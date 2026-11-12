import { MIN_SOM_MENTIONS } from '../prompts/b8-report'
import type { QuestionCategory } from '../prompts/types'
import { isScoredAgnostic, withoutProbes } from './questionScope'
import type { QuestionRepeatAnalysis } from './types'

/**
 * 정기진단 보고서 숫자 칸의 「n건 중 m건」 — 언급률 · 언급 점유율 · 자사 인용률을 카드 비율만이 아니라 건수로도 보인다(2026-11-12 사용자
 * 「상세한 점수 표기가 되어야 한눈에」). 건수는 그 주 판정 기록에서 센다 — 서버가 점수를 낼 때와 같은 규칙(server/aggregate.ts
 * aggregateWeeklyMetrics)이라 카드 비율과 어긋나지 않는다:
 *   - 실증 질문(probe)의 응답은 처음부터 뺀다.
 *   - 언급률 · 점유율은 이름 없는 질문(점수에 드는 카테고리 무관 질문)만 — 언급률은 응답 단위, 점유율은 언급 횟수 단위.
 *   - 자사 인용률은 모든 질문의 인용 단위(전체 인용 중 자사 소유로 판정된 인용).
 * 판정 기록이나 질문 은행을 못 읽었으면 null — 0건으로 채우지 않는다(미측정 지표 정책).
 */

export interface ReportTileCounts {
  /** 이름 없는 질문의 응답 수 · 그중 우리를 부른 응답 수. */
  mention: { mentioned: number; responses: number }
  /**
   * 이름 없는 질문의 답에서 우리 · 경쟁사가 불린 횟수. 점유율은 경쟁사 목록이 있고 합이 MIN_SOM_MENTIONS 이상일 때만 낸다
   * (카드 shareOfMention과 같은 문턱) — 아니면 measurable false.
   */
  share: { brand: number; total: number; measurable: boolean }
  /** 모든 질문의 인용 수 · 그중 자사 소유로 판정된 인용 수. */
  citations: { owned: number; total: number }
}

export function reportTileCounts(
  analyses: readonly QuestionRepeatAnalysis[] | null,
  questions: readonly { questionId: string; category: QuestionCategory; probe?: boolean }[] | null,
  hasCompetitors: boolean,
): ReportTileCounts | null {
  if (!analyses || !questions || analyses.length === 0) return null
  const spec = new Map(questions.map((q) => [q.questionId, q]))
  const all = withoutProbes([...analyses], [...questions])
  const agnostic = all.filter((a) => {
    const q = spec.get(a.questionId)
    return q !== undefined && isScoredAgnostic(q)
  })
  const brand = agnostic.reduce((n, a) => n + a.mentionSentences.length, 0)
  const competitors = agnostic.reduce((n, a) => n + a.competitorMentions.reduce((t, c) => t + c.mentionCount, 0), 0)
  const total = brand + competitors
  return {
    mention: { mentioned: agnostic.filter((a) => a.mentioned).length, responses: agnostic.length },
    share: { brand, total, measurable: hasCompetitors && total > 0 && total >= MIN_SOM_MENTIONS },
    citations: {
      owned: all.reduce((n, a) => n + a.citations.filter((c) => c.ownerType === 'brand-owned').length, 0),
      total: all.reduce((n, a) => n + a.citations.length, 0),
    },
  }
}

/** 칸 아래 작은 줄 — 「이름 없는 질문 응답 144건 중 0건」 등. 건수를 모르면 null. */
export function mentionDetail(c: ReportTileCounts | null): string | null {
  return c ? `이름 없는 질문 응답 ${c.mention.responses.toLocaleString()}건 중 ${c.mention.mentioned.toLocaleString()}건` : null
}

export function shareDetail(c: ReportTileCounts | null): string | null {
  if (!c) return null
  if (!c.share.measurable) {
    return c.share.total === 0 ? '이름 없는 질문 답에 브랜드 언급이 없음' : `브랜드 언급 ${c.share.total}회 — ${MIN_SOM_MENTIONS}회 미만이라 판정하지 않음`
  }
  return `브랜드 언급 ${c.share.total.toLocaleString()}회 중 우리 ${c.share.brand.toLocaleString()}회`
}

export function citationDetail(c: ReportTileCounts | null): string | null {
  return c ? `인용 ${c.citations.total.toLocaleString()}건 중 자사 ${c.citations.owned.toLocaleString()}건` : null
}

/** 비율(0~1)을 칸 숫자(%, 소수 한 자리)로. 증감도 이 값끼리 뺀다(%p). */
export const pct1 = (v: number) => Math.round(v * 1000) / 10
