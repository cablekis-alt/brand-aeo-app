/**
 * 질문 은행에 탐색(learn) 질문을 덧붙인다 — 은행을 다시 만들지 않는다.
 *
 * 왜 필요한가: 생성 프롬프트에 단계 하한이 없던 시절에 만든 은행은 추천형(consider)으로 쏠려 있다.
 * 스테이,머뭄 v3은 탐색 3 · 비교 26 · 결정 7이었고, 3개로 낸 탐색 언급률 0.0%는 "세 번 다 안
 * 나왔다"는 뜻일 뿐 통계로 못 쓴다. 탐색은 아직 후보를 모르는 신규 고객이 들어오는 입구라
 * 그 구간이 안 보이면 "왜 새 고객이 안 오나"를 설명할 수 없다.
 *
 * 왜 새 버전을 만들지 않나: 기존 questionId를 그대로 두고 **덧붙이기만** 한다. 그래야 지난 주차의
 * 판정 레코드가 계속 유효하고(재계산·주차 비교가 살아 있다), 새 문항은 다음 측정부터 답이 쌓인다.
 * 은행을 제자리에서 고치는 것은 tag-stages·tag-topics가 이미 하는 방식이라 새로운 관행도 아니다.
 *
 *   npx tsx scripts/add-learn-questions.ts <tenantId> [개수]            # 기본 6개, repo(data/)
 *   npx tsx scripts/add-learn-questions.ts <tenantId> 6 --dry-run
 *   npx tsx scripts/add-learn-questions.ts <tenantId> 6 "$env:APPDATA\brand-aeo-app"   # 데스크톱 데이터
 *
 * 판정 엔진 1회를 쓴다. 앱이 실행 중이면 데스크톱 대상 실행은 앱을 끄고 한다.
 */
import 'dotenv/config'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildStageTopUpPrompt, learnQuota } from '../src/prompts/b1-question-bank'
import type { QuestionSpec } from '../src/prompts/types'
import { getJudgeClient } from '../server/engines/index'
import { parseJsonLoose } from '../server/jsonParse'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const positional = args.filter((a) => !a.startsWith('--'))
const tenantId = positional[0]
const requested = Number(positional[1] ?? '6')
/** 셸이 확장하지 못한 환경변수 토큰을 직접 푼다(scripts/rescore-local.ts와 같은 헬퍼). */
const expandEnvTokens = (input: string) =>
  input
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name: string) => process.env[name] ?? m)
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/g, (m, name: string) => process.env[name] ?? m)
const appDataDir = positional[2] ? expandEnvTokens(positional[2]) : undefined

if (!tenantId || !Number.isFinite(requested) || requested < 1) {
  console.error('사용법: npx tsx scripts/add-learn-questions.ts <tenantId> [개수] [appDataDir] [--dry-run]')
  process.exit(1)
}

const dataRoot = appDataDir ? path.join(appDataDir, 'data') : 'data'
interface TenantLite {
  tenantId: string
  brandName: string
  aliases?: string[]
  industry: string
  region: string
  questionBankVersion: string
  competitors?: { name: string; aliases?: string[] }[]
}
const tenants = JSON.parse(readFileSync('server/tenants.config.json', 'utf8')) as TenantLite[]
// 설치본에서 등록한 브랜드는 베이스 설정에 없다 — 그때는 오버레이를 본다(resolve-stored-citations와 같은 규칙).
const overlayPath = appDataDir ? path.join(appDataDir, 'tenants.overlay.json') : path.join('server', 'tenants.overlay.json')
const overlay = existsSync(overlayPath)
  ? (JSON.parse(readFileSync(overlayPath, 'utf8')) as TenantLite[])
  : []
const tenant = tenants.find((t) => t.tenantId === tenantId) ?? overlay.find((t) => t.tenantId === tenantId)
if (!tenant) {
  console.error(`테넌트를 찾을 수 없습니다: ${tenantId} (베이스·오버레이 모두 확인)`)
  process.exit(1)
}

/** 상호·별칭·경쟁사명 — 탐색 질문에 이것이 들어가면 그 단계가 아니다. */
const brandNames = [
  tenant.brandName,
  ...(tenant.aliases ?? []),
  ...(tenant.competitors ?? []).flatMap((c) => [c.name, ...(c.aliases ?? [])]),
].filter((n): n is string => typeof n === 'string' && n.length > 0)

const version = tenant.questionBankVersion
const bankPath = path.join(dataRoot, tenantId, 'question-bank', `${version}.json`)
if (!existsSync(bankPath)) {
  console.error(`질문 은행이 없습니다: ${bankPath}`)
  process.exit(1)
}
const bank = JSON.parse(readFileSync(bankPath, 'utf8')) as { version: string; questions: QuestionSpec[] }
const questions = bank.questions ?? []
const learnBefore = questions.filter((q) => q.stage === 'learn').length
const floor = learnQuota(questions.length + requested)

console.log(`${tenantId} · ${version} · 문항 ${questions.length}개`)
console.log(`  현재 단계: 탐색 ${learnBefore} · 비교 ${questions.filter((q) => q.stage === 'consider').length} · 결정 ${questions.filter((q) => q.stage === 'decide').length}`)
console.log(`  ${requested}개 추가 후 탐색 ${learnBefore + requested}개 / 하한 ${floor}개`)

const maxIndex = questions.reduce((max, q) => {
  const n = Number(/-(\d+)$/.exec(q.questionId)?.[1] ?? '0')
  return Number.isFinite(n) ? Math.max(max, n) : max
}, 0)

const prompt = buildStageTopUpPrompt({
  industry: tenant.industry,
  region: tenant.region,
  existingTexts: questions.map((q) => q.text),
  count: requested,
  version,
  startIndex: maxIndex + 1,
})

console.log('\n판정 엔진 호출 중…')
const result = await getJudgeClient().call(prompt)
const parsed = parseJsonLoose<Partial<QuestionSpec>[]>(result.text) ?? []

const existingIds = new Set(questions.map((q) => q.questionId))
const existingTexts = new Set(questions.map((q) => q.text.replace(/\s+/g, '')))
const added: QuestionSpec[] = []
for (const row of parsed) {
  if (!row?.text || !row.questionId) continue
  if (existingIds.has(row.questionId) || existingTexts.has(row.text.replace(/\s+/g, ''))) {
    console.log(`  건너뜀(중복): ${row.text}`)
    continue
  }
  // 단계·카테고리는 코드가 고정한다 — 보강의 목적이 탐색 표본을 늘리는 것이라 LLM이 다른 값을
  // 달아 오면 목적이 사라진다. 다만 상호가 섞이면 그건 탐색 질문이 아니므로 버린다.
  if (brandNames.some((name) => name.length > 1 && row.text!.includes(name))) {
    console.log(`  건너뜀(상호 포함 — 탐색 질문이 아님): ${row.text}`)
    continue
  }
  added.push({
    questionId: row.questionId,
    text: row.text,
    category: 'category-agnostic',
    stage: 'learn',
    topic: row.topic,
    industry: tenant.industry,
    region: tenant.region,
    containsBrandName: false,
    version,
  })
  existingIds.add(row.questionId)
  existingTexts.add(row.text.replace(/\s+/g, ''))
}

console.log(`\n새 탐색 질문 ${added.length}개:`)
for (const q of added) console.log(`  ${q.questionId}  [${q.topic ?? '-'}]  ${q.text}`)

if (added.length === 0) {
  console.log('\n추가할 질문이 없습니다.')
  process.exit(0)
}

if (dryRun) {
  console.log('\n--dry-run — 파일을 쓰지 않았습니다.')
  process.exit(0)
}

bank.questions = [...questions, ...added]
writeFileSync(bankPath, JSON.stringify(bank, null, 2) + '\n', 'utf8')
console.log(`\n저장: ${bankPath} (문항 ${bank.questions.length}개)`)

// 발행본(src/data/live-*)도 같은 내용을 유지한다 — 웹이 옛 은행을 보면 화면이 갈린다.
const publishedPath = `src/data/live-${tenantId}-question-bank.json`
if (!appDataDir && existsSync(publishedPath)) {
  const published = JSON.parse(readFileSync(publishedPath, 'utf8')) as { questions: QuestionSpec[] }
  published.questions = [...(published.questions ?? []), ...added]
  writeFileSync(publishedPath, JSON.stringify(published, null, 2) + '\n', 'utf8')
  console.log(`저장: ${publishedPath} (문항 ${published.questions.length}개)`)
}

console.log('\n다음 측정부터 새 문항에 답이 쌓입니다. 기존 문항 id는 그대로라 지난 주차 비교는 유지됩니다.')
console.log('questionBankSize를 설정에서 맞춰 두면 화면 문구가 실제 문항 수와 어긋나지 않습니다.')
