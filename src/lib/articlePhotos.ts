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
  /** 사람이 이 사진을 이 자리에 넣기로 확인한 때(서버 시각). 없으면 넣지 않는다. */
  confirmedAt: string
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

/** 사진 대체 텍스트 정리 — 제어 문자 · 줄바꿈 · 대괄호를 걷고 160자까지(마크다운 이미지 문법이 깨지지 않게). */
export function cleanPhotoAlt(s: string): string {
  const visible = Array.from(s, (ch) => {
    const code = ch.codePointAt(0)!
    return code < 0x20 || code === 0x7f || ch === '[' || ch === ']' ? ' ' : ch
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
 * 한 자리에는 사진 하나 — 앞서 짝지은 사진이 차지한 자리는 다시 쓰지 않는다.
 */
export function matchPhotos(markdown: string, picks: readonly PhotoPick[]): PhotoMatch {
  const slots = photoSlotsOf(markdown)
  const taken = new Set<number>()
  const result: PhotoMatch = { applied: [], suggested: [], unmatched: [] }
  const free = (s: PhotoSlot) => !taken.has(s.line)
  const confirmed = picks.filter((p) => p.confirmedAt)
  const pending: PhotoPick[] = []
  for (const pick of confirmed) {
    const both = slots.filter((s) => s.key === pick.slot && s.heading === pick.heading)
    const sameKey = slots.filter((s) => s.key === pick.slot)
    const slot =
      both.length === 1 && free(both[0]!)
        ? both[0]!
        : sameKey.length === pick.same && sameKey[pick.nth - 1] && free(sameKey[pick.nth - 1]!)
          ? sameKey[pick.nth - 1]!
          : null
    if (slot) {
      taken.add(slot.line)
      result.applied.push({ pick, slot })
    } else pending.push(pick)
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
  const { applied } = matchPhotos(markdown, picks)
  if (!applied.length) return { markdown, applied: [] }
  const lines = markdown.split('\n')
  const out: AppliedPhoto[] = []
  for (const { pick, slot } of [...applied].sort((a, b) => a.slot.line - b.slot.line)) {
    const src = canonicalPhotoSrc(pick.src)
    if (!src) continue
    const alt = cleanPhotoAlt(pick.alt) || cleanPhotoAlt(slot.alt)
    const cr = lines[slot.line]!.endsWith('\r') ? '\r' : ''
    lines[slot.line] = `![${alt}](${src})${cr}`
    out.push({ src, alt, heading: slot.heading, slotAlt: slot.alt, place: { slot: pick.slot, nth: pick.nth, heading: pick.heading } })
  }
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
