import { classifyEngineError } from '../engineExhaustion.js';

export interface RetryOptions {
  /** 로그에 찍을 이름(엔진). 예전엔 모든 엔진이 「[openai]」로 찍혀 어느 엔진이 밀리는지 알 수 없었다. */
  label?: string;
  /**
   * 한도(429)일 때 기다릴 시간의 바탕 — 시도마다 곱한다(15초 → 15 · 30초). 없으면 다른 오류와 같은 지수 백오프(1 · 2 · 4초 …).
   * 분당 한도에 걸린 엔진은 1 · 2초 뒤에 다시 보내도 같은 분 안이라 또 막혀 호출이 버려진다(Perplexity, 2026-10-21).
   */
  rateLimitWaitMs?: number;
}

export async function withOpenAiRetry<T>(fn: () => Promise<T>, attempts = 6, options: RetryOptions = {}): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const message = err instanceof Error ? err.message : String(err);
      // 지출 한도 · 크레딧 소진 · 일일 한도 · 인증 실패는 재시도해도 회복되지 않는다 → 즉시 포기(백오프 낭비 방지).
      // Gemini 월 지출 한도(spending cap)는 429로 와서 예전엔 아래 재시도에 걸렸다(engineExhaustion.ts 주석).
      if (classifyEngineError(message)) throw err;
      // OpenAI SDK 타임아웃은 "Request timed out." / APIConnectionTimeoutError로 온다.
      const retryable =
        /429|rate limit|500|502|503|504|timeout|timed out|APIConnection|ETIMEDOUT|ECONNRESET|ECONNREFUSED/i.test(
          message,
        );
      if (!retryable || i === attempts - 1) throw err;
      const rateLimited = /429|rate limit/i.test(message);
      const waitMs = rateLimited && options.rateLimitWaitMs ? Math.min(60_000, options.rateLimitWaitMs * (i + 1)) : Math.min(30_000, 1000 * 2 ** i);
      const reason = rateLimited ? '한도(429)' : /timeout|timed out|ETIMEDOUT/i.test(message) ? '시간 초과' : '일시 오류';
      console.log(`[${options.label ?? 'openai'}] retry ${i + 1}/${attempts - 1} in ${waitMs}ms (${reason})`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw last;
}
