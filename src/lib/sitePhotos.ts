import type { TenantSummary } from './api'
import { canonicalPhotoSrc, cleanPhotoAlt } from './articlePhotos'
import { fetchPage } from './aeo/fetchPage'
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
function photoKey(raw: string, base: string): string | null {
  let url: URL
  try {
    url = new URL(raw, base)
  } catch {
    return null
  }
  if (url.pathname.endsWith('/_next/image')) {
    const inner = url.searchParams.get('url')
    if (inner) return photoKey(inner, url.href)
  }
  return `${url.origin}${url.pathname}`
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

/** 구조화 데이터의 업체 사진(주소 · 가진 곳 이름)과 로고 주소. */
function jsonLdImages(doc: Document): { images: { url: string; where?: string }[]; logos: string[] } {
  const images: { url: string; where?: string }[] = []
  const logos: string[] = []
  const walk = (value: unknown, depth: number) => {
    if (depth > 12 || !value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const v of value) walk(v, depth + 1)
      return
    }
    const node = value as JsonLdNode
    logos.push(...imageUrls(node.logo))
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
  return { images, logos }
}

/** 페이지 <img>의 주소 후보 — src · srcset의 각 주소 · 지연 로딩 속성. */
function imgSources(img: Element): string[] {
  const out: string[] = []
  for (const attr of ['src', 'data-src', 'data-original', 'data-lazy-src']) {
    const v = img.getAttribute(attr)?.trim()
    if (v) out.push(v)
  }
  for (const attr of ['srcset', 'data-srcset']) {
    const v = img.getAttribute(attr)
    if (v) out.push(...v.split(',').map((part) => part.trim().split(/\s+/)[0] ?? '').filter(Boolean))
  }
  return out
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
    for (const raw of imgSources(img)) {
      const key = photoKey(raw, base)
      if (!key) continue
      const alts = altsByPhoto.get(key) ?? new Map<string, number>()
      alts.set(alt, (alts.get(alt) ?? 0) + 1)
      altsByPhoto.set(key, alts)
      photosByAlt.set(alt, (photosByAlt.get(alt) ?? new Set<string>()).add(key))
    }
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
  const { images, logos } = jsonLdImages(doc)
  const logoKeys = new Set(logos.map((l) => photoKey(l, base)).filter((k): k is string => Boolean(k)))
  const meta = (prop: string) => doc.querySelector(`meta[property="${prop}"], meta[name="${prop}"]`)?.getAttribute('content')?.trim() ?? ''

  const found: { raw: string; alt: string; source: SitePhoto['source']; where?: string }[] = []
  const add = (raw: string, rest: Omit<SitePhoto, 'src' | 'alt'> & { alt?: string }) => found.push({ raw, ...rest, alt: rest.alt ?? '' })
  for (const im of images) add(im.url, { source: 'jsonld', ...(im.where ? { where: im.where } : {}) })
  if (!found.length) {
    const og = meta('og:image')
    if (og) add(og, { source: 'og', alt: cleanPhotoAlt(meta('og:image:alt')) })
    const host = (() => {
      try {
        return new URL(base).host
      } catch {
        return ''
      }
    })()
    for (const img of doc.querySelectorAll('img[alt]')) {
      const src = imgSources(img)[0]
      const abs = src ? absolute(src, base) : null
      if (abs && new URL(abs).host === host) add(abs, { source: 'img' })
    }
  }

  const seen = new Set<string>()
  const photos: SitePhoto[] = []
  let skippedHttp = 0
  for (const f of found) {
    const key = photoKey(f.raw, base)
    const abs = absolute(f.raw, base)
    if (!key || !abs || logoKeys.has(key) || seen.has(key)) continue
    seen.add(key)
    const src = canonicalPhotoSrc(abs)
    if (!src) {
      if (abs.startsWith('http:')) skippedHttp += 1
      continue
    }
    photos.push({ src, alt: altOf(key) || f.alt, source: f.source, ...(f.where ? { where: f.where } : {}) })
    if (photos.length >= MAX_PHOTOS) break
  }
  return { photos, skippedHttp }
}

/** 페이지를 받아 후보를 고른다. 같은 페이지는 화면이 열려 있는 동안 다시 받지 않는다(fresh면 다시 받는다). */
const cache = new Map<string, Promise<SitePhotoResult>>()
export function loadSitePhotos(pageUrl: string, fresh = false): Promise<SitePhotoResult> {
  const hit = cache.get(pageUrl)
  if (hit && !fresh) return hit
  const task = fetchPage(pageUrl).then((page) => {
    if (page.fetchError) throw new Error(page.fetchError)
    if (page.status >= 400) throw new Error(`페이지를 읽지 못했어요 (HTTP ${page.status})`)
    return { pageUrl: page.finalUrl || pageUrl, ...extractSitePhotos(page.html, page.finalUrl || pageUrl) }
  })
  cache.set(pageUrl, task)
  task.catch(() => cache.delete(pageUrl))
  return task
}
