import { inferAddressViaSearch, inferBrandFields, inferCompetitors } from '../server/brandInference.js';
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
    if (kind === 'address') {
      // B — 페이지에서 못 찾은 주소를 브랜드명+지역 웹검색 그라운딩/추론으로 조회.
      const brandName = str(body.brandName);
      if (!brandName.trim()) {
        sendJson(res, 400, { error: 'brandName이 필요합니다.' });
        return;
      }
      if (body.debug) {
        // 임시 진단 — 배포에서 Gemini가 실제로 뭐라 답하는지 원시 응답을 본다.
        const { GeminiJudgeClient } = await import('../server/engines/geminiJudgeClient.js');
        const sys = '당신은 한국 비즈니스의 실제 도로명 주소를 아는 도우미입니다. 확실하지 않으면 "모름"만 답하고, 주소를 지어내지 마세요.';
        const usr = `"${brandName}"${str(body.region) ? ` (${str(body.region)})` : ''}의 공식 도로명 주소를 한 줄만 답하세요. 예: "서울 강남구 봉은사로 107". 확실하지 않으면 "모름".`;
        let raw = '';
        let err = '';
        try {
          raw = (await new GeminiJudgeClient().call({ system: sys, user: usr })).text ?? '';
        } catch (e) {
          err = e instanceof Error ? e.message : String(e);
        }
        sendJson(res, 200, { address: await inferAddressViaSearch(brandName, str(body.region)), _raw: raw, _err: err, _hasKey: Boolean(process.env.GEMINI_API_KEY), _vercel: Boolean(process.env.VERCEL) });
        return;
      }
      sendJson(res, 200, { address: await inferAddressViaSearch(brandName, str(body.region)) });
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
