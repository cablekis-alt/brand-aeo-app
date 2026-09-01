import { GoogleGenAI } from '@google/genai';
import type { PromptMessage } from '../../src/prompts/types';
import type { EngineCallResult, EngineClient } from './types';

// 2026-09 기준 확인된 값은 아니며, 실제 배포 전 ai.google.dev에서 현재 모델명을 재확인할 것.
const MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.7-flash';

export class GeminiEngineClient implements EngineClient {
  private ai: GoogleGenAI;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY 환경변수가 설정되지 않았습니다.');
    this.ai = new GoogleGenAI({ apiKey });
  }

  async call(prompt: PromptMessage): Promise<EngineCallResult> {
    const start = performance.now();
    const response = await this.ai.models.generateContent({
      model: MODEL,
      contents: prompt.user,
      config: {
        systemInstruction: prompt.system,
        tools: [{ googleSearch: {} }],
      },
    });

    const grounding = response.candidates?.[0]?.groundingMetadata;
    const citations = (grounding?.groundingChunks ?? [])
      .map((chunk) => chunk.web?.uri)
      .filter((uri): uri is string => Boolean(uri));

    return {
      text: response.text ?? '',
      citations,
      usedWebSearch: citations.length > 0 || Boolean(grounding?.webSearchQueries?.length),
      tokenUsage: response.usageMetadata?.totalTokenCount,
      latencyMs: Math.round(performance.now() - start),
    };
  }
}
