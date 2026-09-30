import { GoogleGenAI } from '@google/genai';
import type { PromptMessage } from '../../src/prompts/types.js';
import type { EngineCallResult, EngineClient } from './types.js';
import { judgeTemperature } from './judgeSampling.js';
import { withOpenAiRetry } from './retry.js';

/**
 * B1/B5/B8 심판용 Gemini 클라이언트. 수집 엔진과 달리 웹 검색 없이 순수 텍스트 추론만 한다.
 * OpenAI/Anthropic 크레딧 없이 파이프라인 전체를 Gemini로 돌릴 때 JUDGE_ENGINE=gemini로 선택된다.
 */
const MODEL = process.env.JUDGE_GEMINI_MODEL?.trim() || process.env.GEMINI_MODEL?.trim() || 'gemini-3.7-flash';

/**
 * 판정 호출 한 번의 대기 상한. 전에는 상한이 없어 응답 없는 판정 한 건이 측정을 붙잡을 수 있었다.
 * 수집(90초)보다 넉넉하게 둔다 — 판정이 실패하면 빈 응답으로 강등되고 파서가 "언급 없음" 같은
 * 기본값으로 받아, 너무 짧으면 점수가 조용히 틀어진다.
 * 실측 판정 약 2만 건: 중앙 2~7초 · p99 14~22초 · 120초 초과 1건(198.8초). 두 번까지 시도한다.
 */
const TIMEOUT_MS = Number(process.env.GEMINI_JUDGE_TIMEOUT_MS) || 120_000;

export class GeminiJudgeClient implements EngineClient {
  private ai: GoogleGenAI;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY 환경변수가 설정되지 않았습니다.');
    this.ai = new GoogleGenAI({ apiKey });
  }

  async call(prompt: PromptMessage): Promise<EngineCallResult> {
    const start = performance.now();
    try {
      const response = await withOpenAiRetry(async () => {
        try {
          return await this.ai.models.generateContent({
            model: MODEL,
            contents: prompt.user,
            // 온도를 0으로 고정한다 — 판정은 측정 도구이므로 같은 입력에 같은 답이 나와야 한다
            // (judgeSampling.ts의 실측 근거 참고). undefined면 파라미터를 보내지 않는다.
            config: {
              systemInstruction: prompt.system,
              temperature: judgeTemperature(),
              httpOptions: { timeout: TIMEOUT_MS },
            },
          });
        } catch (err) {
          // SDK의 시간 초과(AbortError)를 재시도 규칙(retry.ts)이 알아보는 문구로 바꾼다.
          if (err instanceof Error && err.name === 'AbortError') {
            throw new Error(`Gemini judge request timeout after ${TIMEOUT_MS}ms`, { cause: err });
          }
          throw err;
        }
      }, 2);
      return {
        text: response.text ?? '',
        citations: [] as string[],
        usedWebSearch: false,
        model: MODEL,
        tokenUsage: response.usageMetadata?.totalTokenCount,
        inputTokens: response.usageMetadata?.promptTokenCount,
        outputTokens: response.usageMetadata?.candidatesTokenCount,
        latencyMs: Math.round(performance.now() - start),
      };
    } catch {
      // 판정 1건 실패가 테넌트 전체를 멈추지 않도록 빈 텍스트로 강등한다(파서가 null→기본값 처리).
      return { text: '', citations: [], usedWebSearch: false, latencyMs: Math.round(performance.now() - start) };
    }
  }
}
