import { agnosticAnalyses } from './mentionScope.js';
import type { ResultStore } from './store.js';

/**
 * 엔진별 언급률 추이 — 같은 질문을 엔진마다 물었을 때 어디서 더 나오는지.
 *
 * 왜 점수가 아니라 언급률인가. 엔진별 종합 점수를 내면 비교가 성립하지 않는다. 점수는
 * 측정 불가 항목의 가중치를 빼고 재정규화하는데, 엔진마다 빠지는 항목이 다르다
 * (원진 W38 실측: openai는 순위 판정 0건이라 P 15%가 빠지고 perplexity는 1건이라 들어간다).
 * 그러면 두 점수가 서로 다른 분모로 정규화된 값이라, 같은 축에 놓고 "이 엔진이 더 높다"고
 * 말할 수 없다. 언급률은 분모가 그 엔진의 응답 수로 분명해 그 문제가 없다.
 *
 * 계산 규칙은 스코어카드와 **같다**(server/aggregate.ts) — 카테고리 무관 질문에서만 센다.
 * 다른 규칙을 쓰면 엔진 선들의 평균이 화면 위쪽 언급률과 맞지 않는다.
 */
export interface EngineTrendPoint {
  weekOf: string;
  /** 그 주에 실제로 응답한 엔진만. 측정하지 않은 엔진은 아예 없다 — 0으로 적지 않는다. */
  byEngine: { engine: string; mentionRate: number; answers: number }[];
  /** 스코어카드와 같은 전체 언급률. 엔진 선들과 대조할 기준이다. */
  overall: number | null;
}

export async function getEngineTrend(
  store: ResultStore,
  tenant: { tenantId: string; questionBankVersion?: string },
  weeksBack = 12,
): Promise<EngineTrendPoint[]> {
  const history = await store.getScorecardHistory(tenant.tenantId, weeksBack);
  const points: EngineTrendPoint[] = [];
  for (const card of history) {
    const analyses = await store.getQuestionAnalyses(tenant.tenantId, card.weekOf);
    // 그 주차를 측정한 은행 버전을 쓴다. 현재 버전으로 부르면 옛 주차의 질문 id가 맞지 않아
    // 카테고리 분류가 통째로 비고 언급률이 전부 0으로 보인다.
    const version = card.questionBankVersion ?? tenant.questionBankVersion ?? '';
    const bank = version ? await store.getQuestionBank(tenant.tenantId, version) : null;
    if (!bank || analyses.length === 0) {
      points.push({ weekOf: card.weekOf, byEngine: [], overall: null });
      continue;
    }
    const scoped = agnosticAnalyses(analyses, bank.questions);
    if (scoped.length === 0) {
      points.push({ weekOf: card.weekOf, byEngine: [], overall: null });
      continue;
    }
    const per = new Map<string, { hit: number; n: number }>();
    for (const a of scoped) {
      const row = per.get(a.engine) ?? { hit: 0, n: 0 };
      row.n += 1;
      if (a.mentioned) row.hit += 1;
      per.set(a.engine, row);
    }
    points.push({
      weekOf: card.weekOf,
      byEngine: [...per.entries()]
        .map(([engine, v]) => ({ engine, mentionRate: v.hit / v.n, answers: v.n }))
        .sort((a, b) => a.engine.localeCompare(b.engine)),
      overall: scoped.filter((a) => a.mentioned).length / scoped.length,
    });
  }
  return points;
}
