import Anthropic from '@anthropic-ai/sdk';
import type { PromptMessage } from '../../src/prompts/types.js';
import type { EngineCallResult, EngineClient } from './types.js';

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';

/**
 * 출력 한도. 생각(추론) 토큰도 여기에 들어간다.
 *
 * 예전 4,096은 판정 비교(2026-10-13, 교보생명 W40)에서 인용 30~40개짜리 Perplexity 응답의 인용 분류를
 * 잘랐다 — 그 응답의 인용 목록이 통째로 빠졌다(Opus 5.5 120건, Sonnet 5.5 150건). 글쓰기(초안)는 더 길다.
 * 이만큼 크면 비스트리밍 요청은 시간 초과에 걸리므로 스트리밍으로 받는다.
 */
const MAX_TOKENS = 64000;

/**
 * 추론 강도. 판정 비교에 쓴 값(Opus 5.5 기본값)을 명시해 둔다 — 모델 기본값이 바뀌어도 판정·글이 흔들리지 않게.
 */
const EFFORT = 'medium' as const;

/** 추론 강도·거절 시 대체 모델을 받는 모델(5세대). 그 밖의 모델에 보내면 400이거나 효과가 없다. */
const SUPPORTS_EFFORT_AND_FALLBACK = /^claude-(opus-5|fable-5|sonnet-5-5)/;

/**
 * Claude 판정·글쓰기 클라이언트 — 판정 엔진(JUDGE_ENGINE=claude)과 글쓰기 엔진(WRITER_ENGINE=claude)이 같이 쓴다.
 * 웹 검색이 필요 없는 텍스트 작업이라 도구를 붙이지 않는다.
 *
 * temperature를 보내지 않는다 — 현행 Claude 모델은 temperature·top_p·top_k를 400으로 거부한다
 * (engines/judgeSampling.ts). 그래서 Claude로는 판정 노이즈를 고정할 수 없다(측정 판정 기본은 Gemini).
 *
 * 실패는 빈 텍스트로 강등한다(Gemini 판정과 같다) — 한 건 실패가 측정 전체를 멈추지 않게 하고, 빈 응답이
 * 줄줄이 쌓이면 engines/index.ts의 guarded가 측정을 멈춘다. 대신 이유는 반드시 로그에 남긴다.
 */
export class ClaudeJudgeClient implements EngineClient {
  private client: Anthropic;
  private readonly model: string;

  constructor(model: string = process.env.JUDGE_MODEL ?? DEFAULT_CLAUDE_MODEL) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.');
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async call(prompt: PromptMessage): Promise<EngineCallResult> {
    const start = performance.now();
    const modern = SUPPORTS_EFFORT_AND_FALLBACK.test(this.model);
    try {
      const response = await this.client.beta.messages
        .stream({
          model: this.model,
          max_tokens: MAX_TOKENS,
          system: prompt.system,
          messages: [{ role: 'user', content: prompt.user }],
          // 안전 분류기가 거절하면 같은 호출 안에서 Anthropic이 고른 대체 모델로 이어 답한다.
          // 실제로 답한 모델은 response.model에 실려 와 판정 기록(judgeUsage.model)에 남는다.
          ...(modern
            ? { output_config: { effort: EFFORT }, fallbacks: 'default' as const, betas: ['server-side-fallback-2026-07-01'] }
            : {}),
        })
        .finalMessage();

      const base = {
        citations: [] as string[],
        usedWebSearch: false,
        model: response.model,
        tokenUsage: response.usage.input_tokens + response.usage.output_tokens,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        latencyMs: Math.round(performance.now() - start),
      };
      if (response.stop_reason === 'max_tokens' || response.stop_reason === 'refusal') {
        // 잘린 JSON·거절 문구를 결과로 넘기면 파서가 기본값으로 흡수해 조용히 빈 판정이 된다 — 실패로 돌린다.
        console.error(
          `[claude] ${response.model} ${response.stop_reason === 'max_tokens' ? `출력 한도(${MAX_TOKENS})에 걸려 잘림` : `거절(${response.stop_details?.category ?? '분류 없음'})`} — 이 호출은 실패로 처리합니다`,
        );
        return { ...base, text: '' };
      }
      const text = response.content
        .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      return { ...base, text };
    } catch (err) {
      console.error(`[claude] ${this.model} 호출 실패 — 빈 결과로 처리합니다:`, err instanceof Error ? err.message : err);
      return { text: '', citations: [], usedWebSearch: false, model: this.model, latencyMs: Math.round(performance.now() - start) };
    }
  }
}
