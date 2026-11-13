/**
 * 자동 업데이트 기록(electron/updateLog.cjs)을 확인한다 — 종료 때 설치 시도를 적고, 다음 시작 때 버전으로 설치가 끝났는지 가르고,
 * latest.yml이 아직 없을 때만 다시 확인하는지. 앱 · 파일 · 네트워크 없이 돈다.
 *
 *   npx tsx scripts/verify-update-log.ts
 */
import { createRequire } from 'node:module'

type Pending = { version: string; fromVersion: string; at: string; via?: string }
type Event = { type: string; at: string; [k: string]: unknown }
type Log = { pending: Pending | null; events: Event[] }
interface UpdateLogModule {
  CHECK_INTERVAL_MS: number
  INSTALL_GRACE_MS: number
  MAX_EVENTS: number
  MAX_RETRIES: number
  RETRY_DELAY_MS: number
  compareVersions: (a: string, b: string) => number
  emptyLog: () => Log
  isMissingChannelFile: (err: unknown) => boolean
  judgeOnStart: (log: Log, currentVersion: string, now: string) => { log: Log; failure: null | Record<string, unknown>; changed: boolean }
  parseLog: (text: string | null) => { log: Log; problem: string | null }
  recordAttempt: (log: Log, a: { version: string; fromVersion: string; at: string; via: string }) => Log
  recordEvent: (log: Log, e: Event) => Log
  retryDelay: (n: number) => number | null
}

const u = createRequire(import.meta.url)('../electron/updateLog.cjs') as UpdateLogModule

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

// ── 버전 비교 ──
ok(
  '버전 비교 — 자리마다 숫자로(0.4.10 > 0.4.9), v 머리 · 같음',
  u.compareVersions('0.4.10', '0.4.9') === 1 &&
    u.compareVersions('0.4.9', '0.4.10') === -1 &&
    u.compareVersions('v0.4.75', '0.4.75') === 0 &&
    u.compareVersions('1.0.0', '0.99.99') === 1,
)

// ── 기록 읽기 ──
ok('파일이 없으면 빈 기록 · 문제 없음', (() => {
  const r = u.parseLog(null)
  return r.problem === null && r.log.pending === null && r.log.events.length === 0
})())
ok('깨진 파일이면 빈 기록으로 시작하고 까닭을 돌려줌(조용히 삼키지 않음)', (() => {
  const r = u.parseLog('{not json')
  return r.problem !== null && r.problem.includes('update-log.json') && r.log.pending === null
})())
ok('모양이 다른 파일 · 반쯤 쓴 시도 기록은 버림', (() => {
  const a = u.parseLog('[]')
  const b = u.parseLog(JSON.stringify({ pending: { version: '0.4.76' }, events: [{ type: 'x', at: 't' }, null, { at: 'no-type' }] }))
  return a.problem !== null && b.problem === null && b.log.pending === null && b.log.events.length === 1
})())

// ── 설치 시도 → 다음 시작 판정 ──
const tried = u.recordAttempt(u.emptyLog(), { version: '0.4.76', fromVersion: '0.4.75', at: '2026-11-13T10:00:00Z', via: 'quit' })
ok('시도를 적으면 pending과 사건이 남음', tried.pending?.version === '0.4.76' && tried.events.at(-1)?.type === 'install-attempt')
const again = u.recordAttempt(tried, { version: '0.4.76', fromVersion: '0.4.75', at: '2026-11-13T10:00:05Z', via: 'quit' })
ok('같은 버전 시도가 또 오면 가장 최근 시도로(유예는 마지막 시도부터 셈) · 사건은 둘 다 남음', again.pending?.at === '2026-11-13T10:00:05Z' && again.events.length === 2)
const newer = u.recordAttempt(tried, { version: '0.4.77', fromVersion: '0.4.75', at: '2026-11-14T10:00:00Z', via: 'button' })
ok('더 새 버전 시도는 pending을 바꿈', newer.pending?.version === '0.4.77' && newer.pending?.via === 'button')

const failed = u.judgeOnStart(tried, '0.4.75', '2026-11-13T10:05:00Z')
ok(
  '다음 시작 때 버전이 그대로면 「설치가 끝나지 않음」 — failure를 돌려주고 pending을 지움',
  failed.changed && failed.failure?.version === '0.4.76' && failed.failure?.fromVersion === '0.4.75' && failed.log.pending === null &&
    failed.log.events.at(-1)?.type === 'install-failed',
)
const installed = u.judgeOnStart(tried, '0.4.76', '2026-11-13T10:05:00Z')
ok('버전이 올라갔으면 설치됨 — failure 없음 · pending 지움', installed.changed && installed.failure === null && installed.log.pending === null && installed.log.events.at(-1)?.type === 'installed')
ok('어떤 길로든(asar 교체로 더 높게) 그 버전 이상이면 설치됨', u.judgeOnStart(tried, '0.4.80', 'now').failure === null)
const soon = u.judgeOnStart(tried, '0.4.75', '2026-11-13T10:02:00Z')
ok(
  `시도한 지 ${u.INSTALL_GRACE_MS / 60000}분 안에 다시 켜면(아직 설치 중일 수 있음) 판정을 미루고 pending을 그대로 둠`,
  !soon.changed && soon.failure === null && soon.log.pending?.version === '0.4.76' && u.INSTALL_GRACE_MS === 5 * 60 * 1000,
)
ok('그 안이라도 버전이 올라갔으면 바로 설치됨', u.judgeOnStart(tried, '0.4.76', '2026-11-13T10:01:00Z').log.events.at(-1)?.type === 'installed')
ok('미룬 뒤 시간이 지나 다시 켜면 그때 「설치가 끝나지 않음」', u.judgeOnStart(soon.log, '0.4.75', '2026-11-13T10:06:00Z').failure?.version === '0.4.76')
// 재검토에서 나온 경우: 10:00 시도 → 10:01 다시 켬(미룸) → 그 세션이 같은 설치 파일을 다시 확인해 12:00 종료 때 또 시도 → 20초 뒤 다시 켬.
const retried = u.recordAttempt(soon.log, { version: '0.4.76', fromVersion: '0.4.75', at: '2026-11-13T12:00:00Z', via: 'quit' })
const reopened = u.judgeOnStart(retried, '0.4.75', '2026-11-13T12:00:20Z')
ok('미룬 뒤 같은 버전으로 다시 시도하고 곧바로 켜도 유예가 들음(첫 시도 시각으로 잘못 판정하지 않음)', !reopened.changed && reopened.failure === null && reopened.log.pending?.at === '2026-11-13T12:00:00Z')
const idle = u.judgeOnStart(u.emptyLog(), '0.4.75', 'now')
ok('남은 시도가 없으면 바꾸지 않음(파일을 쓰지 않음)', !idle.changed && idle.failure === null)
ok('한 번 판정한 실패는 다음 시작 때 다시 알리지 않음', u.judgeOnStart(failed.log, '0.4.75', 'later').failure === null)
ok('저장 · 다시 읽기를 거쳐도 같은 판정', (() => {
  const back = u.parseLog(JSON.stringify(tried)).log
  return u.judgeOnStart(back, '0.4.75', 'now').failure?.version === '0.4.76'
})())

// ── 사건 수 · 문구 길이 ──
let many = u.emptyLog()
for (let i = 0; i < u.MAX_EVENTS + 20; i++) many = u.recordEvent(many, { type: 'error', at: `t${i}`, message: 'x'.repeat(1000) })
ok(
  `사건은 최근 ${u.MAX_EVENTS}개만 · 오류 문구는 300자까지`,
  many.events.length === u.MAX_EVENTS && many.events[0]?.at === 't20' && String(many.events.at(-1)?.message).length === 300,
)

// ── 다시 확인 ──
const channelErr = Object.assign(new Error('Cannot find latest.yml in the latest release artifacts (https://github.com/x/y/releases/download/v0.4.76/latest.yml): HttpError: 404'), {
  code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
})
ok('latest.yml이 아직 없는 확인 실패만 다시 확인(코드 · 문구 둘 다)', u.isMissingChannelFile(channelErr) && u.isMissingChannelFile(new Error('Cannot find latest.yml in the latest release artifacts')))
ok(
  '그 밖의 실패(네트워크 · 버전 없음 · 서명)는 다시 확인하지 않음',
  !u.isMissingChannelFile(Object.assign(new Error('net::ERR_INTERNET_DISCONNECTED'), { code: 'ERR_NETWORK' })) &&
    !u.isMissingChannelFile(Object.assign(new Error('Unable to find latest version on GitHub'), { code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' })) &&
    !u.isMissingChannelFile(null),
)
ok(
  `다시 확인은 ${u.RETRY_DELAY_MS / 60000}분 뒤 · ${u.MAX_RETRIES}번까지, 그다음은 정기 확인(${u.CHECK_INTERVAL_MS / 3600000}시간)`,
  u.retryDelay(1) === 5 * 60 * 1000 && u.retryDelay(u.MAX_RETRIES) === 5 * 60 * 1000 && u.retryDelay(u.MAX_RETRIES + 1) === null && u.retryDelay(0) === null &&
    u.CHECK_INTERVAL_MS === 60 * 60 * 1000 && u.MAX_RETRIES === 6,
)

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
