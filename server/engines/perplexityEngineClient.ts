import OpenAI from 'openai';
import type { PromptMessage } from '../../src/prompts/types.js';
import type { EngineCallResult, EngineClient } from './types.js';
import { withOpenAiRetry } from './retry.js';

/**
 * 프리셋 — Sonar Chat Completions를 대신한다.
 *
 * Perplexity가 Sonar Chat Completions를 **2026년 9월 27일**에 종료하고 Agent API로 옮겼다.
 * 공식 이행표에서 sonar-pro의 대응은 프리셋 `low`다(sonar→fast, sonar-pro→low,
 * sonar-reasoning-pro→medium, sonar-deep-research→high).
 *
 * 프리셋은 모델을 고정하지 않는다 — 어떤 모델을 쓸지는 Perplexity가 정하고 바뀔 수 있다.
 * 그래서 기록에 남기는 "모델"은 응답이 알려 준 실제 모델이 아니라 **우리가 고른 것**
 * (preset:low)으로 둔다. 응답의 모델을 그대로 남기면 Perplexity가 내부적으로 모델을 바꿀
 * 때마다 주차 비교가 "모델이 달라 비교 불가"로 막혀 버린다 — 우리가 바꾼 것이 아닌데도.
 *
 * PERPLEXITY_MODEL을 지정하면 프리셋 대신 그 모델을 직접 쓴다(예: openai/gpt-5.6-sol).
 */
const PINNED_MODEL = process.env.PERPLEXITY_MODEL?.trim() ?? '';
const PRESET = process.env.PERPLEXITY_PRESET?.trim() || 'low';

/** 화면·기록에 쓰는 이름. 모델을 못 박았으면 그 이름, 아니면 고른 프리셋. */
export const MODEL = PINNED_MODEL || `preset:${PRESET}`;

/** Agent API 응답 — OpenAI Responses 형식이되 search_results 항목과 usage.cost가 더 있다. */
interface AgentResponse {
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
    results?: Array<{ url?: string }>;
    queries?: string[];
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    // Perplexity는 실제 청구액을 응답에 담아 준다 — 추정하지 않고 그대로 쓴다.
    cost?: { total_cost?: number; currency?: string };
  };
}

/**
 * Perplexity Agent API는 OpenAI Responses API와 호환이라 openai 패키지를 그대로 쓴다.
 * base URL 끝에 /v1을 반드시 붙여야 한다(Agent API 요건). preset은 OpenAI 타입에 없는
 * Perplexity 전용 파라미터라 공식 문서대로 캐스팅해 넘긴다.
 */
export class PerplexityEngineClient implements EngineClient {
  private client: OpenAI;

  constructor() {
    const apiKey = process.env.PERPLEXITY_API_KEY;
    if (!apiKey) throw new Error('PERPLEXITY_API_KEY 환경변수가 설정되지 않았습니다.');
    /*
     * 타임아웃을 못 박는다. 기본값은 SDK의 10분이고 자체 재시도가 2회라, 멈춘 호출 하나가
     * 수집 슬롯 24개 중 하나를 최대 30분 묶는다. 2026-W39에서 실제로 한 건이 179.6초를
     * 잡아 그 테넌트만 71/72에서 홀로 남았다(중앙값 15.3초, p99 62.5초).
     *
     * 120초는 관측 p99의 약 두 배다 — 정상 호출은 자르지 않으면서 멈춘 호출만 끊는다.
     * Agent API는 검색과 URL 읽기를 함께 하므로 OpenAI 쪽 90초보다 넉넉하게 둔다.
     *
     * 재시도는 withOpenAiRetry로 옮긴다. SDK 재시도를 그냥 끄면 429까지 같이 없어진다.
     * 횟수는 3회로 줄인다 — 기본 6회면 최악 12분이라 캡을 둔 의미가 사라진다.
     */
    this.client = new OpenAI({
      apiKey,
      baseURL: 'https://api.perplexity.ai/v1',
      timeout: 120_000,
      maxRetries: 0,
    });
  }

  async call(prompt: PromptMessage): Promise<EngineCallResult> {
    const start = performance.now();
    const body: Record<string, unknown> = {
      instructions: prompt.system,
      input: prompt.user,
    };
    if (PINNED_MODEL) body.model = PINNED_MODEL;
    else body.preset = PRESET;

    const response = (await withOpenAiRetry(
      () => (this.client.responses.create as unknown as (b: unknown) => Promise<unknown>)(body),
      3,
    )) as AgentResponse;

    const output = response.output ?? [];
    const search = output.filter((item) => item.type === 'search_results');
    const citations = search.flatMap((item) => (item.results ?? []).map((r) => r.url).filter((u): u is string => Boolean(u)));

    const text = (
      response.output_text ??
      output
        .filter((item) => item.type === 'message')
        .flatMap((item) => item.content ?? [])
        .map((c) => c.text ?? '')
        .join('')
    ).trim();
    // 빈 답변을 "브랜드 미언급" 데이터로 저장하면 언급률이 왜곡되므로 실패로 올려 파이프라인이 건너뛰게 한다.
    if (!text) throw new Error('Perplexity 응답 본문이 비었습니다.');

    return {
      text,
      citations,
      // 검색을 실제로 돌렸는지는 질의(queries)로 본다 — 인용이 0건이어도 검색은 했을 수 있다.
      usedWebSearch: search.some((item) => (item.queries?.length ?? 0) > 0) || citations.length > 0,
      model: MODEL,
      tokenUsage: response.usage?.total_tokens,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
      // 실제 청구액. 단가로 곱해 추정하지 않아도 되는 유일한 엔진이다.
      billedCost: response.usage?.cost?.total_cost,
      latencyMs: Math.round(performance.now() - start),
    };
  }
}
