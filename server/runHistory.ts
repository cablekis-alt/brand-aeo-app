import type { WeeklyScorecard } from '../src/prompts/b8-report.js';
import { conditionChanges } from '../src/lib/comparability.js';
import type { PostTiming } from '../src/lib/publishedUrl.js';
import { INDEXING_GRACE_DAYS } from '../src/lib/publishTracking.js';
import { aggregateWeeklyMetrics } from './aggregate.js';
import { clopperPearson } from './exactInterval.js';
import { agnosticAnalyses } from './mentionScope.js';
import { historyCards, shownPosts, weekViews } from './publishedHistory.js';
import type { PublishedPost } from './publishedPosts.js';
import type { ResultStore, RunMeta } from './store.js';

/**
 * 회차 보기(성과 화면 「측정 회차별 보기」) — 같은 주에 여러 번 잰 회차를 시간순으로 늘어놓는다.
 *
 * 앞세우는 숫자는 둘이다. 올린 글이 회차마다 인용됐나, 그리고 이름 없는 질문(점수와 같은 「카테고리 무관」 질문)의 답에서 우리가 순위와
 * 함께 불린 응답 수 k/N. 점수는 이 k가 0~3건이라 1건에 약 5점씩 계단으로 뛴다(실측 같은 날 16→1→6) — 그래서 보조로만 낸다. 회차
 * 하나의 오르내림을 판단으로 쓰지 않게, 회차 사이 비교(전일 대비) · 저장된 신뢰구간 · 코호트 순위는 내지 않는다.
 *
 * 순위 · 점수는 회차가 측정 때 남긴 판정(ownAnalyses)으로 다시 센다 — 저장된 회차 카드는 순위 다시 세기 전 값이고 집계 규칙이 바뀌면
 * 낡는다(store.ts saveRunSnapshot 주석). 올린 글 칸은 성과 표(server/publishedHistory.ts)와 같은 표본 계산을 쓴다.
 */

export interface RunPoint {
  kind: 'run' | 'week-file';
  runId: string | null;
  weekOf: string;
  at: string | null;
  window: { first: string; last: string } | null;
  selfOnly: boolean | null;
  inCohortRun: boolean | null;
  /** 회차 기록이 없던 그 주 파일을 옮겨 둔 회차 — 예정 호출 수 · 판정 맥락을 모른다. */
  preserved?: true;
  weekCard: 'saved' | 'kept' | 'week-file';
  weekCardKeptReason?: string;
  /** 지금 그 주 카드(막대 · 보고서 점수)가 이 회차다. */
  isWeekCard: boolean;
  engines: Record<string, { planned: number; succeeded: number }> | null;
  enginesUsed: string[];
  partialEngines: string[];
  missingEngines: string[];
  engineIssues: string[];
  /** 같은 조건 회차끼리만 점수를 평균낸다. */
  conditionKey: string;
  /** 바로 앞 점과 달라진 측정 조건 — 있으면 그 사이를 잇지 않는다. */
  changesFromPrev: string[];
  bankVersion: string | null;
  /**
   * 카테고리 무관 질문의 답 가운데 우리가 순위와 함께 불린 응답 k / 응답 N(되묻기 포함), 그중 언급된 응답, k/N의 95% 범위. 질문 은행을
   * 못 찾으면 null(확인 불가 — 0이 아니다).
   */
  ranked: { k: number; n: number; mentioned: number; ci: { lower: number; upper: number } | null } | null;
  /** 그 회차 판정으로 다시 센 점수(보조). 은행을 못 찾으면 null. */
  score: number | null;
  /** 측정 때 카드 점수 — 다시 센 값과 맞는지 보는 데만 쓴다. */
  scoreAtMeasure: number | null;
  /** 카테고리 무관 질문 수와 반복 횟수 — 범위 설명(같은 질문을 엔진 여러 곳에 물었다)에 쓴다. */
  agnosticQuestions: number | null;
  repeatsPerQuestion: number | null;
}

export interface RunPostCell {
  timing: PostTiming;
  afterRemoval: boolean;
  daysAfterPublish: number | null;
  withinGrace: boolean;
  /** 정확 일치 인용 응답 수. */
  cited: number;
  /** 그중 이름 없는 질문 — 은행을 못 읽었으면 null. */
  unnamedCited: number | null;
  variantCited: number;
  byEngine: Record<string, number>;
}

export interface RunPostRow {
  post: PublishedPost;
  /** points와 같은 순서. 그 회차 판정이 없으면 null. */
  cells: (RunPostCell | null)[];
  /** 아래 숫자는 성과 표 판단과 같은 기간(올린 주 바로 앞 측정부터)으로 센다 — 그림에 보이는 회차만이 아니다. */
  measuredRuns: number;
  citedRuns: number;
  /** 올린 지 INDEXING_GRACE_DAYS일이 지난 회차만. */
  afterGrace: { measured: number; cited: number };
  firstCited: { at: string | null; daysAfterPublish: number } | null;
  /** 첫 인용 바로 앞 회차(인용 없음)가 올린 지 며칠 뒤였나. */
  lastUncitedDaysBefore: number | null;
  unsureRuns: number;
  weakRuns: number;
  weakEngines: string[];
}

export interface RunHistory {
  points: RunPoint[];
  posts: RunPostRow[];
  /** 그림에 보이는 주의 그 주 카드 점수(막대 값) — 회차 평균 옆에 함께 적는다. */
  weekCardScores: Record<string, number>;
  /** 읽지 못해 뺀 회차(「주차 · 회차 id: 까닭」). */
  issues: string[];
}

export const MAX_RUN_WEEKS = 12;

type RunHistoryStore = Pick<ResultStore, 'getScorecardHistory' | 'getQuestionAnalyses' | 'getQuestionBank' | 'listRunSnapshots'>;

export async function getRunHistory(
  store: RunHistoryStore,
  tenant: { tenantId: string; questionBankVersion?: string },
  posts: PublishedPost[],
  weeksBack = 6,
): Promise<RunHistory> {
  const shown = shownPosts(posts);
  const limit = Math.min(Math.max(1, Math.floor(weeksBack) || 1), MAX_RUN_WEEKS);
  const { all, start } = await historyCards(store, tenant.tenantId, shown, limit);
  // 그림은 최근 limit장, 글별 요약은 성과 표와 같은 시작점부터 — 둘 중 이른 쪽부터 읽는다.
  const drawFrom = Math.max(0, all.length - limit);
  const from = shown.length > 0 ? Math.min(start, drawFrom) : drawFrom;

  const points: RunPoint[] = [];
  // 점마다 그림에 보이는가 · 다음 점과 견줄 카드 · 회차 요약(응답에는 싣지 않는다).
  const drawn: boolean[] = [];
  const ctx: { scorecard: WeeklyScorecard; meta: RunMeta | null; isolated: boolean }[] = [];
  const cells: (RunPostCell | null)[][] = shown.map(() => []);
  const issues: string[] = [];
  for (let c = from; c < all.length; c += 1) {
    const card = all[c]!;
    const { samples, views, issues: weekIssues } = await weekViews(store, tenant, shown, card, { byEngine: true });
    issues.push(...weekIssues.map((i) => `${card.weekOf} · ${i}`));
    samples.forEach((s, k) => {
      const view = views[k]!;
      const bank = view.bank;
      const scorecard: WeeklyScorecard = s.isWeekFile ? card : s.scorecard;
      let ranked: RunPoint['ranked'] = null;
      let score: number | null = null;
      let agnosticQuestions: number | null = null;
      if (bank) {
        const m = aggregateWeeklyMetrics({ competitors: [] }, bank.questions, s.ownAnalyses);
        const scoped = agnosticAnalyses(s.ownAnalyses, bank.questions);
        ranked = { k: m.rankedResponses, n: scoped.length, mentioned: scoped.filter((a) => a.mentioned).length, ci: clopperPearson(m.rankedResponses, scoped.length) };
        score = m.score;
        agnosticQuestions = bank.questions.filter((q) => q.category === 'category-agnostic').length;
      }
      const conditions = {
        enginesUsed: [...(scorecard.enginesUsed ?? [])].sort(),
        judgeEngine: scorecard.judgeEngine ?? null,
        judgeModel: scorecard.judgeModel ?? null,
        modelsUsed: Object.entries(scorecard.modelsUsed ?? {}).sort(),
        questionBankVersion: scorecard.questionBankVersion ?? null,
        repeatsPerQuestion: scorecard.repeatsPerQuestion ?? null,
        contextFingerprint: s.meta?.contextFingerprint ?? '',
        planned: Object.entries(s.meta?.engines ?? {})
          .filter(([, v]) => v.planned > 0)
          .map(([e]) => e)
          .sort(),
      };
      const prev = ctx.at(-1);
      const isolated = s.partialEngines.length > 0 || s.missingEngines.length > 0;
      points.push({
        kind: s.kind,
        runId: s.runId,
        weekOf: card.weekOf,
        at: s.at,
        window: view.window,
        selfOnly: s.meta ? s.meta.selfOnly : null,
        inCohortRun: s.meta ? s.meta.inCohortRun : null,
        ...(s.meta?.preserved ? { preserved: true as const } : {}),
        weekCard: s.kind === 'week-file' ? 'week-file' : (s.meta?.weekCard ?? 'saved'),
        ...(s.meta?.weekCardKeptReason ? { weekCardKeptReason: s.meta.weekCardKeptReason } : {}),
        isWeekCard: s.isWeekFile,
        engines: s.meta && !s.meta.preserved ? s.meta.engines : null,
        enginesUsed: conditions.enginesUsed,
        partialEngines: s.partialEngines,
        missingEngines: s.missingEngines,
        engineIssues: s.meta?.engineIssues ?? [],
        conditionKey: JSON.stringify(conditions),
        changesFromPrev: prev ? changesBetween(prev, { scorecard, meta: s.meta, isolated }) : [],
        bankVersion: view.bankVersion,
        ranked,
        score,
        scoreAtMeasure: scorecard.aeoScore?.current ?? null,
        agnosticQuestions,
        repeatsPerQuestion: scorecard.repeatsPerQuestion ?? null,
      });
      drawn.push(c >= drawFrom);
      ctx.push({ scorecard, meta: s.meta, isolated });
      shown.forEach((_, i) => {
        const cell = view.cells[i];
        if (!cell) {
          cells[i]!.push(null);
          return;
        }
        const days = cell.daysAfterPublish ?? null;
        cells[i]!.push({
          timing: cell.timing,
          afterRemoval: cell.afterRemoval,
          daysAfterPublish: days,
          withinGrace: cell.timing === 'after' && days !== null && days < INDEXING_GRACE_DAYS,
          cited: cell.tally?.all.cited ?? 0,
          unnamedCited: cell.tally ? (cell.tally.unnamed?.cited ?? null) : 0,
          variantCited: cell.variantCited,
          byEngine: view.byEngine?.[i] ?? {},
        });
      });
    });
  }

  const postRows: RunPostRow[] = shown.map((post, i) => {
    const row = cells[i]!;
    const after = row
      .map((cell, k) => ({ cell, point: points[k]! }))
      .filter((x): x is { cell: RunPostCell; point: RunPoint } => Boolean(x.cell && !x.cell.afterRemoval && x.cell.timing === 'after'));
    const firstIdx = after.findIndex((x) => x.cell.cited > 0);
    const weak = after.filter((x) => x.point.partialEngines.length > 0 || x.point.missingEngines.length > 0);
    const matured = after.filter((x) => !x.cell.withinGrace);
    return {
      post,
      cells: row.filter((_, k) => drawn[k]),
      measuredRuns: after.length,
      citedRuns: after.filter((x) => x.cell.cited > 0).length,
      afterGrace: { measured: matured.length, cited: matured.filter((x) => x.cell.cited > 0).length },
      firstCited: firstIdx >= 0 ? { at: after[firstIdx]!.point.at, daysAfterPublish: after[firstIdx]!.cell.daysAfterPublish ?? 0 } : null,
      lastUncitedDaysBefore: firstIdx > 0 ? (after[firstIdx - 1]!.cell.daysAfterPublish ?? null) : null,
      unsureRuns: row.filter((cell) => cell && !cell.afterRemoval && (cell.timing === 'during' || cell.timing === 'ambiguous')).length,
      weakRuns: weak.length,
      weakEngines: [...new Set(weak.flatMap((x) => [...x.point.partialEngines, ...x.point.missingEngines]))].sort(),
    };
  });

  return {
    points: points.filter((_, k) => drawn[k]),
    posts: postRows,
    weekCardScores: Object.fromEntries(all.slice(drawFrom).map((card) => [card.weekOf, card.aeoScore.current])),
    issues,
  };
}

/** 바로 앞 점과 달라진 조건 — 카드 조건 비교(comparability.ts)에 판정 맥락 · 예정 엔진을 더한다. 모르는 값(옛 기록)은 견주지 않는다. */
function changesBetween(
  prev: { scorecard: WeeklyScorecard; meta: RunMeta | null; isolated: boolean },
  cur: { scorecard: WeeklyScorecard; meta: RunMeta | null; isolated: boolean },
): string[] {
  // 엔진이 빠졌거나 일부만 든 회차는 그 자체로 잇지 않는다 — 쓴 엔진 차이를 「수집 엔진 바뀜」으로 또 적지 않는다(설정을 바꾼 것이 아니다).
  const out: string[] = conditionChanges(prev.scorecard, cur.scorecard).filter((c) => !(c === '수집 엔진' && (prev.isolated || cur.isolated)));
  const a = prev.meta;
  const b = cur.meta;
  if (a?.contextFingerprint && b?.contextFingerprint && a.contextFingerprint !== b.contextFingerprint) out.push('판정 맥락');
  const planned = (m: RunMeta) =>
    Object.entries(m.engines ?? {})
      .filter(([, v]) => v.planned > 0)
      .map(([e]) => e)
      .sort()
      .join(',');
  if (a && b && !a.preserved && !b.preserved && planned(a) !== planned(b)) out.push('예정 엔진');
  return out;
}
