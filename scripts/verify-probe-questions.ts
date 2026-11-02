/**
 * 실증 질문(probe)이 점수 모집단에서 빠지는지 확인한다. 가짜 브랜드 · 가짜 주소만 쓰고 AI는 부르지 않는다.
 *
 * 왜: 실증 질문은 같은 질문지 판에 probe: true로 덧붙여 매번 측정한다. 판이 같으니 「같은 조건」 판정은 그대로 참이고,
 * 그 말이 맞으려면 점수 모집단이 문항 하나도 바뀌지 않아야 한다. 덧붙이기 전 은행 + 원래 응답과, 덧붙인 은행 + 원래 응답
 * + 실증 응답이 한 바이트도 다르지 않은 지표를 내야 한다. 특히 사실성 · 자사 인용률 · CI는 이름 없는 질문만이 아니라 전체
 * 응답을 써서, 이름 없는 질문 거르개만 고쳐서는 실증 인용이 자사 인용률(점수의 20%)에 섞인다. 점수 밖에서 문항을 직접 세는 곳
 * (회차 보기 N · 브랜드 현황 질문지 비교 · 일반 질문 하한 · 인용 분해 · 인용 출처 · EEAT · 경쟁사 편집의 질문 수와 크기)도 같은
 * 규칙을 따라야 화면 숫자가 카드와 맞는다. 브랜드 현황 · 경쟁사 편집은 임시 폴더를 APP_DATA_DIR로 쓴다.
 *
 *   npx tsx scripts/verify-probe-questions.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { WeeklyScorecard } from '../src/prompts/b8-report';
import type { QuestionSpec } from '../src/prompts/types';
import { isProbe, isScoredAgnostic, probeIdsOf, withoutProbes } from '../src/lib/questionScope';
import { countAgnostic } from '../src/prompts/b1-question-bank';
import { aggregateWeeklyMetrics } from '../server/aggregate';
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
