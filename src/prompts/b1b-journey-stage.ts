import type { PromptMessage, QuestionSpec } from './types';

/**
 * 구매 여정 단계 — 질문이 고객 여정의 어디에 있는가.
 *
 *   learn     탐색. 아직 무엇을 사야 할지 모른다. "코수술 병원 고를 때 뭘 봐야 해?"
 *   consider  비교. 후보를 고르는 중. "눈재수술 잘하는 곳 추천해줘", "A랑 B 중 뭐가 나아?"
 *   decide    결정. 특정 선택을 확인한다. "여기 가격대 얼마야?", "후기 어때?", "예약 어떻게 해?"
 *
 * 왜 카테고리와 따로 두나. 카테고리(무관·비교·가격…)는 **질문의 형태**를 말하고, 단계는
 * **고객의 위치**를 말한다. 카테고리 무관 22문항 안에 탐색과 비교가 섞여 있어서 카테고리에서
 * 단계를 기계적으로 뽑을 수 없다. 결정 단계에서 밀린다는 것은 전환 직전 고객을 놓친다는 뜻이라,
 * 같은 '패'라도 무게가 다르다 — 그래서 격차 분석에 별도 축으로 올린다.
 *
 * 은행을 새로 만들 때는 생성 프롬프트가 함께 매기고(b1-question-bank), 단계가 없는 옛 은행은
 * 이 프롬프트로 한 번에 보정한다. 둘 다 없으면 화면은 inferStageHeuristic으로 임시 추정하되
 * '추정'임을 밝힌다.
 */
export type JourneyStage = 'learn' | 'consider' | 'decide';
export const JOURNEY_STAGES: readonly JourneyStage[] = ['learn', 'consider', 'decide'];
export const STAGE_LABEL: Record<JourneyStage, string> = { learn: '탐색', consider: '비교', decide: '결정' };

export function isJourneyStage(value: unknown): value is JourneyStage {
  return value === 'learn' || value === 'consider' || value === 'decide';
}

/**
 * 판정 없이 문장 형태로 추정한다. 은행에 stage가 없을 때만 쓰는 임시 값이며 정확도는 대략적이다.
 * 규칙은 위에서 아래로 첫 일치 — 결정 신호(가격·예약·후기·할까)가 가장 구체적이라 먼저 본다.
 */
export function inferStageHeuristic(text: string): JourneyStage {
  const t = text.replace(/\s+/g, ' ');
  if (/(가격|비용|얼마|예약|할인|이벤트|후기|평판|믿을|괜찮|할까|해도 될|가치 있|추천할 만)/.test(t)) return 'decide';
  if (/(추천|어디|어느|비교|vs|중에|랑 |이랑|보다|나아|나은|리스트|순위|잘하는|유명한|좋은 곳)/.test(t)) return 'consider';
  return 'learn';
}

/** 은행 하나를 한 번의 호출로 태깅한다. 응답은 questionId → stage 배열. */
export function buildJourneyStagePrompt(questions: Pick<QuestionSpec, 'questionId' | 'text'>[]): PromptMessage {
  const system = `당신은 소비자 구매 여정 분류자입니다. 각 질문이 고객 여정의 어느 단계인지 하나만 고릅니다.

정의:
- "learn"    탐색 — 무엇을 알아야 하는지, 기준이 무엇인지 묻는다. 아직 후보를 고르지 않았다.
             예: "코수술 병원 고를 때 뭘 봐야 해?", "안면윤곽이 뭐야?"
- "consider" 비교 — 후보를 고르거나 비교한다. 추천·순위·A vs B.
             예: "눈재수술 잘하는 곳 추천해줘", "A랑 B 중 뭐가 나아?"
- "decide"   결정 — 특정 선택을 확정하기 직전의 확인. 가격·예약·후기·괜찮은지.
             예: "여기 안면윤곽 가격대 얼마야?", "A 후기 어때?", "지금 예약해도 될까?"

규칙: 질문 문장만 보고 판단한다. 브랜드명 포함 여부는 단계와 무관하다(브랜드명이 있어도 비교일 수 있다).
출력은 아래 JSON 배열만. 설명·마크다운·코드블록 금지.
[{ "questionId": string, "stage": "learn" | "consider" | "decide" }]`;
  const user = questions.map((q) => `${q.questionId}\t${q.text}`).join('\n');
  return { system, user };
}
