/**
 * 자사 화면 캡처 1차(서버 쪽)를 확인한다 — 프로필 표 · 화면 id · 앱 주소 · 저장(screens.json) · 같은 날 다시 쓰기 · 메인 프로세스 다리 ·
 * 화면 라우트(/api/screens) · 사진 PUT(origin screen) · 사진 받기 · 같은 화면 상한(server/contentDraft.ts saveAutoPhotoPicks).
 * 가짜 PNG · 가짜 브랜드만 쓰고 임시 폴더를 APP_DATA_DIR로 쓴다. 다리는 가짜 parentPort로 시험한다(Electron · 바깥 사이트 · AI를 부르지 않는다).
 * HTTP 부분은 서버(server/index.ts)를 포트 4108에 띄운다 — 자식 프로세스라 parentPort가 없어 찍기는 쓸 수 없다(그것도 확인한다).
 * 캡처 모듈(electron/capture.cjs)은 electron을 가짜로 바꿔 읽고(창을 열지 않는다), 페이지 안 그림 검사(pageInspect)는 jsdom에서 돌린다.
 *
 * 왜:
 * - 찍을 주소는 서버가 프로필에서만 만든다 — 화면이 보낸 주소 · src · alt를 믿으면 아무 사이트나 찍거나 글에 남의 주소가 들어간다.
 * - 화면 파일 라우트는 경로를 받는다 — 정해진 id 모양 · 목록에 있는 것만 주지 않으면 데이터 폴더의 다른 파일이 새어 나간다.
 * - 카카오 지도 이용 조건을 확인하기 전에는 지도 화면이 글에 들어가면 안 된다(결정 4) — 화면이 막아도 서버가 다시 막아야 한다.
 * - 같은 화면은 「화면 + 변형」 단위로 글 하나 · 작성자 한 사람에게 한 번, 브랜드 상한 3은 받지 않는다(결정 3) — 다른 날 다시 찍어
 *   파일이 달라져도 같은 화면으로 세야 한다.
 * - 앱이 끝난 뒤에 캡처 창이 새로 생기면 종료가 늦어지고 자사 사이트를 한 번 더 연다 — 주소를 확인하는 동안 끝나도 창을 만들지 않아야 한다.
 * - 첫 화면의 바깥 그림 · 공공누리 그림은 <html> · <body> 배경이나 웹 컴포넌트(shadow root) 안에 있어도 잡아야 한다.
 * - 잘라 찍기(장소 안내 · 가이드)는 사각형에 걸친 그림만 본다 — 밖의 공공누리 사진 때문에 버리면 안 되고, 안에 걸치면 버려야 한다.
 *   사각형이 화면보다 크거나 머리에 가리면 찍지 않아야 한다(잘린 그림 · 가린 그림이 글에 들어간다).
 * - 장소 안내 변형(장소 이름)은 화면이 보낸 값이다 — 모양 · 사이트 장소 목록을 보지 않으면 아무 경로나 찍는다.
 * - 설명 줄의 시각 · 요금이 찍은 글자에 없으면 「확인 필요」여야 한다(틀린 화면이 사실처럼 나간다).
 *
 *   npx tsx scripts/verify-screen-capture.ts
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import dns from 'node:dns'
import Module, { createRequire } from 'node:module'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { JSDOM, VirtualConsole } from 'jsdom'

const root = mkdtempSync(path.join(tmpdir(), 'verify-screen-capture-'))
const unitDir = path.join(root, 'unit')
const httpDir = path.join(root, 'http')
mkdirSync(unitDir, { recursive: true })
mkdirSync(httpDir, { recursive: true })
process.env.APP_DATA_DIR = unitDir
process.env.BLOB_READ_WRITE_TOKEN = ''
process.env.BLOB_STORE_ID = ''

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

// ── 가짜 PNG(1280×800, 첫 픽셀만 다르게) ─────────────────────────────────
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0)
  return Buffer.concat([len, body, crc])
}
const fakePng = (seed: number, width = 1280, height = 800) => {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc((1 + width * 3) * height)
  raw[1] = seed & 0xff
  raw[2] = (seed >> 8) & 0xff
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const sha16 = (b: Buffer) => createHash('sha256').update(b).digest('hex').slice(0, 16)

/** 가짜 parentPort — 보낸 메시지를 모으고, emit으로 메인의 답을 흉내 낸다. */
class FakePort {
  listeners: ((e: { data?: unknown }) => void)[] = []
  posted: Record<string, unknown>[] = []
  onPost: ((msg: Record<string, unknown>) => void) | null = null
  throwOnPost = false
  on(_event: 'message', fn: (e: { data?: unknown }) => void) {
    this.listeners.push(fn)
    return this
  }
  postMessage(msg: unknown) {
    if (this.throwOnPost) throw new Error('port closed')
    this.posted.push(msg as Record<string, unknown>)
    this.onPost?.(msg as Record<string, unknown>)
  }
  emit(data: unknown) {
    for (const fn of this.listeners) fn({ data })
  }
}
const flush = () => new Promise((r) => setTimeout(r, 0))
const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
    return 'resolved'
  } catch (err) {
    return (err as { code?: string }).code ?? 'no-code'
  }
}

/** 캡처 모듈의 페이지 안 그림 검사(pageInspect) 결과. */
interface InspectResult {
  images: number
  mapImages: number
  foreign: string[]
  kogl: number
  frames: string[]
}

type Rect = { x: number; y: number; width: number; height: number }
type Box = { x: number; y: number; w: number; h: number }
interface ClipState {
  missing: string[]
  rects: Box[]
  /** 넣지 않는 보이는 요소의 잉크 상자(문서 좌표) — 잘라 찍을 사각형(여백 포함)에 걸친 것. core는 번짐을 뺀 진한 부분. */
  obstacles?: (Box & { core?: Box; d?: string })[]
  text: string
  cover: number
  docWidth: number
  docHeight: number
}
interface CaptureModule {
  captureScreen: (url: string, options: Record<string, unknown>) => Promise<unknown>
  disposeCapture: () => void
  pageInspect: (ownHost: string, mapSelector: string | null, mapHosts: string[], region?: Rect | null, firstHeight?: number) => InspectResult
  pageClipState: (selectors: string[], optional: string[], firstHeight: number, padding?: number) => ClipState
  pageClipCovers: (selectors: string[], optional: string[], region: Rect) => string[]
  pageDecode: () => Promise<{ count: number; failed: number }>
  clipPlan: (
    rects: Box[],
    padding: number,
    page: { docWidth: number; docHeight: number; viewWidth: number; viewHeight: number; scrollX: number; scrollY: number; cover: number; obstacles?: (Box & { core?: Box })[] },
  ) => { rect: Rect | null; scrollY: number; problem: string | null }
  requestBlockReason: (details: { url: string; method?: string; resourceType?: string }, ctx: Record<string, unknown>) => Promise<string | null>
  countClosedShadowRoots: (node: unknown) => number
}

/** 캡처 모듈을 새로 읽는다(모듈 캐시를 비우고) — 가짜 electron마다 모듈 상태(종료 여부 · 줄)가 따로다. */
function requireCaptureFresh(fakeElectron: unknown): CaptureModule {
  const req = createRequire(import.meta.url)
  delete req.cache[req.resolve('../electron/capture.cjs')]
  const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown }
  const realLoad = loader._load
  loader._load = function (this: unknown, request: string, ...rest: unknown[]) {
    return request === 'electron' ? fakeElectron : realLoad.call(this, request, ...rest)
  }
  try {
    return req('../electron/capture.cjs') as CaptureModule
  } finally {
    loader._load = realLoad
  }
}

/**
 * 캡처 모듈(electron/capture.cjs)을 가짜 electron으로 읽는다 — 창은 만든 수만 세고, 빈 페이지를 여는 순간 실패해 바로 끝난다. 모듈의
 * 상태(종료 여부)는 이 사본에만 남는다.
 */
function loadCaptureModule(): CaptureModule & { windowsCreated: () => number } {
  let created = 0
  const noop = () => undefined
  class FakeWindow {
    destroyed = false
    webContents = {
      id: 77,
      debugger: { isAttached: () => false, detach: noop, attach: noop, on: noop, sendCommand: () => new Promise(noop) },
      setFrameRate: noop,
      setWindowOpenHandler: noop,
      on: noop,
      getOSProcessId: () => 0,
      getURL: () => '',
      loadURL: () => Promise.reject(Object.assign(new Error('ERR_ABORTED'), { code: 'ERR_ABORTED' })),
    }
    constructor() {
      created += 1
    }
    isDestroyed() {
      return this.destroyed
    }
    destroy() {
      this.destroyed = true
    }
  }
  const fakeSession = {
    setPermissionRequestHandler: noop,
    setPermissionCheckHandler: noop,
    setDevicePermissionHandler: noop,
    setSpellCheckerEnabled: noop,
    on: noop,
    webRequest: { onBeforeRequest: noop },
    clearStorageData: () => Promise.resolve(),
  }
  const fakeElectron = { app: { getAppMetrics: () => [] }, BrowserWindow: FakeWindow, nativeImage: {}, session: { fromPartition: () => fakeSession } }
  return { ...requireCaptureFresh(fakeElectron), windowsCreated: () => created }
}

/**
 * 가짜 페이지(captureSteps 시험)가 기록하는 것 — 잘라 찍기 스크롤 · 그림 검사 · 찍기 시각(ms), 만든 창의 옵션, 화면 흉내
 * (Emulation.setDeviceMetricsOverride) · 찍기(Page.captureScreenshot)의 인자, 일의 차례(metrics · load:<주소>).
 */
interface FakePageLog {
  scrollAt: number | null
  inspectAt: number[]
  shotAt: number | null
  windows: Record<string, unknown>[]
  metrics: Record<string, unknown>[]
  shots: Record<string, unknown>[]
  steps: string[]
}

/** 가짜 페이지로 찍은 결과(captureScreen) 또는 서버로 보낼 답(handleCaptureRequest)에서 시험이 보는 것. */
interface FakeShot {
  ok?: boolean
  width?: number
  height?: number
  scale?: number
  viewWidth?: number
  clip?: Rect | null
}

/**
 * 가짜 페이지로 캡처 한 장을 끝까지 돌린다(창 · 사이트 · 네트워크 없음) — 페이지 안 함수는 이름으로 알아보고 정해 둔 값을 돌려준다.
 * 잘라 찍기면 요소가 문서 y 2300에 있어(rects로 바꾼다) 한 번 스크롤한다 — 잘라 찍기 화면 높이(2100)보다도 아래다. 화면 크기(viewWidth ·
 * viewHeight)는 마지막 화면 흉내 값이고, 찍은 그림의 크기는 실제 CDP처럼 사각형(없으면 화면) × 화면 배율 × clip.scale이다. afterShot을
 * 주면 찍은 뒤의 그림 검사가 그 값을 돌려준다(찍는 사이에 페이지가 바뀐 것). tree는 DOM.getDocument의 뿌리, DOM.getBoxModel은 늘
 * 「상자 없음」으로 실패한다(display:contents host와 같다). relay면 서버 요청 처리(handleCaptureRequest)로 찍고 그 답을 result로 준다.
 * page를 주면 잘라 찍기의 페이지 안 함수(pageClipState · pageClipCovers · pageInspect)를 정해 둔 값 대신 그 페이지(마지막 화면 흉내 크기)에서
 * 그대로 돌린다 — captureSteps가 넘기는 인자까지 시험한다. clipOptions는 잘라 찍기 옵션({ selectors: ['h1'], padding: 16 })에 덧씌운다.
 */
async function runFakePage(opts: {
  clip: boolean
  clipOptions?: Record<string, unknown>
  tree?: unknown
  afterShot?: InspectResult
  rects?: { x: number; y: number; w: number; h: number }[]
  relay?: boolean
  page?: (view: { width: number; height: number }) => { eval: (code: string) => unknown }
}): Promise<{ code: string; log: FakePageLog; result: FakeShot | null }> {
  const log: FakePageLog = { scrollAt: null, inspectAt: [], shotAt: null, windows: [], metrics: [], shots: [], steps: [] }
  const clean: InspectResult = { images: 0, mapImages: 0, foreign: [], kogl: 0, frames: [] }
  let scrollY = 0
  let view = { width: 1280, height: 800, deviceScaleFactor: 1 }
  const noop = () => undefined
  const pageResult = (code: string): unknown => {
    if (code.startsWith('document.fonts')) return 'loaded'
    if (code.startsWith('(window.scrollTo(')) {
      log.scrollAt = Date.now()
      scrollY = Number(/top:\s*(\d+)/.exec(code)?.[1] ?? 0)
      return true
    }
    const fn = /^\(function (\w+)\(/.exec(code)?.[1]
    if (fn === 'pageScroll') return { found: true, y: scrollY }
    if (fn === 'pageDecode') return { count: 0, failed: 0 }
    if (opts.page && (fn === 'pageClipState' || fn === 'pageClipCovers' || fn === 'pageInspect')) {
      if (fn === 'pageInspect') log.inspectAt.push(Date.now())
      return opts.page({ width: view.width, height: view.height }).eval(code)
    }
    if (fn === 'pageClipState') {
      return {
        missing: [], rects: opts.rects ?? [{ x: 100, y: 2300, w: 500, h: 300 }], text: '가상박물관\n이용시간', docWidth: 1280, docHeight: 4000,
        viewWidth: view.width, viewHeight: view.height, scrollX: 0, scrollY, cover: 0,
      }
    }
    if (fn === 'pageClipCovers') return []
    if (fn === 'pageInspect') {
      log.inspectAt.push(Date.now())
      return log.shotAt !== null && opts.afterShot ? opts.afterShot : clean
    }
    return true
  }
  const command = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    if (method === 'DOM.getDocument') return Promise.resolve({ root: opts.tree ?? { nodeName: '#document', children: [] } })
    if (method === 'DOM.getBoxModel') return Promise.reject(new Error('Could not compute box model.'))
    if (method === 'Emulation.setDeviceMetricsOverride') {
      log.metrics.push(params)
      log.steps.push('metrics')
      view = { width: Number(params.width), height: Number(params.height), deviceScaleFactor: Number(params.deviceScaleFactor) }
    }
    if (method === 'Page.captureScreenshot') {
      log.shotAt = Date.now()
      log.shots.push(params)
      const clip = params.clip as { width: number; height: number; scale?: number } | undefined
      const k = view.deviceScaleFactor * (clip?.scale ?? 1)
      const size = { width: Math.round((clip?.width ?? view.width) * k), height: Math.round((clip?.height ?? view.height) * k) }
      return Promise.resolve({ data: Buffer.from(JSON.stringify(size)).toString('base64') })
    }
    return Promise.resolve({})
  }
  class PageWindow {
    destroyed = false
    webContents = {
      id: 91,
      debugger: { isAttached: () => false, detach: noop, attach: noop, on: noop, sendCommand: command },
      setFrameRate: noop,
      setWindowOpenHandler: noop,
      on: noop,
      insertCSS: () => Promise.resolve(),
      executeJavaScript: (code: string) => Promise.resolve(pageResult(code)),
      getOSProcessId: () => 0,
      getURL: () => 'https://gunsan.webforai.kr/places/x/',
      loadURL: (url: string) => {
        log.steps.push(`load:${url}`)
        return Promise.resolve()
      },
    }
    constructor(options: Record<string, unknown>) {
      log.windows.push(options)
    }
    isDestroyed() {
      return this.destroyed
    }
    destroy() {
      this.destroyed = true
    }
  }
  // 찍힌 그림 — 크기는 찍기 응답에 적은 값, 화소는 여러 색(빈 그림 검사를 지나게).
  const nativeImage = {
    createFromBuffer: (buf: Buffer) => {
      const size = JSON.parse(buf.toString()) as { width: number; height: number }
      return {
        getSize: () => size,
        toBitmap: () => {
          const bm = Buffer.alloc(size.width * size.height * 4)
          for (let i = 0; i < size.width * size.height; i += 1) {
            bm[i * 4] = (i * 7) & 255
            bm[i * 4 + 1] = (i * 13) & 255
            bm[i * 4 + 2] = (i * 29) & 255
          }
          return bm
        },
      }
    },
  }
  const fakeSession = {
    setPermissionRequestHandler: noop,
    setPermissionCheckHandler: noop,
    setDevicePermissionHandler: noop,
    setSpellCheckerEnabled: noop,
    on: noop,
    webRequest: { onBeforeRequest: noop },
    clearStorageData: () => Promise.resolve(),
  }
  const capture = requireCaptureFresh({ app: { getAppMetrics: () => [] }, BrowserWindow: PageWindow, nativeImage, session: { fromPartition: () => fakeSession } })
  const realLookup = dns.promises.lookup
  dns.promises.lookup = (() => Promise.resolve([{ address: '93.184.216.34', family: 4 }])) as unknown as typeof dns.promises.lookup
  try {
    const url = 'https://gunsan.webforai.kr/places/x/'
    const options = { host: 'gunsan.webforai.kr', ...(opts.clip ? { clip: { selectors: ['h1'], padding: 16, ...opts.clipOptions } } : {}) }
    let result: FakeShot | null = null
    let code: string
    if (opts.relay) {
      const relay = capture as unknown as { handleCaptureRequest: (m: unknown) => Promise<(FakeShot & { code?: string }) | null> }
      const reply = await relay.handleCaptureRequest({ type: 'screen-capture', id: 'fake-relay', url, options })
      result = reply
      code = reply?.ok ? 'resolved' : (reply?.code ?? 'no-reply')
    } else {
      code = await codeOf(
        capture.captureScreen(url, options).then((shot) => {
          result = shot as FakeShot
        }),
      )
    }
    capture.disposeCapture()
    return { code, log, result }
  } finally {
    dns.promises.lookup = realLookup
  }
}

/**
 * jsdom은 ::before · ::after의 계산 스타일 · border-image 같은 속성 · checkVisibility를 모른다 — Chrome처럼 보이게 덧씌운다. 요소의
 * data-cs(요소) · data-before · data-after(가상 요소) JSON이 계산 스타일 값을 정하고(없는 가상 요소는 그림이 없다), checkVisibility는 Chrome과
 * 같이 display:none(조상 포함) · visibilityProperty면 visibility:hidden · opacityProperty면 opacity 0(조상 포함)을 안 보임으로 본다.
 */
function chromeLike<W extends { getComputedStyle: (el: Element, pseudo?: string | null) => CSSStyleDeclaration; Element: { prototype: object } }>(w: W): W {
  const real = w.getComputedStyle.bind(w)
  const NO_PSEUDO: Record<string, string> = {
    backgroundImage: 'none', content: 'none', maskImage: 'none', borderImageSource: 'none', listStyleImage: 'none', visibility: 'visible', display: 'inline', position: 'static',
  }
  w.getComputedStyle = (el: Element, pseudo?: string | null) => {
    const raw = el.getAttribute(pseudo ? `data-${pseudo.replace(/^:+/, '')}` : 'data-cs')
    const over = raw ? (JSON.parse(raw) as Record<string, string>) : {}
    if (pseudo && !raw) return { ...NO_PSEUDO, getPropertyValue: () => '' } as unknown as CSSStyleDeclaration
    const base = pseudo ? ({ ...NO_PSEUDO, getPropertyValue: () => '' } as unknown as CSSStyleDeclaration) : real(el)
    return new Proxy(base, {
      get: (target, key) => {
        if (typeof key === 'string' && key in over) return over[key]
        const v = Reflect.get(target, key) as unknown
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
      },
    })
  }
  Object.assign(w.Element.prototype, {
    checkVisibility(this: Element, o?: { opacityProperty?: boolean; visibilityProperty?: boolean }) {
      const chain: Element[] = []
      for (let n: Element | null = this.parentElement; n; n = n.parentElement) chain.push(n)
      for (const n of [this, ...chain]) {
        const cs = real(n)
        if (cs.display === 'none') return false
        if (o?.opacityProperty && cs.opacity === '0') return false
      }
      return !(o?.visibilityProperty && real(this).visibility === 'hidden')
    },
  })
  return w
}

const lib = await import('../src/lib/screenCapture')
const screens = await import('../server/screens')
const { saveAutoPhotoPicks } = await import('../server/contentDraft')
const {
  findScreenVariant, isScreenShotId, parseScreenAppSrc, photoRepeatKey, brandRepeatExempt, screenAppSrc, screenOfPick, screenProfileFor,
  screenSaveAllowed, screenUrl, SCREEN_AUTO_SAVE_KINDS, SCREEN_PROFILES,
} = lib
const { captureScreenShot, createCaptureBridge, pngSize, readScreenFile, readScreenShots, screenCaptureOptions, screenFileForPick, screensDir, storeScreenShot } = screens

let server: ReturnType<typeof spawn> | null = null
try {
  // ── 1) 프로필 표 ───────────────────────────────────────────────────────
  const profile = screenProfileFor(['gunsan.webforai.kr', 'all-about-gunsan.vercel.app'])
  const course = profile?.screens.find((s) => s.id === 'course')
  const map = profile?.screens.find((s) => s.id === 'map')
  // 예전 기대값은 코스 5였다 — 2026-11-05 결정 D5(b)로 「아이 둘과」(kids2 — 아이와의 둘째 변형)를 더했다.
  ok('자사 사이트에 프로필 호스트가 있으면 그 프로필(코스 6 · 지도 6)', profile?.host === 'gunsan.webforai.kr' && course?.variants.length === 6 && map?.variants.length === 6)
  ok('ownedDomains의 https:// · www. · 끝 / 를 걷고 찾는다', screenProfileFor(['https://www.gunsan.webforai.kr/']) === profile)
  ok('상위 도메인 · 다른 사이트 · 없음이면 프로필이 없다', screenProfileFor(['webforai.kr']) === null && screenProfileFor(['stay.example']) === null && screenProfileFor(undefined) === null)
  const allUrls = SCREEN_PROFILES.flatMap((p) => p.screens.flatMap((s) => s.variants.map((v) => screenUrl(p, v))))
  // 예전 기대값은 11(코스 5 + 지도 6)이었다 — 4단계에서 「아이와 함께」 가이드 변형 하나를 더했다(12), 2026-11-05 「아이 둘과」 코스 변형(13).
  // 장소 안내는 표에 변형이 없다(사이트 장소마다).
  // 2026-11-05 스테이,머뭄 프로필(co.webforai.kr/s/stay — 앱이 그린 지도만, 찍지 않는 변형 1)을 더해 14.
  const urlsWithHost = SCREEN_PROFILES.flatMap((p) => p.screens.flatMap((s) => s.variants.map((v) => ({ url: screenUrl(p, v), host: p.host }))))
  ok(
    '모든 변형 주소는 https · 그 프로필 호스트',
    allUrls.length === 14 && urlsWithHost.every(({ url, host }) => new URL(url).protocol === 'https:' && new URL(url).host === host),
  )
  const stayProfile = screenProfileFor(['co.webforai.kr'], 'https://co.webforai.kr/s/stay')
  ok(
    '찍지 않는 화면(drawOnly — 앱이 그린 지도만)은 찍기 · 넣기 대상이 아니다',
    stayProfile?.screens.every((s) => s.drawOnly === true) === true && findScreenVariant(stayProfile!, 'map', 'default') === null,
  )
  ok(
    '「아이 둘과」 — 아이 나이 목록(kids=4,9) · 어른 2 · 아이와의 둘째 변형(extra)',
    screenUrl(profile!, course!.variants.find((v) => v.id === 'kids2')!) === 'https://gunsan.webforai.kr/plan/?with=kids&adults=2&kids=4,9' &&
      course!.variants.find((v) => v.id === 'kids2')!.extra === true,
  )
  ok(
    '코스 변형은 /plan/ 미리 채우기 쿼리만(보내는 값 없음)',
    (course?.variants ?? []).every((v) => v.path.startsWith('/plan/')) &&
      screenUrl(profile!, course!.variants.find((v) => v.id === 'kids')!) === 'https://gunsan.webforai.kr/plan/?with=kids&kids=7',
  )
  // 「누구와 가세요?」의 네 칸 — 혼자 · 연인·친구도 주소로 미리 채운다(plan.js fromAddress: with=solo|couple, adults=0..10). 아이와 · 부모님처럼
  // 조건 단계가 맨 위에 오게 찍는다.
  const courseVariant = (id: string) => course?.variants.find((v) => v.id === id)
  ok(
    '코스 변형 — 혼자(with=solo · 어른 1) · 연인·친구(with=couple · 어른 2)도 조건 단계로',
    courseVariant('solo')?.label === '혼자' && screenUrl(profile!, courseVariant('solo')!) === 'https://gunsan.webforai.kr/plan/?with=solo&adults=1' &&
      courseVariant('couple')?.label === '연인·친구' && screenUrl(profile!, courseVariant('couple')!) === 'https://gunsan.webforai.kr/plan/?with=couple&adults=2' &&
      ['solo', 'couple', 'kids', 'parents'].every((id) => courseVariant(id)?.scrollTo === 'fieldset:has(input[name="with"])' && courseVariant(id)?.prefer instanceof RegExp) &&
      courseVariant('default')?.prefer === undefined,
  )
  const ids = SCREEN_PROFILES.flatMap((p) => p.screens.map((s) => `${p.host}/${s.id}:${new Set(s.variants.map((v) => v.id)).size === s.variants.length}`))
  ok('화면 · 변형 id는 프로필 안에서 겹치지 않는다', ids.every((x) => x.endsWith(':true')) && new Set(ids).size === ids.length)
  // 예전 기대값은 ["course"]였다 — 4단계 과제대로 장소 안내 · 가이드(고객 사이트의 자사 글자 · 아이콘 · 일러스트만 잘라 찍은 화면)도 넣는다.
  ok(
    '글에 넣는 종류는 코스 · 장소 안내 · 가이드(지도는 미리보기만)',
    JSON.stringify(SCREEN_AUTO_SAVE_KINDS) === '["course","place","guide"]' && screenSaveAllowed('course') && screenSaveAllowed('place') && screenSaveAllowed('guide') && !screenSaveAllowed('map'),
  )
  // ── 1b) 장소 안내 · 가이드(4단계 잘라 찍기) ───────────────────────────────
  const { placeVariantOfSlug, placeScreenVariant, placeSlugsOfSitemap, screenAlt, screenFactGaps, screenAspectRatio, isScreenKind } = lib
  const placeInfo = profile?.screens.find((s) => s.id === 'place-info')
  const kidsGuide = profile?.screens.find((s) => s.id === 'kids-guide')
  ok(
    '장소 안내 — 잘라 찍기(이름 · 안내 카드 필수, 분류 · 다른 이름 · 소개는 있으면) · 자사 호스트만 · 변형은 사이트 장소마다(표에 없음)',
    placeInfo?.kind === 'place' && placeInfo.placePages === true && placeInfo.ownHostOnly === true && placeInfo.variants.length === 0 &&
      JSON.stringify(placeInfo.clip?.selectors) === JSON.stringify(['article.place .pl-head h1', 'article.place dl.kf.kf-hero']) &&
      (placeInfo.clip?.optional ?? []).includes('article.place .pl-head .kicker') && placeInfo.clip?.padding === 16 && placeInfo.slotWords instanceof RegExp,
  )
  ok(
    '아이와 함께 가이드 — 제목 · 자사 일러스트 필수, 분류 · 첫 줄은 있으면 · 변형 하나(/guides/아이와-함께-군산/)',
    kidsGuide?.kind === 'guide' && kidsGuide.ownHostOnly === true && kidsGuide.variants.length === 1 &&
      JSON.stringify(kidsGuide.clip?.selectors) === JSON.stringify(['header.gd-head h1', 'header.gd-head figure.art-camp']) &&
      screenUrl(profile!, kidsGuide.variants[0]!) === `https://gunsan.webforai.kr/guides/${encodeURIComponent('아이와-함께-군산')}/`,
  )
  ok('찍는 종류 — 코스 · 지도 · 장소 안내 · 가이드', ['course', 'map', 'place', 'guide'].every(isScreenKind) && !isScreenKind('action') && !isScreenKind('unrelated') && !isScreenKind(undefined))
  const museum = placeVariantOfSlug('가상박물관')
  ok(
    '장소 이름(slug)으로 만든 변형 — 주소는 /places/<이름>/(퍼센트 표기) · 이름표는 하이픈을 띄어쓰기로',
    museum?.id === '가상박물관' && museum.label === '가상박물관' && museum.path === `/places/${encodeURIComponent('가상박물관')}/` &&
      placeVariantOfSlug('가상-해양-공원')?.label === '가상 해양 공원' && placeVariantOfSlug('31운동-100주년-기념관')?.id === '31운동-100주년-기념관',
  )
  ok(
    '장소 이름 모양이 아니면 변형이 없다(경로 글자 · 띄어쓰기 · % · ? · # · 앞뒤 하이픈 · 너무 긺 · 글자 아님 · 조합 전 한글)',
    ['', '../x', 'a/b', 'a\\b', '가상 박물관', '%2F', '가상%EB', 'x?y', 'x#y', '-x', 'x-', 'a--b', 'a'.repeat(61), '가상박물관'.normalize('NFD')].every((x) => placeVariantOfSlug(x) === null) &&
      placeVariantOfSlug(123) === null && placeVariantOfSlug(null) === null,
  )
  ok(
    '장소 안내 화면 찾기 — 변형 id 모양만 보고 만든다(사이트 목록은 찍기 전에 서버가 본다)',
    findScreenVariant(profile!, 'place-info', '가상박물관')?.variant.path === museum?.path && findScreenVariant(profile!, 'place-info', '../x') === null &&
      findScreenVariant(profile!, 'kids-guide', 'default')?.screen.kind === 'guide' && findScreenVariant(profile!, 'kids-guide', '가상박물관') === null,
  )
  const PLACE_URL = `https://gunsan.webforai.kr/places/${encodeURIComponent('가상박물관')}/`
  ok(
    '장소 사전 주소로 만든 변형 — https · 프로필 호스트 · /places/<이름>/ 하나만(다른 호스트 · 하위 도메인 · 언어 경로 · 더 깊은 경로 · 쿼리 · 포트 · 계정은 아니다)',
    placeScreenVariant(profile!, PLACE_URL)?.id === '가상박물관' && placeScreenVariant(profile!, 'https://gunsan.webforai.kr/places/가상박물관/')?.id === '가상박물관' &&
      [
        'http://gunsan.webforai.kr/places/가상박물관/', 'https://evil.example/places/가상박물관/', 'https://www.gunsan.webforai.kr/places/가상박물관/',
        'https://gunsan.webforai.kr/en/places/x/', 'https://gunsan.webforai.kr/places/가상박물관/사진/', 'https://gunsan.webforai.kr/places/가상박물관/?x=1',
        'https://gunsan.webforai.kr:8443/places/가상박물관/', 'https://u:p@gunsan.webforai.kr/places/가상박물관/', 'https://gunsan.webforai.kr/places/',
        'https://gunsan.webforai.kr/places/%E0%A4%A/', 'https://gunsan.webforai.kr/places/..%2Fx/', 'not a url',
      ].every((u) => placeScreenVariant(profile!, u) === null),
  )
  const sitemap = [
    '<urlset>', `<url><loc>${PLACE_URL}</loc></url>`, '<url><loc>https://gunsan.webforai.kr/places/가상-해양-공원/</loc></url>',
    '<url><loc>https://gunsan.webforai.kr/en/places/virtual-museum/</loc></url>', '<url><loc>https://evil.example/places/바깥/</loc></url>',
    '<url><loc>https://gunsan.webforai.kr/plan/</loc></url>', '</urlset>',
  ].join('\n')
  ok('sitemap의 장소 이름 — 프로필 호스트의 /places/<이름>/만', JSON.stringify([...placeSlugsOfSitemap(sitemap, profile!)]) === JSON.stringify(['가상박물관', '가상-해양-공원']))
  ok(
    '대체 텍스트 — 장소 안내는 장소 이름을 앞에, 다른 화면은 화면 이름만',
    screenAlt('가상각', placeInfo!, museum!) === "가상각 웹사이트 '가상박물관 장소 안내' 화면" && screenAlt('가상각', kidsGuide!, kidsGuide!.variants[0]) === "가상각 웹사이트 '아이와 함께 안내' 화면" &&
      screenAlt('가상각', course!, course!.variants[0]) === "가상각 웹사이트 'AI 코스 만들기' 화면",
  )
  ok('썸네일 비율 — 찍은 크기 그대로(모르면 없음)', screenAspectRatio({ width: 425, height: 677 }) === '425 / 677' && screenAspectRatio(undefined) === undefined && screenAspectRatio({ width: 0, height: 5 }) === undefined)
  ok(
    '화소 배율 — 잘라 찍는 화면(장소 안내 · 가이드)은 2배, 첫 화면 통째(코스 · 지도)는 1배',
    lib.SCREEN_CLIP_SCALE === 2 && lib.screenShotScale(placeInfo!) === 2 && lib.screenShotScale(kidsGuide!) === 2 && lib.screenShotScale(course!) === 1 && lib.screenShotScale(map!) === 1,
  )
  // 장소 안내는 600 화면으로 잘라 찍는다(2026-11-05 결정 「600px (권장)」) — 사이트의 반응형 배치가 안내 카드를 한 줄 가득(한 줄에 칸 셋) 펴서
  // 장소마다 578(CSS px) · 2배 1156 화소가 되고, 블로그 그림 줄(720)에서 글자가 사이트의 1.25배로 보인다(1280 화면의 425 카드는 세로가 길었다).
  // 767 이하 화면에 생기는 아래 고정 줄(.pl-bar)은 숨긴다. 가이드 · 첫 화면 통째(코스 · 지도)는 1280 그대로.
  ok(
    '화면 가로 — 장소 안내는 600(좁은 화면의 아래 고정 줄 .pl-bar는 숨김), 가이드는 정하지 않음(1280) · 코스 · 지도는 잘라 찍지 않음',
    placeInfo?.clip?.viewWidth === 600 && (placeInfo.hide ?? []).includes('.pl-bar') && kidsGuide?.clip !== undefined && kidsGuide.clip.viewWidth === undefined &&
      !(kidsGuide.hide ?? []).includes('.pl-bar') && course?.clip === undefined && map?.clip === undefined && lib.SCREEN_VIEW_WIDTH === 1280,
  )
  // 찍어 둔 화면이 지금 찍는 방식(배율 · 화면 가로)과 같은가 — 서버는 같은 날이라도 같은 방식으로 찍은 것만 다시 쓴다(sameDayShot). 화면 고르기
  // (SitePhotoPanel)는 오늘 찍은 화면에 「다시 찍기」를 두지 않았다 — 오늘 1280 화면으로 찍은 장소 안내는 다음 날에야 600으로 다시 찍을 수
  // 있었다(검토 2026-11-05). 같은 방식이 아니면 오늘 찍었어도 「다시 찍기」를 둔다.
  const shotCurrent = (lib as { screenShotCurrent?: (shot: { scale?: number; viewWidth?: number }, screen: NonNullable<typeof placeInfo>) => boolean }).screenShotCurrent
  ok(
    '찍는 방식 — 장소 안내는 600 · 2배 기록만 지금 방식(1280 · 2배 · 1배 옛 기록은 아님), 가이드는 1280 · 2배, 코스 · 지도는 1배',
    typeof shotCurrent === 'function' &&
      shotCurrent({ scale: 2, viewWidth: 600 }, placeInfo!) && !shotCurrent({ scale: 2 }, placeInfo!) && !shotCurrent({}, placeInfo!) && !shotCurrent({ viewWidth: 600 }, placeInfo!) &&
      shotCurrent({ scale: 2 }, kidsGuide!) && !shotCurrent({}, kidsGuide!) && !shotCurrent({ scale: 2, viewWidth: 600 }, kidsGuide!) &&
      shotCurrent({}, course!) && shotCurrent({ scale: 1, viewWidth: 1280 }, map!) && !shotCurrent({ scale: 2 }, course!),
  )
  const kidsTarget = { profile: profile!, ...findScreenVariant(profile!, 'course', 'kids')! }
  const wondosim = { profile: profile!, ...findScreenVariant(profile!, 'map', 'r-원도심')! }
  ok('찾을 수 없는 화면 · 변형은 null', findScreenVariant(profile!, 'course', 'nope') === null && findScreenVariant(profile!, 'nope', 'default') === null && findScreenVariant(profile!, 1, 2) === null)
  const kidsOpts = screenCaptureOptions(kidsTarget)
  const mapOpts = screenCaptureOptions(wondosim)
  ok(
    '찍기 옵션은 프로필에서 — 코스는 지도 없이 조건 단계로, 권역 지도는 지도 · 탭 누르기',
    kidsOpts.host === 'gunsan.webforai.kr' && !kidsOpts.map && kidsOpts.scrollTo === 'fieldset:has(input[name="with"])' && JSON.stringify(kidsOpts.hide) === '[".trp-handed-w","[data-wx]"]' &&
      mapOpts.map === true && mapOpts.scrollTo === '.map-grid' && mapOpts.activateFragmentLink === true && JSON.stringify(mapOpts.hide) === '["[data-wx]"]' &&
      screenUrl(profile!, wondosim.variant) === new URL('https://gunsan.webforai.kr/map/#r-원도심').href,
  )
  const placeOpts = screenCaptureOptions({ profile: profile!, ...findScreenVariant(profile!, 'place-info', '가상박물관')! })
  const guideOpts = screenCaptureOptions({ profile: profile!, ...findScreenVariant(profile!, 'kids-guide', 'default')! })
  // 예전 기대값은 장소 안내의 숨길 것이 '["[data-wx]"]'(날씨 카드)뿐이었다 — 600 화면(767 이하)에서는 사이트가 장소 페이지 아래에 고정 줄
  // (.pl-bar)을 띄워 그것도 숨긴다(2026-11-05 실측 권고).
  ok(
    '찍기 옵션 — 장소 안내 · 가이드는 프로필의 잘라 찍기 · 자사 호스트만(지도 · 스크롤 없음)',
    JSON.stringify(placeOpts.clip?.selectors) === JSON.stringify(['article.place .pl-head h1', 'article.place dl.kf.kf-hero']) && placeOpts.clip?.padding === 16 &&
      (placeOpts.clip?.optional ?? []).length === 3 && placeOpts.ownHostOnly === true && !placeOpts.map && !placeOpts.scrollTo && JSON.stringify(placeOpts.hide) === '["[data-wx]",".pl-bar"]' &&
      JSON.stringify(guideOpts.clip?.selectors) === JSON.stringify(['header.gd-head h1', 'header.gd-head figure.art-camp']) && guideOpts.ownHostOnly === true &&
      kidsOpts.clip === undefined && kidsOpts.ownHostOnly === undefined && mapOpts.clip === undefined,
  )
  ok(
    '찍기 옵션 — 장소 안내는 화면 가로 600을 넘기고, 가이드는 넘기지 않는다(캡처 모듈 기본 1280)',
    placeOpts.clip?.viewWidth === 600 && guideOpts.clip !== undefined && !('viewWidth' in guideOpts.clip),
  )

  // ── 2) id · 앱 주소 · 경로 ─────────────────────────────────────────────
  ok(
    '찍은 화면 id는 소문자 16진수 16자만',
    isScreenShotId('0123456789abcdef') && !isScreenShotId('0123456789ABCDEF') && !isScreenShotId('0123456789abcde') && !isScreenShotId('0123456789abcdef0') &&
      !isScreenShotId('../0123456789abc') && !isScreenShotId(123),
  )
  const appSrc = screenAppSrc('fake-gunsan', '0123456789abcdef')
  const parsed = parseScreenAppSrc(appSrc)
  ok('앱 주소 모양과 되읽기', appSrc === '/api/screens/fake-gunsan/0123456789abcdef.png' && parsed?.tenantId === 'fake-gunsan' && parsed.shotId === '0123456789abcdef')
  ok(
    '경로 글자 · 다른 모양의 앱 주소는 읽지 않는다',
    parseScreenAppSrc('/api/screens/..%2Fx/0123456789abcdef.png') === null &&
      parseScreenAppSrc('/api/screens/fake-gunsan/../0123456789abcdef.png') === null &&
      parseScreenAppSrc('/api/screens/%2E%2E/0123456789abcdef.png') === null &&
      parseScreenAppSrc('https://evil.example/api/screens/fake-gunsan/0123456789abcdef.png') === null &&
      parseScreenAppSrc('/api/screens/fake-gunsan/0123456789ABCDEF.png') === null &&
      parseScreenAppSrc(null) === null,
  )
  const throwsRange = (fn: () => unknown) => {
    try {
      fn()
      return false
    } catch (err) {
      return err instanceof RangeError
    }
  }
  ok(
    '화면 폴더는 데이터 폴더 안 <브랜드>/screens만(경로 글자가 든 브랜드 id는 거절)',
    throwsRange(() => screensDir('../x')) && throwsRange(() => screensDir('a/b')) && throwsRange(() => screensDir('a\\b')) && throwsRange(() => screensDir('..')) &&
      throwsRange(() => screensDir('')) && screensDir('fake-gunsan') === path.join(unitDir, 'data', 'fake-gunsan', 'screens'),
  )

  // ── 3) 반복 열쇠 ──────────────────────────────────────────────────────
  const sitePhoto = { src: 'https://site.example/a.jpg' }
  const screenPhoto = { src: '/api/screens/t/0123456789abcdef.png', origin: 'screen' as const, screenId: 'course', variantId: 'kids' }
  ok('반복 열쇠 — 사진은 주소, 화면은 「화면 + 변형」', photoRepeatKey(sitePhoto) === sitePhoto.src && photoRepeatKey(screenPhoto) === 'screen:course:kids')
  ok('브랜드 상한은 화면만 받지 않는다', brandRepeatExempt(screenPhoto) && !brandRepeatExempt(sitePhoto) && !brandRepeatExempt({ origin: 'public' }))
  ok(
    '사진의 화면 · 변형은 브랜드 프로필에서 찾는다',
    screenOfPick(screenPhoto, ['gunsan.webforai.kr'])?.screen.kind === 'course' && screenOfPick(screenPhoto, ['stay.example']) === null && screenOfPick(sitePhoto, ['gunsan.webforai.kr']) === null,
  )

  // ── 3b) 화면 자리 판정 · 종류 · 변형 · 내보내기(src/lib/screenCapture.ts) ──────────────────
  const { isScreenSlotText, screenKindOf, screenVariantChoice, screenExportable } = lib
  ok(
    '「화면」만으로는 화면 자리가 아니다(한 화면에 담긴 · 대형 화면)',
    !isScreenSlotText('가상스테이 가옥 외관과 정원이 한 화면에 담긴 장면') && !isScreenSlotText('대형 화면이 걸린 카페 내부'),
  )
  ok(
    '「사이트」 · 「앱」 · 「스크린」 · 「웹사이트」만 있으면 사진 자리',
    !isScreenSlotText('오토캠핑 사이트 전경') && !isScreenSlotText('스크린 골프장 내부') && !isScreenSlotText('앱으로 주문하는 손님') && !isScreenSlotText('가상스테이 웹사이트 소개'),
  )
  ok(
    '화면 + 웹사이트 · 홈페이지 · 사이트 · 앱이면 화면 자리',
    isScreenSlotText('가상스테이 웹사이트의 예약 화면') && isScreenSlotText('홈페이지 첫 화면') && isScreenSlotText('예약 사이트 화면') && isScreenSlotText('지도 앱 화면'),
  )
  ok(
    '화면 + 화면 이름 · 다른 회사 · 누르기 · 결과도 화면 자리(웹사이트 낱말이 없어도)',
    isScreenSlotText("가상각 '지도에서 찾기' 화면에 박물관이 표시된 모습") && isScreenSlotText('가상각 AI 코스 만들기 화면에서 조건을 고르는 모습') &&
      isScreenSlotText('네이버 플레이스 예약 화면의 달력') && isScreenSlotText('코스 결과 화면에서 한 장소를 눌러 요금이 보이는 모습'),
  )
  ok('검색 결과 · 캡처 · 스크린샷은 「화면」이 없어도 화면 자리', isScreenSlotText('앱 검색 결과') && isScreenSlotText('예약 페이지 캡처') && isScreenSlotText('홈페이지 스크린샷'))
  // 잘라 찍는 화면의 흔한 이름(「장소 안내」 · 「아이와 함께 안내」)은 실물 안내판 · 안내 화면과 겹친다 — 그 이름만으로는 화면 자리가 아니다(모든
  // 브랜드). 웹사이트 · 사이트 · 홈페이지 · 앱 낱말이나 캡처가 함께 있어야 한다(검토 2026-11-04).
  ok(
    '「장소 안내」 · 「아이와 함께 안내」 이름만으로는 화면 자리가 아니다(실물 안내판 사진 자리) · 웹사이트 낱말 · 캡처가 있으면 화면 자리',
    !isScreenSlotText('전시관 입구의 장소 안내 화면이 보이는 모습') && !isScreenSlotText('터미널 대합실의 장소 안내 화면') &&
      !isScreenSlotText('키즈카페 입구의 아이와 함께 안내 화면') && !isScreenSlotText('박물관 로비 장소 안내 화면 앞에서 사진을 찍는 가족') &&
      isScreenSlotText("가상각 웹사이트의 '아이와 함께' 안내 화면") && isScreenSlotText('가상각 장소 안내 캡처'),
  )
  // 흔한 이름 · 안내 낱말로만 정해지는 장소 안내 · 가이드 화면은 자리 글자가 브랜드(자사 사이트)를 말할 때만 찍는다 — 다른 기관 사이트(공식
  // 홈페이지 · 관광공사 · 구석구석 · 시청 · 문화관광)를 말하면 other, 어느 사이트인지 말하지 않으면 unowned(검토 2026-11-04).
  ok(
    '장소 안내 · 가이드 화면은 브랜드를 말할 때만 — 다른 기관 사이트면 other, 사이트를 말하지 않으면 unowned',
    screenKindOf('가상박물관 공식 홈페이지의 관람시간 안내 화면', profile, '가상각').kind === 'other' &&
      screenKindOf('한국관광공사 대한민국 구석구석 사이트에서 가상박물관의 이용시간과 입장료가 표시된 화면', profile, '가상각').kind === 'other' &&
      screenKindOf('가상시 문화관광 홈페이지에서 가상박물관 입장료가 표시된 화면', profile, '가상각').kind === 'other' &&
      screenKindOf('관광정보 사이트에서 한 장소의 여는 시간, 요금, 가는 길이 함께 표시된 화면', profile, '가상각').kind === 'unowned' &&
      screenKindOf("웹사이트의 '아이와 함께' 안내 화면", profile, '가상각').kind === 'unowned' &&
      screenKindOf('가상각 공식 홈페이지에서 가상박물관 관람시간이 표시된 화면', profile, '가상각').kind === 'place' &&
      screenKindOf('gunsan.webforai.kr에서 가상박물관 관람시간이 표시된 화면', profile, '가상각').kind === 'place' &&
      screenKindOf('가상각 웹사이트에서 가상박물관의 이용시간이 표시된 화면', profile).kind === 'unowned',
  )
  // 예전에는 브랜드 이름 없이 불렀다 — 장소 안내 · 가이드 화면은 이제 브랜드 이름이 있어야 해서 시험 브랜드 이름(가상각)을 넘긴다.
  const kindOf = (t: string) => screenKindOf(t, profile, '가상각').kind
  ok(
    '화면 이름이 하나면 그 화면(코스 · 지도) — 따옴표 · 띄어쓰기는 무시',
    kindOf('가상각 웹사이트의 AI 코스 만들기 화면에서 조건을 고르는 모습') === 'course' && kindOf("가상각 'AI코스 만들기' 화면") === 'course' &&
      kindOf("가상각 '지도에서 찾기' 화면") === 'map' && screenKindOf('가상각 화면에서 지도에서 찾기로 숙소 위치를 띄운 모습', profile).screen?.id === 'map',
  )
  ok('화면 이름이 둘이면 ambiguous', kindOf('AI 코스 만들기 화면과 지도에서 찾기 화면') === 'ambiguous')
  ok(
    '누르거나 결과를 받아야 보이는 화면은 action — 조건 고르기 · 조건 선택은 아니다',
    kindOf('지도에서 찾기 화면에서 박물관을 눌러 요금이 보이는 장면') === 'action' && kindOf("'지도에서 찾기' 화면에서 박물관을 선택해 이용시간이 보이는 모습") === 'action' &&
      kindOf('AI 코스 결과 화면') === 'action' && kindOf('가상각 웹사이트의 AI 코스 만들기 조건 선택 화면') === 'course' && kindOf('AI 코스 만들기 화면에서 조건을 선택한 모습') === 'course',
  )
  // 예전 기대값은 「지도 앱에서 숙소까지 도보 경로를 띄운 휴대폰 화면」도 other였다 — 2026-11-05 결정 D5(c)로 장소 목록 출처가 있는 브랜드의
  // 이름 없는 지도 앱 길 안내 자리는 앱이 그린 OSM 지도(map)로 대신한다. 이름이 있는 지도 앱(네이버 · 카카오)은 그대로 other.
  ok(
    '다른 회사 · 휴대폰 화면은 other — 이름 없는 지도 앱의 길 안내 자리는 지도(OSM으로 대신)',
    kindOf('지도 앱에서 숙소까지 도보 경로를 띄운 휴대폰 화면') === 'map' && kindOf('네이버 지도 앱에서 숙소까지 도보 경로를 띄운 휴대폰 화면') === 'other' &&
      kindOf('네이버 플레이스 예약 화면') === 'other' && kindOf('휴대폰으로 예약 확인 문자를 받은 화면') === 'other' &&
      screenKindOf('지도 앱에서 숙소까지 도보 경로를 띄운 휴대폰 화면', null).kind === 'other',
  )
  // 예전 기대값은 「'아이와 함께' 안내 화면」 · 「관광정보 사이트에서 한 장소의 요금이 표시된 화면」이 unrelated였다 — 4단계에서 그 둘이 찍는
  // 화면(가이드 · 장소 안내)이 되어, 목록에 없는 화면의 예를 첫 화면 · 행사 안내로 바꿨다.
  ok(
    '목록에 없는 화면은 unrelated, 프로필이 없는 브랜드는 none',
    kindOf('가상각 웹사이트의 첫 화면') === 'unrelated' && kindOf("가상각 웹사이트의 '이번 주 행사' 안내 화면") === 'unrelated' &&
      screenKindOf('가상스테이 웹사이트의 예약 화면', null).kind === 'none' && screenKindOf('가상각 웹사이트에서 가상박물관의 이용시간이 표시된 화면', null).kind === 'none',
  )
  // 예전 기대값은 「관광정보 사이트에서 한 장소의 … 화면」도 place였다 — 브랜드를 말하지 않아 이제 unowned다(위 검사).
  ok(
    '장소 안내 화면 자리 — 화면 이름 없이 이용시간 · 여는 시간 · 휴관 · 입장료 · 요금 낱말(브랜드를 말할 때)',
    screenKindOf('가상각 웹사이트에서 가상박물관의 이용시간과 휴관일, 입장료가 표시된 화면', profile, '가상각').screen?.id === 'place-info' &&
      kindOf('가상각 웹사이트에서 가상박물관의 여는 시간과 요금 안내가 보이는 화면') === 'place' && kindOf('가상각 홈페이지의 가상박물관 쉬는 날 안내 화면') === 'place',
  )
  ok(
    '가이드 화면 자리 — 「아이와 함께」 안내(따옴표 · 띄어쓰기 무시)',
    screenKindOf("가상각 웹사이트의 '아이와 함께' 안내 화면", profile, '가상각').screen?.id === 'kids-guide' && kindOf('가상각 웹사이트의 아이와 함께 안내 화면') === 'guide' &&
      kindOf("가상각 사이트의 '아이와 함께' 안내 메뉴 화면") === 'guide',
  )
  // 예전 기대값은 브랜드 지도에서 장소를 누르는 두 자리도 action이었다 — 2026-11-05 결정 D5(b)로 그 장소의 장소 안내(viaAction, 확인 필요)로 대신한다.
  const viaActionOf = (t: string) => screenKindOf(t, profile, '가상각')
  ok(
    '장소 안내 낱말이 있어도 다른 종류를 뺏지 않는다 — 브랜드 지도에서 장소를 누르는 자리는 장소 안내(viaAction), 브랜드 없는 결과 화면은 action, 화면 이름이 있으면 그 화면, 다른 회사는 other',
    viaActionOf("가상각 '지도에서 찾기' 화면에서 가상박물관을 선택해 이용시간과 입장료가 보이는 모습").kind === 'place' &&
      viaActionOf("가상각 '지도에서 찾기' 화면에서 가상박물관을 선택해 이용시간과 입장료가 보이는 모습").viaAction === true &&
      kindOf('코스 결과 화면에서 한 장소를 눌러 여는 시간과 요금, 가는 길이 함께 표시된 모습') === 'action' &&
      viaActionOf('가상각 웹사이트의 지도에서 찾기 화면에서 가상박물관을 눌러 여는 시간과 요금이 함께 보이는 장면').viaAction === true &&
      kindOf('가상각 웹사이트의 지도에서 찾기 화면에서 가상박물관 위치를 눌러 보는 모습') === 'action' &&
      kindOf('가상각 웹사이트의 지도에서 찾기 화면에 가상박물관의 이용시간이 표시된 모습') === 'map' &&
      kindOf('가상각 웹사이트의 AI 코스 만들기 화면에서 입장료가 없는 곳을 고르는 모습') === 'course' &&
      kindOf('네이버 플레이스 화면에서 가상박물관 이용시간이 보이는 모습') === 'other' && kindOf('가상각 웹사이트의 지도에서 찾기 화면') === 'map',
  )
  // 설명 줄 · 장면 글자의 사실과 찍은 글자 — 값(시각 · 금액 · 달 · 요일 · 무료 · 입장 마감)과 말(이용시간 · 요금 · 휴관)
  const SHOWN = '관광지\n가상박물관\n이용시간\n3~10월 09:00–18:00(입장마감 17:30)\n11~2월 09:00–17:00(입장마감 16:30)\n쉬는 날\n매주 월요일\n요금\n개별 성인 2,000원\n주차 요금\n무료'
  ok(
    '사실 확인 — 설명 줄의 시각 · 입장 마감 · 달, 장면 글자의 이용시간 · 휴관일 · 입장료가 찍은 글자에 있으면 빈 것이 없다',
    screenFactGaps('가상각 웹사이트에서 가상박물관의 이용시간과 휴관일, 입장료가 표시된 화면\n가상박물관 3~10월 이용시간은 09:00–18:00 (입장마감 17:30)입니다.', SHOWN).length === 0 &&
      screenFactGaps('성인 2000원 · 9:00 개장 · 월요일 휴관 · 주차 무료', SHOWN).length === 0 && screenFactGaps('', SHOWN).length === 0,
  )
  ok(
    '사실 확인 — 찍은 글자에 없는 값은 적힌 모양 그대로(금액 · 시각 · 요일 · 달 · 무료 · 입장 마감)',
    JSON.stringify(screenFactGaps('성인 3,000원, 09:30 개장, 화요일 휴관, 4~10월', SHOWN)) === JSON.stringify(['09:30', '3,000원', '4~10월', '화요일']) &&
      JSON.stringify(screenFactGaps('주차 무료 · 입장마감 17:30', '가상박물관\n09:00–18:00\n2,000원')) === JSON.stringify(['17:30', '무료', '입장 마감']),
  )
  ok(
    '사실 확인 — 값 없이 말한 이용시간 · 요금 · 휴관은 찍은 글자에 시각 · 금액(무료) · 쉬는 날 안내가 있어야(연중무휴도 쉬는 날 안내)',
    JSON.stringify(screenFactGaps('이용시간과 휴관일, 입장료가 보이는 화면', '가상박물관\n전화')) === JSON.stringify(['휴관', '이용시간', '입장료']) &&
      screenFactGaps('휴관일이 보이는 화면', '쉬는 날\n연중무휴').length === 0 && screenFactGaps('요금 안내', '입장료 무료').length === 0,
  )
  ok('사실 확인 — 「월요일에도 여는 곳」은 월요일이 찍은 글자에 있어야', JSON.stringify(screenFactGaps('월요일에도 여는 곳을 확인할 수 있습니다.', '아이와 함께 가상 여행\n두 묶음으로 나눠 다니면 됩니다.')) === JSON.stringify(['월요일']))
  // 낱말 단위로만 견주면 틀린 설명 줄이 지나간다 — 주차의 무료를 입장료의 무료로, 여름철 18:00을 겨울철 18:00으로, 연중무휴를 휴관일로 보고,
  // 「오전 10시」는 견주지 않았다(검토 2026-11-04). 찍은 글자를 항목(이용시간 · 쉬는 날 · 요금 · 주차) · 글 조각으로 나눠 견준다.
  const SHOWN_MUSEUM = [
    '관광지', '가상박물관', '가상박물관은 가상 전시관입니다. 개별권 관람료는 성인 2,000원이고 주차는 무료입니다. 매주 월요일과 1월 1일에 휴관합니다.',
    '이용시간', '3~10월 09:00–18:00(입장마감 17:30)', '11~2월 09:00–17:00(입장마감 16:30)', '쉬는 날', '매주 월요일', '요금', '개별 성인 2,000원', '통합권 성인 3,000원',
    '주차 요금', '무료', '전화', '000-0000-0000',
  ].join('\n')
  const SHOWN_OPEN = '가상곰박물관\n이용시간\n10:00–19:00\n입장 마감 18:00\n쉬는 날\n연중무휴\n요금\n성인 12,000원'
  const gapsOf = (said: string, shown = SHOWN_MUSEUM) => JSON.stringify(screenFactGaps(said, shown))
  ok(
    '사실 확인 — 무료는 같은 항목(입장료 · 주차)에서 · 달 범위의 시각은 그 달의 줄에서 · 연중무휴면 휴관일이 있다는 말은 어긋남 · 「오전 10시」도 견준다',
    gapsOf('가상박물관 입장료는 무료이고 이용시간은 09:00–18:00입니다.') === '["무료"]' &&
      gapsOf('가상박물관은 11~2월에도 09:00–18:00까지 엽니다.') === '["18:00"]' &&
      gapsOf('가상곰박물관은 휴관일이 있으니 미리 확인하세요. 입장료 성인 12,000원.', SHOWN_OPEN) === '["휴관"]' &&
      gapsOf('가상박물관은 오전 10시에 문을 열고 입장료는 성인 2,000원입니다.') === '["오전 10시"]' &&
      gapsOf('두 곳 모두 월요일에 쉽니다.', SHOWN_OPEN) === '["월요일","쉬는 날"]' &&
      gapsOf('연중무휴로 엽니다.') === '["연중무휴"]',
  )
  ok(
    '사실 확인 — 맞는 설명 줄은 그대로 지나간다(주차 무료 · 철마다 시각 · 오후 6시 · 쉬는 날 안내 · 연중무휴 · 통합권)',
    gapsOf('주차는 무료입니다.') === '[]' && gapsOf('3~10월 09:00–18:00, 11~2월 09:00–17:00에 엽니다.') === '[]' && gapsOf('오후 6시까지 열어요.') === '[]' &&
      gapsOf('휴관일이 보이는 화면', SHOWN_OPEN) === '[]' && gapsOf('연중무휴로 엽니다.', SHOWN_OPEN) === '[]' && gapsOf('매주 월요일에 휴관합니다.') === '[]' &&
      gapsOf('통합권은 성인 3,000원입니다.') === '[]' && gapsOf('입장료는 성인 2,000원, 주차는 무료') === '[]',
  )
  ok(
    '장소 안내 · 가이드 화면도 내보낸다(앱 주소 · 프로필의 장소 이름 모양)',
    screenExportable({ src: appSrc, origin: 'screen', screenId: 'place-info', variantId: '가상박물관' }) && screenExportable({ src: appSrc, origin: 'screen', screenId: 'kids-guide', variantId: 'default' }) &&
      !screenExportable({ src: appSrc, origin: 'screen', screenId: 'place-info', variantId: '../x' }) &&
      screenOfPick({ origin: 'screen', screenId: 'place-info', variantId: '가상박물관' }, ['gunsan.webforai.kr'])?.screen.kind === 'place',
  )
  const tiersOf = (screen: NonNullable<typeof map>, text: string, named: string[] = [], context = '') => {
    const c = screenVariantChoice(screen, text, named, context)
    return `${c.tiers.map((t) => t.map((v) => v.id).join(',')).join(' | ')}${c.by ? ` (${c.by})` : ''}`
  }
  ok(
    '원도심 장소를 말하는 지도 자리는 #r-원도심만',
    tiersOf(map!, '지도에서 찾기 화면에 근대역사박물관·진포해양공원·테디베어박물관 위치가 표시된 모습', ['근대역사박물관', '진포해양공원', '테디베어박물관']) === 'r-원도심 (region)',
  )
  ok('다른 권역의 이름 · 장소면 그 권역만', tiersOf(map!, '지도에서 찾기 화면에 선유도 위치가 표시된 모습', ['선유도']) === 'r-고군산 (region)' && tiersOf(map!, '은파호수 둘레 지도에서 찾기 화면') === 'r-은파 (region)')
  ok(
    '권역이 둘이거나 권역 목록에 없는 장소(장소 사전)가 나오면 전체 지도만',
    tiersOf(map!, '근대역사박물관과 선유도가 표시된 지도에서 찾기 화면') === 'default (named)' && tiersOf(map!, '가상식당 위치가 표시된 지도에서 찾기 화면', ['가상식당']) === 'default (named)',
  )
  ok('장소 없는 지도 자리는 모든 변형', tiersOf(map!, '지도에서 찾기 화면에 관광지 위치가 표시된 모습') === 'default,r-원도심,r-은파,r-고군산,r-금강,r-새만금-비응')
  // 조건을 말하지 않는 코스 자리는 기본 다음 조건 변형(general) — 예전에는 세 변형을 한 묶음으로 두어 덜 쓴 조건 화면이 「확인 필요」 없이
  // 들어갔다(검토 2026-11-04: 「연인·혼자」 소제목 아래 부모님 조건 화면).
  // 조건 변형은 표 순서(아이와 · 부모님 · 혼자 · 연인·친구) — 예전 기대값 'default | kids,parents'는 조건 변형이 둘뿐일 때다(3단계에서 혼자 ·
  // 연인·친구를 더했다).
  ok(
    '아이 · 부모님 코스 자리는 그 조건 다음 기본 — 다른 조건은 쓰지 않는다(「아이콘」은 아이가 아니다) · 조건을 말하지 않으면 기본 다음 조건',
    tiersOf(course!, '아이와 함께 AI 코스 만들기 조건을 고르는 모습') === 'kids | kids2 | default (prefer)' && tiersOf(course!, '부모님과 가는 여행의 AI 코스 만들기 화면') === 'parents | default (prefer)' &&
      tiersOf(course!, 'AI 코스 만들기 화면에서 조건을 고르는 모습') === 'default | kids,parents,solo,couple (general)' &&
      tiersOf(course!, '아이콘이 보이는 AI 코스 만들기 화면') === 'default | kids,parents,solo,couple (general)',
  )
  ok('코스 자리에 장소가 나와도 권역으로 좁히지 않는다', tiersOf(course!, 'AI 코스 만들기 화면에 근대역사박물관을 넣는 모습', ['근대역사박물관']) === 'default | kids,parents,solo,couple (general)')
  const COURSE_TEXT = '가상각 웹사이트의 AI 코스 만들기 화면에서 여행 조건을 고르는 모습'
  // 예전 기대값은 혼자 · 연인 소제목이 'default (other)'(기본만)였다 — 그때는 혼자 · 연인·친구 변형이 없어 조건 화면을 쓰지 않았다. 이제 그
  // 동행의 변형이 먼저고, 쓸 수 없으면 기본이다(다른 동행의 변형은 쓰지 않는다).
  ok(
    '코스 조건은 소제목 · 설명 줄도 본다 — 「아이와 함께」 · 「부모님」 · 「혼자」 · 「연인 · 친구 · 커플」은 그 조건 다음 기본',
    tiersOf(course!, COURSE_TEXT, [], "가상각 '아이와 함께' 안내로 시간표를 짜면 어떻게 되나요?") === 'kids | kids2 | default (prefer)' &&
      tiersOf(course!, COURSE_TEXT, [], '1박 2일 일정\n부모님과 함께라면 어르신 인원을 넣어 보세요.') === 'parents | default (prefer)' &&
      tiersOf(course!, COURSE_TEXT, [], '가상각으로 계절별 혼자 코스 짜기') === 'solo | default (prefer)' &&
      tiersOf(course!, COURSE_TEXT, [], '가상각으로 커플·무장애 동선 짜기') === 'couple | default (prefer)' &&
      tiersOf(course!, COURSE_TEXT, [], '가상각으로 연인·혼자 코스는 어떻게 짜나요?') === 'solo,couple | default (prefer)' &&
      tiersOf(course!, COURSE_TEXT, [], '혼자·친구·커플 조건으로 코스를 짜 보면\n조건을 고른 뒤 일정을 다듬습니다.') === 'solo,couple | default (prefer)',
  )
  const companionOf = (context: string) => tiersOf(course!, COURSE_TEXT, [], context)
  ok(
    '혼자 · 연인·친구 낱말 — 사이트 칸 이름과 글에 흔한 말',
    ['나홀로 군산 여행', '홀로 걷는 원도심', '혼행 코스', '1인 여행자를 위한 코스', '솔로 여행 하루 일정', '혼자서 떠나는 하루'].every((t) => companionOf(t) === 'solo | default (prefer)') &&
      [
        '연인과 걷는 코스', '커플 사진 코스', '기념일 데이트 동선', '친구들끼리 군산에서 하루', '친구와 1박 2일', '둘이서 걷는 골목', '둘만의 야경 코스', '둘이 나란히 걷는 길',
        '부부 여행 일정', '신혼여행 코스', '두 사람이 함께 걷는 산책로', '우정 여행 코스', '연인·친구 조건',
      ].every((t) => companionOf(t) === 'couple | default (prefer)'),
  )
  // 아이 낱말 바로 뒤의 「친구」(어린이 친구들 · 아이 친구)는 연인·친구가 아니다 — 아이 글에 연인·친구(어른 2) 화면이 「확인 필요」 없이 들어갔다.
  // 「혼자 하는 · 하기 좋은 · 해도 좋은」 뒤에 여행 · 코스 · 일정이 오면 혼자다(「혼자 하기 어려운 일정 짜기」는 아니다)(검토 2026-11-04).
  ok(
    '「어린이 친구들」 · 「아이 친구」는 아이와만 · 「혼자 하는 여행」 · 「혼자 하기 좋은 여행」 · 「혼자 해도 좋은 1박」은 혼자',
    companionOf('어린이 친구들이 좋아하는 체험 코스') === 'kids | kids2 | default (prefer)' && companionOf('아이 친구 가족과 함께 가는 군산') === 'kids | kids2 | default (prefer)' &&
      companionOf('아이의 친구와 함께') === 'kids | kids2 | default (prefer)' &&
      ['혼자 하는 군산 여행 코스', '혼자 하기 좋은 군산 여행', '혼자 해도 좋은 군산 1박 2일'].every((t) => companionOf(t) === 'solo | default (prefer)') &&
      companionOf('혼자 하기 어려운 일정 짜기') === 'default | kids,parents,solo,couple (general)',
  )
  // 동행이 아닌 말 — 이런 자리에 혼자 · 연인·친구 조건 화면이 「확인 필요」 없이 나가면 안 된다(조건을 말하지 않은 자리로 본다).
  ok(
    '동행이 아닌 말은 조건으로 보지 않는다(혼자서도 쉽게 · 친구 같은 사장님 · 업데이트 · 여부부터 · 공부부터 · 친구 추가 · 홀로그램 · 1인 1메뉴)',
    [
      'AI 코스 만들기는 혼자서도 쉽게 조건을 고를 수 있어요', '혼자서는 정하기 어려운 일정', '일정을 혼자 짜기 어렵다면', '혼자 고민하지 말고 조건만 고르세요',
      '친구 같은 사장님이 반겨 주는 가게', '친구처럼 편한 안내', '카카오톡 친구 추가로 소식 받기', '플러스친구로 묻기', '최근 업데이트된 운영 시간',
      '주차 가능 여부부터 확인하세요', '공부부터 하고 떠나는 여행', '홀로그램 전시', '1인 1메뉴 원칙', '1인당 입장료', '연인원 기준 방문객',
    ].every((t) => companionOf(t) === 'default | kids,parents,solo,couple (general)'),
  )
  // 동행을 말한 자리는 그 동행의 변형과 기본만 — 다른 동행의 조건 화면은 어느 묶음에도 없다.
  const companionCases: [string, string[]][] = [
    ['아이와 함께 가는 코스', ['kids']],
    ['부모님과 가는 코스', ['parents']],
    ['혼자 가는 코스', ['solo']],
    ['연인과 가는 코스', ['couple']],
    ['혼자·친구 여행', ['solo', 'couple']],
  ]
  ok(
    '동행을 말한 코스 자리에는 다른 동행의 변형이 없다',
    companionCases.every(([context, named]) => {
      const c = screenVariantChoice(course!, COURSE_TEXT, [], context)
      const used = c.tiers.flat().map((v) => v.id)
      // 같은 동행의 둘째 변형(kids2 — extra)은 그 동행의 변형이다.
      const companion = (id: string) => course!.variants.find((v) => v.id === id && !v.extra) ?? course!.variants.find((v) => v.id === id)
      const sameAs = (id: string) => (id === 'kids2' ? 'kids' : companion(id)?.id)
      return c.by === 'prefer' && used.every((id) => id === 'default' || named.includes(sameAs(id) ?? id)) && named.every((id) => c.tiers[0]!.some((v) => v.id === id))
    }) && course!.variants.filter((v) => v.prefer && !v.extra).length === 4,
  )
  ok('지도 권역은 소제목 · 설명 줄을 보지 않는다(장면 글자만)', tiersOf(map!, '지도에서 찾기 화면에 관광지 위치가 표시된 모습', [], '선유도 가는 길') === 'default,r-원도심,r-은파,r-고군산,r-금강,r-새만금-비응')
  const exportPick = { src: appSrc, origin: 'screen' as const, screenId: 'course', variantId: 'kids' }
  ok(
    '내보내는 화면 — 앱 주소 · 프로필의 코스 화면만(지도 · 모르는 변형 · https 주소 · origin 없음은 아니다)',
    screenExportable(exportPick) && !screenExportable({ ...exportPick, screenId: 'map', variantId: 'default' }) && !screenExportable({ ...exportPick, variantId: 'nope' }) &&
      !screenExportable({ ...exportPick, src: 'https://gunsan.webforai.kr/a.png' }) && !screenExportable({ src: appSrc, screenId: 'course', variantId: 'kids' }),
  )

  // ── 3b) 화면(UI)이 쓰는 도움 함수 — 설명 줄 · 찍은 날 · 찍는 순서 · 변형마다 가장 늦게 찍은 화면 ───────
  const { screenShotMeta, screenShotDay, screenCaptureOrder, latestScreenShots, MAP_PREVIEW_ONLY_TEXT } = lib
  ok(
    '설명 줄 — 「가상각 웹사이트 화면 · 호스트/경로 · 한국 날짜 캡처」(쿼리는 빼고 #권역은 읽는 글자로)',
    screenShotMeta('가상각', 'https://gunsan.webforai.kr/map/', '2026-11-03T16:30:00.000Z') === '가상각 웹사이트 화면 · gunsan.webforai.kr/map/ · 11-04 캡처' &&
      screenShotMeta('가상각', screenUrl(profile!, wondosim.variant), '2026-11-04T05:00:00.000Z') === '가상각 웹사이트 화면 · gunsan.webforai.kr/map/#r-원도심 · 11-04 캡처' &&
      screenShotMeta('가상각', 'https://gunsan.webforai.kr/plan/?with=kids&kids=7') === '가상각 웹사이트 화면 · gunsan.webforai.kr/plan/',
  )
  ok('설명 줄 — 장소 페이지 주소는 읽는 글자로', screenShotMeta('가상각', PLACE_URL, '2026-11-04T05:00:00.000Z') === '가상각 웹사이트 화면 · gunsan.webforai.kr/places/가상박물관/ · 11-04 캡처')
  ok(
    '찍은 날은 한국 날짜(UTC 15시 이후는 다음 날) · 읽지 못하면 null',
    screenShotDay('2026-11-03T14:59:00.000Z') === '11-03' && screenShotDay('2026-11-03T15:00:00.000Z') === '11-04' && screenShotDay('nope') === null && screenShotDay(undefined) === null,
  )
  const wants = [
    { screenId: 'map', variantId: 'default' },
    { screenId: 'course', variantId: 'kids' },
    { screenId: 'map', variantId: 'r-원도심' },
    { screenId: 'course', variantId: 'default' },
  ]
  const order = (failed?: Set<string>) => screenCaptureOrder(wants, (id) => id === 'course', failed).map((w) => `${w.screenId}:${w.variantId}`).join(',')
  ok(
    '찍는 순서 — 글에 넣는 코스 화면 먼저, 이번 화면에서 실패한 화면은 맨 뒤(같은 무리는 받은 순서)',
    order() === 'course:kids,course:default,map:default,map:r-원도심' && order(new Set(['course:kids'])) === 'course:default,map:default,map:r-원도심,course:kids',
  )
  const latest = latestScreenShots([
    { screenId: 'course', variantId: 'kids', capturedAt: '2026-11-01T00:00:00.000Z', id: 'old' },
    { screenId: 'course', variantId: 'kids', capturedAt: '2026-11-04T00:00:00.000Z', id: 'new' },
    { screenId: 'map', variantId: 'default', capturedAt: '2026-11-02T00:00:00.000Z', id: 'map' },
  ])
  ok('변형마다 가장 늦게 찍은 화면', latest.size === 2 && latest.get('course:kids')?.id === 'new' && latest.get('map:default')?.id === 'map')
  ok('지도 미리보기 안내는 저장하지 않는다고 말한다', MAP_PREVIEW_ONLY_TEXT.includes('카카오 지도') && MAP_PREVIEW_ONLY_TEXT.includes('저장 안 함'))

  // ── 4) PNG 크기 ────────────────────────────────────────────────────────
  const pngA = fakePng(1)
  const size = pngSize(pngA)
  ok('PNG 머리(IHDR)에서 가로 · 세로를 읽는다', size?.width === 1280 && size.height === 800)
  ok('PNG가 아니거나 잘린 그림은 null', pngSize(Buffer.from('not a png at all, just some text bytes')) === null && pngSize(pngA.subarray(0, 20)) === null)

  // ── 5) 다리 — 쓸 수 없을 때 ────────────────────────────────────────────
  const none = createCaptureBridge(undefined)
  ok('parentPort가 없으면 찍을 수 없는 다리', none.available === false && (await codeOf(none.capture({ url: 'https://gunsan.webforai.kr/plan/', options: { host: 'gunsan.webforai.kr' } }))) === 'unavailable')
  const noneCode = await codeOf(captureScreenShot('fake-none', kidsTarget, { bridge: none }))
  ok('다리가 없고 오늘 찍은 것도 없으면 unavailable · 아무것도 쓰지 않는다', noneCode === 'unavailable' && !existsSync(path.join(unitDir, 'data', 'fake-none')))
  ok('검증 스크립트(자식 프로세스 아님)의 기본 다리도 쓸 수 없다', screens.screenCaptureAvailable() === false)

  // ── 6) 다리 — 가짜 parentPort ──────────────────────────────────────────
  {
    const port = new FakePort()
    const bridge = createCaptureBridge(port, { waitMs: () => 300 })
    const req1 = { url: 'https://gunsan.webforai.kr/plan/?with=kids&kids=7', options: kidsOpts }
    const req2 = { url: 'https://gunsan.webforai.kr/map/', options: { host: 'gunsan.webforai.kr', map: true as const } }
    const p1 = bridge.capture(req1)
    const p2 = bridge.capture(req2)
    await flush()
    const first = port.posted[0]
    ok('요청은 한 번에 하나 — 앞 요청의 답 전에는 다음 요청을 보내지 않는다', port.posted.length === 1)
    ok(
      '요청 모양 { type: screen-capture, id, url, options }',
      first?.type === 'screen-capture' && typeof first.id === 'string' && first.url === req1.url && JSON.stringify(first.options) === JSON.stringify(kidsOpts),
    )
    port.emit(null)
    port.emit('text')
    port.emit({ type: 'set-env', name: 'X', value: 'y' })
    port.emit({ type: 'screen-capture-result', id: 'unknown-id', ok: true, png: pngA.toString('base64') })
    await flush()
    ok('모르는 id · 다른 type · 모양이 틀린 메시지는 지나친다', port.posted.length === 1)
    port.emit({ type: 'screen-capture-result', id: first?.id, ok: true, png: pngA.toString('base64'), width: 1280, height: 800, finalUrl: req1.url, warnings: ['w1', 3] })
    const got = await p1
    ok('답의 PNG(base64)를 바이트로 받는다', got.png.equals(pngA) && got.finalUrl === req1.url && JSON.stringify(got.warnings) === '["w1"]' && got.text === undefined)
    {
      const portT = new FakePort()
      const bridgeT = createCaptureBridge(portT, { waitMs: () => 300 })
      const pT = bridgeT.capture(req1)
      await flush()
      portT.emit({ type: 'screen-capture-result', id: portT.posted[0]?.id, ok: true, png: pngA.toString('base64'), text: 'x'.repeat(2500) })
      const gotT = await pT
      const pT2 = bridgeT.capture(req1)
      await flush()
      portT.emit({ type: 'screen-capture-result', id: portT.posted[1]?.id, ok: true, png: pngA.toString('base64'), text: 42 })
      ok('잘라 찍은 부분의 글자(text)를 받는다 — 2000자까지, 글자가 아니면 없음', gotT.text?.length === 2000 && (await pT2).text === undefined)
      // 찍은 화소 배율(scale) — 잘라 찍기는 2. 없거나 1이거나 1~4의 정수가 아니면 없음(1배로 본다).
      const scaleOf = async (scale: unknown) => {
        const p = bridgeT.capture(req1)
        await flush()
        portT.emit({ type: 'screen-capture-result', id: portT.posted[portT.posted.length - 1]?.id, ok: true, png: pngA.toString('base64'), ...(scale === undefined ? {} : { scale }) })
        return (await p).scale
      }
      ok(
        '찍은 배율(scale)을 받는다 — 2배는 2, 없음 · 1 · 1~4의 정수가 아니면 없음(1배)',
        (await scaleOf(2)) === 2 && (await scaleOf(undefined)) === undefined && (await scaleOf(1)) === undefined && (await scaleOf(2.5)) === undefined &&
          (await scaleOf('2')) === undefined && (await scaleOf(9)) === undefined,
      )
      // 찍은 화면 가로(viewWidth) — 장소 안내는 600(2026-11-05). 없음 · 1280(기본)이면 없음, 360~1920의 정수가 아니면 없음(1280으로 본다).
      const viewWidthOf = async (viewWidth: unknown) => {
        const p = bridgeT.capture(req1)
        await flush()
        portT.emit({
          type: 'screen-capture-result', id: portT.posted[portT.posted.length - 1]?.id, ok: true, png: pngA.toString('base64'), scale: 2, ...(viewWidth === undefined ? {} : { viewWidth }),
        })
        return ((await p) as { viewWidth?: unknown }).viewWidth
      }
      ok(
        '찍은 화면 가로(viewWidth)를 받는다 — 600은 600, 없음 · 1280 · 360~1920의 정수가 아니면 없음(1280)',
        (await viewWidthOf(600)) === 600 && (await viewWidthOf(undefined)) === undefined && (await viewWidthOf(1280)) === undefined &&
          (await viewWidthOf(600.5)) === undefined && (await viewWidthOf('600')) === undefined && (await viewWidthOf(359)) === undefined && (await viewWidthOf(1921)) === undefined,
      )
    }
    await flush()
    ok('앞 답이 오면 다음 요청을 보낸다', port.posted.length === 2)
    port.emit({ type: 'screen-capture-result', id: port.posted[1]?.id, ok: false, code: 'kogl-image', message: '공공누리 그림이 보입니다.' })
    ok('실패 답은 그 코드로 거부', (await codeOf(p2)) === 'kogl-image')

    const p3 = bridge.capture(req1)
    await flush()
    port.emit({ type: 'screen-capture-result', id: port.posted[2]?.id, ok: false, code: 'Evil Code!', message: 'x' })
    ok('모양이 틀린 실패 코드는 failed로', (await codeOf(p3)) === 'failed')
    const p4 = bridge.capture(req1)
    await flush()
    port.emit({ type: 'screen-capture-result', id: port.posted[3]?.id, ok: true, png: 42 })
    ok('ok인데 PNG 글자가 없으면 bad-png', (await codeOf(p4)) === 'bad-png')

    const p5 = bridge.capture(req1)
    await flush()
    const lateId = port.posted[4]?.id
    ok('답이 한도 안에 오지 않으면 timeout', (await codeOf(p5)) === 'timeout')
    port.emit({ type: 'screen-capture-result', id: lateId, ok: true, png: pngA.toString('base64') })
    const p6 = bridge.capture(req2)
    await flush()
    port.emit({ type: 'screen-capture-result', id: port.posted[5]?.id, ok: true, png: pngA.toString('base64') })
    ok('늦게 온 답은 버리고 다음 요청은 그대로 돈다', (await codeOf(p6)) === 'resolved' && port.posted.length === 6)

    const port2 = new FakePort()
    const small = createCaptureBridge(port2, { maxQueue: 2, waitMs: () => 2000 })
    const q1 = small.capture(req1)
    const q2 = small.capture(req1)
    ok('줄이 가득 차면 busy', (await codeOf(small.capture(req1))) === 'busy')
    await flush()
    port2.emit({ type: 'screen-capture-result', id: port2.posted[0]?.id, ok: false, code: 'timeout', message: 'x' })
    await codeOf(q1)
    await flush()
    port2.emit({ type: 'screen-capture-result', id: port2.posted[1]?.id, ok: false, code: 'timeout', message: 'x' })
    await codeOf(q2)

    const port3 = new FakePort()
    port3.throwOnPost = true
    ok('메인에 보내지 못하면 unavailable', (await codeOf(createCaptureBridge(port3, { waitMs: () => 2000 }).capture(req1))) === 'unavailable')
  }

  // ── 6b) 캡처 모듈(electron/capture.cjs) — electron을 가짜로 바꿔 읽는다(창 · 사이트를 열지 않는다) ─────────────
  {
    const capture = loadCaptureModule()
    // 페이지 안 그림 검사 — 모든 요소가 1280×800 첫 화면에 보인다고 두고 jsdom에서 그대로 돌린다.
    const inspect = (html: string, setup?: (doc: Document) => void) => {
      const dom = new JSDOM(html, { url: 'https://gunsan.webforai.kr/plan/', runScripts: 'outside-only', virtualConsole: new VirtualConsole() })
      const w = dom.window
      w.innerWidth = 1280
      w.innerHeight = 800
      w.Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1280, bottom: 800, width: 1280, height: 800, x: 0, y: 0, toJSON: () => ({}) })
      setup?.(w.document)
      return w.eval(`(${capture.pageInspect.toString()})('gunsan.webforai.kr', null, ['daumcdn.net', 'kakao.com', 'kakaocdn.net'])`) as InspectResult
    }
    const FOREIGN_BG = 'background-image:url(https://foreign.example/bg.jpg)'
    ok('그림 검사 — 요소의 바깥 배경 · 바깥 그림을 잡는다', inspect(`<style>.c{${FOREIGN_BG}}</style><div class="c">x</div>`).foreign.includes('foreign.example') && inspect('<img src="https://foreign.example/a.jpg">').foreign.includes('foreign.example'))
    ok(
      '그림 검사 — <body> · <html> 배경의 바깥 그림도 잡는다(첫 화면 전체를 덮는다)',
      inspect(`<style>body{${FOREIGN_BG}}</style><div>x</div>`).foreign.includes('foreign.example') && inspect(`<style>html{${FOREIGN_BG}}</style><div>x</div>`).foreign.includes('foreign.example'),
    )
    ok('그림 검사 — 공공누리 표시가 붙은 <body>의 배경도 공공누리로 센다', inspect('<style>body{background-image:url(https://gunsan.webforai.kr/k.jpg)}</style><body data-kogl="3"><div>x</div></body>').kogl > 0)
    ok('그림 검사 — 자사 호스트의 배경 · 그림은 그대로 둔다', inspect('<style>body{background-image:url(/bg.jpg)}</style><img src="/a.png">').foreign.length === 0)
    const shadowImg = inspect('<div id="h"></div>', (doc) => {
      doc.getElementById('h')!.attachShadow({ mode: 'open' }).innerHTML = '<img src="https://foreign.example/in-shadow.jpg">'
    })
    const shadowKogl = inspect('<div data-kogl="3"><div id="h"></div></div>', (doc) => {
      doc.getElementById('h')!.attachShadow({ mode: 'open' }).innerHTML = '<img src="https://gunsan.webforai.kr/k.jpg">'
    })
    // jsdom은 shadow root 안의 <style>을 계산 스타일에 넣지 않는다 — 인라인 style로 둔다.
    const nestedBg = inspect('<div id="h"></div>', (doc) => {
      const outer = doc.getElementById('h')!.attachShadow({ mode: 'open' })
      outer.innerHTML = '<span id="i"></span>'
      outer.getElementById('i')!.attachShadow({ mode: 'open' }).innerHTML = `<p style="${FOREIGN_BG}">x</p>`
    })
    ok(
      '그림 검사 — 웹 컴포넌트(열린 shadow root, 겹쳐도) 안의 바깥 그림 · 배경 · 공공누리 표시 아래 그림도 잡는다',
      shadowImg.images === 1 && shadowImg.foreign.includes('foreign.example') && shadowKogl.kogl > 0 && nestedBg.foreign.includes('foreign.example'),
    )
    const tree = (closed: boolean) => ({
      nodeName: '#document',
      children: [{
        nodeName: 'HTML',
        children: [{
          nodeName: 'BODY',
          children: [
            { nodeName: 'VIDEO', shadowRoots: [{ nodeName: '#document-fragment', shadowRootType: 'user-agent', children: [] }] },
            {
              nodeName: 'X-CARD',
              shadowRoots: [{ nodeName: '#document-fragment', shadowRootType: 'open', children: [{ nodeName: 'X-INNER', shadowRoots: [{ nodeName: '#document-fragment', shadowRootType: closed ? 'closed' : 'open', children: [] }] }] }],
            },
          ],
        }],
      }],
    })
    ok(
      '닫힌 shadow root 세기(CDP DOM.getDocument pierce) — 열린 root 안까지 내려가 세고, 브라우저 기본 root(video 등)는 세지 않는다',
      capture.countClosedShadowRoots(tree(true)) === 1 && capture.countClosedShadowRoots(tree(false)) === 0 && capture.countClosedShadowRoots(null) === 0,
    )

    // 잘라 찍기 — 요소마다 자리(data-r="x,y,w,h", 화면 좌표)를 주고 jsdom에서 페이지 안 함수를 그대로 돌린다(군산각 장소 페이지 실측 자리).
    // 화면 높이는 800(1배 첫 화면), 잘라 찍기 화면을 흉내 낼 때는 2100. 가로는 1280(장소 안내 600 화면을 흉내 낼 때는 600).
    const rectWindow = (html: string, height = 800, width = 1280) => {
      const dom = new JSDOM(html, { url: 'https://gunsan.webforai.kr/places/x/', runScripts: 'outside-only', virtualConsole: new VirtualConsole() })
      const w = dom.window
      w.innerWidth = width
      w.innerHeight = height
      w.Element.prototype.getBoundingClientRect = function (this: Element) {
        const [x, y, width, height] = (this.getAttribute('data-r') ?? '0,0,0,0').split(',').map(Number) as [number, number, number, number]
        return { left: x, top: y, right: x + width, bottom: y + height, width, height, x, y, toJSON: () => ({}) }
      }
      return w
    }
    const inPage = <T,>(w: ReturnType<typeof rectWindow>, fn: (...a: never[]) => unknown, ...args: unknown[]) => w.eval(`(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})`) as T
    const PLACE_HTML = [
      '<nav class="lnav" style="position:sticky" data-r="320,0,945,52">바로가기</nav>',
      '<article class="place"><div class="pl-head" data-r="364,108,384,857">',
      '<p class="kicker" data-r="364,108,403,32">관광지</p><h1 data-r="364,146,384,47">가상박물관</h1><div class="summary" data-r="364,235,384,167">가상 소개</div>',
      '<dl class="kf kf-hero" data-r="364,430,384,323"><dt>이용시간</dt><dd><img src="/assets/icons/fact-hours-64.webp" data-r="390,600,32,32">09:00–18:00</dd><dt>요금</dt><dd>성인 2,000원</dd></dl>',
      '</div><figure class="pv" data-r="799,114,342,323"><img src="https://tong.visitkorea.or.kr/a.jpg" data-kogl="3" data-r="799,114,342,291"></figure></article>',
      '<div class="fab" style="position:fixed;background:#123" data-r="1167,452,56,195"></div>',
    ].join('')
    const SEL = ['article.place .pl-head h1', 'article.place dl.kf.kf-hero']
    const OPT = ['article.place .pl-head .kicker', 'article.place .pl-head .pl-alt', 'article.place .pl-head .summary']
    const pw = rectWindow(PLACE_HTML)
    const state = inPage<ClipState>(pw, capture.pageClipState, SEL, OPT, 800)
    ok(
      '잘라 찍을 요소 — 필수 · 있는 선택 요소의 자리(문서 좌표)와 글자(문서 순서), 위에 붙은 머리 높이',
      state.missing.length === 0 && state.rects.length === 4 && state.text.startsWith('관광지\n가상박물관\n가상 소개\n이용시간') && state.text.includes('성인 2,000원') &&
        state.cover === 52 && state.docWidth === 1280,
    )
    ok('필수 요소가 없으면 missing(선택 요소는 없어도 된다)', JSON.stringify(inPage<ClipState>(pw, capture.pageClipState, ['article.place .nope', 'h1'], ['.pl-alt']).missing) === '["article.place .nope"]')
    // 위에 붙은 머리 — 잘라 찍기 화면(1280×2100)에서도 1배 첫 화면 높이(800)의 절반 위에서 끝나는 고정 · sticky 요소만. 화면 높이의 절반(1050)으로
    // 보면 위에 붙은 높이 600 옆 칸(사각형과 안 겹침)을 머리로 쳐 1배에서 찍히던 페이지가 clip-covered가 됐다(검토 2026-11-05).
    const SIDE_NAV = '<nav class="side" style="position:fixed" data-r="0,0,300,600">옆 칸</nav>'
    const TALL_HEAD = '<header class="big" style="position:sticky" data-r="0,0,1280,380">큰 머리</header>'
    ok(
      '위에 붙은 머리(잘라 찍기 화면 2100) — 높이 600 옆 칸은 머리가 아니다(1배 화면과 같이 52) · 380에서 끝나는 머리는 그대로 머리',
      inPage<ClipState>(rectWindow(`${PLACE_HTML}${SIDE_NAV}`, 2100), capture.pageClipState, SEL, OPT, 800).cover === 52 &&
        inPage<ClipState>(rectWindow(`${PLACE_HTML}${SIDE_NAV}`), capture.pageClipState, SEL, OPT, 800).cover === 52 &&
        inPage<ClipState>(rectWindow(`${PLACE_HTML}${TALL_HEAD}`, 2100), capture.pageClipState, SEL, OPT, 800).cover === 380,
    )
    const page = { docWidth: 1280, docHeight: 16000, viewWidth: 1280, viewHeight: 800, scrollX: 0, scrollY: 0, cover: 52 }
    const plan = capture.clipPlan(state.rects, 16, { ...state, viewWidth: 1280, viewHeight: 800, scrollX: 0, scrollY: 0, docHeight: 16000 })
    ok(
      '잘라 찍기 계획 — 요소를 합친 사각형 + 여백 16(정수) · 첫 화면에 들어가면 스크롤하지 않는다',
      plan.problem === null && JSON.stringify(plan.rect) === JSON.stringify({ x: 348, y: 92, width: 435, height: 677 }) && plan.scrollY === 0,
    )
    const tall = [{ x: 364, y: 146, w: 384, h: 700 }]
    ok(
      '잘라 찍기 계획 — 아래가 넘치면 머리 아래에 들어오는 가장 덜 움직이는 스크롤(위에서 62 · 아래에서 78)',
      capture.clipPlan(tall, 16, page).scrollY === 62 && capture.clipPlan(tall, 16, { ...page, scrollY: 500 }).scrollY === 78 && capture.clipPlan(tall, 16, page).problem === null,
    )
    ok(
      '잘라 찍기 계획 — 화면보다 크면 clip-too-large(머리를 뺀 높이 · 가로), 너무 작으면 clip-too-small, 머리에 가리면 clip-covered, 요소가 없으면 clip-missing',
      capture.clipPlan([{ x: 364, y: 146, w: 384, h: 740 }], 16, page).problem === 'clip-too-large' &&
        capture.clipPlan([{ x: 100, y: 146, w: 1200, h: 100 }], 16, { ...page, docWidth: 1500 }).problem === 'clip-too-large' &&
        capture.clipPlan([{ x: 10, y: 300, w: 50, h: 20 }], 16, page).problem === 'clip-too-small' &&
        capture.clipPlan([{ x: 364, y: 30, w: 384, h: 200 }], 16, page).problem === 'clip-covered' && capture.clipPlan([], 16, page).problem === 'clip-missing',
    )
    ok('잘라 찍기 계획 — 여백은 문서 안으로 자른다', JSON.stringify(capture.clipPlan([{ x: 5, y: 200, w: 300, h: 200 }], 16, page).rect) === JSON.stringify({ x: 0, y: 184, width: 321, height: 232 }))
    // 긴 안내 카드(근대역사박물관 425×920 — 2026-11-05 실측, 800 화면에서는 clip-too-large였다) — 잘라 찍기 화면(1280×2100)에서는 통째로
    // 들어온다. 세로는 2000(CSS px)까지 — 넘으면 화면에 들어와도 clip-too-large.
    const clipPage = { ...page, viewHeight: 2100 }
    const museumCard = capture.clipPlan([{ x: 364, y: 108, w: 393, h: 888 }], 16, clipPage)
    ok(
      '잘라 찍기 계획(1280×2100) — 425×920 카드는 스크롤 없이 통째로 · 세로 2000까지, 2001이면 clip-too-large',
      museumCard.problem === null && museumCard.scrollY === 0 && JSON.stringify(museumCard.rect) === JSON.stringify({ x: 348, y: 92, width: 425, height: 920 }) &&
        capture.clipPlan([{ x: 364, y: 108, w: 393, h: 1968 }], 16, clipPage).problem === null &&
        capture.clipPlan([{ x: 364, y: 108, w: 393, h: 1969 }], 16, clipPage).problem === 'clip-too-large' &&
        capture.clipPlan([{ x: 364, y: 108, w: 393, h: 1969 }], 16, { ...clipPage, viewHeight: 2600 }).problem === 'clip-too-large',
    )
    // 가장자리 규칙(잉크) — 넣지 않는 보이는 요소(obstacles — 잉크 상자: 테두리 상자 + 바깥 그림자 · drop-shadow · outline)가 사각형 가장자리를
    // 지나면 그 가장자리를 잉크 상자 바로 밖으로 옮긴다. 넣을 요소들을 합친 사각형 안으로는 들이지 않는다. 600 화면에서는 여백 16이 카드 아래
    // 「출처 · 확인 필요」 줄의 5~7줄(장치 화소)을 23곳 모두에서 찍었고, 분류 줄 위 아이콘(옛 배치)은 상자만 보면 그림자(drop-shadow 0 6px 8px)
    // 7~10줄이 남았다(실측 2026-11-05).
    const CARD600 = [{ x: 27, y: 124, w: 546, h: 569 }]
    const page600 = { docWidth: 600, docHeight: 3000, viewWidth: 600, viewHeight: 2100, scrollX: 0, scrollY: 0, cover: 52 }
    const rectWith = (obstacles: (Box & { core?: Box })[], rects: Box[] = CARD600) => JSON.stringify(capture.clipPlan(rects, 16, { ...page600, obstacles }).rect)
    const R600 = (y: number, height: number, x = 11, width = 578) => JSON.stringify({ x, y, width, height })
    ok(
      '가장자리 규칙 — 카드 아래 줄이 아래 가장자리를 지나면 아래를 그 줄 바로 위로(578×601 → 578×594) · 위 · 왼쪽 · 오른쪽은 그대로',
      rectWith([]) === R600(108, 601) && rectWith([{ x: 27, y: 702, w: 546, h: 20 }]) === R600(108, 594),
    )
    const HEAD_RECTS = [{ x: 27, y: 202, w: 546, h: 491 }]
    // 걸림돌의 잉크 상자는 번짐 끝(표준편차의 3배)까지, core는 번짐을 뺀 진한 부분이다. 아이콘(150–186)의 drop-shadow(0 6px 8px)는 진한 부분이
    // 150–192로 넣을 요소(202) 위에 통째로 있고, 번짐 끝(216)만 넣을 요소에 걸친다 — 위를 넣을 요소의 위(202)까지 옮긴다. 예전 입력은 번짐을
    // 1.5배로 본 잉크 상자(144–204)뿐이었다: 진한 부분을 따로 주지 않으면 넣을 요소에 걸친 걸림돌과 가를 수 없다(검토 2026-11-05).
    ok(
      '가장자리 규칙 — 분류 줄 위 아이콘의 그림자(잉크 132–216 · 진한 부분 150–192)가 위 가장자리(186)를 지나면 위를 넣을 요소의 위(202)까지 · 상자(150–186)만 보면 그대로 186 · 진한 부분까지 넣을 요소에 걸치면 그대로 186',
      rectWith([{ x: 3, y: 132, w: 112, h: 84, core: { x: 27, y: 150, w: 64, h: 42 } }], HEAD_RECTS) === R600(202, 507) &&
        rectWith([{ x: 27, y: 150, w: 64, h: 36 }], HEAD_RECTS) === R600(186, 523) && rectWith([{ x: 3, y: 132, w: 112, h: 84 }], HEAD_RECTS) === R600(186, 523),
    )
    // 넣을 요소에 겹친 걸림돌은 어느 가장자리를 옮겨도 새 가장자리에 그대로 걸친다 — 옮기면 여백만 없어진다. 예전 기대값은 넣을 요소의 끝까지
    // 옮긴 R600(108, 585) · R600(124, 585)였다: 걸림돌은 그대로 그림 가장자리에 남고, 넣을 요소들 사이의 가로 가득 구분선 하나로 왼쪽 · 오른쪽
    // 여백이 없어져 제목이 그림 가장자리에 붙었다(검토 2026-11-05).
    ok(
      '가장자리 규칙 — 넣을 요소에 겹친 요소(아래 칸 · 위 띠)는 옮겨도 뺄 수 없으므로 가장자리를 옮기지 않는다(여백 그대로)',
      rectWith([{ x: 27, y: 680, w: 546, h: 40 }]) === R600(108, 601) && rectWith([{ x: 27, y: 100, w: 546, h: 40 }]) === R600(108, 601),
    )
    const TWO_RECTS = [{ x: 27, y: 124, w: 546, h: 40 }, { x: 27, y: 200, w: 546, h: 493 }]
    ok(
      '가장자리 규칙 — 넣을 요소들(제목 · 카드) 사이의 가로 가득 구분선 · 뒤에 깔린 가로 가득 배경판은 왼쪽 · 오른쪽 여백 16을 그대로 둔다',
      rectWith([{ x: 0, y: 190, w: 600, h: 1 }], TWO_RECTS) === R600(108, 601) && rectWith([{ x: 0, y: 150, w: 600, h: 320 }], TWO_RECTS) === R600(108, 601) &&
        rectWith([{ x: 0, y: 190, w: 600, h: 1 }, { x: 27, y: 702, w: 546, h: 20 }], TWO_RECTS) === R600(108, 594),
    )
    ok(
      '가장자리 규칙 — 왼쪽 · 오른쪽은 그대로: 화면 가로 가득한 아래 줄은 아래만 옮기고, 여백 안에만 있는 요소 · 사각형 밖 요소는 그대로',
      rectWith([{ x: 0, y: 702, w: 600, h: 20 }]) === R600(108, 594) && rectWith([{ x: 27, y: 695, w: 546, h: 10 }]) === R600(108, 601) &&
        rectWith([{ x: 0, y: 720, w: 600, h: 40 }, { x: 0, y: 0, w: 600, h: 100 }]) === R600(108, 601),
    )
    ok(
      '가장자리 규칙 — 옆 요소가 왼쪽 가장자리만 지나면 왼쪽만 옮긴다(위 · 아래는 그대로)',
      rectWith([{ x: 0, y: 300, w: 15, h: 100 }]) === R600(108, 601, 15, 574),
    )
    ok(
      '가장자리 규칙 — 옮긴 가장자리에 걸리게 된 요소도 다시 본다(아이콘 그림 · 묶음이 차례로 — 108 → 110 → 114)',
      rectWith([{ x: 27, y: 109, w: 64, h: 5 }, { x: 27, y: 100, w: 64, h: 10 }]) === R600(114, 595),
    )
    // 잉크 상자는 페이지 안(pageClipState)에서 잰다 — 넣을 요소 · 그 조상(배경을 칠한 article) · 그 안의 요소, 고정 · sticky 요소(가리는 고정
    // 요소 검사가 따로 본다), 보이지 않는 요소는 빼고, 스스로 그리는 것(배경 · 테두리 · 그림자 · 필터 · outline · 글자 · 그림)만.
    const INK_HTML = [
      '<header class="top" style="position:sticky;background:#123" data-r="0,0,600,52">위 줄</header>',
      '<article class="place" style="background:#fff" data-r="0,100,600,900">',
      `<p class="pl-kpic" data-r="27,150,64,36" data-cs='${JSON.stringify({ filter: 'drop-shadow(rgba(0, 0, 0, 0.25) 0px 6px 8px)' })}'><img src="/assets/icons/k.webp" data-r="27,150,64,36"></p>`,
      '<p class="kicker" data-r="27,202,200,20">관광지</p><h1 data-r="27,230,546,40">가상박물관</h1>',
      '<dl class="kf" data-r="27,290,546,403"><dt data-r="43,306,100,20">이용시간</dt><dd data-r="43,330,200,20">09:00–18:00</dd></dl>',
      '<p class="hidden-line" style="display:none" data-r="27,700,546,20">숨긴 줄</p>',
      `<div class="note" data-r="27,712,546,30" data-cs='${JSON.stringify({ boxShadow: 'rgba(0, 0, 0, 0.2) 0px -2px 8px 0px' })}'></div>`,
      '</article>',
    ].join('')
    const inkState = inPage<ClipState>(chromeLike(rectWindow(INK_HTML, 2100, 600)), capture.pageClipState, ['h1', 'dl.kf'], ['.kicker'], 800, 16)
    const inkNames = (inkState.obstacles ?? []).map((o) => o.d ?? '').sort().join(',')
    const inkPlan = capture.clipPlan(inkState.rects, 16, { ...page600, ...inkState })
    const inkOf = (ink: ClipState, d: string) => JSON.stringify((ink.obstacles ?? []).find((o) => o.d === d))
    // 예전 기대값은 번짐을 drop-shadow 1.5배 · box-shadow 1배로 본 잉크 상자(아이콘 15,144,88,60 · 아래 칸 19,702,562,46)와 아래 702(578×500)였다 —
    // 번짐은 표준편차의 3배까지 그린다(drop-shadow 8px는 표준편차 8 → 24, box-shadow 8px는 표준편차 4 → 12). 진한 부분(core)도 함께 준다.
    ok(
      `잉크 상자(페이지 안) — 아이콘의 drop-shadow · 아래 칸의 box-shadow까지(번짐은 표준편차의 3배 · 진한 부분 core), 조상 · 넣을 요소 안 · sticky · 숨긴 요소는 빼고(${inkNames}) → 위 202 · 아래 698`,
      inkOf(inkState, 'p.pl-kpic') === JSON.stringify({ x: 3, y: 132, w: 112, h: 84, core: { x: 27, y: 150, w: 64, h: 42 }, d: 'p.pl-kpic' }) &&
        inkOf(inkState, 'div.note') === JSON.stringify({ x: 15, y: 698, w: 570, h: 54, core: { x: 27, y: 710, w: 546, h: 32 }, d: 'div.note' }) &&
        !/article|header|hidden-line|dt|dd|kicker|h1/.test(inkNames) && JSON.stringify(inkPlan.rect) === R600(202, 496),
    )
    // 잉크 상자 — filter 목록은 차례로 쌓는다(drop-shadow 두 번이면 아래로 16), drop-shadow() · blur() 길이는 표준편차(3배까지), 직접 든 글자의
    // text-shadow, transform 배율(scale 2면 그림자 6이 12)도 본다. 예전에는 filter 사슬은 가장 큰 하나만, drop-shadow · blur는 1.5배만 보고
    // text-shadow · transform은 보지 않아 카드 위 4~14줄(장치 화소)이 그림 가장자리에 남았다(검토 2026-11-05 합성 페이지 실측).
    const BLACK = 'rgb(0, 0, 0)'
    const INK2_HTML = [
      '<h1 data-r="40,200,400,200">가짜 장소</h1>',
      `<div class="chain" data-r="40,105,400,70" data-cs='${JSON.stringify({ backgroundColor: 'rgb(136, 136, 136)', filter: `drop-shadow(${BLACK} 0px 8px 0px) drop-shadow(${BLACK} 0px 8px 0px)` })}'></div>`,
      `<p class="ts" data-r="40,150,300,20" data-cs='${JSON.stringify({ textShadow: `${BLACK} 0px 20px 0px` })}'>출처 · 확인 필요</p>`,
      `<div class="sc" data-r="40,126,400,50" data-ow="200" data-oh="25" data-cs='${JSON.stringify({ backgroundColor: 'rgb(136, 136, 136)', boxShadow: `${BLACK} 0px 6px 0px 0px` })}'></div>`,
      `<div class="ds" data-r="40,104,400,70" data-cs='${JSON.stringify({ backgroundColor: 'rgb(136, 136, 136)', filter: `drop-shadow(${BLACK} 0px 0px 8px)` })}'></div>`,
      `<div class="bl" data-r="40,100,400,70" data-cs='${JSON.stringify({ backgroundColor: BLACK, filter: 'blur(10px)' })}'></div>`,
    ].join('')
    const ink2Win = chromeLike(rectWindow(INK2_HTML, 2100, 600))
    for (const [prop, attr] of [['offsetWidth', 'data-ow'], ['offsetHeight', 'data-oh']] as const) {
      Object.defineProperty(ink2Win.HTMLElement.prototype, prop, { configurable: true, get(this: Element) { return Number(this.getAttribute(attr) ?? 0) } })
    }
    const ink2 = inPage<ClipState>(ink2Win, capture.pageClipState, ['h1'], [], 800, 16)
    ok(
      `잉크 상자 — filter 사슬은 쌓고(아래 16) · drop-shadow · blur는 표준편차의 3배 · text-shadow · transform 배율까지(${(ink2.obstacles ?? []).map((o) => o.d).join(',')})`,
      inkOf(ink2, 'div.chain') === JSON.stringify({ x: 40, y: 105, w: 400, h: 86, core: { x: 40, y: 105, w: 400, h: 86 }, d: 'div.chain' }) &&
        inkOf(ink2, 'p.ts') === JSON.stringify({ x: 40, y: 150, w: 300, h: 40, core: { x: 40, y: 150, w: 300, h: 40 }, d: 'p.ts' }) &&
        inkOf(ink2, 'div.sc') === JSON.stringify({ x: 40, y: 126, w: 400, h: 62, core: { x: 40, y: 126, w: 400, h: 62 }, d: 'div.sc' }) &&
        inkOf(ink2, 'div.ds') === JSON.stringify({ x: 16, y: 80, w: 448, h: 118, core: { x: 40, y: 104, w: 400, h: 70 }, d: 'div.ds' }) &&
        inkOf(ink2, 'div.bl') === JSON.stringify({ x: 10, y: 70, w: 460, h: 130, core: { x: 40, y: 100, w: 400, h: 70 }, d: 'div.bl' }),
    )
    // 소수 자리 — 사각형은 넣을 요소들을 합친 사각형을 정수로 넓혀(floor · ceil) 여백을 두른다. 걸림돌 후보도 같은 정수 사각형 + 여백으로 고른다:
    // 소수 사각형 + 여백(24.6 · 416.6)으로 고르면 그 사이 1px 미만 띠에서 시작하는 이웃(오른쪽이 24.5인 검은 칸 · 위가 416.7인 검은 줄)을 보지
    // 못해, 사각형(24부터 · 417까지)에 그 조각이 찍혔다(검토 2026-11-05: 왼쪽 2줄).
    const ROUND_HTML = [
      '<h1 data-r="40.6,200,400,200.6">가짜 장소</h1>',
      `<div class="lb" data-r="0,200,24.5,200" data-cs='${JSON.stringify({ backgroundColor: BLACK })}'></div>`,
      `<div class="bb" data-r="40,416.7,400,20" data-cs='${JSON.stringify({ backgroundColor: BLACK })}'></div>`,
    ].join('')
    const roundState = inPage<ClipState>(chromeLike(rectWindow(ROUND_HTML, 2100, 600)), capture.pageClipState, ['h1'], [], 800, 16)
    const roundPlan = capture.clipPlan(roundState.rects, 16, { ...page600, ...roundState })
    ok(
      `가장자리 규칙(소수 자리) — 정수 사각형(24부터 · 417까지)에 걸친 이웃도 걸림돌로 보고 빼 25부터 · 416까지(${JSON.stringify(roundPlan.rect)})`,
      (roundState.obstacles ?? []).map((o) => o.d).sort().join(',') === 'div.bb,div.lb' && JSON.stringify(roundPlan.rect) === JSON.stringify({ x: 25, y: 184, width: 432, height: 232 }),
    )
    const clipInspect = (region?: Rect) =>
      inPage<InspectResult>(pw, capture.pageInspect, 'gunsan.webforai.kr', null, ['daumcdn.net', 'kakao.com', 'kakaocdn.net'], region ?? null, 800)
    const inside = clipInspect(plan.rect!)
    const wide = clipInspect({ x: 348, y: 92, width: 824, height: 364 })
    ok(
      '그림 검사(잘라 찍기) — 사각형 밖의 공공누리 · 바깥 그림은 괜찮고, 사각형에 걸치면 잡는다 · 사각형이 없으면 첫 화면 전체',
      inside.kogl === 0 && inside.foreign.length === 0 && inside.images === 1 && wide.kogl > 0 && wide.foreign.includes('tong.visitkorea.or.kr') && clipInspect().kogl > 0,
    )
    ok(
      '그림 검사(잘라 찍기) — 1px만 걸쳐도 걸친 것(799에서 끝나면 밖, 800이면 안)',
      clipInspect({ x: 348, y: 92, width: 451, height: 300 }).kogl === 0 && clipInspect({ x: 348, y: 92, width: 452, height: 300 }).kogl > 0,
    )
    ok(
      '가리는 고정 요소 — 사각형에 걸친 고정 · sticky 요소를 알린다(밖이면 · 잘라 찍을 요소를 품으면 아니다)',
      JSON.stringify(inPage<string[]>(pw, capture.pageClipCovers, SEL, OPT, plan.rect)) === '[]' &&
        JSON.stringify(inPage<string[]>(pw, capture.pageClipCovers, SEL, OPT, { x: 348, y: 92, width: 900, height: 500 })) === '["div.fab"]' &&
        JSON.stringify(inPage<string[]>(rectWindow('<div class="stick" style="position:sticky" data-r="300,80,600,700"><h1 data-r="364,146,384,47">x</h1></div>'), capture.pageClipCovers, ['h1'], [], plan.rect)) === '[]',
    )
    // 가리는 고정 요소 — 내용 뒤에 깔린 고정 배경(z-index 음수)과 그리는 것이 없는 투명 틀(알림 뿌리 inset:0)은 가리지 않는다. 투명 틀 안의
    // 알림이 사각형에 걸치면 가린다(검토 2026-11-04: 전체 화면 고정 배경이 있는 페이지는 늘 clip-covered였다).
    const coverOf = (html: string) => JSON.stringify(inPage<string[]>(chromeLike(rectWindow(`${html}<h1 data-r="364,146,384,47">x</h1>`)), capture.pageClipCovers, ['h1'], [], plan.rect))
    ok(
      '가리는 고정 요소 — 뒤에 깔린 고정 배경 · 투명한 틀은 아니고, 틀 안의 알림이 걸치거나 색이 있는 고정 요소는 가린다',
      coverOf('<div class="bgfx" style="position:fixed;z-index:-1;background:#eef" data-r="0,0,1280,800"></div>') === '[]' &&
        coverOf('<div class="toasts" style="position:fixed" data-r="0,0,1280,800"><div class="toast" style="background:#123" data-r="1000,700,200,50">알림</div></div>') === '[]' &&
        coverOf('<div class="toasts" style="position:fixed" data-r="0,0,1280,800"><div class="toast" style="background:#123" data-r="400,300,200,50">알림</div></div>') === '["div.toasts"]' &&
        coverOf('<div class="bar" style="position:fixed;background:#123" data-r="0,200,1280,60"></div>') === '["div.bar"]',
    )
    // 그림 검사 — 투명도 0인 공공누리 · 바깥 그림도 센다(스크롤로 드러나는 그림이 검사 뒤 · 찍기 전에 나타날 수 있다). display:none은 세지 않는다.
    const KOGL_IMG = '<figure data-kogl="3" data-r="100,120,200,100"><img src="/img/k.png" data-r="100,120,200,100"></figure>'
    const REGION = { x: 84, y: 84, width: 532, height: 400 }
    const chromeInspect = (html: string, region: Rect | null = REGION) =>
      inPage<InspectResult>(chromeLike(rectWindow(html)), capture.pageInspect, 'gunsan.webforai.kr', null, ['daumcdn.net', 'kakao.com', 'kakaocdn.net'], region, 800)
    ok(
      '그림 검사 — 투명도 0(드러내기 전)인 공공누리 그림도 센다 · display:none은 세지 않는다',
      chromeInspect(`<div class="rv" style="opacity:0" data-r="100,120,200,100">${KOGL_IMG}</div>`).kogl > 0 &&
        chromeInspect(`<div class="rv" style="opacity:0" data-r="100,120,200,100">${KOGL_IMG}</div>`, null).kogl > 0 &&
        chromeInspect(`<div style="display:none" data-r="100,120,200,100">${KOGL_IMG}</div>`).kogl === 0,
    )
    // 가상 요소(::before · ::after) 그림 — host 상자 밖으로 그려도 그 자리로 본다(사각형 옆 요소의 가상 요소가 사각형 안에 그린 공공누리 그림).
    const PSEUDO = (left: string) =>
      `<div class="side" data-kogl="3" data-r="700,100,300,300" data-cs='{"position":"absolute"}' data-before='${JSON.stringify({ backgroundImage: 'url("/img/k.png")', position: 'absolute', left, top: '40px', width: '200px', height: '100px', marginLeft: '0px', marginTop: '0px', transform: 'none' })}'></div>`
    ok(
      '그림 검사 — 사각형 밖 요소의 가상 요소가 사각형 안에 그린 공공누리 그림을 잡는다 · 사각형 밖에 그리면 괜찮다',
      chromeInspect(PSEUDO('-300px')).kogl > 0 && chromeInspect(PSEUDO('20px')).kogl === 0,
    )
    // 가상 요소 자리를 어림할 수 없을 때(transform · % 값) — host가 1배 첫 화면(1280×800)과 사각형을 합친 범위에 걸칠 때만 센다. 잘라 찍기
    // 화면(2100) 전체로 보면 사각형 아래 먼 공공누리 칸(y 1200) 때문에 1배에서 찍히던 페이지가 kogl-image가 됐다(검토 2026-11-05).
    const FAR_PSEUDO = (y: number) =>
      `<div class="kp" data-kogl="3" data-r="820,${y},300,200" data-cs='{"position":"absolute"}' data-before='${JSON.stringify({ backgroundImage: 'url("/img/k.png")', position: 'absolute', left: '10px', top: '10px', width: '100px', height: '80px', transform: 'translateX(1px)' })}'></div>`
    const tallInspect = (html: string, region: Rect) =>
      inPage<InspectResult>(chromeLike(rectWindow(html, 2100)), capture.pageInspect, 'gunsan.webforai.kr', null, ['daumcdn.net', 'kakao.com', 'kakaocdn.net'], region, 800)
    const SHORT_CLIP = { x: 332, y: 84, width: 457, height: 572 }
    const LONG_CLIP = { x: 332, y: 84, width: 457, height: 1332 }
    ok(
      '그림 검사(잘라 찍기 화면 2100) — 자리를 어림할 수 없는 가상 요소는 1배 첫 화면 · 사각형을 합친 범위만: 사각형 아래 먼 칸(y 1200)은 괜찮고, 첫 화면 안 · 긴 사각형 옆이면 센다',
      tallInspect(FAR_PSEUDO(1200), SHORT_CLIP).kogl === 0 && tallInspect(FAR_PSEUDO(500), SHORT_CLIP).kogl > 0 && tallInspect(FAR_PSEUDO(1200), LONG_CLIP).kogl > 0,
    )
    // 위 두 경우를 찍기 순서 전체로(captureSteps가 넘기는 인자까지) — 페이지 안 함수를 잘라 찍기 화면(1280×2100)의 jsdom 페이지에서 돌린다.
    const CARD = (h: number) => `<header class="top" style="position:sticky;background:#123" data-r="0,0,1280,52">위 줄</header><h1 data-r="348,100,425,${h}">가짜 장소</h1>`
    const pageOf = (html: string) => (view: { width: number; height: number }) => chromeLike(rectWindow(html, view.height, view.width))
    const sidePage = await runFakePage({ clip: true, page: pageOf(`${CARD(540)}${SIDE_NAV}`) })
    const farPage = await runFakePage({ clip: true, page: pageOf(`${CARD(540)}${FAR_PSEUDO(1200)}`) })
    const nearPage = await runFakePage({ clip: true, page: pageOf(`${CARD(1300)}${FAR_PSEUDO(1200)}`) })
    ok(
      `잘라 찍기(1280×2100) — 높이 600 옆 칸 · 사각형 아래 먼 공공누리 칸이 있어도 1배처럼 찍고(914×1144), 긴 사각형 옆 공공누리 칸은 버린다(${sidePage.code} · ${farPage.code} · ${nearPage.code})`,
      sidePage.code === 'resolved' && sidePage.result?.width === 914 && sidePage.result.height === 1144 && farPage.code === 'resolved' && nearPage.code === 'kogl-image',
    )
    // 가장자리 규칙을 찍기 순서 전체로 — 600 화면(장소 안내)의 jsdom 페이지: 카드 아래 출처 줄은 아래를, 분류 줄 위 아이콘의 그림자는 위를 옮긴다.
    const HEAD600 = '<header class="top" style="position:sticky;background:#123" data-r="0,0,600,52">위 줄</header>'
    const CARD_PAGE = `${HEAD600}<h1 data-r="27,124,546,40">가짜 장소</h1><dl class="kf" data-r="27,180,546,513"><dt>이용시간</dt><dd>09:00–18:00</dd></dl><p class="kf-prov" data-r="27,702,546,20">출처 · 확인 필요</p>`
    const ICON_PAGE = [
      HEAD600,
      `<p class="pl-kpic" data-r="27,150,64,36" data-cs='${JSON.stringify({ filter: 'drop-shadow(rgba(0, 0, 0, 0.25) 0px 6px 8px)' })}'><img src="/assets/icons/k.webp" data-r="27,150,64,36"></p>`,
      '<p class="kicker" data-r="27,202,200,20">관광지</p><h1 data-r="27,230,546,40">가짜 장소</h1><dl class="kf" data-r="27,290,546,403"><dt>이용시간</dt></dl>',
    ].join('')
    const edgeOpts = { selectors: ['h1', 'dl.kf'], optional: ['.kicker'], viewWidth: 600 }
    const provPage = await runFakePage({ clip: true, clipOptions: edgeOpts, page: pageOf(CARD_PAGE) })
    const iconPage = await runFakePage({ clip: true, clipOptions: edgeOpts, page: pageOf(ICON_PAGE) })
    ok(
      `가장자리 규칙(찍기 순서 · 600 화면) — 출처 줄은 빼고 578×594(1156×1188), 아이콘 그림자는 빼고 578×507(${provPage.code} ${JSON.stringify(provPage.result?.clip)} · ${iconPage.code} ${JSON.stringify(iconPage.result?.clip)})`,
      provPage.code === 'resolved' && JSON.stringify(provPage.result?.clip) === JSON.stringify({ x: 11, y: 108, width: 578, height: 594 }) &&
        provPage.result?.width === 1156 && provPage.result.height === 1188 && iconPage.code === 'resolved' &&
        JSON.stringify(iconPage.result?.clip) === JSON.stringify({ x: 11, y: 202, width: 578, height: 507 }) && iconPage.result?.width === 1156 && iconPage.result.height === 1014,
    )
    ok(
      '그림 검사 — SVG pattern 안의 <image> · <input type=image> · border-image의 공공누리 그림도 잡는다',
      chromeInspect('<svg data-kogl="3" data-r="100,120,300,120"><defs><pattern id="p"><image href="/img/k.png"></image></pattern></defs><rect fill="url(#p)" data-r="100,120,300,120"></rect></svg>').kogl > 0 &&
        chromeInspect('<span data-kogl="3" data-r="100,120,200,100"><input type="image" src="/img/k.png" data-r="100,120,200,100"></span>').kogl > 0 &&
        chromeInspect(`<div data-kogl="3" data-r="100,120,200,100" data-cs='{"borderImageSource":"url(\\"/img/k.png\\")"}'></div>`).kogl > 0 &&
        chromeInspect('<span data-r="100,120,200,100"><input type="image" src="https://foreign.example/b.png" data-r="100,120,200,100"></span>').foreign.includes('foreign.example'),
    )
    const dnsCache = new Map([['gunsan.webforai.kr', Promise.resolve(false)], ['tong.visitkorea.or.kr', Promise.resolve(false)]])
    const own = { host: 'gunsan.webforai.kr', ownHostOnly: true, dnsCache }
    ok(
      '자사 호스트만(ownHostOnly) — 바깥 그림 요청은 off-host, 자사 · data: 는 통과, 끄면 바깥 그림도 통과(지도 · 코스 화면)',
      (await capture.requestBlockReason({ url: 'https://tong.visitkorea.or.kr/a.jpg', method: 'GET', resourceType: 'image' }, own)) === 'off-host' &&
        (await capture.requestBlockReason({ url: 'https://gunsan.webforai.kr/assets/a.webp', method: 'GET', resourceType: 'image' }, own)) === null &&
        (await capture.requestBlockReason({ url: 'data:image/png;base64,AA==', method: 'GET', resourceType: 'image' }, own)) === null &&
        (await capture.requestBlockReason({ url: 'https://gunsan.webforai.kr/api/plan/', method: 'POST', resourceType: 'xhr' }, own)) === 'method' &&
        (await capture.requestBlockReason({ url: 'https://tong.visitkorea.or.kr/a.jpg', method: 'GET', resourceType: 'image' }, { ...own, ownHostOnly: false })) === null,
    )
    // 옵션 검사 — 선택자 · 여백 · 함께 쓸 수 없는 옵션(지도 · 스크롤)은 창을 만들기 전에 invalid-options.
    const optCode = (options: Record<string, unknown>) => codeOf(capture.captureScreen('https://gunsan.webforai.kr/places/x/', { host: 'gunsan.webforai.kr', ...options }))
    const badClips = await Promise.all([
      optCode({ clip: { selectors: [] } }),
      optCode({ clip: { selectors: ['h1{color:red}'] } }),
      optCode({ clip: { selectors: ['h1'], padding: 99 } }),
      optCode({ clip: { selectors: ['h1'], padding: 1.5 } }),
      optCode({ clip: { selectors: ['h1'], optional: 'x' } }),
      optCode({ clip: { selectors: ['h1'], optional: ['<b>'] } }),
      optCode({ clip: { selectors: Array(9).fill('h1') } }),
      optCode({ clip: { selectors: ['h1'] }, map: true }),
      optCode({ clip: { selectors: ['h1'] }, scrollTo: 'h1' }),
      optCode({ clip: 'h1' }),
      optCode({ ownHostOnly: 'yes' }),
    ])
    ok('잘라 찍기 옵션 검사 — 잘못된 선택자 · 여백 · 지도/스크롤과 함께 · ownHostOnly 모양은 invalid-options(창을 만들지 않는다)', badClips.every((c) => c === 'invalid-options') && capture.windowsCreated() === 0)
    // 잘라 찍기 화면 가로(viewWidth) — 360~1920의 정수만. 검사를 지나면 주소를 확인하므로(DNS) 그동안은 가짜 주소로 답한다(밖으로 묻지 않는다).
    {
      const realLookup = dns.promises.lookup
      dns.promises.lookup = (() => Promise.resolve([{ address: '93.184.216.34', family: 4 }])) as unknown as typeof dns.promises.lookup
      try {
        const badWidths = await Promise.all([359, 1921, 600.5, '600', null, 0].map((viewWidth) => optCode({ clip: { selectors: ['h1'], viewWidth } })))
        ok(
          `잘라 찍기 화면 가로(viewWidth) 검사 — 360~1920의 정수가 아니면 invalid-options(창을 만들지 않는다 — ${badWidths.join(',')})`,
          badWidths.every((c) => c === 'invalid-options') && capture.windowsCreated() === 0,
        )
      } finally {
        dns.promises.lookup = realLookup
      }
    }
    // 그림 decode — 보이지 않는 그림(checkVisibility false — 닫힌 <details> 안의 메뉴 아이콘)은 기다리지 않고, 보이는 늦게 읽는(lazy) 그림은 끝까지
    // 기다린다. 1023 이하 화면에서는 닫힌 모바일 메뉴(details.menu > nav.menu-panel)의 lazy 아이콘 둘이 끝내 읽히지 않아, 이것이 없으면 600 화면의
    // 장소 안내가 모두 eval-timeout이었다(실측 2026-11-05).
    {
      const dw = chromeLike(
        rectWindow(
          '<details class="menu"><nav class="menu-panel" style="position:fixed"><img id="menu-icon" src="/assets/icons/btn-plan-64.webp" data-r="530,127,24,24"></nav></details>' +
            '<img id="lazy-icon" src="/assets/icons/fact-hours-64.webp" data-r="43,330,32,32"><img id="done-icon" src="/assets/icons/fact-fee-64.webp" data-r="43,380,32,32">',
          2100,
          600,
        ),
      )
      const doc = dw.document
      const menuIcon = doc.getElementById('menu-icon')!
      const lazyIcon = doc.getElementById('lazy-icon')!
      const doneIcon = doc.getElementById('done-icon')!
      let lazyLoaded = false
      Object.defineProperty(menuIcon, 'complete', { get: () => false })
      Object.defineProperty(lazyIcon, 'complete', { get: () => lazyLoaded })
      Object.defineProperty(doneIcon, 'complete', { get: () => true })
      for (const img of [menuIcon, lazyIcon, doneIcon]) Object.assign(img, { decode: () => Promise.resolve() })
      Object.assign(menuIcon, { checkVisibility: () => false })
      const started = Date.now()
      setTimeout(() => {
        lazyLoaded = true
        lazyIcon.dispatchEvent(new dw.Event('load'))
      }, 300)
      let decodeResult: { count: number; failed: number } | null = null
      let decodeError = ''
      try {
        decodeResult = await Promise.race([
          dw.eval(`(${String(capture.pageDecode)})()`) as Promise<{ count: number; failed: number }>,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
        ])
      } catch (err) {
        decodeError = String(err).slice(0, 80)
      }
      const decodeMs = Date.now() - started
      ok(
        `그림 decode — 보이지 않는 메뉴 아이콘은 기다리지 않고, 보이는 늦게 읽는 그림은 읽힐 때까지 기다린다(${decodeError || JSON.stringify(decodeResult)} · ${decodeMs}ms)`,
        decodeResult !== null && decodeResult.count === 2 && decodeResult.failed === 0 && decodeMs >= 280,
      )
    }
    const relay = capture as unknown as { handleCaptureRequest: (m: unknown) => Promise<{ ok: boolean; code?: string; message?: string } | null> }
    const viaRelay = await relay.handleCaptureRequest({ type: 'screen-capture', id: 'clip-1', url: 'https://gunsan.webforai.kr/places/x/', options: { host: 'gunsan.webforai.kr', clip: { selectors: [] }, ownHostOnly: true } })
    const unknownKey = await relay.handleCaptureRequest({ type: 'screen-capture', id: 'clip-2', url: 'https://gunsan.webforai.kr/places/x/', options: { host: 'gunsan.webforai.kr', bogus: 1 } })
    ok(
      '서버 요청의 옵션 이름 — clip · ownHostOnly는 받는다(선택자 검사까지 간다), 모르는 이름은 거절',
      viaRelay?.code === 'invalid-options' && String(viaRelay.message).includes('잘라 찍을 선택자') && unknownKey?.code === 'invalid-options' && String(unknownKey.message).includes('찍기 옵션'),
    )

    // 종료 경합 — 주소의 DNS를 확인하는 동안 앱이 끝나면(disposeCapture) 창을 만들지 않는다.
    const realLookup = dns.promises.lookup
    const dnsGate: { release?: () => void } = {}
    dns.promises.lookup = (() =>
      new Promise((resolve) => {
        dnsGate.release = () => resolve([{ address: '93.184.216.34', family: 4 }])
      })) as unknown as typeof dns.promises.lookup
    try {
      const job = codeOf(capture.captureScreen('https://gunsan.webforai.kr/plan/', { host: 'gunsan.webforai.kr' }))
      for (let i = 0; i < 50 && !dnsGate.release; i += 1) await flush()
      const waitedForDns = Boolean(dnsGate.release)
      capture.disposeCapture()
      dnsGate.release?.()
      const code = await job
      ok('DNS를 확인하는 동안 앱이 끝나면 캡처 창을 만들지 않고 disposed로 거부', waitedForDns && code === 'disposed' && capture.windowsCreated() === 0)
      ok('끝난 뒤의 찍기는 바로 disposed', (await codeOf(capture.captureScreen('https://gunsan.webforai.kr/plan/', { host: 'gunsan.webforai.kr' }))) === 'disposed')
    } finally {
      dns.promises.lookup = realLookup
    }
  }

  // ── 6c) 캡처 순서(captureSteps) — 가짜 페이지로 한 장을 끝까지 돈다(창 · 사이트 · 네트워크 없음) ─────────────
  {
    // 잘라 찍기 스크롤 뒤에는 페이지가 반응할 틈(조용함 0.8초)을 준 다음 그림을 검사한다 — 예전에는 스크롤하고 5ms 안에 검사해, 스크롤로
    // 드러나는 공공누리 그림이 검사 뒤 · 찍기 전에 나타나 그대로 찍혔다(검토 2026-11-04, 드러내기 40~120ms).
    const scrolled = await runFakePage({ clip: true })
    const waited = scrolled.log.scrollAt !== null && scrolled.log.inspectAt[0] !== undefined ? scrolled.log.inspectAt[0] - scrolled.log.scrollAt : -1
    ok(`잘라 찍기 — 스크롤한 뒤 조용함(0.8초)을 기다린 다음 그림을 검사한다(기다린 시간 ${waited}ms)`, scrolled.code === 'resolved' && waited >= 750)
    // 찍은 뒤 그림 검사를 한 번 더 — 그사이 공공누리 · 바깥 그림이 나타났으면 그 그림을 버린다.
    const KOGL_AFTER: InspectResult = { images: 1, mapImages: 0, foreign: [], kogl: 1, frames: [] }
    const FOREIGN_AFTER: InspectResult = { images: 1, mapImages: 0, foreign: ['foreign.example'], kogl: 0, frames: [] }
    const changedClip = await runFakePage({ clip: true, afterShot: KOGL_AFTER })
    const changedFull = await runFakePage({ clip: false, afterShot: FOREIGN_AFTER })
    ok(
      '찍은 뒤 다시 검사해 그사이 나타난 공공누리 · 바깥 그림이 있으면 버린다(잘라 찍기 · 첫 화면 모두)',
      changedClip.code === 'kogl-image' && changedClip.log.inspectAt.length === 2 && changedFull.code === 'foreign-image' && changedFull.log.inspectAt.length === 2,
    )
    // 잘라 찍기도 닫힌 shadow root는 모두 센다 — host 상자로 사각형과 견주면 display:contents host(상자 없음) · host 밖으로 넘친 내용 안의
    // 공공누리 그림을 놓친다(검토 2026-11-04). 첫 화면 모드와 같다.
    const closedTree = {
      nodeName: '#document',
      children: [{ nodeName: 'HTML', children: [{ nodeName: 'BODY', children: [{ nodeName: 'X-BOX', backendNodeId: 7, shadowRoots: [{ nodeName: '#document-fragment', shadowRootType: 'closed', children: [] }] }] }] }],
    }
    const closedClip = await runFakePage({ clip: true, tree: closedTree })
    ok('잘라 찍기 — 상자가 없는(display:contents) host의 닫힌 shadow root도 세어 버린다', closedClip.code === 'closed-shadow')

    // 2배 잘라 찍기(2026-11-05 결정 — 블로그에서 더 크게) — 화면 배율 2를 사이트를 열기 전(빈 페이지)에 정해 사이트가 고해상도 그림(srcset)을
    // 고르고 글자도 2배로 그린다(clip.scale 2는 1배 그림을 늘린다 — 실측). 찍은 그림은 사각형(CSS px)의 2배, 사각형 · 검사는 CSS px 그대로.
    const PAGE_URL = 'https://gunsan.webforai.kr/places/x/'
    const clip2x = await runFakePage({ clip: true })
    const metric2x = clip2x.log.metrics[0] ?? {}
    const shot2x = clip2x.log.shots[0] as { clip?: Rect & { scale?: number }; captureBeyondViewport?: boolean } | undefined
    ok(
      '잘라 찍기 — 사이트를 열기 전에 화면 흉내 1280×2100 · 배율 2(창은 그대로 1280×800), 찍기는 clip scale 1 · 화면 안에서만',
      clip2x.code === 'resolved' && clip2x.log.metrics.length === 1 && metric2x.deviceScaleFactor === 2 && metric2x.width === 1280 && metric2x.height === 2100 &&
        clip2x.log.steps.indexOf('metrics') < clip2x.log.steps.indexOf(`load:${PAGE_URL}`) && clip2x.log.windows[0]?.width === 1280 && clip2x.log.windows[0]?.height === 800 &&
        shot2x?.clip?.scale === 1 && shot2x.captureBeyondViewport === false,
    )
    ok(
      '잘라 찍기 — 찍은 그림은 사각형(532×332 CSS px)의 2배 1064×664 · 결과에 scale 2 · 사각형은 CSS px(문서 좌표) 그대로',
      clip2x.result?.width === 1064 && clip2x.result.height === 664 && clip2x.result.scale === 2 &&
        JSON.stringify(clip2x.result.clip) === JSON.stringify({ x: 84, y: 2284, width: 532, height: 332 }),
    )
    const relay2x = await runFakePage({ clip: true, relay: true })
    ok('잘라 찍기 — 서버로 보내는 답에도 배율(scale 2)과 2배 크기', relay2x.code === 'resolved' && relay2x.result?.scale === 2 && relay2x.result.width === 1064 && relay2x.result.height === 664)
    // 긴 안내 카드 — 근대역사박물관 425×920(2026-11-05 실측 · 800 화면에서는 clip-too-large로 두 자리가 비었다)도 통째로 찍는다.
    const tallCard = await runFakePage({ clip: true, rects: [{ x: 364, y: 108, w: 393, h: 888 }] })
    ok(
      '긴 안내 카드(425×920) — clip-too-large 대신 통째로 찍는다(850×1840)',
      tallCard.code === 'resolved' && tallCard.result?.width === 850 && tallCard.result.height === 1840 &&
        JSON.stringify(tallCard.result.clip) === JSON.stringify({ x: 348, y: 92, width: 425, height: 920 }),
    )
    const tooTall = await runFakePage({ clip: true, rects: [{ x: 364, y: 108, w: 393, h: 1970 }] })
    ok('잘라 찍을 부분이 2000(CSS px)보다 길면 그대로 clip-too-large(찍지 않는다)', tooTall.code === 'clip-too-large' && tooTall.log.shots.length === 0)
    // 첫 화면 통째(코스 · 지도)는 그대로 — 창 · 화면 1280×800 · 배율 1 · clip 없이 찍기.
    const full = await runFakePage({ clip: false })
    ok(
      '첫 화면 통째는 그대로 — 창 1280×800 · 화면 흉내 1280×800 배율 1 · clip 없이 찍기 · 1280×800 · scale 1',
      full.code === 'resolved' &&
        JSON.stringify(full.log.metrics) === JSON.stringify([{ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false, screenWidth: 1280, screenHeight: 800 }]) &&
        full.log.windows[0]?.width === 1280 && full.log.windows[0]?.height === 800 &&
        JSON.stringify(full.log.shots) === JSON.stringify([{ format: 'png', fromSurface: true, captureBeyondViewport: false }]) &&
        full.result?.width === 1280 && full.result.height === 800 && full.result.scale === 1 && full.result.clip === null,
    )
    // 장소 안내는 600 화면(clip.viewWidth 600)으로 찍는다 — 사이트를 열기 전(빈 페이지)에 화면 흉내 600×2100 · 배율 2(screenWidth도 600 — 사이트의
    // 반응형 배치가 그 폭을 본다). 창은 그대로 1280×800. 가로를 정하지 않은 잘라 찍기(가이드)와 첫 화면 통째(코스 · 지도)는 1280 그대로.
    const NARROW_RECTS = [{ x: 27, y: 2300, w: 546, h: 300 }]
    const narrow = await runFakePage({ clip: true, clipOptions: { viewWidth: 600 }, rects: NARROW_RECTS })
    ok(
      `장소 안내(가로 600) — 사이트를 열기 전에 화면 흉내 600×2100 · 배율 2 · screenWidth 600, 창은 1280×800 · 찍은 그림은 사각형(578×332)의 2배 · 결과에 viewWidth 600(${narrow.code})`,
      narrow.code === 'resolved' &&
        JSON.stringify(narrow.log.metrics) === JSON.stringify([{ width: 600, height: 2100, deviceScaleFactor: 2, mobile: false, screenWidth: 600, screenHeight: 2100 }]) &&
        narrow.log.steps.indexOf('metrics') < narrow.log.steps.indexOf(`load:${PAGE_URL}`) && narrow.log.windows[0]?.width === 1280 && narrow.log.windows[0]?.height === 800 &&
        narrow.result?.width === 1156 && narrow.result.height === 664 && narrow.result.scale === 2 && narrow.result.viewWidth === 600,
    )
    const narrowRelay = await runFakePage({ clip: true, clipOptions: { viewWidth: 600 }, rects: NARROW_RECTS, relay: true })
    ok('장소 안내(가로 600) — 서버로 보내는 답에도 viewWidth 600', narrowRelay.code === 'resolved' && narrowRelay.result?.viewWidth === 600 && narrowRelay.result.scale === 2)
    ok(
      '가로를 정하지 않은 잘라 찍기(가이드) · 첫 화면 통째는 1280 그대로 — 화면 흉내 1280(screenWidth 1280) · 결과 viewWidth 1280',
      JSON.stringify(clip2x.log.metrics) === JSON.stringify([{ width: 1280, height: 2100, deviceScaleFactor: 2, mobile: false, screenWidth: 1280, screenHeight: 2100 }]) &&
        clip2x.result?.viewWidth === 1280 && relay2x.result?.viewWidth === 1280 && full.result?.viewWidth === 1280,
    )
  }

  // ── 7) 저장 · 같은 날 다시 쓰기 ─────────────────────────────────────────
  {
    const T = 'fake-gunsan'
    const pngs: Buffer[] = []
    const texts: string[] = []
    // 답의 화소 배율 — 잘라 찍기(장소 안내 · 가이드)는 메인이 2배로 찍어 scale 2를 보낸다(2026-11-05). 넣지 않은 찍기는 scale 없음(1배).
    // 화면 가로 — 메인은 찍은 화면 가로(viewWidth)를 돌려준다: 잘라 찍기 옵션의 viewWidth(장소 안내 600), 없으면 1280.
    const scales: number[] = []
    let calls = 0
    let delayMs = 0
    const port = new FakePort()
    port.onPost = (msg) => {
      calls += 1
      const png = pngs.shift()
      const text = texts.shift()
      const clip = (msg.options as { clip?: { viewWidth?: number } } | undefined)?.clip
      const scale = clip ? scales.shift() : undefined
      setTimeout(
        () =>
          port.emit({
            type: 'screen-capture-result', id: msg.id, ok: true, png: png ? png.toString('base64') : '', ...(text !== undefined ? { text } : {}),
            ...(scale !== undefined ? { scale } : {}), viewWidth: clip?.viewWidth ?? 1280,
          }),
        delayMs,
      )
    }
    const bridge = createCaptureBridge(port, { waitMs: () => 3000 })
    const day1 = new Date('2026-11-04T03:00:00.000Z') // KST 12:00
    const dir = screensDir(T)
    pngs.push(pngA)
    const r1 = await captureScreenShot(T, kidsTarget, { bridge, now: () => day1 })
    const list1 = await readScreenShots(T)
    ok(
      '찍은 그림을 <sha16>.png와 screens.json 한 줄로 저장',
      !r1.reused && calls === 1 && r1.shot.sha16 === sha16(pngA) && readFileSync(path.join(dir, `${sha16(pngA)}.png`)).equals(pngA) &&
        list1.length === 1 && JSON.stringify(list1[0]) === JSON.stringify({
          sha16: sha16(pngA), screenId: 'course', variantId: 'kids', url: 'https://gunsan.webforai.kr/plan/?with=kids&kids=7', capturedAt: day1.toISOString(), width: 1280, height: 800, bytes: pngA.length,
        }),
    )
    const later = new Date(day1.getTime() + 5 * 3600 * 1000) // KST 17:00 같은 날
    const r2 = await captureScreenShot(T, kidsTarget, { bridge, now: () => later })
    ok('같은 날(KST) 같은 주소면 다시 찍지 않고 그것을 준다', r2.reused && r2.shot.sha16 === r1.shot.sha16 && calls === 1)
    const r2b = await captureScreenShot(T, kidsTarget, { bridge: createCaptureBridge(undefined), now: () => later })
    ok('찍을 수 없는 실행에서도 오늘 찍은 것은 준다', r2b.reused && r2b.shot.sha16 === r1.shot.sha16)
    const day2 = new Date(day1.getTime() + 24 * 3600 * 1000)
    pngs.push(pngA)
    const r3 = await captureScreenShot(T, kidsTarget, { bridge, now: () => day2 })
    const list3 = await readScreenShots(T)
    ok('다음 날은 다시 찍고, 같은 그림이면 줄을 더하지 않고 찍은 때만 새로', !r3.reused && calls === 2 && list3.length === 1 && list3[0]?.capturedAt === day2.toISOString())
    const pngB = fakePng(2)
    const day3 = new Date(day2.getTime() + 24 * 3600 * 1000)
    pngs.push(pngB)
    const r4 = await captureScreenShot(T, kidsTarget, { bridge, now: () => day3 })
    ok('그림이 바뀌면 새 줄 · 새 파일', !r4.reused && calls === 3 && (await readScreenShots(T)).length === 2 && existsSync(path.join(dir, `${sha16(pngB)}.png`)))

    const mapTarget = { profile: profile!, ...findScreenVariant(profile!, 'map', 'default')! }
    const pngM = fakePng(3)
    pngs.push(pngM)
    delayMs = 50
    const [m1, m2] = await Promise.all([captureScreenShot(T, mapTarget, { bridge, now: () => day3 }), captureScreenShot(T, mapTarget, { bridge, now: () => day3 })])
    ok('같은 화면 · 변형을 찍는 중에 또 청하면 한 번만 찍는다', calls === 4 && m1.shot.sha16 === sha16(pngM) && m2.shot.sha16 === m1.shot.sha16)
    delayMs = 0

    const before = readdirSync(dir).sort().join(',')
    pngs.push(Buffer.from('garbage-not-png'))
    const badCode = await codeOf(captureScreenShot(T, { profile: profile!, ...findScreenVariant(profile!, 'course', 'parents')! }, { bridge, now: () => day3 }))
    ok('PNG가 아닌 답은 bad-png · 아무것도 쓰지 않는다', badCode === 'bad-png' && readdirSync(dir).sort().join(',') === before && (await readScreenShots(T)).length === 3)
    const tooBig = await codeOf(storeScreenShot(T, kidsTarget, 'https://gunsan.webforai.kr/plan/', Buffer.concat([pngA, Buffer.alloc(9 * 1024 * 1024)]), day3))
    ok('8MB를 넘는 그림은 받지 않는다', tooBig === 'bad-png')

    ok('목록에 있는 id의 파일을 준다', (await readScreenFile(T, sha16(pngB)))?.equals(pngB) === true)
    writeFileSync(path.join(dir, 'aaaaaaaaaaaaaaaa.png'), pngA)
    ok(
      '목록에 없는 파일 · 모양이 틀린 id는 주지 않는다',
      (await readScreenFile(T, 'aaaaaaaaaaaaaaaa')) === null && (await readScreenFile(T, 'ffffffffffffffff')) === null && (await readScreenFile(T, '../screens')) === null &&
        (await readScreenFile(T, 'screens.json')) === null,
    )

    const pickOfShot = (sha: string, screenId: string, variantId: string, tenant = T) => ({ src: screenAppSrc(tenant, sha), origin: 'screen' as const, screenId, variantId })
    const owned = ['gunsan.webforai.kr']
    const fileFor = await screenFileForPick(T, owned, pickOfShot(sha16(pngB), 'course', 'kids'))
    ok('사진 받기 — 코스 화면 사진이면 이 PC의 파일', Buffer.isBuffer(fileFor) && fileFor.equals(pngB))
    ok('사진 받기 — 지도 화면 사진은 not-allowed', (await screenFileForPick(T, owned, pickOfShot(sha16(pngM), 'map', 'default'))) === 'not-allowed')
    ok(
      '사진 받기 — 다른 브랜드 주소 · 다른 변형 · 프로필 없는 브랜드면 gone',
      (await screenFileForPick(T, owned, pickOfShot(sha16(pngB), 'course', 'kids', 'other'))) === 'gone' &&
        (await screenFileForPick(T, owned, pickOfShot(sha16(pngB), 'course', 'parents'))) === 'gone' &&
        (await screenFileForPick(T, ['stay.example'], pickOfShot(sha16(pngB), 'course', 'kids'))) === 'gone',
    )

    // 장소 안내 — 찍기 전에 사이트 장소 목록을 본다(가짜 목록) · 찍은 부분의 글자(text)와 잘라 찍은 크기를 적는다
    const placeTarget = { profile: profile!, ...findScreenVariant(profile!, 'place-info', '가상박물관')! }
    let listedCalls = 0
    const listed = (slugs: string[]) => async () => {
      listedCalls += 1
      return new Set(slugs)
    }
    const callsBefore = calls
    const notListed = await codeOf(captureScreenShot(T, placeTarget, { bridge, now: () => day3, listedPlaces: listed(['다른곳']) }))
    ok('장소 안내 — 사이트 장소 목록에 없는 장소는 찍지 않는다(not-listed · 400)', notListed === 'not-listed' && calls === callsBefore && screens.captureErrorStatus('not-listed') === 400)
    const dirFail = await codeOf(
      captureScreenShot(T, placeTarget, {
        bridge,
        now: () => day3,
        listedPlaces: async () => {
          throw new Error('HTTP 500')
        },
      }),
    )
    ok('장소 안내 — 장소 목록을 읽지 못하면 찍지 않는다(directory-failed · 502)', dirFail === 'directory-failed' && calls === callsBefore && screens.captureErrorStatus('directory-failed') === 502)
    // 잘라 찍기는 2배로 찍는다(2026-11-05) — 425×677(CSS px) 사각형의 PNG는 850×1354이고 메인이 scale 2를 보낸다.
    const pngP = fakePng(21, 850, 1354)
    pngs.push(pngP)
    texts.push('가상박물관\n이용시간\n09:00–18:00')
    scales.push(2)
    const placeShot = await captureScreenShot(T, placeTarget, { bridge, now: () => day3, listedPlaces: listed(['가상박물관']) })
    const placeRow = (await readScreenShots(T)).find((x) => x.screenId === 'place-info')
    // 예전 기대값은 width 425 · height 677(1배 PNG)이었다 — 잘라 찍기를 2배로 찍게 되어(2026-11-05 결정) 같은 사각형의 PNG가 850×1354다.
    // 기록의 width · height는 늘 PNG 화소 크기이고, 배율(scale 2)을 함께 적는다(CSS 크기 = 화소 ÷ 배율).
    ok(
      '장소 안내 — 목록에 있으면 찍고, 찍은 부분의 글자 · 잘라 찍은 크기(PNG 화소) · 배율 2 · 장소 주소를 적는다',
      !placeShot.reused && calls === callsBefore + 1 && placeRow?.variantId === '가상박물관' && placeRow.text === '가상박물관\n이용시간\n09:00–18:00' &&
        placeRow.width === 850 && placeRow.height === 1354 && placeRow.scale === 2 && placeRow.url === screenUrl(profile!, placeTarget.variant),
    )
    ok('장소 안내 — 찍은 화면 가로 600을 기록에 적는다(viewWidth 600)', (placeRow as { viewWidth?: unknown } | undefined)?.viewWidth === 600)
    const listedBefore = listedCalls
    const placeAgain = await captureScreenShot(T, placeTarget, { bridge, now: () => day3, listedPlaces: listed(['가상박물관']) })
    ok('장소 안내 — 같은 날 다시 청하면 목록도 보지 않고 찍어 둔 것을 준다', placeAgain.reused && placeAgain.shot.sha16 === sha16(pngP) && listedCalls === listedBefore && calls === callsBefore + 1)
    const placeFile = await screenFileForPick(T, owned, pickOfShot(sha16(pngP), 'place-info', '가상박물관'))
    ok('사진 받기 — 장소 안내 화면도 이 PC의 파일', Buffer.isBuffer(placeFile) && placeFile.equals(pngP))
    writeFileSync(path.join(dir, 'screens.json'), JSON.stringify({ shots: [...(await readScreenShots(T)), { ...placeRow, sha16: 'dddddddddddddddd', text: 42 }] }))
    ok('글자(text)가 글자가 아닌 줄은 목록에서 뺀다', !(await readScreenShots(T)).some((x) => x.sha16 === 'dddddddddddddddd'))
    writeFileSync(path.join(dir, 'screens.json'), JSON.stringify({ shots: [...(await readScreenShots(T)), { ...placeRow, sha16: 'eeeeeeeeeeeeeeee', scale: 2.5 }] }))
    ok('배율(scale)이 1~4의 정수가 아닌 줄은 목록에서 뺀다', !(await readScreenShots(T)).some((x) => x.sha16 === 'eeeeeeeeeeeeeeee'))
    writeFileSync(
      path.join(dir, 'screens.json'),
      JSON.stringify({
        shots: [
          ...(await readScreenShots(T)), { ...placeRow, sha16: 'ffffffffffff0001', viewWidth: 600.5 }, { ...placeRow, sha16: 'ffffffffffff0002', viewWidth: 100 },
          { ...placeRow, sha16: 'ffffffffffff0003', viewWidth: '600' }, { ...placeRow, sha16: 'ffffffffffff0004', viewWidth: 600 },
        ],
      }),
    )
    const widthRows = (await readScreenShots(T)).map((x) => x.sha16)
    ok(
      '화면 가로(viewWidth)가 360~1920의 정수가 아닌 줄은 목록에서 뺀다(600은 그대로)',
      !widthRows.includes('ffffffffffff0001') && !widthRows.includes('ffffffffffff0002') && !widthRows.includes('ffffffffffff0003') && widthRows.includes('ffffffffffff0004'),
    )

    // 옛 1배 기록 — 2배로 바꾸기 전(2026-11-05 전)에 찍은 잘라 찍기(scale 없음 · 425×677). 목록 · 사진 받기는 그대로 쓰고, 같은 날 다시 청하면
    // 1배 그림을 다시 주지 않고 2배로 다시 찍는다. 첫 화면 통째(코스)의 1배 기록은 같은 날 그대로 다시 쓴다(위 「같은 날 …」).
    const oldTarget = { profile: profile!, ...findScreenVariant(profile!, 'place-info', '옛박물관')! }
    const pngOld = fakePng(22, 425, 677)
    const oldShot = await storeScreenShot(T, oldTarget, screenUrl(profile!, oldTarget.variant), pngOld, day3, '옛박물관\n이용시간\n10:00–17:00')
    const oldRow = (await readScreenShots(T)).find((x) => x.sha16 === sha16(pngOld))
    const oldFile = await screenFileForPick(T, owned, pickOfShot(sha16(pngOld), 'place-info', '옛박물관'))
    ok(
      '옛 1배 기록(scale 없음)도 목록 · 사진 받기에 그대로(425×677)',
      oldShot.scale === undefined && oldRow?.scale === undefined && oldRow?.width === 425 && oldRow.height === 677 && Buffer.isBuffer(oldFile) && oldFile.equals(pngOld),
    )
    const pngNew = fakePng(23, 850, 1354)
    pngs.push(pngNew)
    texts.push('옛박물관\n이용시간\n10:00–17:00')
    scales.push(2)
    const callsOld = calls
    const again2x = await captureScreenShot(T, oldTarget, { bridge, now: () => day3, listedPlaces: listed(['옛박물관']) })
    ok(
      '같은 날이라도 옛 1배 잘라 찍기는 다시 쓰지 않고 2배로 다시 찍는다',
      !again2x.reused && calls === callsOld + 1 && again2x.shot.sha16 === sha16(pngNew) && again2x.shot.scale === 2 && again2x.shot.width === 850 &&
        (await captureScreenShot(T, oldTarget, { bridge, now: () => day3, listedPlaces: listed(['옛박물관']) })).reused && calls === callsOld + 1,
    )
    // 600으로 바꾸기 전(2026-11-05 오전)에 1280 화면 · 2배로 찍은 장소 안내(scale 2 · viewWidth 없음 · 850 화소) — 목록 · 사진 받기는 그대로
    // 쓰고, 같은 날 다시 청하면 1280 그림을 다시 주지 않고 600으로 다시 찍는다. 가이드(1280)의 같은 날 2배 기록은 그대로 다시 쓴다.
    const wideTarget = { profile: profile!, ...findScreenVariant(profile!, 'place-info', '넓은박물관')! }
    const wideUrl = screenUrl(profile!, wideTarget.variant)
    const png1280 = fakePng(24, 850, 1354)
    const wideShot = await storeScreenShot(T, wideTarget, wideUrl, png1280, day3, '넓은박물관\n이용시간\n10:00–17:00', 2)
    const wideRow = (await readScreenShots(T)).find((x) => x.sha16 === sha16(png1280))
    const wideFile = await screenFileForPick(T, owned, pickOfShot(sha16(png1280), 'place-info', '넓은박물관'))
    ok(
      '1280 화면 · 2배 기록(viewWidth 없음)도 목록 · 사진 받기에 그대로(850×1354)',
      (wideShot as { viewWidth?: unknown }).viewWidth === undefined && wideRow !== undefined && !('viewWidth' in wideRow) && wideRow.scale === 2 && wideRow.width === 850 &&
        Buffer.isBuffer(wideFile) && wideFile.equals(png1280),
    )
    pngs.push(fakePng(25, 1156, 1188))
    texts.push('넓은박물관\n이용시간\n10:00–17:00')
    scales.push(2)
    const callsWide = calls
    const again600 = await captureScreenShot(T, wideTarget, { bridge, now: () => day3, listedPlaces: listed(['넓은박물관']) })
    ok(
      '같은 날이라도 1280 화면으로 찍은 장소 안내는 다시 쓰지 않고 600으로 다시 찍는다 — 그다음은 그 600 기록을 다시 쓴다',
      !again600.reused && calls === callsWide + 1 && (again600.shot as { viewWidth?: unknown }).viewWidth === 600 && again600.shot.width === 1156 && again600.shot.scale === 2 &&
        (await captureScreenShot(T, wideTarget, { bridge, now: () => day3, listedPlaces: listed(['넓은박물관']) })).reused && calls === callsWide + 1,
    )
    const guideTarget = { profile: profile!, ...findScreenVariant(profile!, 'kids-guide', 'default')! }
    const pngGuide = fakePng(26, 1648, 728)
    await storeScreenShot(T, guideTarget, screenUrl(profile!, guideTarget.variant), pngGuide, day3, '아이와 함께', 2)
    const guideAgain = await captureScreenShot(T, guideTarget, { bridge, now: () => day3 })
    ok('가이드(1280)는 같은 날 2배 기록(viewWidth 없음)을 그대로 다시 쓴다', guideAgain.reused && guideAgain.shot.sha16 === sha16(pngGuide) && calls === callsWide + 1)
    const storedWidth = async (seed: number, viewWidth?: number) =>
      ((await storeScreenShot(T, wideTarget, wideUrl, fakePng(seed, 1156, 1188), day3, 'x', 2, viewWidth)) as { viewWidth?: unknown }).viewWidth
    ok('기록의 화면 가로 — 600은 적고, 1280 · 없음이면 적지 않는다(예전 줄과 같은 모양)', (await storedWidth(27, 600)) === 600 && (await storedWidth(28, 1280)) === undefined && (await storedWidth(29)) === undefined)

    const C = 'fake-corrupt'
    mkdirSync(screensDir(C), { recursive: true })
    writeFileSync(path.join(screensDir(C), 'screens.json'), '{broken')
    const corruptRead = await readScreenShots(C)
    const corruptStore = await codeOf(storeScreenShot(C, kidsTarget, 'https://gunsan.webforai.kr/plan/', pngA, day3))
    ok('깨진 screens.json — 읽기는 [] · 쓰기는 덮지 않고 실패', corruptRead.length === 0 && corruptStore !== 'resolved' && readFileSync(path.join(screensDir(C), 'screens.json'), 'utf-8') === '{broken')
  }

  // ── 8) 같은 화면 상한(saveAutoPhotoPicks) ───────────────────────────────
  {
    const T = 'fake-caps'
    const draftsFile = path.join(unitDir, 'data', T, 'drafts.json')
    const AT = '2026-11-04T00:00:00.000Z'
    const writeDrafts = (map: Record<string, unknown>) => {
      mkdirSync(path.dirname(draftsFile), { recursive: true })
      writeFileSync(draftsFile, JSON.stringify(map))
    }
    const readMap = () => JSON.parse(readFileSync(draftsFile, 'utf-8')) as Record<string, { photos?: { src: string; variantId?: string }[] }>
    const draft = (id: string, extra: Record<string, unknown> = {}) => ({ actionId: id, generatedAt: AT, draft: { format: 'article', title: '가상 글', sections: [] }, ...extra })
    const shotPick = (variantId: string, sha: string, slot = '코스 만들기 화면', heading = '코스') => ({
      slot, nth: 1, same: 1, heading, src: screenAppSrc(T, sha), alt: "가상 군산 웹사이트 'AI 코스 만들기' 화면", pageUrl: 'https://gunsan.webforai.kr/plan/',
      confirmedAt: AT, auto: true as const, origin: 'screen' as const, screenId: 'course', variantId, capturedAt: AT,
    })
    const sitePick = (src: string) => ({ slot: '정원 풍경', nth: 1, same: 1, heading: '정원', src, alt: '정원', pageUrl: 'https://site.example/', confirmedAt: AT, auto: true as const })
    const S1 = 'a1a1a1a1a1a1a1a1'
    const S2 = 'b2b2b2b2b2b2b2b2'
    const S3 = 'c3c3c3c3c3c3c3c3'

    const four = ['w1', 'w2', 'w3', 'w4']
    writeDrafts(Object.fromEntries(four.map((id) => [id, draft(id)])))
    const groups4: Record<string, string> = { w1: 'A', w2: 'B', w3: 'C', w4: 'D' }
    const rScreen = await saveAutoPhotoPicks(T, four.map((id) => ({ actionId: id, generatedAt: AT, picks: [shotPick('kids', S1)] })), 3, (id) => groups4[id])
    ok('화면은 브랜드 상한 3을 받지 않는다(작성자 넷 · 글 넷에 같은 화면)', rScreen.saved === 4 && rScreen.skipped === 0)
    writeDrafts(Object.fromEntries(four.map((id) => [id, draft(id)])))
    const rSite = await saveAutoPhotoPicks(T, four.map((id) => ({ actionId: id, generatedAt: AT, picks: [sitePick('https://site.example/garden.jpg')] })), 3, (id) => groups4[id])
    ok('사진은 그대로 브랜드 상한 3', rSite.saved === 3 && rSite.skipped === 1)

    writeDrafts({ a1: draft('a1', { photos: [shotPick('kids', S1)] }), a2: draft('a2') })
    const sameWriter = await saveAutoPhotoPicks(T, [{ actionId: 'a2', generatedAt: AT, picks: [shotPick('kids', S2)] }], 3, () => 'A')
    ok('같은 작성자에게는 같은 화면 · 변형 한 번 — 다른 날 찍은 다른 파일이어도', sameWriter.saved === 0 && sameWriter.skipped === 1 && !readMap().a2?.photos)
    const otherVariant = await saveAutoPhotoPicks(T, [{ actionId: 'a2', generatedAt: AT, picks: [shotPick('parents', S3)] }], 3, () => 'A')
    ok('같은 작성자라도 다른 변형은 넣는다', otherVariant.saved === 1 && readMap().a2?.photos?.[0]?.variantId === 'parents')

    writeDrafts({ b1: draft('b1') })
    const twoSlots = await saveAutoPhotoPicks(
      T,
      [{ actionId: 'b1', generatedAt: AT, picks: [shotPick('kids', S1, '코스 만들기 화면', '하나'), shotPick('kids', S2, '조건 고르는 화면', '둘'), shotPick('default', S3, '처음 화면', '셋')] }],
      3,
    )
    const b1 = readMap().b1?.photos ?? []
    ok('글 하나에 같은 화면 · 변형은 한 번(다른 변형은 들어간다)', twoSlots.saved === 2 && twoSlots.skipped === 1 && b1.map((p) => p.variantId).join(',') === 'kids,default')

    writeDrafts({
      c1: draft('c1', { photoCleared: [{ slot: '코스 만들기 화면', nth: 1, heading: '코스', removed: ['screen:course:kids'] }] }),
    })
    const refill = await saveAutoPhotoPicks(T, [{ actionId: 'c1', generatedAt: AT, picks: [shotPick('kids', S2)] }], 3, () => undefined, { refillCleared: true })
    const refill2 = await saveAutoPhotoPicks(T, [{ actionId: 'c1', generatedAt: AT, picks: [shotPick('parents', S3)] }], 3, () => undefined, { refillCleared: true })
    ok('사람이 뺀 화면은 다른 날 찍은 파일로도 다시 넣지 않는다(다른 변형은 넣는다)', refill.saved === 0 && refill2.saved === 1)
  }

  // ── 9) HTTP — 라우트 · 사진 PUT · 사진 받기 ──────────────────────────────
  const PORT = 4108
  const BASE = `http://127.0.0.1:${PORT}`
  const TENANT = 'vscreen'
  const AT = '2026-11-04T00:00:00.000Z'
  const portFree = () =>
    new Promise<boolean>((resolve) => {
      const srv = net.createServer()
      srv.once('error', () => resolve(false))
      srv.listen(PORT, '127.0.0.1', () => srv.close(() => resolve(true)))
    })
  const tenantBase = { engines: ['gemini'], questionBankSize: 4, questionBankVersion: 'v1', repeatsPerQuestion: 1, factGraph: [], competitors: [], industry: '관광안내', region: '가상시' }
  writeFileSync(
    path.join(httpDir, 'tenants.overlay.json'),
    JSON.stringify([
      { tenantId: TENANT, brandName: '가상 군산여행', aliases: ['가상 군산여행'], ownedDomains: ['gunsan.webforai.kr'], ...tenantBase },
      { tenantId: 'vplain', brandName: '가상 평범', aliases: ['가상 평범'], ownedDomains: ['plain.example'], ...tenantBase },
    ]),
  )
  const tDir = path.join(httpDir, 'data', TENANT)
  const sDir = path.join(tDir, 'screens')
  mkdirSync(sDir, { recursive: true })
  const pngK = fakePng(11)
  const pngM = fakePng(12)
  const shaK = sha16(pngK)
  const shaM = sha16(pngM)
  const today = new Date().toISOString()
  writeFileSync(path.join(sDir, `${shaK}.png`), pngK)
  writeFileSync(path.join(sDir, `${shaM}.png`), pngM)
  writeFileSync(path.join(sDir, 'bbbbbbbbbbbbbbbb.png'), pngK)
  writeFileSync(
    path.join(sDir, 'screens.json'),
    JSON.stringify({
      shots: [
        { sha16: shaK, screenId: 'course', variantId: 'kids', url: 'https://gunsan.webforai.kr/plan/?with=kids&kids=7', capturedAt: today, width: 1280, height: 800, bytes: pngK.length },
        { sha16: shaM, screenId: 'map', variantId: 'default', url: 'https://gunsan.webforai.kr/map/', capturedAt: AT, width: 1280, height: 800, bytes: pngM.length },
      ],
    }),
  )
  const mapPlanted = {
    slot: '지도 화면', nth: 1, same: 1, heading: '지도', src: `/api/screens/${TENANT}/${shaM}.png`, alt: '지도', pageUrl: 'https://gunsan.webforai.kr/map/', confirmedAt: AT,
    origin: 'screen', screenId: 'map', variantId: 'default', capturedAt: AT,
  }
  const emptyDraft = (id: string, extra: Record<string, unknown> = {}) => ({ actionId: id, generatedAt: AT, draft: { format: 'article', title: '가상 글', sections: [], gapCount: 0, usedFacts: [] }, ...extra })
  writeFileSync(
    path.join(tDir, 'drafts.json'),
    JSON.stringify({
      'content:a': emptyDraft('content:a'),
      'content:b': emptyDraft('content:b'),
      'content:c': emptyDraft('content:c'),
      'content:d': emptyDraft('content:d', { photos: [mapPlanted] }),
      'content:e': emptyDraft('content:e'),
    }),
  )
  writeFileSync(path.join(tDir, 'publish-settings.json'), JSON.stringify({ photoRights: { confirmedAt: AT } }))

  const env = {
    ...process.env,
    APP_DATA_DIR: httpDir,
    PORT: String(PORT),
    USE_MOCK_ENGINES: 'true',
    DOTENV_CONFIG_PATH: path.join(httpDir, 'no-such.env'),
    BLOB_READ_WRITE_TOKEN: '',
    BLOB_STORE_ID: '',
    PIPELINE_CRON: '',
    GH_MEASURE_TOKEN: '',
  }
  delete env.AEO_SERVER_HOST
  if (!(await portFree())) throw new Error(`포트 ${PORT}을 다른 프로그램이 쓰고 있어 확인하지 못했습니다.`)
  server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: process.cwd(), env, stdio: 'ignore' })
  let up = false
  for (let i = 0; i < 80 && !up; i += 1) {
    up = await fetch(`${BASE}/health`).then((r) => r.ok, () => false)
    if (!up) await new Promise((r) => setTimeout(r, 500))
  }
  ok('임시 서버가 뜬다', up)

  const json = async (res: Response) => (await res.json().catch(() => ({}))) as Record<string, unknown>
  const post = async (url: string, body: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, body: await json(res) }
  }
  const put = async (url: string, body: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, body: await json(res) }
  }
  const getRaw = (url: string) => fetch(`${BASE}${url}`)
  const stored = () => JSON.parse(readFileSync(path.join(tDir, 'drafts.json'), 'utf-8')) as Record<string, { photos?: Record<string, unknown>[]; photoCleared?: { removed?: string[] }[] }>

  const health = await json(await getRaw('/api/health'))
  ok('/api/health — 자식 프로세스 서버는 screens false', health.screens === false)

  const filesBefore = readdirSync(sDir).sort().join(',')
  const unavailable = await post('/api/screens/capture', { tenantId: TENANT, screenId: 'course', variantId: 'parents' })
  ok('찍을 수 없는 서버의 찍기는 503 unavailable · 파일을 더하지 않는다', unavailable.status === 503 && unavailable.body.code === 'unavailable' && readdirSync(sDir).sort().join(',') === filesBefore)
  const reused = await post('/api/screens/capture', { tenantId: TENANT, screenId: 'course', variantId: 'kids' })
  const reusedShot = reused.body.shot as Record<string, unknown> | undefined
  ok(
    '오늘 찍어 둔 화면이면 찍지 않고 그것을 준다(reused)',
    reused.status === 200 && reused.body.reused === true && reusedShot?.id === shaK && reusedShot.src === `/api/screens/${TENANT}/${shaK}.png` && reused.body.saveAllowed === true,
  )
  ok(
    '찍기 — 브랜드 · 프로필 · 화면 · 변형이 맞지 않으면 400 · 404',
    (await post('/api/screens/capture', { screenId: 'course', variantId: 'kids' })).status === 400 &&
      (await post('/api/screens/capture', { tenantId: 'nope', screenId: 'course', variantId: 'kids' })).status === 404 &&
      (await post('/api/screens/capture', { tenantId: 'vplain', screenId: 'course', variantId: 'kids' })).status === 404 &&
      (await post('/api/screens/capture', { tenantId: TENANT, screenId: 'course', variantId: 'nope' })).status === 400 &&
      (await post('/api/screens/capture', { tenantId: TENANT, screenId: 'course', variantId: 'kids', url: 'https://evil.example/' })).body.shot !== undefined,
  )

  const listRes = await getRaw(`/api/screens/${TENANT}`)
  const list = await json(listRes)
  const listScreens = (list.screens ?? []) as { id: string; saveAllowed: boolean; variants: { url: string }[] }[]
  const listShots = (list.shots ?? []) as { id: string; src: string; screenId: string }[]
  // 예전 기대값은 화면 2개(코스 · 지도)였다 — 4단계에서 장소 안내 · 가이드를 더해 4개다.
  ok(
    '목록 — 화면(코스는 넣기 가능 · 지도는 미리보기만)과 찍어 둔 화면(늦게 찍은 것부터 · 앱 주소)',
    listRes.status === 200 && list.available === false && list.host === 'gunsan.webforai.kr' && listScreens.length === 4 &&
      listScreens.find((s) => s.id === 'course')?.saveAllowed === true && listScreens.find((s) => s.id === 'map')?.saveAllowed === false &&
      listScreens.find((s) => s.id === 'map')?.variants.length === 6 && listShots.length === 2 && listShots[0]?.id === shaK && listShots[1]?.src === `/api/screens/${TENANT}/${shaM}.png`,
  )
  const listPlace = listScreens.find((s) => s.id === 'place-info') as ({ saveAllowed: boolean; placePages?: boolean; variants: unknown[] } | undefined)
  const listGuide = listScreens.find((s) => s.id === 'kids-guide')
  ok(
    '목록 — 장소 안내는 넣기 가능 · 변형은 사이트 장소마다(비어 있음 · placePages), 가이드는 넣기 가능 · 변형 하나',
    listPlace?.saveAllowed === true && listPlace.placePages === true && listPlace.variants.length === 0 && listGuide?.saveAllowed === true && listGuide.variants.length === 1,
  )
  const plain = await json(await getRaw('/api/screens/vplain'))
  ok('프로필 없는 브랜드의 목록은 화면이 없다', Array.isArray(plain.screens) && (plain.screens as unknown[]).length === 0 && plain.host === null)
  ok('모르는 브랜드의 목록은 404', (await getRaw('/api/screens/nope')).status === 404)

  const fileRes = await getRaw(`/api/screens/${TENANT}/${shaK}.png`)
  const fileBytes = Buffer.from(await fileRes.arrayBuffer())
  ok(
    '화면 파일 — image/png · 같은 바이트 · nosniff',
    fileRes.status === 200 && fileRes.headers.get('content-type') === 'image/png' && fileBytes.equals(pngK) && fileRes.headers.get('x-content-type-options') === 'nosniff',
  )
  const notServed = await Promise.all(
    [
      `/api/screens/${TENANT}/bbbbbbbbbbbbbbbb.png`,
      `/api/screens/${TENANT}/${shaK.toUpperCase()}.png`,
      `/api/screens/${TENANT}/${shaK}.jpg`,
      `/api/screens/${TENANT}/${shaK}`,
      `/api/screens/${TENANT}/screens.json`,
      `/api/screens/${TENANT}/..%2F..%2Ftenants.overlay.json`,
      `/api/screens/${TENANT}/..%2Fdrafts.json`,
      `/api/screens/..%2F${TENANT}/${shaK}.png`,
      `/api/screens/%2E%2E/${shaK}.png`,
      `/api/screens/vplain/${shaK}.png`,
    ].map(async (u) => {
      const res = await getRaw(u)
      const text = await res.text()
      return res.status === 404 && !text.includes('가상 군산여행') && !text.includes('generatedAt') && !text.includes('PNG')
    }),
  )
  ok('화면 파일 — 목록에 없는 id · 다른 모양 · 경로 글자 · 다른 브랜드는 404(다른 파일이 새지 않는다)', notServed.every(Boolean))

  const placeBad = await Promise.all(['../x', '가상 박물관', '%2F', ''].map((variantId) => post('/api/screens/capture', { tenantId: TENANT, screenId: 'place-info', variantId })))
  const placeUnavailable = await post('/api/screens/capture', { tenantId: TENANT, screenId: 'place-info', variantId: '가상박물관' })
  ok(
    '장소 안내 찍기 — 장소 이름 모양이 아니면 400, 모양이 맞으면(찍을 수 없는 서버) 503 — 사이트 목록은 찍을 수 있을 때만 받는다',
    placeBad.every((r) => r.status === 400) && placeUnavailable.status === 503 && placeUnavailable.body.code === 'unavailable',
  )
  // 장소 안내 화면 한 장을 목록에 더한다(목록 검사 뒤 — 찍어 둔 화면 수 기대값은 그대로).
  const pngP = fakePng(13, 425, 677)
  const shaP = sha16(pngP)
  const PLACE_URL_V = `https://gunsan.webforai.kr/places/${encodeURIComponent('가상박물관')}/`
  writeFileSync(path.join(sDir, `${shaP}.png`), pngP)
  const listed0 = JSON.parse(readFileSync(path.join(sDir, 'screens.json'), 'utf-8')) as { shots: unknown[] }
  writeFileSync(
    path.join(sDir, 'screens.json'),
    JSON.stringify({
      shots: [
        ...listed0.shots,
        { sha16: shaP, screenId: 'place-info', variantId: '가상박물관', url: PLACE_URL_V, capturedAt: AT, width: 425, height: 677, bytes: pngP.length, text: '가상박물관\n09:00–18:00' },
      ],
    }),
  )

  // 사진 넣기(op pick) — 화면이 보낸 src · pageUrl · alt는 쓰지 않는다
  const place = (slot: string, heading: string) => ({ slot, nth: 1, same: 1, heading })
  const screenBody = (over: Record<string, unknown>, actionId = 'content:a') => ({
    actionId, generatedAt: AT, op: 'pick',
    pick: { ...place('코스 만들기 화면', '코스'), origin: 'screen', screenId: 'course', variantId: 'kids', shotId: shaK, src: 'https://evil.example/x.png', pageUrl: 'https://evil.example/', alt: '가짜 설명 100%', ...over },
  })
  const pickRes = await put(`/api/content-draft/${TENANT}/photos`, screenBody({}))
  const saved = stored()['content:a']?.photos?.[0]
  ok(
    '화면 넣기 — 서버가 목록에서 앱 주소 · 찍은 주소 · 찍은 때 · 화면 이름 대체 텍스트를 단다',
    pickRes.status === 200 && saved?.src === `/api/screens/${TENANT}/${shaK}.png` && saved.pageUrl === 'https://gunsan.webforai.kr/plan/?with=kids&kids=7' &&
      saved.alt === "가상 군산여행 웹사이트 'AI 코스 만들기' 화면" && saved.origin === 'screen' && saved.screenId === 'course' && saved.variantId === 'kids' &&
      saved.capturedAt === today && typeof saved.confirmedAt === 'string' && saved.auto === undefined,
  )
  const mapPick = await put(`/api/content-draft/${TENANT}/photos`, screenBody({ slot: '지도 화면', heading: '지도', screenId: 'map', variantId: 'default', shotId: shaM }, 'content:b'))
  ok('지도 화면은 넣지 않는다(400 · 저장 없음)', mapPick.status === 400 && String(mapPick.body.error).includes('지도') && !stored()['content:b']?.photos)
  const badShot = await put(`/api/content-draft/${TENANT}/photos`, screenBody({ shotId: 'ffffffffffffffff' }, 'content:b'))
  const wrongVariant = await put(`/api/content-draft/${TENANT}/photos`, screenBody({ variantId: 'parents' }, 'content:b'))
  const noShot = await put(`/api/content-draft/${TENANT}/photos`, screenBody({ shotId: undefined }, 'content:b'))
  ok('목록에 없는 화면 · 변형이 다른 화면 · 찍은 화면 id 없음은 400', badShot.status === 400 && wrongVariant.status === 400 && noShot.status === 400 && !stored()['content:b']?.photos)

  const placePick = await put(`/api/content-draft/${TENANT}/photos`, screenBody({ slot: '가상박물관 안내 화면', heading: '안내', screenId: 'place-info', variantId: '가상박물관', shotId: shaP }, 'content:e'))
  const savedPlace = stored()['content:e']?.photos?.[0]
  ok(
    '장소 안내 넣기 — 서버가 목록에서 앱 주소 · 장소 주소 · 장소 이름을 넣은 대체 텍스트를 단다',
    placePick.status === 200 && savedPlace?.src === `/api/screens/${TENANT}/${shaP}.png` && savedPlace.pageUrl === PLACE_URL_V &&
      savedPlace.alt === "가상 군산여행 웹사이트 '가상박물관 장소 안내' 화면" && savedPlace.screenId === 'place-info' && savedPlace.variantId === '가상박물관',
  )
  const placeOther = await put(`/api/content-draft/${TENANT}/photos`, screenBody({ slot: '가상박물관 안내 화면', heading: '안내', screenId: 'place-info', variantId: '다른박물관', shotId: shaP }, 'content:e'))
  ok('장소 안내 넣기 — 찍은 화면과 장소가 다르면 400', placePick.status === 200 && placeOther.status === 400)
  const photoFile = async (actionId: string, slot: string, heading: string) => {
    const q = new URLSearchParams({ actionId, generatedAt: AT, slot, nth: '1', heading })
    return getRaw(`/api/content-draft/${TENANT}/photo-file?${q.toString()}`)
  }
  const pf = await photoFile('content:a', '코스 만들기 화면', '코스')
  ok('사진 받기 — 화면은 이 PC의 파일을 png로', pf.status === 200 && pf.headers.get('content-type') === 'image/png' && Buffer.from(await pf.arrayBuffer()).equals(pngK))
  ok('사진 받기 — 글에 남아 있는 지도 화면은 409', (await photoFile('content:d', '지도 화면', '지도')).status === 409)
  const pfPlace = await photoFile('content:e', '가상박물관 안내 화면', '안내')
  ok('사진 받기 — 장소 안내 화면도 이 PC의 파일을 png로', pfPlace.status === 200 && Buffer.from(await pfPlace.arrayBuffer()).equals(pngP))

  // 자동 채우기(op auto) — 지도는 빼고, 글 하나에 같은 화면 · 변형 한 번
  const autoPick = (slot: string, heading: string, over: Record<string, unknown> = {}) => ({
    ...place(slot, heading), origin: 'screen', screenId: 'course', variantId: 'kids', shotId: shaK, auto: true, src: 'https://evil.example/y.png', ...over,
  })
  const auto = await put(`/api/content-draft/${TENANT}/photos`, {
    op: 'auto',
    articles: [
      { actionId: 'content:b', generatedAt: AT, picks: [autoPick('조건 고르는 화면', '조건'), autoPick('지도 화면', '지도', { screenId: 'map', variantId: 'default', shotId: shaM })] },
      { actionId: 'content:c', generatedAt: AT, picks: [autoPick('코스 화면 하나', '하나'), autoPick('코스 화면 둘', '둘')] },
    ],
  })
  const bPhotos = stored()['content:b']?.photos ?? []
  const cPhotos = stored()['content:c']?.photos ?? []
  ok(
    '자동 채우기 — 지도는 빼고 · 글 하나에 같은 화면 · 변형 한 번(브랜드 상한은 받지 않는다)',
    auto.status === 200 && auto.body.saved === 2 && auto.body.skipped === 2 && bPhotos.length === 1 && bPhotos[0]?.screenId === 'course' && bPhotos[0]?.auto === true &&
      bPhotos[0]?.src === `/api/screens/${TENANT}/${shaK}.png` && cPhotos.length === 1,
  )

  const removed = await put(`/api/content-draft/${TENANT}/photos`, { actionId: 'content:a', generatedAt: AT, op: 'remove', place: { slot: '코스 만들기 화면', nth: 1, heading: '코스' } })
  ok('화면을 빼면 뺀 기록에 「화면 + 변형」 열쇠를 적는다', removed.status === 200 && JSON.stringify(stored()['content:a']?.photoCleared?.[0]?.removed) === '["screen:course:kids"]')
} finally {
  if (server) {
    server.kill()
    await new Promise((r) => setTimeout(r, 800))
  }
  rmSync(root, { recursive: true, force: true })
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
