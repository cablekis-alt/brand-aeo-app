import { collectPage } from '../server/aeo/collectPage.js';
import { acceptGet, param, sendJson } from '../server/httpJson.js';
import type { JsonRequest, JsonResponse } from '../server/httpJson.js';

// 사이트 종합 진단 — 단일 URL의 공개 HTML을 수집한다 (SSRF 가드, 정적 수집). probes=0이면 robots · sitemap · llms 조사를 건너뛴다(사진 후보 · 장소 페이지).
export default async function handler(req: JsonRequest, res: JsonResponse) {
  if (!acceptGet(req, res)) return;

  const target = param(req.query, 'url');
  if (!target) {
    sendJson(res, 400, { error: 'url 쿼리가 필요합니다.' });
    return;
  }
  sendJson(res, 200, await collectPage(target, { probes: param(req.query, 'probes') !== '0' }));
}
