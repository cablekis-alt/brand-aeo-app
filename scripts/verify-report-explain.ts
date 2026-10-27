/**
 * 정기진단 보고서의 「점수 풀이」(src/lib/reportExplain.ts)와 순위 문구 · 강점 · 기대효과(src/lib/b9-report.ts)를 확인한다.
 *
 * 왜(2026-10-26 스테이,머뭄 W44 12점 분석): 12점 중 11점이 이름 없이 물은 질문의 답 2건(같은 질문 하나)에서 나왔는데 보고서에는
 * 비중 꼬리표만 있었고, 순위 칸은 「AI가 추천을 나열할 때 상위에 배치됩니다」라고 「잘하고 있는 점」에까지 적었다(그 2건은 실제 답에서
 * 2번째 · 4번째였다 — 순위는 비교 그룹 이름 안에서만 매긴다). 같은 숫자를 가상 데이터로 다시 만들어 문장을 본다.
 *
 *   npx tsx scripts/verify-report-explain.ts
 */
import { aeoScoreOf, buildPeriodicReport } from '../src/lib/b9-report'
import type { RunHistory, RunPoint } from '../src/lib/api'
import { hostName } from '../src/lib/hostNames'
import { explainScore, ownedDomainCitations, recentRuns, runLabel, separateRunNote, topSourceDomains } from '../src/lib/reportExplain'
import type { QuestionBank, QuestionRepeatAnalysis } from '../src/lib/types'
import type { CitationSourceAnalysis } from '../src/prompts/b7-citation-sources'
import type { WeeklyScorecard } from '../src/prompts/b8-report'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

const ENGINES = ['openai', 'gemini', 'perplexity'] as const

/** 이름 없는 질문 26개 · 이름 넣은 질문 16개 은행(가상). */
const bank = {
  version: 'v9',
  generatedAt: '',
  questions: [
    ...Array.from({ length: 26 }, (_, i) => ({ questionId: `g-${i}`, text: `가상 일반 질문 ${i}`, category: 'category-agnostic', containsBrandName: false })),
    ...Array.from({ length: 16 }, (_, i) => ({ questionId: `n-${i}`, text: `가상브랜드 질문 ${i}`, category: 'brand-direct', containsBrandName: true })),
  ],
} as unknown as QuestionBank

const analysis = (questionId: string, engine: string, mentioned: boolean, brandRank: number | null = null) =>
  ({
    questionId,
    engine,
    callIndex: 1,
    mentioned,
    brandRank,
    // 불린 답에는 긍정 문장 하나 — 감성 계수 1(서버와 같은 규칙, 점수 풀이는 이 문장에서 감성을 센다).
    mentionSentences: mentioned ? [{ text: '가상 문장', sentiment: 'positive' }] : [],
    competitorMentions: [],
    citations: [],
    factualityClaims: [],
  }) as unknown as QuestionRepeatAnalysis

/**
 * 판정 기록 — 이름 없는 질문 78건 중 rankedQs의 질문에 엔진 rankedEngines만 1위(언급) · extraMentions건은 순위 없이 언급,
 * 이름 넣은 질문 48건 중 namedHits건 언급.
 */
function records(opts: { ranked: { q: number; engine: string; rank: number }[]; extraMentions?: number; namedHits: number }): QuestionRepeatAnalysis[] {
  const out: QuestionRepeatAnalysis[] = []
  let extra = opts.extraMentions ?? 0
  for (let i = 0; i < 26; i++) {
    for (const e of ENGINES) {
      const r = opts.ranked.find((x) => x.q === i && x.engine === e)
      if (r) out.push(analysis(`g-${i}`, e, true, r.rank))
      else if (extra > 0) {
        out.push(analysis(`g-${i}`, e, true, null))
        extra -= 1
      } else out.push(analysis(`g-${i}`, e, false))
    }
  }
  let hits = opts.namedHits
  for (let i = 0; i < 16; i++) for (const e of ENGINES) out.push(analysis(`n-${i}`, e, hits-- > 0))
  return out
}

/** 카드 — 점수는 같은 식(aeoScoreOf, 감성 1)으로 낸다(서버 computeAeoScore와 같은 식 — verify-first-screen이 견준다). */
function cardOf(weekOf: string, a: QuestionRepeatAnalysis[], owned: number, extra: Partial<WeeklyScorecard> = {}): WeeklyScorecard {
  const unnamed = a.filter((x) => x.questionId.startsWith('g-'))
  const ranks = unnamed.filter((x) => x.mentioned && x.brandRank !== null).map((x) => x.brandRank as number)
  const mentionRate = unnamed.filter((x) => x.mentioned).length / unnamed.length
  const avg = ranks.length ? ranks.reduce((s, r) => s + r, 0) / ranks.length : null
  const current = aeoScoreOf({ mentionRate, sentiment: 1, brandOwnedCitationRate: owned, avgRecommendationRank: avg, rankedResponses: ranks.length })
  return {
    tenantId: 'v',
    brandName: '가상브랜드',
    weekOf,
    industry: '펜션',
    region: '가상시',
    aeoScore: { current, previousWeek: current, ma4: current, ciLow: Math.max(0, current - 5), ciHigh: current + 5 },
    mentionRate,
    shareOfMention: null,
    avgRecommendationRank: avg,
    rankedResponses: ranks.length,
    factualityScore: null,
    hallucinationFlags: [],
    brandOwnedCitationRate: owned,
    cohortRank: { position: 1, totalTenants: 1 },
    enginesUsed: ['openai', 'gemini', 'perplexity'],
    judgeEngine: 'claude',
    judgeModel: 'claude-sonnet-5-5',
    repeatsPerQuestion: 1,
    questionBankVersion: 'v9',
    ...extra,
  } as unknown as WeeklyScorecard
}

// 1) 스테이,머뭄 W44와 같은 꼴 — 같은 질문(g-14)에 두 엔진이 1위, 이름 넣은 질문 48건 중 43건, 자사 인용 2.43%.
const w44 = records({ ranked: [{ q: 14, engine: 'openai', rank: 1 }, { q: 14, engine: 'perplexity', rank: 1 }], namedHits: 43 })
const card44 = cardOf('2026-W44', w44, 27 / 1113)
const lines44 = explainScore({ card: card44, history: [card44], analyses: w44, bank })
const text = (key: string) => lines44.find((l) => l.key === key)?.text ?? ''
ok('W44 꼴: 점수 12점', card44.aeoScore.current === 12)
ok('구성: 순위 약 10 + 언급 약 1 + 자사 약 1', text('parts') === '12점 = 추천 순위 약 10점 + 언급률 약 1점 + 자사 출처 인용 약 1점.')
ok('비중: 2건이라 25% → 10%', text('weights').includes('이번 주는 2건이라 추천 순위 비중이 25% → 10%로'))
ok('몰림: 12점 중 약 11점 · 답 2건 · 질문 1개 원문', text('concentration').startsWith('12점 가운데 약 11점은 이름 없이 물은 질문의 답 2건(질문 1개 — 「가상 일반 질문 14」)'))
ok('몰림: 없었다면 1점', text('concentration').endsWith('이 2건이 없었다면 1점입니다.'))
ok('계단: 0건 1점 · 1건 7점 · 2건 12점(이번 주) · 3건 17점', text('steps').includes('0건 1점 · 1건 7점 · 2건 12점(이번 주) · 3건 17점'))
ok('순위의 뜻: 비교 그룹 이름 안 순위', text('rankScope').includes('비교 그룹 이름 가운데') && text('rankScope').includes('비교 그룹에 없는 업체는 순위에서 빠지므로'))
ok('이름을 댈 때: 48건 중 43건 · 78건 중 2건', text('named').includes('응답 48건 중 43건') && text('named').includes('78건 중 2건'))
ok('움직이는 것: 1위 답 1건 약 +5점 · 자사 인용률은 모든 질문 기준으로 따로', text('effects').includes('1건이 약 +5점') && text('effects').includes('자사 출처 인용률(모든 질문의 인용 기준)은 1%p에 약 +0.4점'))
ok('견주는 구간: 이력이 한 주뿐이면 없음', !lines44.some((l) => l.key === 'segment'))

// 2) 고객 종이 문구 — 내부 용어 · 질문 id · 판 번호가 나오지 않는다.
const paper = lines44.map((l) => `${l.label} ${l.text}`).join('\n')
ok('고객 문구: 내부 용어 없음(코호트 · 카테고리 · SoM · 감성 · 재정규화 · 질문지 판 · 질문 id)', !/코호트|카테고리|SoM|감성|재정규화|v9|g-\d/.test(paper))

// 3) 순위 문구 · 강점 · 기대효과 — 순위 답 6건 미만이면 「상위에 배치」라고 쓰지 않고 강점에서 뺀다. 기대효과는 이번 주 비중.
const report44 = buildPeriodicReport([card44], '2026-W44')!
const rankNote = report44.metrics.find((m) => m.key === 'avgRecommendationRank')!.note
ok('순위 진단(2건): 「상위에 배치」 대신 비교 그룹 이름 안 순위', !rankNote.includes('상위에 배치') && rankNote.startsWith('답에 나온 비교 그룹 이름 가운데 평균 1.0위입니다(순위가 매겨진 답 2건).'))
ok('순위 진단(2건): 상태 칩은 그대로(양호)', report44.metrics.find((m) => m.key === 'avgRecommendationRank')!.status === 'good')
ok('강점(2건): 순위를 내세우지 않는다', !report44.strengths.some((m) => m.key === 'avgRecommendationRank'))
ok('기대효과: 이번 주 비중(42% → 50%)', report44.recommendations.find((r) => r.id === 'mention')?.expected.startsWith('가중치 42% → 이번 주 50% 지표') === true)

// 4) 순위 답이 6건 이상이면 몰림 · 계단 줄이 없고 순위 문구 · 강점은 예전대로.
const many = records({ ranked: Array.from({ length: 7 }, (_, i) => ({ q: i, engine: 'openai', rank: 1 })), namedHits: 40 })
const cardMany = cardOf('2026-W44', many, 0.05)
const linesMany = explainScore({ card: cardMany, history: [cardMany], analyses: many, bank })
ok('순위 7건: 몰림 · 계단 · 비중 줄 없음', !linesMany.some((l) => ['concentration', 'steps', 'weights'].includes(l.key)))
const reportMany = buildPeriodicReport([cardMany], '2026-W44')!
ok('순위 7건: 순위 진단은 예전 문구', reportMany.metrics.find((m) => m.key === 'avgRecommendationRank')!.note === 'AI가 추천을 나열할 때 상위에 배치됩니다.')
ok('순위 7건: 강점에 순위', reportMany.strengths.some((m) => m.key === 'avgRecommendationRank'))

// 5) 판정 기록이 카드와 다른 측정이면(언급 수가 맞지 않음) 기록으로 센 줄을 쓰지 않는다 — 카드만으로 낼 수 있는 줄은 남는다.
const other = records({ ranked: [{ q: 3, engine: 'gemini', rank: 2 }], extraMentions: 4, namedHits: 10 })
const linesOther = explainScore({ card: card44, history: [card44], analyses: other, bank })
ok('기록이 카드와 다름: 몰림 · 계단 · 이름 · 움직이는 것 없음', !linesOther.some((l) => ['concentration', 'steps', 'named', 'effects'].includes(l.key)))
ok('기록이 카드와 다름: 구성 · 순위의 뜻은 남는다', linesOther.some((l) => l.key === 'parts') && linesOther.some((l) => l.key === 'rankScope'))
ok('기록이 없음: 구성만', explainScore({ card: card44, history: [card44], analyses: [], bank: null }).every((l) => ['parts', 'weights', 'rankScope'].includes(l.key)))

// 6) 견주는 구간 — 측정 조건이 바뀐 주 앞의 점수 범위와 바뀐 조건(종이 말). 바뀐 조건으로 처음 잰 주는 그렇다고 쓴다.
const before = [
  cardOf('2026-W40', w44, 0.03, { judgeEngine: 'gemini', judgeModel: 'gemini-3.7-flash', aeoScore: { current: 22, previousWeek: 22, ma4: 22, ciLow: 17, ciHigh: 27 } } as Partial<WeeklyScorecard>),
  cardOf('2026-W41', w44, 0.03, { judgeEngine: 'gemini', judgeModel: 'gemini-3.7-flash', aeoScore: { current: 1, previousWeek: 22, ma4: 1, ciLow: 0, ciHigh: 5 } } as Partial<WeeklyScorecard>),
]
const card43 = cardOf('2026-W43', w44, 27 / 1113)
const seg = explainScore({ card: card44, history: [...before, card43, card44], analyses: w44, bank }).find((l) => l.key === 'segment')?.text ?? ''
ok('견주는 구간: 시작 주 · 바뀐 조건 · 그 전 범위', seg.startsWith('2026년 43주차부터 측정 조건(판정 엔진 · 판정 모델 바뀜)이 달라져, 그 전 점수(2026년 40~41주차, 1~22점)와는 견주지 않습니다.'))
// 같은 조건 구간의 길이는 적지 않는다 — 「같은 조건으로 잰 최근 측정」 절(같은 주 여러 회차 포함)과 수가 달라 헷갈린다(2단계에서 바꿈).
ok('견주는 구간: 구간 길이를 적지 않는다', seg.endsWith('와는 견주지 않습니다.'))
const segFirst = explainScore({ card: card43, history: [...before, card43], analyses: w44, bank }).find((l) => l.key === 'segment')?.text ?? ''
ok('견주는 구간: 바뀐 조건으로 처음 잰 주', segFirst.endsWith('이번 주가 바뀐 조건으로 처음 잰 주입니다.'))

// ── 1단계 검토 반영 ─────────────────────────────────────────────
// 계단은 1위가 아닌 순위 답을 그대로 두고 1위 답 수만 바꾼다 — 이번 주 칸이 이번 주 점수(실측 골목집 W38 [4,3] 17점이 「0건 11점」).
for (const ranks of [[3], [4, 3], [1, 4, 1], [3, 3, 1, 1]]) {
  const a = records({ ranked: ranks.map((rank, i) => ({ q: i, engine: 'perplexity', rank })), namedHits: 20 })
  const c = cardOf('2026-W44', a, 0.02)
  const steps = explainScore({ card: c, history: [c], analyses: a, bank }).find((l) => l.key === 'steps')?.text ?? ''
  const first = ranks.filter((r) => r === 1).length
  ok(`계단 [${ranks.join(',')}]: 이번 주 칸(${first}건) = 점수 ${c.aeoScore.current}`, steps.includes(`${first}건 ${c.aeoScore.current}점(이번 주)`))
}
// 구성 — 항목 몫의 합이 점수와 같다(실측 web4ai W40 「8점 = 5 + 1 + 1」).
for (const owned of [0.0326, 0.05, 0.13]) {
  const a = records({ ranked: [{ q: 15, engine: 'openai', rank: 1 }], extraMentions: 1, namedHits: 30 })
  const c = cardOf('2026-W40', a, owned)
  const parts = explainScore({ card: c, history: [c], analyses: a, bank }).find((l) => l.key === 'parts')?.text ?? ''
  const nums = [...parts.matchAll(/약 (\d+)점/g)].map((m) => Number(m[1]))
  ok(`구성 합 = 점수(자사 ${owned})`, nums.reduce((s, x) => s + x, 0) === c.aeoScore.current)
}
// 감성 계수는 판정 기록의 언급 문장에서 센다 — 카드 점수에서 거꾸로 풀면 언급 한두 건인 주에 0.7~0.8로 틀어진다.
const one = records({ ranked: [], extraMentions: 2, namedHits: 10 })
// 점수 2.31 → 2로 내려 반올림되는 주 — 거꾸로 풀면 감성 0.78, 문장으로 세면 1.
const cardOne = cardOf('2026-W41', one, 0.02)
const effOne = explainScore({ card: cardOne, history: [cardOne], analyses: one, bank }).find((l) => l.key === 'effects')?.text ?? ''
ok('감성: 문장이 모두 긍정이면 순위 없는 언급 1건 약 +0.7점(거꾸로 푼 감성이면 +0.6)', effOne.includes('순위 없이 불리는 답 1건이 약 +0.7점'))
// 견주는 구간 — 한쪽에 기록이 없을 뿐이면 「달라져」라고 쓰지 않는다(표지 · 비교 불가 안내와 같은 규칙).
const noModel = [cardOf('2026-W38', w44, 0.03, { judgeModel: undefined, modelsUsed: undefined } as Partial<WeeklyScorecard>), card43, card44]
const segUnknown = explainScore({ card: card44, history: noModel, analyses: w44, bank }).find((l) => l.key === 'segment')?.text ?? ''
ok('견주는 구간(기록 없음뿐): 「달라져」 대신 「기록이 한쪽에 없어」', segUnknown.includes('견줄 측정 조건 기록이 한쪽에 없어(') && !segUnknown.includes('달라져'))
// 옛 카드(순위 응답 수 없음) · 지금 식으로 점수가 나오지 않는 카드 — 기록으로 센 줄 · 구성 줄을 쓰지 않는다.
const oldCard = { ...card44, rankedResponses: undefined } as unknown as WeeklyScorecard
ok('옛 카드: 몰림 · 계단 · 움직이는 것 없음', !explainScore({ card: oldCard, history: [oldCard], analyses: w44, bank }).some((l) => ['concentration', 'steps', 'effects', 'named'].includes(l.key)))
const oddCard = { ...card44, aeoScore: { ...card44.aeoScore, current: 27 } } as WeeklyScorecard
ok('식이 맞지 않는 카드: 구성 · 비중 · 기록 줄 없음', !explainScore({ card: oddCard, history: [oddCard], analyses: w44, bank }).some((l) => ['parts', 'weights', 'concentration', 'steps', 'effects'].includes(l.key)))
// 순위 개선제안 근거 · 순위 진단 비중 — 답이 적으면 단정하지 않고, 비중은 꼬리표와 같은 「25% → 10%」.
const lowRank = records({ ranked: [{ q: 0, engine: 'openai', rank: 4 }, { q: 1, engine: 'openai', rank: 3 }], namedHits: 20 })
const cardLow = cardOf('2026-W44', lowRank, 0.02)
const reportLow = buildPeriodicReport([cardLow], '2026-W44')!
ok('순위 개선제안(2건): 「하위에 배치」라고 단정하지 않는다', reportLow.recommendations.find((r) => r.id === 'rank')?.basis.includes('답이 적어 순위 위치를 단정하지 않습니다') === true)
ok('순위 진단(2건): 비중은 「25% → 10%」로(「2/6」 아님)', rankNote.includes('추천 순위 비중이 25% → 10%입니다') && !rankNote.includes('2/6'))

// ── 2단계: 같은 조건 회차 · 다른 회차 표시 · 출처 ─────────────────────────────
// 회차 기록(server/runHistory.ts 모양) — W42 옛 그 주 파일 · W43 옮겨 둔 회차 · W43 회차 · W44 함께 잰 회차 · W44 이 브랜드만 잰 회차(그 주 카드).
const point = (weekOf: string, at: string | null, score: number, k: number, extra: Partial<RunPoint> = {}): RunPoint =>
  ({
    kind: 'run',
    runId: at,
    weekOf,
    at,
    window: null,
    selfOnly: false,
    inCohortRun: false,
    weekCard: 'saved',
    isWeekCard: false,
    engines: null,
    enginesUsed: ['gemini', 'openai', 'perplexity'],
    partialEngines: [],
    missingEngines: [],
    engineIssues: [],
    conditionKey: 'same',
    changesFromPrev: [],
    bankVersion: 'v9',
    ranked: { k, n: 78, mentioned: k, ci: null },
    score,
    scoreAtMeasure: score,
    agnosticQuestions: 26,
    repeatsPerQuestion: 1,
    ...extra,
  }) as RunPoint
const runs: RunHistory = {
  points: [
    point('2026-W42', '2026-10-14T05:39:22.356Z', 1, 0, { kind: 'week-file', runId: null, selfOnly: null, inCohortRun: null, weekCard: 'week-file', isWeekCard: true, changesFromPrev: ['판정 엔진'] }),
    point('2026-W43', '2026-10-22T07:28:47.359Z', 6, 1, { preserved: true }),
    point('2026-W43', '2026-10-22T13:50:45.778Z', 12, 2, { isWeekCard: true }),
    point('2026-W44', '2026-10-26T04:45:46.662Z', 1, 0),
    point('2026-W44', '2026-10-26T04:51:56.913Z', 12, 2, { selfOnly: true, isWeekCard: true }),
  ],
  posts: [],
  weekCardScores: {},
  issues: [],
}
const recent = recentRuns(runs, '2026-W44')
ok('최근 회차: 옛 기록(그 주 파일 · 옮겨 둔 회차)은 회차 보기처럼 뺀다 — 12 · 1 · 12', JSON.stringify(recent?.runs.map((p) => p.score)) === '[12,1,12]')
ok('최근 회차: 평균 8.3 · 범위 1~12', recent?.average === 8.3 && recent.min === 1 && recent.max === 12)
ok('최근 회차: 지난 주 보고서는 그 주까지만', JSON.stringify(recentRuns(runs, '2026-W43')?.runs.map((p) => p.score) ?? null) === 'null')
ok('최근 회차: 기록이 없으면(웹) null', recentRuns(null, '2026-W44') === null)
// 조건은 평균에 넣을 수 있는 회차끼리 conditionKey로 견준다(덮지 않은 회차가 사이에 끼면 서버의 changesFromPrev는 그 회차와 견준 값이다).
const brokenRuns: RunHistory = { ...runs, points: runs.points.map((p, i) => (i === 3 ? { ...p, conditionKey: 'other' } : p)) }
ok('최근 회차: 조건이 바뀐 회차에서 끊는다(1번뿐이면 null)', recentRuns(brokenRuns, '2026-W44') === null)
ok('회차 이름: 한국 시각 · 옛 기록은 주차', runLabel(runs.points[4]!) === '10/26 13:51' && runLabel({ ...runs.points[0]!, at: null }) === '2026년 42주차')

// 표지 평균 — 회차 평균이 있으면 그것 하나만(주 카드 평균과 둘이 나오지 않게).
const hist3 = [cardOf('2026-W42', w44, 0.02, { aeoScore: { current: 1, previousWeek: 1, ma4: 1, ciLow: 0, ciHigh: 5 } } as Partial<WeeklyScorecard>), card43, card44]
const withRuns = buildPeriodicReport(hist3, '2026-W44', undefined, { average: 8.3, count: 3 })!
ok('표지: 같은 조건 최근 3번 측정 평균 8.3', withRuns.verdict.summary.includes('같은 조건 최근 3번 측정 평균 8.3') && !withRuns.verdict.summary.includes('연속 3주'))
const noRuns = buildPeriodicReport(hist3, '2026-W44')!
ok('표지: 회차 기록이 없으면 주 평균 그대로', noRuns.verdict.summary.includes('같은 조건 연속 3주 평균'))

// 다른 회차 표시 — 그 주 카드가 이 브랜드만 다시 잰 회차면 함께 잰 회차 점수와 함께.
const note = separateRunNote(runs, card44) ?? ''
ok('다른 회차 표시: 이 브랜드만 다시 잰 값 · 함께 잰 회차 1점', note === '가상브랜드의 2026년 44주차 점수 12점은 비교 그룹을 잰 회차와 다른 시각(10/26 13:51)에 이 브랜드만 다시 잰 값입니다. 같은 주 같은 조건으로 먼저 잰 회차(10/26 13:45)에서는 1점이었습니다.')
ok('다른 회차 표시: 함께 잰 회차가 카드면 없음', separateRunNote({ ...runs, points: runs.points.slice(0, 4).map((p, i) => (i === 3 ? { ...p, isWeekCard: true } : p)) }, card44) === null)
ok('다른 회차 표시: 옮겨 둔 회차는 묻지 않는다', separateRunNote({ ...runs, points: [{ ...runs.points[4]!, preserved: true }] }, card44) === null)

// 출처 — 이름 없이 물은 질문 기준 상위(URL 줄을 도메인으로), 플랫폼 이름, 등록 주소별 인용(0건 포함).
const src = {
  urls: [
    { raw: 'https://www.yeogi.com/a', domain: 'yeogi.com', citationCount: 3, engines: ['gemini'] },
    { raw: 'https://www.yeogi.com/b', domain: 'yeogi.com', citationCount: 2, engines: ['perplexity'] },
    { raw: 'https://blog.naver.com/x', domain: 'blog.naver.com', citationCount: 4, engines: ['perplexity'] },
  ],
} as unknown as CitationSourceAnalysis
const tops = topSourceDomains(src)
ok('출처 상위: 도메인으로 묶고 엔진을 모은다', JSON.stringify(tops) === JSON.stringify([{ domain: 'yeogi.com', count: 5, engines: ['gemini', 'perplexity'], hosts: 1 }, { domain: 'blog.naver.com', count: 4, engines: ['perplexity'], hosts: 1 }]))
ok('플랫폼 이름: 하위 주소도 · 모르는 주소는 null', hostName('m.blog.naver.com') === '네이버 블로그' && hostName('nol.yanolja.com') === '놀(야놀자)' && hostName('kr.trip.com') === '트립닷컴' && hostName('gunsan.go.kr') === null)
const cite = (domain: string) => ({ raw: `https://${domain}/s/x`, domain, ownerType: 'brand-owned', supportsBrandMention: false })
const withCites = [
  { ...analysis('n-0', 'openai', true), citations: [cite('old.example'), cite('old.example')] },
  { ...analysis('g-0', 'openai', true), citations: [cite('www.old.example'), cite('other.example')] },
] as unknown as QuestionRepeatAnalysis[]
ok(
  '등록 주소별 인용: 이름 넣은 · 이름 없는 질문으로 나누고 0건 주소도',
  JSON.stringify(ownedDomainCitations(withCites, bank, ['old.example', 'new.example'])) ===
    JSON.stringify([{ domain: 'old.example', named: 2, unnamed: 1, total: 3 }, { domain: 'new.example', named: 0, unnamed: 0, total: 0 }]),
)

// ── 2단계 검토 반영 ─────────────────────────────────────────────
const whole = runs.points.slice(2) // W43 회차 · W44 함께 잰 회차 · W44 이 브랜드만(카드)
// 그 주 카드 회차가 엔진이 빠졌으면 회차 평균을 쓰지 않는다(표지 점수가 평균에 없고 다른 조건 평균을 「같은 조건」으로 적었다).
ok('카드 회차 엔진 빠짐: null', recentRuns({ ...runs, points: runs.points.map((p, i) => (i === 4 ? { ...p, missingEngines: ['gemini'] } : p)) }, '2026-W44') === null)
ok('카드 회차 일부만: null', recentRuns({ ...runs, points: runs.points.map((p, i) => (i === 4 ? { ...p, partialEngines: ['perplexity'] } : p)) }, '2026-W44') === null)
// 덮지 않은 회차 · 엔진 빠진 회차가 사이에 끼어도 앞 같은 조건 회차를 버리지 않는다 — 평균에서만 뺀다.
const kept = point('2026-W44', '2026-10-26T05:10:00.000Z', 3, 0, { selfOnly: true, weekCard: 'kept', missingEngines: ['gemini'] })
const w45 = (at: string, score: number, card = false) => point('2026-W45', at, score, score > 1 ? 2 : 0, { isWeekCard: card })
const withKept: RunHistory = { ...runs, points: [...runs.points, kept, w45('2026-11-02T04:00:00.000Z', 6), w45('2026-11-02T05:00:00.000Z', 12, true)] }
ok('덮지 않은 회차가 껴도 W43–W45를 잇는다(12 · 1 · 12 · 6 · 12)', JSON.stringify(recentRuns(withKept, '2026-W45')?.runs.map((p) => p.score)) === '[12,1,12,6,12]')
// 회차 기록 창 맨 앞까지 가서도 4주를 못 채우면 창 밖에 같은 조건 회차가 더 있을 수 있다 — null(주 카드 평균으로).
ok('창 맨 앞까지 가고 4주 미만: null', recentRuns({ ...runs, points: whole }, '2026-W44') === null)
// 그 주 파일을 다시 판정 · 다시 셈해 카드 점수가 회차 점수와 달라졌으면 회차 평균을 쓰지 않는다.
ok('카드 점수 ≠ 회차 점수: null', recentRuns({ ...runs, weekCardScores: { '2026-W44': 7 } }, '2026-W44') === null)
// 먼저 잰 회차가 다른 조건이면 점수를 나란히 놓지 않는다(첫 문장만).
const noteOther = separateRunNote({ ...runs, points: runs.points.map((p, i) => (i === 3 ? { ...p, conditionKey: 'other' } : p)) }, card44) ?? ''
ok('다른 회차 표시: 먼저 잰 회차가 다른 조건이면 점수 문장 없음', noteOther.endsWith('이 브랜드만 다시 잰 값입니다.'))
// 등록 주소 — www만 다른 주소는 하나, 인용은 가장 구체적인 주소 하나에만.
const sub = [
  { ...analysis('n-0', 'openai', true), citations: [cite('www.banobagi.com'), cite('eng.banobagi.com'), cite('banobagi.com')] },
  { ...analysis('g-1', 'openai', true), citations: [cite('eng.banobagi.com')] },
] as unknown as QuestionRepeatAnalysis[]
ok(
  '등록 주소: www 합치고 가장 구체적인 주소에만(겹쳐 세지 않음)',
  JSON.stringify(ownedDomainCitations(sub, bank, ['www.banobagi.com', 'banobagi.com', 'eng.banobagi.com'])) ===
    JSON.stringify([{ domain: 'www.banobagi.com', named: 2, unnamed: 0, total: 2 }, { domain: 'eng.banobagi.com', named: 1, unnamed: 1, total: 2 }]),
)
// 「이름 없이 물은 질문」은 위 출처 표와 같은 기준(브랜드 이름이 없는 질문) — 업종 · 지역 일반 질문이 아니어도 이름이 없으면 그쪽.
const bankLocal = { ...bank, questions: [...bank.questions, { questionId: 'l-0', text: '가상 지역 질문', category: 'local-regional', containsBrandName: false }] } as unknown as QuestionBank
const local = [{ ...analysis('l-0', 'gemini', false), citations: [cite('old.example')] }] as unknown as QuestionRepeatAnalysis[]
ok('등록 주소: 이름 없는 지역 질문도 「이름 없이 물은 질문」으로', JSON.stringify(ownedDomainCitations(local, bankLocal, ['old.example'])) === JSON.stringify([{ domain: 'old.example', named: 0, unnamed: 1, total: 1 }]))
// 플랫폼 이름 — google.com은 그 주소만(하위 주소는 남이 올린 문서 · 리디렉트), 티스토리는 블로그들을 한 줄로.
ok('플랫폼 이름: 구글 하위 주소는 이름 없음 · 구글 플레이', hostName('google.com') === '구글' && hostName('vertexaisearch.cloud.google.com') === null && hostName('docs.google.com') === null && hostName('play.google.com') === '구글 플레이')
const tis = topSourceDomains({
  urls: [
    { raw: 'https://a.tistory.com/1', domain: 'a.tistory.com', citationCount: 3, engines: ['gemini'] },
    { raw: 'https://b.tistory.com/2', domain: 'b.tistory.com', citationCount: 4, engines: ['openai'] },
    { raw: 'https://blog.naver.com/x', domain: 'blog.naver.com', citationCount: 5, engines: ['perplexity'] },
  ],
} as unknown as CitationSourceAnalysis)
ok('출처 상위: 티스토리 블로그들을 한 줄로(블로그 2곳)', JSON.stringify(tis[0]) === JSON.stringify({ domain: 'tistory.com', count: 7, engines: ['gemini', 'openai'], hosts: 2 }))

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
