import { planCohortTargets, type CompetitorPlanStatus } from './cohortPlan.js';
import { linkCompetitorQuestions } from './competitorQuestions.js';
import { listActiveMeasures } from './measureTracker.js';
import { readDeletedTenants } from './tenantTombstone.js';
import type { WeeklyScorecard } from '../src/prompts/b8-report.js';
import type { ResultStore } from './store.js';
import type { TenantConfig } from './types.js';

/**
 * 경쟁사 편집 서랍의 처음 상태(상용화 UI 11차). 읽기만 한다 — 저장된 설정·점수 기록·질문지를 모은다.
 *
 * 「함께 측정 5/5 · 대기」는 측정이 쓰는 planCohortTargets 그대로다. 화면이 경쟁사 순서로 세면 칸 안의
 * 충돌·중복 때문에 실제 측정과 어긋난다(cohortPlan.ts 순서 주석).
 */

export interface EditorCompetitorRow {
  /** 설정(tenant.competitors)에서의 위치. 측정 순서다. */
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
  /** 이 코호트(업종·지역)에서의 마지막 카드. 한 번도 안 쟀으면 null. */
  latest: { weekOf: string; score: number; mentionRate: number; brandOwnedCitationRate: number } | null;
  /** 이 경쟁사를 짚은 브랜드 질문 id(다음 측정에 쓸 질문지 기준). */
  questionIds: string[];
}

export interface EditorPastCompetitor {
  tenantId: string;
  brandName: string;
  /** 이 고객의 코호트에 카드가 있는 주차 수와 마지막 주차. */
  weeks: number;
  lastWeekOf: string;
  lastScore: number;
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
  rows: EditorCompetitorRow[];
  /** 이 고객의 지난 코호트에 끼어 있었지만 지금 목록에는 없는 경쟁사(예전 경쟁사). */
  past: EditorPastCompetitor[];
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
  /** 진행 중인 로컬 측정이 있다. */
  measuring: boolean;
}

function latestIn(history: WeeklyScorecard[], industry: string, region: string): EditorCompetitorRow['latest'] {
  const card = history.filter((c) => c.industry === industry && c.region === region).at(-1);
  return card
    ? {
        weekOf: card.weekOf,
        score: card.aeoScore.current,
        mentionRate: card.mentionRate,
        brandOwnedCitationRate: card.brandOwnedCitationRate,
      }
    : null;
}

export async function buildEditorState(
  tenant: TenantConfig,
  runtime: TenantConfig[],
  store: ResultStore,
): Promise<CompetitorEditorState> {
  const plan = planCohortTargets(tenant, runtime);
  const [history, deleted, bank] = await Promise.all([
    store.getScorecardHistory(tenant.tenantId, Number.MAX_SAFE_INTEGER),
    readDeletedTenants(),
    store.getQuestionBank(tenant.tenantId, tenant.questionBankVersion),
  ]);
  const deletedIds = new Set(deleted);
  const last = history.at(-1) ?? null;
  // 코호트는 점수 기록의 업종·지역이다(영어 질문 측정은 지역에 꼬리표가 붙는다). 측정 전이면 설정값.
  const industry = last?.industry ?? tenant.industry;
  const region = last?.region ?? tenant.region;
  const customers = new Set(runtime.filter((t) => !t.cohortOnly).map((t) => t.tenantId));

  const links = bank
    ? linkCompetitorQuestions(bank.questions, tenant.competitors, [tenant.brandName, ...tenant.aliases])
    : null;

  const rows = await Promise.all(
    plan.entries.map(async (entry): Promise<EditorCompetitorRow> => {
      const competitor = tenant.competitors[entry.index];
      const id = entry.targetTenantId ?? entry.draftId;
      const competitorHistory = id ? await store.getScorecardHistory(id, Number.MAX_SAFE_INTEGER) : [];
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
        existingCustomer: Boolean(entry.existing && !entry.existing.cohortOnly && customers.has(entry.existing.tenantId)),
        collidesWith: entry.collidesWith ?? null,
        deleted: Boolean(id && deletedIds.has(id)),
        latest: latestIn(competitorHistory, industry, region),
        questionIds: links?.byCompetitor[entry.index] ?? [],
      };
    }),
  );

  // 예전 경쟁사: 이 고객이 측정된 주차마다 같은 코호트 카드를 보고, 지금 목록·고객 브랜드가 아닌 곳을 모은다.
  // 같은 코호트의 다른 고객이 지금 재는 경쟁사도 뺀다 — 이 고객이 뺀 곳이 아니다.
  const currentIds = new Set(rows.flatMap((r) => [r.targetTenantId, r.draftId]).filter((x): x is string => Boolean(x)));
  for (const other of runtime) {
    if (other.cohortOnly || other.tenantId === tenant.tenantId || other.industry !== tenant.industry || other.region !== tenant.region) continue;
    for (const e of planCohortTargets(other, runtime).entries) {
      if (e.targetTenantId) currentIds.add(e.targetTenantId);
      if (e.draftId) currentIds.add(e.draftId);
    }
  }
  const pastMap = new Map<string, EditorPastCompetitor>();
  for (const card of history) {
    const members = await store.getCohortScorecards(card.industry, card.region, card.weekOf);
    for (const m of members) {
      if (m.tenantId === tenant.tenantId || customers.has(m.tenantId) || currentIds.has(m.tenantId)) continue;
      const prev = pastMap.get(m.tenantId);
      const newer = !prev || m.weekOf >= prev.lastWeekOf;
      pastMap.set(m.tenantId, {
        tenantId: m.tenantId,
        brandName: newer ? m.brandName : prev.brandName,
        weeks: (prev?.weeks ?? 0) + 1,
        lastWeekOf: newer ? m.weekOf : prev.lastWeekOf,
        lastScore: newer ? m.aeoScore.current : prev.lastScore,
      });
    }
  }
  const past = [...pastMap.values()].sort((a, b) => b.lastWeekOf.localeCompare(a.lastWeekOf) || a.brandName.localeCompare(b.brandName, 'ko'));

  return {
    tenantId: tenant.tenantId,
    brandName: tenant.brandName,
    industry,
    region,
    cap: plan.cap,
    measuredCount: rows.filter((r) => r.status === 'measured').length,
    waitingCount: rows.filter((r) => r.status === 'waiting').length,
    blockedCount: rows.filter((r) => r.takesSlot && r.status !== 'measured').length,
    baseline: last
      ? {
          weekOf: last.weekOf,
          score: last.aeoScore.current,
          rank: last.cohortRank.position,
          totalTenants: last.cohortRank.totalTenants,
          tied: (last.cohortRank.tiedCount ?? 1) > 1,
        }
      : null,
    rows,
    past,
    questionBank: {
      version: tenant.questionBankVersion,
      exists: Boolean(bank),
      measuredVersion: last?.questionBankVersion ?? null,
      sharedCount: bank ? bank.questions.filter((q) => q.cohortShared).length : 0,
      brandCount: bank ? bank.questions.filter((q) => !q.cohortShared).length : 0,
    },
    measuring: listActiveMeasures().length > 0,
  };
}
