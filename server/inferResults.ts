import { get, put } from '@vercel/blob';
import { blobStoreEnabled } from './tenantOverlay.js';
import type { InferredCompetitor } from './brandInference.js';

// 자동 채우기 시 CI 러너가 추론한 경쟁사를 도메인 slug로 키잉해 Blob에 저장한다.
// 폼은 dispatch로 추론을 시작(pending 마킹)하고, 결과가 나올 때까지 폴링해 3.경쟁사에 채운다.
export interface InferResult {
  pending: boolean;
  competitors: InferredCompetitor[];
  at: string;
}

export function slugFromDomain(domain: string): string {
  const label = (domain || '').split('.')[0] || 'brand';
  return label.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'brand';
}

const pathFor = (slug: string) => `infer-competitors-${slug}.json`;

async function write(slug: string, value: InferResult): Promise<void> {
  await put(pathFor(slug), JSON.stringify(value), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 0,
    contentType: 'application/json; charset=utf-8',
  });
}

/** 추론 시작 표시(이전 결과를 지워 stale 반환을 막는다). */
export async function markInferPending(slug: string): Promise<void> {
  if (!blobStoreEnabled()) return;
  await write(slug, { pending: true, competitors: [], at: new Date().toISOString() });
}

/** 러너가 추론 결과를 저장한다. */
export async function writeInferResult(slug: string, competitors: InferredCompetitor[]): Promise<void> {
  await write(slug, { pending: false, competitors, at: new Date().toISOString() });
}

/** 폼이 결과를 읽는다(없으면 null → 아직 시작 안 됨). */
export async function readInferResult(slug: string): Promise<InferResult | null> {
  if (!blobStoreEnabled()) return null;
  try {
    const r = await get(pathFor(slug), { access: 'private', useCache: false });
    if (!r || r.statusCode !== 200 || !r.stream) return null;
    const data: unknown = JSON.parse(await new Response(r.stream).text());
    if (data && typeof data === 'object' && Array.isArray((data as InferResult).competitors)) {
      return data as InferResult;
    }
    return null;
  } catch {
    return null;
  }
}
