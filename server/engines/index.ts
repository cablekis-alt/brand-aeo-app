import type { Engine } from '../../src/prompts/types.js';
import { ClaudeEngineClient } from './claudeEngineClient.js';
import { ClaudeJudgeClient } from './claudeJudgeClient.js';
import { GeminiEngineClient } from './geminiEngineClient.js';
import { GeminiJudgeClient } from './geminiJudgeClient.js';
import { MockEngineClient } from './mockEngineClient.js';
import { MockJudgeClient } from './mockJudgeClient.js';
import { OpenAiEngineClient } from './openaiEngineClient.js';
import { OpenAiJudgeClient } from './openaiJudgeClient.js';
import { PerplexityEngineClient } from './perplexityEngineClient.js';
import type { EngineClient } from './types.js';

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
    const preferred = process.env.JUDGE_ENGINE?.trim().toLowerCase();
    // 명시값 우선. 없으면 키가 실제로 있는 엔진을 고른다(키 없는 클라이언트는 생성자가 throw하므로).
    if (preferred === 'gemini') judgeClient = new GeminiJudgeClient();
    else if (preferred === 'claude') judgeClient = new ClaudeJudgeClient();
    else if (preferred === 'openai') judgeClient = new OpenAiJudgeClient();
    else if (process.env.ANTHROPIC_API_KEY) judgeClient = new ClaudeJudgeClient();
    else if (process.env.OPENAI_API_KEY) judgeClient = new OpenAiJudgeClient();
    else judgeClient = new GeminiJudgeClient(); // GEMINI_API_KEY만 있는 흔한 경우(로컬·데스크톱) 폴백
  }
  return judgeClient;
}
