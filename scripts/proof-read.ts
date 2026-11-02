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

// ── 0차 판독 ─────────────────────────────────────────────────────────────────
interface BrandDesign {
  tenantId: string
  bankVersion: string
  zeroth: { article: string; questionIds: string[] }
  ineligible: { id: string }[]
  metric: { ownedDomains: string[] }
}
interface Post {
  url: string
  recordedAt: string
  articleId?: string
  removedAt?: string
}
interface LoadedRun extends RunMeta {
  weekOf: string
  analyses: Analysis[]
}

function readJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, 'utf8')) as T
}

function loadRuns(dataDir: string, tenantId: string): LoadedRun[] {
  const tenantDir = path.join(dataDir, tenantId)
  const out: LoadedRun[] = []
  for (const week of readdirSync(tenantDir).filter((w) => /^\d{4}-W\d{2}$/.test(w))) {
    const runsDir = path.join(tenantDir, week, 'runs')
    if (!existsSync(runsDir)) continue
    for (const id of readdirSync(runsDir)) {
      const dir = path.join(runsDir, id)
      if (!existsSync(path.join(dir, 'run.json')) || !existsSync(path.join(dir, 'question-analyses.json'))) continue
      const meta = readJson<RunMeta>(path.join(dir, 'run.json'))
      out.push({ ...meta, runId: id, weekOf: week, analyses: readJson<Analysis[]>(path.join(dir, 'question-analyses.json')) })
    }
  }
  return out.sort((a, b) => a.finishedAt.localeCompare(b.finishedAt))
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
  if (mode !== 'zeroth' || !appData) {
    fail('사용법: npx tsx scripts/proof-read.ts zeroth --app-data <dir> [--until YYYY-MM-DD] [--bootstrap 2000] [--out <파일>]')
  }
  const dataDir = path.join(path.resolve(appData!), 'data')
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
    const posts = readJson<{ posts: Post[] }>(path.join(dataDir, b.tenantId, 'published-posts.json')).posts.filter((p) => !p.removedAt)
    const postKeys = new Set(posts.map((p) => postKey(p.url)).filter((k): k is string => k !== null))
    const zerothPostAt = posts
      .filter((p) => p.articleId === b.zeroth.article)
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
