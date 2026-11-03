/**
 * 관광공사 사진(3단계) — 한국관광공사 TourAPI(국문 관광정보 KorService2 · 관광사진 정보 PhotoGalleryService1)의 응답을 읽어, 자사
 * 사이트 장소 페이지(2단계)에 쓸 사진이 없던 장소 자리에 넣을 공공누리 제1유형 사진 후보를 만든다. 부르기 · 캐시 · 키는 서버(server/
 * tourPhotos.ts)가 하고, 이 파일은 응답 읽기 · 장소 맞추기 · 지역 확인 · 출처 글자만 한다(서버 · 화면 · 검증 스크립트가 함께 쓴다 —
 * DOM을 쓰지 않는다).
 *
 * 지킬 것(2026-11-03 실측):
 * - 사이트의 장소 이름과 관광공사 제목이 다를 수 있다(「진포해양공원」 ↔ 「진포해양테마공원」). 사이트 이름 → 장소 페이지의 다른 이름
 *   (alternateName) 순서로 찾고, 그래도 없으면 장소 페이지의 좌표 근처에서 이름이 비슷한 곳을 찾는다.
 * - 다른 도시의 장소를 맞추지 않는다 — 주소(addr1) · 촬영지(galPhotographyLocation)가 브랜드 지역의 도시와 맞아야 한다(「근대역사박물관」은
 *   부산 근대역사관도 나온다).
 * - KorService2 사진은 사진마다 cpyrhtDivCd가 'Type1'일 때만 쓴다(군산근대역사박물관은 22장이 모두 Type3).
 * - 관광사진 정보(포토코리아)에는 사진마다 유형이 없다 — 데이터 페이지(TOUR_SOURCES.gallery.page)가 공공누리 제1유형이라고 밝혀 둔 것을
 *   근거로 쓴다.
 * - 출처는 한국관광공사(촬영자가 있으면 「한국관광공사 김지호」). 「제공」 · 「협찬」 · 「공식」 같은 말은 쓰지 않는다(cleanPhotoCredit).
 */
import { canonicalPhotoSrc, cleanPhotoAlt, cleanPhotoCredit, normSlotAlt, PHOTO_LICENSES } from './articlePhotos.js'
import { hasPeopleWords, placeKey } from './photoAutoPick.js'

/** 사진을 받는 두 서비스 — 이름과 이용 허락 근거 페이지(data.go.kr 데이터 페이지). */
export const TOUR_SOURCES = {
  kor: { name: '한국관광공사 국문 관광정보(TourAPI)', page: 'https://www.data.go.kr/data/15101578/openapi.do' },
  gallery: { name: '한국관광공사 관광사진 정보(포토코리아)', page: 'https://www.data.go.kr/data/15101914/openapi.do' },
} as const
export type TourSource = keyof typeof TOUR_SOURCES

/** 출처의 저작권자 — 촬영자 이름이 없을 때. */
export const TOUR_CREDIT = '한국관광공사'

/** 자동 채우기 한 번에 관광공사 사진을 묻는 장소 수의 상한 — 장소 하나에 TourAPI 2~5번(7일 캐시). */
export const TOUR_PLACE_LIMIT = 20

/** 한 장소에서 돌려줄 사진 수의 상한(서비스마다). */
export const TOUR_PHOTOS_PER_SOURCE = 12

/** 관광공사 사진 하나 — 자동 채우기 · 손으로 고르기의 공공 사진 후보(origin public)가 된다. */
export interface TourPhoto {
  /** https 사진 주소(canonicalPhotoSrc, *.visitkorea.or.kr). */
  src: string
  /** 사진 설명 — 관광공사의 장소 제목(「진포해양테마공원」). */
  title: string
  /** 사이트의 장소 이름(장소 사전) — 자리 맞추기에 쓴다. */
  place: string
  source: TourSource
  license: 'kogl-1'
  licenseType: 1
  /** 출처 — 「한국관광공사」 또는 「한국관광공사 김지호」. */
  creditText: string
  /** 이용 허락 페이지(공공누리 제1유형). */
  creditUrl: string
  /** 이용 허락 근거 페이지(data.go.kr 데이터 페이지) — 고른 사진의 pageUrl이 된다. */
  sourcePageUrl: string
  /** 촬영자(관광사진 정보만). */
  photographer?: string
  /** 관광공사 콘텐츠 id(KorService2 contentid · 관광사진 galContentId). */
  contentId: string
}

/** 장소 하나를 찾을 단서 — 사이트 장소 이름, 장소 페이지의 다른 이름 · 주소 · 좌표. */
export interface TourPhotoQuery {
  place: string
  /** 장소 페이지의 다른 이름(alternateName) — 관광공사 제목과 다를 때 찾는다. */
  names?: string[]
  /** 장소 페이지의 주소(addressLocality · streetAddress) — 브랜드 지역이 전국일 때 도시를 여기서 읽는다. */
  address?: string
  lat?: number
  lng?: number
}

/** 찾은 관광공사 장소. */
export interface TourPlace {
  contentId: string
  title: string
  addr: string
}

export interface TourPhotoResult {
  place: string
  /** 맞춘 도시(지역 확인에 쓴 낱말). 못 정하면 null(그때는 찾지 않는다). */
  city: string | null
  /** 찾은 관광공사 장소 — 못 찾으면 null(관광사진 정보는 이름으로만 찾는다). */
  resolved: TourPlace | null
  photos: TourPhoto[]
  /** 국문 관광정보에서 공공누리 제1유형이 아니라 뺀 사진 수. */
  rejectedType: number
  /** 사람 낱말 · 다른 도시 · 다른 장소라 뺀 관광사진 수. */
  rejectedGallery: number
  /** 알림(찾지 못한 이유 등). */
  note?: string
  /** 서비스 오류 — QUOTA · KEY면 화면이 다음 장소를 부르지 않는다. */
  error?: TourApiErrorCode
}

/** TourAPI 오류 — NO_KEY 키 없음 · FORBIDDEN 서비스 승인 없음(403) · KEY 키가 틀림 · QUOTA 하루 한도 · TIMEOUT · UPSTREAM 그 밖. */
export type TourApiErrorCode = 'NO_KEY' | 'FORBIDDEN' | 'KEY' | 'QUOTA' | 'TIMEOUT' | 'UPSTREAM'

const NATIONAL = /^(국내|전국|한국|대한민국|온라인|해외|국외)$/
const PROVINCE = /^(경기|강원|충북|충남|전북|전남|경북|경남|제주|충청북|충청남|전라북|전라남|경상북|경상남)(도|특별자치도)?$/
const METRO = /^(서울|부산|대구|인천|광주|대전|울산|세종)(특별시|광역시|특별자치시|시)?$/
/** 도시 낱말 끝(군산시 · 강남구 · 부안군) — 떼고 비교한다. */
const CITY_END = /(시|군|구)$/
/** 도로 · 동네 이름 끝 — 주소 첫 낱말이 이 모양이면 도시가 아니다(「해망로 240」). */
const NOT_CITY = /(로|길|동|리|읍|면|가)$/

/**
 * 지역 글자의 도시 — 「전북 군산」 → 「군산」, 「군산시 해망로 240」 → 「군산」, 「서울 강남」 → 「강남」, 「부산」 → 「부산」. 도 이름 ·
 * 「국내」 · 「전국」은 건너뛰고, 처음 나온 도시 낱말(시 · 군 · 구를 뗀 꼴)을 쓴다. 광역시만 있으면 그 이름. 못 정하면 null.
 */
export function regionCityOf(text: string | undefined): string | null {
  let metro: string | null = null
  for (const w of normSlotAlt(text ?? '').split(/[\s,·()/]+/)) {
    if (!w || NATIONAL.test(w) || PROVINCE.test(w)) continue
    const m = METRO.exec(w)
    if (m) {
      metro ??= m[1]!
      continue
    }
    if (!/^[가-힣]{2,6}$/.test(w) || NOT_CITY.test(w)) break
    return w.length >= 3 && CITY_END.test(w) ? w.slice(0, -1) : w
  }
  return metro
}

/** 주소 · 촬영지 글자에 그 도시가 낱말로 있는가 — 「전북특별자치도 군산시 해망로」 · 「전라북도 군산」은 「군산」이다. */
export function cityMatches(text: string | undefined, city: string): boolean {
  if (!city) return false
  return normSlotAlt(text ?? '')
    .split(/[\s,·()/]+/)
    .some((w) => w === city || (w.startsWith(city) && /^(시|군|구|특별시|광역시|특별자치시)$/.test(w.slice(city.length))))
}

/** 이름 비교용 열쇠들 — 3글자 이상만(「달」 · 「하늘」 같은 이름이 아무 제목에나 걸리지 않게). */
function nameKeys(names: readonly string[]): string[] {
  return [...new Set(names.map(placeKey).filter((k) => k.length >= 3))]
}

/**
 * 관광공사 제목이 장소 이름들과 맞는 정도 — 같으면 0, 한쪽이 다른 쪽을 품으면 글자 수 차이(작을수록 가깝다), 아니면 null.
 * 「군산근대역사박물관」은 「근대역사박물관」을 품는다(차이 2).
 */
export function titleDistance(title: string, names: readonly string[]): number | null {
  const k = placeKey(title)
  if (k.length < 3) return null
  let best: number | null = null
  for (const n of nameKeys(names)) {
    const d = k === n ? 0 : k.includes(n) || n.includes(k) ? Math.abs(k.length - n.length) : null
    if (d !== null && (best === null || d < best)) best = d
  }
  return best
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i + 2 <= s.length; i += 1) out.add(s.slice(i, i + 2))
  return out
}

/** 이름이 비슷한가(좌표로 찾을 때만) — 품거나, 글자 2-gram 겹침(Jaccard)이 0.5 이상(「진포해양공원」 ↔ 「진포해양테마공원」). */
export function titleSimilar(title: string, names: readonly string[]): boolean {
  if (titleDistance(title, names) !== null) return true
  const a = bigrams(placeKey(title))
  return nameKeys(names).some((n) => {
    const b = bigrams(n)
    let both = 0
    for (const x of a) if (b.has(x)) both += 1
    return a.size > 0 && both / (a.size + b.size - both) >= 0.5
  })
}

/** 응답의 결과 코드 — response.header.resultCode(오류 응답은 맨 위 resultCode). 없으면 ''. */
export function tourResultCode(json: unknown): string {
  const j = (json ?? {}) as { response?: { header?: { resultCode?: unknown } }; resultCode?: unknown }
  const code = j.response?.header?.resultCode ?? j.resultCode
  return typeof code === 'string' || typeof code === 'number' ? String(code) : ''
}

/** 응답의 항목들 — response.body.items.item이 배열 · 객체 하나 · ''(결과 없음)일 수 있다. */
export function tourItems(json: unknown): Record<string, unknown>[] {
  const items = ((json ?? {}) as { response?: { body?: { items?: unknown } } }).response?.body?.items
  const item = items && typeof items === 'object' ? (items as { item?: unknown }).item : undefined
  const list = Array.isArray(item) ? item : item && typeof item === 'object' ? [item] : []
  return list.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')

/** 관광공사 사진 주소 — *.visitkorea.or.kr의 https(http는 https로) 주소만. 아니면 null. */
export function tourPhotoSrc(raw: unknown): string | null {
  const s = str(raw).replace(/^http:\/\//i, 'https://')
  const src = canonicalPhotoSrc(s)
  if (!src) return null
  const host = new URL(src).hostname.toLowerCase()
  return host === 'visitkorea.or.kr' || host.endsWith('.visitkorea.or.kr') ? src : null
}

/** 관광공사 사진의 출처 — 촬영자가 「한국관광공사 …」면 그대로, 다른 이름이면 「한국관광공사 {이름}」, 없거나 쓸 수 없는 말이면 「한국관광공사」. */
export function tourCreditOf(photographer?: unknown): string {
  const p = cleanPhotoCredit(photographer)
  if (!p) return TOUR_CREDIT
  const credit = p.startsWith(TOUR_CREDIT) ? p : cleanPhotoCredit(`${TOUR_CREDIT} ${p}`)
  return credit || TOUR_CREDIT
}

/**
 * 키워드 · 좌표 검색 결과에서 장소 하나를 고른다 — 주소가 그 도시이고 제목이 이름들과 맞는 곳(가장 가까운 이름, 같으면 응답 순서).
 * near면 이름이 비슷하기만 해도 되고(titleSimilar) 응답의 거리(dist)가 가까운 곳부터.
 */
export function pickTourPlace(items: readonly Record<string, unknown>[], names: readonly string[], city: string, near = false): TourPlace | null {
  const hits = items.flatMap((it, order) => {
    const title = str(it.title)
    const contentId = str(it.contentid)
    const addr = str(it.addr1)
    if (!title || !/^\d+$/.test(contentId) || !cityMatches(addr, city)) return []
    const d = titleDistance(title, names)
    if (d === null && !(near && titleSimilar(title, names))) return []
    const dist = Number(str(it.dist))
    return [{ place: { contentId, title, addr }, d: d ?? 99, dist: Number.isFinite(dist) ? dist : 0, order }]
  })
  hits.sort((a, b) => (near ? a.dist - b.dist : 0) || a.d - b.d || a.order - b.order)
  return hits[0]?.place ?? null
}

function tourPhoto(src: string, title: string, place: string, source: TourSource, contentId: string, photographer?: string): TourPhoto {
  return {
    src,
    title,
    place,
    source,
    license: 'kogl-1',
    licenseType: 1,
    creditText: source === 'gallery' ? tourCreditOf(photographer) : TOUR_CREDIT,
    creditUrl: PHOTO_LICENSES['kogl-1'].url,
    sourcePageUrl: TOUR_SOURCES[source].page,
    ...(photographer ? { photographer } : {}),
    contentId,
  }
}

/**
 * 국문 관광정보의 사진 — 대표 사진(검색 항목의 firstimage, 그 항목의 cpyrhtDivCd가 Type1일 때)과 상세 사진(detailImage2, 사진마다
 * cpyrhtDivCd가 Type1인 것) 순서로, 같은 사진은 한 번. 사진 이름에 사람 낱말이 있으면 뺀다. rejected는 Type1이 아니라 뺀 수.
 */
export function korTourPhotos(
  resolved: TourPlace,
  first: { firstimage?: unknown; cpyrhtDivCd?: unknown } | null,
  images: readonly Record<string, unknown>[],
  place: string,
  names: readonly string[],
): { photos: TourPhoto[]; rejected: number } {
  const photos: TourPhoto[] = []
  const seen = new Set<string>()
  let rejected = 0
  const add = (raw: unknown, type: unknown, label: string) => {
    const src = tourPhotoSrc(raw)
    if (!src || seen.has(src)) return
    seen.add(src)
    if (str(type) !== 'Type1') {
      rejected += 1
      return
    }
    if (label && hasPeopleWords(label.replace(/\.(jpe?g|png|gif|webp)$/i, ''), [...names, resolved.title])) return
    if (photos.length < TOUR_PHOTOS_PER_SOURCE) photos.push(tourPhoto(src, cleanPhotoAlt(resolved.title), place, 'kor', resolved.contentId))
  }
  if (first) add(first.firstimage, first.cpyrhtDivCd, '')
  for (const im of images) {
    if (str(im.contentid) && str(im.contentid) !== resolved.contentId) continue
    add(im.originimgurl, im.cpyrhtDivCd, str(im.imgname))
  }
  return { photos, rejected }
}

/**
 * 관광사진 정보의 사진 — 촬영지가 그 도시이고 제목이 장소 이름들(사이트 이름 · 다른 이름 · 관광공사 제목)과 맞으며 제목 · 검색 낱말에
 * 사람 낱말이 없는 사진만, 응답 순서로. 사람 낱말은 장소 이름들을 걷어 낸 글자에서 본다(「○○박물관 관람객」은 뺀다). rejected는 그래서 뺀 수.
 */
export function galleryTourPhotos(
  items: readonly Record<string, unknown>[],
  place: string,
  names: readonly string[],
  city: string,
): { photos: TourPhoto[]; rejected: number } {
  const photos: TourPhoto[] = []
  const seen = new Set<string>()
  let rejected = 0
  for (const it of items) {
    const src = tourPhotoSrc(it.galWebImageUrl)
    const title = cleanPhotoAlt(str(it.galTitle))
    if (!src || seen.has(src)) continue
    seen.add(src)
    const ok =
      Boolean(title) &&
      cityMatches(str(it.galPhotographyLocation), city) &&
      titleDistance(title, names) !== null &&
      !hasPeopleWords(`${title} ${str(it.galSearchKeyword)}`, names)
    if (!ok) {
      rejected += 1
      continue
    }
    if (photos.length < TOUR_PHOTOS_PER_SOURCE) photos.push(tourPhoto(src, title, place, 'gallery', str(it.galContentId), cleanPhotoCredit(it.galPhotographer) || undefined))
  }
  return { photos, rejected }
}

/** 고른 사진의 찾은 페이지(pageUrl)가 관광공사 데이터 페이지인가 — 화면이 「관광공사 사진」 표시를 단다. */
export function isTourSourcePage(pageUrl: string | undefined): boolean {
  return Object.values(TOUR_SOURCES).some((s) => s.page === pageUrl)
}
