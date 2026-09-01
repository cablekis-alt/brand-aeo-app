import type { Engine } from '../../src/prompts/types';
import { ClaudeEngineClient } from './claudeEngineClient';
import { ClaudeJudgeClient } from './claudeJudgeClient';
import { GeminiEngineClient } from './geminiEngineClient';
import { MockEngineClient } from './mockEngineClient';
import { MockJudgeClient } from './mockJudgeClient';
import { OpenAiEngineClient } from './openaiEngineClient';
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
 * B5 분석(심판) 전용 클라이언트. 수집용 4개 엔진과 분리된 고정 모델이어야 한다
 * (docs/prompt-design.md 2절 참고). 현재는 claude-opus-5로 고정 — 필요 시 JUDGE_MODEL 환경변수로 교체.
 */
export function getJudgeClient(): EngineClient {
  if (USE_MOCK) return new MockJudgeClient();
  if (!judgeClient) judgeClient = new ClaudeJudgeClient();
  return judgeClient;
}
