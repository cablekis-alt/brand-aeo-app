import { createHash } from 'node:crypto';
import { CollectionError, EngineOutage } from './engineExhaustion.js';
import {
  buildBrandMentionPrompt,
  buildCitationClassificationPrompt,
  buildEngineCallPrompt,
  buildFactCheckPrompt,
  buildQuestionBankPrompt,
  agnosticQuota,
  countAgnostic,
  enforceAgnosticQuota,
  buildRecommendationOrderPrompt,
  buildWeeklyReportPrompt,
  type BrandContext,
  type CitationCandidate,
  type QuestionSpec,
  type WeeklyScorecard,
} from '../src/prompts/index.js';
import type { Engine } from '../src/prompts/types.js';
import type { BrandMentionResult, CitationResult, FactCheckResult, RecommendationOrderResult } from './analysisTypes.js';
import { collectLimit, collectRpm, mapWithConcurrency } from './concurrency.js';
import { engineKeyStatus, globalCollectEngines } from './engineKeys.js';
import { MeasureCancelledError, throwIfMeasureCancelled, updateActiveMeasure, type EngineProgress } from './measureTracker.js';
import { resolveCitationUrls } from './citationResolve.js';
import { isClarifyingResponse } from './clarifyingResponse.js';
import { getIsoWeekString } from './dateUtil.js';
import { getEngineClient, getJudgeClient, usedJudgeEngineId } from './engines/index.js';
import { parseJsonLoose } from './jsonParse.js';
import { tagJourneyStages } from './journeyStage.js';
import { aggregateWeeklyMetrics, ciBounds } from './aggregate.js';
import { analyzeCitationSources, urlHost } from './citationSources.js';
import { cohortRankingEntities } from './cohortEntities.js';
import { ensureComposedQuestionBank } from './cohortQuestionBank.js';
import { computeEeatAnalysis } from './eeat.js';
import { preserveUnrecordedWeekFile } from './preserveWeekFile.js';
import { computeCohortRank, movingAverage4 } from './scoring.js';
import type { QuestionBank, ResultStore, RunMeta } from './store.js';
import { baseFingerprint, overrideApplies, readCompetitorOverride } from './tenantCompetitorsStore.js';
import { loadRuntimeTenants, loadTenantWithoutCompetitorEdit } from './tenantRegistry.js';
import type {
  CompetitorMentionDetail,
  FactClaimDetail,
  JudgeUsage,
  QuestionRepeatAnalysis,
  RawCallRecord,
  TenantConfig,
} from './types.js';

// 파이프라인 한 벌이 동시에 띄우는 호출 수. 총량 상한은 여기가 아니라 전역 LLM 슬롯
// (concurrency.ts의 LLM_CONCURRENCY)이 잡으므로, 이 값은 "얼마나 파이프를 채울지"만 정한다.
//
// 실측(scripts/quota-probe.ts, gemini-3.7-flash + 그라운딩, 48회):
//   동시성  8 → 25.1초 · 429 0건 · 0.96/초
//   동시성 16 → 15.2초 · 429 0건 · 1.58/초
//   동시성 24 → 17.3초 · 429 0건 · 2.77/초   (48회 기준)
//   동시성 48 → 17.2초 · 429 0건 · 2.79/초   ← 더 안 빨라지고 p95만 9.3→10.8초
// 즉 키 하나의 처리량 천장이 약 2.8호출/초이고 동시성 24에서 이미 닿는다. 그 위로 올리면
// 서버가 429 대신 큐에 세워 지연만 길어진다.
// 수집 슬롯이 엔진마다 따로가 된 뒤(2026-10-13, concurrency.ts)로는 한 브랜드가 띄우는 수집 호출도 쓰는 엔진들의
// 슬롯 합만큼 띄운다 — 24로 두면 브랜드 하나만 잴 때 엔진마다 8개씩만 돌아 OpenAI·Gemini 슬롯이 놀았다.
// COLLECTION_CONCURRENCY를 주면 그 값을 쓴다.
// 판정은 검색이 없어 더 싸고 슬롯도 따로다(concurrency.ts judge 144). 항목당 판정 호출이 최대 4개(언급 · 인용 · 순위 ·
// 사실 — 인용 0건이거나 factGraph가 없으면 빠진다)라 24 × 4 = 96까지 띄운다. 16이면 브랜드 하나만 잴 때 분석이
// 슬롯을 절반도 못 채워, 인용 45개짜리 답 하나가 줄 끝에서 17초를 기다렸다가 혼자 23초를 더 돌았다(2026-W43 gunsan-national,
// 분석 41초 → 24 · 인용 많은 것 먼저로 재생하면 25초).
const COLLECTION_CONCURRENCY_OVERRIDE = Number(process.env.COLLECTION_CONCURRENCY) || 0;
const ANALYSIS_CONCURRENCY = Math.max(1, Number(process.env.ANALYSIS_CONCURRENCY) || 24);

function toBrandContext(tenant: TenantConfig): BrandContext {
  return {
    brandName: tenant.brandName,
    aliases: tenant.aliases,
    ownedDomains: tenant.ownedDomains,
    competitors: tenant.competitors,
    industry: tenant.industry,
    region: tenant.region,
  };
}

function brandAndCompetitorNames(tenant: TenantConfig): string[] {
  return [
    tenant.brandName,
    ...tenant.aliases,
    ...tenant.competitors.flatMap((competitor) => [competitor.name, ...competitor.aliases]),
  ];
}

/**
 * 경쟁사 편집이 고쳐 만든 은행(derivedFrom)과 「모두 새로 쓰기」로 측정이 새로 만든 은행(regeneratedFrom)은 지금 저장소 설정 위에서
 * 만든 것일 때만 쓴다. 저장소가 나중에 같은 버전 이름을 따로
 * 쓰면(예: 저장소 v6) 수정본은 낡아 꺼지는데 데스크톱의 v6 파일이 그대로 쓰여, 다른 경쟁사 목록으로 만든 질문을 묻게 된다.
 *
 * 수정본을 다시 읽어 견주지 않는다 — 측정이 설정을 읽은 뒤 저장 · 되돌리기가 끝나면, 측정이 읽은 옛 목록 · 옛 질문지는 서로 맞는데도
 * 수정본만 바뀌어 멈춘다. 은행에 적힌 저장소 지문(derivedFrom.base)은 그 은행을 만든 순간의 값이라 겹친 저장과 상관없다.
 */
async function assertDerivedBankInUse(tenant: TenantConfig, store: ResultStore): Promise<void> {
  const bank = await store.getQuestionBank(tenant.tenantId, tenant.questionBankVersion);
  const origin = bank?.derivedFrom ?? bank?.regeneratedFrom;
  if (!origin) return;
  const repo = await loadTenantWithoutCompetitorEdit(tenant.tenantId);
  if (repo && origin.base === baseFingerprint(repo) && repo.questionBankVersion !== tenant.questionBankVersion) return;
  throw new Error(
    `${tenant.tenantId} 질문 은행 ${tenant.questionBankVersion}은 앱에서 경쟁사를 바꾸며 만든 질문지인데 저장소 설정이 그 뒤에 바뀌었습니다 — ` +
      `저장소 설정의 questionBankVersion을 쓰이지 않은 새 값으로 올리세요.`,
  );
}

/**
 * 이 버전이 경쟁사 편집의 「모두 새로 쓰기」로 정한 것이면 그 출처(새로 만드는 은행에 남긴다). 수정본이 지금 저장소 위에서 쓰이고
 * 그 버전을 가리킬 때만이다 — 저장소가 같은 이름을 쓰는 경우는 표식을 붙이지 않는다(그 은행은 저장소 질문지다).
 */
async function regenerateOrigin(tenant: TenantConfig, store: ResultStore): Promise<QuestionBank['regeneratedFrom']> {
  if (await store.getQuestionBank(tenant.tenantId, tenant.questionBankVersion)) return undefined;
  const [file, repo] = await Promise.all([readCompetitorOverride(tenant.tenantId), loadTenantWithoutCompetitorEdit(tenant.tenantId)]);
  const current = file?.current ?? null;
  const qb = current?.questionBank;
  if (!repo || !overrideApplies(current, repo) || !qb?.regenerate || qb.version !== tenant.questionBankVersion) return undefined;
  return { version: qb.regenerate.from, by: 'competitor-edit', base: qb.regenerate.base };
}

/** B1 — 질문 은행은 버전당 1회만 생성하고 이후 주차에는 재사용한다 (버전을 바꾸면 재생성). */
export async function ensureQuestionBank(tenant: TenantConfig, store: ResultStore): Promise<QuestionSpec[]> {
  await assertDerivedBankInUse(tenant, store);
  // 코호트 공통 질문지를 쓰는 브랜드는 일반 질문을 코호트 은행에서 가져온다. 아래의 60% 하한
  // 보정(enforceAgnosticQuota)은 거치지 않는다 — 브랜드 전용 질문을 일반 질문으로 승격하면
  // 코호트가 공유하지 않는 일반 질문이 섞인다.
  if (tenant.cohortQuestionBank) return ensureComposedQuestionBank(tenant, store, await regenerateOrigin(tenant, store));

  const quota = agnosticQuota(tenant.questionBankSize);
  const names = brandAndCompetitorNames(tenant);

  const existing = await store.getQuestionBank(tenant.tenantId, tenant.questionBankVersion);
  if (existing) {
    const enforced = enforceAgnosticQuota(existing.questions, quota, names);
    if (countAgnostic(enforced) >= quota) {
      if (JSON.stringify(enforced) !== JSON.stringify(existing.questions)) {
        await store.saveQuestionBank(tenant.tenantId, { ...existing, questions: enforced });
      }
      return enforced;
    }
  }

  const judge = getJudgeClient();

  // category-agnostic 개수가 하한(quota)에 못 미치면, LLM이 지시를 무시한 것이므로
  // 부족분을 명시해 최대 3회까지 재생성한다 (프롬프트 준수 실패 방어).
  const MAX_ATTEMPTS = 3;
  let questions: QuestionSpec[] | null = null;
  let shortfallNote: string | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const prompt = buildQuestionBankPrompt({
      industry: tenant.industry,
      region: tenant.region,
      brandName: tenant.brandName,
      competitorNames: tenant.competitors.map((c) => c.name),
      count: tenant.questionBankSize,
      version: tenant.questionBankVersion,
      previousVersionDiffNote: shortfallNote,
      language: tenant.questionLanguage,
    });
    const result = await judge.call(prompt);
    const parsed = parseJsonLoose<Array<Omit<QuestionSpec, 'industry' | 'region' | 'version'>>>(result.text);
    if (!parsed) {
      throw new Error(`[B1] 질문 은행 생성 실패: JSON 파싱 불가 (tenant=${tenant.tenantId}, attempt=${attempt})`);
    }

    const candidate: QuestionSpec[] = enforceAgnosticQuota(
      parsed.map((q) => ({
        ...q,
        industry: tenant.industry,
        region: tenant.region,
        version: tenant.questionBankVersion,
      })),
      quota,
      names,
    );

    const agnosticCount = countAgnostic(candidate);
    if (agnosticCount >= quota) {
      questions = candidate;
      break;
    }

    // 마지막 시도까지 미달이면 그대로 채택하되 경고 (측정은 계속). 그 외엔 부족분 명시 후 재시도.
    console.warn(
      `[B1] category-agnostic ${agnosticCount}/${candidate.length} < 하한 ${quota} ` +
        `(tenant=${tenant.tenantId}, attempt=${attempt}/${MAX_ATTEMPTS})`,
    );
    shortfallNote =
      `직전 생성은 category-agnostic이 ${agnosticCount}개뿐이라 실패했다. ` +
      `반드시 정확히 ${quota}개를 category-agnostic으로 만들어라.`;
    if (attempt === MAX_ATTEMPTS) questions = candidate;
  }

  if (!questions) {
    throw new Error(`[B1] 질문 은행 생성 실패 (tenant=${tenant.tenantId})`);
  }

  // 생성 프롬프트가 stage를 빠뜨린 문항만 한 번의 호출로 보정한다(옛 프롬프트·지시 무시 방어).
  questions = await tagJourneyStages(questions, judge);

  await store.saveQuestionBank(tenant.tenantId, {
    version: tenant.questionBankVersion,
    generatedAt: new Date().toISOString(),
    questions,
  });

  return questions;
}

/**
 * 이 측정에서 실제로 쓸 수집 엔진.
 *
 * 두 곳에서 필요하다 — 실제 수집(collectRawCalls)과, "이번 주 카드를 재사용해도 되는가"
 * 판단(measureAndBake의 코호트 재사용). 규칙을 복제하면 저장된 카드의 enginesUsed와
 * 비교 기준이 갈려 다른 엔진으로 잰 카드를 재사용해 버린다. 그래서 여기 한 곳에 둔다.
 *
 * API 키가 있는 엔진만 남긴다. 키 없는 엔진(예: OPENAI_API_KEY 미설정)은 클라이언트 생성자가
 * throw하므로, 미리 걸러 Gemini 단독 등으로 측정이 진행되게 한다(설계상 Gemini만으로 동작 가능).
 */
export function resolveCollectionEngines(tenant: TenantConfig): Engine[] {
  // 규칙은 engineKeys.ts 한 곳에 있다 — 엔진 선택 화면이 "키 없음"이라고 말하는 근거와
  // 여기서 실제로 거르는 근거가 갈리면, 고른 것과 잰 것이 달라진다.
  const override = globalCollectEngines();
  const configured = override ?? tenant.engines;

  const keys = engineKeyStatus();
  const available = configured.filter((e) => keys[e]);
  if (available.length === 0) {
    throw new Error(
      `측정 가능한 엔진이 없습니다 — 최소 GEMINI_API_KEY를 .env에 설정하세요(설정 엔진: ${configured.join(', ')}).`,
    );
  }
  if (available.length < configured.length) {
    const skipped = configured.filter((e) => !available.includes(e));
    console.warn(`[B3] 키 없는 엔진 건너뜀: ${skipped.join(', ')} → ${available.join(', ')}(으)로 측정`);
  }
  return available;
}

/**
 * B3 — 4개 엔진 × 반복 호출. 동일 질문 원문을 그대로 전달한다 (엔진 간 비교 가능성 유지).
 * 엔진별 예정 호출 수와 끊긴 엔진도 돌려준다 — 회차 기록(run.json)이 일부만 들어온 엔진을 가리는 데 쓴다.
 */
async function collectRawCalls(
  tenant: TenantConfig,
  questions: QuestionSpec[],
  weekOf: string,
): Promise<{ calls: RawCallRecord[]; plannedByEngine: Record<string, number>; engineIssues: string[] }> {
  const availableEngines = resolveCollectionEngines(tenant);

  const jobs = questions.flatMap((question) =>
    availableEngines.flatMap((engine) =>
      Array.from({ length: tenant.repeatsPerQuestion }, (_, i) => ({ question, engine, callIndex: i + 1 })),
    ),
  );

  // 엔진 하나가 죽어도(예: OpenAI 크레딧 소진 429) 측정 전체를 중단하지 않는다.
  // 실패한 호출은 건너뛰고 성공한 엔진의 응답만으로 진행한다(부분 저하 > 전면 실패).
  const failuresByEngine = new Map<string, number>();
  // 지출 한도 · 크레딧 · 키처럼 다시 시도해도 풀리지 않는 오류가 난 엔진은 남은 호출을 보내지 않는다(engineExhaustion.ts).
  // 남은 엔진의 호출을 다 받아도 수집 하한에 못 미치면 그 엔진들의 호출도 더 보내지 않는다 — 어차피 실패할 측정에
  // 몇 분씩 돈을 쓰지 않게(엔진 셋 중 하나가 처음부터 끊기면 성공률은 많아야 67%).
  const outage = new EngineOutage();
  const jobsByEngine = new Map<string, number>();
  for (const job of jobs) jobsByEngine.set(job.engine, (jobsByEngine.get(job.engine) ?? 0) + 1);
  const finishedByEngine = new Map<string, number>();
  const finish = (engine: string) => finishedByEngine.set(engine, (finishedByEngine.get(engine) ?? 0) + 1);
  const failedSoFar = () => [...failuresByEngine.values()].reduce((n, v) => n + v, 0);
  // 진행 보고 — 끝난 건수와 엔진별 진행(measureTracker.ts EngineProgress). 화면이 남은 시간을 어림하려면 「보내고 아직 답이 없는
  // 호출이 몇 초째 기다리는가」와 「끝난 호출이 얼마나 걸렸나」가 필요하다 — 끝자락에는 속도가 아니라 응답 시간이 남은 시간을 정한다.
  let collected = 0;
  const inflight = new Map<number, { engine: string; sentAt: number }>();
  const latencies = new Map<string, number[]>();
  const noteLatency = (engine: string, latencyMs: number | undefined) => {
    if (!latencyMs || latencyMs <= 0) return;
    latencies.set(engine, [...(latencies.get(engine) ?? []), latencyMs]);
  };
  const engineProgress = (): Record<string, EngineProgress> =>
    Object.fromEntries(
      [...jobsByEngine].map(([engine, total]) => {
        const progress: EngineProgress = {
          done: finishedByEngine.get(engine) ?? 0,
          total,
          inflightSentAt: [...inflight.values()].filter((c) => c.engine === engine).map((c) => c.sentAt).sort((a, b) => a - b),
          latencyMs: latencies.get(engine) ?? [],
          slots: collectLimit(engine as Engine),
          rpm: collectRpm(engine as Engine),
        };
        return [engine, progress];
      }),
    );
  updateActiveMeasure(tenant.tenantId, { stage: '수집', done: 0, total: jobs.length, engines: engineProgress() });
  const collectionConcurrency = Math.max(
    1,
    COLLECTION_CONCURRENCY_OVERRIDE || availableEngines.reduce((n, engine) => n + collectLimit(engine), 0),
  );
  const settled = await mapWithConcurrency(
    jobs,
    collectionConcurrency,
    async (job, index): Promise<RawCallRecord | null> => {
      // 중단 요청을 받았으면 남은 호출을 보내지 않는다 — 대기 중인 일감이 여기서 바로 끝난다.
      throwIfMeasureCancelled(tenant.tenantId);
      if (outage.isDown(job.engine) || outage.stopped) {
        if (outage.isDown(job.engine)) outage.skip(job.engine);
        else outage.skipStopped();
        failuresByEngine.set(job.engine, (failuresByEngine.get(job.engine) ?? 0) + 1);
        finish(job.engine);
        updateActiveMeasure(tenant.tenantId, { done: ++collected, engines: engineProgress() });
        return null;
      }
      const prompt = buildEngineCallPrompt(job.engine, job.question.text, tenant.questionLanguage);
      // 슬롯을 요청하기 전에 찍는다 — client.call 바깥에서 대기가 생긴다(engines/index.ts).
      const startedAt = new Date().toISOString();
      const onSend = () => {
        inflight.set(index, { engine: job.engine, sentAt: Date.now() });
        updateActiveMeasure(tenant.tenantId, { engines: engineProgress() });
      };
      try {
        const client = getEngineClient(job.engine); // 생성자도 try 안에서(키 문제 등 방어)
        const result = await client.call(prompt, { onSend });
        inflight.delete(index);
        noteLatency(job.engine, result.latencyMs);
        finish(job.engine);
        updateActiveMeasure(tenant.tenantId, { done: ++collected, engines: engineProgress() });
        return {
          tenantId: tenant.tenantId,
          weekOf,
          engine: job.engine,
          questionId: job.question.questionId,
          callIndex: job.callIndex,
          rawText: result.text,
          citations: result.citations,
          usedWebSearch: result.usedWebSearch,
          model: result.model,
          tokenUsage: result.tokenUsage,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          billedCost: result.billedCost,
          latencyMs: result.latencyMs,
          calledAt: new Date().toISOString(),
          startedAt,
        };
      } catch (err) {
        // 중단은 실패가 아니다 — 건너뛰고 계속하면 멈추라는 요청이 무시된다.
        inflight.delete(index);
        if (err instanceof MeasureCancelledError) throw err;
        failuresByEngine.set(job.engine, (failuresByEngine.get(job.engine) ?? 0) + 1);
        finish(job.engine);
        updateActiveMeasure(tenant.tenantId, { done: ++collected, engines: engineProgress() });
        if (outage.note(job.engine, err)) {
          // 측정 상태 화면 · 진행 표시가 「Gemini 지출 한도 초과」를 바로 보이게 한다.
          updateActiveMeasure(tenant.tenantId, { engineIssues: outage.labels() });
          console.warn(`[B3] ${outage.labels().join(', ')} — 이번 측정에서 이 엔진의 남은 호출은 보내지 않습니다 (tenant=${tenant.tenantId})`);
          // 끊긴 엔진의 남은 일감(보내는 중인 것 포함)은 성공할 수 없다. 나머지를 다 받아도 하한에 못 미치면 지금 멈춘다.
          const lostAhead = [...jobsByEngine]
            .filter(([engine]) => outage.isDown(engine))
            .reduce((n, [engine, total]) => n + Math.max(0, total - (finishedByEngine.get(engine) ?? 0)), 0);
          const bestCoverage = (jobs.length - failedSoFar() - lostAhead) / jobs.length;
          if (!partialMeasureAllowed() && bestCoverage < MIN_CALL_COVERAGE && !outage.stopped) {
            outage.stop(MIN_CALL_COVERAGE);
            updateActiveMeasure(tenant.tenantId, { collectionWillFail: true });
            console.warn(`[B3] 남은 엔진만으로는 수집 하한에 못 미칩니다(최대 ${Math.round(bestCoverage * 100)}%) — 남은 호출을 보내지 않습니다 (tenant=${tenant.tenantId})`);
          }
        }
        console.warn(
          `[B3] ${job.engine} 호출 실패(건너뜀) q=${job.question.questionId} #${job.callIndex}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
        return null;
      }
    },
  );

  // 끊긴 엔진의 일감은 곧바로 끝나 중단 요청을 확인할 일감이 남지 않을 수 있다 — 여기서 한 번 더 본다.
  // 안 보면 엔진이 끊긴 뒤 누른 「중단」이 「수집 부족」 실패로 끝난다.
  throwIfMeasureCancelled(tenant.tenantId);
  const calls = settled.filter((r): r is RawCallRecord => r !== null);
  if (failuresByEngine.size > 0) {
    const summary = [...failuresByEngine.entries()].map(([e, n]) => `${e} ${n}건`).join(', ');
    console.warn(`[B3] 엔진 호출 실패 요약 (tenant=${tenant.tenantId}): ${summary} — 성공 ${calls.length}/${jobs.length}건`);
  }
  if (calls.length === 0) {
    throw new CollectionError(
      `${outage.explain()}[B3] 모든 엔진 호출 실패 — 수집된 응답이 없습니다 (tenant=${tenant.tenantId}). 엔진 API 키·크레딧을 확인하세요.`,
      outage.labels(),
    );
  }
  try {
    assertEnoughCoverage(tenant, questions, jobs.length, calls, failuresByEngine);
  } catch (err) {
    // 무엇을 고치면 되는지(「Gemini 지출 한도 초과 — …」)를 문구 맨 앞에 둔다 — 화면은 이 문구를 그대로 보인다.
    throw new CollectionError(`${outage.explain()}${err instanceof Error ? err.message : String(err)}`, outage.labels());
  }
  return { calls, plannedByEngine: Object.fromEntries(jobsByEngine), engineIssues: outage.labels() };
}

/** 수집이 하한에 못 미쳐도 부분 데이터로 진행한다(ALLOW_PARTIAL_MEASURE=1) — assertEnoughCoverage 주석. */
function partialMeasureAllowed(): boolean {
  return process.env.ALLOW_PARTIAL_MEASURE === '1' || process.env.ALLOW_PARTIAL_MEASURE === 'true';
}

/** 이 비율에 못 미치면 측정을 실패로 끊는다. */
const MIN_QUESTION_COVERAGE = 0.9; // 응답이 한 건도 없는 질문이 10%를 넘으면 안 된다
const MIN_CALL_COVERAGE = 0.7; // 계획한 호출 중 성공 비율

/**
 * 반쪽짜리 수집을 성공으로 저장하지 못하게 막는다.
 *
 * 왜 필요한가. 엔진 실패는 건너뛰고 진행하는 것이 기본 설계다(부분 저하 > 전면 실패). 그런데
 * 실패가 대부분이면 이야기가 달라진다 — 실측(2026-09-13): Gemini 할당량이 소진된 상태에서
 * 36문항 측정이 응답 39건·질문 15개만 남기고 **HTTP 200으로 끝났고**, 그 반쪽 데이터가 이미
 * 있던 온전한 그 주 데이터를 덮어썼다. 되돌릴 수 없었다.
 *
 * 여기서 끊으면 아무것도 쓰이지 않는다. 저장(saveRawCalls)은 이 함수 뒤에 온다.
 *
 * 두 가지를 본다. 호출 성공률만 보면 질문 절반이 통째로 비어도 통과할 수 있다 —
 * 한 질문에 엔진×반복이 여러 건이라, 특정 질문에만 실패가 몰리면 총량은 멀쩡해 보인다.
 * 그래서 **응답이 하나도 없는 질문 수**를 따로 센다. 그 질문은 분석에서 아예 사라진다.
 *
 * 부분 데이터라도 꼭 받아야 하면 ALLOW_PARTIAL_MEASURE=1로 넘긴다.
 *
 * 내보내는 이유는 시험 때문이다 — 실제 엔진을 소진시키지 않고 경계값을 확인할 수 있어야 한다.
 */
export function assertEnoughCoverage(
  tenant: TenantConfig,
  questions: QuestionSpec[],
  plannedCalls: number,
  calls: RawCallRecord[],
  failuresByEngine: Map<string, number>,
): void {
  const answered = new Set(calls.map((c) => c.questionId));
  const questionCoverage = questions.length > 0 ? answered.size / questions.length : 1;
  const callCoverage = plannedCalls > 0 ? calls.length / plannedCalls : 1;
  if (questionCoverage >= MIN_QUESTION_COVERAGE && callCoverage >= MIN_CALL_COVERAGE) return;

  if (partialMeasureAllowed()) {
    console.warn(
      `[B3] 수집 부족하지만 ALLOW_PARTIAL_MEASURE로 진행 — 질문 ${answered.size}/${questions.length}, 호출 ${calls.length}/${plannedCalls}`,
    );
    return;
  }

  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const summary = [...failuresByEngine.entries()].map(([e, n]) => `${e} ${n}건`).join(', ') || '없음';
  throw new Error(
    `[B3] 수집이 너무 적어 측정을 중단했습니다 (tenant=${tenant.tenantId}). ` +
      `응답이 있는 질문 ${answered.size}/${questions.length}(${pct(questionCoverage)}, 하한 ${pct(MIN_QUESTION_COVERAGE)}), ` +
      `성공 호출 ${calls.length}/${plannedCalls}(${pct(callCoverage)}, 하한 ${pct(MIN_CALL_COVERAGE)}). ` +
      `엔진 실패: ${summary}. ` +
      `이 주 데이터는 건드리지 않았습니다 — 엔진 크레딧·할당량을 확인한 뒤 다시 실행하세요. ` +
      `부분 데이터라도 저장하려면 ALLOW_PARTIAL_MEASURE=1로 실행합니다.`,
  );
}

/**
 * B5-A~D — 반복 호출 1건마다 독립적으로 판정한다 (3회를 합쳐서 요약한 뒤 판정하지 않는다).
 * 그래야 반복 간 분산이 그대로 살아남아 이후 신뢰구간 계산에 쓰일 수 있다.
 */
async function analyzeRawCall(
  tenant: TenantConfig,
  call: RawCallRecord,
  rankingEntities: string[],
): Promise<QuestionRepeatAnalysis> {
  const judge = getJudgeClient();
  const brand = toBrandContext(tenant);

  // 판정 호출은 한 번의 왕복으로 모은다.
  //  - 사실성 호출을 Promise.all 밖에서 await하면 raw call마다 왕복이 2번이 된다(factGraph가 있는
  //    테넌트에서 판정 구간이 두 배로 늘어난다). 결과값은 같으므로 같이 묶는다.
  //  - 인용이 0건이면 분류할 URL이 없다. 실측 raw call의 40%가 그렇다. 호출을 건너뛰어도
  //    아래 citation?.citations ?? [] 경로가 "인용 없음"으로 같은 값을 만든다.
  const citationPrompt =
    call.citations.length > 0
      ? buildCitationClassificationPrompt(
          brand,
          call.rawText,
          call.citations.map((url): CitationCandidate => ({ url })),
        )
      : null;

  const startedAt = new Date().toISOString();
  const wallStart = performance.now();
  const [mentionRaw, citationRaw, rankRaw, factRaw] = await Promise.all([
    judge.call(buildBrandMentionPrompt(brand, call.rawText)),
    citationPrompt ? judge.call(citationPrompt) : Promise.resolve(null),
    judge.call(buildRecommendationOrderPrompt(brand, call.rawText, rankingEntities)),
    tenant.factGraph.length > 0
      ? judge.call(buildFactCheckPrompt(brand, call.rawText, tenant.factGraph))
      : Promise.resolve(null),
  ]);
  const wallMs = Math.round(performance.now() - wallStart);

  /*
   * 판정 사용량 — 실제로 부른 호출만 센다.
   *
   * citationPrompt와 factCheck은 조건부라 건너뛸 수 있다(인용 0건이 실측 40%). 건너뛴 호출을
   * 0으로 더하면 "부르고 0토큰 썼다"로 읽혀 호출 수가 부풀려진다 — 실제로 부른 것만 센다.
   * 합계(tokenUsage)와 입출력을 따로 더하는 이유는, 엔진에 따라 분리 값을 못 주는 경우에도
   * 합계는 남기기 위해서다.
   */
  const judgeCalls = [mentionRaw, citationRaw, rankRaw, factRaw].filter((r) => r !== null);
  const judgeUsage: JudgeUsage = {
    engine: usedJudgeEngineId(),
    // 판정 모델은 호출 결과가 실어 온 값을 쓴다 — 건너뛴 호출이 있어도 남은 것에서 얻는다.
    model: judgeCalls.find((r) => r.model)?.model,
    calls: judgeCalls.length,
    tokens: judgeCalls.reduce((a, r) => a + (r.tokenUsage ?? 0), 0),
    inputTokens: judgeCalls.reduce((a, r) => a + (r.inputTokens ?? 0), 0),
    outputTokens: judgeCalls.reduce((a, r) => a + (r.outputTokens ?? 0), 0),
  };

  const mention = parseJsonLoose<BrandMentionResult>(mentionRaw.text);
  const citation = citationRaw ? parseJsonLoose<CitationResult>(citationRaw.text) : null;
  const rank = parseJsonLoose<RecommendationOrderResult>(rankRaw.text);
  const fact = factRaw ? parseJsonLoose<FactCheckResult>(factRaw.text) : null;
  const factualityClaims: FactClaimDetail[] = (fact?.claims ?? []).map((c) => ({
    claimText: c.claimText,
    claimType: c.claimType,
    verdict: c.verdict,
    responseValue: c.responseValue,
    factGraphValue: c.factGraphValue,
  }));

  const mentioned = mention?.targetBrand.mentioned ?? false;
  const targetCount = mention?.targetBrand.mentionCount ?? 0;
  const competitorMentions: CompetitorMentionDetail[] = (mention?.competitorMentions ?? []).map((c) => ({
    name: c.name,
    mentionCount: c.mentionCount,
    sentences: c.mentions.map((m) => ({ sentence: m.sentence, sentiment: m.sentiment })),
  }));
  const competitorTotal = competitorMentions.reduce((sum, c) => sum + c.mentionCount, 0);
  const totalMentions = targetCount + competitorTotal;

  const brandRankEntry = rank?.ranking.find((r) => r.entity === tenant.brandName) ?? null;

  return {
    questionId: call.questionId,
    engine: call.engine,
    callIndex: call.callIndex,
    mentioned,
    mentionSentences: (mention?.targetBrand.mentions ?? []).map((m) => ({ sentence: m.sentence, sentiment: m.sentiment })),
    competitorMentions,
    shareOfMention: totalMentions > 0 ? targetCount / totalMentions : 0,
    citations: (citation?.citations ?? []).map((c) => ({
      raw: c.raw,
      // 판정 모델이 적은 domain은 같은 URL도 호스트·상위 도메인으로 오락가락한다 — URL에서 뽑는다.
      domain: urlHost(c.raw) ?? c.domain,
      ownerType: c.ownerType,
      supportsBrandMention: c.supportsBrandMention,
    })),
    topRecommendation: rank?.topRecommendation ?? null,
    brandRank: brandRankEntry?.rank ?? null,
    factualityClaims,
    factualitySupported: factualityClaims.filter((c) => c.verdict === 'supported').length,
    factualityContradicted: factualityClaims.filter((c) => c.verdict === 'contradicted').length,
    brandOwnedCitation: citation?.citations.some((c) => c.ownerType === 'brand-owned') ?? false,
    clarifying: isClarifyingResponse(call.rawText),
    timing: {
      startedAt,
      wallMs,
      judgeMs: {
        mention: mentionRaw.latencyMs ?? 0,
        citation: citationRaw?.latencyMs ?? null,
        rank: rankRaw.latencyMs ?? 0,
        fact: factRaw?.latencyMs ?? null,
      },
    },
    judgeUsage,
  };
}

/**
 * 판정을 보낼 순서(원문 레코드의 자리 번호) — 인용이 많은 답부터. 인용 판정이 분석 시간을 정한다(2026-W43 gunsan-national,
 * 인용 수와 건별 시간의 상관 0.87). 저장 순서대로 보내면 무거운 답이 줄 끝에서 늦게 시작해 혼자 꼬리를 만든다.
 * 같은 인용 수는 원래 순서 그대로다(안정 정렬). 내보내는 이유는 시험 때문이다(scripts/verify-measure-tail.ts).
 */
export function analysisOrder(rawCalls: RawCallRecord[]): number[] {
  return rawCalls.map((_, index) => index).sort((a, b) => rawCalls[b].citations.length - rawCalls[a].citations.length);
}

/** B8 — 결정적 집계. 지표 계산은 server/aggregate.ts 한 곳에만 두고 여기서는 카드를 조립한다. */
export function aggregateScorecard(
  tenant: TenantConfig,
  weekOf: string,
  questions: QuestionSpec[],
  analyses: QuestionRepeatAnalysis[],
  history: WeeklyScorecard[],
  cohortScorecards: WeeklyScorecard[],
  /** 그 주차에 실제로 쓴 모델(엔진 id → 모델명). 원문 레코드에서 뽑아 넘긴다. */
  modelsUsed: Record<string, string>,
  judgeModel: string | undefined,
): WeeklyScorecard {
  const m = aggregateWeeklyMetrics(tenant, questions, analyses);

  // 이번 주보다 앞선 주만 본다. 같은 주를 다시 재면 히스토리에 그 주의 이전 측정 카드가 아직
  // 남아 있어(saveScorecard가 교체하는 것은 이 계산 뒤다) 그 카드가 "전주"가 되고 이동평균에
  // 같은 주가 두 번 들어간다(실측 2026-W40 스테이,머뭄 3차: 전주 4·ma4 14, 맞는 값 27·21).
  // 재계산 스크립트(rescore-local·rescore-all)는 주차마다 한 장씩 히스토리를 쌓아 같은 규칙이다.
  const prior = history.filter((h) => h.weekOf < weekOf);
  const previousWeek = prior.length > 0 ? prior[prior.length - 1].aeoScore.current : m.score;
  const ma4 = Math.round(movingAverage4([...prior.map((h) => h.aeoScore.current), m.score]));

  return {
    tenantId: tenant.tenantId,
    weekOf,
    industry: tenant.industry,
    region: tenant.region,
    brandName: tenant.brandName,
    aeoScore: {
      current: m.score,
      ma4,
      previousWeek,
      ...ciBounds(m.score, m.ciMargin),
    },
    mentionRate: m.mentionRate,
    shareOfMention: m.shareOfMention,
    ...(m.shareOfMentionMentions !== undefined ? { shareOfMentionMentions: m.shareOfMentionMentions } : {}),
    ...(m.repeatsPerQuestion !== undefined ? { repeatsPerQuestion: m.repeatsPerQuestion } : {}),
    avgRecommendationRank: m.avgRecommendationRank,
    rankedResponses: m.rankedResponses,
    factualityScore: m.factualityScore,
    brandOwnedCitationRate: m.brandOwnedCitationRate,
    // 자기 순위는 「다른 카드 + 이번 점수」로 센다. 코호트 제외 목록(「지난 기록에서도 빼기」)에 든 경쟁사를 따로 재면 자기 카드가
    // 거른 목록에서 빠져 분모에 자기가 없고, 측정 끝의 다시 세기도 뺀 카드는 건너뛰어 그대로 남는다.
    cohortRank: computeCohortRank(m.score, [
      ...cohortScorecards.filter((c) => c.tenantId !== tenant.tenantId),
      { tenantId: tenant.tenantId, aeoScore: { current: m.score } } as WeeklyScorecard,
    ]),
    hallucinationFlags: m.hallucinationFlags,
    enginesUsed: m.enginesUsed,
    // 판단 엔진·질문 은행 버전은 지표 집계(aggregate.ts)가 아니라 여기서 붙인다 — 재계산
    // 스크립트는 저장된 카드를 그대로 물려받아야 한다. 다시 해석하면 "그때 무엇으로 재고
    // 무엇으로 판정했는지"가 지워진다.
    judgeEngine: usedJudgeEngineId(),
    // 모델도 같은 이유로 여기서 박제한다 — 설정을 나중에 읽으면 "그때 쓴 모델"이 아니라
    // "지금 설정된 모델"이 남아, 중간에 바꾸면 과거 카드가 조용히 거짓이 된다.
    ...(Object.keys(modelsUsed).length > 0 ? { modelsUsed } : {}),
    ...(judgeModel ? { judgeModel } : {}),
    questionBankVersion: tenant.questionBankVersion,
  };
}

export interface PipelineRunResult {
  scorecard: WeeklyScorecard;
  /** deferReport면 빈 문자열이다 — 리포트는 pendingReport가 끝나야 생긴다. */
  reportMarkdown: string;
  enginesUsed: string[]; // 실제로 응답을 수집한 엔진(성공 호출 기준). 크레딧 소진 등으로 실패한 엔진은 빠진다.
  /** deferReport일 때 뒤에서 쓰는 리포트. 실패해도 reject하지 않는다(로그만 남긴다). */
  pendingReport?: Promise<void>;
  /** 이번 측정이 그 주 카드를 덮지 않은 까닭(weekCardKeepReason). 있으면 scorecard는 이 회차의 카드이고 저장된 주차 카드는 앞의 것이다. */
  weekCardKept?: string;
  /** 회차 기록 번호(runs/<runId>/). 기록을 쓰지 못했으면 null — 측정은 그래도 성공이다. */
  runId: string | null;
}

export interface PipelineOptions {
  /**
   * 리포트(report.md)를 기다리지 않는다 — 스코어카드를 저장하면 끝내고 리포트는 뒤에서 쓴다.
   *
   * 리포트는 판정 엔진을 한 번 더 불러 16초쯤 걸리는데(2026-W43 gunsan-national 262초 중 16초) 점수 · 카드 · 순위의 입력이
   * 아니고, 앱 · CI 어디서도 report.md를 읽지 않는다. 그래도 측정 화면은 그동안 「리포트」 단계에 멈춰 있었다.
   * 화면에서 시작한 측정만 켠다(measureAndBake backgroundReport) — /pipeline/run은 응답에 reportMarkdown을 싣고,
   * 스크립트는 리포트 실패를 측정 실패로 본다. 앱을 바로 끄면 그 주 report.md는 앞선 측정의 것이 남는다.
   */
  deferReport?: boolean;
  /**
   * 측정 방식 — 측정 화면의 「이 브랜드만」, 다른 브랜드 측정 안의 경쟁사 측정. 회차 기록(run.json)에 적고, selfOnly는 그 주 카드를
   * 덮을지(weekCardKeepReason)도 정한다. 점수 계산에는 쓰지 않는다.
   */
  selfOnly?: boolean;
  inCohortRun?: boolean;
}

/**
 * 「이 브랜드만 측정」이 그 주 카드를 덮지 않을 까닭 — 덮어도 되면 null. 파이프라인은 selfOnly 측정에서만 부른다.
 *
 * 이 브랜드만 재면 경쟁사 카드는 그 주 앞서 잰 그대로다. 그 카드들과 같은 도구로 잰 그 주 카드를, 엔진 하나가 지출 한도 등으로
 * 빠진 회차가 덮으면 코호트 순위가 다른 도구로 잰 카드끼리 섞이고 전주 비교도 「수집 엔진 다름」으로 쉰다. 그래서 그 주 카드보다
 * 수집 엔진이 적으면(그 엔진들의 일부) 덮지 않는다. 경쟁사도 함께 재는 측정은 코호트 전체가 같은 엔진으로 다시 재지므로 지금처럼
 * 덮는다. 지역 · 업종 · 질문지 · 판정 엔진이 그 주 카드와 다르면(기본 정보를 고친 뒤 등) 그 카드를 지킬 까닭이 없어 덮는다 —
 * 지키면 옛 코호트에 카드가 남는다. 덮지 않은 회차도 회차 기록(runs/)에는 남는다.
 */
export function weekCardKeepReason(existing: WeeklyScorecard | undefined, next: WeeklyScorecard): string | null {
  if (!existing) return null;
  const sameConditions =
    existing.industry === next.industry &&
    existing.region === next.region &&
    existing.questionBankVersion === next.questionBankVersion &&
    existing.judgeEngine === next.judgeEngine;
  if (!sameConditions) return null;
  const before = existing.enginesUsed ?? [];
  const after = next.enginesUsed ?? [];
  if (before.length === 0 || after.length >= before.length || !after.every((e) => before.includes(e))) return null;
  return `수집 엔진(${[...after].sort().join('+')})이 이번 주 카드(${[...before].sort().join('+')})보다 적어 이번 주 카드는 그대로 둡니다`;
}

/** 판정 맥락 지문(RunMeta.contextFingerprint) — 별칭 · 소유 도메인 · 경쟁사 · 순위 후보. */
function contextFingerprint(tenant: TenantConfig, rankingEntities: string[]): string {
  const { aliases, ownedDomains, competitors } = toBrandContext(tenant);
  return createHash('sha256')
    .update(JSON.stringify({ aliases: aliases ?? [], ownedDomains: ownedDomains ?? [], competitors: competitors ?? [], rankingEntities }))
    .digest('hex')
    .slice(0, 16);
}

/** 수집 사용량 요약(RunMeta.collectUsage) — usageStats.ts와 같은 규칙. 청구액은 엔진이 모든 호출에 알려 줄 때만 합한다. */
function collectUsageOf(rawCalls: RawCallRecord[]): RunMeta['collectUsage'] {
  const out: RunMeta['collectUsage'] = {};
  const billed = new Map<string, number>();
  for (const r of rawCalls) {
    const row = (out[r.engine] ??= { calls: 0, tokens: 0, inputTokens: 0, outputTokens: 0, billedCost: 0, searchCalls: 0 });
    row.calls += 1;
    if (typeof r.tokenUsage === 'number') row.tokens += r.tokenUsage;
    if (typeof r.inputTokens === 'number') row.inputTokens += r.inputTokens;
    if (typeof r.outputTokens === 'number') row.outputTokens += r.outputTokens;
    if (typeof r.billedCost === 'number') {
      row.billedCost = (row.billedCost ?? 0) + r.billedCost;
      billed.set(r.engine, (billed.get(r.engine) ?? 0) + 1);
    }
    if (r.usedWebSearch === true) row.searchCalls += 1;
  }
  for (const [engine, row] of Object.entries(out)) if (billed.get(engine) !== row.calls) row.billedCost = null;
  return out;
}

/*
 * 브랜드 · 주차마다 마지막으로 카드를 저장한 측정의 번호. 뒤에서 쓰는 리포트가 끝나기 전에 같은 주를 다시 재면, 늦게 끝난
 * 옛 리포트가 새 카드의 리포트를 덮는다 — 리포트를 쓰기 전에 아직 자기 카드가 마지막인지 본다.
 */
const reportGeneration = new Map<string, number>();
let reportGenerationSeq = 0;
const pendingReports = new Set<Promise<void>>();

/** 뒤에서 쓰는 리포트가 다 끝나기를 기다린다 — 시험 스크립트가 임시 폴더를 지우기 전에 부른다. */
export async function settlePendingReports(): Promise<void> {
  while (pendingReports.size > 0) await Promise.all([...pendingReports]);
}

async function writeWeeklyReport(
  tenant: TenantConfig,
  store: ResultStore,
  weekOf: string,
  scorecard: WeeklyScorecard,
  analyses: QuestionRepeatAnalysis[],
  generation: number,
): Promise<string> {
  const eeat = computeEeatAnalysis(analyses);
  const citationSources = analyzeCitationSources(analyses);
  const reportResult = await getJudgeClient().call(buildWeeklyReportPrompt(scorecard, { eeat, citationSources }));
  if (reportGeneration.get(`${tenant.tenantId}|${weekOf}`) !== generation) {
    console.warn(`[B8] ${tenant.tenantId} ${weekOf} 리포트를 쓰는 사이 같은 주를 다시 재 — 옛 측정의 리포트는 저장하지 않습니다`);
    return reportResult.text;
  }
  await store.saveReport(tenant.tenantId, weekOf, reportResult.text);
  return reportResult.text;
}

/** 파이프라인 진입점. 스케줄러(B2)가 테넌트별로 주 1회 이 함수를 호출한다. */
export async function runWeeklyPipeline(
  tenant: TenantConfig,
  store: ResultStore,
  now: Date = new Date(),
  options: PipelineOptions = {},
): Promise<PipelineRunResult> {
  const weekOf = getIsoWeekString(now);
  const startedAt = new Date().toISOString();

  const questions = await ensureQuestionBank(tenant, store);
  throwIfMeasureCancelled(tenant.tenantId);
  const { calls: rawCalls, plannedByEngine, engineIssues } = await collectRawCalls(tenant, questions, weekOf);

  // Gemini 그라운딩 리다이렉트(vertexaisearch…/grounding-api-redirect)를 실제 발행 URL로 바꾼다.
  // 이걸 하지 않으면 인용 도메인이 전부 구글로 보여 자사 도메인 판별(Brand AEO Score 20%)과
  // 인용출처·인용 갭 분석이 무의미해진다. 해소 실패분은 원본을 그대로 둔다.
  updateActiveMeasure(tenant.tenantId, { stage: '인용 정리', done: 0, total: 0, engines: undefined });
  const resolvedCitations = await resolveCitationUrls(rawCalls.flatMap((c) => c.citations));
  if (resolvedCitations.size > 0) {
    for (const call of rawCalls) {
      call.citations = call.citations.map((u) => resolvedCitations.get(u) ?? u);
    }
  }
  // 마지막 중단 확인 지점. 여기를 지나면 판정 · 집계까지 끝까지 마무리한다.
  throwIfMeasureCancelled(tenant.tenantId);
  // 실제로 응답을 수집한 엔진(성공 호출 기준) — 설정만 되고 크레딧 소진 등으로 실패한 엔진은 제외된다.
  const enginesUsed = [...new Set(rawCalls.map((c) => c.engine))];

  // 추천 순위는 코호트 전원이 같은 병원 목록으로 매긴다(server/cohortEntities.ts).
  const rankingEntities = cohortRankingEntities(tenant, await loadRuntimeTenants());
  let analyzed = 0;
  updateActiveMeasure(tenant.tenantId, { stage: '분석', done: 0, total: rawCalls.length });
  // 결과는 원래 자리에 되돌려 저장 순서(question-analyses.json)를 지금과 같게 둔다 — 건끼리 의존하지 않는다(analyzeRawCall).
  const order = analysisOrder(rawCalls);
  const judged = await mapWithConcurrency(order, ANALYSIS_CONCURRENCY, async (index) => {
    const out = await analyzeRawCall(tenant, rawCalls[index], rankingEntities);
    updateActiveMeasure(tenant.tenantId, { done: ++analyzed });
    return out;
  });
  const analyses: QuestionRepeatAnalysis[] = new Array(rawCalls.length);
  order.forEach((index, k) => {
    analyses[index] = judged[k];
  });

  updateActiveMeasure(tenant.tenantId, { stage: '집계', done: 0, total: 0 });
  const history = await store.getScorecardHistory(tenant.tenantId, 12);
  const cohortScorecards = await store.getCohortScorecards(tenant.industry, tenant.region, weekOf);

  /*
   * 모델은 **원문 레코드가 실어 온 값**에서 뽑는다. 설정(configuredModels)을 읽으면 측정
   * 도중이나 이후에 바뀐 값이 들어갈 수 있다 — 기록의 뜻이 "그때 쓴 것"이어야 한다.
   * 한 엔진이 서로 다른 모델로 응답했다면(설정을 중간에 바꾼 경우) 쉼표로 둘 다 남긴다 —
   * 하나만 남기면 어느 쪽이 진짜인지 모르게 된다.
   */
  const modelsUsed: Record<string, string> = {};
  {
    const seen = new Map<string, Set<string>>();
    for (const c of rawCalls) {
      if (!c.model) continue;
      const set = seen.get(c.engine) ?? new Set<string>();
      set.add(c.model);
      seen.set(c.engine, set);
    }
    for (const [engine, set] of seen) modelsUsed[engine] = [...set].sort().join(', ');
  }
  const judgeModel = analyses.find((a) => a.judgeUsage?.model)?.judgeUsage?.model;

  const scorecard = aggregateScorecard(
    tenant,
    weekOf,
    questions,
    analyses,
    history,
    cohortScorecards,
    modelsUsed,
    judgeModel,
  );

  const weekCardKept = (options.selfOnly ? weekCardKeepReason(history.find((h) => h.weekOf === weekOf), scorecard) : null) ?? undefined;
  if (weekCardKept) {
    console.warn(`[B8] ${tenant.tenantId} ${weekOf} ${weekCardKept}`);
  } else {
    // 회차 기록이 없는 그 주 파일(v0.4.26 전 측정 · 회차 기록 저장 실패)은 덮기 전에 회차 기록으로 옮겨 둔다. 못 옮겨도 측정은 계속한다.
    await preserveUnrecordedWeekFile(store, tenant.tenantId, weekOf).catch((err: unknown) => {
      console.error(`[B8] ${tenant.tenantId} ${weekOf} 그 주 파일 옮겨 두기 실패(측정은 계속): ${err instanceof Error ? err.message : err}`);
    });
    // 그 주 파일은 판정 · 집계가 다 끝난 뒤에 원문 → 판정 → 카드 순으로 함께 쓴다. 원문을 판정 전에 쓰면, 판정에서 실패했을 때
    // 새 원문과 앞 측정의 판정 · 카드가 한 주차에 섞여 남는다(원문과 판정을 짝지어 읽는 곳 — answerEvidence · rejudge-ranks).
    await store.saveRawCalls(tenant.tenantId, weekOf, rawCalls);
    await store.saveQuestionAnalyses(tenant.tenantId, weekOf, analyses);
    await store.saveScorecard(scorecard);
  }

  const runId = await saveRunSnapshot(store, tenant, weekOf, scorecard, analyses, {
    runId: new Date().toISOString().replace(/[:.]/g, '-'),
    tenantId: tenant.tenantId,
    weekOf,
    startedAt,
    finishedAt: new Date().toISOString(),
    selfOnly: options.selfOnly === true,
    inCohortRun: options.inCohortRun === true,
    weekCard: weekCardKept ? 'kept' : 'saved',
    ...(weekCardKept ? { weekCardKeptReason: weekCardKept } : {}),
    engines: Object.fromEntries(
      Object.entries(plannedByEngine).map(([engine, planned]) => [engine, { planned, succeeded: rawCalls.filter((c) => c.engine === engine).length }]),
    ),
    engineIssues,
    contextFingerprint: contextFingerprint(tenant, rankingEntities),
    collectUsage: collectUsageOf(rawCalls),
  });
  // 그 주 카드를 그대로 두었으면 리포트도 앞 측정의 것을 둔다.
  if (weekCardKept) return { scorecard, reportMarkdown: '', enginesUsed, weekCardKept, runId };

  const generation = ++reportGenerationSeq;
  reportGeneration.set(`${tenant.tenantId}|${weekOf}`, generation);

  if (options.deferReport) {
    const pendingReport = writeWeeklyReport(tenant, store, weekOf, scorecard, analyses, generation).then(
      () => undefined,
      (err: unknown) => {
        console.error(`[B8] ${tenant.tenantId} ${weekOf} 리포트 저장 실패(측정 결과는 저장됨): ${err instanceof Error ? err.message : err}`);
      },
    );
    pendingReports.add(pendingReport);
    void pendingReport.finally(() => pendingReports.delete(pendingReport));
    return { scorecard, reportMarkdown: '', enginesUsed, pendingReport, runId };
  }

  updateActiveMeasure(tenant.tenantId, { stage: '리포트', done: 0, total: 0 });
  const reportMarkdown = await writeWeeklyReport(tenant, store, weekOf, scorecard, analyses, generation);
  return { scorecard, reportMarkdown, enginesUsed, runId };
}

/** 회차 기록을 남긴다. 못 남겨도 측정은 성공이다(그 주 파일은 이미 다 썼다) — 오류를 남기고 null. */
async function saveRunSnapshot(
  store: ResultStore,
  tenant: TenantConfig,
  weekOf: string,
  scorecard: WeeklyScorecard,
  analyses: QuestionRepeatAnalysis[],
  meta: RunMeta,
): Promise<string | null> {
  try {
    return await store.saveRunSnapshot(tenant.tenantId, weekOf, { scorecard, analyses, meta });
  } catch (err) {
    console.error(`[B8] ${tenant.tenantId} ${weekOf} 회차 기록 저장 실패(측정은 끝남): ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
