import { mapWithConcurrency } from './concurrency.js';

/**
 * Gemini 그라운딩 리다이렉트 URL을 실제 발행 URL로 해소한다.
 *
 * Gemini(googleSearch 도구)는 groundingChunks[].web.uri를
 * `https://vertexaisearch.cloud.google.com/grounding-api-redirect/<token>` 형태의
 * 래퍼로 준다. 그래서 인용 도메인이 전부 구글로 보이고 다음이 모두 망가진다:
 *   - brandOwnedCitationRate: 자사 도메인 판별 불가 → AVS 20% 가중치가 0으로 잘림
 *   - AI 인용출처 분석 / 인용 갭: 고유 도메인 1개(other 100%)로 수렴해 무의미
 * (실측: k-wonjin 2026-W36 인용 80건 전부가 이 래퍼였다.)
 *
 * web.domain 필드는 Vertex AI 전용이고 Gemini API에서는 오지 않으므로, 실제로
 * 리다이렉트를 따라가 최종 URL을 얻는다. 본문은 받지 않고 Location 헤더만 읽는다.
 * 실패하면 원래 URL을 그대로 둔다(수집을 막지 않는다 — 이 지표는 보조 신호다).
 */

const REDIRECT_HOST = 'vertexaisearch.cloud.google.com';
const REDIRECT_PATH = 'grounding-api-redirect';
const MAX_HOPS = 3;
const TIMEOUT_MS = 6000;
const CONCURRENCY = 8;

// 프로세스 수명 동안 재사용 — 같은 주차에 같은 URL이 여러 응답에 반복 등장한다.
const cache = new Map<string, string>();

export function isGroundingRedirect(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === REDIRECT_HOST && u.pathname.includes(REDIRECT_PATH);
  } catch {
    return false;
  }
}

async function locationOf(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // redirect:'manual' — 본문을 받지 않고 Location만 본다. HEAD를 거부하는 서버가 있어 GET을 쓴다.
    const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: controller.signal });
    const loc = res.headers.get('location');
    if (loc) return new URL(loc, url).href;
    // 리다이렉트가 아니면 최종 URL이 곧 답이다(래퍼가 직접 본문을 주는 경우).
    return res.url && res.url !== url ? res.url : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 리다이렉트 체인을 끝까지 따라가 최종 URL을 돌려준다. 실패 시 입력을 그대로 반환한다. */
async function resolveOne(url: string): Promise<string> {
  const hit = cache.get(url);
  if (hit) return hit;

  let current = url;
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const next = await locationOf(current);
    if (!next || next === current) break;
    current = next;
    if (!isGroundingRedirect(current)) break; // 래퍼를 벗어났으면 완료
  }
  const resolved = isGroundingRedirect(current) ? url : current; // 끝까지 래퍼면 포기
  cache.set(url, resolved);
  return resolved;
}

/**
 * 여러 URL을 한 번에 해소한다. 래퍼가 아닌 URL은 건드리지 않는다.
 * 반환: 원본 URL → 해소된 URL 맵(해소 실패분은 원본 그대로).
 */
export async function resolveCitationUrls(urls: string[]): Promise<Map<string, string>> {
  const targets = [...new Set(urls.filter(isGroundingRedirect))];
  const out = new Map<string, string>();
  if (targets.length === 0) return out;

  const resolved = await mapWithConcurrency(targets, CONCURRENCY, async (u) => [u, await resolveOne(u)] as const);
  for (const pair of resolved) {
    if (pair) out.set(pair[0], pair[1]);
  }
  return out;
}
