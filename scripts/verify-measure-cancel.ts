/**
 * 사용자가 멈춘 측정은 오류가 아니다 — 서버가 409 · cancelled로 가르면 화면은 ✗ 없는 안내로 알린다(src/lib/api.ts MeasureCancelled).
 *
 * 왜(2026-10-26 상용화 UI 3차 1-C, U4): 직접 멈춘 측정이 빨간 「✗ 측정을 중단했습니다 (tenant=…)」로 찍혀, 운영자가 무엇이 고장 난
 * 줄 알았다. fetch를 흉내 내 확인한다(서버를 띄우지 않는다).
 *
 *   npx tsx scripts/verify-measure-cancel.ts
 */
import { MeasureCancelled, measureErrorText, measureTenantAll } from '../src/lib/api'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

const reply = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as typeof fetch

async function errorOf(status: number, body: unknown): Promise<unknown> {
  globalThis.fetch = reply(status, body)
  try {
    await measureTenantAll('x')
    return null
  } catch (err) {
    return err
  }
}

const cancelled = await errorOf(409, { error: '측정을 중단했습니다 (tenant=x). 이번 주 데이터는 건드리지 않았습니다.', cancelled: true })
ok('409 · cancelled는 MeasureCancelled', cancelled instanceof MeasureCancelled)
ok('멈춘 측정 안내: ✗ 없이 · 내부 id 없이', measureErrorText(cancelled) === '측정을 멈췄습니다. 이번 주 데이터는 그대로입니다.')
const failed = await errorOf(500, { error: '엔진 응답 없음' })
ok('다른 실패는 그대로 오류(✗ + 서버 문구)', !(failed instanceof MeasureCancelled) && measureErrorText(failed) === '✗ 엔진 응답 없음')
const conflict = await errorOf(409, { error: '이미 측정 중입니다' })
ok('cancelled 없는 409는 오류', !(conflict instanceof MeasureCancelled) && measureErrorText(conflict) === '✗ 이미 측정 중입니다')
ok('Error가 아닌 값은 기본 문구', measureErrorText('x') === '✗ 측정 실패')

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
