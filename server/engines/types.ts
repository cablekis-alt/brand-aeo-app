import type { PromptMessage } from '../../src/prompts/types.js';

export interface EngineCallResult {
  text: string;
  /*
   * 이 호출에 실제로 쓴 모델. 나중에 조회하지 않고 호출한 쪽이 실어 보낸다 — 설정을 따로
   * 읽으면 "측정할 때 쓴 모델"이 아니라 "지금 설정된 모델"이 기록돼, 중간에 바꾸면 어긋난다.
   */
  model?: string;
  citations: string[]; // 엔진 API가 구조화된 필드로 반환한 URL
  usedWebSearch: boolean;
  /** 입력+출력 합계. 아래 둘을 못 받는 엔진도 있어 합계는 그대로 남긴다. */
  tokenUsage?: number;
  /*
   * 입력·출력을 나눠 기록한다. 합계만으로는 비용을 알 수 없다 — 출력 토큰이 입력보다
   * 몇 배 비싸고, 엔진마다 비중이 완전히 다르다. 실측(W38): ChatGPT는 토큰의 93%가
   * 입력(웹검색 결과가 컨텍스트로 들어간다)이고 Perplexity는 84%가 출력이다.
   * 같은 "100만 토큰"이 엔진에 따라 몇 배 차이 나는 금액이 된다.
   */
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
}

export interface EngineClient {
  call(prompt: PromptMessage): Promise<EngineCallResult>;
}
