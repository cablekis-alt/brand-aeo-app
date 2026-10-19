/**
 * 올린 글 인용 이력(server/publishedHistory.ts)과 글별 판단(src/lib/publishTracking.ts)을 확인한다. 가짜 저장소만 쓴다 — 앱 데이터 ·
 * 서버 · AI는 부르지 않는다.
 *
 * 왜: 이력은 「집행한 일이 효과가 있었나」에 답하는 유일한 숫자다. 올리기 전 측정을 세거나, 판정 기록이 없는 주를 0으로 보이거나,
 * 질문 은행을 못 읽은 주를 이름 없는 질문 0회로 보이거나, 한 번 인용된 것을 「인용됨」으로 단정하면 고객 보고서가 틀린다.
 *
 *   npx tsx scripts/verify-published-history.ts
 */
import { getPublishedHistory } from '../server/publishedHistory';
import type { PublishedPost } from '../server/publishedPosts';
import type { QuestionBank } from '../server/store';
import type { QuestionRepeatAnalysis } from '../server/types';
import type { WeeklyScorecard } from '../src/prompts/b8-report';
import { summarizePost } from '../src/lib/publishTracking';

const checks: [string, boolean][] = [];
const ok = (label: string, cond: boolean) => checks.push([label, cond]);

const T = 'fake-tenant';
const answer = (questionId: string, callIndex: number, cites: [string, boolean][], extra: Partial<QuestionRepeatAnalysis> = {}) =>
  ({
    questionId,
    engine: 'gemini',
    callIndex,
    mentioned: false,
    mentionSentences: [],
    competitorMentions: [],
    shareOfMention: 0,
    topRecommendation: null,
    brandRank: null,
    factualityClaims: [],
    factualitySupported: 0,
    factualityContradicted: 0,
    brandOwnedCitation: false,
    citations: cites.map(([raw, supportsBrandMention]) => ({ raw, domain: null, ownerType: 'third-party-ugc', supportsBrandMention })),
    ...extra,
  }) as unknown as QuestionRepeatAnalysis;
const at = (day: string) => ({ timing: { startedAt: `${day}T01:00:00Z`, wallMs: 0, judgeMs: { mention: 0, citation: 0, rank: 0, fact: 0 } } });

// 은행 — v4와 v5는 같은 id(c1-001)를 다른 질문으로 쓴다. c1-001은 이름 없는 질문, c1-002는 이름을 댄 질문.
const bank = (version: string, generatedAt: string) =>
  ({
    version,
    generatedAt,
    questions: [
      { questionId: 'c1-001', text: `${version} 이름 없는 질문`, category: 'category-agnostic', containsBrandName: false },
      { questionId: 'c1-002', text: `${version} 이름 댄 질문`, category: 'brand-direct', containsBrandName: true },
    ],
  }) as unknown as QuestionBank;
const banks: Record<string, QuestionBank> = { v4: bank('v4', '2026-09-01T00:00:00Z'), v5: bank('v5', '2026-10-10T00:00:00Z') };

const POST = 'https://example.com/blog/7';
const card = (weekOf: string, extra: Partial<WeeklyScorecard> = {}) => ({ tenantId: T, weekOf, enginesUsed: ['gemini'], questionBankVersion: 'v4', judgeModel: 'judge-a', ...extra }) as unknown as WeeklyScorecard;
const cards = [
  card('2026-W40'),
  card('2026-W41'), // 카드는 있는데 판정 기록이 없다
  card('2026-W42', { questionBankVersion: 'v5', judgeModel: 'judge-b' }),
  card('2026-W43', { questionBankVersion: 'v9' }), // 은행을 못 찾는다
];
const analysesByWeek: Record<string, QuestionRepeatAnalysis[]> = {
  '2026-W40': [answer('c1-001', 0, [[POST, false]], at('2026-10-01'))],
  '2026-W41': [],
  '2026-W42': [
    // 한 응답 안에서 같은 글 두 번(추적 파라미터만 다름) — 한 번만 센다
    answer('c1-001', 0, [[POST, true], [`${POST}?utm_source=openai`, true]], { ...at('2026-10-14'), mentioned: true }),
    answer('c1-001', 1, [[`${POST}?page=2`, false]], at('2026-10-14')),
    answer('c1-002', 0, [[POST, false]], at('2026-10-15')),
  ],
  '2026-W43': [answer('v9-001', 0, [[POST, true]])], // 측정 시각이 없는 옛 형태
};
let reads = 0;
// 실제 저장소처럼 최근 n장만 돌려준다(server/store.ts getScorecardHistory).
const makeStore = (
  cardList: WeeklyScorecard[],
  byWeek: Record<string, QuestionRepeatAnalysis[]>,
  bankMap: Record<string, QuestionBank>,
) => ({
  getScorecardHistory: async (_t: string, n: number) => cardList.slice(-n),
  getQuestionAnalyses: async (_t: string, week: string) => {
    reads += 1;
    return byWeek[week] ?? [];
  },
  getQuestionBank: async (_t: string, v: string) => bankMap[v] ?? null,
});
const store = makeStore(cards, analysesByWeek, banks);
const post = (id: string, publishedOn: string | null, extra: Partial<PublishedPost> = {}): PublishedPost => ({
  id,
  url: POST,
  key: 'example.com/blog/7',
  publishedOn,
  publishedOnSource: 'user',
  recordedAt: '2026-10-01T00:00:00Z',
  articleId: 'content:a',
  targetActionId: 'content:a',
  via: 'own',
  ...extra,
});
const tenant = { tenantId: T, questionBankVersion: 'v5' };

// 1) 기록이 없으면 주차 파일을 읽지 않는다
reads = 0;
const empty = await getPublishedHistory(store, tenant, [post('gone', '2026-09-01', { removedAt: '2026-09-02T00:00:00Z', removedReason: 'mistake' })], 12);
ok('「잘못 적은 주소」뿐이면 빈 결과이고 주차 파일을 읽지 않는다', empty.weeks.length === 0 && reads === 0);

// 2) 주 단위 메타
const h = await getPublishedHistory(store, tenant, [post('p1', '2026-09-28')], 12);
const w = Object.fromEntries(h.weeks.map((x) => [x.weekOf, x]));
ok('판정 기록이 없는 주는 analysed=false이고 칸은 null(0이 아니다)', w['2026-W41']?.analysed === false && h.posts[0]?.cells[1] === null);
ok('그 주를 측정한 은행으로 나눈다(W42는 v5)', w['2026-W42']?.bankVersion === 'v5' && w['2026-W42'].responses.unnamed === 2 && w['2026-W42'].responses.named === 1);
ok('은행을 못 찾은 주는 이름 없는/이름 댄 분모가 null', w['2026-W43']?.bankVersion === null && w['2026-W43'].responses.unnamed === null);
ok('측정 조건이 바뀐 주를 알린다(판정 모델 · 질문지)', (w['2026-W42']?.changes ?? []).includes('모델') && (w['2026-W42']?.changes ?? []).includes('질문지'));

// 3) 칸 — 응답 단위 · 이름 없는/이름 댄 · 뒷받침 · 질의만 다른 주소
const c42 = h.posts[0]!.cells[2]!;
ok('응답 단위로 센다(한 응답 안 두 번은 1)', c42.tally?.all.cited === 2 && c42.tally.unnamed?.cited === 1 && c42.tally.named?.cited === 1);
ok('뒷받침 · 이름이 나온 응답을 센다', c42.tally?.all.supporting === 1 && c42.tally.all.mentioned === 1);
ok('질의만 다른 주소는 응답 단위로 따로 센다', c42.variantCited === 1);
ok('은행을 못 찾은 주는 이름 없는 질문 수가 null(인용 수는 남는다)', h.posts[0]!.cells[3]?.tally?.unnamed === null && h.posts[0]!.cells[3]?.tally?.all.cited === 1);

// 4) 올린 날과 측정 시점
const timings = (on: string | null) => getPublishedHistory(store, tenant, [post('p', on)], 12).then((r) => r.posts[0]!.cells.map((c) => c?.timing ?? 'none').join(','));
ok('올린 날에 따라 before · after · during · ambiguous', (await timings('2026-10-14')) === 'before,none,during,after' && (await timings('2026-10-22')) === 'before,none,before,ambiguous');
ok('올린 날을 모르면 unknown', (await timings(null)) === 'unknown,none,unknown,unknown');

// 5) 글을 내렸으면 내린 뒤의 주는 세지 않는다
const down = await getPublishedHistory(store, tenant, [post('p', '2026-09-28', { removedAt: '2026-10-10T00:00:00Z', removedReason: 'taken-down' })], 12);
ok('「글을 내렸어요」: 내리기 전 주는 세고, 내린 뒤 주는 afterRemoval', down.posts[0]!.cells[0]?.afterRemoval === false && down.posts[0]!.cells[2]?.afterRemoval === true && down.posts[0]!.cells[2]?.tally === null);

// 5-2) 같은 주소를 올렸다 내리고 다시 올렸다 — 앞 글이 올라가 있던 주의 인용으로 새 기록의 올린 날을 의심하지 않는다
const old = post('old', '2026-09-28', { removedAt: '2026-10-02T00:00:00Z', removedReason: 'taken-down' });
const again = post('again', '2026-10-13');
const repost = await getPublishedHistory(store, tenant, [old, again], 12);
ok(
  '다시 올린 기록: 앞서 내린 기록이 올라가 있던 주의 인용은 「올리기 전 인용」 경고에 넣지 않는다',
  repost.posts[1]!.cells[0]?.earlierPostingLive === true && !summarizePost(repost.posts[1]!.cells, repost.weeks).citedBeforePublish,
);
const alone = await getPublishedHistory(store, tenant, [again], 12);
ok('앞 기록이 없으면 올리기 전 인용은 그대로 경고한다', alone.posts[0]!.cells[0]?.earlierPostingLive === undefined && summarizePost(alone.posts[0]!.cells, alone.weeks).citedBeforePublish);

// 6) topic: 글 — 기록한 판과 그 주 판이 같을 때만 겨냥한 질문의 언급을 낸다
const topic = await getPublishedHistory(store, tenant, [post('t', '2026-09-28', { articleId: 'topic:c1-001+c1-002', targetActionId: 'topic:c1-001+c1-002', topic: { bankVersion: 'v5', questionIds: ['c1-001', 'c1-002'], questionTexts: ['v5 이름 없는 질문', 'v5 이름 댄 질문'] } })], 12);
ok('topic: 판이 같은 주는 겨냥한 이름 없는 질문의 응답 · 언급', JSON.stringify(topic.posts[0]!.cells[2]?.topicMention) === JSON.stringify({ answered: 2, mentioned: 1 }));
ok('topic: 판이 다른 주(같은 id, 다른 질문)는 확인 불가(null)', topic.posts[0]!.cells[0]?.topicMention === null);

ok(
  'topic: 겨냥한 질문에 이름 없는 질문이 없으면 해당 없음(undefined — 0/0이 아니다)',
  (await getPublishedHistory(store, tenant, [post('n', '2026-09-28', { articleId: 'topic:c1-002', targetActionId: 'topic:c1-002', topic: { bankVersion: 'v5', questionIds: ['c1-002'], questionTexts: ['v5 이름 댄 질문'] } })], 12)).posts[0]!.cells[2]?.topicMention === undefined,
);
const clarifyingOnly = makeStore(cards, { ...analysesByWeek, '2026-W42': [answer('c1-001', 0, [], { clarifying: true }), answer('c1-002', 0, [])] }, banks);
ok(
  'topic: 그 주 겨냥 질문 답변이 모두 되묻기면 확인 불가(null — 0/0이 아니다)',
  (await getPublishedHistory(clarifyingOnly, tenant, [post('t', '2026-09-28', { articleId: 'topic:c1-001', targetActionId: 'topic:c1-001', topic: { bankVersion: 'v5', questionIds: ['c1-001'], questionTexts: ['v5 이름 없는 질문'] } })], 12)).posts[0]!.cells[2]?.topicMention === null,
);

// 6-2) 카드에 적힌 판의 은행 파일이 없으면 지금 판으로 넘어가지 않는다 — c1-001 같은 id는 판마다 다른 질문일 수 있다
const v4Missing = makeStore(cards, analysesByWeek, { v5: banks.v5! });
const missing = await getPublishedHistory(v4Missing, tenant, [post('t', '2026-09-28', { articleId: 'topic:c1-001', targetActionId: 'topic:c1-001', topic: { bankVersion: 'v5', questionIds: ['c1-001'], questionTexts: ['v5 이름 없는 질문'] } })], 12);
ok(
  '기록한 판(v4) 은행이 없으면 지금 판(v5)으로 나누지 않는다 — 확인 불가',
  missing.weeks[0]?.bankVersion === null && missing.weeks[0].responses.unnamed === null && missing.posts[0]!.cells[0]?.topicMention === null && missing.posts[0]!.cells[0]?.tally?.unnamed === null,
);

// 6-3) 판단은 올린 뒤 측정 전체로 — 요청한 주 수보다 오래전에 올렸으면 그 앞 측정까지 넓힌다
const wide = await getPublishedHistory(store, tenant, [post('p', '2026-10-05')], 1);
ok('요청 주 수(1)보다 오래전에 올렸으면 올린 주 바로 앞 측정부터 읽는다', wide.weeks.map((x) => x.weekOf).join(',') === '2026-W40,2026-W41,2026-W42,2026-W43');
const narrow = await getPublishedHistory(store, tenant, [post('p', '2026-11-30')], 1);
ok('아직 측정 전인 글은 요청 주 수만 읽고, 첫 열 조건 변경도 그 앞 측정과 견준다', narrow.weeks.length === 1 && (narrow.weeks[0]?.changes ?? []).includes('질문지'));
ok('올린 날을 모르는 기록은 창을 넓히지 않는다', (await getPublishedHistory(store, tenant, [post('p', null)], 2)).weeks.length === 2);

// 7) 글별 판단 — 「인용됨」은 올린 뒤 측정 2회 이상
const s = (cells: Parameters<typeof summarizePost>[0], weeks = h.weeks) => summarizePost(cells, weeks);
const cell = (timing: 'after' | 'before' | 'during', cited: number, unnamedCited: number | null = cited) =>
  ({ timing, afterRemoval: false, variantCited: 0, tally: cited ? { all: { cited, supporting: 0, mentioned: 0 }, unnamed: unnamedCited === null ? null : { cited: unnamedCited, supporting: 0, mentioned: 0 }, named: { cited: 0, supporting: 0, mentioned: 0 }, unknown: { cited: 0, supporting: 0, mentioned: 0 }, forms: [] } : null });
ok('올린 뒤 측정이 없으면 측정 대기', s([cell('before', 1), null, cell('before', 0), cell('during', 1)]).tier === 'waiting');
ok('올린 뒤 측정에서 인용이 없으면 인용 없음', s([cell('after', 0), null, cell('after', 0), cell('after', 0)]).tier === 'none');
ok('한 번만 인용되면 판단 보류', s([cell('after', 1), null, cell('after', 0), cell('after', 0)]).tier === 'once');
ok('올린 뒤 측정 2회 이상에서 인용되면 반복 인용', s([cell('after', 1), null, cell('after', 2), cell('after', 0)]).tier === 'repeated');
ok('올리기 전 측정에 인용이 있으면 날짜 확인 경고', s([cell('before', 1), null, cell('after', 0), cell('after', 0)]).citedBeforePublish);
ok('측정 조건이 바뀐 주가 섞이면 알린다', s([cell('after', 1), null, cell('after', 1), cell('after', 0)]).conditionMixed);
ok(
  '판정 기록이 없는 사이 주에서 바뀐 조건도 알린다',
  s([cell('after', 1), null, cell('after', 0)], [{ changes: [] }, { changes: ['수집 엔진'] }, { changes: [] }]).conditionMixed &&
    !s([cell('after', 1), null, cell('after', 0)], [{ changes: ['수집 엔진'] }, { changes: [] }, { changes: [] }]).conditionMixed,
);
const unknownCell = (cited: number) => ({ ...cell('after', cited), timing: 'unknown' as const });
ok('올린 날을 모르는 옛 기록은 측정 대기가 아니라 「올린 날 모름」', s([unknownCell(1), null, unknownCell(1), unknownCell(0)]).tier === 'undated');
ok(
  '올린 날을 모르는 기록은 내렸어도 「올린 날 모름」(「내림」이 먼저 걸리지 않는다)',
  s([unknownCell(1), null, unknownCell(1), { ...unknownCell(0), afterRemoval: true, tally: null }]).tier === 'undated',
);
ok(
  '판단할 수 있는 올린 뒤 측정 없이 내린 글은 측정 대기가 아니라 「내림」',
  s([cell('before', 0), null, { ...cell('after', 0), afterRemoval: true, tally: null }, { ...cell('after', 0), afterRemoval: true, tally: null }]).tier === 'removed',
);
ok('아직 올린 뒤 측정이 없는 글은 측정 대기', s([cell('before', 0), null, cell('during', 0), cell('before', 0)]).tier === 'waiting');

let failed = 0;
for (const [label, pass] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${label}`);
  if (!pass) failed += 1;
}
if (failed > 0) {
  console.error(`\n${failed}건 실패`);
  process.exit(1);
}
console.log(`\n모두 통과 (${checks.length}건)`);
