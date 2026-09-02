import { inferBrandFields } from '../server/brandInference.js';
import { sendJson } from '../server/httpJson.js';
import type { JsonRequest, JsonResponse } from '../server/httpJson.js';

function cors(res: JsonResponse, methods: string) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function readBody(req: JsonRequest): { text?: unknown; brandName?: unknown } {
  const body = req.body;
  if (typeof body === 'string') {
    if (!body.trim()) return {};
    return JSON.parse(body) as { text?: unknown; brandName?: unknown };
  }
  return (body ?? {}) as { text?: unknown; brandName?: unknown };
}

// S-08 온보딩 — 페이지 텍스트에서 업종·지역·주소를 Gemini로 추론한다.
export default async function handler(req: JsonRequest, res: JsonResponse) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    cors(res, 'POST');
    res.end();
    return;
  }
  cors(res, 'POST');
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'POST만 허용됩니다.' });
    return;
  }
  try {
    const { text, brandName } = readBody(req);
    if (typeof text !== 'string' || !text.trim()) {
      sendJson(res, 400, { error: 'text가 필요합니다.' });
      return;
    }
    const fields = await inferBrandFields(text, typeof brandName === 'string' ? brandName : '');
    sendJson(res, 200, fields);
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}
