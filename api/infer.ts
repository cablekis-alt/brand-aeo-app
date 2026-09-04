import { inferAddressViaSearch, inferBrandFields, inferBrandFromDomain, inferCompetitors } from '../server/brandInference.js';
import { canTriggerRemoteMeasure, triggerGithubInfer } from '../server/githubMeasure.js';
import { markInferPending, readInferResult, slugFromDomain } from '../server/inferResults.js';
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
    if (kind === 'competitors-dispatch') {
      // 자동 채우기용 — Vercel에선 추론이 안 되므로 CI 러너에 추론을 맡기고, 폼은 결과를 폴링한다.
      const brandName = str(body.brandName);
      const industry = str(body.industry);
      const domain = str(body.domain);
      if (!brandName.trim() || !industry.trim() || !domain.trim()) {
        sendJson(res, 400, { error: 'brandName, industry, domain이 필요합니다.' });
        return;
      }
      if (!canTriggerRemoteMeasure()) {
        sendJson(res, 200, { dispatched: false, reason: 'no-token' });
        return;
      }
      const slug = slugFromDomain(domain);
      await markInferPending(slug); // 이전 결과를 지워 stale 반환 방지.
      const { htmlUrl } = await triggerGithubInfer({ brandName, industry, region: str(body.region), domain });
      sendJson(res, 200, { dispatched: true, slug, htmlUrl });
      return;
    }
    if (kind === 'competitors-result') {
      const domain = str(body.domain);
      if (!domain.trim()) {
        sendJson(res, 400, { error: 'domain이 필요합니다.' });
        return;
      }
      const result = await readInferResult(slugFromDomain(domain));
      // null = 아직 시작 안 됨(대기), pending=true = 추론 중, pending=false = 완료.
      sendJson(res, 200, result ?? { pending: true, competitors: [], at: '' });
      return;
    }
    if (kind === 'address') {
      // B — 페이지에서 못 찾은 주소를 브랜드명+지역 웹검색 그라운딩/추론으로 조회.
      const brandName = str(body.brandName);
      if (!brandName.trim()) {
        sendJson(res, 400, { error: 'brandName이 필요합니다.' });
        return;
      }
      sendJson(res, 200, { address: await inferAddressViaSearch(brandName, str(body.region)) });
      return;
    }
    if (kind === 'domain') {
      const domain = str(body.domain);
      if (!domain.trim()) {
        sendJson(res, 400, { error: 'domain이 필요합니다.' });
        return;
      }
      sendJson(res, 200, await inferBrandFromDomain(domain));
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
