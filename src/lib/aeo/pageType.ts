import type { CategoryId, PageSignals, PageType } from './types.ts'

export const PAGE_TYPE_KO: Record<PageType, string> = {
  article: '기사',
  news: '뉴스',
  product: '제품',
  saas_home: 'SaaS 홈',
  local_business: '로컬 비즈니스',
  medical: '의료',
  legal: '법률',
  finance: '금융',
  other: '기타',
}

/**
 * 영역별 배점 — aeocheck.co.kr은 페이지 유형과 무관하게 고정 가중치를 쓰므로,
 * 모든 유형이 동일한 분포(합 100)를 쓴다. 유형(pageType)은 EEAT 전문성 요구·콘텐츠 임계 등
 * 감점 판단에만 쓰이고, 영역 배점 자체는 바꾸지 않는다.
 */
const AEOCHECK_WEIGHTS: Record<CategoryId, number> = {
  crawler: 26,
  content: 22,
  eeat: 18,
  structured: 15,
  technical: 12,
  agent: 7,
}

export const PAGE_TYPE_WEIGHTS: Record<PageType, Record<CategoryId, number>> = {
  other: AEOCHECK_WEIGHTS,
  saas_home: AEOCHECK_WEIGHTS,
  article: AEOCHECK_WEIGHTS,
  news: AEOCHECK_WEIGHTS,
  product: AEOCHECK_WEIGHTS,
  local_business: AEOCHECK_WEIGHTS,
  medical: AEOCHECK_WEIGHTS,
  legal: AEOCHECK_WEIGHTS,
  finance: AEOCHECK_WEIGHTS,
}

/**
 * 의료기관 자체 사이트(성형외과·치과 등)를 제목·H1에서 식별한다.
 * 본문에 "고객사"·"보험" 같은 말이 섞여도 발행 주체가 병원임을 판별하는 기준이라
 * YMYL 판정(extractPage)과 유형 분류(여기)가 같은 정의를 공유해야 한다.
 */
export const MEDICAL_ESTABLISHMENT =
  /성형외과|피부과|치과|한의원|정형외과|안과|산부인과|이비인후과|비뇨기과|신경외과|재활의학과|가정의학과|(?:^|\s)의원(?:\s|$)|의료법인|병(?:\s|·)?의원/

function primaryText(s: Pick<PageSignals, 'title' | 'h1s'>): string {
  return `${s.title} ${s.h1s.join(' ')}`
}

function pagePath(s: Pick<PageSignals, 'requestedUrl' | 'finalUrl'>): string {
  const raw = s.finalUrl || s.requestedUrl || ''
  try {
    const path = new URL(raw).pathname.replace(/\/+$/, '')
    return path || '/'
  } catch {
    return '/'
  }
}

function isHomePath(path: string): boolean {
  return path === '/' || /^\/index\.(html?|php)$/i.test(path)
}

function isProductPath(path: string): boolean {
  return /\/(payments?|pricing|checkout|billing|products?|features|plans)(\/|$)/i.test(path)
}

function isArticlePath(path: string): boolean {
  return /\/(wiki|docs|blog|articles?|news|learn|help)\b/i.test(path)
}

function isSaasCopy(blob: string): boolean {
  return /saas|솔루션|플랫폼|자동화|B2B|소프트웨어|payment processing platform/i.test(blob)
}

export function inferPageType(s: PageSignals): PageType {
  const primary = primaryText(s)
  const blob = `${primary} ${s.firstText}`
  const types = s.jsonLdTypes.join(' ')
  const path = pagePath(s)

  if (s.ymyl) {
    // 병원 사이트는 본문에 "보험 임플란트"처럼 금융 낱말이 섞여도 의료로 본다.
    if (MEDICAL_ESTABLISHMENT.test(primary)) return 'medical'
    // 법률·금융 판정은 제목·H1(primary)에서만 본다 — 본문 낱말로는 업종이 뒤집히기 쉽다.
    if (/법률|변호사|소송|legal|attorney|lawyer/i.test(primary)) return 'legal'
    if (/대출|보험|투자|세무|finance|\bloan\b|investment advice/i.test(primary)) return 'finance'
    return 'medical'
  }

  if (/newsarticle/i.test(types) || /뉴스|보도자료|press release/i.test(blob)) return 'news'

  if (/product|softwareapplication/i.test(types) || isProductPath(path)) return 'product'

  if (/localbusiness/i.test(types) || (s.addressLike && s.phoneOrEmail && s.wordCount < 400)) {
    return 'local_business'
  }

  if (isSaasCopy(blob) && !isArticlePath(path)) return 'saas_home'

  if (/article/i.test(types) && s.wordCount >= 250 && !isHomePath(path) && !isProductPath(path)) {
    return 'article'
  }

  if (isHomePath(path) || /^welcome to\b/i.test(s.title)) return 'other'

  if (isArticlePath(path)) return 'article'
  if (s.wordCount >= 350 && s.h2s.length >= 2) return 'article'
  return 'other'
}
