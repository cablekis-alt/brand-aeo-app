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
import { mapWithConcurrency } from './concurrency.js';
import { resolveCitationUrls } from './citationResolve.js';
import { isClarifyingResponse } from './clarifyingResponse.js';
import { getIsoWeekString } from './dateUtil.js';
import { getEngineClient, getJudgeClient, usedJudgeEngineId } from './engines/index.js';
import { parseJsonLoose } from './jsonParse.js';
import { tagJourneyStages } from './journeyStage.js';
import { aggregateWeeklyMetrics } from './aggregate.js';
import { analyzeCitationSources } from './citationSources.js';
import { computeEeatAnalysis } from './eeat.js';
import { computeCohortRank, movingAverage4 } from './scoring.js';
import type { ResultStore } from './store.js';
import type {
  CompetitorMentionDetail,
  FactClaimDetail,
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
// 서버가 429 대신 큐에 세워 지연만 길어진다. 그래서 수집을 전역 상한과 같은 24로 맞춘다.
// 판정은 검색이 없어 더 싸고 예산도 따로다(48). 항목당 판정 호출이 평균 2.6개라
// 16 × 2.6 ≈ 42로 그 예산을 채운다 — 8이면 브랜드 하나만 돌 때 21개밖에 못 띄워
// 파이프가 반만 찬다(실측: 단독 브랜드 2.75호출/초 vs 코호트 병렬 5.2호출/초).
const COLLECTION_CONCURRENCY = Math.max(1, Number(process.env.COLLECTION_CONCURRENCY) || 24);
const ANALYSIS_CONCURRENCY = Math.max(1, Number(process.env.ANALYSIS_CONCURRENCY) || 16);

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

/** B1 — 질문 은행은 버전당 1회만 생성하고 이후 주차에는 재사용한다 (버전을 바꾸면 재생성). */
export async function ensureQuestionBank(tenant: TenantConfig, store: ResultStore): Promise<QuestionSpec[]> {
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
  const ENGINE_ENV: Record<Engine, string> = {
    openai: 'OPENAI_API_KEY',
    gemini: 'GEMINI_API_KEY',
    claude: 'ANTHROPIC_API_KEY',
    perplexity: 'PERPLEXITY_API_KEY',
  };
  // COLLECT_ENGINES(쉼표 구분)를 설정하면 모든 테넌트의 수집 엔진을 전역으로 덮어쓴다.
  // 기존 테넌트 30개가 모두 ['openai','gemini']로 저장돼 있어, 엔진 커버리지를 넓힐 때
  // 설정 파일을 일괄 수정하지 않고 환경변수 하나로 전환할 수 있게 한다(미설정 시 기존 동작 그대로).
  const ALL_ENGINES: Engine[] = ['openai', 'gemini', 'claude', 'perplexity'];
  const override = (process.env.COLLECT_ENGINES ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is Engine => (ALL_ENGINES as string[]).includes(s));
  const configured = override.length > 0 ? override : tenant.engines;

  const useMock = process.env.USE_MOCK_ENGINES === 'true';
  const available = useMock ? configured : configured.filter((e) => process.env[ENGINE_ENV[e]]);
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

/** B3 — 4개 엔진 × 반복 호출. 동일 질문 원문을 그대로 전달한다 (엔진 간 비교 가능성 유지). */
async function collectRawCalls(
  tenant: TenantConfig,
  questions: QuestionSpec[],
  weekOf: string,
): Promise<RawCallRecord[]> {
  const availableEngines = resolveCollectionEngines(tenant);

  const jobs = questions.flatMap((question) =>
    availableEngines.flatMap((engine) =>
      Array.from({ length: tenant.repeatsPerQuestion }, (_, i) => ({ question, engine, callIndex: i + 1 })),
    ),
  );

  // 엔진 하나가 죽어도(예: OpenAI 크레딧 소진 429) 측정 전체를 중단하지 않는다.
  // 실패한 호출은 건너뛰고 성공한 엔진의 응답만으로 진행한다(부분 저하 > 전면 실패).
  const failuresByEngine = new Map<string, number>();
  const settled = await mapWithConcurrency(
    jobs,
    COLLECTION_CONCURRENCY,
    async (job): Promise<RawCallRecord | null> => {
      const prompt = buildEngineCallPrompt(job.engine, job.question.text);
      try {
        const client = getEngineClient(job.engine); // 생성자도 try 안에서(키 문제 등 방어)
        const result = await client.call(prompt);
        return {
          tenantId: tenant.tenantId,
          weekOf,
          engine: job.engine,
          questionId: job.question.questionId,
          callIndex: job.callIndex,
          rawText: result.text,
          citations: result.citations,
          usedWebSearch: result.usedWebSearch,
          tokenUsage: result.tokenUsage,
          latencyMs: result.latencyMs,
          calledAt: new Date().toISOString(),
        };
      } catch (err) {
        failuresByEngine.set(job.engine, (failuresByEngine.get(job.engine) ?? 0) + 1);
        console.warn(
          `[B3] ${job.engine} 호출 실패(건너뜀) q=${job.question.questionId} #${job.callIndex}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
        return null;
      }
    },
  );

  const calls = settled.filter((r): r is RawCallRecord => r !== null);
  if (failuresByEngine.size > 0) {
    const summary = [...failuresByEngine.entries()].map(([e, n]) => `${e} ${n}건`).join(', ');
    console.warn(`[B3] 엔진 호출 실패 요약 (tenant=${tenant.tenantId}): ${summary} — 성공 ${calls.length}/${jobs.length}건으로 진행`);
  }
  if (calls.length === 0) {
    throw new Error(
      `[B3] 모든 엔진 호출 실패 — 수집된 응답이 없습니다 (tenant=${tenant.tenantId}). 엔진 API 키·크레딧을 확인하세요.`,
    );
  }
  return calls;
}

/**
 * B5-A~D — 반복 호출 1건마다 독립적으로 판정한다 (3회를 합쳐서 요약한 뒤 판정하지 않는다).
 * 그래야 반복 간 분산이 그대로 살아남아 이후 신뢰구간 계산에 쓰일 수 있다.
 */
async function analyzeRawCall(tenant: TenantConfig, call: RawCallRecord): Promise<QuestionRepeatAnalysis> {
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

  const [mentionRaw, citationRaw, rankRaw, factRaw] = await Promise.all([
    judge.call(buildBrandMentionPrompt(brand, call.rawText)),
    citationPrompt ? judge.call(citationPrompt) : Promise.resolve(null),
    judge.call(buildRecommendationOrderPrompt(brand, call.rawText)),
    tenant.factGraph.length > 0
      ? judge.call(buildFactCheckPrompt(brand, call.rawText, tenant.factGraph))
      : Promise.resolve(null),
  ]);

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
      domain: c.domain,
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
  };
}

/** B8 — 결정적 집계. 지표 계산은 server/aggregate.ts 한 곳에만 두고 여기서는 카드를 조립한다. */
function aggregateScorecard(
  tenant: TenantConfig,
  weekOf: string,
  questions: QuestionSpec[],
  analyses: QuestionRepeatAnalysis[],
  history: WeeklyScorecard[],
  cohortScorecards: WeeklyScorecard[],
): WeeklyScorecard {
  const m = aggregateWeeklyMetrics(tenant, questions, analyses);

  const previousWeek = history.length > 0 ? history[history.length - 1].aeoScore.current : m.score;
  const ma4 = Math.round(movingAverage4([...history.map((h) => h.aeoScore.current), m.score]));

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
      ciLow: Math.round((m.score - m.ciMargin) * 10) / 10,
      ciHigh: Math.round((m.score + m.ciMargin) * 10) / 10,
    },
    mentionRate: m.mentionRate,
    shareOfMention: m.shareOfMention,
    avgRecommendationRank: m.avgRecommendationRank,
    factualityScore: m.factualityScore,
    brandOwnedCitationRate: m.brandOwnedCitationRate,
    cohortRank: computeCohortRank(m.score, cohortScorecards),
    hallucinationFlags: m.hallucinationFlags,
    enginesUsed: m.enginesUsed,
    // 판단 엔진·질문 은행 버전은 지표 집계(aggregate.ts)가 아니라 여기서 붙인다 — 재계산
    // 스크립트는 저장된 카드를 그대로 물려받아야 한다. 다시 해석하면 "그때 무엇으로 재고
    // 무엇으로 판정했는지"가 지워진다.
    judgeEngine: usedJudgeEngineId(),
    questionBankVersion: tenant.questionBankVersion,
  };
}

export interface PipelineRunResult {
  scorecard: WeeklyScorecard;
  reportMarkdown: string;
  enginesUsed: string[]; // 실제로 응답을 수집한 엔진(성공 호출 기준). 크레딧 소진 등으로 실패한 엔진은 빠진다.
}

/** 파이프라인 진입점. 스케줄러(B2)가 테넌트별로 주 1회 이 함수를 호출한다. */
export async function runWeeklyPipeline(
  tenant: TenantConfig,
  store: ResultStore,
  now: Date = new Date(),
): Promise<PipelineRunResult> {
  const weekOf = getIsoWeekString(now);

  const questions = await ensureQuestionBank(tenant, store);
  const rawCalls = await collectRawCalls(tenant, questions, weekOf);

  // Gemini 그라운딩 리다이렉트(vertexaisearch…/grounding-api-redirect)를 실제 발행 URL로 바꾼다.
  // 이걸 하지 않으면 인용 도메인이 전부 구글로 보여 자사 도메인 판별(AVS 20%)과
  // 인용출처·인용 갭 분석이 무의미해진다. 해소 실패분은 원본을 그대로 둔다.
  const resolvedCitations = await resolveCitationUrls(rawCalls.flatMap((c) => c.citations));
  if (resolvedCitations.size > 0) {
    for (const call of rawCalls) {
      call.citations = call.citations.map((u) => resolvedCitations.get(u) ?? u);
    }
  }
  await store.saveRawCalls(tenant.tenantId, weekOf, rawCalls);
  // 실제로 응답을 수집한 엔진(성공 호출 기준) — 설정만 되고 크레딧 소진 등으로 실패한 엔진은 제외된다.
  const enginesUsed = [...new Set(rawCalls.map((c) => c.engine))];

  const analyses = await mapWithConcurrency(rawCalls, ANALYSIS_CONCURRENCY, (call) => analyzeRawCall(tenant, call));
  await store.saveQuestionAnalyses(tenant.tenantId, weekOf, analyses);

  const history = await store.getScorecardHistory(tenant.tenantId, 12);
  const cohortScorecards = await store.getCohortScorecards(tenant.industry, tenant.region, weekOf);

  const scorecard = aggregateScorecard(tenant, weekOf, questions, analyses, history, cohortScorecards);
  await store.saveScorecard(scorecard);

  const eeat = computeEeatAnalysis(analyses);
  const citationSources = analyzeCitationSources(analyses);

  const judge = getJudgeClient();
  const reportResult = await judge.call(buildWeeklyReportPrompt(scorecard, { eeat, citationSources }));
  await store.saveReport(tenant.tenantId, weekOf, reportResult.text);

  return { scorecard, reportMarkdown: reportResult.text, enginesUsed };
}
