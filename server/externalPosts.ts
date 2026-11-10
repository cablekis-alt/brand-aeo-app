import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  EXTERNAL_ID,
  externalAsLedgerPost,
  externalRegistrationCheck,
  externalViews,
  ledgerWinners,
  ledgerWinsMessage,
  MAX_EXTERNAL_POSTS,
  MAX_EXTERNAL_ROWS,
  measuredBefore,
  parseExternalAddInput,
  parseExternalPatch,
  parseExternalPostsFile,
  repostBasis,
  repostDayProblem,
  takenDownBefore,
  trackedDayProblem,
  type ExternalPost,
  type ExternalPostsFile,
  type ExternalPostView,
} from '../src/lib/externalPosts.js';
import { KEY_RULE } from '../src/lib/publishedUrl.js';
import { PIPELINE_DATA_DIR } from './appPaths.js';
import { getPublishedHistory, viewOfSample, type HistoryCell, type HistoryWeek, type SampleAdjust } from './publishedHistory.js';
import { readPublishedPosts, readPublishedPostsInQueue, type PublishedPost } from './publishedPosts.js';
import { queueTenantWrite, writeJsonAtomic } from './tenantWriteQueue.js';
import type { ResultStore } from './store.js';

/**
 * 앱 밖 글 저장소 — data/<tenant>/external-posts.json(모양 · 규칙은 src/lib/externalPosts.ts). 원장(published-posts.json) · 집행 상태
 * (action-states.json)는 읽기만 하고 쓰지 않는다 — 앱 밖 글을 적고 · 고치고 · 빼도 앱 글 화면은 한 글자도 바뀌지 않는다
 * (scripts/verify-external-posts.ts 격리 검사).
 *
 * ── 쓰기 줄 ─────────────────────────────────────────────────────────────────
 * 원장 · 색인 확인과 같은 브랜드 쓰기 줄(tenantWriteQueue.ts)에서 읽고 쓴다 — 윈도우에서 읽는 중인 파일 위로 rename이 EPERM으로 실패하지
 * 않게, 또 「원장이 이기는가」를 본 순간과 쓰는 순간 사이에 앱 글이 끼어들지 않게. 줄은 다시 들어갈 수 없으므로(promise 체인) 줄 안에서는
 * …InQueue 읽기만 쓰고, 다른 브랜드의 원장은 줄에 들어가기 전에 읽는다(readOtherLedgers — 브랜드 줄 안에서 다른 줄을 기다리지 않는다).
 *
 * 파일이 깨졌으면 읽지도 쓰지도 않는다(500). 원장이 깨졌으면 원장이 이기는지 알 수 없어 적지 않는다(짐작하지 않는다).
 *
 * 웹(Vercel)에는 라우트가 없다(함수 12/12). 화면은 404를 「이 환경에는 없음」으로 읽고 절을 숨긴다.
 */
export const EXTERNAL_POSTS_FILE = 'external-posts.json';

/** 라우트가 그대로 상태 코드로 쓰는 오류. */
export class ExternalPostsError extends Error {
  readonly status: number;
  /** 응답에 함께 싣는 값 — 409면 가로막은 원장 줄(conflict). */
  readonly detail: Record<string, unknown>;
  constructor(message: string, status: number, detail: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

function filePathFor(tenantId: string): string {
  return path.join(PIPELINE_DATA_DIR, tenantId, EXTERNAL_POSTS_FILE);
}

/** 쓰기 줄 안에서 읽는다. 없으면 빈 목록, 깨졌으면 500. 줄 밖에서는 readExternalPosts를 쓴다. */
export async function readExternalPostsInQueue(tenantId: string): Promise<ExternalPost[]> {
  let raw: string;
  try {
    raw = await readFile(filePathFor(tenantId), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new ExternalPostsError(`앱 밖 글 파일(${EXTERNAL_POSTS_FILE})을 읽지 못했습니다: ${err instanceof Error ? err.message : String(err)}`, 500);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    throw new ExternalPostsError(
      `앱 밖 글 파일(${EXTERNAL_POSTS_FILE})이 깨져 있어 읽지도 쓰지도 않았습니다: ${err instanceof Error ? err.message : String(err)}`,
      500,
    );
  }
  const checked = parseExternalPostsFile(parsed);
  if (!checked.ok) throw new ExternalPostsError(`앱 밖 글 파일(${EXTERNAL_POSTS_FILE})의 모양이 맞지 않아 읽지도 쓰지도 않았습니다: ${checked.error}`, 500);
  return checked.posts;
}

export function readExternalPosts(tenantId: string): Promise<ExternalPost[]> {
  return queueTenantWrite(tenantId, () => readExternalPostsInQueue(tenantId));
}

async function writeExternal(tenantId: string, posts: ExternalPost[]): Promise<void> {
  const file: ExternalPostsFile = { version: 1, keyRule: KEY_RULE, posts };
  await writeJsonAtomic(filePathFor(tenantId), file);
}

/** 같은 순간의 앱 밖 글 파일과 원장(옛 기록 포함) — 쓰기 줄 안에서만. */
async function readBothInQueue(tenantId: string): Promise<{ posts: ExternalPost[]; ledger: PublishedPost[] }> {
  return { posts: await readExternalPostsInQueue(tenantId), ledger: await readPublishedPostsInQueue(tenantId) };
}

/** 앱 밖 글 목록(뺀 줄 · 쉬는 줄 포함) — 화면이 상태로 나눠 보인다. */
export function listExternalPosts(tenantId: string): Promise<ExternalPostView[]> {
  return queueTenantWrite(tenantId, async () => {
    const { posts, ledger } = await readBothInQueue(tenantId);
    return externalViews(posts, ledger);
  });
}

export interface TenantLedger {
  tenantId: string;
  posts: PublishedPost[];
}

/**
 * 다른 브랜드들의 원장 — 브랜드마다 그 쓰기 줄에서 하나씩 읽는다. 앱 밖 글을 적을 브랜드의 줄에 들어가기 전에 부른다(C18). 원장이
 * 깨진 브랜드는 건너뛴다 — 다른 브랜드의 앱 글은 알리기만 하므로(막지 않는다) 그 브랜드를 「같은 주소」에서 뺄 뿐이다.
 */
export async function readOtherLedgers(tenantIds: readonly string[]): Promise<TenantLedger[]> {
  const out: TenantLedger[] = [];
  for (const id of tenantIds) {
    try {
      out.push({ tenantId: id, posts: await readPublishedPosts(id) });
    } catch (err) {
      console.warn(`[externalPosts] ${id}의 원장을 읽지 못해 「같은 주소」 알림에서 뺍니다:`, err);
    }
  }
  return out;
}

const liveCount = (posts: readonly ExternalPost[]) => posts.filter((p) => !p.removedAt).length;

/** 줄을 하나 더 살릴 자리가 있는가 — 상한은 살아 있는 줄로 센다(뺀 줄까지 세면 정리해도 자리가 나지 않는다). */
function assertRoom(posts: readonly ExternalPost[]): void {
  if (liveCount(posts) >= MAX_EXTERNAL_POSTS) {
    throw new ExternalPostsError(`앱 밖 글이 ${MAX_EXTERNAL_POSTS}편을 넘었습니다. 추적하지 않을 글을 빼고 다시 시도해 주세요.`, 400);
  }
  if (posts.length >= MAX_EXTERNAL_ROWS) {
    throw new ExternalPostsError(`앱 밖 글 파일이 ${MAX_EXTERNAL_ROWS}줄(뺀 줄 포함)을 넘었습니다. 관리자에게 정리를 요청해 주세요.`, 400);
  }
}

/** 원장이 이기면 거절한다(등록 · 되살리기 같은 기준 — C5). */
function assertLedgerDoesNotWin(ledger: readonly PublishedPost[], key: string): void {
  const winners = ledgerWinners(ledger, key);
  if (winners.length === 0) return;
  const first = winners[0]!;
  throw new ExternalPostsError(ledgerWinsMessage(winners), 409, { conflict: { id: first.id, articleId: first.articleId, removed: Boolean(first.removedAt) } });
}

export interface AddExternalResult {
  post: ExternalPostView;
  posts: ExternalPostView[];
  /** 같은 브랜드 같은 주소의 살아 있는 줄이 이미 있어 새로 쓰지 않았다(그 줄은 고치지 않는다). */
  existing: boolean;
  /** 같은 주소를 앱 글로 가진 다른 브랜드(D13 — 막지 않고 알린다). */
  alsoAppIn: string[];
}

/**
 * 앱 밖 글 한 편을 그 브랜드에 적는다. 같은 주소의 살아 있는 줄이 있으면 그 줄을 돌려준다(올린 날도 고치지 않는다 — 고치기는
 * updateExternalPost). 뺀 줄만 있으면 새 줄을 적는다(다시 올림 — 올린 날은 내린 날 뒤여야 한다, 아니면 400 · C9). 같은 브랜드 원장이
 * 이기면 409. others는 줄에 들어가기 전에 읽은 다른 브랜드 원장이다(readOtherLedgers).
 */
export function addExternalPost(tenantId: string, body: unknown, others: readonly TenantLedger[] = []): Promise<AddExternalResult> {
  const input = parseExternalAddInput(body);
  if (!input.ok) return Promise.reject(new ExternalPostsError(input.error, input.status));
  const { key } = input.value;
  return queueTenantWrite(tenantId, async () => {
    const { posts, ledger } = await readBothInQueue(tenantId);
    const standing = externalRegistrationCheck(tenantId, key, [{ tenantId, posts: ledger }, ...others.filter((o) => o.tenantId !== tenantId)]);
    if (standing.blocked) assertLedgerDoesNotWin(ledger, key);
    const live = posts.find((p) => p.key === key && !p.removedAt);
    let next = posts;
    let post: ExternalPost;
    if (live) {
      post = live;
    } else {
      const reposted = repostDayProblem(input.value.publishedOn, takenDownBefore(posts, { key }));
      if (reposted) throw new ExternalPostsError(reposted, 400);
      assertRoom(posts);
      post = {
        id: `x-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        url: input.value.url,
        key,
        title: input.value.title,
        publishedOn: input.value.publishedOn,
        publishedOnSource: input.value.publishedOnSource,
        trackedAt: new Date().toISOString(),
      };
      next = [...posts, post];
      await writeExternal(tenantId, next);
    }
    const views = externalViews(next, ledger);
    return { post: views.find((v) => v.id === post.id)!, posts: views, existing: Boolean(live), alsoAppIn: standing.appIn };
  });
}

/**
 * 앱 밖 줄 하나를 고친다 — 올린 날(null이면 모름) · 빼기(mistake · taken-down) · 되살리기. 되살리기는 「잘못 적음」으로 뺀 줄만(내린 글을
 * 다시 올렸으면 새로 적는다 — 내린 기간이 남는다), 같은 주소의 살아 있는 줄이 있거나 원장이 이기면 409. 올린 날을 고치거나 되살릴 때 그
 * 줄보다 먼저 내린 같은 주소 줄이 있으면 올린 날은 그 내린 날 뒤여야 한다(400 — C9). 추적 시작 시각은 바꾸지 않는다.
 */
export function updateExternalPost(tenantId: string, postId: string, body: unknown): Promise<{ post: ExternalPostView; posts: ExternalPostView[] }> {
  if (!EXTERNAL_ID.test(postId)) return Promise.reject(new ExternalPostsError('앱 밖 글 id가 올바르지 않습니다.', 400));
  const patch = parseExternalPatch(body);
  if (!patch.ok) return Promise.reject(new ExternalPostsError(patch.error, patch.status));
  const change = patch.value;
  return queueTenantWrite(tenantId, async () => {
    const { posts, ledger } = await readBothInQueue(tenantId);
    const found = posts.find((p) => p.id === postId);
    if (!found) throw new ExternalPostsError(`앱 밖 글을 찾지 못했습니다: ${postId}`, 404);
    let next: ExternalPost = found;
    if (change.kind === 'remove') {
      if (found.removedAt && found.removedReason !== change.reason) throw new ExternalPostsError('이미 다른 까닭으로 뺀 글입니다 — 되살린 뒤 다시 빼 주세요.', 409);
      if (!found.removedAt) next = { ...found, removedAt: new Date().toISOString(), removedReason: change.reason };
    } else {
      const publishedOn = change.publishedOn === undefined ? found.publishedOn : change.publishedOn;
      const problem = trackedDayProblem(publishedOn, found.trackedAt);
      if (problem) throw new ExternalPostsError(problem, 400);
      if (change.kind === 'restore' && found.removedAt) {
        if (found.removedReason !== 'mistake') {
          throw new ExternalPostsError('「글을 내림」으로 뺀 글은 되살리지 않습니다 — 다시 올렸으면 새로 적어 주세요(내린 기간이 남습니다).', 400);
        }
        if (posts.some((p) => p.id !== found.id && p.key === found.key && !p.removedAt)) {
          throw new ExternalPostsError('같은 주소가 다른 줄로 다시 적혀 있어 되살리지 않았습니다.', 409);
        }
        assertLedgerDoesNotWin(ledger, found.key);
        assertRoom(posts);
      }
      const base = { ...found };
      if (change.kind === 'restore') {
        delete base.removedAt;
        delete base.removedReason;
      }
      next = {
        ...base,
        ...(change.publishedOn !== undefined ? { publishedOn: change.publishedOn, publishedOnSource: change.publishedOn === null ? ('unknown' as const) : ('user' as const) } : {}),
      };
      // 다시 올린 줄이면 올린 날이 그 앞에 내린 날보다 뒤여야 한다(C9 — 적을 때와 같은 규칙).
      const reposted = repostDayProblem(next.publishedOn, takenDownBefore(posts, next));
      if (reposted && (change.publishedOn !== undefined || change.kind === 'restore')) throw new ExternalPostsError(reposted, 400);
    }
    const changed = JSON.stringify(next) !== JSON.stringify(found);
    const nextPosts = changed ? posts.map((p) => (p.id === found.id ? next : p)) : posts;
    if (changed) await writeExternal(tenantId, nextPosts);
    const views = externalViews(nextPosts, ledger);
    return { post: views.find((v) => v.id === postId)!, posts: views };
  });
}

/** 서버가 앱 밖 행에서 회차를 비운 까닭 — repost 다시 올리기 전(C9 · repostMask), moved 앱 글 표가 셈(D12 · appCountedMask). */
export type ExternalBlankReason = 'repost' | 'moved';

/** 그 주 회차 가운데 서버가 이 행에서 비운 회차 수(까닭별). */
export type ExternalBlankedRuns = Record<ExternalBlankReason, number>;

/** 앱 밖 글 인용 이력의 한 행 — 계산에 넘긴 원장 모양(post)과 앱 밖 줄(external)을 함께 싣는다. */
export interface ExternalHistoryRow {
  post: PublishedPost;
  external: ExternalPostView;
  cells: (HistoryCell | null)[];
  /**
   * weeks와 같은 순서 — 그 주에 서버가 이 행에서 비운 회차 수(까닭별). 비운 회차가 없거나 판정 기록이 없는 주는 null. 성과 표는 비운 칸의
   * 이름 · 까닭을 이 값으로 고른다 — 주 카드 회차의 측정 기간 같은 것으로 짐작하지 않는다(회차가 여럿인 주는 회차마다 까닭이 다를 수 있다).
   */
  blanked: (ExternalBlankedRuns | null)[];
}

export interface ExternalHistory {
  weeks: HistoryWeek[];
  posts: ExternalHistoryRow[];
}

type HistoryStore = Pick<ResultStore, 'getScorecardHistory' | 'getQuestionAnalyses' | 'getQuestionBank' | 'listRunSnapshots'>;

/** 앱 글 표가 세는 칸인가 — 올리기 전 측정만 세지 않는다(올린 뒤 · 전후 불명 · 올린 날 모름은 그 표에 숫자가 보이고, 앱 글을 내린 뒤 칸도 그 표의 몫이다). */
const appCounts = (cell: HistoryCell) => cell.afterRemoval || cell.timing !== 'before';

/**
 * D12 — 같은 브랜드에서 앱 글로 옮긴 주소(원장이 이김)의 앱 밖 칸은 앱 글 표가 그 회차를 셀 때만 비운다. 회차마다 이긴 앱 글 줄의 칸을 앱 글
 * 표와 같은 계산(같은 표본 · 그 주소의 이긴 원장 줄 모두 — 올린 시각으로 같은 날 회차를 가른다)으로 내고, 그 가운데 하나라도 세면 앱 밖
 * 칸을 「내린 뒤」 모양으로 비운다. 그래서 옮긴 날 옮기기 전에 끝난 회차는 앱 밖 표가, 옮긴 뒤 회차는 앱 글 표가 센다. 앱 글 줄의 올린 날을
 * 기록일보다 뒤로 고쳤으면 그 사이 회차도 앱 밖 표가 센다 — 어느 회차든 두 표 가운데 하나만 센다. 옮긴 줄이 없으면 undefined(계산 그대로).
 */
function appCountedMask(
  store: HistoryStore,
  tenant: { tenantId: string; questionBankVersion?: string },
  views: readonly ExternalPostView[],
  ledger: readonly PublishedPost[],
): SampleAdjust | undefined {
  const keys = new Set(views.filter((v) => v.movedOn !== null).map((v) => v.key));
  if (keys.size === 0) return undefined;
  const app = [...keys].flatMap((k) => ledgerWinners(ledger, k));
  return async (card, sample, view, shown) => {
    const appView = await viewOfSample(store, tenant, app, card, sample);
    return view.cells.map((cell, i) => {
      const key = shown[i]!.key;
      if (cell.afterRemoval || !keys.has(key)) return cell;
      const counted = app.some((p, j) => p.key === key && appCounts(appView.cells[j]!));
      return counted ? { ...cell, afterRemoval: true, tally: null, variantCited: 0 } : cell;
    });
  };
}

/**
 * C9 · D3 — 다시 올린 줄은 앞 줄을 내린 날까지 한 측정(회차)을 세지 않는다. 기준일은 색인 표시와 같은 날(repostBasis — externalIndexBasis)이고
 * 회차가 그보다 앞인지는 칸의 전후와 같은 규칙(measuredBefore)으로 본다 — 회차마다 그 회차의 측정 기간으로 보고, 비운 회차는 까닭(repost)과 함께
 * 행에 싣는다(blanked — 성과 표는 그 값으로 「다시 올리기 전」을 단다). 비우는 것은 이 줄이
 * 세는 칸(「올리기 전」이 아닌 칸)뿐이고 모양은 「내린 뒤」(앱 글로 옮긴 칸과 같다)다 — 전후(날짜 모름)는 그대로 둬 판단 칸이 바뀌지 않는다. 날짜를
 * 적은 다시 올린 줄은 올린 날이 내린 날 뒤라(C9) 그 앞 회차 칸이 이미 「올리기 전」이어서 바뀌지 않는다. 다시 올린 줄이 없으면 undefined.
 */
function repostMask(views: readonly ExternalPostView[]): SampleAdjust | undefined {
  const basis = new Map<string, string>();
  for (const v of views) {
    const b = repostBasis(views, v);
    if (b) basis.set(v.id, b.countsFrom);
  }
  if (basis.size === 0) return undefined;
  return async (card, _sample, view, shown) =>
    view.cells.map((cell, i) => {
      const from = basis.get(shown[i]!.id);
      return from && !cell.afterRemoval && cell.timing !== 'before' && measuredBefore(from, view.window, card.weekOf)
        ? { ...cell, afterRemoval: true, tally: null, variantCited: 0 }
        : cell;
    });
}

/**
 * 회차 칸 고치기를 차례로 잇는다(앞 것이 비운 칸은 뒤 것이 건너뛴다). 단계가 새로 비운 칸은 그 단계의 까닭으로 알린다(note — 주 · 줄 id마다
 * 센다). 하나도 없으면 undefined(계산 그대로).
 */
function chainAdjust(
  steps: readonly [ExternalBlankReason, SampleAdjust | undefined][],
  note: (weekOf: string, postId: string, reason: ExternalBlankReason) => void,
): SampleAdjust | undefined {
  const list = steps.filter((s): s is [ExternalBlankReason, SampleAdjust] => s[1] !== undefined);
  if (list.length === 0) return undefined;
  return async (card, sample, view, shown) => {
    let cells = view.cells;
    for (const [reason, step] of list) {
      const next = await step(card, sample, { ...view, cells }, shown);
      next.forEach((cell, i) => {
        if (cell.afterRemoval && !cells[i]!.afterRemoval) note(card.weekOf, shown[i]!.id, reason);
      });
      cells = next;
    }
    return cells;
  };
}

/**
 * 앱 밖 글 인용 이력 — 앱 글 이력과 같은 계산(getPublishedHistory)을 그대로 쓴다: 그 브랜드의 측정 답변에서 주소가 정확히 같을 때만,
 * 늦게 적어도 지난 측정까지 거슬러, 판정이 없는 주는 null. 넘기는 줄은 변환기(externalAsLedgerPost)를 지난다 — 올린 시각 없음. 다시 올린
 * 줄은 앞 줄을 내린 날까지의 회차를(repostMask), 앱 글로 옮긴 주소는 앱 글 표가 세는 회차를(appCountedMask) 비운다 — 어느 회차든 많아야 한 행이
 * 센다. 비운 회차는 주마다 까닭별로 센다(blanked — 성과 표가 비운 칸의 이름을 고른다). 「잘못 적음」 줄은 뺀다. 저장하지 않고 요청마다 계산한다.
 */
export async function getExternalHistory(
  store: HistoryStore,
  tenant: { tenantId: string; questionBankVersion?: string },
  weeksBack: number,
): Promise<ExternalHistory> {
  const { posts, ledger } = await queueTenantWrite(tenant.tenantId, () => readBothInQueue(tenant.tenantId));
  const views = externalViews(posts, ledger).filter((v) => v.removedReason !== 'mistake');
  const byId = new Map(views.map((v) => [v.id, v]));
  const blanked = new Map<string, ExternalBlankedRuns>();
  const note = (weekOf: string, postId: string, reason: ExternalBlankReason) => {
    const k = `${weekOf}|${postId}`;
    const runs = blanked.get(k) ?? { repost: 0, moved: 0 };
    runs[reason] += 1;
    blanked.set(k, runs);
  };
  const adjust = chainAdjust(
    [
      ['repost', repostMask(views)],
      ['moved', appCountedMask(store, tenant, views, ledger)],
    ],
    note,
  );
  const history = await getPublishedHistory(store, tenant, views.map(externalAsLedgerPost), weeksBack, adjust);
  return {
    weeks: history.weeks,
    posts: history.posts.map((p) => ({
      post: p.post,
      external: byId.get(p.post.id)!,
      cells: p.cells,
      blanked: history.weeks.map((w) => blanked.get(`${w.weekOf}|${p.post.id}`) ?? null),
    })),
  };
}
