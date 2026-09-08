import type { WeeklyScorecard } from '../prompts/b8-report'

// 경쟁 시계열 집계 — 우리 브랜드와 코호트 경쟁사의 주간 AEO Score를 같은 주차 축에 정렬해
// 추이 라인·리더 대비 격차를 만든다. 새 수집 없이 각 브랜드의 스코어카드 히스토리만 사용한다.
export interface TrendEntry {
  tenantId: string
  brandName: string
  self: boolean
  history: WeeklyScorecard[]
}

export interface TrendPoint {
  weekOf: string
  score: number | null
}

export interface TrendSeries {
  tenantId: string
  brandName: string
  self: boolean
  points: TrendPoint[]
  latest: number | null
}

export interface GapRow {
  tenantId: string
  brandName: string
  self: boolean
  latest: number | null
  gapToLeader: number | null // 리더 대비 점수차(0=리더). null=미측정
}

export interface CompetitorTrend {
  weeks: string[]
  series: TrendSeries[] // 최근 점수 높은 순, 우리 브랜드 우선
  gapToLeader: GapRow[]
  leaderName: string | null
  maxScore: number
}

export function buildCompetitorTrend(entries: TrendEntry[]): CompetitorTrend {
  // 모든 브랜드의 주차를 합쳐 공통 축을 만든다(측정이 빠진 주는 null).
  const weekSet = new Set<string>()
  for (const e of entries) for (const c of e.history) weekSet.add(c.weekOf)
  const weeks = [...weekSet].sort((a, b) => a.localeCompare(b))

  const series: TrendSeries[] = entries.map((e) => {
    const byWeek = new Map(e.history.map((c) => [c.weekOf, c.aeoScore.current]))
    const points = weeks.map((w) => ({ weekOf: w, score: byWeek.get(w) ?? null }))
    const latest = [...points].reverse().find((p) => p.score !== null)?.score ?? null
    return { tenantId: e.tenantId, brandName: e.brandName, self: e.self, points, latest }
  })

  // 최근 점수 순 정렬(우리 브랜드는 동점 시 우선).
  series.sort((a, b) => (b.latest ?? -1) - (a.latest ?? -1) || (a.self ? -1 : 0) - (b.self ? -1 : 0))

  const leader = series.find((s) => s.latest !== null) ?? null
  const leaderScore = leader?.latest ?? null
  const gapToLeader: GapRow[] = series.map((s) => ({
    tenantId: s.tenantId,
    brandName: s.brandName,
    self: s.self,
    latest: s.latest,
    gapToLeader: s.latest !== null && leaderScore !== null ? leaderScore - s.latest : null,
  }))

  const maxScore = Math.max(100, ...series.flatMap((s) => s.points.map((p) => p.score ?? 0)))

  return { weeks, series, gapToLeader, leaderName: leader?.brandName ?? null, maxScore }
}
