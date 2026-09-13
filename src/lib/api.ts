import demoScorecards from '../data/demo-scorecards.json'
import { noteDataSource } from './dataSource'
import type { Engine } from '../prompts/types'
import type { WeeklyScorecard } from '../prompts/b8-report'
import type { EeatAnalysis } from '../prompts/b6-eeat'
import type { CitationSourceAnalysis } from '../prompts/b7-citation-sources'
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
export async function fetchTenants(timeoutMs = 5000): Promise<TenantSummary[]> {
  let res: Response
  try {
    res = await fetch('/api/tenants', { signal: AbortSignal.timeout(timeoutMs) })
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
export async function loadCitationBreakdown(tenantId: string, weekOf: string): Promise<CitationBreakdown> {
  const remote = await getJson<CitationBreakdown>(
    `/api/citations/${encodeURIComponent(tenantId)}/${encodeURIComponent(weekOf)}`,
  )
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

// AI 인용출처 분석.
export async function loadCitationSources(tenantId: string, weekOf: string): Promise<CitationSourceAnalysis> {
  const remote = await getJson<CitationSourceAnalysis>(
    `/api/citation-sources/${encodeURIComponent(tenantId)}/${encodeURIComponent(weekOf)}`,
  )
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
 */
export async function measureTenantAll(
  tenantId: string,
  reuseCohort = false,
): Promise<{ brandName?: string; aeoScore?: number; weekOf?: string }> {
  const res = await fetch(`/api/tenants/${encodeURIComponent(tenantId)}/measure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reuseCohort }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || `측정 실패 (HTTP ${res.status})`)
  }
  return (await res.json()) as { brandName?: string; aeoScore?: number; weekOf?: string }
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
}
export type ActionStateMap = Record<string, ActionStateEntry>

export async function loadActionStates(tenantId: string): Promise<ActionStateMap | null> {
  return getJson<ActionStateMap>(`/api/action-states/${encodeURIComponent(tenantId)}`)
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
}
export async function loadContentDrafts(tenantId: string): Promise<Record<string, StoredDraft> | null> {
  return getJson<Record<string, StoredDraft>>(`/api/content-draft/${encodeURIComponent(tenantId)}`)
}
/** 실패하면 throw. 브리프가 없으면 409와 함께 그 사실을 알려준다. */
export async function generateContentDraft(
  tenantId: string,
  input: { actionId: string; targetDomain?: string },
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

/** 브랜드 사실(팩트 그래프) — 데스크톱·로컬 전용. null = 라우트 없는 환경(웹). */
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
