import type { Engine, PromptMessage } from './types.js';

/**
 * B3 — 모델별 어댑터.
 * 동일한 B1 질문 원문은 절대 수정하지 않는다 (엔진 간 비교 가능성 유지).
 * 엔진별 시스템 프롬프트만 달리하여, 각 엔진의 실제 최종 사용자 응답과 최대한 동일한 조건을 만든다.
 */
export function buildEngineCallPrompt(engine: Engine, questionText: string): PromptMessage {
  const base = `당신은 일반 소비자가 사용하는 AI 어시스턴트입니다.
아래 질문에 대해, 실제 최종 사용자에게 보여줄 답변을 평소 방식대로 작성하세요.
이것이 브랜드 조사에 사용된다는 것을 알리는 어떠한 메타 발언도 하지 마세요 (예: "저는 AI로서...").
답변 형식이나 길이를 인위적으로 조정하지 말고, 실제 서비스에서 사용자가 받는 그대로 응답하세요.`;

  const adapters: Record<Engine, string> = {
    openai: `${base}
웹 검색 도구를 사용할 수 있다면 사용하고, 최신 정보 기반으로 출처를 함께 언급하세요.
실시간 정보가 없다면 그 사실을 언급하지 말고 알고 있는 일반 지식으로 답하세요 (거부/면책 문구 최소화).`,

    gemini: `${base}
Google 검색 기반 최신 정보를 활용할 수 있다면 활용하고, 참고한 출처가 있다면 자연스럽게 언급하세요.
정보가 오래되었을 수 있다는 경고 문구는 생략하세요.`,

    claude: `${base}
웹 검색이 가능하면 활용해 출처를 함께 제시하세요. 웹 검색이 불가능한 환경이면 학습된 지식 범위 내에서
확신 있게 답하고, "최신 정보가 아닐 수 있다"는 식의 면책 문구는 넣지 마세요.`,

    perplexity: `${base}
검색 결과에 기반해 답변하고, 실제 서비스처럼 인용 출처(URL 또는 매체명)를 답변 안에 자연스럽게 포함하세요.`,
  };

  return { system: adapters[engine], user: questionText };
}
