import type { QuestionRepeatAnalysis, QuestionSpec } from './types'

// 질문(프롬프트) 단위 승패 집계 — 이번 주 응답(질문 × 엔진 × 반복)에서
// 어떤 질문에서 브랜드가 언급되고(승), 경쟁사에 밀리거나 미언급인지(패)를 본다.
// 새 데이터 수집 없이 기존 판정(QuestionRepeatAnalysis)만으로 계산한다.
export type WinLossVerdict = 'win' | 'even' | 'loss'

export interface WinLossRow {
  questionId: string
  text: string
  category: string
  responses: number // 이 질문에 대한 응답(엔진×반복) 수
  mentionedRate: number // 0~1, 브랜드가 언급된 응답 비율
  brandMentions: number // 브랜드 언급 문장 총합
  topCompetitor: { name: string; mentions: number } | null // 이 질문에서 가장 많이 언급된 경쟁사
  avgRank: number | null // 추천 순위 평균(1=최상위)
  sentiment: { pos: number; neu: number; neg: number } // 브랜드 언급 문장 감성 분포
  verdict: WinLossVerdict
}

function verdictOf(mentionedRate: number, brandMentions: number, topCompetitor: WinLossRow['topCompetitor']): WinLossVerdict {
  if (mentionedRate === 0) return 'loss' // 아예 언급 안 됨
  if (topCompetitor && topCompetitor.mentions > brandMentions) return 'loss' // 경쟁사가 더 많이 언급됨
  if (mentionedRate >= 0.5 && (!topCompetitor || brandMentions >= topCompetitor.mentions)) return 'win'
  return 'even'
}

export function computeQuestionWinLoss(
  analyses: QuestionRepeatAnalysis[],
  questions: QuestionSpec[],
): WinLossRow[] {
  const textById = new Map(questions.map((q) => [q.questionId, q]))
  const byQuestion = new Map<string, QuestionRepeatAnalysis[]>()
  for (const a of analyses) {
    const list = byQuestion.get(a.questionId) ?? []
    list.push(a)
    byQuestion.set(a.questionId, list)
  }

  const rows: WinLossRow[] = []
  for (const [questionId, list] of byQuestion) {
    const responses = list.length
    const mentionedCount = list.filter((a) => a.mentioned).length
    const brandMentions = list.reduce((s, a) => s + a.mentionSentences.length, 0)

    const compTotals = new Map<string, number>()
    for (const a of list) {
      for (const c of a.competitorMentions) compTotals.set(c.name, (compTotals.get(c.name) ?? 0) + c.mentionCount)
    }
    const topCompetitor =
      compTotals.size > 0
        ? [...compTotals.entries()].sort((x, y) => y[1] - x[1]).map(([name, mentions]) => ({ name, mentions }))[0]
        : null

    const ranks = list.map((a) => a.brandRank).filter((r): r is number => r !== null)
    const avgRank = ranks.length > 0 ? ranks.reduce((s, r) => s + r, 0) / ranks.length : null

    const sentiment = { pos: 0, neu: 0, neg: 0 }
    for (const a of list) {
      for (const m of a.mentionSentences) {
        if (m.sentiment === 'positive') sentiment.pos += 1
        else if (m.sentiment === 'negative') sentiment.neg += 1
        else sentiment.neu += 1
      }
    }

    const mentionedRate = responses > 0 ? mentionedCount / responses : 0
    const spec = textById.get(questionId)
    rows.push({
      questionId,
      text: spec?.text ?? questionId,
      category: spec?.category ?? '',
      responses,
      mentionedRate,
      brandMentions,
      topCompetitor,
      avgRank,
      sentiment,
      verdict: verdictOf(mentionedRate, brandMentions, topCompetitor),
    })
  }

  // 패 → 무 → 승 순으로(개선이 필요한 질문을 위로), 같은 등급이면 언급률 낮은 순.
  const order: Record<WinLossVerdict, number> = { loss: 0, even: 1, win: 2 }
  return rows.sort((a, b) => order[a.verdict] - order[b.verdict] || a.mentionedRate - b.mentionedRate)
}
