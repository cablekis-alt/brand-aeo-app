import rawTenants from './tenants.config.json' with { type: 'json' };
import { packagedDataMode } from './appPaths.js';
import { appendTenant, loadTenants } from './config.js';
import { blobStoreEnabled, canPersistTenants, readOverlay, removeOverlayTenant, writeOverlay } from './tenantOverlay.js';
import { addDeletedTenant, readDeletedTenants, removeDeletedTenant } from './tenantTombstone.js';
import type { TenantConfig } from './types.js';
import type { Engine } from '../src/prompts/types.js';

const BASE_TENANTS = rawTenants as TenantConfig[];
const ENGINES: Engine[] = ['openai', 'gemini', 'claude', 'perplexity'];

export { canPersistTenants, blobStoreEnabled, removeOverlayTenant };

/**
 * 베이크된 테넌트를 로컬/패키징에서 즉시 완전 삭제한다(툼스톤 추가).
 * loadRuntimeTenants가 이 목록을 걸러내므로, GitHub Actions 없이 목록·선택지에서 바로 사라진다.
 */
export async function deleteTenantLocally(tenantId: string): Promise<void> {
  await addDeletedTenant(tenantId);
}

/** 커밋된(베이크된) 테넌트인지 — 삭제 시 오버레이 제거만으로는 사라지지 않아 CLI+배포가 필요하다. */
export function isBakedTenant(tenantId: string): boolean {
  return BASE_TENANTS.some((tenant) => tenant.tenantId === tenantId);
}

function asEngineList(value: unknown): Engine[] {
  // 기본 수집 엔진 = ChatGPT + Gemini (지정이 없거나 유효 항목이 없을 때).
  if (!Array.isArray(value) || value.length === 0) return ['openai', 'gemini'];
  const picked = value.filter((item): item is Engine => ENGINES.includes(item as Engine));
  return picked.length > 0 ? picked : ['openai', 'gemini'];
}

/** 온보딩 JSON을 TenantConfig로 정규화한다. 자기 자신을 경쟁사로 넣은 줄은 빼 둔다. */
export function normalizeTenantDraft(raw: unknown): TenantConfig {
  const d = (raw ?? {}) as Partial<TenantConfig> & { ownedDomains?: string[] };
  const missing: string[] = (['tenantId', 'brandName', 'industry', 'region'] as const).filter((key) => !d[key]);
  // cohortOnly(경쟁사 분모) 테넌트는 도메인이 없어도 허용한다(펜션 등). 본 브랜드는 도메인 필수.
  if (!d.cohortOnly && !d.ownedDomains?.length) missing.push('ownedDomains');
  if (missing.length) {
    throw new Error(`필수 항목 누락: ${missing.join(', ')}`);
  }

  const ownedDomains = (d.ownedDomains ?? []).map((domain) => domain.replace(/^www\./, ''));
  const owned = new Set(ownedDomains);
  // 경쟁사도 방어적으로 정규화한다 — aliases/domains가 비면 파이프라인이 깨진다(competitor.aliases 순회 등).
  const competitors = (d.competitors ?? [])
    .map((competitor) => {
      const c = competitor as { name?: unknown; aliases?: unknown; domains?: unknown };
      const name = typeof c.name === 'string' ? c.name.trim() : '';
      const domains = Array.isArray(c.domains)
        ? c.domains.filter((v): v is string => typeof v === 'string').map((v) => v.replace(/^www\./, ''))
        : [];
      const aliases = Array.isArray(c.aliases) && c.aliases.length
        ? c.aliases.filter((v): v is string => typeof v === 'string')
        : name
          ? [name]
          : [];
      return { name, aliases, domains };
    })
    .filter((competitor) => competitor.name && !competitor.domains.some((domain) => owned.has(domain)));

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
    ...(d.cohortOnly ? { cohortOnly: true } : {}),
    ...(d.autoCohort === false ? { autoCohort: false } : {}),
  };
}

export async function loadRuntimeTenants(): Promise<TenantConfig[]> {
  const [overlay, deleted] = await Promise.all([readOverlay(), readDeletedTenants()]);
  const map = new Map<string, TenantConfig>();
  for (const tenant of BASE_TENANTS) map.set(tenant.tenantId, tenant);
  for (const tenant of overlay) {
    if (!map.has(tenant.tenantId)) map.set(tenant.tenantId, tenant);
  }
  // 삭제(툼스톤)된 테넌트는 목록·선택지에서 제외한다.
  for (const id of deleted) map.delete(id);
  return [...map.values()];
}

/**
 * 테넌트를 런타임에 영속화한다.
 * - dev 체크아웃: base config(tenants.config.json)에 append.
 * - Vercel / Electron 패키징: base config는 읽기전용이므로 오버레이(쓰기 가능)에 저장.
 * 이미 있으면 조용히 넘어간다(중복 append 방지).
 */
export async function persistTenantForRuntime(tenant: TenantConfig): Promise<void> {
  if (process.env.VERCEL || packagedDataMode()) {
    const overlay = await readOverlay();
    if (!overlay.some((item) => item.tenantId === tenant.tenantId)) {
      overlay.push(tenant);
      await writeOverlay(overlay);
    }
    return;
  }
  // dev 체크아웃 — base config에 없을 때만 append(중복이면 append가 throw하므로 방어).
  const tenants = await loadTenants();
  if (!tenants.some((item) => item.tenantId === tenant.tenantId)) await appendTenant(tenant);
}

export async function registerTenant(tenant: TenantConfig): Promise<void> {
  const existing = await loadRuntimeTenants();
  if (existing.some((item) => item.tenantId === tenant.tenantId)) {
    throw new Error(`이미 존재하는 tenantId입니다: ${tenant.tenantId}`);
  }
  // 이전에 삭제(툼스톤)된 tenantId를 다시 등록하는 경우, 툼스톤을 걷어내 다시 보이게 한다.
  await removeDeletedTenant(tenant.tenantId);
  await persistTenantForRuntime(tenant);
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
