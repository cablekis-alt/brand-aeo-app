// 자사 화면 캡처 — Electron 메인 프로세스 전용 모듈.
//
// 서버(utilityProcess)는 창을 띄울 수 없으므로, 메인이 숨긴 BrowserWindow(show:false + 오프스크린 렌더링)로
// 자사 사이트의 첫 화면(뷰포트)만 찍어 PNG 바이트를 돌려준다. 파일 저장은 서버가 한다(PIPELINE_DATA_DIR) —
// 이 모듈은 디스크에 아무것도 쓰지 않는다. 세션도 메모리 전용 partition이다.
//
// 지키는 것
//   - 한 번에 한 장(줄 세우기 — 지도 그리기 mapRender.cjs도 같은 줄에 선다). 한 장마다 창을 새로 만들고 끝나면 destroy. 앱 종료 때 disposeCapture().
//   - 크기 1280×800 · 배율 1 고정(CDP Emulation) — Windows 125/150% 배율과 상관없이 같은 그림. 잘라 찍기만 1280×2100 · 배율 2(아래).
//   - capturePage()+toPNG()는 쓰지 않는다(메인에서 동기 인코딩 → 큰 그림이면 앱 창이 멈춘다). CDP
//     Page.captureScreenshot은 렌더러가 인코딩한다.
//   - 자사 호스트 밖으로 이동 · 새 창 · 권한 요청 · 내려받기를 거절한다.
//   - GTM · GA4 · track.js · Vercel Insights 요청을 막는다(캡처가 방문 통계에 잡히지 않게).
//   - 127/8 · ::1 · 사설 주소로 가는 요청을 막는다(인증 없는 로컬 API 보호). 이름은 DNS로 풀어 확인한다.
//   - 보이는 그림 가운데 자사 호스트가 아니거나 data-kogl이 붙은 것이 있으면 그 캡처는 버린다(<html> · <body> 배경과
//     웹 컴포넌트의 열린 shadow root 안까지 본다 — 안을 볼 수 없는 닫힌 shadow root가 있으면 버린다). 투명도 0인 그림도 센다
//     (드러내기 효과로 곧 나타난다). 찍기 전과 찍은 뒤 두 번 검사한다. 지도 상자 안의 카카오 타일만 예외다.
//   - 빈 그림(한 가지 색)이면 실패로 돌려준다.
//   - 동의 배너는 숨기기만 하고 절대 누르지 않는다.
//   - 잘라 찍기(clip): 선택자들의 요소를 합친 사각형(+ 여백)만 찍는다. 그림 검사도 그 사각형에 걸친 것만 본다(밖의 공공누리 사진은 괜찮다 —
//     닫힌 shadow root만은 자리와 상관없이 모두 센다). 사각형이 화면(위에 붙은 머리 아래)에 들어가게 스크롤하고(스크롤한 뒤 조용함을 다시
//     기다린다), 들어가지 않으면 찍지 않는다. 잘라 찍기 화면은 1280×2100 · 배율 2다(2026-11-05 결정 — 블로그에서 더 크게): 배율 2를
//     사이트를 열기 전에 정해 사이트가 고해상도 그림(srcset)을 고르고 글자도 2배로 그린다(clip.scale로 키우면 1배 그림을 늘린다). 화면이 길어
//     첫 화면(800)보다 긴 안내 카드(근대역사박물관 425×920)도 통째로 찍는다 — 세로 CLIP_MAX_HEIGHT까지. 사각형 · 그림 검사는 CSS px, 찍은
//     그림은 그 2배(장치 px)다. 위에 붙은 머리 · 자리를 어림할 수 없는 가상 요소를 볼 범위는 1배 첫 화면(VIEW_HEIGHT) 기준 그대로다.
//   - ownHostOnly: 자사 호스트 밖의 요청을 모두 막는다(관광공사 사진 · 지도 SDK · 동영상 썸네일 — 잘라 찍는 부분에 필요 없다).
'use strict'

const { app, BrowserWindow, nativeImage, session } = require('electron')
const dns = require('node:dns').promises
const net = require('node:net')

const VIEW_WIDTH = 1280
const VIEW_HEIGHT = 800
/**
 * 잘라 찍기의 화면 — 배율 2(src/lib/screenCapture.ts SCREEN_CLIP_SCALE과 같다) · 높이 2100. 실측(2026-11-05, 숨긴 창): 배율을 사이트를 열기
 * 전에 2로 두면 가이드 일러스트가 camp-kids-1280(2배 그림)으로 바뀌고 글자도 2배로 그린다(clip.scale 2는 camp-kids-800을 늘린다). 높이
 * 2100에서는 긴 카드(425×994까지 봤다)도 스크롤 없이 머리 아래에 들어오고, 그림은 800 화면 · 찍는 도중 화면 늘리기와 바이트까지 같았다
 * (captureBeyondViewport는 머리 그림자가 들어오고 회차마다 그림이 달랐다). 렌더러 메모리는 1배와 같은 230~240MB.
 */
const CLIP_VIEW_HEIGHT = 2100
const CLIP_SCALE = 2
const DEFAULT_TIMEOUT_MS = 25000
const MAX_TIMEOUT_MS = 45000
/** 기다리는 한도가 끝난 뒤 찍기 · 검사에 더 주는 시간. 이것까지 넘으면 창을 부수고 실패한다. */
const HARD_GRACE_MS = 12000
const QUIET_MS = 800
/** 이보다 오래 걸린 요청은 '조용함' 판단에서 뺀다(오래 붙는 요청 하나 때문에 한도까지 기다리지 않게). */
const STALLED_REQUEST_MS = 8000
const POLL_MS = 150
const EVAL_TIMEOUT_MS = 5000
const SHOT_TIMEOUT_MS = 15000
const MAX_QUEUE = 20
/** 오프스크린 창의 프레임 수. 찍기에는 이것으로 충분하고, 기본 60보다 CPU를 덜 쓴다. */
const OFFSCREEN_FPS = 30
/** 'persist:'가 없는 이름 = 디스크에 남지 않는 메모리 전용 세션. */
const PARTITION = 'screen-capture'

/** 방문 통계 · 광고 추적 — 캡처가 사이트 통계에 잡히지 않게 막는다. */
const ANALYTICS_HOST_SUFFIXES = [
  'googletagmanager.com',
  'google-analytics.com',
  'analytics.google.com',
  'doubleclick.net',
  'vercel-insights.com',
  'vercel-analytics.com',
]
const ANALYTICS_PATHS = [/^\/_vercel\/(insights|speed-insights)\//, /\/track\.js$/]
/** 지도 상자 안에서만 허용하는 바깥 그림(카카오 지도 타일 · 로고). */
const MAP_IMAGE_HOST_SUFFIXES = ['daumcdn.net', 'kakao.com', 'kakaocdn.net']
/** 늘 숨기는 것: 챗봇 단추, 캐러셀, 미리 채움 안내 줄, 동의 배너. */
const DEFAULT_HIDE = [
  '[data-chat-open]',
  '.chat-fab',
  '[data-hcar]',
  '[data-gallery]',
  '[data-marquee]',
  '[data-plan-handed]',
  '#onetrust-consent-sdk',
  '#onetrust-banner-sdk',
  '.cc-window',
  '[id*="cookie" i][class*="banner" i]',
  '[class*="cookie-banner" i]',
  '[class*="consent-banner" i]',
  '[id*="consent-banner" i]',
  '[aria-label*="cookie" i]',
]
/** 밤 테마를 막는다: <html>에 이 속성이 있으면 낮 값으로 고정한다. */
const DAY_THEME_ATTRS = [['data-wxt', 'day']]
const DEFAULT_MAP_SELECTOR = '.map'
const DEFAULT_MAP_READY_EVENT = 'gs:mapready'
/**
 * 잘라 찍기 — 여백 기본 · 최대, 블로그 그림으로 쓸 수 있는 가장 작은 크기 · 가장 큰 세로(모두 CSS px — 찍은 그림은 그 CLIP_SCALE배), 함께
 * 돌려주는 글자의 최대 길이.
 */
const CLIP_DEFAULT_PADDING = 16
const CLIP_MAX_PADDING = 48
const CLIP_MIN_WIDTH = 200
const CLIP_MIN_HEIGHT = 120
const CLIP_MAX_HEIGHT = 2000
const CLIP_MAX_SELECTORS = 8
const CLIP_TEXT_MAX = 2000

function captureError(code, message, extra) {
  const err = new Error(message)
  err.code = code
  if (extra) Object.assign(err, extra)
  return err
}

// ── 주소 검사 ─────────────────────────────────────────────────────────────

function expandIpv6(ip) {
  let text = ip
  let tail = []
  const lastColon = text.lastIndexOf(':')
  const maybeV4 = text.slice(lastColon + 1)
  if (net.isIPv4(maybeV4)) {
    const p = maybeV4.split('.').map(Number)
    tail = [(p[0] << 8) | p[1], (p[2] << 8) | p[3]]
    text = text.slice(0, lastColon + 1) + '0'
  }
  const halves = text.split('::')
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length > 1 && halves[1] ? halves[1].split(':') : []
  const want = 8 - (tail.length ? 1 : 0)
  const fill = halves.length > 1 ? Array(want - head.length - rest.length).fill('0') : []
  const words = [...head, ...fill, ...rest].map((w) => parseInt(w, 16))
  if (tail.length) words.splice(words.length - 1, 1, ...tail)
  return words
}

function isPrivateV4(ip) {
  const [a, b, c] = ip.split('.').map(Number)
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19))
  )
}

function v4FromWords(hi, lo) {
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.')
}

function isPrivateV6(ip) {
  const w = expandIpv6(ip)
  if (w.length !== 8 || w.some((x) => !Number.isInteger(x) || x < 0 || x > 0xffff)) return true
  const zeros = (from, to) => w.slice(from, to).every((x) => x === 0)
  if (zeros(0, 8)) return true // ::
  if (zeros(0, 7) && w[7] === 1) return true // ::1
  if (zeros(0, 5) && w[5] === 0xffff) return isPrivateV4(v4FromWords(w[6], w[7])) // ::ffff:a.b.c.d
  if (zeros(0, 6)) return isPrivateV4(v4FromWords(w[6], w[7])) // ::a.b.c.d(옛 표기)
  if (w[0] === 0x64 && w[1] === 0xff9b && zeros(2, 6)) return isPrivateV4(v4FromWords(w[6], w[7])) // NAT64
  if (w[0] === 0x2002) return isPrivateV4(v4FromWords(w[1], w[2])) // 6to4
  if ((w[0] & 0xfe00) === 0xfc00) return true // fc00::/7
  if ((w[0] & 0xffc0) === 0xfe80) return true // fe80::/10
  if ((w[0] & 0xffc0) === 0xfec0) return true // fec0::/10(옛 사이트 로컬)
  if ((w[0] & 0xff00) === 0xff00) return true // 멀티캐스트
  return false
}

/** 루프백 · 사설 · 링크 로컬 · 예약 주소면 true. IP 주소가 아니면 막는 쪽(true)으로 본다. */
function isPrivateAddress(address) {
  let ip = String(address || '').trim().toLowerCase()
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1)
  const zone = ip.indexOf('%')
  if (zone >= 0) ip = ip.slice(0, zone)
  const kind = net.isIP(ip)
  if (kind === 4) return isPrivateV4(ip)
  if (kind === 6) return isPrivateV6(ip)
  return true
}

function bareHost(hostname) {
  const h = String(hostname || '').toLowerCase()
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h
}

function hostMatches(host, suffixes) {
  return suffixes.some((s) => host === s || host.endsWith(`.${s}`))
}

/** 호스트 이름이 사설 주소로 풀리면 true. 풀 수 없으면 막는 쪽(true)으로 본다. */
async function resolvesPrivate(host) {
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (net.isIP(host)) return isPrivateAddress(host)
  try {
    const list = await dns.lookup(host, { all: true, verbatim: true })
    return list.length === 0 || list.some((x) => isPrivateAddress(x.address))
  } catch (err) {
    console.warn(`[capture] DNS 확인 실패(${host}): ${err && err.code ? err.code : err}`)
    return true
  }
}

/**
 * 캡처할 주소를 검사한다: https · 기본 포트 · 계정 정보 없음 · 호스트 = 허용 호스트 · 사설 주소로 풀리지 않음.
 * 통과하면 정규화한 주소를 돌려주고, 아니면 code가 붙은 Error를 던진다.
 */
async function assertCaptureUrl(rawUrl, allowedHost) {
  let u
  try {
    u = new URL(String(rawUrl))
  } catch {
    throw captureError('invalid-url', '주소를 읽을 수 없습니다.')
  }
  const host = bareHost(u.hostname)
  const want = bareHost(allowedHost)
  if (u.protocol !== 'https:') throw captureError('invalid-url', 'https 주소만 찍습니다.')
  if (u.username || u.password) throw captureError('invalid-url', '계정 정보가 든 주소는 찍지 않습니다.')
  if (u.port && u.port !== '443') throw captureError('invalid-url', '기본 포트가 아닌 주소는 찍지 않습니다.')
  if (!want || host !== want) throw captureError('off-host', '허용한 호스트의 주소가 아닙니다.')
  if (await resolvesPrivate(host)) throw captureError('private-address', '사설 · 루프백 주소로 풀리는 호스트는 찍지 않습니다.')
  return u.href
}

// ── 옵션 ────────────────────────────────────────────────────────────────

function safeSelector(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 200 && !/[{};<>\\]/.test(s)
}

function normalizeOptions(options) {
  const o = options || {}
  const host = bareHost(o.host)
  if (!host) throw captureError('invalid-options', '허용 호스트(host)가 없습니다.')
  const hide = Array.isArray(o.hide) ? o.hide : []
  if (hide.length > 20 || !hide.every(safeSelector)) throw captureError('invalid-options', '숨길 선택자가 올바르지 않습니다.')
  if (o.scrollTo !== undefined && !safeSelector(o.scrollTo)) throw captureError('invalid-options', '스크롤 선택자가 올바르지 않습니다.')
  let map = null
  if (o.map) {
    const m = typeof o.map === 'object' ? o.map : {}
    const selector = m.selector === undefined ? DEFAULT_MAP_SELECTOR : m.selector
    const readyEvent = m.readyEvent === undefined ? DEFAULT_MAP_READY_EVENT : m.readyEvent
    if (!safeSelector(selector)) throw captureError('invalid-options', '지도 선택자가 올바르지 않습니다.')
    if (typeof readyEvent !== 'string' || !/^[\w:.-]{1,60}$/.test(readyEvent)) {
      throw captureError('invalid-options', '지도 준비 이벤트 이름이 올바르지 않습니다.')
    }
    map = { selector, readyEvent }
  }
  let clip = null
  if (o.clip !== undefined) {
    const c = o.clip && typeof o.clip === 'object' && !Array.isArray(o.clip) ? o.clip : null
    const selectors = c && Array.isArray(c.selectors) ? c.selectors : null
    const optional = c && c.optional !== undefined ? c.optional : []
    const padding = c && c.padding !== undefined ? c.padding : CLIP_DEFAULT_PADDING
    if (!selectors || selectors.length === 0 || selectors.length > CLIP_MAX_SELECTORS || !selectors.every(safeSelector)) {
      throw captureError('invalid-options', '잘라 찍을 선택자가 올바르지 않습니다.')
    }
    if (!Array.isArray(optional) || optional.length > CLIP_MAX_SELECTORS || !optional.every(safeSelector)) {
      throw captureError('invalid-options', '함께 넣을 선택자가 올바르지 않습니다.')
    }
    if (!Number.isInteger(padding) || padding < 0 || padding > CLIP_MAX_PADDING) throw captureError('invalid-options', '잘라 찍기 여백이 올바르지 않습니다.')
    if (map || o.scrollTo !== undefined) throw captureError('invalid-options', '잘라 찍기는 지도 · 스크롤 선택자와 함께 쓰지 않습니다.')
    clip = { selectors: [...selectors], optional: [...optional], padding }
  }
  if (o.ownHostOnly !== undefined && typeof o.ownHostOnly !== 'boolean') throw captureError('invalid-options', 'ownHostOnly가 올바르지 않습니다.')
  const asked = Number(o.timeoutMs)
  const timeoutMs = Number.isFinite(asked) && asked > 0 ? Math.min(Math.max(asked, 5000), MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS
  return {
    host,
    hide: [...DEFAULT_HIDE, ...hide],
    scrollTo: o.scrollTo || null,
    map,
    clip,
    ownHostOnly: o.ownHostOnly === true,
    activateFragmentLink: o.activateFragmentLink === true,
    timeoutMs,
  }
}

function captureCss(hide) {
  return [
    // 애니메이션은 끝 상태로 바로 건너뛴다(none으로 지우면 opacity 0에서 시작하는 요소가 안 보인 채 남는다).
    '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;' +
      'animation-iteration-count:1!important;transition-duration:0s!important;transition-delay:0s!important;' +
      'caret-color:transparent!important}',
    'html{scroll-behavior:auto!important;scrollbar-width:none!important}',
    `${hide.join(',')}{display:none!important}`,
  ].join('\n')
}

// ── 페이지 안에서 도는 스크립트(문자열로 넘긴다) ─────────────────────────────

function pageCall(fn, ...args) {
  return `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})`
}

// 아래 page* 함수들은 문자열로 바뀌어 캡처 창의 페이지 안에서 돈다(Node 쪽 변수를 쓰지 않는다).
function pageSetup(attrs, readyEvent) {
  const root = document.documentElement
  for (const [name, value] of attrs) if (root.hasAttribute(name)) root.setAttribute(name, value)
  if (readyEvent && !window.__screenCaptureHooked) {
    window.__screenCaptureHooked = true
    document.addEventListener(readyEvent, () => {
      if (!window.__screenCaptureMapReadyAt) window.__screenCaptureMapReadyAt = performance.now()
    })
  }
  return true
}

function pageScroll(selector) {
  let el = null
  if (selector) el = document.querySelector(selector)
  else if (location.hash.length > 1) {
    const raw = location.hash.slice(1)
    let id = raw
    try {
      id = decodeURIComponent(raw)
    } catch {
      id = raw // 잘못된 % 표기면 그대로 찾는다
    }
    el = document.getElementById(id)
  }
  if (!el) return { found: false, y: Math.round(scrollY) }
  el.scrollIntoView({ block: 'start', behavior: 'instant' })
  // 화면 맨 위에 붙은 머리(고정 · sticky)가 덮는 만큼 더 내린다.
  let cover = 0
  for (const x of [innerWidth * 0.25, innerWidth * 0.5, innerWidth * 0.75]) {
    for (let n = document.elementFromPoint(x, 2); n && n !== document.documentElement; n = n.parentElement) {
      const pos = getComputedStyle(n).position
      if (pos === 'fixed' || pos === 'sticky') {
        const r = n.getBoundingClientRect()
        if (r.top <= 2 && r.bottom < innerHeight / 2) cover = Math.max(cover, r.bottom)
      }
    }
  }
  const top = el.getBoundingClientRect().top
  if (top < cover + 12) scrollBy({ top: top - cover - 12, behavior: 'instant' })
  return { found: true, y: Math.round(scrollY), cover: Math.round(cover) }
}

/**
 * 주소의 #조각과 같은 곳을 가리키는 페이지 안 링크(a[href="#…"])를 한 번 누른다. 탭처럼 그 링크에 걸린
 * 페이지 스크립트를 깨우려는 것이다(군산각 /map/#r-권역: 바로 열면 목록만 걸러지고 지도는 전체로 남는다).
 * 폼 안의 링크는 누르지 않는다. 이동은 will-navigate에서, 요청은 GET 밖을 모두 막으므로 보내는 일이 없다.
 */
function pageActivateFragmentLink() {
  const norm = (h) => {
    try {
      return decodeURIComponent(h)
    } catch {
      return h // 잘못된 % 표기면 그대로 비교한다
    }
  }
  if (location.hash.length < 2) return { clicked: false, why: 'no-hash' }
  const want = norm(location.hash)
  const link = [...document.querySelectorAll('a[href^="#"]')].find((a) => norm(a.getAttribute('href')) === want)
  if (!link) return { clicked: false, why: 'no-link' }
  if (link.closest('form')) return { clicked: false, why: 'in-form' }
  link.click()
  return { clicked: true }
}

function pageMapState(selector, tileHosts) {
  const box = document.querySelector(selector)
  if (!box) return { box: false }
  const r = box.getBoundingClientRect()
  const ok = (h) => tileHosts.some((s) => h === s || h.endsWith(`.${s}`))
  let tiles = 0
  let pending = 0
  let broken = 0
  for (const img of box.querySelectorAll('img')) {
    let host = ''
    try {
      host = new URL(img.currentSrc || img.src, location.href).hostname
    } catch {
      host = '' // 읽을 수 없는 주소는 타일로 세지 않는다
    }
    if (!ok(host)) continue
    tiles += 1
    if (!img.complete) pending += 1
    else if (img.naturalWidth === 0) broken += 1
  }
  const ready = Boolean(window.__screenCaptureMapReadyAt) || Boolean(window.GSMaps && window.GSMaps.length)
  return {
    box: true,
    ready,
    readyAt: window.__screenCaptureMapReadyAt || null,
    inView: r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight,
    rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    tiles,
    pending,
    broken,
  }
}

async function pageDecode() {
  const vw = innerWidth
  const vh = innerHeight
  const imgs = [...document.images].filter((i) => {
    const r = i.getBoundingClientRect()
    return r.width > 1 && r.height > 1 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw
  })
  const failed = []
  await Promise.all(
    imgs.map((i) =>
      (i.complete
        ? Promise.resolve()
        : new Promise((res) => {
            i.addEventListener('load', res, { once: true })
            i.addEventListener('error', res, { once: true })
          })
      )
        .then(() => i.decode())
        .then(
          () => null,
          () => failed.push(i.currentSrc || i.src),
        ),
    ),
  )
  return { count: imgs.length, failed: failed.length }
}

/**
 * 잘라 찍을 요소들 — 선택자마다 보이는 요소(여럿이면 모두)의 자리(문서 좌표)와 글자(innerText, 문서 순서). 필수 선택자(selectors)에 보이는
 * 요소가 없으면 missing에 적는다(optional은 없어도 된다). 화면 맨 위에 붙은 고정 · sticky 머리의 높이(cover), 문서 · 화면 크기, 스크롤도 준다.
 * 머리는 1배 첫 화면 높이(firstHeight)의 절반 위에서 끝나는 것만이다 — 잘라 찍기 화면(2100)의 절반으로 보면 위에 붙은 긴 옆 칸(높이 600)까지
 * 머리로 쳐 1배에서 찍히던 페이지가 clip-covered가 된다.
 */
function pageClipState(selectors, optional, firstHeight) {
  const shown = (el) => {
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && (el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : true)
  }
  const els = []
  const missing = []
  for (const [list, required] of [
    [selectors, true],
    [optional, false],
  ]) {
    for (const s of list) {
      const found = [...document.querySelectorAll(s)].filter(shown)
      if (required && found.length === 0) missing.push(s)
      for (const el of found) if (!els.includes(el)) els.push(el)
    }
  }
  const rects = els.map((el) => {
    const r = el.getBoundingClientRect()
    return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }
  })
  // 글자는 화면에 보이는 차례(문서 순서)로, 다른 요소 안에 든 요소는 한 번만.
  const ordered = els
    .filter((el) => !els.some((o) => o !== el && o.contains(el)))
    .sort((p, q) => (p.compareDocumentPosition(q) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
  const text = ordered
    .map((el) => (typeof el.innerText === 'string' ? el.innerText : el.textContent || ''))
    .join('\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n[\n ]*/g, '\n')
    .trim()
  let cover = 0
  for (const el of document.querySelectorAll('body *')) {
    const pos = getComputedStyle(el).position
    if (pos !== 'fixed' && pos !== 'sticky') continue
    const r = el.getBoundingClientRect()
    if (r.top <= 2 && r.bottom > 0 && r.bottom < firstHeight / 2 && shown(el)) cover = Math.max(cover, r.bottom)
  }
  const root = document.documentElement
  const body = document.body
  return {
    missing,
    rects,
    text,
    docWidth: Math.max(root.scrollWidth, body ? body.scrollWidth : 0, innerWidth),
    docHeight: Math.max(root.scrollHeight, body ? body.scrollHeight : 0, innerHeight),
    viewWidth: innerWidth,
    viewHeight: innerHeight,
    scrollX: Math.round(scrollX),
    scrollY: Math.round(scrollY),
    cover: Math.ceil(cover),
  }
}

/**
 * 잘라 찍을 사각형(화면 좌표)을 가리는 고정 · sticky 요소 — 잘라 찍을 요소를 품거나 그 안에 든 것은 빼고. 있으면 그림을 가리므로 찍지 않는다.
 * 내용 뒤에 깔린 것(z-index 음수 — 전체 화면 고정 배경)은 가리지 않는다. 스스로 그리는 것이 없는 투명 틀(알림 · 대화창 뿌리 inset:0)은 그 안의
 * 보이는 요소가 사각형에 걸칠 때만 가린다.
 */
function pageClipCovers(selectors, optional, region) {
  const clipEls = [...selectors, ...optional].flatMap((s) => [...document.querySelectorAll(s)])
  const hits = (r) => r.width > 0 && r.height > 0 && r.right > region.x && r.bottom > region.y && r.left < region.x + region.width && r.top < region.y + region.height
  const visible = (el) => !el.checkVisibility || el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
  const clear = (v) => !v || v === 'transparent' || /^rgba\([^)]*,\s*0(?:\.0+)?\)$/.test(v)
  const none = (v) => !v || v === 'none'
  /** 스스로 무엇을 그리나 — 배경색 · 배경 그림 · 테두리 · 그림자 · 직접 든 글자, 또는 그림 · 입력 같은 바뀐 요소. */
  const paints = (el) => {
    const cs = getComputedStyle(el)
    const border = ['Top', 'Right', 'Bottom', 'Left'].some(
      (s) => parseFloat(cs[`border${s}Width`]) > 0 && cs[`border${s}Style`] !== 'none' && !clear(cs[`border${s}Color`]),
    )
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
    return (
      !clear(cs.backgroundColor) || !none(cs.backgroundImage) || border || !none(cs.boxShadow) || ownText ||
      /^(img|svg|video|canvas|iframe|embed|object|input|button|select|textarea|picture)$/i.test(el.tagName)
    )
  }
  const out = []
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el)
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue
    if (parseInt(cs.zIndex, 10) < 0 || !visible(el)) continue
    if (clipEls.some((c) => c === el || c.contains(el) || el.contains(c))) continue
    const covers =
      (hits(el.getBoundingClientRect()) && paints(el)) || [...el.querySelectorAll('*')].some((d) => hits(d.getBoundingClientRect()) && visible(d) && paints(d))
    if (!covers) continue
    const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).join('.')}` : ''
    out.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls}`.slice(0, 80))
  }
  return out
}

/**
 * 그림 검사 — 첫 화면(region이 없을 때) 또는 잘라 찍을 사각형(region, 화면 좌표)에 걸친 그림 · 배경 · 프레임을 본다. 사각형 밖에 있는
 * 공공누리 · 바깥 그림은 찍히지 않으므로 괜찮다. <html> · <body> 배경은 어디든 비치므로 늘 본다.
 * 투명도 0인 그림도 센다(드러내기 효과 — 검사 뒤 · 찍기 전에 나타날 수 있다). display · visibility로 숨긴 것만 뺀다. 그려지지 않는 SVG
 * 묶음(defs · pattern · symbol …) 안의 <image>는 다른 곳(fill:url(#…) · <use>)에서 그려지므로 자리와 상관없이 보고, 가상 요소(::before ·
 * ::after)의 그림은 host 상자가 아니라 가상 요소의 자리(어림)로 본다.
 * 가상 요소의 자리를 어림할 수 없으면 host가 near에 걸칠 때 센다 — 첫 화면, 잘라 찍기면 1배 첫 화면(위에서 firstHeight)과 사각형을 합친 범위.
 * 잘라 찍기 화면(2100) 전체로 보면 1배에서는 보지 않던 사각형 아래 먼 요소까지 센다.
 */
function pageInspect(ownHost, mapSelector, mapHosts, region, firstHeight) {
  const vw = innerWidth
  const vh = innerHeight
  const view = { x: 0, y: 0, width: vw, height: vh }
  const box = region || view
  const near = region ? { x: 0, y: 0, width: vw, height: Math.max(firstHeight, region.y + region.height) } : view
  const hits = (r, b) => r.width > 1 && r.height > 1 && r.bottom > b.y && r.right > b.x && r.top < b.y + b.height && r.left < b.x + b.width
  const inView = (r) => hits(r, box)
  const shown = (el) => (el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : true)
  const SVG_NS = 'http://www.w3.org/2000/svg'
  const SVG_UNPAINTED = 'defs, pattern, symbol, mask, marker, clipPath, filter'
  const px = (v) => (/^-?\d+(?:\.\d+)?px$/.test(String(v)) ? parseFloat(v) : null)
  /**
   * 가상 요소의 상자(화면 좌표) 어림 — 흐름 안(static)이면 host 상자, 절대 위치면 위치 지정 host의 padding 상자에서 left · top(또는 right ·
   * bottom)과 width · height로. 어림할 수 없으면(host가 위치 지정 요소가 아님 · fixed · relative · transform · px가 아닌 값) null.
   */
  const pseudoBox = (el, cs) => {
    const hr = el.getBoundingClientRect()
    if (cs.transform && cs.transform !== 'none') return null
    if (!cs.position || cs.position === 'static') return hr
    const hs = getComputedStyle(el)
    if (cs.position !== 'absolute' || hs.position === 'static') return null
    const w = px(cs.width)
    const h = px(cs.height)
    if (w === null || h === null) return null
    const x0 = hr.left + (px(hs.borderLeftWidth) || 0)
    const y0 = hr.top + (px(hs.borderTopWidth) || 0)
    const [left, top, right, bottom] = [px(cs.left), px(cs.top), px(cs.right), px(cs.bottom)]
    const x = left !== null ? x0 + left + (px(cs.marginLeft) || 0) : right !== null ? x0 + el.clientWidth - right - w : null
    const y = top !== null ? y0 + top + (px(cs.marginTop) || 0) : bottom !== null ? y0 + el.clientHeight - bottom - h : null
    if (x === null || y === null) return null
    return { left: x, top: y, right: x + w, bottom: y + h, width: w, height: h }
  }
  const parse = (u) => {
    try {
      const x = new URL(u, location.href)
      return { scheme: x.protocol, host: x.hostname }
    } catch (err) {
      return { scheme: 'bad:', host: String(err).slice(0, 40) }
    }
  }
  // 웹 컴포넌트(열린 shadow root) 안도 본다. 닫힌 root는 페이지 스크립트로 볼 수 없어 captureSteps가 CDP로 따로 센다(countClosedShadowRoots).
  const roots = [document]
  for (let i = 0; i < roots.length; i += 1) {
    for (const el of roots[i].querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot)
  }
  /** shadow root 경계를 넘어 위로 찾는 closest — 공공누리 표시 · 지도 상자 안의 웹 컴포넌트도 그 안으로 친다. */
  const closestAcross = (el, selector) => {
    for (let n = el; n; n = n.getRootNode().host) {
      const hit = n.closest(selector)
      if (hit) return hit
    }
    return null
  }
  const inKogl = (el) => Boolean(closestAcross(el, '[data-kogl]'))
  const mapOk = (el, host) =>
    Boolean(mapSelector) && Boolean(closestAcross(el, mapSelector)) && mapHosts.some((s) => host === s || host.endsWith(`.${s}`))
  const out = { images: 0, mapImages: 0, foreign: [], kogl: 0, frames: [] }
  const judge = (el, url) => {
    const { scheme, host } = parse(url)
    if (scheme === 'data:' || scheme === 'blob:') return
    if (host === ownHost) return
    if (mapOk(el, host)) {
      out.mapImages += 1
      return
    }
    if (!out.foreign.includes(host)) out.foreign.push(host || scheme)
  }
  for (const root of roots) {
    for (const img of root.querySelectorAll('img, input[type="image"]')) {
      if (!inView(img.getBoundingClientRect()) || !shown(img)) continue
      out.images += 1
      if (inKogl(img)) out.kogl += 1
      judge(img, img.currentSrc || img.src)
    }
    for (const el of root.querySelectorAll('image, feImage, video, iframe, embed, object')) {
      const svg = el.namespaceURI === SVG_NS
      const unpainted = svg && Boolean(el.closest(SVG_UNPAINTED))
      if (!unpainted) {
        // SVG <image>는 자기 상자가 비면(크기 0) 그 SVG의 상자로 본다.
        let r = el.getBoundingClientRect()
        const outer = svg && !(r.width > 1 && r.height > 1) ? el.closest('svg') : null
        if (outer) r = outer.getBoundingClientRect()
        if (!inView(r) || !shown(el)) continue
      }
      if (inKogl(el)) out.kogl += 1
      const url =
        el.getAttribute('href') || el.getAttribute('xlink:href') || el.getAttribute('src') || el.getAttribute('poster') || el.getAttribute('data') || ''
      if (el.tagName === 'IFRAME') out.frames.push(parse(url).host)
      if (url) judge(el, url)
    }
  }
  const urlsIn = (v) => [...String(v || '').matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)].map((m) => m[2])
  // CSS 그림(배경 · content · 마스크 · border-image · 목록 표시) — <html> · <body>는 첫 화면 전체를 덮으므로 자리와 상관없이 보고, 나머지는 첫
  // 화면(잘라 찍기면 그 사각형)에 걸친 요소만 본다. 가상 요소는 host가 밖이어도 그 자리(어림)가 걸치면 보고, 어림할 수 없으면 host가 near(첫
  // 화면 · 잘라 찍기면 1배 첫 화면과 사각형을 합친 범위)에 걸칠 때 본다.
  const page = [document.documentElement, document.body].filter(Boolean)
  const boxes = roots.flatMap((root) => [...root.querySelectorAll(root === document ? 'body *' : '*')])
  for (const el of [...page, ...boxes]) {
    const always = page.includes(el)
    const rect = always ? null : el.getBoundingClientRect()
    const hostIn = always || inView(rect)
    for (const pseudo of [null, '::before', '::after']) {
      if (!pseudo && !hostIn) continue
      const cs = getComputedStyle(el, pseudo)
      const urls = [
        ...urlsIn(cs.backgroundImage),
        ...urlsIn(cs.content),
        ...urlsIn(cs.maskImage),
        ...urlsIn(cs.borderImageSource),
        ...urlsIn(cs.listStyleImage),
        ...urlsIn(cs.getPropertyValue('-webkit-mask-box-image-source')),
      ]
      if (!urls.length || cs.visibility === 'hidden' || cs.display === 'none') continue
      if (pseudo && !hostIn) {
        const pb = pseudoBox(el, cs)
        if (pb ? !inView(pb) : !hits(rect, near)) continue
      }
      if (inKogl(el)) out.kogl += 1
      for (const u of urls) judge(el, u)
    }
  }
  return out
}

/**
 * CDP DOM.getDocument({ depth: -1, pierce: true })의 노드 트리에서 닫힌(closed) shadow root 수를 센다. 페이지 스크립트(pageInspect)는
 * 닫힌 root 안을 볼 수 없으므로 하나라도 있으면 그 캡처는 버린다 — 잘라 찍기도 자리와 상관없이 모두 센다(host 상자로 견주면 display:contents
 * host나 host 밖으로 넘친 내용을 놓친다). 브라우저 기본 root(video · input 등의 user-agent)는 세지 않는다.
 */
function countClosedShadowRoots(root) {
  let closed = 0
  const stack = root ? [root] : []
  while (stack.length) {
    const node = stack.pop()
    if (node.shadowRootType === 'closed') closed += 1
    for (const list of [node.children, node.shadowRoots, node.pseudoElements]) if (Array.isArray(list)) stack.push(...list)
    if (node.contentDocument) stack.push(node.contentDocument)
  }
  return closed
}

// ── 잘라 찍기 계획 ────────────────────────────────────────────────────────

/**
 * 잘라 찍을 사각형과 스크롤 — 요소 자리(문서 좌표 { x, y, w, h })를 합쳐 여백을 두르고 문서 안으로 자른 사각형(정수, 문서 좌표)과, 그
 * 사각형이 화면 안(위에 붙은 머리 cover 아래)에 들어오는 스크롤 가운데 지금 자리에서 가장 덜 움직이는 값. 가로로는 스크롤하지 않는다.
 * 모두 CSS px다(찍은 그림의 화소는 이것의 배율배).
 * problem: clip-missing 요소 없음 · clip-too-small 블로그 그림으로 너무 작음 · clip-too-large 화면(머리를 뺀 높이)보다 크거나 세로가
 * CLIP_MAX_HEIGHT를 넘음 · clip-covered 어떤 스크롤로도 머리 아래에 다 들어오지 않음(문서 맨 위가 머리에 가림). 문제가 없으면 null.
 */
function clipPlan(rects, padding, page) {
  if (!rects.length) return { rect: null, scrollY: page.scrollY, problem: 'clip-missing' }
  const x0 = Math.max(0, Math.floor(Math.min(...rects.map((r) => r.x)) - padding))
  const y0 = Math.max(0, Math.floor(Math.min(...rects.map((r) => r.y)) - padding))
  const x1 = Math.min(page.docWidth, Math.ceil(Math.max(...rects.map((r) => r.x + r.w)) + padding))
  const y1 = Math.min(page.docHeight, Math.ceil(Math.max(...rects.map((r) => r.y + r.h)) + padding))
  const rect = { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) }
  const keep = { rect, scrollY: page.scrollY }
  if (rect.width < CLIP_MIN_WIDTH || rect.height < CLIP_MIN_HEIGHT) return { ...keep, problem: 'clip-too-small' }
  if (x0 < page.scrollX || x1 > page.scrollX + page.viewWidth || rect.height > Math.min(CLIP_MAX_HEIGHT, page.viewHeight - page.cover)) {
    return { ...keep, problem: 'clip-too-large' }
  }
  const lo = Math.max(0, y1 - page.viewHeight)
  const hi = Math.min(Math.max(0, page.docHeight - page.viewHeight), y0 - page.cover)
  if (lo > hi) return { ...keep, problem: 'clip-covered' }
  return { rect, scrollY: Math.min(Math.max(page.scrollY, lo), hi), problem: null }
}

const CLIP_PROBLEM_TEXT = {
  'clip-missing': '잘라 찍을 요소가 페이지에 없습니다',
  'clip-too-small': `잘라 찍을 부분이 너무 작습니다(최소 ${CLIP_MIN_WIDTH}×${CLIP_MIN_HEIGHT})`,
  'clip-too-large': `잘라 찍을 부분이 너무 큽니다(가로는 화면 ${VIEW_WIDTH} 안, 세로는 위에 붙은 머리 아래 ${CLIP_MAX_HEIGHT}까지)`,
  'clip-covered': '잘라 찍을 부분이 위에 붙은 머리에 가립니다',
}

function clipError(plan) {
  const size = plan.rect ? ` — ${plan.rect.width}×${plan.rect.height}` : ''
  return captureError(plan.problem, `${CLIP_PROBLEM_TEXT[plan.problem]}${size}.`)
}

// ── 픽셀 검사 ────────────────────────────────────────────────────────────

/** BGRA 비트맵의 한 영역 통계: 밝기 표준편차, 가장 흔한 색의 비율, 서로 다른 색 수(4비트 양자화). */
function regionStats(bitmap, width, height, rect) {
  const x0 = Math.max(0, Math.floor(rect.x))
  const y0 = Math.max(0, Math.floor(rect.y))
  const x1 = Math.min(width, Math.floor(rect.x + rect.w))
  const y1 = Math.min(height, Math.floor(rect.y + rect.h))
  const counts = new Map()
  let n = 0
  let sum = 0
  let sumSq = 0
  for (let y = y0; y < y1; y += 3) {
    for (let x = x0; x < x1; x += 3) {
      const i = (y * width + x) * 4
      const b = bitmap[i]
      const g = bitmap[i + 1]
      const r = bitmap[i + 2]
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
      sum += lum
      sumSq += lum * lum
      n += 1
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
      counts.set(key, (counts.get(key) || 0) + 1)
    }
  }
  if (n === 0) return { samples: 0, stddev: 0, dominantShare: 1, colors: 0 }
  const mean = sum / n
  const stddev = Math.sqrt(Math.max(0, sumSq / n - mean * mean))
  const top = Math.max(...counts.values())
  return { samples: n, stddev: Math.round(stddev * 10) / 10, dominantShare: Math.round((top / n) * 1000) / 1000, colors: counts.size }
}

function isBlank(stats) {
  return stats.samples === 0 || stats.stddev < 4 || stats.dominantShare > 0.985 || stats.colors < 6
}

/** PNG 한 장이 빈 그림(거의 한 가지 색)인지 본다. 캡처 뒤 검사와 같은 기준이다. */
function blankCheck(png) {
  const image = nativeImage.createFromBuffer(png)
  const { width, height } = image.getSize()
  const stats = regionStats(image.toBitmap(), width, height, { x: 0, y: 0, w: width, h: height })
  return { blank: isBlank(stats), stats, width, height }
}

// ── 창 · 세션 ────────────────────────────────────────────────────────────

let captureSession = null
/** 지금 찍고 있는 작업. 세션의 요청 검사기는 이것만 본다(다른 웹콘텐츠의 요청은 모두 막는다). */
let activeCtx = null
let disposed = false
let queueTail = Promise.resolve()
let queued = 0

function noteBlocked(ctx, host, reason, type) {
  const key = `${reason}|${host}|${type}`
  ctx.blocked.set(key, (ctx.blocked.get(key) || 0) + 1)
}

async function requestBlockReason(details, ctx) {
  let u
  try {
    u = new URL(details.url)
  } catch {
    return 'bad-url'
  }
  if (u.protocol === 'data:' || u.protocol === 'blob:') return null
  // 캡처는 읽기만 한다 — GET · HEAD 밖의 요청(폼 제출 · fetch POST · 비콘)은 모두 막는다.
  if (details.method && details.method !== 'GET' && details.method !== 'HEAD') return 'method'
  if (u.protocol !== 'https:' && u.protocol !== 'wss:') return 'scheme'
  const host = bareHost(u.hostname)
  if (hostMatches(host, ANALYTICS_HOST_SUFFIXES) || ANALYTICS_PATHS.some((re) => re.test(u.pathname))) return 'analytics'
  if ((details.resourceType === 'mainFrame' || details.resourceType === 'subFrame') && host !== ctx.host) return 'off-host'
  if (ctx.ownHostOnly && host !== ctx.host) return 'off-host'
  if (!ctx.dnsCache.has(host)) ctx.dnsCache.set(host, resolvesPrivate(host))
  if (await ctx.dnsCache.get(host)) return 'private-address'
  return null
}

function ensureSession() {
  if (captureSession) return captureSession
  const ses = session.fromPartition(PARTITION, { cache: true })
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.setDevicePermissionHandler(() => false)
  ses.setSpellCheckerEnabled(false)
  ses.on('will-download', (event) => event.preventDefault())
  ses.webRequest.onBeforeRequest((details, callback) => {
    const ctx = activeCtx
    if (!ctx || ctx.aborted || (details.webContentsId !== undefined && details.webContentsId !== ctx.wcId)) {
      callback({ cancel: true })
      return
    }
    requestBlockReason(details, ctx).then(
      (reason) => {
        if (reason) {
          let host = ''
          try {
            host = new URL(details.url).hostname
          } catch {
            host = '(bad-url)'
          }
          noteBlocked(ctx, host, reason, details.resourceType)
          callback({ cancel: true })
        } else callback({})
      },
      (err) => {
        noteBlocked(ctx, '(check-failed)', String(err).slice(0, 60), details.resourceType)
        callback({ cancel: true })
      },
    )
  })
  captureSession = ses
  return ses
}

function destroyWindow(win) {
  if (!win || win.isDestroyed()) return
  const dbg = win.webContents.debugger
  if (dbg.isAttached()) dbg.detach()
  win.destroy()
}

function withTimeout(promise, ms, code, message) {
  let timer = null
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(captureError(code, message)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function checkAlive(ctx) {
  if (ctx.aborted) throw captureError(ctx.abortCode || 'aborted', ctx.abortMessage || '캡처를 멈췄습니다.')
  if (disposed) throw captureError('disposed', '앱이 종료 중입니다.')
  if (ctx.win && ctx.win.isDestroyed()) throw captureError('aborted', '캡처 창이 닫혔습니다.')
}

function evalIn(ctx, code, ms = EVAL_TIMEOUT_MS) {
  checkAlive(ctx)
  return withTimeout(ctx.win.webContents.executeJavaScript(code), ms, 'eval-timeout', '페이지 스크립트가 응답하지 않습니다.')
}

function cdp(ctx, method, params, ms = EVAL_TIMEOUT_MS) {
  checkAlive(ctx)
  return withTimeout(ctx.win.webContents.debugger.sendCommand(method, params || {}), ms, 'cdp-timeout', `${method} 응답이 없습니다.`)
}

function sampleMemory(ctx) {
  // 사이트 격리 때문에 이동하면서 렌더러 프로세스가 바뀔 수 있어 매번 다시 읽는다.
  if (ctx.win && !ctx.win.isDestroyed()) ctx.rendererPid = ctx.win.webContents.getOSProcessId()
  if (!ctx.rendererPid) return
  for (const m of app.getAppMetrics()) {
    if (m.pid !== ctx.rendererPid || !m.memory) continue
    ctx.memoryPeakKB = Math.max(ctx.memoryPeakKB, m.memory.workingSetSize || 0)
    if (m.memory.privateBytes) ctx.privatePeakKB = Math.max(ctx.privatePeakKB, m.memory.privateBytes)
  }
}

/** 요청이 QUIET_MS 동안 하나도 없을 때까지 기다린다. 한도까지 조용해지지 않으면 false. */
async function waitQuiet(ctx) {
  for (;;) {
    checkAlive(ctx)
    const now = Date.now()
    let live = 0
    for (const [id, started] of ctx.inflight) {
      if (now - started.at > STALLED_REQUEST_MS) {
        ctx.inflight.delete(id)
        ctx.stalledHosts.add(started.host)
      } else live += 1
    }
    if (live === 0 && now - ctx.lastNetworkAt >= QUIET_MS) return true
    if (now >= ctx.deadline) return false
    await sleep(POLL_MS)
  }
}

function onDebuggerMessage(ctx, method, params) {
  if (method === 'Network.requestWillBeSent') {
    const type = params.type || ''
    if (type === 'WebSocket' || type === 'EventSource') return
    let host = ''
    try {
      host = new URL(params.request.url).hostname
    } catch {
      host = '(bad-url)'
    }
    ctx.inflight.set(params.requestId, { at: Date.now(), host })
    ctx.lastNetworkAt = Date.now()
  } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
    if (ctx.inflight.delete(params.requestId)) ctx.lastNetworkAt = Date.now()
  }
}

async function runCapture(url, opts, ctx) {
  try {
    return await captureSteps(url, opts, ctx)
  } catch (err) {
    // 종료 · 한도로 창을 부순 뒤에 나는 오류(ERR_FAILED 등)는 원래 까닭으로 돌려준다.
    if (ctx.aborted && err && err.code !== ctx.abortCode) {
      throw captureError(ctx.abortCode || 'aborted', ctx.abortMessage || '캡처를 멈췄습니다.')
    }
    throw err
  } finally {
    // 한도를 넘겨 runJob이 먼저 끝난 경우에도 이 작업이 만든 창 · 타이머는 여기서 치운다.
    if (ctx.memoryTimer) clearInterval(ctx.memoryTimer)
    ctx.memoryTimer = null
    if (ctx.aborted) destroyWindow(ctx.win)
  }
}

async function captureSteps(url, opts, ctx) {
  const t0 = ctx.startedAt
  const mark = (name) => {
    ctx.timings[name] = Date.now() - t0
  }
  const ses = ensureSession()
  await ses.clearStorageData()
  checkAlive(ctx)

  // 오프스크린 렌더링(offscreen) 창. 보통의 숨긴 창은 Windows에서 합성기가 프레임을 내지 않아 CDP
  // Page.captureScreenshot이 응답하지 않는다(실측 2026-11-04: 4번 중 3번 15초 무응답, 나머지도 3.5초).
  // capturePage({stayHidden})는 프레임은 받지만 화면 배율(125%)대로 1600×1000이 나온다. 오프스크린 창은
  // 화면에 그려지지 않고 늘 '보이는' 상태라 CDP가 0.2초 안팎에 1280×800을 돌려준다. 창은 늘 1280×800이다 — 잘라 찍기 화면(1280×2100 ·
  // 배율 2)은 CDP Emulation이 정한다(창을 2100으로 만들어도 Windows가 화면 높이로 줄였다 — 실측 1281×912, 찍힌 그림은 같다).
  const view = opts.clip ? { height: CLIP_VIEW_HEIGHT, scale: CLIP_SCALE } : { height: VIEW_HEIGHT, scale: 1 }
  const win = new BrowserWindow({
    show: false,
    width: VIEW_WIDTH,
    height: VIEW_HEIGHT,
    useContentSize: true,
    frame: false,
    skipTaskbar: true,
    focusable: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      offscreen: true,
      partition: PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      backgroundThrottling: false,
      spellcheck: false,
      disableDialogs: true,
      navigateOnDragDrop: false,
      autoplayPolicy: 'document-user-activation-required',
    },
  })
  ctx.win = win
  if (ctx.aborted) destroyWindow(win)
  checkAlive(ctx)
  const wc = win.webContents
  ctx.wcId = wc.id
  wc.setFrameRate(OFFSCREEN_FPS)

  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('will-attach-webview', (event) => event.preventDefault())
  wc.on('will-navigate', (event) => {
    event.preventDefault()
    ctx.warnings.add('navigation-denied')
  })
  wc.on('will-frame-navigate', (event) => {
    let host = ''
    try {
      host = bareHost(new URL(event.url).hostname)
    } catch {
      host = ''
    }
    if (event.isMainFrame && host !== ctx.host) {
      event.preventDefault()
      ctx.warnings.add('navigation-denied')
    }
  })
  wc.on('will-redirect', (event) => {
    let ok = false
    try {
      const target = new URL(event.url)
      ok = target.protocol === 'https:' && bareHost(target.hostname) === ctx.host
    } catch {
      ok = false
    }
    if (!ok && event.isMainFrame) {
      event.preventDefault()
      ctx.warnings.add('redirect-denied')
    }
  })
  wc.on('render-process-gone', (_e, details) => {
    ctx.aborted = true
    ctx.abortCode = 'renderer-gone'
    ctx.abortMessage = `캡처 창의 렌더러가 멈췄습니다(${details && details.reason}).`
  })
  // 새 창은 렌더러가 아직 없어 CDP 명령이 응답하지 않는다(실측: Network.enable 무응답). 빈 페이지를 먼저 연다.
  await withTimeout(wc.loadURL('about:blank'), EVAL_TIMEOUT_MS, 'load-failed', '빈 페이지를 열지 못했습니다.')
  checkAlive(ctx)
  // 빈 페이지가 열린 뒤에 건다 — 빈 페이지의 dom-ready로 CSS를 넣었다고 잘못 기록하지 않게.
  wc.on('dom-ready', () => {
    if (ctx.aborted || win.isDestroyed()) return
    wc.insertCSS(captureCss(opts.hide), { cssOrigin: 'user' }).then(
      () => {
        ctx.cssReady = true
      },
      (err) => ctx.warnings.add(`css-failed:${String(err).slice(0, 60)}`),
    )
    wc.executeJavaScript(pageCall(pageSetup, DAY_THEME_ATTRS, opts.map ? opts.map.readyEvent : null)).then(
      () => null,
      (err) => ctx.warnings.add(`setup-failed:${String(err).slice(0, 60)}`),
    )
  })

  const dbg = wc.debugger
  dbg.attach('1.3')
  dbg.on('message', (_e, method, params) => onDebuggerMessage(ctx, method, params))
  dbg.on('detach', () => {
    if (!ctx.done) ctx.warnings.add('debugger-detached')
  })
  await cdp(ctx, 'Network.enable')
  // 배율은 사이트를 열기 전(빈 페이지)에 정한다 — 사이트가 처음부터 그 배율의 그림(srcset)을 고른다.
  await cdp(ctx, 'Emulation.setDeviceMetricsOverride', {
    width: VIEW_WIDTH,
    height: view.height,
    deviceScaleFactor: view.scale,
    mobile: false,
    screenWidth: VIEW_WIDTH,
    screenHeight: view.height,
  })
  await cdp(ctx, 'Emulation.setEmulatedMedia', {
    media: 'screen',
    features: [
      { name: 'prefers-reduced-motion', value: 'reduce' },
      { name: 'prefers-color-scheme', value: 'light' },
    ],
  })
  await cdp(ctx, 'Emulation.setFocusEmulationEnabled', { enabled: true })

  ctx.rendererPid = wc.getOSProcessId()
  ctx.memoryTimer = setInterval(() => sampleMemory(ctx), 250)

  const loadFailed = new Promise((_resolve, reject) => {
    wc.on('did-fail-load', (_e, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      if (isMainFrame && errorCode !== -3) reject(captureError('load-failed', `페이지를 열지 못했습니다(${errorCode} ${errorDescription}).`))
    })
  })
  loadFailed.catch((err) => ctx.warnings.add(`late-load-failure:${err.message}`))
  const remaining = () => Math.max(1000, ctx.deadline - Date.now())
  const loading = wc.loadURL(url).catch((err) => {
    if (err && err.code && !String(err.code).startsWith('ERR_')) throw err
    throw captureError('load-failed', `페이지를 열지 못했습니다(${err && err.code ? err.code : err}).`)
  })
  await withTimeout(Promise.race([loading, loadFailed]), remaining(), 'timeout', '페이지가 한도 안에 열리지 않았습니다.')
  mark('loadMs')
  ctx.rendererPid = wc.getOSProcessId()

  const activate = async () => {
    const r = await evalIn(ctx, pageCall(pageActivateFragmentLink))
    if (!r.clicked) ctx.warnings.add(`fragment-link:${r.why}`)
    ctx.activated = r.clicked
  }

  // 글꼴 → (지도가 아니면) 조각 링크 → 스크롤 → 조용함
  await evalIn(ctx, pageCall(pageSetup, DAY_THEME_ATTRS, opts.map ? opts.map.readyEvent : null))
  const fonts = await evalIn(ctx, 'document.fonts.ready.then(() => document.fonts.status)', remaining())
  if (fonts !== 'loaded') ctx.warnings.add(`fonts:${fonts}`)
  mark('fontsMs')
  if (opts.activateFragmentLink && !opts.map) await activate()
  const scroll1 = await evalIn(ctx, pageCall(pageScroll, opts.scrollTo))
  if (opts.scrollTo && !scroll1.found) ctx.warnings.add('scroll-target-missing')
  if (!(await waitQuiet(ctx))) ctx.warnings.add('network-busy-1')
  mark('quiet1Ms')

  // 지도: 준비 신호 → (조각 링크) → 타일이 다 들어와 0.5초 그대로일 때까지
  let mapRect = null
  if (opts.map) {
    const mapState = () => evalIn(ctx, pageCall(pageMapState, opts.map.selector, MAP_IMAGE_HOST_SUFFIXES))
    const notReady = (last) => {
      const why = !last || !last.box ? '지도 상자가 없습니다' : !last.ready ? '지도가 준비되지 않았습니다' : !last.inView ? '지도가 첫 화면에 없습니다' : `타일이 덜 들어왔습니다(${last.pending}/${last.tiles})`
      return captureError('map-not-ready', `${why}.`, { mapState: last })
    }
    let last = await mapState()
    while (!(last.box && last.ready)) {
      if (Date.now() >= ctx.deadline) throw notReady(last)
      await sleep(POLL_MS)
      last = await mapState()
    }
    mark('mapReadyMs')
    if (opts.activateFragmentLink) {
      await activate()
      await sleep(POLL_MS) // 누른 뒤 지도가 옮겨 갈 틈
    }
    let stableSince = 0
    for (;;) {
      last = await mapState()
      if (last.box && last.ready && last.inView && last.tiles > 0 && last.pending === 0) {
        if (!stableSince) stableSince = Date.now()
        if (Date.now() - stableSince >= 500) break
      } else stableSince = 0
      if (Date.now() >= ctx.deadline) throw notReady(last)
      await sleep(POLL_MS * 2)
    }
    if (last.broken > 0) ctx.warnings.add(`map-tiles-broken:${last.broken}`)
    mapRect = last.rect
    ctx.mapTiles = last.tiles
    mark('tilesMs')
  }

  // 그림 decode → 다시 스크롤(늦게 자리 잡은 요소 때문에 밀렸을 수 있다) → 다시 조용함
  const decoded = await evalIn(ctx, pageCall(pageDecode), remaining())
  if (decoded.failed > 0) ctx.warnings.add(`images-failed:${decoded.failed}`)
  mark('decodeMs')
  const scroll2 = await evalIn(ctx, pageCall(pageScroll, opts.scrollTo))
  if (!(await waitQuiet(ctx))) ctx.warnings.add('network-busy-2')
  if (scroll2.y !== scroll1.y) ctx.warnings.add(`scroll-moved:${scroll1.y}->${scroll2.y}`)
  if (opts.map) {
    const s = await evalIn(ctx, pageCall(pageMapState, opts.map.selector, MAP_IMAGE_HOST_SUFFIXES))
    if (!s.box || s.pending > 0 || !s.inView) throw captureError('map-not-ready', '마지막 확인에서 지도 타일이 덜 들어왔습니다.', { mapState: s })
    mapRect = s.rect
  }
  await evalIn(ctx, pageCall(pageSetup, DAY_THEME_ATTRS, null))
  mark('quiet2Ms')
  if (!ctx.cssReady) ctx.warnings.add('css-not-confirmed')

  // 잘라 찍기: 요소 자리 → 사각형 · 스크롤 → (스크롤했으면 그림 decode · 조용함을 다시) → 다시 재어 화면 안인지 · 가리는 고정 요소가 없는지
  let clipRect = null
  let clipView = null
  let clipText = null
  let clipScrollY = null
  if (opts.clip) {
    const { selectors, optional, padding } = opts.clip
    const measure = async () => {
      const state = await evalIn(ctx, pageCall(pageClipState, selectors, optional, VIEW_HEIGHT))
      if (state.missing.length) {
        throw captureError('clip-missing', `잘라 찍을 요소가 페이지에 없습니다(${state.missing.join(', ')}).`, { clipState: { missing: state.missing } })
      }
      return { state, plan: clipPlan(state.rects, padding, state) }
    }
    let { state, plan } = await measure()
    if (plan.problem) throw clipError(plan)
    if (plan.scrollY !== state.scrollY) {
      await evalIn(ctx, `(window.scrollTo({ top: ${Number(plan.scrollY)}, left: 0, behavior: 'instant' }), true)`)
      // 스크롤로 드러나는 것(IntersectionObserver · 늦게 읽는 그림)이 반응할 틈 — 스크롤한 때부터 적어도 QUIET_MS를 기다린다. 요청이 없으면
      // waitQuiet가 바로 돌아와 검사 뒤 · 찍기 전에 그림이 나타날 수 있었다.
      ctx.lastNetworkAt = Date.now()
      const again = await evalIn(ctx, pageCall(pageDecode), remaining())
      if (again.failed > 0) ctx.warnings.add(`images-failed-clip:${again.failed}`)
      if (!(await waitQuiet(ctx))) ctx.warnings.add('network-busy-clip')
      ;({ state, plan } = await measure())
      if (plan.problem) throw clipError(plan)
      if (plan.scrollY !== state.scrollY) throw captureError('clip-covered', '스크롤한 뒤에도 잘라 찍을 부분이 화면에 다 들어오지 않습니다.')
    }
    clipRect = plan.rect
    clipView = { x: plan.rect.x - state.scrollX, y: plan.rect.y - state.scrollY, width: plan.rect.width, height: plan.rect.height }
    const covers = await evalIn(ctx, pageCall(pageClipCovers, selectors, optional, clipView))
    if (covers.length) throw captureError('clip-covered', `잘라 찍을 부분을 고정 요소가 가립니다(${covers.slice(0, 3).join(', ')}).`)
    clipText = state.text.slice(0, CLIP_TEXT_MAX)
    clipScrollY = state.scrollY
    mark('clipMs')
  }

  // 보이는 그림 검사: 바깥 호스트 · 공공누리 그림이 있으면 버린다(잘라 찍기면 그 사각형에 걸친 것만). 찍기 전과 찍은 뒤 두 번 — 그사이에
  // 나타난 그림(드러내기 · 늦게 붙은 요소)이 있으면 찍은 그림도 버린다.
  const where = clipView ? '잘라 찍을 부분' : '첫 화면'
  const inspect = async (after) => {
    const seen = await evalIn(ctx, pageCall(pageInspect, ctx.host, opts.map ? opts.map.selector : null, MAP_IMAGE_HOST_SUFFIXES, clipView, VIEW_HEIGHT))
    const when = after ? '찍는 사이에 ' : ''
    if (seen.kogl > 0) throw captureError('kogl-image', `${when}공공누리 표시가 붙은 그림이 ${where}에 있습니다(${seen.kogl}개).`, { inspect: seen })
    if (seen.foreign.length > 0) {
      throw captureError('foreign-image', `${when}자사 호스트가 아닌 그림이 ${where}에 있습니다(${seen.foreign.join(', ')}).`, { inspect: seen })
    }
    if (seen.frames.length > 0) throw captureError('foreign-image', `${when}${where}에 iframe이 있습니다(${seen.frames.join(', ')}).`, { inspect: seen })
    // 닫힌 shadow root 안은 위 검사가 볼 수 없다 — 하나라도 있으면 바깥 · 공공누리 그림이 없다고 말할 수 없으므로 버린다(잘라 찍기도 모두 센다).
    const tree = await cdp(ctx, 'DOM.getDocument', { depth: -1, pierce: true })
    const closedRoots = countClosedShadowRoots(tree && tree.root)
    if (closedRoots > 0) throw captureError('closed-shadow', `${when}그림을 검사할 수 없는 닫힌 shadow root가 ${closedRoots}개 있습니다.`, { inspect: seen })
    return seen
  }
  const seen = await inspect(false)
  mark('inspectMs')

  const shot = await cdp(
    ctx,
    'Page.captureScreenshot',
    {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
      // CDP clip은 문서 좌표다(스크롤한 화면에서 실측 2026-11-04 — 화면 좌표로 주면 스크롤만큼 아래가 찍힌다). CSS px로 주고 scale은 1 —
      // 찍힌 그림은 화면 배율(view.scale)배다.
      ...(clipRect ? { clip: { x: clipRect.x, y: clipRect.y, width: clipRect.width, height: clipRect.height, scale: 1 } } : {}),
    },
    SHOT_TIMEOUT_MS,
  )
  mark('shotMs')
  await inspect(true)
  mark('reinspectMs')
  checkAlive(ctx)
  const png = Buffer.from(shot.data, 'base64')
  const image = nativeImage.createFromBuffer(png)
  const size = image.getSize()
  // 기대 크기 · 지도 자리는 CSS px × 배율(장치 px). 지도는 잘라 찍기와 함께 쓰지 않아 늘 배율 1이다.
  const css = clipRect ? { width: clipRect.width, height: clipRect.height } : { width: VIEW_WIDTH, height: VIEW_HEIGHT }
  const want = { width: css.width * view.scale, height: css.height * view.scale }
  if (size.width !== want.width || size.height !== want.height) {
    throw captureError('bad-size', `찍힌 크기가 ${size.width}×${size.height}입니다(기대 ${want.width}×${want.height}).`)
  }
  const bitmap = image.toBitmap()
  const pixels = regionStats(bitmap, size.width, size.height, { x: 0, y: 0, w: size.width, h: size.height })
  if (isBlank(pixels)) throw captureError('blank', '빈 화면이 찍혔습니다.', { pixels })
  let mapPixels = null
  if (mapRect) {
    const k = view.scale
    mapPixels = regionStats(bitmap, size.width, size.height, { x: mapRect.x * k, y: mapRect.y * k, w: mapRect.w * k, h: mapRect.h * k })
    if (isBlank(mapPixels)) throw captureError('map-blank', '지도 자리가 비어 있습니다.', { pixels: mapPixels })
  }
  sampleMemory(ctx)
  mark('totalMs')

  return {
    png,
    width: size.width,
    height: size.height,
    scale: view.scale,
    waitedMs: ctx.timings.totalMs,
    url,
    finalUrl: wc.getURL(),
    warnings: [...ctx.warnings],
    timings: { ...ctx.timings },
    blocked: [...ctx.blocked].map(([key, count]) => {
      const [reason, host, type] = key.split('|')
      return { reason, host, type, count }
    }),
    stalledHosts: [...ctx.stalledHosts],
    inspect: seen,
    pixels,
    mapPixels,
    mapTiles: ctx.mapTiles || 0,
    activated: Boolean(ctx.activated),
    scrollY: clipScrollY === null ? scroll2.y : clipScrollY,
    clip: clipRect,
    clipText,
    memoryPeakKB: ctx.memoryPeakKB || null,
    privatePeakKB: ctx.privatePeakKB || null,
  }
}

function newContext(opts) {
  const now = Date.now()
  return {
    host: opts.host,
    startedAt: now,
    deadline: now + opts.timeoutMs,
    win: null,
    wcId: -1,
    rendererPid: 0,
    aborted: false,
    abortCode: null,
    abortMessage: null,
    done: false,
    cssReady: false,
    warnings: new Set(),
    blocked: new Map(),
    dnsCache: new Map(),
    inflight: new Map(),
    stalledHosts: new Set(),
    lastNetworkAt: now,
    timings: {},
    memoryTimer: null,
    memoryPeakKB: 0,
    privatePeakKB: 0,
    mapTiles: 0,
    ownHostOnly: opts.ownHostOnly,
  }
}

async function runJob(rawUrl, options) {
  if (disposed) throw captureError('disposed', '앱이 종료 중입니다.')
  const opts = normalizeOptions(options)
  const url = await assertCaptureUrl(rawUrl, opts.host)
  // DNS를 확인하는 동안 앱이 끝났으면(disposeCapture — 그때는 멈출 작업이 아직 없다) 창을 만들지 않는다.
  if (disposed) throw captureError('disposed', '앱이 종료 중입니다.')
  const ctx = newContext(opts)
  activeCtx = ctx
  let hardTimer = null
  const hardStop = new Promise((_resolve, reject) => {
    hardTimer = setTimeout(() => {
      ctx.aborted = true
      ctx.abortCode = 'timeout'
      ctx.abortMessage = `캡처가 ${Math.round((opts.timeoutMs + HARD_GRACE_MS) / 1000)}초 안에 끝나지 않았습니다.`
      destroyWindow(ctx.win)
      reject(captureError('timeout', ctx.abortMessage))
    }, opts.timeoutMs + HARD_GRACE_MS)
  })
  try {
    return await Promise.race([runCapture(url, opts, ctx), hardStop])
  } finally {
    ctx.done = true
    clearTimeout(hardTimer)
    destroyWindow(ctx.win)
    if (activeCtx === ctx) activeCtx = null
  }
}

/**
 * 자사 화면 한 장을 찍는다(한 번에 한 장, 들어온 순서대로).
 *
 * @param {string} url  https 주소. 호스트는 options.host와 같아야 한다.
 * @param {object} options
 *   host       허용 호스트(프로필의 호스트). 필수.
 *   map        true 또는 { selector, readyEvent } — 지도 화면이면 준비 신호와 타일까지 기다린다.
 *   scrollTo   이 선택자의 요소가 화면 맨 위(고정 머리 아래)에 오게 스크롤한다. 없으면 주소의 #조각.
 *   hide       더 숨길 선택자 목록(최대 20).
 *   activateFragmentLink  true면 주소의 #조각을 가리키는 페이지 안 링크를 한 번 누른다(지도면 지도 준비 뒤).
 *   clip       { selectors, optional?, padding? } — 선택자들(필수 1~8개 · 있으면 넣는 optional 0~8개)의 요소를 합친 사각형에 여백
 *              (기본 16, 최대 48)을 둘러 그 부분만 찍는다. 그림 검사도 그 사각형에 걸친 것만 본다. map · scrollTo와 함께 쓰지 않는다.
 *              화면 1280×2100 · 배율 2로 찍는다(세로 2000 CSS px까지).
 *   ownHostOnly  true면 자사 호스트 밖의 요청을 모두 막는다.
 *   timeoutMs  기다리는 한도(기본 25초, 최대 45초). 찍기 · 검사에 12초를 더 준다.
 * @returns {Promise<{png: Buffer, width: number, height: number, scale: number, waitedMs: number, url: string,
 *   finalUrl: string, warnings: string[], timings: object, blocked: object[], inspect: object,
 *   pixels: object, mapPixels: object|null, mapTiles: number, memoryPeakKB: number|null,
 *   clip: {x: number, y: number, width: number, height: number}|null, clipText: string|null}>}
 *   width · height는 PNG 화소, scale은 화면 배율(첫 화면 1 · 잘라 찍기 2 — width = 사각형 가로 × scale). clip은 찍은 사각형(문서 좌표 ·
 *   CSS px), clipText는 잘라 찍은 요소들의 글자(CLIP_TEXT_MAX자까지 — 서버가 설명 줄의 사실과 견준다).
 *   실패하면 code가 붙은 Error로 거부한다: invalid-url · off-host · private-address · invalid-options · busy ·
 *   disposed · timeout · load-failed · map-not-ready · clip-missing · clip-too-large · clip-too-small · clip-covered · kogl-image ·
 *   foreign-image · closed-shadow · bad-size · blank · map-blank · renderer-gone · aborted · eval-timeout · cdp-timeout.
 */
function captureScreen(url, options) {
  return runQueued(() => runJob(url, options))
}

/**
 * 메인의 숨긴 창 일을 한 줄에 세운다(한 번에 하나, 들어온 순서대로) — 화면 찍기와 지도 그리기(mapRender.cjs)가 함께 쓴다.
 * 종료 뒤면 'disposed', 대기열이 가득 차면(MAX_QUEUE) 'busy'로 거부한다.
 */
function runQueued(run) {
  if (disposed) return Promise.reject(captureError('disposed', '앱이 종료 중입니다.'))
  if (queued >= MAX_QUEUE) return Promise.reject(captureError('busy', '캡처 대기열이 가득 찼습니다.'))
  queued += 1
  const job = queueTail.then(() => run())
  // 사슬은 순서만 지킨다 — 성공 · 실패는 job을 받은 호출자가 처리한다.
  const release = () => {
    queued -= 1
  }
  queueTail = job.then(release, release)
  return job
}

/** 앱 종료 때 부른다: 찍던 창을 부수고, 기다리던 작업은 모두 'disposed'로 거부된다. */
function disposeCapture() {
  disposed = true
  const ctx = activeCtx
  if (ctx) {
    ctx.aborted = true
    ctx.abortCode = 'disposed'
    ctx.abortMessage = '앱이 종료 중입니다.'
    destroyWindow(ctx.win)
  }
}

function captureStatus() {
  return { busy: Boolean(activeCtx), queued, disposed }
}

// ── 서버(utilityProcess)와 주고받는 메시지 ──────────────────────────────────
// 서버(server/screens.ts)가 process.parentPort로 찍기를 청하면 main.cjs가 여기로 넘기고, 돌려준 답을 서버로 보낸다.
//   요청 { type: 'screen-capture', id, url, options: { host, map?, scrollTo?, hide?, activateFragmentLink?, clip?, ownHostOnly?, timeoutMs? } }
//   답   { type: 'screen-capture-result', id, ok: true, png(base64), width, height, scale, url, finalUrl, waitedMs, warnings, text? }
//        { type: 'screen-capture-result', id, ok: false, code, message }
// 지도 그리기 요청 { type: 'map-render', id, spec }은 mapRender.cjs handleMapRequest로 넘기고 'map-render-result'로 답한다(같은 줄에 선다).
const REQUEST_TYPE = 'screen-capture'
const RESULT_TYPE = 'screen-capture-result'
const MAP_REQUEST_TYPE = 'map-render'
const REQUEST_ID = /^[\w-]{1,64}$/
const REQUEST_OPTION_KEYS = new Set(['host', 'map', 'scrollTo', 'hide', 'activateFragmentLink', 'clip', 'ownHostOnly', 'timeoutMs'])

/**
 * 서버가 보낸 찍기 요청 하나를 처리하고 서버로 보낼 답을 돌려준다. 거부하지 않는다 — 실패도 답(ok false)이다. 요청 모양이 아니거나 id가
 * 맞지 않으면 null(답할 곳이 없다). 주소 검사(https · 기본 포트 · 호스트 = options.host · 사설 · 루프백 주소 아님)와 선택자 검사는
 * captureScreen이 하고, 여기서는 모양과 옵션 이름만 본다. 줄 세우기(한 번에 한 장)도 captureScreen이 한다.
 */
async function handleCaptureRequest(msg) {
  if (!msg || typeof msg !== 'object' || msg.type !== REQUEST_TYPE) return null
  const id = typeof msg.id === 'string' && REQUEST_ID.test(msg.id) ? msg.id : null
  if (!id) return null
  try {
    const options = msg.options
    if (typeof msg.url !== 'string' || !msg.url || msg.url.length > 2048) throw captureError('invalid-url', '주소가 없거나 너무 깁니다.')
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some((k) => !REQUEST_OPTION_KEYS.has(k))) {
      throw captureError('invalid-options', '찍기 옵션이 올바르지 않습니다.')
    }
    const shot = await captureScreen(msg.url, options)
    return {
      type: RESULT_TYPE,
      id,
      ok: true,
      png: shot.png.toString('base64'),
      width: shot.width,
      height: shot.height,
      scale: shot.scale,
      url: shot.url,
      finalUrl: shot.finalUrl,
      waitedMs: shot.waitedMs,
      warnings: shot.warnings,
      ...(typeof shot.clipText === 'string' ? { text: shot.clipText } : {}),
    }
  } catch (err) {
    const code = err && typeof err.code === 'string' ? err.code : 'failed'
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[capture] 찍기 실패(${code}): ${typeof msg.url === 'string' ? msg.url.slice(0, 200) : ''} — ${message}`)
    return { type: RESULT_TYPE, id, ok: false, code, message: message.slice(0, 300) }
  }
}

/**
 * 서버 utilityProcess(child)의 찍기 · 지도 그리기 요청을 받아 답을 돌려보내도록 건다(main.cjs startServerProcess). 다른 type의 메시지는
 * 지나친다. isCurrent()가 false면(그사이 서버가 끝났거나 바뀜) 답하지 않는다.
 */
function relayCaptureRequests(child, isCurrent) {
  child.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return
    let handled
    if (msg.type === REQUEST_TYPE) handled = handleCaptureRequest(msg)
    else if (msg.type === MAP_REQUEST_TYPE) handled = require('./mapRender.cjs').handleMapRequest(msg)
    else return
    void handled.then((reply) => {
      if (!reply || !isCurrent()) return
      try {
        child.postMessage(reply)
      } catch (err) {
        const what = msg.type === MAP_REQUEST_TYPE ? '그린 지도' : '찍은 결과'
        console.warn(`[capture] 서버에 ${what}를 보내지 못했습니다: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
  })
}

module.exports = {
  captureScreen,
  runQueued,
  disposeCapture,
  captureStatus,
  handleCaptureRequest,
  relayCaptureRequests,
  assertCaptureUrl,
  isPrivateAddress,
  blankCheck,
  pageInspect,
  pageClipState,
  pageClipCovers,
  clipPlan,
  requestBlockReason,
  countClosedShadowRoots,
  VIEW_WIDTH,
  VIEW_HEIGHT,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
}
