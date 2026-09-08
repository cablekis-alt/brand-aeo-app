import OpenAI from 'openai';
import type { PromptMessage } from '../../src/prompts/types.js';
import type { EngineCallResult, EngineClient } from './types.js';

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
    const text = (completion.choices?.[0]?.message?.content ?? '').trim();
    // 빈 답변을 "브랜드 미언급" 데이터로 저장하면 언급률이 왜곡되므로 실패로 올려 파이프라인이 건너뛰게 한다.
    if (!text) throw new Error('Perplexity 응답 본문이 비었습니다.');

    return {
      text,
      citations,
      usedWebSearch: citations.length > 0,
      tokenUsage: completion.usage?.total_tokens,
      latencyMs: Math.round(performance.now() - start),
    };
  }
}
