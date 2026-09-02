import type { EeatAnalysis } from '../src/prompts/b6-eeat.js';
import type { CitationSourceAnalysis } from '../src/prompts/b7-citation-sources.js';
import { analyzeCitationSources } from './citationSources.js';
import { computeEeatAnalysis } from './eeat.js';
import type { ResultStore } from './store.js';

/** 인용 집계에 필요한 읽기 메서드만 요구한다 (배포 환경의 읽기 전용 스토어도 그대로 쓸 수 있도록). */
type CitationSource = Pick<ResultStore, 'getQuestionAnalyses'>;
type RankingSource = Pick<ResultStore, 'getQuestionAnalyses' | 'getCohortScorecards'>;

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

/** S-05 URL 상세 분석 — 주간 응답에 등장한 인용을 도메인×소유권 기준으로 집계한다. */
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

export interface RankingView {
  cohort: {
    position: number; // 0이면 해당 주차 코호트 데이터 없음
    totalTenants: number;
    peers: { tenantId: string; brandName: string; aeoScore: number }[];
  };
  competitorShareOfMention: { name: string; mentionCount: number; share: number }[];
  topRecommendationRate: number; // 순위 판정이 있었던 응답 중 자사가 1위로 뽑힌 비율
}

/** 코호트·언급 점유 계산에 필요한 테넌트 속성만 받는다. */
export interface RankingTenant {
  tenantId: string;
  brandName: string;
  industry: string;
  region: string;
}

/** S-07 랭킹 분석 — 업종·지역 코호트 순위 + 테넌트 내부 경쟁사 언급 점유율을 한 번에 내려준다. */
export async function getRankingView(
  store: RankingSource,
  tenant: RankingTenant,
  weekOf: string,
): Promise<RankingView> {
  const [cohortScorecards, analyses] = await Promise.all([
    store.getCohortScorecards(tenant.industry, tenant.region, weekOf),
    store.getQuestionAnalyses(tenant.tenantId, weekOf),
  ]);

  const peers = cohortScorecards
    .map((card) => ({ tenantId: card.tenantId, brandName: card.brandName, aeoScore: card.aeoScore.current }))
    .sort((a, b) => b.aeoScore - a.aeoScore);
  const position = peers.findIndex((peer) => peer.tenantId === tenant.tenantId) + 1;

  const mentionTotals = new Map<string, number>();
  mentionTotals.set(tenant.brandName, 0);
  for (const analysis of analyses) {
    mentionTotals.set(tenant.brandName, (mentionTotals.get(tenant.brandName) ?? 0) + analysis.mentionSentences.length);
    for (const competitor of analysis.competitorMentions) {
      mentionTotals.set(competitor.name, (mentionTotals.get(competitor.name) ?? 0) + competitor.mentionCount);
    }
  }
  const totalMentions = [...mentionTotals.values()].reduce((sum, count) => sum + count, 0);
  const competitorShareOfMention = [...mentionTotals.entries()]
    .map(([name, mentionCount]) => ({
      name,
      mentionCount,
      share: totalMentions > 0 ? mentionCount / totalMentions : 0,
    }))
    .sort((a, b) => b.mentionCount - a.mentionCount);

  const withRanking = analyses.filter((analysis) => analysis.topRecommendation !== null);
  const topForBrand = withRanking.filter((analysis) => analysis.topRecommendation === tenant.brandName).length;

  return {
    cohort: { position, totalTenants: peers.length, peers },
    competitorShareOfMention,
    topRecommendationRate: withRanking.length > 0 ? topForBrand / withRanking.length : 0,
  };
}

/** S-09 EEAT 분석 — B5 판정에서 Experience/Expertise/Authoritativeness/Trustworthiness를 집계한다. */
export async function getEeatAnalysis(
  store: CitationSource,
  tenantId: string,
  weekOf: string,
): Promise<EeatAnalysis> {
  const analyses = await store.getQuestionAnalyses(tenantId, weekOf);
  return computeEeatAnalysis(analyses);
}

/** S-10 AI 인용출처 분석 — 소유권을 넘어 출처 유형·엔진 치우침·합의 도메인을 집계한다. */
export async function getCitationSourceAnalysis(
  store: CitationSource,
  tenantId: string,
  weekOf: string,
): Promise<CitationSourceAnalysis> {
  const analyses = await store.getQuestionAnalyses(tenantId, weekOf);
  return analyzeCitationSources(analyses);
}
