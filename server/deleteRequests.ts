import { readFile, writeFile } from 'node:fs/promises';
import { get, put } from '@vercel/blob';
import { stateFilePath } from './appPaths.js';
import { blobStoreEnabled } from './tenantOverlay.js';

// 삭제 대기열 — tenantId 목록만 담는다. 여러 번 빠르게 삭제해도 concurrency로 run이 취소되는 문제를,
// "큐에 누적 → 살아남은 run이 전체를 처리"로 견고하게 만든다(측정 큐와 같은 패턴).
// delete.yml에 이 값을 tenantId로 넘기면 delete-tenant.ts가 큐 전체를 삭제한다.
export const DELETE_QUEUE_SENTINEL = '__queue__';

const LOCAL_PATH = stateFilePath('delete-requests.json');
const BLOB_PATHNAME = 'delete-requests.json';

async function readFromBlob(): Promise<string[]> {
  try {
    const result = await get(BLOB_PATHNAME, { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) return [];
    const data: unknown = JSON.parse(await new Response(result.stream).text());
    return Array.isArray(data) ? (data.filter((v): v is string => typeof v === 'string')) : [];
  } catch {
    return [];
  }
}

async function writeToBlob(list: string[]): Promise<void> {
  await put(BLOB_PATHNAME, JSON.stringify(list, null, 2), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 0,
    contentType: 'application/json; charset=utf-8',
  });
}

async function readFromFile(): Promise<string[]> {
  try {
    const data: unknown = JSON.parse(await readFile(LOCAL_PATH, 'utf-8'));
    return Array.isArray(data) ? data.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export async function readDeleteRequests(): Promise<string[]> {
  return blobStoreEnabled() ? readFromBlob() : readFromFile();
}

async function writeDeleteRequests(list: string[]): Promise<void> {
  if (blobStoreEnabled()) {
    await writeToBlob(list);
    return;
  }
  if (process.env.VERCEL) throw new Error('Vercel에서 삭제 요청을 저장하려면 Blob 스토어가 필요합니다.');
  await writeFile(LOCAL_PATH, JSON.stringify(list, null, 2) + '\n', 'utf-8');
}

/** 삭제 대기열에 추가한다(중복 제거). */
export async function addDeleteRequest(tenantId: string): Promise<string[]> {
  const list = await readDeleteRequests();
  if (!list.includes(tenantId)) list.push(tenantId);
  await writeDeleteRequests(list);
  return list;
}

/** 삭제 대기열에서 제거한다(삭제 완료 후 정리용). 최신 큐를 다시 읽어 동시 추가분을 덮어쓰지 않는다. */
export async function removeDeleteRequest(tenantId: string): Promise<string[]> {
  const list = (await readDeleteRequests()).filter((id) => id !== tenantId);
  await writeDeleteRequests(list);
  return list;
}
