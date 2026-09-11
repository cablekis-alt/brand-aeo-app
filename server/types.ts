import type { BrandContext, Engine, FactGraphNode } from '../src/prompts/types.js';

export interface TenantConfig extends BrandContext {
  tenantId: string;
  engines: Engine[]; // 이 테넌트가 수집 대상으로 쓰는 엔진 목록 (기본 4개)
  // 문항 수. 기본 18 — 반복보다 문항에 예산을 쓰는 게 정밀도에 14배 효율적이다
  // (tenantRegistry.normalizeTenantDraft의 분산 분해 주석 참고).
  questionBankSize: number;
  questionBankVersion: string; // 버저닝 태그. 질문 은행을 새로 생성하려면 이 값을 바꾼다.
  // 같은 질문 반복 횟수. 기본 2 — 비결정성 측정을 유지하는 최소값이다
  // (실측: 재질의 시 판정이 뒤집힐 표준편차 19.6%p).
  repeatsPerQuestion: number;
  factGraph: FactGraphNode[];
  // true면 코호트 비교용 경쟁사 테넌트. 파이프라인·코호트 랭킹에는 들어가지만
  // 브랜드 선택 드롭다운(/api/tenants)에는 노출하지 않는다.
  cohortOnly?: boolean;
  // false면 측정 시 자동 추론된 경쟁사를 코호트로 함께 측정하지 않는다(기본 = 측정함).
  autoCohort?: boolean;
  // GA4 속성 ID — AI 리퍼럴 트래픽(실제 유입) 조회용. 자사 사이트처럼 GA 접근 권한이 있는
  // 브랜드에만 설정한다(경쟁사 테넌트는 보통 없음). 미설정 시 GA4_PROPERTY_ID 환경변수로 폴백.
  ga4PropertyId?: string;
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

// 브랜드 종합 진단/URL 상세 분석/랭킹 분석 화면이 그대로 소비할 수 있도록
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
  // 답을 내놓지 않고 사용자에게 되물은 응답("어느 지역을 찾으시나요?"). 브랜드가 언급될
  // 기회 자체가 없었으므로 "미언급"과 구분한다. 구버전 데이터엔 없어 선택 필드.
  clarifying?: boolean;
}
