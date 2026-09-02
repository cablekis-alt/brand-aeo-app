import { inferCompetitors } from '../server/brandInference.js';
import { sendJson } from '../server/httpJson.js';
import type { JsonRequest, JsonResponse } from '../server/httpJson.js';

function cors(res: JsonResponse, methods: string) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function readBody(req: JsonRequest): { brandName?: unknown; industry?: unknown; region?: unknown } {
  const body = req.body;
  if (typeof body === 'string') {
    if (!body.trim()) return {};
    return JSON.parse(body) as { brandName?: unknown; industry?: unknown; region?: unknown };
  }
  return (body ?? {}) as { brandName?: unknown; industry?: unknown; region?: unknown };
}

// S-08 온보딩 — 같은 업종·지역의 경쟁사를 Gemini(웹검색)로 추천, 도메인은 DNS 검증.
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
    const { brandName, industry, region } = readBody(req);
    if (typeof brandName !== 'string' || !brandName.trim() || typeof industry !== 'string' || !industry.trim()) {
      sendJson(res, 400, { error: 'brandName, industry가 필요합니다.' });
      return;
    }
    const competitors = await inferCompetitors(brandName, industry, typeof region === 'string' ? region : '');
    sendJson(res, 200, competitors);
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}
