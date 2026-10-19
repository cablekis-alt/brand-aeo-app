import type { WeeklyScorecard } from '../src/prompts/b8-report.js';
import { conditionChanges } from '../src/lib/comparability.js';
import {
  indexWeekCitations,
  isoWeekOf,
  kstDate,
  matchKind,
  measuredWindow,
  timingOf,
  trackingKey,
  type PostTiming,
  type WeekTally,
} from '../src/lib/publishedUrl.js';
import type { PublishedPost } from './publishedPosts.js';
import { weekQuestionBank } from './queries.js';
import type { ResultStore } from './store.js';

/**
 * 올린 글 인용 이력 — 집행 원장의 주소마다 측정 주차별로 AI 답변 인용을 센다(언급률 2번 P3).
 *
 * ── 저장하지 않고 볼 때 계산한다 ─────────────────────────────────────────────
 * 주차 판정 파일(question-analyses.json)은 파이프라인 · CI 동기화 · 재측정이 덮는다. 이력을 따로 저장하면 무효화가 필요하고, 늦게
 * 적은 주소는 지난 주차에 소급되지 않는다. 그래서 요청마다 계산한다 — 기록이 0건이면 주차 파일을 하나도 읽지 않는다.
 *
 * ── 0을 지어내지 않는다 ───────────────────────────────────────────────────────
 * 카드는 있는데 판정 기록이 없는 주는 analysed=false(칸 null)로 둔다. 그 주를 측정한 질문 은행을 못 찾으면 이름 없는/이름 댄 질문을
 * null로 둔다(확인 불가). 데모 데이터로 대신하지 않는다 — 측정한 파일만 읽는다.
 */

export interface HistoryWeek {
  weekOf: string;
  /** 판정 기록이 있다. false면 그 주 칸은 0이 아니라 확인 불가다. */
  analysed: boolean;
  /** 측정한 날(한국 날짜)의 범위 — 판정 시작 시각. 시각이 없는 옛 기록이면 null. */
  window: { first: string; last: string } | null;
  engines: string[];
  /** 그 주 판정을 나눈 질문 은행 판. 못 찾았으면 null. */
  bankVersion: string | null;
  /** 응답 수(분모) — 은행을 못 찾으면 이름 없는/이름 댄은 null. */
  responses: { all: number; unnamed: number | null; named: number | null; unknown: number };
  /** 직전 측정 주와 달라진 측정 조건 — 엔진만 늘어도 인용이 생긴 것처럼 보일 수 있어 알린다(보정하지 않는다). */
  changes: string[];
}

export interface HistoryCell {
  /** 그 주 측정이 올린 날에 견줘 언제였나. before면 그 주 인용은 이 글의 효과가 아니다. */
  timing: PostTiming;
  /** 「글을 내렸어요」 뒤에 한 측정 — 그 주에는 글이 없었다(인용을 세지 않는다). */
  afterRemoval: boolean;
  /** 정확 일치 인용(응답 단위). 그 주에 인용되지 않았으면 null. */
  tally: WeekTally | null;
  /** 질의만 다른 주소를 인용한 응답 수 — 같은 글인지 몰라 숫자에 넣지 않는다. */
  variantCited: number;
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

type HistoryStore = Pick<ResultStore, 'getScorecardHistory' | 'getQuestionAnalyses' | 'getQuestionBank'>;

export async function getPublishedHistory(
  store: HistoryStore,
  tenant: { tenantId: string; questionBankVersion?: string },
  posts: PublishedPost[],
  weeksBack: number,
): Promise<PublishedHistory> {
  // 「잘못 적은 주소」는 이력에서 뺀다. 「글을 내렸어요」는 남기고 내린 뒤의 주만 표시한다.
  const shown = posts.filter((p) => !p.removedAt || p.removedReason === 'taken-down');
  if (shown.length === 0) return { weeks: [], posts: [] };
  const limit = Math.min(Math.max(1, Math.floor(weeksBack) || 1), MAX_HISTORY_WEEKS);
  const all = [...(await store.getScorecardHistory(tenant.tenantId, MAX_HISTORY_WEEKS))].sort((a, b) => a.weekOf.localeCompare(b.weekOf));
  // 판단은 올린 뒤 측정 전체로 한다 — 최근 N주만 보면 예전에 올려 여러 번 인용된 글이 「인용 없음」이 된다. 가장 이른 올린 주의 바로
  // 앞 측정까지 넓힌다(올리기 전 인용을 알리려고). 올린 날을 모르는 기록은 판단하지 않으므로 넓히지 않는다. 최대 MAX_HISTORY_WEEKS.
  const earliest = shown
    .map((p) => (p.publishedOn ? isoWeekOf(p.publishedOn) : null))
    .filter((w): w is string => Boolean(w))
    .sort()[0];
  const firstAfter = earliest ? all.findIndex((c) => c.weekOf >= earliest) : -1;
  const start = Math.max(0, Math.min(all.length - limit, firstAfter >= 0 ? firstAfter - 1 : all.length - limit));
  const cards = all.slice(start);

  const weeks: HistoryWeek[] = [];
  const cells: (HistoryCell | null)[][] = shown.map(() => []);
  // 첫 열의 조건 변경도 그 앞 측정과 견준다(창 밖이어도).
  let prev: WeeklyScorecard | null = all[start - 1] ?? null;
  for (const card of cards) {
    const changes = prev ? conditionChanges(prev, card) : [];
    prev = card;
    const analyses = await store.getQuestionAnalyses(tenant.tenantId, card.weekOf);
    if (analyses.length === 0) {
      weeks.push({
        weekOf: card.weekOf,
        analysed: false,
        window: null,
        engines: card.enginesUsed ?? [],
        bankVersion: null,
        responses: { all: 0, unnamed: null, named: null, unknown: 0 },
        changes,
      });
      for (const c of cells) c.push(null);
      continue;
    }

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
    weeks.push({
      weekOf: card.weekOf,
      analysed: true,
      window,
      engines: card.enginesUsed ?? [...new Set(analyses.map((a) => a.engine))].sort(),
      bankVersion: bank?.version ?? null,
      responses: {
        all: responseKeys.size,
        unnamed: named ? counts.unnamed : null,
        named: named ? counts.named : null,
        unknown: counts.unknown,
      },
      changes,
    });

    // 내린 날이 이 주 측정보다 뒤면 이 주에는 글이 올라가 있었다.
    const status = shown.map((post) => {
      const removedOn = post.removedAt ? kstDate(post.removedAt) : null;
      const upDuring = !removedOn || (window ? removedOn > window.last : (isoWeekOf(removedOn) ?? '') > card.weekOf);
      return { upDuring, timing: timingOf(post.publishedOn, window, card.weekOf) };
    });
    shown.forEach((post, i) => {
      const { upDuring, timing } = status[i]!;
      let variantCited = 0;
      if (upDuring) for (const keys of responseKeys.values()) if ([...keys].some((k) => matchKind(post.key, k) === 'query-variant')) variantCited += 1;
      const cell: HistoryCell = {
        timing,
        afterRemoval: !upDuring,
        tally: upDuring ? (index.get(post.key) ?? null) : null,
        variantCited,
      };
      const earlierLive = shown.some(
        (other, j) => j !== i && other.key === post.key && other.removedReason === 'taken-down' && status[j]!.upDuring && status[j]!.timing !== 'before',
      );
      if (timing === 'before' && earlierLive) cell.earlierPostingLive = true;
      if (post.articleId.startsWith('topic:')) {
        const topicMention = topicMentionOf(post, bank, analyses);
        if (topicMention !== undefined) cell.topicMention = topicMention;
      }
      cells[i]!.push(cell);
    });
  }
  return { weeks, posts: shown.map((post, i) => ({ post, cells: cells[i]! })) };
}

/**
 * topic: 글이 겨냥한 질문 가운데 이름 없는 질문의 응답 · 언급. 기록한 판과 그 주 판이 다르거나 판을 모르면 null. 겨냥한 질문에 이름
 * 없는 질문이 없으면 undefined(해당 없음), 그 주에 그 질문의 답변이 없으면(모두 되묻기 · 수집 실패) null — 0/0으로 보이지 않는다.
 */
function topicMentionOf(
  post: PublishedPost,
  bank: Awaited<ReturnType<typeof weekQuestionBank>>,
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
