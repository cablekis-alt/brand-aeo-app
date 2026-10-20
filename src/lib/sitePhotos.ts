import { fetchDraftPhotoFile, type StoredDraft, type TenantSummary } from './api'
import { canonicalPhotoSrc, cleanPhotoAlt, photosAllowed, withPhotos, type AppliedPhoto } from './articlePhotos'
import { publishMarkdownOf } from './draftGaps'
import { downloadBlob, safeFileName } from './markdownFile'
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
  const { images, logos } = jsonLdImages(doc)
  const logoKeys = new Set(logos.map((l) => photoKey(l, base)).filter((k): k is string => Boolean(k)))
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
      photos.push({ src, alt: altOf(key) || f.alt, source: f.source, ...(f.where ? { where: f.where } : {}) })
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

/**
 * 글에 들어간 홈페이지 사진 — 같은 사진은 한 번(글 순서). 「사진 N장 받기」의 N과 파일 순서다. 사진 사용 확인이 없으면(의료 업종은
 * 의료광고 확인까지) 내보내기에도 넣지 않으므로 받을 사진도 없다(publishArticleParts와 같은 기준).
 */
export function articlePhotoFiles(
  stored: StoredDraft,
  ctx: { settings: PublishSettings | null | undefined; industry: string | undefined },
): AppliedPhoto[] {
  if (!photosAllowed(ctx.settings, ctx.industry)) return []
  const seen = new Set<string>()
  return withPhotos(publishMarkdownOf(stored), stored.photos).applied.filter((p) => {
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

/** 고른 사진을 한 장씩 내려받는다(저장 창이 장마다 뜰 수 있다 — 글 하나에 3장까지). 하나라도 실패하면 throw. */
export async function downloadArticlePhotos(tenantId: string, stored: StoredDraft, photos: AppliedPhoto[]): Promise<void> {
  for (const [i, p] of photos.entries()) {
    const blob = await fetchDraftPhotoFile(tenantId, { actionId: stored.actionId, generatedAt: stored.generatedAt, place: p.place })
    downloadBlob(photoFileName(i + 1, p, blob.type), blob)
  }
}
