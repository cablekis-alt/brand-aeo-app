import { canTriggerRemoteMeasure } from '../server/githubMeasure.js';
import { canPersistTenants } from '../server/tenantRegistry.js';
import { engineKeyStatus, globalCollectEngines } from '../server/engineKeys.js';
import { sendJson } from '../server/httpJson.js';
import type { JsonRequest, JsonResponse } from '../server/httpJson.js';

export default function handler(req: JsonRequest, res: JsonResponse) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.end();
    return;
  }
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'GET만 허용됩니다.' });
    return;
  }
  const remote = canTriggerRemoteMeasure();
  sendJson(res, 200, {
    ok: true,
    backend: process.env.VERCEL ? 'vercel' : 'serverless',
    canRegister: canPersistTenants(),
    canMeasure: !process.env.VERCEL || remote,
    measureVia: process.env.VERCEL ? (remote ? 'github' : 'none') : 'local',
    // 엔진 선택 화면이 쓰는 값. 키는 존재 여부만 나간다 — 값은 절대 싣지 않는다.
    engineKeys: engineKeyStatus(),
    collectEngines: globalCollectEngines(),
  });
}
