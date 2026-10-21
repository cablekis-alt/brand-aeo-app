/**
 * 측정 진행 표시의 남은 시간 어림(src/lib/measureEstimate.ts)을 확인한다. API는 부르지 않는다.
 *
 * 왜: 엔진마다 속도가 몇 배 달라(2026-W43 6곳 측정: OpenAI 2분 · Gemini 3분 · Perplexity 14분) 합친 건수로 어림하면 빠른 엔진이
 * 끝낸 건수에 끌려, 실제로 6~13분 남았을 때 화면은 약 1분 30초였다. 엔진마다 어림해 가장 늦은 엔진을 써야 한다.
 *
 *   npx tsx scripts/verify-measure-estimate.ts
 */
import { overallRemainingMs, type ProgressRow } from '../src/lib/measureEstimate'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])
const near = (a: number | null, b: number) => a !== null && Math.abs(a - b) < 1

// 경과 240초, 2곳 — OpenAI · Gemini는 끝났고 Perplexity만 40/84.
const row = (pDone: number): ProgressRow => ({
  stage: '수집',
  done: 42 + 42 + pDone,
  total: 126,
  engines: { openai: { done: 42, total: 42 }, gemini: { done: 42, total: 42 }, perplexity: { done: pDone, total: 42 } },
})
const rows = [row(20), row(20)]
// Perplexity 남은 44건 × (240초 ÷ 40건) = 264초, 분석 몫 15%를 더해 303.6초.
ok('엔진별: 가장 늦은 엔진(Perplexity)으로 어림', near(overallRemainingMs(rows, 240_000), 264_000 * 1.15))
const merged = rows.map(({ engines: _e, ...r }) => r)
// 옛 어림(합친 건수): 44건 × (240초 ÷ 208건) × 1.15 ≈ 58초 — 엔진별이 아니면 몇 배 짧다.
ok('엔진 건수가 없는 옛 서버: 합친 어림으로', near(overallRemainingMs(merged, 240_000), 44 * (240_000 / 208) * 1.15))
ok('남은 엔진의 표본이 적으면(20건 미만) 숫자를 내지 않는다', overallRemainingMs([row(15)], 240_000) === null)
ok('처음 1분은 엔진별 숫자를 내지 않는다(첫 응답 지연이 들어가 크게 나온다)', overallRemainingMs(rows, 45_000) === null)
ok('처음 15초는 숫자를 내지 않는다', overallRemainingMs(rows, 10_000) === null)
ok('단계를 아직 못 받은 줄이 있으면 숫자를 내지 않는다', overallRemainingMs([...rows, {}], 240_000) === null)
// 한 곳은 이미 분석 중(엔진 건수 없음), 한 곳은 수집 중 — 수집 중인 줄로 엔진별 어림.
ok('분석 중인 줄이 섞여도 수집 중인 줄로 엔진별 어림', near(overallRemainingMs([{ stage: '분석', done: 30, total: 126 }, row(20)], 240_000), 22 * (240_000 / 20) * 1.15))

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
