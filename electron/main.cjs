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

const { app, BrowserWindow, Menu, MenuItem, ipcMain, shell } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

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

  // 패키징: vite 없이 번들된 서버(dist-electron/server.cjs)를 인프로세스로 띄우고,
  // 그 서버가 dist(정적 UI)+/api를 같은 오리진(:4000)에서 서빙한다. 창은 그 URL을 로드.
  loadEnvForPackaged()
  // 로컬(한국) 측정은 Gemini grounding이 기준 — judge/수집 기본을 Gemini로(OpenAI 크레딧 비의존).
  // .env에서 명시하면 그 값을 존중한다. CI(measure.yml)의 기본값과 일치.
  if (!process.env.JUDGE_ENGINE) process.env.JUDGE_ENGINE = 'gemini'
  if (!process.env.GEMINI_MODEL) process.env.GEMINI_MODEL = 'gemini-3.7-flash'
  process.env.PORT = API_PORT
  process.env.ELECTRON_STATIC_DIR = path.join(__dirname, '..', 'dist') // asar 내부 dist
  // 측정 데이터·오버레이·큐는 쓰기 가능한 userData로(asar은 읽기전용). server/appPaths.ts가 참조.
  process.env.APP_DATA_DIR = app.getPath('userData')
  // 첫 실행 시드 소스 — asar에 동봉된 커밋 데이터(src/data).
  process.env.SEED_DATA_DIR = path.join(__dirname, '..', 'src', 'data')
  console.log('[data] APP_DATA_DIR =', process.env.APP_DATA_DIR)
  try {
    require(path.join(__dirname, '..', 'dist-electron', 'server.cjs')) // app.listen 실행
  } catch (err) {
    await win.loadURL(
      'data:text/html,' +
        encodeURIComponent(`<h2 style="font-family:sans-serif;padding:2rem">서버 기동 실패</h2><pre style="padding:0 2rem">${String(err)}</pre>`),
    )
    return
  }
  const ready = await waitForUrl(`http://localhost:${API_PORT}/health`)
  await win.loadURL(
    ready
      ? `http://localhost:${API_PORT}`
      : 'data:text/html,' + encodeURIComponent('<h2 style="font-family:sans-serif;padding:2rem">로컬 서버(:' + API_PORT + ') 시작 대기 시간 초과.</h2>'),
  )
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

// 렌더러의 "업데이트 확인" 버튼 → 수동 확인. 현재 버전과 진행 상태를 반환한다.
ipcMain.handle('update:check', async () => {
  const version = app.getVersion()
  if (!app.isPackaged) return { state: 'dev', version }
  if (!autoUpdater) return { state: 'error', version, message: '업데이터를 사용할 수 없습니다.' }
  try {
    const r = await autoUpdater.checkForUpdates()
    const latest = r?.updateInfo?.version
    if (latest && latest !== version) return { state: 'available', version: latest }
    return { state: 'not-available', version }
  } catch (err) {
    return { state: 'error', version, message: err instanceof Error ? err.message : String(err) }
  }
})

ipcMain.handle('update:quitAndInstall', () => {
  if (app.isPackaged && autoUpdater) autoUpdater.quitAndInstall()
})

// ── API 키 설정(앱 내 입력) ──────────────────────────────────────────────
// userData/.env에 저장하고 process.env에 즉시 반영한다. 패키징은 서버가 인프로세스라
// 재시작 없이 다음 측정부터 적용된다(dev는 서버가 자식 프로세스라 재시작 필요).
const API_KEY_NAMES = ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']

function userEnvPath() {
  return path.join(app.getPath('userData'), '.env')
}

ipcMain.handle('settings:apiKeyStatus', () => {
  const status = {}
  for (const n of API_KEY_NAMES) status[n] = Boolean(process.env[n])
  return { status, envPath: userEnvPath() }
})

ipcMain.handle('settings:setApiKey', (_e, payload) => {
  const name = payload?.name
  const value = String(payload?.value ?? '').trim()
  if (!API_KEY_NAMES.includes(name)) return { ok: false, error: '허용되지 않은 키 이름입니다.' }
  try {
    // 1) 즉시 적용(인프로세스 서버가 다음 호출부터 사용)
    if (value) process.env[name] = value
    else delete process.env[name]
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
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})

/** 설치본에 키를 굽지 않는다 — 실행파일 옆 또는 userData의 .env를 읽는다. */
function loadEnvForPackaged() {
  const candidates = [
    path.join(path.dirname(app.getPath('exe')), '.env'),
    path.join(app.getPath('userData'), '.env'),
  ]
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        require('dotenv').config({ path: p })
        console.log('[env] loaded', p)
        return
      }
    } catch {
      /* 무시 */
    }
  }
  console.log('[env] .env 없음 — 측정에는 API 키가 필요합니다(실행파일 옆에 .env 배치).')
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
