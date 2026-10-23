/**
 * 같은 날 올린 글의 측정 전후를 「올렸어요」를 누른 시각으로 가르는지 확인한다(src/lib/publishedUrl.ts timingOf · postedAtOf ·
 * measuredWindow, server/publishedHistory.ts sampleView, src/lib/gapActions.ts, 주소 칸). 화면 · AI는 부르지 않는다.
 *
 * 왜: 올린 날은 날짜만 남겨서, 측정하던 날 올린 글은 늘 「전후 불명」이었다(실측 10-23 군산각 티스토리 /4 — 13:41 측정, 14:14 게시,
 * 14:15 기록). 올린 시각은 누른 시각보다 늦을 수 없어 「측정 시작보다 앞에 눌렀으면 올린 뒤」는 늘 맞고, 「답을 다 모은 뒤에 눌렀으면
 * 올리기 전」은 올린 직후에 눌렀다는 전제다. 측정 시작(하한)은 회차 기록에만 있다 — 판정 시각은 답을 모은 뒤라 하한이 될 수 없다.
 *
 *   npx tsx scripts/verify-posted-time.ts
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PublishedUrlEditor from '../src/components/PublishedUrlEditor';
import type { PublishedPost } from '../src/lib/api';
import { computeGapActions } from '../src/lib/gapActions';
import { daysAfterPublish, measuredWindow, postedAtIndex, postedAtOf, timingOf } from '../src/lib/publishedUrl';
import { weekFileTimingOf, weekTimingOf } from '../src/lib/publishTracking';
import type { QuestionRepeatAnalysis as ClientAnalysis, QuestionSpec } from '../src/lib/types';
import type { WeeklyScorecard } from '../src/prompts/b8-report';
import { analyzeCitationSources } from '../server/citationSources';
import { sampleView } from '../server/publishedHistory';
import type { QuestionRepeatAnalysis } from '../server/types';

// 화면 파일은 jsx 자동 변환을 전제로 하는데 tsx는 고전 변환으로 읽는다 — React를 전역에 둔다(verify-execution-marks.ts와 같다).
Object.assign(globalThis, { React });

const checks: [string, boolean][] = [];
const ok = (label: string, cond: boolean) => checks.push([label, cond]);

const DAY = '2026-10-23';
const W = '2026-W43';
const win = (extra: { startAt?: string; endAt?: string } = {}) => ({ first: DAY, last: DAY, ...extra });

// 1) timingOf — 같은 날만 시각으로, 하한(startAt)이 있어야 「올린 뒤」
ok('측정 시작보다 앞에 눌렀으면 올린 뒤', timingOf(DAY, win({ startAt: '2026-10-23T05:00:00Z', endAt: '2026-10-23T05:30:00Z' }), W, '2026-10-23T04:00:00Z') === 'after');
ok('답을 다 모은 뒤에 눌렀으면 올리기 전', timingOf(DAY, win({ startAt: '2026-10-23T05:00:00Z', endAt: '2026-10-23T05:30:00Z' }), W, '2026-10-23T06:00:00Z') === 'before');
ok('측정 도중에 눌렀으면 전후 불명', timingOf(DAY, win({ startAt: '2026-10-23T05:00:00Z', endAt: '2026-10-23T05:30:00Z' }), W, '2026-10-23T05:10:00Z') === 'during');
ok('누른 시각이 없으면 전후 불명(예전과 같다)', timingOf(DAY, win({ startAt: '2026-10-23T05:00:00Z', endAt: '2026-10-23T05:30:00Z' }), W) === 'during');
ok('측정 시작을 모르면(그 주 파일) 앞에 눌러도 올린 뒤로 단정하지 않는다', timingOf(DAY, win({ endAt: '2026-10-23T05:30:00Z' }), W, '2026-10-23T04:00:00Z') === 'during');
ok('측정 시작을 몰라도 다 모은 뒤에 눌렀으면 올리기 전', timingOf(DAY, win({ endAt: '2026-10-23T05:30:00Z' }), W, '2026-10-23T06:00:00Z') === 'before');
ok('날짜가 다르면 시각을 보지 않는다', timingOf('2026-10-22', win({ startAt: '2026-10-23T05:00:00Z' }), W, '2026-10-22T23:00:00Z') === 'after' && timingOf('2026-10-24', win({ endAt: '2026-10-23T05:30:00Z' }), W, '2026-10-24T00:10:00Z') === 'before');
ok('같은 날 올린 뒤 측정은 D+0', daysAfterPublish(DAY, win({ startAt: '2026-10-23T05:00:00Z' }), W, '2026-10-23T04:00:00Z') === 0);

// 2) postedAtOf — 기본값(오늘)으로 그날 누른 기록만
const post = (extra: Partial<PublishedPost> = {}): PublishedPost => ({
  id: 'p4', url: 'https://fake.tistory.com/4', key: 'fake.tistory.com/4', publishedOn: DAY, publishedOnSource: 'default-today', recordedAt: '2026-10-23T05:15:35Z',
  articleId: 'content:category-agnostic', targetActionId: 'content:category-agnostic', via: 'own', ...extra,
});
ok('기본값으로 그날 누른 기록은 누른 시각', postedAtOf(post()) === '2026-10-23T05:15:35Z');
ok('날짜 칸에서 오늘을 골라도 누른 시각(실측 /4)', postedAtOf(post({ publishedOnSource: 'user' })) === '2026-10-23T05:15:35Z');
ok('다른 날을 고른 기록은 시각을 쓰지 않는다', postedAtOf(post({ publishedOn: '2026-10-22', publishedOnSource: 'user' })) === null);
ok('옛 기록(날짜 모름)은 시각을 쓰지 않는다', postedAtOf(post({ publishedOn: null, publishedOnSource: 'legacy' })) === null);
ok('measuredWindow는 판정 시작의 마지막을 endAt으로', JSON.stringify(measuredWindow([
  { questionId: 'a', timing: { startedAt: '2026-10-23T04:41:00Z' } },
  { questionId: 'b', timing: { startedAt: '2026-10-23T04:43:30Z' } },
])) === JSON.stringify({ first: DAY, last: DAY, endAt: '2026-10-23T04:43:30Z' }));

// 3) 서버 칸 — 회차 기록의 측정 시작이 있을 때만 「올린 뒤」
const analysis = (at: string) =>
  ({
    questionId: 'a1', engine: 'gemini', callIndex: 0, mentioned: false, mentionSentences: [], competitorMentions: [], shareOfMention: 0,
    citations: [], topRecommendation: null, brandRank: null, factualityClaims: [], factualitySupported: 0, factualityContradicted: 0,
    brandOwnedCitation: false, clarifying: false, timing: { startedAt: at, wallMs: 1, judgeMs: { mention: 1, citation: null, rank: 1, fact: null } },
  }) as unknown as QuestionRepeatAnalysis;
const card = { weekOf: W, questionBankVersion: 'v6' } as unknown as WeeklyScorecard;
const noBank = { getQuestionBank: async () => null };
const cellOf = async (analyses: QuestionRepeatAnalysis[], shown: PublishedPost, startAt?: string) =>
  (await sampleView(noBank, { tenantId: 't' }, [shown], { weekOf: W, scorecard: card, analyses, ...(startAt ? { startAt } : {}) })).cells[0]!;
// 실측과 같은 모양: 13:41 측정(판정), 14:15 기록 → 올리기 전
ok('서버 칸 — 측정이 기록보다 앞이면 올리기 전(군산각 /4)', (await cellOf([analysis('2026-10-23T04:41:00Z')], post())).timing === 'before');
const laterRun = [analysis('2026-10-23T06:30:00Z')];
ok('서버 칸 — 회차 시작이 기록보다 뒤면 올린 뒤 · D+0', await (async () => {
  const c = await cellOf(laterRun, post(), '2026-10-23T06:00:00Z');
  return c.timing === 'after' && c.daysAfterPublish === 0;
})());
ok('서버 칸 — 회차 시작을 모르면(그 주 파일) 전후 불명', (await cellOf(laterRun, post())).timing === 'during');
ok('서버 칸 — 다음 날 적으며 날짜를 고른 기록은 전후 불명', (await cellOf([analysis('2026-10-23T04:41:00Z')], post({ publishedOnSource: 'user', recordedAt: '2026-10-24T01:00:00Z' }))).timing === 'during');

// 4) 그래프 핀 · 주 칸 — 회차가 여럿이면 회차마다 시각으로
const weekWithRuns = {
  weekOf: W,
  window: win({ endAt: '2026-10-23T04:43:00Z' }),
  runs: [
    { runId: 'r1', at: '2026-10-23T04:45:00Z', window: win({ startAt: '2026-10-23T04:20:00Z', endAt: '2026-10-23T04:43:00Z' }) },
    { runId: 'r2', at: '2026-10-23T07:30:00Z', window: win({ startAt: '2026-10-23T07:00:00Z', endAt: '2026-10-23T07:25:00Z' }) },
  ],
} as unknown as Parameters<typeof weekTimingOf>[1];
ok('주 칸 — 기록 뒤에 시작한 회차가 있으면 올린 뒤', weekTimingOf(DAY, weekWithRuns, '2026-10-23T05:15:35Z') === 'after');
ok('주 칸 — 시각이 없으면 예전처럼 전후 불명', weekTimingOf(DAY, weekWithRuns) === 'during');

// 5) 콘텐츠 생성의 이번 주 결과와 주소 칸 문구
const questions = [{ questionId: 'a1', text: '군산 여행 정보 사이트 추천해줘', category: 'category-agnostic', containsBrandName: false }] as QuestionSpec[];
const week = [analysis('2026-10-23T04:41:00Z')];
const plan = computeGapActions(week as unknown as ClientAnalysis[], questions, analyzeCitationSources(week), {}, [post()], W);
const hit = plan.actions.find((a) => a.id === 'content:category-agnostic')?.publishedHits?.[0];
ok('이번 주 결과 — 올리기 전 측정', hit?.timing === 'before');
const noop = () => {};
const html = renderToStaticMarkup(
  React.createElement(PublishedUrlEditor, {
    hits: hit ? [hit] : [], removed: [], weekOf: W, busy: false, onRecord: async () => null, onRemove: noop, onRestore: noop, onSetDate: noop,
  }),
);
ok('주소 칸 — 「올리기 전 측정」과 기록한 시각을 밝힌다(버튼 이름은 부르지 않는다)', html.includes('올리기 전 측정') && html.includes('기록한 시각(14:15)보다 앞에 끝나'));
ok('주소 칸 — 올린 날 옆에 기록 시각', html.includes('10/23 올림 · 14:15 기록'));
ok('주소 칸 — 올린 직후에 누르라는 안내', html.includes('오늘 올린 글은 올린 직후에 누르세요'));

// 6) 그 주 파일 결과가 전후 불명이면, 이력(그 주 카드 회차 — 측정 시작 포함)으로 다시 잰다
const laterWeek = [analysis('2026-10-23T13:19:30Z')];
const latePlan = computeGapActions(laterWeek as unknown as ClientAnalysis[], questions, analyzeCitationSources(laterWeek), {}, [post()], W);
const lateHit = latePlan.actions.find((a) => a.id === 'content:category-agnostic')?.publishedHits?.[0];
ok('그 주 파일만으로는 저녁 회차도 전후 불명(측정 시작을 모른다)', lateHit?.timing === 'during');
const history = {
  weeks: [{ weekOf: W, analysed: true, window: win({ startAt: '2026-10-23T13:18:45Z', endAt: '2026-10-23T13:19:30Z' }) }],
  posts: [{ post: post(), cells: [] }],
} as unknown as Parameters<typeof weekFileTimingOf>[0];
const inWeek = weekFileTimingOf(history, W, latePlan.weekWindow);
ok('이력으로 다시 재면 올린 뒤 · D+0', inWeek?.get('p4')?.timing === 'after' && inWeek.get('p4')?.daysAfterPublish === 0);
ok('이력에 그 주가 없으면 null', weekFileTimingOf(history, '2026-W44', latePlan.weekWindow) === null);
const lateHtml = renderToStaticMarkup(
  React.createElement(PublishedUrlEditor, {
    hits: lateHit ? [lateHit] : [], removed: [], weekOf: W, busy: false, timingInWeek: inWeek, onRecord: async () => null, onRemove: noop, onRestore: noop, onSetDate: noop,
  }),
);
ok('주소 칸 — 전후 불명 대신 다시 잰 값(올린 지 0일 · 색인 대기)', !lateHtml.includes('전후 불명') && lateHtml.includes('색인 대기'));

// 7) 검토 회귀 — 같은 글을 두 줄에 적으면 한 편으로, 다른 측정으로는 다시 재지 않는다, 날짜 문구, 같은 날 내렸다 다시 올림
ok('이력의 그 주가 다른 측정이면(화면이 낡음) 다시 재지 않는다', weekFileTimingOf(history, W, { first: DAY, last: DAY, endAt: '2026-10-23T04:41:00Z' }) === null);
const own = post({ id: 'own', recordedAt: '2026-10-23T05:00:00Z' });
const channel = post({ id: 'chan', targetActionId: 'listing:platform:tistory.com', via: 'channel', recordedAt: '2026-10-23T08:00:00Z' });
const pair = postedAtIndex([own, channel]);
ok('같은 글 두 줄 — 가장 이른 기록 시각을 함께 쓴다', pair.get('own') === '2026-10-23T05:00:00Z' && pair.get('chan') === '2026-10-23T05:00:00Z');
const between = await sampleView(noBank, { tenantId: 't' }, [own, channel], { weekOf: W, scorecard: card, analyses: [analysis('2026-10-23T06:30:00Z')], startAt: '2026-10-23T06:00:00Z' });
ok('같은 글 두 줄 — 두 기록 사이 측정이 두 줄 모두 올린 뒤', between.cells.every((c) => c.timing === 'after'));
const firstPost = post({ id: 'a', recordedAt: '2026-10-23T01:00:00Z', removedAt: '2026-10-23T04:00:00Z', removedReason: 'taken-down' });
const repost = post({ id: 'b', recordedAt: '2026-10-23T05:00:00Z' });
ok('같은 날 내렸다 다시 올린 글은 다시 올린 기록의 시각', postedAtIndex([firstPost, repost]).get('b') === '2026-10-23T05:00:00Z');
const prevDay = [analysis('2026-10-22T04:41:00Z')];
const prevPlan = computeGapActions(prevDay as unknown as ClientAnalysis[], questions, analyzeCitationSources(prevDay), {}, [post()], W);
const prevHit = prevPlan.actions.find((a) => a.id === 'content:category-agnostic')?.publishedHits?.[0];
const prevHtml = renderToStaticMarkup(
  React.createElement(PublishedUrlEditor, { hits: prevHit ? [prevHit] : [], removed: [], weekOf: W, busy: false, onRecord: async () => null, onRemove: noop, onRestore: noop, onSetDate: noop }),
);
ok('전날 측정은 날짜 문구(「올린 날보다 앞」) — 기록 시각을 말하지 않는다', prevHit?.timing === 'before' && !prevHit.beforeByTime && prevHtml.includes('올린 날보다 앞이라') && !prevHtml.includes('기록한 시각('));
// 옛 글 A(10-19)를 10-23 14:00에 내리고 B로 14:15에 다시 올렸다 — 13:41 측정이 그 주소를 인용했다(그때는 A가 올라가 있었다).
const citing = { ...analysis('2026-10-23T04:41:00Z'), citations: [{ raw: 'https://fake.tistory.com/4', domain: null, ownerType: 'third-party-authority', supportsBrandMention: false }] } as unknown as QuestionRepeatAnalysis;
const oldA = post({ id: 'A', publishedOn: '2026-10-19', recordedAt: '2026-10-19T01:00:00Z', removedAt: '2026-10-23T05:00:00Z', removedReason: 'taken-down' });
const newB = post({ id: 'B', recordedAt: '2026-10-23T05:15:00Z' });
const reposted = await sampleView(noBank, { tenantId: 't' }, [oldA, newB], { weekOf: W, scorecard: card, analyses: [citing] });
ok('같은 날 내렸다 다시 올림 — 다시 올린 기록에 「올리기 전에 이미 인용」 경고를 붙이지 않는다', reposted.cells[1]!.timing === 'before' && reposted.cells[1]!.earlierPostingLive === true);

let failed = 0;
for (const [label, pass] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${label}`);
  if (!pass) failed += 1;
}
console.log(`\n${checks.length - failed}/${checks.length} 통과`);
if (failed > 0) process.exit(1);
