/**
 * 홈페이지 사진으로 글의 사진 자리 채우기 — 고른 사진을 발행본의 `![장면](#image-slot)` 줄에 끼워 넣는다.
 *
 * 사진 주소는 본문(초안 · 고친 글 · 빈칸 기록)에 넣지 않는다. 넣으면 본문 지문(sourceKeyOf)이 바뀌어 다듬어 둔 채널 글이 전부
 * 「원문 바뀜」이 되고, 사실 가드가 주소 속 숫자를 지어낸 숫자로 읽어 사진 줄을 지울 수 있다. 글 끝 안내처럼 복사 · .md ·
 * .html로 내보내는 순간에만 넣는다(src/lib/publishArticle.ts publishArticleParts).
 *
 * 서버(server/contentDraft.ts · server/index.ts)도 같은 검사를 쓰므로 아무것도 import하지 않는다 — 서버 타입 검사는 DOM이 없다.
 */

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
  /** 사진 주소 — https(canonicalPhotoSrc). */
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
   * 사진(옛 기록 포함). 공공 사진은 license · credit · creditUrl이 모두 있어야 넣는다(publicPhotoProblem).
   */
  origin?: PhotoOrigin
  /** 공공 사진의 이용 허락 — 공공누리 제1유형만 받는다(PHOTO_LICENSES). */
  license?: PhotoLicense
  /** 공공 사진의 출처(저작권자) — 사이트 구조화 데이터의 creditText(예: 「한국관광공사」). */
  credit?: string
  /** 공공 사진의 이용 허락 페이지 — PHOTO_LICENSES[license].url과 같아야 한다. */
  creditUrl?: string
}

/** 사진 자리 하나의 열쇠 — 장면 글자 · 몇 번째 · 소제목. */
export type PhotoPlace = Pick<PhotoPick, 'slot' | 'nth' | 'heading'>

export type PhotoOrigin = 'site' | 'public'

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

/** 출처 표시가 필요한 공공 사진의 주소인가(호스트로만 본다). */
export function needsPhotoCredit(src: string): boolean {
  let host: string
  try {
    host = new URL(src).hostname.toLowerCase()
  } catch {
    return false
  }
  return CREDIT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
}

/**
 * 고른 사진의 출처 상태 — site 홈페이지 사진 · public 출처가 맞는 공공 사진 · missing 출처 표시가 필요한데 없거나 틀림(공공 사진
 * 호스트의 사진을 출처 없이 골랐다). missing은 내보내지 않는다 — 지우지는 않고 「출처 없음」으로 알린다.
 */
export function photoCreditState(p: Pick<PhotoPick, 'src' | 'origin' | 'license' | 'credit' | 'creditUrl'>): 'site' | 'public' | 'missing' {
  if (p.origin === 'public') return typeof publicPhotoFields(p) === 'object' ? 'public' : 'missing'
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
export function withPhotos(markdown: string, picks: readonly PhotoPick[] | undefined): { markdown: string; applied: AppliedPhoto[] } {
  if (!picks?.length) return { markdown, applied: [] }
  return placePhotos(markdown, matchPhotos(markdown, picks).applied)
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
): { markdown: string; applied: AppliedPhoto[] } {
  if (!picks?.length) return { markdown, applied: [] }
  const sourceLines = sourceMarkdown.split('\n')
  const lines = markdown.split('\n')
  const sourceSlots = photoSlotsOf(sourceMarkdown)
  const slots = photoSlotsOf(markdown)
  const placements: { pick: PhotoPick; slot: PhotoSlot }[] = []
  for (const { pick, slot: from } of matchPhotos(sourceMarkdown, picks).applied) {
    const to = mapSlots(
      sourceSlots.filter((s) => s.key === from.key).map((s) => captionAfter(sourceLines, s)),
      slots.filter((s) => s.key === from.key),
      (s) => captionAfter(lines, s),
    )?.[from.nth - 1]
    if (to) placements.push({ pick, slot: to })
  }
  return placePhotos(markdown, placements)
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
 */
function placePhotos(markdown: string, applied: readonly { pick: PhotoPick; slot: PhotoSlot }[]): { markdown: string; applied: AppliedPhoto[] } {
  if (!applied.length) return { markdown, applied: [] }
  const lines = markdown.split('\n')
  const crlf = markdown.includes('\r\n')
  const out: AppliedPhoto[] = []
  for (const { pick, slot } of [...applied].sort((a, b) => b.slot.line - a.slot.line)) {
    const src = canonicalPhotoSrc(pick.src)
    const state = photoCreditState(pick)
    if (!src || state === 'missing') continue
    const alt = cleanPhotoAlt(pick.alt) || cleanPhotoAlt(slot.alt)
    const cr = lines[slot.line]!.endsWith('\r') ? '\r' : ''
    lines[slot.line] = `![${alt}](${src})${cr}`
    const credit = state === 'public' ? (publicPhotoFields(pick) as PublicPhotoFields) : undefined
    if (credit) {
      const line = photoCreditLine(credit)
      const next = lines[slot.line + 1]
      const caption = next === undefined ? null : /^(\s*)\*(?!\*)(.+?)\*(\s*)$/.exec(next.replace(/\r$/, ''))
      if (caption && next !== undefined) lines[slot.line + 1] = `${caption[1]}*${caption[2]} (${line})*${caption[3]}${next.endsWith('\r') ? '\r' : ''}`
      else if (cr || !crlf) lines.splice(slot.line + 1, 0, `*${line}*${cr}`)
      else {
        // CRLF 원고의 마지막 줄 — 사진 줄에 줄 끝을 달고 출처 줄이 마지막 줄이 된다.
        lines[slot.line] = `${lines[slot.line]!}\r`
        lines.splice(slot.line + 1, 0, `*${line}*`)
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
    })
  }
  out.reverse()
  return out.length ? { markdown: lines.join('\n'), applied: out } : { markdown, applied: [] }
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
