import type { CohortMember, PortfolioCohort, PortfolioRow, PortfolioStatus } from './api'
import { weeksBetween } from './comparability'
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

/**
 * 브랜드 바꾸기 패널의 짧은 상태 문구 — 마지막 측정 주차를 앞에 붙인다. 오래됨은 몇 주 전인지로 적는다 — 월요일이면
 * 지난주에 잰 브랜드가 모두 「오래됨」이 되어, 지난주 측정과 4주 전 측정이 같은 말로 보였다.
 */
export function statusShort(r: PortfolioRow): string {
  const week = shortWeek(r.weekOf)
  const age = r.ageWeeks ?? null
  return {
    done: `${week} 완료`,
    stale: age !== null && age >= 2 ? `${week} · ${age}주 전` : `${week} · 이번 주 아직`,
    diff: `${week} · 질문지 다름`,
    unknown: `${week} · 질문지 기록 없음`,
    alone: '경쟁사 없이 측정',
    none: '측정 전',
  }[r.status]
}

/** 브랜드 현황 거르개 — 요약 타일 하나에 하나. 타일끼리 겹치지 않는다(완료 + 측정 남음 + 순위 비교 안 됨 + 경쟁사 없이 = 전체). */
export type PfFilter = '' | 'done' | 'todo' | 'mismatch' | 'alone'
/** 브랜드 현황 정렬 — 빈 값은 업종군별(기본), 나머지는 업종군을 풀고 한 줄로 늘어놓는다. */
export type PfSort = '' | 'oldest' | 'score' | 'name'

const FILTERS: PfFilter[] = ['', 'done', 'todo', 'mismatch', 'alone']
const SORTS: PfSort[] = ['', 'oldest', 'score', 'name']

export function passFilter(r: Pick<PortfolioRow, 'status'>, f: PfFilter): boolean {
  switch (f) {
    case '':
      return true
    case 'done':
      return r.status === 'done'
    case 'todo':
      return r.status === 'stale' || r.status === 'none'
    case 'mismatch':
      return r.status === 'diff' || r.status === 'unknown'
    case 'alone':
      return r.status === 'alone'
  }
}

export interface PortfolioSummary {
  all: number
  done: number
  /** 이번 주 측정 남음 — 같은 질문지로 쟀지만 이번 주가 아니거나(stale) 아직 안 잰(none) 브랜드. */
  todo: number
  none: number
  /** 측정 남은 브랜드 가운데 가장 오래된 측정. 몇 주 전인지 모르면(옛 응답) weeks null. */
  oldest: { weekOf: string; weeks: number | null } | null
  /** 순위 비교 안 됨 — 질문지가 다르거나(diff) 기록이 없어(unknown) 순위를 견줄 수 없다. */
  mismatch: number
  diff: number
  unknown: number
  alone: number
}

export function summarize(rows: PortfolioRow[]): PortfolioSummary {
  const count = (s: PortfolioStatus) => rows.filter((r) => r.status === s).length
  const first = rows
    .filter((r): r is PortfolioRow & { weekOf: string } => r.status === 'stale' && r.weekOf !== null)
    .sort((a, b) => a.weekOf.localeCompare(b.weekOf))[0]
  return {
    all: rows.length,
    done: count('done'),
    todo: count('stale') + count('none'),
    none: count('none'),
    oldest: first ? { weekOf: first.weekOf, weeks: first.ageWeeks ?? null } : null,
    mismatch: count('diff') + count('unknown'),
    diff: count('diff'),
    unknown: count('unknown'),
    alone: count('alone'),
  }
}

/** 상태 점 · 칩 색. 지난주에 잰 브랜드(1주)는 중립 — 매주 월요일 전부 주황이 되지 않게. 2주 넘게 안 쟀거나 순위를 견줄 수 없으면 주황. */
export function rowTone(r: Pick<PortfolioRow, 'status' | 'ageWeeks'>): string {
  if (r.status === 'done') return 'good'
  if (r.status === 'alone') return 'info'
  if (r.status === 'none') return ''
  if (r.status === 'stale') return (r.ageWeeks ?? 2) <= 1 ? '' : 'warn'
  return 'warn'
}

export interface RowChip {
  text: string
  /** good · warn · info · 빈 값(중립). */
  tone: string
  title?: string
  /** 누르면 경쟁사 편집을 여는 칩. */
  action?: 'competitors'
}

/** 경쟁사 편집 화면의 「여기까지 함께 측정」 설명(components/CompetitorEditor.tsx)과 같은 말. */
const waitingTitle = (cap: number) =>
  `한 번에 ${cap}곳까지만 함께 재요. 그 아래는 대기로 두고 측정하지 않아요. 위에서 빼거나 바꾸면 대기 첫 줄이 올라와요.`

/**
 * 브랜드 현황 한 줄의 상태 칩 — 나이 · 완료 → 비교 문제 → 경쟁사 칸 문제 → 편집 대기 → 경쟁사 대기 순서.
 * 측정 나이와 비교 문제(질문지 다름 · 기록 없음)를 한 칩에 섞지 않는다: 「측정 필요 · 질문지 다름」은 언제 쟀는지를,
 * 「측정 오래됨」은 순위를 믿어도 되는지를 감췄다.
 */
export function rowChips(r: PortfolioRow): RowChip[] {
  const week = shortWeek(r.weekOf)
  const chips: RowChip[] = []
  if (r.status === 'done') chips.push({ text: `${week} 완료`, tone: 'good' })
  else if (r.status === 'none') chips.push({ text: '측정 전', tone: '' })
  else {
    const age = r.ageWeeks ?? null
    if (age === null) chips.push({ text: `${week} 측정`, tone: '' })
    else if (age === 1) chips.push({ text: `${week} 측정 · 이번 주 아직`, tone: '' })
    else if (age >= 2) chips.push({ text: `${week} 측정 · ${age}주 전`, tone: 'warn' })
  }
  if (r.status === 'diff') {
    chips.push({
      text: '질문지 다름 · 순위 참고용',
      tone: 'warn',
      title:
        '이 비교 그룹의 다른 브랜드와 이름 없이 물은 질문이 달라 순위를 그대로 견줄 수 없습니다. 경쟁사와 함께 다시 측정하면 같은 질문지로 맞춰집니다.',
    })
  }
  if (r.status === 'unknown') {
    chips.push({
      text: '질문지 기록 없음 · 순위 참고용',
      tone: 'warn',
      title:
        '이 브랜드나 비교 그룹의 다른 브랜드에 질문지 기록이 없어, 같은 질문으로 쟀는지 확인 불가입니다. 경쟁사와 함께 다시 측정하면 같은 질문지로 맞춰집니다.',
    })
  }
  if (r.status === 'alone') {
    chips.push({
      text: '경쟁사 없이 측정',
      tone: 'info',
      title: '이 비교 그룹에서 이 브랜드만 쟀습니다 — 순위가 없습니다. 경쟁사를 함께 측정하면 순위가 생깁니다.',
    })
  }
  const plan = r.competitorPlan
  const collision = plan?.collision
  if (plan && collision === undefined) {
    if (plan.blocked > 0) chips.push({ text: `측정 안 되는 경쟁사 ${plan.blocked}곳`, tone: 'warn', action: 'competitors' })
  } else if (plan && collision !== undefined) {
    if (collision > 0) {
      chips.push({
        text: `ID 겹침 ${collision}곳 · 측정 안 됨`,
        tone: 'warn',
        title: '다른 업종 브랜드와 ID가 겹쳐 함께 재지 못하는 경쟁사가 있습니다. 경쟁사 편집에서 이름이나 주소를 고치면 잴 수 있습니다.',
        action: 'competitors',
      })
    }
    const duplicate = plan.blocked - collision
    if (duplicate > 0) {
      chips.push({
        text: `중복 ${duplicate}곳 · 칸만 차지`,
        tone: 'warn',
        title: '다른 경쟁사와 같은 브랜드로 이어져 측정 칸만 차지하는 경쟁사가 있습니다. 경쟁사 편집에서 빼면 대기 첫 줄이 올라옵니다.',
        action: 'competitors',
      })
    }
  }
  if (r.profileEdit) chips.push({ text: '기본 정보 바뀜 · 다음 측정 대기', tone: 'info', title: r.profileEdit.summary })
  if (r.competitorEdit) chips.push({ text: '경쟁사 바뀜 · 다음 측정 대기', tone: 'info', title: r.competitorEdit.summary })
  if (plan && plan.waiting > 0) {
    chips.push({ text: `경쟁사 대기 ${plan.waiting}곳`, tone: '', title: waitingTitle(plan.cap), action: 'competitors' })
  }
  return chips
}

/**
 * 줄 아래 점수 변화 — 직전 측정과 같은 조건일 때만 증감(서버가 앱 전체 규칙 comparability.ts로 가른다). 직전 측정이
 * 2주 이상 떨어졌으면 「전주」가 아니라 「직전 측정(Wxx)」이라고 적는다(W38 → W41을 「전주 대비」라고 하지 않는다).
 * 견줄 수 없으면 첫 조건 하나와 나머지 수만 적고 전부는 title에 둔다 — 조건 넷이 줄에 다 붙으면 이름 칸이 넘쳤다.
 */
export function changeLine(r: PortfolioRow): { text: string; title?: string } {
  const gap = r.previousWeekOf && r.weekOf ? (weeksBetween(r.previousWeekOf, r.weekOf) ?? 1) : 1
  const far = gap >= 2 && r.previousWeekOf ? `직전 측정(${shortWeek(r.previousWeekOf)})` : null
  if (r.delta !== null) {
    if (r.delta === 0) return { text: far ? `${far}과 같음` : '전주와 같음' }
    return { text: `${far ?? '전주'} 대비 ${r.delta > 0 ? '+' : '−'}${Math.abs(r.delta)}` }
  }
  const against = far ? `${far}과` : '전주와'
  const dims = r.changeDims
  const total = dims ? dims.changed.length + dims.unknown.length : 0
  if (dims && total > 0) {
    const first = dims.changed.length ? `${dims.changed[0]} 바뀜` : `${dims.unknown[0]} 기록 없음`
    const all = [dims.changed.length ? `${dims.changed.join(' · ')} 바뀜` : '', dims.unknown.length ? `${dims.unknown.join(' · ')} 기록 없음` : '']
      .filter(Boolean)
      .join(' · ')
    return {
      text: `변화 표시 안 함 · ${first}${total > 1 ? ` 외 ${total - 1}` : ''}`,
      title: `${against} 조건이 달라 점수 변화를 보이지 않습니다 — ${all}. 같은 조건으로 잰 측정끼리만 증감을 보입니다.`,
    }
  }
  if (r.changeReason) return { text: `${against} 비교 불가 · ${r.changeReason}` }
  return { text: r.weekOf ? '첫 측정 · 다음 측정부터 변화 표시' : '' }
}

/** 점수 막대 폭(%) — 100점 만점 기준. 0점보다 크면 보이게 최소 2%, 측정 전이면 0. */
export function barWidth(score: number, measured: boolean): number {
  if (!measured || score <= 0) return 0
  return Math.max(2, Math.min(100, score))
}

export interface PortfolioViewState {
  f: PfFilter
  /** 업종군 이름(빈 값 = 전체). */
  g: string
  q: string
  sort: PfSort
  /** 「현황 | 관리」 — 관리면 브랜드 관리(수집 엔진 · 측정 · 삭제 · 되살리기). 주소 키는 view. */
  mode: '' | 'manage'
}

/** 주소의 보기 상태(?f=todo&g=…&q=…&sort=oldest&view=manage)를 읽는다 — 모르는 값은 기본으로. */
export function parseView(search: string | URLSearchParams): PortfolioViewState {
  const p = typeof search === 'string' ? new URLSearchParams(search) : search
  const f = FILTERS.find((x) => x === p.get('f')) ?? ''
  const sort = SORTS.find((x) => x === p.get('sort')) ?? ''
  return { f, g: p.get('g') ?? '', q: p.get('q') ?? '', sort, mode: p.get('view') === 'manage' ? 'manage' : '' }
}

/** 보기 상태를 주소 값으로 — 기본값은 적지 않는다(기본 보기의 주소는 비어 있다). */
export function viewParams(v: PortfolioViewState): URLSearchParams {
  const p = new URLSearchParams()
  if (v.f) p.set('f', v.f)
  if (v.g) p.set('g', v.g)
  if (v.q) p.set('q', v.q)
  if (v.sort) p.set('sort', v.sort)
  if (v.mode) p.set('view', v.mode)
  return p
}

/**
 * 비교 그룹 카드를 한 줄로 늘어놓는다(업종군을 풀고). oldest는 가장 이른 측정부터(측정 전이 맨 앞), score는 고객 브랜드 최고
 * 점수 높은 순(점수 없으면 뒤), name은 고객 브랜드 이름순. 같으면 기본 순서(groupCohorts). 측정 전 브랜드의 가짜 카드는
 * 구성원 점수(0)가 아니라 그 브랜드 줄의 점수(null)로 줄 세운다.
 */
export function sortCohorts(cohorts: PortfolioCohort[], rowById: Map<string, PortfolioRow>, sort: PfSort): PortfolioCohort[] {
  const base = groupCohorts(cohorts).flatMap((g) => g.cohorts)
  if (!sort) return base
  const customers = (c: PortfolioCohort) => c.members.filter(isCurrentCustomer)
  const best = (c: PortfolioCohort): number | null => {
    const scores = customers(c)
      .map((m) => rowById.get(m.tenantId)?.score ?? null)
      .filter((x): x is number => x !== null)
    return scores.length ? Math.max(...scores) : null
  }
  const firstName = (c: PortfolioCohort) =>
    customers(c)
      .map((m) => m.brandName)
      .sort((a, b) => a.localeCompare(b, 'ko'))[0] ?? ''
  const order = new Map(base.map((c, i) => [c, i]))
  const compare = (a: PortfolioCohort, b: PortfolioCohort): number => {
    if (sort === 'oldest') return a.weekOf.localeCompare(b.weekOf)
    if (sort === 'score') {
      const x = best(a)
      const y = best(b)
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1
      return y - x
    }
    return firstName(a).localeCompare(firstName(b), 'ko')
  }
  return [...base].sort((a, b) => compare(a, b) || order.get(a)! - order.get(b)!)
}

/**
 * 줄의 「측정」 단추 — 이번 주에 다시 재면 나아지는 브랜드(오래됨 · 질문지 다름 · 기록 없음 · 측정 전)만 보인다.
 * 그 브랜드를 지금 재는 중이면 숨기고(「측정 중」 칩이 대신한다), 다른 브랜드를 재는 중이면 누를 수 없게 한다.
 */
export function showMeasure(r: Pick<PortfolioRow, 'tenantId' | 'status'>, activeTenantId: string | null): 'on' | 'off' | 'disabled' {
  if (!needsMeasure(r) || activeTenantId === r.tenantId) return 'off'
  return activeTenantId ? 'disabled' : 'on'
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

/** 카드 키 — 업종 · 지역 · 주차(측정 전 카드는 주차가 비어 업종 · 지역마다 하나다). */
export const cohortKey = (c: PortfolioCohort) => `${c.industry}|${c.region}|${c.weekOf}`

/**
 * 측정 기록이 없는 고객 브랜드는 비교 그룹 카드가 없다 — 업종 · 지역마다 측정 전 카드 한 장에 모아 목록에서 빠지지 않게(같은
 * 업종 · 지역의 측정 전 브랜드가 카드 두 장으로 갈리지 않게).
 */
export function unmeasuredCohorts(rows: PortfolioRow[]): PortfolioCohort[] {
  const byKey = new Map<string, PortfolioCohort>()
  for (const r of rows.filter((x) => !x.weekOf)) {
    const key = `${r.industry}|${r.region}`
    const card = byKey.get(key) ?? { industry: r.industry, region: r.region, weekOf: '', members: [] }
    card.members.push({
      tenantId: r.tenantId,
      brandName: r.brandName,
      score: 0,
      rank: 0,
      tied: false,
      mentionRate: 0,
      brandOwnedCitationRate: 0,
      competitor: false,
      laterWeek: null,
    })
    byKey.set(key, card)
  }
  return [...byKey.values()]
}

/** 이 카드의 순위를 그대로 견줄 수 없는 까닭 — 지금 재는 고객 가운데 질문지가 다르거나 기록이 없는 곳이 있으면. */
export function refReason(c: PortfolioCohort, rowById: Map<string, PortfolioRow>): 'diff' | 'unknown' | null {
  const statuses = c.members.filter(isCurrentCustomer).map((m) => rowById.get(m.tenantId)?.status)
  if (statuses.includes('diff')) return 'diff'
  if (statuses.includes('unknown')) return 'unknown'
  return null
}
