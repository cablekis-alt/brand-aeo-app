import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import type { ActiveMeasure } from '../components/MeasureProgress'
import { brandLabel, type VariantBrand } from './brandVariant'
import type { LocalRun } from './measureRuns'
import { weekLabel } from './format'

/*
 * 측정 상태 한 벌 — 사이드바(측정 카드 · 배지), 화면 아래 결과 띠(MeasureResultBand), Windows 알림이 같은 응답을 본다.
 *
 * 예전에는 사이드바 · 측정 화면 · 측정 상태 화면이 저마다 /api/measure-status를 다른 간격으로 읽었고, 측정이 끝나도 그 사실을
 * 알리는 곳이 측정을 시작한 화면의 문구뿐이었다 — 다른 화면으로 가면 끝났는지 실패했는지 몰랐다(상용화 UI 3차 U13).
 * 구독하는 화면이 있을 때만 읽는다(측정 중 5초 · 아니면 15초). 창이 뒤에 있어도 건너뛰지 않는다 — 알림이 목적이다.
 */

/** 측정 회차 — server/measureTracker.ts MeasureRunRecord와 같은 모양. */
export interface MeasureRunRecord {
  id: string
  /** 끝난 순서(진행 중이면 0). */
  seq: number
  tenantId: string
  brandName: string
  startedAt: string
  endedAt?: string
  selfOnly?: boolean
  competitorOnly?: boolean
  competitors?: number
  result?: 'done' | 'failed' | 'cancelled'
  aeoScore?: number
  weekOf?: string
  weekCardKept?: string
  error?: string
  engineIssues?: string[]
  /** 함께 재다 실패한 경쟁사. keptEarlierCard면 같은 주에 앞서 잰 그 경쟁사의 카드가 순위에 그대로 들어갔다. */
  competitorFailures?: { tenantId: string; brandName: string; keptEarlierCard?: boolean }[]
}

export interface MeasureRuns {
  /** 서버를 켤 때마다 바뀐다 — 바뀌면 seq를 처음부터 다시 센다. */
  bootId: string
  current: MeasureRunRecord[]
  recent: MeasureRunRecord[]
}

/** 실패한 측정 — server/measureTracker.ts MeasureFailure와 같은 모양. */
export interface MeasureFailure {
  tenantId: string
  brandName: string
  at: string
  error: string
  engineIssues?: string[]
}

export interface MeasureStatusState {
  /** 서버가 측정 상태를 알려 준다(웹에는 이 라우트가 없다). */
  ok: boolean
  active: ActiveMeasure[]
  failed: MeasureFailure[]
  /** 이 PC의 측정 완료 기록(브랜드마다 한 줄 — 측정 1회로 묶는 것은 lib/measureRuns.ts). */
  completed: LocalRun[]
  /** 옛 서버(회차 기록 전)면 null. */
  runs: MeasureRuns | null
  /** 새로 끝난 회차를 받을 때마다 1씩 오른다 — 화면이 저장된 기록을 다시 읽을 신호. */
  doneEpoch: number
  /** 화면 아래 결과 띠에 올릴 회차(최신 먼저). */
  band: MeasureRunRecord[]
}

/** 측정을 시작한 화면의 안내 — 「이 탭을 열어 두세요」 대신. 앞에 브랜드 이름을 붙인다. */
export const MEASURING_NOTE = '측정 중… 다른 화면으로 가도 측정은 계속되고, 끝나면 화면 아래에 알려 드립니다(앱을 끄면 멈춥니다).'

/** 실패 줄에 보일 이유 — 끊긴 엔진이 있으면 그 이름, 없으면 오류 문구 첫 문장. */
export function failureReason(f: { error?: string; engineIssues?: string[] }): string {
  if (f.engineIssues?.length) return f.engineIssues.join(' · ')
  const error = f.error ?? '알 수 없는 오류'
  const first = error.replace(/^\[[^\]]+\]\s*/, '').split(/(?<=[.。])\s/)[0] ?? error
  return first.length > 90 ? `${first.slice(0, 90)}…` : first
}

export interface SeenRuns {
  bootId: string
  seq: number
}

/**
 * 지난번 응답 뒤에 새로 끝난 회차. 처음 받은 응답은 기준만 잡는다(앱을 켜자마자 지난 결과를 다시 알리지 않게). 서버를 다시
 * 켰으면(bootId가 바뀜) 그 뒤에 끝난 회차가 전부 새것이다.
 */
export function pickNewOutcomes(seen: SeenRuns | null, runs: MeasureRuns | null): { fresh: MeasureRunRecord[]; seen: SeenRuns | null } {
  if (!runs) return { fresh: [], seen }
  const top = Math.max(0, ...runs.recent.map((r) => r.seq))
  if (seen === null) return { fresh: [], seen: { bootId: runs.bootId, seq: top } }
  if (seen.bootId !== runs.bootId) return { fresh: runs.recent, seen: { bootId: runs.bootId, seq: top } }
  return { fresh: runs.recent.filter((r) => r.seq > seen.seq), seen: { bootId: runs.bootId, seq: Math.max(seen.seq, top) } }
}

/**
 * 실패한 경쟁사가 순위에 어떻게 들어갔나 — 실패한 측정은 카드를 쓰기 전에 멈춰, 같은 주에 앞서 잰 그 경쟁사의 카드는 순위에 남는다.
 * 그 경우에도 「나머지로 매겼다」고 하면 운영자가 고객에게 틀린 순위 설명을 하게 된다.
 */
function failureRanking(failed: NonNullable<MeasureRunRecord['competitorFailures']>): string {
  const kept = failed.filter((f) => f.keptEarlierCard)
  if (kept.length === 0) return '순위는 나머지로 매겼습니다'
  if (kept.length === failed.length) return '순위에는 앞서 잰 이번 주 기록을 썼습니다'
  return `순위에는 ${kept.map((f) => f.brandName).join(', ')}의 앞서 잰 이번 주 기록을 썼고, 나머지는 빼고 매겼습니다`
}

function durationText(startedAt: string, endedAt?: string): string | null {
  const ms = endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : NaN
  if (!Number.isFinite(ms) || ms < 0) return null
  const s = Math.round(ms / 1000)
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}분 ${s % 60}초` : `${s}초`
}

/** 회차의 브랜드 이름 — 고객 브랜드면 범위 꼬리표까지(「군산각 · 전국형」), 목록에 없으면 경쟁사다. */
export function runName(r: Pick<MeasureRunRecord, 'tenantId' | 'brandName'>, tenants: (VariantBrand & { brandName: string })[]): string {
  const customer = tenants.find((t) => t.tenantId === r.tenantId)
  return customer ? brandLabel(customer, tenants) : `${r.brandName}(경쟁사)`
}

export type OutcomeAction = 'overview' | 'brands' | 'remeasure' | 'status'

export interface OutcomeView {
  tone: 'good' | 'bad' | 'neutral'
  title: string
  sub: string
  /** 띠의 주 동작. 멈춘 측정은 없다. */
  primary: Exclude<OutcomeAction, 'status'> | null
  /** 「측정 상태」 단추를 보이는가. */
  statusLink: boolean
  /** 잰 브랜드가 고객 브랜드면 그 id(개요 보기 · 다시 측정 때 고른다). 경쟁사면 null. */
  customerId: string | null
  /** Windows 알림 — 멈춘 측정은 알리지 않는다(사용자가 멈췄다). */
  notify: { title: string; body: string; action: OutcomeAction } | null
  /** 저절로 닫히는 시간(ms). */
  autoCloseMs: number | null
}

/**
 * 끝난 회차 하나를 띠 · 알림 문구로. 점수 증감은 넣지 않는다 — 직전 측정과 같은 조건인지는 개요가 가른다(comparability.ts).
 * 이름은 같은 홈페이지를 쓰는 형제가 있으면 범위 꼬리표를 붙이고(「군산각 · 전국형」), 고객 브랜드 목록에 없으면 경쟁사다.
 */
export function outcomeMessage(r: MeasureRunRecord, tenants: (VariantBrand & { brandName: string })[]): OutcomeView {
  const customer = tenants.find((t) => t.tenantId === r.tenantId) ?? null
  const name = runName(r, tenants)
  const score = r.aeoScore ?? '?'
  const base = { customerId: customer?.tenantId ?? null, autoCloseMs: null }
  if (r.result === 'cancelled') {
    return {
      ...base,
      tone: 'neutral',
      title: `${name} 측정을 멈췄습니다 — 이번 주 데이터는 그대로입니다.`,
      sub: '',
      primary: null,
      statusLink: false,
      notify: null,
      autoCloseMs: 10_000,
    }
  }
  if (r.result === 'failed') {
    const reason = failureReason(r)
    return {
      ...base,
      tone: 'bad',
      title: `${name} 측정 실패 — ${reason}`,
      sub: '보고서를 보내기 전에 다시 측정하세요. 자세한 이유는 측정 상태에 있습니다.',
      primary: 'remeasure',
      statusLink: true,
      notify: { title: `측정 실패 · ${name}`, body: `${reason} — 눌러서 측정 상태 보기`, action: 'status' },
    }
  }
  if (!customer) {
    return {
      ...base,
      tone: 'good',
      title: `${name} 측정 끝 · Brand AEO ${score}점`,
      sub: '같은 주에 잰 고객 브랜드의 경쟁 순위에 반영됩니다.',
      primary: 'brands',
      statusLink: false,
      notify: { title: `측정 끝 · ${name}`, body: `Brand AEO ${score}점(100점 만점) — 눌러서 브랜드 현황 보기`, action: 'brands' },
    }
  }
  const notify = { title: `측정 끝 · ${name}`, body: `Brand AEO ${score}점(100점 만점) — 눌러서 개요 보기`, action: 'overview' as const }
  if (r.weekCardKept) {
    return {
      ...base,
      tone: 'good',
      title: `${name} 측정 끝 · 이번 회차 ${score}점`,
      sub: `${r.weekCardKept}. 이번 측정은 회차 기록에만 남습니다.`,
      primary: 'overview',
      statusLink: false,
      // 개요는 그 주 카드(앞선 측정)를 보인다 — 알림도 이 점수가 그 주 점수인 것처럼 말하지 않는다.
      notify: { ...notify, body: `이번 회차 ${score}점 — 그 주 기록은 그대로입니다. 눌러서 개요 보기` },
    }
  }
  const failed = r.competitorFailures ?? []
  const names = failed.slice(0, 3).map((f) => f.brandName).join(', ') + (failed.length > 3 ? ` 외 ${failed.length - 3}곳` : '')
  const took = durationText(r.startedAt, r.endedAt)
  const sub = [r.weekOf ? weekLabel(r.weekOf) : '', took ? `${took} 걸림` : ''].filter(Boolean).join(' · ')
  return {
    ...base,
    tone: 'good',
    title: `${name} 측정 끝 · Brand AEO ${score}점(100점 만점)`,
    sub: failed.length ? `${sub}${sub ? ' · ' : ''}경쟁사 ${failed.length}곳(${names})은 측정 실패 — ${failureRanking(failed)}` : sub,
    primary: 'overview',
    statusLink: failed.length > 0,
    notify,
  }
}

// ── 모듈 하나가 들고 있는 상태 · 폴러 ─────────────────────────────────────

const EMPTY: MeasureStatusState = { ok: false, active: [], failed: [], completed: [], runs: null, doneEpoch: 0, band: [] }
const BUSY_MS = 5_000
const IDLE_MS = 15_000
/** 결과를 맡은 뒤(측정을 막 시작함) 이만큼은 측정 중처럼 자주 읽는다. */
const EXPECT_BUSY_MS = 30_000

/**
 * 다음에 읽을 때까지 — 측정 중이거나 막 시작한 참이면 5초, 아니면 15초. 측정을 시작한 직후 읽으면 서버가 아직 회차를 적기 전이라
 * 「측정 중」이 안 보이고 15초 뒤에야 나타났다 — 그래서 시작한 뒤 잠깐은 측정 중처럼 읽는다.
 */
export function pollDelayMs(busy: boolean, expectBusyUntil: number, now: number): number {
  return busy || now < expectBusyUntil ? BUSY_MS : IDLE_MS
}

let state: MeasureStatusState = EMPTY
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | null = null
let inflight = false
let again = false
/** 라우트가 없다(웹) — 더 읽지 않는다. */
let unsupported = false
let seen: SeenRuns | null = null
let expectBusyUntil = 0
/** 지금 결과 문구를 직접 보이는 화면이 맡은 브랜드(측정을 시작한 화면) — 창에 포커스가 있으면 띠를 띄우지 않는다. */
const claims = new Map<string, number>()

export interface OutcomeContext {
  tenants: (VariantBrand & { brandName: string })[]
  /** 알림을 눌렀을 때 — 띠의 그 동작을 한다. */
  onNotificationClick: (record: MeasureRunRecord, action: OutcomeAction) => void
}
let context: OutcomeContext | null = null

/** 결과 띠가 고객 브랜드 목록과 이동 함수를 넘긴다 — 알림 문구 · 알림을 눌렀을 때 쓴다. */
export function setOutcomeContext(next: OutcomeContext | null): void {
  context = next
}

function emit() {
  for (const l of listeners) l()
}

const hasFocus = () => typeof document !== 'undefined' && document.hasFocus()

function notifyOutcome(r: MeasureRunRecord) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  const view = outcomeMessage(r, context?.tenants ?? [])
  if (!view.notify) return
  const { title, body, action } = view.notify
  try {
    // 회차 id로 묶는다 — seq는 서버를 다시 켜면 1부터 다시 세어 다른 회차와 겹친다.
    const n = new Notification(title, { body, tag: `measure-${r.id}` })
    n.onclick = () => {
      const bridge = typeof window !== 'undefined' ? window.electron : undefined
      if (bridge?.focusWindow) void bridge.focusWindow()
      else window.focus()
      context?.onNotificationClick(r, action)
    }
  } catch (err) {
    console.error('[measureStatus] 알림을 띄우지 못했습니다', err)
  }
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : []
}

function parseRuns(v: unknown): MeasureRuns | null {
  const r = v as Partial<MeasureRuns> | null | undefined
  if (!r || typeof r.bootId !== 'string') return null
  return { bootId: r.bootId, current: asArray(r.current), recent: asArray(r.recent) }
}

function schedule() {
  if (timer) clearTimeout(timer)
  timer = null
  if (listeners.size === 0 || unsupported) return
  const busy = state.active.length > 0 || (state.runs?.current.length ?? 0) > 0
  timer = setTimeout(() => void poll(), pollDelayMs(busy, expectBusyUntil, Date.now()))
}

async function poll(): Promise<void> {
  if (typeof window === 'undefined' || unsupported) return
  if (inflight) {
    again = true
    return
  }
  inflight = true
  try {
    const res = await fetch('/api/measure-status')
    if (res.status === 404) {
      unsupported = true
      state = { ...state, ok: false }
      return
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const d = (await res.json()) as { active?: unknown; failed?: unknown; completed?: unknown; runs?: unknown }
    const runs = parseRuns(d.runs)
    const picked = pickNewOutcomes(seen, runs)
    seen = picked.seen
    const focused = hasFocus()
    const toBand: MeasureRunRecord[] = []
    for (const r of picked.fresh) {
      // 결과를 직접 보이는 화면을 보고 있으면 띠 없이 본 것으로 친다.
      if (!(focused && claims.has(r.tenantId))) toBand.push(r)
      if (!focused) notifyOutcome(r)
      if (r.result === 'failed') void window.electron?.flashWindow?.()
    }
    state = {
      ok: true,
      active: asArray<ActiveMeasure>(d.active),
      failed: asArray<MeasureFailure>(d.failed),
      completed: asArray<LocalRun>(d.completed),
      runs,
      doneEpoch: state.doneEpoch + (picked.fresh.length > 0 ? 1 : 0),
      band: toBand.length ? [...toBand.sort((a, b) => b.seq - a.seq), ...state.band] : state.band,
    }
  } catch (err) {
    console.error('[measureStatus] 측정 상태를 읽지 못했습니다', err)
    state = { ...state, ok: false }
  } finally {
    inflight = false
    emit()
    if (again) {
      again = false
      void poll()
    } else schedule()
  }
}

/** 지금 한 번 다시 읽는다(측정을 막 시작했을 때). */
export function pollMeasureStatusNow(): Promise<void> {
  if (timer) clearTimeout(timer)
  timer = null
  return poll()
}

/** 결과 띠의 한 줄을 닫는다(회차 id). */
export function dismissOutcome(id: string): void {
  if (!state.band.some((r) => r.id === id)) return
  state = { ...state, band: state.band.filter((r) => r.id !== id) }
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) void poll()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer) {
      clearTimeout(timer)
      timer = null
    }
  }
}

/** 지금 상태(React 밖에서 읽을 때 — 확인 스크립트). */
export function getMeasureStatus(): MeasureStatusState {
  return state
}

export function useMeasureStatus(): MeasureStatusState {
  return useSyncExternalStore(subscribe, getMeasureStatus, () => EMPTY)
}

/** 측정을 막 시작했다 — 서버가 회차를 적기 전이라도 잠깐은 측정 중처럼 자주 읽는다. */
export function noteMeasureStarted(): void {
  expectBusyUntil = Date.now() + EXPECT_BUSY_MS
}

/** 그 브랜드의 결과를 맡는다. 돌려준 함수로 내려놓는다. */
export function claimMeasureResult(tenantId: string): () => void {
  claims.set(tenantId, (claims.get(tenantId) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const n = (claims.get(tenantId) ?? 1) - 1
    if (n > 0) claims.set(tenantId, n)
    else claims.delete(tenantId)
  }
}

/**
 * 측정을 시작한 화면이 그 브랜드의 결과를 맡는다 — 그 화면이 결과 문구를 보이므로 띠를 겹쳐 띄우지 않는다. 화면을 떠나면
 * 맡은 것을 내려놓는다(그 뒤에 끝나면 띠가 뜬다). 맡는 즉시 한 번 다시 읽고 잠깐은 5초 간격으로 읽는다 — 서버가 회차를 적는 대로
 * 사이드바에 「측정 중」이 뜨게.
 */
export function useMeasureClaim(): (tenantId: string) => void {
  const mine = useRef(new Map<string, () => void>())
  useEffect(() => {
    const held = mine.current
    return () => {
      for (const release of held.values()) release()
      held.clear()
    }
  }, [])
  return useCallback((tenantId: string) => {
    if (!mine.current.has(tenantId)) mine.current.set(tenantId, claimMeasureResult(tenantId))
    noteMeasureStarted()
    void pollMeasureStatusNow()
  }, [])
}
