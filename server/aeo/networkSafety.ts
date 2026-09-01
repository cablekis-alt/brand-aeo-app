import { lookup, resolve4, resolve6 } from 'node:dns/promises';
import { isIP } from 'node:net';

// aeo-checker-app의 SSRF 가드를 ipaddr.js 의존성 없이 옮긴 것.
// DNS로 실제 해석된 IP가 사설 대역이면 수집을 거부한다.

export class CollectorError extends Error {
  code: string;
  detail: string;
  constructor(code: string, message: string, detail = '') {
    super(message);
    this.name = 'CollectorError';
    this.code = code;
    this.detail = detail;
  }
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return -1;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function inRange(ip: string, start: string, end: string): boolean {
  const n = ipv4ToInt(ip);
  const a = ipv4ToInt(start);
  const b = ipv4ToInt(end);
  if (n < 0 || a < 0 || b < 0) return false;
  return n >= a && n <= b;
}

function isPrivateIpv4(ip: string): boolean {
  return (
    inRange(ip, '0.0.0.0', '0.255.255.255') ||
    inRange(ip, '10.0.0.0', '10.255.255.255') ||
    inRange(ip, '100.64.0.0', '100.127.255.255') ||
    inRange(ip, '127.0.0.0', '127.255.255.255') ||
    inRange(ip, '169.254.0.0', '169.254.255.255') ||
    inRange(ip, '172.16.0.0', '172.31.255.255') ||
    inRange(ip, '192.168.0.0', '192.168.255.255') ||
    inRange(ip, '198.18.0.0', '198.19.255.255') ||
    inRange(ip, '224.0.0.0', '255.255.255.255')
  );
}

function firstHextet(ip: string): number {
  const token = ip.split(':').find((p) => p.length > 0) ?? '';
  const hex = token.slice(0, 4).padEnd(4, '0');
  const n = Number.parseInt(hex, 16);
  return Number.isFinite(n) ? n : -1;
}

export function isPrivateIp(ip: string): boolean {
  const raw = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!raw) return true;
  if (raw === '::1' || raw === '::' || raw === '0.0.0.0') return true;

  const v4mapped = raw.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (v4mapped) return isPrivateIpv4(v4mapped[1]!);

  if (raw.includes(':')) {
    const n = firstHextet(raw);
    if (n >= 0xfe80 && n <= 0xfebf) return true;
    if (n >= 0xfc00 && n <= 0xfdff) return true;
    if (n >= 0xff00 && n <= 0xffff) return true;
    return false;
  }
  return isPrivateIpv4(raw);
}

function parseTarget(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CollectorError('INVALID_URL', '올바른 전체 URL을 입력해 주세요.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new CollectorError('INVALID_PROTOCOL', 'http 또는 https URL만 분석할 수 있습니다.');
  }
  if (parsed.username || parsed.password) {
    throw new CollectorError('CREDENTIALS_NOT_ALLOWED', '계정 정보가 포함된 URL은 분석할 수 없습니다.');
  }
  return parsed;
}

async function resolveAddresses(hostname: string): Promise<string[]> {
  if (isIP(hostname)) return [hostname];
  const [v4, v6] = await Promise.allSettled([resolve4(hostname), resolve6(hostname)]);
  const addresses = [
    ...(v4.status === 'fulfilled' ? v4.value : []),
    ...(v6.status === 'fulfilled' ? v6.value : []),
  ];
  if (!addresses.length) {
    try {
      const system = await lookup(hostname, { all: true });
      addresses.push(...system.map((result) => result.address));
    } catch {
      /* 아래 DNS 오류로 통합 */
    }
  }
  if (!addresses.length) {
    throw new CollectorError('DNS_NOT_FOUND', '호스트를 찾을 수 없습니다.');
  }
  return addresses;
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  const parsed = parseTarget(raw);
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.lan')
  ) {
    throw new CollectorError('PRIVATE_ADDRESS', '내부 네트워크 주소는 분석할 수 없습니다.');
  }
  const addresses = await resolveAddresses(hostname);
  if (addresses.some((address) => isPrivateIp(address))) {
    throw new CollectorError('PRIVATE_ADDRESS', '내부 네트워크 주소는 분석할 수 없습니다.');
  }
  return parsed;
}

export function publicCollectorError(error: unknown): { code: string; message: string } {
  if (error instanceof CollectorError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return { code: 'TIMEOUT', message: '페이지 응답 시간이 너무 길어 수집을 중단했습니다.' };
  }
  return { code: 'FETCH_FAILED', message: '페이지를 가져오지 못했습니다. 공개 URL과 서버 상태를 확인해 주세요.' };
}
