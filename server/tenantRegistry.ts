import rawTenants from './tenants.config.json' with { type: 'json' };
import { packagedDataMode } from './appPaths.js';
import { appendTenant, loadTenants } from './config.js';
import { blobStoreEnabled, canPersistTenants, readOverlay, removeOverlayTenant, writeOverlay } from './tenantOverlay.js';
import { addDeletedTenant, readDeletedTenants, removeDeletedTenant } from './tenantTombstone.js';
import { readFactGraphFile } from './factGraphStore.js';
import { readBrandPageUrl } from './brandPageStore.js';
import type { TenantConfig } from './types.js';
import type { Engine } from '../src/prompts/types.js';

const BASE_TENANTS = rawTenants as TenantConfig[];
const ENGINES: Engine[] = ['openai', 'gemini', 'claude', 'perplexity'];

/**
 * base config(tenants.config.json)를 읽는다.
 *
 * 정적 JSON import는 모듈 로드 시 **한 번만** 평가된다. dev 체크아웃에서는 브랜드 등록이
 * 이 파일에 append되므로(persistTenantForRuntime), 정적 import만 쓰면 새 브랜드가 서버를
 * 재시작할 때까지 목록에 나타나지 않는다. 그래서 dev에서는 매번 디스크에서 새로 읽는다.
 * 패키징/Vercel은 base config가 읽기전용 번들이고 등록이 오버레이로 가므로 정적 import가 맞다.
 */
async function baseTenants(): Promise<TenantConfig[]> {
  if (process.env.VERCEL || packagedDataMode()) return BASE_TENANTS;
  try {
    return await loadTenants();
  } catch {
    return BASE_TENANTS; // 파일을 못 읽으면 번들된 값으로 강등한다.
  }
}

export { canPersistTenants, blobStoreEnabled, removeOverlayTenant };

/**
 * 베이크된 테넌트를 로컬/패키징에서 즉시 완전 삭제한다(툼스톤 추가).
 * loadRuntimeTenants가 이 목록을 걸러내므로, GitHub Actions 없이 목록·선택지에서 바로 사라진다.
 */
export async function deleteTenantLocally(tenantId: string): Promise<void> {
  await addDeletedTenant(tenantId);
}

/**
 * 커밋된(베이크된) 테넌트인지 — 삭제 시 오버레이 제거만으로는 사라지지 않아 툼스톤/CLI가 필요하다.
 * dev에서 갓 등록된 브랜드도 base config에 들어가므로 baseTenants()로 최신 목록을 봐야 한다
 * (정적 목록만 보면 baked=false로 오판해 삭제해도 목록에 계속 남는다).
 */
export async function isBakedTenant(tenantId: string): Promise<boolean> {
  return (await baseTenants()).some((tenant) => tenant.tenantId === tenantId);
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
    // 문항 36 × 반복 1 — 같은 36호출 예산에서 정밀도가 가장 좋은 배분이다.
    //
    // 저장된 측정 1,376개 셀(브랜드×주차×엔진×질문)로 분산을 분해한 결과:
    //   질문 간 분산 σ²_b = 0.1671 · 반복 내 분산 σ²_w = 0.0383 → ICC 0.814
    // 분산의 81%가 질문 간이고 **반복으로는 그 부분이 줄지 않는다**. 고정 예산에서
    // 추정치 분산은 σ²_b/k + σ²_w/(k·m)이라 k(문항)만 첫 항을 줄인다. 같은 36호출에서:
    //   12문항 × 3회  SE 14.99%p     18문항 × 2회  SE 13.01%p     36문항 × 1회  SE 9.66%p
    //
    // 반복을 없애도 비결정성 측정을 잃지 않는다 — 그건 매 측정마다 낼 비용이 아니라
    // 주기적으로 재는 상수다. scripts/nondeterminism-probe.ts가 그 역할을 맡고,
    // 반복보다 나은 계측기다: 반복은 수집·판정 노이즈를 한 덩어리로 섞었지만 이 도구는
    // 같은 응답 원문을 다시 판정해 둘을 분리한다.
    questionBankSize: d.questionBankSize ?? 36,
    // v3 = 36문항 체계. 문항 집합이 달라지면 언급률·SoM의 모집단이 바뀌므로 버전을 올려
    // 옛 집합(v1 12문항 · v2 18문항)을 보존한다. 같은 버전에 덮어쓰면 "그때 무엇으로
    // 쟀는지"가 지워진다. 스코어카드에도 questionBankVersion으로 기록된다.
    questionBankVersion: d.questionBankVersion ?? 'v3',
    repeatsPerQuestion: d.repeatsPerQuestion ?? 1,
    competitors,
    factGraph: d.factGraph ?? [],
    ...(d.brandPageUrl ? { brandPageUrl: d.brandPageUrl } : {}),
    ...(d.cohortOnly ? { cohortOnly: true } : {}),
    ...(d.autoCohort === false ? { autoCohort: false } : {}),
  };
}

export async function loadRuntimeTenants(): Promise<TenantConfig[]> {
  const [base, overlay, deleted] = await Promise.all([baseTenants(), readOverlay(), readDeletedTenants()]);
  const map = new Map<string, TenantConfig>();
  for (const tenant of base) map.set(tenant.tenantId, tenant);
  for (const tenant of overlay) {
    if (!map.has(tenant.tenantId)) map.set(tenant.tenantId, tenant);
  }
  // 삭제(툼스톤)된 테넌트는 목록·선택지에서 제외한다.
  for (const id of deleted) map.delete(id);
  // 사람이 앱에서 고치는 값(팩트 그래프·브랜드 페이지 주소)만은 저장한 파일이 베이스·오버레이를
  // 모두 이긴다 — 베이스가 이기는 병합 규칙 탓에 릴리스 없이는 반영되지 않기 때문이다.
  const tenants = [...map.values()];
  const [facts, pages] = await Promise.all([
    Promise.all(tenants.map((t) => readFactGraphFile(t.tenantId))),
    Promise.all(tenants.map((t) => readBrandPageUrl(t.tenantId))),
  ]);
  return tenants.map((t, i) => ({
    ...t,
    ...(facts[i] ? { factGraph: facts[i]! } : {}),
    ...(pages[i] ? { brandPageUrl: pages[i]! } : {}),
  }));
}

/**
 * 오버레이·설정 파일 갱신을 프로세스 내에서 직렬화한다.
 *
 * 아래 영속화는 read-modify-write다. 코호트를 병렬로 측정하면 두 브랜드가 같은 스냅샷을
 * 읽고 각자 push한 뒤 덮어써, 먼저 쓴 등록이 조용히 사라진다.
 * (파일 잠금이 아니다 — 이 파일들을 쓰는 건 서버 프로세스 한 곳뿐이라는 전제에 기댄다.)
 */
let persistChain: Promise<unknown> = Promise.resolve();
function serializePersist<T>(task: () => Promise<T>): Promise<T> {
  const run = persistChain.then(task, task); // 앞선 작업이 실패해도 줄은 계속 흐른다
  persistChain = run.catch(() => undefined);
  return run;
}

/**
 * 테넌트를 런타임에 영속화한다.
 * - dev 체크아웃: base config(tenants.config.json)에 append.
 * - Vercel / Electron 패키징: base config는 읽기전용이므로 오버레이(쓰기 가능)에 저장.
 * 이미 있으면 조용히 넘어간다(중복 append 방지). 호출은 서로 직렬화된다.
 */
export function persistTenantForRuntime(tenant: TenantConfig): Promise<void> {
  return serializePersist(() => persistTenantForRuntimeUnlocked(tenant));
}

async function persistTenantForRuntimeUnlocked(tenant: TenantConfig): Promise<void> {
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
    ...(tenant.brandPageUrl ? { brandPageUrl: tenant.brandPageUrl } : {}),
  };
}
