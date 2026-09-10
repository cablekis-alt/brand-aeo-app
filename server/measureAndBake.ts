import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { packagedDataMode } from './appPaths.js';
import { reconcileCohortRanks } from './cohortRank.js';
import { mapWithConcurrency } from './concurrency.js';
import { inferCompetitors } from './brandInference.js';
import { appendLocalMeasure } from './localMeasureLog.js';
import { clearActiveMeasure, setActiveMeasure } from './measureTracker.js';
import { resolveCollectionEngines, runWeeklyPipeline } from './pipeline.js';
import { resolveJudgeEngineId } from './engines/index.js';
import { getIsoWeekString } from './dateUtil.js';
import { loadRuntimeTenants, normalizeTenantDraft, persistTenantForRuntime } from './tenantRegistry.js';
import { blobStoreEnabled, readOverlay, writeOverlay } from './tenantOverlay.js';
import type { FileResultStore } from './store.js';
import type { TenantConfig } from './types.js';

const SEED_LIVE: Record<string, { bank: string; an: string }> = {
  'example-brand': { bank: 'src/data/live-question-bank.json', an: 'src/data/live-question-analyses.json' },
  'stay-meomum': { bank: 'src/data/live-stay-question-bank.json', an: 'src/data/live-stay-question-analyses.json' },
};

export interface MeasureBakeResult {
  ok: true;
  tenantId: string;
  brandName: string;
  weekOf: string;
  aeoScore: number;
}

// 자동 추론된 경쟁사를 코호트로 함께 측정할 때 최대 개수(측정량·시간 제한).
const MAX_AUTO_COHORT = 5;

// 코호트 경쟁사를 몇 개씩 동시에 측정할지. 순차 측정에서는 브랜드당 80초가 그대로 쌓여
// "브랜드 전체 측정"이 8분을 넘었다. 호출 총량은 여기가 아니라 전역 LLM 슬롯(concurrency.ts)이
// 잡으므로, 이 값을 올려도 쿼터에 몰리는 양은 늘지 않는다(대기 큐만 길어진다).
//
// 기본값은 MAX_AUTO_COHORT와 같게 둔다 — 경쟁사가 한 파도에 다 들어가야 한 개가 남아
// 혼자 도는 두 번째 파도가 생기지 않는다(torder 실측: 3개 병렬 91초 뒤 KT 1개만 또 한 파도).
// 3개 병렬에서 366호출을 91초(4.0호출/초)에 처리해, 수집 호출의 천장 2.8호출/초에 걸리지
// 않는 것도 확인했다 — 판정 호출은 그라운딩 검색이 없어 더 싸다.
const COHORT_CONCURRENCY = Math.max(1, Number(process.env.COHORT_CONCURRENCY) || MAX_AUTO_COHORT);

function slugFromDomain(domain: string): string {
  const label = domain.split('.')[0] || 'brand';
  return label.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'brand';
}

/** 도메인 없는 경쟁사용 안정 ID — 이름(한글 등 비ASCII 포함) 해시. */
function slugFromName(name: string): string {
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return 'comp-' + h.toString(36);
}

/** 본 테넌트의 경쟁사를 cohortOnly 테넌트 초안으로 변환한다 — 코호트 랭킹 분모용.
 *  도메인이 있으면 도메인 slug, 없으면 이름 해시로 안정 ID를 만든다(도메인 없는 업종=펜션 등 지원). */
function cohortOnlyDraftsFrom(tenant: TenantConfig): TenantConfig[] {
  const seen = new Set<string>([tenant.tenantId]);
  const out: TenantConfig[] = [];
  for (const competitor of tenant.competitors) {
    if (!competitor.name) continue;
    const domain = competitor.domains?.[0];
    const id = domain ? slugFromDomain(domain) : slugFromName(competitor.name);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(
      normalizeTenantDraft({
        tenantId: id,
        brandName: competitor.name,
        aliases: competitor.aliases?.length ? competitor.aliases : [competitor.name],
        ownedDomains: domain ? [domain] : [], // 도메인 없으면 빈 배열 — brandOwnedCitation만 null 처리됨
        industry: tenant.industry,
        region: tenant.region,
        engines: tenant.engines,
        questionBankSize: tenant.questionBankSize,
        questionBankVersion: tenant.questionBankVersion,
        repeatsPerQuestion: tenant.repeatsPerQuestion,
        competitors: [],
        factGraph: [],
        cohortOnly: true,
      }),
    );
  }
  return out;
}

/**
 * 측정 결과를 배포용 src/data로 baking한다.
 *
 * 패키징(Electron) 모드: 데이터는 이미 userData/data에 저장됐고 API가 그대로 읽으므로 아무것도 안 한다.
 * dev 체크아웃에서만 baking(웹 배포용) + git 반영을 한다 — tsx/git이 없는 설치본에서는 건너뛴다.
 *
 * execSync는 이벤트 루프를 통째로 막는다. 그래서 코호트 병렬 측정 중에는 호출하지 않고
 * (형제 브랜드의 진행 중인 HTTP 요청이 타임아웃 타이머째로 멈춘다) 병렬 구간이 끝난 뒤 모아 실행한다.
 */
function bakeForWeb(tenant: TenantConfig, weekOf: string): void {
  if (packagedDataMode()) return;
  const id = tenant.tenantId;
  const seed = SEED_LIVE[id];
  if (seed) {
    writeFileSync(seed.bank, readFileSync(`data/${id}/question-bank/${tenant.questionBankVersion}.json`, 'utf8'));
    const analyses = JSON.parse(readFileSync(`data/${id}/${weekOf}/question-analyses.json`, 'utf8')) as unknown;
    writeFileSync(seed.an, JSON.stringify({ tenantId: id, weekOf, analyses }, null, 2) + '\n');
    execSync('npx tsx scripts/rescore-all.ts', { stdio: 'inherit' });
  } else {
    execSync(`npx tsx scripts/publish-tenant.ts ${id}`, { stdio: 'inherit' });
  }
}

interface MeasureOptions {
  /** baking을 호출자에게 미룬다 — 코호트 병렬 측정 중 execSync로 이벤트 루프를 막지 않기 위해. */
  deferBake?: boolean;
  /**
   * 이번 주 카드가 이미 있는 경쟁사는 다시 재지 않는다(기본 false = 항상 재측정).
   *
   * 주차 카드는 주차당 하나라, 같은 주에 다시 재면 앞선 측정을 **덮어쓴다** — 데이터가
   * 늘지 않고 표본만 바뀐다. 그래서 재사용은 손실이 아니다. 다만 "전체 측정"의 현재 의도가
   * "경쟁사도 최신 키로 재측정"이라 기본값은 바꾸지 않고 호출자가 켜도록 둔다.
   */
  reuseCohort?: boolean;
}

/**
 * 이 경쟁사의 이번 주 카드를 재사용해도 되는가.
 *
 * 카드가 있다는 것만으로는 부족하다 — 수집 엔진이나 판단 엔진이 그때와 다르면 그 카드는
 * 지금 측정과 같은 도구로 잰 값이 아니다(엔진 키를 추가한 직후가 정확히 그 경우다).
 * 그래서 enginesUsed·judgeEngine이 지금 쓸 것과 같을 때만 재사용한다.
 *
 * 내부용이지만 export한다 — "왜 재측정했는가"를 직접 확인할 수 있어야 한다
 * (거절 이유가 조용히 틀리면 다른 엔진으로 잰 카드를 재사용하게 된다).
 */
export async function reusableThisWeek(
  tenant: TenantConfig,
  store: FileResultStore,
  weekOf: string,
): Promise<{ ok: boolean; reason?: string }> {
  const history = await store.getScorecardHistory(tenant.tenantId, 12);
  const card = history.find((item) => item.weekOf === weekOf);
  if (!card) return { ok: false, reason: '이번 주 카드 없음' };

  const judgeNow = resolveJudgeEngineId();
  if (card.judgeEngine && card.judgeEngine !== judgeNow) {
    return { ok: false, reason: `판단 엔진 다름(${card.judgeEngine} → ${judgeNow})` };
  }
  if (!card.judgeEngine) return { ok: false, reason: '판단 엔진 기록 없음(v0.1.38 이전)' };

  let enginesNow: string[];
  try {
    enginesNow = [...resolveCollectionEngines(tenant)].sort();
  } catch {
    return { ok: false, reason: '수집 엔진 확인 불가' };
  }
  const enginesThen = [...(card.enginesUsed ?? [])].sort();
  if (enginesThen.length === 0) return { ok: false, reason: '수집 엔진 기록 없음' };
  if (enginesThen.join(',') !== enginesNow.join(',')) {
    return { ok: false, reason: `수집 엔진 다름(${enginesThen.join('+')} → ${enginesNow.join('+')})` };
  }
  return { ok: true };
}

/** 이 브랜드 자신의 측정 — 등록·파이프라인·완료 기록까지. 코호트 측정과 병렬로 돈다. */
async function measureSelf(
  tenant: TenantConfig,
  store: FileResultStore,
): Promise<{ weekOf: string; aeoScore: number; enginesUsed?: string[] }> {
  await persistTenantForRuntime(tenant);

  // 이 브랜드의 파이프라인 실행을 진행중/완료로 추적한다(측정 상태 화면 표시용).
  const startedMs = Date.now();
  setActiveMeasure({ tenantId: tenant.tenantId, brandName: tenant.brandName, startedAt: new Date().toISOString() });
  let pipeline;
  try {
    pipeline = await runWeeklyPipeline(tenant, store);
  } finally {
    clearActiveMeasure(tenant.tenantId);
  }
  const { scorecard } = pipeline;
  appendLocalMeasure({
    tenantId: tenant.tenantId,
    brandName: tenant.brandName,
    weekOf: scorecard.weekOf,
    aeoScore: scorecard.aeoScore.current,
    durationSec: Math.round((Date.now() - startedMs) / 1000),
    at: new Date().toISOString(),
    engines: pipeline.enginesUsed,
  });
  return { weekOf: scorecard.weekOf, aeoScore: scorecard.aeoScore.current, enginesUsed: pipeline.enginesUsed };
}

/** 한 테넌트를 측정한 뒤 배포용 src/data에 baking한다. GitHub Actions·로컬 단건 측정이 같이 쓴다. */
export async function measureAndBake(
  tenant: TenantConfig,
  store: FileResultStore,
  options: MeasureOptions = {},
): Promise<MeasureBakeResult> {
  let cohortTargets: TenantConfig[] = [];

  // 본 브랜드(경쟁사 측정용 cohortOnly가 아닌)일 때만 경쟁사 자동 추론·코호트 측정을 한다.
  // Vercel 서버리스 리전은 한국어 브랜드 회상에 헛소리를 내므로 이 함수는 Vercel에서 실행되지 않는다.
  if (!tenant.cohortOnly) {
    // 1) 경쟁사가 비어 있으면 CI 러너·로컬(=LLM 정상)에서 자동 추론해 채운다.
    if (!tenant.competitors?.length) {
      const inferred = await inferCompetitors(tenant.brandName, tenant.industry, tenant.region).catch(() => []);
      if (inferred.length) {
        tenant = normalizeTenantDraft({
          ...tenant,
          competitors: inferred.map((c) => ({ name: c.name, domains: c.domain ? [c.domain] : [] })),
        });
        console.log(`[measureAndBake] ${tenant.tenantId} 경쟁사 자동 추론: ${inferred.map((c) => c.name).join(', ')}`);

        // 추론된 경쟁사를 즉시 오버레이에 반영 → 배포 사이트(등록 폼)가 긴 측정 파이프라인 전에 경쟁사를 볼 수 있다.
        if (blobStoreEnabled()) {
          try {
            const overlay = await readOverlay();
            const idx = overlay.findIndex((item) => item.tenantId === tenant.tenantId);
            if (idx >= 0) overlay[idx] = tenant;
            else overlay.push(tenant);
            await writeOverlay(overlay);
            console.log(`[measureAndBake] ${tenant.tenantId} 경쟁사 오버레이 조기 반영 완료`);
          } catch (err) {
            console.error(`[measureAndBake] 오버레이 조기 반영 실패: ${err instanceof Error ? err.message : err}`);
          }
        }
      }
    }

    // 2) 코호트로 함께 측정할 경쟁사를 정한다.
    //    "브랜드 전체 측정"은 경쟁사도 최신 키로 재측정한다: 이미 등록된 경쟁사(본 테넌트)는 그대로
    //    재측정(단, 그 경쟁사의 코호트로 더 퍼지지 않게 autoCohort=false), 없으면 cohortOnly로 새로 측정.
    if (tenant.autoCohort !== false && tenant.competitors?.length) {
      const existingById = new Map((await loadRuntimeTenants()).map((item) => [item.tenantId, item]));
      const seen = new Set<string>([tenant.tenantId]);
      for (const draft of cohortOnlyDraftsFrom(tenant).slice(0, MAX_AUTO_COHORT)) {
        if (seen.has(draft.tenantId)) continue;
        seen.add(draft.tenantId);
        const existing = existingById.get(draft.tenantId);
        // 기존 경쟁사면 본 테넌트로 재측정(코호트 재확장 없이), 없으면 cohortOnly 초안.
        cohortTargets.push(existing ? { ...existing, autoCohort: false } : draft);
      }
    }
  }

  // 2-b) reuseCohort면 이번 주 카드가 이미 있는(같은 엔진으로 잰) 경쟁사를 제외한다.
  //      경쟁사 하나당 2분 가까이 걸리므로, 같은 주에 다른 브랜드를 측정할 때 겹치는 경쟁사를
  //      다시 재지 않는 것이 가장 큰 절약이다.
  if (options.reuseCohort && cohortTargets.length > 0) {
    const weekOf = getIsoWeekString(new Date());
    const checks = await Promise.all(
      cohortTargets.map(async (target) => ({ target, verdict: await reusableThisWeek(target, store, weekOf) })),
    );
    const reused = checks.filter((c) => c.verdict.ok);
    for (const { target, verdict } of checks) {
      if (!verdict.ok) console.log(`[measureAndBake] 코호트 재측정 ${target.tenantId}: ${verdict.reason}`);
    }
    if (reused.length > 0) {
      console.log(
        `[measureAndBake] 이번 주(${weekOf}) 카드 재사용 ${reused.length}개: ` +
          reused.map((c) => c.target.tenantId).join(', '),
      );
    }
    cohortTargets = checks.filter((c) => !c.verdict.ok).map((c) => c.target);
  }

  // 3) 본 브랜드와 경쟁사를 **함께** 측정한다.
  //
  //    전에는 경쟁사를 먼저 다 재고 본 브랜드를 마지막에 쟀다 — 본 브랜드 카드의 코호트 순위가
  //    경쟁사 카드를 봐야 했기 때문이다. v0.1.44의 reconcileCohortRanks가 측정이 끝난 뒤 순위를
  //    완성된 집합으로 다시 매기므로 그 순서 제약이 없어졌다.
  //
  //    실측(web4ai + 경쟁사 5개): 경쟁사 5개 동시 구간은 5.2호출/초를 냈는데, 마지막에 혼자 도는
  //    본 브랜드는 2.75호출/초밖에 못 채웠다. 브랜드 하나로는 파이프를 못 채운다.
  //    총량 상한은 전역 LLM 슬롯이 잡으므로 같이 돌려도 쿼터에 몰리는 양은 늘지 않는다.
  const cohortTask =
    cohortTargets.length > 0
      ? // 경쟁사끼리는 서로를 참조하지 않으므로 병렬로 측정한다. 실패한 브랜드는 건너뛰고
        // 나머지로 코호트를 만든다(경쟁사 하나의 실패가 본 브랜드 측정을 막지 않는다).
        mapWithConcurrency(
          cohortTargets,
          COHORT_CONCURRENCY,
          async (target): Promise<{ tenant: TenantConfig; weekOf: string } | null> => {
            try {
              console.log(`[measureAndBake] 코호트 경쟁사 측정 ▶ ${target.brandName} (${target.tenantId})`);
              const result = await measureAndBake(target, store, { deferBake: true });
              return { tenant: target, weekOf: result.weekOf };
            } catch (err) {
              console.error(
                `[measureAndBake] 코호트 경쟁사 측정 실패 ${target.tenantId}: ${err instanceof Error ? err.message : err}`,
              );
              return null;
            }
          },
        )
      : Promise.resolve([]);

  // 본 브랜드가 실패해도 코호트 측정이 끝날 때까지 기다린다 — 여기서 바로 throw하면 진행 중인
  // 경쟁사 측정이 주인 없이 남아 나중에 파일을 쓴다(고아 작업).
  const selfTask = measureSelf(tenant, store).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const [measured, self] = await Promise.all([cohortTask, selfTask]);

  // 미뤄 둔 baking — 병렬 구간이 끝나 진행 중인 호출이 없을 때 순서대로 실행한다.
  // execSync가 이벤트 루프를 막으므로 병렬 구간 안에서는 못 한다(bakeForWeb 주석 참고).
  for (const item of measured) {
    if (!item) continue;
    try {
      bakeForWeb(item.tenant, item.weekOf);
    } catch (err) {
      console.error(
        `[measureAndBake] 코호트 baking 실패 ${item.tenant.tenantId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  if (!self.ok) throw self.error;
  const { weekOf, aeoScore } = self.value;

  // 코호트 순위를 완성된 집합으로 맞춘다 — 파이프라인은 자기 카드가 저장되기 전에 순위를
  // 계산해 분모가 측정 순서에 따라 달라진다(cohortRank.ts 참고). 본 브랜드와 경쟁사를 같이
  // 재기 때문에 이 재계산이 더 중요해졌다 — 어느 카드도 완성된 집합을 보지 못한다.
  // 실패해도 측정 자체는 살린다.
  if (!tenant.cohortOnly) {
    try {
      const updated = await reconcileCohortRanks(store, tenant.industry, tenant.region, weekOf);
      if (updated > 0) console.log(`[measureAndBake] 코호트 순위 재계산 — 카드 ${updated}개 갱신`);
    } catch (err) {
      console.error(`[measureAndBake] 코호트 순위 재계산 실패: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (!options.deferBake) bakeForWeb(tenant, weekOf);

  return {
    ok: true,
    tenantId: tenant.tenantId,
    brandName: tenant.brandName,
    weekOf,
    aeoScore,
  };
}
