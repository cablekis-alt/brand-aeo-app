import { normalizeTenantDraft } from './tenantRegistry.js';
import type { CompetitorContext } from '../src/prompts/types.js';
import type { TenantConfig } from './types.js';

// 자동 추론된 경쟁사를 코호트로 함께 측정할 때 최대 개수(측정량·시간 제한).
export const MAX_AUTO_COHORT = 5;

export function slugFromDomain(domain: string): string {
  const label = domain.split('.')[0] || 'brand';
  return label.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'brand';
}

/** 도메인 없는 경쟁사용 안정 ID — 이름(한글 등 비ASCII 포함) 해시. */
export function slugFromName(name: string): string {
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return 'comp-' + h.toString(36);
}

/** 경쟁사 한 줄이 측정될 때 쓰는 테넌트 ID. 도메인이 있으면 도메인 slug, 없으면 이름 해시. */
export function competitorDraftId(tenant: TenantConfig, competitor: CompetitorContext): string {
  const domain = competitor.domains?.[0];
  const baseId = domain ? slugFromDomain(domain) : slugFromName(competitor.name);
  // 영어 측정의 경쟁사는 ID에 -en을 붙인다 — 같은 병원을 한국어로 재는 테넌트와 데이터 폴더가 겹치지 않게.
  return baseId && tenant.questionLanguage === 'en' ? `${baseId}-en` : baseId;
}

function cohortOnlyDraft(tenant: TenantConfig, competitor: CompetitorContext, id: string): TenantConfig {
  const domain = competitor.domains?.[0];
  return normalizeTenantDraft({
    tenantId: id,
    brandName: competitor.name,
    aliases: competitor.aliases?.length ? competitor.aliases : [competitor.name],
    ownedDomains: domain ? [domain] : [], // 도메인 없으면 빈 배열 — brandOwnedCitation만 null 처리됨
    industry: tenant.industry,
    region: tenant.region,
    engines: tenant.engines,
    questionBankSize: tenant.questionBankSize,
    questionBankVersion: tenant.questionBankVersion,
    repeatsPerQuestion: tenant.repeatsPerQuestion,
    // 같은 코호트의 시험지·언어를 그대로 쓴다. 안 넘기면 새 경쟁사만 한국어 질문과 자기만의
    // 은행으로 재게 되어, 코호트 안에서 서로 다른 시험지를 풀게 된다.
    ...(tenant.questionLanguage ? { questionLanguage: tenant.questionLanguage } : {}),
    ...(tenant.cohortQuestionBank ? { cohortQuestionBank: tenant.cohortQuestionBank } : {}),
    // 시장 범위 · 구매자도 물려받는다 — 같은 코호트가 같은 성격의 질문지(소비자 / 구매 담당자)를 풀게.
    ...(tenant.marketScope ? { marketScope: tenant.marketScope } : {}),
    ...(tenant.buyer ? { buyer: tenant.buyer } : {}),
    competitors: [],
    factGraph: [],
    cohortOnly: true,
  });
}

/**
 * 경쟁사 한 줄이 이번 측정에서 어떻게 되는가.
 *
 * - measured: 함께 잰다.
 * - waiting: 앞에서 MAX_AUTO_COHORT칸이 찼다. 재지 않는다.
 * - collision: ID가 다른 업종·언어의 브랜드와 겹쳐 재지 않는다. **칸은 차지한다**(아래 순서 참고).
 * - duplicate: 앞 줄과 같은 대상으로 잰다. 슬롯을 자르기 전에 걸러지면 칸을 차지하지 않고,
 *   자른 뒤(도메인으로 같은 기존 브랜드에 이어질 때) 걸러지면 칸을 차지한다 — takesSlot으로 구분한다.
 * - unnamed: 이름이 비어 건너뛴다.
 */
export type CompetitorPlanStatus = 'measured' | 'waiting' | 'collision' | 'duplicate' | 'unnamed';

export interface CompetitorPlanEntry {
  /** tenant.competitors에서의 위치(0부터). */
  index: number;
  name: string;
  /** 이 줄로 만든 초안 ID. 이름이 없으면 null. */
  draftId: string | null;
  status: CompetitorPlanStatus;
  /** MAX_AUTO_COHORT칸 중 하나를 쓰는가. */
  takesSlot: boolean;
  /** 실제로 재는 테넌트 ID(기존 브랜드면 그 ID). measured일 때만. */
  targetTenantId?: string;
  /** 이미 등록된 브랜드로 잰다면 그 브랜드. */
  existing?: { tenantId: string; brandName: string; region: string; cohortOnly: boolean };
  /** 다른 지역의 기존 브랜드로 잰다 — 그 카드는 이 코호트 순위표에 들어오지 않는다. */
  otherRegion?: boolean;
  /** collision일 때 겹친 브랜드. */
  collidesWith?: { tenantId: string; brandName: string; industry: string; region: string };
}

export interface CohortPlan {
  cap: number;
  entries: CompetitorPlanEntry[];
  /** 함께 잴 테넌트(selectCohortTargets와 같다). */
  targets: TenantConfig[];
}

/**
 * 브랜드와 함께 측정할 경쟁사 — 등록된 경쟁사는 본 테넌트로(코호트 재확장 없이), 없으면 cohortOnly 초안.
 * 줄마다 왜 재거나 재지 않는지도 함께 돌려준다(경쟁사 편집 서랍의 「함께 측정 5/5 · 대기」).
 *
 * 같은 업종에서는 자사 도메인으로 먼저 찾는다. 초안 ID는 도메인 첫 마디라 다른 업종 브랜드와
 * 겹친다 — 2026-W40 SK텔레콤 측정에서 경쟁사 KT(kt.com)가 ID "kt"가 되어, 통신 KT(ktcorp)
 * 대신 테이블오더의 KT 하이오더(kt)를 재측정했다. 같은 업종이면 지역이 달라도(강남·서초 성형외과)
 * 함께 잰다.
 *
 * 도메인은 같은 코호트(업종+지역)에서 먼저 찾는다. 영어 질문 측정(banobagi-en 등)은 한국어 측정과
 * 업종·도메인이 같고 지역 꼬리표만 달라, 업종만 보면 한국어 테넌트를 재측정하게 된다.
 *
 * 순서: 초안 중복을 거른 뒤 앞 MAX_AUTO_COHORT칸을 자르고, 그다음 충돌을 건너뛴다. 그래서 칸 안에서
 * 충돌이 나면 함께 재는 수가 줄고 대기 중인 줄이 그 자리를 채우지 않는다 — 측정 대상이 바뀌는
 * 동작이라 그대로 두고, 화면에 사실대로 보인다.
 */
export function planCohortTargets(tenant: TenantConfig, runtime: TenantConfig[]): CohortPlan {
  const entries: CompetitorPlanEntry[] = [];
  const drafts: { entry: CompetitorPlanEntry; draft: TenantConfig }[] = [];
  const draftIds = new Set<string>([tenant.tenantId]);
  tenant.competitors.forEach((competitor, index) => {
    if (!competitor.name) {
      entries.push({ index, name: '', draftId: null, status: 'unnamed', takesSlot: false });
      return;
    }
    const id = competitorDraftId(tenant, competitor);
    const entry: CompetitorPlanEntry = { index, name: competitor.name, draftId: id || null, status: 'duplicate', takesSlot: false };
    entries.push(entry);
    if (!id || draftIds.has(id)) return;
    draftIds.add(id);
    drafts.push({ entry, draft: cohortOnlyDraft(tenant, competitor, id) });
  });

  const existingById = new Map(runtime.map((item) => [item.tenantId, item]));
  // 질문 언어가 다르면 다른 시장을 재는 것이다 — 같은 병원이라도 함께 측정하지 않는다.
  const language = (t: TenantConfig) => t.questionLanguage ?? 'ko';
  const sameIndustry = (t: TenantConfig) => t.industry === tenant.industry && language(t) === language(tenant);
  const sameCohort = (t: TenantConfig) => sameIndustry(t) && t.region === tenant.region;
  const sameCohortByDomain = new Map<string, TenantConfig>();
  const sameIndustryByDomain = new Map<string, TenantConfig>();
  for (const t of runtime) {
    if (!sameIndustry(t)) continue;
    for (const d of t.ownedDomains ?? []) {
      sameIndustryByDomain.set(d.toLowerCase(), t);
      if (sameCohort(t)) sameCohortByDomain.set(d.toLowerCase(), t);
    }
  }
  const targets: TenantConfig[] = [];
  const seen = new Set<string>([tenant.tenantId]);
  drafts.forEach(({ entry, draft }, i) => {
    if (i >= MAX_AUTO_COHORT) {
      entry.status = 'waiting';
      return;
    }
    entry.takesSlot = true;
    const domain = draft.ownedDomains[0]?.toLowerCase();
    const existing =
      (domain ? (sameCohortByDomain.get(domain) ?? sameIndustryByDomain.get(domain)) : undefined) ??
      existingById.get(draft.tenantId);
    // ID만 같은 다른 업종(또는 다른 질문 언어) 브랜드는 재측정하지 않는다. 같은 ID로 새로 만들어도 그 브랜드의
    // 데이터 폴더에 섞이므로 건너뛴다(측정할 때 selectCohortTargets가 알린다).
    if (existing && !sameIndustry(existing)) {
      entry.status = 'collision';
      entry.collidesWith = {
        tenantId: existing.tenantId,
        brandName: existing.brandName,
        industry: existing.industry,
        region: existing.region,
      };
      return;
    }
    const targetId = existing?.tenantId ?? draft.tenantId;
    if (seen.has(targetId)) return;
    seen.add(targetId);
    entry.status = 'measured';
    entry.targetTenantId = targetId;
    if (existing) {
      entry.existing = {
        tenantId: existing.tenantId,
        brandName: existing.brandName,
        region: existing.region,
        cohortOnly: Boolean(existing.cohortOnly),
      };
      if (existing.region !== tenant.region) entry.otherRegion = true;
    }
    targets.push(existing ? { ...existing, autoCohort: false } : draft);
  });
  return { cap: MAX_AUTO_COHORT, entries, targets };
}

/** 브랜드와 함께 측정할 경쟁사(planCohortTargets의 targets). */
export function selectCohortTargets(tenant: TenantConfig, runtime: TenantConfig[]): TenantConfig[] {
  const plan = planCohortTargets(tenant, runtime);
  for (const entry of plan.entries) {
    if (entry.status !== 'collision' || !entry.collidesWith) continue;
    const other = entry.collidesWith;
    console.warn(
      `[measureAndBake] 경쟁사 ${entry.name}: ID ${entry.draftId}가 다른 업종·언어의 ` +
        `${other.brandName}(${other.industry} · ${other.region})와 겹쳐 함께 측정하지 않습니다.`,
    );
  }
  return plan.targets;
}
