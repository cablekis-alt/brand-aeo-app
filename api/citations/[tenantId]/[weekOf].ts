import { DemoResultStore } from '../../../server/demoStore.js';
import { acceptGet, findTenant, param, sendJson, tenantNotFound } from '../../../server/httpJson.js';
import type { JsonRequest, JsonResponse } from '../../../server/httpJson.js';
import { getCitationBreakdown } from '../../../server/queries.js';

// S-05 URL 상세 분석.
export default async function handler(req: JsonRequest, res: JsonResponse) {
  if (!acceptGet(req, res)) return;

  const tenantId = param(req.query, 'tenantId');
  const weekOf = param(req.query, 'weekOf');
  const tenant = findTenant(tenantId);
  if (!tenant) {
    tenantNotFound(res, tenantId);
    return;
  }

  const store = new DemoResultStore([tenant]);
  sendJson(res, 200, await getCitationBreakdown(store, tenantId, weekOf));
}
