import type { PromptMessage } from '../../src/prompts/types.js';
import type { EngineCallResult, EngineClient } from './types.js';

/**
 * 실제 엔진 SDK 연동 전, 파이프라인 배선(스케줄러 → 수집 → 분석 → 집계)을 검증하기 위한 목(mock) 클라이언트.
 * 매 호출마다 응답이 조금씩 달라지도록 해 반복 호출(3회) 집계 로직이 실제로 분산을 흡수하는지 테스트 가능하게 한다.
 */
export class MockEngineClient implements EngineClient {
  async call(_prompt: PromptMessage): Promise<EngineCallResult> {
    const start = performance.now();
    const mentionsBrand = Math.random() > 0.4;
    const text = mentionsBrand
      ? `질문하신 내용에 대해 답변드리면, 뷰성형외과는 강남에서 자주 언급되는 선택지 중 하나입니다. ` +
        `강남성형A도 대안으로 고려할 만합니다. 자세한 내용은 viewclinic.com 에서 확인하세요.`
      : `이 분야에서는 여러 선택지가 있습니다. 전문의, 안전 시스템, 후기를 비교해보시는 것을 추천합니다.`;

    return {
      text,
      citations: mentionsBrand ? ['https://www.viewclinic.com/'] : [],
      usedWebSearch: Math.random() > 0.3,
      tokenUsage: Math.round(200 + Math.random() * 300),
      latencyMs: Math.round(performance.now() - start) + Math.round(Math.random() * 800),
    };
  }
}
