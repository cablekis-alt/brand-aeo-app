import { readFile, writeFile } from 'node:fs/promises';
import { get, put } from '@vercel/blob';
import { stateFilePath } from './appPaths.js';
import type { TenantConfig } from './types.js';

const LOCAL_PATH = stateFilePath('tenants.overlay.json');
const BLOB_PATHNAME = 'tenants-overlay.json';

export function blobStoreEnabled(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
}

export function canPersistTenants(): boolean {
  return blobStoreEnabled() || !process.env.VERCEL;
}

async function readOverlayFromBlob(): Promise<TenantConfig[]> {
  try {
    const result = await get(BLOB_PATHNAME, { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) return [];
    const text = await new Response(result.stream).text();
    const data: unknown = JSON.parse(text);
    return Array.isArray(data) ? (data as TenantConfig[]) : [];
  } catch {
    return [];
  }
}

async function writeOverlayToBlob(tenants: TenantConfig[]): Promise<void> {
  await put(BLOB_PATHNAME, JSON.stringify(tenants, null, 2), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 0,
    contentType: 'application/json; charset=utf-8',
  });
}

async function readOverlayFromFile(): Promise<TenantConfig[]> {
  try {
    const raw = await readFile(LOCAL_PATH, 'utf-8');
    const data: unknown = JSON.parse(raw);
    return Array.isArray(data) ? (data as TenantConfig[]) : [];
  } catch {
    return [];
  }
}

export async function readOverlay(): Promise<TenantConfig[]> {
  if (blobStoreEnabled()) return readOverlayFromBlob();
  return readOverlayFromFile();
}

export async function writeOverlay(tenants: TenantConfig[]): Promise<void> {
  if (blobStoreEnabled()) {
    await writeOverlayToBlob(tenants);
    return;
  }
  if (process.env.VERCEL) {
    throw new Error('Vercel에서 브랜드를 저장하려면 Blob 스토어를 연결해야 합니다.');
  }
  await writeFile(LOCAL_PATH, JSON.stringify(tenants, null, 2) + '\n', 'utf-8');
}

/** 오버레이(런타임 등록분)에서 한 테넌트를 제거한다. 베이크된(BASE) 테넌트에는 영향 없음. */
export async function removeOverlayTenant(tenantId: string): Promise<{ removed: boolean }> {
  const overlay = await readOverlay();
  const next = overlay.filter((tenant) => tenant.tenantId !== tenantId);
  const removed = next.length !== overlay.length;
  if (removed) await writeOverlay(next);
  return { removed };
}
