/**
 * AEO 가시성 실증 판독 — docs/proof/preregistration.md §7 · §8을 저장된 회차 기록으로 계산한다. 앱 데이터는 읽기만 한다.
 *
 *   npx tsx scripts/proof-read.ts zeroth --app-data "<userData>" [--until 2026-11-20] [--bootstrap 2000] [--out <파일>]
 *
 * zeroth — 0차 중간 판독(§8, 참고용 · 판정 · 고객용 결론에 쓰지 않음):
 *   - 처치 = 0차 글(10-30 추가 글)이 맡은 9개(design.json zeroth), 비교 = 대상 c1 질문(이름 없는 기존 질문 가운데 0차 · 대상 아님이 아닌 것).
 *   - 사전 = W43~W44 회차 가운데 0차 글의 첫 게시 기록(published-posts.json recordedAt, 0차 글 articleId) 전에 끝난 회차 전부.
 *     이 시기는 측정 방식 · Gemini 모델이 섞여 있어 §6 제외 규칙을 쓰지 않고 회차 고정효과로만 맞춘다.
 *   - 사후 = 11-02부터 --until까지의 정규 회차(§6: 월 · 수 · 금 날짜마다 그날 처음 끝난 selfOnly 회차 가운데 대상 질문을 모두 잰 것).
 *   - 지표 = 가시성 적중(§7): 언급 · 등록 자사 도메인(design.json metric.ownedDomains) 인용 · 그 브랜드 올린 글 주소 인용.
 *   - 추정 = 적중 ~ 처치 × 사후 + 질문 × 엔진 고정효과 + 브랜드 × 회차 고정효과(선형확률모형, 가중 없음 — 0차는 무작위가 아니다).
 *   - 신뢰구간 = 질문 단위 부트스트랩(브랜드 × 군 층별), 백분위수 95%. 질문 간 상관(ICC)과 칸 규칙 기술 통계도 낸다.
 *
 *   npx tsx scripts/proof-read.ts final --app-data "<userData>" [--until 2026-12-28] [--bootstrap 2000] [--alternatives 2000]
 *     [--index-log docs/proof/index-log.csv] [--out docs/proof/final-read-<until>.json]
 *
 * final — 판독(§7). 게시 전(12-07 중간 점검)에 돌려도 되고, 올라간 차수만큼 스택이 생긴다:
 *   - 정규 회차(§6, 보충 포함) 가운데 스코어카드 판 · 모델이 등록과 다르면 회차를, 대상 질문의 10%를 넘게 빠진 엔진은 그 엔진만 뺀다.
 *   - 게시 시각 = 차수 글마다 올린 기록의 가장 이른 recordedAt(잘못 적은 기록 제외). 첫 글 전에 끝난 회차는 사전, 마지막 글 뒤에
 *     시작한 회차는 사후, 그 사이는 뺀다. 스택 A(1차 대 2차 + 대조, 사후는 2차 게시 전까지) · 스택 B(2차 대 대조, 1차 제외).
 *   - θ = 두 스택 · 두 브랜드를 쌓은 가중 이중차분(배정표 단위 확률의 역수, 질문 × 엔진 · 회차 고정효과). 가중 없는 값은 보조.
 *   - (1) 무작위화 추론: 배정표 다시 뽑기마다 같은 θ → 단측 p < 0.025. 구간은 판독 단위 부트스트랩(브랜드 × 군 층별).
 *   - (2) 칸 규칙: 처치 칸 2개 이상 · 대조 칸(두 스택 창 가운데 하나라도) 1개 이하. (3) 게시 후 1주 · 2주 가중 계수 모두 > 0.
 *   - 민감도: 색인 기록이 있으면 구글 색인일 뒤를 사후로 본 θ. 홀드아웃은 원래 질문과 나란히 기술한다. 배정표와 다른 추가 글은 알린다.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { trackingKey } from '../src/lib/publishedUrl'

// ── 지표 ────────────────────────────────────────────────────────────────────
export interface Citation {
  raw?: string
  domain?: string
}
export interface Analysis {
  questionId: string
  engine: string
  mentioned?: boolean
  citations?: Citation[]
}

/** 비교용 주소 — 앱의 trackingKey에 질의까지 뗀다(§7: 호스트 소문자 · www. · 끝 / · 질의 · 조각 무시). */
export function postKey(raw: string): string | null {
  const key = trackingKey(raw)
  return key ? key.split('?')[0]! : null
}

function hostOf(c: Citation): string | null {
  const fromDomain = c.domain?.trim().toLowerCase()
  if (fromDomain) return fromDomain.replace(/^www\./, '')
  if (!c.raw) return null
  try {
    return new URL(c.raw).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    // 주소가 아닌 인용 — 도메인 일치로는 셀 수 없다.
    return null
  }
}

/** 등록 자사 도메인(하위 도메인 포함)과 같은 호스트인가. */
export function ownedHost(host: string | null, ownedDomains: string[]): boolean {
  if (!host) return false
  return ownedDomains.some((d) => {
    const dom = d.toLowerCase().replace(/^www\./, '')
    return host === dom || host.endsWith(`.${dom}`)
  })
}

/** 가시성 적중 — 언급 · 자사 도메인 인용 · 올린 글 주소 인용 가운데 하나. */
export function isHit(a: Analysis, ownedDomains: string[], postKeys: Set<string>): boolean {
  if (a.mentioned) return true
  return (a.citations ?? []).some((c) => {
    if (ownedHost(hostOf(c), ownedDomains)) return true
    const key = c.raw ? postKey(c.raw) : null
    return key !== null && postKeys.has(key)
  })
}

export interface PostRecord {
  url: string
  recordedAt: string
  articleId?: string
  removedAt?: string
  removedReason?: string
}

/** 그 회차 때 살아 있던 올린 글 주소 키 — 잘못 적은 기록은 빼고, 내린 글은 내린 시각 전에 시작한 회차까지 센다(앱과 같은 규칙). */
export function postKeysAt(posts: PostRecord[], startedAt: string): Set<string> {
  const at = Date.parse(startedAt)
  return new Set(
    posts
      .filter((p) => p.removedReason !== 'mistake' && (!p.removedAt || at < Date.parse(p.removedAt)))
      .map((p) => postKey(p.url))
      .filter((k): k is string => k !== null),
  )
}

// ── 회차 ────────────────────────────────────────────────────────────────────
export interface RunMeta {
  runId: string
  startedAt: string
  finishedAt: string
  selfOnly?: boolean
  engines?: Record<string, { planned?: number }>
}

/** KST 날짜(YYYY-MM-DD)와 요일(0 = 일). */
export function kstDay(iso: string): { date: string; weekday: number } {
  const d = new Date(Date.parse(iso) + 9 * 3600_000)
  return { date: d.toISOString().slice(0, 10), weekday: d.getUTCDay() }
}

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
}

/** 정규 측정일(월 · 수 · 금)마다 보충을 받을 날 — 다음 정규일 전까지(월 → 화, 수 → 목, 금 → 토 · 일). 같은 ISO 주 안이다. */
const SUPPLEMENT_DAYS: Record<number, number> = { 1: 1, 3: 1, 5: 2 }

/**
 * 정규 회차(§6) — from ~ until(KST 날짜)의 월 · 수 · 금마다 그날(startedAt KST) 처음 끝난 회차 가운데 qualifies를 만족하는 것 하나.
 * 그날 그런 회차가 없으면 다음 정규일 전까지(같은 주)의 첫 회차가 대신한다(보충). qualifies는 selfOnly · 대상 질문 계획을 본다.
 */
export function regularRuns<T extends RunMeta>(
  runs: T[],
  qualifies: (r: T) => boolean,
  from: string,
  until: string,
): { run: T; scheduled: string; supplement: boolean }[] {
  const firstByDate = new Map<string, T>()
  for (const r of [...runs].sort((a, b) => a.finishedAt.localeCompare(b.finishedAt))) {
    const { date } = kstDay(r.startedAt)
    if (!firstByDate.has(date) && r.selfOnly === true && qualifies(r)) firstByDate.set(date, r)
  }
  const out: { run: T; scheduled: string; supplement: boolean }[] = []
  for (let date = from; date <= until; date = addDays(date, 1)) {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay()
    if (!(weekday in SUPPLEMENT_DAYS)) continue
    const same = firstByDate.get(date)
    if (same) {
      out.push({ run: same, scheduled: date, supplement: false })
      continue
    }
    for (let k = 1; k <= SUPPLEMENT_DAYS[weekday]!; k += 1) {
      const sub = firstByDate.get(addDays(date, k))
      if (sub && addDays(date, k) <= until) {
        out.push({ run: sub, scheduled: date, supplement: true })
        break
      }
    }
  }
  return out
}

/** 그 회차가 대상 질문을 모두 계획에 넣었나 — 엔진 계획 수(run.json planned) 가운데 가장 큰 값이 기준 문항 수 이상. */
export function plannedAll(r: RunMeta, minQuestions: number): boolean {
  return Math.max(0, ...Object.values(r.engines ?? {}).map((e) => e.planned ?? 0)) >= minQuestions
}

// ── 추정 ────────────────────────────────────────────────────────────────────
export interface Row {
  y: number
  d: number
  cell: string
  run: string
}

/** 두 방향 고정효과(칸 · 회차)를 번갈아 빼서 d의 계수를 구한다(Frisch–Waugh–Lovell). d에 변동이 없으면 null. */
export function twoWayFE(rows: Row[], maxIter = 2000, tol = 1e-12): number | null {
  if (!rows.length) return null
  const y = rows.map((r) => r.y)
  const d = rows.map((r) => r.d)
  const demean = (v: number[], key: (r: Row) => string) => {
    const sum = new Map<string, number>()
    const n = new Map<string, number>()
    rows.forEach((r, i) => {
      const k = key(r)
      sum.set(k, (sum.get(k) ?? 0) + v[i]!)
      n.set(k, (n.get(k) ?? 0) + 1)
    })
    let change = 0
    rows.forEach((r, i) => {
      const m = sum.get(key(r))! / n.get(key(r))!
      v[i]! -= m
      change = Math.max(change, Math.abs(m))
    })
    return change
  }
  for (let it = 0; it < maxIter; it += 1) {
    const c = Math.max(demean(y, (r) => r.cell), demean(y, (r) => r.run), demean(d, (r) => r.cell), demean(d, (r) => r.run))
    if (c < tol) break
  }
  const dd = d.reduce((s, v) => s + v * v, 0)
  if (dd < 1e-12) return null
  return d.reduce((s, v, i) => s + v * y[i]!, 0) / dd
}

export function mulberry32(a: number): () => number {
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface QRows {
  /** 층(브랜드 × 군). */
  stratum: string
  question: string
  rows: Row[]
}

/** 질문 단위 부트스트랩 — 층마다 질문을 복원 추출하고, 뽑힌 사본마다 칸 이름을 새로 붙여 다시 추정한다. */
export function bootstrapCI(units: QRows[], reps: number, seed: number): { lo: number; hi: number; draws: number } | null {
  const rand = mulberry32(seed)
  const strata = new Map<string, QRows[]>()
  for (const u of units) strata.set(u.stratum, [...(strata.get(u.stratum) ?? []), u])
  const thetas: number[] = []
  for (let b = 0; b < reps; b += 1) {
    const rows: Row[] = []
    for (const qs of strata.values()) {
      for (let k = 0; k < qs.length; k += 1) {
        const u = qs[Math.floor(rand() * qs.length)]!
        for (const r of u.rows) rows.push({ ...r, cell: `${k}|${r.cell}` })
      }
    }
    const t = twoWayFE(rows)
    if (t !== null) thetas.push(t)
  }
  if (thetas.length < reps * 0.9) return null
  thetas.sort((a, b) => a - b)
  const at = (p: number) => thetas[Math.min(thetas.length - 1, Math.max(0, Math.floor(p * thetas.length)))]!
  return { lo: at(0.025), hi: at(0.975), draws: thetas.length }
}

/** 한 방향 분산분석 ICC(1) — 같은 질문 안 응답들의 상관. 질문이 둘 미만이거나 분산이 없으면 null. */
export function icc(groups: number[][]): number | null {
  const gs = groups.filter((g) => g.length > 0)
  const k = gs.length
  const N = gs.reduce((s, g) => s + g.length, 0)
  if (k < 2 || N <= k) return null
  const grand = gs.flat().reduce((s, v) => s + v, 0) / N
  const ssb = gs.reduce((s, g) => s + g.length * (g.reduce((a, v) => a + v, 0) / g.length - grand) ** 2, 0)
  const ssw = gs.reduce((s, g) => {
    const m = g.reduce((a, v) => a + v, 0) / g.length
    return s + g.reduce((a, v) => a + (v - m) ** 2, 0)
  }, 0)
  const msb = ssb / (k - 1)
  const msw = ssw / (N - k)
  const n0 = (N - gs.reduce((s, g) => s + g.length ** 2, 0) / N) / (k - 1)
  const denom = msb + (n0 - 1) * msw
  return denom > 0 ? (msb - msw) / denom : null
}

/** 칸 규칙(§7) — 사전 마지막 6회 적중 0 → 사후 첫 6회(n) 가운데 ⌈n/2⌉ 이상. 사전 · 사후 응답이 4회 미만이면 null(판정 제외). */
export function cellRule(pre: number[], post: number[]): boolean | null {
  const p = pre.slice(-6)
  const q = post.slice(0, 6)
  if (p.length < 4 || q.length < 4) return null
  return p.every((v) => v === 0) && q.filter((v) => v === 1).length >= Math.ceil(q.length / 2)
}

// ── 가중 고정효과 ────────────────────────────────────────────────────────────
export interface WRow {
  y: number
  /** 처치 항(여럿이면 주별 계수). */
  d: number[]
  w: number
  cell: string
  run: string
}

function groupIndex(keys: string[]): { idx: Int32Array; n: number } {
  const map = new Map<string, number>()
  const idx = new Int32Array(keys.length)
  keys.forEach((k, i) => {
    let g = map.get(k)
    if (g === undefined) {
      g = map.size
      map.set(k, g)
    }
    idx[i] = g
  })
  return { idx, n: map.size }
}

/** 작은 연립방정식(부분 피벗 가우스 소거). 특이하면 null. */
export function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length
  const m = A.map((row, i) => [...row, b[i]!])
  for (let c = 0; c < n; c += 1) {
    let p = c
    for (let r = c + 1; r < n; r += 1) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r
    if (Math.abs(m[p]![c]!) < 1e-12) return null
    ;[m[c], m[p]] = [m[p]!, m[c]!]
    for (let r = 0; r < n; r += 1) {
      if (r === c) continue
      const f = m[r]![c]! / m[c]![c]!
      for (let k = c; k <= n; k += 1) m[r]![k]! -= f * m[c]![k]!
    }
  }
  return m.map((row, i) => row[n]! / row[i]!)
}

/**
 * 가중 두 방향 고정효과 — 칸 · 회차 고정효과를 가중 평균으로 번갈아 빼고(Frisch–Waugh–Lovell) 처치 항들의 계수를 구한다.
 * 변동이 없는 처치 항의 계수는 null(나머지는 그대로 푼다). 자료가 없으면 null.
 */
export function weightedFE(rows: WRow[], maxIter = 5000, tol = 1e-11): (number | null)[] | null {
  const n = rows.length
  if (!n) return null
  const k = rows[0]!.d.length
  const cell = groupIndex(rows.map((r) => r.cell))
  const run = groupIndex(rows.map((r) => r.run))
  const w = Float64Array.from(rows, (r) => r.w)
  const cw = new Float64Array(cell.n)
  const rw = new Float64Array(run.n)
  for (let i = 0; i < n; i += 1) {
    cw[cell.idx[i]!]! += w[i]!
    rw[run.idx[i]!]! += w[i]!
  }
  const sweep = (v: Float64Array, g: { idx: Int32Array; n: number }, gw: Float64Array) => {
    const s = new Float64Array(g.n)
    for (let i = 0; i < n; i += 1) s[g.idx[i]!]! += w[i]! * v[i]!
    let change = 0
    for (let j = 0; j < g.n; j += 1) {
      s[j]! /= gw[j]!
      change = Math.max(change, Math.abs(s[j]!))
    }
    for (let i = 0; i < n; i += 1) v[i]! -= s[g.idx[i]!]!
    return change
  }
  const resid = (v: Float64Array) => {
    for (let it = 0; it < maxIter; it += 1) if (Math.max(sweep(v, cell, cw), sweep(v, run, rw)) < tol) break
    return v
  }
  const ty = resid(Float64Array.from(rows, (r) => r.y))
  const td = Array.from({ length: k }, (_, j) => resid(Float64Array.from(rows, (r) => r.d[j]!)))
  const dot = (a: Float64Array, b: Float64Array) => {
    let s = 0
    for (let i = 0; i < n; i += 1) s += w[i]! * a[i]! * b[i]!
    return s
  }
  const live = td.map((v, j) => j).filter((j) => dot(td[j]!, td[j]!) > 1e-10)
  if (!live.length) return td.map(() => null)
  const beta = solve(
    live.map((a) => live.map((b) => dot(td[a]!, td[b]!))),
    live.map((a) => dot(td[a]!, ty)),
  )
  if (!beta) return null
  return td.map((_, j) => (live.includes(j) ? beta[live.indexOf(j)]! : null))
}

/** 무작위화 추론 단측 p — (다시 뽑은 θ ≥ 실제 θ인 수 + 1) / (다시 뽑은 수 + 1). 계산 못 한 다시 뽑기는 뺀다. */
export function riPValue(observed: number, alternatives: (number | null)[]): { p: number; draws: number } {
  const alts = alternatives.filter((a): a is number => a !== null)
  return { p: (alts.filter((a) => a >= observed - 1e-12).length + 1) / (alts.length + 1), draws: alts.length }
}

/** 차수 게시 시각에 대한 회차 위치(§7) — 첫 글 전에 끝났으면 사전, 마지막 글 뒤에 시작했으면 사후, 그 사이면 뺀다. */
export function periodOf(run: RunMeta, firstPost: string, lastPost: string): 'pre' | 'post' | 'between' {
  if (Date.parse(run.finishedAt) < Date.parse(firstPost)) return 'pre'
  if (Date.parse(run.startedAt) > Date.parse(lastPost)) return 'post'
  return 'between'
}

/** 게시 후 몇째 주(0 = 0~7일, 1 = 7~14일 …). */
export function weekAfter(run: RunMeta, lastPost: string): number {
  return Math.floor((Date.parse(run.startedAt) - Date.parse(lastPost)) / (7 * 86_400_000))
}

/** 추가 글 id — src/lib/extraArticles.ts와 같은 규칙('topic:' + 정렬한 질문 id를 +로). */
export function articleIdOf(questionIds: string[]): string {
  return `topic:${[...questionIds].sort().join('+')}`
}

/** 색인 기록(docs/proof/index-log.csv: 글 주소 · 확인 날짜 · 구글 · Bing) → 주소 키마다 구글 색인이 처음 확인된 날. */
export function indexDates(csv: string): Map<string, string> {
  const out = new Map<string, string>()
  const lines = csv.split(/\r?\n/).filter((l) => l.trim())
  for (const line of lines.slice(1)) {
    const [url, date, google] = line.split(',').map((s) => s.trim())
    const key = url ? postKey(url) : null
    if (!key || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    if (!/^(y|yes|o|1|true|예|색인됨|indexed)$/i.test(google ?? '')) continue
    const prev = out.get(key)
    if (!prev || date < prev) out.set(key, date)
  }
  return out
}

// ── 최종 판독 ────────────────────────────────────────────────────────────────
/** 등록한 측정 조건(§6) — 회차 스코어카드가 이와 다르면 그 회차를 뺀다. */
export const REGISTERED_MODELS = {
  modelsUsed: { openai: 'gpt-6-luna', gemini: 'gemini-3.8-flash (thinking low)', perplexity: 'preset:low' } as Record<string, string>,
  judgeModel: 'claude-sonnet-5-5',
}

interface AssignmentBrand {
  tenantId: string
  bankVersion: string
  pool: { id: string; probe: boolean }[]
  units: { name: string; ids: string[] }[]
  probabilities: { unit: string; round1: number; round2: number; control: number }[]
  labels: string
  rounds: { arm: 'round1' | 'round2'; questionIds: string[]; articles: { questionIds: string[]; channel: string }[]; holdoutSources: string[] }[]
  controlIds: string[]
  analysisUnits: string[][]
  alternativeLabels: string[]
}
interface FinalBrandDesign {
  tenantId: string
  bankVersion: string
  metric: { ownedDomains: string[] }
}
export interface FinalInput {
  dataDir: string
  design: { brands: FinalBrandDesign[] }
  assignment: { brands: AssignmentBrand[] }
  /** 사후 끝(KST 날짜, 그날 포함). */
  until: string
  reps: number
  /** 무작위화 추론에 쓸 다시 뽑기 수(기본 배정표 전부). */
  alternatives?: number
  indexLogCsv?: string | null
  models?: typeof REGISTERED_MODELS
  log?: (line: string) => void
}

type Stack = 'A' | 'B'
/** 응답 하나(정규 회차 · 빠지지 않은 엔진). */
interface Obs {
  brand: string
  q: string
  engine: string
  y: number
  runId: string
  startedAt: string
  date: string
  period: Record<Stack, 'pre' | 'post' | null>
  week: Record<Stack, number | null>
}

export function finalRead(input: FinalInput) {
  const log = input.log ?? (() => {})
  const models = input.models ?? REGISTERED_MODELS
  const warnings: string[] = []
  const obs: Obs[] = []
  const holdoutObs: (Obs & { source: string })[] = []
  const brandInfo = new Map<
    string,
    {
      a: AssignmentBrand
      unitOf: Map<string, number>
      prob: { round1: number; round2: number; control: number }[]
      rounds: Partial<Record<Stack, { first: string; last: string; articleOf: Map<string, string>; urlsOf: Map<string, string[]> }>>
      runs: { runId: string; scheduled: string; supplement: boolean; excluded?: string; droppedEngines: string[] }[]
    }
  >()

  for (const d of input.design.brands) {
    const a = input.assignment.brands.find((b) => b.tenantId === d.tenantId)
    if (!a) throw new Error(`${d.tenantId}: 배정표에 브랜드가 없습니다.`)
    const tenantDir = path.join(input.dataDir, d.tenantId)
    const bank = readJson<{ questions: { questionId: string; probe?: boolean; paraphraseOf?: string }[] }>(
      path.join(tenantDir, 'question-bank', `${d.bankVersion}.json`),
    )
    const holdouts = new Map(bank.questions.filter((q) => q.probe && q.paraphraseOf).map((q) => [q.questionId, q.paraphraseOf!] as const))
    const minQuestions = bank.questions.length - holdouts.size
    const poolIds = new Set(a.pool.map((q) => q.id))
    const unitOf = new Map<string, number>()
    a.units.forEach((u, i) => u.ids.forEach((id) => unitOf.set(id, i)))

    // 게시 시각 — 차수 글마다 올린 기록 가운데 가장 이른 recordedAt(잘못 적은 기록은 뺀다).
    const posts = existsSync(path.join(tenantDir, 'published-posts.json'))
      ? readJson<{ posts: PostRecord[] }>(path.join(tenantDir, 'published-posts.json')).posts
      : []
    const realPosts = posts.filter((p) => p.removedReason !== 'mistake')
    const rounds: Partial<Record<Stack, { first: string; last: string; articleOf: Map<string, string>; urlsOf: Map<string, string[]> }>> = {}
    for (const r of a.rounds) {
      const stack: Stack = r.arm === 'round1' ? 'A' : 'B'
      const articleOf = new Map<string, string>()
      const urlsOf = new Map<string, string[]>()
      const firsts: string[] = []
      for (const art of r.articles) {
        const id = articleIdOf(art.questionIds)
        art.questionIds.forEach((q) => articleOf.set(q, id))
        const mine = realPosts.filter((p) => p.articleId === id)
        urlsOf.set(id, [...new Set(mine.map((p) => p.url))])
        const first = mine.map((p) => p.recordedAt).sort()[0]
        if (first) firsts.push(first)
      }
      if (firsts.length) {
        firsts.sort()
        rounds[stack] = { first: firsts[0]!, last: firsts[firsts.length - 1]!, articleOf, urlsOf }
        if (firsts.length < r.articles.length) warnings.push(`${d.tenantId} ${stack === 'A' ? '1차' : '2차'}: 글 ${r.articles.length}편 가운데 ${firsts.length}편만 올림`)
      }
    }

    // 오염 점검(§9) — 실증 시작 뒤 만든 추가 글이 배정된 글과 다르면 알린다.
    const extrasPath = path.join(tenantDir, 'extra-articles.json')
    if (existsSync(extrasPath)) {
      const assigned = new Set(a.rounds.flatMap((r) => r.articles.map((x) => articleIdOf(x.questionIds))))
      for (const x of readJson<{ articles?: { id: string; createdAt: string; removedAt?: string }[] }>(extrasPath).articles ?? []) {
        if (!x.removedAt && Date.parse(x.createdAt) >= Date.parse('2026-11-02T00:00:00+09:00') && !assigned.has(x.id))
          warnings.push(`${d.tenantId}: 배정표에 없는 추가 글 ${x.id}`)
      }
    }

    // 정규 회차와 제외(§6).
    const runs = loadRuns(input.dataDir, d.tenantId)
    const picks = regularRuns(runs, (r) => plannedAll(r, minQuestions), '2026-11-02', input.until)
    const runInfo: { runId: string; scheduled: string; supplement: boolean; excluded?: string; droppedEngines: string[] }[] = []
    for (const { run, scheduled, supplement } of picks) {
      const info = { runId: run.runId, scheduled, supplement, droppedEngines: [] as string[] } as (typeof runInfo)[number]
      runInfo.push(info)
      const scPath = path.join(run.dir, 'scorecard.json')
      if (!existsSync(scPath)) {
        info.excluded = '스코어카드 없음'
        continue
      }
      const sc = readJson<{ questionBankVersion?: string; modelsUsed?: Record<string, string>; judgeModel?: string }>(scPath)
      // 응답한 엔진의 모델만 견준다 — 엔진이 통째로 빠지면 스코어카드에 그 키가 없고, 그 엔진은 아래 결측 규칙이 뺀다.
      const sameModels =
        Object.entries(sc.modelsUsed ?? {}).every(([e, m]) => models.modelsUsed[e] === m) && sc.judgeModel === models.judgeModel
      if (sc.questionBankVersion !== d.bankVersion) info.excluded = `질문지 판 ${sc.questionBankVersion}`
      else if (!sameModels) info.excluded = `모델 다름(${JSON.stringify(sc.modelsUsed)} · ${sc.judgeModel})`
      if (info.excluded) continue
      // 계획한 엔진까지 — 통째로 실패한 엔진은 응답이 없어도 뺀 엔진으로 적는다.
      const engines = [...new Set([...Object.keys(run.engines ?? {}), ...run.analyses.map((x) => x.engine)])]
      const kept = engines.filter((e) => {
        const seen = new Set(run.analyses.filter((x) => x.engine === e && poolIds.has(x.questionId)).map((x) => x.questionId))
        return seen.size >= 0.9 * poolIds.size
      })
      info.droppedEngines = engines.filter((e) => !kept.includes(e))
      const period = {} as Record<Stack, 'pre' | 'post' | null>
      const week = {} as Record<Stack, number | null>
      const A = rounds.A
      const B = rounds.B
      const pA = A ? periodOf(run, A.first, A.last) : 'pre'
      const pB = B ? periodOf(run, B.first, B.last) : 'pre'
      // 스택 A 사후는 2차 게시 전까지, 스택 B는 2차가 올라가야 생긴다.
      period.A = !A ? null : pA === 'pre' ? 'pre' : pA === 'post' && pB === 'pre' ? 'post' : null
      period.B = !B ? null : pB === 'between' ? null : pB
      week.A = period.A === 'post' ? weekAfter(run, A!.last) : null
      week.B = period.B === 'post' ? weekAfter(run, B!.last) : null
      const keysNow = postKeysAt(posts, run.startedAt)
      for (const x of run.analyses) {
        if (!kept.includes(x.engine)) continue
        const base = {
          brand: d.tenantId,
          q: x.questionId,
          engine: x.engine,
          y: isHit(x, d.metric.ownedDomains, keysNow) ? 1 : 0,
          runId: run.runId,
          startedAt: run.startedAt,
          date: kstDay(run.startedAt).date,
          period,
          week,
        }
        if (poolIds.has(x.questionId)) obs.push(base)
        else if (holdouts.has(x.questionId)) holdoutObs.push({ ...base, source: holdouts.get(x.questionId)! })
      }
    }
    brandInfo.set(d.tenantId, { a, unitOf, prob: a.probabilities, rounds, runs: runInfo })
  }

  // 배정(실제 · 다시 뽑기)에 따라 질문 → 군.
  const armsFrom = (pick: (b: AssignmentBrand) => string) => {
    const m = new Map<string, number>()
    for (const [tenant, info] of brandInfo) {
      const labels = pick(info.a)
      for (const [q, u] of info.unitOf) m.set(`${tenant}|${q}`, Number(labels[u]))
    }
    return m
  }
  const realArms = armsFrom((b) => b.labels)
  const probOf = (o: Obs) => brandInfo.get(o.brand)!.prob[brandInfo.get(o.brand)!.unitOf.get(o.q)!]!

  /** 스택 행 — weighted면 역확률 가중, weekly면 주별 처치 항(0주 · 1주 · 2주 이상). keep으로 질문 · 회차를 거른다. */
  const rowsFor = (
    arms: Map<string, number>,
    opts: { weighted: boolean; weekly?: boolean; cellPrefix?: string; keep?: (o: Obs, stack: Stack) => 'keep' | 'drop' | 'pre-only' },
    source: Obs[] = obs,
  ): WRow[] => {
    const rows: WRow[] = []
    for (const o of source) {
      const arm = arms.get(`${o.brand}|${o.q}`)
      if (arm === undefined) continue
      const p = probOf(o)
      for (const stack of ['A', 'B'] as const) {
        const per = o.period[stack]
        if (!per) continue
        if (stack === 'B' && arm === 0) continue
        const treated = stack === 'A' ? arm === 0 : arm === 1
        const k = opts.keep?.(o, stack) ?? 'keep'
        if (k === 'drop' || (k === 'pre-only' && per === 'post')) continue
        const w = !opts.weighted
          ? 1
          : stack === 'A'
            ? treated
              ? 1 / p.round1
              : 1 / (1 - p.round1)
            : treated
              ? 1 / p.round2
              : 1 / p.control
        const on = treated && per === 'post' ? 1 : 0
        const wk = o.week[stack] ?? 0
        const d = opts.weekly ? [on && wk === 0 ? 1 : 0, on && wk === 1 ? 1 : 0, on && wk >= 2 ? 1 : 0] : [on]
        rows.push({ y: o.y, d, w, cell: `${opts.cellPrefix ?? ''}${stack}|${o.brand}|${o.q}|${o.engine}`, run: `${stack}|${o.brand}|${o.runId}` })
      }
    }
    return rows
  }

  const stacksPresent = (['A', 'B'] as const).filter((s) => obs.some((o) => o.period[s] === 'post'))
  log(`판독 스택: ${stacksPresent.length ? stacksPresent.join(' · ') : '없음(아직 게시 후 회차가 없다)'}`)
  const theta = weightedFE(rowsFor(realArms, { weighted: true }))?.[0] ?? null
  const thetaUnweighted = weightedFE(rowsFor(realArms, { weighted: false }))?.[0] ?? null

  // (1) 무작위화 추론.
  let ri: { p: number; draws: number } | null = null
  if (theta !== null) {
    const n = Math.min(
      input.alternatives ?? Infinity,
      ...[...brandInfo.values()].map((i) => i.a.alternativeLabels.length),
    )
    const alts: (number | null)[] = []
    for (let i = 0; i < n; i += 1) {
      alts.push(weightedFE(rowsFor(armsFrom((b) => b.alternativeLabels[i]!), { weighted: true }))?.[0] ?? null)
      if ((i + 1) % 500 === 0) log(`  무작위화 추론 ${i + 1}/${n}`)
    }
    ri = riPValue(theta, alts)
  }

  // 신뢰구간 — 판독 단위 부트스트랩(브랜드 × 군 층별).
  let ci: { lo: number; hi: number; draws: number } | null = null
  if (theta !== null) {
    const comps: { stratum: string; obs: Obs[] }[] = []
    for (const [tenant, info] of brandInfo) {
      for (const ids of info.a.analysisUnits) {
        const arm = realArms.get(`${tenant}|${ids[0]}`)!
        const set = new Set(ids)
        comps.push({ stratum: `${tenant}|${arm}`, obs: obs.filter((o) => o.brand === tenant && set.has(o.q)) })
      }
    }
    const strata = new Map<string, typeof comps>()
    for (const c of comps) strata.set(c.stratum, [...(strata.get(c.stratum) ?? []), c])
    const rand = mulberry32(20261228)
    const thetas: number[] = []
    for (let b = 0; b < input.reps; b += 1) {
      const rows: WRow[] = []
      for (const list of strata.values()) {
        for (let k = 0; k < list.length; k += 1) {
          const c = list[Math.floor(rand() * list.length)]!
          rows.push(...rowsFor(realArms, { weighted: true, cellPrefix: `${k}|` }, c.obs))
        }
      }
      const t = weightedFE(rows)?.[0]
      if (t !== null && t !== undefined) thetas.push(t)
    }
    if (thetas.length >= input.reps * 0.9) {
      thetas.sort((x, y) => x - y)
      const at = (q: number) => thetas[Math.min(thetas.length - 1, Math.max(0, Math.round(q * (thetas.length - 1))))]!
      ci = { lo: at(0.025), hi: at(0.975), draws: thetas.length }
    }
  }

  // (2) 칸 규칙.
  const series = new Map<string, { stack: Stack; arm: number; pre: { t: string; y: number }[]; post: { t: string; y: number }[] }>()
  for (const o of obs) {
    const arm = realArms.get(`${o.brand}|${o.q}`)!
    for (const stack of ['A', 'B'] as const) {
      const per = o.period[stack]
      if (!per || (stack === 'B' && arm === 0)) continue
      const key = `${stack}|${o.brand}|${o.q}|${o.engine}`
      const s = series.get(key) ?? { stack, arm, pre: [], post: [] }
      s[per].push({ t: o.startedAt, y: o.y })
      series.set(key, s)
    }
  }
  const ruleOf = (s: { pre: { t: string; y: number }[]; post: { t: string; y: number }[] }) =>
    cellRule(
      [...s.pre].sort((x, y) => x.t.localeCompare(y.t)).map((v) => v.y),
      [...s.post].sort((x, y) => x.t.localeCompare(y.t)).map((v) => v.y),
    )
  const treatedCells = [...series.entries()].filter(([, s]) => (s.stack === 'A' ? s.arm === 0 : s.arm === 1) && ruleOf(s) === true).map(([k]) => k)
  const controlMet = new Set<string>()
  for (const [k, s] of series) if (s.arm === 2 && ruleOf(s) === true) controlMet.add(k.slice(2))
  const controlCells = [...controlMet]

  // (3) 게시 후 주별 계수.
  const weekly = weightedFE(rowsFor(realArms, { weighted: true, weekly: true }))

  // 민감도 — 색인일 기준.
  let sensitivity: { theta: number | null; droppedQuestions: string[] } | null = null
  if (input.indexLogCsv) {
    const idx = indexDates(input.indexLogCsv)
    const dropped = new Set<string>()
    const indexOf = (o: Obs, stack: Stack): string | null => {
      const r = brandInfo.get(o.brand)!.rounds[stack]
      const art = r?.articleOf.get(o.q)
      if (!r || !art) return null
      const dates = (r.urlsOf.get(art) ?? []).map((u) => idx.get(postKey(u) ?? '')).filter((x): x is string => !!x)
      return dates.sort()[0] ?? null
    }
    const lastPostDate = new Map<string, string>()
    for (const o of obs) for (const s of ['A', 'B'] as const) if (o.period[s] === 'post') {
      const k = `${o.brand}|${s}`
      if (!lastPostDate.has(k) || o.date > lastPostDate.get(k)!) lastPostDate.set(k, o.date)
    }
    const keep = (o: Obs, stack: Stack): 'keep' | 'drop' | 'pre-only' => {
      const arm = realArms.get(`${o.brand}|${o.q}`)!
      const treated = stack === 'A' ? arm === 0 : arm === 1
      if (!treated) return 'keep'
      const day = indexOf(o, stack)
      const end = lastPostDate.get(`${o.brand}|${stack}`)
      if (!day || (end && day >= end)) {
        dropped.add(`${stack}|${o.brand}|${o.q}`)
        return 'drop'
      }
      return o.period[stack] === 'post' && o.date <= day ? 'drop' : 'keep'
    }
    sensitivity = { theta: weightedFE(rowsFor(realArms, { weighted: true, keep }))?.[0] ?? null, droppedQuestions: [...dropped] }
  }

  // 홀드아웃 — 원래 질문과 나란히(보조).
  const holdouts = [...new Set(holdoutObs.map((h) => `${h.brand}|${h.q}|${h.source}`))].map((key) => {
    const [brand, q, source] = key.split('|') as [string, string, string]
    const arm = realArms.get(`${brand}|${source}`)
    const stack: Stack | null = arm === 0 ? 'A' : arm === 1 ? 'B' : null
    const rate = (list: Obs[], per: 'pre' | 'post') => {
      const xs = stack ? list.filter((o) => o.period[stack] === per) : []
      return { responses: xs.length, hits: xs.filter((o) => o.y === 1).length }
    }
    const h = holdoutObs.filter((o) => o.brand === brand && o.q === q)
    // 원래 질문은 홀드아웃과 같은 회차 · 같은 엔진 응답만 — 홀드아웃은 11-04쯤부터 쟀다.
    const paired = new Set(h.map((o) => `${o.runId}|${o.engine}`))
    const s = obs.filter((o) => o.brand === brand && o.q === source && paired.has(`${o.runId}|${o.engine}`))
    return { brand, holdout: q, source, stack, holdoutPre: rate(h, 'pre'), holdoutPost: rate(h, 'post'), sourcePre: rate(s, 'pre'), sourcePost: rate(s, 'post') }
  })

  const decision = {
    randomization: ri !== null && ri.p < 0.025,
    cells: treatedCells.length >= 2 && controlCells.length <= 1,
    weeks: weekly !== null && weekly[0] != null && weekly[1] != null && weekly[0] > 0 && weekly[1] > 0,
  }
  return {
    until: input.until,
    stacks: stacksPresent,
    theta,
    thetaUnweighted,
    ri,
    ci,
    cells: { treated: treatedCells, control: controlCells },
    weekly: weekly ? { week1: weekly[0], week2: weekly[1], week3plus: weekly[2] } : null,
    sensitivity,
    holdouts,
    decision: { ...decision, effect: decision.randomization && decision.cells && decision.weeks },
    brands: [...brandInfo].map(([tenant, info]) => ({
      tenantId: tenant,
      rounds: Object.fromEntries(Object.entries(info.rounds).map(([s, r]) => [s, { first: r!.first, last: r!.last }])),
      runs: info.runs,
    })),
    warnings,
  }
}

// ── 0차 판독 ─────────────────────────────────────────────────────────────────
interface BrandDesign {
  tenantId: string
  bankVersion: string
  zeroth: { article: string; questionIds: string[] }
  ineligible: { id: string }[]
  metric: { ownedDomains: string[] }
}
export interface LoadedRun extends RunMeta {
  weekOf: string
  /** 회차 기록 폴더(run.json · scorecard.json · question-analyses.json). */
  dir: string
  analyses: Analysis[]
}

function readJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, 'utf8')) as T
}

export function loadRuns(dataDir: string, tenantId: string): LoadedRun[] {
  const tenantDir = path.join(dataDir, tenantId)
  const out: LoadedRun[] = []
  for (const week of readdirSync(tenantDir).filter((w) => /^\d{4}-W\d{2}$/.test(w))) {
    const runsDir = path.join(tenantDir, week, 'runs')
    if (!existsSync(runsDir)) continue
    for (const id of readdirSync(runsDir)) {
      const dir = path.join(runsDir, id)
      if (!existsSync(path.join(dir, 'run.json')) || !existsSync(path.join(dir, 'question-analyses.json'))) continue
      const meta = readJson<RunMeta>(path.join(dir, 'run.json'))
      out.push({ ...meta, runId: id, weekOf: week, dir, analyses: readJson<Analysis[]>(path.join(dir, 'question-analyses.json')) })
    }
  }
  return out.sort((a, b) => a.finishedAt.localeCompare(b.finishedAt))
}

function finalMain(dataDir: string, flag: (name: string) => string | undefined, fail: (msg: string) => never): void {
  // 등록한 사후 끝은 12-28 아침 회차(§5 · §7) — 그 뒤 회차는 넣지 않는다.
  const LAST_FINAL_DAY = '2026-12-28'
  const asked = flag('--until') ?? kstDay(new Date().toISOString()).date
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asked)) fail(`--until은 YYYY-MM-DD여야 합니다: ${asked}`)
  const until = asked > LAST_FINAL_DAY ? LAST_FINAL_DAY : asked
  if (until !== asked) console.log(`사후 끝을 ${asked}에서 ${until}로 줄였습니다(등록한 판독일).`)
  const reps = Number(flag('--bootstrap') ?? 2000)
  if (!Number.isInteger(reps) || reps < 100) fail(`--bootstrap은 100 이상의 정수여야 합니다: ${reps}`)
  const altRaw = flag('--alternatives')
  const alternatives = altRaw === undefined ? undefined : Number(altRaw)
  if (alternatives !== undefined && (!Number.isInteger(alternatives) || alternatives < 1)) fail(`--alternatives는 1 이상의 정수여야 합니다: ${altRaw}`)
  const indexLog = path.resolve(flag('--index-log') ?? 'docs/proof/index-log.csv')
  const outPath = path.resolve(flag('--out') ?? `docs/proof/final-read-${until}.json`)
  const r = finalRead({
    dataDir,
    design: readJson(path.resolve(flag('--design') ?? 'docs/proof/design.json')),
    assignment: readJson(path.resolve(flag('--assignment') ?? 'docs/proof/assignment.json')),
    until,
    reps,
    alternatives,
    indexLogCsv: existsSync(indexLog) ? readFileSync(indexLog, 'utf8') : null,
    log: (line) => console.log(line),
  })
  const pp = (x: number | null | undefined) => (x === null || x === undefined ? '계산 불가' : `${(100 * x).toFixed(1)}%p`)
  for (const b of r.brands) {
    const used = b.runs.filter((x) => !x.excluded)
    console.log(`\n■ ${b.tenantId} — 정규 회차 ${b.runs.length}회(뺀 회차 ${b.runs.length - used.length} · 보충 ${b.runs.filter((x) => x.supplement).length})`)
    for (const [s, p] of Object.entries(b.rounds)) console.log(`  ${s === 'A' ? '1차' : '2차'} 게시 ${p.first} ~ ${p.last}`)
    for (const x of b.runs.filter((x) => x.excluded || x.droppedEngines.length))
      console.log(`  ${x.runId}: ${x.excluded ?? `엔진 뺌 ${x.droppedEngines.join(', ')}`}`)
  }
  console.log(`\n■ 판독(${r.until}까지 · 스택 ${r.stacks.join(' · ') || '없음'})`)
  console.log(`  θ(가중) = ${pp(r.theta)} · 가중 없음 ${pp(r.thetaUnweighted)}${r.ci ? ` · 95% 구간 ${pp(r.ci.lo)} ~ ${pp(r.ci.hi)}` : ''}`)
  console.log(`  (1) 무작위화 추론 단측 p = ${r.ri ? `${r.ri.p.toFixed(4)}(다시 뽑기 ${r.ri.draws}개)` : '계산 불가'} → ${r.decision.randomization ? '충족' : '미충족'}`)
  console.log(`  (2) 칸 규칙: 처치 ${r.cells.treated.length}칸 · 대조 ${r.cells.control.length}칸 → ${r.decision.cells ? '충족' : '미충족'}`)
  console.log(`  (3) 주별: 1주 ${pp(r.weekly?.week1)} · 2주 ${pp(r.weekly?.week2)} → ${r.decision.weeks ? '충족' : '미충족'}`)
  console.log(`  「효과 있음」: ${r.decision.effect ? '예' : '아니오'}`)
  if (r.sensitivity) console.log(`  민감도(색인일): θ = ${pp(r.sensitivity.theta)} · 뺀 질문 ${r.sensitivity.droppedQuestions.length}개`)
  for (const w of r.warnings) console.log(`  ! ${w}`)
  writeFileSync(outPath, JSON.stringify(r, null, 2).replace(/\n/g, '\r\n') + '\r\n')
  console.log(`\n결과: ${outPath}`)
}

function main(): void {
  const args = process.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const fail = (msg: string): never => {
    console.error(msg)
    process.exit(1)
  }
  const mode = args[0]
  const appData = flag('--app-data')
  if ((mode !== 'zeroth' && mode !== 'final') || !appData) {
    fail('사용법: npx tsx scripts/proof-read.ts zeroth|final --app-data <dir> [--until YYYY-MM-DD] [--bootstrap 2000] [--out <파일>]')
  }
  const dataDir = path.join(path.resolve(appData!), 'data')
  if (mode === 'final') {
    finalMain(dataDir, flag, fail)
    return
  }
  const design = readJson<{ brands: BrandDesign[] }>(path.resolve(flag('--design') ?? 'docs/proof/design.json'))
  // 0차 사후는 1차 게시(11-23) 전에서 끝난다 — 그 뒤에는 비교 c1 일부가 1차 처치를 받는다.
  const LAST_ZEROTH_DAY = '2026-11-22'
  const asked = flag('--until') ?? kstDay(new Date().toISOString()).date
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asked)) fail(`--until은 YYYY-MM-DD여야 합니다: ${asked}`)
  const until = asked > LAST_ZEROTH_DAY ? LAST_ZEROTH_DAY : asked
  if (until !== asked) console.log(`사후 끝을 ${asked}에서 ${until}로 줄였습니다(1차 게시 전까지).`)
  const reps = Number(flag('--bootstrap') ?? 2000)
  if (!Number.isInteger(reps) || reps < 100) fail(`--bootstrap은 100 이상의 정수여야 합니다: ${reps}`)
  const outPath = path.resolve(flag('--out') ?? 'docs/proof/zeroth-read.json')

  const allUnits: QRows[] = []
  const report: Record<string, unknown>[] = []
  for (const b of design.brands) {
    const bank = readJson<{ questions: { questionId: string; category?: string; probe?: boolean; paraphraseOf?: string }[] }>(
      path.join(dataDir, b.tenantId, 'question-bank', `${b.bankVersion}.json`),
    )
    const zeroth = new Set(b.zeroth.questionIds)
    const ineligible = new Set(b.ineligible.map((e) => e.id))
    const control = bank.questions
      .filter((q) => q.category === 'category-agnostic' && !q.probe && !zeroth.has(q.questionId) && !ineligible.has(q.questionId))
      .map((q) => q.questionId)
    const posts = readJson<{ posts: PostRecord[] }>(path.join(dataDir, b.tenantId, 'published-posts.json')).posts
    const zerothPostAt = posts
      .filter((p) => p.articleId === b.zeroth.article && p.removedReason !== 'mistake')
      .map((p) => p.recordedAt)
      .sort()[0]
    if (!zerothPostAt) fail(`${b.tenantId}: 0차 글(${b.zeroth.article})의 올린 기록이 없습니다.`)

    const runs = loadRuns(dataDir, b.tenantId)
    const pre = runs.filter((r) => ['2026-W43', '2026-W44'].includes(r.weekOf) && r.finishedAt < zerothPostAt!)
    // 대상 질문을 모두 계획에 넣은 회차 — 계획 수가 홀드아웃을 뺀 지금 질문지 문항 수 이상(실증을 덧붙인 11-02 오후부터).
    const minQuestions = bank.questions.filter((q) => !(q.probe && q.paraphraseOf)).length
    const postPicks = regularRuns(runs, (r) => plannedAll(r, minQuestions), '2026-11-02', until)
    const post = postPicks.map((p) => p.run)

    const groupOf = (id: string) => (zeroth.has(id) ? 'treated' : control.includes(id) ? 'control' : null)
    const byQuestion = new Map<string, QRows>()
    const tally: Record<string, { responses: number; hits: number }> = {}
    const cellSeries = new Map<string, { group: string; pre: number[]; post: number[] }>()
    for (const [period, list] of [['pre', pre], ['post', post]] as const) {
      for (const r of list) {
        const postKeys = postKeysAt(posts, r.startedAt)
        for (const a of r.analyses) {
          const group = groupOf(a.questionId)
          if (!group) continue
          const y = isHit(a, b.metric.ownedDomains, postKeys) ? 1 : 0
          const cell = `${b.tenantId}|${a.questionId}|${a.engine}`
          const row: Row = { y, d: group === 'treated' && period === 'post' ? 1 : 0, cell, run: `${b.tenantId}|${r.runId}` }
          const qKey = `${b.tenantId}|${a.questionId}`
          const unit = byQuestion.get(qKey) ?? { stratum: `${b.tenantId}|${group}`, question: qKey, rows: [] }
          unit.rows.push(row)
          byQuestion.set(qKey, unit)
          const t = (tally[`${group}|${period}`] ??= { responses: 0, hits: 0 })
          t.responses += 1
          t.hits += y
          const s = cellSeries.get(cell) ?? { group, pre: [], post: [] }
          s[period].push(y)
          cellSeries.set(cell, s)
        }
      }
    }
    const units = [...byQuestion.values()]
    allUnits.push(...units)
    const rows = units.flatMap((u) => u.rows)
    const theta = twoWayFE(rows)
    const ci = theta === null ? null : bootstrapCI(units, reps, 20261120)
    const preGroups = units.map((u) => u.rows.filter((r) => pre.some((p) => `${b.tenantId}|${p.runId}` === r.run)).map((r) => r.y))
    const cells = [...cellSeries.values()].map((s) => ({ group: s.group, rule: cellRule(s.pre, s.post) }))
    const cellCount = (group: string) => ({
      met: cells.filter((c) => c.group === group && c.rule === true).length,
      judged: cells.filter((c) => c.group === group && c.rule !== null).length,
    })
    report.push({
      tenantId: b.tenantId,
      zerothPostAt,
      treated: [...zeroth],
      control,
      preRuns: pre.map((r) => r.runId),
      postRuns: postPicks.map((p) => ({ runId: p.run.runId, scheduled: p.scheduled, supplement: p.supplement })),
      tally,
      theta,
      ci,
      iccPre: icc(preGroups),
      cells: { treated: cellCount('treated'), control: cellCount('control') },
    })

    const rate = (k: string) => (tally[k] ? `${tally[k].hits}/${tally[k].responses} (${((100 * tally[k].hits) / tally[k].responses).toFixed(1)}%)` : '—')
    console.log(`\n■ ${b.tenantId} — 0차 첫 게시 ${zerothPostAt} · 사전 ${pre.length}회 · 사후 ${post.length}회(${until}까지)`)
    console.log(`  처치(0차 ${zeroth.size}개)  사전 ${rate('treated|pre')}  사후 ${rate('treated|post')}`)
    console.log(`  비교(c1 ${control.length}개)  사전 ${rate('control|pre')}  사후 ${rate('control|post')}`)
    console.log(`  이중차분 θ = ${theta === null ? '계산 불가' : (100 * theta).toFixed(1) + '%p'}${ci ? ` · 95% 구간 ${(100 * ci.lo).toFixed(1)} ~ ${(100 * ci.hi).toFixed(1)}%p` : ''}`)
    console.log(`  ICC(사전) = ${report.at(-1)!.iccPre === null ? '계산 불가' : (report.at(-1)!.iccPre as number).toFixed(3)}`)
    console.log(`  칸 규칙: 처치 ${cellCount('treated').met}/${cellCount('treated').judged} · 비교 ${cellCount('control').met}/${cellCount('control').judged}`)
  }

  const pooled = twoWayFE(allUnits.flatMap((u) => u.rows))
  const pooledCi = pooled === null ? null : bootstrapCI(allUnits, reps, 20261121)
  console.log(
    `\n■ 두 브랜드 합침 — θ = ${pooled === null ? '계산 불가' : (100 * pooled).toFixed(1) + '%p'}${pooledCi ? ` · 95% 구간 ${(100 * pooledCi.lo).toFixed(1)} ~ ${(100 * pooledCi.hi).toFixed(1)}%p` : ''}`,
  )
  console.log('  참고용 — 0차는 사람이 고른 질문이라 판정 · 고객용 결론에 쓰지 않는다(§8).')
  const out = { format: 'proof-zeroth-read/1', until, bootstrap: reps, brands: report, pooled: { theta: pooled, ci: pooledCi } }
  writeFileSync(outPath, JSON.stringify(out, null, 2).replace(/\n/g, '\r\n') + '\r\n')
  console.log(`\n결과: ${outPath}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
