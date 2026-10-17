import type { StoredDraft, TenantSummary } from './api'
import { publishMarkdownOf } from './draftGaps'

/**
 * 발행본 = 글쓰기 모델이 쓴 본문(publishMarkdownOf) + 코드가 붙이는 글 끝.
 *
 * 왜 둘을 나누나: 다듬은 글(채널 문체)은 본문의 지문(sourceKeyOf)으로 「원문이 바뀌었습니다」를 가린다
 * (PublishList.tsx). 링크 · 상담 안내 같은 코드 부분을 본문에 섞으면, 설정 하나만 바꿔도 다듬은 글이
 * 전부 「원문 바뀜」이 된다. 사실 가드도 본문만 보아야 한다 — 코드 부분의 주소 · 날짜는 지어낸 숫자가 아니다.
 * 그래서 본문은 그대로 두고, 자사 사이트에 올리는 복사 · .md · .html에서만 글 끝을 붙인다.
 * 고쳐 둔 글(editedMarkdown)에도 섞지 않는다 — 내보낼 때마다 붙는다.
 */

/** 글 끝을 만드는 데 필요한 브랜드 정보. */
export type ArticleBrand = Pick<TenantSummary, 'brandName' | 'ownedDomains'>

export interface ArticleContext {
  brand: ArticleBrand
}

/** 브랜드 공식 사이트 — 첫 소유 도메인의 루트. 도메인이 없으면 없다. */
export function brandSiteUrl(brand: ArticleBrand): string | undefined {
  const host = brand.ownedDomains[0]?.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
  return host ? `https://${host}/` : undefined
}

/** 본문에 이미 그 사이트로 가는 링크가 있으면 또 붙이지 않는다. */
function linksTo(markdown: string, url: string): boolean {
  const host = url.replace(/^https?:\/\//i, '').replace(/\/$/, '').toLowerCase()
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\]\\(https?://(www\\.)?${escaped}(/[^)]*)?\\)`, 'i').test(markdown)
}

/** 글 끝 — 코드가 붙이는 부분(마크다운). 붙일 것이 없으면 빈 문자열. */
export function articleTailMarkdown(body: string, ctx: ArticleContext): string {
  const lines: string[] = []
  const site = brandSiteUrl(ctx.brand)
  if (site && !linksTo(body, site)) lines.push(`[${ctx.brand.brandName} 공식 사이트](${site})`)
  return lines.length ? ['---', '', ...lines].join('\n') : ''
}

/** 자사 사이트에 올릴 발행본 — 본문 + 글 끝. 복사 · .md · .html이 같은 결과를 쓴다. */
export function publishArticleOf(stored: StoredDraft, ctx: ArticleContext): string {
  const body = publishMarkdownOf(stored)
  const tail = articleTailMarkdown(body, ctx)
  return tail ? `${body.trimEnd()}\n\n${tail}\n` : body
}
