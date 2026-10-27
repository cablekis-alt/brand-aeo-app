/**
 * 경쟁 시계열 선 색 규칙을 확인한다 — 「우리」 선은 늘 강조색, 경쟁사는 계열색을 차례로. AI는 부르지 않는다.
 *
 * 왜: 선 색을 점수 순서(series 위치)로 나눠, 우리보다 점수가 높은 경쟁사가 있으면 1등 경쟁사가 강조색을 받고
 * 「우리」는 주황 같은 계열색을 받았다(실측 2026-W44 스테이,머뭄: 1등 스테이 골목집이 코발트, 우리는 주황).
 *
 *   npx tsx scripts/verify-competitor-trends.ts
 */
import type { WeeklyScorecard } from '../src/prompts/b8-report'
import { buildCompetitorTrend, seriesColors, type TrendEntry } from '../src/lib/competitorTrends'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

const card = (weekOf: string, current: number) => ({ weekOf, aeoScore: { current } }) as unknown as WeeklyScorecard
const entry = (tenantId: string, self: boolean, scores: number[]): TrendEntry => ({
  tenantId,
  brandName: tenantId,
  self,
  history: scores.map((s, i) => card(`2026-W${40 + i}`, s)),
})
const ACCENT = 'var(--accent)'
const COMPETITOR = ['var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--series-6)']

// 우리가 3등 — 점수 순 정렬에서 셋째 자리에 온다.
const trend = buildCompetitorTrend([entry('self', true, [3, 12]), entry('leader', false, [17, 17]), entry('second', false, [10, 16]), entry('fourth', false, [0, 0])])
const colors = seriesColors(trend.series)
const selfIdx = trend.series.findIndex((s) => s.self)
ok('전제: 우리가 맨 앞이 아니다(점수 순 정렬)', selfIdx === 2)
ok('색 수 = 선 수', colors.length === trend.series.length)
ok('우리 선은 강조색', colors[selfIdx] === ACCENT)
ok('경쟁사는 강조색을 받지 않는다', trend.series.every((s, i) => s.self || colors[i] !== ACCENT))
ok(
  '경쟁사는 정렬 순서대로 2번 · 3번 · 4번 계열색',
  JSON.stringify(trend.series.filter((s) => !s.self).map((s) => colors[trend.series.indexOf(s)])) === JSON.stringify(COMPETITOR.slice(0, 3)),
)

// 우리가 1등이어도 같다 — 경쟁사 첫째가 2번 계열색.
const top = buildCompetitorTrend([entry('self', true, [30]), entry('a', false, [20]), entry('b', false, [10])])
const topColors = seriesColors(top.series)
ok('우리가 1등: 우리 = 강조색', topColors[0] === ACCENT && top.series[0].self)
ok('우리가 1등: 경쟁사 = 2번 · 3번', topColors[1] === COMPETITOR[0] && topColors[2] === COMPETITOR[1])

// 경쟁사가 계열색 다섯보다 많으면 다시 2번부터 — 강조색으로 넘어가지 않는다.
const many = buildCompetitorTrend([
  entry('self', true, [1]),
  ...Array.from({ length: 7 }, (_, i) => entry(`c${i}`, false, [50 - i])),
])
const manyColors = seriesColors(many.series)
const manyCompetitors = many.series.map((s, i) => (s.self ? null : manyColors[i])).filter((c): c is string => c !== null)
ok('경쟁사 7곳: 강조색 없음', manyCompetitors.every((c) => c !== ACCENT))
ok('경쟁사 7곳: 여섯째는 다시 2번 계열색', manyCompetitors[5] === COMPETITOR[0] && manyCompetitors[6] === COMPETITOR[1])
ok('경쟁사 7곳: 우리 = 강조색', manyColors[many.series.findIndex((s) => s.self)] === ACCENT)

let failed = 0
for (const [label, pass] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${label}`)
  if (!pass) failed += 1
}
if (failed > 0) {
  console.error(`\n${failed}건 실패`)
  process.exit(1)
}
console.log(`\n모두 통과 (${checks.length}건)`)
