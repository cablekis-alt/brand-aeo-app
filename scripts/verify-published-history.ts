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
import type { QuestionBank, RunReadIssue, RunSnapshot } from '../server/store';
import type { QuestionRepeatAnalysis } from '../server/types';
import type { WeeklyScorecard } from '../src/prompts/b8-report';
import { citedPostIdsInWeek, executionSummaryLine, freshNoCiteNote, summarizePost, withinIndexingGrace } from '../src/lib/publishTracking';

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
  // 회차 기록(runs/) — 없으면 회차 기록이 생기기 전과 같은 출력이어야 한다.
  runsByWeek: Record<string, { runs: RunSnapshot[]; issues: RunReadIssue[] }> = {},
) => ({
  getScorecardHistory: async (_t: string, n: number) => cardList.slice(-n),
  getQuestionAnalyses: async (_t: string, week: string) => {
    reads += 1;
    return byWeek[week] ?? [];
  },
  getQuestionBank: async (_t: string, v: string) => bankMap[v] ?? null,
  listRunSnapshots: async (_t: string, week: string) => runsByWeek[week] ?? { runs: [], issues: [] },
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
ok('측정 조건이 바뀐 주를 알린다(판정 모델 · 질문지)', (w['2026-W42']?.changes ?? []).includes('판정 모델') && (w['2026-W42']?.changes ?? []).includes('질문지'));

// 3) 칸 — 응답 단위 · 이름 없는/이름 댄 · 뒷받침 · 질의만 다른 주소
const c42 = h.posts[0]!.cells[2]!;
ok('응답 단위로 센다(한 응답 안 두 번은 1)', c42.tally?.all.cited === 2 && c42.tally.unnamed?.cited === 1 && c42.tally.named?.cited === 1);
ok('뒷받침 · 이름이 나온 응답을 센다', c42.tally?.all.supporting === 1 && c42.tally.all.mentioned === 1);
ok('질의만 다른 주소는 응답 단위로 따로 센다', c42.variantCited === 1);
ok('은행을 못 찾은 주는 이름 없는 질문 수가 null(인용 수는 남는다)', h.posts[0]!.cells[3]?.tally?.unnamed === null && h.posts[0]!.cells[3]?.tally?.all.cited === 1);
ok(
  '올린 뒤 며칠 뒤 측정인지 칸에 싣는다(그 주 첫 측정일 · 시각이 없으면 그 주 월요일 기준)',
  h.posts[0]!.cells[0]?.daysAfterPublish === 3 && h.posts[0]!.cells[2]?.daysAfterPublish === 16 && h.posts[0]!.cells[3]?.daysAfterPublish === 21,
);

// 3-b) 갓 올린 글 — 2026-10-21에 올리고 10-22에 한 번 잰 글이 곧바로 「인용 없음」이 됐다(스테이,머뭄 블로그 글). 14일 안 측정뿐이면 「색인 대기」.
{
  const fresh = await getPublishedHistory(
    makeStore([card('2026-W43', { questionBankVersion: 'v5' })], { '2026-W43': [answer('c1-001', 0, [['https://other.example/x', false]], at('2026-10-22'))] }, banks),
    tenant,
    [post('pn', '2026-10-21')],
    12,
  );
  const freshCell = fresh.posts[0]?.cells[0];
  ok('올린 다음 날 측정 — 칸에 1일', freshCell?.timing === 'after' && freshCell.daysAfterPublish === 1);
  ok('올린 다음 날 측정에서 인용이 없으면 「인용 없음」이 아니라 「색인 대기」', summarizePost(fresh.posts[0]!.cells, fresh.weeks).tier === 'indexing');
}

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
// 색인 대기 — 부정 판단만 미룬다
const young = (cited: number, days: number) => ({ ...cell('after', cited), daysAfterPublish: days });
ok('올린 지 14일 안 측정만 있고 인용이 없으면 색인 대기', s([young(0, 1), null, young(0, 8), cell('before', 0)]).tier === 'indexing');
ok('14일 지난 측정이 하나라도 있으면 인용 없음', s([young(0, 6), null, young(0, 14), cell('before', 0)]).tier === 'none');
ok('14일 안의 인용은 그대로 센다(판단 보류)', s([young(1, 3), null, cell('before', 0), cell('before', 0)]).tier === 'once');
ok('14일 안에 내렸으면 기다려도 풀리지 않는다 — 내림', s([young(0, 2), null, { ...young(0, 9), afterRemoval: true, tally: null }, cell('before', 0)]).tier === 'removed');
ok('일수가 없는 칸(옛 서버)은 지난 것으로 본다', s([cell('after', 0), null, cell('before', 0), cell('before', 0)]).tier === 'none');
ok('경계 — 13일은 색인 대기, 14일은 인용 없음', s([young(0, 13)]).tier === 'indexing' && s([young(0, 14)]).tier === 'none');
ok('withinIndexingGrace — 13일 안, 14일 · 일수 없음은 지남', withinIndexingGrace(13) && !withinIndexingGrace(14) && !withinIndexingGrace(undefined) && !withinIndexingGrace(null));
// 내린 날을 넘기면 내린 뒤 측정 칸이 아직 없어도 기다려 풀리는 상태로 두지 않는다(2026-10-22 검토 — 다음 측정 전 · 지난 주차 보고서)
ok('14일 안 측정만 있는데 내렸으면(내린 뒤 칸 없음) 내림', summarizePost([young(0, 1)], h.weeks.slice(0, 1), '2026-10-23').tier === 'removed');
ok('보고 주차 뒤에 내렸으면(내린 날을 넘기지 않음) 그 주는 색인 대기', summarizePost([young(0, 1)], h.weeks.slice(0, 1), null).tier === 'indexing');
ok('올린 뒤 측정 없이 내렸으면(내린 뒤 칸 없음) 측정 대기가 아니라 내림', summarizePost([cell('before', 0)], h.weeks.slice(0, 1), '2026-10-23').tier === 'removed');
ok(
  '갓 올린 글의 인용 없음 칸 꼬리 — 14일 안 · 인용 없음 · 올린 뒤일 때만',
  freshNoCiteNote({ ...young(0, 1) }) === '올린 지 1일 · 아직 판단 전' &&
    freshNoCiteNote({ ...young(0, 14) }) === null &&
    freshNoCiteNote({ ...young(1, 3) }) === null &&
    freshNoCiteNote({ ...cell('before', 0), daysAfterPublish: 1 }) === null,
);
ok(
  '보고서 요약 문장에 색인 대기를 센다',
  executionSummaryLine([{ tier: 'indexing' }, { tier: 'indexing' }, { tier: 'none' }], 'W43') === 'W43까지 기록한 집행 글 3편: 인용 없음 1편 · 색인 대기(올린 지 14일 안) 2편.',
);

// 성과 표 — 같은 주소 · 같은 올린 날을 여러 줄(자사 블로그 줄 · 채널 줄)에 적은 기록은 한 행으로 묶고 올린 곳 칩을 함께 보인다
// (2026-10-21 티스토리 /1이 두 행으로 보였다). 올린 날이 다르면(내렸다 다시 올림) 따로 둔다.
{
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  // tsx는 이 저장소에서 JSX를 고전 방식(React.createElement)으로 바꾼다 — 그림을 그리기 전에 전역 React를 둔다(verify-execution-marks와 같다).
  Object.assign(globalThis, { React });
  const { default: PublishedHistoryTable } = await import('../src/components/PublishedHistoryTable');
  const row = (id: string, targetActionId: string, via: PublishedPost['via'], publishedOn: string, url = 'https://fake.tistory.com/1') => ({
    post: { id, url, key: url.replace('https://', ''), publishedOn, publishedOnSource: 'user', recordedAt: `${publishedOn}T01:00:00Z`, articleId: 'content:a', targetActionId, via, articleTitle: '가상 글' } as PublishedPost,
    cells: [null],
  });
  const html = renderToStaticMarkup(
    React.createElement(PublishedHistoryTable, {
      history: {
        weeks: [{ weekOf: '2026-W43', analysed: true, window: null, engines: [], bankVersion: null, responses: { all: 0, unnamed: null, named: null, unknown: 0 }, changes: [] }],
        posts: [
          row('p-own', 'content:a', 'own', '2026-10-21'),
          row('p-channel', 'listing:platform:tistory.com', 'channel', '2026-10-21'),
          row('p-other', 'listing:platform:blog.naver.com', 'channel', '2026-10-21', 'https://blog.naver.com/fakeblog/2233'),
        ],
      },
    }),
  );
  const rows = html.match(/<tr>/g)?.length ?? 0;
  ok('성과 표 — 같은 주소 · 같은 날 두 줄은 한 행(머리 1 + 글 2)', rows === 3);
  ok('성과 표 — 묶인 행에 올린 곳 칩 둘', html.includes('tistory.com') && html.includes('자사 블로그 · 사이트') && (html.match(/st st-info/g)?.length ?? 0) === 2);
}

// 8) 회차 합치기 — 같은 주에 여러 번 잰 회차(runs/)를 칸 하나로 합친다(server/publishedHistory.ts foldCell). 한 회차라도 인용하면 그 주는
// 인용, 숫자는 회차마다 센 뒤 더한다(이어 붙여 한 번에 세면 같은 응답 키가 한 번으로 줄어든다). 표본이 하나뿐인 주는 전과 같다.
{
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  Object.assign(globalThis, { React });
  const { default: PublishedHistoryTable } = await import('../src/components/PublishedHistoryTable');
  const { runTallyText } = await import('../src/lib/publishTracking');
  const ENG = ['gemini', 'perplexity'];
  const wcard = (weekOf: string, extra: Partial<WeeklyScorecard> = {}) => card(weekOf, { questionBankVersion: 'v5', enginesUsed: ENG, ...extra });
  const px = (day: string) => answer('c1-001', 0, [], { ...at(day), engine: 'perplexity' as QuestionRepeatAnalysis['engine'] });
  const meta = (weekOf: string, runId: string, finishedAt: string, extra: Partial<RunSnapshot['meta']> = {}): RunSnapshot['meta'] => ({
    runId,
    tenantId: T,
    weekOf,
    startedAt: finishedAt,
    finishedAt,
    selfOnly: true,
    inCohortRun: false,
    weekCard: 'saved',
    engines: { gemini: { planned: 2, succeeded: 2 }, perplexity: { planned: 2, succeeded: 2 } },
    engineIssues: [],
    contextFingerprint: 'f',
    collectUsage: {},
    ...extra,
  });
  const snap = (weekOf: string, runId: string, finishedAt: string, analyses: QuestionRepeatAnalysis[], extra: Partial<RunSnapshot['meta']> = {}, cardExtra: Partial<WeeklyScorecard> = {}): RunSnapshot => ({
    meta: meta(weekOf, runId, finishedAt, extra),
    scorecard: wcard(weekOf, cardExtra),
    analyses,
  });
  // W45: 11-03(화)에 올림. R1 11-02(올리기 전, 인용) · R2 11-05(D+2, 인용) · R3 11-07(D+4, 같은 응답 키로 인용 — 그 주 카드) · R4 11-08(D+5,
  // Perplexity가 빠져 카드를 덮지 않음, 은행 판 v9라 이름 없는/이름 댄 확인 불가, 인용).
  const r1 = [answer('c1-001', 0, [[POST, false]], at('2026-11-02')), px('2026-11-02')];
  const r2 = [answer('c1-001', 0, [[POST, false]], at('2026-11-05')), px('2026-11-05')];
  const r3 = [answer('c1-001', 0, [[POST, true]], at('2026-11-07')), px('2026-11-07')];
  const r4 = [answer('c1-002', 0, [[POST, false]], at('2026-11-08'))];
  // W46: 11-10(화)에 올린 둘째 글과 같은 날 두 번 잼 — 둘째 글은 두 회차 모두 측정하던 날(전후 불명), 첫 글은 D+7 · 인용 없음. 회차 하나는 깨짐.
  const r5 = [answer('c1-001', 0, [], at('2026-11-10')), px('2026-11-10')];
  const t6 = { timing: { startedAt: '2026-11-10T06:00:00Z', wallMs: 0, judgeMs: { mention: 0, citation: 0, rank: 0, fact: 0 } } };
  const r6 = [answer('c1-001', 0, [], t6), answer('c1-001', 0, [], { ...t6, engine: 'perplexity' as QuestionRepeatAnalysis['engine'] })];
  const runCards = [wcard('2026-W44'), wcard('2026-W45'), wcard('2026-W46')];
  const runStore = makeStore(
    runCards,
    { '2026-W44': [answer('c1-001', 0, [], at('2026-10-28')), px('2026-10-28')], '2026-W45': r3, '2026-W46': r6 },
    banks,
    {
      '2026-W45': {
        runs: [
          snap('2026-W45', 'r1', '2026-11-02T02:00:00Z', r1),
          snap('2026-W45', 'r2', '2026-11-05T02:00:00Z', r2),
          snap('2026-W45', 'r3', '2026-11-07T02:00:00Z', r3),
          snap(
            '2026-W45',
            'r4',
            '2026-11-08T02:00:00Z',
            r4,
            { weekCard: 'kept', weekCardKeptReason: '엔진 빠짐', engines: { gemini: { planned: 1, succeeded: 1 }, perplexity: { planned: 1, succeeded: 0 } } },
            { questionBankVersion: 'v9', enginesUsed: ['gemini'] },
          ),
        ],
        issues: [],
      },
      '2026-W46': {
        runs: [snap('2026-W46', 'r5', '2026-11-10T02:00:00Z', r5), snap('2026-W46', 'r6', '2026-11-10T07:00:00Z', r6)],
        issues: [{ weekOf: '2026-W46', runId: 'bad', reason: '깨진 판정 파일(검증용)' }],
      },
    },
  );
  const p1 = post('run-1', '2026-11-03');
  const p2 = post('run-2', '2026-11-10', { url: 'https://example.com/blog/8', key: 'example.com/blog/8' });
  const rh = await getPublishedHistory(runStore, tenant, [p1, p2], 12);
  const wk = (weekOf: string) => rh.weeks.find((x) => x.weekOf === weekOf)!;
  const cell = (post: number, weekOf: string) => rh.posts[post]!.cells[rh.weeks.findIndex((x) => x.weekOf === weekOf)]!;
  const c45 = cell(0, '2026-W45');
  ok('회차 합치기 — 올린 뒤 회차가 하나라도 있으면 칸은 after', c45.timing === 'after');
  ok(
    '회차 합치기 — 올린 뒤 3회 중 3회 인용 · 엔진 빠진 회차 1(Perplexity) · 그 주 인용 D+2·4·5',
    c45.runs?.measured === 3 && c45.runs.cited === 3 && c45.runs.weak === 1 && c45.runs.weakEngines.join() === 'perplexity' && c45.runs.citedDays.join() === '2,4,5',
  );
  ok('회차 합치기 — 같은 응답 키라도 회차가 다르면 따로 센다(응답 합 3)', c45.tally?.all.cited === 3);
  ok('회차 합치기 — 한 회차라도 은행을 못 읽었으면 이름 없는/이름 댄은 확인 불가', c45.tally?.unnamed === null && c45.tally?.named === null);
  ok('회차 합치기 — 올리기 전 회차의 인용은 따로 센다(칸은 after)', c45.citedBeforeRuns === 1);
  ok('회차 합치기 — 일수는 가장 늦은 회차(D+5)', c45.daysAfterPublish === 5);
  ok(
    '회차 합치기 — 주 측정 창은 그 주 카드 회차(r3)의 창 · 회차마다의 창은 runs에 · 회차 4개',
    wk('2026-W45').window?.first === '2026-11-07' && wk('2026-W45').window?.last === '2026-11-07' && wk('2026-W45').runs?.length === 4 &&
      wk('2026-W45').runs?.find((r) => r.isWeekCard)?.runId === 'r3' && wk('2026-W45').runs?.[0]?.window?.first === '2026-11-02',
  );
  const cited45 = citedPostIdsInWeek(rh, '2026-W45');
  ok('그 주 칸에서 인용된 기록 — 회차를 합친 칸 기준(첫 글만)', cited45?.has('run-1') === true && cited45.has('run-2') === false && citedPostIdsInWeek(rh, '2026-W99') === null);
  ok('회차 합치기 — 표본이 하나뿐인 주는 runs가 없다(전과 같은 칸)', wk('2026-W44').runs === undefined && cell(0, '2026-W44').runs === undefined);
  ok('회차 합치기 — 읽지 못한 회차는 그 주 runIssues에 남는다', wk('2026-W46').runIssues?.length === 1);
  const c46 = cell(0, '2026-W46');
  ok('회차 합치기 — 인용 없는 주는 「2회 · 인용 없음」과 색인 대기 꼬리', runTallyText(c46)?.main === '2회 · 인용 없음' && runTallyText(c46)?.sub.includes('올린 지 7일 · 아직 판단 전') === true);
  const d46 = cell(1, '2026-W46');
  ok('회차 합치기 — 같은 날 두 번 잰 날 올린 글은 전후 불명이고 회차 문구를 쓰지 않는다', d46.timing === 'during' && d46.runs?.unsure === 2 && runTallyText(d46) === null);
  const s1 = summarizePost(rh.posts[0]!.cells, rh.weeks);
  ok(
    '회차 합치기 — 판단은 주 단위(한 주 인용 · 판단 보류) · 회차 3/5 · 첫 인용 D+2 · 올리기 전 인용 알림',
    s1.tier === 'once' && s1.measuredAfter === 2 && s1.citedWeeks === 1 && s1.measuredRuns === 5 && s1.citedRuns === 3 && s1.firstCitedDays === 2 && s1.citedBeforePublish && s1.lapsed,
  );
  const html = renderToStaticMarkup(React.createElement(PublishedHistoryTable, { history: rh }));
  ok(
    '성과 표 — 회차 칸 · 머리글 회차 수 · 판단 칸 회차 · 첫 인용',
    html.includes('3회 중 3회 · 그 주 인용 D+2·4·5') && html.includes(' ·4회') && html.includes('(회차 3/5)') && html.includes('첫 인용 확인 D+2') && html.includes('한 주 인용 · 판단 보류'),
  );
  ok('성과 표 — 읽지 못한 회차를 알린다', html.includes('회차 기록 1개를 읽지 못해 칸에서 뺐습니다'));

  // 측정하던 날 올리고 같은 주에 다시 잼 — 전후 불명 회차와 올린 뒤 회차가 섞이면 올린 뒤가 앞선다(인용을 판단에 넣는다).
  const p3 = post('run-3', '2026-11-17', { url: 'https://example.com/blog/9', key: 'example.com/blog/9' });
  const ra = [answer('c1-001', 0, [], at('2026-11-17')), px('2026-11-17')];
  const rb = [answer('c1-001', 0, [['https://example.com/blog/9', false]], at('2026-11-19')), px('2026-11-19')];
  const mixStore = makeStore([wcard('2026-W47')], { '2026-W47': rb }, banks, {
    '2026-W47': { runs: [snap('2026-W47', 'ra', '2026-11-17T02:00:00Z', ra), snap('2026-W47', 'rb', '2026-11-19T02:00:00Z', rb)], issues: [] },
  });
  const mix = (await getPublishedHistory(mixStore, tenant, [p3], 12)).posts[0]!.cells[0]!;
  ok(
    '회차 합치기 — 측정하던 날 회차 + 올린 뒤 회차면 칸은 after(올린 뒤 1회 · 전후 불명 1회 · 인용 1)',
    mix.timing === 'after' && mix.runs?.measured === 1 && mix.runs.unsure === 1 && mix.tally?.all.cited === 1 && runTallyText(mix)?.main === '1회 중 1회 · 그 주 인용 D+2',
  );
}

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
