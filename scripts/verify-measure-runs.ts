/**
 * 측정 완료 기록을 측정 1회로 묶는 규칙(src/lib/measureRuns.ts)과, 서버가 그 근거(회차 id · 함께 잰 고객)를 적는지 확인한다.
 * 가짜 엔진(USE_MOCK_ENGINES)과 임시 APP_DATA_DIR로 고객 1 + 경쟁사 1을 재 본다 — 실제 AI는 부르지 않는다.
 *
 * 왜: 완료 기록은 브랜드마다 한 줄이라 고객 하나를 경쟁사 5곳과 재면 「최근 완료」가 6줄이 되어 경쟁사 줄이 고객 측정을 덮었다.
 * 옛 줄을 잘못 묶으면 다른 고객의 경쟁사가 엉뚱한 측정에 붙고, 걸린 시간 안내가 틀린다.
 *
 *   npx tsx scripts/verify-measure-runs.ts
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { durationText, groupMeasureRuns, lastRunDurationSec, recentRunDurations, type LocalRun } from '../src/lib/measureRuns'

const dir = mkdtempSync(path.join(tmpdir(), 'verify-measure-runs-'))
process.env.APP_DATA_DIR = dir
process.env.BLOB_READ_WRITE_TOKEN = ''
process.env.BLOB_STORE_ID = ''
process.env.USE_MOCK_ENGINES = 'true'
delete process.env.MOCK_REPORT_DELAY_MS

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

const t0 = Date.parse('2026-10-26T01:00:00.000Z')
const row = (tenantId: string, endSec: number, durationSec: number, extra: Partial<LocalRun> = {}): LocalRun => ({
  tenantId,
  brandName: `가짜 ${tenantId}`,
  weekOf: '2026-W44',
  aeoScore: 10,
  at: new Date(t0 + endSec * 1000).toISOString(),
  durationSec,
  ...extra,
})
const competitors = new Set(['k1', 'k2', 'k3'])
const isCompetitor = (id: string) => competitors.has(id)

// ── 1) 회차 id로 묶기 ─────────────────────────────────────────────
const byRun = groupMeasureRuns(
  [
    row('c1', 300, 280, { runId: 'r1' }),
    row('k1', 250, 240, { runId: 'r1', parentTenantId: 'c1' }),
    row('k2', 400, 395, { runId: 'r1', parentTenantId: 'c1' }),
  ],
  isCompetitor,
)
ok('회차 id가 같으면 측정 1회 — 고객이 머리, 경쟁사 둘', byRun.length === 1 && byRun[0]!.root.tenantId === 'c1' && byRun[0]!.children.map((c) => c.tenantId).join() === 'k1,k2')
ok('걸린 시간 = 마지막 완료 − 처음 시작', byRun[0]!.durationSec === 400 - 5 && byRun[0]!.kind === 'customer')
const orphan = groupMeasureRuns([row('k1', 100, 90, { runId: 'r2', parentTenantId: 'c9' })], isCompetitor)
ok('고객 줄이 없는 회차(고객 측정 실패) — 경쟁사 줄을 따로', orphan.length === 1 && orphan[0]!.kind === 'legacy' && orphan[0]!.children.length === 0)
const compOnly = groupMeasureRuns([row('k3', 100, 90, { runId: 'r3' })], isCompetitor)
ok('경쟁사 하나만 잰 회차 → competitorOnly', compOnly[0]?.kind === 'competitorOnly')

// ── 2) 옛 줄(회차 id 없음) — 시작 시각 30초 안 · 고객 하나일 때만 ──────
const legacy = groupMeasureRuns([row('c1', 200, 190), row('k1', 150, 135), row('k2', 260, 240)], isCompetitor)
ok('옛 줄: 시작 30초 안 · 고객 하나 → 묶음', legacy.length === 1 && legacy[0]!.children.length === 2)
const twoCustomers = groupMeasureRuns([row('c1', 200, 190), row('c2', 205, 190), row('k1', 150, 140)], isCompetitor)
ok(
  '옛 줄: 고객 둘이 섞이면 묶지 않는다(경쟁사는 어느 측정인지 모름)',
  twoCustomers.length === 3 && twoCustomers.every((g) => g.children.length === 0) && twoCustomers.find((g) => g.root.tenantId === 'k1')?.kind === 'legacy',
)
const far = groupMeasureRuns([row('c1', 200, 190), row('k1', 900, 100)], isCompetitor)
ok('옛 줄: 시작이 30초 넘게 떨어지면 따로', far.length === 2 && far.find((g) => g.root.tenantId === 'k1')?.kind === 'competitorOnly')
const mixed = groupMeasureRuns([row('c1', 100, 50, { runId: 'r1' }), row('c2', 500, 60)], isCompetitor)
ok('최근 끝난 것부터', mixed.map((g) => g.root.tenantId).join() === 'c2,c1')

// ── 3) 걸린 시간 어림 ────────────────────────────────────────────
const groups3 = groupMeasureRuns(
  [row('c1', 1000, 174, { runId: 'a' }), row('c2', 3000, 399, { runId: 'b' }), row('k1', 5000, 30, { runId: 'z' }), row('c1', 7000, 205, { runId: 'c' })],
  isCompetitor,
)
ok('최근 측정 범위(경쟁사만 잰 회차는 빼고)', JSON.stringify(recentRunDurations(groups3)) === JSON.stringify({ minSec: 174, maxSec: 399, count: 3 }))
ok('3번이 안 되면 어림하지 않는다', recentRunDurations(groups3.slice(0, 2)) === null)
ok('그 브랜드의 지난번(가장 최근)', lastRunDurationSec(groups3, 'c1') === 205 && lastRunDurationSec(groups3, 'none') === null)
ok('시간 글', durationText(174) === '2분 54초' && durationText(45) === '45초' && durationText(399) === '6분 39초')

// ── 4) 서버가 회차 id · 함께 잰 고객을 적는다(가짜 엔진) ───────────────
try {
  const { measureAndBake } = await import('../server/measureAndBake')
  const { readLocalMeasures } = await import('../server/localMeasureLog')
  const { FileResultStore } = await import('../server/store')
  const reg = await import('../server/tenantRegistry')
  const overlay = path.join(dir, 'tenants.overlay.json')
  mkdirSync(path.dirname(overlay), { recursive: true })
  writeFileSync(
    overlay,
    JSON.stringify([
      {
        tenantId: 'runs', brandName: '묶음 펜션', aliases: ['묶음 펜션'], ownedDomains: ['runs.example'], industry: '펜션', region: '가상시',
        engines: ['gemini'], questionBankSize: 4, questionBankVersion: 'v1', repeatsPerQuestion: 1, factGraph: [],
        competitors: [{ name: '옆 펜션', aliases: ['옆 펜션'], domains: ['side.example'] }],
      },
    ]),
  )
  const tenant = (await reg.loadRuntimeTenants()).find((t) => t.tenantId === 'runs')!
  await measureAndBake({ ...tenant }, new FileResultStore())
  const log = readLocalMeasures()
  const mine = log.find((r) => r.tenantId === 'runs')
  const comp = log.find((r) => r.tenantId !== 'runs')
  ok('측정 기록 파일이 생긴다', existsSync(path.join(dir, 'measure-runs.json')) && log.length === 2)
  ok('고객 · 경쟁사 줄이 같은 회차 id', Boolean(mine?.runId) && mine?.runId === comp?.runId && mine!.runId!.startsWith('runs@'))
  ok('경쟁사 줄에 함께 잰 고객 · 고객 줄에는 없음', comp?.parentTenantId === 'runs' && mine?.parentTenantId === undefined)
  const grouped = groupMeasureRuns(log as LocalRun[], (id) => id !== 'runs')
  ok('화면 묶음: 측정 1회', grouped.length === 1 && grouped[0]!.root.tenantId === 'runs' && grouped[0]!.children.length === 1)
} catch (err) {
  console.error(err)
  checks.push(['가짜 측정이 끝까지 돈다', false])
} finally {
  rmSync(dir, { recursive: true, force: true })
}

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
