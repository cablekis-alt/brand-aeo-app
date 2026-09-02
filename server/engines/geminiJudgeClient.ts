import { GoogleGenAI } from '@google/genai';
import type { PromptMessage } from '../../src/prompts/types.js';
import type { EngineCallResult, EngineClient } from './types.js';

/**
 * B1/B5/B8 심판용 Gemini 클라이언트. 수집 엔진과 달리 웹 검색 없이 순수 텍스트 추론만 한다.
 * OpenAI/Anthropic 크레딧 없이 파이프라인 전체를 Gemini로 돌릴 때 JUDGE_ENGINE=gemini로 선택된다.
 */
const MODEL = process.env.JUDGE_GEMINI_MODEL?.trim() || process.env.GEMINI_MODEL?.trim() || 'gemini-3.7-flash';

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
      const response = await this.ai.models.generateContent({
        model: MODEL,
        contents: prompt.user,
        config: { systemInstruction: prompt.system },
      });
      return {
        text: response.text ?? '',
        citations: [] as string[],
        usedWebSearch: false,
        tokenUsage: response.usageMetadata?.totalTokenCount,
        latencyMs: Math.round(performance.now() - start),
      };
    } catch {
      // 판정 1건 실패가 테넌트 전체를 멈추지 않도록 빈 텍스트로 강등한다(파서가 null→기본값 처리).
      return { text: '', citations: [], usedWebSearch: false, latencyMs: Math.round(performance.now() - start) };
    }
  }
}
