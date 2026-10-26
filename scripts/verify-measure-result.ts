/**
 * 측정 결과 알림(상용화 UI 3차 U13)을 확인한다 — 서버의 측정 회차 기록(server/measureTracker.ts · measureAndBake.ts)과 화면의 공용
 * 측정 상태(src/lib/measureStatus.ts: 새로 끝난 회차 가려내기 · 띠 · 알림 문구 · 결과 맡기). 임시 폴더를 APP_DATA_DIR로 쓰고,
 * 측정은 가짜 저장소가 첫 읽기에서 실패하게 해 AI를 부르지 않는다.
 *
 * 왜: 측정이 끝나도 알리는 곳이 측정을 시작한 화면의 문구뿐이라, 다른 화면으로 가면 끝났는지 실패했는지 몰랐다. 알림이 같은 결과를
 * 두 번 알리거나(폴링마다), 앱을 켜자마자 지난 결과를 다시 알리거나, 경쟁사마다 따로 알리면 알림을 믿지 않게 된다.
 *
 *   npx tsx scripts/verify-measure-result.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { TenantConfig } from '../server/types'

const dir = mkdtempSync(path.join(tmpdir(), 'verify-measure-result-'))
process.env.APP_DATA_DIR = dir
process.env.BLOB_READ_WRITE_TOKEN = ''
process.env.BLOB_STORE_ID = ''
process.env.PIPELINE_CRON = ''

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

function fakeTenant(tenantId: string): TenantConfig {
  return {
    tenantId,
    brandName: `가짜 ${tenantId}`,
    aliases: [],
    ownedDomains: [],
    industry: '가짜업종',
    region: '가짜시',
    engines: ['openai'],
    questionBankSize: 36,
    questionBankVersion: 'v1',
    repeatsPerQuestion: 1,
    factGraph: [],
    competitors: [],
    cohortOnly: true,
  } as unknown as TenantConfig
}

try {
  const tracker = await import('../server/measureTracker')
  const { markEarlierCards, measureAndBake } = await import('../server/measureAndBake')
  const { FileResultStore } = await import('../server/store')
  const { CollectionError } = await import('../server/engineExhaustion')
  const view = await import('../src/lib/measureStatus')

  // ── 1) 회차 기록 ────────────────────────────────────────────────
  const boot = tracker.listRunRecords().bootId
  const started = tracker.startRunRecord({ tenantId: 'a', brandName: '가짜 A' })
  ok('시작하면 진행 중 1개 · seq 0', tracker.listRunRecords().current.length === 1 && started.seq === 0 && started.id.startsWith('a@'))
  tracker.updateRunRecord(started.id, { competitors: 5 })
  ok('함께 재는 경쟁사 수를 적는다', tracker.listRunRecords().current[0]?.competitors === 5)
  const finished = tracker.finishRunRecord(started.id, { result: 'done', aeoScore: 12, weekOf: '2026-W43' })
  const after = tracker.listRunRecords()
  ok('끝나면 seq 1 · 진행 중에서 빠진다', finished?.seq === 1 && after.current.length === 0 && after.recent[0]?.seq === 1 && Boolean(after.recent[0]?.endedAt))
  ok('같은 회차를 두 번 끝내지 않는다', tracker.finishRunRecord(started.id, { result: 'failed' }) === null && tracker.listRunRecords().recent.length === 1)
  tracker.updateRunRecord(started.id, { competitors: 9 })
  ok('끝난 회차는 고치지 않는다', tracker.listRunRecords().recent[0]?.competitors === 5)
  const f = tracker.startRunRecord({ tenantId: 'b', brandName: '가짜 B' })
  tracker.finishRunRecord(f.id, { result: 'failed', error: '실패', engineIssues: ['Gemini 지출 한도 초과'] })
  const c = tracker.startRunRecord({ tenantId: 'c', brandName: '가짜 C', selfOnly: true })
  tracker.finishRunRecord(c.id, { result: 'cancelled' })
  const rs = tracker.listRunRecords().recent
  ok('실패 · 멈춤도 남는다(최신 먼저)', rs[0]?.result === 'cancelled' && rs[0].selfOnly === true && rs[1]?.result === 'failed' && rs[1].engineIssues?.[0] === 'Gemini 지출 한도 초과')
  for (let i = 0; i < 12; i += 1) {
    const r = tracker.startRunRecord({ tenantId: `n${i}`, brandName: `가짜 ${i}` })
    tracker.finishRunRecord(r.id, { result: 'done', aeoScore: i })
  }
  ok('최근 10개만 남는다', tracker.listRunRecords().recent.length === 10 && tracker.listRunRecords().recent[0]?.seq === 15)
  ok('bootId는 그대로', tracker.listRunRecords().bootId === boot)

  // ── 2) measureAndBake — 사용자가 시작한 측정만 한 회차(가짜 저장소가 첫 읽기에서 실패해 AI를 부르지 않는다) ──
  const failingStore = (err: () => Error) =>
    new Proxy(
      {},
      {
        get: () => async () => {
          throw err()
        },
      },
    ) as never
  const before = tracker.listRunRecords().recent[0]!.seq
  await measureAndBake(fakeTenant('comp-x'), failingStore(() => new Error('가짜 저장소 오류'))).catch(() => undefined)
  const last = tracker.listRunRecords().recent[0]!
  ok(
    '경쟁사 하나만 잰 측정도 회차 — 실패 · 경쟁사 표시',
    last.seq === before + 1 && last.tenantId === 'comp-x' && last.result === 'failed' && last.competitorOnly === true && last.error === '가짜 저장소 오류',
  )
  ok('끝나면 진행 중이 비고 측정 중 표시도 없다', tracker.listRunRecords().current.length === 0 && !tracker.measureInFlight())
  await measureAndBake(fakeTenant('comp-y'), failingStore(() => new Error('가짜 저장소 오류')), { inCohortRun: true }).catch(() => undefined)
  ok('다른 브랜드 측정 안에서 잰 경쟁사는 따로 적지 않는다', tracker.listRunRecords().recent[0]!.seq === before + 1)
  await measureAndBake(fakeTenant('comp-z'), failingStore(() => new tracker.MeasureCancelledError('comp-z'))).catch(() => undefined)
  ok('멈춘 측정은 cancelled', tracker.listRunRecords().recent[0]?.result === 'cancelled' && tracker.listRunRecords().recent[0]?.tenantId === 'comp-z')
  await measureAndBake(fakeTenant('comp-w'), failingStore(() => new CollectionError('수집 실패', ['Gemini 지출 한도 초과']))).catch(() => undefined)
  ok('끊긴 엔진은 engineIssues로', tracker.listRunRecords().recent[0]?.engineIssues?.[0] === 'Gemini 지출 한도 초과')

  // 실패한 경쟁사가 그래도 순위표에 들었나 — 같은 주에 앞서 잰 카드는 남는다(지운 브랜드 · 다른 주는 아니다).
  const writeHistory = (id: string, weekOf: string) => {
    mkdirSync(path.join(dir, 'data', id), { recursive: true })
    writeFileSync(path.join(dir, 'data', id, 'scorecard-history.json'), JSON.stringify([{ tenantId: id, industry: '가짜업종', region: '가짜시', weekOf, brandName: id }]))
  }
  writeHistory('kept', '2026-W43')
  writeHistory('older', '2026-W42')
  writeHistory('gone', '2026-W43')
  writeFileSync(path.join(dir, 'tenants.deleted.json'), JSON.stringify(['gone']))
  const marked = await markEarlierCards(
    new FileResultStore(),
    ['kept', 'older', 'gone', 'none'].map((id) => ({ tenantId: id, brandName: id })),
    { industry: '가짜업종', region: '가짜시', weekOf: '2026-W43' },
  )
  ok(
    '실패한 경쟁사: 이번 주 앞선 카드가 순위표에 남은 곳만 표시',
    marked.map((f) => `${f.tenantId}:${f.keptEarlierCard ? 'kept' : '-'}`).join() === 'kept:kept,older:-,gone:-,none:-',
  )

  // ── 3) 새로 끝난 회차 가려내기 ──────────────────────────────────────
  const rec = (seq: number, extra: Partial<import('../src/lib/measureStatus').MeasureRunRecord> = {}) => ({
    id: `t${seq}@x`,
    seq,
    tenantId: 'stay',
    brandName: '스테이',
    startedAt: '2026-10-26T01:00:00.000Z',
    endedAt: '2026-10-26T01:09:12.000Z',
    result: 'done' as const,
    aeoScore: 12,
    weekOf: '2026-W43',
    ...extra,
  })
  const runs = (bootId: string, recent: ReturnType<typeof rec>[]) => ({ bootId, current: [], recent })
  const first = view.pickNewOutcomes(null, runs('b1', [rec(3), rec(2)]))
  ok('처음 받은 응답은 기준만(알리지 않는다)', first.fresh.length === 0 && first.seen?.seq === 3)
  const second = view.pickNewOutcomes(first.seen, runs('b1', [rec(4), rec(3), rec(2)]))
  ok('seq 4가 새로 오면 4만', second.fresh.map((r) => r.seq).join() === '4' && second.seen?.seq === 4)
  ok('같은 응답을 또 받으면 다시 알리지 않는다', view.pickNewOutcomes(second.seen, runs('b1', [rec(4), rec(3)])).fresh.length === 0)
  ok('앱을 다시 켰으면(bootId 바뀜) 그 뒤 회차 전부', view.pickNewOutcomes(second.seen, runs('b2', [rec(2), rec(1)])).fresh.length === 2)
  ok('회차 기록이 없는 옛 서버 → 알리지 않고 기준 그대로', view.pickNewOutcomes(second.seen, null).fresh.length === 0 && view.pickNewOutcomes(second.seen, null).seen === second.seen)

  // ── 4) 띠 · 알림 문구 ──────────────────────────────────────────────
  const tenants = [
    { tenantId: 'stay', brandName: '스테이', ownedDomains: ['stay.example'], industry: '숙박', region: '가짜시' },
    { tenantId: 'gak', brandName: '가짜각', ownedDomains: ['gak.example'], industry: '중식', region: '가짜시', marketScope: 'local' },
    { tenantId: 'gak-national', brandName: '가짜각', ownedDomains: ['gak.example'], industry: '중식', region: '국내', marketScope: 'national' },
  ]
  const done = view.outcomeMessage(rec(5), tenants)
  ok('끝: 「스테이 측정 끝 · Brand AEO 12점(100점 만점)」', done.title === '스테이 측정 끝 · Brand AEO 12점(100점 만점)' && done.tone === 'good' && done.primary === 'overview')
  ok('끝: 주차 · 걸린 시간, 증감 없음', done.sub === '2026년 43주차 · 9분 12초 걸림' && !/[+]|전주/.test(done.title + done.sub))
  ok('끝: 알림 「측정 끝 · 스테이」 → 개요', done.notify?.title === '측정 끝 · 스테이' && done.notify.action === 'overview' && done.notify.body.includes('12점'))
  const failed = view.outcomeMessage(rec(6, { result: 'failed', error: '긴 오류', engineIssues: ['Gemini 지출 한도 초과'], tenantId: 'gak-national' }), tenants)
  ok('실패: 이름에 범위 꼬리표 · 끊긴 엔진', failed.title === '가짜각 · 전국형 측정 실패 — Gemini 지출 한도 초과' && failed.tone === 'bad')
  ok('실패: 다시 측정 · 측정 상태 · 알림은 측정 상태로', failed.primary === 'remeasure' && failed.statusLink && failed.notify?.action === 'status' && failed.notify.title === '측정 실패 · 가짜각 · 전국형')
  const cancelled = view.outcomeMessage(rec(7, { result: 'cancelled' }), tenants)
  ok('멈춤: 중립 · 「그대로」 · 10초 뒤 닫힘 · 알림 없음', cancelled.tone === 'neutral' && cancelled.title.includes('그대로') && cancelled.autoCloseMs === 10_000 && cancelled.notify === null)
  const kept = view.outcomeMessage(rec(8, { weekCardKept: '엔진 하나가 빠진 측정이라 이번 주 카드를 덮지 않았습니다' }), tenants)
  ok(
    '그 주 카드를 덮지 않음: 「이번 회차 12점」 · 회차 기록에만 · 알림도 그 주 점수처럼 말하지 않는다',
    kept.title === '스테이 측정 끝 · 이번 회차 12점' &&
      kept.sub.endsWith('이번 측정은 회차 기록에만 남습니다.') &&
      kept.notify?.body === '이번 회차 12점 — 그 주 기록은 그대로입니다. 눌러서 개요 보기',
  )
  const partial = view.outcomeMessage(
    rec(9, {
      competitorFailures: [
        { tenantId: 'x', brandName: '가짜성형외과' },
        { tenantId: 'y', brandName: '아무개성형외과' },
      ],
    }),
    tenants,
  )
  ok(
    '경쟁사 일부 실패: 이름과 「순위는 나머지로」 · 측정 상태',
    partial.sub === '2026년 43주차 · 9분 12초 걸림 · 경쟁사 2곳(가짜성형외과, 아무개성형외과)은 측정 실패 — 순위는 나머지로 매겼습니다' && partial.statusLink,
  )
  const failedTwo = [
    { tenantId: 'x', brandName: '가짜성형외과', keptEarlierCard: true },
    { tenantId: 'y', brandName: '아무개성형외과' },
  ]
  ok(
    '실패한 경쟁사의 앞선 이번 주 기록이 순위에 들어갔으면 그렇게 말한다',
    view.outcomeMessage(rec(11, { competitorFailures: failedTwo }), tenants).sub.endsWith('순위에는 가짜성형외과의 앞서 잰 이번 주 기록을 썼고, 나머지는 빼고 매겼습니다') &&
      view.outcomeMessage(rec(12, { competitorFailures: [failedTwo[0]!] }), tenants).sub.endsWith('— 순위에는 앞서 잰 이번 주 기록을 썼습니다'),
  )
  const comp = view.outcomeMessage(rec(10, { tenantId: 'comp-1', brandName: '바깥성형외과', competitorOnly: true }), tenants)
  ok(
    '경쟁사만 잰 측정: 「(경쟁사)」 · 고객 순위에 반영 · 브랜드 현황',
    comp.title === '바깥성형외과(경쟁사) 측정 끝 · Brand AEO 12점' && comp.sub === '같은 주에 잰 고객 브랜드의 경쟁 순위에 반영됩니다.' && comp.primary === 'brands' && comp.customerId === null,
  )
  ok('실패 이유: 끊긴 엔진 없으면 첫 문장 · 길면 자른다', view.failureReason({ error: '[gemini] 첫 문장입니다. 둘째 문장.' }) === '첫 문장입니다.' && view.failureReason({ error: '가'.repeat(120) }).length === 91)

  // ── 5) 공용 상태 — 폴링 결과로 띠 · 알림 · 결과 맡기 ─────────────────────
  const notes: { title: string; tag?: string }[] = []
  let flashes = 0
  let focused = false
  let payload: unknown = { active: [], failed: [], runs: runs('b9', [rec(1)]) }
  const g = globalThis as Record<string, unknown>
  g.window = { electron: { flashWindow: async () => void (flashes += 1) }, focus: () => undefined }
  g.document = { hasFocus: () => focused }
  g.Notification = Object.assign(
    function (this: unknown, title: string, opts?: { tag?: string }) {
      notes.push({ title, tag: opts?.tag })
    },
    { permission: 'granted' },
  )
  g.fetch = async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
  view.setOutcomeContext({ tenants, onNotificationClick: () => undefined })

  await view.pollMeasureStatusNow()
  ok('첫 폴링: 띠 · 알림 없음', view.getMeasureStatus().band.length === 0 && notes.length === 0 && view.getMeasureStatus().ok)
  payload = { active: [], failed: [], runs: runs('b9', [rec(2, { result: 'failed', tenantId: 'gak' }), rec(1)]) }
  await view.pollMeasureStatusNow()
  ok('창이 뒤에 있으면 띠 + 알림 1번(tag는 회차 id) + 작업 표시줄 깜빡임', view.getMeasureStatus().band.map((r) => r.seq).join() === '2' && notes.length === 1 && notes[0]?.tag === 'measure-t2@x' && flashes === 1)
  ok('새 결과가 오면 doneEpoch가 오른다', view.getMeasureStatus().doneEpoch === 1)
  await view.pollMeasureStatusNow()
  ok('같은 응답을 다시 받아도 다시 알리지 않는다', notes.length === 1 && view.getMeasureStatus().band.length === 1 && view.getMeasureStatus().doneEpoch === 1)
  focused = true
  payload = { active: [], failed: [], runs: runs('b9', [rec(3), rec(2, { result: 'failed', tenantId: 'gak' })]) }
  await view.pollMeasureStatusNow()
  ok('창을 보고 있으면 알림 없이 띠만', notes.length === 1 && view.getMeasureStatus().band.map((r) => r.seq).join() === '3,2')
  const release = view.claimMeasureResult('stay')
  payload = { active: [], failed: [], runs: runs('b9', [rec(4), rec(3)]) }
  await view.pollMeasureStatusNow()
  ok('결과를 맡은 화면을 보고 있으면 띠도 없이 본 것으로', view.getMeasureStatus().band.map((r) => r.seq).join() === '3,2' && view.getMeasureStatus().doneEpoch === 3)
  release()
  payload = { active: [], failed: [], runs: runs('b9', [rec(5), rec(4)]) }
  await view.pollMeasureStatusNow()
  ok('맡은 화면을 떠나면 다시 띠', view.getMeasureStatus().band[0]?.seq === 5)
  view.dismissOutcome('t5@x')
  ok('닫으면 띠에서 빠진다', view.getMeasureStatus().band.map((r) => r.seq).join() === '3,2')
  // 서버를 다시 켜면 seq가 1부터 다시 센다 — 띠 · 알림은 회차 id로 가른다.
  payload = { active: [], failed: [], runs: runs('b10', [rec(1, { id: 'boot2@x', tenantId: 'gak' })]) }
  await view.pollMeasureStatusNow()
  const afterBoot = view.getMeasureStatus().band.map((r) => r.id)
  view.dismissOutcome('boot2@x')
  ok('서버를 다시 켠 뒤 같은 seq여도 다른 회차 — 하나만 닫힌다', afterBoot.join() === 'boot2@x,t3@x,t2@x' && view.getMeasureStatus().band.map((r) => r.id).join() === 't3@x,t2@x')
  ok('측정을 막 시작했으면 30초는 5초 간격 · 측정 중이면 5초 · 아니면 15초', view.pollDelayMs(false, 1_000 + 30_000, 1_000) === 5_000 && view.pollDelayMs(true, 0, 1_000) === 5_000 && view.pollDelayMs(false, 31_000, 31_000) === 15_000)
  g.fetch = async () => new Response('not found', { status: 404 })
  await view.pollMeasureStatusNow()
  ok('라우트가 없으면(웹) ok false', view.getMeasureStatus().ok === false)
} catch (err) {
  console.error(err)
  checks.push(['예외 없이 끝까지 돈다', false])
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
