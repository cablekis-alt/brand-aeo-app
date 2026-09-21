import type { EngineRate, UsageRow } from './api'

/**
 * 사용량 한 줄의 비용. **모르면 null을 돌려준다 — 0이 아니다.**
 *
 * 0으로 만들면 "돈이 안 들었다"가 되어 뜻이 완전히 달라진다. 계산할 수 없는 경우가 셋인데
 * 화면이 각각 다르게 말해야 한다:
 *
 *   noRate    단가 미설정 — 사람이 넣으면 된다
 *   noSplit   입력·출력 기록이 없는 옛 주차 — 다시 측정해야 생긴다
 *   ok        계산됨
 *
 * 입출력 분리가 없으면 합계로 대충 계산하지 않는다. 출력 단가가 입력의 4~5배라, 비중을
 * 모르는 채 한쪽 단가를 곱하면 몇 배 틀린 금액이 나온다(실측 W38: ChatGPT는 출력이 7%,
 * Perplexity는 84%). 틀린 금액을 보여 주느니 "계산 불가"가 정직하다.
 */
export type CostReason = 'ok' | 'noRate' | 'noSplit'

export interface CostResult {
  reason: CostReason
  /** reason이 'ok'일 때만 숫자다. */
  amount: number | null
  /** 요청당 요금이 차지한 몫. 토큰만 보면 싸 보이는 엔진을 드러낸다. */
  requestPart: number | null
}

export function rowCost(row: UsageRow, rate: EngineRate | undefined): CostResult {
  const hasTokenRate = rate?.inputPerM !== undefined || rate?.outputPerM !== undefined
  const hasRequestRate = rate?.perRequest !== undefined
  if (!rate || (!hasTokenRate && !hasRequestRate)) return { reason: 'noRate', amount: null, requestPart: null }

  const requestPart = (rate.perRequest ?? 0) * row.calls

  // 토큰 단가가 있는데 분리 기록이 없으면 계산하지 않는다.
  if (hasTokenRate && row.inputTokens === 0 && row.outputTokens === 0 && row.tokens > 0) {
    return { reason: 'noSplit', amount: null, requestPart: null }
  }
  const tokenPart =
    ((rate.inputPerM ?? 0) * row.inputTokens + (rate.outputPerM ?? 0) * row.outputTokens) / 1_000_000
  return { reason: 'ok', amount: tokenPart + requestPart, requestPart }
}

/** 표시용 반올림. 소수 둘째 자리까지 — 그보다 잘게 보여 주면 정밀한 값처럼 읽힌다. */
export function formatMoney(amount: number, currency: string): string {
  const v = amount >= 100 ? Math.round(amount).toLocaleString() : (Math.round(amount * 100) / 100).toLocaleString()
  return `${v} ${currency}`
}
