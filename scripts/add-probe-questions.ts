/**
 * 브랜드 질문지에 실증 질문(probe)을 덧붙인다 — 우리 글이 AI 답변에 인용되는지 실험할 이름 없는 질문이다.
 * (scripts/nondeterminism-probe.ts · quota-probe.ts · probe-gemini.ts와는 무관하다 — 그쪽 probe는 엔진 시험 호출이다.)
 *
 * 실증 질문은 같은 판(예: v5)에 probe: true로 덧붙여 매번 측정하지만 점수 · 코호트 비교 · 고객 리포트 서술 · 본 글에서는 뺀다
 * (src/lib/questionScope.ts). 「글 더 만들기」에서 일부를 처치군으로 골라 글을 쓰고, 나머지는 대조군으로 둔다. 덧붙이기만 하므로
 * 기존 문항 id · 문장이 그대로고 「같은 조건」 판정도 그대로다. 규칙(금지 이름 · 중복 · id)은 server/probeQuestions.ts에 있다.
 *
 * 두 단계로 쓴다. 기본은 dry-run — 판정 엔진 1회로 후보를 만들어 거른 이유와 함께 보여 주고 후보 파일을 남긴다(아무것도 고치지
 * 않는다). 사람이 후보 파일을 보고 뺄 후보를 candidates에서 지운 뒤, 앱을 끄고 --write --from으로 그 후보만 덧붙인다.
 *
 *   npx tsx scripts/add-probe-questions.ts <tenantId> --app-data "<userData>"                        # 새 후보 16개(추천형 10개 이상)
 *   npx tsx scripts/add-probe-questions.ts <tenantId> --app-data "<userData>" --count 18 --recommend 10
 *   npx tsx scripts/add-probe-questions.ts <tenantId> --app-data "<userData>" --paraphrase-of v5-p001,v5-p004   # 홀드아웃(하나에 하나씩)
 *   npx tsx scripts/add-probe-questions.ts <tenantId> --app-data "<userData>" --write --from <후보 파일> [--expect-count 42]
 *
 *   --out <폴더>        후보 파일을 남길 곳(기본: 지금 폴더의 probe-candidates.local — .gitignore의 *.local이라 커밋에 섞이지 않는다)
 *   --expect-count <n>  쓰기 전에 지금 문항 수가 이 값인지 본다(web4ai v5는 42, gunsan v6는 36이었다)
 *
 * 판정 엔진은 측정과 같은 설정(JUDGE_ENGINE)을 쓴다. 키는 .env에서 읽는다 — 설치본 키를 쓰려면 DOTENV_CONFIG_PATH로 userData의
 * .env를 가리킨다. 키는 출력하지 않는다.
 *
 * --write가 지키는 것:
 *   - 앱이 실행 중이면 멈춘다(migrate-question-plan.ts와 같은 tasklist 확인) — 측정이 같은 질문지를 읽고 쓴다.
 *   - 해석한 절대 경로와 지금 문항 수를 보여 주고, 경로가 이 셸의 가상화 사본(Packages\Claude_…)으로 보이거나 문항 수가 후보를
 *     만들 때 · --expect-count와 다르면 멈춘다. Claude 셸에서는 평범한 %APPDATA% 경로도 읽기는 실제 폴더를 통과하는데 쓰기만 파일
 *     단위로 가상화 사본에 가므로, 경로 글자 · 문항 수로는 못 잡는다. 그래서 질문지 폴더에 표지 파일을 써 보고 가상화 위치에 생기면
 *     멈추고(server/probeQuestions.ts writeRedirects), 쓴 뒤에도 백업 폴더가 그쪽에 생겼으면 실패로 알린다 — 사용자 터미널이나
 *     //localhost/C$/… 경로에서 실행한다.
 *   - 질문지와 tenants.overlay.json을 data/<tenantId>/before-probe-<시각>/에 복사한 뒤 질문지 하나만 고친다.
 *   - cohort-banks/ · questionBankSize · src/data 발행본은 건드리지 않는다. 기존 문항은 한 글자도 바꾸지 않는다.
 *
 * 덧붙인 뒤에는 새로 측정해야 실증 답이 쌓인다(같은 주 같은 판 카드는 재사용될 수 있다). rescore-local로 지난 주차 점수가
 * 바뀌지 않는지 확인한다.
 */
import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const VALUE_FLAGS = new Set(['--app-data', '--count', '--recommend', '--paraphrase-of', '--from', '--out', '--expect-count'])
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const positional = args.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(args[i - 1] ?? ''))
const tenantId = positional[0] ?? ''
const write = args.includes('--write')

/** 셸이 확장하지 못한 환경변수 토큰을 직접 푼다(scripts/rescore-local.ts와 같은 헬퍼). */
const expandEnvTokens = (input: string) =>
  input
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name: string) => process.env[name] ?? m)
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/g, (m, name: string) => process.env[name] ?? m)

const USAGE =
  '사용법: npx tsx scripts/add-probe-questions.ts <tenantId> --app-data <dir> [--count 16] [--recommend 10] ' +
  '[--paraphrase-of <id,id,...>] [--out <dir>] [--write --from <candidates.json> [--expect-count <n>]]'
function fail(...lines: string[]): never {
  for (const line of lines) console.error(line)
  process.exit(1)
}

const rawAppData = flag('--app-data')
if (!tenantId || !rawAppData) fail(USAGE)
const intFlag = (name: string, fallback: number | undefined): number | undefined => {
  const raw = flag(name)
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) fail(`${name}는 0 이상의 정수여야 합니다: ${raw}`)
  return n
}

const expanded = expandEnvTokens(rawAppData)
if (expanded !== rawAppData) console.log(`인자 확장: ${rawAppData} → ${expanded}`)
const appData = path.resolve(expanded)
if (!existsSync(appData)) fail(`앱 데이터 폴더가 없습니다: ${appData}`)

// 로컬 앱 데이터만 읽고 쓴다 — .env에 Blob 토큰이 있으면 오버레이(브랜드 목록)를 클라우드에서 읽는다(tenantOverlay.ts).
process.env.BLOB_READ_WRITE_TOKEN = ''
process.env.BLOB_STORE_ID = ''
// APP_DATA_DIR은 server/appPaths.ts가 모듈 로드 시점에 읽으므로, 그 전에 설정해야 한다.
process.env.APP_DATA_DIR = appData

const { COHORT_BANK_DIR, PIPELINE_DATA_DIR, stateFilePath } = await import('../server/appPaths')
const { loadRuntimeTenants } = await import('../server/tenantRegistry')
const { cohortKey } = await import('../server/cohortQuestionBank')
const probe = await import('../server/probeQuestions')
const { isProbe } = await import('../src/lib/questionScope')
type QuestionSpec = import('../src/prompts/types').QuestionSpec
type QuestionBank = import('../server/store').QuestionBank
type ProbeCandidatesFile = import('../server/probeQuestions').ProbeCandidatesFile

// ── 공통: 브랜드 · 질문지 · 코호트 공통 질문지 ────────────────────────────────
const runtime = await loadRuntimeTenants()
const found = runtime.find((t) => t.tenantId === tenantId)
if (!found) fail(`브랜드를 찾을 수 없습니다: ${tenantId} (저장소 설정 · ${stateFilePath('tenants.overlay.json')})`)
const tenant = found
if (tenant.cohortOnly) fail(`${tenantId}는 경쟁사로만 재는 브랜드입니다 — 실증 질문은 글을 쓰는 고객 브랜드에만 넣습니다.`)
const version = tenant.questionBankVersion
const bankPath = path.join(PIPELINE_DATA_DIR, tenantId, 'question-bank', `${version}.json`)
const pathProblem = probe.bankPathProblem(bankPath, PIPELINE_DATA_DIR, tenantId)
if (pathProblem) fail(`✗ ${pathProblem}`)
if (!existsSync(bankPath)) fail(`질문지가 없습니다: ${bankPath} — 이 판으로 한 번 측정한 뒤 실행하세요.`)
const bankRaw = readFileSync(bankPath, 'utf8')
const bank = JSON.parse(bankRaw) as QuestionBank
if (bank.version !== version) fail(`질문지 파일의 판(${bank.version})이 설정의 판(${version})과 다릅니다: ${bankPath}`)
const questions = bank.questions ?? []
const probesNow = questions.filter(isProbe)

/** 이 셸의 가상화 사본인지 — 경로 글자와, 따라간 실제 경로를 함께 본다. 평범한 %APPDATA% 경로의 쓰기 리다이렉트는 --write가 써 보고 잡는다. */
const virtualized = [appData, bankPath].some((p) => probe.looksVirtualized(p) || probe.looksVirtualized(realpathSync.native(p)))

console.log(`브랜드: ${tenant.brandName} (${tenantId})`)
console.log(`앱 데이터: ${appData}`)
console.log(`질문지: ${bankPath}`)
console.log(`  ${version} · 문항 ${questions.length}개(실증 ${probesNow.length}개)`)
if (virtualized) console.warn('⚠ 이 셸의 가상화 사본(Packages\\Claude_…) 경로로 보입니다 — 실제 앱 데이터가 아닙니다.')

/** 코호트 공통 질문지의 문장 — 그 코호트 폴더의 모든 판. 읽기만 한다. */
function readCohortTexts(): string[] {
  const key = bank.cohortBank?.key ?? (tenant.cohortQuestionBank ? cohortKey(tenant.industry, tenant.region) : null)
  if (!key) return []
  const dir = path.join(COHORT_BANK_DIR, key)
  if (!existsSync(dir)) {
    console.warn(`  코호트 공통 질문지 폴더가 없습니다: ${dir} — 브랜드 질문지에 합쳐진 공통 질문으로만 거릅니다.`)
    return []
  }
  const texts: string[] = []
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const file = path.join(dir, name)
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { questions?: QuestionSpec[] }
      texts.push(...(parsed.questions ?? []).map((q) => q.text))
    } catch (err) {
      fail(`코호트 공통 질문지를 읽지 못했습니다: ${file} — ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  console.log(`코호트 공통 질문지: ${dir} (문장 ${texts.length}개)`)
  return texts
}
const cohortTexts = readCohortTexts()
const banned = probe.bannedNames(tenant, runtime)
console.log(`금지 이름 ${banned.length}개: ${banned.join(', ')}`)

if (write) {
  await runWrite()
} else {
  await runDry()
}

// ── dry-run: 후보 만들기 ─────────────────────────────────────────────────────
async function runDry(): Promise<void> {
  const { buildProbeQuestionPrompt } = await import('../src/prompts/b1-question-bank')
  const { getJudgeClient, resolveJudgeEngineId } = await import('../server/engines/index')
  const { parseJsonLoose } = await import('../server/jsonParse')

  const paraphraseIds = (flag('--paraphrase-of') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const mode: 'new' | 'paraphrase' = paraphraseIds.length > 0 ? 'paraphrase' : 'new'
  const count = intFlag('--count', probe.DEFAULT_PROBE_COUNT)!
  const recommendMin = intFlag('--recommend', probe.DEFAULT_RECOMMEND_MIN)!
  if (mode === 'new' && count < 1) fail('--count는 1 이상이어야 합니다.')
  if (mode === 'new' && recommendMin > count) fail(`--recommend(${recommendMin})가 --count(${count})보다 큽니다.`)

  const already = probe.paraphrasedIds(questions)
  const sources: QuestionSpec[] = []
  for (const id of paraphraseIds) {
    const q = questions.find((x) => x.questionId === id)
    if (!q || !isProbe(q)) fail(`바꿔 쓸 질문이 이 질문지의 실증 질문이 아닙니다: ${id}`)
    if (q.paraphraseOf) fail(`${id}는 ${q.paraphraseOf}의 홀드아웃입니다 — 홀드아웃은 다시 바꿔 쓰지 않습니다.`)
    if (already.has(id)) fail(`이미 바꿔 쓴 실증이 있는 질문입니다: ${id}`)
    if (!sources.includes(q)) sources.push(q)
  }
  if (mode === 'paraphrase' && args.includes('--count')) console.log('  바꿔 쓰기는 질문 하나에 하나씩 만듭니다 — --count는 쓰지 않습니다.')

  const existingTexts = [...new Map([...questions.map((q) => q.text), ...cohortTexts].map((t) => [probe.textKey(t), t])).values()]
  const prompt = buildProbeQuestionPrompt({
    industry: tenant.industry,
    region: tenant.region,
    marketScope: tenant.marketScope,
    buyer: tenant.buyer,
    language: tenant.questionLanguage,
    bannedNames: banned,
    existingTexts,
    count,
    recommendMin,
    ...(mode === 'paraphrase' ? { paraphrase: sources.map((q) => ({ questionId: q.questionId, text: q.text })) } : {}),
  })

  const judgeEngine = resolveJudgeEngineId()
  console.log(
    `\n판정 엔진(${judgeEngine}) 호출 중… ${mode === 'paraphrase' ? `바꿔 쓰기 ${sources.length}개` : `새 후보 ${count}개 · 추천형 ${recommendMin}개 이상`}`,
  )
  const result = await getJudgeClient().call(prompt)
  const rows = parseJsonLoose<unknown>(result.text)
  if (rows === null) fail('판정 엔진 응답을 JSON으로 읽지 못했습니다. 응답 앞부분:', result.text.slice(0, 500))

  const parsed = probe.parseProbeRows(rows, mode === 'paraphrase' ? sources : undefined)
  const filtered = probe.filterCandidates(parsed.candidates, {
    banned,
    existingTexts: questions.map((q) => q.text),
    cohortTexts,
    probeIds: new Set(probesNow.map((q) => q.questionId)),
    paraphrased: already,
    holdouts: probe.holdoutIds(questions),
  })
  const limit = mode === 'paraphrase' ? sources.length : count
  const { kept: candidates, dropped } = probe.limitCandidates(filtered.accepted, limit, mode === 'new' ? recommendMin : 0)
  const rejected = [
    ...parsed.rejected,
    ...filtered.rejected,
    ...dropped.map((c) => ({ text: c.text, reason: `요청 개수(${limit})를 넘음` })),
  ]

  const ids = probe.nextProbeIds(bank, candidates.length)
  console.log(`\n후보 ${candidates.length}개(id는 쓸 때 다시 매김):`)
  candidates.forEach((c, i) => {
    const tag = c.paraphraseOf ? `← ${c.paraphraseOf}` : `${c.kind === 'recommend' ? '추천형' : '정보형'}`
    console.log(`  ${ids[i]}  [${c.stage} · ${c.topic ?? '-'} · ${tag}]  ${c.text}`)
  })
  if (rejected.length > 0) {
    console.log(`\n거른 후보 ${rejected.length}개:`)
    for (const r of rejected) console.log(`  ✗ ${r.reason} — ${r.text}`)
  }
  if (mode === 'new') {
    const recommend = candidates.filter(probe.isRecommendCandidate).length
    const met = probe.recommendQuotaMet(candidates, recommendMin)
    console.log(`\n추천형 ${recommend}개 / 하한 ${recommendMin}개 — ${met ? '충족' : '미달(다시 만들거나 후보 파일을 보고 정하세요)'}`)
    if (candidates.length < count) console.log(`요청 ${count}개 중 ${candidates.length}개만 남았습니다.`)
  } else {
    const missing = sources.filter((q) => !candidates.some((c) => c.paraphraseOf === q.questionId)).map((q) => q.questionId)
    if (missing.length > 0) console.log(`\n바꿔 쓰지 못한 질문: ${missing.join(', ')}`)
  }

  if (candidates.length === 0) {
    console.log('\n남은 후보가 없습니다 — 후보 파일을 남기지 않았습니다.')
    return
  }
  const file: ProbeCandidatesFile = {
    format: 'probe-candidates/1',
    tenantId,
    bankVersion: version,
    bankPath,
    bankQuestionCount: questions.length,
    mode,
    generatedAt: new Date().toISOString(),
    judgeEngine,
    ...(result.model ? { judgeModel: result.model } : {}),
    recommendMin: mode === 'new' ? recommendMin : 0,
    candidates,
    rejected,
  }
  const outFlag = flag('--out')
  const outDir = path.resolve(outFlag ?? probe.DEFAULT_CANDIDATES_DIR)
  if (outFlag === undefined) mkdirSync(outDir, { recursive: true })
  else if (!existsSync(outDir)) fail(`--out 폴더가 없습니다: ${outDir}`)
  const outFile = path.join(outDir, `probe-candidates-${tenantId}-${version}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  writeFileSync(outFile, JSON.stringify(file, null, 2) + '\n', 'utf8')
  console.log(`\n후보 파일: ${outFile}`)
  console.log('뺄 후보는 candidates에서 지우고 저장한 뒤, 앱을 끄고 아래로 덧붙입니다(dry-run은 아무것도 고치지 않았습니다):')
  console.log(`  npx tsx scripts/add-probe-questions.ts ${tenantId} --app-data "${appData}" --write --from "${outFile}" --expect-count ${questions.length}`)
}

// ── --write: 검토한 후보만 덧붙이기 ─────────────────────────────────────────────
async function runWrite(): Promise<void> {
  const from = flag('--from')
  if (!from) fail('--write에는 --from <후보 파일>이 필요합니다 — 먼저 dry-run으로 후보를 만들고 검토하세요.')
  const fromPath = path.resolve(from!)
  if (!existsSync(fromPath)) fail(`후보 파일이 없습니다: ${fromPath}`)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(fromPath, 'utf8'))
  } catch (err) {
    fail(`후보 파일을 읽지 못했습니다: ${fromPath} — ${err instanceof Error ? err.message : String(err)}`)
  }
  const read = probe.readCandidatesFile(raw)
  if (!read.ok) fail(`✗ ${read.error}`)
  const { file } = read

  console.log(`후보 파일: ${fromPath} (${file.mode === 'paraphrase' ? '바꿔 쓰기' : '새 후보'} ${file.candidates.length}개)`)
  if (path.resolve(file.bankPath) !== bankPath) console.warn(`⚠ 후보를 만들 때 읽은 질문지 경로가 다릅니다: ${file.bankPath}`)
  if (virtualized) fail('✗ 가상화 사본 경로에는 쓰지 않습니다. 사용자 터미널이나 //localhost/C$/… 경로로 실행하세요.')

  const plan = probe.planProbeWrite({
    file,
    tenantId,
    version,
    bank: { version: bank.version, questions },
    industry: tenant.industry,
    region: tenant.region,
    banned,
    cohortTexts,
    expectCount: intFlag('--expect-count', undefined),
  })
  if (!plan.ok) fail('✗ 쓰지 않았습니다:', ...plan.errors.map((e) => `  - ${e}`))
  const { added, questions: next } = plan

  console.log(`\n덧붙일 실증 질문 ${added.length}개(문항 ${questions.length} → ${next.length}):`)
  for (const q of added) console.log(`  ${q.questionId}  [${q.stage ?? '-'} · ${q.topic ?? '-'}${q.paraphraseOf ? ` · ← ${q.paraphraseOf}` : ''}]  ${q.text}`)

  // 경로 글자로는 안 보이는 쓰기 리다이렉트 — 질문지 폴더에 표지 파일을 써 보고 가상화 위치에 생기는지 본다.
  const roots = { appData: process.env.APPDATA, localAppData: process.env.LOCALAPPDATA }
  let redirected: string[] = []
  try {
    redirected = await probe.writeRedirects(path.dirname(bankPath), roots)
  } catch (err) {
    fail(`✗ 질문지 폴더에 써 보는 확인을 하지 못했습니다(${err instanceof Error ? err.message : String(err)}). 질문지는 쓰지 않았습니다.`)
  }
  if (redirected.length > 0) {
    fail(
      `✗ 이 셸에서 쓴 파일이 실제 폴더가 아닌 가상화 사본으로 갑니다: ${redirected.join(', ')}`,
      '  Claude 셸에서는 %APPDATA% 경로도 평범해 보이고 읽기는 실제 폴더를 통과하지만, 쓰기만 Packages\\Claude_…\\LocalCache로 갑니다.',
      '  사용자 터미널이나 //localhost/C$/… 경로로 실행하세요. 질문지는 쓰지 않았습니다(표지 파일은 지웠습니다).',
    )
  }
  console.log(`쓰기 확인: ${path.dirname(bankPath)}에 쓴 파일이 그 자리에 갑니다(가상화 사본 아님).`)

  // 앱 확인은 쓰기 바로 앞에서 한다 — 확인과 쓰기 사이에 앱을 켤 틈을 줄인다.
  assertAppClosed()
  const { backupDir, copied } = await probe.writeProbeBank({
    bankPath,
    overlayPath: stateFilePath('tenants.overlay.json'),
    tenantDir: path.join(PIPELINE_DATA_DIR, tenantId),
    before: bankRaw,
    next: { ...bank, questions: next },
    now: new Date(),
  })
  console.log(`\n백업: ${backupDir}`)
  for (const c of copied) console.log(`  ${path.basename(c)}`)

  // 표지 파일 확인 뒤에도 쓰기가 가상화 사본으로 갔다면(이름이 시각이라 겹치지 않는 백업 폴더로 본다) 성공으로 알리지 않는다.
  const movedBackup = await probe.findRedirectedCopies(backupDir, roots)
  if (movedBackup.length > 0) {
    fail(
      `✗ 백업과 질문지가 실제 폴더가 아닌 가상화 사본으로 갔습니다: ${movedBackup.join(', ')}`,
      '  실제 앱의 질문지에는 실증이 없습니다. 사용자 터미널이나 //localhost/C$/… 경로로 다시 실행하세요.',
    )
  }

  // 쓴 결과를 다시 읽어 기존 문항이 그대로인지 확인한다.
  const saved = JSON.parse(readFileSync(bankPath, 'utf8')) as QuestionBank
  const intact = JSON.stringify(saved.questions.slice(0, questions.length)) === JSON.stringify(questions)
  if (!intact || saved.questions.length !== next.length) {
    fail(`✗ 쓴 질문지가 기대와 다릅니다 — 백업에서 되돌리세요: ${path.join(backupDir, path.basename(bankPath))}`)
  }
  console.log(`\n저장: ${bankPath} (문항 ${saved.questions.length}개, 기존 ${questions.length}개 그대로)`)
  console.log('cohort-banks · questionBankSize · src/data 발행본은 건드리지 않았습니다.')
  console.log('앱을 켜고 새로 측정해야 실증 답이 쌓입니다. rescore-local로 지난 주차 점수가 그대로인지 확인하세요.')
}

/**
 * 앱이 실행 중이면 중단한다 — 측정이 같은 질문지를 읽고(같은 판이면 그대로 쓴다), 경쟁사 편집이 새 판을 만든다.
 * scripts/migrate-question-plan.ts와 같은 방식으로 실제로 확인한다. 확인에 실패하면 그 사실을 밝힐 뿐 통과시키지 않는다.
 */
function assertAppClosed(): void {
  const EXE = 'Web4AI Brand AEO.exe'
  let out = ''
  try {
    out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${EXE}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8' })
  } catch (err) {
    fail(`✗ tasklist 실행에 실패해 앱 실행 여부를 확인할 수 없습니다(${err instanceof Error ? err.message : String(err)}). 앱을 끄고 다시 시도하세요.`)
  }
  const pids = [...out.matchAll(/^"([^"]+)","(\d+)"/gm)]
    .filter((m) => m[1].toLowerCase() === EXE.toLowerCase())
    .map((m) => m[2])
  if (pids.length > 0) {
    fail(
      `✗ 앱이 실행 중입니다(${EXE} · PID ${pids.join(', ')}). 완전히 종료한 뒤 다시 실행하세요.`,
      '  측정이 같은 질문지를 읽고 쓰므로 동시에 고치면 한쪽 변경이 사라집니다. 아무것도 쓰지 않았습니다.',
    )
  }
}
