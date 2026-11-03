/**
 * 사진 자리 자동 채우기(1단계 — 홈페이지 사진). 글의 사진 자리 글자와 홈페이지 사진 후보(src/lib/sitePhotos.ts)의 설명을 낱말로 맞춰
 * 자리마다 사진을 한 장 고른다. AI를 부르지 않고, 같은 입력이면 늘 같은 결과다.
 *
 * 틀린 사진은 빈자리보다 나쁘다 — 사람이 고른 사진 3장이 이미 장면과 어긋났다(2026-11-03 점검). 그래서 문턱(AUTO_PICK_RULES)에
 * 못 미치면 비워 두고, 다음은 아예 보지 않는다.
 * - 자리: 웹사이트 화면 자리(사진이 아니라 캡처가 맞다) · 이미 사진이 있는 자리 · 사람이 사진을 뺀 자리.
 * - 후보: 설명 없는 사진 · 일러스트 · 사람이 찍힌 사진(초상권) · 출처 표시가 필요한 공공 사진(2단계에서 출처 줄과 함께 다룬다).
 * 사람이 나오는 장면 자리(가족 · 둘이 · 여행자 …)에는 풍경이 맞으면 넣되 「확인 필요」로 표시한다.
 *
 * 같은 사진은 한 글에 한 번, 한 작성자(group)의 글 사이에 한 번, 브랜드 전체에서 AUTO_PICK_RULES.brandRepeat번까지.
 * 서버(server/index.ts op auto)도 이 파일의 후보 검사를 다시 하므로 DOM을 쓰지 않는다.
 */
import { canonicalPhotoSrc, cleanPhotoAlt, matchPhotos, normSlotAlt, PHOTO_LIMITS, photoSlotsOf, type PhotoPick, type PhotoPlace, type PhotoSlot } from './articlePhotos.js'

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
/** 출처 표시가 필요한 공공 사진의 호스트(공공누리 · 한국관광공사 · 정부 기관) — 출처 줄이 생기는 2단계 전에는 넣지 않는다. */
const CREDIT_HOSTS = ['visitkorea.or.kr', 'knto.or.kr', 'kogl.or.kr', 'go.kr']

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

export type AutoCandidateSkip = 'bad-src' | 'no-alt' | 'illustration' | 'people' | 'credit' | 'duplicate'

export const AUTO_CANDIDATE_SKIP_TEXT: Record<AutoCandidateSkip, string> = {
  'bad-src': 'https 주소가 아님',
  'no-alt': '설명 없음',
  illustration: '일러스트',
  people: '사람이 찍힘',
  credit: '출처 표시가 필요한 공공 사진(다음 단계)',
  duplicate: '같은 사진',
}

/** 자동 채우기 후보 — 홈페이지 사진 하나(src/lib/sitePhotos.ts SitePhoto + 찾은 페이지). */
export interface AutoCandidate {
  src: string
  alt: string
  pageUrl: string
  /** 페이지가 출처 표시가 필요한 사진으로 표시했다(공공누리 data-kogl · 구조화 데이터의 license · creditText). */
  credit?: boolean
}

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

/** 자동으로 넣지 않는 후보인가 — 이유, 아니면 null. 서버도 같은 검사를 한다. */
export function autoCandidateSkip(c: Pick<AutoCandidate, 'src' | 'alt' | 'credit'>): AutoCandidateSkip | null {
  if (!canonicalPhotoSrc(c.src)) return 'bad-src'
  const alt = cleanPhotoAlt(c.alt)
  if (!alt) return 'no-alt'
  if (/^일러스트/.test(alt)) return 'illustration'
  if (PEOPLE_PHOTO.test(alt)) return 'people'
  if (c.credit || needsPhotoCredit(c.src)) return 'credit'
  return null
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
 * used 맞는 사진이 반복 상한에 걸림 · full 글 하나에 사진 PHOTO_LIMITS.picks장이 다 참.
 */
export type AutoSlotState = 'filled' | 'kept' | 'cleared' | 'screen' | 'nomatch' | 'used' | 'full'

export const AUTO_SLOT_STATE_TEXT: Record<AutoSlotState, string> = {
  filled: '채움',
  kept: '이미 사진 있음',
  cleared: '사람이 뺀 자리',
  screen: '화면 자리(비워 둠)',
  nomatch: '맞는 사진 없음',
  used: '맞는 사진을 이미 다 씀',
  full: '사진 3장이 다 참',
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
  /** 사람이 나오는 장면 자리에 넣었다 — 미리보기에 「확인 필요」. */
  review?: boolean
}

export interface AutoArticleResult {
  actionId: string
  generatedAt: string
  rows: AutoSlotRow[]
  picks: AutoPickInput[]
}

export interface AutoPickResult {
  articles: AutoArticleResult[]
  /** 자동으로 쓰지 않는 후보와 그 이유. */
  skipped: { candidate: AutoCandidate; reason: AutoCandidateSkip }[]
  /** 자동으로 쓸 수 있는 후보 수. */
  usable: number
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

/**
 * 글마다 빈 사진 자리에 홈페이지 사진을 고른다 — 글은 받은 순서(작성자 배정 순서)대로, 글 안에서는 점수가 높은 짝부터. 같은 점수면
 * 앞 자리, 브랜드에서 덜 쓴 사진, 주소 사전순. others는 이번에 돌지 않는 글의 고른 사진(브랜드 · 작성자 반복 상한에 센다).
 */
export function autoPickPhotos(input: {
  articles: readonly AutoArticle[]
  candidates: readonly AutoCandidate[]
  others?: readonly { src: string; group?: string }[]
  /** 장면을 가르지 못하는 낱말을 뽑을 브랜드 이름(「스테이,머뭄」 — 브랜드 사진이면 모두 그 브랜드다). */
  brandName?: string
}): AutoPickResult {
  const stop = new Set(contentWords(input.brandName ?? ''))
  const skipped: AutoPickResult['skipped'] = []
  const usable: AutoCandidate[] = []
  const seen = new Set<string>()
  for (const raw of input.candidates) {
    const src = canonicalPhotoSrc(raw.src)
    const reason = autoCandidateSkip(raw) ?? (src && seen.has(src) ? 'duplicate' : null)
    if (reason || !src) {
      skipped.push({ candidate: raw, reason: reason ?? 'bad-src' })
      continue
    }
    seen.add(src)
    usable.push({ ...raw, src, alt: cleanPhotoAlt(raw.alt) })
  }
  usable.sort((a, b) => (a.src < b.src ? -1 : a.src > b.src ? 1 : 0))

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
      return { slot, caption, state }
    })
    type Pair = { row: AutoSlotRow; candidate: AutoCandidate; score: SlotScore }
    const pairs: Pair[] = []
    for (const row of rows) {
      if (row.state !== 'nomatch') continue
      for (const candidate of usable) {
        const score = scoreSlot({ key: row.slot.key, caption: row.caption, heading: row.slot.heading }, candidate.alt, stop)
        if (score.pass) pairs.push({ row, candidate, score })
      }
    }
    const blocked = (p: Pair) =>
      inArticle.has(p.candidate.src) ||
      (article.group !== undefined && Boolean(groupUsed.get(article.group)?.has(p.candidate.src))) ||
      (brandCount.get(p.candidate.src) ?? 0) >= AUTO_PICK_RULES.brandRepeat
    const better = (a: Pair, b: Pair) =>
      b.score.score - a.score.score ||
      a.row.slot.line - b.row.slot.line ||
      (brandCount.get(a.candidate.src) ?? 0) - (brandCount.get(b.candidate.src) ?? 0) ||
      (a.candidate.src < b.candidate.src ? -1 : a.candidate.src > b.candidate.src ? 1 : 0)

    const out: AutoPickInput[] = []
    for (;;) {
      const open = pairs.filter((p) => p.row.state === 'nomatch' && !blocked(p))
      if (!open.length || room === 0) break
      const best = open.sort(better)[0]!
      const { row, candidate, score } = best
      const pick: AutoPickInput = {
        slot: row.slot.key,
        nth: row.slot.nth,
        same: row.slot.same,
        heading: row.slot.heading,
        src: candidate.src,
        alt: candidate.alt,
        pageUrl: candidate.pageUrl,
        auto: true,
      }
      Object.assign(row, { state: 'filled', pick, candidate, score, ...(isPeopleScene(row.slot.key) ? { review: true } : {}) })
      out.push(pick)
      inArticle.add(candidate.src)
      countUse(candidate.src, article.group)
      room -= 1
    }
    // 맞는 사진이 있었는데 넣지 못한 자리 — 글이 다 찼거나 반복 상한에 걸렸다.
    for (const row of rows) {
      if (row.state !== 'nomatch') continue
      const best = pairs.filter((p) => p.row === row).sort(better)[0]
      if (best) Object.assign(row, { state: room === 0 ? 'full' : 'used', candidate: best.candidate, score: best.score })
    }
    return { actionId: article.actionId, generatedAt: article.generatedAt, rows, picks: out }
  })
  return { articles, skipped, usable: usable.length }
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
      return JSON.stringify([id, d.generatedAt, d.editedAt ?? '', (d.photos ?? []).map((p) => `${place(p)}=${p.src}`), (d.photoCleared ?? []).map(place)])
    })
    .join('\n')
}

/** 사진 자리 셈 — 작성자 줄의 「사진 자리 n · 채움 m · 자동 k · 빈자리 j」. 채움은 지금 글에 실제로 들어가는 사진이다. */
export function photoSlotStats(articles: readonly { markdown: string; picks?: readonly PhotoPick[] }[]): {
  slots: number
  filled: number
  auto: number
  empty: number
} {
  let slots = 0
  let filled = 0
  let auto = 0
  for (const a of articles) {
    slots += photoSlotsOf(a.markdown).length
    const applied = matchPhotos(a.markdown, a.picks ?? []).applied
    filled += applied.length
    auto += applied.filter((x) => x.pick.auto).length
  }
  return { slots, filled, auto, empty: slots - filled }
}
