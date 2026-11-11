/**
 * 구글 AI 개요(시범) 화면(src/pages/GoogleAio.tsx · src/lib/api.ts 구글 AI 개요 절)을 확인한다.
 *
 * 안전 규칙: 서버를 띄우지 않는다. jsdom과 가짜 fetch만 쓰고, 가짜 fetch는 /api/ 밖으로 가는 요청을 막고 기록한다(진짜 SerpAPI · LLM은 물론 어떤
 * 바깥 주소도 부르지 않는다). 브랜드 · 질문 · 주소 · 제목은 모두 가짜다. 회차 · 지표 모양은 규칙 모듈(src/lib/googleAio.ts)로 만든다 — 서버가 주는
 * 모양과 같다. 작성자는 키(w2)만 쓰고, 이름 칸에 가짜 이름을 넣어 화면 어디에도 나오지 않는지 본다.
 *
 * 무엇을 보나:
 *   웹(404) · 브랜드 없음(tenant not found) · 키 없음 · 연결 설정 틀림 · 설정 파일 깨짐 · 시범 브랜드 아님 · 이 PC 꺼짐 → 켜기 확인창(같은 계정) ·
 *   계획 → 확인창 숫자(몫 분모는 계정 · 장부 값 그대로, 최대 검색 M · 판정 엔진 · 시간 · 앱을 켜 두세요 · 이미 낸 요금 안 · 지난 회차 · 14일 경고) →
 *   실행(JSON planId) → 진행(role=status · 2초마다) → 끝 · 중단(JSON) · 멈춘 까닭(role=alert) · 막힘(몫) · 409(측정 중 · 계획 바뀜 · 도는 중 · 다른 창) ·
 *   다시 판정 확인창(판정 최대 n회 · 엔진 · 검색 0회) · 확인 불가(분모 0) · 질문 표 칸 기호 aria-label · k/N · 출처 없는 개요 · 읽지 못한 회차 ·
 *   흔들림 안내 · 노출 급락 경고 · 판정 비용(생각 토큰 포함) · 회차 자세히(http(s) 링크만) · 올린 글 표(작성자 키만) · 키보드 포커스 · 바깥 요청 0 ·
 *   계정(account.json) 읽기는 계획 때만.
 *
 *   npx tsx scripts/verify-google-aio-ui.ts
 */
import {
  AIO_CELL,
  AIO_NOISE_NOTE,
  GOOGLE_AIO_FORMAT,
  aioConditions,
  aioMaxSearches,
  aioPostRows,
  aioPostsUpDuring,
  aioQuestionSet,
  aioRunId,
  aioSourceMarks,
  aioView,
  sourceOnlyOf,
  summarizeAioRun,
  type AioItem,
  type AioReadContext,
  type AioRun,
  type AioRunState,
  type AioView,
} from '../src/lib/googleAio'
import { trackingKey } from '../src/lib/publishedUrl'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean, detail?: unknown) => {
  checks.push([label, cond])
  if (!cond && detail !== undefined) console.error(`  ✗ ${label}:`, typeof detail === 'string' ? detail.slice(0, 3000) : JSON.stringify(detail, null, 1).slice(0, 3000))
}

// ── 가짜 회차 · 지표(규칙 모듈로 만든다) ──────────────────────────────────────────────────────────
const TENANT = 'vaio-ui'
const WRITER_NAME = '가짜작성자이름'
const LOCATION = 'Gunsan-si,Jeollabuk-do,South Korea'
const OWNED = 'https://fake-stay-ui.example/rooms'
const POST_W2 = 'https://fakewriter2.tistory.com/12'
const POST_EXT = 'https://fake-hand-ui.example.net/posts/3'
const IDS = ['q-001', 'q-002', 'q-003', 'q-004', 'q-005', 'q-006']
const TEXT: Record<string, string> = {
  'q-001': '가짜 군산 숙소 추천해 줘',
  'q-002': '가짜 군산 한옥 숙소',
  'q-003': '가짜 군산 가족 여행 숙소',
  'q-004': '가짜 군산 바다 보이는 숙소',
  'q-005': '가짜 군산 조용한 숙소',
  'q-006': '가짜 군산 오래된 동네 숙소',
}
const QSET = aioQuestionSet(IDS.map((id) => ({ questionId: id, text: TEXT[id]! })))
const refsOf = (...links: string[]) => links.map((link, index) => ({ index, title: `가짜 출처 ${index + 1}`, link, source: `가짜출처${index + 1}` }))
const judged = (m: boolean | null, extra: Partial<AioItem> = {}): Partial<AioItem> => ({ mentioned: m, judgeEngine: 'gemini', judgeModel: 'gemini-fake-ui', judgedAt: '2026-11-10T01:06:00.000Z', ...extra })
function mkRun(startedAt: string, state: AioRunState, items: [string, AioItem['status'], Partial<AioItem>?][], extra: Partial<AioRun> = {}): AioRun {
  const at = new Date(Date.parse(startedAt) + 120_000).toISOString()
  return {
    format: GOOGLE_AIO_FORMAT,
    runId: aioRunId(new Date(startedAt)),
    tenantId: TENANT,
    startedAt,
    finishedAt: state === 'running' ? null : new Date(Date.parse(startedAt) + 600_000).toISOString(),
    state,
    stopReason: null,
    stopMessage: null,
    conditions: aioConditions({ startedAt, location: LOCATION, bankVersion: 'v6', questionSet: QSET, judgeEngine: 'gemini', judgeModel: null }),
    bankVersion: 'v6',
    cohortBank: null,
    questionSet: QSET,
    maxSearches: aioMaxSearches(IDS.length),
    cycle: '2026-12-08',
    usage: { searches: 9, followUps: 2, reSearches: 0, judgeCalls: 4, judgeTokens: { input: 100_000, output: 10_000, thought: 30_000 } },
    items: items.map(([id, status, x]) => ({ questionId: id, query: TEXT[id]!, status, fetchedAt: at, searches: status === 'shown' ? 2 : 1, ...(x ?? {}) })),
    ...extra,
  }
}
const R_OLD = mkRun('2026-11-03T01:00:00.000Z', 'done', [
  ['q-001', 'shown', { ...judged(true), text: '가짜스테이를 추천해요.', references: refsOf(OWNED) }],
  ['q-002', 'shown', { ...judged(false), text: '가짜 한옥 안내.', references: refsOf('https://x-ui.example.com/1') }],
  ['q-003', 'absent'],
  ['q-004', 'absent'],
  ['q-005', 'shown', { ...judged(false), text: '출처 없는 가짜 개요.' }],
  ['q-006', 'absent'],
])
const R_DONE = mkRun('2026-11-10T01:00:00.000Z', 'done', [
  ['q-001', 'shown', { ...judged(true, { competitorMentions: [{ name: '경쟁가짜민박', count: 1 }] }), text: '가짜스테이와 경쟁가짜민박이 있어요.', references: refsOf(POST_W2, 'https://x-ui.example.com/2') }],
  ['q-002', 'shown', { ...judged(null), text: '판정 못 한 가짜 개요.', references: refsOf('https://x-ui.example.com/3') }],
  ['q-003', 'absent', { topKeys: ['search_metadata', 'organic_results'] }],
  ['q-004', 'unreadable', { reason: 'follow-up-error' }],
  ['q-005', 'failed', { reason: 'timeout', error: '응답이 늦어 끊었어요' }],
  ['q-006', 'shown', { ...judged(false), text: '출처 없는 가짜 개요 둘.' }],
])
const R_NEW = mkRun('2026-11-12T01:00:00.000Z', 'done', [
  ['q-001', 'shown', { ...judged(true), text: '새 회차 가짜 개요.', references: refsOf(OWNED) }],
  ['q-002', 'shown', { ...judged(true), text: '새 회차 가짜 개요 둘.', references: refsOf(POST_W2) }],
  ['q-003', 'absent'],
  ['q-004', 'absent'],
  ['q-005', 'absent'],
  ['q-006', 'absent'],
])
const STOP_MSG = '판정 엔진이 3번 잇따라 답하지 않아 검색을 멈췄어요 — 받은 개요는 저장했어요. 판정 엔진을 확인한 뒤 「다시 판정」을 눌러 주세요. 남은 3문항은 재지 않았어요.'
const R_PART = mkRun('2026-11-11T01:00:00.000Z', 'partial', [['q-001', 'absent'], ['q-002', 'absent'], ['q-003', 'absent']], { stopReason: 'judge', stopMessage: STOP_MSG })
const R_INT = mkRun('2026-11-11T02:00:00.000Z', 'interrupted', [['q-001', 'absent']])
const R_DROP = mkRun('2026-11-17T01:00:00.000Z', 'done', IDS.map((id) => [id, 'absent'] as [string, AioItem['status']]))
const R_NULL = mkRun('2026-11-10T01:00:00.000Z', 'done', IDS.map((id, i) => [id, i % 2 ? 'unreadable' : 'failed', i % 2 ? { reason: 'follow-up-error' } : { reason: 'timeout' }] as [string, AioItem['status'], Partial<AioItem>]))

const ledger = [
  { id: 'p-w2', url: POST_W2, key: trackingKey(POST_W2)!, publishedOn: '2026-11-05', publishedOnSource: 'user', recordedAt: '2026-11-05T03:00:00.000Z', articleId: 'topic:w2', articleTitle: '가짜 글 W2' },
  { id: 'p-nm', url: 'https://fakewriter9.tistory.com/1', key: trackingKey('https://fakewriter9.tistory.com/1')!, publishedOn: '2026-11-04', publishedOnSource: 'user', recordedAt: '2026-11-04T03:00:00.000Z', articleId: 'topic:nm', articleTitle: '가짜 글 이름' },
]
const external = [{ id: 'x-000000000011', url: POST_EXT, key: trackingKey(POST_EXT)!, title: '가짜 앱 밖 글', publishedOn: '2026-11-02', publishedOnSource: 'page' as const, trackedAt: '2026-11-02T01:00:00.000Z' }]
// 작성자 키 자리에 이름이 와도 규칙 모듈이 싣지 않는다(w1~w8 꼴만) — 화면 시험도 그 결과로 그린다.
const POSTS = aioPostRows(ledger, external, (p) => (p.articleId === 'topic:w2' ? 'w2' : WRITER_NAME))
const CTX: AioReadContext = { brandName: '가짜스테이', aliases: ['가짜 스테이'], ownedDomains: ['fake-stay-ui.example'], competitors: ['경쟁가짜민박'], posts: POSTS }
const viewOf = (runs: AioRun[], unreadableRuns = 0): AioView => aioView(runs, CTX, { unreadableRuns })
const VIEW = viewOf([R_OLD, R_DONE], 1)
const VIEW_NEW = viewOf([R_OLD, R_DONE, R_NEW], 1)
const VIEW_PART = viewOf([R_OLD, R_DONE, R_PART])
const VIEW_INT = viewOf([R_OLD, R_DONE, R_INT])
const VIEW_DROP = viewOf([R_OLD, R_DONE, R_DROP])
const VIEW_NULL = viewOf([R_NULL])

const detailOf = (run: AioRun) => {
  const { items, ...rest } = run
  const up = aioPostsUpDuring(run, POSTS)
  return {
    run: rest,
    summary: summarizeAioRun(run, CTX),
    items: items.map(({ rawBlock, ...i }) => {
      const sources = aioSourceMarks(i, CTX.ownedDomains, up)
      // 서버는 http(s)만 싣는다 — 화면도 http(s)가 아니면 링크로 그리지 않는지 본다.
      if (i.questionId === 'q-002') sources.push({ kind: 'link', link: 'javascript:alert(1)', title: '가짜 위험 링크', source: null, owned: false, post: null, variant: false })
      return { ...i, hasRawBlock: rawBlock !== undefined, sources, sourceOnly: sourceOnlyOf(i, CTX) }
    }),
    postsUnreadable: false,
  }
}

const JUDGE = { engine: 'gemini', label: 'Gemini', ready: true, problem: null }
const status = (over: Record<string, unknown> = {}) => ({
  tenantId: TENANT,
  enabled: true,
  settingsError: null,
  pilot: true,
  pilotMessage: null,
  location: LOCATION,
  signature: 'google-aio serpapi hl=ko gl=kr dom=google.co.kr loc=Gunsan-si,Jeollabuk-do,South Korea dev=desktop cache=off',
  configured: true,
  configError: null,
  judge: JUDGE,
  measuring: false,
  running: null,
  runningElsewhere: false,
  busy: null,
  rejudging: null,
  rejudged: null,
  view: VIEW,
  unreadableRuns: 1,
  lastRunAt: R_DONE.startedAt,
  resumable: null,
  ...over,
})
// 몫 · 계정 숫자는 일부러 흔하지 않은 값 — 화면이 250 · 500 같은 글자를 박지 않고 계정 · 장부 값을 그대로 쓰는지 본다.
const QUOTA = { cycle: '2026-12-08', cap: 237, sent: 36, left: 201, allowed: 188, floor: 512, accountLeft: 873, aboveFloor: 361, hourLeft: 188, planName: 'Starter', searchesPerMonth: 1000, rateLimitPerHour: 200, planRenewalDate: '2026-12-08' }
const plan = (over: Record<string, unknown> = {}) => ({
  planId: 'plan-aio-ui-1',
  expiresAt: '2026-11-11T05:10:00.000Z',
  tenantId: TENANT,
  resume: null,
  questions: 50,
  totalQuestions: 50,
  maxSearches: 110,
  maxJudgeCalls: 50,
  judge: JUDGE,
  location: LOCATION,
  signature: 'google-aio serpapi',
  bankLabel: 'v6 · 이름 없는 50문항 #ab12cd',
  quota: QUOTA,
  perSearchUsd: 0.025,
  expectedMinutes: [5, 13],
  lastRunAt: '2026-11-03T01:00:00.000Z',
  daysSinceLastRun: 8,
  recent: true,
  blocked: null,
  ...over,
})
const progress = (over: Record<string, unknown> = {}) => ({
  runId: '2026-11-11T05-00-00-000Z',
  startedAt: '2026-11-11T05:00:00.000Z',
  resumed: false,
  planned: 50,
  done: 3,
  totalQuestions: 50,
  searches: 7,
  maxSearches: 110,
  shown: 2,
  absent: 1,
  unreadable: 0,
  failed: 0,
  judgeUnknown: 1,
  cancelling: false,
  ...over,
})
const PRICING = { currency: 'USD', updatedAt: '2026-11-01T00:00:00.000Z', engines: { gemini: { inputPerM: 0.3, outputPerM: 2.5 } } }
const MEASURING = '브랜드 측정이 도는 중이라 시작하지 않았어요 — 측정이 끝난 뒤 다시 눌러 주세요(판정 엔진을 함께 써요).'

{
  const realFetch = globalThis.fetch
  try {
    const React = await import('react')
    const { JSDOM } = await import('jsdom')
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1/' })
    // 확인창(components/ConfirmDialog.tsx)이 HTMLElement · Node를 전역으로 본다.
    Object.assign(globalThis, { React, window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })
    const { createRoot } = await import('react-dom/client')
    const { MemoryRouter } = await import('react-router-dom')
    const { TenantContext } = await import('../src/context/tenant-context')
    const { default: GoogleAioPage } = await import('../src/pages/GoogleAio')
    const { kstStamp } = await import('../src/lib/runTrend')
    const doc = dom.window.document

    type Asked = { method: string; path: string; type: string | null; body: unknown }
    type Reply = { status: number; body: unknown }
    const asked: Asked[] = []
    const outside: string[] = []
    let reply: (a: Asked) => Reply = () => ({ status: 404, body: 'Not Found' })
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!url.startsWith('/api/')) {
        outside.push(url)
        throw new TypeError('verify guard: /api/ 밖으로 나가는 요청을 막았습니다')
      }
      const headers = (init?.headers ?? {}) as Record<string, string>
      const a: Asked = { method: (init?.method ?? 'GET').toUpperCase(), path: url.split('?')[0]!, type: headers['Content-Type'] ?? null, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null }
      asked.push(a)
      const r = reply(a)
      const json = typeof r.body !== 'string'
      return new Response(json ? JSON.stringify(r.body) : String(r.body), { status: r.status, headers: { 'Content-Type': json ? 'application/json' : 'text/html' } })
    }) as typeof fetch

    const tenant = { tenantId: TENANT, brandName: '가짜스테이', aliases: ['가짜 스테이'], ownedDomains: ['fake-stay-ui.example'], industry: '가짜숙소', region: '전북 군산', engines: ['gemini'], questionBankSize: 6, competitors: ['경쟁가짜민박'] }
    const ctx = {
      tenants: [tenant],
      tenantId: TENANT,
      setTenantId: () => {},
      tenant,
      customer: tenant,
      viewing: null,
      viewCompetitor: async () => {},
      exitCompetitorView: () => {},
      loading: false,
      error: null,
      reloadTenants: async () => [tenant],
    }
    const host = doc.getElementById('root')!
    let root: ReturnType<typeof createRoot> | null = null
    const settle = async (n = 3) => {
      for (let i = 0; i < n; i += 1) await React.act(async () => new Promise((r) => setTimeout(r, 30)))
    }
    const waitFor = async (cond: () => boolean, ms = 7000) => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        if (cond()) return true
        await settle(1)
      }
      return cond()
    }
    const click = async (el: Element | null | undefined) => {
      if (!el) throw new Error('누를 것을 찾지 못했다')
      await React.act(async () => (el as HTMLElement).click())
      await settle()
    }
    const key = async (k: string) => {
      await React.act(async () => {
        dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true }))
      })
      await settle()
    }
    const text = () => host.textContent ?? ''
    const buttonNamed = (t: string, within: ParentNode = doc) => [...within.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(t))
    const alerts = () => [...host.querySelectorAll('[role="alert"]')].map((p) => p.textContent ?? '').join(' | ')
    const dialog = () => doc.querySelector('[role="dialog"]')
    const dialogText = () => dialog()?.textContent ?? ''
    const progressEl = () => doc.getElementById('gaio-progress')
    const tiles = () => [...host.querySelectorAll('.gaio-tile')].map((t) => ({ label: t.querySelector('.gaio-tile-label')?.textContent ?? '', value: t.querySelector('.gaio-tile-value')?.textContent ?? '', sub: t.querySelector('.gaio-tile-sub')?.textContent ?? '' }))
    const tile = (label: string) => tiles().find((t) => t.label.includes(label))
    const sent = (method: string, p: string) => asked.filter((a) => a.method === method && a.path === p)
    const P = `/api/google-aio/${TENANT}`
    const mount = async (handler: (a: Asked) => Reply) => {
      reply = handler
      const next = createRoot(host)
      root = next
      await React.act(async () =>
        next.render(React.createElement(TenantContext.Provider, { value: ctx }, React.createElement(MemoryRouter, { initialEntries: ['/google-aio'] }, React.createElement(GoogleAioPage)))),
      )
      await settle(4)
    }
    const unmount = async () => {
      await React.act(async () => root?.unmount())
      asked.length = 0
    }
    let st: Record<string, unknown> = status()
    let planReply: Reply = { status: 200, body: plan() }
    let runReply: Reply = { status: 202, body: { runId: '2026-11-11T05-00-00-000Z', planned: 50, maxSearches: 110, resumed: false } }
    let rejudgeReply: Reply = { status: 202, body: { runId: R_DONE.runId, total: 1 } }
    const live = (a: Asked): Reply => {
      if (a.path === P && a.method === 'GET') return { status: 200, body: st }
      if (a.path === `${P}/plan`) return planReply
      if (a.path === `${P}/run`) {
        if (runReply.status === 202) st = { ...st, running: progress(), view: null }
        return runReply
      }
      if (a.path === `${P}/runs/${R_DONE.runId}`) return { status: 200, body: detailOf(R_DONE) }
      if (a.path.endsWith('/cancel')) {
        st = { ...st, running: progress({ cancelling: true }) }
        return { status: 200, body: { cancelling: true } }
      }
      if (a.path.endsWith('/rejudge')) {
        if (rejudgeReply.status === 202) st = { ...st, rejudging: { runId: R_DONE.runId, total: 1, done: 0 }, view: null }
        return rejudgeReply
      }
      if (a.path === '/api/google-aio/settings') {
        st = { ...st, enabled: (a.body as { enabled: boolean }).enabled }
        return { status: 200, body: { settings: { enabled: (a.body as { enabled: boolean }).enabled } } }
      }
      if (a.path === '/api/engine-pricing') return { status: 200, body: PRICING }
      return { status: 404, body: 'Not Found' }
    }

    // (가) 웹 — 라우트가 없으면(404) 「데스크톱 앱에서 볼 수 있습니다」, 단추 · 계획 요청 없음.
    await mount(() => ({ status: 404, body: 'Not Found' }))
    ok('웹(404) — 「데스크톱 앱에서 볼 수 있습니다」 · 지금 재기 · 켜기 단추 없음', text().includes('데스크톱 앱에서 볼 수 있습니다') && !buttonNamed('지금 재기') && !buttonNamed('켜기') && alerts() === '', text())
    ok('웹(404) — 계획 · 실행 · 설정 요청을 보내지 않는다', asked.every((a) => a.method === 'GET'), asked)
    ok('화면 머리 — 제목 「구글 AI 개요(시범)」 · 안내(점수 · 정기진단 보고서 · 전주 비교에는 넣지 않음)', (doc.querySelector('h1')?.textContent ?? '') === '구글 AI 개요(시범)' && text().includes('점수 · 정기진단 보고서 · 전주 비교에는 넣지 않습니다'), text())
    await unmount()

    // (나) 브랜드 없음 — 404 tenant not found는 웹이 아니라 오류.
    await mount((a) => (a.path === P ? { status: 404, body: { error: `tenant not found: ${TENANT}` } } : { status: 404, body: 'Not Found' }))
    ok('브랜드 없음(tenant not found) — 오류(role=alert) · 「데스크톱 앱」 안내가 아니다', alerts().includes('찾지 못했어요') && !text().includes('데스크톱 앱에서 볼 수 있습니다') && Boolean(buttonNamed('다시 시도')), [alerts(), text()])
    await unmount()

    // (다) 키 없음 — 넣을 곳 · 다시 켜기, 지금 재기 없음(지난 결과는 보인다).
    st = status({ configured: false })
    await mount(live)
    ok(
      '키 없음 — 「SerpAPI 키가 없어요」 · SERPAPI_API_KEY · 다시 켜기, 지금 재기 · 켜기 단추 없음 · 계획 요청 없음',
      text().includes('SerpAPI 키가 없어요') && text().includes('SERPAPI_API_KEY') && text().includes('다시 켜') && !buttonNamed('지금 재기') && !buttonNamed('이 PC에서 켜기') && sent('POST', `${P}/plan`).length === 0,
      text(),
    )
    ok('키 없음 — 지난 결과(요약 타일)는 그대로 보인다', tiles().length >= 4, tiles())
    await unmount()

    // (라) 연결 설정 틀림 · 설정 파일 깨짐.
    st = status({ configError: 'SerpAPI 연결 주소 설정이 올바르지 않아 시작하지 않았어요 — 가상' })
    await mount(live)
    ok('연결 설정 틀림 — 까닭을 보이고 지금 재기 없음', text().includes('연결 주소 설정이 올바르지 않아') && !buttonNamed('지금 재기'), text())
    await unmount()
    st = status({ settingsError: '이 PC의 구글 AI 개요 시범 설정 파일(google-aio-settings.json)이 깨져 있어 시작하지 않았어요.', pilot: false, pilotMessage: '깨짐', enabled: false })
    await mount(live)
    ok('설정 파일 깨짐 — role=alert, 켜기 · 지금 재기 없음', alerts().includes('설정 파일(google-aio-settings.json)이 깨져') && !buttonNamed('켜기') && !buttonNamed('지금 재기'), [alerts(), text()])
    await unmount()

    // (마) 시범 브랜드 아님 — 안내만(켜기 · 지금 재기 없음).
    st = status({ pilot: false, pilotMessage: '이 브랜드는 시범 대상이 아니에요.', location: null, signature: null, view: null, unreadableRuns: 0, lastRunAt: null })
    await mount(live)
    ok('시범 브랜드 아님 — 「이 브랜드는 시범 대상이 아니에요」 · 켜기 · 지금 재기 없음 · 계획 요청 없음', text().includes('이 브랜드는 시범 대상이 아니에요') && !buttonNamed('켜기') && !buttonNamed('지금 재기') && sent('POST', `${P}/plan`).length === 0, text())
    await unmount()

    // (바) 이 PC 꺼짐 → 켜기 확인창(같은 계정을 나눠 씀) → PUT { enabled: true } → 지금 재기.
    st = status({ enabled: false })
    await mount(live)
    ok('이 PC 꺼짐 — 「이 PC에서는 … 켜지 않았어요」 · 「이 PC에서 켜기」 · 지금 재기 없음', text().includes('켜지 않았어요') && Boolean(buttonNamed('이 PC에서 켜기')) && !buttonNamed('지금 재기'), text())
    const enableBtn = buttonNamed('이 PC에서 켜기')
    enableBtn?.focus()
    await click(enableBtn)
    ok(
      '켜기 확인창 — 검색마다 SerpAPI 사용량 · 같은 계정을 다른 PC · 다른 프로젝트와 나눠 씀 · 켜도 저절로 재지 않음',
      Boolean(dialog()) && dialogText().includes('검색마다 SerpAPI 사용량') && dialogText().includes('같은 계정') && dialogText().includes('다른 PC') && dialogText().includes('저절로 재지 않아요'),
      dialogText(),
    )
    await key('Escape')
    ok('켜기 확인창 — Esc로 닫으면 저장하지 않고 포커스는 켜기 단추로', !dialog() && sent('PUT', '/api/google-aio/settings').length === 0 && doc.activeElement === buttonNamed('이 PC에서 켜기'), doc.activeElement?.outerHTML)
    await click(buttonNamed('이 PC에서 켜기'))
    await click(buttonNamed('이 PC에서 켜기', dialog() ?? doc))
    await waitFor(() => Boolean(buttonNamed('지금 재기')))
    const put = sent('PUT', '/api/google-aio/settings')
    ok('켜기 — JSON 본문 { enabled: true } 하나 · 상태를 다시 읽어 지금 재기가 보인다', put.length === 1 && put[0]?.type === 'application/json' && JSON.stringify(put[0]?.body) === JSON.stringify({ enabled: true }) && Boolean(buttonNamed('지금 재기')) && !dialog(), put)
    ok('켜기 — 계정 · 계획 요청은 없다(계정은 「지금 재기」 계획 때만 읽는다)', sent('POST', `${P}/plan`).length === 0 && asked.every((a) => !a.path.startsWith('/api/serpapi')), asked.map((a) => a.path))
    await unmount()

    // (사) 켜짐 — 결과 · 계획 → 확인창 → 실행 → 진행 → 끝.
    st = status()
    planReply = { status: 200, body: plan() }
    await mount(live)
    const gets0 = sent('GET', P).length
    await settle(80)
    ok('쉬는 동안 — 상태를 되풀이해 묻지 않는다(2초마다 묻는 것은 도는 동안뿐)', sent('GET', P).length === gets0, sent('GET', P).length)
    ok('열기만 해서는 — 계획 · 계정 요청이 없다', sent('POST', `${P}/plan`).length === 0 && asked.every((a) => !a.path.startsWith('/api/serpapi')))

    // 요약 타일 — R_DONE: 있음 3 · 없음 1 · 못 읽음 1 · 오류 1, 언급 1/2(판정 불가 1), 자사 0/2, 올린 글 1/2(올라가 있던 글).
    ok('타일 — AI 개요가 뜬 질문 75%(3/4 · 못 읽음 · 오류는 분모 밖)', tile('AI 개요가 뜬 질문')?.value === '75%' && (tile('AI 개요가 뜬 질문')?.sub ?? '').includes('3/4'), tiles())
    ok('타일 — AI 개요 속 언급 50%(1/2 · 판정 불가 1)', tile('언급')?.value === '50%' && (tile('언급')?.sub ?? '').includes('1/2') && (tile('언급')?.sub ?? '').includes('판정 불가 1'), tiles())
    ok('타일 — 자사 사이트 출처 0%(0/2 — 분모가 있으니 확인 불가가 아니다)', tile('자사 사이트 출처')?.value === '0%' && (tile('자사 사이트 출처')?.sub ?? '').includes('0/2'), tiles())
    ok('타일 — 올린 글 출처 50%(1/2 · 그때 올라가 있던 글 n편)', tile('올린 글 출처')?.value === '50%' && (tile('올린 글 출처')?.sub ?? '').includes('1/2') && (tile('올린 글 출처')?.sub ?? '').includes('편'), tiles())
    ok('「출처 없는 개요 1」 — 출처 분모에서 뺀 개요를 따로 보인다', text().includes('출처 없는 개요 1'), text())
    ok('「읽지 못한 회차 1개」 — 숨기지 않고 알린다', text().includes('읽지 못한 회차 1개'), text())
    ok('흔들림 안내 — 「한 번 측정은 흔들립니다 — 두 번 이상 같은 방향일 때만 판단하세요」', text().includes(AIO_NOISE_NOTE), text())
    ok('직전 같은 조건 회차와 — 두 회차 모두 잰 질문으로만 견준다(공통 n개)', /두 회차 모두 잰 질문 4개/.test(text()), text())
    ok('함께 나온 경쟁사 — 판정이 준 이름 · 개요 수', text().includes('경쟁가짜민박 1'), text())

    // 질문 표 — 칸 기호 · aria-label · 범례 · k/N.
    const qrows = [...host.querySelectorAll('.gaio-qtable tbody tr')]
    const q1 = qrows.find((r) => (r.textContent ?? '').includes(TEXT['q-001']!))
    const q1cells = [...(q1?.querySelectorAll('.gaio-cell') ?? [])]
    ok(
      '질문 표 — 회차별 칸 기호에 aria-label · title(같은 글자), 언급 ● 두 번',
      q1cells.length === 2 && q1cells.every((c) => c.getAttribute('aria-label') === AIO_CELL.mentioned.label && c.getAttribute('title') === AIO_CELL.mentioned.label && (c.textContent ?? '') === AIO_CELL.mentioned.symbol),
      q1?.outerHTML,
    )
    const q4 = qrows.find((r) => (r.textContent ?? '').includes(TEXT['q-004']!))
    ok('질문 표 — 못 읽음은 「?」 · 「못 읽음(확인 불가)」', [...(q4?.querySelectorAll('.gaio-cell') ?? [])].some((c) => c.getAttribute('aria-label') === AIO_CELL.unreadable.label && c.textContent === '?'), q4?.outerHTML)
    ok('질문 표 — 노출 · 언급 k/N(분모와 함께)', (q1?.textContent ?? '').includes('2/2') && (q4?.textContent ?? '').includes('0/1'), [q1?.textContent, q4?.textContent])
    const q5 = qrows.find((r) => (r.textContent ?? '').includes(TEXT['q-005']!))
    ok('질문 표 — 판정된 개요가 없는 질문의 언급은 「확인 불가」(0/0을 0으로 쓰지 않음)', (q5?.querySelector('.gaio-k-mention')?.textContent ?? '') === '0/1' || (q5?.querySelector('.gaio-k-mention')?.textContent ?? '') === '확인 불가', q5?.outerHTML)
    const q3 = qrows.find((r) => (r.textContent ?? '').includes(TEXT['q-003']!))
    ok('질문 표 — 개요가 한 번도 안 뜬 질문의 언급은 「확인 불가」', (q3?.querySelector('.gaio-k-mention')?.textContent ?? '') === '확인 불가', q3?.outerHTML)
    const legend = host.querySelector('.gaio-legend')?.textContent ?? ''
    ok('범례 — 기호 여섯 개와 글자', Object.values(AIO_CELL).every((c) => legend.includes(c.symbol) && legend.includes(c.label)), legend)

    // 올린 글 표 — 작성자는 키만, 이름은 어디에도 없다.
    const posts = host.querySelector('.gaio-posts')?.textContent ?? ''
    ok('올린 글 표 — 작성자 w2 · 출처로 나온 회차 k/N · 앱 밖 글 표시', posts.includes('w2') && posts.includes('1/1') && posts.includes('앱 밖'), posts)
    ok('작성자 이름 — 화면 어디에도 없다', !host.innerHTML.includes(WRITER_NAME))

    // 회차 목록 — 판정 비용(생각 토큰 포함: 0.1M × 0.3 + 0.04M × 2.5 = 0.13 USD).
    await waitFor(() => (host.querySelector('.gaio-runs')?.textContent ?? '').includes('0.13 USD'))
    ok('회차 목록 — 판정 비용 약 0.13 USD(입력 × 입력 단가 + (출력 + 생각) × 출력 단가)', (host.querySelector('.gaio-runs')?.textContent ?? '').includes('0.13 USD'), host.querySelector('.gaio-runs')?.textContent)
    ok('회차 목록 — 검색 수 · 최대 검색(9/14회)', (host.querySelector('.gaio-runs')?.textContent ?? '').includes(`9/${aioMaxSearches(IDS.length)}`), host.querySelector('.gaio-runs')?.textContent)

    // 회차 자세히 — 본문 · 출처(자사 · 올린 글 w2) · http(s)만 링크 · 구글에서 보기.
    const runRow = [...host.querySelectorAll('.gaio-runs tbody tr')].find((r) => (r.textContent ?? '').includes(kstStamp(R_DONE.startedAt)))
    await click(buttonNamed('자세히', runRow ?? doc))
    await waitFor(() => (doc.getElementById('gaio-detail')?.textContent ?? '').includes('경쟁가짜민박이 있어요'))
    const detail = doc.getElementById('gaio-detail')
    const dt = detail?.textContent ?? ''
    ok('회차 자세히 — 회차를 그때 읽는다(GET runs/:runId) · 본문 · 상태 · 까닭', sent('GET', `${P}/runs/${R_DONE.runId}`).length === 1 && dt.includes('가짜스테이와 경쟁가짜민박이 있어요') && dt.includes('AI 개요 없음') && dt.includes('늦게 오는 개요를 받지 못했어요'), dt)
    ok('회차 자세히 — 올린 글 출처에 작성자 키(w2) 표시', dt.includes('올린 글') && dt.includes('w2'), dt)
    ok('회차 자세히 — http(s)가 아닌 주소는 링크로 그리지 않는다', ![...(detail?.querySelectorAll('a') ?? [])].some((a) => !/^https?:\/\//.test(a.getAttribute('href') ?? '')) && dt.includes('가짜 위험 링크'), [...(detail?.querySelectorAll('a') ?? [])].map((a) => a.getAttribute('href')))
    ok('회차 자세히 — 「구글에서 보기」는 키 없는 검색 주소', [...(detail?.querySelectorAll('a') ?? [])].some((a) => (a.textContent ?? '').includes('구글에서 보기') && (a.getAttribute('href') ?? '').startsWith('https://www.google.co.kr/search?q=') && !(a.getAttribute('href') ?? '').includes('api_key')))
    ok('회차 자세히 — 펼침 단추는 aria-expanded', buttonNamed('접기', runRow ?? doc)?.getAttribute('aria-expanded') === 'true', runRow?.outerHTML)

    // 계획 → 확인창.
    const nowBtn = buttonNamed('지금 재기')
    nowBtn?.focus()
    await click(nowBtn)
    await waitFor(() => Boolean(dialog()))
    const planCalls = sent('POST', `${P}/plan`)
    ok('계획 — JSON 본문 {} 하나(검색 0 — 계정만 읽음)', planCalls.length === 1 && planCalls[0]?.type === 'application/json' && JSON.stringify(planCalls[0]?.body) === '{}', planCalls)
    const dtx = dialogText()
    ok('확인창 — 질문 50개 · 검색 최대 110회 · 판정(Gemini) 최대 50회', dtx.includes('50개') && dtx.includes('최대 110회') && dtx.includes('Gemini') && dtx.includes('최대 50회'), dtx)
    ok('확인창 — 몫 분모는 계정 · 장부 값 그대로(남은 201회 / 237회, 250 · 500을 박지 않음)', dtx.includes('201회') && dtx.includes('237회') && !dtx.includes('250회') && !dtx.includes('500회'), dtx)
    ok('확인창 — 계정 남은 873회 · 바닥 512회 · 이번 시간 남은 188회 · 12월 8일 갱신', dtx.includes('873회') && dtx.includes('512회') && dtx.includes('188회') && dtx.includes('12월 8일'), dtx)
    ok('확인창 — 걸리는 시간 약 5~13분 · 「앱을 켜 두세요 — 끄면 멈추고 받은 검색만 셉니다」', dtx.includes('약 5~13분') && dtx.includes('앱을 켜 두세요 — 끄면 멈추고 받은 검색만 셉니다'), dtx)
    ok('확인창 — 「이미 낸 요금 안 · 검색당 환산」(검색당 약 $0.025)', dtx.includes('이미 낸 요금 안') && dtx.includes('검색당') && dtx.includes('$0.025'), dtx)
    ok('확인창 — 지난 회차(날짜 · n일 전) · 14일이 안 됐으면 경고 한 줄', dtx.includes(kstStamp('2026-11-03T01:00:00.000Z')) && dtx.includes('8일 전') && dtx.includes('14일'), dtx)
    ok('확인창 — 질문지 판 · 검색 위치', dtx.includes('v6 · 이름 없는 50문항') && dtx.includes(LOCATION), dtx)
    ok('확인창 — 열리면 포커스는 확인창 안(취소)', Boolean(dialog()?.contains(doc.activeElement)), doc.activeElement?.outerHTML)
    await key('Escape')
    ok('확인창 — Esc로 닫으면 실행하지 않는다 · 포커스는 지금 재기로', !dialog() && sent('POST', `${P}/run`).length === 0 && doc.activeElement === buttonNamed('지금 재기'), doc.activeElement?.outerHTML)

    // 확인 → 실행 → 진행.
    await click(buttonNamed('지금 재기'))
    await waitFor(() => Boolean(dialog()))
    await click(buttonNamed('지금 재기(검색 최대 110회)', dialog() ?? doc))
    const runCalls = sent('POST', `${P}/run`)
    ok('실행 — JSON 본문 { planId }만', runCalls.length === 1 && runCalls[0]?.type === 'application/json' && JSON.stringify(runCalls[0]?.body) === JSON.stringify({ planId: 'plan-aio-ui-1' }), runCalls)
    await waitFor(() => (progressEl()?.textContent ?? '').includes('3/50'))
    const pt = progressEl()?.textContent ?? ''
    ok('진행 — role=status 「재는 중… 3/50」 · 검색 7/110회 · 있음 2 · AI 개요 없음 1 · 판정 불가 1', progressEl()?.getAttribute('role') === 'status' && pt.includes('재는 중… 3/50') && pt.includes('검색 7/110회') && pt.includes('있음 2') && pt.includes('AI 개요 없음 1') && pt.includes('판정 불가 1'), pt)
    ok('진행 — 「앱을 켜 두세요」 안내', text().includes('앱을 켜 두세요'), text())
    ok('진행(키보드) — 누른 단추가 사라지면 포커스는 진행 글자로(몸통으로 빠지지 않음)', doc.activeElement === progressEl(), doc.activeElement?.outerHTML)
    ok('진행 — 도는 동안에도 앞서 받은 결과(타일)는 그대로 둔다', tile('AI 개요가 뜬 질문')?.value === '75%', tiles())
    ok('진행 — 지금 재기 · 다시 판정 단추는 없다', !buttonNamed('지금 재기') && !buttonNamed('다시 판정'), text())
    st = { ...st, running: progress({ done: 4, searches: 9 }) }
    await waitFor(() => (progressEl()?.textContent ?? '').includes('4/50'))
    ok('진행 — 2초마다 다시 묻는다(4/50 · 검색 9/110회)', (progressEl()?.textContent ?? '').includes('4/50') && (progressEl()?.textContent ?? '').includes('검색 9/110회'), progressEl()?.textContent)

    // 중단 — JSON {} · 멈추는 중.
    await click(buttonNamed('중단'))
    const cancelCalls = asked.filter((a) => a.method === 'POST' && a.path.endsWith('/cancel'))
    ok('중단 — 그 회차에 JSON 본문 {}', cancelCalls.length === 1 && cancelCalls[0]?.path === `${P}/runs/2026-11-11T05-00-00-000Z/cancel` && cancelCalls[0]?.type === 'application/json' && JSON.stringify(cancelCalls[0]?.body) === '{}', cancelCalls)
    await waitFor(() => (progressEl()?.textContent ?? '').includes('멈추는 중'))
    ok('중단 — 「멈추는 중」(지금 받는 검색 하나는 끝까지)', (progressEl()?.textContent ?? '').includes('멈추는 중'), progressEl()?.textContent)

    // 끝 — 새 결과로 바뀐다.
    st = status({ view: VIEW_NEW, lastRunAt: R_NEW.startedAt })
    await waitFor(() => !progressEl() && tile('AI 개요가 뜬 질문')?.value === '33%')
    ok('끝 — 진행이 사라지고 새 회차 타일(노출 2/6 = 33%)', !progressEl() && tile('AI 개요가 뜬 질문')?.value === '33%' && Boolean(buttonNamed('지금 재기')), tiles())
    ok('끝 — 계획 · 실행은 한 번씩만(되풀이해 보내지 않음)', sent('POST', `${P}/run`).length === 1, asked.map((a) => `${a.method} ${a.path}`))
    await unmount()

    // (아) 멈춘 회차 — 까닭 role=alert · 끊긴 회차는 따로 문구.
    st = status({ view: VIEW_PART, lastRunAt: R_PART.startedAt })
    await mount(live)
    ok('멈춘 회차 — 마지막 회차의 멈춘 까닭을 role=alert로(남은 문항 수까지)', alerts().includes('판정 엔진이 3번 잇따라 답하지 않아') && alerts().includes('남은 3문항'), alerts())
    ok('멈춘 회차 — 일부만 잰 회차는 요약에 쓰지 않는다(요약은 앞 끝난 회차 75%) · 목록에 「일부만 잰 회차」', tile('AI 개요가 뜬 질문')?.value === '75%' && (host.querySelector('.gaio-runs')?.textContent ?? '').includes('일부만 잰 회차'), [tiles(), host.querySelector('.gaio-runs')?.textContent])
    await unmount()
    st = status({ view: VIEW_INT, lastRunAt: R_INT.startedAt })
    await mount(live)
    ok('끊긴 회차 — 까닭이 비어도 「앱이 꺼져 멈춘 회차」로 알린다', alerts().includes('앱이 꺼져'), alerts())
    await unmount()

    // (자) 노출 급락 — 경고 · 추이 선을 잇지 않는다.
    st = status({ view: VIEW_DROP, lastRunAt: R_DROP.startedAt })
    await mount(live)
    ok('노출 급락 — 「AI 개요가 한 번도 안 떴어요 — 구글 · SerpAPI 쪽 변화일 수 있어요」', text().includes('AI 개요가 한 번도 안 떴어요') && text().includes('구글 · SerpAPI 쪽 변화일 수 있어요'), text())
    const segs = host.querySelectorAll('.gaio-trend .gaio-seg-exposure').length
    ok('노출 급락 — 추이 선은 급락한 회차와 잇지 않는다(점 3개 · 선 1개)', host.querySelectorAll('.gaio-trend .gaio-dot-exposure').length === 3 && segs === 1, host.querySelector('.gaio-trend')?.outerHTML)
    await unmount()

    // (차) 확인 불가 — 분모 0은 0%가 아니라 「확인 불가」.
    st = status({ view: VIEW_NULL, unreadableRuns: 0, lastRunAt: R_NULL.startedAt })
    await mount(live)
    const nullTiles = tiles()
    ok('확인 불가 — 잰 질문이 없으면 네 타일 모두 「확인 불가」(0%로 쓰지 않음)', nullTiles.length >= 4 && nullTiles.slice(0, 4).every((t) => t.value === '확인 불가') && !nullTiles.some((t) => t.value === '0%'), nullTiles)
    ok('확인 불가 — 함께 나온 경쟁사도 「확인 불가」(0곳 아님)', text().includes('함께 나온 경쟁사') && text().includes('확인 불가'), text())
    await unmount()

    // (카) 측정 중 — 계획이 409 measuring이면 서버 글자를 그대로(role=alert), 확인창 없음.
    st = status()
    planReply = { status: 409, body: { error: MEASURING, code: 'measuring' } }
    await mount(live)
    await click(buttonNamed('지금 재기'))
    await waitFor(() => alerts().includes('측정이 도는 중'))
    ok('측정 중(409) — 「브랜드 측정이 도는 중이라 시작하지 않았어요」 role=alert · 확인창 없음 · 실행 없음', alerts().includes(MEASURING) && !dialog() && sent('POST', `${P}/run`).length === 0, alerts())
    await unmount()
    st = status({ measuring: true })
    await mount(live)
    ok('측정 중(상태) — 안내를 보이고 지금 재기는 누를 수 없다', text().includes('브랜드 측정이 도는 중') && buttonNamed('지금 재기')?.disabled === true, text())
    await unmount()

    // (타) 몫 모자람 — 계획이 blocked면 까닭만(확인창 · 실행 없음).
    st = status()
    planReply = { status: 200, body: plan({ planId: null, blocked: { kind: 'limit', message: '이번 결제 주기 구글 AI 개요 몫이 37회 남아(몫 237회) 한 회차(최대 110회)를 시작하지 않았어요 — 2026-12-08에 다시 채워져요.' }, quota: { ...QUOTA, left: 37, allowed: 37 } }) }
    await mount(live)
    await click(buttonNamed('지금 재기'))
    await waitFor(() => alerts().includes('37회 남아'))
    ok('몫 모자람 — 「… 37회 남아(몫 237회) … 시작하지 않았어요」 role=alert · 확인창 · 실행 없음', alerts().includes('37회 남아(몫 237회)') && !dialog() && sent('POST', `${P}/run`).length === 0, alerts())
    await unmount()

    // (파) 실행 409 — 계획이 바뀜 · 도는 중 · 다른 창.
    st = status()
    planReply = { status: 200, body: plan() }
    runReply = { status: 409, body: { error: '계획이 바뀌었어요 — 계획을 다시 받아 주세요.', code: 'plan-changed' } }
    await mount(live)
    await click(buttonNamed('지금 재기'))
    await waitFor(() => Boolean(dialog()))
    const getsBefore = sent('GET', P).length
    await click(buttonNamed('지금 재기(검색 최대 110회)', dialog() ?? doc))
    await waitFor(() => alerts().includes('계획이 바뀌'))
    ok('실행 409(계획이 바뀜) — 「계획이 바뀌었어요 — 다시 눌러 주세요」 role=alert · 상태를 다시 읽는다 · 확인창 닫힘', alerts().includes('계획이 바뀌었어요') && alerts().includes('다시 눌러') && sent('GET', P).length > getsBefore && !dialog(), [alerts(), sent('GET', P).length])
    runReply = { status: 409, body: { error: '이미 구글 AI 개요 시범이 도는 중이에요 — 끝난 뒤 다시 눌러 주세요.', code: 'busy' } }
    await click(buttonNamed('지금 재기'))
    await waitFor(() => Boolean(dialog()))
    st = status({ running: progress({ done: 1 }), view: null })
    await click(buttonNamed('지금 재기(검색 최대 110회)', dialog() ?? doc))
    await waitFor(() => (progressEl()?.textContent ?? '').includes('1/50'))
    ok('실행 409(다른 탭이 먼저 돎) — 상태를 다시 읽어 진행으로 넘어간다(오류를 겹쳐 보이지 않음)', (progressEl()?.textContent ?? '').includes('1/50') && !alerts().includes('이미 구글 AI 개요 시범이 도는 중'), [alerts(), progressEl()?.textContent])
    await unmount()
    st = status({ runningElsewhere: true, view: null, busy: '이 PC에서 앱이 한 번 더 켜져 있고, 그쪽에서 SerpAPI 작업(구글 AI 개요 시범 등)이 도는 중이에요 — 끝난 뒤 다시 눌러 주세요.' })
    await mount(live)
    ok('다른 창에서 돎 — 「다른 앱 창」 안내 · 지금 재기 없음', text().includes('다른 앱 창') && !buttonNamed('지금 재기'), text())
    const getsElse = sent('GET', P).length
    await waitFor(() => sent('GET', P).length > getsElse, 4000)
    ok('다른 창에서 돎 — 끝났는지 2초마다 다시 묻는다(가벼운 GET)', sent('GET', P).length > getsElse)
    await unmount()
    st = status({ busy: '다른 SerpAPI 작업(구글 색인 자동 확인)이 도는 중이에요 — 끝난 뒤 다시 눌러 주세요.' })
    await mount(live)
    ok('다른 SerpAPI 작업이 돎 — 까닭을 보이고 지금 재기는 누를 수 없다', text().includes('구글 색인 자동 확인)이 도는 중') && buttonNamed('지금 재기')?.disabled === true, text())
    await unmount()

    // (파2) 도는 중에 다른 탭에서 이 PC를 꺼도 — 다음 질문 전까지는 돌므로 진행과 「중단」을 보인다(켜기 단추가 진행을 가리지 않음).
    st = status({ enabled: false, running: progress({ done: 5 }), view: null })
    await mount(live)
    ok('도는 중 · 이 PC 꺼짐 — 진행(role=status)과 「중단」을 보이고 「이 PC에서 켜기」는 없다', (progressEl()?.textContent ?? '').includes('5/50') && Boolean(buttonNamed('중단')) && !buttonNamed('이 PC에서 켜기'), text())
    await unmount()

    // (하) 판정 엔진 키 없음 — 시작 안 함(지금 재기 · 다시 판정 없음).
    st = status({ judge: { engine: 'gemini', label: 'Gemini', ready: false, problem: '판정 엔진(Gemini) 키가 이 PC에 없어 시작하지 않아요 — 판정 없이 검색비만 쓰지 않게요.' } })
    await mount(live)
    ok('판정 엔진 키 없음 — 까닭 · 지금 재기 누를 수 없음 · 다시 판정 단추 없음', text().includes('판정 엔진(Gemini) 키가 이 PC에 없어') && buttonNamed('지금 재기')?.disabled === true && !buttonNamed('다시 판정'), text())
    await unmount()

    // (거) 다시 판정 — 확인창(판정 최대 n회 · 엔진 · 검색 0회) → JSON { scope: 'unknown' } · 진행 · 끝.
    st = status()
    rejudgeReply = { status: 202, body: { runId: R_DONE.runId, total: 1 } }
    await mount(live)
    const rjRow = [...host.querySelectorAll('.gaio-runs tbody tr')].find((r) => (r.textContent ?? '').includes(kstStamp(R_DONE.startedAt)))
    const rjBtn = buttonNamed('다시 판정', rjRow ?? doc)
    ok('다시 판정 — 판정 불가가 있는 회차에만 단추 「판정 불가 1개 다시 판정」', (rjBtn?.textContent ?? '').includes('판정 불가 1개 다시 판정'), rjRow?.outerHTML)
    await click(rjBtn)
    const rdt = dialogText()
    ok('다시 판정 확인창 — 판정 최대 1회 · Gemini · 검색 0회', Boolean(dialog()) && rdt.includes('판정 최대 1회') && rdt.includes('Gemini') && rdt.includes('검색 0회'), rdt)
    await click(buttonNamed('다시 판정(판정 최대 1회)', dialog() ?? doc))
    const rj = asked.filter((a) => a.method === 'POST' && a.path.endsWith('/rejudge'))
    ok('다시 판정 — 그 회차에 JSON { scope: unknown } · 계획 · 실행 요청 없음', rj.length === 1 && rj[0]?.path === `${P}/runs/${R_DONE.runId}/rejudge` && rj[0]?.type === 'application/json' && JSON.stringify(rj[0]?.body) === JSON.stringify({ scope: 'unknown' }) && sent('POST', `${P}/plan`).length === 0 && sent('POST', `${P}/run`).length === 0, rj)
    await waitFor(() => (progressEl()?.textContent ?? '').includes('다시 판정하는 중'))
    ok('다시 판정 — 진행 role=status 「다시 판정하는 중… 0/1 · 검색 0회」', (progressEl()?.textContent ?? '').includes('다시 판정하는 중… 0/1') && (progressEl()?.textContent ?? '').includes('검색 0회'), progressEl()?.textContent)
    st = status({ rejudged: { runId: R_DONE.runId, judged: 1, failed: 0, stopped: false, at: '2026-11-11T05:00:00.000Z' } })
    await waitFor(() => text().includes('다시 판정을 마쳤어요'))
    ok('다시 판정 — 끝나면 결과 한 줄(판정 1개 · 못 함 0개)', text().includes('다시 판정을 마쳤어요') && text().includes('판정 1개') && !progressEl(), text())
    await unmount()
    st = status()
    rejudgeReply = { status: 409, body: { error: '다시 판정이 이미 도는 중이에요 — 끝난 뒤 다시 눌러 주세요.', code: 'busy' } }
    await mount(live)
    await click(buttonNamed('다시 판정'))
    await click(buttonNamed('다시 판정(판정 최대 1회)', dialog() ?? doc))
    await waitFor(() => alerts().includes('이미 도는 중'))
    ok('다시 판정 409(busy) — 서버 까닭 role=alert', alerts().includes('다시 판정이 이미 도는 중이에요'), alerts())
    await unmount()

    // (너) 이어 재기 — 오늘 멈춘 회차가 있으면 단추, 계획 본문 { resume }.
    st = status({ view: VIEW_PART, resumable: { runId: R_PART.runId, remaining: 3 } })
    planReply = { status: 200, body: plan({ resume: { runId: R_PART.runId, remaining: 3 }, questions: 3, totalQuestions: 6, maxSearches: 8, maxJudgeCalls: 3, planId: 'plan-resume' }) }
    await mount(live)
    await click(buttonNamed('이어 재기'))
    await waitFor(() => Boolean(dialog()))
    const rp = sent('POST', `${P}/plan`)
    ok('이어 재기 — 계획 본문 { resume: 회차 id } · 확인창 「남은 3문항」 · 검색 최대 8회', rp.length === 1 && JSON.stringify(rp[0]?.body) === JSON.stringify({ resume: R_PART.runId }) && dialogText().includes('남은 3문항') && dialogText().includes('최대 8회'), [rp, dialogText()])
    await unmount()

    ok('가짜 fetch — /api/ 밖(진짜 SerpAPI · LLM 포함)으로 나가려 한 요청이 없다', outside.length === 0, outside)
  } catch (err) {
    ok(`화면 검사가 예외 없이 끝난다: ${err instanceof Error ? err.stack : String(err)}`, false)
  } finally {
    globalThis.fetch = realFetch
  }
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
