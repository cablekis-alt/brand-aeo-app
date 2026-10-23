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

export type ArticleUrlReason = 'not-http' | 'homepage' | 'blog-home' | 'short-link' | 'editor'

export const ARTICLE_URL_REASON: Record<ArticleUrlReason, string> = {
  'not-http': 'http(s)로 시작하는 주소가 아닙니다.',
  homepage: '사이트 첫 화면 주소입니다. 올린 글 한 편의 주소를 적어 주세요.',
  'blog-home': '블로그 홈 주소입니다. 올린 글 한 편의 주소를 적어 주세요.',
  'short-link': '단축 주소입니다. AI 답변에는 원래 주소로 인용되므로, 글을 열어 주소창의 주소를 적어 주세요.',
  editor: '글쓰기 · 고치기 · 관리 화면 주소입니다. 글을 올린 뒤 공개된 글을 열어 주소창의 주소를 적어 주세요.',
}

/** 글쓰기 · 관리 화면만 있는 호스트(www. · m.을 뗀 뒤). */
const EDITOR_HOSTS = new Set(['admin.blog.naver.com', 'studio.youtube.com', 'blogger.com', 'draft.blogger.com'])

/**
 * 글쓰기 · 고치기 · 관리 화면 주소인지 — 글을 올리는 중에 주소창에 뜨는 주소다. 공개된 글이 아니라 AI 답변에 인용될 일이 없다
 * (2026-10-21 티스토리 /manage/newpost가 올린 글로 적혔다). 같은 글을 고쳐 다시 올릴 때 뜨는 고치기 화면 주소도 막는다.
 */
function isEditorPage(u: URL): boolean {
  const host = hostOf(u)
  if (EDITOR_HOSTS.has(host)) return true
  const segments = decodePath(u.pathname).toLowerCase().split('/').filter(Boolean)
  if (segments.some((s) => s === 'wp-admin' || s === 'wp-login.php')) return true
  if (host.endsWith('.tistory.com')) {
    const first = segments[0] === 'm' ? segments[1] : segments[0]
    return first === 'manage' || first === 'admin' || first === 'owner'
  }
  if (host === 'blog.naver.com') {
    const redirect = (u.searchParams.get('Redirect') ?? '').toLowerCase()
    return (
      /^post(write|update)form\.(naver|nhn)$/.test(segments[0] ?? '') ||
      segments[1] === 'postwrite' ||
      segments[1] === 'postupdate' ||
      redirect === 'write' ||
      redirect === 'update'
    )
  }
  if (host === 'cafe.naver.com') {
    // 글쓰기는 …/articles/write, 고치기는 …/articles/<글번호>/modify다.
    return (
      /^article(write|modify)\.(naver|nhn)$/.test(segments[0] ?? '') ||
      segments.some((s, i) => s === 'articles' && (segments[i + 1] === 'write' || (/^\d+$/.test(segments[i + 1] ?? '') && segments[i + 2] === 'modify')))
    )
  }
  if (host === 'brunch.co.kr' || host === 'velog.io') return segments[0] === 'write'
  if (host === 'medium.com') return segments[0] === 'new-story' || (segments[0] === 'p' && segments[2] === 'edit')
  return false
}

/**
 * 글 한 편의 주소인지. 첫 화면 · 블로그 홈 · 단축 주소는 받지 않는다 — 정확 일치로는 거의 잡히지 않고, 잡혀도 그 글의 효과가
 * 아니다(사이트 전체의 인용이다). 글쓰기 · 관리 화면 주소도 받지 않는다(isEditorPage).
 */
export function isArticleUrl(raw: string): { ok: true } | { ok: false; reason: ArticleUrlReason } {
  const u = parse(raw)
  if (!u) return { ok: false, reason: 'not-http' }
  const host = hostOf(u)
  if (SHORT_HOSTS.has(host)) return { ok: false, reason: 'short-link' }
  if (isEditorPage(u)) return { ok: false, reason: 'editor' }
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

/**
 * 측정한 때 — 날짜(한국)의 범위와, 같은 날 올린 글의 전후를 시각으로 가를 때 쓰는 시각.
 *   endAt    답을 모은 시각의 상한(판정 시작의 마지막 — 판정은 답을 모은 뒤에 한다). 이보다 뒤에 올렸으면 「올리기 전」 측정이다.
 *   startAt  답을 모은 시각의 하한(회차의 측정 시작). 이보다 앞에 올렸으면 「올린 뒤」 측정이다. 판정 시각으로는 하한을 알 수 없어
 *            회차 기록(RunMeta.startedAt)이 있을 때만 있다(server/publishedHistory.ts).
 */
export interface MeasureWindow {
  first: string
  last: string
  startAt?: string
  endAt?: string
}

/** 측정한 날의 범위(한국 날짜) — 판정 시작 시각의 처음과 끝. 시각이 없는 옛 기록이면 null. */
export function measuredWindow(analyses: { questionId: string; timing?: { startedAt?: string } }[]): MeasureWindow | null {
  let first: string | null = null
  let last: string | null = null
  let endAt: string | null = null
  for (const a of analyses) {
    const at = a.timing?.startedAt
    const day = at ? kstDate(at) : null
    if (!at || !day) continue
    if (!first || day < first) first = day
    if (!last || day > last) last = day
    if (!endAt || Date.parse(at) > Date.parse(endAt)) endAt = at
  }
  return first && last ? { first, last, ...(endAt ? { endAt } : {}) } : null
}

/**
 * 같은 날 측정을 시각으로 가를 때 쓰는 올린 시각 — 올린 날이 「올렸어요」를 누른 날과 같은 기록만, 누른 시각을 쓴다(날짜를 기본값
 * 그대로 뒀든 오늘로 골랐든 같다 — 실측 10-23 /4는 날짜 칸을 열고 오늘을 골랐다). 올린 시각은 누른 시각보다 늦을 수 없어 「이보다 뒤에
 * 시작한 측정은 올린 뒤」는 늘 맞다. 「이보다 앞에 끝난 측정은 올리기 전」은 올린 직후에 눌렀다는 전제다(화면이 그렇게 안내한다).
 * 다른 날을 고른 기록 · 날짜를 모르는 옛 기록은 null — 날짜로만 가린다.
 */
export function postedAtOf(post: { publishedOn: string | null; publishedOnSource: string; recordedAt: string }): string | null {
  return post.publishedOnSource !== 'legacy' && post.publishedOn && kstDate(post.recordedAt) === post.publishedOn ? post.recordedAt : null
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

/** "2026-W43" → 그 주 월요일 "2026-10-19". 꼴이 아니면 null. */
function isoWeekMonday(weekOf: string): string | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(weekOf)
  if (!m) return null
  // 1월 4일이 든 주가 1주다.
  const jan4 = new Date(Date.UTC(Number(m[1]), 0, 4))
  const monday = new Date(jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * 86_400_000 + (Number(m[2]) - 1) * 7 * 86_400_000)
  return monday.toISOString().slice(0, 10)
}

/**
 * 올린 뒤(after) 측정이 올린 날에서 며칠 뒤였나 — 측정 시각이 있으면 그 주 첫 측정일, 없으면 그 주 월요일부터 센다(짧게 잡아
 * 「인용 없음」을 늦게 붙인다). after가 아니면 null. 갓 올린 글은 색인 · 인용까지 열흘 넘게 걸린다 — 이 일수로 판단을 미룬다
 * (src/lib/publishTracking.ts INDEXING_GRACE_DAYS).
 */
export function daysAfterPublish(publishedOn: string | null, window: MeasureWindow | null, weekOf: string, postedAt: string | null = null): number | null {
  if (!publishedOn || timingOf(publishedOn, window, weekOf, postedAt) !== 'after') return null
  const from = window?.first ?? isoWeekMonday(weekOf)
  if (!from) return null
  const days = Math.round((Date.parse(`${from}T00:00:00Z`) - Date.parse(`${publishedOn}T00:00:00Z`)) / 86_400_000)
  return Number.isFinite(days) ? Math.max(0, days) : null
}

/**
 * 고친 글(server/publishedPosts.ts PostEdit)의 측정 하나 — 고친 날 가운데 그 측정 전 · 측정 중에 있었던 가장 늦은 날과 그 전후.
 * timingAt은 올린 날과 같은 규칙(timingOf · weekTimingOf)으로 잰다: after = 고친 뒤 측정, during · ambiguous = 고친 날 측정(전후
 * 불명). 고친 날이 모두 측정 뒤면 null — 그 측정은 고치기 전 글을 본 것이다. 측정 시점을 모르면(unknown) null.
 */
export function editTimingOf(
  edits: { editedOn: string }[] | undefined,
  timingAt: (date: string) => PostTiming,
): { editedOn: string; timing: PostTiming } | null {
  if (!edits?.length) return null
  for (const e of [...edits].sort((a, b) => b.editedOn.localeCompare(a.editedOn))) {
    const t = timingAt(e.editedOn)
    if (t === 'before') continue
    if (t === 'unknown') return null
    return { editedOn: e.editedOn, timing: t }
  }
  return null
}

/**
 * 올린 날(고친 날)에 견준 측정 하나. 날짜로 가리고, 측정하던 날 올렸으면(during) 올린 시각(postedAtOf)과 측정 시각(MeasureWindow)을
 * 견준다 — 측정 시작보다 앞에 올렸으면 after, 답을 다 모은 뒤에 올렸으면 before, 그 사이면 during(전후 불명) 그대로.
 */
export function timingOf(publishedOn: string | null, window: MeasureWindow | null, weekOf: string, postedAt: string | null = null): PostTiming {
  if (!publishedOn) return 'unknown'
  if (window) {
    if (publishedOn < window.first) return 'after'
    if (publishedOn > window.last) return 'before'
    const at = postedAt ? Date.parse(postedAt) : Number.NaN
    if (!Number.isNaN(at)) {
      if (window.startAt && at < Date.parse(window.startAt)) return 'after'
      if (window.endAt && at > Date.parse(window.endAt)) return 'before'
    }
    return 'during'
  }
  const week = isoWeekOf(publishedOn)
  if (!week) return 'unknown'
  if (week < weekOf) return 'after'
  if (week > weekOf) return 'before'
  return 'ambiguous'
}
