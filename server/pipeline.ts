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
import type { BrandMentionResult, CitationResult, FactCheckResult, RecommendationOrderResult } from './analysisTypes.js';
import { mapWithConcurrency } from './concurrency.js';
import { getIsoWeekString } from './dateUtil.js';
import { getEngineClient, getJudgeClient } from './engines/index.js';
import { parseJsonLoose } from './jsonParse.js';
import { analyzeCitationSources } from './citationSources.js';
import { computeEeatAnalysis } from './eeat.js';
import { computeAeoScore, computeCohortRank, mean, meanWithConfidenceInterval, movingAverage4 } from './scoring.js';
import type { ResultStore } from './store.js';
import type {
  CompetitorMentionDetail,
  FactClaimDetail,
  QuestionRepeatAnalysis,
  RawCallRecord,
  TenantConfig,
} from './types.js';

const COLLECTION_CONCURRENCY = 8;
const ANALYSIS_CONCURRENCY = 8;

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

  await store.saveQuestionBank(tenant.tenantId, {
    version: tenant.questionBankVersion,
    generatedAt: new Date().toISOString(),
    questions,
  });

  return questions;
}

/** B3 — 4개 엔진 × 반복 호출. 동일 질문 원문을 그대로 전달한다 (엔진 간 비교 가능성 유지). */
async function collectRawCalls(
  tenant: TenantConfig,
  questions: QuestionSpec[],
  weekOf: string,
): Promise<RawCallRecord[]> {
  const jobs = questions.flatMap((question) =>
    tenant.engines.flatMap((engine) =>
      Array.from({ length: tenant.repeatsPerQuestion }, (_, i) => ({ question, engine, callIndex: i + 1 })),
    ),
  );

  return mapWithConcurrency(jobs, COLLECTION_CONCURRENCY, async (job): Promise<RawCallRecord> => {
    const client = getEngineClient(job.engine);
    const prompt = buildEngineCallPrompt(job.engine, job.question.text);
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
  });
}

/**
 * B5-A~D — 반복 호출 1건마다 독립적으로 판정한다 (3회를 합쳐서 요약한 뒤 판정하지 않는다).
 * 그래야 반복 간 분산이 그대로 살아남아 이후 신뢰구간 계산에 쓰일 수 있다.
 */
async function analyzeRawCall(tenant: TenantConfig, call: RawCallRecord): Promise<QuestionRepeatAnalysis> {
  const judge = getJudgeClient();
  const brand = toBrandContext(tenant);

  const [mentionRaw, citationRaw, rankRaw] = await Promise.all([
    judge.call(buildBrandMentionPrompt(brand, call.rawText)),
    judge.call(
      buildCitationClassificationPrompt(
        brand,
        call.rawText,
        call.citations.map((url): CitationCandidate => ({ url })),
      ),
    ),
    judge.call(buildRecommendationOrderPrompt(brand, call.rawText)),
  ]);

  const mention = parseJsonLoose<BrandMentionResult>(mentionRaw.text);
  const citation = parseJsonLoose<CitationResult>(citationRaw.text);
  const rank = parseJsonLoose<RecommendationOrderResult>(rankRaw.text);

  let fact: FactCheckResult | null = null;
  if (tenant.factGraph.length > 0) {
    const factRaw = await judge.call(buildFactCheckPrompt(brand, call.rawText, tenant.factGraph));
    fact = parseJsonLoose<FactCheckResult>(factRaw.text);
  }
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
  };
}

/** B8 — 결정적 집계. LLM은 여기서 계산된 수치를 재계산하지 않고 해석만 한다. */
function aggregateScorecard(
  tenant: TenantConfig,
  weekOf: string,
  questions: QuestionSpec[],
  analyses: QuestionRepeatAnalysis[],
  history: WeeklyScorecard[],
  cohortScorecards: WeeklyScorecard[],
): WeeklyScorecard {
  const questionById = new Map(questions.map((q) => [q.questionId, q]));

  const categoryAgnostic = analyses.filter((a) => questionById.get(a.questionId)?.category === 'category-agnostic');
  const mentionRate = mean(categoryAgnostic.map((a) => (a.mentioned ? 1 : 0)));

  // SoM(Share of Voice) = 표준 정의인 "횟수 기준": 내 언급 총합 / (내 언급 + 경쟁사 언급) 총합.
  // 응답별 비율을 단순 평균하면 언급이 적은 응답이 과대 반영되므로, 횟수 기준으로 집계한다
  // (랭킹 분석 화면과 동일). 경쟁사가 없거나 아무 언급도 없으면 측정 불가(null).
  const hasCompetitors = tenant.competitors.length > 0;
  const brandMentionTotal = analyses.reduce((sum, a) => sum + a.mentionSentences.length, 0);
  const competitorMentionTotal = analyses.reduce(
    (sum, a) => sum + a.competitorMentions.reduce((t, c) => t + c.mentionCount, 0),
    0,
  );
  const shareTotal = brandMentionTotal + competitorMentionTotal;
  const shareOfMention = hasCompetitors && shareTotal > 0 ? brandMentionTotal / shareTotal : null;

  const ranked = analyses.map((a) => a.brandRank).filter((r): r is number => r !== null);
  const avgRecommendationRank = ranked.length > 0 ? mean(ranked) : null;

  const totalSupported = analyses.reduce((sum, a) => sum + a.factualitySupported, 0);
  const totalContradicted = analyses.reduce((sum, a) => sum + a.factualityContradicted, 0);
  const factualityScore = totalSupported + totalContradicted > 0 ? totalSupported / (totalSupported + totalContradicted) : 1;

  // 브랜드 소유 출처 = "인용 단위"(전체 인용 중 자사 도메인 비중, URL 상세 분석 화면과 동일).
  // 이전의 "자사 인용을 포함한 응답 비율"과 달리 라벨("인용이 자사 도메인으로 연결된 비율")과 일치한다.
  const totalCitations = analyses.reduce((sum, a) => sum + a.citations.length, 0);
  const brandOwnedCitations = analyses.reduce(
    (sum, a) => sum + a.citations.filter((c) => c.ownerType === 'brand-owned').length,
    0,
  );
  const brandOwnedCitationRate = totalCitations > 0 ? brandOwnedCitations / totalCitations : 0;

  // 점수는 위에서 확정한 집계 지표로 결정적으로 계산한다(화면 지표 → 공식 → 점수가 정확히 일치).
  const currentScore = computeAeoScore({
    mentionRate,
    shareOfMention,
    avgRecommendationRank,
    factualityScore,
    brandOwnedCitationRate,
  });

  // CI 폭은 반복 호출 1건마다의 점수 분포에서 낸다(동일 질문 3회 반복의 분산). 중심은 위 결정적 점수.
  const perCallScores = analyses.map((a) => {
    const perCallFactuality =
      a.factualitySupported + a.factualityContradicted > 0
        ? a.factualitySupported / (a.factualitySupported + a.factualityContradicted)
        : 1;
    return computeAeoScore({
      mentionRate: a.mentioned ? 1 : 0,
      shareOfMention: hasCompetitors ? a.shareOfMention : null,
      avgRecommendationRank: a.brandRank,
      factualityScore: perCallFactuality,
      brandOwnedCitationRate: a.brandOwnedCitation ? 1 : 0,
    });
  });
  const scoreCi = meanWithConfidenceInterval(perCallScores.length > 0 ? perCallScores : [0]);
  const ciMargin = scoreCi.high - scoreCi.mean;

  const previousWeek = history.length > 0 ? history[history.length - 1].aeoScore.current : currentScore;
  const ma4 = Math.round(movingAverage4([...history.map((h) => h.aeoScore.current), currentScore]));

  const hallucinationFlags = analyses
    .filter((a) => a.factualityContradicted > 0)
    .map((a) => `${a.engine} / ${a.questionId} #${a.callIndex}: 사실성 불일치 ${a.factualityContradicted}건`);

  return {
    tenantId: tenant.tenantId,
    weekOf,
    industry: tenant.industry,
    region: tenant.region,
    brandName: tenant.brandName,
    aeoScore: {
      current: currentScore,
      ma4,
      previousWeek,
      ciLow: Math.round((currentScore - ciMargin) * 10) / 10,
      ciHigh: Math.round((currentScore + ciMargin) * 10) / 10,
    },
    mentionRate,
    shareOfMention,
    avgRecommendationRank,
    factualityScore,
    brandOwnedCitationRate,
    cohortRank: computeCohortRank(currentScore, cohortScorecards),
    hallucinationFlags,
  };
}

export interface PipelineRunResult {
  scorecard: WeeklyScorecard;
  reportMarkdown: string;
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
  await store.saveRawCalls(tenant.tenantId, weekOf, rawCalls);

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

  return { scorecard, reportMarkdown: reportResult.text };
}
