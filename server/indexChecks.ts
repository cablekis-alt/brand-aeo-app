import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  applyIndexCheck,
  findIndexRecord,
  INDEX_CHECKS_FORMAT,
  parseIndexCheckInput,
  parseIndexChecksFile,
  postingsOf,
  type IndexCheckRecord,
  type IndexChecksFile,
} from '../src/lib/publishStatus.js';
import { PIPELINE_DATA_DIR } from './appPaths.js';
import { readPublishedPostsInQueue } from './publishedPosts.js';
import { queueTenantWrite, writeJsonAtomic } from './tenantWriteQueue.js';

/**
 * 색인 확인 기록 — 올린 글이 네이버에 노출되는지 · 구글에 색인됐는지 사람이 검색해 보고 누른 것(data/<tenant>/index-checks.json, 모양은
 * src/lib/publishStatus.ts IndexChecksFile). 원장(published-posts.json)과 따로 둔다 — 원장 모양은 바꾸지 않는다.
 *
 * 원장과 같은 쓰기 줄(tenantWriteQueue.ts)에서 읽고 쓴다 — 윈도우에서는 읽는 중인 파일 위로 rename이 EPERM으로 실패하고, 줄 밖에서 동시에
 * 쓰면 먼저 쓴 표시가 사라진다. 파일이 깨졌으면 읽지도 쓰지도 않는다(빈 기록으로 읽고 덮으면 확인이 통째로 사라진다).
 *
 * 웹(Vercel)에는 라우트가 없다(함수 12/12). 화면은 404를 「데스크톱 앱에서만」으로 읽는다.
 */
export const INDEX_CHECKS_FILE = 'index-checks.json';

/** 라우트가 그대로 상태 코드로 쓰는 오류. */
export class IndexChecksError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** 원장 기록 id 모양(p-<12자> · legacy-<해시>) — 경로 글자는 받지 않는다. */
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
 * 올린 글 한 편의 한 엔진 확인을 적거나(state) 지운다(null — 미확인으로). postId는 원장에 있는 줄이어야 한다(옛 기록 포함). 같은 편의 다른
 * 줄이나 같은 주소로 적은 기록이 있으면 그 기록을 이어받아 다른 엔진 칸이 사라지지 않게 한다. 확인일 · 출처(manual)는 서버가 정한다.
 */
export function setIndexCheck(tenantId: string, postId: string, body: unknown, now = Date.now()): Promise<{ record: IndexCheckRecord }> {
  const input = parseIndexCheckInput(body);
  if (!input.ok) return Promise.reject(new IndexChecksError(input.error, 400));
  if (!POST_ID.test(postId)) return Promise.reject(new IndexChecksError('올린 글 기록 id가 올바르지 않습니다.', 400));
  return queueTenantWrite(tenantId, async () => {
    const posts = await readPublishedPostsInQueue(tenantId);
    const post = posts.find((p) => p.id === postId);
    if (!post) throw new IndexChecksError(`올린 글 기록을 찾지 못했습니다: ${postId}`, 404);
    const checks = await readIndexChecksInQueue(tenantId);
    const ids = postingsOf(posts).find((p) => p.ids.includes(postId))?.ids ?? [postId];
    const record = applyIndexCheck(findIndexRecord(checks, postId, ids, post.key), post, input.engine, input.state, now);
    const file: IndexChecksFile = { format: INDEX_CHECKS_FORMAT, checks: { ...checks, [postId]: record } };
    await writeJsonAtomic(filePathFor(tenantId), file);
    return { record };
  });
}
