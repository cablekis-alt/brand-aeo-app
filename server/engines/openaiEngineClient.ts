import OpenAI from 'openai';
import type { PromptMessage } from '../../src/prompts/types.js';
import type { EngineCallResult, EngineClient } from './types.js';
import { withOpenAiRetry } from './retry.js';

/*
 * 기본 모델. 설치본은 이 값을 쓴다 — 모델은 bundled.env에 굽지 않으므로(prepare-bundled-env의
 * CONFIG_WHITELIST에 없다) env로 덮지 않으면 여기가 곧 측정에 쓰이는 모델이다.
 *
 * 고르는 기준은 성능이 아니라 "ChatGPT 사용자가 지금 보는 답과 가까운가"다. 우리가 재는 것은
 * AI 답변 속 브랜드 노출이지 최고 품질의 답이 아니다. GPT-6 Luna는 2026-09-22 출시와 함께
 * 무료·Go 사용자에게 먼저 풀렸다.
 *
 * 이력: gpt-4o → gpt-5.6-luna → gpt-6-luna. 비용은 웹검색 수수료($0.01/호출)가 대부분이라
 * 모델 단가를 낮춰도 총액은 조금만 준다(5.6-luna 대비 토큰 단가 절반, 호출당 총액 약 13% 감소).
 * gpt-6-sol은 호출당 약 2.8배 비싸고, 그 품질 향상은 우리가 재는 값과 무관해 쓰지 않는다.
 *
 * 실제 수집 경로(buildEngineCallPrompt → 이 클라이언트)로 확인했다: 웹검색·인용·모델 기록 정상.
 * 같은 질문에서 5.6-luna보다 검색 본문을 더 많이 가져오고(입력 토큰 +30~48%) 답변이 짧으며
 * 인용 수가 적었다(표본 2문항). 인용이 줄면 자사 인용률이 더 흔들리므로 첫 측정에서 확인할 것.
 */
export const MODEL = process.env.OPENAI_MODEL ?? 'gpt-6-luna';

export class OpenAiEngineClient implements EngineClient {
  private client: OpenAI;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY 환경변수가 설정되지 않았습니다.');
    // 멈춘 호출이 SDK 기본 타임아웃(10분)까지 슬롯을 붙잡지 않도록 90초로 제한.
    // 재시도는 withOpenAiRetry가 담당하므로 SDK 자체 재시도는 끈다.
    this.client = new OpenAI({ apiKey, timeout: 90_000, maxRetries: 0 });
  }

  async call(prompt: PromptMessage): Promise<EngineCallResult> {
    const start = performance.now();
    // web_search 도구는 Responses API에서만 지원된다 (chat.completions에는 없음).
    const response = await withOpenAiRetry(() =>
      this.client.responses.create({
        model: MODEL,
        instructions: prompt.system,
        input: prompt.user,
        tools: [{ type: 'web_search' }],
      }),
    );

    // SDK 타입이 tool-call/message 판별 유니온을 세밀하게 노출하지 않아 방어적으로 any 처리한다.
    const output = response.output as unknown as Array<Record<string, unknown>>;
    const usedWebSearch = output.some((item) => item.type === 'web_search_call' && item.status === 'completed');
    const citations = output
      .filter((item) => item.type === 'message')
      .flatMap((item) => (item.content as Array<Record<string, unknown>>) ?? [])
      .flatMap((content) => (content.annotations as Array<Record<string, unknown>>) ?? [])
      .filter((annotation) => annotation.type === 'url_citation')
      .map((annotation) => annotation.url as string);

    return {
      text: response.output_text,
      citations,
      usedWebSearch,
      model: MODEL,
      tokenUsage: response.usage?.total_tokens,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
      latencyMs: Math.round(performance.now() - start),
    };
  }
}
