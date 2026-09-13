import type { PromptMessage, QuestionSpec } from './types';

/**
 * 주제 — 질문이 **무엇에 관한 것인가**.
 *
 * 왜 카테고리·여정 단계로는 부족한가. 카테고리(무관·비교·가격…)는 질문의 형태이고, 단계는
 * 고객의 위치다. 둘 다 "어떤 내용에서 밀리는가"에는 답하지 못한다. 실측(k-wonjin)에서
 * category-agnostic 22문항은 한 덩어리로 묶이는데, 그 안에 눈·코·안면윤곽·가격이 다 섞여 있다.
 * 카테고리로 보면 "무관에서 밀린다"가 전부라 보강할 콘텐츠를 정할 수 없다.
 *
 * 주제는 업종마다 다르므로 고정 목록을 둘 수 없다. 그래서 판정 호출이 **집합 자체를 만들고**
 * 동시에 각 질문을 배정한다. 다만 주 단위 비교가 되려면 집합이 흔들리면 안 되므로,
 * 이미 은행에 있는 주제는 그대로 재사용하게 프롬프트에 넣어 준다(questionTopic.ts).
 *
 * 개수 상한을 두는 이유. 36문항을 12주제로 쪼개면 주제당 3문항이라 언급률의 표준오차가
 * 커져 어느 주제가 아픈지 구분되지 않는다. 4~7개면 주제당 5~9문항이 된다.
 */

/** 주제가 없는 질문을 담는 자리. 판정이 안 된 것을 '기타'로 섞지 않는다. */
export const TOPIC_UNSET = '미분류';

/** 화면·집계에서 쓰는 정규화. 앞뒤 공백·중복 공백·따옴표를 없애고 길이를 제한한다. */
export function normalizeTopic(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.replace(/\s+/g, ' ').replace(/^["'`]|["'`]$/g, '').trim();
  if (!t || t === TOPIC_UNSET) return undefined;
  return t.slice(0, 24);
}

/** 이 질문 목록에 이미 붙어 있는 주제들(중복 제거, 등장 순). */
export function existingTopics(questions: Pick<QuestionSpec, 'topic'>[]): string[] {
  const seen = new Set<string>();
  for (const q of questions) {
    const t = normalizeTopic(q.topic);
    if (t) seen.add(t);
  }
  return [...seen];
}

export const TOPIC_MIN = 4;
export const TOPIC_MAX = 7;

/**
 * 은행 하나를 한 번의 호출로 주제 배정한다. 응답은 questionId → topic 배열.
 * reuse에 든 주제가 있으면 새 이름을 만들지 말고 그것을 쓰게 한다 — 주차 간 비교를 위해서다.
 */
export function buildQuestionTopicPrompt(
  questions: Pick<QuestionSpec, 'questionId' | 'text'>[],
  reuse: string[],
  industry: string,
): PromptMessage {
  const reuseBlock =
    reuse.length > 0
      ? `\n이미 쓰고 있는 주제(가능하면 **그대로 재사용**하라. 주차 간 비교가 깨진다):\n${reuse.map((t) => `- ${t}`).join('\n')}\n새 주제는 위 목록 중 어느 것에도 들어맞지 않을 때만 만든다.`
      : '';

  const system = `당신은 ${industry} 분야의 검색 질문을 주제로 묶는 분류자입니다.
주어진 질문들을 내용에 따라 ${TOPIC_MIN}~${TOPIC_MAX}개의 주제로 묶고, 각 질문에 주제 하나를 배정하세요.

주제를 정하는 규칙:
1. 주제는 **콘텐츠 하나를 쓸 수 있는 단위**여야 한다. 질문의 형태(비교인가 가격인가)가 아니라
   내용(무엇에 관한 이야기인가)으로 묶는다.
2. 한국어 명사구로 짧게 쓴다(12자 이내 권장). 예: "눈 성형", "가격·비용", "회복·부작용".
3. 주제 개수는 ${TOPIC_MIN}개 이상 ${TOPIC_MAX}개 이하. 질문 하나짜리 주제를 만들지 마라 —
   가까운 주제에 합친다.
4. "기타", "일반", "전체" 같은 뭉뚱그린 이름은 금지한다. 그런 질문은 가장 가까운 주제에 넣는다.
5. 모든 질문에 빠짐없이 주제를 배정한다.${reuseBlock}

출력은 아래 JSON 배열만. 설명·마크다운·코드블록 금지.
[{ "questionId": string, "topic": string }]`;

  const user = questions.map((q) => `${q.questionId}\t${q.text}`).join('\n');
  return { system, user };
}
