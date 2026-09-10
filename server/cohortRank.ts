import { computeCohortRank } from './scoring.js';
import type { ResultStore } from './store.js';

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
 * 이미 저장된 옛 주차는 scripts/rescore-local.ts가 같은 계산을 한다.
 *
 * @returns 값이 달라져서 다시 저장한 카드 수
 */
export async function reconcileCohortRanks(
  store: ResultStore,
  industry: string,
  region: string,
  weekOf: string,
): Promise<number> {
  const cards = await store.getCohortScorecards(industry, region, weekOf);
  let updated = 0;
  for (const card of cards) {
    const next = computeCohortRank(card.aeoScore.current, cards);
    const prev = card.cohortRank;
    if (prev && prev.position === next.position && prev.totalTenants === next.totalTenants) continue;
    // saveScorecard는 주차 카드와 히스토리를 함께 갱신한다 — 화면은 히스토리를 읽는다.
    await store.saveScorecard({ ...card, cohortRank: next });
    updated += 1;
  }
  return updated;
}
