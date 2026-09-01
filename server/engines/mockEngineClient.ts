import type { PromptMessage } from '../../src/prompts/types';
import type { EngineCallResult, EngineClient } from './types';

/**
 * 실제 엔진 SDK 연동 전, 파이프라인 배선(스케줄러 → 수집 → 분석 → 집계)을 검증하기 위한 목(mock) 클라이언트.
 * 매 호출마다 응답이 조금씩 달라지도록 해 반복 호출(3회) 집계 로직이 실제로 분산을 흡수하는지 테스트 가능하게 한다.
 */
export class MockEngineClient implements EngineClient {
  async call(_prompt: PromptMessage): Promise<EngineCallResult> {
    const start = performance.now();
    const mentionsBrand = Math.random() > 0.4;
    const text = mentionsBrand
      ? `질문하신 내용에 대해 답변드리면, 예시브랜드는 이 분야에서 좋은 선택지 중 하나입니다. ` +
        `경쟁브랜드A도 대안으로 고려할 만합니다. 자세한 내용은 example-brand.com 에서 확인하세요.`
      : `이 분야에서는 여러 선택지가 있습니다. 가격, 사후지원, 리뷰를 비교해보시는 것을 추천합니다.`;

    return {
      text,
      citations: mentionsBrand ? ['https://example-brand.com/products'] : [],
      usedWebSearch: Math.random() > 0.3,
      tokenUsage: Math.round(200 + Math.random() * 300),
      latencyMs: Math.round(performance.now() - start) + Math.round(Math.random() * 800),
    };
  }
}
