// 지도 그리기 — Electron 메인 프로세스 전용 모듈.
//
// 군산 블로그 글의 지도 자리에 넣을 그림을 앱이 직접 그린다(카카오 · 네이버 지도는 이용 조건상 쓰지 않는다). OpenStreetMap 데이터
// (map-data/gunsan-20261103.pmtiles, 설치본은 resources/map/gunsan.pmtiles)를 오프스크린 창에서 MapLibre(WebGL)로 그리고, 렌더러가 2D 캔버스에
// 표지 · 이름 · 동 이름 · 범례 · 축척 · 출처(「© OpenStreetMap contributors」)를 얹어 PNG로 만든다(electron/map/render.js).
// 이 모듈은 디스크에 아무것도 쓰지 않는다 — 저장은 서버가 한다. 서버(utilityProcess)는 capture.cjs의 relayCaptureRequests로 청한다.
//
// 지키는 것
//   - 바깥 요청 0: 메모리 전용 partition 'map-render'에서 osmmap:// · data: · blob:의 GET만 통과시키고 나머지(http · https · ws · file …)는
//     막고 센다. osmmap:// 처리기는 이 partition에만 건다(본 창은 열 수 없다). 프록시 direct, 맞춤법 검사 끔, 권한 · 내려받기 · 새 창 ·
//     osmmap://app 밖 이동 거절. 스타일에 글꼴(glyphs) · 스프라이트가 없어 글꼴 서버도 부르지 않는다.
//   - 파일은 허용 목록만 GET으로 준다. .pmtiles는 Range(bytes=a-b · bytes=a-)로만 읽는다 — 206, Range가 없거나 틀리거나 너무 크면 416.
//   - CDP 찍기를 쓰지 않는다: 오프스크린 + GPU에서 CDP는 WebGL · 가속 캔버스 층을 빼고 찍는다(실측). 렌더러가 toBlob으로 PNG를 만든다.
//   - 공군기지 상자(AVOID)와 겹치는 틀, 데이터 범위(COVER) 밖 틀은 그리지 않는다 — 그리기 전(center · zoom · 크기로 계산)과 그린 뒤
//     (map.getBounds) 두 번 본다. 틀은 서버가 정하지만 메인이 다시 본다.
//   - 화면 찍기(capture.cjs)와 같은 줄에 선다(한 번에 하나). 한 장마다 창을 새로 만들고 끝나면 destroy. 앱 종료 때 disposeMapRender().
//   - 결과는 1280×800이고 빈 그림이 아니어야 한다(바탕만 따로도 본다). 지도 오류(타일 · 스타일)가 하나라도 있으면 버린다.
'use strict'

const { app, BrowserWindow, protocol, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const SCHEME = 'osmmap'
const ORIGIN = `${SCHEME}://app`
const PAGE_URL = `${ORIGIN}/render.html`
/** 'persist:'가 없는 이름 = 디스크에 남지 않는 메모리 전용 세션. */
const PARTITION = 'map-render'
const WIDTH = 1280
const HEIGHT = 800
const TILE_SIZE = 512
const OFFSCREEN_FPS = 30
const MIN_ZOOM = 10
const MAX_ZOOM = 17
const MAX_MARKERS = 30
const MAX_LABEL = 40
const MAX_AREA_LABELS = 8
const DEFAULT_AREA_LABELS = 4
const DEFAULT_TIMEOUT_MS = 20000
const MIN_TIMEOUT_MS = 3000
const MAX_TIMEOUT_MS = 30000
/** 한도가 지난 뒤 더 기다리는 시간. 이것까지 넘으면 창을 부수고 실패한다. */
const HARD_GRACE_MS = 5000
const POLL_MS = 30
/** .pmtiles 한 번에 주는 가장 큰 구간 — 실측 가장 큰 조각 55KB, 첫 읽기 16KB. 통째로 읽게 두지 않는다. */
const MAX_RANGE_BYTES = 4 * 1024 * 1024
/** 틀 경계 비교 여유(도). 약 0.1m — 기지 상자 끝에 맞닿은 틀을 부동소수 오차로 거절하지 않게. */
const BOUNDS_EPSILON = 1e-6
/** 바탕만의 빈 그림 기준(4px 표본 · 5비트 색): 색이 이보다 적거나 한 색이 이보다 많으면 바탕이 그려지지 않은 것. */
const BASE_MIN_COLORS = 6
const BASE_MAX_DOMINANT = 0.985
const MARKER_KINDS = new Set(['attraction', 'stay', 'food'])
/** 군산 공군기지: OSM landuse airfield [126.6107,35.8863,126.6436,35.9279] + 북쪽 military [126.6209,35.9339,126.6290,35.9426]에 약 1km 여유. */
const AVOID = Object.freeze([126.598, 35.876, 126.656, 35.952])
/** 지도 데이터 범위(잘라 낸 상자, .pmtiles 머리말과 같다). 틀은 이 안에 있어야 한다. */
const COVER = Object.freeze([126.28, 35.7, 126.92, 36.07])
const SPEC_KEYS = new Set(['width', 'height', 'center', 'zoom', 'markers', 'areaLabels', 'legend', 'maxAreaLabels', 'timeoutMs'])
const MARKER_KEYS = new Set(['lng', 'lat', 'kind', 'label'])
const CSP =
  "default-src 'none'; script-src osmmap://app; worker-src osmmap://app blob:; connect-src osmmap://app; style-src osmmap://app 'unsafe-inline'; img-src data: blob:; font-src 'none'"
const TILES_PATH = '/gunsan.pmtiles'
/** 설치본 dist-electron/map-vendor에 넣는 파일(scripts/build-electron-server.mjs가 복사한다). */
const VENDOR_FILES = {
  '/maplibre-gl.mjs': 'maplibre-gl.mjs',
  '/maplibre-gl-worker.mjs': 'maplibre-gl-worker.mjs',
  '/maplibre-gl.css': 'maplibre-gl.css',
  '/pmtiles.js': 'pmtiles.js',
}
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}
/** 페이지(render.js)가 돌려주는 실패 까닭 가운데 그대로 쓰는 것. 나머지는 render-failed. */
const PAGE_CODES = new Set(['webgl-unavailable', 'timeout', 'render-failed'])

function mapError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

// ── 파일 경로 ────────────────────────────────────────────────────────────

let pathsCache = null

/**
 * 지도 데이터 · 페이지 · 라이브러리 경로. 설치본: 지도 데이터는 resources/map/gunsan.pmtiles(asar 밖 — Range를 fd로 읽는다), 라이브러리는
 * asar 안 dist-electron/map-vendor. 개발: map-data/의 원본, 라이브러리는 dist-electron/map-vendor가 있으면 그것, 없으면 node_modules.
 */
function mapPaths() {
  if (pathsCache) return pathsCache
  const packaged = Boolean(app && app.isPackaged)
  const pmtiles = packaged ? path.join(process.resourcesPath, 'map', 'gunsan.pmtiles') : path.join(__dirname, '..', 'map-data', 'gunsan-20261103.pmtiles')
  const vendorDir = path.join(__dirname, '..', 'dist-electron', 'map-vendor')
  const useVendor = packaged || fs.existsSync(path.join(vendorDir, 'maplibre-gl.mjs'))
  const vendorPath = (name) => {
    if (useVendor) return path.join(vendorDir, name)
    const pkg = name.startsWith('pmtiles') ? 'pmtiles' : 'maplibre-gl'
    return path.join(path.dirname(require.resolve(`${pkg}/package.json`)), 'dist', name)
  }
  const files = {
    '/render.html': path.join(__dirname, 'map', 'render.html'),
    '/render.js': path.join(__dirname, 'map', 'render.js'),
    '/style.json': path.join(__dirname, 'map', 'style.json'),
  }
  for (const [route, name] of Object.entries(VENDOR_FILES)) files[route] = vendorPath(name)
  pathsCache = {
    pmtiles,
    files: Object.fromEntries(Object.entries(files).map(([route, file]) => [route, [file, CONTENT_TYPES[path.extname(file)]]])),
  }
  return pathsCache
}

// ── osmmap:// 처리 ───────────────────────────────────────────────────────

/** 'bytes=a-b' · 'bytes=a-'만 받는다. 끝이 크기를 넘으면 마지막 바이트까지. 시작이 크기 이상이거나 시작 > 끝이면 null(416). */
function parseRange(header, size) {
  if (typeof header !== 'string') return null
  const m = /^bytes=(\d{1,15})-(\d{0,15})$/.exec(header.trim())
  if (!m) return null
  const start = Number(m[1])
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  if (start >= size || end < start) return null
  return { start, end }
}

/** 요청이 주는 파일: { tiles: true } · { file, type } · 허용하지 않으면 null. 호스트는 app, 방법은 GET, 경로는 허용 목록과 똑같아야 한다. */
function mapRoute(method, rawUrl) {
  if (method !== 'GET') return null
  let u
  try {
    u = new URL(String(rawUrl))
  } catch {
    return null
  }
  if (u.protocol !== `${SCHEME}:` || u.host !== 'app' || u.username || u.password) return null
  if (u.pathname === TILES_PATH) return { tiles: true }
  const entry = Object.prototype.hasOwnProperty.call(mapPaths().files, u.pathname) ? mapPaths().files[u.pathname] : null
  return entry ? { file: entry[0], type: entry[1] } : null
}

function noteServed(key, bytes) {
  const job = activeJob
  if (!job) return
  if (key === 'range') {
    job.ranges += 1
    job.rangeBytes += bytes
  } else if (key === 'refused') job.refused += 1
}

/** 지도 데이터의 한 구간(206) — Range가 없거나 틀리거나 너무 크면 416. 파일은 요청마다 열고 닫는다. */
function serveTiles(request) {
  const fd = fs.openSync(mapPaths().pmtiles, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const range = parseRange(request.headers.get('range'), size)
    if (!range || range.end - range.start + 1 > MAX_RANGE_BYTES) {
      noteServed('refused', 0)
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}`, 'Cache-Control': 'no-store' } })
    }
    const len = range.end - range.start + 1
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, range.start)
    noteServed('range', len)
    return new Response(buf, {
      status: 206,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
        'Content-Length': String(len),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } finally {
    fs.closeSync(fd)
  }
}

/** osmmap:// 요청 하나에 답한다(map-render partition의 protocol.handle). 허용 목록 밖 · GET 아님은 404. */
function serveMapRequest(request) {
  const route = mapRoute(request.method, request.url)
  if (!route) {
    noteServed('refused', 0)
    return new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })
  }
  if (route.tiles) return serveTiles(request)
  const body = fs.readFileSync(route.file)
  const headers = { 'Content-Type': route.type, 'Content-Length': String(body.length), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  if (route.type.startsWith('text/html')) headers['Content-Security-Policy'] = CSP
  return new Response(body, { status: 200, headers })
}

/** 렌더 창의 요청을 막을 까닭(없으면 null): 그리는 작업 · 그 창 · GET · osmmap://app / data: / blob:만 통과. */
function requestBlockReason(details, job) {
  if (!job || job.finished) return 'no-job'
  if (details.webContentsId !== undefined && details.webContentsId !== job.wcId) return 'other-window'
  if (details.method !== 'GET') return 'method'
  const url = String(details.url || '')
  const colon = url.indexOf(':')
  const scheme = colon > 0 ? url.slice(0, colon).toLowerCase() : ''
  if (scheme === 'data' || scheme === 'blob') return null
  if (scheme !== SCHEME) return 'scheme'
  if (!url.startsWith(`${ORIGIN}/`)) return 'host'
  return null
}

/** osmmap을 특권 스킴으로 등록한다 — app ready 전에 불러야 한다(main.cjs 맨 위). 처리기는 partition에만 건다(ensureSession). */
function registerMapScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }])
}

// ── 그리기 요청 검사 ─────────────────────────────────────────────────────

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

/**
 * 서버가 보낸 spec을 검사해 기본값을 채운 사본을 돌려준다. 어기면 code 'bad-spec' Error.
 *   { width?:1280, height?:800, center:[lng,lat], zoom:10~17, markers:[{lng,lat,kind:'attraction'|'stay'|'food',label:1~40자}] 1~30개,
 *     areaLabels?:boolean(기본 false), legend?:boolean(기본 true), maxAreaLabels?:0~8(기본 4), timeoutMs?:3000~30000(기본 20000) }
 */
function validateMapSpec(spec) {
  const bad = (why) => mapError('bad-spec', `지도 요청이 올바르지 않습니다: ${why}`)
  if (!isPlainObject(spec)) throw bad('객체가 아님')
  const extra = Object.keys(spec).filter((k) => !SPEC_KEYS.has(k))
  if (extra.length) throw bad(`모르는 키 ${extra.slice(0, 3).join(', ')}`)
  if (spec.width !== undefined && spec.width !== WIDTH) throw bad('너비는 1280')
  if (spec.height !== undefined && spec.height !== HEIGHT) throw bad('높이는 800')
  if (!Array.isArray(spec.center) || spec.center.length !== 2 || !spec.center.every(isNum)) throw bad('center는 [경도, 위도]')
  if (!isNum(spec.zoom) || spec.zoom < MIN_ZOOM || spec.zoom > MAX_ZOOM) throw bad(`zoom은 ${MIN_ZOOM}~${MAX_ZOOM}`)
  if (!Array.isArray(spec.markers) || spec.markers.length < 1 || spec.markers.length > MAX_MARKERS) throw bad(`표지는 1~${MAX_MARKERS}개`)
  const markers = spec.markers.map((m, i) => {
    if (!isPlainObject(m) || Object.keys(m).some((k) => !MARKER_KEYS.has(k))) throw bad(`표지 ${i + 1}의 모양`)
    if (!isNum(m.lng) || !isNum(m.lat)) throw bad(`표지 ${i + 1}의 좌표`)
    if (!MARKER_KINDS.has(m.kind)) throw bad(`표지 ${i + 1}의 종류`)
    if (typeof m.label !== 'string' || !m.label.trim() || m.label.length > MAX_LABEL || CONTROL_CHARS.test(m.label)) throw bad(`표지 ${i + 1}의 이름(1~${MAX_LABEL}자)`)
    return { lng: m.lng, lat: m.lat, kind: m.kind, label: m.label.trim() }
  })
  for (const key of ['areaLabels', 'legend']) if (spec[key] !== undefined && typeof spec[key] !== 'boolean') throw bad(`${key}는 참/거짓`)
  const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi
  if (spec.maxAreaLabels !== undefined && !intIn(spec.maxAreaLabels, 0, MAX_AREA_LABELS)) throw bad(`maxAreaLabels는 0~${MAX_AREA_LABELS}`)
  if (spec.timeoutMs !== undefined && !intIn(spec.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)) throw bad(`timeoutMs는 ${MIN_TIMEOUT_MS}~${MAX_TIMEOUT_MS}`)
  return {
    width: WIDTH,
    height: HEIGHT,
    center: [spec.center[0], spec.center[1]],
    zoom: spec.zoom,
    markers,
    areaLabels: spec.areaLabels === true,
    legend: spec.legend !== false,
    maxAreaLabels: spec.maxAreaLabels === undefined ? DEFAULT_AREA_LABELS : spec.maxAreaLabels,
    timeoutMs: spec.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : spec.timeoutMs,
  }
}

// ── 틀 검사 ──────────────────────────────────────────────────────────────

const mercX = (lng) => (lng + 180) / 360
const mercY = (lat) => {
  const s = Math.sin((lat * Math.PI) / 180)
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)
}
const unMercX = (x) => x * 360 - 180
const unMercY = (y) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI

/** 북쪽이 위인 width×height 그림의 범위 [서, 남, 동, 북] — MapLibre와 같은 512px 타일 웹 메르카토르. */
function frameBounds(center, zoom, width = WIDTH, height = HEIGHT) {
  const s = TILE_SIZE * 2 ** zoom
  const cx = mercX(center[0]) * s
  const cy = mercY(center[1]) * s
  return [unMercX((cx - width / 2) / s), unMercY((cy + height / 2) / s), unMercX((cx + width / 2) / s), unMercY((cy - height / 2) / s)]
}

/**
 * 틀 범위를 검사한다: COVER 안(아니면 out-of-cover) · AVOID와 겹치지 않음(아니면 avoid-area) · 표지는 틀 안(아니면 bad-spec).
 * 맞닿는 것은 겹침이 아니다(BOUNDS_EPSILON 여유).
 */
function assertFrame(bounds, markers = []) {
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(isNum)) throw mapError('bad-spec', '지도 범위를 계산할 수 없습니다.')
  const [w, s, e, n] = bounds
  const E = BOUNDS_EPSILON
  if (w < COVER[0] - E || s < COVER[1] - E || e > COVER[2] + E || n > COVER[3] + E) {
    throw mapError('out-of-cover', '지도 범위가 동봉한 군산 지도 데이터 밖으로 나갑니다.')
  }
  if (w < AVOID[2] - E && AVOID[0] < e - E && s < AVOID[3] - E && AVOID[1] < n - E) {
    throw mapError('avoid-area', '지도 범위가 그리지 않는 구역(군산 공군기지 주변)과 겹칩니다.')
  }
  for (const m of markers) {
    if (!(m.lng >= w && m.lng <= e && m.lat >= s && m.lat <= n)) throw mapError('bad-spec', '표지가 지도 범위 밖에 있습니다.')
  }
}

// ── 창 · 세션 ────────────────────────────────────────────────────────────

let sessionReady = null
/** 지금 그리는 작업. 세션의 요청 검사기는 이것만 본다(다른 웹콘텐츠의 요청 · 작업 밖 요청은 모두 막는다). */
let activeJob = null
let disposed = false

function noteBlocked(job, details, reason) {
  if (!job) return
  job.blocked += 1
  if (job.blockedSamples.length >= 10) return
  let where = '(bad-url)'
  try {
    const u = new URL(String(details.url))
    where = u.protocol === 'data:' || u.protocol === 'blob:' ? u.protocol : `${u.protocol}//${u.host}`
  } catch {
    where = '(bad-url)'
  }
  job.blockedSamples.push(`${reason} ${details.method || ''} ${where}`.trim())
}

/** map-render partition을 한 번만 만들고 잠근다. 프록시 direct까지 기다린다. */
function ensureSession() {
  if (sessionReady) return sessionReady
  const ses = session.fromPartition(PARTITION, { cache: false })
  ses.setSpellCheckerEnabled(false)
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.setDevicePermissionHandler(() => false)
  ses.on('will-download', (event) => event.preventDefault())
  ses.webRequest.onBeforeRequest((details, callback) => {
    const job = activeJob
    const reason = requestBlockReason(details, job)
    if (reason) {
      noteBlocked(job, details, reason)
      callback({ cancel: true })
    } else callback({})
  })
  ses.protocol.handle(SCHEME, (request) => {
    try {
      return serveMapRequest(request)
    } catch (err) {
      // 파일이 없거나 읽지 못함(설치본에 지도 데이터 · 라이브러리가 빠졌을 때) — 까닭을 남기고 500. 그리기는 페이지 쪽 실패로 끝난다.
      console.warn(`[map] osmmap 파일을 주지 못했습니다(${new URL(request.url).pathname}): ${err instanceof Error ? err.message : String(err)}`)
      return new Response(null, { status: 500, headers: { 'Cache-Control': 'no-store' } })
    }
  })
  // 프록시 자동 찾기(wpad) 조회를 줄인다. 바깥 요청은 위 검사기가 어차피 모두 막으므로 실패해도 그리기는 이어 간다.
  sessionReady = ses.setProxy({ mode: 'direct' }).then(
    () => ses,
    (err) => {
      console.warn(`[map] 지도 세션 프록시를 direct로 두지 못했습니다: ${err instanceof Error ? err.message : String(err)}`)
      return ses
    },
  )
  return sessionReady
}

function destroyWindow(win) {
  if (win && !win.isDestroyed()) win.destroy()
}

/** 한 단계를 기다린다: ms가 지나면 timeout, 그사이 작업이 멈추면(종료 · 렌더러 끝남 · 한도) 그 까닭으로 바로 끝난다. */
function step(job, promise, ms) {
  let timer = null
  return Promise.race([
    promise,
    job.stoppedPromise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(mapError('timeout', timeoutMessage(job))), Math.max(0, ms))
    }),
  ]).finally(() => clearTimeout(timer))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function checkAlive(job) {
  if (job.stopped) throw job.stopped
  if (disposed) throw mapError('disposed', '앱이 종료 중입니다.')
}

const remaining = (job) => job.deadline - Date.now()
const timeoutMessage = (job) => `지도를 ${Math.round(job.timeoutMs / 1000)}초 안에 그리지 못했습니다.`

async function renderSteps(spec, job) {
  const timings = {}
  const mark = (name) => {
    timings[name] = Date.now() - job.startedAt
  }
  const ses = await ensureSession()
  checkAlive(job)
  const win = new BrowserWindow({
    show: false,
    width: WIDTH,
    height: HEIGHT,
    useContentSize: true,
    frame: false,
    skipTaskbar: true,
    focusable: false,
    paintWhenInitiallyHidden: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      offscreen: true,
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      backgroundThrottling: false,
      spellcheck: false,
      disableDialogs: true,
      navigateOnDragDrop: false,
    },
  })
  job.win = win
  const wc = win.webContents
  job.wcId = wc.id
  wc.setFrameRate(OFFSCREEN_FPS)
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  const keepOnPage = (event, url) => {
    if (!String(url).startsWith(`${ORIGIN}/`)) event.preventDefault()
  }
  wc.on('will-navigate', keepOnPage)
  wc.on('will-redirect', keepOnPage)
  wc.on('will-attach-webview', (event) => event.preventDefault())
  wc.on('render-process-gone', (_event, details) => job.stop('renderer-gone', `지도 렌더러가 끝났습니다(${(details && details.reason) || '까닭 모름'}).`))
  mark('windowMs')

  try {
    await step(job, wc.loadURL(PAGE_URL), remaining(job))
  } catch (err) {
    checkAlive(job)
    if (err && err.code === 'timeout') throw err
    throw mapError('load-failed', `지도 페이지를 열지 못했습니다: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300))
  }
  for (;;) {
    checkAlive(job)
    if (remaining(job) <= 0) throw mapError('timeout', timeoutMessage(job))
    if (await step(job, wc.executeJavaScript('window.rendererReady === true'), remaining(job))) break
    await sleep(POLL_MS)
  }
  mark('pageMs')

  const pageSpec = {
    center: spec.center,
    zoom: spec.zoom,
    markers: spec.markers,
    areaLabels: spec.areaLabels,
    legend: spec.legend,
    maxAreaLabels: spec.maxAreaLabels,
    avoid: AVOID,
    timeoutMs: Math.max(1000, remaining(job)),
  }
  const out = await step(job, wc.executeJavaScript(`window.renderFrame(${JSON.stringify(pageSpec)})`), remaining(job) + 1000)
  checkAlive(job)
  mark('renderMs')
  if (!isPlainObject(out)) throw mapError('render-failed', '지도 페이지가 답하지 않았습니다.')
  if (out.ok !== true) throw mapError(PAGE_CODES.has(out.code) ? out.code : 'render-failed', String(out.message || '지도를 그리지 못했습니다.').slice(0, 300))
  if (!isPlainObject(out.stats)) throw mapError('render-failed', '지도 페이지가 그린 내용을 알려 주지 않았습니다.')
  const stats = out.stats
  if (Array.isArray(stats.errors) && stats.errors.length) throw mapError('map-error', `지도 오류: ${String(stats.errors[0]).slice(0, 200)}`)
  if (!Array.isArray(stats.bounds)) throw mapError('render-failed', '지도 페이지가 범위를 알려 주지 않았습니다.')
  assertFrame(stats.bounds)
  if (Array.isArray(stats.markersOutside) && stats.markersOutside.length) throw mapError('marker-outside', '표지가 그림 밖에 놓였습니다.')
  const base = stats.base || {}
  if (!isNum(base.colors) || base.colors < BASE_MIN_COLORS || !isNum(base.dominantShare) || base.dominantShare > BASE_MAX_DOMINANT) {
    throw mapError('blank', '지도 바탕이 그려지지 않았습니다.')
  }
  if (typeof out.png !== 'string' || !out.png.startsWith('data:image/png;base64,')) throw mapError('render-failed', 'PNG가 없습니다.')
  const png = Buffer.from(out.png.slice(out.png.indexOf(',') + 1), 'base64')
  const check = captureModule().blankCheck(png)
  if (check.width !== WIDTH || check.height !== HEIGHT) throw mapError('bad-size', `그림 크기가 ${check.width}×${check.height}입니다.`)
  if (check.blank) throw mapError('blank', '빈 그림입니다.')
  mark('totalMs')
  const gl = isPlainObject(stats.gl) ? stats.gl : {}
  return {
    png,
    width: check.width,
    height: check.height,
    bounds: stats.bounds,
    zoom: isNum(stats.zoom) ? stats.zoom : spec.zoom,
    labels: isPlainObject(stats.labels) ? stats.labels : { placed: 0, dropped: [] },
    areaLabels: Array.isArray(stats.areaLabels) ? stats.areaLabels : [],
    renderer: typeof gl.renderer === 'string' ? gl.renderer.slice(0, 200) : '',
    timings: { ...timings, page: isPlainObject(stats.timings) ? stats.timings : {} },
    blockedRequests: job.blocked,
    blockedSamples: job.blockedSamples,
    rangeRequests: job.ranges,
    rangeBytes: job.rangeBytes,
    refusedRequests: job.refused,
  }
}

async function renderJob(spec) {
  if (disposed) throw mapError('disposed', '앱이 종료 중입니다.')
  if (activeJob) throw mapError('busy', '다른 지도를 그리는 중입니다.')
  const now = Date.now()
  let stopJob = null
  const stopped = new Promise((_resolve, reject) => {
    stopJob = reject
  })
  const job = {
    stoppedPromise: stopped,
    startedAt: now,
    deadline: now + spec.timeoutMs,
    timeoutMs: spec.timeoutMs,
    win: null,
    wcId: -1,
    finished: false,
    stopped: null,
    blocked: 0,
    blockedSamples: [],
    ranges: 0,
    rangeBytes: 0,
    refused: 0,
  }
  /** 한도 · 종료 · 렌더러 끝남: 창을 부수고 바로 실패한다(그리던 단계는 다음 확인에서 멈춘다). */
  job.stop = (code, message) => {
    if (job.stopped || job.finished) return
    job.stopped = mapError(code, message)
    destroyWindow(job.win)
    stopJob(job.stopped)
  }
  activeJob = job
  const hardTimer = setTimeout(() => job.stop('timeout', timeoutMessage(job)), spec.timeoutMs + HARD_GRACE_MS)
  try {
    return await Promise.race([renderSteps(spec, job), stopped])
  } finally {
    job.finished = true
    clearTimeout(hardTimer)
    destroyWindow(job.win)
    if (activeJob === job) activeJob = null
  }
}

let captureRef = null
/** 줄 · 빈 그림 검사는 화면 찍기 모듈의 것을 쓴다(서로 늦게 읽는다 — 읽는 순서가 돌지 않게). */
function captureModule() {
  if (!captureRef) captureRef = require('./capture.cjs')
  return captureRef
}

/**
 * 지도 한 장을 그린다(화면 찍기와 같은 줄, 들어온 순서대로).
 * spec 모양은 validateMapSpec, 틀은 assertFrame(그리기 전 계산 · 그린 뒤 map.getBounds)으로 본다.
 * @returns {Promise<{png: Buffer, width: number, height: number, bounds: number[], zoom: number, labels: {placed: number, dropped: string[]},
 *   areaLabels: string[], renderer: string, timings: object, blockedRequests: number, blockedSamples: string[], rangeRequests: number,
 *   rangeBytes: number, refusedRequests: number}>}
 *   refusedRequests는 osmmap://에서 거절한 요청 수(허용 목록 밖 404 · 틀린 Range 416).
 *   실패하면 code가 붙은 Error로 거부한다: bad-spec · avoid-area · out-of-cover · busy · disposed · timeout · load-failed · webgl-unavailable ·
 *   render-failed · map-error · marker-outside · blank · bad-size · renderer-gone.
 */
function renderMap(spec) {
  let clean
  try {
    clean = validateMapSpec(spec)
    assertFrame(frameBounds(clean.center, clean.zoom), clean.markers)
  } catch (err) {
    return Promise.reject(err)
  }
  if (disposed) return Promise.reject(mapError('disposed', '앱이 종료 중입니다.'))
  return captureModule().runQueued(() => renderJob(clean))
}

/** 앱 종료 때 부른다: 그리던 창을 부수고, 그 뒤의 그리기는 모두 'disposed'로 거부된다. */
function disposeMapRender() {
  disposed = true
  if (activeJob) activeJob.stop('disposed', '앱이 종료 중입니다.')
}

// ── 서버(utilityProcess)와 주고받는 메시지 ──────────────────────────────────
// capture.cjs의 relayCaptureRequests가 type으로 갈라 여기로 넘긴다.
//   요청 { type: 'map-render', id, spec: { width?, height?, center, zoom, markers, areaLabels?, legend?, maxAreaLabels?, timeoutMs? } }
//   답   { type: 'map-render-result', id, ok: true, png(base64), width, height, bounds, zoom, labels, areaLabels, renderer, timings, blockedRequests }
//        { type: 'map-render-result', id, ok: false, code, message }
const MAP_REQUEST_TYPE = 'map-render'
const MAP_RESULT_TYPE = 'map-render-result'
const REQUEST_ID = /^[\w-]{1,64}$/

/** 서버의 그리기 요청 하나를 처리하고 보낼 답을 돌려준다. 거부하지 않는다 — 실패도 답(ok false)이다. 모양이 아니거나 id가 틀리면 null. */
async function handleMapRequest(msg) {
  if (!isPlainObject(msg) || msg.type !== MAP_REQUEST_TYPE) return null
  const id = typeof msg.id === 'string' && REQUEST_ID.test(msg.id) ? msg.id : null
  if (!id) return null
  try {
    const r = await renderMap(msg.spec)
    return {
      type: MAP_RESULT_TYPE,
      id,
      ok: true,
      png: r.png.toString('base64'),
      width: r.width,
      height: r.height,
      bounds: r.bounds,
      zoom: r.zoom,
      labels: r.labels,
      areaLabels: r.areaLabels,
      renderer: r.renderer,
      timings: r.timings,
      blockedRequests: r.blockedRequests,
    }
  } catch (err) {
    const code = err && typeof err.code === 'string' ? err.code : 'failed'
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[map] 지도 그리기 실패(${code}): ${message}`)
    return { type: MAP_RESULT_TYPE, id, ok: false, code, message: message.slice(0, 300) }
  }
}

module.exports = {
  registerMapScheme,
  renderMap,
  handleMapRequest,
  disposeMapRender,
  parseRange,
  mapRoute,
  serveMapRequest,
  validateMapSpec,
  frameBounds,
  assertFrame,
  requestBlockReason,
  mapPaths,
  AVOID,
  COVER,
  CSP,
  SCHEME,
  PARTITION,
  WIDTH,
  HEIGHT,
  MAP_REQUEST_TYPE,
  MAP_RESULT_TYPE,
}
