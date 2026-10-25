/**
 * 정기진단 보고서(src/lib/b9-report.ts buildPeriodicReport)의 고객용 문장을 확인한다.
 *
 * 왜(2026-10-25 정기진단 보고서 · 검토 리포트 통합 검토):
 *   - 첫 측정 주차에도 요약이 「전주와 보합」이라고 썼다 — 비교할 전주가 없는 것과 보합은 다르다.
 *   - 사실성 「틀림」 기록은 응답마다 한 줄(「openai / v3-q12 #2: 사실성 불일치 2건」)이라 개수는 응답 수인데 「주장 N건」으로 불렀고,
 *     그 내부 문자열(엔진 id · 질문 id · 회차)이 개선제안 근거에 그대로 실려 고객 PDF에 찍혔다.
 *
 *   npx tsx scripts/verify-periodic-report.ts
 */
import { buildPeriodicReport } from '../src/lib/b9-report'
import { measureConditionPlain } from '../src/lib/format'
import { buildRecommendationEvidence } from '../src/lib/recommendationEvidence'
import { citationTop, cohortRows, selfReview, trustChecks } from '../src/lib/reviewReport'
import type { CitationBreakdownRow, QuestionBank, QuestionRepeatAnalysis } from '../src/lib/types'
import type { WeeklyScorecard } from '../src/prompts/b8-report'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

const card = (weekOf: string, current: number, previousWeek: number, extra: Partial<WeeklyScorecard> = {}) =>
  ({
    weekOf,
    brandName: '가상브랜드',
    tenantId: 'v',
    aeoScore: { current, previousWeek, ma4: current, ciLow: Math.max(0, current - 3), ciHigh: current + 3 },
    mentionRate: 0.1,
    shareOfMention: null,
    avgRecommendationRank: null,
    rankedResponses: 0,
    factualityScore: 1,
    hallucinationFlags: [],
    brandOwnedCitationRate: 0.1,
    ...extra,
  }) as unknown as WeeklyScorecard

// 1) 비교할 전주가 없으면 「보합」이라고 하지 않는다
const first = buildPeriodicReport([card('2026-W40', 8, 8)], '2026-W40')!
ok('첫 주차: 「전주와 보합」이라고 하지 않는다', !first.verdict.summary.includes('보합'))
ok('첫 주차: 전주 기록이 없다고 밝힌다', first.verdict.summary.includes('전주 기록 없음'))
const second = buildPeriodicReport([card('2026-W40', 7, 7), card('2026-W41', 8, 7)], '2026-W41')!
ok('둘째 주차: 전주 대비 증감은 그대로', second.verdict.summary.includes('전주 대비 +1'))
const flat = buildPeriodicReport([card('2026-W40', 8, 8), card('2026-W41', 8, 8)], '2026-W41')!
ok('둘째 주차: 같으면 보합', flat.verdict.summary.includes('전주와 보합'))
// 화면 이력은 최근 12주뿐 — 가장 오래 불러온 주차의 앞 측정은 저장된 previousWeek로만 안다. 그 측정과 견줄 수 있는지(측정 조건)는
// 모르므로 증감을 쓰지 않고 「확인 불가」(2026-10-25 「같은 조건」 통일 — 승인받은 기대값 변경: 예전엔 「전주 대비 +1」)
const windowEdge = buildPeriodicReport([card('2026-W41', 9, 8), card('2026-W42', 9, 9)], '2026-W41')!
ok('불러온 이력의 첫 주차: 앞 측정이 이력 밖이면 확인 불가(증감 없음)', windowEdge.verdict.summary.includes('확인 불가') && !windowEdge.verdict.summary.includes('+1'))

// 측정 조건이 바뀐 주 — 표지 · 지표별 진단이 증감을 쓰지 않는다(실측 경쟁사 W41→W42 판정 Gemini → Claude에서 「전주 대비 +9」)
const judgeSwitch = buildPeriodicReport(
  [
    card('2026-W41', 30, 30, { judgeEngine: 'gemini', judgeModel: 'gemini-3.7-flash', mentionRate: 0.1 } as Partial<WeeklyScorecard>),
    card('2026-W42', 39, 30, { judgeEngine: 'claude', judgeModel: 'claude-sonnet-5-5', mentionRate: 0.2 } as Partial<WeeklyScorecard>),
  ],
  '2026-W42',
)!
ok('판정이 바뀐 주: 표지에 「전주 대비」 없음', !judgeSwitch.verdict.summary.includes('전주 대비'))
ok('판정이 바뀐 주: 직전 측정 점수를 부호 없이 나란히 · 무엇이 달랐는지', judgeSwitch.verdict.summary.includes('직전 측정(2026년 41주차) 30점') && judgeSwitch.verdict.summary.includes('판정 엔진'))
ok('판정이 바뀐 주: 지표별 진단 증감 없음', judgeSwitch.metrics.every((m) => !m.delta))
ok('판정이 바뀐 주: 판정 결과를 함께 돌려준다', judgeSwitch.comparison.comparable === false && judgeSwitch.comparison.previousWeekOf === '2026-W41')

// 같은 조건 평균 · 떨어진 주
const run3 = buildPeriodicReport([card('2026-W40', 10, 10), card('2026-W41', 12, 10), card('2026-W43', 14, 12)], '2026-W43')!
ok('같은 조건 평균(4주 이동평균 대신) — 사이에 빈 주가 있으면 「3번」', run3.verdict.summary.includes('같은 조건 3번 평균 12') && !run3.verdict.summary.includes('이동평균'))
const run2c = buildPeriodicReport([card('2026-W40', 10, 10), card('2026-W41', 14, 10)], '2026-W41')!
ok('이어진 주면 「같은 조건 연속 2주 평균」', run2c.verdict.summary.includes('같은 조건 연속 2주 평균 12'))
ok('2주 떨어진 앞 측정은 「직전 측정(Wxx) 대비」', run3.verdict.summary.includes('직전 측정(2026년 41주차) 대비 +2'))
ok('같은 조건 1주뿐이면 평균을 쓰지 않는다', !judgeSwitch.verdict.summary.includes('평균'))

// 2) 사실성 「틀림」 — 응답 단위로 부르고, 내부 문자열을 고객 문장에 싣지 않는다
const flags = ['openai / v3-q12 #2: 사실성 불일치 2건', 'gemini / v3-q07 #1: 사실성 불일치 1건']
const wrong = buildPeriodicReport([card('2026-W41', 8, 8, { factualityScore: 0.5, hallucinationFlags: flags })], '2026-W41')!
const fact = wrong.metrics.find((m) => m.key === 'factualityScore')!
ok('사실성 진단: 응답 단위(「응답이 2건」)', fact.note.includes('응답') && fact.note.includes('2건'))
const factRec = wrong.recommendations.find((r) => r.id === 'fact')!
ok('사실성 개선제안 근거: 응답 2건', factRec.basis.includes('응답') && factRec.basis.includes('2건'))
ok('사실성 개선제안 근거: 엔진 id · 질문 id를 싣지 않는다', !/openai|gemini|v3-q\d+|#\d/.test(factRec.basis))

// 3) 같은 주 코호트 비교 — 저장된 순위 목록으로 줄 · 순위를 내고, 기록을 못 읽은 브랜드도 남긴다(2026-10-25 통합)
const bankOf = (texts: string[]) =>
  ({ questions: texts.map((t, i) => ({ questionId: `q${i}`, text: t, category: 'category-agnostic' })) }) as unknown as QuestionBank
const self = card('2026-W40', 8, 8, {
  tenantId: 'me',
  brandName: '나',
  cohortRank: {
    position: 2,
    totalTenants: 4,
    members: [
      { tenantId: 'me', aeoScore: 8 },
      { tenantId: 'a', aeoScore: 19 },
      { tenantId: 'b', aeoScore: 8 },
      { tenantId: 'c', aeoScore: 4 },
    ],
  },
} as Partial<WeeklyScorecard>)
const memberA = card('2026-W40', 19, 19, { tenantId: 'a', brandName: '가', mentionRate: 0.09 } as Partial<WeeklyScorecard>)
const memberC = card('2026-W40', 4, 4, { tenantId: 'c', brandName: '다' } as Partial<WeeklyScorecard>)
const rows = cohortRows(self, [memberA, memberC], { me: bankOf(['질문1', '질문2']), a: bankOf(['질문1', '질문2']), c: bankOf(['질문9']) })
const rowOf = (id: string) => rows.find((r) => r.tenantId === id)!
ok('코호트: 저장된 목록 4곳이 모두 줄로(못 읽은 b 포함)', rows.length === 4 && rowOf('b').loaded === false)
ok('코호트: 순위는 저장 점수로 — 나 공동 2, 가 1, 다 4', rowOf('me').position === 2 && rowOf('me').tied && rowOf('a').position === 1 && rowOf('c').position === 4)
ok('코호트: 못 읽은 브랜드는 값 칸이 null(0으로 채우지 않음)', rowOf('b').mentionRate === null && rowOf('b').ownedRate === null && rowOf('b').sameQuestions === null)
ok('코호트: 질문지 같음 · 다름', rowOf('a').sameQuestions === true && rowOf('c').sameQuestions === false)
ok('코호트: 읽은 브랜드 값', rowOf('a').mentionRate === 0.09)

// 4) 측정 횟수 점검은 보고 주차까지만 센다 — 그 뒤에 잰 주차를 근거로 쓰지 않는다
const later = card('2026-W41', 9, 8, { tenantId: 'me' } as Partial<WeeklyScorecard>)
const runs = trustChecks(self, [self, later], [memberA, memberC], rows, null).find((c) => c.id === 'runs')!
// 문구는 2026-10-25 「같은 조건」 통일로 「같은 조건으로 연속 N주」로 바뀜 — 판정(주의)은 그대로
ok('측정 횟수: 보고 주차 뒤 주차는 세지 않는다(이번 주뿐 → 주의)', runs.status === 'warn' && runs.detail.includes('아직 이번 주'))
// 판정이 바뀐 주는 같은 조건 연속 구간을 끊는다(예전엔 질문지 · 수집 엔진만 봐서 「같은 조건 3주」로 셌다)
const judgeRunHist = [
  card('2026-W40', 8, 8, { tenantId: 'me', judgeEngine: 'gemini' } as Partial<WeeklyScorecard>),
  card('2026-W41', 8, 8, { tenantId: 'me', judgeEngine: 'gemini' } as Partial<WeeklyScorecard>),
  card('2026-W42', 8, 8, { tenantId: 'me', judgeEngine: 'claude' } as Partial<WeeklyScorecard>),
]
const judgeRun = trustChecks(judgeRunHist[2]!, judgeRunHist, [], [], null).find((c) => c.id === 'runs')!
ok('측정 횟수: 판정이 바뀐 주는 구간을 새로 센다', judgeRun.status === 'warn' && judgeRun.detail.includes('직전 측정과 조건이 달랐습니다'))
const sameRun = trustChecks(judgeRunHist[1]!, judgeRunHist, [], [], null).find((c) => c.id === 'runs')!
ok('측정 횟수: 같은 조건 연속 2주', sameRun.status === 'ok' && sameRun.detail.includes('연속 2주'))
// 코호트 같은 측정 조건 — 질문지 버전 번호는 브랜드마다 달라 보지 않고, 판정 차이는 브랜드 이름과 함께
const memberJudge = card('2026-W42', 8, 8, { tenantId: 'x', brandName: '엑스', judgeEngine: 'gemini', questionBankVersion: 'v9' } as Partial<WeeklyScorecard>)
const condCheck = trustChecks(judgeRunHist[2]!, judgeRunHist, [memberJudge], [
  { tenantId: 'me', isSelf: true, loaded: true } as never,
  { tenantId: 'x', isSelf: false, loaded: true, brandName: '엑스', sameQuestions: true } as never,
], null).find((c) => c.id === 'conditions')!
ok('코호트 조건: 판정 엔진 차이를 브랜드와 함께 · 질문지 버전은 보지 않음', condCheck.status === 'warn' && condCheck.detail.includes('판정 엔진(엑스)') && !condCheck.detail.includes('질문지'))
const qCheck = trustChecks(self, [self], [memberA, memberC], rows, null).find((c) => c.id === 'questions')!
ok('같은 질문지: 다른 질문을 받은 브랜드(다)를 밝힌다', qCheck.status === 'warn' && qCheck.detail.startsWith('다은(는) 일반 질문이 다릅니다'))

// 5) 이 브랜드 응답 요약 — 은행을 못 읽으면 null(「불린 적 없음」으로 쓰지 않는다)
const analyses = [
  { questionId: 'q0', engine: 'openai', mentioned: true, clarifying: false, factualityClaims: [] },
  { questionId: 'q1', engine: 'gemini', mentioned: false, clarifying: true, factualityClaims: [{ verdict: 'contradicted', claimText: '주소', responseValue: '가상로 9', factGraphValue: '가상로 1' }] },
] as unknown as QuestionRepeatAnalysis[]
ok('응답 요약: 은행이 없으면 null', selfReview(analyses, null) === null)
// 판정 기록이 없거나(빈 배열) 예시 기록이라 은행 질문과 하나도 맞지 않으면 null — 「0건 중 0건」을 쓰지 않는다(재검토에서 확인)
ok('응답 요약: 판정 기록이 없으면 null', selfReview([], bankOf(['질문1', '질문2'])) === null)
const demoAnalyses = [{ questionId: 'q-demo-1', engine: 'openai', mentioned: true, clarifying: false, factualityClaims: [] }] as unknown as QuestionRepeatAnalysis[]
ok('응답 요약: 기록이 은행과 하나도 맞지 않으면 null', selfReview(demoAnalyses, bankOf(['질문1', '질문2'])) === null)
const sr = selfReview(analyses, bankOf(['질문1', '질문2']))!
ok('응답 요약: 일반 질문 2개 · 응답 2 · 불림 1 · 되물음 1', sr.general.questions === 2 && sr.general.responses === 2 && sr.general.mentioned === 1 && sr.general.clarifying === 1)
ok('응답 요약: 불린 질문과 엔진', sr.mentionedQuestions.length === 1 && sr.mentionedQuestions[0]!.text === '질문1')
ok('응답 요약: 「틀림」 원문(질문 · AI 값 · 등록 값)', sr.contradicted.length === 1 && sr.contradicted[0]!.said === '가상로 9' && sr.contradicted[0]!.registered === '가상로 1')

// 6) 상위 출처 — 상위 6개 밖의 자사 출처도 넣는다
const crow = (domain: string, n: number, ownerType = 'third-party-ugc') => ({ domain, ownerType, citationCount: n, supportingBrandMentionCount: 0 }) as CitationBreakdownRow
const top = citationTop([...Array.from({ length: 7 }, (_, i) => crow(`d${i}.example`, 10 - i)), crow('me.example', 1, 'brand-owned')])
ok('출처: 상위 6개 + 자사 1개', top.top.length === 7 && top.top.at(-1)!.domain === 'me.example' && top.top.at(-1)!.isOwned)
ok('출처: 합계 · 자사 건수', top.total === 10 + 9 + 8 + 7 + 6 + 5 + 4 + 1 && top.owned === 1)
ok('출처 성격: 업계 약어(UGC) 대신 「이용자 글」', top.top[0]!.owner === '이용자 글')

// 7) 고객 종이 문구(상용화 UI 3차 U5, 2026-10-26) — 내부 용어 · 의료 업종 말 · 해라체가 고객 PDF에 찍혔다(펜션 · KT 보고서에 「원장 · 시술」).
//    모든 지표가 약하면 개선제안이 모두 나온다 — 그 문장 전체를 본다.
const weakAll = buildPeriodicReport(
  [
    card('2026-W41', 5, 5, {
      mentionRate: 0.02,
      shareOfMention: 0.05,
      avgRecommendationRank: 4.5,
      rankedResponses: 6,
      factualityScore: 0.5,
      hallucinationFlags: flags,
      brandOwnedCitationRate: 0.01,
    } as Partial<WeeklyScorecard>),
  ],
  '2026-W41',
  {
    overall: 0.1,
    experience: { score: 0, evidence: [] },
    expertise: { score: 0, evidence: [] },
    authoritativeness: { score: 0, evidence: [] },
    trustworthiness: { score: 0, evidence: [] },
    mentionedCallCount: 1,
    totalCallCount: 10,
  },
)!
const paperText = [
  ...weakAll.metrics.flatMap((m) => [m.label, m.note]),
  ...weakAll.recommendations.flatMap((r) => [r.title, r.basis, r.expected, ...r.actions]),
].join('\n')
ok('고객 문구: 개선제안이 여섯 지표 모두 나온다', ['mention', 'som', 'rank', 'fact', 'citation', 'eeat'].every((id) => weakAll.recommendations.some((r) => r.id === id)))
ok('고객 문구: 내부 용어 없음(Fact Graph · 팩트 그래프 · SoM · Share of Mention · UGC · 비-JS · 카테고리 무관)', !/Fact Graph|팩트 그래프|SoM|Share of Mention|UGC|비-JS|카테고리 무관/.test(paperText))
ok('고객 문구: 의료 업종 말 없음(원장 · 시술 · 진료 · 증상)', !/원장|시술|진료|증상/.test(paperText))
ok('고객 문구: 지표 이름', weakAll.metrics.some((m) => m.label === '언급률') && weakAll.metrics.some((m) => m.label === '언급 점유율 (점수 미포함)') && weakAll.metrics.some((m) => m.label === '자사 출처 인용률'))
ok('고객 문구: 사실성은 「등록된 브랜드 정보」와 견준다', weakAll.metrics.find((m) => m.key === 'factualityScore')!.note.startsWith('등록된 브랜드 정보와 다른 주장이 담긴 응답이 2건'))

// 8) 표지 측정 조건 — 종이에는 엔진 이름만(모델 id · preset은 화면에서)
const plain = measureConditionPlain({
  enginesUsed: ['openai', 'gemini', 'perplexity'],
  judgeEngine: 'claude',
  repeatsPerQuestion: 1,
  questionBankVersion: 'v5',
})
ok('표지 조건(종이): 엔진 이름 · 답변 분석 · 질문당 · 질문지', plain === 'ChatGPT · Gemini · Perplexity에 물음 · 답변 분석 Claude · 질문당 1회 · 질문지 v5')
ok('표지 조건(종이): 기록이 없으면 그 조각을 뺀다', measureConditionPlain({ enginesUsed: ['gemini'] }) === 'Gemini에 물음')

// 9) 개선제안 근거 — 사실성 원문은 화면 전용(D8: 고객 종이에는 건수만), 계산 예시는 합니다체
const evBank = { questions: [{ questionId: 'q0', text: '가상 질문', category: 'category-agnostic' }] } as unknown as QuestionBank
const evAnalyses = [
  {
    questionId: 'q0',
    engine: 'openai',
    mentioned: false,
    clarifying: false,
    mentionSentences: [],
    competitorMentions: [{ name: '경쟁사', mentionCount: 1 }],
    topRecommendation: '경쟁사',
    brandRank: null,
    factualityClaims: [{ verdict: 'contradicted', claimText: '주소', responseValue: '가상로 9', factGraphValue: '가상로 1' }],
  },
] as unknown as QuestionRepeatAnalysis[]
const ev = buildRecommendationEvidence({ card: card('2026-W41', 5, 5, { mentionRate: 0.02 }), analyses: evAnalyses, questions: evBank.questions, citations: null, site: null })
ok('근거: 사실성 원문 묶음은 화면 전용', ev.fact?.blocks.every((b) => b.screenOnly) === true)
ok('근거: 언급률 묶음은 종이에도 싣는다', ev.mention?.blocks.every((b) => !b.screenOnly) === true)
ok('근거: 계산 예시는 합니다체(「약속이 아닙니다」)', (ev.mention?.estimate ?? '').endsWith('약속이 아닙니다).'))

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
