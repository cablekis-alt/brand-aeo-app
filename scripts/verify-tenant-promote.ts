/**
 * 브랜드 등록이 이미 있는 tenantId와 부딪혔을 때의 규칙(server/tenantPromote.ts)을 확인한다.
 * 임시 폴더를 APP_DATA_DIR로 쓰고 가짜 브랜드만 만든다. AI는 부르지 않는다.
 *
 * 왜: id는 홈페이지 첫 마디라 다른 업체가 같은 id를 받는다. 덮어쓰면 두 업체 기록이 섞이거나 고객 설정이 사라진다.
 * 경쟁사로만 재던 같은 곳(홈페이지가 같음)만 고객 브랜드로 전환하고, 지난 기록(id)은 그대로 이어야 한다.
 *
 *   npx tsx scripts/verify-tenant-promote.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'verify-tenant-promote-'))
process.env.APP_DATA_DIR = dir
process.env.BLOB_READ_WRITE_TOKEN = ''
process.env.BLOB_STORE_ID = ''

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])
async function rejects(p: Promise<unknown>, status: number): Promise<boolean> {
  try {
    await p
    return false
  } catch (err) {
    return (err as { status?: number }).status === status
  }
}
const writeJson = (rel: string, value: unknown) => {
  const file = path.join(dir, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value))
}

try {
  const reg = await import('../server/tenantRegistry')
  const promote = await import('../server/tenantPromote')
  const tracker = await import('../server/measureTracker')
  const { FileResultStore } = await import('../server/store')
  const store = new FileResultStore()

  // 가짜 코호트: 고객 vcust(펜션 · 가상시)가 경쟁사 「가상 여행」(vtown.example → id vtown)을 함께 잰다.
  const base = { engines: ['gemini'], questionBankSize: 42, questionBankVersion: 'v5', repeatsPerQuestion: 1, factGraph: [], cohortQuestionBank: 'c1' }
  writeJson('tenants.overlay.json', [
    { ...base, tenantId: 'vcust', brandName: '가상 펜션', aliases: ['가상 펜션'], ownedDomains: ['vcust.example'], industry: '펜션', region: '가상시',
      competitors: [{ name: '가상 여행', aliases: ['가상 여행'], domains: ['vtown.example'] }, { name: '가상 둘', aliases: ['가상 둘'], domains: [] }] },
    { ...base, tenantId: 'vtown', brandName: '가상 여행', aliases: ['가상 여행'], ownedDomains: ['vtown.example'], industry: '펜션', region: '가상시', competitors: [], cohortOnly: true },
  ])
  writeJson('data/vtown/scorecard-history.json', [
    { tenantId: 'vtown', brandName: '가상 여행', industry: '펜션', region: '가상시', weekOf: '2026-W42', aeoScore: { current: 0 }, mentionRate: 0, brandOwnedCitationRate: 0, cohortRank: { position: 2, totalTenants: 2 } },
  ])

  const draft = reg.normalizeTenantDraft({
    tenantId: 'vtown', brandName: '가상 여행 정보', ownedDomains: ['www.vtown.example'], industry: '여행 정보', region: '가상시',
    competitors: [{ name: '가상 관광', domains: ['vtour.example'] }],
  })

  // 1) 등록은 막히고, 부딪힌 상대를 가려낸다
  let blocked = false
  try {
    await reg.registerTenant(draft)
  } catch (err) {
    blocked = err instanceof Error && err.message.includes('이미 존재')
  }
  ok('같은 id 등록은 막힌다(덮어쓰지 않음)', blocked)
  const c = await promote.describeTenantConflict(draft, store)
  ok('경쟁사로만 재던 브랜드', c?.kind === 'competitor')
  ok('홈페이지가 같으면 같은 곳(www 무시)', c?.sameSite === true)
  ok('지난 기록 주 수', c?.weeks === 1)
  ok('이 브랜드를 경쟁사로 재는 고객', c?.referencedBy.map((r) => r.tenantId).join() === 'vcust')

  // 2) 다른 곳 · 고객 브랜드 · 저장소 설정 · 측정 중은 전환하지 않는다
  const other = { ...draft, ownedDomains: ['gunsan.go.example'] }
  ok('홈페이지가 다르면 sameSite false', (await promote.describeTenantConflict(other, store))?.sameSite === false)
  ok('홈페이지가 다르면 전환 409', await rejects(promote.promoteCompetitor(other, [], store), 409))
  const asCustomer = reg.normalizeTenantDraft({ ...draft, tenantId: 'vcust', ownedDomains: ['vcust.example'] })
  ok('고객 브랜드와 부딪히면 customer', (await promote.describeTenantConflict(asCustomer, store))?.kind === 'customer')
  ok('고객 브랜드는 전환 409', await rejects(promote.promoteCompetitor(asCustomer, [], store), 409))
  const repoTenant = (await reg.loadRuntimeTenants()).find((t) => t.tenantId !== 'vcust' && t.tenantId !== 'vtown')!
  const asRepo = reg.normalizeTenantDraft({ ...draft, tenantId: repoTenant.tenantId, ownedDomains: repoTenant.ownedDomains.length ? repoTenant.ownedDomains : ['x.example'] })
  ok('저장소 설정의 브랜드는 repo', (await promote.describeTenantConflict(asRepo, store))?.kind === 'repo')
  ok('저장소 설정의 브랜드는 전환 409', await rejects(promote.promoteCompetitor(asRepo, [], store), 409))
  ok('부딪히지 않으면 conflict 없음', (await promote.describeTenantConflict({ ...draft, tenantId: 'brand-new-x' }, store)) === null)
  tracker.beginMeasureRun()
  ok('측정 중에는 전환 409', await rejects(promote.promoteCompetitor(draft, [], store), 409))
  tracker.endMeasureRun()

  // 3) 전환 — id 그대로, 넣은 값으로 바뀌고, 고른 고객의 경쟁사 목록에서 빠진다
  const result = await promote.promoteCompetitor(draft, ['vcust'], store)
  const runtime = await reg.loadRuntimeTenants()
  const promoted = runtime.find((t) => t.tenantId === 'vtown')!
  ok('전환 결과', result.ok && result.removedFrom.join() === 'vcust' && result.removeErrors.length === 0)
  ok('고객 브랜드가 된다(cohortOnly 아님)', !promoted.cohortOnly)
  ok('넣은 값으로 바뀐다(업종 · 이름 · 경쟁사)', promoted.industry === '여행 정보' && promoted.brandName === '가상 여행 정보' && promoted.competitors[0]?.name === '가상 관광')
  ok('id는 그대로 — 지난 기록이 이어진다', (await store.getScorecardHistory('vtown', 99)).length === 1)
  const customer = runtime.find((t) => t.tenantId === 'vcust')!
  ok('고른 고객의 경쟁사 목록에서 빠진다', customer.competitors.map((x) => x.name).join() === '가상 둘')
  ok('전환한 뒤에는 고객 브랜드라 다시 전환 409', await rejects(promote.promoteCompetitor(draft, [], store), 409))
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
