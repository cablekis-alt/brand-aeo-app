import type { EeatAnalysis } from '../src/prompts/b6-eeat.js';
import type { CitationSourceAnalysis } from '../src/prompts/b7-citation-sources.js';
import { analyzeCitationSources } from './citationSources.js';
import { computeEeatAnalysis } from './eeat.js';
import { agnosticAnalyses } from './mentionScope.js';
import type { ResultStore } from './store.js';
import type { QuestionRepeatAnalysis } from './types.js';

/** 인용 집계에 필요한 읽기 메서드만 요구한다 (배포 환경의 읽기 전용 스토어도 그대로 쓸 수 있도록). */
type CitationSource = Pick<ResultStore, 'getQuestionAnalyses'>;
type RankingSource = Pick<ResultStore, 'getQuestionAnalyses' | 'getCohortScorecards' | 'getQuestionBank'>;

export interface CitationBreakdownRow {
  domain: string;
  ownerType: string;
  citationCount: number;
  supportingBrandMentionCount: number;
}

export interface CitationBreakdown {
  rows: CitationBreakdownRow[];
  brandOwnedCitationRate: number;
}

/** URL 상세 분석 — 주간 응답에 등장한 인용을 도메인×소유권 기준으로 집계한다. */
export async function getCitationBreakdown(
  store: CitationSource,
  tenantId: string,
  weekOf: string,
): Promise<CitationBreakdown> {
  const analyses = await store.getQuestionAnalyses(tenantId, weekOf);
  const rowsByKey = new Map<string, CitationBreakdownRow>();
  let totalCitations = 0;
  let brandOwnedCitations = 0;

  for (const analysis of analyses) {
    for (const citation of analysis.citations) {
      totalCitations += 1;
      if (citation.ownerType === 'brand-owned') brandOwnedCitations += 1;

      const key = `${citation.domain ?? citation.raw}::${citation.ownerType}`;
      const row = rowsByKey.get(key) ?? {
        domain: citation.domain ?? citation.raw,
        ownerType: citation.ownerType,
        citationCount: 0,
        supportingBrandMentionCount: 0,
      };
      row.citationCount += 1;
      if (citation.supportsBrandMention) row.supportingBrandMentionCount += 1;
      rowsByKey.set(key, row);
    }
  }

  return {
    rows: [...rowsByKey.values()].sort((a, b) => b.citationCount - a.citationCount),
    brandOwnedCitationRate: totalCitations > 0 ? brandOwnedCitations / totalCitations : 0,
  };
}

export interface MentionShare {
  name: string;
  mentionCount: number;
  share: number;
}

/** 한 수집 엔진만 놓고 본 지표. 코호트 순위는 여기 없다 — 아래 byEngine 주석 참고. */
export interface EngineRanking {
  engine: string;
  competitorShareOfMention: MentionShare[];
  topRecommendationRate: number;
  /** 언급 점유를 낸 응답 수(카테고리 무관 모집단). 표본이 작으면 값이 튄다는 걸 알려야 한다. */
  mentionCalls: number;
  /** 순위 판정이 있었던 응답 수. topRecommendationRate의 분모다. */
  rankedCalls: number;
}

export interface RankingView {
  cohort: {
    position: number; // 0이면 해당 주차 코호트 데이터 없음
    totalTenants: number;
    peers: { tenantId: string; brandName: string; aeoScore: number }[];
  };
  competitorShareOfMention: MentionShare[];
  // 언급 점유를 어느 질문 집합에서 냈는지. 'category-agnostic'이 정상이고, 질문 은행을 못 읽어
  // 분류가 불가능하면 'all'로 폴백한다(그 경우 브랜드명 질문이 자사 점유를 부풀린다).
  mentionScope: 'category-agnostic' | 'all';
  topRecommendationRate: number; // 순위 판정이 있었던 응답 중 자사가 1위로 뽑힌 비율
  /**
   * 수집 엔진별 분해. 같은 브랜드라도 엔진마다 언급·추천이 다르다.
   *
   * **코호트 순위는 나누지 않는다.** 스코어카드가 (브랜드, 주차)당 하나라 "Gemini 기준 코호트
   * 순위"를 내려면 저장 구조를 엔진별로 쪼개야 한다 — 없는 값을 만들어 보여주지 않는다.
   *
   * 엔진이 하나뿐이면 길이 1이다(화면이 그때는 감춘다).
   */
  byEngine: EngineRanking[];
}

// 화면 표시 순서 고정(ChatGPT·Gemini·Claude·Perplexity) — aggregate.ts와 같은 순서.
const ENGINE_ORDER = ['openai', 'gemini', 'claude', 'perplexity'];

/** 자사 + 경쟁사 언급 수를 세어 점유율로 만든다. 전체 집계와 엔진별 집계가 같이 쓴다. */
function shareOfMentionFrom(analyses: QuestionRepeatAnalysis[], brandName: string): MentionShare[] {
  const totals = new Map<string, number>();
  totals.set(brandName, 0);
  for (const analysis of analyses) {
    totals.set(brandName, (totals.get(brandName) ?? 0) + analysis.mentionSentences.length);
    for (const competitor of analysis.competitorMentions) {
      totals.set(competitor.name, (totals.get(competitor.name) ?? 0) + competitor.mentionCount);
    }
  }
  const sum = [...totals.values()].reduce((acc, count) => acc + count, 0);
  return [...totals.entries()]
    .map(([name, mentionCount]) => ({ name, mentionCount, share: sum > 0 ? mentionCount / sum : 0 }))
    .sort((a, b) => b.mentionCount - a.mentionCount);
}

/**
 * 순위 판정이 있었던 응답 중 자사가 1위로 뽑힌 비율.
 * 모집단은 스코어카드의 avgRecommendationRank와 같이 **전체 응답**이다
 * (카테고리 무관으로 좁힌 것은 언급률·SoM 계열뿐이다).
 */
function topRecommendationFrom(
  analyses: QuestionRepeatAnalysis[],
  brandName: string,
): { rate: number; ranked: number } {
  const withRanking = analyses.filter((analysis) => analysis.topRecommendation !== null);
  const forBrand = withRanking.filter((analysis) => analysis.topRecommendation === brandName).length;
  return { rate: withRanking.length > 0 ? forBrand / withRanking.length : 0, ranked: withRanking.length };
}

/** 코호트·언급 점유 계산에 필요한 테넌트 속성만 받는다. */
export interface RankingTenant {
  tenantId: string;
  brandName: string;
  industry: string;
  region: string;
  questionBankVersion: string;
}

/** 랭킹 분석 — 업종·지역 코호트 순위 + 테넌트 내부 경쟁사 언급 점유율을 한 번에 내려준다. */
export async function getRankingView(
  store: RankingSource,
  tenant: RankingTenant,
  weekOf: string,
): Promise<RankingView> {
  const [cohortScorecards, allAnalyses, bank] = await Promise.all([
    store.getCohortScorecards(tenant.industry, tenant.region, weekOf),
    store.getQuestionAnalyses(tenant.tenantId, weekOf),
    store.getQuestionBank(tenant.tenantId, tenant.questionBankVersion),
  ]);

  // 언급 점유는 스코어카드 SoM과 같은 모집단(카테고리 무관 질문)에서 낸다 — server/mentionScope.ts.
  // 두 화면이 같은 개념을 다른 모집단으로 보여주면 사용자가 값을 대조할 수 없다.
  const scoped = bank ? agnosticAnalyses(allAnalyses, bank.questions) : [];
  const useScoped = bank !== null && scoped.length > 0;
  const analyses = useScoped ? scoped : allAnalyses;

  const peers = cohortScorecards
    .map((card) => ({ tenantId: card.tenantId, brandName: card.brandName, aeoScore: card.aeoScore.current }))
    .sort((a, b) => b.aeoScore - a.aeoScore);
  const position = peers.findIndex((peer) => peer.tenantId === tenant.tenantId) + 1;

  const competitorShareOfMention = shareOfMentionFrom(analyses, tenant.brandName);
  const top = topRecommendationFrom(allAnalyses, tenant.brandName);

  // 엔진별 분해 — 전체와 **같은 함수**로 계산한다. 규칙을 복제하면 "합계는 맞는데 엔진별 합이
  // 안 맞는" 상태가 조용히 생긴다. 모집단의 비대칭(언급 점유는 카테고리 무관, 순위는 전체)도
  // 그대로 유지해야 두 수치가 위쪽 요약과 대조된다.
  const engines = [...new Set(allAnalyses.map((a) => a.engine))].sort((a, b) =>
    ENGINE_ORDER.indexOf(a) - ENGINE_ORDER.indexOf(b),
  );
  const byEngine: EngineRanking[] = engines.map((engine) => {
    const scopedForEngine = analyses.filter((a) => a.engine === engine);
    const allForEngine = allAnalyses.filter((a) => a.engine === engine);
    const engineTop = topRecommendationFrom(allForEngine, tenant.brandName);
    return {
      engine,
      competitorShareOfMention: shareOfMentionFrom(scopedForEngine, tenant.brandName),
      topRecommendationRate: engineTop.rate,
      mentionCalls: scopedForEngine.length,
      rankedCalls: engineTop.ranked,
    };
  });

  return {
    cohort: { position, totalTenants: peers.length, peers },
    competitorShareOfMention,
    mentionScope: useScoped ? 'category-agnostic' : 'all',
    topRecommendationRate: top.rate,
    byEngine,
  };
}

/** EEAT 분석 — B5 판정에서 Experience/Expertise/Authoritativeness/Trustworthiness를 집계한다. */
export async function getEeatAnalysis(
  store: CitationSource,
  tenantId: string,
  weekOf: string,
): Promise<EeatAnalysis> {
  const analyses = await store.getQuestionAnalyses(tenantId, weekOf);
  return computeEeatAnalysis(analyses);
}

/** AI 인용출처 분석 — 소유권을 넘어 출처 유형·엔진 치우침·합의 도메인을 집계한다. */
export async function getCitationSourceAnalysis(
  store: CitationSource,
  tenantId: string,
  weekOf: string,
): Promise<CitationSourceAnalysis> {
  const analyses = await store.getQuestionAnalyses(tenantId, weekOf);
  return analyzeCitationSources(analyses);
}
