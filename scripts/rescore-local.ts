/**
 * 로컬(데스크톱 앱·개발) 데이터에 저장된 스코어카드를 현재 집계 규칙으로 다시 계산한다.
 * 새 API 호출은 없다 — 이미 저장된 판정 레코드(question-analyses.json)만 다시 집계한다.
 *
 * 집계 규칙을 바꾸면 새로 측정한 주차만 새 정의를 쓰고 이미 저장된 주차는 옛 정의로 남아,
 * 같은 브랜드에서 서로 다른 값이 보인다(예: 대시보드 SoM 65.7% vs 랭킹 분석 33.3%). 그걸 맞춘다.
 *
 *   npx tsx scripts/rescore-local.ts --dry-run    # 개발 체크아웃(./data), 미리보기
 *   npx tsx scripts/rescore-local.ts              # 개발 체크아웃 갱신
 *
 * 데스크톱 앱 데이터를 대상으로 할 때는 userData 경로(그 아래 data/가 있는 곳)를 인자로 준다.
 * 셸마다 환경변수 문법이 달라 자주 틀리므로, 확장되지 않은 토큰은 아래에서 직접 풀어준다.
 *   PowerShell: npx tsx scripts/rescore-local.ts --dry-run "$env:APPDATA\brand-aeo-app"
 *   cmd:        npx tsx scripts/rescore-local.ts --dry-run "%APPDATA%\brand-aeo-app"
 *
 * 앱을 종료한 뒤 실행한다.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')

/**
 * 셸이 확장하지 못한 환경변수 토큰을 직접 풀어준다.
 * PowerShell은 %APPDATA%를, cmd는 $env:APPDATA를 확장하지 못해 경로가 리터럴로 들어오고,
 * 그러면 cwd 기준 상대 경로로 붙어 엉뚱한 곳을 가리킨다(실제로 겪은 함정).
 */
function expandEnvTokens(input: string): string {
  return input
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name: string) => process.env[name] ?? m)
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/g, (m, name: string) => process.env[name] ?? m)
}

const rawArg = args.find((a) => !a.startsWith('--'))
const appDataDir = rawArg ? expandEnvTokens(rawArg) : undefined
if (rawArg && appDataDir !== rawArg) console.log(`인자 확장: ${rawArg} → ${appDataDir}`)

// APP_DATA_DIR은 server/appPaths.ts가 모듈 로드 시점에 읽으므로, 그 전에 설정해야 한다.
if (appDataDir) process.env.APP_DATA_DIR = path.resolve(appDataDir)

const { aggregateWeeklyMetrics, ciBounds } = await import('../server/aggregate')
const { PIPELINE_DATA_DIR } = await import('../server/appPaths')
const { computeCohortRank, movingAverage4 } = await import('../server/scoring')
type WeeklyScorecard = import('../src/prompts/b8-report').WeeklyScorecard
type QuestionBank = import('../server/store').QuestionBank
type QuestionRepeatAnalysis = import('../server/types').QuestionRepeatAnalysis

const dataDir = PIPELINE_DATA_DIR
if (!existsSync(dataDir)) {
  console.error(`데이터 디렉터리가 없습니다: ${dataDir}`)
  console.error('데스크톱 앱 데이터를 대상으로 하려면 userData 경로를 인자로 주세요:')
  console.error('  PowerShell: npx tsx scripts/rescore-local.ts --dry-run "$env:APPDATA\\brand-aeo-app"')
  console.error('  cmd:        npx tsx scripts/rescore-local.ts --dry-run "%APPDATA%\\brand-aeo-app"')
  process.exit(1)
}

const readJson = <T,>(p: string): T | null => {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T
  } catch {
    return null
  }
}

/** 그 브랜드 디렉터리에 있는 은행 파일 전부. */
function loadBanks(tenantDir: string): QuestionBank[] {
  const bankDir = path.join(tenantDir, 'question-bank')
  if (!existsSync(bankDir)) return []
  return readdirSync(bankDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => readJson<QuestionBank>(path.join(bankDir, f)))
    .filter((b): b is QuestionBank => b !== null)
}

/**
 * 그 주차의 판정 레코드가 실제로 쓴 은행을 고른다 — 레코드의 문항 id가 전부 들어 있는 은행이다.
 *
 * 예전에는 설정된 버전(없으면 최신) 은행 하나로 모든 주차를 계산했다. 은행을 새로 만든 브랜드는
 * 옛 주차의 id(v1-*)가 새 은행(v3-*)에 없어 그 주차가 통째로 건너뛰어졌고, 한 브랜드 안에서 주차마다
 * 다른 집계 규칙이 남았다. 새 은행에 문항을 덧붙인 경우(36 → 42)는 옛 주차의 id가 모두 들어 있어
 * 그 은행이 그대로 맞는다.
 */
function bankFor(banks: QuestionBank[], analyses: QuestionRepeatAnalysis[]): QuestionBank | null {
  const ids = new Set(analyses.map((a) => a.questionId))
  return (
    banks.find((b) => {
      const bankIds = new Set(b.questions.map((q) => q.questionId))
      return [...ids].every((id) => bankIds.has(id))
    }) ?? null
  )
}

/**
 * SoM 산출에 필요한 건 "그 주에 경쟁사가 설정돼 있었는가" 하나다. 지금 설정이 아니라 그 주 카드로
 * 판단한다 — 카드에 SoM이 있었으면 경쟁사가 있었던 것이다.
 *
 * 지금 설정을 쓰면 안 된다. 경쟁사 목록을 나중에 넣은 브랜드(2026-09-30 펜션 코호트)는 옛 주차 판정에
 * 경쟁사 언급이 없어, "경쟁사 있음"으로 계산하면 언급되기만 하면 SoM이 100%로 나온다. 판정 레코드의
 * competitorMentions로 추론해서도 안 된다 — 언급 횟수 0인 빈 항목이 남아 있어 같은 100%가 나왔다
 * (comp-1j0j0pl 2026-W36).
 *
 * 카드에 SoM이 없던 주는 경쟁사가 없었거나 모집단에 언급이 전혀 없었던 주라, 다시 계산해도 null이다.
 * 표본 미달(MIN_SOM_MENTIONS)로 SoM이 빠진 카드는 shareOfMentionMentions가 남아 있어 경쟁사가 있던 주로 본다.
 */
function hadCompetitors(prev: WeeklyScorecard): boolean {
  return prev.shareOfMention !== null || typeof prev.shareOfMentionMentions === 'number'
}

const isWeekDir = (name: string) => /^\d{4}-W\d{2}$/.test(name)
const pct = (v: number | null) => (v === null ? '측정불가' : `${(v * 100).toFixed(1)}%`)

const updates: { file: string; card: WeeklyScorecard }[] = []
let skipped = 0

for (const tenantId of readdirSync(dataDir)) {
  const tenantDir = path.join(dataDir, tenantId)
  if (!statSync(tenantDir).isDirectory()) continue

  const banks = loadBanks(tenantDir)
  if (banks.length === 0) {
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

    // 판정 레코드의 문항이 다 들어 있는 은행이 없으면 모집단을 정할 수 없다. 틀린 은행으로 계산하면
    // 언급률 0 · SoM 측정불가라는 잘못된 값이 조용히 나오므로, 건드리지 않고 넘긴다.
    const bank = bankFor(banks, analyses)
    if (!bank) {
      console.warn(`${tenantId} ${weekOf}: 판정 레코드의 문항이 모두 들어 있는 은행이 없음 — 건너뜀`)
      skipped += 1
      continue
    }

    // aggregateWeeklyMetrics는 competitors의 "개수"만 본다(0이면 SoM 측정불가).
    const competitors = hadCompetitors(prev) ? [{ name: '(저장된 카드 기준)' }] : []
    const m = aggregateWeeklyMetrics({ competitors }, bank.questions, analyses)
    const previousWeek = history.length > 0 ? history[history.length - 1].aeoScore.current : m.score
    const ma4 = Math.round(movingAverage4([...history.map((h) => h.aeoScore.current), m.score]))
    const card: WeeklyScorecard = {
      ...prev,
      aeoScore: {
        current: m.score,
        ma4,
        previousWeek,
        ...ciBounds(m.score, m.ciMargin),
      },
      mentionRate: m.mentionRate,
      shareOfMention: m.shareOfMention,
      shareOfMentionMentions: m.shareOfMentionMentions,
      ...(m.repeatsPerQuestion !== undefined ? { repeatsPerQuestion: m.repeatsPerQuestion } : {}),
      avgRecommendationRank: m.avgRecommendationRank,
      rankedResponses: m.rankedResponses,
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
