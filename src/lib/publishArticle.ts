import type { StoredDraft, TenantSummary } from './api'
import { renderEvidenceMarkdown } from './answerEvidence'
import { publishMarkdownOf } from './draftGaps'
import type { PublishSettings } from './publishSettings'

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
  /** 브랜드별 발행 설정 — 상담 안내 · 문의 링크(src/lib/publishSettings.ts). 없으면 공식 사이트 링크만. */
  settings?: PublishSettings | null
}

/**
 * 브랜드 공식 사이트 — 발행 설정의 공식 사이트 주소(settings.siteUrl)가 있으면 그것, 없으면 첫 소유 도메인의 루트.
 * 둘 다 없으면 없다. 루트만 쓰면 한 도메인을 경로로 나눠 쓰는 브랜드(…/s/stay)는 플랫폼 첫 화면으로 간다.
 */
export function brandSiteUrl(brand: ArticleBrand, settings?: PublishSettings | null): string | undefined {
  if (settings?.siteUrl) return settings.siteUrl
  const host = brand.ownedDomains[0]?.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
  return host ? `https://${host}/` : undefined
}

/** 본문에 이미 그 사이트로 가는 링크가 있으면 또 붙이지 않는다. */
function linksTo(markdown: string, url: string): boolean {
  const host = url.replace(/^https?:\/\//i, '').replace(/\/$/, '').toLowerCase()
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\]\\(https?://(www\\.)?${escaped}(/[^)]*)?\\)`, 'i').test(markdown)
}

/**
 * 글 끝 — 코드가 붙이는 부분(마크다운). 붙일 것이 없으면 빈 문자열.
 * 순서: 상담 안내 → 문의 링크 → 공식 사이트 링크. 문단마다 빈 줄로 나눈다(한 문단으로 붙지 않게).
 */
export function articleTailMarkdown(body: string, ctx: ArticleContext): string {
  const paras: string[] = []
  const s = ctx.settings
  if (s?.ctaText) paras.push(s.ctaText)
  if (s?.inquiryUrl && !linksTo(body, s.inquiryUrl)) paras.push(`[문의하기](${s.inquiryUrl})`)
  const site = brandSiteUrl(ctx.brand, s)
  if (site && !linksTo(body, site) && site !== s?.inquiryUrl) paras.push(`[${ctx.brand.brandName} 공식 사이트](${site})`)
  return paras.length ? ['---', ...paras].join('\n\n') : ''
}

/**
 * 자사 사이트에 올릴 발행본 — 본문 + 실측 사례(사람이 확인했을 때만) + 글 끝. 복사 · .md · .html이 같은 결과를 쓴다.
 * 붙일 것이 없으면 본문 그대로다(바이트까지 같다).
 */
/**
 * 채널 줄에서 복사할 글 — 블로그 문체로 다듬은 글이면 글 끝(상담 안내 · 문의 · 공식 사이트)을 붙인다. 블로그는 우리가 쓴
 * 글임이 드러나는 곳이라 안내가 어울린다. 위키 · 커뮤니티 · 후기 · 보도 · 소셜은 홍보 문구로 지워지거나 광고로 읽혀 그대로 둔다.
 */
export function channelCopyOf(adapted: { markdown: string; style: string }, ctx: ArticleContext): string {
  if (adapted.style !== 'blog') return adapted.markdown
  const tail = articleTailMarkdown(adapted.markdown, ctx)
  return tail ? `${adapted.markdown.trimEnd()}\n\n${tail}\n` : adapted.markdown
}

export function publishArticleOf(stored: StoredDraft, ctx: ArticleContext): string {
  const body = publishMarkdownOf(stored)
  const evidence = renderEvidenceMarkdown(stored.evidence)
  const tail = articleTailMarkdown(`${body}\n${evidence}`, ctx)
  const extra = [evidence, tail].filter(Boolean)
  return extra.length ? `${[body.trimEnd(), ...extra].join('\n\n')}\n` : body
}
