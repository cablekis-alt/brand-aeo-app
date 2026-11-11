/**
 * SerpAPI 공용 연결(server/serpApi.ts · GET /api/serpapi/account · /api/health serpApi)을 확인한다 — 색인 자동 확인이 먼저 쓰고, 나중에 구글
 * AI 개요 시범이 기능 'aio'로 같은 연결 · 같은 장부를 쓴다.
 *
 * 안전 규칙(검색마다 돈이 든다 — 지키지 않으면 check-all이 사람이 안 보는 사이 진짜 크레딧을 쓴다):
 * - 진짜 SerpAPI(serpapi.com)는 부르지 않는다. 가짜 SerpAPI 서버를 127.0.0.1:4196에 띄우고 SERPAPI_BASE_URL을 그리로 준다. 시작 전에 그 값이
 *   루프백인지 단언하고 아니면 바로 끝낸다. 이 프로세스의 fetch는 127.0.0.1 밖으로 나가면 막고 기록한다. 띄우는 앱 서버(포트 4197)에는
 *   serpapi.com으로 가는 fetch를 막는 가드를 --import로 얹는다.
 * - 키는 가짜(test-serp-<무작위>, 진짜 키 모양과 다름)다. 가짜 서버는 받은 api_key가 그 값인지 매번 본다. 부르는 단계에서는 가짜 서버가
 *   받았는지(= 진짜로 새지 않았는지)를 센다.
 * - 앱 서버는 DOTENV_CONFIG_PATH=<임시 폴더>/no-such.env로 띄운다 — server/index.ts의 'dotenv/config'가 저장소 .env의 진짜 키를 읽지 않게.
 *   「키 없음」은 SERPAPI_API_KEY=''로 준다(지우면 dotenv가 진짜 키를 채울 수 있다).
 * - 임시 폴더(APP_DATA_DIR)만 쓴다. 설치본(포트 4000) · 실데이터는 건드리지 않는다.
 *
 * 무엇을 보나:
 * - 주소: 기본 https://serpapi.com은 설치본 묶음(SERPAPI_LIVE=1로 묶임)에서만 — dev · 시험 서버는 비어 있으면 설정 오류다. SERPAPI_BASE_URL은
 *   정확히 http://127.0.0.1:<포트>만 받고, 그 밖의 값이면 진짜 주소로 돌아가지 않고 시작하지 않는다(요청 0). 3xx는 따라가지 않는다(요청 0).
 * - 실행 잠금(serpapi-run.lock): 검색은 잠금을 잡은 뒤에만 나간다. 다른 프로세스(앱을 두 번 켬)가 살아서 잡고 있으면 못 잡고, 죽었거나
 *   2분 넘게 소식이 없으면 넘겨받는다. 다른 프로세스가 잡은 동안에는 장부의 그쪽 pending을 지우지 않는다. 잠금을 잃으면 보내지 않는다.
 * - 계정(account.json, 무료): 허용 칸만 담는다(api_key · account_email · account_id 버림). 60초 캐시 · 5초 시간 초과. 못 읽거나 Active가
 *   아니거나 갱신일 · 월 검색 수 · 남은 수 · 시간당 한도를 못 읽으면 검색하지 않는다(막힌 쪽).
 * - 장부(serpapi-usage.json): 결제 주기(plan_renewal_date)마다 기능별로 센다. 보내기 전에 sent+1 · pending을 적고, 응답(성공 · 오류 · 시간
 *   초과) 뒤 pending만 지운다. 끊긴 프로세스의 pending은 다음에 지운다(sent는 그대로). 깨졌으면 부르지 않고 덮어쓰지 않는다. 모르는 칸은
 *   버리지 않는다. 최근 6주기만 둔다.
 * - 몫(요금제 월 검색 수의 비율): 계정 바닥 50% · 색인 20% · AI 개요 25% · 여유 5%. 호출마다 기능 몫 · 바닥 · 시간당 남은 수를 검사하고,
 *   10회마다 계정을 다시 읽는다(실패면 멈춤).
 * - 순차 줄(동시 1 · 앞 요청이 끝난 뒤 1초), 시간 초과(30초 — 시험은 SERPAPI_TIMEOUT_MS로 짧게)는 다시 보내지 않음, 오류 분류(401 · 403 ·
 *   429 두 가지 · 400 · 5xx · JSON 아님).
 * - 키는 오류 글자 · 장부 · 응답 · 서버 로그 어디에도 없고, 요청 주소는 남기지 않는다.
 * - 설치본 서버 묶음은 시험 전용 env(SERPAPI_BASE_URL · SERPAPI_TIMEOUT_MS)를 이름째 지운다.
 *
 *   npx tsx scripts/verify-serpapi-client.ts
 */
import { execSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MOCK_PORT = 4196
const APP_PORT = 4197
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`
const APP_BASE = `http://127.0.0.1:${APP_PORT}`
const CHILD = process.argv.includes('--child-hang')
const FAKE_KEY = CHILD ? (process.env.SERPAPI_API_KEY ?? '') : `test-serp-${randomBytes(6).toString('hex')}`

// 안전 — 이 프로세스의 fetch는 127.0.0.1만 나간다(그 밖은 막고 기록한다).
const blocked: string[] = []
const realFetch = globalThis.fetch
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const host = URL.canParse(href) ? new URL(href).hostname : ''
  if (host !== '127.0.0.1') {
    blocked.push(host || '(주소 아님)')
    return Promise.reject(new Error('verify guard: 127.0.0.1 밖으로 나가는 요청을 막았습니다'))
  }
  return realFetch(input, init)
}) as typeof fetch

// 끊김 시험의 자식 — 응답하지 않는 검색 하나를 보내고 부모가 죽일 때까지 기다린다.
if (CHILD) {
  if (process.env.SERPAPI_BASE_URL !== MOCK_BASE || !FAKE_KEY.startsWith('test-serp-')) {
    console.error('자식: 가짜 SerpAPI 주소 · 가짜 키가 아니라 멈춥니다.')
    process.exit(2)
  }
  const child = await import('../server/serpApi')
  const held = await child.claimSerpRun('index')
  if (!held) {
    console.error('자식: 실행 잠금을 잡지 못해 멈춥니다.')
    process.exit(3)
  }
  await child.serpSearch('index', { engine: 'google', q: 'hang' }).catch((err: unknown) => console.error(`자식: ${err instanceof Error ? err.message : String(err)}`))
  process.exit(0)
}

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean, detail?: unknown) => {
  checks.push([label, cond])
  if (!cond && detail !== undefined) console.error(`  ✗ ${label}:`, detail)
}

const dir = mkdtempSync(path.join(tmpdir(), 'verify-serpapi-'))
const dir2 = mkdtempSync(path.join(tmpdir(), 'verify-serpapi-app-'))
const LEDGER = path.join(dir, 'serpapi-usage.json')
const LEDGER2 = path.join(dir2, 'serpapi-usage.json')
const RUN_LOCK = path.join(dir, 'serpapi-run.lock')
process.env.SERPAPI_API_KEY = FAKE_KEY
process.env.SERPAPI_LIVE = ''
process.env.SERPAPI_BASE_URL = MOCK_BASE
process.env.SERPAPI_TIMEOUT_MS = '1500'
process.env.DOTENV_CONFIG_PATH = path.join(dir, 'no-such.env')
process.env.APP_DATA_DIR = dir
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.SERPAPI_BASE_URL) || !FAKE_KEY.startsWith('test-serp-')) {
  console.error('가짜 SerpAPI 주소(127.0.0.1) · 가짜 키가 아니라 시작하지 않습니다.')
  process.exit(1)
}

// ── 가짜 SerpAPI ─────────────────────────────────────────────────────────────
const account = (over: Record<string, unknown> = {}) => ({
  account_id: 'acct-fake-0001',
  api_key: FAKE_KEY,
  account_email: 'fake-owner@example.test',
  account_status: 'Active',
  plan_id: 'starter',
  plan_name: 'Starter',
  plan_monthly_price: 25,
  searches_per_month: 1000,
  plan_searches_left: 990,
  extra_credits: 0,
  total_searches_left: 990,
  this_month_usage: 10,
  this_hour_searches: 0,
  last_hour_searches: 0,
  account_rate_limit_per_hour: 200,
  plan_renewal_date: '2026-12-08',
  ...over,
})
interface Seen {
  path: string
  q: string | null
  keyOk: boolean
  params: string[]
  at: number
  end?: number
  ledger?: string
}
const seen: Seen[] = []
let accountBody: Record<string, unknown> = account()
let accountMode: 'ok' | 'fail' | 'slow' | 'redirect' | 'e401' = 'ok'
let inFlight = 0
let maxInFlight = 0
const searches = () => seen.filter((s) => s.path === '/search.json')
const accountCalls = () => seen.filter((s) => s.path === '/account.json').length
const result = (extra: Record<string, unknown> = {}) => ({ search_metadata: { status: 'Success' }, organic_results: [], ...extra })

const mock = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', MOCK_BASE)
  const p = url.searchParams
  const s: Seen = { path: url.pathname, q: p.get('q'), keyOk: p.get('api_key') === FAKE_KEY, params: [...p.keys()].sort(), at: Date.now() }
  seen.push(s)
  inFlight += 1
  maxInFlight = Math.max(maxInFlight, inFlight)
  let closed = false
  res.on('close', () => {
    if (closed) return
    closed = true
    inFlight -= 1
    s.end = Date.now()
  })
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
  }
  const later = (ms: number, status: number, body: unknown) => {
    const t = setTimeout(() => send(status, body), ms)
    res.on('close', () => clearTimeout(t))
  }
  // 3xx를 따라가 닿는 곳 — 받으면 안 된다(따라가면 키가 붙은 질의째 다른 주소로 간다).
  const redirect = () => {
    res.writeHead(302, { Location: `${MOCK_BASE}/__landed?${url.searchParams.toString()}` })
    res.end()
  }
  if (url.pathname === '/account.json') {
    if (accountMode === 'fail') return send(500, { error: `account down ${FAKE_KEY}` })
    if (accountMode === 'slow') return later(4000, 200, accountBody)
    if (accountMode === 'redirect') return redirect()
    if (accountMode === 'e401') return send(401, { error: 'Invalid API key.' })
    return send(200, accountBody)
  }
  if (url.pathname !== '/search.json') return send(404, { error: 'not found' })
  switch (s.q) {
    case 'redir':
      return redirect()
    case 'probe':
      s.ledger = existsSync(LEDGER) ? readFileSync(LEDGER, 'utf8') : ''
      return send(200, result({ organic_results: [{ position: 1, link: 'https://example.test/a' }], serpapi_pagination: { next: `${MOCK_BASE}/search.json?api_key=${FAKE_KEY}&q=probe&start=10` } }))
    case 'empty':
      return send(200, { search_metadata: { status: 'Success' }, error: "Google hasn't returned any results for this query." })
    case 'e401':
      return send(401, { error: 'Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key' })
    case 'e403':
      return send(403, { error: 'This account is not allowed to use this API.' })
    case 'e429m':
      return send(429, { error: 'Your account has run out of searches.' })
    case 'e429m2':
      return send(429, { error: 'your account has RUN OUT OF SEARCHES' })
    case 'e429h':
      return send(429, { error: 'Your account has exceeded the hourly throughput limit.' })
    case 'e400':
      return send(400, { error: 'Missing query `q` parameter.' })
    case 'e503':
      return send(503, { error: `proxy timeout for ${FAKE_KEY}` })
    case 'garbage':
      return send(200, `<html>not json ${FAKE_KEY}</html>`)
    case 'slow':
      return later(4000, 200, result())
    case 'hang':
      return
    default:
      return send(200, result())
  }
})

const portFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Caught {
  name: string
  kind: string
  message: string
  text: string
}
const errors: Caught[] = []
const caught = async (p: Promise<unknown>): Promise<Caught | null> => {
  try {
    await p
    return null
  } catch (err) {
    const e = err as { name?: string; kind?: string; message?: string; stack?: string }
    const c = { name: e.name ?? '', kind: e.kind ?? '', message: e.message ?? String(err), text: `${String(err)} ${e.stack ?? ''} ${JSON.stringify(err)}` }
    errors.push(c)
    return c
  }
}
// 장부가 없으면 빈 모양 — 회귀가 생겨도 검사가 멈추지 않고 그 줄이 실패로 남게.
const readLedger = (file = LEDGER) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { format: '(없음)', cycles: {}, pending: [] }) as {
  format: string
  cycles: Record<string, Record<string, { sent: number; [k: string]: unknown }>>
  pending: { id: string; feature: string; at: string }[]
  [k: string]: unknown
}
const consoleText: string[] = []
const origWarn = console.warn
const origError = console.error
console.warn = (...a: unknown[]) => {
  consoleText.push(a.map(String).join(' '))
  origWarn(...a)
}
console.error = (...a: unknown[]) => {
  consoleText.push(a.map(String).join(' '))
  origError(...a)
}

for (const port of [MOCK_PORT, APP_PORT]) {
  if (!(await portFree(port))) {
    origError(`포트 ${port}을 다른 프로그램이 쓰고 있어 확인하지 못했습니다.`)
    rmSync(dir, { recursive: true, force: true })
    rmSync(dir2, { recursive: true, force: true })
    process.exit(1)
  }
}
await new Promise<void>((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve))

const children: ChildProcess[] = []
try {
  const serp = await import('../server/serpApi')
  const okSearch = (q: string, feature: 'index' | 'aio' = 'index') => serp.serpSearch(feature, { engine: 'google', q })

  // ── 1. 주소 · 키 가리기 · 몫(서버 없이) ──────────────────────────────────────
  const resolved = (v: string | undefined, live?: string) => {
    const r = serp.resolveSerpBase(v, live)
    return 'base' in r ? r.base : 'config'
  }
  ok(
    '주소 — 비어 있으면 기본 https://serpapi.com은 설치본 묶음(SERPAPI_LIVE=1)에서만',
    resolved(undefined, '1') === 'https://serpapi.com' && resolved('', '1') === 'https://serpapi.com' && serp.SERPAPI_DEFAULT_BASE === 'https://serpapi.com',
  )
  ok(
    '주소 — dev · 시험 서버(묶지 않음)는 비어 있으면 진짜 주소로 가지 않고 설정 오류(SERPAPI_LIVE가 정확히 1일 때만 진짜)',
    ['', undefined, '0', 'true', 'yes', ' 1'].every((live) => resolved(undefined, live) === 'config' && resolved('', live) === 'config') && resolved(undefined) === 'config',
  )
  ok('주소 — 정확히 http://127.0.0.1:<포트>만 받는다', resolved('http://127.0.0.1:4196') === 'http://127.0.0.1:4196' && resolved('http://127.0.0.1:65535') === 'http://127.0.0.1:65535')
  const refused = [
    'http://localhost:4196', 'https://127.0.0.1:4196', 'http://127.0.0.1', 'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1:4196/',
    'http://127.0.0.1:4196/search', 'http://127.0.0.2:4196', 'http://[::1]:4196', 'http://127.0.0.1:4196@evil.example', 'https://serpapi.com',
    'https://example.com', 'serpapi.com', 'http://0x7f000001:4196',
  ]
  ok('주소 — 그 밖의 값은 모두 막는다(기본 주소로 돌아가지 않음 · 설치본 묶음에서도)', refused.every((v) => resolved(v) === 'config' && resolved(v, '1') === 'config'), refused.filter((v) => resolved(v) !== 'config'))
  ok(
    '요청 출처 — Host · Origin이 이 PC(127.0.0.1 · localhost · [::1])일 때만 받는다(DNS 리바인딩 막기)',
    serp.localRequestProblem('127.0.0.1:4197', undefined) === null && serp.localRequestProblem('localhost:5173', 'http://localhost:5173') === null &&
      serp.localRequestProblem('[::1]:4000', 'http://[::1]:4000') === null && serp.localRequestProblem('LOCALHOST', undefined) === null &&
      [
        ['rebind.attacker.example:4197', 'http://rebind.attacker.example:4197'],
        ['rebind.attacker.example:4197', undefined],
        ['127.0.0.1:4197', 'http://evil.example'],
        ['127.0.0.1:4197', 'null'],
        ['127.0.0.1.evil.example:4197', undefined],
        ['evil.example@127.0.0.1:4197', undefined],
        [undefined, undefined],
        ['', undefined],
        ['127.0.0.1:4197', 'http://127.0.0.1:4197/x'],
        ['127.0.0.1:4197', 'file://'],
      ].every(([h, o]) => typeof serp.localRequestProblem(h, o) === 'string'),
  )
  const keyBackup = process.env.SERPAPI_API_KEY
  process.env.SERPAPI_API_KEY = 'test serp+key/=1&x'
  const odd = process.env.SERPAPI_API_KEY
  const scrubbed = serp.scrubSerpKey(`a ${odd} b ${encodeURIComponent(odd)} c ${new URLSearchParams({ k: odd }).toString().slice(2)} d`)
  process.env.SERPAPI_API_KEY = keyBackup
  ok('키 가리기 — 원문 · encodeURIComponent · URLSearchParams 모양 모두 ***', scrubbed === 'a *** b *** c *** d', scrubbed)
  const q1 = serp.serpQuota(1000)
  const q5 = serp.serpQuota(5000)
  ok(
    '몫 — 바닥 50% · 색인 20% · AI 개요 25% · 여유 5%(Starter 1,000 → 500 · 200 · 250 · 50, Developer 5,000 → 2,500 · 1,000 · 1,250 · 250)',
    JSON.stringify(serp.SERPAPI_BUDGET_PCT) === JSON.stringify({ floor: 50, index: 20, aio: 25, slack: 5 }) &&
      JSON.stringify(q1) === JSON.stringify({ floor: 500, index: 200, aio: 250, slack: 50 }) &&
      JSON.stringify(q5) === JSON.stringify({ floor: 2500, index: 1000, aio: 1250, slack: 250 }),
    { q1, q5 },
  )
  ok('기능 — index(색인 자동 확인) · aio(구글 AI 개요 시범)', JSON.stringify(serp.SERP_FEATURES) === JSON.stringify(['index', 'aio']))

  // ── 2. 막힌 쪽 주소 · 키 없음 — 요청 0 ─────────────────────────────────────
  for (const bad of ['', 'http://localhost:4196', 'https://example.com', 'https://serpapi.com', 'http://127.0.0.1:4196/x']) {
    process.env.SERPAPI_BASE_URL = bad
    const conf = serp.serpApiConfigError()
    const s = await caught(okSearch('ok'))
    const a = await caught(serp.serpAccount({ fresh: true }))
    ok(`막힌 쪽 주소(${bad}) — 설정 오류 · 검색 · 계정 모두 시작 안 함`, typeof conf === 'string' && s?.kind === 'config' && a?.kind === 'config', { conf, s, a })
  }
  process.env.SERPAPI_BASE_URL = MOCK_BASE
  process.env.SERPAPI_API_KEY = ''
  const noKeySearch = await caught(okSearch('ok'))
  const noKeyAccount = await caught(serp.serpAccount())
  ok('키 없음 — configured false · 검색 · 계정 no-key', !serp.serpApiConfigured() && noKeySearch?.kind === 'no-key' && noKeyAccount?.kind === 'no-key' && /SERPAPI_API_KEY/.test(noKeySearch.message))
  const noKeyView = await serp.serpApiAccountView()
  ok('키 없음 — 계정 보기도 부르지 않음', noKeyView.configured === false && noKeyView.account === null)
  process.env.SERPAPI_API_KEY = FAKE_KEY
  ok('막힌 쪽 · 키 없음 — 가짜 서버도 받은 것이 없다(어디로도 나가지 않음)', seen.length === 0 && blocked.length === 0, { seen: seen.length, blocked })
  ok('주소가 맞으면 설정 오류 없음 · configured', serp.serpApiConfigError() === null && serp.serpApiConfigured())

  // ── 2-b. 실행 잠금 — 앱을 두 번 켜도 한 프로세스만 보낸다 ─────────────────────────
  const noLock = await caught(okSearch('nolock'))
  ok('잠금 — 실행 잠금 없이는 보내지 않는다(요청 0)', noLock?.kind === 'config' && seen.length === 0, noLock)
  const lockAt = (body: unknown, ageMs = 0) => {
    writeFileSync(RUN_LOCK, typeof body === 'string' ? body : JSON.stringify(body))
    if (ageMs > 0) {
      const t = new Date(Date.now() - ageMs)
      utimesSync(RUN_LOCK, t, t)
    }
  }
  const foreign = (pid: number, token = 't-foreign') => ({ format: 'serpapi-run-lock/1', pid, feature: 'index', token, at: new Date().toISOString() })
  const deadPid = await new Promise<number>((resolve) => {
    const c = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    c.once('exit', () => resolve(c.pid ?? 0))
  })
  const r1 = await serp.claimSerpRun('index')
  const lockText = existsSync(RUN_LOCK) ? readFileSync(RUN_LOCK, 'utf8') : ''
  ok('잠금 — 잡으면 잠금 파일에 이 프로세스 pid · 기능(키 없음)', r1 !== null && lockText.includes(`"pid":${process.pid}`) && lockText.includes('"feature":"index"') && !lockText.includes(FAKE_KEY), lockText)
  ok('잠금 — 같은 프로세스에서 두 번째는 못 잡는다', (await serp.claimSerpRun('aio')) === null && (await serp.claimSerpRun('index')) === null)
  await r1?.()
  await r1?.()
  ok('잠금 — 놓으면 잠금 파일을 지운다(두 번 불러도 한 번)', !existsSync(RUN_LOCK))
  lockAt(foreign(process.ppid))
  const busy = await serp.claimSerpRun('index')
  ok('잠금 — 다른 프로세스(살아 있음)가 잡고 있으면 못 잡고 그 기능을 알린다 · 파일 그대로', busy === null && (await serp.serpRunElsewhere()) === 'index' && readFileSync(RUN_LOCK, 'utf8').includes('t-foreign'))
  lockAt(foreign(process.ppid), 3 * 60_000)
  const r2 = await serp.claimSerpRun('index')
  ok('잠금 — 2분 넘게 소식 없는 잠금은 넘겨받는다(pid가 다시 쓰여도 막히지 않게)', r2 !== null && readFileSync(RUN_LOCK, 'utf8').includes(`"pid":${process.pid}`) && (await serp.serpRunElsewhere()) === null)
  await r2?.()
  lockAt(foreign(deadPid))
  const r3 = await serp.claimSerpRun('index')
  ok('잠금 — 죽은 프로세스의 잠금은 넘겨받는다', deadPid > 0 && r3 !== null, deadPid)
  await r3?.()
  lockAt('')
  const r4 = await serp.claimSerpRun('index')
  lockAt('', 3 * 60_000)
  const r5 = await serp.claimSerpRun('index')
  ok('잠금 — 막 만들어 비어 있는 잠금은 기다리고(못 잡음), 2분 지나면 넘겨받는다', r4 === null && r5 !== null)
  lockAt(foreign(process.ppid, 't-took-over'))
  const sentBeforeLost = searches().length
  const lost = await caught(okSearch('lost'))
  ok('잠금 — 잠금을 잃으면(다른 프로세스가 넘겨받음) 보내지 않고 장부에도 세지 않는다', lost?.kind === 'ledger' && searches().length === sentBeforeLost && !existsSync(LEDGER), lost)
  await r5?.()
  ok('잠금 — 잃은 잠금은 놓을 때 남의 파일을 지우지 않는다', existsSync(RUN_LOCK) && readFileSync(RUN_LOCK, 'utf8').includes('t-took-over'))
  unlinkSync(RUN_LOCK)
  let held = await serp.claimSerpRun('index')
  ok('잠금 — 이 아래 시험은 잠금을 잡고 보낸다', held !== null)

  // ── 3. 계정 — 허용 칸만 · 캐시 ───────────────────────────────────────────────
  const view = await serp.serpApiAccountView()
  const acc = view.account
  const ACCOUNT_KEYS = [
    'accountStatus', 'extraCredits', 'fetchedAt', 'planName', 'planRenewalDate', 'planSearchesLeft', 'rateLimitPerHour', 'searchesPerMonth',
    'thisHourSearches', 'thisMonthUsage', 'totalSearchesLeft',
  ]
  const viewText = JSON.stringify(view)
  ok(
    '계정 — 허용 칸만(키 · 이메일 · 계정 id · 요금 · 그 밖 버림)',
    acc !== null && JSON.stringify(Object.keys(acc).sort()) === JSON.stringify(ACCOUNT_KEYS) && acc.planName === 'Starter' && acc.totalSearchesLeft === 990 &&
      acc.planRenewalDate === '2026-12-08' && acc.rateLimitPerHour === 200 &&
      !viewText.includes(FAKE_KEY) && !viewText.includes('fake-owner@example.test') && !viewText.includes('acct-fake-0001') && !viewText.includes('api_key'),
    view,
  )
  ok(
    '계정 보기 — 몫 · 이번 주기 기능별 사용(장부 없음 = 0) · 지금 보낼 수 있는 수',
    view.configError === null && view.accountError === null && view.usageError === null &&
      JSON.stringify(view.budget) === JSON.stringify({ pct: { floor: 50, index: 20, aio: 25, slack: 5 }, searches: { floor: 500, index: 200, aio: 250, slack: 50 } }) &&
      view.usage?.cycle === '2026-12-08' && view.usage.features.index.sent === 0 && view.usage.features.index.cap === 200 &&
      view.usage.features.index.allowed === 200 && view.usage.features.aio.cap === 250 && view.usage.aboveFloor === 490 && view.usage.hourLeft === 200,
    view,
  )
  ok('계정 — 처음 한 번 부르고 장부 파일은 만들지 않는다(읽기만)', accountCalls() === 1 && searches().length === 0 && !existsSync(LEDGER))
  await serp.serpAccount()
  ok('계정 — 60초 안에는 캐시', accountCalls() === 1)
  await serp.serpAccount({ fresh: true })
  ok('계정 — fresh면 다시 읽는다', accountCalls() === 2)

  // ── 4. 장부 — 보내기 전에 sent+1 · pending, 응답 뒤 pending 지움 · 키 가리기 ──────
  const probe = await okSearch('probe')
  const probeSeen = searches().find((s) => s.q === 'probe')
  const atArrival = probeSeen?.ledger ? (JSON.parse(probeSeen.ledger) as ReturnType<typeof readLedger>) : null
  ok(
    '장부 — 요청이 가짜 서버에 닿았을 때 이미 sent+1 · pending이 적혀 있다',
    atArrival?.format === 'serpapi-usage/1' && atArrival.cycles['2026-12-08']?.index?.sent === 1 && atArrival.pending.length === 1 && atArrival.pending[0]?.feature === 'index',
    probeSeen?.ledger,
  )
  const afterProbe = readLedger()
  ok('장부 — 응답 뒤에는 pending만 지운다', afterProbe.cycles['2026-12-08']?.index?.sent === 1 && afterProbe.pending.length === 0)
  const probeText = JSON.stringify(probe.json)
  ok('검색 — 응답의 키 글자는 ***로 가린 뒤 돌려준다', !probeText.includes(FAKE_KEY) && probeText.includes('api_key=***') && probe.json.search_metadata !== undefined)
  ok(
    '검색 — 가짜 서버가 받은 값: 가짜 키 · 넘긴 매개변수만(api_key · engine · q)',
    probeSeen?.keyOk === true && JSON.stringify(probeSeen.params) === JSON.stringify(['api_key', 'engine', 'q']),
    probeSeen,
  )

  // ── 5. 오류 분류 — 보낸 것은 모두 센다 ──────────────────────────────────────
  const kinds: [string, string][] = [
    ['e401', 'key'], ['e403', 'forbidden'], ['e429m', 'quota-month'], ['e429m2', 'quota-month'], ['e429h', 'rate-hour'], ['e400', 'bad-request'],
    ['e503', 'upstream'], ['garbage', 'upstream'],
  ]
  const got: string[] = []
  for (const [q, kind] of kinds) {
    const e = await caught(okSearch(q))
    got.push(`${q}:${e?.name ?? ''}:${e?.kind ?? '(통과함)'}`)
    ok(`오류 — ${q} → ${kind}`, e?.name === 'SerpApiError' && e.kind === kind, e)
  }
  const e401 = errors.find((e) => e.kind === 'key')
  ok('오류 — 401 안내에 키 이름을 적는다(값은 없이)', e401 !== undefined && /SERPAPI_API_KEY/.test(e401.message) && /401/.test(e401.message))
  const empty = await okSearch('empty')
  ok('결과 0건(Success + 빈 결과 문구)은 오류가 아니다 — 응답을 그대로 돌려준다', empty.json.error === "Google hasn't returned any results for this query.")
  ok('오류 · 0건도 보낸 것은 모두 장부에 센다(probe 1 + 8 + 1)', readLedger().cycles['2026-12-08']?.index?.sent === 10 && readLedger().pending.length === 0)
  ok('10회까지는 계정을 다시 읽지 않는다', accountCalls() === 2, accountCalls())
  accountMode = 'fail'
  const searchesBefore = searches().length
  const refreshFail = await caught(okSearch('ok'))
  ok('11회째 — 계정을 다시 읽고, 못 읽으면 보내지 않는다(막힌 쪽)', accountCalls() === 3 && refreshFail?.kind === 'account' && searches().length === searchesBefore, refreshFail)
  ok(
    '11회째 — 실행 중 다시 읽기 실패는 「다시 읽지 못해 멈췄어요(까닭)」(「시작하지 않았어요」가 아님)',
    refreshFail !== null && refreshFail.message.includes('다시 읽지 못해 멈췄어요') && refreshFail.message.includes('HTTP 500') && !refreshFail.message.includes('시작하지 않았어요'),
    refreshFail?.message,
  )
  ok('계정을 못 읽어 멈춘 검색은 장부에 세지 않는다', readLedger().cycles['2026-12-08']?.index?.sent === 10)
  accountMode = 'ok'
  await okSearch('ok')
  ok('계정이 돌아오면 다시 읽고 보낸다', accountCalls() === 4 && searches().length === searchesBefore + 1 && readLedger().cycles['2026-12-08']?.index?.sent === 11)

  // ── 6. 시간 초과 — 다시 보내지 않음 · 1회로 셈 ────────────────────────────────
  const t0 = Date.now()
  const slow = await caught(okSearch('slow'))
  const tookMs = Date.now() - t0
  await sleep(1500)
  ok('시간 초과 — timeout, 다시 보내지 않는다(가짜 서버가 받은 수 1)', slow?.kind === 'timeout' && searches().filter((s) => s.q === 'slow').length === 1 && tookMs < 3500, { slow, tookMs })
  ok('시간 초과도 장부 1회 · pending 지움', readLedger().cycles['2026-12-08']?.index?.sent === 12 && readLedger().pending.length === 0)

  // ── 7. 순차 줄 — 동시 1 · 앞 요청이 끝난 뒤 1초 ─────────────────────────────
  maxInFlight = 0
  await Promise.all([okSearch('gap1'), okSearch('gap2')])
  const g1 = searches().find((s) => s.q === 'gap1')
  const g2 = searches().find((s) => s.q === 'gap2')
  const gap = g1?.end !== undefined && g2 ? g2.at - g1.end : -1
  ok('순차 줄 — 한 번에 하나, 앞 요청이 끝나고 1초 뒤에 다음 요청', maxInFlight === 1 && gap >= 980, { maxInFlight, gap })

  // ── 7-b. 3xx는 따라가지 않는다 — 따라가면 키가 붙은 질의째 다른 주소(진짜 주소까지)로 나간다 ─────────────
  const landed = () => seen.filter((s) => s.path === '/__landed').length
  const redirSearch = await caught(okSearch('redir'))
  ok('3xx — 검색 응답의 리디렉트는 따라가지 않고 upstream(닿는 곳이 받은 요청 0)', redirSearch?.kind === 'upstream' && landed() === 0 && searches().filter((s) => s.q === 'redir').length === 1, redirSearch)
  accountMode = 'redirect'
  const redirAccount = await caught(serp.serpAccount({ fresh: true }))
  accountMode = 'ok'
  ok('3xx — 계정 응답의 리디렉트도 따라가지 않고 account(닿는 곳이 받은 요청 0)', redirAccount?.kind === 'account' && landed() === 0, redirAccount)

  // ── 8. 몫 — 바닥 · 시간당 · 기능 몫, 결제 주기 ──────────────────────────────
  accountBody = account({ total_searches_left: 501 })
  await serp.serpAccount({ fresh: true })
  const sentBefore = readLedger().cycles['2026-12-08']?.index?.sent ?? -1
  await okSearch('floor1')
  const floorErr = await caught(okSearch('floor2'))
  ok(
    '바닥 — 남은 501회면 1회 보내고(500 남김), 다음은 SerpApiBudgetError floor · 보내지 않음',
    floorErr?.name === 'SerpApiBudgetError' && floorErr.kind === 'floor' && !searches().some((s) => s.q === 'floor2') && readLedger().cycles['2026-12-08']?.index?.sent === sentBefore + 1,
    floorErr,
  )
  accountBody = account({ this_hour_searches: 199 })
  await serp.serpAccount({ fresh: true })
  await okSearch('hour1')
  const hourErr = await caught(okSearch('hour2'))
  ok('시간당 — 199/200이면 1회 보내고 다음은 hour · 보내지 않음', hourErr?.kind === 'hour' && !searches().some((s) => s.q === 'hour2'), hourErr)

  accountBody = account()
  await serp.serpAccount({ fresh: true })
  writeFileSync(
    LEDGER,
    JSON.stringify({
      format: 'serpapi-usage/1',
      budget: { note: '나중 판의 칸' },
      cycles: { '2026-12-08': { index: { sent: 200 }, aio: { sent: 0, followUps: 2 }, future: { sent: 5, note: 'x' } } },
      pending: [],
    }),
  )
  const capBytes = readFileSync(LEDGER, 'utf8')
  const capErr = await caught(okSearch('cap1'))
  ok('색인 몫 — 이번 주기 200회를 다 쓰면 feature-cap · 보내지 않음 · 장부 그대로', capErr?.kind === 'feature-cap' && !searches().some((s) => s.q === 'cap1') && readFileSync(LEDGER, 'utf8') === capBytes, capErr)
  const aioNoLock = await caught(okSearch('aio0', 'aio'))
  ok('잠금 — 다른 기능(index)의 잠금으로는 aio를 보내지 않는다', aioNoLock?.kind === 'config' && !searches().some((s) => s.q === 'aio0'), aioNoLock)
  await held?.()
  held = await serp.claimSerpRun('aio')
  await okSearch('aio1', 'aio')
  await held?.()
  held = await serp.claimSerpRun('index')
  const mixed = readLedger()
  ok(
    'AI 개요 몫은 따로 센다 — 색인이 다 차도 aio는 보내고, 모르는 칸(기능 · 후속 수 · 머리 칸)은 버리지 않는다',
    mixed.cycles['2026-12-08']?.aio?.sent === 1 && mixed.cycles['2026-12-08']?.aio?.followUps === 2 && mixed.cycles['2026-12-08']?.index?.sent === 200 &&
      JSON.stringify(mixed.cycles['2026-12-08']?.future) === JSON.stringify({ sent: 5, note: 'x' }) && JSON.stringify(mixed.budget) === JSON.stringify({ note: '나중 판의 칸' }),
    mixed,
  )
  accountBody = account({ plan_renewal_date: '2027-01-08' })
  await serp.serpAccount({ fresh: true })
  await okSearch('cycle1')
  const rolled = readLedger()
  ok(
    '결제 주기 — 갱신일이 바뀌면 새 주기로 세어 색인 몫이 다시 찬다(앞 주기 기록은 그대로)',
    rolled.cycles['2027-01-08']?.index?.sent === 1 && rolled.cycles['2026-12-08']?.index?.sent === 200,
    rolled.cycles,
  )
  const many: Record<string, unknown> = {}
  for (let m = 3; m <= 12; m += 1) many[`2026-${String(m).padStart(2, '0')}-08`] = { index: { sent: m } }
  writeFileSync(LEDGER, JSON.stringify({ format: 'serpapi-usage/1', cycles: many, pending: [] }))
  await okSearch('prune1')
  const pruned = Object.keys(readLedger().cycles).sort()
  ok(
    '장부 — 최근 6주기만 둔다(지금 주기 포함)',
    JSON.stringify(pruned) === JSON.stringify(['2026-08-08', '2026-09-08', '2026-10-08', '2026-11-08', '2026-12-08', '2027-01-08']),
    pruned,
  )

  // ── 9. 깨진 장부 — 부르지 않고 덮어쓰지 않음 ─────────────────────────────────
  const broken: [string, string][] = [
    ['JSON 아님', '{not json'],
    ['모르는 형식', JSON.stringify({ format: 'serpapi-usage/9', cycles: {}, pending: [] })],
    ['sent 음수', JSON.stringify({ format: 'serpapi-usage/1', cycles: { '2027-01-08': { index: { sent: -1 } } }, pending: [] })],
    ['sent 소수', JSON.stringify({ format: 'serpapi-usage/1', cycles: { '2027-01-08': { index: { sent: 1.5 } } }, pending: [] })],
    ['pending 배열 아님', JSON.stringify({ format: 'serpapi-usage/1', cycles: {}, pending: {} })],
  ]
  for (const [label, text] of broken) {
    writeFileSync(LEDGER, text)
    const before = searches().length
    const e = await caught(okSearch('broken'))
    const v = await serp.serpApiAccountView()
    ok(`깨진 장부(${label}) — ledger · 보내지 않음 · 파일 그대로 · 계정 보기는 usageError`, e?.kind === 'ledger' && searches().length === before && readFileSync(LEDGER, 'utf8') === text && typeof v.usageError === 'string' && v.usage === null, { e, usageError: v.usageError })
  }
  unlinkSync(LEDGER)

  // ── 10. 계정이 막는 경우 — 보내지 않음 ──────────────────────────────────────
  const blockers: [string, Record<string, unknown>][] = [
    ['Active 아님', { account_status: 'Suspended' }],
    ['갱신일 없음', { plan_renewal_date: null }],
    ['갱신일 모양이 다름', { plan_renewal_date: 'Dec 8, 2026' }],
    ['월 검색 수 없음', { searches_per_month: undefined }],
    ['남은 수 없음', { total_searches_left: 'many' }],
    ['시간당 한도 없음', { account_rate_limit_per_hour: undefined }],
  ]
  for (const [label, over] of blockers) {
    accountBody = account(over)
    await serp.serpAccount({ fresh: true })
    const before = searches().length
    const e = await caught(okSearch('blocked'))
    const v = await serp.serpApiAccountView()
    ok(`계정(${label}) — account · 보내지 않음 · 계정 보기에 까닭`, e?.kind === 'account' && searches().length === before && v.accountError?.kind === 'account' && (v.usage === null || v.usage.features.index.allowed === 0), { e, accountError: v.accountError })
  }
  ok('계정 — Active가 아니면 그렇게 알린다', errors.some((e) => e.kind === 'account' && e.message.includes('활성')))
  ok('계정 — 갱신일을 못 읽으면 그렇게 알린다', errors.some((e) => e.kind === 'account' && e.message.includes('갱신일')))
  accountBody = account()
  accountMode = 'slow'
  const ta = Date.now()
  const accountTimeout = await caught(serp.serpAccount({ fresh: true }))
  const accountMs = Date.now() - ta
  ok('계정 — 시간 초과(5초, 시험은 짧게)면 account · 검색도 시작 안 함', accountTimeout?.kind === 'account' && accountMs < 3500 && (await caught(okSearch('after-timeout')))?.kind === 'account', { accountTimeout, accountMs })
  accountMode = 'e401'
  const account401 = await caught(serp.serpAccount({ fresh: true }))
  ok(
    '계정 — 401이면 키가 맞지 않는다고 고칠 곳(%APPDATA%\\brand-aeo-app\\.env의 SERPAPI_API_KEY) · 다시 켜기를 알린다(kind account — 검색은 나가지 않음)',
    account401?.kind === 'account' && account401.message.includes('키가 맞지 않아요') && account401.message.includes('%APPDATA%\\brand-aeo-app\\.env') && account401.message.includes('SERPAPI_API_KEY') && account401.message.includes('다시 켜'),
    account401?.message,
  )
  accountMode = 'ok'

  // ── 11. 요청 모양 — 앱 문제는 보내지 않음 ────────────────────────────────────
  const beforeBad = searches().length
  const badParams = [
    await caught(serp.serpSearch('index', { engine: 'google', q: 'x', api_key: 'other' })),
    await caught(serp.serpSearch('index', { q: 'x' })),
    await caught(serp.serpSearch('index', { engine: 'google', q: 'x', async: 'true' })),
    await caught(serp.serpSearch('nope' as 'index', { engine: 'google', q: 'x' })),
  ]
  ok('요청 모양 — api_key · async를 넘기거나 engine이 없거나 모르는 기능이면 보내지 않는다', badParams.every((e) => e !== null && ['bad-request', 'config'].includes(e.kind)) && searches().length === beforeBad, badParams)

  // ── 12. 끊김 — 응답을 기다리는 사이 프로세스가 죽어도 덜 세지 않는다 ─────────────
  await serp.serpAccount({ fresh: true })
  // 자식이 잠금을 잡고 보낸다 — 이 프로세스는 놓아 둔다(두 프로세스가 한꺼번에 잡지 못한다).
  await held?.()
  const self = fileURLToPath(import.meta.url)
  let childLog = ''
  const child = spawn(process.execPath, ['--import', 'tsx', self, '--child-hang'], { cwd: process.cwd(), env: { ...process.env, SERPAPI_TIMEOUT_MS: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  child.stdout?.on('data', (d: Buffer) => (childLog += d.toString()))
  child.stderr?.on('data', (d: Buffer) => (childLog += d.toString()))
  for (let i = 0; i < 80 && !searches().some((s) => s.q === 'hang'); i += 1) await sleep(250)
  const hangLedger = existsSync(LEDGER) ? readLedger() : null
  ok('끊김 — 요청이 닿은 때 장부에 sent 1 · pending 1', hangLedger?.cycles['2026-12-08']?.index?.sent === 1 && hangLedger.pending.length === 1, { hangLedger, childLog })
  const whileChild = await serp.claimSerpRun('index')
  await serp.serpApiAccountView()
  ok(
    '두 프로세스 — 자식이 잡은 동안 이 프로세스는 잠금을 못 잡고, 계정 보기도 자식의 pending을 지우지 않는다(덜 세지 않게)',
    whileChild === null && (await serp.serpRunElsewhere()) === 'index' && readLedger().pending.length === 1 && readLedger().cycles['2026-12-08']?.index?.sent === 1,
    readLedger(),
  )
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill()
  await exited
  const afterKill = await serp.serpApiAccountView()
  const cleaned = readLedger()
  ok(
    '끊김 — 다음 시작 때 남은 pending은 지우고 sent는 그대로(장부 ≥ 가짜 서버가 받은 수)',
    cleaned.pending.length === 0 && (cleaned.cycles['2026-12-08']?.index?.sent ?? 0) >= searches().filter((s) => s.q === 'hang').length &&
      cleaned.cycles['2026-12-08']?.index?.sent === 1 && afterKill.usage?.features.index.sent === 1,
    cleaned,
  )
  held = await serp.claimSerpRun('index')
  ok('끊김 — 죽은 자식의 잠금은 넘겨받는다', held !== null && (await serp.serpRunElsewhere()) === null)
  await held?.()

  // ── 13. 키 · 요청 주소는 어디에도 남지 않는다 ────────────────────────────────
  const leakIn = (t: string) => t.includes(FAKE_KEY) || t.includes(encodeURIComponent(FAKE_KEY)) || t.includes('api_key=')
  ok('키 — 오류 글자 · 장부 · 로그 · 자식 로그 어디에도 없고 요청 주소도 없다', errors.every((e) => !leakIn(e.text)) && !leakIn(existsSync(LEDGER) ? readFileSync(LEDGER, 'utf8') : '') && consoleText.every((t) => !leakIn(t)) && !leakIn(childLog), {
    errors: errors.filter((e) => leakIn(e.text)).map((e) => e.message),
    console: consoleText.filter(leakIn),
  })
  ok('가짜 서버가 받은 모든 요청은 가짜 키였다', seen.every((s) => s.keyOk))

  // ── 14. 앱 서버 — GET /api/serpapi/account · /api/health serpApi ──────────────
  const GUARD = `data:text/javascript,${encodeURIComponent(
    [
      'const real = globalThis.fetch;',
      'globalThis.fetch = (input, init) => {',
      "  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;",
      "  const host = URL.canParse(href) ? new URL(href).hostname : '';",
      '  if (/(^|\\.)serpapi\\.com$/i.test(host)) {',
      "    process.stderr.write('VERIFY-GUARD blocked a real SerpAPI request\\n');",
      "    return Promise.reject(new Error('verify guard'));",
      '  }',
      '  return real(input, init);',
      '};',
    ].join('\n'),
  )}`
  let logs = ''
  const start = async (over: Record<string, string>): Promise<ChildProcess> => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      APP_DATA_DIR: dir2,
      PORT: String(APP_PORT),
      USE_MOCK_ENGINES: 'true',
      DOTENV_CONFIG_PATH: path.join(dir2, 'no-such.env'),
      BLOB_READ_WRITE_TOKEN: '',
      BLOB_STORE_ID: '',
      PIPELINE_CRON: '',
      GH_MEASURE_TOKEN: '',
      SERPAPI_API_KEY: FAKE_KEY,
      SERPAPI_BASE_URL: MOCK_BASE,
      SERPAPI_TIMEOUT_MS: '1500',
      ...over,
    }
    delete env.AEO_SERVER_HOST
    const srv = spawn(process.execPath, ['--import', GUARD, '--import', 'tsx', 'server/index.ts'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(srv)
    srv.stdout?.on('data', (d: Buffer) => (logs += d.toString()))
    srv.stderr?.on('data', (d: Buffer) => (logs += d.toString()))
    for (let i = 0; i < 120; i += 1) {
      if (await fetch(`${APP_BASE}/api/health`).then((r) => r.ok, () => false)) return srv
      await sleep(500)
    }
    throw new Error(`앱 서버가 뜨지 않았습니다:\n${logs.slice(-2000)}`)
  }
  const stop = async (srv: ChildProcess) => {
    const gone = new Promise<void>((resolve) => (srv.exitCode !== null ? resolve() : srv.once('exit', () => resolve())))
    srv.kill()
    await gone
    for (let i = 0; i < 20 && !(await portFree(APP_PORT)); i += 1) await sleep(250)
  }
  const bodies: string[] = []
  const getJson = async (p: string) => {
    const res = await fetch(`${APP_BASE}${p}`)
    const text = await res.text()
    bodies.push(text)
    return { status: res.status, body: JSON.parse(text || '{}') as Record<string, unknown> }
  }
  type View = Awaited<ReturnType<typeof serp.serpApiAccountView>>

  accountBody = account()
  writeFileSync(
    LEDGER2,
    JSON.stringify({
      format: 'serpapi-usage/1',
      cycles: { '2026-12-08': { index: { sent: 7 }, aio: { sent: 3, followUps: 1 }, future: { sent: 2 } } },
      pending: [{ id: 'p-left-over', feature: 'index', at: '2026-11-10T00:00:00.000Z' }],
    }),
  )
  const searchesBeforeServer = searches().length
  const accountBeforeServer = accountCalls()
  const app1 = await start({})
  try {
    const health = await getJson('/api/health')
    ok('서버 — /api/health serpApi true(값은 없이)', health.status === 200 && health.body.serpApi === true)
    const r = await getJson('/api/serpapi/account')
    const v = r.body as unknown as View
    ok(
      '서버 — GET /api/serpapi/account: 허용 칸 · 몫 · 이 PC 장부(기능별)',
      r.status === 200 && v.configured === true && v.configError === null && v.account?.planName === 'Starter' &&
        JSON.stringify(Object.keys(v.account ?? {}).sort()) === JSON.stringify(ACCOUNT_KEYS) &&
        v.usage?.cycle === '2026-12-08' && v.usage.features.index.sent === 7 && v.usage.features.index.cap === 200 && v.usage.features.index.left === 193 &&
        v.usage.features.aio.sent === 3 && v.usage.features.aio.left === 247 && v.budget.searches?.floor === 500,
      r,
    )
    ok('서버 — 계정 보기는 검색하지 않는다(계정만 1번)', searches().length === searchesBeforeServer && accountCalls() === accountBeforeServer + 1)
    const l2 = readLedger(LEDGER2)
    ok('서버 — 시작 뒤 첫 읽기에서 끊긴 pending을 지우고 모르는 칸은 남긴다', l2.pending.length === 0 && l2.cycles['2026-12-08']?.index?.sent === 7 && JSON.stringify(l2.cycles['2026-12-08']?.future) === JSON.stringify({ sent: 2 }))
    // DNS 리바인딩 — 브라우저가 보기엔 같은 출처지만 Host · Origin이 이 PC가 아니다. 계정도 부르지 않는다.
    const rawGet = (p: string, headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const rq = http.request({ host: '127.0.0.1', port: APP_PORT, path: p, method: 'GET', headers }, (rs) => {
          rs.resume()
          rs.on('end', () => resolve(rs.statusCode ?? 0))
        })
        rq.on('error', reject)
        rq.end()
      })
    const accountBeforeRebind = accountCalls()
    const rebind = [
      await rawGet('/api/serpapi/account', { Host: `rebind.attacker.example:${APP_PORT}` }),
      await rawGet('/api/serpapi/account', { Host: `127.0.0.1:${APP_PORT}`, Origin: 'http://evil.example' }),
      await rawGet('/api/serpapi/account', { Host: `localhost:${APP_PORT}`, Origin: `http://localhost:${APP_PORT}` }),
    ]
    ok('서버 — Host · Origin이 이 PC가 아니면 403(계정도 부르지 않음), 이 PC면 그대로', JSON.stringify(rebind) === JSON.stringify([403, 403, 200]) && accountCalls() === accountBeforeRebind, rebind)
    writeFileSync(LEDGER2, '{broken')
    const rb = await getJson('/api/serpapi/account')
    ok('서버 — 깨진 장부는 usageError로 알리고 덮어쓰지 않는다', rb.status === 200 && typeof rb.body.usageError === 'string' && rb.body.usage === null && readFileSync(LEDGER2, 'utf8') === '{broken')
  } finally {
    await stop(app1)
  }

  const callsBeforeOff = seen.length
  const app2 = await start({ SERPAPI_API_KEY: '' })
  try {
    const health = await getJson('/api/health')
    const r = await getJson('/api/serpapi/account')
    ok('서버(키 없음) — serpApi false · configured false · 계정 null', health.body.serpApi === false && r.status === 200 && r.body.configured === false && r.body.account === null)
  } finally {
    await stop(app2)
  }
  const app3 = await start({ SERPAPI_BASE_URL: 'http://localhost:4196' })
  try {
    const r = await getJson('/api/serpapi/account')
    ok('서버(막힌 쪽 주소) — configError · 계정 null', r.status === 200 && typeof r.body.configError === 'string' && r.body.account === null)
  } finally {
    await stop(app3)
  }
  ok('서버(키 없음 · 막힌 쪽 주소) — 가짜 서버가 받은 것이 없다', seen.length === callsBeforeOff)
  ok('서버 — 응답 · 로그 어디에도 키가 없고, 진짜 SerpAPI로 가려던 요청도 없다', [...bodies, logs].every((t) => !leakIn(t)) && !logs.includes('VERIFY-GUARD'), logs.slice(-1500))

  // ── 15. 설치본 묶음 · 저장소 ────────────────────────────────────────────────
  const buildScript = readFileSync(path.join(process.cwd(), 'scripts', 'build-electron-server.mjs'), 'utf8')
  ok(
    '설치본 — 서버 묶음 빌드가 SerpAPI 시험 전용 env를 이름째 지우고, 진짜 주소 허락(SERPAPI_LIVE)은 1로 박는다',
    buildScript.includes("const SERPAPI_TEST_ENV = ['SERPAPI_BASE_URL', 'SERPAPI_TIMEOUT_MS']") &&
      buildScript.includes("for (const name of SERPAPI_TEST_ENV) serverBuild.define[`process.env.${name}`] = 'undefined'") &&
      buildScript.includes("serverBuild.define['process.env.SERPAPI_LIVE'] = '\"1\"'") &&
      buildScript.includes("define: { 'process.env.POST_IMPORT_TEST_LOOPBACK': 'undefined' }"),
  )
  const { build } = await import('esbuild')
  const bundle = async (define: Record<string, string>) =>
    (await build({ entryPoints: ['server/index.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node20', packages: 'external', write: false, logLevel: 'silent', define })).outputFiles[0]!.text
  const packed = await bundle({
    'process.env.POST_IMPORT_TEST_LOOPBACK': 'undefined',
    'process.env.SERPAPI_BASE_URL': 'undefined',
    'process.env.SERPAPI_TIMEOUT_MS': 'undefined',
    'process.env.SERPAPI_LIVE': '"1"',
  })
  const plain = await bundle({})
  ok(
    '설치본 — 그 define으로 묶으면 SERPAPI_BASE_URL · SERPAPI_TIMEOUT_MS 글자 · SERPAPI_LIVE 읽기가 없고 진짜 주소 · 키 이름 · 장부 · 잠금은 남는다',
    !packed.includes('SERPAPI_BASE_URL') && !packed.includes('SERPAPI_TIMEOUT_MS') && !packed.includes('process.env.SERPAPI_LIVE') && packed.includes('https://serpapi.com') && packed.includes('SERPAPI_API_KEY') &&
      packed.includes('serpapi-usage.json') && packed.includes('serpapi-run.lock') && plain.includes('SERPAPI_BASE_URL') && plain.includes('process.env.SERPAPI_LIVE'),
  )
  ok(
    '.gitignore — dev 장부 · 잠금(server/serpapi-usage.json · server/serpapi-run.lock)을 올리지 않는다',
    ['server/serpapi-usage.json', 'server/serpapi-run.lock'].every((l) => readFileSync('.gitignore', 'utf8').split(/\r?\n/).includes(l)),
  )
  ok('웹 함수는 그대로 12개(api/)', execSync('git ls-files api', { encoding: 'utf8' }).trim().split(/\r?\n/).length === 12)
  ok('이 프로세스의 fetch가 127.0.0.1 밖으로 나가려 한 적이 없다', blocked.length === 0, blocked)
} finally {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill()
  mock.closeAllConnections()
  mock.close()
  rmSync(dir, { recursive: true, force: true })
  rmSync(dir2, { recursive: true, force: true })
}

console.warn = origWarn
console.error = origError
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
