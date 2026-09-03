import { listMeasureRuns, triggerGithubMeasure, triggerGithubQueueMeasure } from '../server/githubMeasure.js';
import { addMeasureRequest, readMeasureRequests, removeMeasureRequest } from '../server/measureRequests.js';
import { sendJson } from '../server/httpJson.js';
import type { JsonRequest, JsonResponse } from '../server/httpJson.js';
import { blobStoreEnabled, normalizeTenantDraft } from '../server/tenantRegistry.js';

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

// S-08 — 배포에서 측정을 바로 못 돌리므로, "측정 요청"을 대기열(Blob)에 쌓아 로컬 CLI가 처리하게 한다.
export default async function handler(req: JsonRequest, res: JsonResponse) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    cors(res, 'GET, POST, DELETE');
    res.end();
    return;
  }
  cors(res, 'GET, POST, DELETE');

  if (req.method === 'GET') {
    if (req.query?.view === 'runs') {
      sendJson(res, 200, await listMeasureRuns());
      return;
    }
    sendJson(res, 200, await readMeasureRequests());
    return;
  }

  if (req.method === 'POST') {
    const body = readBody(req) as { action?: string; tenantId?: string };
    if (body?.action === 'run-queue') {
      const pending = await readMeasureRequests();
      if (pending.length === 0) {
        sendJson(res, 400, { error: '대기열이 비어 있습니다.' });
        return;
      }
      try {
        const { htmlUrl } = await triggerGithubQueueMeasure();
        sendJson(res, 202, { ok: true, via: 'github-actions', mode: 'queue', pending: pending.length, htmlUrl });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(res, 503, { error: message });
      }
      return;
    }
    if (body?.action === 'run') {
      const tenantId = typeof body.tenantId === 'string' ? body.tenantId.trim() : '';
      if (!tenantId) {
        sendJson(res, 400, { error: 'tenantId가 필요합니다.' });
        return;
      }
      try {
        const { htmlUrl } = await triggerGithubMeasure(tenantId);
        sendJson(res, 202, { ok: true, via: 'github-actions', tenantId, htmlUrl });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(res, 503, { error: message });
      }
      return;
    }

    if (!blobStoreEnabled() && process.env.VERCEL) {
      sendJson(res, 503, { error: '측정 요청을 저장하려면 프로젝트에 Blob 스토어(BLOB_READ_WRITE_TOKEN)가 필요합니다.' });
      return;
    }

    try {
      const tenant = normalizeTenantDraft(body);
      const list = await addMeasureRequest(tenant);
      sendJson(res, 201, { ok: true, pending: list.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, message.includes('필수 항목') ? 400 : 500, { error: message });
    }
    return;
  }

  if (req.method === 'DELETE') {
    const tenantId = typeof req.query?.tenantId === 'string' ? req.query.tenantId : '';
    if (!tenantId.trim()) {
      sendJson(res, 400, { error: 'tenantId 쿼리가 필요합니다.' });
      return;
    }
    const list = await removeMeasureRequest(tenantId);
    sendJson(res, 200, { ok: true, pending: list.length });
    return;
  }

  sendJson(res, 405, { error: 'GET, POST, DELETE만 허용됩니다.' });
}
