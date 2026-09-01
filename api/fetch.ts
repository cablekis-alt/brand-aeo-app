import { collectPage } from '../server/aeo/collectPage.js';
import { acceptGet, param, sendJson } from '../server/httpJson.js';
import type { JsonRequest, JsonResponse } from '../server/httpJson.js';

// S-03 사이트 종합 진단 — 단일 URL의 공개 HTML을 수집한다 (SSRF 가드, 정적 수집).
export default async function handler(req: JsonRequest, res: JsonResponse) {
  if (!acceptGet(req, res)) return;

  const target = param(req.query, 'url');
  if (!target) {
    sendJson(res, 400, { error: 'url 쿼리가 필요합니다.' });
    return;
  }
  sendJson(res, 200, await collectPage(target));
}
