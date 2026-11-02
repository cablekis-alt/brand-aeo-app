/**
 * 실증 질문(probe)이 점수 모집단에서 빠지는지 확인한다. 가짜 브랜드 · 가짜 주소만 쓰고 AI는 부르지 않는다.
 *
 * 왜: 실증 질문은 같은 질문지 판에 probe: true로 덧붙여 매번 측정한다. 판이 같으니 「같은 조건」 판정은 그대로 참이고,
 * 그 말이 맞으려면 점수 모집단이 문항 하나도 바뀌지 않아야 한다. 덧붙이기 전 은행 + 원래 응답과, 덧붙인 은행 + 원래 응답
 * + 실증 응답이 한 바이트도 다르지 않은 지표를 내야 한다. 특히 사실성 · 자사 인용률 · CI는 이름 없는 질문만이 아니라 전체
 * 응답을 써서, 이름 없는 질문 거르개만 고쳐서는 실증 인용이 자사 인용률(점수의 20%)에 섞인다.
 *
 *   npx tsx scripts/verify-probe-questions.ts
 */
import type { WeeklyScorecard } from '../src/prompts/b8-report';
import type { QuestionSpec } from '../src/prompts/types';
import { isProbe, isScoredAgnostic, probeIdsOf, withoutProbes } from '../src/lib/questionScope';
import { aggregateWeeklyMetrics } from '../server/aggregate';
import { getEngineTrend } from '../server/engineTrend';
import { agnosticAnalyses } from '../server/mentionScope';
import type { ResultStore } from '../server/store';
import type { CitationDetail, QuestionRepeatAnalysis } from '../server/types';

const checks: [string, boolean, string][] = [];
const check = (label: string, ok: boolean, actual = '') => checks.push([label, ok, actual]);

const VERSION = 'v5';
const spec = (questionId: string, category: QuestionSpec['category'], probe?: boolean): QuestionSpec => ({
  questionId,
  text: `${questionId} 질문`,
  category,
  industry: '테스트업종',
  region: '가상시',
  containsBrandName: category !== 'category-agnostic',
  version: VERSION,
  ...(probe !== undefined ? { probe } : {}),
});
// 덧붙이기 전 은행: 이름 없는 질문 2개 + 이름 넣은 질문 1개.
const bankBefore: QuestionSpec[] = [
  spec('v5-001', 'category-agnostic'),
  spec('v5-002', 'category-agnostic'),
  spec('v5-003', 'brand-direct'),
];
// 같은 판에 실증 2개를 덧붙인 은행 — 기존 문항은 한 글자도 바꾸지 않는다.
const bankAfter: QuestionSpec[] = [
  ...bankBefore,
  spec('v5-p001', 'category-agnostic', true),
  spec('v5-p002', 'category-agnostic', true),
];

// ── 1. 술어 ─────────────────────────────────────────────────────────────────
check('isProbe: probe true', isProbe({ probe: true }));
check('isProbe: probe false', !isProbe({ probe: false }));
check('isProbe: 필드 없음', !isProbe({}));
check('isProbe: 문항 모름(undefined)', !isProbe(undefined));
check('isScoredAgnostic: 이름 없는 일반 질문', isScoredAgnostic(bankAfter[0]));
check('isScoredAgnostic: 실증 질문은 아님', !isScoredAgnostic(bankAfter[3]));
check('isScoredAgnostic: 이름 넣은 질문은 아님', !isScoredAgnostic(bankAfter[2]));
const probeIds = probeIdsOf(bankAfter);
check('probeIdsOf: 실증 id만', probeIds.size === 2 && probeIds.has('v5-p001') && probeIds.has('v5-p002'), [...probeIds].join(','));
check('probeIdsOf: 실증 없는 은행은 빈 집합', probeIdsOf(bankBefore).size === 0);
const rows = [{ questionId: 'v5-001' }, { questionId: 'v5-p001' }, { questionId: '모르는-id' }];
const kept = withoutProbes(rows, bankAfter);
check(
  'withoutProbes: 실증만 빼고 은행에 없는 id는 남김',
  kept.length === 2 && kept[0] === rows[0] && kept[1] === rows[2],
  kept.map((r) => r.questionId).join(','),
);
check('withoutProbes: 새 배열을 돌려줌', withoutProbes(rows, bankBefore) !== rows);

// ── 2. aggregate 불변 ────────────────────────────────────────────────────────
const citation = (domain: string, ownerType: CitationDetail['ownerType']): CitationDetail => ({
  raw: `https://${domain}/page`,
  domain,
  ownerType,
  supportsBrandMention: ownerType === 'brand-owned',
});
const analysis = (
  questionId: string,
  engine: QuestionRepeatAnalysis['engine'],
  callIndex: number,
  o: { mentioned: boolean; rank?: number; citations?: CitationDetail[]; supported?: number; contradicted?: number; competitor?: number },
): QuestionRepeatAnalysis => ({
  questionId,
  engine,
  callIndex,
  mentioned: o.mentioned,
  mentionSentences: o.mentioned ? [{ sentence: '가상 숙소를 추천합니다.', sentiment: 'positive' }] : [],
  competitorMentions: o.competitor ? [{ name: '경쟁 하나', mentionCount: o.competitor, sentences: [] }] : [],
  shareOfMention: o.mentioned ? 1 : 0,
  citations: o.citations ?? [],
  topRecommendation: null,
  brandRank: o.rank ?? null,
  factualityClaims: [],
  factualitySupported: o.supported ?? 0,
  factualityContradicted: o.contradicted ?? 0,
  brandOwnedCitation: (o.citations ?? []).some((c) => c.ownerType === 'brand-owned'),
});
// 원래 응답: gemini · openai, 반복 2회. 자사 인용 1 / 전체 4.
const base: QuestionRepeatAnalysis[] = [
  analysis('v5-001', 'gemini', 1, { mentioned: true, rank: 3, competitor: 2, citations: [citation('own.example', 'brand-owned'), citation('blog.example', 'third-party-ugc')], supported: 1 }),
  analysis('v5-001', 'gemini', 2, { mentioned: false, competitor: 1 }),
  analysis('v5-002', 'openai', 1, { mentioned: false, competitor: 3, citations: [citation('rival.example', 'competitor-owned')] }),
  analysis('v5-002', 'openai', 2, { mentioned: true, rank: 2, competitor: 1 }),
  analysis('v5-003', 'gemini', 1, { mentioned: true, rank: 1, citations: [citation('news.example', 'third-party-authority')], supported: 2, contradicted: 1 }),
];
// 실증 응답: 모두 언급 · 1위 · 자사 인용 · 사실성 불일치. 반복 번호 3과 perplexity 엔진은 원래 응답에 없다 — 거르지 않으면
// 언급률 · 순위 · 자사 인용률 · 환각 플래그 · 반복 횟수 · 엔진 목록이 모두 바뀐다.
const probes: QuestionRepeatAnalysis[] = [
  analysis('v5-p001', 'gemini', 1, { mentioned: true, rank: 1, competitor: 1, citations: [citation('own.example', 'brand-owned'), citation('own.example', 'brand-owned')], supported: 3 }),
  analysis('v5-p001', 'perplexity', 3, { mentioned: true, rank: 1, citations: [citation('own.example', 'brand-owned')], contradicted: 2 }),
  analysis('v5-p002', 'openai', 2, { mentioned: true, rank: 1, citations: [citation('own.example', 'brand-owned')] }),
];
const tenant = { competitors: [{ name: '경쟁 하나' }] };

const before = JSON.stringify(aggregateWeeklyMetrics(tenant, bankBefore, base));
const afterMixed = [probes[0], ...base.slice(0, 2), probes[1], ...base.slice(2), probes[2]];
const after = aggregateWeeklyMetrics(tenant, bankAfter, afterMixed);
check('aggregate: 실증을 덧붙인 은행 + 실증 응답 = 덧붙이기 전과 같은 지표', JSON.stringify(after) === before, JSON.stringify(after));
check(
  'aggregate: 같은 은행에서 실증 응답만 더해도 같음',
  JSON.stringify(aggregateWeeklyMetrics(tenant, bankAfter, base)) === JSON.stringify(aggregateWeeklyMetrics(tenant, bankAfter, [...base, ...probes])),
);
// 거르개가 실제로 일하는지 — probe 표시를 지운 은행에서는 실증 응답이 점수를 바꿔야 한다(검사가 헛돌지 않게).
const unflagged = bankAfter.map(({ probe: _probe, ...q }) => q);
const naive = aggregateWeeklyMetrics(tenant, unflagged, afterMixed);
check('대조: probe 표시가 없으면 지표가 달라짐(검사가 헛돌지 않음)', JSON.stringify(naive) !== before, JSON.stringify(naive));

// ── 3. 자사 인용률 ───────────────────────────────────────────────────────────
check('자사 인용률: 원래 응답 기준 1/4', after.brandOwnedCitationRate === 0.25, String(after.brandOwnedCitationRate));
check('대조: 실증 인용을 세면 자사 인용률이 오름', naive.brandOwnedCitationRate > 0.25, String(naive.brandOwnedCitationRate));
check('사실성: 실증 응답의 판정을 세지 않음', after.factualityScore === 3 / 4, String(after.factualityScore));
check('환각 플래그: 실증 응답이 없음', after.hallucinationFlags.length === 1 && !after.hallucinationFlags.some((f) => f.includes('-p0')), after.hallucinationFlags.join(' | '));
check('반복 횟수 · 엔진 목록: 실증 응답이 바꾸지 않음', after.repeatsPerQuestion === 2 && after.enginesUsed.join(',') === 'openai,gemini', `${after.repeatsPerQuestion} / ${after.enginesUsed.join(',')}`);

// ── 4. agnosticAnalyses · engineTrend ───────────────────────────────────────
const scoped = agnosticAnalyses(afterMixed, bankAfter);
check('agnosticAnalyses: 실증 응답을 뺌', scoped.every((a) => !probeIds.has(a.questionId)) && scoped.length === 4, scoped.map((a) => a.questionId).join(','));
check('agnosticAnalyses: 덧붙이기 전 결과와 같은 응답', JSON.stringify(scoped) === JSON.stringify(agnosticAnalyses(base, bankBefore)));

const card = { tenantId: 'probe-test', weekOf: '2026-W44', questionBankVersion: VERSION, mentionRate: after.mentionRate } as unknown as WeeklyScorecard;
const store = {
  getScorecardHistory: async () => [card],
  getQuestionAnalyses: async () => afterMixed,
  getQuestionBank: async (_tenantId: string, version: string) => (version === VERSION ? { version, questions: bankAfter } : null),
} as unknown as ResultStore;
const [point] = await getEngineTrend(store, { tenantId: 'probe-test', questionBankVersion: VERSION });
check('engineTrend: overall = 카드 언급률', point?.overall === after.mentionRate, `${point?.overall} / ${after.mentionRate}`);
check(
  'engineTrend: 실증에만 있는 엔진(perplexity)이 없음',
  point !== undefined && !point.byEngine.some((e) => e.engine === 'perplexity') && point.byEngine.reduce((n, e) => n + e.answers, 0) === 4,
  JSON.stringify(point?.byEngine),
);

let failed = 0;
for (const [label, ok, actual] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !actual ? '' : ` — 실제: ${actual}`}`);
  if (!ok) failed += 1;
}
if (failed > 0) {
  console.error(`\n${failed}건 실패`);
  process.exit(1);
}
console.log(`\n모두 통과(${checks.length}건)`);
