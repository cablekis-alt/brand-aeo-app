/**
 * 네이버 자동 확인(server/naverIndex.ts)을 확인한다 — 대상 셈 · 결과 주소 맞추기 · 검색 오류 · 실행(적기 · CAS · 멈춤).
 *
 * - 임시 폴더(APP_DATA_DIR)만 쓴다. 설치본(포트 4000) · 실데이터는 건드리지 않는다. 브랜드 · 주소 · 제목은 모두 가짜다.
 * - 네이버는 127.0.0.1 가짜 서버(NAVER_API_HUB_BASE_URL)로만 부른다 — 진짜 검색 0회. 키도 가짜다.
 *
 * 실행: npx tsx scripts/verify-naver-index.ts
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { todayKst, trackingKey } from '../src/lib/publishedUrl'
import { addDays, type IndexCheck, type PublishStatusRow, type TenantChecks } from '../src/lib/publishStatus'

const checks: [string, boolean, unknown?][] = []
const ok = (label: string, cond: boolean, detail?: unknown) => checks.push([label, cond, cond ? undefined : detail])

const today = todayKst()
const D = (n: number) => addDays(today, -n)
const tk = (url: string) => trackingKey(url) as string
const g = (state: IndexCheck['state'], checkedOn: string, source: IndexCheck['source'] = 'manual'): IndexCheck => ({ state, checkedOn, checkedAt: `${checkedOn}T03:00:00.000Z`, source })

const dir = mkdtempSync(path.join(tmpdir(), 'verify-naver-index-'))
const FAKE_ID = `test-naver-id-${randomBytes(4).toString('hex')}`
const FAKE_SECRET = `test-naver-secret-${randomBytes(4).toString('hex')}`
process.env.APP_DATA_DIR = dir
process.env.DOTENV_CONFIG_PATH = path.join(dir, 'no-such.env')
process.env.NAVER_API_HUB_CLIENT_ID = FAKE_ID
process.env.NAVER_API_HUB_CLIENT_SECRET = FAKE_SECRET

// ── 가짜 NAVER API HUB ──
interface Seen {
  kind: string
  query: string
  display: string
  keyOk: boolean
}
const seen: Seen[] = []
/** 검색어 → { blog, webkr } 결과 링크. 검색어가 「E401」 등이면 그 상태로 답한다. */
const answers = new Map<string, { blog?: string[]; webkr?: string[] }>()
const mock = http.createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://127.0.0.1')
  const kind = u.pathname.split('/').pop() ?? ''
  const query = u.searchParams.get('query') ?? ''
  seen.push({ kind, query, display: u.searchParams.get('display') ?? '', keyOk: req.headers['x-ncp-apigw-api-key-id'] === FAKE_ID && req.headers['x-ncp-apigw-api-key'] === FAKE_SECRET })
  const code = /^E(\d{3})/.exec(query)?.[1]
  if (code) {
    res.writeHead(Number(code), { 'content-type': 'application/json' })
    res.end(JSON.stringify({ errorCode: 'SE99', errorMessage: 'fake' }))
    return
  }
  const links = answers.get(query)?.[kind as 'blog' | 'webkr'] ?? []
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ total: links.length, start: 1, display: links.length, items: links.map((link) => ({ title: `<b>${query}</b>`, link, description: '' })) }))
})
await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r()))
const port = (mock.address() as { port: number }).port
process.env.NAVER_API_HUB_BASE_URL = `http://127.0.0.1:${port}/search/v1`

const nv = await import('../server/naverIndex')

// ══ A. 대상 셈 ══════════════════════════════════════════════════════════════
const row = (over: Partial<PublishStatusRow>): PublishStatusRow => {
  const url = over.url ?? 'https://x.tistory.com/1'
  return {
    rowKey: `${over.tenantId ?? 'vn-a'}|${over.postId ?? 'p-x'}`,
    tenantId: 'vn-a',
    brand: '가상하나',
    kind: 'posted',
    origin: 'app',
    postId: 'p-x',
    key: trackingKey(url),
    articleId: 'content:x',
    title: '가상 글',
    writer: null,
    writerUnknown: null,
    postedUnknown: false,
    platform: { key: 'tistory', label: '티스토리' },
    url,
    publishedOn: D(3),
    recheckFrom: D(3),
    trackedOn: null,
    removed: null,
    naver: null,
    google: null,
    checkFrom: null,
    ...over,
  }
}
const SHARED = 'https://shared.tistory.com/9'
const rows = [
  row({ postId: 'p-due', url: 'https://a.tistory.com/1', title: '오늘 차례 글' }),
  row({ postId: 'p-late', url: 'https://a.tistory.com/2', title: '밀린 글', publishedOn: D(5), recheckFrom: D(5) }),
  row({ postId: 'p-early', url: 'https://a.tistory.com/3', title: '이른 글', publishedOn: D(1), recheckFrom: D(1) }),
  row({ postId: 'p-shown', url: 'https://a.tistory.com/4', title: '노출된 글', naver: g('shown', D(1)) }),
  row({ postId: 'p-checked', url: 'https://a.tistory.com/5', title: '오늘 본 글', naver: g('not-yet', today) }),
  row({ postId: 'p-removed', url: 'https://a.tistory.com/6', title: '내린 글', removed: { reason: 'taken-down', at: `${D(1)}T00:00:00.000Z` } }),
  row({ postId: null, kind: 'unposted', url: null, key: null, platform: null, publishedOn: null, recheckFrom: null, title: '안 올린 글' }),
  row({ postId: 'p-untitled', url: 'https://a.tistory.com/7', title: null }),
  row({ tenantId: 'vn-b', brand: '가상둘', postId: 'x-aaaaaaaaaa01', origin: 'external', url: SHARED, title: '앱 밖 제목' }),
  row({ tenantId: 'vn-b', brand: '가상둘', postId: 'p-shared-b', url: SHARED, title: '같은 주소 앱 글' }),
  row({ tenantId: 'vn-a', postId: 'p-shared-a', url: SHARED, title: '같은 주소 앱 글 A' }),
]
const CHECKS: TenantChecks[] = [
  { tenantId: 'vn-a', checks: { 'p-late': { postId: 'p-late', key: tk('https://a.tistory.com/2'), url: 'https://a.tistory.com/2', naver: g('not-yet', D(4)), updatedAt: `${D(4)}T03:00:00.000Z` } } },
]
// p-late는 원본 기록에 「아직」(D4)이 있지만 줄에는 보이지 않는다고 가정(신선도 규칙과 상관없이 CAS 기준값만 본다).
const plan = nv.planNaverTargets({ rows, today, checks: CHECKS, tenantOrder: ['vn-b', 'vn-a'] })
const keysOf = plan.targets.map((t) => t.key).sort()
ok(
  '대상 — 오늘 차례 · 밀린 글만(이른 글 · 노출됨 · 오늘 본 글 · 내린 글 · 안 올린 글은 빼고), 주소마다 한 번',
  JSON.stringify(keysOf) === JSON.stringify([tk('https://a.tistory.com/1'), tk('https://a.tistory.com/2'), tk(SHARED)].sort()),
  keysOf,
)
ok('대상 — 제목 없는 글은 직접 볼 글로 센다', plan.untitled === 1, plan.untitled)
const shared = plan.targets.find((t) => t.key === tk(SHARED))
ok('대상 — 같은 주소는 앱 글이 먼저, 그다음 브랜드 설정 순(vn-b → vn-a)', shared?.postId === 'p-shared-b' && shared.query === '같은 주소 앱 글', shared)
ok(
  '대상 — CAS 기준값은 원본 최신 기록의 네이버 확인 시각(없으면 null)',
  plan.targets.find((t) => t.postId === 'p-late')?.expectRawCheckedAt === `${D(4)}T03:00:00.000Z` && plan.targets.find((t) => t.postId === 'p-due')?.expectRawCheckedAt === null,
)

// ══ B. 결과 주소 맞추기 ═════════════════════════════════════════════════════
const NB = 'https://blog.naver.com/fakeid/223000000001'
ok(
  '맞추기 — 네이버 블로그 m. · 옛 주소 모양(?Redirect=Log&logNo=) · 티스토리 /m/ · 끝 / 를 같은 글로 본다',
  nv.naverResultHas(tk(NB), [{ link: 'https://m.blog.naver.com/fakeid/223000000001' }]) &&
    nv.naverResultHas(tk(NB), [{ link: 'https://blog.naver.com/fakeid?Redirect=Log&logNo=223000000001' }]) &&
    nv.naverResultHas(tk('https://a.tistory.com/1'), [{ link: 'https://a.tistory.com/m/1/' }]),
)
ok(
  '맞추기 — 다른 글 · 같은 블로그 첫 화면 · 모양이 틀린 응답은 못 찾음',
  !nv.naverResultHas(tk(NB), [{ link: 'https://blog.naver.com/fakeid/223000000002' }, { link: 'https://blog.naver.com/fakeid' }]) &&
    !nv.naverResultHas(tk(NB), null) &&
    !nv.naverResultHas(tk(NB), [{ title: 'x' }, 'x', null]),
)

// ══ C. 검색 ═════════════════════════════════════════════════════════════════
answers.set('검색 시험', { blog: ['https://b.tistory.com/1'] })
const items = await nv.naverSearch('blog', '검색 시험')
const last = seen.at(-1)
ok('검색 — 키 두 개를 헤더로 보내고 결과 100개까지 · 검색어 그대로', items.length === 1 && last?.keyOk === true && last.display === '100' && last.query === '검색 시험' && last.kind === 'blog', last)
const errKind = (q: string) => nv.naverSearch('webkr', q).then(() => 'none', (e: { kind?: string }) => e.kind ?? 'throw')
const kinds = { e401: await errKind('E401'), e403: await errKind('E403'), e429: await errKind('E429'), e500: await errKind('E500') }
ok('검색 — 401 키 · 403 권한 · 429 한도 · 5xx 일시 오류로 가른다', kinds.e401 === 'auth' && kinds.e403 === 'forbidden' && kinds.e429 === 'limit' && kinds.e500 === 'upstream', kinds)
const errMsg = await nv.naverSearch('webkr', 'E401').then(
  () => '',
  (e: Error) => e.message,
)
ok('검색 — 오류 문구에 키 값을 싣지 않는다', !errMsg.includes(FAKE_ID) && !errMsg.includes(FAKE_SECRET) && errMsg.includes('NAVER_API_HUB_CLIENT_ID'), errMsg)

// ══ D. 실행 ═════════════════════════════════════════════════════════════════
const post = (id: string, url: string, publishedOn: string, title: string) => ({
  id,
  url,
  key: trackingKey(url),
  publishedOn,
  publishedOnSource: 'user',
  recordedAt: `${publishedOn}T03:00:00.000Z`,
  articleId: 'content:category-agnostic',
  targetActionId: 'content:category-agnostic',
  via: 'own',
  articleTitle: title,
})
const writeData = (tenantId: string, file: string, text: string) => {
  const d = path.join(dir, 'data', tenantId)
  mkdirSync(d, { recursive: true })
  writeFileSync(path.join(d, file), text)
}
const readData = (tenantId: string, file: string) => {
  const p = path.join(dir, 'data', tenantId, file)
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}
const ledger = (posts: unknown[]) => JSON.stringify({ version: 1, keyRule: 3, posts }, null, 2)
const tenant = (tenantId: string, brandName: string) => ({ tenantId, brandName, engines: [], questionBankSize: 1, questionBankVersion: 'v1', repeatsPerQuestion: 1, factGraph: [] }) as never

const U_BLOG = 'https://blog.naver.com/fakerun/223000000101'
const U_WEB = 'https://run.tistory.com/2'
const U_NONE = 'https://run.tistory.com/3'
const U_EARLY = 'https://run.tistory.com/4'
writeData(
  'vr-a',
  'published-posts.json',
  ledger([
    post('p-r1', U_BLOG, D(3), '블로그에서 찾는 글'),
    post('p-r2', U_WEB, D(7), '웹문서에서 찾는 글'),
    post('p-r3', U_NONE, D(14), '어디에도 없는 글'),
    post('p-r4', U_EARLY, D(1), '아직 차례 아닌 글'),
  ]),
)
answers.set('블로그에서 찾는 글', { blog: ['https://m.blog.naver.com/fakerun/223000000101'] })
answers.set('웹문서에서 찾는 글', { blog: ['https://other.tistory.com/1'], webkr: ['https://run.tistory.com/m/2'] })

const waitDone = async () => {
  for (let i = 0; i < 200; i++) {
    if (!nv.naverIndexStatus().running) return
    await new Promise((r) => setTimeout(r, 50))
  }
}
const before = seen.length
const started = await nv.startNaverIndex([tenant('vr-a', '가상실행')])
await waitDone()
const st = nv.naverIndexStatus()
const calls = seen.slice(before)
const file = JSON.parse(readData('vr-a', 'index-checks.json') || '{"checks":{}}') as { checks: Record<string, { naver?: IndexCheck; google?: IndexCheck }> }
ok('실행 — 오늘 차례인 3편(이른 글 빼고)', started.total === 3 && st.run?.total === 3 && st.run.done === 3, { started, run: st.run })
ok('실행 — 블로그에서 찾으면 웹문서는 묻지 않는다(검색 5회: 블로그 3 · 웹문서 2)', calls.filter((c) => c.kind === 'blog').length === 3 && calls.filter((c) => c.kind === 'webkr').length === 2, calls)
ok(
  '실행 — 찾은 글은 「노출됨 · 자동」, 못 찾은 글은 「아직 · 자동」, 확인일 오늘 · 구글 칸은 그대로',
  file.checks['p-r1']?.naver?.state === 'shown' &&
    file.checks['p-r1'].naver.source === 'auto' &&
    file.checks['p-r2']?.naver?.state === 'shown' &&
    file.checks['p-r3']?.naver?.state === 'not-yet' &&
    file.checks['p-r3'].naver.source === 'auto' &&
    file.checks['p-r3'].naver.checkedOn === today &&
    !file.checks['p-r1'].google &&
    !file.checks['p-r4'],
  file,
)
ok('실행 — 결과 셈(노출됨 2 · 아직 1) · 멈춤 없음 · 끝 시각', st.run?.shown === 2 && st.run.notYet === 1 && st.run.stoppedBy === null && st.run.endedAt !== null, st.run)
const again = await nv.startNaverIndex([tenant('vr-a', '가상실행')]).then(
  () => 0,
  (e: { status?: number }) => e.status ?? -1,
)
ok('실행 — 오늘 적은 글은 다시 대상이 아니다(볼 글 없음 409)', again === 409, again)

// 사람 표시가 먼저(CAS) — 계획 뒤 사람이 누르면 덮지 않는다: 계획을 직접 만들어 기준값을 틀리게 준 것과 같다.
writeData('vr-c', 'published-posts.json', ledger([post('p-c1', 'https://cas.tistory.com/1', D(3), '사람이 먼저 누른 글')]))
writeData(
  'vr-c',
  'index-checks.json',
  JSON.stringify({ format: 'index-checks/1', checks: { 'p-c1': { postId: 'p-c1', key: tk('https://cas.tistory.com/1'), url: 'https://cas.tistory.com/1', naver: g('not-yet', D(3)), updatedAt: `${D(3)}T03:00:00.000Z` } } }),
)
const ic = await import('../server/indexChecks')
const cas = (await ic.writeIndexCheck('vr-c', 'p-c1', 'naver', 'shown', [], Date.now(), 'auto', { expectRawCheckedAt: null })) as { skipped?: string }
ok('CAS — 원본 기록의 네이버 확인 시각이 계획과 다르면 적지 않는다(changed)', cas.skipped === 'changed', cas)

// 멈춤 — 키 오류(401)는 그 자리에서 멈추고 적지 않는다.
writeData('vr-d', 'published-posts.json', ledger([post('p-d1', 'https://stop.tistory.com/1', D(3), 'E401 키 틀림'), post('p-d2', 'https://stop.tistory.com/2', D(3), '뒤 글')]))
await nv.startNaverIndex([tenant('vr-d', '가상멈춤')])
await waitDone()
const stopped = nv.naverIndexStatus().run
ok('멈춤 — 401이면 바로 멈추고(뒤 글도 안 봄) 아무것도 적지 않는다', Boolean(stopped?.stoppedBy?.includes('HTTP 401')) && stopped?.done === 0 && readData('vr-d', 'index-checks.json') === '', stopped)

// 멈춤 — 일시 오류가 3번 잇따르면 멈춘다(못 가림으로 센다).
writeData(
  'vr-e',
  'published-posts.json',
  ledger([1, 2, 3, 4].map((n) => post(`p-e${n}`, `https://streak.tistory.com/${n}`, D(3), `E500 일시 ${n}`))),
)
await nv.startNaverIndex([tenant('vr-e', '가상잇따름')])
await waitDone()
const streak = nv.naverIndexStatus().run
ok('멈춤 — 5xx가 3번 잇따르면 멈춘다(못 가림 3 · 넷째는 안 봄)', streak?.unknown === 3 && streak.done === 3 && Boolean(streak.stoppedBy?.includes('잇따라')), streak)

// 키 없음 — 시작을 거절(503), 상태는 configured false.
delete process.env.NAVER_API_HUB_CLIENT_SECRET
const noKey = await nv.startNaverIndex([tenant('vr-a', '가상실행')]).then(
  () => 0,
  (e: { status?: number }) => e.status ?? -1,
)
ok('키 없음 — 상태 configured false · 시작 503', nv.naverIndexStatus().configured === false && noKey === 503, noKey)

mock.close()
rmSync(dir, { recursive: true, force: true })

let failed = 0
for (const [label, cond, detail] of checks) {
  console.log(`${cond ? '✓' : '✗'} ${label}`)
  if (!cond) {
    failed += 1
    if (detail !== undefined) console.log('   ', JSON.stringify(detail).slice(0, 800))
  }
}
console.log(failed ? `\n${failed}건 실패` : `\n모두 통과 (${checks.length}건)`)
process.exit(failed ? 1 : 0)
