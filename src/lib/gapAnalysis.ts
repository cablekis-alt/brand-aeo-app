import { computeQuestionWinLoss, type WinLossRow } from './questionWinLoss'
import { JOURNEY_STAGES, STAGE_LABEL } from './journeyStage'
import type { QuestionRepeatAnalysis, QuestionSpec } from './types'

/**
 * 격차 분석 — "어디가 비어 있나"를 질문 한 줄 위에서 본다.
 *
 * 질문별 승패(questionWinLoss)는 질문 36개를 줄로 보여준다. 그건 목록이지 결론이 아니다.
 * 무엇을 보강할지 정하려면 묶어서 봐야 한다. 여기서는 세 축으로 묶는다:
 *
 *   카테고리  어떤 **유형의 질문**에서 밀리나 (가격 질문? 비교 질문?)
 *   엔진      어떤 **엔진**에서 안 나오나 (실측: 원진은 ChatGPT 0% · Gemini 50%)
 *   경쟁사    **누가** 우리 자리를 가져갔나
 *
 * 판정 규칙은 새로 만들지 않고 computeQuestionWinLoss를 그대로 쓴다 — 두 화면이 같은 주차에
 * 다른 승패를 보여주면 둘 다 못 믿게 된다. 엔진별 값도 그 함수에 엔진으로 거른 분석을
 * 넣어서 낸다(규칙 복제 없음).
 *
 * 새 API 호출은 없다. 이미 저장된 분석과 질문 은행만으로 계산한다.
 */

/** 묶음 하나의 판정 — 화면이 색과 순서를 정하는 데 쓴다. */
export type GapVerdict = 'gap' | 'mixed' | 'strength'

export interface GapGroup {
  key: string
  label: string
  questions: number
  /** 답을 내놓은 응답 중 브랜드가 언급된 비율. 되물은 응답은 분모에서 빠진다. */
  mentionRate: number
  win: number
  even: number
  loss: number
  unanswered: number
  verdict: GapVerdict
  /** 이 묶음에서 가장 아픈 질문들 — 패 판정을 언급률 낮은 순으로. */
  worst: WinLossRow[]
}

export interface CompetitorGap {
  name: string
  /** 이 경쟁사가 우리보다 많이 언급돼 '패'가 된 질문 수. */
  questionsLost: number
  /** 그 질문들에서 이 경쟁사가 언급된 문장 총합. */
  mentions: number
  /** 예시 질문(최대 3개) — 무엇을 보강할지 바로 보이게. */
  examples: string[]
}

export interface GapAnalysis {
  byCategory: GapGroup[]
  /**
   * 구매 여정 단계(탐색·비교·결정)별. 카테고리가 질문의 형태라면 단계는 고객의 위치다 —
   * 결정 단계에서 밀리면 전환 직전 고객을 놓치는 것이라 같은 '패'라도 무게가 다르다.
   * 순서는 여정 순서(탐색 → 비교 → 결정)로 고정한다. 아픈 순 정렬은 여기서는 의미를 해친다.
   */
  byStage: GapGroup[]
  /** 단계가 은행에 기록되지 않아 문장으로 추정한 질문 수. 0이 아니면 화면이 밝힌다. */
  stageInferredCount: number
  byEngine: GapGroup[]
  competitors: CompetitorGap[]
  /** 전체 질문 수 — 묶음 숫자의 분모를 화면에서 밝히기 위해. */
  totalQuestions: number
}

const CATEGORY_LABEL: Record<string, string> = {
  'category-agnostic': '카테고리 무관',
  'brand-direct': '브랜드 직접',
  comparison: '비교',
  'price-spec': '가격·사양',
  'troubleshooting-review': '문제해결·후기',
  'local-regional': '지역',
}

/**
 * 묶음 판정. 패가 절반을 넘으면 gap, 승이 절반을 넘으면 strength, 그 사이는 mixed.
 * 답을 못 얻은 질문(unanswered)은 분모에 넣지 않는다 — 그건 우리 문제가 아니라
 * 엔진이 되물은 경우다.
 */
function verdictOf(win: number, loss: number, decided: number): GapVerdict {
  if (decided === 0) return 'mixed'
  if (loss / decided > 0.5) return 'gap'
  if (win / decided > 0.5) return 'strength'
  return 'mixed'
}

function summarize(key: string, label: string, rows: WinLossRow[]): GapGroup {
  const win = rows.filter((r) => r.verdict === 'win').length
  const even = rows.filter((r) => r.verdict === 'even').length
  const loss = rows.filter((r) => r.verdict === 'loss').length
  const unanswered = rows.filter((r) => r.verdict === 'unanswered').length
  const answered = rows.reduce((sum, r) => sum + r.answered, 0)
  const mentioned = rows.reduce((sum, r) => sum + r.mentionedRate * r.answered, 0)
  return {
    key,
    label,
    questions: rows.length,
    mentionRate: answered > 0 ? mentioned / answered : 0,
    win,
    even,
    loss,
    unanswered,
    verdict: verdictOf(win, loss, win + even + loss),
    worst: rows
      .filter((r) => r.verdict === 'loss')
      .sort((a, b) => a.mentionedRate - b.mentionedRate)
      .slice(0, 3),
  }
}

/** 아픈 묶음이 위로. gap → mixed → strength, 같은 등급이면 언급률 낮은 순. */
function byPain(a: GapGroup, b: GapGroup): number {
  const order: Record<GapVerdict, number> = { gap: 0, mixed: 1, strength: 2 }
  return order[a.verdict] - order[b.verdict] || a.mentionRate - b.mentionRate
}

export function computeGapAnalysis(
  analyses: QuestionRepeatAnalysis[],
  questions: QuestionSpec[],
): GapAnalysis {
  const rows = computeQuestionWinLoss(analyses, questions)

  // ── 카테고리별 ──
  const byCat = new Map<string, WinLossRow[]>()
  for (const r of rows) {
    const list = byCat.get(r.category) ?? []
    list.push(r)
    byCat.set(r.category, list)
  }
  const byCategory = [...byCat.entries()]
    .map(([key, list]) => summarize(key, CATEGORY_LABEL[key] ?? key, list))
    .sort(byPain)

  // ── 구매 여정 단계별 ── 여정 순서 고정. 비어 있는 단계는 넣지 않는다(은행이 그 단계를 안 만든 것).
  const byStage = JOURNEY_STAGES.map((stage) => summarize(stage, STAGE_LABEL[stage], rows.filter((r) => r.stage === stage))).filter(
    (g) => g.questions > 0,
  )
  const stageInferredCount = rows.filter((r) => r.stageInferred).length

  // ── 엔진별 ── 같은 판정 함수에 엔진으로 거른 분석을 넣는다(규칙 복제 없음).
  const engines = [...new Set(analyses.map((a) => a.engine))]
  const byEngine = engines
    .map((engine) => summarize(engine, engine, computeQuestionWinLoss(analyses.filter((a) => a.engine === engine), questions)))
    .sort(byPain)

  // ── 경쟁사별 ── '패'가 된 질문에서 우리를 앞선 경쟁사만 센다.
  // 전체 언급량이 아니라 **우리 자리를 가져간 횟수**가 알고 싶은 값이다.
  const comp = new Map<string, { questionsLost: number; mentions: number; examples: string[] }>()
  for (const r of rows) {
    if (r.verdict !== 'loss' || !r.topCompetitor) continue
    const entry = comp.get(r.topCompetitor.name) ?? { questionsLost: 0, mentions: 0, examples: [] }
    entry.questionsLost += 1
    entry.mentions += r.topCompetitor.mentions
    if (entry.examples.length < 3) entry.examples.push(r.text)
    comp.set(r.topCompetitor.name, entry)
  }
  const competitors = [...comp.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.questionsLost - a.questionsLost || b.mentions - a.mentions)

  return { byCategory, byStage, stageInferredCount, byEngine, competitors, totalQuestions: rows.length }
}
