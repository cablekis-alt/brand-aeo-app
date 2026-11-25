import type { WeeklyScorecard } from '../prompts/b8-report'
import { comparableRun, compareConditions, runCountText, type ConditionChange } from './comparability'
import { ENGINE_LABEL, OWNER_TYPE_LABEL, weekLabel } from './format'
import { isScoredAgnostic, withoutProbes } from './questionScope'
import type { PublishedHistory } from './api'
import type { CitationBreakdownRow, QuestionBank, QuestionRepeatAnalysis } from './types'

/**
 * 측정 신뢰도 점검 · 같은 주 코호트 비교 · 이 브랜드 응답 요약 — 정기진단 보고서(src/pages/PeriodicReport.tsx)의 절들이 쓴다.
 *
 * 모든 문장은 코드 템플릿이고 수치는 저장된 측정값 그대로다(LLM이 쓰지 않는다). 손으로 쓴 검토 문서(옥수 본 정형외과 W40)에서
 * 가장 값진 부분은 숫자가 아니라 **그 숫자를 믿어도 되는지**였다 — 병원마다 질문지가 달랐고, 한 번만 쟀고, 사실성 「틀림」이
 * 판정 오류였다. 그 점검(trustChecks)은 운영자 상자로 둔다.
 *
 * 예전에는 따로 「검토 리포트」 상자와 공유용 HTML 파일이었다. 보고서 본문 한가운데에 끼어 같은 값을 두세 번, 다른 이름 · 단위로
 * 보였고, 고객에게 쓸모 있는 내용(불린 질문 · 출처 · Site AEO 영역)은 HTML에만 있었다. 2026-10-25 본문 절로 합치고 HTML은 없앴다 —
 * 고객 문서는 정기진단 보고서 인쇄 · PDF 하나다.
 */

export type CheckStatus = 'ok' | 'warn' | 'review'

export interface TrustCheck {
  id: string
  label: string
  status: CheckStatus
  detail: string
}

export interface CohortRow {
  tenantId: string
  brandName: string
  isSelf: boolean
  /** 저장된 순위 비교 목록의 점수 — 그래프 아래 코호트 순위와 같은 값 · 같은 분모. */
  score: number
  position: number
  tied: boolean
  /** 그 주 기록을 읽은 브랜드만 값이 있다. 읽지 못하면 null — 「확인 불가」로 보인다(0으로 채우지 않는다). */
  mentionRate: number | null
  ownedRate: number | null
  /** 평균 추천 순위와 순위 응답 수 — 점수 가중치 15인 지표(표기는 formatRankWithCount). */
  avgRank: number | null
  rankedResponses: number | null
  /** 이 브랜드와 같은 일반 질문을 받았는지. 기록이나 은행을 읽지 못하면 null. */
  sameQuestions: boolean | null
  /** 그 주 기록을 읽었는지. */
  loaded: boolean
}

export interface CategoryRow {
  category: string
  label: string
  mentioned: number
  total: number
}

export interface MentionedQuestion {
  text: string
  engines: string[]
}

export interface CitationRow {
  domain: string
  owner: string
  count: number
  isOwned: boolean
}

/** 이 브랜드의 그 주 응답 요약 — 판정 기록과 그 주 질문 은행에서 센다. */
export interface SelfReview {
  /** 이름 없이 물은 질문(일반 질문) — 질문 수 · 응답 수 · 불린 응답 수 · 되물은 응답 수. */
  general: { questions: number; responses: number; mentioned: number; clarifying: number }
  mentionedQuestions: MentionedQuestion[]
  categories: CategoryRow[]
  /** 「틀림」 판정 주장 — 질문 · 엔진 · AI가 말한 값 · 등록된 값. 사람이 원문을 보고 판정 오류인지 가린다. */
  contradicted: { question: string; engine: string; said: string; registered: string }[]
}

const CATEGORY_LABEL: Record<string, string> = {
  'brand-direct': '브랜드 직접',
  comparison: '비교',
  'price-spec': '가격·사양',
  'local-regional': '지역',
  'troubleshooting-review': '후기·문제 해결',
}

/** 되물은 응답이 이 비율을 넘으면 질문에 조건(지역 등)이 모자란다고 본다 — 옥수 본 1차는 27건 중 19건. */
const CLARIFYING_WARN = 0.2

const pct = (v: number) => `${(v * 100).toFixed(1)}%`
const engineText = (c: WeeklyScorecard) => (c.enginesUsed ?? []).map((e) => ENGINE_LABEL[e] ?? e).join(' · ') || '기록 없음'

/**
 * 은행의 일반 질문(브랜드 이름 없는 질문) 텍스트 집합. 은행이 없으면 null. 실증 질문은 넣지 않는다 — 점수에 세지 않는 문항이라,
 * 넣으면 실증을 덧붙인 브랜드만 코호트 다른 브랜드와 「같은 질문」이 아니게 된다(server/portfolio.ts와 같은 규칙).
 */
function generalQuestionTexts(bank: QuestionBank | null | undefined): Set<string> | null {
  if (!bank) return null
  return new Set(bank.questions.filter(isScoredAgnostic).map((q) => q.text.trim()))
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x))
}

/** 표준 경쟁 랭킹(1-2-2-4) — 코호트 순위와 같은 규칙. */
function positionOf(score: number, all: number[]): { position: number; tied: boolean } {
  return { position: all.filter((s) => s > score).length + 1, tied: all.filter((s) => s === score).length > 1 }
}

/**
 * 같은 주 코호트 비교 줄.
 *
 * 줄과 순위는 **저장된 순위 비교 목록**(card.cohortRank.members)에서 낸다 — 그래프 아래 「공동 2/7」과 같은 분모다. 예전에는 읽어 온
 * 카드로 다시 셌는데, 그 주 기록을 못 읽은 브랜드가 조용히 빠져 분모가 줄고 순위가 오를 수 있었다. 이제 그런 브랜드도 줄에 남기고
 * 점수 밖의 칸만 「확인 불가」로 둔다. 목록이 없는 옛 카드(v0.1.44 이전)는 읽은 카드로 센다.
 */
export function cohortRows(
  card: WeeklyScorecard,
  members: WeeklyScorecard[],
  banks: Record<string, QuestionBank | null>,
): CohortRow[] {
  const byId = new Map([card, ...members].map((c) => [c.tenantId, c]))
  const stored = card.cohortRank.members
  const base =
    stored && stored.length > 0
      ? stored.map((m) => ({ tenantId: m.tenantId, score: m.aeoScore }))
      : [...byId.values()].map((c) => ({ tenantId: c.tenantId, score: c.aeoScore.current }))
  if (!base.some((b) => b.tenantId === card.tenantId)) base.push({ tenantId: card.tenantId, score: card.aeoScore.current })
  const scores = base.map((b) => b.score)
  const selfGeneral = generalQuestionTexts(banks[card.tenantId])
  return base
    .map((b) => {
      const c = byId.get(b.tenantId) ?? null
      const general = c ? generalQuestionTexts(banks[b.tenantId]) : null
      const { position, tied } = positionOf(b.score, scores)
      return {
        tenantId: b.tenantId,
        brandName: c?.brandName ?? b.tenantId,
        isSelf: b.tenantId === card.tenantId,
        score: b.score,
        position,
        tied,
        mentionRate: c ? c.mentionRate : null,
        ownedRate: c ? c.brandOwnedCitationRate : null,
        avgRank: c ? c.avgRecommendationRank : null,
        rankedResponses: c ? (c.rankedResponses ?? null) : null,
        sameQuestions: selfGeneral && general ? sameSet(selfGeneral, general) : null,
        loaded: c !== null,
      }
    })
    .sort((a, b) => a.position - b.position || Number(b.isSelf) - Number(a.isSelf))
}

/**
 * 이 브랜드의 그 주 응답 요약. 그 주 질문 은행을 못 읽었거나, 판정 기록이 은행 질문과 하나도 맞지 않으면(기록이 없거나 예시 기록 ·
 * 예시 은행이 왔을 때) 일반 질문을 가려낼 수 없어 null이다 — 「불린 적 없음 · 0건 중 0건」으로 쓰지 않는다.
 *
 * 실증 질문의 응답은 어디에도 세지 않는다 — 일반 질문 · 카테고리 줄 · 「틀림」 주장 모두 카드(server/aggregate.ts 첫머리 거르개)와
 * 같은 모집단이어야 「사실과 어긋난 주장 N건」 아래 목록이 N과 맞는다.
 */
export function selfReview(analyses: QuestionRepeatAnalysis[], bank: QuestionBank | null): SelfReview | null {
  if (!bank) return null
  const bankById = new Map(bank.questions.map((q) => [q.questionId, q]))
  if (!analyses.some((a) => bankById.has(a.questionId))) return null
  const scored = withoutProbes(analyses, bank.questions)
  const generalAnalyses = scored.filter((a) => {
    const q = bankById.get(a.questionId)
    return q !== undefined && isScoredAgnostic(q)
  })
  const mentionedByText = new Map<string, Set<string>>()
  for (const a of generalAnalyses) {
    if (!a.mentioned) continue
    const text = bankById.get(a.questionId)?.text ?? a.questionId
    mentionedByText.set(text, (mentionedByText.get(text) ?? new Set()).add(ENGINE_LABEL[a.engine] ?? a.engine))
  }
  const categories: CategoryRow[] = Object.entries(CATEGORY_LABEL)
    .map(([category, label]) => {
      // 이름을 넣어 물은 질문만 — 이 유형들은 브랜드 이름을 넣은 질문이다(보고서는 「이름을 넣어 물은 질문 — 유형별」로 이름 없는 질문과 갈라
      // 보인다, 2026-11-16). 이름 없는 질문이 섞여 들어오면 그 질문은 위 「이름 없이 물은 질문」 쪽에 센다.
      const rows = scored.filter((a) => {
        const q = bankById.get(a.questionId)
        return q?.category === category && q.containsBrandName !== false
      })
      return { category, label, mentioned: rows.filter((a) => a.mentioned).length, total: rows.length }
    })
    .filter((r) => r.total > 0)
  return {
    general: {
      questions: new Set(generalAnalyses.map((a) => a.questionId)).size,
      responses: generalAnalyses.length,
      mentioned: generalAnalyses.filter((a) => a.mentioned).length,
      clarifying: generalAnalyses.filter((a) => a.clarifying).length,
    },
    mentionedQuestions: [...mentionedByText].map(([text, engines]) => ({ text, engines: [...engines] })),
    categories,
    contradicted: scored.flatMap((a) =>
      a.factualityClaims
        .filter((c) => c.verdict === 'contradicted')
        .map((c) => ({
          question: bankById.get(a.questionId)?.text ?? a.questionId,
          engine: ENGINE_LABEL[a.engine] ?? a.engine,
          said: c.responseValue ?? c.claimText,
          registered: c.factGraphValue ?? '—',
        })),
    ),
  }
}

/** 그 주 우리가 올린 글(올린 글 기록)이 AI 답에 출처로 붙은 횟수 — 질문 갈래별 · 이름 없는 질문은 글 주소의 호스트별. */
export interface OwnPostCitations {
  /** 그 주 인용된 우리 글 편 수(주소 기준). */
  posts: number
  all: number
  /** 질문 은행을 못 읽은 주는 null — 0이 아니라 확인 불가. */
  named: number | null
  unnamed: number | null
  /** 이름 없는 질문 인용 — 글 주소의 호스트별(「cablekis.tistory.com」). */
  unnamedByHost: { host: string; count: number }[]
  /** 그 주 인용된 글의 주소 키 — 집행 표의 판단(여러 주 · 한 주 인용)을 붙일 때 쓴다. */
  citedKeys: string[]
}

/**
 * 정기진단 보고서 「AI가 근거로 쓴 출처」의 우리 글 줄(2026-11-16) — 블로그(티스토리 등)에 올린 글은 자사 주소가 아니라 「자사」 칸에
 * 들어가지 않고, 「티스토리 · 블로그 N곳」 묶음에도 남의 글과 섞여 있었다. 셈은 발행 현황 · 퍼포먼스와 같은 올린 글 인용 기록
 * (server/publishedHistory.ts)이다. 같은 주소를 여러 줄에 적은 기록은 한 편으로(그 주 인용이 가장 많은 줄). 그 주가 기록에 없으면 null.
 */
export function ownPostCitations(history: PublishedHistory | null, weekOf: string): OwnPostCitations | null {
  if (!history) return null
  const i = history.weeks.findIndex((w) => w.weekOf === weekOf)
  if (i < 0) return null
  const byKey = new Map<string, { key: string; url: string; tally: NonNullable<NonNullable<PublishedHistory['posts'][number]['cells'][number]>['tally']> }>()
  for (const p of history.posts) {
    const tally = p.cells[i]?.tally
    if (!tally) continue
    const key = p.post.key ?? p.post.url
    const cur = byKey.get(key)
    if (!cur || tally.all.cited > cur.tally.all.cited) byKey.set(key, { key, url: p.post.url, tally })
  }
  const rows = [...byKey.values()]
  const known = rows.every((r) => r.tally.named !== null && r.tally.unnamed !== null)
  const hosts = new Map<string, number>()
  for (const r of rows) {
    const n = r.tally.unnamed?.cited ?? 0
    if (n === 0) continue
    let host: string
    try {
      host = new URL(r.url).hostname.replace(/^(www|m)\./, '')
    } catch {
      continue
    }
    hosts.set(host, (hosts.get(host) ?? 0) + n)
  }
  return {
    posts: rows.filter((r) => r.tally.all.cited > 0).length,
    all: rows.reduce((s, r) => s + r.tally.all.cited, 0),
    named: known ? rows.reduce((s, r) => s + (r.tally.named?.cited ?? 0), 0) : null,
    unnamed: known ? rows.reduce((s, r) => s + (r.tally.unnamed?.cited ?? 0), 0) : null,
    unnamedByHost: [...hosts].map(([host, count]) => ({ host, count })).sort((a, b) => b.count - a.count || a.host.localeCompare(b.host)),
    citedKeys: rows.filter((r) => r.tally.all.cited > 0).map((r) => r.key),
  }
}

/** 출처 줄(도메인)에 들어가는 우리 글 인용 — 호스트가 그 도메인이거나 그 아래(「cablekis.tistory.com」 → 「tistory.com」). */
export function ownPostsInDomain(own: OwnPostCitations | null, domain: string): number {
  if (!own) return 0
  return own.unnamedByHost.filter((h) => h.host === domain || h.host.endsWith(`.${domain}`)).reduce((s, h) => s + h.count, 0)
}

/**
 * 판정이 자사로 본 인용이 남의 도메인 줄에 섞였을 때 붙일 이름 — 그 도메인의 주소 가운데 인용이 가장 많은 첫 경로 칸(블로그 아이디)을
 * 붙인다(「blog.naver.com」 → 「blog.naver.com/gunsangak」). 주소 목록이 없으면 도메인 그대로.
 */
function ownedSplitName(r: CitationBreakdownRow): string {
  const bySeg = new Map<string, number>()
  for (const u of r.urls ?? []) {
    let seg: string | undefined
    try {
      seg = new URL(u.url).pathname.split('/').filter(Boolean)[0]
    } catch {
      continue
    }
    if (seg) bySeg.set(seg, (bySeg.get(seg) ?? 0) + u.citationCount)
  }
  const top = [...bySeg].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
  return top ? `${r.domain}/${top[0]}` : r.domain
}

/**
 * 그 주 인용 상위 출처 — 상위 6개와 그 밖의 자사 출처. 건수는 인용 분석(/api/citations)의 도메인별 인용 수 그대로다.
 *
 * 도메인 줄의 성격은 그 도메인 인용 가운데 가장 많은 성격이라, 판정이 자사로 본 인용이 남의 글과 같은 도메인(네이버 블로그 등)에 있으면
 * 「이용자 글」 줄 안에 묻혔다 — 숫자 칸 「자사 인용률」(인용 하나하나의 판정)은 127건인데 표의 자사 합은 100건(군산각 W47, 2026-11-17).
 * 그런 인용은 「blog.naver.com/gunsangak · 자사」 줄로 떼어 내고 원래 줄에서 뺀다 — 표의 자사 합이 숫자 칸과 같아진다.
 */
export function citationTop(rows: CitationBreakdownRow[]): { total: number; owned: number; top: CitationRow[] } {
  const ownedLabel = OWNER_TYPE_LABEL['brand-owned'] ?? 'brand-owned'
  const expanded: CitationRow[] = []
  for (const r of rows) {
    const label = OWNER_TYPE_LABEL[r.ownerType] ?? r.ownerType
    if (r.ownerType === 'brand-owned') {
      expanded.push({ domain: r.domain, owner: label, count: r.citationCount, isOwned: true })
      continue
    }
    const ownedN = Math.min(r.ownerTypeCounts?.['brand-owned'] ?? 0, r.citationCount)
    if (r.citationCount - ownedN > 0) expanded.push({ domain: r.domain, owner: label, count: r.citationCount - ownedN, isOwned: false })
    if (ownedN > 0) expanded.push({ domain: ownedSplitName(r), owner: ownedLabel, count: ownedN, isOwned: true })
  }
  const sorted = expanded.sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
  const top = sorted.slice(0, 6)
  for (const r of sorted.filter((r) => r.isOwned && !top.includes(r))) top.push(r)
  return {
    total: rows.reduce((s, r) => s + r.citationCount, 0),
    owned: expanded.filter((r) => r.isOwned).reduce((s, r) => s + r.count, 0),
    top,
  }
}

/** 자사 출처 한 줄을 질문 종류로 나눈 값 — 이름 없이 물은 질문에서는 어느 AI가 인용했는지도. */
export interface OwnedCitationSplitRow {
  domain: string
  total: number
  named: number
  unnamed: number
  /** 이름 없이 물은 질문에서 이 출처를 인용한 엔진별 수(많은 순). */
  unnamedEngines: { engine: string; count: number }[]
}

export interface OwnedCitationSplit {
  rows: OwnedCitationSplitRow[]
  total: number
  named: number
  unnamed: number
}

/** 서버 인용 표(server/queries.ts getCitationBreakdown)와 같은 줄 키 — URL 호스트를 먼저 쓰고 www. · m.을 접는다. */
function breakdownHost(raw: string, domain: string | null | undefined): string {
  let host: string | null = null
  if (/^https?:\/\//i.test(raw.trim())) {
    try {
      host = new URL(raw.trim()).hostname || null
    } catch {
      // URL로 해석되지 않는 값 — 서버처럼 판정 값으로 넘긴다.
      host = null
    }
  }
  const base = (host ?? domain ?? raw).trim()
  return (base.split('/')[0] ?? base).toLowerCase().replace(/\.$/, '').replace(/^(?:www|m)\./, '')
}

/**
 * 자사 출처를 질문 종류로 나눈다 — 「모든 질문 · 자사 n건」이 이름을 넣어 물은 질문과 이름 없이 물은 질문에서 각각 몇 건인지(2026-11-25
 * 군산각 W48 — 자사 167건 가운데 이름 없이 물은 질문은 27건뿐이었는데 표로는 읽을 수 없었다). 모집단은 citationTop과 같다(실증 질문 제외).
 * 줄 이름도 citationTop과 같게 — 남의 도메인 줄에 섞인 자사 인용은 「blog.naver.com/아이디」로. 그 주 질문지가 없으면 null(나누지 못함).
 */
export function ownedCitationSplit(
  rows: CitationBreakdownRow[],
  analyses: QuestionRepeatAnalysis[],
  bank: QuestionBank | null,
): OwnedCitationSplit | null {
  if (!bank) return null
  const byId = new Map(bank.questions.map((q) => [q.questionId, q]))
  const nameOf = new Map(rows.map((r) => [r.domain, r.ownerType === 'brand-owned' ? r.domain : ownedSplitName(r)]))
  const acc = new Map<string, { named: number; unnamed: number; engines: Map<string, number> }>()
  for (const a of withoutProbes(analyses, bank.questions)) {
    const q = byId.get(a.questionId)
    if (!q) return null
    for (const c of a.citations) {
      if (c.ownerType !== 'brand-owned') continue
      const host = breakdownHost(c.raw, c.domain)
      const name = nameOf.get(host) ?? host
      const row = acc.get(name) ?? { named: 0, unnamed: 0, engines: new Map<string, number>() }
      if (q.containsBrandName) row.named += 1
      else {
        row.unnamed += 1
        row.engines.set(a.engine, (row.engines.get(a.engine) ?? 0) + 1)
      }
      acc.set(name, row)
    }
  }
  const out = [...acc].map(([domain, r]) => ({
    domain,
    total: r.named + r.unnamed,
    named: r.named,
    unnamed: r.unnamed,
    unnamedEngines: [...r.engines].map(([engine, count]) => ({ engine, count })).sort((x, y) => y.count - x.count || x.engine.localeCompare(y.engine)),
  }))
  out.sort((x, y) => y.total - x.total || x.domain.localeCompare(y.domain))
  const named = out.reduce((s, r) => s + r.named, 0)
  const unnamed = out.reduce((s, r) => s + r.unnamed, 0)
  return { rows: out, total: named + unnamed, named, unnamed }
}

/**
 * 측정 신뢰도 점검 — 순위 · 점수를 그대로 읽어도 되는지. 운영자가 보는 점검이다(고객 종이에는 싣지 않는다).
 *
 * history는 보고 주차까지만 센다 — 그 뒤에 잰 주차로 「여러 주 같은 조건」이라고 하면 그 주 보고서가 아직 없던 근거를 쓴다.
 * general이 null이면(그 주 질문 은행을 못 읽음) 되물은 응답 점검을 뺀다.
 */
export function trustChecks(
  card: WeeklyScorecard,
  history: WeeklyScorecard[],
  members: WeeklyScorecard[],
  cohort: CohortRow[],
  general: SelfReview['general'] | null,
): TrustCheck[] {
  const checks: TrustCheck[] = []
  const others = cohort.filter((r) => !r.isSelf)

  // 1) 같은 시험지 — 일반 질문이 다르면 순위가 질문 차이를 잰다.
  if (others.length === 0) {
    checks.push({ id: 'cohort', label: '비교 대상', status: 'warn', detail: '이 주차에 함께 잰 코호트 브랜드가 없어 순위를 비교할 수 없습니다.' })
  } else {
    const differ = others.filter((r) => r.sameQuestions === false)
    const unknown = others.filter((r) => r.sameQuestions === null) // 이 브랜드 은행을 못 읽어도 여기로 온다.
    checks.push(
      differ.length > 0
        ? {
            id: 'questions',
            label: '같은 일반 질문',
            status: 'warn',
            detail: `${differ.map((r) => r.brandName).join(', ')}은(는) 일반 질문이 다릅니다 — 점수 차이가 가시성이 아니라 질문 차이일 수 있습니다.`,
          }
        : unknown.length > 0
          ? {
              id: 'questions',
              label: '같은 일반 질문',
              status: 'warn',
              detail: `${unknown.map((r) => r.brandName).join(', ')}의 이번 주 기록이나 질문 은행을 읽지 못해 같은 질문을 받았는지 확인하지 못했습니다.`,
            }
          : {
              id: 'questions',
              label: '같은 일반 질문',
              status: 'ok',
              detail: `코호트 ${cohort.length}곳이 같은 일반 질문${general ? ` ${general.questions}개` : ''}를 받았습니다.`,
            },
    )
  }

  // 2) 같은 측정 조건 — 같은 주 코호트 브랜드끼리, 앱 전체 규칙(comparability.ts)으로. 질문지 버전 번호는 브랜드마다 따로 매겨
  //    견주지 않는다(같은 질문을 받았는지는 위 「같은 일반 질문」이 문장으로 본다). 한쪽에만 기록이 있으면 확인 불가로 친다.
  const byDim = new Map<ConditionChange, { states: Set<string>; brands: string[] }>()
  for (const m of members) {
    for (const d of compareConditions(card, m).filter((d) => d.dimension !== '질문지')) {
      const e = byDim.get(d.dimension) ?? { states: new Set<string>(), brands: [] }
      e.states.add(d.state)
      if (!e.brands.includes(m.brandName)) e.brands.push(m.brandName)
      byDim.set(d.dimension, e)
    }
  }
  const condText = [...byDim]
    .map(([dim, e]) => `${dim}${e.states.has('changed') ? '' : ' 확인 불가'}(${e.brands.join(', ')})`)
    .join(' · ')
  const unread = others.filter((r) => !r.loaded).length
  const unreadNote = unread > 0 ? ` (기록을 읽지 못한 ${unread}곳은 빼고 비교)` : ''
  if (others.length > 0) {
    checks.push(
      byDim.size > 0
        ? {
            id: 'conditions',
            label: '같은 측정 조건',
            status: 'warn',
            detail: `코호트 안에서 다른 조건이 있습니다 — ${condText}. 같은 조건의 비교가 아닙니다.${unreadNote}`,
          }
        : {
            id: 'conditions',
            label: '같은 측정 조건',
            status: unread > 0 ? 'warn' : 'ok',
            detail: `코호트 모두 ${engineText(card)}로 쟀고 판정 엔진 · 모델${card.repeatsPerQuestion ? `·반복 횟수(질문당 ${card.repeatsPerQuestion}회)` : ''}도 같습니다.${unreadNote}`,
          },
    )
  }

  // 3) 측정 횟수 — 한 번 잰 결과는 같은 설정에서도 몇 %p씩 흔들린다. 같은 조건으로 **연속해** 잰 주를 센다(앱 전체 규칙의
  //    comparableRun — 그래프 · 같은 조건 평균과 같은 구간). 예전에는 질문지 · 수집 엔진만 보고 떨어진 주도 세서, 판정이 바뀐 주를
  //    「같은 조건 3주」로 셌다. 같은 주 재측정은 그 주를 덮어써서 세지 않으므로 세는 단위는 주차다.
  const run = comparableRun(history, card.weekOf)
  const hadEarlier = history.some((h) => h.weekOf < card.weekOf)
  checks.push(
    run.length >= 2
      ? {
          id: 'runs',
          label: '측정 횟수',
          status: 'ok',
          detail: `같은 조건으로 ${runCountText(run)} 쟀습니다(${weekLabel(run[0]!.weekOf)}–${weekLabel(card.weekOf)}). 같은 방향인지 추이로 확인합니다.`,
        }
      : {
          id: 'runs',
          label: '측정 횟수',
          status: 'warn',
          detail: `같은 조건으로 잰 주가 아직 이번 주(${weekLabel(card.weekOf)})뿐입니다${hadEarlier ? ' — 직전 측정과 조건이 달랐습니다' : ''}. 고객용 결론은 같은 조건으로 다시 재서 같은 방향일 때 씁니다.`,
        },
  )

  // 4) 되물은 응답 — 많으면 질문에 지역·조건이 모자라 브랜드가 불릴 자리가 없다.
  if (general && general.responses > 0) {
    const rate = general.clarifying / general.responses
    checks.push(
      rate >= CLARIFYING_WARN
        ? {
            id: 'clarifying',
            label: '되물은 응답',
            status: 'warn',
            detail: `일반 질문 응답 ${general.responses}건 중 ${general.clarifying}건(${pct(rate)})이 답 대신 조건을 되물었습니다 — 질문에 지역·조건이 모자랄 수 있습니다.`,
          }
        : { id: 'clarifying', label: '되물은 응답', status: 'ok', detail: `일반 질문 응답 ${general.responses}건 중 되물은 응답 ${general.clarifying}건(${pct(rate)}).` },
    )
  }

  // 5) 사실성 「틀림」 — 판정 오류일 수 있어 결론으로 쓰기 전에 사람이 원문을 본다. 기록은 응답마다 한 줄이라 응답 수다.
  checks.push(
    card.hallucinationFlags.length > 0
      ? {
          id: 'facts',
          label: '사실성 판정',
          status: 'review',
          detail: `「틀림」 판정이 담긴 응답 ${card.hallucinationFlags.length}건 — AI가 실제로 틀렸을 수도, 다른 브랜드에 대한 답을 이 브랜드 사실과 대조한 판정 오류일 수도 있습니다. 원문을 확인한 뒤 씁니다.`,
        }
      : card.factualityScore === null
        ? { id: 'facts', label: '사실성 판정', status: 'ok', detail: '팩트 그래프가 없어 사실성을 재지 않았습니다(점수 미포함).' }
        : { id: 'facts', label: '사실성 판정', status: 'ok', detail: `「틀림」 판정 없음 · 사실성 ${pct(card.factualityScore)}.` },
  )
  return checks
}
