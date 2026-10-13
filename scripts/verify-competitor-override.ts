/**
 * 앱에서 고친 경쟁사 목록(data/<tenant>/competitors.json)의 정리 규칙과 병합 규칙을 확인한다. AI는 부르지 않는다.
 * 임시 폴더를 APP_DATA_DIR로 쓴다 — 사용자 폴더·저장소 data/는 건드리지 않는다.
 *
 * 왜: 베이스 설정이 이기는 병합 규칙 탓에 스테이,머뭄처럼 저장소 설정에 든 브랜드는 경쟁사를 바꾸려면 릴리스가
 * 필요했다. 이 파일이 베이스를 이겨야 하고, 반대로 릴리스로 베이스가 바뀐 뒤에는 옛 파일이 새 베이스를 가리면 안 된다.
 *
 *   npx tsx scripts/verify-competitor-override.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'verify-competitor-override-'))
process.env.APP_DATA_DIR = dir
process.env.BLOB_READ_WRITE_TOKEN = ''
process.env.BLOB_STORE_ID = ''

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])
const throws = (fn: () => unknown, needle: string) => {
  try {
    fn()
    return false
  } catch (err) {
    return err instanceof Error && err.message.includes(needle)
  }
}

try {
  const store = await import('../server/tenantCompetitorsStore')
  const reg = await import('../server/tenantRegistry')
  const owner = reg.normalizeTenantDraft({
    tenantId: 'cust',
    brandName: '가상,펜션',
    ownedDomains: ['cust.example'],
    industry: '펜션',
    region: '가상시',
    competitors: [{ name: '가상 블로그 펜션', domains: ['blog.naver.com'] }],
  })

  // 1) 목록 정리
  const n = store.normalizeCompetitorList(
    [
      { name: ' 가상 하나 ', domains: ['https://www.one.example/rooms?x=1'] },
      { name: '가상,둘', domains: [] },
      { name: '가상 셋', domains: ['blog.naver.com/ourpension'] },
      { name: '가상 블로그 펜션', domains: ['blog.naver.com'] },
    ],
    owner,
    owner.competitors,
  )
  ok('주소 전체 → 도메인, www 뗌', n.competitors[0].domains.join() === 'one.example' && n.competitors[0].name === '가상 하나')
  ok('쉼표가 든 이름은 그대로', n.competitors[1].name === '가상,둘')
  ok('별칭이 없으면 이름', n.competitors[1].aliases.join() === '가상,둘')
  ok('새로 넣은 공용 주소(네이버 블로그)는 홈페이지로 쓰지 않는다', n.competitors[2].domains.length === 0 && n.droppedHosts.includes('blog.naver.com'))
  ok('이미 있던 줄의 공용 주소는 그대로 둔다(id가 바뀌지 않게)', n.competitors[3].domains.join() === 'blog.naver.com')
  ok('빈 목록은 거절', throws(() => store.normalizeCompetitorList([], owner), '한 곳 이상'))
  ok('같은 이름 두 번은 거절(띄어쓰기 무시)', throws(() => store.normalizeCompetitorList([{ name: '가상 하나' }, { name: '가상하나' }], owner), '두 번'))
  ok('자기 도메인은 거절', throws(() => store.normalizeCompetitorList([{ name: '가상 넷', domains: ['www.cust.example'] }], owner), '자신의 도메인'))
  ok('알아볼 수 없는 주소는 거절', throws(() => store.normalizeCompetitorList([{ name: '가상 넷', domains: ['홈페이지 없음'] }], owner), '알아볼 수 없'))
  ok('이름 없는 줄은 거절', throws(() => store.normalizeCompetitorList([{ name: '  ' }], owner), '이름이 비어'))
  ok('21곳은 거절', throws(() => store.normalizeCompetitorList(Array.from({ length: 21 }, (_, i) => ({ name: `가상 ${i}` })), owner), '20곳'))
  ok('hostFromInput: 스킴 없는 주소', store.hostFromInput('All-About.example/a') === 'all-about.example')
  ok('hostFromInput: 모바일 주소(m.)는 벗긴다', store.hostFromInput('https://m.virtual-a.co.kr/main') === 'virtual-a.co.kr')
  ok('첫 마디가 업체 이름이 아닌 주소(shop.)는 공용으로 본다', store.isSharedHost('shop.virtual-b.co.kr') && !store.isSharedHost('virtual-b.co.kr'))
  ok('목록 지문은 순서가 바뀌면 달라진다', store.listHash([n.competitors[0], n.competitors[1]]) !== store.listHash([n.competitors[1], n.competitors[0]]))

  // 2) 베이스 지문
  const fp = store.baseFingerprint(owner)
  ok('경쟁사가 바뀌면 지문이 바뀐다', fp !== store.baseFingerprint({ ...owner, competitors: [] }))
  ok('질문지 버전이 바뀌면 지문이 바뀐다', fp !== store.baseFingerprint({ ...owner, questionBankVersion: 'v9' }))
  ok('시장 범위 같은 다른 값은 지문에 없다', fp === store.baseFingerprint({ ...owner, marketScope: 'national' }))

  // 3) 병합 — 패키징 모드(APP_DATA_DIR)는 번들된 저장소 설정을 베이스로 쓴다. 저장소 설정의 첫 고객 브랜드로 시험한다.
  const repo = (await reg.loadRuntimeTenants()).find((t) => !t.cohortOnly && t.competitors.length >= 2)!
  const repoCohortOnly = (await reg.loadRuntimeTenants()).find((t) => t.cohortOnly)!
  const write = (id: string, body: string) => {
    mkdirSync(path.join(dir, 'data', id), { recursive: true })
    writeFileSync(path.join(dir, 'data', id, 'competitors.json'), body)
  }
  const edited = [{ name: '가상 새 경쟁사', aliases: ['가상 새 경쟁사'], domains: [] }]
  const byId = async (id: string) => (await reg.loadRuntimeTenants()).find((t) => t.tenantId === id)!

  write(repo.tenantId, JSON.stringify({ current: { competitors: edited, base: store.baseFingerprint(repo) }, lastSave: null }))
  ok('지문이 맞으면 앱에서 고친 목록이 저장소 설정을 이긴다', (await byId(repo.tenantId)).competitors[0].name === '가상 새 경쟁사')
  ok('고친 목록을 빼고 읽으면 저장소 설정', (await reg.loadTenantWithoutCompetitorEdit(repo.tenantId))!.competitors[0].name === repo.competitors[0].name)

  write(repo.tenantId, JSON.stringify({ current: { competitors: edited, base: 'old-base' }, lastSave: null }))
  ok('저장소 설정이 바뀐 뒤(지문 다름)에는 쓰지 않는다', (await byId(repo.tenantId)).competitors[0].name === repo.competitors[0].name)

  write(repo.tenantId, JSON.stringify({ current: null, lastSave: null }))
  ok('current가 null이면 저장소 설정', (await byId(repo.tenantId)).competitors[0].name === repo.competitors[0].name)

  const origError = console.error
  let logged = 0
  console.error = () => {
    logged += 1
  }
  write(repo.tenantId, '{ 깨진 파일')
  const broken = await byId(repo.tenantId)
  console.error = origError
  ok('깨진 파일이면 저장소 설정을 쓰고 로그를 남긴다', broken.competitors[0].name === repo.competitors[0].name && logged > 0)
  write(repo.tenantId, JSON.stringify({ current: null, lastSave: null }))

  write(repoCohortOnly.tenantId, JSON.stringify({ current: { competitors: edited, base: store.baseFingerprint(repoCohortOnly) }, lastSave: null }))
  ok('경쟁사 측정용 브랜드(cohortOnly)에는 적용하지 않는다', (await byId(repoCohortOnly.tenantId)).competitors.length === repoCohortOnly.competitors.length)
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
