import { conditionChange } from '../src/lib/comparability.js';
import type { WeeklyScorecard } from '../src/prompts/b8-report.js';
import { getIsoWeekString } from '../src/prompts/isoWeek.js';
import type { ResultStore } from './store.js';
import type { TenantConfig } from './types.js';

/**
 * 브랜드 현황 — 등록한 고객 브랜드마다 마지막 측정과 코호트 상태를 한 번에 모은다(화면: 브랜드 현황).
 *
 * 브랜드가 30곳을 넘자 어느 코호트가 측정이 필요한지 볼 곳이 없었다. 2026-10-03 W40 점검(34곳 중 20곳
 * 재측정 필요)은 데이터 폴더를 손으로 훑어서 냈다. 그 점검을 여기 코드로 옮긴다.
 *
 * 질문지가 같은지는 정기진단 보고서의 「질문지 같음/다름」과 **같은 기준**이다 — 그 주 코호트 구성원들의
 * 일반 질문(브랜드 이름 없는 질문) 글이 같은 집합인지. 버전 이름(v4·v5)이 달라도 일반 질문이 같으면 같다.
 * 판정 호출은 없다 — 저장된 점수 기록과 질문지만 읽는다.
 */
export type PortfolioStatus = 'done' | 'stale' | 'diff' | 'unknown' | 'alone' | 'none';

export interface PortfolioRow {
  tenantId: string;
  brandName: string;
  industry: string;
  region: string;
  /** 등록한 경쟁사 수. */
  competitors: number;
  status: PortfolioStatus;
  /** 마지막으로 측정한 주차. 측정 전이면 null. */
  weekOf: string | null;
  score: number | null;
  rank: number | null;
  totalTenants: number | null;
  tied: boolean;
  /** 직전 측정과 같은 조건일 때만 점수 변화. */
  delta: number | null;
  /** 직전 측정과 조건이 달라 비교하지 않을 때 그 이유(예: 질문지). */
  changeReason: string | null;
}

export interface Portfolio {
  /** 오늘 날짜의 주차 — 「이번 주 완료」의 기준. */
  currentWeek: string;
  rows: PortfolioRow[];
}

/** 일반 질문 글 집합 — 보고서(src/lib/reviewReport.ts generalQuestionTexts)와 같은 기준. */
function generalTexts(bank: { questions: { category: string; text: string }[] } | null): Set<string> | null {
  if (!bank) return null;
  return new Set(bank.questions.filter((q) => q.category === 'category-agnostic').map((q) => q.text.trim()));
}

const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

export async function buildPortfolio(tenants: TenantConfig[], store: ResultStore, now = new Date()): Promise<Portfolio> {
  const currentWeek = getIsoWeekString(now);
  const bankCache = new Map<string, Promise<Set<string> | null>>();
  const textsOf = (card: WeeklyScorecard): Promise<Set<string> | null> => {
    const version = card.questionBankVersion;
    if (!version) return Promise.resolve(null);
    const key = `${card.tenantId}|${version}`;
    if (!bankCache.has(key)) bankCache.set(key, store.getQuestionBank(card.tenantId, version).then(generalTexts));
    return bankCache.get(key)!;
  };

  const rows = await Promise.all(
    tenants
      .filter((t) => !t.cohortOnly)
      .map(async (t): Promise<PortfolioRow> => {
        const base = {
          tenantId: t.tenantId,
          brandName: t.brandName,
          industry: t.industry,
          region: t.region,
          competitors: t.competitors.length,
        };
        const history = await store.getScorecardHistory(t.tenantId, Number.MAX_SAFE_INTEGER);
        const last = history.at(-1);
        if (!last) {
          return { ...base, status: 'none', weekOf: null, score: null, rank: null, totalTenants: null, tied: false, delta: null, changeReason: null };
        }
        const prev = history.length > 1 ? history[history.length - 2]! : null;
        const change = prev ? conditionChange(prev, last) : null;

        const members = await store.getCohortScorecards(last.industry, last.region, last.weekOf);
        let status: PortfolioStatus;
        if (members.length <= 1) status = 'alone';
        else {
          const mine = await textsOf(last);
          let diff = false;
          let unknown = false;
          for (const m of members) {
            if (m.tenantId === last.tenantId) continue;
            const theirs = await textsOf(m);
            if (!mine || !theirs) unknown = true;
            else if (!sameSet(mine, theirs)) diff = true;
          }
          status = diff ? 'diff' : unknown ? 'unknown' : last.weekOf === currentWeek ? 'done' : 'stale';
        }

        return {
          ...base,
          // 점수 기록의 업종·지역이 이 브랜드가 실제로 속한 코호트다(영어 질문 측정은 지역에 꼬리표가 붙는다).
          industry: last.industry,
          region: last.region,
          status,
          weekOf: last.weekOf,
          score: last.aeoScore.current,
          rank: last.cohortRank.position,
          totalTenants: last.cohortRank.totalTenants,
          tied: (last.cohortRank.tiedCount ?? 1) > 1,
          delta: prev && !change ? last.aeoScore.current - prev.aeoScore.current : null,
          changeReason: change,
        };
      }),
  );
  return { currentWeek, rows };
}
