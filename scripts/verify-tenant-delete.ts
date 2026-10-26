/**
 * 브랜드 삭제 미리보기 · 지운 브랜드 되살리기 · 「측정 중이면 막기」(server/tenantRemovedStore.ts · server/index.ts)를 확인한다. 임시 데이터
 * 폴더 · 가짜 엔진(USE_MOCK_ENGINES)으로 서버를 띄워 HTTP로 부른다 — 실제 AI는 부르지 않고 실제 데이터는 건드리지 않는다.
 *
 * 왜: 삭제하면 설정(경쟁사 · 수집 엔진)이 사라지고 같은 비교 그룹의 지난 순위가 다시 매겨진다. 되살렸는데 순위가 지우기 전과 다르거나,
 * 같은 홈페이지를 다시 등록한 뒤 되살려 같은 브랜드가 둘이 되거나, 측정 중에 지우거나 두 측정이 겹치면 순위 · 기록이 엉킨다.
 *
 *   npx tsx scripts/verify-tenant-delete.ts
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo
      srv.close(() => resolve(port))
    })
  })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const dir = mkdtempSync(path.join(tmpdir(), 'verify-tenant-delete-'))
const writeJson = (rel: string, value: unknown) => {
  const file = path.join(dir, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value))
}
const readJson = <T>(rel: string): T => JSON.parse(readFileSync(path.join(dir, rel), 'utf8')) as T

const IND = '생명보험'
const REG = '서울 종로'
const WEEKS = ['2026-W36', '2026-W37', '2026-W38', '2026-W39', '2026-W40', '2026-W41', '2026-W42', '2026-W43']
const card = (tenantId: string, brandName: string, weekOf: string, score: number, position: number) => ({
  tenantId,
  weekOf,
  industry: IND,
  region: REG,
  brandName,
  aeoScore: { current: score, ma4: score, previousWeek: score, ciLow: 0, ciHigh: 0 },
  mentionRate: 0.1,
  shareOfMention: null,
  avgRecommendationRank: null,
  factualityScore: null,
  brandOwnedCitationRate: 0.05,
  // 측정 끝에 매긴 것과 같은 순위(점수 40 · 30 두 곳)로 시작한다.
  cohortRank: { position, totalTenants: 2 },
  hallucinationFlags: [],
})
const tenant = (tenantId: string, brandName: string, p: Record<string, unknown> = {}) => ({
  tenantId,
  brandName,
  aliases: [brandName],
  ownedDomains: [`${tenantId}.example`],
  industry: IND,
  region: REG,
  engines: ['gemini'],
  questionBankSize: 4,
  questionBankVersion: 'v1',
  repeatsPerQuestion: 1,
  factGraph: [],
  competitors: [],
  ...p,
})
writeJson('tenants.overlay.json', [
  tenant('kyobo', '가짜교보'),
  tenant('hanwha', '가짜한화', { competitors: [{ name: '가짜교보', aliases: ['가짜교보'], domains: ['kyobo.example'] }] }),
  tenant('slow', '느린 펜션', { industry: '펜션', region: '가상시' }),
])
writeJson('data/kyobo/scorecard-history.json', WEEKS.map((w) => card('kyobo', '가짜교보', w, 40, 1)))
writeJson('data/hanwha/scorecard-history.json', WEEKS.map((w) => card('hanwha', '가짜한화', w, 30, 2)))

const port = await freePort()
const base = `http://127.0.0.1:${port}`
const env = {
  ...process.env,
  APP_DATA_DIR: dir,
  PORT: String(port),
  USE_MOCK_ENGINES: 'true',
  // 측정이 몇 초 걸리게 — 그동안 「측정 중이면 막기」를 확인한다.
  MOCK_ENGINE_DELAY_MS: '2500',
  BLOB_READ_WRITE_TOKEN: '',
  BLOB_STORE_ID: '',
  PIPELINE_CRON: '',
  GH_MEASURE_TOKEN: '',
}
const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: process.cwd(), env, stdio: 'ignore' })
const call = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null }
}
const hanwhaRank = (weekOf: string) => {
  const r = readJson<{ weekOf: string; cohortRank: { position: number; totalTenants: number } }[]>('data/hanwha/scorecard-history.json').find((c) => c.weekOf === weekOf)?.cohortRank
  return r ? `${r.position}/${r.totalTenants}` : null
}

try {
  let up = false
  for (let i = 0; i < 80 && !up; i += 1) {
    up = await fetch(`${base}/api/health`).then((r) => r.ok, () => false)
    if (!up) await sleep(500)
  }
  ok('서버가 뜬다', up)

  // ── 1) 미리보기 ─────────────────────────────────────────────
  const preview = await call('GET', '/api/tenants/kyobo/delete-preview')
  const cohorts = preview.body?.cohorts as { industry: string; region: string; weeks: number; firstWeekOf: string; lastWeekOf: string }[] | undefined
  ok(
    '미리보기: 비교 그룹 · 주 수 · 처음 · 마지막 주',
    preview.status === 200 && cohorts?.length === 1 && cohorts[0]!.weeks === 8 && cohorts[0]!.firstWeekOf === '2026-W36' && cohorts[0]!.lastWeekOf === '2026-W43',
  )
  ok('미리보기: 이 브랜드를 경쟁사로 재는 고객', JSON.stringify(preview.body?.competitorOf) === JSON.stringify([{ tenantId: 'hanwha', brandName: '가짜한화' }]))
  ok('미리보기: 측정 중 아님 · 없는 브랜드는 404', preview.body?.measuring === false && (await call('GET', '/api/tenants/none/delete-preview')).status === 404)

  // ── 2) 측정 중이면 막는다 ─────────────────────────────────────
  const first = call('POST', '/api/tenants/slow/measure', { selfOnly: true })
  let inFlight = false
  for (let i = 0; i < 40 && !inFlight; i += 1) {
    const s = await call('GET', '/api/measure-status')
    inFlight = ((s.body?.runs as { current?: unknown[] } | undefined)?.current?.length ?? 0) > 0
    if (!inFlight) await sleep(150)
  }
  ok('가짜 측정이 시작됐다', inFlight)
  const second = await call('POST', '/api/tenants/hanwha/measure', {})
  ok('측정 중 다른 측정 → 409 busy', second.status === 409 && second.body?.busy === true && String(second.body?.error).includes('이미 측정 중'))
  ok('측정 중 삭제 → 409', (await call('DELETE', '/api/tenants?tenantId=kyobo')).status === 409)
  ok('측정 중 미리보기는 측정 중으로', (await call('GET', '/api/tenants/kyobo/delete-preview')).body?.measuring === true)
  const done = await first
  ok('먼저 시작한 측정은 끝까지', done.status === 200)

  // ── 3) 삭제 · 백업 · 순위 ──────────────────────────────────────
  const before = hanwhaRank('2026-W43')
  const del = await call('DELETE', '/api/tenants?tenantId=kyobo')
  ok('삭제(로컬) — 목록에서 빠지고 기록은 남는다', del.status === 200 && del.body?.locallyDeleted === true && existsSync(path.join(dir, 'data/kyobo/scorecard-history.json')))
  const listAfter = await call('GET', '/api/tenants')
  ok('브랜드 목록에서 빠진다', Array.isArray(listAfter.body) && !(listAfter.body as unknown as { tenantId: string }[]).some((t) => t.tenantId === 'kyobo'))
  const backup = readJson<{ tenantId: string; overlay: { tenantId: string } | null }[]>('tenants.removed.json')
  ok('지우기 전 설정을 남긴다', backup[0]?.tenantId === 'kyobo' && backup[0]?.overlay?.tenantId === 'kyobo')
  ok('같은 비교 그룹 순위를 이 브랜드를 빼고 다시 매긴다(2/2 → 1/1)', before === '2/2' && hanwhaRank('2026-W43') === '1/1' && hanwhaRank('2026-W36') === '1/1')
  const removed = await call('GET', '/api/tenants/removed')
  const removedList = removed.body as unknown as Record<string, unknown>[]
  ok('지운 브랜드 목록 — 설정 본문은 내보내지 않는다', Array.isArray(removedList) && removedList[0]?.tenantId === 'kyobo' && !('overlay' in removedList[0]!))

  // ── 4) 같은 홈페이지가 다시 등록돼 있으면 되살리지 않는다 ────────────
  const twin = await call('POST', '/api/tenants', tenant('kyobo-again', '가짜교보 새로', { ownedDomains: ['kyobo.example'] }))
  ok('같은 홈페이지를 다른 ID로 다시 등록(빈 자리라 된다)', twin.status === 201)
  const blocked = await call('POST', '/api/tenants/kyobo/restore')
  ok('같은 홈페이지 · 비교 그룹이 있으면 되살리기 409', blocked.status === 409 && String(blocked.body?.error).includes('같은 홈페이지'))
  ok('다시 등록한 브랜드를 빼면', (await call('DELETE', '/api/tenants?tenantId=kyobo-again')).status === 200)

  // ── 5) 되살리기 ──────────────────────────────────────────────
  const restored = await call('POST', '/api/tenants/kyobo/restore')
  ok('되살리기 200', restored.status === 200 && restored.body?.tenantId === 'kyobo')
  const listBack = (await call('GET', '/api/tenants')).body as unknown as { tenantId: string; competitors: string[] }[]
  ok('브랜드 목록에 돌아온다', listBack.some((t) => t.tenantId === 'kyobo'))
  ok('툼스톤이 걷힌다', !readJson<string[]>('tenants.deleted.json').includes('kyobo'))
  ok('순위가 지우기 전과 같다(1/1 → 2/2)', hanwhaRank('2026-W43') === before && hanwhaRank('2026-W36') === '2/2')
  ok('지운 브랜드 목록에서 빠진다', !readJson<{ tenantId: string }[]>('tenants.removed.json').some((r) => r.tenantId === 'kyobo'))
  ok('되살린 뒤 다시 되살리기 · 목록에 없는 브랜드 → 404', (await call('POST', '/api/tenants/kyobo/restore')).status === 404 && (await call('POST', '/api/tenants/none/restore')).status === 404)
} catch (err) {
  console.error(err)
  checks.push(['예외 없이 끝까지 돈다', false])
} finally {
  server.kill()
  await sleep(500)
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
