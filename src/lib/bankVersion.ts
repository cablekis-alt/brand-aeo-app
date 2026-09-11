import type { QuestionRepeatAnalysis, WeeklyScorecard } from './types'

/**
 * 이 주차를 측정한 질문 은행 버전을 정한다.
 *
 * 왜 필요한가. 질문 은행을 버전 없이 불러오면 서버가 테넌트의 **현재** 버전을 준다.
 * 그러면 옛 주차를 볼 때 질문 id가 맞지 않아 질문 텍스트·카테고리가 조용히 빈 값이 되고,
 * 화면에는 질문 대신 `v1-001` 같은 id가 뜨고 카테고리가 하나로 뭉친다.
 *
 * 두 단계로 정한다.
 *   1) 스코어카드의 questionBankVersion — v0.1.49부터 기록한다.
 *   2) 없으면 **질문 id의 접두에서 읽는다**. id가 `v1-001` 꼴이라 접두가 곧 버전이다.
 *      추측이 아니라 데이터가 스스로 밝힌 값이다.
 *
 * 둘 다 없으면 undefined를 돌려 호출부가 버전 없이(=현재 은행) 요청하게 둔다.
 */
export function resolveBankVersion(
  history: WeeklyScorecard[],
  weekOf: string,
  analyses: QuestionRepeatAnalysis[],
): string | undefined {
  const recorded = history.find((card) => card.weekOf === weekOf)?.questionBankVersion
  if (recorded) return recorded

  const prefixes = new Set<string>()
  for (const a of analyses) {
    const match = /^(v\d+)-/.exec(a.questionId ?? '')
    if (match) prefixes.add(match[1])
  }
  // 한 주차는 은행 하나로 측정된다. 접두가 여러 개면 무엇이 맞는지 알 수 없으니
  // 현재 은행으로 폴백한다(잘못된 하나를 고르는 것보다 낫다).
  return prefixes.size === 1 ? [...prefixes][0] : undefined
}
