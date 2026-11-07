import type { PhotoScene } from './photoScenes'

/**
 * 업주 사진 보관함(2026-11-06 — 방법 1) — 업주(자기 시설) 사진을 브랜드 홈페이지에 올리지 않고 운영자 PC에만 두고 글의 사진 자리에 쓴다.
 * 사진은 서버가 PIPELINE_DATA_DIR/<tenant>/owner-photos/<id>.<ext>에 두고(server/ownerPhotos.ts), 글의 사진 기록에는 앱 주소
 * (/api/owner-photos/<tenant>/<id>.<ext>)만 적는다 — 자사 화면 · 앱이 그린 지도와 같은 길이다(origin 'owner'). 앱 밖으로 나가는 글(.html ·
 * 서식째 복사)에는 그림을 문서 안에 넣고(src/lib/screenExport.ts), 「사진 N장 받기」 · 작성자 묶음에는 파일을 준다(서버 photo-file).
 * 공개 주소가 아니라 .html의 구조화 데이터(JSON-LD image) · og:image에는 넣지 않는다.
 *
 * 올릴 때 사진마다 장면 설명(alt — 자동 채우기가 사진 자리 글자와 맞추는 글자)과 권리 확인(업주 · 촬영자에게 홈페이지 · 블로그 게시
 * 허락을 받았다)을 함께 받고, 장면(바깥 · 실내 · 시간 · 사람)은 올릴 때 한 번 읽어 둔다(server/photoScenes.ts describeLocalPhoto).
 * DOM을 쓰지 않는다(서버 · 검증 스크립트가 같은 파일을 쓴다).
 */

/** 받는 형식 — 파일 앞 바이트로 가린다(확장자 · 화면이 보낸 형식은 믿지 않는다). */
export const OWNER_PHOTO_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const
export type OwnerPhotoMime = keyof typeof OWNER_PHOTO_TYPES
export type OwnerPhotoExt = (typeof OWNER_PHOTO_TYPES)[OwnerPhotoMime]

/** 한 장의 최대 크기 — 화면이 올리기 전에 가로 2400px · JPEG로 줄인다(OWNER_PHOTO_UPLOAD_EDGE). */
export const OWNER_PHOTO_MAX_BYTES = 12 * 1024 * 1024
/** 브랜드 하나에 두는 최대 장수. */
export const OWNER_PHOTO_MAX = 200
/** 올리기 전에 줄이는 긴 변(px) — 블로그 그림 줄(720px)의 2배 이상이면 충분하고, 장면 읽기 한도(3.75MB)도 넘지 않는다. */
export const OWNER_PHOTO_UPLOAD_EDGE = 2400
/** 사진 id — 파일 sha256의 앞 16자(소문자 16진수). 같은 사진을 두 번 올리면 같은 id다. */
export const OWNER_PHOTO_ID = /^[0-9a-f]{16}$/

/** 권리 확인 — 누가 허락했나(업주 · 촬영자 등 짧은 글자)와 확인한 때(서버 시각), 메모. */
export interface OwnerPhotoRights {
  confirmedAt: string
  /** 허락한 사람(「업주」 · 「업주 지인(촬영자)」) — 이름은 적지 않는다. */
  holder: string
  note?: string
}

/**
 * 「제품 화면」 표시(2026-11-07 설계 D1) — 회사가 준 제품 화면 캡처를 사진이 아니라 화면으로 쓴다(자동 채우기는 자리 글자가 그 제품과 화면
 * 낱말을 함께 말하는 자리에만 넣는다 — src/lib/photoAutoPick.ts 업주 화면 단계). product는 제품 이름 한 줄(PRODUCT_SCREEN_MAX자까지) — 쉼표로
 * 다른 이름을 덧붙인다(「NEGOTIUM, 네고시움」 — 앞이 대표 이름). 표시가 결정한다 — 장면이 화면으로 읽혀도 표시하지 않으면 제안만 한다.
 */
export interface OwnerProductScreen {
  product: string
}

/** 제품 이름 글자 수 상한(쉼표 · 띄어쓰기 포함). */
export const PRODUCT_SCREEN_MAX = 30
/** 이름 하나의 비교 글자 최소 길이. */
const PRODUCT_NAME_MIN = 2

/** 제품 이름 비교용 글자 — 띄어쓰기 · 문장부호를 빼고 소문자로(「NEGOTIUM」 · 「negotium」 · 「Nego tium」은 같다). */
export function productKey(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** 제품 이름들 — 쉼표로 나눈 이름 가운데 비교 글자가 2자 이상인 것(앞이 대표 이름). */
export function productNames(product: string): { name: string; key: string }[] {
  return product
    .split(/[,，]/)
    .map((raw) => raw.replace(/\s+/g, ' ').trim())
    .map((name) => ({ name, key: productKey(name) }))
    .filter((n) => n.key.length >= PRODUCT_NAME_MIN)
}

/** 대표 이름(첫 이름) — 칩 · 까닭 글자에 쓴다. 이름이 없으면 ''. */
export function productLabel(product: string): string {
  return productNames(product)[0]?.name ?? ''
}

/** 제품 이름 정리 — 한 줄 · 이름마다 띄어쓰기 정리 · 2자 미만 이름은 뺀다. 이름이 없거나 PRODUCT_SCREEN_MAX자를 넘으면 null. */
export function cleanProductScreen(raw: unknown): OwnerProductScreen | null {
  if (typeof raw !== 'string') return null
  const product = productNames(raw.replace(/[\p{Cc}<>]/gu, ' '))
    .map((n) => n.name)
    .join(', ')
  return product && product.length <= PRODUCT_SCREEN_MAX ? { product } : null
}

/**
 * 장면이 화면으로 읽힌 사진의 제품 이름 제안 — 설명의 첫 로마자 낱말(「ADO2 첫 화면 — …」 → 「ADO2」, 「robots.txt 화면」 → 「robots.txt」).
 * 없으면 ''. 제안일 뿐 — 사람이 고쳐 표시한다.
 */
export function productGuessFromAlt(alt: string): string {
  return /[A-Za-z][A-Za-z0-9]*(?:[.+-][A-Za-z0-9]+)*/.exec(alt)?.[0] ?? ''
}

/** 보관한 업주 사진 하나(owner-photos.json). */
export interface OwnerPhotoRecord {
  id: string
  ext: OwnerPhotoExt
  mime: OwnerPhotoMime
  bytes: number
  width?: number
  height?: number
  /** 장면 설명 — 자동 채우기가 사진 자리 글자와 맞춘다(cleanPhotoAlt). */
  alt: string
  uploadedAt: string
  rights: OwnerPhotoRights
  /** 올릴 때 읽은 장면 — 키가 없거나 읽지 못하면 없다(sceneError). */
  scene?: PhotoScene
  sceneError?: string
  /** 「제품 화면」 표시 — 있으면 사진이 아니라 그 제품의 화면 캡처다(사진 자리에 넣지 않는다). */
  productScreen?: OwnerProductScreen
}

/** 화면에 주는 모양 — 앱 주소를 단다. */
export interface OwnerPhotoView extends OwnerPhotoRecord {
  src: string
}

export function isOwnerPhotoId(v: unknown): v is string {
  return typeof v === 'string' && OWNER_PHOTO_ID.test(v)
}

/** 업주 사진의 앱 주소 — /api/owner-photos/<tenant>/<id>.<ext>. */
export function ownerPhotoAppSrc(tenantId: string, id: string, ext: OwnerPhotoExt): string {
  return `/api/owner-photos/${encodeURIComponent(tenantId)}/${id}.${ext}`
}

/** 앱 주소를 읽는다 — 모양이 맞지 않으면 null. */
export function parseOwnerPhotoAppSrc(src: unknown): { tenantId: string; id: string; ext: OwnerPhotoExt } | null {
  if (typeof src !== 'string') return null
  const m = /^\/api\/owner-photos\/([^/?#]+)\/([0-9a-f]{16})\.(jpg|png|webp)$/.exec(src)
  if (!m) return null
  let tenantId: string
  try {
    tenantId = decodeURIComponent(m[1]!)
  } catch {
    return null
  }
  if (!tenantId || /[/\\]/.test(tenantId) || tenantId === '.' || tenantId === '..') return null
  return { tenantId, id: m[2]!, ext: m[3] as OwnerPhotoExt }
}

/** 파일 앞 바이트로 형식을 가린다 — JPEG(FF D8 FF) · PNG(89 50 4E 47 …) · WEBP(RIFF … WEBP). 아니면 null. */
export function sniffOwnerPhotoType(bytes: Uint8Array): OwnerPhotoMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) return 'image/png'
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to))
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  return null
}

/** 그림의 가로 · 세로 — 머리 부분만 읽는다. 읽지 못하면 null. */
export function ownerPhotoSize(bytes: Uint8Array, mime: OwnerPhotoMime): { width: number; height: number } | null {
  const u16be = (i: number) => (bytes[i]! << 8) | bytes[i + 1]!
  const u24le = (i: number) => bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16)
  const u32be = (i: number) => ((bytes[i]! << 24) >>> 0) + (bytes[i + 1]! << 16) + (bytes[i + 2]! << 8) + bytes[i + 3]!
  const ok = (w: number, h: number) => (w > 0 && h > 0 && w <= 30000 && h <= 30000 ? { width: w, height: h } : null)
  if (mime === 'image/png') return bytes.length >= 24 ? ok(u32be(16), u32be(20)) : null
  if (mime === 'image/webp') {
    if (bytes.length < 30) return null
    const chunk = String.fromCharCode(...bytes.slice(12, 16))
    if (chunk === 'VP8X') return ok(1 + u24le(24), 1 + u24le(27))
    if (chunk === 'VP8 ') return ok(((bytes[27]! << 8) | bytes[26]!) & 0x3fff, ((bytes[29]! << 8) | bytes[28]!) & 0x3fff)
    if (chunk === 'VP8L') {
      const v = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24)
      return ok((v & 0x3fff) + 1, ((v >>> 14) & 0x3fff) + 1)
    }
    return null
  }
  // JPEG — SOF 표시(C0~C3 · C5~C7 · C9~CB · CD~CF)의 높이 · 가로.
  let i = 2
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1
      continue
    }
    const marker = bytes[i + 1]!
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    const len = u16be(i + 2)
    if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return ok(u16be(i + 7), u16be(i + 5))
    i += 2 + len
  }
  return null
}

/** 허락한 사람 글자 정리 — 한 줄 · 30자. 비면 「업주」. */
export function cleanRightsHolder(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.replace(/[\p{Cc}<>]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 30) : ''
  return s || '업주'
}
