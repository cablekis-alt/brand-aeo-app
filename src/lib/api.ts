import demoScorecards from '../data/demo-scorecards.json'
import type { Engine } from '../prompts/types'
import type { WeeklyScorecard } from '../prompts/b8-report'
import type { EeatAnalysis } from '../prompts/b6-eeat'
import type { CitationSourceAnalysis } from '../prompts/b7-citation-sources'
import type { CitationBreakdown, QuestionBank, QuestionRepeatAnalysis, RankingView } from './types'

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
    engines: ['openai'],
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

export async function loadTenants(): Promise<TenantSummary[]> {
  const remote = await getJson<TenantSummary[]>('/api/tenants')
  if (Array.isArray(remote) && remote.length > 0) return remote
  return FALLBACK_TENANTS
}

export async function loadScorecards(tenantId: string): Promise<WeeklyScorecard[]> {
  const remote = await getJson<unknown>(`/api/scorecards/${encodeURIComponent(tenantId)}`)
  if (Array.isArray(remote) && remote.every(isScorecard) && remote.length > 0) {
    return remote
  }
  return (demoScorecards as WeeklyScorecard[]).filter((card) => card.tenantId === tenantId)
}

// S-02 브랜드 종합 진단 — 실측 데이터가 없는 주차는 빈 배열(화면에서 "데이터 없음"으로 처리).
export async function loadQuestionAnalyses(tenantId: string, weekOf: string): Promise<QuestionRepeatAnalysis[]> {
  const remote = await getJson<QuestionRepeatAnalysis[]>(
    `/api/question-analyses/${encodeURIComponent(tenantId)}/${encodeURIComponent(weekOf)}`,
  )
  return remote ?? []
}

// S-04 질문 프롬프트 빌더 — version을 생략하면 서버가 테넌트의 현재 버전을 반환한다.
export async function loadQuestionBank(tenantId: string): Promise<QuestionBank | null> {
  return getJson<QuestionBank>(`/api/question-bank/${encodeURIComponent(tenantId)}`)
}

// S-05 URL 상세 분석.
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

// S-09 EEAT 분석.
export async function loadEeat(tenantId: string, weekOf: string): Promise<EeatAnalysis> {
  const remote = await getJson<EeatAnalysis>(`/api/eeat/${encodeURIComponent(tenantId)}/${encodeURIComponent(weekOf)}`)
  return remote ?? EMPTY_EEAT
}

// S-10 AI 인용출처 분석.
export async function loadCitationSources(tenantId: string, weekOf: string): Promise<CitationSourceAnalysis> {
  const remote = await getJson<CitationSourceAnalysis>(
    `/api/citation-sources/${encodeURIComponent(tenantId)}/${encodeURIComponent(weekOf)}`,
  )
  return remote ?? EMPTY_CITATION_SOURCES
}

// S-07 랭킹 분석.
export async function loadRanking(tenantId: string, weekOf: string): Promise<RankingView | null> {
  return getJson<RankingView>(`/api/ranking/${encodeURIComponent(tenantId)}/${encodeURIComponent(weekOf)}`)
}

// S-14 측정 상태 — 최근 GitHub Actions 측정 실행 목록.
export interface MeasureRunInfo {
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
