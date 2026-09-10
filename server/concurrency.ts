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
 * 천장이다. 판정은 48에서 처리량이 21% 오르고 p50 지연이 그대로다 — 아직 여유가 있다.
 * 같은 슬롯을 다투게 두면 수집이 서버 큐에 막혀 있는 동안 판정도 함께 대기한다.
 *
 * 429는 어느 단계에서도 나오지 않았다. 그래서 상한은 "429가 나는 지점"이 아니라
 * "처리량이 더 안 오르는 지점"으로 잡는다.
 */
const LIMITS = {
  collect: Math.max(1, Number(process.env.COLLECT_LLM_CONCURRENCY) || 24),
  judge: Math.max(1, Number(process.env.JUDGE_LLM_CONCURRENCY) || 48),
} as const;

export type LlmPool = keyof typeof LIMITS;

const inFlight: Record<LlmPool, number> = { collect: 0, judge: 0 };
const waiting: Record<LlmPool, Array<() => void>> = { collect: [], judge: [] };

/** 슬롯을 얻는다. 꽉 찼으면 release가 슬롯을 그대로 물려줄 때까지 기다린다. */
function acquire(pool: LlmPool): Promise<void> {
  if (inFlight[pool] < LIMITS[pool]) {
    inFlight[pool] += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiting[pool].push(resolve));
}

/**
 * 슬롯을 놓는다. 대기자가 있으면 카운터를 **줄이지 않고** 넘겨준다 —
 * 줄인 뒤 깨우면, 깨어난 대기자가 실제로 실행되기 전(마이크로태스크 사이)에 새 호출이
 * 빈 슬롯으로 보고 끼어들어 상한을 넘긴다.
 */
function release(pool: LlmPool): void {
  const next = waiting[pool].shift();
  if (next) next();
  else inFlight[pool] -= 1;
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
  return { ...LIMITS };
}
