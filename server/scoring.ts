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
  mentionRate: number; // 0~1, category-agnostic 질문 중 언급 비율(원시 비율 — 화면 표시값과 동일)
  shareOfMention: number | null; // 0~1. 경쟁사가 없으면 측정 불가(null)
  avgRecommendationRank: number | null; // 1이 최상위, null이면 순위 데이터 없음
  factualityScore: number; // 0~1
  brandOwnedCitationRate: number; // 0~1
  // 자사 언급의 감성 계수(positive 1.0 / neutral 0.7 / negative 0.2의 평균, 0.2~1.0). 언급이 없으면 1.0(중립 취급).
  // 점수 계산 시 Mention·SoM 성분 값에 곱해, "부정적으로 많이 언급"이 가시성 점수를 깎도록 한다.
  // 원시 비율(mentionRate·shareOfMention)은 화면 표시용으로 그대로 두고, 감성은 여기서만 반영한다.
  mentionSentiment?: number;
}

/** 감성 → 가중치. positive 1.0 · neutral 0.7 · negative 0.2 (미상은 중립 0.7). */
export function sentimentWeight(s: 'positive' | 'neutral' | 'negative' | string): number {
  return s === 'positive' ? 1.0 : s === 'negative' ? 0.2 : 0.7;
}

// AVS(Brand AEO Score) 가중치 — 권장 하이브리드(합 1.0).
//   Mention 0.25 · Share of Mention 0.25 · Citation 0.20 · Position 0.15 · Factuality 0.15
//   · Mention/SoM에는 감성 계수를 곱한다  · EEAT는 점수에 넣지 않고 별도 진단 축으로 둔다
//   · SoM/순위가 null(경쟁사·추천문맥 없음)이면 그 가중치를 빼고 남은 합으로 재정규화.
export const AEO_SCORE_WEIGHTS = {
  mentionRate: 0.25,
  shareOfMention: 0.25,
  brandOwnedCitation: 0.2,
  recommendationRank: 0.15,
  factuality: 0.15,
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
  // 감성 계수: Mention·SoM 성분에만 곱한다(0.2~1.0). 미지정이면 1.0(중립적 취급 — 원시 비율 그대로).
  const s = inputs.mentionSentiment ?? 1.0;
  const components: { value: number; weight: number }[] = [
    { value: inputs.mentionRate * s, weight: AEO_SCORE_WEIGHTS.mentionRate },
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
    components.push({ value: inputs.shareOfMention * s, weight: AEO_SCORE_WEIGHTS.shareOfMention });
  }
  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  const composite = components.reduce((sum, c) => sum + c.value * (c.weight / totalWeight), 0);
  return Math.round(composite * 100);
}

/**
 * 코호트 순위 — 표준 경쟁 랭킹(1-2-3-4-4: 동점은 같은 번호, 그 다음 번호를 건너뛴다).
 *
 * position은 "내 점수보다 엄격히 높은 브랜드 수 + 1"이라 동점 위/아래 브랜드의 순위가
 * 흔들리지 않는다. 동점을 소수점으로 깨지 않는 것은 의도다 — aeoScore.current는 정수로
 * 반올림된 값이고 신뢰구간이 ±3~6점이라, 0.4점 차이로 서열을 매기면 화면에 같은 숫자가
 * 보이는 두 브랜드에 설명할 수 없는 우열이 생긴다.
 *
 * members에 비교 대상을 남긴다 — 순위 숫자만으로는 주차 간 비교가 성립하지 않는다
 * (측정한 경쟁사 구성이 주차마다 달라진다).
 */
/**
 * 두 코호트 순위가 같은지 — 저장을 건너뛸지 판단할 때 쓴다.
 * members가 비어 있으면 "다르다"로 본다(v0.1.44 이전 카드를 backfill해야 alerts가 주차 간
 * 비교를 할 수 있다).
 */
export function sameCohortRank(
  a: WeeklyScorecard['cohortRank'] | undefined,
  b: WeeklyScorecard['cohortRank'],
): boolean {
  if (!a || !a.members?.length) return false;
  return (
    a.position === b.position &&
    a.totalTenants === b.totalTenants &&
    (a.tiedCount ?? 1) === (b.tiedCount ?? 1) &&
    a.members.length === (b.members?.length ?? 0) &&
    a.members.every((m, i) => m.tenantId === b.members?.[i]?.tenantId && m.aeoScore === b.members?.[i]?.aeoScore)
  );
}

export function computeCohortRank(
  tenantScore: number,
  cohortScorecards: WeeklyScorecard[],
): NonNullable<WeeklyScorecard['cohortRank']> {
  const scores = cohortScorecards.map((s) => s.aeoScore.current);
  const position = scores.filter((s) => s > tenantScore).length + 1;
  return {
    position,
    totalTenants: Math.max(scores.length, 1),
    tiedCount: Math.max(scores.filter((s) => s === tenantScore).length, 1),
    // tenantId로 정렬해 둔다 — 저장 순서가 readdir 순서에 흔들리지 않아야 sameCohortRank가
    // "달라졌다"고 오판해 매번 다시 쓰지 않는다.
    members: cohortScorecards
      .map((s) => ({ tenantId: s.tenantId, aeoScore: s.aeoScore.current }))
      .sort((a, b) => a.tenantId.localeCompare(b.tenantId)),
  };
}
