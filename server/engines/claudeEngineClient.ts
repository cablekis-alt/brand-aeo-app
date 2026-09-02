import Anthropic from '@anthropic-ai/sdk';
import type { PromptMessage } from '../../src/prompts/types.js';
import type { EngineCallResult, EngineClient } from './types.js';

const MODEL = process.env.CLAUDE_MODEL ?? 'claude-sonnet-5';

export class ClaudeEngineClient implements EngineClient {
  private client: Anthropic;

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.');
    this.client = new Anthropic({ apiKey });
  }

  async call(prompt: PromptMessage): Promise<EngineCallResult> {
    const start = performance.now();
    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      // claude-opus-5/claude-sonnet-5 등 최신 모델은 web_search_20260318로 도메인/지역 필터링이 가능하지만,
      // 4개 엔진 결과를 동일 조건으로 비교하기 위해 가장 폭넓게 지원되는 기본 버전만 사용한다.
      // (SDK 타입 정의가 서버 도구 버전 문자열을 리터럴로 노출하지 않아 any로 캐스팅)
      tools: [{ type: 'web_search_20250305', name: 'web_search' }] as unknown as Anthropic.Messages.Tool[],
    });

    const content = response.content as unknown as Array<Record<string, unknown>>;
    const usedWebSearch = content.some((block) => block.type === 'web_search_tool_result');
    const textBlocks = content.filter((block) => block.type === 'text');
    const citations = textBlocks
      .flatMap((block) => (block.citations as Array<Record<string, unknown>>) ?? [])
      .filter((citation) => citation.type === 'web_search_result_location')
      .map((citation) => citation.url as string);

    return {
      text: textBlocks.map((block) => block.text as string).join('\n'),
      citations,
      usedWebSearch,
      tokenUsage: (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0),
      latencyMs: Math.round(performance.now() - start),
    };
  }
}
