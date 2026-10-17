/**
 * 다시 시도해도 풀리지 않는 엔진 오류(지출 한도 · 크레딧 · 일일 한도 · 키)를 가려 바로 끊는지 확인한다
 * (server/engineExhaustion.ts · engines/retry.ts · pipeline.ts collectRawCalls · measureAndBake 실패 기록).
 * 임시 폴더를 APP_DATA_DIR로 쓰고 가짜 엔진만 부른다 — MOCK_ENGINE_FAIL로 Gemini가 실제와 같은 문구의 지출 한도 오류를 낸다.
 *
 * 왜: 2026-10-17 Gemini 월 지출 한도가 찼을 때 재시도 규칙이 그 문구를 몰라 실패할 호출을 하나하나 다시 시도했고,
 * 화면에는 「수집이 너무 적어 중단」과 실패 건수만 남아 무엇을 고칠지 알 수 없었다.
 *
 *   npx tsx scripts/verify-engine-exhaustion.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'verify-engine-exhaustion-'))
process.env.APP_DATA_DIR = dir
process.env.BLOB_READ_WRITE_TOKEN = ''
process.env.BLOB_STORE_ID = ''
process.env.USE_MOCK_ENGINES = 'true'
process.env.COLLECT_ENGINES = 'openai,gemini,perplexity'
// 한 번에 세 호출 — 질문 하나의 세 엔진이 함께 나간다. 막힌 Gemini는 곧바로 실패하고 나머지는 날아가는 중이라,
// 그 사이 「보내지 않음」 · 「중단」을 확인할 틈이 생긴다.
process.env.COLLECTION_CONCURRENCY = '3'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])
const writeJson = (rel: string, value: unknown) => {
  const file = path.join(dir, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value))
}

const GEMINI_SPEND_CAP =
  '{"error":{"code":429,"message":"Your project has exceeded its monthly spending cap. Please go to AI Studio at https://ai.studio/spend to manage your project spend cap.","status":"RESOURCE_EXHAUSTED"}}'

try {
  const ex = await import('../server/engineExhaustion')
  const { withOpenAiRetry } = await import('../server/engines/retry')

  // 1) 오류 가리기 — 분당 한도 · 시간 초과는 일시적(재시도), 나머지는 끊는다
  ok('Gemini 월 지출 한도', ex.classifyEngineError(GEMINI_SPEND_CAP) === 'spend-cap')
  ok('OpenAI 크레딧(insufficient_quota)', ex.classifyEngineError('429 You exceeded your current quota, please check your plan and billing details.') === 'credits')
  ok('Claude 크레딧 잔액 부족', ex.classifyEngineError('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}') === 'credits')
  ok('Gemini 분당 한도는 일시적', ex.classifyEngineError('429 You exceeded your current quota. Quota exceeded for metric: generate_content_free_tier_requests, limit: 15 per minute') === null)
  ok('Gemini 일일 한도', ex.classifyEngineError('429 RESOURCE_EXHAUSTED Quota exceeded for quota metric GenerateRequestsPerDayPerProjectPerModel') === 'daily')
  ok('키 오류(401)', ex.classifyEngineError('401 Incorrect API key provided') === 'auth')
  ok('키 오류(Gemini JSON 403)', ex.classifyEngineError('{"error":{"code":403,"message":"Method doesn\'t allow unregistered callers.","status":"PERMISSION_DENIED"}}') === 'auth')
  ok('토큰 수 403이 든 분당 한도는 키 오류가 아니다', ex.classifyEngineError('429 Rate limit reached for gpt-6-luna in organization org-x on tokens per min (TPM): Limit 30000, Used 29800, Requested 403. Please try again in 806ms.') === null)
  ok('Used 401이 든 분당 요청 한도도 일시적', ex.classifyEngineError('429 Rate limit reached for gpt-6-luna on requests per min (RPM): Limit 500, Used 401, Requested 1.') === null)
  ok('OpenAI 일일 토큰 한도(TPD)', ex.classifyEngineError('429 Rate limit reached for gpt-6-luna on tokens per day (TPD): Limit 90000, Used 90000, Requested 500.') === 'daily')
  ok('Claude 작업공간 사용 한도', ex.classifyEngineError('400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC."}}') === 'spend-cap')
  ok('Gemini 선불 크레딧 소진', ex.classifyEngineError('{"error":{"code":429,"message":"Your prepayment credits are depleted. Please go to AI Studio to manage your project and billing.","status":"RESOURCE_EXHAUSTED"}}') === 'credits')
  ok('그냥 429는 일시적', ex.classifyEngineError('429 Too Many Requests') === null)
  ok('시간 초과는 일시적', ex.classifyEngineError('Gemini request timeout after 90000ms') === null)
  ok('화면 이름', ex.exhaustionLabel('gemini', 'spend-cap') === 'Gemini 지출 한도 초과')
  ok('고칠 곳 안내', ex.exhaustionHint('gemini', 'spend-cap').includes('ai.studio/spend'))

  // 2) 재시도 — 지출 한도는 한 번에 포기, 일시적인 429는 다시 시도
  let tries = 0
  await withOpenAiRetry(async () => {
    tries += 1
    throw new Error(GEMINI_SPEND_CAP)
  }, 3).catch(() => undefined)
  ok('지출 한도는 다시 시도하지 않는다', tries === 1)
  tries = 0
  await withOpenAiRetry(async () => {
    tries += 1
    throw new Error('429 Too Many Requests')
  }, 2).catch(() => undefined)
  ok('일시적인 429는 다시 시도한다', tries === 2)

  // 3) 측정 — Gemini가 지출 한도로 끊기면 남은 Gemini 호출은 보내지 않고, 실패 문구 맨 앞에 고칠 곳을 붙인다
  const { measureAndBake } = await import('../server/measureAndBake')
  const tracker = await import('../server/measureTracker')
  const { FileResultStore } = await import('../server/store')
  const store = new FileResultStore()
  // 질문 6개를 미리 둔다 — 가짜 엔진은 질문을 만들지 못한다. 첫 Gemini 실패 뒤에 보내지 않을 Gemini 호출이 남게.
  const base = { engines: ['openai', 'gemini', 'perplexity'], questionBankSize: 6, questionBankVersion: 'v3', repeatsPerQuestion: 1, factGraph: [] }
  writeJson('data/vbrand/question-bank/v3.json', {
    version: 'v3',
    generatedAt: '2026-10-17T00:00:00.000Z',
    questions: Array.from({ length: 6 }, (_, i) => ({
      questionId: `v3-00${i + 1}`, text: `가상시 여행 정보 사이트 추천 ${i + 1}`, category: 'category-agnostic',
      industry: '여행 정보', region: '가상시', containsBrandName: false, version: 'v3',
    })),
  })
  writeJson('tenants.overlay.json', [
    { ...base, tenantId: 'vbrand', brandName: '가상 여행', aliases: ['가상 여행'], ownedDomains: ['vbrand.example'], industry: '여행 정보', region: '가상시',
      competitors: [{ name: '가상 관광', aliases: ['가상 관광'], domains: [] }], autoCohort: false },
  ])
  const reg = await import('../server/tenantRegistry')
  const tenant = (await reg.loadRuntimeTenants()).find((t) => t.tenantId === 'vbrand')!

  process.env.MOCK_ENGINE_FAIL = 'gemini:spend-cap'
  // 호출마다 잠깐 기다리게 해 진행 중 상태를 엿본다 — 끊긴 엔진이 진행 표시에 바로 붙는지.
  process.env.MOCK_ENGINE_DELAY_MS = '20'
  const seenLive = new Set<string>()
  const peek = setInterval(() => {
    for (const a of tracker.listActiveMeasures()) for (const issue of a.engineIssues ?? []) seenLive.add(issue)
  }, 5)
  let message = ''
  try {
    await measureAndBake(tenant, store)
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
  } finally {
    clearInterval(peek)
    delete process.env.MOCK_ENGINE_DELAY_MS
  }
  ok('진행 중에 끊긴 엔진이 바로 보인다', [...seenLive].join() === 'Gemini 지출 한도 초과')
  ok('3개 엔진 중 Gemini가 끊기면 수집이 모자라 측정이 멈춘다', message.length > 0)
  ok('실패 문구 맨 앞에 무엇을 고칠지', message.startsWith('Gemini 지출 한도 초과 — Google AI Studio(ai.studio/spend)'))
  ok('남은 Gemini 호출은 보내지 않았다', /남은 호출 \d+건은 보내지 않았습니다/.test(message))
  ok('남은 엔진으로 하한에 못 미치면 다른 엔진 호출도 멈춘다', /수집 하한\(70%\)에 못 미쳐 측정을 멈췄습니다 \(다른 엔진의 남은 호출 \d+건도/.test(message))
  ok('이번 주 카드를 쓰지 않았다', (await store.getScorecardHistory('vbrand', 9)).length === 0)
  const failed = tracker.listMeasureFailures()
  ok('측정 상태 화면의 「실패」 줄', failed[0]?.tenantId === 'vbrand' && failed[0]?.engineIssues?.join() === 'Gemini 지출 한도 초과')
  await measureAndBake(tenant, store).catch(() => undefined)
  ok('같은 곳이 다시 실패해도 줄은 하나', tracker.listMeasureFailures().filter((f) => f.tenantId === 'vbrand').length === 1)

  // 4) 엔진이 넷이면 하나가 끊겨도 75%라 측정은 되고, 성공하면 그 브랜드의 실패 줄은 지운다
  process.env.COLLECT_ENGINES = 'openai,gemini,perplexity,claude'
  let seenStop = false
  const watchStop = setInterval(() => {
    if (tracker.listActiveMeasures().some((a) => a.collectionWillFail)) seenStop = true
  }, 1)
  const result = await measureAndBake({ ...tenant, engines: ['openai', 'gemini', 'perplexity', 'claude'] }, store).finally(() =>
    clearInterval(watchStop),
  )
  const card = (await store.getScorecardHistory('vbrand', 9)).at(-1)
  ok('넷 중 하나가 끊겨도 측정은 된다', result.ok && card?.enginesUsed?.includes('gemini') === false)
  ok('성공하면 실패 줄을 지운다', !tracker.listMeasureFailures().some((f) => f.tenantId === 'vbrand'))
  ok('넷 중 하나는 하한에 닿을 수 있어 멈추지 않는다', !seenStop)

  // 5) 엔진이 끊긴 뒤 누른 「중단」은 실패가 아니라 중단이다 — 끊긴 엔진의 일감이 곧바로 끝나 큐가 비어도
  process.env.COLLECT_ENGINES = 'openai,gemini,perplexity'
  process.env.MOCK_ENGINE_DELAY_MS = '300'
  let cancelSent = false
  const canceller = setInterval(() => {
    if (!cancelSent && tracker.listActiveMeasures().some((a) => a.engineIssues?.length)) {
      tracker.requestCancelActiveMeasures()
      cancelSent = true
    }
  }, 5)
  let cancelled = false
  try {
    await measureAndBake(tenant, store)
  } catch (err) {
    cancelled = err instanceof tracker.MeasureCancelledError
  } finally {
    clearInterval(canceller)
    delete process.env.MOCK_ENGINE_DELAY_MS
  }
  ok('엔진이 끊긴 뒤의 「중단」은 중단으로 끝난다', cancelSent && cancelled)
  ok('중단은 「실패」 줄로 남지 않는다', !tracker.listMeasureFailures().some((f) => f.tenantId === 'vbrand'))
} finally {
  delete process.env.MOCK_ENGINE_FAIL
  rmSync(dir, { recursive: true, force: true })
}

let failedCount = 0
for (const [label, pass] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${label}`)
  if (!pass) failedCount += 1
}
if (failedCount > 0) {
  console.error(`\n${failedCount}건 실패`)
  process.exit(1)
}
console.log(`\n모두 통과 (${checks.length}건)`)
