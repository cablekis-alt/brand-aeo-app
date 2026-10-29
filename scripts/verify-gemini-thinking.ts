/**
 * Gemini 생각 수준 · 실제 모델 기록 · 생각 토큰 비용을 확인한다. 임시 폴더를 APP_DATA_DIR로 쓰고 가짜 기록만 만든다. AI는 부르지 않는다.
 *
 * 왜: 3.8 Flash는 기본 생각 수준(보통)에서 호출당 약 800토큰을 생각에 쓰고, 그 토큰은 출력 단가로 청구되는데 출력 토큰에는
 * 들지 않아 앱 비용이 실제의 절반쯤으로 보였다. 또 gemini-3.7-flash로 보낸 요청은 2026-08-13부터 3.8 Flash가 처리하는데
 * 기록에는 3.7로 남았다. 2026-10-29 비교 측정 뒤 생각 수준을 낮음으로 내리고 기록을 실제에 맞춘다.
 *
 *   npx tsx scripts/verify-gemini-thinking.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'verify-gemini-thinking-'))
process.env.APP_DATA_DIR = dir
process.env.BLOB_READ_WRITE_TOKEN = ''
process.env.BLOB_STORE_ID = ''

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

try {
  const { ThinkingLevel } = await import('@google/genai')
  const { resolveThinkingLevel, geminiModelLabel } = await import('../server/engines/geminiEngineClient')
  const { thoughtTokensOf, getUsageStats } = await import('../server/usageStats')
  const { compareConditions } = await import('../src/lib/comparability')

  // ── 생각 수준 ──
  ok('비우면 LOW(기본)', resolveThinkingLevel(undefined) === ThinkingLevel.LOW && resolveThinkingLevel('  ') === ThinkingLevel.LOW)
  ok('medium → MEDIUM(대소문자 무관)', resolveThinkingLevel('medium') === ThinkingLevel.MEDIUM)
  ok('DEFAULT → 보내지 않음(모델 기본값)', resolveThinkingLevel('DEFAULT') === undefined)
  const warn = console.warn
  console.warn = () => undefined
  ok('모르는 값 → LOW', resolveThinkingLevel('bogus') === ThinkingLevel.LOW && resolveThinkingLevel('THINKING_LEVEL_UNSPECIFIED') === ThinkingLevel.LOW)
  console.warn = warn

  // ── 기록할 모델 ──
  ok('실제 모델 + 생각 수준', geminiModelLabel('gemini-3.8-flash', 'gemini-3.7-flash', ThinkingLevel.LOW) === 'gemini-3.8-flash (thinking low)')
  ok('응답에 모델이 없으면 보낸 이름', geminiModelLabel(undefined, 'gemini-3.7-flash', ThinkingLevel.LOW) === 'gemini-3.7-flash (thinking low)')
  ok('DEFAULT면 꼬리 없음', geminiModelLabel('gemini-3.8-flash', 'gemini-3.7-flash', undefined) === 'gemini-3.8-flash')

  // ── 생각 토큰 ──
  ok('기록된 생각 토큰을 쓴다', thoughtTokensOf({ engine: 'gemini', tokenUsage: 2000, inputTokens: 300, outputTokens: 900, thoughtTokens: 0 }) === 0)
  ok('Gemini 옛 기록은 전체 − 입력 − 출력', thoughtTokensOf({ engine: 'gemini', tokenUsage: 2000, inputTokens: 300, outputTokens: 900 }) === 800)
  ok('다른 엔진은 0(출력에 이미 포함)', thoughtTokensOf({ engine: 'openai', tokenUsage: 2000, inputTokens: 300, outputTokens: 900 }) === 0)
  ok('합이 모자라면 0', thoughtTokensOf({ engine: 'gemini', tokenUsage: 1000, inputTokens: 300, outputTokens: 900 }) === 0 && thoughtTokensOf({ engine: 'gemini', inputTokens: 1 }) === 0)

  // ── 비용 집계: 출력에 생각 토큰이 들어간다 ──
  const week = '2026-W44'
  const call = (engine: string, extra: Record<string, number>) => ({
    tenantId: 'tg', weekOf: week, engine, questionId: 'q1', callIndex: 0, rawText: 'x', citations: [], usedWebSearch: false,
    calledAt: '2026-10-29T00:00:00.000Z', ...extra,
  })
  mkdirSync(path.join(dir, 'data/tg', week), { recursive: true })
  writeFileSync(path.join(dir, 'data/tg', week, 'raw-calls.json'), JSON.stringify([
    call('gemini', { tokenUsage: 2000, inputTokens: 300, outputTokens: 900 }), // 옛 기록 — 생각 800 어림
    call('gemini', { tokenUsage: 1200, inputTokens: 300, outputTokens: 900, thoughtTokens: 0 }), // 새 기록 — 생각 0
    call('openai', { tokenUsage: 1500, inputTokens: 1000, outputTokens: 500 }),
  ]))
  const stats = await getUsageStats(1)
  const w = stats.weeks.find((x) => x.weekOf === week)
  const gem = w?.byEngine.find((r) => r.engine === 'gemini')
  const oai = w?.byEngine.find((r) => r.engine === 'openai')
  ok('집계: Gemini 출력 = 출력 + 생각(900 + 800 + 900)', gem?.outputTokens === 2600)
  ok('집계: 다른 엔진 출력은 그대로', oai?.outputTokens === 500)

  // ── 「같은 조건」: 모델 기록이 바뀌면 수집 모델 바뀜 ──
  const card = (weekOf: string, gemini: string) => ({ weekOf, enginesUsed: ['gemini'], judgeEngine: 'claude', judgeModel: 'claude-sonnet-5-5', modelsUsed: { gemini }, questionBankVersion: 'v1', repeatsPerQuestion: 1 })
  const diffs = compareConditions(card('2026-W44', 'gemini-3.7-flash') as never, card('2026-W45', 'gemini-3.8-flash (thinking low)') as never)
  ok('3.7 → 3.8(생각 낮음)은 수집 모델 바뀜', diffs.some((d) => d.dimension === '수집 모델' && d.state === 'changed'))
  ok('같은 기록끼리는 같은 조건', compareConditions(card('2026-W45', 'gemini-3.8-flash (thinking low)') as never, card('2026-W46', 'gemini-3.8-flash (thinking low)') as never).length === 0)
} finally {
  rmSync(dir, { recursive: true, force: true })
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
