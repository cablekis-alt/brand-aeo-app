export async function withOpenAiRetry<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const message = err instanceof Error ? err.message : String(err);
      const retryable = /429|rate limit|500|502|503|504|timeout|ETIMEDOUT|ECONNRESET/i.test(message);
      if (!retryable || i === attempts - 1) throw err;
      const waitMs = Math.min(30_000, 1000 * 2 ** i);
      console.log(`[openai] retry ${i + 1}/${attempts - 1} in ${waitMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw last;
}
