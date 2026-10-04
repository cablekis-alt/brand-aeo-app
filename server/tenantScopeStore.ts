import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MARKET_SCOPES, type MarketScope } from '../src/prompts/types.js';
import { PIPELINE_DATA_DIR } from './appPaths.js';

/**
 * 브랜드별 시장 범위 — data/<tenant>/market-scope.json.
 *
 * 왜 오버레이가 아니라 별도 파일인가 — 수집 엔진(tenantEnginesStore.ts)과 같은 이유다. 테넌트 병합은
 * **베이스가 이기므로**(loadRuntimeTenants) repo config에 박힌 브랜드는 오버레이에 써도 무시된다. 이미
 * 등록된 브랜드에 시장 범위를 붙이는 일이 릴리스를 기다리게 할 수는 없다. 새로 등록하는 브랜드는 오버레이에도
 * 같은 값이 들어가지만, 이 파일이 있으면 이 파일이 이긴다.
 */
export interface TenantScope {
  marketScope: MarketScope;
  /** B2B형에서만 쓴다. 다른 범위면 저장하지 않는다. */
  buyer?: string;
}

function filePathFor(tenantId: string): string {
  return path.join(PIPELINE_DATA_DIR, tenantId, 'market-scope.json');
}

/** 아는 값만 받는다. 모르는 범위는 거절한다 — 조용히 지역형으로 바꾸면 질문지가 엉뚱하게 만들어진다. */
export function normalizeTenantScope(input: unknown): TenantScope {
  const raw = (input ?? {}) as { marketScope?: unknown; buyer?: unknown };
  const scope = typeof raw.marketScope === 'string' ? raw.marketScope.trim() : '';
  if (!(MARKET_SCOPES as string[]).includes(scope)) {
    throw new Error(`시장 범위는 ${MARKET_SCOPES.join(' · ')} 중 하나여야 합니다.`);
  }
  const buyer = typeof raw.buyer === 'string' ? raw.buyer.trim().slice(0, 120) : '';
  return scope === 'b2b' && buyer ? { marketScope: 'b2b', buyer } : { marketScope: scope as MarketScope };
}

/** 파일이 없거나 깨졌으면 null(= 테넌트 설정의 값, 그것도 없으면 지역형). */
export async function readTenantScope(tenantId: string): Promise<TenantScope | null> {
  let text: string;
  try {
    text = await readFile(filePathFor(tenantId), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    return normalizeTenantScope(JSON.parse(text));
  } catch (err) {
    console.error(`[tenantScope] ${tenantId} market-scope.json을 읽지 못했습니다 — 설정값을 씁니다:`, err);
    return null;
  }
}

export async function writeTenantScope(tenantId: string, scope: TenantScope): Promise<void> {
  const target = filePathFor(tenantId);
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ ...scope, updatedAt: new Date().toISOString().slice(0, 10) }, null, 2), 'utf-8');
  await rename(tmp, target);
}
