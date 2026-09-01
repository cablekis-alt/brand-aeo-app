export type PublicUrlResult =
  | { ok: true; href: string; hostname: string }
  | { ok: false; error: string }

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map((p) => Number(p))
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return -1
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0
}

function inRange(ip: string, start: string, end: string): boolean {
  const n = ipv4ToInt(ip)
  const a = ipv4ToInt(start)
  const b = ipv4ToInt(end)
  if (n < 0 || a < 0 || b < 0) return false
  return n >= a && n <= b
}

export function isPrivateIpv4(ip: string): boolean {
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
  )
}

function firstHextet(ip: string): number {
  const token = ip.split(':').find((p) => p.length > 0) ?? ''
  const hex = token.slice(0, 4).padEnd(4, '0')
  const n = Number.parseInt(hex, 16)
  return Number.isFinite(n) ? n : -1
}

export function isPrivateIp(ip: string): boolean {
  const raw = ip.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!raw) return true
  if (raw === '::1' || raw === '::' || raw === '0.0.0.0') return true

  const v4mapped = raw.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)
  if (v4mapped) return isPrivateIpv4(v4mapped[1]!)

  if (raw.includes(':')) {
    const n = firstHextet(raw)
    if (n >= 0xfe80 && n <= 0xfebf) return true
    if (n >= 0xfc00 && n <= 0xfdff) return true
    if (n >= 0xff00 && n <= 0xffff) return true
    return false
  }
  return isPrivateIpv4(raw)
}

export function hostLooksLikeIp(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '')
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return true
  return h.includes(':')
}

export function parsePublicHttpUrl(raw: string): PublicUrlResult {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, error: 'URL이 비어 있습니다.' }

  const href = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(href)
  } catch {
    return { ok: false, error: 'URL 형식이 올바르지 않습니다.' }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'http(s) URL만 허용됩니다.' }
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: '사용자 정보가 포함된 URL은 허용되지 않습니다.' }
  }
  if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
    return { ok: false, error: '80/443 포트만 허용됩니다.' }
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!hostname) return { ok: false, error: '호스트가 없습니다.' }
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.lan')
  ) {
    return { ok: false, error: '사설 호스트는 수집할 수 없습니다.' }
  }
  if (hostLooksLikeIp(hostname) && isPrivateIp(hostname)) {
    return { ok: false, error: '사설 IP는 수집할 수 없습니다.' }
  }
  return { ok: true, href: parsed.href, hostname }
}
