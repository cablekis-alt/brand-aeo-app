/**
 * 브랜드 등록이 이미 있는 tenantId와 부딪혔을 때의 규칙(server/tenantPromote.ts)을 확인한다.
 * 임시 폴더를 APP_DATA_DIR로 쓰고 가짜 브랜드만 만든다. AI는 부르지 않는다(측정은 가짜 엔진).
 *
 * 왜: id는 홈페이지 첫 마디라 다른 업체가 같은 id를 받는다. 덮어쓰면 두 업체 기록이 섞이거나 고객 설정이 사라진다.
 * 경쟁사로만 재던 같은 곳(홈페이지가 같음)만 고객 브랜드로 전환하고, 지난 기록(id)은 그대로 이어야 한다.
 * 전환할 때는 경쟁사 때 남은 설정 · 질문지가 등록 값을 이기지 않아야 하고, 같은 주에 다시 재면 옛 코호트 순위도
 * 다시 매겨야 한다(2026-10-16 검토).
 *
 *   npx tsx scripts/verify-tenant-promote.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'verify-tenant-promote-'))
process.env.APP_DATA_DIR = dir
process.env.BLOB_READ_WRITE_TOKEN = ''
process.env.BLOB_STORE_ID = ''
process.env.USE_MOCK_ENGINES = 'true'

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
  const { measureAndBake } = await import('../server/measureAndBake')
  const { getIsoWeekString } = await import('../server/dateUtil')
  const { FileResultStore } = await import('../server/store')
  const store = new FileResultStore()
  const week = getIsoWeekString(new Date())

  // 가짜 코호트(펜션 · 가상시): 고객 vcust가 경쟁사 「가상 여행」(vtown.example → id vtown)을 함께 잰다.
  // 고객 vother는 주소가 다른 곳(vtown.go.example — id는 똑같이 vtown)을 경쟁사로 둔다.
  // 고객 vmulti의 「멀티」 줄은 첫 홈페이지가 multi.example이라 측정에서는 id multi로 잰다(둘째 주소가 vtown).
  const base = { engines: ['gemini'], questionBankSize: 42, questionBankVersion: 'v3', repeatsPerQuestion: 1, factGraph: [], cohortQuestionBank: 'c1' }
  writeJson('tenants.overlay.json', [
    { ...base, tenantId: 'vcust', brandName: '가상 펜션', aliases: ['가상 펜션'], ownedDomains: ['vcust.example'], industry: '펜션', region: '가상시',
      competitors: [{ name: '가상 여행', aliases: ['가상 여행'], domains: ['www.vtown.example'] }, { name: '가상 둘', aliases: ['가상 둘'], domains: [] }] },
    { ...base, tenantId: 'vother', brandName: '가상 민박', aliases: ['가상 민박'], ownedDomains: ['vother.example'], industry: '펜션', region: '가상시',
      competitors: [{ name: '가상 시청', aliases: ['가상 시청'], domains: ['vtown.go.example'] }] },
    { ...base, tenantId: 'vmulti', brandName: '가상 별장', aliases: ['가상 별장'], ownedDomains: ['vmulti.example'], industry: '펜션', region: '가상시',
      competitors: [{ name: '멀티', aliases: ['멀티'], domains: ['multi.example', 'vtown.example'] }] },
    { ...base, tenantId: 'vtown', brandName: '가상 여행', aliases: ['가상 여행'], ownedDomains: ['vtown.example'], industry: '펜션', region: '가상시', competitors: [], cohortOnly: true },
  ])
  // 이번 주에 둘 다 쟀다 — 펜션 코호트 순위 1/2 · 2/2.
  const card = (tenantId: string, brandName: string, score: number, position: number) => ({
    tenantId, brandName, industry: '펜션', region: '가상시', weekOf: week, questionBankVersion: 'v3',
    aeoScore: { current: score }, mentionRate: 0, brandOwnedCitationRate: 0, cohortRank: { position, totalTenants: 2 },
  })
  const seedCards = () => {
    writeJson('data/vtown/scorecard-history.json', [card('vtown', '가상 여행', 40, 1)])
    writeJson('data/vcust/scorecard-history.json', [card('vcust', '가상 펜션', 30, 2)])
  }
  seedCards()
  // 경쟁사일 때 고친 시장 범위와, 경쟁사 목록 없이 만든 v3 질문지.
  writeJson('data/vtown/market-scope.json', { marketScope: 'b2b', buyer: '가상 구매 담당' })
  writeJson('data/vtown/question-bank/v3.json', { version: 'v3', questions: [] })
  // 고객 vcust의 질문지 — 「가상 여행」을 짚은 비교 질문이 있다. 목록에서 빼면 그 질문도 빠진다(질문 넘겨받기 · 받을 곳 없음).
  const vq = (questionId: string, text: string, category: string, cohortShared = false) => ({
    questionId, text, category, industry: '펜션', region: '가상시', containsBrandName: !cohortShared, version: questionId.split('-')[0], ...(cohortShared ? { cohortShared } : {}),
  })
  writeJson('data/vcust/question-bank/v3.json', {
    version: 'v3',
    generatedAt: '2026-01-01T00:00:00.000Z',
    cohortBank: { key: '펜션__가상시', version: 'c1' },
    questions: [vq('c1-001', '가상시 펜션 추천해줘', 'category-agnostic', true), vq('v3-001', '가상 펜션이랑 가상 여행 중에 어디가 더 나아?', 'comparison'), vq('v3-002', '가상 펜션 체크인 몇 시야?', 'brand-direct')],
  })

  // 문항 수 1 — 가짜 엔진은 브랜드 전용 질문을 만들지 못해, 4)의 측정이 코호트 공통 질문만 쓰게 한다.
  const draft = reg.normalizeTenantDraft({
    tenantId: 'vtown', brandName: '가상 여행 정보', ownedDomains: ['www.vtown.example'], industry: '여행 정보', region: '가상시',
    engines: ['gemini'], questionBankSize: 1, competitors: [{ name: '가상 관광', domains: ['vtour.example'] }],
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
  ok('이번 주에 잰 기록이 있다', c?.lastWeekOf === week && c?.measuredThisWeek === true)
  ok('경쟁사 때 고친 설정을 알린다', c?.overrides.join() === '시장 범위')
  ok('홈페이지가 같은 줄을 둔 고객만(주소가 다른 vother · 둘째 주소만 같은 vmulti 아님)', c?.referencedBy.map((r) => r.tenantId).join() === 'vcust')
  ok('id만 같은 다른 곳의 줄은 따로 알린다', c?.sharedIdLines.map((l) => `${l.tenantId}:${l.line}:${l.domain}`).join() === 'vother:가상 시청:vtown.go.example')

  // 2) 다른 곳 · 고객 브랜드 · 저장소 설정 · 측정 중은 전환하지 않는다
  const other = { ...draft, ownedDomains: ['gunsan.go.example'] }
  ok('홈페이지가 다르면 sameSite false', (await promote.describeTenantConflict(other, store))?.sameSite === false)
  ok('홈페이지가 다르면 전환 409', await rejects(promote.promoteCompetitor(other, [], store), 409))
  const asCustomer = reg.normalizeTenantDraft({ ...draft, tenantId: 'vcust', ownedDomains: ['vcust.example'] })
  ok('고객 브랜드와 부딪히면 customer', (await promote.describeTenantConflict(asCustomer, store))?.kind === 'customer')
  ok('고객 브랜드는 전환 409', await rejects(promote.promoteCompetitor(asCustomer, [], store), 409))
  const repoTenant = (await reg.loadRuntimeTenants()).find((t) => !['vcust', 'vother', 'vmulti', 'vtown'].includes(t.tenantId))!
  const asRepo = reg.normalizeTenantDraft({ ...draft, tenantId: repoTenant.tenantId, ownedDomains: repoTenant.ownedDomains.length ? repoTenant.ownedDomains : ['x.example'] })
  ok('저장소 설정의 브랜드는 repo', (await promote.describeTenantConflict(asRepo, store))?.kind === 'repo')
  ok('저장소 설정의 브랜드는 전환 409', await rejects(promote.promoteCompetitor(asRepo, [], store), 409))
  ok('부딪히지 않으면 conflict 없음', (await promote.describeTenantConflict({ ...draft, tenantId: 'brand-new-x' }, store)) === null)
  tracker.beginMeasureRun()
  ok('측정 중에는 전환 409', await rejects(promote.promoteCompetitor(draft, [], store), 409))
  tracker.endMeasureRun()
  ok('막힌 전환은 설정 파일을 옮기지 않는다', existsSync(path.join(dir, 'data/vtown/market-scope.json')))

  // 3) 전환 — id 그대로, 넣은 값으로 바뀌고, 고른 고객의 경쟁사 목록에서 빠진다
  const result = await promote.promoteCompetitor(draft, ['vcust', 'vother', 'vmulti'], store)
  const runtime = await reg.loadRuntimeTenants()
  const promoted = runtime.find((t) => t.tenantId === 'vtown')!
  ok('전환 결과', result.ok && result.removedFrom.join() === 'vcust' && result.removeErrors.length === 0)
  ok('고객 브랜드가 된다(cohortOnly 아님)', !promoted.cohortOnly)
  ok('넣은 값으로 바뀐다(업종 · 이름 · 경쟁사)', promoted.industry === '여행 정보' && promoted.brandName === '가상 여행 정보' && promoted.competitors[0]?.name === '가상 관광')
  ok('id는 그대로 — 지난 기록이 이어진다', (await store.getScorecardHistory('vtown', 99)).length === 1)
  const customer = runtime.find((t) => t.tenantId === 'vcust')!
  ok('고른 고객의 경쟁사 목록에서 빠진다(www 무시)', customer.competitors.map((x) => x.name).join() === '가상 둘')
  const vcustV4 = JSON.parse(readFileSync(path.join(dir, 'data/vcust/question-bank/v4.json'), 'utf8')) as { questions: { questionId: string }[] }
  ok(
    '그 경쟁사를 짚은 비교 질문도 빠진다(질문지 v3 → v4 · 3 → 2)',
    customer.questionBankVersion === 'v4' && customer.questionBankSize === 2 && vcustV4.questions.map((x) => x.questionId).join() === 'c1-001,v3-002',
  )
  const vother = runtime.find((t) => t.tenantId === 'vother')!
  ok('id만 같은 다른 곳의 줄은 빼지 않는다', vother.competitors.map((x) => x.name).join() === '가상 시청')
  const vmulti = runtime.find((t) => t.tenantId === 'vmulti')!
  ok('첫 홈페이지가 다른 줄은 빼지 않는다(측정과 같은 기준)', vmulti.competitors.map((x) => x.name).join() === '멀티')

  // 3-b) 경쟁사 때 설정은 백업으로 — 등록 값이 이긴다
  const backup = path.join(dir, 'data/vtown', result.backupDir)
  ok('백업 폴더 이름', /^before-promote-/.test(result.backupDir) && existsSync(backup))
  ok('시장 범위 파일을 백업으로 옮긴다', result.setAside.join() === '시장 범위' && !existsSync(path.join(dir, 'data/vtown/market-scope.json')) && existsSync(path.join(backup, 'market-scope.json')))
  ok('등록 값의 시장 범위를 쓴다(b2b 아님)', promoted.marketScope !== 'b2b' && promoted.buyer === undefined)
  const savedEntry = JSON.parse(readFileSync(path.join(backup, 'overlay-entry.json'), 'utf8')) as { cohortOnly?: boolean; industry?: string }
  ok('옛 오버레이 항목을 남긴다', savedEntry.cohortOnly === true && savedEntry.industry === '펜션')

  // 3-c) 질문지 — 경쟁사 때 만든 v3이 있으면 다음 번호로, 옛 질문지는 그대로
  ok('질문지 버전을 올린다(v3 → v4)', result.questionBankVersion === 'v4' && promoted.questionBankVersion === 'v4')
  ok('옛 질문지는 남는다', existsSync(path.join(dir, 'data/vtown/question-bank/v3.json')))
  ok('전환한 뒤에는 고객 브랜드라 다시 전환 409', await rejects(promote.promoteCompetitor(draft, [], store), 409))

  // 4) 같은 주에 다시 재면 — 카드는 새 코호트로 옮겨 가고, 옛 코호트(펜션) 순위도 다시 매긴다
  // 4-a) 카드를 저장한 뒤 보고서 단계에서 실패해도 옛 코호트 순위는 다시 매긴다.
  const failing = new FileResultStore()
  failing.saveReport = async () => {
    throw new Error('보고서 저장 실패(검증용)')
  }
  const failed = await measureAndBake({ ...promoted, autoCohort: false }, failing).then(() => false, () => true)
  const movedCard = (await store.getScorecardHistory('vtown', 99)).find((x) => x.weekOf === week)
  const leftCard = (await store.getScorecardHistory('vcust', 99)).find((x) => x.weekOf === week)
  ok('실패한 측정 — 카드는 새 코호트로 옮겨 갔다', failed && movedCard?.industry === '여행 정보')
  ok('실패한 측정도 옛 코호트 순위를 다시 매긴다(2/2 → 1/1)', leftCard?.cohortRank?.position === 1 && leftCard.cohortRank.totalTenants === 1)

  // 4-b) 성공한 측정 — 이번 주 카드를 펜션으로 되돌려 다시 잰다.
  seedCards()
  await measureAndBake({ ...promoted, autoCohort: false }, store)
  const vtownCard = (await store.getScorecardHistory('vtown', 99)).find((x) => x.weekOf === week)
  ok('이번 주 카드가 새 코호트로', vtownCard?.industry === '여행 정보' && vtownCard.cohortRank?.totalTenants === 1)
  const vcustCard = (await store.getScorecardHistory('vcust', 99)).find((x) => x.weekOf === week)
  ok('옛 코호트에 남은 고객 순위를 다시 매긴다(2/2 → 1/1)', vcustCard?.cohortRank?.position === 1 && vcustCard.cohortRank.totalTenants === 1)
  ok('새 질문지를 v4로 만든다', readdirSync(path.join(dir, 'data/vtown/question-bank')).includes('v4.json'))
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
