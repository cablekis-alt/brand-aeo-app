import type { WeeklyScorecard } from '../prompts/b8-report'
import { comparableRun, compareConditions, runCountText, type ConditionChange } from './comparability'
import { ENGINE_LABEL, OWNER_TYPE_LABEL, weekLabel } from './format'
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
const engineSet = (c: Pick<WeeklyScorecard, 'enginesUsed'>) => [...(c.enginesUsed ?? [])].sort().join('+')

/**
 * 같은 질문 은행 · 같은 수집 엔진으로 잰 주차(오름차순). 「측정 횟수」 점검과 콘텐츠의 실측 사례
 * (src/lib/answerEvidence.ts · server/articleEvidence.ts)가 같은 기준으로 센다 — 한 곳만 바뀌면 같은 브랜드가 한쪽에선
 * 「한 번 잰 결과」, 다른 쪽에선 「여러 주」로 보인다. 같은 주 재측정은 그 주를 덮어쓰므로 주차가 세는 단위다.
 */
export function sameConditionWeeks(
  history: Pick<WeeklyScorecard, 'weekOf' | 'questionBankVersion' | 'enginesUsed'>[],
  card: Pick<WeeklyScorecard, 'questionBankVersion' | 'enginesUsed'>,
): string[] {
  return history
    .filter((h) => h.questionBankVersion === card.questionBankVersion && engineSet(h) === engineSet(card))
    .map((h) => h.weekOf)
    .sort()
}
const engineText = (c: WeeklyScorecard) => (c.enginesUsed ?? []).map((e) => ENGINE_LABEL[e] ?? e).join(' · ') || '기록 없음'

/** 은행의 일반 질문(브랜드 이름 없는 질문) 텍스트 집합. 은행이 없으면 null. */
function generalQuestionTexts(bank: QuestionBank | null | undefined): Set<string> | null {
  if (!bank) return null
  return new Set(bank.questions.filter((q) => q.category === 'category-agnostic').map((q) => q.text.trim()))
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
 */
export function selfReview(analyses: QuestionRepeatAnalysis[], bank: QuestionBank | null): SelfReview | null {
  if (!bank) return null
  const bankById = new Map(bank.questions.map((q) => [q.questionId, q]))
  if (!analyses.some((a) => bankById.has(a.questionId))) return null
  const generalAnalyses = analyses.filter((a) => bankById.get(a.questionId)?.category === 'category-agnostic')
  const mentionedByText = new Map<string, Set<string>>()
  for (const a of generalAnalyses) {
    if (!a.mentioned) continue
    const text = bankById.get(a.questionId)?.text ?? a.questionId
    mentionedByText.set(text, (mentionedByText.get(text) ?? new Set()).add(ENGINE_LABEL[a.engine] ?? a.engine))
  }
  const categories: CategoryRow[] = Object.entries(CATEGORY_LABEL)
    .map(([category, label]) => {
      const rows = analyses.filter((a) => bankById.get(a.questionId)?.category === category)
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
    contradicted: analyses.flatMap((a) =>
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

/** 그 주 인용 상위 출처 — 상위 6개와 그 밖의 자사 출처. 건수는 인용 분석(/api/citations)의 도메인별 인용 수 그대로다. */
export function citationTop(rows: CitationBreakdownRow[]): { total: number; owned: number; top: CitationRow[] } {
  const sorted = [...rows].sort((a, b) => b.citationCount - a.citationCount)
  const top: CitationRow[] = sorted.slice(0, 6).map((r) => ({
    domain: r.domain,
    owner: OWNER_TYPE_LABEL[r.ownerType] ?? r.ownerType,
    count: r.citationCount,
    isOwned: r.ownerType === 'brand-owned',
  }))
  for (const r of sorted.filter((r) => r.ownerType === 'brand-owned' && !top.some((t) => t.domain === r.domain))) {
    top.push({ domain: r.domain, owner: OWNER_TYPE_LABEL[r.ownerType] ?? r.ownerType, count: r.citationCount, isOwned: true })
  }
  return {
    total: rows.reduce((s, r) => s + r.citationCount, 0),
    owned: rows.filter((r) => r.ownerType === 'brand-owned').reduce((s, r) => s + r.citationCount, 0),
    top,
  }
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
