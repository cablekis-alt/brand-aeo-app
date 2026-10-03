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
  const a = [...(prev.enginesUsed ?? [])].sort().join(',')
  const b = [...(cur.enginesUsed ?? [])].sort().join(',')
  if (a && b && a !== b) return '수집 엔진'
  if (prev.judgeEngine && cur.judgeEngine && prev.judgeEngine !== cur.judgeEngine) return '판정 엔진'
  const pm = prev.modelsUsed
  const cm = cur.modelsUsed
  if (pm && cm) {
    for (const e of new Set([...Object.keys(pm), ...Object.keys(cm)])) {
      if (pm[e] && cm[e] && pm[e] !== cm[e]) return '모델'
    }
  }
  if (prev.judgeModel && cur.judgeModel && prev.judgeModel !== cur.judgeModel) return '모델'
  if (prev.questionBankVersion && cur.questionBankVersion && prev.questionBankVersion !== cur.questionBankVersion) {
    return '질문지'
  }
  if (prev.repeatsPerQuestion && cur.repeatsPerQuestion && prev.repeatsPerQuestion !== cur.repeatsPerQuestion) {
    return '반복 횟수'
  }
  return null
}
