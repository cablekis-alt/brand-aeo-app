/**
 * 지도 그리기(electron/mapRender.cjs, 메인 프로세스)의 검사할 수 있는 부분을 확인한다 — osmmap:// 파일 주기(허용 목록 · GET만 · .pmtiles Range
 * 206/416 · CSP) · 그리기 요청 모양(spec 검사) · 틀 검사(공군기지 상자 AVOID · 데이터 범위 COVER, 그리기 전 계산 · 그린 뒤 map.getBounds) ·
 * 렌더 창 요청 막기 · partition 설정 · 화면 찍기(capture.cjs)와 같은 줄 · 시간 한도 · 앱 종료 · 서버 다리(relayCaptureRequests의 'map-render') ·
 * 설치본 경로 · 묶음 설정 · 지도 데이터 · 알림 파일 · 스타일.
 * electron은 가짜로 바꿔 읽는다(창을 열지 않고 바깥 요청도 없다). 실제 그리기(WebGL · PNG)는 숨긴 창 하니스로 따로 확인한다.
 *
 * 왜:
 * - 지도 그림은 공개 블로그에 나간다 — 공군기지가 틀에 들어가면 안 된다. 틀은 서버가 정해도 메인이 그리기 전과 그린 뒤에 다시 본다.
 * - 렌더 창은 바깥으로 요청하면 안 된다(타일 · 글꼴 서버 이용 조건, 사용자 PC 밖 노출) — osmmap:// · data: · blob:의 GET만 통과한다.
 * - osmmap://는 디스크의 파일을 렌더러에 주는 길이다 — 허용 목록 밖 경로를 주면 앱 파일이 새어 나간다.
 * - .pmtiles는 Range로만 읽는다 — 잘못된 Range에 파일 통째(17.7MB)를 주지 않는다.
 * - 그리기와 화면 찍기가 함께 돌면 숨긴 창이 둘 뜨고 GPU · 메모리를 같이 쓴다 — 같은 줄에 선다.
 * - 지도 데이터 파일이 줄 끝 바꾸기 등으로 바뀌면 지도가 깨진다 — 바이트(sha256)와 머리말 범위를 본다.
 *
 *   npx tsx scripts/verify-map-render.ts
 */
import Module, { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs'
import path from 'node:path'

const req = createRequire(import.meta.url)
const ROOT = process.cwd()
const MAP_FILE = path.join(ROOT, 'map-data', 'gunsan-20261103.pmtiles')
const MAP_SIZE = 17723203
const MAP_SHA256 = '50c25efc72af917d17794cd3b00bf08de7b714761d4038ec14e6869843bdbdec'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
    return 'resolved'
  } catch (err) {
    return (err as { code?: string }).code ?? 'no-code'
  }
}
const codeOfSync = (fn: () => unknown): string => {
  try {
    fn()
    return 'ok'
  } catch (err) {
    return (err as { code?: string }).code ?? 'no-code'
  }
}
const lf = (s: string) => s.replace(/\r\n/g, '\n')

type Bounds = [number, number, number, number]
interface Marker {
  lng: number
  lat: number
  kind: string
  label: string
}
interface NormalSpec {
  width: number
  height: number
  center: [number, number]
  zoom: number
  markers: Marker[]
  areaLabels: boolean
  legend: boolean
  maxAreaLabels: number
  timeoutMs: number
}
interface RenderResult {
  png: Buffer
  width: number
  height: number
  bounds: Bounds
  zoom: number
  labels: { placed: number; dropped: string[] }
  areaLabels: string[]
  renderer: string
  timings: Record<string, number>
  blockedRequests: number
}
interface MapModule {
  registerMapScheme: () => void
  renderMap: (spec: unknown) => Promise<RenderResult>
  handleMapRequest: (msg: unknown) => Promise<Record<string, unknown> | null>
  disposeMapRender: () => void
  parseRange: (header: unknown, size: number) => { start: number; end: number } | null
  serveMapRequest: (request: { url: string; method: string; headers: Headers }) => Response
  validateMapSpec: (spec: unknown) => NormalSpec
  frameBounds: (center: [number, number], zoom: number, width?: number, height?: number) => Bounds
  assertFrame: (bounds: unknown, markers?: { lng: number; lat: number }[]) => void
  requestBlockReason: (details: { url: string; method?: string; webContentsId?: number }, job: { wcId: number; finished?: boolean } | null) => string | null
  mapPaths: () => { pmtiles: string; files: Record<string, [string, string]> }
  AVOID: Bounds
  COVER: Bounds
  CSP: string
  SCHEME: string
  PARTITION: string
  MAP_REQUEST_TYPE: string
  MAP_RESULT_TYPE: string
}
interface CaptureModule {
  runQueued: <T>(run: () => Promise<T>) => Promise<T>
  disposeCapture: () => void
  relayCaptureRequests: (child: { on: (event: 'message', fn: (msg: unknown) => void) => void; postMessage: (msg: unknown) => void }, isCurrent: () => boolean) => void
}

/** 가짜 electron — 만든 창 · 세션 설정 · 스킴 등록을 적는다. 창의 페이지는 page 함수가 정한다. */
interface FakePage {
  load?: () => Promise<void>
  ready?: () => boolean
  frame?: (pageSpec: Record<string, unknown>) => unknown
}
function fakeElectron(opts: { packaged?: boolean; page?: FakePage; size?: { width: number; height: number }; bitmap?: () => Buffer } = {}) {
  const log = {
    windows: [] as { options: Record<string, unknown>; destroyed: boolean; frameRate: number | null; openHandler: (() => unknown) | null; events: Map<string, (...a: unknown[]) => void>; createdAt: number; scripts: string[] }[],
    partitions: [] as { name: string; options: unknown }[],
    spellcheck: [] as boolean[],
    proxy: [] as unknown[],
    sessionSchemes: [] as string[],
    schemeHandler: null as null | ((request: { url: string; method: string; headers: Headers }) => Response),
    globalHandled: [] as string[],
    privileged: [] as unknown[],
    permissionRequest: null as null | ((wc: unknown, p: string, cb: (v: boolean) => void) => void),
    permissionCheck: null as null | (() => boolean),
    devicePermission: null as null | (() => boolean),
    sessionEvents: new Map<string, (...a: unknown[]) => void>(),
    onBeforeRequest: null as null | ((details: Record<string, unknown>, cb: (r: { cancel?: boolean }) => void) => void),
  }
  const page = opts.page ?? {}
  const fakeSession = {
    setSpellCheckerEnabled: (v: boolean) => log.spellcheck.push(v),
    setPermissionRequestHandler: (fn: typeof log.permissionRequest) => {
      log.permissionRequest = fn
    },
    setPermissionCheckHandler: (fn: typeof log.permissionCheck) => {
      log.permissionCheck = fn
    },
    setDevicePermissionHandler: (fn: typeof log.devicePermission) => {
      log.devicePermission = fn
    },
    on: (event: string, fn: (...a: unknown[]) => void) => log.sessionEvents.set(event, fn),
    webRequest: {
      onBeforeRequest: (fn: typeof log.onBeforeRequest) => {
        log.onBeforeRequest = fn
      },
    },
    protocol: {
      handle: (scheme: string, fn: (request: { url: string; method: string; headers: Headers }) => Response) => {
        log.sessionSchemes.push(scheme)
        log.schemeHandler = fn
      },
    },
    setProxy: (cfg: unknown) => {
      log.proxy.push(cfg)
      return Promise.resolve()
    },
  }
  let nextId = 300
  class FakeWindow {
    entry: (typeof log.windows)[number]
    webContents: Record<string, unknown>
    constructor(options: Record<string, unknown>) {
      const entry = { options, destroyed: false, frameRate: null as number | null, openHandler: null as (() => unknown) | null, events: new Map<string, (...a: unknown[]) => void>(), createdAt: Date.now(), scripts: [] as string[] }
      this.entry = entry
      log.windows.push(entry)
      const id = (nextId += 1)
      this.webContents = {
        id,
        setFrameRate: (n: number) => {
          entry.frameRate = n
        },
        setWindowOpenHandler: (fn: () => unknown) => {
          entry.openHandler = fn
        },
        on: (event: string, fn: (...a: unknown[]) => void) => entry.events.set(event, fn),
        getOSProcessId: () => 0,
        loadURL: () => (entry.destroyed ? Promise.reject(new Error('destroyed')) : page.load ? page.load() : Promise.reject(Object.assign(new Error('ERR_FAILED'), { code: 'ERR_FAILED' }))),
        executeJavaScript: (code: string) => {
          entry.scripts.push(code)
          if (entry.destroyed) return Promise.reject(new Error('destroyed'))
          if (code.includes('rendererReady')) return Promise.resolve(page.ready ? page.ready() : true)
          const m = /^window\.renderFrame\((.*)\)$/s.exec(code)
          if (m && page.frame) return Promise.resolve(page.frame(JSON.parse(m[1]) as Record<string, unknown>))
          return new Promise(() => undefined)
        },
      }
    }
    isDestroyed() {
      return this.entry.destroyed
    }
    destroy() {
      this.entry.destroyed = true
    }
  }
  const size = opts.size ?? { width: 1280, height: 800 }
  const electron = {
    app: { isPackaged: Boolean(opts.packaged), getAppMetrics: () => [] },
    BrowserWindow: FakeWindow,
    protocol: {
      registerSchemesAsPrivileged: (list: unknown[]) => log.privileged.push(...list),
      handle: (scheme: string) => log.globalHandled.push(scheme),
    },
    session: {
      fromPartition: (name: string, options: unknown) => {
        log.partitions.push({ name, options })
        return fakeSession
      },
    },
    nativeImage: {
      createFromBuffer: () => ({ getSize: () => size, toBitmap: () => (opts.bitmap ? opts.bitmap() : variedBitmap(size.width, size.height)) }),
    },
  }
  return { electron, log, session: fakeSession }
}

/** 여러 색이 섞인 BGRA 비트맵(빈 그림 아님). */
function variedBitmap(width: number, height: number): Buffer {
  const b = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4
      b[i] = (x * 7) & 255
      b[i + 1] = (y * 5) & 255
      b[i + 2] = ((x + y) * 3) & 255
      b[i + 3] = 255
    }
  }
  return b
}
const flatBitmap = (width: number, height: number) => Buffer.alloc(width * height * 4, 0xee)

/** capture.cjs와 mapRender.cjs를 같은 가짜 electron으로 새로 읽는다 — mapRender가 나중에 부르는 capture는 이 사본이다. */
function loadPair(electron: unknown): { capture: CaptureModule; map: MapModule } {
  const capturePath = req.resolve('../electron/capture.cjs')
  const mapPath = req.resolve('../electron/mapRender.cjs')
  delete req.cache[capturePath]
  delete req.cache[mapPath]
  const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown }
  const realLoad = loader._load
  loader._load = function (this: unknown, request: string, ...rest: unknown[]) {
    return request === 'electron' ? electron : realLoad.call(this, request, ...rest)
  }
  try {
    const capture = req(capturePath) as CaptureModule
    const map = req(mapPath) as MapModule
    return { capture, map }
  } finally {
    loader._load = realLoad
  }
}

const A_CENTER: [number, number] = [126.71987318135001, 35.9863352216531]
const A_BOUNDS: Bounds = [126.69756400298331, 35.97505214547359, 126.74218235971676, 35.997616684538606]
const B_CENTER: [number, number] = [126.69734283669038, 35.9601922754505]
const B_BOUNDS: Bounds = [126.656, 35.93927454816345, 126.73868567338076, 35.98110446391171]
const marker = (lng: number, lat: number, kind = 'attraction', label = '시험 장소'): Marker => ({ lng, lat, kind, label })
const validSpec = (extra: Record<string, unknown> = {}) => ({
  center: A_CENTER,
  zoom: 14.3,
  markers: [marker(126.7155, 35.9899, 'attraction', '시험 관광지'), marker(126.7262, 35.9831, 'food', '시험 식당')],
  areaLabels: true,
  ...extra,
})
const goodFrame = (pageSpec: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  ok: true,
  png: `data:image/png;base64,${Buffer.from('fake-png').toString('base64')}`,
  stats: {
    errors: [],
    timings: { styleMs: 3, loadMs: 120, idleMs: 200, overlayMs: 230, encodeMs: 260 },
    gl: { webgl2: true, renderer: 'ANGLE (fake)' },
    zoom: pageSpec.zoom,
    bounds: A_BOUNDS,
    base: { colors: 110, dominantShare: 0.37 },
    labels: { placed: 2, dropped: [] },
    areaLabels: ['시험동'],
    markersOutside: [],
    ...extra,
  },
})

// ── 지도 데이터 · 알림 · 묶음 설정 ─────────────────────────────────────────

{
  const buf = readFileSync(MAP_FILE)
  ok(`지도 데이터 — 크기 ${MAP_SIZE}바이트 · sha256이 잘라 낸 원본과 같다`, buf.length === MAP_SIZE && createHash('sha256').update(buf).digest('hex') === MAP_SHA256)
  const head = buf.subarray(0, 127)
  const box = [102, 106, 110, 114].map((at) => head.readInt32LE(at) / 1e7)
  ok('지도 데이터 — PMTiles v3 · 줌 0–15', head.toString('ascii', 0, 7) === 'PMTiles' && head[7] === 3 && head[100] === 0 && head[101] === 15)
  const attrs = readFileSync(path.join(ROOT, '.gitattributes'), 'utf8')
  ok('.gitattributes — *.pmtiles는 binary(줄 끝을 바꾸지 않는다)', /^\*\.pmtiles\s+binary\s*$/m.test(attrs))
  const notice = lf(readFileSync(path.join(ROOT, 'map-data', 'NOTICE-OSM.txt'), 'utf8'))
  const maplibreLicense = lf(readFileSync(path.join(path.dirname(req.resolve('maplibre-gl/package.json')), 'LICENSE.txt'), 'utf8')).trim()
  const pmtilesLicense = lf(readFileSync(path.join(ROOT, 'map-data', 'pmtiles.LICENSE.txt'), 'utf8')).trim()
  ok(
    '알림 파일 — ODbL 알림(© OpenStreetMap contributors · ODbL 1.0 · 저작권 주소 · 원본 빌드)',
    notice.includes('© OpenStreetMap contributors') &&
      notice.includes('Open Database License(ODbL) 1.0') &&
      notice.includes('https://www.openstreetmap.org/copyright') &&
      notice.includes('https://opendatacommons.org/licenses/odbl/1-0/') &&
      notice.includes('20261103'),
  )
  ok('알림 파일 — maplibre-gl LICENSE.txt 원문 · pmtiles 라이선스 글(fflate 포함)을 그대로 담는다', notice.includes(maplibreLicense) && notice.includes(pmtilesLicense) && pmtilesLicense.includes('fflate'))
  const builder = lf(readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8'))
  ok('electron-builder.yml — files에 dist-electron/map-vendor/**/*', /^\s+- dist-electron\/map-vendor\/\*\*\/\*(\s+#.*)?$/m.test(builder))
  ok(
    'electron-builder.yml — extraResources: 지도 데이터 → map/gunsan.pmtiles · 알림 → map/NOTICE-OSM.txt',
    /- from: map-data\/gunsan-20261103\.pmtiles\n\s+to: map\/gunsan\.pmtiles/.test(builder) && /- from: map-data\/NOTICE-OSM\.txt\n\s+to: map\/NOTICE-OSM\.txt/.test(builder),
  )
  const vercelIgnore = lf(readFileSync(path.join(ROOT, '.vercelignore'), 'utf8'))
  ok('.vercelignore — 지도 데이터는 웹 배포에 올리지 않는다', /^map-data\/?$/m.test(vercelIgnore))
  ok('Vite public/에 지도 파일을 두지 않는다', !existsSync(path.join(ROOT, 'public', 'gunsan.pmtiles')) && !existsSync(path.join(ROOT, 'public', 'map')))
  const buildScript = readFileSync(path.join(ROOT, 'scripts', 'build-electron-server.mjs'), 'utf8')
  ok(
    '묶음 스크립트 — maplibre-gl(mjs · worker · css · LICENSE) · pmtiles(js · 라이선스)를 dist-electron/map-vendor로',
    buildScript.includes('dist-electron/map-vendor') &&
      ['maplibre-gl.mjs', 'maplibre-gl-worker.mjs', 'maplibre-gl.css', 'maplibre-gl.LICENSE.txt', 'pmtiles.js', 'pmtiles.LICENSE.txt'].every((f) => buildScript.includes(`'${f}'`)),
  )
  const main = readFileSync(path.join(ROOT, 'electron', 'main.cjs'), 'utf8')
  const reg = main.indexOf('registerMapScheme()')
  ok('main.cjs — osmmap 스킴을 app ready 전에 등록한다', reg > 0 && reg < main.indexOf('app.whenReady('))
  const disposeFn = /function disposeCaptureWindows\(\) \{[\s\S]*?\n\}/.exec(main)?.[0] ?? ''
  ok('main.cjs — 앱 종료(disposeCaptureWindows)에서 지도 그리기도 끝낸다', disposeFn.includes('disposeMapRender()'))
  ok('지도 데이터 머리말 범위 = COVER(틀은 이 안에만)', JSON.stringify(box) === JSON.stringify([126.28, 35.7, 126.92, 36.07]))
}

// ── 스타일(electron/map/style.json) ─────────────────────────────────────

{
  const style = JSON.parse(readFileSync(path.join(ROOT, 'electron', 'map', 'style.json'), 'utf8')) as {
    glyphs?: string
    sprite?: string
    sources: Record<string, { type: string; url: string }>
    layers: { id: string; type: string; 'source-layer'?: string; filter?: unknown }[]
  }
  ok('스타일 — 글꼴(glyphs) · 스프라이트 · symbol 레이어가 없다(글꼴 서버를 부르지 않는다)', !('glyphs' in style) && !('sprite' in style) && style.layers.every((l) => l.type !== 'symbol'))
  const urls = Object.values(style.sources).map((s) => s.url)
  ok('스타일 — 타일은 osmmap://app/gunsan.pmtiles 하나뿐', urls.length === 1 && urls[0] === 'pmtiles://osmmap://app/gunsan.pmtiles')
  const last = style.layers[style.layers.length - 1]
  ok('스타일 — 맨 위 mask-military가 군사 · 비행장 땅을 바탕색으로 덮는다', last.id === 'mask-military' && JSON.stringify(last.filter).includes('airfield') && JSON.stringify(last.filter).includes('military'))
  const roads = style.layers.filter((l) => l['source-layer'] === 'roads' && l.id !== 'ferry')
  ok('스타일 — 모든 도로 레이어에서 aeroway(활주로 · 유도로)를 뺀다', roads.length > 5 && roads.every((l) => JSON.stringify(l.filter).includes('"aeroway"')))
  const landuse = style.layers.filter((l) => l['source-layer'] === 'landuse' && l.id !== 'mask-military')
  ok('스타일 — 땅 쓰임 채움은 군사 · 비행장을 칠하지 않는다', landuse.length > 5 && landuse.every((l) => JSON.stringify(l.filter).includes('"!"') && JSON.stringify(l.filter).includes('military')))
}

// ── 순수 부분: Range · 요청 막기 · spec · 틀 ────────────────────────────

{
  const { map } = loadPair(fakeElectron().electron)
  const S = 1000
  ok('Range — bytes=0-99 → 0..99', JSON.stringify(map.parseRange('bytes=0-99', S)) === '{"start":0,"end":99}')
  ok('Range — bytes=900- → 900..999(끝까지)', JSON.stringify(map.parseRange('bytes=900-', S)) === '{"start":900,"end":999}')
  ok('Range — 끝이 크기를 넘으면 마지막 바이트까지', JSON.stringify(map.parseRange('bytes=990-5000', S)) === '{"start":990,"end":999}')
  ok(
    'Range — 시작이 크기 이상 · 시작 > 끝 · 접미(-500) · 여러 구간 · 다른 단위 · 없음은 받지 않는다',
    ['bytes=1000-', 'bytes=5-3', 'bytes=-500', 'bytes=0-1,4-5', 'items=0-9', '', undefined, null, 'bytes=a-b', 'bytes= 0-9x'].every((h) => map.parseRange(h, S) === null),
  )

  const job = { wcId: 7 }
  const block = (url: string, method = 'GET', webContentsId: number | undefined = 7) => map.requestBlockReason({ url, method, webContentsId }, job)
  ok(
    '요청 막기 — osmmap://app의 GET · data: · blob: · 창 id 없음(워커)은 통과',
    block('osmmap://app/render.html') === null && block('data:image/png;base64,AAAA') === null && block('blob:osmmap://app/1234') === null && block('osmmap://app/gunsan.pmtiles', 'GET', undefined) === null,
  )
  ok(
    '요청 막기 — http · https · ws · wss · file · 다른 호스트 · GET 아님 · 다른 창 · 작업 없음은 막는다',
    block('https://tile.openstreetmap.org/1/1/1.png') !== null &&
      block('http://127.0.0.1:4000/api/health') !== null &&
      block('ws://localhost:5173/') !== null &&
      block('wss://example.com/') !== null &&
      block('file:///C:/Windows/win.ini') !== null &&
      block('osmmap://evil/render.html') !== null &&
      block('osmmap://app/render.html', 'POST') !== null &&
      block('osmmap://app/render.html', 'GET', 8) !== null &&
      map.requestBlockReason({ url: 'osmmap://app/render.html', method: 'GET', webContentsId: 7 }, null) !== null &&
      map.requestBlockReason({ url: 'osmmap://app/render.html', method: 'GET', webContentsId: 7 }, { wcId: 7, finished: true }) !== null,
  )

  const spec = map.validateMapSpec(validSpec())
  ok(
    'spec — 맞는 요청은 기본값을 채운다(1280×800 · 범례 켬 · 동 이름 4 · 한도 20초)',
    spec.width === 1280 && spec.height === 800 && spec.legend === true && spec.areaLabels === true && spec.maxAreaLabels === 4 && spec.timeoutMs === 20000 && spec.markers.length === 2,
  )
  const bad = (label: string, s: unknown) => ok(`spec — ${label}이면 bad-spec`, codeOfSync(() => map.validateMapSpec(s)) === 'bad-spec')
  bad('객체가 아님', null)
  bad('배열', [])
  bad('모르는 키', validSpec({ style: 'x' }))
  bad('크기가 1280×800이 아님', validSpec({ width: 1000 }))
  bad('줌 10 미만', validSpec({ zoom: 9.99 }))
  bad('줌 17 초과', validSpec({ zoom: 17.01 }))
  bad('줌이 숫자 아님', validSpec({ zoom: '14' }))
  bad('줌 NaN', validSpec({ zoom: Number.NaN }))
  bad('중심이 무한', validSpec({ center: [Number.POSITIVE_INFINITY, 35.9] }))
  bad('중심 좌표가 셋', validSpec({ center: [126.7, 35.9, 1] }))
  bad('표지 0개', validSpec({ markers: [] }))
  bad('표지 31개', validSpec({ markers: Array.from({ length: 31 }, (_v, i) => marker(126.71 + i * 0.0001, 35.986)) }))
  bad('이름 41자', validSpec({ markers: [marker(126.7155, 35.9899, 'attraction', '가'.repeat(41))] }))
  bad('이름 빈 글', validSpec({ markers: [marker(126.7155, 35.9899, 'attraction', '  ')] }))
  bad('이름에 제어 문자', validSpec({ markers: [marker(126.7155, 35.9899, 'attraction', '시험\u0007')] }))
  bad('모르는 종류', validSpec({ markers: [marker(126.7155, 35.9899, 'hotel')] }))
  bad('표지의 모르는 키', validSpec({ markers: [{ ...marker(126.7155, 35.9899), url: 'https://example.com/' }] }))
  bad('표지 좌표가 글자', validSpec({ markers: [{ ...marker(126.7155, 35.9899), lng: '126.7' }] }))
  bad('동 이름 수가 범위 밖', validSpec({ maxAreaLabels: 99 }))
  bad('한도가 범위 밖', validSpec({ timeoutMs: 120000 }))
  bad('켬/끔이 참거짓 아님', validSpec({ legend: 'yes' }))
  ok('spec — 이름 40자는 받는다', codeOfSync(() => map.validateMapSpec(validSpec({ markers: [marker(126.7155, 35.9899, 'stay', '가'.repeat(40))] }))) === 'ok')

  const near = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-9)
  ok('틀 — center · zoom · 1280×800으로 계산한 범위가 시험 틀(원도심 · 은파)과 같다', near(map.frameBounds(A_CENTER, 14.3), A_BOUNDS) && near(map.frameBounds(B_CENTER, 13.41), B_BOUNDS))
  ok('틀 — 공군기지 상자 동쪽 끝에 맞닿은 틀(은파)은 통과', codeOfSync(() => map.assertFrame(map.frameBounds(B_CENTER, 13.41))) === 'ok')
  const shifted = map.frameBounds([B_CENTER[0] - 0.0005, B_CENTER[1]], 13.41)
  ok('틀 — 상자에 조금이라도 들어가면 avoid-area', codeOfSync(() => map.assertFrame(shifted)) === 'avoid-area')
  ok('틀 — 기지 위 틀은 avoid-area', codeOfSync(() => map.assertFrame(map.frameBounds([126.627, 35.914], 13))) === 'avoid-area')
  ok('틀 — 데이터 범위(COVER) 밖으로 나가면 out-of-cover', codeOfSync(() => map.assertFrame(map.frameBounds([126.3, 35.72], 13))) === 'out-of-cover')
  ok('틀 — 표지가 틀 밖이면 bad-spec', codeOfSync(() => map.assertFrame(A_BOUNDS, [{ lng: 126.80, lat: 35.99 }])) === 'bad-spec')
  ok('틀 — 범위가 숫자 넷이 아니면 bad-spec', codeOfSync(() => map.assertFrame([126.7, 35.9, Number.NaN, 36])) === 'bad-spec')
  ok('상자 값 — AVOID · COVER', JSON.stringify(map.AVOID) === '[126.598,35.876,126.656,35.952]' && JSON.stringify(map.COVER) === '[126.28,35.7,126.92,36.07]')
}

// ── osmmap:// 파일 주기(개발 경로 · 실제 파일) ─────────────────────────────

{
  const { map } = loadPair(fakeElectron().electron)
  const get = (url: string, headers: Record<string, string> = {}, method = 'GET') => map.serveMapRequest({ url, method, headers: new Headers(headers) })
  const html = get('osmmap://app/render.html')
  const htmlText = await html.text()
  ok('render.html — 200 · CSP 머리말 · text/html', html.status === 200 && html.headers.get('content-security-policy') === map.CSP && (html.headers.get('content-type') ?? '').startsWith('text/html') && htmlText.includes('render.js'))
  ok(
    'CSP — 바깥 출처 없음(default none · 스크립트 · 연결은 osmmap://app만 · 글꼴 none)',
    map.CSP.includes("default-src 'none'") && map.CSP.includes('connect-src osmmap://app;') && map.CSP.includes("font-src 'none'") && !/https?:/.test(map.CSP) && !map.CSP.includes('unsafe-eval'),
  )
  const js = get('osmmap://app/maplibre-gl.mjs')
  ok('maplibre-gl.mjs · worker · css · pmtiles.js · render.js · style.json — 200(모듈은 text/javascript)', js.status === 200 && (js.headers.get('content-type') ?? '').startsWith('text/javascript') && ['/maplibre-gl-worker.mjs', '/maplibre-gl.css', '/pmtiles.js', '/render.js', '/style.json'].every((p) => get(`osmmap://app${p}`).status === 200))
  const fd = openSync(MAP_FILE, 'r')
  const first = Buffer.alloc(16384)
  readSync(fd, first, 0, first.length, 0)
  const tail = Buffer.alloc(203)
  readSync(fd, tail, 0, tail.length, MAP_SIZE - 203)
  closeSync(fd)
  const r1 = get('osmmap://app/gunsan.pmtiles', { range: 'bytes=0-16383' })
  const b1 = Buffer.from(await r1.arrayBuffer())
  ok(
    '.pmtiles — bytes=0-16383 → 206 · Content-Range · Content-Length · 같은 바이트',
    r1.status === 206 && r1.headers.get('content-range') === `bytes 0-16383/${MAP_SIZE}` && r1.headers.get('content-length') === '16384' && r1.headers.get('accept-ranges') === 'bytes' && b1.equals(first),
  )
  const r2 = get('osmmap://app/gunsan.pmtiles', { range: `bytes=${MAP_SIZE - 203}-` })
  ok('.pmtiles — 끝까지(bytes=a-) → 206 · 마지막 바이트까지', r2.status === 206 && Buffer.from(await r2.arrayBuffer()).equals(tail))
  const range416 = (h: Record<string, string>) => {
    const r = get('osmmap://app/gunsan.pmtiles', h)
    return r.status === 416 && r.headers.get('content-range') === `bytes */${MAP_SIZE}`
  }
  ok('.pmtiles — Range 없음 → 416(파일 통째로 주지 않는다)', range416({}))
  ok('.pmtiles — 범위 밖 · 거꾸로 · 접미 · 여러 구간 → 416', range416({ range: `bytes=${MAP_SIZE}-` }) && range416({ range: 'bytes=5-3' }) && range416({ range: 'bytes=-500' }) && range416({ range: 'bytes=0-1,4-5' }))
  ok('.pmtiles — 한 번에 너무 큰 구간(bytes=0-) → 416', range416({ range: 'bytes=0-' }))
  const notFound = (url: string, method = 'GET') => get(url, {}, method).status === 404
  ok('GET 아님(POST · HEAD · PUT) → 404', notFound('osmmap://app/render.html', 'POST') && notFound('osmmap://app/render.html', 'HEAD') && notFound('osmmap://app/gunsan.pmtiles', 'PUT'))
  ok(
    '허용 목록 밖 → 404(다른 호스트 · 상위 경로 · 앱 파일 · 대소문자 · 지도 원본 이름 · source map · 뿌리)',
    [
      'osmmap://evil/render.html',
      'osmmap://app/../map-data/gunsan-20261103.pmtiles',
      'osmmap://app/%2e%2e/electron/main.cjs',
      'osmmap://app/electron/main.cjs',
      'osmmap://app/main.cjs',
      'osmmap://app/RENDER.HTML',
      'osmmap://app/gunsan-20261103.pmtiles',
      'osmmap://app/maplibre-gl.mjs.map',
      'osmmap://app/',
      'osmmap://user:pw@app/render.html',
      'osmmap://app:81/render.html',
    ].every((u) => notFound(u)),
  )
  const paths = map.mapPaths()
  ok('개발 경로 — 지도 데이터는 map-data/gunsan-20261103.pmtiles · 페이지는 electron/map', paths.pmtiles === MAP_FILE && paths.files['/render.html'][0] === path.join(ROOT, 'electron', 'map', 'render.html'))
}

// ── 설치본 경로 ─────────────────────────────────────────────────────────

{
  const proc = process as unknown as { resourcesPath?: string }
  const before = proc.resourcesPath
  proc.resourcesPath = path.join('X:', 'Web4AI', 'resources')
  try {
    const { map } = loadPair(fakeElectron({ packaged: true }).electron)
    const paths = map.mapPaths()
    const vendor = path.join(ROOT, 'dist-electron', 'map-vendor')
    ok(
      '설치본 경로 — 지도 데이터는 resources/map/gunsan.pmtiles(asar 밖) · 라이브러리는 dist-electron/map-vendor',
      paths.pmtiles === path.join('X:', 'Web4AI', 'resources', 'map', 'gunsan.pmtiles') &&
        ['/maplibre-gl.mjs', '/maplibre-gl-worker.mjs', '/maplibre-gl.css', '/pmtiles.js'].every((p) => path.dirname(paths.files[p][0]) === vendor),
    )
    // 지도 데이터가 빠진 설치본 — 처리기는 던지지 않고 500으로 답한다(까닭은 로그에)
    const fake = fakeElectron({ packaged: true })
    const pair = loadPair(fake.electron)
    await codeOf(pair.map.renderMap(validSpec()))
    const missing = fake.log.schemeHandler?.({ url: 'osmmap://app/gunsan.pmtiles', method: 'GET', headers: new Headers({ range: 'bytes=0-99' }) })
    ok('파일이 없으면 osmmap 처리기는 500(던지지 않는다)', missing?.status === 500)
  } finally {
    proc.resourcesPath = before
  }
}

// ── 스킴 등록 · 서버 다리 · 줄 · 한도 · 종료(가짜 electron) ──────────────

{
  const fake = fakeElectron()
  const { map } = loadPair(fake.electron)
  map.registerMapScheme()
  const priv = fake.log.privileged as { scheme: string; privileges: Record<string, boolean> }[]
  ok(
    '스킴 등록 — osmmap을 standard · secure · fetch · CORS · stream 특권 스킴으로(처리기는 전역에 걸지 않는다)',
    priv.length === 1 && priv[0].scheme === 'osmmap' && ['standard', 'secure', 'supportFetchAPI', 'corsEnabled', 'stream'].every((k) => priv[0].privileges[k] === true) && fake.log.globalHandled.length === 0,
  )

  ok('서버 다리 — 모양이 아니면 답하지 않는다(null)', (await map.handleMapRequest(null)) === null && (await map.handleMapRequest({ type: 'screen-capture', id: 'a' })) === null && (await map.handleMapRequest({ type: 'map-render', id: '../x', spec: validSpec() })) === null && (await map.handleMapRequest({ type: 'map-render', id: 'x'.repeat(65), spec: validSpec() })) === null)
  const badReply = await map.handleMapRequest({ type: 'map-render', id: 'm-1', spec: validSpec({ zoom: 30 }) })
  ok('서버 다리 — 틀린 spec은 ok false · bad-spec 답', badReply?.type === map.MAP_RESULT_TYPE && badReply?.id === 'm-1' && badReply?.ok === false && badReply?.code === 'bad-spec')
  const avoidReply = await map.handleMapRequest({ type: 'map-render', id: 'm-2', spec: validSpec({ center: [126.627, 35.914], zoom: 13, markers: [marker(126.62, 35.92)] }) })
  ok('서버 다리 — 기지 위 틀은 그리지 않고 avoid-area 답', avoidReply?.ok === false && avoidReply?.code === 'avoid-area')
  ok('잘못된 요청은 창을 만들지 않는다', fake.log.windows.length === 0 && fake.log.partitions.length === 0)
}

{
  // 성공(가짜 페이지) — partition 설정 · 창 설정 · 페이지에 넘기는 spec · 결과 모양
  let pageSpec: Record<string, unknown> = {}
  const fake = fakeElectron({
    page: {
      load: () => Promise.resolve(),
      frame: (s) => {
        pageSpec = s
        return goodFrame(s)
      },
    },
  })
  const { map } = loadPair(fake.electron)
  const reply = await map.handleMapRequest({ type: 'map-render', id: 'ok-1', spec: validSpec() })
  const w = fake.log.windows[0]
  const prefs = (w?.options.webPreferences ?? {}) as Record<string, unknown>
  ok(
    '그리기 — ok 답(png base64 · 1280×800 · bounds · 이름 · 렌더러 · 시간 · 막은 요청 수)',
    reply?.ok === true && reply?.png === Buffer.from('fake-png').toString('base64') && reply?.width === 1280 && reply?.height === 800 && Array.isArray(reply?.bounds) && reply?.renderer === 'ANGLE (fake)' && typeof (reply?.timings as Record<string, number>)?.totalMs === 'number' && reply?.blockedRequests === 0,
  )
  ok(
    'partition — 메모리 전용 map-render · 맞춤법 끔 · 프록시 direct · osmmap 처리기는 이 세션에만',
    fake.log.partitions.length === 1 && fake.log.partitions[0].name === map.PARTITION && map.PARTITION === 'map-render' && fake.log.spellcheck.includes(false) && JSON.stringify(fake.log.proxy) === '[{"mode":"direct"}]' && JSON.stringify(fake.log.sessionSchemes) === '["osmmap"]' && fake.log.globalHandled.length === 0,
  )
  let granted: boolean | null = null
  fake.log.permissionRequest?.(null, 'geolocation', (v) => {
    granted = v
  })
  let prevented = false
  fake.log.sessionEvents.get('will-download')?.({ preventDefault: () => (prevented = true) })
  ok('partition — 권한 요청 · 권한 확인 · 장치 권한 거절 · 내려받기 막기', granted === false && fake.log.permissionCheck?.() === false && fake.log.devicePermission?.() === false && prevented)
  ok(
    '창 — 숨김 · 1280×800 · 오프스크린 · 샌드박스 · 격리 · Node 없음 · 맞춤법 끔 · 30fps',
    w?.options.show === false && w?.options.width === 1280 && w?.options.height === 800 && prefs.offscreen === true && prefs.sandbox === true && prefs.contextIsolation === true && prefs.nodeIntegration === false && prefs.spellcheck === false && prefs.session === fake.session && w?.frameRate === 30,
  )
  let navBlocked = 0
  const nav = w?.events.get('will-navigate')
  nav?.({ preventDefault: () => (navBlocked += 1) }, 'https://example.com/')
  nav?.({ preventDefault: () => (navBlocked += 1) }, 'osmmap://app/render.html')
  ok('창 — 새 창 거절 · osmmap://app 밖으로 이동 막기', JSON.stringify(w?.openHandler?.()) === '{"action":"deny"}' && navBlocked === 1)
  ok('창 — 끝나면 부순다', w?.destroyed === true)
  ok('페이지에 넘기는 spec — 메인의 AVOID를 함께(동 이름도 기지 안은 뺀다) · 남은 한도', JSON.stringify(pageSpec.avoid) === JSON.stringify(map.AVOID) && typeof pageSpec.timeoutMs === 'number' && (pageSpec.timeoutMs as number) <= 20000 && (pageSpec.markers as unknown[]).length === 2)

  // 요청 막기 처리기 — 지금 그리는 창이 아니면(끝난 뒤) 막는다
  let cancelled: boolean | undefined
  fake.log.onBeforeRequest?.({ url: 'osmmap://app/render.html', method: 'GET', webContentsId: 301, resourceType: 'mainFrame' }, (r) => {
    cancelled = r.cancel
  })
  ok('요청 막기 처리기 — 그리는 작업이 없을 때는 osmmap도 막는다', cancelled === true)
}

{
  const cases: [string, Record<string, unknown>, string][] = [
    ['지도 오류(타일 · 스타일)', { errors: ['tile failed'] }, 'map-error'],
    ['그린 뒤 범위가 기지와 겹침', { bounds: map0Shift() }, 'avoid-area'],
    ['바탕이 한 가지 색', { base: { colors: 1, dominantShare: 1 } }, 'blank'],
    ['표지가 그림 밖', { markersOutside: ['시험 식당'] }, 'marker-outside'],
  ]
  for (const [label, extra, want] of cases) {
    const fake = fakeElectron({ page: { load: () => Promise.resolve(), frame: (s) => goodFrame(s, extra) } })
    const { map } = loadPair(fake.electron)
    ok(`그린 뒤 검사 — ${label}이면 ${want}`, (await codeOf(map.renderMap(validSpec()))) === want && fake.log.windows[0]?.destroyed === true)
  }
  const webgl = fakeElectron({ page: { load: () => Promise.resolve(), frame: () => ({ ok: false, code: 'webgl-unavailable', message: 'Failed to initialize WebGL' }) } })
  ok('페이지 실패 — WebGL 없음은 webgl-unavailable', (await codeOf(loadPair(webgl.electron).map.renderMap(validSpec()))) === 'webgl-unavailable')
  const sized = fakeElectron({ page: { load: () => Promise.resolve(), frame: (s) => goodFrame(s) }, size: { width: 1000, height: 800 } })
  ok('결과 검사 — 1280×800이 아니면 bad-size', (await codeOf(loadPair(sized.electron).map.renderMap(validSpec()))) === 'bad-size')
  const blank = fakeElectron({ page: { load: () => Promise.resolve(), frame: (s) => goodFrame(s) }, bitmap: () => flatBitmap(1280, 800) })
  ok('결과 검사 — 빈 그림(한 가지 색)이면 blank', (await codeOf(loadPair(blank.electron).map.renderMap(validSpec()))) === 'blank')
}

{
  // 화면 찍기와 같은 줄 — 앞 일이 끝나기 전에는 창을 만들지 않는다
  const fake = fakeElectron()
  const { capture, map } = loadPair(fake.electron)
  let release: (v: string) => void = () => undefined
  const first = capture.runQueued(() => new Promise<string>((r) => (release = r)))
  const drawn = codeOf(map.renderMap(validSpec()))
  await sleep(150)
  const beforeRelease = fake.log.windows.length
  release('done')
  await first
  const code = await drawn
  ok('줄 — 그리기는 화면 찍기 뒤에 선다(앞 일 끝난 뒤 창 하나)', beforeRelease === 0 && fake.log.windows.length === 1 && code === 'load-failed' && fake.log.windows[0].destroyed)
}

{
  // 한도 — 페이지가 준비되지 않으면 timeoutMs 뒤 timeout, 창은 부순다
  const fake = fakeElectron({ page: { load: () => Promise.resolve(), ready: () => false } })
  const { map } = loadPair(fake.electron)
  const t0 = Date.now()
  const code = await codeOf(map.renderMap(validSpec({ timeoutMs: 3000 })))
  const took = Date.now() - t0
  ok(`한도 — 3초 안에 준비되지 않으면 timeout(${took}ms) · 창 부숨`, code === 'timeout' && took >= 2900 && took < 6000 && fake.log.windows[0]?.destroyed === true)
}

{
  // 앱 종료 — 그리는 중이면 바로 끝내고 창을 부수며, 그 뒤 요청은 창 없이 disposed
  const fake = fakeElectron({ page: { load: () => new Promise(() => undefined) } })
  const { map } = loadPair(fake.electron)
  const t0 = Date.now()
  const pending = codeOf(map.renderMap(validSpec()))
  await sleep(100)
  map.disposeMapRender()
  const code = await pending
  ok(`종료 — 그리던 것은 disposed로 바로 끝(${Date.now() - t0}ms) · 창 부숨`, code === 'disposed' && Date.now() - t0 < 1500 && fake.log.windows[0]?.destroyed === true)
  const after = await codeOf(map.renderMap(validSpec()))
  ok('종료 — 그 뒤 요청은 창을 만들지 않고 disposed', after === 'disposed' && fake.log.windows.length === 1)
}

{
  // relayCaptureRequests — 'map-render'는 지도로, 답은 'map-render-result'. 서버가 바뀌었으면 답하지 않는다.
  const fake = fakeElectron()
  const { capture } = loadPair(fake.electron)
  const make = () => {
    const posted: Record<string, unknown>[] = []
    let listener: (msg: unknown) => void = () => undefined
    return {
      posted,
      child: {
        on: (_e: 'message', fn: (msg: unknown) => void) => {
          listener = fn
        },
        postMessage: (msg: unknown) => posted.push(msg as Record<string, unknown>),
      },
      emit: (msg: unknown) => listener(msg),
    }
  }
  const a = make()
  capture.relayCaptureRequests(a.child, () => true)
  a.emit({ type: 'map-render', id: 'r-1', spec: validSpec({ markers: [] }) })
  a.emit({ type: 'set-env', name: 'X', value: 'y' })
  await sleep(50)
  ok('다리 — map-render 요청에 map-render-result로 답한다(다른 type은 지나친다)', a.posted.length === 1 && a.posted[0].type === 'map-render-result' && a.posted[0].id === 'r-1' && a.posted[0].code === 'bad-spec')
  const b = make()
  capture.relayCaptureRequests(b.child, () => false)
  b.emit({ type: 'map-render', id: 'r-2', spec: validSpec({ markers: [] }) })
  await sleep(50)
  ok('다리 — 그사이 서버가 바뀌었으면 답하지 않는다', b.posted.length === 0)
}

function map0Shift(): Bounds {
  return [126.65, 35.93927454816345, 126.73268567338076, 35.98110446391171]
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
