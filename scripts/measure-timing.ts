/**
 * 측정 한 주차가 어디서 시간을 썼는지 단계별로 가른다.
 *
 * 코호트를 병렬로 재면 브랜드마다 끝나는 시각이 크게 벌어진다(2026-W38 화학 6곳: 3분 17초 ~
 * 6분 44초). 원인은 둘 중 하나인데 겉으로는 구분이 안 된다.
 *
 *   큐에서 기다렸다   전역 슬롯(수집 24 · 판정 48)을 6곳이 나눠 쓴다 → 동시성 문제
 *   API가 느렸다      모델 지연·SDK 내부 재시도 → 동시성을 올려도 안 빨라진다
 *
 * 전역 슬롯은 client.call 바깥에서 잡으므로(engines/index.ts의 limited) latencyMs에는 대기가
 * 안 들어간다. 그래서 기록된 시각과 지연의 차이가 곧 대기다.
 *
 *   수집  calledAt(끝난 시각) - startedAt(큐에 들어간 시각) - latencyMs
 *   분석  timing.wallMs - max(timing.judgeMs)      ← 판정 4건은 병렬이라 합이 아니라 최대값
 *
 * 두 필드 모두 v0.1.97부터 남는다. 그 전 주차는 "기록 없음"으로 표시된다.
 *
 *   npx tsx scripts/measure-timing.ts                        # repo의 data/
 *   npx tsx scripts/measure-timing.ts --week 2026-W38
 *   npx tsx scripts/measure-timing.ts "%APPDATA%\brand-aeo-app"
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

type RawCallRecord = import('../server/types').RawCallRecord
type QuestionRepeatAnalysis = import('../server/types').QuestionRepeatAnalysis

const args = process.argv.slice(2)

/** 셸이 확장하지 못한 환경변수 토큰을 직접 푼다(PowerShell은 %VAR%를, cmd는 $env:VAR를 못 푼다). */
function expandEnvTokens(input: string): string {
  return input
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name: string) => process.env[name] ?? m)
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/g, (m, name: string) => process.env[name] ?? m)
}

const rawArg = args.find((a) => !a.startsWith('--'))
const root = path.join(rawArg ? expandEnvTokens(rawArg) : process.cwd(), 'data')
const weekArg = args[args.indexOf('--week') + 1]
const week = args.includes('--week') && weekArg ? weekArg : null

if (!existsSync(root)) {
  console.error(`데이터 폴더가 없습니다: ${root}`)
  process.exit(1)
}

const readJson = <T,>(p: string): T | null => {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T
  } catch {
    return null
  }
}
const ms = (s: string) => Date.parse(s)
const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : 0)
const p95 = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)]! : 0)
const sec = (n: number) => `${Math.round(n / 1000)}s`
/** 한글은 터미널에서 두 칸을 먹는다 — 문자 수로 세면 열이 어긋난다. */
const width = (s: string) => [...s].reduce((w, ch) => w + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1), 0)
const pad = (s: string, n: number) => ' '.repeat(Math.max(0, n - width(s))) + s
const padR = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - width(s)))

/** 주차 폴더를 가진 테넌트를 모은다. */
const tenants = readdirSync(root).filter((d) => statSync(path.join(root, d)).isDirectory())
const weeks = new Set<string>()
for (const t of tenants) {
  for (const w of readdirSync(path.join(root, t))) {
    if (/^\d{4}-W\d{2}$/.test(w)) weeks.add(w)
  }
}
const target = week ?? [...weeks].sort().pop()
if (!target) {
  console.error('주차 폴더를 찾지 못했습니다.')
  process.exit(1)
}

type Row = {
  tenantId: string
  collectSpan: number
  collectApi: number
  collectWait: number
  collectWaitP95: number
  analyzeSpan: number
  analyzeApi: number
  analyzeWait: number
  analyzeWaitP95: number
  total: number
  legacy: boolean
}

const rows: Row[] = []
for (const t of tenants) {
  const dir = path.join(root, t, target)
  const calls = readJson<RawCallRecord[]>(path.join(dir, 'raw-calls.json'))
  const analyses = readJson<QuestionRepeatAnalysis[]>(path.join(dir, 'question-analyses.json'))
  if (!calls?.length) continue

  const cStart = calls.map((c) => (c.startedAt ? ms(c.startedAt) : NaN)).filter((n) => !Number.isNaN(n))
  const cEnd = calls.map((c) => ms(c.calledAt))
  const cWait = calls
    .filter((c) => c.startedAt && c.latencyMs != null)
    .map((c) => Math.max(0, ms(c.calledAt) - ms(c.startedAt!) - c.latencyMs!))

  const timed = (analyses ?? []).filter((a) => a.timing)
  const aStart = timed.map((a) => ms(a.timing!.startedAt))
  const aEnd = timed.map((a) => ms(a.timing!.startedAt) + a.timing!.wallMs)
  const aWait = timed.map((a) => {
    const j = a.timing!.judgeMs
    return Math.max(0, a.timing!.wallMs - Math.max(j.mention, j.rank, j.citation ?? 0, j.fact ?? 0))
  })
  const aApi = timed.map((a) => {
    const j = a.timing!.judgeMs
    return Math.max(j.mention, j.rank, j.citation ?? 0, j.fact ?? 0)
  })

  const first = cStart.length ? Math.min(...cStart) : Math.min(...cEnd)
  const last = aEnd.length ? Math.max(...aEnd) : Math.max(...cEnd)
  rows.push({
    tenantId: t,
    collectSpan: Math.max(...cEnd) - first,
    collectApi: med(calls.map((c) => c.latencyMs ?? 0)),
    collectWait: med(cWait),
    collectWaitP95: p95(cWait),
    analyzeSpan: aEnd.length ? Math.max(...aEnd) - Math.min(...aStart) : 0,
    analyzeApi: med(aApi),
    analyzeWait: med(aWait),
    analyzeWaitP95: p95(aWait),
    total: last - first,
    legacy: cStart.length === 0 || timed.length === 0,
  })
}

if (!rows.length) {
  console.error(`${target} 주차의 측정 기록이 없습니다.`)
  process.exit(1)
}
rows.sort((a, b) => a.total - b.total)

console.log(`\n${target} · ${rows.length}개 브랜드 · ${root}\n`)
console.log(
  [padR('브랜드', 18), pad('전체', 10), pad('수집구간', 10), pad('API중앙', 10), pad('대기중앙', 10), pad('대기p95', 10), pad('분석구간', 10), pad('API중앙', 10), pad('대기중앙', 10), pad('대기p95', 10)].join(''),
)
console.log('-'.repeat(108))
for (const r of rows) {
  console.log(
    [
      padR(r.tenantId + (r.legacy ? ' *' : ''), 18),
      pad(sec(r.total), 10),
      pad(sec(r.collectSpan), 10),
      pad(sec(r.collectApi), 10),
      pad(sec(r.collectWait), 10),
      pad(sec(r.collectWaitP95), 10),
      pad(r.analyzeSpan ? sec(r.analyzeSpan) : '-', 10),
      pad(r.analyzeApi ? sec(r.analyzeApi) : '-', 10),
      pad(r.analyzeWait ? sec(r.analyzeWait) : '-', 10),
      pad(r.analyzeWaitP95 ? sec(r.analyzeWaitP95) : '-', 10),
    ].join(''),
  )
}

if (rows.some((r) => r.legacy)) {
  console.log('\n* v0.1.97 이전 기록 — startedAt/timing이 없어 대기를 뺄 수 없습니다.')
}

// 가장 빠른 브랜드와 가장 느린 브랜드의 차이가 어디서 왔는지 한 줄로 말한다.
const fast = rows[0]!
const slow = rows[rows.length - 1]!
if (rows.length > 1 && !fast.legacy && !slow.legacy) {
  const gap = slow.total - fast.total
  const byWait = slow.collectWait - fast.collectWait + (slow.analyzeWait - fast.analyzeWait)
  const byApi = slow.collectApi - fast.collectApi + (slow.analyzeApi - fast.analyzeApi)
  console.log(
    `\n가장 느린 ${slow.tenantId}는 ${fast.tenantId}보다 ${sec(gap)} 더 걸렸습니다 ` +
      `(호출 1건당 대기 ${byWait >= 0 ? '+' : ''}${sec(byWait)} · API ${byApi >= 0 ? '+' : ''}${sec(byApi)}).`,
  )
  console.log(
    byWait > byApi
      ? '→ 큐에서 기다린 시간이 더 큽니다. 동시성 상한(COLLECT_LLM_CONCURRENCY · JUDGE_LLM_CONCURRENCY)을 보세요.'
      : '→ API 왕복 자체가 더 느렸습니다. 동시성을 올려도 안 빨라집니다.',
  )
}
console.log()
