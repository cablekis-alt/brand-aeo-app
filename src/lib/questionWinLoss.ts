import { normalizeTopic } from '../prompts/b1c-question-topic'
import { stageOf, type JourneyStage } from './journeyStage'
import type { QuestionRepeatAnalysis, QuestionSpec } from './types'

// 질문(프롬프트) 단위 승패 집계 — 이번 주 응답(질문 × 엔진 × 반복)에서
// 어떤 질문에서 브랜드가 언급되고(승), 경쟁사에 밀리거나 미언급인지(패)를 본다.
// 새 데이터 수집 없이 기존 판정(QuestionRepeatAnalysis)만으로 계산한다.
// 'unanswered' = 엔진이 답 대신 되물어(예: "어느 지역을 찾으시나요?") 브랜드가 언급될 기회
// 자체가 없었던 질문. "경쟁에서 밀림(패)"과 진단이 다르므로 분리한다 — 이쪽은 질문 설계 문제다.
export type WinLossVerdict = 'win' | 'even' | 'loss' | 'unanswered'

export interface WinLossRow {
  questionId: string
  text: string
  category: string
  /** 구매 여정 단계와 그것이 추정값인지. */
  stage: JourneyStage
  stageInferred: boolean
  /** 콘텐츠 주제. 은행에 없으면 undefined — 화면이 '미분류'로 묶고 그 수를 밝힌다. */
  topic?: string
  responses: number // 이 질문에 대한 응답(엔진×반복) 수
  clarifying: number // 그중 되물은 응답 수(답을 내놓지 않음)
  answered: number // 실제로 답을 내놓은 응답 수 = responses - clarifying
  mentionedRate: number // 0~1, **답한 응답 중** 브랜드가 언급된 비율(되물은 응답은 분모에서 제외)
  brandMentions: number // 브랜드 언급 문장 총합
  topCompetitor: { name: string; mentions: number } | null // 이 질문에서 가장 많이 언급된 경쟁사
  avgRank: number | null // 추천 순위 평균(1=최상위)
  sentiment: { pos: number; neu: number; neg: number } // 브랜드 언급 문장 감성 분포
  verdict: WinLossVerdict
}

function verdictOf(
  answered: number,
  mentionedRate: number,
  brandMentions: number,
  topCompetitor: WinLossRow['topCompetitor'],
): WinLossVerdict {
  if (answered === 0) return 'unanswered' // 전부 되물음 — 언급될 기회가 없었다
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
    // 되물은 응답은 "답한 것"이 아니므로 언급률 분모에서 뺀다(0%로 깎지 않는다).
    const answeredList = list.filter((a) => !a.clarifying)
    const clarifying = responses - answeredList.length
    const answered = answeredList.length
    const mentionedCount = answeredList.filter((a) => a.mentioned).length
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

    const mentionedRate = answered > 0 ? mentionedCount / answered : 0
    const spec = textById.get(questionId)
    rows.push({
      questionId,
      text: spec?.text ?? questionId,
      category: spec?.category ?? '',
      ...(() => { const st = stageOf({ text: spec?.text ?? '', stage: spec?.stage }); return { stage: st.stage, stageInferred: st.inferred } })(),
      topic: normalizeTopic(spec?.topic),
      responses,
      clarifying,
      answered,
      mentionedRate,
      brandMentions,
      topCompetitor,
      avgRank,
      sentiment,
      verdict: verdictOf(answered, mentionedRate, brandMentions, topCompetitor),
    })
  }

  // 패 → 무응답 → 무 → 승 순으로(개선이 필요한 질문을 위로), 같은 등급이면 언급률 낮은 순.
  const order: Record<WinLossVerdict, number> = { loss: 0, unanswered: 1, even: 2, win: 3 }
  return rows.sort((a, b) => order[a.verdict] - order[b.verdict] || a.mentionedRate - b.mentionedRate)
}
