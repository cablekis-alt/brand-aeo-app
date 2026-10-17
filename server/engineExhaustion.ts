/**
 * 엔진 호출 오류 중 「다시 시도해도 이 측정 안에서는 풀리지 않는」 것 — 지출 한도 · 크레딧 · 일일 한도 · 키.
 *
 * 2026-10-17 군산 측정: Gemini 프로젝트의 월 지출 한도(spending cap)가 차서 429 RESOURCE_EXHAUSTED가 났는데,
 * 재시도 규칙(engines/retry.ts)이 이 문구를 몰라 실패할 호출 100여 건을 하나하나 다시 시도한 뒤 「수집이 너무 적어
 * 중단」으로 끝났다. 화면에는 엔진 실패 건수만 남아 무엇을 고쳐야 하는지 알 수 없었다.
 *
 * 분당 한도는 같은 429 · RESOURCE_EXHAUSTED로 오지만 잠시 뒤 풀리므로 여기에 넣지 않는다(재시도한다).
 */
export type ExhaustionKind = 'spend-cap' | 'credits' | 'daily' | 'auth';

/**
 * 오류 문구로 가린다. 모르는 오류 · 일시적인 오류(분당 한도 · 시간 초과 · 5xx)는 null.
 *
 * SDK마다 문구 모양이 다르다 — openai(Perplexity 포함) · @anthropic-ai/sdk는 「429 …」처럼 상태 코드로 시작하고,
 * @google/genai는 오류 본문 JSON 전체(「"code":429 … "status":"RESOURCE_EXHAUSTED"」)를 문구로 쓴다.
 */
export function classifyEngineError(message: string): ExhaustionKind | null {
  // Gemini 월 지출 한도 · Claude 작업공간 사용 한도(「…usage limits. You will regain access on …」).
  if (/spending cap|spend cap|regain access on/i.test(message)) return 'spend-cap';
  // 일일 한도 — 분당 한도와 함께 넘겼다고 오면(무료 등급) 하루 한도가 진짜로 찬 것이라 분당보다 먼저 본다.
  if (/per ?day|PerDay|\((TPD|RPD)\)/i.test(message) && /quota|exhausted|exceeded|limit/i.test(message)) return 'daily';
  // 분당 한도 · 일반 속도 제한 — 잠시 뒤 풀린다. Gemini 무료 등급은 「exceeded your current quota … per minute」로,
  // OpenAI는 「Rate limit reached … per min (TPM): … Requested 403」처럼 와서 아래 크레딧 · 키 규칙과 겹친다.
  if (/per ?min(ute)?\b|PerMinute|rate limit|\((TPM|RPM)\)/i.test(message)) return null;
  if (
    /no credits|insufficient_quota|exceeded your.*quota|credit balance is too low|insufficient (credits|funds|balance)|credits are depleted|prepayment credits/i.test(
      message,
    )
  ) {
    return 'credits';
  }
  // 키 오류 — 상태 코드는 문구 맨 앞(openai · anthropic)이나 JSON의 code(genai)에서만 읽는다. 본문 아무 데나 있는
  // 401 · 403(토큰 수 「Requested 403」 등)을 키 오류로 읽으면 멀쩡한 엔진을 측정 내내 끊는다.
  if (/invalid_api_key|incorrect api key|api key not valid|API_KEY_INVALID/i.test(message)) return 'auth';
  if (/^\s*40[13]\b|"code"\s*:\s*40[13]\b/.test(message)) return 'auth';
  return null;
}

const ENGINE_NAME: Record<string, string> = { openai: 'ChatGPT', gemini: 'Gemini', claude: 'Claude', perplexity: 'Perplexity' };
const KIND_LABEL: Record<ExhaustionKind, string> = {
  'spend-cap': '지출 한도 초과',
  credits: '크레딧 소진',
  daily: '일일 한도 초과',
  auth: 'API 키 오류',
};

/** 화면에 붙이는 짧은 이름 — 「Gemini 지출 한도 초과」. */
export function exhaustionLabel(engine: string, kind: ExhaustionKind): string {
  return `${ENGINE_NAME[engine] ?? engine} ${KIND_LABEL[kind]}`;
}

/** 무엇을 하면 풀리는가. */
export function exhaustionHint(engine: string, kind: ExhaustionKind): string {
  const name = ENGINE_NAME[engine] ?? engine;
  if (kind === 'spend-cap') {
    return engine === 'gemini'
      ? 'Google AI Studio(ai.studio/spend)에서 월 지출 한도를 올리거나 다음 달에 다시 재세요'
      : `${name} 결제 화면에서 지출 한도를 올린 뒤 다시 재세요`;
  }
  if (kind === 'credits') return `${name} 결제 화면에서 크레딧을 충전한 뒤 다시 재세요`;
  if (kind === 'daily') return `내일 다시 재거나 ${name} 요금제를 올리세요`;
  return `${name} API 키를 확인하세요(앱 설정 .env)`;
}

/**
 * 측정 한 번(브랜드 한 곳의 수집) 안에서 끊긴 엔진. 끊긴 엔진의 남은 호출은 보내지 않는다 — 어차피 같은 오류로
 * 실패하고, 실패 호출도 슬롯과 시간을 먹는다.
 */
export class EngineOutage {
  private readonly down = new Map<string, ExhaustionKind>();
  private readonly skipped = new Map<string, number>();
  /** 남은 엔진만으로는 수집 하한에 못 미쳐 멈췄다 — 그 하한(0~1). */
  private stoppedBelow: number | null = null;
  /** 멈춘 뒤 보내지 않은, 끊기지 않은 엔진의 호출. */
  private stoppedSkips = 0;

  /** 실패한 호출을 알린다. 다시 시도해도 풀리지 않는 오류라 이번에 엔진을 끊었으면 true. */
  note(engine: string, err: unknown): boolean {
    if (this.down.has(engine)) return false;
    const kind = classifyEngineError(err instanceof Error ? err.message : String(err));
    if (!kind) return false;
    this.down.set(engine, kind);
    return true;
  }

  isDown(engine: string): boolean {
    return this.down.has(engine);
  }

  /** 끊긴 엔진이라 보내지 않은 호출을 센다. */
  skip(engine: string): void {
    this.skipped.set(engine, (this.skipped.get(engine) ?? 0) + 1);
  }

  /** 남은 엔진의 호출을 다 받아도 하한(minCoverage)에 못 미친다 — 이후 호출은 보내지 않는다. */
  stop(minCoverage: number): void {
    this.stoppedBelow = minCoverage;
  }

  get stopped(): boolean {
    return this.stoppedBelow !== null;
  }

  /** 멈춘 뒤 보내지 않은 호출을 센다. */
  skipStopped(): void {
    this.stoppedSkips += 1;
  }

  /** 「Gemini 지출 한도 초과」 목록 — 측정 상태 화면의 칩. */
  labels(): string[] {
    return [...this.down].map(([engine, kind]) => exhaustionLabel(engine, kind));
  }

  /** 실패 문구 맨 앞에 붙이는 설명. 끊긴 엔진이 없으면 빈 문자열. */
  explain(): string {
    const engines = [...this.down]
      .map(([engine, kind]) => {
        const skipped = this.skipped.get(engine) ?? 0;
        return `${exhaustionLabel(engine, kind)} — ${exhaustionHint(engine, kind)}${skipped ? ` (남은 호출 ${skipped}건은 보내지 않았습니다)` : ''}. `;
      })
      .join('');
    const stopped =
      this.stoppedBelow === null
        ? ''
        : `남은 엔진만으로는 수집 하한(${Math.round(this.stoppedBelow * 100)}%)에 못 미쳐 측정을 멈췄습니다` +
          `${this.stoppedSkips ? ` (다른 엔진의 남은 호출 ${this.stoppedSkips}건도 보내지 않았습니다)` : ''}. `;
    return engines + stopped;
  }
}

/** 수집이 모자라 측정을 멈췄다 — 끊긴 엔진 이름(engineIssues)을 함께 들고 간다(측정 상태 화면의 「실패」 줄). */
export class CollectionError extends Error {
  readonly engineIssues: string[];

  constructor(message: string, engineIssues: string[]) {
    super(message);
    this.name = 'CollectionError';
    this.engineIssues = engineIssues;
  }
}
