/**
 * 같은 홈페이지를 다른 시장 범위로 하나 더 등록하는 규칙(server/tenantPromote.ts registerVariant · src/lib/brandVariant.ts)을 확인한다.
 * 임시 폴더를 APP_DATA_DIR로 쓰고 가짜 브랜드만 만든다. AI는 부르지 않는다(측정은 가짜 엔진).
 *
 * 왜: 브랜드 id는 홈페이지 첫 마디라 같은 홈페이지를 전국형으로도 재려면 id가 부딪혔다(2026-10-21 군산각 gunsan · gunsan-national).
 * 새 브랜드는 id에 범위 꼬리를 붙여 따로 쌓아야 하고, 업종 · 지역 · 언어가 같으면 같은 질문지 · 순위표를 나눠 쓰게 되므로 막아야 한다.
 * 사람이 넣은 사실 · 브랜드 페이지 · 발행 설정만 가져오고, 범위마다 다른 경쟁사 · 시장 범위는 가져오지 않는다. 사실 · 브랜드 페이지는
 * 저장소 설정 · 등록 때 넣은 값에도 있다 — 앱에서 고친 파일만 보면 빠진다. 네이버 블로그 같은 플랫폼 주소는 같은 홈페이지가 아니다
 * (2026-10-21 검토).
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
const readJson = <T>(rel: string): T => JSON.parse(readFileSync(path.join(dir, rel), 'utf-8')) as T
const has = (rel: string) => existsSync(path.join(dir, rel))
const fact = (id: string, claim: string, value: string) => ({ id, type: 'other', claim, value, updatedAt: '2026-10-01' })

try {
  const v = await import('../src/lib/brandVariant')
  const { findTenantByDomain, findTenantByName } = await import('../src/lib/aeo/resolveTarget')
  const reg = await import('../server/tenantRegistry')
  const promote = await import('../server/tenantPromote')
  const { measureAndBake } = await import('../server/measureAndBake')
  const { getIsoWeekString } = await import('../server/dateUtil')
  const { FileResultStore } = await import('../server/store')
  const store = new FileResultStore()
  const week = getIsoWeekString(new Date())

  // 1) id · 홈페이지 · 코호트 — 순수 함수
  const g = { tenantId: 'gunsan', ownedDomains: ['g.example'] }
  const gNational = { tenantId: 'gunsan-national', ownedDomains: ['g.example'] }
  const gLocal = { tenantId: 'gunsan-local', ownedDomains: ['g.example'] }
  ok('id: 지역형 바탕 + 전국형 → -national', v.variantTenantId(g, 'national', [g]) === 'gunsan-national')
  ok('id: 바탕이 변형이면 꼬리를 바꿔 붙인다(-national → -local)', v.variantTenantId(gNational, undefined, [g, gNational]) === 'gunsan-local')
  ok('id: B2B형 → -b2b', v.variantTenantId(gLocal, 'b2b', [g, gLocal]) === 'gunsan-b2b')
  ok('id: 같은 범위의 두 번째 변형은 -2', v.variantTenantId(g, undefined, [g, gLocal]) === 'gunsan-local-2' && v.variantTenantId(gLocal, undefined, [g, gLocal]) === 'gunsan-local-2')
  const seoul = { tenantId: 'seoul-national', ownedDomains: ['seoul-national.example'] }
  ok('id: 도메인에서 온 -national은 떼지 않는다', v.variantTenantId(seoul, undefined, [seoul]) === 'seoul-national-local')
  ok('홈페이지: www · https · 경로 · 포트 차이는 같은 곳', v.sharesSite({ ownedDomains: ['https://www.a.example:8080/x'] }, { ownedDomains: ['A.example'] }))
  ok('홈페이지: 다른 곳', !v.sharesSite({ ownedDomains: ['a.example'] }, { ownedDomains: ['b.example'] }))
  ok('홈페이지: 플랫폼 주소(네이버 블로그)는 같아도 다른 업체', !v.sharesSite({ ownedDomains: ['blog.naver.com'] }, { ownedDomains: ['blog.naver.com'] }))
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
  const blogA = { tenantId: 'blog', ownedDomains: ['blog.naver.com'], industry: '카페', region: '가상시' }
  ok('표시: 네이버 블로그를 함께 쓰는 다른 업체는 형제가 아니다', v.variantTag(blogA, [blogA, { ...blogA, tenantId: 'blog-2' }]) === null)

  // 3) 사이트 진단 — 같은 홈페이지면 지금 고른 브랜드, 더 구체적인 주소의 주인은 그대로
  const summaries = [local, national].map((t) => ({ ...t, brandName: '가상각', aliases: [] }) as unknown as TenantSummary)
  ok('진단: 고른 브랜드가 그 홈페이지면 그 브랜드', findTenantByDomain('https://x.example/a', summaries, summaries[1])?.tenantId === 'x-national')
  ok('진단: 고른 게 없으면 목록 첫 브랜드', findTenantByDomain('x.example', summaries)?.tenantId === 'x')
  const other = { tenantId: 'o', brandName: '다른 곳', aliases: [], ownedDomains: ['o.example'] } as unknown as TenantSummary
  ok('진단: 고른 브랜드가 다른 홈페이지면 주인', findTenantByDomain('m.x.example', [...summaries, other], other)?.tenantId === 'x')
  const shop = { tenantId: 'shop', brandName: '가상 상점', aliases: [], ownedDomains: ['shop.x.example'] } as unknown as TenantSummary
  ok('진단: 하위 주소를 가진 브랜드가 고른 브랜드(상위 주소)를 이긴다', findTenantByDomain('https://shop.x.example/p', [...summaries, shop], summaries[0])?.tenantId === 'shop')
  ok('진단: 상호 입력 — 같은 이름의 범위 변형이면 고른 브랜드', findTenantByName('가상각', summaries, summaries[1])?.tenantId === 'x-national')
  ok('진단: 상호 입력 — 고른 게 다른 브랜드면 첫 변형', findTenantByName('가상각', [...summaries, other], other)?.tenantId === 'x')
  const twinName = { ...other, tenantId: 'o2', brandName: '가상각' } as unknown as TenantSummary
  ok('진단: 상호 입력 — 이름만 같은 다른 홈페이지면 고르지 않는다', findTenantByName('가상각', [summaries[0], twinName]) === null)

  // 4) 서버 — 가짜 브랜드: 고객 vsite(지역형, 사실 · 브랜드 페이지는 설정에만), 같은 홈페이지의 영어 측정 vsite-en,
  //    홈페이지가 같은 경쟁사 vcomp, vsite의 옛 도메인을 함께 쓰는 고객 vold, 네이버 블로그 고객 blog.
  const base = { engines: ['gemini'], questionBankSize: 1, questionBankVersion: 'v3', repeatsPerQuestion: 1, factGraph: [], cohortQuestionBank: 'c1', competitors: [] }
  writeJson('tenants.overlay.json', [
    { ...base, tenantId: 'vsite', brandName: '가상각', aliases: ['가상각', '가상 여행의 모든것'], ownedDomains: ['vsite.example', 'old.vsite.example'],
      industry: '관광정보서비스', region: '가상시', ga4PropertyId: '123456', brandPageUrl: 'https://vsite.example/about',
      factGraph: [fact('f1', '주소', '가상시 가상로 1'), fact('f2', '체크인', '15시')],
      competitors: [{ name: '가상 시청', aliases: ['가상 시청'], domains: ['vcity.example'] }] },
    { ...base, tenantId: 'vsite-en', brandName: '가상각', aliases: ['Gasang-gak'], ownedDomains: ['vsite.example'],
      industry: '관광정보서비스', region: '가상시 (영어 질문)', questionLanguage: 'en' },
    { ...base, tenantId: 'vcomp', brandName: '가상 관광', aliases: ['가상 관광'], ownedDomains: ['vcomp.example'], industry: '관광안내', region: '국내', cohortOnly: true },
    { ...base, tenantId: 'vold', brandName: '가상 옛집', aliases: ['가상 옛집'], ownedDomains: ['old.vsite.example'], industry: '여행사', region: '국내' },
    { ...base, tenantId: 'blog', brandName: '가짜카페A', aliases: ['가짜카페A'], ownedDomains: ['blog.naver.com'], industry: '카페', region: '가상시', ga4PropertyId: '999111' },
    { ...base, tenantId: 'vnat', brandName: '가상전국', aliases: ['가상전국'], ownedDomains: ['vnat.example'], industry: '관광안내', region: '국내', marketScope: 'national' },
  ])
  writeJson('data/vsite/scorecard-history.json', [{ tenantId: 'vsite', brandName: '가상각', industry: '관광정보서비스', region: '가상시', weekOf: '2026-W40',
    questionBankVersion: 'v3', aeoScore: { current: 30 }, mentionRate: 0, brandOwnedCitationRate: 0, cohortRank: { position: 1, totalTenants: 1 } }])
  writeJson('data/vsite/publish-settings.json', { ctaText: '문의하기', photoRights: { confirmedAt: '2026-10-01T00:00:00.000Z' } })
  writeJson('data/vsite/market-scope.json', { marketScope: 'local' })
  writeJson('data/vsite/competitors.json', { competitors: [] })
  // 지운 vsite-b2b — 기록 2주(관광 B2B · 국내)와 앱에서 고친 시장 범위 · 발행 설정이 남아 있다. 같은 코호트의 경쟁사 vca는 지울 때 1/1로 다시 매겨졌다.
  writeJson('tenants.deleted.json', ['vsite-b2b'])
  const card = (tenantId: string, weekOf: string, score: number, position: number, totalTenants: number) => ({ tenantId, brandName: tenantId, industry: '관광 B2B', region: '국내',
    weekOf, questionBankVersion: 'v3', aeoScore: { current: score }, mentionRate: 0, brandOwnedCitationRate: 0, cohortRank: { position, totalTenants } })
  writeJson('data/vsite-b2b/scorecard-history.json', [card('vsite-b2b', '2026-W30', 10, 2, 2), card('vsite-b2b', '2026-W31', 10, 2, 2)])
  writeJson('data/vsite-b2b/market-scope.json', { marketScope: 'b2b', buyer: '옛 구매 담당' })
  writeJson('data/vsite-b2b/publish-settings.json', { ctaText: '지운 브랜드의 옛 문의', blogUrl: 'https://old.example/blog' })
  writeJson('data/vca/scorecard-history.json', [card('vca', '2026-W30', 50, 1, 1), card('vca', '2026-W31', 50, 1, 1)])

  const draftOf = (extra: Record<string, unknown>) =>
    reg.normalizeTenantDraft({ tenantId: 'vsite', brandName: '가상각', ownedDomains: ['www.vsite.example'], engines: ['gemini'], questionBankSize: 1, ...extra })
  const nationalDraft = draftOf({ industry: '관광안내', region: '국내', marketScope: 'national', aliases: ['가상각', '가상각 전국'],
    competitors: [{ name: '가상 관광', domains: ['vcomp.example'] }],
    factGraph: [fact('f1', '주차', '10대'), fact('f2', '체크 인', '16시'), fact('f3', '주소', '등록 화면 주소')] })

  // 4-a) 살피기 — 고객 브랜드와 부딪히면 범위 변형을 연다
  const conflict = await promote.describeTenantConflict(nationalDraft, store)
  ok('살피기: 고객 브랜드 · 같은 홈페이지', conflict?.kind === 'customer' && conflict.sameSite)
  ok('살피기: 새 id vsite-national, 막히지 않음', conflict?.variant?.tenantId === 'vsite-national' && conflict.variant.blocked === null && conflict.variant.twinId === null)
  ok('살피기: 형제 목록에 영어 측정도 보인다(같은 홈페이지 고객)', (conflict?.siblings ?? []).map((s) => s.tenantId).sort().join(',') === 'vsite,vsite-en')

  // 4-b) 같은 코호트면 막는다
  const sameCohortDraft = draftOf({ industry: '관광정보서비스', region: '가상시', marketScope: 'national' })
  const blocked = (await promote.describeTenantConflict(sameCohortDraft, store))?.variant
  ok('막기: 업종 · 지역이 같으면 이유와 함께 막는다(막은 브랜드 = 부딪힌 브랜드 자신, 범위는 달라 같은 설정 아님)',
    Boolean(blocked?.blocked?.includes('vsite')) && blocked?.twinId === 'vsite' && blocked.sameSettings === false)
  const sameAgain = (await promote.describeTenantConflict(draftOf({ industry: '관광정보서비스', region: '가상시' }), store))?.variant
  ok('막기: 범위 · 업종 · 지역이 모두 같으면 같은 설정으로 다시 누른 것', sameAgain?.twinId === 'vsite' && sameAgain.sameSettings === true)
  const natToB2b = (await promote.describeTenantConflict(reg.normalizeTenantDraft({ tenantId: 'vnat', brandName: '가상전국', ownedDomains: ['vnat.example'],
    industry: '관광안내', region: '국내', marketScope: 'b2b', buyer: '여행사' }), store))?.variant
  ok('막기: 전국형 바탕을 같은 업종 B2B형으로 — 같은 설정이 아니고 「국내」 까닭을 보인다',
    natToB2b?.twinId === 'vnat' && natToB2b.sameSettings === false && Boolean(natToB2b.blocked?.includes('「국내」')))
  ok('막기: 등록도 409', await rejects(promote.registerVariant(sameCohortDraft, store, { copyBusinessFiles: true }), 409))
  const twinComp = draftOf({ industry: '관광안내', region: '국내', marketScope: 'national', ownedDomains: ['vsite.example', 'vcomp.example'] })
  ok('막기: 홈페이지를 함께 쓰는 경쟁사와 같은 코호트도 막는다', (await promote.describeTenantConflict(twinComp, store))?.variant?.twinId === 'vcomp')
  const viaOldDomain = draftOf({ industry: '여행사', region: '국내', marketScope: 'national' })
  ok('막기: 바탕 브랜드의 옛 도메인을 함께 쓰는 같은 코호트도 미리 막는다', (await promote.describeTenantConflict(viaOldDomain, store))?.variant?.twinId === 'vold')

  // 4-c) 등록 — 새 id, 별칭 · 홈페이지 · GA4는 물려받고, 사실 · 브랜드 페이지(설정 값) · 발행 설정을 가져온다
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
  ok('가져오기: 사실 · 브랜드 페이지 · 발행 설정', result.copied.join(',') === '사실,브랜드 페이지,발행 설정' && result.copyErrors.length === 0)
  ok('가져오기: 설정에만 있던 브랜드 페이지', created?.brandPageUrl === 'https://vsite.example/about')
  ok('가져오기: 바탕 사실이 먼저, 등록 화면 사실은 겹치지 않는 것만(띄어쓰기 차이도 같은 사실)', created?.factGraph.map((f) => f.value).join(',') === '가상시 가상로 1,15시,10대')
  ok('가져오기: 더한 사실의 id가 바탕 사실과 겹치지 않는다', new Set(created?.factGraph.map((f) => f.id)).size === created?.factGraph.length)
  ok('가져오기: 시장 범위 · 경쟁사 목록은 가져오지 않는다', !has('data/vsite-national/market-scope.json') && !has('data/vsite-national/competitors.json'))
  ok('가져오기: 발행 설정 내용이 같다', readJson<{ ctaText?: string }>('data/vsite-national/publish-settings.json').ctaText === '문의하기')
  ok('기록: 새 브랜드는 0주에서', result.restoredWeeks === 0 && (await store.getScorecardHistory('vsite-national', 99)).length === 0)

  // 4-d) 다시 누르면 — 이제 같은 코호트 형제가 있어 409
  ok('다시 등록: 409', await rejects(promote.registerVariant(nationalDraft, store, { copyBusinessFiles: true }), 409))

  // 4-e) 전국형과 B2B형은 지역이 둘 다 국내 — 업종까지 같으면 막고 그 까닭을 덧붙인다
  const b2bSame = draftOf({ industry: '관광안내', region: '국내', marketScope: 'b2b', buyer: '여행사' })
  ok('막기: 국내 · 같은 업종의 B2B형', Boolean((await promote.describeTenantConflict(b2bSame, store))?.variant?.blocked?.includes('「국내」')))
  const againBlocked = (await promote.describeTenantConflict(nationalDraft, store))?.variant?.blocked ?? ''
  ok('막기: 전국형을 또 전국형으로 — 「국내」 덧붙임 없이 이유만', againBlocked.includes('vsite-national') && !againBlocked.includes('「국내」'))

  // 4-f) 같은 범위의 두 번째 변형 — 막지 않고 -2
  const lodging = draftOf({ industry: '숙박', region: '가상시', aliases: ['가상각'] })
  const plain = await promote.registerVariant(lodging, store, { copyBusinessFiles: false })
  const plainTenant = (await reg.loadRuntimeTenants()).find((t) => t.tenantId === 'vsite-local')
  ok('복사 끔: 지역형 숙박 → vsite-local, 아무것도 가져오지 않는다', plain.tenantId === 'vsite-local' && plain.copied.length === 0 && plainTenant?.factGraph.length === 0 && !plainTenant.brandPageUrl && !has('data/vsite-local/publish-settings.json'))
  const cafe = (await promote.describeTenantConflict(draftOf({ industry: '카페', region: '가상시' }), store))?.variant
  ok('같은 범위 두 번째: vsite-local-2, 막지 않는다', cafe?.tenantId === 'vsite-local-2' && cafe.blocked === null)

  // 4-g) 지운 같은 id — 기록은 되살아난다고 알리고, 남은 설정(시장 범위 · 발행 설정)은 백업으로, 그 코호트 순위는 다시 매긴다.
  //      바탕 브랜드가 앱에서 사실을 고쳤으면 그 값을 가져온다. 의료 업종이면 사진 확인은 넘기지 않는다.
  writeJson('data/vsite/fact-graph.json', [fact('f9', '주소', '가상시 고친로 2')])
  const b2bDraft = draftOf({ industry: '피부과 B2B', region: '국내', marketScope: 'b2b', buyer: '병원 구매 담당' })
  const b2bPlan = await promote.describeTenantConflict(b2bDraft, store)
  ok('지운 id: 되살아날 기록 2주를 알린다', b2bPlan?.variant?.tenantId === 'vsite-b2b' && b2bPlan.variant.restoredWeeks === 2 && b2bPlan.variant.blocked === null)
  const b2b = await promote.registerVariant(b2bDraft, store, { copyBusinessFiles: true })
  ok('지운 id: 남은 시장 범위 · 발행 설정은 백업으로', b2b.setAside.join(',') === '시장 범위,발행 설정' && !has('data/vsite-b2b/market-scope.json'))
  const b2bTenant = (await reg.loadRuntimeTenants()).find((t) => t.tenantId === 'vsite-b2b')
  ok('지운 id: 다시 보인다', b2bTenant?.buyer === '병원 구매 담당')
  const b2bSettings = readJson<{ ctaText?: string; blogUrl?: string; photoRights?: unknown }>('data/vsite-b2b/publish-settings.json')
  ok('지운 id: 발행 설정은 지운 브랜드가 아니라 바탕 브랜드 것', b2bSettings.ctaText === '문의하기' && b2bSettings.blogUrl === undefined)
  ok('의료 업종: 사진 사용 확인은 넘기지 않는다', b2bSettings.photoRights === undefined)
  ok('가져오기: 앱에서 고친 사실 파일이 설정을 이긴다', b2bTenant?.factGraph.map((f) => f.value).join(',') === '가상시 고친로 2')
  const ranks = await Promise.all(['vca', 'vsite-b2b'].map((id) => store.getScorecardHistory(id, 99)))
  ok('지운 id: 되살아난 주의 코호트 순위를 다시 매긴다(vca 1/2 · vsite-b2b 2/2)',
    ranks[0].every((c) => c.cohortRank?.position === 1 && c.cohortRank.totalTenants === 2) &&
      ranks[1].every((c) => c.cohortRank?.position === 2 && c.cohortRank.totalTenants === 2))

  // 4-h) 경쟁사와 부딪히면 범위 변형이 아니라 전환
  const compDraft = reg.normalizeTenantDraft({ tenantId: 'vcomp', brandName: '가상 관광', ownedDomains: ['vcomp.example'], industry: '관광안내', region: '국내' })
  ok('경쟁사와 부딪힘: 범위 변형 없음', (await promote.describeTenantConflict(compDraft, store))?.variant === null)

  // 4-i) 네이버 블로그를 홈페이지로 쓰는 다른 업체 — 범위 변형으로 묶지 않는다(남의 별칭 · GA4 · 사실을 물려받는다)
  const bakery = reg.normalizeTenantDraft({ tenantId: 'blog', brandName: '가짜베이커리B', ownedDomains: ['blog.naver.com'], industry: '베이커리', region: '다른시' })
  const bakeryConflict = await promote.describeTenantConflict(bakery, store)
  ok('플랫폼 주소: 부딪혀도 범위 변형 없음', bakeryConflict?.kind === 'customer' && bakeryConflict.variant === null)
  ok('플랫폼 주소: 등록도 409', await rejects(promote.registerVariant(bakery, store, { copyBusinessFiles: true }), 409))

  // 5) 그냥 등록 — 같은 홈페이지 · 같은 코호트의 고객 브랜드가 다른 id로 있으면 막는다(영어 측정 · 경쟁사 · 플랫폼 주소는 지나간다)
  const twin = reg.normalizeTenantDraft({ tenantId: 'vsite-copy', brandName: '가상각', ownedDomains: ['vsite.example'], industry: '관광안내', region: '국내', marketScope: 'national' })
  ok('그냥 등록: 같은 홈페이지 · 코호트는 막는다', await throwsWith(reg.registerTenant(twin), '이미 존재'))
  const enTwin = reg.normalizeTenantDraft({ tenantId: 'vsite-en2', brandName: '가상각', ownedDomains: ['vsite.example'], industry: '숙박', region: '가상시 (영어 질문)', questionLanguage: 'en' })
  await reg.registerTenant(enTwin)
  ok('그냥 등록: 다른 언어는 지나간다', (await reg.loadRuntimeTenants()).some((t) => t.tenantId === 'vsite-en2'))
  const compTwin = reg.normalizeTenantDraft({ tenantId: 'vsite-comp', brandName: '가상각', ownedDomains: ['vsite.example'], industry: '숙박', region: '가상시', cohortOnly: true })
  await reg.registerTenant(compTwin)
  ok('그냥 등록: 경쟁사(cohortOnly)는 지나간다', (await reg.loadRuntimeTenants()).some((t) => t.tenantId === 'vsite-comp'))
  const blogCafe = reg.normalizeTenantDraft({ tenantId: 'cafe-b', brandName: '가짜카페B', ownedDomains: ['blog.naver.com'], industry: '카페', region: '가상시' })
  await reg.registerTenant(blogCafe)
  ok('그냥 등록: 같은 플랫폼 주소의 같은 코호트 업체는 지나간다', (await reg.loadRuntimeTenants()).some((t) => t.tenantId === 'cafe-b'))

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
