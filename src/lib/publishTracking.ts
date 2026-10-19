import type { HistoryCell, HistoryWeek } from './api'

/**
 * 올린 글 하나의 판단 — 올린 뒤 측정에서 얼마나 인용됐나(언급률 2번 P3).
 *
 * 단일 측정은 흔들린다(같은 설정 2회 측정에서도 인용 구성이 바뀐다 — 실측: 인용된 주소의 81.6%가 한 주에만 나왔다). 그래서 한 번
 * 인용된 것은 「판단 보류」로 두고, 올린 뒤 측정 2회 이상에서 인용됐을 때만 「반복 인용」이라 부른다. 올리기 전 · 측정 중(전후 불명) ·
 * 내린 뒤 · 판정 기록이 없는 주는 세지 않는다. 질의만 다른 주소의 인용과 답변에 우리 이름이 나왔는지는 보조 숫자다.
 *
 * 올린 뒤 측정이 없을 때는 기다리면 풀리는지로 나눈다 — 올린 날을 모르는 옛 기록(날짜를 적어야 판단)과, 판단할 수 있는 측정 없이
 * 내린 글(다시 측정될 수 없다)은 「측정 대기」가 아니다. 내리기 전 측정이 판정 기록 없음 · 전후 불명이었을 수 있어 「측정 전에
 * 내렸다」고 단정하지 않는다.
 */
export type PostTier = 'waiting' | 'undated' | 'removed' | 'none' | 'once' | 'repeated'

export const TIER_LABEL: Record<PostTier, string> = {
  waiting: '측정 대기',
  undated: '올린 날 모름 · 날짜를 적으면 판단',
  removed: '내림 · 올린 뒤 판단할 측정 없음',
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
  /**
   * 올린 뒤 첫 측정과 마지막 측정 사이에 측정 조건(엔진 · 판정 · 모델 · 질문지 · 반복 횟수)이 바뀌었다 — 판정 기록이 없는 사이 주에서
   * 바뀐 것도 센다. 보정하지 않고 알리기만 한다.
   */
  conditionMixed: boolean
  /** 올리기 전 측정에서 이미 인용됐다 — 올린 날이 틀렸을 수 있다. 같은 주소를 앞서 올렸다 내린 기록이 올라가 있던 주는 빼고 본다. */
  citedBeforePublish: boolean
}

const cited = (c: HistoryCell) => (c.tally?.all.cited ?? 0) > 0

/** cells와 weeks는 같은 순서다(서버 server/publishedHistory.ts). */
export function summarizePost(cells: (HistoryCell | null)[], weeks: Pick<HistoryWeek, 'changes'>[]): PostSummary {
  const after: { cell: HistoryCell; week: number }[] = []
  cells.forEach((cell, week) => {
    if (cell && !cell.afterRemoval && cell.timing === 'after') after.push({ cell, week })
  })
  const seen = cells.filter((c): c is HistoryCell => c !== null)
  const citedWeeks = after.filter((a) => cited(a.cell)).length
  const tier: PostTier =
    after.length > 0
      ? citedWeeks === 0
        ? 'none'
        : citedWeeks === 1
          ? 'once'
          : 'repeated'
      : // 올린 날을 모르면 내렸어도 「올린 날 모름」 — 날짜를 알아야 판단할 수 있다.
        seen.length > 0 && seen.every((c) => c.timing === 'unknown')
        ? 'undated'
        : seen.some((c) => c.afterRemoval)
          ? 'removed'
          : 'waiting'
  const unknownSplit = after.some((a) => a.cell.tally && a.cell.tally.unnamed === null)
  const first = after[0]
  const last = after.at(-1)
  return {
    tier,
    measuredAfter: after.length,
    citedWeeks,
    unnamedCited: unknownSplit ? null : after.reduce((sum, a) => sum + (a.cell.tally?.unnamed?.cited ?? 0), 0),
    supporting: after.reduce((sum, a) => sum + (a.cell.tally?.all.supporting ?? 0), 0),
    variantCited: after.reduce((sum, a) => sum + a.cell.variantCited, 0),
    lapsed: citedWeeks > 0 && Boolean(last) && !cited(last!.cell),
    conditionMixed:
      first !== undefined && last !== undefined && weeks.slice(first.week + 1, last.week + 1).some((w) => (w?.changes.length ?? 0) > 0),
    // 같은 주소를 앞서 올렸다 내린 기록이 올라가 있던 주의 인용은 그 글의 것이다 — 다시 올린 기록의 날짜를 의심하지 않는다.
    citedBeforePublish: cells.some((c) => c && !c.afterRemoval && !c.earlierPostingLive && c.timing === 'before' && cited(c)),
  }
}
