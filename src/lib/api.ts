import demoScorecards from '../data/demo-scorecards.json'
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
export async function loadQuestionBank(tenantId: string): Promise<QuestionBank | null> {
  return getJson<QuestionBank>(`/api/question-bank/${encodeURIComponent(tenantId)}`)
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
