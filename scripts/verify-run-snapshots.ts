/**
 * 회차 기록(server/store.ts saveRunSnapshot · server/pipeline.ts)을 확인한다 — 같은 주에 여러 번 재도 회차마다 runs/<runId>/가
 * 남는지, 주차 카드는 지금처럼 하나인지, 엔진이 빠진 측정이 그 주 카드를 덮지 않는지(weekCardKeepReason), 판정에서 실패한 측정이
 * 그 주 파일을 건드리지 않는지, 회차 기록을 못 써도 측정은 성공인지, 주차를 훑는 곳(사용량 · 코호트)이 runs/를 세지 않는지.
 * 임시 폴더를 APP_DATA_DIR로 쓰고 가짜 브랜드 · 가짜 엔진만 쓴다.
 *
 * 왜: 같은 주에 다시 재면 그 주 파일을 통째로 덮어, 2026-W43 스테이,머뭄 8회 측정 가운데 마지막 1회만 남았다. 10-21에 올린 글이
 * 며칠째 처음 인용됐는지를 볼 수 없었다. 2026-W42 gunsan-national은 Gemini가 빠진 측정이 그 주 3엔진 카드를 덮었다.
 *
 *   npx tsx scripts/verify-run-snapshots.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { WeeklyScorecard } from '../src/prompts/b8-report'
import type { RunMeta } from '../server/store'

const dir = mkdtempSync(path.join(tmpdir(), 'verify-run-snapshots-'))
process.env.APP_DATA_DIR = dir
process.env.BLOB_READ_WRITE_TOKEN = ''
process.env.BLOB_STORE_ID = ''
process.env.USE_MOCK_ENGINES = 'true'
delete process.env.MOCK_REPORT_DELAY_MS

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])
const writeJson = (rel: string, value: unknown) => {
  const file = path.join(dir, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value))
}
const card = (engines?: string[]) => ({ enginesUsed: engines }) as WeeklyScorecard

const BRAND = {
  tenantId: 'snap', brandName: '회차 펜션', aliases: ['회차 펜션'], ownedDomains: ['snap.example'], industry: '펜션', region: '가상시',
  engines: ['gemini', 'openai'], questionBankSize: 6, questionBankVersion: 'v1', repeatsPerQuestion: 2, factGraph: [],
  competitors: [{ name: '이웃 펜션', aliases: ['이웃 펜션'], domains: ['near.example'] }],
}

try {
  const { weekCardKeepReason } = await import('../server/pipeline')
  const { measureAndBake } = await import('../server/measureAndBake')
  const { getIsoWeekString } = await import('../server/dateUtil')
  const { FileResultStore } = await import('../server/store')
  const { getUsageStats } = await import('../server/usageStats')
  const { MockJudgeClient } = await import('../server/engines/mockJudgeClient')
  const reg = await import('../server/tenantRegistry')
  const week = getIsoWeekString(new Date())
  const weekDir = path.join(dir, 'data/snap', week)
  const runsDir = path.join(weekDir, 'runs')
  const runIds = () => (existsSync(runsDir) ? readdirSync(runsDir).sort() : [])
  const runMeta = (id: string) => JSON.parse(readFileSync(path.join(runsDir, id, 'run.json'), 'utf8')) as RunMeta
  const runCard = (id: string) => JSON.parse(readFileSync(path.join(runsDir, id, 'scorecard.json'), 'utf8')) as WeeklyScorecard
  const weekFile = (name: string) => readFileSync(path.join(weekDir, name), 'utf8')
  const history = () => JSON.parse(readFileSync(path.join(dir, 'data/snap/scorecard-history.json'), 'utf8')) as WeeklyScorecard[]
  const tenant = async () => (await reg.loadRuntimeTenants()).find((t) => t.tenantId === 'snap')!

  // 1) 덮지 않을 까닭 — 앞서 잰 그 주 카드보다 엔진이 적을 때(그 엔진들의 일부)만
  ok('덮기: 그 주 카드가 없으면 덮는다', weekCardKeepReason(undefined, card(['gemini'])) === null)
  ok('덮기: 엔진이 빠진 측정은 덮지 않는다', typeof weekCardKeepReason(card(['openai', 'gemini', 'perplexity']), card(['openai', 'perplexity'])) === 'string')
  ok('덮기: 같은 엔진은 덮는다', weekCardKeepReason(card(['gemini', 'openai']), card(['openai', 'gemini'])) === null)
  ok('덮기: 엔진이 늘면 덮는다', weekCardKeepReason(card(['gemini']), card(['gemini', 'openai'])) === null)
  ok('덮기: 구성이 다르면(부분집합 아님) 덮는다', weekCardKeepReason(card(['gemini', 'openai']), card(['gemini', 'perplexity'])) === null)
  ok('덮기: 엔진 기록 없는 옛 카드는 덮는다', weekCardKeepReason(card(undefined), card(['gemini'])) === null)

  writeJson('tenants.overlay.json', [BRAND])
  const store = new FileResultStore()

  // 2) 같은 주 두 번 — 주차 카드는 하나, 회차 기록은 둘
  process.env.COLLECT_ENGINES = 'gemini,openai'
  await measureAndBake(await tenant(), store, { selfOnly: true })
  await measureAndBake(await tenant(), store, { selfOnly: true })
  const two = runIds()
  ok('같은 주 2회: 주차 카드는 한 장', history().filter((h) => h.weekOf === week).length === 1)
  ok('같은 주 2회: 회차 기록 2개 · 시각 순 이름', two.length === 2 && two[0] < two[1])
  ok(
    '회차 기록: 카드 · 판정 · run.json이 다 있다',
    two.every((id) => ['scorecard.json', 'question-analyses.json', 'run.json'].every((f) => existsSync(path.join(runsDir, id, f)))),
  )
  ok('회차 기록: 원문(raw-calls)은 남기지 않는다', two.every((id) => !existsSync(path.join(runsDir, id, 'raw-calls.json'))))
  const meta = runMeta(two[1])
  const weekRaw = JSON.parse(weekFile('raw-calls.json')) as { engine: string; usedWebSearch?: boolean }[]
  ok(
    'run.json: 측정 방식 · 그 주 카드 · 시각',
    meta.runId === two[1] && meta.weekOf === week && meta.selfOnly && !meta.inCohortRun && meta.weekCard === 'saved' && meta.startedAt <= meta.finishedAt,
  )
  ok(
    'run.json: 엔진별 예정 · 성공 호출 수',
    Object.keys(meta.engines).sort().join() === 'gemini,openai' &&
      Object.entries(meta.engines).every(([e, v]) => v.planned === 12 && v.succeeded === weekRaw.filter((r) => r.engine === e).length),
  )
  ok(
    'run.json: 수집 사용량 요약이 그 회차 원문과 맞는다',
    Object.entries(meta.collectUsage).every(([e, u]) => u.calls === weekRaw.filter((r) => r.engine === e).length) &&
      Object.values(meta.collectUsage).reduce((n, u) => n + u.calls, 0) === weekRaw.length,
  )
  ok('run.json: 판정 맥락 지문(16자리)', /^[0-9a-f]{16}$/.test(meta.contextFingerprint) && runMeta(two[0]).contextFingerprint === meta.contextFingerprint)
  ok(
    '마지막 회차 = 그 주 카드 · 판정',
    runCard(two[1]).aeoScore.current === history().find((h) => h.weekOf === week)!.aeoScore.current &&
      readFileSync(path.join(runsDir, two[1], 'question-analyses.json'), 'utf8') === JSON.stringify(JSON.parse(weekFile('question-analyses.json')), null, 2),
  )

  // 3) 주차를 훑는 곳은 runs/를 세지 않는다 — 사용량은 그 주 원문 한 벌, 코호트 카드는 한 장
  const usage = await getUsageStats(1)
  ok('사용량: runs/를 세지 않는다(그 주 원문 한 벌)', usage.weeks.length === 1 && usage.weeks[0].weekOf === week && usage.weeks[0].calls === weekRaw.length)
  ok('코호트: 브랜드당 카드 한 장', (await store.getCohortScorecards(BRAND.industry, BRAND.region, week)).filter((c) => c.tenantId === 'snap').length === 1)

  // 4) 엔진이 빠진 측정 — 그 주 카드 · 파일은 그대로, 회차 기록에만 남고 화면에 까닭을 돌려준다
  const before = { raw: weekFile('raw-calls.json'), an: weekFile('question-analyses.json'), card: weekFile('scorecard.json'), report: weekFile('report.md') }
  process.env.COLLECT_ENGINES = 'gemini'
  const kept = await measureAndBake(await tenant(), store, { selfOnly: true })
  const afterKept = runIds()
  ok('엔진 빠짐: 측정은 성공 · 까닭을 돌려준다', typeof kept.weekCardKept === 'string' && kept.weekCardKept.includes('gemini'))
  ok(
    '엔진 빠짐: 그 주 원문 · 판정 · 카드 · 리포트는 그대로',
    weekFile('raw-calls.json') === before.raw && weekFile('question-analyses.json') === before.an && weekFile('report.md') === before.report &&
      history().find((h) => h.weekOf === week)!.enginesUsed!.slice().sort().join() === 'gemini,openai',
  )
  const keptMeta = runMeta(afterKept[afterKept.length - 1])
  ok(
    '엔진 빠짐: 회차 기록에는 남는다(kept · 까닭 · gemini만)',
    afterKept.length === 3 && keptMeta.weekCard === 'kept' && keptMeta.weekCardKeptReason === kept.weekCardKept &&
      Object.keys(keptMeta.engines).join() === 'gemini',
  )

  // 5) 엔진이 늘면 덮는다
  process.env.COLLECT_ENGINES = 'gemini,openai,perplexity'
  const grown = await measureAndBake(await tenant(), store, { selfOnly: true })
  ok(
    '엔진 늘어남: 그 주 카드를 덮는다',
    grown.weekCardKept === undefined && history().find((h) => h.weekOf === week)!.enginesUsed!.length === 3 && runIds().length === 4,
  )

  // 6) 판정에서 실패 — 그 주 파일을 하나도 건드리지 않고, 회차 기록도 남기지 않는다
  const beforeFail = { raw: weekFile('raw-calls.json'), an: weekFile('question-analyses.json'), card: weekFile('scorecard.json') }
  const judgeCall = MockJudgeClient.prototype.call
  MockJudgeClient.prototype.call = async () => {
    throw new Error('판정 실패(검증용)')
  }
  let judgeFailed = false
  try {
    await measureAndBake(await tenant(), store, { selfOnly: true })
  } catch {
    judgeFailed = true
  } finally {
    MockJudgeClient.prototype.call = judgeCall
  }
  ok(
    '판정 실패: 측정은 실패 · 그 주 원문 · 판정 · 카드는 앞 측정 그대로(섞이지 않음)',
    judgeFailed && weekFile('raw-calls.json') === beforeFail.raw && weekFile('question-analyses.json') === beforeFail.an && weekFile('scorecard.json') === beforeFail.card,
  )
  ok('판정 실패: 회차 기록을 남기지 않는다', runIds().length === 4)

  // 7) 회차 기록을 못 써도 측정은 성공 · 그 주 카드는 저장
  const broken = new FileResultStore()
  broken.saveRunSnapshot = async () => {
    throw new Error('회차 기록 저장 실패(검증용)')
  }
  let cardSaves = 0
  const saveCard = broken.saveScorecard.bind(broken)
  broken.saveScorecard = async (c) => {
    cardSaves += 1
    await saveCard(c)
  }
  const survived = await measureAndBake(await tenant(), broken, { selfOnly: true }).then(() => true, () => false)
  ok('회차 기록 실패: 측정은 성공 · 그 주 카드는 저장', survived && cardSaves === 1 && runIds().length === 4)

  // 8) 판정 맥락이 바뀌면 지문이 바뀐다 — 별칭 추가
  writeJson('tenants.overlay.json', [{ ...BRAND, aliases: ['회차 펜션', '회차'] }])
  await measureAndBake(await tenant(), store, { selfOnly: true })
  const last = runIds()
  ok('판정 맥락 지문: 별칭이 바뀌면 달라진다', runMeta(last[last.length - 1]).contextFingerprint !== meta.contextFingerprint)
} finally {
  delete process.env.COLLECT_ENGINES
  rmSync(dir, { recursive: true, force: true })
}

let failed = 0
for (const [label, pass] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${label}`)
  if (!pass) failed += 1
}
if (failed > 0) {
  console.error(`\n${failed}건 실패`)
  process.exit(1)
}
console.log(`\n모두 통과 (${checks.length}건)`)
