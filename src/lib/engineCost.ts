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
export type CostReason = 'ok' | 'billed' | 'noRate' | 'noSplit'

export interface CostResult {
  reason: CostReason
  /** reason이 'ok'일 때만 숫자다. */
  amount: number | null
  /** 검색 요금이 차지한 몫. 토큰만 보면 싸 보이는 엔진을 드러낸다. */
  requestPart: number | null
  /** 검색한 호출 수와 그중 월 무료 한도로 빠진 수. 검색 요금을 계산하지 않았으면 0. */
  searches: number
  freeSearches: number
}

/**
 * 이 줄의 검색 중 월 무료 한도 안에 든 수. 한도는 달마다 새로 차므로, 달별로 그 달에 앞서 쓴
 * 검색(priorInMonth)을 빼고 남은 한도만큼만 무료로 친다.
 */
function freeSearchesOf(row: UsageRow, freePerMonth: number): number {
  if (freePerMonth <= 0) return 0
  return row.searchByMonth.reduce(
    (sum, m) => sum + Math.min(m.searches, Math.max(0, freePerMonth - m.priorInMonth)),
    0,
  )
}

export function rowCost(row: UsageRow, rate: EngineRate | undefined): CostResult {
  /*
   * 엔진이 실제 청구액을 알려 줬으면 그걸 쓴다 — 단가를 곱한 추정보다 정확하고, 과금 구조가
   * 바뀌어도 따라갈 필요가 없다. Perplexity Agent API가 그렇다.
   * 단가 설정보다 **앞서** 본다. 사람이 넣은 단가가 낡았어도 청구액은 틀리지 않는다.
   */
  if (typeof row.billedCost === 'number') {
    return { reason: 'billed', amount: row.billedCost, requestPart: null, searches: 0, freeSearches: 0 }
  }
  const hasTokenRate = rate?.inputPerM !== undefined || rate?.outputPerM !== undefined
  const hasRequestRate = rate?.perRequest !== undefined
  if (!rate || (!hasTokenRate && !hasRequestRate)) {
    return { reason: 'noRate', amount: null, requestPart: null, searches: 0, freeSearches: 0 }
  }

  // 검색 요금은 검색한 호출에만, 그달 무료 한도를 넘은 몫에만 붙는다. 판정 줄은 검색이 0이라 0이다.
  const searches = hasRequestRate ? row.searchCalls : 0
  const freeSearches = hasRequestRate ? freeSearchesOf(row, rate.freeRequestsPerMonth ?? 0) : 0
  const requestPart = (rate.perRequest ?? 0) * (searches - freeSearches)

  // 토큰 단가가 있는데 분리 기록이 없으면 계산하지 않는다.
  if (hasTokenRate && row.inputTokens === 0 && row.outputTokens === 0 && row.tokens > 0) {
    return { reason: 'noSplit', amount: null, requestPart: null, searches, freeSearches }
  }
  const tokenPart =
    ((rate.inputPerM ?? 0) * row.inputTokens + (rate.outputPerM ?? 0) * row.outputTokens) / 1_000_000
  return { reason: 'ok', amount: tokenPart + requestPart, requestPart, searches, freeSearches }
}

/** 표시용 반올림. 소수 둘째 자리까지 — 그보다 잘게 보여 주면 정밀한 값처럼 읽힌다. */
export function formatMoney(amount: number, currency: string): string {
  const v = amount >= 100 ? Math.round(amount).toLocaleString() : (Math.round(amount * 100) / 100).toLocaleString()
  return `${v} ${currency}`
}

/**
 * 여러 줄(한 주차의 수집 또는 판정)의 비용 합. 계산하지 못한 줄이 하나라도 있으면 complete가
 * false다 — 화면이 그 합을 "일부"로 밝혀야 한다. 빠진 줄을 0으로 치면 합이 실제보다 작아진다.
 */
export function sumCost(
  rows: UsageRow[],
  engines: Record<string, EngineRate> | undefined,
): { amount: number; complete: boolean } {
  let amount = 0
  let complete = true
  for (const row of rows) {
    const c = rowCost(row, engines?.[row.engine])
    if (c.amount === null) complete = false
    else amount += c.amount
  }
  return { amount, complete }
}
