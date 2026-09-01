export const Severities = ['critical', 'high', 'medium', 'low'] as const
export type Severity = (typeof Severities)[number]

export const Priorities = ['P0', 'P1', 'P2'] as const
export type Priority = (typeof Priorities)[number]

export const WorkTypes = ['dev', 'content'] as const
export type WorkType = (typeof WorkTypes)[number]

export const CategoryIds = [
  'accessibility',
  'answer_content',
  'structure',
  'trust',
  'citability',
  'entity',
] as const
export type CategoryId = (typeof CategoryIds)[number]

export type PageType =
  | 'article'
  | 'news'
  | 'product'
  | 'saas_home'
  | 'local_business'
  | 'medical'
  | 'legal'
  | 'finance'
  | 'other'

export type CollectionMode = 'static' | 'browser'

export type ScoreValue = number | 'unknown'

export interface Finding {
  title: string
  evidence: string
  quote: string | null
}

export interface IssueFinding extends Finding {
  severity: Severity
  aiImpact: string
}

export interface CategoryResult {
  id: CategoryId
  name: string
  score: ScoreValue
  maxScore: number
  judgment: string
  positives: Finding[]
  issues: IssueFinding[]
}

export interface TopIssue {
  rank: number
  severity: Severity
  categoryId: CategoryId
  title: string
  evidence: string
  aiImpact: string
  quote: string | null
}

export interface Recommendation {
  priority: number
  workType: WorkType
  task: string
  expectedEffect: string
  difficulty: '낮음' | '중간' | '높음'
  before: string | null
  after: string | null
}

export interface FaqItem {
  question: string
  answer: string
}

export interface ContentSuggestions {
  title: string
  h1: string
  summary: string
  outline: string[]
  faqs: FaqItem[]
  sourcesToAdd: string[]
  schemaTypes: string[]
}

export interface AccessFailure {
  status: string
  cause: string
  technical: string
  neededFromUser: string
  howToRetry: string
}

export interface Verdict {
  readiness: string
  biggestStrength: string
  biggestBlocker: string
  firstAction: string
  scoreRangeIfFixed: string
}

export interface AuditContext {
  topicOrQuery: string
  audience: string
  competitorUrls: string[]
}

export const DEFAULT_AUDIT_CONTEXT: AuditContext = {
  topicOrQuery: '',
  audience: '',
  competitorUrls: [],
}

export interface JsonLdEntity {
  types: string[]
  name: string | null
}

export interface HeadingItem {
  level: number
  text: string
}

export interface PageSignals {
  requestedUrl: string
  finalUrl: string
  status: number
  contentType: string
  redirected: boolean
  crossHostRedirect: boolean
  fetchError: string | null
  fetchErrorCode: string | null
  collectionMode: CollectionMode
  renderWarning: string | null
  title: string
  metaDescription: string
  canonical: string
  robotsMeta: string[]
  xRobotsTag: string
  robotsTxt: string
  robotsTxtStatus: number | null
  sitemapFound: boolean
  llmsTxtFound: boolean
  lang: string
  h1s: string[]
  h2s: string[]
  h3s: string[]
  headingOutline: HeadingItem[]
  ogTitle: string
  ogSiteName: string
  ogType: string
  ogUrl: string
  jsonLdTypes: string[]
  jsonLdEntities: JsonLdEntity[]
  wordCount: number
  mainText: string
  firstText: string
  listCount: number
  tableCount: number
  faqLike: boolean
  internalLinkCount: number
  externalLinkCount: number
  aboutOrContactLinks: string[]
  authorCandidates: string[]
  orgCandidates: string[]
  dates: string[]
  phoneOrEmail: boolean
  addressLike: boolean
  reviewOrDisclaimer: boolean
  noindex: boolean
  nofollow: boolean
  noai: boolean
  nosnippet: boolean
  maxSnippetZero: boolean
  scriptCount: number
  spaShell: boolean
  iframeCount: number
  iframeOnly: boolean
  authWall: boolean
  authWallEvidence: string
  ymyl: boolean
  pageType: PageType
  emptyAltCount: number
  imageCount: number
}

export interface AeoReport {
  url: string
  analyzedAt: string
  pageTitle: string
  coreTopic: string
  topicInferred: boolean
  audience: string
  audienceInferred: boolean
  collectionMode: CollectionMode
  accessStatus: 'ok' | 'failed'
  accessFailure: AccessFailure | null
  overallScore: number | null
  grade: string | null
  oneLiner: string
  categories: CategoryResult[]
  strengths: Finding[]
  problems: TopIssue[]
  recommendations: Recommendation[]
  contentSuggestions: ContentSuggestions | null
  citableSentences: string[]
  verdict: Verdict | null
  limitations: string[]
  disclaimer: string
  source: 'heuristic' | 'llm'
  pageType: PageType
  bodyWordCount: number | null
}

export const DISCLAIMER =
  '이 점수는 제출된 페이지의 AI 검색 대응 준비도를 진단한 결과입니다. ChatGPT·Perplexity·Claude·Gemini 등에서의 실제 인용, 노출 또는 순위를 보장하지 않습니다.'
