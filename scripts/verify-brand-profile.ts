/**
 * 브랜드 기본 정보(업종 · 지역 · 시장 범위) 고치기(server/brandProfileEditor.ts)를 확인한다.
 * 임시 폴더를 APP_DATA_DIR로 쓰고 가짜 브랜드만 만든다. AI는 부르지 않는다.
 *
 * 왜: 그냥 바꾸면 ① 앱에서 고친 경쟁사 목록이 말없이 꺼지고(지문에 질문지 버전이 들어 있다) ② 옛 코호트로 만든 질문지 때문에
 * 측정이 멈추거나 범위만 바꾼 브랜드가 옛 질문으로 계속 잰다 ③ 이 고객만 재는 경쟁사가 옛 코호트에 남는다. 2026-10-21 군산각을
 * 지역형으로 바꿀 때 설정 파일을 손으로 고친 일을 앱에서 하게 한다.
 *
 *   npx tsx scripts/verify-brand-profile.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'verify-brand-profile-'))
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
const readJson = <T>(rel: string): T => JSON.parse(readFileSync(path.join(dir, rel), 'utf-8')) as T

try {
  const reg = await import('../server/tenantRegistry')
  const editor = await import('../server/brandProfileEditor')
  const comp = await import('../server/tenantCompetitorsStore')
  const tracker = await import('../server/measureTracker')
  const { planCohortTargets } = await import('../server/cohortPlan')
  const { reusableThisWeek } = await import('../server/measureAndBake')
  const { getCohortTrend } = await import('../server/cohortTrend')
  const { getIsoWeekString } = await import('../server/dateUtil')
  const { FileResultStore } = await import('../server/store')
  const store = new FileResultStore()
  const week = getIsoWeekString(new Date())

  // 가짜 코호트(펜션 · 가상시): 고객 pcust가 경쟁사 ptwo(이 고객만 잰다)와 pshare(고객 pother도 잰다)를 함께 잰다.
  // 관광안내 · 국내에는 전국형 고객 pnat(공통 질문지 c3)이 있다. psib은 pcust와 홈페이지가 같은 캠핑장 브랜드.
  const base = { engines: ['gemini'], questionBankSize: 1, questionBankVersion: 'v3', repeatsPerQuestion: 1, factGraph: [], cohortQuestionBank: 'c1' }
  const line = (name: string, domain: string) => ({ name, aliases: [name], domains: [domain] })
  const pcustEntry = { ...base, tenantId: 'pcust', brandName: '가상 펜션', aliases: ['가상 펜션'], ownedDomains: ['pcust.example'], industry: '펜션', region: '가상시',
    ga4PropertyId: '777', competitors: [line('가상 둘', 'ptwo.example'), line('공유 셋', 'pshare.example')] }
  writeJson('tenants.overlay.json', [
    pcustEntry,
    { ...base, tenantId: 'ptwo', brandName: '가상 둘', aliases: ['가상 둘'], ownedDomains: ['ptwo.example'], industry: '펜션', region: '가상시', competitors: [], cohortOnly: true },
    { ...base, tenantId: 'pshare', brandName: '공유 셋', aliases: ['공유 셋'], ownedDomains: ['pshare.example'], industry: '펜션', region: '가상시', competitors: [], cohortOnly: true },
    { ...base, tenantId: 'pother', brandName: '다른 민박', aliases: ['다른 민박'], ownedDomains: ['pother.example'], industry: '펜션', region: '가상시', competitors: [line('공유 셋', 'pshare.example')] },
    { ...base, tenantId: 'pnat', brandName: '가상 전국', aliases: ['가상 전국'], ownedDomains: ['pnat.example'], industry: '관광안내', region: '국내', marketScope: 'national', cohortQuestionBank: 'c3', competitors: [] },
    { ...base, tenantId: 'psib', brandName: '가상 펜션', aliases: ['가상 펜션'], ownedDomains: ['pcust.example'], industry: '캠핑장', region: '가상시', competitors: [] },
    { ...base, tenantId: 'peng', brandName: 'Gasang', aliases: ['Gasang'], ownedDomains: ['peng.example'], industry: '펜션', region: '가상시 (영어 질문)', questionLanguage: 'en', competitors: [] },
    // 경쟁사를 재지 않는 고객(autoCohort 끔)이 ptwo를 목록에 두었다 — ptwo는 여전히 pcust만 재는 곳이다.
    { ...base, tenantId: 'pauto', brandName: '안 재는 고객', aliases: ['안 재는 고객'], ownedDomains: ['pauto.example'], industry: '펜션', region: '가상시', autoCohort: false, competitors: [line('가상 둘', 'ptwo.example')] },
    // pcust를 경쟁사로 재는 고객.
    { ...base, tenantId: 'pref', brandName: '참조 민박', aliases: ['참조 민박'], ownedDomains: ['pref.example'], industry: '펜션', region: '가상시', competitors: [line('가상 펜션', 'pcust.example')] },
    // 아무도 재지 않는 경쟁사 측정 브랜드(지운 고객이 남김) — 야영장 · 국내 · 전국형 · c4.
    { ...base, tenantId: 'porph', brandName: '남은 곳', aliases: ['남은 곳'], ownedDomains: ['porph.example'], industry: '야영장', region: '국내', marketScope: 'national', cohortQuestionBank: 'c4', competitors: [], cohortOnly: true },
    // 칸(5곳)을 넘어 대기 중인 경쟁사: pbig의 6번째 pwait(이 고객만), 5번째 pwshare(pother2의 대기 줄도 가리킴).
    { ...base, tenantId: 'pbig', brandName: '큰 캠핑', aliases: ['큰 캠핑'], ownedDomains: ['pbig.example'], industry: '캠핑', region: '가상시',
      competitors: [line('가1', 'a1.example'), line('가2', 'a2.example'), line('가3', 'a3.example'), line('가4', 'a4.example'), line('함께 대기', 'pwshare.example'), line('대기 여섯', 'pwait.example')] },
    { ...base, tenantId: 'pother2', brandName: '옆 캠핑', aliases: ['옆 캠핑'], ownedDomains: ['pother2.example'], industry: '캠핑', region: '가상시',
      competitors: [line('나1', 'b1.example'), line('나2', 'b2.example'), line('나3', 'b3.example'), line('나4', 'b4.example'), line('나5', 'b5.example'), line('함께 대기', 'pwshare.example')] },
    { ...base, tenantId: 'pwait', brandName: '대기 여섯', aliases: ['대기 여섯'], ownedDomains: ['pwait.example'], industry: '캠핑', region: '가상시', competitors: [], cohortOnly: true },
    { ...base, tenantId: 'pwshare', brandName: '함께 대기', aliases: ['함께 대기'], ownedDomains: ['pwshare.example'], industry: '캠핑', region: '가상시', competitors: [], cohortOnly: true },
    // 시장 범위만 따로 B2B로 정해 지역(가상구)이 남은 고객.
    { ...base, tenantId: 'pkx', brandName: '가상 송출', aliases: ['가상 송출'], ownedDomains: ['pkx.example'], industry: '방송송출', region: '가상구', competitors: [] },
  ])
  writeJson('data/pkx/market-scope.json', { marketScope: 'b2b', buyer: '가상 구매' })
  // 질문지 v3 · v5가 있고, 경쟁사 편집이 v7을 예약했다(다시 만들기 대기) — 다음 번호는 v8이다(빈 v4 · v6을 채우지 않는다).
  writeJson('data/pcust/question-bank/v3.json', { version: 'v3', questions: [] })
  writeJson('data/pcust/question-bank/v5.json', { version: 'v5', questions: [] })
  const oldFp = comp.baseFingerprint(pcustEntry as never)
  const edited = [line('가상 둘', 'ptwo.example'), line('공유 셋', 'pshare.example'), line('추가 넷', 'pfour.example')]
  writeJson('data/pcust/competitors.json', {
    current: { competitors: edited, base: oldFp, questionBank: { version: 'v7', size: 1, regenerate: { from: 'v3', base: oldFp } } },
    lastSave: { savedAt: '2026-10-20T00:00:00.000Z', before: { competitors: pcustEntry.competitors, base: oldFp, questionBank: { version: 'v3', size: 1 } }, summary: '추가 넷 추가' },
    measured: { at: '2026-10-19T00:00:00.000Z', listHash: comp.listHash(pcustEntry.competitors as never), bankVersion: 'v3', repoBase: oldFp },
    updatedAt: '2026-10-20T00:00:00.000Z',
  })
  writeJson('data/pcust/market-scope.json', { marketScope: 'local' })
  const card = (tenantId: string, industry: string, region: string, questionBankVersion: string, weekOf = week, score = 30) => ({
    tenantId, brandName: tenantId, industry, region, weekOf, questionBankVersion, aeoScore: { current: score }, mentionRate: 0, brandOwnedCitationRate: 0,
    cohortRank: { position: 1, totalTenants: 2 }, judgeEngine: 'mock', enginesUsed: ['gemini'],
  })
  writeJson('data/pcust/scorecard-history.json', [card('pcust', '펜션', '가상시', 'v3')])
  writeJson('data/ptwo/scorecard-history.json', [card('ptwo', '펜션', '가상시', 'v3')])
  writeJson('data/pother/scorecard-history.json', [card('pother', '펜션', '가상시', 'v3', week, 50)])

  // 1) 처음 상태
  const state = await editor.describeProfileEditor('pcust')
  ok('상태: 앱에서 등록한 고객 브랜드는 고칠 수 있다', state.editable && state.reason === null && state.industry === '펜션' && state.marketScope === 'local')
  const two = state.competitors.find((c) => c.tenantId === 'ptwo')
  const share = state.competitors.find((c) => c.tenantId === 'pshare')
  ok('상태: 이 고객만 재는 경쟁사는 함께 옮김(기본 켬)', two?.movable === true && two.defaultMove === true)
  ok('상태: 다른 고객도 재는 경쟁사는 옮기지 않음(그 고객 이름)', share?.movable === false && Boolean(share.reason?.includes('다른 민박')))
  ok('상태: 자동 완성 업종 · 지역(국내 · 영어 꼬리표 제외)', state.industries.includes('펜션') && state.regions.includes('가상시') && !state.regions.includes('국내') && !state.regions.some((r) => r.includes('영어')))
  ok('상태: 영어 질문 측정 브랜드는 막음', (await editor.describeProfileEditor('peng')).editable === false)
  ok('상태: 저장소 설정 브랜드는 막음', (await editor.describeProfileEditor('web4ai')).reason?.includes('저장소') === true)
  ok('상태: 경쟁사 측정 브랜드 · 없는 브랜드는 404', (await rejects(editor.describeProfileEditor('ptwo'), 404)) && (await rejects(editor.describeProfileEditor('nope'), 404)))
  const big = await editor.describeProfileEditor('pbig')
  ok('상태: 칸을 넘어 대기 중인 경쟁사도 함께 옮길 수 있다', big.competitors.some((c) => c.tenantId === 'pwait' && c.movable))
  ok('상태: 다른 고객의 대기 줄이 가리키는 경쟁사는 공유', big.competitors.some((c) => c.tenantId === 'pwshare' && !c.movable && Boolean(c.reason?.includes('옆 캠핑'))))

  // 2) 미리 계산
  const input = (extra: Record<string, unknown>) => ({ industry: '펜션', region: '가상시', marketScope: 'local', buyer: '', move: [], ...extra })
  const same = await editor.planProfileEdit('pcust', input({}), store)
  ok('계획: 그대로면 바뀐 내용 없음', same.unchanged && same.errors.length === 0 && same.bank.to === same.bank.from)
  writeJson('cohort-banks/숙박__가상시/c1.json', { key: '숙박__가상시', version: 'c1', questions: [] })
  const lodging = await editor.planProfileEdit('pcust', input({ industry: '숙박', move: ['ptwo'] }), store)
  ok('계획: 질문지는 쓰인 번호 중 가장 큰 것 + 1(v3 · v5 · 예약 v7 → v8)', lodging.bank.from === 'v7' && lodging.bank.to === 'v8')
  ok('계획: 새 코호트에 다른 브랜드가 만든 공통 질문지 c1이 있으면 c2', lodging.cohortBank.to === 'c2')
  ok('계획: 함께 옮기는 경쟁사', lodging.moving.map((m) => m.tenantId).join(',') === 'ptwo' && lodging.errors.length === 0)
  ok('계획: 이번 주에 잰 카드를 새 코호트로 바꾼다고 알림', lodging.thisWeek.includes('가상 펜션') && lodging.thisWeek.includes('가상 둘'))
  ok('계획: 옮기지 않은 경쟁사는 업종이 달라 측정 안 됨', lodging.notes.some((n) => n.startsWith('공유 셋')))
  const glamping = await editor.planProfileEdit('pcust', input({ industry: '글램핑' }), store)
  ok('계획: 새 코호트에 공통 질문지가 없으면 지금 버전(c1)', glamping.cohortBank.to === 'c1')
  const national = await editor.planProfileEdit('pcust', input({ industry: '관광안내', marketScope: 'national', region: '국내' }), store)
  ok('계획: 전국형은 지역 「국내」, 구성원의 공통 질문지(c3)를 따른다', national.errors.length === 0 && national.to.region === '국내' && national.cohortBank.to === 'c3' && national.cohortBank.members.includes('가상 전국'))
  ok('계획: 지역형에서 전국형으로 바꾸며 다른 지역을 보내면 막는다', (await editor.planProfileEdit('pcust', input({ industry: '관광안내', marketScope: 'national', region: '아무거나' }), store)).errors.some((e) => e.includes('국내')))
  const b2b = await editor.planProfileEdit('pcust', input({ industry: '관광안내', marketScope: 'b2b', region: '국내', buyer: '여행사' }), store)
  ok('계획: 같은 코호트에 범위가 다른 브랜드가 있으면 막는다', b2b.errors.some((e) => e.includes('범위가 다른')))
  const scopeOnly = await editor.planProfileEdit('pcust', input({ marketScope: 'b2b', buyer: '가상 구매', region: '' }), store)
  ok('계획: 지역형 → B2B형은 지역이 국내로 바뀌어 새 코호트', scopeOnly.to.region === '국내' && scopeOnly.to.buyer === '가상 구매')
  ok('계획: 함께 재는 다른 고객의 경쟁사는 옮길 수 없다', (await editor.planProfileEdit('pcust', input({ industry: '숙박', move: ['pshare'] }), store)).errors.some((e) => e.includes('옮길 수 없어요')))
  ok('계획: 같은 홈페이지의 다른 브랜드와 같은 코호트면 막는다', (await editor.planProfileEdit('pcust', input({ industry: '캠핑장' }), store)).errors.some((e) => e.includes('psib')))
  ok('계획: 지역형인데 지역이 비거나 「국내」면 막는다', (await editor.planProfileEdit('pcust', input({ region: '' }), store)).errors.length > 0 && (await editor.planProfileEdit('pcust', input({ region: '국내' }), store)).errors.length > 0)
  ok('계획: 모양이 틀린 입력은 400', await rejects(editor.planProfileEdit('pcust', { industry: 3 }, store), 400))
  writeJson('measure-requests.json', [{ tenant: pcustEntry, requestedAt: '2026-10-21T00:00:00.000Z' }])
  ok('계획: 측정 대기열에 있으면 막는다', (await editor.planProfileEdit('pcust', input({ industry: '숙박' }), store)).errors.some((e) => e.includes('대기열')))
  writeJson('measure-requests.json', [])
  ok('계획: 이 브랜드를 경쟁사로 재는 고객에게 생길 일을 알린다', lodging.notes.some((n) => n.startsWith('참조 민박') && n.includes('업종이 달라져')))
  const camp = await editor.planProfileEdit('pcust', input({ industry: '야영장', marketScope: 'b2b', region: '국내', buyer: '캠핑 운영사' }), store)
  ok('계획: 아무도 재지 않는 경쟁사 측정 브랜드는 구성원이 아니다(막지 않고 그 질문지도 따르지 않는다)', camp.errors.length === 0 && camp.cohortBank.to !== 'c4' && camp.cohortBank.members.length === 0)
  const kx = await editor.describeProfileEditor('pkx')
  const kxInput = (extra: Record<string, unknown>) => ({ industry: '방송송출', region: '가상구', marketScope: 'b2b', buyer: '가상 구매', move: [], ...extra })
  ok('지역 남은 B2B: 그대로면 바뀐 내용 없음', kx.marketScope === 'b2b' && kx.region === '가상구' && (await editor.planProfileEdit('pkx', kxInput({}), store)).unchanged)
  const kxBuyer = await editor.planProfileEdit('pkx', kxInput({ buyer: '다른 구매' }), store)
  ok('지역 남은 B2B: 구매자만 바꾸면 지역은 그대로', kxBuyer.errors.length === 0 && kxBuyer.to.region === '가상구')
  ok('지역 남은 B2B: 다른 지역으로는 못 옮긴다', (await editor.planProfileEdit('pkx', kxInput({ region: '다른구' }), store)).errors.some((e) => e.includes('국내')))
  ok('지역 남은 B2B: 「국내」로는 옮길 수 있다', (await editor.planProfileEdit('pkx', kxInput({ region: '국내' }), store)).to.region === '국내')

  // 3) 저장 — 미리보기 열쇠 · 측정 중 · 그대로
  ok('저장: 미리보기와 다르면 409', await rejects(editor.saveProfileEdit('pcust', input({ industry: '숙박', move: ['ptwo'] }), 'stale', store), 409))
  tracker.beginMeasureRun()
  ok('저장: 측정 중이면 409', await rejects(editor.saveProfileEdit('pcust', input({ industry: '숙박', move: ['ptwo'] }), lodging.key, store), 409))
  tracker.endMeasureRun()
  ok('저장: 바뀐 내용이 없으면 400', await rejects(editor.saveProfileEdit('pcust', input({}), same.key, store), 400))
  const saved = await editor.saveProfileEdit('pcust', input({ industry: '숙박', move: ['ptwo'] }), lodging.key, store)
  ok('저장: 결과', saved.questionBankVersion === 'v8' && saved.moved.join(',') === '가상 둘')

  const overlay = readJson<Record<string, unknown>[]>('tenants.overlay.json')
  const entry = overlay.find((t) => t.tenantId === 'pcust') as Record<string, unknown>
  ok('오버레이: 업종 · 질문지 · 공통 질문지만 바뀌고 GA4 · 경쟁사 줄은 그대로', entry.industry === '숙박' && entry.questionBankVersion === 'v8' && entry.cohortQuestionBank === 'c2' &&
    entry.ga4PropertyId === '777' && (entry.competitors as unknown[]).length === 2)
  const runtime = await reg.loadRuntimeTenants()
  const pcust = runtime.find((t) => t.tenantId === 'pcust')!
  ok('런타임: 앱에서 고친 경쟁사 목록이 계속 쓰인다(가장 중요)', pcust.competitors.map((c) => c.name).join(',') === '가상 둘,공유 셋,추가 넷')
  ok('런타임: 질문지는 새 번호(예약된 v7로 되돌아가지 않음)', pcust.questionBankVersion === 'v8' && pcust.industry === '숙박')
  const file = readJson<{ current: { base: string; questionBank?: unknown }; lastSave: { before: { base: string; questionBank?: unknown } }; measured: { repoBase: string; bankVersion: string } }>('data/pcust/competitors.json')
  const newFp = comp.baseFingerprint(entry as never)
  ok('경쟁사 목록 파일: 지문을 새로 적고 질문지 값은 버린다', file.current.base === newFp && file.current.questionBank === undefined)
  ok('경쟁사 목록 파일: 되돌리기용 이전 목록도 같은 지문', file.lastSave.before.base === newFp && file.lastSave.before.questionBank === undefined)
  ok('경쟁사 목록 파일: 측정 기록은 그대로(거짓 「경쟁사 바뀜」 없음)', file.measured.repoBase === oldFp && file.measured.bankVersion === 'v3')
  const ptwo = runtime.find((t) => t.tenantId === 'ptwo')!
  ok('함께 옮긴 경쟁사: 새 업종 · 같은 질문지 이름', ptwo.industry === '숙박' && ptwo.questionBankVersion === 'v8' && ptwo.cohortQuestionBank === 'c2')
  ok('옮기지 않은 경쟁사는 그대로', runtime.find((t) => t.tenantId === 'pshare')?.industry === '펜션')
  const entries = planCohortTargets(pcust, runtime).entries
  ok('새 측정 계획: 옮긴 경쟁사는 함께 잰다', entries.some((e) => e.name === '가상 둘' && e.status === 'measured' && e.targetTenantId === 'ptwo' && !e.otherRegion))
  ok('새 측정 계획: 옮기지 않은 공유 경쟁사는 업종 충돌', entries.some((e) => e.name === '공유 셋' && e.status === 'collision'))
  const backups = readdirSync(path.join(dir, 'data/pcust')).filter((f) => f.startsWith('before-profile-'))
  ok('백업: 옛 오버레이 항목 · 경쟁사 목록 · 시장 범위', backups.length === 1 && ['overlay-entry.json', 'competitors.json', 'market-scope.json'].every((f) => existsSync(path.join(dir, 'data/pcust', backups[0]!, f))))
  ok('백업: 함께 옮긴 경쟁사도', readdirSync(path.join(dir, 'data/ptwo')).some((f) => f.startsWith('before-profile-')))

  // 4) 브랜드 현황 · 이번 주 재사용 · 코호트 추세
  const last = (await store.getScorecardHistory('pcust', 99)).at(-1)
  ok('현황: 다시 재기 전에는 「기본 정보 바뀜 · 다음 측정 대기」', (await editor.pendingProfileEdit(pcust, last))?.summary.includes('업종 펜션 → 숙박') === true)
  ok('현황: 새 설정으로 잰 카드가 생기면 끝', (await editor.pendingProfileEdit(pcust, card('pcust', '숙박', '가상시', 'v8') as never)) === null)
  ok('현황: 표식 없는 브랜드는 없음', (await editor.pendingProfileEdit({ tenantId: 'pother', industry: '펜션', region: '가상시', questionBankVersion: 'v3' }, undefined)) === null)
  ok('현황: 지운 뒤 같은 id로 다시 등록해 설정이 다르면 남은 표식은 쓰지 않는다', (await editor.pendingProfileEdit({ tenantId: 'pcust', industry: '펜션', region: '가상시', questionBankVersion: 'v8' }, undefined)) === null)
  ok('현황: 같은 업종 · 지역으로 다시 등록해 질문지가 표식보다 이르면 쓰지 않는다', (await editor.pendingProfileEdit({ tenantId: 'pcust', industry: '숙박', region: '가상시', questionBankVersion: 'v3' }, undefined)) === null)
  const reuse = await reusableThisWeek(ptwo, store, week)
  ok('이번 주 재사용: 옛 코호트로 잰 카드는 다시 잰다', !reuse.ok && Boolean(reuse.reason?.includes('코호트 다름')))
  const trend = await getCohortTrend(store, pcust)
  ok('코호트 추세: 지난 주는 그 주 카드의 코호트(펜션)와 비교', trend.length === 1 && trend[0]!.peerCount === 2 && trend[0]!.avg === 40)

  // 5) 범위 바꾸기 — 시장 범위 파일도 같은 값으로, 구성원(전국형 pnat)의 공통 질문지를 따른다
  const toNational = await editor.planProfileEdit('pcust', input({ industry: '관광안내', marketScope: 'national', region: '국내', move: ['ptwo'] }), store)
  ok('범위 계획: 오류 없음 · 다음 번호 v9', toNational.errors.length === 0 && toNational.bank.to === 'v9')
  await editor.saveProfileEdit('pcust', input({ industry: '관광안내', marketScope: 'national', region: '국내', move: ['ptwo'] }), toNational.key, store)
  const scopeFile = readJson<{ marketScope: string }>('data/pcust/market-scope.json')
  const after = (await reg.loadRuntimeTenants()).find((t) => t.tenantId === 'pcust')!
  ok('범위 저장: 시장 범위 파일 · 런타임이 전국형', scopeFile.marketScope === 'national' && after.marketScope === 'national' && after.region === '국내' && after.cohortQuestionBank === 'c3')
  ok('범위 저장: 경쟁사 목록은 여전히 쓰인다', after.competitors.length === 3)

  // 6) 공통 질문지를 따르는 등록 — 같은 코호트 고객이 c3을 쓰면 새로 등록하는 브랜드도 c3(기본값 c1이 아니라)
  await reg.registerTenant(reg.normalizeTenantDraft({ tenantId: 'pnew', brandName: '새 전국', ownedDomains: ['pnew.example'], industry: '관광안내', region: '국내', marketScope: 'national' }))
  const pnew = readJson<Record<string, unknown>[]>('tenants.overlay.json').find((t) => t.tenantId === 'pnew')
  ok('등록: 같은 코호트 고객의 공통 질문지를 따른다', pnew?.cohortQuestionBank === 'c3')
  // 지운 id에 옛 공통 질문지로 만든 v3이 남아 있으면 — 공통 질문지를 따라 바꿀 때 질문지 번호도 올린다(첫 측정이 멈추지 않게).
  writeJson('data/pold/question-bank/v3.json', { version: 'v3', cohortBank: { key: '관광안내__국내', version: 'c1' }, questions: [] })
  await reg.registerTenant(reg.normalizeTenantDraft({ tenantId: 'pold', brandName: '옛 전국', ownedDomains: ['pold.example'], industry: '관광안내', region: '국내', marketScope: 'national' }))
  const pold = readJson<Record<string, unknown>[]>('tenants.overlay.json').find((t) => t.tenantId === 'pold')
  ok('등록: 공통 질문지를 바꾸면 남은 질문지 번호를 피한다(v3 → v4)', pold?.cohortQuestionBank === 'c3' && pold.questionBankVersion === 'v4')

  // 7) 업종을 바꿨다 되돌리기 — 그사이 아무도 재지 않던 경쟁사 측정 브랜드를 다시 재게 되면 그 공통 질문지를 따른다
  writeJson('cohort-banks/글램핑__가상시/c1.json', { key: '글램핑__가상시', version: 'c1', questions: [] })
  const prevOverlay = readJson<Record<string, unknown>[]>('tenants.overlay.json')
  writeJson('tenants.overlay.json', [
    ...prevOverlay,
    { ...base, tenantId: 'pglamp', brandName: '가상 글램핑', aliases: ['가상 글램핑'], ownedDomains: ['pglamp.example'], industry: '카라반', region: '가상시', competitors: [line('글램핑 옆', 'pgside.example')] },
    { ...base, tenantId: 'pgside', brandName: '글램핑 옆', aliases: ['글램핑 옆'], ownedDomains: ['pgside.example'], industry: '글램핑', region: '가상시', competitors: [], cohortOnly: true },
  ])
  const back = await editor.planProfileEdit('pglamp', { industry: '글램핑', region: '가상시', marketScope: 'local', buyer: '', move: [] }, store)
  ok('계획: 바꾼 뒤 다시 재게 되는 경쟁사 측정 브랜드는 구성원(그 공통 질문지 c1을 따른다)', back.errors.length === 0 && back.cohortBank.to === 'c1' && back.cohortBank.members.includes('글램핑 옆'))

  // 8) 상호 · 별칭(상용화 UI 3차 U7, 2026-10-26) — 상호 칸에 주소를 넣어 등록한 브랜드(실측 dona)를 앱에서 고친다. 상호를 바꾸면 이름을
  //    넣은 질문도 새로 만들어야 해 질문지를 올리고, 별칭만 바꾸면 질문지는 그대로다. 경쟁사 측정 브랜드의 이름은 바꾸지 않는다.
  const glampState = await editor.describeProfileEditor('pglamp')
  ok('상호: 처음 상태에 별칭', glampState.aliases.join(',') === '가상 글램핑')
  const same8 = { industry: '카라반', region: '가상시', marketScope: 'local', buyer: '', move: ['pgside'] }
  ok('상호: 주소면 막는다', (await editor.planProfileEdit('pglamp', { ...same8, brandName: 'https://www.pglamp.example/' }, store)).errors.some((e) => e.includes('주소')))
  ok('상호: 비우면 막는다', (await editor.planProfileEdit('pglamp', { ...same8, brandName: '' }, store)).errors.some((e) => e.includes('상호')))
  ok('별칭: 주소면 막는다', (await editor.planProfileEdit('pglamp', { ...same8, aliases: ['www.pglamp.example'] }, store)).errors.some((e) => e.includes('별칭')))
  ok('상호: 도메인 모양이면 알리기만', (await editor.planProfileEdit('pglamp', { ...same8, brandName: 'pglamp.com' }, store)).notes.some((n) => n.includes('도메인 모양')))
  const rename = await editor.planProfileEdit('pglamp', { ...same8, brandName: '새 글램핑', aliases: ['새 글램핑', '글램핑 새'] }, store)
  ok('상호 계획: 오류 없음 · 질문지를 올린다', rename.errors.length === 0 && !rename.unchanged && rename.bank.to !== rename.bank.from)
  ok('상호 계획: 코호트가 그대로라 함께 옮기는 경쟁사가 없다(보낸 목록은 쓰지 않음)', rename.moving.length === 0 && rename.to.industry === '카라반')
  ok('상호 계획: 요약 · 안내(조사 「으로」)', rename.summary.includes('상호 가상 글램핑 → 새 글램핑') && rename.notes.some((n) => n.startsWith('상호를 「새 글램핑」으로 바꿉니다')))
  const aliasOnly = await editor.planProfileEdit('pglamp', { ...same8, aliases: ['가상 글램핑', '글램핑 가상'] }, store)
  ok('별칭만: 질문지는 그대로 · 언급 판정이 달라진다고 알림', aliasOnly.errors.length === 0 && !aliasOnly.unchanged && aliasOnly.bank.to === aliasOnly.bank.from && aliasOnly.notes.some((n) => n.includes('언급 판정')))
  await editor.saveProfileEdit('pglamp', { ...same8, brandName: '새 글램핑', aliases: ['새 글램핑', '글램핑 새'] }, rename.key, store)
  const renamedOverlay = readJson<Record<string, unknown>[]>('tenants.overlay.json')
  const renamed = renamedOverlay.find((t) => t.tenantId === 'pglamp')!
  ok('상호 저장: 오버레이 상호 · 별칭 · 질문지', renamed.brandName === '새 글램핑' && (renamed.aliases as string[]).join(',') === '새 글램핑,글램핑 새' && renamed.questionBankVersion === rename.bank.to)
  ok('상호 저장: 경쟁사 측정 브랜드의 이름은 그대로', renamedOverlay.find((t) => t.tenantId === 'pgside')?.brandName === '글램핑 옆')
  ok('상호 저장: 런타임에도 새 이름', (await reg.loadRuntimeTenants()).find((t) => t.tenantId === 'pglamp')?.brandName === '새 글램핑')

  // 9) 1-D 검토 회귀 — 경쟁사 편집이 만든 질문지(derivedFrom)를 쓰는 브랜드의 별칭만 바꿔도 그 질문지로 계속 잰다. 예전엔 런타임 질문지
  //    번호를 오버레이에 적고 경쟁사 목록 파일의 질문지 값을 버려, 다음 측정이 「저장소 설정이 그 뒤에 바뀌었습니다」로 멈췄다.
  const pderEntry = { ...base, tenantId: 'pder', brandName: '파생 고객', aliases: ['파생 고객'], ownedDomains: ['pder.example'], industry: '민박', region: '가상읍', questionBankVersion: 'v4', competitors: [line('파생 경쟁', 'pderc.example')] }
  const pnameEntry = { ...base, tenantId: 'pname', brandName: '이름 고객', aliases: ['이름 고객'], ownedDomains: ['pname.example'], industry: '게스트하우스', region: '가상동', competitors: [] }
  const pnameRef = { ...base, tenantId: 'pnref', brandName: '이름 참조', aliases: ['이름 참조'], ownedDomains: ['pnref.example'], industry: '게스트하우스', region: '가상동', competitors: [line('이름 고객', 'pname.example')] }
  writeJson('tenants.overlay.json', [...readJson<Record<string, unknown>[]>('tenants.overlay.json'), pderEntry, pnameEntry, pnameRef])
  const derFp = comp.baseFingerprint(pderEntry as never)
  writeJson('data/pder/competitors.json', {
    current: { competitors: pderEntry.competitors, base: derFp, questionBank: { version: 'v5', size: 1 } },
    lastSave: null,
    measured: null,
    updatedAt: '2026-10-25T00:00:00.000Z',
  })
  writeJson('data/pder/question-bank/v5.json', { version: 'v5', derivedFrom: { base: derFp, from: 'v4' }, questions: [] })
  ok('파생 질문지: 런타임은 경쟁사 편집의 v5', (await reg.loadRuntimeTenants()).find((t) => t.tenantId === 'pder')?.questionBankVersion === 'v5')
  const derInput = { industry: '민박', region: '가상읍', marketScope: 'local', buyer: '', move: [], aliases: ['파생 고객', '파생고객'] }
  const derPlan = await editor.planProfileEdit('pder', derInput, store)
  ok('파생 질문지: 별칭만 바꾸는 계획은 질문지 그대로', derPlan.errors.length === 0 && derPlan.bank.to === derPlan.bank.from)
  await editor.saveProfileEdit('pder', derInput, derPlan.key, store)
  const derEntry = readJson<Record<string, unknown>[]>('tenants.overlay.json').find((t) => t.tenantId === 'pder')!
  ok('파생 질문지: 오버레이는 별칭만 바뀌고 질문지 번호(v4) · 지문은 그대로', derEntry.questionBankVersion === 'v4' && (derEntry.aliases as string[]).join(',') === '파생 고객,파생고객' && comp.baseFingerprint(derEntry as never) === derFp)
  ok('파생 질문지: 경쟁사 목록 파일의 질문지 값(v5)을 지킨다', readJson<{ current: { questionBank?: { version: string } } }>('data/pder/competitors.json').current.questionBank?.version === 'v5')
  ok('파생 질문지: 런타임은 여전히 v5', (await reg.loadRuntimeTenants()).find((t) => t.tenantId === 'pder')?.questionBankVersion === 'v5')
  ok('별칭만: 「다음 측정 대기」 표식을 남기지 않는다', !existsSync(path.join(dir, 'data/pder/profile-edit.json')))
  // 자기 경쟁사 이름으로 바꾸면 막는다(판정에 같은 이름이 둘 — 점유율이 합쳐진다)
  ok('상호: 자기 경쟁사 이름이면 막는다', (await editor.planProfileEdit('pder', { ...derInput, brandName: '파생 경쟁' }, store)).errors.some((e) => e.includes('경쟁사 목록')))
  ok('별칭: 자기 경쟁사 이름(공백 무시)이면 막는다', (await editor.planProfileEdit('pder', { ...derInput, aliases: ['파생경쟁'] }, store)).errors.some((e) => e.includes('경쟁사 목록')))
  // 상호를 바꾸면 이 브랜드를 경쟁사 목록에 옛 이름으로 적은 다른 고객을 알린다
  const nameRefPlan = await editor.planProfileEdit('pname', { industry: '게스트하우스', region: '가상동', marketScope: 'local', buyer: '', move: [], brandName: '새 이름 고객' }, store)
  ok('상호: 옛 이름으로 적어 둔 다른 고객을 알린다', nameRefPlan.notes.some((n) => n.startsWith('이름 참조') && n.includes('옛 이름')))
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
