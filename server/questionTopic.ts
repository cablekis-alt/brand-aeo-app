import {
  buildQuestionTopicPrompt,
  existingTopics,
  normalizeTopic,
  TOPIC_MAX,
} from '../src/prompts/b1c-question-topic.js';
import type { QuestionSpec } from '../src/prompts/types.js';
import type { EngineClient } from './engines/types.js';
import { parseJsonLoose } from './jsonParse.js';

/**
 * topic이 없는 문항만 골라 한 번의 판정 호출로 배정한다. 이미 있는 값은 건드리지 않는다.
 *
 * 이미 쓰고 있는 주제를 프롬프트에 넣어 재사용하게 한다 — 주차마다 이름이 흔들리면
 * 주제별 추이를 볼 수 없다. 응답이 깨지거나 일부만 오면 받은 것만 채운다. 여정 단계와 달리
 * 추정 폴백이 없으므로 못 받은 문항은 화면에서 '미분류'로 남고, 그 수를 밝힌다.
 */
export async function tagQuestionTopics(
  questions: QuestionSpec[],
  judge: EngineClient,
  industry: string,
): Promise<QuestionSpec[]> {
  const missing = questions.filter((q) => !normalizeTopic(q.topic));
  if (missing.length === 0) return questions;

  const reuse = existingTopics(questions);
  const result = await judge.call(buildQuestionTopicPrompt(missing, reuse, industry));
  const parsed = parseJsonLoose<Array<{ questionId?: string; topic?: string }>>(result.text) ?? [];

  const byId = new Map<string, string>();
  for (const row of parsed) {
    const topic = normalizeTopic(row?.topic);
    if (row?.questionId && topic) byId.set(row.questionId, topic);
  }

  // 상한을 넘겨 왔으면 문항이 적은 주제부터 버린다. 억지로 합치지 않는다 — 잘못 합치면
  // 화면이 거짓말을 하게 되고, 버려진 문항은 '미분류'로 남아 다시 매길 수 있다.
  const count = new Map<string, number>();
  for (const t of byId.values()) count.set(t, (count.get(t) ?? 0) + 1);
  for (const t of reuse) if (!count.has(t)) count.set(t, 0); // 기존 주제는 유지 대상
  if (count.size > TOPIC_MAX) {
    const keep = new Set(
      [...count.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, TOPIC_MAX)
        .map(([t]) => t),
    );
    for (const [id, t] of byId) if (!keep.has(t)) byId.delete(id);
  }

  return questions.map((q) =>
    normalizeTopic(q.topic) ? q : byId.has(q.questionId) ? { ...q, topic: byId.get(q.questionId) } : q,
  );
}
