/**
 * 사진 자리 자동 채우기. 1단계 — 글의 사진 자리 글자와 홈페이지 사진 후보(src/lib/sitePhotos.ts)의 설명을 낱말로 맞춰 자리마다 사진을
 * 한 장 고른다. 2단계 — 그래도 빈 자리는 자리 글자에 나온 장소 이름(자사 사이트 sitemap의 /places/{이름}/, findPlaces 순서 — 앞 장소에
 * 쓸 사진이 없으면 다음 장소)으로 그 장소 페이지의 공공누리 제1유형 사진(공공 사진, 출처 줄과 함께 내보낸다)을 고른다. 3단계 — 장소
 * 페이지에 쓸 사진이 없던 장소 자리는 한국관광공사 TourAPI의 공공누리 제1유형 사진(관광공사 사진, src/lib/tourPhotos.ts — 역시 공공
 * 사진)으로 채운다. 이 파일은 AI를 부르지 않고, 같은 입력이면 늘 같은 결과다.
 *
 * 사진 장면(src/lib/photoScenes.ts — 서버가 비전 모델로 읽어 둔 장면)을 주면 장면으로도 고른다. 장소만 맞고 장면이 어긋난 사진(외관 자리에
 * 실내 전시 · 디오라마 사진 — 2026-11-03 군산각 근대역사박물관 13곳)이 들어가지 않게, 자리 글자가 바라는 장면(바깥 · 실내 · 가까이 ·
 * 시간 · 사람)과 어긋난 사진은 빼고, 장소 사진(②③)은 장면을 읽은 사진 가운데 장면이 잘 맞는 것부터 고른다. 장면을 주지 않으면(이 PC에
 * 키가 없거나 웹) 지금까지처럼 고른다.
 *
 * 틀린 사진은 빈자리보다 나쁘다 — 사람이 고른 사진 3장이 이미 장면과 어긋났다(2026-11-03 점검). 그래서 문턱(AUTO_PICK_RULES)에
 * 못 미치면 비워 두고, 다음은 아예 보지 않는다. 다만 빈자리보다는 비슷한 사진이 낫다(2026-11-04 결정) — 장면을 읽었을 때 맞는 사진이
 * 어디에도 없으면 시간만 다른 사진(낮 사진 · 해 질 무렵 자리)을 「비슷한 사진」(늘 「확인 필요」)으로 넣는다. 종류 · 사람이 어긋난 사진은
 * 그래도 넣지 않는다.
 * - 자리: 웹사이트 화면 자리(사진이 아니라 캡처가 맞다) · 이미 사진이 있는 자리 · 사람이 사진을 뺀 자리(「사람이 뺀 자리도 다시
 *   채우기」를 켜면 다시 보되, 그 자리에서 뺀 사진은 고르지 않는다).
 * - 후보: 설명 없는 사진 · 일러스트 · 사람이 찍힌 사진(초상권) · 출처를 확인하지 못한 공공 사진 · 공공누리 제1유형이 아닌 공공 사진.
 * 사람이 나오는 장면 자리(가족 · 둘이 · 여행자 …)에는 풍경이 맞으면 넣되 「확인 필요」로 표시한다.
 *
 * 같은 사진은 한 글에 한 번, 한 작성자(group)의 글 사이에 한 번, 브랜드 전체에서 AUTO_PICK_RULES.brandRepeat번까지.
 * 서버(server/index.ts op auto)도 이 파일의 후보 검사를 다시 하므로 DOM을 쓰지 않는다.
 *
 * 자사 화면(src/lib/screenCapture.ts — 2026-11-04) — 사진을 다 고른 뒤 화면 자리(웹사이트 화면 자리 가운데 프로필 표의 화면 이름이 정확히
 * 하나 나온 코스 · 지도 자리)를 이 PC에 찍어 둔 화면으로 채운다(자사 화면 단계). 화면은 브랜드 상한을 받지 않고, 글 하나 · 작성자 한
 * 사람에게 「화면 + 변형」 한 번(결정 3). 지도 화면은 미리보기만 하고 저장하지 않는다(결정 4 — SCREEN_AUTO_SAVE_KINDS).
 */
import {
  canonicalPhotoSrc,
  cleanPhotoAlt,
  clearedMatches,
  matchPhotos,
  needsPhotoCredit,
  normSlotAlt,
  PHOTO_LICENSES,
  PHOTO_LIMITS,
  photoCreditState,
  photoSlotsOf,
  publicPhotoFields,
  type ClearedPhotoPlace,
  type PhotoLicense,
  type PhotoPick,
  type PhotoPlace,
  type PhotoSlot,
  type PublicPhotoFields,
} from './articlePhotos.js'
import {
  REGION_SCENE_LIMITS,
  REGION_SCENE_PLACE,
  SCENE_TIME_TEXT,
  type PhotoScene,
  type SceneSetting,
  type SceneTime,
  type SceneWant,
} from './photoScenes.js'
import {
  isScreenSlotText,
  parseScreenAppSrc,
  photoRepeatKey,
  screenAlt,
  screenKindOf,
  screenProfileFor,
  screenSaveAllowed,
  screenUrl,
  screenVariantChoice,
  type ScreenDef,
  type ScreenKind,
  type ScreenShotView,
  type ScreenSlotKind,
  type ScreenVariant,
  type ScreenVariantChoice,
} from './screenCapture.js'
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
  /** 촬영 연월(YYYYMM, 관광사진 정보) — 장면을 읽을 사진을 시기마다 고루 고른다(src/lib/photoScenes.ts scenesToRead). */
  month?: string
  /** 관광사진 정보의 검색 낱말 — 장소 없는 자리에 견줄 지역 사진을 낱말로 먼저 고른다. */
  keywords?: string
  /** 관광공사 사진의 촬영지 · 주소(「전라북도 군산시」) — 미리보기에 보인다. */
  location?: string
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

/**
 * 글자에서 장소 이름을 걷어 낸다 — 띄어쓰기 · 문장부호는 무시하고 맞춘다(「먹방이와친구들」도 「먹방이와 친구들」). mark를 주면 걷어 낸
 * 자리의 첫 글자를 mark로 둔다(장소 이름 바로 뒤의 「앞 · 밖」을 알아보게 — slotSceneWants).
 */
function withoutPlaceName(text: string, place: string, mark = ' '): string {
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
  const starts = new Set<number>()
  for (let at = hay.indexOf(key); at >= 0; at = hay.indexOf(key, at + key.length)) {
    starts.add(kept[at]!)
    for (let k = at; k < at + key.length; k += 1) gone.add(kept[k]!)
  }
  return Array.from(s, (ch, i) => (starts.has(i) ? mark : gone.has(i) ? ' ' : ch)).join('')
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

/**
 * 웹사이트 화면 자리인가 — 사진이 아니라 화면 캡처가 맞는 자리라 사진을 넣지 않는다(src/lib/screenCapture.ts isScreenSlotText — 「화면」과
 * 함께 웹사이트 · 홈페이지 · 사이트 · 앱 · 화면 이름 · 다른 회사 낱말이 있거나, 검색 결과 · 캡처 · 스크린샷). 코스 · 지도 화면 자리는 자사
 * 화면 단계가 찍어 둔 화면으로 채운다.
 */
export function isScreenSlot(slotKey: string): boolean {
  return isScreenSlotText(slotKey)
}

/**
 * 사람이 나오는 장면 자리인가 — 자동으로 넣은 사진에 「확인 필요」를 달고, 사람을 알아볼 수 있는 사진도 받는다(sceneFit). places(자리에
 * 나온 장소 이름)를 걷어 낸 글자에서만 본다 — 「새만금어린이랜드 입구」 · 「먹방이와 친구들 매장 외관」은 사람 장면이 아니다.
 */
export function isPeopleScene(slotKey: string, places: readonly string[] = []): boolean {
  return PEOPLE_SCENE.test(places.reduce((s, p) => withoutPlaceName(s, p), normSlotAlt(slotKey).toLowerCase()))
}

/** 낱말 끝의 조사 하나를 뗀다(떼고 두 글자 이상 남을 때만). */
function stripJosa(raw: string): string {
  for (const j of JOSA) if (raw.length - j.length >= 2 && raw.endsWith(j)) return raw.slice(0, -j.length)
  return raw
}

/** 낱말 하나를 비교할 모양으로 — 조사를 떼고, 꾸밈말 · 불용어 · 숫자 낱말 · 한 글자는 버린다(빈 글자). */
function contentWord(raw: string, stop: ReadonlySet<string>): string {
  const w = stripJosa(raw)
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

/**
 * 자리 글자가 바라는 장면의 낱말 — 자리 글자에서 장소 이름을 걷어 낸 뒤 본다(「진포해양공원」의 「공원」 · 「어린이체험관」의
 * 「체험관」이 장면 낱말로 읽히지 않게). 걷어 낸 자리에는 PLACE_MARK를 두어 장소 이름 바로 뒤의 「앞 · 밖」(「근대역사박물관 앞」)을
 * 바깥으로 본다. 「전시관 · 전시장」은 건물 이름이라 실내 낱말이 아니다(「전시관 입구」는 바깥). 바깥과 실내가 함께 나오면 종류를 정하지
 * 않는다(외관 · 외벽은 늘 바깥).
 */
const PLACE_MARK = '§'
const WANT_OUTSIDE_STRONG = /외관|외벽/
const WANT_OUTSIDE =
  /외관|외벽|건물\s?앞|건물\s?밖|§\s*(앞|밖)|앞마당|마당|(^|\s)거리|골목|입구|정문|출입구|매표소|산책로|산책길|둘레길|보행로|풍경|전경|야외|광장|해변|바닷가|해안|바다|호수|하늘|노을|석양|일몰|야경|공원|(^|\s)숲|정원|(^|\s)다리|항구|포구|등대|바깥|외부/
const WANT_INSIDE = /전시(?!관|장)|실내|내부|안쪽|객실|로비|체험실|침실|욕실|주방|열람실|강당|(매장|가게|카페|식당)\s?안/
const WANT_CLOSE = /음식|요리|메뉴|디저트|(^|\s)빵|커피|음료|접시|상차림|그릇|소품/
/** 안내판 · 간판 자리 — 가까이 찍은 사진도 받는다(바깥 자리면 안내판 · 간판 사진만 — SIGN_SCENE). */
const WANT_SIGN = /안내판|표지판|간판|팻말|요금표|안내문/
/** 장면(낱말 · 설명)이 안내판 · 간판인가 — 바깥 안내판 자리가 받는 가까이 찍은 사진. */
const SIGN_SCENE = /안내판|표지판|간판|팻말|요금표|안내문|현판|알림판|게시판/
/**
 * 안내판 사진이 실내 전시물 · 방 안의 것인가 — 바깥 안내판 자리에 실내 전시 설명판 · 유물 근접이 들어가지 않게. 「전시」만으로는 빼지
 * 않는다 — 박물관 앞에 세운 「특별전시 안내 표지판」은 바깥 안내판이다(2026-11-04 결정).
 */
const SIGN_INSIDE = /전시실|전시물|전시품|디오라마|모형|유물|진열|실내|내부|객실|로비/
const WANT_NIGHT = /야경|(^|\s)밤|야간|불빛|불\s?켜진|조명이\s?켜진/
const WANT_DUSK = /해\s?질\s?(무렵|녘)|해질녘|노을|일몰|석양|황혼|어스름/
/** 저녁 · 해가 진 뒤 — 해 질 무렵이나 밤. */
const WANT_EVENING = /저녁|해\s?가?\s?진\s?(뒤|후|직후|다음|무렵)/
const WANT_DAY = /(^|\s)한?낮(에|의)?(\s|$)|오전|오후|햇살|햇빛|맑은\s?날|파란\s?하늘/
/** 장면 설명의 「사람 없음」 — 자리의 「사람」 낱말과 맞지 않게 지운다. */
const NO_PEOPLE_TEXT = /(사람|인물|인적)\s?(없음|없이|없는|없다)/g

/** 자리 하나가 바라는 장면(slotSceneWants). */
export interface SceneWants {
  /** 받는 장면 종류 — 앞이 바라는 종류. null이면 화면 · 그림만 아니면 된다(장소 사진은 장면 점수 순서로). */
  settings: readonly SceneSetting[] | null
  /**
   * 가까이 찍은 사진(closeup)은 안내판 · 간판 사진만 받는다 — 바깥 자리(입구 · 매표소)에 안내판 낱말이 있어 closeup을 받는 자리. 실내
   * 전시물 · 디오라마 · 유물 근접이나 실내 전시 설명판은 받지 않는다.
   */
  closeupSign: boolean
  /** 받는 시간 — 앞이 바라는 시간. null이면 상관없다. 실내 · 가까이 자리면 시간 모름(unknown)도 받는다(실내 사진은 시간을 모른다). */
  times: readonly SceneTime[] | null
  /** 사람이 나오는 장면 자리(isPeopleScene — 장소 이름을 걷어 낸 글자) — 사람을 알아볼 수 있는 사진도 받되 「확인 필요」. */
  people: boolean
  /** 장면 글자 · 설명 줄의 내용어(장소 이름 · 브랜드 이름을 뺀). */
  key: string[]
  caption: string[]
}

/**
 * 장면을 보고 뺀 이유 — kind 화면 · 그림, setting 장면 종류가 다름(외관 자리에 실내), time 시간이 다름, people 사람을 알아볼 수 있음,
 * words 장소 없는 자리의 지역 사진인데 자리 낱말이 장면 · 사진 제목에 하나도 없음, unread 장면을 아직 읽지 않음, failed 장면을 읽지
 * 못함(받지 못함 · 형식 · 모델이 읽지 않음 — 다시 눌러도 한동안 읽지 않는다).
 */
export type SceneSkip = 'kind' | 'setting' | 'time' | 'people' | 'words' | 'unread' | 'failed'

export const SCENE_SKIP_TEXT: Record<SceneSkip, string> = {
  kind: '화면 · 그림',
  setting: '장면 종류가 다름',
  time: '시간대가 다름',
  people: '사람을 알아볼 수 있음',
  words: '자리 낱말이 장면 · 제목에 없음',
  unread: '장면을 아직 읽지 않음',
  failed: '장면을 읽지 못함',
}

/** 사진 장면 하나가 자리와 맞는 정도. ok가 아니면 miss가 이유. */
export interface SceneFit {
  ok: boolean
  miss?: Exclude<SceneSkip, 'words' | 'unread' | 'failed'>
  /**
   * 시간만 다르다(miss time — 낮 사진 · 해 질 무렵 자리, 밤 사진 · 낮 자리) — 종류 · 사람은 맞는다. 맞는 사진이 어디에도 없을 때만
   * 「비슷한 사진」으로 쓴다(늘 「확인 필요」 — 2026-11-04 결정). 그래서 점수 · 맞은 낱말도 낸다. 종류 · 사람 · 화면이 어긋난 사진(miss가
   * kind · setting · people)은 비슷한 사진으로도 쓰지 않는다.
   */
  soft?: true
  /** 맞은 낱말(장면 글자 2 · 설명 줄 1) + 바라는 종류 1 + 바라는 시간 1. */
  score: number
  /** 장면(낱말 · 설명)과 맞은 자리 낱말. */
  words: string[]
}

/**
 * 글자가 바라는 장면 종류 — 장면 낱말이 없으면 undefined, 바깥과 실내가 함께 나오면 null(정하지 않는다). sign은 바깥 자리에 안내판 ·
 * 간판 낱말이 있어 가까이 찍은 사진(closeup)을 더 받는 자리 — 그 closeup은 안내판 · 간판 사진만(SceneWants.closeupSign).
 */
function settingWants(text: string): { settings: SceneSetting[] | null | undefined; sign: boolean } {
  const outside = WANT_OUTSIDE.test(text)
  const inside = WANT_INSIDE.test(text)
  const settings: SceneSetting[] | null | undefined = WANT_OUTSIDE_STRONG.test(text) || (outside && !inside)
    ? ['exterior', 'aerial']
    : inside && !outside
      ? ['interior', 'closeup']
      : WANT_CLOSE.test(text) && !outside
        ? ['closeup', 'interior']
        : outside && inside
          ? null
          : undefined
  if (settings && WANT_SIGN.test(text) && !settings.includes('closeup')) return { settings: [...settings, 'closeup'], sign: true }
  return { settings, sign: false }
}

/** 글자가 바라는 시간 — 시간 낱말이 없으면 undefined, 낮과 밤이 함께 나오면 null. 저녁 · 해가 진 뒤는 해 질 무렵이나 밤. */
function timeWants(text: string): SceneTime[] | null | undefined {
  const night = WANT_NIGHT.test(text)
  const evening = WANT_EVENING.test(text)
  const dusk = WANT_DUSK.test(text)
  const day = WANT_DAY.test(text)
  if (day && (night || evening || dusk)) return null
  return night ? ['night', 'dusk'] : evening ? ['dusk', 'night'] : dusk ? ['dusk'] : day ? ['day', 'unknown'] : undefined
}

/**
 * 자리 하나가 바라는 장면 — places는 자리에 나온 장소 이름(글자에서 걷어 낸다), stop은 브랜드 이름 낱말. 종류 · 시간은 장면 글자가 정하고,
 * 장면 글자에 그 낱말이 없을 때만 바로 아랫줄 설명이 정한다 — 설명 줄은 사진이 아니라 본문을 풀어 쓰기도 한다(2026-11-04 군산각 「낮 시간에
 * 근대역사박물관 건물 앞을 둘이 걸어가는 장면」의 설명 「입장 마감이 있는 실내 명소는 …」 — 「실내」 때문에 실내 디오라마 사진이 들어갔다).
 * 실내 · 가까이 자리에 시간 낱말(불빛 · 조명이 켜진)이 있으면 시간 모름도 받는다 — 실내 사진은 시간을 모른다(unknown).
 */
export function slotSceneWants(slot: { key: string; caption: string }, places: readonly string[] = [], stop: ReadonlySet<string> = new Set()): SceneWants {
  const strip = (t: string) => places.reduce((s, p) => withoutPlaceName(s, p, PLACE_MARK), normSlotAlt(t).toLowerCase())
  const key = strip(slot.key)
  const caption = strip(slot.caption)
  const fromKey = settingWants(key)
  const decided = fromKey.settings !== undefined ? fromKey : settingWants(caption)
  const settings = decided.settings ?? null
  const timeFromKey = timeWants(key)
  const wantedTimes = timeFromKey !== undefined ? timeFromKey : (timeWants(caption) ?? null)
  const indoor = settings?.[0] === 'interior' || settings?.[0] === 'closeup'
  const times = wantedTimes && indoor && !wantedTimes.includes('unknown') ? [...wantedTimes, 'unknown' as const] : wantedTimes
  return {
    settings,
    closeupSign: decided.sign,
    times,
    people: isPeopleScene(slot.key, places),
    key: contentWords(key, stop),
    caption: contentWords(caption, stop),
  }
}

/** 장면이 바깥 안내판 자리에 넣을 안내판 · 간판 사진인가 — 안내판 낱말이 있고 실내 전시물 · 진열 낱말은 없다(SIGN_INSIDE). */
function signScene(scene: Pick<PhotoScene, 'text' | 'tags'>): boolean {
  const seen = [scene.text, ...scene.tags].join(' ')
  return SIGN_SCENE.test(seen) && !SIGN_INSIDE.test(seen)
}

/**
 * 사진 장면 하나를 자리에 견준다 — 화면 · 그림은 늘 빼고, 자리가 바라는 종류와 다르면 빼고(틀린 사진보다 빈자리), 사람을 알아볼 수 있는
 * 사진은 사람이 나오는 장면 자리가 아니면 뺀다. 바깥 안내판 자리(closeupSign)의 가까이 찍은 사진은 안내판 · 간판 사진만 받는다
 * (2026-11-04 — 「입구와 이용시간 안내판」 자리에 디오라마 · 유물 근접 사진이 점수 0으로 들어갔다). 시간만 다르면 soft(비슷한 사진 —
 * 맞는 사진이 없을 때만 쓴다)로 돌려준다. 맞은 낱말로 점수를 낸다(장면 글자 낱말 2 · 설명 줄 낱말 1 · 바라는 종류 1 · 바라는 시간 1).
 */
export function sceneFit(wants: SceneWants, scene: Pick<PhotoScene, 'text' | 'setting' | 'people' | 'time' | 'tags'>): SceneFit {
  const miss = (m: NonNullable<SceneFit['miss']>): SceneFit => ({ ok: false, miss: m, score: 0, words: [] })
  if (scene.setting === 'screen' || scene.setting === 'illustration') return miss('kind')
  if (wants.settings && !wants.settings.includes(scene.setting)) return miss('setting')
  if (wants.closeupSign && scene.setting === 'closeup' && !signScene(scene)) return miss('setting')
  if (scene.people === 'identifiable' && !wants.people) return miss('people')
  const seen = [...new Set([...scene.tags.map((t) => t.toLowerCase()), ...contentWords(scene.text.replace(NO_PEOPLE_TEXT, ' '))])]
  const hits = (words: readonly string[]) => words.filter((w) => seen.some((s) => sameWord(w, s)))
  const key = hits(wants.key)
  const caption = hits(wants.caption)
  const timeOk = !wants.times || wants.times.includes(scene.time)
  const score = 2 * key.length + caption.length + (wants.settings?.[0] === scene.setting ? 1 : 0) + (timeOk && wants.times?.[0] === scene.time ? 1 : 0)
  const words = [...new Set([...key, ...caption])]
  return timeOk ? { ok: true, score, words } : { ok: false, miss: 'time', soft: true, score, words }
}

/**
 * 장소 없는 자리를 지역 사진에 견줄 장면 낱말 — 내용어에 더해 이 낱말들은 글자 안에서도 찾는다(한 글자 낱말 「꽃 · 숲 · 섬」 —
 * 「꽃이 핀 산책로」의 「꽃」이 「벚꽃」과 맞게).
 */
const REGION_SCENE_WORDS = [
  '꽃', '숲', '섬', '벚꽃', '거리', '골목', '산책로', '산책길', '둘레길', '바닷가', '해변', '해안', '바다', '호수', '강변', '난간', '야경', '노을', '일몰',
  '조명', '철길', '시장', '항구', '포구', '등대', '다리', '공원', '정원', '광장', '구도심', '원도심', '갈대', '갯벌', '방파제', '선착장',
]
/**
 * 장소 없는 자리 낱말에 더해 지역 사진에서 같이 찾는 낱말 — 두 방향(「골목」 자리는 「거리」 사진도, 「거리」 자리는 「골목」 사진도).
 * 2026-11-04 요청 — 관광사진 제목 · 검색 낱말에 「골목」이 드물다(군산 지역 사진 500장에 0장, 「근대문화유산거리」 · 「이색거리」는 있다).
 * 같은 날 요청 — 「구도심 거리」 자리에 검색 낱말 「이색거리」로 읽은 경암동 철길마을 사진이 장면 낱말이 「골목」뿐이라 빠졌다.
 * 더한 낱말만 맞는 사진은 자리 낱말이 맞는 사진 뒤에 읽고, 자리 낱말이 장면 · 제목에 하나도 맞지 않을 때만 쓰며 장면 점수에 더하지 않는다.
 */
const REGION_TERM_ALSO: ReadonlyMap<string, readonly string[]> = new Map([
  ['골목', ['거리']],
  ['거리', ['골목']],
])
/**
 * 더한 낱말로 끝나도 그 장면이 아닌 낱말 — 「먹거리」 · 「볼거리」 · 「즐길거리」는 거리가 아니다(2026-11-04 검토). 자리 글자의 거리가 이 낱말뿐이면
 * 골목을 더하지도 않는다(regionAlso). 「골목」으로 끝나는 낱말(먹자골목 · 뒷골목 · 벽화골목 · 카페골목)은 모두 골목이라 두지 않는다.
 */
const REGION_ALSO_NOT: Readonly<Record<string, RegExp>> = {
  거리: /(먹|볼|놀|살|할|즐길|구경|이야깃|이야기|얘깃|읽을|체험|웃음|화젯|간식|반찬|안줏|군것질|걱정|고민)거리$/,
}

/**
 * 걸리는 시간 · 길이를 말하는 「거리」(「걸어서 10분 거리」 · 「차로 5km 거리」 · 「걸어갈 수 있는 거리」 · 「가까운 거리」 · 「역까지의 거리」 ·
 * 「거리가 가깝다」) — 길이 아니라 골목을 더하지 않는다(2026-11-04 검토 — 설명 줄 「숙소에서 걸어서 10분 거리」 때문에 바닷가 산책로 자리에
 * 철길 골목 사진이 들어갔다).
 */
const DISTANCE_GEORI = /(\d\s*(분|초|시간|km|㎞|m|미터|킬로미터|킬로)|도보|수\s*있는|가까운|먼|떨어진|까지의)\s*거리|거리\s*(가|는|도)\s*(가깝|가까|멀|먼|짧)/gu

/**
 * 자리 낱말(own)에 더할 낱말(REGION_TERM_ALSO) — 뜻이 여럿인 낱말(REGION_ALSO_NOT이 있는 「거리」)은 자리 글자에서도 사진 쪽과 같은 규칙
 * (alsoHits — 낱말이 같거나 거리로 끝나고 먹거리 · 볼거리가 아님)으로, 걸리는 시간 · 길이를 말하는 거리(DISTANCE_GEORI)는 빼고 본다
 * (「먹거리들」 · 「볼거리마다」 · 「거리두기」 · 「거리감」 · 「걸어서 10분 거리」 자리에는 골목을 더하지 않는다). 「골목」은 자리 낱말에 있으면
 * 더한다(「골목길」 · 「골목골목」도 — 전과 같다). 자리 낱말에 이미 있는 낱말은 더하지 않는다.
 */
function regionAlso(own: readonly string[], text: string): string[] {
  const words = normSlotAlt(text).toLowerCase().replace(DISTANCE_GEORI, ' ').split(/[^\p{L}\p{N}]+/u).map(stripJosa)
  const from = own.filter((t) => REGION_TERM_ALSO.has(t) && (!REGION_ALSO_NOT[t] || alsoHits([t], words).length > 0))
  return [...new Set(from.flatMap((t) => REGION_TERM_ALSO.get(t)!))].filter((t) => !own.includes(t))
}

/**
 * 더한 낱말(REGION_TERM_ALSO) 가운데 낱말 목록에 맞는 것 — 낱말이 같거나 그 낱말로 끝날 때만(「이색거리」 · 「근대문화유산거리」 · 「길거리」 ·
 * 「먹자골목」), REGION_ALSO_NOT 낱말(「먹거리」 · 「볼거리」)은 빼고. 글자 안에서는 찾지 않는다(「거리두기」 · 「길거리음식」 · 「골목길」).
 */
function alsoHits(also: readonly string[], words: readonly string[]): string[] {
  return also.filter((t) => words.some((w) => w.endsWith(t) && !REGION_ALSO_NOT[t]?.test(w)))
}

/**
 * 자리 글자가 브랜드 자기 시설(숙소 · 객실 · 매장 · 메뉴)을 가리키는 낱말 — 장소 이름이 없어도 다른 곳의 지역 사진은 분명히 틀린 사진이다
 * (2026-11-04 검토 — 「스테이머뭄 한옥 객실 내부」에 다른 숙소의 한옥 객실 사진이 들어갔다).
 */
const OWN_FACILITY = /객실|침실|욕실|주방|로비|독채|숙소|숙박|펜션|게스트하우스|호텔|모텔|리조트|민박|스테이|매장|가게|점포|메뉴|카운터|체크인/
/**
 * 고유한 장소 이름의 끝 — 앞에 두 글자 이상 붙은 낱말(「은파호수공원」 · 「월명산」 · 「비응항」)은 장소 이름으로 본다. 장소 사전에 없는(또는
 * 사전이 없는 브랜드의) 장소라도 그 이름이 나온 자리에는 다른 곳의 지역 사진을 넣지 않는다.
 */
const PLACE_NAME_END = /(공원|박물관|미술관|기념관|전시관|체험관|과학관|문학관|도서관|해수욕장|시장|호수|저수지|성당|교회|사찰|타워|대교|가옥|고택|마을|해변|폭포|계곡|항|역|산|섬|궁)$/

/** 글자에 고유한 장소 이름(PLACE_NAME_END 앞에 두 글자 이상)이 있는가 — stop(브랜드 · 브랜드 도시 낱말)은 보지 않는다. */
function namesPlace(text: string, stop: ReadonlySet<string>): boolean {
  return normSlotAlt(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .some((raw) => {
      const w = stripJosa(raw)
      const end = w && !stop.has(w) ? PLACE_NAME_END.exec(w)?.[0] : undefined
      return end !== undefined && w.length - end.length >= 2
    })
}

/**
 * 자리 글자가 브랜드 자기 시설을 가리키는가 — 장면 글자나 설명 줄에 브랜드 이름(띄어쓰기 · 문장부호 무시, MIN_PLACE_KEY자 이상)이 있거나
 * 장면 글자에 자기 시설 낱말(OWN_FACILITY)이 있다.
 */
function ownFacility(slot: { key: string; caption: string }, brandKey: string): boolean {
  if (brandKey.length >= MIN_PLACE_KEY && (placeKey(slot.key).includes(brandKey) || placeKey(slot.caption).includes(brandKey))) return true
  return OWN_FACILITY.test(normSlotAlt(slot.key))
}

/** 글자의 지역 사진 견주기 낱말 — 내용어(stop 제외)와 글자 안의 장면 낱말(REGION_SCENE_WORDS). */
function regionTerms(text: string, stop: ReadonlySet<string>): string[] {
  const s = normSlotAlt(text).toLowerCase()
  return [...new Set([...contentWords(s, stop), ...REGION_SCENE_WORDS.filter((w) => s.includes(w))])]
}

/** want 낱말 가운데 have에 맞는 것 — 같은 낱말이거나 한쪽이 다른 쪽을 품는다(한 글자 장면 낱말은 글자 안에 있으면). */
function termHits(want: readonly string[], have: readonly string[]): string[] {
  return want.filter((w) => have.some((h) => sameWord(w, h) || (w.length === 1 && h.includes(w))))
}

/** 비슷한 사진의 까닭 — 「비슷한 사진 — 시간이 다름: 낮 사진 · 해 질 무렵 자리」. */
export function similarWhy(wants: Pick<SceneWants, 'times'>, scene: Pick<PhotoScene, 'time'>): string {
  const want = wants.times?.[0]
  return `비슷한 사진 — 시간이 다름: ${SCENE_TIME_TEXT[scene.time]} 사진${want ? ` · ${SCENE_TIME_TEXT[want]} 자리` : ''}`
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

/**
 * 자동 채우기로 보낼 사진 — 확인 시각은 서버가 저장할 때 찍는다. 자사 화면(origin screen)이면 찍은 화면 id(shotId)도 보낸다 — 서버는 화면이
 * 보낸 src · pageUrl · alt를 쓰지 않고 screens.json에서 그 화면을 찾아 단다.
 */
export type AutoPickInput = Omit<PhotoPick, 'confirmedAt'> & { auto: true; shotId?: string }

/** 자동 채우기를 돌릴 글 하나. */
export interface AutoArticle {
  actionId: string
  generatedAt: string
  /** 발행 원고(publishMarkdownOf) — 사진 자리 열쇠가 SitePhotoPanel과 같아야 한다. */
  markdown: string
  /** 이미 고른 사진(사람 · 자동). */
  picks?: readonly PhotoPick[]
  /** 사람이 사진을 뺀 자리 — 다시 채우지 않는다(refillCleared면 다시 채우되, 그 자리에서 뺀 사진 removed는 고르지 않는다). */
  cleared?: readonly ClearedPhotoPlace[]
  /** 작성자 — 같은 작성자의 글 사이에 같은 사진을 한 번만 쓴다. 없으면 글 · 브랜드 상한만. */
  group?: string
}

/**
 * 자리 하나의 결과.
 * filled 넣음 · kept 이미 사진이 있음(제안 대기 포함 — 다시 본 자동 사진은 recheck) · cleared 사람이 뺀 자리 · screen 웹사이트 화면 자리 ·
 * nomatch 맞는 사진 없음 · used 맞는 사진이 반복 상한에 걸림 · full 글 하나에 사진 PHOTO_LIMITS.picks장이 다 참 · license 자리의 장소
 * 사진이 공공누리 제1유형이 아님 · scene 후보는 있었는데 장면이 자리와 맞지 않음(장면을 읽지 못한 사진 포함) · unread 장면을 아직 읽지
 * 않은 사진이 남음(읽기 상한 · 키 · 한도 · Claude 과부하로 멈춤 — 다시 누르면 이어서 읽는다) · replace 이미 넣은 자동 사진의 장면이
 * 자리와 어긋나 다른 사진으로 바꿈 · remove 이미 넣은 자동 사진의 장면이 어긋나고 바꿀 사진도 없어 뺌.
 * 자사 화면 자리(screen) — 찍지 않는 화면이면 screen 그대로(row.screenSlot이 까닭), 코스 화면을 넣으면 filled, 글에 넣지 않는 화면(지도 —
 * SCREEN_AUTO_SAVE_KINDS 밖)이면 preview(미리보기만), 고른 화면 · 변형을 아직 찍지 않았으면 uncaptured(찍은 뒤 다시 누른다 — screenWanted),
 * 쓸 변형이 모두 상한에 걸리면 used, 글이 다 찼으면 full.
 */
export type AutoSlotState =
  | 'filled'
  | 'kept'
  | 'cleared'
  | 'screen'
  | 'nomatch'
  | 'used'
  | 'full'
  | 'license'
  | 'scene'
  | 'unread'
  | 'replace'
  | 'remove'
  | 'preview'
  | 'uncaptured'

export const AUTO_SLOT_STATE_TEXT: Record<AutoSlotState, string> = {
  filled: '채움',
  kept: '이미 사진 있음',
  cleared: '사람이 뺀 자리',
  screen: '화면 자리(비워 둠)',
  nomatch: '맞는 사진 없음',
  used: '맞는 사진을 이미 다 씀',
  full: '사진 3장이 다 참',
  license: '장소 사진이 공공누리 제1유형이 아님',
  scene: '장면이 맞는 사진 없음',
  unread: '장면을 아직 읽지 않음',
  replace: '장면 안 맞음 → 바꿈',
  remove: '장면 안 맞음 → 뺌',
  preview: '화면 미리보기만(글에 넣지 않음)',
  uncaptured: '화면을 아직 찍지 않음',
}

/** 화면 자리에 고른 자사 화면 · 변형(자사 화면 단계) — 찍어 둔 화면이 있으면 shot. */
export interface AutoScreenPick {
  screenId: string
  variantId: string
  kind: ScreenKind
  /** 화면 이름(「AI 코스 만들기」) · 변형 이름(「아이와」). */
  label: string
  variantLabel: string
  /** 찍을(찍은) 주소 — 프로필에서 만든 것. */
  url: string
  /** 글에 넣는 종류인가(SCREEN_AUTO_SAVE_KINDS) — 아니면 미리보기만(preview). */
  saveAllowed: boolean
  /** 이 PC에 찍어 둔 그 화면 · 변형(가장 늦게 찍은 것). 없으면 아직 찍지 않았다(uncaptured). */
  shot?: AutoScreenShot
  /** 자리 글자로 변형을 좁힌 까닭(screenVariantChoice). */
  by?: ScreenVariantChoice['by']
}

/** 자사 화면 단계가 쓰는 찍어 둔 화면(GET /api/screens의 shots 한 장). */
export type AutoScreenShot = Pick<ScreenShotView, 'id' | 'screenId' | 'variantId' | 'url' | 'capturedAt' | 'src'>

/** 찍을 화면 · 변형 하나(screenWanted) — 화면이 POST /api/screens/capture로 찍고 다시 고른다. */
export interface AutoScreenWant {
  screenId: string
  variantId: string
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
  /** used인데 상한에 걸린 것이 홈페이지 사진 짝뿐이다 — 자리의 장소에 장소 페이지 · 관광공사 사진이 없었다(관광공사 사진을 찾을 자리). */
  homeOnly?: true
  /**
   * used인데 장면으로 고를 때 장면이 맞는 장소 페이지 사진이 모두 반복 상한에 걸렸고 자리의 장소에 관광공사 사진은 아직 없다 — 관광공사
   * 사진을 찾을 자리(장면으로 거르면 맞는 장소 사진이 몇 장 남지 않아 상한에 자주 걸린다).
   */
  askTour?: true
  /** 넣은(filled) · 가장 잘 맞은(used · full) 사진의 장면 — 장면을 읽었을 때. */
  scene?: PhotoScene
  /** 그 장면이 자리와 맞은 정도(맞은 낱말 · 점수). */
  fit?: SceneFit
  /** 장면 때문에 뺀 후보 수(이유별) — 장면으로 고를 때만. */
  sceneSkips?: Partial<Record<SceneSkip, number>>
  /** 사람이 뺀 자리를 다시 채우는 자리(refillCleared) — 그 자리에서 뺀 사진은 고르지 않는다. */
  refill?: true
  /**
   * 맞는 사진이 어디에도 없어 시간만 다른 「비슷한 사진」을 넣었다 — 그 까닭(similarWhy, 「비슷한 사진 — 시간이 다름: 낮 사진 · 해 질 무렵
   * 자리」). 늘 「확인 필요」. 관광공사 사진을 더 찾을 자리다(tourPlacesWanted — 맞는 사진이 나오면 그쪽을 쓴다).
   */
  similar?: string
  /**
   * 이미 넣은 자동 사진을 장면으로 다시 본 결과(「이미 넣은 자동 사진도 장면 확인」) — fit 장면이 맞아 그대로 · similar 시간만 달라 비슷한
   * 사진으로 그대로(맞는 사진이 없다) · unknown 장면을 몰라 그대로 · replace 바꿈 · remove 뺌. 사람이 고른 사진은 다시 보지 않는다.
   */
  recheck?: 'fit' | 'similar' | 'unknown' | 'replace' | 'remove'
  /** 다시 본 자동 사진(그 자리에 있던 사진). */
  old?: PhotoPick
  /** 그 사진의 장면과 자리에 견준 결과(장면을 읽었을 때). */
  oldScene?: PhotoScene
  oldFit?: SceneFit
  /** 장소 이름이 없는 자리에 지역 사진(비슷한 장면)을 넣었다 — 늘 「확인 필요」. */
  placeless?: true
  /** 장소 없는 자리에서 자리 낱말이 맞아 장면을 견준 지역 사진 수(지역 사진을 볼 때만 — 0이면 낱말이 맞는 사진이 없었다). */
  regionTried?: number
  /**
   * 지역 사진(③b)으로 채울 수 있는 장소 없는 자리 — 장소 사전을 읽었고(placesUnknown 아님) 글에 사진 자리가 남았으며, 브랜드 자기 시설
   * (브랜드 이름 · 객실 · 독채 · 매장 · 메뉴)이나 고유한 장소 이름이 나온 자리가 아니다. 화면은 이런 자리가 있을 때만 지역 사진을 부른다.
   */
  regionSlot?: true
  /** 화면 자리(state screen으로 시작한 자리)의 종류(src/lib/screenCapture.ts screenKindOf) — course · map이 아니면 찍지 않는 까닭. */
  screenSlot?: ScreenSlotKind
  /** 화면 자리에 고른 자사 화면 · 변형(filled · preview · uncaptured). */
  screenPick?: AutoScreenPick
}

/** 이미 넣은 자동 사진을 바꾸거나 뺄 것 — 저장할 때 서버가 그 자리에 같은 자동 사진이 아직 있을 때만 한다(server/contentDraft.ts). */
export interface AutoReplaceInput {
  /** 그 자동 사진의 자리 열쇠(저장된 모양 그대로). */
  place: PhotoPlace
  /** 화면이 본 그 자리의 자동 사진 주소. */
  src: string
  /** 바꿀 사진(같은 자리 열쇠) — 없으면 뺀다. 뺀 자리는 사람이 뺀 자리로 적지 않는다(다음에 다시 채운다). */
  pick?: AutoPickInput
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
  /** 이미 넣은 자동 사진을 바꾸거나 뺄 것(장면으로 다시 본 결과). */
  replaces: AutoReplaceInput[]
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
  /**
   * 장소 없는 자리의 지역 사진(regionCandidates를 줄 때) — rows 본 자리 수, pool 지역 사진 수(이번에 받은 관광공사 사진 포함), matched
   * 자리 낱말이 맞은 사진 수, wanted 장면을 읽으려고 고른 사진 수(자리마다 REGION_SCENE_LIMITS.perSlot장까지).
   */
  region?: { rows: number; pool: number; matched: number; wanted: number }
  /**
   * 장면을 읽으면 고르는 데 쓰일 사진 — 열린 자리마다 설명이 맞은 홈페이지 사진, 자리 장소의 장소 페이지 사진 · 관광공사 사진(자리 순서,
   * 중복 없이). 화면이 이 사진들의 장면을 서버에 묻고(src/lib/sitePhotos.ts loadScenesFor) 다시 고른다.
   */
  sceneWanted: SceneWant[]
  /**
   * 찍으면 화면 자리에 쓰일 자사 화면 · 변형(uncaptured 자리, 처음 나온 순서, 중복 없이) — 이 실행에서 찍을 수 있을 때만(screens.available).
   * 화면이 찍고(POST /api/screens/capture) 다시 고른다. 변형은 찍었는지와 상관없이 고르므로 찍은 뒤에도 같은 자리에 같은 변형이 간다.
   */
  screenWanted: AutoScreenWant[]
}

/** 사진 자리 바로 아랫줄의 설명(`*설명*`) — 없으면 ''(articlePhotos.ts captionAfter와 같은 모양). */
function captionOf(lines: readonly string[], slot: PhotoSlot): string {
  const m = /^\*(?!\*)(.+?)\*$/.exec((lines[slot.line + 1] ?? '').trim())
  return m ? normSlotAlt(m[1]!) : ''
}

/** 이 자리의 사람이 뺀 기록 — 장면 글자가 같고 소제목이나 몇 번째가 같으면(clearedMatches). */
function clearedAt(slot: PhotoSlot, cleared: readonly ClearedPhotoPlace[] | undefined): ClearedPhotoPlace[] {
  return (cleared ?? []).filter((c) => clearedMatches(c, { slot: slot.key, nth: slot.nth, heading: slot.heading }))
}

/**
 * 사람이 뺀 자리를 다시 볼 것인가 — refillCleared(「사람이 뺀 자리도 다시 채우기」)이고, 그 자리의 뺀 기록이 모두 뺀 사진(removed)을
 * 알거나 장면으로 고를 때(withScenes). 뺀 사진을 적기 전의 옛 기록은 무엇을 뺐는지 몰라 장면으로만 거른다 — 장면 없이 고르면 같은
 * 입력에서 v0.4.52가 넣었던(사람이 뺀) 그 사진을 다시 고른다.
 */
function refills(cleared: readonly ClearedPhotoPlace[], refillCleared: boolean, withScenes: boolean): boolean {
  return refillCleared && (withScenes || cleared.every((c) => (c.removed?.length ?? 0) > 0))
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
 * 공공 사진을 찾으러 읽을 장소 — 글들의 빈 사진 자리(화면 자리 · 사진이 있는 자리 · 사람이 뺀 자리 제외 — refillCleared면 사람이 뺀
 * 자리도 본다, 장면으로 고르지 않으면(withScenes false) 뺀 사진을 적기 전의 옛 기록 자리는 빼고)에 나온 장소, 나온 순서대로 중복 없이.
 * 자리마다 첫 장소를 모두 앞에, 다음 장소들은 그 뒤에 둔다(읽기 상한에 걸리면 다음 장소부터 빠진다). recheckAuto(「이미 넣은 자동 사진도
 * 장면 확인」 — 장면으로 고를 때만)면 자동 사진이 든 자리의 장소도 맨 뒤에 둔다(장면이 어긋나면 바꿀 사진을 찾는다). 장소 페이지는 이것만
 * 읽는다(src/lib/sitePhotos.ts loadPublicPhotos).
 */
export function placesToRead(
  articles: readonly Pick<AutoArticle, 'markdown' | 'picks' | 'cleared'>[],
  places: readonly string[],
  refillCleared = false,
  withScenes = true,
  recheckAuto = false,
): string[] {
  const first: string[] = []
  const rest: string[] = []
  const recheck: string[] = []
  for (const a of articles) {
    const lines = a.markdown.split('\n')
    const match = matchPhotos(a.markdown, a.picks ?? [])
    const occupied = new Set([...match.applied, ...match.suggested].map((m) => m.slot.line))
    const autoAt = new Set(match.applied.filter((m) => m.pick.auto).map((m) => m.slot.line))
    for (const slot of photoSlotsOf(a.markdown)) {
      if (isScreenSlot(slot.key)) continue
      const found = () => slotPlaces({ key: slot.key, caption: captionOf(lines, slot) }, places)
      if (occupied.has(slot.line)) {
        if (recheckAuto && withScenes && autoAt.has(slot.line)) recheck.push(...found())
        continue
      }
      const cleared = clearedAt(slot, a.cleared)
      if (cleared.length > 0 && !refills(cleared, refillCleared, withScenes)) continue
      found().forEach((place, i) => (i === 0 ? first : rest).push(place))
    }
  }
  return [...new Set([...first, ...rest, ...recheck])]
}

/** 자리의 장소 페이지를 모두 읽었나 — 아니면 3단계(관광공사 사진)로 채우지 않는다(읽지 못한 장소의 페이지 사진이 먼저다). */
function placesRead(places: readonly string[], pagesRead: ReadonlySet<string>): boolean {
  return places.every((p) => pagesRead.has(p))
}

/**
 * 장소 페이지(2단계)에 쓸 공공 사진이 없어 비어 있는 장소 자리의 장소들 — 관광공사 사진(3단계)을 찾을 장소. 자리마다 첫 장소를 모두
 * 앞에, 다음 장소들은 그 뒤에(화면이 장소 수 상한으로 자른다). 맞는 사진 없음 · 제1유형 아님 · 장면이 맞는 사진 없음(장면을 읽지 못한
 * 사진뿐인 자리 포함) 자리와, 홈페이지 사진 짝만 반복 상한에 걸린 자리(used · homeOnly), 장면으로 고를 때 장면이 맞는 장소 페이지 사진이
 * 반복 상한에 걸린 자리(used · askTour)를 본다 — 장면 없이 고를 때 장소 페이지 · 관광공사 사진이 반복 상한에 걸린 자리(used) · 글이 다
 * 찬 자리(full) · 장면을 아직 읽지 않은 자리(unread)는 묻지 않는다.
 * pagesRead는 장소 페이지를 읽은 장소(2단계가 본 장소) — 자리의 장소 가운데 하나라도 읽지 못했으면(일시 실패 · 읽기 상한) 그 자리는 묻지
 * 않는다(autoPickPhotos ③도 채우지 않는다). 다음에 눌러 그 페이지를 읽은 뒤에 묻는다.
 */
export function tourPlacesWanted(result: Pick<AutoPickResult, 'articles'>, pagesRead: ReadonlySet<string>): string[] {
  const first: string[] = []
  const rest: string[] = []
  for (const a of result.articles) {
    for (const row of a.rows) {
      const open =
        row.state === 'nomatch' ||
        row.state === 'license' ||
        row.state === 'scene' ||
        row.state === 'remove' ||
        Boolean(row.similar) ||
        (row.state === 'used' && (row.homeOnly || row.askTour))
      if (!open || !row.places?.length || !placesRead(row.places, pagesRead)) continue
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
 *
 * scenes를 주면(장면으로 고르기) — 장면을 읽은 후보는 자리와 장면이 어긋나면(sceneFit) 빼고, 장소 사진(②③)은 장면을 읽은 사진만 장면
 * 점수가 높은 것부터(같으면 ②는 페이지 순서, ③은 브랜드에서 덜 쓴 사진 · 받은 순서) 고른다. 자리 글자로 종류를 정하지 못한 자리(「근대역사
 * 박물관 이야기」)는 화면 · 그림이 아닌 장소 사진을 장면 점수 순서로 받는다(2026-11-04 결정 — 빈자리보다 비슷한 사진). 홈페이지 사진(①)은 설명 낱말이 이미
 * 장면을 말하므로 장면을 읽지 않았어도 쓰고, 읽었으면 설명 점수에 장면 점수를 더한다. 같은 점수면 지금까지의 순서 그대로다. 장면을 읽지
 * 못한 사진(sceneFailed)은 「아직 읽지 않음」(unread — 다시 누르면 읽는다)이 아니라 장면이 맞지 않은 사진으로 센다(관광공사 사진을 찾는다).
 * 장소 이름이 없는 자리는 regionCandidates를 주면 ③b 지역 사진(브랜드 도시로 찾은 관광사진 · 이번에 받은 관광공사 사진)에서 자리 낱말이
 * 맞는 사진을 장면으로 고른다(row.placeless) — 장소 사전을 읽지 못했으면(placesUnknown) 하지 않고, 브랜드 자기 시설 · 고유한 장소 이름이
 * 나온 자리 · 사진이 다 찬 글의 자리는 보지 않는다(regionSlot). 모든 글에서 ①②③③b를 고른 뒤, 장면이 맞는 사진이 어디에도 없는 자리는
 * ④ 시간만 다른 사진(SceneFit soft)을 「비슷한 사진」으로 넣는다(row.similar — 관광공사 사진을 더 찾을 자리, 늘 「확인 필요」 — 앞 글의
 * 비슷한 사진이 뒤 글의 맞는 사진을 반복 상한으로 막지 않게 맨 뒤에, 장면을 아직 읽지 않은 후보가 남은 자리는 넣지 않는다). recheckAuto면
 * 이미 넣은 자동 사진도 장면으로 다시 보고 같은 단계로 바꿀 사진을 찾는다(replaces — 글의 사진 수 상한에 세지 않는다). 나가는 자동 사진은
 * 나가기로 정해진 때 상한에서 덜어 내 그 글과 뒤 글이 쓸 수 있다(release).
 * 장면 없이 고를 때 「사람이 뺀 자리도 다시 채우기」는 뺀 사진을 아는 자리만 다시 채운다(refills). 장면 없이 고르되 읽어 둔 장면
 * (knownScenes — 이 PC에 키가 없다)을 주면 그 장면이 어긋난 사진은 고르지 않는다.
 */
export function autoPickPhotos(input: {
  articles: readonly AutoArticle[]
  candidates: readonly AutoCandidate[]
  /** 자사 사이트 장소 페이지의 공공 사진(origin 'public', 장소 · 유형 · 출처) — 제1유형이 아니거나 출처가 없으면 이유와 함께 뺀다. */
  publicCandidates?: readonly AutoCandidate[]
  /**
   * 관광공사 사진(3단계, origin 'public' · tour · 장소) — 장소 페이지 사진이 없던 장소에만(tourPlacesWanted). 국문 관광정보 사진이 앞.
   * 사이트의 두 장소가 같은 관광공사 장소로 풀려 같은 사진이 두 장소에 오면 두 장소 모두에 둔다(반복 상한 · 한 글에 한 번은 그대로).
   */
  tourCandidates?: readonly AutoCandidate[]
  /** 장소 페이지를 읽은 장소(2단계가 본 장소) — 주면 ③(관광공사 사진)은 자리의 장소 페이지를 모두 읽은 자리만 채운다(tourPlacesWanted와 같다). */
  pagesRead?: ReadonlySet<string>
  /** 장소 사전(자사 사이트 sitemap의 /places/{이름}/) — 자리 글자에서 장소를 찾는다. */
  places?: readonly string[]
  others?: readonly { src: string; group?: string }[]
  /** 장면을 가르지 못하는 낱말을 뽑을 브랜드 이름(「스테이,머뭄」 — 브랜드 사진이면 모두 그 브랜드다). */
  brandName?: string
  /** 브랜드 자사 사이트 — 그 주소의 사진은 공공 사진 호스트여도 홈페이지 사진이다(autoCandidateSkip). */
  ownedDomains?: readonly string[]
  /** 사진 장면(열쇠는 canonicalPhotoSrc) — 주면 장면으로도 고른다. 비어 있어도 주면 장소 사진(②③)은 장면을 읽은 뒤에만 쓴다. */
  scenes?: ReadonlyMap<string, PhotoScene>
  /**
   * 읽어 둔 장면만(이 PC에 키가 없어 새로 읽지 못한다 — scenes를 주지 않을 때만 본다) — 장면을 모르는 사진은 지금처럼(장면 없이) 고르고,
   * 읽어 둔 장면이 종류 · 사람 · 화면이 어긋난 사진은 고르지 않으며(장면 때문에 뺀 자동 사진이 다시 들어가지 않게), 시간만 다르면 맞는
   * 사진이 없을 때만 「비슷한 사진」으로 넣는다.
   */
  knownScenes?: ReadonlyMap<string, PhotoScene>
  /** 장소 사전(sitemap)을 읽지 못했다 — 장소 이름이 나온 자리를 알 수 없어 장소 없는 자리에 지역 사진(③b)을 넣지 않는다. */
  placesUnknown?: boolean
  /** 장면을 읽지 못한 사진(받지 못함 · 형식 · 모델이 읽지 않음, 열쇠는 canonicalPhotoSrc) — 장소 사진이면 쓰지 않되 「아직 읽지 않음」으로 세지 않는다. */
  sceneFailed?: ReadonlySet<string>
  /** 사람이 뺀 자리도 다시 채운다 — 그 자리에서 뺀 사진(ClearedPhotoPlace.removed)은 고르지 않는다(장면이 없으면 뺀 사진을 아는 자리만). */
  refillCleared?: boolean
  /**
   * 이미 넣은 자동 사진(PhotoPick.auto)도 장면으로 다시 본다 — scenes를 줄 때만. 사람이 고른 사진(auto 없음 · 옛 기록)은 보지 않는다.
   * 장면이 어긋나면 맞는 사진으로 바꾸고(시간만 다르면 맞는 사진이 있을 때만 — 없으면 비슷한 사진으로 둔다), 종류 · 사람이 어긋났는데 바꿀
   * 사진이 없으면 뺀다(replaces).
   */
  recheckAuto?: boolean
  /**
   * 장소 없는 자리(자리 글자에 장소 이름이 없다)에 견줄 지역 사진 — 관광사진 정보를 브랜드 도시로 찾은 사진(src/lib/sitePhotos.ts
   * regionCandidatesOf). 이번에 받은 관광공사 사진(tourCandidates)도 함께 본다. scenes를 줄 때만 쓴다(장면 없이는 넣지 않는다).
   */
  regionCandidates?: readonly AutoCandidate[]
  /** 브랜드 도시(「군산」) — 지역 사진에 다 들어 있어 견주는 낱말에서 뺀다. */
  regionCity?: string
  /**
   * 자사 화면(src/lib/screenCapture.ts) — 주면 화면 자리를 찍어 둔 화면으로 채운다(자사 화면 단계, 브랜드 프로필은 ownedDomains로 찾는다).
   * available은 이 실행에서 화면을 찍을 수 있는가(/api/health screens — 설치한 데스크톱 앱만), shots는 이 PC에 찍어 둔 화면(GET
   * /api/screens). 주지 않으면 화면 자리는 지금처럼 비워 둔다(screen).
   */
  screens?: { available: boolean; shots: readonly AutoScreenShot[] }
}): AutoPickResult {
  const stop = new Set(contentWords(input.brandName ?? ''))
  const scenes = input.scenes
  /** 사진의 장면 — 장면으로 고르면(scenes) 그 장면, 아니면(키가 없다) 읽어 둔 장면(knownScenes). */
  const sceneOf = (src: string) => (scenes ? scenes.get(src) : input.knownScenes?.get(src))
  const sceneWanted: SceneWant[] = []
  const wantAt = new Map<string, SceneWant>()
  const want = (c: Pick<AutoCandidate, 'src' | 'place' | 'month'>, source: SceneWant['source'], existing = false) => {
    const had = wantAt.get(c.src)
    if (had) {
      // 다른 자리의 후보로 먼저 줄에 선 사진도 이미 넣은 자동 사진이면 먼저 읽는다(상한에 밀리지 않게 — scenesToRead).
      if (existing) had.existing = true
      return
    }
    const w: SceneWant = { src: c.src, source, ...(c.place ? { place: c.place } : {}), ...(c.month ? { month: c.month } : {}), ...(existing ? { existing: true as const } : {}) }
    wantAt.set(c.src, w)
    sceneWanted.push(w)
  }
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

  // 관광공사 사진 — 장소별로, 받은 순서 그대로(국문 관광정보 사진이 앞). 이미 본 사진(홈페이지 · 장소 페이지)이나 같은 장소에 이미 받은
  // 사진과 같으면 뺀다. 다른 장소에 같은 사진이 와도(두 장소가 같은 관광공사 장소로 풀렸다) 빼지 않는다 — 뒤 장소의 자리가 비지 않게.
  const tourByPlace = new Map<string, AutoCandidate[]>()
  const tourSrcs = new Set<string>()
  for (const raw of input.tourCandidates ?? []) {
    const src = canonicalPhotoSrc(raw.src)
    const samePlace = Boolean(raw.place && tourByPlace.get(raw.place)?.some((c) => c.src === src))
    const reason = autoCandidateSkip({ ...raw, origin: 'public' }) ?? (src && (seen.has(src) || publicSeen.has(src) || samePlace) ? 'duplicate' : null)
    if (reason || !src || !raw.place) {
      skipped.push({ candidate: raw, reason: reason ?? 'bad-src' })
      continue
    }
    tourSrcs.add(src)
    tourByPlace.set(raw.place, [...(tourByPlace.get(raw.place) ?? []), { ...raw, src, alt: cleanPhotoAlt(raw.alt) }])
  }
  const usableTour = tourSrcs.size

  // 지역 사진(장소 없는 자리) — 받은 지역 사진(공공누리 제1유형 · 출처 · 사람 낱말 검사)과 이번에 받은 관광공사 사진, 중복 없이. 장면으로
  // 고를 때만.
  const regionPool: AutoCandidate[] | null = scenes && input.regionCandidates ? [] : null
  if (regionPool) {
    const poolSeen = new Set<string>()
    for (const raw of input.regionCandidates ?? []) {
      const src = canonicalPhotoSrc(raw.src)
      if (!src || poolSeen.has(src) || seen.has(src) || publicSeen.has(src)) continue
      const reason = autoCandidateSkip({ ...raw, origin: 'public' })
      if (reason) {
        skipped.push({ candidate: raw, reason })
        continue
      }
      poolSeen.add(src)
      regionPool.push({ ...raw, src, alt: cleanPhotoAlt(raw.alt) })
    }
    for (const list of tourByPlace.values()) {
      for (const c of list) {
        if (poolSeen.has(c.src)) continue
        poolSeen.add(c.src)
        regionPool.push(c)
      }
    }
  }
  const regionStop = new Set([...stop, ...contentWords(input.regionCity ?? '')])
  const poolTerms = new Map<string, string[]>()
  const termsOfCandidate = (c: AutoCandidate) => {
    let t = poolTerms.get(c.src)
    if (!t) {
      t = regionTerms(`${c.alt} ${c.keywords ?? ''}`, regionStop)
      poolTerms.set(c.src, t)
    }
    return t
  }
  /** 자리마다 장면을 읽을 지역 사진(낱말이 맞는 순서) — 모든 글을 본 뒤 자리를 돌아가며 sceneWanted에 넣는다(앞 자리만 상한을 쓰지 않게). */
  const regionWants: AutoCandidate[][] = []
  const regionMatched = new Set<string>()
  const brandKey = placeKey(input.brandName ?? '')
  /** 지역 사진을 견줄 수 있는 장소 없는 자리인가 — 브랜드 자기 시설 · 고유한 장소 이름이 나온 자리는 아니다(다른 곳의 사진은 틀린 사진이다). */
  const regionSlotOk = (row: AutoSlotRow) =>
    !ownFacility({ key: row.slot.key, caption: row.caption }, brandKey) && !namesPlace(`${row.slot.key} ${row.caption}`, regionStop)

  const brandCount = new Map<string, number>()
  /** 작성자마다 쓴 사진 수 — 나가는 자동 사진은 덜어 낸다(release). */
  const groupUsed = new Map<string, Map<string, number>>()
  const countUse = (src: string, group: string | undefined, by = 1) => {
    const key = canonicalPhotoSrc(src) ?? src
    brandCount.set(key, Math.max(0, (brandCount.get(key) ?? 0) + by))
    if (!group) return
    const mine = groupUsed.get(group) ?? new Map<string, number>()
    mine.set(key, Math.max(0, (mine.get(key) ?? 0) + by))
    groupUsed.set(group, mine)
  }
  // 고른 사진은 반복 열쇠로 센다 — 사진은 주소, 자사 화면은 「화면 + 변형」(photoRepeatKey · otherPhotoUses).
  for (const o of input.others ?? []) countUse(o.src, o.group)
  for (const a of input.articles) for (const p of a.picks ?? []) countUse(photoRepeatKey(p), a.group)
  /**
   * 나가는 자동 사진(장면으로 다시 본 사진)은 나가기로 정해진 때 상한에서 덜어 낸다 — 종류 · 사람이 어긋난 사진은 글을 볼 때(반드시
   * 나간다), 시간만 다른 사진은 맞는 사진으로 바꿀 때. 서버는 글 순서대로 저장하고 같은 글 안에서는 나가는 사진을 먼저 비우므로
   * (server/contentDraft.ts saveAutoPhotoPicks), 덜어 낸 사진은 그 글과 뒤 글만 쓸 수 있다 — 앞 글에는 아직 그 자리에 있는 사진으로 센다.
   */
  const released = new Map<string, { at: number; group?: string }[]>()
  const release = (src: string, at: number, group: string | undefined) => {
    const key = canonicalPhotoSrc(src) ?? src
    countUse(key, group, -1)
    released.set(key, [...(released.get(key) ?? []), { at, ...(group !== undefined ? { group } : {}) }])
  }
  /** 글 at에서는 아직 자리에 있는(뒤 글이 덜어 낸) 사진 수 — 브랜드 전체와 작성자 group의 것. */
  const heldLater = (src: string, at: number, group: string | undefined) => {
    const later = (released.get(src) ?? []).filter((r) => r.at > at)
    return { brand: later.length, group: group === undefined ? 0 : later.filter((r) => r.group === group).length }
  }

  type Pair = { row: AutoSlotRow; candidate: AutoCandidate; score: SlotScore; rank: number; scene?: PhotoScene; fit?: SceneFit }
  type Option = { candidate: AutoCandidate; order: number; scene?: PhotoScene; fit?: SceneFit }
  /** 자리 · 장소 하나의 후보 — fit 장면이 맞는 것(장면을 모르면 장면 없이 고를 때만), soft 시간만 다른 것(비슷한 사진). */
  type Options = { fit: Option[]; soft: Option[] }
  type Similar = { candidate: AutoCandidate; score: SlotScore; scene?: PhotoScene; fit: SceneFit; rank: number[]; place?: string; region?: true }
  const byRank = (a: Similar, b: Similar) => {
    for (let i = 0; i < a.rank.length; i += 1) if (a.rank[i] !== b.rank[i]) return a.rank[i]! - b.rank[i]!
    return 0
  }
  const placeScore = (place: string): SlotScore => ({ score: 0, words: [place], coverage: 1, pass: true })
  const regionScore = (o: Option): SlotScore => ({ score: 0, words: o.fit?.words ?? [], coverage: 1, pass: true })
  const sceneScore = (o: Option) => o.fit?.score ?? 0
  const used = (o: Option) => brandCount.get(o.candidate.src) ?? 0

  // 자사 화면 — 브랜드 프로필(자사 사이트에 프로필 호스트가 있을 때만)과 화면 · 변형마다 가장 늦게 찍은 화면(앱 주소 모양이 맞는 것만).
  const screenProfile = screenProfileFor(input.ownedDomains)
  const shotAt = new Map<string, AutoScreenShot>()
  for (const s of input.screens?.shots ?? []) {
    if (parseScreenAppSrc(s.src)?.shotId !== s.id) continue
    const k = `${s.screenId}:${s.variantId}`
    const had = shotAt.get(k)
    if (!had || Date.parse(s.capturedAt) > Date.parse(had.capturedAt)) shotAt.set(k, s)
  }
  const screenWanted = new Map<string, AutoScreenWant>()
  const screenKey = (screen: ScreenDef, v: ScreenVariant) => photoRepeatKey({ src: '', origin: 'screen', screenId: screen.id, variantId: v.id })

  // 글마다 자리를 정하고(이미 넣은 자동 사진을 장면으로 다시 본다 — 모든 글을 먼저 보아 그 사진의 장면을 먼저 읽게), 모든 글에서 장면이
  // 맞는 사진(①②③③b)을 고른 뒤에 비슷한 사진(④)을 고른다 — 앞 글의 비슷한 사진이 뒤 글의 맞는 사진을 반복 상한으로 막지 않게.
  const workers = input.articles.map((article, index) => {
    const lines = article.markdown.split('\n')
    const slots = photoSlotsOf(article.markdown)
    const picks = article.picks ?? []
    const match = matchPhotos(article.markdown, picks)
    const occupied = new Set([...match.applied, ...match.suggested].map((m) => m.slot.line))
    const inArticle = new Set(
      picks.map((p) => {
        const key = photoRepeatKey(p)
        return canonicalPhotoSrc(key) ?? key
      }),
    )
    let room = Math.max(0, PHOTO_LIMITS.picks - picks.length)
    // 다시 볼 자동 사진 — 장면으로 고를 때 「이미 넣은 자동 사진도 장면 확인」이면, 자리를 찾아 넣은(applied) 자동 사진(auto)만(화면 자리 ·
    // 자사 화면 제외).
    const recheckAt = new Map<number, PhotoPick>()
    if (scenes && input.recheckAuto) {
      for (const m of match.applied) if (m.pick.auto && m.pick.origin !== 'screen' && !isScreenSlot(m.slot.key)) recheckAt.set(m.slot.line, m.pick)
    }

    /** 다시 채우는 자리(refillCleared)에서 사람이 뺀 사진, 다시 보는 자동 사진의 자리에서 사람이 뺀 사진과 그 자동 사진 — 그 자리에는 고르지 않는다. */
    const removedAt = new Map<AutoSlotRow, Set<string>>()
    /** 화면 자리의 화면(코스 · 지도 — screenKindOf) — 자사 화면 단계가 채운다. */
    const screenOfRow = new Map<AutoSlotRow, ScreenDef>()
    const rows: AutoSlotRow[] = slots.map((slot) => {
      const caption = captionOf(lines, slot)
      const cleared = clearedAt(slot, article.cleared)
      const old = recheckAt.get(slot.line)
      const state: AutoSlotState = occupied.has(slot.line)
        ? 'kept'
        : cleared.length && !refills(cleared, Boolean(input.refillCleared), Boolean(scenes))
          ? 'cleared'
          : isScreenSlot(slot.key)
            ? 'screen'
            : 'nomatch'
      const found = (state === 'nomatch' || old) && places.length ? slotPlaces({ key: slot.key, caption }, places) : []
      const screenKind = state === 'screen' ? screenKindOf(slot.key, screenProfile) : null
      const row: AutoSlotRow = {
        slot,
        caption,
        state,
        ...(found.length ? { place: found[0]!, places: found } : {}),
        ...((state === 'nomatch' || state === 'screen') && cleared.length ? { refill: true as const } : {}),
        ...(old ? { old } : {}),
        ...(screenKind ? { screenSlot: screenKind.kind } : {}),
      }
      // 사람이 뺀 사진(자사 화면은 「화면 + 변형」 열쇠 — photoRepeatKey)은 다시 채우는 그 자리에 고르지 않는다.
      const gone = cleared.flatMap((c) => (c.removed ?? []).map((s) => canonicalPhotoSrc(s) ?? s))
      if (row.refill) removedAt.set(row, new Set(gone))
      if (old) removedAt.set(row, new Set([...gone, canonicalPhotoSrc(old.src) ?? old.src]))
      if (screenKind?.screen) screenOfRow.set(row, screenKind.screen)
      return row
    })
    const removed = (row: AutoSlotRow, src: string) => Boolean(removedAt.get(row)?.has(src))
    const isBlocked = (src: string) => {
      const later = heldLater(src, index, article.group)
      return (
        inArticle.has(src) ||
        (article.group !== undefined && (groupUsed.get(article.group)?.get(src) ?? 0) + later.group > 0) ||
        (brandCount.get(src) ?? 0) + later.brand >= AUTO_PICK_RULES.brandRepeat
      )
    }
    /** 사진을 넣을 자리가 남았나 — 다시 보는 자동 사진의 자리는 그 사진을 바꾸는 것이라 글의 사진 수 상한에 세지 않는다. */
    const hasRoom = (row: AutoSlotRow) => Boolean(row.old) || room > 0
    // 장면 — 자리가 바라는 장면(자리마다 한 번)과 장면 때문에 뺀 후보 수.
    const wantsAt = new Map<AutoSlotRow, SceneWants>()
    const wantsOf = (row: AutoSlotRow) => {
      let w = wantsAt.get(row)
      if (!w) {
        w = slotSceneWants({ key: row.slot.key, caption: row.caption }, row.places ?? [], stop)
        wantsAt.set(row, w)
      }
      return w
    }
    const skipScene = (row: AutoSlotRow, why: SceneSkip) => {
      row.sceneSkips = { ...row.sceneSkips, [why]: (row.sceneSkips?.[why] ?? 0) + 1 }
    }
    // 이미 넣은 자동 사진을 장면으로 다시 본다 — 장면을 모르면(아직 읽지 않음 · 읽지 못함) 그대로, 맞으면 그대로. 어긋나면 그 자리를 바꿀
    // 사진을 찾는 자리로 연다(nomatch — 그 사진 · 사람이 그 자리에서 뺀 사진은 고르지 않는다). 시간만 다르면(soft) ①②③③b의 맞는 사진으로만
    // 바꾸고, 종류 · 사람이 어긋났으면 ④ 비슷한 사진으로도 바꾸며, 둘 다 없으면 뺀다(finish). 종류 · 사람이 어긋난 사진은 반드시 나가므로
    // 지금 상한에서 덜어 낸다 — 같은 글의 다른 자리 · 뒤 글의 맞는 자리가 그 사진을 쓸 수 있다.
    for (const row of rows) {
      if (!row.old) continue
      const src = canonicalPhotoSrc(row.old.src) ?? row.old.src
      want({ src }, row.old.origin === 'public' ? 'public' : 'site', true)
      const scene = scenes?.get(src)
      if (!scene) {
        row.recheck = 'unknown'
        continue
      }
      const fit = sceneFit(wantsOf(row), scene)
      Object.assign(row, { oldScene: scene, oldFit: fit })
      if (fit.ok) Object.assign(row, { recheck: 'fit', scene, fit })
      else {
        row.state = 'nomatch'
        if (!fit.soft) {
          inArticle.delete(src)
          release(src, index, article.group)
        }
      }
    }
    const out: AutoPickInput[] = []
    const replaces: AutoReplaceInput[] = []
    const fill = (row: AutoSlotRow, candidate: AutoCandidate, score: SlotScore, seen?: { scene?: PhotoScene; fit?: SceneFit }, similar?: string) => {
      const credit = candidate.origin === 'public' ? publicCandidateFields(candidate) : null
      // 바꾸는 사진은 그 자동 사진의 자리 열쇠 그대로 — 지금 글에서 같은 자리로 짝지어진다.
      const at = row.old ?? { slot: row.slot.key, nth: row.slot.nth, same: row.slot.same, heading: row.slot.heading }
      const pick: AutoPickInput = {
        slot: at.slot,
        nth: at.nth,
        same: at.same,
        heading: at.heading,
        src: candidate.src,
        alt: candidate.alt,
        pageUrl: candidate.pageUrl,
        auto: true,
        ...(credit ?? {}),
      }
      Object.assign(row, {
        state: row.old ? 'replace' : 'filled',
        ...(row.old ? { recheck: 'replace' } : {}),
        pick,
        candidate,
        score,
        ...(seen?.scene ? { scene: seen.scene } : {}),
        ...(seen?.fit ? { fit: seen.fit } : {}),
        ...(isPeopleScene(row.slot.key, row.places ?? []) || credit || similar ? { review: true } : {}),
        ...(similar ? { similar } : {}),
      })
      if (row.old) {
        replaces.push({ place: { slot: at.slot, nth: at.nth, heading: at.heading }, src: row.old.src, pick })
        // 시간만 다른 자동 사진은 맞는 사진으로 바꿀 때 덜어 낸다(종류 · 사람이 어긋난 사진은 이미 덜어 냈다).
        if (row.oldFit?.soft) {
          const old = canonicalPhotoSrc(row.old.src) ?? row.old.src
          inArticle.delete(old)
          release(old, index, article.group)
        }
      } else {
        out.push(pick)
        room -= 1
      }
      inArticle.add(candidate.src)
      countUse(candidate.src, article.group)
    }

    const pairs: Pair[] = []
    /** 시간만 다른 짝(비슷한 사진 — ④에서 맞는 사진이 없는 자리에만). */
    const softPairs: Pair[] = []
    const better = (a: Pair, b: Pair) =>
      b.rank - a.rank ||
      a.row.slot.line - b.row.slot.line ||
      (brandCount.get(a.candidate.src) ?? 0) - (brandCount.get(b.candidate.src) ?? 0) ||
      (a.candidate.src < b.candidate.src ? -1 : a.candidate.src > b.candidate.src ? 1 : 0)
    const tourOk = (row: AutoSlotRow) => !input.pagesRead || placesRead(row.places ?? [], input.pagesRead)
    // 장소 사진(②③)의 자리별 후보 — 장면으로 고르면 장면을 읽은 사진 가운데 자리와 맞는 것만(뺀 이유는 센다). 키가 없으면(knownScenes)
    // 장면을 모르는 사진은 지금처럼 쓰고, 읽어 둔 장면이 어긋난 사진만 뺀다. 장소 페이지를 다 읽지 못한 자리는 관광공사 사진을 보지 않는다.
    const optionsOf = (row: AutoSlotRow, list: readonly AutoCandidate[], source: SceneWant['source']): Options => {
      const opts: Options = { fit: [], soft: [] }
      list.forEach((candidate, order) => {
        if (removed(row, candidate.src)) return
        want(candidate, source)
        const scene = sceneOf(candidate.src)
        if (!scene) {
          if (scenes) skipScene(row, input.sceneFailed?.has(candidate.src) ? 'failed' : 'unread')
          else opts.fit.push({ candidate, order })
          return
        }
        const fit = sceneFit(wantsOf(row), scene)
        if (!fit.ok) skipScene(row, fit.miss!)
        if (fit.ok || fit.soft) opts[fit.ok ? 'fit' : 'soft'].push({ candidate, order, scene, fit })
      })
      return opts
    }
    const publicOpts = new Map<AutoSlotRow, Map<string, Options>>()
    const tourOpts = new Map<AutoSlotRow, Map<string, Options>>()
    const optsAt = (m: Map<AutoSlotRow, Map<string, Options>>, row: AutoSlotRow, place: string, kind: keyof Options = 'fit') => m.get(row)?.get(place)?.[kind] ?? []
    const regionOpts = new Map<AutoSlotRow, Options>()
    /** 지역 사진으로 채울 수 있는 장소 없는 자리인데 글에 사진 자리가 남지 않았다 — 장면을 청하지 않고 full로 둔다. */
    const regionFull = new Set<AutoSlotRow>()

    /** ①②③③b — 장면이 맞는 사진(장면 없이 고르면 지금까지처럼). */
    const fitStages = () => {
      // ① 홈페이지 사진 — 점수(설명 낱말 + 장면)가 높은 짝부터. 장면이 자리와 어긋나면 짝으로 두지 않는다.
      for (const row of rows) {
        if (row.state !== 'nomatch') continue
        for (const candidate of usable) {
          if (removed(row, candidate.src)) continue
          const score = scoreSlot({ key: row.slot.key, caption: row.caption, heading: row.slot.heading }, candidate.alt, stop)
          if (!score.pass) continue
          want(candidate, 'site')
          const scene = sceneOf(candidate.src)
          const fit = scene ? sceneFit(wantsOf(row), scene) : undefined
          const pair = { row, candidate, score, rank: score.score + (fit?.score ?? 0), ...(scene ? { scene } : {}), ...(fit ? { fit } : {}) }
          if (fit && !fit.ok) {
            skipScene(row, fit.miss!)
            if (fit.soft) softPairs.push(pair)
            continue
          }
          pairs.push(pair)
        }
      }
      for (;;) {
        const open = pairs.filter((p) => p.row.state === 'nomatch' && hasRoom(p.row) && !isBlocked(p.candidate.src))
        if (!open.length) break
        const best = open.sort(better)[0]!
        fill(best.row, best.candidate, best.score, best)
      }

      for (const row of rows) {
        if (row.state !== 'nomatch' || !row.places) continue
        publicOpts.set(row, new Map(row.places.map((place) => [place, optionsOf(row, publicByPlace.get(place) ?? [], 'public')])))
        if (tourOk(row)) tourOpts.set(row, new Map(row.places.map((place) => [place, optionsOf(row, tourByPlace.get(place) ?? [], 'tour')])))
      }

      // ② 공공 사진 — 남은 자리를 앞에서부터, 자리의 장소(앞 장소부터) 페이지 사진 가운데 아직 쓰지 않은 첫 장(장면으로 고르면 장면이 가장
      // 잘 맞는 장, 같으면 페이지 순서).
      for (const row of rows) {
        if (row.state !== 'nomatch' || !row.places || !hasRoom(row)) continue
        for (const place of row.places) {
          const open = optsAt(publicOpts, row, place).filter((o) => !isBlocked(o.candidate.src))
          if (!open.length) continue
          const best = scenes ? [...open].sort((a, b) => sceneScore(b) - sceneScore(a) || a.order - b.order)[0]! : open[0]!
          fill(row, best.candidate, placeScore(place), best)
          row.place = place
          break
        }
      }

      // ③ 관광공사 사진 — 아직 빈 자리를 앞에서부터, 자리의 장소(앞 장소부터) 사진 가운데 브랜드에서 가장 덜 쓴 첫 장(장면으로 고르면 장면이
      // 가장 잘 맞는 장, 같으면 덜 쓴 장 · 받은 순서).
      for (const row of rows) {
        if (row.state !== 'nomatch' || !row.places || !hasRoom(row) || !tourOk(row)) continue
        for (const place of row.places) {
          const open = optsAt(tourOpts, row, place).filter((o) => !isBlocked(o.candidate.src))
          if (!open.length) continue
          const best = scenes
            ? [...open].sort((a, b) => sceneScore(b) - sceneScore(a) || used(a) - used(b) || a.order - b.order)[0]!
            : open.reduce((b, o) => (used(o) < used(b) ? o : b))
          fill(row, best.candidate, placeScore(place), best)
          row.place = place
          break
        }
      }

      // ③b 장소 없는 자리 — 장소 사전을 읽었고 브랜드 자기 시설 · 고유한 장소 이름이 나온 자리가 아니며 글에 사진 자리가 남은 자리(regionSlot)만.
      // 지역 사진 가운데 자리 낱말(내용어 · 꽃 · 골목 · 바닷가 …, 사람 낱말 · 브랜드 도시 제외, 밤 · 해 질 무렵 자리면 야경 · 노을, 골목
      // 자리면 거리 · 거리 자리면 골목 — REGION_TERM_ALSO · regionAlso)이 제목 · 검색 낱말에 맞는 사진을 낱말이 많이 맞는 순서로(같으면 더한
      // 낱말이 많이 맞는 순서 — 자리 낱말이 맞는 사진이 더한 낱말만 맞는 사진보다 먼저) 자리마다 REGION_SCENE_LIMITS.perSlot장만 장면을 읽고(sceneWanted region), 장면이
      // 맞고(sceneFit — 종류 · 사람 · 화면은 그대로 뺀다) 자리 낱말이 장면 · 사진 제목에 하나 이상 맞는(하나도 없으면 더한 낱말 — alsoHits,
      // 장면 점수에는 더하지 않는다) 사진을 장면 점수 순서로 넣는다(장소로 묶어 둘 이름이 없어서). 늘 「확인 필요」, 시간만 다르면 ④ 비슷한 사진.
      const regionRows: AutoSlotRow[] = []
      for (const row of rows) {
        if (row.state !== 'nomatch' || row.places?.length || input.placesUnknown || !regionSlotOk(row)) continue
        if (!hasRoom(row)) {
          if (input.regionCity) regionFull.add(row)
          continue
        }
        row.regionSlot = true
        if (regionPool) regionRows.push(row)
      }
      for (const row of regionRows) {
        const w = wantsOf(row)
        const slotText = `${row.slot.key} ${row.caption}`
        const own = [
          ...new Set([
            ...regionTerms(slotText, regionStop).filter((t) => !PEOPLE_SCENE.test(t)),
            ...(w.times?.[0] === 'night' ? ['야경'] : w.times?.[0] === 'dusk' ? ['노을'] : []),
          ]),
        ]
        const also = regionAlso(own, slotText)
        const ranked = regionPool!
          .map((candidate, i) => ({
            candidate,
            i,
            n: termHits(own, termsOfCandidate(candidate)).length,
            alsoN: also.length ? alsoHits(also, contentWords(`${candidate.alt} ${candidate.keywords ?? ''}`, regionStop)).length : 0,
          }))
          .filter((x) => x.n + x.alsoN > 0)
        for (const x of ranked) regionMatched.add(x.candidate.src)
        const top = ranked.sort((a, b) => b.n - a.n || b.alsoN - a.alsoN || a.i - b.i).slice(0, REGION_SCENE_LIMITS.perSlot).map((x) => x.candidate)
        row.regionTried = top.length
        regionWants.push(top)
        const opts: Options = { fit: [], soft: [] }
        top.forEach((candidate, order) => {
          if (removed(row, candidate.src)) return
          const scene = scenes!.get(candidate.src)
          if (!scene) {
            skipScene(row, input.sceneFailed?.has(candidate.src) ? 'failed' : 'unread')
            return
          }
          const fit = sceneFit(w, scene)
          if (!fit.ok && !fit.soft) {
            skipScene(row, fit.miss!)
            return
          }
          const seenTerms = [...scene.tags.map((t) => t.toLowerCase()), ...regionTerms(scene.text.replace(NO_PEOPLE_TEXT, ' '), new Set()), ...regionTerms(candidate.alt, regionStop)]
          const ownAnchors = termHits(own, seenTerms)
          const anchors = ownAnchors.length || !also.length ? ownAnchors : alsoHits(also, contentWords(`${scene.tags.join(' ')} ${scene.text.replace(NO_PEOPLE_TEXT, ' ')} ${candidate.alt}`, regionStop))
          if (!anchors.length) {
            skipScene(row, 'words')
            return
          }
          if (!fit.ok) skipScene(row, fit.miss!)
          opts[fit.ok ? 'fit' : 'soft'].push({ candidate, order, scene, fit: { ...fit, score: fit.score + ownAnchors.length, words: [...new Set([...fit.words, ...anchors])] } })
        })
        regionOpts.set(row, opts)
      }
      for (const row of regionRows) {
        if (row.state !== 'nomatch' || !hasRoom(row)) continue
        const open = (regionOpts.get(row)?.fit ?? []).filter((o) => !isBlocked(o.candidate.src))
        if (!open.length) continue
        const best = [...open].sort((a, b) => sceneScore(b) - sceneScore(a) || a.order - b.order)[0]!
        fill(row, best.candidate, regionScore(best), best)
        row.placeless = true
      }
    }

    /**
     * ④ 비슷한 사진 — 모든 글에서 장면이 맞는 사진을 고른 뒤, 장면이 맞는 사진이 어디에도 없어(①②③③b 모두 — 반복 상한에 걸린 사진 포함)
     * 아직 빈 자리에 시간만 다른 사진(soft — 낮 사진 · 해 질 무렵 자리)을 장면 점수가 높은 것부터(같으면 홈페이지 → 장소 페이지 → 관광공사 →
     * 지역 사진, 그 안에서는 ①②③③b의 순서). 장면을 아직 읽지 않은 후보가 남은 자리는 넣지 않는다(맞는 사진이 있는지 모른다 — unread). 늘
     * 「확인 필요」. 종류 · 사람 · 화면이 어긋난 사진은 쓰지 않는다(틀린 사진은 빈자리보다 나쁘다).
     */
    const similarStage = () => {
      for (const row of rows) {
        // 시간만 다른 자동 사진(soft)은 바꿀 비슷한 사진을 찾지 않는다 — 그 사진이 이미 비슷한 사진이다.
        if (row.state !== 'nomatch' || !hasRoom(row) || row.oldFit?.soft || row.sceneSkips?.unread) continue
        const rowPlaces = row.places ?? []
        const fromPlace = (m: Map<AutoSlotRow, Map<string, Options>>, stage: number) =>
          rowPlaces.flatMap((place, i) =>
            optsAt(m, row, place, 'soft').map((o): Similar => ({ ...o, fit: o.fit!, score: placeScore(place), place, rank: [-sceneScore(o), stage, i, stage === 2 ? used(o) : 0, o.order] })),
          )
        const list: Similar[] = [
          ...softPairs
            .filter((p) => p.row === row)
            .sort(better)
            .map((p, order): Similar => ({ candidate: p.candidate, score: p.score, ...(p.scene ? { scene: p.scene } : {}), fit: p.fit!, rank: [-p.fit!.score, 0, 0, 0, order] })),
          ...fromPlace(publicOpts, 1),
          ...(tourOk(row) ? fromPlace(tourOpts, 2) : []),
          ...(regionOpts.get(row)?.soft ?? []).map((o): Similar => ({ ...o, fit: o.fit!, score: regionScore(o), region: true, rank: [-sceneScore(o), 3, 0, 0, o.order] })),
        ]
        const best = list.filter((o) => !isBlocked(o.candidate.src)).sort(byRank)[0]
        if (!best?.scene) continue
        fill(row, best.candidate, best.score, best, similarWhy(wantsOf(row), best.scene))
        if (best.place) row.place = best.place
        if (best.region) row.placeless = true
      }
    }

    /**
     * 자사 화면 — 모든 글의 사진(①②③③b · 비슷한 사진)을 고른 뒤, 화면 자리(state screen) 가운데 코스 · 지도 자리(screenOfRow)에 글에 남은
     * 자리만큼. 변형은 자리 글자로 좁힌 묶음(screenVariantChoice — 원도심 장소 → #r-원도심, 장면 글자 · 소제목 · 설명 줄이 아이 · 부모님 →
     * 그 조건, 혼자 · 연인 → 기본만, 조건을 말하지 않으면 기본 다음 조건) 앞부터, 묶음 안에서는 브랜드에서 덜 쓴 변형(같으면 표 순서). 같은
     * 「화면 + 변형」은 글 하나 · 작성자 한 사람에게 한 번이고 브랜드 상한은 받지 않는다(결정 3).
     * 사람이 그 자리에서 뺀 화면(refill — removed의 화면 열쇠)은 고르지 않는다. 사람 장면 규칙(isPeopleScene)은 보지 않는다(화면이다).
     * 찍을 수 있으면 변형은 찍었는지와 상관없이 고르고, 아직 찍지 않았으면 uncaptured로 두어 screenWanted로 청한다(찍은 뒤 같은 결과가
     * 나오게). 찍을 수 없으면(웹 · dev) 찍어 둔 변형을 먼저 고른다. 글에 넣지 않는 종류(지도 — SCREEN_AUTO_SAVE_KINDS 밖)는 미리보기
     * (preview)만 — 보낼 사진(out)에 넣지 않고 글의 사진 수도 쓰지 않는다. 지도는 늘 「확인 필요」(지도에 장소 이름이 보이지 않을 수 있다),
     * 코스는 첫 묶음 밖의 변형을 쓸 때 — 자리가 말한 조건의 변형을 쓰지 못했거나, 조건을 말하지 않는 자리에 조건 변형을 쓸 때 — 「확인
     * 필요」. 글의 사진 수(room)는 고치지 않는다 — finish가 사진 자리의 상태를
     * 지금처럼 정하게(사진이 먼저다).
     */
    const screenStage = () => {
      const screens = input.screens
      if (!screens || !screenProfile) return
      let left = room
      const blocked = (key: string) =>
        inArticle.has(key) || (article.group !== undefined && (groupUsed.get(article.group)?.get(key) ?? 0) > 0)
      for (const row of rows) {
        const screen = screenOfRow.get(row)
        if (row.state !== 'screen' || !screen) continue
        if (left <= 0) {
          row.state = 'full'
          continue
        }
        const choice = screenVariantChoice(screen, row.slot.key, places.length ? findPlaces(row.slot.key, places) : [], `${row.slot.heading}\n${row.caption}`)
        const open = (v: ScreenVariant) => !blocked(screenKey(screen, v)) && !removed(row, screenKey(screen, v))
        const shotOf = (v: ScreenVariant) => shotAt.get(`${screen.id}:${v.id}`)
        const byUse = (a: ScreenVariant, b: ScreenVariant) =>
          (brandCount.get(screenKey(screen, a)) ?? 0) - (brandCount.get(screenKey(screen, b)) ?? 0) || screen.variants.indexOf(a) - screen.variants.indexOf(b)
        const choose = (ok: (v: ScreenVariant) => boolean) => {
          for (const [tier, list] of choice.tiers.entries()) {
            const best = list.filter(ok).sort(byUse)[0]
            if (best) return { variant: best, tier }
          }
          return null
        }
        const any = choose(open)
        if (!any) {
          row.state = 'used'
          continue
        }
        const chosen = screens.available ? any : (choose((v) => open(v) && Boolean(shotOf(v))) ?? any)
        const { variant } = chosen
        const key = screenKey(screen, variant)
        const shot = shotOf(variant)
        const saveAllowed = screenSaveAllowed(screen.kind)
        inArticle.add(key)
        countUse(key, article.group)
        if (saveAllowed) left -= 1
        row.screenPick = {
          screenId: screen.id,
          variantId: variant.id,
          kind: screen.kind,
          label: screen.label,
          variantLabel: variant.label,
          url: screenUrl(screenProfile, variant),
          saveAllowed,
          ...(shot ? { shot } : {}),
          ...(choice.by ? { by: choice.by } : {}),
        }
        if (!shot) {
          row.state = 'uncaptured'
          const k = `${screen.id}:${variant.id}`
          if (screens.available && !screenWanted.has(k)) screenWanted.set(k, { screenId: screen.id, variantId: variant.id })
          continue
        }
        const pick: AutoPickInput = {
          slot: row.slot.key,
          nth: row.slot.nth,
          same: row.slot.same,
          heading: row.slot.heading,
          src: shot.src,
          alt: cleanPhotoAlt(screenAlt(input.brandName ?? '', screen)),
          pageUrl: shot.url,
          auto: true,
          origin: 'screen',
          screenId: screen.id,
          variantId: variant.id,
          capturedAt: shot.capturedAt,
          shotId: shot.id,
        }
        Object.assign(row, { state: saveAllowed ? 'filled' : 'preview', pick, ...(screen.kind === 'map' || chosen.tier > 0 ? { review: true } : {}) })
        if (saveAllowed) out.push(pick)
      }
    }

    // 맞는 사진이 있었는데 넣지 못한 자리 — 글이 다 찼거나 반복 상한에 걸렸다. 장소의 공공 사진이 모두 「제1유형 아님」으로 빠졌으면 license.
    // 홈페이지 사진 짝만 상한에 걸리고 장소 사진이 없던 자리는 homeOnly, 장면으로 고를 때 장면이 맞는 장소 페이지 사진이 상한에 걸리고 그
    // 장소들의 관광공사 사진은 아직 없는 자리는 askTour — 관광공사 사진을 찾을 자리다(tourPlacesWanted). 지역 사진으로 채울 장소 없는 자리인데
    // 글이 다 찼으면 full. 장면으로 고를 때 후보가 장면 때문에 모두 빠졌으면(장면을 읽지 못한 사진 포함) scene, 장면을 아직 읽지 않은 후보가
    // 있으면 unread(다시 누르면 이어서 읽는다).
    const licenseOnly = (place: string) => {
      const reasons = skippedByPlace.get(place) ?? []
      return reasons.length > 0 && !publicByPlace.get(place)?.length && !tourByPlace.get(place)?.length && reasons.every((r) => r === 'license')
    }
    const finish = (): AutoArticleResult => {
      for (const row of rows) {
        if (row.state !== 'nomatch') continue
        if (row.old) {
          // 다시 본 자동 사진 — 바꿀 사진이 없다. 시간만 다르면 비슷한 사진으로 두고, 아니면 뺀다(사람이 뺀 자리로 적지 않는다 — 이미 덜어 냈다).
          if (row.oldFit?.soft && row.oldScene) {
            Object.assign(row, { state: 'kept', recheck: 'similar', scene: row.oldScene, fit: row.oldFit, similar: similarWhy(wantsOf(row), row.oldScene), review: true })
          } else {
            Object.assign(row, { state: 'remove', recheck: 'remove' })
            replaces.push({ place: { slot: row.old.slot, nth: row.old.nth, heading: row.old.heading }, src: row.old.src })
          }
          continue
        }
        const best = pairs.filter((p) => p.row === row).sort(better)[0]
        const publicPlace = row.places?.find((place) => optsAt(publicOpts, row, place).length || optsAt(tourOpts, row, place).length)
        const askTour = Boolean(scenes) && room > 0 && Boolean(publicPlace) && !row.places?.some((place) => tourByPlace.get(place)?.length)
        if (best)
          Object.assign(row, {
            state: room === 0 ? 'full' : 'used',
            candidate: best.candidate,
            score: best.score,
            ...(best.scene ? { scene: best.scene } : {}),
            ...(best.fit ? { fit: best.fit } : {}),
            ...(room > 0 && !publicPlace ? { homeOnly: true } : {}),
            ...(askTour ? { askTour: true } : {}),
          })
        else if (publicPlace) {
          const o = optsAt(publicOpts, row, publicPlace)[0] ?? optsAt(tourOpts, row, publicPlace)[0]!
          Object.assign(row, {
            state: room === 0 ? 'full' : 'used',
            candidate: o.candidate,
            score: placeScore(publicPlace),
            place: publicPlace,
            ...(o.scene ? { scene: o.scene } : {}),
            ...(o.fit ? { fit: o.fit } : {}),
            ...(askTour ? { askTour: true } : {}),
          })
        } else if (regionFull.has(row)) row.state = 'full'
        else if (row.places?.some(licenseOnly)) row.state = 'license'
        else if (row.sceneSkips?.unread) row.state = 'unread'
        else if (row.sceneSkips) row.state = 'scene'
      }

      // 이미 고른 사진 가운데 출처 없는 공공 사진 — 같은 사진이 제1유형 · 출처와 함께 장소 페이지에 있으면 출처를 붙인다.
      const credits: AutoCreditPatch[] = []
      for (const p of picks) {
        if (photoCreditState(p) !== 'missing') continue
        const hit = creditBySrc.get(canonicalPhotoSrc(p.src) ?? p.src)
        if (hit) credits.push({ place: { slot: p.slot, nth: p.nth, heading: p.heading }, src: p.src, fields: hit.fields, pageUrl: hit.pageUrl })
      }
      return { actionId: article.actionId, generatedAt: article.generatedAt, rows, picks: out, replaces, credits }
    }
    return { fitStages, similarStage, screenStage, finish }
  })
  for (const w of workers) w.fitStages()
  for (const w of workers) w.similarStage()
  for (const w of workers) w.screenStage()
  const articles = workers.map((w) => w.finish())
  // 지역 사진의 장면 — 자리를 돌아가며(첫째 자리의 1번 · 둘째 자리의 1번 …) 넣는다. 한 번 누를 때 REGION_SCENE_LIMITS.perRun장까지는 읽기
  // 쪽(src/lib/sitePhotos.ts loadScenesFor)이 REGION_SCENE_PLACE로 센다.
  const regionWanted = new Set<string>()
  for (let i = 0; i < REGION_SCENE_LIMITS.perSlot; i += 1) {
    for (const list of regionWants) {
      const c = list[i]
      if (!c) continue
      regionWanted.add(c.src)
      want({ src: c.src, place: REGION_SCENE_PLACE, ...(c.month ? { month: c.month } : {}) }, 'region')
    }
  }
  return {
    articles,
    skipped,
    usable: usable.length,
    usablePublic,
    usableTour,
    sceneWanted,
    screenWanted: [...screenWanted.values()],
    ...(regionPool ? { region: { rows: regionWants.length, pool: regionPool.length, matched: regionMatched.size, wanted: regionWanted.size } } : {}),
  }
}

/**
 * 지역 사진을 찾을 장소 없는 자리 수 — 지역 사진으로 채울 수 있는 자리(regionSlot — 장소 사전을 읽었고, 브랜드 자기 시설 · 고유한 장소
 * 이름이 나온 자리가 아니며, 글에 사진 자리가 남았다) 가운데 아직 빈(맞는 사진 없음 · 장면이 맞는 사진 없음 · 아직 읽지 않음 · 홈페이지 짝만
 * 상한에 걸림 · 장면이 어긋나 뺌) 자리와 비슷한 사진으로 채운 자리. 화면이 이 수가 있을 때만 지역 사진을 부른다.
 */
export function regionRowsWanted(result: Pick<AutoPickResult, 'articles'>): number {
  return result.articles
    .flatMap((a) => a.rows)
    .filter(
      (row) =>
        row.regionSlot &&
        (row.state === 'nomatch' || row.state === 'scene' || row.state === 'unread' || row.state === 'remove' || Boolean(row.similar) || (row.state === 'used' && row.homeOnly)),
    ).length
}

/** 미리보기 요약의 셈(src/components/PhotoAutoFill.tsx). */
export interface AutoPreviewCounts {
  /** 채울 자리(filled)와 그 가운데 공공 사진 · 관광공사 사진 · 확인 필요 · 비슷한 사진 · 장소 없는 자리 · 사람이 뺀 자리. */
  filled: { all: number; public: number; tour: number; review: number; similar: number; placeless: number; refill: number }
  /** 장면이 어긋나 바꿀 자동 사진(replace)과 그 가운데 확인 필요 · 비슷한 사진 · 장소 없는 자리. */
  replaced: { all: number; review: number; similar: number; placeless: number }
  /** 장면이 어긋나 뺄 자동 사진. */
  removed: number
  /** 다시 보고 그대로 둔 자동 사진 — 장면 맞음 · 비슷한 사진으로 둠 · 장면 모름. */
  kept: { fit: number; similar: number; unknown: number }
  /** 장소가 나온 빈 자리 — 채우지 못했거나 저장하면 비는(뺄) 자리. 사진이 있는 자리 · 채울 · 바꿀 자리는 세지 않는다. */
  emptyPlaces: number
}

/**
 * 미리보기 요약의 셈 — 「채울 자리 n (확인 필요 m · 비슷한 사진 …)」은 채울 자리만 세고, 바꿀 자리의 확인 필요 · 비슷한 사진 · 장소 없는
 * 자리는 바꿈에 따로 센다(비슷한 사진으로 둔 자리 · 바꿀 자리가 채울 자리의 「확인 필요」에 섞이지 않게). 장소가 나온 빈 자리에는 다시 보고
 * 그대로 둔 · 바꿀 자동 사진 자리를 세지 않는다.
 */
export function autoPreviewCounts(rows: readonly AutoSlotRow[]): AutoPreviewCounts {
  const filled = rows.filter((r) => r.state === 'filled')
  const replaced = rows.filter((r) => r.state === 'replace')
  const kept = (k: NonNullable<AutoSlotRow['recheck']>) => rows.filter((r) => r.state === 'kept' && r.recheck === k).length
  return {
    filled: {
      all: filled.length,
      public: filled.filter((r) => r.pick?.origin === 'public' && !r.candidate?.tour).length,
      tour: filled.filter((r) => r.candidate?.tour).length,
      review: filled.filter((r) => r.review).length,
      similar: filled.filter((r) => r.similar).length,
      placeless: filled.filter((r) => r.placeless).length,
      refill: filled.filter((r) => r.refill).length,
    },
    replaced: {
      all: replaced.length,
      review: replaced.filter((r) => r.review).length,
      similar: replaced.filter((r) => r.similar).length,
      placeless: replaced.filter((r) => r.placeless).length,
    },
    removed: rows.filter((r) => r.state === 'remove').length,
    kept: { fit: kept('fit'), similar: kept('similar'), unknown: kept('unknown') },
    emptyPlaces: rows.filter((r) => r.place && r.state !== 'filled' && r.state !== 'kept' && r.state !== 'replace').length,
  }
}

/**
 * 이번에 돌지 않는 글의 고른 사진 — 브랜드 · 작성자 반복 상한에 센다. src는 반복 열쇠(photoRepeatKey) — 사진은 주소, 자사 화면은 「화면 +
 * 변형」(다른 날 다시 찍은 같은 화면도 같은 화면으로 센다).
 */
export function otherPhotoUses(
  drafts: Readonly<Record<string, { photos?: readonly PhotoPick[] }>>,
  exclude: ReadonlySet<string>,
  groupOf: (actionId: string) => string | undefined = () => undefined,
): { src: string; group?: string }[] {
  const out: { src: string; group?: string }[] = []
  for (const [id, d] of Object.entries(drafts)) {
    if (exclude.has(id)) continue
    const group = groupOf(id)
    for (const p of d.photos ?? []) out.push({ src: photoRepeatKey(p), ...(group ? { group } : {}) })
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
