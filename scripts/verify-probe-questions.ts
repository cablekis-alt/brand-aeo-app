/**
 * 실증 질문(probe)이 점수 모집단에서 빠지는지 확인한다. 가짜 브랜드 · 가짜 주소만 쓰고 AI는 부르지 않는다.
 *
 * 왜: 실증 질문은 같은 질문지 판에 probe: true로 덧붙여 매번 측정한다. 판이 같으니 「같은 조건」 판정은 그대로 참이고,
 * 그 말이 맞으려면 점수 모집단이 문항 하나도 바뀌지 않아야 한다. 덧붙이기 전 은행 + 원래 응답과, 덧붙인 은행 + 원래 응답
 * + 실증 응답이 한 바이트도 다르지 않은 지표를 내야 한다. 특히 사실성 · 자사 인용률 · CI는 이름 없는 질문만이 아니라 전체
 * 응답을 써서, 이름 없는 질문 거르개만 고쳐서는 실증 인용이 자사 인용률(점수의 20%)에 섞인다. 점수 밖에서 문항을 직접 세는 곳
 * (회차 보기 N · 브랜드 현황 질문지 비교 · 일반 질문 하한 · 인용 분해 · 인용 출처 · EEAT · 경쟁사 편집의 질문 수와 크기)도 같은
 * 규칙을 따라야 화면 숫자가 카드와 맞는다. 화면이 판정 기록으로 다시 세는 곳(점수 풀이 · 비교 그룹 「같은 질문」 · 응답 요약 · 감성 ·
 * 개요 · 개선제안 근거 · 격차 분석)도 같다. 콘텐츠 생성의 본 글 · 채널에는 실증이 들지 않고 plan.probes로만 나오며, 추가 글은 실증을
 * 맡을 수 있다(처치군). 브랜드 현황 · 경쟁사 편집은 임시 폴더를 APP_DATA_DIR로 쓴다.
 *
 *   npx tsx scripts/verify-probe-questions.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ExtraArticleForm from '../src/components/ExtraArticleForm';
import type { WeeklyScorecard } from '../src/prompts/b8-report';
import type { QuestionSpec } from '../src/prompts/types';
import { isProbe, isScoredAgnostic, probeIdsOf, withoutProbes } from '../src/lib/questionScope';
import { agnosticQuota, countAgnostic } from '../src/prompts/b1-question-bank';
import { QUESTION_SCOPE_LABEL, QUESTION_SCOPE_OPTIONS, citationBasisLabel } from '../src/lib/citationView';
import { answersCsv, buildAnswerQuestions, engineMentions, questionCoverage, unnamedOwnedCitation } from '../src/lib/answerInsights';
import { buildAnswerEvidence } from '../src/lib/answerEvidence';
import { aeoScoreOf } from '../src/lib/b9-report';
import { computeGapActions, probeQuestionList } from '../src/lib/gapActions';
import { computeGapAnalysis } from '../src/lib/gapAnalysis';
import { checkNewExtraArticle, topicArticleId } from '../src/lib/extraArticles';
import { buildRecommendationEvidence } from '../src/lib/recommendationEvidence';
import { explainScore, ownedDomainCitations } from '../src/lib/reportExplain';
import { cohortRows, selfReview } from '../src/lib/reviewReport';
import { computeSentiment } from '../src/lib/sentiment';
import type {
  QuestionBank as ClientQuestionBank,
  QuestionRepeatAnalysis as ClientAnalysis,
  QuestionSpec as ClientQuestionSpec,
} from '../src/lib/types';
import { aggregateWeeklyMetrics } from '../server/aggregate';
import { analyzeCitationSources } from '../server/citationSources';
import { linkCompetitorQuestions } from '../server/competitorQuestions';
import { getEngineTrend } from '../server/engineTrend';
import { agnosticAnalyses } from '../server/mentionScope';
import type { ResultStore } from '../server/store';
import type { CitationDetail, QuestionRepeatAnalysis, TenantConfig } from '../server/types';

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

// ── 5. 일반 질문 하한 ────────────────────────────────────────────────────────
check('countAgnostic: 실증 질문은 하한을 채우지 않음', countAgnostic(bankAfter) === 2 && countAgnostic(bankBefore) === 2, String(countAgnostic(bankAfter)));

// ── 5-1. 경쟁사 질문 잇기 ────────────────────────────────────────────────────
// 실증 질문은 만들 때 있던 경쟁사 이름을 피하지만, 나중에 더한 경쟁사 이름 · 별칭이 본문에 들어 있을 수 있다. 그래도 그 경쟁사의
// 비교 질문으로 잇지 않는다 — 이으면 경쟁사를 뺄 때 고쳐 쓰이거나(문장 · id가 바뀜) 빠진다.
const linkBank: QuestionSpec[] = [
  { ...spec('v5-004', 'comparison'), text: '가상 숙소랑 한옥 가상채 중 어디가 나아?' },
  { ...spec('v5-p003', 'category-agnostic', true), text: '가상시 한옥 가상채 같은 조용한 곳 추천해줘' },
];
const links = linkCompetitorQuestions(linkBank, [{ name: '한옥 가상채' }], ['가상 숙소']);
check(
  '경쟁사 질문 잇기: 경쟁사 이름이 든 실증 질문은 잇지 않음',
  links.byCompetitor[0]?.join() === 'v5-004' && links.questions.length === 1,
  JSON.stringify(links.byCompetitor),
);
check(
  '대조: probe 표시가 없으면 같은 문장을 이음(검사가 헛돌지 않음)',
  linkCompetitorQuestions(linkBank.map(({ probe: _probe, ...x }) => x), [{ name: '한옥 가상채' }], ['가상 숙소']).byCompetitor[0]?.length === 2,
);

// ── 5-2. 인용 갭 분석 질문 유형 필터 ─────────────────────────────────────────
// 「모든 질문」 보기도 실증 응답을 뺀다(8번) — 이름표 · 기준 문구가 그렇게 말하고, 실증 인용 출처는 따로 고를 수 있어야 한다.
check('인용 갭 필터: 실증 질문 칸이 있음', QUESTION_SCOPE_OPTIONS.includes('probe') && QUESTION_SCOPE_OPTIONS.length === 4, QUESTION_SCOPE_OPTIONS.join(','));
check('인용 갭 필터: 기본 칸(이름 없는 질문)이 맨 앞', QUESTION_SCOPE_OPTIONS[0] === 'unnamed');
check('인용 갭 필터: 「모든 질문」 이름표가 실증 제외를 말함', QUESTION_SCOPE_LABEL.all.includes('실증 제외'), QUESTION_SCOPE_LABEL.all);
check('인용 갭 기준 문구: 모든 질문은 실증을 뺀 전체', citationBasisLabel('all') === '실증 질문을 뺀 전체 인용', citationBasisLabel('all'));
check('인용 갭 기준 문구: 실증 질문 칸', citationBasisLabel('probe') === '실증 질문의 인용', citationBasisLabel('probe'));

// ── 5-3. 화면 점수 경로(src/lib) ─────────────────────────────────────────────
// 화면은 서버가 준 판정 기록 · 은행으로 점수 모집단을 다시 센다. 실증을 세면 카드와 숫자가 어긋나고, 점수 풀이는 matchesCard가
// 거짓이 되어 기록으로 센 줄을 조용히 버린다. 덧붙이기 전 은행 + 원래 응답과 같은 결과를 내야 한다.
const clientBank = (questions: QuestionSpec[]) => ({ version: VERSION, generatedAt: '', questions }) as unknown as ClientQuestionBank;
const clientQs = (questions: QuestionSpec[]) => questions as unknown as ClientQuestionSpec[];
const asClient = (list: QuestionRepeatAnalysis[]) => list as unknown as ClientAnalysis[];
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// 점수 풀이 카드 — 점수는 같은 식(aeoScoreOf, 원래 응답의 언급 문장은 모두 긍정이라 감성 1)으로 낸다(verify-report-explain.ts와 같은 방식).
const scoredRanks = agnosticAnalyses(base, bankBefore).filter((a) => a.mentioned && a.brandRank !== null).map((a) => a.brandRank as number);
const explainAvg = scoredRanks.reduce((s, r) => s + r, 0) / scoredRanks.length;
const explainScoreNow = aeoScoreOf({
  mentionRate: after.mentionRate,
  sentiment: 1,
  brandOwnedCitationRate: after.brandOwnedCitationRate,
  avgRecommendationRank: explainAvg,
  rankedResponses: scoredRanks.length,
});
const explainCard = {
  tenantId: 'probe-test',
  brandName: '가상 숙소',
  weekOf: '2026-W44',
  industry: '테스트업종',
  region: '가상시',
  aeoScore: { current: explainScoreNow, previousWeek: null, ma4: explainScoreNow, ciLow: 0, ciHigh: explainScoreNow },
  mentionRate: after.mentionRate,
  shareOfMention: null,
  avgRecommendationRank: explainAvg,
  rankedResponses: scoredRanks.length,
  factualityScore: null,
  hallucinationFlags: [],
  brandOwnedCitationRate: after.brandOwnedCitationRate,
  cohortRank: { position: 1, totalTenants: 2 },
  enginesUsed: ['gemini', 'openai'],
  judgeEngine: 'gemini',
  judgeModel: 'g-1',
  repeatsPerQuestion: 2,
  questionBankVersion: VERSION,
} as unknown as WeeklyScorecard;
const explainOf = (bank: QuestionSpec[], list: QuestionRepeatAnalysis[]) =>
  explainScore({ card: explainCard, history: [explainCard], analyses: asClient(list), bank: clientBank(bank) });
const RECORD_LINES = ['concentration', 'steps', 'effects', 'named'];
const explainBefore = explainOf(bankBefore, base);
const explainAfter = explainOf(bankAfter, afterMixed);
check(
  '점수 풀이: 실증이 있어도 기록으로 센 줄이 남음(matchesCard 참)',
  explainAfter.some((l) => l.key === 'steps') && explainAfter.some((l) => l.key === 'named'),
  explainAfter.map((l) => l.key).join(','),
);
check('점수 풀이: 덧붙이기 전과 같은 문장', sameJson(explainAfter, explainBefore));
check(
  '대조: probe 표시가 없으면 기록으로 센 줄이 빠짐(검사가 헛돌지 않음)',
  !explainOf(unflagged, afterMixed).some((l) => RECORD_LINES.includes(l.key)),
  explainOf(unflagged, afterMixed).map((l) => l.key).join(','),
);
const ownedRows = ownedDomainCitations(asClient(afterMixed), clientBank(bankAfter), ['own.example']);
check(
  '자사 주소별 인용: 실증 인용을 세지 않음',
  sameJson(ownedRows, ownedDomainCitations(asClient(base), clientBank(bankBefore), ['own.example'])) && ownedRows?.[0]?.total === 1,
  JSON.stringify(ownedRows),
);

// 비교 그룹 「같은 질문」 — 고객만 실증을 덧붙였다. 실증을 세면 같은 일반 질문을 받은 경쟁사가 「일반 질문이 다름」이 된다.
const reviewRival = { ...explainCard, tenantId: 'probe-rival', brandName: '가상 경쟁' } as WeeklyScorecard;
const cohortOf = (selfBank: QuestionSpec[]) =>
  cohortRows(explainCard, [reviewRival], { 'probe-test': clientBank(selfBank), 'probe-rival': clientBank(bankBefore) }).find((r) => !r.isSelf);
check('정기진단 비교 그룹: 실증을 덧붙여도 같은 질문', cohortOf(bankAfter)?.sameQuestions === true, String(cohortOf(bankAfter)?.sameQuestions));
check('대조: probe 표시가 없으면 다른 질문(검사가 헛돌지 않음)', cohortOf(unflagged)?.sameQuestions === false, String(cohortOf(unflagged)?.sameQuestions));
// 「틀림」 주장 — 카드의 환각 플래그처럼 실증 응답의 주장은 목록에 오르지 않는다(카드 건수 아래 목록이 건수와 맞게).
const claim = { claimText: '가상 주장', claimType: 'other' as const, verdict: 'contradicted' as const, responseValue: '가', factGraphValue: '나' };
const baseClaims = base.map((a) => (a.questionId === 'v5-003' ? { ...a, factualityClaims: [claim] } : a));
const afterClaims = [...baseClaims, { ...probes[1]!, factualityClaims: [claim] }];
const reviewAfter = selfReview(asClient(afterClaims), clientBank(bankAfter));
check(
  '정기진단 응답 요약: 일반 질문 · 카테고리 · 「틀림」이 덧붙이기 전과 같음',
  sameJson(reviewAfter, selfReview(asClient(baseClaims), clientBank(bankBefore))) &&
    reviewAfter?.general.questions === 2 &&
    reviewAfter.general.responses === 4 &&
    reviewAfter.contradicted.length === 1,
  JSON.stringify(reviewAfter?.general),
);

// 감성 — 전체 · 엔진별은 실증을 빼고, 질문별 줄은 실증 표시를 달고 남긴다.
const sentimentBefore = computeSentiment(asClient(base), clientQs(bankBefore));
const sentimentAfter = computeSentiment(asClient(afterMixed), clientQs(bankAfter));
check(
  '감성: 전체 · 엔진별 분포가 덧붙이기 전과 같음',
  sameJson(sentimentAfter.overall, sentimentBefore.overall) && sameJson(sentimentAfter.byEngine, sentimentBefore.byEngine),
  JSON.stringify({ overall: sentimentAfter.overall, engines: sentimentAfter.byEngine.map((e) => e.engine) }),
);
check(
  '감성: 질문별 줄에 실증이 실증 표시로 남음',
  sentimentAfter.byQuestion.some((q) => q.questionId === 'v5-p001' && q.probe) && sentimentAfter.byQuestion.every((q) => q.probe === probeIds.has(q.questionId)),
  JSON.stringify(sentimentAfter.byQuestion.map((q) => [q.questionId, q.probe])),
);

// 개요 · AI 답변 화면(answerInsights)
const insights = (bank: QuestionSpec[], list: QuestionRepeatAnalysis[]) => ({
  coverage: questionCoverage(asClient(list), clientQs(bank)),
  engines: engineMentions(asClient(list), clientQs(bank)),
  owned: unnamedOwnedCitation(asClient(list), clientQs(bank)),
});
check('개요: 질문 N개 중 M개 · 엔진별 언급 · 이름 없는 질문 자사 인용이 덧붙이기 전과 같음', sameJson(insights(bankAfter, afterMixed), insights(bankBefore, base)), JSON.stringify(insights(bankAfter, afterMixed)));
const answerRows = buildAnswerQuestions(asClient(afterMixed), clientQs(bankAfter), '가상 숙소');
const probeRow = answerRows.find((r) => r.questionId === 'v5-p001');
check('AI 답변: 실증 질문 줄에 실증 표시(이름 넣은 질문 아님)', probeRow?.probe === true && probeRow.named === false && answerRows.find((r) => r.questionId === 'v5-001')?.probe === false);
check('AI 답변 CSV: 질문 종류가 「실증 질문」', answersCsv(answerRows).includes('v5-p001,v5-p001 질문,,실증 질문,'), answersCsv(answerRows).split('\r\n')[1] ?? '');

// 개선제안 근거 · 격차 분석 — 밀린 일반 질문 · 묶음 판정에 실증이 들지 않는다.
const recOf = (bank: QuestionSpec[], list: QuestionRepeatAnalysis[]) =>
  buildRecommendationEvidence({ card: explainCard, analyses: asClient(list), questions: clientQs(bank), citations: null, site: null });
check('개선제안 근거: 덧붙이기 전과 같음', sameJson(recOf(bankAfter, afterClaims), recOf(bankBefore, baseClaims)), JSON.stringify(recOf(bankAfter, afterClaims)));
const gapAfter = computeGapAnalysis(asClient(afterMixed), clientQs(bankAfter));
check(
  '격차 분석: 묶음 · 질문 수가 덧붙이기 전과 같음',
  sameJson(gapAfter, computeGapAnalysis(asClient(base), clientQs(bankBefore))) && gapAfter.totalQuestions === 3,
  `질문 ${gapAfter.totalQuestions}개`,
);

// 글의 실측 사례 — 「이 글의 질문」을 물은 답을 세는 줄이라 실증만 고른 추가 글(처치군)에서도 그 답을 센다(점수 모집단이 아니다).
const probeEvidence = buildAnswerEvidence({
  weekOf: '2026-W44',
  questionIds: ['v5-p001'],
  questions: clientQs(bankAfter),
  analyses: asClient(afterMixed),
  raw: [],
  brandName: '가상 숙소',
  aliases: [],
  competitorNames: [],
  card: { enginesUsed: ['gemini', 'perplexity'] },
  sameConditionRun: [{ weekOf: '2026-W44' }],
  industry: '테스트업종',
  builtAt: '2026-10-28T03:00:00Z',
});
check('실측 사례: 실증만 고른 글도 그 질문의 답을 셈', probeEvidence.answered.asked === 2 && probeEvidence.answered.mentioned === 2, JSON.stringify(probeEvidence.answered));

// ── 5-4. 콘텐츠 생성 — 본 글 · 채널 · 추가 글 ──────────────────────────────────
// 실증은 본 글 · otherLost · 채널의 질문에 들지 않고 plan.probes로만 나온다. 실증 응답의 인용은 채널의 「충족」 · 대신 싣는 질문을
// 바꾸지 않는다. 추가 글은 실증을 맡을 수 있다(처치군). 인용 출처는 서버 기본 보기처럼 실증 응답을 뺀 응답으로 낸다.
// v5-001 패(namu.wiki · tistory 인용) · v5-002 승(네이버 블로그 인용) · v5-003 이름 넣은 질문 패 · v5-p001 패(네이버 블로그 인용) ·
// v5-p002 승(namu.wiki를 우리 근거로 인용).
const cd = (raw: string, supportsBrandMention = false): CitationDetail => ({ raw, domain: null, ownerType: 'third-party-ugc', supportsBrandMention });
const gapBase: QuestionRepeatAnalysis[] = [
  analysis('v5-001', 'gemini', 1, { mentioned: false, competitor: 1, citations: [cd('https://namu.wiki/w/가상시'), cd('https://fake-probe.tistory.com/1')] }),
  analysis('v5-001', 'gemini', 2, { mentioned: false, competitor: 1 }),
  analysis('v5-002', 'gemini', 1, { mentioned: true, citations: [cd('https://blog.naver.com/fake-probe/2')] }),
  analysis('v5-002', 'gemini', 2, { mentioned: true }),
  analysis('v5-003', 'gemini', 1, { mentioned: false, competitor: 2 }),
];
const gapProbes: QuestionRepeatAnalysis[] = [
  analysis('v5-p001', 'gemini', 1, { mentioned: false, competitor: 2, citations: [cd('https://blog.naver.com/fake-probe/p1')] }),
  analysis('v5-p002', 'gemini', 1, { mentioned: true, citations: [cd('https://namu.wiki/w/가상시', true)] }),
];
const gapAll = [...gapBase, ...gapProbes];
const gapPlan = (bank: QuestionSpec[], list: QuestionRepeatAnalysis[], opts: Parameters<typeof computeGapActions>[6] = {}) =>
  computeGapActions(asClient(list), clientQs(bank), analyzeCitationSources(withoutProbes(list, bank)), {}, [], '2026-W44', opts);
const gapBefore = gapPlan(bankBefore, gapBase);
const gapAfter2 = gapPlan(bankAfter, gapAll);
const MAIN_ID = 'content:category-agnostic';
const mainOf = (p: ReturnType<typeof gapPlan>) => p.actions.find((a) => a.id === MAIN_ID);
check('본 글: 실증 질문이 없음(진 일반 질문만)', mainOf(gapAfter2)?.questionIds.join() === 'v5-001', JSON.stringify(mainOf(gapAfter2)?.questionIds));
check('본 글 · 채널 항목: 덧붙이기 전과 같음', sameJson(gapAfter2.actions, gapBefore.actions), JSON.stringify(gapAfter2.actions.map((a) => [a.id, a.questionIds, a.satisfied])));
check('otherLost: 덧붙이기 전과 같음(이름 넣은 질문만)', sameJson(gapAfter2.otherLost, gapBefore.otherLost) && gapAfter2.otherLost.map((q) => q.questionId).join() === 'v5-003', JSON.stringify(gapAfter2.otherLost));
check(
  'plan.probes: 이긴 실증까지 판정과 함께 · 실증 없는 은행은 빈 목록',
  gapAfter2.probes.map((r) => `${r.questionId}:${r.verdict}`).join() === 'v5-p001:loss,v5-p002:win' && gapAfter2.probes.every((r) => r.probe) && gapBefore.probes.length === 0,
  gapAfter2.probes.map((r) => `${r.questionId}:${r.verdict}`).join(),
);
check(
  '채널 항목: 질문에 실증이 없음(대신 싣는 질문 포함)',
  gapAfter2.actions.filter((a) => a.kind === 'listing').every((a) => a.questionIds.every((id) => !probeIds.has(id))),
  JSON.stringify(gapAfter2.actions.filter((a) => a.kind === 'listing').map((a) => [a.id, a.questionIds])),
);
const wikiOf = (p: ReturnType<typeof gapPlan>) => p.actions.find((a) => a.id === 'listing:namu.wiki');
check('채널 「충족」: 실증 응답의 뒷받침 인용이 켜지 않음', wikiOf(gapAfter2)?.satisfied === false, JSON.stringify(wikiOf(gapAfter2)?.support));
// 대조 — probe 표시가 없으면 실증이 본 글 · 채널에 들고 「충족」이 켜진다(검사가 헛돌지 않게).
const gapNaive = gapPlan(unflagged, gapAll);
check(
  '대조: probe 표시가 없으면 본 글에 실증이 들고 namu.wiki가 「충족」',
  (mainOf(gapNaive)?.questionIds.includes('v5-p001') ?? false) && wikiOf(gapNaive)?.satisfied === true && gapNaive.probes.length === 0,
  JSON.stringify({ main: mainOf(gapNaive)?.questionIds, wiki: wikiOf(gapNaive)?.satisfied }),
);
check('은행을 못 읽은 주: plan.probes 비어 있음', gapPlan([], gapAll).probes.length === 0);

// 추가 글 — 실증만 고른 글(처치군)을 만들 수 있고, 이번 주 id로 찾아 밀린 실증을 reach로 센다. 본 글은 그대로다.
const probeArticleIds = ['v5-p002', 'v5-p001'];
const created = checkNewExtraArticle(
  { id: topicArticleId(probeArticleIds), name: '가상 처치 글', bankVersion: VERSION, questionIds: probeArticleIds, questionTexts: ['v5-p002 질문', 'v5-p001 질문'] },
  [],
  '2026-10-30T09:00:00.000Z',
);
check('추가 글: 실증 질문 id로 만들 수 있음', created.ok && created.article.id === 'topic:v5-p001+v5-p002', created.ok ? created.article.id : created.error);
if (created.ok) {
  const withProbeArticle = gapPlan(bankAfter, gapAll, { extraArticles: [created.article], bankVersion: VERSION });
  const probeArticle = withProbeArticle.actions.find((a) => a.id === created.article.id);
  check(
    '추가 글: 실증을 이번 주 id로 찾고(같은 판) 밀린 실증을 reach로 셈',
    probeArticle?.extra?.how === 'same-bank' && probeArticle.questionIds.join() === 'v5-p001,v5-p002' && probeArticle.reach === 1 && probeArticle.extra.won === 1,
    JSON.stringify({ how: probeArticle?.extra?.how, ids: probeArticle?.questionIds, reach: probeArticle?.reach }),
  );
  check('추가 글: 실증을 맡아도 본 글 · otherLost는 그대로', sameJson(mainOf(withProbeArticle), mainOf(gapAfter2)) && sameJson(withProbeArticle.otherLost, gapAfter2.otherLost));
  check('추가 글: 맡아도 plan.probes에 남음(처치 · 대조를 화면이 가름)', withProbeArticle.probes.length === 2);
}

// 추가 글이 맡은 실증에 이번 주 응답이 없을 때 — 엔진 호출이 모두 실패했거나, 실증을 덧붙이기 전에 잰 주(같은 판)를 볼 때다. 응답 줄이
// 없어 plan.probes에 없지만, 은행에서 찾았으니 확인 불가(missingTexts)도 아니다. 은행으로 실증임을 가려(extra.probes) 「글 더 만들기」의
// 본 글 목록에 「다른 글이 맡은 본 글 질문」으로 보이지 않고, 실증 목록 · 실증 칸에 「맡음」 · 확인 불가로 보여야 한다.
const bankWithSilent: QuestionSpec[] = [...bankAfter, spec('v5-p003', 'category-agnostic', true)];
const silentIds = ['v5-p003', 'v5-p001'];
const silentArticle = checkNewExtraArticle(
  { id: topicArticleId(silentIds), name: '가상 처치 글', bankVersion: VERSION, questionIds: silentIds, questionTexts: ['v5-p003 질문', 'v5-p001 질문'] },
  [],
  '2026-10-30T09:00:00.000Z',
);
check('응답 없는 실증: 추가 글을 만들 수 있음', silentArticle.ok, silentArticle.ok ? '' : silentArticle.error);
if (silentArticle.ok) {
  const silentPlan = gapPlan(bankWithSilent, gapAll, { extraArticles: [silentArticle.article], bankVersion: VERSION });
  const silentAction = silentPlan.actions.find((a) => a.id === silentArticle.article.id);
  const silentExtras = silentPlan.actions.filter((a) => a.extra);
  check(
    '응답 없는 실증: 같은 판에서 찾아 확인 불가(missingTexts)가 아니고 plan.probes에도 없음',
    silentAction?.extra?.missingTexts.length === 0 && (silentAction?.questionIds.includes('v5-p003') ?? false) && !silentPlan.probes.some((p) => p.questionId === 'v5-p003'),
    JSON.stringify({ ids: silentAction?.questionIds, missing: silentAction?.extra?.missingTexts, probes: silentPlan.probes.map((p) => p.questionId) }),
  );
  check(
    '응답 없는 실증: extra.probes가 은행으로 실증을 가림(이번 주 id · 고정 문장, 응답 있는 실증 포함)',
    sameJson(silentAction?.extra?.probes, [
      { questionId: 'v5-p001', text: 'v5-p001 질문' },
      { questionId: 'v5-p003', text: 'v5-p003 질문' },
    ]),
    JSON.stringify(silentAction?.extra?.probes),
  );
  const silentList = probeQuestionList(silentPlan.probes, silentExtras);
  check(
    '실증 목록: 응답 없는 실증을 맡음 · 판정 없음(확인 불가)으로 덧붙임',
    silentList.map((p) => `${p.questionId}:${p.verdict ?? '-'}:${p.takenBy ?? '-'}`).join() === 'v5-p001:loss:가상 처치 글,v5-p002:win:-,v5-p003:-:가상 처치 글',
    silentList.map((p) => `${p.questionId}:${p.verdict ?? '-'}:${p.takenBy ?? '-'}`).join(),
  );
  check(
    '실증 목록: 맡은 글이 없으면 응답 없는 실증은 싣지 않음',
    probeQuestionList(silentPlan.probes, []).map((p) => p.questionId).join() === 'v5-p001,v5-p002',
  );
  // 「글 더 만들기」 — 본 글 목록(aria-label="본 글의 이번 주 질문")과 실증 목록(aria-label="실증 질문")을 나눠 본다.
  // 화면 파일은 jsx 자동 변환을 전제로 하는데 tsx는 고전 변환으로 읽는다 — React를 전역에 둔다(verify-execution-marks.ts와 같다).
  Object.assign(globalThis, { React });
  const formHtml = (extraActions: typeof silentExtras) =>
    renderToStaticMarkup(
      React.createElement(ExtraArticleForm, {
        main: mainOf(silentPlan) ?? null,
        probes: silentPlan.probes,
        extraActions,
        bankVersion: VERSION,
        corrupt: false,
        loadError: null,
        onCreate: async () => null,
      }),
    );
  const listOf = (html: string, label: string) => {
    const start = html.indexOf(`aria-label="${label}"`);
    // 정적 렌더가 이웃한 글자 사이에 넣는 <!-- -->는 떼고 본다.
    return start < 0 ? '' : html.slice(start, html.indexOf('</ul>', start)).replaceAll('<!-- -->', '');
  };
  const html = formHtml(silentExtras);
  const mainList = listOf(html, '본 글의 이번 주 질문');
  const probeListHtml = listOf(html, '실증 질문');
  check('글 더 만들기: 응답 없는 실증이 본 글 목록에 없음', mainList.includes('v5-001 질문') && !mainList.includes('v5-p003'), mainList);
  check(
    '글 더 만들기: 응답 없는 실증이 실증 목록에 「맡음」 · 확인 불가로 보임',
    /v5-p003 질문<span class="muted"> · 이번 주 응답 없음\(확인 불가\)<\/span><span class="muted"> · 「가상 처치 글」 글이 맡음/.test(probeListHtml),
    probeListHtml,
  );
  // 대조 — extra.probes가 없으면 예전처럼 본 글 목록에 「다른 글이 맡은」 질문으로 보인다(검사가 헛돌지 않게).
  const naiveExtras = silentExtras.map((a) => ({ ...a, extra: a.extra ? { ...a.extra, probes: undefined } : undefined }));
  check('대조: extra.probes가 없으면 응답 없는 실증이 본 글 목록에 보임', listOf(formHtml(naiveExtras), '본 글의 이번 주 질문').includes('v5-p003 질문'));

  // 판이 바뀌어 문장으로 다시 찾은 주 — extra.probes는 새 id에 만들 때 고정한 문장을 붙인다.
  const respec = (q: QuestionSpec, id: string): QuestionSpec => ({ ...q, questionId: id, version: 'v6' });
  const bankV6: QuestionSpec[] = [...bankBefore.map((q) => ({ ...q, version: 'v6' })), respec(bankWithSilent[5], 'v6-p009')];
  const byTextPlan = gapPlan(bankV6, gapBase, { extraArticles: [silentArticle.article], bankVersion: 'v6' });
  const byTextAction = byTextPlan.actions.find((a) => a.id === silentArticle.article.id);
  check(
    '판이 바뀐 주: 문장으로 찾은 실증의 새 id · 고정 문장',
    byTextAction?.extra?.how === 'by-text' && sameJson(byTextAction.extra.probes, [{ questionId: 'v6-p009', text: 'v5-p003 질문' }]),
    JSON.stringify({ how: byTextAction?.extra?.how, probes: byTextAction?.extra?.probes }),
  );
}

// 여기부터는 앱 데이터 폴더의 파일도 읽는다 — 위 import는 경로를 정하지 않으므로 이제 임시 폴더로 정하고 모듈을 불러온다.
const dir = mkdtempSync(path.join(tmpdir(), 'verify-probe-questions-'));
process.env.APP_DATA_DIR = dir;
process.env.BLOB_READ_WRITE_TOKEN = '';
process.env.BLOB_STORE_ID = '';
const writeJson = (rel: string, value: unknown) => {
  const file = path.join(dir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
};
try {
  const { PIPELINE_DATA_DIR } = await import('../server/appPaths');
  check('준비: 앱 데이터 경로가 임시 폴더', PIPELINE_DATA_DIR.startsWith(dir), PIPELINE_DATA_DIR);
  const { getRunHistory } = await import('../server/runHistory');
  const { buildPortfolio } = await import('../server/portfolio');
  const { getCitationBreakdown, getCitationSourceAnalysis, getEeatAnalysis, getRankingView } = await import('../server/queries');

  const weekCard = {
    tenantId: 'probe-test',
    weekOf: '2026-W44',
    industry: '테스트업종',
    region: '가상시',
    brandName: '가상 숙소',
    aeoScore: { current: 30, ma4: 30, previousWeek: null, ciLow: 0, ciHigh: 0 },
    mentionRate: after.mentionRate,
    shareOfMention: null,
    avgRecommendationRank: null,
    factualityScore: null,
    brandOwnedCitationRate: after.brandOwnedCitationRate,
    cohortRank: { position: 1, totalTenants: 2 },
    hallucinationFlags: [],
    enginesUsed: ['gemini', 'openai'],
    judgeEngine: 'gemini',
    judgeModel: 'g-1',
    questionBankVersion: VERSION,
    repeatsPerQuestion: 2,
  } as unknown as WeeklyScorecard;
  const bankFile = (questions: QuestionSpec[]) => ({ version: VERSION, generatedAt: '2026-10-01T00:00:00Z', questions });
  // 그 주 카드 하나 · 그 판 은행 하나만 있는 가짜 저장소. bank가 null이면 은행을 못 찾는 주차다.
  const weekStore = (bank: QuestionSpec[] | null, analyses: QuestionRepeatAnalysis[]) =>
    ({
      getScorecardHistory: async () => [weekCard],
      getQuestionAnalyses: async () => analyses,
      getQuestionBank: async (_tenantId: string, version: string) => (bank && version === VERSION ? bankFile(bank) : null),
      getCohortScorecards: async () => [weekCard],
      listRunSnapshots: async () => ({ runs: [], issues: [] }),
    }) as unknown as ResultStore;
  const beforeStore = weekStore(bankBefore, base);
  const afterStore = weekStore(bankAfter, afterMixed);

  // ── 6. 회차 보기 ───────────────────────────────────────────────────────────
  const runOf = async (store: ResultStore) => (await getRunHistory(store, { tenantId: 'probe-test', questionBankVersion: VERSION }, [])).points[0];
  const runBefore = await runOf(beforeStore);
  const runAfter = await runOf(afterStore);
  check('runHistory: 이름 없는 질문 수 N이 덧붙이기 전과 같음', runAfter?.agnosticQuestions === 2 && runBefore?.agnosticQuestions === 2, `${runBefore?.agnosticQuestions} → ${runAfter?.agnosticQuestions}`);
  check(
    'runHistory: k/N · 다시 센 점수가 덧붙이기 전과 같음',
    runAfter !== undefined && JSON.stringify(runAfter.ranked) === JSON.stringify(runBefore?.ranked) && runAfter.score === runBefore?.score && runAfter.ranked?.n === 4,
    `${JSON.stringify(runBefore?.ranked)} / ${JSON.stringify(runAfter?.ranked)}`,
  );

  // ── 7. 브랜드 현황(질문지 비교) ──────────────────────────────────────────────
  // 고객은 실증을 덧붙인 은행, 같은 코호트 경쟁사는 실증 없는 같은 일반 질문. 실증을 세면 「질문지 다름」으로 뒤집힌다.
  const rivalCard = { ...weekCard, tenantId: 'probe-rival', brandName: '가상 경쟁' } as WeeklyScorecard;
  const portfolioStore = (customerBank: QuestionSpec[]) =>
    ({
      scorecardIndex: async () => ({
        historyOf: (tenantId: string) => (tenantId === 'probe-test' ? [weekCard] : tenantId === 'probe-rival' ? [rivalCard] : []),
        cohort: () => [weekCard, rivalCard],
      }),
      getQuestionBank: async (tenantId: string, version: string) => (version === VERSION ? bankFile(tenantId === 'probe-test' ? customerBank : bankBefore) : null),
    }) as unknown as ResultStore;
  const customer = {
    tenantId: 'probe-test',
    brandName: '가상 숙소',
    aliases: [],
    ownedDomains: ['own.example'],
    industry: '테스트업종',
    region: '가상시',
    engines: ['gemini', 'openai'],
    questionBankSize: 3,
    questionBankVersion: VERSION,
    repeatsPerQuestion: 2,
    factGraph: [],
    competitors: [],
  } as unknown as TenantConfig;
  const NOW = new Date('2026-10-28T03:00:00Z'); // 2026-W44
  const pfRow = async (bank: QuestionSpec[]) => (await buildPortfolio([customer], portfolioStore(bank), NOW)).rows[0];
  const pfAfter = await pfRow(bankAfter);
  check('portfolio: 실증을 덧붙여도 「질문지 다름」이 아님', pfAfter?.status === 'done', String(pfAfter?.status));
  const pfNaive = await pfRow(unflagged);
  check('대조: probe 표시가 없으면 「질문지 다름」(검사가 헛돌지 않음)', pfNaive?.status === 'diff', String(pfNaive?.status));

  // ── 8. 인용 분해 · 인용 출처 · EEAT · 이름 넣은/없는 질문 언급률 ──────────────────
  const breakdownBefore = await getCitationBreakdown(beforeStore, 'probe-test', '2026-W44');
  const breakdownAfter = await getCitationBreakdown(afterStore, 'probe-test', '2026-W44');
  check(
    '인용 분해: 자사 인용률 = 카드(실증 인용 뺌)',
    breakdownAfter.brandOwnedCitationRate === after.brandOwnedCitationRate && breakdownAfter.totalCitations === 4,
    `${breakdownAfter.brandOwnedCitationRate} · ${breakdownAfter.totalCitations}건`,
  );
  check('인용 분해: 덧붙이기 전과 같은 표', JSON.stringify(breakdownAfter) === JSON.stringify(breakdownBefore));
  const breakdownNoBank = await getCitationBreakdown(weekStore(null, afterMixed), 'probe-test', '2026-W44');
  check('인용 분해: 은행을 못 찾으면 지금처럼 전체를 셈', breakdownNoBank.totalCitations === 8, `${breakdownNoBank.totalCitations}건`);

  const sourcesOf = (store: ResultStore, questions?: 'unnamed' | 'named' | 'probe') =>
    getCitationSourceAnalysis(store, 'probe-test', '2026-W44', questions ? { questions } : {});
  check('인용 출처 기본 보기: 덧붙이기 전과 같음(실증 응답 뺌)', JSON.stringify(await sourcesOf(afterStore)) === JSON.stringify(await sourcesOf(beforeStore)));
  check(
    '인용 출처 이름 없는 질문: 덧붙이기 전과 같음(실증 응답 뺌)',
    JSON.stringify(await sourcesOf(afterStore, 'unnamed')) === JSON.stringify(await sourcesOf(beforeStore, 'unnamed')),
  );
  check(
    '인용 출처 이름 넣은 질문: 덧붙이기 전과 같음',
    JSON.stringify(await sourcesOf(afterStore, 'named')) === JSON.stringify(await sourcesOf(beforeStore, 'named')),
  );
  const probeSources = await sourcesOf(afterStore, 'probe');
  check(
    "인용 출처 'probe' 범위: 실증 응답 3건 · 인용 4건만",
    probeSources.questionScope?.scope === 'probe' && probeSources.questionScope.responses === 3 && probeSources.questionScope.unknown === 0 && probeSources.totalCitations === 4,
    JSON.stringify({ scope: probeSources.questionScope, total: probeSources.totalCitations }),
  );
  check(
    "인용 출처 'probe' 범위: 실증 없는 은행이면 빈 집계",
    (await sourcesOf(beforeStore, 'probe')).questionScope?.responses === 0,
  );
  check(
    'EEAT: 덧붙이기 전과 같음(실증 응답 뺌)',
    JSON.stringify(await getEeatAnalysis(afterStore, 'probe-test', '2026-W44')) === JSON.stringify(await getEeatAnalysis(beforeStore, 'probe-test', '2026-W44')),
  );
  const rankingTenant = { tenantId: 'probe-test', brandName: '가상 숙소', industry: '테스트업종', region: '가상시', questionBankVersion: VERSION };
  const splitBefore = (await getRankingView(beforeStore, rankingTenant, '2026-W44')).promptedSplit;
  const splitAfter = (await getRankingView(afterStore, rankingTenant, '2026-W44')).promptedSplit;
  check(
    '이름 넣은/없는 질문 언급률: 실증 응답을 어느 쪽에도 세지 않음',
    JSON.stringify(splitAfter) === JSON.stringify(splitBefore) && splitAfter?.unnamed.answered === 4,
    JSON.stringify(splitAfter),
  );

  // ── 8-1. 올린 글 인용 이력 ─────────────────────────────────────────────────────
  // 실증 응답의 인용은 이름 없는 질문에 넣지 않고 probe 칸에 센다 — 처치 글이 실증 답에 인용됐는지가 실험 결과라 보이되, 이름 없는
  // 질문의 숫자 · 분모는 덧붙이기 전 주와 같아야 주간 비교가 이어진다. 모든 가짜 인용은 own.example/page다(원래 응답 1건 · 실증 3건).
  const { foldCell, sampleView } = await import('../server/publishedHistory');
  const { indexWeekCitations, questionKinds } = await import('../src/lib/publishedUrl');
  const { default: PublishedHistoryTable } = await import('../src/components/PublishedHistoryTable');
  const kindsAfter = questionKinds(bankAfter);
  check(
    '질문 종류: 실증은 probe · 이름 없는/이름 넣은 질문은 그대로',
    kindsAfter.get('v5-p001') === 'probe' && kindsAfter.get('v5-001') === 'unnamed' && kindsAfter.get('v5-003') === 'named',
    JSON.stringify([...kindsAfter]),
  );
  const tallyAfter = indexWeekCitations(afterMixed, kindsAfter).get('own.example/page');
  const tallyBefore = indexWeekCitations(base, questionKinds(bankBefore)).get('own.example/page');
  check(
    '인용 칸: 실증 인용은 probe 칸에만(이름 없는 질문 칸은 덧붙이기 전과 같음)',
    tallyAfter?.probe?.cited === 3 && tallyAfter.all.cited === 4 && JSON.stringify(tallyAfter.unnamed) === JSON.stringify(tallyBefore?.unnamed) && tallyBefore?.probe?.cited === 0,
    JSON.stringify(tallyAfter),
  );
  check('인용 칸: 은행을 못 읽으면 probe도 null(확인 불가)', indexWeekCitations(afterMixed, null).get('own.example/page')?.probe === null);
  const trackedPost = {
    id: 'probe-post',
    url: 'https://own.example/page',
    key: 'own.example/page',
    publishedOn: '2026-10-01',
    publishedOnSource: 'user' as const,
    recordedAt: '2026-10-01T03:00:00Z',
    articleId: 'content:category-agnostic',
    targetActionId: 'content:category-agnostic',
    via: 'own' as const,
  };
  const viewOf = (store: ResultStore, analyses: QuestionRepeatAnalysis[]) =>
    sampleView(store, { tenantId: 'probe-test', questionBankVersion: VERSION }, [trackedPost], { weekOf: '2026-W44', scorecard: weekCard, analyses });
  const viewBefore = await viewOf(beforeStore, base);
  const viewAfter = await viewOf(afterStore, afterMixed);
  check(
    '이력 분모: 실증 응답은 probe로 · 이름 없는/이름 넣은 질문 분모는 덧붙이기 전과 같음',
    sameJson(viewAfter.responses, { all: 8, unnamed: 4, named: 1, probe: 3, unknown: 0 }) && sameJson(viewBefore.responses, { all: 5, unnamed: 4, named: 1, probe: 0, unknown: 0 }),
    JSON.stringify({ before: viewBefore.responses, after: viewAfter.responses }),
  );
  const viewNoBank = await viewOf(weekStore(null, afterMixed), afterMixed);
  check('이력 분모: 은행을 못 찾으면 실증도 null', viewNoBank.responses.probe === null && viewNoBank.responses.unnamed === null, JSON.stringify(viewNoBank.responses));
  const viewNaive = await viewOf(weekStore(unflagged, afterMixed), afterMixed);
  check(
    '대조: probe 표시가 없으면 실증 응답이 이름 없는 질문 분모 · 인용에 듦(검사가 헛돌지 않음)',
    viewNaive.responses.unnamed === 7 && viewNaive.cells[0]?.tally?.unnamed?.cited === 4,
    JSON.stringify({ responses: viewNaive.responses, unnamed: viewNaive.cells[0]?.tally?.unnamed }),
  );
  const folded = foldCell([viewAfter.cells[0]!, viewAfter.cells[0]!], [
    { partialEngines: [], missingEngines: [] },
    { partialEngines: [], missingEngines: [] },
  ]);
  check('회차 합치기: probe 칸도 더함', folded.tally?.probe?.cited === 6 && folded.tally.unnamed?.cited === 2, JSON.stringify(folded.tally));
  const foldedNoBank = foldCell([viewAfter.cells[0]!, viewNoBank.cells[0]!], [
    { partialEngines: [], missingEngines: [] },
    { partialEngines: [], missingEngines: [] },
  ]);
  check('회차 합치기: 한 회차라도 은행을 못 읽었으면 probe는 확인 불가', foldedNoBank.tally?.probe === null, JSON.stringify(foldedNoBank.tally?.probe));
  // 표 — 실증을 측정한 주가 있을 때만 칸에 「실증」과 안내를 붙인다. 실증이 없는 브랜드의 표는 글자 하나 바뀌지 않는다.
  const tableHtml = (view: typeof viewAfter, cells = view.cells) =>
    renderToStaticMarkup(
      React.createElement(PublishedHistoryTable, {
        history: {
          weeks: [{ weekOf: '2026-W44', analysed: true, window: view.window, engines: view.engines, bankVersion: view.bankVersion, responses: view.responses, changes: [] }],
          posts: [{ post: trackedPost, cells }],
        },
      }),
    ).replaceAll('<!-- -->', '');
  check('이력 표: 여러 번 잰 주는 응답 합 아래에 실증 인용', tableHtml(viewAfter, [folded]).includes('응답 합 실증 6'), tableHtml(viewAfter, [folded]));
  const htmlAfter = tableHtml(viewAfter);
  const htmlBefore = tableHtml(viewBefore);
  check('이력 표: 실증을 잰 주가 있으면 칸에 「실증 3」', htmlAfter.includes('이름 없는 1 · 이름 댄 0 · 실증 3') && htmlAfter.includes('「실증」은 점수에 넣지 않는'), htmlAfter);
  check('이력 표: 실증이 없으면 「실증」 글자가 없음', !htmlBefore.includes('실증') && htmlBefore.includes('이름 없는 1 · 이름 댄 0'), htmlBefore);

  // ── 9. 경쟁사 편집의 질문 수 · 크기 ─────────────────────────────────────────
  // 저장소 설정의 고객 브랜드 하나(경쟁사 3곳 이상)에 가짜 질문지를 둔다(verify-competitor-save.ts와 같은 방식).
  const ed = await import('../server/competitorEditor');
  const reg = await import('../server/tenantRegistry');
  const { FileResultStore } = await import('../server/store');
  const fileStore = new FileResultStore();
  const runtime0 = await reg.loadRuntimeTenants();
  const repo = runtime0.find((t) => !t.cohortOnly && t.competitors.length >= 3 && t.autoCohort !== false);
  if (!repo) {
    check('경쟁사 편집: 시험할 고객 브랜드(경쟁사 3곳 이상)가 있어야 함', false);
  } else {
    const id = repo.tenantId;
    const v = repo.questionBankVersion;
    const [c0] = repo.competitors;
    const q = (questionId: string, text: string, category: QuestionSpec['category'], extra: Partial<QuestionSpec> = {}) => ({
      questionId,
      text,
      category,
      industry: repo.industry,
      region: repo.region,
      containsBrandName: category !== 'category-agnostic',
      version: v,
      ...extra,
    });
    writeJson(`data/${id}/question-bank/${v}.json`, {
      version: v,
      generatedAt: '2026-01-01T00:00:00.000Z',
      questions: [
        q('c1-001', '가상 지역 좋은 곳 어디야?', 'category-agnostic', { cohortShared: true }),
        q(`${v}-001`, `${repo.brandName}이랑 ${c0!.name} 중 어디가 더 나아?`, 'comparison'),
        q(`${v}-002`, `${repo.brandName} 가격 알려줘`, 'price-spec'),
        q(`${v}-p001`, '가상 지역 조용한 숙소 추천해줘', 'category-agnostic', { probe: true }),
        q(`${v}-p002`, '가상 지역 아이랑 갈 만한 곳 골라줘', 'category-agnostic', { probe: true }),
      ],
    });
    const s0 = await ed.buildEditorState(repo, runtime0, fileStore);
    check(
      '경쟁사 편집: 브랜드 질문 수에 실증을 세지 않고 따로 냄',
      s0.questionBank.sharedCount === 1 && s0.questionBank.brandCount === 2 && s0.questionBank.probeCount === 2,
      JSON.stringify({ shared: s0.questionBank.sharedCount, brand: s0.questionBank.brandCount, probe: s0.questionBank.probeCount }),
    );
    // 첫 경쟁사를 빼면 그 비교 질문을 넘겨받거나 빼서 새 판을 만든다 — 실증은 그대로 옮기되 크기에는 세지 않는다.
    const fresh = async () => (await reg.loadRuntimeTenants()).find((t) => t.tenantId === id)!;
    const competitors = repo.competitors.slice(1);
    const plan = await ed.planEdit(await fresh(), await reg.loadRuntimeTenants(), fileStore, competitors);
    if (plan.questions.mode !== 'derive') {
      check('경쟁사 편집: 첫 경쟁사를 빼면 질문지를 고쳐 만듦(derive)', false, plan.questions.mode);
    } else {
      const drafts = plan.questions.items
        .filter((i) => i.action === 'rewrite')
        .map((i) => ({ fromId: i.fromId, text: i.swaps.reduce((t, s) => t.replace(s.from.name, s.to!.name), i.source.text) }));
      await ed.saveEdit(id, fileStore, { competitors, questions: { key: plan.questions.key, drafts } });
      const derived = await fileStore.getQuestionBank(id, plan.questions.toVersion);
      const saved = await fresh();
      check(
        '경쟁사 편집: 고쳐 만든 질문지에 실증을 그대로 옮김',
        derived?.questions.filter(isProbe).length === 2 && derived.questions.length === plan.questions.sizeAfter,
        JSON.stringify(derived?.questions.map((x) => x.questionId)),
      );
      check(
        '경쟁사 편집: 저장한 크기(questionBankSize)에 실증을 세지 않음',
        saved.questionBankVersion === plan.questions.toVersion && saved.questionBankSize === plan.questions.sizeAfter - 2,
        `${saved.questionBankVersion} · ${saved.questionBankSize} / 문항 ${plan.questions.sizeAfter}`,
      );
    }
  }

  // ── 10. 코호트 질문지 없는 고객의 고쳐 만들기 ───────────────────────────────────
  // 일반 질문 하한은 실증을 뺀 문항 수로 정한다 — 측정(pipeline.ts)이 실증을 뺀 저장 크기로 하한을 정하니, 여기서 실증까지 세면
  // 측정이 받아들이는 은행을 저장에서 거절한다. 일반 질문을 하한에 딱 맞게(실증 뺀 5문항 중 3개) 둔다. 실증 하나는 나중에 더한
  // 경쟁사(빠질 곳) 이름을 품는다 — 그대로 옮겨져야 한다(5-1).
  const nc = (name: string) => ({ name, aliases: [name], domains: [] as string[] });
  const N = {
    tenantId: 'probe-nocohort',
    brandName: '가상머뭄',
    aliases: ['가상머뭄'],
    ownedDomains: ['fake-nocohort.example'],
    industry: '가상업종',
    region: '가상동',
    engines: ['gemini'],
    repeatsPerQuestion: 1,
    factGraph: [],
    questionBankVersion: 'v5',
    questionBankSize: 5,
    competitors: [nc('가상골목'), nc('가상옥도')],
  };
  writeJson('tenants.overlay.json', [N]);
  const nq = (questionId: string, text: string, category: QuestionSpec['category'], extra: Partial<QuestionSpec> = {}) => ({
    questionId,
    text,
    category,
    industry: N.industry,
    region: N.region,
    containsBrandName: category !== 'category-agnostic',
    version: 'v5',
    ...extra,
  });
  const nBank = [
    nq('v5-001', '가상동 가상업종 추천해줘', 'category-agnostic'),
    nq('v5-002', '가상동에서 가상업종 고를 때 뭘 봐야 해?', 'category-agnostic'),
    nq('v5-003', '가상동 가상업종 가격대는 어때?', 'category-agnostic'),
    nq('v5-004', '가상머뭄이랑 가상골목 중에 어디가 더 나아?', 'comparison'),
    nq('v5-005', '가상머뭄 체크인 몇 시야?', 'brand-direct'),
    nq('v5-p001', '가상동 조용한 가상업종 골라줘', 'category-agnostic', { probe: true, containsBrandName: false }),
    nq('v5-p002', '가상골목 근처 가상업종 추천해줘', 'category-agnostic', { probe: true, containsBrandName: false }),
  ];
  writeJson(`data/${N.tenantId}/question-bank/v5.json`, { version: 'v5', generatedAt: '2026-10-13T00:00:00.000Z', questions: nBank });
  const freshN = async () => (await reg.loadRuntimeTenants()).find((t) => t.tenantId === N.tenantId);
  const tN = await freshN();
  if (!tN || tN.cohortQuestionBank) {
    check('코호트 없는 고객: 준비(오버레이 브랜드 · 코호트 질문지 없음)', false, JSON.stringify(tN?.cohortQuestionBank));
  } else {
    const sN = await ed.buildEditorState(tN, await reg.loadRuntimeTenants(), fileStore);
    const golmok = sN.rows.find((r) => r.name === '가상골목');
    check('경쟁사 편집 서랍: 경쟁사 이름이 든 실증 질문을 그 경쟁사 질문으로 보이지 않음', golmok?.questionIds.join() === 'v5-004', JSON.stringify(golmok?.questionIds));
    const nextList = [nc('가상옥도')];
    const planN = await ed.planEdit(tN, await reg.loadRuntimeTenants(), fileStore, nextList);
    if (planN.questions.mode !== 'derive') {
      check('코호트 없는 고객: 가상골목을 빼면 질문지를 고쳐 만듦(derive)', false, planN.questions.mode);
    } else {
      const pq = planN.questions;
      check('고쳐 만들기 계획: 실증 질문을 넘겨받기 항목에 넣지 않음', pq.items.length === 1 && pq.items[0]?.fromId === 'v5-004', pq.items.map((i) => i.fromId).join(','));
      // 고치기 전 식(실증까지 센 문항 수로 하한)이면 거절됐을 은행인지 — 검사가 헛돌지 않게.
      const scoredAfter = pq.sizeAfter - 2;
      check(
        '대조: 실증까지 센 문항 수로 하한을 정하면 거절될 은행',
        countAgnostic(nBank) === agnosticQuota(scoredAfter) && countAgnostic(nBank) < agnosticQuota(pq.sizeAfter),
        `일반 ${countAgnostic(nBank)} · 하한 ${agnosticQuota(scoredAfter)} / 실증 포함 ${agnosticQuota(pq.sizeAfter)}`,
      );
      const draftsN = pq.items
        .filter((i) => i.action === 'rewrite')
        .map((i) => ({ fromId: i.fromId, text: i.swaps.reduce((t, s) => t.replace(s.from.name, s.to!.name), i.source.text) }));
      let saveError = '';
      try {
        await ed.saveEdit(N.tenantId, fileStore, { competitors: nextList, questions: { key: pq.key, drafts: draftsN } });
      } catch (err) {
        saveError = err instanceof Error ? err.message : String(err);
      }
      check('코호트 없는 고객: 일반 질문이 실증 뺀 하한에 딱 맞으면 저장됨', saveError === '', saveError);
      const derivedN = await fileStore.getQuestionBank(N.tenantId, pq.toVersion);
      const probesN = derivedN?.questions.filter(isProbe) ?? [];
      check(
        '고쳐 만든 질문지: 실증 질문의 id · 문장이 그대로',
        probesN.length === 2 && probesN.every((p) => nBank.some((b) => b.questionId === p.questionId && b.text === p.text)),
        JSON.stringify(probesN.map((p) => [p.questionId, p.text])),
      );
      const savedN = await freshN();
      check('코호트 없는 고객: 저장한 크기에 실증을 세지 않음', savedN?.questionBankSize === pq.sizeAfter - 2, `${savedN?.questionBankSize} / 문항 ${pq.sizeAfter}`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

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
