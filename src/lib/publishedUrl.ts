/**
 * 올린 글 주소와 AI가 인용한 주소를 맞추는 규칙 — 화면(src/lib/gapActions.ts)과 서버(server/publishedPosts.ts)가 이 한 벌을 쓴다.
 *
 * 런타임 import를 두지 않는다. 서버가 '../src/lib/publishedUrl.js'로 불러 쓰므로, 여기서 다른 모듈을 끌어오면 서버 묶음에
 * 화면 코드가 딸려 들어간다.
 *
 * ── 왜 정확 일치만 세는가 ─────────────────────────────────────────────────────
 * 예전 규칙은 "인용 주소가 올린 주소로 시작하면 같은 글"이었다. 그러면 `…/1`을 올렸는데 `…/12`가 인용돼도 「인용됨」이 된다
 * (설치본 사본의 실제 인용에 이런 쌍이 441개 있었다). 반대로 질의(`?`)가 붙은 변형은 같은 글(나무위키 uuid · 야놀자 체크인)과
 * 다른 글(게시판 idx · category)이 섞여 있어(1,411쌍) 합치면 틀린다. 그래서 숫자는 정확 일치만 세고, 질의만 다른 주소는
 * 「질의만 다른 주소 k회」로 따로 보인다.
 */

/** 키 규칙 버전. 규칙을 바꾸면 올리고, 서버는 저장된 기록을 읽을 때 key를 다시 계산한다. */
export const KEY_RULE = 3

/**
 * 인용 추적용 파라미터 — 같은 글인데 붙었다 안 붙었다 한다(OpenAI는 utm_source=openai를 붙인다). si는 유튜브 · 스포티파이의
 * 공유 꼬리표지만 다른 사이트에서는 뜻이 있는 값이라(실측: 지역 코드) 전역으로 떼지 않는다 — 유튜브는 v만 남긴다.
 */
const TRACKING_PARAM = /^(utm_.*|fbclid|gclid|igshid|igsh)$/i

/**
 * 질의가 글을 가리키지 않는 플랫폼 — 질의를 모두 뗀다. 티스토리는 카테고리 목록에서 연 글에 ?category=가, 인스타그램은 「링크 복사」에
 * ?igsh= · ?hl=가 붙는다(실측: 그대로 적으면 인용 8,311건 중 0건이 맞았다).
 */
const QUERYLESS_HOST = (host: string) => host === 'blog.naver.com' || host.endsWith('.tistory.com') || host === 'instagram.com'

/** 유튜브 영상 id — youtu.be · /shorts/ · /embed/ · /live/ · watch?v= 모두 같은 영상이다. id는 대소문자를 가린다. */
function youtubeId(host: string, u: URL, path: string): string | null {
  if (host === 'youtu.be') return path.split('/').filter(Boolean)[0] ?? null
  if (host !== 'youtube.com') return null
  if (path === '/watch') return u.searchParams.get('v')
  const m = /^\/(shorts|embed|live|v)\/([^/]+)$/.exec(path)
  return m ? m[2]! : null
}

/** 인스타그램 게시물 — /p/ · /reel/ · /reels/ · /tv/ 와 /<계정>/p/<코드> 는 같은 게시물이다. 코드는 대소문자를 가린다. */
function instagramCode(host: string, path: string): string | null {
  if (host !== 'instagram.com') return null
  const m = /^(?:\/[^/]+)?\/(p|reels?|tv)\/([^/]+)$/.exec(path)
  return m ? m[2]! : null
}

/** 유튜브 · 인스타그램에서 영상 · 게시물이 아닌 첫 단계 경로(채널 · 프로필 홈으로 보지 않는다). */
const YOUTUBE_RESERVED = new Set(['watch', 'shorts', 'embed', 'live', 'v', 'playlist', 'results', 'hashtag', 'feed', 'premium'])
const INSTAGRAM_RESERVED = new Set(['p', 'reel', 'reels', 'tv', 'explore', 'stories', 'accounts'])

/** 단축 주소 — 인용에는 원래 주소로 나오므로 그대로 적으면 맞출 수 없다. */
const SHORT_HOSTS = new Set(['naver.me', 'bit.ly', 't.co', 'goo.gl', 'tinyurl.com', 'han.gl', 'me2.do', 'vo.la', 'url.kr', 'buly.kr', 'is.gd'])

function parse(raw: string): URL | null {
  try {
    const u = new URL(raw.trim())
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null
  } catch {
    // URL로 읽히지 않는 값 — 호출부가 「주소가 아님」으로 처리한다.
    return null
  }
}

function decodePath(path: string): string {
  try {
    return decodeURI(path)
  } catch {
    // 잘못 인코딩된 경로 — 원문 그대로 비교한다.
    return path
  }
}

/** 호스트 표기 — 소문자, 앞의 www. · m.를 뗀다(모바일 주소와 PC 주소는 같은 글이다). */
function hostOf(u: URL): string {
  return u.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '')
}

/**
 * 비교용 키. http(s)가 아니거나 주소가 아니면 null.
 *   - 호스트 소문자, www. · m. 떼기, 해시 떼기, 경로 끝 슬래시 떼기, 경로의 퍼센트 인코딩 풀기
 *   - 추적 파라미터(utm_* · fbclid · gclid · igshid · igsh) 제거, 남은 질의는 키 순으로
 *   - 네이버 블로그: PostView · GoPost · PostList.naver|nhn?blogId=&logNo= 와 /blogId?logNo= → /blogId/logNo
 *   - 네이버 블로그 · 티스토리 · 인스타그램: 질의를 모두 뗀다(글을 가리키지 않는다)
 *   - 티스토리: /m/… → /… (숫자 주소와 /entry/글제목 모두)
 *   - 유튜브: youtube.com/watch?v=<id> 하나로, 인스타그램: instagram.com/p/<코드> 하나로(id · 코드는 대소문자를 그대로 둔다)
 *   - 나머지는 전체를 소문자로
 */
export function trackingKey(raw: string): string | null {
  const u = parse(raw)
  if (!u) return null
  const host = hostOf(u)
  let path = decodePath(u.pathname).replace(/\/+$/, '')
  const video = youtubeId(host, u, path)
  if (video) return `youtube.com/watch?v=${video}`
  const post = instagramCode(host, path)
  if (post) return `instagram.com/p/${post}`
  let params = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAM.test(k))
  if (host === 'blog.naver.com') {
    const blogId = u.searchParams.get('blogId')
    const logNo = u.searchParams.get('logNo')
    const segments = path.split('/').filter(Boolean)
    // 한 단계 경로가 끝점 파일(PostView.naver · GoPost.naver · PostList.nhn …)이면 아이디는 blogId에 있다. 아니면 그 경로가 아이디다.
    const endpoint = segments.length === 1 && /\.(naver|nhn)$/i.test(segments[0]!)
    if (endpoint && blogId && logNo) path = `/${blogId}/${logNo}`
    else if (segments.length === 1 && !endpoint && logNo) path = `/${segments[0]}/${logNo}`
  }
  if (QUERYLESS_HOST(host)) params = []
  if (host.endsWith('.tistory.com')) path = path.replace(/^\/m(?=\/)/, '')
  params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const query = params.length ? `?${params.map(([k, v]) => `${k}=${v}`).join('&')}` : ''
  return `${host}${path}${query}`.toLowerCase()
}

export type ArticleUrlReason = 'not-http' | 'homepage' | 'blog-home' | 'short-link'

export const ARTICLE_URL_REASON: Record<ArticleUrlReason, string> = {
  'not-http': 'http(s)로 시작하는 주소가 아닙니다.',
  homepage: '사이트 첫 화면 주소입니다. 올린 글 한 편의 주소를 적어 주세요.',
  'blog-home': '블로그 홈 주소입니다. 올린 글 한 편의 주소를 적어 주세요.',
  'short-link': '단축 주소입니다. AI 답변에는 원래 주소로 인용되므로, 글을 열어 주소창의 주소를 적어 주세요.',
}

/**
 * 글 한 편의 주소인지. 첫 화면 · 블로그 홈 · 단축 주소는 받지 않는다 — 정확 일치로는 거의 잡히지 않고, 잡혀도 그 글의 효과가
 * 아니다(사이트 전체의 인용이다).
 */
export function isArticleUrl(raw: string): { ok: true } | { ok: false; reason: ArticleUrlReason } {
  const u = parse(raw)
  if (!u) return { ok: false, reason: 'not-http' }
  const host = hostOf(u)
  if (SHORT_HOSTS.has(host)) return { ok: false, reason: 'short-link' }
  const key = trackingKey(raw) ?? ''
  // 키의 호스트는 원래 호스트와 다를 수 있다(youtu.be → youtube.com). 첫 / · ? 앞까지가 호스트다.
  const cut = key.search(/[/?]/)
  const rest = cut < 0 ? '' : key.slice(cut)
  if (rest === '') return { ok: false, reason: 'homepage' }
  const segments = rest.split('?')[0]!.split('/').filter(Boolean)
  const single = segments.length === 1 && !rest.includes('?')
  if (single && host === 'blog.naver.com') return { ok: false, reason: 'blog-home' }
  if (single && segments[0]!.startsWith('@') && ['brunch.co.kr', 'velog.io', 'medium.com'].includes(host)) {
    return { ok: false, reason: 'blog-home' }
  }
  // 유튜브 채널(/@x · /@x/videos · /channel/<id> · /c/x · /user/x · 옛 /이름)과 인스타그램 프로필(/<계정>)은 영상 · 게시물이 아니다.
  if (host === 'youtube.com' && !key.startsWith('youtube.com/watch?v=')) {
    const first = segments[0] ?? ''
    if (first.startsWith('@') || ['channel', 'c', 'user'].includes(first) || (segments.length === 1 && !YOUTUBE_RESERVED.has(first))) {
      return { ok: false, reason: 'blog-home' }
    }
  }
  if (host === 'instagram.com' && !key.startsWith('instagram.com/p/') && segments.length === 1 && !INSTAGRAM_RESERVED.has(segments[0]!)) {
    return { ok: false, reason: 'blog-home' }
  }
  return { ok: true }
}

/**
 * 올린 글 키와 인용 키의 관계.
 *   exact          같은 글
 *   query-variant  올린 주소에 질의가 없고(경로가 한 단계 이상) 인용 주소가 거기에 `?…`만 붙은 것 — 같은 글일 수도, 다른 글일
 *                  수도 있다(게시판 idx · category).
 *   null           다른 글. `/1` 아래의 `/1/comments`나 `/12`는 다른 글이다.
 *
 * 반대 방향(올린 쪽에만 질의)은 보지 않는다. 질의로 글을 가리키는 게시판 글(…?idx=47)을 적으면, 질의 없는 목록 · 첫 화면 인용
 * 하나가 그 게시판 글 전부에 같은 숫자로 붙었다(검토 실측: 힌트가 약 3배, 그 쌍의 82%가 실제로는 다른 페이지). 플랫폼의 쓸모없는
 * 질의(티스토리 ?category= 등)는 키에서 이미 뗀다.
 */
export function matchKind(postKey: string, citedKey: string): 'exact' | 'query-variant' | null {
  if (postKey === citedKey) return 'exact'
  if (!postKey.includes('?') && postKey.includes('/') && citedKey.startsWith(`${postKey}?`)) return 'query-variant'
  return null
}

/** 응답 단위 집계 — 한 응답 안에서 같은 글이 여러 번 인용돼도 한 번이다. */
export interface CitationTally {
  /** 이 글을 인용한 응답 수. */
  cited: number
  /** 그중 그 인용이 우리 언급을 뒷받침한 응답 수(supportsBrandMention). */
  supporting: number
  /** 그중 답변에 우리 이름이 나온 응답 수 — 보조 숫자. */
  mentioned: number
}

export interface WeekTally {
  all: CitationTally
  /** 브랜드 이름 없는 질문(containsBrandName=false). 질문 은행을 못 읽었으면 null — 0이 아니라 확인 불가다. */
  unnamed: CitationTally | null
  named: CitationTally | null
  /** 은행에 없는 질문의 응답. 은행을 못 읽었으면 all과 같다. */
  unknown: CitationTally
  /** 이 키로 묶인 원래 주소 몇 개(3개까지) — 무엇이 맞았는지 보여 줄 근거. */
  forms: string[]
}

interface CitationLike {
  raw: string
  supportsBrandMention: boolean
}
interface AnalysisLike {
  questionId: string
  engine: string
  callIndex: number
  mentioned: boolean
  citations?: CitationLike[]
}

const emptyTally = (): CitationTally => ({ cited: 0, supporting: 0, mentioned: 0 })

/**
 * 한 주 판정의 인용을 키별로 센다. namedById는 질문 id → containsBrandName — 그 주를 측정한 은행에서 만든다. null이면
 * 은행을 못 읽은 것이라 이름 없는/이름 댄 질문을 나누지 않는다.
 */
export function indexWeekCitations(analyses: AnalysisLike[], namedById: Map<string, boolean> | null): Map<string, WeekTally> {
  const out = new Map<string, WeekTally>()
  const seen = new Set<string>()
  for (const a of analyses) {
    const response = `${a.questionId}|${a.engine}|${a.callIndex}`
    const byKey = new Map<string, { supporting: boolean; raw: string }>()
    for (const c of a.citations ?? []) {
      const key = c.raw ? trackingKey(c.raw) : null
      if (!key) continue
      const prev = byKey.get(key)
      byKey.set(key, { supporting: Boolean(prev?.supporting) || c.supportsBrandMention, raw: prev?.raw ?? c.raw })
    }
    for (const [key, hit] of byKey) {
      // 같은 응답이 두 번 들어온 파일(재판정 덧붙임)도 한 번만 센다.
      if (seen.has(`${response}|${key}`)) continue
      seen.add(`${response}|${key}`)
      const row = out.get(key) ?? {
        all: emptyTally(),
        unnamed: namedById ? emptyTally() : null,
        named: namedById ? emptyTally() : null,
        unknown: emptyTally(),
        forms: [],
      }
      const named = namedById?.get(a.questionId)
      const buckets = [row.all, named === undefined ? row.unknown : named ? row.named! : row.unnamed!]
      // 이름 없는 질문의 「뒷받침」은 그 답에 우리 이름이 나왔을 때만 센다 — 실행 항목 카드 · 인용 출처 집계와 같은 기준(맘맘 오분류).
      const supports = hit.supporting && (a.mentioned || named !== false)
      for (const t of buckets) {
        t.cited += 1
        if (supports) t.supporting += 1
        if (a.mentioned) t.mentioned += 1
      }
      if (row.forms.length < 3 && !row.forms.includes(hit.raw)) row.forms.push(hit.raw)
      out.set(key, row)
    }
  }
  return out
}

/** ISO 시각 → 한국 날짜(YYYY-MM-DD). */
export function kstDate(iso: string): string | null {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : new Date(t + 9 * 3600_000).toISOString().slice(0, 10)
}

/** 오늘 한국 날짜. */
export function todayKst(now = Date.now()): string {
  return new Date(now + 9 * 3600_000).toISOString().slice(0, 10)
}

/** 측정한 날의 범위(한국 날짜) — 판정 시작 시각의 처음과 끝. 시각이 없는 옛 기록이면 null. */
export function measuredWindow(analyses: { questionId: string; timing?: { startedAt?: string } }[]): { first: string; last: string } | null {
  let first: string | null = null
  let last: string | null = null
  for (const a of analyses) {
    const day = a.timing?.startedAt ? kstDate(a.timing.startedAt) : null
    if (!day) continue
    if (!first || day < first) first = day
    if (!last || day > last) last = day
  }
  return first && last ? { first, last } : null
}

/** 날짜(YYYY-MM-DD)의 ISO 주차("2026-W42"). */
export function isoWeekOf(date: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return null
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/**
 * 그 주 측정이 올린 날에 견줘 언제였나.
 *   after      올린 뒤에 측정했다 — 인용을 센다
 *   before     올리기 전에 측정했다 — 그 주 인용은 이 글의 효과가 아니다
 *   during     측정하던 날 올렸다 — 전후를 알 수 없다
 *   ambiguous  측정 시각이 없는 옛 기록인데 같은 주에 올렸다 — 전후를 알 수 없다
 *   unknown    올린 날을 모른다(주소만 남은 옛 기록)
 */
export type PostTiming = 'after' | 'before' | 'during' | 'ambiguous' | 'unknown'

export function timingOf(publishedOn: string | null, window: { first: string; last: string } | null, weekOf: string): PostTiming {
  if (!publishedOn) return 'unknown'
  if (window) {
    if (publishedOn < window.first) return 'after'
    if (publishedOn > window.last) return 'before'
    return 'during'
  }
  const week = isoWeekOf(publishedOn)
  if (!week) return 'unknown'
  if (week < weekOf) return 'after'
  if (week > weekOf) return 'before'
  return 'ambiguous'
}
