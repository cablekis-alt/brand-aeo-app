/**
 * AEO 가시성 실증의 무작위 배정 — 이름 없는 질문을 의미 묶음 단위로 1차 처치 · 2차 처치 · 대조로 나누고, 처치 질문으로 쓸 글과
 * 올릴 곳, 홀드아웃(바꿔 쓸 실증 질문)을 정한다. 설계(docs/proof/design.json)와 사전 등록 문서는 배정을 돌리기 전에 커밋한다.
 *
 *   npx tsx scripts/proof-assign.ts --app-data "<userData>" --check                 # 단위별 처치 확률만(실제 배정 안 함)
 *   npx tsx scripts/proof-assign.ts --app-data "<userData>" [--design docs/proof/design.json] [--out docs/proof/assignment.json]
 *
 * 읽기만 한다(질문지). 같은 설계 · 같은 질문지면 같은 파일이 나온다(시각을 적지 않는다).
 *
 * 규칙:
 *   - 대상: 설계의 bankVersion 질문지에서 이름 없는 질문(category-agnostic) 가운데 zeroth(0차 글이 맡은 질문) · ineligible(사실과
 *     맞지 않아 글로 답할 수 없는 질문) · 홀드아웃(paraphraseOf가 있는 실증)을 뺀 것. 0차는 id로 고정한다 — 「목록에서 빼기」 같은
 *     나중 조작으로 대상이 바뀌지 않게.
 *   - 단위: 설계의 clusters(의미가 거의 같아 한 글이 함께 답할 질문 묶음)는 한 단위, 나머지 질문은 하나씩 한 단위.
 *   - 뽑기: 단위마다 1차 · 2차 · 대조를 1/3씩 독립으로 뽑고, 아래 조건을 만족하는 첫 뽑기를 쓴다(조건을 만족하는 배정 가운데
 *     어느 것이든 같은 확률). 조건: 1차 · 2차 질문 수가 armSize ± 1, 군마다 실증 질문 holdoutsPerArm개 이상.
 *   - 처치 확률: 같은 절차를 따로 정한 난수로 probabilityDraws번 돌려 단위마다 1차 · 2차 · 대조 확률을 구한다. 어느 하나라도
 *     minProbability보다 작으면 멈춘다(구조적으로 한 군에 고정되는 단위가 없게).
 *   - 다시 뽑기: 같은 절차로 alternatives번 더 뽑아 남긴다 — 무작위화 추론(판독에서 실제 배정의 효과를 이 분포와 견준다).
 *   - 글: 군 안에서 같은 단위 질문끼리 먼저 둘씩, 남은 질문은 난수로 섞어 둘씩 짝짓는다. 질문 수가 홀수면 마지막 글이 셋을 맡는다.
 *     올릴 곳은 자사 사이트 · 티스토리 반씩(홀수 편이면 남는 한 편은 난수) 정한 뒤 섞어 나눈다.
 *   - 홀드아웃: 군마다 실증 질문 holdoutsPerArm개를 난수로 고른다. 글 · 브리프에는 넣지 않는다.
 *   - 판독 단위: 같은 단위이거나 같은 글로 묶인 질문은 한 판독 단위다(부트스트랩 재표집 단위).
 *   - 난수: mulberry32. 실제 배정은 FNV-1a("<seed>:<tenantId>"), 확률은 FNV-1a("probability:<tenantId>"),
 *     다시 뽑기 i번째는 FNV-1a("alternative:<i>:<tenantId>").
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const USAGE = '사용법: npx tsx scripts/proof-assign.ts --app-data <dir> [--check] [--design docs/proof/design.json] [--out <파일>]'
function fail(...lines: string[]): never {
  for (const line of lines) console.error(line)
  process.exit(1)
}

interface BrandDesign {
  tenantId: string
  bankVersion: string
  /** 1차 · 2차 처치 군의 목표 질문 수(±1 허용). */
  armSize: number
  /** 0차 — 실증 전에 만든 추가 글이 맡은 질문. */
  zeroth: { article: string; questionIds: string[] }
  /** 대상에서 뺄 질문과 이유. */
  ineligible: { id: string; reason: string }[]
  /** 의미 묶음 — 한 단위로 배정한다. */
  clusters: { name: string; ids: string[] }[]
}
interface Design {
  seed: number
  holdoutsPerArm: number
  probabilityDraws: number
  minProbability: number
  alternatives: number
  brands: BrandDesign[]
}

const rawAppData = flag('--app-data')
if (!rawAppData) fail(USAGE)
const checkOnly = args.includes('--check')
const designPath = path.resolve(flag('--design') ?? 'docs/proof/design.json')
if (!existsSync(designPath)) fail(`설계 파일이 없습니다: ${designPath}`)
const design = JSON.parse(readFileSync(designPath, 'utf8')) as Design
const { seed, holdoutsPerArm, probabilityDraws, minProbability, alternatives } = design
for (const [name, v] of Object.entries({ seed, holdoutsPerArm, probabilityDraws, alternatives })) {
  if (!Number.isInteger(v) || v < 0) fail(`${name}는 0 이상의 정수여야 합니다: ${v}`)
}
if (probabilityDraws < 1) fail('probabilityDraws는 1 이상이어야 합니다 — 0이면 확률 점검이 조용히 꺼진다.')
if (!(minProbability >= 0 && minProbability < 1 / 3)) fail(`minProbability는 0 이상 1/3 미만이어야 합니다: ${minProbability}`)
for (const b of design.brands) {
  if (!Number.isInteger(b.armSize) || b.armSize < 2) fail(`${b.tenantId}: armSize는 2 이상의 정수여야 합니다: ${b.armSize}`)
}
const outPath = path.resolve(flag('--out') ?? 'docs/proof/assignment.json')
const appData = path.resolve(rawAppData)
if (!existsSync(appData)) fail(`앱 데이터 폴더가 없습니다: ${appData}`)

const { isProbe } = await import('../src/lib/questionScope')
type QuestionSpec = import('../src/prompts/types').QuestionSpec

const MAX_ATTEMPTS = 1_000_000

// ── 난수 ────────────────────────────────────────────────────────────────────
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (const ch of Buffer.from(s, 'utf8')) {
    h ^= ch
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}
function mulberry32(a: number): () => number {
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const a = [...items]
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

// ── 배정 ────────────────────────────────────────────────────────────────────
interface PoolQuestion {
  id: string
  text: string
  stage: string
  probe: boolean
}
interface Unit {
  name: string
  questions: PoolQuestion[]
}
const ARMS = ['round1', 'round2', 'control'] as const
type Arm = (typeof ARMS)[number]
const ARM_LABEL: Record<Arm, string> = { round1: '1차', round2: '2차', control: '대조' }

/** 조건을 만족하는 뽑기 하나 — 단위마다 군 번호(0 = 1차, 1 = 2차, 2 = 대조). */
function drawAllocation(units: Unit[], armSize: number, rand: () => number): { labels: number[]; attempt: number } {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const labels = units.map(() => Math.floor(rand() * 3))
    const ok = [0, 1].every((arm) => {
      const qs = units.flatMap((u, i) => (labels[i] === arm ? u.questions : []))
      return Math.abs(qs.length - armSize) <= 1 && qs.filter((q) => q.probe).length >= holdoutsPerArm
    })
    if (ok) return { labels, attempt }
  }
  return fail(`${MAX_ATTEMPTS}번 뽑아도 조건(군 크기 ${armSize}±1 · 실증 ${holdoutsPerArm}개 이상)을 만족하는 배정이 없습니다.`)
}

/** 군 안에서 같은 단위끼리 먼저 둘씩, 남은 질문은 섞어 둘씩. 홀수면 마지막 글이 셋. */
function articlesOf(armUnits: Unit[], rand: () => number): PoolQuestion[][] {
  const groups: PoolQuestion[][] = []
  const rest: PoolQuestion[] = []
  for (const u of armUnits) {
    let i = 0
    for (; i + 1 < u.questions.length; i += 2) groups.push([u.questions[i]!, u.questions[i + 1]!])
    if (i < u.questions.length) rest.push(u.questions[i]!)
  }
  const mixed = shuffle(rest, rand)
  for (let i = 0; i + 1 < mixed.length; i += 2) groups.push([mixed[i]!, mixed[i + 1]!])
  if (mixed.length % 2) {
    const last = mixed[mixed.length - 1]!
    if (groups.length) groups[groups.length - 1]!.push(last)
    else groups.push([last])
  }
  return groups
}

/** 글 n편의 채널 — 자사 사이트 · 티스토리 반씩, 홀수면 남는 한 편은 난수로. 순서는 섞는다. */
function channelsOf(n: number, rand: () => number): string[] {
  const half = Math.floor(n / 2)
  const base = [...Array<string>(half).fill('자사 사이트'), ...Array<string>(half).fill('티스토리')]
  if (n % 2) base.push(rand() < 0.5 ? '자사 사이트' : '티스토리')
  return shuffle(base, rand)
}

/** 같은 단위이거나 같은 글로 묶인 질문을 합친 판독 단위(연결 성분). */
function analysisUnitsOf(units: Unit[], articles: string[][]): string[][] {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    const p = parent.get(x) ?? x
    if (p === x) return x
    const r = find(p)
    parent.set(x, r)
    return r
  }
  const union = (a: string, b: string) => parent.set(find(a), find(b))
  for (const u of units) for (const q of u.questions) parent.set(q.id, q.id)
  for (const u of units) for (const q of u.questions.slice(1)) union(u.questions[0]!.id, q.id)
  for (const a of articles) for (const id of a.slice(1)) union(a[0]!, id)
  const byRoot = new Map<string, string[]>()
  for (const id of parent.keys()) byRoot.set(find(id), [...(byRoot.get(find(id)) ?? []), id])
  return [...byRoot.values()].map((ids) => ids.sort()).sort((a, b) => a[0]!.localeCompare(b[0]!))
}

// ── 브랜드마다 ───────────────────────────────────────────────────────────────
const brands = []
for (const b of design.brands) {
  const { tenantId, bankVersion, armSize } = b
  const bankPath = path.join(appData, 'data', tenantId, 'question-bank', `${bankVersion}.json`)
  if (!existsSync(bankPath)) fail(`질문지가 없습니다: ${bankPath}`)
  const questions = (JSON.parse(readFileSync(bankPath, 'utf8')) as { questions: QuestionSpec[] }).questions
  const unnamed = questions.filter((q) => q.category === 'category-agnostic')
  const unnamedIds = new Set(unnamed.map((q) => q.questionId))
  const notUnnamed = [...b.zeroth.questionIds, ...b.ineligible.map((e) => e.id)].filter((id) => !unnamedIds.has(id))
  if (notUnnamed.length) fail(`${tenantId}: 설계의 zeroth · ineligible에 이름 없는 질문이 아닌 id가 있습니다: ${notUnnamed.join(', ')}`)

  const zeroth = new Set(b.zeroth.questionIds)
  const ineligible = new Map(b.ineligible.map((e) => [e.id, e.reason] as const))
  const excluded = unnamed
    .filter((q) => zeroth.has(q.questionId) || ineligible.has(q.questionId) || (isProbe(q) && q.paraphraseOf))
    .map((q) => ({
      id: q.questionId,
      reason: zeroth.has(q.questionId)
        ? `0차 추가 글이 맡음: ${b.zeroth.article}`
        : ineligible.has(q.questionId)
          ? `대상 아님: ${ineligible.get(q.questionId)}`
          : `홀드아웃(${q.paraphraseOf} 바꿔 쓰기)`,
    }))
  const excludedIds = new Set(excluded.map((e) => e.id))
  const pool: PoolQuestion[] = unnamed
    .filter((q) => !excludedIds.has(q.questionId))
    .map((q) => ({ id: q.questionId, text: q.text, stage: q.stage ?? '', probe: isProbe(q) }))
  const byId = new Map(pool.map((q) => [q.id, q] as const))

  // 단위 — 설계의 묶음, 나머지는 하나씩(질문지 순서).
  const clustered = new Set<string>()
  const units: Unit[] = []
  for (const c of b.clusters) {
    const bad = c.ids.filter((id) => !byId.has(id) || clustered.has(id))
    if (bad.length) fail(`${tenantId}: 묶음 「${c.name}」에 대상이 아니거나 다른 묶음에 이미 있는 id가 있습니다: ${bad.join(', ')}`)
    c.ids.forEach((id) => clustered.add(id))
    units.push({ name: c.name, questions: [...c.ids].sort().map((id) => byId.get(id)!) })
  }
  for (const q of pool) if (!clustered.has(q.id)) units.push({ name: q.id, questions: [q] })

  // 단위별 확률 — 실제 배정과 다른 난수.
  const probRand = mulberry32(fnv1a(`probability:${tenantId}`))
  const counts = units.map(() => [0, 0, 0])
  for (let i = 0; i < probabilityDraws; i += 1) {
    drawAllocation(units, armSize, probRand).labels.forEach((l, u) => (counts[u]![l]! += 1))
  }
  const probabilities = units.map((u, i) => ({
    unit: u.name,
    ids: u.questions.map((q) => q.id),
    round1: counts[i]![0]! / probabilityDraws,
    round2: counts[i]![1]! / probabilityDraws,
    control: counts[i]![2]! / probabilityDraws,
  }))
  const stuck = probabilities.filter((p) => Math.min(p.round1, p.round2, p.control) < minProbability)

  console.log(`\n■ ${tenantId} (${bankVersion}) — 대상 ${pool.length}개 · 단위 ${units.length}개 · 제외 ${excluded.length}개`)
  console.log('  단위별 확률(1차 / 2차 / 대조):')
  for (const p of probabilities) {
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`.padStart(6)
    console.log(`    ${pct(p.round1)} ${pct(p.round2)} ${pct(p.control)}  ${p.unit}${p.ids.length > 1 ? ` (${p.ids.join(', ')})` : ''}`)
  }
  if (stuck.length) fail(`${tenantId}: 확률이 ${minProbability} 미만인 단위가 있습니다 — 설계를 고친 뒤 다시: ${stuck.map((p) => p.unit).join(', ')}`)
  if (checkOnly) continue

  // 실제 배정.
  const rand = mulberry32(fnv1a(`${seed}:${tenantId}`))
  const { labels, attempt } = drawAllocation(units, armSize, rand)
  const armUnits = (arm: Arm) => units.filter((_, i) => labels[i] === ARMS.indexOf(arm))
  const rounds = (['round1', 'round2'] as const).map((arm) => {
    const articles = articlesOf(armUnits(arm), rand)
    const channels = channelsOf(articles.length, rand)
    const probes = armUnits(arm).flatMap((u) => u.questions.filter((q) => q.probe))
    return {
      arm,
      questionIds: armUnits(arm).flatMap((u) => u.questions.map((q) => q.id)).sort(),
      articles: articles.map((a, i) => ({ questionIds: a.map((q) => q.id).sort(), channel: channels[i]! })),
      holdoutSources: shuffle(probes, rand)
        .slice(0, holdoutsPerArm)
        .map((q) => q.id)
        .sort(),
    }
  })
  const controlIds = armUnits('control').flatMap((u) => u.questions.map((q) => q.id)).sort()
  const analysisUnits = analysisUnitsOf(
    units,
    rounds.flatMap((r) => r.articles.map((a) => a.questionIds)),
  )
  // 무작위화 추론용 다시 뽑기 — 단위 순서대로 군 번호를 이은 문자열.
  const alternativeLabels = Array.from({ length: alternatives }, (_, i) =>
    drawAllocation(units, armSize, mulberry32(fnv1a(`alternative:${i + 1}:${tenantId}`))).labels.join(''),
  )

  brands.push({
    tenantId,
    bankVersion,
    armSize,
    excluded,
    pool,
    units: units.map((u) => ({ name: u.name, ids: u.questions.map((q) => q.id) })),
    probabilities,
    attempt,
    labels: labels.join(''),
    rounds,
    controlIds,
    analysisUnits,
    alternativeLabels,
  })

  const label = (id: string) => `${id}${byId.get(id)!.probe ? ' [실증]' : ''} ${byId.get(id)!.text}`
  console.log(`  배정 — 뽑기 ${attempt}번째`)
  for (const r of rounds) {
    console.log(`  ${ARM_LABEL[r.arm]} 처치 ${r.questionIds.length}개 · 글 ${r.articles.length}편`)
    r.articles.forEach((a, i) => {
      console.log(`    글 ${i + 1} · ${a.channel}`)
      for (const id of a.questionIds) console.log(`      ${label(id)}${r.holdoutSources.includes(id) ? '  ← 홀드아웃' : ''}`)
    })
  }
  console.log(`  대조 ${controlIds.length}개`)
  for (const id of controlIds) console.log(`    ${label(id)}`)
}

if (!checkOnly) {
  const out = {
    format: 'proof-assignment/2',
    script: 'scripts/proof-assign.ts',
    design: 'docs/proof/design.json',
    seed,
    brands,
  }
  writeFileSync(outPath, JSON.stringify(out, null, 2).replace(/\n/g, '\r\n') + '\r\n')
  console.log(`\n배정표: ${outPath}`)
}
