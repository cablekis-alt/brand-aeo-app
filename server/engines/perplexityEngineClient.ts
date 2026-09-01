import OpenAI from 'openai';
import type { PromptMessage } from '../../src/prompts/types';
import type { EngineCallResult, EngineClient } from './types';

const MODEL = process.env.PERPLEXITY_MODEL ?? 'sonar-pro';

/**
 * Perplexity API는 OpenAI 호환 스펙(base URL만 다름)이라 별도 SDK 없이 openai 패키지를 재사용한다.
 * 단, citations/search_results는 OpenAI 타입 정의에 없는 Perplexity 전용 확장 필드라 any로 다룬다.
 */
export class PerplexityEngineClient implements EngineClient {
  private client: OpenAI;

  constructor() {
    const apiKey = process.env.PERPLEXITY_API_KEY;
    if (!apiKey) throw new Error('PERPLEXITY_API_KEY 환경변수가 설정되지 않았습니다.');
    this.client = new OpenAI({ apiKey, baseURL: 'https://api.perplexity.ai' });
  }

  async call(prompt: PromptMessage): Promise<EngineCallResult> {
    const start = performance.now();
    const completion = (await this.client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
    })) as unknown as {
      choices: { message: { content: string | null } }[];
      citations?: string[];
      search_results?: { url: string }[];
      usage?: { total_tokens?: number };
    };

    const citations = completion.search_results?.map((r) => r.url) ?? completion.citations ?? [];

    return {
      text: completion.choices[0].message.content ?? '',
      citations,
      usedWebSearch: citations.length > 0,
      tokenUsage: completion.usage?.total_tokens,
      latencyMs: Math.round(performance.now() - start),
    };
  }
}
