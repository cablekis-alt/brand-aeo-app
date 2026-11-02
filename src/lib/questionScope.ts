/**
 * 실증 질문(probe)과 점수 모집단 — 어느 문항의 응답을 점수에 세는가를 한 곳에서 정한다.
 *
 * 실증 질문은 우리 글이 AI 답에 인용되는지 실험하려고 같은 질문지 판에 덧붙인 이름 없는 질문이다. 측정은 다른 질문처럼
 * 매번 묻지만, 점수 · 코호트 비교 · 고객 리포트 서술 · 본 글에서는 뺀다. 그래야 덧붙여도 점수 모집단이 문항 하나 바뀌지
 * 않고(기존 id · 엔진 · 반복 그대로), 판이 같으니 「같은 조건」 판정도 그대로 참이다.
 *
 * 'category-agnostic'으로 점수 모집단을 고르던 곳은 isScoredAgnostic을, 전체 응답을 쓰는 지표(사실성 · 자사 인용률)는
 * withoutProbes를 쓴다. 하나라도 빠지면 화면 숫자가 카드와 어긋난다.
 *
 * 서버(server/mentionScope · aggregate)도 '../src/lib/questionScope.js'로 읽는다 — 런타임 import를 두지 않는다.
 * 구조 타입만 받아 서버(src/prompts/types)와 화면(src/lib/types) 두 QuestionSpec을 모두 받는다.
 */
import type { QuestionCategory } from '../prompts/types.js'

/** 술어가 보는 문항 속성만. */
export interface ScopedQuestion {
  questionId: string
  category: QuestionCategory
  probe?: boolean
}

/** 실증 질문인가. 문항을 모르면(은행에 없음) 실증이 아니다. */
export function isProbe(q: { probe?: boolean } | null | undefined): boolean {
  return q?.probe === true
}

/** 점수에 세는 이름 없는 질문인가 — 카테고리 무관이고 실증이 아니다. */
export function isScoredAgnostic(q: { category: QuestionCategory; probe?: boolean }): boolean {
  return q.category === 'category-agnostic' && !isProbe(q)
}

/** 은행의 실증 질문 id. */
export function probeIdsOf(questions: { questionId: string; probe?: boolean }[]): Set<string> {
  return new Set(questions.filter(isProbe).map((q) => q.questionId))
}

/**
 * 실증 질문의 응답을 뺀다. 은행에 없는 questionId의 응답은 남긴다 — 실증인지 알 수 없고, 지금까지 그렇게 세어 왔다.
 * 새 배열을 돌려준다(원소는 그대로).
 */
export function withoutProbes<T extends { questionId: string }>(
  analyses: T[],
  questions: { questionId: string; probe?: boolean }[],
): T[] {
  const probes = probeIdsOf(questions)
  return analyses.filter((a) => !probes.has(a.questionId))
}
