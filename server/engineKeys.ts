import type { Engine } from '../src/prompts/types.js';

/**
 * 수집 엔진의 키 존재 여부와 전역 지정 — /api/health가 웹·데스크톱 양쪽에 알려 주는 값.
 *
 * 이 파일이 따로 있는 이유는 규칙이 갈리면 안 되기 때문이다. 엔진 선택 화면이 "이 엔진은 키가
 * 없다"고 말하는 근거와, 측정이 실제로 엔진을 거르는 근거가 다르면 고른 것과 잰 것이 달라진다.
 * resolveCollectionEngines도 여기서 가져다 쓴다.
 *
 * **키 값은 절대 나가지 않는다 — 존재 여부(boolean)만 내보낸다.**
 */
export const ALL_ENGINES: Engine[] = ['openai', 'gemini', 'claude', 'perplexity'];

export const ENGINE_ENV: Record<Engine, string> = {
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  claude: 'ANTHROPIC_API_KEY',
  perplexity: 'PERPLEXITY_API_KEY',
};

/** 키가 설정된 엔진. 목 모드에서는 전부 true — 그때는 키 없이도 측정이 돈다. */
export function engineKeyStatus(): Record<Engine, boolean> {
  const useMock = process.env.USE_MOCK_ENGINES === 'true';
  return Object.fromEntries(
    ALL_ENGINES.map((engine) => [engine, useMock || Boolean(process.env[ENGINE_ENV[engine]])]),
  ) as Record<Engine, boolean>;
}

/**
 * COLLECT_ENGINES(쉼표 구분) 전역 지정. 설정하면 모든 테넌트의 수집 엔진을 덮어쓴다.
 * 없거나 아는 엔진이 하나도 없으면 null = 브랜드별 설정을 쓴다.
 *
 * 기존 테넌트 30개가 모두 ['openai','gemini']로 저장돼 있어, 엔진 커버리지를 넓힐 때
 * 설정 파일을 일괄 수정하지 않고 환경변수 하나로 전환할 수 있게 한다.
 */
export function globalCollectEngines(): Engine[] | null {
  const picked = (process.env.COLLECT_ENGINES ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is Engine => (ALL_ENGINES as string[]).includes(s));
  return picked.length > 0 ? picked : null;
}
