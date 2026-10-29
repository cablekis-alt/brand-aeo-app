import { GoogleGenAI, ThinkingLevel } from '@google/genai';
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

/**
 * 생각 수준. 기본 LOW — 생각 토큰은 출력 단가로 청구되는데(3.8 Flash 기본 MEDIUM이면 호출당 약 800토큰), 2026-10-29 비교 측정
 * (DB손해보험, 보통 4회 · 낮음 2회)에서 이름 없는 질문 언급 · 순위 · 점수가 같은 설정을 다시 잰 흔들림 안이었고 비용은 약 46% 줄었다.
 * GEMINI_THINKING_LEVEL로 MINIMAL · LOW · MEDIUM · HIGH를 고르고, DEFAULT면 보내지 않아 모델 기본값을 쓴다.
 */
export function resolveThinkingLevel(raw: string | undefined): ThinkingLevel | undefined {
  const v = raw?.trim().toUpperCase();
  if (!v) return ThinkingLevel.LOW;
  if (v === 'DEFAULT') return undefined;
  if (v !== ThinkingLevel.THINKING_LEVEL_UNSPECIFIED && (Object.values(ThinkingLevel) as string[]).includes(v)) return v as ThinkingLevel;
  console.warn(`[gemini] GEMINI_THINKING_LEVEL=${raw}을(를) 알 수 없어 LOW로 잽니다.`);
  return ThinkingLevel.LOW;
}
const THINKING_LEVEL = resolveThinkingLevel(process.env.GEMINI_THINKING_LEVEL);

/**
 * 기록할 모델 — 응답이 알려 준 실제 모델(modelVersion)에 생각 수준을 붙인다. 주소로 보낸 이름을 적으면 실제와 어긋난다:
 * gemini-3.7-flash는 2026-08-13 중단 뒤 3.8 Flash로 자동 처리되는데 기록에는 3.7로 남았다. 생각 수준도 답을 바꿀 수 있는
 * 측정 조건이라 「같은 조건」(comparability 수집 모델)이 갈라 보게 함께 적는다.
 */
export function geminiModelLabel(modelVersion: string | undefined, requested: string, level: ThinkingLevel | undefined): string {
  const model = modelVersion?.trim() || requested;
  return level ? `${model} (thinking ${level.toLowerCase()})` : model;
}

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
            ...(THINKING_LEVEL ? { thinkingConfig: { thinkingLevel: THINKING_LEVEL } } : {}),
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
    }, 2, { label: 'gemini' });

    const grounding = response.candidates?.[0]?.groundingMetadata;
    const citations = (grounding?.groundingChunks ?? [])
      .map((chunk) => chunk.web?.uri)
      .filter((uri): uri is string => Boolean(uri));

    return {
      text: response.text ?? '',
      citations,
      usedWebSearch: citations.length > 0 || Boolean(grounding?.webSearchQueries?.length),
      model: geminiModelLabel(response.modelVersion, MODEL, THINKING_LEVEL),
      tokenUsage: response.usageMetadata?.totalTokenCount,
      inputTokens: response.usageMetadata?.promptTokenCount,
      outputTokens: response.usageMetadata?.candidatesTokenCount,
      thoughtTokens: response.usageMetadata?.thoughtsTokenCount ?? 0,
      latencyMs: Math.round(performance.now() - start),
    };
  }
}
