/**
 * 정기진단 보고서 숫자 칸의 건수(src/lib/reportTiles.ts)가 서버 점수 계산(server/aggregate.ts aggregateWeeklyMetrics)의 비율과 같은지 —
 * 가짜 판정 기록으로 본다. 화면 · 서버 없이 돈다.
 *
 *   npx tsx scripts/verify-report-tiles.ts
 */
import { aggregateWeeklyMetrics } from '../server/aggregate'
import type { QuestionSpec } from '../src/prompts/types'
import { citationDetail, mentionDetail, pct1, reportTileCounts, roundedPoints, shareDetail } from '../src/lib/reportTiles'
import type { QuestionRepeatAnalysis } from '../src/lib/types'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

const q = (questionId: string, category: QuestionSpec['category'], probe = false): QuestionSpec =>
  ({ questionId, text: `가상 질문 ${questionId}?`, category, industry: '가상', region: '가상시', containsBrandName: category === 'brand-direct', version: 'v1', ...(probe ? { probe: true } : {}) }) as QuestionSpec

const QUESTIONS = [q('a1', 'category-agnostic'), q('a2', 'category-agnostic'), q('b1', 'brand-direct'), q('p1', 'category-agnostic', true)]

type Opt = { mentioned?: boolean; sentences?: number; competitors?: number[]; owned?: number; other?: number }
const an = (questionId: string, o: Opt = {}): QuestionRepeatAnalysis =>
  ({
    questionId,
    engine: 'openai',
    callIndex: 0,
    mentioned: o.mentioned ?? false,
    mentionSentences: Array.from({ length: o.sentences ?? (o.mentioned ? 1 : 0) }, () => ({ text: '가상', sentiment: 'neutral' })),
    competitorMentions: (o.competitors ?? []).map((n, i) => ({ name: `경쟁${i}`, mentionCount: n })),
    shareOfMention: 0,
    citations: [
      ...Array.from({ length: o.owned ?? 0 }, () => ({ raw: 'https://own.example/', domain: 'own.example', ownerType: 'brand-owned', supportsBrandMention: true })),
      ...Array.from({ length: o.other ?? 0 }, () => ({ raw: 'https://x.example/', domain: 'x.example', ownerType: 'third-party-ugc', supportsBrandMention: false })),
    ],
    topRecommendation: null,
    brandRank: o.mentioned ? 2 : null,
    factualityClaims: [],
    factualitySupported: 0,
    factualityContradicted: 0,
    brandOwnedCitation: (o.owned ?? 0) > 0,
  }) as unknown as QuestionRepeatAnalysis

// 이름 없는 질문 4응답(2번 언급) · 이름 넣은 질문 2응답 · 실증 1응답(세지 않아야 함).
const ANALYSES = [
  an('a1', { mentioned: true, sentences: 2, competitors: [3, 1], owned: 1, other: 4 }),
  an('a1', { competitors: [4], other: 3 }),
  an('a2', { mentioned: true, sentences: 1, competitors: [2], other: 2 }),
  an('a2', { competitors: [1], other: 5 }),
  an('b1', { mentioned: true, sentences: 3, competitors: [9], owned: 6, other: 1 }),
  an('b1', { mentioned: true, sentences: 1, owned: 2 }),
  an('p1', { mentioned: true, sentences: 5, competitors: [7], owned: 9, other: 9 }),
]

const tenant = { competitors: [{ name: '경쟁0' }, { name: '경쟁1' }] }
const metrics = aggregateWeeklyMetrics(tenant, QUESTIONS, ANALYSES as never)
const c = reportTileCounts(ANALYSES, QUESTIONS, true)!

ok('언급 — 이름 없는 질문 4응답 중 2(실증 · 이름 넣은 질문 제외)', c.mention.responses === 4 && c.mention.mentioned === 2)
ok('언급 — 건수 비율이 서버 언급률과 같음', c.mention.mentioned / c.mention.responses === metrics.mentionRate)
ok('점유 — 우리 3회 · 전체 14회(실증 제외)', c.share.brand === 3 && c.share.total === 14 && c.share.measurable)
ok('점유 — 건수 비율이 서버 점유율과 같음', metrics.shareOfMention !== null && c.share.brand / c.share.total === metrics.shareOfMention)
ok('인용 — 전체 24건 중 자사 9건(실증 제외 · 이름 넣은 질문 포함)', c.citations.total === 24 && c.citations.owned === 9)
ok('인용 — 건수 비율이 서버 자사 인용률과 같음', c.citations.owned / c.citations.total === metrics.brandOwnedCitationRate)

// 점유율을 판정하지 않는 경우 — 서버가 null을 내는 경우와 같다.
const few = [an('a1', { mentioned: true, competitors: [2] }), an('a2', {})]
const fewMetrics = aggregateWeeklyMetrics(tenant, QUESTIONS, few as never)
const fewC = reportTileCounts(few, QUESTIONS, true)!
ok('점유 — 언급 10회 미만이면 판정 안 함(서버도 null)', !fewC.share.measurable && fewMetrics.shareOfMention === null)
ok('점유 — 판정 안 할 때 까닭 글자', shareDetail(fewC) === '브랜드 언급 3회 — 10회 미만이라 판정하지 않음')
const noComp = reportTileCounts(ANALYSES, QUESTIONS, false)!
ok('점유 — 경쟁사 목록이 없으면 판정 안 함(서버도 null)', !noComp.share.measurable && aggregateWeeklyMetrics({ competitors: [] }, QUESTIONS, ANALYSES as never).shareOfMention === null)
const none = reportTileCounts([an('a1', {}), an('a2', {})], QUESTIONS, true)!
ok('점유 — 언급이 하나도 없으면 「언급이 없음」', shareDetail(none) === '이름 없는 질문 답에 브랜드 언급이 없음')

// 못 읽음 — 0건으로 채우지 않는다.
ok('기록을 못 읽으면 null(0건 아님)', reportTileCounts(null, QUESTIONS, true) === null && reportTileCounts([], QUESTIONS, true) === null && reportTileCounts(ANALYSES, null, true) === null)
ok('건수를 모르면 작은 줄 없음', mentionDetail(null) === null && shareDetail(null) === null && citationDetail(null) === null)

// 글자.
ok('작은 줄 글자', mentionDetail(c) === '이름 없는 질문 응답 4건 중 2건' && shareDetail(c) === '브랜드 언급 14회 중 우리 3회' && citationDetail(c) === '인용 24건 중 자사 9건')
ok('천 단위 쉼표', citationDetail({ ...c, citations: { owned: 120, total: 1739 } }) === '인용 1,739건 중 자사 120건')
ok('비율 → % 소수 한 자리', pct1(0.069) === 6.9 && pct1(0.0076) === 0.8 && pct1(0.027) === 2.7 && pct1(0) === 0)

// 점수 몫 — 합이 총점과 정확히 같게(W46 실측 세 브랜드의 몫).
const sumOf = (m: Map<string, number | null>) => Math.round([...m.values()].reduce((n: number, v) => n + (v ?? 0), 0) * 10) / 10
const stay = roundedPoints([{ key: 'mention', points: 1.27 }, { key: 'rank', points: 15.45 }, { key: 'owned', points: 0.28 }], 17)
ok('점수 몫 — 1.27 · 15.45 · 0.28 → 합 17(가장 큰 몫에서 맞춤)', sumOf(stay) === 17 && stay.get('mention') === 1.3 && stay.get('owned') === 0.3 && stay.get('rank') === 15.4)
const gun = roundedPoints([{ key: 'mention', points: 0 }, { key: 'rank', points: null }, { key: 'owned', points: 3.07 }], 3)
ok('점수 몫 — 순위 없는 주는 null 그대로, 합 3', sumOf(gun) === 3 && gun.get('rank') === null && gun.get('mention') === 0 && gun.get('owned') === 3)
const o2o = roundedPoints([{ key: 'mention', points: 0.95 }, { key: 'rank', points: 20.87 }, { key: 'owned', points: 3.18 }], 25)
ok('점수 몫 — 0.95 · 20.87 · 3.18 → 합 25', sumOf(o2o) === 25)
const zero = roundedPoints([{ key: 'mention', points: 0 }, { key: 'rank', points: null }, { key: 'owned', points: 0 }], 0)
ok('점수 몫 — 0점이면 모두 0', sumOf(zero) === 0 && zero.get('owned') === 0)

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
