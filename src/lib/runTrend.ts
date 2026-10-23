import type { RunHistory, RunPoint, RunPostRow } from './api'
import { kstDate, timingOf } from './publishedUrl'
import { distinctPostings, INDEXING_GRACE_DAYS, type Posting } from './publishTracking'
import { isoWeekThursday } from '../prompts/isoWeek'

/**
 * 측정 회차별 보기의 그림 모델(src/components/RunTrendPanel.tsx) — 그리기와 나눠 시험할 수 있게 둔다.
 *
 * x는 한국 날짜 칸이다. 같은 날 m번 잰 회차는 그 칸 안 (j+0.5)/m 자리에 시간순으로 놓는다. 선은 같은 조건으로 잰 이웃 회차끼리만
 * 잇는다 — 조건이 바뀐 곳, 엔진이 빠졌거나 일부만 들어온 회차, 옛 기록(회차 기록 전 그 주 파일 · 옮겨 둔 회차), 질문 은행을 못 찾은
 * 회차에서 끊는다.
 */

/** ISO 시각 → 한국 시각 「10/28 14:05」. */
export function kstStamp(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const d = new Date(t + 9 * 3600_000)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${hh}:${mm}`
}

/** 0.046 → 「4.6%」. */
export const pct = (x: number) => `${Math.round(x * 1000) / 10}%`

/** "2026-10-28" → "10/28". */
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`

const DAY = 86_400_000
const dayNum = (d: string) => Date.parse(`${d}T00:00:00Z`) / DAY

/** 회차가 측정된 한국 날짜 — 시각이 없으면 그 주 판정 창의 첫날, 그것도 없으면 그 주 월요일. */
function pointDay(p: RunPoint): string | null {
  if (p.at) return kstDate(p.at)
  if (p.window) return p.window.first
  const thu = isoWeekThursday(p.weekOf)
  return thu ? new Date(thu.getTime() - 3 * DAY).toISOString().slice(0, 10) : null
}

/** 회차의 글 표시 — 인용됨 · 인용 없음 · 색인 대기(14일 안) · 전후 불명 · 엔진 빠짐(근거 약함) · 그리지 않음 · 판정 없음. */
export type RunMark = 'cited' | 'none' | 'grace' | 'unsure' | 'weak' | 'skip' | 'unknown'

export interface RunDot {
  /** points의 자리. */
  i: number
  x: number
  /** 엔진이 빠졌거나 일부만 들어온 회차 — 잇지 않는다. */
  isolated: boolean
  /** 회차 기록 전 그 주 파일 · 옮겨 둔 회차 — 측정 방식 · 예정 호출 수를 몰라 잇지 않는다. */
  legacy: boolean
  /** 질문 은행을 못 찾아 순위 응답을 셀 수 없다. */
  unknown: boolean
}

export interface RunPin {
  n: number
  date: string
  x: number
  graceEndX: number
  postings: Posting<RunPostRow>[]
}

/**
 * 마지막으로 고친 뒤의 회차 — 고친 날과 같은 규칙(timingOf)으로 고친 날 뒤에 잰 회차만 센다. 고친 날 당일 회차는 전후 불명이라 넣지
 * 않는다. 엔진이 빠진 회차 · 전후 불명 회차는 세지 않는다.
 */
export interface RunSinceEdit {
  editedOn: string
  measured: number
  cited: number
  /** 고친 날에서 며칠 뒤 회차에서 처음 인용됐나. */
  firstCitedDays: number | null
}

export interface RunTrendModel {
  days: string[]
  dots: RunDot[]
  /** 이어 그릴 점 묶음(points 자리). */
  segments: number[][]
  breaks: { x: number; text: string }[]
  pins: RunPin[]
  /**
   * 글별 줄 — 핀 번호, 줄 이름(같은 날 올린 글은 「1a · 1b」), 회차마다의 표시(points와 같은 순서). 고친 글이면 고친 날(그림 안에
   * 들면 x)과 마지막으로 고친 뒤의 회차 결과.
   */
  rows: {
    posting: Posting<RunPostRow>
    pin: number | null
    label: string
    marks: RunMark[]
    edits: { date: string; x: number | null }[]
    sinceEdit: RunSinceEdit | null
  }[]
  /**
   * 주마다 회차 점수 — 같은 조건 회차끼리만 평균, 그 주 카드 점수(막대)와 나란히. 평균에서 뺀 회차는 까닭별로 센다(옛 기록 · 엔진이
   * 빠진 회차 · 질문 은행을 못 찾은 회차).
   */
  scoreLine: { weekOf: string; scores: number[]; mean: number | null; mixed: boolean; bar: number | null; legacy: number; isolated: number; unknown: number }[]
  /** 이 브랜드가 같은 날 여러 번 잰 날 가운데 가장 크게 흔들린 날 — 안내 문구에 쓴다. 없으면 null. */
  sameDay: { date: string; scores: number[] } | null
}

export function buildRunTrend(h: RunHistory): RunTrendModel {
  const points = h.points
  const days0 = points.map(pointDay).filter((d): d is string => Boolean(d)).sort()
  const postings = distinctPostings(h.posts, (r) => r.post)
  const firstDay = days0[0] ?? null
  const lastDay = days0.at(-1) ?? null
  // 올린 날이 첫 회차보다 일주일 안쪽 앞이면 그날부터 그린다(핀이 그림 안에 서게).
  const pubDates = postings.map((p) => p.post.publishedOn).filter((d): d is string => Boolean(d))
  const startDay =
    firstDay === null
      ? null
      : (pubDates.filter((d) => d < firstDay && dayNum(firstDay) - dayNum(d) <= 7).sort()[0] ?? firstDay)
  const days: string[] = []
  if (startDay && lastDay) for (let n = dayNum(startDay); n <= dayNum(lastDay); n += 1) days.push(new Date(n * DAY).toISOString().slice(0, 10))
  const dayIndex = new Map(days.map((d, i) => [d, i]))

  // 같은 날 회차를 시간순으로 칸 안에 나눈다.
  const byDay = new Map<string, number[]>()
  points.forEach((p, i) => {
    const d = pointDay(p)
    if (!d) return
    byDay.set(d, [...(byDay.get(d) ?? []), i])
  })
  const xOf = new Map<number, number>()
  for (const [d, idx] of byDay) {
    const sorted = [...idx].sort((a, b) => (points[a]!.at ?? '').localeCompare(points[b]!.at ?? ''))
    sorted.forEach((i, j) => xOf.set(i, (dayIndex.get(d) ?? 0) + (j + 0.5) / sorted.length))
  }

  const dots: RunDot[] = points.map((p, i) => ({
    i,
    x: xOf.get(i) ?? 0,
    isolated: p.partialEngines.length > 0 || p.missingEngines.length > 0,
    legacy: p.kind === 'week-file' || Boolean(p.preserved),
    unknown: p.ranked === null,
  }))
  const linkable = (d: RunDot) => !d.isolated && !d.legacy && !d.unknown
  const segments: number[][] = []
  let run: number[] = []
  dots.forEach((d, i) => {
    // 이을 수 없는 점, 바로 앞 점이 이을 수 없었던 자리, 조건이 바뀐 자리에서 끊는다.
    const joins = linkable(d) && run.at(-1) === i - 1 && points[i]!.changesFromPrev.length === 0
    if (!joins && run.length) {
      segments.push(run)
      run = []
    }
    if (linkable(d)) run.push(i)
  })
  if (run.length) segments.push(run)

  const breaks = points.flatMap((p, i) => (p.changesFromPrev.length > 0 && i > 0 ? [{ x: (dots[i - 1]!.x + dots[i]!.x) / 2, text: p.changesFromPrev.join(' · ') }] : []))

  // 핀 — 올린 날마다 하나(같은 날 올린 글은 한 핀).
  const pinDates = [...new Set(pubDates.filter((d) => dayIndex.has(d)))].sort()
  const pins: RunPin[] = pinDates.map((date, k) => ({
    n: k + 1,
    date,
    x: dayIndex.get(date)!,
    graceEndX: Math.min(days.length, dayIndex.get(date)! + INDEXING_GRACE_DAYS),
    postings: postings.filter((p) => p.post.publishedOn === date),
  }))
  const pinOf = (p: Posting<RunPostRow>) => pins.find((pin) => pin.date === p.post.publishedOn)?.n ?? null

  // 같은 핀에 든 글이 여럿이면 「1a · 1b」로 가른다 — 그림 줄 · 회차 표 열 · 위 목록이 같은 이름을 쓴다.
  const rows = postings.map((posting) => {
    const pin = pinOf(posting)
    const siblings = pin === null ? [] : postings.filter((p) => pinOf(p) === pin)
    const label = pin === null ? '?' : siblings.length > 1 ? `${pin}${String.fromCharCode(97 + siblings.indexOf(posting))}` : String(pin)
    return { posting, pin, label }
  }).map(({ posting, pin, label }) => {
    const marks = posting.item.cells.map((c, k): RunMark => {
      if (!c) return 'unknown'
      if (c.afterRemoval || c.timing === 'before' || c.timing === 'unknown') return 'skip'
      if (c.timing === 'during' || c.timing === 'ambiguous') return 'unsure'
      if (c.cited > 0) return 'cited'
      if (dots[k]?.isolated) return 'weak'
      return c.withinGrace ? 'grace' : 'none'
    })
    const editDates = (posting.post.edits ?? []).map((e) => e.editedOn)
    const lastEdit = editDates.at(-1)
    let sinceEdit: RunSinceEdit | null = null
    if (lastEdit) {
      sinceEdit = { editedOn: lastEdit, measured: 0, cited: 0, firstCitedDays: null }
      points.forEach((p, k) => {
        const day = pointDay(p)
        const window = p.window ?? (day ? { first: day, last: day } : null)
        if (timingOf(lastEdit, window, p.weekOf) !== 'after') return
        const mark = marks[k]
        if (mark !== 'cited' && mark !== 'none' && mark !== 'grace') return
        sinceEdit!.measured += 1
        if (mark !== 'cited') return
        sinceEdit!.cited += 1
        const d = day ? dayNum(day) - dayNum(lastEdit) : null
        if (d !== null && (sinceEdit!.firstCitedDays === null || d < sinceEdit!.firstCitedDays)) sinceEdit!.firstCitedDays = d
      })
    }
    return {
      posting,
      pin,
      label,
      marks,
      edits: editDates.map((date) => ({ date, x: dayIndex.has(date) ? dayIndex.get(date)! : null })),
      sinceEdit,
    }
  })

  const weeks = [...new Set(points.map((p) => p.weekOf))]
  const scoreLine = weeks.map((weekOf) => {
    const inWeek = points.map((p, i) => ({ p, d: dots[i]! })).filter(({ p }) => p.weekOf === weekOf)
    const usable = inWeek.filter(({ p, d }) => p.score !== null && !d.legacy && !d.isolated)
    const scores = usable.map(({ p }) => p.score!)
    const mixed = new Set(usable.map(({ p }) => p.conditionKey)).size > 1
    const mean = scores.length > 0 && !mixed ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null
    return {
      weekOf,
      scores,
      mean,
      mixed,
      bar: h.weekCardScores[weekOf] ?? null,
      legacy: inWeek.filter(({ d }) => d.legacy).length,
      isolated: inWeek.filter(({ d }) => !d.legacy && d.isolated).length,
      unknown: inWeek.filter(({ p, d }) => !d.legacy && !d.isolated && p.score === null).length,
    }
  })

  // 같은 날 흔들림 — 같은 조건으로 끝까지 잰 회차끼리만(엔진이 빠진 차이를 잡음으로 설명하지 않게).
  let sameDay: RunTrendModel['sameDay'] = null
  for (const [date, idx] of byDay) {
    const usable = idx.filter((i) => points[i]!.score !== null && !dots[i]!.legacy && !dots[i]!.isolated)
    const byKey = new Map<string, number[]>()
    for (const i of usable) byKey.set(points[i]!.conditionKey, [...(byKey.get(points[i]!.conditionKey) ?? []), i])
    for (const group of byKey.values()) {
      const scores = [...group].sort((a, b) => (points[a]!.at ?? '').localeCompare(points[b]!.at ?? '')).map((i) => points[i]!.score!)
      if (scores.length < 2) continue
      const spread = Math.max(...scores) - Math.min(...scores)
      if (!sameDay || spread > Math.max(...sameDay.scores) - Math.min(...sameDay.scores)) sameDay = { date, scores }
    }
  }

  return { days, dots, segments, breaks, pins, rows, scoreLine, sameDay }
}

/** 날짜 칸 이름 「10/28」. */
export const dayLabel = md
