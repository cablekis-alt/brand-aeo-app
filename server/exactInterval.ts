/**
 * 비율 k/n의 95% 범위(Clopper–Pearson) — 회차 하나의 「순위와 함께 불린 응답 k / 응답 n」에 붙인다(server/runHistory.ts).
 *
 * 정규 근사는 k가 0~3인 작은 비율에서 음수 하한 · 0 폭을 낸다(실측 web4ai 이름 없는 답 78건 중 0~3건). 이항 꼬리 확률을 이분법으로
 * 풀어 근사 없이 낸다. 같은 질문을 엔진 여러 곳에 물어 응답끼리 함께 움직이므로 실제 흔들림은 이 범위보다 크다 — 화면이 그렇게 적는다.
 */

/** P(X ≤ k) for X ~ Binomial(n, p) — 로그 공간에서 더한다(n이 수백이어도 넘치지 않게). */
function binomCdf(k: number, n: number, p: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  const lp = Math.log(p);
  const lq = Math.log(1 - p);
  let logC = 0; // log C(n, 0)
  let sum = 0;
  for (let i = 0; i <= k; i += 1) {
    if (i > 0) logC += Math.log((n - i + 1) / i);
    sum += Math.exp(logC + i * lp + (n - i) * lq);
  }
  return Math.min(1, sum);
}

/** f(p)가 p에 대해 단조일 때 f(p) = target인 p — 80번 반으로 나누면 소수 넷째 자리보다 훨씬 정확하다. */
function solve(f: (p: number) => number, target: number, increasing: boolean): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2;
    if (f(mid) < target === increasing) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function clopperPearson(k: number, n: number, alpha = 0.05): { lower: number; upper: number } | null {
  if (!Number.isInteger(k) || !Number.isInteger(n) || n <= 0 || k < 0 || k > n) return null;
  const half = alpha / 2;
  if (k === 0) return { lower: 0, upper: 1 - Math.pow(half, 1 / n) };
  if (k === n) return { lower: Math.pow(half, 1 / n), upper: 1 };
  // 하한: P(X ≥ k | p) = α/2 — p가 커지면 늘어난다. 상한: P(X ≤ k | p) = α/2 — p가 커지면 줄어든다.
  const lower = solve((p) => 1 - binomCdf(k - 1, n, p), half, true);
  const upper = solve((p) => binomCdf(k, n, p), half, false);
  return { lower, upper };
}
