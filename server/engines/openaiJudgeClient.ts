import OpenAI from 'openai';
import type { PromptMessage } from '../../src/prompts/types.js';
import type { EngineCallResult, EngineClient } from './types.js';
import { withOpenAiRetry } from './retry.js';

/**
 * B1/B5/B8 심판용. 수집 엔진(웹 검색)과 달리 순수 텍스트 추론만 한다.
 * ANTHROPIC_API_KEY가 없을 때 getJudgeClient()가 이 클라이언트로 폴백한다.
 */
function judgeModel(): string {
  const requested = process.env.JUDGE_MODEL?.trim() ?? '';
  if (requested && !requested.toLowerCase().startsWith('claude')) return requested;
  return process.env.OPENAI_MODEL?.trim() || 'gpt-4o';
}

const MODEL = judgeModel();

export class OpenAiJudgeClient implements EngineClient {
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
    const response = await withOpenAiRetry(() =>
      this.client.responses.create({
        model: MODEL,
        instructions: prompt.system,
        input: prompt.user,
      }),
    );
    return {
      text: response.output_text,
      citations: [] as string[],
      usedWebSearch: false,
      tokenUsage: response.usage?.total_tokens,
      latencyMs: Math.round(performance.now() - start),
    };
  }
}
