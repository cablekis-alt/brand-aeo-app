import Anthropic from '@anthropic-ai/sdk';
import type { PromptMessage } from '../../src/prompts/types';
import type { EngineCallResult, EngineClient } from './types';

const JUDGE_MODEL = process.env.JUDGE_MODEL ?? 'claude-opus-5';

/**
 * B1(질문 생성)/B5(분석)/B8(리포트) 전용 고정 모델.
 * 수집용 4개 엔진과 반드시 분리해야 분석기 자체의 변동이 주간 지표 노이즈에 섞이지 않는다
 * (docs/prompt-design.md 2절). 웹 검색이 필요 없는 순수 텍스트 추론이므로 도구를 붙이지 않는다.
 */
export class ClaudeJudgeClient implements EngineClient {
  private client: Anthropic;

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.');
    this.client = new Anthropic({ apiKey });
  }

  async call(prompt: PromptMessage): Promise<EngineCallResult> {
    const start = performance.now();
    const response = await this.client.messages.create({
      model: JUDGE_MODEL,
      max_tokens: 4096,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    return {
      text,
      citations: [],
      usedWebSearch: false,
      tokenUsage: (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0),
      latencyMs: Math.round(performance.now() - start),
    };
  }
}
