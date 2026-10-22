import type { PromptMessage } from '../../src/prompts/types.js';
import type { EngineCallOptions, EngineCallResult, EngineClient } from './types.js';

/**
 * 실제 엔진 SDK 연동 전, 파이프라인 배선(스케줄러 → 수집 → 분석 → 집계)을 검증하기 위한 목(mock) 클라이언트.
 * 매 호출마다 응답이 조금씩 달라지도록 해 반복 호출(3회) 집계 로직이 실제로 분산을 흡수하는지 테스트 가능하게 한다.
 */
/**
 * 시험용 — MOCK_ENGINE_FAIL=gemini:spend-cap처럼 주면 그 엔진의 가짜 호출이 실제 엔진과 같은 문구의 오류를 낸다
 * (scripts/verify-engine-exhaustion.ts). 실제 엔진을 소진시키지 않고 「끊긴 엔진」 처리를 확인한다.
 * MOCK_ENGINE_DELAY_MS를 주면 호출마다 그만큼 기다린다 — 진행 중 상태(측정 상태 화면의 칩)를 볼 틈을 만든다.
 */
const MOCK_FAILURE_MESSAGE: Record<string, string> = {
  'spend-cap':
    '{"error":{"code":429,"message":"Your project has exceeded its monthly spending cap. Please go to AI Studio at https://ai.studio/spend to manage your project spend cap.","status":"RESOURCE_EXHAUSTED"}}',
  credits: '429 You exceeded your current quota, please check your plan and billing details. (insufficient_quota)',
};

export class MockEngineClient implements EngineClient {
  private readonly engine?: string;

  constructor(engine?: string) {
    this.engine = engine;
  }

  async call(_prompt: PromptMessage, options?: EngineCallOptions): Promise<EngineCallResult> {
    // 막힌 엔진은 기다리지 않고 바로 거절한다 — 실제 엔진도 지출 한도 · 크레딧 오류는 곧바로 돌려준다.
    const [failEngine, failKind] = (process.env.MOCK_ENGINE_FAIL ?? '').split(':');
    if (failEngine && failEngine === this.engine) throw new Error(MOCK_FAILURE_MESSAGE[failKind ?? ''] ?? 'mock failure');
    // 가짜 엔진은 슬롯을 거치지 않으므로 여기서 「보냄」을 알린다(진행 표시 시험).
    options?.onSend?.();
    // 기다린 시간도 응답 시간에 넣는다 — 진행 표시의 남은 시간 어림이 실제 엔진처럼 응답 시간을 본다.
    const start = performance.now();
    const delayMs = Number(process.env.MOCK_ENGINE_DELAY_MS) || 0;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
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
