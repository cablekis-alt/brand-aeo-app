/**
 * LLM 슬롯이 엔진마다 따로 도는지 확인한다(server/concurrency.ts). 실제 API는 부르지 않는다.
 *
 * 왜: 수집 슬롯 24를 세 엔진이 나눠 쓰던 때, Gemini가 느려지자 OpenAI·Perplexity까지 함께 느려져 측정이 7분에서
 * 11분이 됐다(2026-10-13). 한 엔진의 슬롯이 꽉 차도 다른 엔진·판정은 기다리지 않아야 한다.
 * Perplexity는 동시 8칸이 응답이 느린 날 한도의 1/3밖에 못 써(2026-10-21 W43: 6곳 측정에서 Perplexity만 14분) 분당 시작 상한
 * 45회 + 동시 24칸으로 바꿨다 — 시작 간격이 지켜지는지도 본다.
 *
 *   npx tsx scripts/verify-llm-pools.ts
 */
import { collectLimit, collectRpm, llmConcurrencyLimits, withLlmSlot } from '../server/concurrency'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])
const keys = ['COLLECT_LLM_CONCURRENCY', 'COLLECT_LLM_CONCURRENCY_PERPLEXITY', 'JUDGE_LLM_CONCURRENCY', 'COLLECT_LLM_RPM_PERPLEXITY', 'COLLECT_LLM_RPM_OPENAI'] as const
for (const k of keys) delete process.env[k]

// 1) 기본값 — 실측으로 정한 엔진별 상한
ok('Gemini 24', collectLimit('gemini') === 24)
ok('OpenAI 36', collectLimit('openai') === 36)
ok('Perplexity 24', collectLimit('perplexity') === 24)
ok('분당 시작 상한: Perplexity 45, 나머지 없음', collectRpm('perplexity') === 45 && collectRpm('openai') === 0 && collectRpm('gemini') === 0)
ok('판정 144', llmConcurrencyLimits().judge === 144)
ok('화면 확인 4', llmConcurrencyLimits().check === 4)

// 2) 환경변수 — 엔진 하나만, 또는 전부
process.env.COLLECT_LLM_CONCURRENCY_PERPLEXITY = '5'
ok('엔진 하나만 바꾸기', collectLimit('perplexity') === 5 && collectLimit('openai') === 36)
process.env.COLLECT_LLM_CONCURRENCY = '12'
ok('전부 바꾸기(엔진별 값이 우선)', collectLimit('openai') === 12 && collectLimit('perplexity') === 5)
for (const k of keys) delete process.env[k]

// 3) 슬롯이 엔진마다 독립 — Perplexity 8칸을 다 채워도 OpenAI·판정은 바로 돈다(이 확인은 칸 8 · 분당 상한 끔으로)
process.env.COLLECT_LLM_CONCURRENCY_PERPLEXITY = '8'
process.env.COLLECT_LLM_RPM_PERPLEXITY = '0'
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
for (const k of keys) delete process.env[k]

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

// 5) 분당 시작 상한 — 분당 600회(0.1초 간격)로 두면 동시에 6건을 넣어도 0.1초씩 벌어져 시작한다. 상한 없는 OpenAI는 한꺼번에.
process.env.COLLECT_LLM_RPM_PERPLEXITY = '600'
const stamp = async (pool: 'collect:perplexity' | 'collect:openai') => {
  const starts: number[] = []
  await Promise.all(Array.from({ length: 6 }, () => withLlmSlot(pool, async () => void starts.push(Date.now()))))
  return starts.sort((a, b) => a - b)
}
const paced = await stamp('collect:perplexity')
const gaps = paced.slice(1).map((t, i) => t - paced[i]!)
ok('분당 상한: 시작 간격을 지킨다(0.1초)', gaps.every((g) => g >= 90))
const free = await stamp('collect:openai')
ok('상한 없는 엔진은 기다리지 않는다', free.at(-1)! - free[0]! < 50)
process.env.COLLECT_LLM_RPM_PERPLEXITY = '0'
const off = await stamp('collect:perplexity')
ok('상한을 끄면(0) 기다리지 않는다', off.at(-1)! - off[0]! < 50)
for (const k of keys) delete process.env[k]

// 6) 다시 시도해도 안 풀리는 오류(크레딧 소진) — 줄에 선 호출은 간격을 기다리지 않고 같은 오류로 바로 끝난다(빨리 멈추기).
//    이 엔진은 1분 동안 끊긴 채라 맨 끝에 둔다.
process.env.COLLECT_LLM_RPM_PERPLEXITY = '600'
const ends: number[] = []
const outcomes = await Promise.all(
  Array.from({ length: 6 }, (_, i) =>
    withLlmSlot('collect:perplexity', async () => {
      if (i === 0) throw new Error('insufficient_quota: no credits left')
      return 'sent'
    }).then(
      (v) => (ends.push(Date.now()), v),
      (err: Error) => (ends.push(Date.now()), err.message),
    ),
  ),
)
ok('크레딧 소진 뒤 줄에 선 호출은 보내지 않고 같은 오류로 끝난다', outcomes.every((o) => o.includes('insufficient_quota')))
// 첫 호출은 앞 시험이 남긴 시작 예약만큼 기다릴 수 있다 — 첫 실패 뒤 나머지가 간격(0.1초 × 5) 없이 끝나는지 본다.
ok('첫 실패 뒤 나머지는 간격을 기다리지 않고 바로 끝난다', Math.max(...ends) - Math.min(...ends) < 100)
const otherEngine = await withLlmSlot('collect:openai', async () => 'sent')
ok('다른 엔진은 그대로 돈다', otherEngine === 'sent')
for (const k of keys) delete process.env[k]

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
