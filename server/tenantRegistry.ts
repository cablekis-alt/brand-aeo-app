import rawTenants from './tenants.config.json' with { type: 'json' };
import { appendTenant } from './config.js';
import { blobStoreEnabled, canPersistTenants, readOverlay, writeOverlay } from './tenantOverlay.js';
import type { TenantConfig } from './types.js';
import type { Engine } from '../src/prompts/types.js';

const BASE_TENANTS = rawTenants as TenantConfig[];
const ENGINES: Engine[] = ['openai', 'gemini', 'claude', 'perplexity'];

export { canPersistTenants, blobStoreEnabled };

function asEngineList(value: unknown): Engine[] {
  if (!Array.isArray(value) || value.length === 0) return ['openai'];
  const picked = value.filter((item): item is Engine => ENGINES.includes(item as Engine));
  return picked.length > 0 ? picked : ['openai'];
}

/** 온보딩 JSON을 TenantConfig로 정규화한다. 자기 자신을 경쟁사로 넣은 줄은 빼 둔다. */
export function normalizeTenantDraft(raw: unknown): TenantConfig {
  const d = (raw ?? {}) as Partial<TenantConfig> & { ownedDomains?: string[] };
  const missing: string[] = (['tenantId', 'brandName', 'industry', 'region'] as const).filter((key) => !d[key]);
  if (!d.ownedDomains?.length) missing.push('ownedDomains');
  if (missing.length) {
    throw new Error(`필수 항목 누락: ${missing.join(', ')}`);
  }

  const ownedDomains = d.ownedDomains!.map((domain) => domain.replace(/^www\./, ''));
  const owned = new Set(ownedDomains);
  const competitors = (d.competitors ?? []).filter(
    (competitor) => !competitor.domains.some((domain) => owned.has(domain.replace(/^www\./, ''))),
  );

  return {
    tenantId: d.tenantId!,
    brandName: d.brandName!,
    aliases: d.aliases?.length ? d.aliases : [d.brandName!],
    ownedDomains,
    industry: d.industry!,
    region: d.region!,
    engines: asEngineList(d.engines),
    questionBankSize: d.questionBankSize ?? 12,
    questionBankVersion: d.questionBankVersion ?? 'v1',
    repeatsPerQuestion: d.repeatsPerQuestion ?? 3,
    competitors,
    factGraph: d.factGraph ?? [],
  };
}

export async function loadRuntimeTenants(): Promise<TenantConfig[]> {
  const overlay = await readOverlay();
  const map = new Map<string, TenantConfig>();
  for (const tenant of BASE_TENANTS) map.set(tenant.tenantId, tenant);
  for (const tenant of overlay) {
    if (!map.has(tenant.tenantId)) map.set(tenant.tenantId, tenant);
  }
  return [...map.values()];
}

export async function registerTenant(tenant: TenantConfig): Promise<void> {
  const existing = await loadRuntimeTenants();
  if (existing.some((item) => item.tenantId === tenant.tenantId)) {
    throw new Error(`이미 존재하는 tenantId입니다: ${tenant.tenantId}`);
  }
  if (process.env.VERCEL) {
    const overlay = await readOverlay();
    overlay.push(tenant);
    await writeOverlay(overlay);
    return;
  }
  await appendTenant(tenant);
}

export function toTenantSummary(tenant: TenantConfig) {
  return {
    tenantId: tenant.tenantId,
    brandName: tenant.brandName,
    aliases: tenant.aliases,
    ownedDomains: tenant.ownedDomains,
    industry: tenant.industry,
    region: tenant.region,
    engines: tenant.engines,
    questionBankSize: tenant.questionBankSize,
    competitors: tenant.competitors.map((competitor) => competitor.name),
  };
}
