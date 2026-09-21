import OpenAI from 'openai';
import type { PromptMessage } from '../../src/prompts/types.js';
import type { EngineCallResult, EngineClient } from './types.js';
import { withOpenAiRetry } from './retry.js';

/*
 * 기본 모델. 설치본은 이 값을 쓴다 — 모델은 bundled.env에 굽지 않으므로(prepare-bundled-env의
 * CONFIG_WHITELIST에 없다) env로 덮지 않으면 여기가 곧 측정에 쓰이는 모델이다.
 *
 * gpt-4o에서 옮겼다. 2024년 모델이라 지금 ChatGPT 사용자가 보는 답과 멀어졌고, 우리 사용량
 * 기준으로 토큰 비용이 10배 이상 비쌌다(실측 W38 추정: gpt-4o $51.9 vs luna $16.1).
 * 웹검색 도구가 동작하는 것을 실제 호출로 확인했다.
 */
export const MODEL = process.env.OPENAI_MODEL ?? 'gpt-5.6-luna';

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
