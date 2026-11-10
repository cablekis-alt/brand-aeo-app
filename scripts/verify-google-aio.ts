/**
 * 구글 AI 개요 시범(src/lib/googleAio.ts)을 확인한다.
 *
 * 안전 규칙(검색마다 돈이 든다): 진짜 SerpAPI(serpapi.com)와 LLM 공급자는 부르지 않는다. A부는 순수 함수만 부르고, 이 프로세스의 fetch는
 * 127.0.0.1 밖으로 나가면 막고 기록한다(A부는 fetch를 한 번도 부르지 않아야 한다). 응답 꼴은 2026-11-10 한국어 시험(키 가림)의 모양을 본떠
 * 손으로 쓴 가짜다 — 브랜드 · 주소 · 제목은 모두 가짜이고 작성자는 w1~w8로만 쓴다.
 *
 * 무엇을 보나:
 * A. 순수 함수 — 검색 매개변수(no_cache · 위치 표 「전북 군산」 · 전국형 · B2B는 위치 없음 · 설정 덮어쓰기) · 늦게 오는 개요 후속 매개변수 ·
 *    조건 서명 · 질문 지문 · 시작 조건 M · 응답 읽기(있음 인라인 · 늦게 오는 개요 · 없음 · 결과 0건 · 못 읽음 · 오류 · 모양 깨짐 · page_token
 *    상한) · 모르는 text_blocks type의 글자 · 출처는 http(s)만 · rawBlock에서 page_token · serpapi_link 빼기 · 언급 판정 읽기(판정 불가 null) ·
 *    지표 분모(분모 0 · 목록 없음은 null — 0 아님) · 출처 없는 개요 · 자사 · 올린 글 출처는 읽을 때 계산('after' 회차만 · 내린 뒤 회차 빼기 ·
 *    앱 밖 글) · 「출처로만 보임」(낱말 경계) · 요약 타일은 done 또는 90% 이상 회차만 · 회차끼리는 공통 질문만 · 같은 조건 회차만 k/N ·
 *    노출 급락 경고와 추이 선 끊기 · 판정 비용(생각 토큰 포함) · 이어 재기 거절 · 회차 id · 이 PC 설정 읽기 · 회차 파일 읽기.
 * 정적 검사 — 점수 · 보고서 · 회차 기록 모듈(측정 · 집계 · 점수 · 저장 · 회차 기록 · 표본 · 인용 이력 · 사용량 · 정기진단 보고서 · 퍼포먼스 ·
 *    개요)과 AI 개요가 읽기만 하는 모듈(원장 · 앱 밖 글 · 발행 현황 · 색인 자동 확인 · 측정 진행 · 판정 엔진 · SerpAPI 공용 연결)의 닫힘에 AI 개요
 *    모듈이 없다. AI 개요 모듈은 resetJudgeHealth를 쓰지 않는다. src/lib/googleAio.ts의 닫힘은 화면 · 서버 공용 순수 모듈뿐이다(node 모듈 ·
 *    서버 모듈 · 네트워크 없음).
 *
 *   npx tsx scripts/verify-google-aio.ts
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  AIO_CELL,
  AIO_FOLLOW_UP_ENGINE,
  AIO_LOCATIONS,
  AIO_NOISE_NOTE,
  AIO_RAW_BLOCK_MAX,
  AIO_RUN_ID,
  AIO_SEARCH_PARAMS,
  AIO_TEXT_MAX,
  AIO_VALUE_MAX,
  GOOGLE_AIO_FORMAT,
  aioBankLabel,
  aioCellOf,
  aioConditionDiffs,
  aioConditionSignature,
  aioConditions,
  aioFollowUpParams,
  aioItemOf,
  aioLocationFor,
  aioMaxSearches,
  aioParamsFit,
  aioPostRows,
  aioPostTable,
  aioQuestionRows,
  aioQuestionSet,
  aioQuestionsOf,
  aioReSearchCap,
  aioRemaining,
  aioResumeProblem,
  aioRunId,
  aioSameConditions,
  aioSearchParams,
  aioTrend,
  aioView,
  compareAioRuns,
  flattenTextBlocks,
  isSummaryRun,
  judgeCostOf,
  latestSummaryRun,
  parseAioRun,
  parseAioSettings,
  pctText,
  ratioText,
  readAioFirst,
  readAioFollowUp,
  readMentionVerdict,
  scrubRawBlock,
  sourceOnlyOf,
  summarizeAioRun,
  type AioItem,
  type AioPost,
  type AioReadContext,
  type AioReadResult,
  type AioRun,
  type AioRunState,
} from '../src/lib/googleAio'
import { mentionsWord } from '../src/lib/aeo/entityMatch'
import { trackingKey } from '../src/lib/publishedUrl'

// 안전 — 이 프로세스의 fetch는 127.0.0.1만 나간다(그 밖은 막고 기록한다). A부는 fetch를 부르지 않는다.
const fetchCalls: string[] = []
const realFetch = globalThis.fetch
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  fetchCalls.push(href.split('?')[0]!)
  const host = URL.canParse(href) ? new URL(href).hostname : ''
  if (host !== '127.0.0.1') return Promise.reject(new Error('verify guard: 127.0.0.1 밖으로 나가는 요청을 막았습니다'))
  return realFetch(input, init)
}) as typeof fetch

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean, detail?: unknown) => {
  checks.push([label, cond])
  if (!cond && detail !== undefined) console.error(`  ✗ ${label}:`, typeof detail === 'string' ? detail : JSON.stringify(detail, null, 1).slice(0, 3000))
}
const repo = process.cwd()
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const near = (a: number | null, b: number) => a !== null && Math.abs(a - b) < 1e-9

// ── 가짜 응답(2026-11-10 시험 응답의 모양 — 글자는 모두 지어낸 것) ────────────────────────────────────────────
const GUNSAN = 'Gunsan-si,Jeollabuk-do,South Korea'
const tokenOf = (n: number) => 'Ab0-_Zx9'.repeat(Math.ceil(n / 8)).slice(0, n)
const TOKEN = tokenOf(1534)
const meta = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  status: 'Success',
  json_endpoint: `https://serpapi.com/searches/${id}.json`,
  markdown_endpoint: `https://serpapi.com/searches/${id}.md`,
  created_at: '2026-11-11 01:00:00 UTC',
  processed_at: '2026-11-11 01:00:00 UTC',
  raw_html_file: `https://serpapi.com/searches/${id}.html`,
  total_time_taken: 1.25,
  ...extra,
})
const ref = (index: number, link: string, title: string, extra: Record<string, unknown> = {}) => ({
  index,
  title,
  link,
  snippet: `가짜 출처 ${index}의 발췌문 — 본문에 넣지 않는다`,
  source: `가짜출처${index}`,
  source_icon: `https://icons.example.net/${index}.png`,
  ...extra,
})

/** k1 — 지역 질문 첫 검색: ai_overview에 page_token · serpapi_link만(늦게 오는 개요). */
const k1First = {
  search_metadata: meta('fake-k1', { google_url: 'https://www.google.co.kr/search?q=fake', pixel_position_endpoint: 'https://serpapi.com/searches/fake-k1.json_with_pixel_position' }),
  search_parameters: { engine: 'google', q: '가짜 군산 1박 2일 코스', location_requested: GUNSAN, location_used: GUNSAN, google_domain: 'google.co.kr', hl: 'ko', gl: 'kr', device: 'desktop' },
  search_information: { query_displayed: '가짜 군산 1박 2일 코스', total_results: 1000, time_taken_displayed: 0.31, organic_results_state: 'Results for exact spelling' },
  ai_overview: { page_token: TOKEN, serpapi_link: `https://serpapi.com/search.json?engine=google_ai_overview&page_token=${TOKEN}` },
  organic_results: [{ position: 1, title: '가짜 결과', link: 'https://example.org/a' }],
  related_searches: [],
  pagination: { current: 1, next: 'https://www.google.co.kr/search?q=fake&start=10' },
  serpapi_pagination: { current: 1, next: 'https://serpapi.com/search.json?start=10' },
}
/** k1 후속 — 문단 6 · 출처 10. */
const k1Follow = {
  search_metadata: meta('fake-k1-f', { google_ai_overview_url: 'https://www.google.com/fake-aio' }),
  search_parameters: { engine: 'google_ai_overview', page_token: TOKEN },
  ai_overview: {
    text_blocks: [
      { type: 'paragraph', snippet: '가짜 군산 여행은 바다와 골목을 함께 봅니다.', snippet_highlighted_words: ['바다와 골목'], reference_indexes: [0, 1, 2] },
      { type: 'heading', snippet: '첫째 날 가짜 일정' },
      {
        type: 'list',
        list: [
          { snippet: '오전: 가짜 시장 구경', list: [{ snippet: '가짜 빵집 들르기', reference_indexes: [3] }], reference_indexes: [2] },
          { snippet: '점심: 가짜 국숫집', list: [{ snippet: '줄이 길어요', reference_indexes: [4] }], reference_indexes: [4] },
          { snippet: '오후: 가짜 근대 거리', list: [{ snippet: '골목 하나' }, { snippet: '골목 둘' }, { snippet: '사진 찍기', reference_indexes: [5] }] },
          { snippet: '저녁: 가짜 항구', list: [{ snippet: '노을', reference_indexes: [6] }] },
          { snippet: '밤: 가짜 숙소', list: [{ snippet: '한옥', reference_indexes: [7] }, { snippet: '조용한 방', reference_indexes: [7] }] },
        ],
      },
      { type: 'heading', snippet: '둘째 날 가짜 일정' },
      {
        type: 'list',
        list: [
          { snippet: '오전: 가짜 섬', list: [{ snippet: '배', reference_indexes: [8] }] },
          { snippet: '점심: 가짜 횟집', list: [{ snippet: '바다 앞', reference_indexes: [9] }] },
          { snippet: '오후: 돌아가기', list: [{ snippet: '기차', reference_indexes: [9] }] },
        ],
      },
      { type: 'paragraph', snippet: '날씨를 미리 보고 가세요.' },
    ],
    references: [
      ref(0, 'https://news.example.com/article/1', '가짜 신문 기사', { thumbnail: 'https://thumbs.example.net/0.jpg' }),
      ref(1, 'https://tour.example.go.kr/view?id=7', '가짜 관광 안내'),
      ref(2, 'https://m.blog.naver.com/fakewriter1/223000000001', '가짜 블로그 여행기'),
      ref(3, 'https://www.youtube.com/watch?v=FAKEvid01', '가짜 영상'),
      ref(4, 'https://m.blog.naver.com/otherblog/223000000099', '테스트펜션 숙박 후기(가짜)'),
      ref(5, 'https://www.instagram.com/p/FAKEp1/', '가짜 사진 1'),
      ref(6, 'https://www.instagram.com/reel/FAKEr2/', '가짜 사진 2'),
      ref(7, 'https://fakestay.tistory.com/12#:~:text=%EA%B0%80%EC%A7%9C', '가짜 숙소 글'),
      ref(8, 'https://www.city.example.go.kr/tour/1', '가짜 시청 1'),
      ref(9, 'https://www.city.example.go.kr/tour/2', '가짜 시청 2'),
    ],
  },
}
/** k2 — 나라 단위 질문 후속: 문단 14 · 출처 목록 없음(references 키 자체가 없다). */
const k2Follow = {
  search_metadata: meta('fake-k2-f'),
  search_parameters: { engine: 'google_ai_overview', page_token: tokenOf(1491) },
  ai_overview: {
    text_blocks: [
      { type: 'paragraph', snippet: '가짜 한옥 숙소를 고를 때 볼 점입니다.', snippet_highlighted_words: ['볼 점'] },
      ...[1, 2, 3, 4, 5, 6].flatMap((i) => [
        { type: 'heading', snippet: `가짜 기준 ${i}` },
        { type: 'list', list: [{ snippet: `가짜 설명 ${i}-1` }, { snippet: `가짜 설명 ${i}-2` }] },
      ]),
      { type: 'paragraph', snippet: '마지막으로 후기를 보세요.' },
    ],
  },
}
/** e1 — 영어 대조 후속: 장소 결과(local_result) · snippet_links가 든 목록, 출처 9. */
const e1Follow = {
  search_metadata: meta('fake-e1-f'),
  search_parameters: { engine: 'google_ai_overview', page_token: tokenOf(1436) },
  ai_overview: {
    text_blocks: [
      { type: 'paragraph', snippet: 'Choosing a fake hanok stay depends on location.', snippet_highlighted_words: ['location'], reference_indexes: [0] },
      { type: 'heading', snippet: 'Fake places to consider' },
      {
        type: 'list',
        list: [
          {
            local_result: { title: 'Fake Hanok Lodge', data_cid: '123', data_cid_search: 'https://www.google.com/search?cid=123', gps_coordinates: { latitude: 35.8, longitude: 127.1 }, provider_id: '/g/fake' },
            snippet: 'A quiet fake lodge near the old town.',
            reference_indexes: [1, 2],
            snippet_links: [
              { text: 'Fake Hanok Lodge', link: 'https://www.google.com/maps/fake?entry=1' },
              { text: 'old town', link: 'https://hanok.example.org/' },
            ],
          },
          { snippet: 'Another fake option.', reference_indexes: [3] },
        ],
      },
    ],
    references: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => ref(i, `https://en.example.com/guide/${i}`, `Fake guide ${i}`)),
  },
}
/** 인라인 — 첫 검색에 본문 · 출처가 바로 온다. */
const inlineFirst = {
  search_metadata: meta('fake-inline'),
  search_parameters: { engine: 'google', q: '가짜 질문', google_domain: 'google.co.kr', hl: 'ko', gl: 'kr', device: 'desktop' },
  ai_overview: {
    text_blocks: [
      { type: 'paragraph', snippet: '테스트펜션은 조용한 가짜 숙소입니다.', reference_indexes: [0] },
      { type: 'expandable', title: '더 보기', text_blocks: [{ type: 'paragraph', snippet: '접힌 문단의 가짜 글' }] },
    ],
    references: [ref(0, 'https://fake-stay.example/about', '가짜 소개')],
    serpapi_link: 'https://serpapi.com/search.json?engine=google_ai_overview&page_token=zzz',
  },
  organic_results: [],
}
const absentFirst = {
  search_metadata: meta('fake-absent'),
  search_parameters: { engine: 'google', q: '가짜' },
  search_information: { organic_results_state: 'Results for exact spelling' },
  organic_results: [{ position: 1, title: '가짜', link: 'https://example.org/b' }],
  related_questions: [],
}
const noResultsFirst = { search_metadata: meta('fake-zero'), search_parameters: { engine: 'google', q: '가짜' }, search_information: { organic_results_state: 'Fully empty' }, error: "Google hasn't returned any results for this query." }

// ── A1. 검색 매개변수 · 위치 · 조건 서명 ─────────────────────────────────────────────────────
{
  const p = aioSearchParams('가짜 군산 1박 2일 코스', GUNSAN)
  ok('매개변수 — engine=google · hl=ko · gl=kr · google.co.kr · desktop · no_cache=true · location · q', same(p, {
    engine: 'google',
    q: '가짜 군산 1박 2일 코스',
    google_domain: 'google.co.kr',
    gl: 'kr',
    hl: 'ko',
    device: 'desktop',
    no_cache: 'true',
    location: GUNSAN,
  }), p)
  ok('매개변수 — 위치가 없으면 location 칸이 없다', !('location' in aioSearchParams('q', null)))
  ok('매개변수 — 검색어는 앞뒤 공백만 뗀다(질문 지문과 같은 글자)', aioSearchParams('  가짜 질문 하나  ', null).q === '가짜 질문 하나')
  ok('매개변수 — 공용 연결의 값 길이 상한 안인지 보내기 전에 가린다(질문 · 위치 · page_token)', aioParamsFit(p) && aioParamsFit(aioFollowUpParams(tokenOf(AIO_VALUE_MAX))) && !aioParamsFit(aioFollowUpParams(tokenOf(AIO_VALUE_MAX + 1))) && !aioParamsFit(aioSearchParams('가'.repeat(AIO_VALUE_MAX + 1), null)))
  ok('매개변수 — 키 · async · output은 넣지 않는다(공용 연결이 붙이고, 금지)', ['api_key', 'async', 'output'].every((k) => !(k in p) && !(k in aioFollowUpParams(TOKEN))))
  ok('매개변수 — 11-10 시험에서 받아들여진 위치(location_used)와 같은 값을 보낸다', p.location === k1First.search_parameters.location_used && p.location === k1First.search_parameters.location_requested)
  ok('매개변수 — 고정 칸은 상수와 같다', Object.entries(AIO_SEARCH_PARAMS).every(([k, v]) => p[k] === v) && AIO_SEARCH_PARAMS.no_cache === 'true')
  ok('늦게 오는 개요 후속 — engine=google_ai_overview · page_token · no_cache', same(aioFollowUpParams(TOKEN), { engine: 'google_ai_overview', page_token: TOKEN, no_cache: 'true' }) && AIO_FOLLOW_UP_ENGINE === 'google_ai_overview')

  ok('위치 표 — 「전북 군산」 → Gunsan-si,Jeollabuk-do,South Korea', AIO_LOCATIONS['전북 군산'] === GUNSAN)
  const local = aioLocationFor({ tenantId: 'fake-local', region: '전북 군산' })
  ok('위치 — 지역형(marketScope 없음) 「전북 군산」은 표의 값', local.ok && local.location === GUNSAN, local)
  const localExplicit = aioLocationFor({ tenantId: 'fake-local', region: ' 전북  군산 ', marketScope: 'local' })
  ok('위치 — 지역 글자의 앞뒤 · 겹친 공백은 같은 지역', localExplicit.ok && localExplicit.location === GUNSAN, localExplicit)
  const national = aioLocationFor({ tenantId: 'fake-n', region: '전북 군산', marketScope: 'national' })
  const b2b = aioLocationFor({ tenantId: 'fake-b', region: '전국', marketScope: 'b2b' })
  ok('위치 — 전국형 · B2B는 위치 없음(gl=kr만)', national.ok && national.location === null && b2b.ok && b2b.location === null, [national, b2b])
  const unknown = aioLocationFor({ tenantId: 'fake-x', region: '제주 서귀포' })
  ok('위치 — 표에 없는 지역형은 짐작하지 않고 멈춘다(위치 없이 재지 않는다)', !unknown.ok && unknown.reason === 'no-location', unknown)
  const over = aioLocationFor({ tenantId: 'fake-x', region: '제주 서귀포' }, { 'fake-x': 'Seogwipo-si,Jeju,South Korea' })
  const overNational = aioLocationFor({ tenantId: 'fake-n', region: '전국', marketScope: 'national' }, { 'fake-n': 'South Korea' })
  ok('위치 — 이 PC 설정 locations가 이긴다(지역형 · 전국형 모두)', over.ok && over.location === 'Seogwipo-si,Jeju,South Korea' && overNational.ok && overNational.location === 'South Korea', [over, overNational])
  ok('위치 — 다른 브랜드의 설정은 쓰지 않는다', (() => {
    const r = aioLocationFor({ tenantId: 'fake-local', region: '전북 군산' }, { other: 'Elsewhere' })
    return r.ok && r.location === GUNSAN
  })())

  const sig = aioConditionSignature(GUNSAN)
  ok('조건 서명 — 검색어는 들지 않고 고정 칸 · 위치가 든다', !sig.includes('가짜') && sig.startsWith('google-aio serpapi') && sig.includes('hl=ko') && sig.includes('gl=kr') && sig.includes('google.co.kr') && sig.includes('desktop') && sig.includes(GUNSAN) && /no_?cache|cache/.test(sig), sig)
  ok('조건 서명 — 같은 위치면 같고, 위치가 다르거나 없으면 다르다', sig === aioConditionSignature(GUNSAN) && sig !== aioConditionSignature(null) && sig !== aioConditionSignature('Seoul,South Korea'))
  ok('조건 서명 — 위치 없음도 서명에 적힌다', aioConditionSignature(null).includes('없음'), aioConditionSignature(null))
}

// ── A2. 질문 고르기 · 지문 · 시작 조건 M ──────────────────────────────────────────────────────
const fakeQuestion = (i: number, category = 'category-agnostic', extra: Record<string, unknown> = {}) => ({
  questionId: `c1-${String(i).padStart(3, '0')}`,
  text: `가짜 이름 없는 질문 ${i}번은 무엇인가요?`,
  category,
  industry: '펜션',
  region: '전북 군산',
  containsBrandName: category !== 'category-agnostic' && category !== 'local-regional',
  version: 'v6',
  ...extra,
})
const fakeBank = [
  ...Array.from({ length: 50 }, (_, i) => fakeQuestion(i + 1)),
  fakeQuestion(51, 'brand-direct'),
  fakeQuestion(52, 'comparison'),
  fakeQuestion(53, 'category-agnostic', { probe: true }),
  fakeQuestion(54, 'local-regional'),
]
{
  const picked = aioQuestionsOf(fakeBank as Parameters<typeof aioQuestionsOf>[0])
  ok('질문 — 점수에 세는 이름 없는 질문만(카테고리 무관 · 실증 아님) 50개', picked.length === 50 && picked.every((q) => !q.questionId.endsWith('53') && Number(q.questionId.slice(3)) <= 50), picked.map((q) => q.questionId))
  ok('질문 — 질문지 순서 그대로', picked[0]!.questionId === 'c1-001' && picked[49]!.questionId === 'c1-050')
  const set = aioQuestionSet(picked)
  ok('질문 지문 — scope · ids · hash(16자)', set.scope === 'scored-agnostic' && set.ids.length === 50 && /^[0-9a-f]{16}$/.test(set.hash), set)
  const shuffled = aioQuestionSet([...picked].reverse())
  ok('질문 지문 — 순서가 달라도 같은 집합이면 같다', shuffled.hash === set.hash)
  const edited = aioQuestionSet(picked.map((q, i) => (i === 7 ? { ...q, text: `${q.text} ` + '(고침)' } : q)))
  ok('질문 지문 — 문장 하나가 바뀌면 다르다(검색어가 바뀐다)', edited.hash !== set.hash)
  const more = aioQuestionSet([...picked, { questionId: 'c1-099', text: '더한 가짜 질문' }])
  ok('질문 지문 — 문항이 더해지면 다르다', more.hash !== set.hash)
  ok('질문지 글자 — 「v6 · 이름 없는 50문항 #지문 6자」', aioBankLabel('v6', 50, set.hash) === `v6 · 이름 없는 50문항 #${set.hash.slice(0, 6)}`)

  ok('M — 50문항은 110(2n + 2·⌈0.1n⌉)', aioMaxSearches(50) === 110)
  ok('M — 48문항 106 · 57문항 126 · 56문항 124 · 10문항 22 · 1문항 4 · 0문항 0', aioMaxSearches(48) === 106 && aioMaxSearches(57) === 126 && aioMaxSearches(56) === 124 && aioMaxSearches(10) === 22 && aioMaxSearches(1) === 4 && aioMaxSearches(0) === 0)
  ok('다시 검색 상한 — 질문의 10%(올림): 50 → 5 · 48 → 5 · 1 → 1 · 0 → 0', aioReSearchCap(50) === 5 && aioReSearchCap(48) === 5 && aioReSearchCap(1) === 1 && aioReSearchCap(0) === 0)
}

// ── A3. 응답 읽기 — 네 상태 ──────────────────────────────────────────────────────────────────
const shownOf = (r: AioReadResult) => (r.status === 'shown' ? r : null)
{
  const first = readAioFirst(k1First)
  ok('늦게 오는 개요 — page_token만 온 첫 검색은 후속으로(1,534자 그대로)', first.step === 'follow-up' && first.pageToken === TOKEN && first.searchId === 'fake-k1', first.step === 'follow-up' ? first.pageToken.length : first)
  const follow = shownOf(readAioFollowUp(k1Follow))
  ok('늦게 오는 개요 — 후속에서 있음(deferred)', follow !== null && follow.kind === 'deferred' && follow.searchId === 'fake-k1-f', follow)
  const text = follow?.overview.text ?? ''
  ok('본문 — 문단 · 제목 · 목록 · 안쪽 목록 글자가 모두 든다', ['바다와 골목을 함께', '첫째 날 가짜 일정', '오전: 가짜 시장 구경', '가짜 빵집 들르기', '골목 둘', '둘째 날 가짜 일정', '날씨를 미리 보고'].every((s) => text.includes(s)), text)
  ok('본문 — 출처 발췌(references[].snippet)는 넣지 않는다', !text.includes('발췌문'), text)
  ok('본문 — 목록은 「- 」로 줄을 나누고 안쪽 목록은 들여 쓴다', text.split('\n').some((l) => l.startsWith('- 오전: 가짜 시장 구경')) && text.split('\n').some((l) => /^\s+- 가짜 빵집 들르기/.test(l)), text)
  ok('출처 — 10개 모두 http(s) · 번호 · 제목 · 출처 이름', follow?.overview.references.length === 10 && follow.overview.references.every((r) => /^https?:\/\//.test(r.link)) && follow.overview.references[2]!.index === 2 && follow.overview.references[2]!.title === '가짜 블로그 여행기' && follow.overview.references[2]!.source === '가짜출처2', follow?.overview.references)

  const k2 = shownOf(readAioFollowUp(k2Follow))
  ok('출처 없는 개요 — 문단 14개는 있음, 출처는 빈 목록', k2 !== null && k2.overview.references.length === 0 && k2.overview.text.split('\n').length === 14 + 12 - 6, k2?.overview.text.split('\n').length)

  const e1 = shownOf(readAioFollowUp(e1Follow))
  ok('장소 결과 — local_result의 이름도 본문에 남는다(버리지 않음)', e1 !== null && e1.overview.text.includes('Fake Hanok Lodge') && e1.overview.text.includes('A quiet fake lodge'), e1?.overview.text)
  ok('본문 — snippet_links의 글자는 snippet에 이미 있어 두 번 넣지 않는다', e1 !== null && e1.overview.text.split('Fake Hanok Lodge').length === 2, e1?.overview.text)
  ok('본문 — 좌표 · cid · provider 같은 기계 칸은 넣지 않는다', e1 !== null && !e1.overview.text.includes('35.8') && !e1.overview.text.includes('/g/fake') && !e1.overview.text.includes('cid='), e1?.overview.text)
  ok('snippet_links — 링크를 출처 링크로 모은다(http(s)만, 겹침 없이)', e1 !== null && same(e1.overview.links, ['https://www.google.com/maps/fake?entry=1', 'https://hanok.example.org/']), e1?.overview.links)

  const inline = readAioFirst(inlineFirst)
  ok('인라인 — 첫 검색에 본문이 오면 후속 없이 있음(inline)', inline.step === 'done' && inline.read.status === 'shown' && inline.read.kind === 'inline', inline)
  const inlineText = inline.step === 'done' && inline.read.status === 'shown' ? inline.read.overview.text : ''
  ok('펼치기(expandable) — 접힌 문단 글자도 든다', inlineText.includes('더 보기') && inlineText.includes('접힌 문단의 가짜 글'), inlineText)

  const absent = readAioFirst(absentFirst)
  ok('없음 — 검색은 성공했고 ai_overview 키가 없다(실패도 0도 아님)', absent.step === 'done' && absent.read.status === 'absent' && absent.read.noResults === false, absent)
  ok('없음 — 응답 최상위 키 이름만 남긴다(topKeys)', absent.step === 'done' && absent.read.status === 'absent' && same(absent.read.topKeys, Object.keys(absentFirst)), absent)
  const zero = readAioFirst(noResultsFirst)
  ok('결과 0건 — 「없음」(noResults)', zero.step === 'done' && zero.read.status === 'absent' && zero.read.noResults === true, zero)

  const errOnly = readAioFirst({ ...absentFirst, ai_overview: { error: 'AI Overview is not available.' } })
  ok('못 읽음 — ai_overview에 error만', errOnly.step === 'done' && errOnly.read.status === 'unreadable' && errOnly.read.reason === 'overview-error', errOnly)
  const emptyBlock = readAioFirst({ ...absentFirst, ai_overview: { text_blocks: [], references: [] } })
  ok('못 읽음 — 글자도 출처도 하나 없음', emptyBlock.step === 'done' && emptyBlock.read.status === 'unreadable' && emptyBlock.read.reason === 'overview-empty', emptyBlock)
  const blankText = readAioFirst({ ...absentFirst, ai_overview: { text_blocks: [{ type: 'paragraph', snippet: '   ' }] } })
  ok('못 읽음 — 빈 글자만 있는 블록', blankText.step === 'done' && blankText.read.status === 'unreadable' && blankText.read.reason === 'overview-empty', blankText)
  const badShape = readAioFirst({ ...absentFirst, ai_overview: 'oops' })
  ok('못 읽음 — ai_overview 모양이 객체가 아님', badShape.step === 'done' && badShape.read.status === 'unreadable' && badShape.read.reason === 'overview-shape', badShape)
  const refsOnly = readAioFirst({ ...absentFirst, ai_overview: { references: [ref(0, 'https://only.example.com/x', '출처만')] } })
  ok('있음 — 글자가 없어도 출처가 있으면 있음(출처만)', refsOnly.step === 'done' && refsOnly.read.status === 'shown' && refsOnly.read.overview.references.length === 1, refsOnly)

  const atLimit = readAioFirst({ ...k1First, ai_overview: { page_token: tokenOf(AIO_VALUE_MAX) } })
  const overLimit = readAioFirst({ ...k1First, ai_overview: { page_token: tokenOf(AIO_VALUE_MAX + 1) } })
  ok('page_token 상한 — 공용 상한(2048자)까지는 후속으로', AIO_VALUE_MAX === 2048 && atLimit.step === 'follow-up', atLimit.step)
  ok('page_token 상한 — 넘으면 보내지 않고 「못 읽음」(token-too-long)', overLimit.step === 'done' && overLimit.read.status === 'unreadable' && overLimit.read.reason === 'token-too-long', overLimit)
  {
    const src = readFileSync(path.resolve(repo, 'server/serpApi.ts'), 'utf8')
    ok('page_token 상한 — 공용 연결(server/serpApi.ts checkRequest)의 값 길이 상한과 같은 수', src.includes(`v.length > ${AIO_VALUE_MAX}`))
  }
  const both = readAioFirst({ ...k1First, ai_overview: { page_token: TOKEN, text_blocks: [{ type: 'paragraph', snippet: '바로 온 글' }] } })
  ok('page_token과 본문이 함께 오면 후속 없이 인라인', both.step === 'done' && both.read.status === 'shown' && both.read.kind === 'inline', both)

  const notSuccess = readAioFirst({ ...absentFirst, search_metadata: { ...absentFirst.search_metadata, status: 'Error' } })
  ok('오류 — search_metadata.status가 Success가 아니면 오류로 못 잼(다시 보내지 않는 쪽)', notSuccess.step === 'done' && notSuccess.read.status === 'failed' && notSuccess.read.reason === 'not-success', notSuccess)
  const otherErr = readAioFirst({ ...absentFirst, error: 'Something else went wrong.' })
  ok('오류 — 결과 0건 문구가 아닌 error는 오류', otherErr.step === 'done' && otherErr.read.status === 'failed' && otherErr.read.reason === 'upstream-error', otherErr)
  const noMeta = readAioFirst({ ai_overview: { text_blocks: [{ type: 'paragraph', snippet: '메타 없음' }] } })
  const notObj = readAioFirst([1, 2, 3])
  const nul = readAioFirst(null)
  ok('오류 — 메타가 없거나 객체가 아닌 응답은 모양 깨짐(shape)', [noMeta, notObj, nul].every((r) => r.step === 'done' && r.read.status === 'failed' && r.read.reason === 'shape'), [noMeta, notObj, nul])

  const fExpired = readAioFollowUp({ search_metadata: meta('f-x'), ai_overview: { error: 'page_token expired' } })
  const fTopErr = readAioFollowUp({ search_metadata: meta('f-y'), error: 'Invalid page_token.' })
  const fEmpty = readAioFollowUp({ search_metadata: meta('f-z'), search_parameters: { engine: 'google_ai_overview' } })
  const fShape = readAioFollowUp({ nothing: true })
  const fNotOk = readAioFollowUp({ search_metadata: { ...meta('f-w'), status: 'Error' }, ai_overview: { text_blocks: [{ type: 'paragraph', snippet: 'x' }] } })
  const fTokenAgain = readAioFollowUp({ search_metadata: meta('f-v'), ai_overview: { page_token: tokenOf(20) } })
  ok('후속 — 만료(ai_overview.error) · 최상위 error · Success가 아닌 검색은 못 읽음(follow-up-error)', [fExpired, fTopErr, fNotOk].every((r) => r.status === 'unreadable' && r.reason === 'follow-up-error'), [fExpired, fTopErr, fNotOk])
  ok('후속 — Success가 아니면 본문이 와도 있음으로 세지 않는다', fNotOk.status === 'unreadable' && fNotOk.searchId === 'f-w', fNotOk)
  ok('후속 — ai_overview가 없거나 page_token만 다시 오면 못 읽음(follow-up-empty — 또 따라가지 않음)', [fEmpty, fTokenAgain].every((r) => r.status === 'unreadable' && r.reason === 'follow-up-empty'), [fEmpty, fTokenAgain])
  ok('후속 — 메타가 없으면 못 읽음(follow-up-shape)', fShape.status === 'unreadable' && fShape.reason === 'follow-up-shape' && readAioFollowUp(null).status === 'unreadable', fShape)
  ok('못 읽음 · 오류 — 어느 경우도 「있음」 · 「없음」이 되지 않는다(노출 분모 밖)', [errOnly, emptyBlock, badShape, notSuccess, otherErr, noMeta].every((r) => r.step === 'done' && (r.read.status === 'unreadable' || r.read.status === 'failed')))
}

// ── A4. 모르는 type · 출처 거르기 · rawBlock ─────────────────────────────────────────────────────
{
  const lines = flattenTextBlocks([
    { type: 'video_carousel', title: '가짜 영상 묶음', items: [{ title: '가짜 영상 하나', snippet: '영상 설명', link: 'https://v.example.com/1' }] },
    { type: 'table', table: [['항목', '값'], ['체크인', '15시']] },
    { type: 'comparison', product_labels: ['가짜 A', '가짜 B'], comparison: [{ feature: '가격', values: ['싸다', '비싸다'] }] },
    { type: 'brand_new_type', nested: { deeper: { snippet: '깊이 숨은 가짜 글' } }, thumbnail: 'https://t.example.com/x.png' },
    '맨 글자 블록',
    42,
  ])
  const joined = lines.join('\n')
  ok('모르는 type — 제목 · 글자 · 안쪽 항목 글자를 버리지 않는다', ['가짜 영상 묶음', '가짜 영상 하나', '영상 설명', '깊이 숨은 가짜 글', '맨 글자 블록'].every((s) => joined.includes(s)), joined)
  ok('표 · 비교 — 칸 글자를 「 | 」로 한 줄씩', joined.includes('항목 | 값') && joined.includes('체크인 | 15시') && joined.includes('가짜 A | 가짜 B') && joined.includes('가격') && joined.includes('싸다 | 비싸다'), joined)
  ok('모르는 type — 링크 · 썸네일 주소는 본문에 넣지 않는다', !joined.includes('https://'), joined)

  const bad = readAioFollowUp({
    search_metadata: meta('f-refs'),
    ai_overview: {
      text_blocks: [{ type: 'paragraph', snippet: '출처 거르기 가짜' }],
      references: [
        ref(0, 'javascript:alert(1)', '스크립트'),
        ref(1, 'ftp://files.example.com/a', 'ftp'),
        ref(2, '/relative/path', '상대'),
        { index: 3, title: '링크 없음' },
        ref(4, 'https://ok.example.com/a', '좋음'),
        ref(5, `https://long.example.com/${'a'.repeat(AIO_VALUE_MAX)}`, '너무 긴 주소'),
        'not-an-object',
        ref(6, 'http://plain.example.com/b', '평문'),
      ],
    },
  })
  const refs = bad.status === 'shown' ? bad.overview.references.map((r) => r.link) : []
  ok('출처 — http(s)만 받고(javascript · ftp · 상대 · 없음 · 너무 긴 주소 · 객체 아님은 버림)', same(refs, ['https://ok.example.com/a', 'http://plain.example.com/b']), refs)

  const block = {
    text_blocks: [{ type: 'paragraph', snippet: 'x', nested: { page_token: 'p', serpapi_link: 'https://serpapi.com/x', keep: 'y', account_id: 'acct-fake' } }],
    page_token: 'top',
    serpapi_link: 'https://serpapi.com/y',
    api_key: 'should-not-be-here',
    account_email: 'nobody@example.invalid',
    references: [],
  }
  const scrubbed = scrubRawBlock(block)
  const raw = JSON.stringify(scrubbed)
  ok('rawBlock — page_token · serpapi_link · api_key · 계정 칸을 어느 깊이에서든 뺀다', 'rawBlock' in scrubbed && ['page_token', 'serpapi_link', 'api_key', 'account_id', 'account_email', 'acct-fake', 'example.invalid'].every((s) => !raw.includes(s)) && raw.includes('keep'), raw)
  ok('rawBlock — 원본 객체는 고치지 않는다', block.page_token === 'top' && block.text_blocks[0]!.nested.page_token === 'p')
  const huge = scrubRawBlock({ text_blocks: [{ type: 'paragraph', snippet: '가'.repeat(Math.ceil(AIO_RAW_BLOCK_MAX / 3) + 10) }] })
  ok('rawBlock — 64KB(UTF-8)를 넘으면 싣지 않고 rawBlockOmitted', same(huge, { rawBlockOmitted: true }), Object.keys(huge))

  const follow = readAioFollowUp(k1Follow)
  const item = aioItemOf({ questionId: 'c1-001', query: '가짜 군산 1박 2일 코스' }, follow, { fetchedAt: '2026-11-11T01:00:05.000Z', searches: 2 })
  ok('문항 기록 — 있음 · deferred · 본문 · 출처 · links · searchId · 검색 수', item.status === 'shown' && item.kind === 'deferred' && (item.text ?? '').includes('바다와 골목') && item.references?.length === 10 && Array.isArray(item.links) && item.searchId === 'fake-k1-f' && item.searches === 2, item)
  ok('문항 기록 — rawBlock에 page_token · serpapi_link가 없다', !JSON.stringify(item).includes('page_token') && !JSON.stringify(item).includes('serpapi_link'), Object.keys(item))
  ok('문항 기록 — 판정 전에는 mentioned 칸이 없다(판정 불가 null과 다르다)', !('mentioned' in item))
  const long = aioItemOf({ questionId: 'c1-002', query: 'q' }, { status: 'shown', kind: 'inline', searchId: null, overview: { text: '가'.repeat(AIO_TEXT_MAX + 50), references: [], links: [], rawBlock: {} } }, { fetchedAt: '2026-11-11T01:00:06.000Z', searches: 1 })
  ok('문항 기록 — 본문은 16,000자까지 잘라 적고 truncated', long.text?.length === AIO_TEXT_MAX && long.truncated === true, [long.text?.length, long.truncated])
  const absentItem = aioItemOf({ questionId: 'c1-003', query: 'q' }, readAioFirst(absentFirst).step === 'done' ? (readAioFirst(absentFirst) as { read: AioReadResult }).read : follow, { fetchedAt: '2026-11-11T01:00:07.000Z', searches: 1 })
  ok('문항 기록 — 없음은 topKeys만(본문 · 출처 없음)', absentItem.status === 'absent' && Array.isArray(absentItem.topKeys) && absentItem.text === undefined && absentItem.references === undefined, absentItem)
}

// ── A5. 언급 판정 읽기 ─────────────────────────────────────────────────────────────────────────
{
  const yes = readMentionVerdict({ targetBrand: { mentioned: true, mentionCount: 1, mentions: [{ mentionOrder: 1, sentence: '테스트펜션은 조용해요.', sentiment: 'positive', matchedAlias: '테스트펜션' }] }, competitorMentions: [{ name: '경쟁가짜펜션', mentionCount: 2, mentions: [] }, { name: '없는곳', mentionCount: 0, mentions: [] }] })
  ok('판정 — 언급 true · 문장 · 경쟁사(0번 나온 곳은 뺌)', yes.mentioned === true && same(yes.sentences, ['테스트펜션은 조용해요.']) && same(yes.competitors, [{ name: '경쟁가짜펜션', count: 2 }]), yes)
  const no = readMentionVerdict({ targetBrand: { mentioned: false, mentionCount: 0, mentions: [] }, competitorMentions: [] })
  ok('판정 — 언급 false는 false', no.mentioned === false && no.sentences.length === 0)
  const bad = [null, undefined, 'text', {}, { targetBrand: {} }, { targetBrand: { mentioned: 'yes' } }, { targetBrand: null }].map(readMentionVerdict)
  ok('판정 — 못 읽은 응답은 판정 불가 null(false로 세지 않음)', bad.every((v) => v.mentioned === null), bad)
  const longSentence = readMentionVerdict({ targetBrand: { mentioned: true, mentions: Array.from({ length: 30 }, () => ({ sentence: '가'.repeat(900) })) } })
  ok('판정 — 문장은 10개 · 300자까지', longSentence.sentences.length === 10 && longSentence.sentences.every((s) => s.length === 300))
}

// ── A6. 회차 · 지표 · 분모 ────────────────────────────────────────────────────────────────────
const BRAND: AioReadContext = {
  brandName: '테스트펜션',
  aliases: ['시험펜션'],
  ownedDomains: ['fake-stay.example', 'fakestay.tistory.com'],
  competitors: ['경쟁가짜펜션'],
  posts: [],
}
const POST_A = 'https://m.blog.naver.com/fakewriter1/223000000001'
const POST_B = 'https://fake-other.example.net/posts/5'
const POST_C = 'https://fakewriter3.tistory.com/7'
const POST_D = 'https://news.example.com/article/1'
const ledger = [
  { id: 'p-a', url: POST_A, key: trackingKey(POST_A)!, publishedOn: '2026-11-03', publishedOnSource: 'user', recordedAt: '2026-11-03T03:00:00.000Z', articleId: 'topic:a', articleTitle: '가짜 글 A' },
  { id: 'p-a2', url: POST_A, key: trackingKey(POST_A)!, publishedOn: '2026-11-03', publishedOnSource: 'user', recordedAt: '2026-11-03T03:05:00.000Z', articleId: 'topic:a', removedAt: '2026-11-03T03:06:00.000Z', removedReason: 'mistake' },
  { id: 'p-c', url: POST_C, key: trackingKey(POST_C)!, publishedOn: '2026-11-20', publishedOnSource: 'user', recordedAt: '2026-11-20T03:00:00.000Z', articleId: 'topic:c', articleTitle: '가짜 글 C' },
  { id: 'p-d', url: POST_D, key: trackingKey(POST_D)!, publishedOn: '2026-11-01', publishedOnSource: 'user', recordedAt: '2026-11-01T03:00:00.000Z', articleId: 'topic:d', articleTitle: '가짜 글 D', removedAt: '2026-11-05T03:00:00.000Z', removedReason: 'taken-down' },
]
const external = [
  { id: 'x-000000000001', url: POST_B, key: trackingKey(POST_B)!, title: '가짜 손글 B', publishedOn: '2026-11-02', publishedOnSource: 'page' as const, trackedAt: '2026-11-04T01:00:00.000Z' },
  { id: 'x-000000000002', url: POST_A, key: trackingKey(POST_A)!, title: '옮긴 손글', publishedOn: '2026-11-01', publishedOnSource: 'page' as const, trackedAt: '2026-11-02T01:00:00.000Z' },
  { id: 'x-000000000003', url: 'https://mistake.example.com/1', key: trackingKey('https://mistake.example.com/1')!, title: '잘못', publishedOn: '2026-11-01', publishedOnSource: 'page' as const, trackedAt: '2026-11-02T01:00:00.000Z', removedAt: '2026-11-02T02:00:00.000Z', removedReason: 'mistake' as const },
]
const writerOf = (p: { articleId: string }) => (p.articleId === 'topic:a' ? 'w1' : p.articleId === 'topic:c' ? '가짜작성자이름' : null)
const POSTS: AioPost[] = aioPostRows(ledger, external, writerOf)
{
  const keys = POSTS.map((p) => p.key).sort()
  ok('올린 글 — 잘못 적은 줄 · 앱 글로 옮긴 앱 밖 줄 · 잘못 적은 앱 밖 줄은 빼고, 내린 글은 남긴다', same(keys, [trackingKey(POST_A), trackingKey(POST_B), trackingKey(POST_C), trackingKey(POST_D)].sort()), POSTS)
  const a = POSTS.find((p) => p.key === trackingKey(POST_A))
  const b = POSTS.find((p) => p.key === trackingKey(POST_B))
  const c = POSTS.find((p) => p.key === trackingKey(POST_C))
  ok('올린 글 — 앱 글은 origin app · 작성자 w1', a?.origin === 'app' && a.writerKey === 'w1' && a.title === '가짜 글 A', a)
  ok('올린 글 — 앱 밖 글은 origin external · 작성자 없음', b?.origin === 'external' && b.writerKey === null && b.title === '가짜 손글 B', b)
  ok('올린 글 — 작성자 칸에는 w1~w8 꼴만(이름이 오면 싣지 않는다)', c?.writerKey === null && !JSON.stringify(POSTS).includes('가짜작성자이름'), c)
  ok('올린 글 — 앱 글의 올린 시각은 같은 날 「올렸어요」를 누른 시각(postedAtIndex)', a?.postings.some((p) => p.postedAt === '2026-11-03T03:00:00.000Z') === true && b?.postings.every((p) => p.postedAt === null) === true, [a?.postings, b?.postings])
}

const RUN_START = '2026-11-10T01:00:00.000Z'
const SIG = aioConditionSignature(GUNSAN)
const IDS10 = Array.from({ length: 10 }, (_, i) => `c1-${String(i + 1).padStart(3, '0')}`)
const QSET10 = aioQuestionSet(IDS10.map((id) => ({ questionId: id, text: `가짜 질문 ${id}` })))

function item(questionId: string, status: AioItem['status'], extra: Partial<AioItem> = {}): AioItem {
  return { questionId, query: `가짜 질문 ${questionId}`, status, fetchedAt: '2026-11-10T01:05:00.000Z', searches: status === 'shown' ? 2 : 1, ...extra }
}
const refsOf = (...links: string[]) => links.map((link, index) => ({ index, title: `가짜 출처 ${index}`, link, source: `가짜${index}` }))
function mkRun(over: { runId?: string; startedAt?: string; state?: AioRunState; items: AioItem[]; ids?: string[]; location?: string | null; bankVersion?: string; judgeEngine?: string | null }): AioRun {
  const startedAt = over.startedAt ?? RUN_START
  const ids = over.ids ?? IDS10
  const qset = over.ids ? aioQuestionSet(ids.map((id) => ({ questionId: id, text: `가짜 질문 ${id}` }))) : QSET10
  const location = over.location === undefined ? GUNSAN : over.location
  return {
    format: GOOGLE_AIO_FORMAT,
    runId: over.runId ?? aioRunId(new Date(startedAt)),
    tenantId: 'fake-tenant',
    startedAt,
    finishedAt: over.state === 'running' ? null : '2026-11-10T01:10:00.000Z',
    state: over.state ?? 'done',
    stopReason: null,
    conditions: aioConditions({ startedAt, location, bankVersion: over.bankVersion ?? 'v6', questionSet: qset, judgeEngine: over.judgeEngine === undefined ? 'gemini' : over.judgeEngine, judgeModel: null }),
    bankVersion: over.bankVersion ?? 'v6',
    cohortBank: { key: '펜션__전북_군산', version: 'c1' },
    questionSet: qset,
    maxSearches: aioMaxSearches(ids.length),
    cycle: '2026-12-08',
    usage: { searches: 0, followUps: 0, reSearches: 0, judgeCalls: 0, judgeTokens: { input: 0, output: 0, thought: 0 } },
    items: over.items.map((i) => ({ ...i, fetchedAt: i.fetchedAt.slice(0, 10) === startedAt.slice(0, 10) ? i.fetchedAt : new Date(Date.parse(startedAt) + 300_000).toISOString() })),
  }
}
const judged = (m: boolean | null, extra: Partial<AioItem> = {}): Partial<AioItem> => ({ mentioned: m, judgeEngine: 'gemini', judgeModel: 'gemini-fake-1', judgedAt: '2026-11-10T01:06:00.000Z', ...extra })
const R1 = mkRun({
  items: [
    item('c1-001', 'shown', { ...judged(true), text: '테스트펜션을 추천합니다.', references: refsOf('https://fake-stay.example/rooms') }),
    item('c1-002', 'shown', { ...judged(false), text: '가짜 여행 안내.', references: refsOf(POST_A.replace('m.blog', 'blog'), 'https://x.example.com/1') }),
    item('c1-003', 'shown', { ...judged(null), text: '판정 못 한 가짜 개요.' }),
    item('c1-004', 'absent', { topKeys: ['search_metadata'] }),
    item('c1-005', 'absent', { noResults: true }),
    item('c1-006', 'unreadable', { reason: 'follow-up-error' }),
    item('c1-007', 'failed', { reason: 'timeout' }),
    item('c1-008', 'shown', { ...judged(false), text: '가짜 다른 글.', references: refsOf(`${POST_B}?ref=aio`), links: ['https://www.google.com/maps/fake'] }),
    item('c1-009', 'absent'),
    item('c1-010', 'shown', { ...judged(true, { competitorMentions: [{ name: '경쟁가짜펜션', count: 1 }] }), text: '시험펜션과 경쟁가짜펜션.', references: refsOf(POST_D) }),
  ],
})
{
  const s = summarizeAioRun(R1, { ...BRAND, posts: POSTS })
  ok('셈 — 있음 5 · 없음 3 · 못 읽음 1 · 오류 1 · 판정 불가 1 · 출처 없는 개요 1', s.shown === 5 && s.absent === 3 && s.unreadable === 1 && s.failed === 1 && s.judgeUnknown === 1 && s.noSourceList === 1, s)
  ok('노출률 — 있음 ÷ (있음 + 없음) = 5/8(못 읽음 · 오류는 분모에서 뺌)', s.exposure.k === 5 && s.exposure.n === 8 && near(s.exposure.rate, 5 / 8), s.exposure)
  ok('언급 — 판정된 있음만: 2/4(판정 불가 · 없음은 분모에서 뺌)', s.mention.k === 2 && s.mention.n === 4 && near(s.mention.rate, 0.5), s.mention)
  ok('자사 출처 — 출처 목록을 받은 있음만 분모: 1/4', s.ownSource.k === 1 && s.ownSource.n === 4 && s.ownSource.reason === 'ok' && near(s.ownSource.rate, 0.25), s.ownSource)
  ok('올린 글 출처 — 올린 뒤 회차 · 올라가 있던 글만: 1/4(내린 글 D는 세지 않음, 올리기 전 글 C도)', s.postSource.k === 1 && s.postSource.n === 4 && s.postSource.reason === 'ok' && s.postSource.posts === 2, s.postSource)
  ok('올린 글 출처 — 질의만 다른 주소는 따로(variant 1)', s.variantSource === 1, s.variantSource)
  ok('경쟁사 — 판정이 준 이름별 개요 수', same(s.competitors, [{ name: '경쟁가짜펜션', count: 1 }]), s.competitors)
  ok('잰 문항 · 예정 — 8/10', s.measured === 8 && s.planned === 10 && near(s.coverage, 0.8), s)

  const noOwned = summarizeAioRun(R1, { ...BRAND, ownedDomains: [], posts: POSTS })
  ok('자사 출처 — 자사 주소가 없으면 확인 불가(null · 0 아님)', noOwned.ownSource.rate === null && noOwned.ownSource.reason === 'no-owned' && ratioText(noOwned.ownSource) === '확인 불가', noOwned.ownSource)
  const more = summarizeAioRun(R1, { ...BRAND, ownedDomains: [...BRAND.ownedDomains, 'x.example.com'], posts: POSTS })
  ok('자사 출처 — 읽을 때 계산: 자사 주소를 더하면 지난 회차에도 바로 적용(2/4)', more.ownSource.k === 2 && more.ownSource.n === 4, more.ownSource)
  const sub = summarizeAioRun(mkRun({ items: [item('c1-001', 'shown', { ...judged(false), text: 'x', references: refsOf('https://www.FAKE-STAY.example/a#:~:text=%EA%B0%80'), links: [] })] }), BRAND)
  ok('자사 출처 — www · 대소문자 · 「#:~:text=」 붙은 주소도 자사', sub.ownSource.k === 1 && sub.ownSource.n === 1, sub.ownSource)
  const viaLinks = summarizeAioRun(mkRun({ items: [item('c1-001', 'shown', { ...judged(false), text: 'x', references: refsOf('https://x.example.com/1'), links: ['https://fakestay.tistory.com/3'] })] }), BRAND)
  ok('자사 출처 — 본문 안 링크(snippet_links)도 출처로 본다', viaLinks.ownSource.k === 1, viaLinks.ownSource)
  const unreadablePosts = summarizeAioRun(R1, { ...BRAND, posts: null })
  ok('올린 글 출처 — 원장 · 앱 밖 글을 못 읽으면 확인 불가(「0편」 아님)', unreadablePosts.postSource.rate === null && unreadablePosts.postSource.reason === 'posts-unreadable', unreadablePosts.postSource)
  const noPosts = summarizeAioRun(R1, { ...BRAND, posts: [] })
  ok('올린 글 출처 — 그때까지 올린 글이 없으면 확인 불가(올린 글 없음)', noPosts.postSource.rate === null && noPosts.postSource.reason === 'no-posts', noPosts.postSource)
  const noComp = summarizeAioRun(R1, { ...BRAND, competitors: [] })
  ok('경쟁사 — 경쟁사 목록이 없으면 null(「0곳」 아님)', noComp.competitors === null)
  const folded = summarizeAioRun(
    mkRun({ items: [item('c1-001', 'shown', { ...judged(false, { competitorMentions: [{ name: '경쟁 가짜 펜션', count: 1 }] }), text: 'x' })] }),
    { ...BRAND, competitors: ['경쟁가짜펜션', '안나온가짜'] },
  )
  ok('경쟁사 — 판정이 띄어 쓴 이름도 같은 경쟁사로 센다 · 안 나온 경쟁사는 목록에 없다(잰 0)', same(folded.competitors, [{ name: '경쟁가짜펜션', count: 1 }]), folded.competitors)
  const noneJudged = summarizeAioRun(mkRun({ items: [item('c1-001', 'shown', { ...judged(null), text: 'x' }), item('c1-002', 'absent')] }), BRAND)
  ok('경쟁사 — 판정된 개요가 없으면 null(확인 불가)', noneJudged.competitors === null && noneJudged.mention.rate === null && noneJudged.judgeUnknown === 1, noneJudged)

  // 출처 목록 없이 온 개요만 — 출처 분모에 넣지 않는다(「출처 0」으로 세지 않음). 2026-11-10 나라 단위 질문이 이 모양이었다.
  const k2Item = aioItemOf({ questionId: 'c1-001', query: '가짜 한옥 숙소 고르기' }, readAioFollowUp(k2Follow), { fetchedAt: '2026-11-10T01:05:00.000Z', searches: 2 })
  const noList = summarizeAioRun(mkRun({ items: [{ ...k2Item, ...judged(false) }, item('c1-002', 'absent')] }), { ...BRAND, posts: POSTS })
  ok('출처 없는 개요 — 노출 1/2 · 언급 0/1은 세고, 자사 · 올린 글 출처는 분모 0이라 확인 불가(까닭 no-source-list)', noList.exposure.k === 1 && noList.exposure.n === 2 && noList.mention.k === 0 && noList.mention.n === 1 && noList.noSourceList === 1 && noList.ownSource.rate === null && noList.ownSource.n === 0 && noList.ownSource.reason === 'no-source-list' && noList.postSource.rate === null && noList.postSource.reason === 'no-source-list', noList)
  ok('출처 지표 — 있음이 하나도 없으면 까닭은 no-overview', summarizeAioRun(mkRun({ items: [item('c1-001', 'absent')] }), { ...BRAND, posts: POSTS }).ownSource.reason === 'no-overview')

  const dead = summarizeAioRun(mkRun({ items: [item('c1-001', 'unreadable', { reason: 'overview-error' }), item('c1-002', 'failed', { reason: 'timeout' })] }), BRAND)
  ok('분모 0 — 노출 · 언급 · 출처 모두 null, 글자는 「확인 불가」', dead.exposure.rate === null && dead.mention.rate === null && dead.ownSource.rate === null && dead.postSource.rate === null && ratioText(dead.exposure) === '확인 불가' && pctText(dead.mention) === '확인 불가', dead)
  const onlyAbsent = summarizeAioRun(mkRun({ items: [item('c1-001', 'absent'), item('c1-002', 'absent')] }), BRAND)
  ok('없음만 — 노출 0/2(잰 0)는 0, 언급 · 출처는 확인 불가', onlyAbsent.exposure.rate === 0 && onlyAbsent.exposure.n === 2 && onlyAbsent.mention.rate === null && onlyAbsent.ownSource.rate === null && ratioText(onlyAbsent.exposure) === '0/2' && pctText(onlyAbsent.exposure) === '0%', onlyAbsent)
  ok('비율 글자 — k/N과 백분율', ratioText(s.exposure) === '5/8' && pctText(s.mention) === '50%')

  // 같은 날 올린 글 — 앱 글은 「올렸어요」 시각으로 가르고(측정 시작 전 → 올린 뒤, 측정 뒤 → 올리기 전), 앱 밖 글은 올린 시각을 몰라 전후 불명.
  const E = 'https://fakewriter2.tistory.com/1'
  const F = 'https://fakewriter2.tistory.com/2'
  const G = 'https://fake-hand.example.org/g'
  const sameDayPosts = aioPostRows(
    [
      { id: 'p-e', url: E, key: trackingKey(E)!, publishedOn: '2026-11-10', publishedOnSource: 'user', recordedAt: '2026-11-10T00:30:00.000Z', articleId: 'topic:e' },
      { id: 'p-f', url: F, key: trackingKey(F)!, publishedOn: '2026-11-10', publishedOnSource: 'user', recordedAt: '2026-11-10T02:00:00.000Z', articleId: 'topic:f' },
    ],
    [{ id: 'x-000000000009', url: G, key: trackingKey(G)!, title: null, publishedOn: '2026-11-10', publishedOnSource: 'user', trackedAt: '2026-11-09T01:00:00.000Z' }],
    () => 'w2',
  )
  const sameDayRun = mkRun({ items: [E, F, G].map((u, i) => item(IDS10[i]!, 'shown', { ...judged(false), text: 'x', references: refsOf(u) })) })
  const sd = summarizeAioRun(sameDayRun, { ...BRAND, posts: sameDayPosts })
  ok('올린 글 출처 — 같은 날: 측정 시작 전에 올린 앱 글만 센다(측정 뒤 올림 · 올린 시각 모르는 앱 밖 글은 전후 불명이라 뺌)', sd.postSource.posts === 1 && sd.postSource.k === 1 && sd.postSource.n === 3, sd.postSource)
  const sdTable = aioPostTable([sameDayRun], sameDayPosts)
  ok('올린 글 표 — 같은 날 전후 불명 · 올리기 전 회차는 N에 안 든다', same(sdTable.map((r) => [r.runs, r.cited]), [[1, 1], [0, 0], [0, 0]]), sdTable)

  const dup = summarizeAioRun(mkRun({ items: [item('c1-001', 'unreadable', { reason: 'overview-error' }), item('c1-001', 'shown', { ...judged(true), text: 'x', references: refsOf('https://x.example.com/2') })] }), BRAND)
  ok('같은 문항이 두 번 적혀 있으면 마지막 기록 하나만 센다', dup.shown === 1 && dup.unreadable === 0 && dup.exposure.n === 1, dup)

  const only = sourceOnlyOf(R1.items[1]!, BRAND)
  ok('「출처로만 보임」 — 출처가 없으면 false', only === false)
  const srcOnly = sourceOnlyOf(item('c1-002', 'shown', { ...judged(false), text: '이름 없는 가짜 본문', references: [{ index: 0, title: '테스트펜션 후기', link: 'https://r.example.com/1', source: '가짜' }] }), BRAND)
  ok('「출처로만 보임」 — 본문에 이름이 없고 출처 제목에만 있으면 true', srcOnly === true)
  const inText = sourceOnlyOf(item('c1-002', 'shown', { ...judged(true), text: '시험펜션에서 묵어요', references: [{ index: 0, title: '테스트펜션 후기', link: 'https://r.example.com/1', source: '가짜' }] }), BRAND)
  ok('「출처로만 보임」 — 본문에 별칭이 있으면 false', inText === false)
  const gunsan = sourceOnlyOf(item('c1-002', 'shown', { ...judged(false), text: '가짜 본문', references: [{ index: 0, title: '군산 각 지역 가볼 만한 곳', link: 'https://r.example.com/2', source: '가짜' }] }), { ...BRAND, brandName: '군산각', aliases: [] })
  ok('「출처로만 보임」 — 낱말 경계(「군산 각 지역」은 군산각이 아님)', gunsan === false && mentionsWord('군산각에서 먹었어요', '군산각') && !mentionsWord('군산 각 지역', '군산각'))
  const cut = sourceOnlyOf(item('c1-002', 'shown', { ...judged(false), text: '이름 없는 가짜 본문', truncated: true, references: [{ index: 0, title: '테스트펜션 후기', link: 'https://r.example.com/1', source: '가짜' }] }), BRAND)
  ok('「출처로만 보임」 — 잘린 본문에서 이름을 못 찾으면 확인 불가(null)', cut === null)
  ok('「출처로만 보임」 — 있음이 아니면 null', sourceOnlyOf(item('c1-004', 'absent'), BRAND) === null)
  ok('요약 — 「출처로만 보임」 개요 수', summarizeAioRun(mkRun({ items: [item('c1-002', 'shown', { ...judged(false), text: '이름 없는 가짜 본문', references: [{ index: 0, title: '테스트펜션 후기', link: 'https://r.example.com/1', source: '가짜' }] })] }), BRAND).sourceOnly === 1)
}

// ── A7. 요약 회차 · 같은 조건 · 공통 질문 · 추이 ────────────────────────────────────────────
const measuredItems = (n: number, total = 50, ids?: string[]) =>
  (ids ?? Array.from({ length: total }, (_, i) => `c1-${String(i + 1).padStart(3, '0')}`)).map((id, i) => item(id, i < n ? 'absent' : 'unreadable', i < n ? {} : { reason: 'follow-up-error' }))
const IDS50 = Array.from({ length: 50 }, (_, i) => `c1-${String(i + 1).padStart(3, '0')}`)
{
  const done = mkRun({ ids: IDS50, state: 'done', items: measuredItems(10) })
  const p45 = mkRun({ ids: IDS50, state: 'partial', items: measuredItems(45) })
  const p44 = mkRun({ ids: IDS50, state: 'partial', items: measuredItems(44) })
  const running = mkRun({ ids: IDS50, state: 'running', items: measuredItems(50) })
  const cancelled90 = mkRun({ ids: IDS50, state: 'cancelled', items: measuredItems(45) })
  ok('요약 회차 — done은 잰 문항이 적어도 요약에 쓴다', isSummaryRun(done))
  ok('요약 회차 — 일부만 잰 회차는 잰 문항(있음 + 없음)이 예정의 90% 이상일 때만(45/50 예 · 44/50 아니오)', isSummaryRun(p45) && !isSummaryRun(p44) && isSummaryRun(cancelled90))
  ok('요약 회차 — 도는 중인 회차는 쓰지 않는다', !isSummaryRun(running))
  const older = mkRun({ ids: IDS50, startedAt: '2026-11-01T01:00:00.000Z', state: 'done', items: measuredItems(50) })
  const newerBad = mkRun({ ids: IDS50, startedAt: '2026-11-12T01:00:00.000Z', state: 'partial', items: measuredItems(20) })
  ok('요약 회차 — 마지막 쓸 수 있는 회차(뒤의 일부만 잰 회차는 건너뜀)', latestSummaryRun([older, newerBad])?.runId === older.runId && latestSummaryRun([newerBad]) === null)

  // 같은 조건
  const base = mkRun({ startedAt: '2026-11-01T01:00:00.000Z', items: [item('c1-001', 'shown', { ...judged(true), text: 'x' })] })
  const otherLoc = mkRun({ startedAt: '2026-11-02T01:00:00.000Z', location: 'Seoul,South Korea', items: [item('c1-001', 'absent')] })
  const otherBank = mkRun({ startedAt: '2026-11-03T01:00:00.000Z', ids: [...IDS10, 'c1-011'], items: [item('c1-001', 'absent')] })
  const noJudge = mkRun({ startedAt: '2026-11-04T01:00:00.000Z', items: [item('c1-001', 'absent')] })
  const otherJudgeModel = mkRun({ startedAt: '2026-11-05T01:00:00.000Z', items: [item('c1-001', 'shown', { ...judged(false, { judgeModel: 'gemini-fake-2' }), text: 'x' })] })
  const otherJudgeEngine = mkRun({ startedAt: '2026-11-06T01:00:00.000Z', judgeEngine: 'claude', items: [item('c1-001', 'shown', { ...judged(false, { judgeEngine: 'claude', judgeModel: 'claude-fake' }), text: 'x' })] })
  ok('같은 조건 — 위치가 다르면(조건 서명) 수집 모델 바뀜', !aioSameConditions(base, otherLoc) && aioConditionDiffs(base, otherLoc).some((d) => d.dimension === '수집 모델' && d.state === 'changed'), aioConditionDiffs(base, otherLoc))
  ok('같은 조건 — 질문이 더해지면(지문) 질문지 바뀜', !aioSameConditions(base, otherBank) && aioConditionDiffs(base, otherBank).some((d) => d.dimension === '질문지'), aioConditionDiffs(base, otherBank))
  ok('같은 조건 — 판정이 한 번도 없던 회차(개요가 안 뜸)는 판정 모델로 끊지 않는다', aioSameConditions(base, noJudge), aioConditionDiffs(base, noJudge))
  ok('같은 조건 — 판정 모델이 다르면 끊는다', !aioSameConditions(base, otherJudgeModel) && aioConditionDiffs(base, otherJudgeModel).some((d) => d.dimension === '판정 모델'), aioConditionDiffs(base, otherJudgeModel))
  ok('같은 조건 — 판정 엔진이 다르면 끊는다', !aioSameConditions(noJudge, otherJudgeEngine) && aioConditionDiffs(noJudge, otherJudgeEngine).some((d) => d.dimension === '판정 엔진'), aioConditionDiffs(noJudge, otherJudgeEngine))
  ok('같은 조건 — 회차 조건 칸(주차 · aio · 서명 · 판 글자 · 반복 1)', base.conditions.weekOf === '2026-W44' && same(base.conditions.enginesUsed, ['aio']) && base.conditions.modelsUsed.aio === SIG && base.conditions.questionBankVersion === aioBankLabel('v6', 10, QSET10.hash) && base.conditions.repeatsPerQuestion === 1 && base.conditions.location === GUNSAN, base.conditions)

  // 공통 질문만 견줌
  const a = mkRun({ startedAt: '2026-11-01T01:00:00.000Z', items: IDS10.map((id, i) => item(id, i < 5 ? 'shown' : 'absent', i < 5 ? { ...judged(i < 2), text: 'x' } : {})) })
  const b = mkRun({ startedAt: '2026-11-15T01:00:00.000Z', state: 'partial', items: IDS10.slice(0, 4).map((id) => item(id, 'shown', { ...judged(true), text: 'x' })).concat([item('c1-005', 'unreadable', { reason: 'follow-up-error' })]) })
  const cmp = compareAioRuns(a, b)
  ok('회차 비교 — 두 회차 모두에서 잰 질문만(4개) — 노출 4/4 → 4/4', cmp.common === 4 && cmp.exposure[0].k === 4 && cmp.exposure[0].n === 4 && cmp.exposure[1].k === 4 && cmp.exposure[1].n === 4, cmp)
  ok('회차 비교 — 언급은 두 회차 모두 판정된 질문만: 2/4 → 4/4', cmp.mention[0].k === 2 && cmp.mention[0].n === 4 && cmp.mention[1].k === 4 && cmp.mention[1].n === 4, cmp.mention)

  // 질문 표 k/N
  const q1 = mkRun({ startedAt: '2026-11-01T01:00:00.000Z', items: [item('c1-001', 'shown', { ...judged(true), text: 'x' }), item('c1-002', 'shown', { ...judged(null), text: 'x' }), item('c1-003', 'unreadable', { reason: 'follow-up-error' })] })
  const q2 = mkRun({ startedAt: '2026-11-15T01:00:00.000Z', items: [item('c1-001', 'shown', { ...judged(true), text: 'x' }), item('c1-002', 'absent'), item('c1-003', 'unreadable', { reason: 'overview-error' })] })
  const qOther = mkRun({ startedAt: '2026-11-08T01:00:00.000Z', location: null, items: [item('c1-001', 'absent'), item('c1-002', 'absent')] })
  const qRunning = mkRun({ startedAt: '2026-11-16T01:00:00.000Z', state: 'running', items: [item('c1-001', 'absent')] })
  const rows = aioQuestionRows([q2, qOther, q1, qRunning])
  const r1 = rows.rows.find((r) => r.questionId === 'c1-001')!
  const r2 = rows.rows.find((r) => r.questionId === 'c1-002')!
  const r3 = rows.rows.find((r) => r.questionId === 'c1-003')!
  ok('질문 표 — 최신(끝난) 회차와 같은 조건 회차만, 오래된 순(다른 위치 회차 · 도는 회차는 빼고 따로 센다)', same(rows.runIds, [q1.runId, q2.runId]) && rows.otherConditionRuns === 1, rows)
  ok('질문 표 — 노출 k/N: 2/2 · 1/2(못 읽음은 N에 안 듦) · 0/0', r1.exposure.k === 2 && r1.exposure.n === 2 && r2.exposure.k === 1 && r2.exposure.n === 2 && r3.exposure.n === 0 && ratioText(r3.exposure) === '확인 불가', [r1, r2, r3])
  ok('질문 표 — 언급 k/N: 판정된 있음만(2/2 · 0/0)', r1.mention.k === 2 && r1.mention.n === 2 && r2.mention.n === 0, [r1.mention, r2.mention])
  ok('질문 표 — 칸 기호: ● 언급 · ◌ 판정 불가 · — 없음 · ? 못 읽음', same(r1.cells.map((c) => c?.symbol), ['●', '●']) && same(r2.cells.map((c) => c?.symbol), ['◌', '—']) && same(r3.cells.map((c) => c?.symbol), ['?', '?']), [r1.cells, r2.cells, r3.cells])
  ok('칸 기호 — 범례 · aria 글자', AIO_CELL.absent.label === 'AI 개요 없음' && AIO_CELL.failed.symbol === '×' && AIO_CELL['not-mentioned'].symbol === '○' && AIO_CELL['judge-unknown'].label === '판정 불가' && AIO_CELL.unreadable.label.includes('못 읽음'), AIO_CELL)
  ok('칸 — 오류는 ×, 언급 없음은 ○', aioCellOf(item('c1-1', 'failed', { reason: 'timeout' }))?.symbol === '×' && aioCellOf(item('c1-1', 'shown', { ...judged(false), text: 'x' }))?.symbol === '○')

  // 추이 · 노출 급락
  const t = (day: string, shown: number, n = 10) => mkRun({ startedAt: `2026-11-${day}T01:00:00.000Z`, items: IDS10.slice(0, n).map((id, i) => item(id, i < shown ? 'shown' : 'absent', i < shown ? { ...judged(false), text: 'x' } : {})) })
  const T1 = t('01', 5)
  const T2 = t('08', 4)
  const T3 = t('15', 0)
  const T4 = t('22', 3)
  const trend = aioTrend([T4, T2, T1, T3])
  ok('추이 — 같은 조건 · 요약 회차만 오래된 순', same(trend.points.map((p) => p.runId), [T1.runId, T2.runId, T3.runId, T4.runId]), trend)
  ok('노출 급락 — 앞 회차들이 20%를 넘는데 0이면 경고', same(trend.drops, [T3.runId]), trend.drops)
  ok('노출 급락 — 추이 선을 그 회차 앞뒤로 잇지 않는다', same(trend.points.map((p) => p.connectToPrev), [false, true, false, false]), trend.points)
  const low = aioTrend([t('01', 1), t('08', 0)])
  ok('노출 급락 — 앞 회차가 20% 이하면 경고하지 않는다', low.drops.length === 0 && same(low.points.map((p) => p.connectToPrev), [false, true]), low)
  const firstZero = aioTrend([t('01', 0)])
  ok('노출 급락 — 앞 회차가 없으면 경고하지 않는다', firstZero.drops.length === 0)
}

// ── A8. 올린 글 표 · 전체 화면 모델 ───────────────────────────────────────────────────────────
{
  const run1 = mkRun({ startedAt: '2026-11-10T01:00:00.000Z', items: [item('c1-001', 'shown', { ...judged(false), text: 'x', references: refsOf(POST_A) }), item('c1-002', 'shown', { ...judged(false), text: 'x', references: refsOf(POST_C) })] })
  const run2 = mkRun({ startedAt: '2026-11-24T01:00:00.000Z', items: [item('c1-001', 'shown', { ...judged(false), text: 'x', references: refsOf('https://x.example.com/9') }), item('c1-002', 'shown', { ...judged(false), text: 'x', references: refsOf(POST_C) })] })
  const run3 = mkRun({ startedAt: '2026-11-25T01:00:00.000Z', items: [item('c1-001', 'absent')] })
  const table = aioPostTable([run2, run1, run3], POSTS)
  const ra = table.find((r) => r.key === trackingKey(POST_A))!
  const rc = table.find((r) => r.key === trackingKey(POST_C))!
  const rd = table.find((r) => r.key === trackingKey(POST_D))!
  ok('올린 글 표 — 올린 뒤 회차만 N(출처를 받은 개요가 있는 회차): A 1/2 · C 1/1(올리기 전 회차는 N에 안 듦)', ra.cited === 1 && ra.runs === 2 && rc.cited === 1 && rc.runs === 1, [ra, rc])
  ok('올린 글 표 — 내린 뒤 회차는 N에 안 든다(D 0/0)', rd.runs === 0 && rd.cited === 0, rd)
  ok('올린 글 표 — 처음 나온 날 · 작성자는 w 키만', ra.firstCitedOn === '2026-11-10' && rc.firstCitedOn === '2026-11-24' && ra.writerKey === 'w1' && rc.writerKey === null, [ra, rc])

  const view = aioView([run2, run1, run3], { ...BRAND, posts: POSTS }, { unreadableRuns: 2 })
  ok('화면 모델 — 요약은 마지막 요약 회차 · 읽지 못한 회차 수 · 흔들림 안내', view.summary?.runId === run3.runId && view.unreadableRuns === 2 && view.note === AIO_NOISE_NOTE && AIO_NOISE_NOTE === '한 번 측정은 흔들립니다 — 두 번 이상 같은 방향일 때만 판단하세요', view)
  ok('화면 모델 — 회차 목록은 새것부터, 조건이 같은지 · 요약 회차인지', same(view.runs.map((r) => r.runId), [run3.runId, run2.runId, run1.runId]) && view.runs.every((r) => r.sameCondition && r.summaryRun), view.runs)
  ok('화면 모델 — 직전 비교는 공통 질문으로', view.previous?.common === 1, view.previous)
  ok('화면 모델 — 작성자 이름이 없다', !JSON.stringify(view).includes('가짜작성자이름'))
  const empty = aioView([], { ...BRAND, posts: null }, { unreadableRuns: 0 })
  ok('화면 모델 — 회차가 없으면 요약 null · 빈 표', empty.summary === null && empty.runs.length === 0 && empty.questions.rows.length === 0 && empty.trend.points.length === 0 && empty.previous === null, empty)
}

// ── A9. 판정 비용(생각 토큰 포함) ─────────────────────────────────────────────────────────────
{
  const usage = { judgeCalls: 3, judgeTokens: { input: 1_000_000, output: 100_000, thought: 400_000 } }
  ok('판정 비용 — 입력 × 입력 단가 + (출력 + 생각) × 출력 단가', near(judgeCostOf(usage, { inputPerM: 0.3, outputPerM: 2.5 }), 0.3 + 0.5 * 2.5), judgeCostOf(usage, { inputPerM: 0.3, outputPerM: 2.5 }))
  ok('판정 비용 — 단가가 없으면 null(0 아님)', judgeCostOf(usage, undefined) === null && judgeCostOf(usage, { inputPerM: 0.3 }) === null && judgeCostOf(usage, {}) === null)
  ok('판정 비용 — 판정을 했는데 토큰 기록이 없으면 null', judgeCostOf({ judgeCalls: 2, judgeTokens: { input: 0, output: 0, thought: 0 } }, { inputPerM: 1, outputPerM: 1 }) === null)
  ok('판정 비용 — 판정이 0회면 0', judgeCostOf({ judgeCalls: 0, judgeTokens: { input: 0, output: 0, thought: 0 } }, { inputPerM: 1, outputPerM: 1 }) === 0)
}

// ── A10. 이어 재기 · 회차 id · 설정 · 회차 파일 ───────────────────────────────────────────────────
{
  const startedAt = '2026-11-10T15:30:00.000Z' // KST 2026-11-11 00:30
  const part = mkRun({ startedAt, state: 'partial', items: [item('c1-001', 'shown', { ...judged(true), text: 'x' }), item('c1-002', 'absent')] })
  const want = { today: '2026-11-11', signature: SIG, fingerprint: QSET10.hash }
  ok('이어 재기 — 같은 KST 날 · 같은 서명 · 같은 지문이면 된다', aioResumeProblem(part, want) === null, aioResumeProblem(part, want))
  ok('이어 재기 — 남은 문항은 끝 상태가 없는 것만(8개)', same(aioRemaining(part), IDS10.slice(2)))
  ok('이어 재기 — 날이 다르면 거절(other-day)', aioResumeProblem(part, { ...want, today: '2026-11-12' }) === 'other-day')
  ok('이어 재기 — 조건 서명이 다르면 거절(conditions)', aioResumeProblem(part, { ...want, signature: aioConditionSignature(null) }) === 'conditions')
  ok('이어 재기 — 질문 지문이 다르면 거절(questions)', aioResumeProblem(part, { ...want, fingerprint: 'ffffffffffffffff' }) === 'questions')
  ok('이어 재기 — 끝난 회차 · 도는 회차는 거절', aioResumeProblem({ ...part, state: 'done' }, want) === 'not-stopped' && aioResumeProblem({ ...part, state: 'running' }, want) === 'not-stopped')
  ok('이어 재기 — 남은 문항이 없으면 거절(nothing-left)', aioResumeProblem(mkRun({ startedAt, state: 'cancelled', items: IDS10.map((id) => item(id, 'absent')) }), want) === 'nothing-left')
  ok('이어 재기 — 중단 · 끊긴 회차도 된다', aioResumeProblem({ ...part, state: 'cancelled' }, want) === null && aioResumeProblem({ ...part, state: 'interrupted' }, want) === null)

  ok('회차 id — 시작 시각의 : · .를 -로(윈도우 파일 이름)', aioRunId(new Date('2026-11-11T02:03:04.567Z')) === '2026-11-11T02-03-04-567Z' && AIO_RUN_ID.test('2026-11-11T02-03-04-567Z'))
  ok('회차 id — 다른 꼴은 받지 않는다(경로 · 인코딩 · 원래 ISO)', ['..%2F..%2Fx', '../x', '2026-11-11T02:03:04.567Z', '2026-11-11T02-03-04-567Z.json', '', '2026-11-11T02-03-04-567Z/..'].every((s) => !AIO_RUN_ID.test(s)))

  const def = parseAioSettings(undefined)
  ok('설정 — 파일이 없으면 기본: 꺼짐 · 시범 브랜드 web4ai · 위치 덮어쓰기 없음', def.ok && def.settings.enabled === false && same(def.settings.tenants, ['web4ai']) && same(def.settings.locations, {}), def)
  const on = parseAioSettings({ format: 'google-aio-settings/1', enabled: true, tenants: ['web4ai', 'gunsan'], locations: { gunsan: GUNSAN } })
  ok('설정 — 켜짐 · 브랜드 더하기 · 위치 덮어쓰기', on.ok && on.settings.enabled && same(on.settings.tenants, ['web4ai', 'gunsan']) && on.settings.locations.gunsan === GUNSAN, on)
  const badSettings = [{ enabled: 'yes' }, { enabled: true, tenants: 'web4ai' }, { enabled: true, tenants: ['../x'] }, { enabled: true, locations: { web4ai: 5 } }, { enabled: true, locations: { web4ai: '' } }, { enabled: true, locations: { web4ai: 'x'.repeat(201) } }, { enabled: true, locations: { web4ai: 'a\nb' } }, 'text', [1], { format: 'other/9', enabled: true }].map(parseAioSettings)
  ok('설정 — 모양이 틀리면 오류(켜짐으로 짐작하지 않음)', badSettings.every((r) => !r.ok), badSettings)

  const good = parseAioRun(JSON.parse(JSON.stringify(R1)))
  ok('회차 파일 — 쓴 모양 그대로 읽힌다', good.ok && good.run.runId === R1.runId && good.run.items.length === 10, good.ok ? '' : good.error)
  const noCohort = parseAioRun(JSON.parse(JSON.stringify({ ...R1, cohortBank: null, cycle: null, stopReason: 'cancelled', stopMessage: '중단했어요' })))
  ok('회차 파일 — 코호트 질문지 · 결제 주기가 없는(null) 회차도 읽힌다', noCohort.ok, noCohort.ok ? '' : noCohort.error)
  const broken = [
    null,
    { ...R1, format: 'google-aio/9' },
    { ...R1, runId: '../x' },
    { ...R1, state: 'weird' },
    { ...R1, items: [{ questionId: 'c1-001', status: 'maybe' }] },
    { ...R1, items: 'x' },
    { ...R1, questionSet: { ids: 'x' } },
    { ...R1, startedAt: 'not-a-date' },
    { ...R1, conditions: null },
    { ...R1, conditions: { ...R1.conditions, judgeModel: 7 } },
    { ...R1, conditions: { ...R1.conditions, modelsUsed: { aio: 1 } } },
    { ...R1, items: [{ ...R1.items[0]!, references: [{ index: 0, title: 5, link: 'https://x.example.com/1', source: null }] }] },
    { ...R1, items: [{ ...R1.items[0]!, competitorMentions: [{ count: 1 }] }] },
    { ...R1, items: [{ ...R1.items[0]!, text: 12 }] },
    { ...R1, items: [{ ...R1.items[0]!, judgeModel: {} }] },
    { ...R1, items: [{ ...R1.items[0]!, kind: 'later' }] },
    { ...R1, items: [{ ...R1.items[0]!, topKeys: [1] }] },
    { ...R1, items: [{ ...R1.items[0]!, error: { message: 'x' } }] },
    { ...R1, stopMessage: ['x'] },
    { ...R1, cycle: undefined },
    { ...R1, cohortBank: { key: 'x' } },
    { ...R1, cohortBank: undefined },
    { ...R1, usage: { ...R1.usage, judgeTokens: { input: 1, output: 1 } } },
  ].map(parseAioRun)
  ok('회차 파일 — 모양이 틀리면 읽지 못한 회차(숨기지 않고 센다)', broken.every((r) => !r.ok), broken.map((r) => (r.ok ? 'ok' : r.error)))
}

// ── 정적 검사 — 격리 · 순수 ─────────────────────────────────────────────────────────────────────
/** 있어야 하는 AI 개요 모듈. 실행기(server/googleAio.ts)는 다음 커밋에서 생긴다 — 생기면 여기에 더한다. */
const NEW_MODULES = ['src/lib/googleAio.ts']
/** 격리 검사가 지키는 AI 개요 모듈 — 아직 없는 파일은 어느 닫힘에도 들 수 없으니 미리 넣어 둔다(생기는 순간부터 지킨다). */
const GUARDED_MODULES = [...NEW_MODULES, 'server/googleAio.ts']
/**
 * 닫힘(런타임으로 불러오는 모듈을 따라간 전체)에 AI 개요 모듈이 없어야 하는 뿌리 — 점수 · 보고서 · 같은 조건 · 회차 기록 · 사용량, 그리고 AI
 * 개요가 읽기만 하는 원장 · 앱 밖 글 · 발행 현황 · 색인 자동 확인 · 측정 진행 · 판정 엔진 · SerpAPI 공용 연결(거꾸로 불러오면 고리가 생긴다).
 */
const CLOSED_ROOTS = [
  'server/pipeline.ts',
  'server/aggregate.ts',
  'server/scoring.ts',
  'server/store.ts',
  'server/runHistory.ts',
  'server/runSamples.ts',
  'server/publishedHistory.ts',
  'server/usageStats.ts',
  'server/measureAndBake.ts',
  'server/ciSync.ts',
  'server/cohortRank.ts',
  'server/queries.ts',
  'server/portfolio.ts',
  'scripts/ci-measure.ts',
  'scripts/measure-local.ts',
  'src/pages/PeriodicReport.tsx',
  'src/pages/Performance.tsx',
  'src/pages/Dashboard.tsx',
  'src/lib/comparability.ts',
  'src/lib/api.ts',
  'server/publishedPosts.ts',
  'server/externalPosts.ts',
  'server/indexAuto.ts',
  'server/measureTracker.ts',
  'server/serpApi.ts',
  'server/engines/index.ts',
  'server/tenantRegistry.ts',
  'src/lib/publishStatus.ts',
  'src/lib/publishedUrl.ts',
  'src/lib/externalPosts.ts',
  'src/lib/indexAuto.ts',
  'src/lib/questionScope.ts',
  'src/pages/PublishStatus.tsx',
  'src/components/IndexAutoPanel.tsx',
]
const SPEC = /(?:^|\n)\s*(import|export)\s+(type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g
function resolveSpec(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = path.resolve(path.dirname(from), spec.replace(/\.js$/, ''))
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (existsSync(c) && statSync(c).isFile()) return c
  }
  return null
}
/** 런타임 불러오기만(import type · export type은 런타임에 없다). bare는 패키지 · node 모듈 이름 그대로. */
function specsOf(file: string): { rel: string[]; bare: string[] } {
  const rel: string[] = []
  const bare: string[] = []
  for (const m of readFileSync(file, 'utf-8').matchAll(SPEC)) {
    if (m[2]) continue
    const spec = (m[3] ?? m[4])!
    if (!spec.startsWith('.')) {
      bare.push(spec)
      continue
    }
    const r = resolveSpec(file, spec)
    if (r) rel.push(r)
  }
  return { rel, bare }
}
function closureOf(root: string): Set<string> {
  const seen = new Set<string>()
  const stack = [path.resolve(repo, root)]
  while (stack.length > 0) {
    const f = stack.pop()!
    if (seen.has(f)) continue
    seen.add(f)
    stack.push(...specsOf(f).rel)
  }
  return seen
}
{
  const newAbs = NEW_MODULES.map((m) => path.resolve(repo, m))
  ok('정적 검사 — AI 개요 모듈이 있다', newAbs.every((f) => existsSync(f)))
  const missing = CLOSED_ROOTS.filter((r) => !existsSync(path.resolve(repo, r)))
  ok(`정적 검사 — 지키는 모듈이 모두 있다(이름이 바뀌면 여기를 고친다)${missing.length ? `: 없음 ${missing.join(', ')}` : ''}`, missing.length === 0)
  const guardedAbs = GUARDED_MODULES.map((m) => path.resolve(repo, m))
  const leaks = CLOSED_ROOTS.filter((r) => existsSync(path.resolve(repo, r))).flatMap((r) => {
    const c = closureOf(r)
    return guardedAbs.filter((n) => c.has(n)).map((n) => `${r} → ${path.relative(repo, n)}`)
  })
  ok(`정적 검사 — 점수 · 보고서 · 같은 조건 · 회차 기록 · 사용량 · 원장 · 발행 현황 · 색인 모듈은 AI 개요 모듈을 불러오지 않는다${leaks.length ? `: ${leaks.join(', ')}` : ''}`, leaks.length === 0)
  ok('정적 검사 — 검사가 실제로 잡는다(이 시험 스크립트의 닫힘에는 AI 개요 모듈이 있다)', newAbs.every((n) => closureOf('scripts/verify-google-aio.ts').has(n)))
  const resets = guardedAbs.filter((f) => existsSync(f) && /\bresetJudgeHealth\b/.test(readFileSync(f, 'utf8'))).map((f) => path.relative(repo, f))
  ok(`정적 검사 — AI 개요 모듈은 resetJudgeHealth를 부르지도 불러오지도 않는다(브랜드 측정의 판정 차단기를 지우지 않는다)${resets.length ? `: ${resets.join(', ')}` : ''}`, resets.length === 0)

  const lib = path.resolve(repo, 'src/lib/googleAio.ts')
  const libClosure = [...closureOf('src/lib/googleAio.ts')]
  const outsideSrcLib = libClosure.filter((f) => !path.relative(path.resolve(repo, 'src'), f).match(/^(lib|prompts)[\\/]/))
  ok(`순수 — src/lib/googleAio.ts의 닫힘은 src/lib · src/prompts 안뿐(서버 · 화면 모듈 없음)${outsideSrcLib.length ? `: ${outsideSrcLib.map((f) => path.relative(repo, f)).join(', ')}` : ''}`, outsideSrcLib.length === 0)
  const bareIn = libClosure.flatMap((f) => specsOf(f).bare.map((b) => `${path.relative(repo, f)} → ${b}`))
  ok(`순수 — 닫힘 어디에도 패키지 · node 모듈 import가 없다${bareIn.length ? `: ${bareIn.join(', ')}` : ''}`, bareIn.length === 0)
  const src = readFileSync(lib, 'utf8')
  ok('순수 — 네트워크를 부르지 않는다(fetch · XMLHttpRequest · WebSocket · EventSource 없음)', !/\b(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/.test(src) && !/new\s+(XMLHttpRequest|WebSocket|EventSource)\b/.test(src))
  const relSpecs = [...src.matchAll(SPEC)].filter((m) => !m[2]).map((m) => (m[3] ?? m[4])!).filter((s) => s.startsWith('.'))
  ok(`서버가 불러올 모듈 — 상대 런타임 import는 .js로 끝난다(Vercel · 묶음 규칙)${relSpecs.filter((s) => !s.endsWith('.js')).join(', ')}`, relSpecs.length > 0 && relSpecs.every((s) => s.endsWith('.js')), relSpecs)
  ok('순수 — 디버그 출력이 없다(console.log)', !/console\.log\(/.test(src))
  const em = readFileSync(path.resolve(repo, 'src/lib/aeo/entityMatch.ts'), 'utf8')
  ok('entityMatch — mentionsWord만 내보내고 런타임 import가 없다(서버 묶음에 화면 코드가 딸려 오지 않게)', /export function mentionsWord\(text: string, name: string\): boolean/.test(em) && specsOf(path.resolve(repo, 'src/lib/aeo/entityMatch.ts')).rel.length === 0)
}

ok('A부는 fetch를 한 번도 부르지 않았다(진짜 SerpAPI · LLM 0회)', fetchCalls.length === 0, fetchCalls)

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
