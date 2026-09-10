/**
 * 로컬(데스크톱 앱·개발) 데이터에 저장된 스코어카드를 현재 집계 규칙으로 다시 계산한다.
 * 새 API 호출은 없다 — 이미 저장된 판정 레코드(question-analyses.json)만 다시 집계한다.
 *
 * 집계 규칙을 바꾸면 새로 측정한 주차만 새 정의를 쓰고 이미 저장된 주차는 옛 정의로 남아,
 * 같은 브랜드에서 서로 다른 값이 보인다(예: 대시보드 SoM 65.7% vs 랭킹 분석 33.3%). 그걸 맞춘다.
 *
 *   npx tsx scripts/rescore-local.ts --dry-run                     # 개발 체크아웃(./data), 미리보기
 *   npx tsx scripts/rescore-local.ts                               # 개발 체크아웃 갱신
 *   npx tsx scripts/rescore-local.ts "%APPDATA%\\web4ai-brand-aeo" # 데스크톱 앱 데이터
 *
 * 인자는 앱의 userData 디렉터리(그 아래 data/가 있는 경로)다. 앱을 종료한 뒤 실행한다.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const appDataDir = args.find((a) => !a.startsWith('--'))

// APP_DATA_DIR은 server/appPaths.ts가 모듈 로드 시점에 읽으므로, 그 전에 설정해야 한다.
if (appDataDir) process.env.APP_DATA_DIR = path.resolve(appDataDir)

const { aggregateWeeklyMetrics } = await import('../server/aggregate')
const { PIPELINE_DATA_DIR } = await import('../server/appPaths')
const { computeCohortRank, movingAverage4 } = await import('../server/scoring')
const { loadRuntimeTenants } = await import('../server/tenantRegistry')
type WeeklyScorecard = import('../src/prompts/b8-report').WeeklyScorecard
type QuestionBank = import('../server/store').QuestionBank
type QuestionRepeatAnalysis = import('../server/types').QuestionRepeatAnalysis

const dataDir = PIPELINE_DATA_DIR
if (!existsSync(dataDir)) {
  console.error(`데이터 디렉터리가 없습니다: ${dataDir}`)
  process.exit(1)
}

const readJson = <T,>(p: string): T | null => {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T
  } catch {
    return null
  }
}

/** 설정된 버전의 은행이 없으면 그 브랜드 디렉터리에 있는 가장 최신 은행 파일을 쓴다. */
function loadBank(tenantDir: string, version: string): QuestionBank | null {
  const bankDir = path.join(tenantDir, 'question-bank')
  const exact = readJson<QuestionBank>(path.join(bankDir, `${version}.json`))
  if (exact) return exact
  if (!existsSync(bankDir)) return null
  const files = readdirSync(bankDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
  const latest = files.at(-1)
  return latest ? readJson<QuestionBank>(path.join(bankDir, latest)) : null
}

// 경쟁사 목록(SoM 측정 가능 여부)은 테넌트 설정에서 온다 — 앱이 등록한 브랜드까지 포함해 읽는다.
const tenantById = new Map((await loadRuntimeTenants()).map((t) => [t.tenantId, t]))

const isWeekDir = (name: string) => /^\d{4}-W\d{2}$/.test(name)
const pct = (v: number | null) => (v === null ? '측정불가' : `${(v * 100).toFixed(1)}%`)

const updates: { file: string; card: WeeklyScorecard }[] = []
let skipped = 0

for (const tenantId of readdirSync(dataDir)) {
  const tenantDir = path.join(dataDir, tenantId)
  if (!statSync(tenantDir).isDirectory()) continue

  const tenant = tenantById.get(tenantId)
  if (!tenant) {
    console.warn(`${tenantId}: 테넌트 설정 없음 — 건너뜀 (경쟁사 목록을 알 수 없어 SoM을 정할 수 없음)`)
    skipped += 1
    continue
  }
  const bank = loadBank(tenantDir, tenant.questionBankVersion)
  if (!bank) {
    console.warn(`${tenantId}: 질문 은행 없음 — 건너뜀 (질문 category를 알 수 없어 모집단을 정할 수 없음)`)
    skipped += 1
    continue
  }

  const history: WeeklyScorecard[] = []
  for (const weekOf of readdirSync(tenantDir).filter(isWeekDir).sort()) {
    const weekDir = path.join(tenantDir, weekOf)
    const analyses = readJson<QuestionRepeatAnalysis[]>(path.join(weekDir, 'question-analyses.json'))
    const prev = readJson<WeeklyScorecard>(path.join(weekDir, 'scorecard.json'))
    if (!analyses || analyses.length === 0 || !prev) continue

    // 은행과 판정 레코드의 questionId가 전혀 겹치지 않으면(버전 불일치) 모집단이 빈 집합이 되어
    // 언급률 0 · SoM 측정불가라는 잘못된 값이 조용히 나온다. 그 경우 건드리지 않고 넘긴다.
    const bankIds = new Set(bank.questions.map((q) => q.questionId))
    if (!analyses.some((a) => bankIds.has(a.questionId))) {
      console.warn(`${tenantId} ${weekOf}: 질문 은행(${bank.version})과 판정 레코드의 질문 id 불일치 — 건너뜀`)
      skipped += 1
      continue
    }

    const m = aggregateWeeklyMetrics(tenant, bank.questions, analyses)
    const previousWeek = history.length > 0 ? history[history.length - 1].aeoScore.current : m.score
    const ma4 = Math.round(movingAverage4([...history.map((h) => h.aeoScore.current), m.score]))
    const card: WeeklyScorecard = {
      ...prev,
      aeoScore: {
        current: m.score,
        ma4,
        previousWeek,
        ciLow: Math.round((m.score - m.ciMargin) * 10) / 10,
        ciHigh: Math.round((m.score + m.ciMargin) * 10) / 10,
      },
      mentionRate: m.mentionRate,
      shareOfMention: m.shareOfMention,
      avgRecommendationRank: m.avgRecommendationRank,
      factualityScore: m.factualityScore,
      brandOwnedCitationRate: m.brandOwnedCitationRate,
      hallucinationFlags: m.hallucinationFlags,
      enginesUsed: m.enginesUsed,
    }
    history.push(card)
    updates.push({ file: path.join(weekDir, 'scorecard.json'), card })

    if (card.aeoScore.current !== prev.aeoScore.current || card.shareOfMention !== prev.shareOfMention) {
      console.log(
        `${tenantId.padEnd(18)} ${weekOf}  Score ${prev.aeoScore.current}→${card.aeoScore.current}` +
          `  SoM ${pct(prev.shareOfMention)}→${pct(card.shareOfMention)}`,
      )
    }
  }
}

// 코호트 순위는 같은 업종·지역·주차의 재계산된 카드끼리 다시 매긴다.
for (const { card } of updates) {
  const group = updates
    .map((u) => u.card)
    .filter((c) => c.industry === card.industry && c.region === card.region && c.weekOf === card.weekOf)
  card.cohortRank = computeCohortRank(card.aeoScore.current, group)
}

console.log(`\n대상 디렉터리: ${dataDir}`)
if (dryRun) {
  console.log(`--dry-run — 파일을 쓰지 않았습니다. 대상 ${updates.length}건 (건너뜀 ${skipped}곳)`)
  process.exit(0)
}

// scorecard.json과 scorecard-history.json을 함께 갱신한다(화면은 history를 읽는다).
const historyByTenant = new Map<string, WeeklyScorecard[]>()
for (const { file, card } of updates) {
  writeFileSync(file, JSON.stringify(card, null, 2), 'utf8')
  historyByTenant.set(card.tenantId, [...(historyByTenant.get(card.tenantId) ?? []), card])
}
for (const [tenantId, list] of historyByTenant) {
  const historyPath = path.join(dataDir, tenantId, 'scorecard-history.json')
  const existing = readJson<WeeklyScorecard[]>(historyPath) ?? []
  const recomputed = new Set(list.map((c) => c.weekOf))
  const merged = [...existing.filter((c) => !recomputed.has(c.weekOf)), ...list].sort((a, b) =>
    a.weekOf.localeCompare(b.weekOf),
  )
  writeFileSync(historyPath, JSON.stringify(merged, null, 2), 'utf8')
}

console.log(`갱신 완료 — 스코어카드 ${updates.length}건 / 브랜드 ${historyByTenant.size}곳 (건너뜀 ${skipped}곳)`)
