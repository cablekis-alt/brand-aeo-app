import { readFile } from 'node:fs/promises';
import type { IgnoredPost } from '../src/lib/postImport.js';
import { KEY_RULE, trackingKey } from '../src/lib/publishedUrl.js';
import { stateFilePath } from './appPaths.js';
import { queueTenantWrite, writeJsonAtomic } from './tenantWriteQueue.js';

/**
 * 「새 글 찾기」에서 숨긴 주소(무시 목록) — 앱 전체에 하나(stateFilePath('post-import-ignored.json') — 저장한 블로그 blog-sources.json과 같은
 * 자리, 그 파일과 따로 둔다: 블로그 목록은 저장할 때마다 통째로 다시 쓴다). 앱 글도 앱 밖 글도 아닌 글(작성자의 다른 글 · 지운 글)이 새 글
 * 찾기에 매번 다시 나오지 않게 한다. 원장 · 앱 밖 글 파일과 상관없다 — 숨기기만 한다.
 *
 * 줄마다 읽을 때 나온 주소 모양(붙여 넣은 · 읽은 · 적을 주소)과 그 추적 키를 모두 둔다 — 목록 주소와 정식 주소의 모양이 달라도 숨고, 그 가운데
 * 하나로 등록하면 풀린다(C11). 키 규칙(KEY_RULE)이 바뀌면 읽을 때 주소로 키를 다시 계산한다. 파일이 깨졌으면 읽지도 쓰지도 않는다(빈 목록으로
 * 읽고 덮으면 숨긴 주소가 통째로 다시 나온다).
 *
 * 쓰기 줄은 브랜드 쓰기 줄과 겹치지 않는 이름(LOCK — 브랜드 id에는 /가 없다)이다. 이 줄 안에서는 이 파일만 읽고 쓴다 — 브랜드 파일을 읽지
 * 않는다(브랜드 줄 안에서 이 줄을 기다리는 곳도 없다). 그래서 등록과 무시가 엇갈려 멈추지 않는다(C18). 「등록하면 무시를 푼다」는 브랜드
 * 쓰기가 끝난 뒤 줄 밖에서 부른다(server/postImport.ts). 「무시한 글 보기 · 되돌리기」(GET /api/post-import/ignored · POST
 * /api/post-import/unignore)도 이 줄만 쓴다.
 */
export const IGNORED_FILE = 'post-import-ignored.json';
const IGNORED_FORMAT = 'post-import-ignored/1';
/** 무시 목록 상한 — 넘으면 조용히 자르지 않고 알린다. */
export const IGNORED_MAX = 5000;
const LOCK = 'post-import-ignored/*';

/** 무시 줄 — 화면과 같은 모양(src/lib/postImport.ts IgnoredPost: 주소 · 읽을 때 나온 주소 모양 · 그 추적 키 · 무시한 때). */
export type IgnoredEntry = IgnoredPost;

/** 라우트 · 등록이 그대로 상태 코드로 쓰는 오류. */
export class IgnoredListError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const filePath = () => stateFilePath(IGNORED_FILE);
const keysOf = (urls: readonly string[]) => [...new Set(urls.map((u) => trackingKey(u)).filter((k): k is string => k !== null))];
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** 파일 검사 — 모양이 하나라도 틀리면 깨진 파일이다. 키 규칙이 지금과 다르면 주소로 키를 다시 계산한다. 모르는 칸은 그대로 둔다. */
function parseIgnored(raw: unknown): IgnoredEntry[] {
  const file = raw as { format?: unknown; keyRule?: unknown; ignored?: unknown } | null;
  if (!file || typeof file !== 'object' || file.format !== IGNORED_FORMAT || !Array.isArray(file.ignored)) {
    throw new IgnoredListError(`무시 목록(${IGNORED_FILE})의 모양이 맞지 않아 읽지도 쓰지도 않았습니다.`, 500);
  }
  const sameRule = file.keyRule === KEY_RULE;
  return file.ignored.map((e: unknown, i: number) => {
    const entry = e as Partial<IgnoredEntry> | null;
    if (!entry || typeof entry.url !== 'string' || !isStrings(entry.urls) || !isStrings(entry.keys) || typeof entry.ignoredAt !== 'string') {
      throw new IgnoredListError(`무시 목록(${IGNORED_FILE})의 ${i + 1}번째 줄 모양이 맞지 않아 읽지도 쓰지도 않았습니다.`, 500);
    }
    return { ...(entry as IgnoredEntry), keys: sameRule ? entry.keys : keysOf(entry.urls) };
  });
}

async function readInLock(): Promise<IgnoredEntry[]> {
  let text: string;
  try {
    text = await readFile(filePath(), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new IgnoredListError(`무시 목록(${IGNORED_FILE})을 읽지 못했습니다: ${err instanceof Error ? err.message : String(err)}`, 500);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    throw new IgnoredListError(`무시 목록(${IGNORED_FILE})이 깨져 있어 읽지도 쓰지도 않았습니다: ${err instanceof Error ? err.message : String(err)}`, 500);
  }
  return parseIgnored(parsed);
}

async function writeInLock(entries: IgnoredEntry[]): Promise<void> {
  await writeJsonAtomic(filePath(), { format: IGNORED_FORMAT, keyRule: KEY_RULE, ignored: entries });
}

/** 무시 목록. 없으면 빈 목록, 깨졌으면 IgnoredListError(500). */
export function readIgnored(): Promise<IgnoredEntry[]> {
  return queueTenantWrite(LOCK, readInLock);
}

/** 주소의 추적 키 → 무시한 때(가장 이른 것). */
export function ignoredAtByKey(entries: readonly IgnoredEntry[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of entries) for (const k of e.keys) if (!out.has(k) || e.ignoredAt < out.get(k)!) out.set(k, e.ignoredAt);
  return out;
}

/**
 * 주소들을 무시 목록에 더한다 — 줄마다 그 주소 모양들(urls[0]이 그 줄의 주소). 키가 하나라도 이미 있으면 그 줄은 existing(그대로 둔다).
 * 상한을 넘으면 하나도 쓰지 않고 400. 결과는 줄 순서 그대로.
 */
export function addIgnored(items: readonly { urls: readonly string[] }[], now = new Date()): Promise<('added' | 'existing')[]> {
  return queueTenantWrite(LOCK, async () => {
    const entries = await readInLock();
    const known = new Set(entries.flatMap((e) => e.keys));
    const added: IgnoredEntry[] = [];
    const results = items.map((item): 'added' | 'existing' => {
      const keys = keysOf(item.urls);
      if (keys.length === 0 || keys.some((k) => known.has(k))) return 'existing';
      for (const k of keys) known.add(k);
      added.push({ url: item.urls[0]!, urls: [...new Set(item.urls)], keys, ignoredAt: now.toISOString() });
      return 'added';
    });
    if (added.length === 0) return results;
    if (entries.length + added.length > IGNORED_MAX) {
      throw new IgnoredListError(`무시 목록이 ${IGNORED_MAX}개를 넘어 더 적지 않았습니다. 관리자에게 정리를 요청해 주세요.`, 400);
    }
    await writeInLock([...entries, ...added]);
    return results;
  });
}

/** 최근에 무시한 것부터(같은 때면 나중에 적은 것부터 — 파일은 적은 순서다). */
const newestFirst = (entries: readonly IgnoredEntry[]) =>
  entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.ignoredAt < b.e.ignoredAt ? 1 : a.e.ignoredAt > b.e.ignoredAt ? -1 : b.i - a.i))
    .map(({ e }) => e);

/** 「무시한 글 보기」 — 최근 것부터. 없으면 빈 목록, 깨졌으면 IgnoredListError(500). */
export async function listIgnored(): Promise<IgnoredEntry[]> {
  return newestFirst(await readIgnored());
}

/** 이 키들 가운데 하나라도 가진 무시 줄을 뺀다 — 뺀 줄 수와 남은 줄. 뺄 줄이 없으면 파일을 쓰지 않는다. */
function removeKeys(keys: readonly string[]): Promise<{ removed: number; kept: IgnoredEntry[] }> {
  const wanted = new Set(keys);
  return queueTenantWrite(LOCK, async () => {
    const entries = await readInLock();
    const kept = entries.filter((e) => !e.keys.some((k) => wanted.has(k)));
    if (kept.length !== entries.length) await writeInLock(kept);
    return { removed: entries.length - kept.length, kept };
  });
}

/** 이 키들 가운데 하나라도 가진 무시 줄을 뺀다(등록한 주소 — 무시가 풀린다). 뺀 줄 수. 없으면 파일을 쓰지 않는다. */
export async function unignoreKeys(keys: readonly string[]): Promise<number> {
  return (await removeKeys(keys)).removed;
}

/**
 * 「되돌리기」 — 이 주소들(무시 줄의 주소 모양 가운데 어느 것이든)의 무시를 푼다. 키는 지금 규칙으로 계산한다(읽을 때 파일의 키도 같은 규칙으로
 * 다시 계산된다 — C11). 푼 줄 수와 남은 목록(최근 것부터).
 */
export async function unignoreUrls(urls: readonly string[]): Promise<{ removed: number; ignored: IgnoredEntry[] }> {
  const { removed, kept } = await removeKeys(keysOf(urls));
  return { removed, ignored: newestFirst(kept) };
}
