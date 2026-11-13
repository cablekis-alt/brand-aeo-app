'use strict'

/**
 * 자동 업데이트 기록 — 종료 때 설치를 시도한 버전을 userData/update-log.json에 남기고, 다음 시작 때 지금 버전과 견줘
 * 설치가 끝났는지 가른다.
 *
 * 왜 따로 남기나(2026-11-13 원인 분석): electron-updater는 종료 때 설치 파일을 띄우고 pid만 보면 성공으로 친다. Windows
 * 스마트 앱 컨트롤이 서명 없는 설치 파일을 막아도(Code Integrity 3077) 그때는 창이 이미 닫혀 오류를 보일 곳이 없고 로그
 * 파일도 없다 — 사용자는 「껐다 켰는데 버전이 그대로」만 겪는다. 다음 시작 때 버전이 그대로면 그것을 「설치가 끝나지 않음」으로
 * 알린다.
 *
 * 파일 읽기 · 쓰기와 타이머는 main.cjs가 하고, 여기는 판정만 하는 순수 함수다 — scripts/verify-update-log.ts가 검사한다.
 */

/** 기록에 남기는 사건 수 — 오래된 것부터 버린다. */
const MAX_EVENTS = 50
/** 앱이 켜져 있는 동안 새 릴리스를 확인하는 간격. 확인은 원래 앱을 켤 때 한 번뿐이라 켜 둔 동안 나온 릴리스를 못 봤다. */
const CHECK_INTERVAL_MS = 60 * 60 * 1000
/**
 * latest.yml이 아직 없을 때 다시 확인하는 간격 · 횟수. 릴리스가 공개된 뒤 CI가 설치 파일을 올리기까지 몇 분 동안은
 * latest.yml이 없어 확인이 ERR_UPDATER_CHANNEL_FILE_NOT_FOUND로 끝나고 electron-updater는 다시 시도하지 않는다.
 */
const RETRY_DELAY_MS = 5 * 60 * 1000
const MAX_RETRIES = 6
/** 기록에 남기는 오류 문구 길이(스택 전체를 남기지 않는다). */
const MAX_MESSAGE = 300
/**
 * 시도한 지 이만큼이 안 됐으면 버전이 그대로여도 판정을 미룬다. 종료 때 설치 파일은 앱을 다시 띄우지 않고 조용히 돈다 — 앱을 끄자마자
 * 다시 켜면 설치가 끝나기 전(11-08 실측 약 45초, 백신 검사로 더 길어짐)의 옛 버전이 떠서 「설치가 끝나지 않음」으로 잘못 적었다.
 */
const INSTALL_GRACE_MS = 5 * 60 * 1000

function emptyLog() {
  return { pending: null, events: [] }
}

/** 'v0.4.75' · '0.4.75' → [0, 4, 75]. 숫자가 아닌 부분은 0으로 본다(이 앱 버전은 늘 세 자리 숫자다). */
function versionParts(v) {
  return String(v ?? '')
    .trim()
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .slice(0, 3)
    .map((n) => (/^\d+$/.test(n) ? Number(n) : 0))
}

/** a가 b보다 높으면 1, 같으면 0, 낮으면 -1. */
function compareVersions(a, b) {
  const pa = versionParts(a)
  const pb = versionParts(b)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

const isText = (v) => typeof v === 'string' && v.length > 0

/** 남은 시도 기록 하나가 쓸 만한가 — 손으로 고쳤거나 반쯤 쓴 파일이면 버린다. */
function validPending(p) {
  return p && typeof p === 'object' && isText(p.version) && isText(p.fromVersion) && isText(p.at) ? p : null
}

/**
 * 파일 글자 → 기록. 파일이 없으면(text null) 빈 기록이고 문제도 없다. 읽을 수 없는 내용이면 빈 기록으로 시작하되 problem에 까닭을
 * 돌려준다 — 부른 쪽이 로그로 남긴다(조용히 삼키지 않는다).
 */
function parseLog(text) {
  if (text == null || text === '') return { log: emptyLog(), problem: null }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { log: emptyLog(), problem: `update-log.json을 읽지 못해 새로 시작합니다: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.events)) {
    return { log: emptyLog(), problem: 'update-log.json 모양이 달라 새로 시작합니다.' }
  }
  const events = raw.events.filter((e) => e && typeof e === 'object' && isText(e.type) && isText(e.at)).slice(-MAX_EVENTS)
  return { log: { pending: validPending(raw.pending), events }, problem: null }
}

function withEvent(log, event) {
  return { ...log, events: [...log.events, event].slice(-MAX_EVENTS) }
}

/** 사건 하나를 덧붙인다(오래된 것부터 MAX_EVENTS 밖으로). */
function recordEvent(log, event) {
  const e = { ...event }
  if (isText(e.message)) e.message = e.message.slice(0, MAX_MESSAGE)
  return withEvent(log, e)
}

/**
 * 종료 때(또는 「재시작하여 설치」 단추) 설치를 시작한다고 적는다. 같은 버전 시도가 이미 남아 있어도 가장 최근 시도로 바꾼다 — 판정
 * 유예(INSTALL_GRACE_MS)는 마지막 시도부터 센다. 처음 시각을 지키면, 판정을 미룬 뒤 같은 설치 파일로 다시 시도했을 때 첫 시도 시각이
 * 남아 유예가 듣지 않고 설치 중인 것을 「끝나지 않음」으로 적었다. (단추를 누르면 quitAndInstall과 quit이 몇 ms 사이로 둘 다 지나간다.)
 */
function recordAttempt(log, { version, fromVersion, at, via }) {
  const pending = { version, fromVersion, at, via }
  return withEvent({ ...log, pending }, { type: 'install-attempt', version, fromVersion, at, via })
}

/**
 * 시작할 때 — 남은 시도가 있으면 지금 버전과 견준다. 지금 버전이 시도한 버전 이상이면 설치된 것(pending을 지운다), 아래면 설치가
 * 끝나지 않은 것이다(pending을 지우고 failure를 돌려준다). 다만 시도한 지 INSTALL_GRACE_MS가 안 됐으면 아직 설치 중일 수 있어 판정을
 * 미룬다(pending을 그대로 둔다). 같은 설치 파일은 다음 시작 확인에서 다시 받아 둔 것으로 확인되면 종료 때 또 시도한다 — 그 시도는 새로
 * 적힌다.
 */
function judgeOnStart(log, currentVersion, now) {
  const p = log.pending
  if (!p) return { log, failure: null, changed: false }
  const sinceAttempt = Date.parse(now) - Date.parse(p.at)
  if (compareVersions(currentVersion, p.version) < 0 && sinceAttempt >= 0 && sinceAttempt < INSTALL_GRACE_MS) {
    return { log, failure: null, changed: false }
  }
  if (compareVersions(currentVersion, p.version) >= 0) {
    return {
      log: withEvent({ ...log, pending: null }, { type: 'installed', version: p.version, fromVersion: p.fromVersion, attemptedAt: p.at, at: now }),
      failure: null,
      changed: true,
    }
  }
  const failure = { version: p.version, fromVersion: p.fromVersion, attemptedAt: p.at, via: p.via ?? null }
  return {
    log: withEvent(
      { ...log, pending: null },
      { type: 'install-failed', version: p.version, fromVersion: p.fromVersion, currentVersion, attemptedAt: p.at, at: now },
    ),
    failure,
    changed: true,
  }
}

/** latest.yml이 아직 없는 확인 실패인가 — 몇 분 뒤 다시 확인할 가치가 있는 것은 이것뿐이다. */
function isMissingChannelFile(err) {
  if (!err) return false
  if (err.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') return true
  const message = err instanceof Error ? err.message : String(err)
  return /Cannot find latest\.yml/i.test(message)
}

/** n번째(1부터) 다시 확인을 기다릴 시간. 횟수를 넘으면 null — 그다음은 정기 확인에 맡긴다. */
function retryDelay(n) {
  return n >= 1 && n <= MAX_RETRIES ? RETRY_DELAY_MS : null
}

module.exports = {
  CHECK_INTERVAL_MS,
  INSTALL_GRACE_MS,
  MAX_EVENTS,
  MAX_RETRIES,
  RETRY_DELAY_MS,
  compareVersions,
  emptyLog,
  isMissingChannelFile,
  judgeOnStart,
  parseLog,
  recordAttempt,
  recordEvent,
  retryDelay,
}
