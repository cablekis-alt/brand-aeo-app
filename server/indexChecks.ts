import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  applyIndexCheck,
  findIndexRecord,
  freshIndexRecord,
  INDEX_CHECKS_FORMAT,
  parseIndexCheckInput,
  parseIndexChecksFile,
  postingsOf,
  type IndexCheckRecord,
  type IndexChecksFile,
  type TenantChecks,
} from '../src/lib/publishStatus.js';
import { EXTERNAL_ID, externalViews } from '../src/lib/externalPosts.js';
import { PIPELINE_DATA_DIR } from './appPaths.js';
import { readExternalPostsInQueue } from './externalPosts.js';
import { readPublishedPostsInQueue, type PublishedPost } from './publishedPosts.js';
import { queueTenantWrite, writeJsonAtomic } from './tenantWriteQueue.js';

/**
 * 색인 확인 기록 — 올린 글이 네이버에 노출되는지 · 구글에 색인됐는지 사람이 검색해 보고 누른 것(data/<tenant>/index-checks.json, 모양은
 * src/lib/publishStatus.ts IndexChecksFile). 원장(published-posts.json)과 따로 둔다 — 원장 모양은 바꾸지 않는다.
 *
 * 원장과 같은 쓰기 줄(tenantWriteQueue.ts)에서 읽고 쓴다 — 윈도우에서는 읽는 중인 파일 위로 rename이 EPERM으로 실패하고, 줄 밖에서 동시에
 * 쓰면 먼저 쓴 표시가 사라진다. 파일이 깨졌으면 읽지도 쓰지도 않는다(빈 기록으로 읽고 덮으면 확인이 통째로 사라진다).
 *
 * 한 주소의 상태는 그 주소 기록(다른 고객 브랜드 포함) 가운데 가장 나중 것이다(src/lib/publishStatus.ts findIndexRecord). 적을 때 그 기록을
 * 이어받으므로, 다른 브랜드의 같은 주소를 동시에 적으면 서로의 표시를 못 보고 덮는다 — 색인 확인 쓰기는 모든 브랜드를 건너 한 줄
 * (INDEX_CHECKS_LOCK)에 세운다. 그 줄 안에서 다른 브랜드 파일은 그 브랜드의 쓰기 줄에서 하나씩 읽는다(줄을 겹쳐 잡지 않는다 — 브랜드 줄
 * 안에서 이 줄을 기다리는 곳은 없다).
 *
 * 웹(Vercel)에는 라우트가 없다(함수 12/12). 화면은 404를 「데스크톱 앱에서만」으로 읽는다.
 */
export const INDEX_CHECKS_FILE = 'index-checks.json';

/** 색인 확인 쓰기 줄 — 브랜드 id에는 /가 들어가지 않으므로 어느 브랜드 줄과도 겹치지 않는다. */
const INDEX_CHECKS_LOCK = 'index-checks/*';

/** 라우트가 그대로 상태 코드로 쓰는 오류. */
export class IndexChecksError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** 기록 id 모양(원장 p-<12자> · legacy-<해시>, 앱 밖 글 x-<12자>) — 경로 글자는 받지 않는다. */
const POST_ID = /^[A-Za-z0-9_-]{1,80}$/;

function filePathFor(tenantId: string): string {
  return path.join(PIPELINE_DATA_DIR, tenantId, INDEX_CHECKS_FILE);
}

/** 쓰기 줄 안에서 읽는다. 없으면 빈 기록, 깨졌으면 500. */
export async function readIndexChecksInQueue(tenantId: string): Promise<Record<string, IndexCheckRecord>> {
  let raw: string;
  try {
    raw = await readFile(filePathFor(tenantId), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new IndexChecksError(`색인 확인 파일(${INDEX_CHECKS_FILE})을 읽지 못했습니다: ${err instanceof Error ? err.message : String(err)}`, 500);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    throw new IndexChecksError(
      `색인 확인 파일(${INDEX_CHECKS_FILE})이 깨져 있어 읽지도 쓰지도 않았습니다: ${err instanceof Error ? err.message : String(err)}`,
      500,
    );
  }
  const checked = parseIndexChecksFile(parsed);
  if (!checked.ok) throw new IndexChecksError(`색인 확인 파일(${INDEX_CHECKS_FILE})의 모양이 맞지 않아 읽지도 쓰지도 않았습니다: ${checked.error}`, 500);
  return checked.checks;
}

/**
 * 다른 고객 브랜드들의 확인 기록 — 브랜드마다 그 쓰기 줄에서 하나씩 읽는다. 파일이 깨진 브랜드는 건너뛴다(발행 현황도 그 브랜드 기록을
 * 쓰지 않고 오류로 알린다).
 */
async function readOthersChecks(tenantIds: readonly string[]): Promise<TenantChecks[]> {
  const out: TenantChecks[] = [];
  for (const other of tenantIds) {
    try {
      out.push({ tenantId: other, checks: await queueTenantWrite(other, () => readIndexChecksInQueue(other)) });
    } catch (err) {
      console.warn(`[indexChecks] ${other}의 ${INDEX_CHECKS_FILE}을 읽지 못해 같은 주소 기록에서 뺍니다:`, err);
    }
  }
  return out;
}

/** 표시를 적을 줄 — 기록 id로 쓸 줄(post), 같은 편으로 묶인 줄 id(ids), 올린 날(앞선 확인을 뺄 기준). */
interface MarkTarget {
  post: { id: string; key: string; url: string };
  ids: string[];
  publishedOn: string | null;
}

/** 원장 줄 — 살아 있는 편이어야 한다(내린 · 뺀 편은 409). */
function ledgerTarget(posts: readonly PublishedPost[], postId: string): MarkTarget {
  const post = posts.find((p) => p.id === postId);
  if (!post) throw new IndexChecksError(`올린 글 기록을 찾지 못했습니다: ${postId}`, 404);
  // 날짜 있는 줄에 밀려 표에 없는 옛 줄은 같은 주소의 살아 있는 편으로 본다.
  const postings = postingsOf([...posts]);
  const posting = postings.find((p) => p.ids.includes(postId)) ?? postings.find((p) => !p.removed && p.post.key === post.key);
  if (!posting || posting.removed) throw new IndexChecksError('내렸거나 잘못 적은 주소로 뺀 글에는 색인 확인을 표시하지 않습니다.', 409);
  return { post, ids: posting.ids, publishedOn: posting.post.publishedOn };
}

/**
 * 앱 밖 글 줄(x- id — server/externalPosts.ts) — 쓰기 줄 안이므로 …InQueue로 읽는다. 살아 있는 줄이어야 한다: 뺀 줄 · 같은 브랜드에 앱 글로
 * 옮겨 쉬는 줄은 409(옮긴 주소는 앱 글 줄에서 표시한다 — 같은 주소 키라 표시가 이어진다, C15). 앱 밖 글 파일이 깨졌으면 500.
 */
async function externalTarget(tenantId: string, postId: string, posts: readonly PublishedPost[]): Promise<MarkTarget> {
  const view = externalViews(await readExternalPostsInQueue(tenantId), posts).find((v) => v.id === postId);
  if (!view) throw new IndexChecksError(`앱 밖 글을 찾지 못했습니다: ${postId}`, 404);
  if (view.state === 'moved') throw new IndexChecksError('같은 브랜드에 앱 글로 옮긴 주소입니다 — 앱 글 줄에서 표시해 주세요(표시는 이어집니다).', 409);
  if (view.state === 'removed') throw new IndexChecksError('뺀 앱 밖 글에는 색인 확인을 표시하지 않습니다.', 409);
  return { post: { id: view.id, key: view.key, url: view.url }, ids: [view.id], publishedOn: view.publishedOn };
}

/**
 * 올린 글 한 편의 한 엔진 확인을 적거나(state) 지운다(null — 미확인으로). postId는 원장에 있는 살아 있는 편의 줄이거나 살아 있는 앱 밖 글
 * 줄(x- id)이어야 한다(내린 · 뺀 · 앱 글로 옮긴 줄은 409). 그 주소의 지금 기록(같은 편의 다른 줄 · 같은 주소 · 다른 고객 브랜드 others의 같은
 * 주소 가운데 가장 나중, 올린 날보다 앞선 확인은 빼고)을 이어받아 다른 엔진 칸이 사라지지 않게 한다 — 앱 밖 줄과 같은 주소의 앱 글 줄도 서로
 * 이어받는다(C15). 확인일 · 출처(manual)는 서버가 정한다.
 */
export function setIndexCheck(
  tenantId: string,
  postId: string,
  body: unknown,
  others: readonly string[] = [],
  now = Date.now(),
): Promise<{ record: IndexCheckRecord }> {
  const input = parseIndexCheckInput(body);
  if (!input.ok) return Promise.reject(new IndexChecksError(input.error, 400));
  if (!POST_ID.test(postId)) return Promise.reject(new IndexChecksError('올린 글 기록 id가 올바르지 않습니다.', 400));
  return queueTenantWrite(INDEX_CHECKS_LOCK, async () => {
    const foreign = await readOthersChecks(others.filter((id) => id !== tenantId));
    return queueTenantWrite(tenantId, async () => {
      const posts = await readPublishedPostsInQueue(tenantId);
      const target = EXTERNAL_ID.test(postId) ? await externalTarget(tenantId, postId, posts) : ledgerTarget(posts, postId);
      const checks = await readIndexChecksInQueue(tenantId);
      const found = findIndexRecord({ tenantId, checks }, foreign, target.ids, target.post.key);
      const base = found ? freshIndexRecord(found.record, target.publishedOn) : null;
      const record = applyIndexCheck(base, target.post, input.engine, input.state, now);
      const file: IndexChecksFile = { format: INDEX_CHECKS_FORMAT, checks: { ...checks, [postId]: record } };
      await writeJsonAtomic(filePathFor(tenantId), file);
      return { record };
    });
  });
}
