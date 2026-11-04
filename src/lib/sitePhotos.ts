import { fetchDraftPhotoFile, loadPhotoScenes, loadTourPhotos, type StoredDraft, type TenantSummary } from './api'
import {
  canonicalPhotoSrc,
  cleanPhotoAlt,
  cleanPhotoCredit,
  exportPhotoPicks,
  koglTypeOf,
  PHOTO_LICENSES,
  withPhotos,
  type AppliedPhoto,
  type PhotoLicense,
  type PublicPhotoFields,
} from './articlePhotos'
import { publishMarkdownOf } from './draftGaps'
import { downloadBlob, safeFileName } from './markdownFile'
import { fetchPage } from './aeo/fetchPage'
import { findPlace, placeKey, placeNameOfPath, publicCandidateFields, type AutoCandidate, type AutoPickResult } from './photoAutoPick'
import { REGION_SCENE_LIMITS, REGION_SCENE_PLACE, scenesToRead, type PhotoScene, type SceneWant } from './photoScenes'
import { TOUR_PLACE_LIMIT, type TourPhotoQuery, type TourPhotoResult } from './tourPhotos'
import { todayKst } from './publishedUrl'
import { brandSiteUrl } from './publishArticle'
import type { PublishSettings } from './publishSettings'

/**
 * 홈페이지 사진 후보 — 브랜드 홈페이지의 구조화 데이터(JSON-LD)가 「이 업체의 사진」으로 묶어 둔 사진만 고른다.
 *
 * 페이지의 <img>를 모두 긁으면 안 된다 — 2026-10-20 실측(공유 빌더의 숙소 페이지)에서 고유 사진 92장 중 숙소 사진은 9장뿐이고
 * 나머지는 축제 · 다른 식당 · 관광지 · 실존 유명인 사진이었다. 업체 노드(업체 · 숙소 · 객실 · 가게 · 상품)의 image · photo만 쓰고,
 * 그것이 하나도 없을 때만 대표 사진(og:image) → 같은 사이트의 설명 있는 <img>로 넘어간다. 그래도 사람이 썸네일을 보고 고른다
 * — 업체 사진에도 사람이 찍힌 사진이 섞인다(대표 사진의 설명에는 사람이 없었다).
 *
 * 페이지는 기존 수집 프록시(/api/fetch, 정적 읽기 — AI 크롤러와 같은 조건)로 받고 화면의 DOMParser로 읽는다. 새 서버 함수가 없다.
 */
export interface SitePhoto {
  /** https 주소(canonicalPhotoSrc). */
  src: string
  /** 사이트가 단 장면 설명 — 여러 사진에 똑같이 붙은 꼬리표(「○○ 사진」)는 쓰지 않는다. 없으면 ''. */
  alt: string
  /** 어디서 찾았나 — 구조화 데이터 · 대표 사진 · 페이지 사진. */
  source: 'jsonld' | 'og' | 'img'
  /** 구조화 데이터에서 그 사진을 가진 곳의 이름(예: 「A동」). */
  where?: string
  /**
   * 페이지가 출처 표시가 필요한 사진으로 표시했다 — 공공누리 표시(<img data-kogl>)나 구조화 데이터 ImageObject의 공공누리 유형(license ·
   * acquireLicensePage).
   * 자동 채우기(src/lib/photoAutoPick.ts)는 이 사진을 홈페이지 사진으로 넣지 않는다 — 장소 페이지의 공공 사진(extractPublicPhotos)으로만
   * 출처와 함께 넣는다.
   */
  credit?: true
}

export interface SitePhotoResult {
  pageUrl: string
  photos: SitePhoto[]
  /** https가 아니라 뺀 사진 수 — 0장일 때 이유를 알린다. */
  skippedHttp: number
}

const MAX_PHOTOS = 24
/** 업체 노드 — 이 타입의 image · photo만 「이 업체의 사진」이다(관광지 · 행사 · 인물 · 후기 노드는 뺀다). */
const BUSINESS_TYPE =
  /(Business|Organization|Corporation|Lodging|Hotel|Motel|Hostel|Resort|BedAndBreakfast|Campground|Room|Suite|Accommodation|Apartment|House|Restaurant|FoodEstablishment|CafeOrCoffeeShop|Bakery|Store|Clinic|Dentist|Physician|Hospital|Product|Service)$/
/** 한 설명이 이만큼 많은 서로 다른 사진에 붙어 있으면 장면 설명이 아니라 꼬리표다. */
const GENERIC_ALT_PHOTOS = 3
/**
 * 꼬리표 모양 — 「체크인 · 스테이 머뭄 사진」처럼 이름표 · 구분점 · 「사진」으로 된 설명. 일정 카드 썸네일에 한 사진이 스무 번씩
 * 붙어 장면 설명(두세 번)보다 많이 나온다(2026-10-20 실측) — 횟수로는 거를 수 없어 모양으로 뺀다.
 */
const TAG_ALT = /\s·\s.*(사진|이미지|photo|image)$/i

/** 사진을 찾을 페이지 — 발행 설정의 공식 사이트 → 브랜드 페이지 → 첫 소유 도메인 루트(htmlFile.ts 조직 주소와 같은 순서). */
export function photoPageOf(brand: Pick<TenantSummary, 'brandName' | 'ownedDomains' | 'brandPageUrl'>, settings?: PublishSettings | null): string | undefined {
  return settings?.siteUrl || brand.brandPageUrl || brandSiteUrl(brand, settings)
}

/** 같은 사진인지 — 주소의 query · 조각은 무시하고, Next.js 이미지 최적화 주소(/_next/image?url=)는 원래 주소로 푼다. */
/** 이미지 최적화 주소 — query에 원래 사진 주소를 담는다(경로 끝 · 그 주소를 담은 query 이름). */
const IMAGE_PROXIES: [string, string][] = [
  ['/_next/image', 'url'],
  ['/_vercel/image', 'url'],
  ['/.netlify/images', 'url'],
  ['/_image', 'href'],
]
const IMAGE_PATH = /\.(jpe?g|png|gif|webp|avif|bmp)$/i

function photoKey(raw: string, base: string): string | null {
  let url: URL
  try {
    url = new URL(raw, base)
  } catch {
    return null
  }
  for (const [path, param] of IMAGE_PROXIES) {
    const inner = url.pathname.endsWith(path) ? url.searchParams.get(param) : null
    if (inner) return photoKey(inner, url.href)
  }
  // 경로가 사진 파일이 아니면(image.php?id=3) query가 사진을 가른다 — 버리면 다른 사진이 한 장으로 합쳐진다.
  return IMAGE_PATH.test(url.pathname) ? `${url.origin}${url.pathname}` : `${url.origin}${url.pathname}${url.search}`
}

function absolute(raw: string, base: string): string | null {
  try {
    return new URL(raw, base).href
  } catch {
    return null
  }
}

type JsonLdNode = Record<string, unknown>

function typesOf(node: JsonLdNode): string[] {
  const t = node['@type']
  return (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === 'string')
}

/** image · photo · logo 값의 주소들 — 문자열, ImageObject(url · contentUrl), 배열. */
function imageUrls(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(imageUrls)
  if (value && typeof value === 'object') {
    const v = value as JsonLdNode
    return [v.contentUrl, v.url].filter((x): x is string => typeof x === 'string').slice(0, 1)
  }
  return []
}

/**
 * 출처 표시가 필요한 공공 사진 ImageObject(license나 acquireLicensePage가 공공누리 유형 주소)의 주소들. © 표시(copyrightNotice) ·
 * creditText · 다른 라이선스만 단 사진은 자사 사진의 이미지 라이선스 메타데이터일 수 있어 보지 않는다(홈페이지 사진으로 고를 수 있다).
 */
function creditImageUrls(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(creditImageUrls)
  if (!value || typeof value !== 'object') return []
  const v = value as JsonLdNode
  return koglTypeOf(v.license) !== null || koglTypeOf(v.acquireLicensePage) !== null ? imageUrls(v) : []
}

/** 구조화 데이터의 업체 사진(주소 · 가진 곳 이름), 로고 주소, 출처 표시가 필요한 사진 주소. */
function jsonLdImages(doc: Document): { images: { url: string; where?: string }[]; logos: string[]; credits: string[] } {
  const images: { url: string; where?: string }[] = []
  const logos: string[] = []
  const credits: string[] = []
  const walk = (value: unknown, depth: number) => {
    if (depth > 12 || !value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const v of value) walk(v, depth + 1)
      return
    }
    const node = value as JsonLdNode
    logos.push(...imageUrls(node.logo))
    credits.push(...(typesOf(node).includes('ImageObject') ? creditImageUrls(node) : []), ...creditImageUrls(node.image), ...creditImageUrls(node.photo))
    if (typesOf(node).some((t) => BUSINESS_TYPE.test(t))) {
      const where = typeof node.name === 'string' ? node.name.trim().slice(0, 40) : undefined
      for (const url of [...imageUrls(node.image), ...imageUrls(node.photo)]) images.push({ url, ...(where ? { where } : {}) })
    }
    for (const [key, v] of Object.entries(node)) {
      if (key === 'image' || key === 'photo' || key === 'logo' || key === '@context') continue
      walk(v, depth + 1)
    }
  }
  for (const script of doc.querySelectorAll('script[type]')) {
    if (!/ld\+json/i.test(script.getAttribute('type') ?? '')) continue
    const raw = script.textContent?.trim()
    if (!raw) continue
    try {
      walk(JSON.parse(raw), 0)
    } catch (err) {
      console.warn('[sitePhotos] 구조화 데이터를 읽지 못해 건너뜁니다', err)
    }
  }
  return { images, logos, credits }
}

/**
 * srcset의 주소들 — HTML 규칙대로 읽는다: 공백이 아닌 글자 덩어리가 주소이고, 주소 끝의 쉼표나 설명자(800w · 2x) 뒤의 쉼표가
 * 구분자다. 쉼표로만 자르면 주소 안에 쉼표가 든 변환 주소(/cdn-cgi/image/width=800,quality=75/…, Cloudinary · Wix)와
 * data: 자리표시자가 조각나 없는 주소가 된다.
 */
function srcsetCandidates(set: string): { url: string; size: number }[] {
  const out: { url: string; size: number }[] = []
  let i = 0
  while (i < set.length) {
    while (i < set.length && (/\s/.test(set[i]!) || set[i] === ',')) i += 1
    const start = i
    while (i < set.length && !/\s/.test(set[i]!)) i += 1
    let url = set.slice(start, i)
    let descriptor = ''
    if (url.endsWith(',')) url = url.replace(/,+$/, '')
    else {
      const d = i
      while (i < set.length && set[i] !== ',') i += 1
      descriptor = set.slice(d, i).trim()
    }
    if (url) out.push({ url, size: Number.parseFloat(descriptor) || 0 })
  }
  return out
}

/** 페이지 <img>의 주소 후보 — src · 지연 로딩 속성 · srcset의 각 주소. */
function imgSources(img: Element): string[] {
  const out: string[] = []
  for (const attr of ['src', 'data-src', 'data-original', 'data-lazy-src']) {
    const v = img.getAttribute(attr)?.trim()
    if (v) out.push(v)
  }
  for (const attr of ['srcset', 'data-srcset']) {
    const v = img.getAttribute(attr)
    if (v) out.push(...srcsetCandidates(v).map((c) => c.url))
  }
  return out
}

/**
 * 사진의 실제 주소 — 지연 로딩 속성(data-src 등) → srcset의 가장 큰 주소 → data-srcset → src. data: 자리표시자는 건너뛴다.
 */
function lazySource(img: Element): string | null {
  for (const attr of ['data-src', 'data-original', 'data-lazy-src']) {
    const v = img.getAttribute(attr)?.trim()
    if (v && !v.startsWith('data:')) return v
  }
  for (const attr of ['srcset', 'data-srcset']) {
    const widest = srcsetCandidates(img.getAttribute(attr) ?? '')
      .filter((c) => !c.url.startsWith('data:'))
      .sort((a, b) => b.size - a.size)[0]
    if (widest) return widest.url
  }
  const src = img.getAttribute('src')?.trim()
  return src && !src.startsWith('data:') ? src : null
}

/**
 * 사진마다 장면 설명을 고른다 — 그 사진에 붙은 설명 가운데, 여러 사진(GENERIC_ALT_PHOTOS장 이상)에 똑같이 붙은 설명과 꼬리표
 * 모양(TAG_ALT)은 빼고 가장 자주 붙은 것(같으면 긴 것). 장면 설명이 없으면 ''(사진 자리 글자를 쓴다). 브랜드 이름이 든 설명도
 * 장면 설명일 수 있어 이름만으로는 거르지 않는다.
 */
function altChooser(doc: Document, base: string): (key: string) => string {
  const altsByPhoto = new Map<string, Map<string, number>>()
  const photosByAlt = new Map<string, Set<string>>()
  for (const img of doc.querySelectorAll('img')) {
    const alt = cleanPhotoAlt(img.getAttribute('alt') ?? '')
    if (!alt) continue
    const keys = [...new Set(imgSources(img).map((raw) => photoKey(raw, base)).filter((k): k is string => Boolean(k)))]
    if (!keys.length) continue
    for (const key of keys) {
      const alts = altsByPhoto.get(key) ?? new Map<string, number>()
      alts.set(alt, (alts.get(alt) ?? 0) + 1)
      altsByPhoto.set(key, alts)
    }
    // 사진 수는 <img> 하나를 한 장으로, 그 사진의 실제 주소로 센다 — srcset의 크기별 주소(…-300x200.jpg 등)를 여러 사진으로 세면
    // 장면 설명이 꼬리표로 버려지고, 지연 로딩 자리표시자(같은 src)로 세면 모든 사진에 붙은 꼬리표를 한 장으로 본다.
    const real = lazySource(img)
    photosByAlt.set(alt, (photosByAlt.get(alt) ?? new Set<string>()).add((real && photoKey(real, base)) || keys[0]!))
  }
  return (key) => {
    const alts = [...(altsByPhoto.get(key) ?? new Map<string, number>()).entries()].filter(
      ([alt]) => (photosByAlt.get(alt)?.size ?? 0) < GENERIC_ALT_PHOTOS && !TAG_ALT.test(alt),
    )
    alts.sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    return alts[0]?.[0] ?? ''
  }
}

/** 페이지 HTML에서 사진 후보를 고른다(화면 전용 — DOMParser). */
export function extractSitePhotos(html: string, pageUrl: string): Omit<SitePhotoResult, 'pageUrl'> {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const baseHref = doc.querySelector('base[href]')?.getAttribute('href')
  const base = (baseHref && absolute(baseHref, pageUrl)) || pageUrl
  const altOf = altChooser(doc, base)
  const { images, logos, credits } = jsonLdImages(doc)
  const logoKeys = new Set(logos.map((l) => photoKey(l, base)).filter((k): k is string => Boolean(k)))
  const creditKeys = new Set(
    [...credits, ...[...doc.querySelectorAll('img[data-kogl]')].flatMap(imgSources)].map((u) => photoKey(u, base)).filter((k): k is string => Boolean(k)),
  )
  const meta = (prop: string) => doc.querySelector(`meta[property="${prop}"], meta[name="${prop}"]`)?.getAttribute('content')?.trim() ?? ''

  type Found = { raw: string; alt: string; source: SitePhoto['source']; where?: string }
  const seen = new Set<string>()
  const photos: SitePhoto[] = []
  let skippedHttp = 0
  // 후보를 걸러 담는다 — 로고 · 같은 사진 · https가 아닌 사진 · SVG(사진 받기가 받지 않는다)는 뺀다.
  const collect = (found: Found[]) => {
    for (const f of found) {
      if (photos.length >= MAX_PHOTOS) return
      const key = photoKey(f.raw, base)
      const abs = absolute(f.raw, base)
      if (!key || !abs || logoKeys.has(key) || seen.has(key) || /\.svg$/i.test(new URL(abs).pathname)) continue
      seen.add(key)
      const src = canonicalPhotoSrc(abs)
      if (!src) {
        if (abs.startsWith('http:')) skippedHttp += 1
        continue
      }
      photos.push({
        src,
        alt: altOf(key) || f.alt,
        source: f.source,
        ...(f.where ? { where: f.where } : {}),
        ...(creditKeys.has(key) ? { credit: true as const } : {}),
      })
    }
  }
  collect(images.map((im) => ({ raw: im.url, alt: '', source: 'jsonld' as const, ...(im.where ? { where: im.where } : {}) })))
  // 업체 사진이 하나도 남지 않으면(없거나 로고 · http뿐) 대표 사진 → 같은 사이트의 설명 있는 사진으로 넘어간다.
  if (!photos.length) {
    const fallback: Found[] = []
    const og = meta('og:image')
    if (og) fallback.push({ raw: og, alt: cleanPhotoAlt(meta('og:image:alt')), source: 'og' })
    const host = (() => {
      try {
        return new URL(base).host
      } catch {
        return ''
      }
    })()
    for (const img of doc.querySelectorAll('img[alt]')) {
      if (!cleanPhotoAlt(img.getAttribute('alt') ?? '')) continue // 빈 설명은 장식(아이콘)이다
      const raw = lazySource(img)
      const abs = raw ? absolute(raw, base) : null
      if (abs && new URL(abs).host === host) fallback.push({ raw: abs, alt: '', source: 'img' })
    }
    collect(fallback)
  }
  return { photos, skippedHttp }
}

/**
 * 공공 사진 — 자사 사이트 장소 페이지의 구조화 데이터가 출처 · 이용 허락과 함께 단 사진(ImageObject의 license · creditText).
 * 군산각은 장소 페이지마다 한국관광공사 사진을 공공누리 유형과 함께 싣는다(https://gunsan.webforai.kr/places/고군산군도/). 홈페이지
 * 사진(extractSitePhotos)과 따로 읽는다 — 관광지 노드를 업체 사진에서 일부러 빼는 이유(위 주석)가 그대로라서, 출처 · 유형이 기계로
 * 읽히는 사진만 이 길로 받는다. 받는 유형은 공공누리 제1유형뿐이다(그 밖은 유형과 함께 돌려주고 자동 채우기가 뺀다).
 */
export interface PublicPhoto {
  /** https 주소(canonicalPhotoSrc). */
  src: string
  /** 사진을 가진 장소 이름(구조화 데이터) — 없으면 <img> 설명에서 「사진 N」 꼬리표를 뗀 글자. */
  alt: string
  /** 공공누리 유형(1~4) — license(없으면 acquireLicensePage) 주소로 읽는다. 모르면 null. */
  licenseType: 1 | 2 | 3 | 4 | null
  /** 제1유형이고 페이지의 <img data-kogl> 표시와 어긋나지 않으면 'kogl-1', 아니면 null. */
  license: PhotoLicense | null
  /** 출처(creditText → copyrightNotice → creator.name, cleanPhotoCredit). 없으면 ''. */
  creditText: string
}

/** 사진을 가진 곳으로 보지 않는 노드(페이지 · 목록 · 운영사 · 주소 등). */
const NOT_PHOTO_OWNER = /^(ImageObject|WebPage|WebSite|BreadcrumbList|ListItem|Organization|Corporation|Person|PropertyValue|PostalAddress|GeoCoordinates|LocationFeatureSpecification|CreativeWork)$/
/** 장소 페이지 사진의 「○○ 사진 3」 꼬리표 끝. */
const PHOTO_NUMBER_TAG = /\s*(사진|이미지|photo|image)\s*\d*$/i

/** 페이지 HTML에서 공공 사진을 고른다(화면 전용 — DOMParser). 출처 · 이용 허락 표시가 있는 ImageObject만, 같은 사진은 한 번. */
export function extractPublicPhotos(html: string, pageUrl: string): PublicPhoto[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const baseHref = doc.querySelector('base[href]')?.getAttribute('href')
  const base = (baseHref && absolute(baseHref, pageUrl)) || pageUrl
  // <img data-kogl="N"> — 구조화 데이터의 유형과 어긋나면 유형을 모르는 사진으로 본다.
  const marks = new Map<string, Set<string>>()
  const imgAlt = new Map<string, string>()
  for (const img of doc.querySelectorAll('img')) {
    const mark = img.getAttribute('data-kogl')?.trim()
    const alt = cleanPhotoAlt(img.getAttribute('alt') ?? '')
    for (const raw of imgSources(img)) {
      const key = photoKey(raw, base)
      if (!key) continue
      if (mark) marks.set(key, (marks.get(key) ?? new Set<string>()).add(mark))
      if (alt && !imgAlt.has(key)) imgAlt.set(key, alt)
    }
  }
  const found: { node: JsonLdNode; owner?: string }[] = []
  const walk = (value: unknown, owner: string | undefined, depth: number) => {
    if (depth > 12 || !value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const v of value) walk(v, owner, depth + 1)
      return
    }
    const node = value as JsonLdNode
    const types = typesOf(node)
    if (types.includes('ImageObject') && ['license', 'creditText', 'copyrightNotice', 'acquireLicensePage'].some((k) => node[k])) found.push({ node, owner })
    const named = typeof node.name === 'string' && node.name.trim() && types.length > 0 && !types.some((t) => NOT_PHOTO_OWNER.test(t))
    const next = named ? (node.name as string).trim().slice(0, 40) : owner
    for (const [key, v] of Object.entries(node)) {
      if (key !== '@context') walk(v, next, depth + 1)
    }
  }
  for (const script of doc.querySelectorAll('script[type]')) {
    if (!/ld\+json/i.test(script.getAttribute('type') ?? '')) continue
    const raw = script.textContent?.trim()
    if (!raw) continue
    try {
      walk(JSON.parse(raw), undefined, 0)
    } catch (err) {
      console.warn('[sitePhotos] 구조화 데이터를 읽지 못해 공공 사진을 건너뜁니다', err)
    }
  }
  const seen = new Set<string>()
  const out: PublicPhoto[] = []
  for (const { node, owner } of found) {
    const url = imageUrls(node)[0]
    const key = url ? photoKey(url, base) : null
    const abs = url ? absolute(url, base) : null
    const src = abs ? canonicalPhotoSrc(abs) : null
    if (!key || !src || seen.has(key)) continue
    seen.add(key)
    // license가 있으면 그것으로 읽는다 — 공공누리 주소가 아니면(다른 라이선스 · 「공공누리 제3유형」 같은 글자) acquireLicensePage가
    // 제1유형이어도 유형을 모르는 사진이다. license가 없을 때만 acquireLicensePage로 읽는다. 둘 다 있는데 어긋나도 모른다.
    const hasLicense = typeof node.license === 'string' ? node.license.trim() !== '' : Boolean(node.license)
    const byLicense = koglTypeOf(node.license)
    const byPage = koglTypeOf(node.acquireLicensePage)
    const licenseType = hasLicense ? (byPage !== null && byPage !== byLicense ? null : byLicense) : byPage
    const mark = marks.get(key)
    const markAgrees = !mark || (mark.size === 1 && mark.has(String(licenseType)))
    const creator = node.creator && typeof node.creator === 'object' && !Array.isArray(node.creator) ? (node.creator as JsonLdNode).name : undefined
    const creditText = cleanPhotoCredit(node.creditText) || cleanPhotoCredit(node.copyrightNotice) || cleanPhotoCredit(creator)
    out.push({
      src,
      alt: cleanPhotoAlt(owner ?? '') || cleanPhotoAlt((imgAlt.get(key) ?? '').replace(PHOTO_NUMBER_TAG, '')),
      licenseType,
      license: licenseType === 1 && markAgrees ? 'kogl-1' : null,
      creditText,
    })
  }
  return out
}

/** 장소 페이지가 밝힌 장소 — 다른 이름(alternateName) · 주소 · 좌표. 관광공사 사진(3단계)을 찾는 단서다. */
export interface PlaceInfo {
  /** 페이지의 장소 이름 · 다른 이름 가운데 사전 이름과 다른 것(「진포해양테마공원」). */
  names: string[]
  /** 주소 — addressLocality · streetAddress(도시를 읽는다). 없으면 ''. */
  address: string
  lat?: number
  lng?: number
}

/** 장소 노드의 종류 — 관광지 · 장소에 더해 식당 · 숙소(군산각 이성당 장소 페이지는 Restaurant 하나뿐이다). */
const PLACE_TYPE =
  /(Place|TouristAttraction|Landmark|Park|Museum|Beach|Mountain|Island|Market|Church|Temple|Zoo|Aquarium|Garden|Monument|Destination|Venue|Gallery|Restaurant|FoodEstablishment|CafeOrCoffeeShop|Bakery|BarOrPub|LodgingBusiness|Hotel|Motel|Resort|Hostel|BedAndBreakfast|Campground)/

/**
 * 장소 페이지의 장소 노드(좌표나 주소가 있는 관광지 · 장소)를 읽는다 — 이름이 사전 이름과 맞는 노드가 먼저, 없으면 첫 노드. 없으면 null
 * (화면 전용 — DOMParser).
 */
export function extractPlaceInfo(html: string, place: string): PlaceInfo | null {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const nodes: JsonLdNode[] = []
  const walk = (value: unknown, depth: number) => {
    if (depth > 12 || !value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const v of value) walk(v, depth + 1)
      return
    }
    const node = value as JsonLdNode
    if (typesOf(node).some((t) => PLACE_TYPE.test(t)) && (node.geo || node.address)) nodes.push(node)
    for (const [key, v] of Object.entries(node)) if (key !== '@context') walk(v, depth + 1)
  }
  for (const script of doc.querySelectorAll('script[type]')) {
    if (!/ld\+json/i.test(script.getAttribute('type') ?? '')) continue
    const raw = script.textContent?.trim()
    if (!raw) continue
    try {
      walk(JSON.parse(raw), 0)
    } catch (err) {
      console.warn('[sitePhotos] 구조화 데이터를 읽지 못해 장소 정보를 건너뜁니다', err)
    }
  }
  const key = placeKey(place)
  const namesOf = (n: JsonLdNode) =>
    [n.name, ...(Array.isArray(n.alternateName) ? n.alternateName : [n.alternateName])].filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => cleanPhotoAlt(x).slice(0, 60))
  const node = nodes.find((n) => namesOf(n).some((x) => placeKey(x) === key)) ?? nodes[0]
  if (!node) return null
  const addr = (node.address && typeof node.address === 'object' ? node.address : {}) as JsonLdNode
  const address = cleanPhotoAlt([addr.addressLocality, addr.streetAddress].filter((x): x is string => typeof x === 'string').join(' ')).slice(0, 120)
  const geo = (node.geo && typeof node.geo === 'object' ? node.geo : {}) as JsonLdNode
  const lat = Number(geo.latitude)
  const lng = Number(geo.longitude)
  return {
    names: [...new Set(namesOf(node).filter((x) => placeKey(x) !== key && placeKey(x).length >= 3))].slice(0, 3),
    address,
    ...(Number.isFinite(lat) && Number.isFinite(lng) && geo.latitude !== undefined && geo.longitude !== undefined ? { lat, lng } : {}),
  }
}

/** 장소 사전의 한 곳 — 자사 사이트 sitemap의 /places/{이름}/ 페이지. */
export interface PlaceEntry {
  /** 주소의 이름(하이픈은 띄어쓰기로). */
  name: string
  url: string
}

/** 장소 사전의 최대 크기 — 군산각 381곳(2026-11-03). */
const MAX_PLACES = 3000

/**
 * sitemap.xml에서 장소 사전을 만든다 — 사이트와 같은 출처의 /places/{이름}/ 주소만(다른 언어 경로 /en/places/… 는 뺀다). 같은 이름은 한 번.
 * sitemap 색인(sitemapindex)은 읽지 않는다.
 */
export function placeDirectoryOf(sitemapXml: string, siteRoot: string): PlaceEntry[] {
  let origin: string
  try {
    origin = new URL(siteRoot).origin
  } catch {
    return []
  }
  const out: PlaceEntry[] = []
  const names = new Set<string>()
  for (const m of sitemapXml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    if (out.length >= MAX_PLACES) break
    let url: URL
    try {
      url = new URL(m[1]!.replace(/&amp;/g, '&'))
    } catch {
      continue
    }
    const name = url.origin === origin ? placeNameOfPath(url.pathname) : null
    if (!name || names.has(name)) continue
    names.add(name)
    out.push({ name, url: url.href })
  }
  return out
}

const directoryCache = new Map<string, Promise<PlaceEntry[]>>()

/** 사이트의 장소 사전(sitemap.xml) — 사이트 출처마다 화면이 열려 있는 동안 한 번 받는다. sitemap이 없으면(404) 빈 사전. */
export function loadPlaceDirectory(siteRoot: string): Promise<PlaceEntry[]> {
  let origin: string
  try {
    origin = new URL(siteRoot).origin
  } catch {
    return Promise.resolve([])
  }
  const hit = directoryCache.get(origin)
  if (hit) return hit
  const task = fetchPage(`${origin}/sitemap.xml`, { probes: false }).then((page) => {
    if (page.fetchError) throw new Error(page.fetchError)
    if (page.status >= 400) return []
    return placeDirectoryOf(page.html, origin)
  })
  directoryCache.set(origin, task)
  task.catch(() => directoryCache.delete(origin))
  return task
}

/** 한 번에 읽는 장소 페이지 수의 상한 — 군산각 글 80편의 장소 자리는 20곳 안팎이다(2026-11-03). */
export const PUBLIC_PAGE_LIMIT = 30
const PUBLIC_FETCH_CONCURRENCY = 3

export interface PublicPhotoPage {
  /** 장소 사전의 이름. */
  place: string
  pageUrl: string
  photos: PublicPhoto[]
  /** 페이지가 밝힌 장소(다른 이름 · 주소 · 좌표) — 관광공사 사진을 찾는 단서. 없으면 null. */
  info: PlaceInfo | null
}

const publicPageCache = new Map<string, Promise<PublicPhotoPage>>()

function loadPublicPage(entry: PlaceEntry): Promise<PublicPhotoPage> {
  const hit = publicPageCache.get(entry.url)
  if (hit) return hit
  const task = fetchPage(entry.url, { probes: false }).then((page) => {
    if (page.fetchError) throw new Error(page.fetchError)
    if (page.status >= 400) throw new Error(`페이지를 읽지 못했어요 (HTTP ${page.status})`)
    const pageUrl = page.finalUrl || entry.url
    return { place: entry.name, pageUrl, photos: extractPublicPhotos(page.html, pageUrl), info: extractPlaceInfo(page.html, entry.name) }
  })
  publicPageCache.set(entry.url, task)
  task.catch(() => publicPageCache.delete(entry.url))
  return task
}

export interface PublicPhotoLoad {
  pages: PublicPhotoPage[]
  /** 읽지 못한 장소와 이유. */
  failed: { place: string; error: string }[]
  /** 상한(PUBLIC_PAGE_LIMIT)에 걸려 읽지 않은 장소 수. */
  capped: number
}

/** 이름이 사전에 있는 장소의 페이지를 읽어 공공 사진을 모은다 — 앞에서부터 PUBLIC_PAGE_LIMIT곳까지, 페이지마다 캐시. */
export async function loadPublicPhotos(directory: readonly PlaceEntry[], names: readonly string[]): Promise<PublicPhotoLoad> {
  const byName = new Map(directory.map((e) => [e.name, e]))
  const wanted = [...new Set(names)].flatMap((n) => {
    const e = byName.get(n)
    return e ? [e] : []
  })
  const entries = wanted.slice(0, PUBLIC_PAGE_LIMIT)
  const pages: (PublicPhotoPage | null)[] = new Array<PublicPhotoPage | null>(entries.length).fill(null)
  const failed: PublicPhotoLoad['failed'] = []
  let next = 0
  const worker = async () => {
    while (next < entries.length) {
      const i = next
      next += 1
      const entry = entries[i]!
      try {
        pages[i] = await loadPublicPage(entry)
      } catch (err) {
        failed.push({ place: entry.name, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PUBLIC_FETCH_CONCURRENCY, entries.length) }, worker))
  return { pages: pages.filter((p): p is PublicPhotoPage => p !== null), failed, capped: wanted.length - entries.length }
}

/** 장소 페이지의 공공 사진 → 자동 채우기 후보(origin 'public'). 페이지 순서 · 사진 순서 그대로. */
export function publicCandidatesOf(pages: readonly PublicPhotoPage[]): AutoCandidate[] {
  return pages.flatMap((page) =>
    page.photos.map((p) => ({
      src: p.src,
      alt: p.alt || page.place,
      pageUrl: page.pageUrl,
      origin: 'public' as const,
      place: page.place,
      license: p.license,
      licenseType: p.licenseType,
      creditText: p.creditText,
    })),
  )
}

/** 관광공사 사진을 찾을 단서 — 장소 이름과, 읽은 장소 페이지가 있으면 그 페이지의 다른 이름 · 주소 · 좌표. */
export function tourQueryOf(place: string, pages: readonly PublicPhotoPage[]): TourPhotoQuery {
  const info = pages.find((p) => p.place === place)?.info
  if (!info) return { place }
  return {
    place,
    ...(info.names.length ? { names: info.names } : {}),
    ...(info.address ? { address: info.address } : {}),
    ...(info.lat !== undefined && info.lng !== undefined ? { lat: info.lat, lng: info.lng } : {}),
  }
}

export interface TourPhotoLoad {
  results: TourPhotoResult[]
  /** 알림 — 장소마다 찾지 못한 이유 · 서비스 오류(같은 글은 한 번). */
  notes: string[]
  /** 상한(TOUR_PLACE_LIMIT)에 걸리거나 오류로 멈춰 묻지 않은 장소 수. */
  skipped: number
  /** 오류(한도 · 키 · 시간 초과 · 되풀이된 응답 오류 · 요청 실패)로 남은 장소를 묻지 않았다 — 알림은 notes에. */
  stopped: boolean
}

/** 이 오류가 나면 남은 장소는 묻지 않는다 — 한도 · 키는 다음 장소도 같고, 시간 초과면 장소마다 10초씩 기다리게 된다. */
const TOUR_STOP_ERRORS: ReadonlySet<string> = new Set(['QUOTA', 'KEY', 'NO_KEY', 'TIMEOUT'])
/** 그 밖의 응답 오류(UPSTREAM)가 이만큼 되풀이되면 남은 장소는 묻지 않는다. */
const TOUR_UPSTREAM_STOP = 2

/**
 * 장소들의 관광공사 사진을 서버(/api/tourapi/photos)에 묻는다 — 앞에서부터, 둘씩. TourAPI를 새로 부른 장소(liveCalls가 0이 아닌 장소)가
 * TOUR_PLACE_LIMIT곳에 닿으면 멈춘다 — 캐시에서 온 장소(이미 찾았거나 사진이 없다고 나온 곳)는 세지 않으므로, 다시 누르면 뒤 장소를 이어서
 * 묻는다. 한도 · 키 · 시간 초과(TOUR_STOP_ERRORS) 오류가 나거나 응답 오류가 되풀이되면 남은 장소는 묻지 않는다. 장소 페이지를 읽었으면 그
 * 페이지의 다른 이름 · 주소 · 좌표를 함께 보낸다(tourQueryOf).
 */
export async function loadTourPhotosFor(tenantId: string, places: readonly string[], pages: readonly PublicPhotoPage[]): Promise<TourPhotoLoad> {
  const wanted = [...new Set(places)]
  const results: (TourPhotoResult | null)[] = new Array<TourPhotoResult | null>(wanted.length).fill(null)
  const notes: string[] = []
  const note = (n: string) => {
    if (!notes.includes(n)) notes.push(n)
  }
  let stopped = false
  let upstream = 0
  /** TourAPI를 새로 부른 장소 수와 아직 답을 기다리는 장소 수 — 기다리는 장소도 새로 부를 수 있으니 상한에 함께 센다. */
  let live = 0
  let running = 0
  let next = 0
  const worker = async () => {
    while (!stopped && next < wanted.length && live + running < TOUR_PLACE_LIMIT) {
      const i = next
      next += 1
      running += 1
      try {
        const r = await loadTourPhotos(tenantId, tourQueryOf(wanted[i]!, pages))
        results[i] = r
        if (r.liveCalls !== 0) live += 1
        if (r.error === 'UPSTREAM') upstream += 1
        if ((r.error && TOUR_STOP_ERRORS.has(r.error)) || upstream >= TOUR_UPSTREAM_STOP) stopped = true
        if (r.error && r.note) note(r.note)
      } catch (err) {
        live += 1
        stopped = true
        note(err instanceof Error ? err.message : String(err))
      } finally {
        running -= 1
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, wanted.length) }, worker))
  const done = results.filter((r): r is TourPhotoResult => r !== null)
  return { results: done, notes, skipped: wanted.length - done.length, stopped }
}

/** 관광공사 사진 → 자동 채우기 후보(origin 'public' · tour). 장소 순서 · 받은 순서 그대로(국문 관광정보 사진이 앞). */
export function tourCandidatesOf(results: readonly TourPhotoResult[]): AutoCandidate[] {
  return results.flatMap((r) =>
    r.photos.map((p) => ({
      src: p.src,
      alt: p.title || r.place,
      pageUrl: p.sourcePageUrl,
      origin: 'public' as const,
      place: r.place,
      license: p.license,
      licenseType: p.licenseType,
      creditText: p.creditText,
      tour: p.source,
      ...(p.month ? { month: p.month } : {}),
      ...(p.keywords ? { keywords: p.keywords } : {}),
    })),
  )
}

/** 지역 사진(장소 없는 자리 — 관광사진 정보를 브랜드 도시로 찾은 사진) → 자동 채우기 후보(origin public · tour gallery, 장소 없음). 받은 순서 그대로. */
export function regionCandidatesOf(result: TourPhotoResult): AutoCandidate[] {
  return result.photos.map((p) => ({
    src: p.src,
    alt: p.title,
    pageUrl: p.sourcePageUrl,
    origin: 'public' as const,
    license: p.license,
    licenseType: p.licenseType,
    creditText: p.creditText,
    tour: p.source,
    ...(p.month ? { month: p.month } : {}),
    ...(p.keywords ? { keywords: p.keywords } : {}),
    ...(p.location ? { location: p.location } : {}),
  }))
}

/** 한 번 누를 때 장소마다 새로 읽는 사진 장면 수의 상한(관광공사 사진은 촬영 연월이 고루 섞이게). */
export const SCENE_PER_PLACE = 40
/** 한 번 누를 때 새로 읽는 사진 장면 수의 상한 — 사진 한 장에 비전 모델 한 번. */
export const SCENE_RUN_LIMIT = 150
/** 한 번에 묻는 새 장면 수 — 화면이 진행(n/m)을 보인다. */
const SCENE_CHUNK = 12
/** 읽어 둔 장면만 물을 때 한 번에 묻는 주소 수(서버 SCENE_MAX_SRCS). */
const SCENE_PEEK = 300

export interface SceneLoad {
  /** 이 PC에서 새로 읽을 수 있었나(키가 있는가). */
  available: boolean
  /** 이번에 비전 모델을 부른 횟수(비용). */
  calls: number
  /** 이번에 새로 읽은 장면 수. */
  described: number
  /** 이미 읽어 둔 장면을 받은 수. */
  cached: number
  /** 상한에 걸려 이번에 읽지 않고 남긴 사진 수. */
  left: number
  /** 읽지 못한 사진(받지 못함 · 형식 · 모양이 틀림). */
  failed: string[]
  notes: string[]
}

/** 한 번 누를 때(실행 하나) 새로 읽을 수 있는 남은 수 — loadScenesFor를 여러 번 불러도(관광공사 사진 앞뒤) 함께 줄어든다. */
export interface SceneBudget {
  /** 남은 수(모두 합쳐). */
  total: number
  /** 장소마다 이미 읽은 수. */
  perPlace: Map<string, number>
}

/** 실행 하나의 새 예산 — 모두 SCENE_RUN_LIMIT장, 장소마다 SCENE_PER_PLACE장. */
export function newSceneBudget(): SceneBudget {
  return { total: SCENE_RUN_LIMIT, perPlace: new Map() }
}

/**
 * 자동 채우기가 견줄 사진(sceneWanted)의 장면을 scenes에 채운다 — 먼저 읽어 둔 장면을 받고(비용 없음), 없는 사진은 장소마다
 * SCENE_PER_PLACE장 · 모두 SCENE_RUN_LIMIT장까지(budget — 한 실행에서 함께 센다, scenesToRead — 관광공사 사진은 촬영 연월이 고루)
 * SCENE_CHUNK장씩 새로 읽는다. 키가 없거나 서버가 멈추면(키 · 한도 · 크레딧 · Claude 과부하 — 남은 사진이 pending) 멈추고 알린다(그때까지
 * 받은 장면은 쓴다). 새로 읽는 묶음 요청이 실패하면(시간 초과 등) 거기서 멈추되, 앞 묶음까지의 호출 수 · 읽은 수는 그대로 돌려주고 남은
 * 사진 수와 이유를 알린다(비용 안내가 실제보다 적게 나오지 않게). onProgress(n, m)는 새로 읽기의 진행.
 */
export async function loadScenesFor(
  wanted: readonly SceneWant[],
  scenes: Map<string, PhotoScene>,
  onProgress?: (done: number, total: number) => void,
  budget: SceneBudget = newSceneBudget(),
): Promise<SceneLoad> {
  const out: SceneLoad = { available: true, calls: 0, described: 0, cached: 0, left: 0, failed: [], notes: [] }
  const note = (n: string) => {
    if (!out.notes.includes(n)) out.notes.push(n)
  }
  const ask = [...new Set(wanted.map((w) => w.src).filter((src) => !scenes.has(src)))]
  const missing = new Set<string>()
  for (let i = 0; i < ask.length; i += SCENE_PEEK) {
    const r = await loadPhotoScenes(ask.slice(i, i + SCENE_PEEK), 0)
    for (const [src, scene] of Object.entries(r.scenes)) scenes.set(src, scene)
    out.cached += Object.keys(r.scenes).length
    for (const src of r.missing) if (!r.failed[src]) missing.add(src)
    out.failed.push(...Object.keys(r.failed))
    out.available &&= r.available
    r.notes.forEach(note)
  }
  if (!out.available || !missing.size) return out
  const plan = scenesToRead(wanted, missing, {
    perPlace: SCENE_PER_PLACE,
    total: Math.max(0, budget.total),
    used: budget.perPlace,
    caps: { [REGION_SCENE_PLACE]: REGION_SCENE_LIMITS.perRun },
  })
  out.left = plan.left
  budget.total -= plan.read.length
  const placeOf = new Map(wanted.map((w) => [w.src, w.place ?? '']))
  for (const src of plan.read) {
    const place = placeOf.get(src) ?? ''
    if (place) budget.perPlace.set(place, (budget.perPlace.get(place) ?? 0) + 1)
  }
  onProgress?.(0, plan.read.length)
  let done = 0
  for (let i = 0; i < plan.read.length; i += SCENE_CHUNK) {
    const chunk = plan.read.slice(i, i + SCENE_CHUNK)
    let r: Awaited<ReturnType<typeof loadPhotoScenes>>
    try {
      r = await loadPhotoScenes(chunk, chunk.length)
    } catch (e) {
      out.left += plan.read.length - done
      note(`사진 장면을 다 읽지 못했어요 — ${e instanceof Error ? e.message : String(e)} 남은 사진 ${plan.read.length - done}장은 다시 누르면 이어서 읽어요.`)
      break
    }
    for (const [src, scene] of Object.entries(r.scenes)) scenes.set(src, scene)
    out.calls += r.calls
    out.described += r.described
    out.failed.push(...Object.keys(r.failed))
    r.notes.forEach(note)
    done += chunk.length
    onProgress?.(Math.min(done, plan.read.length), plan.read.length)
    // 키 · 한도 오류로 남긴 사진이 있으면 멈춘다 — 남은 묶음도 같은 이유로 못 읽는다.
    if (r.pending > 0) {
      out.left += plan.read.length - done + r.pending
      break
    }
  }
  const cappedPlaces = plan.cappedPlaces.filter((p) => p !== REGION_SCENE_PLACE)
  if (cappedPlaces.length) note(`장소마다 한 번에 ${SCENE_PER_PLACE}장까지 장면을 읽어요(${cappedPlaces.join(' · ')}) — 다시 누르면 남은 사진을 이어서 읽어요.`)
  if (plan.cappedPlaces.includes(REGION_SCENE_PLACE)) {
    note(`장소 없는 자리의 지역 사진은 한 번에 ${REGION_SCENE_LIMITS.perRun}장까지 장면을 읽어요 — 다시 누르면 남은 사진을 이어서 읽어요.`)
  }
  return out
}

/** 장면을 읽고 다시 고르기를 되풀이하는 최대 횟수(pickReadingScenes). */
const SCENE_PICK_ROUNDS = 3

/**
 * 장면으로 고르기 — 고르고(pick), 고르는 데 쓰일 사진(sceneWanted) 가운데 아직 묻지 않은 사진의 장면을 읽고(read) 다시 고른다. 장면이
 * 생기면 고르는 길이 바뀌어 새 사진이 쓰일 수 있어(홈페이지 사진으로 채운 자리 — 그 사진의 장면이 어긋나 빠지면 처음에는 묻지 않은 그
 * 자리의 장소 사진이 쓰인다) 새로 쓰일 사진이 없을 때까지 SCENE_PICK_ROUNDS번까지 되풀이한다. asked는 이미 물은 사진(실행 하나에서 함께 —
 * 같은 사진을 두 번 묻지 않는다).
 */
export async function pickReadingScenes(
  pick: () => AutoPickResult,
  read: (wanted: readonly SceneWant[]) => Promise<void>,
  asked: Set<string> = new Set(),
): Promise<AutoPickResult> {
  let result = pick()
  for (let round = 0; round < SCENE_PICK_ROUNDS; round += 1) {
    const fresh = result.sceneWanted.filter((w) => !asked.has(w.src))
    if (!fresh.length) break
    for (const w of fresh) asked.add(w.src)
    await read(fresh)
    result = pick()
  }
  return result
}

/** 사이트 출처 — 사진을 찾는 페이지(photoPageOf)의 루트. */
export function siteRootOf(pageUrl: string | undefined): string | null {
  if (!pageUrl) return null
  try {
    return `${new URL(/^https?:\/\//i.test(pageUrl) ? pageUrl : `https://${pageUrl}`).origin}/`
  } catch {
    return null
  }
}

/**
 * 출처 없는 공공 사진에 붙일 출처를 찾는다(「출처 붙이기」) — 단서(사진 설명 · 홈페이지에서 그 사진에 붙은 설명, 예: 「대장도 사진 1」)에
 * 나온 장소의 페이지를 읽어, 같은 사진이 공공누리 제1유형 · 출처와 함께 있으면 그 출처. 못 찾으면 null(사진은 내보내지 않는다).
 */
export async function findPublicCredit(
  siteRoot: string,
  src: string,
  hints: readonly string[],
): Promise<{ fields: PublicPhotoFields; pageUrl: string; place: string } | null> {
  const want = canonicalPhotoSrc(src)
  if (!want) return null
  const directory = await loadPlaceDirectory(siteRoot)
  const names = directory.map((e) => e.name)
  const places = [...new Set(hints.flatMap((h) => findPlace(h, names) ?? []))]
  if (!places.length) return null
  const { pages } = await loadPublicPhotos(directory, places)
  for (const c of publicCandidatesOf(pages)) {
    const fields = c.src === want ? publicCandidateFields(c) : null
    if (fields) return { fields, pageUrl: c.pageUrl, place: c.place ?? '' }
  }
  return null
}

/** 페이지를 받아 후보를 고른다. 같은 페이지는 화면이 열려 있는 동안 다시 받지 않는다(fresh면 다시 받는다). */
const cache = new Map<string, Promise<SitePhotoResult>>()
export function loadSitePhotos(pageUrl: string, fresh = false): Promise<SitePhotoResult> {
  const hit = cache.get(pageUrl)
  if (hit && !fresh) return hit
  const task = fetchPage(pageUrl, { probes: false }).then((page) => {
    if (page.fetchError) throw new Error(page.fetchError)
    if (page.status >= 400) throw new Error(`페이지를 읽지 못했어요 (HTTP ${page.status})`)
    return { pageUrl: page.finalUrl || pageUrl, ...extractSitePhotos(page.html, page.finalUrl || pageUrl) }
  })
  cache.set(pageUrl, task)
  task.catch(() => cache.delete(pageUrl))
  return task
}

/**
 * 글에 들어간 홈페이지 사진 — 같은 사진은 한 번(글 순서). 「사진 N장 받기」의 N과 파일 순서다. 사진 사용 확인이 없으면(의료 업종은
 * 의료광고 확인까지) 내보내기에도 넣지 않으므로 받을 사진도 없다(publishArticleParts와 같은 기준).
 */
export function articlePhotoFiles(
  stored: StoredDraft,
  ctx: { settings: PublishSettings | null | undefined; industry: string | undefined },
): AppliedPhoto[] {
  return uniquePhotoFiles(withPhotos(publishMarkdownOf(stored), exportPhotoPicks(ctx.settings, ctx.industry, stored.photos)).applied)
}

/** 글에 들어간 사진에서 받을 파일 — 같은 사진은 한 번(글 순서). 채널 줄은 다듬은 글에 들어간 사진으로 부른다(channelArticleParts). */
export function uniquePhotoFiles(applied: readonly AppliedPhoto[]): AppliedPhoto[] {
  const seen = new Set<string>()
  return applied.filter((p) => {
    if (seen.has(p.src)) return false
    seen.add(p.src)
    return true
  })
}

const PHOTO_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif' }

/**
 * 사진 파일 이름 — 「사진1-소제목.jpg」. 블로그 편집기가 붙여 넣은 바깥 사진을 버리면 사진 자리 안내 글자도 함께 사라져, 넣을
 * 위치를 이 이름으로 찾는다. 확장자는 서버가 파일 앞 바이트로 정한 형식에서만 정한다.
 */
export function photoFileName(k: number, photo: Pick<AppliedPhoto, 'heading' | 'slotAlt'>, type: string): string {
  return `사진${k}-${safeFileName(photo.heading || photo.slotAlt)}.${PHOTO_EXT[type] ?? 'jpg'}`
}

/** 글 하나의 「사진 N장 받기」에 함께 받는 공공 사진 출처 파일 이름. */
export const ARTICLE_CREDITS_FILE = '사진 출처.txt'

/** 출처 파일의 한 줄 — 글 번호(작성자 묶음만) · 저장한 사진 파일 이름 · 그 사진. 출처가 없는 사진(홈페이지 사진)은 건너뛴다. */
export interface PhotoCreditRow {
  article?: string
  name: string
  photo: AppliedPhoto
}

/**
 * 공공 사진 출처 파일 내용 — 공공 사진마다 한 줄(탭으로 나눔): (글 번호 ·) 사진 파일 이름 · 출처 · 유형 · 원 주소 · 받은 날. 블로그 편집기에
 * 사진 파일을 직접 올리면 .html · 붙여 넣은 글의 사진 설명(출처 줄)이 따라가지 않을 수 있어, 사진마다 출처를 적도록 함께 둔다. 메모장에서
 * 열리게 줄 끝은 CRLF. 글 번호 칸은 글 번호가 있는 줄이 있을 때만(작성자 묶음 src/lib/writerBundle.ts).
 */
export function photoCreditsTable(rows: readonly PhotoCreditRow[], today: string): string {
  const credited = rows.filter((r) => r.photo.credit)
  const withArticle = credited.some((r) => r.article !== undefined)
  const cells = (article: string, rest: string[]) => (withArticle ? [article, ...rest] : rest).join('\t')
  const first = credited[0]?.photo.credit
  const lines = [
    '사진 출처 — 아래 사진은 공공누리 제1유형 공공 사진입니다. 블로그에 올릴 때 사진 바로 아래에 출처와 이용 허락 링크를 적어 주세요.',
    ...(first ? [`예: 사진: ${first.credit}, ${PHOTO_LICENSES[first.license].name} (${first.creditUrl})`] : []),
    '「제공」 · 「협찬」 · 「공식」처럼 공공기관과 특별한 관계로 보이는 말은 쓰지 않습니다. 사진 속 인물의 초상권은 이 이용 허락에 들어 있지 않습니다.',
    '',
    cells('글 번호', ['사진 파일 이름', '출처', '유형', '원 주소', '받은 날']),
    ...credited.map(({ article, name, photo }) => {
      const c = photo.credit!
      return cells(article ?? '', [name, c.credit, `${PHOTO_LICENSES[c.license].name} (${c.creditUrl})`, photo.src, today])
    }),
  ]
  return `${lines.join('\r\n')}\r\n`
}

/**
 * 고른 사진을 한 장씩 내려받는다(저장 창이 장마다 뜰 수 있다 — 글 하나에 3장까지). 공공 사진이 있으면 「사진 출처.txt」도 받는다 —
 * 붙여 넣은 글에서 바깥 사진(<figure>)이 버려지면 사진 설명의 출처 줄도 함께 사라져, 받은 파일을 직접 올리는 작성자가 출처를 적을 수
 * 있게. 하나라도 실패하면 throw — 그때까지 받은 공공 사진이 있으면 출처 파일은 받아 둔다.
 */
export async function downloadArticlePhotos(tenantId: string, stored: StoredDraft, photos: AppliedPhoto[]): Promise<void> {
  const rows: PhotoCreditRow[] = []
  const saveCredits = () => {
    if (!rows.some((r) => r.photo.credit)) return
    downloadBlob(ARTICLE_CREDITS_FILE, new Blob([photoCreditsTable(rows, todayKst())], { type: 'text/plain;charset=utf-8' }))
  }
  try {
    for (const [i, p] of photos.entries()) {
      const blob = await fetchDraftPhotoFile(tenantId, { actionId: stored.actionId, generatedAt: stored.generatedAt, place: p.place })
      const name = photoFileName(i + 1, p, blob.type)
      downloadBlob(name, blob)
      rows.push({ name, photo: p })
    }
  } catch (err) {
    saveCredits()
    throw err
  }
  saveCredits()
}
