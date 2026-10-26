/**
 * 측정 상태의 비용 문구(src/lib/engineCost.ts sumCost · costText · costTotalText · costPartText)를 확인한다. 가짜 사용량만 쓴다.
 *
 * 왜: 계산하지 못한 줄이 섞이면 「9.92 USD+」로만 적어 「+」가 무슨 뜻인지 몰랐고, 하나도 계산하지 못한 주(판정 엔진 단가 미설정)는
 * 합이 0이라 「0 USD」처럼 읽혔다 — 공짜로 측정한 것처럼 보인다.
 *
 *   npx tsx scripts/verify-cost-text.ts
 */
import type { EngineRate, UsageRow } from '../src/lib/api'
import { costPartText, costText, costTotalText, mergeCost, sumCost } from '../src/lib/engineCost'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

const row = (engine: string, p: Partial<UsageRow> = {}): UsageRow => ({
  engine,
  calls: 100,
  tokens: 1_000_000,
  inputTokens: 600_000,
  outputTokens: 400_000,
  billedCost: null,
  latencyMs: 0,
  tenants: 1,
  searchCalls: 0,
  searchByMonth: [],
  ...p,
})
const rates: Record<string, EngineRate> = {
  openai: { inputPerM: 2, outputPerM: 8 }, // 1.2 + 3.2 = 4.4
  gemini: { inputPerM: 1, outputPerM: 4 }, // 0.6 + 1.6 = 2.2
}

const all = sumCost([row('openai'), row('gemini')], rates)
ok('다 계산 → 금액만', costText(all, 'USD') === '6.6 USD' && all.complete && all.counted === 2)
const someMissing = sumCost([row('openai'), row('claude')], rates)
ok('일부 → 「4.4 USD 이상 — Claude 단가 미설정」', costText(someMissing, 'USD') === '4.4 USD 이상 — Claude 단가 미설정' && !someMissing.complete)
const none = sumCost([row('claude'), row('claude')], rates)
ok('하나도 못 함 → 「확인 불가(Claude 단가 미설정)」(엔진은 한 번만)', costText(none, 'USD') === '확인 불가(Claude 단가 미설정)' && none.missing.length === 1)
const noSplit = sumCost([row('openai', { inputTokens: 0, outputTokens: 0 })], rates)
ok('입력 · 출력 기록 없음 → 「확인 불가(입력·출력 기록 없음)」', costText(noSplit, 'USD') === '확인 불가(입력·출력 기록 없음)')
const billed = sumCost([row('perplexity', { billedCost: 3.5 })], rates)
ok('엔진이 알려 준 청구액은 단가 없이 금액', costText(billed, 'USD') === '3.5 USD' && billed.complete)

// 주차 칸 — 합계와 괄호 안 몫
const collect = sumCost([row('openai'), row('perplexity', { billedCost: 7.85 })], rates)
const judge = sumCost([row('claude')], rates)
const total = mergeCost(collect, judge)
ok('합계: 일부만 → 「비용 12.25 USD 이상」', costTotalText(total, 'USD') === '비용 12.25 USD 이상')
ok('몫: 「12.25 USD」 · 「확인 불가 — Claude 단가 미설정」', costPartText(collect, 'USD') === '12.25 USD' && costPartText(judge, 'USD') === '확인 불가 — Claude 단가 미설정')
ok('합계: 다 못 함 → 「비용 확인 불가」', costTotalText(mergeCost(judge, judge), 'USD') === '비용 확인 불가')
ok('합계: 줄이 없으면 그리지 않는다(null)', costTotalText(sumCost([], rates), 'USD') === null)
ok('몫: 일부 → 「4.4 USD 이상 — Claude 단가 미설정」', costPartText(someMissing, 'USD') === '4.4 USD 이상 — Claude 단가 미설정')
const twoReasons = sumCost([row('claude'), row('openai', { inputTokens: 0, outputTokens: 0 })], rates)
ok('까닭이 둘이면 함께', costText(twoReasons, 'USD') === '확인 불가(Claude 단가 미설정 · 입력·출력 기록 없음)')
const texts = [all, someMissing, none, noSplit, billed, total, judge].flatMap((v) => [costText(v, 'USD'), costPartText(v, 'USD'), costTotalText(v, 'USD') ?? ''])
ok('「0 USD」 · 「+」 표기가 어디에도 없다', texts.every((t) => !/(^|\s)0 USD/.test(t) && !t.includes('+')))

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
