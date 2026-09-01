/**
 * 저장된 실측 분석으로부터 9개 테넌트 스코어카드를 새 점수식으로 재계산한다 (새 API 호출 없음).
 * computeAeoScore가 바뀔 때(예: 순위 null 재정규화) 반영용.
 *   - 브랜드(example-brand, stay-meomum): src/data/live-*-question-analyses.json + live-*-question-bank.json
 *   - 경쟁사(cohortOnly): data/<tenant>/2026-W36/question-analyses.json + data/<tenant>/question-bank/<ver>.json
 * 결과를 src/data/demo-scorecards.json에 반영하고 코호트 순위를 재계산한다.
 *   npx tsx scripts/rescore-all.ts
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { computeAeoScore, computeCohortRank, mean, meanWithConfidenceInterval } from '../server/scoring'
import type { WeeklyScorecard } from '../src/prompts/b8-report'
import type { QuestionSpec } from '../src/prompts/types'
import type { QuestionRepeatAnalysis, TenantConfig } from '../server/types'

const WEEK = '2026-W36'
const read = <T,>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T

const tenants = read<TenantConfig[]>('server/tenants.config.json')
const cards = read<WeeklyScorecard[]>('src/data/demo-scorecards.json')

const BRAND_SOURCES: Record<string, { bank: string; analyses: string }> = {
  'example-brand': {
    bank: 'src/data/live-question-bank.json',
    analyses: 'src/data/live-question-analyses.json',
  },
  'stay-meomum': {
    bank: 'src/data/live-stay-question-bank.json',
    analyses: 'src/data/live-stay-question-analyses.json',
  },
}

/** 테넌트의 (은행 질문, 분석)을 읽는다. 브랜드는 src/data live-*, 경쟁사는 data/. */
function loadSource(tenant: TenantConfig): { questions: QuestionSpec[]; analyses: QuestionRepeatAnalysis[] } | null {
  const brand = BRAND_SOURCES[tenant.tenantId]
  if (brand) {
    const bank = read<{ questions: QuestionSpec[] }>(brand.bank)
    const wrapped = read<{ analyses: QuestionRepeatAnalysis[] }>(brand.analyses)
    return { questions: bank.questions, analyses: wrapped.analyses }
  }
  const bankPath = `data/${tenant.tenantId}/question-bank/${tenant.questionBankVersion}.json`
  const anPath = `data/${tenant.tenantId}/${WEEK}/question-analyses.json`
  if (!existsSync(bankPath) || !existsSync(anPath)) return null
  const bank = read<{ questions: QuestionSpec[] }>(bankPath)
  const analyses = read<QuestionRepeatAnalysis[]>(anPath) // data/는 순수 배열
  return { questions: bank.questions, analyses }
}

function recompute(prev: WeeklyScorecard, tenant: TenantConfig): WeeklyScorecard {
  const src = loadSource(tenant)
  if (!src) {
    console.warn(`  ${tenant.tenantId}: 분석 소스 없음 — 기존 카드 유지`)
    return prev
  }
  const { questions, analyses } = src
  const catOf = new Map(questions.map((q) => [q.questionId, q.category]))

  const agnostic = analyses.filter((a) => catOf.get(a.questionId) === 'category-agnostic')
  const mentionRate = mean(agnostic.map((a) => (a.mentioned ? 1 : 0)))

  const hasCompetitors = tenant.competitors.length > 0
  const brandMentionTotal = analyses.reduce((s, a) => s + a.mentionSentences.length, 0)
  const competitorMentionTotal = analyses.reduce(
    (s, a) => s + a.competitorMentions.reduce((t, c) => t + c.mentionCount, 0),
    0,
  )
  const shareTotal = brandMentionTotal + competitorMentionTotal
  const shareOfMention = hasCompetitors && shareTotal > 0 ? brandMentionTotal / shareTotal : null

  const ranks = analyses.map((a) => a.brandRank).filter((r): r is number => r !== null)
  const avgRecommendationRank = ranks.length > 0 ? mean(ranks) : null

  const supported = analyses.reduce((s, a) => s + a.factualitySupported, 0)
  const contradicted = analyses.reduce((s, a) => s + a.factualityContradicted, 0)
  const factualityScore = supported + contradicted > 0 ? supported / (supported + contradicted) : 1

  const totalCitations = analyses.reduce((s, a) => s + a.citations.length, 0)
  const brandOwnedCitations = analyses.reduce(
    (s, a) => s + a.citations.filter((c) => c.ownerType === 'brand-owned').length,
    0,
  )
  const brandOwnedCitationRate = totalCitations > 0 ? brandOwnedCitations / totalCitations : 0

  const currentScore = computeAeoScore({
    mentionRate,
    shareOfMention,
    avgRecommendationRank,
    factualityScore,
    brandOwnedCitationRate,
  })

  const perCallScores = analyses.map((a) => {
    const f =
      a.factualitySupported + a.factualityContradicted > 0
        ? a.factualitySupported / (a.factualitySupported + a.factualityContradicted)
        : 1
    return computeAeoScore({
      mentionRate: a.mentioned ? 1 : 0,
      shareOfMention: hasCompetitors ? a.shareOfMention : null,
      avgRecommendationRank: a.brandRank,
      factualityScore: f,
      brandOwnedCitationRate: a.brandOwnedCitation ? 1 : 0,
    })
  })
  const ci = meanWithConfidenceInterval(perCallScores)
  const margin = ci.high - ci.mean

  // 파이프라인과 동일하게 실측 분석에서 다시 만든다 (이전 카드 값을 재사용하면 stale해진다).
  const hallucinationFlags = analyses
    .filter((a) => a.factualityContradicted > 0)
    .map((a) => `${a.engine} / ${a.questionId} #${a.callIndex}: 사실성 불일치 ${a.factualityContradicted}건`)

  return {
    ...prev,
    aeoScore: {
      current: currentScore,
      ma4: currentScore,
      previousWeek: currentScore,
      ciLow: Math.round((currentScore - margin) * 10) / 10,
      ciHigh: Math.round((currentScore + margin) * 10) / 10,
    },
    mentionRate,
    shareOfMention,
    avgRecommendationRank,
    factualityScore,
    brandOwnedCitationRate,
    hallucinationFlags,
  }
}

const byId = new Map(tenants.map((t) => [t.tenantId, t]))
const next = cards.map((c) => {
  const tenant = byId.get(c.tenantId)
  if (!tenant) return c
  const updated = recompute(c, tenant)
  const fmt = (r: number | null) => (r === null ? 'null' : r.toFixed(2))
  console.log(
    `${c.tenantId.padEnd(16)} Score ${c.aeoScore.current}→${updated.aeoScore.current}` +
      `  (순위 ${fmt(updated.avgRecommendationRank)}${updated.avgRecommendationRank === null ? ' → 재정규화 제외' : ''})`,
  )
  return updated
})

// 코호트 순위 재계산 (업종·지역·주차 그룹).
for (const card of next) {
  const group = next.filter(
    (c) => c.industry === card.industry && c.region === card.region && c.weekOf === card.weekOf,
  )
  card.cohortRank = computeCohortRank(card.aeoScore.current, group)
}

writeFileSync('src/data/demo-scorecards.json', JSON.stringify(next, null, 2) + '\n')
console.log('\ndemo-scorecards.json 갱신 완료')
for (const [key, list] of groupByCohort(next)) {
  console.log(`\n[${key}]`)
  for (const c of [...list].sort((a, b) => b.aeoScore.current - a.aeoScore.current)) {
    console.log(`  ${c.cohortRank.position}/${c.cohortRank.totalTenants}  Score ${String(c.aeoScore.current).padStart(3)}  ${c.brandName}`)
  }
}

function groupByCohort(list: WeeklyScorecard[]): Map<string, WeeklyScorecard[]> {
  const m = new Map<string, WeeklyScorecard[]>()
  for (const c of list) {
    const key = `${c.industry} · ${c.region} · ${c.weekOf}`
    m.set(key, [...(m.get(key) ?? []), c])
  }
  return m
}
