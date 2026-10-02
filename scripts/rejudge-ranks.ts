/**
 * 저장된 답변의 추천 순위를 코호트 공통 목록(server/cohortEntities.ts)으로 다시 판정한다.
 *
 * 추천 순위 판정 기준을 바꾸면 새로 측정한 주차만 새 기준을 쓰고, 이미 저장된 주차는 옛 기준
 * ("이 브랜드 + 이 브랜드가 등록한 경쟁사"끼리만)으로 남는다. 그걸 맞춘다. 순위는 브랜드 이름 없는
 * 질문에서 브랜드가 언급된 답변에만 있을 수 있으므로 그 답변만 다시 판정한다(판정 호출 1건씩).
 * 원문(raw-calls.json)이 없는 주차는 다시 판정할 수 없어 그대로 둔다.
 *
 * 결과는 question-analyses.json의 brandRank·topRecommendation에 쓴다. 점수는 바꾸지 않는다 —
 * 이어서 scripts/rescore-local.ts를 같은 경로로 돌린다.
 *
 * 판정 모델은 같은 답변에도 다른 순위를 낼 수 있어, 미리보기와 실제 반영을 따로 돌리면 결과가
 * 갈린다. 데이터 사본에 먼저 돌려 영향을 확인하고, 그 사본의 판정 기록을 그대로 옮겨 쓴다.
 *
 *   npx tsx scripts/rejudge-ranks.ts "<userData 경로 또는 사본>"
 *
 * 앱을 종료한 뒤(또는 사본에) 실행한다.
 */
import 'dotenv/config'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const rawArg = process.argv.slice(2).find((a) => !a.startsWith('--'))
if (!rawArg) {
  console.error('사용법: npx tsx scripts/rejudge-ranks.ts "<userData 경로>"')
  process.exit(1)
}
// APP_DATA_DIR은 server/appPaths.ts가 모듈 로드 시점에 읽으므로, 그 전에 설정해야 한다.
process.env.APP_DATA_DIR = path.resolve(rawArg)

const { PIPELINE_DATA_DIR } = await import('../server/appPaths')
const { loadRuntimeTenants } = await import('../server/tenantRegistry')
const { cohortRankingEntities } = await import('../server/cohortEntities')
const { buildRecommendationOrderPrompt } = await import('../src/prompts/b5c-recommendation-order')
const { getJudgeClient } = await import('../server/engines/index')
const { parseJsonLoose } = await import('../server/jsonParse')
const { mapWithConcurrency } = await import('../server/concurrency')
type QuestionRepeatAnalysis = import('../server/types').QuestionRepeatAnalysis
type RawCallRecord = import('../server/types').RawCallRecord
type RecommendationOrderResult = import('../server/analysisTypes').RecommendationOrderResult
type QuestionBank = import('../server/store').QuestionBank

const readJson = <T,>(p: string): T | null => (existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : null)

const judge = getJudgeClient()
const tenants = new Map((await loadRuntimeTenants()).map((t) => [t.tenantId, t]))
const runtime = [...tenants.values()]

let judged = 0
let changed = 0
let failed = 0
const summary: string[] = []

for (const tenantId of readdirSync(PIPELINE_DATA_DIR)) {
  const tenant = tenants.get(tenantId)
  const tenantDir = path.join(PIPELINE_DATA_DIR, tenantId)
  if (!tenant || !existsSync(tenantDir)) continue
  const entities = cohortRankingEntities(tenant, runtime)
  for (const week of readdirSync(tenantDir).filter((w) => /^\d{4}-W\d{2}$/.test(w)).sort()) {
    const dir = path.join(tenantDir, week)
    const analyses = readJson<QuestionRepeatAnalysis[]>(path.join(dir, 'question-analyses.json'))
    const rawCalls = readJson<RawCallRecord[]>(path.join(dir, 'raw-calls.json'))
    const card = readJson<{ questionBankVersion?: string }>(path.join(dir, 'scorecard.json'))
    if (!analyses || !rawCalls || !card?.questionBankVersion) continue
    const bank = readJson<QuestionBank>(path.join(tenantDir, 'question-bank', `${card.questionBankVersion}.json`))
    if (!bank) continue
    const agnostic = new Set(bank.questions.filter((q) => q.category === 'category-agnostic').map((q) => q.questionId))
    const rawByKey = new Map(rawCalls.map((c) => [`${c.questionId}|${c.engine}|${c.callIndex}`, c]))
    const targets = analyses.filter((a) => a.mentioned && agnostic.has(a.questionId))
    if (targets.length === 0) continue

    const before = targets.map((a) => a.brandRank)
    await mapWithConcurrency(targets, 4, async (a) => {
      const raw = rawByKey.get(`${a.questionId}|${a.engine}|${a.callIndex}`)
      if (!raw) return
      try {
        const res = await judge.call(buildRecommendationOrderPrompt(tenant, raw.rawText, entities))
        const rank = parseJsonLoose<RecommendationOrderResult>(res.text)
        if (!rank) throw new Error('판정 응답을 읽지 못했습니다')
        a.brandRank = rank.ranking.find((r) => r.entity === tenant.brandName)?.rank ?? null
        a.topRecommendation = rank.topRecommendation ?? null
        judged += 1
      } catch (err) {
        // 판정이 실패한 답변은 옛 순위를 그대로 둔다 — 빈칸으로 바꾸면 순위가 없던 것처럼 보인다.
        failed += 1
        console.warn(`  판정 실패 ${tenantId} ${week} ${a.questionId}/${a.engine}: ${err instanceof Error ? err.message : err}`)
      }
    })
    const after = targets.map((a) => a.brandRank)
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changed += 1
      const fmt = (xs: (number | null)[]) => xs.filter((x) => x !== null).join(',') || '-'
      summary.push(`${tenantId.padEnd(26)} ${week}  순위 [${fmt(before)}] → [${fmt(after)}]`)
    }
    writeFileSync(path.join(dir, 'question-analyses.json'), JSON.stringify(analyses, null, 2), 'utf8')
  }
}

console.log(summary.join('\n'))
console.log(`\n대상 디렉터리: ${PIPELINE_DATA_DIR}`)
console.log(`다시 판정 ${judged}건 · 실패 ${failed}건 · 순위가 바뀐 카드 ${changed}장. 이어서 rescore-local.ts를 같은 경로로 돌리세요.`)
