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
const SUFFIX_RE = /-(local|national|b2b)$/

const scopeOf = (b: Pick<VariantBrand, 'marketScope'>): Scope =>
  b.marketScope === 'national' || b.marketScope === 'b2b' ? b.marketScope : 'local'

/** 질문 언어 — 영어 측정 브랜드는 지역 꼬리표 「(영어 질문)」로도 알아본다(lib/portfolioView isEnglishCohort와 같은 표시). */
const languageOf = (b: Pick<VariantBrand, 'questionLanguage' | 'region'>): string =>
  b.questionLanguage ?? (b.region.includes('(영어 질문)') ? 'en' : 'ko')

export function hostKey(domain: string): string {
  return domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '')
}

/** 범위 변형의 id — 바탕 id(이미 꼬리가 붙어 있으면 뗀다)에 범위 꼬리를 붙인다. gunsan + 전국형 → gunsan-national. */
export function variantTenantId(baseId: string, scope: string | undefined): string {
  return `${baseId.replace(SUFFIX_RE, '')}-${SCOPE_SUFFIX[scopeOf({ marketScope: scope })]}`
}

/** 홈페이지가 하나라도 겹치는가. */
export function sharesSite(a: Pick<VariantBrand, 'ownedDomains'>, b: Pick<VariantBrand, 'ownedDomains'>): boolean {
  const hosts = new Set(a.ownedDomains.map(hostKey).filter(Boolean))
  return b.ownedDomains.some((d) => hosts.has(hostKey(d)))
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

export function scopeLabel(scope: string | undefined): string {
  return SCOPE_LABEL[scopeOf({ marketScope: scope })]
}
