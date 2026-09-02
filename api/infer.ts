import { inferBrandFields, inferCompetitors } from '../server/brandInference.js';
import { sendJson } from '../server/httpJson.js';
import type { JsonRequest, JsonResponse } from '../server/httpJson.js';

// Hobby 플랜의 함수 개수 제한(12개)에 맞추려고 브랜드 필드 추론과 경쟁사 추론을 한 함수로 합친다.
// ?kind=brand → {industry, region, address},  ?kind=competitors → [{name, domain}]
function cors(res: JsonResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function readBody(req: JsonRequest): Record<string, unknown> {
  const body = req.body;
  if (typeof body === 'string') {
    if (!body.trim()) return {};
    return JSON.parse(body) as Record<string, unknown>;
  }
  return (body ?? {}) as Record<string, unknown>;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export default async function handler(req: JsonRequest, res: JsonResponse) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    cors(res);
    res.end();
    return;
  }
  cors(res);
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'POST만 허용됩니다.' });
    return;
  }
  const kind = str(req.query?.kind);
  const body = readBody(req);
  try {
    if (kind === 'competitors') {
      const brandName = str(body.brandName);
      const industry = str(body.industry);
      if (!brandName.trim() || !industry.trim()) {
        sendJson(res, 400, { error: 'brandName, industry가 필요합니다.' });
        return;
      }
      sendJson(res, 200, await inferCompetitors(brandName, industry, str(body.region)));
      return;
    }
    // 기본: 브랜드 필드 추론
    const text = str(body.text);
    if (!text.trim()) {
      sendJson(res, 400, { error: 'text가 필요합니다.' });
      return;
    }
    sendJson(res, 200, await inferBrandFields(text, str(body.brandName)));
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}
