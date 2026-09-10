// Web4AI Brand AEO — Electron 데스크톱 셸 (최소 스캐폴딩, 개발 모드)
//
// 목적: 한국 리전 로컬 PC에서 정확한 측정을 돌리기 위한 데스크톱 껍데기.
// 웹(Vercel)과 동일한 React UI + 로컬 Express API(server/index.ts)를 한 창에서 띄운다.
//
// 개발 모드 동작:
//   1) 로컬 API 서버(tsx server/index.ts, :4000)를 자식 프로세스로 띄운다.
//   2) vite 개발 서버(npm run dev, :5173)를 자식 프로세스로 띄운다(/api는 :4000으로 프록시).
//   3) vite가 준비되면 BrowserWindow가 그 URL을 로드한다.
//
// 패키징(electron-builder + 정적 dist 서빙 + 컴파일된 서버)은 다음 단계 — electron/README.md 참고.

const { app, BrowserWindow, Menu, MenuItem, ipcMain, shell, utilityProcess } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')

const IS_WINDOWS = process.platform === 'win32'
const API_PORT = process.env.PORT || '4000'
const DEV_SERVER_URL = process.env.DEV_SERVER_URL || 'http://localhost:5173'
const PROJECT_ROOT = path.resolve(__dirname, '..')

/** 업데이트 상태를 렌더러로 보낼 때 쓰는 현재 창 참조. */
let mainWindow = null

/** 자식 프로세스 핸들 — 종료 시 정리한다. */
const children = []

function spawnChild(command, args, label) {
  // Windows에서 npm/npx는 .cmd 셸을 거쳐야 하므로 shell:true로 실행한다.
  const child = spawn(command, args, {
    cwd: PROJECT_ROOT,
    shell: IS_WINDOWS,
    env: { ...process.env, PORT: API_PORT },
    stdio: 'pipe',
  })
  child.stdout.on('data', (d) => process.stdout.write(`[${label}] ${d}`))
  child.stderr.on('data', (d) => process.stderr.write(`[${label}] ${d}`))
  child.on('exit', (code) => console.log(`[${label}] exited (code ${code})`))
  children.push(child)
  return child
}

function killChildren() {
  for (const child of children) {
    if (child.exitCode === null) {
      try {
        child.kill()
      } catch {
        /* 이미 종료 */
      }
    }
  }
  stopServerProcess()
}

// ── 번들 서버(utilityProcess) ────────────────────────────────────────────
// 서버를 메인 프로세스에서 require하면 측정(수집·판정 각 8병렬, 브랜드당 60~140초)이 메인의
// 이벤트 루프를 포화시켜 창 입력이 멈춘다 — 네이티브 <select> 팝업은 메인이 그리므로 브랜드
// 드롭다운이 측정 내내 "안 눌리는" 상태가 된다. 그래서 별도 프로세스로 분리한다.
let serverProcess = null
let serverExit = null // { code } — 헬스체크 실패 시 원인 표시용
const serverLog = [] // stderr/stdout 최근 줄(기동 실패 진단용)

function rememberServerLog(chunk) {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (!line.trim()) continue
    serverLog.push(line)
    if (serverLog.length > 40) serverLog.shift()
  }
}

function startServerProcess(env) {
  const entry = path.join(__dirname, 'server-entry.cjs')
  const child = utilityProcess.fork(entry, [], {
    serviceName: 'brand-aeo-api',
    env,
    stdio: 'pipe',
  })
  child.stdout?.on('data', (d) => {
    rememberServerLog(d)
    process.stdout.write(`[api] ${d}`)
  })
  child.stderr?.on('data', (d) => {
    rememberServerLog(d)
    process.stderr.write(`[api] ${d}`)
  })
  child.on('exit', (code) => {
    serverExit = { code }
    serverProcess = null
    console.log(`[api] utilityProcess 종료 (code ${code})`)
  })
  serverProcess = child
  return child
}

function stopServerProcess() {
  if (!serverProcess) return
  try {
    serverProcess.kill()
  } catch {
    /* 이미 종료 */
  }
  serverProcess = null
}

/** 앱에서 바꾼 API 키를 서버 프로세스에 전달한다(프로세스가 분리돼 env가 자동 공유되지 않는다). */
function sendEnvToServer(name, value) {
  if (!serverProcess) return false
  try {
    serverProcess.postMessage({ type: 'set-env', name, value })
    return true
  } catch {
    return false
  }
}

/**
 * 포트가 이미 점유돼 있는지 "연결"로 판별한다.
 *
 * 바인딩 시도로 검사하면 안 된다 — 127.0.0.1에만 바인딩해 보면 모든 인터페이스(::)에 붙은
 * 다른 프로세스와의 충돌을 놓치고, Windows에서는 두 프로세스가 같은 포트를 동시에 바인딩하는
 * 경우까지 있다. 우리가 알고 싶은 것은 "localhost:port에 이미 응답하는 소켓이 있는가"이고,
 * 그건 앱이 나중에 접속할 대상과 정확히 같은 조건이므로 연결로 확인한다.
 */
function isPortOccupied(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port: Number(port), host: 'localhost' })
    const finish = (occupied) => {
      sock.destroy()
      resolve(occupied)
    }
    sock.setTimeout(1000)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false)) // ECONNREFUSED = 비어 있음
  })
}

/** OS가 배정한 빈 포트를 얻는다. 0이면 실패. */
function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(0))
    srv.listen(0, () => {
      const chosen = srv.address().port
      srv.close(() => resolve(chosen))
    })
  })
}

/**
 * 인프로세스 서버가 쓸 포트를 고른다.
 *
 * 기본 포트를 다른 프로세스(개발용 dev 서버 등)가 점유하면, 예전에는 우리 서버가 바인딩에
 * 실패해도 /health가 그 남의 서버로 응답해 앱이 조용히 그쪽을 로드했다(정적 UI가 없어
 * "Cannot GET /"). 이제 미리 빈 포트를 찾아 충돌 자체를 피한다.
 */
async function pickApiPort(preferred) {
  const wanted = Number(preferred) || 4000
  if (!(await isPortOccupied(wanted))) return String(wanted)
  const free = await freePort()
  if (free) {
    console.warn(`[server] :${wanted}이 이미 사용 중 — :${free}으로 대체합니다.`)
    return String(free)
  }
  return String(wanted)
}

/**
 * 해당 포트의 서버가 '우리 인프로세스 서버'인지 서명(servesUi)으로 확인한다.
 * 'ok' = 우리 서버 · 'foreign' = 응답은 오지만 남의 서버 · 'timeout' = 무응답.
 */
async function waitForOwnServer(port, timeoutMs = 30000) {
  const start = Date.now()
  let sawForeign = false
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/health`)
      if (res.ok) {
        const body = await res.json().catch(() => null)
        if (body && body.servesUi === true) return 'ok'
        sawForeign = true // 응답은 오는데 UI를 서빙하지 않는 서버 = 우리 것이 아니다
      }
    } catch {
      /* 아직 안 뜸 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return sawForeign ? 'foreign' : 'timeout'
}

/** URL이 200을 줄 때까지 폴링한다(vite 준비 대기). */
async function waitForUrl(url, timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: 'HEAD' })
      if (res.ok || res.status === 200) return true
    } catch {
      /* 아직 안 뜸 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    title: 'Web4AI Brand AEO',
    icon: path.join(__dirname, 'build', 'icon.png'), // dev 창/작업표시줄 아이콘(패키징은 exe에 내장)
    backgroundColor: '#f4f1ea',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, // 렌더러와 Node 격리(보안)
      nodeIntegration: false, // 렌더러에서 Node 직접 접근 차단
      sandbox: false, // preload에서 contextBridge 쓰기 위해
    },
  })
  mainWindow = win

  // 렌더러 안의 외부 링크(GitHub Actions 로그 등)는 기본 브라우저로 연다.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) {
      void shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  // 우클릭 컨텍스트 메뉴 — Electron은 기본 제공하지 않으므로 직접 붙인다(입력창 복사/붙여넣기 등).
  win.webContents.on('context-menu', (_e, params) => {
    const { editFlags, isEditable, selectionText } = params
    const menu = new Menu()
    if (isEditable) {
      menu.append(new MenuItem({ label: '실행 취소', role: 'undo', enabled: editFlags.canUndo }))
      menu.append(new MenuItem({ label: '다시 실행', role: 'redo', enabled: editFlags.canRedo }))
      menu.append(new MenuItem({ type: 'separator' }))
      menu.append(new MenuItem({ label: '잘라내기', role: 'cut', enabled: editFlags.canCut }))
      menu.append(new MenuItem({ label: '복사', role: 'copy', enabled: editFlags.canCopy }))
      menu.append(new MenuItem({ label: '붙여넣기', role: 'paste', enabled: editFlags.canPaste }))
      menu.append(new MenuItem({ label: '모두 선택', role: 'selectAll' }))
    } else if (selectionText && selectionText.trim()) {
      menu.append(new MenuItem({ label: '복사', role: 'copy' }))
      menu.append(new MenuItem({ label: '모두 선택', role: 'selectAll' }))
    }
    if (menu.items.length) menu.popup({ window: win })
  })

  if (!app.isPackaged) {
    // 개발: API + vite 자식 프로세스 기동 → vite 준비되면 로드.
    spawnChild(IS_WINDOWS ? 'npx.cmd' : 'npx', ['tsx', 'server/index.ts'], 'api')
    spawnChild(IS_WINDOWS ? 'npm.cmd' : 'npm', ['run', 'dev'], 'vite')
    const ready = await waitForUrl(DEV_SERVER_URL)
    if (ready) {
      await win.loadURL(DEV_SERVER_URL)
      win.webContents.openDevTools({ mode: 'detach' })
    } else {
      await win.loadURL(
        'data:text/html,' +
          encodeURIComponent(
            '<h2 style="font-family:sans-serif;padding:2rem">vite 개발 서버(:5173)를 기다리다 시간 초과했습니다.</h2>' +
              '<p style="font-family:sans-serif;padding:0 2rem">터미널 로그를 확인하세요.</p>',
          ),
      )
    }
    return
  }

  // 패키징: vite 없이 번들된 서버(dist-electron/server.cjs)를 별도 프로세스(utilityProcess)로
  // 띄우고, 그 서버가 dist(정적 UI)+/api를 같은 오리진(:4000)에서 서빙한다. 창은 그 URL을 로드.
  // 메인에서 require하지 않는 이유는 startServerProcess()의 주석 참고(측정 중 UI 멈춤).
  loadEnvForPackaged()
  // 로컬(한국) 측정은 Gemini grounding이 기준 — judge/수집 기본을 Gemini로(OpenAI 크레딧 비의존).
  // .env에서 명시하면 그 값을 존중한다. CI(measure.yml)의 기본값과 일치.
  if (!process.env.JUDGE_ENGINE) process.env.JUDGE_ENGINE = 'gemini'
  if (!process.env.GEMINI_MODEL) process.env.GEMINI_MODEL = 'gemini-3.7-flash'
  // 기본 포트가 점유돼 있으면 빈 포트로 대체한다 — 남의 서버에 붙는 사고를 원천 차단.
  const apiPort = await pickApiPort(API_PORT)
  // 서버 프로세스에 넘길 환경 — 프로세스가 분리되므로 여기서 명시적으로 전달해야 한다.
  // (loadEnvForPackaged()가 메인의 process.env에 올려둔 API 키도 이 스프레드로 함께 간다.)
  const serverEnv = {
    ...process.env,
    PORT: apiPort,
    ELECTRON_STATIC_DIR: path.join(__dirname, '..', 'dist'), // asar 내부 dist
    // 측정 데이터·오버레이·큐는 쓰기 가능한 userData로(asar은 읽기전용). server/appPaths.ts가 참조.
    APP_DATA_DIR: app.getPath('userData'),
    // 첫 실행 시드 소스 — asar에 동봉된 커밋 데이터(src/data).
    SEED_DATA_DIR: path.join(__dirname, '..', 'src', 'data'),
  }
  console.log('[data] APP_DATA_DIR =', serverEnv.APP_DATA_DIR)
  try {
    startServerProcess(serverEnv)
  } catch (err) {
    await win.loadURL(
      'data:text/html,' +
        encodeURIComponent(`<h2 style="font-family:sans-serif;padding:2rem">서버 기동 실패</h2><pre style="padding:0 2rem">${String(err)}</pre>`),
    )
    return
  }
  // 그 포트의 서버가 정말 우리 것인지 서명으로 확인한다(servesUi). 남의 서버면 로드하지 않는다.
  const health = await waitForOwnServer(apiPort)
  if (health === 'ok') {
    await win.loadURL(`http://localhost:${apiPort}`)
  } else {
    // 서버 프로세스가 죽었으면 그 사실과 마지막 로그를 보여준다(인프로세스일 때는 예외로 잡혔지만
    // 별도 프로세스는 조용히 종료될 수 있어, 원인을 화면에 남겨야 진단이 된다).
    const crashed = serverExit !== null
    const detail = crashed
      ? `로컬 서버 프로세스가 시작 직후 종료됐습니다(code ${serverExit.code}).`
      : health === 'foreign'
        ? `포트 ${apiPort}을 다른 프로그램이 사용하고 있어 앱 화면을 열 수 없습니다.` +
          ` 개발용 서버(npm run server:dev)가 떠 있으면 종료한 뒤 앱을 다시 실행하세요.`
        : `로컬 서버(:${apiPort}) 시작을 기다리다 시간이 초과됐습니다.`
    const logTail = serverLog.length > 0 ? `<pre style="padding:0 2rem;white-space:pre-wrap">${serverLog.slice(-12).join('\n')}</pre>` : ''
    await win.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          `<h2 style="font-family:sans-serif;padding:2rem">앱을 시작할 수 없습니다</h2>` +
            `<p style="font-family:sans-serif;padding:0 2rem;line-height:1.6">${detail}</p>${logTail}`,
        ),
    )
  }
  initAutoUpdater()
}

/**
 * 자동 업데이트 — GitHub Releases의 latest.yml을 확인해 새 버전을 내려받고, 다음 실행 시 설치한다.
 * 패키징 빌드에서만 동작(app-update.yml 필요). 상태는 렌더러(update:status)로 통지해 UI가 표시한다.
 */
let autoUpdater = null

function sendUpdateStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:status', status)
}

function initAutoUpdater() {
  if (!app.isPackaged) return
  try {
    ;({ autoUpdater } = require('electron-updater'))
  } catch {
    autoUpdater = null
    return // 의존성 없음 — 무시
  }
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => sendUpdateStatus({ state: 'checking' }))
  autoUpdater.on('update-available', (info) => sendUpdateStatus({ state: 'available', version: info?.version }))
  autoUpdater.on('update-not-available', (info) => sendUpdateStatus({ state: 'not-available', version: info?.version }))
  autoUpdater.on('download-progress', (p) => sendUpdateStatus({ state: 'downloading', percent: Math.round(p?.percent || 0) }))
  autoUpdater.on('update-downloaded', (info) => sendUpdateStatus({ state: 'downloaded', version: info?.version }))
  autoUpdater.on('error', (err) => sendUpdateStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) }))
  autoUpdater.checkForUpdates().catch(() => {}) // 시작 시 1회(조용히)
}

/** "1.2.3" 형식 비교 — a가 b보다 높으면 true. */
function isNewerVersion(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true
    if ((pa[i] || 0) < (pb[i] || 0)) return false
  }
  return false
}

// 렌더러의 "업데이트 확인" — GitHub API로 최신 릴리스를 직접 조회한다(electron-updater의 캐싱/판정
// 이슈로 새 버전을 못 잡는 경우가 있어, 감지는 API로 확실히 하고 다운로드만 electron-updater/수동에 맡긴다).
ipcMain.handle('update:check', async () => {
  const version = app.getVersion()
  if (!app.isPackaged) return { state: 'dev', version }
  try {
    const res = await fetch('https://api.github.com/repos/cablekis-alt/brand-aeo-app/releases/latest', {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Web4AI-Brand-AEO' },
    })
    if (!res.ok) throw new Error(`GitHub API ${res.status}`)
    const data = await res.json()
    const latest = String(data.tag_name || '').replace(/^v/, '')
    if (latest && isNewerVersion(latest, version)) {
      // 새 버전 있음 — electron-updater 자동 다운로드도 시도(되면 '재시작하여 설치'까지). 안 되면 수동 링크.
      if (autoUpdater) autoUpdater.checkForUpdates().catch(() => {})
      return { state: 'available', version: latest }
    }
    return { state: 'not-available', version, latest }
  } catch (err) {
    return { state: 'error', version, message: err instanceof Error ? err.message : String(err) }
  }
})

// 자동 업데이트가 불안정할 때의 수동 폴백 — 릴리스 페이지를 기본 브라우저로 연다.
ipcMain.handle('update:openReleases', () => {
  void shell.openExternal('https://github.com/cablekis-alt/brand-aeo-app/releases/latest')
})

ipcMain.handle('update:quitAndInstall', () => {
  if (app.isPackaged && autoUpdater) autoUpdater.quitAndInstall()
})

// ── API 키 설정(앱 내 입력) ──────────────────────────────────────────────
// userData/.env에 저장하고 process.env에 즉시 반영한다. 패키징은 서버가 별도 프로세스라
// env가 자동 공유되지 않으므로 같은 변경을 서버 프로세스에도 postMessage로 보낸다
// (그래서 재시작 없이 다음 측정부터 적용된다). dev는 서버가 자식 프로세스라 재시작 필요.
const API_KEY_NAMES = ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'PERPLEXITY_API_KEY']

function userEnvPath() {
  return path.join(app.getPath('userData'), '.env')
}

// server/engines/index.ts의 getJudgeClient()와 동일한 우선순위로 "실제" 판단 엔진을 해석한다.
// UI가 '항상 Gemini' 같은 고정 문구 대신 실제 동작을 표시하도록(키 조합에 따라 달라진다).
function resolveJudgeEngine() {
  const explicit = (process.env.JUDGE_ENGINE || '').trim().toLowerCase()
  if (explicit === 'gemini' || explicit === 'claude' || explicit === 'openai') return explicit
  if (process.env.GEMINI_API_KEY) return 'gemini' // 기본 고정(비교가능성)
  if (process.env.ANTHROPIC_API_KEY) return 'claude'
  return 'openai'
}

ipcMain.handle('settings:apiKeyStatus', () => {
  const status = {}
  for (const n of API_KEY_NAMES) status[n] = Boolean(process.env[n])
  const collect = (process.env.COLLECT_ENGINES || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  return {
    status,
    envPath: userEnvPath(),
    judgeEngine: resolveJudgeEngine(),
    collectEngines: collect.length > 0 ? collect : null, // null = 테넌트별 설정 사용
  }
})

ipcMain.handle('settings:setApiKey', (_e, payload) => {
  const name = payload?.name
  const value = String(payload?.value ?? '').trim()
  if (!API_KEY_NAMES.includes(name)) return { ok: false, error: '허용되지 않은 키 이름입니다.' }
  try {
    // 1) 즉시 적용 — 메인(설정 화면 표시용)과 서버 프로세스(측정에서 실제 사용) 양쪽.
    if (value) process.env[name] = value
    else delete process.env[name]
    const forwarded = sendEnvToServer(name, value)
    // 2) userData/.env에 병합 저장(다른 키·변수 보존)
    const file = userEnvPath()
    let lines = []
    try {
      lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    } catch {
      lines = []
    }
    lines = lines.filter((l) => l.trim() && !l.startsWith(`${name}=`))
    if (value) lines.push(`${name}=${value}`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8')
    // forwarded=false면 서버 프로세스가 없다(dev 또는 기동 실패) — 재시작 후 .env에서 읽힌다.
    return { ok: true, needsRestart: !forwarded }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})

/** 설치본에 키를 굽지 않는다 — 실행파일 옆 또는 userData의 .env를 읽는다. */
function loadEnvForPackaged() {
  // 우선순위(높은 순): 실행파일 옆 .env → userData/.env → 설치본 동봉 기본 키(bundled.env).
  // dotenv는 이미 설정된 값을 덮어쓰지 않으므로, 위 순서대로 로드하면 키 단위로 앞이 우선한다.
  const candidates = [
    path.join(path.dirname(app.getPath('exe')), '.env'),
    path.join(app.getPath('userData'), '.env'),
    // extraResources로 복사된 기본 키 — resources/bundled.env. 사용자 .env가 있으면 그쪽이 이긴다.
    process.resourcesPath ? path.join(process.resourcesPath, 'bundled.env') : null,
  ].filter(Boolean)
  let loaded = 0
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        require('dotenv').config({ path: p })
        console.log('[env] loaded', p)
        loaded++
      }
    } catch {
      /* 무시 */
    }
  }
  if (!loaded) {
    console.log('[env] .env 없음 — 측정에는 API 키가 필요합니다(실행파일 옆에 .env 배치 또는 앱에서 입력).')
  }
}

app.whenReady().then(() => {
  void createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  killChildren()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', killChildren)
