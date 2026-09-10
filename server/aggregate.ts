import type { QuestionSpec } from '../src/prompts/types.js';
import { agnosticAnalyses, shareOfMentionOf } from './mentionScope.js';
import { computeAeoScore, mean, meanWithConfidenceInterval, sentimentWeight } from './scoring.js';
import type { QuestionRepeatAnalysis } from './types.js';

/**
 * B8 주간 지표 집계 — 결정적 계산만 한다(LLM은 이 수치를 해석만 하고 재계산하지 않는다).
 *
 * 파이프라인(새 측정)과 재계산 스크립트(저장된 측정)가 반드시 같은 규칙을 써야 하므로
 * 여기 한 곳에만 둔다. 예전에 이 로직이 pipeline.ts와 scripts/ 양쪽에 복제돼 있어서
 * 저장된 주차와 새 주차의 정의가 갈린 적이 있다(2026-W36은 감성 계수 없이 계산된 카드).
 */

/** 집계에 필요한 테넌트 속성만. */
export interface AggregateTenant {
  competitors: { name: string }[];
}

export interface WeeklyMetrics {
  mentionRate: number;
  shareOfMention: number | null;
  avgRecommendationRank: number | null;
  factualityScore: number;
  brandOwnedCitationRate: number;
  /** 감성 계수(0.2~1.0). 점수에만 반영되고 화면 지표에는 들어가지 않는다. */
  mentionSentiment: number;
  score: number;
  /** 95% 신뢰구간 반폭. 중심은 score. */
  ciMargin: number;
  hallucinationFlags: string[];
  enginesUsed: string[];
}

// 표시 일관성을 위한 표준 엔진 순서(ChatGPT·Gemini·Claude·Perplexity).
const ENGINE_ORDER = ['openai', 'gemini', 'claude', 'perplexity'];

export function aggregateWeeklyMetrics(
  tenant: AggregateTenant,
  questions: QuestionSpec[],
  analyses: QuestionRepeatAnalysis[],
): WeeklyMetrics {
  // 언급률·SoM·감성 계수는 같은 모집단(카테고리 무관 질문)에서 낸다 — 근거는 server/mentionScope.ts.
  const categoryAgnostic = agnosticAnalyses(analyses, questions);
  const mentionRate = mean(categoryAgnostic.map((a) => (a.mentioned ? 1 : 0)));

  // SoM(Share of Voice) = 표준 정의인 "횟수 기준": 내 언급 총합 / (내 언급 + 경쟁사 언급) 총합.
  // 응답별 비율을 단순 평균하면 언급이 적은 응답이 과대 반영되므로 횟수 기준으로 집계한다
  // (랭킹 분석 화면과 동일). 경쟁사가 없거나 모집단에 아무 언급도 없으면 측정 불가(null).
  const hasCompetitors = tenant.competitors.length > 0;
  const shareOfMention = shareOfMentionOf(categoryAgnostic, hasCompetitors);

  // 순위·사실성·인용은 전체 응답 기준 — 브랜드명이 들어간 질문에서도 그대로 의미가 있는 지표다.
  const ranked = analyses.map((a) => a.brandRank).filter((r): r is number => r !== null);
  const avgRecommendationRank = ranked.length > 0 ? mean(ranked) : null;

  const totalSupported = analyses.reduce((sum, a) => sum + a.factualitySupported, 0);
  const totalContradicted = analyses.reduce((sum, a) => sum + a.factualityContradicted, 0);
  const factualityScore =
    totalSupported + totalContradicted > 0 ? totalSupported / (totalSupported + totalContradicted) : 1;

  // 브랜드 소유 출처 = "인용 단위"(전체 인용 중 자사 도메인 비중, URL 상세 분석 화면과 동일).
  // 이전의 "자사 인용을 포함한 응답 비율"과 달리 라벨("인용이 자사 도메인으로 연결된 비율")과 일치한다.
  const totalCitations = analyses.reduce((sum, a) => sum + a.citations.length, 0);
  const brandOwnedCitations = analyses.reduce(
    (sum, a) => sum + a.citations.filter((c) => c.ownerType === 'brand-owned').length,
    0,
  );
  const brandOwnedCitationRate = totalCitations > 0 ? brandOwnedCitations / totalCitations : 0;

  // 자사 언급의 감성 계수(0.2~1.0) — 언급 문장의 sentiment 가중 평균. 언급이 없으면 1.0(중립 취급).
  // Mention·SoM 성분에만 곱해 "부정적으로 많이 언급"이 가시성 점수를 깎도록 한다(원시 비율은 화면 표시용으로 유지).
  // 곱해지는 두 성분과 같은 모집단에서 낸다 — 안 그러면 성분과 계수가 서로 다른 질문 집합을 보게 된다.
  const agnosticSentiments = categoryAgnostic.flatMap((a) =>
    a.mentionSentences.map((m) => sentimentWeight(m.sentiment)),
  );
  const mentionSentiment = agnosticSentiments.length > 0 ? mean(agnosticSentiments) : 1.0;

  // 점수는 위에서 확정한 집계 지표로 결정적으로 계산한다(화면 지표 → 공식 → 점수가 정확히 일치).
  const score = computeAeoScore({
    mentionRate,
    shareOfMention,
    avgRecommendationRank,
    factualityScore,
    brandOwnedCitationRate,
    mentionSentiment,
  });

  // CI 폭은 반복 호출 1건마다의 점수 분포에서 낸다(동일 질문 3회 반복의 분산). 중심은 위 결정적 점수.
  const perCallScores = analyses.map((a) => {
    const perCallFactuality =
      a.factualitySupported + a.factualityContradicted > 0
        ? a.factualitySupported / (a.factualitySupported + a.factualityContradicted)
        : 1;
    const perCallSentiment =
      a.mentionSentences.length > 0 ? mean(a.mentionSentences.map((m) => sentimentWeight(m.sentiment))) : 1.0;
    return computeAeoScore({
      mentionRate: a.mentioned ? 1 : 0,
      shareOfMention: hasCompetitors ? a.shareOfMention : null,
      avgRecommendationRank: a.brandRank,
      factualityScore: perCallFactuality,
      brandOwnedCitationRate: a.brandOwnedCitation ? 1 : 0,
      mentionSentiment: perCallSentiment,
    });
  });
  const scoreCi = meanWithConfidenceInterval(perCallScores.length > 0 ? perCallScores : [0]);

  const hallucinationFlags = analyses
    .filter((a) => a.factualityContradicted > 0)
    .map((a) => `${a.engine} / ${a.questionId} #${a.callIndex}: 사실성 불일치 ${a.factualityContradicted}건`);

  // 실제로 응답을 수집한 엔진 — 분석(=성공 호출)에 등장한 엔진만. 크레딧 소진 등으로 실패한 엔진은 빠진다.
  const engineSet = new Set<string>(analyses.map((a) => a.engine));
  const enginesUsed = [
    ...ENGINE_ORDER.filter((e) => engineSet.has(e)),
    ...[...engineSet].filter((e) => !ENGINE_ORDER.includes(e)),
  ];

  return {
    mentionRate,
    shareOfMention,
    avgRecommendationRank,
    factualityScore,
    brandOwnedCitationRate,
    mentionSentiment,
    score,
    ciMargin: scoreCi.high - scoreCi.mean,
    hallucinationFlags,
    enginesUsed,
  };
}
