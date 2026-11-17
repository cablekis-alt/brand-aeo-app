/**
 * Claude 판정 호출의 대기 상한(server/engines/claudeJudgeClient.ts JUDGE_TIMEOUT_MS)을 확인한다. 실제 API는 부르지 않는다 — 요청 한 번(send)만
 * 가짜로 바꿔 끼운다.
 *
 * 왜: 상한이 없어 API가 잠깐 멈춘 판정 두 건이 160초씩 붙잡아 스테이,머뭄 측정이 106초 → 350초로 늘었다(2026-11-17).
 * 상한을 넘으면 끊고 한 번 더 보내고, 두 번 다 넘으면 빈 결과(실패 한 건)로 돌린다. 글쓰기는 상한이 없어야 한다(몇 분씩 걸리는 게 정상).
 *
 *   npx tsx scripts/verify-judge-timeout.ts
 */
import type Anthropic from '@anthropic-ai/sdk'
import { ClaudeJudgeClient, JUDGE_TIMEOUT_MS } from '../server/engines/claudeJudgeClient'
import type { PromptMessage } from '../src/prompts/types'

process.env.ANTHROPIC_API_KEY ??= 'test-key-not-used'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

const message = (text: string) =>
  ({
    model: 'claude-test',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  }) as unknown as Anthropic.Beta.BetaMessage

/** 시도마다 정한 동작 — 'hang'은 끊길 때까지 기다린다(끊기면 SDK처럼 던진다), 'ok'는 바로 답한다, 'error'는 바로 던진다. */
class FakeClient extends ClaudeJudgeClient {
  sent = 0
  sawSignal: boolean[] = []
  constructor(
    private readonly plan: ('hang' | 'ok' | 'error')[],
    timeoutMs?: number,
  ) {
    super('claude-test', timeoutMs === undefined ? {} : { timeoutMs })
  }
  protected override send(_prompt: PromptMessage, signal: AbortSignal | undefined): Promise<Anthropic.Beta.BetaMessage> {
    const step = this.plan[this.sent] ?? 'ok'
    this.sent += 1
    this.sawSignal.push(signal !== undefined)
    if (step === 'ok') return Promise.resolve(message(`답 ${this.sent}`))
    if (step === 'error') return Promise.reject(new Error('500 server error'))
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' })))
      if (!signal) setTimeout(() => _resolve(message('늦은 답')), 120)
    })
  }
}

const prompt: PromptMessage = { system: 's', user: 'u' }
const quiet = <T>(fn: () => Promise<T>) => {
  const warn = console.warn
  const error = console.error
  console.warn = () => {}
  console.error = () => {}
  return fn().finally(() => {
    console.warn = warn
    console.error = error
  })
}

// 0) 기본값
ok('기본 상한 60초', JUDGE_TIMEOUT_MS === 60_000)

// 1) 바로 답하면 한 번만 보낸다
{
  const c = new FakeClient(['ok'], 50)
  const r = await c.call(prompt)
  ok('바로 답하면 그 답 · 한 번만 보냄', r.text === '답 1' && c.sent === 1 && c.sawSignal[0] === true)
}

// 2) 첫 시도가 멈추면 상한에서 끊고 한 번 더 — 두 번째 답을 쓴다
{
  const c = new FakeClient(['hang', 'ok'], 50)
  const t0 = performance.now()
  const r = await quiet(() => c.call(prompt))
  const ms = performance.now() - t0
  ok('멈춘 첫 시도는 끊고 다시 보내 두 번째 답을 쓴다', r.text === '답 2' && c.sent === 2)
  ok('끊는 시점은 상한 근처(50ms 상한 → 1초 안)', ms >= 45 && ms < 1000)
}

// 3) 두 번 다 멈추면 빈 결과(실패 한 건) — 세 번째는 보내지 않는다
{
  const c = new FakeClient(['hang', 'hang', 'ok'], 50)
  const r = await quiet(() => c.call(prompt))
  ok('두 번 다 넘으면 빈 결과 · 두 번만 보냄', r.text === '' && c.sent === 2)
}

// 4) 시간 초과가 아닌 오류는 다시 보내지 않는다(SDK가 이미 재시도한다) — 빈 결과
{
  const c = new FakeClient(['error', 'ok'], 50)
  const r = await quiet(() => c.call(prompt))
  ok('시간 초과 아닌 오류는 한 번만 보내고 빈 결과', r.text === '' && c.sent === 1)
}

// 5) 상한 없이 만든 클라이언트(글쓰기)는 끊지 않는다 — 상한보다 오래 걸려도 그 답을 쓴다
{
  const c = new FakeClient(['hang'])
  const r = await c.call(prompt)
  ok('상한 없는 클라이언트(글쓰기)는 끊지 않고 기다린다', r.text === '늦은 답' && c.sent === 1 && c.sawSignal[0] === false)
}

// 6) 판정 클라이언트에만 상한을 거는지 — getJudgeClient · getWriterClient 배선
{
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../server/engines/index.ts', import.meta.url), 'utf8')
  ok('판정 클라이언트는 JUDGE_TIMEOUT_MS로 만든다', /judgeClient = limited\(guarded\(new ClaudeJudgeClient\(undefined, \{ timeoutMs: JUDGE_TIMEOUT_MS \}\)\)/.test(src))
  ok('글쓰기 클라이언트는 상한 없이 만든다', /writerClient = limited\(new ClaudeJudgeClient\(claudeWriterModel\(\)\), 'judge'\)/.test(src))
}

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
