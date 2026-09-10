import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { packagedDataMode } from './appPaths.js';
import { reconcileCohortRanks } from './cohortRank.js';
import { mapWithConcurrency } from './concurrency.js';
import { inferCompetitors } from './brandInference.js';
import { appendLocalMeasure } from './localMeasureLog.js';
import { clearActiveMeasure, setActiveMeasure } from './measureTracker.js';
import { runWeeklyPipeline } from './pipeline.js';
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
}

/** 한 테넌트를 측정한 뒤 배포용 src/data에 baking한다. GitHub Actions·로컬 단건 측정이 같이 쓴다. */
export async function measureAndBake(
  tenant: TenantConfig,
  store: FileResultStore,
  options: MeasureOptions = {},
): Promise<MeasureBakeResult> {
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

    // 2) 경쟁사를 코호트로 함께 측정 → 본 브랜드 스코어카드의 코호트 순위(1/N)가 채워진다.
    //    "브랜드 전체 측정"은 경쟁사도 최신 키로 재측정한다: 이미 등록된 경쟁사(본 테넌트)는 그대로
    //    재측정(단, 그 경쟁사의 코호트로 더 퍼지지 않게 autoCohort=false), 없으면 cohortOnly로 새로 측정.
    //    본 브랜드보다 "먼저" 측정해 같은 주차 코호트에 포함시킨다.
    if (tenant.autoCohort !== false && tenant.competitors?.length) {
      const existingById = new Map((await loadRuntimeTenants()).map((item) => [item.tenantId, item]));
      const seen = new Set<string>([tenant.tenantId]);
      const targets: TenantConfig[] = [];
      for (const draft of cohortOnlyDraftsFrom(tenant).slice(0, MAX_AUTO_COHORT)) {
        if (seen.has(draft.tenantId)) continue;
        seen.add(draft.tenantId);
        const existing = existingById.get(draft.tenantId);
        // 기존 경쟁사면 본 테넌트로 재측정(코호트 재확장 없이), 없으면 cohortOnly 초안.
        targets.push(existing ? { ...existing, autoCohort: false } : draft);
      }

      // 경쟁사끼리는 서로를 참조하지 않으므로 병렬로 측정한다. 실패한 브랜드는 건너뛰고
      // 나머지로 코호트를 만든다(경쟁사 하나의 실패가 본 브랜드 측정을 막지 않는다).
      const measured = await mapWithConcurrency(
        targets,
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
      );

      // 미뤄 둔 baking — 병렬 구간이 끝나 진행 중인 호출이 없을 때 순서대로 실행한다.
      // 본 브랜드보다 먼저 해야 본 브랜드 baking이 코호트 순위를 최신 값으로 다시 계산한다.
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
    }
  }

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
  const weekOf = scorecard.weekOf;
  const id = tenant.tenantId;
  appendLocalMeasure({
    tenantId: id,
    brandName: tenant.brandName,
    weekOf,
    aeoScore: scorecard.aeoScore.current,
    durationSec: Math.round((Date.now() - startedMs) / 1000),
    at: new Date().toISOString(),
    engines: pipeline.enginesUsed,
  });

  // 코호트 순위를 완성된 집합으로 맞춘다 — 파이프라인은 자기 카드가 저장되기 전에 순위를
  // 계산해 분모가 측정 순서에 따라 달라진다(cohortRank.ts 참고). 본 브랜드가 마지막에
  // 측정되므로 여기가 모든 형제 카드가 저장된 시점이다. 실패해도 측정 자체는 살린다.
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
    tenantId: id,
    brandName: tenant.brandName,
    weekOf,
    aeoScore: scorecard.aeoScore.current,
  };
}
