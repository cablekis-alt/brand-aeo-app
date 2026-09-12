import { buildJourneyStagePrompt, isJourneyStage } from '../src/prompts/b1b-journey-stage.js';
import type { QuestionSpec } from '../src/prompts/types.js';
import type { EngineClient } from './engines/types.js';
import { parseJsonLoose } from './jsonParse.js';

/**
 * stage가 없는 문항만 골라 한 번의 판정 호출로 매긴다. 이미 있는 값은 건드리지 않는다.
 * 응답이 깨지거나 일부만 오면 받은 것만 채우고 나머지는 undefined로 둔다 — 화면이 '추정'으로
 * 밝히며 폴백하므로 여기서 억지로 채우지 않는다.
 */
export async function tagJourneyStages(questions: QuestionSpec[], judge: EngineClient): Promise<QuestionSpec[]> {
  const missing = questions.filter((q) => !isJourneyStage(q.stage));
  if (missing.length === 0) return questions;
  const result = await judge.call(buildJourneyStagePrompt(missing));
  const parsed = parseJsonLoose<Array<{ questionId?: string; stage?: string }>>(result.text) ?? [];
  const byId = new Map<string, QuestionSpec['stage']>();
  for (const row of parsed) {
    if (row?.questionId && isJourneyStage(row.stage)) byId.set(row.questionId, row.stage);
  }
  return questions.map((q) => (isJourneyStage(q.stage) ? q : byId.has(q.questionId) ? { ...q, stage: byId.get(q.questionId) } : q));
}
