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

/** Category max scores by page type. Each row sums to 100. */
export const PAGE_TYPE_WEIGHTS: Record<PageType, Record<CategoryId, number>> = {
  other: {
    accessibility: 15,
    answer_content: 20,
    structure: 15,
    trust: 20,
    citability: 20,
    entity: 10,
  },
  saas_home: {
    accessibility: 15,
    answer_content: 24,
    structure: 14,
    trust: 14,
    citability: 18,
    entity: 15,
  },
  article: {
    accessibility: 12,
    answer_content: 18,
    structure: 15,
    trust: 22,
    citability: 25,
    entity: 8,
  },
  news: {
    accessibility: 12,
    answer_content: 16,
    structure: 14,
    trust: 24,
    citability: 24,
    entity: 10,
  },
  product: {
    accessibility: 14,
    answer_content: 22,
    structure: 16,
    trust: 14,
    citability: 22,
    entity: 12,
  },
  local_business: {
    accessibility: 16,
    answer_content: 16,
    structure: 12,
    trust: 18,
    citability: 16,
    entity: 22,
  },
  medical: {
    accessibility: 12,
    answer_content: 16,
    structure: 12,
    trust: 30,
    citability: 22,
    entity: 8,
  },
  legal: {
    accessibility: 12,
    answer_content: 16,
    structure: 12,
    trust: 30,
    citability: 22,
    entity: 8,
  },
  finance: {
    accessibility: 12,
    answer_content: 16,
    structure: 12,
    trust: 28,
    citability: 24,
    entity: 8,
  },
}

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
    if (/법률|변호사|소송|legal|attorney|lawyer/i.test(blob)) return 'legal'
    if (/대출|보험|투자|세무|finance|\bloan\b|investment advice/i.test(blob)) return 'finance'
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
