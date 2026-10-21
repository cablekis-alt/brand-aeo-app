/**
 * 같은 홈페이지를 다른 시장 범위로 하나 더 등록하는 규칙(server/tenantPromote.ts registerVariant · src/lib/brandVariant.ts)을 확인한다.
 * 임시 폴더를 APP_DATA_DIR로 쓰고 가짜 브랜드만 만든다. AI는 부르지 않는다(측정은 가짜 엔진).
 *
 * 왜: 브랜드 id는 홈페이지 첫 마디라 같은 홈페이지를 전국형으로도 재려면 id가 부딪혔다(2026-10-21 군산각 gunsan · gunsan-national).
 * 새 브랜드는 id에 범위 꼬리를 붙여 따로 쌓아야 하고, 업종 · 지역 · 언어가 같으면 같은 질문지 · 순위표를 나눠 쓰게 되므로 막아야 한다.
 * 사람이 넣은 사실 · 브랜드 페이지 · 발행 설정만 가져오고, 범위마다 다른 경쟁사 · 시장 범위는 가져오지 않는다.
 *
 *   npx tsx scripts/verify-tenant-variant.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { TenantSummary } from '../src/lib/api'

const dir = mkdtempSync(path.join(tmpdir(), 'verify-tenant-variant-'))
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
async function throwsWith(p: Promise<unknown>, text: string): Promise<boolean> {
  try {
    await p
    return false
  } catch (err) {
    return err instanceof Error && err.message.includes(text)
  }
}
const writeJson = (rel: string, value: unknown) => {
  const file = path.join(dir, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value))
}
const has = (rel: string) => existsSync(path.join(dir, rel))

try {
  const v = await import('../src/lib/brandVariant')
  const { findTenantByDomain } = await import('../src/lib/aeo/resolveTarget')
  const reg = await import('../server/tenantRegistry')
  const promote = await import('../server/tenantPromote')
  const { measureAndBake } = await import('../server/measureAndBake')
  const { getIsoWeekString } = await import('../server/dateUtil')
  const { FileResultStore } = await import('../server/store')
  const store = new FileResultStore()
  const week = getIsoWeekString(new Date())

  // 1) id · 홈페이지 · 코호트 — 순수 함수
  ok('id: 지역형 바탕 + 전국형 → -national', v.variantTenantId('gunsan', 'national') === 'gunsan-national')
  ok('id: 이미 꼬리가 있으면 떼고 붙인다(-national → -local)', v.variantTenantId('gunsan-national', undefined) === 'gunsan-local')
  ok('id: B2B형 → -b2b', v.variantTenantId('gunsan-local', 'b2b') === 'gunsan-b2b')
  ok('홈페이지: www · https · 경로 차이는 같은 곳', v.sharesSite({ ownedDomains: ['https://www.a.example/x'] }, { ownedDomains: ['A.example'] }))
  ok('홈페이지: 다른 곳', !v.sharesSite({ ownedDomains: ['a.example'] }, { ownedDomains: ['b.example'] }))
  const ko = { tenantId: 'a', ownedDomains: ['a.example'], industry: '펜션', region: '가상시' }
  ok('코호트: 업종 · 지역 · 언어가 같으면 같다', v.sameCohort(ko, { ...ko, tenantId: 'b', marketScope: 'national' }))
  ok('코호트: 영어 질문은 다르다', !v.sameCohort(ko, { ...ko, tenantId: 'a-en', region: '가상시 (영어 질문)', questionLanguage: 'en' }))

  // 2) 목록 표시 — 형제가 있을 때만, 범위가 같으면 업종
  const local = { tenantId: 'x', ownedDomains: ['x.example'], industry: '관광정보서비스', region: '가상시' }
  const national = { tenantId: 'x-national', ownedDomains: ['x.example'], industry: '관광안내', region: '국내', marketScope: 'national' }
  const english = { tenantId: 'x-en', ownedDomains: ['x.example'], industry: '관광정보서비스', region: '가상시 (영어 질문)', questionLanguage: 'en' }
  const comp = { tenantId: 'x-comp', ownedDomains: ['x.example'], industry: '관광정보서비스', region: '다른시', cohortOnly: true }
  ok('표시: 혼자면 없음', v.variantTag(local, [local, english, comp]) === null)
  ok('표시: 지역형 · 전국형', v.variantTag(local, [local, national]) === '지역형' && v.variantTag(national, [local, national]) === '전국형')
  const local2 = { ...local, tenantId: 'x-local', industry: '숙박' }
  ok('표시: 범위가 같은 형제면 업종', v.variantTag(local, [local, local2]) === '관광정보서비스' && v.variantTag(local2, [local, local2]) === '숙박')
  ok('표시: 경쟁사 · 영어 측정은 형제가 아니다', v.variantTag(english, [local, national, english]) === null && v.variantTag(comp, [local, comp]) === null)

  // 3) 사이트 진단 — 같은 홈페이지면 지금 고른 브랜드
  const summaries = [local, national].map((t) => ({ ...t, brandName: '가상각' }) as unknown as TenantSummary)
  ok('진단: 고른 브랜드가 그 홈페이지면 그 브랜드', findTenantByDomain('https://x.example/a', summaries, summaries[1])?.tenantId === 'x-national')
  ok('진단: 고른 게 없으면 목록 첫 브랜드', findTenantByDomain('x.example', summaries)?.tenantId === 'x')
  const other = { tenantId: 'o', brandName: '다른 곳', ownedDomains: ['o.example'] } as unknown as TenantSummary
  ok('진단: 고른 브랜드가 다른 홈페이지면 주인', findTenantByDomain('m.x.example', [...summaries, other], other)?.tenantId === 'x')

  // 4) 서버 — 가짜 브랜드: 고객 vsite(지역형), 같은 홈페이지의 영어 측정 vsite-en, 홈페이지가 같은 경쟁사 vcomp.
  const base = { engines: ['gemini'], questionBankSize: 1, questionBankVersion: 'v3', repeatsPerQuestion: 1, factGraph: [], cohortQuestionBank: 'c1', competitors: [] }
  writeJson('tenants.overlay.json', [
    { ...base, tenantId: 'vsite', brandName: '가상각', aliases: ['가상각', '가상 여행의 모든것'], ownedDomains: ['vsite.example', 'old.vsite.example'],
      industry: '관광정보서비스', region: '가상시', ga4PropertyId: '123456',
      competitors: [{ name: '가상 시청', aliases: ['가상 시청'], domains: ['vcity.example'] }] },
    { ...base, tenantId: 'vsite-en', brandName: '가상각', aliases: ['Gasang-gak'], ownedDomains: ['vsite.example'],
      industry: '관광정보서비스', region: '가상시 (영어 질문)', questionLanguage: 'en' },
    { ...base, tenantId: 'vcomp', brandName: '가상 관광', aliases: ['가상 관광'], ownedDomains: ['vcomp.example'], industry: '관광안내', region: '국내', cohortOnly: true },
  ])
  writeJson('data/vsite/scorecard-history.json', [{ tenantId: 'vsite', brandName: '가상각', industry: '관광정보서비스', region: '가상시', weekOf: '2026-W40',
    questionBankVersion: 'v3', aeoScore: { current: 30 }, mentionRate: 0, brandOwnedCitationRate: 0, cohortRank: { position: 1, totalTenants: 1 } }])
  writeJson('data/vsite/fact-graph.json', { facts: [{ key: '주소', value: '가상시 가상로 1' }] })
  writeJson('data/vsite/brand-page.json', { brandPageUrl: 'https://vsite.example/about' })
  writeJson('data/vsite/publish-settings.json', { ctaText: '문의하기', photoRights: { confirmedAt: '2026-10-01T00:00:00.000Z' } })
  writeJson('data/vsite/market-scope.json', { marketScope: 'local' })
  writeJson('data/vsite/competitors.json', { competitors: [] })
  // 지운 vsite-b2b — 기록 2주와 앱에서 고친 시장 범위가 남아 있다.
  writeJson('tenants.deleted.json', ['vsite-b2b'])
  const old = (weekOf: string) => ({ tenantId: 'vsite-b2b', brandName: '가상각', industry: '관광 B2B', region: '국내', weekOf, questionBankVersion: 'v3',
    aeoScore: { current: 10 }, mentionRate: 0, brandOwnedCitationRate: 0 })
  writeJson('data/vsite-b2b/scorecard-history.json', [old('2026-W30'), old('2026-W31')])
  writeJson('data/vsite-b2b/market-scope.json', { marketScope: 'b2b', buyer: '옛 구매 담당' })

  const draftOf = (extra: Record<string, unknown>) =>
    reg.normalizeTenantDraft({ tenantId: 'vsite', brandName: '가상각', ownedDomains: ['www.vsite.example'], engines: ['gemini'], questionBankSize: 1, ...extra })
  const nationalDraft = draftOf({ industry: '관광안내', region: '국내', marketScope: 'national', aliases: ['가상각', '가상각 전국'],
    competitors: [{ name: '가상 관광', domains: ['vcomp.example'] }] })

  // 4-a) 살피기 — 고객 브랜드와 부딪히면 범위 변형을 연다
  const conflict = await promote.describeTenantConflict(nationalDraft, store)
  ok('살피기: 고객 브랜드 · 같은 홈페이지', conflict?.kind === 'customer' && conflict.sameSite)
  ok('살피기: 새 id vsite-national, 막히지 않음', conflict?.variant?.tenantId === 'vsite-national' && conflict.variant.blocked === null)
  ok('살피기: 형제 목록에 영어 측정도 보인다(같은 홈페이지 고객)', (conflict?.siblings ?? []).map((s) => s.tenantId).sort().join(',') === 'vsite,vsite-en')

  // 4-b) 같은 코호트면 막는다
  const sameCohortDraft = draftOf({ industry: '관광정보서비스', region: '가상시', marketScope: 'national' })
  const blocked = await promote.describeTenantConflict(sameCohortDraft, store)
  ok('막기: 업종 · 지역이 같으면 이유와 함께 막는다', Boolean(blocked?.variant?.blocked?.includes('vsite')))
  ok('막기: 등록도 409', await rejects(promote.registerVariant(sameCohortDraft, store, { copyBusinessFiles: true }), 409))
  const twinComp = draftOf({ industry: '관광안내', region: '국내', marketScope: 'national', ownedDomains: ['vsite.example', 'vcomp.example'] })
  ok('막기: 홈페이지를 함께 쓰는 경쟁사와 같은 코호트도 막는다', Boolean((await promote.describeTenantConflict(twinComp, store))?.variant?.blocked?.includes('vcomp')))

  // 4-c) 등록 — 새 id, 별칭 · 홈페이지 · GA4는 물려받고, 사람이 넣은 설정만 복사
  const result = await promote.registerVariant(nationalDraft, store, { copyBusinessFiles: true })
  const runtime = await reg.loadRuntimeTenants()
  const created = runtime.find((t) => t.tenantId === 'vsite-national')
  ok('등록: 새 브랜드 vsite-national', result.tenantId === 'vsite-national' && created?.marketScope === 'national' && !created.cohortOnly)
  ok('등록: 이름은 그대로', created?.brandName === '가상각')
  ok('등록: 별칭 합침(바탕 별칭 유지)', ['가상각', '가상각 전국', '가상 여행의 모든것'].every((a) => created?.aliases.includes(a)))
  ok('등록: 옛 도메인까지 합침', created?.ownedDomains.includes('old.vsite.example') === true && created.ownedDomains.filter((d) => v.hostKey(d) === 'vsite.example').length === 1)
  ok('등록: GA4 속성 물려받음', created?.ga4PropertyId === '123456')
  ok('등록: 경쟁사는 초안 값', created?.competitors.map((c) => c.name).join(',') === '가상 관광')
  ok('등록: 바탕 브랜드는 그대로', runtime.find((t) => t.tenantId === 'vsite')?.industry === '관광정보서비스')
  ok('복사: 사실 · 브랜드 페이지 · 발행 설정', result.copied.join(',') === '사실,브랜드 페이지,발행 설정' && result.copyErrors.length === 0)
  ok('복사: 시장 범위 · 경쟁사 목록은 가져오지 않는다', !has('data/vsite-national/market-scope.json') && !has('data/vsite-national/competitors.json'))
  ok('복사: 사실 내용이 같다', readFileSync(path.join(dir, 'data/vsite-national/fact-graph.json'), 'utf-8').includes('가상로 1'))
  ok('기록: 새 브랜드는 0주에서', result.restoredWeeks === 0 && (await store.getScorecardHistory('vsite-national', 99)).length === 0)

  // 4-d) 다시 누르면 — 이제 같은 코호트 형제가 있어 409
  ok('다시 등록: 409', await rejects(promote.registerVariant(nationalDraft, store, { copyBusinessFiles: true }), 409))

  // 4-e) 전국형과 B2B형은 지역이 둘 다 국내 — 업종까지 같으면 막고 그 까닭을 덧붙인다
  const b2bSame = draftOf({ industry: '관광안내', region: '국내', marketScope: 'b2b', buyer: '여행사' })
  ok('막기: 국내 · 같은 업종의 B2B형', Boolean((await promote.describeTenantConflict(b2bSame, store))?.variant?.blocked?.includes('「국내」')))
  const againBlocked = (await promote.describeTenantConflict(nationalDraft, store))?.variant?.blocked ?? ''
  ok('막기: 전국형을 또 전국형으로 — 「국내」 덧붙임 없이 이유만', againBlocked.includes('vsite-national') && !againBlocked.includes('「국내」'))

  // 4-f) 지운 같은 id — 기록은 되살아난다고 알리고, 남은 설정은 백업으로 옮긴다. 의료 업종이면 사진 확인은 넘기지 않는다.
  const b2bDraft = draftOf({ industry: '피부과 B2B', region: '국내', marketScope: 'b2b', buyer: '병원 구매 담당' })
  const b2bPlan = await promote.describeTenantConflict(b2bDraft, store)
  ok('지운 id: 되살아날 기록 2주를 알린다', b2bPlan?.variant?.tenantId === 'vsite-b2b' && b2bPlan.variant.restoredWeeks === 2 && b2bPlan.variant.blocked === null)
  const b2b = await promote.registerVariant(b2bDraft, store, { copyBusinessFiles: true })
  ok('지운 id: 남은 시장 범위는 백업으로', b2b.setAside.join(',') === '시장 범위' && !has('data/vsite-b2b/market-scope.json'))
  ok('지운 id: 다시 보인다', (await reg.loadRuntimeTenants()).some((t) => t.tenantId === 'vsite-b2b' && t.buyer === '병원 구매 담당'))
  const b2bSettings = JSON.parse(readFileSync(path.join(dir, 'data/vsite-b2b/publish-settings.json'), 'utf-8')) as { ctaText?: string; photoRights?: unknown }
  ok('의료 업종: 사진 사용 확인은 넘기지 않는다(다른 발행 설정은 넘긴다)', b2bSettings.ctaText === '문의하기' && b2bSettings.photoRights === undefined)

  // 4-g) 복사하지 않기
  const lodging = draftOf({ industry: '숙박', region: '가상시', aliases: ['가상각'] })
  const plain = await promote.registerVariant(lodging, store, { copyBusinessFiles: false })
  ok('복사 끔: 지역형 숙박 → vsite-local, 아무것도 복사하지 않는다', plain.tenantId === 'vsite-local' && plain.copied.length === 0 && !has('data/vsite-local/fact-graph.json'))

  // 4-h) 경쟁사와 부딪히면 범위 변형이 아니라 전환
  const compDraft = reg.normalizeTenantDraft({ tenantId: 'vcomp', brandName: '가상 관광', ownedDomains: ['vcomp.example'], industry: '관광안내', region: '국내' })
  ok('경쟁사와 부딪힘: 범위 변형 없음', (await promote.describeTenantConflict(compDraft, store))?.variant === null)

  // 5) 그냥 등록 — 같은 홈페이지 · 같은 코호트의 고객 브랜드가 다른 id로 있으면 막는다(영어 측정 · 경쟁사는 지나간다)
  const twin = reg.normalizeTenantDraft({ tenantId: 'vsite-copy', brandName: '가상각', ownedDomains: ['vsite.example'], industry: '관광안내', region: '국내', marketScope: 'national' })
  ok('그냥 등록: 같은 홈페이지 · 코호트는 막는다', await throwsWith(reg.registerTenant(twin), '이미 존재'))
  const enTwin = reg.normalizeTenantDraft({ tenantId: 'vsite-en2', brandName: '가상각', ownedDomains: ['vsite.example'], industry: '숙박', region: '가상시 (영어 질문)', questionLanguage: 'en' })
  await reg.registerTenant(enTwin)
  ok('그냥 등록: 다른 언어는 지나간다', (await reg.loadRuntimeTenants()).some((t) => t.tenantId === 'vsite-en2'))
  const compTwin = reg.normalizeTenantDraft({ tenantId: 'vsite-comp', brandName: '가상각', ownedDomains: ['vsite.example'], industry: '숙박', region: '가상시', cohortOnly: true })
  await reg.registerTenant(compTwin)
  ok('그냥 등록: 경쟁사(cohortOnly)는 지나간다', (await reg.loadRuntimeTenants()).some((t) => t.tenantId === 'vsite-comp'))

  // 6) 첫 측정 — 새 브랜드 폴더에만 쌓이고, 질문지는 그때 만든다
  const toMeasure = (await reg.loadRuntimeTenants()).find((t) => t.tenantId === 'vsite-national')!
  await measureAndBake({ ...toMeasure, autoCohort: false }, store)
  const measured = (await store.getScorecardHistory('vsite-national', 99)).find((c) => c.weekOf === week)
  ok('첫 측정: 새 브랜드 카드(관광안내 · 국내)', measured?.industry === '관광안내' && measured.region === '국내')
  ok('첫 측정: 질문지를 만든다', has(`data/vsite-national/question-bank/${toMeasure.questionBankVersion}.json`))
  ok('첫 측정: 바탕 브랜드 기록은 그대로(1주)', (await store.getScorecardHistory('vsite', 99)).length === 1)
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
