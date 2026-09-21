import type { BrandContext, Engine, FactGraphNode } from '../src/prompts/types.js';

export interface TenantConfig extends BrandContext {
  tenantId: string;
  engines: Engine[]; // 이 테넌트가 수집 대상으로 쓰는 엔진 목록 (기본 4개)
  // 문항 수. 기본 36 — 반복보다 문항에 예산을 쓰는 게 정밀도에 14배 효율적이다
  // (tenantRegistry.normalizeTenantDraft의 분산 분해 주석 참고).
  questionBankSize: number;
  questionBankVersion: string; // 버저닝 태그. 질문 은행을 새로 생성하려면 이 값을 바꾼다.
  // 같은 질문 반복 횟수. 기본 1 — 비결정성은 매 측정이 아니라
  // scripts/nondeterminism-probe.ts로 주기적으로 따로 잰다.
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
  // 사실이 실제로 적힌 페이지. ownedDomains[0]은 "소유한 곳"일 뿐 본문이 있는 곳과 다를 수
  // 있다(스테이,머뭄: 소유 도메인 루트는 콘솔 껍데기, 본문은 /s/stay). 사실 추출의 기본 주소.
  brandPageUrl?: string;
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
  // 입력·출력 분리. 합계만으로는 비용을 낼 수 없다(engines/types.ts 주석 참고).
  // 구버전 데이터엔 없어 선택 필드.
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  // 호출이 **끝난** 시각. 시작이 아니다 — 응답을 받은 뒤에 찍는다.
  calledAt: string;
  // 큐에 들어간 시각(전역 슬롯을 요청하기 직전). calledAt - startedAt - latencyMs가
  // 슬롯 대기다. 이게 없으면 "느린 API"와 "막힌 큐"를 구분할 수 없다.
  // 구버전 데이터엔 없어 선택 필드.
  startedAt?: string;
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
/**
 * 판정 단계 실측. 분석 구간이 브랜드마다 왜 달랐는지 사후에 가르기 위한 기록이다.
 *
 * 2026-W38 화학 코호트 6곳에서 폴리미래만 분석이 203초 걸렸다(나머지 99~102초). 판정 호출
 * 수(288건 · 한화솔루션과 동일)도, 인용 수도, 답변 길이도 그 차이를 설명하지 못했는데 남은
 * 기록이 없어 거기서 멈췄다.
 *
 * 전역 슬롯은 client.call 바깥에서 잡으므로(engines/index.ts의 limited) judgeMs에는 대기가
 * 안 들어가고 wallMs에는 들어간다. 그래서 둘의 차이가 원인을 가른다:
 *
 *   wallMs - max(judgeMs)가 크다   큐에서 기다린 것 — 동시성 상한 문제
 *   max(judgeMs)가 크다            API가 느린 것 — SDK 내부 재시도·모델 지연
 *
 * 판정 4건은 Promise.all로 함께 돌리므로 wallMs는 넷의 합이 아니라 가장 느린 하나에 대기를
 * 더한 값이다.
 */
export interface AnalysisTiming {
  startedAt: string;
  /** 슬롯 대기 + API 왕복. 판정 4건 병렬 전체. */
  wallMs: number;
  /** 슬롯을 얻은 뒤의 API 왕복만. 건너뛴 판정은 null. */
  judgeMs: { mention: number; citation: number | null; rank: number; fact: number | null };
}

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
  // 판정에 걸린 시간. 점수에는 쓰이지 않는다 — 측정 자체를 진단하기 위한 기록이다.
  // 구버전 데이터엔 없어 선택 필드.
  timing?: AnalysisTiming;
  /*
   * 이 응답을 판정하는 데 쓴 토큰. 수집 원문(raw-calls)은 분석 **전에** 저장되므로 여기 싣는다.
   *
   * 판정은 수집만큼, 때로는 더 많이 쓴다 — 응답 하나마다 2~4회(언급·인용·순위·사실성)를
   * 부르고 프롬프트에 답변 원문이 통째로 들어간다. 실측 W38은 수집 4,277회에 판정이 약
   * 1만 2천 회였는데 어디에도 기록이 없었다. 크레딧이 왜 줄었는지 답할 수 없던 이유다.
   */
  judgeUsage?: JudgeUsage;
}

export interface JudgeUsage {
  /** 판정 엔진. 수집 엔진과 다를 수 있다(실측 W38: 수집 3종, 판정은 전부 gemini). */
  engine: string;
  /** 실제로 부른 판정 호출 수. 인용 0건·팩트그래프 없음이면 건너뛰므로 2~4로 달라진다. */
  calls: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
}
