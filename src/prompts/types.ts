export type Engine = 'openai' | 'gemini' | 'claude' | 'perplexity';

/**
 * 측정 질문의 언어. 기본은 한국어다. 'en'은 해외 환자처럼 영어로 묻는 측정이다 — 질문 생성과
 * 엔진 지시문만 바뀌고, 판정·집계는 같다.
 */
export type QuestionLanguage = 'ko' | 'en';

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
  /** 구매 여정 단계(b1b-journey-stage). 옛 은행에는 없다 — 화면은 없으면 추정값을 쓰고 그렇게 밝힌다. */
  stage?: 'learn' | 'consider' | 'decide';
  /** 콘텐츠 주제(b1c-question-topic). 업종마다 달라 고정 목록이 없다. 없으면 화면은 '미분류'로 센다. */
  topic?: string;
  industry: string;
  region: string;
  containsBrandName: boolean;
  version: string;
  /** 코호트 공통 질문지에서 온 문항이면 true — 같은 코호트 브랜드가 똑같이 받는다. */
  cohortShared?: boolean;
  /**
   * 실증 질문이면 true — 콘텐츠가 인용되는지 실험하려고 같은 판에 덧붙인 문항이다. 측정은 다른 질문처럼 매번 묻지만
   * 점수 · 코호트 비교 · 본 글에서는 뺀다(src/lib/questionScope.ts). 이름 없는 질문(category-agnostic)으로만 쓴다.
   */
  probe?: boolean;
  /**
   * 다른 실증 질문을 표현만 바꿔 쓴 실증(홀드아웃)이면 그 원래 질문 id — 처치 글이 문장이 다른 같은 의도의 질문에도 인용되는지
   * 본다(scripts/add-probe-questions.ts --paraphrase-of). 실증 질문에만 있다.
   */
  paraphraseOf?: string;
}

export interface CompetitorContext {
  name: string;
  aliases: string[];
  domains: string[];
}

/**
 * 시장 범위 — 이 브랜드가 누구에게 파는가. 지역 · 경쟁사 · 질문지가 이 값을 따른다.
 *   local    지역형: 동네 손님(병원 · 펜션 · 학원). 지역이 질문에 들어간다.
 *   national 전국형: 전국 소비자(보험 · 통신 · 가전). 지역은 「국내」, 제품 · 브랜드를 비교한다.
 *   b2b      B2B형: 기업 고객에게 납품(셋톱박스 · 부품 · 장비). 구매 · 조달 담당자가 공급사를 찾는다.
 * 값이 없으면 지역형으로 본다 — 시장 범위가 생기기 전의 브랜드가 모두 그렇게 측정됐다.
 */
export type MarketScope = 'local' | 'national' | 'b2b';
export const MARKET_SCOPES: MarketScope[] = ['local', 'national', 'b2b'];
/** 전국형 · B2B형 브랜드의 지역 값 — 본사 주소가 아니라 시장 전체를 뜻한다. */
export const NATIONAL_REGION = '국내';

export interface BrandContext {
  brandName: string;
  aliases: string[];
  ownedDomains: string[];
  competitors: CompetitorContext[];
  industry: string;
  region: string;
  /** 없으면 지역형(local). */
  marketScope?: MarketScope;
  /** B2B형의 구매자(예: "통신사 IPTV 셋톱박스 구매 · 조달 담당자") — 질문하는 사람이 된다. */
  buyer?: string;
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
