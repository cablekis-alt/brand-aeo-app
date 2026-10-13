import { competitorDraftId, planCohortTargets, type CompetitorPlanStatus } from './cohortPlan.js';
import { discoverBrands } from './competitorDiscovery.js';
import { linkCompetitorQuestions } from './competitorQuestions.js';
import { measureInFlight } from './measureTracker.js';
import { loadRuntimeTenants, loadTenantWithoutCompetitorEdit } from './tenantRegistry.js';
import { readDeletedTenants } from './tenantTombstone.js';
import {
  baseFingerprint,
  listHash,
  normalizeCompetitorList,
  overrideApplies,
  readCompetitorOverride,
  serializeCompetitorFile,
  writeCompetitorOverride,
  type CompetitorOverride,
  type CompetitorOverrideFile,
} from './tenantCompetitorsStore.js';
import { getIsoWeekString } from '../src/prompts/isoWeek.js';
import { objectParticle } from '../src/lib/korean.js';
import type { WeeklyScorecard } from '../src/prompts/b8-report.js';
import type { CompetitorContext } from '../src/prompts/types.js';
import type { QuestionBank, ResultStore } from './store.js';
import type { TenantConfig } from './types.js';

/**
 * 경쟁사 편집 서랍(상용화 UI 11차)의 서버 쪽 — 처음 상태, 바꾼 목록 미리 계산, 저장, 되돌리기.
 *
 * 「함께 측정 5/5 · 대기」와 줄 순서는 측정이 쓰는 planCohortTargets 그대로다. 화면이 경쟁사 순서로 세면 칸 안의
 * 충돌·중복 때문에 실제 측정과 어긋난다(cohortPlan.ts 순서 주석). 저장은 data/<tenant>/competitors.json에
 * 하고(tenantCompetitorsStore.ts), 측정 기록은 지우지 않는다 — 뺀 경쟁사의 지난 카드는 지난 순위표에 남는다.
 */

export interface EditorCompetitorRow {
  /** 목록에서의 위치. 측정 순서다. */
  index: number;
  name: string;
  aliases: string[];
  domains: string[];
  draftId: string | null;
  status: CompetitorPlanStatus;
  takesSlot: boolean;
  /** 실제로 재는 브랜드 id(기존 브랜드로 재면 그 id). 재지 않으면 null. */
  targetTenantId: string | null;
  /** 다른 지역 브랜드로 잰다 — 그 카드는 이 코호트 순위표에 안 들어온다. */
  otherRegion: boolean;
  /** 다른 고객 브랜드를 경쟁사로 잰다(그 고객의 설정으로). */
  existingCustomer: boolean;
  collidesWith: { tenantId: string; brandName: string; industry: string; region: string } | null;
  /** 지운 브랜드(툼스톤)와 id가 같다. */
  deleted: boolean;
  /** 지운 브랜드가 다른 업종이었다 — 재면 그 브랜드의 기록에 섞이므로 넣을 수 없다. */
  deletedOtherIndustry: { brandName: string; industry: string } | null;
  /** 이 코호트(업종·지역)에 쌓인 주차 수 — 다시 넣으면 이 기록을 잇는다. */
  cohortWeeks: number;
  /** 이 코호트에서의 마지막 카드. 한 번도 안 쟀으면 null. */
  latest: { weekOf: string; score: number; mentionRate: number; brandOwnedCitationRate: number } | null;
  /** 이 경쟁사를 짚은 브랜드 질문 id(다음 측정에 쓸 질문지 기준). */
  questionIds: string[];
}

export interface EditorPastCompetitor {
  tenantId: string;
  brandName: string;
  aliases: string[];
  domains: string[];
  /** 이 고객의 코호트에 카드가 있는 주차 수와 마지막 주차. */
  weeks: number;
  lastWeekOf: string;
  lastScore: number;
}

export interface EditorSuggestion {
  name: string;
  aliases: string[];
  domains: string[];
  /** past: 예전 경쟁사 · cohort: 같은 코호트에 등록된 브랜드 · answers: 지난 측정 답변에 나온 이름. */
  source: 'past' | 'cohort' | 'answers';
  note: string;
  /** 예전 경쟁사를 다시 넣으면 같은 id로 지난 기록을 잇는가(source past). */
  continues?: boolean;
}

export interface CompetitorEditorState {
  tenantId: string;
  brandName: string;
  industry: string;
  region: string;
  cap: number;
  measuredCount: number;
  waitingCount: number;
  /** 칸은 쓰는데 측정되지 않는 줄(이름 겹침·같은 대상). */
  blockedCount: number;
  /** 고객의 마지막 측정. 측정 전이면 null. */
  baseline: { weekOf: string; score: number; rank: number; totalTenants: number; tied: boolean } | null;
  /** 지금 쓰는 경쟁사 목록(측정 순서). 화면은 이 목록에 바꾼 내용을 얹는다. */
  competitors: CompetitorContext[];
  rows: EditorCompetitorRow[];
  /** 이 고객의 지난 코호트에 끼어 있었지만 지금 목록에는 없는 경쟁사(예전 경쟁사). */
  past: EditorPastCompetitor[];
  suggestions: EditorSuggestion[];
  questionBank: {
    /** 다음 측정에 쓸 버전(설정값). */
    version: string;
    /** 그 버전 파일이 이미 있는가. 없으면 다음 측정 때 새로 만든다. */
    exists: boolean;
    /** 마지막 측정에 쓴 버전. */
    measuredVersion: string | null;
    sharedCount: number;
    brandCount: number;
  };
  /** 앱에서 고친 목록(competitors.json)의 상태. */
  edit: {
    /** 앱에서 고친 목록을 쓰는 중. */
    active: boolean;
    /** 고친 목록이 있지만 저장소 설정이 그 뒤에 바뀌어 쓰지 않는 중. */
    stale: boolean;
    savedAt: string | null;
    summary: string | null;
    /** 마지막 저장을 되돌릴 수 있다(그 뒤 이 브랜드를 측정하지 않았다). */
    undoAvailable: boolean;
    /** 저장소 설정의 경쟁사 목록 — 「저장소 설정으로 돌아가기」의 대상. */
    repoCompetitors: CompetitorContext[];
  };
  /** 진행 중인 로컬 측정이 있다 — 저장·되돌리기를 막는다. */
  measuring: boolean;
}

export interface EditPlan {
  cap: number;
  measuredCount: number;
  waitingCount: number;
  blockedCount: number;
  rows: EditorCompetitorRow[];
  /** 정리한 목록(주소 → 도메인, 공용 주소 뺌) — 저장하면 이대로 저장된다. */
  competitors: CompetitorContext[];
  /** 공용 주소라 홈페이지로 쓰지 않은 주소. */
  droppedHosts: string[];
  /** 지금은 함께 재는데 바꾼 목록에서는 재지 않는 경쟁사. */
  leaving: { name: string; tenantId: string | null; questionIds: string[]; thisWeek: boolean }[];
  /** 알릴 것(저장은 된다). */
  notes: string[];
  /** 저장을 막는 문제. */
  errors: string[];
  /** 지금 목록과 같다(바뀐 것이 없다). */
  unchanged: boolean;
  /** 진행 중인 로컬 측정이 있다 — 저장이 막힌다(서랍을 연 뒤 측정이 끝났는지 여기서 다시 본다). */
  measuring: boolean;
}

/** 서랍 API의 실패 — 라우트가 status로 응답한다. */
export class EditorError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'EditorError';
    this.status = status;
  }
}

const shortWeek = (weekOf: string) => weekOf.replace(/^\d{4}-/, '');
const squash = (s: string) => s.replace(/\s+/g, '');
const sameList = (a: CompetitorContext[], b: CompetitorContext[]) =>
  JSON.stringify(a.map((c) => [c.name, c.aliases, c.domains])) === JSON.stringify(b.map((c) => [c.name, c.aliases, c.domains]));

interface Context {
  tenant: TenantConfig;
  runtime: TenantConfig[];
  store: ResultStore;
  history: WeeklyScorecard[];
  last: WeeklyScorecard | null;
  industry: string;
  region: string;
  customers: Set<string>;
  deletedIds: Set<string>;
  bank: QuestionBank | null;
}

async function loadContext(tenant: TenantConfig, runtime: TenantConfig[], store: ResultStore): Promise<Context> {
  const [history, deleted, bank] = await Promise.all([
    store.getScorecardHistory(tenant.tenantId, Number.MAX_SAFE_INTEGER),
    readDeletedTenants(),
    store.getQuestionBank(tenant.tenantId, tenant.questionBankVersion),
  ]);
  const last = history.at(-1) ?? null;
  return {
    tenant,
    runtime,
    store,
    history,
    last,
    // 코호트는 점수 기록의 업종·지역이다(영어 질문 측정은 지역에 꼬리표가 붙는다). 측정 전이면 설정값.
    industry: last?.industry ?? tenant.industry,
    region: last?.region ?? tenant.region,
    customers: new Set(runtime.filter((t) => !t.cohortOnly).map((t) => t.tenantId)),
    deletedIds: new Set(deleted),
    bank,
  };
}

/** 경쟁사 목록 하나를 서랍 줄로 — 측정 계획, 최근 카드, 이어진 비교 질문. */
async function describeRows(ctx: Context, competitors: CompetitorContext[]) {
  const candidate: TenantConfig = { ...ctx.tenant, competitors };
  const plan = planCohortTargets(candidate, ctx.runtime);
  const links = ctx.bank
    ? linkCompetitorQuestions(ctx.bank.questions, competitors, [ctx.tenant.brandName, ...ctx.tenant.aliases])
    : null;
  const rows = await Promise.all(
    plan.entries.map(async (entry): Promise<EditorCompetitorRow> => {
      const competitor = competitors[entry.index];
      const id = entry.targetTenantId ?? entry.draftId;
      const history = id ? await ctx.store.getScorecardHistory(id, Number.MAX_SAFE_INTEGER) : [];
      const inCohort = history.filter((c) => c.industry === ctx.industry && c.region === ctx.region);
      const deleted = Boolean(id && ctx.deletedIds.has(id));
      const otherIndustry = deleted ? history.find((c) => c.industry !== ctx.industry) : undefined;
      const card = inCohort.at(-1);
      return {
        index: entry.index,
        name: entry.name,
        aliases: competitor?.aliases ?? [],
        domains: competitor?.domains ?? [],
        draftId: entry.draftId,
        status: entry.status,
        takesSlot: entry.takesSlot,
        targetTenantId: entry.targetTenantId ?? null,
        otherRegion: entry.otherRegion === true,
        existingCustomer: Boolean(entry.existing && !entry.existing.cohortOnly && ctx.customers.has(entry.existing.tenantId)),
        collidesWith: entry.collidesWith ?? null,
        deleted,
        deletedOtherIndustry: otherIndustry ? { brandName: otherIndustry.brandName, industry: otherIndustry.industry } : null,
        cohortWeeks: inCohort.length,
        latest: card
          ? { weekOf: card.weekOf, score: card.aeoScore.current, mentionRate: card.mentionRate, brandOwnedCitationRate: card.brandOwnedCitationRate }
          : null,
        questionIds: links?.byCompetitor[entry.index] ?? [],
      };
    }),
  );
  return {
    cap: plan.cap,
    rows,
    measuredCount: rows.filter((r) => r.status === 'measured').length,
    waitingCount: rows.filter((r) => r.status === 'waiting').length,
    blockedCount: rows.filter((r) => r.takesSlot && r.status !== 'measured').length,
  };
}

const PAST_WEEKS = 12;

/** 이 고객의 지난 코호트에 끼어 있었지만 지금은 아무 고객도 재지 않는 경쟁사. */
async function pastCompetitors(ctx: Context, rows: EditorCompetitorRow[]): Promise<EditorPastCompetitor[]> {
  // 같은 코호트의 다른 고객이 지금 재는 경쟁사도 뺀다 — 이 고객이 뺀 곳이 아니다.
  const currentIds = new Set(rows.flatMap((r) => [r.targetTenantId, r.draftId]).filter((x): x is string => Boolean(x)));
  for (const other of ctx.runtime) {
    if (other.cohortOnly || other.tenantId === ctx.tenant.tenantId || other.industry !== ctx.tenant.industry || other.region !== ctx.tenant.region) continue;
    for (const e of planCohortTargets(other, ctx.runtime).entries) {
      if (e.targetTenantId) currentIds.add(e.targetTenantId);
      if (e.draftId) currentIds.add(e.draftId);
    }
  }
  const byId = new Map(ctx.runtime.map((t) => [t.tenantId, t]));
  const pastMap = new Map<string, EditorPastCompetitor>();
  // 최근 12주만 본다 — 주마다 모든 브랜드 폴더를 읽으므로(getCohortScorecards) 오래된 기록까지 훑으면 서랍이 느려진다.
  const recent = ctx.history.slice(-PAST_WEEKS);
  const cohorts = await Promise.all(recent.map((card) => ctx.store.getCohortScorecards(card.industry, card.region, card.weekOf)));
  for (const members of cohorts) {
    for (const m of members) {
      if (m.tenantId === ctx.tenant.tenantId || ctx.customers.has(m.tenantId) || currentIds.has(m.tenantId)) continue;
      const prev = pastMap.get(m.tenantId);
      const newer = !prev || m.weekOf >= prev.lastWeekOf;
      const t = byId.get(m.tenantId);
      pastMap.set(m.tenantId, {
        tenantId: m.tenantId,
        brandName: newer ? m.brandName : prev.brandName,
        aliases: t?.aliases ?? [m.brandName],
        domains: t?.ownedDomains ?? [],
        weeks: (prev?.weeks ?? 0) + 1,
        lastWeekOf: newer ? m.weekOf : prev.lastWeekOf,
        lastScore: newer ? m.aeoScore.current : prev.lastScore,
      });
    }
  }
  return [...pastMap.values()].sort((a, b) => b.lastWeekOf.localeCompare(a.lastWeekOf) || a.brandName.localeCompare(b.brandName, 'ko'));
}

/** 「+ 경쟁사 추가」 후보 — 예전 경쟁사, 같은 코호트에 등록된 브랜드, 마지막 측정 답변에 나온 이름. AI는 부르지 않는다. */
async function suggestionsFor(ctx: Context, rows: EditorCompetitorRow[], past: EditorPastCompetitor[]): Promise<EditorSuggestion[]> {
  const taken = new Set(rows.flatMap((r) => [r.targetTenantId, r.draftId, r.name.replace(/\s+/g, '')]).filter((x): x is string => Boolean(x)));
  const out: EditorSuggestion[] = [];
  const add = (s: EditorSuggestion) => {
    const key = s.name.replace(/\s+/g, '');
    if (taken.has(key)) return;
    taken.add(key);
    out.push(s);
  };
  for (const p of past) {
    // 다시 넣었을 때 같은 id가 나와야 기록이 이어진다. 홈페이지로 만든 id(도메인 첫 마디)인데 그 주소를 모르면
    // 이름으로 새로 잰다 — 그때는 이어진다고 말하지 않는다.
    const continues = competitorDraftId(ctx.tenant, { name: p.brandName, aliases: p.aliases, domains: p.domains }) === p.tenantId;
    add({
      name: p.brandName,
      aliases: p.aliases,
      domains: p.domains,
      source: 'past',
      continues,
      note: `지난 기록 ${p.weeks}주 · 마지막 ${shortWeek(p.lastWeekOf)} ${p.lastScore}점 · ${continues ? '다시 넣으면 기록을 이어요' : '다시 넣으면 새로 재요(지난 기록과 이어지지 않음)'}`,
    });
  }
  for (const t of ctx.runtime) {
    if (!t.cohortOnly || t.industry !== ctx.industry || t.region !== ctx.region || taken.has(t.tenantId)) continue;
    add({ name: t.brandName, aliases: t.aliases, domains: t.ownedDomains, source: 'cohort', note: `${ctx.region} · ${ctx.industry} · 등록된 브랜드` });
  }
  if (ctx.last) {
    const known = ctx.runtime.map((t) => ({ name: t.brandName, aliases: t.aliases ?? [] }));
    const found = await discoverBrands(
      ctx.tenant.tenantId,
      ctx.last.weekOf,
      { brandName: ctx.tenant.brandName, aliases: ctx.tenant.aliases ?? [], industry: ctx.tenant.industry },
      known,
    );
    for (const b of found.brands.filter((x) => !x.registered).slice(0, 5)) {
      add({ name: b.name, aliases: [b.name], domains: [], source: 'answers', note: `${shortWeek(ctx.last.weekOf)} 답변 ${b.answers}건에 나옴` });
    }
  }
  return out;
}

/**
 * 마지막 저장을 되돌릴 수 있는가 — 저장한 뒤 이 브랜드를 지금 목록으로 쟀으면 안 된다(그 측정은 새 목록으로 쟀다).
 * 저장 뒤에 시작했어도 옛 목록으로 잰 측정(저장과 측정 시작이 겹친 경우)은 막지 않는다.
 */
function canUndo(file: CompetitorOverrideFile | null, effective: TenantConfig['competitors']): boolean {
  if (!file?.lastSave) return false;
  const m = file.measured;
  return !(m && m.at && m.at > file.lastSave.savedAt && m.listHash === listHash(effective));
}

export async function buildEditorState(tenant: TenantConfig, runtime: TenantConfig[], store: ResultStore): Promise<CompetitorEditorState> {
  const ctx = await loadContext(tenant, runtime, store);
  const [described, file, repo] = await Promise.all([
    describeRows(ctx, tenant.competitors),
    readCompetitorOverride(tenant.tenantId),
    loadTenantWithoutCompetitorEdit(tenant.tenantId),
  ]);
  const past = await pastCompetitors(ctx, described.rows);
  const suggestions = await suggestionsFor(ctx, described.rows, past);
  const current = file?.current ?? null;
  const active = repo ? overrideApplies(current, repo) : false;
  const last = ctx.last;
  return {
    tenantId: tenant.tenantId,
    brandName: tenant.brandName,
    industry: ctx.industry,
    region: ctx.region,
    ...described,
    baseline: last
      ? {
          weekOf: last.weekOf,
          score: last.aeoScore.current,
          rank: last.cohortRank.position,
          totalTenants: last.cohortRank.totalTenants,
          tied: (last.cohortRank.tiedCount ?? 1) > 1,
        }
      : null,
    competitors: tenant.competitors,
    past,
    suggestions,
    questionBank: {
      version: tenant.questionBankVersion,
      exists: Boolean(ctx.bank),
      measuredVersion: last?.questionBankVersion ?? null,
      sharedCount: ctx.bank ? ctx.bank.questions.filter((q) => q.cohortShared).length : 0,
      brandCount: ctx.bank ? ctx.bank.questions.filter((q) => !q.cohortShared).length : 0,
    },
    edit: {
      active,
      stale: Boolean(current) && !active,
      savedAt: file?.lastSave?.savedAt ?? null,
      summary: file?.lastSave?.summary ?? null,
      undoAvailable: canUndo(file, tenant.competitors),
      repoCompetitors: repo?.competitors ?? [],
    },
    measuring: measureInFlight(),
  };
}

/** 바꾼 목록을 미리 계산한다 — 저장하지 않는다. 저장도 같은 계산을 거친다(미리 본 것과 저장하는 것이 같게). */
export async function planEdit(tenant: TenantConfig, runtime: TenantConfig[], store: ResultStore, input: unknown): Promise<EditPlan> {
  let normalized;
  try {
    normalized = normalizeCompetitorList(input, tenant, tenant.competitors);
  } catch (err) {
    throw new EditorError(400, err instanceof Error ? err.message : String(err));
  }
  const notes: string[] = [];
  const errors: string[] = [];
  // 새로 넣은 이름이 같은 업종에 등록된 브랜드면 그 홈페이지로 잇는다 — 이름만으로 재면 id가 달라 같은 곳이 두 줄이 된다.
  // 고객 자신의 이름은 넣을 수 없다. 원래 목록에 있던 줄은 손대지 않는다(id가 바뀌면 기록이 끊긴다).
  const own = new Set([tenant.brandName, ...tenant.aliases].map(squash));
  const before = new Set(tenant.competitors.map((c) => squash(c.name)));
  const language = (t: TenantConfig) => t.questionLanguage ?? 'ko';
  const competitors = normalized.competitors.map((c) => {
    const key = squash(c.name);
    if (own.has(key) || c.aliases.some((a) => own.has(squash(a)))) errors.push(`${c.name}: ${tenant.brandName} 자신이에요 — 경쟁사로 넣을 수 없어요.`);
    if (before.has(key) || c.domains.length) return c;
    const registered = runtime.find(
      (t) =>
        t.tenantId !== tenant.tenantId &&
        t.industry === tenant.industry &&
        language(t) === language(tenant) &&
        t.ownedDomains.length > 0 &&
        [t.brandName, ...t.aliases].some((n) => squash(n) === key),
    );
    if (!registered) return c;
    notes.push(`${c.name}: 등록된 브랜드(${registered.brandName} · ${registered.ownedDomains[0]})와 이어 재요.`);
    return { ...c, domains: [registered.ownedDomains[0]!] };
  });
  const ctx = await loadContext(tenant, runtime, store);
  const [now, next] = await Promise.all([describeRows(ctx, tenant.competitors), describeRows(ctx, competitors)]);
  const nextMeasured = new Set(next.rows.filter((r) => r.status === 'measured').map((r) => r.targetTenantId));
  const week = getIsoWeekString(new Date());
  const leaving = now.rows
    .filter((r) => r.status === 'measured' && !nextMeasured.has(r.targetTenantId))
    .map((r) => ({ name: r.name, tenantId: r.targetTenantId, questionIds: r.questionIds, thisWeek: r.latest?.weekOf === week }));

  for (const l of leaving) {
    if (l.questionIds.length) {
      notes.push(`질문지는 그대로예요 — 빠진 ${objectParticle(l.name)} 묻는 질문(${l.questionIds.join(' · ')})이 남아요.`);
    }
    if (l.thisWeek) notes.push(`이번 주(${shortWeek(week)})에 다시 재도 ${l.name}의 ${shortWeek(week)} 기록은 순위표에 남아요.`);
  }
  if (normalized.droppedHosts.length) {
    notes.push(`공용 주소라 홈페이지로 쓰지 않았어요(이름으로 잽니다): ${normalized.droppedHosts.join(', ')}`);
  }
  for (const r of next.rows) {
    if (!r.deletedOtherIndustry) continue;
    errors.push(
      `${r.name}: 지운 다른 업종 브랜드(${r.deletedOtherIndustry.brandName} · ${r.deletedOtherIndustry.industry})와 id가 같아 넣을 수 없어요. 홈페이지 주소를 넣거나 이름을 조금 바꿔 주세요.`,
    );
  }
  return {
    ...next,
    competitors,
    droppedHosts: normalized.droppedHosts,
    leaving,
    notes,
    errors,
    unchanged: sameList(competitors, tenant.competitors),
    measuring: measureInFlight(),
  };
}

// 저장·되돌리기는 측정 기록과 같은 줄에서 — 같은 파일을 두 곳이 동시에 읽고 쓰지 않게(tenantCompetitorsStore.ts).
const serializeEdit = serializeCompetitorFile;

async function customerTenant(tenantId: string): Promise<{ tenant: TenantConfig; runtime: TenantConfig[] }> {
  const runtime = await loadRuntimeTenants();
  const tenant = runtime.find((t) => t.tenantId === tenantId);
  if (!tenant || tenant.cohortOnly) throw new EditorError(404, `tenant not found: ${tenantId}`);
  return { tenant, runtime };
}

function assertNotMeasuring(): void {
  if (measureInFlight()) throw new EditorError(409, '측정이 진행 중이에요. 끝난 뒤에 저장해 주세요.');
}

/** 바꾼 목록을 저장한다. 다음 측정부터 이 목록으로 잰다. */
export function saveEdit(tenantId: string, store: ResultStore, body: unknown): Promise<CompetitorEditorState> {
  return serializeEdit(async () => {
    assertNotMeasuring();
    const { tenant, runtime } = await customerTenant(tenantId);
    const raw = (body ?? {}) as { competitors?: unknown; summary?: unknown };
    const plan = await planEdit(tenant, runtime, store, raw.competitors);
    if (plan.errors.length) throw new EditorError(400, plan.errors.join(' '));
    if (plan.unchanged) throw new EditorError(400, '바뀐 내용이 없어요.');
    const repo = await loadTenantWithoutCompetitorEdit(tenantId);
    if (!repo) throw new EditorError(404, `tenant not found: ${tenantId}`);
    const competitors = plan.competitors;
    const file = await readCompetitorOverride(tenantId);
    const before = overrideApplies(file?.current ?? null, repo) ? file!.current : null;
    // 저장소 설정과 같아지면 고친 목록을 지운다 — 저장소 설정을 그대로 따른다.
    const current: CompetitorOverride | null = sameList(competitors, repo.competitors) ? null : { competitors, base: baseFingerprint(repo) };
    const summary = typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary.trim().slice(0, 300) : '경쟁사 목록을 바꿨어요';
    // 처음 고칠 때는 지금 목록이 마지막 측정이 쓴 목록이다 — 「다음 측정 대기」를 그것과 견준다.
    const measured = file?.measured ?? { at: null, listHash: listHash(tenant.competitors) };
    assertNotMeasuring(); // 위에서 기다리는 동안 측정이 시작됐을 수 있다 — 쓰기 직전에 다시 본다.
    await writeCompetitorOverride(tenantId, { current, lastSave: { savedAt: new Date().toISOString(), before, summary }, measured });
    const after = await customerTenant(tenantId);
    return buildEditorState(after.tenant, after.runtime, store);
  });
}

/** 마지막 저장을 되돌린다 — 그 뒤 이 브랜드를 쟀으면 안 된다. */
export function undoEdit(tenantId: string, store: ResultStore): Promise<CompetitorEditorState> {
  return serializeEdit(async () => {
    assertNotMeasuring();
    const { tenant } = await customerTenant(tenantId);
    const file = await readCompetitorOverride(tenantId);
    if (!file?.lastSave) throw new EditorError(409, '되돌릴 저장이 없어요.');
    if (!canUndo(file, tenant.competitors)) {
      throw new EditorError(409, '저장한 뒤 이 목록으로 이미 측정해서 되돌릴 수 없어요. 경쟁사를 다시 바꿔 저장해 주세요.');
    }
    assertNotMeasuring();
    await writeCompetitorOverride(tenantId, { current: file.lastSave.before, lastSave: null, measured: file.measured });
    const after = await customerTenant(tenantId);
    return buildEditorState(after.tenant, after.runtime, store);
  });
}

/** 앱에서 고친 목록을 버리고 저장소 설정을 따른다. 되돌릴 수 있게 저장 기록을 남긴다. */
export function resetEdit(tenantId: string, store: ResultStore): Promise<CompetitorEditorState> {
  return serializeEdit(async () => {
    assertNotMeasuring();
    const [file, repo] = await Promise.all([readCompetitorOverride(tenantId), loadTenantWithoutCompetitorEdit(tenantId)]);
    if (!repo || repo.cohortOnly) throw new EditorError(404, `tenant not found: ${tenantId}`);
    // 고친 목록이 없거나, 저장소 설정이 바뀌어 이미 쓰이지 않는 목록이면 돌아갈 것이 없다.
    if (!file?.current || !overrideApplies(file.current, repo)) throw new EditorError(409, '이미 저장소 설정을 쓰고 있어요.');
    assertNotMeasuring();
    await writeCompetitorOverride(tenantId, {
      current: null,
      lastSave: { savedAt: new Date().toISOString(), before: file.current, summary: '저장소 설정의 경쟁사 목록으로 돌아감' },
      measured: file.measured,
    });
    const after = await customerTenant(tenantId);
    return buildEditorState(after.tenant, after.runtime, store);
  });
}

/**
 * 고친 목록을 아직 재지 않았다 — 브랜드 현황 카드의 「경쟁사 바뀜 · 다음 측정 대기」.
 * tenant는 측정이 읽는 런타임 값이다(고친 목록이 쓰이면 그 목록). 마지막으로 잰 목록과 다르면 대기다.
 * 고친 목록이 저장소 설정 변경으로 쓰이지 않으면(지문 다름) 다음 측정도 그 목록을 쓰지 않으므로 대기가 아니다.
 */
export async function pendingCompetitorEdit(tenant: TenantConfig): Promise<{ savedAt: string; summary: string } | null> {
  const file = await readCompetitorOverride(tenant.tenantId);
  if (!file?.measured) return null;
  if (file.current && !sameList(file.current.competitors, tenant.competitors)) return null;
  if (file.measured.listHash === listHash(tenant.competitors)) return null;
  return { savedAt: file.lastSave?.savedAt ?? file.updatedAt, summary: file.lastSave?.summary ?? '경쟁사 목록을 바꿨어요' };
}
