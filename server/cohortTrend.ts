import type { ResultStore } from './store.js';

/**
 * 주차별 코호트 평균 — 추이 그래프에 겹쳐 그릴 비교선.
 *
 * 왜 순위로 부족한가. 지금 화면은 "코호트 3/7"만 말한다. 순위는 **얼마나** 벌어졌는지를
 * 감춘다 — 3등이 평균을 10점 앞설 수도, 1점 뒤질 수도 있고, 코호트 전체가 같이 오른 주에
 * 우리만 제자리여도 순위는 그대로다. 평균선을 겹치면 "우리가 오른 것"과 "판이 오른 것"이
 * 분리돼 보인다.
 *
 * 자사를 평균에서 뺀다. 코호트가 작아서(실측 n=4) 자기를 넣으면 자기 점수가 비교 기준을
 * 끌어당겨 격차가 줄어 보인다. 비교 대상은 "나 말고 나머지"여야 한다.
 */
export interface CohortTrendPoint {
  weekOf: string;
  /** 자사를 뺀 코호트 평균. 비교할 브랜드가 없으면 null — 0으로 적지 않는다. */
  avg: number | null;
  /** 평균에 들어간 브랜드 수(자사 제외). 0이면 그 주는 비교 불가다. */
  peerCount: number;
}

export async function getCohortTrend(
  store: ResultStore,
  tenant: { tenantId: string; industry: string; region: string },
  weeksBack = 12,
): Promise<CohortTrendPoint[]> {
  const history = await store.getScorecardHistory(tenant.tenantId, weeksBack);
  const points: CohortTrendPoint[] = [];
  for (const card of history) {
    const cards = await store.getCohortScorecards(tenant.industry, tenant.region, card.weekOf);
    const peers = cards.filter((c) => c.tenantId !== tenant.tenantId);
    points.push({
      weekOf: card.weekOf,
      avg: peers.length > 0 ? Math.round(peers.reduce((sum, c) => sum + c.aeoScore.current, 0) / peers.length) : null,
      peerCount: peers.length,
    });
  }
  return points;
}
