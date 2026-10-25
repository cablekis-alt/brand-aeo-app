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
