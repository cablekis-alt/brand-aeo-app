import type { CohortExclusion } from './cohortExclusionStore.js';
import { computeCohortRank, sameCohortRank } from './scoring.js';
import type { ResultStore } from './store.js';
import type { WeeklyScorecard } from '../src/prompts/b8-report.js';

type CohortRank = NonNullable<WeeklyScorecard['cohortRank']>;

/** 코호트 한 주의 순위 다시 세기 결과 — 저장하지 않는다. */
export interface CohortRankPlan {
  industry: string;
  region: string;
  weekOf: string;
  /** 다시 센 뒤 순위표에 남는 카드마다 지금 저장된 순위와 새 순위. */
  cards: { tenantId: string; brandName: string; before: CohortRank | null; after: CohortRank; changed: boolean }[];
}

/**
 * 코호트(업종 · 지역 · 주차) 순위를 완성된 집합으로 다시 센다 — 저장하지 않는다. exclusions를 주면 파일 대신 그 제외 목록으로
 * 카드를 거른다(「지난 기록에서도 빼기」 미리보기). 저장하는 reconcileCohortRanks도 이 함수를 거친다 — 미리 본 순위와
 * 저장되는 순위가 같은 계산에서 나온다.
 */
export async function planCohortRanks(
  store: ResultStore,
  industry: string,
  region: string,
  weekOf: string,
  exclusions?: readonly CohortExclusion[],
): Promise<CohortRankPlan> {
  return (await rankCohort(store, industry, region, weekOf, exclusions)).plan;
}

async function rankCohort(
  store: ResultStore,
  industry: string,
  region: string,
  weekOf: string,
  exclusions?: readonly CohortExclusion[],
): Promise<{ cards: WeeklyScorecard[]; plan: CohortRankPlan }> {
  const cards = await store.getCohortScorecards(industry, region, weekOf, exclusions ? { exclusions } : undefined);
  return {
    cards,
    plan: {
      industry,
      region,
      weekOf,
      cards: cards.map((card) => {
        const after = computeCohortRank(card.aeoScore.current, cards);
        return { tenantId: card.tenantId, brandName: card.brandName, before: card.cohortRank ?? null, after, changed: !sameCohortRank(card.cohortRank, after) };
      }),
    },
  };
}

/**
 * 같은 코호트(업종·지역·주차)의 순위를 **완성된 집합**으로 다시 계산해 저장한다.
 *
 * 파이프라인은 순위를 "그 순간까지 저장된 카드"로 계산한다. 자기 카드는 아직 저장 전이고
 * 형제 브랜드도 측정 중이라, 분모가 측정 순서에 따라 달라진다
 * (실측 2026-W37: torder 2/4 — 5개를 측정했는데 자기 자신이 빠졌다. payhere·vdcompany는 1/1).
 *
 * 웹 배포본에서는 baking(scripts/publish-tenant.ts)이 전체 집합으로 다시 계산해 가려져 있었다.
 * 하지만 패키징(데스크톱) 모드는 baking을 건너뛰고 API가 저장된 값을 그대로 읽는다 —
 * 그래서 앱에서는 틀린 분모가 그대로 보였다. 여기서 맞춘다.
 *
 * 이미 저장된 옛 주차는 scripts/rescore-local.ts가 같은 계산을 한다(그 스크립트는 코호트 제외 목록을 모른다).
 *
 * 제외 목록으로 빠진 카드 자신의 저장 순위는 건드리지 않는다 — 지운 브랜드(툼스톤)와 같다.
 *
 * @returns 값이 달라져서 다시 저장한 카드 수
 */
export async function reconcileCohortRanks(
  store: ResultStore,
  industry: string,
  region: string,
  weekOf: string,
  exclusions?: readonly CohortExclusion[],
): Promise<number> {
  const { cards, plan } = await rankCohort(store, industry, region, weekOf, exclusions);
  let updated = 0;
  for (const [i, card] of cards.entries()) {
    const next = plan.cards[i];
    if (!next?.changed) continue;
    // saveScorecard는 주차 카드와 히스토리를 함께 갱신한다 — 화면은 히스토리를 읽는다.
    await store.saveScorecard({ ...card, cohortRank: next.after });
    updated += 1;
  }
  return updated;
}

/** 코호트 한 주를 가리키는 키. */
export interface CohortWeekKey {
  industry: string;
  region: string;
  weekOf: string;
}

/**
 * 제외 항목이 건드리는 코호트 주차 — 그 경쟁사 기록 가운데 항목의 업종 · 지역 · 주차 범위에 드는 카드의 주차.
 * 항목을 더하든 지우든 다시 셀 주차는 같다.
 */
export async function affectedCohortWeeks(store: ResultStore, entries: readonly CohortExclusion[]): Promise<CohortWeekKey[]> {
  const out = new Map<string, CohortWeekKey>();
  for (const e of entries) {
    const history = await store.getScorecardHistory(e.tenantId, Number.MAX_SAFE_INTEGER);
    for (const card of history) {
      if (card.industry !== e.industry || card.region !== e.region) continue;
      if (card.weekOf > e.untilWeek || (e.fromWeek && card.weekOf < e.fromWeek)) continue;
      out.set(`${card.industry}|${card.region}|${card.weekOf}`, { industry: card.industry, region: card.region, weekOf: card.weekOf });
    }
  }
  return [...out.values()].sort((a, b) => a.weekOf.localeCompare(b.weekOf) || a.industry.localeCompare(b.industry) || a.region.localeCompare(b.region));
}
