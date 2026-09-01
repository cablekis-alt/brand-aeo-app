import rawTenants from './tenants.config.json' with { type: 'json' };
import type { DemoTenant } from './demoData.js';
import type { TenantConfig } from './types.js';

/**
 * Vercel Node 런타임의 요청/응답에서 실제로 쓰는 부분만 추린 구조적 타입.
 * @vercel/node를 런타임 의존성으로 추가하지 않으려고 직접 선언한다.
 */
export interface JsonRequest {
  method?: string;
  query: Record<string, string | string[] | undefined>;
}

export interface JsonResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

export function sendJson(res: JsonResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify(body));
}

/** GET 이외의 메서드를 걸러낸다. 계속 진행해도 되면 true를 돌려준다. */
export function acceptGet(req: JsonRequest, res: JsonResponse): boolean {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.end();
    return false;
  }
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'GET만 허용됩니다.' });
    return false;
  }
  return true;
}

export function param(query: JsonRequest['query'], key: string): string {
  const value = query[key];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

// 서버리스 번들에 정적으로 포함된다 (fs·process.cwd()에 의존하지 않는다).
export const TENANTS = rawTenants as TenantConfig[];

export function findTenant(tenantId: string): (TenantConfig & DemoTenant) | undefined {
  return TENANTS.find((tenant) => tenant.tenantId === tenantId);
}

export function tenantNotFound(res: JsonResponse, tenantId: string): void {
  sendJson(res, 404, { error: `tenant not found: ${tenantId}` });
}
