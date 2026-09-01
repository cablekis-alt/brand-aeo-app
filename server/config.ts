import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { TenantConfig } from './types';

const TENANTS_CONFIG_PATH = path.resolve(process.cwd(), 'server/tenants.config.json');

export async function loadTenants(): Promise<TenantConfig[]> {
  const raw = await readFile(TENANTS_CONFIG_PATH, 'utf-8');
  return JSON.parse(raw) as TenantConfig[];
}
