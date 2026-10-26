import { RANK_FULL_WEIGHT_RESPONSES, type WeeklyScorecard } from '../prompts/b8-report'
import type { RunHistory, RunPoint } from './api'
import {
  aeoScoreOf,
  aeoScoreRaw,
  mentionSentimentOf,
  NEUTRAL_SENTIMENT,
  scoreBreakdown,
  scoreInputsOf,
  weightTagText,
  type ScoreInputs,
  type ScorePartKey,
} from './b9-report'
import { comparableRun, compareConditions, conditionSummary } from './comparability'
import { formatRank, weekLabel } from './format'
import { buildRunTrend, kstStamp } from './runTrend'
import type { CitationSourceAnalysis } from '../prompts/b7-citation-sources'
import type { QuestionBank, QuestionRepeatAnalysis } from './types'

/*
 * 정기진단 보고서의 「점수 풀이」 — 이번 주 점수가 어디서 나왔고, 무엇이 점수를 움직이는지 고객이 읽을 문장으로 푼다.
 *
 * 2026-10-26 스테이,머뭄 W44 12점을 사람이 풀어 보니, 12점 중 11점이 이름 없이 물은 질문의 답 2건(같은 질문 하나)에서 나왔고 같은 날
 * 같은 조건으로 한 번 더 잰 회차는 1점이었다. 보고서에는 비중 꼬리표(「25% → 10%」)만 있어 이 사실을 읽을 수 없었고, 순위 칸은
 * 「상위에 배치됩니다」라고 반대로 말했다. 문장은 코드 템플릿이고 숫자는 카드 · 판정 기록에서 센 그대로다(LLM이 쓰지 않는다).
 * 점수 식은 b9-report.ts aeoScoreOf(서버 computeAeoScore와 같은 식)를 다시 쓴다 — 「이 답이 없었다면」 · 「1건 늘면」도 같은 식이다.
 *
 * 브랜드마다 사정이 달라 줄마다 조건이 있다 — 점수가 답 몇 건에 몰리지 않은 브랜드에는 「몰림」 · 「계단」 줄이 나오지 않는다.
 */

export interface ExplainLine {
  key: 'parts' | 'weights' | 'concentration' | 'steps' | 'rankScope' | 'named' | 'effects' | 'segment'
  label: string
  text: string
}

const PART_LABEL: Record<ScorePartKey, string> = {
  mentionRate: '언급률',
  brandOwnedCitationRate: '자사 출처 인용',
  avgRecommendationRank: '추천 순위',
}

/** 「몰림」 줄을 쓰는 문턱 — 순위가 매겨진 답 몇 건이 점수의 절반 이상, 3점 이상을 낼 때. */
const CONCENTRATION_SHARE = 0.5
const CONCENTRATION_MIN_POINTS = 3

/** 1점보다 작은 차이는 소수 한 자리, 그보다 크면 정수 — 「약 +5점」 · 「약 +0.4점」. */
function pointsText(d: number): string {
  const v = Math.abs(d) >= 1.5 ? Math.round(d) : Math.round(d * 10) / 10
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}점`
}

/** 「2026년 36~41주차」 — 같은 해면 해를 한 번만. */
function weekRangeText(from: string, to: string): string {
  const a = from.match(/(\d{4})-W(\d{2})/)
  const b = to.match(/(\d{4})-W(\d{2})/)
  if (!a || !b) return `${from}~${to}`
  if (from === to) return `${a[1]}년 ${Number(a[2])}주차`
  return a[1] === b[1] ? `${a[1]}년 ${Number(a[2])}~${Number(b[2])}주차` : `${a[1]}년 ${Number(a[2])}주차~${b[1]}년 ${Number(b[2])}주차`
}

/** 이름 없이 물은 질문(점수의 언급률 · 추천 순위 모집단 — server/aggregate.ts와 같은 규칙)과 이름을 넣어 물은 질문의 판정 기록. */
interface Population {
  unnamed: QuestionRepeatAnalysis[]
  named: QuestionRepeatAnalysis[]
  /** 이름 없이 물은 질문에서 언급되고 순위가 매겨진 답(점수의 순위 몫). */
  ranked: QuestionRepeatAnalysis[]
  /** 판정 기록이 카드와 같은 측정에서 나왔는가 — 언급률 · 순위 답 수가 카드와 맞을 때만 기록으로 센 줄을 쓴다. */
  matchesCard: boolean
}

function population(card: WeeklyScorecard, analyses: QuestionRepeatAnalysis[], bank: QuestionBank | null): Population | null {
  if (!bank) return null
  const byId = new Map(bank.questions.map((q) => [q.questionId, q]))
  const unnamed = analyses.filter((a) => byId.get(a.questionId)?.category === 'category-agnostic')
  const named = analyses.filter((a) => byId.get(a.questionId)?.containsBrandName === true)
  if (unnamed.length === 0) return null
  const ranked = unnamed.filter((a) => a.mentioned && a.brandRank !== null)
  const mentioned = unnamed.filter((a) => a.mentioned).length
  // 순위 응답 수가 없는 옛 카드는 순위를 다른 식(전체 비중)으로 셌다 — 기록으로 센 줄을 쓰면 계단 · 몰림이 카드 점수와 어긋난다.
  const matchesCard =
    card.rankedResponses !== undefined &&
    card.rankedResponses === ranked.length &&
    Math.abs(mentioned / unnamed.length - card.mentionRate) < 1e-6
  return { unnamed, named, ranked, matchesCard }
}

/** 이번 주 다른 값은 그대로 두고 순위가 매겨진 답만 바꾼 점수 식 입력 — ranks는 순위가 매겨진 답들의 순위, 그 답들은 언급으로도 센다. */
function withRanked(base: ScoreInputs, n: number, otherMentions: number, ranks: number[], sentiment = base.sentiment): ScoreInputs {
  return {
    ...base,
    sentiment,
    mentionRate: (otherMentions + ranks.length) / n,
    avgRecommendationRank: ranks.length > 0 ? ranks.reduce((s, r) => s + r, 0) / ranks.length : null,
    rankedResponses: ranks.length,
  }
}

/** 정수 몫 나누기 — 합이 점수와 같게(내림한 뒤 소수부가 큰 항목부터 1점씩). 「12점 = 10 + 1 + 1」이 더해서 맞아야 한다. */
function apportion(values: number[], total: number): number[] {
  const floors = values.map((v) => Math.floor(Math.max(0, v)))
  let diff = total - floors.reduce((a, b) => a + b, 0)
  const order = values.map((v, i) => ({ i, frac: Math.max(0, v) - floors[i]! })).sort((a, b) => b.frac - a.frac)
  for (let j = 0; diff > 0 && j < order.length; j += 1, diff -= 1) floors[order[j]!.i]! += 1
  // 합이 넘치면(언급 몫이 0에서 잘린 경우) 소수부가 작은 항목부터 1점씩 덜어 낸다.
  for (let j = order.length - 1; diff < 0 && j >= 0; j -= 1) {
    const i = order[j]!.i
    if (floors[i]! > 0) {
      floors[i]! -= 1
      diff += 1
    }
  }
  return floors
}

export function explainScore(input: {
  card: WeeklyScorecard
  history: WeeklyScorecard[]
  analyses: QuestionRepeatAnalysis[]
  bank: QuestionBank | null
}): ExplainLine[] {
  const { card, history, analyses, bank } = input
  const score = card.aeoScore.current
  const lines: ExplainLine[] = []
  const parts = scoreBreakdown(card)
  // 지금 점수 식으로 카드 점수가 나오는가 — 옛 가중치로 낸 카드(웹 데모 등)는 항목 몫 · 비중이 맞지 않아 그런 줄을 쓰지 않는다.
  const formulaFits = aeoScoreOf(scoreInputsOf(card)) === score

  if (formulaFits) {
    // 구성 — 항목마다 보탠 점수(약, 정수). 합이 점수와 같게 나눈다.
    const counted = parts.filter((p) => p.points !== null).sort((a, b) => (b.points ?? 0) - (a.points ?? 0))
    const ints = apportion(
      counted.map((p) => p.points ?? 0),
      score,
    )
    lines.push({
      key: 'parts',
      label: '구성',
      text: `${score}점 = ${counted.map((p, i) => `${PART_LABEL[p.key]} 약 ${ints[i]}점`).join(' + ')}${
        parts.some((p) => p.key === 'avgRecommendationRank' && p.points === null) ? ' (순위가 매겨진 답이 없어 추천 순위는 점수에서 빠졌습니다)' : ''
      }.`,
    })

    // 비중 — 순위 답이 6건보다 적으면 순위 몫을 그만큼 줄이고 나머지를 키운다.
    const rankPart = parts.find((p) => p.key === 'avgRecommendationRank')!
    if (card.rankedResponses !== undefined && card.rankedResponses < RANK_FULL_WEIGHT_RESPONSES) {
      const others = parts
        .filter((p) => p.key !== 'avgRecommendationRank')
        .map((p) => `${PART_LABEL[p.key]} ${weightTagText(p, { short: true })}`)
        .join(' · ')
      lines.push({
        key: 'weights',
        label: '비중',
        text:
          rankPart.weight === 0
            ? `순위가 매겨진 답이 없으면 추천 순위를 빼고 나머지 두 항목으로만 셉니다(${others}).`
            : `순위가 매겨진 답이 ${RANK_FULL_WEIGHT_RESPONSES}건보다 적으면 그만큼만 반영합니다. 이번 주는 ${card.rankedResponses}건이라 추천 순위 비중이 ${weightTagText(rankPart, { short: true })}로 줄고, 나머지가 커졌습니다(${others}).`,
      })
    }
  }

  /*
   * 기록으로 센 줄(몰림 · 계단 · 이름을 댈 때 · 움직이는 것) — 판정 기록이 카드와 같은 측정이고, 기록 값(실제 감성 계수 포함)으로 같은 식에
   * 넣어 카드 점수가 나올 때만. 감성 계수는 언급 문장에서 서버와 같은 규칙으로 센다(반올림된 점수에서 거꾸로 풀면 언급이 한두 건인 주에
   * 0.7~0.8로 틀어진다). 새로 불리는 답을 가정할 때는 지금 문장 평균, 문장이 없으면 중립 0.7(개선제안 계산 예시와 같은 가정).
   */
  const pop = population(card, analyses, bank)
  const base = scoreInputsOf(card)
  let usable: (Population & { n: number; ranks: number[]; otherMentions: number; sentimentNow: number; sentimentNew: number }) | null = null
  if (pop && pop.matchesCard) {
    const n = pop.unnamed.length
    const ranks = pop.ranked.map((a) => a.brandRank as number)
    const otherMentions = pop.unnamed.filter((a) => a.mentioned).length - ranks.length
    const actual = mentionSentimentOf(pop.unnamed)
    const sentimentNow = actual ?? 1
    if (aeoScoreOf(withRanked(base, n, otherMentions, ranks, sentimentNow)) === score) {
      usable = { ...pop, n, ranks, otherMentions, sentimentNow, sentimentNew: actual ?? NEUTRAL_SENTIMENT }
    }
  }

  if (usable) {
    const { n, ranks, otherMentions, sentimentNow, sentimentNew } = usable
    const k = ranks.length

    // 몰림 — 순위가 매겨진 답 몇 건이 점수 대부분을 낸 주. 그 답들이 없었다면 그 답의 언급 문장도 감성 평균에서 빠진다(서버와 같다).
    if (k > 0 && k < RANK_FULL_WEIGHT_RESPONSES) {
      const rest = usable.unnamed.filter((a) => !usable!.ranked.includes(a))
      const without = aeoScoreOf(withRanked(base, n, otherMentions, [], mentionSentimentOf(rest) ?? 1))
      const fromRanked = score - without
      if (fromRanked >= CONCENTRATION_MIN_POINTS && fromRanked >= score * CONCENTRATION_SHARE) {
        const texts = [...new Set(usable.ranked.map((a) => bank!.questions.find((q) => q.questionId === a.questionId)?.text ?? ''))].filter(Boolean)
        const where = texts.length === 1 ? `질문 1개 — 「${texts[0]}」` : `질문 ${texts.length}개`
        lines.push({
          key: 'concentration',
          label: '몰림',
          text: `${score}점 가운데 약 ${fromRanked}점은 이름 없이 물은 질문의 답 ${k}건(${where})에서 나왔습니다. 이 ${k}건이 없었다면 ${without}점입니다.`,
        })
      }
    }

    // 계단 — 순위 비중이 늘어나는 구간(6건 미만)에서는 1위 답 한 건이 점수를 크게 바꾼다. 1위가 아닌 순위 답은 그대로 두고 1위 답 수만
    // 바꾼다 — 이번 주 칸이 이번 주 점수와 같다.
    if (k < RANK_FULL_WEIGHT_RESPONSES) {
      const nonFirst = ranks.filter((r) => r !== 1)
      const firstNow = k - nonFirst.length
      const top = Math.min(RANK_FULL_WEIGHT_RESPONSES, Math.max(3, firstNow + 1))
      const steps = Array.from({ length: top + 1 }, (_, j) => {
        const s = j === firstNow ? score : aeoScoreOf(withRanked(base, n, otherMentions, [...nonFirst, ...Array(j).fill(1)], j > firstNow ? sentimentNew : sentimentNow))
        return `${j}건 ${s}점${j === firstNow ? '(이번 주)' : ''}`
      })
      lines.push({
        key: 'steps',
        label: '계단',
        text: `이번 주 다른 값은 그대로 두고 비교 그룹 이름 중 1위로 추천된 답 수만 바꾸면 ${steps.join(' · ')}입니다. 한두 건 차이로 점수가 크게 움직이므로, 한 번 잰 점수보다 같은 조건으로 여러 번 잰 흐름으로 봅니다.`,
      })
    }
  }

  // 순위의 뜻 — 순위는 답에 나온 비교 그룹 이름 안에서 매긴다(목록 밖 업체는 빠진다).
  if (card.avgRecommendationRank !== null) {
    lines.push({
      key: 'rankScope',
      label: '순위의 뜻',
      text: `평균 추천 순위 ${formatRank(card.avgRecommendationRank)}위는 답에 나온 비교 그룹 이름 가운데 몇 번째로 추천됐는지입니다. 비교 그룹에 없는 업체는 순위에서 빠지므로, 실제 답에서는 더 뒤에 소개됐을 수 있습니다.`,
    })
  }

  // 이름을 댈 때와 아닐 때 — 점수의 언급률 · 순위는 이름 없이 물은 질문만 센다.
  if (usable && usable.named.length > 0) {
    const nm = usable.named.filter((a) => a.mentioned).length
    const um = usable.unnamed.filter((a) => a.mentioned).length
    lines.push({
      key: 'named',
      label: '이름을 댈 때',
      text: `브랜드 이름을 넣어 물은 질문은 응답 ${usable.named.length}건 중 ${nm}건에서 불렸고, 이름 없이 물은 질문은 ${usable.unnamed.length}건 중 ${um}건이었습니다. 점수의 언급률과 추천 순위는 이름 없이 물은 질문에서만 셉니다.`,
    })
  }

  // 무엇이 점수를 움직이나 — 같은 식에 한 건 · 1%p를 더해 본 값. 자사 출처 인용률은 모든 질문의 인용으로 세므로 따로 적는다.
  if (usable) {
    const { n, ranks, otherMentions, sentimentNow, sentimentNew } = usable
    const now = aeoScoreRaw(withRanked(base, n, otherMentions, ranks, sentimentNow))
    const topOne = aeoScoreRaw(withRanked(base, n, otherMentions, [...ranks, 1], sentimentNew)) - now
    const plainOne = aeoScoreRaw(withRanked(base, n, otherMentions + 1, ranks, sentimentNew)) - now
    const owned =
      aeoScoreRaw({ ...withRanked(base, n, otherMentions, ranks, sentimentNow), brandOwnedCitationRate: base.brandOwnedCitationRate + 0.01 }) - now
    lines.push({
      key: 'effects',
      label: '움직이는 것',
      text: `같은 식으로 셈하면 이번 주에는 이름 없이 물은 질문에서 비교 그룹 이름 중 1위로 추천되는 답 1건이 약 ${pointsText(topOne)}, 순위 없이 불리는 답 1건이 약 ${pointsText(plainOne)}입니다. 자사 출처 인용률(모든 질문의 인용 기준)은 1%p에 약 ${pointsText(owned)}입니다(같은 식으로 낸 값이며 약속이 아닙니다).`,
    })
  }

  // 견주는 구간 — 측정 조건이 바뀐 주 앞의 점수와는 견주지 않는다(앱 전체 규칙 comparability.ts). 바뀐 조건과 한쪽에 기록이 없는 조건을
  // 가른다 — 기록이 없는 것을 「달라졌다」고 쓰지 않는다(표지 · 비교 불가 안내와 같은 규칙).
  const run = comparableRun(history, card.weekOf)
  const earlier = history.filter((h) => run.length > 0 && h.weekOf < run[0]!.weekOf).sort((a, b) => a.weekOf.localeCompare(b.weekOf))
  if (run.length > 0 && earlier.length > 0) {
    const scores = earlier.map((h) => h.aeoScore.current)
    const lo = Math.min(...scores)
    const hi = Math.max(...scores)
    const diffs = compareConditions(earlier.at(-1)!, run[0]!)
    const changed = diffs.some((d) => d.state === 'changed')
    const start = weekRangeText(run[0]!.weekOf, run[0]!.weekOf)
    const before = `그 전 점수(${weekRangeText(earlier[0]!.weekOf, earlier.at(-1)!.weekOf)}, ${lo === hi ? `${lo}점` : `${lo}~${hi}점`})와는 견주지 않습니다.`
    const unknownDims = diffs.filter((d) => d.state === 'unknown').map((d) => d.dimension).join(' · ')
    lines.push({
      key: 'segment',
      label: '견주는 구간',
      // 같은 조건 구간의 길이는 적지 않는다 — 「같은 조건으로 잰 최근 측정」 절은 같은 주 여러 회차까지 세어(옛 기록 제외) 수가 다르다.
      text: changed
        ? `${start}부터 측정 조건(${conditionSummary(diffs)})이 달라져, ${before}${run.length === 1 ? ' 이번 주가 바뀐 조건으로 처음 잰 주입니다.' : ''}`
        : `${start}부터는 앞 측정과 견줄 측정 조건 기록이 한쪽에 없어(${unknownDims}), ${before}${run.length === 1 ? ' 이번 주부터 새로 이어 봅니다.' : ''}`,
    })
  }

  return lines
}

/** 같은 조건으로 잰 최근 회차 — 보고서 표지 평균과 「같은 조건으로 잰 최근 측정」 절이 같은 묶음을 쓴다. */
export interface RecentRuns {
  runs: RunPoint[]
  /** 소수 한 자리. */
  average: number
  min: number
  max: number
}

/** 평균에 넣는 주 수 — 표지의 「같은 조건 평균」(comparability.ts runAverage)과 같은 최근 4주. */
const RECENT_RUN_WEEKS = 4

/**
 * 판정 주차까지 같은 조건으로 잰 최근 회차(최근 4주) — 같은 주에 여러 번 잰 회차도 넣는다. 주마다 마지막 회차(그 주 카드)만 세면 같은 날
 * 1점 · 12점으로 잰 주가 12점 한 번으로 남는다(스테이,머뭄 W44).
 *
 * 잇는 규칙은 회차 보기(runTrend.ts buildRunTrend segments)와 같다 — 조건이 바뀐 곳, 엔진이 빠진 회차, 옛 기록(회차 기록 전 그 주 파일 ·
 * 옮겨 둔 회차), 질문지를 못 찾은 회차에서 끊는다. 이을 수 있는 회차가 2번 미만이거나 회차 기록이 없으면(웹) null — 표지는 주 카드 평균을 쓴다.
 */
export function recentRuns(h: RunHistory | null, weekOf: string): RecentRuns | null {
  if (!h || h.points.length === 0) return null
  const model = buildRunTrend(h)
  const segOf = (i: number) => model.segments.find((s) => s.includes(i)) ?? null
  let last = -1
  h.points.forEach((p, i) => {
    if (p.weekOf === weekOf && segOf(i)) last = i
  })
  if (last < 0) return null
  const seg = segOf(last)!.filter((i) => i <= last)
  const weeks = [...new Set(seg.map((i) => h.points[i]!.weekOf))].slice(-RECENT_RUN_WEEKS)
  const runs = seg.map((i) => h.points[i]!).filter((p) => weeks.includes(p.weekOf) && p.score !== null)
  if (runs.length < 2) return null
  const scores = runs.map((p) => p.score!)
  return {
    runs,
    average: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10,
    min: Math.min(...scores),
    max: Math.max(...scores),
  }
}

/** 회차 이름 — 회차는 측정을 마친 한국 시각(「10/26 13:51」), 시각이 없는 옛 기록은 주차. */
export function runLabel(p: RunPoint): string {
  return p.kind === 'run' && p.at ? kstStamp(p.at) : weekLabel(p.weekOf)
}

/**
 * 이번 주 카드가 비교 그룹과 다른 회차인가 — 「이 브랜드만」 다시 잰 회차가 그 주 카드면, 같은 주 비교 그룹 표의 다른 브랜드 점수는 다른
 * 시각에 잰 값이다(스테이,머뭄 W44 — 함께 잰 회차 1점 · 6분 뒤 이 브랜드만 잰 회차 12점). 옮겨 둔 회차는 측정 방식을 몰라 묻지 않는다.
 */
export function separateRunNote(h: RunHistory | null, card: WeeklyScorecard): string | null {
  if (!h) return null
  const own = h.points.find((p) => p.weekOf === card.weekOf && p.isWeekCard)
  if (!own || own.kind !== 'run' || own.preserved || own.selfOnly !== true) return null
  const together = h.points
    .filter((p) => p.weekOf === card.weekOf && p.kind === 'run' && !p.preserved && p.selfOnly === false && p.inCohortRun === false)
    .at(-1)
  const togetherScore = together ? (together.score ?? together.scoreAtMeasure) : null
  return `${card.brandName}의 ${weekLabel(card.weekOf)} 점수 ${card.aeoScore.current}점은 비교 그룹을 잰 회차와 다른 시각${own.at ? `(${kstStamp(own.at)})` : ''}에 이 브랜드만 다시 잰 값입니다.${
    together && togetherScore !== null ? ` 비교 그룹과 함께 잰 회차(${together.at ? kstStamp(together.at) : weekLabel(together.weekOf)})에서는 ${togetherScore}점이었습니다.` : ''
  }`
}

/** 이름 없이 물은 질문 답의 출처 상위 — 도메인마다 인용 수(인용 분석의 URL 줄을 도메인으로 묶는다). */
export function topSourceDomains(src: CitationSourceAnalysis | null, limit = 6): { domain: string; count: number; engines: string[] }[] {
  if (!src || src.urls.length === 0) return []
  const by = new Map<string, { count: number; engines: Set<string> }>()
  for (const u of src.urls) {
    const e = by.get(u.domain) ?? { count: 0, engines: new Set<string>() }
    e.count += u.citationCount
    for (const g of u.engines) e.engines.add(g)
    by.set(u.domain, e)
  }
  return [...by]
    .map(([domain, e]) => ({ domain, count: e.count, engines: [...e.engines].sort() }))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
    .slice(0, limit)
}

/** 인용 도메인이 등록된 주소(또는 그 하위 주소)인가 — 소유는 호스트 단위다(server/aggregate · 경로는 보지 않는다). */
const onDomain = (host: string, domain: string) => {
  const h = host.toLowerCase().replace(/^www\./, '')
  const d = domain.toLowerCase().replace(/^www\./, '')
  return h === d || h.endsWith(`.${d}`)
}

/**
 * 등록된 자사 주소마다 인용 수 — 이름을 넣어 물은 질문 · 이름 없이 물은 질문으로 나눠, 한 번도 인용되지 않은 주소(새로 옮긴 주소 등)도
 * 0건으로 보인다. 판정 모델의 자사 판정(자사 출처 인용률)과 달리 등록 주소와 직접 대조한 수다.
 */
export function ownedDomainCitations(
  analyses: QuestionRepeatAnalysis[],
  bank: QuestionBank | null,
  ownedDomains: string[],
): { domain: string; named: number; unnamed: number; total: number }[] | null {
  if (!bank || ownedDomains.length === 0 || analyses.length === 0) return null
  const byId = new Map(bank.questions.map((q) => [q.questionId, q]))
  return ownedDomains.map((domain) => {
    let named = 0
    let unnamed = 0
    let total = 0
    for (const a of analyses) {
      const q = byId.get(a.questionId)
      const n = a.citations.filter((c) => c.domain !== null && onDomain(c.domain, domain)).length
      total += n
      if (q?.containsBrandName === true) named += n
      else if (q?.category === 'category-agnostic') unnamed += n
    }
    return { domain, named, unnamed, total }
  })
}
