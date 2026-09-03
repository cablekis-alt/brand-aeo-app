import { canPersistTenants, isBakedTenant, loadRuntimeTenants, normalizeTenantDraft, registerTenant, removeOverlayTenant, toTenantSummary } from '../server/tenantRegistry.js';
import { removeMeasureRequest } from '../server/measureRequests.js';
import { sendJson } from '../server/httpJson.js';
import type { JsonRequest, JsonResponse } from '../server/httpJson.js';

function cors(res: JsonResponse, methods: string) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function readBody(req: JsonRequest): unknown {
  const body = req.body;
  if (typeof body === 'string') {
    if (!body.trim()) return {};
    return JSON.parse(body) as unknown;
  }
  return body ?? {};
}

export default async function handler(req: JsonRequest, res: JsonResponse) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    cors(res, 'GET, POST, DELETE');
    res.end();
    return;
  }
  cors(res, 'GET, POST, DELETE');

  if (req.method === 'DELETE') {
    const raw = req.query?.tenantId;
    const tenantId = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (!tenantId) {
      sendJson(res, 400, { error: 'tenantId 쿼리가 필요합니다.' });
      return;
    }
    try {
      const { removed } = await removeOverlayTenant(tenantId);
      await removeMeasureRequest(tenantId);
      const stillBaked = isBakedTenant(tenantId);
      sendJson(res, 200, { ok: true, tenantId, removedFromOverlay: removed, stillBaked });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (req.method === 'GET') {
    const allRaw = req.query?.all
    const allFlag = Array.isArray(allRaw) ? allRaw[0] : allRaw
    const all = allFlag === '1' || allFlag === 'true'
    const tenants = await loadRuntimeTenants();
    const picked = all ? tenants : tenants.filter((tenant) => !tenant.cohortOnly);
    sendJson(
      res,
      200,
      picked.map((tenant) => ({ ...toTenantSummary(tenant), cohortOnly: Boolean(tenant.cohortOnly) })),
    );
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'GET 또는 POST만 허용됩니다.' });
    return;
  }

  if (!canPersistTenants()) {
    sendJson(res, 503, {
      error: 'Vercel에 브랜드를 저장하려면 프로젝트에 Blob 스토어를 연결하고 BLOB_READ_WRITE_TOKEN을 넣어야 합니다.',
    });
    return;
  }

  try {
    const tenant = normalizeTenantDraft(readBody(req));
    await registerTenant(tenant);
    sendJson(res, 201, { ok: true, tenantId: tenant.tenantId, brandName: tenant.brandName });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('필수 항목') ? 400 : message.includes('이미 존재') ? 409 : 500;
    sendJson(res, status, { error: message });
  }
}
