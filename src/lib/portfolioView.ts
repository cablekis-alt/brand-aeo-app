import type { CohortMember, PortfolioCohort, PortfolioRow, PortfolioStatus } from './api'
import { groupOrder, industryGroupOf } from './industryGroups'

/*
 * 브랜드 현황(pages/Portfolio.tsx)과 브랜드 바꾸기 패널(components/BrandSwitcher.tsx)이 함께 쓰는
 * 묶음·상태 규칙. 두 곳이 같은 브랜드를 다른 순서나 다른 말로 보여 주지 않게 여기 한 벌만 둔다.
 */

/** 측정이 필요한 상태 — 질문지가 다르거나 기록이 없거나, 같은 질문지지만 이번 주에 재지 않았거나, 아직 안 쟀다. */
export const NEEDS_MEASURE: PortfolioStatus[] = ['diff', 'unknown', 'stale', 'none']

export function needsMeasure(r: Pick<PortfolioRow, 'status'>): boolean {
  return NEEDS_MEASURE.includes(r.status)
}

const shortWeek = (weekOf: string | null) => weekOf?.replace(/^\d{4}-/, '') ?? ''

export function statusTone(status: PortfolioStatus): string {
  if (status === 'done') return 'good'
  if (status === 'alone') return 'info'
  if (status === 'none') return ''
  return 'warn'
}

/** 브랜드 현황 화면의 상태 칩 문구. */
export function statusChip(r: PortfolioRow): { text: string; tone: string } {
  const week = shortWeek(r.weekOf)
  const text = {
    done: `${week} 완료`,
    stale: `측정 오래됨 · ${week}`,
    diff: '측정 필요 · 질문지 다름',
    unknown: '측정 필요 · 질문지 기록 없음',
    alone: '경쟁사 미측정',
    none: '측정 전',
  }[r.status]
  return { text, tone: statusTone(r.status) }
}

/** 브랜드 바꾸기 패널의 짧은 상태 문구 — 마지막 측정 주차를 앞에 붙인다. */
export function statusShort(r: PortfolioRow): string {
  const week = shortWeek(r.weekOf)
  return {
    done: `${week} 완료`,
    stale: `${week} · 오래됨`,
    diff: `${week} · 질문지 다름`,
    unknown: `${week} · 기록 없음`,
    alone: '경쟁사 미측정',
    none: '측정 전',
  }[r.status]
}

export interface CohortView<T> {
  /** `업종 · 지역` */
  label: string
  list: T[]
}
export interface GroupView<T> {
  name: string
  cohorts: CohortView<T>[]
}

/**
 * 영어 질문 코호트인가 — 영어 측정 테넌트는 지역에 「(영어 질문)」 꼬리표를 붙여 한국어 코호트와 나눈다
 * (server/types.ts questionLanguage).
 */
export function isEnglishCohort(region: string): boolean {
  return region.includes('(영어 질문)')
}

/**
 * 영어 질문 코호트를 같은 업종의 마지막 코호트 바로 뒤로 옮긴다(같은 업종이 없으면 맨 뒤). 나머지 순서는 그대로.
 * 고객 브랜드가 많아(강남 성형외과 5곳) 업종군 맨 위에 오면 한국어 코호트가 밀려 보였고, 업종군 맨 아래로
 * 내리면 성형외과와 떨어져 무엇의 영어판인지 흐려졌다 — 같은 업종의 끝이 자리다.
 */
function placeEnglishAfterSameIndustry<C>(sorted: C[], industryOf: (c: C) => string, regionOf: (c: C) => string): C[] {
  const out = sorted.filter((c) => !isEnglishCohort(regionOf(c)))
  for (const e of sorted.filter((c) => isEnglishCohort(regionOf(c)))) {
    let at = -1
    out.forEach((c, i) => {
      if (industryOf(c) === industryOf(e)) at = i
    })
    out.splice(at < 0 ? out.length : at + 1, 0, e)
  }
  return out
}

/**
 * 업종군 → 코호트(업종 · 지역) → 브랜드로 묶는다. 업종군은 규칙 순서, 코호트는 우리 브랜드가 많은 것부터
 * (같으면 이름순, 영어 질문 코호트는 같은 업종 끝), 브랜드는 점수 높은 순(점수 없으면 뒤, 같으면 이름순).
 */
export function groupByIndustry<T extends { brandName: string; industry: string; region: string; score: number | null }>(
  rows: T[],
): GroupView<T>[] {
  const byGroup = new Map<string, Map<string, T[]>>()
  for (const r of rows) {
    const g = industryGroupOf(r.industry)
    const cohorts = byGroup.get(g) ?? new Map<string, T[]>()
    const key = `${r.industry} · ${r.region}`
    cohorts.set(key, [...(cohorts.get(key) ?? []), r])
    byGroup.set(g, cohorts)
  }
  return [...byGroup.entries()]
    .sort((a, b) => groupOrder(a[0]) - groupOrder(b[0]))
    .map(([name, cohorts]) => ({
      name,
      cohorts: placeEnglishAfterSameIndustry(
        [...cohorts.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], 'ko')),
        ([, list]) => list[0]!.industry,
        ([, list]) => list[0]!.region,
      ).map(([label, list]) => ({
          label,
        list: [...list].sort((x, y) => (y.score ?? -1) - (x.score ?? -1) || x.brandName.localeCompare(y.brandName, 'ko')),
      })),
    }))
}

/** 지금 이 코호트에서 재는 고객 브랜드인가 — 경쟁사도, 그 뒤 주차에 다시 잰 지난 기록도 아니다. */
export function isCurrentCustomer(m: CohortMember): boolean {
  return !m.competitor && m.laterWeek === null
}

/**
 * 코호트 리더보드를 업종군별로 묶는다. 업종군은 규칙 순서, 그 안은 지금 재는 고객 브랜드가 많은 코호트부터
 * (같으면 이름순, 이름도 같으면 최근 주차부터 — 같은 업종 · 지역의 W37과 W40이 나란히 온다). 영어 질문
 * 코호트는 같은 업종 끝.
 */
export function groupCohorts(cohorts: PortfolioCohort[]): { name: string; cohorts: PortfolioCohort[] }[] {
  const byGroup = new Map<string, PortfolioCohort[]>()
  for (const c of cohorts) {
    const g = industryGroupOf(c.industry)
    byGroup.set(g, [...(byGroup.get(g) ?? []), c])
  }
  const own = (c: PortfolioCohort) => c.members.filter(isCurrentCustomer).length
  const label = (c: PortfolioCohort) => `${c.industry} · ${c.region}`
  return [...byGroup.entries()]
    .sort((a, b) => groupOrder(a[0]) - groupOrder(b[0]))
    .map(([name, list]) => ({
      name,
      cohorts: placeEnglishAfterSameIndustry(
        [...list].sort(
          (a, b) => own(b) - own(a) || label(a).localeCompare(label(b), 'ko') || b.weekOf.localeCompare(a.weekOf),
        ),
        (c) => c.industry,
        (c) => c.region,
      ),
    }))
}

/**
 * 브랜드 현황에서 경쟁사 줄을 열 때 맞출 고객 브랜드 — 그 줄이 든 코호트 카드의 고객 브랜드.
 *
 * 고른 고객을 그대로 두면 다른 업종 고객과 비교하게 된다: 사이드바에서 View Plastic Surgery를 고른 채 펜션
 * 카드의 군산여행의 모든것을 열자 성형외과 고객과 나란히 비교했다(2026-10-13). 지금 고른 고객이 그 카드에
 * 있으면 그대로 두고, 없으면 그 카드의 첫 고객 브랜드로 맞춘다. 고객 브랜드가 없는 카드면 null(바꾸지 않는다).
 * 그 뒤 주차에 다시 잰 고객도(지난 기록 줄) 그 카드의 고객이다.
 */
export function customerForCompetitorRow(cohort: PortfolioCohort, currentCustomerId: string | undefined): string | null {
  const customers = cohort.members.filter((m) => !m.competitor).map((m) => m.tenantId)
  if (currentCustomerId && customers.includes(currentCustomerId)) return currentCustomerId
  return customers[0] ?? null
}

/** 두 측정이 같은 코호트(업종 · 지역)인가 — 경쟁사 보기의 「고객과 비교」는 같은 코호트일 때만 나란히 놓는다. */
export function sameCohort(a: { industry: string; region: string }, b: { industry: string; region: string }): boolean {
  return a.industry === b.industry && a.region === b.region
}

/**
 * 경쟁사 보기 띠가 보여 줄 코호트 — 그 경쟁사가 고객 브랜드와 함께 있는 코호트 중 가장 최근 주차.
 * 같이 있는 코호트가 없으면(다른 고객의 경쟁사를 연 경우) 그 경쟁사가 든 가장 최근 코호트.
 */
export function cohortOfCompetitor(
  cohorts: PortfolioCohort[],
  competitorId: string,
  customerId: string | undefined,
): PortfolioCohort | null {
  const withIt = cohorts.filter((c) => c.members.some((m) => m.tenantId === competitorId))
  const latest = (list: PortfolioCohort[]) => [...list].sort((a, b) => b.weekOf.localeCompare(a.weekOf))[0] ?? null
  return latest(withIt.filter((c) => c.members.some((m) => m.tenantId === customerId))) ?? latest(withIt)
}
