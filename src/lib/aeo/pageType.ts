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
 * Category max scores by page type. Each row sums to 100.
 * 기본 분포는 aeocheck.co.kr의 공개 가중치에 정렬한다:
 *   AI 크롤러 접근·색인 26(=accessibility), 콘텐츠 구조 22(=answer_content),
 *   E-E-A-T·최신성 18(=trust), 구조화 데이터 15(=structure),
 *   기술 기초 12(=citability로 매핑), 에이전트 접근성 7(=entity로 매핑).
 * 페이지 유형별로 성격을 반영해 조정하되(예: 로컬은 entity, YMYL은 trust 가중),
 * aeocheck와 근접하도록 편차를 과도하게 두지 않는다.
 */
export const PAGE_TYPE_WEIGHTS: Record<PageType, Record<CategoryId, number>> = {
  other: {
    accessibility: 26,
    answer_content: 22,
    structure: 15,
    trust: 18,
    citability: 12,
    entity: 7,
  },
  saas_home: {
    accessibility: 24,
    answer_content: 24,
    structure: 14,
    trust: 13,
    citability: 15,
    entity: 10,
  },
  article: {
    accessibility: 22,
    answer_content: 20,
    structure: 15,
    trust: 20,
    citability: 15,
    entity: 8,
  },
  news: {
    accessibility: 22,
    answer_content: 18,
    structure: 14,
    trust: 22,
    citability: 16,
    entity: 8,
  },
  product: {
    accessibility: 24,
    answer_content: 22,
    structure: 16,
    trust: 14,
    citability: 16,
    entity: 8,
  },
  local_business: {
    accessibility: 24,
    answer_content: 16,
    structure: 13,
    trust: 18,
    citability: 11,
    entity: 18,
  },
  // YMYL(의료·법률·금융): E-E-A-T를 아주 살짝만 가중하고(trust 20 vs aeocheck 18) 나머지는
  // aeocheck 기본 분포에 맞춘다 — 클리닉 등 YMYL 사이트 결과가 aeocheck과 근접하도록.
  medical: {
    accessibility: 24,
    answer_content: 20,
    structure: 14,
    trust: 20,
    citability: 14,
    entity: 8,
  },
  legal: {
    accessibility: 24,
    answer_content: 20,
    structure: 14,
    trust: 20,
    citability: 14,
    entity: 8,
  },
  finance: {
    accessibility: 24,
    answer_content: 20,
    structure: 14,
    trust: 20,
    citability: 14,
    entity: 8,
  },
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
