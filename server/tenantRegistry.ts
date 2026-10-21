import { readdir } from 'node:fs/promises';
import path from 'node:path';
import rawTenants from './tenants.config.json' with { type: 'json' };
import { packagedDataMode, PIPELINE_DATA_DIR } from './appPaths.js';
import { reconcileCohortRanks } from './cohortRank.js';
import { appendTenant, loadTenants } from './config.js';
import { blobStoreEnabled, canPersistTenants, readOverlay, removeOverlayTenant, writeOverlay } from './tenantOverlay.js';
import { addDeletedTenant, readDeletedTenants, removeDeletedTenant } from './tenantTombstone.js';
import { readFactGraphFile } from './factGraphStore.js';
import { readBrandPageUrl } from './brandPageStore.js';
import { readTenantEngines } from './tenantEnginesStore.js';
import { readTenantScope, type TenantScope } from './tenantScopeStore.js';
import { overrideApplies, readCompetitorOverride } from './tenantCompetitorsStore.js';
import type { ResultStore } from './store.js';
import type { TenantConfig } from './types.js';
import type { Engine } from '../src/prompts/types.js';
import { sameCohort, sharesSite } from '../src/lib/brandVariant.js';

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
 * 로컬/패키징에서 브랜드를 지운다 — 툼스톤을 달고, 그 브랜드가 끼어 있던 코호트의 순위를 다시 매긴다.
 *
 * 툼스톤은 브랜드 목록(loadRuntimeTenants)과 코호트 순위(store.getCohortScorecards) 양쪽이 걸러 낸다.
 * 예전에는 베이크된 브랜드에만 달고, 앱에서 등록한 브랜드·자동 등록된 경쟁사는 오버레이에서만 뺐다 —
 * 측정 데이터(data/<id>/)는 남으므로 지운 브랜드가 순위표에 계속 끼었다.
 *
 * 순위는 스코어카드에 저장된 값이라(개요·보고서가 그 값을 읽는다) 툼스톤만으로는 남은 브랜드의 「2/6」이
 * 그대로다. 지운 브랜드가 측정된 주차·코호트마다 측정 끝에 쓰는 것과 같은 재계산을 돌린다.
 * 측정 데이터는 지우지 않는다 — 툼스톤을 걷으면(같은 id로 다시 등록·측정) 되살아난다.
 */
export async function deleteTenantLocally(tenantId: string, store: ResultStore): Promise<{ ranksUpdated: number }> {
  const history = await store.getScorecardHistory(tenantId, Number.MAX_SAFE_INTEGER);
  await addDeletedTenant(tenantId);
  const cohorts = new Map<string, { industry: string; region: string; weekOf: string }>();
  for (const c of history) cohorts.set(`${c.industry}|${c.region}|${c.weekOf}`, c);
  let ranksUpdated = 0;
  for (const { industry, region, weekOf } of cohorts.values()) {
    ranksUpdated += await reconcileCohortRanks(store, industry, region, weekOf);
  }
  return { ranksUpdated };
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

/**
 * 새 브랜드가 쓰는 코호트 공통 질문지 버전.
 *
 * 브랜드마다 질문 은행을 따로 만들면 일반 질문(브랜드 이름 없는 질문)이 브랜드마다 달라 코호트
 * 순위가 질문지 차이를 잰다 — 실측 W40 성동구 정형외과: 경쟁 병원 질문지에만 자기 동네를 짚은 지역
 * 질문이 11~15개 있어, 공유 질문지로 다시 재자 왕십리본 35 → 9점, 옥수 본 0/66 → 5/66이 됐다.
 * 그래서 등록되는 모든 브랜드가 코호트 질문지를 쓴다(cohortQuestionBank.ts). 경쟁사 초안은 본 브랜드의
 * 값을 물려받는다(cohortPlan.ts cohortOnlyDraft).
 */
export const DEFAULT_COHORT_QUESTION_BANK = 'c1';

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
    // 지정이 없으면 기본 코호트 질문지를 쓴다(DEFAULT_COHORT_QUESTION_BANK 주석). 정규화는 등록·측정 요청·
    // 경쟁사 초안에서만 돈다 — 저장된 베이스·오버레이 테넌트는 이 함수를 거치지 않아 값이 바뀌지 않는다.
    cohortQuestionBank: d.cohortQuestionBank || DEFAULT_COHORT_QUESTION_BANK,
    // 알 수 없는 값은 버린다 — 한국어(기본)로 측정하는 편이, 엉뚱한 언어로 은행을 만드는 것보다 낫다.
    ...(d.questionLanguage === 'en' ? { questionLanguage: 'en' as const } : {}),
    // 시장 범위 — 지역형이 기본이라 값이 없거나 모르면 적지 않는다. 구매자는 B2B형에서만 남긴다.
    ...(d.marketScope === 'national' || d.marketScope === 'b2b' ? { marketScope: d.marketScope } : {}),
    ...(d.marketScope === 'b2b' && typeof d.buyer === 'string' && d.buyer.trim() ? { buyer: d.buyer.trim().slice(0, 120) } : {}),
  };
}

/** 시장 범위 파일은 범위 · 구매자를 통째로 정한다 — 파일에 구매자가 없으면 설정의 구매자도 지운다. */
function withScope(tenant: TenantConfig, scope: TenantScope): TenantConfig {
  const next: TenantConfig = { ...tenant, marketScope: scope.marketScope };
  if (scope.buyer) next.buyer = scope.buyer;
  else delete next.buyer;
  return next;
}

/** 앱에서 고친 경쟁사 목록을 베이스가 바뀌어 쓰지 않을 때 한 번만 알린다(목록을 읽을 때마다 찍히지 않게). */
const staleCompetitorWarned = new Set<string>();

export async function loadRuntimeTenants(): Promise<TenantConfig[]> {
  return mergeRuntimeTenants(true);
}

/**
 * 앱에서 고친 경쟁사 목록(competitors.json)을 빼고 병합한 테넌트 — 경쟁사 편집이 베이스 지문을 적고,
 * 「저장소 설정으로 돌아가기」가 돌아갈 목록을 보여 줄 때 쓴다.
 */
export async function loadTenantWithoutCompetitorEdit(tenantId: string): Promise<TenantConfig | undefined> {
  return (await mergeRuntimeTenants(false)).find((t) => t.tenantId === tenantId);
}

async function mergeRuntimeTenants(withCompetitorEdits: boolean): Promise<TenantConfig[]> {
  const [base, overlay, deleted] = await Promise.all([baseTenants(), readOverlay(), readDeletedTenants()]);
  const map = new Map<string, TenantConfig>();
  for (const tenant of base) map.set(tenant.tenantId, tenant);
  for (const tenant of overlay) {
    if (!map.has(tenant.tenantId)) map.set(tenant.tenantId, tenant);
  }
  // 삭제(툼스톤)된 테넌트는 목록·선택지에서 제외한다.
  for (const id of deleted) map.delete(id);
  // 사람이 앱에서 고치는 값(팩트 그래프·브랜드 페이지 주소·수집 엔진·시장 범위·경쟁사 목록)만은 저장한
  // 파일이 베이스·오버레이를 모두 이긴다 — 베이스가 이기는 병합 규칙 탓에 릴리스 없이는 반영되지
  // 않기 때문이다. 경쟁사 목록은 고객 브랜드만 고치고, 베이스가 그 뒤에 바뀌었으면 쓰지 않는다
  // (tenantCompetitorsStore.ts 지문 주석).
  const tenants = [...map.values()];
  const [facts, pages, engines, scopes, competitorEdits] = await Promise.all([
    Promise.all(tenants.map((t) => readFactGraphFile(t.tenantId))),
    Promise.all(tenants.map((t) => readBrandPageUrl(t.tenantId))),
    Promise.all(tenants.map((t) => readTenantEngines(t.tenantId))),
    Promise.all(tenants.map((t) => readTenantScope(t.tenantId))),
    Promise.all(tenants.map((t) => (withCompetitorEdits && !t.cohortOnly ? readCompetitorOverride(t.tenantId) : null))),
  ]);
  return tenants.map((t, i) => {
    const edit = competitorEdits[i]?.current ?? null;
    const applies = overrideApplies(edit, t);
    if (edit && !applies && !staleCompetitorWarned.has(t.tenantId)) {
      staleCompetitorWarned.add(t.tenantId);
      console.warn(`[tenantRegistry] ${t.tenantId}: 저장소 설정이 바뀌어 앱에서 고친 경쟁사 목록을 쓰지 않습니다(competitors.json).`);
    }
    return {
      ...(scopes[i] ? withScope(t, scopes[i]!) : t),
      ...(facts[i] ? { factGraph: facts[i]! } : {}),
      ...(pages[i] ? { brandPageUrl: pages[i]! } : {}),
      ...(engines[i] ? { engines: engines[i]! } : {}),
      // 경쟁사를 바꾸며 고쳐 만든 질문지가 있으면 그 버전 · 크기로 잰다(competitorEditor.ts 4단계).
      ...(applies
        ? {
            competitors: edit.competitors,
            ...(edit.questionBank ? { questionBankVersion: edit.questionBank.version, questionBankSize: edit.questionBank.size } : {}),
          }
        : {}),
    };
  });
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
  // 지운 브랜드를 다시 측정하는 경우(다른 브랜드의 경쟁사 목록에 남아 있으면 측정 때 다시 잰다) — 툼스톤이
  // 남으면 데이터는 쌓이는데 목록·순위에서 안 보인다. 측정·등록한다는 것은 다시 쓰는 브랜드라는 뜻이다.
  await removeDeletedTenant(tenant.tenantId);
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

/**
 * 오버레이에 있는 브랜드 하나를 통째로 바꾼다 — 경쟁사로만 재던 브랜드를 고객 브랜드로 전환할 때(tenantPromote.ts).
 * 오버레이에 없으면(저장소 설정의 브랜드 · dev 체크아웃) 바꿀 수 없다 — 베이스가 이기므로 오버레이에 써도 무시된다.
 * 다른 영속화와 같은 줄에서 돈다(serializePersist).
 */
export function replaceOverlayTenant(tenant: TenantConfig): Promise<void> {
  return replaceOverlayTenants([tenant]);
}

/**
 * 오버레이의 브랜드 여럿을 한 번에 바꾼다 — 기본 정보를 고칠 때 고객과 함께 옮기는 경쟁사(brandProfileEditor.ts).
 * 하나라도 오버레이에 없으면 아무것도 쓰지 않는다. 오버레이 파일은 한 번만 쓴다.
 */
export function replaceOverlayTenants(tenants: TenantConfig[]): Promise<void> {
  return serializePersist(async () => {
    if (!process.env.VERCEL && !packagedDataMode()) {
      throw new Error('dev 체크아웃에서는 저장소 설정(tenants.config.json)을 직접 고치세요.');
    }
    const overlay = await readOverlay();
    for (const tenant of tenants) {
      const i = overlay.findIndex((item) => item.tenantId === tenant.tenantId);
      if (i < 0) throw new Error(`오버레이에 없는 브랜드입니다: ${tenant.tenantId}`);
      overlay[i] = tenant;
    }
    await writeOverlay(overlay);
  });
}

/**
 * 새로 들어오는 브랜드가 쓸 코호트 공통 질문지 버전 — 같은 코호트(업종 · 지역 · 언어)의 고객 브랜드가 쓰는 버전을 따른다.
 * 기본 정보 고치기(brandProfileEditor.ts)가 공통 질문지를 올린 코호트(c1 → c2)에 기본값 c1으로 들어오면, 한 순위표에서 옛 질문을
 * 따로 쓰게 된다. 같은 코호트에 고객이 없거나 공통 질문지를 쓰지 않는 브랜드면 그대로.
 */
export function cohortBankFor(tenant: TenantConfig, runtime: TenantConfig[]): string | undefined {
  if (!tenant.cohortQuestionBank) return tenant.cohortQuestionBank;
  const counts = new Map<string, number>();
  for (const t of runtime) {
    if (t.cohortOnly || t.tenantId === tenant.tenantId || !t.cohortQuestionBank || !sameCohort(t, tenant)) continue;
    counts.set(t.cohortQuestionBank, (counts.get(t.cohortQuestionBank) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? tenant.cohortQuestionBank;
}

/**
 * 새로 쓸 질문지 버전 — 그 버전 파일이 이미 있으면(지운 같은 id · 경쟁사로 잴 때 만든 것) 안 쓰인 다음 번호로 올린다.
 * 옛 질문지는 경쟁사 목록 없이 만들었거나 다른 코호트 공통 질문지로 만든 것이라, 다시 쓰면 첫 측정이 「questionBankVersion을 새 값으로
 * 올리세요」로 멈춘다(cohortQuestionBank.ts ensureComposedQuestionBank). 지난 주차는 자기 버전의 질문지를 그대로 읽고, 화면은 질문지가
 * 바뀐 주를 「질문지 v3→v6」로 비교에서 뺀다.
 */
export async function freshBankVersion(tenantId: string, wanted: string): Promise<string> {
  let files: string[];
  try {
    files = await readdir(path.join(PIPELINE_DATA_DIR, tenantId, 'question-bank'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return wanted;
    throw err;
  }
  const used = new Set(files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length)));
  if (!used.has(wanted)) return wanted;
  const numbers = [...used, wanted].map((v) => /^v(\d+)$/.exec(v)?.[1]).filter((n): n is string => Boolean(n)).map(Number);
  let next = Math.max(0, ...numbers) + 1;
  while (used.has(`v${next}`)) next += 1;
  return `v${next}`;
}

export async function registerTenant(tenant: TenantConfig): Promise<void> {
  const existing = await loadRuntimeTenants();
  if (existing.some((item) => item.tenantId === tenant.tenantId)) {
    throw new Error(`이미 존재하는 tenantId입니다: ${tenant.tenantId}`);
  }
  // 같은 홈페이지 · 같은 코호트(업종 · 지역 · 언어)의 고객 브랜드가 다른 id로 있으면 막는다 — 같은 질문지 · 순위표를 두 브랜드가
  // 나눠 쓰게 된다(지운 브랜드를 다른 id로 되살리는 경우 등). 다른 범위로 하나 더 등록(tenantPromote registerVariant)은 코호트가 달라 지나간다.
  if (!tenant.cohortOnly) {
    const twin = existing.find((item) => !item.cohortOnly && sharesSite(item, tenant) && sameCohort(item, tenant));
    if (twin) throw new Error(`이미 존재하는 홈페이지 · 코호트입니다: ${twin.tenantId}(${twin.brandName} · ${twin.industry} · ${twin.region})`);
  }
  // 이전에 삭제(툼스톤)된 tenantId를 다시 등록하는 경우, 툼스톤을 걷어내 다시 보이게 한다.
  await removeDeletedTenant(tenant.tenantId);
  const cohortQuestionBank = tenant.cohortOnly ? tenant.cohortQuestionBank : cohortBankFor(tenant, existing);
  if (cohortQuestionBank === tenant.cohortQuestionBank) {
    await persistTenantForRuntime(tenant);
    return;
  }
  // 공통 질문지를 바꾸면 질문지 번호도 비어 있는 것으로 — 지운 같은 id에 남은 그 번호의 질문지는 옛 공통 질문지로 만든 것이다.
  const questionBankVersion = await freshBankVersion(tenant.tenantId, tenant.questionBankVersion);
  await persistTenantForRuntime({ ...tenant, cohortQuestionBank, questionBankVersion });
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
    marketScope: tenant.marketScope ?? 'local',
    ...(tenant.buyer ? { buyer: tenant.buyer } : {}),
  };
}
