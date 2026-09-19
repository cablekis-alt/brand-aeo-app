import { lookup, resolve4, resolve6 } from 'node:dns/promises';
import { connect, isIP } from 'node:net';

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
  if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
    throw new CollectorError('INVALID_PORT', '80/443 포트만 분석할 수 있습니다.');
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

/**
 * fetch 실패의 원인 코드 — undici는 TypeError('fetch failed')로 감싸고 실제 원인을 cause에 둔다.
 * cause가 또 cause를 가질 수 있어 몇 단계 따라간다.
 */
function causeCodeOf(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return '';
}

/** 원인 코드별 문구. 사람이 다음에 무엇을 할지 알 수 있게 쓴다 — "확인해 주세요"로 끝내지 않는다. */
const CAUSE_MESSAGE: Record<string, { code: string; message: string }> = {
  ECONNREFUSED: { code: 'CONNECTION_REFUSED', message: '서버가 연결을 거부했습니다 — 도메인은 살아 있지만 웹 서버가 꺼져 있거나 포트가 닫혀 있습니다.' },
  ETIMEDOUT: { code: 'CONNECT_TIMEOUT', message: '서버에 연결하지 못했습니다 — 주소는 찾았지만 응답이 없습니다(방화벽 차단이거나 서버가 내려간 상태).' },
  EHOSTUNREACH: { code: 'HOST_UNREACHABLE', message: '서버에 도달할 수 없습니다 — 네트워크 경로가 끊겨 있습니다.' },
  ENETUNREACH: { code: 'HOST_UNREACHABLE', message: '서버에 도달할 수 없습니다 — 네트워크 경로가 끊겨 있습니다.' },
  ECONNRESET: { code: 'CONNECTION_RESET', message: '서버가 연결을 끊었습니다 — 수집기 접근을 막고 있을 수 있습니다.' },
  ENOTFOUND: { code: 'DNS_NOT_FOUND', message: '호스트를 찾을 수 없습니다 — 도메인 철자와 DNS를 확인해 주세요.' },
  EAI_AGAIN: { code: 'DNS_TEMPORARY', message: 'DNS 조회에 일시적으로 실패했습니다. 잠시 뒤 다시 시도해 주세요.' },
  CERT_HAS_EXPIRED: { code: 'TLS_ERROR', message: 'HTTPS 인증서가 만료됐습니다 — 인증서를 갱신해야 수집할 수 있습니다.' },
  ERR_TLS_CERT_ALTNAME_INVALID: { code: 'TLS_ERROR', message: 'HTTPS 인증서의 도메인이 주소와 맞지 않습니다.' },
  DEPTH_ZERO_SELF_SIGNED_CERT: { code: 'TLS_ERROR', message: 'HTTPS 인증서가 자체 서명이라 검증할 수 없습니다.' },
  SELF_SIGNED_CERT_IN_CHAIN: { code: 'TLS_ERROR', message: 'HTTPS 인증서 체인에 자체 서명 인증서가 있어 검증할 수 없습니다.' },
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: { code: 'TLS_ERROR', message: 'HTTPS 인증서를 검증하지 못했습니다(중간 인증서 누락일 수 있습니다).' },
};

/**
 * 수집 실패를 사람이 읽을 문구로. **동기 매핑만** 한다 — 연결 자체가 안 된 것인지까지 가리려면
 * describeCollectFailure를 쓴다.
 */
export function publicCollectorError(error: unknown): { code: string; message: string } {
  if (error instanceof CollectorError) {
    return { code: error.code, message: error.message };
  }
  const mapped = CAUSE_MESSAGE[causeCodeOf(error)];
  if (mapped) return mapped;
  if (error instanceof Error && error.name === 'AbortError') {
    return { code: 'TIMEOUT', message: '페이지 응답 시간이 너무 길어 수집을 중단했습니다.' };
  }
  return { code: 'FETCH_FAILED', message: '페이지를 가져오지 못했습니다. 공개 URL과 서버 상태를 확인해 주세요.' };
}

/**
 * 해당 호스트의 웹 포트가 TCP 연결을 받아 주는지. 실패 경로에서만 부른다.
 *
 * 이미 assertPublicUrl로 공개 주소임을 확인한 호스트에만 쓴다(SSRF 가드를 우회하지 않는다).
 */
async function tcpReachable(hostname: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: hostname, port });
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * 수집 실패 진단 — 타임아웃일 때 **연결이 안 된 것인지, 연결은 됐는데 느린 것인지**를 가린다.
 *
 * 왜 나누나: 둘 다 "응답 시간이 너무 길어 수집을 중단했습니다"로 나오면 사람이 "우리 앱이 느린가"로
 * 읽고 기다린다. 실제로는 포트가 닫혀 있어 몇 번을 눌러도 같은 결과다(2026-09-19 실측:
 * web4ai.o2osolution.ai는 ping은 3ms로 살아 있는데 443·80이 전부 무응답이었다).
 * 그래서 AbortError가 나면 같은 호스트에 짧은 TCP 연결을 한 번 시도해 사실을 확인하고,
 * "연결 못 함"과 "느림"을 다른 문구로 돌려준다.
 */
export async function describeCollectFailure(error: unknown, url: string): Promise<{ code: string; message: string }> {
  const base = publicCollectorError(error);
  if (base.code !== 'TIMEOUT') return base;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return base;
  }
  // https로 왔다면 collectPage가 http로도 한 번 더 시도한 뒤다(fetchWithProtocolFallback).
  // 그러니 두 포트를 함께 확인해야 메시지가 사실과 맞는다 — "443만 막혔다"고 쓰면 틀린 안내가 된다.
  const ports = parsed.port
    ? [Number(parsed.port)]
    : parsed.protocol === 'http:'
      ? [80]
      : [443, 80];
  const reachable = await Promise.all(ports.map((port) => tcpReachable(parsed.hostname, port, 3_000)));
  const open = ports.filter((_, i) => reachable[i]);
  if (open.length > 0) {
    return {
      code: 'RESPONSE_TIMEOUT',
      message: `${parsed.hostname}에 연결은 됐지만(포트 ${open.join('·')}) 응답이 너무 느려 중단했습니다 — AI 크롤러도 같은 이유로 이 페이지를 지나칠 수 있습니다.`,
    };
  }
  return {
    code: 'CONNECT_TIMEOUT',
    message: `${parsed.hostname}에 연결하지 못했습니다 — 주소(DNS)는 찾았지만 포트 ${ports.join('·')}이 응답하지 않습니다(서버가 내려갔거나 방화벽 차단). 기다려도 같은 결과이니 사이트 상태를 확인하거나 사실이 적힌 다른 주소를 써 주세요.`,
  };
}
