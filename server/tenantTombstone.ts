import { readFile, writeFile } from 'node:fs/promises';
import { get, put } from '@vercel/blob';
import { stateFilePath } from './appPaths.js';
import { blobStoreEnabled } from './tenantOverlay.js';

// 베이크된(BASE config에 컴파일된) 테넌트는 파일에서 지울 수 없다 — 정적 import라 번들에 박혀 있다.
// 그래서 "삭제한 tenantId" 목록(툼스톤)을 쓰기 가능한 상태에 두고, loadRuntimeTenants가 이를 걸러낸다.
// 로컬/패키징(Electron)에서 GitHub Actions 없이도 즉시 완전 삭제되도록 한다.
const LOCAL_PATH = stateFilePath('tenants.deleted.json');
const BLOB_PATHNAME = 'tenants-deleted.json';

async function readFromBlob(): Promise<string[]> {
  try {
    const result = await get(BLOB_PATHNAME, { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) return [];
    const text = await new Response(result.stream).text();
    const data: unknown = JSON.parse(text);
    return Array.isArray(data) ? data.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

async function writeToBlob(ids: string[]): Promise<void> {
  await put(BLOB_PATHNAME, JSON.stringify(ids, null, 2), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 0,
    contentType: 'application/json; charset=utf-8',
  });
}

async function readFromFile(): Promise<string[]> {
  try {
    const raw = await readFile(LOCAL_PATH, 'utf-8');
    const data: unknown = JSON.parse(raw);
    return Array.isArray(data) ? data.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export async function readDeletedTenants(): Promise<string[]> {
  if (blobStoreEnabled()) return readFromBlob();
  return readFromFile();
}

async function writeDeletedTenants(ids: string[]): Promise<void> {
  if (blobStoreEnabled()) {
    await writeToBlob(ids);
    return;
  }
  if (process.env.VERCEL) {
    throw new Error('Vercel에서 삭제 상태를 저장하려면 Blob 스토어를 연결해야 합니다.');
  }
  await writeFile(LOCAL_PATH, JSON.stringify(ids, null, 2) + '\n', 'utf-8');
}

/** 테넌트를 삭제 목록(툼스톤)에 추가한다. 이미 있으면 그대로 둔다. */
export async function addDeletedTenant(tenantId: string): Promise<void> {
  const ids = await readDeletedTenants();
  if (!ids.includes(tenantId)) {
    ids.push(tenantId);
    await writeDeletedTenants(ids);
  }
}

/** 툼스톤에서 제거한다(같은 tenantId 재등록 시 다시 보이도록). */
export async function removeDeletedTenant(tenantId: string): Promise<void> {
  const ids = await readDeletedTenants();
  const next = ids.filter((id) => id !== tenantId);
  if (next.length !== ids.length) await writeDeletedTenants(next);
}
