import demoScorecards from '../data/demo-scorecards.json'
import { noteDataSource } from './dataSource'
import type { Engine, MarketScope } from '../prompts/types'
import type { WeeklyScorecard } from '../prompts/b8-report'
import type { EeatAnalysis } from '../prompts/b6-eeat'
import type { CitationQuestionScope, CitationSourceAnalysis } from '../prompts/b7-citation-sources'
import type { PublishSettings } from './publishSettings'
import type { AnswerEvidence } from './answerEvidence'
import type {
  AiReferralReport,
  CitationBreakdown,
  QuestionBank,
  QuestionRepeatAnalysis,
  RankingView,
} from './types'

export interface TenantSummary {
  tenantId: string
  brandName: string
  aliases: string[]
  ownedDomains: string[]
  industry: string
  region: string
  engines: Engine[]
  questionBankSize: number
  competitors: string[]
  /** 사실이 적힌 페이지. 없으면 소유 도메인 루트를 쓴다. */
  brandPageUrl?: string
  /** 시장 범위 — 서버가 없으면 지역형(local)으로 채운다. */
  marketScope?: MarketScope
  /** B2B형의 구매자. */
  buyer?: string
}

const FALLBACK_TENANTS: TenantSummary[] = [
  {
    tenantId: 'example-brand',
    brandName: '뷰성형외과',
    aliases: ['뷰성형외과', '강남 뷰성형외과', 'VIEW성형외과', 'View Clinic'],
    ownedDomains: ['viewclinic.com'],
    industry: '성형외과',
    region: '서울 강남',
    engines: ['openai', 'gemini'],
    questionBankSize: 12,
    competitors: ['강남성형A', '강남성형B'],
  },
]

function isScorecard(value: unknown): value is WeeklyScorecard {
  if (!value || typeof value !== 'object') return false
  const card = value as WeeklyScorecard
  return typeof card.tenantId === 'string' && typeof card.weekOf === 'string' && typeof card.aeoScore?.current === 'number'
}

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(path)
    if (!res.ok) return null
    // 서버가 측정 전 주차를 데모로 바꿔 줬는지 — 화면 배너의 유일한 근거다(dataSource.ts).
    noteDataSource(path, res.headers.get('X-Data-Source') === 'demo')
    return (await res.json()) as T
  } catch {
    return null
  }
}

/**
 * 브랜드 목록 — 실패하면 throw한다. 호출부(TenantProvider)가 이전 목록을 지키고 재시도하려면
 * "빈 목록"과 "조회 실패"를 반드시 구분해야 한다. 서버가 실제로 준 빈 배열은 "브랜드 0개"로
 * 그대로 믿는다(그래야 브랜드가 없을 때 더미 대신 빈 상태 화면이 나온다).
 *
 * 응답이 없어도 무한정 기다리지 않는다 — 기다리는 동안 화면에 브랜드 선택 드롭다운 자체가
 * 없어서 "눌러도 안 눌리는" 상태로 보이기 때문이다.
 */
export async function fetchTenants(timeoutMs = 5000, includeCompetitors = false): Promise<TenantSummary[]> {
  let res: Response
  try {
    // includeCompetitors: 코호트 비교용으로만 등록된 경쟁사까지 — 경쟁사 보기(읽기 전용)가 쓴다.
    res = await fetch(includeCompetitors ? '/api/tenants?all=1' : '/api/tenants', { signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    // AbortSignal.timeout은 "signal timed out"이라는 영문 DOMException을 던진다 — 화면에
    // 그대로 노출되지 않도록 우리 문구로 바꾼다.
    const timedOut = err instanceof DOMException && err.name === 'TimeoutError'
    throw new Error(
      timedOut
        ? `브랜드 목록이 ${timeoutMs / 1000}초 안에 응답하지 않았습니다.`
        : '브랜드 목록을 불러오지 못했습니다(서버 연결 불가).',
      { cause: err },
    )
  }
  if (!res.ok) throw new Error(`브랜드 목록 조회 실패 (HTTP ${res.status})`)
  const data: unknown = await res.json()
  if (!Array.isArray(data)) throw new Error('브랜드 목록 형식이 올바르지 않습니다.')
  return data as TenantSummary[]
}

/** 재시도까지 실패했을 때 쓰는 데모 목록(백엔드 없이 UI만 보는 로컬 개발용). */
export const DEMO_TENANTS: TenantSummary[] = FALLBACK_TENANTS

export async function loadScorecards(tenantId: string): Promise<WeeklyScorecard[]> {
  const remote = await getJson<unknown>(`/api/scorecards/${encodeURIComponent(tenantId)}`)
  if (Array.isArray(remote) && remote.every(isScorecard) && remote.length > 0) {
    return remote
  }
  // 서버가 없거나(웹) 응답이 비면 번들된 데모 스코어카드 — 이것도 데모다.
  noteDataSource(`/api/scorecards/${encodeURIComponent(tenantId)}`, true)
  return (demoScorecards as WeeklyScorecard[]).filter((card) => card.tenantId === tenantId)
}

// 브랜드 종합 진단 — 실측 데이터가 없는 주차는 빈 배열(화면에서 "데이터 없음"으로 처리).
export async function loadQuestionAnalyses(tenantId: string, weekOf: string): Promise<QuestionRepeatAnalysis[]> {
  const remote = await getJson<QuestionRepeatAnalysis[]>(
    `/api/question-analyses/${encodeURIComponent(tenantId)}/${encodeURIComponent(weekOf)}`,
  )
  return remote ?? []
}

// 질문 프롬프트 빌더 — version을 생략하면 서버가 테넌트의 현재 버전을 반환한다.
/**
 * 질문 은행. **주차의 은행 버전을 넘겨야 한다.**
 *
 * 버전을 빼면 서버가 테넌트의 **현재** 버전을 준다. 그러면 옛 주차를 볼 때 질문 id가 맞지
 * 않아 질문 텍스트·카테고리가 조용히 빈 값이 된다(화면에 빈 줄이 뜨고 카테고리가 뭉친다).
 * 주차 버전은 스코어카드의 questionBankVersion에 있다 — v0.1.49 이전 카드엔 없으므로,
 * 없으면 버전 없이 요청해 현재 은행으로 폴백한다.
 */
export async function loadQuestionBank(tenantId: string, version?: string): Promise<QuestionBank | null> {
  const path = `/api/question-bank/${encodeURIComponent(tenantId)}`
  return getJson<QuestionBank>(version ? `${path}?version=${encodeURIComponent(version)}` : path)
}

// URL 상세 분석.
export async function loadCitationBreakdown(
  tenantId: string,
  weekOf: string,
  engine?: string | null,
): Promise<CitationBreakdown> {
  const base = `/api/citations/${encodeURIComponent(tenantId)}/${encodeURIComponent(weekOf)}`
  const remote = await getJson<CitationBreakdown>(engine ? `${base}?engine=${encodeURIComponent(engine)}` : base)
  return remote ?? { rows: [], brandOwnedCitationRate: 0 }
}

const EMPTY_EEAT: EeatAnalysis = {
  overall: 0,
  experience: { score: 0, evidence: [] },
  expertise: { score: 0, evidence: [] },
  authoritativeness: { score: 0, evidence: [] },
  trustworthiness: { score: 0, evidence: [] },
  mentionedCallCount: 0,
  totalCallCount: 0,
}

const EMPTY_CITATION_SOURCES: CitationSourceAnalysis = {
  totalCitations: 0,
  uniqueUrls: 0,
  uniqueDomains: 0,
  qualityRate: 0,
  mix: [],
  byEngine: [],
  urls: [],
  consensusDomains: [],
}

// EEAT 분석.
export async function loadEeat(tenantId: string, weekOf: string): Promise<EeatAnalysis> {
  const remote = await getJson<EeatAnalysis>(`/api/eeat/${encodeURIComponent(tenantId)}/${encodeURIComponent(weekOf)}`)
  return remote ?? EMPTY_EEAT
}

// AI 인용출처 분석. questions를 주면 그 질문 유형(브랜드 이름 없는 질문 / 이름을 댄 질문)의 응답만 센다.
export async function loadCitationSources(
  tenantId: string,
  weekOf: string,
  engine?: string | null,
  questions?: CitationQuestionScope | null,
): Promise<CitationSourceAnalysis> {
  const base = `/api/citation-sources/${encodeURIComponent(tenantId)}/${encodeURIComponent(weekOf)}`
  const params = new URLSearchParams()
  if (engine) params.set('engine', engine)
  if (questions) params.set('questions', questions)
  const qs = params.toString()
  const remote = await getJson<CitationSourceAnalysis>(qs ? `${base}?${qs}` : base)
  return remote ?? EMPTY_CITATION_SOURCES
}

// 랭킹 분석.
export async function loadRanking(tenantId: string, weekOf: string): Promise<RankingView | null> {
  return getJson<RankingView>(`/api/ranking/${encodeURIComponent(tenantId)}/${encodeURIComponent(weekOf)}`)
}

/**
 * 상호(브랜드명)로 공식 도메인을 역추론한다 — Site AEO 진단 대상 결정용.
 * 판단 엔진(Gemini) 호출 1회가 든다. 확실하지 않으면 서버가 domain을 ""로 돌려준다
 * (프롬프트가 도메인을 지어내지 못하게 막아 둔다).
 *
 * 주의: 한국 사업체의 도메인·주소 회상은 Vercel 리전에서 신뢰할 수 없다 — 호출부가
 * 데스크톱 앱에서만 쓰도록 게이트한다.
 */
export async function inferBrandDomain(
  brandName: string,
  region = '',
): Promise<{ brandName: string; domain: string; industry: string; region: string; address: string } | null> {
  try {
    const res = await fetch('/api/infer?kind=identify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brandName, region }),
    })
    if (!res.ok) return null
    return (await res.json()) as { brandName: string; domain: string; industry: string; region: string; address: string }
  } catch {
    return null
  }
}

/**
 * 별칭 추론 — AI 답변이 이 브랜드를 부르는 다른 표기.
 *
 * 언급 판정이 브랜드명과 별칭을 그대로 쓰므로, 별칭이 비면 한국어 답변의 다른 표기를 통째로
 * 놓친다(실측: 가온그룹이 "KAONGROUP.COM"으로 등록돼 언급 3/72). 실패하면 null —
 * 화면은 사용자가 직접 넣도록 두고 등록을 막지 않는다.
 */
export async function inferBrandAliases(
  brandName: string,
  industry = '',
  region = '',
  domain = '',
): Promise<string[] | null> {
  try {
    const res = await fetch('/api/infer?kind=aliases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brandName, industry, region, domain }),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { aliases?: unknown }
    return Array.isArray(body.aliases) ? body.aliases.filter((x): x is string => typeof x === 'string') : null
  } catch {
    return null
  }
}

// AI 리퍼럴 트래픽(GA4) — 로컬/데스크톱 백엔드에만 라우트가 있다.
// 404(웹 배포)와 "GA 미설정"을 구분해 화면에서 다른 안내를 띄운다.
export async function loadAiReferrals(tenantId: string, days = 28): Promise<AiReferralReport> {
  const remote = await getJson<AiReferralReport>(
    `/api/ga-referrals/${encodeURIComponent(tenantId)}?days=${days}`,
  )
  return (
    remote ?? {
      configured: false,
      reason: 'unavailable',
      rows: [],
      totalAiSessions: 0,
      totalSessions: 0,
      aiShare: 0,
    }
  )
}

// 측정 상태 — 최근 GitHub Actions 측정 실행 목록.
export interface MeasureRunInfo {
  id: number
  runNumber: number
  title: string
  status: string
  conclusion: string | null
  event: string
  createdAt: string
  updatedAt: string
  htmlUrl: string
}

export async function loadMeasureRuns(): Promise<{ enabled: boolean; runs: MeasureRunInfo[] }> {
  const remote = await getJson<{ enabled: boolean; runs: MeasureRunInfo[] }>('/api/measure-requests?view=runs')
  return remote ?? { enabled: false, runs: [] }
}

/** 진행 중인 GitHub Actions 측정 run을 취소한다. */
export async function cancelMeasureRun(runId: number): Promise<void> {
  const res = await fetch('/api/measure-requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'cancel', runId }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || `취소 실패 (HTTP ${res.status})`)
  }
}

/**
 * 브랜드 전체 측정(경쟁사·코호트 포함)을 로컬 백엔드에 요청한다. 수 분 걸린다.
 *
 * 세 화면(측정·브랜드 관리·온보딩)이 같은 엔드포인트를 각자 fetch하고 있었다 —
 * reuseCohort 같은 옵션이 늘면 한 곳만 빠뜨리게 되므로 여기로 모은다.
 *
 * @param reuseCohort 이번 주 카드가 이미 있는(같은 엔진으로 잰) 경쟁사는 다시 재지 않는다.
 * @param selfOnly 이 브랜드만 잰다 — 경쟁사는 재지 않고, 순위는 경쟁사들의 이번 주 카드로 다시 매긴다.
 */
export async function measureTenantAll(
  tenantId: string,
  reuseCohort = false,
  selfOnly = false,
): Promise<{ brandName?: string; aeoScore?: number; weekOf?: string; weekCardKept?: string }> {
  const res = await fetch(`/api/tenants/${encodeURIComponent(tenantId)}/measure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reuseCohort, selfOnly }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || `측정 실패 (HTTP ${res.status})`)
  }
  return (await res.json()) as { brandName?: string; aeoScore?: number; weekOf?: string; weekCardKept?: string }
}

/** 측정 전 계획(server/measureAndBake.ts MeasurePreview). */
export interface MeasurePreview {
  weekOf: string
  engines: string[]
  enginesError: string | null
  judgeEngine: string
  targets: { tenantId: string; brandName: string; reusable: boolean; reason: string | null }[]
  peers: { tenantId: string; brandName: string; engines: string[]; judgeEngine: string | null; sameTools: boolean }[]
}

/** 측정 전 계획 — 로컬 백엔드 전용. 못 읽으면 throw한다(화면은 미리 확인 없이도 측정할 수 있다). */
export async function loadMeasurePreview(tenantId: string): Promise<MeasurePreview> {
  const res = await fetch(`/api/tenants/${encodeURIComponent(tenantId)}/measure-preview`)
  const body = (await res.json().catch(() => null)) as (MeasurePreview & { error?: string }) | null
  if (!res.ok || !body) throw new Error(body?.error || `측정 계획을 읽지 못했습니다 (HTTP ${res.status})`)
  return body
}

/**
 * 진행 중인 로컬 측정을 멈춘다(로컬 백엔드 전용).
 * stopping은 곧 멈추는 브랜드(이번 주 데이터를 쓰지 않음), finishing은 이미 저장을 시작해 마무리하는 브랜드다.
 */
export async function cancelLocalMeasure(): Promise<{ stopping: string[]; finishing: string[] }> {
  const res = await fetch('/api/measure-cancel', { method: 'POST' })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || `측정 중단 실패 (HTTP ${res.status})`)
  }
  return (await res.json()) as { stopping: string[]; finishing: string[] }
}

/**
 * 실행 항목의 집행 상태 — 데스크톱·로컬 전용이다.
 *
 * 웹(Vercel)에는 이 라우트가 없다(Hobby 함수 한도를 새로 쓰지 않으려고 만들지 않았다).
 * 그래서 **null은 오류가 아니라 "이 환경에는 저장 기능이 없다"** 는 뜻이다. 호출부는 이걸로
 * 컨트롤을 숨긴다 — 저장되지 않는 버튼을 보여 주는 것보다 아예 없는 편이 정직하다.
 */
export type ActionStatus = 'todo' | 'doing' | 'done' | 'skip'
export interface ActionStateEntry {
  status: ActionStatus
  updatedAt: string
  markedWeek?: string
  note?: string
  /** 집행하고 올린 글 주소. 다음 측정의 인용 주소와 맞춰 "그 글이 인용됐나"를 가린다. */
  publishedUrls?: string[]
}
export type ActionStateMap = Record<string, ActionStateEntry>

export async function loadActionStates(tenantId: string): Promise<ActionStateMap | null> {
  return getJson<ActionStateMap>(`/api/action-states/${encodeURIComponent(tenantId)}`)
}

/**
 * 집행 원장 — 올린 글 주소 한 줄 = 기록 한 줄(server/publishedPosts.ts). 데스크톱·로컬 전용이다.
 * 주소는 v0.4.3부터 여기에 쓴다. 집행 상태 파일에 남은 옛 주소는 서버가 「옛 기록」(legacy)으로 합쳐 준다.
 */
export type PostVia = 'own' | 'channel' | 'orphan' | 'direct'
export type PostRemovedReason = 'mistake' | 'taken-down'
/** 질문 은행에서 고른 질문으로 쓴 글(topic:)의 질문 스냅샷 — 은행 버전을 모르면 bankVersion null, 문장 없음. */
export interface TopicSnapshot {
  bankVersion: string | null
  questionIds: string[]
  questionTexts: string[]
}
/** 올린 글을 고친 날(server/publishedPosts.ts PostEdit) — 기존 글을 수정해 원문을 바꿨을 때 남긴다. */
export interface PostEdit {
  /** 고친 날(한국 날짜). */
  editedOn: string
  recordedAt: string
  draftGeneratedAt?: string
  adaptationSourceKey?: string
}
/** 고친 날을 남길 때 보내는 값 — 고칠 때 붙여 넣은 판을 함께 남긴다. */
export type PostEditInput = Pick<PostEdit, 'editedOn' | 'draftGeneratedAt' | 'adaptationSourceKey'>
export interface PublishedPost {
  id: string
  url: string
  /** 비교용 키(src/lib/publishedUrl.ts trackingKey). */
  key: string
  /** 올린 날(한국 날짜). null이면 모른다(옛 기록). */
  publishedOn: string | null
  publishedOnSource: 'default-today' | 'user' | 'legacy'
  recordedAt: string
  articleId: string
  targetActionId: string
  via: PostVia
  articleTitle?: string
  draftGeneratedAt?: string
  adaptationSourceKey?: string
  viewingWeek?: string
  topic?: TopicSnapshot
  /** 고친 날(오래된 순). */
  edits?: PostEdit[]
  removedAt?: string
  removedReason?: PostRemovedReason
  legacy?: true
}

/** 원장 요청 실패 — 서버가 준 이유를 그대로 싣는다(409 다른 글의 주소, 400 첫 화면 주소 등). */
export class PublishedPostsRequestError extends Error {}

async function postsRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, init)
  } catch (err) {
    throw new PublishedPostsRequestError(`앱 서버에 닿지 못했습니다: ${err instanceof Error ? err.message : String(err)}`)
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new PublishedPostsRequestError(body.error || `집행 기록 요청 실패 (HTTP ${res.status})`)
  return body
}

/**
 * 원장 읽기. **null은 "이 환경에는 기록 기능이 없다"(웹 — 라우트 404)**는 뜻이고, 그 밖의 실패(파일이 깨짐 등)는 이유와 함께
 * throw한다 — 기능을 조용히 숨기면 왜 적을 수 없는지 모른다.
 */
export async function loadPublishedPosts(tenantId: string): Promise<PublishedPost[] | null> {
  const path = `/api/published-posts/${encodeURIComponent(tenantId)}`
  let res: Response
  try {
    res = await fetch(path)
  } catch (err) {
    throw new PublishedPostsRequestError(`앱 서버에 닿지 못했습니다: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (res.status === 404) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    // 브랜드가 없다는 404는 기능이 없다는 뜻이 아니다 — 그대로 알린다.
    if (body?.error?.startsWith('tenant not found')) throw new PublishedPostsRequestError(body.error)
    return null
  }
  const body = (await res.json().catch(() => ({}))) as { posts?: PublishedPost[]; error?: string }
  if (!res.ok || !Array.isArray(body.posts)) throw new PublishedPostsRequestError(body.error || `집행 기록을 읽지 못했습니다 (HTTP ${res.status})`)
  return body.posts
}

export interface RecordPostInput {
  url: string
  articleId: string
  targetActionId: string
  via: PostVia
  articleTitle?: string
  draftGeneratedAt?: string
  adaptationSourceKey?: string
  viewingWeek?: string
  publishedOn: string
  /** 사람이 날짜를 고쳤는가(아니면 기본값 오늘). */
  publishedOnChosen: boolean
  /** 「올렸어요」 — 같은 요청에서 그 항목을 「집행함」으로 바꾼다. */
  markDone: boolean
  /** topic: 글이면 질문 스냅샷. */
  topic?: TopicSnapshot
}

/** 올린 글 인용 이력(server/publishedHistory.ts) — 주소 × 측정 주차. 서버 타입과 같은 모양이다. */
export interface HistoryWeek {
  weekOf: string
  /** 판정 기록이 있다. false면 그 주 칸은 0이 아니라 확인 불가다. */
  analysed: boolean
  window: { first: string; last: string } | null
  engines: string[]
  bankVersion: string | null
  responses: { all: number; unnamed: number | null; named: number | null; unknown: number }
  /** 직전 측정 주와 달라진 측정 조건. */
  changes: string[]
  /** 그 주 회차 — 같은 주에 여러 번 잰 주에만(옛 서버는 없다). */
  runs?: HistoryRun[]
  /** 읽지 못해 칸에서 뺀 회차. */
  runIssues?: string[]
}
/** 그 주 회차 하나(server/publishedHistory.ts HistoryRun). */
export interface HistoryRun {
  runId: string | null
  kind: 'run' | 'week-file'
  at: string | null
  window: { first: string; last: string } | null
  weekCard: 'saved' | 'kept' | 'week-file'
  isWeekCard: boolean
  selfOnly: boolean | null
  preserved?: true
  engines: string[]
  partialEngines: string[]
  missingEngines: string[]
  bankVersion: string | null
}
/** 회차가 여럿인 주의 칸 — 올린 뒤 회차 가운데 몇 번 인용됐나(server/publishedHistory.ts RunCellTally). */
export interface RunCellTally {
  measured: number
  cited: number
  weak: number
  weakEngines: string[]
  unsure: number
  citedDays: number[]
}
export interface HistoryCell {
  timing: import('./publishedUrl').PostTiming
  afterRemoval: boolean
  tally: import('./publishedUrl').WeekTally | null
  variantCited: number
  /** 올린 뒤 측정이 올린 날에서 며칠 뒤였나 — 갓 올린 글은 판단을 미룬다(publishTracking.ts INDEXING_GRACE_DAYS). 회차가 여럿이면 가장 늦은 회차. */
  daysAfterPublish?: number
  topicMention?: { answered: number; mentioned: number } | null
  earlierPostingLive?: true
  /** 회차가 여럿인 주 — 회차별로 센 값. */
  runs?: RunCellTally
  /** 같은 주에 올리기 전 회차에서 이미 인용됐다. */
  citedBeforeRuns?: number
}
export interface PostHistory {
  post: PublishedPost
  cells: (HistoryCell | null)[]
}
export interface PublishedHistory {
  weeks: HistoryWeek[]
  posts: PostHistory[]
}

/** 이력 읽기. null은 이 환경에 기능이 없다(웹 — 라우트 404). 그 밖의 실패는 이유와 함께 throw한다. */
export async function loadPublishedHistory(tenantId: string, weeks = 12): Promise<PublishedHistory | null> {
  let res: Response
  try {
    res = await fetch(`/api/published-history/${encodeURIComponent(tenantId)}?weeks=${weeks}`)
  } catch (err) {
    throw new PublishedPostsRequestError(`앱 서버에 닿지 못했습니다: ${err instanceof Error ? err.message : String(err)}`)
  }
  const body = (await res.json().catch(() => null)) as (PublishedHistory & { error?: string }) | null
  if (res.status === 404 && !body?.error?.startsWith('tenant not found')) return null
  if (!res.ok || !body || !Array.isArray(body.weeks)) {
    throw new PublishedPostsRequestError(body?.error || `올린 글 인용 이력을 읽지 못했습니다 (HTTP ${res.status})`)
  }
  return body
}

/** 측정 회차별 보기(server/runHistory.ts) — 서버 타입과 같은 모양이다. */
export interface RunPoint {
  kind: 'run' | 'week-file'
  runId: string | null
  weekOf: string
  at: string | null
  window: { first: string; last: string } | null
  selfOnly: boolean | null
  inCohortRun: boolean | null
  preserved?: true
  weekCard: 'saved' | 'kept' | 'week-file'
  weekCardKeptReason?: string
  isWeekCard: boolean
  engines: Record<string, { planned: number; succeeded: number }> | null
  enginesUsed: string[]
  partialEngines: string[]
  missingEngines: string[]
  engineIssues: string[]
  conditionKey: string
  changesFromPrev: string[]
  bankVersion: string | null
  ranked: { k: number; n: number; mentioned: number; ci: { lower: number; upper: number } | null } | null
  score: number | null
  scoreAtMeasure: number | null
  agnosticQuestions: number | null
  repeatsPerQuestion: number | null
}
export interface RunPostCell {
  timing: import('./publishedUrl').PostTiming
  afterRemoval: boolean
  daysAfterPublish: number | null
  withinGrace: boolean
  cited: number
  unnamedCited: number | null
  variantCited: number
  byEngine: Record<string, number>
}
export interface RunPostRow {
  post: PublishedPost
  cells: (RunPostCell | null)[]
  measuredRuns: number
  citedRuns: number
  afterGrace: { measured: number; cited: number }
  firstCited: { at: string | null; daysAfterPublish: number } | null
  lastUncitedDaysBefore: number | null
  unsureRuns: number
  weakRuns: number
  weakEngines: string[]
}
export interface RunHistory {
  points: RunPoint[]
  posts: RunPostRow[]
  weekCardScores: Record<string, number>
  issues: string[]
}

/** 회차 보기 읽기. null은 이 환경에 기능이 없다(웹 — 라우트 404). 그 밖의 실패는 이유와 함께 throw한다. */
export async function loadRunHistory(tenantId: string, weeks = 6): Promise<RunHistory | null> {
  let res: Response
  try {
    res = await fetch(`/api/run-history/${encodeURIComponent(tenantId)}?weeks=${weeks}`)
  } catch (err) {
    throw new PublishedPostsRequestError(`앱 서버에 닿지 못했습니다: ${err instanceof Error ? err.message : String(err)}`)
  }
  const body = (await res.json().catch(() => null)) as (RunHistory & { error?: string }) | null
  if (res.status === 404 && !body?.error?.startsWith('tenant not found')) return null
  if (!res.ok || !body || !Array.isArray(body.points)) {
    throw new PublishedPostsRequestError(body?.error || `측정 회차 기록을 읽지 못했습니다 (HTTP ${res.status})`)
  }
  return body
}

export async function recordPublishedPost(
  tenantId: string,
  input: RecordPostInput,
): Promise<{ post: PublishedPost; posts: PublishedPost[]; states?: ActionStateMap; existing: boolean }> {
  return postsRequest(`/api/published-posts/${encodeURIComponent(tenantId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export async function patchPublishedPost(
  tenantId: string,
  postId: string,
  patch: { publishedOn?: string; remove?: PostRemovedReason; restore?: true; addEdit?: PostEditInput; removeEdit?: string },
): Promise<{ post: PublishedPost; posts: PublishedPost[] }> {
  return postsRequest(`/api/published-posts/${encodeURIComponent(tenantId)}/${encodeURIComponent(postId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

/** 실패하면 null. 화면은 이전 상태를 되돌리고 사용자에게 알린다(조용히 삼키지 않는다). */
export async function saveActionState(
  tenantId: string,
  actionId: string,
  status: ActionStatus,
  markedWeek?: string,
): Promise<ActionStateMap | null> {
  try {
    const res = await fetch(`/api/action-states/${encodeURIComponent(tenantId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actionId, status, markedWeek }),
    })
    if (!res.ok) return null
    return (await res.json()) as ActionStateMap
  } catch {
    return null
  }
}

/**
 * CI 측정 결과 동기화 — 데스크톱 전용. GET은 가능 여부(토큰·repo), POST는 실제 동기화.
 * null은 라우트가 없는 환경(웹)이다 — 화면은 이 경우 섹션 자체를 숨긴다.
 */
export interface CiSyncSummary {
  enabled: boolean
  repo: string
  cardsAdded: number
  analysesAdded: number
  banksAdded: number
  ranksUpdated: number
  skippedExisting: number
  tenantsTouched: string[]
}
export async function loadCiSyncStatus(): Promise<{ enabled: boolean; repo: string } | null> {
  return getJson<{ enabled: boolean; repo: string }>('/api/ci-sync')
}
/** 실패하면 throw — 동기화가 조용히 "0건"으로 끝나면 사용자가 성공으로 읽는다. */
export async function runCiSync(): Promise<CiSyncSummary> {
  const res = await fetch('/api/ci-sync', { method: 'POST' })
  const body = (await res.json().catch(() => ({}))) as CiSyncSummary & { error?: string }
  if (!res.ok) throw new Error(body.error || `동기화 실패 (HTTP ${res.status})`)
  return body
}

/**
 * 질문 은행 구매 여정 단계 보정 — stage가 없는 문항만 판정 엔진이 매긴다(데스크톱·로컬 전용).
 * 실패하면 throw. 조용히 0건으로 끝나면 사용자가 성공으로 읽는다.
 */
export async function tagQuestionBankStages(
  tenantId: string,
  version?: string,
): Promise<{ total: number; taggedBefore: number; taggedAfter: number }> {
  const q = version ? `?version=${encodeURIComponent(version)}` : ''
  const res = await fetch(`/api/question-bank/${encodeURIComponent(tenantId)}/tag-stages${q}`, { method: 'POST' })
  const body = (await res.json().catch(() => ({}))) as { total: number; taggedBefore: number; taggedAfter: number; error?: string }
  if (!res.ok) throw new Error(body.error || `단계 매기기 실패 (HTTP ${res.status})`)
  return body
}

/**
 * 질문 은행 콘텐츠 주제 배정 — topic이 없는 문항만 판정 엔진이 매긴다(데스크톱·로컬 전용).
 * 이미 있는 주제는 재사용하게 서버가 프롬프트에 넣는다 — 주차마다 이름이 바뀌면 추이를 못 본다.
 */
export async function tagQuestionBankTopics(
  tenantId: string,
  version?: string,
): Promise<{ total: number; taggedBefore: number; taggedAfter: number; brandTopicsDropped: number; topics: string[] }> {
  const q = version ? `?version=${encodeURIComponent(version)}` : ''
  const res = await fetch(`/api/question-bank/${encodeURIComponent(tenantId)}/tag-topics${q}`, { method: 'POST' })
  const body = (await res.json().catch(() => ({}))) as {
    total: number
    taggedBefore: number
    taggedAfter: number
    brandTopicsDropped: number
    topics: string[]
    error?: string
  }
  if (!res.ok) throw new Error(body.error || `주제 매기기 실패 (HTTP ${res.status})`)
  return body
}

/** 콘텐츠 브리프(데스크톱·로컬 전용). null = 라우트 없는 환경(웹) → 화면은 버튼을 숨긴다. */
export type { ContentBrief } from '../prompts/b9b-content-brief'
export interface StoredBrief {
  actionId: string
  generatedAt: string
  brief: import('../prompts/b9b-content-brief').ContentBrief
  reused?: boolean
}
export async function loadContentBriefs(tenantId: string): Promise<Record<string, StoredBrief> | null> {
  return getJson<Record<string, StoredBrief>>(`/api/content-brief/${encodeURIComponent(tenantId)}`)
}
/** 실패하면 throw — 브리프가 조용히 비면 사용자가 "없는 게 정상"으로 읽는다. */
export async function generateContentBrief(
  tenantId: string,
  input: { actionId: string; kind: 'listing' | 'content'; title: string; targetDomain?: string; questionTexts: string[]; evidence: string },
  force = false,
): Promise<StoredBrief> {
  const res = await fetch(`/api/content-brief/${encodeURIComponent(tenantId)}${force ? '?force=1' : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = (await res.json().catch(() => ({}))) as StoredBrief & { error?: string }
  if (!res.ok) throw new Error(body.error || `브리프 생성 실패 (HTTP ${res.status})`)
  return body
}

/**
 * 콘텐츠 초안(데스크톱·로컬 전용) — 브리프에서 한 걸음.
 * 사실이 없는 자리는 문장을 짓지 않고 gap으로 비워 온다. null = 라우트 없는 환경(웹).
 */
export type { ContentDraft, DraftBlock, DraftSection } from '../prompts/b9c-content-draft'
export interface StoredDraft {
  actionId: string
  generatedAt: string
  draft: import('../prompts/b9c-content-draft').ContentDraft
  reused?: boolean
  /** 사람이 고친 마크다운. 있으면 화면·내보내기가 이것을 쓴다. */
  editedMarkdown?: string
  editedAt?: string
  /** 고친 글의 사실 가드 경고. 저장을 막지는 않는다. */
  editWarnings?: string[]
  /** 화면에서 채운 빈칸 기록 — 키 `절:블록`. 내보내기는 src/lib/draftGaps.ts로 반영한다. */
  gapFills?: Record<string, GapFill>
  /** 실측 사례 — 사람이 원문과 대조해 확인하면 발행본에 붙는다(src/lib/answerEvidence.ts). */
  evidence?: AnswerEvidence
  /** 사람이 고른 홈페이지 사진 — 본문에는 넣지 않고 내보낼 때만 사진 자리에 넣는다(src/lib/articlePhotos.ts). */
  photos?: import('./articlePhotos').PhotoPick[]
}
/** 빈칸 하나의 처리 — 확인한 값, 뺌, 또는 페이지에서 찾아 둔 후보(확인 전). server/contentDraft.ts와 같다. */
export interface GapFill {
  value?: string
  omit?: boolean
  suggested?: string
  sourceUrl?: string
}
export async function loadContentDrafts(tenantId: string): Promise<Record<string, StoredDraft> | null> {
  return getJson<Record<string, StoredDraft>>(`/api/content-draft/${encodeURIComponent(tenantId)}`)
}
/** 실패하면 throw. 브리프가 없으면 409와 함께 그 사실을 알려준다. */
export async function generateContentDraft(
  tenantId: string,
  /** format 'article' = 블로그 긴 글 형식(src/prompts/b9c-content-draft.ts). 없으면 옛 형식. */
  input: { actionId: string; targetDomain?: string; format?: 'article' },
  force = false,
): Promise<StoredDraft> {
  const res = await fetch(`/api/content-draft/${encodeURIComponent(tenantId)}${force ? '?force=1' : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = (await res.json().catch(() => ({}))) as StoredDraft & { error?: string }
  if (!res.ok) throw new Error(body.error || `초안 생성 실패 (HTTP ${res.status})`)
  return body
}

/**
 * 글의 실측 사례 — build(이 글의 질문으로 찾기) · confirm(원문과 맞음) · include · exclude(발행본에 넣기) · clear.
 * 판정 호출이 없다. 실패하면 이유를 담아 throw.
 */
export async function updateDraftEvidence(
  tenantId: string,
  body: { actionId: string; op: 'build' | 'confirm' | 'include' | 'exclude' | 'clear'; questionIds?: string[]; weekOf?: string },
): Promise<StoredDraft> {
  const res = await fetch(`/api/content-draft/${encodeURIComponent(tenantId)}/evidence`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as StoredDraft & { error?: string }
  if (!res.ok) throw new Error(data.error || `실측 사례 저장 실패 (HTTP ${res.status})`)
  return data
}

/** 브랜드별 발행 설정(src/lib/publishSettings.ts). 라우트가 없는 환경(웹)이면 null. */
export async function loadPublishSettings(tenantId: string): Promise<PublishSettings | null> {
  return getJson<PublishSettings>(`/api/tenants/${encodeURIComponent(tenantId)}/publish-settings`)
}
/** 실패하면 이유를 담아 throw. */
export async function savePublishSettings(tenantId: string, settings: PublishSettings): Promise<PublishSettings> {
  const res = await fetch(`/api/tenants/${encodeURIComponent(tenantId)}/publish-settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  })
  const body = (await res.json().catch(() => ({}))) as PublishSettings & { error?: string }
  if (!res.ok) throw new Error(body.error || `발행 설정 저장 실패 (HTTP ${res.status})`)
  return body
}

/** 고른 홈페이지 사진 한 장의 파일(「사진 N장 받기」) — 서버가 그 자리에 고른 사진만 받아 준다. 실패하면 throw. */
export async function fetchDraftPhotoFile(
  tenantId: string,
  q: { actionId: string; generatedAt: string; place: PhotoPlace },
): Promise<Blob> {
  const params = new URLSearchParams({
    actionId: q.actionId,
    generatedAt: q.generatedAt,
    slot: q.place.slot,
    nth: String(q.place.nth),
    heading: q.place.heading,
  })
  const res = await fetch(`/api/content-draft/${encodeURIComponent(tenantId)}/photo-file?${params.toString()}`)
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || `사진을 받지 못했습니다 (HTTP ${res.status})`)
  }
  return res.blob()
}

/** 이 브랜드의 홈페이지 사진을 글에 써도 된다는 확인(한 번) — 확인 시각은 서버가 찍는다. 의료 업종은 medical까지. */
export async function savePhotoRights(tenantId: string, opts: { medical?: boolean } = {}): Promise<PublishSettings> {
  const res = await fetch(`/api/tenants/${encodeURIComponent(tenantId)}/photo-rights`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts.medical ? { medical: true } : {}),
  })
  const body = (await res.json().catch(() => ({}))) as PublishSettings & { error?: string }
  if (!res.ok) throw new Error(body.error || `사진 사용 확인 저장 실패 (HTTP ${res.status})`)
  // 같은 화면에서 발행 설정을 먼저 읽어 둔 곳(콘텐츠 생성의 올리기 목록)이 새 확인을 쓰게 알린다 — 낡은 설정이면 고른 사진을 뺀다.
  // (이 파일은 서버 타입 검사에도 들어간다 — DOM 타입이 없어 window 대신 globalThis로 부른다.)
  const target = globalThis as { dispatchEvent?: (event: Event) => boolean }
  target.dispatchEvent?.(new CustomEvent<PhotoRightsChange>(PHOTO_RIGHTS_EVENT, { detail: { tenantId, settings: body } }))
  return body
}

/** 사진 사용 확인이 바뀌었다(savePhotoRights) — 화면 안에서만 도는 알림. */
export const PHOTO_RIGHTS_EVENT = 'brand-aeo:photo-rights'
export interface PhotoRightsChange {
  tenantId: string
  settings: PublishSettings
}

/** 사람이 고친 초안을 저장한다. 실패하면 throw — 조용히 삼키면 고친 글이 사라진 줄 모른다. */
export async function saveContentDraft(
  tenantId: string,
  actionId: string,
  markdown: string,
): Promise<StoredDraft> {
  const res = await fetch(`/api/content-draft/${encodeURIComponent(tenantId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actionId, markdown }),
  })
  const body = (await res.json().catch(() => ({}))) as StoredDraft & { error?: string }
  if (!res.ok) throw new Error(body.error || `초안 저장 실패 (HTTP ${res.status})`)
  return body
}

/** 채널 다듬기 결과 — server/channelAdapt.ts와 같은 모양. 콘텐츠 항목 → 채널 항목. */
export interface ChannelAdaptation {
  contentActionId: string
  channelActionId: string
  channelDomain: string
  style: import('../prompts/b9d-channel-adapt').ChannelStyle
  title: string
  markdown: string
  generatedAt: string
  sourceKey: string
  notes?: string[]
  /** 제목이 사실 대조를 거쳤나(server/channelAdapt.ts) — 아니면 「제목 복사」가 다듬은 제목을 쓰지 않는다. */
  titleChecked?: boolean
}
export type ChannelAdaptationMap = Record<string, Record<string, ChannelAdaptation>>
/** null = 라우트 없는 환경(웹). */
export async function loadChannelAdaptations(tenantId: string): Promise<ChannelAdaptationMap | null> {
  return getJson<ChannelAdaptationMap>(`/api/channel-adapt/${encodeURIComponent(tenantId)}`)
}
/** 판정 1~2회. 실패하면 throw. */
export async function adaptForChannel(
  tenantId: string,
  /** format 'article' — 원문이 블로그 글 형식이면 블로그 채널에서 구조 · 서식을 지킨다(b9d-channel-adapt). */
  input: { contentActionId: string; channelActionId: string; channelDomain: string; channelBadge: string; sourceMarkdown: string; format?: 'article' },
): Promise<ChannelAdaptation> {
  const res = await fetch(`/api/channel-adapt/${encodeURIComponent(tenantId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = (await res.json().catch(() => ({}))) as ChannelAdaptation & { error?: string }
  if (!res.ok) throw new Error(body.error || `채널 다듬기 실패 (HTTP ${res.status})`)
  return body
}

/** 브랜드 현황 — server/portfolio.ts와 같은 모양. 상태: 이번 주 완료·측정 오래됨·질문지 다름·기록 없음·경쟁사 미측정·측정 전. */
export type PortfolioStatus = 'done' | 'stale' | 'diff' | 'unknown' | 'alone' | 'none'
export interface PortfolioRow {
  tenantId: string
  brandName: string
  industry: string
  region: string
  competitors: number
  status: PortfolioStatus
  weekOf: string | null
  score: number | null
  rank: number | null
  totalTenants: number | null
  tied: boolean
  delta: number | null
  changeReason: string | null
  /** 다음 측정에서 함께 잴 경쟁사 수(측정과 같은 계산). 경쟁사를 함께 재지 않는 브랜드면 null. */
  competitorPlan: { measured: number; cap: number; waiting: number; blocked: number } | null
  /** 경쟁사 편집을 저장했고 아직 다시 재지 않았다. */
  competitorEdit: { savedAt: string; summary: string } | null
  /** 기본 정보(업종 · 지역 · 시장 범위)를 바꿨고 아직 새 설정으로 재지 않았다 — 「기본 정보 바뀜 · 다음 측정 대기」. */
  profileEdit: { savedAt: string; summary: string } | null
}
/** null = 라우트 없는 환경(웹). 데스크톱 앱 전용 — 판정 호출 없이 저장된 기록만 읽는다. */
/** 코호트 미니 리더보드의 한 줄 — server/portfolio.ts CohortMember와 같은 모양. */
export interface CohortMember {
  tenantId: string
  brandName: string
  score: number
  rank: number
  tied: boolean
  mentionRate: number
  brandOwnedCitationRate: number
  competitor: boolean
  /** 고객 브랜드인데 그 뒤 주차에 다시 쟀으면 그 주차(이 코호트는 지난 기록). */
  laterWeek: string | null
}
export interface PortfolioCohort {
  industry: string
  region: string
  weekOf: string
  members: CohortMember[]
}
export interface Portfolio {
  currentWeek: string
  rows: PortfolioRow[]
  cohorts: PortfolioCohort[]
}

export async function loadPortfolio(): Promise<Portfolio | null> {
  return getJson<Portfolio>('/api/portfolio')
}

/** 경쟁사 편집 서랍 — server/competitorEditor.ts CompetitorEditorState와 같은 모양. */
export type CompetitorPlanStatus = 'measured' | 'waiting' | 'collision' | 'duplicate' | 'unnamed'
export interface EditorCompetitorRow {
  index: number
  name: string
  aliases: string[]
  domains: string[]
  draftId: string | null
  status: CompetitorPlanStatus
  takesSlot: boolean
  targetTenantId: string | null
  otherRegion: boolean
  existingCustomer: boolean
  collidesWith: { tenantId: string; brandName: string; industry: string; region: string } | null
  deleted: boolean
  deletedOtherIndustry: { brandName: string; industry: string } | null
  cohortWeeks: number
  cohortFirstWeekOf: string | null
  /** 지난 기록에서 뺀 범위(코호트 제외 목록). */
  excluded: ExcludedRange[]
  /** 이 경쟁사를 함께 재는 다른 고객 브랜드 — 있으면 지난 기록에서 뺄 수 없다. */
  measuredByOthers: string[]
  latest: { weekOf: string; score: number; mentionRate: number; brandOwnedCitationRate: number } | null
  questionIds: string[]
  /** 「업종 다름」 판정 — 모르면 null(server/competitorEditor.ts IndustryMark). */
  industry: IndustryMark | null
}
export interface IndustryMark {
  verdict: 'same' | 'different'
  looksLike: string | null
  by: 'ai' | 'person'
}
/** 「브랜드 질문 모두 새로 쓰기」 — server/competitorEditor.ts RewriteAllPlan과 같은 모양. */
export interface RewriteAllPlan {
  available: boolean
  reason: string | null
  fromVersion: string
  toVersion: string
  size: number
  brandCount: number
  key: string
}
/** 업종 확인 · 표시의 응답 — verdict null이면 모른다(칩 없음). error는 확인하지 못한 이유. */
export interface IndustryResult {
  name: string
  verdict: 'same' | 'different' | null
  looksLike: string | null
  reason: string | null
  by: 'ai' | 'person' | null
  error?: string
}
/** 코호트 제외 목록에 든 범위 — fromWeek가 없으면 처음부터. */
export interface ExcludedRange {
  id: string
  fromWeek?: string
  untilWeek: string
}
export interface RankLite {
  position: number
  totalTenants: number
  tiedCount: number
}
/** 「지난 기록에서도 빼기」 · 「다시 세기」 미리보기 — server/competitorEditor.ts ExclusionPreview와 같은 모양. */
export interface ExclusionPreview {
  items: { tenantId: string; brandName: string; action: 'exclude' | 'restore'; fromWeek?: string; untilWeek: string; firstWeek: string; weeks: number }[]
  weeks: { weekOf: string; before: RankLite | null; after: RankLite }[]
  locked: { tenantId: string; brandName: string; by: string[] }[]
  otherCustomers: { brandName: string; weeks: number }[]
  cardsRewritten: number
  key: string
}
/** 지난 기록 바꾸기 — 뺄 경쟁사(onlyWeek면 그 주만)와 다시 셀 경쟁사. */
export interface PastOutInput {
  add: { tenantId: string; onlyWeek?: string }[]
  restore: string[]
}
export interface CompetitorEntry {
  name: string
  aliases: string[]
  domains: string[]
}
export interface EditorPastCompetitor {
  tenantId: string
  brandName: string
  aliases: string[]
  domains: string[]
  weeks: number
  firstWeekOf: string
  lastWeekOf: string
  lastScore: number
  /** 지금 코호트에 있는 이 경쟁사 카드 전체 — 「지난 기록에서도 빼기」가 빼는 범위. 0이면 옛 코호트 기록뿐이다. */
  cohortWeeks: number
  cohortFirstWeekOf: string | null
  cohortLastWeekOf: string | null
  excluded: ExcludedRange[]
}
export interface CompetitorEditorState {
  tenantId: string
  brandName: string
  industry: string
  region: string
  cap: number
  measuredCount: number
  waitingCount: number
  blockedCount: number
  baseline: { weekOf: string; score: number; rank: number; totalTenants: number; tied: boolean } | null
  competitors: CompetitorEntry[]
  rows: EditorCompetitorRow[]
  past: EditorPastCompetitor[]
  /** continues: 예전 경쟁사를 다시 넣으면 같은 id로 지난 기록을 잇는가. */
  suggestions: (CompetitorEntry & { source: 'past' | 'cohort' | 'answers'; note: string; continues?: boolean })[]
  questionBank: {
    version: string
    exists: boolean
    measuredVersion: string | null
    sharedCount: number
    brandCount: number
    /** 경쟁사를 바꾸며 고쳐 만든 질문지면 그 출처. */
    derived: { from: string; replaced: number; removed: number } | null
    /** 「브랜드 질문 모두 새로 쓰기」 — 목록 그대로 질문지만 새로 쓰는 저장(서랍 바닥 줄). */
    rewriteAll: RewriteAllPlan
  }
  edit: {
    active: boolean
    stale: boolean
    savedAt: string | null
    summary: string | null
    undoAvailable: boolean
    repoCompetitors: CompetitorEntry[]
  }
  measuring: boolean
}
/** 바꾼 목록 미리 계산 — server/competitorEditor.ts EditPlan과 같은 모양. */
export interface CompetitorEditPlan {
  cap: number
  measuredCount: number
  waitingCount: number
  blockedCount: number
  rows: EditorCompetitorRow[]
  competitors: CompetitorEntry[]
  droppedHosts: string[]
  leaving: { name: string; tenantId: string | null; questionIds: string[]; thisWeek: boolean }[]
  notes: string[]
  errors: string[]
  unchanged: boolean
  measuring: boolean
  exclusion: ExclusionPreview | null
  questions: QuestionHandoffPlan
  /** 「브랜드 질문 모두 새로 쓰기」 — 고르면 저장할 때 버전만 올리고 다음 측정이 새로 쓴다. */
  rewriteAll: RewriteAllPlan
  /** 저장한 뒤 함께 재는데 비교 질문이 없는 곳(빠지는 질문 빼고 넘겨받는 질문 더해 · 업종 다름 제외). */
  noQuestion: string[]
  /** 「질문지 그대로 두기」로 저장하면 비교 질문이 없는 곳(지금 질문만). */
  noQuestionKept: string[]
}

/** 질문 넘겨받기 — server/questionHandoff.ts QuestionPlan과 같은 모양. */
export interface QuestionHandoffItem {
  fromId: string
  toId: string | null
  action: 'rewrite' | 'remove'
  source: { text: string; topic?: string; category: string; stage?: 'learn' | 'consider' | 'decide' }
  swaps: { from: CompetitorEntry; to: CompetitorEntry | null; via: 'hint' | 'promoted' | 'existing' | null }[]
  keep: CompetitorEntry[]
  expectedIndexes: number[]
  topicNeedsRewrite: boolean
  reason: 'hint' | 'promoted' | 'existing' | 'noReceiver'
}
export interface QuestionHandoffPlan {
  /** derive만 새 질문지를 만든다. same: 그대로 · repo: 저장소 질문지로 돌아감 · fresh: 다음 측정이 새로 만든다. */
  mode: 'same' | 'derive' | 'repo' | 'fresh'
  fromVersion: string
  toVersion: string
  sizeBefore: number
  sizeAfter: number
  items: QuestionHandoffItem[]
  receivers: { name: string; ids: string[] }[]
  unreceived: {
    name: string
    questionIds: string[]
    reason: 'noReceiver' | 'receiverHasOwn' | 'otherIndustry'
    own?: { name: string; questionIds: string[] }
    /** 「업종 다름」만 아니었으면 받을 수 있던 곳 — 이유가 receiverHasOwn이어도 싣는다. */
    other?: string[]
  }[]
  key: string
}
/** 넘겨받기 힌트 — from 자리를 to가 대신했다(이름). */
export interface HandoffHint {
  from: string
  to: string
}
/** 고쳐 쓴 비교 질문 — server/competitorRewrite.ts RewriteResult와 같은 모양. */
export interface QuestionRewriteResult {
  key: string
  drafts: { fromId: string; toId: string; text: string; topic?: string; attempts: number }[]
  failed: { fromId: string; reasons: string[] }[]
  ms: number
  engine?: string
}

/** 경쟁사 편집 서랍의 처음 상태 — 데스크톱 앱 전용(Express 라우트). 실패하면 throw한다. */
export async function loadCompetitorEditor(tenantId: string): Promise<CompetitorEditorState> {
  return competitorRequest(tenantId, '', 'GET', undefined, '경쟁사 목록을 불러오지 못했습니다')
}

async function competitorRequest<T>(tenantId: string, sub: string, method: string, body: unknown, failure: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`/api/tenants/${encodeURIComponent(tenantId)}/competitors${sub}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  })
  const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok || !json) throw new Error(json?.error || `${failure} (HTTP ${res.status})`)
  return json
}

/**
 * 바꾼 목록을 미리 계산한다 — 저장하지 않는다. 입력이 잘못되면 throw(서버 메시지). pastOut이 있으면 「지난 기록에서도 빼기」 ·
 * 「다시 세기」의 주차별 순위도 계산한다(exclusion).
 */
export function planCompetitorEdit(
  tenantId: string,
  competitors: CompetitorEntry[],
  pastOut?: PastOutInput | null,
  handoff: HandoffHint[] = [],
): Promise<CompetitorEditPlan> {
  return competitorRequest(
    tenantId,
    '/plan',
    'POST',
    { competitors, ...(pastOut ? { pastOut } : {}), ...(handoff.length ? { handoff } : {}) },
    '바꾼 목록을 계산하지 못했습니다',
  )
}

/**
 * 넘겨받은 비교 질문을 판정 엔진으로 고쳐 쓴다(미리보기 — 저장하지 않는다). key는 미리 계산한 계획의 것이다. fresh면 저장해 둔
 * 결과를 쓰지 않고 다르게 다시 쓴다. 한 문항에 최대 90초씩 걸릴 수 있어 3분에서 끊는다.
 */
export function draftCompetitorQuestions(
  tenantId: string,
  competitors: CompetitorEntry[],
  handoff: HandoffHint[],
  key: string,
  fresh = false,
): Promise<QuestionRewriteResult> {
  return competitorRequest(
    tenantId,
    '/questions',
    'POST',
    { competitors, key, ...(handoff.length ? { handoff } : {}), ...(fresh ? { fresh } : {}) },
    '비교 질문을 고쳐 쓰지 못했습니다',
    AbortSignal.timeout(180_000),
  )
}

/**
 * 저장 — 다음 측정부터 이 목록으로 잰다. 측정 중이면 throw. 지난 기록을 바꾸면 미리 본 결과의 previewKey를 함께 보낸다 — 그사이
 * 순위가 바뀌었으면 throw(409). 넘겨받은 질문이 있으면 고쳐 쓴 문장(미리 본 그대로)을 questions로 보낸다.
 */
export function saveCompetitorEdit(
  tenantId: string,
  competitors: CompetitorEntry[],
  summary: string,
  past?: { pastOut: PastOutInput; previewKey: string } | null,
  extra: {
    handoff?: HandoffHint[]
    /** mode: derive(기본) · all(브랜드 질문 모두 새로 쓰기) · keep(질문지 그대로 두기). drafts는 derive일 때만. */
    questions?: { mode?: 'derive' | 'all' | 'keep'; key: string; drafts?: { fromId: string; text: string; topic?: string }[] }
  } = {},
): Promise<CompetitorEditorState> {
  return competitorRequest(
    tenantId,
    '',
    'PUT',
    { competitors, summary, ...(past ?? {}), ...(extra.handoff?.length ? { handoff: extra.handoff } : {}), ...(extra.questions ? { questions: extra.questions } : {}) },
    '경쟁사 목록을 저장하지 못했습니다',
  )
}

/**
 * 경쟁사 「업종 다름」 확인 — 추가하거나 새 이름으로 바꿀 때 부른다(데스크톱 전용, 검색이 붙은 판정 1회 · 이미 본 이름이면 바로 답함).
 * 확인하지 못하면 verdict null · error로 돌아온다. 그라운딩 호출이 30초까지 걸릴 수 있어 45초에서 끊는다.
 */
export function checkCompetitorIndustry(tenantId: string, entry: CompetitorEntry): Promise<IndustryResult> {
  return competitorRequest(tenantId, '/industry', 'POST', entry, '업종을 확인하지 못했습니다', AbortSignal.timeout(45_000))
}

/** 사람이 정한 업종 — same(「펜션 맞음」) · different(「업종 다름으로 표시」) · null(표시 지우기). 바로 저장된다. */
export function markCompetitorIndustry(tenantId: string, name: string, mark: 'same' | 'different' | null): Promise<IndustryResult> {
  return competitorRequest(tenantId, '/industry/mark', 'POST', { name, mark }, '업종 표시를 저장하지 못했습니다')
}

/** 마지막 저장 되돌리기 — 그 뒤 측정했으면 throw. */
export function undoCompetitorEdit(tenantId: string): Promise<CompetitorEditorState> {
  return competitorRequest(tenantId, '/undo', 'POST', {}, '되돌리지 못했습니다')
}

/** 앱에서 고친 목록을 버리고 저장소 설정을 따른다. */
export function resetCompetitorEdit(tenantId: string): Promise<CompetitorEditorState> {
  return competitorRequest(tenantId, '', 'DELETE', undefined, '저장소 설정으로 돌아가지 못했습니다')
}

/** 기본 정보 서랍 — 이 고객과 함께 재는 경쟁사 측정 브랜드(server/brandProfileEditor.ts ProfileCompetitor). */
export interface ProfileCompetitor {
  tenantId: string
  brandName: string
  industry: string
  region: string
  movable: boolean
  defaultMove: boolean
  reason: string | null
}

/** 기본 정보 서랍의 처음 상태(server/brandProfileEditor.ts ProfileEditorState). */
export interface ProfileEditorState {
  tenantId: string
  brandName: string
  industry: string
  region: string
  marketScope: MarketScope
  buyer: string
  questionBankVersion: string
  editable: boolean
  reason: string | null
  measuring: boolean
  industries: string[]
  regions: string[]
  competitors: ProfileCompetitor[]
}

export interface ProfileInput {
  industry: string
  region: string
  marketScope: MarketScope
  buyer: string
  move: string[]
}

/** 기본 정보 미리 계산(server/brandProfileEditor.ts ProfilePlan). */
export interface ProfilePlan {
  key: string
  unchanged: boolean
  errors: string[]
  notes: string[]
  measuring: boolean
  to: { industry: string; region: string; marketScope: MarketScope; buyer: string; questionBankVersion: string; cohortQuestionBank: string | null }
  bank: { from: string; to: string }
  cohortBank: { from: string | null; to: string | null; members: string[] }
  moving: { tenantId: string; brandName: string }[]
  thisWeek: string[]
  summary: string
}

export interface ProfileSaveResult {
  ok: true
  tenantId: string
  summary: string
  questionBankVersion: string
  moved: string[]
  backupDir: string
}

/** 기본 정보 서랍 요청 — 데스크톱 앱 전용(Express 라우트). 실패하면 throw한다. */
async function profileRequest<T>(tenantId: string, sub: string, method: string, body: unknown, failure: string): Promise<T> {
  const res = await fetch(`/api/tenants/${encodeURIComponent(tenantId)}/profile${sub}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok || !json) throw new Error(json?.error || `${failure} (HTTP ${res.status})`)
  return json
}

export function loadProfileEditor(tenantId: string): Promise<ProfileEditorState> {
  return profileRequest(tenantId, '', 'GET', undefined, '기본 정보를 불러오지 못했습니다')
}

export function planProfileEdit(tenantId: string, input: ProfileInput): Promise<ProfilePlan> {
  return profileRequest(tenantId, '/plan', 'POST', input, '바꿀 내용을 계산하지 못했습니다')
}

/** 저장 — 미리보기(previewKey)와 지금 계산이 다르면 서버가 409로 거절한다. */
export function saveProfileEdit(tenantId: string, input: ProfileInput, previewKey: string): Promise<ProfileSaveResult> {
  return profileRequest(tenantId, '', 'PUT', { input, previewKey }, '기본 정보를 저장하지 못했습니다')
}

/** 빈칸 기록 저장 — 판정 호출 없음. 실패하면 throw. */
export async function saveDraftGaps(
  tenantId: string,
  actionId: string,
  gapFills: Record<string, GapFill>,
): Promise<StoredDraft> {
  const res = await fetch(`/api/content-draft/${encodeURIComponent(tenantId)}/gaps`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actionId, gapFills }),
  })
  const body = (await res.json().catch(() => ({}))) as StoredDraft & { error?: string }
  if (!res.ok) throw new Error(body.error || `빈칸 저장 실패 (HTTP ${res.status})`)
  return body
}

/** 사진 자리 하나 — 장면 글자 · 몇 번째 · 소제목(src/lib/articlePhotos.ts PhotoPick과 같은 열쇠). */
export type PhotoPlace = Pick<import('./articlePhotos').PhotoPick, 'slot' | 'nth' | 'heading'>
/** 사진을 고를 때 보내는 값 — 확인 시각은 서버가 찍는다. */
export type PhotoPickInput = Omit<import('./articlePhotos').PhotoPick, 'confirmedAt'>

/**
 * 글 사진 자리에 고른 홈페이지 사진을 넣거나(pick — replaces가 있으면 그 자리에서 옮긴다) 뺀다(remove). 판정 호출 없음.
 * 화면이 본 초안(generatedAt)이 그사이 다시 만들어졌으면 서버가 409로 거절한다. photoNote는 사이트 설명을 쓰지 않은 이유.
 */
export async function saveDraftPhoto(
  tenantId: string,
  body:
    | { actionId: string; generatedAt: string; op: 'pick'; pick: PhotoPickInput; replaces?: PhotoPlace }
    | { actionId: string; generatedAt: string; op: 'remove'; place: PhotoPlace },
): Promise<StoredDraft & { photoNote?: string }> {
  const res = await fetch(`/api/content-draft/${encodeURIComponent(tenantId)}/photos`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const out = (await res.json().catch(() => ({}))) as StoredDraft & { photoNote?: string; error?: string }
  if (!res.ok) throw Object.assign(new Error(out.error || `사진 저장 실패 (HTTP ${res.status})`), { status: res.status })
  return out
}

/** 브랜드 사실(팩트 그래프) — 데스크톱·로컬 전용. null = 라우트 없는 환경(웹). */
/**
 * 브랜드 페이지에서 팩트 그래프 후보를 뽑는다. 저장하지 않는다 — 사람이 골라 넣는다.
 * 값이 페이지에 글자 그대로 없으면 서버가 버리고 그 이유를 dropped에 담는다.
 */
export interface FactCandidate {
  type: FactNode['type']
  claim: string
  value: string
  sourceUrl: string
}
export async function fetchFactCandidates(
  tenantId: string,
  url?: string,
): Promise<{ candidates: FactCandidate[]; sourceUrl: string; dropped: string[] }> {
  const res = await fetch(`/api/tenants/${encodeURIComponent(tenantId)}/fact-candidates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(url ? { url } : {}),
  })
  const body = (await res.json().catch(() => ({}))) as {
    candidates?: FactCandidate[]
    sourceUrl?: string
    dropped?: string[]
    error?: string
  }
  if (!res.ok) throw new Error(body.error || `사실 후보를 가져오지 못했습니다 (HTTP ${res.status})`)
  return { candidates: body.candidates ?? [], sourceUrl: body.sourceUrl ?? '', dropped: body.dropped ?? [] }
}

/**
 * 등록 **전** 브랜드에서 사실 후보를 뽑는다 — 온보딩용.
 *
 * 테넌트가 아직 없어 `/api/tenants/:id/fact-candidates`를 쓸 수 없다. 온보딩이 끝났을 때
 * 팩트 그래프가 비어 있으면 첫 초안이 빈칸투성이가 된다 — 111개 브랜드 중 사실 2건 이상이
 * 1곳뿐이었던 이유가 그것이다.
 */
export async function fetchFactCandidatesFor(
  url: string,
  brandName: string,
  industry = '',
): Promise<{ candidates: FactCandidate[]; sourceUrl: string; dropped: string[] }> {
  const res = await fetch('/api/fact-candidates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, brandName, industry }),
  })
  const body = (await res.json().catch(() => ({}))) as {
    candidates?: FactCandidate[]
    sourceUrl?: string
    dropped?: string[]
    error?: string
  }
  if (!res.ok) throw new Error(body.error || `사실 후보를 가져오지 못했습니다 (HTTP ${res.status})`)
  return { candidates: body.candidates ?? [], sourceUrl: body.sourceUrl ?? '', dropped: body.dropped ?? [] }
}

export interface GapFactHit {
  need: string
  type: FactNode['type']
  claim: string
  value: string
  sourceUrl: string
}

/**
 * 초안의 빈칸을 브랜드 페이지에서 찾아본다. **저장하지 않는다** — 사람이 확인하고 넣는다.
 * 페이지에 없으면 missing으로 돌아오고, 화면은 그 자리에 입력칸을 띄운다.
 */
export async function findFactsForGaps(
  tenantId: string,
  needs: string[],
  url?: string,
): Promise<{ found: GapFactHit[]; missing: string[]; sourceUrl: string; dropped: string[] }> {
  const res = await fetch(`/api/tenants/${encodeURIComponent(tenantId)}/fact-for-gaps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ needs, ...(url ? { url } : {}) }),
  })
  const body = (await res.json().catch(() => ({}))) as {
    found?: GapFactHit[]
    missing?: string[]
    sourceUrl?: string
    dropped?: string[]
    error?: string
  }
  if (!res.ok) throw new Error(body.error || `빈칸을 채우지 못했습니다 (HTTP ${res.status})`)
  return {
    found: body.found ?? [],
    missing: body.missing ?? needs,
    sourceUrl: body.sourceUrl ?? '',
    dropped: body.dropped ?? [],
  }
}

/** 브랜드 페이지 주소를 저장한다. 빈 문자열을 넘기면 지워져 소유 도메인 루트로 되돌아간다. */
/** 답변에 함께 나온 브랜드 — 판정이 아니라 사람이 확인할 후보다. */
export interface DiscoveredBrand {
  name: string
  mentions: number
  answers: number
  engines: string[]
  questionIds: string[]
  registered: boolean
}

export interface DiscoveryResult {
  brands: DiscoveredBrand[]
  /** 업종에서 쓸 이름 접미사. 비어 있으면 이 업종에서는 찾을 수 없다는 뜻이다. */
  suffixes: string[]
  /** 'fallback'에서 0개는 "경쟁사가 없다"가 아니라 "이 방식으로는 못 찾는다"는 뜻이다. */
  suffixSource: 'catalog' | 'fallback' | 'none'
  answersScanned: number
}

export async function loadDiscoveredBrands(tenantId: string, weekOf: string): Promise<DiscoveryResult | null> {
  return getJson<DiscoveryResult>(
    `/api/discovered-brands/${encodeURIComponent(tenantId)}/${encodeURIComponent(weekOf)}`,
  )
}

/** 저장된 AI 답변 원문. 질문 하나 단위로만 받는다(한 주차 전체는 실측 215KB). */
export interface RawAnswer {
  engine: string
  callIndex: number
  rawText: string
  citations: string[]
  usedWebSearch: boolean
  latencyMs?: number
  calledAt: string
}

export async function loadRawAnswers(
  tenantId: string,
  weekOf: string,
  questionId: string,
): Promise<RawAnswer[] | null> {
  return getJson<RawAnswer[]>(
    `/api/raw-answers/${encodeURIComponent(tenantId)}/${encodeURIComponent(weekOf)}?questionId=${encodeURIComponent(questionId)}`,
  )
}

/**
 * 엔진 사용량(전체 브랜드 합산). 비용은 내려오지 않는다 — 화면이 단가 설정으로 계산한다.
 * 대신 입력·출력을 나눠 준다. 합계만으로는 환산조차 못 한다(출력이 몇 배 비싸고 비중이
 * 엔진마다 다르다).
 */
export interface UsageRow {
  engine: string
  calls: number
  tokens: number
  inputTokens: number
  outputTokens: number
  /** 엔진이 알려 준 실제 청구액 합. null이면 단가로 계산해야 한다(0과 다르다). */
  billedCost: number | null
  latencyMs: number
  tenants: number
  /** 웹검색을 쓴 호출 수. 판정 줄은 0이다. */
  searchCalls: number
  /** 검색 호출의 달별 분포와, 같은 달에 이 주차보다 앞서 쓴 검색 수(월 무료 한도 계산용). */
  searchByMonth: { month: string; searches: number; priorInMonth: number }[]
}

export interface UsageStats {
  weeks: {
    weekOf: string
    byEngine: UsageRow[]
    judgeByEngine: UsageRow[]
    calls: number
    tokens: number
    judgeCalls: number
    judgeTokens: number
  }[]
  filesRead: number
  /** 판정 기록이 있는 주차. 없는 주차는 그 기능이 생기기 전에 측정한 것이다. */
  weeksWithJudge: string[]
}

/**
 * 엔진 단가. **기본값이 없다** — 비어 있으면 "미설정"이고 화면은 비용을 만들지 않는다.
 * 단가를 코드에 박으면 벤더가 가격을 바꾼 뒤에도 그대로 거짓을 말한다.
 */
export interface EngineRate {
  model?: string
  inputPerM?: number
  outputPerM?: number
  /** 웹검색 1회당 요금. 검색한 호출에만 붙는다. */
  perRequest?: number
  /** 달마다 무료인 검색 건수. */
  freeRequestsPerMonth?: number
}

export interface EnginePricing {
  currency: string
  updatedAt: string
  engines: Record<string, EngineRate>
  /** 지금 실제로 호출하는 모델. 읽기 전용 — 모델은 환경변수로만 바뀐다. */
  currentModels?: Record<string, string>
}

export async function loadPricing(): Promise<EnginePricing | null> {
  return getJson<EnginePricing>('/api/engine-pricing')
}

export async function savePricing(p: EnginePricing): Promise<EnginePricing | { error: string }> {
  try {
    const res = await fetch('/api/engine-pricing', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(p),
    })
    const body = (await res.json().catch(() => null)) as (EnginePricing & { error?: string }) | null
    if (!res.ok || !body) return { error: body?.error ?? `저장 실패 (HTTP ${res.status})` }
    return body
  } catch (err) {
    return { error: err instanceof Error ? err.message : '저장 중 오류가 발생했습니다.' }
  }
}

export async function loadUsage(weeks = 4): Promise<UsageStats | null> {
  return getJson<UsageStats>(`/api/usage?weeks=${weeks}`)
}

/** 엔진별 언급률 추이. byEngine이 비면 그 주차는 질문 은행을 읽지 못해 분류할 수 없었다는 뜻이다. */
export interface EngineTrendPoint {
  weekOf: string
  byEngine: { engine: string; mentionRate: number; answers: number }[]
  overall: number | null
}

export async function loadEngineTrend(tenantId: string, weeks = 12): Promise<EngineTrendPoint[] | null> {
  return getJson<EngineTrendPoint[]>(`/api/engine-trend/${encodeURIComponent(tenantId)}?weeks=${weeks}`)
}

/** 주차별 코호트 평균(자사 제외). avg가 null인 주는 비교할 브랜드가 없었다는 뜻이다. */
export interface CohortTrendPoint {
  weekOf: string
  avg: number | null
  peerCount: number
}

export async function loadCohortTrend(tenantId: string, weeks = 12): Promise<CohortTrendPoint[] | null> {
  return getJson<CohortTrendPoint[]>(`/api/cohort-trend/${encodeURIComponent(tenantId)}?weeks=${weeks}`)
}

/** Site AEO Checker의 주차별 기록. 주차 키는 서버가 정한다(클라이언트 시계를 믿지 않는다). */
export interface SiteScoreRecord {
  weekOf: string
  score: number
  grade: string | null
  url: string
  pageTitle: string
  collectionMode: string
  categories: { id: string; name: string; score: number | null; maxScore: number }[]
  measuredAt: string
}

export async function loadSiteScores(tenantId: string): Promise<Record<string, SiteScoreRecord> | null> {
  return getJson<Record<string, SiteScoreRecord>>(`/api/site-scores/${encodeURIComponent(tenantId)}`)
}

/**
 * 진단 결과를 이번 주 칸에 기록한다. 실패 사유를 문자열로 돌려준다 — 조용히 삼키면
 * "저장된 줄 알았는데 추이가 안 생기는" 상태가 된다(진단 화면이 그대로 보여 준다).
 */
export async function saveSiteScore(
  tenantId: string,
  input: Omit<SiteScoreRecord, 'weekOf' | 'measuredAt'>,
): Promise<{ weekOf: string; scores: Record<string, SiteScoreRecord> } | { error: string }> {
  try {
    const res = await fetch(`/api/site-scores/${encodeURIComponent(tenantId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    const body = (await res.json().catch(() => null)) as
      | { weekOf?: string; scores?: Record<string, SiteScoreRecord>; error?: string }
      | null
    if (!res.ok) return { error: body?.error ?? `저장 실패 (HTTP ${res.status})` }
    if (!body?.weekOf || !body.scores) return { error: '서버가 저장 결과를 돌려주지 않았습니다.' }
    return { weekOf: body.weekOf, scores: body.scores }
  } catch (err) {
    return { error: err instanceof Error ? err.message : '저장 중 오류가 발생했습니다.' }
  }
}

export async function saveBrandPageUrl(tenantId: string, url: string): Promise<string> {
  const res = await fetch(`/api/tenants/${encodeURIComponent(tenantId)}/brand-page`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  const body = (await res.json().catch(() => ({}))) as { brandPageUrl?: string; error?: string }
  if (!res.ok) throw new Error(body.error || `주소를 저장하지 못했습니다 (HTTP ${res.status})`)
  return body.brandPageUrl ?? ''
}

/** 브랜드별 수집 엔진을 저장한다. 전역 지정(COLLECT_ENGINES)이 켜져 있으면 그쪽이 이긴다. */
export async function saveTenantEngines(tenantId: string, engines: Engine[]): Promise<Engine[]> {
  const res = await fetch(`/api/tenants/${encodeURIComponent(tenantId)}/engines`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engines }),
  })
  const body = (await res.json().catch(() => ({}))) as { engines?: Engine[]; error?: string }
  if (!res.ok) throw new Error(body.error || `엔진을 저장하지 못했습니다 (HTTP ${res.status})`)
  return body.engines ?? engines
}

export interface FactNode {
  id: string
  type: 'price' | 'spec' | 'date' | 'certification' | 'location' | 'other'
  claim: string
  value: string
  sourceUrl?: string
  updatedAt: string
}
export async function loadFactGraph(
  tenantId: string,
): Promise<{ tenantId: string; source: 'file' | 'config'; factGraph: FactNode[] } | null> {
  return getJson(`/api/tenants/${encodeURIComponent(tenantId)}/fact-graph`)
}
export async function saveFactGraph(
  tenantId: string,
  factGraph: FactNode[],
): Promise<{ factGraph: FactNode[]; dropped: number }> {
  const res = await fetch(`/api/tenants/${encodeURIComponent(tenantId)}/fact-graph`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ factGraph }),
  })
  const body = (await res.json().catch(() => ({}))) as { factGraph: FactNode[]; dropped: number; error?: string }
  if (!res.ok) throw new Error(body.error || `저장 실패 (HTTP ${res.status})`)
  return body
}
