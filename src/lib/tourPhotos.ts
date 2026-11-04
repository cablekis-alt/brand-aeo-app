/**
 * 관광공사 사진(3단계) — 한국관광공사 TourAPI(국문 관광정보 KorService2 · 관광사진 정보 PhotoGalleryService1)의 응답을 읽어, 자사
 * 사이트 장소 페이지(2단계)에 쓸 사진이 없던 장소 자리에 넣을 공공누리 제1유형 사진 후보를 만든다. 부르기 · 캐시 · 키는 서버(server/
 * tourPhotos.ts)가 하고, 이 파일은 응답 읽기 · 장소 맞추기 · 지역 확인 · 출처 글자만 한다(서버 · 화면 · 검증 스크립트가 함께 쓴다 —
 * DOM을 쓰지 않는다).
 *
 * 지킬 것(2026-11-03 실측):
 * - 사이트의 장소 이름과 관광공사 제목이 다를 수 있다(「진포해양공원」 ↔ 「진포해양테마공원」). 사이트 이름 → 장소 페이지의 다른 이름
 *   (alternateName) 순서로 찾고, 그래도 없으면 이름 끝의 종류 낱말(「공원」 · 「박물관」 …)을 뗀 낱말로 찾아 이름이 비슷한 곳을, 그래도
 *   없으면 장소 페이지의 좌표 근처에서 이름이 비슷한 곳을 찾는다. 좌표 검색(locationBasedList2)은 그 좌표의 장소 자신도 돌려주지 않을
 *   때가 있다(진포해양테마공원 좌표 1km — 26건에 진포해양테마공원 없음).
 * - 다른 도시의 장소를 맞추지 않는다 — 주소(addr1) · 촬영지(galPhotographyLocation)가 브랜드 지역의 광역시 · 도와 시 · 군 · 구에 함께
 *   맞아야 한다(「근대역사박물관」은 부산 근대역사관도 나온다 · 「중구」는 서울 · 부산 · 대구 · 인천 · 대전 · 울산에 다 있다).
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

/** 한 번에 TourAPI를 새로 부르는 장소 수의 상한 — 장소 하나에 TourAPI 2~8번(7일 캐시). 캐시에서 온 장소는 세지 않는다. */
export const TOUR_PLACE_LIMIT = 20

/**
 * 한 장소에서 돌려줄 사진 수의 상한(서비스마다) — 장소의 사진을 모두 돌려준다(관광사진 정보는 여러 쪽을 넘겨 받는다 —
 * server/tourPhotos.ts). 자동 채우기가 사진 장면을 읽어 자리에 맞는 사진을 고르므로(src/lib/photoScenes.ts), 앞 몇 장만 보면 맞는 사진이
 * 있어도 못 찾는다(군산근대역사박물관 관광사진 115장 — 앞 40장은 모두 2013-01 실내 전시 사진).
 */
export const TOUR_PHOTOS_PER_SOURCE = 500

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
  /** 장소의 주소(국문 관광정보 addr1) 또는 촬영지(관광사진 galPhotographyLocation) — 도시 확인의 근거. */
  location: string
  /** 사진 이름(국문 관광정보 imgname — 대표 사진은 없다). */
  imageName?: string
  /** 촬영 연월(YYYYMM, 관광사진 정보 galPhotographyMonth) — 장면을 읽을 사진을 시기마다 고루 고른다. */
  month?: string
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
  /** 맞춘 지역(regionLabel — 「부산 중구」 · 「군산」). 못 정하면 null(그때는 찾지 않는다). */
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
  /** 서비스 오류 — QUOTA · KEY · TIMEOUT이면 화면이 다음 장소를 부르지 않는다(src/lib/sitePhotos.ts loadTourPhotosFor). */
  error?: TourApiErrorCode
  /** 이번 요청이 TourAPI를 실제로 부른 횟수 — 0이면 모두 캐시에서 왔다(화면이 장소 수 상한에 세지 않는다). */
  liveCalls?: number
}

/** TourAPI 오류 — NO_KEY 키 없음 · FORBIDDEN 서비스 승인 없음(403) · KEY 키가 틀림 · QUOTA 하루 한도 · TIMEOUT · UPSTREAM 그 밖. */
export type TourApiErrorCode = 'NO_KEY' | 'FORBIDDEN' | 'KEY' | 'QUOTA' | 'TIMEOUT' | 'UPSTREAM'

const NATIONAL = /^(국내|전국|한국|대한민국|온라인|해외|국외)$/
const PROVINCE = /^(경기|강원|충북|충남|전북|전남|경북|경남|제주|충청북|충청남|전라북|전라남|경상북|경상남)(도|특별자치도)?$/
/** 도 이름의 줄인 꼴 — 「전라북도」 · 「전북특별자치도」는 같은 「전북」이다. */
const PROVINCE_SHORT: Readonly<Record<string, string>> = { 충청북: '충북', 충청남: '충남', 전라북: '전북', 전라남: '전남', 경상북: '경북', 경상남: '경남' }
const METRO = /^(서울|부산|대구|인천|광주|대전|울산|세종)(특별시|광역시|특별자치시|시)?$/
/**
 * 통합한 광역 단체 — 「전남광주통합특별시 목포시 영산로」(2026-11 TourAPI 주소). 줄인 꼴은 앞부분(「전남광주」)이고, 옛 이름(「전남」 ·
 * 「광주」)을 품는다(provinceCovers).
 */
const MERGED = /^([가-힣]{4,6})통합특별시$/
/** 도시 낱말 끝(군산시 · 강남구 · 부안군) — 떼고 비교한다. */
const CITY_END = /(시|군|구)$/
/** 도로 · 동네 이름 끝 — 주소 첫 낱말이 이 모양이면 도시가 아니다(「해망로 240」). */
const NOT_CITY = /(로|길|동|리|읍|면|가)$/
/**
 * 여러 광역시 · 도에 같은 이름이 있는 시 · 군 · 구(시 · 군 · 구를 뗀 꼴, 두 글자 구는 그대로) — 광역시 · 도 없이는 어느 곳인지 모른다
 * (중구 · 동구 · 서구 · 남구 · 북구는 광역시마다, 강서구는 서울 · 부산, 고성군은 강원 · 경남, 광주는 광주광역시 · 경기 광주시).
 */
const SHARED_CITY: ReadonlySet<string> = new Set(['중구', '동구', '서구', '남구', '북구', '강서', '고성', '광주'])

/** 지역 — 광역시 · 도(줄인 꼴 「부산」 · 「전북」)와 시 · 군 · 구(시 · 군 · 구를 뗀 꼴 「군산」 · 「강남」, 두 글자 구는 그대로 「중구」). */
export interface TourRegion {
  province: string | null
  city: string | null
}

/**
 * 지역 글자를 읽는다 — 「전북 군산」 → 전북 · 군산, 「부산광역시 중구 대청로」 → 부산 · 중구, 「경기 광주」 → 경기 · 광주, 「광주」 → 광주 · 없음,
 * 「군산시 해망로 240」 → 없음 · 군산, 「전남광주통합특별시 목포시」 → 전남광주 · 목포. 「국내」 · 「전국」은 건너뛰고, 처음 나온 광역시 · 도
 * 다음의 첫 도시 낱말을 쓴다(광역시 · 도 뒤의 「광주」는 경기 광주시다). 못 읽으면 null.
 */
export function tourRegionOf(text: string | undefined): TourRegion | null {
  let province: string | null = null
  for (const w of normSlotAlt(text ?? '').split(/[\s,·()/]+/)) {
    if (!w || NATIONAL.test(w)) continue
    const p: RegExpExecArray | null = province ? null : (PROVINCE.exec(w) ?? METRO.exec(w) ?? MERGED.exec(w))
    if (p) {
      province = PROVINCE_SHORT[p[1]!] ?? p[1]!
      continue
    }
    if (!/^[가-힣]{2,6}$/.test(w) || NOT_CITY.test(w)) break
    return { province, city: w.length >= 3 && CITY_END.test(w) ? w.slice(0, -1) : w }
  }
  return province ? { province, city: null } : null
}

/** 어느 곳인지 정해지는 지역인가 — 광역시 · 도나 시 · 군 · 구가 있고, 여러 곳에 있는 구 · 군 이름이면 광역시 · 도도 있어야 한다. */
export function knownRegion(r: TourRegion | null): r is TourRegion {
  if (!r) return false
  return r.city ? r.province !== null || !SHARED_CITY.has(r.city) : r.province !== null
}

/** 광역 단체 a가 b를 품는가 — 같거나, a가 통합한 단체(「전남광주」)이고 b가 그 옛 이름(「전남」 · 「광주」)이다. */
function provinceCovers(a: string, b: string): boolean {
  return a === b || (a.length > 2 && b.length === 2 && a.includes(b))
}

/** 두 광역 단체가 겹치는가 — 한쪽이 다른 쪽을 품는다. */
function provincesMeet(a: string, b: string): boolean {
  return provinceCovers(a, b) || provinceCovers(b, a)
}

/** 두 지역이 서로 어긋나지 않는가 — 둘 다 있는 광역시 · 도가 겹치고(통합한 단체는 옛 이름과 겹친다), 둘 다 있는 시 · 군 · 구가 같다. */
export function regionsAgree(a: TourRegion, b: TourRegion): boolean {
  return !(a.province && b.province && !provincesMeet(a.province, b.province)) && !(a.city && b.city && a.city !== b.city)
}

/** 지역의 표시 글자 — 「부산 중구」 · 「군산」 · 「서울」. */
export function regionLabel(r: TourRegion): string {
  return [r.province, r.city].filter(Boolean).join(' ')
}

/** 지역 글자의 도시 낱말 하나 — 「전북 군산」 → 「군산」, 「서울 강남」 → 「강남」, 「부산」 → 「부산」. 못 정하면 null. 같은 도시인지는 cityMatches로 본다. */
export function regionCityOf(text: string | undefined): string | null {
  const r = tourRegionOf(text)
  return r ? (r.city ?? r.province) : null
}

/**
 * 주소 · 촬영지 글자가 그 지역인가 — 시 · 군 · 구가 낱말로 있고(「전북특별자치도 군산시 해망로」 · 「전라북도 군산」은 「군산」), 광역시 ·
 * 도가 있으면 겹쳐야 한다(「대구광역시 중구」는 「부산 중구」가 아니다 · 「전남광주통합특별시 목포시」는 「전남 목포」다). 글자에 광역시 · 도가
 * 없으면 여러 곳에 있는 구 · 군 이름(중구 · 고성 …)으로는 맞추지 않는다. 지역이 광역시 · 도뿐이면 글자의 광역시 · 도를 품어야 한다(「광주」는
 * 「전남광주통합특별시 목포시」를 품지 않는다). region은 지역 글자여도 된다(tourRegionOf).
 */
export function cityMatches(text: string | undefined, region: TourRegion | string | null): boolean {
  const want = typeof region === 'string' ? tourRegionOf(region) : region
  if (!knownRegion(want)) return false
  const got = tourRegionOf(text)
  if (!want.city) return Boolean(want.province && got?.province && provinceCovers(want.province, got.province))
  if (want.province && got?.province && !provincesMeet(want.province, got.province)) return false
  if (want.province && !got?.province && SHARED_CITY.has(want.city)) return false
  const city = want.city
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

/** 제목과 이름들의 글자 2-gram 겹침(Jaccard) 가운데 가장 큰 값 — 0~1. */
function titleOverlap(title: string, names: readonly string[]): number {
  const a = bigrams(placeKey(title))
  if (!a.size) return 0
  let best = 0
  for (const n of nameKeys(names)) {
    const b = bigrams(n)
    let both = 0
    for (const x of a) if (b.has(x)) both += 1
    best = Math.max(best, both / (a.size + b.size - both))
  }
  return best
}

/** 이름이 비슷한가(좌표 · 끝말을 뗀 낱말로 찾을 때만) — 품거나, 글자 2-gram 겹침(Jaccard)이 0.5 이상(「진포해양공원」 ↔ 「진포해양테마공원」). */
export function titleSimilar(title: string, names: readonly string[]): boolean {
  return titleDistance(title, names) !== null || titleOverlap(title, names) >= 0.5
}

/** 장소 종류를 나타내는 이름 끝 — 사이트와 관광공사가 다르게 붙이기 쉽다(「진포해양공원」 ↔ 「진포해양테마공원」). */
const KIND_END = /\s*(테마공원|공원|유원지|관광지|해수욕장|해변|박물관|미술관|기념관|전시관|체험관|홍보관|전망대|시장|거리|마을|광장)$/

/**
 * 이름에서 종류 끝말을 뗀 찾을 낱말 — 「진포해양공원」 → 「진포해양」. 남은 글자가 3글자 이상일 때만(「해양공원」의 「해양」처럼 아무 곳에나
 * 걸리는 낱말로는 찾지 않는다). 같은 낱말은 한 번.
 */
export function tourStemKeywords(names: readonly string[]): string[] {
  const out: string[] = []
  for (const raw of names) {
    const name = normSlotAlt(raw)
    const stem = name.replace(KIND_END, '').trim()
    if (stem !== name && placeKey(stem).length >= 3 && !out.some((s) => placeKey(s) === placeKey(stem))) out.push(stem)
  }
  return out
}

/** 끝말을 뗀 낱말로 찾은 곳이 장소 페이지의 좌표에서 이보다 멀면 맞추지 않는다(둘 다 좌표가 있을 때). */
const STEM_NEAR_M = 3000

/** 두 좌표 사이의 거리(m) — 짧은 거리라 평면 근사. */
function metersBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180
  const x = (b.lng - a.lng) * rad * Math.cos(((a.lat + b.lat) / 2) * rad)
  const y = (b.lat - a.lat) * rad
  return Math.hypot(x, y) * 6_371_000
}

/** 장소를 고르는 방법 — name 이름 검색 결과(제목이 이름과 맞는 곳) · stem 끝말을 뗀 낱말 검색 결과 · near 좌표 근처 검색 결과. */
export type TourPickMode = 'name' | 'stem' | 'near'

/** 응답의 결과 코드 — response.header.resultCode(오류 응답은 맨 위 resultCode). 없으면 ''. */
export function tourResultCode(json: unknown): string {
  const j = (json ?? {}) as { response?: { header?: { resultCode?: unknown } }; resultCode?: unknown }
  const code = j.response?.header?.resultCode ?? j.resultCode
  return typeof code === 'string' || typeof code === 'number' ? String(code) : ''
}

/** 응답의 전체 건수 — response.body.totalCount. 없거나 숫자가 아니면 null(쪽 넘기기는 받은 건수로 멈춘다). */
export function tourTotalCount(json: unknown): number | null {
  const n = Number(((json ?? {}) as { response?: { body?: { totalCount?: unknown } } }).response?.body?.totalCount)
  return Number.isInteger(n) && n >= 0 ? n : null
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
 * 키워드 · 좌표 검색 결과에서 장소 하나를 고른다 — 주소가 그 지역(cityMatches — 광역시 · 도까지)이고 제목이 이름들과 맞는 곳(가장 가까운
 * 이름, 같으면 응답 순서). stem · near면 이름이 비슷하기만 해도 된다(titleSimilar). stem은 이름이 더 비슷한 곳부터, 장소 페이지의
 * 좌표(at)가 있으면 그 좌표에서 STEM_NEAR_M 안의 곳만. near는 응답의 거리(dist)가 가까운 곳부터.
 */
export function pickTourPlace(
  items: readonly Record<string, unknown>[],
  names: readonly string[],
  region: TourRegion | string | null,
  how: { mode?: TourPickMode; at?: { lat: number; lng: number } } = {},
): TourPlace | null {
  const mode = how.mode ?? 'name'
  const want = typeof region === 'string' ? tourRegionOf(region) : region
  const hits = items.flatMap((it, order) => {
    const title = str(it.title)
    const contentId = str(it.contentid)
    const addr = str(it.addr1)
    if (!title || !/^\d+$/.test(contentId) || !cityMatches(addr, want)) return []
    const d = titleDistance(title, names)
    if (d === null && !(mode !== 'name' && titleSimilar(title, names))) return []
    const lat = str(it.mapy) ? Number(str(it.mapy)) : NaN
    const lng = str(it.mapx) ? Number(str(it.mapx)) : NaN
    if (mode === 'stem' && how.at && Number.isFinite(lat) && Number.isFinite(lng) && metersBetween(how.at, { lat, lng }) > STEM_NEAR_M) return []
    const dist = Number(str(it.dist))
    return [{ place: { contentId, title, addr }, d: d ?? 99, overlap: titleOverlap(title, names), dist: Number.isFinite(dist) ? dist : 0, order }]
  })
  hits.sort((a, b) => (mode === 'near' ? a.dist - b.dist : 0) || a.d - b.d || (mode === 'stem' ? b.overlap - a.overlap : 0) || a.order - b.order)
  return hits[0]?.place ?? null
}

function tourPhoto(
  src: string,
  title: string,
  place: string,
  source: TourSource,
  contentId: string,
  location: string,
  extra: { photographer?: string; imageName?: string; month?: string } = {},
): TourPhoto {
  const { photographer, imageName, month } = extra
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
    location,
    ...(imageName ? { imageName } : {}),
    ...(month ? { month } : {}),
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
    if (photos.length < TOUR_PHOTOS_PER_SOURCE) {
      photos.push(tourPhoto(src, cleanPhotoAlt(resolved.title), place, 'kor', resolved.contentId, resolved.addr, label ? { imageName: cleanPhotoAlt(label) } : {}))
    }
  }
  if (first) add(first.firstimage, first.cpyrhtDivCd, '')
  for (const im of images) {
    if (str(im.contentid) && str(im.contentid) !== resolved.contentId) continue
    add(im.originimgurl, im.cpyrhtDivCd, str(im.imgname))
  }
  return { photos, rejected }
}

/**
 * 관광사진 정보의 사진 — 촬영지가 그 지역(cityMatches — 광역시 · 도까지)이고 제목이 장소 이름들(사이트 이름 · 다른 이름 · 관광공사
 * 제목)과 맞으며 제목 · 검색 낱말에 사람 낱말이 없는 사진만, 응답 순서로. 사람 낱말은 장소 이름들을 걷어 낸 글자에서 본다(「○○박물관
 * 관람객」은 뺀다). rejected는 그래서 뺀 수.
 */
export function galleryTourPhotos(
  items: readonly Record<string, unknown>[],
  place: string,
  names: readonly string[],
  region: TourRegion | string | null,
): { photos: TourPhoto[]; rejected: number } {
  const want = typeof region === 'string' ? tourRegionOf(region) : region
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
      cityMatches(str(it.galPhotographyLocation), want) &&
      titleDistance(title, names) !== null &&
      !hasPeopleWords(`${title} ${str(it.galSearchKeyword)}`, names)
    if (!ok) {
      rejected += 1
      continue
    }
    if (photos.length < TOUR_PHOTOS_PER_SOURCE) {
      const photographer = cleanPhotoCredit(it.galPhotographer)
      const month = /^\d{6}$/.test(str(it.galPhotographyMonth)) ? str(it.galPhotographyMonth) : ''
      photos.push(
        tourPhoto(src, title, place, 'gallery', str(it.galContentId), str(it.galPhotographyLocation), { ...(photographer ? { photographer } : {}), ...(month ? { month } : {}) }),
      )
    }
  }
  return { photos, rejected }
}

/** 고른 사진의 찾은 페이지(pageUrl)가 관광공사 데이터 페이지면 그 서비스, 아니면 null. */
export function tourSourceOf(pageUrl: string | undefined): TourSource | null {
  return (Object.keys(TOUR_SOURCES) as TourSource[]).find((k) => TOUR_SOURCES[k].page === pageUrl) ?? null
}

/** 고른 사진의 찾은 페이지(pageUrl)가 관광공사 데이터 페이지인가 — 화면이 「관광공사 사진」 표시를 단다. */
export function isTourSourcePage(pageUrl: string | undefined): boolean {
  return tourSourceOf(pageUrl) !== null
}
