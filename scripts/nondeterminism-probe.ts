/**
 * 비결정성 계측 — "같은 조건에서 다시 재면 판정이 얼마나 달라지나"를 주기적으로 잰다.
 *
 * 왜 별도 도구인가. 예전에는 매 측정이 질문마다 반복 호출(repeatsPerQuestion=3)을 해서
 * 이 값을 얻었다. 그런데 저장된 1,376개 셀로 분산을 분해해 보니 분산의 81%가 질문 간이고
 * 반복 내는 19%뿐이었다(ICC 0.814). 즉 반복은 정밀도에 거의 기여하지 않으면서 예산의
 * 3분의 2를 먹고 있었다. 그 예산을 문항으로 옮기면(36문항 × 1회) 같은 비용에 언급률
 * 표준오차가 14.99%p → 9.66%p로 내려간다.
 *
 * 비결정성은 매 측정마다 낼 비용이 아니라 **주기적으로 재는 상수**다. 모델이나 프롬프트가
 * 바뀔 때 다시 재면 된다.
 *
 * 그리고 이 도구는 반복보다 **나은 계측기**다. 반복은 수집과 판정을 한 덩어리로 다시 돌려
 * 둘의 노이즈가 섞였다. 여기서는 나눠 잰다:
 *
 *   --judge    같은 응답 원문을 N회 다시 판정 → 판정 노이즈만 (σ_judge)
 *   --collect  같은 질문을 N회 다시 수집하고 각각 판정 → 수집+판정 합성 노이즈 (σ_total)
 *
 * 두 값이 있으면 수집 자체의 기여를 분리할 수 있다: σ²_collect ≈ σ²_total − σ²_judge.
 * 수집 호출에는 googleSearch 그라운딩이 붙으므로, 수집 노이즈는 모델 샘플링만이 아니라
 * **검색이 가져오는 문서가 매번 달라지는 것**까지 포함한다.
 *
 *   npx tsx scripts/nondeterminism-probe.ts --judge                 # 판정 노이즈 (기본 12문항 × 3회)
 *   npx tsx scripts/nondeterminism-probe.ts --collect               # 수집+판정 (기본 8문항 × 3회)
 *   npx tsx scripts/nondeterminism-probe.ts --judge 16 4            # 문항 수 · 반복 수 지정
 *   npx tsx scripts/nondeterminism-probe.ts --collect --tenant torder
 *
 * 주의: 실제 API를 호출한다. --judge 기본값은 판정 36회, --collect 기본값은 수집 24회 +
 * 판정 24회다(수집 호출이 그라운딩 검색을 포함해 더 비싸다).
 */
import 'dotenv/config'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { getEngineClient, getJudgeClient, resolveJudgeEngineId } from '../server/engines/index'
import { resolveCollectionEngines } from '../server/pipeline'
import { mapWithConcurrency } from '../server/concurrency'
import { parseJsonLoose } from '../server/jsonParse'
import { buildBrandMentionPrompt, buildEngineCallPrompt } from '../src/prompts/index'
import type { BrandContext } from '../src/prompts/index'
import type { BrandMentionResult } from '../server/analysisTypes'
import type { TenantConfig } from '../server/types'

const argv = process.argv.slice(2)
const judgeMode = argv.includes('--judge')
const collectMode = argv.includes('--collect')
if (judgeMode === collectMode) {
  console.error('--judge 또는 --collect 중 하나를 주세요. 자세한 설명은 파일 상단 주석 참고.')
  process.exit(1)
}
const flagValue = (name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--tenant')
const items = Number(positional[0] ?? (judgeMode ? 12 : 8))
const repeats = Number(positional[1] ?? 3)
const tenantId = flagValue('--tenant') ?? 'k-wonjin'

if (!Number.isFinite(items) || items < 2 || !Number.isFinite(repeats) || repeats < 2) {
  console.error('문항 수와 반복 수는 2 이상이어야 합니다(분산을 내려면 반복이 최소 2회).')
  process.exit(1)
}

const cfg = JSON.parse(readFileSync('server/tenants.config.json', 'utf8')) as TenantConfig[]
const tenant = cfg.find((t) => t.tenantId === tenantId)
if (!tenant) {
  console.error(`테넌트를 찾을 수 없습니다: ${tenantId}`)
  process.exit(1)
}
const brand: BrandContext = {
  brandName: tenant.brandName,
  aliases: tenant.aliases,
  ownedDomains: tenant.ownedDomains,
  competitors: tenant.competitors,
  industry: tenant.industry,
  region: tenant.region,
}

/**
 * 판정 결과를 0/1로.
 *
 * 필드는 `targetBrand.mentioned`다 — 저장된 분석의 `mentionSentences`와 **다르다**.
 * 그걸 혼동하면 모든 응답이 조용히 0이 되고("언급 없음") 분산이 항상 0으로 나온다.
 * 그래서 필드가 없으면 0이 아니라 null(판정 실패)로 돌려 눈에 보이게 한다.
 */
function mentionedFrom(text: string): number | null {
  const parsed = parseJsonLoose<BrandMentionResult>(text)
  if (!parsed || typeof parsed.targetBrand?.mentioned !== 'boolean') return null
  return parsed.targetBrand.mentioned ? 1 : 0
}

/** 이 브랜드의 카테고리 무관 questionId 집합 — 지표(언급률·SoM)가 쓰는 모집단. */
function agnosticIds(): Set<string> {
  const ids = new Set<string>()
  const dirs = [
    path.join('data', tenantId, 'question-bank'),
    path.join(process.env.APPDATA ?? '', 'brand-aeo-app', 'data', tenantId, 'question-bank'),
  ]
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      try {
        const bank = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as {
          questions?: { questionId?: string; category?: string }[]
        }
        for (const q of bank.questions ?? []) {
          if (q.category === 'category-agnostic' && q.questionId) ids.add(q.questionId)
        }
      } catch {
        // 다음 파일로
      }
    }
  }
  return ids
}

/**
 * 최신 주차의 저장된 응답 원문 — --judge가 같은 입력을 반복 판정하는 데 쓴다.
 *
 * **카테고리 무관 질문의 응답만** 쓴다. 브랜드명이 들어간 질문은 거의 항상 언급되므로
 * 그쪽을 섞으면 언급률이 100%에 붙고, 0/1 값의 반복 내 분산은 상한이 p(1-p)라
 * 구조적으로 0이 나온다(측정이 아무것도 못 잡는다). 그리고 앞에서 N개를 자르지 않고
 * 고르게 뽑는다 — 저장 순서가 질문 순서라 앞쪽만 보면 한쪽 카테고리에 몰린다.
 */
function loadStoredRawTexts(): string[] {
  const agn = agnosticIds()
  const dirs = [path.join('data', tenantId), path.join(process.env.APPDATA ?? '', 'brand-aeo-app', 'data', tenantId)]
  const found: { week: string; texts: string[] }[] = []
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const week of readdirSync(dir)) {
      const f = path.join(dir, week, 'raw-calls.json')
      if (!existsSync(f)) continue
      try {
        const calls = JSON.parse(readFileSync(f, 'utf8')) as { rawText?: string; questionId?: string }[]
        const texts = calls
          .filter((c) => agn.size === 0 || (c.questionId && agn.has(c.questionId)))
          .map((c) => c.rawText)
          .filter((t): t is string => Boolean(t && t.length > 200))
        if (texts.length) found.push({ week, texts })
      } catch {
        // 다음 주차로
      }
    }
  }
  found.sort((a, b) => b.week.localeCompare(a.week))
  return found[0]?.texts ?? []
}

/** 리스트 전체에서 고르게 n개 — 앞에서 자르면 한쪽 카테고리·엔진에 몰린다. */
function spread<T>(list: T[], n: number): T[] {
  if (list.length <= n) return list
  const step = list.length / n
  return Array.from({ length: n }, (_, i) => list[Math.floor(i * step)])
}

/** 질문 은행의 카테고리 무관 문항 — --collect가 다시 물어볼 질문. */
function loadAgnosticQuestions(): string[] {
  const dirs = [
    path.join('data', tenantId, 'question-bank'),
    path.join(process.env.APPDATA ?? '', 'brand-aeo-app', 'data', tenantId, 'question-bank'),
  ]
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    const files = readdirSync(dir).sort()
    for (const f of files.reverse()) {
      try {
        const bank = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as {
          questions?: { text?: string; category?: string }[]
        }
        const texts = (bank.questions ?? [])
          .filter((q) => q.category === 'category-agnostic')
          .map((q) => q.text)
          .filter((t): t is string => Boolean(t))
        if (texts.length) return texts
      } catch {
        // 다음 파일로
      }
    }
  }
  return []
}

/** 셀별 표본분산의 평균 = 반복 내 분산. 0/1 값이라 분산의 상한은 0.25다. */
function withinVariance(cells: number[][]): {
  sigma2: number
  cells: number
  flipped: number
  all0: number
  all1: number
  rate: number
} {
  const usable = cells.filter((v) => v.length >= 2)
  const vars = usable.map((v) => {
    const m = v.reduce((s, x) => s + x, 0) / v.length
    return v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1)
  })
  const flipped = usable.filter((v) => new Set(v).size > 1).length
  const all1 = usable.filter((v) => v.every((x) => x === 1)).length
  const all0 = usable.filter((v) => v.every((x) => x === 0)).length
  const flat = usable.flat()
  return {
    sigma2: vars.length ? vars.reduce((s, x) => s + x, 0) / vars.length : 0,
    cells: usable.length,
    flipped,
    all0,
    all1,
    rate: flat.length ? flat.reduce((s, x) => s + x, 0) / flat.length : 0,
  }
}

const CONCURRENCY = 8
const judge = getJudgeClient()

console.log(
  `대상 ${tenant.brandName} (${tenantId}) · 판단엔진 ${resolveJudgeEngineId()} · ` +
    `${judgeMode ? '판정' : '수집+판정'} 노이즈 · ${items}개 × ${repeats}회\n`,
)

const cells: number[][] = []
let failures = 0

if (judgeMode) {
  const texts = loadStoredRawTexts()
  if (texts.length === 0) {
    console.error('저장된 응답 원문이 없습니다. 먼저 이 브랜드를 한 번 측정하세요.')
    process.exit(1)
  }
  const picked = spread(texts, items)
  console.log(`저장된 카테고리 무관 응답 ${texts.length}개 중 ${picked.length}개를 각 ${repeats}회 다시 판정합니다.`)
  const jobs = picked.flatMap((text, i) => Array.from({ length: repeats }, () => ({ i, text })))
  const results: (number | null)[][] = picked.map(() => [])
  await mapWithConcurrency(jobs, CONCURRENCY, async (job) => {
    try {
      const out = await judge.call(buildBrandMentionPrompt(brand, job.text))
      results[job.i].push(mentionedFrom(out.text))
    } catch {
      results[job.i].push(null)
    }
  })
  for (const row of results) {
    const clean = row.filter((v): v is number => v !== null)
    failures += row.length - clean.length
    cells.push(clean)
  }
} else {
  const questions = loadAgnosticQuestions()
  if (questions.length === 0) {
    console.error('질문 은행을 찾을 수 없습니다. 먼저 이 브랜드를 한 번 측정하세요.')
    process.exit(1)
  }
  const picked = spread(questions, items)
  // 파이프라인과 같은 규칙으로 엔진을 고른다(COLLECT_ENGINES 전역 지정을 포함).
  // tenant.engines[0]을 직접 쓰면 설정과 다른 엔진으로 재게 된다.
  const engineId = resolveCollectionEngines(tenant)[0]
  console.log(`카테고리 무관 ${questions.length}개 중 ${picked.length}개를 ${engineId}로 각 ${repeats}회 다시 수집·판정합니다.`)
  const jobs = picked.flatMap((text, i) => Array.from({ length: repeats }, () => ({ i, text })))
  const results: (number | null)[][] = picked.map(() => [])
  await mapWithConcurrency(jobs, CONCURRENCY, async (job) => {
    try {
      const engine = getEngineClient(engineId)
      const raw = await engine.call(buildEngineCallPrompt(engineId, job.text))
      const out = await judge.call(buildBrandMentionPrompt(brand, raw.text))
      results[job.i].push(mentionedFrom(out.text))
    } catch {
      results[job.i].push(null)
    }
  })
  for (const row of results) {
    const clean = row.filter((v): v is number => v !== null)
    failures += row.length - clean.length
    cells.push(clean)
  }
}

const { sigma2, cells: n, flipped, all0, all1, rate } = withinVariance(cells)
const sd = Math.sqrt(sigma2)

console.log('')
console.log(`분산 산출 대상 셀 ${n}개${failures > 0 ? ` · 실패한 호출 ${failures}건 제외` : ''}`)
console.log(`셀 구성: 전부 언급없음 ${all0} · 전부 언급됨 ${all1} · 섞임 ${flipped} · 언급률 ${(rate * 100).toFixed(0)}%`)

// 0/1 값의 반복 내 분산은 언급률이 0%나 100%에 붙으면 **구조적으로** 0이 된다
// (상한이 p(1-p)다). 그걸 "노이즈가 없다"로 읽으면 안 되므로 여기서 못 박는다.
const degenerate = rate <= 0.1 || rate >= 0.9
if (degenerate) {
  console.log('')
  console.log('⚠ 언급률이 한쪽 끝에 붙어 있습니다. 0/1 값의 반복 내 분산은 상한이 p(1-p)이므로')
  console.log('  이 조건에서 σ가 작게 나오는 것은 노이즈가 없다는 뜻이 아닙니다.')
  console.log('  언급률이 30~70%인 브랜드·주차로 다시 재세요.')
}
console.log(`${judgeMode ? '판정' : '수집+판정'} 내 분산  σ² = ${sigma2.toFixed(4)}`)
console.log(`${judgeMode ? '판정' : '수집+판정'} 내 표준편차 σ = ${(sd * 100).toFixed(1)}%p`)
console.log(`판정이 뒤집힌 셀 ${flipped}/${n}개 (${n ? Math.round((flipped / n) * 100) : 0}%)`)
console.log('')
console.log('참고 — 2026-09-11 기준선 (저장된 측정 1,376개 셀, 수집+판정 합성)')
console.log('  σ² = 0.0383 · σ = 19.6%p · 질문 간 분산 σ²_b = 0.1671 → ICC 0.814')
if (judgeMode) {
  const residual = 0.0383 - sigma2
  console.log('')
  console.log(`수집 자체의 기여 추정  σ²_collect ≈ 0.0383 − ${sigma2.toFixed(4)} = ${residual.toFixed(4)}` +
    (residual > 0 ? ` (σ ≈ ${(Math.sqrt(residual) * 100).toFixed(1)}%p)` : ' — 판정 노이즈가 기준선보다 큽니다'))
  console.log('  기준선은 다른 표본(브랜드·주차 전체)에서 나온 값이므로 이 차이는 어림값이다.')
  console.log('  같은 브랜드·주차로 맞추려면 --collect도 같은 조건으로 돌려 비교하세요.')
}
