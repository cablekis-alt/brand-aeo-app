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
 * 맡을 수 있다(처치군). 브랜드 현황 · 경쟁사 편집은 임시 폴더를 APP_DATA_DIR로 쓴다. 실증 질문을 만드는 스크립트
 * (scripts/add-probe-questions.ts)는 규칙(id · 금지 이름 · 중복 · 추천형 하한 · 프롬프트)과, 임시 폴더의 가짜 브랜드에 후보 파일로
 * --write를 돌린 결과(백업 · 덧붙이기만 · 거절할 때 아무것도 안 바뀜)를 본다 — AI는 부르지 않는다.
 *
 *   npx tsx scripts/verify-probe-questions.ts
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ExtraArticleForm from '../src/components/ExtraArticleForm';
import type { WeeklyScorecard } from '../src/prompts/b8-report';
import type { QuestionSpec } from '../src/prompts/types';
import type { WeekTally } from '../src/lib/publishedUrl';
import { isProbe, isScoredAgnostic, probeIdsOf, withoutProbes } from '../src/lib/questionScope';
import { agnosticQuota, buildProbeQuestionPrompt, countAgnostic } from '../src/prompts/b1-question-bank';
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
import {
  DEFAULT_CANDIDATES_DIR,
  bankPathProblem,
  bannedNames,
  filterCandidates,
  findRedirectedCopies,
  holdoutIds,
  limitCandidates,
  looksVirtualized,
  nameIn,
  nextProbeIds,
  paraphrasedIds,
  parseProbeRows,
  planProbeWrite,
  readCandidatesFile,
  recommendQuotaMet,
  redirectCandidates,
  toProbeSpec,
  writeProbeBank,
  writeRedirects,
  type ProbeCandidate,
  type ProbeCandidatesFile,
} from '../server/probeQuestions';
import type { QuestionBank as ServerQuestionBank, ResultStore } from '../server/store';
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

  // ── 8-2. 실행 항목 카드의 올린 글 주소(PublishedUrlEditor) ─────────────────────
  // 실증 답에만 인용된 처치 글 — 카드가 「인용됨」이라 하면서 숫자가 모두 0이면 실험 결과가 어디에도 안 보인다(P7). 실증 인용을
  // 따로 적고 이름 없는 질문 인용처럼 초록으로. 실증 인용이 없는 글은 문구 · 색이 그대로다.
  const { default: PublishedUrlEditor } = await import('../src/components/PublishedUrlEditor');
  const editorHtml = (tally: WeekTally | null | undefined) =>
    renderToStaticMarkup(
      React.createElement(PublishedUrlEditor, {
        hits: [{ post: trackedPost, timing: 'after', tally: tally ?? null, variantCited: 0, daysAfterPublish: 20 }],
        removed: [],
        weekOf: '2026-W44',
        busy: false,
        onRecord: async () => null,
        onRemove: () => undefined,
        onRestore: () => undefined,
        onSetDate: () => undefined,
      }),
    ).replaceAll('<!-- -->', '');
  const probeOnlyTally = indexWeekCitations([probes[0]!], kindsAfter).get('own.example/page');
  const editorProbe = editorHtml(probeOnlyTally);
  check(
    '올린 글 주소: 실증 답에만 인용되면 「실증 1(점수 제외)」 · 초록',
    probeOnlyTally?.unnamed?.cited === 0 && editorProbe.includes('이름 없는 질문 0 · 이름 댄 질문 0 · 실증 1(점수 제외) · 뒷받침') && editorProbe.includes('status-pill st-good'),
    editorProbe,
  );
  const editorNoProbe = editorHtml(tallyBefore);
  check(
    '올린 글 주소: 실증 인용이 없으면 문구 · 색 그대로',
    !editorNoProbe.includes('실증') && editorNoProbe.includes('이름 없는 질문 1 · 이름 댄 질문 0 · 뒷받침') && editorNoProbe.includes('status-pill st-good'),
    editorNoProbe,
  );
  const namedOnlyTally = indexWeekCitations([base[0]!], questionKinds([{ questionId: 'v5-001', containsBrandName: true }])).get('own.example/page');
  const editorNamed = editorHtml(namedOnlyTally);
  check('대조: 이름 댄 질문에만 인용되면 파랑(st-info) — 초록 조건이 헛돌지 않음', editorNamed.includes('status-pill st-info') && !editorNamed.includes('실증'), editorNamed);

  // ── 8-3. 인용 갭의 「실증 질문」 칸 ──────────────────────────────────────────
  // 칸은 고른 주를 측정한 판의 질문지로 가른다 — 모두 새로 쓰기로 실증 없는 v6이 된 뒤에도 v5로 잰 W44에서는 실증 응답의 인용
  // 출처를 볼 수 있어야 하고(서버는 그 주 판으로 돌려준다), 실증 없는 판으로 잰 주에는 칸이 없어야 한다(P7).
  const { questionScopeOptions } = await import('../src/lib/citationView');
  const { resolveBankVersion } = await import('../src/lib/bankVersion');
  const gapHistory = [
    { ...weekCard, weekOf: '2026-W44', questionBankVersion: 'v5' },
    { ...weekCard, weekOf: '2026-W45', questionBankVersion: 'v6' },
  ] as unknown as WeeklyScorecard[];
  const gapBanks = new Map([
    ['v5', { questions: bankAfter }],
    ['v6', { questions: bankBefore }],
  ]);
  const scopeAt = (weekOf: string) => questionScopeOptions(gapBanks.get(resolveBankVersion(gapHistory, weekOf, []) ?? 'v6') ?? null);
  check(
    '인용 갭 칸: 실증을 잰 판의 주에는 「실증 질문」 · 실증 없는 판의 주에는 없음',
    scopeAt('2026-W44').includes('probe') && !scopeAt('2026-W45').includes('probe') && scopeAt('2026-W45').length === QUESTION_SCOPE_OPTIONS.length - 1,
    JSON.stringify({ W44: scopeAt('2026-W44'), W45: scopeAt('2026-W45') }),
  );
  check('인용 갭 칸: 질문지를 못 읽었으면 「실증 질문」 없음', !questionScopeOptions(null).includes('probe'));

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

// ── 11. 실증 질문 만들기 스크립트(scripts/add-probe-questions.ts) ───────────────────
// id — 판 접두를 그대로 둔 `${version}-p001` 꼴. 일반 번호 정규식(add-learn-questions maxIndex · questionHandoff seq)과 추가 글 id
// 구분자('+')에 걸리지 않아야 한다.
const newIds = nextProbeIds({ version: VERSION, questions: bankAfter }, 2);
check('실증 id: 그 판의 가장 큰 p번호 다음부터', sameJson(newIds, ['v5-p003', 'v5-p004']), newIds.join(','));
const firstIds = nextProbeIds({ version: VERSION, questions: [...bankBefore, { questionId: 'v4-p009' }, { questionId: 'v5-010' }, { questionId: 'v5-pxyz' }] }, 1);
check('실증 id: 실증 없는 판은 p001부터 · 다른 판 접두 · 일반 번호는 보지 않음', sameJson(firstIds, ['v5-p001']), firstIds.join(','));
check(
  '실증 id: 일반 번호 정규식 /-(\\d+)$/ · 추가 글 구분자 +에 걸리지 않음',
  [...newIds, ...firstIds].every((id) => !/-(\d+)$/.test(id) && !id.includes('+')),
);

// 금지 이름 — 브랜드 · 별칭 · 경쟁사 · 경쟁사 별칭 · 코호트 순위 이름(같은 코호트 구성원과 그 경쟁사). 다른 코호트는 넣지 않는다.
const fakeTenant = (tenantId: string, brandName: string, region: string, competitors: [string, string[]][], extra: Partial<TenantConfig> = {}) =>
  ({
    tenantId,
    brandName,
    aliases: [],
    ownedDomains: [],
    industry: '가상업종',
    region,
    engines: ['gemini'],
    questionBankSize: 4,
    questionBankVersion: VERSION,
    repeatsPerQuestion: 1,
    factGraph: [],
    competitors: competitors.map(([name, aliases]) => ({ name, aliases, domains: [] })),
    ...extra,
  }) as TenantConfig;
const selfT = fakeTenant('probe-self', '가상 숙소', '가상읍', [['경쟁 하나', ['경쟁1']]], { aliases: ['가상숙소', ' '] });
const neighbourT = fakeTenant('probe-neighbour', '가상 이웃', '가상읍', [['먼 경쟁', []]]);
const elsewhereT = fakeTenant('probe-elsewhere', '다른 지역 숙소', '다른읍', [['다른 경쟁', []]]);
const banned = bannedNames(selfT, [selfT, neighbourT, elsewhereT]);
check(
  '금지 이름: 브랜드 · 별칭 · 경쟁사 · 경쟁사 별칭 · 코호트 구성원과 그 경쟁사',
  ['가상 숙소', '가상숙소', '경쟁 하나', '경쟁1', '가상 이웃', '먼 경쟁'].every((n) => banned.includes(n)),
  banned.join(','),
);
check(
  '금지 이름: 다른 코호트 · 빈 이름 · 중복이 없음',
  !banned.includes('다른 지역 숙소') && !banned.includes('다른 경쟁') && banned.every((n) => n.trim() === n && n.length > 0) && new Set(banned).size === banned.length,
  banned.join(','),
);
check('이름 찾기: 띄어쓰기만 다른 이름도 찾음', nameIn('가상숙 소 근처 조용한 곳', ['가상 숙소']) === '가상 숙소' && nameIn('가상읍 조용한 곳', ['가상 숙소']) === null);

// 후보 거르기 — 이름 · 질문지 · 코호트 공통 질문지 · 후보끼리 중복(띄어쓰기만 다른 것 포함) · 실증 아닌 원래 질문 · 이미 바꿔 쓴 실증.
const cand = (text: string, extra: Partial<ProbeCandidate> = {}): ProbeCandidate => ({ text, stage: 'consider', kind: 'recommend', ...extra });
const filterCtx = {
  banned,
  existingTexts: bankAfter.map((q) => q.text),
  cohortTexts: ['가상읍 조용한 곳 알려줘'],
  probeIds: probeIdsOf(bankAfter),
  paraphrased: new Set(['v5-p002']),
};
const filtered = filterCandidates(
  [
    cand('가상읍 아이랑 묵기 좋은 곳 추천해줘'),
    cand('가상 숙소 말고 다른 곳 추천해줘'),
    cand('경쟁1 같은 곳 있어?'),
    cand('v5-001  질문'),
    cand('가상읍 조용한곳 알려줘'),
    cand('가상읍 아이랑 묵기 좋은 곳  추천해줘'),
    cand('가상읍 바다 보이는 곳 골라줘', { paraphraseOf: 'v5-001', kind: undefined }),
    cand('가상읍 애들이랑 갈 곳 골라줘', { paraphraseOf: 'v5-p002', kind: undefined }),
    cand('가상읍에서 애들 데리고 묵을 데 어디가 좋아?', { paraphraseOf: 'v5-p001', kind: undefined }),
  ],
  filterCtx,
);
check(
  '후보 거르기: 남은 후보(순서 그대로)',
  sameJson(filtered.accepted.map((c) => c.text), ['가상읍 아이랑 묵기 좋은 곳 추천해줘', '가상읍에서 애들 데리고 묵을 데 어디가 좋아?']),
  JSON.stringify(filtered.accepted.map((c) => c.text)),
);
check(
  '후보 거르기: 이유',
  sameJson(filtered.rejected.map((r) => r.reason), [
    '이름 포함: 가상 숙소',
    '이름 포함: 경쟁1',
    '질문지에 같은 문장이 있음',
    '코호트 공통 질문지에 같은 문장이 있음',
    '후보끼리 같은 문장',
    '질문지의 실증 질문이 아닌 것을 바꿔 씀: v5-001',
    '이미 바꿔 쓴 실증이 있는 질문: v5-p002',
  ]),
  JSON.stringify(filtered.rejected.map((r) => r.reason)),
);
check(
  '이미 바꿔 쓴 실증: 질문지의 paraphraseOf에서 읽음',
  sameJson([...paraphrasedIds([...bankAfter, { ...spec('v5-p003', 'category-agnostic', true), paraphraseOf: 'v5-p001' }])], ['v5-p001']),
);

// 홀드아웃 규칙 — 원래 질문 하나에 홀드아웃 하나. 후보 파일 둘을 합쳐 같은 원래 질문이 두 번 들어와도, 홀드아웃(p003)을 원래
// 질문으로 고른 후보도 거른다. 질문지에 이미 있는 홀드아웃만 보던 때는 둘 다 통과했다.
const bankHoldout: QuestionSpec[] = [...bankAfter, { ...spec('v5-p003', 'category-agnostic', true), paraphraseOf: 'v5-p001' }];
check('홀드아웃 id: paraphraseOf가 있는 실증만', sameJson([...holdoutIds(bankHoldout)], ['v5-p003']));
const holdoutFiltered = filterCandidates(
  [
    cand('가상읍 애들이랑 묵을 곳 골라줘', { paraphraseOf: 'v5-p002', kind: undefined }),
    cand('가상읍 아이 데리고 지낼 숙소 어디가 좋아?', { paraphraseOf: 'v5-p002', kind: undefined }),
    cand('가상읍 바다 쪽 숙소 하나 골라줘', { paraphraseOf: 'v5-p003', kind: undefined }),
  ],
  {
    banned,
    existingTexts: bankHoldout.map((q) => q.text),
    cohortTexts: [],
    probeIds: probeIdsOf(bankHoldout),
    paraphrased: paraphrasedIds(bankHoldout),
    holdouts: holdoutIds(bankHoldout),
  },
);
check(
  '후보 거르기: 같은 원래 질문 두 번 · 홀드아웃을 다시 바꿔 쓴 후보는 거름',
  sameJson(holdoutFiltered.accepted.map((c) => c.text), ['가상읍 애들이랑 묵을 곳 골라줘']) &&
    sameJson(holdoutFiltered.rejected.map((r) => r.reason), ['같은 원래 질문(v5-p002)을 두 번 바꿔 씀', '홀드아웃을 다시 바꿔 씀: v5-p003']),
  JSON.stringify(holdoutFiltered),
);
const paraPlan = (candidates: ProbeCandidate[]) =>
  planProbeWrite({
    file: {
      format: 'probe-candidates/1',
      tenantId: 'probe-self',
      bankVersion: VERSION,
      bankPath: 'fake',
      bankQuestionCount: bankHoldout.length,
      mode: 'paraphrase',
      generatedAt: '2026-11-02T00:00:00.000Z',
      judgeEngine: 'mock',
      recommendMin: 0,
      candidates,
      rejected: [],
    },
    tenantId: 'probe-self',
    version: VERSION,
    bank: { version: VERSION, questions: bankHoldout },
    industry: '가상업종',
    region: '가상읍',
    banned,
    cohortTexts: [],
  });
const paraErrors = (p: ReturnType<typeof paraPlan>) => (p.ok ? '' : p.errors.join(' | '));
const dupPlan = paraPlan([
  cand('A 가상읍 묵을 곳', { paraphraseOf: 'v5-p002', kind: undefined }),
  cand('B 가상읍 지낼 곳', { paraphraseOf: 'v5-p002', kind: undefined }),
]);
const chainPlan = paraPlan([cand('가상읍 바다 쪽 숙소 하나 골라줘', { paraphraseOf: 'v5-p003', kind: undefined })]);
check(
  '쓰기 계획(--write): 같은 원래 질문 두 번 · 홀드아웃의 홀드아웃이면 하나도 쓰지 않음',
  !dupPlan.ok && paraErrors(dupPlan).includes('같은 원래 질문(v5-p002)을 두 번 바꿔 씀') && !chainPlan.ok && paraErrors(chainPlan).includes('홀드아웃을 다시 바꿔 씀: v5-p003'),
  `${paraErrors(dupPlan)} / ${paraErrors(chainPlan)}`,
);
const onePlan = paraPlan([cand('가상읍 묵을 곳 하나 골라줘', { paraphraseOf: 'v5-p002', kind: undefined })]);
check(
  '쓰기 계획(--write): 원래 질문 하나에 홀드아웃 하나는 그대로 씀',
  onePlan.ok && sameJson(onePlan.added.map((q) => [q.questionId, q.paraphraseOf]), [['v5-p004', 'v5-p002']]),
  paraErrors(onePlan),
);

// 추천형 하한 — kind recommend이고 단계가 비교(consider)일 때만 센다.
const quotaSet = [cand('a'), cand('b', { stage: 'learn' }), cand('c', { kind: 'info' })];
check('추천형 하한: consider · recommend만 셈', recommendQuotaMet(quotaSet, 1) && !recommendQuotaMet(quotaSet, 2));

// 개수 맞추기 — 엔진이 개수를 넘겨 냈을 때 앞에서부터 자르면 뒤쪽 추천형이 잘려 하한이 거짓으로 미달이 된다. 정보형 9개 뒤에
// 추천형 11개가 오면, 16개로 줄여도 추천형 10개를 채울 수 있어야 한다(앞에서 자르면 추천형 7개).
const overflow = [
  ...Array.from({ length: 9 }, (_, i) => cand(`정보 ${i}`, { stage: 'learn', kind: 'info' })),
  ...Array.from({ length: 11 }, (_, i) => cand(`추천 ${i}`)),
];
const limited = limitCandidates(overflow, 16, 10);
check(
  '개수 맞추기: 추천형을 하한만큼 먼저 남기고 나머지를 원래 순서로 채움',
  limited.kept.length === 16 &&
    limited.kept.filter((c) => c.kind === 'recommend').length === 10 &&
    recommendQuotaMet(limited.kept, 10) &&
    !recommendQuotaMet(overflow.slice(0, 16), 10) &&
    sameJson(limited.kept.map((c) => c.text), [...overflow.slice(0, 6), ...overflow.slice(9, 19)].map((c) => c.text)) &&
    sameJson(limited.dropped.map((c) => c.text), ['정보 6', '정보 7', '정보 8', '추천 10']),
  JSON.stringify(limited.dropped.map((c) => c.text)),
);
check(
  '개수 맞추기: 하한 0(바꿔 쓰기) · 넘치지 않으면 앞에서부터 그대로',
  sameJson(limitCandidates(overflow, 5, 0).kept, overflow.slice(0, 5)) && sameJson(limitCandidates(overflow, 30, 10).kept, overflow),
);

// 문항으로 — 실증 표시 · 이름 없는 질문 · 코호트 공통 아님. 점수 모집단에 들지 않는다.
const probeSpec = toProbeSpec(filtered.accepted[1]!, 'v5-p003', { industry: '가상업종', region: '가상읍', version: VERSION });
check(
  '문항으로: probe · category-agnostic · containsBrandName false · cohortShared 없음 · paraphraseOf',
  probeSpec.probe === true &&
    probeSpec.category === 'category-agnostic' &&
    probeSpec.containsBrandName === false &&
    !('cohortShared' in probeSpec) &&
    probeSpec.paraphraseOf === 'v5-p001' &&
    probeSpec.version === VERSION &&
    probeSpec.stage === 'consider',
  JSON.stringify(probeSpec),
);
check(
  '문항으로: 실증으로 보이고 점수 모집단(일반 질문 하한)에 들지 않음',
  isProbe(probeSpec) && !isScoredAgnostic(probeSpec) && countAgnostic([...bankBefore, probeSpec]) === countAgnostic(bankBefore),
);
check('문항으로: 새 후보에는 paraphraseOf 없음', !('paraphraseOf' in toProbeSpec(filtered.accepted[0]!, 'v5-p004', { industry: '가상업종', region: '가상읍', version: VERSION })));

// 판정 엔진 응답 읽기 — 형식이 틀린 줄은 이유와 함께 거르고, 바꿔 쓰기는 단계 · 주제를 원래 질문에서 옮긴다.
const parsedNew = parseProbeRows([
  { text: ' 가상읍 숙소 추천해줘 ', stage: 'consider', topic: ' 숙소 고르기 ', kind: 'recommend' },
  { text: '', stage: 'learn', kind: 'info' },
  { text: '단계가 틀린 질문', stage: 'buy', kind: 'info' },
  { text: '종류가 틀린 질문', stage: 'learn', kind: 'other' },
  '문자열 줄',
]);
check(
  '응답 읽기: 맞는 줄만 후보(앞뒤 공백 정리) · 나머지는 형식 오류',
  sameJson(parsedNew.candidates, [{ text: '가상읍 숙소 추천해줘', stage: 'consider', topic: '숙소 고르기', kind: 'recommend' }]) &&
    parsedNew.rejected.length === 4 &&
    parsedNew.rejected.every((r) => r.reason.startsWith('형식 오류')),
  JSON.stringify(parsedNew),
);
check('응답 읽기: 배열이 아니면 하나의 형식 오류', parseProbeRows({ text: 'x' }).rejected.length === 1 && parseProbeRows(null).candidates.length === 0);
const sourceP001 = { ...spec('v5-p001', 'category-agnostic', true), stage: 'consider' as const, topic: '아이 동반' };
const parsedPara = parseProbeRows(
  [
    { paraphraseOf: 'v5-p001', text: '가상읍에서 애들 데리고 묵을 데 어디가 좋아?' },
    { paraphraseOf: 'v5-p001', text: '두 번째 바꿔 쓰기' },
    { paraphraseOf: 'v5-p009', text: '목록에 없는 원래 질문' },
  ],
  [sourceP001],
);
check(
  '응답 읽기(바꿔 쓰기): 단계 · 주제를 원래 질문에서 옮기고 원래 질문 하나에 하나만',
  sameJson(parsedPara.candidates, [{ text: '가상읍에서 애들 데리고 묵을 데 어디가 좋아?', stage: 'consider', topic: '아이 동반', paraphraseOf: 'v5-p001' }]) &&
    parsedPara.rejected.length === 2,
  JSON.stringify(parsedPara),
);

// 프롬프트 — 시장 범위 안내(scopeGuide) · 금지 이름 · 기존 문장 · 개수 · 추천형 하한 · 출력 키(text · stage · topic · kind). id는 코드가 매긴다.
const promptText = (p: { system: string; user: string }) => `${p.system}\n${p.user}`;
const probePromptReq = { industry: '가상업종', region: '가상읍', bannedNames: ['가상 숙소', '경쟁 하나'], existingTexts: ['기존 질문 하나'], count: 16, recommendMin: 10 };
const pLocal = promptText(buildProbeQuestionPrompt(probePromptReq));
check(
  '실증 프롬프트: 금지 이름 · 기존 문장 · 개수 · 추천형 하한 · 지역형 추천 예시',
  ['가상 숙소, 경쟁 하나', '- 기존 질문 하나', '정확히 16개', '최소 10개', '"가상읍 가상업종 추천해줘"'].every((s) => pLocal.includes(s)),
  pLocal,
);
check(
  '실증 프롬프트: 출력은 text · stage · topic · kind뿐(id · 카테고리는 코드가)',
  pLocal.includes('"kind": "recommend" | "info"') && !pLocal.includes('questionId') && !pLocal.includes('"category"') && !pLocal.includes('시장 범위:'),
);
const pNational = promptText(buildProbeQuestionPrompt({ ...probePromptReq, region: '국내', marketScope: 'national' }));
check('실증 프롬프트: 전국형은 시장 범위 · 지역 금지 규칙', pNational.includes('시장 범위: 전국형') && pNational.includes('특정 시 · 구 같은 지역을 질문에 넣지 마라'));
const pPara = promptText(buildProbeQuestionPrompt({ ...probePromptReq, paraphrase: [{ questionId: 'v5-p001', text: 'v5-p001 질문' }] }));
check(
  '실증 프롬프트(바꿔 쓰기): 원래 질문 · 금지 이름 · paraphraseOf 출력 · 하나에 하나',
  ['- v5-p001: v5-p001 질문', '가상 숙소, 경쟁 하나', '"paraphraseOf": string', '정확히 하나씩, 모두 1개', '의도를 바꾸지 마라'].every((s) => pPara.includes(s)) &&
    !pPara.includes('"kind"'),
  pPara,
);

// 경로 — 그 브랜드의 question-bank 폴더 안만. 코호트 공통 질문지 · 이 셸의 가상화 사본은 안 된다.
const fakeRoot = path.join(tmpdir(), 'probe-path-check');
const fakeData = path.join(fakeRoot, 'data');
check('경로: 브랜드 질문지는 통과', bankPathProblem(path.join(fakeData, 'probe-self', 'question-bank', 'v5.json'), fakeData, 'probe-self') === null);
check(
  '경로: 코호트 공통 질문지 · 다른 브랜드 폴더는 거절',
  (bankPathProblem(path.join(fakeRoot, 'cohort-banks', 'k', 'c1.json'), fakeData, 'probe-self') ?? '').includes('cohort-banks') &&
    bankPathProblem(path.join(fakeData, 'probe-other', 'question-bank', 'v5.json'), fakeData, 'probe-self') !== null,
);
check(
  '경로: 가상화 사본(Packages\\Claude_…)만 걸림',
  looksVirtualized('C:\\Users\\fake\\AppData\\Local\\Packages\\Claude_abc123\\LocalCache\\Roaming\\brand-aeo-app') &&
    !looksVirtualized('//localhost/C$/Users/fake/AppData/Roaming/brand-aeo-app') &&
    !looksVirtualized('C:\\Users\\fake\\AppData\\Roaming\\brand-aeo-app'),
);

// 쓰기 리다이렉트 — Claude 셸에서는 평범한 %APPDATA% 경로도 읽기는 실제 폴더를 통과하고 쓰기만 파일 단위로 LocalCache에 간다.
// 경로 글자로는 안 보이므로 써 보고 확인한다. 가짜 %APPDATA% · %LOCALAPPDATA%(Packages\Claude_fake 있음)에서, 옮겨 가는 쓰기는
// 검사용 io로 흉내 낸다.
const rdir = mkdtempSync(path.join(tmpdir(), 'verify-probe-redirect-'));
try {
  const roots = { appData: path.join(rdir, 'Roaming'), localAppData: path.join(rdir, 'Local') };
  const pkg = path.join(roots.localAppData, 'Packages', 'Claude_fake');
  mkdirSync(path.join(pkg, 'LocalCache'), { recursive: true });
  mkdirSync(path.join(roots.localAppData, 'Packages', 'Other_app'), { recursive: true });
  const qdir = path.join(roots.appData, 'brand-aeo-app', 'data', 'probe-self', 'question-bank');
  mkdirSync(qdir, { recursive: true });
  const mirrorOf = (p: string) => path.join(pkg, 'LocalCache', 'Roaming', path.relative(roots.appData, p));
  check(
    '쓰기 리다이렉트 위치: %APPDATA% 아래만 LocalCache\\Roaming으로 · UNC · 다른 폴더 · 가상화 경로 자체는 없음',
    sameJson(redirectCandidates(path.join(qdir, 'v5.json'), roots, [pkg]), [mirrorOf(path.join(qdir, 'v5.json'))]) &&
      sameJson(redirectCandidates(path.join(roots.localAppData, 'x', 'y.json'), roots, [pkg]), [path.join(pkg, 'LocalCache', 'Local', 'x', 'y.json')]) &&
      redirectCandidates('//localhost/C$/Users/fake/AppData/Roaming/brand-aeo-app/x.json', roots, [pkg]).length === 0 &&
      redirectCandidates(path.join(rdir, 'elsewhere', 'x.json'), roots, [pkg]).length === 0 &&
      redirectCandidates(path.join(pkg, 'LocalCache', 'Roaming', 'x.json'), roots, [pkg]).length === 0,
  );
  const leftovers = () =>
    [qdir, mirrorOf(qdir)].filter((d) => existsSync(d)).flatMap((d) => readdirSync(d).filter((n) => n.startsWith('.probe-write-check-')));
  const landed = await writeRedirects(qdir, roots);
  check('쓰기 확인: 제자리에 가면 빈 목록 · 표지 파일은 지움', landed.length === 0 && leftovers().length === 0, JSON.stringify(landed));
  const moved = await writeRedirects(qdir, roots, {
    write: async (file) => {
      mkdirSync(path.dirname(mirrorOf(file)), { recursive: true });
      writeFileSync(mirrorOf(file), '');
    },
    remove: async (file) => rmSync(mirrorOf(file)),
  });
  check(
    '쓰기 확인: 경로 글자가 평범해도 쓰기가 LocalCache로 가면 그 위치를 돌려줌 · 표지 파일은 지움',
    moved.length === 1 && moved[0]!.startsWith(path.join(pkg, 'LocalCache', 'Roaming')) && path.basename(moved[0]!).startsWith('.probe-write-check-') && leftovers().length === 0,
    JSON.stringify(moved),
  );
  const backupLike = path.join(roots.appData, 'brand-aeo-app', 'data', 'probe-self', 'before-probe-2026-11-02T00-00-00-000Z');
  const before = await findRedirectedCopies(backupLike, roots);
  mkdirSync(mirrorOf(backupLike), { recursive: true });
  const after = await findRedirectedCopies(backupLike, roots);
  check('쓴 뒤 확인: 백업 폴더가 LocalCache에 생겼으면 찾음', before.length === 0 && sameJson(after, [mirrorOf(backupLike)]), JSON.stringify(after));
  check('쓴 뒤 확인: Claude 패키지 폴더가 없으면 빈 목록', (await findRedirectedCopies(backupLike, { ...roots, localAppData: path.join(rdir, 'none') })).length === 0);
} finally {
  rmSync(rdir, { recursive: true, force: true });
}

// 후보 파일 기본 위치 — 저장소 루트에서 --out 없이 돌려도 고객 브랜드 문장 · 절대 경로가 커밋에 섞이지 않는다(.gitignore *.local).
const ignored = spawnSync('git', ['check-ignore', '-q', `${DEFAULT_CANDIDATES_DIR}/probe-candidates-probe-self-v5-2026-11-02T00-00-00-000Z.json`], { encoding: 'utf8' });
check('후보 파일 기본 위치: git이 무시하는 폴더', ignored.status === 0 && DEFAULT_CANDIDATES_DIR.endsWith('.local'), `${ignored.status} ${ignored.stderr}`);

// 후보 파일 · 쓰기 계획 — 후보를 만든 뒤 질문지가 바뀌었거나 다른 브랜드 · 판이면 쓰지 않는다. 기존 문항은 같은 객체 그대로 둔다.
const candidatesFile = (over: Partial<ProbeCandidatesFile> = {}): ProbeCandidatesFile => ({
  format: 'probe-candidates/1',
  tenantId: 'probe-self',
  bankVersion: VERSION,
  bankPath: 'fake',
  bankQuestionCount: bankAfter.length,
  mode: 'new',
  generatedAt: '2026-11-02T00:00:00.000Z',
  judgeEngine: 'mock',
  recommendMin: 1,
  candidates: [cand('가상읍 아이랑 묵기 좋은 곳 추천해줘'), cand('가상읍 숙소 체크인 보통 몇 시야?', { stage: 'decide', kind: 'info', topic: '예약' })],
  rejected: [],
  ...over,
});
const planOf = (file: ProbeCandidatesFile, expectCount?: number) =>
  planProbeWrite({
    file,
    tenantId: 'probe-self',
    version: VERSION,
    bank: { version: VERSION, questions: bankAfter },
    industry: '가상업종',
    region: '가상읍',
    banned,
    cohortTexts: filterCtx.cohortTexts,
    expectCount,
  });
const goodPlan = planOf(candidatesFile(), bankAfter.length);
check(
  '쓰기 계획: 뒤에 덧붙이기만(기존 문항은 같은 객체) · 다음 실증 id',
  goodPlan.ok &&
    goodPlan.questions.length === bankAfter.length + 2 &&
    bankAfter.every((q, i) => goodPlan.questions[i] === q) &&
    sameJson(goodPlan.added.map((q) => q.questionId), ['v5-p003', 'v5-p004']) &&
    goodPlan.added.every((q) => isProbe(q) && q.category === 'category-agnostic' && !q.containsBrandName),
  JSON.stringify(goodPlan),
);
const planErrors = (p: ReturnType<typeof planOf>) => (p.ok ? '' : p.errors.join(' | '));
check('쓰기 계획: 문항 수가 후보를 만들 때와 다르면 멈춤', planErrors(planOf(candidatesFile({ bankQuestionCount: 3 }))).includes('지금 문항 수(5)가 후보를 만들 때(3)와 다릅니다'));
check('쓰기 계획: --expect-count와 다르면 멈춤', planErrors(planOf(candidatesFile(), 42)).includes('--expect-count 42'));
check(
  '쓰기 계획: 다른 브랜드 · 다른 판의 후보 파일이면 멈춤',
  planErrors(planOf(candidatesFile({ tenantId: 'probe-other' }))).includes('다른 브랜드') && planErrors(planOf(candidatesFile({ bankVersion: 'v4' }))).includes('판이 바뀌었으면'),
);
check(
  '쓰기 계획: 지금 질문지 기준으로 걸리는 후보가 있으면 하나도 쓰지 않음',
  planErrors(planOf(candidatesFile({ candidates: [cand('가상읍 새 질문'), cand('v5-001 질문')] }))).includes('질문지에 같은 문장이 있음'),
);
check('쓰기 계획: 빈 후보면 멈춤', planErrors(planOf(candidatesFile({ candidates: [] }))).includes('덧붙일 후보가 없습니다'));
check(
  '후보 파일 읽기: 형식 · 모드와 paraphraseOf가 맞아야 함',
  readCandidatesFile(candidatesFile()).ok &&
    !readCandidatesFile({ ...candidatesFile(), format: 'other' }).ok &&
    !readCandidatesFile(candidatesFile({ mode: 'paraphrase' })).ok &&
    !readCandidatesFile(candidatesFile({ candidates: [cand('x', { paraphraseOf: 'v5-p001' })] })).ok &&
    !readCandidatesFile(candidatesFile({ candidates: [{ text: 'x', stage: 'buy' } as unknown as ProbeCandidate] })).ok,
);

// 임시 폴더의 가짜 브랜드 — 코호트 공통 질문지를 쓰는 고객(오버레이 등록). 파일 쓰기(writeProbeBank)를 직접 부르고, 스크립트도
// 하위 프로세스로 --write --from을 돌린다. 하위 프로세스는 앱이 켜져 있으면 쓰기를 거절해야 하므로 그때는 거절만 본다.
const sdir = mkdtempSync(path.join(tmpdir(), 'verify-probe-script-'));
try {
  const { cohortKey } = await import('../server/cohortQuestionBank');
  const S = fakeTenant('probe-script-fake', '가상 별채', '가상읍', [['가상 앞집', []]], {
    aliases: ['가상별채'],
    ownedDomains: ['fake-script.example'],
    cohortQuestionBank: 'c1',
  });
  const key = cohortKey(S.industry, S.region);
  const sq = (questionId: string, text: string, category: QuestionSpec['category'], extra: Partial<QuestionSpec> = {}): QuestionSpec => ({
    questionId,
    text,
    category,
    industry: S.industry,
    region: S.region,
    containsBrandName: category !== 'category-agnostic',
    version: questionId.startsWith('c1') ? 'c1' : VERSION,
    ...extra,
  });
  const cohortQuestions = [sq('c1-001', '가상읍 가상업종 추천해줘', 'category-agnostic'), sq('c1-002', '가상읍 가상업종 고를 때 뭘 봐야 해?', 'category-agnostic')];
  const scriptBank: ServerQuestionBank = {
    version: VERSION,
    generatedAt: '2026-10-13T00:00:00.000Z',
    questions: [
      ...cohortQuestions.map((q) => ({ ...q, cohortShared: true })),
      sq('v5-001', '가상 별채 체크인 몇 시야?', 'brand-direct'),
      sq('v5-002', '가상 별채랑 가상 앞집 중에 어디가 나아?', 'comparison'),
    ],
    cohortBank: { key, version: 'c1' },
  };
  const put = (root: string, rel: string, value: unknown) => {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value, null, 2));
    return file;
  };
  const seed = (root: string) => ({
    overlay: put(root, 'tenants.overlay.json', [S]),
    cohort: put(root, path.join('cohort-banks', key, 'c1.json'), { key, industry: S.industry, region: S.region, version: 'c1', generatedAt: '2026-10-01T00:00:00.000Z', questions: cohortQuestions }),
    bank: put(root, path.join('data', S.tenantId, 'question-bank', `${VERSION}.json`), scriptBank),
  });
  const files = seed(sdir);
  const tenantDirS = path.join(sdir, 'data', S.tenantId);
  const raw = (file: string) => readFileSync(file, 'utf8');
  const original = { bank: raw(files.bank), overlay: raw(files.overlay), cohort: raw(files.cohort) };
  const backups = () => readdirSync(tenantDirS).filter((n) => n.startsWith('before-probe-'));
  const scriptCandidates = (over: Partial<ProbeCandidatesFile> = {}) =>
    candidatesFile({
      tenantId: S.tenantId,
      bankPath: files.bank,
      bankQuestionCount: scriptBank.questions.length,
      candidates: [cand('가상읍 강아지랑 묵을 수 있는 곳 추천해줘'), cand('가상읍 숙소 성수기 요금 보통 얼마야?', { stage: 'learn', kind: 'info', topic: '가격·비용' })],
      ...over,
    });

  // 파일 쓰기 — 백업(질문지 · 오버레이) 뒤 질문지 하나만 고친다. 오버레이 · 코호트 공통 질문지는 그대로다.
  const sPlan = planProbeWrite({
    file: scriptCandidates(),
    tenantId: S.tenantId,
    version: VERSION,
    bank: scriptBank,
    industry: S.industry,
    region: S.region,
    banned: bannedNames(S, [S]),
    cohortTexts: cohortQuestions.map((q) => q.text),
  });
  check('파일 쓰기 준비: 계획이 섬', sPlan.ok, planErrors(sPlan));
  if (sPlan.ok) {
    const written = await writeProbeBank({
      bankPath: files.bank,
      overlayPath: files.overlay,
      tenantDir: tenantDirS,
      before: original.bank,
      next: { ...scriptBank, questions: sPlan.questions },
      now: new Date('2026-11-02T03:04:05.678Z'),
    });
    check('파일 쓰기: 백업 폴더 이름 before-probe-<시각>', path.basename(written.backupDir) === 'before-probe-2026-11-02T03-04-05-678Z', written.backupDir);
    check(
      '파일 쓰기: 백업에 질문지 · 오버레이 원문',
      written.copied.length === 2 &&
        raw(path.join(written.backupDir, `${VERSION}.json`)) === original.bank &&
        raw(path.join(written.backupDir, 'tenants.overlay.json')) === original.overlay,
      written.copied.join(','),
    );
    const after1 = JSON.parse(raw(files.bank)) as ServerQuestionBank;
    check(
      '파일 쓰기: 기존 문항 그대로 · 실증 2개를 뒤에 · 은행의 다른 필드 그대로',
      sameJson(after1.questions.slice(0, 4), scriptBank.questions) &&
        sameJson(after1.questions.slice(4).map((q) => q.questionId), ['v5-p001', 'v5-p002']) &&
        after1.questions.slice(4).every((q) => q.probe === true && !q.cohortShared) &&
        sameJson(after1.cohortBank, scriptBank.cohortBank) &&
        after1.generatedAt === scriptBank.generatedAt,
      JSON.stringify(after1.questions.slice(4)),
    );
    check('파일 쓰기: 오버레이(questionBankSize) · 코호트 공통 질문지는 그대로', raw(files.overlay) === original.overlay && raw(files.cohort) === original.cohort);
    let staleError = '';
    try {
      await writeProbeBank({
        bankPath: files.bank,
        overlayPath: files.overlay,
        tenantDir: tenantDirS,
        before: original.bank,
        next: { ...scriptBank, questions: sPlan.questions },
        now: new Date('2026-11-02T03:05:00.000Z'),
      });
    } catch (err) {
      staleError = err instanceof Error ? err.message : String(err);
    }
    check('파일 쓰기: 계획 뒤 질문지가 바뀌었으면 아무것도 안 씀(백업도 안 만듦)', staleError.includes('그 사이 바뀌었습니다') && backups().length === 1, staleError);
  }
  // 하위 프로세스 검사를 위해 처음 상태로 되돌린다.
  writeFileSync(files.bank, original.bank);
  for (const name of backups()) rmSync(path.join(tenantDirS, name), { recursive: true, force: true });

  // 스크립트 --write — 하위 프로세스(tsx). 쓰기 모드는 판정 엔진을 부르지 않는다. Blob 토큰은 비워 로컬 오버레이를 읽게 한다.
  const tsxCli = path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs');
  const runScript = (appData: string, candidatesPath: string, ...extra: string[]) =>
    spawnSync(process.execPath, [tsxCli, 'scripts/add-probe-questions.ts', S.tenantId, '--app-data', appData, '--write', '--from', candidatesPath, ...extra], {
      encoding: 'utf8',
      env: { ...process.env, APP_DATA_DIR: '', BLOB_READ_WRITE_TOKEN: '', BLOB_STORE_ID: '', DOTENV_CONFIG_QUIET: 'true' },
    });
  const unchanged = () => raw(files.bank) === original.bank && raw(files.overlay) === original.overlay && raw(files.cohort) === original.cohort && backups().length === 0;
  const saveCandidates = (name: string, value: ProbeCandidatesFile) => put(sdir, name, value);

  const mismatch = runScript(sdir, saveCandidates('mismatch.json', scriptCandidates({ bankQuestionCount: 3 })));
  check(
    '스크립트 --write: 문항 수가 후보 파일과 다르면 거절 · 아무것도 안 바뀜',
    mismatch.status === 1 && mismatch.stderr.includes('지금 문항 수(4)가 후보를 만들 때(3)와 다릅니다') && unchanged(),
    `${mismatch.status} ${mismatch.stderr}`,
  );
  const goodCandidates = saveCandidates('good.json', scriptCandidates());
  const expectMiss = runScript(sdir, goodCandidates, '--expect-count', '42');
  check(
    '스크립트 --write: --expect-count와 다르면 거절 · 해석한 절대 경로와 문항 수를 먼저 보임',
    expectMiss.status === 1 &&
      expectMiss.stderr.includes('--expect-count 42') &&
      expectMiss.stdout.includes(`앱 데이터: ${sdir}`) &&
      expectMiss.stdout.includes(`질문지: ${files.bank}`) &&
      expectMiss.stdout.includes(`${VERSION} · 문항 4개(실증 0개)`) &&
      unchanged(),
    `${expectMiss.status} ${expectMiss.stdout}${expectMiss.stderr}`,
  );
  // 가상화 사본처럼 보이는 경로 — 같은 가짜 데이터를 Packages\Claude_…\ 아래에 둔다.
  const virtualRoot = path.join(sdir, 'Packages', 'Claude_fake', 'LocalCache', 'Roaming', 'brand-aeo-app');
  const vFiles = seed(virtualRoot);
  const vBank = raw(vFiles.bank);
  const virtual = runScript(virtualRoot, saveCandidates('virtual.json', scriptCandidates({ bankPath: vFiles.bank })));
  check(
    '스크립트 --write: 가상화 사본 경로면 거절 · 아무것도 안 바뀜',
    virtual.status === 1 &&
      virtual.stderr.includes('가상화 사본') &&
      raw(vFiles.bank) === vBank &&
      readdirSync(path.join(virtualRoot, 'data', S.tenantId)).every((n) => !n.startsWith('before-probe-')),
    `${virtual.status} ${virtual.stderr}`,
  );
  const spawnScript = (scriptArgs: string[], env: NodeJS.ProcessEnv) =>
    spawnSync(process.execPath, [tsxCli, 'scripts/add-probe-questions.ts', S.tenantId, ...scriptArgs], {
      encoding: 'utf8',
      env: { ...process.env, APP_DATA_DIR: '', BLOB_READ_WRITE_TOKEN: '', BLOB_STORE_ID: '', DOTENV_CONFIG_QUIET: 'true', ...env },
    });
  // 평범한 %APPDATA% 경로(가짜 프로필 · Claude 패키지 폴더 있음) — 경로 글자로는 가상화가 안 보여도 써 보고 확인한 뒤에야 쓴다.
  // 이 셸에서 실제 리다이렉트는 흉내 낼 수 없으므로(위 writeRedirects 검사가 맡는다) 여기서는 확인을 거치고 표지 파일이 남지 않는지 본다.
  const profile = path.join(sdir, 'fake-profile');
  mkdirSync(path.join(profile, 'Local', 'Packages', 'Claude_fake', 'LocalCache'), { recursive: true });
  const pRoot = path.join(profile, 'Roaming', 'brand-aeo-app');
  const pFiles = seed(pRoot);
  const plain = spawnScript(
    ['--app-data', pRoot, '--write', '--from', saveCandidates('plain.json', scriptCandidates({ bankPath: pFiles.bank })), '--expect-count', '4'],
    { APPDATA: path.join(profile, 'Roaming'), LOCALAPPDATA: path.join(profile, 'Local') },
  );
  check(
    '스크립트 --write: 평범한 %APPDATA% 경로도 써 보는 확인을 거침 · 표지 파일이 남지 않음',
    plain.stdout.includes(`쓰기 확인: ${path.dirname(pFiles.bank)}에 쓴 파일이 그 자리에 갑니다`) &&
      (plain.status === 0 || /앱이 실행 중|tasklist 실행에 실패/.test(plain.stderr)) &&
      readdirSync(path.dirname(pFiles.bank)).every((n) => !n.startsWith('.probe-write-check-')),
    `${plain.status} ${plain.stdout}${plain.stderr}`,
  );
  // dry-run --paraphrase-of에 홀드아웃을 주면 판정 엔진을 부르기 전에 멈춘다(혹시 지나가도 mock 엔진 · --out은 임시 폴더).
  const hRoot = path.join(sdir, 'holdout-root');
  const hFiles = seed(hRoot);
  writeFileSync(
    hFiles.bank,
    JSON.stringify({
      ...scriptBank,
      questions: [
        ...scriptBank.questions,
        sq('v5-p001', '가상읍 조용한 숙소 골라줘', 'category-agnostic', { probe: true, stage: 'consider' }),
        sq('v5-p002', '가상읍 한적한 숙소 하나 골라줘', 'category-agnostic', { probe: true, stage: 'consider', paraphraseOf: 'v5-p001' }),
      ],
    }),
  );
  const chain = spawnScript(['--app-data', hRoot, '--paraphrase-of', 'v5-p002', '--out', sdir], { USE_MOCK_ENGINES: 'true' });
  check(
    '스크립트 dry-run: 홀드아웃을 원래 질문으로 주면 엔진 호출 전에 멈춤',
    chain.status === 1 && chain.stderr.includes('v5-p002는 v5-p001의 홀드아웃입니다') && !chain.stdout.includes('판정 엔진('),
    `${chain.status} ${chain.stdout}${chain.stderr}`,
  );

  // 앱이 켜져 있으면 쓰기를 거절해야 하고, 꺼져 있으면 백업 뒤 덧붙인다(migrate-question-plan.ts와 같은 tasklist 확인).
  const appRunning = (() => {
    try {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Web4AI Brand AEO.exe', '/NH', '/FO', 'CSV'], { encoding: 'utf8' });
      return /^"Web4AI Brand AEO\.exe","\d+"/im.test(out);
    } catch (err) {
      console.warn(`tasklist를 실행하지 못했습니다 — 스크립트도 쓰기를 거절해야 합니다: ${err instanceof Error ? err.message : String(err)}`);
      return true;
    }
  })();
  const good = runScript(sdir, goodCandidates, '--expect-count', '4');
  if (appRunning) {
    check(
      '스크립트 --write: 앱이 켜져 있으면(지금 켜져 있음) 쓰기 직전에 거절 · 아무것도 안 바뀜',
      good.status === 1 && /앱이 실행 중|tasklist 실행에 실패/.test(good.stderr) && good.stdout.includes('덧붙일 실증 질문 2개') && unchanged(),
      `${good.status} ${good.stderr}`,
    );
  } else {
    const saved = JSON.parse(raw(files.bank)) as ServerQuestionBank;
    check(
      '스크립트 --write: 앱이 꺼져 있으면(지금 꺼져 있음) 백업 뒤 실증 2개만 덧붙임',
      good.status === 0 &&
        backups().length === 1 &&
        sameJson(saved.questions.slice(0, 4), scriptBank.questions) &&
        sameJson(saved.questions.slice(4).map((q) => q.questionId), ['v5-p001', 'v5-p002']) &&
        raw(files.overlay) === original.overlay &&
        raw(files.cohort) === original.cohort,
      `${good.status} ${good.stdout}${good.stderr}`,
    );
  }
} finally {
  rmSync(sdir, { recursive: true, force: true });
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
