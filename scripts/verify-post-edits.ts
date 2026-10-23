/**
 * 올린 글을 「고친 날」로 나눠 보는 계산을 확인한다(src/lib/publishedUrl.ts editTimingOf · src/lib/publishTracking.ts summarizeSinceEdit ·
 * src/lib/runTrend.ts · src/lib/gapActions.ts PublishedHit.edit · 주소 칸). 화면 · AI는 부르지 않는다.
 *
 * 왜: 원문이 바뀌어 블로그의 기존 글을 수정하면 주소는 그대로인데 글이 바뀐다. 올린 날만으로 세면 고친 뒤 인용이 옛 글 덕인지 새 글
 * 덕인지 가를 수 없다. 고친 날도 올린 날과 같은 규칙(측정 전 · 측정 중 · 측정 뒤)으로 재야 한다 — 고친 날 당일 측정은 전후 불명이다.
 *
 *   npx tsx scripts/verify-post-edits.ts
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PublishedUrlEditor from '../src/components/PublishedUrlEditor';
import type { HistoryCell, HistoryWeek, PublishedPost, RunHistory, RunPoint, RunPostRow } from '../src/lib/api';
import { computeGapActions, recordOnlyHits } from '../src/lib/gapActions';
import { editTimingOf, timingOf } from '../src/lib/publishedUrl';
import { summarizeSinceEdit, weekEditNote, weekEditOf } from '../src/lib/publishTracking';
import { buildRunTrend } from '../src/lib/runTrend';
import type { QuestionRepeatAnalysis as ClientAnalysis, QuestionSpec } from '../src/lib/types';
import { analyzeCitationSources } from '../server/citationSources';
import type { QuestionRepeatAnalysis } from '../server/types';

// 화면 파일은 jsx 자동 변환을 전제로 하는데 tsx는 고전 변환으로 읽는다 — React를 전역에 둔다(verify-execution-marks.ts와 같다).
Object.assign(globalThis, { React });

const checks: [string, boolean][] = [];
const ok = (label: string, cond: boolean) => checks.push([label, cond]);

// 1) 고친 날의 전후 — 올린 날과 같은 규칙
const day = (d: string) => ({ first: d, last: d });
const at = (edits: string[], window: { first: string; last: string } | null, weekOf = '2026-W43') =>
  editTimingOf(edits.map((editedOn) => ({ editedOn })), (on) => timingOf(on, window, weekOf));
ok('고친 날이 없으면 null', editTimingOf(undefined, () => 'after') === null && at([], day('2026-10-20')) === null);
ok('측정 전에 고쳤으면 고친 뒤(after)', at(['2026-10-18'], day('2026-10-20'))?.timing === 'after');
ok('측정하던 날 고쳤으면 전후 불명(during)', at(['2026-10-20'], day('2026-10-20'))?.timing === 'during');
ok('측정 뒤에 고쳤으면 null(그 측정은 고치기 전 글)', at(['2026-10-22'], day('2026-10-20')) === null);
ok('여러 번 고쳤으면 측정 전 가장 늦은 고친 날', at(['2026-10-15', '2026-10-18', '2026-10-22'], day('2026-10-20'))?.editedOn === '2026-10-18');
ok('측정 시각이 없는 같은 주는 ambiguous', at(['2026-10-21'], null, '2026-W43')?.timing === 'ambiguous');
ok('측정 시각이 없으면 앞 주에 고친 것은 after', at(['2026-10-14'], null, '2026-W43')?.timing === 'after');

// 2) 주 칸 — 회차가 여럿이면 한 회차라도 고친 뒤면 after
const week = (weekOf: string, windows: string[]): Pick<HistoryWeek, 'weekOf' | 'window' | 'runs'> => ({
  weekOf,
  window: day(windows.at(-1)!),
  runs: windows.map((d, i) => ({ runId: `r${i}`, at: `${d}T03:00:00Z`, window: day(d) })) as HistoryWeek['runs'],
});
const edited = { edits: [{ editedOn: '2026-10-21', recordedAt: '2026-10-21T00:00:00Z' }] };
ok('주 칸 — 고치기 전 회차와 고친 뒤 회차가 섞이면 after', weekEditOf(edited, week('2026-W43', ['2026-10-20', '2026-10-23']))?.timing === 'after');
ok('주 칸 — 모든 회차가 고치기 전이면 null', weekEditOf(edited, week('2026-W43', ['2026-10-19', '2026-10-20'])) === null);
ok('주 칸 — 고친 날 회차뿐이면 during', weekEditOf(edited, week('2026-W43', ['2026-10-21']))?.timing === 'during');

// 3) 성과 표 판단 — 마지막으로 고친 뒤
const cell = (citedDays: number[], extra: Partial<HistoryCell> = {}): HistoryCell => ({
  timing: 'after',
  afterRemoval: false,
  tally: citedDays.length ? ({ all: { cited: citedDays.length, supporting: 0 }, unnamed: null, named: null } as unknown as HistoryCell['tally']) : null,
  variantCited: 0,
  daysAfterPublish: 10,
  runs: { measured: 2, cited: citedDays.length, weak: 0, weakEngines: [], unsure: 0, citedDays },
  ...extra,
});
const post = { publishedOn: '2026-10-10', edits: [{ editedOn: '2026-10-15', recordedAt: '2026-10-15T00:00:00Z' }] };
const weeks = [week('2026-W42', ['2026-10-13']), week('2026-W43', ['2026-10-15', '2026-10-17']), week('2026-W44', ['2026-10-24'])];
// W42: 고치기 전(인용 D+3) · W43: 고친 날 회차에서만 인용(D+5) · W44: 고친 뒤 인용(D+14)
const since = summarizeSinceEdit(post, [cell([3]), cell([5]), cell([14])], weeks);
ok('고친 뒤 측정한 주 = 고친 뒤 회차가 있는 주(W43 · W44)', since?.measuredWeeks === 2);
ok('고친 날 당일 회차의 인용은 고친 뒤 인용으로 세지 않는다', since?.citedWeeks === 1);
ok('고친 뒤 첫 인용 = 고친 날에서 D+9', since?.firstCitedDays === 9 && since.editedOn === '2026-10-15');
ok('고친 날이 없으면 null', summarizeSinceEdit({ publishedOn: '2026-10-10' }, [cell([3])], [weeks[0]!]) === null);
ok('올린 날을 모르면 null', summarizeSinceEdit({ publishedOn: null, edits: post.edits }, [cell([3])], [weeks[0]!]) === null);
const removed = summarizeSinceEdit(post, [null, cell([], { afterRemoval: true }), cell([14])], weeks);
ok('판정 없는 주 · 내린 뒤 칸은 세지 않는다', removed?.measuredWeeks === 1 && removed.citedWeeks === 1);
const unknownDays = summarizeSinceEdit(post, [null, null, cell([], { tally: { all: { cited: 1, supporting: 0 }, unnamed: null, named: null } as unknown as HistoryCell['tally'], runs: undefined, daysAfterPublish: undefined })], weeks);
ok('일수를 모르는 인용 주는 인용으로 세되 첫 인용 일수는 비운다', unknownDays?.citedWeeks === 1 && unknownDays.firstCitedDays === null);

// 3-b) 성과 표 칸 꼬리 — 고치기 전 회차가 섞인 주는 고친 뒤 몫만 따로(칸 숫자는 그 주 올린 뒤 전체)
const mixedWeek = week('2026-W43', ['2026-10-19', '2026-10-20', '2026-10-22']);
const mixedPost = { publishedOn: '2026-10-10', edits: [{ editedOn: '2026-10-21', recordedAt: '2026-10-21T00:00:00Z' }] };
ok('섞인 주 — 고치기 전 회차 인용(D+9·10)만 있으면 「고친 뒤 회차 1번 인용 없음」', weekEditNote(mixedPost, cell([9, 10]), mixedWeek) === '10/21 고친 날이 든 주 · 고친 뒤 회차 1번 인용 없음');
ok('섞인 주 — 고친 뒤 회차 인용은 고친 날 기준 D+N', weekEditNote(mixedPost, cell([9, 12]), mixedWeek) === '10/21 고친 날이 든 주 · 고친 뒤 회차 1번 인용 D+1');
ok('모든 회차가 고친 뒤면 「고친 뒤」만', weekEditNote(mixedPost, cell([12]), week('2026-W43', ['2026-10-22', '2026-10-23'])) === '10/21 고친 뒤');
ok('고친 날 회차와 고치기 전 회차만 있으면 고친 뒤 회차 없음', weekEditNote(mixedPost, cell([]), week('2026-W43', ['2026-10-20', '2026-10-21'])) === '10/21 고친 날이 든 주 · 고친 뒤 회차 없음(고친 날 회차는 전후 불명)');
ok('고친 날 회차뿐이면 전후 불명', weekEditNote(mixedPost, cell([]), week('2026-W43', ['2026-10-21'])) === '10/21 고친 날 측정 · 고치기 전후 불명');
ok('모든 회차가 고치기 전이면 꼬리 없음', weekEditNote(mixedPost, cell([9]), week('2026-W43', ['2026-10-19', '2026-10-20'])) === null);

// 4) 회차 보기
const point = (runId: string, iso: string): RunPoint => ({
  kind: 'run', runId, weekOf: '2026-W43', at: iso, window: null, selfOnly: true, inCohortRun: false, weekCard: 'saved', isWeekCard: false,
  engines: { gemini: { planned: 26, succeeded: 26 } }, enginesUsed: ['gemini'], partialEngines: [], missingEngines: [], engineIssues: [],
  conditionKey: 'k1', changesFromPrev: [], bankVersion: 'v5', ranked: null, score: 5, scoreAtMeasure: 5, agnosticQuestions: 26, repeatsPerQuestion: 1,
});
const runCell = (cited: number): RunPostRow['cells'][number] => ({ timing: 'after', afterRemoval: false, daysAfterPublish: 12, withinGrace: false, cited, unnamedCited: cited, variantCited: 0, byEngine: {} });
const runPost: PublishedPost = {
  id: 'p1', url: 'https://fake.tistory.com/2', key: 'fake.tistory.com/2', publishedOn: '2026-10-10', publishedOnSource: 'user', recordedAt: '2026-10-10T00:00:00Z',
  articleId: 'content:category-agnostic', targetActionId: 'listing:platform:tistory.com', via: 'channel',
  edits: [{ editedOn: '2026-10-22', recordedAt: '2026-10-22T00:00:00Z' }],
};
// 고친 뒤 회차 셈은 서버가 그림 밖 회차까지 전체 기간으로 낸다(server/runHistory.ts — scripts/verify-run-history.ts가 확인). 그림 모델은
// 그 값을 그대로 쓰고, 고친 날 점선 자리만 정한다.
const sinceEdit = { editedOn: '2026-10-22', measured: 1, cited: 1, weak: 0, firstCitedDays: 2 };
const hist: RunHistory = {
  points: [point('a', '2026-10-20T01:00:00Z'), point('b', '2026-10-22T01:00:00Z'), point('c', '2026-10-24T01:00:00Z')],
  posts: [{ post: runPost, cells: [runCell(1), runCell(0), runCell(1)], measuredRuns: 3, citedRuns: 2, afterGrace: { measured: 3, cited: 2 }, firstCited: { at: '2026-10-20T01:00:00Z', daysAfterPublish: 10 }, lastUncitedDaysBefore: null, unsureRuns: 0, weakRuns: 0, weakEngines: [], sinceEdit }],
  weekCardScores: {},
  issues: [],
};
const model = buildRunTrend(hist);
const row = model.rows[0]!;
ok('회차 보기 — 서버가 낸 고친 뒤 셈을 그대로 쓴다', row.sinceEdit === sinceEdit);
ok('회차 보기 — 고친 날 점선 자리 = 그 날 칸', row.edits.length === 1 && row.edits[0]!.x === model.days.indexOf('2026-10-22'));
ok('회차 보기 — 그림 밖 고친 날은 점선 없음(x null)', buildRunTrend({ ...hist, posts: [{ ...hist.posts[0]!, post: { ...runPost, edits: [{ editedOn: '2026-09-01', recordedAt: '2026-09-01T00:00:00Z' }] } }] }).rows[0]!.edits[0]!.x === null);
ok('회차 보기 — 옛 서버(셈 없음)면 null', buildRunTrend({ ...hist, posts: [{ ...hist.posts[0]!, sinceEdit: undefined }] }).rows[0]!.sinceEdit === null);

// 5) 콘텐츠 생성의 이번 주 결과 — 고친 뒤 측정인지 밝힌다
const questions = [{ questionId: 'a1', text: '군산 여행 정보 사이트 추천해줘', category: 'category-agnostic', containsBrandName: false }] as QuestionSpec[];
const analysis = {
  questionId: 'a1', engine: 'gemini', callIndex: 0, mentioned: false, mentionSentences: [], competitorMentions: [], shareOfMention: 0,
  citations: [{ raw: 'https://fake.tistory.com/2', domain: null, ownerType: 'third-party-authority', supportsBrandMention: false }],
  topRecommendation: null, brandRank: null, factualityClaims: [], factualitySupported: 0, factualityContradicted: 0, brandOwnedCitation: false, clarifying: false,
  timing: { startedAt: '2026-10-24T01:00:00Z' },
} as unknown as QuestionRepeatAnalysis;
const ownPost = { ...runPost, targetActionId: 'content:category-agnostic', via: 'own' as const };
const plan = computeGapActions([analysis] as unknown as ClientAnalysis[], questions, analyzeCitationSources([analysis]), {}, [ownPost], '2026-W43');
const hit = plan.actions.find((a) => a.id === 'content:category-agnostic')?.publishedHits?.[0];
ok('이번 주 결과에 고친 날 전후가 붙는다(10/24 측정 · 10/22 고침 → 고친 뒤)', hit?.edit?.editedOn === '2026-10-22' && hit.edit.timing === 'after');
const planBefore = computeGapActions([analysis] as unknown as ClientAnalysis[], questions, analyzeCitationSources([analysis]), {}, [{ ...ownPost, edits: [{ editedOn: '2026-10-25', recordedAt: '2026-10-25T00:00:00Z' }] }], '2026-W44');
ok('측정 뒤에 고쳤으면 이번 주 결과에 고친 날을 붙이지 않는다', planBefore.actions.find((a) => a.id === 'content:category-agnostic')?.publishedHits?.[0]?.edit === undefined);

// 6) 주소 칸 — 「고쳤어요」는 고친 날을 받을 수 있는 화면에만, 고친 날은 「올림 · 고침」으로
const noop = () => {};
const editor = (extra: Partial<React.ComponentProps<typeof PublishedUrlEditor>> = {}) =>
  renderToStaticMarkup(
    React.createElement(PublishedUrlEditor, {
      hits: recordOnlyHits([runPost]),
      removed: [],
      weekOf: '',
      busy: false,
      judged: false,
      onRecord: async () => null,
      onRemove: noop,
      onRestore: noop,
      onSetDate: noop,
      ...extra,
    }),
  );
ok('고친 날을 「10/10 올림 · 10/22 고침」으로 적는다', editor().includes('10/10 올림 · 10/22 고침'));
ok('고친 날을 받을 수 있으면 「고쳤어요」가 있다', editor({ onAddEdit: noop, onRemoveEdit: noop }).includes('고쳤어요'));
ok('받을 수 없으면 「고쳤어요」를 그리지 않는다', !editor().includes('고쳤어요'));
ok('올린 날을 모르는 기록에는 「고쳤어요」를 그리지 않는다', !renderToStaticMarkup(
  React.createElement(PublishedUrlEditor, {
    hits: recordOnlyHits([{ ...runPost, publishedOn: null, publishedOnSource: 'legacy', edits: undefined }]),
    removed: [], weekOf: '', busy: false, judged: false, onRecord: async () => null, onRemove: noop, onRestore: noop, onSetDate: noop, onAddEdit: noop,
  }),
).includes('고쳤어요'));

let failed = 0;
for (const [label, pass] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${label}`);
  if (!pass) failed += 1;
}
console.log(`\n${checks.length - failed}/${checks.length} 통과`);
if (failed > 0) process.exit(1);
