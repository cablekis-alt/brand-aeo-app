import type { EeatAnalysis } from '../src/prompts/b6-eeat.js';
import type { CitationSourceAnalysis } from '../src/prompts/b7-citation-sources.js';
import { analyzeCitationSources, canonicalUrl } from './citationSources.js';
import { computeEeatAnalysis } from './eeat.js';
import { agnosticAnalyses } from './mentionScope.js';
import type { ResultStore } from './store.js';
import type { QuestionRepeatAnalysis } from './types.js';

/** 인용 집계에 필요한 읽기 메서드만 요구한다 (배포 환경의 읽기 전용 스토어도 그대로 쓸 수 있도록). */
type CitationSource = Pick<ResultStore, 'getQuestionAnalyses' | 'getScorecardHistory'>;
type RankingSource = Pick<ResultStore, 'getQuestionAnalyses' | 'getCohortScorecards' | 'getQuestionBank'>;

export interface CitationBreakdownRow {
  /** 정규화된 호스트 — www.·m. 접두를 접고 소문자로. 같은 사이트가 여러 줄로 갈라지지 않게 한다. */
  domain: string;
  /** 이 호스트의 대표 소유권 — 인용별 판정의 다수결. 근거는 ownerTypeCounts. */
  ownerType: string;
  /** 소유권 판정별 인용 수. 화면에서 "왜 이 소유권인가"를 보여 주는 근거. */
  ownerTypeCounts: Record<string, number>;
  /** unknown을 뺀 판정이 둘 이상 갈렸는가 — 같은 사이트를 판정이 경쟁사/제3자로 다르게 봤다는 뜻. */
  mixed: boolean;
  citationCount: number;
  /** 이 주 전체 인용 중 비중(0~1). */
  share: number;
  supportingBrandMentionCount: number;
  /** 이 호스트에서 실제 인용된 URL — 많이 인용된 순 상위 10개. "그 블로그 글이 뭔데?"에 답한다. */
  urls: CitationBreakdownUrl[];
  /** 전주 점유율(0~1). 비교 가능할 때만 값이 있고, 전주에 없던 도메인은 0. 비교 불가면 null. */
  previousShare: number | null;
}

export interface CitationBreakdownUrl {
  /** 해시·추적 파라미터를 뗀 URL(citationSources.canonicalUrl). */
  url: string;
  citationCount: number;
  engines: string[];
  supportingBrandMentionCount: number;
}

export interface CitationBreakdown {
  rows: CitationBreakdownRow[];
  brandOwnedCitationRate: number;
  totalCitations: number;
  /** 이 주에 응답을 낸 수집 엔진(필터 전 기준). 화면의 엔진 필터 선택지. */
  engines: string[];
  /** 적용된 엔진 필터. 있으면 rows·share·totalCitations 전부 그 엔진 응답만으로 낸 값이다. */
  engine: string | null;
  /**
   * 전주 대비. 수집 엔진이 같을 때만 비교한다 — 엔진이 다르면 출처 분포가 통째로 바뀌므로
   * (Gemini는 예약 플랫폼, Perplexity는 네이버 블로그를 끌어온다) 변화가 아니라 잡음을 그리게 된다.
   * 엔진 필터가 켜져 있으면 두 주가 모두 그 엔진을 썼는지만 본다 — 그래서 필터를 켜면 엔진 구성이
   * 바뀐 주차 사이에서도 비교가 살아난다. null이면 전주 자체가 없다.
   */
  comparison: CitationComparison | null;
}

export interface CitationComparison {
  previousWeekOf: string;
  comparable: boolean;
  /** 비교 불가 사유(화면 문구). comparable=true면 없음. */
  reason?: string;
  previousEngines: string[];
  currentEngines: string[];
}

/**
 * 인용 호스트 정규화 — 도메인별 집계의 키.
 *
 * `www.`와 모바일 `m.` 접두를 접고 소문자로 맞춘다. 이걸 하지 않으면 k-wonjin.co.kr /
 * www.k-wonjin.co.kr / m.k-wonjin.co.kr 이 세 줄로 갈라져, 고객이 "우리 사이트가 몇 번
 * 인용됐나"를 눈으로 더해야 한다(2026-09-18 원진 W38 화면에서 실제로 그랬다).
 * `blog.`·`news.` 같은 의미 있는 서브도메인은 접지 않는다 — 다른 매체다.
 */
export function normalizeCitationHost(domainOrRaw: string): string {
  let host = domainOrRaw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
    try {
      host = new URL(host).hostname;
    } catch {
      host = host.split('/')[0] ?? host;
    }
  } else {
    host = host.split('/')[0] ?? host;
  }
  return host
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^(?:www|m)\./, '');
}

/**
 * 소유권 다수결. `unknown`은 "판정 없음"이라 판정이 하나라도 있으면 표에서 빼고 센다.
 * 동률이면 더 구체적인 쪽(자사 > 경쟁사 > 제3자 권위 > 제3자 UGC)을 택한다 —
 * "경쟁사 3 · 제3자 권위 3"이면 경쟁사로 보는 게 브랜드 관점에서 안전한 쪽이다.
 *
 * `mixed`는 차순위 판정이 판정 전체의 20% 이상일 때만 켠다. blog.naver.com 이 UGC 68 · 경쟁사 1로
 * 갈렸다고 「혼재」를 붙이면 잡음을 신호처럼 보이게 한다 — 그건 판정 1건이 튄 것이다.
 * sswan.co.kr(경쟁사 5 · 권위 3)처럼 실제로 갈린 경우만 표시한다.
 */
const OWNER_TYPE_PRIORITY = ['brand-owned', 'competitor-owned', 'third-party-authority', 'third-party-ugc', 'unknown'];
const MIXED_RUNNER_UP_SHARE = 0.2;
function majorityOwnerType(counts: Record<string, number>): { ownerType: string; mixed: boolean } {
  const judged = Object.entries(counts).filter(([t, n]) => t !== 'unknown' && n > 0);
  const pool = judged.length > 0 ? judged : Object.entries(counts);
  pool.sort((a, b) => b[1] - a[1] || OWNER_TYPE_PRIORITY.indexOf(a[0]) - OWNER_TYPE_PRIORITY.indexOf(b[0]));
  const judgedTotal = judged.reduce((sum, [, n]) => sum + n, 0);
  const runnerUp = judged.length > 1 ? (pool[1]?.[1] ?? 0) : 0;
  return {
    ownerType: pool[0]?.[0] ?? 'unknown',
    mixed: judged.length > 1 && runnerUp / judgedTotal >= MIXED_RUNNER_UP_SHARE,
  };
}

/**
 * URL 상세 분석 — 주간 응답에 등장한 인용을 **호스트 기준**으로 집계한다.
 *
 * 이전에는 키가 `domain::ownerType`이어서 같은 호스트가 소유권별로 여러 줄이 됐다
 * (sswan.co.kr 이 경쟁사·제3자 권위·알 수 없음 세 줄). 판정이 응답마다 흔들린 것이 그대로
 * 표에 노출돼 "이 사이트는 경쟁사인가요, 언론인가요?"라는 질문을 낳았다. 이제 호스트당
 * 한 줄, 소유권은 다수결로 정하고 갈린 사실(mixed)과 근거(ownerTypeCounts)를 함께 준다.
 * brandOwnedCitationRate는 aggregate.ts와 같은 **인용 단위** 비율 그대로다.
 */
export interface CitationBreakdownOptions {
  /** 수집 엔진 하나로 좁혀 본다(예: 'openai'). */
  engine?: string | null;
  /** 내부용 — 전주 계산 시 재귀를 끊는다. */
  withComparison?: boolean;
}

const distinctEngines = (analyses: QuestionRepeatAnalysis[]): string[] =>
  [...new Set(analyses.map((a) => a.engine))].sort();

const sameEngineSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((e, i) => e === b[i]);

export async function getCitationBreakdown(
  store: CitationSource,
  tenantId: string,
  weekOf: string,
  options: CitationBreakdownOptions = {},
): Promise<CitationBreakdown> {
  const engine = options.engine?.trim() || null;
  const withComparison = options.withComparison ?? true;
  const allAnalyses = await store.getQuestionAnalyses(tenantId, weekOf);
  const engines = distinctEngines(allAnalyses);
  const analyses = engine ? allAnalyses.filter((a) => a.engine === engine) : allAnalyses;
  type UrlAcc = { citationCount: number; engines: Set<string>; supporting: number };
  type Acc = { counts: Record<string, number>; citationCount: number; supporting: number; urls: Map<string, UrlAcc> };
  const byHost = new Map<string, Acc>();
  let totalCitations = 0;
  let brandOwnedCitations = 0;

  for (const analysis of analyses) {
    for (const citation of analysis.citations) {
      totalCitations += 1;
      if (citation.ownerType === 'brand-owned') brandOwnedCitations += 1;

      const host = normalizeCitationHost(citation.domain ?? citation.raw);
      const acc = byHost.get(host) ?? { counts: {}, citationCount: 0, supporting: 0, urls: new Map<string, UrlAcc>() };
      acc.counts[citation.ownerType] = (acc.counts[citation.ownerType] ?? 0) + 1;
      acc.citationCount += 1;
      if (citation.supportsBrandMention) acc.supporting += 1;
      const url = canonicalUrl(citation.raw);
      const u = acc.urls.get(url) ?? { citationCount: 0, engines: new Set<string>(), supporting: 0 };
      u.citationCount += 1;
      u.engines.add(analysis.engine);
      if (citation.supportsBrandMention) u.supporting += 1;
      acc.urls.set(url, u);
      byHost.set(host, acc);
    }
  }

  const rows: CitationBreakdownRow[] = [...byHost.entries()]
    .map(([domain, acc]) => {
      const { ownerType, mixed } = majorityOwnerType(acc.counts);
      return {
        domain,
        ownerType,
        ownerTypeCounts: acc.counts,
        mixed,
        citationCount: acc.citationCount,
        share: totalCitations > 0 ? acc.citationCount / totalCitations : 0,
        supportingBrandMentionCount: acc.supporting,
        urls: [...acc.urls.entries()]
          .map(([url, u]) => ({
            url,
            citationCount: u.citationCount,
            engines: [...u.engines].sort(),
            supportingBrandMentionCount: u.supporting,
          }))
          .sort((a, b) => b.citationCount - a.citationCount || a.url.localeCompare(b.url))
          .slice(0, 10),
        previousShare: null,
      };
    })
    .sort((a, b) => b.citationCount - a.citationCount || a.domain.localeCompare(b.domain));

  let comparison: CitationComparison | null = null;
  if (withComparison) {
    // 전주 = 이력에서 이번 주보다 앞선 가장 최근 주차. 이력이 없거나 이번 주가 첫 주면 비교 대상 없음.
    const history = await store.getScorecardHistory(tenantId, 104);
    const previousWeekOf = history
      .map((c) => c.weekOf)
      .filter((w) => w < weekOf)
      .sort()
      .pop();
    if (previousWeekOf) {
      const prevAll = await store.getQuestionAnalyses(tenantId, previousWeekOf);
      const previousEngines = distinctEngines(prevAll);
      const comparable = engine
        ? previousEngines.includes(engine) && engines.includes(engine)
        : sameEngineSet(previousEngines, engines);
      if (comparable) {
        const prev = await getCitationBreakdown(store, tenantId, previousWeekOf, { engine, withComparison: false });
        const prevShare = new Map(prev.rows.map((r) => [r.domain, r.share]));
        for (const row of rows) row.previousShare = prevShare.get(row.domain) ?? 0;
        comparison = { previousWeekOf, comparable: true, previousEngines, currentEngines: engines };
      } else {
        const reason = engine
          ? `전주(${previousWeekOf})에 ${engine} 응답이 없어 비교 불가`
          : `수집 엔진이 달라 비교 불가 — 전주 ${previousEngines.join('+') || '없음'} · 이번 주 ${engines.join('+') || '없음'}`;
        comparison = { previousWeekOf, comparable: false, reason, previousEngines, currentEngines: engines };
      }
    }
  }

  return {
    rows,
    brandOwnedCitationRate: totalCitations > 0 ? brandOwnedCitations / totalCitations : 0,
    totalCitations,
    engines,
    engine,
    comparison,
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
