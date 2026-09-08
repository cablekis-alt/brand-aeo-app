import type { QuestionRepeatAnalysis, QuestionSpec } from './types'
import type { Engine } from '../prompts/types'

// 감성 대시보드 집계 — 브랜드 언급 문장의 긍/중/부 분포를 전체·엔진별·질문별로 나누고,
// 부정 언급 문장을 드릴다운할 수 있게 모은다. 새 수집 없이 기존 판정 데이터만 사용한다.
export interface SentimentCounts {
  pos: number
  neu: number
  neg: number
  total: number
}

export interface EngineSentiment extends SentimentCounts {
  engine: Engine
}

export interface QuestionSentiment extends SentimentCounts {
  questionId: string
  text: string
}

export interface NegativeMention {
  engine: Engine
  questionId: string
  text: string // 질문 문구
  sentence: string // 부정 언급 문장
}

export interface SentimentSummary {
  overall: SentimentCounts
  byEngine: EngineSentiment[]
  byQuestion: QuestionSentiment[] // 부정 비율 높은 순
  negatives: NegativeMention[]
}

const empty = (): SentimentCounts => ({ pos: 0, neu: 0, neg: 0, total: 0 })
function add(c: SentimentCounts, s: 'positive' | 'neutral' | 'negative') {
  if (s === 'positive') c.pos += 1
  else if (s === 'negative') c.neg += 1
  else c.neu += 1
  c.total += 1
}
export function negRate(c: SentimentCounts): number {
  return c.total > 0 ? c.neg / c.total : 0
}
export function posRate(c: SentimentCounts): number {
  return c.total > 0 ? c.pos / c.total : 0
}

export function computeSentiment(
  analyses: QuestionRepeatAnalysis[],
  questions: QuestionSpec[],
): SentimentSummary {
  const textById = new Map(questions.map((q) => [q.questionId, q.text]))
  const overall = empty()
  const engineMap = new Map<Engine, SentimentCounts>()
  const questionMap = new Map<string, SentimentCounts>()
  const negatives: NegativeMention[] = []

  for (const a of analyses) {
    const eng = engineMap.get(a.engine) ?? empty()
    const q = questionMap.get(a.questionId) ?? empty()
    for (const m of a.mentionSentences) {
      add(overall, m.sentiment)
      add(eng, m.sentiment)
      add(q, m.sentiment)
      if (m.sentiment === 'negative') {
        negatives.push({
          engine: a.engine,
          questionId: a.questionId,
          text: textById.get(a.questionId) ?? a.questionId,
          sentence: m.sentence,
        })
      }
    }
    engineMap.set(a.engine, eng)
    questionMap.set(a.questionId, q)
  }

  const byEngine: EngineSentiment[] = [...engineMap.entries()]
    .map(([engine, c]) => ({ engine, ...c }))
    .sort((x, y) => y.total - x.total)

  const byQuestion: QuestionSentiment[] = [...questionMap.entries()]
    .map(([questionId, c]) => ({ questionId, text: textById.get(questionId) ?? questionId, ...c }))
    .filter((q) => q.total > 0)
    .sort((x, y) => negRate(y) - negRate(x) || y.neg - x.neg)

  return { overall, byEngine, byQuestion, negatives }
}
