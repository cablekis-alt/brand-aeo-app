import type { HistoryCell, HistoryWeek } from './api'

/**
 * 올린 글 하나의 판단 — 올린 뒤 측정에서 얼마나 인용됐나(언급률 2번 P3).
 *
 * 단일 측정은 흔들린다(같은 설정 2회 측정에서도 인용 구성이 바뀐다 — 실측: 인용된 주소의 81.6%가 한 주에만 나왔다). 그래서 한 번
 * 인용된 것은 「판단 보류」로 두고, 올린 뒤 측정 2회 이상에서 인용됐을 때만 「반복 인용」이라 부른다. 올리기 전 · 측정 중(전후 불명) ·
 * 내린 뒤 · 판정 기록이 없는 주는 세지 않는다. 질의만 다른 주소의 인용과 답변에 우리 이름이 나왔는지는 보조 숫자다.
 */
export type PostTier = 'waiting' | 'none' | 'once' | 'repeated'

export const TIER_LABEL: Record<PostTier, string> = {
  waiting: '측정 대기',
  none: '인용 없음',
  once: '한 번 인용 · 판단 보류',
  repeated: '반복 인용',
}

export interface PostSummary {
  tier: PostTier
  /** 올린 뒤에 한 측정 수(판정 기록이 있고, 전후가 분명한 주). */
  measuredAfter: number
  /** 그중 정확 일치 인용이 있던 주 수. */
  citedWeeks: number
  /** 올린 뒤 측정의 이름 없는 질문 인용 합. 그 사이 한 주라도 질문 은행을 못 읽었으면 null(확인 불가). */
  unnamedCited: number | null
  /** 올린 뒤 측정에서 그 인용이 우리를 뒷받침한 응답 합. */
  supporting: number
  /** 올린 뒤 측정에서 질의만 다른 주소를 인용한 응답 합 — 숫자에 넣지 않는다. */
  variantCited: number
  /** 인용된 적이 있는데 가장 최근 측정에서는 없었다. */
  lapsed: boolean
  /** 올린 뒤 측정 사이에 측정 조건(엔진 · 판정 · 질문지)이 바뀌었다 — 보정하지 않고 알리기만 한다. */
  conditionMixed: boolean
  /** 올리기 전 측정에서 이미 인용됐다 — 올린 날이 틀렸을 수 있다. */
  citedBeforePublish: boolean
}

const cited = (c: HistoryCell) => (c.tally?.all.cited ?? 0) > 0

/** cells와 weeks는 같은 순서다(서버 server/publishedHistory.ts). */
export function summarizePost(cells: (HistoryCell | null)[], weeks: Pick<HistoryWeek, 'changes'>[]): PostSummary {
  const after: { cell: HistoryCell; week: number }[] = []
  cells.forEach((cell, week) => {
    if (cell && !cell.afterRemoval && cell.timing === 'after') after.push({ cell, week })
  })
  const citedWeeks = after.filter((a) => cited(a.cell)).length
  const tier: PostTier = after.length === 0 ? 'waiting' : citedWeeks === 0 ? 'none' : citedWeeks === 1 ? 'once' : 'repeated'
  const unknownSplit = after.some((a) => a.cell.tally && a.cell.tally.unnamed === null)
  const last = after.at(-1)
  return {
    tier,
    measuredAfter: after.length,
    citedWeeks,
    unnamedCited: unknownSplit ? null : after.reduce((sum, a) => sum + (a.cell.tally?.unnamed?.cited ?? 0), 0),
    supporting: after.reduce((sum, a) => sum + (a.cell.tally?.all.supporting ?? 0), 0),
    variantCited: after.reduce((sum, a) => sum + a.cell.variantCited, 0),
    lapsed: citedWeeks > 0 && Boolean(last) && !cited(last!.cell),
    conditionMixed: after.slice(1).some((a) => (weeks[a.week]?.changes.length ?? 0) > 0),
    citedBeforePublish: cells.some((c) => c && !c.afterRemoval && c.timing === 'before' && cited(c)),
  }
}
