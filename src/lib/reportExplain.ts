import { RANK_FULL_WEIGHT_RESPONSES, type WeeklyScorecard } from '../prompts/b8-report'
import { aeoScoreOf, aeoScoreRaw, scoreBreakdown, scoreInputsOf, weightTagText, type ScoreInputs, type ScorePartKey } from './b9-report'
import { comparableRun, compareConditions, conditionSummary, runCountText } from './comparability'
import { formatRank } from './format'
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
  const matchesCard =
    Math.abs(mentioned / unnamed.length - card.mentionRate) < 1e-6 && (card.rankedResponses === undefined || card.rankedResponses === ranked.length)
  return { unnamed, named, ranked, matchesCard }
}

/** 이번 주 다른 값은 그대로 두고 순위가 매겨진 답만 바꾼 점수 식 입력 — ranks는 순위가 매겨진 답들의 순위, 그 답들은 언급으로도 센다. */
function withRanked(base: ScoreInputs, n: number, otherMentions: number, ranks: number[]): ScoreInputs {
  return {
    ...base,
    mentionRate: (otherMentions + ranks.length) / n,
    avgRecommendationRank: ranks.length > 0 ? ranks.reduce((s, r) => s + r, 0) / ranks.length : null,
    rankedResponses: ranks.length,
  }
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

  // 구성 — 항목마다 보탠 점수(약). 언급률 몫은 감성 계수가 카드에 남지 않아 나머지를 뺀 값이라 정수로만 적는다.
  const counted = parts.filter((p) => p.points !== null).sort((a, b) => (b.points ?? 0) - (a.points ?? 0))
  lines.push({
    key: 'parts',
    label: '구성',
    text: `${score}점 = ${counted.map((p) => `${PART_LABEL[p.key]} 약 ${Math.round(p.points ?? 0)}점`).join(' + ')}${
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

  const pop = population(card, analyses, bank)
  const base = scoreInputsOf(card)
  const usable = pop && pop.matchesCard ? pop : null

  if (usable) {
    const n = usable.unnamed.length
    const k = usable.ranked.length
    const otherMentions = usable.unnamed.filter((a) => a.mentioned).length - k

    // 몰림 — 순위가 매겨진 답 몇 건이 점수 대부분을 낸 주.
    if (k > 0 && k < RANK_FULL_WEIGHT_RESPONSES) {
      const without = aeoScoreOf(withRanked(base, n, otherMentions, []))
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

    // 계단 — 순위 비중이 늘어나는 구간(6건 미만)에서는 1위 답 한 건이 점수를 크게 바꾼다.
    if (k < RANK_FULL_WEIGHT_RESPONSES) {
      const top = Math.min(RANK_FULL_WEIGHT_RESPONSES, Math.max(3, k + 1))
      const steps = Array.from({ length: top + 1 }, (_, j) => `${j}건 ${aeoScoreOf(withRanked(base, n, otherMentions, Array(j).fill(1)))}점`)
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

  // 무엇이 점수를 움직이나 — 같은 식에 한 건 · 1%p를 더해 본 값.
  if (usable) {
    const n = usable.unnamed.length
    const k = usable.ranked.length
    const otherMentions = usable.unnamed.filter((a) => a.mentioned).length - k
    const ranks = usable.ranked.map((a) => a.brandRank as number)
    const now = aeoScoreRaw(withRanked(base, n, otherMentions, ranks))
    const topOne = aeoScoreRaw(withRanked(base, n, otherMentions, [...ranks, 1])) - now
    const plainOne = aeoScoreRaw(withRanked(base, n, otherMentions + 1, ranks)) - now
    const owned = aeoScoreRaw({ ...withRanked(base, n, otherMentions, ranks), brandOwnedCitationRate: base.brandOwnedCitationRate + 0.01 }) - now
    lines.push({
      key: 'effects',
      label: '움직이는 것',
      text: `같은 식으로 셈하면 이번 주에는 이름 없이 물은 질문에서 비교 그룹 이름 중 1위로 추천되는 답 1건이 약 ${pointsText(topOne)}, 순위 없이 불리는 답 1건이 약 ${pointsText(plainOne)}, 자사 출처 인용률 1%p가 약 ${pointsText(owned)}입니다(같은 식으로 낸 값이며 약속이 아닙니다).`,
    })
  }

  // 견주는 구간 — 측정 조건이 바뀐 주 앞의 점수와는 견주지 않는다(앱 전체 규칙 comparability.ts).
  const run = comparableRun(history, card.weekOf)
  const earlier = history.filter((h) => run.length > 0 && h.weekOf < run[0]!.weekOf).sort((a, b) => a.weekOf.localeCompare(b.weekOf))
  if (run.length > 0 && earlier.length > 0) {
    const scores = earlier.map((h) => h.aeoScore.current)
    const lo = Math.min(...scores)
    const hi = Math.max(...scores)
    const change = conditionSummary(compareConditions(earlier.at(-1)!, run[0]!))
    lines.push({
      key: 'segment',
      label: '견주는 구간',
      text: `${weekRangeText(run[0]!.weekOf, run[0]!.weekOf)}부터 측정 조건${change ? `(${change})` : ''}이 달라져, 그 전 점수(${weekRangeText(earlier[0]!.weekOf, earlier.at(-1)!.weekOf)}, ${lo === hi ? `${lo}점` : `${lo}~${hi}점`})와는 견주지 않습니다. ${
        run.length > 1 ? `같은 조건으로 잰 ${runCountText(run)}만 이어서 봅니다.` : '이번 주가 바뀐 조건으로 처음 잰 주입니다.'
      }`,
    })
  }

  return lines
}
