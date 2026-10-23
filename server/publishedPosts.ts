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

export interface TopicSnapshot {
  bankVersion: string | null;
  questionIds: string[];
  questionTexts: string[];
}

/** 질문 스냅샷 상한 — 한 글이 다루는 질문은 많아야 수십 개다. */
const TOPIC_MAX_QUESTIONS = 60;
/** 항목 id 상한 — topic: 글은 고른 질문 id를 +로 이으므로 질문 60개 × id 60자를 받는다. */
const MAX_ID_LENGTH = 'topic:'.length + TOPIC_MAX_QUESTIONS * 61;

/**
 * topic 스냅샷 검사. topic: 글이 아니면 받지 않는다. questionIds는 문자열 배열, 문장은 id와 개수가 같거나(은행을 알 때) 비어
 * 있어야 한다(은행을 모를 때). 틀리면 400 — 잘못된 스냅샷을 남기면 나중 결과가 엉뚱한 질문을 가리킨다.
 */
function checkTopic(value: unknown, articleId: string): TopicSnapshot | undefined {
  if (value === undefined || value === null) return undefined;
  if (!articleId.startsWith('topic:')) throw new PublishedPostsError('질문 스냅샷은 질문 은행에서 고른 글(topic:)에만 붙습니다.', 400);
  const v = value as Record<string, unknown>;
  const ids = v.questionIds;
  const texts = v.questionTexts ?? [];
  const isStrings = (a: unknown, max: number): a is string[] =>
    Array.isArray(a) && a.length <= TOPIC_MAX_QUESTIONS && a.every((x) => typeof x === 'string' && x.length > 0 && x.length <= max);
  if (!isStrings(ids, 60) || ids.length === 0) throw new PublishedPostsError('질문 스냅샷의 questionIds가 올바르지 않습니다.', 400);
  // 스냅샷은 그 글의 질문이어야 한다 — topic: id는 고른 질문 id를 정렬해 +로 이은 것이다.
  if (`topic:${ids.join('+')}` !== articleId) {
    throw new PublishedPostsError('질문 스냅샷의 질문이 글(topic:)의 질문과 다릅니다.', 400);
  }
  if (!Array.isArray(texts) || (texts.length > 0 && !isStrings(texts, 400))) {
    throw new PublishedPostsError('질문 스냅샷의 questionTexts가 올바르지 않습니다.', 400);
  }
  const bankVersion = typeof v.bankVersion === 'string' && v.bankVersion.trim() ? v.bankVersion.trim().slice(0, 20) : null;
  if (bankVersion && texts.length !== ids.length) {
    throw new PublishedPostsError('질문 스냅샷의 문장 수가 질문 수와 다릅니다.', 400);
  }
  if (!bankVersion && texts.length > 0) throw new PublishedPostsError('은행 버전 없이 질문 문장만 남길 수는 없습니다.', 400);
  return { bankVersion, questionIds: [...ids], questionTexts: bankVersion ? [...(texts as string[])] : [] };
}
export type RemovedReason = 'mistake' | 'taken-down';
export type PublishedOnSource = 'default-today' | 'user' | 'legacy';

/**
 * 올린 글을 고친 날 — 원문이 바뀌어 채널용 글을 다시 만들고 블로그의 기존 글을 수정했을 때 남긴다. 주소가 그대로라 기록은 하나인데
 * 글 내용이 바뀌었으니, 고친 뒤 측정을 따로 보아야 옛 글 · 새 글 가운데 무엇이 인용됐는지 가늠할 수 있다(성과 표 · 회차 보기).
 */
export interface PostEdit {
  /** 고친 날(한국 날짜). 한 글에 같은 날은 한 번. */
  editedOn: string;
  /** 기록한 시각. */
  recordedAt: string;
  /** 고칠 때 붙여 넣은 판 — 그때 초안의 generatedAt · 채널용 다듬은 글의 sourceKey. */
  draftGeneratedAt?: string;
  adaptationSourceKey?: string;
}

/** 한 글에 남길 수 있는 고친 날 수 — 넘으면 조용히 자르지 않고 알린다. */
export const MAX_EDITS = 30;

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
  /**
   * 질문 은행에서 고른 질문으로 쓴 글(topic:)의 질문 스냅샷. 질문 id의 뜻은 은행 판마다 바뀌므로(ktcorp v4→v5) 그때의 은행 버전과
   * 문장을 함께 고정한다. bankVersion이 null이면 그때의 은행을 몰라 문장도 없다 — 겨냥한 질문의 결과는 확인 불가로 둔다.
   */
  topic?: TopicSnapshot;
  /** 고친 날(오래된 순). 같은 주소를 여러 줄(자사 · 채널)에 적었으면 그 줄들에 같은 목록을 둔다. */
  edits?: PostEdit[];
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
  /** 응답에 함께 싣는 값 — 409면 가로막은 기록(conflict). */
  readonly detail: Record<string, unknown>;
  constructor(message: string, status: number, detail: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.detail = detail;
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

/**
 * 집행 상태 파일에만 있던 옛 주소 — 원장에 **같은 곳 · 같은 키**의 줄이 이미 있으면(옮겼거나 뺐다) 다시 보이지 않는다. 같은 글을
 * 다른 곳(채널 줄)에 같은 주소로 적었다고 이 곳의 옛 기록이 사라지면 안 된다.
 */
function legacyPosts(states: ActionStateMap, ledger: PublishedPost[]): PublishedPost[] {
  const known = new Set(ledger.map((p) => `${p.targetActionId}|${p.key}`));
  const out: PublishedPost[] = [];
  for (const [actionId, state] of Object.entries(states)) {
    for (const url of state.publishedUrls ?? []) {
      const key = trackingKey(url);
      if (!key || known.has(`${actionId}|${key}`)) continue;
      known.add(`${actionId}|${key}`);
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

/**
 * 원장 + 옛 기록. 뺀 기록도 함께 준다 — 화면이 「뺀 주소」로 접어 보이고 되살린다.
 * 읽기도 쓰기 줄에 세운다 — 윈도우에서는 읽는 중인 파일 위로 rename이 실패해(EPERM), 화면 여러 곳이 동시에 불러오면 「올렸어요」가
 * 실패했다(검토 실측: 읽기 2개를 쉬지 않고 걸면 80건 중 3건).
 */
export function readPublishedPosts(tenantId: string): Promise<PublishedPost[]> {
  return queueTenantWrite(tenantId, async () => {
    const { ledger, legacy } = await readAll(tenantId);
    return [...ledger, ...legacy];
  });
}

async function writeLedger(tenantId: string, posts: PublishedPost[]): Promise<void> {
  const file: PublishedPostsFile = { version: 1, keyRule: KEY_RULE, posts: posts.map((p) => without(p, 'legacy')) };
  await writeJsonAtomic(filePathFor(tenantId), file);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 올린 날 · 고친 날 검사 — 형식, 실제 날짜, 오늘(한국) 이후가 아님. */
function checkDate(value: unknown, label = '올린 날'): string {
  if (typeof value !== 'string' || !DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new PublishedPostsError(`${label}은 YYYY-MM-DD 형식이어야 합니다.`, 400);
  }
  if (new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new PublishedPostsError(`없는 날짜입니다: ${value}`, 400);
  }
  if (value > todayKst()) throw new PublishedPostsError(`${label}이 오늘보다 뒤입니다.`, 400);
  if (value < '2020-01-01') throw new PublishedPostsError(`${label}이 너무 이릅니다.`, 400);
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
  /** topic: 글의 질문 스냅샷(TopicSnapshot). */
  topic?: unknown;
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

/**
 * 줄을 하나 더 살릴 자리가 있는가 — 새 기록 · 옛 기록 옮기기 · 되살리기가 함께 쓴다. 상한은 뺀 적 없는 기록으로 센다(뺀 기록까지
 * 세면 정리해도 자리가 나지 않는다). 파일이 끝없이 커지지 않게 뺀 기록을 포함한 전체 상한도 둔다.
 */
function assertRoom(ledger: PublishedPost[]): void {
  if (ledger.filter((p) => !p.removedAt).length >= MAX_POSTS) {
    throw new PublishedPostsError(`올린 글 기록이 ${MAX_POSTS}개를 넘었습니다. 잘못 적은 주소를 빼고 다시 시도해 주세요.`, 400);
  }
  if (ledger.length >= MAX_POSTS * 4) {
    throw new PublishedPostsError(`집행 기록 파일이 ${MAX_POSTS * 4}줄(뺀 기록 포함)을 넘었습니다. 관리자에게 정리를 요청해 주세요.`, 400);
  }
}

export function addPublishedPost(tenantId: string, input: AddPostInput): Promise<AddPostResult> {
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  const check = isArticleUrl(url);
  if (!check.ok) return Promise.reject(new PublishedPostsError(ARTICLE_URL_REASON[check.reason], 400));
  const key = trackingKey(url);
  // 항목 id는 자르지 않는다 — 잘린 id로 적으면 기록과 집행 상태가 그 글에서 떨어져 나간다(질문을 많이 고른 topic: 글).
  if ([input.articleId, input.targetActionId].some((v) => typeof v === 'string' && v.trim().length > MAX_ID_LENGTH)) {
    return Promise.reject(new PublishedPostsError(`글 · 올린 곳 id가 너무 깁니다(${MAX_ID_LENGTH}자까지). 한 글에 고른 질문을 줄여 주세요.`, 400));
  }
  const articleId = str(input.articleId, MAX_ID_LENGTH);
  const targetActionId = str(input.targetActionId, MAX_ID_LENGTH);
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
  let topic: TopicSnapshot | undefined;
  try {
    topic = checkTopic(input.topic, articleId);
  } catch (err) {
    return Promise.reject(err);
  }
  const markedWeek = str(input.viewingWeek, 20);
  return queueTenantWrite(tenantId, async () => {
    const { ledger, legacy } = await readAll(tenantId);
    const actives = [...ledger, ...legacy].filter((p) => p.key === key && !p.removedAt);
    // 한 주소는 한 글의 것이다 — 다른 글에 적힌 주소면 거절한다. 같은 글은 여러 곳(자사 블로그 줄 · 그 블로그가 속한 채널 줄)에
    // 함께 적을 수 있다. 옛 기록은 어느 글인지 모르므로(articleId = 항목) 「다른 글」로 단정하지 않고, 같은 곳이면 같은 기록으로 본다.
    const sameTarget = actives.find((p) => p.targetActionId === targetActionId && (p.articleId === articleId || p.legacy));
    const otherArticle = actives.find((p) => p !== sameTarget && !p.legacy && p.articleId !== articleId);
    if (otherArticle) {
      const name = otherArticle.articleTitle ? `「${otherArticle.articleTitle}」` : otherArticle.articleId;
      const where = otherArticle.viewingWeek ? ` ${otherArticle.viewingWeek} 화면에서 적은 기록입니다.` : '';
      throw new PublishedPostsError(`이 주소는 이미 다른 글 ${name}의 올린 주소로 적혀 있습니다.${where} 그 기록을 빼야 이 글에 적을 수 있습니다.`, 409, {
        conflict: { id: otherArticle.id, articleId: otherArticle.articleId, targetActionId: otherArticle.targetActionId, viewingWeek: otherArticle.viewingWeek ?? null },
      });
    }
    let post: PublishedPost;
    let existing = false;
    let posts = ledger;
    const chosenDate = input.publishedOn !== undefined && input.publishedOnChosen === true;
    // 같은 글 · 같은 주소 · 같은 올린 날로 이미 적은 줄(한 편의 글)에 고친 날이 있으면 새 줄도 그 목록을 이어받는다 — 줄마다 목록이
    // 갈라지면 성과 표 대표 줄에 따라 「고침」이 보였다 안 보였다 한다.
    const inheritedEdits = (on: string | null) =>
      on ? unionEdits(ledger.filter((p) => !p.removedAt && p.key === key && p.articleId === articleId && p.publishedOn === on).map((p) => p.edits)) : [];
    if (sameTarget?.legacy) {
      // 옛 기록을 다시 적으면 원장으로 옮긴다 — 이제야 어느 글인지 안다. 올린 날은 사람이 골랐을 때만 채운다 — 모르는 날을 오늘로
      // 채우면 지난 주 인용이 「올리기 전 측정」이 되어 사라진다.
      assertRoom(ledger);
      existing = true;
      const inherited = inheritedEdits(chosenDate ? publishedOn : null);
      post = {
        ...without(sameTarget, 'legacy'),
        articleId,
        via,
        publishedOn: chosenDate ? publishedOn : null,
        publishedOnSource: chosenDate ? 'user' : 'legacy',
        ...(str(input.articleTitle, 200) ? { articleTitle: str(input.articleTitle, 200) } : {}),
        ...(markedWeek ? { viewingWeek: markedWeek } : {}),
        ...(topic ? { topic } : {}),
        ...(inherited.length > 0 ? { edits: inherited } : {}),
      };
      posts = [...ledger, post];
      await writeLedger(tenantId, posts);
    } else if (sameTarget) {
      existing = true;
      // 같은 주소를 날짜를 골라 다시 적었으면 그 날로 고친다 — 날짜를 버리고 성공처럼 보이면 틀린 날이 그대로 남는다.
      // 질문 스냅샷이 없던 기록이면 이번에 받은 것을 붙인다.
      const redate = chosenDate && sameTarget.publishedOn !== publishedOn;
      const earliestEdit = sameTarget.edits?.[0]?.editedOn;
      if (redate && earliestEdit && earliestEdit < publishedOn) {
        throw new PublishedPostsError(`올린 날을 고친 날(${earliestEdit})보다 뒤로 옮길 수 없습니다.`, 400);
      }
      const addTopic = Boolean(topic && !sameTarget.topic);
      if (redate || addTopic) {
        post = {
          ...sameTarget,
          ...(redate ? { publishedOn, publishedOnSource: 'user' as const } : {}),
          ...(addTopic && topic ? { topic } : {}),
        };
        posts = ledger.map((p) => (p.id === sameTarget.id ? post : p));
        await writeLedger(tenantId, posts);
      } else {
        post = sameTarget;
      }
    } else {
      assertRoom(ledger);
      const inherited = inheritedEdits(publishedOn);
      post = {
        id: `p-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        url,
        key,
        publishedOn,
        publishedOnSource: chosenDate ? 'user' : 'default-today',
        recordedAt: new Date().toISOString(),
        articleId,
        targetActionId,
        via,
        ...(str(input.articleTitle, 200) ? { articleTitle: str(input.articleTitle, 200) } : {}),
        ...(str(input.draftGeneratedAt, 40) ? { draftGeneratedAt: str(input.draftGeneratedAt, 40) } : {}),
        ...(str(input.adaptationSourceKey, 200) ? { adaptationSourceKey: str(input.adaptationSourceKey, 200) } : {}),
        ...(markedWeek ? { viewingWeek: markedWeek } : {}),
        ...(topic ? { topic } : {}),
        ...(inherited.length > 0 ? { edits: inherited } : {}),
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
  /** 고친 날을 남긴다 — { editedOn, draftGeneratedAt?, adaptationSourceKey? }. 같은 날이면 그 판으로 바꾼다. */
  addEdit?: unknown;
  /** 잘못 남긴 고친 날(YYYY-MM-DD)을 뺀다. */
  removeEdit?: unknown;
}

/** 여러 줄의 고친 날 목록을 합친다 — 같은 날이면 나중에 기록한 판을 둔다(오래된 순). */
function unionEdits(lists: (PostEdit[] | undefined)[]): PostEdit[] {
  const byDay = new Map<string, PostEdit>();
  for (const list of lists) {
    for (const e of list ?? []) {
      const cur = byDay.get(e.editedOn);
      if (!cur || cur.recordedAt < e.recordedAt) byDay.set(e.editedOn, e);
    }
  }
  return [...byDay.values()].sort((a, b) => a.editedOn.localeCompare(b.editedOn));
}

/** 고친 날 목록에 하나를 넣거나 뺀 결과(오래된 순). */
function nextEdits(current: PostEdit[] | undefined, add: PostEdit | undefined, removeOn: string | undefined): PostEdit[] {
  let list = [...(current ?? [])];
  if (removeOn !== undefined) {
    if (!list.some((e) => e.editedOn === removeOn)) throw new PublishedPostsError(`그 날 고친 기록이 없습니다: ${removeOn}`, 400);
    list = list.filter((e) => e.editedOn !== removeOn);
  }
  if (add) {
    list = [...list.filter((e) => e.editedOn !== add.editedOn), add];
    if (list.length > MAX_EDITS) throw new PublishedPostsError(`고친 날은 한 글에 ${MAX_EDITS}번까지 남길 수 있습니다.`, 400);
  }
  return list.sort((a, b) => a.editedOn.localeCompare(b.editedOn));
}

export function patchPublishedPost(tenantId: string, postId: string, input: PatchPostInput): Promise<{ post: PublishedPost; posts: PublishedPost[] }> {
  const remove = input.remove === 'mistake' || input.remove === 'taken-down' ? input.remove : undefined;
  if (input.remove !== undefined && !remove) return Promise.reject(new PublishedPostsError('뺀 이유가 올바르지 않습니다.', 400));
  let publishedOn: string | undefined;
  let addEdit: PostEdit | undefined;
  let removeEdit: string | undefined;
  try {
    publishedOn = input.publishedOn === undefined ? undefined : checkDate(input.publishedOn);
    if (input.addEdit !== undefined) {
      const raw = (input.addEdit ?? {}) as Record<string, unknown>;
      const draftGeneratedAt = str(raw.draftGeneratedAt, 40);
      const adaptationSourceKey = str(raw.adaptationSourceKey, 200);
      addEdit = {
        editedOn: checkDate(raw.editedOn, '고친 날'),
        recordedAt: new Date().toISOString(),
        ...(draftGeneratedAt ? { draftGeneratedAt } : {}),
        ...(adaptationSourceKey ? { adaptationSourceKey } : {}),
      };
    }
    removeEdit = input.removeEdit === undefined ? undefined : checkDate(input.removeEdit, '고친 날');
  } catch (err) {
    return Promise.reject(err);
  }
  if (!remove && input.restore !== true && publishedOn === undefined && !addEdit && removeEdit === undefined) {
    return Promise.reject(new PublishedPostsError('바꿀 것이 없습니다(publishedOn · remove · restore · addEdit · removeEdit).', 400));
  }
  return queueTenantWrite(tenantId, async () => {
    const { ledger, legacy } = await readAll(tenantId);
    const found = ledger.find((p) => p.id === postId) ?? legacy.find((p) => p.id === postId);
    if (!found) throw new PublishedPostsError(`집행 기록을 찾지 못했습니다: ${postId}`, 404);
    // 고친 날은 올린 날 뒤에만 선다 — 올린 날을 모르면 앞뒤를 잴 수 없다. 올린 날을 고친 날 뒤로 옮기는 것도 막는다.
    const effectivePublishedOn = publishedOn ?? found.publishedOn;
    const editsChanged = Boolean(addEdit) || removeEdit !== undefined;
    if (addEdit) {
      if (found.removedAt && input.restore !== true) throw new PublishedPostsError('뺀 기록에는 고친 날을 남기지 않습니다.', 400);
      if (!effectivePublishedOn) throw new PublishedPostsError('올린 날을 모르는 기록입니다 — 올린 날을 먼저 적어 주세요.', 400);
    }
    // 한 편의 글 — 같은 글 · 같은 주소 · 같은 올린 날로 적은 다른 줄(자사 블로그 줄 · 그 블로그의 채널 줄). 성과 표가 한 행으로 묶는 범위와
    // 같다(distinctPostings). 올린 날이 다른 줄은 따로 올린 글이라 고친 날을 나누지 않는다 — 나누면 그 줄의 올린 날보다 앞선 고친 날이 생긴다.
    const siblings = ledger.filter(
      (p) => p.id !== found.id && !p.removedAt && p.key === found.key && p.articleId === found.articleId && p.publishedOn === effectivePublishedOn,
    );
    const restoring = input.restore === true && Boolean(found.removedAt);
    // 고친 날은 묶음 전체의 목록(합친 것)에 더하고 뺀다 — 한 줄의 목록으로 다른 줄을 덮으면 그 줄에만 있던 고친 날이 사라진다. 되살린
    // 줄은 지금 살아 있는 줄의 목록을 따른다(뺀 동안 바뀐 고친 날).
    const edits = editsChanged
      ? nextEdits(unionEdits([found.edits, ...siblings.map((s) => s.edits)]), addEdit, removeEdit)
      : restoring && siblings.length > 0
        ? unionEdits(siblings.map((s) => s.edits))
        : found.edits;
    // 앞뒤 검사는 이번에 올린 날이나 고친 날이 바뀔 때만 — 빼기 · 되살리기를 저장된 값 때문에 막지 않는다.
    const earliestEdit = edits?.[0]?.editedOn;
    if ((publishedOn !== undefined || editsChanged) && earliestEdit && effectivePublishedOn && earliestEdit < effectivePublishedOn) {
      throw new PublishedPostsError(
        addEdit && addEdit.editedOn === earliestEdit
          ? `고친 날(${earliestEdit})이 올린 날(${effectivePublishedOn})보다 앞입니다.`
          : `올린 날을 고친 날(${earliestEdit})보다 뒤로 옮길 수 없습니다.`,
        400,
      );
    }
    if (input.restore === true && found.removedAt) {
      // 지금 규칙으로 받지 않는 주소(예: 규칙을 강화하기 전에 적은 관리 화면 주소)는 되살리지 않는다 — 적을 때와 같은 검사.
      const check = isArticleUrl(found.url);
      if (!check.ok) throw new PublishedPostsError(`되살리지 않았습니다 — ${ARTICLE_URL_REASON[check.reason]}`, 400);
      // 같은 주소가 그사이 다른 글이나 같은 곳에 다시 적혔으면 되살리지 않는다 — 한 주소가 두 글의 것이 되거나 한 곳에 두 번 붙는다.
      const clash = ledger.find(
        (p) =>
          p.id !== found.id &&
          p.key === found.key &&
          !p.removedAt &&
          (p.articleId !== found.articleId || p.targetActionId === found.targetActionId),
      );
      if (clash) throw new PublishedPostsError('같은 주소가 다른 기록으로 다시 적혀 있어 되살리지 않았습니다.', 409);
      assertRoom(ledger);
    }
    if (found.legacy) assertRoom(ledger);
    const editsTouched = editsChanged || (restoring && siblings.length > 0);
    const withEdits = (p: PublishedPost): PublishedPost => {
      if (!editsTouched) return p;
      const copy = { ...p };
      if (edits && edits.length > 0) copy.edits = edits;
      else delete copy.edits;
      return copy;
    };
    const base = without(found, 'legacy', 'removedAt', 'removedReason');
    const next: PublishedPost = withEdits({
      ...base,
      ...(publishedOn !== undefined ? { publishedOn, publishedOnSource: 'user' as const } : {}),
      ...(remove
        ? { removedAt: new Date().toISOString(), removedReason: remove }
        : input.restore === true || !found.removedAt
          ? {}
          : { removedAt: found.removedAt, ...(found.removedReason ? { removedReason: found.removedReason } : {}) }),
    });
    // 고친 날이 바뀌었으면 묶음의 다른 줄에도 같은 목록을 둔다 — 한 편의 글이다.
    const siblingIds = new Set(editsChanged ? siblings.map((s) => s.id) : []);
    // 옛 기록을 고치면 원장으로 옮긴다 — 이후 읽기에서는 같은 키라 옛 기록 쪽이 가려진다.
    const posts = (found.legacy ? [...ledger, next] : ledger.map((p) => (p.id === postId ? next : p))).map((p) => (siblingIds.has(p.id) ? withEdits(p) : p));
    await writeLedger(tenantId, posts);
    return { post: next, posts: [...posts, ...legacyPosts(await readActionStates(tenantId), posts)] };
  });
}
