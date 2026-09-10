import type { Engine, QuestionCategory } from '../prompts/types'

export interface MentionSentence {
  sentence: string
  sentiment: 'positive' | 'neutral' | 'negative'
}

export interface CompetitorMentionDetail {
  name: string
  mentionCount: number
  sentences: MentionSentence[]
}

export type CitationOwnerType =
  | 'brand-owned'
  | 'competitor-owned'
  | 'third-party-authority'
  | 'third-party-ugc'
  | 'unknown'

export interface CitationDetail {
  raw: string
  domain: string | null
  ownerType: CitationOwnerType
  supportsBrandMention: boolean
}

export interface FactClaimDetail {
  claimText: string
  claimType: 'price' | 'spec' | 'date' | 'certification' | 'location' | 'other'
  verdict: 'supported' | 'contradicted' | 'unverifiable'
  responseValue: string | null
  factGraphValue: string | null
}

// 브랜드 종합 진단 화면이 그대로 소비하는, 반복 호출 1건당 판정 상세.
export interface QuestionRepeatAnalysis {
  questionId: string
  engine: Engine
  callIndex: number
  mentioned: boolean
  mentionSentences: MentionSentence[]
  competitorMentions: CompetitorMentionDetail[]
  shareOfMention: number
  citations: CitationDetail[]
  topRecommendation: string | null
  brandRank: number | null
  factualityClaims: FactClaimDetail[]
  factualitySupported: number
  factualityContradicted: number
  brandOwnedCitation: boolean
  /** 답 대신 사용자에게 되물은 응답 — "미언급"과 구분한다. 구버전 데이터엔 없다. */
  clarifying?: boolean
}

export interface QuestionSpec {
  questionId: string
  text: string
  category: QuestionCategory
  industry: string
  region: string
  containsBrandName: boolean
  version: string
}

// 질문 프롬프트 빌더.
export interface QuestionBank {
  version: string
  generatedAt: string
  questions: QuestionSpec[]
}

export interface CitationBreakdownRow {
  domain: string
  ownerType: string
  citationCount: number
  supportingBrandMentionCount: number
}

// URL 상세 분석.
export interface CitationBreakdown {
  rows: CitationBreakdownRow[]
  brandOwnedCitationRate: number
}

// AI 리퍼럴 트래픽(GA4) — server/gaReferrals.ts의 응답 계약.
// 클라이언트가 server/를 직접 import하면 google-auth-library가 번들에 섞이므로 형만 따로 둔다.
export interface AiReferralRow {
  engine: string
  label: string
  sessions: number
  activeUsers: number
  engagedSessions: number
  share: number
  sources: string[]
}

export interface AiReferralReport {
  configured: boolean
  reason?: string
  propertyId?: string
  startDate?: string
  endDate?: string
  rows: AiReferralRow[]
  totalAiSessions: number
  totalSessions: number
  aiShare: number
}

// 랭킹 분석.
export interface RankingView {
  cohort: {
    position: number
    totalTenants: number
    peers: { tenantId: string; brandName: string; aeoScore: number }[]
  }
  competitorShareOfMention: { name: string; mentionCount: number; share: number }[]
  topRecommendationRate: number
}
