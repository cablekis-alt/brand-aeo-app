import type { FactNode, StoredDraft, TenantSummary } from './api'
import { draftToPublishMarkdown, stripGapNotes } from './markdownFile'

/**
 * 발행용 .html — 발행용 마크다운을 완성된 HTML 문서로.
 *
 * 왜 .md 옆에 .html이 따로 있나: 자체 사이트·CMS에 올릴 때는 시맨틱 태그(<article>·<h1>·<h2>)와
 * <head>의 JSON-LD(Article + 브랜드 Organization)가 그대로 AEO 신호가 된다 — 사이트 진단에서
 * 구조화 데이터 15점을 움직이는 바로 그 신호다. 마크다운은 플랫폼이 알아서 렌더하지만 JSON-LD는
 * 우리가 심어 줄 때만 생긴다.
 *
 * 한계를 숨기지 않는다: 네이버 블로그·티스토리 같은 플랫폼은 <head>를 버린다. 그때 살아남는 건
 * 본문 HTML뿐이고 JSON-LD 효과는 자체 사이트에 올릴 때만 난다. 화면이 그 한 줄을 적는다.
 *
 * 마크다운 변환기는 우리 원고 문법(제목·단락·목록·인용·강조·링크)만 다룬다. 외부 라이브러리를
 * 넣지 않는 이유: 입력이 우리 초안(+사람이 고친 것)이라 문법이 좁고, 모르는 문법은 단락으로
 * 안전하게 떨어지면 된다. 텍스트는 전부 이스케이프한다 — 고친 글에 <script>가 있어도 문자로 남는다.
 */

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 인라인 문법 — 굵게·기울임·코드·링크. 먼저 이스케이프한 뒤 문법만 태그로 바꾼다. */
function inline(text: string): string {
  let s = escapeHtml(text)
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
  // 링크는 http(s)만 — javascript: 같은 스킴은 그대로 글자로 남긴다.
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener">$1</a>')
  return s
}

/** 발행용 마크다운 → 본문 HTML(<article> 안쪽). 문서 전체는 buildPublishHtml이 감싼다. */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let para: string[] = []
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null
  let quote: string[] = []

  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`)
    para = []
  }
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`)
    list = null
  }
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote><p>${inline(quote.join(' '))}</p></blockquote>`)
    quote = []
  }
  const flushAll = () => {
    flushPara()
    flushList()
    flushQuote()
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    const t = line.trim()
    if (!t) {
      flushAll()
      continue
    }
    const h = /^(#{1,3})\s+(.+)$/.exec(t)
    if (h) {
      flushAll()
      const level = h[1].length
      out.push(`<h${level}>${inline(h[2])}</h${level}>`)
      continue
    }
    if (/^(-{3,}|\*{3,})$/.test(t)) {
      flushAll()
      out.push('<hr>')
      continue
    }
    if (t.startsWith('>')) {
      flushPara()
      flushList()
      quote.push(t.replace(/^>\s?/, ''))
      continue
    }
    const ul = /^[-*]\s+(.+)$/.exec(t)
    const ol = /^\d+[.)]\s+(.+)$/.exec(t)
    if (ul || ol) {
      flushPara()
      flushQuote()
      const tag = ul ? 'ul' : 'ol'
      if (!list || list.tag !== tag) {
        flushList()
        list = { tag, items: [] }
      }
      list.items.push((ul ?? ol)![1])
      continue
    }
    // 그 밖은 단락. 목록·인용이 열려 있었다면 닫는다.
    flushList()
    flushQuote()
    para.push(t)
  }
  flushAll()
  return out.join('\n')
}

/** JSON-LD를 <script> 안에 넣을 때 </script> 조기 종료를 막는다. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/<\//g, '<\\/')
}

/**
 * 사실 그래프에서 Organization에 넣을 값을 고른다 — **있는 것만.** 없는 필드는 아예 쓰지 않는다.
 * 주소는 type 'location'이거나 claim에 주소·소재지가 들어간 것, 전화는 claim에 전화·연락처·대표번호.
 * 값은 그대로 문자열로 싣는다(우편번호·시군구 분해는 추측이 들어가므로 하지 않는다).
 */
function organizationFromFacts(brand: TenantSummary, facts: FactNode[]): Record<string, unknown> {
  const url = brand.brandPageUrl || (brand.ownedDomains[0] ? `https://${brand.ownedDomains[0].replace(/^https?:\/\//, '')}/` : undefined)
  const org: Record<string, unknown> = {
    '@type': 'Organization',
    '@id': url ? `${url}#organization` : undefined,
    name: brand.brandName,
    ...(brand.aliases.length > 1 ? { alternateName: brand.aliases.filter((a) => a !== brand.brandName) } : {}),
    ...(url ? { url } : {}),
  }
  const address = facts.find((f) => f.type === 'location' || /주소|소재지/.test(f.claim))
  if (address?.value) org.address = { '@type': 'PostalAddress', streetAddress: address.value, addressCountry: 'KR' }
  const phone = facts.find((f) => /전화|연락처|대표번호|문의/.test(f.claim) && /\d{2,4}[-.\s]?\d{3,4}[-.\s]?\d{4}/.test(f.value))
  if (phone?.value) org.telephone = phone.value.match(/\d{2,4}[-.\s]?\d{3,4}[-.\s]?\d{4}/)?.[0] ?? phone.value
  for (const k of Object.keys(org)) if (org[k] === undefined) delete org[k]
  return org
}

export interface PublishHtmlInput {
  stored: StoredDraft
  brand: TenantSummary
  facts: FactNode[]
}

/** 발행용 마크다운(빈칸·「이 글이 쓴 사실」 제거) — .md 버튼과 같은 원고를 쓴다. */
export function publishMarkdownOf(stored: StoredDraft): string {
  return stored.editedMarkdown ? stripGapNotes(stored.editedMarkdown) : draftToPublishMarkdown(stored.draft)
}

/** 완성된 HTML 문서. 본문은 <article>, <head>에 메타와 JSON-LD(Article + Organization). */
export function buildPublishHtml({ stored, brand, facts }: PublishHtmlInput): string {
  const md = publishMarkdownOf(stored)
  const title = stored.draft.title
  const description = (stored.draft.lead || md.split('\n').find((l) => l && !l.startsWith('#')) || '').slice(0, 160)
  const published = (stored.editedAt ?? stored.generatedAt).slice(0, 10)
  const org = organizationFromFacts(brand, facts)
  const article = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: title,
    description,
    inLanguage: 'ko',
    datePublished: published,
    dateModified: published,
    author: org,
    publisher: org,
    ...(brand.ownedDomains[0] ? { isPartOf: { '@type': 'WebSite', url: `https://${brand.ownedDomains[0].replace(/^https?:\/\//, '')}/`, name: brand.brandName } } : {}),
  }
  const body = markdownToHtml(md)

  return [
    '<!doctype html>',
    '<html lang="ko">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}">`,
    `<meta property="og:type" content="article">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:site_name" content="${escapeHtml(brand.brandName)}">`,
    `<meta property="article:published_time" content="${published}">`,
    '<script type="application/ld+json">',
    jsonForScript(article),
    '</script>',
    '</head>',
    '<body>',
    '<main>',
    `<article itemscope itemtype="https://schema.org/Article">`,
    body,
    `<footer><p><small>발행 ${published} · ${escapeHtml(brand.brandName)}</small></p></footer>`,
    '</article>',
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n')
}
