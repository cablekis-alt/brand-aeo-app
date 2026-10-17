import { classifyEngineError } from '../engineExhaustion.js';

export async function withOpenAiRetry<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
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
      const waitMs = Math.min(30_000, 1000 * 2 ** i);
      console.log(`[openai] retry ${i + 1}/${attempts - 1} in ${waitMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw last;
}
