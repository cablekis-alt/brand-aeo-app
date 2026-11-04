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

interface CaptureModule {
  captureScreen: (url: string, options: Record<string, unknown>) => Promise<unknown>
  disposeCapture: () => void
  pageInspect: (ownHost: string, mapSelector: string | null, mapHosts: string[]) => InspectResult
  countClosedShadowRoots: (node: unknown) => number
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
  const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown }
  const realLoad = loader._load
  loader._load = function (this: unknown, request: string, ...rest: unknown[]) {
    return request === 'electron' ? fakeElectron : realLoad.call(this, request, ...rest)
  }
  try {
    const mod = createRequire(import.meta.url)('../electron/capture.cjs') as CaptureModule
    return { ...mod, windowsCreated: () => created }
  } finally {
    loader._load = realLoad
  }
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
  ok('자사 사이트에 프로필 호스트가 있으면 그 프로필(코스 3 · 지도 6)', profile?.host === 'gunsan.webforai.kr' && course?.variants.length === 3 && map?.variants.length === 6)
  ok('ownedDomains의 https:// · www. · 끝 / 를 걷고 찾는다', screenProfileFor(['https://www.gunsan.webforai.kr/']) === profile)
  ok('상위 도메인 · 다른 사이트 · 없음이면 프로필이 없다', screenProfileFor(['webforai.kr']) === null && screenProfileFor(['stay.example']) === null && screenProfileFor(undefined) === null)
  const allUrls = SCREEN_PROFILES.flatMap((p) => p.screens.flatMap((s) => s.variants.map((v) => screenUrl(p, v))))
  ok('모든 변형 주소는 https · 프로필 호스트', allUrls.length === 9 && allUrls.every((u) => new URL(u).protocol === 'https:' && new URL(u).host === 'gunsan.webforai.kr'))
  ok(
    '코스 변형은 /plan/ 미리 채우기 쿼리만(보내는 값 없음)',
    (course?.variants ?? []).every((v) => v.path.startsWith('/plan/')) &&
      screenUrl(profile!, course!.variants.find((v) => v.id === 'kids')!) === 'https://gunsan.webforai.kr/plan/?with=kids&kids=7',
  )
  const ids = SCREEN_PROFILES.flatMap((p) => p.screens.map((s) => `${p.host}/${s.id}:${new Set(s.variants.map((v) => v.id)).size === s.variants.length}`))
  ok('화면 · 변형 id는 프로필 안에서 겹치지 않는다', ids.every((x) => x.endsWith(':true')) && new Set(ids).size === ids.length)
  ok('글에 넣는 종류는 코스만(지도는 미리보기만)', JSON.stringify(SCREEN_AUTO_SAVE_KINDS) === '["course"]' && screenSaveAllowed('course') && !screenSaveAllowed('map'))
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
  const kindOf = (t: string) => screenKindOf(t, profile).kind
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
  ok('다른 회사 · 휴대폰 화면은 other', kindOf('지도 앱에서 숙소까지 도보 경로를 띄운 휴대폰 화면') === 'other' && kindOf('네이버 플레이스 예약 화면') === 'other')
  ok(
    '목록에 없는 화면은 unrelated, 프로필이 없는 브랜드는 none',
    kindOf("가상각 웹사이트의 '아이와 함께' 안내 화면") === 'unrelated' && kindOf('관광정보 사이트에서 한 장소의 요금이 표시된 화면') === 'unrelated' &&
      screenKindOf('가상스테이 웹사이트의 예약 화면', null).kind === 'none',
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
  ok(
    '아이 · 부모님 코스 자리는 그 조건 다음 기본 — 다른 조건은 쓰지 않는다(「아이콘」은 아이가 아니다) · 조건을 말하지 않으면 기본 다음 조건',
    tiersOf(course!, '아이와 함께 AI 코스 만들기 조건을 고르는 모습') === 'kids | default (prefer)' && tiersOf(course!, '부모님과 가는 여행의 AI 코스 만들기 화면') === 'parents | default (prefer)' &&
      tiersOf(course!, 'AI 코스 만들기 화면에서 조건을 고르는 모습') === 'default | kids,parents (general)' &&
      tiersOf(course!, '아이콘이 보이는 AI 코스 만들기 화면') === 'default | kids,parents (general)',
  )
  ok('코스 자리에 장소가 나와도 권역으로 좁히지 않는다', tiersOf(course!, 'AI 코스 만들기 화면에 근대역사박물관을 넣는 모습', ['근대역사박물관']) === 'default | kids,parents (general)')
  const COURSE_TEXT = '가상각 웹사이트의 AI 코스 만들기 화면에서 여행 조건을 고르는 모습'
  ok(
    '코스 조건은 소제목 · 설명 줄도 본다 — 「아이와 함께」 · 「부모님」은 그 조건, 「혼자 · 연인 · 친구 · 커플」은 기본만',
    tiersOf(course!, COURSE_TEXT, [], "가상각 '아이와 함께' 안내로 시간표를 짜면 어떻게 되나요?") === 'kids | default (prefer)' &&
      tiersOf(course!, COURSE_TEXT, [], '1박 2일 일정\n부모님과 함께라면 어르신 인원을 넣어 보세요.') === 'parents | default (prefer)' &&
      tiersOf(course!, COURSE_TEXT, [], '가상각으로 연인·혼자 코스는 어떻게 짜나요?') === 'default (other)' &&
      tiersOf(course!, COURSE_TEXT, [], '혼자·친구·커플 조건으로 코스를 짜 보면\n조건을 고른 뒤 일정을 다듬습니다.') === 'default (other)',
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
    ok('답의 PNG(base64)를 바이트로 받는다', got.png.equals(pngA) && got.finalUrl === req1.url && JSON.stringify(got.warnings) === '["w1"]')
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

  // ── 7) 저장 · 같은 날 다시 쓰기 ─────────────────────────────────────────
  {
    const T = 'fake-gunsan'
    const pngs: Buffer[] = []
    let calls = 0
    let delayMs = 0
    const port = new FakePort()
    port.onPost = (msg) => {
      calls += 1
      const png = pngs.shift()
      setTimeout(() => port.emit({ type: 'screen-capture-result', id: msg.id, ok: true, png: png ? png.toString('base64') : '' }), delayMs)
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
    JSON.stringify({ 'content:a': emptyDraft('content:a'), 'content:b': emptyDraft('content:b'), 'content:c': emptyDraft('content:c'), 'content:d': emptyDraft('content:d', { photos: [mapPlanted] }) }),
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
  ok(
    '목록 — 화면(코스는 넣기 가능 · 지도는 미리보기만)과 찍어 둔 화면(늦게 찍은 것부터 · 앱 주소)',
    listRes.status === 200 && list.available === false && list.host === 'gunsan.webforai.kr' && listScreens.length === 2 &&
      listScreens.find((s) => s.id === 'course')?.saveAllowed === true && listScreens.find((s) => s.id === 'map')?.saveAllowed === false &&
      listScreens.find((s) => s.id === 'map')?.variants.length === 6 && listShots.length === 2 && listShots[0]?.id === shaK && listShots[1]?.src === `/api/screens/${TENANT}/${shaM}.png`,
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

  const photoFile = async (actionId: string, slot: string, heading: string) => {
    const q = new URLSearchParams({ actionId, generatedAt: AT, slot, nth: '1', heading })
    return getRaw(`/api/content-draft/${TENANT}/photo-file?${q.toString()}`)
  }
  const pf = await photoFile('content:a', '코스 만들기 화면', '코스')
  ok('사진 받기 — 화면은 이 PC의 파일을 png로', pf.status === 200 && pf.headers.get('content-type') === 'image/png' && Buffer.from(await pf.arrayBuffer()).equals(pngK))
  ok('사진 받기 — 글에 남아 있는 지도 화면은 409', (await photoFile('content:d', '지도 화면', '지도')).status === 409)

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
