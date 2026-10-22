/**
 * 측정 꼬리 줄이기(server/pipeline.ts)를 확인한다 — 판정을 인용 많은 답부터 보내되 저장 순서는 그대로 두는지(analysisOrder),
 * 화면에서 시작한 측정이 리포트(report.md)를 기다리지 않는지(deferReport · measureAndBake backgroundReport).
 * 임시 폴더를 APP_DATA_DIR로 쓰고 가짜 브랜드 · 가짜 엔진만 쓴다.
 *
 * 왜: 2026-W43 gunsan-national 측정 262초 중 분석이 41초 · 리포트가 16초였다. 인용 45개짜리 답 하나가 판정 줄 끝에서
 * 늦게 시작해 분석 꼬리를 만들었고, 아무도 읽지 않는 report.md를 쓰는 동안 화면은 「리포트」에 멈춰 있었다.
 *
 *   npx tsx scripts/verify-measure-tail.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { RawCallRecord } from '../server/types'
import type { PromptMessage } from '../src/prompts/types'

const dir = mkdtempSync(path.join(tmpdir(), 'verify-measure-tail-'))
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

try {
  const { analysisOrder, settlePendingReports } = await import('../server/pipeline')
  const { measureAndBake } = await import('../server/measureAndBake')
  const { readLocalMeasures } = await import('../server/localMeasureLog')
  const { getIsoWeekString } = await import('../server/dateUtil')
  const { FileResultStore } = await import('../server/store')
  const reg = await import('../server/tenantRegistry')
  const week = getIsoWeekString(new Date())

  // 1) 판정 순서 — 인용 많은 답부터, 같은 수는 원래 순서
  const call = (n: number) => ({ citations: Array.from({ length: n }, (_, i) => `https://x.example/${i}`) }) as never
  ok('판정 순서: 인용 많은 답부터 · 같은 수는 원래 순서', analysisOrder([call(0), call(3), call(1), call(3), call(0)]).join() === '1,3,2,0,4')
  ok('판정 순서: 빈 목록', analysisOrder([]).length === 0)

  writeJson('tenants.overlay.json', [
    {
      tenantId: 'tail', brandName: '꼬리 펜션', aliases: ['꼬리 펜션'], ownedDomains: ['tail.example'], industry: '펜션', region: '가상시',
      engines: ['gemini'], questionBankSize: 6, questionBankVersion: 'v1', repeatsPerQuestion: 2, factGraph: [],
      competitors: [{ name: '이웃 펜션', aliases: ['이웃 펜션'], domains: ['near.example'] }],
    },
  ])
  const tenant = (await reg.loadRuntimeTenants()).find((t) => t.tenantId === 'tail')!
  const reportFile = path.join(dir, 'data/tail', week, 'report.md')

  // 2) 저장 순서 — 판정을 섞어 보내도 question-analyses.json은 raw-calls.json 순서 그대로
  const store = new FileResultStore()
  await measureAndBake({ ...tenant }, store, { selfOnly: true })
  const raw = JSON.parse(readFileSync(path.join(dir, 'data/tail', week, 'raw-calls.json'), 'utf8')) as { questionId: string; engine: string; callIndex: number }[]
  const analyses = JSON.parse(readFileSync(path.join(dir, 'data/tail', week, 'question-analyses.json'), 'utf8')) as { questionId: string; engine: string; callIndex: number }[]
  const key = (r: { questionId: string; engine: string; callIndex: number }) => `${r.questionId}|${r.engine}|${r.callIndex}`
  ok('저장 순서: 판정 결과가 원문 순서 그대로', raw.length === 12 && analyses.map(key).join() === raw.map(key).join())
  ok('기본(스크립트): 리포트까지 쓰고 끝낸다', existsSync(reportFile))

  // 2-b) 보내는 순서 — 실제 측정이 인용 많은 답부터 판정을 보내는가. 가짜 엔진이 답마다 꼬리표와 정해진 인용 수를 내고,
  // 가짜 판정이 언급 판정(답마다 하나씩 나간다)이 도착한 순서를 적는다. 판정을 띄우는 일꾼은 차례로 시작해 첫 판정을 바로
  // 부르므로 도착 순서가 곧 보낸 순서다.
  const { MockEngineClient } = await import('../server/engines/mockEngineClient')
  const { MockJudgeClient } = await import('../server/engines/mockJudgeClient')
  const CITES = [0, 3, 1, 5, 0, 2, 4, 1, 6, 0, 2, 7]
  const engineCall = MockEngineClient.prototype.call
  const judgeCall = MockJudgeClient.prototype.call
  let sent = 0
  const arrivals: string[] = []
  MockEngineClient.prototype.call = async function () {
    const i = sent++
    return {
      text: `가짜 답 TAG#${i}#`,
      citations: Array.from({ length: CITES[i % CITES.length] }, (_, k) => `https://c${i}.example/${k}`),
      usedWebSearch: true,
      tokenUsage: 100,
      latencyMs: 1,
    }
  }
  MockJudgeClient.prototype.call = async function (this: InstanceType<typeof MockJudgeClient>, prompt: PromptMessage) {
    if (prompt.system.includes('브랜드 언급을 정확히 탐지하는 분석기')) arrivals.push(/TAG#(\d+)#/.exec(prompt.user)?.[1] ?? '?')
    return judgeCall.call(this, prompt)
  }
  try {
    await measureAndBake({ ...tenant }, store, { selfOnly: true })
  } finally {
    MockEngineClient.prototype.call = engineCall
    MockJudgeClient.prototype.call = judgeCall
  }
  const tagged = JSON.parse(readFileSync(path.join(dir, 'data/tail', week, 'raw-calls.json'), 'utf8')) as RawCallRecord[]
  const tag = (r: RawCallRecord) => /TAG#(\d+)#/.exec(r.rawText)?.[1] ?? '?'
  const expected = analysisOrder(tagged).map((i) => tag(tagged[i]))
  ok(
    '보내는 순서: 실제 측정도 인용 많은 답부터 판정한다(원래 순서와 다르게)',
    arrivals.length === 12 && arrivals.join() === expected.join() && expected.join() !== tagged.map(tag).join(),
  )

  // 3) 기본(스크립트)은 리포트 실패를 측정 실패로 본다 — 그대로
  const failing = new FileResultStore()
  failing.saveReport = async () => {
    throw new Error('리포트 저장 실패(검증용)')
  }
  const failedByDefault = await measureAndBake({ ...tenant }, failing, { selfOnly: true }).then(() => false, () => true)
  ok('기본: 리포트 저장 실패는 측정 실패', failedByDefault)

  // 4) 화면(backgroundReport): 리포트 저장이 실패해도 측정은 성공 · 카드와 완료 기록은 남는다. 카드는 앞 단계 것이 이미
  // 있으므로 이 측정이 저장했는지를 센다 — 측정이 돌아오기 전에.
  let cardSaves = 0
  const saveCard = failing.saveScorecard.bind(failing)
  failing.saveScorecard = async (card) => {
    cardSaves += 1
    await saveCard(card)
  }
  const before = readLocalMeasures().filter((r) => r.tenantId === 'tail').length
  const bgFail = await measureAndBake({ ...tenant }, failing, { selfOnly: true, backgroundReport: true }).then(() => true, () => false)
  ok('화면: 리포트 저장이 실패해도 측정은 성공 · 카드는 측정이 끝나기 전에 저장', bgFail && cardSaves === 1)
  await settlePendingReports()
  ok('화면: 완료 기록을 남긴다', readLocalMeasures().filter((r) => r.tenantId === 'tail').length === before + 1)

  // 5) 화면: 리포트를 기다리지 않는다 — 측정이 끝난 때는 아직 report.md가 없고, 뒤에서 마저 쓴다
  rmSync(reportFile, { force: true })
  process.env.MOCK_REPORT_DELAY_MS = '2000'
  const t0 = Date.now()
  await measureAndBake({ ...tenant }, store, { selfOnly: true, backgroundReport: true })
  const returnedMs = Date.now() - t0
  ok('화면: 리포트를 기다리지 않고 끝낸다', !existsSync(reportFile))
  await settlePendingReports()
  ok('화면: 리포트는 뒤에서 쓴다', existsSync(reportFile) && Date.now() - t0 >= 2000)
  ok('화면: 측정이 리포트 대기만큼 길어지지 않는다', returnedMs < 2000)

  // 6) 뒤에서 쓰는 옛 리포트가 같은 주를 다시 잰 측정의 리포트를 덮지 않는다
  let saves = 0
  const counting = new FileResultStore()
  const save = counting.saveReport.bind(counting)
  counting.saveReport = async (...args) => {
    saves += 1
    await save(...args)
  }
  // 가짜 리포트 본문 끝의 「(delay=값)」으로 어느 측정의 리포트인지 가린다 — 옛 측정은 1500, 새 측정은 0.
  rmSync(reportFile, { force: true })
  process.env.MOCK_REPORT_DELAY_MS = '1500'
  await measureAndBake({ ...tenant }, counting, { selfOnly: true, backgroundReport: true })
  process.env.MOCK_REPORT_DELAY_MS = '0'
  await measureAndBake({ ...tenant }, counting, { selfOnly: true, backgroundReport: true })
  await settlePendingReports()
  ok(
    '다시 잰 주: 늦게 끝난 옛 리포트는 저장하지 않는다(새 리포트 1건만)',
    saves === 1 && existsSync(reportFile) && readFileSync(reportFile, 'utf8').includes('(delay=0)'),
  )
} finally {
  delete process.env.MOCK_REPORT_DELAY_MS
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
