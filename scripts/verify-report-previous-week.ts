/**
 * 첫 측정 주차의 「전주」(aeoScore.previousWeek)와 주간 리포트 프롬프트(B8 buildWeeklyReportPrompt)를 확인한다.
 * 임시 폴더를 APP_DATA_DIR로 쓰고 가짜 브랜드 · 가짜 엔진만 쓴다.
 *
 * 왜(2026-10-17 데이터 검토): gunsan W42(지금 gunsan-national W42)는 첫 측정인데 report.md가 「3주 연속 같은 값」이라고 썼다.
 * 앞 측정이 없으면 previousWeek에 이번 주 점수를 채워, 프롬프트에 「이번주 2 / 4주 이동평균 2 / 전주 2」가 들어갔다 — 글쓰기
 * 모델은 같은 숫자 셋을 연속으로 읽었다. 재지 않은 값을 채우지 않는다: 앞 측정이 없으면 null, 프롬프트는 「첫 측정」이라고 적는다.
 * 앞 측정이 있어도 측정 조건이 다르면 증감으로 읽지 않는다(src/lib/comparability.ts — 정기진단 보고서 표지와 같은 규칙).
 *
 *   npx tsx scripts/verify-report-previous-week.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildPeriodicReport } from '../src/lib/b9-report'
import { comparableWith } from '../src/lib/comparability'
import { buildWeeklyReportPrompt, type WeeklyScorecard } from '../src/prompts/b8-report'
import type { PromptMessage } from '../src/prompts/types'

const dir = mkdtempSync(path.join(tmpdir(), 'verify-report-previous-week-'))
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

const card = (weekOf: string, current: number, previousWeek: number | null, extra: Partial<WeeklyScorecard> = {}) =>
  ({
    tenantId: 'v',
    weekOf,
    industry: '펜션',
    region: '가상시',
    brandName: '가상 펜션',
    aeoScore: { current, previousWeek, ma4: current, ciLow: 0, ciHigh: current + 8 },
    mentionRate: 0,
    shareOfMention: null,
    avgRecommendationRank: null,
    rankedResponses: 0,
    factualityScore: null,
    brandOwnedCitationRate: 0,
    cohortRank: { position: 1, totalTenants: 1 },
    hallucinationFlags: [],
    enginesUsed: ['gemini'],
    judgeEngine: 'gemini',
    questionBankVersion: 'v1',
    ...extra,
  }) as WeeklyScorecard
const scoreLine = (p: PromptMessage) => p.user.split('\n').find((l) => l.startsWith('- AEO Score:')) ?? ''

// 1) 프롬프트 — 앞 측정이 없으면 「첫 측정」, 이동평균도 없다(측정 1회의 평균은 이번 주 점수 그대로다)
const w42 = card('2026-W42', 2, null)
const firstLine = scoreLine(buildWeeklyReportPrompt(w42, { comparison: comparableWith([w42], '2026-W42') }))
ok('첫 측정: 「첫 측정 — 비교할 이전 주차 없음」', firstLine.includes('첫 측정 — 비교할 이전 주차 없음'))
ok('첫 측정: 전주 점수를 적지 않는다(「전주 2」 없음)', !/전주 \d/.test(firstLine))
ok('첫 측정: 4주 이동평균 숫자를 적지 않는다', !/이동평균 \d/.test(firstLine) && firstLine.includes('측정 1회뿐'))
ok('첫 측정: comparison 없이 불러도 같다', scoreLine(buildWeeklyReportPrompt(w42)) === firstLine)
const firstSystem = buildWeeklyReportPrompt(w42).system
ok('시스템 지시: 비교 값이 없으면 증감 · 보합 · 연속을 쓰지 않는다', firstSystem.includes('연속') && firstSystem.includes('보합'))

// 2) 앞 측정이 있고 같은 조건 — 지금처럼 「전주 N」
const w41 = card('2026-W41', 5, null)
const w42b = card('2026-W42', 7, 5)
const nextLine = scoreLine(buildWeeklyReportPrompt(w42b, { comparison: comparableWith([w41, w42b], '2026-W42') }))
ok('같은 조건 전주: 「전주 5」 · 이동평균 숫자', nextLine.includes('전주 5') && /4주 이동평균 \d/.test(nextLine))
ok('comparison 없이 부르면 저장된 전주 그대로', scoreLine(buildWeeklyReportPrompt(w42b)).includes('전주 5'))

// 3) 앞 측정이 2주 이상 떨어짐 — 「전주」가 아니라 「직전 측정(Wxx)」
const w38 = card('2026-W38', 5, null)
const w40 = card('2026-W40', 7, 5)
const gapLine = scoreLine(buildWeeklyReportPrompt(w40, { comparison: comparableWith([w38, w40], '2026-W40') }))
ok('떨어진 앞 측정: 「직전 측정(2026-W38, 2주 전) 5」', gapLine.includes('직전 측정(2026-W38, 2주 전) 5') && !gapLine.includes('전주'))

// 4) 앞 측정이 있지만 측정 조건이 다름 — 증감으로 읽지 않는다고 적는다
const w41g = card('2026-W41', 30, null)
const w42c = card('2026-W42', 39, 30, { judgeEngine: 'claude' })
const switchLine = scoreLine(buildWeeklyReportPrompt(w42c, { comparison: comparableWith([w41g, w42c], '2026-W42') }))
ok('판정 엔진 바뀜: 직전 점수와 이유를 적는다', switchLine.includes('직전 측정(2026-W41) 30') && switchLine.includes('판정 엔진') && switchLine.includes('증감으로 읽지 않음'))
ok('판정 엔진 바뀜: 「전주 30」이라고 적지 않는다', !switchLine.includes('전주 30'))
const w42u = card('2026-W42', 39, 30, { judgeModel: 'claude-sonnet-5-5' })
const unknownLine = scoreLine(buildWeeklyReportPrompt(w42u, { comparison: comparableWith([w41g, w42u], '2026-W42') }))
ok('기록이 한쪽에만 있음: 「달라」가 아니라 「기록이 한쪽에 없어」', unknownLine.includes('기록이 한쪽에 없어(판정 모델)') && !unknownLine.includes('달라'))

// 5) 정기진단 보고서 표지 — null이면 「전주 기록 없음」(옛 카드처럼 이번 주 점수로 채워져 있어도 같다)
const cover = (c: WeeklyScorecard) => buildPeriodicReport([c], c.weekOf)!.verdict.summary
ok('보고서 표지: previousWeek null → 「전주 기록 없음」', cover(card('2026-W42', 2, null)).includes('전주 기록 없음'))
ok('보고서 표지: 옛 카드(전주 = 이번 주) → 「전주 기록 없음」', cover(card('2026-W42', 2, 2)).includes('전주 기록 없음'))
ok('보고서 표지: 앞 측정이 이력 밖 → 「확인 불가」', cover(card('2026-W42', 2, 9)).includes('확인 불가'))

// 6) 파이프라인 — 첫 측정 카드는 previousWeek null로 저장되고 리포트 프롬프트가 「첫 측정」을 받는다. 다음 주는 그 점수가 전주다.
try {
  const { runWeeklyPipeline } = await import('../server/pipeline')
  const { FileResultStore } = await import('../server/store')
  const { MockJudgeClient } = await import('../server/engines/mockJudgeClient')
  const reg = await import('../server/tenantRegistry')
  writeJson('tenants.overlay.json', [
    {
      tenantId: 'pfirst', brandName: '첫측정 펜션', aliases: ['첫측정 펜션'], ownedDomains: ['pfirst.example'], industry: '펜션', region: '가상시',
      engines: ['gemini'], questionBankSize: 3, questionBankVersion: 'v1', repeatsPerQuestion: 1, factGraph: [], competitors: [],
    },
  ])
  process.env.COLLECT_ENGINES = 'gemini'
  const store = new FileResultStore()
  const tenant = (await reg.loadRuntimeTenants()).find((t) => t.tenantId === 'pfirst')!

  const reportPrompts: PromptMessage[] = []
  const judgeCall = MockJudgeClient.prototype.call
  MockJudgeClient.prototype.call = async function (prompt: PromptMessage) {
    if (prompt.system.includes('주간 리포트를 작성하는 애널리스트')) reportPrompts.push(prompt)
    return judgeCall.call(this, prompt)
  }
  try {
    const first = await runWeeklyPipeline(tenant, store, new Date('2026-10-14T03:00:00Z'))
    const history = () => JSON.parse(readFileSync(path.join(dir, 'data/pfirst/scorecard-history.json'), 'utf8')) as WeeklyScorecard[]
    ok('파이프라인 첫 측정(W42): previousWeek null', first.scorecard.weekOf === '2026-W42' && first.scorecard.aeoScore.previousWeek === null)
    ok('파이프라인 첫 측정: 저장된 카드도 null', history().find((h) => h.weekOf === '2026-W42')?.aeoScore.previousWeek === null)
    ok('파이프라인 첫 측정: 리포트 프롬프트가 「첫 측정」을 받는다', reportPrompts.length === 1 && scoreLine(reportPrompts[0]!).includes('첫 측정 — 비교할 이전 주차 없음'))

    const second = await runWeeklyPipeline(tenant, store, new Date('2026-10-21T03:00:00Z'))
    const w42score = first.scorecard.aeoScore.current
    ok('파이프라인 다음 주(W43): 전주 = W42 점수', second.scorecard.weekOf === '2026-W43' && second.scorecard.aeoScore.previousWeek === w42score)
    ok('파이프라인 다음 주: 리포트 프롬프트에 「전주 N」', reportPrompts.length === 2 && scoreLine(reportPrompts[1]!).includes(`전주 ${w42score}`))

    // 같은 주를 다시 재도 그 주의 앞 측정 카드가 「전주」가 되지 않는다(W42만 있는 브랜드의 W42 재측정 = 여전히 첫 측정)
    writeJson('data/pfirst/scorecard-history.json', history().filter((h) => h.weekOf === '2026-W42'))
    const again = await runWeeklyPipeline(tenant, store, new Date('2026-10-15T03:00:00Z'))
    ok('같은 주 재측정: 여전히 첫 측정(null)', again.scorecard.weekOf === '2026-W42' && again.scorecard.aeoScore.previousWeek === null)
  } finally {
    MockJudgeClient.prototype.call = judgeCall
  }
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
