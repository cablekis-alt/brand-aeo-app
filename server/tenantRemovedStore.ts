import { readFile } from 'node:fs/promises';
import { stateFilePath } from './appPaths.js';
import { planCohortTargets } from './cohortPlan.js';
import { measureInFlight } from './measureTracker.js';
import { readOverlay, writeOverlay } from './tenantOverlay.js';
import { findBakedTenant, isBakedTenant, loadRuntimeTenants, reconcileTenantCohorts } from './tenantRegistry.js';
import { removeDeletedTenant } from './tenantTombstone.js';
import { queueTenantWrite, writeJsonAtomic } from './tenantWriteQueue.js';
import { sameCohort, sharesSite } from '../src/lib/brandVariant.js';
import type { ResultStore } from './store.js';
import type { TenantConfig } from './types.js';

/**
 * 브랜드 삭제 — 지우기 전 미리보기와, 지운 브랜드를 설정째 되살리기(상용화 UI 3차 U15, 결정 S2-2).
 *
 * 삭제는 툼스톤을 달고 오버레이에서 설정(경쟁사 · 수집 엔진 · 시장 범위)을 뺀다. 측정 기록(data/<id>/)은 남지만 설정은 사라져,
 * 실수로 지우면 다시 등록하고 경쟁사를 다시 넣어야 했다. 지우기 직전의 오버레이 설정을 이 PC의 tenants.removed.json에 남겨 두고,
 * 되살리면 오버레이와 툼스톤을 지우기 전으로 돌리고 같은 코호트 순위를 다시 매긴다. 고객 설정이 들어 있어 저장소에 올리지 않는다.
 */

export interface RemovedTenant {
  tenantId: string;
  brandName: string;
  industry: string;
  region: string;
  removedAt: string;
  /** 지우기 직전의 오버레이 설정 — 없으면 저장소 설정(tenants.config.json)의 브랜드라 툼스톤만 걷으면 된다. */
  overlay: TenantConfig | null;
  /** 지우기 직전 브랜드의 모습(목록에 보이던 설정) — 되살릴 때 같은 홈페이지 · 비교 그룹 검사에 쓴다(옛 백업에는 없다). */
  snapshot?: TenantConfig;
}

const FILE = stateFilePath('tenants.removed.json');
const MAX_REMOVED = 50;
const QUEUE = '__tenants.removed__';

export class TenantRestoreError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'TenantRestoreError';
    this.status = status;
  }
}

export async function readRemovedTenants(): Promise<RemovedTenant[]> {
  let text: string;
  try {
    text = await readFile(FILE, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  try {
    const data: unknown = JSON.parse(text);
    return Array.isArray(data) ? (data as RemovedTenant[]).filter((r) => typeof r?.tenantId === 'string') : [];
  } catch (err) {
    console.error('[tenantRemovedStore] tenants.removed.json이 깨져 지운 브랜드 목록을 비운 채로 보입니다:', err);
    return [];
  }
}

/** 지우기 직전에 남긴다 — 같은 브랜드는 가장 최근 것 하나만, 최근 50곳까지. */
export function addRemovedTenant(entry: RemovedTenant): Promise<void> {
  return queueTenantWrite(QUEUE, async () => {
    const list = (await readRemovedTenants()).filter((r) => r.tenantId !== entry.tenantId);
    await writeJsonAtomic(FILE, [entry, ...list].slice(0, MAX_REMOVED));
  });
}

/** 지우기 전 미리보기 — 측정 기록이 든 코호트와 주 수, 이 브랜드를 경쟁사로 재는 고객, 지금 측정 중인가. */
export interface TenantDeletePreview {
  tenantId: string;
  brandName: string;
  /** 저장소 설정의 브랜드(오버레이가 아닌) — 이 PC에서는 툼스톤으로 숨긴다. */
  baked: boolean;
  cohorts: { industry: string; region: string; weeks: number; firstWeekOf: string; lastWeekOf: string }[];
  competitorOf: { tenantId: string; brandName: string }[];
  measuring: boolean;
}

export async function describeTenantDelete(tenantId: string, store: ResultStore): Promise<TenantDeletePreview | null> {
  const runtime = await loadRuntimeTenants();
  const tenant = runtime.find((t) => t.tenantId === tenantId);
  if (!tenant) return null;
  const history = await store.getScorecardHistory(tenantId, Number.MAX_SAFE_INTEGER);
  const byCohort = new Map<string, TenantDeletePreview['cohorts'][number]>();
  for (const card of history) {
    const key = `${card.industry}|${card.region}`;
    const cur = byCohort.get(key);
    if (!cur) byCohort.set(key, { industry: card.industry, region: card.region, weeks: 1, firstWeekOf: card.weekOf, lastWeekOf: card.weekOf });
    else {
      cur.weeks += 1;
      if (card.weekOf < cur.firstWeekOf) cur.firstWeekOf = card.weekOf;
      if (card.weekOf > cur.lastWeekOf) cur.lastWeekOf = card.weekOf;
    }
  }
  const competitorOf = runtime
    .filter((t) => !t.cohortOnly && t.tenantId !== tenantId && t.autoCohort !== false && t.competitors.length > 0)
    .filter((t) => planCohortTargets(t, runtime).entries.some((e) => e.targetTenantId === tenantId))
    .map((t) => ({ tenantId: t.tenantId, brandName: t.brandName }));
  return {
    tenantId,
    brandName: tenant.brandName,
    baked: await isBakedTenant(tenantId),
    cohorts: [...byCohort.values()],
    competitorOf,
    measuring: measureInFlight(),
  };
}

/**
 * 지운 브랜드를 되살린다 — 오버레이 설정을 되돌리고 툼스톤을 걷은 뒤, 그 브랜드가 든 코호트 순위를 다시 매긴다. 같은 id가 이미 있거나
 * 같은 홈페이지 · 코호트의 고객 브랜드가 다시 등록돼 있으면(registerTenant와 같은 규칙) 409, 측정 중이면 409.
 */
export async function restoreRemovedTenant(tenantId: string, store: ResultStore): Promise<RemovedTenant> {
  if (measureInFlight()) throw new TenantRestoreError(409, '측정이 진행 중이에요. 끝난 뒤에 되살려 주세요.');
  const entry = (await readRemovedTenants()).find((r) => r.tenantId === tenantId);
  if (!entry) throw new TenantRestoreError(404, '지운 브랜드 목록에 없습니다.');
  const runtime = await loadRuntimeTenants();
  if (runtime.some((t) => t.tenantId === tenantId)) {
    // 같은 ID로 다시 등록했거나 다른 고객의 경쟁사로 다시 잰 뒤다 — 되살릴 것이 없으니 목록에서 뺀다(남겨 두면 늘 409).
    await dropRemovedTenant(tenantId);
    throw new TenantRestoreError(409, `같은 ID의 브랜드가 이미 다시 있어 「지운 브랜드」에서 뺐습니다: ${tenantId}`);
  }
  // 같은 홈페이지 · 비교 그룹 검사는 지우기 직전 모습으로 — 저장소 설정 브랜드(오버레이가 없음)도 같은 규칙을 탄다. 모습을 남기기
  // 전의 백업이면 저장소 설정에서 찾는다.
  const shape = entry.overlay ?? entry.snapshot ?? (await findBakedTenant(tenantId)) ?? null;
  if (!shape) throw new TenantRestoreError(409, '이 백업에는 브랜드 설정이 없어 되살릴 수 없습니다.');
  if (!shape.cohortOnly) {
    const twin = runtime.find((t) => !t.cohortOnly && sharesSite(t, shape) && sameCohort(t, shape));
    if (twin) {
      throw new TenantRestoreError(409, `같은 홈페이지 · 비교 그룹의 브랜드가 이미 있습니다: ${twin.brandName}(${twin.industry} · ${twin.region})`);
    }
  }
  if (entry.overlay) {
    const overlay = await readOverlay();
    if (!overlay.some((t) => t.tenantId === tenantId)) await writeOverlay([...overlay, entry.overlay]);
  }
  await removeDeletedTenant(tenantId);
  await reconcileTenantCohorts(tenantId, store);
  await dropRemovedTenant(tenantId);
  return entry;
}

/** 지운 브랜드 목록에서 뺀다 — 되살렸거나, 같은 ID가 다시 생겼거나, 지우기가 끝나지 못했을 때. */
export function dropRemovedTenant(tenantId: string): Promise<void> {
  return queueTenantWrite(QUEUE, async () => {
    const list = await readRemovedTenants();
    if (list.some((r) => r.tenantId === tenantId)) await writeJsonAtomic(FILE, list.filter((r) => r.tenantId !== tenantId));
  });
}
