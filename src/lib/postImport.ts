/**
 * 주소 한꺼번에 등록 — 순수 규칙. 화면은 발행 현황(src/pages/PublishStatus.tsx)의 src/components/PostImportPanel.tsx, 서버는
 * server/postImport.ts(페이지 읽기 · 짝짓기 · 등록). 기록 모양은 src/lib/postRegistration.ts(CLI와 같은 규칙)가 정한다.
 *
 * 작성자들은 받은 글을 자기 블로그(네이버 블로그 · 티스토리 · 워드프레스)에 올리고 운영자에게 주소를 메일로 보낸다. 운영자는 글마다 페이지를
 * 열어 어느 앱 글인지 맞춰 보고 「올렸어요」를 눌렀다(2026-11-09 손으로 48건 — 한 건도 틀리지 않은 방법을 그대로 옮겼다):
 *   페이지 → 제목 · 올린 날 · 본문 → 모든 고객 브랜드의 모든 초안과 2글자 묶음 겹침(Jaccard) → 가장 잘 맞는 글.
 *
 * ── 맞음 기준(MATCH_RULE) ──────────────────────────────────────────────────
 * 11-09 실측(올린 글 48편 + 앱 글이 아닌 11편): 맞는 글의 본문 겹침 0.43~0.85, 그때 다음 후보는 0.27 이하. 앱 글이 아닌 글은 가장 잘
 * 맞는 초안도 0.16 이하. 그래서 「맞음」은 본문 0.35 이상이고 다음 후보보다 0.15 이상 높을 때 — 0.35는 다른 글의 최고(0.27)와 맞는 글의
 * 최저(0.43) 사이, 0.15는 실측 차이의 최저(0.29)의 절반쯤이다. 그 밖에 0.2 이상이면 「확인 필요」(사람이 후보 셋 가운데 고르거나 「앱 글
 * 아님」), 그 아래는 「앱 글 아님」(그래도 사람이 고를 수 있다). 제목 겹침은 보이기만 한다 — 작성자가 제목을 고쳐 올리기도 한다.
 *
 * ── 올린 날 ─────────────────────────────────────────────────────────────────
 * 페이지에서 읽는다(네이버는 「2시간 전」 같은 상대 시각도 지금 한국 시각으로 센다). 모르면 null — 오늘로 채우지 않는다(확인 불가 원칙).
 * 그 줄은 사람이 날을 골라야 등록된다. 오늘(KST) 뒤 · 2020년 전 날짜는 쓰지 않는다.
 *
 * 서버가 import하므로 상대 import는 .js로 쓰고, 화면 모듈은 끌어오지 않는다. 받은 HTML은 글자로만 다룬다(실행 · 그리기 없음).
 */
import type { StoredDraft } from './api.js'
import { effectiveDraft } from './draftGaps.js'
import { ARTICLE_URL_REASON, isArticleUrl, kstDate, todayKst, trackingKey } from './publishedUrl.js'

export const MATCH_RULE = {
  /** 「맞음」 — 가장 잘 맞는 초안의 본문 겹침 하한. */
  matchBody: 0.35,
  /** 「맞음」 — 다음 후보와의 차이 하한. */
  matchGap: 0.15,
  /** 「확인 필요」 — 본문 겹침 하한(그 아래는 「앱 글 아님」). */
  reviewBody: 0.2,
} as const

/** 화면에 보이는 후보 수. */
export const CANDIDATE_LIMIT = 3
/** 본문으로 보지 않는 짧은 글 — 2글자 묶음이 이보다 적으면 「읽지 못함」(본문을 못 찾은 것을 「앱 글 아님」으로 단정하지 않는다). */
export const MIN_BODY_GRAMS = 30
/** 저장한 블로그 상한. */
export const BLOG_SOURCES_MAX = 30
/** 한 번에 등록하는 줄 상한 — 긴 워드프레스 주소 100줄도 서버 JSON 한도(100KB) 안에 든다. 화면은 40줄씩 나눠 보낸다. */
export const COMMIT_MAX_ITEMS = 100

export type PostPlatform = 'naver' | 'tistory' | 'wordpress' | 'generic'
export const POST_PLATFORM_LABEL: Record<PostPlatform, string> = {
  naver: '네이버 블로그',
  tistory: '티스토리',
  wordpress: '워드프레스',
  generic: '그 밖',
}

const parseUrl = (raw: string): URL | null => {
  try {
    const u = new URL(raw.trim())
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null
  } catch {
    // 주소로 읽히지 않는 값 — 호출부가 건너뛴다.
    return null
  }
}

// ── 붙여 넣은 글에서 주소 찾기 ───────────────────────────────────────────────

export interface ExtractedUrls {
  /** 글 주소(적힌 순서, 같은 글은 한 번). */
  urls: string[]
  /** 글 주소가 아니라 건너뛴 것과 이유(src/lib/publishedUrl.ts ARTICLE_URL_REASON). */
  ignored: { url: string; reason: string }[]
  /** 같은 글(추적 키)이라 겹쳐 뺀 수. */
  duplicates: number
}

/** 주소에 쓰이는 글자 — 공백 · 꺾쇠 · 따옴표 · 한국어 문장 부호에서 끊는다. 한글은 받는다(워드프레스 한글 주소를 풀어 쓴 것). */
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`{}|\\^[\]「」『』〈〉《》，。、]+/gi

/** 주소 끝에 붙은 문장 부호 · 짝 없는 닫는 괄호 · 글 번호 바로 뒤에 붙은 한글(「…/123입니다」)을 뗀다. */
function trimUrl(raw: string): string {
  let u = raw
  for (;;) {
    const before = u
    u = u.replace(/[.,;:!?'"’”…]+$/u, '')
    if (u.endsWith(')') && (u.match(/\(/g)?.length ?? 0) < (u.match(/\)/g)?.length ?? 0)) u = u.slice(0, -1)
    u = u.replace(/(\/\d+)\P{ASCII}+$/u, '$1')
    if (u === before) return u
  }
}

/** Outlook 안전 링크(…safelinks.protection.outlook.com/?url=…)는 원래 주소로. */
function unwrapSafeLink(url: string): string {
  const u = parseUrl(url)
  if (!u || !/(^|\.)safelinks\.protection\.outlook\.com$/i.test(u.hostname)) return url
  const inner = u.searchParams.get('url')
  return inner && parseUrl(inner) ? inner : url
}

/**
 * 메일 · 메모를 붙여 넣은 글에서 http(s) 주소를 찾는다. Outlook이 링크 뒤에 붙이는 <주소>는 꺾쇠 안에서 줄이 바뀌어도 한 주소로 잇고
 * (긴 워드프레스 주소), 안전 링크는 풀고, 같은 글(추적 키)은 한 번만 둔다. 글 한 편의 주소가 아니면(블로그 홈 · 단축 주소 · 첫 화면 ·
 * 글쓰기 화면) 이유와 함께 건너뛴다.
 */
export function extractPostUrls(text: string): ExtractedUrls {
  const joined = text.replace(/<(https?:\/\/[^<>\s]*(?:[ \t]*\r?\n[ \t]*[^<>\s]+)*)>/gi, (_, u: string) => ` ${u.replace(/\s+/g, '')} `)
  const urls: string[] = []
  const ignored: { url: string; reason: string }[] = []
  const seen = new Set<string>()
  let duplicates = 0
  for (const m of joined.matchAll(URL_IN_TEXT)) {
    const url = unwrapSafeLink(trimUrl(m[0]))
    const key = trackingKey(url)
    if (!key) continue
    if (seen.has(key)) {
      duplicates += 1
      continue
    }
    seen.add(key)
    const check = isArticleUrl(url)
    if (check.ok) urls.push(url)
    else ignored.push({ url, reason: ARTICLE_URL_REASON[check.reason] })
  }
  return { urls, ignored, duplicates }
}

// ── 플랫폼 · 읽을 주소 ───────────────────────────────────────────────────────

export function postPlatformOf(url: string): PostPlatform {
  const host = parseUrl(url)?.hostname.toLowerCase() ?? ''
  if (host === 'blog.naver.com' || host === 'm.blog.naver.com') return 'naver'
  if (host.endsWith('.tistory.com')) return 'tistory'
  if (host.endsWith('.wordpress.com')) return 'wordpress'
  return 'generic'
}

const NAVER_ID = /^[A-Za-z0-9_-]{1,50}$/

/** 네이버 블로그 글 — /아이디/글번호 · /아이디?logNo= · PostView.naver?blogId=&logNo=. 글이 아니면 null. */
export function naverPostRef(url: string): { blogId: string; logNo: string } | null {
  const u = parseUrl(url)
  if (!u || postPlatformOf(url) !== 'naver') return null
  const segments = u.pathname.split('/').filter(Boolean)
  const endpoint = segments.length === 1 && /\.(naver|nhn)$/i.test(segments[0]!)
  const blogId = endpoint ? u.searchParams.get('blogId') : segments[0]
  const logNo = endpoint ? u.searchParams.get('logNo') : (segments[1] ?? u.searchParams.get('logNo'))
  return blogId && logNo && NAVER_ID.test(blogId) && /^\d{1,20}$/.test(logNo) ? { blogId, logNo } : null
}

/** 읽을 주소 — 네이버 글은 본문이 든 PostView(글 주소 페이지는 틀만 있다), 나머지는 그대로. */
export function readTargetOf(url: string): string {
  const ref = naverPostRef(url)
  return ref ? `https://blog.naver.com/PostView.naver?blogId=${ref.blogId}&logNo=${ref.logNo}` : url.trim()
}

// ── HTML을 글자로 ───────────────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  middot: '·',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  bull: '•',
  times: '×',
  copy: '©',
  reg: '®',
  trade: '™',
}

/** HTML 엔티티를 푼다 — 이름(자주 쓰는 것) · 숫자(&#8216; · &#x2019;). 모르는 이름은 그대로 둔다. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1))
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

/** 글이 아닌 요소 — 통째로 뺀다. */
const DROP_BLOCKS = /<(script|style|noscript|template|svg|iframe|object|textarea|select|button)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
/** 본문 둘레의 메뉴 · 꼬리말 · 곁글 · 양식 — 본문을 뽑을 때 뺀다. */
const DROP_FRAME = /<(nav|footer|aside|form|header)\b[^>]*>[\s\S]*?<\/\1\s*>/gi

/** 주석 · 스크립트 · 스타일 등을 걷어낸 HTML. */
function withoutCode(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, ' ').replace(DROP_BLOCKS, ' ')
}

/** HTML 조각을 글자로 — 메뉴 · 꼬리말을 빼고, 문단 경계는 줄바꿈, 엔티티를 풀고, 공백을 줄인다. */
export function htmlToText(html: string): string {
  return decodeEntities(
    withoutCode(html)
      .replace(DROP_FRAME, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|blockquote|section|article)\s*>/gi, '\n')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}

/** 여는 태그의 속성. */
function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(/([^\s=<>"'/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    out[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? ''
  }
  return out
}

/** 클래스 낱말을 가진 여는 태그인가. */
const hasClass = (token: string) => (tag: string) => (attrsOf(tag).class ?? '').split(/\s+/).includes(token)
const hasId = (id: string) => (tag: string) => attrsOf(tag).id === id
const isTag = (name: string) => (tag: string) => new RegExp(`^<${name}\\b`, 'i').test(tag)

/** 조건에 맞는 첫 요소의 안쪽 HTML — 같은 이름의 태그 깊이를 세어 닫는 태그를 찾는다. 없으면 null. */
function elementInner(html: string, test: (openTag: string) => boolean): string | null {
  for (const m of html.matchAll(/<([a-zA-Z][\w-]*)\b[^>]*>/g)) {
    if (!test(m[0])) continue
    const name = m[1]!.toLowerCase()
    const start = m.index! + m[0].length
    const re = new RegExp(`<(/?)${name}\\b[^>]*>`, 'gi')
    re.lastIndex = start
    let depth = 1
    for (let t = re.exec(html); t; t = re.exec(html)) {
      if (t[0].endsWith('/>')) continue
      depth += t[1] ? -1 : 1
      if (depth === 0) return html.slice(start, t.index)
    }
    return html.slice(start)
  }
  return null
}

/** <meta property|name|itemprop=key content=…> 값(엔티티를 푼다). 없으면 null. */
function metaContent(html: string, key: string): string | null {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrsOf(m[0])
    if ((a.property ?? a.name ?? a.itemprop ?? '').toLowerCase() === key && a.content !== undefined) return decodeEntities(a.content).trim()
  }
  return null
}

/** JSON-LD의 datePublished(@graph · 배열 안까지). 깨진 JSON-LD는 건너뛴다. */
function jsonLdDate(html: string): string | null {
  const find = (v: unknown, depth: number): string | null => {
    if (depth > 6 || v === null || typeof v !== 'object') return null
    if (Array.isArray(v)) {
      for (const x of v) {
        const hit = find(x, depth + 1)
        if (hit) return hit
      }
      return null
    }
    const o = v as Record<string, unknown>
    if (typeof o.datePublished === 'string') return o.datePublished
    for (const x of Object.values(o)) {
      const hit = find(x, depth + 1)
      if (hit) return hit
    }
    return null
  }
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    let data: unknown
    try {
      data = JSON.parse(m[1]!.trim())
    } catch {
      // 깨진 JSON-LD — 이 덩어리는 날짜 단서가 아니다. 다른 덩어리 · meta · <time>으로 본다.
      continue
    }
    const hit = find(data, 0)
    if (hit) return hit
  }
  return null
}

const timeDatetime = (html: string) => /<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/i.exec(html)?.[1] ?? null

// ── 날짜 ────────────────────────────────────────────────────────────────────

const realDay = (day: string) => {
  const t = Date.parse(`${day}T00:00:00Z`)
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === day
}
const ymd = (y: string, m: string, d: string) => `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`

/**
 * 페이지의 날짜 글자를 한국 날짜(YYYY-MM-DD)로 — ISO(시간대가 있으면 한국 날짜로 바꾸고, 없으면 그 날짜 그대로) · 「2026. 11. 7. 14:03」 ·
 * 「2026년 11월 7일」 · 네이버 상대 시각(방금 · N초/분/시간/일 전 · 어제 · 그제)은 now(한국 시각)에서 센다. 읽지 못했거나 실제 날짜가
 * 아니거나 오늘(KST) 뒤 · 2020년 전이면 null.
 */
export function parsePostDate(raw: string, now: number): string | null {
  const t = raw.replace(/\s+/g, ' ').trim()
  let day: string | null = null
  const rel = /^(\d{1,3})\s*(초|분|시간|일)\s*전/.exec(t)
  if (/^\d{4}-\d{2}-\d{2}T/.test(t)) day = /([zZ]|[+-]\d{2}:?\d{2})$/.test(t) ? kstDate(t) : t.slice(0, 10)
  else if (/^\d{4}-\d{2}-\d{2}$/.test(t)) day = t
  else if (/^(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/.test(t)) {
    const m = /^(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/.exec(t)!
    day = ymd(m[1]!, m[2]!, m[3]!)
  } else if (/^방금/.test(t)) day = todayKst(now)
  else if (rel) {
    const unit = { 초: 1000, 분: 60_000, 시간: 3_600_000, 일: 86_400_000 }[rel[2] as '초' | '분' | '시간' | '일']
    day = todayKst(now - Number(rel[1]) * unit)
  } else if (/^어제/.test(t)) day = todayKst(now - 86_400_000)
  else if (/^(그제|그저께)/.test(t)) day = todayKst(now - 2 * 86_400_000)
  if (!day || !realDay(day) || day > todayKst(now) || day < '2020-01-01') return null
  return day
}

// ── 페이지 읽기(플랫폼별) ────────────────────────────────────────────────────

export interface ParsedPost {
  title: string
  /** 올린 날(한국 날짜). 모르면 null — 사람이 고른다. */
  publishedOn: string | null
  /** 날짜를 읽은 글자(「2시간 전」 · ISO 등). 없으면 null. */
  dateText: string | null
  /** 본문 글자. */
  body: string
}

/** 플랫폼마다 본문 자리 — 앞에서부터 처음 찾은 것. 없으면 <article> · <main> · <body> · 문서 전체. */
const BODY_PLACES: Record<PostPlatform, ((tag: string) => boolean)[]> = {
  naver: [hasClass('se-main-container'), hasId('postViewArea')],
  tistory: [hasClass('contents_style'), hasClass('tt_article_useless_p_margin'), hasClass('entry-content')],
  wordpress: [hasClass('entry-content')],
  generic: [(tag) => attrsOf(tag).itemprop === 'articleBody', hasClass('entry-content')],
}
const BODY_FALLBACK = [isTag('article'), isTag('main'), isTag('body')]

/** 페이지 HTML에서 제목 · 올린 날 · 본문을 읽는다(플랫폼별 자리, 없으면 일반 단서). now는 상대 시각을 셀 때 쓴다. */
export function parsePostHtml(platform: PostPlatform, html: string, now: number): ParsedPost {
  const code = withoutCode(html)
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(code)?.[1]
  const title = (metaContent(code, 'og:title') || metaContent(code, 'twitter:title') || decodeEntities(titleTag ?? '')).replace(/\s+/g, ' ').trim()
  let fragment: string | null = null
  for (const test of [...BODY_PLACES[platform], ...BODY_FALLBACK]) {
    fragment = elementInner(code, test)
    if (fragment !== null) break
  }
  const naverDate = platform === 'naver' ? (elementInner(code, hasClass('se_publishDate')) ?? elementInner(code, hasClass('_postAddDate'))) : null
  const dateText =
    (naverDate !== null ? htmlToText(naverDate) : null) ||
    metaContent(code, 'article:published_time') ||
    jsonLdDate(html) ||
    (fragment !== null ? timeDatetime(fragment) : null) ||
    timeDatetime(code)
  return {
    title,
    publishedOn: dateText ? parsePostDate(dateText, now) : null,
    dateText: dateText || null,
    body: htmlToText(fragment ?? code),
  }
}

// ── 맞음 정도 ───────────────────────────────────────────────────────────────

/** 비교 글자 — {N}(제목의 절 수 자리)과 기호 · 공백을 빼고 한글 · 영문 · 숫자만. */
const matchChars = (s: string) => s.replace(/\{N\}/g, '').replace(/[^0-9A-Za-z가-힣]+/g, '')

/** 2글자 묶음(겹치는 것은 한 번). */
export function bigrams(text: string): Set<string> {
  const t = matchChars(text)
  const out = new Set<string>()
  for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2))
  return out
}

/** 겹침(Jaccard) — 하나가 비면 0. */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  let both = 0
  for (const g of small) if (big.has(g)) both += 1
  return both / (a.size + b.size - both)
}

/**
 * 초안의 비교 글 — 고친 글이 있으면 그 글(제목은 첫 # 줄, 없으면 초안 제목), 아니면 초안 제목과 첫머리 · 절 제목 · 문단(채운 빈칸 반영,
 * 남은 빈칸 메모는 뺀다). 11-09 손 작업과 같은 재료다.
 */
export function draftMatchText(stored: StoredDraft): { title: string; body: string } {
  const edited = stored.editedMarkdown
  if (edited) return { title: /^#\s+(.+)$/m.exec(edited)?.[1]?.trim() || stored.draft.title, body: edited }
  const d = effectiveDraft(stored)
  const body = [d.lead, ...d.sections.flatMap((s) => [s.heading, ...s.blocks.filter((b) => b.kind !== 'gap').map((b) => b.body ?? '')])].join('\n')
  return { title: stored.draft.title, body }
}

export type MatchState = 'match' | 'review' | 'none'

/** 부동소수 비교 여유 — 0.35 − 0.20 = 0.1499…를 0.15로 본다. */
const EPS = 1e-9

/** 판정 — 후보들의 본문 겹침(순서 상관없음)으로 맞음 · 확인 필요 · 앱 글 아님. */
export function decideMatch(bodyScores: readonly number[]): MatchState {
  const [best = 0, second = 0] = [...bodyScores].sort((a, b) => b - a)
  if (best >= MATCH_RULE.matchBody - EPS && best - second >= MATCH_RULE.matchGap - EPS) return 'match'
  if (best >= MATCH_RULE.reviewBody - EPS) return 'review'
  return 'none'
}

/** 화면 숫자 — 겹침을 백분율로. */
export const scorePercent = (n: number) => `${Math.round(n * 100)}%`

// ── 서버가 주는 읽기 결과 · 줄 상태 ─────────────────────────────────────────

export interface ImportCandidate {
  tenantId: string
  /** 브랜드 이름(범위 변형이면 꼬리표까지 — src/lib/brandVariant.ts brandLabel). */
  brand: string
  articleId: string
  /** 앱 글 제목(콘텐츠 보관함과 같은 제목). */
  title: string
  /** 본문 겹침(0~1). */
  body: number
  /** 제목 겹침(0~1) — 보이기만 한다. */
  titleScore: number
  /** 작성자(콘텐츠 보관함 규칙 — 배정에 있고 그 추가 글을 배정 판으로 만들었다). 배정 밖 글이면 null. */
  writer: { key: string; name: string } | null
  /** 배정이나 추가 글 목록을 읽지 못해 작성자를 모른다(「미확인」). */
  writerUnknown: boolean
  /** 이 글의 자사 · 직접 줄에 이미 적힌 다른 주소 수 — 0이 아니면 같은 글을 또 올렸는지 확인하게 알린다(그래도 더할 수 있다). */
  otherUrls: number
}

/** 이 주소가 고객 브랜드 원장에 적힌 기록(살아 있는 줄 · 옛 기록). */
export interface KnownRecord {
  tenantId: string
  brand: string
  articleId: string
  targetActionId: string
  via: string
  articleTitle: string | null
  publishedOn: string | null
  /** 집행 상태 파일에만 있던 옛 주소. */
  legacy: boolean
}

export interface PostImportReadOk {
  ok: true
  /** 적힌 그대로(앞뒤 공백만 뗀다). */
  url: string
  key: string
  platform: { key: PostPlatform; label: string }
  post: { title: string; publishedOn: string | null; dateText: string | null; bodyChars: number }
  /** 본문 겹침 순 — 많아야 CANDIDATE_LIMIT개. */
  candidates: ImportCandidate[]
  known: KnownRecord[]
}
export interface PostImportReadFail {
  ok: false
  url: string
  key: string | null
  error: string
}
export type PostImportRead = PostImportReadOk | PostImportReadFail

export interface RowPick {
  tenantId: string
  articleId: string
}

/**
 * 고른 글에 이 주소를 적어도 되는가 — 원장에 적힌 기록으로 본다.
 *   already  그 브랜드 · 그 글의 자사 · 직접 줄(targetActionId = 글 id)이나 옛 기록에 이미 있다 — 건너뛴다.
 *   other    다른 글(다른 브랜드 포함)의 주소로 적혀 있다 — 막는다(한 주소는 한 글의 것이다).
 *   fresh    새로 적는다. 같은 글의 채널 줄에만 있던 주소도 여기다(자사 · 직접 줄에도 더한다 — CLI · 「올렸어요」와 같다).
 */
export type UrlVerdict = { kind: 'fresh' } | { kind: 'already'; record: KnownRecord } | { kind: 'other'; record: KnownRecord }

export function urlVerdict(known: readonly KnownRecord[], pick: RowPick): UrlVerdict {
  const mine = known.find((k) => k.tenantId === pick.tenantId && k.articleId === pick.articleId && k.targetActionId === pick.articleId)
  if (mine) return { kind: 'already', record: mine }
  const other = known.find((k) => !k.legacy && (k.tenantId !== pick.tenantId || k.articleId !== pick.articleId))
  if (other) return { kind: 'other', record: other }
  return { kind: 'fresh' }
}

export type RowState = MatchState | 'already' | 'other' | 'unreadable'
export const ROW_STATE_LABEL: Record<RowState, string> = {
  match: '맞음',
  review: '확인 필요',
  none: '앱 글 아님',
  already: '이미 등록됨',
  other: '다른 글로 등록됨',
  unreadable: '읽지 못함',
}

/**
 * 처음 고를 글 — 이 주소가 이미 후보 글의 자사 · 직접 줄에 적혀 있으면 그 글(사람이 둘째 후보를 골라 적은 주소를 다시 읽어도 「이미
 * 등록됨」), 아니면 맞음 · 확인 필요면 첫 후보, 앱 글 아님이면 없음.
 */
export function autoPick(read: PostImportRead): RowPick | null {
  if (!read.ok) return null
  const recorded = read.candidates.find((c) => read.known.some((k) => k.tenantId === c.tenantId && k.articleId === c.articleId && k.targetActionId === c.articleId))
  if (recorded) return { tenantId: recorded.tenantId, articleId: recorded.articleId }
  if (decideMatch(read.candidates.map((c) => c.body)) === 'none') return null
  const c = read.candidates[0]!
  return { tenantId: c.tenantId, articleId: c.articleId }
}

/**
 * 줄 상태 — 읽지 못함 › (고른 글 기준) 이미 등록됨 · 다른 글로 등록됨 › 자동 판정(맞음 · 확인 필요 · 앱 글 아님). 고른 글이 없는데(앱 글
 * 아님) 원장에 이미 적힌 주소면 「이미 등록됨」 — 할 일이 없다.
 */
export function rowStateOf(read: PostImportRead, pick: RowPick | null): { state: RowState; verdict: UrlVerdict | null } {
  if (!read.ok) return { state: 'unreadable', verdict: null }
  const auto = decideMatch(read.candidates.map((c) => c.body))
  if (!pick) {
    const record = read.known[0]
    return record ? { state: 'already', verdict: { kind: 'already', record } } : { state: auto, verdict: null }
  }
  const verdict = urlVerdict(read.known, pick)
  if (verdict.kind === 'already') return { state: 'already', verdict }
  if (verdict.kind === 'other') return { state: 'other', verdict }
  return { state: auto, verdict }
}

/** 처음부터 체크해 둘 줄 — 「맞음」만(날짜를 모르면 사람이 날을 골라야 등록된다). */
export function checkedByDefault(read: PostImportRead): boolean {
  const pick = autoPick(read)
  return pick !== null && rowStateOf(read, pick).state === 'match'
}

// ── 저장한 블로그 · 새 글 찾기 ──────────────────────────────────────────────

export interface BlogSource {
  /** 블로그 홈(normalizeBlogSource). */
  url: string
  platform: PostPlatform
  addedAt: string
}

/**
 * 블로그 주소를 홈으로 맞춘다 — 네이버는 https://blog.naver.com/<아이디>(글 주소 · 모바일 · RSS 주소도 받는다), 티스토리 · 워드프레스는
 * https://<호스트>, 그 밖은 사이트 주소(포트 포함). http(s)가 아니거나 네이버 아이디가 없으면 이유.
 */
export function normalizeBlogSource(raw: string): { ok: true; url: string; platform: PostPlatform } | { ok: false; error: string } {
  const t = raw.trim()
  if (!t) return { ok: false, error: '블로그 주소를 적어 주세요.' }
  if (t.length > 300) return { ok: false, error: `블로그 주소가 너무 깁니다: ${t.slice(0, 60)}…` }
  const u = parseUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`)
  if (!u || !u.hostname) return { ok: false, error: `http(s) 블로그 주소가 아닙니다: ${t}` }
  const host = u.hostname.toLowerCase()
  if (host === 'rss.blog.naver.com' || host === 'blog.naver.com' || host === 'm.blog.naver.com') {
    const segments = u.pathname.split('/').filter(Boolean)
    const first = segments[0]?.replace(/\.xml$/i, '') ?? ''
    const id = naverPostRef(u.href)?.blogId ?? (first && !/\.(naver|nhn)$/i.test(first) ? first : u.searchParams.get('blogId'))
    if (!id || !NAVER_ID.test(id)) return { ok: false, error: `네이버 블로그 아이디가 없는 주소입니다: ${t}` }
    return { ok: true, url: `https://blog.naver.com/${id}`, platform: 'naver' }
  }
  if (host.endsWith('.tistory.com')) return { ok: true, url: `https://${host}`, platform: 'tistory' }
  if (host.endsWith('.wordpress.com')) return { ok: true, url: `https://${host}`, platform: 'wordpress' }
  return { ok: true, url: `${u.protocol}//${u.host.toLowerCase()}`, platform: 'generic' }
}

export type ListKind = 'rss' | 'sitemap' | 'wp-api'

/** 워드프레스(.com) 공개 API의 글 목록 한 쪽(100편). */
export function wpListPageUrl(host: string, page: number): string {
  return `https://public-api.wordpress.com/rest/v1.1/sites/${host}/posts/?number=100&fields=URL,date&page=${page}`
}

/**
 * 저장한 블로그의 글 목록을 읽을 곳 — 네이버 RSS, 티스토리 사이트맵(모든 글) · RSS(최근 10편쯤), 워드프레스(.com) 공개 API(쪽마다 100편),
 * 그 밖은 RSS · feed · 사이트맵. sourceUrl은 normalizeBlogSource가 맞춘 홈.
 */
export function blogListTargets(sourceUrl: string): { kind: ListKind; url: string }[] {
  const platform = postPlatformOf(sourceUrl)
  const host = parseUrl(sourceUrl)?.hostname ?? ''
  if (platform === 'naver') {
    const id = parseUrl(sourceUrl)?.pathname.split('/').filter(Boolean)[0] ?? ''
    return [{ kind: 'rss', url: `https://rss.blog.naver.com/${id}.xml` }]
  }
  if (platform === 'tistory') return [{ kind: 'sitemap', url: `${sourceUrl}/sitemap.xml` }, { kind: 'rss', url: `${sourceUrl}/rss` }]
  if (platform === 'wordpress') return [{ kind: 'wp-api', url: wpListPageUrl(host, 1) }]
  return [
    { kind: 'rss', url: `${sourceUrl}/rss` },
    { kind: 'rss', url: `${sourceUrl}/feed` },
    { kind: 'sitemap', url: `${sourceUrl}/sitemap.xml` },
  ]
}

const cdata = (s: string) => s.trim().replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim()

/** RSS · Atom의 링크 — <link>…</link> · <guid>…</guid>(주소인 것) · <link href="…"/>. 문서 순서. */
export function parseFeedLinks(xml: string): string[] {
  const out: string[] = []
  // 닫는 태그가 있는 것과 스스로 닫는 것(Atom)을 나눠 찾는다 — 한 식으로 쓰면 <link …/> 뒤의 다른 </link>까지 삼킨다.
  for (const m of xml.matchAll(/<(link|guid)\b([^>]*?)\/>|<(link|guid)\b([^>]*)>([\s\S]*?)<\/\3\s*>/gi)) {
    const value = m[1] ? (attrsOf(m[2] ?? '').href ?? '') : cdata(m[5] ?? '') || (attrsOf(m[4] ?? '').href ?? '')
    const url = decodeEntities(value).trim()
    if (/^https?:\/\//i.test(url)) out.push(url)
  }
  return out
}

/** 사이트맵 — 글 주소(<url><loc>)와 하위 사이트맵(<sitemap><loc>). */
export function parseSitemap(xml: string): { urls: string[]; sitemaps: string[] } {
  const locs = (tag: 'url' | 'sitemap') =>
    [...xml.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi'))].flatMap((m) => {
      const loc = /<loc\b[^>]*>([\s\S]*?)<\/loc\s*>/i.exec(m[1]!)?.[1]
      return loc ? [decodeEntities(cdata(loc))] : []
    })
  return { urls: locs('url'), sitemaps: locs('sitemap') }
}

/** 워드프레스 공개 API 응답({ found, posts: [{ URL }] }). 모양이 틀리면 빈 목록. */
export function parseWpPostList(json: unknown): { urls: string[]; found: number | null } {
  if (typeof json !== 'object' || json === null) return { urls: [], found: null }
  const o = json as { found?: unknown; posts?: unknown }
  const posts = Array.isArray(o.posts) ? o.posts : []
  const urls = posts.flatMap((p) => (typeof p === 'object' && p !== null && typeof (p as { URL?: unknown }).URL === 'string' ? [(p as { URL: string }).URL] : []))
  return { urls, found: typeof o.found === 'number' ? o.found : null }
}

/** 그 밖 블로그에서 글이 아닌 첫 단계 경로. */
const GENERIC_NON_POST = /^\/(category|categories|tag|tags|author|page|search|feed|rss|comments|wp-json|wp-content|wp-admin|wp-includes)(\/|$)/i

/**
 * 목록에서 이 블로그의 글 주소만 — 같은 블로그(네이버는 같은 아이디, 그 밖은 같은 호스트)이고 글 한 편의 주소(isArticleUrl)인 것. 네이버는
 * /아이디/글번호로 맞추고(RSS 꼬리표를 뗀다), 티스토리는 숫자 글 · /entry/ 글만(/m/ · 분류 · 태그 · 방명록 · 공지 빼고), 워드프레스는 기본 글
 * hello-world를 뺀다. 같은 글(추적 키)은 한 번.
 */
export function listedPostUrls(sourceUrl: string, urls: readonly string[]): string[] {
  const src = parseUrl(sourceUrl)
  if (!src) return []
  const platform = postPlatformOf(sourceUrl)
  const naverId = platform === 'naver' ? (src.pathname.split('/').filter(Boolean)[0] ?? '').toLowerCase() : ''
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of urls) {
    const u = parseUrl(raw)
    if (!u) continue
    let url = raw.trim()
    if (platform === 'naver') {
      const ref = naverPostRef(url)
      if (!ref || ref.blogId.toLowerCase() !== naverId) continue
      url = `https://blog.naver.com/${ref.blogId}/${ref.logNo}`
    } else {
      if (u.host.toLowerCase() !== src.host.toLowerCase()) continue
      const path = u.pathname.replace(/\/+$/, '')
      if (platform === 'tistory' && !/^\/\d+$/.test(path) && !/^\/entry\/.+/.test(path)) continue
      if (platform === 'wordpress' && path.split('/').pop() === 'hello-world') continue
      if (platform === 'generic' && GENERIC_NON_POST.test(path)) continue
    }
    const key = trackingKey(url)
    if (!key || seen.has(key) || !isArticleUrl(url).ok) continue
    seen.add(key)
    out.push(url)
  }
  return out
}

/** 글 번호(티스토리 숫자 글 · 네이버 글번호) — 클수록 나중 글. 번호가 없는 주소는 null. */
function postNumber(url: string): number | null {
  const ref = naverPostRef(url)
  if (ref) return Number(ref.logNo)
  const m = postPlatformOf(url) === 'tistory' ? /^\/(\d+)\/?$/.exec(parseUrl(url)?.pathname ?? '') : null
  return m ? Number(m[1]) : null
}

/**
 * 최근 글이 앞으로 — 글 번호가 있으면(티스토리 숫자 글 · 네이버) 큰 번호부터, 번호가 없는 주소는 목록 순서 그대로 그 뒤에. RSS ·
 * 워드프레스 API는 이미 최근 순이다. 글이 천 편 넘는 블로그(작성자의 원래 블로그)에서 새 글을 앞에서부터 자르기 위해 쓴다.
 */
export function newestFirst(urls: readonly string[]): string[] {
  return urls
    .map((url, i) => ({ url, i, n: postNumber(url) }))
    .sort((a, b) => (a.n !== null && b.n !== null ? b.n - a.n : a.n !== null ? -1 : b.n !== null ? 1 : a.i - b.i))
    .map((x) => x.url)
}

export interface BlogListResult {
  source: string
  platform: PostPlatform
  /** 이 블로그에서 찾은 글 수. */
  found: number
  /** 고객 브랜드 원장에 살아 있지 않은 글 주소(최근 글부터, 많아야 NEW_URLS_MAX편). */
  newUrls: string[]
  /** 상한을 넘어 돌려주지 않은 더 오래된 새 글 수. */
  older: number
  /** 읽지 못한 목록(일부만 읽었으면 나머지로 찾은 글은 그대로). */
  errors: string[]
}

/** 한 블로그에서 한 번에 돌려주는 새 글 — 글이 천 편 넘는 블로그도 최근 글만 읽게. */
export const NEW_URLS_MAX = 50

// ── 등록 요청 ───────────────────────────────────────────────────────────────

export interface CommitItem {
  tenantId: string
  articleId: string
  url: string
  /** 사람이 확인한 올린 날(YYYY-MM-DD). */
  publishedOn: string
}

export interface CommitResult {
  tenantId: string
  articleId: string
  url: string
  /** added — 새로 적음, existing — 이미 그 글의 기록이라 그대로 둠, error — 적지 않음(이유는 error). */
  status: 'added' | 'existing' | 'error'
  error?: string
  postId?: string
}

/** 등록 요청 본문 검사 — { items: [{ tenantId, articleId, url, publishedOn }] }(글자, COMMIT_MAX_ITEMS줄까지). */
export function parseCommitItems(body: unknown): { ok: true; items: CommitItem[] } | { ok: false; error: string } {
  const items = (body as { items?: unknown } | null)?.items
  if (!Array.isArray(items) || items.length === 0) return { ok: false, error: '등록할 줄(items)이 없습니다.' }
  if (items.length > COMMIT_MAX_ITEMS) return { ok: false, error: `한 번에 ${COMMIT_MAX_ITEMS}줄까지 등록합니다.` }
  const out: CommitItem[] = []
  for (const [i, raw] of items.entries()) {
    const it = raw as Record<string, unknown> | null
    const fields = ['tenantId', 'articleId', 'url', 'publishedOn'] as const
    if (!it || typeof it !== 'object' || fields.some((f) => typeof it[f] !== 'string' || !(it[f] as string).trim() || (it[f] as string).length > 4000)) {
      return { ok: false, error: `${i + 1}번째 줄 모양이 틀렸습니다 — tenantId · articleId · url · publishedOn 글자가 필요합니다.` }
    }
    out.push({ tenantId: it.tenantId as string, articleId: it.articleId as string, url: (it.url as string).trim(), publishedOn: (it.publishedOn as string).trim() })
  }
  return { ok: true, items: out }
}
