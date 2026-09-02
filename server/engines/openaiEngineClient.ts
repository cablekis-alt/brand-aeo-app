import OpenAI from 'openai';
import type { PromptMessage } from '../../src/prompts/types.js';
import type { EngineCallResult, EngineClient } from './types.js';
import { withOpenAiRetry } from './retry.js';

// 2026-09 기준 확인된 값은 아니며, 실제 배포 전 platform.openai.com에서 현재 모델명을 재확인할 것.
const MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o';

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
      tokenUsage: response.usage?.total_tokens,
      latencyMs: Math.round(performance.now() - start),
    };
  }
}
