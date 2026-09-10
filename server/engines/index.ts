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
/** 이번 프로세스에서 실제로 생성된 판단 클라이언트의 id. 스코어카드에 기록한다. */
let judgeEngineId: JudgeEngineId | undefined;

export type JudgeEngineId = 'gemini' | 'claude' | 'openai' | 'mock';

/**
 * 설정으로부터 판단 엔진 id를 해석한다. getJudgeClient()가 이 결과로 클라이언트를 만들므로
 * 둘이 갈릴 수 없다 — 규칙을 두 곳에 복제하면 스코어카드에 기록된 판단 엔진이 거짓이 된다.
 */
export function resolveJudgeEngineId(): JudgeEngineId {
  if (USE_MOCK) return 'mock';
  const preferred = process.env.JUDGE_ENGINE?.trim().toLowerCase();
  // 명시값 우선.
  if (preferred === 'gemini' || preferred === 'claude' || preferred === 'openai') return preferred;
  // 기본: Gemini 고정. 키가 없을 때만 다른 엔진으로 폴백한다.
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.ANTHROPIC_API_KEY) return 'claude';
  return 'openai';
}

/**
 * 이 측정에서 실제로 쓴 판단 엔진 id.
 *
 * 해석값을 다시 계산하지 않고 "만들어진 클라이언트"의 id를 돌려준다 — 클라이언트는 프로세스
 * 수명 동안 캐시되므로, 도중에 JUDGE_ENGINE이 바뀌면 해석값과 실제 사용 엔진이 달라진다.
 */
export function usedJudgeEngineId(): JudgeEngineId {
  return judgeEngineId ?? resolveJudgeEngineId();
}

/**
 * B5 분석(심판) 전용 클라이언트. 수집용 엔진과 분리된 고정 모델이어야 한다.
 *
 * 판단 엔진은 "측정 도구"이므로 그때그때 존재하는 키에 따라 바뀌면 주차 간 비교가 깨진다.
 * 따라서 기본값을 Gemini로 고정한다 — 파이프라인이 최소 요구하는 키가 GEMINI_API_KEY이고,
 * 문서·UI도 판단을 Gemini로 안내해 왔다. 수집 엔진을 늘려도(Claude·Perplexity 키 추가)
 * 판단은 그대로 유지된다. 바꾸려면 JUDGE_ENGINE으로 명시한다.
 */
export function getJudgeClient(): EngineClient {
  if (USE_MOCK) {
    judgeEngineId = 'mock';
    return new MockJudgeClient();
  }
  if (!judgeClient) {
    const id = resolveJudgeEngineId();
    // 키 없는 클라이언트는 생성자가 throw한다 — 그때는 id도 기록하지 않는다.
    if (id === 'claude') judgeClient = new ClaudeJudgeClient();
    else if (id === 'openai') judgeClient = new OpenAiJudgeClient();
    else judgeClient = new GeminiJudgeClient();
    judgeEngineId = id;
  }
  return judgeClient;
}
