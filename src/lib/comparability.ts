import type { WeeklyScorecard } from '../prompts/b8-report'

/** 두 주차의 측정 조건 중 처음 걸린 차이. 같으면 null. */
export type ConditionChange = '수집 엔진' | '판정 엔진' | '모델' | '질문지' | '반복 횟수'

/**
 * 두 주차를 점수 증감으로 바로 비교해도 되는가 — 대시보드의 전주 대비 칩과 5주 추이의 「조건 변경」
 * 표식이 같은 규칙을 써야 한다. 칩은 +3인데 막대에는 조건 변경 표식이 붙으면 화면이 자기모순이다.
 *
 * **양쪽에 기록이 있을 때만** 다르다고 본다. 기록이 없는 옛 주차(그 필드가 생기기 전 측정)를 비교
 * 불가로 몰면 쌓아 온 증감이 전부 사라진다 — 모르는 것을 다르다고 단정하지 않는다.
 * 수집 엔진·판정 엔진 규칙은 alerts.ts(sameEngines·sameJudge)와 같다. 질문지·반복 횟수는 정기진단
 * 보고서의 측정 조건 점검과 같은 항목이다.
 */
export function conditionChange(prev: WeeklyScorecard, cur: WeeklyScorecard): ConditionChange | null {
  return conditionChanges(prev, cur)[0] ?? null
}

/** 달라진 측정 조건 전부(위와 같은 순서) — 보고서 추이 그래프처럼 「무엇이 바뀌었나」를 다 적어야 할 때. */
export function conditionChanges(prev: WeeklyScorecard, cur: WeeklyScorecard): ConditionChange[] {
  const out: ConditionChange[] = []
  const a = [...(prev.enginesUsed ?? [])].sort().join(',')
  const b = [...(cur.enginesUsed ?? [])].sort().join(',')
  if (a && b && a !== b) out.push('수집 엔진')
  if (prev.judgeEngine && cur.judgeEngine && prev.judgeEngine !== cur.judgeEngine) out.push('판정 엔진')
  const pm = prev.modelsUsed
  const cm = cur.modelsUsed
  const modelChanged =
    (pm && cm && [...new Set([...Object.keys(pm), ...Object.keys(cm)])].some((e) => pm[e] && cm[e] && pm[e] !== cm[e])) ||
    Boolean(prev.judgeModel && cur.judgeModel && prev.judgeModel !== cur.judgeModel)
  if (modelChanged) out.push('모델')
  if (prev.questionBankVersion && cur.questionBankVersion && prev.questionBankVersion !== cur.questionBankVersion) {
    out.push('질문지')
  }
  if (prev.repeatsPerQuestion && cur.repeatsPerQuestion && prev.repeatsPerQuestion !== cur.repeatsPerQuestion) {
    out.push('반복 횟수')
  }
  return out
}
