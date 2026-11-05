/**
 * 홈페이지 사진으로 글의 사진 자리 채우기 — 고른 사진을 발행본의 `![장면](#image-slot)` 줄에 끼워 넣는다.
 *
 * 사진 주소는 본문(초안 · 고친 글 · 빈칸 기록)에 넣지 않는다. 넣으면 본문 지문(sourceKeyOf)이 바뀌어 다듬어 둔 채널 글이 전부
 * 「원문 바뀜」이 되고, 사실 가드가 주소 속 숫자를 지어낸 숫자로 읽어 사진 줄을 지울 수 있다. 글 끝 안내처럼 복사 · .md ·
 * .html로 내보내는 순간에만 넣는다(src/lib/publishArticle.ts publishArticleParts).
 *
 * 서버(server/contentDraft.ts · server/index.ts)도 같은 검사를 쓰므로 DOM을 쓰는 모듈은 import하지 않는다 — 서버 타입 검사는 DOM이 없다
 * (src/lib/screenCapture.ts는 DOM 없이 자사 화면의 앱 주소만 본다).
 */
import { MAP_CREDIT, mapCaptionLines, mapPickExportable } from './mapImage.js'
import { parseOwnerPhotoAppSrc } from './ownerPhotos.js'
import { screenExportable } from './screenCapture.js'

/** 사람이 고른 사진 하나 — 초안별로 저장한다(server/contentDraft.ts StoredDraft.photos). */
export interface PhotoPick {
  /** 짝지을 사진 자리 — 그 자리 대체 텍스트(normSlotAlt). */
  slot: string
  /** 같은 대체 텍스트가 여러 자리에 있을 때 몇 번째 자리인가(1부터). */
  nth: number
  /** 고를 때 같은 대체 텍스트를 가진 자리 수 — 지금도 같으면 nth로 찾는다(절이 빠지거나 늘면 nth를 믿지 않는다). */
  same: number
  /** 고를 때 그 자리 위 소제목(번호를 뗀 글자). */
  heading: string
  /** 사진 주소 — https(canonicalPhotoSrc). 자사 화면(origin 'screen')이면 앱 주소 /api/screens/<tenant>/<id>.png(src/lib/screenCapture.ts screenAppSrc). */
  src: string
  /** 사진의 대체 텍스트 — 사이트가 단 장면 설명(서버가 사실 가드로 거른 것). 비면 사진 자리 글자를 쓴다. */
  alt: string
  /** 사진을 찾은 페이지. */
  pageUrl: string
  /** 사람이 이 사진을 이 자리에 넣기로 확인한 때(서버 시각). 없으면 넣지 않는다. 자동 채우기는 운영자가 미리보기를 보고 저장한 때. */
  confirmedAt: string
  /**
   * 자동 채우기(src/lib/photoAutoPick.ts)가 고른 사진. 사람이 고르거나 바꾸면 이 표시가 없는 사진이 되고, 자동 채우기는 사진이 있는
   * 자리를 덮지 않는다. 없으면 사람이 고른 사진(옛 기록 포함).
   */
  auto?: true
  /**
   * 사진이 어디서 왔나 — 'public'은 출처 표시가 필요한 공공 사진(자사 사이트 장소 페이지의 공공누리 제1유형 사진). 없으면 홈페이지
   * 사진(옛 기록 포함). 공공 사진은 license · credit · creditUrl이 모두 있어야 넣는다(publicPhotoProblem). 'site'는 공공 사진 호스트의
   * 주소지만 브랜드 자사 사이트(ownedDomains)의 사진이라고 서버가 고를 때 확인한 홈페이지 사진(자사 사이트가 visitkorea.or.kr · go.kr인
   * 브랜드) — 화면이 보낸 'site'는 믿지 않고 서버만 단다. 'screen'은 운영자 PC에 찍어 둔 자사 사이트 화면(src/lib/screenCapture.ts) —
   * 서버가 screens.json에서 찾아 src · pageUrl · alt · screenId · variantId · capturedAt을 단다(화면이 보낸 주소는 믿지 않는다).
   * 'osm-map'은 앱이 OSM 데이터로 그린 군산 지도(src/lib/mapImage.ts) — 서버가 maps.json에서 찾아 src(앱 주소 /api/maps/<tenant>/<id>.png) ·
   * pageUrl(장소 목록 출처) · alt(「군산 지도 — … 위치」) · caption · credit · mapId · mapVariant를 단다.
   * 'owner'는 운영자 PC의 업주 사진 보관함에 올린 업주(자기 시설) 사진(src/lib/ownerPhotos.ts) — 서버가 owner-photos.json에서 찾아 src(앱 주소
   * /api/owner-photos/<tenant>/<id>.<ext>) · alt(올릴 때 적은 설명) · pageUrl(브랜드 페이지) · ownerPhotoId를 단다.
   */
  origin?: PhotoOrigin
  /** 자사 화면의 화면 id(src/lib/screenCapture.ts 프로필 표). origin 'screen'에만. */
  screenId?: string
  /** 자사 화면의 변형 id. origin 'screen'에만. */
  variantId?: string
  /** 자사 화면을 찍은 때(screens.json capturedAt). origin 'screen'에만. */
  capturedAt?: string
  /** 업주 사진의 id(src/lib/ownerPhotos.ts — 파일 sha256 앞 16자). origin 'owner'에만. */
  ownerPhotoId?: string
  /** 앱이 그린 지도의 id(maps.json — 그림 이름). origin 'osm-map'에만. */
  mapId?: string
  /** 앱이 그린 지도의 장소 묶음(src/lib/mapImage.ts mapVariantKey) — 반복 상한의 열쇠. origin 'osm-map'에만. */
  mapVariant?: string
  /**
   * 앱이 그린 지도의 설명 문장(「A · B 위치를 지도에 표시했습니다.」) — 넣을 때 사진 자리 바로 아랫줄 설명(사이트 기능 문장)을 이 문장 +
   * 출처 줄로 바꾼다(글의 자리 글자는 고치지 않는다). origin 'osm-map'에만.
   */
  caption?: string
  /** 공공 사진의 이용 허락 — 공공누리 제1유형만 받는다(PHOTO_LICENSES). */
  license?: PhotoLicense
  /** 공공 사진의 출처(저작권자) — 사이트 구조화 데이터의 creditText(예: 「한국관광공사」). 앱이 그린 지도는 OSM 출처 줄(MAP_CREDIT). */
  credit?: string
  /** 공공 사진의 이용 허락 페이지 — PHOTO_LICENSES[license].url과 같아야 한다. */
  creditUrl?: string
}

/** 사진 자리 하나의 열쇠 — 장면 글자 · 몇 번째 · 소제목. */
export type PhotoPlace = Pick<PhotoPick, 'slot' | 'nth' | 'heading'>

/**
 * 사람이 사진을 뺀 자리(StoredDraft.photoCleared) — 뺀 사진 주소(removed, 오래된 것부터)도 적는다. 「사람이 뺀 자리도 다시 채우기」가 그
 * 사진을 다시 고르지 않게. 옛 기록에는 removed가 없다(그때는 막을 사진을 모른다). 자사 화면은 주소 대신 「화면 + 변형」 열쇠
 * (src/lib/screenCapture.ts photoRepeatKey — screen:<screenId>:<variantId>)를 적는다 — 다른 날 다시 찍은 같은 화면도 막게.
 */
export interface ClearedPhotoPlace extends PhotoPlace {
  removed?: string[]
  /**
   * 사람이 「이 자리 빼기」로 사진 없이 내보내기로 한 자리(2026-11-05 결정 D5(d)) — 내보낼 때 사진 자리 줄을 빼고(본문은 고치지 않는다 — 채널
   * 글이 「원문 바뀜」이 되지 않게), 자동 채우기는 「사람이 뺀 자리도 다시 채우기」를 켜도 채우지 않는다. 바로 아랫줄 설명은 글로 남는다.
   */
  drop?: true
}

/** 내보내기에서 뺄 사진 자리 — 사람이 뺀 자리(dropped — ClearedPhotoPlace.drop)와, empty면 사진을 넣지 못한 모든 자리. */
export interface PhotoSlotDrops {
  dropped?: readonly ClearedPhotoPlace[]
  empty?: boolean
}

/** 이 자리가 사람이 「이 자리 빼기」로 뺀 자리인가(clearedMatches — 넉넉하게). */
export function slotDropped(slot: PhotoPlace, cleared: readonly ClearedPhotoPlace[] | undefined): boolean {
  return Boolean(cleared?.some((c) => c.drop && clearedMatches(c, slot)))
}

/** 한 자리에 적어 두는 뺀 사진 주소의 최대 수. */
export const MAX_REMOVED_SRCS = 10

/** 사람이 뺀 기록이 이 자리의 것인가 — 장면 글자가 같고 소제목이나 몇 번째가 같으면(넉넉하게 본다 — 다시 채우는 것보다 비워 두는 편이 낫다). */
export function clearedMatches(c: PhotoPlace, place: PhotoPlace): boolean {
  return c.slot === place.slot && (c.heading === place.heading || c.nth === place.nth)
}

export type PhotoOrigin = 'site' | 'public' | 'screen' | 'osm-map' | 'owner'

/**
 * 받는 공공 사진의 이용 허락 — 공공누리 제1유형(출처 표시 · 상업 이용 · 변경 가능)만. 제2유형(상업 이용 금지) · 제3유형(변경 금지) ·
 * 제4유형과 유형을 모르는 사진은 넣지 않는다(2026-11-03 결정).
 */
export const PHOTO_LICENSES = {
  'kogl-1': { name: '공공누리 제1유형', url: 'https://www.kogl.or.kr/info/licenseType1.do' },
} as const
export type PhotoLicense = keyof typeof PHOTO_LICENSES

/** 공공 사진의 출처 · 이용 허락 — PhotoPick에 함께 저장한다. */
export type PublicPhotoFields = Required<Pick<PhotoPick, 'origin' | 'license' | 'credit' | 'creditUrl'>>

/** 출처에 쓰지 않는 말 — 공공누리는 공공기관이 후원하거나 특별한 관계인 것처럼 보이게 하는 표시를 금지한다. */
const CREDIT_FORBIDDEN = /제공|협찬|후원|공식|인증|추천/
const CREDIT_MAX = 60

/** 공공누리 이용 허락 주소의 유형(1~4) — kogl.or.kr의 /info/licenseType{n}.do만 읽는다. 아니면 null(유형 모름). */
export function koglTypeOf(raw: unknown): 1 | 2 | 3 | 4 | null {
  if (typeof raw !== 'string') return null
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase()
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || (host !== 'kogl.or.kr' && host !== 'www.kogl.or.kr')) return null
  const m = /^\/info\/licenseType([1-4])\.do$/i.exec(url.pathname)
  return m ? (Number(m[1]) as 1 | 2 | 3 | 4) : null
}

/** 출처 글자 정리 — 사진 설명과 같은 정리(cleanPhotoAlt)에 60자. 출처에 쓰지 않는 말(제공 · 협찬 · 공식 …)이 있으면 ''. */
export function cleanPhotoCredit(raw: unknown): string {
  const s = cleanPhotoAlt(typeof raw === 'string' ? raw : '').replace(/[()*_`]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!s || s.length > CREDIT_MAX || CREDIT_FORBIDDEN.test(s)) return ''
  return s
}

/**
 * 공공 사진 표시를 고른다 — origin 'public' · 허용한 유형 · 출처 글자 · 그 유형의 이용 허락 주소가 모두 맞으면 저장할 모양, 아니면
 * 이유(글자). origin이 'public'이 아니면 null(홈페이지 사진). 서버(사진 PUT)와 화면이 같은 검사를 쓴다.
 */
export function publicPhotoFields(raw: { origin?: unknown; license?: unknown; credit?: unknown; creditUrl?: unknown }): PublicPhotoFields | string | null {
  if (raw.origin !== 'public') return null
  const license = typeof raw.license === 'string' && Object.hasOwn(PHOTO_LICENSES, raw.license) ? (raw.license as PhotoLicense) : null
  if (!license) return '공공누리 제1유형 사진만 쓸 수 있어요.'
  const credit = cleanPhotoCredit(raw.credit)
  if (!credit) return '공공 사진의 출처(저작권자)가 없거나 쓸 수 없는 말이 들어 있어요.'
  if (raw.creditUrl !== PHOTO_LICENSES[license].url) return '공공 사진의 이용 허락 주소가 유형과 맞지 않아요.'
  return { origin: 'public', license, credit, creditUrl: PHOTO_LICENSES[license].url }
}

/** 출처 표시가 필요한 공공 사진의 호스트(공공누리 · 한국관광공사 · 정부 기관). */
const CREDIT_HOSTS = ['visitkorea.or.kr', 'knto.or.kr', 'kogl.or.kr', 'go.kr']

function hostOf(src: string): string | null {
  try {
    return new URL(src).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** 브랜드 자사 사이트(ownedDomains — 「site.example」 · 「https://site.example/」 모양)의 사진 주소인가 — 그 호스트이거나 그 하위 도메인. */
export function isOwnedPhotoHost(src: string, ownedDomains: readonly string[] | undefined): boolean {
  const host = hostOf(src)
  if (!host) return false
  return (ownedDomains ?? []).some((raw) => {
    const d = raw.trim().toLowerCase().replace(/^https?:\/\//, '').split(/[/?#:]/)[0]!.replace(/^www\./, '').replace(/\.$/, '')
    return Boolean(d) && (host === d || host.endsWith(`.${d}`))
  })
}

/**
 * 출처 표시가 필요한 공공 사진의 주소인가 — 호스트로 본다. 브랜드 자사 사이트(ownedDomains)의 사진이면 아니다: 자사 사이트가
 * 공공 사진 호스트(korean.visitkorea.or.kr · tour.jb.go.kr)인 브랜드는 자기 홈페이지 사진을 홈페이지 사진으로 쓴다.
 */
export function needsPhotoCredit(src: string, ownedDomains?: readonly string[]): boolean {
  const host = hostOf(src)
  if (!host || isOwnedPhotoHost(src, ownedDomains)) return false
  return CREDIT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
}

/**
 * 고른 사진의 출처 상태 — site 홈페이지 사진 · public 출처가 맞는 공공 사진 · missing 출처 표시가 필요한데 없거나 틀림(공공 사진
 * 호스트의 사진을 출처 없이 골랐다). missing은 내보내지 않는다 — 지우지는 않고 「출처 없음」으로 알린다. origin 'site'는 서버가 자사
 * 사이트 사진으로 확인한 사진이다.
 */
export function photoCreditState(p: Pick<PhotoPick, 'src' | 'origin' | 'license' | 'credit' | 'creditUrl'>): 'site' | 'public' | 'missing' {
  if (p.origin === 'public') return typeof publicPhotoFields(p) === 'object' ? 'public' : 'missing'
  // 앱이 그린 지도(origin osm-map)는 OSM 출처 줄이 이용 조건이다 — 출처 줄이 맞을 때만 내보낸다(넣을 때 그림 바로 아래에 붙는다).
  if (p.origin === 'osm-map') return p.credit === MAP_CREDIT ? 'site' : 'missing'
  // 자사 화면(origin screen — 운영자 PC에 찍어 둔 자사 사이트 화면)은 출처 표시가 필요 없다 — 홈페이지 사진과 같다.
  // 업주 사진(origin owner — 권리 확인을 받고 올린 자기 시설 사진)도 출처 표시가 필요 없다.
  if (p.origin === 'site' || p.origin === 'screen' || p.origin === 'owner') return 'site'
  return needsPhotoCredit(p.src) ? 'missing' : 'site'
}

/** 사진 바로 아래에 붙는 출처 — 「사진: 한국관광공사, [공공누리 제1유형](주소)」. 출처가 맞지 않으면 ''. */
export function photoCreditLine(p: Pick<PhotoPick, 'origin' | 'license' | 'credit' | 'creditUrl'>): string {
  const f = publicPhotoFields(p)
  if (!f || typeof f === 'string') return ''
  return `사진: ${f.credit}, [${PHOTO_LICENSES[f.license].name}](${f.creditUrl})`
}

/** 글에 실제로 들어간 사진 — .html의 JSON-LD image · og:image, 「사진 N장 받기」가 쓴다. */
export interface AppliedPhoto {
  src: string
  alt: string
  heading: string
  /** 원래 사진 자리 글자(파일 이름 · 안내에 쓴다). */
  slotAlt: string
  /** 고른 사진의 자리 열쇠 — 「사진 N장 받기」가 이것으로 그 사진 파일을 청한다. */
  place: Pick<PhotoPick, 'slot' | 'nth' | 'heading'>
  /** 공공 사진의 출처 · 이용 허락 — .html의 JSON-LD ImageObject와 묶음의 「00-사진 출처.txt」가 쓴다. 홈페이지 사진이면 없다. */
  credit?: PublicPhotoFields
  /** 사진을 찾은 페이지(PhotoPick.pageUrl). */
  pageUrl?: string
  /** 사람이 넣기로 확인한(자동이면 저장한) 때. */
  confirmedAt?: string
  /**
   * 자사 화면(origin screen) — src는 앱 주소(/api/screens/<tenant>/<id>.png)라 앱 밖으로 그대로 나가면 안 된다: .html · 서식째 복사는
   * src/lib/screenExport.ts가 그림을 문서 안(data:)에 넣고, JSON-LD image · og:image에는 넣지 않는다(공개된 절대 주소가 아니다).
   */
  screen?: Required<Pick<PhotoPick, 'screenId' | 'variantId'>> & Pick<PhotoPick, 'capturedAt'>
  /**
   * 앱이 그린 지도(origin osm-map) — src는 앱 주소(/api/maps/<tenant>/<id>.png)라 자사 화면처럼 내보낼 때 문서 안에 넣고 JSON-LD image ·
   * og:image에는 넣지 않는다. credit은 그림 바로 아래 설명 줄에 붙은 OSM 출처 줄(「사진 출처」 파일에도 적는다).
   */
  map?: { mapId: string; variant: string; credit: string }
  /**
   * 업주 사진(origin owner) — src는 앱 주소(/api/owner-photos/<tenant>/<id>.<ext>)라 자사 화면처럼 내보낼 때 문서 안에 넣고 JSON-LD image ·
   * og:image에는 넣지 않는다(공개된 절대 주소가 아니다).
   */
  owner?: { id: string }
}

export const PHOTO_LIMITS = { picks: 3, alt: 160, src: 2048 } as const

/** 사진 자리 줄 — src/lib/markdownFile.ts IMAGE_SLOT_LINE과 같은 모양(그쪽은 DOM을 써서 서버가 가져올 수 없다). */
const SLOT_LINE = /^!\[([^\]]*)\]\(#image-slot\)$/
const HEADING_LINE = /^##\s+(.+)$/

/** 사진 자리 글자 비교용 — 유니코드 정규화와 공백 한 칸. */
export function normSlotAlt(s: string): string {
  return s.normalize('NFC').replace(/\s+/g, ' ').trim()
}

/** 소제목 글자 — 「## 3. 제목」의 번호를 뗀다(빈 절을 빼면 번호가 바뀐다). */
function headingText(line: string): string {
  return normSlotAlt(line.replace(/^##\s+/, '').replace(/^\d+\.\s+/, ''))
}

/** 사진 대체 텍스트 정리 — 제어 문자 · 줄바꿈 · 대괄호 · 역슬래시(닫는 대괄호를 글자로 만든다)를 걷고 160자까지(마크다운 이미지 문법이 깨지지 않게). */
export function cleanPhotoAlt(s: string): string {
  const visible = Array.from(s, (ch) => {
    const code = ch.codePointAt(0)!
    return code < 0x20 || code === 0x7f || ch === '[' || ch === ']' || ch === '\\' ? ' ' : ch
  }).join('')
  return visible
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PHOTO_LIMITS.alt)
    .trim()
}

/**
 * 사진 주소를 마크다운에 넣을 수 있는 https 주소로 — 아니면 null. 공백 · 한글 파일명은 인코딩하고(국내 호스팅의 「객실 1.jpg」),
 * 이미지 문법을 깨는 괄호 · 별표 · 백틱도 인코딩한다(htmlFile.ts IMAGE_LINE은 `)`와 공백에서 주소를 끊는다).
 * http · 계정 정보 · 443이 아닌 포트 · 2048자를 넘는 주소는 받지 않는다.
 */
export function canonicalPhotoSrc(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null
  url.hash = ''
  const href = url.href.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\*/g, '%2A').replace(/`/g, '%60')
  return href.length <= PHOTO_LIMITS.src ? href : null
}

/**
 * 고른 사진을 글에 넣을 주소 — 사진은 https(canonicalPhotoSrc). 자사 화면(origin screen)은 앱 주소(/api/screens/<tenant>/<id>.png) 그대로 —
 * 모양이 맞고 글에 넣는 종류의 화면일 때만(src/lib/screenCapture.ts screenExportable — 지도 화면은 넣지 않는다). 아니면 null(넣지 않는다).
 * canonicalPhotoSrc는 https만 받는 그대로 둔다 — 서버가 화면이 보낸 사진 주소를 거르는 데 쓴다(앱 주소는 서버가 screens.json에서 단다).
 * 앱이 그린 지도(origin osm-map)도 앱 주소 그대로 — 주소 · 지도 id · 변형 열쇠가 맞을 때만(src/lib/mapImage.ts mapPickExportable).
 */
export function photoPickSrc(p: Pick<PhotoPick, 'src' | 'origin' | 'screenId' | 'variantId' | 'mapId' | 'mapVariant' | 'ownerPhotoId'>): string | null {
  if (p.origin === 'screen') return screenExportable(p) ? p.src : null
  // 업주 사진 — 앱 주소 그대로, 주소의 id가 사진 기록의 id와 같을 때만(src/lib/ownerPhotos.ts).
  if (p.origin === 'owner') return parseOwnerPhotoAppSrc(p.src)?.id === p.ownerPhotoId && p.ownerPhotoId ? p.src : null
  if (p.origin === 'osm-map') return mapPickExportable(p) ? p.src : null
  return canonicalPhotoSrc(p.src)
}

/** 글 안의 사진 자리 하나. */
export interface PhotoSlot {
  /** 줄 번호(0부터). */
  line: number
  /** 원래 대체 텍스트. */
  alt: string
  /** normSlotAlt(alt). */
  key: string
  /** 같은 key 가운데 몇 번째(1부터). */
  nth: number
  /** 같은 key를 가진 자리 수. */
  same: number
  /** 그 자리 위 소제목(번호를 뗀 글자). 소제목 전이면 ''. */
  heading: string
}

/** 글의 사진 자리 — 한 줄 전체가 `![…](#image-slot)`인 줄(countImageSlots와 같은 판정). */
export function photoSlotsOf(markdown: string): PhotoSlot[] {
  const slots: PhotoSlot[] = []
  let heading = ''
  markdown.split('\n').forEach((raw, line) => {
    const t = raw.trim()
    const h = HEADING_LINE.exec(t)
    if (h) {
      heading = headingText(t)
      return
    }
    const m = SLOT_LINE.exec(t)
    if (!m) return
    const key = normSlotAlt(m[1]!)
    slots.push({ line, alt: m[1]!, key, nth: slots.filter((s) => s.key === key).length + 1, same: 0, heading })
  })
  for (const s of slots) s.same = slots.filter((o) => o.key === s.key).length
  return slots
}

export interface PhotoMatch {
  /** 자리를 찾아 넣을 사진. */
  applied: { pick: PhotoPick; slot: PhotoSlot }[]
  /** 확실하지 않아 넣지 않은 사진 — 「이 자리로 옮기기」로 사람에게 다시 묻는다(소제목이나 장면 글자만 맞는다). */
  suggested: { pick: PhotoPick; slot: PhotoSlot }[]
  /** 자리를 찾지 못한 사진 — 넣지 않는다(엉뚱한 절에 들어가지 않게). */
  unmatched: PhotoPick[]
}

/**
 * 고른 사진을 지금 글의 사진 자리와 짝짓는다. 확인(confirmedAt)이 없는 사진은 보지 않는다.
 * ① 장면 글자와 소제목이 모두 같은 자리가 하나뿐이면 그 자리.
 * ② 같은 장면 글자의 자리 수가 고를 때와 같으면 nth 번째 자리(소제목만 고쳤다).
 * 그 밖에는 넣지 않는다 — 같은 소제목 아래 빈 자리가 하나뿐이거나 같은 장면 글자의 빈 자리가 있으면 그 자리를 제안한다.
 * 한 자리에는 사진 하나. ①을 모든 사진에 먼저 주고 ②는 남은 자리에만 — 고른 순서에 따라 정확히 맞는 사진의 자리를 다른 사진이
 * ②로 먼저 가져가 두 사진이 서로 바뀌지 않게.
 */
export function matchPhotos(markdown: string, picks: readonly PhotoPick[]): PhotoMatch {
  const slots = photoSlotsOf(markdown)
  const taken = new Set<number>()
  const result: PhotoMatch = { applied: [], suggested: [], unmatched: [] }
  const free = (s: PhotoSlot) => !taken.has(s.line)
  const confirmed = picks.filter((p) => p.confirmedAt)
  const placed = new Map<PhotoPick, PhotoSlot>()
  const take = (pick: PhotoPick, slot: PhotoSlot | undefined) => {
    if (!slot || !free(slot) || placed.has(pick)) return
    taken.add(slot.line)
    placed.set(pick, slot)
  }
  for (const pick of confirmed) {
    const both = slots.filter((s) => s.key === pick.slot && s.heading === pick.heading)
    if (both.length === 1) take(pick, both[0])
  }
  for (const pick of confirmed) {
    const sameKey = slots.filter((s) => s.key === pick.slot)
    if (sameKey.length === pick.same) take(pick, sameKey[pick.nth - 1])
  }
  const pending: PhotoPick[] = []
  for (const pick of confirmed) {
    const slot = placed.get(pick)
    if (slot) result.applied.push({ pick, slot })
    else pending.push(pick)
  }
  // 제안은 넣은 사진이 다 자리를 잡은 뒤에 — 넣을 사진의 자리를 제안으로 내주지 않는다.
  for (const pick of pending) {
    const underHeading = slots.filter((s) => s.heading === pick.heading && free(s))
    const slot = underHeading.length === 1 ? underHeading[0]! : slots.find((s) => s.key === pick.slot && free(s))
    if (slot) result.suggested.push({ pick, slot })
    else result.unmatched.push(pick)
  }
  return result
}

/**
 * 발행 원고에 고른 사진을 넣는다 — 짝지은 자리 줄만 `![사진 설명](https 주소)`로 바꾸고 바로 아랫줄 `*설명*`은 그대로 둔다
 * (htmlFile.ts가 figure · figcaption으로 낸다). 넣은 사진이 없으면 원고를 그대로(바이트까지 같게) 돌려준다.
 */
export function withPhotos(
  markdown: string,
  picks: readonly PhotoPick[] | undefined,
  drops: PhotoSlotDrops = {},
): { markdown: string; applied: AppliedPhoto[] } {
  const applied = picks?.length ? matchPhotos(markdown, picks).applied : []
  return placePhotos(markdown, applied, dropSlots(photoSlotsOf(markdown), applied, drops))
}

/**
 * 뺄 사진 자리 — 사진을 넣지 않는 자리 가운데 사람이 뺀 자리(drops.dropped)와, drops.empty면 나머지 빈 자리 모두. slotKey는 그 자리를 뺀 기록과
 * 견줄 자리 열쇠(다듬은 글의 자리는 원문 자리의 열쇠 — withPhotosFromSource).
 */
function dropSlots(
  slots: readonly PhotoSlot[],
  applied: readonly { pick: PhotoPick; slot: PhotoSlot }[],
  drops: PhotoSlotDrops,
  placeOf: (s: PhotoSlot) => PhotoPlace | null = (s) => ({ slot: s.key, nth: s.nth, heading: s.heading }),
): PhotoSlot[] {
  if (!drops.empty && !drops.dropped?.some((c) => c.drop)) return []
  // 넣는 사진(placePhotos가 실제로 넣는 것 — 주소가 있고 출처가 맞는 사진)의 자리만 빼지 않는다.
  const filled = new Set(applied.filter((a) => photoPickSrc(a.pick) && photoCreditState(a.pick) !== 'missing').map((a) => a.slot.line))
  return slots.filter((s) => {
    if (filled.has(s.line)) return false
    if (drops.empty) return true
    const place = placeOf(s)
    return place !== null && slotDropped(place, drops.dropped)
  })
}

/** 사진 자리 줄 바로 아랫줄의 설명(`*설명*`) — 없으면 ''. */
function captionAfter(lines: readonly string[], slot: PhotoSlot): string {
  const m = /^\*(?!\*)(.+?)\*$/.exec((lines[slot.line + 1] ?? '').trim())
  return m ? normSlotAlt(m[1]!) : ''
}

/**
 * 다듬은 글(채널 문체)에 고른 사진을 넣는다. 다듬은 글은 소제목을 바꿔 쓰므로 사진을 다듬은 글에서 바로 짝짓지 않는다 — 먼저 다듬기
 * 원문(sourceMarkdown — 다듬은 글을 만든 그 원문이어야 한다)에서 자사 발행본과 같은 규칙으로 자리를 찾고, 그 원문 자리를 다듬은 글의
 * 자리로 옮긴다(mapSlots). 다듬기는 사진 자리 줄과 설명 줄을 원문 글자 그대로 남긴다(server/channelAdapt.ts keepSourceMedia).
 */
export function withPhotosFromSource(
  markdown: string,
  sourceMarkdown: string,
  picks: readonly PhotoPick[] | undefined,
  drops: PhotoSlotDrops = {},
): { markdown: string; applied: AppliedPhoto[] } {
  if (!picks?.length && !drops.empty && !drops.dropped?.some((c) => c.drop)) return { markdown, applied: [] }
  const sourceLines = sourceMarkdown.split('\n')
  const lines = markdown.split('\n')
  const sourceSlots = photoSlotsOf(sourceMarkdown)
  const slots = photoSlotsOf(markdown)
  /** 원문 자리 → 다듬은 글의 자리(확실하지 않으면 undefined). */
  const mapTo = (from: PhotoSlot) =>
    mapSlots(
      sourceSlots.filter((s) => s.key === from.key).map((s) => captionAfter(sourceLines, s)),
      slots.filter((s) => s.key === from.key),
      (s) => captionAfter(lines, s),
    )?.[from.nth - 1]
  const placements: { pick: PhotoPick; slot: PhotoSlot }[] = []
  for (const { pick, slot: from } of picks?.length ? matchPhotos(sourceMarkdown, picks).applied : []) {
    const to = mapTo(from)
    if (to) placements.push({ pick, slot: to })
  }
  // 뺄 자리 — 다듬은 글의 자리를 원문 자리로 되짚어 그 자리 열쇠로 뺀 기록과 견준다(되짚지 못하면 사람이 뺀 자리로 보지 않는다).
  const back = new Map<number, PhotoSlot>()
  for (const from of sourceSlots) {
    const to = mapTo(from)
    if (to) back.set(to.line, from)
  }
  const drop = dropSlots(slots, placements, drops, (s) => {
    const from = back.get(s.line)
    return from ? { slot: from.key, nth: from.nth, heading: from.heading } : null
  })
  return placePhotos(markdown, placements, drop)
}

/**
 * 같은 장면 글자의 원문 자리(설명 줄 목록, 원문 순서)를 다듬은 글의 자리로 — 원문 i번째 자리의 짝을 i번째에 둔다. 확실하지 않으면 null
 * (그 장면의 사진은 넣지 않는다).
 * ① 자리 수가 다르면 null. ② 순서대로 짝지어 설명 줄이 어긋나지 않으면(다듬은 글이 설명을 뺐으면 어긋남이 아니다) 그 순서 —
 * 다듬기는 절 순서를 지킨다(ARTICLE_BLOG_RULE). ③ 어긋나면 원문 설명이 모두 있고 서로 다르며 다듬은 글의 설명이 하나씩 맞을 때만 그 짝.
 */
function mapSlots(sourceCaptions: readonly string[], targets: readonly PhotoSlot[], captionOf: (s: PhotoSlot) => string): PhotoSlot[] | null {
  if (sourceCaptions.length !== targets.length) return null
  const captions = targets.map(captionOf)
  if (captions.every((c, i) => !c || c === sourceCaptions[i])) return [...targets]
  if (sourceCaptions.some((c) => !c) || new Set(sourceCaptions).size !== sourceCaptions.length) return null
  const mapped = sourceCaptions.map((c) => targets[captions.indexOf(c)])
  return mapped.every(Boolean) && new Set(mapped).size === mapped.length ? (mapped as PhotoSlot[]) : null
}

/**
 * 짝지은 자리 줄만 `![사진 설명](https 주소)`로 바꾼다. 공공 사진은 바로 아랫줄 설명에 출처를 붙이고(`*설명 (사진: 한국관광공사,
 * [공공누리 제1유형](주소))*`), 설명 줄이 없으면 출처 줄을 한 줄 끼운다 — 줄 번호가 밀리지 않게 뒤 자리부터 바꾼다. 출처가 맞지
 * 않는 공공 사진(photoCreditState missing)은 넣지 않는다. 넣은 사진이 없으면 원고를 그대로(바이트까지 같게) 돌려준다.
 * 자사 화면은 `![화면 이름](앱 주소)`로 넣는다(photoPickSrc) — 앱 안 미리보기는 같은 출처라 바로 보이고, 앱 밖으로 내보낼 때는
 * src/lib/screenExport.ts가 그림을 문서 안에 넣거나 「[화면: …]」 글자로 바꾼다. 앱이 그린 지도도 `![군산 지도 — … 위치](앱 주소)`로 넣고,
 * 그림 바로 아래 줄에 OSM 출처 줄, 그다음 줄에 지도의 위치 문장을 둔다 — 바로 아랫줄 설명(사이트 기능 문장)을 이 두 줄로 바꾸고, 설명 줄이
 * 없으면 두 줄을 끼운다. 출처 줄이 그림 바로 아래에 붙어 모든 내보내기(서식째 복사 · .html · 작성자 묶음 · 글자)에 따라간다.
 */
function placePhotos(
  markdown: string,
  applied: readonly { pick: PhotoPick; slot: PhotoSlot }[],
  drop: readonly PhotoSlot[] = [],
): { markdown: string; applied: AppliedPhoto[] } {
  if (!applied.length && !drop.length) return { markdown, applied: [] }
  const lines = markdown.split('\n')
  const crlf = markdown.includes('\r\n')
  const out: AppliedPhoto[] = []
  // 뺄 자리 줄과 넣을 사진을 뒤 줄부터 — 줄 번호가 밀리지 않게. 뺄 자리는 그 줄만 지운다(바로 아랫줄 설명은 글로 남는다). 앞뒤가 빈 줄이면
  // 빈 줄 하나도 함께 지워 빈 줄이 겹치지 않게 한다.
  const ops = [...applied.map((a) => ({ ...a, drop: false })), ...drop.map((slot) => ({ slot, pick: null, drop: true }))].sort((a, b) => b.slot.line - a.slot.line)
  let dropped = 0
  for (const op of ops) {
    if (op.drop) {
      const at = op.slot.line
      const blank = (i: number) => i >= 0 && i < lines.length && lines[i]!.trim() === ''
      lines.splice(at, blank(at - 1) && (blank(at + 1) || at + 1 >= lines.length) ? 2 : 1)
      if (blank(at - 1) && at - 1 === lines.length - 1) lines.splice(at - 1, 1)
      dropped += 1
      continue
    }
    const { pick, slot } = op as { pick: PhotoPick; slot: PhotoSlot }
    const src = photoPickSrc(pick)
    const state = photoCreditState(pick)
    if (!src || state === 'missing') continue
    const alt = cleanPhotoAlt(pick.alt) || cleanPhotoAlt(slot.alt)
    const cr = lines[slot.line]!.endsWith('\r') ? '\r' : ''
    lines[slot.line] = `![${alt}](${src})${cr}`
    const credit = state === 'public' ? (publicPhotoFields(pick) as PublicPhotoFields) : undefined
    const isMap = pick.origin === 'osm-map'
    if (credit || isMap) {
      const next = lines[slot.line + 1]
      const caption = next === undefined ? null : /^(\s*)\*(?!\*)(.+?)\*(\s*)$/.exec(next.replace(/\r$/, ''))
      // 공공 사진은 설명 뒤에 출처를 붙이고(설명이 없으면 출처 줄만), 지도는 설명(사이트 기능 문장) 자리에 출처 줄 · 위치 문장 두 줄을 둔다.
      const texts = credit ? [caption ? `${caption[2]!} (${photoCreditLine(credit)})` : photoCreditLine(credit)] : mapCaptionLines(pick.caption)
      // 끼운 줄의 줄 끝 — 마지막 줄은 바꾼(끼운) 자리의 줄 끝, 그 앞 줄들은 원고의 줄 끝(CRLF 원고면 \r).
      const ends = (last: string) => texts.map((_t, i) => (i < texts.length - 1 ? (crlf ? '\r' : '') : last))
      if (caption && next !== undefined) {
        const end = ends(next.endsWith('\r') ? '\r' : '')
        lines.splice(slot.line + 1, 1, ...texts.map((t, i) => `${caption[1]}*${t}*${caption[3]}${end[i]}`))
      } else if (cr || !crlf) {
        const end = ends(cr)
        lines.splice(slot.line + 1, 0, ...texts.map((t, i) => `*${t}*${end[i]}`))
      } else {
        // CRLF 원고의 마지막 줄 — 사진 줄에 줄 끝을 달고 끼운 줄의 마지막이 마지막 줄이 된다.
        lines[slot.line] = `${lines[slot.line]!}\r`
        const end = ends('')
        lines.splice(slot.line + 1, 0, ...texts.map((t, i) => `*${t}*${end[i]}`))
      }
    }
    out.push({
      src,
      alt,
      heading: slot.heading,
      slotAlt: slot.alt,
      place: { slot: pick.slot, nth: pick.nth, heading: pick.heading },
      ...(credit ? { credit } : {}),
      pageUrl: pick.pageUrl,
      confirmedAt: pick.confirmedAt,
      ...(pick.origin === 'screen' && pick.screenId && pick.variantId
        ? { screen: { screenId: pick.screenId, variantId: pick.variantId, ...(pick.capturedAt ? { capturedAt: pick.capturedAt } : {}) } }
        : {}),
      ...(isMap && pick.mapId && pick.mapVariant ? { map: { mapId: pick.mapId, variant: pick.mapVariant, credit: MAP_CREDIT } } : {}),
      ...(pick.origin === 'owner' && pick.ownerPhotoId ? { owner: { id: pick.ownerPhotoId } } : {}),
    })
  }
  out.reverse()
  return out.length || dropped ? { markdown: lines.join('\n'), applied: out } : { markdown, applied: [] }
}

/**
 * 사진 기능에서 의료 업종으로 보는 업종 — 기본으로 꺼 둔다(환자 · 시술 전후 사진은 의료광고 심의 대상). 실측 사례 · 사실 승인의
 * 의료 기본값(src/lib/answerEvidence.ts MEDICAL_INDUSTRY)보다 넓다 — 「외과 · 내과」로 끝나는 진료과와 영문 표기까지 본다.
 */
const PHOTO_MEDICAL =
  /성형|치과|병원|의원|피부과|한의원|클리닉|의료|안과|산부인과|외과|내과|의학과|이비인후과|비뇨|소아|한방|약국|요양|hospital|clinic|dental|medical/i

export function isPhotoMedical(industry: string | undefined): boolean {
  return PHOTO_MEDICAL.test(industry ?? '')
}

/**
 * 고른 사진을 글에 넣어도 되는가 — 브랜드의 사진 사용 확인이 있고, 의료 업종이면 의료광고 확인까지 있을 때만. 내보내기 · 사진 받기
 * (서버 photo-file)가 같은 기준을 쓴다 — 확인 뒤 업종이 의료로 바뀌어도 확인 없이 나가지 않게.
 */
export function photosAllowed(settings: { photoRights?: { medical?: true } } | null | undefined, industry: string | undefined): boolean {
  const rights = settings?.photoRights
  return Boolean(rights) && (!isPhotoMedical(industry) || Boolean(rights?.medical))
}

/** 공공 사진(공공누리)을 써도 된다는 브랜드 확인이 있는가 — 홈페이지 사진 확인(photosAllowed) 위에 따로 받는다. */
export function publicPhotosAllowed(
  settings: { photoRights?: { medical?: true; publicAt?: string } } | null | undefined,
  industry: string | undefined,
): boolean {
  return photosAllowed(settings, industry) && Boolean(settings?.photoRights?.publicAt)
}

/**
 * 내보낼(복사 · .html · 사진 받기) 고른 사진 — 사진 사용 확인이 없으면(의료 업종은 의료광고 확인까지) 없다. 출처가 없거나 틀린 공공
 * 사진(photoCreditState missing)과, 공공 사진 사용 확인(photoRights.publicAt) 전의 공공 사진은 뺀다. 서버의 사진 받기(photo-file)도 같은 기준.
 */
export function exportPhotoPicks(
  settings: { photoRights?: { medical?: true; publicAt?: string } } | null | undefined,
  industry: string | undefined,
  picks: readonly PhotoPick[] | undefined,
): PhotoPick[] {
  if (!picks?.length || !photosAllowed(settings, industry)) return []
  const publicOk = publicPhotosAllowed(settings, industry)
  return picks.filter((p) => {
    const state = photoCreditState(p)
    return state === 'site' || (state === 'public' && publicOk)
  })
}
