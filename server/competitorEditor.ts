import { createHash } from 'node:crypto';
import {
  applyExclusionChanges,
  isExcluded,
  readCohortExclusions,
  stampExclusion,
  updateCohortExclusions,
  type CohortExclusion,
} from './cohortExclusionStore.js';
import { competitorDraftId, planCohortTargets, type CompetitorPlanStatus } from './cohortPlan.js';
import { cohortKey } from './cohortQuestionBank.js';
import { affectedCohortWeeks, planCohortRanks, reconcileCohortRanks, type CohortWeekKey } from './cohortRank.js';
import { discoverBrands } from './competitorDiscovery.js';
import { checkCompetitorIndustry } from './competitorIndustry.js';
import {
  effectiveIndustry,
  industryKey,
  readCompetitorIndustry,
  updateCompetitorIndustry,
  type CompetitorIndustryEntry,
} from './competitorIndustryStore.js';
import { linkCompetitorQuestions } from './competitorQuestions.js';
import { measureInFlight } from './measureTracker.js';
import {
  checkRewrite,
  deriveQuestionBank,
  linkAfterEdit,
  nextBankVersion,
  planQuestionHandoff,
  type HandoffHint,
  type QuestionPlan,
  type RewriteDraft,
} from './questionHandoff.js';
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
import { directionParticle } from '../src/lib/korean.js';
import { agnosticQuota, countAgnostic } from '../src/prompts/b1-question-bank.js';
import type { WeeklyScorecard } from '../src/prompts/b8-report.js';
import type { CompetitorContext, QuestionLanguage } from '../src/prompts/types.js';
import type { EngineClient } from './engines/types.js';
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
  /** 이 코호트에서의 첫 카드 주차(「지난 기록에서도 빼기」 범위 표시). */
  cohortFirstWeekOf: string | null;
  /** 지난 기록에서 뺀 범위(코호트 제외 목록). */
  excluded: ExcludedRange[];
  /** 이 경쟁사를 함께 재는 다른 고객 브랜드 — 있으면 지난 기록에서 뺄 수 없다(그 고객의 순위표에 든다). */
  measuredByOthers: string[];
  /** 이 코호트에서의 마지막 카드. 한 번도 안 쟀으면 null. */
  latest: { weekOf: string; score: number; mentionRate: number; brandOwnedCitationRate: number } | null;
  /** 이 경쟁사를 짚은 브랜드 질문 id(다음 측정에 쓸 질문지 기준). */
  questionIds: string[];
  /** 「업종 다름」 판정(competitorIndustryStore.ts) — 모르면 null. 다르면 비교 질문을 넘겨받지 않는다. */
  industry: IndustryMark | null;
}

/** 경쟁사 업종 판정 — 사람이 정한 값이 AI 판정보다 먼저다. */
export interface IndustryMark {
  verdict: 'same' | 'different';
  looksLike: string | null;
  by: 'ai' | 'person';
}

export interface EditorPastCompetitor {
  tenantId: string;
  brandName: string;
  aliases: string[];
  domains: string[];
  /** 이 고객의 최근 순위표(최근 12주)에 든 주차 수와 처음 · 마지막 주차. */
  weeks: number;
  firstWeekOf: string;
  lastWeekOf: string;
  lastScore: number;
  /**
   * 지금 코호트(업종 · 지역)에 있는 이 경쟁사 카드 전체 — 「지난 기록에서도 빼기」가 빼는 범위다(최근 12주보다 넓을 수 있다).
   * 0이면 옛 코호트(이 고객이 코호트를 옮기기 전)의 기록뿐이라 뺄 것이 없다.
   */
  cohortWeeks: number;
  cohortFirstWeekOf: string | null;
  cohortLastWeekOf: string | null;
  /** 지난 기록에서 뺀 범위(코호트 제외 목록). 비면 지난 순위표에 남아 있다. */
  excluded: ExcludedRange[];
}

/** 코호트 제외 목록에 든 범위 — fromWeek가 없으면 처음부터. */
export interface ExcludedRange {
  id: string;
  fromWeek?: string;
  untilWeek: string;
}

/** 순위 한 칸(코호트 순위의 화면용). */
export interface RankLite {
  position: number;
  totalTenants: number;
  tiedCount: number;
}

/**
 * 「지난 기록에서도 빼기」 · 「다시 세기」 미리보기 — 저장하지 않는다. 저장은 같은 계산을 다시 하고 key가 같을 때만 쓴다
 * (미리 본 순위 = 저장되는 순위).
 */
export interface ExclusionPreview {
  /** firstWeek · weeks: 그 범위에 든 이 코호트 카드의 첫 주차와 주차 수. */
  items: { tenantId: string; brandName: string; action: 'exclude' | 'restore'; fromWeek?: string; untilWeek: string; firstWeek: string; weeks: number }[];
  /** 이 고객의 주차별 순위 — 지금 저장된 값과 바뀐 뒤. 그 주 코호트에 이 고객 카드가 없으면 넣지 않는다. */
  weeks: { weekOf: string; before: RankLite | null; after: RankLite }[];
  /** 그 경쟁사를 지금 함께 재는 다른 고객이 있다 — 저장할 수 없다. */
  locked: { tenantId: string; brandName: string; by: string[] }[];
  /** 순위가 함께 바뀌는 다른 고객 브랜드(그 경쟁사를 재지는 않는다). */
  otherCustomers: { brandName: string; weeks: number }[];
  /** 순위를 다시 쓸 카드 수(같은 코호트의 다른 브랜드 카드 포함). */
  cardsRewritten: number;
  /** 미리 본 결과의 지문 — 저장할 때 같아야 한다. */
  key: string;
}

/** 화면이 보내는 「지난 기록」 바꾸기 — 뺄 경쟁사(onlyWeek면 그 주만)와 다시 셀 경쟁사. */
export interface PastOutInput {
  add: { tenantId: string; onlyWeek?: string }[];
  restore: string[];
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
    /** 경쟁사를 바꾸며 고쳐 만든 질문지면 그 출처(앞 버전 · 고친 수 · 뺀 수). */
    derived: { from: string; replaced: number; removed: number } | null;
    /** 「브랜드 질문 모두 새로 쓰기」 — 목록은 그대로 두고 질문지만 새로 쓰는 저장(서랍 바닥 줄)에 쓴다. */
    rewriteAll: RewriteAllPlan;
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
  /** 「지난 기록에서도 빼기」 · 「다시 세기」 미리보기. 요청에 없으면 null. */
  exclusion: ExclusionPreview | null;
  /** 질문 넘겨받기(4단계) — 빠지는 경쟁사의 질문을 누가 받고, 질문지가 어떻게 되는가. */
  questions: QuestionPlan;
  /** 「브랜드 질문 모두 새로 쓰기」(5단계) — 고르면 저장할 때 버전만 올리고 다음 측정이 새로 쓴다. */
  rewriteAll: RewriteAllPlan;
  /** 저장한 뒤 함께 재는데 비교 질문이 없는 곳(빠지는 질문 빼고 넘겨받는 질문 더해) — 「모두 새로 쓰기」를 권하는 안내에 쓴다. */
  noQuestion: string[];
  /** 「질문지 그대로 두기」로 저장하면 비교 질문이 없는 곳(넘겨받기 없이 지금 질문만). */
  noQuestionKept: string[];
}

/**
 * 「브랜드 질문 모두 새로 쓰기」 — 저장할 때 은행 파일은 쓰지 않고 수정본에 다음 버전 · 크기만 적는다. 다음 측정이 그 버전을 바꾼
 * 목록으로 새로 만든다(cohortQuestionBank.ts ensureComposedQuestionBank). 공통 질문은 코호트 은행에서 그대로 가져온다.
 */
export interface RewriteAllPlan {
  available: boolean;
  /** 쓸 수 없으면 그 이유(화면에 그대로 보인다). */
  reason: string | null;
  fromVersion: string;
  toVersion: string;
  /** 새로 쓸 질문지 문항 수 — 저장소 설정 값으로 되돌린다(넘겨받기로 뺀 질문까지 다시 채운다, 결정 E1). */
  size: number;
  /** 새로 쓸 브랜드 질문 수(문항 수 − 공통 질문 수). */
  brandCount: number;
  /** 저장할 때 같아야 하는 지문 — 버전 · 크기 · 목록. */
  key: string;
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
/** 넘겨받기와 같은 이름 비교 — 띄어쓰기 · 대소문자를 무시한다(questionHandoff.ts). */
const fold = (s: string) => s.replace(/\s+/g, '').toLowerCase();
const sameList =(a: CompetitorContext[], b: CompetitorContext[]) =>
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
  /** 코호트 제외 목록 전체(cohortExclusionStore.ts). */
  exclusions: CohortExclusion[];
  /** 같은 코호트의 다른 고객이 목록에 둔 경쟁사 id(대기 포함) — 예전 경쟁사에서 뺀다. */
  othersListed: Set<string>;
  /** 같은 코호트의 다른 고객이 지금 함께 재는 경쟁사 id → 그 고객 이름들 — 지난 기록에서 뺄 수 없다. */
  othersMeasuring: Map<string, string[]>;
  /** 이 고객이 본 경쟁사 업종 판정(이름 키). */
  industryMarks: Record<string, CompetitorIndustryEntry>;
}

/** 그 이름의 업종 판정(지금 고객 업종 기준). */
const industryOf = (ctx: Context, name: string): IndustryMark | null => effectiveIndustry(ctx.industryMarks[industryKey(name)], ctx.tenant.industry);

async function loadContext(tenant: TenantConfig, runtime: TenantConfig[], store: ResultStore): Promise<Context> {
  const [history, deleted, bank, exclusions, industryMarks] = await Promise.all([
    store.getScorecardHistory(tenant.tenantId, Number.MAX_SAFE_INTEGER),
    readDeletedTenants(),
    store.getQuestionBank(tenant.tenantId, tenant.questionBankVersion),
    readCohortExclusions(),
    readCompetitorIndustry(tenant.tenantId),
  ]);
  const last = history.at(-1) ?? null;
  // 코호트는 점수 기록의 업종·지역이다(영어 질문 측정은 지역에 꼬리표가 붙는다). 측정 전이면 설정값.
  const industry = last?.industry ?? tenant.industry;
  const region = last?.region ?? tenant.region;
  const othersListed = new Set<string>();
  const othersMeasuring = new Map<string, string[]>();
  // 같은 코호트의 다른 고객 — 마지막 카드가 이 코호트에 있거나(아직 옛 코호트로 순위표에 든다), 설정이 이 코호트인(다음 측정부터
  // 여기서 잰다) 고객. 설정만 보면 「국내」로 옮기고 아직 다시 재지 않은 고객을 놓쳐 잠금이 빠진다.
  const others = runtime.filter((o) => !o.cohortOnly && o.tenantId !== tenant.tenantId);
  const otherLast = await Promise.all(others.map((o) => store.getScorecardHistory(o.tenantId, 1)));
  for (const [i, other] of others.entries()) {
    const ol = otherLast[i]!.at(-1);
    const inCohort =
      ((ol?.industry ?? other.industry) === industry && (ol?.region ?? other.region) === region) ||
      (other.industry === industry && other.region === region);
    if (!inCohort) continue;
    for (const e of planCohortTargets(other, runtime).entries) {
      for (const id of [e.targetTenantId, e.draftId]) {
        if (!id) continue;
        othersListed.add(id);
        if (e.status === 'measured') othersMeasuring.set(id, [...new Set([...(othersMeasuring.get(id) ?? []), other.brandName])]);
      }
    }
  }
  return {
    tenant,
    runtime,
    store,
    history,
    last,
    industry,
    region,
    customers: new Set(runtime.filter((t) => !t.cohortOnly).map((t) => t.tenantId)),
    deletedIds: new Set(deleted),
    bank,
    exclusions,
    othersListed,
    othersMeasuring,
    industryMarks,
  };
}

/** 이 고객의 코호트에서 그 경쟁사를 뺀 범위. */
function excludedRanges(ctx: Context, tenantId: string): ExcludedRange[] {
  return ctx.exclusions
    .filter((e) => e.tenantId === tenantId && e.industry === ctx.industry && e.region === ctx.region)
    .map((e) => ({ id: e.id, ...(e.fromWeek ? { fromWeek: e.fromWeek } : {}), untilWeek: e.untilWeek }));
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
        cohortFirstWeekOf: inCohort[0]?.weekOf ?? null,
        excluded: id ? excludedRanges(ctx, id) : [],
        measuredByOthers: id ? (ctx.othersMeasuring.get(id) ?? []) : [],
        latest: card
          ? { weekOf: card.weekOf, score: card.aeoScore.current, mentionRate: card.mentionRate, brandOwnedCitationRate: card.brandOwnedCitationRate }
          : null,
        questionIds: links?.byCompetitor[entry.index] ?? [],
        industry: industryOf(ctx, entry.name),
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
  const ownIds = new Set(rows.flatMap((r) => [r.targetTenantId, r.draftId]).filter((x): x is string => Boolean(x)));
  // 같은 코호트의 다른 고객이 목록에 둔 경쟁사도 뺀다 — 이 고객이 뺀 곳이 아니다. 다만 이 코호트에서 지난 기록을 뺀 경쟁사는
  // 남긴다 — 「다시 세기」를 할 곳이 이 목록뿐이다.
  const hidden = (id: string) => ownIds.has(id) || (ctx.othersListed.has(id) && !excludedRanges(ctx, id).length);
  const byId = new Map(ctx.runtime.map((t) => [t.tenantId, t]));
  const pastMap = new Map<string, Omit<EditorPastCompetitor, 'cohortWeeks' | 'cohortFirstWeekOf' | 'cohortLastWeekOf'>>();
  // 최근 12주만 본다 — 주마다 모든 브랜드 폴더를 읽으므로(getCohortScorecards) 오래된 기록까지 훑으면 서랍이 느려진다.
  // 지난 기록에서 뺀 경쟁사도 보여야 한다(「다시 세기」) — 제외 목록 없이 읽고 뺀 범위를 따로 붙인다.
  const recent = ctx.history.slice(-PAST_WEEKS);
  const cohorts = await Promise.all(recent.map((card) => ctx.store.getCohortScorecards(card.industry, card.region, card.weekOf, { exclusions: [] })));
  for (const members of cohorts) {
    for (const m of members) {
      if (m.tenantId === ctx.tenant.tenantId || ctx.customers.has(m.tenantId) || hidden(m.tenantId)) continue;
      const prev = pastMap.get(m.tenantId);
      const newer = !prev || m.weekOf >= prev.lastWeekOf;
      const t = byId.get(m.tenantId);
      pastMap.set(m.tenantId, {
        tenantId: m.tenantId,
        brandName: newer ? m.brandName : prev.brandName,
        aliases: t?.aliases ?? [m.brandName],
        domains: t?.ownedDomains ?? [],
        weeks: (prev?.weeks ?? 0) + 1,
        firstWeekOf: prev && prev.firstWeekOf < m.weekOf ? prev.firstWeekOf : m.weekOf,
        lastWeekOf: newer ? m.weekOf : prev.lastWeekOf,
        lastScore: newer ? m.aeoScore.current : prev.lastScore,
        excluded: excludedRanges(ctx, m.tenantId),
      });
    }
  }
  // 최근 12주 밖에서 뺀 경쟁사도 「다시 세기」를 할 수 있게 넣는다.
  const extra = [
    ...new Set(
      ctx.exclusions
        .filter((e) => e.industry === ctx.industry && e.region === ctx.region && !pastMap.has(e.tenantId) && !hidden(e.tenantId) && !ctx.customers.has(e.tenantId))
        .map((e) => e.tenantId),
    ),
  ];
  const ids = [...pastMap.keys(), ...extra];
  const histories = await Promise.all(ids.map((id) => ctx.store.getScorecardHistory(id, Number.MAX_SAFE_INTEGER)));
  const out: EditorPastCompetitor[] = [];
  for (const [i, id] of ids.entries()) {
    const inCohort = histories[i]!.filter((c) => c.industry === ctx.industry && c.region === ctx.region);
    const cohort = { cohortWeeks: inCohort.length, cohortFirstWeekOf: inCohort[0]?.weekOf ?? null, cohortLastWeekOf: inCohort.at(-1)?.weekOf ?? null };
    const seen = pastMap.get(id);
    if (seen) {
      out.push({ ...seen, ...cohort });
      continue;
    }
    const lastCard = inCohort.at(-1);
    if (!lastCard) continue;
    const t = byId.get(id);
    out.push({
      tenantId: id,
      brandName: lastCard.brandName,
      aliases: t?.aliases ?? [lastCard.brandName],
      domains: t?.ownedDomains ?? [],
      weeks: inCohort.length,
      firstWeekOf: inCohort[0]!.weekOf,
      lastWeekOf: lastCard.weekOf,
      lastScore: lastCard.aeoScore.current,
      excluded: excludedRanges(ctx, id),
      ...cohort,
    });
  }
  return out.sort((a, b) => b.lastWeekOf.localeCompare(a.lastWeekOf) || a.brandName.localeCompare(b.brandName, 'ko'));
}

/** 「+ 경쟁사 추가」 후보 — 예전 경쟁사, 같은 코호트에 등록된 브랜드, 마지막 측정 답변에 나온 이름. AI는 부르지 않는다. */
async function suggestionsFor(ctx: Context, rows: EditorCompetitorRow[], past: EditorPastCompetitor[]): Promise<EditorSuggestion[]> {
  const taken = new Set(rows.flatMap((r) => [r.targetTenantId, r.draftId, r.name.replace(/\s+/g, '')]).filter((x): x is string => Boolean(x)));
  const out: EditorSuggestion[] = [];
  const add = (s: EditorSuggestion) => {
    const key = s.name.replace(/\s+/g, '');
    if (taken.has(key)) return;
    // 다른 업종으로 본 곳은 권하지 않는다(사람이 「업종 맞음」으로 풀면 다시 나온다).
    if (industryOf(ctx, s.name)?.verdict === 'different') return;
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

/** 마지막 목록 저장의 시각 · 요약 — 지난 기록만 바꾼 저장은 건너뛴다(그 전 목록 저장을 이어 둔 값). 없으면 undefined. */
function listSaveInfo(file: CompetitorOverrideFile): { savedAt: string; summary: string } | undefined {
  const ls = file.lastSave;
  if (!ls) return undefined;
  if (ls.listUnchanged) return ls.list;
  return { savedAt: ls.savedAt, summary: ls.summary };
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
  const [described, file, repo, bankVersions] = await Promise.all([
    describeRows(ctx, tenant.competitors),
    readCompetitorOverride(tenant.tenantId),
    loadTenantWithoutCompetitorEdit(tenant.tenantId),
    store.listQuestionBankVersions(tenant.tenantId),
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
      derived: ctx.bank?.derivedFrom
        ? { from: ctx.bank.derivedFrom.version, replaced: ctx.bank.derivedFrom.replaced.length, removed: ctx.bank.derivedFrom.removed.length }
        : null,
      rewriteAll: rewriteAllFor(tenant, repo, ctx.bank, takenVersions(bankVersions, ctx.history, repo), tenant.competitors),
    },
    edit: {
      active,
      stale: Boolean(current) && !active,
      savedAt: (file ? listSaveInfo(file)?.savedAt : undefined) ?? file?.lastSave?.savedAt ?? null,
      summary: file?.lastSave?.summary ?? null,
      undoAvailable: canUndo(file, tenant.competitors),
      repoCompetitors: repo?.competitors ?? [],
    },
    measuring: measureInFlight(),
  };
}

/** 지난 기록 바꾸기를 정리한다 — 잘못된 입력이면 400. */
function parsePastOut(raw: unknown): PastOutInput | null {
  if (raw === undefined || raw === null) return null;
  const x = raw as { add?: unknown; restore?: unknown };
  const add = Array.isArray(x.add) ? x.add : [];
  const restore = Array.isArray(x.restore) ? x.restore : [];
  const out: PastOutInput = { add: [], restore: [] };
  for (const item of add) {
    const a = (item ?? {}) as { tenantId?: unknown; onlyWeek?: unknown };
    if (typeof a.tenantId !== 'string' || !a.tenantId) throw new EditorError(400, '지난 기록에서 뺄 경쟁사가 올바르지 않습니다.');
    if (a.onlyWeek !== undefined && (typeof a.onlyWeek !== 'string' || !/^\d{4}-W\d{2}$/.test(a.onlyWeek))) {
      throw new EditorError(400, `주차를 알아볼 수 없습니다: ${String(a.onlyWeek)}`);
    }
    if (out.add.some((o) => o.tenantId === a.tenantId)) continue;
    out.add.push({ tenantId: a.tenantId, ...(typeof a.onlyWeek === 'string' ? { onlyWeek: a.onlyWeek } : {}) });
  }
  for (const id of restore) {
    if (typeof id !== 'string' || !id) throw new EditorError(400, '다시 셀 경쟁사가 올바르지 않습니다.');
    if (!out.restore.includes(id)) out.restore.push(id);
  }
  return out.add.length || out.restore.length ? out : null;
}

const rankLite = (r: { position: number; totalTenants: number; tiedCount?: number }): RankLite => ({
  position: r.position,
  totalTenants: r.totalTenants,
  tiedCount: r.tiedCount ?? 1,
});

/** 제외 목록 바꾸기 — 저장이 쓰는 항목(새로 뺄 항목 · 지울 항목 id)과 미리보기. */
interface ExclusionChange {
  add: CohortExclusion[];
  removed: CohortExclusion[];
  affected: CohortWeekKey[];
  preview: ExclusionPreview;
}

/**
 * 「지난 기록에서도 빼기」 · 「다시 세기」를 미리 계산한다. 뺄 수 있는 경쟁사는 바꾼 목록에서 아예 빠진 곳(대기 줄도 아님)이고,
 * 이 코호트에 카드가 있어야 한다. 그 경쟁사를 다른 고객이 함께 재면 잠근다(locked — 저장 409). 고객 브랜드는 뺄 수 없다.
 */
async function planExclusion(
  ctx: Context,
  nextRows: EditorCompetitorRow[],
  input: PastOutInput,
  errors: string[],
  notes: string[],
): Promise<ExclusionChange> {
  const listed = new Set(nextRows.flatMap((r) => [r.targetTenantId, r.draftId]).filter((x): x is string => Boolean(x)));
  const add: CohortExclusion[] = [];
  const items: ExclusionPreview['items'] = [];
  const locked: ExclusionPreview['locked'] = [];
  for (const a of input.add) {
    if (a.tenantId === ctx.tenant.tenantId || ctx.customers.has(a.tenantId)) {
      errors.push('고객 브랜드는 지난 기록에서 뺄 수 없어요.');
      continue;
    }
    if (listed.has(a.tenantId)) {
      errors.push('목록에 남은 경쟁사(대기 포함)는 지난 기록에서 뺄 수 없어요 — 목록에서 뺀 뒤 체크해 주세요.');
      continue;
    }
    const history = await ctx.store.getScorecardHistory(a.tenantId, Number.MAX_SAFE_INTEGER);
    const inCohort = history.filter((c) => c.industry === ctx.industry && c.region === ctx.region);
    const last = inCohort.at(-1);
    if (!last) {
      errors.push(`${history.at(-1)?.brandName ?? a.tenantId}: 이 코호트(${ctx.industry} · ${ctx.region})에 남은 기록이 없는 경쟁사예요.`);
      continue;
    }
    if (a.onlyWeek && !inCohort.some((c) => c.weekOf === a.onlyWeek)) {
      errors.push(`${last.brandName}의 ${shortWeek(a.onlyWeek)} 기록이 이 코호트에 없어요.`);
      continue;
    }
    const by = ctx.othersMeasuring.get(a.tenantId) ?? [];
    if (by.length) locked.push({ tenantId: a.tenantId, brandName: last.brandName, by });
    const entry = stampExclusion({
      industry: ctx.industry,
      region: ctx.region,
      tenantId: a.tenantId,
      untilWeek: a.onlyWeek ?? last.weekOf,
      ...(a.onlyWeek ? { fromWeek: a.onlyWeek } : {}),
      brandName: last.brandName,
      excludedBy: ctx.tenant.tenantId,
    });
    const covered = inCohort.filter((c) => c.weekOf <= entry.untilWeek && (!entry.fromWeek || c.weekOf >= entry.fromWeek));
    // 이미 뺀 주만 덮으면 항목을 더 만들지 않는다 — 같은 범위 항목이 겹쳐 쌓이면 「다시 세기」 · 되돌리기가 일부만 푼다.
    if (covered.every((c) => isExcluded(ctx.exclusions, c))) {
      notes.push(`${last.brandName}: 그 주차는 이미 지난 기록에서 뺐어요.`);
      continue;
    }
    add.push(entry);
    items.push({
      tenantId: a.tenantId,
      brandName: last.brandName,
      action: 'exclude',
      ...(entry.fromWeek ? { fromWeek: entry.fromWeek } : {}),
      untilWeek: entry.untilWeek,
      firstWeek: covered[0]?.weekOf ?? entry.untilWeek,
      weeks: covered.length,
    });
  }
  const removed: CohortExclusion[] = [];
  for (const id of input.restore) {
    const entries = ctx.exclusions.filter((e) => e.tenantId === id && e.industry === ctx.industry && e.region === ctx.region);
    if (!entries.length) continue;
    removed.push(...entries);
    const history = await ctx.store.getScorecardHistory(id, Number.MAX_SAFE_INTEGER);
    const covered = history.filter((c) => c.industry === ctx.industry && c.region === ctx.region && entries.some((e) => c.weekOf <= e.untilWeek && (!e.fromWeek || c.weekOf >= e.fromWeek)));
    items.push({
      tenantId: id,
      brandName: entries.at(-1)!.brandName,
      action: 'restore',
      ...(entries.length === 1 && entries[0]!.fromWeek ? { fromWeek: entries[0]!.fromWeek } : {}),
      untilWeek: entries.map((e) => e.untilWeek).sort().at(-1)!,
      firstWeek: covered[0]?.weekOf ?? entries[0]!.untilWeek,
      weeks: covered.length,
    });
  }
  const hypo = applyExclusionChanges(ctx.exclusions, { add, removeIds: removed.map((e) => e.id) });
  const affected = await affectedCohortWeeks(ctx.store, [...add, ...removed]);
  const plans = await Promise.all(affected.map((k) => planCohortRanks(ctx.store, k.industry, k.region, k.weekOf, hypo)));
  const weeks: ExclusionPreview['weeks'] = [];
  const others = new Map<string, number>();
  let cardsRewritten = 0;
  const changedForKey: [string, string, RankLite][] = [];
  for (const plan of plans) {
    for (const c of plan.cards) {
      if (c.changed) {
        cardsRewritten += 1;
        changedForKey.push([plan.weekOf, c.tenantId, rankLite(c.after)]);
      }
      if (c.tenantId === ctx.tenant.tenantId) {
        weeks.push({ weekOf: plan.weekOf, before: c.before ? rankLite(c.before) : null, after: rankLite(c.after) });
      } else if (c.changed && ctx.customers.has(c.tenantId)) {
        others.set(c.brandName, (others.get(c.brandName) ?? 0) + 1);
      }
    }
  }
  // 미리 본 결과의 지문 — 무엇을 빼고 되살리는지와, 그 결과 다시 쓸 순위.
  const key = createHash('sha1')
    .update(JSON.stringify({ add: add.map((e) => [e.tenantId, e.industry, e.region, e.fromWeek ?? null, e.untilWeek]), removed: removed.map((e) => e.id), changed: changedForKey }))
    .digest('hex')
    .slice(0, 16);
  return {
    add,
    removed,
    affected,
    preview: {
      items,
      weeks: weeks.sort((a, b) => a.weekOf.localeCompare(b.weekOf)),
      locked,
      otherCustomers: [...others.entries()].map(([brandName, n]) => ({ brandName, weeks: n })),
      cardsRewritten,
      key,
    },
  };
}

/** 바꾼 목록을 미리 계산한다 — 저장하지 않는다. 저장도 같은 계산을 거친다(미리 본 것과 저장하는 것이 같게). */
export async function planEdit(
  tenant: TenantConfig,
  runtime: TenantConfig[],
  store: ResultStore,
  input: unknown,
  pastOut?: unknown,
  handoff?: unknown,
  options?: PlanOptions,
): Promise<EditPlan> {
  return (await computePlan(tenant, runtime, store, input, pastOut, handoff, options)).plan;
}

/** 넘겨받기 계획 선택 — existingReceivers: false면 이미 재는 곳은 질문을 받지 않는다(questionHandoff.ts). */
export interface PlanOptions {
  existingReceivers?: boolean;
}

/** 화면이 보내는 넘겨받기 힌트(바꿈 · 측정에 넣기 — 누가 누구 자리에 들었나)를 정리한다. 잘못된 입력이면 400. */
function parseHints(raw: unknown): HandoffHint[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 40) throw new EditorError(400, '바꾼 경쟁사 정보가 올바르지 않습니다.');
  return raw.map((h) => {
    const x = (h ?? {}) as { from?: unknown; to?: unknown };
    if (typeof x.from !== 'string' || !x.from.trim() || typeof x.to !== 'string' || !x.to.trim()) {
      throw new EditorError(400, '바꾼 경쟁사 정보가 올바르지 않습니다.');
    }
    return { from: x.from, to: x.to };
  });
}

/** 고쳐 쓰기(판정 엔진)와 저장 검사가 함께 쓰는 값 — 같은 계획 위에서 문장을 만들고 검사한다. */
export interface QuestionRewriteContext {
  plan: QuestionPlan;
  bank: QuestionBank | null;
  /** 바꾼 목록(측정 순서). */
  next: CompetitorContext[];
  /** 지금 목록에 있다가 바꾼 목록에서 빠지는 곳 — 고친 문장 검사가 긴 이름부터 읽는 데 쓴다(questionHandoff.ts linkAfterEdit). */
  gone: CompetitorContext[];
  brandName: string;
  brandNames: string[];
  industry: string;
  region: string;
  language: QuestionLanguage;
}

/** 질문지 이름으로 쓰인 버전(은행 파일 · 이 고객 카드 · 저장소) — 새 버전은 이 이름을 피한다. */
function takenVersions(bankVersions: string[], history: WeeklyScorecard[], repo: TenantConfig | undefined): string[] {
  return [...bankVersions, ...history.map((c) => c.questionBankVersion).filter((v): v is string => Boolean(v)), ...(repo ? [repo.questionBankVersion] : [])];
}

function rewriteAllFor(
  tenant: TenantConfig,
  repo: TenantConfig | undefined,
  bank: QuestionBank | null,
  taken: string[],
  competitors: CompetitorContext[],
): RewriteAllPlan {
  const size = repo?.questionBankSize ?? tenant.questionBankSize;
  const shared = bank ? bank.questions.filter((q) => q.cohortShared).length : 0;
  const brandCount = Math.max(0, size - shared);
  const fromVersion = tenant.questionBankVersion;
  const toVersion = nextBankVersion(fromVersion, [...taken, fromVersion]);
  // 공통 질문이 그대로인 경우에만 연다 — 코호트 질문지가 없으면 측정이 일반 질문까지 새로 만들고(pipeline.ts), 코호트가
  // 바뀌었으면 공통 질문도 다른 코호트 것이 된다. 은행 파일이 없으면 다음 측정이 이미 새 목록으로 만든다.
  const reason = !tenant.cohortQuestionBank
    ? '코호트 공통 질문지를 쓰지 않는 브랜드라 새로 쓰면 공통 질문까지 바뀌어요.'
    : !bank
      ? '질문지가 아직 없어요 — 다음 측정이 새 목록으로 만들어요.'
      : bank.cohortBank?.key !== cohortKey(tenant.industry, tenant.region) || bank.cohortBank?.version !== tenant.cohortQuestionBank
        ? '코호트(업종 · 지역)가 바뀌어 새로 쓰면 공통 질문도 바뀌어요.'
        : brandCount < 1
          ? '브랜드 질문 자리가 없어요(문항 수가 공통 질문 수와 같아요).'
          : null;
  const key = createHash('sha1')
    .update(JSON.stringify({ fromVersion, toVersion, size, list: competitors.map((c) => [c.name, c.aliases ?? []]) }))
    .digest('hex')
    .slice(0, 16);
  return { available: !reason, reason, fromVersion, toVersion, size, brandCount, key };
}

const measuredFlags = (rows: EditorCompetitorRow[], length: number) => {
  const flags = Array.from({ length }, () => false);
  for (const r of rows) if (r.status === 'measured') flags[r.index] = true;
  return flags;
};

async function computePlan(
  tenant: TenantConfig,
  runtime: TenantConfig[],
  store: ResultStore,
  input: unknown,
  pastOutRaw?: unknown,
  handoffRaw?: unknown,
  options: PlanOptions = {},
): Promise<{ plan: EditPlan; exclusion: ExclusionChange | null; rewrite: QuestionRewriteContext; repo: TenantConfig | undefined }> {
  const pastOut = parsePastOut(pastOutRaw);
  const hints = parseHints(handoffRaw);
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
  const [now, next, repo, bankVersions] = await Promise.all([
    describeRows(ctx, tenant.competitors),
    describeRows(ctx, competitors),
    loadTenantWithoutCompetitorEdit(tenant.tenantId),
    store.listQuestionBankVersions(tenant.tenantId),
  ]);
  const unchanged = sameList(competitors, tenant.competitors);
  const brandNames = [tenant.brandName, ...tenant.aliases];
  const taken = takenVersions(bankVersions, ctx.history, repo);
  // 빠지는 경쟁사의 질문을 누가 받는가. 저장소 목록으로 돌아가는 저장은 앱 수정본을 지우므로(saveEdit) 질문지도 저장소
  // 버전으로 돌아간다. 새 버전 이름은 은행 파일 · 이 고객 카드 · 저장소가 쓴 이름을 피한다.
  const questions = planQuestionHandoff({
    bank: ctx.bank,
    version: tenant.questionBankVersion,
    brandNames,
    backToRepo: Boolean(repo && !unchanged && sameList(competitors, repo.competitors)),
    repoVersion: repo?.questionBankVersion ?? tenant.questionBankVersion,
    now: { competitors: tenant.competitors, measured: measuredFlags(now.rows, tenant.competitors.length) },
    next: { competitors, measured: measuredFlags(next.rows, competitors.length) },
    hints,
    taken,
    otherIndustry: competitors.filter((c) => industryOf(ctx, c.name)?.verdict === 'different').map((c) => c.name),
    ...(options.existingReceivers === false ? { existingReceivers: false } : {}),
  });
  // 저장한 뒤에도 비교 질문이 없는 곳 — 빠지는 질문은 세지 않고 넘겨받은 질문은 센다. 「질문지 그대로 두기」면 질문지가 그대로라
  // 넘겨받기 없이 지금 질문으로만 센다.
  const receiving = new Set(questions.receivers.map((r) => fold(r.name)));
  const dropped = new Set(questions.items.filter((i) => i.action === 'remove').map((i) => i.fromId));
  const askable = next.rows.filter((r) => r.status === 'measured' && r.industry?.verdict !== 'different');
  const noQuestion = askable
    .filter((r) => !r.questionIds.some((id) => !dropped.has(id)) && !receiving.has(fold(r.name)))
    .map((r) => r.name);
  const noQuestionKept = askable.filter((r) => !r.questionIds.length).map((r) => r.name);
  const nextMeasured = new Set(next.rows.filter((r) => r.status === 'measured').map((r) => r.targetTenantId));
  const week = getIsoWeekString(new Date());
  const leaving = now.rows
    .filter((r) => r.status === 'measured' && !nextMeasured.has(r.targetTenantId))
    .map((r) => ({ name: r.name, tenantId: r.targetTenantId, questionIds: r.questionIds, thisWeek: r.latest?.weekOf === week }));

  for (const l of leaving) {
    if (l.thisWeek) {
      notes.push(`이번 주(${shortWeek(week)})에 다시 재도 ${l.name}의 ${shortWeek(week)} 기록은 순위표에 남아요 — 「${shortWeek(week)} 기록만 빼기」로 뺄 수 있어요.`);
    }
  }
  // 같은 경쟁사인데 홈페이지가 바뀌어 측정 id가 달라지면 지난 기록과 이어지지 않는다 — 저장 전에 알린다.
  const nowByName = new Map(now.rows.map((r) => [squash(r.name), r]));
  for (const r of next.rows) {
    const was = nowByName.get(squash(r.name));
    const oldId = was?.targetTenantId ?? was?.draftId;
    const newId = r.targetTenantId ?? r.draftId;
    if (!was || !oldId || !newId || oldId === newId) continue;
    notes.push(
      was.cohortWeeks > 0
        ? `${r.name}: 홈페이지를 바꾸면 측정 id가 ${oldId} → ${directionParticle(newId)} 바뀌어 지난 기록(${was.cohortWeeks}주)과 이어지지 않아요.`
        : `${r.name}: 홈페이지를 바꾸면 측정 id가 ${oldId} → ${directionParticle(newId)} 바뀌어요.`,
    );
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
  const exclusion = pastOut ? await planExclusion(ctx, next.rows, pastOut, errors, notes) : null;
  return {
    plan: {
      ...next,
      competitors,
      droppedHosts: normalized.droppedHosts,
      leaving,
      notes,
      errors,
      unchanged,
      measuring: measureInFlight(),
      exclusion: exclusion?.preview ?? null,
      questions,
      rewriteAll: rewriteAllFor(tenant, repo, ctx.bank, taken, competitors),
      noQuestion,
      noQuestionKept,
    },
    exclusion: exclusion && exclusion.preview.items.length ? exclusion : null,
    rewrite: {
      plan: questions,
      bank: ctx.bank,
      next: competitors,
      gone: tenant.competitors.filter((c) => !competitors.some((x) => fold(x.name) === fold(c.name))),
      brandName: tenant.brandName,
      brandNames,
      industry: tenant.industry,
      region: tenant.region,
      language: tenant.questionLanguage ?? 'ko',
    },
    repo,
  };
}

/**
 * 고쳐 쓰기(POST /competitors/questions)가 쓸 계획 — 서랍이 미리 본 계획(key)과 같아야 한다. 측정 중에는 고쳐 쓰지 않는다
 * (판정 엔진을 측정과 나눠 쓴다 · 결정 D8).
 */
export async function questionRewriteContext(tenantId: string, store: ResultStore, body: unknown): Promise<QuestionRewriteContext> {
  if (measureInFlight()) throw new EditorError(409, '측정이 진행 중이에요. 끝난 뒤에 고쳐 써 주세요.');
  const { tenant, runtime } = await customerTenant(tenantId);
  const raw = (body ?? {}) as { competitors?: unknown; handoff?: unknown; key?: unknown };
  const { plan, rewrite } = await computePlan(tenant, runtime, store, raw.competitors, undefined, raw.handoff);
  if (plan.errors.length) throw new EditorError(400, plan.errors.join(' '));
  if (raw.key !== plan.questions.key) throw new EditorError(409, '그사이 질문지나 목록이 바뀌었어요. 서랍을 다시 열어 주세요.');
  return rewrite;
}

/**
 * 저장 요청의 질문지 방식 — derive(바뀐 경쟁사 질문만 고치기, 기본) · all(브랜드 질문 모두 새로 쓰기) · keep(질문지 그대로 두기).
 * 없으면 derive다(고객 전환의 「목록에서 빼기」처럼 방식 없이 부르는 곳이 있다).
 */
function parseQuestionMode(raw: unknown): 'derive' | 'all' | 'keep' {
  const mode = (raw as { mode?: unknown } | null | undefined)?.mode;
  if (mode === undefined || mode === null || mode === 'derive') return 'derive';
  if (mode === 'all' || mode === 'keep') return mode;
  throw new EditorError(400, `질문지 방식을 알아볼 수 없습니다: ${String(mode)}`);
}

/**
 * 저장할 새 은행 — 화면이 보낸 고친 문장(미리 본 그대로)으로 만든다. 판정 엔진은 부르지 않는다. 계획이 미리 본 것과 다르거나
 * 문장이 검사를 통과하지 못하면 거절한다(미리 본 것 = 저장되는 것).
 */
function derivedBankFor(rewrite: QuestionRewriteContext, repo: TenantConfig, raw: unknown, now: string): QuestionBank {
  const { plan, bank } = rewrite;
  if (!bank) throw new EditorError(409, '질문지 파일이 없어요. 서랍을 다시 열어 주세요.');
  const body = (raw ?? {}) as { key?: unknown; drafts?: unknown };
  if (body.key !== plan.key) throw new EditorError(409, '그사이 질문지나 목록이 바뀌었어요 — 고쳐 쓴 질문을 다시 확인한 뒤 저장해 주세요.');
  const rewrites = plan.items.filter((i) => i.action === 'rewrite');
  const drafts = new Map<string, RewriteDraft>();
  for (const d of Array.isArray(body.drafts) ? body.drafts : []) {
    const x = (d ?? {}) as { fromId?: unknown; text?: unknown; topic?: unknown };
    if (typeof x.fromId !== 'string' || typeof x.text !== 'string' || (x.topic !== undefined && typeof x.topic !== 'string')) {
      throw new EditorError(400, '고쳐 쓴 질문이 올바르지 않습니다.');
    }
    drafts.set(x.fromId, { text: x.text, ...(x.topic ? { topic: x.topic } : {}) });
  }
  if (drafts.size !== rewrites.length || rewrites.some((i) => !drafts.has(i.fromId))) {
    throw new EditorError(400, '고쳐 쓴 질문이 넘겨받을 질문과 맞지 않아요. 다시 고쳐 써 주세요.');
  }
  for (const item of rewrites) {
    const d = drafts.get(item.fromId)!;
    const others = [
      ...bank.questions.filter((q) => q.questionId !== item.fromId).map((q) => q.text),
      ...[...drafts.entries()].filter(([id]) => id !== item.fromId).map(([, x]) => x.text),
    ];
    const checked = checkRewrite(d.text, d.topic, {
      item,
      brandNames: rewrite.brandNames,
      language: rewrite.language,
      next: rewrite.next,
      gone: rewrite.gone,
      otherTexts: others,
    });
    if (checked.reasons.length) throw new EditorError(400, `${item.fromId}: ${checked.reasons.join(' · ')}`);
    // 고쳐 쓰기가 정리해 돌려준 문장 · 주제 그대로여야 한다 — 저장이 다시 다듬으면 미리 본 것과 달라진다.
    if (checked.text !== d.text || (checked.topic ?? '') !== (d.topic ?? '')) {
      throw new EditorError(400, `${item.fromId}: 미리 본 문장과 달라요. 다시 고쳐 써 주세요.`);
    }
  }
  const derived = deriveQuestionBank(bank, plan, drafts, { now, base: baseFingerprint(repo) });
  // 만든 은행을 다시 잇는다 — 고친 질문은 받을 곳에만, 남은 질문은 나간 곳에 이어지지 않아야 한다. 고친 문장 검사(R4 · R5)와 같은
  // 함수로 잇는다 — 나간 이름이 남는 · 받는 곳 이름 안에 들어 있어도(초원 / 초원고택) 남는 이름으로 읽는다.
  const outgoing = [...new Map(plan.items.flatMap((i) => i.swaps.map((s) => [fold(s.from.name), s.from] as const))).values()];
  const relinked = new Map(linkAfterEdit(derived.questions, rewrite.next, rewrite.gone, outgoing, rewrite.brandNames).map((l) => [l.questionId, l]));
  const ids = derived.questions.map((q) => q.questionId);
  const problems = [
    ...rewrites
      .filter((i) => relinked.get(i.toId!)?.nextIndexes.join() !== i.expectedIndexes.join())
      .map((i) => `${i.toId}: 넘겨받을 경쟁사에 이어지지 않아요`),
    ...[...relinked.values()].filter((l) => l.outgoingHit).map((l) => `${l.questionId}: 빠지는 경쟁사를 계속 물어요`),
    ...(new Set(ids).size !== ids.length ? ['질문 id가 겹쳐요'] : []),
    ...(derived.questions.length !== plan.sizeAfter ? [`문항 수가 ${plan.sizeAfter}개가 아니에요`] : []),
    // 코호트 질문지를 쓰지 않는 은행은 측정이 일반 질문 하한을 다시 맞추며 은행을 고쳐 쓴다 — 하한 아래로 내려가면 안 된다.
    ...(!repo.cohortQuestionBank && countAgnostic(derived.questions) < agnosticQuota(plan.sizeAfter) ? ['일반 질문이 하한보다 적어져요'] : []),
  ];
  if (problems.length) throw new EditorError(400, `새 질문지를 만들 수 없어요: ${problems.join(' · ')}`);
  return derived;
}

/** 제외 목록을 바꾸고 그 주차 순위를 다시 센다. 반대 방향(되돌리기 · 실패 보상)도 같은 함수로 한다. */
async function writeExclusion(store: ResultStore, change: { add: CohortExclusion[]; removed: CohortExclusion[] }): Promise<void> {
  await updateCohortExclusions((entries) => {
    const present = new Set(entries.map((e) => e.id));
    // 되살릴 항목이 이미 있으면 다시 넣지 않는다(같은 id가 둘이 되지 않게).
    return applyExclusionChanges(entries, { add: change.add.filter((e) => !present.has(e.id)), removeIds: change.removed.map((e) => e.id) });
  });
  const weeks = await affectedCohortWeeks(store, [...change.add, ...change.removed]);
  for (const k of weeks) await reconcileCohortRanks(store, k.industry, k.region, k.weekOf);
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

/**
 * 바꾼 목록을 저장한다. 다음 측정부터 이 목록으로 잰다. 「지난 기록에서도 빼기」 · 「다시 세기」가 있으면 제외 목록을 고치고 그
 * 주차 순위를 다시 센다 — 미리 본 결과(previewKey)와 지금 계산이 다르면 409(그 사이 측정 등으로 순위가 바뀌었다).
 */
export function saveEdit(tenantId: string, store: ResultStore, body: unknown): Promise<CompetitorEditorState> {
  return serializeEdit(async () => {
    assertNotMeasuring();
    const { tenant, runtime } = await customerTenant(tenantId);
    const raw = (body ?? {}) as { competitors?: unknown; summary?: unknown; pastOut?: unknown; previewKey?: unknown; handoff?: unknown; questions?: unknown };
    // 고친 문장 없이 부르는 곳(고객 전환)은 「새로 든 곳만 받기」로 계획한다 — 미리 본 계획과 같은 선택으로 다시 센다.
    const incomingOnly = (raw.questions as { receivers?: unknown } | null | undefined)?.receivers === 'incoming';
    const { plan, exclusion, rewrite, repo } = await computePlan(tenant, runtime, store, raw.competitors, raw.pastOut, raw.handoff, {
      ...(incomingOnly ? { existingReceivers: false } : {}),
    });
    if (plan.errors.length) throw new EditorError(400, plan.errors.join(' '));
    const questionMode = parseQuestionMode(raw.questions);
    const rewriteAll = questionMode === 'all';
    // 질문지만 새로 쓰는 저장(목록 그대로)도 저장이다(결정 E2 — 이미 재는 곳에 비교 질문이 없을 때).
    if (plan.unchanged && !exclusion && !rewriteAll) throw new EditorError(400, '바뀐 내용이 없어요.');
    if (rewriteAll) {
      if (!plan.rewriteAll.available) throw new EditorError(400, plan.rewriteAll.reason ?? '질문지를 새로 쓸 수 없어요.');
      if ((raw.questions as { key?: unknown }).key !== plan.rewriteAll.key) {
        throw new EditorError(409, '그사이 질문지나 목록이 바뀌었어요 — 다시 확인한 뒤 저장해 주세요.');
      }
    }
    // 「질문지 그대로 두기」는 고칠 질문이 있을 때만 뜻이 있다 — 미리 본 계획(빠지는 경쟁사를 계속 묻는 질문)과 같아야 한다.
    const keep = questionMode === 'keep' && plan.questions.mode === 'derive';
    if (keep && (raw.questions as { key?: unknown }).key !== plan.questions.key) {
      throw new EditorError(409, '그사이 질문지나 목록이 바뀌었어요 — 다시 확인한 뒤 저장해 주세요.');
    }
    if (exclusion) {
      const locked = exclusion.preview.locked;
      if (locked.length) {
        throw new EditorError(409, `${locked.map((l) => `${l.brandName}(${l.by.join(', ')}도 재요)`).join(', ')}: 다른 고객 브랜드가 함께 재는 경쟁사라 지난 기록에서 뺄 수 없어요.`);
      }
      if (raw.previewKey !== exclusion.preview.key) throw new EditorError(409, '그사이 순위가 바뀌었어요. 미리보기를 다시 확인한 뒤 저장해 주세요.');
    }
    if (!repo) throw new EditorError(404, `tenant not found: ${tenantId}`);
    const competitors = plan.competitors;
    const savedAt = new Date().toISOString();
    const newBank = plan.questions.mode === 'derive' && questionMode === 'derive' ? derivedBankFor(rewrite, repo, raw.questions, savedAt) : null;
    const file = await readCompetitorOverride(tenantId);
    // 「모두 새로 쓰기」를 저장하고 아직 재지 않았다(그 버전 파일이 없다) — 그 뒤의 저장(추가 · 바꾸기 · 그대로 두기 · 고객 전환)도
    // 새로 쓸 표시를 잇는다. 빠뜨리면 다음 측정이 그 버전을 표시 없이 만들어 저장소 질문지를 고친 것으로 보는 검사가 놓친다.
    const pendingQb = file?.current && overrideApplies(file.current, repo) ? file.current.questionBank : undefined;
    const pendingRegenerate =
      pendingQb?.regenerate && pendingQb.version === tenant.questionBankVersion && plan.questions.mode === 'fresh' ? pendingQb : undefined;
    // 수정본의 질문지 — 새로 만들었으면 그 버전, 모두 새로 쓰면 다음 버전 이름만(은행은 다음 측정이 만든다), 아니면 지금 쓰는 앱
    // 질문지를 그대로 잇는다(빠뜨리면 저장소 버전으로 떨어져 목록과 질문지가 어긋난다).
    const questionBank: CompetitorOverride['questionBank'] = newBank
      ? { version: newBank.version, size: newBank.questions.length }
      : rewriteAll
        ? { version: plan.rewriteAll.toVersion, size: plan.rewriteAll.size, regenerate: { from: plan.rewriteAll.fromVersion, base: baseFingerprint(repo) } }
        : pendingRegenerate
          ? { version: pendingRegenerate.version, size: pendingRegenerate.size, regenerate: pendingRegenerate.regenerate }
          : tenant.questionBankVersion !== repo.questionBankVersion
            ? { version: tenant.questionBankVersion, size: tenant.questionBankSize }
            : undefined;
    // 지난 기록만 바꾼 저장이면 되돌려도 목록은 그대로다(쓰이지 않는 옛 목록도 지우지 않게 파일 값 그대로).
    const pastOnly = plan.unchanged && !rewriteAll;
    const before = pastOnly ? (file?.current ?? null) : overrideApplies(file?.current ?? null, repo) ? file!.current : null;
    // 저장소 설정과 같아지면 고친 목록을 지운다 — 저장소 설정을 그대로 따른다. 다만 질문지를 새로 쓰면 저장소 목록이라도
    // 수정본을 남긴다(새 버전을 적을 곳이 수정본뿐이다). 목록을 그대로 두고 지난 기록만 바꾸면 파일의 목록도 그대로 둔다
    // (저장소 설정이 바뀌어 쓰이지 않는 옛 목록도 지우지 않는다).
    const current: CompetitorOverride | null = pastOnly
      ? (file?.current ?? null)
      : sameList(competitors, repo.competitors) && !rewriteAll
        ? null
        : { competitors, base: baseFingerprint(repo), ...(questionBank ? { questionBank } : {}) };
    const summary = typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary.trim().slice(0, 300) : '경쟁사 목록을 바꿨어요';
    // 처음 고칠 때는 지금 목록 · 질문지가 마지막 측정이 쓴 것이다 — 「다음 측정 대기」를 그것과 견준다. 질문지 버전은 마지막
    // 카드의 것(없으면 지금 버전)을 적는다 — 질문지만 새로 쓴 저장도 대기로 보이게.
    const lastCard = (await store.getScorecardHistory(tenantId, 1)).at(-1);
    const measured = file?.measured
      ? { ...file.measured, bankVersion: file.measured.bankVersion ?? lastCard?.questionBankVersion ?? tenant.questionBankVersion }
      : { at: null, listHash: listHash(tenant.competitors), bankVersion: lastCard?.questionBankVersion ?? tenant.questionBankVersion };
    assertNotMeasuring(); // 위에서 기다리는 동안 측정이 시작됐을 수 있다 — 쓰기 직전에 다시 본다.
    const exclusions = exclusion ? { added: exclusion.add, removed: exclusion.removed } : undefined;
    // 지난 기록만 바꾼 저장이면 직전 목록 저장의 설명을 이어 둔다 — 「경쟁사 바뀜 · 다음 측정 대기」가 제외 요약을 보이지 않게.
    const list = pastOnly && file?.lastSave ? listSaveInfo(file) : undefined;
    let createdBank: string | null = null;
    try {
      // 새 질문지 → 제외 목록 · 순위 다시 세기 → 수정본 순서로 쓴다. 새 질문지가 수정본보다 먼저다 — 수정본이 가리키는 버전
      // 파일이 없으면 다음 측정이 그 버전을 판정 엔진으로 새로 만들어 미리 본 질문과 달라진다. 어느 단계든 실패하면 앞 단계를
      // 되돌린다(제외 목록은 반대로 다시 불러도 같은 결과다) — 되돌릴 기록 없는 제외, 일부만 다시 쓴 순위, 아무도 안 쓰는
      // 질문지가 남지 않게.
      if (newBank) {
        await store.createQuestionBank(tenantId, newBank);
        createdBank = newBank.version;
      }
      if (exclusions) await writeExclusion(store, { add: exclusions.added, removed: exclusions.removed });
      await writeCompetitorOverride(tenantId, {
        current,
        lastSave: {
          savedAt,
          before,
          summary,
          ...(exclusions ? { exclusions } : {}),
          ...(pastOnly ? { listUnchanged: true as const } : {}),
          ...(list ? { list } : {}),
        },
        measured,
      });
    } catch (err) {
      if (exclusions) {
        await writeExclusion(store, { add: exclusions.removed, removed: exclusions.added }).catch((undoErr: unknown) =>
          console.error(`[competitorEditor] ${tenantId} 제외 목록 되돌리기 실패:`, undoErr),
        );
      }
      if (createdBank) {
        const version = createdBank;
        await store.removeQuestionBank(tenantId, version).catch((undoErr: unknown) =>
          console.error(`[competitorEditor] ${tenantId} 새 질문지 ${version} 지우기 실패:`, undoErr),
        );
      }
      throw err;
    }
    const after = await customerTenant(tenantId);
    return buildEditorState(after.tenant, after.runtime, store);
  });
}

/** 마지막 저장을 되돌린다 — 그 뒤 이 브랜드를 쟀으면 안 된다. */
export function undoEdit(tenantId: string, store: ResultStore): Promise<CompetitorEditorState> {
  return serializeEdit(async () => {
    assertNotMeasuring();
    const { tenant, runtime } = await customerTenant(tenantId);
    const file = await readCompetitorOverride(tenantId);
    if (!file?.lastSave) throw new EditorError(409, '되돌릴 저장이 없어요.');
    if (!canUndo(file, tenant.competitors)) {
      throw new EditorError(409, '저장한 뒤 이 목록으로 이미 측정해서 되돌릴 수 없어요. 경쟁사를 다시 바꿔 저장해 주세요.');
    }
    // 그 저장이 지난 기록에서 뺀 · 되살린 항목도 반대로 돌린다(순위를 다시 센다). 「다시 세기」를 되돌리면 다시 빼게 되는데,
    // 그사이 다른 고객이 그 경쟁사를 함께 재게 됐으면 막는다(빼기와 같은 잠금 규칙).
    const ex = file.lastSave.exclusions;
    if (ex?.removed.length) {
      const ctx = await loadContext(tenant, runtime, store);
      const locked = ex.removed.filter((e) => ctx.othersMeasuring.has(e.tenantId));
      if (locked.length) {
        throw new EditorError(
          409,
          `${locked.map((e) => `${e.brandName}(${ctx.othersMeasuring.get(e.tenantId)!.join(', ')}도 재요)`).join(', ')}: 다른 고객 브랜드가 함께 재는 경쟁사가 됐어요 — 지난 기록에서 다시 뺄 수 없어 되돌릴 수 없어요.`,
        );
      }
    }
    assertNotMeasuring();
    if (ex) await writeExclusion(store, { add: ex.removed, removed: ex.added });
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

/** 업종 확인 · 표시의 응답 — 서랍의 줄 칩이 쓴다. verdict null이면 모른다(칩 없음). */
export interface IndustryResult {
  name: string;
  verdict: 'same' | 'different' | null;
  looksLike: string | null;
  reason: string | null;
  by: 'ai' | 'person' | null;
  /** 확인하지 못한 이유(저장하지 않았다) — 다음에 다시 확인한다. */
  error?: string;
}

function industryInput(body: unknown): CompetitorContext {
  const x = (body ?? {}) as { name?: unknown; aliases?: unknown; domains?: unknown };
  const name = typeof x.name === 'string' ? x.name.trim().slice(0, 80) : '';
  if (!name) throw new EditorError(400, '경쟁사 이름이 비어 있습니다.');
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((a): a is string => typeof a === 'string' && a.trim().length > 0).map((a) => a.trim()) : []);
  const aliases = strings(x.aliases);
  return { name, aliases: aliases.length ? aliases : [name], domains: strings(x.domains) };
}

function industryResult(name: string, entry: CompetitorIndustryEntry | undefined, customerIndustry: string, error?: string): IndustryResult {
  const mark = effectiveIndustry(entry, customerIndustry);
  return {
    name,
    verdict: mark?.verdict ?? null,
    looksLike: mark?.looksLike ?? entry?.ai?.looksLike ?? null,
    reason: entry?.ai?.reason ?? null,
    by: mark?.by ?? null,
    ...(error ? { error } : {}),
  };
}

/**
 * 「업종 다름」 확인 — 경쟁사를 추가하거나 새 이름으로 바꿀 때 서랍이 부른다(결정 7 · F2: 측정 중에도 한다). 이미 본 이름이면 다시
 * 묻지 않는다(사람이 정한 값 · 지금 고객 업종으로 본 AI 판정). 엔진 오류는 저장하지 않고 error로 돌려준다(칩 없음).
 */
export async function checkEditorIndustry(tenantId: string, body: unknown, client: () => EngineClient): Promise<IndustryResult> {
  if (process.env.VERCEL) throw new EditorError(501, '경쟁사 업종 확인은 데스크톱 앱에서만 할 수 있어요.');
  const { tenant, runtime } = await customerTenant(tenantId);
  const competitor = industryInput(body);
  const key = industryKey(competitor.name);
  const entries = await readCompetitorIndustry(tenantId);
  const cached = entries[key];
  if (cached?.person || (cached?.ai && cached.ai.customerIndustry === tenant.industry)) return industryResult(competitor.name, cached, tenant.industry);
  let check;
  try {
    // 엔진은 부를 때 만든다 — 규칙으로 정하는 이름(업종 접미사 · 등록 고객)은 엔진 키가 없어도 정해야 한다.
    const lazy: EngineClient = { call: (prompt) => client().call(prompt) };
    check = await checkCompetitorIndustry(tenant, competitor, { client: lazy, engine: 'gemini', runtime });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[competitorEditor] ${tenantId} · ${competitor.name} 업종 확인 실패: ${message}`);
    return industryResult(competitor.name, cached, tenant.industry, message);
  }
  const next = await updateCompetitorIndustry(tenantId, (all) => ({
    ...all,
    [key]: {
      ...all[key],
      name: competitor.name,
      ai: { ...check, customerIndustry: tenant.industry, at: new Date().toISOString() },
    },
  }));
  return industryResult(competitor.name, next[key], tenant.industry);
}

/**
 * 사람이 정한 업종 — 「{업종} 맞음」(same) · 「업종 다름으로 표시」(different) · null(사람 표시 지우기). 바로 쓴다(저장 · 되돌리기 대상이
 * 아니다, 결정 F4). 측정 중에도 된다(측정은 이 값을 보지 않는다).
 */
export async function markEditorIndustry(tenantId: string, body: unknown): Promise<IndustryResult> {
  if (process.env.VERCEL) throw new EditorError(501, '경쟁사 업종 표시는 데스크톱 앱에서만 바꿀 수 있어요.');
  const { tenant } = await customerTenant(tenantId);
  const competitor = industryInput(body);
  const mark = (body as { mark?: unknown } | null)?.mark;
  if (mark !== 'same' && mark !== 'different' && mark !== null) throw new EditorError(400, '업종 표시는 same · different · null 중 하나여야 합니다.');
  const key = industryKey(competitor.name);
  const next = await updateCompetitorIndustry(tenantId, (all) => {
    const entry: CompetitorIndustryEntry = { ...all[key], name: competitor.name };
    if (mark) entry.person = { mark, at: new Date().toISOString() };
    else delete entry.person;
    return { ...all, [key]: entry };
  });
  return industryResult(competitor.name, next[key], tenant.industry);
}

/** 마지막 측정과 질문지 버전이 다르고, 그 버전을 쓰이는 수정본이 골랐다(질문지만 새로 쓴 저장 · 넘겨받기로 만든 버전). */
async function bankChosenByEdit(file: CompetitorOverrideFile, tenant: TenantConfig): Promise<boolean> {
  const measured = file.measured?.bankVersion;
  if (!measured || measured === tenant.questionBankVersion) return false;
  if (!file.current?.questionBank || file.current.questionBank.version !== tenant.questionBankVersion) return false;
  const repo = await loadTenantWithoutCompetitorEdit(tenant.tenantId);
  return Boolean(repo && overrideApplies(file.current, repo));
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
  // 목록도 질문지도 마지막 측정과 같으면 대기가 아니다(질문지 버전을 적기 전의 기록은 목록만 본다). 질문지 버전은 앱이 고른
  // 것(쓰이는 수정본이 적은 버전)만 센다 — 저장소 설정이 질문지 버전을 올린 것은 경쟁사 편집이 아니다.
  const listChanged = file.measured.listHash !== listHash(tenant.competitors);
  if (!listChanged && !(await bankChosenByEdit(file, tenant))) return null;
  const info = listSaveInfo(file);
  return { savedAt: info?.savedAt ?? file.updatedAt, summary: info?.summary ?? '경쟁사 목록을 바꿨어요' };
}
