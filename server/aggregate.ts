import type { QuestionSpec } from '../src/prompts/types.js';
import { MIN_SOM_MENTIONS, rankWeightFactor } from '../src/prompts/b8-report.js';
import { agnosticAnalyses, mentionTotals, shareOfMentionOf } from './mentionScope.js';
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
  /** SoM 표본(자사 + 경쟁사 언급 횟수). 경쟁사가 없으면 undefined. */
  shareOfMentionMentions?: number;
  avgRecommendationRank: number | null;
  factualityScore: number | null;
  brandOwnedCitationRate: number;
  /** 감성 계수(0.2~1.0). 점수에만 반영되고 화면 지표에는 들어가지 않는다. */
  mentionSentiment: number;
  /** 추천 순위가 매겨진 응답 수(카테고리 무관 질문) — 순위 비중을 정한다. */
  rankedResponses: number;
  /** 질문당 반복 횟수 — 판정 기록의 가장 큰 반복 번호. 판정 기록이 없으면 undefined. */
  repeatsPerQuestion?: number;
  score: number;
  /** 95% 신뢰구간 반폭. 중심은 score. */
  ciMargin: number;
  hallucinationFlags: string[];
  enginesUsed: string[];
}

// 표시 일관성을 위한 표준 엔진 순서(ChatGPT·Gemini·Claude·Perplexity).
const ENGINE_ORDER = ['openai', 'gemini', 'claude', 'perplexity'];

/**
 * 추천 순위가 있다고 보는 최소 순위 응답 수 — 1건이다. 응답이 적을 때의 과대 반영은 문턱이 아니라
 * 비중으로 막는다(b8-report.ts RANK_FULL_WEIGHT_RESPONSES·rankWeightFactor). 2026-W40 기준 순위가
 * 산출된 48곳 중 14곳이 1건이라, 3건 문턱은 응답 한 건 차이로 점수를 15점 넘게 바꿨다.
 */
export const MIN_RANKED_RESPONSES = 1;

/**
 * 점수의 95% 신뢰구간(소수 첫째 자리). 하한은 0에서 자른다 — 점수는 0~100이라 음수 하한은 있을 수
 * 없는 값을 보여 준다(2026-W40 홈캐스트 2점이 −9.1~13.1로 나왔다).
 *
 * 자르면 구간 폭이 줄어든다. 흔들림의 크기는 자르기 전 폭(상한 − 점수의 2배)으로 판단해야 한다
 * — 화면의 「변동성 큼」 알림과 리포트 문구가 그렇게 한다.
 */
export function ciBounds(score: number, margin: number): { ciLow: number; ciHigh: number } {
  return {
    ciLow: Math.max(0, Math.round((score - margin) * 10) / 10),
    ciHigh: Math.round((score + margin) * 10) / 10,
  };
}

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
  // (랭킹 분석 화면과 동일). 경쟁사가 없거나, 자사·경쟁사 언급이 MIN_SOM_MENTIONS번 미만이면 측정
  // 불가(null) — 몇 번의 언급으로 낸 비율은 한두 번에 크게 흔들린다(b8-report.ts 주석).
  const hasCompetitors = tenant.competitors.length > 0;
  const shareOfMention = shareOfMentionOf(categoryAgnostic, hasCompetitors, MIN_SOM_MENTIONS);
  const somTotals = mentionTotals(categoryAgnostic);
  const shareOfMentionMentions = hasCompetitors ? somTotals.brand + somTotals.competitors : undefined;

  // 추천 순위도 언급률과 같은 모집단(카테고리 무관 질문)에서 낸다. 브랜드명을 넣고 물으면 답이 그
  // 브랜드 중심으로 써져, 1위가 질문 때문에 나온다 — 2026-W39 라엘펜션은 언급률 0%인데 brand-direct
  // 응답 1건의 1위로 40점을 받아 스테이,머뭄(39점)보다 위에 섰다.
  const ranked = categoryAgnostic.map((a) => a.brandRank).filter((r): r is number => r !== null);
  const avgRecommendationRank = ranked.length >= MIN_RANKED_RESPONSES ? mean(ranked) : null;
  const rankedResponses = ranked.length;
  const rankWeight = rankWeightFactor(rankedResponses, avgRecommendationRank);

  // 사실성·인용은 전체 응답 기준 — 브랜드명이 들어간 질문에서도 그대로 의미가 있는 지표다.

  const totalSupported = analyses.reduce((sum, a) => sum + a.factualitySupported, 0);
  const totalContradicted = analyses.reduce((sum, a) => sum + a.factualityContradicted, 0);
  // 대조할 사실이 하나도 없으면 측정 불가다 — 100%로 채우지 않는다. 팩트 그래프가 없는 브랜드는 판정
  // 자체가 돌지 않아 늘 이 경우다. 점수에는 들어가지 않는 정확도 지표다(b8-report.ts 가중치 주석).
  const factualityScore =
    totalSupported + totalContradicted > 0 ? totalSupported / (totalSupported + totalContradicted) : null;

  // 브랜드 소유 출처 = "인용 단위"(전체 인용 중 자사 도메인 비중, URL 상세 분석 화면과 동일).
  // 이전의 "자사 인용을 포함한 응답 비율"과 달리 라벨("인용이 자사 도메인으로 연결된 비율")과 일치한다.
  const totalCitations = analyses.reduce((sum, a) => sum + a.citations.length, 0);
  const brandOwnedCitations = analyses.reduce(
    (sum, a) => sum + a.citations.filter((c) => c.ownerType === 'brand-owned').length,
    0,
  );
  const brandOwnedCitationRate = totalCitations > 0 ? brandOwnedCitations / totalCitations : 0;

  // 자사 언급의 감성 계수(0.2~1.0) — 언급 문장의 sentiment 가중 평균. 언급이 없으면 1.0(중립 취급).
  // Mention 성분에만 곱해 "부정적으로 많이 언급"이 가시성 점수를 깎도록 한다(원시 비율은 화면 표시용으로 유지).
  // 곱해지는 성분과 같은 모집단에서 낸다 — 안 그러면 성분과 계수가 서로 다른 질문 집합을 보게 된다.
  const agnosticSentiments = categoryAgnostic.flatMap((a) =>
    a.mentionSentences.map((m) => sentimentWeight(m.sentiment)),
  );
  const mentionSentiment = agnosticSentiments.length > 0 ? mean(agnosticSentiments) : 1.0;

  // 점수는 위에서 확정한 집계 지표로 결정적으로 계산한다(화면 지표 → 공식 → 점수가 정확히 일치).
  // SoM은 점수에 넣지 않는다 — 경쟁사 목록이 있는 브랜드만 잴 수 있어 코호트 안에서 같은 조건으로
  // 비교할 수 없다(b8-report.ts 가중치 주석). 화면·리포트용으로 카드에만 남긴다.
  const score = computeAeoScore({
    mentionRate,
    avgRecommendationRank,
    rankWeight,
    brandOwnedCitationRate,
    mentionSentiment,
  });

  // CI 폭은 반복 호출 1건마다의 점수 분포에서 낸다(동일 질문 3회 반복의 분산). 중심은 위 결정적 점수.
  // 응답별 순위도 위 지표와 같은 모집단만 쓴다 — 브랜드명 질문의 순위가 분산에 섞이지 않게.
  const agnosticSet = new Set(categoryAgnostic);
  const perCallScores = analyses.map((a) => {
    const perCallSentiment =
      a.mentionSentences.length > 0 ? mean(a.mentionSentences.map((m) => sentimentWeight(m.sentiment))) : 1.0;
    return computeAeoScore({
      mentionRate: a.mentioned ? 1 : 0,
      avgRecommendationRank: agnosticSet.has(a) ? a.brandRank : null,
      // 응답별 점수도 집계와 같은 순위 비중을 쓴다 — 중심과 분산이 서로 다른 산식을 보면 안 된다.
      rankWeight,
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

  // 반복 횟수는 설정이 아니라 실제로 물은 횟수에서 낸다 — 설정이 측정 뒤에 바뀌어도 카드는 그때 값을 남긴다.
  const repeatsPerQuestion = analyses.length > 0 ? Math.max(...analyses.map((a) => Number(a.callIndex) || 1)) : undefined;

  return {
    mentionRate,
    shareOfMention,
    ...(shareOfMentionMentions !== undefined ? { shareOfMentionMentions } : {}),
    rankedResponses,
    ...(repeatsPerQuestion !== undefined ? { repeatsPerQuestion } : {}),
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
