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
 * C. 실행기(server/googleAio.ts, 같은 프로세스) — 이 프로세스의 env를 가짜로 정한 뒤 불러온다(임시 APP_DATA_DIR · 가짜 키 · 가짜 SerpAPI
 *    127.0.0.1:4198 · 목 엔진 · LLM 키 비움). 판정 · 검색을 주입해 판정 불가 null · 판정 3번 잇따라 실패면 'partial' · 생각 토큰 · 다시 판정 검색 0을,
 *    진짜 공용 연결(serpSearch)과 가짜 SerpAPI로 멈춤 규칙(401 · 403 · 429 두 가지 · 400 · 시간 초과 · 5xx 3번 잇따름 · 계정 바닥 · 몫 · 시간당 ·
 *    최대 검색 수 M · 중단 · 긴 page_token · 못 읽음 다시 검색 10% · 후속 400 · 만료)을 가짜 서버가 받은 수와 장부 sent로 본다. 계획 → 실행 사이
 *    다시 보기(측정 중 · 이 PC 꺼짐 · 질문지 바뀜 · 몫 모자람 — 검색 0 · 잠금 놓음)도 본다.
 * B. 라우트(앱 서버 127.0.0.1:4199를 띄움 — DOTENV_CONFIG_PATH는 없는 파일, serpapi.com · LLM 공급자로 가는 fetch는 --import 가드가 막음) —
 *    계획(검색 0) → 실행(202) → 진행(메모리, 가벼운 GET) → 결과 · 회차 상세(자사 · 올린 글 출처는 읽을 때 계산, 작성자는 w1~w8만) · 다시
 *    판정(검색 0) · 중단 · 이어 재기 · Host/Origin 403 · JSON만(415) · 회차 id 400 · 고객 브랜드만(404) · 409(이 PC 꺼짐 · 시범 아님 · 몫 ·
 *    도는 중 · 다른 창 · 색인 자동 확인과 서로) · 질문지 없음(동봉본 복사 없음) · 판정 엔진 키 없음 · SerpAPI 키 없음 · 끊긴 회차(GET은 바꾸지
 *    않고 다음 시작 때 한 번 고침) · 격리(브랜드 데이터 · 이 PC 상태 파일 · 코호트 질문지 바이트 같음 · GET /api/usage 같음) · 가짜 키(원문 ·
 *    인코딩)와 가짜 작성자 이름이 응답 · 회차 파일 · 장부 · 서버 로그 어디에도 없음.
 *
 *   npx tsx scripts/verify-google-aio.ts
 */
import { execSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
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
  aioPostsUpDuring,
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
  aioSourceMarks,
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
import { addDays } from '../src/lib/publishStatus'
import { parseWriterPlan } from '../src/lib/probePlan'
import { todayKst, trackingKey } from '../src/lib/publishedUrl'
import type { AioJudgeFn, AioSearchFn, GoogleAioPlanView, GoogleAioRunDetail, GoogleAioStatusView } from '../server/googleAio'
import type { TenantConfig } from '../server/types'

// 안전 — 이 프로세스의 fetch는 127.0.0.1만 나간다(그 밖은 막고 기록한다). A부는 fetch를 부르지 않는다.
const fetchCalls: string[] = []
const blockedHosts: string[] = []
const realFetch = globalThis.fetch
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  fetchCalls.push(href.split('?')[0]!)
  const host = URL.canParse(href) ? new URL(href).hostname : ''
  if (host !== '127.0.0.1') {
    blockedHosts.push(host || '(주소 아님)')
    return Promise.reject(new Error('verify guard: 127.0.0.1 밖으로 나가는 요청을 막았습니다'))
  }
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

  const up1 = aioPostsUpDuring(run1, POSTS).map((p) => p.key).sort()
  ok('회차 상세 — 그 회차 때 올린 뒤 · 올라가 있던 글만(A · B — C는 올리기 전, D는 내린 뒤)', same(up1, [trackingKey(POST_A), trackingKey(POST_B)].sort()), up1)
  const marks = aioSourceMarks(
    item('c1-001', 'shown', { ...judged(false), text: 'x', references: refsOf(POST_A, 'https://rooms.fake-stay.example/1', `${POST_B}?ref=aio`, POST_C), links: ['https://www.google.com/maps/fake'] }),
    BRAND.ownedDomains,
    aioPostsUpDuring(run1, POSTS),
  )
  ok(
    '회차 상세 — 출처마다 자사(하위 도메인) · 올린 글(작성자 키) · 질의만 다른 주소 · 본문 링크를 읽을 때 표시',
    marks.length === 5 &&
      marks[0]!.post?.writerKey === 'w1' && marks[0]!.post.origin === 'app' && !marks[0]!.owned &&
      marks[1]!.owned && marks[1]!.post === null &&
      marks[2]!.variant && marks[2]!.post === null &&
      marks[3]!.post === null && !marks[3]!.variant &&
      marks[4]!.kind === 'link' && !marks[4]!.owned && marks[4]!.title === null,
    marks,
  )
  ok('회차 상세 — 자사 주소 칸이 비면 자사 표시 없음', aioSourceMarks(item('c1-001', 'shown', { references: refsOf('https://fake-stay.example/a') }), [], []).every((m) => !m.owned))

  const view = aioView([run2, run1, run3], { ...BRAND, posts: POSTS }, { unreadableRuns: 2 })
  ok('화면 모델 — 요약은 마지막 요약 회차 · 읽지 못한 회차 수 · 흔들림 안내', view.summary?.runId === run3.runId && view.unreadableRuns === 2 && view.note === AIO_NOISE_NOTE && AIO_NOISE_NOTE === '한 번 측정은 흔들립니다 — 두 번 이상 같은 방향일 때만 판단하세요', view)
  ok('화면 모델 — 회차 목록은 새것부터, 조건이 같은지 · 요약 회차인지', same(view.runs.map((r) => r.runId), [run3.runId, run2.runId, run1.runId]) && view.runs.every((r) => r.sameCondition && r.summaryRun), view.runs)
  ok('화면 모델 — 직전 비교는 공통 질문으로', view.previous?.common === 1, view.previous)
  ok('화면 모델 — 작성자 이름이 없다', !JSON.stringify(view).includes('가짜작성자이름'))
  const stopped = { ...mkRun({ startedAt: '2026-11-26T01:00:00.000Z', state: 'partial', items: [item('c1-001', 'absent')] }), stopReason: 'streak', stopMessage: '가짜 멈춘 까닭' }
  const mixed = mkRun({ startedAt: '2026-11-27T01:00:00.000Z', items: [item('c1-001', 'shown', { ...judged(true), text: 'x' }), item('c1-002', 'shown', { ...judged(false, { judgeEngine: 'claude' }), text: 'x' })] })
  const rows = aioView([stopped, mixed, run1], { ...BRAND, posts: POSTS }, { unreadableRuns: 0 }).runs
  const rowOf = (id: string) => rows.find((r) => r.runId === id)
  ok(
    '화면 모델 — 회차 줄에 멈춘 까닭 · 최대 검색 수 · 판정 엔진(문항 기록 — 섞이면 a+b, 판정이 없으면 시작 때 엔진)',
    rowOf(stopped.runId)?.stopReason === 'streak' && rowOf(stopped.runId)?.stopMessage === '가짜 멈춘 까닭' && rowOf(stopped.runId)?.maxSearches === aioMaxSearches(10) &&
      rowOf(stopped.runId)?.judgeEngine === 'gemini' && rowOf(mixed.runId)?.judgeEngine === 'claude+gemini' && rowOf(run1.runId)?.stopMessage === null && rowOf(run1.runId)?.judgeEngine === 'gemini',
    rows.map((r) => ({ id: r.runId, stopReason: r.stopReason, stopMessage: r.stopMessage, judgeEngine: r.judgeEngine, maxSearches: r.maxSearches })),
  )
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
/** 있어야 하는 AI 개요 모듈 — 순수 규칙과 실행기. */
const NEW_MODULES = ['src/lib/googleAio.ts', 'server/googleAio.ts']
/** 격리 검사가 지키는 AI 개요 모듈. */
const GUARDED_MODULES = [...NEW_MODULES]
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
  ok('정적 검사 — 대조: 앱 서버(server/index.ts)의 닫힘에는 실행기와 순수 규칙이 있다(라우트가 실제로 묶인다)', newAbs.every((n) => closureOf('server/index.ts').has(n)))
  const runner = path.resolve(repo, 'server/googleAio.ts')
  const runnerSrc = existsSync(runner) ? readFileSync(runner, 'utf8') : ''
  const runnerSpecs = existsSync(runner) ? [...runnerSrc.matchAll(SPEC)].map((m) => (m[3] ?? m[4])!).filter((s) => s.startsWith('.')) : []
  ok(`실행기 — 상대 import는 모두 .js로 끝난다(Vercel · 묶음 규칙)${runnerSpecs.filter((s) => !s.endsWith('.js')).join(', ')}`, runnerSpecs.length > 0 && runnerSpecs.every((s) => s.endsWith('.js')), runnerSpecs)
  ok('실행기 — 디버그 출력(console.log)이 없고 작성자 이름 칸(writer.name · writerLabel · buildTenantStatus)을 쓰지 않는다', runnerSrc.length > 0 && !/console\.log\(/.test(runnerSrc) && !/writer\.name|writerLabel|buildTenantStatus/.test(runnerSrc))
  ok('실행기 — 시험 전용 env 이름을 새로 읽지 않는다(process.env 읽기는 판정 엔진 키 확인뿐 — 이름을 적어 읽는 곳이 없다)', runnerSrc.length > 0 && !/process\.env\.[A-Za-z_]|process\.env\[\s*['"`]/.test(runnerSrc), [...runnerSrc.matchAll(/process\.env[^\s;)]*/g)].map((m) => m[0]))
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

// ══ B · C 공통 — 가짜 SerpAPI(127.0.0.1:4198) ════════════════════════════════════════════════════
const MOCK_PORT = 4198
const APP_PORT = 4199
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`
const APP_BASE = `http://127.0.0.1:${APP_PORT}`
const FAKE_KEY = `test-serp-${randomBytes(6).toString('hex')}`
const WRITER_NAME = '가짜작성자이름'
const CYCLE = '2026-12-08'
/** C(같은 프로세스)의 검색 시간 초과 — 'slow'는 이보다 늦게 답한다. */
const C_TIMEOUT_MS = 600
/** B(띄운 서버)의 검색 시간 초과 — 'slowok'은 이보다 일찍 답한다. */
const B_TIMEOUT_MS = 2500
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(MOCK_BASE) || !FAKE_KEY.startsWith('test-serp-')) {
  console.error('가짜 SerpAPI 주소(127.0.0.1) · 가짜 키가 아니라 시작하지 않습니다.')
  process.exit(1)
}
const portFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
const dirC = mkdtempSync(path.join(tmpdir(), 'verify-google-aio-c-'))
const dirB = mkdtempSync(path.join(tmpdir(), 'verify-google-aio-b-'))
const seedB = mkdtempSync(path.join(tmpdir(), 'verify-google-aio-seed-'))
const removeDirs = () => {
  for (const d of [dirC, dirB, seedB]) rmSync(d, { recursive: true, force: true })
}
/** 띄운 앱 서버(B) — 시험이 중간에 멈춰도(예외 · 실패) 끄고 임시 폴더를 지운다. */
const children: ChildProcess[] = []
process.on('exit', () => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill()
  removeDirs()
})
for (const port of [MOCK_PORT, APP_PORT]) {
  if (!(await portFree(port))) {
    console.error(`포트 ${port}을 다른 프로그램이 쓰고 있어 확인하지 못했습니다.`)
    removeDirs()
    process.exit(1)
  }
}

const account = (over: Record<string, unknown> = {}) => ({
  account_id: 'acct-fake-aio',
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
  plan_renewal_date: CYCLE,
  ...over,
})
interface Seen {
  path: string
  engine: string | null
  q: string | null
  token: string | null
  keyOk: boolean
  params: Record<string, string>
  at: number
}
const seen: Seen[] = []
let accountBody: Record<string, unknown> = account()
const searchesSeen = () => seen.filter((s) => s.path === '/search.json')
const tokens = new Map<string, string>()
const qCount = new Map<string, number>()
const issueToken = (q: string, len = 1500) => {
  const t = `t${tokens.size + 1}-${'Ab0-_Zx9'.repeat(Math.ceil(len / 8) + 1)}`.slice(0, len)
  tokens.set(t, q)
  return t
}
/** 질문 문장 「가짜 질문 <종류> <번호>」의 종류 — 가짜 서버가 이 글자로 답을 고른다. */
const kindOf = (q: string) => /^가짜 질문 (\S+)/.exec(q)?.[1] ?? ''
const inlineB = {
  search_metadata: meta('fake-inline-b'),
  search_parameters: { engine: 'google', q: '가짜', google_domain: 'google.co.kr', hl: 'ko', gl: 'kr', device: 'desktop' },
  ai_overview: {
    text_blocks: [{ type: 'paragraph', snippet: '뷰성형외과는 조용한 가짜 병원이에요. 강남성형A도 가까워요.', reference_indexes: [0, 1] }],
    references: [ref(0, 'https://fake-view.example/about', '가짜 소개'), ref(1, 'https://fake-hand.example.net/posts/5', '가짜 손글')],
  },
}
const LONG_TEXT = '뷰성형외과 가짜 긴 본문 문장입니다. '.repeat(1200)
const bigInline = { ...inlineB, ai_overview: { text_blocks: [{ type: 'paragraph', snippet: LONG_TEXT }], references: [ref(0, 'https://fake-view.example/long', '가짜 긴 글')] } }
const errOnly = { search_metadata: meta('fake-err-only'), search_parameters: { engine: 'google', q: '가짜' }, ai_overview: { error: 'An error occurred while fetching the AI Overview.' } }
const deferredFirst = (q: string, len?: number) => ({
  ...k1First,
  search_parameters: { ...k1First.search_parameters, q },
  ai_overview: { page_token: issueToken(q, len), serpapi_link: 'https://serpapi.com/search.json?engine=google_ai_overview&page_token=x' },
})
type Reply = { status: number; body: unknown; delayMs?: number }
function firstReply(q: string, n: number): Reply {
  switch (kindOf(q)) {
    case 'inline':
      return { status: 200, body: inlineB }
    case 'big':
      return { status: 200, body: bigInline }
    case 'refsonly':
      return { status: 200, body: { ...inlineB, ai_overview: { references: [ref(0, 'https://fake-view.example/only', '가짜 출처만')] } } }
    case 'deferred':
    case 'norefs':
    case 'expired':
    case 'f400':
    case 'fslow':
      return { status: 200, body: deferredFirst(q) }
    case 'longtoken':
      return { status: 200, body: deferredFirst(q, AIO_VALUE_MAX + 1) }
    case 'noresults':
      return { status: 200, body: noResultsFirst }
    case 'erronce':
      return { status: 200, body: n === 1 ? errOnly : inlineB }
    case 'errtwice':
      return { status: 200, body: errOnly }
    case 'k401':
      return { status: 401, body: { error: 'Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key' } }
    case 'k403':
      return { status: 403, body: { error: 'This account is not allowed to use this API.' } }
    case 'k429m':
      return { status: 429, body: { error: 'Your account has run out of searches.' } }
    case 'k429h':
      return { status: 429, body: { error: 'Your account has exceeded the hourly throughput limit.' } }
    case 'k400':
      return { status: 400, body: { error: 'Missing query `q` parameter.' } }
    case 'e500':
      return { status: 500, body: { error: 'Internal error.' } }
    case 'slow':
      return { status: 200, body: absentFirst, delayMs: C_TIMEOUT_MS + 900 }
    case 'slowok':
      return { status: 200, body: absentFirst, delayMs: 1200 }
    default:
      return { status: 200, body: absentFirst }
  }
}
function followReply(q: string): Reply {
  switch (kindOf(q)) {
    case 'deferred':
      return { status: 200, body: k1Follow }
    case 'norefs':
      return { status: 200, body: k2Follow }
    case 'f400':
      return { status: 400, body: { error: 'Invalid page_token.' } }
    case 'fslow':
      return { status: 200, body: k1Follow, delayMs: C_TIMEOUT_MS + 900 }
    default:
      return { status: 200, body: { search_metadata: meta('fake-expired', { status: 'Error' }), error: 'This page_token has expired.' } }
  }
}
const mock = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', MOCK_BASE)
  const p = url.searchParams
  const s: Seen = { path: url.pathname, engine: p.get('engine'), q: p.get('q'), token: p.get('page_token'), keyOk: p.get('api_key') === FAKE_KEY, params: Object.fromEntries(p.entries()), at: Date.now() }
  seen.push(s)
  const reply = (r: Reply) => {
    const send = () => {
      if (res.writableEnded || res.destroyed) return
      res.writeHead(r.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(r.body))
    }
    if (!r.delayMs) return send()
    const t = setTimeout(send, r.delayMs)
    res.on('close', () => clearTimeout(t))
  }
  if (s.path === '/account.json') return reply({ status: 200, body: accountBody })
  if (s.path !== '/search.json') return reply({ status: 404, body: { error: 'not found' } })
  if (s.engine === 'google_ai_overview') return reply(followReply(tokens.get(s.token ?? '') ?? ''))
  const q = s.q ?? ''
  if (q.startsWith('site:')) return reply({ status: 200, body: { search_metadata: { status: 'Success' }, organic_results: [] }, delayMs: 1500 })
  const n = (qCount.get(q) ?? 0) + 1
  qCount.set(q, n)
  return reply(firstReply(q, n))
})
await new Promise<void>((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve))
const writeJson = (p: string, v: unknown) => {
  mkdirSync(path.dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(v, null, 2))
}
const qsOf = (kinds: string[], prefix = 'c1') => kinds.map((k, i) => ({ questionId: `${prefix}-${String(i + 1).padStart(3, '0')}`, text: `가짜 질문 ${k} ${i + 1}` }))
const bankOf = (version: string, items: { questionId: string; text: string; category?: string; probe?: boolean; containsBrandName?: boolean }[], extra: Record<string, unknown> = {}) => ({
  version,
  generatedAt: '2026-11-01T00:00:00.000Z',
  questions: items.map((q) => ({ industry: '가상업종', region: '전북 군산', containsBrandName: false, version, category: 'category-agnostic', ...q })),
  ...extra,
})
const ledgerSent = (file: string): number => {
  if (!existsSync(file)) return 0
  const j = JSON.parse(readFileSync(file, 'utf8')) as { cycles?: Record<string, { aio?: { sent?: number } }> }
  return j.cycles?.[CYCLE]?.aio?.sent ?? 0
}
const errOf = (p: Promise<unknown>) => p.then(
  () => null,
  (e: { status?: number; code?: string | null; message?: string }) => e,
)

// ══ C. 실행기 — 같은 프로세스(env를 가짜로 정한 뒤 불러온다) ════════════════════════════════════════
Object.assign(process.env, {
  APP_DATA_DIR: dirC,
  DOTENV_CONFIG_PATH: path.join(dirC, 'no-such.env'),
  SERPAPI_API_KEY: FAKE_KEY,
  SERPAPI_LIVE: '',
  SERPAPI_BASE_URL: MOCK_BASE,
  SERPAPI_TIMEOUT_MS: String(C_TIMEOUT_MS),
  USE_MOCK_ENGINES: 'true',
  GEMINI_API_KEY: '',
  OPENAI_API_KEY: '',
  ANTHROPIC_API_KEY: '',
  PERPLEXITY_API_KEY: '',
  JUDGE_ENGINE: '',
})
const BRAND_C = {
  brandName: '뷰성형외과',
  aliases: ['뷰성형'],
  ownedDomains: ['fake-view.example'],
  competitors: [{ name: '강남성형A', aliases: [], domains: [] }],
  industry: '가상업종',
  region: '전북 군산',
}
const TENANT_C = { tenantId: 'vaio-c', ...BRAND_C, engines: ['gemini'], questionBankSize: 3, questionBankVersion: 'v1', repeatsPerQuestion: 1, factGraph: [] } as unknown as TenantConfig
const SETTINGS_C = path.join(dirC, 'google-aio-settings.json')
const BANK_C = path.join(dirC, 'data', 'vaio-c', 'question-bank', 'v1.json')
const C_QS = qsOf(['inline', 'absent', 'deferred'])
writeJson(SETTINGS_C, { format: 'google-aio-settings/1', enabled: true, tenants: ['vaio-c'] })
writeJson(BANK_C, bankOf('v1', C_QS))
const LEDGER_C = path.join(dirC, 'serpapi-usage.json')
const aio = await import('../server/googleAio')
const serp = await import('../server/serpApi')
const tracker = await import('../server/measureTracker')

const OK_TEXT = JSON.stringify({ targetBrand: { mentioned: true, mentionCount: 1, mentions: [{ mentionOrder: 1, sentence: '뷰성형외과는 조용한 가짜 병원이에요.', sentiment: 'neutral' }] }, competitorMentions: [{ name: '강남성형A', mentionCount: 1, mentions: [] }] })
const judgeOk: AioJudgeFn = async () => ({ text: OK_TEXT, citations: [], usedWebSearch: false, model: 'fake-judge-1', inputTokens: 100, outputTokens: 20, thoughtTokens: 30 })
const judgeThrow: AioJudgeFn = async () => {
  throw new Error('가짜 판정 실패')
}
let injectedCalls = 0
/** 주입 검색 — 가짜 서버를 거치지 않고 같은 답을 바로 준다(판정 시험용, 1초 간격 없음). */
const injected: AioSearchFn = async (params) => {
  injectedCalls += 1
  const r = params.engine === 'google_ai_overview' ? followReply(tokens.get(params.page_token ?? '') ?? '') : firstReply(params.q ?? '', 1)
  return { json: r.body as Record<string, unknown> }
}
async function core(kinds: string[], opts: { judge?: AioJudgeFn; search?: AioSearchFn; maxSearches?: number; cancelAt?: number; cancelled?: () => boolean; account?: Record<string, unknown>; ledger?: unknown; pilotOn?: () => Promise<boolean> } = {}) {
  accountBody = account(opts.account)
  if (opts.ledger !== undefined) writeFileSync(LEDGER_C, JSON.stringify(opts.ledger))
  await serp.serpAccount({ fresh: true })
  await sleep(3)
  const questions = qsOf(kinds)
  const run = aio.newAioRun({ tenantId: 'vaio-c', startedAt: new Date(), location: GUNSAN, bankVersion: 'v1', cohortBank: null, questions, maxSearches: opts.maxSearches, cycle: CYCLE, judgeEngine: 'fake-judge' })
  const before = searchesSeen().length
  const sentBefore = ledgerSent(LEDGER_C)
  const release = opts.search ? null : await serp.claimSerpRun('aio')
  if (!opts.search && !release) throw new Error('실행 잠금을 잡지 못했습니다')
  try {
    const out = await aio.executeAioRun(run, questions, BRAND_C, {
      search: opts.search,
      judge: opts.judge ?? judgeOk,
      judgeEngine: 'fake-judge',
      cancelled: () => (opts.cancelled?.() ?? false) || (opts.cancelAt !== undefined && run.items.length >= opts.cancelAt),
      pilotOn: opts.pilotOn,
    })
    return { run: out, requests: searchesSeen().slice(before), sent: ledgerSent(LEDGER_C) - sentBefore }
  } finally {
    await release?.()
  }
}
const shownItems = (r: AioRun) => r.items.filter((i) => i.status === 'shown')

// ── C1. 판정 — 판정 불가 null · 3번 잇따라 실패면 멈춤 · 생각 토큰 · 자르기 전 본문 ─────────────────────────────
{
  injectedCalls = 0
  const r1 = await core(['inline', 'absent', 'inline', 'inline', 'inline'], { search: injected, judge: judgeThrow })
  ok('C 판정 — 판정이 실패하면 mentioned null(미언급 false로 세지 않는다)', shownItems(r1.run).length === 3 && shownItems(r1.run).every((i) => i.mentioned === null), r1.run.items)
  ok(
    'C 판정 — 3번 잇따라 실패하면 검색을 멈춘다(partial · judge) — 남은 질문은 보내지 않는다',
    r1.run.state === 'partial' && r1.run.stopReason === 'judge' && injectedCalls === 4 && r1.run.items.length === 4 && r1.run.usage.judgeCalls === 3 && /판정 엔진/.test(r1.run.stopMessage ?? ''),
    { state: r1.run.state, stop: r1.run.stopReason, injectedCalls, usage: r1.run.usage },
  )
  const seq = ['', '판정 답이 아닌 글', OK_TEXT, '', OK_TEXT]
  let k = 0
  const seqJudge: AioJudgeFn = async () => ({ text: seq[k++] ?? '', citations: [], usedWebSearch: false, model: 'fake-judge-1', inputTokens: 10, outputTokens: 2, thoughtTokens: 3 })
  const r2 = await core(['inline', 'inline', 'inline', 'inline', 'inline'], { search: injected, judge: seqJudge })
  ok(
    'C 판정 — 빈 답 · 못 읽는 답은 null, 성공하면 잇따름을 되돌린다(멈추지 않음)',
    same(r2.run.items.map((i) => i.mentioned), [null, null, true, null, true]) && r2.run.state === 'done' && r2.run.usage.judgeCalls === 5,
    { m: r2.run.items.map((i) => i.mentioned), state: r2.run.state },
  )
  ok('C 판정 — 생각 토큰을 따로 센다(입력 · 출력 · 생각)', same(r2.run.usage.judgeTokens, { input: 50, output: 10, thought: 15 }), r2.run.usage.judgeTokens)
  ok(
    'C 판정 — 판정 엔진(주입한 id) · 모델(결과가 실어 온 값)을 문항 · 조건에 적는다',
    r2.run.items.every((i) => i.judgeEngine === 'fake-judge' && i.judgeModel === 'fake-judge-1' && typeof i.judgedAt === 'string') && r2.run.conditions.judgeEngine === 'fake-judge' && r2.run.conditions.judgeModel === 'fake-judge-1',
    r2.run.conditions,
  )
  ok('C 판정 — 경쟁사 · 언급 문장을 함께 적는다', same(r2.run.items[2]?.competitorMentions, [{ name: '강남성형A', count: 1 }]) && r2.run.items[2]?.mentionSentences?.length === 1, r2.run.items[2])
  let promptLen = 0
  const lenJudge: AioJudgeFn = async (prompt) => {
    promptLen = prompt.user.length
    return judgeOk(prompt)
  }
  const r3 = await core(['big'], { search: injected, judge: lenJudge })
  ok('C 판정 — 판정은 자르기 전 전체 본문으로, 회차 파일에는 16,000자까지(잘림 표시)', promptLen > AIO_TEXT_MAX + 1000 && r3.run.items[0]?.text?.length === AIO_TEXT_MAX && r3.run.items[0]?.truncated === true, { promptLen, len: r3.run.items[0]?.text?.length })
  injectedCalls = 0
  let absentJudged = 0
  const r4 = await core(['absent', 'noresults'], { search: injected, judge: async (p) => ((absentJudged += 1), judgeOk(p)) })
  ok('C 판정 — 없음 · 결과 0건은 판정하지 않는다(판정 0회)', absentJudged === 0 && r4.run.usage.judgeCalls === 0 && r4.run.items[1]?.noResults === true && r4.run.state === 'done', r4.run.items)

  // ── C2. 다시 판정 — 검색 0 ──
  const seenBefore = seen.length
  const sentBefore = ledgerSent(LEDGER_C)
  injectedCalls = 0
  const rj = await aio.rejudgeAioItems(r1.run, BRAND_C, 'unknown', { judge: judgeOk, judgeEngine: 'fake-judge' })
  ok(
    'C 다시 판정 — 판정 불가였던 문항이 판정되고 rejudgedAt이 붙는다',
    rj.judged === 3 && shownItems(rj.run).every((i) => i.mentioned === true && typeof i.rejudgedAt === 'string') && rj.run.usage.judgeCalls === 6,
    { judged: rj.judged, items: shownItems(rj.run) },
  )
  const rj2 = await aio.rejudgeAioItems(rj.run, BRAND_C, 'all', { judge: judgeThrow, judgeEngine: 'fake-judge' })
  ok('C 다시 판정 — 다시 판정이 실패하면 앞 판정을 지우지 않는다 · 3번 잇따르면 멈춘다', rj2.stopped && rj2.failed === 3 && shownItems(rj2.run).every((i) => i.mentioned === true), rj2)
  ok('C 다시 판정 — 가짜 SerpAPI가 받은 요청 0 · 장부 그대로 · 주입 검색 0', seen.length === seenBefore && ledgerSent(LEDGER_C) === sentBefore && injectedCalls === 0)
}

// ── C3. 멈춤 규칙 — 진짜 공용 연결(serpSearch) · 가짜 SerpAPI가 받은 수 · 장부 sent ─────────────────────────────
{
  const stopCase = async (kind: string, reason: string, label: string) => {
    const r = await core([kind, 'absent'])
    ok(
      `C 멈춤 — ${label}: 바로 멈춘다(partial · ${reason}) · 그 뒤 질문은 보내지 않는다 · 보낸 1회는 장부에 센다`,
      r.run.state === 'partial' && r.run.stopReason === reason && r.requests.length === 1 && r.sent === 1 && r.run.usage.searches === 1 && r.run.items.length === 0 && !(r.run.stopMessage ?? '').includes(FAKE_KEY),
      { state: r.run.state, stop: r.run.stopReason, req: r.requests.length, sent: r.sent, msg: r.run.stopMessage },
    )
  }
  await stopCase('k401', 'key', '401(키)')
  await stopCase('k403', 'forbidden', '403')
  await stopCase('k429m', 'quota-month', '429 결제 주기 소진')
  await stopCase('k429h', 'rate-hour', '429 시간당 한도')
  await stopCase('k400', 'bad-request', '400')

  const streak = await core(['slow', 'e500', 'slow', 'absent'])
  const perQ = (r: { requests: Seen[] }) => [...new Set(r.requests.map((s) => s.q))].map((q) => r.requests.filter((s) => s.q === q).length)
  ok(
    'C 멈춤 — 시간 초과 · 5xx가 3번 잇따르면 멈춘다 · 시간 초과는 다시 보내지 않는다(질문마다 1회)',
    streak.run.state === 'partial' && streak.run.stopReason === 'streak' && streak.requests.length === 3 && perQ(streak).every((n) => n === 1) && same(streak.run.items.map((i) => [i.status, i.reason]), [['failed', 'timeout'], ['failed', 'upstream'], ['failed', 'timeout']]) && streak.sent === 3,
    { stop: streak.run.stopReason, req: streak.requests.length, items: streak.run.items.map((i) => [i.status, i.reason]) },
  )
  const followStreak = await core(['fslow', 'fslow', 'fslow', 'absent'])
  ok(
    'C 멈춤 — 늦게 오는 개요 후속의 시간 초과도 잇따름에 센다(3번이면 멈춤 · 다시 보내지 않음)',
    followStreak.run.stopReason === 'streak' && followStreak.requests.length === 6 && followStreak.run.items.every((i) => i.reason === 'follow-up-failed' && i.searches === 2),
    { stop: followStreak.run.stopReason, req: followStreak.requests.length, items: followStreak.run.items.map((i) => [i.reason, i.searches]) },
  )
  const reset = await core(['slow', 'e500', 'absent', 'slow'])
  ok('C 멈춤 — 사이에 성공이 있으면 잇따름을 되돌린다(끝까지 · 질문마다 1회)', reset.run.state === 'done' && reset.requests.length === 4 && perQ(reset).every((n) => n === 1), { state: reset.run.state, req: reset.requests.length })

  const floor = await core(['deferred', 'deferred', 'absent'], { account: { total_searches_left: 503 } })
  ok(
    'C 멈춤 — 실행 중 계정 바닥에 닿으면 후속을 보내지 않고 그 질문은 「못 읽음」, 멈춘다(요청 · 장부 3)',
    floor.run.state === 'partial' && floor.run.stopReason === 'floor' && floor.requests.length === 3 && floor.sent === 3 && same(floor.run.items.map((i) => [i.status, i.reason ?? null]), [['shown', null], ['unreadable', 'follow-up-blocked']]),
    { stop: floor.run.stopReason, req: floor.requests.length, sent: floor.sent, items: floor.run.items.map((i) => [i.status, i.reason]) },
  )
  const cap = await core(['absent', 'absent'], { ledger: { format: 'serpapi-usage/1', cycles: { [CYCLE]: { aio: { sent: 249 } } }, pending: [] } })
  ok('C 멈춤 — 이 PC 시범 몫(이번 결제 주기)에 닿으면 다음 검색을 보내지 않는다(feature-cap)', cap.run.stopReason === 'feature-cap' && cap.requests.length === 1 && cap.sent === 1 && cap.run.items.length === 1, { stop: cap.run.stopReason, req: cap.requests.length })
  writeFileSync(LEDGER_C, JSON.stringify({ format: 'serpapi-usage/1', cycles: {}, pending: [] }))
  const hour = await core(['absent', 'absent'], { account: { this_hour_searches: 199 } })
  ok('C 멈춤 — 이번 시간 한도에 닿으면 보내지 않는다(hour)', hour.run.stopReason === 'hour' && hour.requests.length === 1, { stop: hour.run.stopReason, req: hour.requests.length })
  const maxed = await core(['deferred', 'deferred'], { maxSearches: 3 })
  ok(
    'C 상한 — 한 회차가 보낸 검색은 M을 넘지 않는다(닿으면 후속을 보내지 않고 멈춤)',
    maxed.requests.length === 3 && maxed.run.usage.searches === 3 && maxed.run.stopReason === 'max-searches' && maxed.run.items[1]?.reason === 'follow-up-blocked',
    { req: maxed.requests.length, usage: maxed.run.usage, stop: maxed.run.stopReason },
  )
  const cancelled = await core(['absent', 'absent', 'absent'], { cancelAt: 1 })
  ok('C 중단 — 중단하면 남은 질문은 0회(cancelled · 받은 것은 남김)', cancelled.run.state === 'cancelled' && cancelled.run.stopReason === 'cancelled' && cancelled.requests.length === 1 && cancelled.run.items.length === 1, { state: cancelled.run.state, req: cancelled.requests.length })
  injectedCalls = 0
  let stopNow = false
  const cancelMid: AioSearchFn = async (params) => {
    const r = await injected(params)
    if (params.engine === 'google') stopNow = true
    return r
  }
  const midCancel = await core(['deferred', 'absent'], { search: cancelMid, cancelled: () => stopNow })
  ok(
    'C 중단 — 첫 검색과 후속 사이에 중단하면 후속도 보내지 않는다(그 질문은 남겨 이어 재기 대상)',
    injectedCalls === 1 && midCancel.run.state === 'cancelled' && midCancel.run.items.length === 0 && midCancel.run.usage.searches === 1 && midCancel.run.usage.followUps === 0,
    { calls: injectedCalls, state: midCancel.run.state, usage: midCancel.run.usage },
  )
  let pilotChecks = 0
  const off = await core(['absent', 'absent'], { pilotOn: async () => (pilotChecks += 1) === 1 })
  ok('C 중단 — 실행 중 이 PC에서 끄면 다음 질문부터 보내지 않는다', off.run.state === 'cancelled' && off.run.stopReason === 'pilot-off' && off.requests.length === 1, { state: off.run.state, stop: off.run.stopReason, req: off.requests.length })

  const long = await core(['longtoken', 'absent'])
  ok(
    'C 읽기 — page_token이 공용 상한(2048자)보다 길면 후속을 보내지 않고 「못 읽음」(다시 검색도 않음)',
    long.requests.length === 2 && long.requests.every((s) => s.engine === 'google') && long.run.items[0]?.status === 'unreadable' && long.run.items[0]?.reason === 'token-too-long' && long.run.items[0]?.searches === 1,
    { req: long.requests.map((s) => s.engine), item: long.run.items[0] },
  )
  const re = await core(['erronce', 'errtwice', 'absent', 'absent'])
  ok(
    'C 다시 검색 — 못 읽음은 1번만 다시 검색 · 회차당 질문의 10%(올림)까지',
    re.requests.length === 5 && re.run.usage.reSearches === 1 && re.run.items[0]?.status === 'shown' && re.run.items[0]?.searches === 2 && re.run.items[1]?.status === 'unreadable' && re.run.items[1]?.searches === 1,
    { req: re.requests.length, usage: re.run.usage, items: re.run.items.map((i) => [i.status, i.searches]) },
  )
  const re2 = await core(['errtwice', 'absent'])
  ok('C 다시 검색 — 다시 검색도 못 읽으면 「못 읽음」(그 문항 검색 2)', re2.run.items[0]?.status === 'unreadable' && re2.run.items[0]?.reason === 'overview-error' && re2.run.items[0]?.searches === 2 && re2.requests.length === 3, re2.run.items[0])
  const f400 = await core(['f400', 'absent'])
  ok(
    'C 후속 — 후속이 HTTP 400이면 그 질문은 「못 읽음」, 회차는 멈춘다(같은 요청은 다 실패 — 돈이 안 나가는 쪽)',
    f400.requests.length === 2 && f400.run.items[0]?.status === 'unreadable' && f400.run.items[0]?.reason === 'follow-up-failed' && f400.run.stopReason === 'bad-request' && f400.sent === 2,
    { req: f400.requests.length, item: f400.run.items[0], stop: f400.run.stopReason },
  )
  const expired = await core(['expired'])
  ok(
    'C 후속 — 만료(Success 아님)는 「못 읽음」이고 1번 다시 검색한다(검색 4 · 후속 2)',
    expired.requests.length === 4 && expired.run.items[0]?.status === 'unreadable' && expired.run.items[0]?.reason === 'follow-up-error' && expired.run.items[0]?.searches === 4 && expired.run.usage.followUps === 2 && expired.run.usage.reSearches === 1,
    { req: expired.requests.length, item: expired.run.items[0], usage: expired.run.usage },
  )
  const fslow = await core(['fslow', 'absent'])
  ok(
    'C 후속 — 후속이 시간 초과면 다시 보내지 않고 다시 검색도 않는다(「못 읽음」)',
    fslow.requests.length === 3 && fslow.run.items[0]?.status === 'unreadable' && fslow.run.items[0]?.reason === 'follow-up-failed' && fslow.run.state === 'done',
    { req: fslow.requests.length, item: fslow.run.items[0] },
  )
  const deferred = await core(['deferred'])
  const follow = deferred.requests[1]
  ok(
    'C 후속 — 늦게 오는 개요는 고정 엔진 + page_token으로 직접 받는다(serpapi_link를 따라가지 않음 · 질의 · 위치 없음)',
    deferred.requests.length === 2 && follow?.engine === 'google_ai_overview' && same(Object.keys(follow.params).sort(), ['api_key', 'engine', 'no_cache', 'page_token']) && deferred.run.items[0]?.kind === 'deferred' && deferred.run.usage.followUps === 1,
    follow?.params,
  )
  const firstParams = deferred.requests[0]?.params ?? {}
  ok(
    'C 검색 — 첫 검색 매개변수(engine · q · google.co.kr · kr · ko · desktop · no_cache · 위치)',
    firstParams.engine === 'google' && firstParams.q === '가짜 질문 deferred 1' && firstParams.google_domain === 'google.co.kr' && firstParams.gl === 'kr' && firstParams.hl === 'ko' && firstParams.device === 'desktop' && firstParams.no_cache === 'true' && firstParams.location === GUNSAN,
    firstParams,
  )
  const file = path.join(dirC, 'data', 'vaio-c', 'google-aio', `${deferred.run.runId}.json`)
  const saved = existsSync(file) ? parseAioRun(JSON.parse(readFileSync(file, 'utf8'))) : null
  ok(
    'C 저장 — data/<브랜드>/google-aio/<회차 id>.json에 문항마다 적고, 원문 블록에는 page_token · serpapi_link가 없다',
    saved?.ok === true && saved.run.state === 'done' && saved.run.items.length === 1 && !readFileSync(file, 'utf8').includes('page_token') && !readFileSync(file, 'utf8').includes('serpapi_link'),
    saved,
  )
  ok('C — 가짜 서버가 받은 모든 요청은 가짜 키였다', seen.every((s) => s.keyOk))
}

// ── C4. 계획(검색 0) → 실행 사이 다시 보기 — 측정 중 · 이 PC 꺼짐 · 질문지 바뀜 · 몫 모자람(검색 0 · 잠금 놓음) ─────────────
{
  accountBody = account()
  const before = searchesSeen().length
  const p0 = await aio.planGoogleAio(TENANT_C, {})
  ok(
    'C 계획 — 검색 0 · 질문 3 · 최대 검색 M = 2n + 2⌈0.1n⌉ · 몫은 계정 비율에서(이번 주기 aio 몫)',
    typeof p0.planId === 'string' && p0.questions === 3 && p0.maxSearches === aioMaxSearches(3) && p0.quota?.cap === 250 && p0.quota.floor === 500 && p0.blocked === null && searchesSeen().length === before,
    p0,
  )
  const lockFile = path.join(dirC, 'serpapi-run.lock')
  const released = () => serp.serpRunHolder() === null && !existsSync(lockFile)
  tracker.beginMeasureRun()
  const pm = await errOf(aio.planGoogleAio(TENANT_C, {}))
  const rm = await errOf(aio.startGoogleAio(TENANT_C, { planId: p0.planId }))
  tracker.endMeasureRun()
  ok('C G3 — 측정 중이면 계획 · 실행 모두 409 measuring(검색 0 · 잠금 놓음)', pm?.status === 409 && pm.code === 'measuring' && rm?.status === 409 && rm.code === 'measuring' && searchesSeen().length === before && released(), [pm, rm])
  const p1 = await aio.planGoogleAio(TENANT_C, {})
  writeJson(SETTINGS_C, { format: 'google-aio-settings/1', enabled: false, tenants: ['vaio-c'] })
  const r1 = await errOf(aio.startGoogleAio(TENANT_C, { planId: p1.planId }))
  writeJson(SETTINGS_C, { format: 'google-aio-settings/1', enabled: true, tenants: ['vaio-c'] })
  ok('C 다시 보기 — 계획 뒤 이 PC에서 끄면 실행 409 pilot-off(검색 0 · 잠금 놓음)', r1?.status === 409 && r1.code === 'pilot-off' && searchesSeen().length === before && released(), r1)
  const p2 = await aio.planGoogleAio(TENANT_C, {})
  writeJson(BANK_C, bankOf('v1', [{ ...C_QS[0]!, text: '가짜 질문 inline 1 바뀜' }, C_QS[1]!, C_QS[2]!]))
  const r2 = await errOf(aio.startGoogleAio(TENANT_C, { planId: p2.planId }))
  writeJson(BANK_C, bankOf('v1', C_QS))
  ok('C 다시 보기 — 계획 뒤 질문지가 바뀌면(질문 지문) 실행 409 plan-changed(검색 0 · 잠금 놓음)', r2?.status === 409 && r2.code === 'plan-changed' && searchesSeen().length === before && released(), r2)
  const p3 = await aio.planGoogleAio(TENANT_C, {})
  accountBody = account({ total_searches_left: 505 })
  const r3 = await errOf(aio.startGoogleAio(TENANT_C, { planId: p3.planId }))
  accountBody = account()
  ok('C 다시 보기 — 계획 뒤 계정 남은 수가 줄어 M에 못 미치면 실행 409 limit(검색 0 · 잠금 놓음 · 회차를 줄이지 않음)', r3?.status === 409 && r3.code === 'limit' && searchesSeen().length === before && released(), r3)
  const r4 = await errOf(aio.startGoogleAio(TENANT_C, { planId: p3.planId }))
  ok('C 계획 id — 한 번 쓴(또는 없는) 계획 id는 409 plan-changed', r4?.status === 409 && r4.code === 'plan-changed', r4)
  const p5 = await aio.planGoogleAio(TENANT_C, {})
  const started = await aio.startGoogleAio(TENANT_C, { planId: p5.planId })
  const during = await aio.googleAioStatus(TENANT_C)
  ok('C 실행 — 도는 동안 상태는 메모리의 진행만(가벼운 GET — 회차 · 원장을 읽지 않음)', during.running?.runId === started.runId && during.view === null && during.running.planned === 3, during)
  for (let i = 0; i < 200 && (await aio.googleAioStatus(TENANT_C)).running; i += 1) await sleep(100)
  const after = await aio.googleAioStatus(TENANT_C)
  const last = after.view?.runs[0]
  ok('C 실행 — 끝나면 회차가 보이고(done) 잠금을 놓는다', after.running === null && last?.runId === started.runId && last.state === 'done' && released(), { running: after.running, last })

  // 이어 재기 거절 — 조건 서명 · 질문 지문이 다르면(계획 409 resume, 검색 0)
  const stopped = { ...aio.newAioRun({ tenantId: 'vaio-c', startedAt: new Date(Date.now() - 5_000), location: GUNSAN, bankVersion: 'v1', cohortBank: null, questions: C_QS, cycle: CYCLE, judgeEngine: 'mock' }), state: 'cancelled' as const, finishedAt: new Date().toISOString() }
  writeJson(path.join(dirC, 'data', 'vaio-c', 'google-aio', `${stopped.runId}.json`), stopped)
  const rOk = await aio.planGoogleAio(TENANT_C, { resume: stopped.runId })
  writeJson(SETTINGS_C, { format: 'google-aio-settings/1', enabled: true, tenants: ['vaio-c'], locations: { 'vaio-c': 'Seoul,South Korea' } })
  const rCond = await errOf(aio.planGoogleAio(TENANT_C, { resume: stopped.runId }))
  writeJson(SETTINGS_C, { format: 'google-aio-settings/1', enabled: true, tenants: ['vaio-c'] })
  writeJson(BANK_C, bankOf('v1', [...C_QS, { questionId: 'c1-009', text: '가짜 질문 absent 9' }]))
  const rQs = await errOf(aio.planGoogleAio(TENANT_C, { resume: stopped.runId }))
  writeJson(BANK_C, bankOf('v1', C_QS))
  ok(
    'C 이어 재기 — 같은 날 · 같은 조건 · 같은 지문이면 남은 질문만 계획, 위치(조건 서명)나 질문지(지문)가 다르면 409 resume',
    rOk.resume?.runId === stopped.runId && rOk.questions === 3 && typeof rOk.planId === 'string' && rCond?.status === 409 && rCond.code === 'resume' && /검색 조건/.test(rCond.message ?? '') && rQs?.status === 409 && rQs.code === 'resume' && /질문지/.test(rQs.message ?? '') && searchesSeen().length === before + 4,
    [rOk.resume, rCond, rQs],
  )

  // 코호트 질문지를 쓰는 브랜드 — 은행의 코호트 출처가 지금 코호트(업종 · 지역 · 판)와 같아야 한다
  const cohortTenant = { ...TENANT_C, cohortQuestionBank: 'c1' } as TenantConfig
  const noCohort = await aio.planGoogleAio(cohortTenant, {})
  writeJson(BANK_C, bankOf('v1', C_QS, { cohortBank: { key: '가상업종__전북_군산', version: 'c1' } }))
  const withCohort = await aio.planGoogleAio(cohortTenant, {})
  writeJson(BANK_C, bankOf('v1', C_QS, { cohortBank: { key: '가상업종__전북_군산', version: 'c0' } }))
  const oldCohort = await aio.planGoogleAio(cohortTenant, {})
  writeJson(BANK_C, bankOf('v1', C_QS))
  ok(
    'C 질문지 — 코호트 질문지를 쓰는 브랜드는 은행의 코호트 출처(키 · 판)가 지금과 같을 때만(아니면 「측정을 한 번 한 뒤 재세요」 · 계획 id 없음)',
    noCohort.planId === null && noCohort.blocked?.kind === 'bank' && /측정을 한 번 한 뒤 재세요/.test(noCohort.blocked.message) && typeof withCohort.planId === 'string' && oldCohort.planId === null && oldCohort.blocked?.kind === 'bank',
    [noCohort.blocked, withCohort.blocked, oldCohort.blocked],
  )

  // 다시 판정 — 두 요청이 함께 와도 하나만(판정비 두 번 없음)
  const [j1, j2] = await Promise.allSettled([aio.rejudgeGoogleAio(TENANT_C, started.runId, { scope: 'all' }), aio.rejudgeGoogleAio(TENANT_C, started.runId, { scope: 'all' })])
  const rejected = [j1, j2].filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason as { status?: number; code?: string })
  ok('C 다시 판정 — 두 요청이 함께 오면 하나는 409 busy', [j1, j2].filter((r) => r.status === 'fulfilled').length === 1 && rejected.length === 1 && rejected[0]!.status === 409 && rejected[0]!.code === 'busy', [j1, j2])
  for (let i = 0; i < 100 && (await aio.googleAioStatus(TENANT_C)).rejudging; i += 1) await sleep(50)
  writeJson(SETTINGS_C, { format: 'google-aio-settings/1', enabled: false, tenants: ['vaio-c'] })
  const pOffRj = await errOf(aio.rejudgeGoogleAio(TENANT_C, started.runId, { scope: 'all' }))
  writeJson(SETTINGS_C, { format: 'google-aio-settings/1', enabled: true, tenants: ['vaio-c'] })
  tracker.beginMeasureRun()
  const mRj = await errOf(aio.rejudgeGoogleAio(TENANT_C, started.runId, { scope: 'all' }))
  tracker.endMeasureRun()
  const noRun = await errOf(aio.rejudgeGoogleAio(TENANT_C, '2020-01-01T00-00-00-000Z', { scope: 'all' }))
  ok('C 다시 판정 — 이 PC 꺼짐 409 pilot-off · 측정 중 409 measuring · 없는 회차 404 · 그 뒤 다시 받을 수 있다', pOffRj?.status === 409 && pOffRj.code === 'pilot-off' && mRj?.status === 409 && mRj.code === 'measuring' && noRun?.status === 404 && (await aio.googleAioStatus(TENANT_C)).rejudging === null, [pOffRj, mRj, noRun])

  // 회차 폴더 — 쓰다 만 임시 파일 · 다른 이름은 거르고, 깨진 회차 파일은 숨기지 않고 센다
  const folder = path.join(dirC, 'data', 'vaio-c', 'google-aio')
  writeFileSync(path.join(folder, `${started.runId}.json.123.abc.tmp`), '{')
  writeFileSync(path.join(folder, 'memo.txt'), 'x')
  writeFileSync(path.join(folder, '2020-01-01T00-00-00-000Z.json'), '{"format":"google-aio/1"')
  const validRuns = readdirSync(folder).filter((n) => /^[\w-]+\.json$/.test(n)).length - 1
  const listed = await aio.googleAioStatus(TENANT_C)
  ok('C 회차 폴더 — 임시 파일 · 다른 이름은 거르고, 깨진 회차 파일은 「읽지 못한 회차 1개」', listed.unreadableRuns === 1 && listed.view?.unreadableRuns === 1 && listed.view.runs.length === validRuns, { unreadable: listed.unreadableRuns, runs: listed.view?.runs.map((r) => r.runId) })
  for (const f of [`${started.runId}.json.123.abc.tmp`, 'memo.txt', '2020-01-01T00-00-00-000Z.json']) unlinkSync(path.join(folder, f))

  injectedCalls = 0
  let refsJudged = 0
  const refsOnly = await core(['refsonly'], { search: injected, judge: async (p) => ((refsJudged += 1), judgeOk(p)) })
  ok('C 판정 — 본문 없이 출처만 온 개요는 판정하지 않는다(판정 불가로 남음 · 판정 0회)', refsOnly.run.items[0]?.status === 'shown' && refsOnly.run.items[0]?.mentioned === undefined && refsJudged === 0 && refsOnly.run.usage.judgeCalls === 0, refsOnly.run.items[0])
}

// ══ B. 라우트 — 앱 서버(127.0.0.1:4199)를 띄운다 ══════════════════════════════════════════════════
const GUARD = `data:text/javascript,${encodeURIComponent(
  [
    'const real = globalThis.fetch;',
    'globalThis.fetch = (input, init) => {',
    "  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;",
    "  const host = URL.canParse(href) ? new URL(href).hostname : '';",
    '  if (/(^|\\.)(serpapi\\.com|googleapis\\.com|openai\\.com|anthropic\\.com|perplexity\\.ai)$/i.test(host)) {',
    "    process.stderr.write('VERIFY-GUARD blocked a real SerpAPI or LLM request\\n');",
    "    return Promise.reject(new Error('verify guard'));",
    '  }',
    '  return real(input, init);',
    '};',
  ].join('\n'),
)}`
const D = (n: number) => addDays(todayKst(), -n)
const tenantB = (tenantId: string, brandName: string, over: Record<string, unknown> = {}) => ({
  tenantId,
  brandName,
  aliases: [],
  ownedDomains: [`${tenantId}.example`],
  industry: '가상업종',
  region: '전북 군산',
  engines: ['gemini'],
  questionBankSize: 8,
  questionBankVersion: 'v1',
  repeatsPerQuestion: 1,
  factGraph: [],
  competitors: [],
  ...over,
})
writeJson(path.join(dirB, 'tenants.overlay.json'), [
  tenantB('vaio-a', '뷰성형외과', { aliases: ['뷰성형'], ownedDomains: ['fake-view.example'], competitors: [{ name: '강남성형A', aliases: [], domains: [] }] }),
  tenantB('vaio-n', '가상전국', { region: '전국', marketScope: 'national' }),
  tenantB('vaio-x', '가상시범아님'),
  tenantB('vaio-nobank', '가상질문지없음'),
  tenantB('vaio-comp', '가상경쟁', { cohortOnly: true }),
])
const A_QS = [
  ...qsOf(['inline', 'deferred', 'absent', 'noresults', 'norefs']),
  { questionId: 'b1-001', text: '뷰성형외과 어때?', category: 'brand-direct', containsBrandName: true },
  { questionId: 'c1-006', text: '가짜 질문 probe 6', probe: true },
]
const N_QS = qsOf(['slowok', 'slowok', 'slowok', 'slowok'], 'n1')
const dataB = (tenantId: string, ...rest: string[]) => path.join(dirB, 'data', tenantId, ...rest)
writeJson(dataB('vaio-a', 'question-bank', 'v1.json'), bankOf('v1', A_QS))
writeJson(dataB('vaio-n', 'question-bank', 'v1.json'), bankOf('v1', N_QS))
writeJson(dataB('vaio-x', 'question-bank', 'v1.json'), bankOf('v1', qsOf(['absent'], 'x1')))
writeJson(path.join(seedB, 'question-banks', 'vaio-nobank', 'v1.json'), bankOf('v1', qsOf(['absent'], 'nb')))
const POST_W1 = 'https://m.blog.naver.com/fakewriter1/223000000001'
const ledgerPost = (id: string, url: string, publishedOn: string, extra: Record<string, unknown> = {}) => ({
  id,
  url,
  key: trackingKey(url),
  publishedOn,
  publishedOnSource: 'user',
  recordedAt: `${publishedOn}T03:00:00.000Z`,
  articleId: 'content:category-agnostic',
  targetActionId: 'content:category-agnostic',
  via: 'own',
  articleTitle: '가짜 글',
  ...extra,
})
const LEDGER_A_TEXT = JSON.stringify(
  {
    version: 1,
    keyRule: 3,
    posts: [
      ledgerPost('p-aio00000001', POST_W1, D(5), { articleId: 'topic:c1-001', targetActionId: 'topic:c1-001', via: 'channel', articleTitle: '가짜 작성자 글', topic: { bankVersion: 'v1', questionIds: ['c1-001'], questionTexts: ['가짜 질문 inline 1'] } }),
      ledgerPost('p-aio00000002', 'https://slowidx.tistory.com/1', D(14)),
    ],
  },
  null,
  2,
)
writeFileSync(dataB('vaio-a', 'published-posts.json'), LEDGER_A_TEXT)
writeJson(dataB('vaio-a', 'external-posts.json'), {
  version: 1,
  keyRule: 3,
  posts: [{ id: 'x-a10000000001', url: 'https://fake-hand.example.net/posts/5', key: trackingKey('https://fake-hand.example.net/posts/5'), title: '가짜 손글', publishedOn: D(6), publishedOnSource: 'page', trackedAt: `${D(6)}T01:00:00.000Z` }],
})
const PLAN_B = {
  format: 'probe-plan/2',
  tenantId: 'vaio-a',
  bankVersion: 'v1',
  activeUntil: '2027-03-31',
  source: { writers: 'docs/writers.json', seed: 1 },
  articles: [{ id: 'topic:c1-001', name: '가짜 주제 하나', angle: '처음 가는 사람의 눈으로', writer: { key: 'w1', name: WRITER_NAME }, blog: '', questionIds: ['c1-001'], questionTexts: ['가짜 질문 inline 1'] }],
}
ok('B 준비 — 가짜 배정 파일(가짜 작성자 이름)은 앱의 검사를 통과한다', parseWriterPlan(PLAN_B).plan !== undefined)
writeJson(dataB('vaio-a', 'probe-plan.json'), PLAN_B)
const SETTINGS_B = path.join(dirB, 'google-aio-settings.json')
writeJson(SETTINGS_B, { format: 'google-aio-settings/1', enabled: false, tenants: ['vaio-a', 'vaio-n', 'vaio-nobank'] })
const LEDGER_B = path.join(dirB, 'serpapi-usage.json')
const LOCK_B = path.join(dirB, 'serpapi-run.lock')

let logs = ''
const startApp = async (over: Record<string, string> = {}): Promise<ChildProcess> => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APP_DATA_DIR: dirB,
    PORT: String(APP_PORT),
    USE_MOCK_ENGINES: 'true',
    DOTENV_CONFIG_PATH: path.join(dirB, 'no-such.env'),
    SEED_DATA_DIR: seedB,
    BLOB_READ_WRITE_TOKEN: '',
    BLOB_STORE_ID: '',
    PIPELINE_CRON: '',
    GH_MEASURE_TOKEN: '',
    GEMINI_API_KEY: '',
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    PERPLEXITY_API_KEY: '',
    JUDGE_ENGINE: '',
    SERPAPI_API_KEY: FAKE_KEY,
    SERPAPI_LIVE: '',
    SERPAPI_BASE_URL: MOCK_BASE,
    SERPAPI_TIMEOUT_MS: String(B_TIMEOUT_MS),
    ...over,
  }
  delete env.AEO_SERVER_HOST
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(env.SERPAPI_BASE_URL ?? '')) throw new Error('가짜 SerpAPI 주소가 아니라 서버를 띄우지 않습니다.')
  const srv = spawn(process.execPath, ['--import', GUARD, '--import', 'tsx', 'server/index.ts'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(srv)
  srv.stdout?.on('data', (d: Buffer) => (logs += d.toString()))
  srv.stderr?.on('data', (d: Buffer) => (logs += d.toString()))
  for (let i = 0; i < 120; i += 1) {
    if (await fetch(`${APP_BASE}/api/health`).then((r) => r.ok, () => false)) return srv
    await sleep(500)
  }
  throw new Error(`앱 서버가 뜨지 않았습니다:\n${logs.slice(-2000)}`)
}
const stopApp = async (srv: ChildProcess) => {
  const exited = new Promise<void>((resolve) => (srv.exitCode !== null || srv.signalCode !== null ? resolve() : srv.once('exit', () => resolve())))
  srv.kill()
  await exited
  for (let i = 0; i < 20 && !(await portFree(APP_PORT)); i += 1) await sleep(250)
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
  return { status: r.status, text, body: (text.startsWith('{') ? JSON.parse(text) : {}) as T & { error?: string; code?: string } }
}
/** Host · Origin을 마음대로 붙이는 요청(fetch는 Host를 못 바꾼다) — 127.0.0.1의 앱 서버로만 간다. */
const rawCall = (method: string, p: string, headers: Record<string, string>, body?: unknown) =>
  new Promise<{ status: number; text: string }>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const rq = http.request(
      { host: '127.0.0.1', port: APP_PORT, path: p, method, headers: { ...headers, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {}) } },
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
const status = (tenantId: string) => call<GoogleAioStatusView>('GET', `/api/google-aio/${tenantId}`)
const plan = (tenantId: string, body: Record<string, unknown> = {}) => call<GoogleAioPlanView>('POST', `/api/google-aio/${tenantId}/plan`, body)
const runPlan = (tenantId: string, planId: string | null) => call<{ runId: string; planned: number; maxSearches: number }>('POST', `/api/google-aio/${tenantId}/run`, { planId })
const waitIdle = async (tenantId: string) => {
  for (let i = 0; i < 600; i += 1) {
    const s = await status(tenantId)
    if (s.status === 200 && s.body.running === null && s.body.rejudging === null && !s.body.runningElsewhere) return s.body
    await sleep(200)
  }
  return null
}
const runFileOf = (tenantId: string, runId: string) => dataB(tenantId, 'google-aio', `${runId}.json`)
const readRun = (tenantId: string, runId: string) => JSON.parse(readFileSync(runFileOf(tenantId, runId), 'utf8')) as AioRun
const readRunMaybe = (tenantId: string, runId: string): AioRun | null => (existsSync(runFileOf(tenantId, runId)) ? readRun(tenantId, runId) : null)
const hashTree = (root: string, skip: (rel: string) => boolean) => {
  const out = new Map<string, string>()
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      const rel = path.relative(root, p).split(path.sep).join('/')
      if (skip(rel)) continue
      if (e.isDirectory()) walk(p)
      else out.set(rel, createHash('sha256').update(readFileSync(p)).digest('hex'))
    }
  }
  if (existsSync(root)) walk(root)
  return out
}
const changed = (a: Map<string, string>, b: Map<string, string>) => [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k))
/** 격리 비교에서 빼는 것 — AI 개요 회차 폴더 · 공용 장부 · 실행 잠금 · 쓰다 만 임시 파일. */
const isolationSkip = (rel: string) => rel === 'serpapi-usage.json' || rel === 'serpapi-run.lock' || /^data\/[^/]+\/google-aio(\/|$)/.test(rel) || rel.endsWith('.tmp')
const today = todayKst()

let app = await startApp()
try {
  // ── B1. Host · Origin · JSON · 회차 id · 고객 브랜드만 ──
  const before = searchesSeen().length
  const evil = { Host: 'evil.example:4199' }
  const fromEvil = { Host: '127.0.0.1:4199', Origin: 'http://evil.example' }
  const rid = '2026-11-11T00-00-00-000Z'
  const blocked403 = [
    await rawCall('GET', '/api/google-aio/vaio-a', evil),
    await rawCall('GET', `/api/google-aio/vaio-a/runs/${rid}`, evil),
    await rawCall('POST', '/api/google-aio/vaio-a/plan', fromEvil, {}),
    await rawCall('POST', '/api/google-aio/vaio-a/run', evil, { planId: 'x' }),
    await rawCall('POST', `/api/google-aio/vaio-a/runs/${rid}/cancel`, evil, {}),
    await rawCall('POST', `/api/google-aio/vaio-a/runs/${rid}/rejudge`, fromEvil, { scope: 'all' }),
    await rawCall('PUT', '/api/google-aio/settings', fromEvil, { enabled: true }),
  ]
  ok('B Host/Origin — 이 PC 화면이 아닌 요청은 GET 상태 · 회차 상세 · 계획 · 실행 · 중단 · 다시 판정 · 설정 모두 403', blocked403.every((r) => r.status === 403), blocked403.map((r) => r.status))
  const t415 = [
    await call('POST', '/api/google-aio/vaio-a/plan', undefined, { text: '{}', type: 'text/plain' }),
    await call('POST', '/api/google-aio/vaio-a/run', undefined, { text: 'planId=x', type: 'application/x-www-form-urlencoded' }),
    await call('PUT', '/api/google-aio/settings', undefined, { text: '{"enabled":true}', type: 'text/plain' }),
    await call('POST', `/api/google-aio/vaio-a/runs/${rid}/rejudge`, undefined, { text: '{}', type: 'text/plain' }),
    await call('POST', `/api/google-aio/vaio-a/runs/${rid}/cancel`, undefined, { text: '{}' }),
  ]
  ok('B JSON만 — 계획 · 실행 · 설정 · 다시 판정 · 중단은 JSON이 아니면 415', t415.every((r) => r.status === 415), t415.map((r) => r.status))
  const bad400 = [
    await call('GET', '/api/google-aio/vaio-a/runs/..%2F..%2Fgoogle-aio-settings'),
    await call('GET', '/api/google-aio/vaio-a/runs/..%2F..%2F..%2Fserpapi-usage'),
    await call('GET', '/api/google-aio/vaio-a/runs/2026-11-11T00:00:00.000Z'),
    await call('POST', '/api/google-aio/vaio-a/runs/..%2Fx/cancel', {}),
    await call('POST', '/api/google-aio/vaio-a/runs/..%2Fx/rejudge', { scope: 'all' }),
  ]
  ok('B 회차 id — 꼴이 아니면(..%2F · 원래 ISO) 파일을 열기 전에 400', bad400.every((r) => r.status === 400), bad400.map((r) => r.status))
  const t404 = [await status('vaio-none'), await status('vaio-comp'), await plan('vaio-comp'), await call('GET', `/api/google-aio/vaio-a/runs/${rid}`)]
  ok('B 고객 브랜드만 — 없는 브랜드 · 경쟁사는 404(tenant not found), 없는 회차는 404', t404.every((r) => r.status === 404) && /tenant not found/.test(t404[0]!.body.error ?? '') && /tenant not found/.test(t404[1]!.body.error ?? ''), t404.map((r) => [r.status, r.body.error]))

  // ── B2. 이 PC 꺼짐 · 켜기 · 시범 아님 · 질문지 없음 ──
  const s0 = await status('vaio-a')
  ok('B 상태 — 이 PC 꺼짐 · 시범 브랜드 · 위치(전북 군산) · 키 있음 · 판정 엔진(목) 준비', s0.status === 200 && s0.body.enabled === false && s0.body.pilot === true && s0.body.location === GUNSAN && s0.body.configured === true && s0.body.judge.ready === true, s0.body)
  const pOff = await plan('vaio-a')
  ok('B 이 PC 꺼짐 — 계획 409 pilot-off', pOff.status === 409 && pOff.body.code === 'pilot-off', pOff.body)
  const badPut = [await call('PUT', '/api/google-aio/settings', { enabled: 'yes' }), await call('PUT', '/api/google-aio/settings', { enabled: true, tenants: ['vaio-x'] }), await call('PUT', '/api/google-aio/settings', {})]
  ok('B 설정 — enabled(참 · 거짓) 하나만 받는다(그 밖은 400)', badPut.every((r) => r.status === 400), badPut.map((r) => r.status))
  const put = await call('PUT', '/api/google-aio/settings', { enabled: true })
  const settingsFile = JSON.parse(readFileSync(SETTINGS_B, 'utf8')) as { enabled?: boolean; tenants?: string[] }
  ok('B 설정 — 이 PC에서 켜기(파일의 시범 브랜드 목록은 그대로)', put.status === 200 && settingsFile.enabled === true && same(settingsFile.tenants, ['vaio-a', 'vaio-n', 'vaio-nobank']), [put.body, settingsFile])
  const pX = await plan('vaio-x')
  const sX = await status('vaio-x')
  ok('B 시범 아님 — 계획 409 not-pilot · 상태는 「이 브랜드는 시범 대상이 아니에요」', pX.status === 409 && pX.body.code === 'not-pilot' && sX.body.pilot === false && /시범 대상이 아니에요/.test(sX.body.pilotMessage ?? ''), [pX.body, sX.body.pilotMessage])
  const sN = await status('vaio-n')
  ok('B 위치 — 전국형은 위치 없이(gl=kr만)', sN.body.location === null && /loc=없음/.test(sN.body.signature ?? ''), sN.body.signature)
  const pNb = await plan('vaio-nobank')
  ok(
    'B 질문지 없음 — 「측정을 한 번 한 뒤 재세요」(계획 id 없음) · 동봉 질문지를 이 PC로 복사하지 않는다',
    pNb.status === 200 && pNb.body.planId === null && pNb.body.blocked?.kind === 'bank' && /측정을 한 번 한 뒤 재세요/.test(pNb.body.blocked.message) && !existsSync(dataB('vaio-nobank', 'question-bank')),
    pNb.body,
  )
  accountBody = account({ total_searches_left: 505 })
  const pLow = await plan('vaio-a')
  accountBody = account()
  ok(
    'B 몫 — 계정 바닥 위로 남은 수가 M보다 적으면 시작하지 않는다(계획 id 없음 · 숫자와 까닭)',
    pLow.status === 200 && pLow.body.planId === null && pLow.body.blocked?.kind === 'limit' && pLow.body.maxSearches === aioMaxSearches(5) && /12회/.test(pLow.body.blocked.message) && pLow.body.quota?.aboveFloor === 5,
    pLow.body,
  )
  ok('B — 여기까지 가짜 SerpAPI가 받은 검색 0(계정만 무료로 읽음)', searchesSeen().length === before)

  // ── B3. 계획 → 실행 → 진행 → 결과(격리 · 장부 · 매개변수) ──
  const usageBefore = await call('GET', '/api/usage')
  const treeBefore = hashTree(dirB, isolationSkip)
  const sentBefore = ledgerSent(LEDGER_B)
  const p1 = await plan('vaio-a')
  ok(
    'B 계획 — 검색 0 · 점수에 세는 이름 없는 질문만(브랜드 · 실증 질문 빼고 5) · M 12 · 판정 최대 5 · 몫(aio 250 · 바닥 500)은 계정에서 · 확인창 재료',
    p1.status === 200 && typeof p1.body.planId === 'string' && p1.body.questions === 5 && p1.body.maxSearches === 12 && p1.body.maxJudgeCalls === 5 && p1.body.quota?.cap === 250 && p1.body.quota.floor === 500 && p1.body.quota.hourLeft === 200 && p1.body.judge.ready === true && p1.body.lastRunAt === null && p1.body.expectedMinutes.length === 2 && searchesSeen().length === before,
    p1.body,
  )
  accountBody = account({ this_hour_searches: 195 })
  const rLow = await runPlan('vaio-a', p1.body.planId)
  accountBody = account()
  ok('B 실행 — 계획 뒤 시간당 남은 수가 M보다 적어지면 409 limit · 검색 0 · 잠금 놓음', rLow.status === 409 && rLow.body.code === 'limit' && searchesSeen().length === before && !existsSync(LOCK_B), rLow.body)
  const p2 = await plan('vaio-a')
  const r2 = await runPlan('vaio-a', p2.body.planId)
  const sRun = await status('vaio-a')
  ok('B 실행 — 202 · 도는 동안 상태는 메모리의 진행(가벼운 GET — view 없음)', r2.status === 202 && r2.body.planned === 5 && r2.body.maxSearches === 12 && (sRun.body.running === null || (sRun.body.running.runId === r2.body.runId && sRun.body.view === null)), [r2.body, sRun.body.running])
  const done = await waitIdle('vaio-a')
  const runId = r2.body.runId
  const run = readRun('vaio-a', runId)
  const mine = searchesSeen().slice(before)
  const firsts = mine.filter((s) => s.engine === 'google')
  const follows = mine.filter((s) => s.engine === 'google_ai_overview')
  ok(
    'B 결과 — done · 문항 5 · 검색 7(첫 검색 5 + 늦게 오는 개요 후속 2) · 장부 aio sent +7 · 가짜 서버가 받은 수와 같다',
    run.state === 'done' && run.items.length === 5 && run.usage.searches === 7 && run.usage.followUps === 2 && mine.length === 7 && ledgerSent(LEDGER_B) - sentBefore === 7 && firsts.length === 5 && follows.length === 2,
    { state: run.state, usage: run.usage, mine: mine.length, sent: ledgerSent(LEDGER_B) - sentBefore },
  )
  ok(
    'B 결과 — 첫 검색은 고정 조건 + 위치, 후속은 엔진 · page_token · no_cache만',
    firsts.every((s) => s.params.hl === 'ko' && s.params.gl === 'kr' && s.params.google_domain === 'google.co.kr' && s.params.device === 'desktop' && s.params.no_cache === 'true' && s.params.location === GUNSAN) &&
      follows.every((s) => same(Object.keys(s.params).sort(), ['api_key', 'engine', 'no_cache', 'page_token'])),
    mine.map((s) => s.params.engine),
  )
  const summary = done?.view?.summary
  ok(
    'B 결과 — 노출 3/5 · 언급 1/3(목 판정) · 출처 목록 받은 개요 2(출처 없는 개요 1) · 자사 1/2 · 올린 글 2/2 · 경쟁사 강남성형A 1',
    summary?.exposure.k === 3 && summary.exposure.n === 5 && summary.mention.k === 1 && summary.mention.n === 3 && summary.noSourceList === 1 && summary.ownSource.k === 1 && summary.ownSource.n === 2 && summary.postSource.k === 2 && summary.postSource.n === 2 && same(summary.competitors, [{ name: '강남성형A', count: 1 }]),
    summary,
  )
  const postRow = done?.view?.posts?.find((p) => p.url === POST_W1)
  ok('B 올린 글 표 — 작성자는 키(w1)만 · 이 회차에 출처로 나옴 1/1', postRow?.writerKey === 'w1' && postRow.cited === 1 && postRow.runs === 1, done?.view?.posts)
  ok('B 결과 — 질문 표는 같은 조건 회차만, 칸 기호 · 범례 글자', done?.view?.questions.rows.length === 5 && done.view.questions.rows[0]?.cells[0]?.kind === 'mentioned' && done.view.questions.rows[2]?.cells[0]?.label === 'AI 개요 없음', done?.view?.questions)
  const treeAfter = hashTree(dirB, isolationSkip)
  const usageAfter = await call('GET', '/api/usage')
  ok('B 격리 — 브랜드 데이터(회차 폴더 밖) · 이 PC 상태 파일 · 코호트 질문지 바이트가 그대로(점수 · 회차 기록 · 원장 · 앱 밖 글 · 질문지 복사 없음)', changed(treeBefore, treeAfter).length === 0, changed(treeBefore, treeAfter))
  ok('B 격리 — GET /api/usage 응답이 그대로(시범 판정 · 검색은 사용량 표에 들지 않음)', usageBefore.status === 200 && usageBefore.text === usageAfter.text)
  const detail = await call<GoogleAioRunDetail>('GET', `/api/google-aio/vaio-a/runs/${runId}`)
  const inlineItem = detail.body.items?.find((i) => i.questionId === 'c1-001')
  const deferredItem = detail.body.items?.find((i) => i.questionId === 'c1-002')
  ok(
    'B 회차 상세 — 원문 블록은 싣지 않고, 출처마다 자사 · 올린 글(작성자 키)을 읽을 때 표시',
    detail.status === 200 && detail.body.items.every((i) => !('rawBlock' in i)) && inlineItem?.sources.some((s) => s.owned && s.link === 'https://fake-view.example/about') === true && inlineItem.sources.some((s) => s.post?.origin === 'external') && deferredItem?.sources.some((s) => s.post?.writerKey === 'w1' && s.link === POST_W1) === true,
    detail.body.items?.map((i) => i.sources),
  )

  // ── B4. 다시 판정(검색 0) ──
  const beforeRj = searchesSeen().length
  const sentRj = ledgerSent(LEDGER_B)
  const rj = await call<{ runId: string; total: number }>('POST', `/api/google-aio/vaio-a/runs/${runId}/rejudge`, { scope: 'all' })
  const rjBad = await call('POST', `/api/google-aio/vaio-a/runs/${runId}/rejudge`, { scope: 'some' })
  await waitIdle('vaio-a')
  const rejudged = readRun('vaio-a', runId)
  ok(
    'B 다시 판정 — 202 · 판정 3(있음만) · 문항에 rejudgedAt · 가짜 SerpAPI 요청 0 · 장부 그대로 · scope가 틀리면 400',
    rj.status === 202 && rj.body.total === 3 && rejudged.items.filter((i) => i.rejudgedAt).length === 3 && searchesSeen().length === beforeRj && ledgerSent(LEDGER_B) === sentRj && rjBad.status === 400,
    [rj.body, rjBad.status],
  )

  // ── B5. 도는 중 — 409 busy · 색인 자동 확인과 서로 · 가벼운 GET · 중단 · 이어 재기 ──
  const pN = await plan('vaio-n')
  const rN = await runPlan('vaio-n', pN.body.planId)
  await sleep(300)
  const busyA = await plan('vaio-a')
  const busyIdx = await call('POST', '/api/index-auto/plan', { trigger: 'button' })
  const busyRj = await call('POST', `/api/google-aio/vaio-n/runs/${rN.body.runId}/rejudge`, { scope: 'all' })
  writeFileSync(dataB('vaio-n', 'published-posts.json'), '{"version":1,"posts":[')
  const light = await status('vaio-n')
  ok(
    'B 도는 중 — 다른 브랜드 계획 409 busy · 색인 자동 확인 계획 409(「구글 AI 개요 시범」이 도는 중) · 그 회차 다시 판정 409 busy',
    rN.status === 202 && busyA.status === 409 && busyA.body.code === 'busy' && busyIdx.status === 409 && /구글 AI 개요 시범/.test(busyIdx.body.error ?? '') && busyRj.status === 409 && busyRj.body.code === 'busy',
    [rN.body, busyA.body, busyIdx.body, busyRj.body],
  )
  ok('B 도는 중 — 상태 GET은 원장을 읽지 않는다(원장이 깨져도 200 · 진행만)', light.status === 200 && light.body.running?.runId === rN.body.runId && light.body.view === null, light.body)
  for (let i = 0; i < 100 && (readRunMaybe('vaio-n', rN.body.runId)?.items.length ?? 0) < 1; i += 1) await sleep(100)
  const cancel = await call('POST', `/api/google-aio/vaio-n/runs/${rN.body.runId}/cancel`, {})
  const nIdle = await waitIdle('vaio-n')
  const nRun = readRun('vaio-n', rN.body.runId)
  const nAfterCancel = searchesSeen().filter((s) => (s.q ?? '').includes('slowok')).length
  ok('B 중단 — 200 · cancelled · 남은 질문은 보내지 않는다', cancel.status === 200 && nRun.state === 'cancelled' && nRun.items.length >= 1 && nRun.items.length < 4 && nAfterCancel === nRun.items.length, { cancel: cancel.body, state: nRun.state, items: nRun.items.length, sent: nAfterCancel })
  ok('B 원장 깨짐 — 끝난 뒤 상태는 올린 글 출처를 「확인 불가」(posts null · 0 아님)', nIdle?.view?.posts === null && nIdle.view.runs[0]?.summary.postSource.rate === null && nIdle.view.runs[0]?.summary.postSource.reason === 'posts-unreadable', nIdle?.view?.runs[0]?.summary.postSource)
  writeFileSync(dataB('vaio-n', 'published-posts.json'), JSON.stringify({ version: 1, keyRule: 3, posts: [] }))
  ok('B 이어 재기 — 상태가 오늘 멈춘 회차를 알려 준다', nIdle?.resumable?.runId === rN.body.runId && nIdle.resumable.remaining === 4 - nRun.items.length, nIdle?.resumable)
  const pRes = await plan('vaio-n', { resume: rN.body.runId })
  const rRes = await runPlan('vaio-n', pRes.body.planId)
  await waitIdle('vaio-n')
  const resumed = readRun('vaio-n', rN.body.runId)
  const perQuery = N_QS.map((q) => searchesSeen().filter((s) => s.q === q.text).length)
  ok(
    'B 이어 재기 — 남은 질문만 보낸다(질문마다 검색 1 — 이중 과금 없음) · 같은 회차가 done',
    pRes.status === 200 && pRes.body.resume?.runId === rN.body.runId && pRes.body.questions === 4 - nRun.items.length && rRes.status === 202 && resumed.state === 'done' && resumed.items.length === 4 && perQuery.every((n) => n === 1),
    { plan: pRes.body.resume, state: resumed.state, perQuery },
  )
  const pResBad = await plan('vaio-n', { resume: '../x' })
  const pResNone = await plan('vaio-n', { resume: '2020-01-01T00-00-00-000Z' })
  const pResDone = await plan('vaio-n', { resume: rN.body.runId })
  ok('B 이어 재기 — 회차 id 꼴이 아니면 400, 없는 회차 · 끝난 회차는 409 resume', pResBad.status === 400 && pResNone.status === 409 && pResNone.body.code === 'resume' && pResDone.status === 409 && pResDone.body.code === 'resume', [pResBad.status, pResNone.body, pResDone.body])

  // ── B6. 색인 자동 확인이 도는 중 → AI 개요 409 ──
  const ip = await call<{ planId: string | null; searches: number }>('POST', '/api/index-auto/plan', { trigger: 'button' })
  const ir = await call('POST', '/api/index-auto/run', { planId: ip.body.planId })
  const aioWhileIdx = await plan('vaio-a')
  ok('B 색인 자동 확인이 도는 중 — AI 개요 계획 409 busy(「색인 자동 확인」이 도는 중)', ip.body.searches >= 1 && ir.status === 202 && aioWhileIdx.status === 409 && aioWhileIdx.body.code === 'busy' && /색인 자동 확인/.test(aioWhileIdx.body.error ?? ''), [ip.body.searches, ir.status, aioWhileIdx.body])
  for (let i = 0; i < 100; i += 1) {
    const s = await call<{ running: unknown }>('GET', '/api/index-auto')
    if (s.body.running === null) break
    await sleep(200)
  }

  // ── B7. 다른 창(앱을 두 번 켬)이 잠금을 쥠 · 끊긴 회차 ──
  const staleToday = { ...run, runId: aioRunId(new Date(Date.now() - 60_000)), startedAt: new Date(Date.now() - 60_000).toISOString(), finishedAt: null, state: 'running', stopReason: null, stopMessage: null, items: run.items.slice(0, 2) }
  const yesterdayAt = new Date(Date.now() - 36 * 3600_000)
  const staleOld = { ...staleToday, runId: aioRunId(yesterdayAt), startedAt: yesterdayAt.toISOString(), items: run.items.slice(0, 1).map((i) => ({ ...i, fetchedAt: yesterdayAt.toISOString() })) }
  writeJson(runFileOf('vaio-a', staleToday.runId), staleToday)
  writeJson(runFileOf('vaio-a', staleOld.runId), staleOld)
  const staleText = readFileSync(runFileOf('vaio-a', staleToday.runId), 'utf8')
  writeFileSync(LOCK_B, JSON.stringify({ format: 'serpapi-run-lock/1', pid: process.pid, feature: 'aio', token: 'other-window', at: new Date().toISOString() }))
  const se = await status('vaio-a')
  const pe = await plan('vaio-a')
  const re1 = await runPlan('vaio-a', 'plan-x')
  const rje = await call('POST', `/api/google-aio/vaio-a/runs/${staleToday.runId}/rejudge`, { scope: 'unknown' })
  const ce = await call('POST', `/api/google-aio/vaio-a/runs/${staleToday.runId}/cancel`, {})
  const ie = await call('POST', '/api/index-auto/plan', { trigger: 'button' })
  ok(
    'B 다른 창 — 다른 창이 AI 개요를 쥐면 상태는 「도는 중(다른 창)」(가벼운 GET), 계획 · 실행 · 다시 판정 · 중단 · 색인 계획 모두 409 busy-elsewhere',
    se.body.runningElsewhere === true && se.body.view === null && pe.body.code === 'busy-elsewhere' && re1.body.code === 'busy-elsewhere' && rje.body.code === 'busy-elsewhere' && ce.body.code === 'busy-elsewhere' && ie.status === 409 && ie.body.code === 'busy-elsewhere',
    [se.body.runningElsewhere, pe.body, re1.body, rje.body, ce.body, ie.body],
  )
  ok('B 다른 창 — 그 창이 쓰는 「도는 중」 회차 파일을 끊김으로 바꾸지 않는다', readFileSync(runFileOf('vaio-a', staleToday.runId), 'utf8') === staleText)
  writeFileSync(LOCK_B, JSON.stringify({ format: 'serpapi-run-lock/1', pid: process.pid, feature: 'index', token: 'other-window', at: new Date().toISOString() }))
  const pi = await plan('vaio-a')
  ok('B 다른 창 — 다른 창이 색인 자동 확인을 쥐어도 AI 개요 계획 409 busy-elsewhere', pi.status === 409 && pi.body.code === 'busy-elsewhere', pi.body)
  unlinkSync(LOCK_B)
  const sFree = await status('vaio-a')
  const staleRow = sFree.body.view?.runs.find((r) => r.runId === staleToday.runId)
  ok(
    'B 끊긴 회차 — 실행기 없이 「도는 중」인 파일은 GET에서 「끊김」으로만 보인다(파일은 그대로) · 오늘 것이면 이어 재기 후보',
    staleRow?.state === 'interrupted' && readFileSync(runFileOf('vaio-a', staleToday.runId), 'utf8') === staleText && sFree.body.resumable?.runId === staleToday.runId,
    [staleRow?.state, sFree.body.resumable],
  )
  const pStale = await plan('vaio-a', { resume: staleToday.runId })
  const rStale = await runPlan('vaio-a', pStale.body.planId)
  await waitIdle('vaio-a')
  const fixedOld = readRun('vaio-a', staleOld.runId)
  const resumedToday = readRun('vaio-a', staleToday.runId)
  ok(
    'B 끊긴 회차 — 다음 시작 때 한 번 고친다(어제 것은 interrupted로) · 오늘 것은 이어 재서 done',
    rStale.status === 202 && fixedOld.state === 'interrupted' && resumedToday.state === 'done' && resumedToday.items.length === 5,
    [rStale.body, fixedOld.state, resumedToday.state],
  )
  const pOld = await plan('vaio-a', { resume: staleOld.runId })
  ok('B 이어 재기 — 날이 다른 회차는 409 resume(「오늘 시작한 회차만」)', pOld.status === 409 && pOld.body.code === 'resume' && /오늘/.test(pOld.body.error ?? ''), pOld.body)

  // ── B8. 키 · 작성자 이름 ──
  const files = [LEDGER_B, ...readdirSync(dataB('vaio-a', 'google-aio')).map((f) => dataB('vaio-a', 'google-aio', f)), ...readdirSync(dataB('vaio-n', 'google-aio')).map((f) => dataB('vaio-n', 'google-aio', f))]
  const fileText = files.map((f) => readFileSync(f, 'utf8')).join('\n')
  const keyIn = (t: string) => t.includes(FAKE_KEY) || t.includes(encodeURIComponent(FAKE_KEY)) || t.includes('api_key=')
  ok('B 키 — 가짜 키(원문 · 인코딩)가 응답 · 회차 파일 · 장부 · 서버 로그 어디에도 없다', [...bodies, fileText, logs].every((t) => !keyIn(t)) && !logs.includes('VERIFY-GUARD'), logs.slice(-1500))
  ok('B 작성자 — 가짜 작성자 이름이 응답 · 회차 파일 · 서버 로그 어디에도 없다', [...bodies, fileText, logs].every((t) => !t.includes(WRITER_NAME)))
  ok('B 날짜 — 오늘 회차 id는 오늘 한국 날짜로 읽힌다', resumedToday.runId.startsWith(today.slice(0, 4)))
} finally {
  await stopApp(app)
}

// ── B9. 판정 엔진 키 없음 · SerpAPI 키 없음 — 시작 안 함(검색 0) ──
const beforeOff = searchesSeen().length
app = await startApp({ USE_MOCK_ENGINES: '' })
try {
  const s = await status('vaio-a')
  const p = await plan('vaio-a')
  ok('B 판정 엔진 키 없음 — 상태 judge.ready false · 계획 id 없음(까닭 judge) · 검색 0', s.body.judge.ready === false && p.status === 200 && p.body.planId === null && p.body.blocked?.kind === 'judge' && searchesSeen().length === beforeOff, [s.body.judge, p.body.blocked])
} finally {
  await stopApp(app)
}
app = await startApp({ SERPAPI_API_KEY: '' })
try {
  const s = await status('vaio-a')
  const p = await plan('vaio-a')
  const r = await runPlan('vaio-a', 'plan-x')
  ok('B SerpAPI 키 없음 — 상태 configured false · 계획 · 실행 503 · 검색 0', s.body.configured === false && p.status === 503 && r.status === 503 && searchesSeen().length === beforeOff, [s.body.configured, p.status, r.status])
} finally {
  await stopApp(app)
}
ok('B — .gitignore가 dev 설정 파일(server/google-aio-settings.json)을 올리지 않는다', readFileSync('.gitignore', 'utf8').split(/\r?\n/).includes('server/google-aio-settings.json'))
ok('B — 웹 함수는 그대로 12개(api/ — 새 라우트는 Express 전용)', execSync('git ls-files api', { encoding: 'utf8' }).trim().split(/\r?\n/).length === 12)
ok('B · C — 가짜 서버가 받은 모든 요청은 가짜 키였다', seen.every((s) => s.keyOk))
ok('B · C — 이 프로세스의 fetch가 127.0.0.1 밖으로 나가려 한 적이 없다(진짜 SerpAPI · LLM 0회)', blockedHosts.length === 0, blockedHosts)

for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill()
mock.closeAllConnections()
mock.close()
removeDirs()

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
