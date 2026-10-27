import type { EeatAnalysis } from '../prompts/b6-eeat'
import type { RecommendationEvidence } from './recommendationEvidence'
import {
  AEO_SCORE_WEIGHTS,
  MIN_SOM_MENTIONS,
  normalizeRank,
  RANK_FULL_WEIGHT_RESPONSES,
  rankWeightFactor,
  shareOfMentionShortSample,
  type WeeklyScorecard,
} from '../prompts/b8-report'
import { comparableRun, comparableWith, runAverage, runCountText, type Comparability } from './comparability'
import { formatPct, formatRank, weekLabel } from './format'

// B9 — 주간 스코어카드를 결정적 규칙으로 진단하고 개선제안을 도출한다.
// 점수·수치는 이미 확정된 입력이며, 여기서는 "해석"과 "실행안"만 규칙 기반으로 붙인다(새 수치 생성 금지).

export type MetricStatus = 'good' | 'ok' | 'warn' | 'bad' | 'unknown'
export type Priority = 'high' | 'medium' | 'low'

export const STATUS_LABEL: Record<MetricStatus, string> = {
  good: '양호',
  ok: '보통',
  warn: '주의',
  bad: '미흡',
  unknown: '확인 불가',
}
export const PRIORITY_LABEL: Record<Priority, string> = { high: '높음', medium: '중간', low: '낮음' }

export interface MetricDiagnosis {
  key: string
  label: string
  weight: number
  valueText: string
  status: MetricStatus
  note: string
  delta?: { text: string; tone: 'up' | 'down' | 'flat' }
}

export interface Recommendation {
  id: string
  title: string
  priority: Priority
  basis: string
  actions: string[]
  expected: string
  links: { label: string; to: string }[]
  /**
   * 이번 주 데이터로 본 실행 항목(밀린 질문·출처·감점) — 화면이 측정 기록을 읽어 붙인다
   * (src/lib/recommendationEvidence.ts). 기록이 없으면(웹 데모 등) 비어 있고 actions만 보인다.
   */
  evidence?: RecommendationEvidence
}

export interface PeriodicReport {
  verdict: { tone: MetricStatus; label: string; summary: string }
  metrics: MetricDiagnosis[]
  strengths: MetricDiagnosis[]
  risks: string[]
  recommendations: Recommendation[]
  variabilityNote: string | null
  /**
   * 직전 측정과 견줘도 되는가 — 앱 전체 규칙(comparability.ts). 표지 요약 · 지표별 진단 · 화면의 숫자 칸이 같은 판정을 쓴다
   * (예전엔 표지 · 진단만 검사 없이 증감을 써서, 판정이 바뀐 주에도 「전주 대비 +9」가 고객 종이에 찍혔다).
   */
  comparison: Comparability
}


const SEVERITY: Record<MetricStatus, number> = { bad: 1, warn: 0.6, unknown: 0.5, ok: 0.25, good: 0 }

export type ScorePartKey = 'mentionRate' | 'brandOwnedCitationRate' | 'avgRecommendationRank'

export interface ScorePart {
  key: ScorePartKey
  /** 기본 가중치(AEO_SCORE_WEIGHTS). */
  baseWeight: number
  /** 이번 주 실제 비중 — 순위 응답이 적거나 없으면 순위 몫이 줄고 나머지가 그만큼 커진다(재정규화). 빠진 항목은 0. */
  weight: number
  /** 이번 주 점수에 이 항목이 보탠 점수(약). 빠진 항목은 null. */
  points: number | null
}

/**
 * 이번 주 Brand AEO Score가 어디서 나왔나 — 항목별 실제 비중과 보탠 점수.
 *
 * 점수는 server/scoring.ts computeAeoScore로 낸다: 순위 몫은 순위 응답 수만큼만(rankWeightFactor), 순위가 없으면 빼고 남은
 * 가중치로 나눈다. 화면마다 기본 가중치(25%)만 적어 「12점 중 10점이 순위 응답 2건에서 나왔다」를 읽을 수 없었고, 진단 화면은
 * 재정규화 전 값(8%)을 적어 세 화면의 비중이 서로 달랐다(상용화 UI 3차 U20). 여기 한 곳에서 내고 개요 · 진단 · 보고서 · 알림이 쓴다.
 *
 * 순위 · 자사 인용 몫은 카드 값으로 정확히 낸다. 언급률 몫에는 감성 계수가 곱해지는데 카드에 남지 않아, 점수에서 나머지 둘을
 * 뺀 값으로 둔다(반올림 탓에 1점 안팎 어긋날 수 있어 「약」이라고 쓴다).
 */
export function scoreBreakdown(card: WeeklyScorecard): ScorePart[] {
  const rankFactor = rankWeightFactor(card.rankedResponses, card.avgRecommendationRank)
  const raw = {
    mentionRate: AEO_SCORE_WEIGHTS.mentionRate,
    brandOwnedCitationRate: AEO_SCORE_WEIGHTS.brandOwnedCitationRate,
    avgRecommendationRank: card.avgRecommendationRank === null ? 0 : AEO_SCORE_WEIGHTS.avgRecommendationRank * rankFactor,
  }
  const total = raw.mentionRate + raw.brandOwnedCitationRate + raw.avgRecommendationRank
  const rankPoints =
    card.avgRecommendationRank === null || raw.avgRecommendationRank === 0
      ? null
      : normalizeRank(card.avgRecommendationRank) * (raw.avgRecommendationRank / total) * 100
  const ownedPoints = card.brandOwnedCitationRate * (raw.brandOwnedCitationRate / total) * 100
  const mentionPoints = Math.max(0, card.aeoScore.current - (rankPoints ?? 0) - ownedPoints)
  return [
    { key: 'mentionRate', baseWeight: AEO_SCORE_WEIGHTS.mentionRate, weight: raw.mentionRate / total, points: mentionPoints },
    { key: 'avgRecommendationRank', baseWeight: AEO_SCORE_WEIGHTS.avgRecommendationRank, weight: raw.avgRecommendationRank / total, points: rankPoints },
    {
      key: 'brandOwnedCitationRate',
      baseWeight: AEO_SCORE_WEIGHTS.brandOwnedCitationRate,
      weight: raw.brandOwnedCitationRate / total,
      points: ownedPoints,
    },
  ]
}

/** 점수 식에 들어가는 값 — 카드 값 + 감성 계수(카드에 남지 않아 impliedSentiment로 푼다). */
export interface ScoreInputs {
  mentionRate: number
  sentiment: number
  brandOwnedCitationRate: number
  avgRecommendationRank: number | null
  rankedResponses: number | undefined
}

/**
 * Brand AEO Score 식 — server/scoring.ts computeAeoScore와 같다(화면은 서버 모듈을 들이지 않는다). 순위 몫은 순위 응답 수만큼,
 * 순위가 없으면 빼고 남은 가중치로 나눈다. scripts/verify-first-screen.ts가 서버 식과 같은 값을 내는지 견준다.
 */
export function aeoScoreOf(v: ScoreInputs): number {
  return Math.round(aeoScoreRaw(v))
}

/** 반올림 전 점수(0~100) — 「자사 인용률 1%p는 약 +0.4점」처럼 1점보다 작은 차이를 셀 때 쓴다(보고서 점수 풀이). */
export function aeoScoreRaw(v: ScoreInputs): number {
  const rankFactor = rankWeightFactor(v.rankedResponses, v.avgRecommendationRank)
  const parts = [
    { value: v.mentionRate * v.sentiment, weight: AEO_SCORE_WEIGHTS.mentionRate },
    { value: v.brandOwnedCitationRate, weight: AEO_SCORE_WEIGHTS.brandOwnedCitationRate },
    ...(v.avgRecommendationRank !== null && rankFactor > 0
      ? [{ value: normalizeRank(v.avgRecommendationRank), weight: AEO_SCORE_WEIGHTS.avgRecommendationRank * rankFactor }]
      : []),
  ]
  const total = parts.reduce((s, p) => s + p.weight, 0)
  return parts.reduce((s, p) => s + p.value * (p.weight / total), 0) * 100
}

/** 언급 문장 감성 → 가중치 — server/scoring.ts sentimentWeight와 같다(positive 1 · neutral 0.7 · negative 0.2, 그 밖은 중립). */
export function sentimentWeightOf(s: string): number {
  return s === 'positive' ? 1 : s === 'negative' ? 0.2 : 0.7
}

/** 새 언급을 가정할 때 지금 언급 문장이 없으면 쓰는 감성 — 중립. 보고서 점수 풀이와 개선제안 계산 예시가 같은 가정을 쓴다. */
export const NEUTRAL_SENTIMENT = 0.7

/**
 * 감성 계수 — 언급 문장 가중치의 평균(server/aggregate.ts와 같은 규칙 — 이름 없이 물은 질문의 판정 기록만 넘긴다). 문장이 없으면 null.
 * 판정 기록이 있으면 이 값을 쓴다 — 카드 점수에서 거꾸로 푼 값(impliedSentiment)은 언급이 한두 건인 주에 반올림 탓에 크게 틀어진다.
 */
export function mentionSentimentOf(analyses: { mentionSentences: { sentiment: string }[] }[]): number | null {
  const w = analyses.flatMap((a) => a.mentionSentences.map((m) => sentimentWeightOf(m.sentiment)))
  return w.length > 0 ? w.reduce((s, x) => s + x, 0) / w.length : null
}

/** 카드 점수에서 감성 계수를 거꾸로 푼다(0.2~1). 언급률이 0이면 계수가 점수에 들어가지 않아 1로 둔다. */
export function impliedSentiment(card: WeeklyScorecard): number {
  if (card.mentionRate <= 0) return 1
  const mention = scoreBreakdown(card).find((p) => p.key === 'mentionRate')!
  const implied = (mention.points ?? 0) / 100 / (mention.weight * card.mentionRate)
  return Number.isFinite(implied) ? Math.min(1, Math.max(0.2, implied)) : 1
}

export const scoreInputsOf = (card: WeeklyScorecard): ScoreInputs => ({
  mentionRate: card.mentionRate,
  sentiment: impliedSentiment(card),
  brandOwnedCitationRate: card.brandOwnedCitationRate,
  avgRecommendationRank: card.avgRecommendationRank,
  rankedResponses: card.rankedResponses,
})

/** 가중치 꼬리표 — 「가중치 42%」, 이번 주 비중이 다르면 「가중치 25% → 이번 주 10%」, 빠졌으면 「점수 제외」. */
export function weightTagText(part: ScorePart, opts: { short?: boolean } = {}): string {
  const base = Math.round(part.baseWeight * 100)
  if (part.weight === 0) return '점수 제외'
  const now = Math.round(part.weight * 100)
  // 짧게 — 표 안 작은 꼬리표(「25% → 10%」).
  if (opts.short) return now === base ? `${base}%` : `${base}% → ${now}%`
  return now === base ? `가중치 ${base}%` : `가중치 ${base}% → 이번 주 ${now}%`
}

/**
 * 지표 설명은 상태(양호·보통·주의·미흡)마다 따로 둔다. 예전엔 '양호'와 그 밖의 둘로만 나눠, '보통'에도
 * 가장 나쁜 쪽 문구가 붙어 상태 칩과 설명이 서로 다른 말을 했다(실측: 교보생명 W40 자사 인용 21.0%
 * '보통' 옆에 「거의 연결되지 않습니다」, SoM 35.9% '보통' 옆에 「경쟁사에 점유를 내주고 있습니다」).
 * 측정 불가(unknown)는 지표마다 사정이 달라 각 지표가 따로 적는다.
 */
type GradedNotes = Record<Exclude<MetricStatus, 'unknown'>, string>
function noteFor(s: MetricStatus, notes: GradedNotes): string {
  return s === 'unknown' ? '' : notes[s]
}

/** 순위가 매겨진 답이 점수에 다 반영되는 수(6건)보다 적은가 — 응답 수를 모르는 옛 카드는 아니라고 본다. */
function fewRankedResponses(card: WeeklyScorecard): boolean {
  return card.rankedResponses !== undefined && card.rankedResponses < RANK_FULL_WEIGHT_RESPONSES
}

/** 이번 주 추천 순위 비중 「25% → 10%」 — 지표별 진단 꼬리표 · 점수 풀이 「비중」 줄과 같은 값(예전 「비중 2/6」은 33%로 읽혔다). */
function rankWeightText(card: WeeklyScorecard): string {
  const part = scoreBreakdown(card).find((p) => p.key === 'avgRecommendationRank')!
  return weightTagText(part, { short: true })
}

function rateStatus(v: number, good: number, ok: number, warn: number): MetricStatus {
  if (v >= good) return 'good'
  if (v >= ok) return 'ok'
  if (v >= warn) return 'warn'
  return 'bad'
}

function pctDelta(
  cur: number | null,
  prev: number | null | undefined,
  lowerIsBetter = false,
): MetricDiagnosis['delta'] {
  if (cur === null || prev === null || prev === undefined) return undefined
  const d = Math.round((cur - prev) * 1000) / 10 // 퍼센트포인트, 소수1
  if (d === 0) return { text: '보합', tone: 'flat' }
  const improved = lowerIsBetter ? d < 0 : d > 0
  return { text: `${d > 0 ? '+' : ''}${d}%p`, tone: improved ? 'up' : 'down' }
}

function rankDelta(cur: number | null, prev: number | null | undefined): MetricDiagnosis['delta'] {
  if (cur === null || prev === null || prev === undefined) return undefined
  const d = Math.round((cur - prev) * 10) / 10
  if (d === 0) return { text: '보합', tone: 'flat' }
  // 순위는 낮을수록 좋다 → 감소가 개선
  return { text: `${d > 0 ? '+' : ''}${d}`, tone: d < 0 ? 'up' : 'down' }
}

function diagnoseMetrics(card: WeeklyScorecard, prev?: WeeklyScorecard, eeat?: EeatAnalysis): MetricDiagnosis[] {
  const out: MetricDiagnosis[] = []

  // 1) 언급률 — 브랜드 이름 없이 물은 질문의 응답 기준(카테고리 무관)
  {
    const s = rateStatus(card.mentionRate, 0.5, 0.35, 0.2)
    out.push({
      key: 'mentionRate',
      // 모집단(이름 없이 물은 질문)은 진단 문장 · 숫자 칸 설명이 말한다 — 표의 이름 칸이 좁아 이름은 짧게 둔다.
      label: '언급률',
      weight: AEO_SCORE_WEIGHTS.mentionRate,
      valueText: formatPct(card.mentionRate),
      status: s,
      note: noteFor(s, {
        good: '브랜드명을 넣지 않은 자연어 질문에서도 잘 노출됩니다.',
        ok: '브랜드명을 넣지 않은 질문에서 자주 등장하지만, 빠지는 질문이 남아 있습니다.',
        warn: '브랜드명을 넣지 않은 질문에서 답변에 등장하는 비율이 낮습니다.',
        bad: '브랜드명을 넣지 않은 질문에서는 답변에 거의 등장하지 않습니다.',
      }),
      delta: pctDelta(card.mentionRate, prev?.mentionRate),
    })
  }

  // 2) Share of Mention — Brand AEO Score에 들어가지 않는 점유율 지표라 가중치가 없다(사실성과 같은 진단 참고용).
  //    경쟁사 목록이 있는 브랜드만 잴 수 있어 코호트 안에서 같은 조건으로 비교할 수 없다(b8-report.ts 가중치 주석).
  {
    const v = card.shareOfMention
    const shortSample = shareOfMentionShortSample(card)
    const s: MetricStatus = v === null ? 'unknown' : rateStatus(v, 0.4, 0.28, 0.15)
    out.push({
      key: 'shareOfMention',
      label: '언급 점유율 (점수 미포함)',
      weight: 0,
      valueText: formatPct(v),
      status: s,
      note:
        v === null
          ? shortSample !== null
            ? `브랜드명을 넣지 않은 질문에서 자사·경쟁사 언급이 ${shortSample}번뿐이라(${MIN_SOM_MENTIONS}번 미만) 점유율을 판정하지 않습니다.`
            : '경쟁사가 없거나, 브랜드명을 넣지 않은 질문에서 자사·경쟁사 언급이 전혀 없어 측정할 수 없습니다.'
          : noteFor(s, {
              good: '브랜드명을 넣지 않은 질문에서 경쟁 브랜드 대비 언급 점유가 높습니다.',
              ok: '브랜드명을 넣지 않은 질문에서 경쟁 브랜드와 언급을 나눠 갖고 있습니다 — 앞선 경쟁사를 따라잡을 여지가 있습니다.',
              warn: '브랜드명을 넣지 않은 질문에서 경쟁사에 점유를 내주고 있습니다.',
              bad: '브랜드명을 넣지 않은 질문의 언급 대부분을 경쟁사가 가져갑니다.',
            }),
      delta: pctDelta(v, prev?.shareOfMention),
    })
  }

  // 3) 평균 추천 순위 (낮을수록 좋음)
  //    순위는 답에 나온 비교 그룹 이름 안에서 매긴다(목록 밖 업체는 빠진다 — src/prompts/b5c-recommendation-order.ts). 순위 답이 몇 건뿐인
  //    주에 「상위에 배치됩니다」라고 쓰면, 실제 답에서는 네 번째로 소개된 1건이 「늘 상위」로 읽혔다(스테이,머뭄 W44 — 2건 모두 1위였지만
  //    답 안에서는 2번째 · 4번째). 그런 주는 무엇을 셌는지만 적고, 「잘하고 있는 점」에서도 뺀다(buildPeriodicReport).
  {
    const v = card.avgRecommendationRank
    let s: MetricStatus = 'unknown'
    if (v !== null) s = v <= 2 ? 'good' : v <= 3 ? 'ok' : v <= 4 ? 'warn' : 'bad'
    const few = v !== null && fewRankedResponses(card)
    out.push({
      key: 'avgRecommendationRank',
      label: '평균 추천 순위',
      weight: AEO_SCORE_WEIGHTS.avgRecommendationRank,
      valueText: formatRank(v),
      status: s,
      note:
        v === null
          ? '순위가 매겨진 답변이 없어 판정할 수 없습니다.'
          : few
            ? `답에 나온 비교 그룹 이름 가운데 평균 ${formatRank(v)}위입니다(순위가 매겨진 답 ${card.rankedResponses}건). 비교 그룹에 없는 업체는 순위에서 빠지고, 점수에는 답 수만큼만 반영해 추천 순위 비중이 ${rankWeightText(card)}입니다.`
            : noteFor(s, {
                good: 'AI가 추천을 나열할 때 상위에 배치됩니다.',
                ok: 'AI가 추천을 나열할 때 중상위에 놓입니다.',
                warn: 'AI가 여러 브랜드를 추천할 때 상대적으로 하위에 놓입니다.',
                bad: 'AI가 추천을 나열할 때 대체로 뒤쪽에 놓입니다.',
              }),
      delta: rankDelta(v, prev?.avgRecommendationRank),
    })
  }

  // 4) 사실성 — Brand AEO Score에 들어가지 않는 정확도 지표라 가중치가 없다(EEAT와 같은 진단 참고용).
  //    대조한 사실이 없으면 측정 불가다.
  {
    const v = card.factualityScore
    let s: MetricStatus = v === null ? 'unknown' : rateStatus(v, 0.9, 0.8, 0.6)
    if (card.hallucinationFlags.length > 0 && (s === 'good' || s === 'ok')) s = 'warn'
    out.push({
      key: 'factualityScore',
      label: '사실성 (점수 미포함)',
      weight: 0,
      valueText: formatPct(v),
      status: s,
      // 「틀림」 기록은 응답마다 한 줄이라 개수는 응답 수다(server/aggregate.ts) — 주장 수로 부르지 않는다.
      note:
        card.hallucinationFlags.length > 0
          ? `등록된 브랜드 정보와 다른 주장이 담긴 응답이 ${card.hallucinationFlags.length}건 있었습니다.`
          : v === null
            ? '등록된 브랜드 정보가 없거나 대조할 사실이 없어 측정하지 못했습니다.'
            : noteFor(s, {
                good: '답변이 사실 정보와 대체로 일치합니다.',
                ok: '답변이 사실 정보와 대부분 일치하지만, 어긋나는 서술이 일부 있습니다.',
                warn: '답변에 사실과 어긋나는 서술이 적지 않습니다.',
                bad: '답변의 사실 정보 상당수가 등록된 브랜드 정보와 어긋납니다.',
              }),
      delta: pctDelta(v, prev?.factualityScore),
    })
  }

  // 5) 자사 출처 인용률
  {
    const s = rateStatus(card.brandOwnedCitationRate, 0.3, 0.15, 0.05)
    out.push({
      key: 'brandOwnedCitationRate',
      label: '자사 출처 인용률',
      weight: AEO_SCORE_WEIGHTS.brandOwnedCitationRate,
      valueText: formatPct(card.brandOwnedCitationRate),
      status: s,
      note: noteFor(s, {
        good: 'AI 답변의 인용이 자사 도메인으로 잘 연결됩니다.',
        ok: 'AI가 근거로 삼는 출처 중 자사 콘텐츠가 일부 있습니다 — 인용되는 자사 페이지를 늘리면 더 오릅니다.',
        warn: 'AI가 근거로 삼는 출처 중 자사 콘텐츠가 적습니다.',
        bad: 'AI가 근거로 삼는 출처가 자사 콘텐츠로 거의 연결되지 않습니다.',
      }),
      delta: pctDelta(card.brandOwnedCitationRate, prev?.brandOwnedCitationRate),
    })
  }

  // 6) EEAT (보조 지표, 있을 때만)
  if (eeat && eeat.totalCallCount > 0) {
    const s = rateStatus(eeat.overall, 0.6, 0.45, 0.3)
    out.push({
      key: 'eeat',
      label: 'EEAT 종합',
      weight: 0, // 점수 가중치엔 없으나 진단 참고
      valueText: formatPct(eeat.overall),
      status: s,
      note: noteFor(s, {
        good: '경험·전문성·권위·신뢰 신호가 고르게 나타납니다.',
        ok: '경험·전문성·권위·신뢰 신호가 나타나지만 고르지 않습니다.',
        warn: 'AI 답변에서 전문성·권위·신뢰 신호가 약하게 나타납니다.',
        bad: 'AI 답변에서 전문성·권위·신뢰 신호가 거의 보이지 않습니다.',
      }),
    })
  }

  return out
}

const REC_LINKS = {
  questions: { label: '질문 프롬프트 빌더', to: '/questions' },
  diagnosis: { label: '브랜드 종합 진단', to: '/diagnosis' },
  site: { label: '사이트 종합 진단', to: '/site-diagnosis' },
  citations: { label: 'URL 상세 분석', to: '/citations' },
  sources: { label: 'AI 인용출처 분석', to: '/citation-sources' },
  ranking: { label: '경쟁 순위', to: '/ranking' },
  eeat: { label: 'EEAT 분석', to: '/eeat' },
  onboarding: { label: '브랜드 추가', to: '/brand-onboarding' },
}

/** 가중치를 문구에 박지 않고 상수에서 만든다 — 손으로 적은 "35%"가 실제 25%와 어긋나 있었다. */
function pctOf(weight: number): string {
  return `${Math.round(weight * 100)}%`
}

/**
 * 개선제안 기대효과에 적는 비중 — 이번 주 실제 비중(scoreBreakdown). 순위 답이 적은 주는 순위 몫이 줄고 언급률 · 자사 인용 몫이 커지는데,
 * 기본 가중치만 적으면 「12점 중 10점이 순위」인 주에 언급률을 「가중치 42%」로 적어 지표별 진단의 「42% → 50%」와 어긋났다.
 */
function weightOf(card: WeeklyScorecard, key: ScorePartKey): string {
  const part = scoreBreakdown(card).find((p) => p.key === key)
  if (!part) return `가중치 ${pctOf(AEO_SCORE_WEIGHTS[key])}`
  return part.weight === 0 ? `가중치 ${pctOf(part.baseWeight)}(이번 주는 순위가 매겨진 답이 없어 점수에서 빠짐)` : weightTagText(part)
}

function priorityOf(weight: number, status: MetricStatus): Priority {
  const impact = (weight || 0.1) * SEVERITY[status]
  if (impact >= 0.2) return 'high'
  if (impact >= 0.1) return 'medium'
  return 'low'
}

// 지표 상태 → 개선제안. warn/bad/unknown 인 지표에만 생성한다.
function buildRecommendations(metrics: MetricDiagnosis[], card: WeeklyScorecard): Recommendation[] {
  const by = Object.fromEntries(metrics.map((m) => [m.key, m])) as Record<string, MetricDiagnosis>
  const recs: Recommendation[] = []
  const weak = (k: string) => by[k] && (by[k].status === 'warn' || by[k].status === 'bad' || by[k].status === 'unknown')

  if (weak('mentionRate')) {
    const m = by.mentionRate
    recs.push({
      id: 'mention',
      title: '브랜드 이름 없는 질문에서 노출 확대',
      priority: priorityOf(m.weight, m.status),
      basis: `현재 언급률 ${m.valueText} — 브랜드명 없는 질문에서의 노출이 부족합니다.`,
      actions: [
        '업종·지역·이용 상황 기반의 공개 가이드·FAQ 콘텐츠를 늘려 자연어 질문의 답이 되도록 합니다.',
        '"○○ 지역 추천", "○○ 잘하는 곳" 류의 제3자 비교·추천 글에 포함되도록 노출을 늘립니다.',
        '핵심 페이지에 구조화 데이터(JSON-LD)와 명확한 제목·요약을 넣어 AI가 인용하기 쉽게 만듭니다.',
      ],
      expected: `${weightOf(card, 'mentionRate')} 지표 — 개선 시 Brand AEO Score 상승 폭이 큽니다.`,
      links: [REC_LINKS.questions, REC_LINKS.sources],
    })
  }

  if (weak('shareOfMention')) {
    const m = by.shareOfMention
    const isUnknown = m.status === 'unknown'
    const shortSample = shareOfMentionShortSample(card)
    recs.push({
      id: 'som',
      title: isUnknown ? '점유율 측정 조건 만들기' : '경쟁 대비 언급 점유 강화',
      priority: priorityOf(m.weight, m.status),
      basis: !isUnknown
        ? `현재 언급 점유율 ${m.valueText} — 브랜드명을 넣지 않은 질문에서 경쟁사에 밀리고 있습니다.`
        : shortSample !== null
          ? `브랜드명을 넣지 않은 질문에서 자사·경쟁사 언급이 ${shortSample}번뿐이라(${MIN_SOM_MENTIONS}번 미만) 언급 점유율을 판정하지 않았습니다.`
          : '경쟁사가 없거나, 브랜드명을 넣지 않은 질문에서 자사·경쟁사 언급이 전혀 없어 언급 점유율을 측정하지 못하고 있습니다.',
      actions: !isUnknown
        ? [
            '경쟁사와 함께 거론되는 질문에서 차별화 포인트(서비스·후기·가격 투명성 등)를 공개 콘텐츠로 명확히 합니다.',
            '후기·평점 플랫폼과 지역 커뮤니티에서의 노출·언급을 늘려 비교 문맥에서 우위를 확보합니다.',
          ]
        : shortSample !== null
          ? [
              '업종·지역 질문에서 자사와 경쟁사가 거의 거론되지 않는 상태입니다 — 먼저 브랜드 이름 없는 질문의 언급률을 올려야 점유율을 잴 수 있습니다.',
              '경쟁사 목록이 실제로 함께 추천되는 곳인지 확인합니다. 그 질문에서 불리지 않는 경쟁사만 있으면 언급 합계가 늘지 않습니다.',
            ]
          : [
            '브랜드 추가에서 주요 경쟁사를 등록하면 다음 측정부터 점유율이 산출됩니다.',
            '경쟁사를 이미 등록했다면 그 업종·지역 질문 자체에 브랜드가 전혀 등장하지 않는 상태입니다 — 먼저 브랜드 이름 없는 질문의 언급률을 올려야 합니다.',
          ],
      expected: isUnknown
        ? '점유율 지표가 활성화되어 진단 정확도가 올라갑니다.'
        : '점수에는 들어가지 않지만, 같은 질문에서 경쟁사보다 먼저 불리는지를 보여주는 지표입니다.',
      links: isUnknown ? [REC_LINKS.onboarding] : [REC_LINKS.diagnosis, REC_LINKS.ranking],
    })
  }

  if (weak('avgRecommendationRank')) {
    const m = by.avgRecommendationRank
    recs.push({
      id: 'rank',
      title: '추천 순위 끌어올리기',
      priority: priorityOf(m.weight, m.status),
      // 순위 답이 몇 건뿐인 주는 지표별 진단처럼 무엇을 셌는지만 적는다 — 답 두 건으로 「하위에 배치」라고 단정하지 않는다.
      basis:
        m.status === 'unknown'
          ? '추천·나열형 문맥이 적어 순위가 판정되지 않습니다.'
          : fewRankedResponses(card)
            ? `현재 답에 나온 비교 그룹 이름 가운데 평균 ${m.valueText}위(순위가 매겨진 답 ${card.rankedResponses}건) — 답이 적어 순위 위치를 단정하지 않습니다.`
            : `현재 평균 추천 순위 ${m.valueText} — AI 추천 나열에서 하위에 배치됩니다.`,
      actions: [
        '권위 있는 제3자 추천·수상·"1위/베스트" 신호를 확보해 AI가 상위로 인식하도록 합니다.',
        '리뷰 수·평점·최신 후기를 늘려 추천 근거를 강화합니다.',
      ],
      expected: `${weightOf(card, 'avgRecommendationRank')} 지표 — 추천형 질문 비중이 큰 업종에서 특히 효과적입니다.`,
      links: [REC_LINKS.ranking],
    })
  }

  // 사실성을 재지 못한 브랜드(팩트 그래프 없음)에 "사실 오류 정정"을 권하지 않는다 — 오류가 있다는 근거가 없다.
  if (weak('factualityScore') && by.factualityScore.status !== 'unknown') {
    const m = by.factualityScore
    recs.push({
      id: 'fact',
      title: '사실 오류 정정 및 공식 정보 정비',
      priority: Math.max(0, card.hallucinationFlags.length) > 0 ? 'high' : priorityOf(m.weight, m.status),
      // 「틀림」 기록 원문(엔진 id · 질문 id · 회차)은 싣지 않는다 — 고객이 읽는 근거이고, 원문은 화면의 사실성 절에서 본다.
      basis:
        card.hallucinationFlags.length > 0
          ? `사실과 어긋난 주장이 담긴 AI 응답이 ${card.hallucinationFlags.length}건 관측됐습니다.`
          : `사실성 ${m.valueText} — 답변에 부정확한 서술이 섞일 여지가 있습니다.`,
      actions: [
        '주소·제공 서비스(상품)·가격·자격/이력 등 핵심 사실을 공식 페이지에 최신 상태로 명확히 게시합니다.',
        '오정보의 근거가 된 외부 출처(오래된 소개글 등)를 찾아 정정·갱신을 요청합니다.',
        '구조화 데이터로 핵심 사실을 기계가 읽기 쉽게 제공해 혼동을 줄입니다.',
      ],
      expected: '사실성 오류는 신뢰 훼손 위험이 커 우선 처리 대상입니다.',
      links: [REC_LINKS.diagnosis, REC_LINKS.site],
    })
  }

  if (weak('brandOwnedCitationRate')) {
    const m = by.brandOwnedCitationRate
    recs.push({
      id: 'citation',
      title: '자사 출처 인용 가능성 개선',
      priority: priorityOf(m.weight, m.status),
      basis: `자사 출처 인용률 ${m.valueText} — AI가 근거로 자사 콘텐츠를 거의 참조하지 않습니다.`,
      actions: [
        '자바스크립트 없이도 읽히는 정적 콘텐츠를 확보합니다(AI 검색 로봇은 대부분 자바스크립트를 실행하지 않습니다).',
        '인용하기 좋은 "팩트/요약" 페이지를 만들고 llms.txt·구조화 데이터로 접근성을 높입니다.',
        'AI가 실제로 인용 중인 제3자 출처를 파악해 그 출처에 자사 정보가 반영되도록 합니다.',
      ],
      expected: `${weightOf(card, 'brandOwnedCitationRate')} 지표이며, 인용 연결은 신뢰·전환에 직접 기여합니다.`,
      links: [REC_LINKS.site, REC_LINKS.citations, REC_LINKS.sources],
    })
  }

  if (weak('eeat')) {
    const m = by.eeat
    recs.push({
      id: 'eeat',
      title: 'EEAT 신호 보강',
      priority: 'low',
      basis: `EEAT 종합 ${m.valueText} — 전문성·권위·신뢰 신호가 약하게 나타납니다.`,
      actions: [
        '대표·담당 전문가의 자격과 이력, 실제 이용 경험(후기), 권위 있는 제3자 언급을 공개 콘텐츠에 드러냅니다.',
      ],
      expected: '답변의 어조·추천 맥락을 우호적으로 만들어 다른 지표를 함께 끌어올립니다.',
      links: [REC_LINKS.eeat],
    })
  }

  const order: Record<Priority, number> = { high: 0, medium: 1, low: 2 }
  return recs.sort((a, b) => order[a.priority] - order[b.priority])
}

/**
 * 같은 조건 평균과 그 이름 — 회차 평균(reportExplain.ts recentRuns, 같은 주 여러 회차 포함)이 있으면 그것, 없으면 같은 조건 주 카드 평균
 * (runAverage). 같은 조건으로 2번 이상 잰 구간이 있을 때만 — 조건이 바뀐 주를 섞은 4주 이동평균을 보이지 않는다. 표지 · 개요가 같은 값을
 * 같은 말로 쓴다(한 앱에 평균이 둘이면 두 값처럼 읽힌다). 사이에 측정하지 않은 주가 있으면 「같은 조건 3번 평균」(연속이라고 하지 않는다).
 */
export function sameConditionAverage(
  history: WeeklyScorecard[],
  weekOf: string,
  runs?: { average: number; count: number } | null,
): { average: number; text: string } | null {
  if (runs) return { average: runs.average, text: `같은 조건 최근 ${runs.count}번 측정 평균` }
  const weekAvg = runAverage(history, weekOf)
  if (!weekAvg) return null
  return { average: weekAvg.average, text: `같은 조건 ${runCountText(comparableRun(history, weekOf).slice(-4))} 평균` }
}

export function buildPeriodicReport(
  history: WeeklyScorecard[],
  weekOf: string,
  eeat?: EeatAnalysis,
  /**
   * 같은 조건으로 잰 최근 회차 평균(같은 주 여러 회차 포함 — reportExplain.ts recentRuns). 있으면 표지 · 흔들림 문장이 주 카드 평균 대신
   * 이 값을 쓴다 — 한 문서에 평균이 둘이면 두 값처럼 읽힌다. 회차 기록이 없는 곳(웹)은 null.
   */
  runs?: { average: number; count: number } | null,
): PeriodicReport | null {
  const idx = history.findIndex((h) => h.weekOf === weekOf)
  const card = idx >= 0 ? history[idx] : history.at(-1)
  if (!card) return null
  // 직전 측정과 견줘도 될 때만 증감을 쓴다 — 측정 조건이 바뀐 주의 차이는 브랜드가 아니라 측정 방식이 만든 것이다.
  const comparison = comparableWith(history, card.weekOf)
  const prev = comparison.previousWeekOf ? history.find((h) => h.weekOf === comparison.previousWeekOf) : undefined

  const metrics = diagnoseMetrics(card, comparison.comparable ? prev : undefined, eeat)
  // 순위 답이 몇 건뿐인 주의 순위는 강점으로 내세우지 않는다 — 답 한두 건의 「비교 그룹 이름 중 1위」다(diagnoseMetrics 3).
  const strengths = metrics.filter((m) => m.status === 'good' && !(m.key === 'avgRecommendationRank' && fewRankedResponses(card)))
  const recommendations = buildRecommendations(metrics, card)

  // 종합 판정
  const badCount = metrics.filter((m) => m.status === 'bad').length
  const warnCount = metrics.filter((m) => m.status === 'warn').length
  /*
   * 표지의 증감 — 저장된 previousWeek · ma4(측정 당시 값, 조건이 바뀐 주를 가리지 않는다)를 쓰지 않고 이력에서 센다.
   *   - 앞 측정이 없음: 첫 측정 주차면 「전주 기록 없음」 — 저장된 previousWeek가 null이다(2026-10-27 전 카드는 이번 주 점수가
   *     들어 있어 같으면 첫 측정으로 본다). 그 밖의 값이면 앞 측정이 있었는데 불러온 이력(최근 12주) 밖이다 — 견줄 수 있는지
   *     모르니 「확인 불가」.
   *   - 견줄 수 없음: 증감 대신 두 점수를 부호 없이 나란히 적고 무엇이 달랐는지 적는다.
   *   - 2주 이상 떨어진 앞 측정은 「전주」가 아니라 「직전 측정(Wxx)」.
   */
  const prevLabel = comparison.previousWeekOf ? weekLabel(comparison.previousWeekOf) : ''
  // 바뀐 조건과 한쪽에 기록이 없어 확인할 수 없는 조건을 가른다 — 기록이 없는 것을 「달라」라고 하지 않는다.
  const changedDims = comparison.diffs.filter((d) => d.state === 'changed').map((d) => d.dimension).join(' · ')
  const unknownDims = comparison.diffs.filter((d) => d.state === 'unknown').map((d) => d.dimension).join(' · ')
  const notComparableText = changedDims
    ? `측정 조건(${changedDims})이 달라 증감으로 읽지 않음`
    : `측정 조건 기록이 한쪽에 없어(${unknownDims}) 증감으로 읽지 않음`
  const delta = prev ? card.aeoScore.current - prev.aeoScore.current : 0
  const against = (comparison.gapWeeks ?? 1) >= 2 ? `직전 측정(${prevLabel}) 대비` : '전주 대비'
  const trendText = !prev
    ? card.aeoScore.previousWeek === null || card.aeoScore.previousWeek === card.aeoScore.current
      ? '전주 기록 없음'
      : '직전 측정 기록을 불러오지 못해 증감 확인 불가'
    : !comparison.comparable
      ? `직전 측정(${prevLabel}) ${prev.aeoScore.current}점 — ${notComparableText}`
      : delta > 0
        ? `${against} +${delta}`
        : delta < 0
          ? `${against} ${delta}`
          : (comparison.gapWeeks ?? 1) >= 2
            ? `직전 측정(${prevLabel})과 같음`
            : '전주와 보합'
  const avg = sameConditionAverage(history, card.weekOf, runs)
  let tone: MetricStatus
  let label: string
  if (card.aeoScore.current >= 60 && badCount === 0) {
    tone = 'good'
    label = '전반적으로 양호'
  } else if (card.aeoScore.current >= 40 && badCount <= 1) {
    tone = 'warn'
    label = '부분 개선 필요'
  } else {
    tone = 'bad'
    label = '개선 필요'
  }
  const scoreNote = [avg ? `${avg.text} ${avg.average}` : '', trendText].filter(Boolean).join(', ')
  const summary = `Brand AEO Score ${card.aeoScore.current}점(${scoreNote}). 미흡 ${badCount}개·주의 ${warnCount}개 지표가 있으며, 아래 ${recommendations.length}개 개선제안을 우선순위대로 제시합니다.`

  // 하한은 0에서 잘려 있어(ciBounds) 상한 − 하한은 흔들림을 줄여 보인다. 자르기 전 폭으로 판단한다.
  const ciMargin = card.aeoScore.ciHigh - card.aeoScore.current
  const variabilityNote =
    2 * ciMargin > 25
      ? `95% 신뢰구간이 ±${Math.round(ciMargin * 10) / 10}점(${card.aeoScore.ciLow}–${card.aeoScore.ciHigh})으로 넓습니다(변동성 큼). 이번 주 단일 변동은 과잉 해석하지 말고 ${
          avg ? `${avg.text}(${avg.average}) 추세로 판단하세요.` : '같은 조건으로 한 번 더 잰 뒤 같은 방향인지 확인하세요.'
        }`
      : null

  return {
    verdict: { tone, label, summary },
    metrics,
    strengths,
    risks: card.hallucinationFlags,
    recommendations,
    variabilityNote,
    comparison,
  }
}
