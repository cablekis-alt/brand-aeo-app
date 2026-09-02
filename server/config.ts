import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TenantConfig } from './types.js';

export const TENANTS_CONFIG_PATH = path.resolve(process.cwd(), 'server/tenants.config.json');

export async function loadTenants(): Promise<TenantConfig[]> {
  const raw = await readFile(TENANTS_CONFIG_PATH, 'utf-8');
  return JSON.parse(raw) as TenantConfig[];
}

/**
 * 새 테넌트를 tenants.config.json 배열 끝에 추가한다 (S-08 온보딩용).
 * tenantId가 이미 있으면 에러. 로컬 백엔드에서만 동작한다(배포 서버리스는 읽기 전용).
 */
export async function appendTenant(tenant: TenantConfig): Promise<void> {
  const tenants = await loadTenants();
  if (tenants.some((t) => t.tenantId === tenant.tenantId)) {
    throw new Error(`이미 존재하는 tenantId입니다: ${tenant.tenantId}`);
  }
  tenants.push(tenant);
  await writeFile(TENANTS_CONFIG_PATH, JSON.stringify(tenants, null, 2) + '\n', 'utf-8');
}
