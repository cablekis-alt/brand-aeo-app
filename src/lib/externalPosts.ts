/**
 * 앱 밖 글 — 앱에서 만들지 않은 글(손으로 쓴 글)의 주소를 브랜드마다 따로 적어 인용을 추적한다(data/<tenant>/external-posts.json,
 * 서버: server/externalPosts.ts). 2026-11-10 설계 B안 · 검토 C1–C21 · 결정 D1–D14.
 *
 * ── 왜 원장(published-posts.json)에 섞지 않는가 ─────────────────────────────────
 * 원장은 「집행」 기록이다 — 콘텐츠 보관함 · 정기진단 보고서 집행 표 · 퍼포먼스 집행 핀 · 실행 계획이 모두 원장을 읽는다. 손글을 원장에
 * 섞으면 그 화면을 하나씩 막아야 하고, 하나라도 빠뜨리면 손글이 「집행 글」로 조용히 섞인다. 따로 두면 앱 글 화면에 구조상 닿지 않는다
 * (scripts/verify-external-posts.ts가 원장 · 집행 상태 · 앱 글 응답이 바이트 단위로 같음을 지킨다). 집행 상태 · 글 id · 질문은 담지 않는다.
 *
 * ── 짐작하지 않는다 ────────────────────────────────────────────────────────
 * 올린 날을 모르면 null(「올린 날 모름」) — 오늘로 채우지 않는다(지난 인용이 「올리기 전」으로 사라진다). 제목이 없으면 null(화면은
 * 「제목 미확인」). 올린 시각은 늘 모른다 — 추적을 시작한 시각(trackedAt)은 올린 시각이 아니다. 그래서 인용 계산에 넘길 때 같은 날 측정은
 * 전후 불명(during)이 된다(externalAsLedgerPost).
 *
 * ── 한 주소 한 줄 · 다시 올리면 새 줄 ─────────────────────────────────────────
 * 같은 브랜드 안에서 살아 있는(빼지 않은) 줄은 주소 키마다 하나다. 「글을 내림」으로 뺀 주소를 다시 올리면 새 x- 줄을 적어 내린 기간을
 * 남긴다(원장과 같다). 되살리기는 「잘못 적음」으로 뺀 줄만 — 내린 줄을 되살리면 내린 동안의 측정도 「올라가 있음」으로 센다. 다시 올린
 * 줄의 올린 날은 내린 날 뒤여야 한다(repostDayProblem) — 비공개를 풀면 페이지 날짜가 처음 올린 날 그대로라, 그 날을 받으면 내린 동안의
 * 측정을 「올라가 있음」으로 센다. 날짜 모름으로 다시 올린 줄도 내린 날까지 한 측정은 세지 않는다(repostBasis — 색인 표시와 같은 기준일).
 *
 * ── 원장이 이긴다 ─────────────────────────────────────────────────────────
 * 같은 브랜드 원장에 같은 주소 키의 앱 글 줄 — 살아 있거나 「글을 내렸어요」로 뺀 줄, 옛 기록 포함(성과 표 shownPosts와 같은 기준) — 이
 * 있으면 앱 밖 줄은 쉰다(「앱 글로 옮김」). 등록 · 되살리기 거절도 같은 기준이다(ledgerWinners). 옮긴 날은 그 원장 줄을 적은 때의 한국
 * 날짜다. 앱 밖 표는 앱 글 표가 실제로 세는 측정(회차)만 비운다 — 서버가 회차마다 그 앱 글 줄의 칸을 함께 계산해, 앱 글 칸이 「올리기 전」이
 * 아니면 앱 밖 칸을 비운다(server/externalPosts.ts getExternalHistory). 날짜로 끊으면 옮긴 날 옮기기 전에 끝난 측정이나, 앱 글의 올린 날을
 * 기록일보다 뒤로 고친 사이의 측정을 어느 표도 세지 않는다. 다른 브랜드의 원장은 막지 않는다(「같은 주소: ○○의 앱 글」로만 알린다 —
 * externalRegistrationCheck).
 *
 * ── 격리의 범위 ───────────────────────────────────────────────────────────
 * 원장 · 집행 상태 · 앱 글 응답(올린 글 목록 · 인용 이력 · 회차 보기)은 앱 밖 글과 섞이지 않는다. 색인 표시(index-checks.json)는 예외다 —
 * 네이버 노출 · 구글 색인은 주소의 상태라 x- id 기록도 같은 파일에 두고, 같은 주소 키의 앱 글 줄(같은 브랜드 · 다른 고객 브랜드)과 서로
 * 이어받는다(C15, 의도한 연속성 — 앱 글로 옮긴 뒤에도 표시가 이어진다). 그래서 격리 검사는 색인 표시를 보지 않는다.
 *
 * 런타임 import는 './publishedUrl.js'뿐이다 — 서버가 '../src/lib/externalPosts.js'로 불러 쓴다. 측정 · 집계 · 원장 · 보고서 · 실행 계획
 * 모듈은 이 파일을 불러오지 않는다(scripts/verify-external-posts.ts 정적 검사).
 */
import { ARTICLE_URL_REASON, isArticleUrl, KEY_RULE, kstDate, timingOf, todayKst, trackingKey, type MeasureWindow } from './publishedUrl.js'

/** 브랜드마다 살아 있는(빼지 않은) 줄 상한 — 넘으면 조용히 자르지 않고 알린다. */
export const MAX_EXTERNAL_POSTS = 500
/** 뺀 줄을 포함한 줄 상한 — 파일이 끝없이 커지지 않게. */
export const MAX_EXTERNAL_ROWS = MAX_EXTERNAL_POSTS * 4
export const EXTERNAL_TITLE_MAX = 200
export const UNTITLED = '제목 미확인'
/** 앱 밖 글 id — x-<12자>. 원장 id(p- · legacy-)와 겹치지 않는다. */
export const EXTERNAL_ID = /^x-[0-9a-f]{12}$/

/** 올린 날의 출처 — page 페이지 날짜, user 사람이 고름, unknown 모름(publishedOn null). */
export type ExternalDateSource = 'page' | 'user' | 'unknown'
export type ExternalRemovedReason = 'mistake' | 'taken-down'

export interface ExternalPost {
  id: string
  /** 적은 그대로(앞뒤 공백만 뗀다). */
  url: string
  /** 비교용 키(publishedUrl.ts trackingKey). keyRule이 바뀌면 읽을 때 url로 다시 계산한다. */
  key: string
  /** 페이지 제목. 없으면 null — 화면은 「제목 미확인」(externalTitle). */
  title: string | null
  /** 올린 날(한국 날짜). null이면 모른다 — 전후를 판단하지 않는다. */
  publishedOn: string | null
  publishedOnSource: ExternalDateSource
  /** 추적을 시작한 시각 — 한 번 쓰면 바꾸지 않는다. 올린 시각이 아니다. */
  trackedAt: string
  removedAt?: string
  removedReason?: ExternalRemovedReason
}

export interface ExternalPostsFile {
  version: 1
  keyRule: number
  posts: ExternalPost[]
}

/**
 * 화면 · 응답에 싣는 줄 — 파일의 줄에 상태를 더한 것.
 *   live     추적 중
 *   moved    같은 브랜드에 앱 글로 적혀 쉰다(원장이 이김) — 지우지 않는다
 *   removed  뺐다(removedReason)
 */
export type ExternalState = 'live' | 'moved' | 'removed'
export interface ExternalPostView extends ExternalPost {
  state: ExternalState
  /** 같은 브랜드 원장에 같은 주소의 앱 글 줄이 있으면 그 줄을 적은 한국 날짜(가장 이른 줄). 없으면 null. 뺀 줄에도 싣는다. */
  movedOn: string | null
  /**
   * 앱 글 표가 이 주소를 세기 시작하는 날 — 이긴 앱 글 줄의 올린 날 가운데 가장 이른 날(그 날의 회차는 앱 글의 올린 시각으로 가린다). 앱 글
   * 줄에 올린 날이 없으면(옛 기록) null. 화면 표시용이다 — 칸을 비우는 것은 서버가 회차마다 정한다.
   */
  appCountsFrom: string | null
}

/** 화면에 보이는 제목 — 없으면 「제목 미확인」. */
export const externalTitle = (p: Pick<ExternalPost, 'title'>): string => p.title ?? UNTITLED

/** 오류 — 상태 코드를 함께 싣는다(서버 라우트가 그대로 쓴다). */
export interface ExternalProblem {
  status: number
  error: string
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const DATE = /^\d{4}-\d{2}-\d{2}$/
const realDay = (day: string) => DATE.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`)) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day
const SOURCES: ExternalDateSource[] = ['page', 'user', 'unknown']
const REASONS: ExternalRemovedReason[] = ['mistake', 'taken-down']

/** 올린 날 검사 — 형식, 실제 날짜, 오늘(한국) 이후가 아님, 2020년 전이 아님. 괜찮으면 null. */
export function externalDayProblem(day: unknown, today: string): string | null {
  if (typeof day !== 'string' || !DATE.test(day)) return '올린 날은 YYYY-MM-DD 형식이어야 합니다(모르면 null).'
  if (!realDay(day)) return `없는 날짜입니다: ${day}`
  if (day > today) return `올린 날(${day})이 오늘(${today})보다 뒤입니다.`
  if (day < '2020-01-01') return `올린 날(${day})이 너무 이릅니다.`
  return null
}

/** 제목 — 앞뒤 공백을 떼고 200자까지. 비었으면 null. 글자가 아니면 undefined(받지 않는다). */
function titleOf(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t ? t.slice(0, EXTERNAL_TITLE_MAX) : null
}

export interface ExternalAddInput {
  url: string
  key: string
  title: string | null
  publishedOn: string | null
  publishedOnSource: ExternalDateSource
}

/**
 * 적기 요청 검사 — { url, title?, publishedOn, publishedOnSource? }. 올린 날 칸은 꼭 있어야 한다(모르면 null) — 칸이 빠진 요청을
 * 「모름」이나 오늘로 채우지 않는다. 날짜를 주면 그 출처(page · user)도 있어야 한다. 페이지를 다시 읽지 않으므로 제목 · 날짜를 여기서
 * 다시 검사한다.
 */
export function parseExternalAddInput(body: unknown, today = todayKst()): { ok: true; value: ExternalAddInput } | ({ ok: false } & ExternalProblem) {
  if (!isObj(body)) return { ok: false, status: 400, error: '요청 본문이 올바르지 않습니다.' }
  const url = typeof body.url === 'string' ? body.url.trim() : ''
  const check = isArticleUrl(url)
  if (!check.ok) return { ok: false, status: 400, error: ARTICLE_URL_REASON[check.reason] }
  const key = trackingKey(url)
  if (!key) return { ok: false, status: 400, error: ARTICLE_URL_REASON['not-http'] }
  const title = titleOf(body.title)
  if (title === undefined) return { ok: false, status: 400, error: '제목은 글자여야 합니다.' }
  if (!('publishedOn' in body)) return { ok: false, status: 400, error: '올린 날 칸(publishedOn)이 필요합니다 — 모르면 null로 보냅니다.' }
  if (body.publishedOn === null) return { ok: true, value: { url, key, title, publishedOn: null, publishedOnSource: 'unknown' } }
  const problem = externalDayProblem(body.publishedOn, today)
  if (problem) return { ok: false, status: 400, error: problem }
  const source = body.publishedOnSource
  if (source !== 'page' && source !== 'user') return { ok: false, status: 400, error: '올린 날의 출처(publishedOnSource: page · user)가 필요합니다.' }
  return { ok: true, value: { url, key, title, publishedOn: body.publishedOn as string, publishedOnSource: source } }
}

export type ExternalPatch =
  | { kind: 'date'; publishedOn: string | null }
  | { kind: 'remove'; reason: ExternalRemovedReason }
  | { kind: 'restore'; publishedOn?: string | null }

/**
 * 고치기 요청 검사 — { publishedOn } 올린 날 고치기(null이면 모름), { remove: 'mistake' | 'taken-down' } 빼기, { restore: true } 되살리기
 * (올린 날을 함께 고칠 수 있다). 빼기는 다른 칸과 함께 받지 않는다.
 */
export function parseExternalPatch(body: unknown, today = todayKst()): { ok: true; value: ExternalPatch } | ({ ok: false } & ExternalProblem) {
  if (!isObj(body)) return { ok: false, status: 400, error: '요청 본문이 올바르지 않습니다.' }
  const hasDate = 'publishedOn' in body
  if (hasDate && body.publishedOn !== null) {
    const problem = externalDayProblem(body.publishedOn, today)
    if (problem) return { ok: false, status: 400, error: problem }
  }
  const publishedOn = hasDate ? (body.publishedOn as string | null) : undefined
  if (body.remove !== undefined) {
    const reason = REASONS.find((r) => r === body.remove)
    if (!reason) return { ok: false, status: 400, error: '뺀 까닭이 올바르지 않습니다(mistake · taken-down).' }
    if (hasDate || body.restore !== undefined) return { ok: false, status: 400, error: '빼기는 다른 고치기와 함께 하지 않습니다.' }
    return { ok: true, value: { kind: 'remove', reason } }
  }
  if (body.restore !== undefined) {
    if (body.restore !== true) return { ok: false, status: 400, error: 'restore는 true만 받습니다.' }
    return { ok: true, value: { kind: 'restore', ...(publishedOn !== undefined ? { publishedOn } : {}) } }
  }
  if (publishedOn !== undefined) return { ok: true, value: { kind: 'date', publishedOn } }
  return { ok: false, status: 400, error: '바꿀 것이 없습니다(publishedOn · remove · restore).' }
}

/** 올린 날이 추적을 시작한 날보다 뒤인가 — 추적을 시작할 때 이미 글이 있었으므로 그럴 수 없다. 괜찮으면 null. */
export function trackedDayProblem(publishedOn: string | null, trackedAt: string): string | null {
  const tracked = kstDate(trackedAt)
  return publishedOn && tracked && publishedOn > tracked ? `올린 날(${publishedOn})이 추적을 시작한 날(${tracked})보다 뒤입니다.` : null
}

/** 내린 표시만 본 줄 — 파일의 줄 · 화면 줄 · 발행 현황 줄에서 이 모양을 만든다. */
export interface TakedownRowLike {
  id: string
  key: string
  removedAt?: string
  removedReason?: string
}

/**
 * 같은 브랜드 같은 주소에서 이 줄보다 먼저 「글을 내림」으로 뺀 다른 줄의 가장 늦은 내린 날(한국 날짜) — 이 줄은 다시 올린 글이다(C9).
 * 「먼저」는 이 줄을 빼기 전(살아 있는 줄 · 새로 적을 줄이면 모든 내린 줄)이다. 없으면 null.
 */
export function takenDownBefore(rows: readonly TakedownRowLike[], post: { id?: string; key: string; removedAt?: string }): string | null {
  const until = post.removedAt ? Date.parse(post.removedAt) : Number.POSITIVE_INFINITY
  const days = rows
    .filter((r) => r.id !== post.id && r.key === post.key && r.removedReason === 'taken-down' && r.removedAt && Date.parse(r.removedAt) < until)
    .map((r) => kstDate(r.removedAt!))
    .filter((d): d is string => d !== null)
    .sort()
  return days.at(-1) ?? null
}

/**
 * 다시 올린 줄의 올린 날 검사(C9) — 내린 날보다 뒤여야 한다. 비공개를 풀어 다시 올린 글은 페이지 날짜가 처음 올린 날 그대로라, 그 날을
 * 받으면 내린 동안의 측정을 「올라가 있음」으로 센다. 같은 날도 받지 않는다(처음 올린 날과 내린 날이 같은 글을 막으려고 — 같은 날 다시
 * 올렸으면 「날짜 모름」). 올린 날을 모르면(null) 받는다(D3). 괜찮으면 null.
 */
export function repostDayProblem(publishedOn: string | null, downOn: string | null): string | null {
  return publishedOn && downOn && publishedOn <= downOn
    ? `이 브랜드에서 이 주소의 글을 ${downOn}에 내렸다고 적었습니다 — 다시 올린 글의 올린 날(${publishedOn})은 그 뒤여야 합니다. 페이지 날짜가 처음 올린 날이면 다시 올린 날을 고르거나 「날짜 모름」으로 적어 주세요.`
    : null
}

const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)

/**
 * 색인 표시의 신선도 기준일(src/lib/publishStatus.ts freshIndexRecord) — 이 날보다 앞선 확인은 이 줄의 확인이 아니다. 올린 날, 그리고 다시
 * 올린 줄이면 내린 날 다음 날(다시 올린 글은 그 전에 올라갈 수 없다 — repostDayProblem) 가운데 늦은 날. 올린 날을 모르는 다시 올린 줄이
 * 내리기 전 「노출됨 · 색인됨」을 이어받아 곧바로 「확인 끝」이 되지 않게. 둘 다 없으면 null(그대로). 다시 올린 줄의 인용 칸도 이 날을 쓴다(repostBasis).
 */
export function externalIndexBasis(rows: readonly TakedownRowLike[], post: TakedownRowLike & { publishedOn: string | null }): string | null {
  const down = takenDownBefore(rows, post)
  const floor = down ? nextDay(down) : null
  return post.publishedOn && floor ? (post.publishedOn > floor ? post.publishedOn : floor) : (post.publishedOn ?? floor)
}

/**
 * 다시 올린 줄(C9)이 인용을 세기 시작하는 날 — 같은 브랜드 같은 주소에서 이 줄보다 먼저 「글을 내림」으로 뺀 줄이 있을 때만, 그 내린 날(downOn)과
 * 색인 표시와 같은 기준일(countsFrom — externalIndexBasis: 내린 날 다음 날 · 올린 날 가운데 늦은 날). 그보다 앞서 한 측정(measuredBefore)은 이
 * 줄이 세지 않는다 — 그 측정은 내린 줄이 세고(내린 날 측정은 어느 줄도 세지 않는다), 날짜 모름(D3)으로 다시 올린 줄의 칸에도 숫자가 보여 같은 측정이
 * 두 행에 함께 보이지 않게. 서버(server/externalPosts.ts — 회차마다 칸을 비우고 그 까닭을 싣는다)와 성과 표(src/lib/useExternalHistory.ts — 까닭에 적을
 * 내린 날 · 날짜 모름 도움말)가 이 함수를 같이 쓴다. 날짜를 적은 다시 올린 줄은 올린 날이 내린 날 뒤라(repostDayProblem) 그 앞 측정 칸이 이미 「올리기 전」이다. 다시 올린 줄이 아니면 null.
 */
export function repostBasis(rows: readonly TakedownRowLike[], post: TakedownRowLike & { publishedOn: string | null }): { downOn: string; countsFrom: string } | null {
  const downOn = takenDownBefore(rows, post)
  const countsFrom = externalIndexBasis(rows, post)
  return downOn && countsFrom ? { downOn, countsFrom } : null
}

/**
 * 측정(회차 · 주)이 기준일보다 앞인가 — 칸의 전후와 같은 규칙(publishedUrl.ts timingOf에 기준일을 올린 날로 넣어 「올리기 전」): 측정한 마지막 날이
 * 기준일 앞이면, 측정 시각이 없는 옛 기록은 그 주가 기준일의 주 앞이면.
 */
export function measuredBefore(basis: string, window: MeasureWindow | null, weekOf: string): boolean {
  return timingOf(basis, window, weekOf) === 'before'
}

/**
 * 파일 검사 — 모양이 하나라도 틀리면 받지 않는다(서버는 읽지도 쓰지도 않는다 — 빈 목록으로 읽고 덮으면 기록이 통째로 사라진다).
 * 키 규칙이 지금과 다르면 url로 키를 다시 계산한다.
 */
export function parseExternalPostsFile(raw: unknown): { ok: true; posts: ExternalPost[] } | { ok: false; error: string } {
  if (!isObj(raw) || raw.version !== 1 || !Array.isArray(raw.posts)) return { ok: false, error: '형식이 version 1 · posts 배열이 아닙니다.' }
  const rule = typeof raw.keyRule === 'number' ? raw.keyRule : 0
  const posts: ExternalPost[] = []
  for (const r of raw.posts as unknown[]) {
    const label = isObj(r) && typeof r.id === 'string' ? r.id : '(id 없음)'
    if (!isObj(r) || typeof r.id !== 'string' || !EXTERNAL_ID.test(r.id)) return { ok: false, error: `줄 id가 x-<12자>가 아닙니다: ${label}` }
    if (typeof r.url !== 'string' || typeof r.key !== 'string' || typeof r.trackedAt !== 'string' || Number.isNaN(Date.parse(r.trackedAt))) {
      return { ok: false, error: `주소 · 키 · 추적 시작 시각이 틀렸습니다: ${label}` }
    }
    if (!(r.title === null || typeof r.title === 'string')) return { ok: false, error: `제목이 틀렸습니다: ${label}` }
    if (!(r.publishedOn === null || (typeof r.publishedOn === 'string' && realDay(r.publishedOn)))) return { ok: false, error: `올린 날이 틀렸습니다: ${label}` }
    const source = SOURCES.find((s) => s === r.publishedOnSource)
    if (!source || (source === 'unknown') !== (r.publishedOn === null)) return { ok: false, error: `올린 날 출처가 틀렸습니다: ${label}` }
    const removed = r.removedAt !== undefined || r.removedReason !== undefined
    const reason = REASONS.find((x) => x === r.removedReason)
    if (removed && (typeof r.removedAt !== 'string' || Number.isNaN(Date.parse(r.removedAt)) || !reason)) return { ok: false, error: `뺀 표시가 틀렸습니다: ${label}` }
    // 모르는 칸은 그대로 둔다 — 뒤 판이 더한 칸을 이 판이 다시 쓰면서 지우지 않게(원장 readFileOnly와 같다).
    posts.push({ ...(r as unknown as ExternalPost), key: rule === KEY_RULE ? r.key : (trackingKey(r.url) ?? r.key) })
  }
  return { ok: true, posts }
}

/** 원장 줄에서 이 규칙이 보는 값(server/publishedPosts.ts PublishedPost · src/lib/api.ts PublishedPost 모두 이 모양을 가진다). */
export interface LedgerRowLike {
  key: string
  recordedAt: string
  publishedOn?: string | null
  removedAt?: string
  removedReason?: string
}

/**
 * 같은 브랜드 원장에서 이 주소를 앱 글로 가진 줄 — 살아 있거나 「글을 내렸어요」로 뺀 줄(옛 기록 포함). 「잘못 적음」은 이기지 않는다.
 * 성과 표 shownPosts(server/publishedHistory.ts)와 같은 기준 — 그 줄은 앱 글 표에 보인다. 등록 거절 · 되살리기 거절 · 쉼이 모두 이것을 쓴다.
 */
export function ledgerWinners<T extends LedgerRowLike>(ledger: readonly T[], key: string): T[] {
  return ledger.filter((p) => p.key === key && (!p.removedAt || p.removedReason === 'taken-down'))
}

/**
 * 원장이 이긴 주소의 옮긴 날(가장 이른 줄을 적은 한국 날짜)과 앱 글 표가 세기 시작하는 날(이긴 줄의 가장 이른 올린 날 — 기록일과 섞지
 * 않는다: 앱 글 표는 올린 날로 센다). 이긴 줄이 없으면 null.
 */
export function appTakeover(ledger: readonly LedgerRowLike[], key: string): { movedOn: string | null; appCountsFrom: string | null } | null {
  const winners = ledgerWinners(ledger, key)
  if (winners.length === 0) return null
  const recorded = winners.map((p) => kstDate(p.recordedAt)).filter((d): d is string => d !== null)
  const movedOn = recorded.sort()[0] ?? null
  const starts = winners.map((p) => p.publishedOn).filter((d): d is string => typeof d === 'string' && realDay(d)).sort()
  return { movedOn, appCountsFrom: starts[0] ?? null }
}

/** 파일의 줄 → 화면 줄(상태 · 옮긴 날). 뺀 줄이 먼저다 — 원장이 이겼어도 사람이 뺀 줄은 「뺌」이다. */
export function externalViews(posts: readonly ExternalPost[], ledger: readonly LedgerRowLike[]): ExternalPostView[] {
  return posts.map((p) => {
    const takeover = appTakeover(ledger, p.key)
    const state: ExternalState = p.removedAt ? 'removed' : takeover ? 'moved' : 'live'
    return { ...p, state, movedOn: takeover?.movedOn ?? null, appCountsFrom: takeover?.appCountsFrom ?? null }
  })
}

/**
 * 고른 브랜드에 이 주소를 앱 밖 글로 적어도 되는가(D13) — 고른 브랜드의 원장만 막는다(blocked). 다른 브랜드에 앱 글로 적힌 주소는 막지
 * 않고 그 브랜드들(appIn)을 알린다(「같은 주소: ○○의 앱 글」). 화면 · 서버 · 시험이 이 함수 하나를 쓴다.
 */
export function externalRegistrationCheck(
  tenantId: string,
  key: string,
  ledgers: readonly { tenantId: string; posts: readonly LedgerRowLike[] }[],
): { blocked: boolean; appIn: string[] } {
  const holders = ledgers.filter((l) => ledgerWinners(l.posts, key).length > 0).map((l) => l.tenantId)
  return { blocked: holders.includes(tenantId), appIn: [...new Set(holders.filter((id) => id !== tenantId))] }
}

/** 원장이 이겨 거절할 때의 문구 — 살아 있는 앱 글이 없고 내린 줄만 있으면 그렇게 알린다(C5). */
export function ledgerWinsMessage(winners: readonly LedgerRowLike[]): string {
  return winners.some((p) => !p.removedAt)
    ? '이 주소는 이미 이 브랜드의 앱 글로 적혀 있습니다 — 앱 글 표(올린 글 인용 추적)에서 봅니다.'
    : '이 주소는 이 브랜드의 앱 글로 적었다가 내린 기록이 있습니다 — 그 기록을 「잘못 적음」으로 빼야 앱 밖 글로 적을 수 있습니다.'
}

/** 인용 계산(getPublishedHistory)에 넘기는 원장 모양. 앱 글 화면에는 나가지 않는다 — 앱 밖 글 이력 응답에만 실린다. */
export interface LedgerShapedPost {
  id: string
  url: string
  key: string
  publishedOn: string | null
  /** 늘 'legacy' — 누른 시각이 올린 시각인 기록이 아니다(publishedUrl.ts postedAtOf가 null을 준다). */
  publishedOnSource: 'legacy'
  recordedAt: string
  articleId: string
  targetActionId: string
  via: 'direct'
  articleTitle: string
  removedAt?: string
  removedReason?: ExternalRemovedReason
}

/**
 * 앱 밖 줄 → 인용 계산용 원장 모양(C7).
 *   - 올린 시각을 싣지 않는다: publishedOnSource 'legacy'라 같은 날 측정은 전후 불명(during)이다. 추적 시작 시각은 recordedAt에만 둔다
 *     (다시 올린 줄을 가르는 데 쓴다 — publishedUrl.ts postedAtIndex).
 *   - 사람이 「글을 내림」 · 「잘못 적음」으로 뺀 표시는 그대로 넘긴다(인용 계산이 내린 뒤 칸을 비우고, 잘못 적은 줄은 이력에서 뺀다).
 *   - 앱 글로 옮긴 것은 여기서 끊지 않는다 — 앱 글 표가 세는 회차만 서버가 비운다(D12, server/externalPosts.ts getExternalHistory).
 */
export function externalAsLedgerPost(post: ExternalPostView): LedgerShapedPost {
  const base: LedgerShapedPost = {
    id: post.id,
    url: post.url,
    key: post.key,
    publishedOn: post.publishedOn,
    publishedOnSource: 'legacy',
    recordedAt: post.trackedAt,
    articleId: `external:${post.id}`,
    targetActionId: 'external',
    via: 'direct',
    articleTitle: externalTitle(post),
  }
  return post.removedAt && post.removedReason ? { ...base, removedAt: post.removedAt, removedReason: post.removedReason } : base
}
