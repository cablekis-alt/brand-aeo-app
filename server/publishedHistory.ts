import type { WeeklyScorecard } from '../src/prompts/b8-report.js';
import { conditionChanges } from '../src/lib/comparability.js';
import {
  daysAfterPublish,
  indexWeekCitations,
  isoWeekOf,
  kstDate,
  matchKind,
  measuredWindow,
  timingOf,
  trackingKey,
  type CitationTally,
  type PostTiming,
  type WeekTally,
} from '../src/lib/publishedUrl.js';
import type { PublishedPost } from './publishedPosts.js';
import { weekQuestionBank } from './queries.js';
import { weekSamples, type WeekSample } from './runSamples.js';
import type { QuestionBank, ResultStore } from './store.js';
import type { QuestionRepeatAnalysis } from './types.js';

/**
 * 올린 글 인용 이력 — 집행 원장의 주소마다 측정 주차별로 AI 답변 인용을 센다(언급률 2번 P3).
 *
 * ── 저장하지 않고 볼 때 계산한다 ─────────────────────────────────────────────
 * 주차 판정 파일(question-analyses.json)은 파이프라인 · CI 동기화 · 재측정이 덮는다. 이력을 따로 저장하면 무효화가 필요하고, 늦게
 * 적은 주소는 지난 주차에 소급되지 않는다. 그래서 요청마다 계산한다 — 기록이 0건이면 주차 파일을 하나도 읽지 않는다.
 *
 * ── 한 주의 칸은 그 주 회차를 합친다 ──────────────────────────────────────────
 * 같은 주에 여러 번 재면 회차 기록(runs/, server/runSamples.ts)이 남는다. 칸은 회차마다 센 뒤 합친다 — 한 회차라도 인용하면 그 주는
 * 인용이다. 판정을 이어 붙여 한 번에 세면 안 된다(indexWeekCitations는 응답 키로 겹침을 지워 다른 회차의 같은 응답을 한 번으로 센다).
 * 표본이 하나뿐인 주는 전과 같은 칸이다.
 *
 * ── 0을 지어내지 않는다 ───────────────────────────────────────────────────────
 * 카드는 있는데 판정 기록이 없는 주는 analysed=false(칸 null)로 둔다. 그 주를 측정한 질문 은행을 못 찾으면 이름 없는/이름 댄 질문을
 * null로 둔다(확인 불가). 데모 데이터로 대신하지 않는다 — 측정한 파일만 읽는다.
 */

/** 그 주 회차 하나(표본이 2개 이상인 주에만 싣는다). */
export interface HistoryRun {
  runId: string | null;
  /** week-file = 회차 기록이 없는 그 주 파일(v0.4.26 전 측정). */
  kind: 'run' | 'week-file';
  at: string | null;
  window: { first: string; last: string } | null;
  weekCard: 'saved' | 'kept' | 'week-file';
  /** 지금 그 주 카드(막대 · 보고서 점수)가 이 회차다. */
  isWeekCard: boolean;
  selfOnly: boolean | null;
  preserved?: true;
  engines: string[];
  partialEngines: string[];
  missingEngines: string[];
  bankVersion: string | null;
}

export interface HistoryWeek {
  weekOf: string;
  /** 판정 기록이 있다. false면 그 주 칸은 0이 아니라 확인 불가다. */
  analysed: boolean;
  /**
   * 측정한 날(한국 날짜)의 범위 — 판정 시작 시각. 회차가 여럿이면 그 주 카드 회차의 범위(회차마다의 범위는 runs[].window — 그래프 핀은
   * 그것으로 칸과 같은 규칙을 쓴다, src/lib/publishTracking.ts weekTimingOf). 시각이 없는 옛 기록이면 null.
   */
  window: { first: string; last: string } | null;
  engines: string[];
  /** 그 주 판정을 나눈 질문 은행 판. 못 찾았으면 null. */
  bankVersion: string | null;
  /** 응답 수(분모) — 은행을 못 찾으면 이름 없는/이름 댄은 null. 회차가 여럿이면 그 주 카드 회차의 수. */
  responses: { all: number; unnamed: number | null; named: number | null; unknown: number };
  /** 직전 측정 주와 달라진 측정 조건 — 엔진만 늘어도 인용이 생긴 것처럼 보일 수 있어 알린다(보정하지 않는다). */
  changes: string[];
  /** 그 주 회차 — 표본이 2개 이상일 때만. */
  runs?: HistoryRun[];
  /** 읽지 못해 칸에서 뺀 회차. */
  runIssues?: string[];
}

/** 회차가 여럿인 주의 칸 — 올린 뒤 회차 가운데 몇 번 인용됐나. */
export interface RunCellTally {
  /** 올린 뒤 · 내리기 전 회차 수 — 엔진이 빠진 회차도 넣는다. */
  measured: number;
  /** 그중 정확 일치 인용이 있던 회차 수. */
  cited: number;
  /** 그중 엔진이 빠졌거나 일부만 들어온 회차 수와 그 엔진. */
  weak: number;
  weakEngines: string[];
  /** 전후 불명(측정하던 날 올림 · 시각 없는 같은 주) 회차 수 — measured에 넣지 않는다. */
  unsure: number;
  /** 인용된 회차가 올린 지 며칠 뒤였나(오름차순, 겹치면 하나). */
  citedDays: number[];
}

export interface HistoryCell {
  /** 그 주 측정이 올린 날에 견줘 언제였나. before면 그 주 인용은 이 글의 효과가 아니다. 회차가 여럿이면 올린 뒤 회차가 하나라도 있으면 after. */
  timing: PostTiming;
  /** 「글을 내렸어요」 뒤에 한 측정 — 그 주에는 글이 없었다(인용을 세지 않는다). */
  afterRemoval: boolean;
  /** 정확 일치 인용(응답 단위, 회차 합). 그 주에 인용되지 않았으면 null. */
  tally: WeekTally | null;
  /** 질의만 다른 주소를 인용한 응답 수 — 같은 글인지 몰라 숫자에 넣지 않는다. */
  variantCited: number;
  /** 올린 뒤(after) 측정이 올린 날에서 며칠 뒤였나(src/lib/publishedUrl.ts daysAfterPublish). 회차가 여럿이면 가장 늦은 회차. after가 아니면 없다. */
  daysAfterPublish?: number;
  /**
   * topic: 글이 겨냥한 질문 가운데 이름 없는 질문의 그 주 응답 · 언급. 그 주 은행 판이 기록한 판과 같을 때만 낸다 — 질문 id는 판마다
   * 다시 쓰이므로 판이 다르면 null(확인 불가). 그 주 답변이 없어도 null. topic: 글이 아니거나 겨냥한 질문에 이름 없는 질문이 없으면
   * undefined(해당 없음).
   */
  topicMention?: { answered: number; mentioned: number } | null;
  /**
   * 같은 주소를 앞서 올렸다 「글을 내렸어요」로 내린 다른 기록이 그 주에 올라가 있었다 — 다시 올린 기록에서 그 주 인용은 앞 글의
   * 것이라 「올리기 전에 이미 인용됨(올린 날 확인)」으로 보지 않는다.
   */
  earlierPostingLive?: true;
  /** 회차가 여럿인 주 — 회차별로 센 값. */
  runs?: RunCellTally;
  /** 같은 주에 올리기 전 회차에서 이미 인용됐다(칸이 after여도) — 올린 날이 틀렸을 수 있다. */
  citedBeforeRuns?: number;
}

export interface PostHistory {
  post: PublishedPost;
  /** weeks와 같은 순서. 판정 기록이 없는 주는 null. */
  cells: (HistoryCell | null)[];
}

export interface PublishedHistory {
  weeks: HistoryWeek[];
  posts: PostHistory[];
}

export const MAX_HISTORY_WEEKS = 52;

type HistoryStore = Pick<ResultStore, 'getScorecardHistory' | 'getQuestionAnalyses' | 'getQuestionBank' | 'listRunSnapshots'>;

/** 「잘못 적은 주소」는 이력에서 뺀다. 「글을 내렸어요」는 남기고 내린 뒤의 주만 표시한다. */
export const shownPosts = (posts: PublishedPost[]) => posts.filter((p) => !p.removedAt || p.removedReason === 'taken-down');

/**
 * 판단에 쓰는 카드 — 올린 뒤 측정 전체로 한다(최근 N주만 보면 예전에 올려 여러 번 인용된 글이 「인용 없음」이 된다). 가장 이른 올린
 * 주의 바로 앞 측정까지 넓힌다(올리기 전 인용을 알리려고). 올린 날을 모르는 기록은 판단하지 않으므로 넓히지 않는다. 최대
 * MAX_HISTORY_WEEKS. 회차 보기(server/runHistory.ts)도 글별 요약을 같은 카드로 센다.
 */
export async function historyCards(
  store: Pick<ResultStore, 'getScorecardHistory'>,
  tenantId: string,
  shown: PublishedPost[],
  weeksBack: number,
): Promise<{ all: WeeklyScorecard[]; start: number }> {
  const limit = Math.min(Math.max(1, Math.floor(weeksBack) || 1), MAX_HISTORY_WEEKS);
  const all = [...(await store.getScorecardHistory(tenantId, MAX_HISTORY_WEEKS))].sort((a, b) => a.weekOf.localeCompare(b.weekOf));
  const earliest = shown
    .map((p) => (p.publishedOn ? isoWeekOf(p.publishedOn) : null))
    .filter((w): w is string => Boolean(w))
    .sort()[0];
  const firstAfter = earliest ? all.findIndex((c) => c.weekOf >= earliest) : -1;
  const start = Math.max(0, Math.min(all.length - limit, firstAfter >= 0 ? firstAfter - 1 : all.length - limit));
  return { all, start };
}

export async function getPublishedHistory(
  store: HistoryStore,
  tenant: { tenantId: string; questionBankVersion?: string },
  posts: PublishedPost[],
  weeksBack: number,
): Promise<PublishedHistory> {
  const shown = shownPosts(posts);
  if (shown.length === 0) return { weeks: [], posts: [] };
  const { all, start } = await historyCards(store, tenant.tenantId, shown, weeksBack);
  const cards = all.slice(start);

  const weeks: HistoryWeek[] = [];
  const cells: (HistoryCell | null)[][] = shown.map(() => []);
  // 첫 열의 조건 변경도 그 앞 측정과 견준다(창 밖이어도).
  let prev: WeeklyScorecard | null = all[start - 1] ?? null;
  for (const card of cards) {
    const changes = prev ? conditionChanges(prev, card) : [];
    prev = card;
    const week = await weekViews(store, tenant, shown, card);
    const runIssues = week.issues.length > 0 ? { runIssues: week.issues } : {};
    if (week.views.length === 0) {
      weeks.push({
        weekOf: card.weekOf,
        analysed: false,
        window: null,
        engines: card.enginesUsed ?? [],
        bankVersion: null,
        responses: { all: 0, unnamed: null, named: null, unknown: 0 },
        changes,
        ...runIssues,
      });
      for (const c of cells) c.push(null);
      continue;
    }
    const { samples, views } = week;
    // 그 주 화면의 기준(응답 수 · 엔진 · 은행)은 그 주 카드 회차 — 그 주 파일과 짝이 없으면 마지막 표본.
    const base = views[samples.findIndex((s) => s.isWeekFile)] ?? views.at(-1)!;
    const many = samples.length > 1;
    weeks.push({
      weekOf: card.weekOf,
      analysed: true,
      window: base.window,
      engines: base.engines,
      bankVersion: base.bankVersion,
      responses: base.responses,
      changes,
      ...(many ? { runs: samples.map((s, k) => historyRun(s, views[k]!)) } : {}),
      ...runIssues,
    });
    shown.forEach((_, i) => {
      cells[i]!.push(many ? foldCell(views.map((v) => v.cells[i]!), samples) : views[0]!.cells[i]!);
    });
  }
  return { weeks, posts: shown.map((post, i) => ({ post, cells: cells[i]! })) };
}

/** 표본 하나를 센 결과. */
export interface SampleView {
  window: { first: string; last: string } | null;
  bank: QuestionBank | null;
  bankVersion: string | null;
  engines: string[];
  responses: HistoryWeek['responses'];
  /** shown과 같은 순서. */
  cells: HistoryCell[];
  /** opts.byEngine일 때만 — 글마다 엔진별 정확 일치 인용 응답 수. */
  byEngine?: Record<string, number>[];
}

/** 한 주의 표본과 표본별 계산. 회차를 읽지 못한 것은 issues(「회차 id: 까닭」)로 남긴다. */
export async function weekViews(
  store: HistoryStore,
  tenant: { tenantId: string; questionBankVersion?: string },
  shown: PublishedPost[],
  card: WeeklyScorecard,
  opts?: { byEngine?: boolean },
): Promise<{ samples: WeekSample[]; views: SampleView[]; issues: string[] }> {
  const analyses = await store.getQuestionAnalyses(tenant.tenantId, card.weekOf);
  const { samples, issues } = await weekSamples(store, tenant.tenantId, card, analyses);
  const views: SampleView[] = [];
  // 그 주 파일 표본은 그 주 카드로 센다 — 회차 기록이 없던 때와 같은 결과가 나오게.
  for (const s of samples) views.push(await sampleView(store, tenant, shown, { weekOf: card.weekOf, scorecard: s.isWeekFile ? card : s.scorecard, analyses: s.analyses }, opts));
  return { samples, views, issues: issues.map((i) => `${i.runId}: ${i.reason}`) };
}

/** 표본 하나(한 측정의 판정)를 센다 — 회차 기록이 생기기 전의 주 칸 계산 그대로다. */
export async function sampleView(
  store: Pick<ResultStore, 'getQuestionBank'>,
  tenant: { tenantId: string; questionBankVersion?: string },
  shown: PublishedPost[],
  sample: { weekOf: string; scorecard: WeeklyScorecard; analyses: QuestionRepeatAnalysis[] },
  opts?: { byEngine?: boolean },
): Promise<SampleView> {
  const { weekOf, scorecard: card, analyses } = sample;
  const found = await weekQuestionBank(store, tenant.tenantId, analyses, card.questionBankVersion, tenant.questionBankVersion);
  // 카드에 판이 적혀 있으면 그 판만 쓴다 — 그 파일이 없어 지금 판으로 넘어가면, 판마다 다시 쓰이는 질문 id(c1-001 등)가 다른
  // 질문을 가리킬 수 있다. 판을 모르면 확인 불가로 둔다.
  const bank = found && card.questionBankVersion && found.version !== card.questionBankVersion ? null : found;
  const named = bank ? new Map(bank.questions.map((q) => [q.questionId, q.containsBrandName])) : null;
  const index = indexWeekCitations(analyses, named);
  const window = measuredWindow(analyses);

  // 분모와 응답별 인용 키 — 같은 응답이 두 번 들어온 파일(재판정 덧붙임)도 한 번만 센다.
  const responseKeys = new Map<string, Set<string>>();
  const counts = { unnamed: 0, named: 0, unknown: 0 };
  for (const a of analyses) {
    const id = `${a.questionId}|${a.engine}|${a.callIndex}`;
    if (!responseKeys.has(id)) {
      const n = named?.get(a.questionId);
      if (n === undefined) counts.unknown += 1;
      else if (n) counts.named += 1;
      else counts.unnamed += 1;
    }
    const keys = responseKeys.get(id) ?? new Set<string>();
    for (const c of a.citations ?? []) {
      const key = c.raw ? trackingKey(c.raw) : null;
      if (key) keys.add(key);
    }
    responseKeys.set(id, keys);
  }

  // 내린 날이 이 측정보다 뒤면 이 측정 때는 글이 올라가 있었다.
  const status = shown.map((post) => {
    const removedOn = post.removedAt ? kstDate(post.removedAt) : null;
    const upDuring = !removedOn || (window ? removedOn > window.last : (isoWeekOf(removedOn) ?? '') > weekOf);
    return { upDuring, timing: timingOf(post.publishedOn, window, weekOf) };
  });
  const cells = shown.map((post, i) => {
    const { upDuring, timing } = status[i]!;
    let variantCited = 0;
    if (upDuring) for (const keys of responseKeys.values()) if ([...keys].some((k) => matchKind(post.key, k) === 'query-variant')) variantCited += 1;
    const cell: HistoryCell = {
      timing,
      afterRemoval: !upDuring,
      tally: upDuring ? (index.get(post.key) ?? null) : null,
      variantCited,
    };
    const days = daysAfterPublish(post.publishedOn, window, weekOf);
    if (days !== null) cell.daysAfterPublish = days;
    const earlierLive = shown.some(
      (other, j) => j !== i && other.key === post.key && other.removedReason === 'taken-down' && status[j]!.upDuring && status[j]!.timing !== 'before',
    );
    if (timing === 'before' && earlierLive) cell.earlierPostingLive = true;
    if (post.articleId.startsWith('topic:')) {
      const topicMention = topicMentionOf(post, bank, analyses);
      if (topicMention !== undefined) cell.topicMention = topicMention;
    }
    return cell;
  });

  let byEngine: Record<string, number>[] | undefined;
  if (opts?.byEngine) {
    const engineNames = [...new Set(analyses.map((a) => a.engine))].sort();
    const perEngine = engineNames.map((e) => [e, indexWeekCitations(analyses.filter((a) => a.engine === e), named)] as const);
    byEngine = shown.map((post, i) =>
      cells[i]!.tally ? Object.fromEntries(perEngine.map(([e, idx]) => [e, idx.get(post.key)?.all.cited ?? 0]).filter(([, n]) => (n as number) > 0)) : {},
    );
  }

  return {
    window,
    bank,
    bankVersion: bank?.version ?? null,
    engines: card.enginesUsed ?? [...new Set(analyses.map((a) => a.engine))].sort(),
    responses: {
      all: responseKeys.size,
      unnamed: named ? counts.unnamed : null,
      named: named ? counts.named : null,
      unknown: counts.unknown,
    },
    cells,
    ...(byEngine ? { byEngine } : {}),
  };
}

function historyRun(s: WeekSample, v: SampleView): HistoryRun {
  return {
    runId: s.runId,
    kind: s.kind,
    at: s.at,
    window: v.window,
    weekCard: s.kind === 'week-file' ? 'week-file' : (s.meta?.weekCard ?? 'saved'),
    isWeekCard: s.isWeekFile,
    selfOnly: s.meta ? s.meta.selfOnly : null,
    ...(s.meta?.preserved ? { preserved: true as const } : {}),
    engines: v.engines,
    partialEngines: s.partialEngines,
    missingEngines: s.missingEngines,
    bankVersion: v.bankVersion,
  };
}

const isCited = (c: HistoryCell) => (c.tally?.all.cited ?? 0) > 0;
const unsureTiming = (t: PostTiming) => t === 'during' || t === 'ambiguous';

function addTally(a: CitationTally, b: CitationTally): CitationTally {
  return { cited: a.cited + b.cited, supporting: a.supporting + b.supporting, mentioned: a.mentioned + b.mentioned };
}

/** 회차들의 정확 일치 인용 합 — 이름 없는/이름 댄은 한 회차라도 은행을 못 읽었으면 확인 불가. */
function sumTallies(tallies: WeekTally[]): WeekTally | null {
  if (tallies.length === 0) return null;
  return tallies.slice(1).reduce<WeekTally>(
    (sum, t) => ({
      all: addTally(sum.all, t.all),
      unnamed: sum.unnamed && t.unnamed ? addTally(sum.unnamed, t.unnamed) : null,
      named: sum.named && t.named ? addTally(sum.named, t.named) : null,
      unknown: addTally(sum.unknown, t.unknown),
      forms: [...new Set([...sum.forms, ...t.forms])].slice(0, 3),
    }),
    { ...tallies[0]!, forms: [...tallies[0]!.forms] },
  );
}

/**
 * 한 글의 그 주 칸 — 회차별 칸을 합친다. 칸의 전후는 올라가 있던 회차 가운데 올린 뒤(after)가 있으면 after, 없으면 전후 불명, 그다음
 * before · unknown 순이다. 숫자는 그 전후에 든 회차만 더한다(올리기 전 회차의 인용은 citedBeforeRuns로 따로 센다).
 */
export function foldCell(views: HistoryCell[], samples: Pick<WeekSample, 'partialEngines' | 'missingEngines'>[]): HistoryCell {
  const up = views.map((v, k) => ({ v, k })).filter(({ v }) => !v.afterRemoval);
  if (up.length === 0) return { ...views.at(-1)!, afterRemoval: true, tally: null };
  const has = (pred: (t: PostTiming) => boolean) => up.some(({ v }) => pred(v.timing));
  const timing: PostTiming = has((t) => t === 'after')
    ? 'after'
    : has((t) => t === 'during')
      ? 'during'
      : has((t) => t === 'ambiguous')
        ? 'ambiguous'
        : has((t) => t === 'before')
          ? 'before'
          : 'unknown';
  const sameGroup = (t: PostTiming) => (unsureTiming(timing) ? unsureTiming(t) : t === timing);
  const contrib = up.filter(({ v }) => sameGroup(v.timing));
  const tally = sumTallies(contrib.map(({ v }) => v.tally).filter((t): t is WeekTally => t !== null));
  const cell: HistoryCell = {
    timing,
    afterRemoval: false,
    tally,
    variantCited: contrib.reduce((n, { v }) => n + v.variantCited, 0),
  };
  if (timing === 'after') {
    const days = contrib.map(({ v }) => v.daysAfterPublish).filter((d): d is number => d !== undefined);
    if (days.length > 0) cell.daysAfterPublish = Math.max(...days);
  }
  if (timing === 'before' && contrib.some(({ v }) => v.earlierPostingLive)) cell.earlierPostingLive = true;
  const topics = contrib.map(({ v }) => v.topicMention);
  if (topics.some((t) => t !== undefined)) {
    cell.topicMention = topics.some((t) => t === null)
      ? null
      : topics.reduce<{ answered: number; mentioned: number }>(
          (sum, t) => (t ? { answered: sum.answered + t.answered, mentioned: sum.mentioned + t.mentioned } : sum),
          { answered: 0, mentioned: 0 },
        );
  }
  if (timing !== 'before') {
    const before = up.filter(({ v }) => v.timing === 'before' && isCited(v) && !v.earlierPostingLive).length;
    if (before > 0) cell.citedBeforeRuns = before;
  }
  const after = timing === 'after' ? contrib : [];
  const weak = after.filter(({ k }) => samples[k]!.partialEngines.length > 0 || samples[k]!.missingEngines.length > 0);
  cell.runs = {
    measured: after.length,
    cited: after.filter(({ v }) => isCited(v)).length,
    weak: weak.length,
    weakEngines: [...new Set(weak.flatMap(({ k }) => [...samples[k]!.partialEngines, ...samples[k]!.missingEngines]))].sort(),
    unsure: up.filter(({ v }) => unsureTiming(v.timing)).length,
    citedDays: [...new Set(after.filter(({ v }) => isCited(v)).map(({ v }) => v.daysAfterPublish).filter((d): d is number => d !== undefined))].sort(
      (a, b) => a - b,
    ),
  };
  return cell;
}

/**
 * topic: 글이 겨냥한 질문 가운데 이름 없는 질문의 응답 · 언급. 기록한 판과 그 주 판이 다르거나 판을 모르면 null. 겨냥한 질문에 이름
 * 없는 질문이 없으면 undefined(해당 없음), 그 주에 그 질문의 답변이 없으면(모두 되묻기 · 수집 실패) null — 0/0으로 보이지 않는다.
 */
function topicMentionOf(
  post: PublishedPost,
  bank: QuestionBank | null,
  analyses: { questionId: string; engine: string; callIndex: number; mentioned: boolean; clarifying?: boolean }[],
): { answered: number; mentioned: number } | null | undefined {
  const snap = post.topic;
  if (!snap?.bankVersion || !bank || bank.version !== snap.bankVersion) return null;
  const unnamed = new Set(bank.questions.filter((q) => snap.questionIds.includes(q.questionId) && !q.containsBrandName).map((q) => q.questionId));
  if (unnamed.size === 0) return undefined;
  const seen = new Set<string>();
  let answered = 0;
  let mentioned = 0;
  for (const a of analyses) {
    if (!unnamed.has(a.questionId) || a.clarifying) continue;
    const id = `${a.questionId}|${a.engine}|${a.callIndex}`;
    if (seen.has(id)) continue;
    seen.add(id);
    answered += 1;
    if (a.mentioned) mentioned += 1;
  }
  return answered > 0 ? { answered, mentioned } : null;
}
