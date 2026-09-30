import { GoogleGenAI } from '@google/genai';
import type { PromptMessage } from '../../src/prompts/types.js';
import type { EngineCallResult, EngineClient } from './types.js';
import { withOpenAiRetry } from './retry.js';

// 2026-09 기준 확인된 값은 아니며, 실제 배포 전 ai.google.dev에서 현재 모델명을 재확인할 것.
export const MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.7-flash';

/**
 * 호출 한 번의 대기 상한. 전에는 상한이 없어서, 응답이 오지 않는 호출 한 건이 수집 전체를
 * 붙잡았다(실측 2026-09-30 더스완 측정: 72건 중 71건에서 5분 넘게 멈춤). 수집은 모든 호출이
 * 끝나야 다음 단계로 넘어간다.
 * 실측 W38~W40 수집 2,490건: 중앙 9.8초 · p99 18.4초 · 최대 47초 — 그 두 배 남짓으로 잡는다.
 * 두 번까지 시도하므로 최악 약 3분, 그래도 실패하면 그 호출만 건너뛴다(pipeline.ts collectRawCalls).
 */
const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 90_000;

export class GeminiEngineClient implements EngineClient {
  private ai: GoogleGenAI;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY 환경변수가 설정되지 않았습니다.');
    this.ai = new GoogleGenAI({ apiKey });
  }

  async call(prompt: PromptMessage): Promise<EngineCallResult> {
    const start = performance.now();
    const response = await withOpenAiRetry(async () => {
      try {
        return await this.ai.models.generateContent({
          model: MODEL,
          contents: prompt.user,
          config: {
            systemInstruction: prompt.system,
            tools: [{ googleSearch: {} }],
            httpOptions: { timeout: TIMEOUT_MS },
          },
        });
      } catch (err) {
        // SDK는 시간 초과를 AbortError("This operation was aborted")로 던진다 — 재시도 규칙(retry.ts)이
        // 알아보지 못하는 문구라, 알아보는 문구로 바꿔 던진다.
        if (err instanceof Error && err.name === 'AbortError') {
          throw new Error(`Gemini request timeout after ${TIMEOUT_MS}ms`, { cause: err });
        }
        throw err;
      }
    }, 2);

    const grounding = response.candidates?.[0]?.groundingMetadata;
    const citations = (grounding?.groundingChunks ?? [])
      .map((chunk) => chunk.web?.uri)
      .filter((uri): uri is string => Boolean(uri));

    return {
      text: response.text ?? '',
      citations,
      usedWebSearch: citations.length > 0 || Boolean(grounding?.webSearchQueries?.length),
      model: MODEL,
      tokenUsage: response.usageMetadata?.totalTokenCount,
      inputTokens: response.usageMetadata?.promptTokenCount,
      outputTokens: response.usageMetadata?.candidatesTokenCount,
      latencyMs: Math.round(performance.now() - start),
    };
  }
}
