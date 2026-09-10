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
 * 프로세스 전체에서 동시에 진행되는 LLM 호출 수 상한.
 *
 * 파이프라인 안의 동시성(수집 8 · 분석 8 × 판정 최대 4)은 "한 번에 한 브랜드"를 전제로 한
 * 값이다. 코호트를 병렬로 측정하면 그 값들이 곱해져 같은 모델 쿼터에 몇 배로 몰린다
 * (Gemini 단독 측정에서는 수집과 판정이 같은 gemini-3.7-flash 버킷을 쓴다).
 * 그래서 상한을 호출 지점마다 두지 않고 여기 한 곳에서 잡는다 — LLM_CONCURRENCY로 조정한다.
 */
const LLM_CONCURRENCY = Math.max(1, Number(process.env.LLM_CONCURRENCY) || 24);

let llmInFlight = 0;
const llmWaiting: Array<() => void> = [];

/** 슬롯을 얻는다. 꽉 찼으면 release가 슬롯을 그대로 물려줄 때까지 기다린다. */
function acquireLlmSlot(): Promise<void> {
  if (llmInFlight < LLM_CONCURRENCY) {
    llmInFlight += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => llmWaiting.push(resolve));
}

/**
 * 슬롯을 놓는다. 대기자가 있으면 카운터를 **줄이지 않고** 넘겨준다 —
 * 줄인 뒤 깨우면, 깨어난 대기자가 실제로 실행되기 전(마이크로태스크 사이)에 새 호출이
 * 빈 슬롯으로 보고 끼어들어 상한을 넘긴다.
 */
function releaseLlmSlot(): void {
  const next = llmWaiting.shift();
  if (next) next();
  else llmInFlight -= 1;
}

export async function withLlmSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquireLlmSlot();
  try {
    return await fn();
  } finally {
    releaseLlmSlot();
  }
}

export function llmConcurrencyLimit(): number {
  return LLM_CONCURRENCY;
}
