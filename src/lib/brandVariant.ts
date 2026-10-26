/**
 * 같은 홈페이지를 다른 시장 범위로 하나 더 등록한 브랜드(범위 변형) — 서버(server/tenantPromote.ts)와 화면이 함께 쓴다.
 *
 * 왜: 브랜드 id는 홈페이지 첫 마디라(cohortPlan.ts slugFromDomain) 같은 홈페이지는 같은 id로 부딪혀, 지역형으로 등록한 브랜드를
 * 전국형으로도 재려면 설정 파일을 손으로 고쳐야 했다(2026-10-21 군산각 gunsan · gunsan-national). 영어 질문 측정(-en)처럼
 * id에 범위 꼬리를 붙여 따로 등록한다. 이름은 바꾸지 않는다 — 질문 생성 · 판정 · 글에 그대로 들어가기 때문이다. 화면에서만
 * 같은 홈페이지를 쓰는 고객 브랜드가 둘 이상일 때 「지역형 / 전국형 / B2B형」 표시를 붙여 가른다.
 *
 * 질문지가 업종__지역으로 묶이므로(server/cohortQuestionBank.ts cohortKey) 업종이나 지역이 달라야 다른 질문을 푼다 —
 * 전국형과 B2B형은 지역이 둘 다 「국내」라 업종까지 같으면 같은 코호트가 된다.
 */
import { isSharedPlatformHost } from './sharedHosts.js'

/** 범위 변형이 다루는 브랜드 값 — 서버 TenantConfig와 화면 TenantSummary 모두 이 모양을 가진다. */
export interface VariantBrand {
  tenantId: string
  ownedDomains: string[]
  industry: string
  region: string
  marketScope?: string
  questionLanguage?: string
  cohortOnly?: boolean
}

type Scope = 'local' | 'national' | 'b2b'
const SCOPE_SUFFIX: Record<Scope, string> = { local: 'local', national: 'national', b2b: 'b2b' }
const SCOPE_LABEL: Record<Scope, string> = { local: '지역형', national: '전국형', b2b: 'B2B형' }
const SUFFIX_RE = /-(local|national|b2b)(-\d+)?$/

const scopeOf = (b: Pick<VariantBrand, 'marketScope'>): Scope =>
  b.marketScope === 'national' || b.marketScope === 'b2b' ? b.marketScope : 'local'

/** 질문 언어 — 영어 측정 브랜드는 지역 꼬리표 「(영어 질문)」로도 알아본다(lib/portfolioView isEnglishCohort와 같은 표시). */
const languageOf = (b: Pick<VariantBrand, 'questionLanguage' | 'region'>): string =>
  b.questionLanguage ?? (b.region.includes('(영어 질문)') ? 'en' : 'ko')

export function hostKey(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^www\./, '')
}

/**
 * 범위 변형의 id — 바탕 id에 범위 꼬리를 붙인다(gunsan + 전국형 → gunsan-national). 바탕이 이미 변형이면(꼬리를 뗀 id가 같은
 * 홈페이지의 브랜드로 있으면) 꼬리를 바꿔 붙인다(gunsan-national + 지역형 → gunsan-local). 도메인에서 온 id가 우연히 -local 등으로
 * 끝나면 떼지 않는다. 그 id가 이미 있으면(같은 범위의 두 번째 변형 — 업종이나 지역이 다르다) -2, -3을 붙인다.
 */
export function variantTenantId(
  base: Pick<VariantBrand, 'tenantId' | 'ownedDomains'>,
  scope: string | undefined,
  all: Pick<VariantBrand, 'tenantId' | 'ownedDomains'>[],
): string {
  const stripped = base.tenantId.replace(SUFFIX_RE, '')
  const root = stripped !== base.tenantId && all.some((t) => t.tenantId === stripped && sharesSite(t, base)) ? stripped : base.tenantId
  const stem = `${root}-${SCOPE_SUFFIX[scopeOf({ marketScope: scope })]}`
  const taken = new Set(all.map((t) => t.tenantId))
  let id = stem
  for (let n = 2; taken.has(id); n += 1) id = `${stem}-${n}`
  return id
}

/** 같은 홈페이지로 볼 호스트 — 네이버 블로그 · 인스타그램 같은 플랫폼 주소는 여러 업체가 함께 쓰므로 뺀다(lib/sharedHosts.ts). */
function siteHosts(b: Pick<VariantBrand, 'ownedDomains'>): string[] {
  return b.ownedDomains.map(hostKey).filter((h) => h && !isSharedPlatformHost(h))
}

/** 홈페이지가 하나라도 겹치는가(플랫폼 주소는 겹쳐도 다른 업체다). */
export function sharesSite(a: Pick<VariantBrand, 'ownedDomains'>, b: Pick<VariantBrand, 'ownedDomains'>): boolean {
  const hosts = new Set(siteHosts(a))
  return siteHosts(b).some((h) => hosts.has(h))
}

/** 같은 질문지 · 순위표를 쓰는가 — 업종 · 지역 · 질문 언어가 모두 같다. */
export function sameCohort(a: VariantBrand, b: VariantBrand): boolean {
  return a.industry === b.industry && a.region === b.region && languageOf(a) === languageOf(b)
}

/** 같은 홈페이지를 쓰는 다른 고객 브랜드(경쟁사로만 재는 브랜드와 다른 언어 측정은 뺀다). */
export function siblingsOf<T extends VariantBrand>(t: VariantBrand, all: T[]): T[] {
  return all.filter((o) => o.tenantId !== t.tenantId && !o.cohortOnly && languageOf(o) === languageOf(t) && sharesSite(o, t))
}

/**
 * 목록에 붙일 범위 표시 — 같은 홈페이지를 쓰는 고객 브랜드가 둘 이상일 때만. 형제끼리 범위가 같으면(업종만 다른 변형) 업종을 쓴다.
 * 형제가 없으면 null — 평소 목록은 그대로다.
 */
export function variantTag(t: VariantBrand, all: VariantBrand[]): string | null {
  if (t.cohortOnly) return null
  const siblings = siblingsOf(t, all)
  if (siblings.length === 0) return null
  const scope = scopeOf(t)
  return siblings.some((s) => scopeOf(s) === scope) ? t.industry : SCOPE_LABEL[scope]
}

/** 화면에 보일 브랜드 이름 — 같은 홈페이지를 쓰는 형제가 있으면 범위 꼬리표를 붙인다(「군산각 · 전국형」). 없으면 이름 그대로. */
export function brandLabel(t: VariantBrand & { brandName: string }, all: VariantBrand[]): string {
  const tag = variantTag(t, all)
  return tag ? `${t.brandName} · ${tag}` : t.brandName
}

/**
 * 상호 칸에 들어온 값이 주소인가 — 「https://」 · 「www.」로 시작하거나 「/」로 끝나면 사람들이 부르는 이름이 아니다. 그대로 등록하면
 * 이름과 별칭이 주소가 되어 AI 답변 속 「도전과나눔」을 언급으로 세지 못한다(실측 dona — 상용화 UI 3차 U7). 막고 홈페이지 칸으로 옮긴다.
 */
export function isAddressLike(name: string): boolean {
  const t = name.trim()
  return /^(https?:\/\/|www\.)/i.test(t) || (t.length > 1 && t.endsWith('/'))
}

/** 상호가 도메인 모양인가(「trip.com」) — 막지 않고 확인만 한다(도메인이 실제로 부르는 이름인 곳도 있다). */
export function isDomainLike(name: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(name.trim())
}

export function scopeLabel(scope: string | undefined): string {
  return SCOPE_LABEL[scopeOf({ marketScope: scope })]
}
