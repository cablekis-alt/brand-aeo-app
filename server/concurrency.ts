import type { Engine } from '../src/prompts/types.js';

/** 엔진 API 레이트리밋을 고려한 제한 동시성 map. 순서는 보존하되, 동시에는 최대 `limit`개만 실행한다. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await fn(items[current], current);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * 동시에 진행되는 LLM 호출 수 상한 — **수집과 판정을 따로** 잡는다.
 *
 * 파이프라인 안의 동시성(수집 24 · 분석 8 × 판정 최대 4)은 "한 번에 한 브랜드"를 전제한
 * 값이라, 코호트를 병렬로 측정하면 곱해져 같은 모델 쿼터에 몰린다. 그래서 총량 상한은
 * 호출 지점마다 두지 않고 이 파일 한 곳에서 잡는다.
 *
 * 예산을 하나로 합치면 안 된다 — 두 호출의 성질이 다르다(scripts/quota-probe.ts 실측,
 * gemini-3.7-flash · 96회):
 *
 *   수집(googleSearch 그라운딩)  24 → 2.77/초 p95 9.3초   48 → 2.79/초 p95 10.8초
 *   판정(검색 없음)              24 → 6.06/초 p50 2.74초  48 → 7.30/초 p50 2.76초
 *
 * 수집은 48로 올려도 처리량이 그대로이고 p95만 늘어난다 — 서버가 거절 대신 큐에 세우는
 * 천장이다. 같은 슬롯을 다투게 두면 수집이 서버 큐에 막혀 있는 동안 판정도 함께 대기한다.
 *
 * 429는 어느 단계에서도 나오지 않았다. 그래서 상한은 "429가 나는 지점"이 아니라
 * "처리량이 더 안 오르는 지점"으로 잡는다.
 *
 * 판정 상한을 다시 쟀다(2026-09-15, 단계별 192회). 48은 천장이 아니었다:
 *
 *    48 → 13.8/초 p50 2680ms
 *    96 → 23.6/초 p50 2820ms   (1.71×)
 *   144 → 27.9/초 p50 2599ms   (1.18×)   ← 여기서 평평해진다
 *   192 → 28.5/초 p50 2830ms   (1.02×)   p95만 4385 → 4795ms
 *
 * 전 구간 429 0건. 그래서 판정은 144로 올린다. 실측 근거: 대한민국 구석구석 W38에서
 * 판정 한 건의 wall 중앙값 11.9초 중 **6.9초가 큐 대기**였다 — 일하는 시간보다 기다리는
 * 시간이 길었다. 대기는 우리 세마포어가 만든 것이지 서버가 민 것이 아니다.
 *
 * 수집은 그대로 24다. 그쪽 천장은 서버가 쥐고 있어 올려도 p95만 는다.
 *
 * ── 수집 슬롯은 엔진마다 따로 (2026-10-13) ───────────────────────────────────────
 * 위 24는 Gemini 하나로 수집하던 때 Gemini 키의 천장이다. 엔진이 셋(OpenAI · Gemini · Perplexity)이 된 뒤에도
 * 24를 셋이 나눠 써, 느린 엔진이 슬롯을 붙잡으면 다른 엔진까지 함께 느려졌다 — 2026-10-13 스테이,머뭄 코호트
 * 6곳(호출 756회)에서 Gemini 응답 중앙값이 10.4 → 18.9초가 되자 세 엔진의 처리량이 똑같이 0.68 → 0.48회/초로
 * 떨어졌고 측정이 7분에서 11분이 됐다. 처리량이 「24 ÷ 평균 응답 시간」에 묶여 있었다.
 * 키와 천장은 엔진마다 다르므로 슬롯도 엔진마다 둔다(scripts/quota-probe.ts --engine, 2026-10-13, 단계별 36회):
 *
 *   OpenAI      12 → 0.56/초 p50 16.5초        36 → 1.37/초 p50 15.1초 · 429 0건   → 36
 *   Perplexity  12 → 0.80/초 p50 8.4초(재시도 4) 36 → 0.56/초 · 429로 12건 실패      → 8 (분당 약 50회 제한)
 *   Gemini      위 실측 그대로 24
 *
 * COLLECT_LLM_CONCURRENCY는 이제 엔진마다의 기본값을 한꺼번에 바꾸고, COLLECT_LLM_CONCURRENCY_<ENGINE>
 * (예: _PERPLEXITY)이 그 엔진만 바꾼다.
 */
const COLLECT_DEFAULTS: Record<Engine, number> = { gemini: 24, openai: 36, perplexity: 8, claude: 24 };

/**
 * check — 사람이 화면에서 기다리는 한 번짜리 확인(경쟁사 편집의 「업종 다름」 확인). 측정 수집과 같은 엔진 · 같은 키를 쓰지만
 * 슬롯은 따로다 — 코호트 측정 중에는 수집 슬롯 줄에 호출 100건 넘게가 서 있어, 같은 줄에 서면 확인이 시간 초과로 버려진다.
 */
export type LlmPool = 'judge' | 'check' | `collect:${Engine}`;

/** 엔진 하나의 수집 슬롯 수. */
export function collectLimit(engine: Engine): number {
  const specific = Number(process.env[`COLLECT_LLM_CONCURRENCY_${engine.toUpperCase()}`]);
  const shared = Number(process.env.COLLECT_LLM_CONCURRENCY);
  return Math.max(1, specific || shared || COLLECT_DEFAULTS[engine]);
}

function limitOf(pool: LlmPool): number {
  if (pool === 'judge') return Math.max(1, Number(process.env.JUDGE_LLM_CONCURRENCY) || 144);
  if (pool === 'check') return Math.max(1, Number(process.env.CHECK_LLM_CONCURRENCY) || 4);
  return collectLimit(pool.slice('collect:'.length) as Engine);
}

const inFlight = new Map<LlmPool, number>();
const waiting = new Map<LlmPool, Array<() => void>>();

/** 슬롯을 얻는다. 꽉 찼으면 release가 슬롯을 그대로 물려줄 때까지 기다린다. */
function acquire(pool: LlmPool): Promise<void> {
  const used = inFlight.get(pool) ?? 0;
  if (used < limitOf(pool)) {
    inFlight.set(pool, used + 1);
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const queue = waiting.get(pool) ?? [];
    queue.push(resolve);
    waiting.set(pool, queue);
  });
}

/**
 * 슬롯을 놓는다. 대기자가 있으면 카운터를 **줄이지 않고** 넘겨준다 —
 * 줄인 뒤 깨우면, 깨어난 대기자가 실제로 실행되기 전(마이크로태스크 사이)에 새 호출이
 * 빈 슬롯으로 보고 끼어들어 상한을 넘긴다.
 */
function release(pool: LlmPool): void {
  const next = waiting.get(pool)?.shift();
  if (next) next();
  else inFlight.set(pool, (inFlight.get(pool) ?? 1) - 1);
}

export async function withLlmSlot<T>(pool: LlmPool, fn: () => Promise<T>): Promise<T> {
  await acquire(pool);
  try {
    return await fn();
  } finally {
    release(pool);
  }
}

export function llmConcurrencyLimits(): Record<LlmPool, number> {
  const engines: Engine[] = ['gemini', 'openai', 'perplexity', 'claude'];
  return Object.fromEntries([
    ['judge', limitOf('judge')],
    ['check', limitOf('check')],
    ...engines.map((e) => [`collect:${e}`, collectLimit(e)]),
  ]) as Record<LlmPool, number>;
}
