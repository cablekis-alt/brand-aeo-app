/**
 * 저장된 실측 분석(src/data/live-*-question-analyses.json)으로부터 모든 테넌트의 스코어카드를
 * 현재 점수식으로 재계산한다 (새 API 호출 없음). 집계 규칙이 바뀔 때 저장된 카드를 맞추는 용도다.
 *   - 소스: server/liveRegistry.ts의 LIVE_BANKS·LIVE_ANALYSES (publish-tenant.ts가 자동 갱신)
 *   - 결과: src/data/demo-scorecards.json 갱신 + 코호트 순위 재계산
 *
 * 집계는 파이프라인과 같은 server/aggregate.ts를 쓴다 — 새 측정과 저장된 측정의 정의가 갈리지 않는다.
 *   npx tsx scripts/rescore-all.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { aggregateWeeklyMetrics } from '../server/aggregate'
import { LIVE_ANALYSES, LIVE_BANKS } from '../server/liveRegistry'
import { computeCohortRank, movingAverage4 } from '../server/scoring'
import type { WeeklyScorecard } from '../src/prompts/b8-report'
import type { QuestionSpec } from '../src/prompts/types'
import type { QuestionRepeatAnalysis, TenantConfig } from '../server/types'

const read = <T,>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T

const tenants = read<TenantConfig[]>('server/tenants.config.json')
const cards = read<WeeklyScorecard[]>('src/data/demo-scorecards.json')

/** 테넌트·주차의 (은행 질문, 판정 레코드). 실측 산출물이 없으면 null. */
function loadSource(
  tenantId: string,
  weekOf: string,
): { questions: QuestionSpec[]; analyses: QuestionRepeatAnalysis[] } | null {
  const bank = LIVE_BANKS[tenantId]
  const file = LIVE_ANALYSES.find((f) => f.tenantId === tenantId && f.weekOf === weekOf)
  if (!bank || !file || !Array.isArray(file.analyses) || file.analyses.length === 0) return null
  return { questions: bank.questions, analyses: file.analyses as QuestionRepeatAnalysis[] }
}

function recompute(prev: WeeklyScorecard, tenant: TenantConfig, history: WeeklyScorecard[]): WeeklyScorecard {
  const src = loadSource(tenant.tenantId, prev.weekOf)
  if (!src) {
    console.warn(`  ${tenant.tenantId} ${prev.weekOf}: 분석 소스 없음 — 기존 카드 유지`)
    return prev
  }
  const m = aggregateWeeklyMetrics(tenant, src.questions, src.analyses)
  const previousWeek = history.length > 0 ? history[history.length - 1].aeoScore.current : m.score
  const ma4 = Math.round(movingAverage4([...history.map((h) => h.aeoScore.current), m.score]))

  return {
    ...prev,
    aeoScore: {
      current: m.score,
      ma4,
      previousWeek,
      ciLow: Math.round((m.score - m.ciMargin) * 10) / 10,
      ciHigh: Math.round((m.score + m.ciMargin) * 10) / 10,
    },
    mentionRate: m.mentionRate,
    shareOfMention: m.shareOfMention,
    avgRecommendationRank: m.avgRecommendationRank,
    factualityScore: m.factualityScore,
    brandOwnedCitationRate: m.brandOwnedCitationRate,
    hallucinationFlags: m.hallucinationFlags,
    enginesUsed: m.enginesUsed,
  }
}

const byId = new Map(tenants.map((t) => [t.tenantId, t]))
const ordered = [...cards].sort((a, b) => a.weekOf.localeCompare(b.weekOf))
const historyByTenant = new Map<string, WeeklyScorecard[]>()

const updatedById = new Map<string, WeeklyScorecard>()
const pctOrNull = (v: number | null) => (v === null ? '측정불가' : `${(v * 100).toFixed(1)}%`)

for (const card of ordered) {
  const tenant = byId.get(card.tenantId)
  const key = `${card.tenantId}::${card.weekOf}`
  if (!tenant) {
    updatedById.set(key, card)
    continue
  }
  const history = historyByTenant.get(card.tenantId) ?? []
  const updated = recompute(card, tenant, history)
  historyByTenant.set(card.tenantId, [...history, updated])
  updatedById.set(key, updated)

  const scoreMoved = updated.aeoScore.current !== card.aeoScore.current
  const somMoved = updated.shareOfMention !== card.shareOfMention
  if (scoreMoved || somMoved) {
    console.log(
      `${card.tenantId.padEnd(18)} ${card.weekOf}  Score ${card.aeoScore.current}→${updated.aeoScore.current}` +
        (somMoved ? `  SoM ${pctOrNull(card.shareOfMention)}→${pctOrNull(updated.shareOfMention)}` : ''),
    )
  }
}

const next = cards.map((c) => updatedById.get(`${c.tenantId}::${c.weekOf}`) ?? c)

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
    console.log(
      `  ${c.cohortRank.position}/${c.cohortRank.totalTenants}  Score ${String(c.aeoScore.current).padStart(3)}  ${c.brandName}`,
    )
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
