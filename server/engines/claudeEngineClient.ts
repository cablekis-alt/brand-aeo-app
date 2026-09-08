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
      // Sonnet 5는 thinking을 생략하면 adaptive로 동작하고 그 토큰도 max_tokens를 공유한다.
      // 2048이면 답변이 중간에 잘려 "언급 없음"으로 오판될 수 있어 넉넉히 잡는다.
      max_tokens: 4096,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      // web_search 서버 도구는 모델 세대별로 버전이 다르다 — claude-sonnet-5/opus-5 계열은 _20260209를 쓰고,
      // 구형(Opus 4.6/Sonnet 4.6 이전) 모델만 기본형 _20250305를 쓴다. 세대에 맞지 않으면 400이 난다.
      // (SDK 타입이 서버 도구 버전 문자열을 리터럴로 노출하지 않아 캐스팅)
      tools: [{ type: 'web_search_20260209', name: 'web_search' }] as unknown as Anthropic.Messages.Tool[],
    });

    // 안전 정책상 거부되면 HTTP 200 + stop_reason='refusal'로 빈 본문이 온다.
    // 빈 답변을 "브랜드 미언급" 데이터로 저장하면 언급률이 왜곡되므로, 실패로 올려 파이프라인이 건너뛰게 한다.
    if (response.stop_reason === 'refusal') {
      throw new Error(`Claude가 응답을 거부했습니다 (${response.stop_details?.category ?? 'unknown'}).`);
    }

    const content = response.content as unknown as Array<Record<string, unknown>>;
    const usedWebSearch = content.some((block) => block.type === 'web_search_tool_result');
    const textBlocks = content.filter((block) => block.type === 'text');
    const citations = textBlocks
      .flatMap((block) => (block.citations as Array<Record<string, unknown>>) ?? [])
      .filter((citation) => citation.type === 'web_search_result_location')
      .map((citation) => citation.url as string);

    const text = textBlocks.map((block) => block.text as string).join('\n').trim();
    // 본문이 비면(모델이 도구만 쓰고 답을 못 냈거나 잘린 경우) 분석 대상이 될 수 없다 — 실패로 올려 건너뛴다.
    if (!text) {
      throw new Error(`Claude 응답 본문이 비었습니다 (stop_reason=${response.stop_reason ?? 'unknown'}).`);
    }

    return {
      text,
      citations,
      usedWebSearch,
      tokenUsage: (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0),
      latencyMs: Math.round(performance.now() - start),
    };
  }
}
