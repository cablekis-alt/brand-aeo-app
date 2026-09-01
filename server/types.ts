import type { BrandContext, Engine, FactGraphNode } from '../src/prompts/types.js';

export interface TenantConfig extends BrandContext {
  tenantId: string;
  engines: Engine[]; // 이 테넌트가 수집 대상으로 쓰는 엔진 목록 (기본 4개)
  questionBankSize: number; // 예: 100
  questionBankVersion: string; // 버저닝 태그. 질문 은행을 새로 생성하려면 이 값을 바꾼다.
  repeatsPerQuestion: number; // 예: 3 — 설계 원칙: 비결정성 대응
  factGraph: FactGraphNode[];
}

export interface RawCallRecord {
  tenantId: string;
  weekOf: string;
  engine: Engine;
  questionId: string;
  callIndex: number;
  rawText: string;
  citations: string[];
  usedWebSearch: boolean;
  tokenUsage?: number;
  latencyMs?: number;
  calledAt: string;
}

export interface MentionSentence {
  sentence: string;
  sentiment: 'positive' | 'neutral' | 'negative';
}

export interface CompetitorMentionDetail {
  name: string;
  mentionCount: number;
  sentences: MentionSentence[];
}

export interface CitationDetail {
  raw: string;
  domain: string | null;
  ownerType: 'brand-owned' | 'competitor-owned' | 'third-party-authority' | 'third-party-ugc' | 'unknown';
  supportsBrandMention: boolean;
}

export interface FactClaimDetail {
  claimText: string;
  claimType: 'price' | 'spec' | 'date' | 'certification' | 'location' | 'other';
  verdict: 'supported' | 'contradicted' | 'unverifiable';
  responseValue: string | null;
  factGraphValue: string | null;
}

// B-02(브랜드 종합 진단)/B-04(URL 상세 분석)/B-06(랭킹 분석) 화면이 그대로 소비할 수 있도록
// B5-A~D 판정 결과를 요약(mentioned, shareOfMention 등)과 원본 상세를 함께 저장한다.
export interface QuestionRepeatAnalysis {
  questionId: string;
  engine: Engine;
  callIndex: number;
  mentioned: boolean;
  mentionSentences: MentionSentence[];
  competitorMentions: CompetitorMentionDetail[];
  shareOfMention: number; // 이 1회 응답 기준 (0이면 미언급)
  citations: CitationDetail[];
  topRecommendation: string | null;
  brandRank: number | null; // 대상 브랜드가 명시적으로 순위 매겨졌을 때의 순위
  factualityClaims: FactClaimDetail[];
  factualitySupported: number;
  factualityContradicted: number;
  brandOwnedCitation: boolean;
}
