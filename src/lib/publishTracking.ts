import type { HistoryCell, HistoryWeek, PublishedHistory, PublishedPost } from './api'
import { ENGINE_LABEL } from './format'
import { editTimingOf, isoWeekOf, kstDate, timingOf, type PostTiming } from './publishedUrl'

/**
 * 올린 글 하나의 판단 — 올린 뒤 측정에서 얼마나 인용됐나(언급률 2번 P3).
 *
 * 단일 측정은 흔들린다(같은 설정 2회 측정에서도 인용 구성이 바뀐다 — 실측: 인용된 주소의 81.6%가 한 주에만 나왔다). 그래서 한 번
 * 인용된 것은 「판단 보류」로 두고, 올린 뒤 서로 다른 2주 이상에서 인용됐을 때만 「여러 주 인용」이라 부른다. 한 주에 여러 번 잰
 * 회차는 한 주로 센다(한 회차라도 인용하면 그 주는 인용, server/publishedHistory.ts) — 같은 주 회차는 색인 상태를 공유해 독립 근거가
 * 아니다. 다만 자주 잴수록 한 주가 「인용」으로 잡힐 기회가 늘어, 주 3회 재는 브랜드가 「여러 주 인용」에 더 빨리 닿는다 — 판단 옆에
 * 회차 수를 함께 적는다. 올리기 전 · 측정 중(전후 불명) · 내린 뒤 · 판정 기록이 없는 주는 세지 않는다. 질의만 다른 주소의 인용과 답변에 우리 이름이 나왔는지는 보조 숫자다.
 *
 * 올린 뒤 측정이 없을 때는 기다리면 풀리는지로 나눈다 — 올린 날을 모르는 옛 기록(날짜를 적어야 판단)과, 판단할 수 있는 측정 없이
 * 내린 글(다시 측정될 수 없다)은 「측정 대기」가 아니다. 내리기 전 측정이 판정 기록 없음 · 전후 불명이었을 수 있어 「측정 전에
 * 내렸다」고 단정하지 않는다.
 */
export type PostTier = 'waiting' | 'undated' | 'removed' | 'indexing' | 'none' | 'once' | 'repeated'

/**
 * 갓 올린 글은 색인 · 인용까지 시간이 걸린다 — 새 글이 처음 인용되기까지 11 · 13일 걸린 실측이 있다(2026-10 측정 기록). 올린 지 이
 * 일수 안의 측정만 있고 인용이 없으면 「인용 없음」이 아니라 「색인 대기」다(부정 판단만 미룬다 — 그 안의 인용은 그대로 센다).
 * 실제로 색인됐는지 확인한 것은 아니고 올린 뒤 지난 날로 붙이는 상태다. 주 1회 측정이면 두 주다.
 */
export const INDEXING_GRACE_DAYS = 14

export const TIER_LABEL: Record<PostTier, string> = {
  waiting: '측정 대기',
  undated: '올린 날 모름 · 날짜를 적으면 판단',
  removed: '내림 · 올린 뒤 판단할 측정 없음',
  indexing: `색인 대기 · 올린 지 ${INDEXING_GRACE_DAYS}일 안 측정만`,
  none: '인용 없음',
  once: '한 주 인용 · 판단 보류',
  repeated: '여러 주 인용',
}

export interface PostSummary {
  tier: PostTier
  /** 올린 뒤에 한 측정 수(판정 기록이 있고, 전후가 분명한 주). */
  measuredAfter: number
  /** 그중 정확 일치 인용이 있던 주 수. */
  citedWeeks: number
  /** 올린 뒤 회차 수 · 그중 인용된 회차 수 — 회차 기록이 없는 주는 1회로 센다. */
  measuredRuns: number
  citedRuns: number
  /** 처음 인용된 회차가 올린 지 며칠 뒤였나. 인용이 없거나 일수를 모르면 null. */
  firstCitedDays: number | null
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

/** 올린 지 INDEXING_GRACE_DAYS일이 안 된 측정인지 — 일수가 없으면(옛 서버) 지난 것으로 본다. 판단 · 표 칸 · 이번 주 알약이 같이 쓴다. */
export const withinIndexingGrace = (days: number | null | undefined): boolean => days !== null && days !== undefined && days < INDEXING_GRACE_DAYS

/** 갓 올린 글의 「인용 없음」 칸에 붙이는 꼬리 — 그 칸은 판단에 넣지 않는다(성과 표 · 정기진단 보고서 집행 표가 같은 문구를 쓴다). */
export function freshNoCiteNote(c: HistoryCell): string | null {
  return !c.tally && c.timing === 'after' && withinIndexingGrace(c.daysAfterPublish) ? `올린 지 ${c.daysAfterPublish}일 · 아직 판단 전` : null
}

/**
 * cells와 weeks는 같은 순서다(서버 server/publishedHistory.ts). removedOn은 「글을 내렸어요」로 내린 날(한국 날짜) — 내린 뒤 측정 칸이
 * 아직 없어도(다음 측정 전 · 지난 주차 보고서) 기다려서 풀리는 상태(색인 대기 · 측정 대기)로 보이지 않게 한다. 보고서는 그 주차까지로
 * 자른 날을 넘긴다(그 뒤에 내린 일은 그 주 보고서에 넣지 않는다).
 */
export function summarizePost(cells: (HistoryCell | null)[], weeks: Pick<HistoryWeek, 'changes'>[], removedOn: string | null = null): PostSummary {
  const after: { cell: HistoryCell; week: number }[] = []
  cells.forEach((cell, week) => {
    if (cell && !cell.afterRemoval && cell.timing === 'after') after.push({ cell, week })
  })
  const seen = cells.filter((c): c is HistoryCell => c !== null)
  const citedWeeks = after.filter((a) => cited(a.cell)).length
  // 내렸으면 기다려도 풀리지 않는다.
  const down = removedOn !== null || seen.some((c) => c.afterRemoval)
  // 올린 지 INDEXING_GRACE_DAYS일이 지난 측정이 하나라도 있어야 「인용 없음」이다.
  const matured = after.some((a) => !withinIndexingGrace(a.cell.daysAfterPublish))
  const tier: PostTier =
    after.length > 0
      ? citedWeeks === 0
        ? matured
          ? 'none'
          : down
            ? 'removed'
            : 'indexing'
        : citedWeeks === 1
          ? 'once'
          : 'repeated'
      : // 올린 날을 모르면 내렸어도 「올린 날 모름」 — 날짜를 알아야 판단할 수 있다.
        seen.length > 0 && seen.every((c) => c.timing === 'unknown')
        ? 'undated'
        : down
          ? 'removed'
          : 'waiting'
  const unknownSplit = after.some((a) => a.cell.tally && a.cell.tally.unnamed === null)
  const first = after[0]
  const last = after.at(-1)
  return {
    tier,
    measuredAfter: after.length,
    citedWeeks,
    measuredRuns: after.reduce((n, a) => n + (a.cell.runs?.measured ?? 1), 0),
    citedRuns: after.reduce((n, a) => n + (a.cell.runs?.cited ?? (cited(a.cell) ? 1 : 0)), 0),
    firstCitedDays: firstCitedDaysOf(after.map((a) => a.cell)),
    unnamedCited: unknownSplit ? null : after.reduce((sum, a) => sum + (a.cell.tally?.unnamed?.cited ?? 0), 0),
    supporting: after.reduce((sum, a) => sum + (a.cell.tally?.all.supporting ?? 0), 0),
    variantCited: after.reduce((sum, a) => sum + a.cell.variantCited, 0),
    lapsed: citedWeeks > 0 && Boolean(last) && !cited(last!.cell),
    conditionMixed:
      first !== undefined && last !== undefined && weeks.slice(first.week + 1, last.week + 1).some((w) => (w?.changes.length ?? 0) > 0),
    // 같은 주소를 앞서 올렸다 내린 기록이 올라가 있던 주의 인용은 그 글의 것이다 — 다시 올린 기록의 날짜를 의심하지 않는다.
    citedBeforePublish:
      cells.some((c) => c && !c.afterRemoval && !c.earlierPostingLive && c.timing === 'before' && cited(c)) ||
      cells.some((c) => (c?.citedBeforeRuns ?? 0) > 0),
  }
}

function firstCitedDaysOf(after: HistoryCell[]): number | null {
  const first = after.find(cited)
  if (!first) return null
  return first.runs?.citedDays[0] ?? first.daysAfterPublish ?? null
}

/**
 * 회차가 여럿인 주의 칸 문구 — 「3회 중 1회 · 그 주 인용 D+12」 · 「3회 · 인용 없음」. 「첫 인용」이라는 말은 글 전체의 첫 인용(판단
 * 칸 · 회차 보기)에만 쓰고, 칸에는 그 주 인용된 회차의 일수를 적는다. 올린 뒤 회차가 없는 칸(전후 불명 · 올리기 전)은 null —
 * 그 칸은 회차가 하나일 때와 같은 문구를 쓴다. 성과 표 · 정기진단 보고서 집행 표가 같이 쓴다.
 */
export function runTallyText(c: HistoryCell): { main: string; sub: string[] } | null {
  const r = c.runs
  if (!r || r.measured === 0 || c.timing !== 'after' || c.afterRemoval) return null
  const sub: string[] = []
  if (c.tally) {
    sub.push(
      c.tally.unnamed && c.tally.named
        ? `응답 합 이름 없는 ${c.tally.unnamed.cited} · 이름 댄 ${c.tally.named.cited}`
        : `응답 합 인용 ${c.tally.all.cited} · 질문 유형 확인 불가`,
    )
  }
  if (r.weak > 0) sub.push(`엔진 빠진 회차 ${r.weak}${r.weakEngines.length ? `(${r.weakEngines.map(engineName).join(' · ')})` : ''}`)
  if (r.unsure > 0) sub.push(`전후 불명 ${r.unsure}회`)
  if (r.cited === 0) {
    const fresh = freshNoCiteNote(c)
    if (fresh) sub.push(fresh)
    return { main: `${r.measured}회 · 인용 없음`, sub }
  }
  const days = r.citedDays.length > 0 ? ` · 그 주 인용 D+${r.citedDays.join('·')}` : ''
  return { main: `${r.measured}회 중 ${r.cited}회${days}`, sub }
}

export const engineName = (e: string) => ENGINE_LABEL[e] ?? e

/** 기록이 어느 줄에 올린 것인지 — 범례 · 표에서 글 옆에 붙인다. */
export function postChannelLabel(p: Pick<PublishedPost, 'targetActionId' | 'via'>): string {
  if (p.targetActionId === 'listing:__news__') return '언론'
  if (p.via === 'direct') return '직접 적음'
  if (p.via === 'own') return '자사 블로그 · 사이트'
  // 채널 줄 · 덮는 글 없는 채널(orphan) 줄 — 채널 이름.
  return p.targetActionId.replace(/^listing:(platform:)?/, '').replace(/^content:/, '')
}

/** "2026-10-19" → "10/19". */
export const monthDay = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`

/**
 * 기록이 속한 주 — 올린 날의 주, 올린 날을 모르면 기록한 날의 주. 지난 주차 보고서가 그 뒤의 기록을 넣지 않게 하는 한 가지 시계다.
 *
 * 옛 기록(v0.4.3 전 집행 상태에 적은 주소, publishedOnSource 'legacy')은 ''(늘 앞) — 그 recordedAt은 집행 상태를 고칠 때마다 지금으로
 * 바뀌는 updatedAt이라, 자르면 오래전 집행이 상태를 한 번 고친 뒤 보고서에서 사라진다. 그 주소는 모두 v0.4.3 전에 적었다.
 */
export function postWeekOf(p: Pick<PublishedPost, 'publishedOn' | 'recordedAt' | 'publishedOnSource'>): string {
  if (p.publishedOn) return isoWeekOf(p.publishedOn) ?? ''
  if (p.publishedOnSource === 'legacy') return ''
  return isoWeekOf(kstDate(p.recordedAt) ?? '') ?? ''
}

/** 한 번 올린 글 — 같은 주소를 여러 줄(자사 블로그 줄 + 그 블로그의 채널 줄)에 적은 기록을 하나로 묶은 것. */
export interface Posting<T> {
  item: T
  post: PublishedPost
  /** 그 주소를 적은 줄들의 이름. */
  places: string[]
}

/**
 * 편수는 원장 줄이 아니라 올린 글로 센다 — 같은 주소 · 같은 올린 날인 줄은 한 편이다(올렸다 내리고 다시 올린 주소는 날이 달라 따로).
 * 같은 주소에 날짜가 있는 줄이 있으면 날짜 없는 옛 줄은 뺀다. 「잘못 적은 주소」는 뺀다.
 *
 * 대표 줄: 「글을 내렸어요」는 줄마다 따로 적으므로, 한 줄이라도 내렸으면 그 주소는 내려간 것이다 — 가장 먼저 내린 줄을 대표로 둔다
 * (내린 날 · 내린 뒤 칸이 판단에 들어간다). 다만 내린 뒤에 같은 주소를 다시 적은 줄이 있으면 다시 올린 것으로 보고 그 줄을 둔다.
 */
export function distinctPostings<T>(items: T[], postOf: (t: T) => PublishedPost): Posting<T>[] {
  const live = items.filter((t) => postOf(t).removedReason !== 'mistake')
  const dated = new Set(live.filter((t) => postOf(t).publishedOn).map((t) => postOf(t).key))
  const groups = new Map<string, T[]>()
  for (const t of live) {
    const p = postOf(t)
    if (!p.publishedOn && dated.has(p.key)) continue
    const k = `${p.key}|${p.publishedOn ?? ''}`
    groups.set(k, [...(groups.get(k) ?? []), t])
  }
  return [...groups.values()].map((group) => {
    const down = group
      .filter((t) => postOf(t).removedReason === 'taken-down' && postOf(t).removedAt)
      .sort((a, b) => postOf(a).removedAt!.localeCompare(postOf(b).removedAt!))[0]
    const reposted = down && group.find((t) => !postOf(t).removedAt && postOf(t).recordedAt > postOf(down).removedAt!)
    const item = reposted ?? down ?? group.find((t) => !postOf(t).removedAt) ?? group[0]!
    return { item, post: postOf(item), places: [...new Set(group.map((t) => postChannelLabel(postOf(t))))] }
  })
}

/**
 * 그 주 측정에 견준 올린 날. 회차가 여럿이면 칸(server/publishedHistory.ts foldCell)과 같은 규칙 — 회차마다 전후를 보고, 올린 뒤
 * 회차가 하나라도 있으면 after, 없으면 측정하던(during) · 시각 없는 같은 주(ambiguous) · 올리기 전(before) 순이다.
 */
export function weekTimingOf(publishedOn: string, w: Pick<HistoryWeek, 'weekOf' | 'window' | 'runs'>): PostTiming {
  if (!w.runs?.length) return timingOf(publishedOn, w.window, w.weekOf)
  const each = w.runs.map((r) => timingOf(publishedOn, r.window, w.weekOf))
  return (['after', 'during', 'ambiguous', 'before'] as const).find((t) => each.includes(t)) ?? 'unknown'
}

/** 고친 글의 그 주 칸 — 그 주 측정이 마지막으로 고친 날에 견줘 어땠나(회차가 여럿이면 올린 날과 같은 weekTimingOf 규칙). */
export function weekEditOf(
  post: Pick<PublishedPost, 'edits'>,
  w: Pick<HistoryWeek, 'weekOf' | 'window' | 'runs'>,
): { editedOn: string; timing: PostTiming } | null {
  return editTimingOf(post.edits, (on) => weekTimingOf(on, w))
}

const dayDiff = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

/** 마지막으로 고친 뒤의 판단 — 고친 글을 본 측정만 센다. 같은 주에 고치기 전 회차가 섞였으면 그 회차의 인용은 넣지 않는다. */
export interface EditSummary {
  /** 마지막으로 고친 날. */
  editedOn: string
  /** 고친 뒤 회차가 있는 주 수(올린 뒤 · 내리기 전 칸만). */
  measuredWeeks: number
  /** 그중 고친 뒤 회차에서 인용된 주 수. */
  citedWeeks: number
  /** 고친 날에서 며칠 뒤 처음 인용이 확인됐나. 인용이 없거나 일수를 모르면 null. */
  firstCitedDays: number | null
}

/**
 * 고친 글이면 마지막으로 고친 뒤의 결과(cells와 weeks는 같은 순서). 회차 칸의 인용 일수(citedDays)는 올린 날 기준이라, 고친 날까지의
 * 일수보다 큰 것만 고친 뒤 회차다 — 날짜 단위라 고친 날 당일 회차는 전후 불명으로 넣지 않는다(올린 날과 같은 규칙).
 */
export function summarizeSinceEdit(
  post: Pick<PublishedPost, 'edits' | 'publishedOn'>,
  cells: (HistoryCell | null)[],
  weeks: Pick<HistoryWeek, 'weekOf' | 'window' | 'runs'>[],
): EditSummary | null {
  const last = post.edits?.at(-1)?.editedOn
  if (!last || !post.publishedOn) return null
  const offset = dayDiff(post.publishedOn, last)
  let measuredWeeks = 0
  let citedWeeks = 0
  let firstCitedDays: number | null = null
  cells.forEach((c, i) => {
    const w = weeks[i]
    if (!c || !w || c.afterRemoval || c.timing !== 'after' || weekTimingOf(last, w) !== 'after') return
    measuredWeeks += 1
    const days = c.runs?.citedDays.length ? c.runs.citedDays : cited(c) && c.daysAfterPublish !== undefined ? [c.daysAfterPublish] : []
    const afterEdit = days.filter((d) => d > offset)
    // 일수를 모르는 인용(측정 시각 없는 옛 주)은 그 주가 통째로 고친 뒤라 인용으로 센다 — 일수만 비운다.
    const citedAfter = afterEdit.length > 0 || (days.length === 0 && cited(c))
    if (!citedAfter) return
    // 첫 인용 주의 일수를 모르면 「첫 인용 D+N」은 비운다 — 뒤 주의 일수를 첫 인용처럼 적지 않는다.
    if (citedWeeks === 0 && afterEdit.length > 0) firstCitedDays = Math.min(...afterEdit) - offset
    citedWeeks += 1
  })
  return { editedOn: last, measuredWeeks, citedWeeks, firstCitedDays }
}

/**
 * 그 주 칸(회차 합침)에서 올린 뒤 인용된 기록 id — 정기진단 보고서의 개선제안 · 실행 항목의 올린 주소 알약이 마지막 저장 측정에는
 * 없고 같은 주 다른 회차에서만 인용된 글을 밝히는 데 쓴다. 그 주가 이력에 없으면 null.
 */
export function citedPostIdsInWeek(history: Pick<PublishedHistory, 'weeks' | 'posts'>, weekOf: string): Set<string> | null {
  const w = history.weeks.findIndex((x) => x.weekOf === weekOf)
  if (w < 0) return null
  return new Set(
    history.posts
      .filter((p) => {
        const c = p.cells[w]
        return Boolean(c && !c.afterRemoval && c.timing !== 'before' && (c.tally?.all.cited ?? 0) > 0)
      })
      .map((p) => p.post.id),
  )
}

/** 그래프 칸 — 측정한 주인지(빈칸이면 미측정). */
export interface ExecutionSlot {
  weekOf: string
  measured: boolean
}

/** 그래프 위 집행 핀 하나. 같은 자리에 든 글은 한 핀으로 합친다. */
export interface ExecutionPin {
  /** 칸 번호로 잰 위치 — 정수면 그 칸 위, .5면 두 칸 사이 틈. */
  x: number
  /** 측정하던 때 올려 그 측정의 전후를 모른다 — 속 빈 핀. */
  hollow: boolean
  posts: Posting<PublishedPost>[]
  /** 범례 번호(1부터, 왼쪽부터). */
  n: number
}

export interface ExecutionMarks {
  pins: ExecutionPin[]
  /** 그래프 첫 칸보다 앞서 올린 글 수 — 핀 없이 범례에 수만 적는다. */
  outOfRange: number
  /** 올린 날을 모르는 옛 기록 수 — 둘 자리가 없다. */
  undated: number
}

/**
 * 집행 핀 자리(언급률 2번 P4). 측정 시각이 있는 측정 가운데 올린 날이 그 측정 기간 안이면 그 칸 위 속 빈 핀(전후 불명)이다 — 측정
 * 주차 이름과 측정한 날의 주가 어긋나도(일요일 밤 측정 · CI 시간대) 서버 칸(timingOf)과 같은 말을 한다. 그 밖에는 올린 날이 든 주가
 * 측정됐으면 측정 전에 올린 글은 그 칸 왼쪽 틈, 측정 뒤에 올린 글은 오른쪽 틈 — 핀 오른쪽 막대 · 점이 「올린 뒤 측정」이다. 시각 없는
 * 같은 주는 칸 위 속 빈 핀, 측정하지 않은 주는 칸 위. 칸 목록에 없는 주(측정한 주만 늘어놓은 막대)는 그다음 칸 왼쪽 틈이다.
 * 같은 주에 여러 번 잰 주는 칸(server/publishedHistory.ts foldCell)과 같은 규칙으로 정한다 — 올린 뒤 회차가 하나라도 있으면 올린
 * 뒤, 없고 측정하던 회차가 있으면 전후 불명(weekTimingOf).
 *
 * 첫 칸보다 앞서 올린 글은 수만 센다. 다만 prev(첫 칸 바로 앞 측정)를 주면 그 측정 뒤에 올린 글은 첫 칸 왼쪽 틈에 둔다 — 「직전
 * 측정과 이 측정 사이」를 세는 표의 첫 행이 비지 않게.
 *
 * 같은 주소를 여러 줄에 적은 기록은 한 편으로 센다(distinctPostings). 「글을 내렸어요」는 둔다(올렸던 일이다). endWeek 뒤의 기록은
 * 버린다 — 지난 주차 보고서에 그 뒤의 집행을 그리지 않는다(올린 날을 모르면 기록한 날로 자른다). 주소 없이 「집행함」만 누른 항목은
 * 믿을 날짜가 없어 핀을 두지 않는다(여기에 오지 않는다).
 */
export function executionMarks(
  posts: PublishedPost[],
  slots: ExecutionSlot[],
  weeks: Pick<HistoryWeek, 'weekOf' | 'window' | 'runs'>[],
  endWeek?: string,
  prev?: Pick<HistoryWeek, 'weekOf' | 'window' | 'runs'> | null,
): ExecutionMarks {
  const weekOfSlot = new Map(weeks.map((w) => [w.weekOf, w]))
  // 측정하던 때 올렸나 — 측정 시각이 있는 측정만(시각 없는 옛 기록은 같은 주여도 아래에서 칸 위 속 빈 핀).
  const during = (d: string, w: Pick<HistoryWeek, 'weekOf' | 'window' | 'runs'> | undefined) =>
    Boolean(w && (w.window || w.runs?.length) && weekTimingOf(d, w) === 'during')
  const byX = new Map<number, { hollow: boolean; posts: Posting<PublishedPost>[] }>()
  let outOfRange = 0
  let undated = 0
  // 보고 주차로 먼저 자르고 묶는다 — 보고서 표와 같은 순서(그 뒤에 적은 같은 주소 줄이 옛 줄을 지우지 않게).
  for (const posting of distinctPostings(endWeek ? posts.filter((p) => postWeekOf(p) <= endWeek) : posts, (p) => p)) {
    const { post } = posting
    const pd = post.publishedOn
    const week = pd ? isoWeekOf(pd) : null
    if (!pd || !week) {
      undated += 1
      continue
    }
    if (slots.length === 0) continue
    let x: number
    let hollow = false
    const duringSlot = slots.findIndex((s) => s.measured && during(pd, weekOfSlot.get(s.weekOf)))
    if (duringSlot >= 0) {
      x = duringSlot
      hollow = true
    } else if (week < slots[0]!.weekOf) {
      // 첫 칸 앞 — 바로 앞 측정 뒤에 올렸으면 첫 칸 왼쪽 틈, 아니면(그 측정 전 · 전후 불명) 범위 밖.
      if (!prev || weekTimingOf(pd, prev) !== 'before') {
        outOfRange += 1
        continue
      }
      x = -0.5
    } else {
      const i = slots.findIndex((s) => s.weekOf === week)
      if (i >= 0 && slots[i]!.measured) {
        const timing = weekTimingOf(pd, weekOfSlot.get(week) ?? { weekOf: week, window: null })
        if (timing === 'after') x = i - 0.5
        else if (timing === 'before') x = i + 0.5
        else {
          x = i
          hollow = true
        }
      } else if (i >= 0) {
        x = i
      } else {
        const next = slots.findIndex((s) => s.weekOf > week)
        x = next >= 0 ? next - 0.5 : slots.length - 0.5
      }
    }
    const at = byX.get(x) ?? { hollow, posts: [] }
    at.posts.push(posting)
    byX.set(x, at)
  }
  const pins = [...byX.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([x, v], k) => ({
      x,
      hollow: v.hollow,
      posts: [...v.posts].sort((a, b) => (a.post.publishedOn ?? '').localeCompare(b.post.publishedOn ?? '')),
      n: k + 1,
    }))
  return { pins, outOfRange, undated }
}

/**
 * 글 한 편의 범례 — 「10/19 자사 블로그 · 사이트 · tistory.com 「제목」 · 10/22 내림」. 내린 날은 until(그래프 끝 주) 안일 때만 적는다
 * — 지난 주차 보고서에 그 뒤의 일을 적지 않는다.
 */
export function postingLegend(posting: Posting<unknown>, until?: string): string {
  const { post } = posting
  const off = post.removedAt ? kstDate(post.removedAt) : null
  const removed = off && (!until || (isoWeekOf(off) ?? '') <= until) ? ` · ${monthDay(off)} 내림` : ''
  return `${post.publishedOn ? monthDay(post.publishedOn) : ''} ${posting.places.join(' · ')} 「${post.articleTitle ?? post.articleId}」${removed}`
}

/** 핀의 범례 한 줄 — 첫 글 + 「외 n편」. */
export function pinLegend(pin: ExecutionPin, until?: string): string {
  const rest = pin.posts.length - 1
  return `${postingLegend(pin.posts[0]!, until)}${rest > 0 ? ` 외 ${rest}편` : ''}`
}

/**
 * 측정 행마다 그 측정 직전에 올린 편수 — 직전 측정과 이 측정 사이(핀이 이 칸 왼쪽 틈)에 올린 글. 측정하던 주에 올린 글(속 빈 핀)은
 * unsure로 따로 센다. 마지막 측정 뒤에 올린 글은 어느 행에도 들지 않는다.
 */
export function executionsPerSlot(marks: ExecutionMarks, slots: ExecutionSlot[]): Map<string, { count: number; unsure: number }> {
  const out = new Map<string, { count: number; unsure: number }>()
  for (const pin of marks.pins) {
    const slot = slots[Math.ceil(pin.x)]
    if (!slot) continue
    const row = out.get(slot.weekOf) ?? { count: 0, unsure: 0 }
    if (pin.hollow) row.unsure += pin.posts.length
    else row.count += pin.posts.length
    out.set(slot.weekOf, row)
  }
  return out
}

const SUMMARY_ORDER: [PostTier, string][] = [
  ['repeated', '여러 주 인용'],
  ['once', '한 주 인용(판단 보류)'],
  ['none', '인용 없음'],
  ['indexing', `색인 대기(올린 지 ${INDEXING_GRACE_DAYS}일 안)`],
  ['waiting', '측정 대기'],
  ['undated', '올린 날 모름'],
  ['removed', '판단할 측정 없이 내림'],
]

/**
 * 보고서 한 문장 — 「W42까지 기록한 집행 글 3편: 반복 인용 1편 · 인용 없음 2편.」 0인 판단은 뺀다. 「덕분에」 같은 인과 표현은 쓰지
 * 않는다 — 인용은 측정 조건 · 다른 글에도 달려 있다. 기록이 없으면 null(「집행 0편」이라고 단정하지 않는다 — 적지 않았을 뿐일 수 있다).
 */
export function executionSummaryLine(summaries: Pick<PostSummary, 'tier'>[], untilLabel: string): string | null {
  if (summaries.length === 0) return null
  const parts = SUMMARY_ORDER.map(([tier, label]) => [label, summaries.filter((s) => s.tier === tier).length] as const)
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${label} ${n}편`)
  return `${untilLabel}까지 기록한 집행 글 ${summaries.length}편: ${parts.join(' · ')}.`
}

/**
 * 올린 뒤 측정 주 — 판정 기록이 없는 주(확인 불가)와 측정하던 주(전후 불명)도 넣는다. 판정이 있는 주는 칸의 전후 판정을 따르고(측정 주차
 * 이름과 측정한 날의 주가 어긋나도 맞다), 판정이 없는 주는 올린 주부터 넣는다. 내린 주 뒤는 넣지 않는다(판정 기록이 없는 주도).
 */
export function afterWeeksOf(
  cells: (HistoryCell | null)[],
  weeks: Pick<HistoryWeek, 'weekOf'>[],
  publishedOn: string | null,
  removedOn: string | null = null,
): { weekOf: string; cell: HistoryCell | null }[] {
  const publishedWeek = publishedOn ? isoWeekOf(publishedOn) : null
  if (!publishedWeek) return []
  const removedWeek = removedOn ? isoWeekOf(removedOn) : null
  const out: { weekOf: string; cell: HistoryCell | null }[] = []
  cells.forEach((cell, i) => {
    const weekOf = weeks[i]?.weekOf
    if (!weekOf) return
    if (removedWeek && weekOf > removedWeek) return
    if (cell) {
      if (cell.afterRemoval || cell.timing === 'before' || cell.timing === 'unknown') return
      out.push({ weekOf, cell })
    } else if (weekOf >= publishedWeek) {
      out.push({ weekOf, cell: null })
    }
  })
  return out
}
