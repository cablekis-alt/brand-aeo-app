/**
 * 측정 진행 표시의 남은 시간(src/lib/measureEstimate.ts)과, 서버가 그 재료(보낸 시각 · 응답 시간)를 보내는지 확인한다.
 * 실제 API는 부르지 않는다(가짜 엔진 · 임시 폴더).
 *
 * 왜: v0.4.22까지의 어림은 「남은 건수 × 경과 ÷ 끝낸 건수」를 매 렌더 다시 계산해 —
 *  - 응답만 기다리는 수집 끝자락에서 크게 짧게 말했다(2026-W43 군산각 전국 1분 52초에 「약 26초」, 실제 약 2분 30초).
 *  - 수집 뒤 단계(인용 정리 · 분석 · 집계)를 수집의 0.15배로만 셌고, 분석 단계에서는 측정 전체 경과로 나눠 1,500초가 튀었다.
 *  - 폴링 사이에 경과만 늘어 숫자가 거꾸로 올라갔다(22 → 23 → 24초).
 *
 *   npx tsx scripts/verify-measure-estimate.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createEtaState,
  createEtaTracker,
  estimateFinishAt,
  formatDuration,
  rememberRows,
  stepEta,
  tickEta,
  waitingNote,
  type EngineProgress,
  type EtaState,
  type ProgressRow,
} from '../src/lib/measureEstimate'

const checks: [string, boolean, string][] = []
const ok = (label: string, cond: boolean, detail = '') => checks.push([label, cond, detail])
const NOW = 1_800_000_000_000
const ago = (sec: number) => NOW - sec * 1000
const leftSec = (rows: ProgressRow[], at = NOW) => {
  const end = estimateFinishAt(rows, at, rememberRows({}, rows))
  return end === null ? null : (end - at) / 1000
}
const ms = (secs: number[]) => secs.map((s) => Math.round(s * 1000))

// ── 2026-W43 군산각 전국(OpenAI + Perplexity 72건) 경과 112초 — 기록에서 다시 세운 서버 상태 그대로.
// OpenAI 36/36 끝, Perplexity 31/36 — 남은 5건은 69~83초째 응답을 기다린다(안 보낸 호출 0). 실제로 남은 시간: 119초(리포트 안 기다림).
const OPENAI_LAT = ms([6.3, 8.6, 10, 11.1, 11.5, 11.8, 12.8, 13.8, 13.8, 14.1, 14.2, 14.7, 15.1, 15.1, 15.7, 16.1, 16.2, 16.2, 16.5, 17, 17.1, 18.7, 18.7, 19.6, 20, 20.5, 20.8, 20.8, 23.6, 24.3, 24.6, 26, 26, 28.6, 28.9, 37.3])
const PPLX_LAT = ms([5.5, 6.1, 6.3, 6.4, 8.4, 8.8, 9.5, 9.6, 11.4, 13.2, 13.4, 14.3, 14.4, 17.4, 17.6, 21, 21.3, 24.5, 24.7, 26.3, 30.9, 36.3, 39.6, 42.1, 44.6, 45.7, 46.1, 48.1, 52.3, 57.7, 64])
const gunsan = (pplx: Partial<EngineProgress> = {}): ProgressRow => ({
  tenantId: 'gunsan-national',
  stage: '수집',
  stageStartedAt: ago(112),
  done: 36 + (pplx.done ?? 31),
  total: 72,
  engines: {
    openai: { done: 36, total: 36, inflightSentAt: [], latencyMs: OPENAI_LAT, slots: 36, rpm: 0 },
    perplexity: { done: 31, total: 36, inflightSentAt: [ago(82.6), ago(75.9), ago(74.6), ago(73.3), ago(69.3)], latencyMs: PPLX_LAT, slots: 24, rpm: 45, ...pplx },
  },
})
const g112 = leftSec([gunsan()])
ok('응답만 기다리는 수집 끝자락: 기다린 시간으로 어림한다(실제 119초 · 옛 어림 26초)', g112 !== null && g112 >= 90 && g112 <= 150, `${g112?.toFixed(0)}초`)
const gFresh = leftSec([gunsan({ inflightSentAt: [ago(5), ago(4), ago(3), ago(2), ago(1)] })])
ok('같은 5건이라도 방금 보냈으면 더 짧다 — 오래 기다린 호출일수록 늦게 온다', gFresh !== null && g112 !== null && gFresh < g112, `방금 보냄 ${gFresh?.toFixed(0)}초 < 70~80초째 ${g112?.toFixed(0)}초`)

// ── 숫자를 내지 않는 때.
ok('준비 중인 줄만 있으면 숫자를 내지 않는다', leftSec([{ tenantId: 'x' }]) === null)
ok('옛 서버(보낸 시각 · 응답 시간 필드 없음)면 숫자를 내지 않는다', leftSec([{ tenantId: 'old', stage: '수집', done: 10, total: 72, engines: { openai: { done: 10, total: 36 } } }]) === null)
const early = gunsan({ done: 2, inflightSentAt: [ago(10), ago(9)], latencyMs: ms([7, 9]) })
ok('남은 일이 있는 엔진의 응답이 3건 모이기 전에는 숫자를 내지 않는다(사전 분포만의 첫 숫자는 절반쯤이었다)', leftSec([early]) === null)

// ── 준비 중인 줄이 섞이면 수집 중인 가장 큰 줄과 같은 일을 하나도 안 한 줄로 센다(숫자가 줄지 않는다).
const withPreparing = leftSec([gunsan(), { tenantId: 'next' }])
ok('준비 중인 줄이 섞이면 그 줄의 일감까지 센다', withPreparing !== null && g112 !== null && withPreparing > g112 + 30, `${withPreparing?.toFixed(0)}초 > ${g112?.toFixed(0)}초 + 30`)

// ── 분당 상한: 줄들이 Perplexity 시작 간격(45회/분 = 1.33초)을 함께 쓴다 — 두 줄에 안 보낸 36건씩이면 적어도 72 × 1.33 = 96초.
const pacedRow = (id: string): ProgressRow => ({
  tenantId: id,
  stage: '수집',
  stageStartedAt: ago(20),
  done: 6,
  total: 42,
  engines: { perplexity: { done: 6, total: 42, inflightSentAt: [], latencyMs: ms([12, 14, 15, 16, 18, 20]), slots: 24, rpm: 45 } },
})
const paced = leftSec([pacedRow('a'), pacedRow('b')])
ok('분당 상한은 줄끼리 함께 쓴다(두 줄 72건 ≥ 96초 + 뒤 단계)', paced !== null && paced >= 96 + 20, `${paced?.toFixed(0)}초`)

// ── 수집 뒤 단계.
const allSent = gunsan({ done: 36, inflightSentAt: [] })
const tail = leftSec([allSent])
ok('호출이 다 끝나도 인용 정리 · 분석 · 집계 몫(72건 약 24초)이 남는다', tail !== null && tail >= 15 && tail <= 40, `${tail?.toFixed(0)}초`)
const citeMem = rememberRows({}, [allSent])
const citeEnd = estimateFinishAt([{ tenantId: 'gunsan-national', stage: '인용 정리', stageStartedAt: ago(1), done: 0, total: 0 }], NOW, citeMem)
const cite = citeEnd === null ? null : (citeEnd - NOW) / 1000
ok('인용 정리: 수집 때 본 건수(72)로 분석 몫을 센다(Gemini 없음)', cite !== null && cite >= 20 && cite <= 30, `${cite?.toFixed(1)}초`)
const ana = leftSec([{ tenantId: 'a', stage: '분석', stageStartedAt: ago(5), done: 10, total: 72 }])
ok('분석 10/72(시작 5초): 수백 초로 튀지 않는다(옛 어림 1,544초)', ana !== null && ana >= 10 && ana <= 30, `${ana?.toFixed(0)}초`)
const anaLate = leftSec([{ tenantId: 'a', stage: '분석', stageStartedAt: ago(30), done: 60, total: 72 }])
ok('분석 60/72(30초째): 실제 속도로 옮겨 간다', anaLate !== null && anaLate >= 1 && anaLate <= 12, `${anaLate?.toFixed(1)}초`)
const agg = leftSec([{ tenantId: 'a', stage: '집계', stageStartedAt: ago(0.1), done: 0, total: 0 }])
ok('집계만 남으면 1초 안쪽', agg !== null && agg <= 1, `${agg?.toFixed(1)}초`)
const report = leftSec([{ tenantId: 'a', stage: '리포트', stageStartedAt: ago(4), done: 0, total: 0 }])
ok('리포트(화면 밖에서 시작한 측정): 16초 − 지난 시간', report !== null && Math.abs(report - 12) < 0.5, `${report?.toFixed(1)}초`)

// ── 표시: 폴링 사이에는 숫자가 오르지 않는다 · 작은 차이는 속도로 메운다 · 큰 차이만 고친다 · 바닥에서는 문구.
let st: EtaState = createEtaState()
const view = (t: number, end?: number | null) => {
  const r = stepEta(st, NOW + t, end === undefined || end === null ? end : NOW + end)
  st = r.state
  return r.view
}
const sec = (v: ReturnType<typeof view>) => (v.kind === 'number' ? Math.round(v.ms / 1000) : null)
view(0, 100_000)
const shown = [1000, 2000, 3000, 4000].map((t) => sec(view(t)))
ok('폴링 사이 1초마다 1초씩 준다', shown.join(',') === '99,98,97,96', shown.join(' → '))
const glide = view(5000, 5000 + 105_000)
ok('새 어림이 조금 길면(+10초) 숫자를 올리지 않는다', sec(glide) === 95)
ok('… 대신 천천히 줄인다(0.5배속)', sec(view(6000)) === 95 && sec(view(7000)) === 94)
const jump = view(10_000, 10_000 + 150_000)
ok('새 어림이 많이 길면(+60초) 바로 올린다 — 늦어진 것을 숨기지 않는다', sec(jump) === 150)
const cool = view(15_000, 15_000 + 220_000)
ok('올린 뒤 15초 안에는 다시 올리지 않는다(톱니 막기)', (sec(cool) ?? 999) < 150)
const again = view(26_000, 26_000 + 220_000)
ok('15초가 지나면 다시 올린다', sec(again) === 220)
const down = view(30_000, 30_000 + 30_000)
ok('새 어림이 많이 짧으면 바로 내린다', sec(down) === 30)
let last = view(31_000)
for (let t = 32_000; t <= 60_000; t += 1000) last = view(t)
ok('바닥(3초)에 닿으면 「마무리 중」 — 0초나 음수를 보이지 않는다', last.kind === 'text' && last.text === '마무리 중')
ok('「마무리 중」에서 새 어림이 짧으면(8초) 문구를 유지', view(61_000, 61_000 + 8_000).kind === 'text')
ok('「마무리 중」에서 새 어림이 20초를 넘으면 숫자로 돌아간다', sec(view(66_000, 66_000 + 45_000)) === 45)
ok('어림 불가(null)면 보이던 카운트다운을 이어 간다', sec(view(67_000, null)) === 44)

// ── tickEta: 새 폴링 응답이 있는 시계에서만 다시 어림한다(같은 상태로 다시 어림하면 경과만 늘어 숫자가 오른다).
let tr = createEtaTracker()
const seen: number[] = []
for (let t = 0; t <= 10_000; t += 1000) {
  const r = tickEta(tr, t === 0 ? [gunsan()] : null, NOW + t)
  tr = r.tracker
  if (r.view.kind === 'number') seen.push(Math.round(r.view.ms / 1000))
}
ok('폴링 사이 1초 시계에서는 숫자가 커지지 않는다(역주행 0)', seen.length === 11 && seen.every((v, i) => i === 0 || v < seen[i - 1]!), seen.join(' → '))

// ── 무엇을 기다리나.
const labels = { openai: 'ChatGPT', perplexity: 'Perplexity' }
ok('응답만 기다리고 가장 오래된 것이 30초를 넘으면 무엇을 기다리는지 알린다', waitingNote([gunsan()], NOW, labels) === 'Perplexity 응답 5건 기다리는 중(가장 오래된 것 1분 23초째)', waitingNote([gunsan()], NOW, labels) ?? 'null')
ok('아직 보낼 호출이 남았으면 알리지 않는다', waitingNote([pacedRow('a')], NOW, labels) === null)
ok('방금 보낸 호출만 기다리면 알리지 않는다(30초 안쪽)', waitingNote([gunsan({ inflightSentAt: [ago(20), ago(10), ago(9), ago(8), ago(7)] })], NOW, labels) === null)
const two = gunsan()
two.engines!.openai = { done: 34, total: 36, inflightSentAt: [ago(40), ago(35)], latencyMs: OPENAI_LAT.slice(0, 34), slots: 36, rpm: 0 }
ok('엔진이 둘이면 건수 많은 순으로', waitingNote([two], NOW, labels) === 'Perplexity 5건 · ChatGPT 2건 응답 기다리는 중(가장 오래된 것 1분 23초째)', waitingNote([two], NOW, labels) ?? 'null')
ok('formatDuration: 45초 · 2분 · 1분 23초', formatDuration(45_000) === '45초' && formatDuration(120_000) === '2분' && formatDuration(82_600) === '1분 23초')

// ── 서버가 어림 재료를 보내는가 — 가짜 엔진으로 측정하며, 호출을 보낸 순간 · 판정을 부른 순간의 진행 상태를 그대로 적는다
// (타이머로 엿보면 가짜 호출이 너무 빨라 놓친다). 임시 폴더를 APP_DATA_DIR로 쓴다.
const dir = mkdtempSync(path.join(tmpdir(), 'verify-measure-estimate-'))
process.env.APP_DATA_DIR = dir
process.env.BLOB_READ_WRITE_TOKEN = ''
process.env.BLOB_STORE_ID = ''
process.env.USE_MOCK_ENGINES = 'true'
// 4건씩 돌려, 뒤에 보내는 호출 때는 앞 호출의 응답 시간이 이미 쌓여 있게 한다.
process.env.COLLECTION_CONCURRENCY = '4'
try {
  const { measureAndBake } = await import('../server/measureAndBake')
  const { listActiveMeasures } = await import('../server/measureTracker')
  const { MockEngineClient } = await import('../server/engines/mockEngineClient')
  const { MockJudgeClient } = await import('../server/engines/mockJudgeClient')
  const { FileResultStore } = await import('../server/store')
  const reg = await import('../server/tenantRegistry')
  const file = path.join(dir, 'tenants.overlay.json')
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(
    file,
    JSON.stringify([
      {
        tenantId: 'eta', brandName: '어림 펜션', aliases: ['어림 펜션'], ownedDomains: ['eta.example'], industry: '펜션', region: '가상시',
        engines: ['gemini', 'perplexity'], questionBankSize: 4, questionBankVersion: 'v1', repeatsPerQuestion: 2, factGraph: [],
        competitors: [{ name: '옆집 펜션', aliases: ['옆집 펜션'], domains: ['next.example'] }],
      },
    ]),
  )
  const tenant = (await reg.loadRuntimeTenants()).find((t) => t.tenantId === 'eta')!
  const snaps: (ProgressRow & { sentBy?: string })[] = []
  const snapshot = (sentBy?: string) => {
    for (const m of listActiveMeasures()) snaps.push({ ...(structuredClone(m) as unknown as ProgressRow), sentBy })
  }
  const engineCall = MockEngineClient.prototype.call
  const judgeCall = MockJudgeClient.prototype.call
  MockEngineClient.prototype.call = function (this: InstanceType<typeof MockEngineClient>, prompt, options) {
    return engineCall.call(this, prompt, {
      onSend: () => {
        options?.onSend?.()
        snapshot((this as unknown as { engine?: string }).engine)
      },
    })
  }
  MockJudgeClient.prototype.call = function (this: InstanceType<typeof MockJudgeClient>, prompt) {
    snapshot()
    return judgeCall.call(this, prompt)
  }
  try {
    await measureAndBake({ ...tenant }, new FileResultStore(), { selfOnly: true })
  } finally {
    MockEngineClient.prototype.call = engineCall
    MockJudgeClient.prototype.call = judgeCall
  }
  const pp = snaps.filter((m) => m.stage === '수집' && m.sentBy === 'perplexity').map((m) => m.engines?.perplexity)
  ok(
    '서버: 호출을 보내면 그 시각 · 슬롯 · 분당 상한을 바로 보낸다',
    pp.length === 8 && pp.every((e) => (e?.inflightSentAt?.length ?? 0) > 0 && e!.slots === 24 && e!.rpm === 45),
    `보낸 순간 ${pp.length}회`,
  )
  ok('서버: 끝난 호출의 응답 시간을 쌓는다', pp.some((e) => (e?.latencyMs?.length ?? 0) >= 3 && e!.latencyMs!.every((v) => v > 0)))
  const collecting = snaps.filter((m) => m.stage === '수집' && m.engines)
  ok(
    '서버: 끝낸 건수 + 기다리는 건수는 전체를 넘지 않는다',
    collecting.length > 0 && collecting.every((m) => Object.values(m.engines!).every((e) => e.done + (e.inflightSentAt?.length ?? 0) <= e.total)),
  )
  ok('서버: 단계가 바뀐 시각을 찍는다', snaps.length > 0 && snaps.every((m) => !m.stage || typeof m.stageStartedAt === 'number'))
  ok('서버: 수집이 끝나면 엔진 진행을 지운다', snaps.filter((m) => m.stage && m.stage !== '수집').every((m) => m.engines === undefined))
} finally {
  delete process.env.COLLECTION_CONCURRENCY
  rmSync(dir, { recursive: true, force: true })
}

let failed = 0
for (const [label, pass, detail] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${label}${detail ? ` (${detail})` : ''}`)
  if (!pass) failed += 1
}
if (failed > 0) {
  console.error(`\n${failed}건 실패`)
  process.exit(1)
}
console.log(`\n모두 통과 (${checks.length}건)`)
