/**
 * 색인 자동 확인 — 발행 현황의 구글 색인 칸을 SerpAPI 구글 검색(site:)으로 대신 본다(실행기: server/indexAuto.ts, 공용 연결:
 * server/serpApi.ts, 적기: server/indexChecks.ts writeIndexCheck). 순수 함수만 둔다 — 서버와 화면이 같은 규칙을 쓴다.
 * 2026-11-10 설계 「색인 자동 확인」(결정 D1–D13 권장안 · 비평 K1–K19) + 사용자 변경(구글만 · 14일째 차례와 자동 「아직」뿐인 글의
 * 30일째만 자동 · 3 · 7일째는 직접 · 단추를 눌러야 돈다).
 *
 * ── 무엇을 자동으로 보나 ──────────────────────────────────────────────────────
 * 구글 칸이 14일째 차례인 글(14일 지남 포함 — 차례 날은 14일째 그대로)과, 14일째를 지나 마지막 확인이 자동 「아직」뿐인 글의 30일째 한 번 더.
 * 3 · 7일째 차례는 사람이 본다(manual로 센다). 네이버 칸은 자동이 보지도 쓰지도 않는다. 같은 주소 키는 검색 1번 — 대표 줄(구글이 자동
 * 차례인 줄 가운데 앱 글 줄 먼저, 다음 앱 밖 글 줄, 같으면 설정 순 첫 브랜드)에 적고, 주소 키로 모든 줄에 보인다(findIndexRecord).
 *
 * ── 차례 단위 시도(D11) ─────────────────────────────────────────────────────
 * 차례 id = (주소 키, 'd14:'+14일째 날) · (주소 키, 'd30:'+30일째 날). 같은 차례에서 찾음 · 못 찾음(적었든 건너뛰었든) · 결정적 못 가림
 * (similar-many · other-url · corrected · naver-form)은 1회로 끝, 일시 못 가림(timeout · upstream · parse · interrupted)은 합계 2회까지.
 * 실행을 멈춘 오류(키 · 한도 · 계정 · 장부 등)와 보내지 않은 시도는 세지 않는다. 모르는 결과 · 까닭(나중 판)은 끝으로 본다(돈이 덜 드는 쪽).
 *
 * ── 판정(D3 A · D12) ────────────────────────────────────────────────────────
 * 결과 링크(organic_results[].link만 — sitelinks · 광고는 안 봄)를 trackingKey로 맞춘다. 같은 주소면 「색인됨」, 검색이 성공했고 덜 찬 쪽에 같은
 * 주소가 없으면 「아직 · 자동」. 그 밖(오류 · 모양 이상 · 자동 교정 · 비슷한 주소가 많음 · ?…만 다른 주소 · 네이버 블로그 글 못 찾음)은
 * 「자동으로 못 가림」 — 아무것도 적지 않는다(짐작하지 않는다).
 *
 * ── 사람 표시가 먼저(D4 A) ──────────────────────────────────────────────────
 * 「색인됨」인 칸은 차례가 아니다(recheckOf done). 원본(신선도로 거르기 전) 최신 기록이 「색인됨」인 주소 — 다른 줄 · 앞선 올림에서 색인됨으로
 * 본 주소 — 는 자동이 건드리지 않고 사람에게 남긴다(shownElsewhere — 설계는 「찾으면 적는다」였으나, 적으면 그 사람 「색인됨」이 가장 나중
 * 기록에서 밀려나므로 더 조심스러운 쪽을 골랐다). 쓸 때는 계획 때 본 원본 기록의 구글 확인 시각(expectRawCheckedAt)과 같아야 적는다(CAS).
 *
 * 서버가 import하므로 상대 import는 .js로 쓰고, 화면 모듈은 끌어오지 않는다.
 */
import { addDays, findIndexRecord, recheckOf, rowName, type IndexCheck, type PlatformKey, type PublishStatusRow, type RowOrigin, type TenantChecks } from './publishStatus.js'
import { matchKind, TRACKING_PARAM, trackingKey } from './publishedUrl.js'

export const INDEX_AUTO_FORMAT = 'index-auto/1'
/** 자동으로 보는 차례 — 14일째(RECHECK_DAYS의 마지막). 3 · 7일째는 사람이 본다. */
export const AUTO_TURN_DAY = 14
/** 마지막 확인이 자동 「아직」뿐인 글을 한 번 더 보는 날. */
export const AUTO_LATE_DAY = 30
export const RUN_CAP_DEFAULT = 40
export const RUN_CAP_MAX = 200
/** 일시 못 가림은 한 차례에 합계 이 횟수까지. */
export const TRANSIENT_LIMIT = 2

/** 구글 검색 매개변수 — 사람이 한국에서 보는 구글과 같게(google.co.kr · gl=kr · hl=ko), 자동 교정 빼기(nfpr) · 비슷한 결과 숨기지 않기(filter). */
export const GOOGLE_SEARCH_PARAMS = { engine: 'google', google_domain: 'google.co.kr', gl: 'kr', hl: 'ko', nfpr: '1', filter: '0' } as const
/** 검색은 성공했고 결과가 0건일 때 SerpAPI가 주는 문구(정확히 이 글자일 때만 「0건」으로 읽는다). */
export const GOOGLE_NO_RESULTS = "Google hasn't returned any results for this query."
/** 자동 교정 없이 그대로 찾았다는 organic_results_state 값 — 다른 값이면 교정된 결과로 본다(값이 없으면 보지 않는다). */
export const EXACT_SPELLING = 'Results for exact spelling'
/** 한 쪽 결과 수 — 이만큼 차면 site: 접두어 일치가 다른 글(/2 → /20 · /21…)을 함께 잡아 2쪽에 우리 글이 있을 수 있다. */
const PAGE_SIZE = 10
const QUERY_MAX = 1500

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// ── 검색어 ───────────────────────────────────────────────────────────────────

/** 자동으로 찾지 않는 까닭 — platform 유튜브 · 인스타그램, query 추적 질의를 떼고도 질의가 남음(site:로 못 가림), form 주소 모양. */
export type QueryRefusal = 'platform' | 'query' | 'form'
export type SiteQuery = { ok: true; q: string } | { ok: false; reason: QueryRefusal }

/** 등록 주소의 경로 그대로(퍼센트 인코딩 · 한글 원문 그대로) — 질의 · 해시 · 끝 슬래시만 뗀다. */
function registeredPath(url: string): string {
  const rest = url.trim().replace(/^https?:\/\//i, '')
  const cut = rest.search(/[/?#]/)
  if (cut < 0) return ''
  return rest.slice(cut).replace(/#.*$/, '').replace(/\?.*$/, '').replace(/\/+$/, '')
}

const siteOr = (forms: string[]): SiteQuery => {
  const q = forms.map((f) => `site:${f}`).join(' OR ')
  return q.length > QUERY_MAX ? { ok: false, reason: 'form' } : { ok: true, q }
}

/**
 * 구글 site: 검색어 — 사람이 「구글에서 확인」으로 여는 검색과 같은 모양. 티스토리는 /m/ 모바일 주소로도 색인될 수 있어 두 모양을, 네이버
 * 블로그는 /아이디/글번호로(PostView 모양으로 적은 글도) blog · m.blog 두 모양을, www가 붙은 주소는 www 있는 · 없는 두 모양을 OR로 묻는다.
 * 경로가 붙은 site: · OR · 한글 경로의 동작은 실제 키 시험 전이라 [모름] — 판정이 정확한 주소 키로만 「색인됨」을 적으므로 틀려도 「색인됨」을
 * 잘못 적지는 않는다.
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

/** SerpAPI에 보내는 매개변수(키는 server/serpApi.ts가 붙인다). num · start · no_cache · async는 보내지 않는다. */
export function googleSearchParams(q: string): Record<string, string> {
  return { ...GOOGLE_SEARCH_PARAMS, q }
}

// ── 판정 ─────────────────────────────────────────────────────────────────────

/** 자동으로 못 가린 까닭 — 결정적(차례당 1회) · 일시(차례당 합계 2회). */
export type DecisiveReason = 'similar-many' | 'other-url' | 'corrected' | 'naver-form'
export type TransientReason = 'timeout' | 'upstream' | 'parse' | 'interrupted'
export type AutoReason = DecisiveReason | TransientReason

export type Judgement =
  | { outcome: 'found'; matched: string; results: number; organicState: string | null }
  | { outcome: 'not-found'; results: number; organicState: string | null }
  | { outcome: 'unknown'; reason: DecisiveReason | 'upstream' | 'parse'; results: number | null; organicState: string | null; matched?: string }

const linkText = (s: string) => s.slice(0, 500)

/**
 * HTTP 200 응답 한 건의 판정. 위에서부터 처음 맞는 줄로 정한다: 메타 없음 → parse, status가 Success 아님 → upstream, 오류 글자가 빈 결과 문구와
 * 다름 → upstream, 빈 결과 문구 → 못 찾음(0건), organic_results가 배열 아님 → parse(「0건」으로 읽지 않는다), 자동 교정 → corrected, 같은 주소 →
 * 찾음, ?…만 다른 주소 → other-url, 쪽이 참 · 다음 쪽 → similar-many, 그 밖 → 못 찾음. 네이버 블로그 글의 「못 찾음」은 구글 색인 모양을
 * 확인하기 전까지 naver-form(D12).
 */
export function judgeGoogle(rowKey: string, platform: PlatformKey | null, json: unknown): Judgement {
  if (!isObj(json) || !isObj(json.search_metadata)) return { outcome: 'unknown', reason: 'parse', results: null, organicState: null }
  const info = json.search_information
  const organicState = isObj(info) && typeof info.organic_results_state === 'string' ? info.organic_results_state.slice(0, 120) : null
  if (json.search_metadata.status !== 'Success') return { outcome: 'unknown', reason: 'upstream', results: null, organicState }
  const notFound = (results: number): Judgement =>
    platform === 'naver-blog' ? { outcome: 'unknown', reason: 'naver-form', results, organicState } : { outcome: 'not-found', results, organicState }
  if (json.error !== undefined) return json.error === GOOGLE_NO_RESULTS ? notFound(0) : { outcome: 'unknown', reason: 'upstream', results: null, organicState }
  if (!Array.isArray(json.organic_results)) return { outcome: 'unknown', reason: 'parse', results: null, organicState }
  const results = json.organic_results.length
  if (organicState !== null && organicState !== EXACT_SPELLING) return { outcome: 'unknown', reason: 'corrected', results, organicState }
  const links = json.organic_results.flatMap((r) => (isObj(r) && typeof r.link === 'string' ? [r.link] : []))
  const exact = links.find((l) => trackingKey(l) === rowKey)
  if (exact) return { outcome: 'found', matched: linkText(exact), results, organicState }
  const variant = links.find((l) => {
    const k = trackingKey(l)
    return k !== null && matchKind(rowKey, k) === 'query-variant'
  })
  if (variant) return { outcome: 'unknown', reason: 'other-url', matched: linkText(variant), results, organicState }
  const next = (p: unknown) => isObj(p) && p.next !== undefined && p.next !== null
  if (results >= PAGE_SIZE || next(json.serpapi_pagination) || next(json.pagination)) return { outcome: 'unknown', reason: 'similar-many', results, organicState }
  return notFound(results)
}

// ── 차례 ─────────────────────────────────────────────────────────────────────

export type AutoTier = 'day14' | 'day30'
export interface AutoTurn {
  tier: AutoTier
  /** 차례 id — 같은 주소 키 안에서 이 값이 같으면 같은 차례다. */
  turn: string
  /** 차례 날(14일째 · 30일째). */
  since: string
}

type TurnRow = Pick<PublishStatusRow, 'kind' | 'removed' | 'publishedOn' | 'google'> & { recheckFrom?: string | null }

/** 다시 볼 날을 세는 날 — rowRecheck와 같은 기준(앱 밖 줄은 recheckFrom). */
const fromOf = (row: TurnRow) => (row.recheckFrom === undefined ? row.publishedOn : row.recheckFrom)

/**
 * 줄의 구글 자동 차례 — 14일째 차례(14일 지남 포함)이거나, 14일째를 지나 보이는 구글 기록이 자동 「아직」이고 30일째가 왔는데 그 뒤 확인이 없을
 * 때. 사람 기록이 마지막이면 30일째도 아니다(사람이 이미 봤다). 아니면 null.
 */
export function autoTurnOf(row: TurnRow, today: string): AutoTurn | null {
  if (row.kind !== 'posted' || row.removed) return null
  const from = fromOf(row)
  if (!from) return null
  const r = recheckOf(from, row.google, today)
  const day14 = addDays(from, AUTO_TURN_DAY)
  if (r.kind === 'due') return r.since === day14 ? { tier: 'day14', turn: `d14:${day14}`, since: day14 } : null
  if (r.kind !== 'over') return null
  const day30 = addDays(from, AUTO_LATE_DAY)
  const g = row.google
  return g && g.source === 'auto' && g.state === 'not-yet' && g.checkedOn < day30 && today >= day30 ? { tier: 'day30', turn: `d30:${day30}`, since: day30 } : null
}

/** 구글이 3 · 7일째 차례인 줄 — 자동이 보지 않고 사람이 본다. */
export function manualTurnOf(row: TurnRow, today: string): boolean {
  if (row.kind !== 'posted' || row.removed) return false
  const from = fromOf(row)
  if (!from) return false
  const r = recheckOf(from, row.google, today)
  return r.kind === 'due' && r.since !== addDays(from, AUTO_TURN_DAY)
}

// ── 차례 단위 시도(D11) ─────────────────────────────────────────────────────

const DECISIVE = new Set<string>(['similar-many', 'other-url', 'corrected', 'naver-form'])
const TRANSIENT = new Set<string>(['timeout', 'upstream', 'parse', 'interrupted'])
/** 실행을 멈춘 오류 · 우리 쪽 검사 — 그 글의 차례 몫에 넣지 않는다. */
const STOP = new Set<string>(['no-key', 'config', 'key', 'forbidden', 'quota-month', 'rate-hour', 'bad-request', 'ledger', 'account', 'feature-cap', 'floor', 'hour', 'write'])

export const isDecisiveReason = (reason: string | undefined) => reason !== undefined && DECISIVE.has(reason)
export const isTransientReason = (reason: string | undefined) => reason !== undefined && TRANSIENT.has(reason)

/** 시도 기록에서 차례 규칙이 보는 값(server/indexAuto.ts index-auto.json attempts). */
export interface AttemptLike {
  key: string
  turn: string
  /** pending · found · not-found · unknown · not-sent(우리 쪽에서 보내지 않음) — 모르는 값도 받는다. */
  outcome: string
  reason?: string
}

/** 시도 하나가 차례에 미치는 것 — 끝냄 · 일시 1회 · 안 셈. */
function attemptWeight(a: AttemptLike): 'settles' | 'transient' | 'ignored' {
  if (a.outcome === 'not-sent') return 'ignored'
  if (a.outcome === 'pending') return 'transient'
  if (a.outcome === 'unknown' && a.reason !== undefined) {
    if (STOP.has(a.reason)) return 'ignored'
    if (TRANSIENT.has(a.reason)) return 'transient'
  }
  return 'settles'
}

export interface TurnProgress {
  /** 이 차례에는 다시 찾지 않는다. */
  settled: boolean
  /** 이 차례의 일시 못 가림 수. */
  transient: number
}

/** 한 주소 키 · 한 차례의 시도 상황. */
export function turnProgress(attempts: readonly AttemptLike[], key: string, turn: string): TurnProgress {
  let settled = false
  let transient = 0
  for (const a of attempts) {
    if (a.key !== key || a.turn !== turn) continue
    const w = attemptWeight(a)
    if (w === 'settles') settled = true
    else if (w === 'transient') transient += 1
  }
  return { settled: settled || transient >= TRANSIENT_LIMIT, transient }
}

// ── 대상 고르기 ──────────────────────────────────────────────────────────────

export interface AutoTarget {
  key: string
  /** 대표 줄 — 결과를 적는 곳. */
  tenantId: string
  postId: string
  origin: RowOrigin
  rowName: string
  url: string
  platform: PlatformKey | null
  tier: AutoTier
  turn: string
  since: string
  /** first 이 차례 첫 시도, retry 일시 못 가림 뒤 두 번째 시도. */
  batch: 'first' | 'retry'
  query: string
  /** CAS 기준값 — 원본(신선도로 거르기 전) 최신 기록의 구글 확인 시각. 쓸 때 같아야 적는다. */
  expectRawCheckedAt: string | null
}

export interface AutoUnsupported {
  key: string
  rowName: string
  reason: QueryRefusal
}

export interface AutoPlan {
  /** 묶음 순서: 14일째 첫 시도 → 30일째 첫 시도 → 두 번째 시도, 같은 묶음에서는 차례 날이 이른 것부터(같으면 주소 키 순). */
  targets: AutoTarget[]
  /** 3 · 7일째 차례라 사람이 보는 주소 수. */
  manual: number
  /** 자동으로 안 찾는 주소. */
  unsupported: AutoUnsupported[]
  /** 이번 차례에 자동으로 못 가려 다시 찾지 않는 주소 수(결정적 1회 · 일시 2회). */
  settled: number
  /** 원본 최신 기록이 「색인됨」이라 자동이 건드리지 않는 주소 수(직접 확인). */
  shownElsewhere: number
}

export interface AutoPlanInput {
  rows: readonly PublishStatusRow[]
  today: string
  /** 모든 고객 브랜드의 확인 기록(발행 현황과 같은 순간에 읽은 것) — CAS 기준값을 셈한다. */
  checks: readonly TenantChecks[]
  attempts: readonly AttemptLike[]
  /** 고객 브랜드 설정 순 — 대표 줄을 정할 때. */
  tenantOrder: readonly string[]
}

type LiveRow = PublishStatusRow & { key: string; postId: string; url: string }

const BATCH_RANK = { 'first:day14': 0, 'first:day30': 1, 'retry:day14': 2, 'retry:day30': 2 } as const

/** 오늘 자동으로 볼 주소들 — 주소 키마다 하나(대표 줄 · 차례), 같은 키의 줄은 검색 1번. */
export function planAutoTargets(input: AutoPlanInput): AutoPlan {
  const { today, attempts } = input
  const order = (tenantId: string) => {
    const i = input.tenantOrder.indexOf(tenantId)
    return i < 0 ? input.tenantOrder.length : i
  }
  const byRank = (a: LiveRow, b: LiveRow) =>
    (a.origin === 'app' ? 0 : 1) - (b.origin === 'app' ? 0 : 1) || order(a.tenantId) - order(b.tenantId) || (a.postId < b.postId ? -1 : a.postId > b.postId ? 1 : 0)
  const byKey = new Map<string, LiveRow[]>()
  for (const r of input.rows) {
    if (r.kind !== 'posted' || r.removed || !r.key || !r.postId || !r.url) continue
    byKey.set(r.key, [...(byKey.get(r.key) ?? []), r as LiveRow])
  }
  const plan: AutoPlan = { targets: [], manual: 0, unsupported: [], settled: 0, shownElsewhere: 0 }
  for (const [key, rows] of byKey) {
    const turns = rows.map((r) => ({ r, t: autoTurnOf(r, today) }))
    let chosen: { rep: LiveRow; turn: AutoTurn; batch: 'first' | 'retry' } | null = null
    let any = false
    for (const tier of ['day14', 'day30'] as const) {
      const cands = turns.filter((x): x is { r: LiveRow; t: AutoTurn } => x.t?.tier === tier).sort((a, b) => byRank(a.r, b.r))
      const top = cands[0]
      if (!top) continue
      any = true
      const progress = turnProgress(attempts, key, top.t.turn)
      if (progress.settled) continue
      chosen = { rep: top.r, turn: top.t, batch: progress.transient > 0 ? 'retry' : 'first' }
      break
    }
    if (!any) {
      if (rows.some((r) => manualTurnOf(r, today))) plan.manual += 1
      continue
    }
    if (!chosen) {
      plan.settled += 1
      continue
    }
    const { rep, turn, batch } = chosen
    const query = googleSiteQuery(rep.url, rep.platform?.key ?? null)
    if (!query.ok) {
      plan.unsupported.push({ key, rowName: rowName(rep), reason: query.reason })
      continue
    }
    const own = input.checks.find((c) => c.tenantId === rep.tenantId) ?? { tenantId: rep.tenantId, checks: {} }
    const raw: IndexCheck | null =
      findIndexRecord(
        own,
        input.checks.filter((c) => c.tenantId !== rep.tenantId),
        [rep.postId],
        key,
      )?.record.google ?? null
    if (raw?.state === 'shown') {
      plan.shownElsewhere += 1
      continue
    }
    plan.targets.push({
      key,
      tenantId: rep.tenantId,
      postId: rep.postId,
      origin: rep.origin,
      rowName: rowName(rep),
      url: rep.url,
      platform: rep.platform?.key ?? null,
      tier: turn.tier,
      turn: turn.turn,
      since: turn.since,
      batch,
      query: query.q,
      expectRawCheckedAt: raw?.checkedAt ?? null,
    })
  }
  plan.targets.sort(
    (a, b) =>
      BATCH_RANK[`${a.batch}:${a.tier}`] - BATCH_RANK[`${b.batch}:${b.tier}`] || (a.since < b.since ? -1 : a.since > b.since ? 1 : 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  )
  return plan
}

// ── 몫 ───────────────────────────────────────────────────────────────────────

/** 공용 연결의 지금 몫(server/serpApi.ts SerpAllowance에서 쓰는 칸). */
export interface AllowanceLike {
  featureLeft: number
  aboveFloor: number
  hourLeft: number
  /** 셋의 최솟값, 계정이 막으면 0. */
  allowed: number
}
export type PlanLimit = 'run-cap' | 'feature-cap' | 'floor' | 'hour' | 'account'

/**
 * 이번에 검색할 수 = min(대상, 한 번 상한, 이번 결제 주기 색인 몫 남음, 계정 바닥 위 남은 수, 이번 시간 남은 수), 0 아래면 0. 계정 · 몫을 모르면
 * (allowance null) 0이다 — 남은 검색을 모르고 쓰지 않는다. limitedBy는 대상보다 적게 만든 까닭(가장 작은 것).
 */
export function planSearches(candidates: number, runCap: number, allowance: AllowanceLike | null): { searches: number; limitedBy: PlanLimit | null } {
  if (candidates <= 0) return { searches: 0, limitedBy: null }
  if (!allowance) return { searches: 0, limitedBy: 'account' }
  const bounds: [PlanLimit, number][] = [
    ['run-cap', runCap],
    ['feature-cap', allowance.featureLeft],
    ['floor', allowance.aboveFloor],
    ['hour', allowance.hourLeft],
    ['account', allowance.allowed],
  ]
  let searches = candidates
  let limitedBy: PlanLimit | null = null
  for (const [kind, n] of bounds) {
    const v = Math.max(0, Math.floor(n))
    if (v < searches) {
      searches = v
      limitedBy = kind
    }
  }
  return { searches, limitedBy }
}

// ── 문구 ─────────────────────────────────────────────────────────────────────

/** 줄마다 보이는 「자동으로 못 가림」 · 「자동으로 안 찾음」 까닭. 실행을 멈춘 까닭은 그때 오류 글(server/serpApi.ts)을 쓴다. */
export const AUTO_REASON_TEXT: Record<string, string> = {
  'similar-many': '비슷한 주소가 많아 이 글을 가리지 못했어요 — 직접 확인해 주세요.',
  'other-url': '주소 뒤에 ?…만 다른 주소로 나왔어요 — 직접 확인해 주세요.',
  corrected: '구글이 검색어를 고쳐 보여 줘서 가리지 못했어요 — 직접 확인해 주세요.',
  'naver-form': '네이버 블로그 글은 구글이 어떤 주소로 색인하는지 아직 확인 중이라, 못 찾았을 때는 적지 않아요 — 직접 확인해 주세요.',
  timeout: 'SerpAPI가 시간 안에 답하지 않았어요 — 다음에 한 번 더 찾아요.',
  upstream: 'SerpAPI 응답 오류로 가리지 못했어요 — 다음에 한 번 더 찾아요.',
  parse: '검색 결과 모양을 읽지 못했어요 — 다음에 한 번 더 찾아요.',
  interrupted: '확인하는 사이 앱이 꺼져 결과를 받지 못했어요 — 다음에 한 번 더 찾아요.',
  platform: '유튜브 · 인스타그램 글은 자동으로 찾지 않아요 — 직접 확인해 주세요.',
  query: '주소에 질의(?…)가 남아 site: 검색으로 가릴 수 없어요 — 직접 확인해 주세요.',
  form: '주소 모양이 자동 검색에 맞지 않아요 — 직접 확인해 주세요.',
}

export function autoReasonText(reason: string | undefined): string {
  return (reason !== undefined ? AUTO_REASON_TEXT[reason] : undefined) ?? '알 수 없는 까닭으로 가리지 못했어요 — 직접 확인해 주세요.'
}
