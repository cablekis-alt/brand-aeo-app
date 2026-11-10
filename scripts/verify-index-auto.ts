/**
 * 색인 자동 확인(src/lib/indexAuto.ts · server/indexAuto.ts · server/indexChecks.ts writeIndexCheck · /api/index-auto 라우트)을 확인한다.
 *
 * 안전 규칙(검색마다 돈이 든다 — 지키지 않으면 check-all이 사람이 안 보는 사이 진짜 크레딧을 쓴다):
 * - 진짜 SerpAPI(serpapi.com)는 부르지 않는다. 가짜 SerpAPI 서버를 127.0.0.1:4195에 띄우고 SERPAPI_BASE_URL을 그리로 준다. 시작 전에 그 값이
 *   루프백인지 단언하고 아니면 바로 끝낸다. 이 프로세스의 fetch는 127.0.0.1 밖으로 나가면 막고 기록한다. 띄우는 앱 서버(포트 4194)에는
 *   serpapi.com으로 가는 fetch를 막는 가드를 --import로 얹는다.
 * - 키는 가짜(test-serp-<무작위>, 진짜 키 모양과 다름)다. 가짜 서버는 받은 api_key가 그 값인지 매번 본다. 부르는 단계에서는 가짜 서버가
 *   받은 수를 센다(= 진짜로 새지 않았다).
 * - 앱 서버는 DOTENV_CONFIG_PATH=<임시 폴더>/no-such.env로 띄운다 — server/index.ts의 'dotenv/config'가 저장소 .env의 진짜 키를 읽지 않게.
 *   「키 없음」은 SERPAPI_API_KEY=''로 준다(지우면 dotenv가 진짜 키를 채울 수 있다).
 * - 임시 폴더(APP_DATA_DIR)만 쓴다. 설치본(포트 4000) · 실데이터는 건드리지 않는다. 브랜드 · 주소 · 제목은 모두 가짜다(작성자 없음).
 *
 * 무엇을 보나:
 * A. 순수 함수 — 검색어(site: · 티스토리 /m/ · 네이버 두 모양 · www 두 모양 · 추적 질의 떼기 · 안 찾는 주소), 판정(정확 일치 · /m/ · m. ·
 *    덜 찬 쪽 · 꽉 찬 쪽 · 다음 쪽 · ?… 변형 · 빈 결과 문구 · 모양 이상 · 자동 교정 · 오류 · 네이버 블로그), 대상(14일째 차례 · 자동 「아직」뿐인
 *    글의 30일째 · 3 · 7일째는 직접 · 대표 줄 · 같은 주소 1번 · 묶음 순서), 차례 규칙(결정적 1회 · 일시 2회 · 멈춤 오류는 안 셈), 몫 계산.
 * B. writeIndexCheck — 사람 표시는 그대로, 자동은 계획 때 본 원본 기록과 같을 때만(CAS) · 이 줄이 「색인됨」이면 건드리지 않음(R1) · 원본이
 *    「색인됨」이면 「아직」은 쓰지 않고 찾음은 적음(R4 — 다시 올린 글) · 옛 판(v0.4.63 · v0.4.64) 파서가 자동이 쓴 파일을 읽는다.
 * C. 서버 — 계획(검색 0) · 실행(주소 키마다 1번 · 매개변수) · 결과를 줄마다 · CAS · 격리(원장 · 집행 상태 · 앱 밖 글 바이트 같음) · 차례 규칙 ·
 *    401 · 403 · 429(두 가지) 멈춤 · 몫 · 바닥 · 계정 · 끊김(어디까지 했는지 남음) · JSON만(415) · Host · Origin(DNS 리바인딩 403) · 계획 id ·
 *    한 번에 하나(앱을 두 번 켠 두 서버 사이에도) · 열 때 하루 한 번 · 키 없음 · 막힌 쪽 주소 · 깨진 기록 파일 · 모르는 값 보존 · 키가 어디에도 없음.
 *
 *   npx tsx scripts/verify-index-auto.ts
 */
import { execSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  autoReasonText,
  autoTurnOf,
  GOOGLE_NO_RESULTS,
  googleSearchParams,
  googleSiteQuery,
  judgeGoogle,
  manualTurnOf,
  planAutoTargets,
  planSearches,
  turnProgress,
  type AttemptLike,
} from '../src/lib/indexAuto'
import { todayKst, trackingKey } from '../src/lib/publishedUrl'
import { addDays, type IndexCheck, type PlatformKey, type PublishStatus, type PublishStatusRow, type TenantChecks } from '../src/lib/publishStatus'
import type { IndexAutoPlanView, IndexAutoRunRecord, IndexAutoStatusView } from '../server/indexAuto'

const MOCK_PORT = 4195
const APP_PORT = 4194
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`
const APP_BASE = `http://127.0.0.1:${APP_PORT}`
/** 앱을 두 번 켠 경우의 둘째 서버(같은 APP_DATA_DIR). */
const APP2_PORT = 4193
const FAKE_KEY = `test-serp-${randomBytes(6).toString('hex')}`

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

if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(MOCK_BASE) || !FAKE_KEY.startsWith('test-serp-')) {
  console.error('가짜 SerpAPI 주소(127.0.0.1) · 가짜 키가 아니라 시작하지 않습니다.')
  process.exit(1)
}

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean, detail?: unknown) => {
  checks.push([label, cond])
  if (!cond && detail !== undefined) console.error(`  ✗ ${label}:`, typeof detail === 'string' ? detail : JSON.stringify(detail, null, 1).slice(0, 3000))
}
const sorted = (o: Record<string, unknown>) => JSON.stringify(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ══ A. 순수 함수 ══════════════════════════════════════════════════════════════

// ── 검색어 ──
const q = (url: string, platform: PlatformKey | null) => {
  const r = googleSiteQuery(url, platform)
  return r.ok ? r.q : `refused:${r.reason}`
}
ok('검색어 — 티스토리는 PC · /m/ 두 모양을 OR(끝 슬래시 · 질의 뗌, 호스트 소문자)', q('https://Fake.tistory.com/2/?category=7', 'tistory') === 'site:fake.tistory.com/2 OR site:fake.tistory.com/m/2', q('https://Fake.tistory.com/2/?category=7', 'tistory'))
ok('검색어 — 티스토리 /m/ 주소로 적어도 같은 검색', q('https://fake.tistory.com/m/2', 'tistory') === 'site:fake.tistory.com/2 OR site:fake.tistory.com/m/2')
ok(
  '검색어 — 티스토리 한글 제목 주소는 인코딩 그대로',
  q('https://fake.tistory.com/entry/%EA%B0%80%EC%83%81#c1', 'tistory') === 'site:fake.tistory.com/entry/%EA%B0%80%EC%83%81 OR site:fake.tistory.com/m/entry/%EA%B0%80%EC%83%81',
)
ok(
  '검색어 — 네이버 블로그는 /id/logNo로(PostView 모양도) blog · m.blog 두 모양',
  q('https://blog.naver.com/PostView.naver?blogId=fakeid&logNo=224000000001', 'naver-blog') === 'site:blog.naver.com/fakeid/224000000001 OR site:m.blog.naver.com/fakeid/224000000001' &&
    q('https://m.blog.naver.com/fakeid/224000000001', 'naver-blog') === 'site:blog.naver.com/fakeid/224000000001 OR site:m.blog.naver.com/fakeid/224000000001',
)
ok('검색어 — www가 붙은 주소는 두 모양', q('https://www.stay.example/blog/1', 'owned') === 'site:www.stay.example/blog/1 OR site:stay.example/blog/1')
ok(
  '검색어 — 그 밖은 등록 주소 그대로(인코딩 · 원문 한글 모두)',
  q('https://wp.example/%ED%95%9C%EA%B8%80-slug/', 'other') === 'site:wp.example/%ED%95%9C%EA%B8%80-slug' && q('https://wp.example/한글-slug', 'other') === 'site:wp.example/한글-slug',
)
ok('검색어 — 추적 질의(utm_* · fbclid)만 떼고 찾는다', q('https://wp.example/post?utm_source=openai&fbclid=x', 'other') === 'site:wp.example/post')
ok('검색어 — 추적 질의를 떼고도 질의가 남으면 자동으로 안 찾음', q('https://board.example/view?idx=5', 'other') === 'refused:query')
ok('검색어 — 유튜브 · 인스타그램은 안 찾음', q('https://www.youtube.com/watch?v=fakeVid', 'youtube') === 'refused:platform' && q('https://www.instagram.com/p/FAKE/', 'instagram') === 'refused:platform')
ok('검색어 — 첫 화면 · 포트 · 주소 아님은 모양 오류', q('https://wp.example/', 'other') === 'refused:form' && q('https://wp.example:8443/a', 'other') === 'refused:form' && q('not a url', null) === 'refused:form')
ok(
  '매개변수 — engine=google · google.co.kr · gl=kr · hl=ko · nfpr=1 · filter=0(num · start · no_cache · async 없음)',
  sorted(googleSearchParams('site:x')) === sorted({ engine: 'google', q: 'site:x', google_domain: 'google.co.kr', gl: 'kr', hl: 'ko', nfpr: '1', filter: '0' }),
  googleSearchParams('site:x'),
)

// ── 판정 ──
const KEY = 'fake.tistory.com/2'
const res = (organic: (string | Record<string, unknown>)[] | undefined, extra: Record<string, unknown> = {}) => ({
  search_metadata: { status: 'Success' },
  ...(organic ? { organic_results: organic.map((l, i) => (typeof l === 'string' ? { position: i + 1, link: l } : l)) } : {}),
  ...extra,
})
const judge = (json: unknown, key = KEY, platform: PlatformKey | null = 'tistory') => judgeGoogle(key, platform, json)
const j1 = judge(res(['https://fake.tistory.com/2']))
ok('판정 — 같은 주소 → 찾음(맞은 링크를 남김)', j1.outcome === 'found' && j1.matched === 'https://fake.tistory.com/2', j1)
const j2 = judge(res(['https://fake.tistory.com/20', 'https://fake.tistory.com/m/2/']))
ok('판정 — 모바일(/m/) 링크도 같은 주소 → 찾음', j2.outcome === 'found' && j2.matched === 'https://fake.tistory.com/m/2/', j2)
ok('판정 — 네이버 m. 링크도 같은 주소 → 찾음', judgeGoogle('blog.naver.com/fakeid/224000000010', 'naver-blog', res(['https://m.blog.naver.com/fakeid/224000000010'])).outcome === 'found')
const j3 = judge(res(['https://fake.tistory.com/20', 'https://fake.tistory.com/21']))
ok('판정 — 덜 찬 쪽에 /20 · /21만 → 못 찾음(결과 수)', j3.outcome === 'not-found' && j3.results === 2, j3)
const ten = Array.from({ length: 10 }, (_, i) => `https://fake.tistory.com/2${i}`)
const j4 = judge(res(ten))
ok('판정 — 결과 10건(쪽이 참) → 자동으로 못 가림(similar-many)', j4.outcome === 'unknown' && j4.reason === 'similar-many', j4)
const j5 = judge(res(['https://fake.tistory.com/20'], { serpapi_pagination: { next: 'https://serpapi.com/search.json?start=10' } }))
ok('판정 — 다음 쪽이 있으면 → similar-many', j5.outcome === 'unknown' && j5.reason === 'similar-many', j5)
ok('판정 — 꽉 찬 쪽이라도 같은 주소가 있으면 찾음', judge(res([...ten.slice(0, 9), 'https://fake.tistory.com/2'])).outcome === 'found')
const j6 = judgeGoogle('wp.example/post-a', 'other', res(['https://wp.example/post-a?amp=1']))
ok('판정 — ?…만 다른 주소 → other-url(링크를 근거로)', j6.outcome === 'unknown' && j6.reason === 'other-url' && j6.matched === 'https://wp.example/post-a?amp=1', j6)
const j7 = judge({ search_metadata: { status: 'Success' }, error: GOOGLE_NO_RESULTS })
ok('판정 — 정확히 빈 결과 문구 → 못 찾음(0건)', j7.outcome === 'not-found' && j7.results === 0, j7)
const j8 = judge({ search_metadata: { status: 'Success' } })
ok('판정 — organic_results가 없으면(오류도 없음) 0건으로 읽지 않고 parse', j8.outcome === 'unknown' && j8.reason === 'parse', j8)
ok('판정 — organic_results가 배열이 아니면 parse', (() => { const j = judge(res(undefined, { organic_results: {} })); return j.outcome === 'unknown' && j.reason === 'parse' })())
const j9 = judge(res(['https://fake.tistory.com/2'], { search_information: { organic_results_state: 'Showing results for fake.tistory.com/22' } }))
ok('판정 — 자동 교정 결과 → corrected(같은 주소가 있어도)', j9.outcome === 'unknown' && j9.reason === 'corrected' && j9.organicState === 'Showing results for fake.tistory.com/22', j9)
ok('판정 — "Results for exact spelling"이면 그대로 판정', judge(res(['https://fake.tistory.com/2'], { search_information: { organic_results_state: 'Results for exact spelling' } })).outcome === 'found')
const j10 = judge({ search_metadata: { status: 'Error' }, error: 'Something went wrong.' })
ok('판정 — status Error → upstream', j10.outcome === 'unknown' && j10.reason === 'upstream', j10)
const j11 = judge({ search_metadata: { status: 'Success' }, error: "Google hasn't returned any results for this query" })
ok('판정 — 빈 결과 문구와 정확히 같지 않은 오류 → upstream', j11.outcome === 'unknown' && j11.reason === 'upstream', j11)
ok('판정 — 메타 없음 · 객체 아님 → parse', judge({ organic_results: [] }).outcome === 'unknown' && judge('x').outcome === 'unknown' && (judge(null) as { reason?: string }).reason === 'parse')
const j12 = judgeGoogle('blog.naver.com/fakeid/224000000009', 'naver-blog', res(['https://blog.naver.com/fakeid/2240000000091']))
const j13 = judgeGoogle('blog.naver.com/fakeid/224000000009', 'naver-blog', { search_metadata: { status: 'Success' }, error: GOOGLE_NO_RESULTS })
ok('판정 — 네이버 블로그 글은 못 찾으면 적지 않음(naver-form)', j12.outcome === 'unknown' && j12.reason === 'naver-form' && j13.outcome === 'unknown' && j13.reason === 'naver-form', { j12, j13 })
ok(
  '판정 — sitelinks · 광고는 보지 않는다',
  judge(res([{ link: 'https://fake.tistory.com/20', sitelinks: { inline: [{ link: 'https://fake.tistory.com/2' }] } }], { ads: [{ link: 'https://fake.tistory.com/2' }] })).outcome === 'not-found',
)

// ── 차례 ──
const TODAY = '2026-11-30'
const g = (state: IndexCheck['state'], checkedOn: string, source: IndexCheck['source'] = 'manual'): IndexCheck => ({ state, checkedOn, checkedAt: `${checkedOn}T03:00:00.000Z`, source })
const row = (over: Partial<PublishStatusRow>): PublishStatusRow => {
  const url = over.url ?? 'https://x.tistory.com/1'
  return {
    rowKey: `${over.tenantId ?? 'vt-a'}|${over.postId ?? 'p-x'}`,
    tenantId: 'vt-a',
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
    publishedOn: '2026-11-16',
    recheckFrom: '2026-11-16',
    trackedOn: null,
    removed: null,
    naver: null,
    google: null,
    checkFrom: null,
    ...over,
  }
}
const from = (day: string, over: Partial<PublishStatusRow> = {}) => row({ publishedOn: day, recheckFrom: day, ...over })
const t1 = autoTurnOf(from('2026-11-16'), TODAY)
ok('차례 — 14일째(오늘) → day14, 차례 id는 14일째 날', JSON.stringify(t1) === JSON.stringify({ tier: 'day14', turn: 'd14:2026-11-30', since: '2026-11-30' }), t1)
ok('차례 — 14일 지난 글도 14일째 차례 그대로(같은 id)', autoTurnOf(from('2026-11-10'), TODAY)?.turn === 'd14:2026-11-24')
ok('차례 — 7일째 사람 「아직」은 14일째 차례를 막지 않는다', autoTurnOf(from('2026-11-10', { google: g('not-yet', '2026-11-20') }), TODAY)?.turn === 'd14:2026-11-24')
ok('차례 — 7일째 · 3일째 차례는 자동 대상이 아니고 직접 보는 글', autoTurnOf(from('2026-11-20'), TODAY) === null && manualTurnOf(from('2026-11-20'), TODAY) && autoTurnOf(from('2026-11-26'), TODAY) === null && manualTurnOf(from('2026-11-26'), TODAY))
ok('차례 — 3일째 전 · 색인됨 · 뺀 글 · 안 올린 글 · 날짜 모름은 어느 쪽도 아님', [
  from('2026-11-28'),
  from('2026-11-10', { google: g('shown', '2026-11-12') }),
  from('2026-11-10', { removed: { reason: 'taken-down', at: '2026-11-20' } }),
  from('2026-11-10', { kind: 'unposted' }),
  row({ publishedOn: null, recheckFrom: null }),
].every((r) => autoTurnOf(r, TODAY) === null && !manualTurnOf(r, TODAY)))
ok('차례 — 14일째 뒤 마지막 확인이 사람 「아직」이면 끝(30일째도 아님)', autoTurnOf(from('2026-10-30', { google: g('not-yet', '2026-11-13') }), TODAY) === null)
const t30 = autoTurnOf(from('2026-10-30', { google: g('not-yet', '2026-11-13', 'auto') }), TODAY)
ok('차례 — 마지막 확인이 자동 「아직」뿐이면 30일째 한 번 더', JSON.stringify(t30) === JSON.stringify({ tier: 'day30', turn: 'd30:2026-11-29', since: '2026-11-29' }), t30)
ok('차례 — 30일째 전이면 아직 아님 · 30일째 뒤 자동 확인이 있으면 끝', autoTurnOf(from('2026-10-30', { google: g('not-yet', '2026-11-13', 'auto') }), '2026-11-28') === null && autoTurnOf(from('2026-10-30', { google: g('not-yet', '2026-11-29', 'auto') }), TODAY) === null)
ok('차례 — 앱 밖 줄은 recheckFrom(추적 시작일)으로 센다', autoTurnOf(row({ origin: 'external', publishedOn: '2026-10-01', recheckFrom: '2026-11-16' }), TODAY)?.turn === 'd14:2026-11-30')
ok(
  '차례 — 오늘 자동 「아직」을 적으면 14일째 차례는 끝, 30일째에 다시',
  autoTurnOf(from('2026-11-16', { google: g('not-yet', TODAY, 'auto') }), TODAY) === null && autoTurnOf(from('2026-11-16', { google: g('not-yet', TODAY, 'auto') }), '2026-12-16')?.turn === 'd30:2026-12-16',
)

// ── 차례 단위 시도(D11) ──
const att = (outcome: string, reason?: string, turn = 'd14:2026-11-30', key = 'k'): AttemptLike => ({ key, turn, outcome, ...(reason ? { reason } : {}) })
const tp = (list: AttemptLike[]) => turnProgress(list, 'k', 'd14:2026-11-30')
ok('시도 — 없음 → 열림', JSON.stringify(tp([])) === JSON.stringify({ settled: false, transient: 0 }))
ok('시도 — 일시 오류 1회 → 열림(두 번째 시도 남음)', ['timeout', 'upstream', 'parse', 'interrupted'].every((r) => JSON.stringify(tp([att('unknown', r)])) === JSON.stringify({ settled: false, transient: 1 })))
ok('시도 — 대기(pending)도 일시 1회로 셈', tp([att('pending')]).transient === 1 && !tp([att('pending')]).settled)
ok('시도 — 일시 오류 합계 2회 → 끝', tp([att('unknown', 'timeout'), att('unknown', 'parse')]).settled)
ok('시도 — 결정적 못 가림은 1회로 끝', ['similar-many', 'other-url', 'corrected', 'naver-form'].every((r) => tp([att('unknown', r)]).settled))
ok('시도 — 찾음 · 못 찾음(적음 · 건너뜀) → 끝', tp([att('found')]).settled && tp([att('not-found')]).settled)
ok(
  '시도 — 실행을 멈춘 오류 · 보내지 않은 시도는 세지 않는다',
  ['key', 'forbidden', 'quota-month', 'rate-hour', 'bad-request', 'account', 'ledger', 'config', 'write'].every((r) => JSON.stringify(tp([att('unknown', r)])) === JSON.stringify({ settled: false, transient: 0 })) &&
    JSON.stringify(tp([att('not-sent', 'floor'), att('not-sent', 'feature-cap')])) === JSON.stringify({ settled: false, transient: 0 }),
)
ok('시도 — 모르는 까닭 · 모르는 결과(나중 판)는 끝으로 본다(돈이 덜 드는 쪽)', tp([att('unknown', 'future-reason')]).settled && tp([att('weird-outcome')]).settled)
ok('시도 — 다른 차례 · 다른 주소는 섞이지 않는다', !tp([att('found', undefined, 'd14:2026-11-24'), att('found', undefined, 'd14:2026-11-30', 'other')]).settled)

// ── 대상 고르기 ──
const tk = (url: string) => trackingKey(url) as string
const CHECKS: TenantChecks[] = [
  {
    tenantId: 'vt-a',
    checks: {
      'p-a1': { postId: 'p-a1', key: tk('https://k1.tistory.com/1'), url: 'https://k1.tistory.com/1', google: g('not-yet', '2026-11-20'), updatedAt: '2026-11-20T03:00:00.000Z' },
    },
  },
  {
    tenantId: 'vt-b',
    checks: {
      'p-b9': { postId: 'p-b9', key: tk('https://k9.tistory.com/9'), url: 'https://k9.tistory.com/9', google: g('shown', '2026-11-10'), updatedAt: '2026-11-10T03:00:00.000Z' },
    },
  },
]
const planRows: PublishStatusRow[] = [
  from('2026-11-16', { tenantId: 'vt-a', postId: 'p-a1', url: 'https://k1.tistory.com/1', key: tk('https://k1.tistory.com/1'), google: g('not-yet', '2026-11-20') }),
  from('2026-11-16', { tenantId: 'vt-b', postId: 'p-b1', url: 'https://k1.tistory.com/1', key: tk('https://k1.tistory.com/1'), google: g('not-yet', '2026-11-20') }),
  row({ tenantId: 'vt-b', postId: 'x-bbbbbbbbbb02', origin: 'external', publishedOn: null, recheckFrom: '2026-11-10', url: 'https://k2.tistory.com/2', key: tk('https://k2.tistory.com/2') }),
  from('2026-11-20', { tenantId: 'vt-c', postId: 'p-c2', url: 'https://k2.tistory.com/2', key: tk('https://k2.tistory.com/2') }),
  row({ tenantId: 'vt-a', postId: 'x-aaaaaaaaaa03', origin: 'external', publishedOn: null, recheckFrom: '2026-11-16', url: 'https://k3.tistory.com/3', key: tk('https://k3.tistory.com/3') }),
  from('2026-11-16', { tenantId: 'vt-c', postId: 'p-c3', url: 'https://k3.tistory.com/3', key: tk('https://k3.tistory.com/3') }),
  from('2026-11-20', { tenantId: 'vt-a', postId: 'p-a4', url: 'https://k4.tistory.com/4', key: tk('https://k4.tistory.com/4') }),
  from('2026-10-30', { tenantId: 'vt-a', postId: 'p-a5', url: 'https://k5.tistory.com/5', key: tk('https://k5.tistory.com/5'), google: g('not-yet', '2026-11-13', 'auto') }),
  from('2026-11-16', { tenantId: 'vt-a', postId: 'p-a6', url: 'https://k6.tistory.com/6', key: tk('https://k6.tistory.com/6') }),
  from('2026-11-16', { tenantId: 'vt-a', postId: 'p-a7', url: 'https://k7.tistory.com/7', key: tk('https://k7.tistory.com/7') }),
  from('2026-11-16', { tenantId: 'vt-a', postId: 'p-a8', url: 'https://www.youtube.com/watch?v=fakeVid', key: tk('https://www.youtube.com/watch?v=fakeVid'), platform: { key: 'youtube', label: '유튜브' } }),
  from('2026-11-16', { tenantId: 'vt-a', postId: 'p-a9', url: 'https://k9.tistory.com/9', key: tk('https://k9.tistory.com/9') }),
  from('2026-11-01', { tenantId: 'vt-a', postId: 'p-a10', url: 'https://k10.tistory.com/10', key: tk('https://k10.tistory.com/10') }),
  from('2026-11-01', { tenantId: 'vt-a', postId: 'p-a11', url: 'https://k11.tistory.com/11', key: tk('https://k11.tistory.com/11') }),
  from('2026-11-16', { tenantId: 'vt-a', postId: 'p-a12', url: 'https://k12.tistory.com/12', key: tk('https://k12.tistory.com/12'), removed: { reason: 'taken-down', at: '2026-11-20' } }),
]
const planAttempts: AttemptLike[] = [
  att('unknown', 'timeout', 'd14:2026-11-30', tk('https://k6.tistory.com/6')),
  att('unknown', 'similar-many', 'd14:2026-11-30', tk('https://k7.tistory.com/7')),
  // 14일 지난 글을 사흘 잇따라 — 첫날 시간 초과 · 둘째 날 응답 오류 → 셋째 날은 대상이 아니다(같은 차례 id, 합계 2회).
  att('unknown', 'timeout', 'd14:2026-11-15', tk('https://k11.tistory.com/11')),
  att('unknown', 'upstream', 'd14:2026-11-15', tk('https://k11.tistory.com/11')),
  att('unknown', 'key', 'd14:2026-11-15', tk('https://k10.tistory.com/10')),
]
const plan = planAutoTargets({ rows: planRows, today: TODAY, checks: CHECKS, attempts: planAttempts, tenantOrder: ['vt-a', 'vt-b', 'vt-c'] })
const keysOf = plan.targets.map((t) => t.key)
ok(
  '대상 — 순서: 14일째 첫 시도(since 오래된 것부터) → 30일째 → 일시 오류 두 번째 시도',
  JSON.stringify(keysOf) === JSON.stringify(['k10.tistory.com/10', 'k2.tistory.com/2', 'k1.tistory.com/1', 'k3.tistory.com/3', 'k9.tistory.com/9', 'k5.tistory.com/5', 'k6.tistory.com/6']),
  keysOf,
)
const byKey = (k: string) => plan.targets.find((t) => t.key === k)
ok('대상 — 두 브랜드의 같은 주소는 검색 1번 · 대표는 설정 순 첫 브랜드', plan.targets.filter((t) => t.key === 'k1.tistory.com/1').length === 1 && byKey('k1.tistory.com/1')?.tenantId === 'vt-a' && byKey('k1.tistory.com/1')?.postId === 'p-a1')
ok('대상 — 대표 줄은 14일째 차례인 줄에서(7일째 앱 글보다 14일째 앱 밖 글)', byKey('k2.tistory.com/2')?.tenantId === 'vt-b' && byKey('k2.tistory.com/2')?.origin === 'external' && byKey('k2.tistory.com/2')?.turn === 'd14:2026-11-24')
ok('대상 — 같은 차례면 앱 글 줄이 먼저(설정 순보다 앞)', byKey('k3.tistory.com/3')?.tenantId === 'vt-c' && byKey('k3.tistory.com/3')?.origin === 'app')
ok('대상 — 30일째 한 번 더', byKey('k5.tistory.com/5')?.tier === 'day30' && byKey('k5.tistory.com/5')?.turn === 'd30:2026-11-29' && byKey('k5.tistory.com/5')?.batch === 'first')
ok('대상 — 일시 오류 1회 글은 두 번째 시도(retry)', byKey('k6.tistory.com/6')?.batch === 'retry' && byKey('k1.tistory.com/1')?.batch === 'first')
ok('대상 — 멈춤 오류만 있던 글은 첫 시도 그대로', byKey('k10.tistory.com/10')?.batch === 'first')
ok(
  '대상 — 검색어 · CAS 기준값(원본 최신 기록의 구글 확인 시각)',
  byKey('k1.tistory.com/1')?.query === 'site:k1.tistory.com/1 OR site:k1.tistory.com/m/1' && byKey('k1.tistory.com/1')?.expectRawCheckedAt === '2026-11-20T03:00:00.000Z' && byKey('k3.tistory.com/3')?.expectRawCheckedAt === null,
)
ok('대상 — 3 · 7일째만 차례인 주소는 직접 보는 글로 센다', plan.manual === 1, plan.manual)
ok('대상 — 이번 차례에 자동으로 못 가린 주소(결정적 · 일시 2회)는 다시 찾지 않는다', plan.settled === 2, plan.settled)
ok('대상 — 유튜브는 자동으로 안 찾는 주소', plan.unsupported.length === 1 && plan.unsupported[0]?.reason === 'platform' && plan.unsupported[0]?.key === 'youtube.com/watch?v=fakeVid', plan.unsupported)
ok(
  '대상 — 원본 기록이 「색인됨」인 주소(다른 줄 · 내리기 전 올림)도 대상(R4 — 찾으면 적고 「아직」은 쓰는 쪽이 건너뜀) · CAS 기준값은 그 기록',
  byKey('k9.tistory.com/9')?.tenantId === 'vt-a' && byKey('k9.tistory.com/9')?.expectRawCheckedAt === '2026-11-10T03:00:00.000Z' && !('shownElsewhere' in plan),
  byKey('k9.tistory.com/9'),
)
ok('대상 — 뺀 줄은 대상이 아니다', !byKey('k12.tistory.com/12'))

// ── 몫 계산 ──
const A = (o: Partial<{ featureLeft: number; aboveFloor: number; hourLeft: number; allowed: number }> = {}) => ({ featureLeft: 200, aboveFloor: 490, hourLeft: 200, allowed: 200, ...o })
const ps = (n: number, cap: number, a: ReturnType<typeof A> | null) => JSON.stringify(planSearches(n, cap, a))
ok('몫 — 대상이 적으면 그대로', ps(12, 40, A()) === JSON.stringify({ searches: 12, limitedBy: null }))
ok('몫 — 한 번 상한', ps(50, 40, A()) === JSON.stringify({ searches: 40, limitedBy: 'run-cap' }))
ok('몫 — 색인 몫 남음', ps(12, 40, A({ featureLeft: 3, allowed: 3 })) === JSON.stringify({ searches: 3, limitedBy: 'feature-cap' }))
ok('몫 — 계정 바닥', ps(12, 40, A({ aboveFloor: 0, allowed: 0 })) === JSON.stringify({ searches: 0, limitedBy: 'floor' }))
ok('몫 — 시간당 남은 수', ps(12, 40, A({ hourLeft: 2, allowed: 2 })) === JSON.stringify({ searches: 2, limitedBy: 'hour' }))
ok('몫 — 계정이 막으면(allowed 0) · 계정을 모르면 0', ps(12, 40, A({ allowed: 0 })) === JSON.stringify({ searches: 0, limitedBy: 'account' }) && ps(12, 40, null) === JSON.stringify({ searches: 0, limitedBy: 'account' }))
ok('몫 — 대상이 없으면 0 · 음수 없음', ps(0, 40, A()) === JSON.stringify({ searches: 0, limitedBy: null }) && planSearches(5, 40, A({ featureLeft: -3, allowed: -3 })).searches === 0)
ok(
  '까닭 문구 — 모든 까닭에 화면 문구, 모르는 까닭은 「알 수 없는 까닭」',
  ['similar-many', 'other-url', 'corrected', 'naver-form', 'timeout', 'upstream', 'parse', 'interrupted', 'platform', 'query', 'form'].every((r) => autoReasonText(r).length > 8 && !autoReasonText(r).includes('알 수 없는')) &&
    autoReasonText('future-reason').includes('알 수 없는') && autoReasonText(undefined).includes('알 수 없는'),
)

// ══ B. writeIndexCheck(CAS) · 옛 판 파서 ══════════════════════════════════════
const today = todayKst()
const D = (n: number) => addDays(today, -n)
const unitDir = mkdtempSync(path.join(tmpdir(), 'verify-index-auto-unit-'))
const dir = mkdtempSync(path.join(tmpdir(), 'verify-index-auto-'))
const oldDir = mkdtempSync(path.join(tmpdir(), 'verify-index-auto-old-'))
process.env.APP_DATA_DIR = unitDir
process.env.DOTENV_CONFIG_PATH = path.join(unitDir, 'no-such.env')
process.env.SERPAPI_API_KEY = FAKE_KEY
process.env.SERPAPI_BASE_URL = MOCK_BASE

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
const ledgerFile = (posts: unknown[]) => JSON.stringify({ version: 1, keyRule: 3, posts }, null, 2)
const writeData = (root: string, tenantId: string, file: string, text: string) => {
  const d = path.join(root, 'data', tenantId)
  mkdirSync(d, { recursive: true })
  writeFileSync(path.join(d, file), text)
}
const readData = (root: string, tenantId: string, file: string) => {
  const p = path.join(root, 'data', tenantId, file)
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

// 옛 판 파서 — 한 파일만 꺼내면 상대 import가 깨지므로 그 판에서 publishStatus.ts가 끌어오는 파일(상대 import를 따라간 닫힘)을 임시 폴더에 꺼낸다.
type Parser = (raw: unknown) => { ok: boolean }
const oldParsers: [string, Parser][] = []
for (const tag of ['v0.4.63', 'v0.4.64']) {
  const known = new Set(execSync(`git ls-tree -r --name-only ${tag} -- src`, { encoding: 'utf8' }).trim().split(/\r?\n/))
  const queue = ['src/lib/publishStatus.ts']
  const done = new Set<string>()
  while (queue.length > 0) {
    const f = queue.pop()!
    if (done.has(f)) continue
    done.add(f)
    const text = execSync(`git show ${tag}:${f}`, { maxBuffer: 32 * 1024 * 1024 })
    const out = path.join(oldDir, tag, f)
    mkdirSync(path.dirname(out), { recursive: true })
    writeFileSync(out, text)
    if (!/\.tsx?$/.test(f)) continue
    for (const m of text.toString('utf8').matchAll(/(?:from|import)\s+'(\.{1,2}\/[^']+)'/g)) {
      const spec = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]!))
      const next = [spec.replace(/\.js$/, '.ts'), spec.replace(/\.js$/, '.tsx'), spec, `${spec}.ts`].find((c) => known.has(c))
      if (next) queue.push(next)
    }
  }
  const mod = (await import(pathToFileURL(path.join(oldDir, tag, 'src', 'lib', 'publishStatus.ts')).href)) as { parseIndexChecksFile: Parser }
  oldParsers.push([tag, mod.parseIndexChecksFile])
}
ok('옛 판 파서를 꺼냈다(v0.4.63 · v0.4.64)', oldParsers.length === 2 && oldParsers.every(([, p]) => typeof p === 'function'))
const oldRead = (text: string) => oldParsers.every(([, parse]) => parse(JSON.parse(text)).ok)

const UNIT_URL = 'https://unit.tistory.com/1'
writeData(unitDir, 'vu-a', 'published-posts.json', ledgerFile([post('p-vu-a1', UNIT_URL, D(14), '가상 단위 글')]))
writeData(unitDir, 'vu-b', 'published-posts.json', ledgerFile([post('p-vu-b1', UNIT_URL, D(14), '가상 단위 글')]))
writeData(unitDir, 'vu-a', 'index-checks.json', JSON.stringify({ format: 'index-checks/1', checks: { 'p-vu-a1': { postId: 'p-vu-a1', key: tk(UNIT_URL), url: UNIT_URL, naver: g('shown', D(2)), updatedAt: `${D(2)}T03:00:00.000Z` } } }))
const ic = await import('../server/indexChecks')
type Written = { record?: { google?: IndexCheck & Record<string, unknown>; naver?: IndexCheck } ; skipped?: string }
const autoWrite = (tenantId: string, postId: string, state: 'shown' | 'not-yet', others: string[], expect: string | null, now = Date.now()) =>
  ic.writeIndexCheck(tenantId, postId, 'google', state, others, now, 'auto', { expectRawCheckedAt: expect }) as Promise<Written>
const u1 = await autoWrite('vu-a', 'p-vu-a1', 'not-yet', ['vu-b'], null)
const u1g = u1.record?.google
ok(
  'writeIndexCheck — 자동 「아직」: source auto · 칸은 state · checkedOn · checkedAt · source만 · 네이버 칸 그대로',
  u1g?.source === 'auto' && u1g.state === 'not-yet' && u1g.checkedOn === today && JSON.stringify(Object.keys(u1g).sort()) === JSON.stringify(['checkedAt', 'checkedOn', 'source', 'state']) && u1.record?.naver?.state === 'shown',
  u1,
)
ok('writeIndexCheck — 옛 판(v0.4.63 · v0.4.64) 파서가 자동이 쓴 파일을 읽는다', oldRead(readData(unitDir, 'vu-a', 'index-checks.json')))
const bytesA = readData(unitDir, 'vu-a', 'index-checks.json')
const u2 = await autoWrite('vu-a', 'p-vu-a1', 'shown', ['vu-b'], null)
ok('CAS — 계획 때 본 값과 원본 기록이 다르면 쓰지 않는다(changed) · 파일 그대로', u2.skipped === 'changed' && readData(unitDir, 'vu-a', 'index-checks.json') === bytesA, u2)
const human = await ic.setIndexCheck('vu-b', 'p-vu-b1', { engine: 'google', state: 'not-yet' }, ['vu-a'], Date.now() + 1000)
ok('사람 표시(PUT 길) — 그대로 manual로 적는다', human.record.google?.source === 'manual' && human.record.google.state === 'not-yet')
const u3 = await autoWrite('vu-a', 'p-vu-a1', 'shown', ['vu-b'], u1g?.checkedAt ?? null)
ok('CAS — 다른 브랜드 줄에서 사람이 사이에 눌렀으면(원본 최신 기록이 바뀜) 덮지 않는다', u3.skipped === 'changed' && readData(unitDir, 'vu-a', 'index-checks.json') === bytesA, u3)
const u4 = await autoWrite('vu-a', 'p-vu-a1', 'shown', ['vu-b'], human.record.google?.checkedAt ?? null, Date.now() + 2000)
ok('CAS — 같으면 적는다(자동 「색인됨」)', u4.record?.google?.state === 'shown' && u4.record.google.source === 'auto', u4)
const bytesA2 = readData(unitDir, 'vu-a', 'index-checks.json')
const u5 = await autoWrite('vu-a', 'p-vu-a1', 'not-yet', ['vu-b'], u4.record?.google?.checkedAt ?? null, Date.now() + 3000)
const u6 = await autoWrite('vu-a', 'p-vu-a1', 'shown', ['vu-b'], u4.record?.google?.checkedAt ?? null, Date.now() + 3000)
ok('이 줄에 「색인됨」이 보이면 자동은 건드리지 않는다(R1 — already-shown, 「아직」 · 「색인됨」 모두)', u5.skipped === 'already-shown' && u6.skipped === 'already-shown' && readData(unitDir, 'vu-a', 'index-checks.json') === bytesA2, { u5, u6 })
const callAny = ic.writeIndexCheck as unknown as (...a: unknown[]) => Promise<unknown>
const noGuard = await callAny('vu-a', 'p-vu-a1', 'google', 'not-yet', [], Date.now(), 'auto').then(() => 'written', (e: { status?: number }) => e.status)
const autoClear = await callAny('vu-a', 'p-vu-a1', 'google', null, [], Date.now(), 'auto', { expectRawCheckedAt: null }).then(() => 'written', (e: { status?: number }) => e.status)
ok('자동 쓰기 — 조건(guard) 없이 · 지우기(null)로는 적지 않는다', noGuard === 400 && autoClear === 400 && readData(unitDir, 'vu-a', 'index-checks.json') === bytesA2, { noGuard, autoClear })
// 다시 올린 글(R4) — 다른 브랜드 줄의 「색인됨」(이 줄 올린 날보다 앞서 신선도로 가려짐)이 원본 최신 기록이다. 자동 「아직」은 쓰지 않고, 찾음은 적는다.
const RE_URL = 'https://unit-re.tistory.com/3'
writeData(unitDir, 'vu-c', 'published-posts.json', ledgerFile([post('p-vu-c1', RE_URL, D(5), '가상 다시 올린 글')]))
writeData(unitDir, 'vu-d', 'index-checks.json', JSON.stringify({ format: 'index-checks/1', checks: { 'p-vu-d0': { postId: 'p-vu-d0', key: tk(RE_URL), url: RE_URL, google: g('shown', D(20)), updatedAt: `${D(20)}T03:00:00.000Z` } } }))
const reExpect = `${D(20)}T03:00:00.000Z`
const reNotYet = await autoWrite('vu-c', 'p-vu-c1', 'not-yet', ['vu-d'], reExpect)
const reNotYetFile = readData(unitDir, 'vu-c', 'index-checks.json')
const reShown = await autoWrite('vu-c', 'p-vu-c1', 'shown', ['vu-d'], reExpect)
ok(
  '다시 올린 글(R4) — 원본 「색인됨」이 신선도로 가려진 줄: 자동 「아직」은 already-shown(파일 없음), 찾음은 「색인됨 · 자동」으로 적는다',
  reNotYet.skipped === 'already-shown' && reNotYetFile === '' && reShown.record?.google?.state === 'shown' && reShown.record.google.source === 'auto' && reShown.record.google.checkedOn === today,
  { reNotYet, reShown },
)
const gone = await autoWrite('vu-a', 'p-nope', 'not-yet', [], null).then(() => 0, (e: { status?: number }) => e.status ?? -1)
ok('자동 쓰기 — 없는 줄은 404(실행기는 row-gone으로 넘긴다)', gone === 404, gone)

// ══ C. 서버 ═══════════════════════════════════════════════════════════════════
const portFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
  })

// ── 가짜 SerpAPI ──
const account = (over: Record<string, unknown> = {}) => ({
  account_id: 'acct-fake-0002',
  api_key: FAKE_KEY,
  account_email: 'fake-owner@example.test',
  account_status: 'Active',
  plan_name: 'Starter',
  searches_per_month: 1000,
  plan_searches_left: 990,
  extra_credits: 0,
  total_searches_left: 990,
  this_month_usage: 10,
  this_hour_searches: 0,
  account_rate_limit_per_hour: 200,
  plan_renewal_date: '2026-12-08',
  ...over,
})
interface Seen {
  path: string
  q: string
  first: string
  keyOk: boolean
  params: Record<string, string>
  at: number
}
const seen: Seen[] = []
let accountBody: Record<string, unknown> = account()
let accountMode: 'ok' | 'fail' = 'ok'
let stopMode = '401'
let hangMode = true
/** 이 수만큼 검색을 받으면 계정 남은 수를 바닥(500)으로 낮춘다(바닥 시험). */
let floorAfter = Infinity
const searches = () => seen.filter((s) => s.path === '/search.json')
const EMPTY = { search_metadata: { status: 'Success' }, error: GOOGLE_NO_RESULTS }
const found = (first: string) => res([`https://${first}`])

const mock = http.createServer((req, res2) => {
  const url = new URL(req.url ?? '/', MOCK_BASE)
  const p = url.searchParams
  const qText = p.get('q') ?? ''
  const s: Seen = { path: url.pathname, q: qText, first: /^site:(\S+)/.exec(qText)?.[1] ?? '', keyOk: p.get('api_key') === FAKE_KEY, params: Object.fromEntries(p.entries()), at: Date.now() }
  seen.push(s)
  const send = (status: number, body: unknown) => {
    res2.writeHead(status, { 'Content-Type': 'application/json' })
    res2.end(JSON.stringify(body))
  }
  const later = (ms: number, status: number, body: unknown) => {
    const t = setTimeout(() => send(status, body), ms)
    res2.on('close', () => clearTimeout(t))
  }
  if (url.pathname === '/account.json') {
    if (accountMode === 'fail') return send(500, { error: 'account down' })
    return send(200, accountBody)
  }
  if (url.pathname !== '/search.json') return send(404, { error: 'not found' })
  if (searches().length >= floorAfter) accountBody = account({ total_searches_left: 500 })
  switch (s.first) {
    case 'found.tistory.com/2':
      return send(200, res(['https://found.tistory.com/m/2', 'https://found.tistory.com/21']))
    case 'none.tistory.com/3':
      return send(200, res(['https://none.tistory.com/30', 'https://none.tistory.com/31']))
    case 'many.tistory.com/1':
      return send(200, res(Array.from({ length: 10 }, (_, i) => `https://many.tistory.com/1${i}`)))
    case 'wp-other.example/post-a':
      return send(200, res(['https://wp-other.example/post-a?amp=1']))
    case 'corr.example/p1':
      return send(200, res(['https://corr.example/p1'], { search_information: { organic_results_state: 'Showing results for corr.example/p1x' } }))
    case 'parse.example/p1':
      return send(200, { search_metadata: { status: 'Success' } })
    case 'blog.naver.com/fakeid/224000000009':
    case 'empty.tistory.com/5':
    case 'mix.tistory.com/4':
    case 'else.tistory.com/8':
      return send(200, EMPTY)
    case 'blog.naver.com/fakeid/224000000010':
      return send(200, res(['https://m.blog.naver.com/fakeid/224000000010']))
    case 'serr.example/p':
      return send(200, { search_metadata: { status: 'Error' }, error: `Something went wrong for ${FAKE_KEY}.` })
    case 'slow.example/p':
      return later(5000, 200, res([]))
    case 'cas.tistory.com/7':
      return later(1500, 200, found(s.first))
    case 'conc.tistory.com/1':
    case 'twoproc.tistory.com/1':
    case 'twoproc.tistory.com/2':
      return later(1500, 200, found(s.first))
    case 'hang.tistory.com/1':
      return hangMode ? undefined : send(200, found(s.first))
    case 'wbreak.tistory.com/1':
    case 'rgone.tistory.com/1':
      return later(1500, 200, found(s.first))
    case 'stop.tistory.com/1':
      if (stopMode === '401') return send(401, { error: 'Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key' })
      if (stopMode === '403') return send(403, { error: 'This account is not allowed to use this API.' })
      if (stopMode === '429m') return send(429, { error: 'Your account has run out of searches.' })
      if (stopMode === '429m2') return send(429, { error: 'your account has RUN OUT OF SEARCHES' })
      if (stopMode === '429h') return send(429, { error: 'Your account has exceeded the hourly throughput limit.' })
      return send(200, found(s.first))
    default:
      if (s.first.startsWith('streak')) return send(200, { search_metadata: { status: 'Error' }, error: 'Something went wrong.' })
      return send(200, found(s.first))
  }
})

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

for (const port of [MOCK_PORT, APP_PORT, APP2_PORT]) {
  if (!(await portFree(port))) {
    console.error(`포트 ${port}을 다른 프로그램이 쓰고 있어 확인하지 못했습니다.`)
    for (const d of [dir, unitDir, oldDir]) rmSync(d, { recursive: true, force: true })
    process.exit(1)
  }
}
await new Promise<void>((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve))

// ── 가짜 데이터 ──
const tenant = (tenantId: string, brandName: string, over: Record<string, unknown> = {}) => ({
  tenantId,
  brandName,
  aliases: [brandName],
  ownedDomains: [`${tenantId}.example`],
  industry: '숙박',
  region: '가상시',
  engines: ['gemini'],
  questionBankSize: 4,
  questionBankVersion: 'v1',
  repeatsPerQuestion: 1,
  factGraph: [],
  competitors: [],
  ...over,
})
writeFileSync(
  path.join(dir, 'tenants.overlay.json'),
  JSON.stringify([tenant('vauto-a', '가상하나'), tenant('vauto-b', '가상둘'), tenant('vauto-c', '가상셋'), tenant('vauto-comp', '가상경쟁', { cohortOnly: true })]),
)
const URLS = {
  found: 'https://found.tistory.com/2',
  none: 'https://none.tistory.com/3',
  many: 'https://many.tistory.com/1',
  other: 'https://wp-other.example/post-a',
  corr: 'https://corr.example/p1',
  parse: 'https://parse.example/p1',
  naverNf: 'https://blog.naver.com/fakeid/224000000009',
  naverFound: 'https://blog.naver.com/PostView.naver?blogId=fakeid&logNo=224000000010',
  empty: 'https://empty.tistory.com/5',
  serr: 'https://serr.example/p',
  slow: 'https://slow.example/p',
  day3: 'https://day3.tistory.com/1',
  day7: 'https://day7.tistory.com/1',
  yt: 'https://www.youtube.com/watch?v=fakeVid123',
  query: 'https://board.example/view?idx=5',
  done: 'https://done.tistory.com/1',
  cas: 'https://cas.tistory.com/7',
  shared: 'https://shared.tistory.com/9',
  mix: 'https://mix.tistory.com/4',
  elsewhere: 'https://else.tistory.com/8',
  late: 'https://late.tistory.com/6',
  lateManual: 'https://late2.tistory.com/6',
  comp: 'https://comp.tistory.com/1',
}
const ledgerA = [
  post('p-va01', URLS.found, D(14), '가상 찾는 글'),
  post('p-va02', URLS.none, D(14), '가상 못 찾는 글'),
  post('p-va03', URLS.many, D(20), '가상 비슷한 주소 글'),
  post('p-va04', URLS.other, D(14), '가상 변형 주소 글'),
  post('p-va05', URLS.corr, D(14), '가상 교정 글'),
  post('p-va06', URLS.parse, D(14), '가상 모양 이상 글'),
  post('p-va07', URLS.naverNf, D(14), '가상 네이버 글'),
  post('p-va08', URLS.naverFound, D(14), '가상 네이버 찾는 글'),
  post('p-va09', URLS.empty, D(14), '가상 빈 결과 글'),
  post('p-va10', URLS.serr, D(14), '가상 오류 글'),
  post('p-va11', URLS.slow, D(14), '가상 느린 글'),
  post('p-va12', URLS.day3, D(3), '가상 3일째 글'),
  post('p-va13', URLS.day7, D(8), '가상 7일째 글'),
  post('p-va14', URLS.yt, D(14), '가상 영상'),
  post('p-va15', URLS.query, D(14), '가상 게시판 글'),
  post('p-va16', URLS.done, D(14), '가상 색인된 글'),
  post('p-va17', URLS.cas, D(14), '가상 사이에 누른 글'),
  post('p-va18', URLS.shared, D(14), '가상 같은 주소 글'),
  post('p-va20', URLS.elsewhere, D(14), '가상 다른 줄 색인 글'),
  post('p-va21', URLS.late, D(31), '가상 30일째 글'),
  post('p-va22', URLS.lateManual, D(31), '가상 30일째 사람 글'),
]
const rec = (postId: string, url: string, over: Record<string, unknown>) => ({ postId, key: tk(url), url, updatedAt: `${D(30)}T03:00:00.000Z`, ...over })
const checksA = {
  format: 'index-checks/1',
  checks: {
    'p-va01': rec('p-va01', URLS.found, { naver: g('shown', D(5)), updatedAt: `${D(5)}T03:00:00.000Z` }),
    'p-va16': rec('p-va16', URLS.done, { google: g('shown', D(1)), updatedAt: `${D(1)}T03:00:00.000Z` }),
    'p-va21': rec('p-va21', URLS.late, { google: g('not-yet', D(17), 'auto'), updatedAt: `${D(17)}T03:00:00.000Z` }),
    'p-va22': rec('p-va22', URLS.lateManual, { google: g('not-yet', D(17)), updatedAt: `${D(17)}T03:00:00.000Z` }),
  },
}
const xRow = (id: string, url: string, trackedOn: string) => ({ id, url, key: tk(url), title: '가상 손글', publishedOn: null, publishedOnSource: 'unknown', trackedAt: `${trackedOn}T01:00:00.000Z` })
writeData(dir, 'vauto-a', 'published-posts.json', ledgerFile(ledgerA))
writeData(dir, 'vauto-a', 'index-checks.json', JSON.stringify(checksA, null, 2))
writeData(dir, 'vauto-a', 'action-states.json', JSON.stringify({ 'content:category-agnostic': { state: 'done', updatedAt: `${D(14)}T03:00:00.000Z`, publishedUrls: [] } }, null, 2))
writeData(dir, 'vauto-a', 'scorecard-2026-W45.json', '{"fake":"scorecard"}')
writeData(dir, 'vauto-b', 'published-posts.json', ledgerFile([post('p-vb18', URLS.shared, D(14), '가상 같은 주소 글')]))
writeData(dir, 'vauto-b', 'external-posts.json', JSON.stringify({ version: 1, keyRule: 3, posts: [xRow('x-bbbbbbbb0019', URLS.mix, D(20)), xRow('x-bbbbbbbb0020', URLS.elsewhere, D(30))] }, null, 2))
writeData(dir, 'vauto-b', 'index-checks.json', JSON.stringify({ format: 'index-checks/1', checks: { 'x-bbbbbbbb0020': rec('x-bbbbbbbb0020', URLS.elsewhere, { google: g('shown', D(20)), updatedAt: `${D(20)}T03:00:00.000Z` }) } }, null, 2))
writeData(dir, 'vauto-c', 'published-posts.json', ledgerFile([post('p-vc19', URLS.mix, D(14), '가상 섞인 글')]))
writeData(dir, 'vauto-comp', 'published-posts.json', ledgerFile([post('p-vcomp', URLS.comp, D(14), '가상 경쟁사 글')]))

const INDEX_AUTO = path.join(dir, 'index-auto.json')
const LEDGER = path.join(dir, 'serpapi-usage.json')
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T
/** data/ 아래 파일 바이트(브랜드 index-checks.json은 따로 본다). */
const snapshotData = (skipChecks: boolean) => {
  const out = new Map<string, string>()
  const root = path.join(dir, 'data')
  for (const t of readdirSync(root)) {
    for (const f of readdirSync(path.join(root, t))) {
      const p = path.join(root, t, f)
      if (statSync(p).isFile() && !(skipChecks && f === 'index-checks.json')) out.set(`${t}/${f}`, readFileSync(p, 'utf8'))
    }
  }
  return out
}
const sameSnapshot = (a: Map<string, string>, b: Map<string, string>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v)

// ── 앱 서버 ──
let logs = ''
const children: ChildProcess[] = []
const start = async (over: Record<string, string> = {}, port = APP_PORT): Promise<ChildProcess> => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APP_DATA_DIR: dir,
    PORT: String(port),
    USE_MOCK_ENGINES: 'true',
    DOTENV_CONFIG_PATH: path.join(dir, 'no-such.env'),
    BLOB_READ_WRITE_TOKEN: '',
    BLOB_STORE_ID: '',
    PIPELINE_CRON: '',
    GH_MEASURE_TOKEN: '',
    ANTHROPIC_API_KEY: '',
    SERPAPI_API_KEY: FAKE_KEY,
    SERPAPI_BASE_URL: MOCK_BASE,
    SERPAPI_TIMEOUT_MS: '3000',
    ...over,
  }
  delete env.AEO_SERVER_HOST
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(env.SERPAPI_BASE_URL ?? '') && env.SERPAPI_BASE_URL !== 'http://localhost:4195') throw new Error('가짜 SerpAPI 주소가 아니라 서버를 띄우지 않습니다.')
  const srv = spawn(process.execPath, ['--import', GUARD, '--import', 'tsx', 'server/index.ts'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(srv)
  srv.stdout?.on('data', (d: Buffer) => (logs += d.toString()))
  srv.stderr?.on('data', (d: Buffer) => (logs += d.toString()))
  for (let i = 0; i < 120; i += 1) {
    if (await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok, () => false)) return srv
    await sleep(500)
  }
  throw new Error(`앱 서버가 뜨지 않았습니다:\n${logs.slice(-2000)}`)
}
const stop = async (srv: ChildProcess, port = APP_PORT) => {
  const exited = new Promise<void>((resolve) => (srv.exitCode !== null || srv.signalCode !== null ? resolve() : srv.once('exit', () => resolve())))
  srv.kill()
  await exited
  for (let i = 0; i < 20 && !(await portFree(port)); i += 1) await sleep(250)
}
const bodies: string[] = []
const call = async <T = Record<string, unknown>>(method: string, p: string, body?: unknown, raw?: { text: string; type?: string }) => {
  const headers: Record<string, string> = {}
  let payload: string | undefined
  if (raw) {
    payload = raw.text
    if (raw.type) headers['Content-Type'] = raw.type
  } else if (body !== undefined) {
    payload = JSON.stringify(body)
    headers['Content-Type'] = 'application/json'
  }
  const r = await fetch(`${APP_BASE}${p}`, { method, headers, body: payload })
  const text = await r.text()
  bodies.push(text)
  return { status: r.status, body: (text.startsWith('{') ? JSON.parse(text) : {}) as T & { error?: string } }
}
/** Host · Origin을 마음대로 붙이는 요청(fetch는 Host를 못 바꾼다) — 127.0.0.1의 앱 서버로만 간다. */
const rawCall = (method: string, p: string, headers: Record<string, string>, body?: unknown, port = APP_PORT) =>
  new Promise<{ status: number; text: string }>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const rq = http.request(
      { host: '127.0.0.1', port, path: p, method, headers: { ...headers, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {}) } },
      (rs) => {
        let text = ''
        rs.on('data', (d: Buffer) => (text += d.toString()))
        rs.on('end', () => resolve({ status: rs.statusCode ?? 0, text }))
      },
    )
    rq.on('error', reject)
    if (payload) rq.write(payload)
    rq.end()
  })
const status = () => call<IndexAutoStatusView>('GET', '/api/index-auto')
const makePlan = (trigger: 'button' | 'open' = 'button') => call<IndexAutoPlanView>('POST', '/api/index-auto/plan', { trigger })
const runPlan = (planId: string | null) => call<{ runId: string; total: number }>('POST', '/api/index-auto/run', { planId })
/** 둘째 서버(APP2_PORT)로 — JSON 본문만. */
const callOn = async <T = Record<string, unknown>>(port: number, method: string, p: string, body?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await r.text()
  bodies.push(text)
  return { status: r.status, body: (text.startsWith('{') ? JSON.parse(text) : {}) as T & { error?: string; code?: string } }
}
const waitRunOn = async (port: number): Promise<IndexAutoRunRecord | null> => {
  for (let i = 0; i < 400; i += 1) {
    const s = await callOn<IndexAutoStatusView>(port, 'GET', '/api/index-auto')
    if (s.status === 200 && s.body.running === null) return s.body.lastRun
    await sleep(250)
  }
  return null
}
const waitRun = async (): Promise<IndexAutoRunRecord | null> => {
  for (let i = 0; i < 400; i += 1) {
    const s = await status()
    if (s.status === 200 && s.body.running === null) return s.body.lastRun
    await sleep(250)
  }
  return null
}
const publishStatus = async () => (await call<PublishStatus>('GET', '/api/publish-status')).body
const googleOf = (ps: PublishStatus, tenantId: string, postId: string) => ps.rows.find((r) => r.tenantId === tenantId && r.postId === postId)?.google ?? null
interface AttemptFile {
  id: string
  key: string
  turn: string
  outcome: string
  reason?: string
  runId?: string
  query?: string
  matched?: string
  wrote?: string
  skipped?: string
  [k: string]: unknown
}
const attemptsFile = () => (existsSync(INDEX_AUTO) ? readJson<{ attempts: AttemptFile[]; runs: IndexAutoRunRecord[]; settings: unknown; format: string; openRunOn: unknown }>(INDEX_AUTO) : { attempts: [], runs: [], settings: null, format: '(없음)', openRunOn: null })
const sentInLedger = () => (existsSync(LEDGER) ? (readJson<{ cycles: Record<string, { index?: { sent: number } }> }>(LEDGER).cycles['2026-12-08']?.index?.sent ?? 0) : 0)

let app = await start()
try {
  // ── C1. 상태 · 요청 모양(검색 0) ──
  const s0 = await status()
  ok(
    '서버 — GET /api/index-auto: 키 있음 · 기본 설정(한 번 40편 · 열 때 자동 끔) · 도는 것 없음',
    s0.status === 200 && s0.body.configured === true && s0.body.configError === null && sorted(s0.body.settings as unknown as Record<string, unknown>) === sorted({ runCap: 40, autoOnOpen: false }) && s0.body.running === null && s0.body.lastRun === null,
    s0,
  )
  const textPlan = await call('POST', '/api/index-auto/plan', undefined, { text: '{"trigger":"button"}', type: 'text/plain' })
  const noBodyPlan = await call('POST', '/api/index-auto/plan')
  const emptyPlan = await call('POST', '/api/index-auto/plan', {})
  const extraPlan = await call('POST', '/api/index-auto/plan', { trigger: 'button', dryRun: true })
  const badTrigger = await call('POST', '/api/index-auto/plan', { trigger: 'cron' })
  ok('계획 — JSON이 아니면 415 · trigger 없음 · 모르는 칸 · 모르는 trigger는 400', textPlan.status === 415 && noBodyPlan.status === 415 && emptyPlan.status === 400 && extraPlan.status === 400 && badTrigger.status === 400, [textPlan.status, noBodyPlan.status, emptyPlan.status, extraPlan.status, badTrigger.status])
  const textRun = await call('POST', '/api/index-auto/run', undefined, { text: '{"planId":"x"}', type: 'text/plain' })
  const formRun = await call('POST', '/api/index-auto/run', undefined, { text: 'planId=x', type: 'application/x-www-form-urlencoded' })
  const noIdRun = await call('POST', '/api/index-auto/run', {})
  const extraRun = await call('POST', '/api/index-auto/run', { planId: 'x', trigger: 'button' })
  const unknownRun = await runPlan('plan-that-does-not-exist')
  ok(
    '실행 — 다른 사이트의 단순 요청(text/plain · form)은 415, planId 없음 · 모르는 칸 400, 모르는 planId 409',
    textRun.status === 415 && formRun.status === 415 && noIdRun.status === 400 && extraRun.status === 400 && unknownRun.status === 409 && /계획/.test(unknownRun.body.error ?? '') &&
      (unknownRun.body as { code?: string }).code === 'plan-changed',
    [textRun.status, formRun.status, noIdRun.status, extraRun.status, unknownRun.status, unknownRun.body],
  )
  ok('요청 모양 시험 — 가짜 서버가 받은 검색 0', searches().length === 0)

  // DNS 리바인딩 — 브라우저가 보기엔 같은 출처라 CORS가 막지 못한다. Host · Origin이 이 PC가 아니면 계획 · 실행 · 설정 모두 403(계정 · 검색 0).
  const evil = { Host: `rebind.attacker.example:${APP_PORT}`, Origin: `http://rebind.attacker.example:${APP_PORT}` }
  const accountBeforeEvil = seen.filter((s) => s.path === '/account.json').length
  const evilCalls = [
    await rawCall('POST', '/api/index-auto/plan', evil, { trigger: 'button' }),
    await rawCall('POST', '/api/index-auto/run', evil, { planId: 'x' }),
    await rawCall('PUT', '/api/index-auto/settings', evil, { autoOnOpen: true }),
    await rawCall('GET', '/api/index-auto', evil),
    await rawCall('POST', '/api/index-auto/plan', { Host: `127.0.0.1:${APP_PORT}`, Origin: 'http://evil.example' }, { trigger: 'button' }),
  ]
  const afterEvil = await status()
  ok(
    'DNS 리바인딩 — Host · Origin이 이 PC가 아니면 계획 · 실행 · 설정 · 상태 모두 403, 계정 · 검색 0, 설정 그대로',
    evilCalls.every((r) => r.status === 403) && seen.filter((s) => s.path === '/account.json').length === accountBeforeEvil && searches().length === 0 && afterEvil.body.settings.autoOnOpen === false,
    evilCalls.map((r) => r.status),
  )
  const localOk = await rawCall('GET', '/api/index-auto', { Host: `localhost:${APP_PORT}`, Origin: `http://localhost:${APP_PORT}` })
  ok('Host · Origin이 이 PC(localhost)면 그대로 받는다', localOk.status === 200, localOk.status)

  // ── C2. 계획 — 검색 0 ──
  const p1 = await makePlan()
  const p1Keys = p1.body.targets?.map((t) => t.key) ?? []
  const expected1 = [
    tk(URLS.many),
    tk(URLS.naverNf),
    tk(URLS.naverFound),
    tk(URLS.cas),
    tk(URLS.corr),
    tk(URLS.elsewhere),
    tk(URLS.empty),
    tk(URLS.found),
    tk(URLS.mix),
    tk(URLS.none),
    tk(URLS.parse),
    tk(URLS.serr),
    tk(URLS.shared),
    tk(URLS.slow),
    tk(URLS.other),
    tk(URLS.late),
  ]
  ok(
    '계획 — 14일째 차례 · 30일째 한 번 더 · 같은 주소 1번 · 다른 줄에 「색인됨」이 있는 주소도(16편), 3 · 7일째 2편은 직접, 안 찾는 주소 2편',
    p1.status === 200 && typeof p1.body.planId === 'string' && p1.body.searches === 16 && p1.body.candidates === 16 && JSON.stringify(p1Keys) === JSON.stringify(expected1) &&
      p1.body.manual === 2 && p1.body.unsupported.length === 2 && !('shownElsewhere' in p1.body) && p1.body.settled === 0 && p1.body.limitedBy === null && p1.body.blocked === null,
    { status: p1.status, keys: p1Keys, body: { ...p1.body, targets: undefined } },
  )
  ok(
    '계획 — 이번 결제 주기 색인 몫 · 계정 남은 검색을 함께 보인다(Starter 1,000 → 색인 200 · 바닥 500)',
    p1.body.quota?.cycle === '2026-12-08' && p1.body.quota.cap === 200 && p1.body.quota.used === 0 && p1.body.quota.floor === 500 && p1.body.quota.accountLeft === 990 && p1.body.quota.planName === 'Starter',
    p1.body.quota,
  )
  ok('계획 — 같은 주소 두 브랜드는 설정 순 첫 브랜드 줄 · 앱 글 + 앱 밖 글은 앱 글 줄에 적는다', p1.body.targets.find((t) => t.key === tk(URLS.shared))?.tenantId === 'vauto-a' && p1.body.targets.find((t) => t.key === tk(URLS.mix))?.tenantId === 'vauto-c')
  ok('계획 — 응답에 계정 이메일 · 계정 id · 키가 없다', !JSON.stringify(p1.body).includes('fake-owner@example.test') && !JSON.stringify(p1.body).includes('acct-fake-0002') && !JSON.stringify(p1.body).includes(FAKE_KEY))
  ok('계획 — 가짜 서버가 받은 검색 0(계정만)', searches().length === 0 && seen.some((s) => s.path === '/account.json'))

  // ── C3. 첫 실행 ──
  const before = snapshotData(true)
  const checksBBefore = readData(dir, 'vauto-b', 'index-checks.json')
  const run1 = await runPlan(p1.body.planId)
  ok('실행 — 202 · 실행 id · 검색 16회 예정', run1.status === 202 && typeof run1.body.runId === 'string' && run1.body.total === 16, run1)
  const reused = await runPlan(p1.body.planId)
  ok('실행 — 같은 계획 id는 다시 못 쓴다(409 — 도는 중)', reused.status === 409 && (reused.body as { code?: string }).code === 'busy', reused.body)
  // 사이에 누름(CAS) — cas 글 검색이 가짜 서버에 닿은 뒤 사람이 그 칸을 「아직」으로 누른다.
  for (let i = 0; i < 200 && !searches().some((s) => s.first === 'cas.tistory.com/7'); i += 1) await sleep(50)
  const humanCas = await call('PUT', '/api/index-checks/vauto-a/p-va17', { engine: 'google', state: 'not-yet' })
  ok('CAS — 확인하는 사이 사람이 누른 표시는 받는다(200)', humanCas.status === 200, humanCas)
  const last1 = await waitRun()
  const s1 = searches()
  ok('실행 — 가짜 서버가 받은 검색은 정확히 16회(같은 주소 1번 · 안 찾는 주소 · 직접 보는 글 0)', s1.length === 16 && new Set(s1.map((s) => s.first)).size === 16, s1.map((s) => s.first))
  ok(
    '실행 — 매번 가짜 키 · engine=google · google.co.kr · gl=kr · hl=ko · nfpr=1 · filter=0(num · start · no_cache · async 없음)',
    s1.every(
      (s) =>
        s.keyOk && JSON.stringify(Object.keys(s.params).sort()) === JSON.stringify(['api_key', 'engine', 'filter', 'gl', 'google_domain', 'hl', 'nfpr', 'q']) && s.params.engine === 'google' &&
        s.params.google_domain === 'google.co.kr' && s.params.gl === 'kr' && s.params.hl === 'ko' && s.params.nfpr === '1' && s.params.filter === '0',
    ),
    s1[0],
  )
  ok(
    '실행 — 검색어(티스토리 /m/ · 네이버 두 모양 · 그 밖 하나)',
    s1.find((s) => s.first === 'found.tistory.com/2')?.q === 'site:found.tistory.com/2 OR site:found.tistory.com/m/2' &&
      s1.find((s) => s.first === 'blog.naver.com/fakeid/224000000010')?.q === 'site:blog.naver.com/fakeid/224000000010 OR site:m.blog.naver.com/fakeid/224000000010' &&
      s1.find((s) => s.first === 'wp-other.example/post-a')?.q === 'site:wp-other.example/post-a',
  )
  const items = new Map((last1?.items ?? []).map((it) => [it.key, it]))
  const it = (url: string) => items.get(tk(url))
  ok(
    '결과 — 줄마다: 찾음 4(적음) · 사이에 누른 글 1(건너뜀) · 못 찾음 3(적음) · 다른 줄 색인됨인 못 찾음 1(건너뜀) · 못 가림 7',
    last1?.endedAt !== null && last1?.searched === 16 && last1.found === 5 && last1.notFound === 4 && last1.unknown === 7 && last1.skipped === 2 && last1.notRun === 0 && last1.stoppedBy === null,
    { ...last1, items: undefined },
  )
  ok(
    '결과 — 적은 것: 찾음 → shown, 못 찾음 → not-yet, 사이에 누름 → changed',
    it(URLS.found)?.wrote === 'shown' && it(URLS.naverFound)?.wrote === 'shown' && it(URLS.shared)?.wrote === 'shown' && it(URLS.late)?.wrote === 'shown' &&
      it(URLS.none)?.wrote === 'not-yet' && it(URLS.empty)?.wrote === 'not-yet' && it(URLS.mix)?.wrote === 'not-yet' && it(URLS.cas)?.skipped === 'changed' &&
      it(URLS.elsewhere)?.outcome === 'not-found' && it(URLS.elsewhere)?.skipped === 'already-shown' && it(URLS.elsewhere)?.wrote === undefined,
    [...items.values()],
  )
  ok(
    '결과 — 못 가림 까닭(similar-many · other-url · corrected · parse · naver-form · upstream · timeout)',
    it(URLS.many)?.reason === 'similar-many' && it(URLS.other)?.reason === 'other-url' && it(URLS.other)?.matched === 'https://wp-other.example/post-a?amp=1' && it(URLS.corr)?.reason === 'corrected' &&
      it(URLS.parse)?.reason === 'parse' && it(URLS.naverNf)?.reason === 'naver-form' && it(URLS.serr)?.reason === 'upstream' && it(URLS.slow)?.reason === 'timeout' &&
      [URLS.many, URLS.other, URLS.corr, URLS.parse, URLS.naverNf, URLS.serr, URLS.slow].every((u) => it(u)?.wrote === undefined),
    [...items.values()],
  )
  const ck = readJson<{ checks: Record<string, { google?: IndexCheck & Record<string, unknown>; naver?: IndexCheck }> }>(path.join(dir, 'data', 'vauto-a', 'index-checks.json')).checks
  const autoCells = ['p-va01', 'p-va02', 'p-va08', 'p-va09', 'p-va18', 'p-va21'].map((id) => ck[id]?.google)
  ok(
    'index-checks.json — 자동 칸은 source auto · 오늘 · state · checkedOn · checkedAt · source만',
    autoCells.every((c) => c?.source === 'auto' && c.checkedOn === today && JSON.stringify(Object.keys(c).sort()) === JSON.stringify(['checkedAt', 'checkedOn', 'source', 'state'])) &&
      ck['p-va01']?.google?.state === 'shown' && ck['p-va02']?.google?.state === 'not-yet' && ck['p-va21']?.google?.state === 'shown',
    autoCells,
  )
  ok(
    'index-checks.json — 사람 표시 · 네이버 칸은 그대로(사이에 누른 칸 · 색인된 칸 · 30일째 사람 「아직」 · 네이버 노출)',
    ck['p-va17']?.google?.source === 'manual' && ck['p-va17'].google.state === 'not-yet' && ck['p-va16']?.google?.source === 'manual' && ck['p-va16'].google.state === 'shown' &&
      ck['p-va22']?.google?.source === 'manual' && ck['p-va01']?.naver?.state === 'shown' && ck['p-va01'].naver.source === 'manual',
  )
  ok(
    'index-checks.json — 못 가린 글 · 안 찾는 주소 · 직접 보는 글에는 아무것도 적지 않는다',
    ['p-va03', 'p-va04', 'p-va05', 'p-va06', 'p-va07', 'p-va10', 'p-va11', 'p-va12', 'p-va13', 'p-va14', 'p-va15', 'p-va20'].every((id) => ck[id] === undefined),
  )
  ok(
    'index-checks.json — 옛 판(v0.4.63 · v0.4.64) 파서가 자동이 쓴 파일을 모두 읽는다',
    ['vauto-a', 'vauto-b', 'vauto-c'].every((t) => oldRead(readData(dir, t, 'index-checks.json') || '{"format":"index-checks/1","checks":{}}')),
  )
  ok('격리 — 원장 · 집행 상태 · 앱 밖 글 · 그 밖 data 파일은 바이트 단위로 같다', sameSnapshot(before, snapshotData(true)))
  ok('격리 — 대표 줄이 아닌 브랜드(vauto-b)의 index-checks.json도 같다', readData(dir, 'vauto-b', 'index-checks.json') === checksBBefore)
  const ps1 = await publishStatus()
  ok(
    '표시 — 자동 결과는 주소 키로 모든 줄에 보인다(두 브랜드 같은 주소 · 앱 밖 줄)',
    googleOf(ps1, 'vauto-b', 'p-vb18')?.state === 'shown' && googleOf(ps1, 'vauto-b', 'p-vb18')?.source === 'auto' && googleOf(ps1, 'vauto-b', 'x-bbbbbbbb0019')?.state === 'not-yet' &&
      googleOf(ps1, 'vauto-b', 'x-bbbbbbbb0019')?.source === 'auto' && googleOf(ps1, 'vauto-c', 'p-vc19')?.source === 'auto',
  )
  ok(
    '표시 — 다른 줄의 사람 「색인됨」은 그대로 보인다(못 찾은 자동 「아직」이 가리지 않는다)',
    googleOf(ps1, 'vauto-b', 'x-bbbbbbbb0020')?.state === 'shown' && googleOf(ps1, 'vauto-b', 'x-bbbbbbbb0020')?.source === 'manual' && googleOf(ps1, 'vauto-a', 'p-va20') === null,
  )
  const af1 = attemptsFile()
  ok(
    'index-auto.json — 시도 16건 · 대기 없음 · 차례 id · 검색어만(요청 주소 없음)',
    af1.format === 'index-auto/1' && af1.attempts.length === 16 && af1.attempts.every((a) => a.outcome !== 'pending' && /^d(14|30):\d{4}-\d{2}-\d{2}$/.test(a.turn) && typeof a.query === 'string' && a.query.startsWith('site:')) &&
      af1.attempts.find((a) => a.key === tk(URLS.late))?.turn === `d30:${D(1)}` && af1.attempts.find((a) => a.key === tk(URLS.found))?.turn === `d14:${today}`,
    af1.attempts,
  )
  ok('장부 — 이번 주기 색인 16회(보낸 것 모두)', sentInLedger() === 16, sentInLedger())
  const st1 = await status()
  ok(
    'GET — 주소마다 최근 자동 시도(3건까지) · 마지막 실행',
    st1.body.lastRun?.runId === run1.body.runId && st1.body.attemptsByKey[tk(URLS.many)]?.[0]?.reason === 'similar-many' && st1.body.attemptsByKey[tk(URLS.found)]?.[0]?.wrote === 'shown',
    st1.body.attemptsByKey,
  )

  // ── C4. 차례 규칙 — 같은 날 다시 ──
  const p2 = await makePlan()
  ok(
    '둘째 계획 — 일시 오류 글(parse · upstream · timeout)만 두 번째 시도, 결정적 4편 · 앞선 「색인됨」으로 건너뛴 1편은 다시 찾지 않음',
    p2.body.searches === 3 && JSON.stringify(p2.body.targets.map((t) => t.key).sort()) === JSON.stringify([tk(URLS.parse), tk(URLS.serr), tk(URLS.slow)].sort()) &&
      p2.body.targets.every((t) => t.batch === 'retry') && p2.body.settled === 5,
    { ...p2.body, quota: undefined },
  )
  const n2 = searches().length
  await runPlan(p2.body.planId)
  await waitRun()
  ok('둘째 실행 — 검색 3회', searches().length === n2 + 3)
  const p3 = await makePlan()
  ok('셋째 계획 — 차례마다 일시 2회를 다 써서 대상 0 · 계획 id 없음', p3.body.searches === 0 && p3.body.candidates === 0 && p3.body.planId === null && p3.body.settled === 8, { ...p3.body, quota: undefined })
  ok('셋째 — 검색 0', searches().length === n2 + 3)

  // ── C5. 멈춤 오류 ──
  const withLedger = (extra: unknown[]) => writeData(dir, 'vauto-a', 'published-posts.json', ledgerFile([...ledgerA, ...extra]))
  withLedger([post('p-vs01', 'https://stop.tistory.com/1', D(14), '가상 멈춤 글')])
  for (const [mode, kind, text] of [
    ['401', 'key', /401/],
    ['403', 'forbidden', /403/],
    ['429m', 'quota-month', /결제 주기/],
    ['429m2', 'quota-month', /결제 주기/],
    ['429h', 'rate-hour', /시간/],
  ] as const) {
    stopMode = mode
    const pl = await makePlan()
    const before5 = searches().length
    const checksBefore = readData(dir, 'vauto-a', 'index-checks.json')
    await runPlan(pl.body.planId)
    const lr = await waitRun()
    ok(
      `멈춤 — ${mode} → ${kind}: 바로 멈춤 · 그 글은 적지 않음 · 시도는 차례 몫에 넣지 않음`,
      pl.body.searches === 1 && searches().length === before5 + 1 && lr?.stoppedBy?.kind === kind && text.test(lr.stoppedBy.message) && readData(dir, 'vauto-a', 'index-checks.json') === checksBefore &&
        attemptsFile().attempts.at(-1)?.reason === kind,
      { plan: pl.body.searches, lr: { ...lr, items: undefined } },
    )
  }
  const pAfterStops = await makePlan()
  ok('멈춤 오류만 있던 글은 다음 계획에서 다시 첫 시도', pAfterStops.body.targets.find((t) => t.key === 'stop.tistory.com/1')?.batch === 'first')
  withLedger([post('p-vs01', 'https://stop.tistory.com/1', D(14), '가상 멈춤 글'), post('p-vs02', 'https://stop2.tistory.com/1', D(14), '가상 멈춤 뒤 글')])
  stopMode = '429h'
  const pl2 = await makePlan()
  const before6 = searches().length
  await runPlan(pl2.body.planId)
  const lr2 = await waitRun()
  ok('멈춤 — 앞 글에서 시간당 한도 429 → 뒤 글은 부르지 않음(notRun 1)', pl2.body.searches === 2 && searches().length === before6 + 1 && lr2?.notRun === 1 && lr2.stoppedBy?.kind === 'rate-hour' && !searches().slice(before6).some((s) => s.first.startsWith('stop2.')), { ...lr2, items: undefined })
  stopMode = 'ok'
  const pl3 = await makePlan()
  await runPlan(pl3.body.planId)
  const lr3 = await waitRun()
  ok('멈춤이 풀리면 두 글 모두 찾음', lr3?.found === 2 && lr3.stoppedBy === null, { ...lr3, items: undefined })
  withLedger(['1', '2', '3', '4'].map((n) => post(`p-vt0${n}`, n === '4' ? 'https://streakz.tistory.com/1' : `https://streak${n}.tistory.com/1`, D(14), `가상 잇따름 글 ${n}`)))
  const sp = await makePlan()
  const before6b = searches().length
  await runPlan(sp.body.planId)
  const sr = await waitRun()
  ok(
    '멈춤 — 응답 오류가 3번 잇따르면 멈춘다(4번째는 부르지 않음 · 세 글은 일시 1회)',
    sp.body.searches === 4 && searches().length === before6b + 3 && sr?.stoppedBy?.kind === 'upstream-streak' && sr.notRun === 1 && sr.unknown === 3,
    { ...sr, items: undefined },
  )
  // 검색과 적기 사이에 그 브랜드 index-checks.json이 깨지면 덮어쓰지 않고 멈춘다 · 줄이 빠지면 row-gone으로 건너뛴다.
  withLedger([post('p-vw01', 'https://wbreak.tistory.com/1', D(14), '가상 깨짐 글')])
  const wp = await makePlan()
  const goodChecksA = readData(dir, 'vauto-a', 'index-checks.json')
  await runPlan(wp.body.planId)
  for (let i = 0; i < 200 && !searches().some((s) => s.first === 'wbreak.tistory.com/1'); i += 1) await sleep(50)
  writeData(dir, 'vauto-a', 'index-checks.json', '{"format":"index-checks/1","checks":')
  const wr = await waitRun()
  ok(
    '적기 실패 — 그 브랜드 확인 파일이 깨졌으면 덮어쓰지 않고 멈춘다(write · 차례 몫에 안 셈)',
    wr?.stoppedBy?.kind === 'write' && readData(dir, 'vauto-a', 'index-checks.json') === '{"format":"index-checks/1","checks":' && attemptsFile().attempts.at(-1)?.reason === 'write',
    { ...wr, items: undefined },
  )
  writeData(dir, 'vauto-a', 'index-checks.json', goodChecksA)
  ok('적기 실패 — 파일을 고치면 그 글은 다시 첫 시도', (await makePlan()).body.targets.find((t) => t.key === 'wbreak.tistory.com/1')?.batch === 'first')
  withLedger([post('p-vg01', 'https://rgone.tistory.com/1', D(14), '가상 빠지는 글')])
  const gp = await makePlan()
  await runPlan(gp.body.planId)
  for (let i = 0; i < 200 && !searches().some((s) => s.first === 'rgone.tistory.com/1'); i += 1) await sleep(50)
  withLedger([])
  const gr = await waitRun()
  ok('줄이 빠짐 — 검색하는 사이 원장에서 빠진 글은 적지 않는다(row-gone)', gr?.items[0]?.skipped === 'row-gone' && gr.items[0].wrote === undefined && readData(dir, 'vauto-a', 'index-checks.json') === goodChecksA, gr?.items)

  // ── C6. 몫 · 바닥 · 계정 ──
  withLedger([post('p-vm01', 'https://budget.tistory.com/1', D(14), '가상 몫 글'), post('p-vm02', 'https://budget.tistory.com/2', D(14), '가상 몫 글 2')])
  const ledgerNow = readJson<{ format: string; cycles: Record<string, Record<string, unknown>>; pending: unknown[] }>(LEDGER)
  writeFileSync(LEDGER, JSON.stringify({ ...ledgerNow, cycles: { ...ledgerNow.cycles, '2026-12-08': { index: { sent: 200 }, aio: { sent: 7 } } } }))
  const before7 = searches().length
  const capPlan = await makePlan()
  ok('몫 — 이번 주기 색인 200회를 다 쓰면 계획 0 · 계획 id 없음 · 까닭(feature-cap)', capPlan.body.searches === 0 && capPlan.body.planId === null && capPlan.body.limitedBy === 'feature-cap' && capPlan.body.candidates === 2, { ...capPlan.body, targets: undefined })
  writeFileSync(LEDGER, JSON.stringify({ ...ledgerNow, cycles: { ...ledgerNow.cycles, '2026-12-08': { index: { sent: 199 }, aio: { sent: 7 } } } }))
  const onePlan = await makePlan()
  ok('몫 — 1회 남으면 1편만(AI 개요 사용은 색인 몫에 안 섞임)', onePlan.body.searches === 1 && onePlan.body.limitedBy === 'feature-cap' && onePlan.body.quota?.used === 199)
  await runPlan(onePlan.body.planId)
  await waitRun()
  ok('몫 — 그 1회만 보냈다', searches().length === before7 + 1 && sentInLedger() === 200)
  writeFileSync(LEDGER, JSON.stringify({ ...ledgerNow, cycles: { ...ledgerNow.cycles, '2026-12-08': { index: { sent: 20 } } } }))
  accountBody = account({ total_searches_left: 500 })
  const floorPlan = await makePlan()
  ok('바닥 — 계정 남은 검색이 바닥(500)이면 계획 0 · 까닭 floor', floorPlan.body.searches === 0 && floorPlan.body.limitedBy === 'floor' && floorPlan.body.planId === null, { ...floorPlan.body, targets: undefined })
  accountBody = account({ account_status: 'Suspended' })
  const suspended = await makePlan()
  ok('계정 — Active가 아니면 계획 0 · 까닭을 알린다', suspended.body.searches === 0 && suspended.body.planId === null && /활성/.test(suspended.body.blocked ?? ''), suspended.body.blocked)
  accountBody = account({ plan_renewal_date: null })
  const noRenewal = await makePlan()
  ok('계정 — 갱신일을 못 읽으면 계획 0(막힌 쪽)', noRenewal.body.searches === 0 && /갱신일/.test(noRenewal.body.blocked ?? ''), noRenewal.body.blocked)
  accountBody = account()
  accountMode = 'fail'
  const accountDown = await makePlan()
  ok('계정 — 못 읽으면 계획 0 · 까닭', accountDown.status === 200 && accountDown.body.searches === 0 && accountDown.body.planId === null && /계정/.test(accountDown.body.blocked ?? ''), accountDown.body)
  accountMode = 'ok'
  ok('몫 · 바닥 · 계정 시험 — 가짜 서버가 받은 검색은 1회뿐', searches().length === before7 + 1)
  // 실행 중 바닥 — 10회째 뒤 계정을 다시 읽을 때 남은 수가 바닥이면 거기서 멈춘다.
  const floorPosts = Array.from({ length: 12 }, (_, i) => post(`p-vf${String(i + 1).padStart(2, '0')}`, `https://floor${String(i + 1).padStart(2, '0')}.tistory.com/1`, D(14), `가상 바닥 글 ${i + 1}`))
  withLedger(floorPosts)
  const fPlan = await makePlan()
  const before8 = searches().length
  floorAfter = before8 + 10
  await runPlan(fPlan.body.planId)
  const fRun = await waitRun()
  floorAfter = Infinity
  accountBody = account()
  ok(
    '바닥 — 실행 중 10회째 뒤 계정이 바닥이면 멈춤(검색 10 · 남은 글 · 보내지 않은 시도는 차례 몫에 안 셈)',
    fPlan.body.searches === 12 && searches().length === before8 + 10 && fRun?.stoppedBy?.kind === 'floor' && fRun.notRun === 2 && attemptsFile().attempts.at(-1)?.outcome === 'not-sent',
    { plan: fPlan.body.searches, got: searches().length - before8, run: { ...fRun, items: undefined } },
  )
  const fAfter = await makePlan()
  ok('바닥 — 멈춘 글은 다음 계획에 첫 시도로 남는다', fAfter.body.targets.filter((t) => t.key.startsWith('floor')).length === 2 && fAfter.body.targets.every((t) => t.batch === 'first'))
  await runPlan(fAfter.body.planId)
  await waitRun()

  // ── C7. 한 번 상한 · 설정 ──
  const badSettings = [
    await call('PUT', '/api/index-auto/settings', undefined, { text: '{"runCap":5}', type: 'text/plain' }),
    await call('PUT', '/api/index-auto/settings', {}),
    await call('PUT', '/api/index-auto/settings', { runCap: 0 }),
    await call('PUT', '/api/index-auto/settings', { runCap: 201 }),
    await call('PUT', '/api/index-auto/settings', { runCap: '5' }),
    await call('PUT', '/api/index-auto/settings', { runCap: 2.5 }),
    await call('PUT', '/api/index-auto/settings', { autoOnOpen: 'yes' }),
    await call('PUT', '/api/index-auto/settings', { runCap: 5, foo: 1 }),
  ].map((r) => r.status)
  ok('설정 — JSON만(415) · 빈 본문 · 범위 밖 · 모양 틀림 · 모르는 칸 400', JSON.stringify(badSettings) === JSON.stringify([415, 400, 400, 400, 400, 400, 400, 400]), badSettings)
  const capSet = await call<{ settings: { runCap: number; autoOnOpen: boolean } }>('PUT', '/api/index-auto/settings', { runCap: 2 })
  withLedger(Array.from({ length: 3 }, (_, i) => post(`p-vr0${i + 1}`, `https://runcap.tistory.com/${i + 1}`, D(14), `가상 상한 글 ${i + 1}`)))
  const capPlan2 = await makePlan()
  ok('한 번 상한 — runCap 2면 3편 중 2편(run-cap)', capSet.status === 200 && capSet.body.settings.runCap === 2 && capSet.body.settings.autoOnOpen === false && capPlan2.body.searches === 2 && capPlan2.body.limitedBy === 'run-cap' && capPlan2.body.candidates === 3)
  await call('PUT', '/api/index-auto/settings', { runCap: 40 })
  const capPlan3 = await makePlan()
  await runPlan(capPlan3.body.planId)
  await waitRun()

  // ── C8. 열 때 하루 한 번 ──
  withLedger([post('p-vo01', 'https://open.tistory.com/1', D(14), '가상 열 때 글')])
  const openOff = await makePlan('open')
  ok('열 때 — 설정이 꺼져 있으면 409', openOff.status === 409, openOff)
  await call('PUT', '/api/index-auto/settings', { autoOnOpen: true })
  const openPlan = await makePlan('open')
  const openRun = await runPlan(openPlan.body.planId)
  await waitRun()
  const openAgain = await makePlan('open')
  const st8 = await status()
  ok('열 때 — 켜면 하루 한 번 돌고, 같은 날 두 번째는 409', openPlan.status === 200 && openRun.status === 202 && openAgain.status === 409 && st8.body.openRunToday === true && attemptsFile().runs.at(-1)?.trigger === 'open', [openPlan.status, openRun.status, openAgain.status])
  await call('PUT', '/api/index-auto/settings', { autoOnOpen: false })

  // ── C9. 한 번에 하나 ──
  withLedger([post('p-vk01', 'https://conc.tistory.com/1', D(14), '가상 동시 글'), post('p-vk02', 'https://conc2.tistory.com/1', D(14), '가상 동시 글 2')])
  const cp1 = await makePlan()
  const cp2 = await makePlan()
  const before9 = searches().length
  const cr1 = await runPlan(cp1.body.planId)
  const cr2 = await runPlan(cp2.body.planId)
  const cpDuring = await makePlan()
  const stDuring = await status()
  await waitRun()
  ok(
    '한 번에 하나 — 도는 동안 두 번째 실행 · 계획은 409, 진행(done/total)이 보인다',
    cr1.status === 202 && cr2.status === 409 && cpDuring.status === 409 && stDuring.body.running?.total === 2 && searches().length === before9 + 2,
    [cr1.status, cr2.status, cpDuring.status, stDuring.body.running],
  )

  // ── C9-b. 앱을 두 번 켬 — 같은 사용자 데이터를 쓰는 두 서버도 한 번에 하나(실행 잠금 파일) ──
  withLedger([post('p-vp01', 'https://twoproc.tistory.com/1', D(14), '가상 두 창 글'), post('p-vp02', 'https://twoproc.tistory.com/2', D(14), '가상 두 창 글 2')])
  const app2 = await start({}, APP2_PORT)
  try {
    const tp1 = await makePlan()
    const tp2 = await callOn<IndexAutoPlanView>(APP2_PORT, 'POST', '/api/index-auto/plan', { trigger: 'button' })
    const beforeTwo = searches().length
    const [tr1, tr2] = await Promise.all([runPlan(tp1.body.planId), callOn<{ runId: string; total: number }>(APP2_PORT, 'POST', '/api/index-auto/run', { planId: tp2.body.planId })])
    const winner = tr1.status === 202 ? APP_PORT : APP2_PORT
    const loser = winner === APP_PORT ? APP2_PORT : APP_PORT
    const lost = winner === APP_PORT ? tr2 : tr1
    const loserStatus = await callOn<IndexAutoStatusView>(loser, 'GET', '/api/index-auto')
    const loserPlan = await callOn<IndexAutoPlanView>(loser, 'POST', '/api/index-auto/plan', { trigger: 'button' })
    const loserPut = await callOn(loser, 'PUT', '/api/index-auto/settings', { runCap: 7 })
    const pendingWhile = attemptsFile().attempts.filter((a) => a.key.startsWith('twoproc.') && a.outcome === 'pending').length
    const twoRun = await waitRunOn(winner)
    const twoAttempts = attemptsFile().attempts.filter((a) => a.key.startsWith('twoproc.'))
    ok(
      '앱을 두 번 켬 — 두 서버가 함께 눌러도 한쪽만 202, 다른 쪽은 409(다른 창에서 도는 중)',
      tp1.body.searches === 2 && tp2.body.searches === 2 && [tr1.status, tr2.status].sort().join(',') === '202,409' && (lost.body as { code?: string }).code === 'busy-elsewhere',
      [tr1.status, tr2.status, lost.body],
    )
    ok(
      '앱을 두 번 켬 — 도는 동안 다른 서버는 계획 409 · 설정 저장 409 · 상태에 「다른 창」 안내, 그쪽 대기 시도를 끊김으로 닫지 않는다',
      loserPlan.status === 409 && loserPlan.body.code === 'busy-elsewhere' && loserPut.status === 409 && loserStatus.status === 200 && loserStatus.body.running === null &&
        typeof loserStatus.body.busyElsewhere === 'string' && pendingWhile <= 1 && (await status()).body.settings.runCap === 40,
      { loserPlan: loserPlan.status, loserPut: loserPut.status, busyElsewhere: loserStatus.body.busyElsewhere, pendingWhile },
    )
    ok(
      '앱을 두 번 켬 — 가짜 서버가 받은 검색은 계획 수(2)와 같고, 시도 2건 모두 찾음(끊김 · 덮어쓰기 없음)',
      searches().length - beforeTwo === 2 && twoRun?.searched === 2 && twoAttempts.length === 2 && twoAttempts.every((a) => a.outcome === 'found' && a.reason === undefined),
      { got: searches().length - beforeTwo, twoAttempts },
    )
    const loserAfter = await callOn<IndexAutoStatusView>(loser, 'GET', '/api/index-auto')
    ok('앱을 두 번 켬 — 끝나면 다른 서버의 「다른 창」 안내도 사라진다', loserAfter.body.busyElsewhere === null, loserAfter.body.busyElsewhere)
  } finally {
    await stop(app2, APP2_PORT)
  }

  // ── C10. 끊김 — 응답을 기다리는 사이 앱이 꺼짐 ──
  withLedger([post('p-vh00', 'https://aaa-hang.tistory.com/1', D(14), '가상 끊김 앞 글'), post('p-vh01', 'https://hang.tistory.com/1', D(14), '가상 끊김 글')])
  const hp = await makePlan()
  const ledgerBeforeHang = sentInLedger()
  const fakeBeforeHang = searches().length
  await runPlan(hp.body.planId)
  for (let i = 0; i < 200 && !searches().some((s) => s.first === 'hang.tistory.com/1'); i += 1) await sleep(50)
  await stop(app)
  const pendingLeft = attemptsFile().attempts.at(-1)
  ok('끊김 — 꺼진 때 시도는 대기(pending)로 남아 있다', pendingLeft?.outcome === 'pending' && pendingLeft.key === 'hang.tistory.com/1', pendingLeft)
  app = await start()
  const st10 = await status()
  const closed = attemptsFile().attempts.find((a) => a.id === pendingLeft?.id)
  ok('끊김 — 다시 켜면 대기 시도를 interrupted로 닫고 실행은 끊김(endedAt null)으로 둔다', closed?.outcome === 'unknown' && closed.reason === 'interrupted' && st10.body.lastRun?.endedAt === null && st10.body.running === null, { closed, lastRun: st10.body.lastRun })
  ok(
    '끊김 — 끊긴 실행 기록에 끊기기 전에 끝난 글(1편 · 찾음)이 남는다(보낸 수 · 줄마다)',
    st10.body.lastRun?.planned === 2 && st10.body.lastRun.searched === 1 && st10.body.lastRun.found === 1 && st10.body.lastRun.items.length === 1 &&
      st10.body.lastRun.items[0]?.key === 'aaa-hang.tistory.com/1' && st10.body.lastRun.items[0]?.wrote === 'shown',
    st10.body.lastRun,
  )
  ok(
    '끊김 — 장부는 가짜 서버가 받은 검색 수 이상(덜 세지 않음)',
    searches().length - fakeBeforeHang === 2 && sentInLedger() - ledgerBeforeHang >= searches().length - fakeBeforeHang,
    { ledger: sentInLedger() - ledgerBeforeHang, fake: searches().length - fakeBeforeHang },
  )
  const hp2 = await makePlan()
  ok('끊김 — 그 글은 두 번째 시도(retry)로 다시 대상', hp2.body.targets.find((t) => t.key === 'hang.tistory.com/1')?.batch === 'retry')
  hangMode = false
  await runPlan(hp2.body.planId)
  const hr = await waitRun()
  ok('끊김 — 두 번째 시도에서 찾으면 적는다', hr?.found === 1)

  // ── C11. 기록 파일 — 모르는 값 보존 · 깨진 파일 ──
  const af = readJson<Record<string, unknown> & { attempts: Record<string, unknown>[] }>(INDEX_AUTO)
  af.attempts.push({ id: 'a-future', at: new Date().toISOString(), on: today, runId: 'r-future', engine: 'google', key: 'future.tistory.com/1', turn: `d14:${today}`, outcome: 'unknown', reason: 'future-reason', extraField: { kept: true } })
  af.futureTop = 'kept'
  writeFileSync(INDEX_AUTO, JSON.stringify(af, null, 2))
  withLedger([post('p-vz01', 'https://keep.tistory.com/1', D(14), '가상 보존 글')])
  const kp = await makePlan()
  await runPlan(kp.body.planId)
  await waitRun()
  const kept = readJson<Record<string, unknown> & { attempts: Record<string, unknown>[] }>(INDEX_AUTO)
  ok(
    '기록 파일 — 모르는 까닭 · 칸 · 머리 칸은 다시 쓴 뒤에도 남는다',
    kept.futureTop === 'kept' && JSON.stringify(kept.attempts.find((a) => a.id === 'a-future')?.extraField) === JSON.stringify({ kept: true }) && kept.attempts.find((a) => a.id === 'a-future')?.reason === 'future-reason',
  )
  const st11 = await status()
  ok('기록 파일 — 모르는 까닭도 GET에 그대로 보인다', st11.status === 200 && st11.body.attemptsByKey['future.tistory.com/1']?.[0]?.reason === 'future-reason')
  const goodText = readFileSync(INDEX_AUTO, 'utf8')
  for (const [label, text] of [
    ['JSON 아님', '{broken'],
    ['모르는 형식', JSON.stringify({ format: 'index-auto/9', settings: { runCap: 40, autoOnOpen: false }, attempts: [], runs: [] })],
    ['설정 틀림', JSON.stringify({ format: 'index-auto/1', settings: { runCap: 0, autoOnOpen: false }, attempts: [], runs: [] })],
    ['시도 배열 아님', JSON.stringify({ format: 'index-auto/1', settings: { runCap: 40, autoOnOpen: false }, attempts: {}, runs: [] })],
  ] as const) {
    writeFileSync(INDEX_AUTO, text)
    const before11 = searches().length
    const g11 = await status()
    const p11 = await makePlan()
    const r11 = await runPlan('whatever')
    ok(`기록 파일 깨짐(${label}) — GET · 계획 500, 실행 시작 안 함 · 파일 그대로 · 검색 0`, g11.status === 500 && p11.status === 500 && r11.status >= 400 && readFileSync(INDEX_AUTO, 'utf8') === text && searches().length === before11, [g11.status, p11.status, r11.status])
  }
  writeFileSync(INDEX_AUTO, goodText)
  writeFileSync(LEDGER, '{broken')
  const brokenLedger = await makePlan()
  ok('장부 깨짐 — 계획 0 · 까닭(덮어쓰지 않음)', brokenLedger.body.searches === 0 && brokenLedger.body.planId === null && /사용 기록/.test(brokenLedger.body.blocked ?? '') && readFileSync(LEDGER, 'utf8') === '{broken', brokenLedger.body)
  unlinkSync(LEDGER)
} finally {
  await stop(app)
}

// ── C12. 키 없음 · 막힌 쪽 주소 ──
const callsBeforeOff = seen.length
app = await start({ SERPAPI_API_KEY: '' })
try {
  const s = await status()
  const p = await makePlan()
  const r = await runPlan('x')
  ok('키 없음 — configured false · 계획 503(넣을 곳 안내) · 실행 503', s.status === 200 && s.body.configured === false && p.status === 503 && /SERPAPI_API_KEY/.test(p.body.error ?? '') && r.status === 503, [s.body.configured, p.status, r.status])
} finally {
  await stop(app)
}
app = await start({ SERPAPI_BASE_URL: 'http://localhost:4195' })
try {
  const s = await status()
  const p = await makePlan()
  ok('막힌 쪽 주소 — configError · 계획 503', s.body.configured === true && typeof s.body.configError === 'string' && p.status === 503, [s.body.configError, p.status])
} finally {
  await stop(app)
}
ok('키 없음 · 막힌 쪽 주소 — 가짜 서버가 받은 것이 없다', seen.length === callsBeforeOff)

// ── C13. 키 · 저장소 ──
const leakIn = (t: string) => t.includes(FAKE_KEY) || t.includes(encodeURIComponent(FAKE_KEY)) || t.includes('api_key=')
const filesText = [INDEX_AUTO, ...['vauto-a', 'vauto-b', 'vauto-c'].map((t) => path.join(dir, 'data', t, 'index-checks.json'))].map((p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')).join('\n')
ok('키 — 응답 · 기록 파일 · index-checks · 서버 로그 어디에도 없고, 진짜 SerpAPI로 가려던 요청도 없다', [...bodies, filesText, logs].every((t) => !leakIn(t)) && !logs.includes('VERIFY-GUARD'), logs.slice(-1500))
ok('가짜 서버가 받은 모든 요청은 가짜 키였다', seen.every((s) => s.keyOk))
ok('.gitignore — dev 기록(server/index-auto.json)을 올리지 않는다', readFileSync('.gitignore', 'utf8').split(/\r?\n/).includes('server/index-auto.json'))
ok('웹 함수는 그대로 12개(api/)', execSync('git ls-files api', { encoding: 'utf8' }).trim().split(/\r?\n/).length === 12)
ok('이 프로세스의 fetch가 127.0.0.1 밖으로 나가려 한 적이 없다', blocked.length === 0, blocked)

for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill()
mock.closeAllConnections()
mock.close()
for (const d of [dir, unitDir, oldDir]) rmSync(d, { recursive: true, force: true })

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
