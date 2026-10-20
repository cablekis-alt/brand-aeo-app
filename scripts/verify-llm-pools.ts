/**
 * LLM 슬롯이 엔진마다 따로 도는지 확인한다(server/concurrency.ts). 실제 API는 부르지 않는다.
 *
 * 왜: 수집 슬롯 24를 세 엔진이 나눠 쓰던 때, Gemini가 느려지자 OpenAI·Perplexity까지 함께 느려져 측정이 7분에서
 * 11분이 됐다(2026-10-13). 한 엔진의 슬롯이 꽉 차도 다른 엔진·판정은 기다리지 않아야 한다.
 *
 *   npx tsx scripts/verify-llm-pools.ts
 */
import { collectLimit, llmConcurrencyLimits, withLlmSlot } from '../server/concurrency'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])
const keys = ['COLLECT_LLM_CONCURRENCY', 'COLLECT_LLM_CONCURRENCY_PERPLEXITY', 'JUDGE_LLM_CONCURRENCY'] as const
for (const k of keys) delete process.env[k]

// 1) 기본값 — 실측으로 정한 엔진별 상한
ok('Gemini 24', collectLimit('gemini') === 24)
ok('OpenAI 36', collectLimit('openai') === 36)
ok('Perplexity 8', collectLimit('perplexity') === 8)
ok('판정 144', llmConcurrencyLimits().judge === 144)
ok('화면 확인 4', llmConcurrencyLimits().check === 4)

// 2) 환경변수 — 엔진 하나만, 또는 전부
process.env.COLLECT_LLM_CONCURRENCY_PERPLEXITY = '5'
ok('엔진 하나만 바꾸기', collectLimit('perplexity') === 5 && collectLimit('openai') === 36)
process.env.COLLECT_LLM_CONCURRENCY = '12'
ok('전부 바꾸기(엔진별 값이 우선)', collectLimit('openai') === 12 && collectLimit('perplexity') === 5)
for (const k of keys) delete process.env[k]

// 3) 슬롯이 엔진마다 독립 — Perplexity 8칸을 다 채워도 OpenAI·판정은 바로 돈다
let release!: () => void
const gate = new Promise<void>((r) => (release = r))
const order: string[] = []
const held = Array.from({ length: 8 }, (_, i) => withLlmSlot('collect:perplexity', async () => {
  order.push(`p${i}`)
  await gate
}))
const ninth = withLlmSlot('collect:perplexity', async () => {
  order.push('p8')
})
const openai = withLlmSlot('collect:openai', async () => {
  order.push('openai')
})
const judge = withLlmSlot('judge', async () => {
  order.push('judge')
})
await Promise.all([openai, judge])
ok('Perplexity가 꽉 차도 OpenAI는 기다리지 않는다', order.includes('openai'))
ok('Perplexity가 꽉 차도 판정은 기다리지 않는다', order.includes('judge'))
ok('Perplexity 9번째는 자리가 날 때까지 기다린다', !order.includes('p8'))
release()
await Promise.all([...held, ninth])
ok('자리가 나면 9번째도 돈다', order.includes('p8'))

// 4) 화면에서 기다리는 확인(경쟁사 업종)은 측정 수집 줄에 서지 않는다 — Gemini 수집 24칸이 다 차도 바로 돈다
let releaseG!: () => void
const gateG = new Promise<void>((r) => (releaseG = r))
const heldG = Array.from({ length: 24 }, () => withLlmSlot('collect:gemini', () => gateG))
let checked = false
await withLlmSlot('check', async () => {
  checked = true
})
ok('Gemini 수집이 꽉 차도 화면 확인은 기다리지 않는다', checked)
releaseG()
await Promise.all(heldG)

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
