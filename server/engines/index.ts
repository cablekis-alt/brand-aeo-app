import type { Engine } from '../../src/prompts/types.js';
import { withLlmSlot, type LlmPool } from '../concurrency.js';
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

/**
 * 모든 실제 LLM 호출을 전역 슬롯 안에서 실행하게 감싼다 — 동시 호출 상한을 한 곳에서만 잡는다.
 * 수집·판정·사실확인·브랜드 추론이 전부 이 경로를 지나므로, 코호트를 병렬로 측정해도
 * 쿼터에 몰리는 총량이 상한을 넘지 않는다.
 *
 * 수집과 판정은 **다른 예산**을 쓴다 — 그라운딩 검색이 붙은 수집은 이미 서버 천장에 닿아
 * 있고 판정은 여유가 있다(concurrency.ts의 실측 주석 참고). 같은 예산을 쓰면 수집이
 * 서버 큐에 막혀 있는 동안 판정도 함께 대기한다.
 *
 * latencyMs는 클라이언트 내부에서 재므로 슬롯 대기 시간은 포함되지 않는다 —
 * 저장된 지연값은 여전히 "호출 자체가 걸린 시간"이다(대기까지 섞으면 엔진 비교가 망가진다).
 */
function limited(client: EngineClient, pool: LlmPool): EngineClient {
  return { call: (prompt) => withLlmSlot(pool, () => client.call(prompt)) };
}

/**
 * 판정이 줄줄이 빈 응답이면 던진다 — 조용한 오염을 막는 차단기.
 *
 * 판정 클라이언트는 실패를 빈 문자열로 강등한다(판정 한 건이 테넌트 전체를 멈추지 않게 하려는
 * 의도이고 그건 맞다). 문제는 전부 실패할 때다. Gemini 월 지출 한도가 찼을 때 실제로 그랬다 —
 * 모든 판정이 ''를 돌려주는데 파서가 기본값으로 흡수해서, 측정은 "성공"으로 끝나고 언급 0·
 * 순위 없음으로 채워진 엉터리 스코어카드가 주차 이력에 남는다.
 *
 * 한 건 실패는 견디고 연속으로 쌓일 때만 멈춘다. 성공이 하나라도 나오면 계수를 되돌린다 —
 * 드문 빈 응답이 누적돼 멀쩡한 측정을 죽이면 안 된다.
 */
const JUDGE_EMPTY_LIMIT = Math.max(1, Number(process.env.JUDGE_EMPTY_LIMIT) || 20);
let judgeEmptyStreak = 0;

/** 측정 시작마다 되돌린다 — 앞 측정의 끝자락 실패가 다음 측정을 곧바로 죽이면 안 된다. */
export function resetJudgeHealth(): void {
  judgeEmptyStreak = 0;
}

function guarded(client: EngineClient): EngineClient {
  return {
    call: async (prompt) => {
      const result = await client.call(prompt);
      if (result.text.trim()) {
        judgeEmptyStreak = 0;
        return result;
      }
      judgeEmptyStreak += 1;
      if (judgeEmptyStreak >= JUDGE_EMPTY_LIMIT) {
        throw new Error(
          `판정 엔진이 응답하지 않습니다 — 빈 응답 ${judgeEmptyStreak}건 연속. ` +
            `측정을 중단합니다(그대로 두면 언급 0·순위 없음으로 채워진 잘못된 점수가 저장됩니다). ` +
            `API 키·할당량·지출 한도를 확인하세요.`,
        );
      }
      return result;
    },
  };
}

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
    client = limited(createEngineClient(engine), 'collect');
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
    // guarded가 안쪽 — 슬롯을 잡은 뒤의 실제 응답을 본다.
    if (id === 'claude') judgeClient = limited(guarded(new ClaudeJudgeClient()), 'judge');
    else if (id === 'openai') judgeClient = limited(guarded(new OpenAiJudgeClient()), 'judge');
    else judgeClient = limited(guarded(new GeminiJudgeClient()), 'judge');
    judgeEngineId = id;
  }
  return judgeClient;
}
