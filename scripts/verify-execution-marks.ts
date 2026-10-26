/**
 * 집행 핀(언급률 2번 P4)을 확인한다 — 그래프 위 자리(executionMarks), 측정 행별 편수, 보고서 한 문장, 점수 추이 그래프 마크업,
 * 개선제안의 재권고 방지. 가짜 데이터만 쓴다 — 앱 데이터 · 서버 · AI는 부르지 않는다.
 *
 * 왜: 핀이 한 칸만 어긋나도 「올린 뒤 측정」이 「올리기 전 측정」으로 읽힌다. 핀이 없는 브랜드의 그래프가 바뀌거나, 지난 주차
 * 보고서에 그 뒤의 집행이 그려지거나, 이미 집행한 일을 다시 권하면 고객 보고서가 틀린다.
 *
 *   npx tsx scripts/verify-execution-marks.ts
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ScoreTrendChart from '../src/components/ScoreTrendChart';
import type { PublishedPost } from '../src/lib/api';
import { computeGapActions } from '../src/lib/gapActions';
import { afterWeeksOf, distinctPostings, executionMarks, executionsPerSlot, executionSummaryLine } from '../src/lib/publishTracking';
import { trackingKey } from '../src/lib/publishedUrl';
import { buildRecommendationEvidence } from '../src/lib/recommendationEvidence';
import type { QuestionRepeatAnalysis as ClientAnalysis, QuestionSpec } from '../src/lib/types';
import type { WeeklyScorecard } from '../src/prompts/b8-report';
import { analyzeCitationSources } from '../server/citationSources';
import type { QuestionRepeatAnalysis } from '../server/types';

// tsx는 이 저장소에서 JSX를 고전 방식(React.createElement)으로 바꾼다 — 그림을 그리기 전에 전역 React를 둔다.
Object.assign(globalThis, { React });

const checks: [string, boolean][] = [];
const ok = (label: string, cond: boolean) => checks.push([label, cond]);

const post = (id: string, publishedOn: string | null, extra: Partial<PublishedPost> = {}): PublishedPost => ({
  id,
  url: `https://example.com/blog/${id}`,
  key: `example.com/blog/${id}`,
  publishedOn,
  publishedOnSource: 'user',
  recordedAt: '2026-10-19T00:00:00Z',
  articleId: `content:${id}`,
  targetActionId: `content:${id}`,
  via: 'own',
  articleTitle: `글 ${id}`,
  ...extra,
});

// 칸: W40 측정(10/1) · W41 미측정 · W42 측정(10/14~15) · W43 측정(시각 없음)
const slots = [
  { weekOf: '2026-W40', measured: true },
  { weekOf: '2026-W41', measured: false },
  { weekOf: '2026-W42', measured: true },
  { weekOf: '2026-W43', measured: true },
];
const weeks = [
  { weekOf: '2026-W40', window: { first: '2026-10-01', last: '2026-10-01' } },
  { weekOf: '2026-W42', window: { first: '2026-10-14', last: '2026-10-15' } },
  { weekOf: '2026-W43', window: null },
];
const posts = [
  post('a', '2026-09-29'), // W40, 측정 전 → W40 왼쪽 틈
  post('b', '2026-10-03'), // W40, 측정 뒤 → W40 오른쪽 틈
  post('f', '2026-10-04'), // b와 같은 자리 → 합친다
  post('c', '2026-10-07'), // W41 미측정 → 칸 위
  post('d', '2026-10-14'), // W42 측정하던 날 → 속 빈 핀
  post('e', '2026-10-20'), // W43 시각 없음 → 속 빈 핀
  post('g', '2026-09-01'), // 그래프 앞 → 수만
  post('h', '2026-10-28'), // W44 — endWeek 뒤
  post('i', '2026-10-05', { removedAt: '2026-10-06T00:00:00Z', removedReason: 'mistake' }),
  post('j', null), // 올린 날 모름
  post('k', '2026-10-02', { removedAt: '2026-10-20T00:00:00Z', removedReason: 'taken-down' }), // 내렸어도 올린 일이다
];
const m = executionMarks(posts, slots, weeks, '2026-W43');
const at = (x: number) => m.pins.find((p) => p.x === x);
ok('측정 전에 올린 글은 그 칸 왼쪽 틈(-0.5)', at(-0.5)?.posts.map((q) => q.post.id).join() === 'a' && at(-0.5)?.hollow === false);
ok('측정 뒤에 올린 글은 오른쪽 틈 — 같은 자리는 한 핀으로 합치고 올린 날 순으로 둔다', at(0.5)?.posts.map((q) => q.post.id).join() === 'k,b,f');
ok('측정하지 않은 주에 올린 글은 칸 위', at(1)?.posts.map((q) => q.post.id).join() === 'c' && at(1)?.hollow === false);
ok('측정하던 날 올린 글은 칸 위 속 빈 핀(전후 불명)', at(2)?.hollow === true && at(2)?.posts[0]?.post.id === 'd');
ok('시각 없는 같은 주도 속 빈 핀', at(3)?.hollow === true && at(3)?.posts[0]?.post.id === 'e');
ok('그래프 앞은 수만 센다 · 올린 날 모름은 따로 센다', m.outOfRange === 1 && m.undated === 1);
ok('endWeek 뒤 · 잘못 적은 주소는 버린다', !m.pins.some((p) => p.posts.some((q) => q.post.id === 'h' || q.post.id === 'i')));
ok('번호는 왼쪽부터 1, 2, 3…', m.pins.map((p) => p.n).join() === '1,2,3,4,5' && m.pins.map((p) => p.x).join() === '-0.5,0.5,1,2,3');
ok('endWeek가 없으면 마지막 칸 뒤 틈', executionMarks([post('h', '2026-10-28')], slots, weeks).pins[0]?.x === 3.5);
const month = executionMarks(posts, slots.slice(0, 1), weeks, '2026-W40');
ok('월간 — 그 달 마지막 주차(endWeek) 뒤에 올린 글은 그리지 않는다', month.pins.map((p) => p.posts.map((q) => q.post.id).join()).join('|') === 'a|k,b,f');

// 측정한 주만 늘어놓은 막대(AEO 퍼포먼스) — 측정하지 않은 주에 올린 글은 다음 막대 왼쪽
const bars = [
  { weekOf: '2026-W40', measured: true },
  { weekOf: '2026-W42', measured: true },
  { weekOf: '2026-W43', measured: true },
];
const mb = executionMarks(posts, bars, weeks);
ok('막대에 없는 주(W41)는 다음 막대(W42) 왼쪽 틈 — W40 뒤에 올린 글과 합친다', mb.pins.find((p) => p.x === 0.5)?.posts.map((q) => q.post.id).join() === 'k,b,f,c');
const per = executionsPerSlot(mb, bars);
ok(
  '측정 행별 편수 — 직전 측정과 이 측정 사이에 올린 글, 측정하던 주는 전후 불명',
  per.get('2026-W40')?.count === 1 && per.get('2026-W42')?.count === 4 && per.get('2026-W42')?.unsure === 1 && per.get('2026-W43')?.unsure === 1,
);
ok('마지막 측정 뒤에 올린 글은 어느 행에도 넣지 않는다', [...per.values()].reduce((n, r) => n + r.count + r.unsure, 0) === 7 && mb.pins.some((p) => p.x === 2.5));

// 보고서 한 문장
ok(
  '0인 판단은 빼고 적는다',
  executionSummaryLine([{ tier: 'repeated' }, { tier: 'none' }, { tier: 'none' }], 'W42') === 'W42까지 기록한 집행 글 3편: 여러 주 인용 1편 · 인용 없음 2편.',
);
ok('기록이 없으면 문장이 없다(「집행 0편」이라고 단정하지 않는다)', executionSummaryLine([], 'W42') === null);
ok('인과 표현을 쓰지 않는다', !/덕분|때문|효과|올랐/.test(executionSummaryLine([{ tier: 'repeated' }, { tier: 'once' }, { tier: 'waiting' }], 'W42') ?? ''));

// 점수 추이 그래프 — 핀이 없으면 전과 똑같고, 핀이 있어도 조건 변경 표시는 그대로
const card = (weekOf: string, current: number, extra: Partial<WeeklyScorecard> = {}) =>
  ({ weekOf, aeoScore: { current, ciLow: current - 3, ciHigh: current + 3 }, enginesUsed: ['gemini'], questionBankVersion: 'v4', ...extra }) as unknown as WeeklyScorecard;
const history = [card('2026-W40', 10), card('2026-W42', 12, { questionBankVersion: 'v5' }), card('2026-W43', 14, { questionBankVersion: 'v5' })];
const draw = (executions?: Parameters<typeof ScoreTrendChart>[0]['executions']) =>
  renderToStaticMarkup(React.createElement(ScoreTrendChart, { history, endWeek: '2026-W43', ...(executions ? { executions } : {}) }));
const count = (html: string, needle: string) => html.split(needle).length - 1;
const plain = draw();
ok('핀 줄이 없으면 executions를 줘도 마크업이 같다(기록 0건)', draw({ posts: [], weeks }) === plain);
const pinned = draw({ posts, weeks });
ok('핀 수만큼 st-exec 선을 그린다', count(pinned, 'class="st-exec"') === 5 && count(plain, 'st-exec') === 0);
ok('조건 변경 점선 · 마름모는 핀이 있어도 그대로', count(pinned, 'class="st-break"') === count(plain, 'class="st-break"') && count(plain, 'class="st-break"') === 1);
ok('핀이 있을 때만 위쪽을 18px 늘린다', plain.includes('height="190"') && pinned.includes('height="208"'));
ok('범례 — 4개까지 적고 나머지는 「외 n편」, 범위 밖 · 날짜 모름 수', /외 1편/.test(pinned) && /그래프 범위 밖 1편/.test(pinned) && /올린 날 모름 1편/.test(pinned));
ok('읽기 도구 요약에 올린 글 수를 붙인다', /올린 글 7편 표시/.test(pinned));

// 개선제안 — 이미 집행한 등재 항목은 다시 권하지 않는다
const question = (questionId: string, containsBrandName: boolean) =>
  ({ questionId, text: containsBrandName ? '가상브랜드 어때?' : '군산 숙소 추천해 줘', category: containsBrandName ? 'brand-direct' : 'category-agnostic', containsBrandName }) as QuestionSpec;
const questions = [question('v2-001', false), question('v2-002', true)];
const cite = (raw: string, supports: boolean) => ({ raw, domain: null, ownerType: 'third-party-authority' as const, supportsBrandMention: supports });
const analysis = (questionId: string, citations: ReturnType<typeof cite>[]) =>
  ({
    questionId,
    engine: 'gemini',
    callIndex: 0,
    mentioned: false,
    mentionSentences: [],
    competitorMentions: [],
    shareOfMention: 0,
    citations,
    topRecommendation: null,
    brandRank: null,
    factualityClaims: [],
    factualitySupported: 0,
    factualityContradicted: 0,
    brandOwnedCitation: false,
    clarifying: false,
  }) as unknown as QuestionRepeatAnalysis;
// 네이버 블로그는 지분 자리(충족 없음) — 우리 글(me/1)이 이번 주 이름 없는 질문에서 인용됐다.
const analyses = [
  analysis('v2-001', [cite('https://namu.wiki/w/가상', false), cite('https://blog.naver.com/me/1', true), cite('https://blog.naver.com/b/2', false)]),
  analysis('v2-002', [cite('https://namu.wiki/w/가상', true)]),
];
const citations = analyzeCitationSources(analyses);
const wiki = computeGapActions(analyses as unknown as ClientAnalysis[], questions, citations, {}).actions.find((a) => a.id === 'listing:namu.wiki')!;
const repCard = { weekOf: '2026-W42', brandName: '가상브랜드', mentionRate: 0, aeoScore: { current: 5, ciLow: 0, ciHigh: 10 }, avgRecommendationRank: null, rankedResponses: 0, brandOwnedCitationRate: 0 } as unknown as WeeklyScorecard;
const evidence = (extra: Partial<Parameters<typeof buildRecommendationEvidence>[0]> = {}) =>
  buildRecommendationEvidence({ card: repCard, analyses: analyses as unknown as ClientAnalysis[], questions, citations, site: null, ...extra }).citation?.blocks ?? [];
const recommended = (blocks: ReturnType<typeof evidence>) => blocks[0]?.heading.startsWith('AI가 인용했지만') === true && blocks[0].items.some((i) => i.text.startsWith(wiki.title));
const executedBlock = (blocks: ReturnType<typeof evidence>) => blocks.find((b) => b.heading.startsWith('이미 집행한 출처'));
ok('기록이 없으면 전과 같이 권한다', recommended(evidence()) && !executedBlock(evidence()));
const wikiUrl = 'https://namu.wiki/w/가상브랜드';
const wikiPost = post('w', '2026-10-12', { url: wikiUrl, key: trackingKey(wikiUrl) ?? wikiUrl, articleId: 'listing:namu.wiki', targetActionId: 'listing:namu.wiki', via: 'direct' });
const withPost = evidence({ posts: [wikiPost] });
// 상용화 UI 3차(U5): 고객 종이에 실리는 문장(detail)과 운영자 메모(opsNote — 화면에서만)를 가른다. 같은 사실을 두 칸에 나눠 확인한다.
ok(
  '올린 주소를 적은 항목은 다시 권하지 않고 「10/12 올림 · 아직 인용 전」으로 따로 적는다',
  !recommended(withPost) && executedBlock(withPost)?.items[0]?.detail === '10/12 올림 · 아직 인용 전' && !executedBlock(withPost)?.items[0]?.opsNote,
);
const marked = evidence({ states: { 'listing:namu.wiki': { status: 'done', updatedAt: '2026-10-10T00:00:00Z', markedWeek: '2026-W41' } } });
ok('주소 없이 「집행함」만 눌렀으면 그렇게 밝힌다', /^집행 표시\(2026년 41주차\) · 올린 주소 기록 없음$/.test(executedBlock(marked)?.items[0]?.detail ?? ''));
ok('보고 주차 뒤에 올린 글 · 뒤에 표시한 집행은 보지 않는다(지난 주차 보고서)', recommended(evidence({ posts: [{ ...wikiPost, publishedOn: '2026-10-30' }] })) && recommended(evidence({ states: { 'listing:namu.wiki': { status: 'done', updatedAt: '2026-11-01T00:00:00Z', markedWeek: '2026-W44' } } })));
ok('잘못 적어 뺀 주소는 집행으로 보지 않는다', recommended(evidence({ posts: [{ ...wikiPost, removedAt: '2026-10-13T00:00:00Z', removedReason: 'mistake' }] })));

// ── 검토 지적 회귀 ──────────────────────────────────────────────────────────
// 같은 주소를 자사 블로그 줄과 채널 줄에 함께 적었다 — 한 편이다
const own = post('o', '2026-10-03', { url: 'https://fake.tistory.com/5', key: 'fake.tistory.com/5', articleId: 'content:a', targetActionId: 'content:a', via: 'own' });
const chan = { ...own, id: 'o2', targetActionId: 'listing:platform:tistory.com', via: 'channel' as const };
const legacyDup = { ...own, id: 'legacy-o', publishedOn: null, publishedOnSource: 'legacy' as const };
const dup = executionMarks([own, chan, legacyDup], bars, weeks);
ok(
  '같은 주소 · 같은 날을 여러 줄에 적으면 한 편 — 범례에 올린 곳을 모은다, 날짜 있는 줄이 있으면 날짜 없는 옛 줄은 뺀다',
  dup.pins.length === 1 && dup.pins[0]!.posts.length === 1 && dup.pins[0]!.posts[0]!.places.length === 2 && dup.undated === 0 && executionsPerSlot(dup, bars).get('2026-W42')?.count === 1,
);
// 한 줄에서만 「글을 내렸어요」 — 그 주소는 내려갔다(내린 줄이 대표). 내린 뒤 같은 주소를 다시 적었으면 다시 올린 것.
const ownDown = { ...own, removedAt: '2026-10-08T00:00:00Z', removedReason: 'taken-down' as const };
ok(
  '같은 주소 · 같은 날 두 줄(둘 다 내리기 전에 적음) 가운데 한 줄만 내렸으면 내린 줄이 대표',
  distinctPostings([{ ...chan, recordedAt: '2026-10-03T00:00:00Z' }, { ...ownDown, recordedAt: '2026-10-03T00:00:00Z' }], (p) => p)[0]?.post.id === 'o',
);
ok(
  '내린 뒤 같은 주소를 다시 적은 줄이 있으면 그 줄이 대표',
  distinctPostings([{ ...chan, recordedAt: '2026-10-09T00:00:00Z' }, ownDown], (p) => p)[0]?.post.id === 'o2',
);
// 보고 주차로 먼저 자르고 묶는다 — 그 뒤에 적은 같은 주소 줄이 옛 줄을 지우지 않는다(보고서 표와 같은 순서)
const legacyRow = { ...own, id: 'lg', publishedOn: null, publishedOnSource: 'legacy' as const, recordedAt: '2026-09-20T00:00:00Z' };
ok('보고 주차 뒤의 같은 주소 줄 때문에 옛 줄이 그래프 「올린 날 모름」에서 빠지지 않는다', executionMarks([legacyRow, { ...chan, publishedOn: '2026-10-28' }], slots, weeks, '2026-W43').undated === 1);
ok('올렸다 내리고 다시 올린 같은 주소는 날이 달라 두 편', executionMarks([{ ...own, removedAt: '2026-10-04T00:00:00Z', removedReason: 'taken-down' }, { ...chan, publishedOn: '2026-10-20' }], bars, weeks).pins.reduce((n, p) => n + p.posts.length, 0) === 2);

// 측정 주차 이름과 측정한 날의 주가 어긋남(일요일 밤 · CI 시간대) — 측정 기간 안에 올렸으면 그 칸 위 속 빈 핀
const shifted = executionMarks(
  [post('s', '2026-10-19')],
  [{ weekOf: '2026-W42', measured: true }, { weekOf: '2026-W43', measured: true }],
  [{ weekOf: '2026-W42', window: { first: '2026-10-19', last: '2026-10-19' } }, { weekOf: '2026-W43', window: { first: '2026-10-22', last: '2026-10-22' } }],
);
ok('측정 기간이 다음 주 날짜여도 그 측정 중에 올린 글은 전후 불명', shifted.pins[0]?.x === 0 && shifted.pins[0]?.hollow === true);

// 첫 막대 바로 앞 측정(prev) — 그 측정 뒤에 올린 글은 첫 막대 왼쪽, 그 전 · 측정 중은 범위 밖
const prevWeek = { weekOf: '2026-W38', window: { first: '2026-09-17', last: '2026-09-17' } };
const early = executionMarks([post('p1', '2026-09-20'), post('p2', '2026-09-25'), post('p3', '2026-09-10'), post('p4', '2026-09-17')], bars, weeks, undefined, prevWeek);
ok('prev 측정 뒤 · 첫 막대 전에 올린 글은 첫 막대 행에 든다', early.pins.find((p) => p.x === -0.5)?.posts.map((q) => q.post.id).join() === 'p1,p2' && early.outOfRange === 2 && executionsPerSlot(early, bars).get('2026-W40')?.count === 2);

// 날짜 없는 기록도 endWeek로 자른다(기록한 날)
ok('날짜 없는 기록은 기록한 날로 자른다', executionMarks([post('u', null, { recordedAt: '2026-10-28T00:00:00Z' })], slots, weeks, '2026-W43').undated === 0);

// 올린 뒤 측정 칸 — 내린 주 뒤는 넣지 않고(판정 없는 주도), 판정 있는 주는 칸의 전후를 따른다
const cellOf = (timing: 'after' | 'during' | 'before', extra = {}) => ({ timing, afterRemoval: false, tally: null, variantCited: 0, ...extra });
const aw = afterWeeksOf(
  [cellOf('after'), null, null, cellOf('after', { afterRemoval: true })],
  [{ weekOf: '2026-W40' }, { weekOf: '2026-W41' }, { weekOf: '2026-W42' }, { weekOf: '2026-W43' }],
  '2026-09-29',
  '2026-10-06',
);
ok('내린 주(W41)의 판정 없는 칸은 확인 불가로 두고, 그 뒤 주는 넣지 않는다', aw.map((a) => a.weekOf).join() === '2026-W40,2026-W41');
ok('측정 주차 이름이 올린 주보다 앞이어도 측정 중이면 넣는다', afterWeeksOf([cellOf('during')], [{ weekOf: '2026-W42' }], '2026-10-19').length === 1);

// 그래프 — 왼쪽 끝 핀은 세로축 눈금을 비키고, 속 빈 핀 선은 점수 글자 위에서 멈추고, 내린 글은 범례에 내린 날
ok('왼쪽 끝 핀이 있으면 세로축 눈금을 왼쪽으로 옮긴다(없으면 그대로)', pinned.includes('class="st-axis" x="24"') && plain.includes('class="st-axis" x="36"'));
ok('속 빈 핀의 선은 바닥까지 긋지 않는다', (pinned.match(/class="st-exec"[^>]*y2="158"/g) ?? []).length === 3);
ok('범례에 내린 날을 적는다(그래프 끝 주 안일 때)', /10\/20 내림/.test(pinned));
ok('요약 문장의 측정 대기는 판단 칸과 같은 말', /측정 대기 1편/.test(executionSummaryLine([{ tier: 'waiting' }], 'W42') ?? ''));

// 개선제안 — 한 가지 달력 시계, 내린 글, 지분 자리
const nextWeekPost = { ...wikiPost, publishedOn: '2026-10-19', recordedAt: '2026-10-19T01:00:00Z' };
const nextWeekState = { 'listing:namu.wiki': { status: 'done' as const, updatedAt: '2026-10-19T01:00:00Z', markedWeek: '2026-W42' } };
const mixed = evidence({ posts: [nextWeekPost], states: nextWeekState });
ok('다음 주에 「올렸어요」(보던 주차는 이번 주)면 이번 주 보고서는 그대로 권한다', recommended(mixed) && !JSON.stringify(mixed).includes('올린 주소 기록 없음'));
// 옛 기록(v0.4.3 전 상태 파일의 주소)의 recordedAt은 상태를 고칠 때마다 바뀐다 — 그것으로 자르면 오래전 집행이 사라져 다시 권해진다.
ok(
  '옛 기록은 상태를 나중에 고쳐 기록 시각이 보고 주차 뒤로 밀려도 집행으로 본다',
  !recommended(evidence({ posts: [{ ...wikiPost, publishedOn: null, publishedOnSource: 'legacy', recordedAt: '2026-10-28T00:00:00Z' }] })),
);
ok(
  '원장에 날짜 없이 적은 기록은 기록한 날이 보고 주차 뒤면 집행으로 보지 않는다',
  recommended(evidence({ posts: [{ ...wikiPost, publishedOn: null, publishedOnSource: 'user', recordedAt: '2026-10-28T00:00:00Z' }] })),
);
const downed = evidence({
  posts: [{ ...wikiPost, publishedOn: '2026-10-05', removedAt: '2026-10-08T00:00:00Z', removedReason: 'taken-down' }],
  states: { 'listing:namu.wiki': { status: 'done', updatedAt: '2026-10-05T00:00:00Z' } },
});
// 사용자 결정(10-19): 글을 모두 내린 항목 · 블로그 플랫폼은 다시 권하고, 집행했다는 사실을 머리말로 단다.
const wikiDetail = (blocks: ReturnType<typeof evidence>) => blocks[0]?.items.find((i) => i.text.startsWith(wiki.title))?.detail ?? '';
ok(
  '글을 모두 내린 집행함 항목은 다시 권하고 「올린 글 10/8 내림 — 다시 올릴 곳」을 단다',
  recommended(downed) && !executedBlock(downed) && wikiDetail(downed).startsWith('[올린 글 10/8 내림 — 다시 올릴 곳] '),
);
const downedOnly = evidence({ posts: [{ ...wikiPost, publishedOn: '2026-10-05', removedAt: '2026-10-08T00:00:00Z', removedReason: 'taken-down' }] });
ok('집행함 표시 없이 글만 내렸어도 같은 머리말', recommended(downedOnly) && wikiDetail(downedOnly).startsWith('[올린 글 10/8 내림 — 다시 올릴 곳] '));
const naverUrl = 'https://blog.naver.com/me/1';
const naver = evidence({
  posts: [post('n', '2026-10-01', { url: naverUrl, key: trackingKey(naverUrl) ?? naverUrl, articleId: 'content:n', targetActionId: 'listing:platform:blog.naver.com', via: 'channel' })],
});
const naverItem = naver[0]?.items.find((i) => i.text.includes('네이버'));
const naverNote = naverItem?.detail ?? '';
ok(
  '블로그 플랫폼은 한 편 올려도 계속 권하고 집행 사실을 머리말로, 지분은 운영 메모로 단다(「충족 전」이라 쓰지 않는다)',
  !executedBlock(naver) &&
    /^\[10\/1 올림 · 이번 주 인용됨 — 글을 더 올릴수록 인용 비중이 오릅니다\] /.test(naverNote) &&
    /^지분 \d+\/\d+ · 완료 기준: /.test(naverItem?.opsNote ?? '') &&
    !`${naverNote} ${naverItem?.opsNote ?? ''}`.includes('충족 전'),
);

// 같은 주 회차 합침(citedPostIds) — 마지막 저장 측정에는 없고 다른 회차에서만 인용된 글은 「인용됨」으로 적되 기준을 밝힌다.
// 주지 않으면 전과 같다(위 「인용 대기」 검사).
const otherRun = evidence({ posts: [wikiPost], citedPostIds: new Set(['w']) });
ok(
  '다른 회차에서만 인용된 집행 글 — 고객에게는 「인용됨」, 운영 메모에 「다른 회차에서만 인용(마지막 저장 측정에서는 없음)」',
  executedBlock(otherRun)?.items[0]?.detail === '10/12 올림 · 이번 주 인용됨' &&
    executedBlock(otherRun)?.items[0]?.opsNote === '같은 주 다른 회차에서만 인용(마지막 저장 측정에서는 없음) · 아직 충족 전',
);
ok('회차 합침 기록에 없는 글은 그대로 「아직 인용 전」', executedBlock(evidence({ posts: [wikiPost], citedPostIds: new Set(['x']) }))?.items[0]?.detail === '10/12 올림 · 아직 인용 전');
const naverOther = 'https://blog.naver.com/me/9';
const platformOther = evidence({
  posts: [post('n9', '2026-10-01', { url: naverOther, key: trackingKey(naverOther) ?? naverOther, articleId: 'content:n', targetActionId: 'listing:platform:blog.naver.com', via: 'channel' })],
  citedPostIds: new Set(['n9']),
});
const platformItem = platformOther[0]?.items.find((i) => i.text.includes('네이버'));
ok(
  '블로그 플랫폼 — 다른 회차에서만 인용됐으면 지분이 마지막 측정 기준임을 운영 메모에 밝힌다',
  (platformItem?.detail ?? '').startsWith('[10/1 올림 · 이번 주 인용됨 — ') &&
    /^같은 주 다른 회차에서만 인용\(마지막 저장 측정에서는 없음\) · 지분 \d+\/\d+\(마지막 측정 기준\) · 완료 기준: /.test(platformItem?.opsNote ?? ''),
);
const platformSame = evidence({
  posts: [post('n', '2026-10-01', { url: naverUrl, key: trackingKey(naverUrl) ?? naverUrl, articleId: 'content:n', targetActionId: 'listing:platform:blog.naver.com', via: 'channel' })],
  citedPostIds: new Set(['n']),
});
ok(
  '마지막 측정에서도 인용됐으면 기준을 따로 적지 않는다',
  /^지분 \d+\/\d+ · 완료 기준: /.test(platformSame[0]?.items.find((i) => i.text.includes('네이버'))?.opsNote ?? ''),
);
// 고객 종이에 실리는 문장에는 운영 표시(지분 n/m · 충족 전 · 완료 기준 · 집행함)가 없다 — 모두 운영 메모로 갔다. 출처 설명의 「지분」 같은
// 보통 말(「우리 블로그를 운영하면 그 지분이 바로 올라갑니다」)은 고객 문장이라 남는다.
ok(
  '고객 문장(detail)에는 지분 n/m · 충족 전 · 완료 기준 · 집행함이 없다',
  [withPost, marked, naver, otherRun, platformOther, platformSame, downed]
    .flatMap((blocks) => blocks.flatMap((b) => b.items.map((i) => i.detail ?? '')))
    .every((d) => !/지분 \d+\/\d+|충족 전|완료 기준|집행함/.test(d)),
);

// 글을 내렸는데 내리기 전 같은 주 다른 회차에서 인용됐다 — 이미 내린 글은 다음 측정이 인용할 수 없으니 그대로 다시 권한다.
const downedOther = evidence({
  posts: [{ ...wikiPost, publishedOn: '2026-10-05', removedAt: '2026-10-08T00:00:00Z', removedReason: 'taken-down' }],
  states: { 'listing:namu.wiki': { status: 'done', updatedAt: '2026-10-05T00:00:00Z' } },
  citedPostIds: new Set(['w']),
});
ok('내린 글이 다른 회차에서 인용됐어도 「다시 올릴 곳」으로 다시 권한다', recommended(downedOther) && wikiDetail(downedOther).startsWith('[올린 글 10/8 내림 — 다시 올릴 곳] '));

// 같은 주에 여러 번 잰 주 — 핀도 칸(foldCell)과 같은 규칙: 올린 뒤 회차가 하나라도 있으면 올린 뒤(왼쪽 틈), 없고 측정하던 회차가 있으면
// 전후 불명. 그 주 카드 회차가 올리기 전이어도(뒤 회차는 카드를 덮지 않음) 칸과 같은 쪽에 선다.
const runOf = (first: string, last = first) =>
  ({ runId: first, kind: 'run', at: `${last}T05:00:00Z`, window: { first, last }, weekCard: 'saved', isWeekCard: false, selfOnly: true, engines: [], partialEngines: [], missingEngines: [], bankVersion: null }) as never;
const multi = (cardWindow: string, runs: string[]) => [{ weekOf: '2026-W44', window: { first: cardWindow, last: cardWindow }, runs: runs.map((d) => runOf(d)) }];
const oneSlot = [{ weekOf: '2026-W44', measured: true }];
const between = executionMarks([post('m1', '2026-10-28')], oneSlot, multi('2026-10-26', ['2026-10-26', '2026-10-30']));
ok('회차 사이에 올림(카드는 앞 회차) — 핀은 올린 뒤(왼쪽 틈) · 칸과 같은 쪽', between.pins[0]?.x === -0.5 && between.pins[0]?.hollow === false);
const sameDayRun = executionMarks([post('m2', '2026-10-30')], oneSlot, multi('2026-10-30', ['2026-10-26', '2026-10-30']));
ok('측정하던 날 올리고 그 뒤 회차가 없으면 전후 불명(속 빈 핀)', sameDayRun.pins[0]?.x === 0 && sameDayRun.pins[0]?.hollow === true);
const afterAll = executionMarks([post('m3', '2026-10-31')], oneSlot, multi('2026-10-30', ['2026-10-26', '2026-10-30']));
ok('모든 회차 뒤에 올림 — 오른쪽 틈', afterAll.pins[0]?.x === 0.5);

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
