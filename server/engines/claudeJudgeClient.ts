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
/**
 * 판정 호출 한 번의 대기 상한 — 넘으면 끊고 한 번 더 보낸다(두 번 다 넘으면 빈 결과 = 실패 한 건).
 * 판정에만 건다: 글쓰기(초안 · 다듬기)는 같은 클라이언트를 쓰지만 몇 분씩 걸리는 게 정상이라 상한이 없다(getWriterClient).
 * 실측 Claude 판정 2,280건(2026-W47 세 브랜드): 중앙 1.9초 · p99 17.7초 · 가장 긴 정상 26.5초. 상한이 없을 때 API가 잠깐 멈춘
 * 두 건이 160초씩 붙잡아 스테이,머뭄 측정이 106초 → 350초로 늘었다(2026-11-17).
 */
export const JUDGE_TIMEOUT_MS = Number(process.env.JUDGE_TIMEOUT_MS) || 60_000;

export class ClaudeJudgeClient implements EngineClient {
  private client: Anthropic;
  private readonly model: string;
  /** 없으면 상한 없음(글쓰기). */
  private readonly timeoutMs: number | undefined;

  constructor(model: string = process.env.JUDGE_MODEL ?? DEFAULT_CLAUDE_MODEL, options: { timeoutMs?: number } = {}) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.');
    this.client = new Anthropic({ apiKey });
    this.model = model;
    this.timeoutMs = options.timeoutMs;
  }

  /** 요청 한 번 — signal로 끊을 수 있다. 시험(scripts/verify-judge-timeout.ts)이 이것만 바꿔 끼운다. */
  protected send(prompt: PromptMessage, signal: AbortSignal | undefined): Promise<Anthropic.Beta.BetaMessage> {
    const modern = SUPPORTS_EFFORT_AND_FALLBACK.test(this.model);
    return this.client.beta.messages
      .stream(
        {
          model: this.model,
          max_tokens: MAX_TOKENS,
          system: prompt.system,
          messages: [{ role: 'user', content: prompt.user }],
          // 안전 분류기가 거절하면 같은 호출 안에서 Anthropic이 고른 대체 모델로 이어 답한다.
          // 실제로 답한 모델은 response.model에 실려 와 판정 기록(judgeUsage.model)에 남는다.
          ...(modern
            ? { output_config: { effort: EFFORT }, fallbacks: 'default' as const, betas: ['server-side-fallback-2026-07-01'] }
            : {}),
        },
        signal ? { signal } : undefined,
      )
      .finalMessage();
  }

  /** 상한이 있으면 넘을 때 끊고 한 번 더 보낸다. 다른 오류는 그대로 던진다(SDK가 이미 재시도했다). */
  private async sendWithTimeout(prompt: PromptMessage): Promise<Anthropic.Beta.BetaMessage> {
    const limit = this.timeoutMs;
    if (!limit) return this.send(prompt, undefined);
    for (let attempt = 1; ; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), limit);
      try {
        return await this.send(prompt, controller.signal);
      } catch (err) {
        if (!controller.signal.aborted) throw err;
        if (attempt >= 2) throw new Error(`판정이 ${limit / 1000}초 안에 끝나지 않았습니다(2번 시도)`, { cause: err });
        console.warn(`[claude] ${this.model} 판정이 ${limit / 1000}초를 넘어 끊고 한 번 더 보냅니다`);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  async call(prompt: PromptMessage): Promise<EngineCallResult> {
    const start = performance.now();
    try {
      const response = await this.sendWithTimeout(prompt);

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
