/**
 * 저장된 실측 분석(live-*-question-analyses.json)으로부터 두 테넌트 스코어카드를 재계산한다.
 * 새 API 호출 없이, aggregateScorecard의 최신 로직(횟수 기준 SoM + 결정적 점수 + CI 폭)을 반영한다.
 *   npx tsx scripts/recompute-stay-scorecard.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { computeAeoScore, mean, meanWithConfidenceInterval } from '../server/scoring';
import type { WeeklyScorecard } from '../src/prompts/b8-report';
import type { QuestionSpec } from '../src/prompts/types';
import type { QuestionRepeatAnalysis, TenantConfig } from '../server/types';

interface Source {
  tenantId: string;
  bankPath: string;
  analysesPath: string;
}

const SOURCES: Source[] = [
  {
    tenantId: 'example-brand',
    bankPath: 'src/data/live-question-bank.json',
    analysesPath: 'src/data/live-question-analyses.json',
  },
  {
    tenantId: 'stay-meomum',
    bankPath: 'src/data/live-stay-question-bank.json',
    analysesPath: 'src/data/live-stay-question-analyses.json',
  },
];

const read = <T,>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;

const tenants = read<TenantConfig[]>('server/tenants.config.json');
const cards = read<WeeklyScorecard[]>('src/data/demo-scorecards.json');

function recompute(source: Source): WeeklyScorecard {
  const tenant = tenants.find((t) => t.tenantId === source.tenantId);
  if (!tenant) throw new Error(`tenant 없음: ${source.tenantId}`);
  const prev = cards.find((c) => c.tenantId === source.tenantId);
  if (!prev) throw new Error(`기존 스코어카드 없음: ${source.tenantId}`);

  const bank = read<{ questions: QuestionSpec[] }>(source.bankPath);
  const analyses = read<{ analyses: QuestionRepeatAnalysis[] }>(source.analysesPath).analyses;
  const catOf = new Map(bank.questions.map((q) => [q.questionId, q.category]));

  const agnostic = analyses.filter((a) => catOf.get(a.questionId) === 'category-agnostic');
  const mentionRate = mean(agnostic.map((a) => (a.mentioned ? 1 : 0)));

  const hasCompetitors = tenant.competitors.length > 0;
  const brandMentionTotal = analyses.reduce((s, a) => s + a.mentionSentences.length, 0);
  const competitorMentionTotal = analyses.reduce(
    (s, a) => s + a.competitorMentions.reduce((t, c) => t + c.mentionCount, 0),
    0,
  );
  const shareTotal = brandMentionTotal + competitorMentionTotal;
  const shareOfMention = hasCompetitors && shareTotal > 0 ? brandMentionTotal / shareTotal : null;

  const ranks = analyses.map((a) => a.brandRank).filter((r): r is number => r !== null);
  const avgRecommendationRank = ranks.length > 0 ? mean(ranks) : null;

  const supported = analyses.reduce((s, a) => s + a.factualitySupported, 0);
  const contradicted = analyses.reduce((s, a) => s + a.factualityContradicted, 0);
  const factualityScore = supported + contradicted > 0 ? supported / (supported + contradicted) : 1;

  const brandOwnedCitationRate = mean(analyses.map((a) => (a.brandOwnedCitation ? 1 : 0)));

  const currentScore = computeAeoScore({
    mentionRate,
    shareOfMention,
    avgRecommendationRank,
    factualityScore,
    brandOwnedCitationRate,
  });

  const perCallScores = analyses.map((a) => {
    const f = a.factualitySupported + a.factualityContradicted > 0
      ? a.factualitySupported / (a.factualitySupported + a.factualityContradicted)
      : 1;
    return computeAeoScore({
      mentionRate: a.mentioned ? 1 : 0,
      shareOfMention: hasCompetitors ? a.shareOfMention : null,
      avgRecommendationRank: a.brandRank,
      factualityScore: f,
      brandOwnedCitationRate: a.brandOwnedCitation ? 1 : 0,
    });
  });
  const ci = meanWithConfidenceInterval(perCallScores);
  const margin = ci.high - ci.mean;

  return {
    ...prev,
    aeoScore: {
      current: currentScore,
      ma4: currentScore,
      previousWeek: currentScore,
      ciLow: Math.round((currentScore - margin) * 10) / 10,
      ciHigh: Math.round((currentScore + margin) * 10) / 10,
    },
    mentionRate,
    shareOfMention,
    avgRecommendationRank,
    factualityScore,
    brandOwnedCitationRate,
  };
}

const next = cards.map((c) => {
  const src = SOURCES.find((s) => s.tenantId === c.tenantId);
  if (!src) return c;
  const updated = recompute(src);
  console.log(
    `${c.tenantId}: Score ${c.aeoScore.current}→${updated.aeoScore.current} | SoM ${c.shareOfMention === null ? 'null' : (c.shareOfMention * 100).toFixed(1) + '%'}→${updated.shareOfMention === null ? 'null(판정불가)' : (updated.shareOfMention * 100).toFixed(1) + '%'}`,
  );
  return updated;
});

writeFileSync('src/data/demo-scorecards.json', JSON.stringify(next, null, 2) + '\n');
console.log('demo-scorecards.json 갱신 완료');
