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

const { app, BrowserWindow, shell } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const IS_WINDOWS = process.platform === 'win32'
const API_PORT = process.env.PORT || '4000'
const DEV_SERVER_URL = process.env.DEV_SERVER_URL || 'http://localhost:5173'
const PROJECT_ROOT = path.resolve(__dirname, '..')

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
    backgroundColor: '#f4f1ea',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, // 렌더러와 Node 격리(보안)
      nodeIntegration: false, // 렌더러에서 Node 직접 접근 차단
      sandbox: false, // preload에서 contextBridge 쓰기 위해
    },
  })

  // 렌더러 안의 외부 링크(GitHub Actions 로그 등)는 기본 브라우저로 연다.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) {
      void shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
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
  process.env.PORT = API_PORT
  process.env.ELECTRON_STATIC_DIR = path.join(__dirname, '..', 'dist') // asar 내부 dist
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
}

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
