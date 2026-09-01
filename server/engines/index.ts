import type { Engine } from '../../src/prompts/types';
import { ClaudeEngineClient } from './claudeEngineClient';
import { ClaudeJudgeClient } from './claudeJudgeClient';
import { GeminiEngineClient } from './geminiEngineClient';
import { MockEngineClient } from './mockEngineClient';
import { MockJudgeClient } from './mockJudgeClient';
import { OpenAiEngineClient } from './openaiEngineClient';
import { OpenAiJudgeClient } from './openaiJudgeClient';
import { PerplexityEngineClient } from './perplexityEngineClient';
import type { EngineClient } from './types';

// 로컬 개발/파이프라인 배선 테스트 시 실제 API 키 없이 돌리기 위한 탈출구.
// (docs/prompt-design.md 8절 스모크 테스트 참고)
const USE_MOCK = process.env.USE_MOCK_ENGINES === 'true';

const engineClients = new Map<Engine, EngineClient>();

function createEngineClient(engine: Engine): EngineClient {
  switch (engine) {
    case 'openai':
      return new OpenAiEngineClient();
    case 'gemini':
      return new GeminiEngineClient();
    case 'claude':
      return new ClaudeEngineClient();
    case 'perplexity':
      return new PerplexityEngineClient();
  }
}

export function getEngineClient(engine: Engine): EngineClient {
  if (USE_MOCK) return new MockEngineClient();
  let client = engineClients.get(engine);
  if (!client) {
    client = createEngineClient(engine);
    engineClients.set(engine, client);
  }
  return client;
}

let judgeClient: EngineClient | undefined;

/**
 * B5 분석(심판) 전용 클라이언트. 수집용 엔진과 분리된 고정 모델이어야 한다.
 * Anthropic 키가 있으면 Claude를 쓰고, 없으면 OpenAI 키로 폴백한다 (웹 검색 없음).
 */
export function getJudgeClient(): EngineClient {
  if (USE_MOCK) return new MockJudgeClient();
  if (!judgeClient) {
    judgeClient = process.env.ANTHROPIC_API_KEY ? new ClaudeJudgeClient() : new OpenAiJudgeClient();
  }
  return judgeClient;
}
