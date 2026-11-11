/**
 * 구글 AI 개요 시범 — 순수 규칙. 화면(src/pages/GoogleAio.tsx)과 서버(server/googleAio.ts)가 이 한 벌을 쓴다. 2026-11-10 설계
 * 「구글 AI 개요 측정」(D1–D13 권장안 · 비평 K1–K24) + 2026-11-11 파일 목록 승인(G1 위치 고정 · G3 측정 중에는 재지 않음 · 검토 반영).
 * 점수 · 정기진단 보고서 · 전주 비교 · 회차 기록과 격리한다 — 그쪽 모듈은 이 파일을 불러오지 않는다(scripts/verify-google-aio.ts 정적 검사).
 *
 * ── 검색 조건 ─────────────────────────────────────────────────────────────────
 * 질문 원문 그대로 engine=google · hl=ko · gl=kr · google.co.kr · desktop · no_cache=true(회차마다 새 표본 · 낡은 캐시의 만료 토큰을 받지 않음).
 * 지역형은 도시 위치 — 표(AIO_LOCATIONS)에 있는 지역만 쓴다. 「전북 군산」의 값은 Locations API로 고른 것이 아니라 2026-11-10 시험에서
 * location_requested와 location_used가 같게 받아들여진 것을 확인한 값이다(G1). 전국형 · B2B는 위치 없이 gl=kr만. 이 PC 설정 파일의
 * locations가 브랜드별로 덮어쓴다(파일로만). 표에 없는 지역형은 짐작하지 않고 재지 않는다. 조건은 서명(aioConditionSignature)으로 회차에
 * 적고, 바뀌면 「같은 조건」 비교(src/lib/comparability.ts compareConditions)가 「수집 모델 바뀜」으로 끊는다.
 *
 * ── 응답 읽기 — 질문마다 네 상태 ───────────────────────────────────────────────
 *   있음(shown)          ai_overview에 글자나 출처가 바로 옴(inline), 또는 page_token만 와서 후속 요청(engine=google_ai_overview)으로 받음(deferred).
 *   없음(absent)         검색은 성공했고 ai_overview 키가 없다. 결과 0건도 여기. 화면 「AI 개요 없음」 — 노출률 분모에만 든다(언급 · 출처 분모 밖).
 *   못 읽음(unreadable)  자리는 있었는데 내용을 못 받음(후속 만료 · 실패, error만, 글자도 출처도 없음, page_token이 요청 길이 상한을 넘음 —
 *                        보내지 않는다). 모든 분모에서 뺀다.
 *   오류(failed)         HTTP 오류 · 시간 초과 · 연결 실패 · 응답 모양 깨짐 · Success가 아닌 검색. 다시 보내지 않는다. 모든 분모에서 뺀다.
 * text_blocks는 줄글로 펼친다 — 모르는 type도 글자를 버리지 않는다. 출처는 references[]와 본문 안 snippet_links[]의 http(s) 주소만 받는다.
 * 원문 블록(rawBlock)은 page_token · serpapi_link를 빼고 64KB까지만 둔다(파서를 고친 뒤 다시 펼치려고).
 *
 * ── 지표 — 못 본 것은 0이 아니라 확인 불가(미측정 지표 정책) ─────────────────────
 * 분모가 0이거나 목록이 없으면 rate는 null(화면 「확인 불가」). 언급은 판정된 있음만(판정 불가 null은 따로 센다). 출처 지표는 출처 목록을 받은
 * 있음만 분모로 쓰고 「출처 없는 개요」는 따로 센다. 자사 출처 · 올린 글 출처는 저장하지 않고 읽을 때 지금의 자사 주소 · 원장 · 앱 밖 글로
 * 계산한다(자사 주소 · 원장을 고치면 지난 회차에도 바로 적용). 올린 글은 그 글을 올린 뒤(timingOf 'after') · 올라가 있던 회차만 센다.
 * 요약 타일은 끝난(done) 회차나 잰 문항(있음 + 없음)이 예정의 90% 이상인 회차만 쓴다(실행기는 90% 미만이면 끝까지 갔어도 done으로 적지
 * 않는다). 회차끼리는 두 회차 모두에서 잰 질문만 견준다. 질문 표 · 추이 · 올린 글 표는 잰 문항이 있는 최신 회차와 같은 조건인 회차만 묶는다(추이 ·
 * 올린 글 표는 그중 요약 회차만). 한 번 측정은 흔들린다 — 두 번 이상 같은 방향일 때만 판단한다.
 *
 * 서버가 import하므로 상대 import는 .js로 쓰고, node 모듈 · 서버 모듈 · 화면 모듈은 끌어오지 않는다. 네트워크도 부르지 않는다.
 */
import { mentionsWord } from './aeo/entityMatch.js'
import { compareConditions, type ConditionDiff } from './comparability.js'
import { externalAsLedgerPost, externalViews, type ExternalPost } from './externalPosts.js'
import { GOOGLE_NO_RESULTS } from './indexAuto.js'
import { ownedUrl } from './publishStatus.js'
import { isoWeekOf, kstDate, matchKind, postedAtIndex, timingOf, trackingKey, type MeasureWindow } from './publishedUrl.js'
import { isScoredAgnostic } from './questionScope.js'
import type { MarketScope, QuestionCategory } from '../prompts/types.js'

export const GOOGLE_AIO_FORMAT = 'google-aio/1'
export const GOOGLE_AIO_SETTINGS_FORMAT = 'google-aio-settings/1'
/** 이 PC 설정 파일이 없을 때의 시범 브랜드(스테이,머뭄). 다른 브랜드는 설정 파일 tenants에 더한다. */
export const AIO_DEFAULT_TENANTS: readonly string[] = ['web4ai']

/** 고정 검색 조건(D4 · D7). 키는 공용 연결(server/serpApi.ts)이 붙인다 — 여기에 넣지 않는다. */
export const AIO_SEARCH_PARAMS = { engine: 'google', google_domain: 'google.co.kr', gl: 'kr', hl: 'ko', device: 'desktop', no_cache: 'true' } as const
export const AIO_FOLLOW_UP_ENGINE = 'google_ai_overview'
/** 지역(tenant.region) → SerpAPI 위치. 「전북 군산」은 2026-11-10 시험의 location_used로 확인한 값(Locations API로 고른 값이 아니다). */
export const AIO_LOCATIONS: Readonly<Record<string, string>> = { '전북 군산': 'Gunsan-si,Jeollabuk-do,South Korea' }
/** 공용 연결이 받는 매개변수 값 길이 상한 — server/serpApi.ts checkRequest와 같은 수(시험이 둘이 같은지 본다). */
export const AIO_VALUE_MAX = 2048
/** 회차 파일에 적는 본문 길이(판정은 자르기 전 전체 본문으로 한다). */
export const AIO_TEXT_MAX = 16_000
/** 회차 파일에 두는 원문 블록 크기(UTF-8 바이트). 넘으면 싣지 않고 rawBlockOmitted. */
export const AIO_RAW_BLOCK_MAX = 64 * 1024
/** 못 읽음 다시 검색 — 회차당 질문의 이 비율(%, 올림)까지. */
export const AIO_RESEARCH_PCT = 10
/** 요약 타일에 쓰는 일부만 잰 회차 — 잰 문항이 예정의 이 비율(%) 이상(측정 MIN_QUESTION_COVERAGE 0.9와 같은 값). */
export const AIO_SUMMARY_PCT = 90
/** 앞 회차들의 노출률이 이보다 높았는데 한 회차가 0이면 경고한다(구글 · SerpAPI 쪽 변화가 조용히 「없음」이 되는 것을 막는 장치). */
export const AIO_DROP_FROM = 0.2
export const AIO_LOCATION_MAX = 200
export const AIO_NOISE_NOTE = '한 번 측정은 흔들립니다 — 두 번 이상 같은 방향일 때만 판단하세요'
/** 회차 id = 시작 시각의 ISO에서 : · .를 -로(윈도우 파일 이름 — server/pipeline.ts runId와 같은 꼴). 경로에 넣기 전에 이 꼴만 받는다. */
export const AIO_RUN_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/
const TENANT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
/** 작성자 칸에는 키(w1 …)만 싣는다 — 이름은 어떤 길로도 싣지 않는다. */
const WRITER_KEY = /^w[1-9]\d?$/
const REFS_MAX = 50
const LINKS_MAX = 50
const FIELD_MAX = 300
const MAX_DEPTH = 8

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const clean = (s: string) => s.replace(/\s+/g, ' ').trim()
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s)
const uniq = <T>(xs: readonly T[]) => [...new Set(xs)]

// ── 타입 ─────────────────────────────────────────────────────────────────────

export type AioStatus = 'shown' | 'absent' | 'unreadable' | 'failed'
export const AIO_STATUSES: readonly AioStatus[] = ['shown', 'absent', 'unreadable', 'failed']
export type AioKind = 'inline' | 'deferred'
/** 오류로 못 잼 — 다시 보내지 않는다. timeout · upstream · bad-query는 실행기가 적는다(HTTP 오류 · 시간 초과 · 보내기 전 거절). */
export type AioFailedReason = 'shape' | 'not-success' | 'upstream-error' | 'timeout' | 'upstream' | 'bad-query'
/**
 * 못 읽음 — follow-up-failed · follow-up-blocked는 실행기가 적는다(후속 요청 실패 · 몫 · 바닥에 막혀 후속을 보내지 않음). interrupted는 앱이
 * 꺼질 때 날아가던 검색의 질문(aioSettleInFlight — 보낸 검색은 세고 다시 보내지 않는다).
 */
export type AioUnreadableReason =
  | 'overview-error'
  | 'overview-empty'
  | 'overview-shape'
  | 'token-too-long'
  | 'follow-up-error'
  | 'follow-up-empty'
  | 'follow-up-shape'
  | 'follow-up-failed'
  | 'follow-up-blocked'
  | 'interrupted'
export type AioReason = AioFailedReason | AioUnreadableReason

export const AIO_STATUS_LABEL: Record<AioStatus, string> = { shown: '있음', absent: 'AI 개요 없음', unreadable: '못 읽음(확인 불가)', failed: '오류로 못 잼' }
export const AIO_REASON_TEXT: Record<AioReason, string> = {
  shape: 'SerpAPI 응답 모양을 읽지 못했어요',
  'not-success': 'SerpAPI가 검색을 끝내지 못했다고 알려 왔어요',
  'upstream-error': 'SerpAPI가 오류를 알려 왔어요',
  timeout: '응답이 늦어 끊었어요(다시 보내지 않아요)',
  upstream: 'SerpAPI 연결 오류(다시 보내지 않아요)',
  'bad-query': `질문 글자가 SerpAPI 요청 길이 상한(${AIO_VALUE_MAX}자)을 넘어 보내지 않았어요`,
  'overview-error': 'AI 개요 자리에 오류만 왔어요',
  'overview-empty': 'AI 개요 자리는 있었는데 글자도 출처도 없었어요',
  'overview-shape': 'AI 개요 모양을 읽지 못했어요',
  'token-too-long': `늦게 오는 개요의 토큰이 SerpAPI 요청 길이 상한(${AIO_VALUE_MAX}자)을 넘어 받으러 가지 않았어요`,
  'follow-up-error': '늦게 오는 개요를 받지 못했어요(만료 · 오류)',
  'follow-up-empty': '늦게 오는 개요를 받으러 갔지만 비어 있었어요',
  'follow-up-shape': '늦게 오는 개요 응답 모양을 읽지 못했어요',
  'follow-up-failed': '늦게 오는 개요를 받으러 간 요청이 실패했어요',
  'follow-up-blocked': '몫 · 계정 바닥에 닿아 늦게 오는 개요를 받으러 가지 않았어요',
  interrupted: '앱이 꺼질 때 받던 검색이라 결과를 받지 못했어요(보낸 검색은 셌고, 다시 보내지 않아요)',
}

export interface AioReference {
  index: number | null
  title: string | null
  link: string
  source: string | null
}

/** 읽은 AI 개요 — text는 자르기 전 전체 본문(판정용). 저장할 때 aioItemOf가 자른다. */
export interface AioOverview {
  text: string
  references: AioReference[]
  links: string[]
  rawBlock: unknown
  rawBlockOmitted?: true
}

export type AioReadResult =
  | { status: 'shown'; kind: AioKind; overview: AioOverview; searchId: string | null }
  | { status: 'absent'; noResults: boolean; topKeys: string[]; searchId: string | null }
  | { status: 'unreadable'; reason: AioUnreadableReason; topKeys: string[]; searchId: string | null; rawBlock?: unknown; rawBlockOmitted?: true }
  | { status: 'failed'; reason: AioFailedReason; topKeys: string[]; searchId: string | null }

/** 첫 검색(engine=google) 읽기 — 끝났거나, 늦게 오는 개요라 후속을 보낼 page_token. */
export type AioFirstRead = { step: 'done'; read: AioReadResult } | { step: 'follow-up'; pageToken: string; searchId: string | null }

/** 회차 파일의 문항 한 줄. 끝 상태가 있는 문항만 적는다(이어 재기는 없는 문항만 보낸다). */
export interface AioItem {
  questionId: string
  query: string
  status: AioStatus
  kind?: AioKind
  reason?: AioReason
  /** 16,000자까지 — 넘으면 truncated. */
  text?: string
  truncated?: boolean
  references?: AioReference[]
  /** 본문 안 snippet_links의 주소(http(s)). */
  links?: string[]
  rawBlock?: unknown
  rawBlockOmitted?: true
  /** 없음 · 못 읽음 · 오류일 때 응답 최상위 키 이름만(구글 · SerpAPI가 키 이름을 바꿔 조용히 「없음」이 되는 것을 바로 보려고). */
  topKeys?: string[]
  noResults?: true
  /** search_metadata.id(SerpAPI 보관 31일). */
  searchId?: string
  fetchedAt: string
  /** 이 문항에 보낸 검색 수(첫 검색 · 후속 · 다시 검색). */
  searches: number
  /** 키를 지운 짧은 까닭. */
  error?: string
  /** 판정 — true · false · null(판정 불가). 판정하지 않았으면 칸이 없다. */
  mentioned?: boolean | null
  mentionSentences?: string[]
  competitorMentions?: { name: string; count: number }[]
  judgeEngine?: string
  judgeModel?: string | null
  judgedAt?: string
  rejudgedAt?: string
}

export type AioRunState = 'running' | 'done' | 'partial' | 'cancelled' | 'interrupted'
export const AIO_RUN_STATES: readonly AioRunState[] = ['running', 'done', 'partial', 'cancelled', 'interrupted']

/** 판정 토큰 — 생각 토큰(Gemini)은 출력 단가로 청구되지만 출력에 들지 않아 따로 센다. */
export interface AioJudgeTokens {
  input: number
  output: number
  thought: number
}

export interface AioUsage {
  /** 이 회차가 보낸 SerpAPI 검색(첫 검색 · 후속 · 다시 검색 모두 — 공용 장부 sent와 같은 셈). */
  searches: number
  followUps: number
  reSearches: number
  judgeCalls: number
  judgeTokens: AioJudgeTokens
}

/** 「같은 조건」 칸 — src/lib/comparability.ts Card와 같은 이름(수집 엔진 'aio' · 수집 모델 = 조건 서명). */
export interface AioConditions {
  weekOf: string
  enginesUsed: string[]
  modelsUsed: Record<string, string>
  judgeEngine: string | null
  judgeModel: string | null
  questionBankVersion: string
  repeatsPerQuestion: number
  location: string | null
}

export interface AioQuestionSet {
  scope: 'scored-agnostic'
  /** 질문지 순서. */
  ids: string[]
  /** 질문 id · 문장 지문(16자). */
  hash: string
}

/**
 * 날아가는 검색 — 실행기가 검색을 보내기 직전에 회차 파일에 적고(usage.searches도 그때 센다 — 공용 장부와 같은 규칙), 그 질문의 문항을 적을 때
 * 지운다. 앱이 꺼져 이 칸이 남은 회차는 그 질문을 「못 읽음(interrupted)」으로 마무리한다 — 이어 재기가 같은 질문을 다시 사지 않게.
 */
export interface AioInFlight {
  questionId: string
  query: string
  /** 그 질문에 지금까지 보낸 검색(날아가는 것 포함). */
  searches: number
  at: string
}

export interface AioRun {
  format: typeof GOOGLE_AIO_FORMAT
  runId: string
  tenantId: string
  startedAt: string
  finishedAt: string | null
  state: AioRunState
  stopReason?: string | null
  stopMessage?: string | null
  conditions: AioConditions
  /** 원래 판 글자('v6') — 질문 id 접두로는 판을 짐작할 수 없다. */
  bankVersion: string
  cohortBank: { key: string; version: string } | null
  questionSet: AioQuestionSet
  /** 시작 때 예약한 최대 검색 수 M — 보낸 검색이 이를 넘지 않는다. */
  maxSearches: number
  /** 시작 때 결제 주기(plan_renewal_date). */
  cycle: string | null
  usage: AioUsage
  items: AioItem[]
  /** 날아가는 검색(실행기만 적는다 — 없으면 칸이 없거나 null). */
  inFlight?: AioInFlight | null
}

export interface AioSettings {
  format: typeof GOOGLE_AIO_SETTINGS_FORMAT
  enabled: boolean
  tenants: string[]
  locations: Record<string, string>
}

// ── 검색 조건 ─────────────────────────────────────────────────────────────────

/** 첫 검색 매개변수 — 검색어는 질문 원문 그대로(앞뒤 공백만 뗀다 — 질문 지문과 같은 글자). 위치가 없으면 location 칸이 없다(gl=kr만). */
export function aioSearchParams(query: string, location: string | null): Record<string, string> {
  const { engine, ...fixed } = AIO_SEARCH_PARAMS
  return { engine, q: query.trim(), ...fixed, ...(location ? { location } : {}) }
}

/**
 * 공용 연결(server/serpApi.ts checkRequest)이 받는 값 길이인가 — 넘으면 그 연결이 보내지 않고 bad-request를 던진다. 실행기는 보내기 전에
 * 이것으로 가려 그 문항만 「오류로 못 잼」(bad-query) · 「못 읽음」(token-too-long)으로 두고, HTTP 400 멈춤과 섞지 않는다.
 */
export function aioParamsFit(params: Readonly<Record<string, string>>): boolean {
  return Object.values(params).every((v) => v.length <= AIO_VALUE_MAX)
}

/** 늦게 오는 개요 후속 — 응답 안의 serpapi_link를 따라가지 않고 고정 엔진 + page_token으로 직접 만든다. */
export function aioFollowUpParams(pageToken: string): Record<string, string> {
  return { engine: AIO_FOLLOW_UP_ENGINE, page_token: pageToken, no_cache: AIO_SEARCH_PARAMS.no_cache }
}

/** 위치 값으로 받는 글자 — 비지 않고 · 200자까지 · 제어 문자 없음. */
export function validLocation(v: unknown): v is string {
  if (!isStr(v) || !v.trim() || v.length > AIO_LOCATION_MAX) return false
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return false
  }
  return true
}

export type AioLocation = { ok: true; location: string | null } | { ok: false; reason: 'no-location'; region: string }

/**
 * 이 브랜드의 검색 위치. 이 PC 설정(locations — 파일로만)이 먼저, 다음 전국형 · B2B는 위치 없음, 지역형은 표의 값. 표에 없는 지역형은
 * 짐작하지 않는다(no-location — 재지 않는다).
 */
export function aioLocationFor(
  brand: { tenantId: string; region?: string | null; marketScope?: MarketScope | null },
  overrides: Readonly<Record<string, string>> = {},
): AioLocation {
  const own = Object.hasOwn(overrides, brand.tenantId) ? overrides[brand.tenantId] : undefined
  if (validLocation(own)) return { ok: true, location: own }
  if (brand.marketScope === 'national' || brand.marketScope === 'b2b') return { ok: true, location: null }
  const region = clean(brand.region ?? '')
  const fixed = Object.hasOwn(AIO_LOCATIONS, region) ? AIO_LOCATIONS[region] : undefined
  return fixed ? { ok: true, location: fixed } : { ok: false, reason: 'no-location', region }
}

/** 조건 서명 — 회차 conditions.modelsUsed.aio. 위치 · 기기 · 캐시가 바뀌면 「같은 조건」 비교가 끊긴다. 검색어는 들지 않는다. */
export function aioConditionSignature(location: string | null): string {
  const p = AIO_SEARCH_PARAMS
  return `google-aio serpapi hl=${p.hl} gl=${p.gl} dom=${p.google_domain} loc=${location ?? '없음'} dev=${p.device} cache=${p.no_cache === 'true' ? 'off' : 'on'}`
}

// ── 질문 · 지문 · 시작 조건 ─────────────────────────────────────────────────────

/** 점수에 세는 이름 없는 질문(isScoredAgnostic)만 — 질문지 순서 그대로. 문장이 빈 문항은 뺀다. */
export function aioQuestionsOf<Q extends { questionId: string; text: string; category: QuestionCategory; probe?: boolean }>(questions: readonly Q[]): Q[] {
  return questions.filter((q) => isScoredAgnostic(q) && isStr(q.text) && q.text.trim().length > 0)
}

/** FNV-1a 64비트(UTF-16 단위) — 지문용(암호용 아님). */
function fnv64(text: string): string {
  let h = 0xcbf29ce484222325n
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i))
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return h.toString(16).padStart(16, '0')
}

/** 질문 묶음 — ids는 질문지 순서, hash는 (id · 문장) 집합의 지문(순서와 무관, 문장이 바뀌면 바뀐다 — 검색어가 바뀌므로). */
export function aioQuestionSet(questions: readonly { questionId: string; text: string }[]): AioQuestionSet {
  const lines = questions.map((q) => `${q.questionId}\n${q.text.trim()}`).sort()
  return { scope: 'scored-agnostic', ids: questions.map((q) => q.questionId), hash: fnv64(lines.join('\n\n')) }
}

/** 질문지 칸 — 「v6 · 이름 없는 50문항 #ab12cd」. 같은 판에 문항이 더해져도 「질문지」 바뀜으로 잡힌다. */
export function aioBankLabel(bankVersion: string, count: number, hash: string): string {
  return `${bankVersion} · 이름 없는 ${count}문항 #${hash.slice(0, 6)}`
}

/** 못 읽음 다시 검색 상한(문항 수) — 질문의 10% 올림. */
export function aioReSearchCap(questions: number): number {
  const n = Math.max(0, Math.floor(questions))
  return Math.ceil((n * AIO_RESEARCH_PCT) / 100)
}

/**
 * 한 회차의 최대 검색 수 M = 2n + 2·⌈0.1n⌉ — 늦게 오는 개요는 질문당 2회, 못 읽음 다시 검색도 2회씩. 실제는 n + (뜬 개요 × 늦게 오는 비율)
 * + 다시 검색이라 50문항이면 50~110회다. 시작 조건은 남은 몫이 M 이상일 때만이고, 회차를 줄여 시작하지 않는다.
 */
export function aioMaxSearches(questions: number): number {
  const n = Math.max(0, Math.floor(questions))
  return 2 * n + 2 * aioReSearchCap(n)
}

/** 회차 조건 칸. weekOf는 시작 시각의 한국 날짜 ISO 주. 판정 모델은 판정 결과가 실어 온 값만 쓴다(없으면 null). */
export function aioConditions(input: {
  startedAt: string
  location: string | null
  bankVersion: string
  questionSet: AioQuestionSet
  judgeEngine: string | null
  judgeModel: string | null
}): AioConditions {
  const day = kstDate(input.startedAt)
  return {
    weekOf: (day ? isoWeekOf(day) : null) ?? '',
    enginesUsed: ['aio'],
    modelsUsed: { aio: aioConditionSignature(input.location) },
    judgeEngine: input.judgeEngine,
    judgeModel: input.judgeModel,
    questionBankVersion: aioBankLabel(input.bankVersion, input.questionSet.ids.length, input.questionSet.hash),
    repeatsPerQuestion: 1,
    location: input.location,
  }
}

export function aioRunId(startedAt: Date): string {
  return startedAt.toISOString().replace(/[:.]/g, '-')
}

// ── 응답 읽기 ─────────────────────────────────────────────────────────────────

/** 본문에 넣지 않는 칸 — 링크 · 그림 · 좌표 · 번호 같은 기계 칸. snippet_links의 글자는 snippet에 이미 있다. */
const SKIP_KEYS = new Set([
  'type',
  'reference_indexes',
  'snippet_highlighted_words',
  'snippet_links',
  'link',
  'links',
  'url',
  'serpapi_link',
  'page_token',
  'api_key',
  'thumbnail',
  'thumbnails',
  'source_icon',
  'favicon',
  'icon',
  'image',
  'images',
  'video',
  'videos',
  'gps_coordinates',
  'data_cid',
  'data_cid_search',
  'provider_id',
  'index',
  'position',
  'id',
])
const TEXT_FIRST = ['title', 'snippet']

function orderedEntries(o: Record<string, unknown>): [string, unknown][] {
  const keys = Object.keys(o)
  return [...TEXT_FIRST.filter((k) => keys.includes(k)), ...keys.filter((k) => !TEXT_FIRST.includes(k))].map((k) => [k, o[k]])
}

function nodeLines(node: unknown, indent: string, depth: number): string[] {
  if (depth > MAX_DEPTH) return []
  if (isStr(node)) {
    const t = clean(node)
    return t ? [indent + t] : []
  }
  if (Array.isArray(node)) {
    // 글자 · 숫자만 든 배열은 표의 한 줄이다.
    if (node.length > 0 && node.every((x) => isStr(x) || isNum(x))) {
      const row = node.map((x) => clean(String(x))).filter(Boolean).join(' | ')
      return row ? [indent + row] : []
    }
    return node.flatMap((x) => nodeLines(x, indent, depth + 1))
  }
  if (!isObj(node)) return []
  const own: string[] = []
  const kids: string[] = []
  for (const [k, v] of orderedEntries(node)) {
    if (SKIP_KEYS.has(k)) continue
    if (isStr(v)) {
      const t = clean(v)
      if (t) own.push(t)
    } else if (k === 'list' && Array.isArray(v)) {
      kids.push(...listLines(v, indent, depth + 1))
    } else if (Array.isArray(v) || isObj(v)) {
      kids.push(...nodeLines(v, indent, depth + 1))
    }
  }
  return own.length ? [indent + own.join(' — '), ...kids] : kids
}

function listLines(items: unknown[], indent: string, depth: number): string[] {
  return items.flatMap((item) => {
    const lines = nodeLines(item, `${indent}  `, depth)
    return lines.length ? [`${indent}- ${lines[0]!.trimStart()}`, ...lines.slice(1)] : []
  })
}

/**
 * text_blocks → 줄글 줄. 문단 · 제목은 한 줄, 목록은 「- 」 줄(안쪽 목록은 들여 씀), 표 · 비교는 칸을 「 | 」로. 모르는 type은 그 안의 title ·
 * snippet · 글자 칸과 안쪽 항목을 펼친다(버리지 않는다). 링크 · 그림 · 좌표 같은 칸은 넣지 않는다.
 */
export function flattenTextBlocks(blocks: readonly unknown[]): string[] {
  return blocks.flatMap((b) => nodeLines(b, '', 0))
}

/** http(s) 주소만 — 공용 상한보다 긴 주소 · 상대 주소 · 다른 scheme은 버린다. */
function httpUrl(v: unknown): string | null {
  if (!isStr(v)) return null
  const s = v.trim()
  if (!s || s.length > AIO_VALUE_MAX) return null
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:' ? s : null
  } catch {
    // 주소로 읽히지 않는 값 — 출처로 받지 않는다.
    return null
  }
}

const textField = (v: unknown): string | null => (isStr(v) && clean(v) ? clip(clean(v), FIELD_MAX) : null)

function referencesOf(v: unknown): AioReference[] {
  if (!Array.isArray(v)) return []
  const out: AioReference[] = []
  for (const r of v.slice(0, REFS_MAX)) {
    if (!isObj(r)) continue
    const link = httpUrl(r.link)
    if (!link) continue
    out.push({ index: isNum(r.index) && Number.isInteger(r.index) ? r.index : null, title: textField(r.title), link, source: textField(r.source) })
  }
  return out
}

function linksOf(node: unknown, out: string[], depth: number): string[] {
  if (depth > MAX_DEPTH || out.length >= LINKS_MAX) return out
  if (Array.isArray(node)) {
    for (const x of node) linksOf(x, out, depth + 1)
    return out
  }
  if (!isObj(node)) return out
  for (const [k, v] of Object.entries(node)) {
    if (k === 'snippet_links' && Array.isArray(v)) {
      for (const l of v) {
        const u = isObj(l) ? httpUrl(l.link) : null
        if (u && !out.includes(u) && out.length < LINKS_MAX) out.push(u)
      }
    } else if (Array.isArray(v) || isObj(v)) {
      linksOf(v, out, depth + 1)
    }
  }
  return out
}

/** UTF-8 바이트 수. */
function utf8Length(s: string): number {
  let n = 0
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
  }
  return n
}

/** 원문 블록에서 늘 빼는 칸 — 다시 쓸 수 있는 토큰 · 키를 붙여 부르는 주소 · 계정 칸(응답 블록에 섞여 와도 싣지 않는다). */
const RAW_DROP = new Set(['page_token', 'serpapi_link', 'api_key', 'account_id', 'account_email'])

function withoutRawDrop(v: unknown, depth: number): unknown {
  if (depth > 20) return null
  if (Array.isArray(v)) return v.map((x) => withoutRawDrop(x, depth + 1))
  if (!isObj(v)) return v
  const o: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) if (!RAW_DROP.has(k)) o[k] = withoutRawDrop(x, depth + 1)
  return o
}

/** 원문 블록 — page_token · serpapi_link · api_key · 계정 칸을 어느 깊이에서든 뺀 사본. 64KB를 넘으면 싣지 않는다. */
export function scrubRawBlock(block: unknown): { rawBlock: unknown } | { rawBlockOmitted: true } {
  const copy = withoutRawDrop(block, 0)
  return utf8Length(JSON.stringify(copy) ?? '') > AIO_RAW_BLOCK_MAX ? { rawBlockOmitted: true } : { rawBlock: copy }
}

function overviewOf(aio: Record<string, unknown>): AioOverview {
  const blocks = Array.isArray(aio.text_blocks) ? aio.text_blocks : []
  const raw = scrubRawBlock(aio)
  return {
    text: flattenTextBlocks(blocks).join('\n'),
    references: referencesOf(aio.references),
    links: linksOf(blocks, [], 0),
    ...('rawBlock' in raw ? { rawBlock: raw.rawBlock } : { rawBlock: null, rawBlockOmitted: true as const }),
  }
}

const hasContent = (o: AioOverview) => o.text.length > 0 || o.references.length > 0
const topKeysOf = (json: Record<string, unknown>) => Object.keys(json).slice(0, 40).map((k) => clip(k, 60))
function searchIdOf(json: Record<string, unknown>): string | null {
  const m = json.search_metadata
  return isObj(m) && isStr(m.id) && m.id && m.id.length <= 120 ? m.id : null
}
const rawOf = (aio: Record<string, unknown>): { rawBlock?: unknown; rawBlockOmitted?: true } => scrubRawBlock(aio)

/**
 * 첫 검색(engine=google · HTTP 200) 한 건 읽기. 위에서부터: 메타 없음 → 오류(shape), Success 아님 → 오류, ai_overview 없음 → 없음(결과 0건
 * 문구면 noResults, 다른 error면 오류), ai_overview가 객체가 아님 → 못 읽음, 글자나 출처가 있음 → 있음(inline), page_token → 후속(상한을
 * 넘으면 보내지 않고 못 읽음), error만 → 못 읽음, 그 밖 → 못 읽음(비어 있음).
 */
export function readAioFirst(json: unknown): AioFirstRead {
  const done = (read: AioReadResult): AioFirstRead => ({ step: 'done', read })
  if (!isObj(json) || !isObj(json.search_metadata)) return done({ status: 'failed', reason: 'shape', topKeys: isObj(json) ? topKeysOf(json) : [], searchId: null })
  const topKeys = topKeysOf(json)
  const searchId = searchIdOf(json)
  if (json.search_metadata.status !== 'Success') return done({ status: 'failed', reason: 'not-success', topKeys, searchId })
  const aio = json.ai_overview
  if (aio === undefined) {
    if (json.error === undefined) return done({ status: 'absent', noResults: false, topKeys, searchId })
    return done(json.error === GOOGLE_NO_RESULTS ? { status: 'absent', noResults: true, topKeys, searchId } : { status: 'failed', reason: 'upstream-error', topKeys, searchId })
  }
  if (!isObj(aio)) return done({ status: 'unreadable', reason: 'overview-shape', topKeys, searchId })
  const overview = overviewOf(aio)
  if (hasContent(overview)) return done({ status: 'shown', kind: 'inline', overview, searchId })
  if (isStr(aio.page_token) && aio.page_token) {
    if (aio.page_token.length > AIO_VALUE_MAX) return done({ status: 'unreadable', reason: 'token-too-long', topKeys, searchId, ...rawOf(aio) })
    return { step: 'follow-up', pageToken: aio.page_token, searchId }
  }
  return done({ status: 'unreadable', reason: aio.error !== undefined ? 'overview-error' : 'overview-empty', topKeys, searchId, ...rawOf(aio) })
}

/**
 * 후속(engine=google_ai_overview · HTTP 200) 한 건 읽기 — 있음(deferred)이 아니면 모두 못 읽음이다(첫 검색에서 자리는 있었다). page_token이
 * 또 와도 따라가지 않는다.
 */
export function readAioFollowUp(json: unknown): AioReadResult {
  if (!isObj(json) || !isObj(json.search_metadata)) return { status: 'unreadable', reason: 'follow-up-shape', topKeys: isObj(json) ? topKeysOf(json) : [], searchId: null }
  const topKeys = topKeysOf(json)
  const searchId = searchIdOf(json)
  // 메타는 있는데 Success가 아니면 SerpAPI가 받으러 간 개요를 내주지 못했다(만료 · 오류) — 모양이 깨진 것과 가른다.
  if (json.search_metadata.status !== 'Success') return { status: 'unreadable', reason: 'follow-up-error', topKeys, searchId }
  const aio = json.ai_overview
  if (aio === undefined) return { status: 'unreadable', reason: json.error !== undefined ? 'follow-up-error' : 'follow-up-empty', topKeys, searchId }
  if (!isObj(aio)) return { status: 'unreadable', reason: 'follow-up-shape', topKeys, searchId }
  const overview = overviewOf(aio)
  if (hasContent(overview)) return { status: 'shown', kind: 'deferred', overview, searchId }
  return { status: 'unreadable', reason: aio.error !== undefined || json.error !== undefined ? 'follow-up-error' : 'follow-up-empty', topKeys, searchId, ...rawOf(aio) }
}

/** 저장용 본문 — 16,000자까지. */
export function clipAioText(text: string): { text: string; truncated: boolean } {
  return text.length > AIO_TEXT_MAX ? { text: text.slice(0, AIO_TEXT_MAX), truncated: true } : { text, truncated: false }
}

/** 읽은 결과 → 회차 파일 문항 한 줄(판정 칸은 판정 뒤에 더한다). */
export function aioItemOf(q: { questionId: string; query: string }, read: AioReadResult, meta: { fetchedAt: string; searches: number; error?: string | null }): AioItem {
  const base: AioItem = {
    questionId: q.questionId,
    query: q.query,
    status: read.status,
    fetchedAt: meta.fetchedAt,
    searches: meta.searches,
    ...(read.searchId ? { searchId: read.searchId } : {}),
    ...(meta.error ? { error: clip(meta.error, FIELD_MAX) } : {}),
  }
  switch (read.status) {
    case 'shown': {
      const { text, truncated } = clipAioText(read.overview.text)
      return {
        ...base,
        kind: read.kind,
        text,
        ...(truncated ? { truncated: true } : {}),
        references: read.overview.references,
        links: read.overview.links,
        ...(read.overview.rawBlockOmitted ? { rawBlockOmitted: true as const } : { rawBlock: read.overview.rawBlock }),
      }
    }
    case 'absent':
      return { ...base, topKeys: read.topKeys, ...(read.noResults ? { noResults: true as const } : {}) }
    case 'unreadable':
      return {
        ...base,
        reason: read.reason,
        topKeys: read.topKeys,
        ...(read.rawBlockOmitted ? { rawBlockOmitted: true as const } : read.rawBlock !== undefined ? { rawBlock: read.rawBlock } : {}),
      }
    case 'failed':
      return { ...base, reason: read.reason, topKeys: read.topKeys }
  }
}

// ── 언급 판정(b5a) 읽기 ─────────────────────────────────────────────────────────

export interface AioMentionVerdict {
  /** null = 판정 불가(응답을 못 읽음) — 미언급(false)으로 세지 않는다(측정의 `?? false`를 따르지 않는다). */
  mentioned: boolean | null
  sentences: string[]
  competitors: { name: string; count: number }[]
}

/** 판정 응답(parseJsonLoose 결과) → 언급 · 문장 · 경쟁사. 모양이 틀리면 판정 불가. */
export function readMentionVerdict(parsed: unknown): AioMentionVerdict {
  const target = isObj(parsed) && isObj(parsed.targetBrand) ? parsed.targetBrand : null
  if (!isObj(parsed) || !target || typeof target.mentioned !== 'boolean') return { mentioned: null, sentences: [], competitors: [] }
  const sentences = (Array.isArray(target.mentions) ? target.mentions : [])
    .flatMap((m) => (isObj(m) && isStr(m.sentence) && clean(m.sentence) ? [clip(clean(m.sentence), FIELD_MAX)] : []))
    .slice(0, 10)
  const competitors = (Array.isArray(parsed.competitorMentions) ? parsed.competitorMentions : [])
    .flatMap((c) => {
      if (!isObj(c) || !isStr(c.name) || !c.name.trim()) return []
      const count = isNum(c.mentionCount) ? Math.floor(c.mentionCount) : Array.isArray(c.mentions) ? c.mentions.length : 0
      return count > 0 ? [{ name: clip(c.name.trim(), 100), count }] : []
    })
    .slice(0, REFS_MAX)
  return { mentioned: target.mentioned, sentences, competitors }
}

// ── 판정 비용 ─────────────────────────────────────────────────────────────────

export function addJudgeTokens(a: AioJudgeTokens, b: Partial<AioJudgeTokens>): AioJudgeTokens {
  const n = (v: number | undefined) => (isNum(v) && v > 0 ? v : 0)
  return { input: a.input + n(b.input), output: a.output + n(b.output), thought: a.thought + n(b.thought) }
}

/**
 * 판정 비용(USD 등 단가 통화) = 입력 × 입력 단가 + (출력 + 생각) × 출력 단가(server/usageStats.ts thoughtTokensOf와 같은 규칙 — 생각 토큰은
 * 출력 단가로 청구된다). 판정이 0회면 0, 단가가 없거나 토큰 기록이 없으면 null(0 아님).
 */
export function judgeCostOf(usage: { judgeCalls: number; judgeTokens: AioJudgeTokens }, rate: { inputPerM?: number; outputPerM?: number } | null | undefined): number | null {
  if (usage.judgeCalls <= 0) return 0
  const t = usage.judgeTokens
  if (t.input + t.output + t.thought <= 0) return null
  if (!rate || !isNum(rate.inputPerM) || !isNum(rate.outputPerM)) return null
  return (t.input * rate.inputPerM + (t.output + t.thought) * rate.outputPerM) / 1_000_000
}

// ── 이 PC 설정 · 회차 파일 읽기 ─────────────────────────────────────────────────

type Parsed<T> = { ok: true } & T
type ParseError = { ok: false; error: string }

/** 이 PC 설정(stateFilePath('google-aio-settings.json')) — 파일이 없으면(undefined) 기본(꺼짐). 모양이 틀리면 오류(켜짐으로 짐작하지 않는다). */
export function parseAioSettings(raw: unknown): Parsed<{ settings: AioSettings }> | ParseError {
  const base: AioSettings = { format: GOOGLE_AIO_SETTINGS_FORMAT, enabled: false, tenants: [...AIO_DEFAULT_TENANTS], locations: {} }
  if (raw === undefined) return { ok: true, settings: base }
  if (!isObj(raw)) return { ok: false, error: '설정 파일이 객체가 아닙니다' }
  if (raw.format !== undefined && raw.format !== GOOGLE_AIO_SETTINGS_FORMAT) return { ok: false, error: '설정 파일 형식이 다릅니다' }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') return { ok: false, error: 'enabled는 참 · 거짓이어야 합니다' }
  let tenants = base.tenants
  if (raw.tenants !== undefined) {
    if (!Array.isArray(raw.tenants) || !raw.tenants.every((t) => isStr(t) && TENANT_ID.test(t))) return { ok: false, error: 'tenants는 브랜드 id 목록이어야 합니다' }
    tenants = uniq(raw.tenants as string[]).slice(0, 20)
  }
  const locations: Record<string, string> = {}
  if (raw.locations !== undefined) {
    if (!isObj(raw.locations)) return { ok: false, error: 'locations는 객체여야 합니다' }
    for (const [k, v] of Object.entries(raw.locations)) {
      if (!TENANT_ID.test(k) || !validLocation(v)) return { ok: false, error: `locations.${clip(k, 64)} 값이 올바르지 않습니다` }
      locations[k] = v
    }
  }
  return { ok: true, settings: { format: GOOGLE_AIO_SETTINGS_FORMAT, enabled: raw.enabled === true, tenants, locations } }
}

const isTime = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v))

/** 없음(undefined · null)이거나 글자. */
const optStr = (v: unknown) => v === undefined || v === null || isStr(v)

/** 읽을 때 계산이 기대는 칸을 모두 본다 — 깨진 칸 하나로 화면 전체가 멈추지 않고 그 회차만 「읽지 못한 회차」가 되게. */
function itemProblem(i: unknown): string | null {
  if (!isObj(i)) return '문항이 객체가 아닙니다'
  if (!isStr(i.questionId) || !i.questionId) return '문항 id가 없습니다'
  const at = `문항 ${clip(i.questionId, 40)}`
  if (!AIO_STATUSES.includes(i.status as AioStatus)) return `${at}의 상태가 올바르지 않습니다`
  if (!isTime(i.fetchedAt)) return `${at}의 시각이 올바르지 않습니다`
  if (!isStr(i.query) || !isNum(i.searches)) return `${at}의 칸이 모자랍니다`
  if (i.text !== undefined && !isStr(i.text)) return `${at}의 본문이 올바르지 않습니다`
  if (i.kind !== undefined && i.kind !== 'inline' && i.kind !== 'deferred') return `${at}의 개요 종류가 올바르지 않습니다`
  if (![i.reason, i.error, i.searchId, i.judgedAt, i.rejudgedAt].every(optStr)) return `${at}의 글자 칸이 올바르지 않습니다`
  if (i.truncated !== undefined && typeof i.truncated !== 'boolean') return `${at}의 잘림 표시가 올바르지 않습니다`
  if (![i.topKeys, i.mentionSentences].every((v) => v === undefined || (Array.isArray(v) && v.every(isStr)))) return `${at}의 목록 칸이 올바르지 않습니다`
  if (i.mentioned !== undefined && i.mentioned !== null && typeof i.mentioned !== 'boolean') return `${at}의 판정이 올바르지 않습니다`
  if (!optStr(i.judgeEngine) || !optStr(i.judgeModel)) return `${at}의 판정 엔진 칸이 올바르지 않습니다`
  if (i.references !== undefined && (!Array.isArray(i.references) || !i.references.every((r) => isObj(r) && isStr(r.link) && optStr(r.title) && optStr(r.source)))) {
    return `${at}의 출처가 올바르지 않습니다`
  }
  if (i.links !== undefined && (!Array.isArray(i.links) || !i.links.every(isStr))) return `${at}의 링크가 올바르지 않습니다`
  if (i.competitorMentions !== undefined && (!Array.isArray(i.competitorMentions) || !i.competitorMentions.every((c) => isObj(c) && isStr(c.name) && isNum(c.count)))) {
    return `${at}의 경쟁사 칸이 올바르지 않습니다`
  }
  return null
}

/** 회차 파일 읽기 — 모양이 틀리면 오류(화면은 「읽지 못한 회차 n개」로 숨기지 않고 센다). */
export function parseAioRun(raw: unknown): Parsed<{ run: AioRun }> | ParseError {
  const bad = (error: string): ParseError => ({ ok: false, error })
  if (!isObj(raw)) return bad('회차 파일이 객체가 아닙니다')
  if (raw.format !== GOOGLE_AIO_FORMAT) return bad('회차 파일 형식이 다릅니다')
  if (!isStr(raw.runId) || !AIO_RUN_ID.test(raw.runId)) return bad('회차 id가 올바르지 않습니다')
  if (!isStr(raw.tenantId) || !TENANT_ID.test(raw.tenantId)) return bad('브랜드 id가 올바르지 않습니다')
  if (!isTime(raw.startedAt) || (raw.finishedAt !== null && !isTime(raw.finishedAt))) return bad('시각이 올바르지 않습니다')
  if (!AIO_RUN_STATES.includes(raw.state as AioRunState)) return bad('상태가 올바르지 않습니다')
  if (![raw.stopReason, raw.stopMessage].every(optStr) || !(raw.cycle === null || isStr(raw.cycle))) return bad('멈춘 까닭 · 결제 주기 칸이 올바르지 않습니다')
  const cb = raw.cohortBank
  if (cb !== null && !(isObj(cb) && isStr(cb.key) && isStr(cb.version))) return bad('코호트 질문지 칸이 올바르지 않습니다')
  const c = raw.conditions
  if (
    !isObj(c) ||
    !isStr(c.weekOf) ||
    !Array.isArray(c.enginesUsed) ||
    !c.enginesUsed.every(isStr) ||
    !isObj(c.modelsUsed) ||
    !Object.values(c.modelsUsed).every(isStr) ||
    !isStr(c.questionBankVersion) ||
    !isNum(c.repeatsPerQuestion) ||
    !optStr(c.judgeEngine) ||
    !optStr(c.judgeModel) ||
    !optStr(c.location)
  ) {
    return bad('조건 칸이 올바르지 않습니다')
  }
  if (!isStr(raw.bankVersion)) return bad('질문지 판이 없습니다')
  const q = raw.questionSet
  if (!isObj(q) || !Array.isArray(q.ids) || !q.ids.every(isStr) || !isStr(q.hash)) return bad('질문 묶음이 올바르지 않습니다')
  const u = raw.usage
  const t = isObj(u) ? u.judgeTokens : null
  if (!isObj(u) || ![u.searches, u.followUps, u.reSearches, u.judgeCalls].every(isNum) || !isObj(t) || ![t.input, t.output, t.thought].every(isNum)) {
    return bad('사용량 칸이 올바르지 않습니다')
  }
  if (!isNum(raw.maxSearches)) return bad('최대 검색 수가 없습니다')
  const f = raw.inFlight
  if (f !== undefined && f !== null && !(isObj(f) && isStr(f.questionId) && f.questionId && isStr(f.query) && isNum(f.searches) && isTime(f.at))) return bad('날아가는 검색 칸이 올바르지 않습니다')
  if (!Array.isArray(raw.items)) return bad('문항 목록이 없습니다')
  for (const i of raw.items) {
    const p = itemProblem(i)
    if (p) return bad(p)
  }
  return { ok: true, run: raw as unknown as AioRun }
}

// ── 이어 재기 ─────────────────────────────────────────────────────────────────

/** 문항마다 마지막 기록 하나(같은 문항이 두 번 적혔으면 나중 것) — 질문 묶음 순서, 묶음 밖 문항은 뺀다. */
function latestItems(run: AioRun): AioItem[] {
  const by = new Map<string, AioItem>()
  for (const i of run.items) by.set(i.questionId, i)
  return run.questionSet.ids.flatMap((id) => {
    const i = by.get(id)
    return i ? [i] : []
  })
}

/** 끝 상태가 없는 문항 — 이어 재기는 이것만 보낸다(이중 과금 없음). */
export function aioRemaining(run: AioRun): string[] {
  const done = new Set(run.items.map((i) => i.questionId))
  return run.questionSet.ids.filter((id) => !done.has(id))
}

/**
 * 앱이 꺼져 날아가는 검색(inFlight)이 남은 회차 — 그 질문을 「못 읽음(interrupted)」 문항으로 마무리한 사본(보낸 검색 수는 그 문항에 남는다).
 * 회차의 usage.searches는 보내기 전에 이미 셌으므로 고치지 않는다. 날아가는 검색이 없거나 그 질문의 문항이 이미 있으면 칸만 지운다.
 */
export function aioSettleInFlight(run: AioRun): AioRun {
  const f = run.inFlight
  if (!f) return run.inFlight === undefined ? run : { ...run, inFlight: null }
  if (run.items.some((i) => i.questionId === f.questionId) || !run.questionSet.ids.includes(f.questionId)) return { ...run, inFlight: null }
  const item: AioItem = { questionId: f.questionId, query: f.query, status: 'unreadable', reason: 'interrupted', topKeys: [], fetchedAt: f.at, searches: Math.max(0, Math.floor(f.searches)) }
  return { ...run, items: [...run.items, item], inFlight: null }
}

/** 잰 문항(있음 + 없음) · 예정 · 못 읽음 · 오류 — 문항마다 마지막 기록으로. */
export function aioCoverage(run: AioRun): { planned: number; measured: number; unreadable: number; failed: number } {
  const items = latestItems(run)
  return {
    planned: run.questionSet.ids.length,
    measured: items.filter(isMeasured).length,
    unreadable: items.filter((i) => i.status === 'unreadable').length,
    failed: items.filter((i) => i.status === 'failed').length,
  }
}

/** 잰 문항이 예정의 90% 이상인가(측정 MIN_QUESTION_COVERAGE와 같은 값). 실행기는 이보다 적으면 끝까지 갔어도 'done'이 아니라 'partial'로 적는다. */
export function aioEnoughMeasured(run: AioRun): boolean {
  const { planned, measured } = aioCoverage(run)
  return planned > 0 && measured * 100 >= planned * AIO_SUMMARY_PCT
}

export type AioResumeProblem = 'not-stopped' | 'other-day' | 'conditions' | 'judge-engine' | 'questions' | 'nothing-left'

/**
 * 이어 재도 되는가 — 멈춘(partial · cancelled · interrupted) 회차가 같은 한국 날짜 · 같은 조건 서명 · 같은 판정 엔진 · 같은 질문 지문이고 남은 문항이
 * 있을 때만. 날이 넘으면 새 회차로 한다(한 회차 표본이 여러 날에 걸치면 흔들림 해석이 섞인다). 판정 엔진은 회차를 시작할 때의 엔진
 * (conditions.judgeEngine)과 지금 엔진을 견준다 — 한 회차 안에서 언급 판정 기준이 섞이지 않게(2026-11-11 사용자 결정 ③). 시작 엔진을 모르는
 * 회차(null)도 거절한다.
 */
export function aioResumeProblem(run: AioRun, want: { today: string; signature: string; fingerprint: string; judgeEngine: string }): AioResumeProblem | null {
  if (run.state !== 'partial' && run.state !== 'cancelled' && run.state !== 'interrupted') return 'not-stopped'
  if (kstDate(run.startedAt) !== want.today) return 'other-day'
  if (run.conditions.modelsUsed.aio !== want.signature) return 'conditions'
  if (run.conditions.judgeEngine !== want.judgeEngine) return 'judge-engine'
  if (run.questionSet.hash !== want.fingerprint) return 'questions'
  if (aioRemaining(run).length === 0) return 'nothing-left'
  return null
}

// ── 올린 글(원장 · 앱 밖 글) ────────────────────────────────────────────────────

/** 원장 기록에서 이 규칙이 보는 값(server/publishedPosts.ts PublishedPost가 이 모양을 가진다). */
export interface AioLedgerPostLike {
  id: string
  url: string
  key: string
  publishedOn: string | null
  publishedOnSource: string
  recordedAt: string
  articleId: string
  articleTitle?: string
  removedAt?: string
  removedReason?: string
}

/** 한 주소의 올림 한 번 — 올린 날 · 같은 날 측정을 가를 올린 시각(앱 글만) · 내린 시각. */
export interface AioPosting {
  publishedOn: string | null
  postedAt: string | null
  removedAt: string | null
}

/** 올린 글 한 편(주소 키 하나) — 앱 글 줄과 앱 밖 글 줄을 주소 키로 묶는다. 작성자는 키(w1~w8)만. */
export interface AioPost {
  key: string
  url: string
  origin: 'app' | 'external'
  writerKey: string | null
  title: string | null
  postings: AioPosting[]
}

const safeWriterKey = (v: unknown): string | null => (isStr(v) && WRITER_KEY.test(v) ? v : null)

/**
 * 출처 맞추기에 쓸 올린 글 — 퍼포먼스 「올린 글 인용 추적」과 같은 규칙: 원장은 잘못 적은 줄을 빼고 내린 글은 남긴다(shownPosts와 같음),
 * 같은 날 측정은 그 편의 가장 이른 「올렸어요」 시각으로 가린다(postedAtIndex). 앱 밖 글은 앱 글로 옮긴 줄(원장이 이김)과 잘못 적은 줄을 빼고,
 * 올린 시각은 늘 모른다(externalAsLedgerPost — 같은 날 측정은 전후 불명). 옮긴 줄을 빼므로 그 주소는 앱 글 줄의 올린 날부터만 센다 — 앱 밖 줄의
 * 올린 날이 더 이르면 그 사이 회차는 N에도 k에도 넣지 않는다(앱 글을 내린 뒤를 앱 밖 줄이 「올라가 있음」으로 되살리지 않게 하는 쪽을 골랐다).
 * writerKeyOf가 무엇을 주든 w1~w8 꼴이 아니면 싣지 않는다.
 */
export function aioPostRows<L extends AioLedgerPostLike>(ledger: readonly L[], external: readonly ExternalPost[], writerKeyOf: (post: L) => string | null): AioPost[] {
  const shown = ledger.filter((p) => !p.removedAt || p.removedReason === 'taken-down')
  const postedAt = postedAtIndex(shown)
  const byKey = new Map<string, AioPost>()
  const add = (key: string, url: string, origin: AioPost['origin'], writerKey: string | null, title: string | null, posting: AioPosting) => {
    const cur = byKey.get(key)
    if (!cur) {
      byKey.set(key, { key, url, origin, writerKey, title, postings: [posting] })
      return
    }
    cur.postings.push(posting)
    if (origin === 'app' && cur.origin !== 'app') {
      cur.origin = 'app'
      cur.url = url
    }
    cur.writerKey ??= writerKey
    cur.title ??= title
  }
  for (const p of shown) {
    if (!p.key) continue
    add(p.key, p.url, 'app', safeWriterKey(writerKeyOf(p)), p.articleTitle ?? null, { publishedOn: p.publishedOn, postedAt: postedAt.get(p.id) ?? null, removedAt: p.removedAt ?? null })
  }
  for (const view of externalViews(external, ledger)) {
    if (view.state === 'moved' || view.removedReason === 'mistake') continue
    const row = externalAsLedgerPost(view)
    if (!row.key) continue
    add(row.key, row.url, 'external', null, view.title, { publishedOn: row.publishedOn, postedAt: null, removedAt: row.removedAt ?? null })
  }
  return [...byKey.values()]
}

/** 회차의 측정 창 — 시작 시각 ~ 마지막 문항 시각(한국 날짜 · 시각). */
export function aioRunWindow(run: AioRun): MeasureWindow | null {
  const first = kstDate(run.startedAt)
  if (!first) return null
  let endAt = run.startedAt
  for (const i of run.items) if (Date.parse(i.fetchedAt) > Date.parse(endAt)) endAt = i.fetchedAt
  return { first, last: kstDate(endAt) ?? first, startAt: run.startedAt, endAt }
}

/** 이 회차 때 올린 뒤였고 올라가 있던 글인가 — 올린 뒤('after')만, 내린 날이 측정 마지막 날보다 뒤(또는 안 내림)일 때만. */
function postUpDuring(post: AioPost, window: MeasureWindow, weekOf: string): boolean {
  return post.postings.some((p) => {
    if (timingOf(p.publishedOn, window, weekOf, p.postedAt) !== 'after') return false
    const removedOn = p.removedAt ? kstDate(p.removedAt) : null
    return !removedOn || removedOn > window.last
  })
}

/** 이 회차 때 올린 뒤였고 올라가 있던 글 — 회차 상세가 출처마다 올린 글을 표시할 때 쓴다(요약 셈과 같은 규칙). */
export function aioPostsUpDuring(run: AioRun, posts: readonly AioPost[]): AioPost[] {
  const window = aioRunWindow(run)
  return window ? posts.filter((p) => postUpDuring(p, window, run.conditions.weekOf)) : []
}

/** 회차 상세의 출처 한 줄 — 자사 · 올린 글 표시는 읽을 때 계산한다(저장하지 않는다). 작성자는 키만. */
export interface AioSourceMark {
  kind: 'reference' | 'link'
  link: string
  title: string | null
  source: string | null
  /** 자사 주소(하위 도메인 포함). 자사 주소 칸이 비면 false. */
  owned: boolean
  /** 이 회차 때 올라가 있던 올린 글(주소 키가 같음). */
  post: { key: string; origin: AioPost['origin']; writerKey: string | null } | null
  /** 올린 글 주소에 질의(?…)만 다른 주소 — 올린 글 출처로 세지 않는다. */
  variant: boolean
}

/** 문항의 출처(references)와 본문 안 링크(snippet_links)마다 자사 · 올린 글 표시. upPosts는 aioPostsUpDuring의 결과. */
export function aioSourceMarks(item: AioItem, ownedDomains: readonly string[], upPosts: readonly AioPost[]): AioSourceMark[] {
  const owned = ownedDomains.map((d) => d.trim()).filter(Boolean)
  const mark = (kind: AioSourceMark['kind'], link: string, title: string | null, source: string | null): AioSourceMark => {
    const key = trackingKey(link)
    const post = key ? (upPosts.find((p) => p.key === key) ?? null) : null
    const variant = !post && key !== null && upPosts.some((p) => matchKind(p.key, key) === 'query-variant')
    return { kind, link, title, source, owned: owned.length > 0 && ownedUrl(link, owned), post: post ? { key: post.key, origin: post.origin, writerKey: post.writerKey } : null, variant }
  }
  return [...(item.references ?? []).map((r) => mark('reference', r.link, r.title, r.source)), ...(item.links ?? []).map((l) => mark('link', l, null, null))]
}

// ── 지표 ─────────────────────────────────────────────────────────────────────

/** k/N — 분모가 0이면 rate는 null(확인 불가, 0 아님). */
export interface AioRatio {
  k: number
  n: number
  rate: number | null
}
const ratio = (k: number, n: number): AioRatio => ({ k, n, rate: n > 0 ? k / n : null })

/**
 * 출처 지표가 확인 불가인 까닭 — no-overview 있음이 하나도 없음, no-source-list 있음은 있었지만 모두 출처 목록 없이 옴, no-owned 자사 주소 칸이
 * 비어 있음, no-posts 그 회차 때 올라가 있던(올린 뒤) 글이 없음, posts-unreadable 원장 · 앱 밖 글을 못 읽음.
 */
export type AioSourceReason = 'ok' | 'no-overview' | 'no-source-list' | 'no-owned' | 'no-posts' | 'posts-unreadable'
export interface AioSourceRatio extends AioRatio {
  reason: AioSourceReason
}
export interface AioPostSourceRatio extends AioSourceRatio {
  /** 이 회차 때 올라가 있던(올린 뒤) 글 수. */
  posts: number
}

/** 읽을 때 쓰는 지금의 브랜드 값 — 자사 주소 · 원장 · 앱 밖 글을 고치면 지난 회차에도 바로 적용된다. posts null = 원장 · 앱 밖 글을 못 읽음. */
export interface AioReadContext {
  brandName: string
  aliases: string[]
  ownedDomains: string[]
  competitors: string[]
  posts: AioPost[] | null
}

const isListed = (i: AioItem) => i.status === 'shown' && (i.references?.length ?? 0) > 0
const isMeasured = (i: AioItem | null | undefined) => !!i && (i.status === 'shown' || i.status === 'absent')
const isJudged = (i: AioItem | null | undefined) => !!i && i.status === 'shown' && typeof i.mentioned === 'boolean'
/** 판정할 본문이 있는가(출처만 온 개요는 없다 — 판정하지 않는다). */
const hasText = (i: AioItem) => isStr(i.text) && i.text.trim().length > 0
const linksOfItem = (i: AioItem) => [...(i.references ?? []).map((r) => r.link), ...(i.links ?? [])]
const citedKeys = (i: AioItem) => new Set(linksOfItem(i).flatMap((l) => trackingKey(l) ?? []))

/** 「출처로만 보임」 — 본문에는 브랜드 이름이 없고 출처 제목 · 출처 이름에만 낱말로 나온다(낱말 경계 — 「군산 각 지역」은 군산각이 아니다). */
export function sourceOnlyOf(item: AioItem, brand: Pick<AioReadContext, 'brandName' | 'aliases'>): boolean | null {
  if (item.status !== 'shown') return null
  const names = uniq([brand.brandName, ...brand.aliases].map((s) => s.trim()).filter(Boolean))
  if (names.length === 0) return null
  const inRefs = (item.references ?? []).some((r) => names.some((n) => mentionsWord(r.title ?? '', n) || mentionsWord(r.source ?? '', n)))
  if (!inRefs) return false
  if (names.some((n) => mentionsWord(item.text ?? '', n))) return false
  // 잘린 본문에서 못 찾았으면 뒤쪽에 있을 수 있다 — 짐작하지 않는다.
  return item.truncated ? null : true
}

export interface AioRunSummary {
  runId: string
  startedAt: string
  state: AioRunState
  planned: number
  /** 잰 문항 = 있음 + 없음. */
  measured: number
  coverage: number | null
  shown: number
  absent: number
  unreadable: number
  failed: number
  judged: number
  /** 판정이 없는 있음(본문 없는 개요 포함). */
  judgeUnknown: number
  /** 본문 없이 출처만 온 있음 — 판정할 글이 없어 판정하지 않는다(다시 판정 대상도 아니다). */
  noText: number
  /** 다시 판정할 수 있는 있음 — 본문이 있고 판정이 없음(판정 불가). 「다시 판정」 단추 · 「판정 최대 n회」가 이 수를 쓴다. */
  rejudgeable: number
  /** 출처 목록 없이 온 있음 — 출처 분모에서 뺐다. */
  noSourceList: number
  sourceOnly: number
  /** 올린 글 주소에 질의(?…)만 다른 주소가 출처인 개요 — 올린 글 출처로 세지 않고 따로 보인다. */
  variantSource: number
  exposure: AioRatio
  mention: AioRatio
  ownSource: AioSourceRatio
  postSource: AioPostSourceRatio
  /** 경쟁사별 언급된 개요 수(많은 순). 경쟁사 목록이 없거나 판정된 개요가 없으면 null. */
  competitors: { name: string; count: number }[] | null
}

/** 회차 하나의 셈. 출처 지표는 출처 목록을 받은 있음만, 언급은 판정된 있음만 분모로 쓴다. */
export function summarizeAioRun(run: AioRun, ctx: AioReadContext): AioRunSummary {
  const items = latestItems(run)
  const count = (s: AioStatus) => items.filter((i) => i.status === s).length
  const shown = items.filter((i) => i.status === 'shown')
  const judged = shown.filter(isJudged)
  const listed = shown.filter(isListed)
  const planned = run.questionSet.ids.length
  const measured = items.filter(isMeasured).length

  const noList: AioSourceReason = shown.length > 0 ? 'no-source-list' : 'no-overview'
  const owned = ctx.ownedDomains.map((d) => d.trim()).filter(Boolean)
  const ownK = owned.length ? listed.filter((i) => linksOfItem(i).some((l) => ownedUrl(l, owned))).length : 0
  const ownSource: AioSourceRatio =
    owned.length === 0
      ? { k: 0, n: listed.length, rate: null, reason: 'no-owned' }
      : listed.length === 0
        ? { k: 0, n: 0, rate: null, reason: noList }
        : { ...ratio(ownK, listed.length), reason: 'ok' }

  const window = aioRunWindow(run)
  const upPosts = ctx.posts && window ? ctx.posts.filter((p) => postUpDuring(p, window, run.conditions.weekOf)) : []
  const listedKeys = listed.map(citedKeys)
  const postK = listedKeys.filter((keys) => upPosts.some((p) => keys.has(p.key))).length
  const variantSource = listedKeys.filter(
    (keys) => !upPosts.some((p) => keys.has(p.key)) && upPosts.some((p) => [...keys].some((k) => matchKind(p.key, k) === 'query-variant')),
  ).length
  const postSource: AioPostSourceRatio =
    ctx.posts === null
      ? { k: 0, n: listed.length, rate: null, reason: 'posts-unreadable', posts: 0 }
      : listed.length === 0
        ? { k: 0, n: 0, rate: null, reason: noList, posts: upPosts.length }
        : upPosts.length === 0
          ? { k: 0, n: listed.length, rate: null, reason: 'no-posts', posts: 0 }
          : { ...ratio(postK, listed.length), reason: 'ok', posts: upPosts.length }

  const names = uniq(ctx.competitors.map((c) => c.trim()).filter(Boolean))
  // 판정이 돌려준 이름은 띄어쓰기 · 대소문자가 다를 수 있다(「LG U+」 · 「lgu+」) — 그 둘만 접고 견준다.
  const fold = (s: string) => s.replace(/\s+/g, '').toLowerCase()
  const competitors =
    names.length === 0 || judged.length === 0
      ? null
      : names
          .map((name) => ({ name, count: judged.filter((i) => (i.competitorMentions ?? []).some((c) => fold(c.name) === fold(name) && c.count > 0)).length }))
          .filter((c) => c.count > 0)
          .sort((a, b) => b.count - a.count)

  return {
    runId: run.runId,
    startedAt: run.startedAt,
    state: run.state,
    planned,
    measured,
    coverage: planned > 0 ? measured / planned : null,
    shown: shown.length,
    absent: count('absent'),
    unreadable: count('unreadable'),
    failed: count('failed'),
    judged: judged.length,
    judgeUnknown: shown.length - judged.length,
    noText: shown.filter((i) => !hasText(i)).length,
    rejudgeable: shown.filter((i) => hasText(i) && !isJudged(i)).length,
    noSourceList: shown.length - listed.length,
    sourceOnly: shown.filter((i) => sourceOnlyOf(i, ctx) === true).length,
    variantSource,
    exposure: ratio(shown.length, measured),
    mention: ratio(judged.filter((i) => i.mentioned === true).length, judged.length),
    ownSource,
    postSource,
    competitors,
  }
}

/**
 * 요약 타일에 쓰는 회차 — 끝난(done) 회차, 또는 잰 문항이 예정의 90% 이상인 멈춘 회차. 도는 중인 회차는 쓰지 않는다. 실행기는 잰 문항이 90%
 * 미만이면 끝까지 갔어도 'done'으로 적지 않는다(늦게 오는 개요 장애로 「못 읽음」만 쌓인 회차가 노출 0%로 요약에 오르지 않게 — 'partial' · coverage).
 */
export function isSummaryRun(run: AioRun): boolean {
  if (run.state === 'running') return false
  if (run.state === 'done') return true
  return aioEnoughMeasured(run)
}

const byStart = (a: AioRun, b: AioRun) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.runId.localeCompare(b.runId)

/** 마지막 요약 회차(시작 시각 기준). 없으면 null. */
export function latestSummaryRun(runs: readonly AioRun[]): AioRun | null {
  return [...runs].sort(byStart).filter(isSummaryRun).at(-1) ?? null
}

// ── 같은 조건 ─────────────────────────────────────────────────────────────────

type AioCard = {
  weekOf: string
  enginesUsed: string[]
  modelsUsed: Record<string, string>
  questionBankVersion: string
  repeatsPerQuestion: number
  judgeEngine?: string
  judgeModel?: string
}

/** compareConditions에 넣는 칸 — 판정 엔진 · 모델은 문항에 적힌 판정 기록에서 읽는다(다시 판정해도 맞게). 판정 기록이 없으면 시작 때 엔진. */
function aioCard(run: AioRun): AioCard {
  const judged = run.items.filter((i) => isStr(i.judgeEngine) && i.judgeEngine)
  const engines = uniq(judged.map((i) => i.judgeEngine!)).sort()
  const models = uniq(judged.flatMap((i) => (isStr(i.judgeModel) && i.judgeModel ? [i.judgeModel] : []))).sort()
  const judgeEngine = engines.length ? engines.join('+') : run.conditions.judgeEngine
  return {
    weekOf: run.conditions.weekOf,
    enginesUsed: run.conditions.enginesUsed,
    modelsUsed: run.conditions.modelsUsed,
    questionBankVersion: run.conditions.questionBankVersion,
    repeatsPerQuestion: run.conditions.repeatsPerQuestion,
    ...(judgeEngine ? { judgeEngine } : {}),
    ...(models.length ? { judgeModel: models.join(' + ') } : {}),
  }
}

/**
 * 두 회차 사이에 달라진(또는 확인할 수 없는) 조건 — compareConditions 그대로. 다만 판정이 한 번도 없던 회차(AI 개요가 안 떴다)에는 판정 모델
 * 기록이 없고 그 회차에는 판정에 기댄 숫자도 없으므로, 어느 한쪽이라도 그러면 판정 모델은 견주지 않는다(판정 엔진은 그대로 본다).
 */
export function aioConditionDiffs(a: AioRun, b: AioRun): ConditionDiff[] {
  const ca = aioCard(a)
  const cb = aioCard(b)
  if (ca.judgeModel && cb.judgeModel) return compareConditions(ca, cb)
  return compareConditions({ ...ca, judgeModel: undefined }, { ...cb, judgeModel: undefined })
}

export function aioSameConditions(a: AioRun, b: AioRun): boolean {
  return aioConditionDiffs(a, b).length === 0
}

/**
 * 끝난 회차(도는 중 제외) 가운데 잰 문항(있음 + 없음)이 하나라도 있는 회차만 — 그중 최신과 같은 조건인 회차(오래된 순)와 다른 조건 회차 수.
 * 잰 문항이 0개인 회차(첫 질문 전에 중단 · 키 오류로 바로 멈춤 · 판정 기록이 없어 시작 때 엔진으로 견줌)는 기준이 되지 않고 질문 표 · 추이에도
 * 들지 않는다(회차 목록에는 그대로 보인다) — 빈 회차 하나가 앞 회차들의 표를 지우지 않게.
 */
function sameConditionSet(runs: readonly AioRun[]): { latest: AioRun | null; same: AioRun[]; other: number } {
  const finished = runs.filter((r) => r.state !== 'running' && latestItems(r).some(isMeasured)).sort(byStart)
  const latest = finished.at(-1) ?? null
  if (!latest) return { latest: null, same: [], other: 0 }
  const same = finished.filter((r) => r === latest || aioSameConditions(r, latest))
  return { latest, same, other: finished.length - same.length }
}

// ── 회차끼리 · 질문 표 · 추이 · 올린 글 표 ─────────────────────────────────────────

export interface AioRunComparison {
  /** 두 회차 모두에서 잰(있음 · 없음) 질문 수. */
  common: number
  exposure: [AioRatio, AioRatio]
  /** 두 회차 모두에서 판정된 있음인 질문 수. */
  mentionCommon: number
  mention: [AioRatio, AioRatio]
}

/** 두 회차의 비율을 견준다 — 두 회차 모두에서 잰 질문만 쓴다. */
export function compareAioRuns(a: AioRun, b: AioRun): AioRunComparison {
  const ma = new Map(latestItems(a).map((i) => [i.questionId, i]))
  const mb = new Map(latestItems(b).map((i) => [i.questionId, i]))
  const ids = a.questionSet.ids.filter((id) => mb.has(id))
  const common = ids.filter((id) => isMeasured(ma.get(id)) && isMeasured(mb.get(id)))
  const shownIn = (m: Map<string, AioItem>, list: string[]) => list.filter((id) => m.get(id)?.status === 'shown').length
  const both = ids.filter((id) => isJudged(ma.get(id)) && isJudged(mb.get(id)))
  const mentionedIn = (m: Map<string, AioItem>) => both.filter((id) => m.get(id)?.mentioned === true).length
  return {
    common: common.length,
    exposure: [ratio(shownIn(ma, common), common.length), ratio(shownIn(mb, common), common.length)],
    mentionCommon: both.length,
    mention: [ratio(mentionedIn(ma), both.length), ratio(mentionedIn(mb), both.length)],
  }
}

export type AioCellKind = 'mentioned' | 'not-mentioned' | 'judge-unknown' | 'no-text' | 'absent' | 'unreadable' | 'failed'
/** 질문 표 칸 기호 · 범례 글자(aria-label · title에도 같은 글자). */
export const AIO_CELL: Record<AioCellKind, { symbol: string; label: string }> = {
  mentioned: { symbol: '●', label: 'AI 개요에 언급' },
  'not-mentioned': { symbol: '○', label: 'AI 개요는 있지만 언급 없음' },
  'judge-unknown': { symbol: '◌', label: '판정 불가' },
  'no-text': { symbol: '◇', label: '본문 없는 개요(출처만 옴 · 판정 안 함)' },
  absent: { symbol: '—', label: 'AI 개요 없음' },
  unreadable: { symbol: '?', label: '못 읽음(확인 불가)' },
  failed: { symbol: '×', label: '오류로 못 잼' },
}
export interface AioCell {
  kind: AioCellKind
  symbol: string
  label: string
}

export function aioCellOf(item: AioItem): AioCell {
  const kind: AioCellKind =
    item.status !== 'shown'
      ? item.status
      : item.mentioned === true
        ? 'mentioned'
        : item.mentioned === false
          ? 'not-mentioned'
          : hasText(item)
            ? 'judge-unknown'
            : 'no-text'
  return { kind, ...AIO_CELL[kind] }
}

export interface AioQuestionRow {
  questionId: string
  query: string
  /** runIds와 같은 순서 — 그 회차에 끝 상태가 없으면 null(재지 않음). */
  cells: (AioCell | null)[]
  /** 노출 N = 있음 + 없음. */
  exposure: AioRatio
  /** 언급 N = 판정된 있음. */
  mention: AioRatio
}

/** 질문 표 — 최신(끝난) 회차와 같은 조건인 회차만 오래된 순으로 묶어 질문별 k/N. 다른 조건 회차는 수만 센다(화면이 흐리게 따로 보인다). */
export function aioQuestionRows(runs: readonly AioRun[]): { runIds: string[]; rows: AioQuestionRow[]; otherConditionRuns: number } {
  const { latest, same, other } = sameConditionSet(runs)
  if (!latest) return { runIds: [], rows: [], otherConditionRuns: 0 }
  const maps = same.map((r) => new Map(latestItems(r).map((i) => [i.questionId, i])))
  const rows = latest.questionSet.ids.map((id): AioQuestionRow => {
    const items = maps.map((m) => m.get(id) ?? null)
    const present = items.filter((i): i is AioItem => i !== null)
    return {
      questionId: id,
      query: present.at(-1)?.query ?? '',
      cells: items.map((i) => (i ? aioCellOf(i) : null)),
      exposure: ratio(present.filter((i) => i.status === 'shown').length, present.filter(isMeasured).length),
      mention: ratio(present.filter((i) => isJudged(i) && i.mentioned === true).length, present.filter(isJudged).length),
    }
  })
  return { runIds: same.map((r) => r.runId), rows, otherConditionRuns: other }
}

export interface AioTrendPoint {
  runId: string
  startedAt: string
  exposure: AioRatio
  mention: AioRatio
  /** 앞 회차들의 노출률이 20%를 넘었는데 이 회차는 0 — 경고하고 선을 잇지 않는다. */
  dropped: boolean
  /** 앞 점과 선을 이을지 — 첫 점 · 급락한 점 · 그 다음 점 · 비율이 없는 점은 잇지 않는다. */
  connectToPrev: boolean
}

/** 추이 — 최신과 같은 조건의 요약 회차만 오래된 순. 급락은 앞 점들(급락 점 제외)을 합친 노출률이 20%를 넘는데 이 회차가 0/N(N>0)일 때. */
export function aioTrend(runs: readonly AioRun[]): { points: AioTrendPoint[]; drops: string[] } {
  const { same } = sameConditionSet(runs)
  const points: AioTrendPoint[] = []
  let poolK = 0
  let poolN = 0
  for (const run of same.filter(isSummaryRun)) {
    const items = latestItems(run)
    const exposure = ratio(items.filter((i) => i.status === 'shown').length, items.filter(isMeasured).length)
    const judged = items.filter(isJudged)
    const mention = ratio(judged.filter((i) => i.mentioned === true).length, judged.length)
    const dropped = exposure.n > 0 && exposure.k === 0 && poolN > 0 && poolK / poolN > AIO_DROP_FROM
    const prev = points.at(-1)
    const gap = (p: AioTrendPoint) => p.dropped || p.exposure.rate === null
    points.push({ runId: run.runId, startedAt: run.startedAt, exposure, mention, dropped, connectToPrev: false })
    const cur = points.at(-1)!
    cur.connectToPrev = !!prev && !gap(prev) && !gap(cur)
    if (!dropped) {
      poolK += exposure.k
      poolN += exposure.n
    }
  }
  return { points, drops: points.filter((p) => p.dropped).map((p) => p.runId) }
}

export interface AioPostTableRow {
  key: string
  url: string
  origin: AioPost['origin']
  writerKey: string | null
  title: string | null
  /** 이 글을 올린 뒤 · 올라가 있던 회차 가운데 출처 목록을 받은 개요가 있던 회차 수(N). */
  runs: number
  /** 그중 이 글이 출처로 나온 회차 수(k). */
  cited: number
  /** 이 글 주소에 질의(?…)만 붙은 주소만 나온 회차 수. */
  variant: number
  firstCitedOn: string | null
}

/**
 * 올린 글 표 — 최신과 같은 조건의 요약 회차(끝남 · 90% 이상)만, 그 글을 올린 뒤('after') · 올라가 있던 회차만 N에 넣는다(올리기 전 · 내린 뒤
 * 회차를 「안 나옴」으로 세지 않는다). 일부만 잰 회차는 그 글이 나올 질문을 묻지 않았을 수 있어 N에 넣지 않는다(추이와 같은 규칙).
 */
export function aioPostTable(runs: readonly AioRun[], posts: readonly AioPost[]): AioPostTableRow[] {
  const { same } = sameConditionSet(runs)
  const perRun = same.filter(isSummaryRun).flatMap((run) => {
    const window = aioRunWindow(run)
    const listed = latestItems(run).filter(isListed)
    return window && listed.length > 0 ? [{ run, window, keys: listed.map(citedKeys) }] : []
  })
  return posts.map((post): AioPostTableRow => {
    let n = 0
    let k = 0
    let variant = 0
    let firstCitedOn: string | null = null
    for (const { run, window, keys } of perRun) {
      if (!postUpDuring(post, window, run.conditions.weekOf)) continue
      n += 1
      if (keys.some((ks) => ks.has(post.key))) {
        k += 1
        firstCitedOn ??= window.first
      } else if (keys.some((ks) => [...ks].some((c) => matchKind(post.key, c) === 'query-variant'))) {
        variant += 1
      }
    }
    return { key: post.key, url: post.url, origin: post.origin, writerKey: post.writerKey, title: post.title, runs: n, cited: k, variant, firstCitedOn }
  })
}

// ── 화면 모델 ─────────────────────────────────────────────────────────────────

export interface AioRunRow {
  runId: string
  startedAt: string
  /** 끝난 시각 — 끊긴 회차는 null. 화면은 「마지막으로 끝난 회차」를 이것으로 고른다(이어 잰 옛 회차의 멈춘 까닭도 보이게). */
  finishedAt: string | null
  state: AioRunState
  /** 끝 상태가 없는 문항 수(이어 재기 대상이 될 수 있는 질문). */
  remaining: number
  summary: AioRunSummary
  /** 요약 타일에 쓸 수 있는 회차(done 또는 90% 이상). 아니면 「일부만 잰 회차」. */
  summaryRun: boolean
  /** 최신(끝난) 회차와 같은 조건인가 — 다르면 diffs에 무엇이 다른지. */
  sameCondition: boolean
  diffs: ConditionDiff[]
  usage: AioUsage
  /** 이 회차의 최대 검색 수(M). */
  maxSearches: number
  /** 멈춘 까닭(실행기가 적은 글 — 키는 지웠다). 실행기 없이 끊긴 회차는 파일을 고치기 전이라 null일 수 있다. */
  stopReason: string | null
  stopMessage: string | null
  /** 판정 엔진(문항의 판정 기록 — 섞였으면 「a+b」, 판정이 없으면 시작 때 엔진). 화면이 판정 비용 단가를 고를 때 쓴다. */
  judgeEngine: string | null
}

export interface AioView {
  /** 마지막 요약 회차의 셈. 없으면 null. */
  summary: AioRunSummary | null
  /** 마지막 요약 회차와 그 앞 같은 조건 요약 회차의 비교(공통 질문만). */
  previous: AioRunComparison | null
  /** 새것부터. */
  runs: AioRunRow[]
  questions: ReturnType<typeof aioQuestionRows>
  /** 원장 · 앱 밖 글을 못 읽었으면 null(확인 불가). */
  posts: AioPostTableRow[] | null
  trend: ReturnType<typeof aioTrend>
  /** 읽지 못한 회차 파일 수 — 숨기지 않고 알린다. */
  unreadableRuns: number
  note: string
}

/** 시범 화면 한 장 — 회차 파일들과 지금의 브랜드 값으로 읽을 때 계산한다(저장하지 않는다). */
export function aioView(runs: readonly AioRun[], ctx: AioReadContext, opts: { unreadableRuns: number }): AioView {
  const sorted = [...runs].sort(byStart)
  const { latest } = sameConditionSet(sorted)
  const summaryRuns = sorted.filter(isSummaryRun)
  const last = summaryRuns.at(-1) ?? null
  const prev = last ? (summaryRuns.filter((r) => r !== last && aioSameConditions(r, last)).at(-1) ?? null) : null
  return {
    summary: last ? summarizeAioRun(last, ctx) : null,
    previous: last && prev ? compareAioRuns(prev, last) : null,
    runs: [...sorted].reverse().map((run): AioRunRow => {
      const diffs = latest && run !== latest ? aioConditionDiffs(latest, run) : []
      return {
        runId: run.runId,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        state: run.state,
        remaining: aioRemaining(run).length,
        summary: summarizeAioRun(run, ctx),
        summaryRun: isSummaryRun(run),
        sameCondition: diffs.length === 0,
        diffs,
        usage: run.usage,
        maxSearches: run.maxSearches,
        stopReason: run.stopReason ?? null,
        stopMessage: run.stopMessage ?? null,
        judgeEngine: aioCard(run).judgeEngine ?? null,
      }
    }),
    questions: aioQuestionRows(sorted),
    posts: ctx.posts ? aioPostTable(sorted, ctx.posts) : null,
    trend: aioTrend(sorted),
    unreadableRuns: Math.max(0, Math.floor(opts.unreadableRuns)),
    note: AIO_NOISE_NOTE,
  }
}

// ── 글자 ─────────────────────────────────────────────────────────────────────

/** 판정 엔진 이름 — 서버(상태 · 계획의 judge.label)와 화면(회차 자세히 · 회차 목록)이 같은 글자를 쓴다. 모르는 id는 그대로. */
export const AIO_JUDGE_LABEL: Readonly<Record<string, string>> = { gemini: 'Gemini', claude: 'Claude', openai: 'OpenAI', mock: '시험용 목 판정' }
export function aioJudgeLabel(engine: string | null | undefined): string {
  if (!engine) return '기록 없음'
  return engine
    .split('+')
    .map((e) => (Object.hasOwn(AIO_JUDGE_LABEL, e) ? AIO_JUDGE_LABEL[e] : undefined) ?? e)
    .join(' + ')
}

/** 날짜(YYYY-MM-DD) → 「12월 8일」 — 결제 주기 갱신일을 서버 알림 · 화면이 같은 꼴로 적는다. 꼴이 아니면 그대로. */
export function aioDayText(day: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${Number(day.slice(5, 7))}월 ${Number(day.slice(8, 10))}일` : day
}

/** 「k/N」 — 분모가 0이거나 확인 불가면 「확인 불가」. */
export function ratioText(r: AioRatio): string {
  return r.rate === null ? '확인 불가' : `${r.k}/${r.n}`
}

/** 백분율(반올림) — 확인 불가면 「확인 불가」. */
export function pctText(r: AioRatio): string {
  return r.rate === null ? '확인 불가' : `${Math.round(r.rate * 100)}%`
}
