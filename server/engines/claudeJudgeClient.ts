import Anthropic from '@anthropic-ai/sdk';
import type { PromptMessage } from '../../src/prompts/types.js';
import type { EngineCallResult, EngineClient } from './types.js';

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
    // temperature를 보내지 않는다 — 현행 Claude 모델(Opus 5·4.8·4.7, Sonnet 5, Fable 5 계열)은
    // temperature·top_p·top_k를 400으로 거부한다. 기본 JUDGE_MODEL이 claude-opus-5라
    // 넣으면 판정이 전부 실패한다. 자세한 사정은 engines/judgeSampling.ts 주석 참고.
    // 결과적으로 판단 엔진을 Claude로 두면 판정 노이즈를 고정할 수 없다(기본은 Gemini).
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
