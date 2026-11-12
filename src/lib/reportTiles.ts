import type { QuestionCategory } from '../prompts/types'
import { isScoredAgnostic, withoutProbes } from './questionScope'
import type { QuestionRepeatAnalysis } from './types'

/**
 * 정기진단 보고서 숫자 칸의 「n건 중 m건」 — 언급률 · 자사 인용률을 카드 비율만이 아니라 건수로도 보인다(2026-11-12 사용자
 * 「상세한 점수 표기가 되어야 한눈에」). 건수는 그 주 판정 기록에서 센다 — 서버가 점수를 낼 때와 같은 규칙(server/aggregate.ts
 * aggregateWeeklyMetrics)이라 카드 비율과 어긋나지 않는다:
 *   - 실증 질문(probe)의 응답은 처음부터 뺀다.
 *   - 언급률은 이름 없는 질문(점수에 드는 카테고리 무관 질문)만, 응답 단위.
 *   - 자사 인용률은 모든 질문의 인용 단위(전체 인용 중 자사 소유로 판정된 인용).
 * 판정 기록이나 질문 은행을 못 읽었으면 null — 0건으로 채우지 않는다(미측정 지표 정책).
 */

export interface ReportTileCounts {
  /** 이름 없는 질문의 응답 수 · 그중 우리를 부른 응답 수. */
  mention: { mentioned: number; responses: number }
  /** 모든 질문의 인용 수 · 그중 자사 소유로 판정된 인용 수. */
  citations: { owned: number; total: number }
}

export function reportTileCounts(
  analyses: readonly QuestionRepeatAnalysis[] | null,
  questions: readonly { questionId: string; category: QuestionCategory; probe?: boolean }[] | null,
): ReportTileCounts | null {
  if (!analyses || !questions || analyses.length === 0) return null
  const spec = new Map(questions.map((q) => [q.questionId, q]))
  const all = withoutProbes([...analyses], [...questions])
  const agnostic = all.filter((a) => {
    const q = spec.get(a.questionId)
    return q !== undefined && isScoredAgnostic(q)
  })
  return {
    mention: { mentioned: agnostic.filter((a) => a.mentioned).length, responses: agnostic.length },
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

export function citationDetail(c: ReportTileCounts | null): string | null {
  return c ? `인용 ${c.citations.total.toLocaleString()}건 중 자사 ${c.citations.owned.toLocaleString()}건` : null
}

/** 비율(0~1)을 칸 숫자(%, 소수 한 자리)로. 증감도 이 값끼리 뺀다(%p). */
export const pct1 = (v: number) => Math.round(v * 1000) / 10

/**
 * 점수 몫(src/lib/b9-report.ts scoreBreakdown)을 소수 한 자리로 — 합이 총점과 정확히 같게(2026-11-12 사용자 「그래서 총합 17점」).
 * 각자 반올림하면 1.27 + 15.45 + 0.28이 1.3 + 15.5 + 0.3 = 17.1로 어긋나므로, 남는 차이는 가장 큰 몫에서 맞춘다. 빠진 몫(null — 순위가
 * 없는 주)은 그대로 null이다.
 */
export function roundedPoints<K extends string>(parts: readonly { key: K; points: number | null }[], total: number): Map<K, number | null> {
  const out = new Map<K, number | null>()
  for (const p of parts) out.set(p.key, p.points === null ? null : Math.round(p.points * 10) / 10)
  const present = parts.filter((p) => p.points !== null)
  if (present.length === 0) return out
  const sum = present.reduce((n, p) => n + (out.get(p.key) as number), 0)
  const diff = Math.round((total - sum) * 10) / 10
  if (diff !== 0) {
    const largest = present.reduce((a, b) => ((b.points as number) > (a.points as number) ? b : a))
    out.set(largest.key, Math.round(((out.get(largest.key) as number) + diff) * 10) / 10)
  }
  return out
}
