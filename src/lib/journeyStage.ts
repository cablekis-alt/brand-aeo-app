import { inferStageHeuristic, isJourneyStage, type JourneyStage } from '../prompts/b1b-journey-stage'
import type { QuestionSpec } from './types'

export { STAGE_LABEL, JOURNEY_STAGES, type JourneyStage } from '../prompts/b1b-journey-stage'

/**
 * 질문의 구매 여정 단계. 은행에 기록된 값이 있으면 그것, 없으면 문장 형태로 추정한다.
 * inferred가 true면 화면이 "추정"이라고 밝혀야 한다 — 추정을 실측처럼 보이게 두지 않는다.
 */
export function stageOf(q: Pick<QuestionSpec, 'text' | 'stage'>): { stage: JourneyStage; inferred: boolean } {
  if (isJourneyStage(q.stage)) return { stage: q.stage, inferred: false }
  return { stage: inferStageHeuristic(q.text), inferred: true }
}
