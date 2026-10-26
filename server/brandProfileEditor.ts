import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BUNDLED_COHORT_BANK_DIR, COHORT_BANK_DIR, packagedDataMode, PIPELINE_DATA_DIR } from './appPaths.js';
import { planCohortTargets } from './cohortPlan.js';
import { cohortKey } from './cohortQuestionBank.js';
import { EditorError } from './competitorEditor.js';
import { getIsoWeekString } from './dateUtil.js';
import { readMeasureRequests } from './measureRequests.js';
import { measureInFlight } from './measureTracker.js';
import { nextBankVersion } from './questionHandoff.js';
import { baseFingerprint, readCompetitorOverride, serializeCompetitorFile, writeCompetitorOverride, type CompetitorOverride } from './tenantCompetitorsStore.js';
import { readOverlay } from './tenantOverlay.js';
import { isBakedTenant, loadRuntimeTenants, replaceOverlayTenants } from './tenantRegistry.js';
import { readTenantScope, writeTenantScope } from './tenantScopeStore.js';
import { isAddressLike, isDomainLike, sameCohort, scopeLabel, sharesSite } from '../src/lib/brandVariant.js';
import { directionParticle, subjectParticle, topicParticle } from '../src/lib/korean.js';
import { MARKET_SCOPES, NATIONAL_REGION, type MarketScope } from '../src/prompts/types.js';
import type { WeeklyScorecard } from '../src/prompts/b8-report.js';
import type { ResultStore } from './store.js';
import type { TenantConfig } from './types.js';

/**
 * 브랜드 기본 정보(상호 · 별칭 · 업종 · 지역 · 시장 범위) 고치기 — 브랜드 현황 코호트 카드의 「기본 정보」 서랍(components/ProfileEditor.tsx).
 *
 * 상호 · 별칭(상용화 UI 3차 U7): 상호 칸에 주소를 넣어 등록한 브랜드(실측 dona — 이름 · 별칭이 모두 「https://www.dona.kr/」)를 앱에서
 * 고칠 길이 없었다. 상호를 바꾸면 이름을 넣은 질문도 새 이름으로 만들어야 해 질문지 번호를 올린다(업종 · 지역과 같은 길). 별칭만 바꾸면
 * 질문은 그대로이고 다음 측정의 언급 판정만 달라진다 — 질문지를 올리지 않는다. 경쟁사 측정 브랜드의 이름은 바꾸지 않는다.
 *
 * 왜: 등록한 뒤 업종 · 지역 · 범위를 바꾸려면 설정 파일을 손으로 고쳐야 했다(2026-10-21 군산각 지역형 전환). 그런데 그냥 바꾸면
 * 1. 질문지 — 같은 질문지 버전이 옛 코호트로 만든 것이라 측정이 멈추거나(cohortQuestionBank.ts ensureComposedQuestionBank),
 *    범위만 바꾸면 옛 질문으로 계속 잰다. 그래서 질문지 버전을 쓰인 적 없는 다음 번호로 올린다.
 * 2. 경쟁사 — 앱에서 고친 경쟁사 목록(competitors.json)은 오버레이 항목의 지문과 맞을 때만 쓰인다(tenantCompetitorsStore.ts
 *    baseFingerprint). 지문에는 질문지 버전이 들어 있어, 버전을 올리면 목록이 말없이 꺼진다. 저장할 때 지문을 다시 적는다.
 * 3. 경쟁사 측정 브랜드 — 이미 등록된 경쟁사는 자기 설정으로 잰다(cohortPlan.ts). 이 고객만 재는 경쟁사는 함께 옮기고,
 *    다른 고객도 재는 곳은 옮기지 않고 알리기만 한다.
 * 앱에서 등록한 브랜드(오버레이)만 고친다 — 저장소 설정 브랜드는 베이스가 이겨 오버레이를 바꿔도 무시된다. 데스크톱 전용.
 * 지난 기록은 옮기지 않는다 — 옛 카드는 옛 코호트에 남고, 다음 측정부터 새 코호트로 잰다.
 */

export interface ProfileCompetitor {
  tenantId: string;
  brandName: string;
  industry: string;
  region: string;
  /** 함께 옮길 수 있는가 — 앱에서 등록했고 이 고객만 재는 경쟁사. */
  movable: boolean;
  /** 기본으로 함께 옮기는가 — 지금 이 고객과 같은 코호트에 있는 곳(다른 지역에서 재던 곳은 고른 사람만 옮긴다). */
  defaultMove: boolean;
  /** 옮길 수 없는 까닭. */
  reason: string | null;
}

export interface ProfileEditorState {
  tenantId: string;
  brandName: string;
  aliases: string[];
  industry: string;
  region: string;
  marketScope: MarketScope;
  buyer: string;
  questionBankVersion: string;
  /** 이 서랍에서 고칠 수 있는가. 못 하면 reason. */
  editable: boolean;
  reason: string | null;
  measuring: boolean;
  /** 입력 칸 자동 완성 — 등록된 브랜드의 업종 · 지역. */
  industries: string[];
  regions: string[];
  /** 이 고객과 함께 재는 경쟁사 측정 브랜드. */
  competitors: ProfileCompetitor[];
}

export interface ProfileInput {
  /** 없으면 그대로. */
  brandName?: string;
  /** 없으면 그대로. */
  aliases?: string[];
  industry: string;
  region: string;
  marketScope: MarketScope;
  buyer: string;
  /** 함께 옮길 경쟁사 측정 브랜드 id. */
  move: string[];
}

export interface ProfileTarget {
  brandName: string;
  aliases: string[];
  industry: string;
  region: string;
  marketScope: MarketScope;
  buyer: string;
  questionBankVersion: string;
  /** 코호트 공통 질문지 버전. 고객이 공통 질문지를 쓰지 않으면 null. */
  cohortQuestionBank: string | null;
}

export interface ProfilePlan {
  /** 저장할 때 같은 미리보기인지 확인하는 열쇠. */
  key: string;
  unchanged: boolean;
  /** 하나라도 있으면 저장할 수 없다. */
  errors: string[];
  notes: string[];
  measuring: boolean;
  to: ProfileTarget;
  bank: { from: string; to: string };
  cohortBank: { from: string | null; to: string | null; members: string[] };
  moving: { tenantId: string; brandName: string }[];
  /** 이번 주에 이미 잰 카드가 다음 측정에서 새 코호트로 바뀌는 브랜드. */
  thisWeek: string[];
  summary: string;
}

export interface ProfileSaveResult {
  ok: true;
  tenantId: string;
  summary: string;
  questionBankVersion: string;
  moved: string[];
  /** 옛 설정을 둔 폴더 이름(data/<id>/ 아래). */
  backupDir: string;
}

/** 저장 표식 — 다음 측정 전까지 브랜드 현황에 「기본 정보 바뀜 · 다음 측정 대기」를 띄운다. */
interface ProfileMarker {
  savedAt: string;
  summary: string;
  from: ProfileTarget;
  to: ProfileTarget;
}

const tenantDir = (tenantId: string) => path.join(PIPELINE_DATA_DIR, tenantId);
const markerPath = (tenantId: string) => path.join(tenantDir(tenantId), 'profile-edit.json');
const isMissing = (err: unknown) => (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
const scopeOf = (t: { marketScope?: string }): MarketScope => (t.marketScope === 'national' || t.marketScope === 'b2b' ? t.marketScope : 'local');
const isEnglish = (t: TenantConfig) => t.questionLanguage === 'en' || t.region.includes('(영어 질문)');
const tp = (w: string) => topicParticle(w).slice(w.length);
const sp = (w: string) => subjectParticle(w).slice(w.length);
const dp = (w: string) => directionParticle(w).slice(w.length);

/** 화면이 보낸 값을 고른다. 모양이 틀리면 400, 값이 비면 계획의 errors로 알린다. */
export function normalizeProfileInput(raw: unknown): ProfileInput {
  const d = (raw ?? {}) as Record<string, unknown>;
  const text = (v: unknown, label: string) => {
    if (v === undefined || v === null) return '';
    if (typeof v !== 'string') throw new EditorError(400, `${label} 값이 올바르지 않습니다.`);
    return v.trim();
  };
  const scope = d.marketScope ?? 'local';
  if (typeof scope !== 'string' || !MARKET_SCOPES.includes(scope as MarketScope)) throw new EditorError(400, `알 수 없는 시장 범위입니다: ${String(scope)}`);
  const marketScope = scope as MarketScope;
  if (d.move !== undefined && (!Array.isArray(d.move) || d.move.some((v) => typeof v !== 'string'))) throw new EditorError(400, '함께 옮길 경쟁사 목록이 올바르지 않습니다.');
  if (d.aliases !== undefined && (!Array.isArray(d.aliases) || d.aliases.some((v) => typeof v !== 'string'))) throw new EditorError(400, '별칭 목록이 올바르지 않습니다.');
  // 별칭 — 앞뒤 공백을 걷고 빈 값 · 같은 값은 뺀다(순서는 지킨다). 너무 긴 목록은 자른다.
  const aliases =
    d.aliases === undefined
      ? undefined
      : [...new Set((d.aliases as string[]).map((a) => a.trim().slice(0, 60)).filter(Boolean))].slice(0, 20);
  return {
    ...(d.brandName === undefined ? {} : { brandName: text(d.brandName, '상호').slice(0, 80) }),
    ...(aliases === undefined ? {} : { aliases }),
    industry: text(d.industry, '업종').slice(0, 60),
    // 전국형 · B2B형은 「국내」가 기본이다(BrandOnboarding.tsx와 같다). 이미 전국형 · B2B형인데 지역이 남은 브랜드는 그 지역을 그대로 둘 수 있다
    // (설치본에 11곳 — 코호트를 「국내」로 옮기는 일은 따로 정한다). 그 밖의 지역은 computePlan이 막는다.
    region: text(d.region, '지역').slice(0, 60) || (marketScope === 'local' ? '' : NATIONAL_REGION),
    marketScope,
    buyer: marketScope === 'b2b' ? text(d.buyer, '구매자').slice(0, 120) : '',
    move: [...new Set((d.move as string[] | undefined) ?? [])].sort(),
  };
}

interface Context {
  runtime: TenantConfig[];
  tenant: TenantConfig;
  /** 오버레이 원본 항목(앱에서 등록한 브랜드) — 런타임 값이 아니라 이것을 바꾼다. */
  entry: TenantConfig | null;
  overlay: TenantConfig[];
  reason: string | null;
}

async function loadContext(tenantId: string): Promise<Context> {
  const runtime = await loadRuntimeTenants();
  const tenant = runtime.find((t) => t.tenantId === tenantId);
  if (!tenant || tenant.cohortOnly) throw new EditorError(404, `고객 브랜드를 찾을 수 없습니다: ${tenantId}`);
  const overlay = await readOverlay();
  const entry = overlay.find((t) => t.tenantId === tenantId) ?? null;
  let reason: string | null = null;
  if (!process.env.VERCEL && !packagedDataMode()) reason = 'dev 체크아웃에서는 저장소 설정(tenants.config.json)을 직접 고치세요.';
  else if (await isBakedTenant(tenantId)) reason = '저장소 설정에 있는 브랜드라 앱에서 바꿀 수 없어요 — 릴리스로 고칩니다.';
  else if (!entry) reason = '앱에서 등록한 브랜드가 아니라 바꿀 수 없어요.';
  else if (isEnglish(tenant)) reason = '영어 질문 측정 브랜드는 아직 여기서 바꿀 수 없어요.';
  return { runtime, tenant, entry, overlay, reason };
}

interface LineTarget {
  name: string;
  tenantId: string;
  /** 이미 등록된 경쟁사 측정 브랜드(cohortOnly)인가. */
  cohortOnly: boolean;
}

/**
 * 고객이 재는(또는 칸이 나면 잴) 경쟁사 브랜드 — 측정 계획(cohortPlan.ts)의 measured 줄과, 칸이 차 대기 중인 줄을 한 줄씩 다시 계획해
 * 찾은 브랜드. 대기 줄도 앞 줄을 빼면 바로 재므로 함께 옮기기 · 함께 재는 고객 판단에 넣는다. 경쟁사를 재지 않는 고객(autoCohort 끔)은 없다.
 */
function lineTargets(customer: TenantConfig, runtime: TenantConfig[]): LineTarget[] {
  if (customer.autoCohort === false) return [];
  const out: LineTarget[] = [];
  for (const e of planCohortTargets(customer, runtime).entries) {
    const line = customer.competitors[e.index];
    const resolved = e.status === 'waiting' && line ? planCohortTargets({ ...customer, competitors: [line] }, runtime).entries[0] : e;
    if (resolved?.status !== 'measured' || !resolved.targetTenantId) continue;
    out.push({ name: e.name, tenantId: resolved.targetTenantId, cohortOnly: Boolean(resolved.existing?.cohortOnly) });
  }
  return out;
}

interface TargetMap {
  /** 이 고객이 재는 브랜드. */
  mine: LineTarget[];
  /** 브랜드 id → 그 브랜드를 재는 다른 고객 이름. */
  measuredBy: Map<string, string[]>;
  /** 어느 고객이든 재는 브랜드 — 아무도 재지 않는 경쟁사 측정 브랜드(지운 고객이 남긴 것 등)는 코호트 구성원으로 세지 않는다. */
  active: Set<string>;
}

function targetMap(tenant: TenantConfig, runtime: TenantConfig[]): TargetMap {
  const measuredBy = new Map<string, string[]>();
  const active = new Set<string>();
  const mine = lineTargets(tenant, runtime);
  for (const t of mine) active.add(t.tenantId);
  // 다른 고객이 재는 경쟁사 — 코호트와 상관없이 모든 고객을 본다(지역이 다른 같은 업종 고객도 도메인으로 잰다).
  for (const other of runtime) {
    if (other.cohortOnly || other.tenantId === tenant.tenantId) continue;
    for (const t of lineTargets(other, runtime)) {
      active.add(t.tenantId);
      measuredBy.set(t.tenantId, [...(measuredBy.get(t.tenantId) ?? []), other.brandName]);
    }
  }
  return { mine, measuredBy, active };
}

/** 이 고객과 함께 재는 경쟁사 측정 브랜드와, 함께 옮길 수 있는지. */
async function competitorsOf(ctx: Context, targets: TargetMap): Promise<ProfileCompetitor[]> {
  const { tenant, runtime } = ctx;
  const overlayIds = new Set(ctx.overlay.map((t) => t.tenantId));
  const { measuredBy } = targets;
  const out: ProfileCompetitor[] = [];
  const seen = new Set<string>();
  for (const e of targets.mine) {
    if (!e.cohortOnly || seen.has(e.tenantId)) continue;
    seen.add(e.tenantId);
    const t = runtime.find((x) => x.tenantId === e.tenantId);
    if (!t) continue;
    const shared = measuredBy.get(t.tenantId) ?? [];
    const reason = (await isBakedTenant(t.tenantId))
      ? '저장소 설정의 경쟁사라 옮길 수 없어요'
      : !overlayIds.has(t.tenantId)
        ? '앱에서 등록한 경쟁사가 아니라 옮길 수 없어요'
        : shared.length > 0
          ? `${[...new Set(shared)].join(', ')}도 함께 재는 경쟁사라 옮기지 않아요`
          : null;
    out.push({ tenantId: t.tenantId, brandName: t.brandName, industry: t.industry, region: t.region, movable: !reason, defaultMove: !reason && sameCohort(t, tenant), reason });
  }
  return out;
}

export async function describeProfileEditor(tenantId: string): Promise<ProfileEditorState> {
  const ctx = await loadContext(tenantId);
  const { tenant, runtime } = ctx;
  const sorted = (values: string[]) => [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
  const korean = runtime.filter((t) => !isEnglish(t));
  return {
    tenantId,
    brandName: tenant.brandName,
    aliases: tenant.aliases ?? [],
    industry: tenant.industry,
    region: tenant.region,
    marketScope: scopeOf(tenant),
    buyer: tenant.buyer ?? '',
    questionBankVersion: tenant.questionBankVersion,
    editable: !ctx.reason,
    reason: ctx.reason,
    measuring: measureInFlight(),
    industries: sorted(korean.map((t) => t.industry)),
    regions: sorted(korean.map((t) => t.region).filter((r) => r !== NATIONAL_REGION)),
    competitors: await competitorsOf(ctx, targetMap(tenant, runtime)),
  };
}

/** 같은 접두(v · en · c)의 번호 중 가장 큰 것 + 1 — 빈 번호를 채우지 않는다(지난 주가 그 번호의 다른 질문지를 읽는다). */
function nextAfterMax(current: string, used: Iterable<string>): string {
  const m = /^(.*?)(\d+)$/.exec(current);
  const prefix = m ? m[1]! : current;
  let max = current;
  let maxN = m ? Number(m[2]) : 0;
  for (const v of used) {
    const n = /^(.*?)(\d+)$/.exec(v);
    if (n && n[1] === prefix && Number(n[2]) > maxN) {
      maxN = Number(n[2]);
      max = v;
    }
  }
  return nextBankVersion(max, used);
}

/** 이 브랜드들이 한 번이라도 쓴(또는 예약한) 질문지 버전 — 은행 파일 · 카드 · 설정 · 경쟁사 편집 · 측정 대기열. */
async function usedBankVersions(ids: string[], ctx: Context, store: ResultStore, requests: { tenant: TenantConfig }[]): Promise<Set<string>> {
  const used = new Set<string>();
  for (const id of ids) {
    for (const v of await store.listQuestionBankVersions(id)) used.add(v);
    for (const c of await store.getScorecardHistory(id, Number.MAX_SAFE_INTEGER)) if (c.questionBankVersion) used.add(c.questionBankVersion);
    const runtime = ctx.runtime.find((t) => t.tenantId === id);
    if (runtime) used.add(runtime.questionBankVersion);
    const entry = ctx.overlay.find((t) => t.tenantId === id);
    if (entry) used.add(entry.questionBankVersion);
    for (const r of requests) if (r.tenant.tenantId === id && r.tenant.questionBankVersion) used.add(r.tenant.questionBankVersion);
  }
  const file = await readCompetitorOverride(ctx.tenant.tenantId);
  for (const v of [file?.current?.questionBank?.version, file?.lastSave?.before?.questionBank?.version, file?.measured?.bankVersion]) if (v) used.add(v);
  return used;
}

/** 이 코호트 키로 이미 있는 공통 질문지 버전(사용자 폴더 · 앱에 넣어 둔 것). readCohortBank는 동봉본을 복사하므로 쓰지 않는다. */
async function cohortBankVersions(key: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (const dir of [COHORT_BANK_DIR, BUNDLED_COHORT_BANK_DIR]) {
    if (!dir) continue;
    try {
      for (const f of await readdir(path.join(dir, key))) if (f.endsWith('.json')) out.add(f.slice(0, -'.json'.length));
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
  }
  return out;
}

function mostCommon(values: string[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

function describeChange(from: ProfileTarget, to: ProfileTarget): string {
  const parts: string[] = [];
  if (from.brandName !== to.brandName) parts.push(`상호 ${from.brandName} → ${to.brandName}`);
  if (!sameList(from.aliases, to.aliases)) parts.push(`별칭 ${to.aliases.length > 0 ? to.aliases.join(' · ') : '없음'}`);
  if (from.industry !== to.industry) parts.push(`업종 ${from.industry} → ${to.industry}`);
  if (from.region !== to.region) parts.push(`지역 ${from.region} → ${to.region}`);
  if (from.marketScope !== to.marketScope) parts.push(`${scopeLabel(from.marketScope)} → ${scopeLabel(to.marketScope)}`);
  else if (from.buyer !== to.buyer) parts.push('구매자 바뀜');
  if (from.questionBankVersion !== to.questionBankVersion) parts.push(`질문지 ${from.questionBankVersion} → ${to.questionBankVersion}`);
  return parts.join(' · ');
}

async function computePlan(ctx: Context, input: ProfileInput, store: ResultStore): Promise<ProfilePlan> {
  const { tenant, runtime } = ctx;
  const errors: string[] = [];
  const notes: string[] = [];
  if (ctx.reason) errors.push(ctx.reason);
  if (!input.industry) errors.push('업종을 적어 주세요.');
  if (input.marketScope === 'local' && !input.region) errors.push('지역형은 지역을 적어 주세요.');
  if (input.marketScope === 'local' && input.region === NATIONAL_REGION) errors.push(`지역형은 「${NATIONAL_REGION}」 대신 지역을 적어 주세요(「${NATIONAL_REGION}」은 전국형 · B2B형).`);
  if (input.region.includes('(영어 질문)')) errors.push('지역에 「(영어 질문)」을 넣을 수 없어요.');
  // 전국형 · B2B형의 지역은 「국내」 — 이미 전국형 · B2B형으로 지역이 남아 있던 브랜드만 그 지역을 그대로 둘 수 있다.
  const keepsRegion = scopeOf(tenant) !== 'local' && input.region === tenant.region;
  if (input.marketScope !== 'local' && input.region !== NATIONAL_REGION && !keepsRegion) {
    errors.push(`전국형 · B2B형은 지역이 「${NATIONAL_REGION}」예요.`);
  }

  const from: ProfileTarget = {
    brandName: tenant.brandName,
    aliases: tenant.aliases ?? [],
    industry: tenant.industry,
    region: tenant.region,
    marketScope: scopeOf(tenant),
    buyer: tenant.buyer ?? '',
    questionBankVersion: tenant.questionBankVersion,
    cohortQuestionBank: tenant.cohortQuestionBank ?? null,
  };
  // 상호 · 별칭 — 보내지 않았으면 그대로. 상호는 주소면 막고, 도메인 모양이면 알리기만 한다.
  const nameTo = input.brandName ?? from.brandName;
  const aliasesTo = input.aliases ?? from.aliases;
  const nameChanged = nameTo !== from.brandName;
  const aliasesChanged = !sameList(aliasesTo, from.aliases);
  if (!nameTo) errors.push('상호를 적어 주세요.');
  else if (isAddressLike(nameTo)) errors.push('상호에는 주소가 아니라 사람들이 부르는 이름을 적어 주세요 — 예: 도전과나눔.');
  if (aliasesTo.some(isAddressLike)) errors.push('별칭에 주소를 넣을 수 없어요 — 홈페이지는 그대로 두고 사람들이 부르는 이름만 적어 주세요.');
  // 새 상호 · 별칭이 이 브랜드의 경쟁사 줄과 같으면 판정에 같은 이름이 둘이 되고 점유율이 합쳐진다 — 경쟁사 편집이 같은 상태를 막는
  // 것과 같은 비교(공백 무시)로 막는다(1-D 검토, competitorEditor.ts 「자신이에요」).
  if (nameChanged || aliasesChanged) {
    const squash = (v: string) => v.replace(/\s+/g, '');
    const own = new Set([nameTo, ...aliasesTo].filter(Boolean).map(squash));
    const clash = tenant.competitors.find((c) => own.has(squash(c.name)) || c.aliases.some((a) => own.has(squash(a))));
    if (clash) errors.push(`「${clash.name}」${tp(clash.name)} 이 브랜드의 경쟁사 목록에 있어요 — 경쟁사 편집에서 그 줄을 먼저 빼거나 다른 이름을 적어 주세요.`);
  }
  // 업종 · 지역 · 범위가 그대로인가 — 코호트 · 함께 옮길 경쟁사 · 공통 질문지는 이것이 바뀔 때만 따진다.
  const cohortUnchanged =
    from.industry === input.industry && from.region === input.region && from.marketScope === input.marketScope && from.buyer === input.buyer;
  const unchanged = cohortUnchanged && !nameChanged && !aliasesChanged;

  const targets = targetMap(tenant, runtime);
  const competitors = await competitorsOf(ctx, targets);
  const moving: ProfileCompetitor[] = [];
  // 상호 · 별칭만 바꾸면 코호트가 그대로라 함께 옮길 경쟁사가 없다 — 보낸 목록은 쓰지 않는다(옮기면 경쟁사 질문지까지 올라간다).
  for (const id of cohortUnchanged ? [] : input.move) {
    const c = competitors.find((x) => x.tenantId === id);
    if (!c) errors.push(`함께 재는 경쟁사가 아닙니다: ${id}`);
    else if (!c.movable) errors.push(`${c.brandName}${tp(c.brandName)} 함께 옮길 수 없어요 — ${c.reason}`);
    else moving.push(c);
  }
  const movingIds = new Set(moving.map((m) => m.tenantId));
  const next = { ...tenant, industry: input.industry, region: input.region, marketScope: input.marketScope, buyer: input.buyer || undefined };

  const requests = await readMeasureRequests();
  const ids = [tenant.tenantId, ...moving.map((m) => m.tenantId)];
  const queued = requests.filter((r) => ids.includes(r.tenant.tenantId)).map((r) => r.tenant.brandName);
  if (!unchanged && queued.length > 0) {
    // 대기열은 넣을 때의 설정으로 잰다(index.ts /api/measure-requests/process) — 옛 업종 · 옛 질문지로 이번 주 카드를 덮어쓴다.
    errors.push(`측정 대기열에 ${queued.join(', ')}${sp(queued.at(-1)!)} 있어요. 그 측정이 끝난 뒤에 바꿔 주세요.`);
  }

  // 같은 홈페이지의 다른 고객 브랜드와 같은 코호트가 되면 같은 질문지 · 순위표를 나눠 쓴다(registerTenant와 같은 규칙).
  const twin = cohortUnchanged ? null : runtime.find((t) => !t.cohortOnly && t.tenantId !== tenant.tenantId && sharesSite(t, tenant) && sameCohort(t, next));
  if (twin) errors.push(`같은 홈페이지의 ${twin.brandName}(${twin.tenantId})${sp(twin.brandName)} 이미 ${twin.industry} · ${twin.region}에 있어요.`);

  // 새 코호트의 구성원 — 함께 옮기는 경쟁사와 자기 자신은 뺀다. 경쟁사 측정 브랜드는 어느 고객이든 잴 때만 센다(아무도 재지 않는 곳은
  // 화면에 보이지도 않고 옮길 수도 없어, 그것 때문에 막히거나 그 질문지를 따르면 안 된다).
  // 바꾼 뒤에야 이 고객이 다시 재게 되는 곳(업종이 달라 겹치던 경쟁사 측정 브랜드 등)도 센다 — 빠뜨리면 한 순위표에서 공통 질문지가 갈린다.
  const willMeasure = new Set<string>();
  if (input.industry && input.region) {
    const nextRuntime = runtime.map((t) =>
      t.tenantId === tenant.tenantId ? next : movingIds.has(t.tenantId) ? { ...t, industry: input.industry, region: input.region, marketScope: input.marketScope } : t,
    );
    for (const t of lineTargets(next, nextRuntime)) willMeasure.add(t.tenantId);
  }
  const members = runtime.filter(
    (t) =>
      t.tenantId !== tenant.tenantId &&
      !movingIds.has(t.tenantId) &&
      sameCohort(t, next) &&
      (!t.cohortOnly || targets.active.has(t.tenantId) || willMeasure.has(t.tenantId)),
  );
  const otherScope = members.filter((m) => scopeOf(m) !== input.marketScope);
  if (!cohortUnchanged && from.cohortQuestionBank && otherScope.length > 0) {
    // 공통 질문지 키는 업종__지역뿐이라(cohortQuestionBank.ts cohortKey) 범위가 다른 브랜드와 같은 공통 질문을 쓰게 된다.
    const names = otherScope.slice(0, 3).map((m) => `${m.brandName}(${scopeLabel(m.marketScope)})`);
    errors.push(
      `${input.industry} · ${input.region} 코호트에 범위가 다른 브랜드가 있어요(${names.join(', ')}${otherScope.length > 3 ? ` 외 ${otherScope.length - 3}곳` : ''}) — ` +
        `${scopeLabel(input.marketScope)}으로는 같은 공통 질문지를 쓸 수 없으니 업종을 다르게 적어 주세요.`,
    );
  }

  // 코호트 공통 질문지 — 구성원이 있으면 그 버전을 따른다. 혼자면 지금 버전을 쓰되, 그 키에 같은 버전 파일이 이미 있거나(다른 브랜드가
  // 만든 것) 키가 그대로인데 범위 · 구매자만 바뀌었으면 다음 번호로 올린다(공통 질문은 범위 · 구매자로 만든다).
  let cohortTo: string | null = from.cohortQuestionBank;
  if (from.cohortQuestionBank && !cohortUnchanged) {
    const memberVersion = mostCommon(members.map((m) => m.cohortQuestionBank).filter((v): v is string => Boolean(v)));
    if (memberVersion) cohortTo = memberVersion;
    else {
      const key = cohortKey(input.industry, input.region);
      const taken = await cohortBankVersions(key);
      const keyChanged = key !== cohortKey(from.industry, from.region);
      if (!keyChanged || taken.has(from.cohortQuestionBank)) cohortTo = nextAfterMax(from.cohortQuestionBank, taken);
    }
  }

  const used = await usedBankVersions(ids, ctx, store, requests);
  // 질문지는 코호트가 바뀌거나 상호가 바뀔 때 올린다(이름을 넣은 질문이 새 이름이어야 한다). 별칭만 바뀌면 질문은 그대로다.
  const bankTo = cohortUnchanged && !nameChanged ? from.questionBankVersion : nextAfterMax(from.questionBankVersion, used);
  const to: ProfileTarget = {
    brandName: nameTo,
    aliases: aliasesTo,
    industry: input.industry,
    region: input.region,
    marketScope: input.marketScope,
    buyer: input.buyer,
    questionBankVersion: bankTo,
    cohortQuestionBank: cohortTo,
  };

  if (nameChanged && nameTo && !isAddressLike(nameTo)) {
    notes.push(`상호를 「${nameTo}」${dp(nameTo)} 바꿉니다 — 다음 측정부터 AI 답변에서 이 이름(과 별칭)이 나오면 언급으로 셉니다. 지난 기록의 이름은 그대로입니다.`);
    if (isDomainLike(nameTo)) notes.push(`「${nameTo}」${sp(nameTo)} 도메인 모양이에요 — 사람들이 부르는 상호가 따로 있으면 그 이름을 적어 주세요.`);
    const same = runtime.find((t) => !t.cohortOnly && t.tenantId !== tenant.tenantId && t.brandName === nameTo);
    if (same) notes.push(`같은 이름의 브랜드가 이미 있어요(${same.industry} · ${same.region}) — 화면에서 헷갈리지 않게 확인해 주세요.`);
    // 이 브랜드를 경쟁사로 재는 다른 고객은 그 줄의 이름(옛 이름)을 순위 후보로 쓴다 — 고치지 않으면 같은 브랜드가 두 이름으로 보인다(1-D 검토).
    const oldNameUsers = runtime.filter(
      (o) => !o.cohortOnly && o.tenantId !== tenant.tenantId && lineTargets(o, runtime).some((t) => t.tenantId === tenant.tenantId && t.name !== nameTo),
    );
    if (oldNameUsers.length > 0) {
      notes.push(
        `${oldNameUsers.map((o) => o.brandName).join(', ')}${tp(oldNameUsers.at(-1)!.brandName)} 이 브랜드를 경쟁사 목록에 옛 이름으로 적어 두었어요 — 그쪽 경쟁사 편집에서 이름을 맞춰 주세요.`,
      );
    }
  }
  if (aliasesChanged && !nameChanged) {
    notes.push('별칭을 바꾸면 다음 측정부터 언급 판정이 달라집니다 — 언급률이 직전 측정과 다르게 셀 수 있어요.');
  }

  const week = getIsoWeekString(new Date());
  const thisWeek: string[] = [];
  if (bankTo !== from.questionBankVersion) {
    notes.push(`질문지를 ${bankTo}로 새로 만듭니다(다음 측정). 바뀐 주는 직전 측정과 점수 증감을 비교하지 않습니다.`);
  }
  if (!cohortUnchanged) {
    for (const t of [tenant, ...moving.map((m) => runtime.find((x) => x.tenantId === m.tenantId)!)]) {
      const last = (await store.getScorecardHistory(t.tenantId, 1)).at(-1);
      if (last?.weekOf === week) thisWeek.push(t.brandName);
    }
    if (cohortTo && members.length > 0) {
      const names = members.slice(0, 3).map((m) => m.brandName).join(', ');
      notes.push(`같은 코호트 ${members.length}곳과 공통 질문지(${cohortTo})를 함께 씁니다 — ${names}${members.length > 3 ? ` 외 ${members.length - 3}곳` : ''}.`);
    } else if (cohortTo && cohortTo !== from.cohortQuestionBank) {
      notes.push(`이 코호트의 공통 질문지를 새로 만듭니다(${cohortTo}).`);
    }
    if (thisWeek.length > 0) {
      notes.push(`이번 주에 이미 잰 ${thisWeek.join(', ')}의 카드는 다음 측정이 새 코호트로 바꿉니다(옛 코호트 순위도 다시 매깁니다).`);
    }
    // 옮기지 않은 경쟁사 — 업종이 다르면 「측정 안 됨」, 지역이 다르면 옛 지역으로 재 새 순위표에 들지 않는다.
    // 업종 · 지역이 비면 측정 계획을 세울 수 없다(초안 정규화가 던진다) — 그 오류는 위에서 이미 알렸다.
    if (input.industry && input.region) {
      const moved = (t: TenantConfig) => ({ ...t, industry: to.industry, region: to.region, marketScope: to.marketScope });
      const after = runtime.map((t) => (movingIds.has(t.tenantId) || t.tenantId === tenant.tenantId ? moved(t) : t));
      const offered = new Set(competitors.map((c) => c.tenantId));
      for (const e of planCohortTargets(next, after).entries) {
        if (e.status === 'collision') {
          const why = e.collidesWith && offered.has(e.collidesWith.tenantId) ? '옮기지 않은 경쟁사' : `${e.collidesWith?.brandName ?? '다른 브랜드'}와 id가 겹침`;
          notes.push(`${e.name}: 업종이 다른 브랜드로 잡혀 측정하지 않습니다(${why}).`);
        } else if (e.status === 'measured' && e.otherRegion) notes.push(`${e.name}: 다른 지역(${e.existing?.region ?? ''})으로 재 새 순위표에 들지 않습니다.`);
      }
      // 이 브랜드를 경쟁사로 재는 다른 고객 — 업종이 바뀌면 그쪽은 이 브랜드를 재지 않고(칸은 차지), 지역이 바뀌면 그쪽 순위표에서 빠진다.
      for (const other of runtime) {
        if (other.cohortOnly || other.tenantId === tenant.tenantId || other.autoCohort === false) continue;
        if (!lineTargets(other, runtime).some((t) => t.tenantId === tenant.tenantId)) continue;
        for (const e of planCohortTargets(other, after).entries) {
          if (e.status === 'collision' && e.collidesWith?.tenantId === tenant.tenantId) {
            notes.push(`${other.brandName}${tp(other.brandName)} 이 브랜드를 경쟁사로 재는데, 업종이 달라져 그쪽에서는 측정하지 않습니다(함께 측정 칸은 차지).`);
          } else if (e.status === 'measured' && e.targetTenantId === tenant.tenantId && e.otherRegion && tenant.region === other.region) {
            // 원래부터 다른 지역으로 재던 고객(그쪽 순위표에 원래 없음)에게는 알리지 않는다.
            notes.push(`${other.brandName}${tp(other.brandName)} 이 브랜드를 경쟁사로 재는데, 지역이 달라져 그쪽 순위표에 들지 않습니다.`);
          }
        }
      }
    }
  }

  const key = createHash('sha1')
    .update(JSON.stringify({ entry: ctx.entry, moving: moving.map((m) => ctx.overlay.find((t) => t.tenantId === m.tenantId) ?? null), input, to }))
    .digest('hex')
    .slice(0, 16);
  return {
    key,
    unchanged,
    errors,
    notes,
    measuring: measureInFlight(),
    to,
    bank: { from: from.questionBankVersion, to: bankTo },
    cohortBank: { from: from.cohortQuestionBank, to: cohortTo, members: members.map((m) => m.brandName) },
    moving: moving.map((m) => ({ tenantId: m.tenantId, brandName: m.brandName })),
    thisWeek,
    summary: unchanged ? '바뀐 내용 없음' : describeChange(from, to),
  };
}

export async function planProfileEdit(tenantId: string, raw: unknown, store: ResultStore): Promise<ProfilePlan> {
  const ctx = await loadContext(tenantId);
  return computePlan(ctx, normalizeProfileInput(raw), store);
}

/**
 * 오버레이 항목에 새 기본 정보를 넣는다 — 나머지(경쟁사 · GA4 …)는 그대로. 정규화(normalizeTenantDraft)를 거치지 않는다. 상호 · 별칭은
 * 고객 항목에만(identity) — 함께 옮기는 경쟁사 측정 브랜드는 코호트만 옮긴다.
 */
function applyTarget(entry: TenantConfig, to: ProfileTarget, identity: boolean): TenantConfig {
  const next: TenantConfig = { ...entry, industry: to.industry, region: to.region, questionBankVersion: to.questionBankVersion };
  if (identity) {
    next.brandName = to.brandName;
    next.aliases = to.aliases;
  }
  if (to.cohortQuestionBank) next.cohortQuestionBank = to.cohortQuestionBank;
  if (to.marketScope === 'local') delete next.marketScope;
  else next.marketScope = to.marketScope;
  if (to.marketScope === 'b2b' && to.buyer) next.buyer = to.buyer;
  else delete next.buyer;
  return next;
}

/**
 * 앱에서 고친 경쟁사 목록이 계속 쓰이게 지문을 새 오버레이 항목으로 다시 적는다. 그 파일의 질문지 값은 버린다 — 남기면 병합 때
 * 새 질문지 버전을 옛 버전으로 덮는다(tenantRegistry.ts mergeRuntimeTenants). 이미 맞지 않던(stale) 목록은 되살리지 않는다.
 * measured는 그대로 둔다 — 바꾸면 「경쟁사 바뀜 · 다음 측정 대기」가 거짓으로 뜬다(competitorEditor.ts bankChosenByEdit).
 */
function rebaseCompetitorOverride(tenantId: string, prev: TenantConfig, next: TenantConfig): Promise<void> {
  const oldFp = baseFingerprint(prev);
  const newFp = baseFingerprint(next);
  // 지문이 그대로면(별칭만 바꿈 — 지문에는 이름 · 별칭이 없다) 다시 적지 않는다. 다시 적으면 경쟁사 편집이 만든 질문지 값
  // (questionBank · 다시 만들기 대기)을 버려 그 질문지로 재던 측정이 멈춘다(1-D 검토).
  if (oldFp === newFp) return Promise.resolve();
  const rebase = (o: CompetitorOverride | null): CompetitorOverride | null => (o && o.base === oldFp ? { competitors: o.competitors, base: newFp } : o);
  return serializeCompetitorFile(async () => {
    const file = await readCompetitorOverride(tenantId);
    if (!file) return;
    await writeCompetitorOverride(tenantId, {
      current: rebase(file.current),
      lastSave: file.lastSave ? { ...file.lastSave, before: rebase(file.lastSave.before) } : null,
      measured: file.measured,
    });
  });
}

/** 바꾸기 전 설정을 data/<id>/<backup>/에 남긴다 — 오버레이 항목, 경쟁사 목록, 시장 범위. 남긴 파일 이름을 돌려준다. */
async function backupTenant(tenantId: string, entry: TenantConfig, backup: string): Promise<string[]> {
  const dir = path.join(tenantDir(tenantId), backup);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'overlay-entry.json'), JSON.stringify(entry, null, 2), 'utf-8');
  const copied: string[] = [];
  for (const file of ['competitors.json', 'market-scope.json']) {
    try {
      await copyFile(path.join(tenantDir(tenantId), file), path.join(dir, file));
      copied.push(file);
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
  }
  return copied;
}

/**
 * 기본 정보를 저장한다.
 * 1. 다시 계획한다 — 미리보기와 열쇠가 다르거나 오류가 있으면 409. 측정 중이면 409.
 * 2. 고객과 함께 옮길 경쟁사의 옛 설정을 before-profile-<시각>/에 남긴다.
 * 3. 오버레이 항목을 한 번에 바꾸고, 시장 범위 파일이 있으면 같은 값으로, 경쟁사 목록 지문을 다시 적고, 표식을 남긴다.
 *    중간에 실패하면 오버레이 항목과 파일을 되돌린다.
 */
export async function saveProfileEdit(tenantId: string, raw: unknown, previewKey: unknown, store: ResultStore): Promise<ProfileSaveResult> {
  if (measureInFlight()) throw new EditorError(409, '측정이 진행 중이에요. 끝난 뒤에 저장해 주세요.');
  const ctx = await loadContext(tenantId);
  if (ctx.reason || !ctx.entry) throw new EditorError(409, ctx.reason ?? '앱에서 등록한 브랜드가 아니라 바꿀 수 없어요.');
  const plan = await computePlan(ctx, normalizeProfileInput(raw), store);
  if (plan.unchanged) throw new EditorError(400, '바뀐 내용이 없어요.');
  if (plan.errors.length > 0) throw new EditorError(409, plan.errors[0]!);
  if (plan.key !== previewKey) throw new EditorError(409, '미리보기 뒤에 설정이 바뀌었어요. 바뀐 내용을 다시 확인해 주세요.');
  if (measureInFlight()) throw new EditorError(409, '측정이 진행 중이에요. 끝난 뒤에 저장해 주세요.');

  const backup = `before-profile-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const prevEntries = [ctx.entry, ...plan.moving.map((m) => ctx.overlay.find((t) => t.tenantId === m.tenantId)!)];
  const copied = new Map<string, string[]>();
  for (const entry of prevEntries) copied.set(entry.tenantId, await backupTenant(entry.tenantId, entry, backup));
  /*
   * 별칭만 바뀐 저장(질문지 · 코호트 그대로)은 오버레이 항목의 별칭만 바꾼다. 계획의 질문지 값은 런타임(경쟁사 편집이 만든 질문지일 수
   * 있다)에서 와서 오버레이에 적으면 지문이 바뀌고, 경쟁사 편집 질문지로 재던 측정이 멈춘다(1-D 검토 — 「질문 은행 v5은 앱에서 경쟁사를
   * 바꾸며 만든 질문지인데 저장소 설정이 그 뒤에 바뀌었습니다」).
   */
  const aliasOnly = plan.bank.to === plan.bank.from && plan.moving.length === 0 && plan.to.brandName === ctx.tenant.brandName &&
    plan.to.industry === ctx.tenant.industry && plan.to.region === ctx.tenant.region && plan.to.marketScope === scopeOf(ctx.tenant) && plan.to.buyer === (ctx.tenant.buyer ?? '');
  const nextEntries = aliasOnly
    ? [{ ...ctx.entry, aliases: plan.to.aliases }]
    : prevEntries.map((e, i) => applyTarget(e, plan.to, i === 0));

  await replaceOverlayTenants(nextEntries);
  try {
    for (const entry of aliasOnly ? [] : nextEntries) {
      if (await readTenantScope(entry.tenantId)) {
        await writeTenantScope(entry.tenantId, plan.to.marketScope === 'b2b' && plan.to.buyer ? { marketScope: 'b2b', buyer: plan.to.buyer } : { marketScope: plan.to.marketScope });
      }
    }
    await rebaseCompetitorOverride(tenantId, ctx.entry, nextEntries[0]!);
    const from: ProfileTarget = {
      brandName: ctx.tenant.brandName,
      aliases: ctx.tenant.aliases ?? [],
      industry: ctx.tenant.industry,
      region: ctx.tenant.region,
      marketScope: scopeOf(ctx.tenant),
      buyer: ctx.tenant.buyer ?? '',
      questionBankVersion: ctx.tenant.questionBankVersion,
      cohortQuestionBank: ctx.tenant.cohortQuestionBank ?? null,
    };
    // 별칭만 바꾼 저장은 「다음 측정 대기」 표식을 남기지 않는다 — 질문지가 그대로라 곧바로 끝난 것으로 보이고, 앞선 대기 표식(업종 ·
    // 질문지 변경)을 덮어써 그 요약이 사라졌다(1-D 검토).
    if (!aliasOnly) {
      const marker: ProfileMarker = { savedAt: new Date().toISOString(), summary: plan.summary, from, to: plan.to };
      await writeFile(markerPath(tenantId), JSON.stringify(marker, null, 2), 'utf-8');
    }
  } catch (err) {
    console.error(`[brandProfileEditor] ${tenantId} 저장 실패 — 되돌립니다:`, err);
    try {
      await replaceOverlayTenants(prevEntries);
      for (const [id, files] of copied) {
        for (const file of files) await copyFile(path.join(tenantDir(id), backup, file), path.join(tenantDir(id), file));
      }
    } catch (undoErr) {
      console.error(`[brandProfileEditor] ${tenantId} 되돌리기도 실패했습니다 — 백업(${backup})에서 직접 되돌려 주세요:`, undoErr);
    }
    throw err;
  }
  return {
    ok: true,
    tenantId,
    summary: plan.summary,
    questionBankVersion: plan.to.questionBankVersion,
    moved: plan.moving.map((m) => m.brandName),
    backupDir: backup,
  };
}

/** 앞 버전이 뒤 버전보다 이른가 — 같은 접두면 번호로, 아니면 다르면 이르다고 본다. */
function olderVersion(a: string | undefined, b: string): boolean {
  if (!a) return true;
  const ma = /^(.*?)(\d+)$/.exec(a);
  const mb = /^(.*?)(\d+)$/.exec(b);
  if (ma && mb && ma[1] === mb[1]) return Number(ma[2]) < Number(mb[2]);
  return a !== b;
}

/**
 * 기본 정보를 바꾼 뒤 아직 새 설정으로 재지 않았는가 — 브랜드 현황의 「기본 정보 바뀜 · 다음 측정 대기」.
 * 마지막 카드가 새 업종 · 지역이고 질문지가 저장한 버전 이상이면 끝났다(그 뒤 경쟁사 편집으로 버전이 더 올라가도 끝난 것이다).
 */
export async function pendingProfileEdit(
  tenant: Pick<TenantConfig, 'tenantId' | 'industry' | 'region' | 'questionBankVersion'>,
  last: WeeklyScorecard | undefined,
): Promise<{ savedAt: string; summary: string } | null> {
  const { tenantId } = tenant;
  let marker: ProfileMarker;
  try {
    marker = JSON.parse(await readFile(markerPath(tenantId), 'utf-8')) as ProfileMarker;
  } catch (err) {
    if (!isMissing(err)) console.error(`[brandProfileEditor] ${tenantId} profile-edit.json을 읽지 못했습니다:`, err);
    return null;
  }
  if (!marker?.to?.questionBankVersion) return null;
  // 지금 설정이 표식의 새 설정과 다르면 그 뒤 브랜드를 지우고 다시 등록했거나(같은 id) 다시 바꾼 것이다 — 남은 표식은 쓰지 않는다.
  // 질문지가 표식보다 이르면 같은 업종 · 지역으로 다시 등록한 것이다(바꾼 브랜드의 질문지는 표식 버전에서 올라가기만 한다).
  if (tenant.industry !== marker.to.industry || tenant.region !== marker.to.region || olderVersion(tenant.questionBankVersion, marker.to.questionBankVersion)) {
    return null;
  }
  if (last && last.industry === marker.to.industry && last.region === marker.to.region && !olderVersion(last.questionBankVersion, marker.to.questionBankVersion)) {
    return null;
  }
  return { savedAt: marker.savedAt, summary: marker.summary };
}
