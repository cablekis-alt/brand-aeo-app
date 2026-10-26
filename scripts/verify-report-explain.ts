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
import { explainScore } from '../src/lib/reportExplain'
import type { QuestionBank, QuestionRepeatAnalysis } from '../src/lib/types'
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
  ({ questionId, engine, callIndex: 1, mentioned, brandRank, mentionSentences: [], competitorMentions: [], citations: [], factualityClaims: [] }) as unknown as QuestionRepeatAnalysis

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
ok('계단: 0건 1점 · 1건 7점 · 2건 12점 · 3건 17점', text('steps').includes('0건 1점 · 1건 7점 · 2건 12점 · 3건 17점'))
ok('순위의 뜻: 비교 그룹 이름 안 순위', text('rankScope').includes('비교 그룹 이름 가운데') && text('rankScope').includes('비교 그룹에 없는 업체는 순위에서 빠지므로'))
ok('이름을 댈 때: 48건 중 43건 · 78건 중 2건', text('named').includes('응답 48건 중 43건') && text('named').includes('78건 중 2건'))
ok('움직이는 것: 1위 답 1건 약 +5점 · 자사 1%p 약 +0.4점', text('effects').includes('1건이 약 +5점') && text('effects').includes('1%p가 약 +0.4점'))
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
ok('견주는 구간: 같은 조건 연속 2주', seg.endsWith('같은 조건으로 잰 연속 2주만 이어서 봅니다.'))
const segFirst = explainScore({ card: card43, history: [...before, card43], analyses: w44, bank }).find((l) => l.key === 'segment')?.text ?? ''
ok('견주는 구간: 바뀐 조건으로 처음 잰 주', segFirst.endsWith('이번 주가 바뀐 조건으로 처음 잰 주입니다.'))

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
