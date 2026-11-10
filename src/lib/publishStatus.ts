/**
 * 발행 현황 — 고객 브랜드 전체의 올린 글을 한 표로 본다(화면: src/pages/PublishStatus.tsx, 서버: server/publishStatus.ts ·
 * server/indexChecks.ts). 작성자 8명이 브랜드마다 10편씩 올리므로, 누가 몇 편을 올렸는지와 올린 글이 네이버 · 구글에 나오는지를 브랜드마다
 * 화면을 옮겨 다니며 볼 수 없었다.
 *
 * ── 한 줄 = 한 주소 ───────────────────────────────────────────────────────
 * 원장(server/publishedPosts.ts)은 「주소 한 줄 = 기록 한 줄」이라 같은 글을 자사 줄과 채널 줄에 함께 적으면 두 줄이다. 먼저 같은 주소 ·
 * 같은 올린 날의 줄을 올린 일 한 번으로 묶고(성과 표 src/lib/publishTracking.ts distinctPostings와 같은 묶음 — 내림 · 다시 올림을 가린다),
 * 그 가운데 살아 있는 것은 주소 하나로 다시 묶는다. 네이버 노출 · 구글 색인은 주소의 상태라, 올린 날만 다르게 두 번 적은 주소(자사 줄
 * 10/30 · 채널 줄 11/02 「오늘」)를 두 줄로 두면 표시가 줄마다 갈라지고 요약이 두 번 센다(검토 실측 web4ai). 발행일은 가장 이른 날이다.
 * 「뺀 글 보기」를 켜면 내린 글 · 잘못 적은 주소도 흐리게 보인다.
 *
 * ── 색인 확인은 본 것만 ─────────────────────────────────────────────────────
 * 네이버는 사람이 검색해 보고 「노출됨」 · 「아직」을 누른다. 구글은 사람이 누르거나, 「구글 자동 확인」(src/lib/indexAuto.ts ·
 * server/indexAuto.ts — SerpAPI site: 검색, 2026-11-10)이 14일째 차례에 대신 보고 적는다. 누르지 않은 글은 「미확인」이다 — 「아직」으로
 * 채우지 않는다(자동으로 가리지 못한 글도 적지 않는다). 기록은 원장과 따로 data/<tenant>/index-checks.json에 두고(원장 모양은 바꾸지 않는다),
 * 기록마다 출처(manual 직접 · auto 자동)를 남긴다 — 칸 · CSV가 「자동」을 따로 보인다.
 *
 * 한 주소의 상태는 기록 하나다 — 그 주소의 기록(줄 id · 주소 키, 다른 고객 브랜드 포함 — 범위 변형 두 브랜드에 같은 글을 적는다) 가운데
 * 가장 나중에 고친 것. 적을 때 늘 그 기록을 이어받아 새 기록이 가장 나중이 된다(findIndexRecord). 올린 날보다 앞선 확인은 그 올림의
 * 확인이 아니다 — 내린 뒤 같은 주소로 다시 올린 글은 미확인부터 다시 본다(freshIndexRecord).
 *
 * ── 다시 볼 날 ────────────────────────────────────────────────────────────
 * 올린 뒤 3 · 7 · 14일째에 다시 본다. 그날이 지났는데 그날 이후에 본 기록이 없고 노출 · 색인도 아니면 「오늘 다시 볼 글」이다. 14일째에 보고도
 * 아직이면 「14일 지남」으로 둔다.
 *
 * ── 앱 밖 글 줄(2026-11-10) ──────────────────────────────────────────────────
 * 앱에서 만들지 않은 글(손글 — src/lib/externalPosts.ts · data/<tenant>/external-posts.json)도 한 줄로 보인다(origin 'external'). 원장과 따로
 * 읽어 넘기므로 작성자 진행(배정 글 · 원장 줄만 센다)은 그대로다. 작성자 칸은 「앱 밖 글」 — 배정 파일을 못 읽어도 「미확인」이 아니다(C12).
 * 다시 볼 날은 올린 날과 추적을 시작한 날 가운데 늦은 날부터 센다(recheckFrom — 오래된 손글이 등록하자마자 「14일 지남」으로 쏟아지지 않게,
 * D4. 올린 날을 모르면 추적을 시작한 날부터). 같은 브랜드에 앱 글로 옮긴 줄은 「앱 글로 옮김」으로 쉰다(뺀 글처럼 — D12). 색인 표시는 주소의
 * 상태라 같은 주소 키의 앱 글 줄과 서로 이어받는다(C15). 요약은 같은 주소가 어느 브랜드에서든 앱 글이면 앱 글로 센다(앱 글 a + 앱 밖 b =
 * 올린 글).
 *
 * 서버가 import하므로 상대 import는 .js로 쓰고, 화면 모듈은 끌어오지 않는다.
 */
import { externalIndexBasis, externalRegistrationCheck, type ExternalPostView, type TakedownRowLike } from './externalPosts.js'
import { kstDate, todayKst, TRACKING_PARAM, trackingKey } from './publishedUrl.js'
import { planWriters, writerArticle, type PlanWriter, type WriterPlan, type WriterPlanArticle } from './probePlan.js'

export const INDEX_CHECKS_FORMAT = 'index-checks/1'
export const INDEX_ENGINES = ['naver', 'google'] as const
export type IndexEngine = (typeof INDEX_ENGINES)[number]
export const INDEX_STATES = ['shown', 'not-yet'] as const
export type IndexState = (typeof INDEX_STATES)[number]
/** manual — 사람이 검색해 보고 눌렀다. auto — 색인 자동 확인(구글 — SerpAPI site: 검색, src/lib/indexAuto.ts). */
export type IndexSource = 'manual' | 'auto'

export const ENGINE_NAME: Record<IndexEngine, string> = { naver: '네이버', google: '구글' }
/** 「나온다」의 엔진별 이름 — 네이버는 노출, 구글은 색인. */
export const SHOWN_WORD: Record<IndexEngine, string> = { naver: '노출됨', google: '색인됨' }

/** 한 엔진의 확인 한 번. */
export interface IndexCheck {
  state: IndexState
  /** 확인한 날(한국 날짜) — 다시 볼 날을 셀 때 쓴다. */
  checkedOn: string
  /** 기록한 시각(ISO). */
  checkedAt: string
  source: IndexSource
}

/** 올린 글 한 편의 확인 기록 — 엔진 칸이 없으면 미확인. */
export interface IndexCheckRecord {
  /** 원장 기록 id(표시를 누른 줄). */
  postId: string
  /** 주소 키(src/lib/publishedUrl.ts trackingKey) — 한 주소의 상태는 이 키의 가장 나중 기록이다(대표 줄 · 브랜드가 달라도). */
  key: string
  url: string
  naver?: IndexCheck
  google?: IndexCheck
  updatedAt: string
}

export interface IndexChecksFile {
  format: typeof INDEX_CHECKS_FORMAT
  /** 원장 기록 id → 기록. */
  checks: Record<string, IndexCheckRecord>
}

/** 올린 뒤 다시 볼 날(일째). */
export const RECHECK_DAYS = [3, 7, 14] as const

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'

/** 실제 있는 날짜(YYYY-MM-DD)인가. */
function isDay(v: unknown): v is string {
  if (!isStr(v) || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const t = Date.parse(`${v}T00:00:00Z`)
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v
}

/** 날짜(YYYY-MM-DD)에 n일을 더한다. */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
}

// ── 플랫폼 ───────────────────────────────────────────────────────────────────

export type PlatformKey = 'naver-blog' | 'tistory' | 'brunch' | 'velog' | 'medium' | 'instagram' | 'youtube' | 'blogger' | 'owned' | 'other'
export interface Platform {
  key: PlatformKey
  label: string
}

const under = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`)

/** 알려진 플랫폼 — 자사 주소 목록에 있어도 플랫폼 이름을 쓴다(네이버 블로그 글은 블로그 검색으로 본다). */
const PLATFORMS: { key: Exclude<PlatformKey, 'owned' | 'other'>; label: string; test: (host: string) => boolean }[] = [
  { key: 'naver-blog', label: '네이버 블로그', test: (h) => h === 'blog.naver.com' || h === 'm.blog.naver.com' },
  { key: 'tistory', label: '티스토리', test: (h) => under(h, 'tistory.com') },
  { key: 'brunch', label: '브런치', test: (h) => under(h, 'brunch.co.kr') },
  { key: 'velog', label: '벨로그', test: (h) => under(h, 'velog.io') },
  { key: 'medium', label: '미디엄', test: (h) => under(h, 'medium.com') },
  { key: 'instagram', label: '인스타그램', test: (h) => under(h, 'instagram.com') },
  { key: 'youtube', label: '유튜브', test: (h) => under(h, 'youtube.com') || h === 'youtu.be' },
  { key: 'blogger', label: '블로거', test: (h) => under(h, 'blogspot.com') || h === 'blogger.com' },
]

/** 자사 주소 칸(「site.example」 · 「https://site.example/」 모양)의 호스트. */
const ownedHost = (raw: string) => raw.trim().toLowerCase().replace(/^https?:\/\//, '').split(/[/?#:]/)[0]!.replace(/^www\./, '').replace(/\.$/, '')

/** http(s) 주소의 호스트(소문자 · www. 뗌). 주소가 아니면 null. */
function hostOfUrl(url: string): string | null {
  try {
    const u = new URL(url.trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    // 주소로 읽히지 않는 값 — 호스트를 모른다.
    return null
  }
}

const ownedBy = (host: string, ownedDomains: readonly string[]) => ownedDomains.some((d) => ownedHost(d) && under(host, ownedHost(d)))

/** 올린 주소의 플랫폼 — 알려진 플랫폼 → 브랜드 자사 사이트(하위 도메인 포함) → 그 밖(호스트). http(s) 주소가 아니면 null. */
export function platformOf(url: string, ownedDomains: readonly string[]): Platform | null {
  const host = hostOfUrl(url)
  if (host === null) return null
  const known = PLATFORMS.find((p) => p.test(host))
  if (known) return { key: known.key, label: known.label }
  if (ownedBy(host, ownedDomains)) return { key: 'owned', label: '자사 사이트' }
  return { key: 'other', label: host }
}

/**
 * 주소가 이 브랜드의 자사 주소 칸(하위 도메인 포함)에 드는가 — 알려진 플랫폼을 먼저 보지 않는다(platformOf와 다르다: 티스토리 블로그를
 * 자사 주소로 넣은 브랜드면 그 블로그 글도 자사 주소다). 앱 밖 글을 붙일 브랜드를 미리 고를 때 쓴다(src/lib/postImport.ts ownedBrandsOf — 여럿이
 * 함께 쓰는 플랫폼 호스트는 그쪽이 뺀다). http(s) 주소가 아니면 false.
 */
export function ownedUrl(url: string, ownedDomains: readonly string[]): boolean {
  const host = hostOfUrl(url)
  return host !== null && ownedBy(host, ownedDomains)
}

// ── 한 편으로 묶기 ───────────────────────────────────────────────────────────

/** 원장 기록에서 이 화면이 쓰는 값(server/publishedPosts.ts PublishedPost · src/lib/api.ts PublishedPost 모두 이 모양을 가진다). */
export interface LedgerPostLike {
  id: string
  url: string
  key: string
  publishedOn: string | null
  recordedAt: string
  articleId: string
  articleTitle?: string
  removedAt?: string
  removedReason?: 'mistake' | 'taken-down'
  /** topic: 글의 질문 스냅샷 — 그 글을 쓴 질문지 판. 판을 모르면 bankVersion null. */
  topic?: { bankVersion: string | null }
}

export type RemovedReason = 'mistake' | 'taken-down'
/** 표의 줄이 빠진 까닭 — 원장 · 앱 밖 글의 빼기(mistake · taken-down)와, 같은 브랜드에 앱 글로 옮겨 쉬는 앱 밖 줄(moved — at은 옮긴 한국 날짜). */
export type RowRemovedReason = RemovedReason | 'moved'
/** 줄의 출처 — app 원장(앱 글), external 앱 밖 글(src/lib/externalPosts.ts). */
export type RowOrigin = 'app' | 'external'

export interface Posting<P extends LedgerPostLike = LedgerPostLike> {
  /** 대표 줄 — 살아 있는 편은 가장 이른 올린 날의 줄. */
  post: P
  /** 이 편으로 묶인 줄 id 모두(뺀 줄 포함) — 확인 기록을 대표가 아닌 줄로 적었어도 찾는다. */
  ids: string[]
  /** 이 편의 살아 있는 줄(뺀 줄 빼고) — 작성자 진행이 배정 글을 셀 때 쓴다. 뺀 편이면 빈 배열. */
  live: P[]
  /** 내렸거나(taken-down) 잘못 적은 주소만 남은(mistake) 편. 살아 있으면 null. */
  removed: { reason: RemovedReason; at: string } | null
}

/**
 * 올린 일 한 번씩 — 같은 주소 · 같은 올린 날. 같은 주소에 날짜 있는 줄이 있으면 날짜 없는 옛 줄은 뺀다. 대표: 한 줄이라도 내렸으면 가장
 * 먼저 내린 줄(그 뒤에 같은 주소를 다시 적은 줄이 있으면 다시 올린 것으로 보고 그 줄), 아니면 살아 있는 첫 줄, 다 잘못 적은 주소면 첫 줄.
 */
function publicationsOf<P extends LedgerPostLike>(posts: P[]): Posting<P>[] {
  const dated = new Set(posts.filter((p) => p.publishedOn && p.removedReason !== 'mistake').map((p) => p.key))
  const groups = new Map<string, P[]>()
  for (const p of posts) {
    if (!p.publishedOn && dated.has(p.key)) continue
    const k = `${p.key}|${p.publishedOn ?? ''}`
    groups.set(k, [...(groups.get(k) ?? []), p])
  }
  return [...groups.values()].map((group) => {
    const ids = group.map((p) => p.id)
    const live = group.filter((p) => !p.removedAt)
    const down = group
      .filter((p) => p.removedReason === 'taken-down' && p.removedAt)
      .sort((a, b) => a.removedAt!.localeCompare(b.removedAt!))[0]
    const reposted = down ? live.find((p) => p.recordedAt > down.removedAt!) : undefined
    if (down && !reposted) return { post: down, ids, live: [], removed: { reason: 'taken-down' as const, at: down.removedAt! } }
    const rep = reposted ?? live[0]
    if (rep) return { post: rep, ids, live, removed: null }
    const first = group[0]!
    return { post: first, ids, live: [], removed: { reason: 'mistake' as const, at: first.removedAt ?? '' } }
  })
}

/**
 * 원장 줄을 표의 한 줄씩으로 묶는다 — 올린 일 한 번씩(publicationsOf)으로 나눈 뒤, 살아 있는 것은 주소 하나로 합친다(대표 · 발행일은
 * 가장 이른 올린 날, 줄 id는 모두). 내린 편 · 잘못 적은 주소만 남은 편은 올린 날마다 따로 남는다(뺀 글 보기).
 */
export function postingsOf<P extends LedgerPostLike>(posts: P[]): Posting<P>[] {
  const publications = publicationsOf(posts)
  const liveByKey = new Map<string, Posting<P>[]>()
  for (const p of publications) if (!p.removed) liveByKey.set(p.post.key, [...(liveByKey.get(p.post.key) ?? []), p])
  const out: Posting<P>[] = []
  for (const p of publications) {
    if (p.removed) {
      out.push(p)
      continue
    }
    const same = liveByKey.get(p.post.key)
    if (!same) continue
    liveByKey.delete(p.post.key)
    const first = [...same].sort((a, b) => (a.post.publishedOn ?? '9999').localeCompare(b.post.publishedOn ?? '9999'))[0]!
    out.push({ post: first.post, ids: same.flatMap((s) => s.ids), live: same.flatMap((s) => s.live), removed: null })
  }
  return out
}

/** 고객 브랜드 한 곳의 확인 기록. */
export interface TenantChecks {
  tenantId: string
  checks: Record<string, IndexCheckRecord>
}

export interface FoundIndexRecord {
  record: IndexCheckRecord
  /** 기록이 있는 브랜드. */
  tenantId: string
}

/**
 * 한 편의 확인 기록 — 그 편으로 묶인 줄 id의 기록과, key를 주면 같은 주소의 기록(이 브랜드 · 다른 고객 브랜드) 가운데 가장 나중에 고친
 * 것 하나. 적을 때 늘 이 기록을 이어받으므로 가장 나중 기록이 그 주소의 지금 상태다 — 대표 줄 기록을 앞세우면 대표가 바뀌었다 돌아올 때
 * (뺀 줄을 되살림) 그 사이의 표시가 가려졌다. 뺀 편은 key 없이(null) 제 줄의 기록만 본다. 없으면 null(두 엔진 모두 미확인).
 */
export function findIndexRecord(own: TenantChecks, others: readonly TenantChecks[], ids: readonly string[], key: string | null): FoundIndexRecord | null {
  const found: FoundIndexRecord[] = []
  for (const t of [own, ...others]) {
    for (const [id, record] of Object.entries(t.checks)) {
      if ((t === own && ids.includes(id)) || (key !== null && record.key === key)) found.push({ record, tenantId: t.tenantId })
    }
  }
  return found.sort((a, b) => b.record.updatedAt.localeCompare(a.record.updatedAt))[0] ?? null
}

/**
 * 올린 날보다 앞선 확인은 뺀다 — 내린 뒤 같은 주소로 다시 올린 글이 내리기 전 「노출됨 · 색인됨」을 이어받아 한 번도 다시 보지 않고
 * 「확인 끝」이 되던 것. 표시할 때도 적을 때(이어받기)도 이 기록을 쓴다. 올린 날을 모르면 그대로.
 */
export function freshIndexRecord(record: IndexCheckRecord, publishedOn: string | null): IndexCheckRecord {
  if (!publishedOn) return record
  const next = { ...record }
  for (const engine of INDEX_ENGINES) {
    const check = next[engine]
    if (check && check.checkedOn < publishedOn) delete next[engine]
  }
  return next
}

/** 배정 글인가 — 글 id가 배정에 있고, 그 글을 쓴 판이 배정 판이어야 한다(질문 id는 판이 바뀌어도 이어진다 — GapActions writerArticleOf와 같은 규칙). 판을 모르면 'bank-unknown'. */
export function planArticleOf(plan: WriterPlan | null, post: Pick<LedgerPostLike, 'articleId' | 'topic'>): WriterPlanArticle | 'bank-unknown' | null {
  const article = writerArticle(plan, post.articleId)
  if (!article || !plan) return null
  const version = post.topic?.bankVersion
  if (!version) return 'bank-unknown'
  return version === plan.bankVersion ? article : null
}

// ── 표의 줄 ──────────────────────────────────────────────────────────────────

export interface PublishStatusRow {
  /** 화면 키 — 올린 글은 `<브랜드>|<대표 줄 id>`, 아직 안 올린 배정 글은 `<브랜드>|plan|<글 id>`. */
  rowKey: string
  tenantId: string
  /** 브랜드 이름(범위 변형이면 꼬리표까지 — src/lib/brandVariant.ts brandLabel). */
  brand: string
  kind: 'posted' | 'unposted'
  /** 원장(앱 글) · 앱 밖 글. 아직 안 올린 배정 글은 app. */
  origin: RowOrigin
  /** 확인 기록을 적는 원장 줄(대표) · 앱 밖 글 줄(x- id). 아직 안 올린 글이면 null. */
  postId: string | null
  /** 주소 키 — 같은 주소의 줄(다른 고객 브랜드 포함)은 표시 하나를 함께 쓴다. 아직 안 올린 글이면 null. */
  key: string | null
  articleId: string
  /** 그때 글 제목(없으면 배정 주제 이름). 모르면 null. */
  title: string | null
  /** 배정 작성자. 배정 밖 글이면 null. */
  writer: PlanWriter | null
  /** 작성자를 모른다(writer는 null, 「미확인」) — 배정 파일을 읽지 못했거나, 배정 글 id인데 그 글을 쓴 질문지 판을 모른다. */
  writerUnknown: WriterUnknown | null
  /** 아직 안 올린 배정 글인데, 판을 몰라 이 배정 글인지 모르는 올린 글이 있다 — 「올렸는지 미확인」. */
  postedUnknown: boolean
  platform: Platform | null
  url: string | null
  /** 올린 날(한국 날짜). 모르면 null. */
  publishedOn: string | null
  /** 다시 볼 날(3 · 7 · 14일째)을 세는 날 — 앱 글은 올린 날, 앱 밖 글은 올린 날과 추적을 시작한 날 가운데 늦은 날(모르면 추적을 시작한 날). */
  recheckFrom: string | null
  /** 앱 밖 글 — 추적을 시작한 한국 날짜. 앱 글 · 아직 안 올린 글은 null. */
  trackedOn: string | null
  removed: { reason: RowRemovedReason; at: string } | null
  naver: IndexCheck | null
  google: IndexCheck | null
  /** 보이는 확인 기록을 다른 고객 브랜드의 같은 주소 줄에서 표시했으면 그 브랜드 이름. */
  checkFrom: string | null
}

export type WriterUnknown = 'plan-unreadable' | 'bank-unknown'
export const WRITER_UNKNOWN_NOTE: Record<WriterUnknown, string> = {
  'plan-unreadable': '배정 파일(probe-plan.json)을 읽지 못해 작성자를 모릅니다',
  'bank-unknown': '배정 글과 같은 질문으로 쓴 글인데, 그 글을 쓴 질문지 판을 몰라 배정 글인지 확인하지 못했습니다',
}

/** 작성자 한 사람의 진행 — 배정 글 중 살아 있는 글이 하나라도 있는 글 수(배정 판으로 쓴 글만). */
export interface WriterSummary {
  tenantId: string
  brand: string
  key: string
  name: string
  assigned: number
  posted: number
  /** 올렸는지 미확인 — 배정 글 id로 올린 글이 있는데 그 글을 쓴 판을 모른다. */
  unsure: number
}

/** 그 브랜드만의 문제 — 파일이 깨졌다 등. 다른 브랜드는 그대로 보인다. */
export interface TenantIssue {
  tenantId: string
  brand: string
  error: string
}

export interface PublishStatus {
  /** 서버가 센 오늘(한국 날짜). */
  today: string
  /** 고객 브랜드(경쟁사 · 지운 브랜드 빼고, 설정 순) — 줄이 없는 브랜드도. 앱 밖 글을 붙일 브랜드를 고를 때 쓴다. */
  brands: { tenantId: string; brand: string }[]
  rows: PublishStatusRow[]
  writers: WriterSummary[]
  issues: TenantIssue[]
}

export interface TenantStatusInput {
  tenantId: string
  brand: string
  ownedDomains: readonly string[]
  posts: LedgerPostLike[]
  plan: WriterPlan | null
  /** 배정 파일이 있는데 읽지 못했다. */
  planUnreadable: boolean
  checks: Record<string, IndexCheckRecord>
  /** 다른 고객 브랜드의 확인 기록(브랜드 이름과 함께) — 같은 주소의 기록을 함께 본다. 없으면 이 브랜드 기록만. */
  others?: readonly (TenantChecks & { brand: string })[]
  /** 이 브랜드의 앱 밖 글(상태 · 옮긴 날을 붙인 줄 — src/lib/externalPosts.ts externalViews). 없으면 앱 글 줄만. */
  external?: readonly ExternalPostView[]
}

/** 늦은 날(둘 다 없으면 null). */
const laterDay = (a: string | null, b: string | null) => (a && b ? (a > b ? a : b) : (a ?? b))

/**
 * 한 브랜드의 줄과 작성자 진행. 올린 글(앱 글 · 앱 밖 글)은 올린 날이 늦은 순(모르면 뒤), 그 뒤에 아직 안 올린 배정 글(배정표 순 — 작성자 순,
 * 작성자 안에서는 번호 순). 배정 글이 살아 있는 편 없이 내린 글뿐이면 아직 안 올린 줄로도 보인다. 배정 판이 아닌 판으로 쓴 글은 배정 글로
 * 세지 않는다. 작성자 진행은 원장 줄만 센다(앱 밖 글은 넣지 않는다).
 */
export function buildTenantStatus(input: TenantStatusInput): { rows: PublishStatusRow[]; writers: WriterSummary[] } {
  const { tenantId, brand, plan } = input
  const own: TenantChecks = { tenantId, checks: input.checks }
  const others = input.others ?? []
  /** 보이는 확인 기록 — 뺀 줄은 제 줄 기록만, 살아 있는 줄은 같은 주소 키의 기록(다른 고객 브랜드 포함) 가운데 가장 나중 것. */
  const indexOf = (ids: readonly string[], key: string, publishedOn: string | null, removed: boolean) => {
    const found = removed ? findIndexRecord(own, [], ids, null) : findIndexRecord(own, others, ids, key)
    const record = found ? freshIndexRecord(found.record, publishedOn) : null
    const from = found && found.tenantId !== tenantId && (record?.naver || record?.google) ? found.tenantId : null
    return { naver: record?.naver ?? null, google: record?.google ?? null, checkFrom: from ? (others.find((o) => o.tenantId === from)?.brand ?? from) : null }
  }
  const postings = postingsOf(input.posts)
  const appRows = postings.map(({ post, ids, removed }): PublishStatusRow => {
    const match = planArticleOf(plan, post)
    const assigned = match === 'bank-unknown' ? null : match
    return {
      rowKey: `${tenantId}|${post.id}`,
      tenantId,
      brand,
      kind: 'posted',
      origin: 'app',
      postId: post.id,
      key: post.key,
      articleId: post.articleId,
      title: post.articleTitle?.trim() || assigned?.name || null,
      writer: assigned ? { ...assigned.writer } : null,
      writerUnknown: input.planUnreadable ? 'plan-unreadable' : match === 'bank-unknown' ? 'bank-unknown' : null,
      postedUnknown: false,
      platform: platformOf(post.url, input.ownedDomains),
      url: post.url,
      publishedOn: post.publishedOn,
      recheckFrom: post.publishedOn,
      trackedOn: null,
      removed,
      ...indexOf(ids, post.key, post.publishedOn, removed !== null),
    }
  })
  // 앱 밖 글 — 작성자는 늘 「앱 밖 글」(배정 파일과 상관없다), 다시 볼 날은 올린 날 · 추적 시작일 가운데 늦은 날부터, 앱 글로 옮긴 줄은 쉰다.
  // 색인 표시는 올린 날(다시 올린 줄이면 그 앞에 내린 날 다음 날까지)보다 앞선 확인을 뺀다(externalIndexBasis — 날짜 모르는 다시 올린 줄이
  // 내리기 전 표시를 이어받지 않게).
  const external = input.external ?? []
  const externalRows = external.map((x): PublishStatusRow => {
    const trackedOn = kstDate(x.trackedAt)
    const removed: PublishStatusRow['removed'] =
      x.state === 'removed' && x.removedReason ? { reason: x.removedReason, at: x.removedAt ?? '' } : x.state === 'moved' ? { reason: 'moved', at: x.movedOn ?? '' } : null
    return {
      rowKey: `${tenantId}|${x.id}`,
      tenantId,
      brand,
      kind: 'posted',
      origin: 'external',
      postId: x.id,
      key: x.key,
      articleId: `external:${x.id}`,
      title: x.title,
      writer: null,
      writerUnknown: null,
      postedUnknown: false,
      platform: platformOf(x.url, input.ownedDomains),
      url: x.url,
      publishedOn: x.publishedOn,
      recheckFrom: laterDay(x.publishedOn, trackedOn),
      trackedOn,
      removed,
      ...indexOf([x.id], x.key, externalIndexBasis(external, x), removed !== null),
    }
  })
  const posted = [...appRows, ...externalRows].sort((a, b) => (b.publishedOn ?? '').localeCompare(a.publishedOn ?? ''))
  // 배정 글의 진행 — 살아 있는 줄 가운데 배정 판으로 쓴 글만 올린 것으로 센다. 판을 모르는 글은 「올렸는지 미확인」으로 따로 둔다.
  const liveRows = postings.flatMap((p) => p.live).map((p) => ({ articleId: p.articleId, match: planArticleOf(plan, p) }))
  const live = new Set(liveRows.filter((p) => p.match !== null && p.match !== 'bank-unknown').map((p) => p.articleId))
  const unsure = new Set(liveRows.filter((p) => p.match === 'bank-unknown' && !live.has(p.articleId)).map((p) => p.articleId))
  const unposted = (plan?.articles ?? [])
    .filter((a) => !live.has(a.id))
    .map(
      (a): PublishStatusRow => ({
        rowKey: `${tenantId}|plan|${a.id}`,
        tenantId,
        brand,
        kind: 'unposted',
        origin: 'app',
        postId: null,
        key: null,
        articleId: a.id,
        title: a.name,
        writer: { ...a.writer },
        writerUnknown: null,
        postedUnknown: unsure.has(a.id),
        platform: null,
        url: null,
        publishedOn: null,
        recheckFrom: null,
        trackedOn: null,
        removed: null,
        naver: null,
        google: null,
        checkFrom: null,
      }),
    )
  const writers = plan
    ? planWriters(plan).map((w): WriterSummary => {
        const mine = plan.articles.filter((a) => a.writer.key === w.key)
        return {
          tenantId,
          brand,
          key: w.key,
          name: w.name,
          assigned: mine.length,
          posted: mine.filter((a) => live.has(a.id)).length,
          unsure: mine.filter((a) => unsure.has(a.id)).length,
        }
      })
    : []
  return { rows: [...posted, ...unposted], writers }
}

/**
 * 모든 브랜드의 줄 순서 — 올린 글(브랜드를 건너 올린 날 늦은 순, 모르면 뒤)을 먼저, 그 뒤에 아직 안 올린 배정 글(브랜드 · 배정표 순).
 * 브랜드마다 [올린 글, 배정 글]을 이어 붙이면 둘째 브랜드의 올린 글이 첫 브랜드의 배정 글 80줄 뒤에 묻혔다(검토 실측 86~90번째).
 */
export function orderRows(rows: PublishStatusRow[]): PublishStatusRow[] {
  const posted = rows.filter((r) => r.kind === 'posted').sort((a, b) => (b.publishedOn ?? '').localeCompare(a.publishedOn ?? ''))
  return [...posted, ...rows.filter((r) => r.kind === 'unposted')]
}

/** 그 브랜드 앱 밖 줄의 내린 표시(발행 현황 줄에서) — 다시 올린 줄의 기준일(src/lib/externalPosts.ts takenDownBefore)을 화면에서 정한다. */
export function externalTakedowns(rows: readonly PublishStatusRow[], tenantId: string): TakedownRowLike[] {
  return rows.flatMap((r) =>
    r.origin === 'external' && r.tenantId === tenantId && r.postId && r.key
      ? [{ id: r.postId, key: r.key, ...(r.removed && r.removed.reason !== 'moved' ? { removedAt: r.removed.at, removedReason: r.removed.reason } : {}) }]
      : [],
  )
}

/** 줄의 색인 표시 기준일 — 앱 글 줄은 올린 날, 앱 밖 줄은 서버와 같은 규칙(externalIndexBasis — 다시 올린 줄이면 내린 날 다음 날까지). */
export function indexBasisOfRow(rows: readonly PublishStatusRow[], r: PublishStatusRow): string | null {
  if (r.origin !== 'external' || !r.postId || !r.key) return r.publishedOn
  return externalIndexBasis(externalTakedowns(rows, r.tenantId), { id: r.postId, key: r.key, publishedOn: r.publishedOn, ...(r.removed?.at ? { removedAt: r.removed.at } : {}) })
}

/**
 * 이 주소를 앱 글로 가진(원장이 이기는) 고객 브랜드 — 표의 앱 글 줄로 본다(살아 있는 편 · 내린 편, 잘못 적은 주소만 남은 편은 빼고). 서버
 * 등록 거절 · 등록 패널과 같은 함수(externalRegistrationCheck — D13)로 가린다. 앱 밖 글 「다른 브랜드에도 추적」이 이 브랜드를 막는다.
 */
export function appHolderBrands(rows: readonly PublishStatusRow[], key: string): string[] {
  const byTenant = new Map<string, { key: string; recordedAt: string; removedAt?: string; removedReason?: string }[]>()
  for (const r of rows) {
    if (r.origin === 'external' || r.kind !== 'posted' || r.key !== key) continue
    const removed = r.removed ? { removedAt: r.removed.at || 'removed', removedReason: r.removed.reason } : {}
    byTenant.set(r.tenantId, [...(byTenant.get(r.tenantId) ?? []), { key, recordedAt: '', ...removed }])
  }
  return externalRegistrationCheck('', key, [...byTenant].map(([tenantId, posts]) => ({ tenantId, posts }))).appIn
}

/**
 * 표시를 저장한 뒤 화면 줄을 고친다 — 같은 주소의 살아 있는 줄 모두(다른 고객 브랜드 포함, 다시 읽은 것과 같은 값). 줄마다 올린 날보다
 * 앞선 확인은 뺀다(앱 밖 줄은 다시 올린 줄의 내린 날까지 — indexBasisOfRow). from은 표시를 누른 줄.
 */
export function withIndexRecord(rows: PublishStatusRow[], from: Pick<PublishStatusRow, 'tenantId' | 'brand' | 'key'>, record: IndexCheckRecord): PublishStatusRow[] {
  return rows.map((r) => {
    if (r.kind !== 'posted' || r.removed || r.key === null || r.key !== from.key) return r
    const fresh = freshIndexRecord(record, indexBasisOfRow(rows, r))
    const naver = fresh.naver ?? null
    const google = fresh.google ?? null
    return { ...r, naver, google, checkFrom: r.tenantId !== from.tenantId && (naver || google) ? from.brand : null }
  })
}

/** 같은 주소를 적은 브랜드들(살아 있는 올린 글) — 주소 키 → 브랜드 이름. 둘 이상인 주소만. */
export function sameUrlBrands(rows: PublishStatusRow[]): Map<string, string[]> {
  const byKey = new Map<string, string[]>()
  for (const r of rows) {
    if (r.kind !== 'posted' || r.removed || r.key === null) continue
    const list = byKey.get(r.key) ?? []
    if (!list.includes(r.brand)) byKey.set(r.key, [...list, r.brand])
  }
  return new Map([...byKey].filter(([, brands]) => brands.length > 1))
}

/** 작성자 칸에 쓰는 값 — origin이 없는 줄(옛 모양)은 앱 글로 본다. */
type WriterCell = Pick<PublishStatusRow, 'writer' | 'writerUnknown'> & { origin?: RowOrigin }

/** 작성자 칸 — 앱 밖 글은 「앱 밖 글」(먼저 본다 — C12), 「w1 · 이름」, 배정 밖 글은 「배정 없음」, 배정 파일을 못 읽었으면 「미확인」. */
export function writerLabel(row: WriterCell): string {
  if (row.origin === 'external') return '앱 밖 글'
  if (row.writer) return `${row.writer.key} · ${row.writer.name}`
  return row.writerUnknown ? '미확인' : '배정 없음'
}

// ── 확인 기록 적기 · 검사 ────────────────────────────────────────────────────

export type IndexCheckInput = { ok: true; engine: IndexEngine; state: IndexState | null } | { ok: false; error: string }

/** PUT 본문 검사 — { engine, state }만 받는다. state null은 지우기(미확인으로). 확인일 · 출처는 서버가 정한다. */
export function parseIndexCheckInput(body: unknown): IndexCheckInput {
  if (!isObj(body)) return { ok: false, error: '본문은 { engine, state } 모양이어야 합니다.' }
  const extra = Object.keys(body).filter((k) => k !== 'engine' && k !== 'state')
  if (extra.length > 0) return { ok: false, error: `받지 않는 칸이 있습니다: ${extra.join(', ')}` }
  const engine = INDEX_ENGINES.find((e) => e === body.engine)
  if (!engine) return { ok: false, error: 'engine은 naver · google 가운데 하나여야 합니다.' }
  if (!('state' in body)) return { ok: false, error: 'state가 필요합니다(shown · not-yet, 지우려면 null).' }
  if (body.state === null) return { ok: true, engine, state: null }
  const state = INDEX_STATES.find((s) => s === body.state)
  if (!state) return { ok: false, error: 'state는 shown · not-yet · null 가운데 하나여야 합니다.' }
  return { ok: true, engine, state }
}

/** 기록에 엔진 하나의 확인을 적거나(state) 지운다(null). 다른 엔진 칸은 그대로 둔다. */
export function applyIndexCheck(
  current: IndexCheckRecord | null,
  post: { id: string; key: string; url: string },
  engine: IndexEngine,
  state: IndexState | null,
  now: number,
  source: IndexSource = 'manual',
): IndexCheckRecord {
  const at = new Date(now).toISOString()
  const next: IndexCheckRecord = {
    postId: post.id,
    key: post.key,
    url: post.url,
    ...(current?.naver ? { naver: current.naver } : {}),
    ...(current?.google ? { google: current.google } : {}),
    updatedAt: at,
  }
  if (state === null) delete next[engine]
  else next[engine] = { state, checkedOn: todayKst(now), checkedAt: at, source }
  return next
}

function indexCheckOf(v: unknown): IndexCheck | null | undefined {
  if (v === undefined) return undefined
  if (!isObj(v)) return null
  const state = INDEX_STATES.find((s) => s === v.state)
  const source = v.source === 'manual' || v.source === 'auto' ? v.source : null
  if (!state || !source || !isDay(v.checkedOn) || !isStr(v.checkedAt) || Number.isNaN(Date.parse(v.checkedAt))) return null
  return { state, checkedOn: v.checkedOn, checkedAt: v.checkedAt, source }
}

/** 확인 파일 검사 — 형식 · 기록 모양이 하나라도 틀리면 깨진 파일이다(읽지도 쓰지도 않는다 — 빈 기록으로 덮으면 확인이 통째로 사라진다). */
export function parseIndexChecksFile(raw: unknown): { ok: true; checks: Record<string, IndexCheckRecord> } | { ok: false; error: string } {
  if (!isObj(raw) || raw.format !== INDEX_CHECKS_FORMAT || !isObj(raw.checks)) return { ok: false, error: `형식이 ${INDEX_CHECKS_FORMAT}가 아닙니다.` }
  const checks: Record<string, IndexCheckRecord> = {}
  for (const [id, r] of Object.entries(raw.checks)) {
    if (!isObj(r) || r.postId !== id || !isStr(r.key) || !isStr(r.url) || !isStr(r.updatedAt)) return { ok: false, error: `기록 모양이 틀렸습니다: ${id}` }
    const naver = indexCheckOf(r.naver)
    const google = indexCheckOf(r.google)
    if (naver === null || google === null) return { ok: false, error: `확인 칸이 틀렸습니다: ${id}` }
    checks[id] = { postId: id, key: r.key, url: r.url, ...(naver ? { naver } : {}), ...(google ? { google } : {}), updatedAt: r.updatedAt }
  }
  return { ok: true, checks }
}

// ── 다시 볼 날 ───────────────────────────────────────────────────────────────

export type Recheck =
  /** 노출됨 · 색인됨 — 다시 볼 일 없음. */
  | { kind: 'done' }
  /** 올린 날을 모른다. */
  | { kind: 'no-date' }
  /** 오늘 다시 볼 글 — since는 지난 다시 볼 날, over는 14일째도 지났다. */
  | { kind: 'due'; since: string; over: boolean }
  /** 다음 다시 볼 날. */
  | { kind: 'wait'; next: string }
  /** 14일째에 보고도 아직 — 더 다시 보지 않는다. */
  | { kind: 'over' }

/** 한 엔진의 다시 볼 날. */
export function recheckOf(publishedOn: string | null, check: IndexCheck | null, today: string): Recheck {
  if (check?.state === 'shown') return { kind: 'done' }
  if (!publishedOn) return { kind: 'no-date' }
  const days = RECHECK_DAYS.map((d) => addDays(publishedOn, d))
  const last = days.filter((d) => d <= today).at(-1)
  if (last && !(check && check.checkedOn >= last)) return { kind: 'due', since: last, over: today > days[days.length - 1]! }
  const next = days.find((d) => d > today)
  return next ? { kind: 'wait', next } : { kind: 'over' }
}

export interface RowRecheck {
  due: boolean
  /** 다시 볼 차례인 엔진. */
  engines: IndexEngine[]
  /** 다음 다시 볼 날(두 엔진 가운데 이른 날). */
  nextOn: string | null
  /** 14일째도 지났다. */
  over: boolean
  /** 「다시 볼 날」 칸의 머리 — 오늘 다시 볼 글 · 다음 날 · 14일 지남 · 모름 · 확인 끝. */
  label: string
  /** 오늘 다시 볼 글이면 어느 엔진인지(14일 지남까지) — 「네이버 · 구글 · 14일 지남」. 그 밖은 빈 글자. */
  note: string
}

const NO_RECHECK: RowRecheck = { due: false, engines: [], nextOn: null, over: false, label: '', note: '' }

/**
 * 줄의 다시 볼 날 — 두 엔진을 합친다. 아직 안 올린 글 · 뺀 글은 다시 보지 않는다(빈 칸). 기준일은 줄의 recheckFrom(앱 밖 글은 추적을 시작한
 * 날보다 이르지 않다 — D4)이고, 그 칸이 없는 줄(옛 모양)은 올린 날이다. 칸 · 요약 · 「오늘 다시 볼 글」 거르기가 모두 이 함수를 지나 같은
 * 기준일을 쓴다(C14).
 */
export function rowRecheck(
  row: Pick<PublishStatusRow, 'kind' | 'removed' | 'publishedOn' | 'naver' | 'google'> & { recheckFrom?: string | null },
  today: string,
): RowRecheck {
  if (row.kind !== 'posted' || row.removed) return NO_RECHECK
  const from = row.recheckFrom === undefined ? row.publishedOn : row.recheckFrom
  const per = INDEX_ENGINES.map((engine) => ({ engine, r: recheckOf(from, row[engine], today) }))
  const due = per.filter((p) => p.r.kind === 'due')
  if (due.length > 0) {
    const over = due.some((p) => p.r.kind === 'due' && p.r.over)
    const engines = due.map((p) => p.engine)
    const note = [...engines.map((e) => ENGINE_NAME[e]), ...(over ? ['14일 지남'] : [])].join(' · ')
    return { due: true, engines, nextOn: null, over, label: '오늘 다시 볼 글', note }
  }
  const next = per
    .map((p) => (p.r.kind === 'wait' ? p.r.next : null))
    .filter((d): d is string => d !== null)
    .sort()[0]
  if (next) return { ...NO_RECHECK, nextOn: next, label: next }
  if (per.some((p) => p.r.kind === 'over')) return { ...NO_RECHECK, over: true, label: '14일 지남' }
  if (per.some((p) => p.r.kind === 'no-date')) return { ...NO_RECHECK, label: '모름' }
  return { ...NO_RECHECK, label: '확인 끝' }
}

/** 확인 칸 이름 — 네이버는 노출, 구글은 색인. 기록이 없으면 미확인. */
export function indexStateLabel(engine: IndexEngine, check: IndexCheck | null): string {
  if (!check) return '미확인'
  if (check.state === 'not-yet') return '아직'
  return SHOWN_WORD[engine]
}

/** 확인 방법 — 사람이 눌렀으면 「직접」, 색인 자동 확인이 적었으면 「자동」. 기록이 없으면 빈 글자. */
export function checkSourceLabel(check: IndexCheck | null): string {
  if (!check) return ''
  return check.source === 'auto' ? '자동' : '직접'
}

// ── 요약 · 거르기 ────────────────────────────────────────────────────────────

export interface StatusSummary {
  posted: number
  /** 올린 글 가운데 앱 글 — 같은 주소가 어느 브랜드에서든 앱 글이면 앱 글이다(app + external = posted). */
  app: number
  /** 올린 글 가운데 앱 밖 글로만 추적하는 주소. */
  external: number
  naverShown: number
  googleShown: number
  /** 한 엔진이라도 미확인인 글. */
  unknown: number
  due: number
}

/**
 * 맨 위 요약 — 살아 있는 올린 글만, 서로 다른 주소로 센다(아직 안 올린 글 · 뺀 글은 빼고). 범위 변형 두 브랜드에 같은 글 주소를 적으면
 * 모든 브랜드 보기에서 두 줄이지만 올린 글은 하나다. 같은 주소의 줄 가운데 하나라도 그 상태면 센다. 앱 글 · 앱 밖 글도 같은 주소로 한
 * 번만 — 한 브랜드에서라도 앱 글이면 앱 글로 센다(C12).
 */
export function summarizeStatus(rows: PublishStatusRow[], today: string): StatusSummary {
  const pages = new Map<string, PublishStatusRow[]>()
  for (const r of rows) {
    if (r.kind !== 'posted' || r.removed) continue
    const k = r.key ?? r.rowKey
    pages.set(k, [...(pages.get(k) ?? []), r])
  }
  const count = (test: (r: PublishStatusRow) => boolean) => [...pages.values()].filter((same) => same.some(test)).length
  const app = count((r) => r.origin !== 'external')
  return {
    posted: pages.size,
    app,
    external: pages.size - app,
    naverShown: count((r) => r.naver?.state === 'shown'),
    googleShown: count((r) => r.google?.state === 'shown'),
    unknown: count((r) => r.naver === null || r.google === null),
    due: count((r) => rowRecheck(r, today).due),
  }
}

export type StateFilter = '' | IndexState | 'unknown'
export interface StatusFilter {
  /** '' = 모든 브랜드. */
  tenantId: string
  /** '' = 모두, 'none' = 배정 없음, 'unknown' = 미확인, 'external' = 앱 밖 글, 그 밖은 writerFilterValue. */
  writer: string
  naver: StateFilter
  google: StateFilter
  dueOnly: boolean
  showUnposted: boolean
  showRemoved: boolean
}

/** 작성자 거르기 값 — 같은 키라도 브랜드마다 사람이 다를 수 있어 이름까지 붙인다. 앱 밖 글은 먼저 'external'(작성자 칸과 같은 순서). */
export function writerFilterValue(row: WriterCell): string {
  if (row.origin === 'external') return 'external'
  if (row.writer) return `${row.writer.key}\n${row.writer.name}`
  return row.writerUnknown ? 'unknown' : 'none'
}

const stateMatches = (f: StateFilter, check: IndexCheck | null) => !f || (f === 'unknown' ? check === null : check?.state === f)

/** 거르기 — 엔진 상태 · 오늘 다시 볼 글은 올린 글에만 뜻이 있어 그 거르기를 켜면 아직 안 올린 글은 빠진다. */
export function filterRows(rows: PublishStatusRow[], f: StatusFilter, today: string): PublishStatusRow[] {
  const byState = Boolean(f.naver || f.google || f.dueOnly)
  return rows.filter((r) => {
    if (f.tenantId && r.tenantId !== f.tenantId) return false
    if (f.writer && writerFilterValue(r) !== f.writer) return false
    if (r.kind === 'unposted') return f.showUnposted && !byState
    if (r.removed && !f.showRemoved) return false
    if (!stateMatches(f.naver, r.naver) || !stateMatches(f.google, r.google)) return false
    return !f.dueOnly || rowRecheck(r, today).due
  })
}

/**
 * 고른 브랜드 · 작성자가 새로 읽은 줄에 없으면(브랜드를 지웠거나 그 브랜드 파일이 깨졌다 · 배정이 바뀌었다) 모두로 되돌린다 — select에는
 * 「모든 브랜드」가 보이는데 거르기는 사라진 브랜드로 남아 요약 · 표가 모두 비던 것. 브랜드가 사라졌으면 그 브랜드에서 고른 작성자도
 * 비운다(같은 키 · 이름의 작성자가 다른 브랜드에 있어도). 그대로면 같은 값을 돌려준다.
 */
export function validFilter(f: StatusFilter, rows: PublishStatusRow[]): StatusFilter {
  const tenantGone = Boolean(f.tenantId) && !rows.some((r) => r.tenantId === f.tenantId)
  const tenantId = tenantGone ? '' : f.tenantId
  const writer = f.writer && !tenantGone && rows.some((r) => (!tenantId || r.tenantId === tenantId) && writerFilterValue(r) === f.writer) ? f.writer : ''
  return tenantId === f.tenantId && writer === f.writer ? f : { ...f, tenantId, writer }
}

/**
 * 작성자 칩 누르기 — 켜면 그 브랜드 · 작성자로 거르고, 끄면 켜기 전 브랜드 거르기로 돌아간다(before — 칩으로 켰을 때만 있다). 끌 때 작성자만
 * 비우면 브랜드 거르기가 남아 다른 브랜드의 작성자 진행이 사라졌다.
 */
export function toggleWriterChip(
  f: StatusFilter,
  chip: { tenantId: string; writer: string },
  before: string | null,
): { filter: StatusFilter; before: string | null } {
  if (f.tenantId === chip.tenantId && f.writer === chip.writer) return { filter: { ...f, writer: '', tenantId: before ?? f.tenantId }, before: null }
  return { filter: { ...f, tenantId: chip.tenantId, writer: chip.writer }, before: before ?? f.tenantId }
}

/** 줄이 하나도 없을 때 — 파일을 읽지 못한 브랜드가 있으면 「기록이 없다」고 하지 않는다(issues), 정말 없으면 empty. 줄이 있으면 null. */
export function emptyStateOf(data: Pick<PublishStatus, 'rows' | 'issues'>): 'issues' | 'empty' | null {
  if (data.rows.length > 0) return null
  return data.issues.length > 0 ? 'issues' : 'empty'
}

// ── 화면 읽기 이름 ───────────────────────────────────────────────────────────

/**
 * 줄을 가리키는 이름 — 단추 · 링크가 줄마다 같은 이름이면 화면 읽기 프로그램으로 어느 글의 것인지 모른다. 브랜드 + 제목(모르면 주소) +
 * 플랫폼(같은 글을 티스토리 · 네이버 블로그에 함께 올리면 제목이 같다).
 */
export function rowName(row: Pick<PublishStatusRow, 'brand' | 'title' | 'url' | 'platform'>): string {
  const what = row.title?.trim() || (row.url ? withoutScheme(row.url) : '제목 미확인')
  return `${row.brand} 「${what}」${row.platform ? ` ${row.platform.label}` : ''}`
}

/**
 * 표시 단추의 이름 — state null은 지우기. 이미 그 상태인 단추를 다시 누르면 상태는 그대로이고 확인일만 오늘로 바뀌므로 그렇게 알린다
 * (눌린 토글을 다시 눌러도 풀리지 않는 것을 이름으로 설명).
 */
export function markLabel(row: Pick<PublishStatusRow, 'brand' | 'title' | 'url' | 'platform'>, engine: IndexEngine, state: IndexState | null, current: IndexCheck | null): string {
  const target = `${rowName(row)} ${ENGINE_NAME[engine]}`
  if (state === null) return `${target} 표시 지우기(미확인으로)`
  const word = state === 'shown' ? SHOWN_WORD[engine] : '아직'
  return current?.state === state ? `${target} ${word} — 지금 표시됨, 다시 누르면 확인일을 오늘로` : `${target} ${word}으로 표시`
}

/** 검색 링크의 이름 — 새 창(데스크톱 앱은 시스템 브라우저)으로 열린다는 것까지. */
export function searchLabel(row: Pick<PublishStatusRow, 'brand' | 'title' | 'url' | 'platform'>, engine: IndexEngine): string {
  return `${rowName(row)} ${ENGINE_NAME[engine]}에서 확인(새 창)`
}

// ── 검색 주소 ────────────────────────────────────────────────────────────────

/** 주소에서 http(s):// · # 뒤 · 끝 슬래시를 뗀다. */
const withoutScheme = (url: string) => url.trim().replace(/^https?:\/\//i, '').replace(/#.*$/, '').replace(/\/+$/, '')

/**
 * 「네이버에서 확인」 — 네이버 블로그 글은 블로그 검색에서 제목으로, 그 밖은 웹문서 검색에서 제목(모르면 주소)으로 찾는다. 올린 주소가 없으면
 * null.
 */
export function naverSearchUrl(row: Pick<PublishStatusRow, 'url' | 'title' | 'platform'>): string | null {
  if (!row.url) return null
  const where = row.platform?.key === 'naver-blog' ? 'blog' : 'web'
  const query = row.title?.trim() || withoutScheme(row.url)
  return `https://search.naver.com/search.naver?where=${where}&query=${encodeURIComponent(query)}`
}

/** 자동으로 찾지 않는 까닭 — platform 유튜브 · 인스타그램, query 추적 질의를 떼고도 질의가 남음(site:로 못 가림), form 주소 모양. */
export type QueryRefusal = 'platform' | 'query' | 'form'
export type SiteQuery = { ok: true; q: string } | { ok: false; reason: QueryRefusal }

const SITE_QUERY_MAX = 1500

/** 등록 주소의 경로 그대로(퍼센트 인코딩 · 한글 원문 그대로) — 질의 · 해시 · 끝 슬래시만 뗀다. */
function registeredPath(url: string): string {
  const rest = url.trim().replace(/^https?:\/\//i, '')
  const cut = rest.search(/[/?#]/)
  if (cut < 0) return ''
  return rest.slice(cut).replace(/#.*$/, '').replace(/\?.*$/, '').replace(/\/+$/, '')
}

const siteOr = (forms: string[]): SiteQuery => {
  const q = forms.map((f) => `site:${f}`).join(' OR ')
  return q.length > SITE_QUERY_MAX ? { ok: false, reason: 'form' } : { ok: true, q }
}

/**
 * 구글 site: 검색어 — 색인 자동 확인(src/lib/indexAuto.ts)과 사람이 여는 「구글에서 확인」이 같은 검색어를 쓴다. 티스토리는 /m/ 모바일 주소로도
 * 색인될 수 있어 두 모양을, 네이버 블로그는 /아이디/글번호로(PostView 모양으로 적은 글도) blog · m.blog 두 모양을, www가 붙은 주소는 www 있는 ·
 * 없는 두 모양을 OR로 묻는다. 경로가 붙은 site: · OR · 한글 경로의 동작은 실제 키 시험 전이라 [모름] — 자동 판정이 정확한 주소 키로만
 * 「색인됨」을 적으므로 틀려도 「색인됨」을 잘못 적지는 않는다.
 */
export function googleSiteQuery(url: string, platform: PlatformKey | null): SiteQuery {
  if (platform === 'youtube' || platform === 'instagram') return { ok: false, reason: 'platform' }
  let u: URL
  try {
    u = new URL(url.trim())
  } catch {
    // 주소로 읽히지 않는 값 — 검색어를 만들 수 없다.
    return { ok: false, reason: 'form' }
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.port || u.username || u.password) return { ok: false, reason: 'form' }
  const host = u.hostname.toLowerCase()
  if (platform === 'naver-blog') {
    const m = /^blog\.naver\.com\/([a-z0-9_-]+)\/(\d+)$/.exec(trackingKey(url) ?? '')
    return m ? siteOr([`blog.naver.com/${m[1]}/${m[2]}`, `m.blog.naver.com/${m[1]}/${m[2]}`]) : { ok: false, reason: 'form' }
  }
  const path = registeredPath(url)
  if (!path || /[\s"\\]/.test(path)) return { ok: false, reason: 'form' }
  if (platform === 'tistory') {
    const p = path.replace(/^\/m(?=\/)/i, '')
    return siteOr([`${host}${p}`, `${host}/m${p}`])
  }
  if ([...u.searchParams.keys()].some((k) => !TRACKING_PARAM.test(k))) return { ok: false, reason: 'query' }
  return host.startsWith('www.') ? siteOr([`${host}${path}`, `${host.slice(4)}${path}`]) : siteOr([`${host}${path}`])
}

/**
 * 「구글에서 확인」 — 색인 자동 확인과 같은 site: 검색어 · 같은 조건(google.co.kr · hl=ko · gl=kr — 사람이 한국에서 보는 구글)으로 연다
 * (2026-11-10 D9 A). 자동으로 안 찾는 주소(유튜브 · 인스타그램 · 질의가 남는 주소 등)는 site:<주소>로 사람이 본다.
 */
export function googleSearchUrl(url: string): string {
  const site = googleSiteQuery(url, platformOf(url, [])?.key ?? null)
  const q = site.ok ? site.q : `site:${withoutScheme(url)}`
  return `https://www.google.co.kr/search?q=${encodeURIComponent(q)}&hl=ko&gl=kr`
}

// ── CSV ──────────────────────────────────────────────────────────────────────

/**
 * CSV 한 칸 — = + - @ 탭 CR로 시작하면 앞에 '를 붙여 엑셀이 수식으로 읽지 않게 하고(CSV 수식 주입), 쉼표 · 따옴표 · 줄바꿈이 있으면
 * 따옴표로 감싼다(RFC 4180, 따옴표는 두 번).
 */
export function csvCell(v: string | number | null): string {
  const s = v === null ? '' : String(v)
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

const REMOVED_LABEL: Record<RemovedReason, string> = { 'taken-down': '내림', mistake: '잘못 적은 주소' }

/**
 * 표의 「다시 볼 날」 칸 — 뺀 글은 뺀 이유(앱 글로 옮겨 쉬는 앱 밖 줄은 「앱 글로 옮김(옮긴 날)」 — D12), 오늘 다시 볼 글은 어느 엔진인지 ·
 * 14일 지남까지(표의 칩 · 아래 줄과 같은 글자).
 */
export function recheckCell(row: PublishStatusRow, today: string): string {
  if (row.removed?.reason === 'moved') return `앱 글로 옮김(${row.removed.at || '날짜 모름'})`
  if (row.removed) return REMOVED_LABEL[row.removed.reason]
  const r = rowRecheck(row, today)
  return r.note ? `${r.label} (${r.note})` : r.label
}

/** 아직 안 올린 배정 글의 표시 — 판을 몰라 올렸는지 모르는 글은 「올렸는지 미확인」. */
export const unpostedLabel = (row: Pick<PublishStatusRow, 'postedUnknown'>) => (row.postedUnknown ? '올렸는지 미확인' : '아직 안 올림')

/**
 * 표에 보이는 줄 그대로 — 열은 표와 같고 엔진마다 확인일을 더한다. 엑셀이 한글을 깨뜨리지 않게 BOM을 붙이고 줄은 CRLF. checkMethods면 끝에
 * 「네이버 확인 방법」 「구글 확인 방법」(직접 · 자동 · 빈칸) 두 열을 더한다 — 자동 「아직」(site: 검색에서 못 봄)을 사람이 본 「아직」과 가르려고
 * (색인 자동 확인 D9 A). 발행 현황 화면은 늘 켠다. 앞 열 순서는 그대로다.
 */
export function publishStatusCsv(rows: PublishStatusRow[], today: string, opts: { checkMethods?: boolean } = {}): string {
  const head = ['브랜드', '작성자', '글 제목', '플랫폼', '주소', '발행일', '네이버 노출', '네이버 확인일', '구글 색인', '구글 확인일', '다시 볼 날']
  if (opts.checkMethods) head.push('네이버 확인 방법', '구글 확인 방법')
  const lines = [head.map(csvCell).join(',')]
  for (const r of rows) {
    const posted = r.kind === 'posted'
    const cells = [
      r.brand,
      writerLabel(r),
      r.title ?? '제목 미확인',
      r.platform?.label ?? '',
      r.url ?? '',
      posted ? (r.publishedOn ?? '모름') : unpostedLabel(r),
      posted ? indexStateLabel('naver', r.naver) : '',
      r.naver?.checkedOn ?? '',
      posted ? indexStateLabel('google', r.google) : '',
      r.google?.checkedOn ?? '',
      posted ? recheckCell(r, today) : '',
    ]
    if (opts.checkMethods) cells.push(posted ? checkSourceLabel(r.naver) : '', posted ? checkSourceLabel(r.google) : '')
    lines.push(cells.map(csvCell).join(','))
  }
  return '﻿' + lines.join('\r\n') + '\r\n'
}

export function publishStatusFileName(today: string): string {
  return `발행-현황-${today}.csv`
}
