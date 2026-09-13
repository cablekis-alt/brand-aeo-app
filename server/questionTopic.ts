import {
  buildQuestionTopicPrompt,
  existingTopics,
  isBrandTopic,
  normalizeTopic,
  TOPIC_MAX,
} from '../src/prompts/b1c-question-topic.js';
import type { QuestionSpec } from '../src/prompts/types.js';
import type { EngineClient } from './engines/types.js';
import { parseJsonLoose } from './jsonParse.js';

export interface TopicTagResult {
  questions: QuestionSpec[];
  /** 상호가 이름이 되어 버린 주제 배정을 몇 건 되돌렸는지. 화면이 밝힌다. */
  brandTopicsDropped: number;
}

/**
 * topic이 없는 문항만 골라 한 번의 판정 호출로 배정한다. 이미 있는 값은 건드리지 않는다.
 * 단 **상호가 이름이 된 주제는 예외로 걷어낸다** — 프롬프트를 고치기 전에 매긴 은행을
 * 다시 돌리면 고쳐지도록(실측: 제이준성형외과 은행에 "제이준성형외과" 주제가 생겼다).
 *
 * 이미 쓰고 있는 주제를 프롬프트에 넣어 재사용하게 한다 — 주차마다 이름이 흔들리면
 * 주제별 추이를 볼 수 없다. 응답이 깨지거나 일부만 오면 받은 것만 채운다. 여정 단계와 달리
 * 추정 폴백이 없으므로 못 받은 문항은 화면에서 '미분류'로 남고, 그 수를 밝힌다.
 */
export async function tagQuestionTopics(
  questions: QuestionSpec[],
  judge: EngineClient,
  industry: string,
  names: string[] = [],
): Promise<TopicTagResult> {
  // 1) 상호가 이름이 된 기존 주제를 먼저 비운다. 그래야 아래에서 '없는 것'으로 잡혀 다시 매겨진다.
  let brandTopicsDropped = 0;
  const cleaned = questions.map((q) => {
    const t = normalizeTopic(q.topic);
    if (t && isBrandTopic(t, names)) {
      brandTopicsDropped += 1;
      return { ...q, topic: undefined };
    }
    return q;
  });

  const missing = cleaned.filter((q) => !normalizeTopic(q.topic));
  if (missing.length === 0) return { questions: cleaned, brandTopicsDropped };

  const reuse = existingTopics(cleaned);
  const result = await judge.call(buildQuestionTopicPrompt(missing, reuse, industry, names));
  const parsed = parseJsonLoose<Array<{ questionId?: string; topic?: string }>>(result.text) ?? [];

  const byId = new Map<string, string>();
  for (const row of parsed) {
    const topic = normalizeTopic(row?.topic);
    if (!row?.questionId || !topic) continue;
    // 2) 지시를 흘려 다시 상호를 써 온 경우. 억지로 바꾸지 않고 버린다 — '미분류'로 남으면
    //    화면이 그 수를 밝히고 다시 매길 수 있다. 잘못 붙인 주제는 없는 것만 못하다.
    if (isBrandTopic(topic, names)) continue;
    byId.set(row.questionId, topic);
  }

  // 상한을 넘겨 왔으면 문항이 적은 주제부터 버린다. 억지로 합치지 않는다.
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

  return {
    questions: cleaned.map((q) =>
      normalizeTopic(q.topic) ? q : byId.has(q.questionId) ? { ...q, topic: byId.get(q.questionId) } : q,
    ),
    brandTopicsDropped,
  };
}
