export async function withOpenAiRetry<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const message = err instanceof Error ? err.message : String(err);
      // 크레딧 소진·쿼터 초과·인증 실패는 재시도해도 절대 회복되지 않는다 → 즉시 포기(백오프 낭비 방지).
      const permanent = /no credits|insufficient_quota|exceeded your.*quota|invalid_api_key|incorrect api key|401|403/i.test(
        message,
      );
      if (permanent) throw err;
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
