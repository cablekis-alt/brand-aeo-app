/**
 * 색인 자동 확인 화면(src/components/IndexAutoPanel.tsx · src/pages/PublishStatus.tsx · src/lib/indexAuto.ts 화면 함수)을 확인한다.
 *
 * 안전 규칙: 서버를 띄우지 않는다. jsdom과 가짜 fetch만 쓰고, 가짜 fetch는 /api/ 밖으로 가는 요청을 막고 기록한다(진짜 SerpAPI는 물론 어떤
 * 바깥 주소도 부르지 않는다). 브랜드 · 주소 · 제목은 모두 가짜다(작성자 없음).
 *
 * 무엇을 보나:
 * A. 화면 함수 — 칸 아래 안내(결정적 못 가림은 그 차례 동안 · 일시 못 가림은 오늘만 · 마지막 확인이 자동 「아직」이면 직접 확인 권함 · 30일째
 *    한 번 더), 자동 확인 기록 글, 머리 단추의 오늘 볼 글 어림.
 * B. 화면 — 웹(404)이면 패널 · 단추 없음, 키 없음이면 넣을 곳 · 다시 켜기 안내만, 연결 설정 틀림, 펼치기 전에는 계정을 읽지 않음(계획 요청 0),
 *    계획(검색 수 · 이번 결제 주기 몫 · 계정 바닥 · 직접 볼 글 · 못 가린 글 · 안 찾는 주소) · 막힘(검색 0) · 계획 오류는 패널 안에서만, 실행(JSON ·
 *    planId) · 진행(role=status) · 결과(「자동으로 못 가림」 목록) · 끝나면 표 다시 읽기 · 멈춘 까닭(role=alert) · 계획이 바뀜(409) · 설정(기본 끔 ·
 *    JSON 저장) · 열 때 하루 한 번(켜졌을 때만 · 한 번만) · 칩 「· 자동」 · 칸 아래 안내 · CSV 확인 방법 열 · 키보드(단추 · 포커스).
 *
 *   npx tsx scripts/verify-index-auto-ui.ts
 */
import { trackingKey } from '../src/lib/publishedUrl'
import { autoAttemptsText, autoCellNotes, estimateAutoTargets, type AutoAttemptView } from '../src/lib/indexAuto'
import type { IndexCheck, PublishStatus, PublishStatusRow } from '../src/lib/publishStatus'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean, detail?: unknown) => {
  checks.push([label, cond])
  if (!cond && detail !== undefined) console.error(`  ✗ ${label}:`, typeof detail === 'string' ? detail : JSON.stringify(detail, null, 1).slice(0, 3000))
}

// ── 가짜 줄 ────────────────────────────────────────────────────────────────────
const T = '2026-11-30'
const g = (state: IndexCheck['state'], checkedOn: string, source: IndexCheck['source'] = 'manual'): IndexCheck => ({ state, checkedOn, checkedAt: `${checkedOn}T03:00:00.000Z`, source })
const U = (n: number) => `https://fake-ia.tistory.com/${n}`
const K = (n: number) => trackingKey(U(n)) as string
const row = (n: number, publishedOn: string, over: Partial<PublishStatusRow> = {}): PublishStatusRow => ({
  rowKey: `via-a|p-ia${n}`,
  tenantId: 'via-a',
  brand: '가상하나',
  kind: 'posted',
  origin: 'app',
  postId: `p-ia${n}`,
  key: K(n),
  articleId: `content:ia-${n}`,
  title: `가상 글 ${n}`,
  writer: null,
  writerUnknown: null,
  postedUnknown: false,
  platform: { key: 'tistory', label: '티스토리' },
  url: U(n),
  publishedOn,
  recheckFrom: publishedOn,
  trackedOn: null,
  removed: null,
  naver: null,
  google: null,
  checkFrom: null,
  ...over,
})
const att = (turn: string, outcome: string, reason: string | undefined, at: string): AutoAttemptView => ({ at, on: at.slice(0, 10), turn, outcome, ...(reason ? { reason } : {}) })
const ROWS: PublishStatusRow[] = [
  row(1, '2026-11-10', { google: g('shown', '2026-11-24', 'auto') }),
  row(2, '2026-11-10', { google: g('not-yet', '2026-11-24', 'auto') }),
  row(3, '2026-11-16'),
  row(4, '2026-11-15'),
  row(5, '2026-11-16'),
  row(6, '2026-11-20', { google: g('not-yet', '2026-11-23') }),
  row(7, '2026-11-16', { google: g('not-yet', '2026-11-30') }),
]
const ATTEMPTS: Record<string, AutoAttemptView[]> = {
  [K(3)]: [att('d14:2026-11-30', 'unknown', 'similar-many', '2026-11-30T01:00:00.000Z')],
  [K(4)]: [att('d14:2026-11-29', 'unknown', 'timeout', '2026-11-30T01:00:00.000Z')],
  // 사람이 자동 시도 뒤에 「아직」을 눌렀다 — 앞선 자동 못 가림 안내는 보이지 않는다.
  [K(7)]: [att('d14:2026-11-30', 'unknown', 'similar-many', '2026-11-30T01:00:00.000Z')],
  [K(2)]: [att('d14:2026-11-24', 'not-found', undefined, '2026-11-24T03:00:00.000Z'), att('d14:2026-11-24', 'unknown', 'timeout', '2026-11-24T02:00:00.000Z')],
}

// ══ A. 화면 함수 ══════════════════════════════════════════════════════════════
const notes = (n: number, autoOn = true, today = T) => autoCellNotes(ROWS[n - 1]!, today, ATTEMPTS[K(n)], autoOn).map((x) => x.text)
ok('칸 안내 — 이번 차례에 결정적 까닭으로 못 가림 → 「자동으로 못 가림 — 직접 확인해 주세요(까닭)」', JSON.stringify(notes(3)) === JSON.stringify(['자동으로 못 가림 — 직접 확인해 주세요(비슷한 주소가 많음)']), notes(3))
ok('칸 안내 — 다음 차례로 넘어가면 결정적 안내도 사라진다', autoCellNotes(row(3, '2026-11-02'), T, ATTEMPTS[K(3)], true).length === 0)
ok('칸 안내 — 오늘 일시 오류 → 「오늘 자동으로 못 가림 — 까닭」, 다음 날은 없음', notes(4)[0] === '오늘 자동으로 못 가림 — SerpAPI 응답 시간 초과' && notes(4, true, '2026-12-01').length === 0, notes(4))
ok('칸 안내 — 같은 차례에 일시 오류가 두 번이면 그 차례 동안 직접 확인 안내', (() => {
  const two = [att('d14:2026-11-29', 'unknown', 'upstream', '2026-11-30T02:00:00.000Z'), att('d14:2026-11-29', 'unknown', 'timeout', '2026-11-29T01:00:00.000Z')]
  return autoCellNotes(ROWS[3]!, '2026-12-01', two, true)[0]?.text === '자동으로 못 가림 — 직접 확인해 주세요(SerpAPI 응답 오류)'
})())
ok('칸 안내 — 자동 시도 뒤에 사람이 표시했으면 안내하지 않는다', notes(7).length === 0, notes(7))
ok(
  '칸 안내 — 14일 지남 · 마지막 확인이 자동 「아직」 → 직접 확인 권함 + 30일째 한 번 더(키가 없으면 30일째 안내는 뺀다)',
  JSON.stringify(notes(2)) === JSON.stringify(['마지막 확인이 자동이에요 — 한 번 직접 확인해 보세요', '30일째(12/10)에 자동으로 한 번 더 봐요']) &&
    JSON.stringify(notes(2, false)) === JSON.stringify(['마지막 확인이 자동이에요 — 한 번 직접 확인해 보세요']),
  notes(2),
)
ok('칸 안내 — 자동 기록 파일 없이도(시도 없음) 「마지막 확인이 자동」은 확인 기록만으로', autoCellNotes(ROWS[1]!, T, undefined, true)[0]?.text === '마지막 확인이 자동이에요 — 한 번 직접 확인해 보세요')
ok('칸 안내 — 키가 없으면 시도 안내는 없다 · 사람 표시 · 색인됨 · 뺀 줄은 없음', notes(3, false).length === 0 && notes(1).length === 0 && notes(6).length === 0 && autoCellNotes(row(3, '2026-11-16', { removed: { reason: 'mistake', at: T } }), T, ATTEMPTS[K(3)], true).length === 0)
ok('자동 확인 기록 글 — 오래된 것부터 날짜 · 결과', autoAttemptsText(ATTEMPTS[K(2)]) === '자동 확인 기록: 11/24 못 가림 · 11/24 못 찾음' && autoAttemptsText(undefined) === '', autoAttemptsText(ATTEMPTS[K(2)]))
ok('머리 단추 어림 — 오늘 자동으로 볼 글(끝난 차례 · 직접 볼 글 · 색인됨 빼고, 일시 오류 1회는 넣음)', estimateAutoTargets(ROWS, T, ATTEMPTS) === 2, estimateAutoTargets(ROWS, T, ATTEMPTS))

// ══ B. 화면 ══════════════════════════════════════════════════════════════════
const STATUS_DATA: PublishStatus = { today: T, brands: [{ tenantId: 'via-a', brand: '가상하나' }], rows: ROWS, writers: [], issues: [] }
const SETTINGS = { runCap: 40, autoOnOpen: false }
const status = (over: Record<string, unknown> = {}) => ({
  configured: true,
  configError: null,
  settings: SETTINGS,
  running: null,
  lastRun: null,
  attemptsByKey: ATTEMPTS,
  openRunToday: false,
  ...over,
})
const QUOTA = { cycle: '2026-12-08', cap: 200, used: 42, featureLeft: 158, floor: 500, accountLeft: 958, aboveFloor: 457, hourLeft: 196, allowed: 158, planName: 'Starter', searchesPerMonth: 1000, rateLimitPerHour: 200 }
const target = (n: number) => ({ key: K(n), tenantId: 'via-a', postId: `p-ia${n}`, origin: 'app', rowName: `가상하나 「가상 글 ${n}」 티스토리`, tier: 'day14', turn: 'd14:2026-11-30', since: T, batch: 'first', query: `site:${K(n)}` })
const plan = (over: Record<string, unknown> = {}) => ({
  planId: 'plan-ui-1',
  expiresAt: '2026-11-30T05:10:00.000Z',
  trigger: 'button',
  today: T,
  candidates: 2,
  searches: 2,
  limitedBy: null,
  blocked: null,
  targets: [target(5), target(4)],
  manual: 1,
  unsupported: [{ key: 'youtube.com/watch?v=fakeVid', rowName: '가상하나 「가상 영상」 유튜브', reason: 'platform', text: '유튜브 · 인스타그램 글은 자동으로 찾지 않아요 — 직접 확인해 주세요.' }],
  settled: 1,
  shownElsewhere: 0,
  quota: QUOTA,
  settings: SETTINGS,
  ...over,
})
const RUN_DONE = {
  runId: 'r-ui-1',
  trigger: 'button',
  startedAt: '2026-11-30T05:00:00.000Z',
  endedAt: '2026-11-30T05:00:12.000Z',
  planned: 2,
  searched: 2,
  found: 1,
  notFound: 0,
  unknown: 1,
  skipped: 0,
  notRun: 0,
  stoppedBy: null,
  items: [
    { key: K(5), tenantId: 'via-a', postId: 'p-ia5', rowName: '가상하나 「가상 글 5」 티스토리', tier: 'day14', outcome: 'found', matched: U(5), wrote: 'shown' },
    { key: K(4), tenantId: 'via-a', postId: 'p-ia4', rowName: '가상하나 「가상 글 4」 티스토리', tier: 'day14', outcome: 'unknown', reason: 'other-url', matched: `${U(4)}?amp=1` },
  ],
}

{
  const realFetch = globalThis.fetch
  const realCreateObjectURL = URL.createObjectURL
  const realRevoke = URL.revokeObjectURL
  try {
    const React = await import('react')
    const { JSDOM } = await import('jsdom')
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1/' })
    Object.assign(globalThis, { React, window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
    const { createRoot } = await import('react-dom/client')
    const { MemoryRouter } = await import('react-router-dom')
    const { default: PublishStatusPage } = await import('../src/pages/PublishStatus')
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
    let csvBlob: Blob | null = null
    URL.createObjectURL = ((b: Blob) => {
      csvBlob = b
      return 'blob:verify'
    }) as typeof URL.createObjectURL
    URL.revokeObjectURL = () => {}

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
    const typeInto = async (el: Element | null | undefined, value: string) => {
      if (!el) throw new Error('적을 칸을 찾지 못했다')
      await React.act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(el, value)
        el.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
      await settle()
    }
    const buttonNamed = (text: string, within: ParentNode = doc) => [...within.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(text))
    const reloadButton = () => buttonNamed('다시 읽기', doc.querySelector('.page-actions') ?? doc)
    const panel = () => doc.querySelector('.iap-panel')
    const panelText = () => panel()?.textContent ?? ''
    const alerts = () => [...(panel()?.querySelectorAll('[role="alert"]') ?? [])].map((p) => p.textContent ?? '').join(' | ')
    const toggle = () => doc.getElementById('iap-toggle') as HTMLButtonElement | null
    const headButton = () => [...doc.querySelectorAll('.page-actions button')].find((b) => (b.textContent ?? '').includes('구글 자동 확인') || (b.textContent ?? '').includes('확인하는 중'))
    const lead = () => doc.querySelector('.page-lead')?.textContent ?? ''
    const sent = (method: string, p: string) => asked.filter((a) => a.method === method && a.path === p)
    const cellOf = (n: number) => {
      const tr = [...doc.querySelectorAll('.ps-table tbody tr')].find((t) => t.querySelector(`a[href="${U(n)}"]`))
      return tr?.querySelectorAll('td.ps-index')[1] ?? null
    }
    const mount = async (handler: (a: Asked) => Reply) => {
      reply = handler
      const next = createRoot(host)
      root = next
      await React.act(async () => next.render(React.createElement(MemoryRouter, { initialEntries: ['/publish-status'] }, React.createElement(PublishStatusPage))))
      await settle(4)
    }
    const unmount = async () => {
      await React.act(async () => root?.unmount())
      asked.length = 0
    }
    const base = (st: () => unknown, more: (a: Asked) => Reply | null = () => null) => (a: Asked): Reply => {
      if (a.path === '/api/publish-status') return { status: 200, body: STATUS_DATA }
      if (a.path === '/api/blog-sources') return { status: 200, body: { sources: [] } }
      if (a.path === '/api/index-auto' && a.method === 'GET') return { status: 200, body: st() }
      return more(a) ?? { status: 404, body: 'Not Found' }
    }

    // (가) 웹 — 라우트가 없으면(404) 패널 · 머리 단추 · 구글 자동 문장이 없다.
    await mount((a) => (a.path === '/api/publish-status' ? { status: 200, body: STATUS_DATA } : { status: 404, body: 'Not Found' }))
    ok('웹(404) — 패널 · 머리 단추 · 구글 자동 문장 없음, 표는 그대로', panel() === null && !headButton() && !lead().includes('구글 자동 확인') && doc.querySelectorAll('.ps-table tbody tr').length === ROWS.length)
    ok('웹(404) — 계획 · 실행 요청을 보내지 않는다', sent('POST', '/api/index-auto/plan').length === 0 && sent('POST', '/api/index-auto/run').length === 0)
    await unmount()

    // (나) 키 없음 — 넣을 곳 · 다시 켜기 안내 한 줄, 단추 없음.
    await mount(base(() => status({ configured: false })))
    ok(
      '키 없음 — 「%APPDATA%\\brand-aeo-app\\.env에 SERPAPI_API_KEY」 · 「다시 켜」 안내, 단추 · 머리 단추 · 구글 자동 문장 없음',
      panelText().includes('%APPDATA%\\brand-aeo-app\\.env') && panelText().includes('SERPAPI_API_KEY') && panelText().includes('다시 켜') && panelText().includes('직접 확인') &&
        !buttonNamed('확인하기') && !headButton() && !lead().includes('구글 자동 확인') && sent('POST', '/api/index-auto/plan').length === 0,
      panelText(),
    )
    ok('키 없음 — 칩 「· 자동」 · 「마지막 확인이 자동」은 확인 기록만으로 보인다', (cellOf(2)?.textContent ?? '').includes('아직 · 자동') && (cellOf(2)?.textContent ?? '').includes('마지막 확인이 자동이에요') && !(cellOf(2)?.textContent ?? '').includes('30일째'))
    await unmount()

    // (다) 연결 설정이 틀림 — 서버 까닭을 보이고 단추 없음.
    await mount(base(() => status({ configError: 'SerpAPI 연결 주소 설정이 올바르지 않아 시작하지 않았어요 — 가상' })))
    ok('연결 설정 틀림 — 까닭을 보이고 단추 · 계획 요청 없음', panelText().includes('연결 주소 설정이 올바르지 않아') && !buttonNamed('확인하기') && !headButton() && sent('POST', '/api/index-auto/plan').length === 0, panelText())
    await unmount()

    // (라) 키 있음 — 펼치기 전에는 계정을 읽지 않고, 펼치면 계획을 받는다.
    let st: Record<string, unknown> = status()
    let planReply: Reply = { status: 200, body: plan() }
    let runReply: Reply = { status: 202, body: { runId: 'r-ui-1', total: 2 } }
    const settingsReply: Reply = { status: 200, body: { settings: { runCap: 30, autoOnOpen: true } } }
    const live = base(
      () => st,
      (a) => {
        if (a.path === '/api/index-auto/plan') return planReply
        if (a.path === '/api/index-auto/run') {
          // 서버처럼 202를 돌려줄 때는 이미 도는 중이다(GET이 진행을 준다).
          if (runReply.status === 202) st = { ...st, running: { runId: (runReply.body as { runId: string }).runId, trigger: 'button', startedAt: '2026-11-30T05:00:00.000Z', total: 2, done: 1 } }
          return runReply
        }
        if (a.path === '/api/index-auto/settings') return settingsReply
        return null
      },
    )
    await mount(live)
    ok('키 있음 — page-lead에 「구글 자동 확인」 문장(검색마다 SerpAPI 사용량)', lead().includes('구글 자동 확인') && lead().includes('SerpAPI'), lead())
    ok('키 있음 — 머리 단추 「구글 자동 확인(2편)」(오늘 볼 글 어림)', (headButton()?.textContent ?? '') === '구글 자동 확인(2편)', headButton()?.textContent)
    ok('키 있음 — 펼치기 전에는 계획(계정 읽기)을 부르지 않는다 · 패널은 접힘', sent('POST', '/api/index-auto/plan').length === 0 && toggle()?.getAttribute('aria-expanded') === 'false')
    ok(
      '칩 — 자동 기록은 「색인됨 · 자동」 · 「아직 · 자동」, 날짜는 「자동 확인」, 사람 기록은 꼬리표 없음',
      (cellOf(1)?.querySelector('.chip')?.textContent ?? '') === '색인됨 · 자동' && (cellOf(1)?.textContent ?? '').includes('11/24 자동 확인') &&
        (cellOf(2)?.querySelector('.chip')?.textContent ?? '') === '아직 · 자동' && (cellOf(6)?.querySelector('.chip')?.textContent ?? '') === '아직' && (cellOf(6)?.textContent ?? '').includes('11/23 확인'),
      [cellOf(1)?.textContent, cellOf(2)?.textContent, cellOf(6)?.textContent],
    )
    ok(
      '칩 — 자동 「아직」의 풀이(확정 아님) · 자동 확인 기록을 칸 툴팁으로',
      (cellOf(2)?.querySelector('.chip')?.getAttribute('title') ?? '').includes('site: 검색에서 이 주소를 못 찾았어요') && (cellOf(2)?.querySelector('.chip')?.getAttribute('title') ?? '').includes('자동 확인 기록: 11/24'),
      cellOf(2)?.querySelector('.chip')?.getAttribute('title'),
    )
    ok(
      '칸 아래 — 결정적 「자동으로 못 가림 — 직접 확인해 주세요(까닭)」 · 오늘 일시 「오늘 자동으로 못 가림」 · 30일째 안내',
      (cellOf(3)?.textContent ?? '').includes('자동으로 못 가림 — 직접 확인해 주세요(비슷한 주소가 많음)') && (cellOf(4)?.textContent ?? '').includes('오늘 자동으로 못 가림 — SerpAPI 응답 시간 초과') &&
        (cellOf(2)?.textContent ?? '').includes('30일째(12/10)에 자동으로 한 번 더 봐요'),
    )
    const tiles = doc.querySelector('.ps-summary')?.textContent ?? ''
    ok('요약 타일 — 구글 색인은 「색인됨인 글(자동 확인 포함)」', tiles.includes('색인됨인 글(자동 확인 포함)'), tiles)

    // 머리 단추 → 패널이 펼쳐지고 포커스가 패널 머리로 · 계획을 받는다(JSON · trigger button).
    await click(headButton())
    await waitFor(() => panelText().includes('이번에 확인할 글'))
    const planCalls = sent('POST', '/api/index-auto/plan')
    ok('펼치기 — 머리 단추가 패널을 펼치고 포커스를 패널 머리로 옮긴다', toggle()?.getAttribute('aria-expanded') === 'true' && doc.activeElement === toggle())
    ok('펼치기 — 계획을 한 번 받는다(JSON 본문 { trigger: button })', planCalls.length === 1 && planCalls[0]?.type === 'application/json' && JSON.stringify(planCalls[0]?.body) === JSON.stringify({ trigger: 'button' }), planCalls)
    const pt = panelText()
    ok('계획 — 「이번에 확인할 글 2편 · 검색 2회」', pt.includes('이번에 확인할 글 2편 · 검색 2회'), pt)
    ok('계획 — 이번 결제 주기(12월 8일 갱신까지) 색인 몫 남은 158회 / 200회 · 계정 남은 958회 · 바닥 500회', pt.includes('12월 8일') && pt.includes('158회') && pt.includes('200회') && pt.includes('958회') && pt.includes('500회'), pt)
    ok('계획 — 요금제(Starter 월 1,000회 · 시간당 200회)', pt.includes('Starter') && pt.includes('1,000회') && pt.includes('시간당 200회'), pt)
    ok('계획 — 3 · 7일째는 직접 · 이번 차례에 못 가린 글은 다시 찾지 않음 · 자동으로 안 찾는 주소', pt.includes('3 · 7일째 차례 1편은 직접 확인') && pt.includes('자동으로 못 가린 글 1편 — 다시 찾지 않아요') && pt.includes('자동으로 안 찾는 주소 1편') && pt.includes('가상 영상'), pt)
    const runBtn = buttonNamed('2편 확인하기(검색 2회)', panel() ?? doc)
    ok('계획 — 단추 이름에 편 수 · 검색 수 「2편 확인하기(검색 2회)」', Boolean(runBtn) && runBtn?.disabled === false)
    ok('계획 — 「열 때 하루 한 번」 설정은 기본 꺼짐 · 한 번에 40편', (doc.getElementById('iap-on-open') as HTMLInputElement | null)?.checked === false && (doc.getElementById('iap-run-cap') as HTMLInputElement | null)?.value === '40')

    // 실행 → 진행 → 끝 → 결과 · 표 다시 읽기.
    const statusReadsBefore = sent('GET', '/api/publish-status').length
    await click(runBtn)
    const runCalls = sent('POST', '/api/index-auto/run')
    ok('실행 — JSON 본문 { planId }만 보낸다', runCalls.length === 1 && runCalls[0]?.type === 'application/json' && JSON.stringify(runCalls[0]?.body) === JSON.stringify({ planId: 'plan-ui-1' }), runCalls)
    ok('실행(키보드) — 누른 단추가 진행으로 바뀌면 포커스는 패널 머리로', doc.activeElement === toggle())
    await waitFor(() => (doc.querySelector('.iap-progress[role="status"]')?.textContent ?? '').includes('1/2'))
    ok('진행 — role=status 「확인하는 중… 1/2」 · 앱을 끄면 멈춘다는 안내 · 머리 단추도 진행', (doc.querySelector('.iap-progress[role="status"]')?.textContent ?? '').includes('확인하는 중… 1/2') && (doc.querySelector('.iap-progress')?.textContent ?? '').includes('앱을 끄면 멈춰요') && (headButton()?.textContent ?? '').includes('확인하는 중… 1/2'))
    const plansBeforeEnd = sent('POST', '/api/index-auto/plan').length
    st = status({ lastRun: RUN_DONE })
    await waitFor(() => panelText().includes('2편 확인 — 색인됨 1 · 아직 0 · 자동으로 못 가림 1'))
    const rt = panelText()
    ok('결과 — 「2편 확인 — 색인됨 1 · 아직 0 · 자동으로 못 가림 1」', rt.includes('2편 확인 — 색인됨 1 · 아직 0 · 자동으로 못 가림 1'), rt)
    ok('결과 — 「자동으로 못 가림」 목록: 글 이름 · 까닭 · 맞은 링크', rt.includes('가상 글 4') && rt.includes('?…만 다른 주소로 나왔어요') && Boolean(panel()?.querySelector(`.iap-list a[href="${U(4)}?amp=1"]`)), rt)
    await waitFor(() => sent('GET', '/api/publish-status').length > statusReadsBefore && sent('POST', '/api/index-auto/plan').length > plansBeforeEnd)
    ok('끝나면 — 발행 현황 표를 다시 읽고 계획을 새로 받는다', sent('GET', '/api/publish-status').length > statusReadsBefore && sent('POST', '/api/index-auto/plan').length > plansBeforeEnd)
    ok('끝나면 — 진행 글자가 사라지고 머리 단추가 돌아온다', doc.querySelector('.iap-progress') === null && (headButton()?.textContent ?? '').startsWith('구글 자동 확인'))

    // 멈춘 실행 — 맨 위에 까닭(role=alert).
    st = status({ lastRun: { ...RUN_DONE, stoppedBy: { kind: 'rate-hour', message: '이번 시간 검색 한도에 닿았어요 — 한 시간쯤 뒤 다시 눌러 주세요. 남은 1편은 확인하지 않았어요.' }, searched: 1, notRun: 1 } })
    await click(reloadButton())
    await waitFor(() => alerts().includes('시간 검색 한도'))
    ok('멈춤 — 멈춘 까닭을 role=alert로(남은 편 수까지)', alerts().includes('이번 시간 검색 한도에 닿았어요') && alerts().includes('남은 1편'), alerts())

    // 설정 — 바꾼 값만 JSON으로 저장한다.
    await typeInto(doc.getElementById('iap-run-cap'), '30')
    await click(doc.getElementById('iap-on-open'))
    await click(buttonNamed('설정 저장', panel() ?? doc))
    const put = sent('PUT', '/api/index-auto/settings')
    ok('설정 — JSON 본문 { runCap: 30, autoOnOpen: true }', put.length === 1 && put[0]?.type === 'application/json' && JSON.stringify(put[0]?.body) === JSON.stringify({ runCap: 30, autoOnOpen: true }), put)
    ok('설정 — 저장 뒤에 화면이 받은 값으로 바뀐다', (doc.getElementById('iap-run-cap') as HTMLInputElement | null)?.value === '30' && (doc.getElementById('iap-on-open') as HTMLInputElement | null)?.checked === true && panelText().includes('저장했어요'))
    const putBefore = sent('PUT', '/api/index-auto/settings').length
    await typeInto(doc.getElementById('iap-run-cap'), '0')
    await click(buttonNamed('설정 저장', panel() ?? doc))
    ok('설정 — 범위 밖(0)은 화면이 막는다(보내지 않음)', sent('PUT', '/api/index-auto/settings').length === putBefore && panelText().includes('1~200'))

    // 계획이 바뀜(409) — 까닭을 보이고 계획을 다시 받는다.
    await click(buttonNamed('계획 다시 받기', panel() ?? doc))
    await waitFor(() => Boolean(buttonNamed('확인하기(검색 2회)', panel() ?? doc)))
    runReply = { status: 409, body: { error: '계획이 바뀌었어요 — 계획을 다시 받아 주세요.' } }
    const plans409 = sent('POST', '/api/index-auto/plan').length
    await click(buttonNamed('확인하기(검색 2회)', panel() ?? doc))
    await waitFor(() => sent('POST', '/api/index-auto/plan').length > plans409)
    ok('실행 409 — 까닭을 패널 안에(role=alert) 보이고 계획을 새로 받는다', alerts().includes('계획이 바뀌었어요') && sent('POST', '/api/index-auto/plan').length > plans409, alerts())

    // 막힘 — 계정을 못 읽으면 검색 0 · 단추 없음 · 까닭(패널 안에서만), 표는 그대로.
    planReply = { status: 200, body: plan({ planId: null, searches: 0, limitedBy: 'account', blocked: 'SerpAPI 계정 상태를 읽지 못해 시작하지 않았어요.', quota: null }) }
    await click(buttonNamed('계획 다시 받기', panel() ?? doc))
    await waitFor(() => panelText().includes('계정 상태를 읽지 못해'))
    ok(
      '막힘 — 계정을 못 읽으면 검색하지 않는다(단추 없음 · 까닭 role=alert) · 표는 그대로',
      alerts().includes('계정 상태를 읽지 못해') && !alerts().includes('계획이 바뀌었어요') && !buttonNamed('확인하기(검색', panel() ?? doc) && doc.querySelectorAll('.ps-table tbody tr').length === ROWS.length,
      panelText(),
    )
    planReply = { status: 502, body: { error: 'SerpAPI 계정 상태를 읽지 못해 시작하지 않았어요 — 가상 502' } }
    await click(buttonNamed('계획 다시 받기', panel() ?? doc))
    await waitFor(() => panelText().includes('가상 502'))
    ok('계획 오류 — 패널 안에서만 알리고(role=alert) 표 · 표 위 오류는 그대로', panelText().includes('가상 502') && doc.querySelectorAll('.ps-table tbody tr').length === ROWS.length && [...doc.querySelectorAll('p.error[role="alert"]')].every((p) => panel()?.contains(p)))

    // 키보드 — 패널 머리는 단추이고 다시 누르면 접힌다.
    await click(toggle())
    ok('키보드 — 패널 머리는 단추(aria-expanded) · 다시 누르면 접힘', toggle()?.tagName === 'BUTTON' && toggle()?.getAttribute('aria-expanded') === 'false' && (doc.getElementById('iap-body') as HTMLElement | null)?.hidden === true)

    // CSV — 확인 방법 두 열.
    await click(buttonNamed('CSV로 받기'))
    const csvText = csvBlob ? await (csvBlob as Blob).text() : ''
    ok('CSV — 끝에 「네이버 확인 방법」 「구글 확인 방법」 열(자동 · 직접)', (csvText.split('\r\n')[0] ?? '').endsWith(',네이버 확인 방법,구글 확인 방법') && csvText.includes(',자동\r\n'), csvText.slice(0, 400))
    await unmount()

    // (마) 열 때 하루 한 번 — 켜져 있고 오늘 안 했으면 열자마자 계획 → 실행(한 번만).
    st = status({ settings: { runCap: 40, autoOnOpen: true } })
    planReply = { status: 200, body: plan({ planId: 'plan-open', trigger: 'open' }) }
    runReply = { status: 202, body: { runId: 'r-ui-open', total: 2 } }
    await mount(live)
    await waitFor(() => sent('POST', '/api/index-auto/run').length > 0 && (doc.querySelector('.iap-progress')?.textContent ?? '').includes('1/2'))
    await click(reloadButton())
    await settle(4)
    const openPlans = sent('POST', '/api/index-auto/plan')
    const openRuns = sent('POST', '/api/index-auto/run')
    ok(
      '열 때 하루 한 번(켬) — 열자마자 계획(trigger open) → 실행(planId) 한 번씩, 다시 읽어도 또 하지 않는다 · 패널이 펼쳐져 진행이 보인다',
      openPlans.length === 1 && JSON.stringify(openPlans[0]?.body) === JSON.stringify({ trigger: 'open' }) && openRuns.length === 1 && JSON.stringify(openRuns[0]?.body) === JSON.stringify({ planId: 'plan-open' }) &&
        toggle()?.getAttribute('aria-expanded') === 'true',
      [openPlans.map((p) => p.body), openRuns.map((p) => p.body)],
    )
    await unmount()
    st = status({ settings: { runCap: 40, autoOnOpen: true }, openRunToday: true })
    await mount(live)
    ok('열 때 하루 한 번 — 오늘 이미 했으면 계획도 받지 않는다', sent('POST', '/api/index-auto/plan').length === 0 && sent('POST', '/api/index-auto/run').length === 0)
    await unmount()
    st = status()
    await mount(live)
    ok('열 때 하루 한 번(기본 끔) — 열기만 해서는 계획 · 실행 요청이 없다', sent('POST', '/api/index-auto/plan').length === 0 && sent('POST', '/api/index-auto/run').length === 0)
    await unmount()

    // (바) 자동 확인 상태를 못 읽음(500) — 패널 안에서만 알리고 표는 그대로.
    const broken = { status: 500, body: { error: '자동 확인 기록 파일(index-auto.json)이 깨져 있어 시작하지 않았어요.' } }
    await mount((a) => (a.path === '/api/index-auto' ? broken : base(() => status())(a)))
    await waitFor(() => panelText().includes('깨져 있어'))
    ok('상태 읽기 실패 — 패널 안에서만 알린다(머리 단추 없음 · 표 그대로)', panelText().includes('깨져 있어') && !headButton() && doc.querySelectorAll('.ps-table tbody tr').length === ROWS.length, panelText())
    await unmount()

    ok('가짜 fetch — /api/ 밖(진짜 SerpAPI 포함)으로 나가려 한 요청이 없다', outside.length === 0, outside)
  } catch (err) {
    ok(`화면 검사가 예외 없이 끝난다: ${err instanceof Error ? err.stack : String(err)}`, false)
  } finally {
    globalThis.fetch = realFetch
    URL.createObjectURL = realCreateObjectURL
    URL.revokeObjectURL = realRevoke
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
