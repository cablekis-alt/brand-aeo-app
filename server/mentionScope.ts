import type { QuestionCategory } from '../src/prompts/types.js';

/**
 * 언급률·SoM의 산출 모집단 — "카테고리 무관"(무프롬프트) 질문의 응답만 쓴다.
 *
 * 브랜드명이 들어간 질문(brand-direct·comparison·price-spec)은 엔진이 거의 항상 그 브랜드를
 * 말하므로, 모집단에 넣으면 점유율이 구조적으로 부풀려진다. 언급률은 원래부터 카테고리 무관
 * 질문만 썼는데 SoM은 전체 응답을 써서 두 지표가 서로 다른 모집단을 보고 있었다(예: 무프롬프트
 * 언급 2.1%인데 SoM 65.7%). 같은 모집단으로 맞춰야 "얼마나 불려지는가(언급률)"와 "불릴 때
 * 경쟁사 대비 얼마를 가져가는가(SoM)"가 한 화면에서 비교된다.
 */
export const MENTION_SCOPE_LABEL = '카테고리 무관 질문';

/** 판정 레코드에서 카테고리 무관 질문의 응답만 골라낸다. 은행에 없는 questionId는 제외한다. */
export function agnosticAnalyses<T extends { questionId: string }>(
  analyses: T[],
  questions: { questionId: string; category: QuestionCategory }[],
): T[] {
  const categoryOf = new Map(questions.map((q) => [q.questionId, q.category]));
  return analyses.filter((a) => categoryOf.get(a.questionId) === 'category-agnostic');
}

interface MentionCountable {
  mentionSentences: unknown[];
  competitorMentions: { mentionCount: number }[];
}

/** 브랜드·경쟁사 언급 문장 수 합계. SoM은 응답별 비율의 평균이 아니라 이 횟수 기준으로 낸다. */
export function mentionTotals(analyses: MentionCountable[]): { brand: number; competitors: number } {
  return {
    brand: analyses.reduce((sum, a) => sum + a.mentionSentences.length, 0),
    competitors: analyses.reduce(
      (sum, a) => sum + a.competitorMentions.reduce((t, c) => t + c.mentionCount, 0),
      0,
    ),
  };
}

/**
 * SoM(Share of Voice) = 내 언급 총합 / (내 + 경쟁사 언급) 총합.
 * 경쟁사가 설정되지 않았거나 모집단에 아무 언급도 없으면 측정 불가(null) — 0으로 대체하지 않는다.
 */
export function shareOfMentionOf(analyses: MentionCountable[], hasCompetitors: boolean): number | null {
  const { brand, competitors } = mentionTotals(analyses);
  const total = brand + competitors;
  return hasCompetitors && total > 0 ? brand / total : null;
}
