/*
 * 측정 완료 기록(server/localMeasureLog.ts measure-runs.json)을 측정 1회 단위로 묶는다 — 측정 상태의 「최근 완료」, 측정에 걸리는
 * 시간 안내가 같은 묶음을 본다.
 *
 * 완료 기록은 브랜드마다 한 줄이라, 고객 하나를 경쟁사 5곳과 함께 재면 6줄이 생겨 「최근 완료」가 경쟁사 줄로 덮였다(상용화 UI 3차 U13).
 * 새 줄은 회차 id(runId)와 함께 잰 고객(parentTenantId)을 적는다. 그 전 줄은 시작 시각(완료 시각 − 걸린 시간)이 30초 안에 몰렸고
 * 그 안의 고객 브랜드가 정확히 하나일 때만 묶는다 — 둘 이상이면 어느 측정의 경쟁사인지 모르므로 묶지 않는다.
 *
 * 런타임 import를 두지 않는다 — 서버도 '../src/lib/measureRuns.js'로 읽을 수 있게(대기열의 걸린 시간 어림).
 */

export interface LocalRun {
  tenantId: string
  brandName: string
  weekOf: string
  aeoScore: number
  /** 완료 시각(ISO). */
  at: string
  durationSec?: number
  engines?: string[]
  weekCardKept?: string
  source?: string
  /** 측정 회차 id(`${tenantId}@${startedAt}`) — 함께 잰 경쟁사 줄도 같은 값. */
  runId?: string
  /** 다른 고객의 측정 안에서 경쟁사로 잰 줄이면 그 고객. */
  parentTenantId?: string
}

export interface RunGroup {
  key: string
  /** customer: 고객 브랜드 측정(경쟁사 함께) · competitorOnly: 경쟁사 하나만 잰 측정 · legacy: 옛 줄이라 어느 측정인지 모름 */
  kind: 'customer' | 'competitorOnly' | 'legacy'
  root: LocalRun
  /** 함께 잰 경쟁사 줄(완료 시각 순). */
  children: LocalRun[]
  /** 처음 시작부터 마지막 완료까지(초). */
  durationSec: number
  /** 마지막 완료 시각(ms). */
  endedAt: number
}

const LEGACY_WINDOW_MS = 30_000

const endOf = (r: LocalRun) => Date.parse(r.at)
const startOf = (r: LocalRun) => endOf(r) - (r.durationSec ?? 0) * 1000

function makeGroup(key: string, kind: RunGroup['kind'], root: LocalRun, children: LocalRun[]): RunGroup {
  const all = [root, ...children]
  const start = Math.min(...all.map(startOf))
  const end = Math.max(...all.map(endOf))
  return {
    key,
    kind,
    root,
    children: [...children].sort((a, b) => endOf(a) - endOf(b)),
    durationSec: Math.max(0, Math.round((end - start) / 1000)),
    endedAt: end,
  }
}

/** 완료 기록을 측정 1회씩 묶는다(최근 끝난 것부터). isCompetitor는 경쟁사(비교용 브랜드)인가. */
export function groupMeasureRuns(rows: LocalRun[], isCompetitor: (tenantId: string) => boolean): RunGroup[] {
  const valid = rows.filter((r) => Number.isFinite(endOf(r)))
  const groups: RunGroup[] = []

  const byRun = new Map<string, LocalRun[]>()
  for (const r of valid.filter((x) => x.runId)) byRun.set(r.runId!, [...(byRun.get(r.runId!) ?? []), r])
  for (const [runId, list] of byRun) {
    const root = list.find((r) => !r.parentTenantId) ?? null
    if (root) {
      groups.push(makeGroup(runId, isCompetitor(root.tenantId) ? 'competitorOnly' : 'customer', root, list.filter((r) => r !== root)))
    } else {
      // 고객 자신은 실패하고 경쟁사만 끝난 회차 — 경쟁사 줄을 따로 보인다(고객 줄은 「최근 실패」에 있다).
      for (const r of list) groups.push(makeGroup(`${runId}|${r.tenantId}`, 'legacy', r, []))
    }
  }

  // 옛 줄 — 시작 시각이 30초 안에 몰린 줄끼리. 그 안의 고객이 하나일 때만 묶는다.
  const legacy = valid.filter((x) => !x.runId).sort((a, b) => startOf(a) - startOf(b))
  let i = 0
  while (i < legacy.length) {
    const first = startOf(legacy[i]!)
    let j = i + 1
    while (j < legacy.length && startOf(legacy[j]!) - first <= LEGACY_WINDOW_MS) j += 1
    const cluster = legacy.slice(i, j)
    const customers = cluster.filter((r) => !isCompetitor(r.tenantId))
    if (customers.length === 1) {
      const root = customers[0]!
      groups.push(makeGroup(`${root.tenantId}@${root.at}`, 'customer', root, cluster.filter((r) => r !== root)))
    } else {
      for (const r of cluster) {
        const kind: RunGroup['kind'] = !isCompetitor(r.tenantId) ? 'customer' : customers.length === 0 && cluster.length === 1 ? 'competitorOnly' : 'legacy'
        groups.push(makeGroup(`${r.tenantId}@${r.at}`, kind, r, []))
      }
    }
    i = j
  }
  return groups.sort((a, b) => b.endedAt - a.endedAt)
}

/** 이 PC에서 최근 고객 브랜드 측정 n번이 걸린 시간의 범위. 3번이 안 되면 null(어림이 되지 않는다). */
export function recentRunDurations(groups: RunGroup[], n = 10): { minSec: number; maxSec: number; count: number } | null {
  const recent = groups.filter((g) => g.kind === 'customer').slice(0, n)
  if (recent.length < 3) return null
  const secs = recent.map((g) => g.durationSec)
  return { minSec: Math.min(...secs), maxSec: Math.max(...secs), count: recent.length }
}

/**
 * 그 브랜드를 마지막으로 잰 측정이 걸린 시간(초). 기록이 없으면 null. 경쟁사는 대개 고객 측정 안에서 함께 재므로, 묶음의
 * 경쟁사 줄로 잰 것이 더 최근이면 그 줄이 걸린 시간을 쓴다.
 */
export function lastRunDurationSec(groups: RunGroup[], tenantId: string): number | null {
  for (const g of groups) {
    if (g.root.tenantId === tenantId) return g.durationSec
    const child = g.children.find((c) => c.tenantId === tenantId)
    if (child?.durationSec !== undefined) return child.durationSec
  }
  return null
}

/** 초 → 「6분 39초」 · 「45초」. */
export function durationText(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}분 ${s % 60}초` : `${s}초`
}
