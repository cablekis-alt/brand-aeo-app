export type Engine = 'openai' | 'gemini' | 'claude' | 'perplexity';

export type QuestionCategory =
  | 'category-agnostic' // 브랜드명 없이 카테고리로만 묻는 질문 (AEO 핵심 지표)
  | 'brand-direct' // 브랜드명을 직접 언급하는 질문
  | 'comparison' // A vs B 비교 질문
  | 'price-spec' // 가격/스펙 질문
  | 'troubleshooting-review' // 후기/문제해결 질문
  | 'local-regional'; // 지역 특화 질문

export interface QuestionSpec {
  questionId: string;
  text: string;
  category: QuestionCategory;
  industry: string;
  region: string;
  containsBrandName: boolean;
  version: string;
}

export interface CompetitorContext {
  name: string;
  aliases: string[];
  domains: string[];
}

export interface BrandContext {
  brandName: string;
  aliases: string[];
  ownedDomains: string[];
  competitors: CompetitorContext[];
  industry: string;
  region: string;
}

export interface FactGraphNode {
  id: string;
  type: 'price' | 'spec' | 'date' | 'certification' | 'location' | 'other';
  claim: string;
  value: string;
  sourceUrl?: string;
  updatedAt: string;
}

export interface PromptMessage {
  system: string;
  user: string;
}

export interface NormalizedResponse {
  engine: Engine;
  questionId: string;
  callIndex: 1 | 2 | 3;
  timestamp: string;
  rawText: string;
  structuredCitations: string[]; // 엔진 API가 별도 필드로 반환한 URL (Perplexity citations 등)
  usedWebSearch: boolean;
  tokenUsage?: number;
  latencyMs?: number;
}
