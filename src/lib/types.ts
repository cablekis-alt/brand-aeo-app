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
