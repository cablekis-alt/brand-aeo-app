/**
 * 사진 자리 자동 채우기. 1단계 — 글의 사진 자리 글자와 홈페이지 사진 후보(src/lib/sitePhotos.ts)의 설명을 낱말로 맞춰 자리마다 사진을
 * 한 장 고른다. 2단계 — 그래도 빈 자리는 자리 글자에 나온 장소 이름(자사 사이트 sitemap의 /places/{이름}/, findPlaces 순서 — 앞 장소에
 * 쓸 사진이 없으면 다음 장소)으로 그 장소 페이지의 공공누리 제1유형 사진(공공 사진, 출처 줄과 함께 내보낸다)을 고른다. 3단계 — 장소
 * 페이지에 쓸 사진이 없던 장소 자리는 한국관광공사 TourAPI의 공공누리 제1유형 사진(관광공사 사진, src/lib/tourPhotos.ts — 역시 공공
 * 사진)으로 채운다. AI를 부르지 않고, 같은 입력이면 늘 같은 결과다.
 *
 * 틀린 사진은 빈자리보다 나쁘다 — 사람이 고른 사진 3장이 이미 장면과 어긋났다(2026-11-03 점검). 그래서 문턱(AUTO_PICK_RULES)에
 * 못 미치면 비워 두고, 다음은 아예 보지 않는다.
 * - 자리: 웹사이트 화면 자리(사진이 아니라 캡처가 맞다) · 이미 사진이 있는 자리 · 사람이 사진을 뺀 자리.
 * - 후보: 설명 없는 사진 · 일러스트 · 사람이 찍힌 사진(초상권) · 출처를 확인하지 못한 공공 사진 · 공공누리 제1유형이 아닌 공공 사진.
 * 사람이 나오는 장면 자리(가족 · 둘이 · 여행자 …)에는 풍경이 맞으면 넣되 「확인 필요」로 표시한다.
 *
 * 같은 사진은 한 글에 한 번, 한 작성자(group)의 글 사이에 한 번, 브랜드 전체에서 AUTO_PICK_RULES.brandRepeat번까지.
 * 서버(server/index.ts op auto)도 이 파일의 후보 검사를 다시 하므로 DOM을 쓰지 않는다.
 */
import {
  canonicalPhotoSrc,
  cleanPhotoAlt,
  matchPhotos,
  needsPhotoCredit,
  normSlotAlt,
  PHOTO_LICENSES,
  PHOTO_LIMITS,
  photoCreditState,
  photoSlotsOf,
  publicPhotoFields,
  type PhotoLicense,
  type PhotoPick,
  type PhotoPlace,
  type PhotoSlot,
  type PublicPhotoFields,
} from './articlePhotos.js'
import type { TourSource } from './tourPhotos.js'

export { needsPhotoCredit }

export const AUTO_PICK_RULES = {
  /** 이 점수 이상이어야 넣는다. */
  threshold: 2.5,
  /** 사진 자리 글자의 내용어 가운데 이만큼(비율) 이상이 사진 설명과 맞아야 넣는다 — 「정원과 가옥 외관」 자리에 정원 사진만 맞는 것을 막는다. */
  coverage: 0.25,
  /** 같은 사진을 브랜드 전체에서 쓰는 최대 횟수(사람이 고른 것 포함). */
  brandRepeat: 3,
  /** 맞은 낱말 하나의 무게 — 사진 자리 글자 · 바로 아랫줄 설명 · 소제목. 글자 2-gram 겹침(Jaccard)의 무게. */
  weights: { key: 2, caption: 1, heading: 0.5, bigram: 2 },
} as const

/** 웹사이트 화면 자리 — 사진이 아니라 화면 캡처가 맞는 자리라 비워 둔다. */
const SCREEN_SLOT = /화면|웹사이트|사이트|앱|홈페이지|검색 결과|스크린|캡처/
/** 「아이」로 시작하지만 사람이 아닌 낱말(아이보리 · 아이콘 · 아이디어 · 아이스(크림 · 링크) · 아이폰 · 아이템)은 뺀다. */
const CHILD = '아이(?!보리|콘|디어|스|폰|템)'
/** 사람을 가리키는 흔한 낱말 — 손님 · 일하는 사람 · 가족 호칭(관람객과 같은 부류). */
const PEOPLE_WORDS = '관람객|관광객|방문객|투숙객|숙박객|이용객|탐방객|손님|여행자|일행|직원|셰프|요리사|바리스타|어르신|손주|신랑|신부'
/** 사람이 찍힌 사진의 설명 — 초상권 확인이 필요해 자동으로 넣지 않는다(설명만으로 거르므로 완전하지 않다). 「모델하우스」 · 「모델명」은 사람이 아니다. */
const PEOPLE_PHOTO = new RegExp(`여성|남성|${CHILD}|어린이|아기|사람|인물|포즈|가족|커플|연인|부부|얼굴|모델(?!하우스|룸|명)|학생|친구|${PEOPLE_WORDS}`)
/** 사람이 나오는 장면 자리 — 풍경 사진이 맞아도 장면과 어긋날 수 있어 「확인 필요」로 표시한다. */
const PEOPLE_SCENE = new RegExp(`가족|둘이|두 사람|커플|연인|부부|친구|${CHILD}|어린이|사람|뒷모습|인물|혼자|여성|남성|${PEOPLE_WORDS}`)

/** 낱말 끝의 조사 — 긴 것부터 뗀다(떼고 두 글자 이상 남을 때만). */
const JOSA = ['에서', '으로', '에게', '까지', '부터', '처럼', '이나', '와', '과', '은', '는', '이', '가', '을', '를', '의', '에', '로', '도', '만']
/** 꾸밈말 끝(「설치된」 · 「푸른」 · 「비춘」) — 장면을 가르지 못하는 낱말이라 뺀다. 세 글자 이상에서만 보는 끝은 따로 둔다(「제한」 · 「주인」). */
const MODIFIER_END = /(는|된|던|른|춘|친|힌)$/
const MODIFIER_END_LONG = /(한|인|은|운)$/
/** 자리를 가리키는 말(「앞의」 · 「안에서」) — 한 글자 낱말이라 조사를 떼지 못해 따로 버린다. */
const POSITION_WORD = /^(앞|뒤|옆|안|밖|위|속|곁|아래|사이)(의|에|을|를|로|에서|으로)?$/
const STOP_WORDS = new Set([
  '장면', '모습', '사진', '이미지', '풍경', '안내', '보이는', '보이', '함께', '있는', '없는', '하는', '위한', '대한', '통해', '공간',
  '작은', '넓은', '좋은', '높은', '깊은', '같은', '많은', '어떤', '이런', '그런', '모든', '여러', '한눈에',
])

export type AutoCandidateSkip = 'bad-src' | 'no-alt' | 'illustration' | 'people' | 'credit' | 'license' | 'duplicate'

export const AUTO_CANDIDATE_SKIP_TEXT: Record<AutoCandidateSkip, string> = {
  'bad-src': 'https 주소가 아님',
  'no-alt': '설명 없음',
  illustration: '일러스트',
  people: '사람이 찍힘',
  credit: '출처를 확인하지 못한 공공 사진',
  license: '공공누리 제1유형이 아닌 공공 사진',
  duplicate: '같은 사진',
}

/** 자동 채우기 후보 — 홈페이지 사진 하나(src/lib/sitePhotos.ts SitePhoto + 찾은 페이지) 또는 공공 사진 하나(PublicPhoto). */
export interface AutoCandidate {
  src: string
  alt: string
  pageUrl: string
  /** 페이지가 출처 표시가 필요한 사진으로 표시했다(공공누리 data-kogl · 구조화 데이터 ImageObject의 공공누리 유형). */
  credit?: boolean
  /** 공공 사진(자사 사이트 장소 페이지의 공공누리 사진) — 장소 이름으로만 맞춘다(설명이 「○○ 사진 N」 꼬리표뿐이다). */
  origin?: 'public'
  /** 공공 사진의 장소(장소 사전의 이름). */
  place?: string
  /** 공공 사진의 이용 허락 — 제1유형이면 'kogl-1', 아니면(제2~4유형 · 모름) null. */
  license?: PhotoLicense | null
  /** 공공 사진의 공공누리 유형(1~4) — 모르면 null. 미리보기에 뺀 이유로 보인다. */
  licenseType?: number | null
  /** 공공 사진의 출처(구조화 데이터 creditText · 관광공사 사진의 「한국관광공사 김지호」). */
  creditText?: string
  /** 관광공사 사진(3단계)이면 그 서비스 — kor 국문 관광정보 · gallery 관광사진 정보(포토코리아). */
  tour?: TourSource
}

/** 공공 사진 후보의 저장 모양(출처 · 이용 허락) — 맞지 않으면 null. */
export function publicCandidateFields(c: Pick<AutoCandidate, 'origin' | 'license' | 'creditText'>): PublicPhotoFields | null {
  if (c.origin !== 'public' || !c.license) return null
  const f = publicPhotoFields({ origin: 'public', license: c.license, credit: c.creditText, creditUrl: PHOTO_LICENSES[c.license].url })
  return f && typeof f === 'object' ? f : null
}

/**
 * 자동으로 넣지 않는 후보인가 — 이유, 아니면 null. 서버도 같은 검사를 한다. ownedDomains는 브랜드 자사 사이트 — 그 주소의 사진은 공공
 * 사진 호스트여도 홈페이지 사진이다(needsPhotoCredit). 공공 사진의 설명은 장소 이름이라, 사람 낱말은 장소 이름(place, 없으면 장소 페이지
 * 주소의 이름)을 걷어 낸 글자에서만 본다 — 「새만금어린이랜드」 · 「먹방이와 친구들」의 사진이 「사람이 찍힘」으로 빠지지 않게. 장소 이름만으로는
 * 사진에 사람이 찍혔는지 알 수 없어, 넣은 공공 사진은 늘 「확인 필요」다(autoPickPhotos).
 */
export function autoCandidateSkip(
  c: Pick<AutoCandidate, 'src' | 'alt' | 'credit' | 'origin' | 'license' | 'creditText' | 'place'> & { pageUrl?: string },
  ownedDomains?: readonly string[],
): AutoCandidateSkip | null {
  if (!canonicalPhotoSrc(c.src)) return 'bad-src'
  const alt = cleanPhotoAlt(c.alt)
  if (!alt) return 'no-alt'
  if (/^일러스트/.test(alt)) return 'illustration'
  const place = c.origin === 'public' ? c.place || placeNameOfUrl(c.pageUrl) : null
  if (PEOPLE_PHOTO.test(place ? withoutPlaceName(alt, place) : alt)) return 'people'
  if (c.origin === 'public') {
    if (c.license !== 'kogl-1') return 'license'
    return publicCandidateFields(c) ? null : 'credit'
  }
  if (c.credit || needsPhotoCredit(c.src, ownedDomains)) return 'credit'
  return null
}

/** 장소 이름 비교용 — 띄어쓰기 · 문장부호를 빼고 소문자로(「근대역사박물관」은 「군산 근대역사박물관」 안에 있다). */
export function placeKey(s: string): string {
  return normSlotAlt(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** 장소 사전 주소(/places/{이름}/)의 이름 — 하이픈은 띄어쓰기로(src/lib/sitePhotos.ts placeDirectoryOf가 쓴다). 아니면 null. */
export function placeNameOfPath(pathname: string): string | null {
  const seg = /^\/places\/([^/]+)\/?$/.exec(pathname)?.[1]
  if (!seg) return null
  let name: string
  try {
    name = decodeURIComponent(seg)
  } catch {
    return null
  }
  name = name.replace(/-/g, ' ').replace(/\s+/g, ' ').trim()
  return name || null
}

function placeNameOfUrl(url: string | undefined): string | null {
  if (!url) return null
  try {
    return placeNameOfPath(new URL(url).pathname)
  } catch {
    return null
  }
}

/**
 * 사진 설명 · 검색어에 사람 낱말이 있는가 — 장소 이름들(places)을 걷어 낸 글자에서만 본다(「새만금어린이랜드」는 사람이 아니다).
 * 관광공사 사진(server/tourPhotos.ts)의 사진 이름 · 검색 낱말도 같은 기준으로 거른다.
 */
export function hasPeopleWords(text: string, places: readonly string[] = []): boolean {
  return PEOPLE_PHOTO.test(places.reduce((s, p) => withoutPlaceName(s, p), normSlotAlt(text).toLowerCase()))
}

/** 글자에서 장소 이름을 걷어 낸다 — 띄어쓰기 · 문장부호는 무시하고 맞춘다(「먹방이와친구들」도 「먹방이와 친구들」). */
function withoutPlaceName(text: string, place: string): string {
  const key = placeKey(place)
  const s = normSlotAlt(text).toLowerCase()
  if (!key) return s
  const kept: number[] = []
  let hay = ''
  for (let i = 0; i < s.length; i += 1) {
    if (!/[\p{L}\p{N}]/u.test(s[i]!)) continue
    kept.push(i)
    hay += s[i]
  }
  const gone = new Set<number>()
  for (let at = hay.indexOf(key); at >= 0; at = hay.indexOf(key, at + key.length)) {
    for (let k = at; k < at + key.length; k += 1) gone.add(kept[k]!)
  }
  return Array.from(s, (ch, i) => (gone.has(i) ? ' ' : ch)).join('')
}

/** 장소 이름이 이보다 짧으면(띄어쓰기를 뺀 글자 수) 맞추지 않는다 — 「달」 · 「하늘」 · 「연도」 같은 이름이 아무 글에나 걸린다. */
const MIN_PLACE_KEY = 3
/**
 * 「○○공원」은 「○○」로도 맞춘다(원고는 「은파호수 둘레 산책로」라고 쓰고 사전 이름은 「은파호수공원」) — 줄인 이름이 이만큼 길 때만
 * (「어린이공원」의 「어린이」는 아무 글에나 걸린다).
 */
const PARK_SUFFIX = /공원$/
const MIN_SHORT_KEY = 4

/** 글자의 비교용 모양 — placeKey와 같은 글자와, 낱말(띄어쓰기 · 문장부호로 나뉜 덩어리)이 시작하는 자리. */
function placeHay(text: string): { hay: string; starts: Set<number> } {
  const starts = new Set<number>()
  let hay = ''
  for (const w of normSlotAlt(text).toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!w) continue
    starts.add(hay.length)
    hay += w
  }
  return { hay, starts }
}

/**
 * 이름이 글자에 나온 마지막 자리 — 띄어쓰기는 무시하되, 글자의 띄어쓰기가 이름을 한 글자 조각으로 가르면 맞지 않는다(「오래된 이 성당」은
 * 「이성당」이 아니다 · 「가상 근대 박물관」은 「가상근대박물관」이다). 없으면 -1.
 */
function lastWholeAt(hay: string, starts: ReadonlySet<number>, key: string): number {
  for (let at = hay.lastIndexOf(key); at >= 0; at = at > 0 ? hay.lastIndexOf(key, at - 1) : -1) {
    let prev = at
    let whole = true
    for (let k = at + 1; k <= at + key.length && whole; k += 1) {
      if (k < at + key.length && !starts.has(k)) continue
      whole = k - prev >= 2
      prev = k
    }
    if (whole) return at
  }
  return -1
}

/**
 * 글자에 나온 장소들 — 앞이 먼저 쓸 장소. 긴 이름이 먼저(같은 자리의 짧은 이름 「근대박물관」은 「가상근대박물관」에 묻혀 빠진다), 같은
 * 길이면 글자에서 뒤에 나온 이름(한국어 명사구는 꾸밈말이 앞, 머리 명사가 뒤 — 「푸르던 바다가 보이는 대장도」), 그다음 사전 이름 그대로
 * 맞은 것(줄인 이름보다), 사전 순서.
 */
export function findPlaces(text: string, places: readonly string[]): string[] {
  const { hay, starts } = placeHay(text)
  if (!hay) return []
  const hits: { name: string; len: number; at: number; short: boolean; order: number }[] = []
  places.forEach((name, order) => {
    const full = placeKey(name)
    const stem = full.replace(PARK_SUFFIX, '')
    const keys = [{ key: full, short: false }, ...(stem !== full && stem.length >= MIN_SHORT_KEY ? [{ key: stem, short: true }] : [])]
    for (const { key, short } of keys) {
      if (key.length < MIN_PLACE_KEY) continue
      const at = lastWholeAt(hay, starts, key)
      if (at < 0) continue
      hits.push({ name, len: key.length, at, short, order })
      return
    }
  })
  const kept = hits.filter((h) => !hits.some((o) => o.len > h.len && o.at <= h.at && h.at + h.len <= o.at + o.len))
  kept.sort((a, b) => b.len - a.len || b.at - a.at || Number(a.short) - Number(b.short) || a.order - b.order)
  return kept.map((h) => h.name)
}

/** 글자에 나온 장소 하나 — findPlaces의 첫 장소. 없으면 null. */
export function findPlace(text: string, places: readonly string[]): string | null {
  return findPlaces(text, places)[0] ?? null
}

/** 웹사이트 화면 자리인가. */
export function isScreenSlot(slotKey: string): boolean {
  return SCREEN_SLOT.test(slotKey)
}

/** 사람이 나오는 장면 자리인가 — 자동으로 넣은 사진에 「확인 필요」를 단다. */
export function isPeopleScene(slotKey: string): boolean {
  return PEOPLE_SCENE.test(slotKey)
}

/** 낱말 하나를 비교할 모양으로 — 조사를 떼고, 꾸밈말 · 불용어 · 숫자 낱말 · 한 글자는 버린다(빈 글자). */
function contentWord(raw: string, stop: ReadonlySet<string>): string {
  let w = raw
  for (const j of JOSA) {
    if (w.length - j.length >= 2 && w.endsWith(j)) {
      w = w.slice(0, -j.length)
      break
    }
  }
  if (w.length < 2 || /\d/.test(w) || POSITION_WORD.test(raw) || STOP_WORDS.has(w) || STOP_WORDS.has(raw) || stop.has(w)) return ''
  if (MODIFIER_END.test(w) || (w.length >= 3 && MODIFIER_END_LONG.test(w))) return ''
  return w
}

/** 글자의 내용어(중복 없이, 나온 순서). */
export function contentWords(text: string, stop: ReadonlySet<string> = new Set()): string[] {
  const words = normSlotAlt(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .map((w) => contentWord(w, stop))
    .filter(Boolean)
  return [...new Set(words)]
}

/** 두 낱말이 맞는가 — 같거나, 두 글자 이상인 한쪽이 다른 쪽에 들어 있다(「공원」 · 「진포해양공원」). */
function sameWord(a: string, b: string): boolean {
  return a === b || (a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a)))
}

/** 글자 2-gram — stop 낱말(브랜드 이름 · 조사가 붙은 꼴 포함)은 빼고 센다. 장면을 가르지 못하는 글자가 점수를 올리지 않게. */
function bigrams(text: string, stop: ReadonlySet<string>): Set<string> {
  const s = normSlotAlt(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((w) => ![...stop].some((x) => w.startsWith(x)))
    .join('')
  const out = new Set<string>()
  for (let i = 0; i + 2 <= s.length; i += 1) out.add(s.slice(i, i + 2))
  return out
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size || !b.size) return 0
  let both = 0
  for (const x of a) if (b.has(x)) both += 1
  return both / (a.size + b.size - both)
}

export interface SlotScore {
  score: number
  /** 사진 설명과 맞은 낱말(사진 자리 글자 · 설명 줄 · 소제목에서, 중복 없이). */
  words: string[]
  /** 사진 자리 글자의 내용어 가운데 맞은 비율. */
  coverage: number
  /** 문턱을 넘었나. */
  pass: boolean
}

/** 사진 자리 하나와 사진 설명 하나의 점수. stop은 브랜드 이름처럼 장면을 가르지 못하는 낱말. */
export function scoreSlot(slot: { key: string; caption: string; heading: string }, alt: string, stop: ReadonlySet<string> = new Set()): SlotScore {
  const photo = contentWords(alt, stop)
  const hits = (words: string[]) => words.filter((w) => photo.some((p) => sameWord(w, p)))
  const keyWords = contentWords(slot.key, stop)
  const key = hits(keyWords)
  const caption = hits(contentWords(slot.caption, stop))
  const heading = hits(contentWords(slot.heading, stop))
  const w = AUTO_PICK_RULES.weights
  const raw = w.key * key.length + w.caption * caption.length + w.heading * heading.length + w.bigram * jaccard(bigrams(slot.key, stop), bigrams(alt, stop))
  const score = Math.round(raw * 100) / 100
  const coverage = keyWords.length ? key.length / keyWords.length : 0
  return {
    score,
    words: [...new Set([...key, ...caption, ...heading])],
    coverage,
    pass: key.length >= 1 && coverage >= AUTO_PICK_RULES.coverage && score >= AUTO_PICK_RULES.threshold,
  }
}

/** 자동 채우기로 보낼 사진 — 확인 시각은 서버가 저장할 때 찍는다. */
export type AutoPickInput = Omit<PhotoPick, 'confirmedAt'> & { auto: true }

/** 자동 채우기를 돌릴 글 하나. */
export interface AutoArticle {
  actionId: string
  generatedAt: string
  /** 발행 원고(publishMarkdownOf) — 사진 자리 열쇠가 SitePhotoPanel과 같아야 한다. */
  markdown: string
  /** 이미 고른 사진(사람 · 자동). */
  picks?: readonly PhotoPick[]
  /** 사람이 사진을 뺀 자리 — 다시 채우지 않는다. */
  cleared?: readonly PhotoPlace[]
  /** 작성자 — 같은 작성자의 글 사이에 같은 사진을 한 번만 쓴다. 없으면 글 · 브랜드 상한만. */
  group?: string
}

/**
 * 자리 하나의 결과.
 * filled 넣음 · kept 이미 사진이 있음(제안 대기 포함) · cleared 사람이 뺀 자리 · screen 웹사이트 화면 자리 · nomatch 맞는 사진 없음 ·
 * used 맞는 사진이 반복 상한에 걸림 · full 글 하나에 사진 PHOTO_LIMITS.picks장이 다 참 · license 자리의 장소 사진이 공공누리 제1유형이 아님.
 */
export type AutoSlotState = 'filled' | 'kept' | 'cleared' | 'screen' | 'nomatch' | 'used' | 'full' | 'license'

export const AUTO_SLOT_STATE_TEXT: Record<AutoSlotState, string> = {
  filled: '채움',
  kept: '이미 사진 있음',
  cleared: '사람이 뺀 자리',
  screen: '화면 자리(비워 둠)',
  nomatch: '맞는 사진 없음',
  used: '맞는 사진을 이미 다 씀',
  full: '사진 3장이 다 참',
  license: '장소 사진이 공공누리 제1유형이 아님',
}

export interface AutoSlotRow {
  slot: PhotoSlot
  caption: string
  state: AutoSlotState
  /** filled일 때 넣을 사진. */
  pick?: AutoPickInput
  /** filled · used · full일 때 가장 잘 맞은 사진과 그 점수. */
  candidate?: AutoCandidate
  score?: SlotScore
  /** 사람이 나오는 장면 자리에 넣었거나 공공 사진(장소 이름으로만 맞췄다)을 넣었다 — 미리보기에 「확인 필요」. */
  review?: boolean
  /** 자리 글자(장면 · 설명 줄)에 나온 장소(slotPlaces의 첫 장소, 공공 사진을 넣었으면 그 사진의 장소) — 공공 사진은 장소로만 맞춘다. */
  place?: string
  /** 자리 글자에 나온 장소 전부(slotPlaces 순서) — 앞 장소에 쓸 공공 사진이 없으면 다음 장소의 사진을 본다. */
  places?: string[]
}

/** 이미 고른 사진 가운데 출처가 없는 공공 사진(photoCreditState missing)에 붙일 출처 — 같은 사진이 장소 페이지에 제1유형으로 있다. */
export interface AutoCreditPatch {
  place: PhotoPlace
  src: string
  fields: PublicPhotoFields
  /** 그 사진을 찾은 장소 페이지. */
  pageUrl: string
}

export interface AutoArticleResult {
  actionId: string
  generatedAt: string
  rows: AutoSlotRow[]
  picks: AutoPickInput[]
  /** 이미 고른 사진에 붙일 출처(「출처 붙이기」를 자동 채우기 저장에 함께 보낸다). */
  credits: AutoCreditPatch[]
}

export interface AutoPickResult {
  articles: AutoArticleResult[]
  /** 자동으로 쓰지 않는 후보와 그 이유. */
  skipped: { candidate: AutoCandidate; reason: AutoCandidateSkip }[]
  /** 자동으로 쓸 수 있는 홈페이지 사진 수. */
  usable: number
  /** 자동으로 쓸 수 있는 공공 사진 수(장소 페이지 · 제1유형 · 출처 있음). */
  usablePublic: number
  /** 자동으로 쓸 수 있는 관광공사 사진 수(3단계). */
  usableTour: number
}

/** 사진 자리 바로 아랫줄의 설명(`*설명*`) — 없으면 ''(articlePhotos.ts captionAfter와 같은 모양). */
function captionOf(lines: readonly string[], slot: PhotoSlot): string {
  const m = /^\*(?!\*)(.+?)\*$/.exec((lines[slot.line + 1] ?? '').trim())
  return m ? normSlotAlt(m[1]!) : ''
}

/** 사람이 뺀 자리인가 — 장면 글자가 같고 소제목이나 몇 번째가 같으면(넉넉하게 본다 — 다시 채우는 것보다 비워 두는 편이 낫다). */
function isCleared(slot: PhotoSlot, cleared: readonly PhotoPlace[] | undefined): boolean {
  return (cleared ?? []).some((c) => c.slot === slot.key && (c.heading === slot.heading || c.nth === slot.nth))
}

/** 자리의 장소들 — 장면 글자에 나온 장소(findPlaces 순서) 다음에 바로 아랫줄 설명에 나온 장소(소제목은 절 전체라 보지 않는다). */
export function slotPlaces(slot: { key: string; caption: string }, places: readonly string[]): string[] {
  return [...new Set([...findPlaces(slot.key, places), ...(slot.caption ? findPlaces(slot.caption, places) : [])])]
}

/** 자리의 장소 하나 — slotPlaces의 첫 장소. 없으면 null. */
export function slotPlace(slot: { key: string; caption: string }, places: readonly string[]): string | null {
  return slotPlaces(slot, places)[0] ?? null
}

/**
 * 공공 사진을 찾으러 읽을 장소 — 글들의 빈 사진 자리(화면 자리 · 사진이 있는 자리 · 사람이 뺀 자리 제외)에 나온 장소, 나온 순서대로
 * 중복 없이. 자리마다 첫 장소를 모두 앞에, 다음 장소들은 그 뒤에 둔다(읽기 상한에 걸리면 다음 장소부터 빠진다). 장소 페이지는 이것만
 * 읽는다(src/lib/sitePhotos.ts loadPublicPhotos).
 */
export function placesToRead(articles: readonly Pick<AutoArticle, 'markdown' | 'picks' | 'cleared'>[], places: readonly string[]): string[] {
  const first: string[] = []
  const rest: string[] = []
  for (const a of articles) {
    const lines = a.markdown.split('\n')
    const match = matchPhotos(a.markdown, a.picks ?? [])
    const occupied = new Set([...match.applied, ...match.suggested].map((m) => m.slot.line))
    for (const slot of photoSlotsOf(a.markdown)) {
      if (occupied.has(slot.line) || isCleared(slot, a.cleared) || isScreenSlot(slot.key)) continue
      slotPlaces({ key: slot.key, caption: captionOf(lines, slot) }, places).forEach((place, i) => (i === 0 ? first : rest).push(place))
    }
  }
  return [...new Set([...first, ...rest])]
}

/**
 * 장소 페이지(2단계)에 쓸 공공 사진이 없어 비어 있는 장소 자리의 장소들 — 관광공사 사진(3단계)을 찾을 장소. 자리마다 첫 장소를 모두
 * 앞에, 다음 장소들은 그 뒤에(화면이 장소 수 상한으로 자른다). 맞는 사진 없음 · 제1유형 아님 자리만 본다 — 장소 페이지 사진이 반복 상한에
 * 걸린 자리(used) · 글이 다 찬 자리(full)는 묻지 않는다.
 */
export function tourPlacesWanted(result: Pick<AutoPickResult, 'articles'>): string[] {
  const first: string[] = []
  const rest: string[] = []
  for (const a of result.articles) {
    for (const row of a.rows) {
      if ((row.state !== 'nomatch' && row.state !== 'license') || !row.places) continue
      row.places.forEach((place, i) => (i === 0 ? first : rest).push(place))
    }
  }
  return [...new Set([...first, ...rest])]
}

/**
 * 글마다 빈 사진 자리에 사진을 고른다 — 글은 받은 순서(작성자 배정 순서)대로. 글 안에서는 먼저 홈페이지 사진을 점수가 높은 짝부터(같은
 * 점수면 앞 자리, 브랜드에서 덜 쓴 사진, 주소 사전순), 그래도 빈 자리는 자리 글자에 나온 장소의 공공 사진을(앞 장소부터 — 그 장소에 쓸
 * 사진이 없으면 다음 장소, 그 장소 페이지의 사진 순서, 앞 자리부터), 그래도 빈 자리는 그 장소의 관광공사 사진을(앞 장소부터, 브랜드에서
 * 가장 덜 쓴 사진 — 같은 장소의 여러 자리에 다른 사진이 가게, 같으면 국문 관광정보 사진 먼저 · 응답 순서). others는 이번에 돌지 않는 글의
 * 고른 사진(브랜드 · 작성자 반복 상한에 센다). 공공 사진 · 관광공사 사진도 같은 상한을 쓴다. 넣은 공공 사진 · 관광공사 사진은 장소
 * 이름으로만 맞췄으므로 늘 「확인 필요」다.
 * 이미 고른 사진 가운데 출처가 없는 공공 사진은, 같은 사진이 공공 사진 후보(제1유형 · 출처 있음)에 있으면 credits로 출처를 붙인다.
 */
export function autoPickPhotos(input: {
  articles: readonly AutoArticle[]
  candidates: readonly AutoCandidate[]
  /** 자사 사이트 장소 페이지의 공공 사진(origin 'public', 장소 · 유형 · 출처) — 제1유형이 아니거나 출처가 없으면 이유와 함께 뺀다. */
  publicCandidates?: readonly AutoCandidate[]
  /** 관광공사 사진(3단계, origin 'public' · tour · 장소) — 장소 페이지 사진이 없던 장소에만(tourPlacesWanted). 국문 관광정보 사진이 앞. */
  tourCandidates?: readonly AutoCandidate[]
  /** 장소 사전(자사 사이트 sitemap의 /places/{이름}/) — 자리 글자에서 장소를 찾는다. */
  places?: readonly string[]
  others?: readonly { src: string; group?: string }[]
  /** 장면을 가르지 못하는 낱말을 뽑을 브랜드 이름(「스테이,머뭄」 — 브랜드 사진이면 모두 그 브랜드다). */
  brandName?: string
  /** 브랜드 자사 사이트 — 그 주소의 사진은 공공 사진 호스트여도 홈페이지 사진이다(autoCandidateSkip). */
  ownedDomains?: readonly string[]
}): AutoPickResult {
  const stop = new Set(contentWords(input.brandName ?? ''))
  const skipped: AutoPickResult['skipped'] = []
  const usable: AutoCandidate[] = []
  const seen = new Set<string>()
  for (const raw of input.candidates) {
    const src = canonicalPhotoSrc(raw.src)
    const reason = autoCandidateSkip(raw, input.ownedDomains) ?? (src && seen.has(src) ? 'duplicate' : null)
    if (reason || !src) {
      skipped.push({ candidate: raw, reason: reason ?? 'bad-src' })
      continue
    }
    seen.add(src)
    usable.push({ ...raw, src, alt: cleanPhotoAlt(raw.alt) })
  }
  usable.sort((a, b) => (a.src < b.src ? -1 : a.src > b.src ? 1 : 0))

  // 공공 사진 — 장소별로, 페이지의 사진 순서 그대로(대표 사진이 앞이다). 출처 붙이기는 설명 검사와 무관하게 제1유형 · 출처만 본다.
  const places = input.places ?? []
  const publicByPlace = new Map<string, AutoCandidate[]>()
  /** 장소마다 뺀 공공 사진의 이유 — 모두 「제1유형 아님」일 때만 자리를 license로 적는다. */
  const skippedByPlace = new Map<string, AutoCandidateSkip[]>()
  const creditBySrc = new Map<string, { fields: PublicPhotoFields; pageUrl: string }>()
  const publicSeen = new Set<string>()
  let usablePublic = 0
  for (const raw of input.publicCandidates ?? []) {
    const src = canonicalPhotoSrc(raw.src)
    const fields = publicCandidateFields(raw)
    if (src && fields && !creditBySrc.has(src)) creditBySrc.set(src, { fields, pageUrl: raw.pageUrl })
    const reason = autoCandidateSkip({ ...raw, origin: 'public' }) ?? (src && (seen.has(src) || publicSeen.has(src)) ? 'duplicate' : null)
    if (reason || !src || !raw.place) {
      skipped.push({ candidate: raw, reason: reason ?? 'bad-src' })
      if (raw.place) skippedByPlace.set(raw.place, [...(skippedByPlace.get(raw.place) ?? []), reason ?? 'bad-src'])
      continue
    }
    publicSeen.add(src)
    usablePublic += 1
    const list = publicByPlace.get(raw.place) ?? []
    list.push({ ...raw, src, alt: cleanPhotoAlt(raw.alt) })
    publicByPlace.set(raw.place, list)
  }

  // 관광공사 사진 — 장소별로, 받은 순서 그대로(국문 관광정보 사진이 앞). 이미 본 사진(홈페이지 · 장소 페이지)과 같으면 뺀다.
  const tourByPlace = new Map<string, AutoCandidate[]>()
  let usableTour = 0
  for (const raw of input.tourCandidates ?? []) {
    const src = canonicalPhotoSrc(raw.src)
    const reason = autoCandidateSkip({ ...raw, origin: 'public' }) ?? (src && (seen.has(src) || publicSeen.has(src)) ? 'duplicate' : null)
    if (reason || !src || !raw.place) {
      skipped.push({ candidate: raw, reason: reason ?? 'bad-src' })
      continue
    }
    publicSeen.add(src)
    usableTour += 1
    tourByPlace.set(raw.place, [...(tourByPlace.get(raw.place) ?? []), { ...raw, src, alt: cleanPhotoAlt(raw.alt) }])
  }

  const brandCount = new Map<string, number>()
  const groupUsed = new Map<string, Set<string>>()
  const countUse = (src: string, group: string | undefined) => {
    const key = canonicalPhotoSrc(src) ?? src
    brandCount.set(key, (brandCount.get(key) ?? 0) + 1)
    if (group) groupUsed.set(group, (groupUsed.get(group) ?? new Set<string>()).add(key))
  }
  for (const o of input.others ?? []) countUse(o.src, o.group)
  for (const a of input.articles) for (const p of a.picks ?? []) countUse(p.src, a.group)

  const articles = input.articles.map((article): AutoArticleResult => {
    const lines = article.markdown.split('\n')
    const slots = photoSlotsOf(article.markdown)
    const picks = article.picks ?? []
    const match = matchPhotos(article.markdown, picks)
    const occupied = new Set([...match.applied, ...match.suggested].map((m) => m.slot.line))
    const inArticle = new Set(picks.map((p) => canonicalPhotoSrc(p.src) ?? p.src))
    let room = Math.max(0, PHOTO_LIMITS.picks - picks.length)

    const rows: AutoSlotRow[] = slots.map((slot) => {
      const caption = captionOf(lines, slot)
      const state: AutoSlotState = occupied.has(slot.line)
        ? 'kept'
        : isCleared(slot, article.cleared)
          ? 'cleared'
          : isScreenSlot(slot.key)
            ? 'screen'
            : 'nomatch'
      const found = state === 'nomatch' && places.length ? slotPlaces({ key: slot.key, caption }, places) : []
      return { slot, caption, state, ...(found.length ? { place: found[0]!, places: found } : {}) }
    })
    const isBlocked = (src: string) =>
      inArticle.has(src) ||
      (article.group !== undefined && Boolean(groupUsed.get(article.group)?.has(src))) ||
      (brandCount.get(src) ?? 0) >= AUTO_PICK_RULES.brandRepeat
    const out: AutoPickInput[] = []
    const fill = (row: AutoSlotRow, candidate: AutoCandidate, score: SlotScore) => {
      const credit = candidate.origin === 'public' ? publicCandidateFields(candidate) : null
      const pick: AutoPickInput = {
        slot: row.slot.key,
        nth: row.slot.nth,
        same: row.slot.same,
        heading: row.slot.heading,
        src: candidate.src,
        alt: candidate.alt,
        pageUrl: candidate.pageUrl,
        auto: true,
        ...(credit ?? {}),
      }
      Object.assign(row, { state: 'filled', pick, candidate, score, ...(isPeopleScene(row.slot.key) || credit ? { review: true } : {}) })
      out.push(pick)
      inArticle.add(candidate.src)
      countUse(candidate.src, article.group)
      room -= 1
    }

    // ① 홈페이지 사진 — 점수가 높은 짝부터.
    type Pair = { row: AutoSlotRow; candidate: AutoCandidate; score: SlotScore }
    const pairs: Pair[] = []
    for (const row of rows) {
      if (row.state !== 'nomatch') continue
      for (const candidate of usable) {
        const score = scoreSlot({ key: row.slot.key, caption: row.caption, heading: row.slot.heading }, candidate.alt, stop)
        if (score.pass) pairs.push({ row, candidate, score })
      }
    }
    const better = (a: Pair, b: Pair) =>
      b.score.score - a.score.score ||
      a.row.slot.line - b.row.slot.line ||
      (brandCount.get(a.candidate.src) ?? 0) - (brandCount.get(b.candidate.src) ?? 0) ||
      (a.candidate.src < b.candidate.src ? -1 : a.candidate.src > b.candidate.src ? 1 : 0)
    for (;;) {
      const open = pairs.filter((p) => p.row.state === 'nomatch' && !isBlocked(p.candidate.src))
      if (!open.length || room === 0) break
      const best = open.sort(better)[0]!
      fill(best.row, best.candidate, best.score)
    }

    // ② 공공 사진 — 남은 자리를 앞에서부터, 자리의 장소(앞 장소부터) 페이지 사진 가운데 아직 쓰지 않은 첫 장.
    const placeScore = (place: string): SlotScore => ({ score: 0, words: [place], coverage: 1, pass: true })
    for (const row of rows) {
      if (row.state !== 'nomatch' || !row.places || room === 0) continue
      for (const place of row.places) {
        const candidate = (publicByPlace.get(place) ?? []).find((c) => !isBlocked(c.src))
        if (!candidate) continue
        fill(row, candidate, placeScore(place))
        row.place = place
        break
      }
    }

    // ③ 관광공사 사진 — 아직 빈 자리를 앞에서부터, 자리의 장소(앞 장소부터) 사진 가운데 브랜드에서 가장 덜 쓴 첫 장.
    for (const row of rows) {
      if (row.state !== 'nomatch' || !row.places || room === 0) continue
      for (const place of row.places) {
        const open = (tourByPlace.get(place) ?? []).filter((c) => !isBlocked(c.src))
        if (!open.length) continue
        const candidate = open.reduce((best, c) => ((brandCount.get(c.src) ?? 0) < (brandCount.get(best.src) ?? 0) ? c : best))
        fill(row, candidate, placeScore(place))
        row.place = place
        break
      }
    }

    // 맞는 사진이 있었는데 넣지 못한 자리 — 글이 다 찼거나 반복 상한에 걸렸다. 장소의 공공 사진이 모두 「제1유형 아님」으로 빠졌으면 license.
    const licenseOnly = (place: string) => {
      const reasons = skippedByPlace.get(place) ?? []
      return reasons.length > 0 && !publicByPlace.get(place)?.length && !tourByPlace.get(place)?.length && reasons.every((r) => r === 'license')
    }
    for (const row of rows) {
      if (row.state !== 'nomatch') continue
      const best = pairs.filter((p) => p.row === row).sort(better)[0]
      const publicPlace = row.places?.find((place) => publicByPlace.get(place)?.length || tourByPlace.get(place)?.length)
      if (best) Object.assign(row, { state: room === 0 ? 'full' : 'used', candidate: best.candidate, score: best.score })
      else if (publicPlace)
        Object.assign(row, {
          state: room === 0 ? 'full' : 'used',
          candidate: publicByPlace.get(publicPlace)?.[0] ?? tourByPlace.get(publicPlace)![0],
          score: placeScore(publicPlace),
          place: publicPlace,
        })
      else if (row.places?.some(licenseOnly)) row.state = 'license'
    }

    // 이미 고른 사진 가운데 출처 없는 공공 사진 — 같은 사진이 제1유형 · 출처와 함께 장소 페이지에 있으면 출처를 붙인다.
    const credits: AutoCreditPatch[] = []
    for (const p of picks) {
      if (photoCreditState(p) !== 'missing') continue
      const hit = creditBySrc.get(canonicalPhotoSrc(p.src) ?? p.src)
      if (hit) credits.push({ place: { slot: p.slot, nth: p.nth, heading: p.heading }, src: p.src, fields: hit.fields, pageUrl: hit.pageUrl })
    }
    return { actionId: article.actionId, generatedAt: article.generatedAt, rows, picks: out, credits }
  })
  return { articles, skipped, usable: usable.length, usablePublic, usableTour }
}

/** 이번에 돌지 않는 글의 고른 사진 — 브랜드 · 작성자 반복 상한에 센다. */
export function otherPhotoUses(
  drafts: Readonly<Record<string, { photos?: readonly PhotoPick[] }>>,
  exclude: ReadonlySet<string>,
  groupOf: (actionId: string) => string | undefined = () => undefined,
): { src: string; group?: string }[] {
  const out: { src: string; group?: string }[] = []
  for (const [id, d] of Object.entries(drafts)) {
    if (exclude.has(id)) continue
    const group = groupOf(id)
    for (const p of d.photos ?? []) out.push({ src: p.src, ...(group ? { group } : {}) })
  }
  return out
}

/**
 * 자동 채우기 미리보기가 기댄 초안 상태의 열쇠 — 미리보기를 계산한 때와 다르면 그 미리보기로 저장하지 않는다(다른 미리보기 · 사람이
 * 고른 사진이 그사이 저장되면 작성자 · 브랜드 반복 상한이 달라진다). 사진이 있는 글과 미리보기 글(ids)의 초안 시각 · 고친 시각 · 고른
 * 사진 · 사람이 뺀 자리를 본다 — 사진 없는 다른 글이 새로 생기는 것은 상관없다.
 */
export function photoStateKey(
  drafts: Readonly<
    Record<string, { generatedAt: string; editedAt?: string; photos?: readonly PhotoPick[]; photoCleared?: readonly PhotoPlace[] }>
  >,
  ids: ReadonlySet<string>,
): string {
  const place = (p: PhotoPlace) => `${p.slot}#${p.nth}#${p.heading}`
  return Object.keys(drafts)
    .filter((id) => ids.has(id) || (drafts[id]!.photos?.length ?? 0) > 0)
    .sort()
    .map((id) => {
      const d = drafts[id]!
      return JSON.stringify([id, d.generatedAt, d.editedAt ?? '', (d.photos ?? []).map((p) => `${place(p)}=${p.src}${p.origin === 'public' ? '+public' : ''}`), (d.photoCleared ?? []).map(place)])
    })
    .join('\n')
}

/**
 * 사진 자리 셈 — 작성자 줄의 「사진 자리 n · 채움 m(공공 p) · 자동 k · 출처 없음 c · 빈자리 j」. 채움은 지금 글에 실제로 들어가는 사진이다
 * — 출처 없는 공공 사진(photoCreditState missing)은 내보내지 않으므로 채움에 세지 않고 noCredit으로 따로 센다. 글을 고쳐 제안 자리로
 * 밀린(「이 자리로 옮기기」를 기다리는) 출처 없는 공공 사진도 noCredit에 센다 — 옮기기 전에 출처부터 붙여야 한다.
 */
export function photoSlotStats(articles: readonly { markdown: string; picks?: readonly PhotoPick[] }[]): {
  slots: number
  filled: number
  auto: number
  public: number
  noCredit: number
  empty: number
} {
  let slots = 0
  let filled = 0
  let auto = 0
  let pub = 0
  let noCredit = 0
  for (const a of articles) {
    slots += photoSlotsOf(a.markdown).length
    const match = matchPhotos(a.markdown, a.picks ?? [])
    noCredit += match.suggested.filter(({ pick }) => photoCreditState(pick) === 'missing').length
    for (const { pick } of match.applied) {
      const state = photoCreditState(pick)
      if (state === 'missing') {
        noCredit += 1
        continue
      }
      filled += 1
      if (pick.auto) auto += 1
      if (state === 'public') pub += 1
    }
  }
  return { slots, filled, auto, public: pub, noCredit, empty: slots - filled }
}
