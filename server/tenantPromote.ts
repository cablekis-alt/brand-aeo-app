import { competitorDraftId, planCohortTargets } from './cohortPlan.js';
import { EditorError, saveEdit } from './competitorEditor.js';
import { measureInFlight } from './measureTracker.js';
import { isBakedTenant, loadRuntimeTenants, replaceOverlayTenant } from './tenantRegistry.js';
import { topicParticle } from '../src/lib/korean.js';
import type { ResultStore } from './store.js';
import type { TenantConfig } from './types.js';

/**
 * 브랜드 등록이 이미 있는 tenantId와 부딪혔을 때 — 무엇과 부딪혔는지 가려내고, 같은 곳이면 고객 브랜드로 전환한다.
 *
 * 그냥 덮어쓰지 않는 이유: id는 홈페이지 첫 마디라(cohortPlan.ts slugFromDomain) 서로 다른 업체가 같은 id를 받는다
 * (gunsan.webforai.kr과 gunsan.go.kr은 둘 다 gunsan). 덮어쓰면 두 업체의 기록이 한 폴더에 쌓이고, 이미 있는 고객
 * 브랜드면 경쟁사 · 사실 · 질문지 설정이 말없이 사라진다. 그래서 경쟁사로만 재던 브랜드(cohortOnly)이고 홈페이지가
 * 같을 때만 전환을 연다 — id가 그대로라 지난 측정 기록이 이어진다(2026-10-16, 군산여행의 모든것).
 */
export interface TenantConflict {
  /** competitor: 경쟁사로만 재던 브랜드 · customer: 이미 등록된 고객 브랜드 · repo: 저장소 설정의 브랜드(앱에서 못 바꿈). */
  kind: 'competitor' | 'customer' | 'repo';
  tenantId: string;
  brandName: string;
  industry: string;
  region: string;
  ownedDomains: string[];
  /** 홈페이지가 같은가 — 경쟁사 브랜드와 같으면 같은 곳으로 보고 전환할 수 있다. */
  sameSite: boolean;
  /** 이 id로 쌓인 측정 주차 수. */
  weeks: number;
  /** 이 브랜드를 경쟁사로 함께 재는 고객 브랜드. */
  referencedBy: { tenantId: string; brandName: string }[];
}

const host = (d: string) => d.trim().toLowerCase().replace(/^www\./, '');

export async function describeTenantConflict(draft: TenantConfig, store: ResultStore): Promise<TenantConflict | null> {
  const runtime = await loadRuntimeTenants();
  const existing = runtime.find((t) => t.tenantId === draft.tenantId);
  if (!existing) return null;
  const drafts = new Set(draft.ownedDomains.map(host));
  const referencedBy = runtime
    .filter((t) => !t.cohortOnly && t.tenantId !== existing.tenantId)
    .filter((t) =>
      planCohortTargets(t, runtime).entries.some((e) => e.targetTenantId === existing.tenantId || e.draftId === existing.tenantId),
    )
    .map((t) => ({ tenantId: t.tenantId, brandName: t.brandName }));
  const history = await store.getScorecardHistory(existing.tenantId, Number.MAX_SAFE_INTEGER);
  const kind: TenantConflict['kind'] = (await isBakedTenant(existing.tenantId)) ? 'repo' : existing.cohortOnly ? 'competitor' : 'customer';
  return {
    kind,
    tenantId: existing.tenantId,
    brandName: existing.brandName,
    industry: existing.industry,
    region: existing.region,
    ownedDomains: existing.ownedDomains,
    sameSite: existing.ownedDomains.some((d) => drafts.has(host(d))),
    weeks: history.length,
    referencedBy,
  };
}

export interface PromoteResult {
  ok: true;
  tenantId: string;
  brandName: string;
  /** 경쟁사 목록에서 이 브랜드를 뺀 고객 브랜드. */
  removedFrom: string[];
  /** 빼지 못한 고객 브랜드와 이유(전환은 이미 됐다). */
  removeErrors: { tenantId: string; error: string }[];
}

/**
 * 경쟁사로만 재던 브랜드를 고객 브랜드로 전환한다 — id를 그대로 두고 등록 화면에서 넣은 값으로 바꾼다.
 * removeFrom의 고객 브랜드에서는 이 브랜드를 경쟁사 목록에서 뺀다(업종이 바뀌면 그 브랜드 측정에서
 * 「이름 겹침 · 측정 안 됨」으로 남기 때문 — cohortPlan.ts). 빼기는 경쟁사 편집 저장과 같은 길이라 되돌릴 수 있다.
 */
export async function promoteCompetitor(draft: TenantConfig, removeFrom: string[], store: ResultStore): Promise<PromoteResult> {
  if (measureInFlight()) throw new EditorError(409, '측정이 진행 중이에요. 끝난 뒤에 전환해 주세요.');
  const conflict = await describeTenantConflict(draft, store);
  if (!conflict) throw new EditorError(404, `전환할 브랜드가 없습니다: ${draft.tenantId} — 그냥 등록하세요.`);
  if (conflict.kind === 'customer') throw new EditorError(409, `${topicParticle(conflict.brandName)} 이미 고객 브랜드예요 — 브랜드 관리에서 고치세요.`);
  if (conflict.kind === 'repo') throw new EditorError(409, `${topicParticle(conflict.brandName)} 저장소 설정에 있는 브랜드라 앱에서 바꿀 수 없어요.`);
  if (!conflict.sameSite) {
    throw new EditorError(409, `같은 id(${conflict.tenantId})를 쓰는 다른 곳(${conflict.ownedDomains.join(', ') || '홈페이지 없음'})이 있어 전환할 수 없어요.`);
  }

  await replaceOverlayTenant({ ...draft, cohortOnly: undefined });

  const removedFrom: string[] = [];
  const removeErrors: PromoteResult['removeErrors'] = [];
  const runtime = await loadRuntimeTenants();
  const drafts = new Set(draft.ownedDomains.map(host));
  for (const id of new Set(removeFrom)) {
    const customer = runtime.find((t) => t.tenantId === id && !t.cohortOnly);
    if (!customer) {
      removeErrors.push({ tenantId: id, error: '고객 브랜드가 아닙니다.' });
      continue;
    }
    const kept = customer.competitors.filter(
      (c) => competitorDraftId(customer, c) !== draft.tenantId && !c.domains.some((d) => drafts.has(host(d))),
    );
    if (kept.length === customer.competitors.length) continue;
    try {
      await saveEdit(id, store, { competitors: kept, summary: `빼기 · ${draft.brandName}(고객 브랜드로 전환)` });
      removedFrom.push(id);
    } catch (err) {
      removeErrors.push({ tenantId: id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { ok: true, tenantId: draft.tenantId, brandName: draft.brandName, removedFrom, removeErrors };
}
