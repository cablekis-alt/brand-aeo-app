import { demoQuestionBank, demoScorecardHistory } from '../../server/demoData.js';
import { acceptGet, findTenant, param, sendJson, tenantNotFound } from '../../server/httpJson.js';
import type { JsonRequest, JsonResponse } from '../../server/httpJson.js';

// S-04 질문 프롬프트 빌더.
export default function handler(req: JsonRequest, res: JsonResponse) {
  if (!acceptGet(req, res)) return;

  const tenantId = param(req.query, 'tenantId');
  const tenant = findTenant(tenantId);
  if (!tenant) {
    tenantNotFound(res, tenantId);
    return;
  }

  // Vercel 함수의 기본 lib 타깃이 낮아 Array.prototype.at을 쓰지 않는다.
  const history = demoScorecardHistory(tenantId);
  const latestWeek = history.length > 0 ? history[history.length - 1].weekOf : '2026-W36';
  sendJson(res, 200, demoQuestionBank(tenant, latestWeek));
}
