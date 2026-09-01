/**
 * 저장된 스테이 머뭄 실측 분석(live-stay-question-analyses.json)으로부터 스코어카드를 재계산한다.
 * 새 API 호출 없이, SoM=null(경쟁사 없음) + 재정규화된 AEO Score를 반영한다.
 *   npx tsx scripts/recompute-stay-scorecard.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { computeAeoScore, meanWithConfidenceInterval, mean } from '../server/scoring';
import type { WeeklyScorecard } from '../src/prompts/b8-report';
import type { QuestionRepeatAnalysis } from '../server/types';

const TENANT_ID = 'stay-meomum';

const live = JSON.parse(readFileSync('src/data/live-stay-question-analyses.json', 'utf8')) as {
  analyses: QuestionRepeatAnalysis[];
};
const analyses = live.analyses;

// 경쟁사가 없으므로 SoM은 null. per-call 점수도 SoM을 제외하고 재정규화한다.
const perCallScores = analyses.map((a) => {
  const perCallFactuality =
    a.factualitySupported + a.factualityContradicted > 0
      ? a.factualitySupported / (a.factualitySupported + a.factualityContradicted)
      : 1;
  return computeAeoScore({
    mentionRate: a.mentioned ? 1 : 0,
    shareOfMention: null,
    avgRecommendationRank: a.brandRank,
    factualityScore: perCallFactuality,
    brandOwnedCitationRate: a.brandOwnedCitation ? 1 : 0,
  });
});

const ci = meanWithConfidenceInterval(perCallScores);
const current = Math.round(ci.mean);

const cards = JSON.parse(readFileSync('src/data/demo-scorecards.json', 'utf8')) as WeeklyScorecard[];
const stay = cards.find((c) => c.tenantId === TENANT_ID);
if (!stay) throw new Error('stay-meomum 스코어카드를 찾지 못했습니다.');

const before = { score: stay.aeoScore.current, som: stay.shareOfMention };

stay.shareOfMention = null;
stay.aeoScore = {
  current,
  ma4: current,
  previousWeek: current,
  ciLow: Math.round(ci.low * 10) / 10,
  ciHigh: Math.round(ci.high * 10) / 10,
};

writeFileSync('src/data/demo-scorecards.json', JSON.stringify(cards, null, 2) + '\n');

console.log('재계산 전:', JSON.stringify(before));
console.log('재계산 후: score', current, '| SoM null | CI', stay.aeoScore.ciLow, '~', stay.aeoScore.ciHigh);
console.log('언급률(불변):', (stay.mentionRate * 100).toFixed(1) + '%', '| 사실성:', (stay.factualityScore * 100).toFixed(0) + '%');
console.log('per-call 평균:', mean(perCallScores).toFixed(2));
