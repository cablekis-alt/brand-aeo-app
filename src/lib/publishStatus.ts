/**
 * 발행 현황 — 고객 브랜드 전체의 올린 글을 한 표로 본다(화면: src/pages/PublishStatus.tsx, 서버: server/publishStatus.ts ·
 * server/indexChecks.ts). 작성자 8명이 브랜드마다 10편씩 올리므로, 누가 몇 편을 올렸는지와 올린 글이 네이버 · 구글에 나오는지를 브랜드마다
 * 화면을 옮겨 다니며 볼 수 없었다.
 *
 * ── 한 줄 = 한 편 ─────────────────────────────────────────────────────────
 * 원장(server/publishedPosts.ts)은 「주소 한 줄 = 기록 한 줄」이라 같은 글을 자사 줄과 채널 줄에 함께 적으면 두 줄이다. 블로그에 올라간 글은
 * 하나이므로 같은 주소 · 같은 올린 날의 줄은 한 편으로 묶는다(성과 표 src/lib/publishTracking.ts distinctPostings와 같은 묶음). 다만 여기는
 * 「뺀 글 보기」가 있어 잘못 적은 주소도 흐리게 보인다.
 *
 * ── 색인 확인은 사람이 본 것만 ─────────────────────────────────────────────
 * 지금은 네이버 · 구글 모두 사람이 검색해 보고 「노출됨/색인됨」 · 「아직」을 누른다. 누르지 않은 글은 「미확인」이다 — 「아직」으로 채우지
 * 않는다. 기록은 원장과 따로 data/<tenant>/index-checks.json에 두고(원장 모양은 바꾸지 않는다), 기록마다 출처(manual · auto)를 남겨 나중에
 * 네이버 검색 API로 자동 확인해도 같은 칸에 쓴다.
 *
 * ── 다시 볼 날 ────────────────────────────────────────────────────────────
 * 올린 뒤 3 · 7 · 14일째에 다시 본다. 그날이 지났는데 그날 이후에 본 기록이 없고 노출 · 색인도 아니면 「오늘 다시 볼 글」이다. 14일째에 보고도
 * 아직이면 「14일 지남」으로 둔다.
 *
 * 서버가 import하므로 상대 import는 .js로 쓰고, 화면 모듈은 끌어오지 않는다.
 */
import { todayKst } from './publishedUrl.js'
import { planWriters, writerArticle, type PlanWriter, type WriterPlan } from './probePlan.js'

export const INDEX_CHECKS_FORMAT = 'index-checks/1'
export const INDEX_ENGINES = ['naver', 'google'] as const
export type IndexEngine = (typeof INDEX_ENGINES)[number]
export const INDEX_STATES = ['shown', 'not-yet'] as const
export type IndexState = (typeof INDEX_STATES)[number]
/** manual — 사람이 검색해 보고 눌렀다. auto — 나중에 붙일 자동 확인(네이버 검색 API). */
export type IndexSource = 'manual' | 'auto'

export const ENGINE_NAME: Record<IndexEngine, string> = { naver: '네이버', google: '구글' }

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
  /** 원장 기록 id(한 편의 대표 줄). */
  postId: string
  /** 주소 키(src/lib/publishedUrl.ts trackingKey) — 대표 줄이 바뀌거나 올린 날을 고쳐 묶음이 달라져도 같은 주소의 기록을 찾는다. */
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

/** 올린 주소의 플랫폼 — 알려진 플랫폼 → 브랜드 자사 사이트(하위 도메인 포함) → 그 밖(호스트). http(s) 주소가 아니면 null. */
export function platformOf(url: string, ownedDomains: readonly string[]): Platform | null {
  let host: string
  try {
    const u = new URL(url.trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    host = u.hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    // 주소로 읽히지 않는 값 — 플랫폼을 모른다.
    return null
  }
  const known = PLATFORMS.find((p) => p.test(host))
  if (known) return { key: known.key, label: known.label }
  if (ownedDomains.some((d) => ownedHost(d) && under(host, ownedHost(d)))) return { key: 'owned', label: '자사 사이트' }
  return { key: 'other', label: host }
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
}

export type RemovedReason = 'mistake' | 'taken-down'

export interface Posting<P extends LedgerPostLike = LedgerPostLike> {
  /** 대표 줄. */
  post: P
  /** 이 편으로 묶인 줄 id 모두(뺀 줄 포함) — 확인 기록을 대표가 아닌 줄로 적었어도 찾는다. */
  ids: string[]
  /** 내렸거나(taken-down) 잘못 적은 주소만 남은(mistake) 편. 살아 있으면 null. */
  removed: { reason: RemovedReason; at: string } | null
}

/**
 * 원장 줄을 올린 글 한 편씩으로 묶는다 — 같은 주소 · 같은 올린 날. 같은 주소에 날짜 있는 줄이 있으면 날짜 없는 옛 줄은 뺀다.
 * 대표: 한 줄이라도 내렸으면 가장 먼저 내린 줄(그 뒤에 같은 주소를 다시 적은 줄이 있으면 다시 올린 것으로 보고 그 줄), 아니면 살아 있는
 * 첫 줄, 다 잘못 적은 주소면 첫 줄(뺀 글).
 */
export function postingsOf<P extends LedgerPostLike>(posts: P[]): Posting<P>[] {
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
    if (down && !reposted) return { post: down, ids, removed: { reason: 'taken-down' as const, at: down.removedAt! } }
    const rep = reposted ?? live[0]
    if (rep) return { post: rep, ids, removed: null }
    const first = group[0]!
    return { post: first, ids, removed: { reason: 'mistake' as const, at: first.removedAt ?? '' } }
  })
}

/** 가장 나중에 고친 기록. */
const latest = (list: IndexCheckRecord[]): IndexCheckRecord | null => [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null

/** 한 편의 확인 기록 — 대표 줄 id → 묶인 다른 줄 id → 같은 주소 키(가장 나중 기록). 없으면 null(두 엔진 모두 미확인). */
export function findIndexRecord(checks: Record<string, IndexCheckRecord>, repId: string, ids: readonly string[], key: string): IndexCheckRecord | null {
  if (checks[repId]) return checks[repId]
  const byId = latest(ids.map((id) => checks[id]).filter((r): r is IndexCheckRecord => Boolean(r)))
  if (byId) return byId
  return latest(Object.values(checks).filter((r) => r.key === key))
}

// ── 표의 줄 ──────────────────────────────────────────────────────────────────

export interface PublishStatusRow {
  /** 화면 키 — 올린 글은 `<브랜드>|<대표 줄 id>`, 아직 안 올린 배정 글은 `<브랜드>|plan|<글 id>`. */
  rowKey: string
  tenantId: string
  /** 브랜드 이름(범위 변형이면 꼬리표까지 — src/lib/brandVariant.ts brandLabel). */
  brand: string
  kind: 'posted' | 'unposted'
  /** 확인 기록을 적는 원장 줄(대표). 아직 안 올린 글이면 null. */
  postId: string | null
  articleId: string
  /** 그때 글 제목(없으면 배정 주제 이름). 모르면 null. */
  title: string | null
  /** 배정 작성자. 배정 밖 글이면 null. */
  writer: PlanWriter | null
  /** 배정 파일을 읽지 못해 작성자를 모른다 — writer는 null이고 「미확인」으로 보인다. */
  writerUnknown: boolean
  platform: Platform | null
  url: string | null
  /** 올린 날(한국 날짜). 모르면 null. */
  publishedOn: string | null
  removed: { reason: RemovedReason; at: string } | null
  naver: IndexCheck | null
  google: IndexCheck | null
}

/** 작성자 한 사람의 진행 — 배정 글 중 살아 있는 글이 하나라도 있는 글 수. */
export interface WriterSummary {
  tenantId: string
  brand: string
  key: string
  name: string
  assigned: number
  posted: number
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
}

/**
 * 한 브랜드의 줄과 작성자 진행. 올린 글은 올린 날이 늦은 순(모르면 뒤), 그 뒤에 아직 안 올린 배정 글(배정표 순 — 작성자 순, 작성자 안에서는
 * 번호 순). 배정 글이 살아 있는 편 없이 내린 글뿐이면 아직 안 올린 줄로도 보인다.
 */
export function buildTenantStatus(input: TenantStatusInput): { rows: PublishStatusRow[]; writers: WriterSummary[] } {
  const { tenantId, brand, plan } = input
  const postings = postingsOf(input.posts)
  const posted = postings
    .map(({ post, ids, removed }): PublishStatusRow => {
      const assigned = writerArticle(plan, post.articleId)
      const record = findIndexRecord(input.checks, post.id, ids, post.key)
      return {
        rowKey: `${tenantId}|${post.id}`,
        tenantId,
        brand,
        kind: 'posted',
        postId: post.id,
        articleId: post.articleId,
        title: post.articleTitle?.trim() || assigned?.name || null,
        writer: assigned ? { ...assigned.writer } : null,
        writerUnknown: !assigned && input.planUnreadable,
        platform: platformOf(post.url, input.ownedDomains),
        url: post.url,
        publishedOn: post.publishedOn,
        removed,
        naver: record?.naver ?? null,
        google: record?.google ?? null,
      }
    })
    .sort((a, b) => (b.publishedOn ?? '').localeCompare(a.publishedOn ?? ''))
  const live = new Set(postings.filter((p) => !p.removed).map((p) => p.post.articleId))
  const unposted = (plan?.articles ?? [])
    .filter((a) => !live.has(a.id))
    .map(
      (a): PublishStatusRow => ({
        rowKey: `${tenantId}|plan|${a.id}`,
        tenantId,
        brand,
        kind: 'unposted',
        postId: null,
        articleId: a.id,
        title: a.name,
        writer: { ...a.writer },
        writerUnknown: false,
        platform: null,
        url: null,
        publishedOn: null,
        removed: null,
        naver: null,
        google: null,
      }),
    )
  const writers = plan
    ? planWriters(plan).map((w): WriterSummary => {
        const mine = plan.articles.filter((a) => a.writer.key === w.key)
        return { tenantId, brand, key: w.key, name: w.name, assigned: mine.length, posted: mine.filter((a) => live.has(a.id)).length }
      })
    : []
  return { rows: [...posted, ...unposted], writers }
}

/** 작성자 칸 — 「w1 · 이름」, 배정 밖 글은 「배정 없음」, 배정 파일을 못 읽었으면 「미확인」. */
export function writerLabel(row: Pick<PublishStatusRow, 'writer' | 'writerUnknown'>): string {
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
  /** 표 · CSV의 「다시 볼 날」 칸. */
  label: string
}

const NO_RECHECK: RowRecheck = { due: false, engines: [], nextOn: null, over: false, label: '' }

/** 줄의 다시 볼 날 — 두 엔진을 합친다. 아직 안 올린 글 · 뺀 글은 다시 보지 않는다(빈 칸). */
export function rowRecheck(row: Pick<PublishStatusRow, 'kind' | 'removed' | 'publishedOn' | 'naver' | 'google'>, today: string): RowRecheck {
  if (row.kind !== 'posted' || row.removed) return NO_RECHECK
  const per = INDEX_ENGINES.map((engine) => ({ engine, r: recheckOf(row.publishedOn, row[engine], today) }))
  const due = per.filter((p) => p.r.kind === 'due')
  if (due.length > 0) {
    const over = due.some((p) => p.r.kind === 'due' && p.r.over)
    return { due: true, engines: due.map((p) => p.engine), nextOn: null, over, label: '오늘 다시 볼 글' }
  }
  const next = per
    .map((p) => (p.r.kind === 'wait' ? p.r.next : null))
    .filter((d): d is string => d !== null)
    .sort()[0]
  if (next) return { due: false, engines: [], nextOn: next, over: false, label: next }
  if (per.some((p) => p.r.kind === 'over')) return { due: false, engines: [], nextOn: null, over: true, label: '14일 지남' }
  if (per.some((p) => p.r.kind === 'no-date')) return { due: false, engines: [], nextOn: null, over: false, label: '모름' }
  return { due: false, engines: [], nextOn: null, over: false, label: '확인 끝' }
}

/** 확인 칸 이름 — 네이버는 노출, 구글은 색인. 기록이 없으면 미확인. */
export function indexStateLabel(engine: IndexEngine, check: IndexCheck | null): string {
  if (!check) return '미확인'
  if (check.state === 'not-yet') return '아직'
  return engine === 'naver' ? '노출됨' : '색인됨'
}

// ── 요약 · 거르기 ────────────────────────────────────────────────────────────

export interface StatusSummary {
  posted: number
  naverShown: number
  googleShown: number
  /** 한 엔진이라도 미확인인 글. */
  unknown: number
  due: number
}

/** 맨 위 요약 — 살아 있는 올린 글만 센다(아직 안 올린 글 · 뺀 글은 빼고). */
export function summarizeStatus(rows: PublishStatusRow[], today: string): StatusSummary {
  const live = rows.filter((r) => r.kind === 'posted' && !r.removed)
  return {
    posted: live.length,
    naverShown: live.filter((r) => r.naver?.state === 'shown').length,
    googleShown: live.filter((r) => r.google?.state === 'shown').length,
    unknown: live.filter((r) => r.naver === null || r.google === null).length,
    due: live.filter((r) => rowRecheck(r, today).due).length,
  }
}

export type StateFilter = '' | IndexState | 'unknown'
export interface StatusFilter {
  /** '' = 모든 브랜드. */
  tenantId: string
  /** '' = 모두, 'none' = 배정 없음, 'unknown' = 미확인, 그 밖은 writerFilterValue. */
  writer: string
  naver: StateFilter
  google: StateFilter
  dueOnly: boolean
  showUnposted: boolean
  showRemoved: boolean
}

/** 작성자 거르기 값 — 같은 키라도 브랜드마다 사람이 다를 수 있어 이름까지 붙인다. */
export function writerFilterValue(row: Pick<PublishStatusRow, 'writer' | 'writerUnknown'>): string {
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

/** 「구글에서 확인」 — site:<주소>로 그 글이 색인됐는지 본다. */
export function googleSearchUrl(url: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(`site:${withoutScheme(url)}`)}`
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

/** 표의 「다시 볼 날」 칸 — 뺀 글은 뺀 이유. */
export function recheckCell(row: PublishStatusRow, today: string): string {
  if (row.removed) return REMOVED_LABEL[row.removed.reason]
  return rowRecheck(row, today).label
}

/** 표에 보이는 줄 그대로 — 열은 표와 같고 엔진마다 확인일을 더한다. 엑셀이 한글을 깨뜨리지 않게 BOM을 붙이고 줄은 CRLF. */
export function publishStatusCsv(rows: PublishStatusRow[], today: string): string {
  const head = ['브랜드', '작성자', '글 제목', '플랫폼', '주소', '발행일', '네이버 노출', '네이버 확인일', '구글 색인', '구글 확인일', '다시 볼 날']
  const lines = [head.map(csvCell).join(',')]
  for (const r of rows) {
    const posted = r.kind === 'posted'
    lines.push(
      [
        r.brand,
        writerLabel(r),
        r.title ?? '제목 미확인',
        r.platform?.label ?? '',
        r.url ?? '',
        posted ? (r.publishedOn ?? '모름') : '아직 안 올림',
        posted ? indexStateLabel('naver', r.naver) : '',
        r.naver?.checkedOn ?? '',
        posted ? indexStateLabel('google', r.google) : '',
        r.google?.checkedOn ?? '',
        posted ? recheckCell(r, today) : '',
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return '﻿' + lines.join('\r\n') + '\r\n'
}

export function publishStatusFileName(today: string): string {
  return `발행-현황-${today}.csv`
}
