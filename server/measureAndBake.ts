import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { packagedDataMode } from './appPaths.js';
import { readCohortExclusions, trimRemeasured, updateCohortExclusions } from './cohortExclusionStore.js';
import { ensureCohortBank } from './cohortQuestionBank.js';
import { MAX_AUTO_COHORT, selectCohortTargets } from './cohortPlan.js';
import { reconcileCohortRanks } from './cohortRank.js';
import { mapWithConcurrency } from './concurrency.js';
import { inferCompetitors } from './brandInference.js';
import { appendLocalMeasure } from './localMeasureLog.js';
import { resetJudgeHealth } from './engines/index.js';
import { CollectionError } from './engineExhaustion.js';
import {
  beginMeasureRun,
  clearActiveMeasure,
  clearMeasureFailures,
  endMeasureRun,
  MeasureCancelledError,
  recordMeasureFailure,
  setActiveMeasure,
} from './measureTracker.js';
import { resolveCollectionEngines, runWeeklyPipeline } from './pipeline.js';
import { resolveJudgeEngineId } from './engines/index.js';
import { getIsoWeekString } from './dateUtil.js';
import { loadRuntimeTenants, loadTenantWithoutCompetitorEdit, normalizeTenantDraft, persistTenantForRuntime } from './tenantRegistry.js';
import { blobStoreEnabled, readOverlay, writeOverlay } from './tenantOverlay.js';
import { baseFingerprint, recordCompetitorMeasurement } from './tenantCompetitorsStore.js';
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
  /** 이번 측정이 그 주 카드를 덮지 않은 까닭(pipeline.ts weekCardKeepReason). 있으면 aeoScore는 이 회차 점수이고 그 주 카드는 앞의 것이다. */
  weekCardKept?: string;
}

// 코호트 경쟁사를 몇 개씩 동시에 측정할지. 순차 측정에서는 브랜드당 80초가 그대로 쌓여
// "브랜드 전체 측정"이 8분을 넘었다. 호출 총량은 여기가 아니라 전역 LLM 슬롯(concurrency.ts)이
// 잡으므로, 이 값을 올려도 쿼터에 몰리는 양은 늘지 않는다(대기 큐만 길어진다).
//
// 기본값은 MAX_AUTO_COHORT와 같게 둔다 — 경쟁사가 한 파도에 다 들어가야 한 개가 남아
// 혼자 도는 두 번째 파도가 생기지 않는다(torder 실측: 3개 병렬 91초 뒤 KT 1개만 또 한 파도).
// 3개 병렬에서 366호출을 91초(4.0호출/초)에 처리해, 수집 호출의 천장 2.8호출/초에 걸리지
// 않는 것도 확인했다 — 판정 호출은 그라운딩 검색이 없어 더 싸다.
const COHORT_CONCURRENCY = Math.max(1, Number(process.env.COHORT_CONCURRENCY) || MAX_AUTO_COHORT);

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
   * 다른 브랜드의 측정 안에서 경쟁사로 잰다. 코호트 순위 재계산은 그 측정이 끝에서 한 번 한다 —
   * 경쟁사마다 하면 형제 브랜드의 카드 저장과 겹친다.
   */
  inCohortRun?: boolean;
  /**
   * 이번 주 카드가 이미 있는 경쟁사는 다시 재지 않는다(기본 false = 항상 재측정).
   *
   * 주차 카드는 주차당 하나라, 같은 주에 다시 재면 앞선 측정을 **덮어쓴다** — 데이터가
   * 늘지 않고 표본만 바뀐다(회차 기록 runs/에만 쌓인다). 그래서 재사용은 손실이 아니다. 다만 "전체 측정"의 현재 의도가
   * "경쟁사도 최신 키로 재측정"이라 기본값은 바꾸지 않고 호출자가 켜도록 둔다.
   */
  reuseCohort?: boolean;
  /**
   * 이 브랜드만 잰다 — 경쟁사 자동 추론 · 함께 측정을 건너뛰고, 코호트 순위는 경쟁사들의 이번 주 카드로 다시 매긴다(측정 화면의
   * 「이 브랜드만 측정」). 경쟁사를 재지 않았으므로 경쟁사 목록을 「측정함」으로 적지 않는다 — 적으면 경쟁사 편집의
   * 「다음 측정 대기」가 바뀐 경쟁사를 재지도 않았는데 사라진다. 경쟁사 카드와 도구가 다르면 화면이 측정 전에 알린다(measurePreview).
   */
  selfOnly?: boolean;
  /**
   * 리포트(report.md)를 기다리지 않고 측정을 끝낸다(pipeline.ts deferReport) — 측정 화면에서 시작한 측정. 함께 재는 경쟁사도
   * 같다. 리포트 저장이 실패해도 측정은 성공으로 남는다(점수 · 카드는 이미 저장됐다).
   */
  backgroundReport?: boolean;
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
  // 기본 정보를 바꿔 함께 옮긴 경쟁사는 이번 주 카드가 옛 코호트 · 옛 질문지로 잰 것이다 — 재사용하면 새 순위표에서 빠진다
  // (brandProfileEditor.ts).
  if (card.industry !== tenant.industry || card.region !== tenant.region) {
    return { ok: false, reason: `코호트 다름(${card.industry} · ${card.region} → ${tenant.industry} · ${tenant.region})` };
  }
  if (card.questionBankVersion !== tenant.questionBankVersion) {
    return { ok: false, reason: `질문지 다름(${card.questionBankVersion ?? '기록 없음'} → ${tenant.questionBankVersion})` };
  }

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

/** 측정 전에 보는 계획 — 측정 화면이 「건너뛰기」 · 「이 브랜드만」을 고르기 전에 무엇이 일어날지 알린다. */
export interface MeasurePreview {
  weekOf: string;
  /** 지금 쓸 수집 엔진 · 판단 엔진. 수집 엔진을 정하지 못하면(키 없음) engines는 비고 enginesError에 까닭. */
  engines: string[];
  enginesError: string | null;
  judgeEngine: string;
  /** 「건너뛰기」 때 함께 잴 경쟁사마다 — 이번 주 카드를 다시 쓰는가, 아니면 왜 다시 재는가(reusableThisWeek). */
  targets: { tenantId: string; brandName: string; reusable: boolean; reason: string | null }[];
  /** 「이 브랜드만」 때 함께 순위를 매길 이번 주 코호트 카드(자기 제외)와, 그 카드가 지금과 같은 도구로 잰 것인가. */
  peers: { tenantId: string; brandName: string; engines: string[]; judgeEngine: string | null; sameTools: boolean }[];
}

export async function measurePreview(tenant: TenantConfig, store: FileResultStore): Promise<MeasurePreview> {
  const weekOf = getIsoWeekString(new Date());
  const judgeEngine = resolveJudgeEngineId();
  let engines: string[] = [];
  let enginesError: string | null = null;
  try {
    engines = [...resolveCollectionEngines(tenant)].sort();
  } catch (err) {
    enginesError = err instanceof Error ? err.message : String(err);
  }
  const runtime = await loadRuntimeTenants();
  const candidates = tenant.cohortOnly || tenant.autoCohort === false || !tenant.competitors?.length ? [] : selectCohortTargets(tenant, runtime);
  const targets = await Promise.all(
    candidates.map(async (t) => {
      const v = await reusableThisWeek(t, store, weekOf);
      return { tenantId: t.tenantId, brandName: t.brandName, reusable: v.ok, reason: v.ok ? null : (v.reason ?? null) };
    }),
  );
  const cards = await store.getCohortScorecards(tenant.industry, tenant.region, weekOf);
  const peers = cards
    .filter((c) => c.tenantId !== tenant.tenantId)
    .map((c) => {
      const used = [...(c.enginesUsed ?? [])].sort();
      return {
        tenantId: c.tenantId,
        brandName: c.brandName,
        engines: used,
        judgeEngine: c.judgeEngine ?? null,
        sameTools: !enginesError && used.join(',') === engines.join(',') && c.judgeEngine === judgeEngine,
      };
    });
  return { weekOf, engines, enginesError, judgeEngine, targets, peers };
}

type CohortKey = { industry: string; region: string; weekOf: string };

/**
 * 같은 주에 다시 넣어 잰 경쟁사의 코호트 제외를 푼다(cohortExclusionStore.ts trimRemeasured) — 그 주부터 다시 센다.
 * 이번 측정으로 이 고객의 코호트에 카드를 남긴 경쟁사(측정 성공 · 이번 주 카드 재사용)만 본다 — 다른 지역으로 잰 경쟁사의 카드는
 * 이 고객의 순위표에 들지 않으므로, 그 지역 고객이 뺀 기록을 풀지 않는다. 다시 셀 코호트 주차를 돌려준다.
 * 실패해도 측정은 살린다(그 주는 계속 빠진 채 남는다 — 서랍의 「다시 세기」로 풀 수 있다).
 */
export async function releaseRemeasured(
  cohort: { industry: string; region: string },
  measured: ({ tenant: TenantConfig; weekOf: string } | null)[],
  reused: TenantConfig[],
  weekOf: string,
): Promise<CohortKey[]> {
  const hits = [
    ...measured.flatMap((m) => (m ? [{ tenantId: m.tenant.tenantId, industry: m.tenant.industry, region: m.tenant.region, weekOf: m.weekOf }] : [])),
    ...reused.map((t) => ({ tenantId: t.tenantId, industry: t.industry, region: t.region, weekOf })),
  ].filter((h) => h.industry === cohort.industry && h.region === cohort.region);
  if (!hits.length) return [];
  try {
    // 풀 것이 없으면 파일을 쓰지 않는다(측정마다 쓰지 않게).
    if (!trimRemeasured(await readCohortExclusions(), hits).trimmed.length) return [];
    let trimmed: ReturnType<typeof trimRemeasured>['trimmed'] = [];
    await updateCohortExclusions((entries) => {
      const result = trimRemeasured(entries, hits);
      trimmed = result.trimmed;
      return result.entries;
    });
    for (const t of trimmed) {
      console.log(`[measureAndBake] 코호트 제외 해제 ${t.entry.tenantId}(${t.entry.brandName}): ${t.weekOf}부터 다시 셉니다${t.removed ? ' — 항목을 지웠습니다' : ''}`);
    }
    return trimmed.map((t) => ({ industry: t.entry.industry, region: t.entry.region, weekOf: t.weekOf }));
  } catch (err) {
    console.error(`[measureAndBake] 코호트 제외 해제 실패: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

/**
 * 이번 측정으로 이번 주 카드가 다른 코호트로 옮겨 갈 브랜드의 옛 코호트.
 *
 * 주차 카드는 브랜드 · 주차당 하나라(store.saveScorecard), 이번 주에 이미 잰 브랜드를 업종 · 지역을 바꿔 다시 재면
 * 옛 코호트의 카드가 새 코호트 카드로 바뀐다. 측정 끝의 순위 재계산은 새 코호트만 돌아서, 옛 코호트에 남은 브랜드의
 * 저장 순위(「3위 / 7」)는 떠난 브랜드를 센 채 남았다(2026-10-16, 경쟁사 → 고객 브랜드 전환한 군산여행의 모든것).
 * 측정이 실패하거나 주가 바뀌어 카드가 그대로면, 옛 코호트를 다시 계산해도 값이 같아 아무것도 쓰지 않는다.
 */
async function cohortsLeftThisWeek(store: FileResultStore, tenants: TenantConfig[], weekOf: string): Promise<CohortKey[]> {
  const left = new Map<string, CohortKey>();
  for (const t of tenants) {
    const card = (await store.getScorecardHistory(t.tenantId, 12)).find((item) => item.weekOf === weekOf);
    if (!card || (card.industry === t.industry && card.region === t.region)) continue;
    left.set(`${card.industry}|${card.region}`, { industry: card.industry, region: card.region, weekOf });
  }
  return [...left.values()];
}

/**
 * 측정 상태 화면의 「실패」 줄을 남긴다. 사용자가 멈춘 측정은 실패가 아니다. 같은 오류를 두 번 남기지 않는다 —
 * 본 브랜드의 실패는 경쟁사 측정을 기다리지 않고 바로 남기고(measureAndBakeRun), 바깥(measureAndBake)에서 다시 만난다.
 */
const recordedFailures = new WeakSet<object>();
function noteMeasureFailure(tenant: TenantConfig, err: unknown): void {
  if (err instanceof MeasureCancelledError) return;
  if (typeof err === 'object' && err !== null) {
    if (recordedFailures.has(err)) return;
    recordedFailures.add(err);
  }
  recordMeasureFailure({
    tenantId: tenant.tenantId,
    brandName: tenant.brandName,
    at: new Date().toISOString(),
    error: err instanceof Error ? err.message : String(err),
    ...(err instanceof CollectionError && err.engineIssues.length ? { engineIssues: err.engineIssues } : {}),
  });
}

/** 이 브랜드 자신의 측정 — 등록·파이프라인·완료 기록까지. 코호트 측정과 병렬로 돈다. */
async function measureSelf(
  tenant: TenantConfig,
  store: FileResultStore,
  options: MeasureOptions,
): Promise<{ weekOf: string; aeoScore: number; enginesUsed?: string[]; weekCardKept?: string }> {
  await persistTenantForRuntime(tenant);

  // 이 브랜드의 파이프라인 실행을 진행중/완료로 추적한다(측정 상태 화면 표시용).
  const startedMs = Date.now();
  // 앞 측정의 끝자락 실패가 다음 측정을 곧바로 죽이면 안 된다.
  resetJudgeHealth();
  setActiveMeasure({ tenantId: tenant.tenantId, brandName: tenant.brandName, startedAt: new Date().toISOString() });
  let pipeline;
  try {
    pipeline = await runWeeklyPipeline(tenant, store, undefined, {
      deferReport: options.backgroundReport === true,
      selfOnly: options.selfOnly === true,
      inCohortRun: options.inCohortRun === true,
    });
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
    ...(pipeline.weekCardKept ? { weekCardKept: pipeline.weekCardKept } : {}),
  });
  return {
    weekOf: scorecard.weekOf,
    aeoScore: scorecard.aeoScore.current,
    enginesUsed: pipeline.enginesUsed,
    ...(pipeline.weekCardKept ? { weekCardKept: pipeline.weekCardKept } : {}),
  };
}

/** 한 테넌트를 측정한 뒤 배포용 src/data에 baking한다. GitHub Actions·로컬 단건 측정이 같이 쓴다. */
export async function measureAndBake(
  tenant: TenantConfig,
  store: FileResultStore,
  options: MeasureOptions = {},
): Promise<MeasureBakeResult> {
  // 처음부터 끝까지 「측정 중」으로 센다 — 경쟁사 편집이 이 사이에 저장하지 않게(measureTracker.ts).
  beginMeasureRun();
  try {
    const result = await measureAndBakeRun(tenant, store, options);
    clearMeasureFailures(tenant.tenantId);
    return result;
  } catch (err) {
    // 측정 상태 화면의 「실패」 줄 — 함께 재던 경쟁사도 각자 남는다(그 경쟁사의 측정도 이 함수를 거친다).
    noteMeasureFailure(tenant, err);
    throw err;
  } finally {
    endMeasureRun();
  }
}

/** 저장소 설정 지문(경쟁사 편집 수정본을 뺀 설정) — 읽지 못하면 없이 기록한다(질문지 차이로는 「다음 측정 대기」를 세지 않는다). */
async function repoFingerprint(tenantId: string): Promise<string | undefined> {
  try {
    const repo = await loadTenantWithoutCompetitorEdit(tenantId);
    return repo ? baseFingerprint(repo) : undefined;
  } catch (err) {
    console.warn(`[measureAndBake] 저장소 설정을 읽지 못해 지문 없이 기록합니다 ${tenantId}: ${err instanceof Error ? err.message : err}`);
    return undefined;
  }
}

async function measureAndBakeRun(
  tenant: TenantConfig,
  store: FileResultStore,
  options: MeasureOptions,
): Promise<MeasureBakeResult> {
  let cohortTargets: TenantConfig[] = [];
  // 이번 주 카드를 다시 쓴(재측정하지 않은) 경쟁사 — 그 카드도 이번 코호트에 든다(코호트 제외 해제에 쓴다).
  let reusedTargets: TenantConfig[] = [];
  // 고객 브랜드 자신의 측정이면, 끝난 뒤 어느 경쟁사 목록으로 쟀는지 적는다(경쟁사 편집의 「다음 측정 대기」).
  const startedAt = new Date().toISOString();
  // 시작할 때의 저장소 설정 지문 — 기록하는 목록 · 질문지 버전과 같은 때의 값이어야 한다(측정 중에 설정이 바뀌어도 어긋나지 않게).
  const repoBase = tenant.cohortOnly ? undefined : await repoFingerprint(tenant.tenantId);
  // 적을 목록은 런타임 설정이 준 목록이다 — 아래에서 비어 있으면 추론으로 채우지만 그 목록은 저장하지 않아, 다음 측정도 같은
  // 빈 목록에서 시작한다(「다음 측정 대기」는 런타임 목록과 견준다). 함께 잴 경쟁사(cohortTargets)와는 따로다 — 코호트 없이
  // 재는 고객(autoCohort false)도 이 목록으로 판정한다.
  const runtimeList = tenant.competitors ?? [];

  // 본 브랜드(경쟁사 측정용 cohortOnly가 아닌)일 때만 경쟁사 자동 추론·코호트 측정을 한다.
  // Vercel 서버리스 리전은 한국어 브랜드 회상에 헛소리를 내므로 이 함수는 Vercel에서 실행되지 않는다.
  if (!tenant.cohortOnly && !options.selfOnly) {
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
      cohortTargets.push(...selectCohortTargets(tenant, await loadRuntimeTenants()));
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
    reusedTargets = reused.map((c) => c.target);
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
  // 코호트 공통 질문지는 병렬 측정을 시작하기 전에 한 번 준비한다. 동시에 재는 브랜드들이 각자
  // 만들면 서로 다른 질문지가 된다(ensureCohortBank가 진행 중인 생성을 공유하지만, 먼저 끝내 두면
  // 실패도 여기서 한 번에 드러난다).
  if (tenant.cohortQuestionBank) await ensureCohortBank(tenant);

  // 이번 주 카드가 다른 코호트에 있던 브랜드 — 끝에서 옛 코호트 순위도 다시 매긴다(cohortsLeftThisWeek).
  // 다른 브랜드 측정 안에서 재는 경쟁사는 그 측정이 자기 대상 전체로 한 번 본다.
  const weekNow = getIsoWeekString(new Date());
  const leftCohorts = options.inCohortRun ? [] : await cohortsLeftThisWeek(store, [tenant, ...cohortTargets], weekNow);

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
              const result = await measureAndBake(target, store, { deferBake: true, inCohortRun: true, backgroundReport: options.backgroundReport });
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
  const selfTask = measureSelf(tenant, store, options).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => {
      // 경쟁사 측정이 끝날 때까지(몇 분) 기다리지 않고 바로 「실패」 줄을 남긴다 — 그 사이 진행 줄은 이미 사라졌다.
      noteMeasureFailure(tenant, error);
      return { ok: false as const, error };
    },
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

  // 본 브랜드가 실패해도 순위 재계산은 한다(아래) — 파이프라인은 카드를 저장한 뒤 보고서 단계에서도 실패할 수 있어,
  // 카드는 새 코호트로 옮겨 갔는데 옛 코호트 순위가 떠난 브랜드를 센 채 남는다. 실패했으면 측정을 시작한 주로 본다.
  const weekOf = self.ok ? self.value.weekOf : weekNow;

  // 코호트 순위를 완성된 집합으로 맞춘다 — 파이프라인은 자기 카드가 저장되기 전에 순위를
  // 계산해 분모가 측정 순서에 따라 달라진다(cohortRank.ts 참고). 본 브랜드와 경쟁사를 같이
  // 재기 때문에 이 재계산이 더 중요해졌다 — 어느 카드도 완성된 집합을 보지 못한다.
  // 실패해도 측정 자체는 살린다.
  //
  // 경쟁사만 따로 재도(측정 화면 「이 경쟁사만 측정」) 다시 계산한다. 예전에는 본 브랜드 측정에서만 해서,
  // 경쟁사 점수가 바뀌어도 같은 코호트 고객 카드의 「3위 / 7」 같은 저장 순위가 다음 전체 측정까지 옛 값으로
  // 남았다(2026-10-15). 다른 브랜드 측정 안에서 잰 경쟁사는 그 측정이 끝에서 한 번 계산한다(inCohortRun).
  // 뺐던 경쟁사(「지난 기록에서도 빼기」)를 다시 넣어 같은 주에 쟀다 — 그 주는 다시 센다. 고객 브랜드의 측정에서만 —
  // 「이 경쟁사만 측정」으로 따로 잰 것은 목록에 다시 넣은 것이 아니다. 측정에 실패한 경쟁사는 그대로 둔다.
  const released = !tenant.cohortOnly && !options.inCohortRun ? await releaseRemeasured({ industry: tenant.industry, region: tenant.region }, measured, reusedTargets, weekNow) : [];

  if (!tenant.cohortOnly || !options.inCohortRun) {
    try {
      let updated = await reconcileCohortRanks(store, tenant.industry, tenant.region, weekOf);
      for (const old of [...leftCohorts, ...released]) {
        if (old.industry === tenant.industry && old.region === tenant.region && old.weekOf === weekOf) continue;
        updated += await reconcileCohortRanks(store, old.industry, old.region, old.weekOf);
      }
      if (updated > 0) console.log(`[measureAndBake] 코호트 순위 재계산 — 카드 ${updated}개 갱신`);
    } catch (err) {
      console.error(`[measureAndBake] 코호트 순위 재계산 실패: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (!self.ok) throw self.error;
  const { aeoScore, weekCardKept } = self.value;
  // 다른 고객의 경쟁사로 잰 측정(inCohortRun)은 적지 않는다 — 이 브랜드 자신의 측정이 아니다. 이 브랜드만 잰 측정(selfOnly)도
  // 경쟁사를 재지 않았으니 적지 않는다. 그 주 카드를 덮지 않은 측정(weekCardKept)도 카드가 옛 목록 그대로라 적지 않는다.
  if (!tenant.cohortOnly && !options.inCohortRun && !options.selfOnly && !weekCardKept) {
    // 저장소 설정 지문도 적는다 — 뒤에 질문지 버전이 달라졌을 때 저장소 설정 때문인지 경쟁사 편집 때문인지 가른다.
    await recordCompetitorMeasurement(tenant.tenantId, runtimeList, startedAt, tenant.questionBankVersion, repoBase).catch((err: unknown) => {
      console.error(`[measureAndBake] 경쟁사 측정 기록 실패 ${tenant.tenantId}: ${err instanceof Error ? err.message : err}`);
    });
  }

  if (!options.deferBake) bakeForWeb(tenant, weekOf);

  return {
    ok: true,
    tenantId: tenant.tenantId,
    brandName: tenant.brandName,
    weekOf,
    aeoScore,
    ...(weekCardKept ? { weekCardKept } : {}),
  };
}
