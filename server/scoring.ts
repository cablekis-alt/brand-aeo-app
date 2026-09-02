import type { WeeklyScorecard } from '../src/prompts/b8-report.js';

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

// n이 작을 때(설계상 반복 3회) z=1.96을 쓰면 구간이 실제보다 좁게 나온다.
// df=1~29 구간은 t-분포 임계값을 쓰고, 그 이상은 정규분포로 수렴한다고 보고 z=1.96을 쓴다.
const T_TABLE_95: Record<number, number> = {
  1: 12.71, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571,
  6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
  15: 2.131, 20: 2.086, 25: 2.06, 29: 2.045,
};

function tCritical95(df: number): number {
  if (df <= 0) return 0;
  if (T_TABLE_95[df]) return T_TABLE_95[df];
  if (df >= 29) return 1.96;
  const knownDf = Object.keys(T_TABLE_95).map(Number).sort((a, b) => a - b);
  const upper = knownDf.find((d) => d > df) ?? 29;
  return T_TABLE_95[upper];
}

export interface ConfidenceInterval {
  mean: number;
  low: number;
  high: number;
}

/** 반복 호출(설계상 엔진당 3회) 결과의 평균과 95% 신뢰구간을 계산한다. */
export function meanWithConfidenceInterval(values: number[]): ConfidenceInterval {
  const m = mean(values);
  if (values.length < 2) return { mean: m, low: m, high: m };
  const sd = stddev(values);
  const marginOfError = tCritical95(values.length - 1) * (sd / Math.sqrt(values.length));
  return { mean: m, low: m - marginOfError, high: m + marginOfError };
}

/** 최근 4주(당월 포함) 이동평균. 4주 미만이면 있는 만큼만으로 평균낸다. */
export function movingAverage4(weeklyScoresOldestFirst: number[]): number {
  const last4 = weeklyScoresOldestFirst.slice(-4);
  return mean(last4);
}

export interface AeoScoreInputs {
  mentionRate: number; // 0~1, category-agnostic 질문 중 언급 비율
  shareOfMention: number | null; // 0~1. 경쟁사가 없으면 측정 불가(null)
  avgRecommendationRank: number | null; // 1이 최상위, null이면 순위 데이터 없음
  factualityScore: number; // 0~1
  brandOwnedCitationRate: number; // 0~1
}

// 가중치는 초기값이며 테넌트/업종별로 조정 가능하도록 상수로 분리해둔다.
export const AEO_SCORE_WEIGHTS = {
  mentionRate: 0.35,
  shareOfMention: 0.25,
  recommendationRank: 0.15,
  factuality: 0.15,
  brandOwnedCitation: 0.1,
};

/** 순위(1=최상위)를 0~1 스코어로 변환. */
function normalizeRank(rank: number, maxRank = 5): number {
  return Math.max(0, (maxRank - rank + 1) / maxRank);
}

/**
 * B8 AEO Score. 0~100 스케일. 산식은 리포트 생성 프롬프트(b8-report.ts)에 입력으로만 전달되고, 재계산되지 않는다.
 * 측정되지 않은 항목은 지어내지 않고 재정규화로 제외한다:
 *   - shareOfMention이 null(경쟁사 없음)이면 그 가중치(0.25)를 제외.
 *   - avgRecommendationRank가 null(추천 문맥 자체가 없어 순위 판정 불가)이면 그 가중치(0.15)를 제외.
 * 남은 항목의 가중치 합으로 나눠 비례 재정규화한다.
 */
export function computeAeoScore(inputs: AeoScoreInputs): number {
  const components: { value: number; weight: number }[] = [
    { value: inputs.mentionRate, weight: AEO_SCORE_WEIGHTS.mentionRate },
    { value: inputs.factualityScore, weight: AEO_SCORE_WEIGHTS.factuality },
    { value: inputs.brandOwnedCitationRate, weight: AEO_SCORE_WEIGHTS.brandOwnedCitation },
  ];
  if (inputs.avgRecommendationRank !== null) {
    components.push({
      value: normalizeRank(inputs.avgRecommendationRank),
      weight: AEO_SCORE_WEIGHTS.recommendationRank,
    });
  }
  if (inputs.shareOfMention !== null) {
    components.push({ value: inputs.shareOfMention, weight: AEO_SCORE_WEIGHTS.shareOfMention });
  }
  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  const composite = components.reduce((sum, c) => sum + c.value * (c.weight / totalWeight), 0);
  return Math.round(composite * 100);
}

export function computeCohortRank(
  tenantScore: number,
  cohortScorecards: WeeklyScorecard[],
): { position: number; totalTenants: number } {
  const scores = cohortScorecards.map((s) => s.aeoScore.current).sort((a, b) => b - a);
  const position = scores.filter((s) => s > tenantScore).length + 1;
  return { position, totalTenants: Math.max(scores.length, 1) };
}
