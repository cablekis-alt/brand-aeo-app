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
  /**
   * 이 변형이 보여 주는 권역의 이름 · 장소(지도 권역 변형) — 자리 글자에 이 가운데 하나가 나오면 이 변형만 쓴다(원도심 장소를 말하는 지도
   * 자리에는 #r-원도심만 — screenVariantChoice). 띄어쓰기 · 문장부호는 무시하고 맞춘다.
   */
  places?: readonly string[]
  /** 자리 글자가 이 조건을 말하면(「아이」 · 「부모님」) 이 변형을 먼저 쓴다(코스 조건 변형 — screenVariantChoice). */
  prefer?: RegExp
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

function gunsanRegion(name: string, places: readonly string[], label = name): ScreenVariant {
  return { id: `r-${name}`, label, path: `/map/#r-${name}`, scrollTo: '.map-grid', activateFragmentLink: true, places }
}

/**
 * 군산각 지도 권역의 이름 · 장소 — 사이트 /map/의 권역별 장소 목록(2026-11-04)에서 글에 나올 만한 관광지만 골랐다(식당 · 숙소 · 짧은 이름은
 * 뺐다 — 「달」 · 「하늘」 같은 이름은 아무 글에나 걸린다). 여기 없는 장소가 자리에 나오면 그 지도 자리는 전체 지도만 쓴다(screenVariantChoice).
 */
const GUNSAN_REGION_PLACES = {
  원도심: [
    '원도심', '구도심', '시간여행', '근대역사박물관', '근대미술관', '근대건축관', '군산세관', '장미갤러리', '호남관세박물관', '진포해양공원',
    '테디베어박물관', '초원사진관', '동국사', '신흥동', '일본식 가옥', '히로쓰', '경암동', '철길마을', '월명공원', '월명호수', '해망굴', '이성당',
    '말랭이마을', '우체통거리', '영화의 거리', '평화박물관', '이영춘 가옥', '군산역사관', '동백대교', '월명동', '영화동', '장미동',
  ],
  은파: ['은파', '물빛다리', '청암산', '군산호수', '은적사', '옥구향교'],
  고군산: ['고군산', '선유도', '장자도', '대장도', '대장봉', '무녀도', '신시도', '관리도', '방축도', '야미도', '선유대교', '장자교'],
  금강: ['금강', '하구둑', '철새', '나포', '채만식', '임피', '발산리', '오성산', '진포대첩', '진포시비'],
  '새만금-비응': ['새만금', '비응', '어린이랜드', '생말공원', '어린이교통공원'],
} as const satisfies Record<string, readonly string[]>

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
          { id: 'kids', label: '아이와', path: '/plan/?with=kids&kids=7', scrollTo: GUNSAN_COURSE_STEP, prefer: /아이(?!보리|콘|디어|스|폰|템)|어린이|자녀/ },
          { id: 'parents', label: '부모님', path: '/plan/?with=parents&adults=3&seniors=2', scrollTo: GUNSAN_COURSE_STEP, prefer: /부모님|어르신|효도/ },
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
          gunsanRegion('원도심', GUNSAN_REGION_PLACES.원도심),
          gunsanRegion('은파', GUNSAN_REGION_PLACES.은파),
          gunsanRegion('고군산', GUNSAN_REGION_PLACES.고군산),
          gunsanRegion('금강', GUNSAN_REGION_PLACES.금강),
          gunsanRegion('새만금-비응', GUNSAN_REGION_PLACES['새만금-비응'], '새만금·비응'),
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

/**
 * 내보내도 되는 자사 화면 사진인가 — 앱 주소 모양이 맞고, 어느 프로필에 그 화면 · 변형이 글에 넣는 종류(SCREEN_AUTO_SAVE_KINDS)로 있을 때만.
 * 서버가 지도 화면을 저장하지 않지만(결정 4), 내보내기(src/lib/articlePhotos.ts placePhotos)도 한 번 더 막는다.
 */
export function screenExportable(p: Pick<PhotoPick, 'src' | 'origin' | 'screenId' | 'variantId'>): boolean {
  if (p.origin !== 'screen' || !parseScreenAppSrc(p.src)) return false
  return SCREEN_PROFILES.some((profile) => {
    const found = findScreenVariant(profile, p.screenId, p.variantId)
    return found !== null && screenSaveAllowed(found.screen.kind)
  })
}

// ── 화면 자리 판정(src/lib/photoAutoPick.ts 자사 화면 단계) ──────────────────────────────────────────

/** 비교용 글자 — 띄어쓰기 · 따옴표 · 문장부호를 걷고 소문자로(「'AI 코스 만들기'」 → 「ai코스만들기」). */
function textKey(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** 「화면」이 없어도 화면 자리인 낱말 — 검색 결과 · 캡처 · 스크린샷은 사진일 수 없다. */
const SCREEN_ALWAYS = /검색\s?결과|스크린\s?샷|캡처|캡쳐/
/** 「화면」과 함께 있으면 화면 자리 — 웹사이트 · 홈페이지 · 사이트 · 앱(2026-11-04 계획 5절). */
const SITE_WORD = /웹\s?사이트|홈\s?페이지|사이트|앱|어플/
/** 다른 회사 · 기기의 화면 — 화면 자리로 보되 찍지 않는다(네이버 지도 · 휴대폰 지도 앱 · 네이버 플레이스 예약 화면). */
const OTHER_SCREEN = /네이버|카카오|구글|티맵|인스타그램|유튜브|플레이스|휴대폰|핸드폰|스마트폰|모바일|태블릿/
/**
 * 누르거나 결과를 받아야 보이는 화면 — 사이트에 없는 동작이거나 운영 사이트의 AI 호출이 필요해 사람이 찍는다. 조건을 고르는 것(「조건을
 * 선택한」 · 「조건 선택 화면」)은 주소로 미리 채우는 코스 화면이라 아니다.
 */
const ACTION_SCREEN = /눌러|누른|누르|클릭|터치|(?<!조건을?\s?)선택(해|한|하면)|결과\s?화면|결과가|결과를/

/** 프로필 표의 화면 이름(「AI 코스 만들기」 · 「지도에서 찾기」) 가운데 글자에 나온 것. */
function labelsIn(text: string, profiles: readonly ScreenProfile[]): ScreenDef[] {
  const t = textKey(text)
  return profiles.flatMap((p) => p.screens.filter((s) => t.includes(textKey(s.label))))
}

/**
 * 웹사이트 화면 자리인가 — 사진이 아니라 화면 캡처가 맞는 자리. 「화면」만으로는 보지 않는다(「한 화면에 담긴 장면」 · 「대형 화면이 걸린
 * 카페」는 사진 자리다). 「화면」과 함께 웹사이트 · 홈페이지 · 사이트 · 앱, 프로필 표의 화면 이름(「군산각 '지도에서 찾기' 화면」), 다른
 * 회사 · 기기 낱말(「네이버 플레이스 예약 화면」), 누르기 · 결과 낱말(「코스 결과 화면에서 한 장소를 눌러」)이 있을 때 — 뒤의 둘은 찍지 않고
 * 비워 둔다 — 그리고 검색 결과 · 캡처 · 스크린샷이면 화면 자리다. 「사이트」 · 「앱」 · 「스크린」만 있는 자리(「캠핑 사이트」 · 「스크린
 * 골프장」)는 사진 자리다.
 */
export function isScreenSlotText(text: string): boolean {
  const t = text.normalize('NFC')
  if (SCREEN_ALWAYS.test(t)) return true
  if (!t.includes('화면')) return false
  return SITE_WORD.test(t) || OTHER_SCREEN.test(t) || ACTION_SCREEN.test(t) || labelsIn(t, SCREEN_PROFILES).length > 0
}

/**
 * 화면 자리의 종류 — course 코스 화면 · map 지도 화면(프로필 표의 화면 이름이 장면 글자에 정확히 하나 있을 때), 그 밖에는 찍지 않는다:
 * other 다른 회사 · 기기 화면, action 누르거나 결과를 받아야 보이는 화면, none 브랜드에 찍을 화면 목록(프로필)이 없음, ambiguous 화면
 * 이름이 둘 이상, unrelated 목록에 없는 화면(「아이와 함께 안내」 · 장소 상세 · 브랜드와 무관한 사이트).
 */
export type ScreenSlotKind = ScreenKind | 'other' | 'action' | 'none' | 'ambiguous' | 'unrelated'

export const SCREEN_SLOT_KIND_TEXT: Record<ScreenSlotKind, string> = {
  course: '코스 화면',
  map: '지도 화면',
  other: '다른 회사 · 휴대폰 화면',
  action: '누르거나 결과를 받아야 보이는 화면',
  none: '이 브랜드는 찍을 화면이 없음',
  ambiguous: '화면 이름이 둘 이상',
  unrelated: '찍을 화면 목록에 없는 화면',
}

/**
 * 화면 자리 하나(장면 글자)의 종류와 그 화면 — 설명 줄은 보지 않는다(「AI 코스 만들기」 자리의 설명이 「지도에서 찾기로 …」를 말하기도 한다).
 * profile은 브랜드의 화면 프로필(screenProfileFor) — 없으면 none.
 */
export function screenKindOf(text: string, profile: ScreenProfile | null): { kind: ScreenSlotKind; screen?: ScreenDef } {
  const t = text.normalize('NFC')
  if (OTHER_SCREEN.test(t)) return { kind: 'other' }
  if (ACTION_SCREEN.test(t)) return { kind: 'action' }
  if (!profile) return { kind: 'none' }
  const found = labelsIn(t, [profile])
  if (found.length > 1) return { kind: 'ambiguous' }
  return found[0] ? { kind: found[0].kind, screen: found[0] } : { kind: 'unrelated' }
}

/**
 * 화면 자리에 쓸 변형 — 묶음(tiers) 앞부터, 묶음 안에서는 브랜드에서 덜 쓴 변형을 고른다(같으면 표 순서 — photoAutoPick.ts가 고른다).
 * - 권역 변형이 있는 화면(지도): 장면 글자에 한 권역의 이름 · 장소만 나오면 그 권역만(by region — 원도심 장소를 말하는 지도 자리에는
 *   #r-원도심만). 권역이 둘 이상이거나, 장소 사전의 장소(namedPlaces — 장면 글자에 나온 장소)가 어느 권역 목록에도 없으면 전체 지도만
 *   (by named — 그 장소가 안 보이는 권역 지도를 넣지 않게).
 * - 조건 변형이 있는 화면(코스): 장면 글자가 「아이」 · 「부모님」을 말하면 그 변형 다음 기본 변형(by prefer — 다른 조건 변형은 쓰지 않는다).
 * - 그 밖에는 모든 변형.
 */
export interface ScreenVariantChoice {
  tiers: ScreenVariant[][]
  by?: 'region' | 'named' | 'prefer'
}

export function screenVariantChoice(screen: ScreenDef, text: string, namedPlaces: readonly string[] = []): ScreenVariantChoice {
  const general = screen.variants.filter((v) => !v.places?.length && !v.prefer)
  const base = general.length ? general : [...screen.variants]
  const regional = screen.variants.filter((v) => v.places?.length)
  if (regional.length) {
    const t = textKey(text)
    const hits = regional.filter((v) => v.places!.some((p) => t.includes(textKey(p))))
    const unknown = namedPlaces.filter((name) => !regional.some((v) => v.places!.some((p) => textKey(name).includes(textKey(p)))))
    if (hits.length === 1 && !unknown.length) return { tiers: [hits], by: 'region' }
    if (hits.length > 1 || unknown.length) return { tiers: [base], by: 'named' }
  }
  const norm = text.normalize('NFC')
  const preferred = screen.variants.filter((v) => v.prefer?.test(norm))
  if (preferred.length) return { tiers: [preferred, base.filter((v) => !preferred.includes(v))].filter((tier) => tier.length > 0), by: 'prefer' }
  return { tiers: [[...screen.variants]] }
}
