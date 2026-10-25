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
ok('측정 횟수: 보고 주차 뒤 주차는 세지 않는다(1개 → 주의)', runs.status === 'warn' && runs.detail.includes('아직 1개'))
const qCheck = trustChecks(self, [self], [memberA, memberC], rows, null).find((c) => c.id === 'questions')!
ok('같은 질문지: 다른 질문을 받은 브랜드(다)를 밝힌다', qCheck.status === 'warn' && qCheck.detail.startsWith('다은(는) 일반 질문이 다릅니다'))

// 5) 이 브랜드 응답 요약 — 은행을 못 읽으면 null(「불린 적 없음」으로 쓰지 않는다)
const analyses = [
  { questionId: 'q0', engine: 'openai', mentioned: true, clarifying: false, factualityClaims: [] },
  { questionId: 'q1', engine: 'gemini', mentioned: false, clarifying: true, factualityClaims: [{ verdict: 'contradicted', claimText: '주소', responseValue: '가상로 9', factGraphValue: '가상로 1' }] },
] as unknown as QuestionRepeatAnalysis[]
ok('응답 요약: 은행이 없으면 null', selfReview(analyses, null) === null)
const sr = selfReview(analyses, bankOf(['질문1', '질문2']))!
ok('응답 요약: 일반 질문 2개 · 응답 2 · 불림 1 · 되물음 1', sr.general.questions === 2 && sr.general.responses === 2 && sr.general.mentioned === 1 && sr.general.clarifying === 1)
ok('응답 요약: 불린 질문과 엔진', sr.mentionedQuestions.length === 1 && sr.mentionedQuestions[0]!.text === '질문1')
ok('응답 요약: 「틀림」 원문(질문 · AI 값 · 등록 값)', sr.contradicted.length === 1 && sr.contradicted[0]!.said === '가상로 9' && sr.contradicted[0]!.registered === '가상로 1')

// 6) 상위 출처 — 상위 6개 밖의 자사 출처도 넣는다
const crow = (domain: string, n: number, ownerType = 'third-party-ugc') => ({ domain, ownerType, citationCount: n, supportingBrandMentionCount: 0 }) as CitationBreakdownRow
const top = citationTop([...Array.from({ length: 7 }, (_, i) => crow(`d${i}.example`, 10 - i)), crow('me.example', 1, 'brand-owned')])
ok('출처: 상위 6개 + 자사 1개', top.top.length === 7 && top.top.at(-1)!.domain === 'me.example' && top.top.at(-1)!.isOwned)
ok('출처: 합계 · 자사 건수', top.total === 10 + 9 + 8 + 7 + 6 + 5 + 4 + 1 && top.owned === 1)

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
