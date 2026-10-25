import type { TenantSummary } from '../api'
import { hostKey, sharesSite } from '../brandVariant'

/**
 * Site AEO 진단 대상 결정 — 입력이 URL이면 그대로, 상호면 도메인을 찾는다.
 *
 * 해석 순서(비용이 없는 것부터):
 *   ① URL·도메인 형태          → 그대로 사용            (호출 0회)
 *   ② 등록된 브랜드명과 일치     → 그 브랜드의 소유 도메인 (호출 0회)
 *   ③ 그 외                    → /api/infer?kind=identify 추론 (LLM 1회)
 *
 * ①②는 순수 함수라 여기서 처리하고, ③은 네트워크가 필요해 호출부가 맡는다.
 */

export type TargetSource = 'url' | 'tenant' | 'infer'

export interface ResolvedTarget {
  /** 진단할 https URL. */
  url: string
  source: TargetSource
  /** ②·③에서 확정된 브랜드명 — 화면 표시와 엔티티 일치 판정의 기준이 된다. */
  brandName?: string
  /** ②에서 맞은 등록 브랜드의 id — 별칭까지 쓰려면 필요하다. */
  tenantId?: string
}

/**
 * 입력이 URL·도메인 형태인지. 한글 상호는 점이 없어 걸리지 않는다.
 * `k-wonjin.co.kr` · `https://x.test/a?b=1` · `KAONGROUP.COM` → true
 * `삼성서울병원` · `t'order` · `WJ 원진성형외과` → false
 */
export function looksLikeUrl(input: string): boolean {
  const s = input.trim()
  if (!s) return false
  if (/\s/.test(s)) return false // 공백이 있으면 상호로 본다
  if (/^https?:\/\//i.test(s)) return true
  // 경로·쿼리를 떼고 호스트 부분만 본다.
  const host = s.split(/[/?#]/)[0]
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(host)
}

/** 도메인·URL을 진단용 https URL로 만든다. */
export function toHttpsUrl(domainOrUrl: string): string {
  const s = domainOrUrl.trim()
  return /^https?:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, '')}`
}

/** 비교용 정규화 — 공백·대소문자·구두점 차이를 없앤다("WJ 원진성형외과" ↔ "wj원진성형외과"). */
function norm(value: string): string {
  return value
    .toLowerCase()
    .replace(/[()[\]{}<>|·・,./\\'"`~!@#$%^&*_+=?:;-]/g, '')
    .replace(/\s+/g, '')
    .trim()
}

/**
 * 등록된 브랜드에서 입력과 맞는 것을 찾는다.
 *
 * 정확히 일치하는 게 있으면 그것, 없으면 부분 일치를 보되 **후보가 둘 이상이면 포기**한다
 * ("원진"만 넣었을 때 엉뚱한 브랜드를 골라 남의 사이트를 진단하는 사고를 막는다).
 * 후보가 모두 같은 홈페이지의 브랜드(다른 범위로 하나 더 등록한 브랜드)면 같은 사이트라 포기하지 않는다 — 지금 고른 브랜드가 그중에
 * 있으면 그것, 아니면 첫 브랜드.
 */
export function findTenantByName(input: string, tenants: TenantSummary[], preferred?: TenantSummary | null): TenantSummary | null {
  const q = norm(input)
  if (q.length < 2) return null

  const namesOf = (t: TenantSummary) => [t.brandName, ...(t.aliases ?? [])].map(norm).filter((n) => n.length >= 2)
  const pick = (found: TenantSummary[]): TenantSummary | null => {
    if (found.length <= 1) return found[0] ?? null
    if (!found.every((t) => sharesSite(t, found[0]))) return null
    return found.find((t) => t.tenantId === preferred?.tenantId) ?? found[0]
  }

  const exact = tenants.filter((t) => namesOf(t).includes(q))
  if (exact.length > 0) return pick(exact)

  return pick(tenants.filter((t) => namesOf(t).some((n) => n.includes(q) || q.includes(n))))
}

/**
 * 브랜드의 대표 주소를 진단용 URL로. 없으면 null.
 *
 * 등록된 브랜드 페이지가 있으면 그쪽이 먼저다. 소유 도메인은 "누구 것인가"를 정하는 값이지
 * "열리는 주소"가 아니다 — 가온그룹은 소유 도메인이 kaongroup.com인데 그 호스트에 A 레코드가
 * 없다(www.kaongroup.com만 뜬다). 소유 도메인은 인용 집계의 기준이라 그대로 두고,
 * 열어 볼 주소만 브랜드 페이지로 바로잡는다.
 */
export function tenantSiteUrl(tenant: Pick<TenantSummary, 'ownedDomains' | 'brandPageUrl'>): string | null {
  const page = tenant.brandPageUrl?.trim()
  if (page) return toHttpsUrl(page)
  const domain = tenant.ownedDomains?.[0]?.trim()
  return domain ? toHttpsUrl(domain) : null
}

/** ①② — 네트워크 없이 결정되는 경우만 돌려준다. 못 정하면 null(호출부가 ③으로 넘긴다). */
export function resolveWithoutNetwork(input: string, tenants: TenantSummary[], preferred?: TenantSummary | null): ResolvedTarget | null {
  const s = input.trim()
  if (!s) return null
  if (looksLikeUrl(s)) return { url: toHttpsUrl(s), source: 'url' }

  const tenant = findTenantByName(s, tenants, preferred)
  if (tenant) {
    const url = tenantSiteUrl(tenant)
    if (url) return { url, source: 'tenant', brandName: tenant.brandName, tenantId: tenant.tenantId }
  }
  return null
}

/**
 * URL의 호스트를 소유한 등록 브랜드. 서브도메인도 인정한다(m.k-wonjin.co.kr → k-wonjin).
 * 여럿이 맞으면 더 구체적인 주소(shop.x.com > x.com)를 가진 브랜드가 이긴다. 같은 주소를 쓰는 브랜드가 여럿이면(다른 범위로 하나 더
 * 등록한 브랜드 · 영어 측정 -en) 지금 고른 브랜드(preferred)가 이긴다 — 목록의 첫 브랜드로만 가면 나머지 브랜드에는 사이트 점수가
 * 쌓이지 않았다(2026-10-21 gunsan · gunsan-national).
 */
export function findTenantByDomain(url: string, tenants: TenantSummary[], preferred?: TenantSummary | null): TenantSummary | null {
  let host: string
  try {
    host = new URL(toHttpsUrl(url)).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return null
  }
  let best: { tenant: TenantSummary; length: number } | null = null
  for (const t of preferred ? [preferred, ...tenants] : tenants) {
    for (const raw of t.ownedDomains ?? []) {
      const d = hostKey(raw)
      if (!d || (host !== d && !host.endsWith(`.${d}`))) continue
      // 길이가 같으면 먼저 본 브랜드(고른 브랜드 → 목록 순서)가 남는다.
      if (!best || d.length > best.length) best = { tenant: t, length: d.length }
    }
  }
  return best?.tenant ?? null
}

/**
 * 엔티티 일치 판정의 **주체 브랜드**를 정한다 — 진단한 페이지가 "누구의 것인지"와 짝이 맞아야 한다.
 *
 * 드롭다운에서 고른 브랜드를 그대로 쓰면 안 된다. 입력이 다른 브랜드로 해석될 수 있어서
 * (상호를 넣거나 남의 URL을 넣는 경우) 뷰성형외과 페이지를 t'order 기준으로 판정하는 일이 생긴다.
 *
 *   ② 등록 브랜드명으로 찾음 → 그 브랜드(별칭 포함)
 *   ③ 상호 추론            → 추론된 상호(별칭 없음)
 *   ① URL 입력             → 그 호스트를 소유한 등록 브랜드, 없으면 현재 선택 브랜드
 *
 * 마지막 경우는 `viaSelected: true`다 — 주소가 그 브랜드 것이라는 근거가 없다. 그 브랜드의 블로그 글 · 새 도메인일 수도,
 * 상관없는 남의 사이트일 수도 있으니, 판정 전에 페이지가 그 브랜드를 부르는지(pageMentionsBrand) 확인해야 한다.
 */
export function subjectBrand(
  target: ResolvedTarget,
  tenants: TenantSummary[],
  selected: TenantSummary | undefined,
): { brandName: string; aliases: string[]; viaSelected: boolean } | null {
  if (target.source === 'tenant') {
    const t = tenants.find((x) => x.tenantId === target.tenantId)
    if (t) return { brandName: t.brandName, aliases: t.aliases ?? [], viaSelected: false }
  }
  if (target.source === 'infer' && target.brandName) {
    return { brandName: target.brandName, aliases: [], viaSelected: false }
  }
  const owner = findTenantByDomain(target.url, tenants, selected)
  if (owner) return { brandName: owner.brandName, aliases: owner.aliases ?? [], viaSelected: false }
  return selected ? { brandName: selected.brandName, aliases: selected.aliases ?? [], viaSelected: true } : null
}
