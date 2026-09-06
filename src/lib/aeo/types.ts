export const Severities = ['critical', 'high', 'medium', 'low'] as const
export type Severity = (typeof Severities)[number]

export const Priorities = ['P0', 'P1', 'P2'] as const
export type Priority = (typeof Priorities)[number]

export const WorkTypes = ['dev', 'content'] as const
export type WorkType = (typeof WorkTypes)[number]

// aeocheck.co.kr의 6개 영역 체계에 맞춘 카테고리(각 영역이 같은 것을 측정하도록 재설계).
export const CategoryIds = [
  'crawler', // AI 크롤러 접근·색인 (robots·noindex·status)
  'agent', // 에이전트 접근성 (링크·버튼·폼 라벨·시맨틱·alt)
  'structured', // 구조화 데이터 (JSON-LD·Organization·Breadcrumb)
  'content', // 콘텐츠 구조·인용 친화도 (H1/H2·질문형·표·직접답변)
  'eeat', // E-E-A-T·최신성·신뢰 (저자·수정일·연락처)
  'technical', // 기술 기본기 (canonical·HTTPS·메타·OG)
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
  // 자바스크립트 쿠키/리다이렉트 기반 봇 차단(WAF anti-bot) 챌린지. JS를 실행하지 않는
  // 크롤러(AI 검색 봇 포함)는 이 벽을 넘지 못해 본문에 접근할 수 없다.
  botChallenge: boolean
  botChallengeEvidence: string
  // Apache/nginx/IIS 등 웹서버 기본 페이지 — 실제 사이트가 배포되지 않은 상태.
  serverDefaultPage: boolean
  serverDefaultPageEvidence: string
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
