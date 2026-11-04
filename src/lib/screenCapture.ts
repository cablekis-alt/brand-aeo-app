/**
 * 자사 화면 캡처 — 브랜드 자사 사이트에서 찍을 화면(프로필 표) · 화면 · 변형 id · 이름표 · 글에 넣는 규칙.
 *
 * 데스크톱 앱의 메인 프로세스가 숨긴 창으로 찍고(electron/capture.cjs), 서버가 운영자 PC에 저장한다(server/screens.ts —
 * PIPELINE_DATA_DIR/<tenant>/screens/<id>.png + screens.json). 글의 사진 기록(PhotoPick)에는 앱 주소 /api/screens/<tenant>/<id>.png만 적고,
 * 그림은 내보낼 때 넣는다(2026-11-04 결정 1).
 *
 * 찍을 주소는 이 표에서만 나온다 — 화면(클라이언트)은 주소를 보내지 않고 화면 id · 변형 id만 보낸다. 코스 화면은 주소의 쿼리로 조건을
 * 미리 채우기만 하고 보내지 않는다(POST /api/plan/ 없음 — 캡처 창은 GET 말고는 모두 막는다).
 *
 * 서버(server/screens.ts · server/index.ts · server/contentDraft.ts)와 화면이 함께 쓰므로 DOM에 기대지 않는다.
 */
import type { PhotoPick } from './articlePhotos.js'

/** 화면 종류 — course(코스 만들기 화면) · map(지도 화면). */
export type ScreenKind = 'course' | 'map'

/** 한 화면의 변형 하나 — 같은 페이지를 다른 조건 · 권역으로 연 것. 「화면 + 변형」이 한 장의 단위다. */
export interface ScreenVariant {
  /** 변형 id — 그 화면 안에서 고유. */
  id: string
  /** 미리보기 · 칩에 쓰는 이름(「아이와」 · 「원도심」). */
  label: string
  /** 찍을 주소의 경로 · 쿼리 · #조각(호스트 뒤). 미리 채우기는 주소로만 한다 — 제출하지 않는다. */
  path: string
  /** 이 선택자의 요소가 화면 맨 위(고정 머리 아래)에 오게 스크롤한다(electron/capture.cjs scrollTo). */
  scrollTo?: string
  /**
   * 주소의 #조각을 가리키는 페이지 안 링크를 지도 준비 뒤 한 번 누른다 — 군산각 /map/#r-권역을 바로 열면 목록만 그 권역으로 걸러지고
   * 지도는 군산 전체로 남는다(site.js가 map.js보다 먼저 gs:region을 보낸다). 사이트가 고치면 뺀다.
   */
  activateFragmentLink?: true
}

/** 찍을 화면 하나. */
export interface ScreenDef {
  /** 화면 id — 그 프로필 안에서 고유. */
  id: string
  kind: ScreenKind
  /** 사이트의 메뉴 이름 그대로(「AI 코스 만들기」) — 대체 텍스트 · 미리보기에 쓴다. */
  label: string
  /** 지도 화면 — 준비 신호(gs:mapready)와 카카오 타일까지 기다린다. */
  map?: true
  /** 이 화면에서 더 숨길 것(챗봇 단추 · 캐러셀 · 동의 배너는 캡처 모듈이 늘 숨긴다). */
  hide?: readonly string[]
  variants: readonly ScreenVariant[]
}

/** 자사 사이트 하나의 화면 목록 — 호스트로 찾는다(브랜드 ownedDomains에 그 호스트가 있어야 한다). */
export interface ScreenProfile {
  host: string
  screens: readonly ScreenDef[]
}

/** 찍은 화면 한 장 — server/screens.ts가 screens.json에 적는다. */
export interface ScreenShot {
  /** PNG sha256의 앞 16자(소문자 16진수) — 파일 이름 <sha16>.png이자 찍은 화면 id. */
  sha16: string
  screenId: string
  variantId: string
  /** 찍은 주소(프로필에서 만든 것). */
  url: string
  /** 찍은 때(서버 시각, ISO). 같은 그림을 다른 날 다시 찍으면 이 값만 새로 적는다. */
  capturedAt: string
  width: number
  height: number
  bytes: number
}

/** 목록 · 찍기 응답에 나가는 한 장 — id(= sha16)와 앱 주소(src)를 붙인다. */
export interface ScreenShotView extends ScreenShot {
  id: string
  src: string
}

/** 군산각 코스 화면의 조건 고르기 단계(동행) — 아이와 · 부모님 변형은 여기가 맨 위에 오게 찍는다. */
const GUNSAN_COURSE_STEP = 'fieldset:has(input[name="with"])'
/** 군산각 날씨 카드 — 실시간 날씨 · 점수 · 밤에는 달이 그려져 오래 남는 블로그 그림에 맞지 않는다. */
const GUNSAN_WEATHER = '[data-wx]'

function gunsanRegion(name: string, label = name): ScreenVariant {
  return { id: `r-${name}`, label, path: `/map/#r-${name}`, scrollTo: '.map-grid', activateFragmentLink: true }
}

/**
 * 자사 화면 프로필 표. 1차는 군산각의 코스 화면 3장(기본 · 아이와 · 부모님 조건)과 지도 화면 6장(전체 + 권역 5)이다. 주소의 쿼리 이름 ·
 * 권역 조각은 사이트(plan.js fromAddress · /map/의 권역 탭)에서 확인한 것이다(2026-11-04). 프로필이 없는 브랜드는 찍을 화면이 없다.
 */
export const SCREEN_PROFILES: readonly ScreenProfile[] = [
  {
    host: 'gunsan.webforai.kr',
    screens: [
      {
        id: 'course',
        kind: 'course',
        label: 'AI 코스 만들기',
        hide: ['.trp-handed-w', GUNSAN_WEATHER],
        variants: [
          { id: 'default', label: '기본', path: '/plan/', scrollTo: '#trp-form' },
          { id: 'kids', label: '아이와', path: '/plan/?with=kids&kids=7', scrollTo: GUNSAN_COURSE_STEP },
          { id: 'parents', label: '부모님', path: '/plan/?with=parents&adults=3&seniors=2', scrollTo: GUNSAN_COURSE_STEP },
        ],
      },
      {
        id: 'map',
        kind: 'map',
        label: '지도에서 찾기',
        map: true,
        hide: [GUNSAN_WEATHER],
        variants: [
          { id: 'default', label: '전체', path: '/map/', scrollTo: '.map-grid' },
          gunsanRegion('원도심'),
          gunsanRegion('은파'),
          gunsanRegion('고군산'),
          gunsanRegion('금강'),
          gunsanRegion('새만금-비응', '새만금·비응'),
        ],
      },
    ],
  },
]

/**
 * 글에 저장해도 되는 화면 종류 — 사람이 고르기(op pick)와 자동 채우기(op auto) 모두, 그리고 사진 받기(photo-file)도 이 값을 본다.
 * 카카오 지도 화면은 운영자가 이용 조건(로고 · 출처를 그대로 두고 블로그에 다시 싣는 것)을 확인하기 전까지 찍기 · 미리보기만 한다
 * (2026-11-04 결정 4). 확인되면 여기에 'map'을 더한다 — 서버와 화면이 이 값 하나만 본다.
 */
export const SCREEN_AUTO_SAVE_KINDS: readonly ScreenKind[] = ['course']

export function screenSaveAllowed(kind: ScreenKind): boolean {
  return SCREEN_AUTO_SAVE_KINDS.includes(kind)
}

/** 찍은 화면 id(= PNG sha256 앞 16자)의 모양. */
export const SCREEN_SHOT_ID = /^[0-9a-f]{16}$/

export function isScreenShotId(v: unknown): v is string {
  return typeof v === 'string' && SCREEN_SHOT_ID.test(v)
}

/** 글의 사진 기록에 적는 앱 주소 — 앱 안(같은 출처)에서만 열린다. 내보낼 때 그림으로 바꾼다. */
export function screenAppSrc(tenantId: string, shotId: string): string {
  return `/api/screens/${encodeURIComponent(tenantId)}/${shotId}.png`
}

const APP_SRC = /^\/api\/screens\/([^/?#]+)\/([0-9a-f]{16})\.png$/

/** 앱 주소에서 브랜드 · 찍은 화면 id를 읽는다. 모양이 다르거나 브랜드 id에 경로 글자가 있으면 null. */
export function parseScreenAppSrc(src: unknown): { tenantId: string; shotId: string } | null {
  const m = typeof src === 'string' ? APP_SRC.exec(src) : null
  if (!m) return null
  let tenantId: string
  try {
    tenantId = decodeURIComponent(m[1]!)
  } catch {
    return null
  }
  if (!tenantId || /[/\\]/.test(tenantId) || tenantId === '.' || tenantId === '..') return null
  return { tenantId, shotId: m[2]! }
}

/**
 * 같은 사진 반복 상한의 열쇠(src/lib/photoAutoPick.ts AUTO_PICK_RULES · server/contentDraft.ts saveAutoPhotoPicks). 사진은 주소, 자사 화면은
 * 「화면 + 변형」 — 다른 날 다시 찍어 파일이 달라져도 같은 화면으로 센다(2026-11-04 결정 3). 사람이 뺀 자리의 기록(removed)도 이 열쇠를 적는다.
 */
export function photoRepeatKey(p: Pick<PhotoPick, 'src' | 'origin' | 'screenId' | 'variantId'>): string {
  return p.origin === 'screen' && p.screenId && p.variantId ? `screen:${p.screenId}:${p.variantId}` : p.src
}

/**
 * 브랜드 전체 반복 상한(AUTO_PICK_RULES.brandRepeat)을 받지 않는 사진인가 — 자사 화면은 받지 않는다(결정 3). 글 하나에 한 번 · 작성자
 * 한 사람에게 한 번은 화면에도 그대로 지킨다(photoRepeatKey 단위).
 */
export function brandRepeatExempt(p: Pick<PhotoPick, 'origin'>): boolean {
  return p.origin === 'screen'
}

/** ownedDomains 한 줄(「site.example」 · 「https://www.site.example/」)의 호스트 — articlePhotos.ts isOwnedPhotoHost와 같은 정리. */
function ownedHost(raw: string): string {
  return raw.trim().toLowerCase().replace(/^https?:\/\//, '').split(/[/?#:]/)[0]!.replace(/^www\./, '').replace(/\.$/, '')
}

/** 브랜드의 화면 프로필 — 자사 사이트(ownedDomains)에 프로필 호스트가 그대로 있을 때만(하위 도메인으로 넓히지 않는다). 없으면 null. */
export function screenProfileFor(ownedDomains: readonly string[] | undefined): ScreenProfile | null {
  const owned = new Set((ownedDomains ?? []).map(ownedHost).filter(Boolean))
  return SCREEN_PROFILES.find((p) => owned.has(p.host)) ?? null
}

/** 프로필에서 화면 · 변형을 찾는다. 없으면 null. */
export function findScreenVariant(profile: ScreenProfile, screenId: unknown, variantId: unknown): { screen: ScreenDef; variant: ScreenVariant } | null {
  const screen = profile.screens.find((s) => s.id === screenId)
  const variant = screen?.variants.find((v) => v.id === variantId)
  return screen && variant ? { screen, variant } : null
}

/** 자사 화면 사진(origin screen)의 화면 · 변형 — 브랜드 프로필에 없으면 null. */
export function screenOfPick(
  pick: Pick<PhotoPick, 'origin' | 'screenId' | 'variantId'>,
  ownedDomains: readonly string[] | undefined,
): { screen: ScreenDef; variant: ScreenVariant } | null {
  if (pick.origin !== 'screen') return null
  const profile = screenProfileFor(ownedDomains)
  return profile ? findScreenVariant(profile, pick.screenId, pick.variantId) : null
}

/** 찍을 주소 — https · 프로필 호스트. */
export function screenUrl(profile: ScreenProfile, variant: ScreenVariant): string {
  return new URL(variant.path, `https://${profile.host}/`).href
}

/**
 * 자사 화면의 대체 텍스트 — 화면 이름만(「군산각 웹사이트 'AI 코스 만들기' 화면」). 사진 자리의 장면 글자(「박물관 위치가 표시된」)를
 * 쓰면 화면에 실제로 없는 사실이 나갈 수 있다.
 */
export function screenAlt(brandName: string, screen: Pick<ScreenDef, 'label'>): string {
  return `${brandName} 웹사이트 '${screen.label}' 화면`
}
