import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ARTICLE_URL_REASON, isArticleUrl, KEY_RULE, todayKst, trackingKey } from '../src/lib/publishedUrl.js';
import { readActionStates, writeActionStateInQueue, type ActionStateMap } from './actionStates.js';
import { PIPELINE_DATA_DIR } from './appPaths.js';
import { queueTenantWrite, writeJsonAtomic } from './tenantWriteQueue.js';

/**
 * 집행 원장 — 올린 글 주소를 **주소 한 줄 = 기록 한 줄**로 남긴다(data/<tenant>/published-posts.json).
 *
 * ── 왜 집행 상태(action-states.json)에 붙이지 않는가 ──────────────────────────────
 * 항목 id는 주마다 바뀐다(설치본 사본: 콘텐츠형 약 27%, 등재형 약 19%). 채널 항목 하나를 여러 글이 함께 쓰기도 한다. 항목에
 * 주소를 붙이면 항목이 그 주 목록에서 빠질 때 주소도 안 보이고, 어느 글을 올린 것인지도 남지 않는다. 그래서 주소를 기본 키로
 * 두고 글 · 올린 곳 · 올린 날 · 초안 판을 함께 적는다. 주차별 인용 이력은 저장하지 않는다 — 측정 파일이 재측정 · CI 동기화로
 * 덮이므로, 볼 때 계산한다(늦게 적은 주소도 지난 주차까지 소급된다).
 *
 * ── 지우지 않는다 ─────────────────────────────────────────────────────────────
 * 「빼기」는 표시만 한다(removedAt · removedReason). 「잘못 적은 주소」는 이력에서 빼고, 「글을 내렸어요」는 내린 날까지
 * 이력을 남긴다. 둘 다 되살릴 수 있다.
 *
 * 웹(Vercel)에는 라우트가 없다(함수 12/12). 화면은 404를 「이 환경에는 기록 기능이 없음」으로 읽는다.
 */

export type PostVia = 'own' | 'channel' | 'orphan' | 'direct';
export type RemovedReason = 'mistake' | 'taken-down';
export type PublishedOnSource = 'default-today' | 'user' | 'legacy';

export interface PublishedPost {
  id: string;
  /** 적은 그대로(앞뒤 공백만 뗀다). */
  url: string;
  /** 비교용 키(src/lib/publishedUrl.ts trackingKey). keyRule이 바뀌면 읽을 때 다시 계산한다. */
  key: string;
  /** 올린 날(한국 날짜). null이면 모른다(옛 기록) — 전후 판정이 「모름」이 된다. */
  publishedOn: string | null;
  publishedOnSource: PublishedOnSource;
  /** 기록한 시각. 한 번 쓰면 다시 쓰지 않는다 — 날짜를 고쳐도 남는다. */
  recordedAt: string;
  /** 올린 글 — drafts.json의 키(content:* · topic:* · 덮는 글 없는 listing:*). */
  articleId: string;
  /** 계획에서 이 기록이 붙는 항목. 자사 · 직접이면 articleId와 같고, 채널이면 채널 항목이다. */
  targetActionId: string;
  via: PostVia;
  /** 그때 글 제목. */
  articleTitle?: string;
  /** 그때 초안의 generatedAt — 다시 만들어 초안이 덮여도 어느 판을 올렸는지 남는다. */
  draftGeneratedAt?: string;
  /** 채널용으로 다듬은 글을 올렸으면 그 판의 sourceKey. */
  adaptationSourceKey?: string;
  /** 기록할 때 보던 주차 — 감사용일 뿐 발행 시점으로 쓰지 않는다. */
  viewingWeek?: string;
  removedAt?: string;
  removedReason?: RemovedReason;
  /** 집행 상태 파일에만 있던 옛 주소. 원장 파일에는 없다 — 고치면 원장으로 옮긴다. */
  legacy?: true;
}

interface PublishedPostsFile {
  version: 1;
  keyRule: number;
  posts: PublishedPost[];
}

/** 테넌트당 기록 상한 — 넘으면 조용히 자르지 않고 알린다. */
export const MAX_POSTS = 500;

/** 라우트가 그대로 상태 코드로 쓰는 오류. */
export class PublishedPostsError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** 기록 사본에서 주어진 칸을 뺀다(옛 기록 표시 · 뺀 표시를 지울 때). */
function without(post: PublishedPost, ...keys: ('legacy' | 'removedAt' | 'removedReason')[]): PublishedPost {
  const copy = { ...post };
  for (const k of keys) delete copy[k];
  return copy;
}

function filePathFor(tenantId: string): string {
  return path.join(PIPELINE_DATA_DIR, tenantId, 'published-posts.json');
}

/** 파일만 읽는다. 없으면 빈 목록, 깨졌으면 오류 — 빈 목록으로 읽고 덮어쓰면 기록이 통째로 사라진다. */
async function readFileOnly(tenantId: string): Promise<PublishedPost[]> {
  let raw: string;
  try {
    raw = await readFile(filePathFor(tenantId), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new PublishedPostsError(`집행 기록 파일을 읽지 못했습니다: ${err instanceof Error ? err.message : String(err)}`, 500);
  }
  let parsed: Partial<PublishedPostsFile>;
  try {
    parsed = JSON.parse(raw) as Partial<PublishedPostsFile>;
  } catch (err) {
    throw new PublishedPostsError(
      `집행 기록 파일(published-posts.json)이 깨져 있어 읽지도 쓰지도 않았습니다: ${err instanceof Error ? err.message : String(err)}`,
      500,
    );
  }
  if (!parsed || !Array.isArray(parsed.posts)) {
    throw new PublishedPostsError('집행 기록 파일(published-posts.json)의 모양이 맞지 않아 읽지도 쓰지도 않았습니다.', 500);
  }
  const rule = parsed.keyRule ?? 0;
  return parsed.posts.map((p) => (rule === KEY_RULE ? p : { ...p, key: trackingKey(p.url) ?? p.key }));
}

/** 짧은 해시(djb2) — 옛 기록의 id를 매번 같게 만든다. */
function hashOf(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/** 집행 상태 파일에만 있던 옛 주소 — 원장에 같은 키가 이미 있으면(옮겼거나 뺐다) 다시 보이지 않는다. */
function legacyPosts(states: ActionStateMap, ledger: PublishedPost[]): PublishedPost[] {
  const known = new Set(ledger.map((p) => p.key));
  const out: PublishedPost[] = [];
  for (const [actionId, state] of Object.entries(states)) {
    for (const url of state.publishedUrls ?? []) {
      const key = trackingKey(url);
      if (!key || known.has(key)) continue;
      known.add(key);
      out.push({
        id: `legacy-${hashOf(`${actionId}|${url}`)}`,
        url,
        key,
        publishedOn: null,
        publishedOnSource: 'legacy',
        recordedAt: state.updatedAt,
        articleId: actionId,
        targetActionId: actionId,
        via: 'direct',
        legacy: true,
      });
    }
  }
  return out;
}

async function readAll(tenantId: string): Promise<{ ledger: PublishedPost[]; legacy: PublishedPost[] }> {
  const ledger = await readFileOnly(tenantId);
  return { ledger, legacy: legacyPosts(await readActionStates(tenantId), ledger) };
}

/** 원장 + 옛 기록. 뺀 기록도 함께 준다 — 화면이 「뺀 주소」로 접어 보이고 되살린다. */
export async function readPublishedPosts(tenantId: string): Promise<PublishedPost[]> {
  const { ledger, legacy } = await readAll(tenantId);
  return [...ledger, ...legacy];
}

async function writeLedger(tenantId: string, posts: PublishedPost[]): Promise<void> {
  const file: PublishedPostsFile = { version: 1, keyRule: KEY_RULE, posts: posts.map((p) => without(p, 'legacy')) };
  await writeJsonAtomic(filePathFor(tenantId), file);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 올린 날 검사 — 형식, 실제 날짜, 오늘(한국) 이후가 아님. */
function checkDate(value: unknown): string {
  if (typeof value !== 'string' || !DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new PublishedPostsError('올린 날은 YYYY-MM-DD 형식이어야 합니다.', 400);
  }
  if (new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new PublishedPostsError(`없는 날짜입니다: ${value}`, 400);
  }
  if (value > todayKst()) throw new PublishedPostsError('올린 날이 오늘보다 뒤입니다.', 400);
  if (value < '2020-01-01') throw new PublishedPostsError('올린 날이 너무 이릅니다.', 400);
  return value;
}

const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;

export interface AddPostInput {
  url: unknown;
  articleId: unknown;
  targetActionId: unknown;
  via: unknown;
  articleTitle?: unknown;
  draftGeneratedAt?: unknown;
  adaptationSourceKey?: unknown;
  viewingWeek?: unknown;
  publishedOn?: unknown;
  /** 날짜를 사람이 골랐는가 — 아니면 기본값(오늘)이다. */
  publishedOnChosen?: unknown;
  /** true면 같은 줄 작업에서 그 항목을 「집행함」으로 바꾼다(「올렸어요」). */
  markDone?: unknown;
}

export interface AddPostResult {
  post: PublishedPost;
  posts: PublishedPost[];
  /** markDone이었으면 바뀐 집행 상태. */
  states?: ActionStateMap;
  /** 같은 글 · 같은 곳에 이미 적힌 주소라 새로 쓰지 않았다. */
  existing: boolean;
}

const VIAS: PostVia[] = ['own', 'channel', 'orphan', 'direct'];

export function addPublishedPost(tenantId: string, input: AddPostInput): Promise<AddPostResult> {
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  const check = isArticleUrl(url);
  if (!check.ok) return Promise.reject(new PublishedPostsError(ARTICLE_URL_REASON[check.reason], 400));
  const key = trackingKey(url);
  const articleId = str(input.articleId, 200);
  const targetActionId = str(input.targetActionId, 200);
  const via = VIAS.find((v) => v === input.via);
  if (!key || !articleId || !targetActionId || !via) {
    return Promise.reject(new PublishedPostsError('주소 · 글 · 올린 곳(articleId · targetActionId · via)이 필요합니다.', 400));
  }
  let publishedOn: string;
  try {
    publishedOn = input.publishedOn === undefined ? todayKst() : checkDate(input.publishedOn);
  } catch (err) {
    return Promise.reject(err);
  }
  const markedWeek = str(input.viewingWeek, 20);
  return queueTenantWrite(tenantId, async () => {
    const { ledger, legacy } = await readAll(tenantId);
    const active = [...ledger, ...legacy].find((p) => p.key === key && !p.removedAt);
    let post: PublishedPost;
    let existing = false;
    let posts = ledger;
    if (active && active.articleId === articleId && active.targetActionId === targetActionId) {
      post = active;
      existing = true;
    } else if (active) {
      const name = active.articleTitle ? `「${active.articleTitle}」` : active.articleId;
      throw new PublishedPostsError(`이 주소는 이미 ${name}의 올린 글로 적혀 있습니다. 그 기록을 먼저 빼 주세요.`, 409);
    } else {
      if (ledger.length >= MAX_POSTS) {
        throw new PublishedPostsError(`집행 기록이 ${MAX_POSTS}줄을 넘었습니다. 잘못 적은 주소를 정리한 뒤 다시 시도해 주세요.`, 400);
      }
      post = {
        id: `p-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        url,
        key,
        publishedOn,
        publishedOnSource: input.publishedOn !== undefined && input.publishedOnChosen === true ? 'user' : 'default-today',
        recordedAt: new Date().toISOString(),
        articleId,
        targetActionId,
        via,
        ...(str(input.articleTitle, 200) ? { articleTitle: str(input.articleTitle, 200) } : {}),
        ...(str(input.draftGeneratedAt, 40) ? { draftGeneratedAt: str(input.draftGeneratedAt, 40) } : {}),
        ...(str(input.adaptationSourceKey, 200) ? { adaptationSourceKey: str(input.adaptationSourceKey, 200) } : {}),
        ...(markedWeek ? { viewingWeek: markedWeek } : {}),
      };
      posts = [...ledger, post];
      await writeLedger(tenantId, posts);
    }
    const states =
      input.markDone === true
        ? await writeActionStateInQueue(tenantId, targetActionId, { status: 'done', ...(markedWeek ? { markedWeek } : {}) })
        : undefined;
    return { post, posts: [...posts, ...legacyPosts(await readActionStates(tenantId), posts)], existing, ...(states ? { states } : {}) };
  });
}

export interface PatchPostInput {
  publishedOn?: unknown;
  /** 'mistake' | 'taken-down'이면 뺀다. */
  remove?: unknown;
  /** true면 되살린다. */
  restore?: unknown;
}

export function patchPublishedPost(tenantId: string, postId: string, input: PatchPostInput): Promise<{ post: PublishedPost; posts: PublishedPost[] }> {
  const remove = input.remove === 'mistake' || input.remove === 'taken-down' ? input.remove : undefined;
  if (input.remove !== undefined && !remove) return Promise.reject(new PublishedPostsError('뺀 이유가 올바르지 않습니다.', 400));
  let publishedOn: string | undefined;
  try {
    publishedOn = input.publishedOn === undefined ? undefined : checkDate(input.publishedOn);
  } catch (err) {
    return Promise.reject(err);
  }
  if (!remove && input.restore !== true && publishedOn === undefined) {
    return Promise.reject(new PublishedPostsError('바꿀 것이 없습니다(publishedOn · remove · restore).', 400));
  }
  return queueTenantWrite(tenantId, async () => {
    const { ledger, legacy } = await readAll(tenantId);
    const found = ledger.find((p) => p.id === postId) ?? legacy.find((p) => p.id === postId);
    if (!found) throw new PublishedPostsError(`집행 기록을 찾지 못했습니다: ${postId}`, 404);
    if (input.restore === true && found.removedAt) {
      // 같은 주소가 그사이 다른 기록으로 다시 적혔으면 되살리지 않는다 — 한 주소에 기록이 둘이 된다.
      const clash = ledger.find((p) => p.id !== found.id && p.key === found.key && !p.removedAt);
      if (clash) throw new PublishedPostsError('같은 주소가 다른 기록으로 다시 적혀 있어 되살리지 않았습니다.', 409);
    }
    const base = without(found, 'legacy', 'removedAt', 'removedReason');
    const next: PublishedPost = {
      ...base,
      ...(publishedOn !== undefined ? { publishedOn, publishedOnSource: 'user' as const } : {}),
      ...(remove
        ? { removedAt: new Date().toISOString(), removedReason: remove }
        : input.restore === true || !found.removedAt
          ? {}
          : { removedAt: found.removedAt, ...(found.removedReason ? { removedReason: found.removedReason } : {}) }),
    };
    // 옛 기록을 고치면 원장으로 옮긴다 — 이후 읽기에서는 같은 키라 옛 기록 쪽이 가려진다.
    const posts = found.legacy ? [...ledger, next] : ledger.map((p) => (p.id === postId ? next : p));
    await writeLedger(tenantId, posts);
    return { post: next, posts: [...posts, ...legacyPosts(await readActionStates(tenantId), posts)] };
  });
}
