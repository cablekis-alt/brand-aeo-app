/**
 * 두 측정을 증감으로 견줘도 되는가 — 앱 전체가 쓰는 규칙 하나(src/lib/comparability.ts)를 확인한다.
 *
 * 왜(2026-10-25 「같은 조건」 규칙 통일): 규칙이 화면마다 8갈래 넘게 갈려, 같은 두 주를 두고 그래프는 선을 끊는데 보고서 표지는
 * 「전주 대비 -44」를 찍고, 개요 칩은 「질문지 달라 비교 불가」인데 알림은 「상승 +11점」이었다. 값은 실측을 흉내 낸 가짜다.
 *
 *   npx tsx scripts/verify-comparability.ts
 */
import {
  comparableRun,
  comparableWith,
  compareConditions,
  conditionChanges,
  conditionReason,
  runAverage,
  siteComparable,
  weeksBetween,
} from '../src/lib/comparability'
import { comparisonFromHistory } from '../src/lib/citationView'
import type { WeeklyScorecard } from '../src/prompts/b8-report'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

const base = {
  enginesUsed: ['gemini', 'openai', 'perplexity'],
  judgeEngine: 'gemini',
  modelsUsed: { gemini: 'gemini-3.7-flash', openai: 'gpt-6-luna', perplexity: 'preset:low' },
  judgeModel: 'gemini-3.7-flash',
  questionBankVersion: 'v4',
  repeatsPerQuestion: 1,
}
const card = (weekOf: string, score: number, extra: Partial<WeeklyScorecard> = {}) =>
  ({ weekOf, aeoScore: { current: score }, ...base, ...extra }) as unknown as WeeklyScorecard
const claude = { judgeEngine: 'claude', judgeModel: 'claude-sonnet-5-5' }

// 1) 판정만 바뀜(실측 경쟁사 W41→W42 Gemini → Claude)
const judgeOnly = compareConditions(card('2026-W41', 30), card('2026-W42', 39, claude))
ok('판정만 바뀜: 판정 엔진 · 판정 모델 둘 다 바뀜', judgeOnly.map((d) => d.dimension).join(',') === '판정 엔진,판정 모델' && judgeOnly.every((d) => d.state === 'changed'))
ok('판정만 바뀜: 이유 첫 구절에 값', conditionReason(judgeOnly).startsWith('판정 엔진 Gemini → Claude'))

// 2) 질문지 · 반복만 바뀜(실측 mercury W38→W40) — 예전 숫자 칸 규칙은 통과시켰다
const qr = compareConditions(card('2026-W38', 9, { questionBankVersion: 'v4', repeatsPerQuestion: 3 }), card('2026-W40', 20, { questionBankVersion: 'v7' }))
ok('질문지 · 반복 바뀜', qr.map((d) => d.dimension).join(',') === '질문지,반복 횟수')

// 3) 한쪽에만 기록 — 확인 불가(견주지 않음), 양쪽 다 없음 — 같음
const oneSide = compareConditions(card('2026-W38', 9, { judgeModel: undefined }), card('2026-W39', 11))
ok('한쪽만 판정 모델 기록: 확인 불가', oneSide.length === 1 && oneSide[0]!.dimension === '판정 모델' && oneSide[0]!.state === 'unknown')
const bothMissing = compareConditions(
  card('2026-W36', 9, { judgeModel: undefined, judgeEngine: undefined, modelsUsed: undefined, questionBankVersion: undefined }),
  card('2026-W37', 11, { judgeModel: undefined, judgeEngine: undefined, modelsUsed: undefined, questionBankVersion: undefined }),
)
ok('양쪽 다 기록 없음: 같음', bothMissing.length === 0)
ok('빈 수집 모델 기록은 기록 없음', compareConditions(card('2026-W38', 1, { modelsUsed: {} }), card('2026-W39', 1, { modelsUsed: {} })).length === 0)

// 4) 수집 모델만 바뀜
const model = compareConditions(card('2026-W41', 1), card('2026-W42', 1, { modelsUsed: { ...base.modelsUsed, gemini: 'gemini-3.8-flash' } }))
ok('수집 모델 바뀜(엔진 이름과 함께)', model.length === 1 && model[0]!.dimension === '수집 모델' && model[0]!.to === 'Gemini gemini-3.8-flash')

// 5) 엔진 하나로 좁혀 보기
const g = card('2026-W41', 1, { enginesUsed: ['gemini'], modelsUsed: { gemini: 'gemini-3.7-flash' } })
const go = card('2026-W42', 1, { enginesUsed: ['gemini', 'openai'], modelsUsed: { gemini: 'gemini-3.7-flash', openai: 'gpt-6-luna' } })
ok('엔진 좁혀 보기: 두 주 모두 Gemini면 견준다', compareConditions(g, go, { engine: 'gemini' }).length === 0)
ok('엔진 좁혀 보기: 한 주에 ChatGPT가 없으면 수집 엔진 바뀜', compareConditions(g, go, { engine: 'openai' })[0]?.dimension === '수집 엔진')
ok('엔진 안 좁히면 엔진 집합 바뀜', conditionChanges(g, go)[0] === '수집 엔진')

// 6) 주 간격 · 해 넘김
ok('W38→W40은 2주', weeksBetween('2026-W38', '2026-W40') === 2)
ok('2026-W53→2027-W01은 1주(2026년은 53주)', weeksBetween('2026-W53', '2027-W01') === 1)

// 7) 앞 측정과 견주기 — 떨어진 주 · 앞 측정 없음
const hist = [card('2026-W38', 10), card('2026-W40', 12), card('2026-W41', 15, claude), card('2026-W42', 18, claude)]
const c40 = comparableWith(hist, '2026-W40')
ok('W40: 직전 측정 W38, 2주 떨어짐, 견줄 수 있음', c40.comparable && c40.previousWeekOf === '2026-W38' && c40.gapWeeks === 2)
const c41 = comparableWith(hist, '2026-W41')
ok('W41: 판정이 바뀌어 견주지 않음, 이유에 직전 측정 주차', !c41.comparable && c41.reason.startsWith('직전 측정(2026-W40)과 측정 조건이 달라'))
const c38 = comparableWith(hist, '2026-W38')
ok('W38: 앞 측정 없음', c38.previousWeekOf === null && !c38.comparable)

// 8) 같은 조건 연속 구간 · 평균
ok('구간: W42는 W41–W42', comparableRun(hist, '2026-W42').map((c) => c.weekOf).join(',') === '2026-W41,2026-W42')
ok('구간: W40은 W38–W40', comparableRun(hist, '2026-W40').length === 2)
ok('평균: W42 같은 조건 2주 평균 17', runAverage(hist, '2026-W42')?.average === 17 && runAverage(hist, '2026-W42')?.weeks === 2)
ok('평균: 조건이 바뀐 첫 주(W41)는 평균 없음', runAverage(hist, '2026-W41') === null)

// 9) 사이트 진단(실측 ktcorp W40 corp.kt.com 57 → W41 www.kt.com 0)
ok('사이트: 주소가 다르면 견주지 않음', !siteComparable({ url: 'https://corp.kt.com/', collectionMode: 'static' }, { url: 'https://www.kt.com/', collectionMode: 'static' }))
ok('사이트: www · 스킴 · 끝 / 차이는 같은 주소', siteComparable({ url: 'https://www.x.com/', collectionMode: 'static' }, { url: 'http://x.com', collectionMode: 'static' }))
ok('사이트: 수집 방식이 다르면 견주지 않음', !siteComparable({ url: 'https://x.com/', collectionMode: 'static' }, { url: 'https://x.com/', collectionMode: 'browser' }))

// 10) 숫자 칸 · 인용 갭(comparisonFromHistory)이 같은 규칙을 쓴다
const mercury = [card('2026-W38', 9, { questionBankVersion: 'v4', repeatsPerQuestion: 3 }), card('2026-W40', 20, { questionBankVersion: 'v7' })]
const mc = comparisonFromHistory(mercury, '2026-W40', null)
ok('숫자 칸: 질문지 · 반복이 바뀐 주는 견주지 않음', mc !== null && !mc.comparable && (mc.reason ?? '').includes('질문지'))
const gc = comparisonFromHistory([g, go], '2026-W42', 'openai')
ok('인용 갭: 엔진 하나로 좁혔는데 그 엔진 응답이 한쪽에 없으면 그 이유', gc !== null && !gc.comparable && (gc.reason ?? '').includes('ChatGPT 응답이 없어'))
ok('인용 갭: 견줄 수 있으면 comparable', comparisonFromHistory([card('2026-W41', 1), card('2026-W42', 2)], '2026-W42', null)?.comparable === true)

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
