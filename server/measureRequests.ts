import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { get, put } from '@vercel/blob';
import { blobStoreEnabled } from './tenantOverlay.js';
import type { TenantConfig } from './types.js';

/** 측정 대기열 항목. 로컬 CLI가 self-contained하게 측정할 수 있도록 전체 tenant를 담는다. */
export interface MeasureRequest {
  tenant: TenantConfig;
  requestedAt: string;
}

const LOCAL_PATH = path.resolve(process.cwd(), 'server/measure-requests.json');
const BLOB_PATHNAME = 'measure-requests.json';

async function readFromBlob(): Promise<MeasureRequest[]> {
  try {
    const result = await get(BLOB_PATHNAME, { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) return [];
    const data: unknown = JSON.parse(await new Response(result.stream).text());
    return Array.isArray(data) ? (data as MeasureRequest[]) : [];
  } catch {
    return [];
  }
}

async function writeToBlob(list: MeasureRequest[]): Promise<void> {
  await put(BLOB_PATHNAME, JSON.stringify(list, null, 2), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 0,
    contentType: 'application/json; charset=utf-8',
  });
}

async function readFromFile(): Promise<MeasureRequest[]> {
  try {
    const data: unknown = JSON.parse(await readFile(LOCAL_PATH, 'utf-8'));
    return Array.isArray(data) ? (data as MeasureRequest[]) : [];
  } catch {
    return [];
  }
}

export async function readMeasureRequests(): Promise<MeasureRequest[]> {
  return blobStoreEnabled() ? readFromBlob() : readFromFile();
}

async function writeMeasureRequests(list: MeasureRequest[]): Promise<void> {
  if (blobStoreEnabled()) {
    await writeToBlob(list);
    return;
  }
  if (process.env.VERCEL) throw new Error('Vercel에서 측정 요청을 저장하려면 Blob 스토어가 필요합니다.');
  await writeFile(LOCAL_PATH, JSON.stringify(list, null, 2) + '\n', 'utf-8');
}

/** 대기열에 추가한다(같은 tenantId면 최신으로 갱신). */
export async function addMeasureRequest(tenant: TenantConfig): Promise<MeasureRequest[]> {
  const list = (await readMeasureRequests()).filter((r) => r.tenant.tenantId !== tenant.tenantId);
  list.push({ tenant, requestedAt: new Date().toISOString() });
  await writeMeasureRequests(list);
  return list;
}

/** 대기열에서 제거한다(측정 완료 후 정리용). */
export async function removeMeasureRequest(tenantId: string): Promise<MeasureRequest[]> {
  const list = (await readMeasureRequests()).filter((r) => r.tenant.tenantId !== tenantId);
  await writeMeasureRequests(list);
  return list;
}
