/**
 * 자사 주소 칸의 한 줄 — 사이트 주소(호스트, 하위 도메인 포함) 또는 블로그 플랫폼의 「주소/블로그 아이디」.
 *
 * 왜: 군산각 네이버 블로그(blog.naver.com/gunsangak)를 자사 주소로 넣으려면 호스트만으로는 안 된다 — blog.naver.com 전체를 자사로 보면
 * 남의 블로그 글까지 자사 인용으로 잡힌다(2026-11-25). 그래서 네이버 블로그만 아이디까지 적은 줄을 받고, 주소를 맞출 때는 그 아이디의
 * 글만 자사로 본다. 호스트만 쓰는 곳(사진 출처 · 화면 프로필 등)은 hostOnlyOwned로 이 줄을 빼고 본다.
 */

/** 아이디까지 적어야 하는 블로그 플랫폼 — 정규화한 줄의 호스트와, 같은 블로그로 볼 호스트. */
const BLOG_HOSTS: Record<string, readonly string[]> = {
  'blog.naver.com': ['blog.naver.com', 'm.blog.naver.com'],
}
const BLOG_ALIAS: Record<string, string> = { 'm.blog.naver.com': 'blog.naver.com' }
const BLOG_ID_RE = /^[a-z0-9_-]+$/
/** 블로그 아이디가 아닌 첫 경로(네이버 블로그의 글 보기 · 목록 화면). */
const NOT_BLOG_ID = new Set(['postview.naver', 'postlist.naver', 'prologue', 'mylog', 'blogid'])

export interface OwnedEntry {
  host: string
  /** 블로그 플랫폼 줄이면 그 아이디(소문자), 사이트 주소 줄이면 null. */
  blogId: string | null
}

function parseLoose(raw: string): URL | null {
  const s = raw.trim()
  if (!s) return null
  try {
    return new URL(/^https?:\/\//i.test(s) ? s : `http://${s}`)
  } catch {
    // 주소로 읽히지 않는 값.
    return null
  }
}

const cleanHost = (h: string) => h.toLowerCase().replace(/^www\./, '').replace(/\.+$/, '')

/** 블로그 플랫폼 주소에서 아이디 — 첫 경로 또는 blogId 질의. 없으면 null. */
function blogIdOf(u: URL): string | null {
  const q = u.searchParams.get('blogId')?.toLowerCase() ?? null
  if (q && BLOG_ID_RE.test(q)) return q
  let first: string
  try {
    first = decodeURIComponent(u.pathname.split('/').filter(Boolean)[0] ?? '').toLowerCase()
  } catch {
    // 깨진 퍼센트 표기 — 아이디로 보지 않는다.
    return null
  }
  return first && BLOG_ID_RE.test(first) && !NOT_BLOG_ID.has(first) ? first : null
}

/** 아이디까지 적어야 하는 블로그 플랫폼 호스트인가(blog.naver.com · m.blog.naver.com). */
export function isBlogPathHost(host: string): boolean {
  const h = cleanHost(host)
  return h in BLOG_HOSTS || h in BLOG_ALIAS
}

/** 자사 주소 칸 한 줄을 읽는다. 블로그 플랫폼인데 아이디가 없으면 blogId null(호스트 줄로 남는다 — 편집기가 막는다). */
export function parseOwnedEntry(raw: string): OwnedEntry | null {
  const u = parseLoose(raw)
  if (!u) return null
  const host = cleanHost(u.hostname)
  if (!host) return null
  if (isBlogPathHost(host)) {
    const base = BLOG_ALIAS[host] ?? host
    return { host: base, blogId: blogIdOf(u) }
  }
  return { host, blogId: null }
}

/** 저장 · 비교에 쓰는 한 줄 표기 — 「site.example」 또는 「blog.naver.com/아이디」. 읽을 수 없으면 ''. */
export function ownedEntryKey(raw: string): string {
  const e = parseOwnedEntry(raw)
  if (!e) return ''
  return e.blogId ? `${e.host}/${e.blogId}` : e.host
}

/** 블로그 아이디까지 적은 줄인가. */
export function isBlogEntry(raw: string): boolean {
  return parseOwnedEntry(raw)?.blogId != null
}

const under = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`)

/** 주소(URL)가 이 자사 주소 줄에 드는가 — 사이트 줄은 그 호스트 · 하위 도메인, 블로그 줄은 같은 블로그 아이디의 글만. */
export function urlMatchesOwnedEntry(url: string, raw: string): boolean {
  const entry = parseOwnedEntry(raw)
  if (!entry) return false
  let u: URL
  try {
    u = new URL(url.trim())
  } catch {
    // 주소가 아니다.
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const host = cleanHost(u.hostname)
  if (entry.blogId) return (BLOG_HOSTS[entry.host] ?? []).includes(host) && blogIdOf(u) === entry.blogId
  // 아이디 없는 블로그 플랫폼 줄은 아무 주소도 자사로 보지 않는다 — 남의 블로그까지 잡히는 것보다 안 잡히는 쪽으로 실패한다.
  if (isBlogPathHost(entry.host)) return false
  return under(host, entry.host)
}

/** 주소가 자사 주소 목록의 어느 줄에 드는가. */
export function urlOwnedBy(url: string, owned: readonly string[]): boolean {
  return owned.some((d) => urlMatchesOwnedEntry(url, d))
}

/**
 * 판정을 고정할 때 쓰는 맞춤 — 자사 주소에 들되, 다른 곳(다른 브랜드 · 경쟁사)이 자사 주소 아래 더 구체적인 주소를 가졌으면 그 주소는 뺀다.
 * 에이아이오투오(o2osolution.ai) 아래 스테이,머뭄 페이지(web4ai.o2osolution.ai)가 있어, 호스트만 보면 에이아이오투오 측정에서 남의 페이지가 자사가 된다.
 */
export function ownedUrlMatcher(owned: readonly string[], others: readonly string[]): (url: string) => boolean {
  const own = owned.map(ownedEntryKey).filter(Boolean)
  const nested = others
    .map(ownedEntryKey)
    .filter((o) => o && !own.includes(o))
    .filter((o) => {
      const e = parseOwnedEntry(o)!
      const sample = e.blogId ? `https://${e.host}/${e.blogId}` : `https://${e.host}/`
      return urlOwnedBy(sample, own)
    })
  return (url) => urlOwnedBy(url, own) && !urlOwnedBy(url, nested)
}

/** 호스트로만 비교하는 곳에 넘길 목록 — 블로그 플랫폼 줄(아이디 유무와 관계없이)을 뺀다. */
export function hostOnlyOwned(owned: readonly string[]): string[] {
  return owned.filter((d) => {
    const e = parseOwnedEntry(d)
    return e !== null && !isBlogPathHost(e.host)
  })
}
