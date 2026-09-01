import type { PromptMessage } from '../../src/prompts/types';

export interface EngineCallResult {
  text: string;
  citations: string[]; // 엔진 API가 구조화된 필드로 반환한 URL
  usedWebSearch: boolean;
  tokenUsage?: number;
  latencyMs?: number;
}

export interface EngineClient {
  call(prompt: PromptMessage): Promise<EngineCallResult>;
}
