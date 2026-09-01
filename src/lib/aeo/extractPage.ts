import type { HeadingItem, JsonLdEntity, PageSignals } from './types.ts'
import { clip, unique } from './clip.ts'
import { inferPageType } from './pageType.ts'

function attr(el: Element | null, name: string): string {
  return el?.getAttribute(name)?.trim() ?? ''
}

function textOf(el: Element | null): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function metaContent(doc: Document, key: string): string {
  const want = key.toLowerCase()
  for (const el of doc.querySelectorAll('meta')) {
    const name = (
      el.getAttribute('name') ||
      el.getAttribute('property') ||
      el.getAttribute('http-equiv') ||
      ''
    ).toLowerCase()
    if (name !== want) continue
    const value = attr(el, 'content')
    if (value) return value
  }
  return ''
}

const JSON_LD_DATE_KEYS = new Set([
  'datepublished',
  'datemodified',
  'datecreated',
  'lastreviewed',
  'dateposted',
])

function collectJsonLd(doc: Document): { entities: JsonLdEntity[]; dates: string[] } {
  const entities: JsonLdEntity[] = []
  const dates: string[] = []
  const walk = (node: unknown, depth: number) => {
    if (!node || depth > 10) return
    if (Array.isArray(node)) {
      node.forEach((item) => walk(item, depth + 1))
      return
    }
    if (typeof node !== 'object') return
    const rec = node as Record<string, unknown>
    const rawType = rec['@type']
    const types = Array.isArray(rawType)
      ? rawType.map(String)
      : rawType
        ? [String(rawType)]
        : []
    const name = typeof rec.name === 'string' ? rec.name : null
    if (types.length || name) entities.push({ types, name })
    for (const [key, value] of Object.entries(rec)) {
      if (key === '@context') continue
      if (JSON_LD_DATE_KEYS.has(key.toLowerCase()) && typeof value === 'string' && value.trim()) {
        dates.push(value.trim())
      }
      walk(value, depth + 1)
    }
  }
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    const raw = script.textContent?.trim()
    if (!raw) continue
    try {
      walk(JSON.parse(raw), 0)
    } catch {
      entities.push({ types: ['InvalidJSON-LD'], name: clip(raw, 80) })
    }
  }
  return { entities, dates: unique(dates) }
}

/** Primary-topic YMYL only. Customer-vertical mentions (의료 클리닉 고객사) must not match. */
const YMYL_PRIMARY =
  /의료\s*(정보|상담|진료|가이드|칼럼)|병원\s*(진료|예약|안내)|질병\s*(치료|정보)|처방약|법률\s*(상담|자문|가이드)|변호사\s*(사무실|상담|선임)|소송\s*대리|보험\s*(상품|가입|청구|가이드)|대출\s*(금리|상품|한도|가이드)|투자\s*(자문|권유|상품|가이드)|세무\s*(상담|신고)|증상\s*(과|은|이|치료)|(?:^|\s)클리닉(?:\s|$)|medical advice|health insurance|\bdiagnos(?:is|e[sd])\b|\battorney\b|\blawyer\b|investment advice|\bpersonal loan\b/i

const YMYL_ADVICE_BODY =
  /치료법|복용법|부작용|처방전|진료과|법률\s*효력|이자율\s*보장|수익률\s*보장|이\s*글을\s*의학적/

const CUSTOMER_VERTICAL =
  /고객사|도입 사례|업종 예시|버티컬|솔루션을 제공|예약 안내 챗봇|B2B|자동화합니다|소프트웨어|플랫폼|산업군/

const ADVICE_TITLE =
  /치료 가이드|진료 안내|처방|복용|법률 상담|변호사 선임|대출 금리|보험 청구|투자 자문|세무 상담|medical advice|symptoms of|symptoms and causes|symptoms-causes|diagnosis and treatment/i

/** Path of a condition encyclopedia / clinic advice page, not a generic /health marketing site. */
const EN_MEDICAL_URL =
  /\/diseases-conditions\/|\/symptoms-causes\/|\/health-conditions\/|\/condition\/[a-z0-9-]+/i

const EN_CONDITION_IN_TITLE =
  /\b(type\s*[12]\s*diabetes|diabetes|hypertension|asthma|alzheimer'?s|influenza|covid-?19|stroke|arthritis|cancer)\b/i

const EN_ADVICE_FRAME =
  /symptom|cause|treatment|diagnos|disease|condition|side effects/i

const AUTH_RE =
  /로그인\s*필요|회원\s*전용|paywall|subscribe to (read|continue)|sign in to continue|this content is for members/i

const DATE_RE =
  /\b20\d{2}[-./년]\s*\d{1,2}[-./월]\s*\d{1,2}|\b20\d{2}-\d{2}-\d{2}\b/g

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
const PHONE_RE = /(?:\+82[\s-]?)?0?\d{1,3}[\s.-]?\d{3,4}[\s.-]?\d{4}/
const ADDRESS_RE = /시\s|구\s|로\s\d|길\s\d|광역시|특별시|도\s\S+시/

const JUNK_SELECTOR = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'link',
  'nav',
  'footer',
  '[hidden]',
  '[aria-hidden="true"]',
  '.sr-only',
  '.visually-hidden',
  '.screen-reader-text',
  '.noprint',
  '#nojs',
  '.ambox',
  '.tmbox',
  '.cmbox',
  '.ombox',
  '.fmbox',
  '.hatnote',
  '.dablink',
  '#siteNotice',
  '.mw-editsection',
  'ol.references',
  '.reflist',
  '.navbox',
  '.vertical-navbox',
  '.sidebar',
  '#toc',
  '.toc',
  '.vector-toc',
  '.mw-portlet',
  '[role="note"]',
].join(',')

const FALLBACK_RE =
  /displays a fallback because interactive scripts did not run|enable javascript to view|javascript(?:가|이)?\s*(?:꺼져|비활성)|이 페이지는\s*폴백/i

const BOILERPLATE_RE =
  /this (article|page) (needs|may not|is a stub)|additional citations for verification|from wikipedia, the free encyclopedia|please help improve this article|이 문서는|출처가 필요합니다|위키백과,\s*우리 모두의 백과사전|this page was last edited|part of a series on/gi

export function isPlaceholderHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase()
    return (
      /^(example\.(com|net|org|edu)|example\.invalid|example\.test)$/.test(host) ||
      host.endsWith('.example.com') ||
      host.endsWith('.example.net') ||
      host.endsWith('.example.org')
    )
  } catch {
    return false
  }
}

export function isWikiHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    return host === 'wikipedia.org' || host.endsWith('.wikipedia.org') || host.endsWith('.wikimedia.org')
  } catch {
    return false
  }
}

export function isReferenceHost(url: string): boolean {
  if (isWikiHost(url)) return true
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    return (
      host === 'developer.mozilla.org' ||
      host === 'python.org' ||
      host.endsWith('.python.org')
    )
  } catch {
    return false
  }
}

function hostBrand(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    const head = host.split('.')[0] ?? ''
    if (head.length < 3 || /^(www|en|m|docs|www2)$/i.test(head)) return ''
    return head.charAt(0).toUpperCase() + head.slice(1)
  } catch {
    return ''
  }
}

function isDecorativeHeading(text: string): boolean {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length < 2) return true
  if (/^(logo|more|menu|close|search|skip|home)$/i.test(t)) return true
  if (/\blogo\b/i.test(t) && t.length < 28) return true
  if (/^\d+(\.\d+)?x$/i.test(t)) return true
  return false
}

export function collapsePrimaryH1s(h1s: string[], title: string, ogTitle = ''): string[] {
  const cleaned = unique(
    h1s.map((h) => h.replace(/\s+/g, ' ').trim()).filter((h) => h && !isDecorativeHeading(h)),
  )
  if (cleaned.length <= 2) return cleaned
  const hay = `${title} ${ogTitle}`.replace(/\s+/g, ' ').trim().toLowerCase()
  const aligned = cleaned.filter((h) => hay.includes(h.toLowerCase()))
  if (aligned.length) return unique(aligned).slice(0, 2)
  return cleaned.slice(0, 1)
}

const REVIEW_CUE_RE =
  /검토|전문의|자격|면책|reviewed by|medically reviewed|licensed|disclaimer|not a substitute|medical advice|Mayo Clinic Staff|editorial policy|대체하지 않습니다/i

export function isBoilerplateText(text: string): boolean {
  BOILERPLATE_RE.lastIndex = 0
  return BOILERPLATE_RE.test(text)
}

export function purifyBody(text: string): string {
  let t = text.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\u00a0/g, ' ')
  t = t.replace(FALLBACK_RE, ' ')
  t = t.replace(BOILERPLATE_RE, ' ')
  t = t.replace(/skip to (main )?content/gi, ' ')
  t = t.replace(/\b(accept all cookies|쿠키 동의|cookie settings)\b/gi, ' ')
  t = t.replace(/\s+/g, ' ').trim()
  const parts = t.split(/(?<=[.。!?]|다\.|요\.)\s+/)
  const out: string[] = []
  for (const p of parts) {
    const piece = p.trim()
    if (!piece || out[out.length - 1] === piece || isBoilerplateText(piece)) continue
    out.push(piece)
  }
  return out.join(' ')
}

function usableHydratedString(value: string): boolean {
  const s = value.replace(/\s+/g, ' ').trim()
  if (s.length < 16 || s.length > 2500) return false
  if (/^(https?:\/\/|\/_next\/|flex|grid|rgb\(|#[0-9a-f]{3,8})/i.test(s)) return false
  if (!/[가-힣A-Za-z]{8,}/.test(s)) return false
  return /[\s.,'’]/.test(s) || /[가-힣]{8,}/.test(s)
}

function walkJsonStrings(node: unknown, out: string[], depth = 0) {
  if (depth > 8 || out.length > 80) return
  if (typeof node === 'string') {
    if (usableHydratedString(node)) out.push(node.trim())
    return
  }
  if (Array.isArray(node)) {
    node.slice(0, 50).forEach((item) => walkJsonStrings(item, out, depth + 1))
    return
  }
  if (node && typeof node === 'object') {
    Object.values(node)
      .slice(0, 60)
      .forEach((item) => walkJsonStrings(item, out, depth + 1))
  }
}

export function extractHydratedText(doc: Document): string {
  const chunks: string[] = []
  const scripts = doc.querySelectorAll(
    'script#__NEXT_DATA__, script[id="__NUXT_DATA__"], script[type="application/json"]',
  )
  for (const script of scripts) {
    const raw = script.textContent?.trim()
    if (!raw) continue
    try {
      const strings: string[] = []
      walkJsonStrings(JSON.parse(raw), strings)
      chunks.push(...strings)
    } catch {
      /* ignore invalid JSON islands */
    }
  }
  for (const noscript of doc.querySelectorAll('noscript')) {
    const t = textOf(noscript)
    if (t.length >= 40 && !FALLBACK_RE.test(t)) chunks.push(t)
  }
  return purifyBody(chunks.join(' '))
}

export function detectYmyl(title: string, h1s: string[], firstText: string, pageUrl = ''): boolean {
  const primary = `${title} ${h1s.join(' ')}`
  const blob = `${primary} ${firstText}`
  const englishAdvice =
    EN_MEDICAL_URL.test(pageUrl) ||
    (EN_CONDITION_IN_TITLE.test(primary) && EN_ADVICE_FRAME.test(primary))
  if (
    CUSTOMER_VERTICAL.test(blob) &&
    !ADVICE_TITLE.test(primary) &&
    !YMYL_PRIMARY.test(primary) &&
    !englishAdvice
  ) {
    return false
  }
  if (englishAdvice || ADVICE_TITLE.test(primary) || YMYL_PRIMARY.test(primary)) return true
  return YMYL_ADVICE_BODY.test(firstText)
}

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).hostname.replace(/^www\./, '') === new URL(b).hostname.replace(/^www\./, '')
  } catch {
    return false
  }
}

function compactStyle(el: Element): string {
  return attr(el, 'style').replace(/\s+/g, '').toLowerCase()
}

function isInlineHidden(el: Element): boolean {
  const style = compactStyle(el)
  return style.includes('display:none') || style.includes('visibility:hidden')
}

function collapseCarousels(root: HTMLElement) {
  for (const host of root.querySelectorAll('.slideshow, .flex-slideshow, .carousel, .slider')) {
    const slides = [...host.querySelectorAll('ul.slides > li')]
    const items = slides.length ? slides : [...host.querySelectorAll('.slide')]
    items.slice(1).forEach((node) => node.remove())
  }
}

function pruneHiddenAndFallback(root: HTMLElement) {
  for (const el of [...root.querySelectorAll('*')]) {
    if (isInlineHidden(el)) {
      el.remove()
      continue
    }
    const text = textOf(el)
    if (FALLBACK_RE.test(text) && text.length < 400) el.remove()
  }
}

function looksLikeOfficialContact(pageUrl: string, root: HTMLElement, mainText: string): boolean {
  try {
    const host = new URL(pageUrl).hostname.replace(/^www\./, '')
    if (/\.wikipedia\.org$|\.wikimedia\.org$/.test(host) || host === 'wikipedia.org') return false
  } catch {
    /* invalid URL: still inspect visible contact cues */
  }
  if (root.querySelector('a[href^="mailto:"], a[href^="tel:"]')) return true
  const hasEmail = EMAIL_RE.test(mainText)
  const hasPhone = PHONE_RE.test(mainText)
  if (!hasEmail && !hasPhone) return false
  return /문의|연락처|고객센터|대표전화|contact us|\bemail\b|전화\s*[:：]/i.test(mainText)
}

function pickContentRoot(clone: HTMLElement): HTMLElement {
  const selectors = ['#mw-content-text', 'main', '[role="main"]', '#content', 'article', '#root']
  for (const sel of selectors) {
    const el = clone.querySelector(sel)
    if (el && textOf(el).length >= 40) return el as HTMLElement
  }
  return clone
}

function visibleHeadings(root: HTMLElement): { h1s: string[]; h2s: string[]; h3s: string[]; outline: HeadingItem[] } {
  const outline: HeadingItem[] = [...root.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((el) => ({
    level: Number(el.tagName.slice(1)),
    text: textOf(el),
  })).filter((h) => h.text)

  let h1s = unique(outline.filter((h) => h.level === 1).map((h) => h.text))
  if (!h1s.length) {
    const aria = [...root.querySelectorAll('[role="heading"][aria-level="1"]')].map(textOf).filter(Boolean)
    h1s = unique(aria)
  }
  return {
    h1s,
    h2s: unique(outline.filter((h) => h.level === 2).map((h) => h.text)),
    h3s: unique(outline.filter((h) => h.level === 3).map((h) => h.text)),
    outline,
  }
}

export function extractPage(input: {
  requestedUrl: string
  finalUrl: string
  status: number
  contentType: string
  redirected: boolean
  html: string
  robotsTxt: string
  robotsTxtStatus: number | null
  sitemapFound: boolean
  llmsTxtFound: boolean
  xRobotsTag: string
  fetchError: string | null
  fetchErrorCode?: string | null
  renderMode?: 'static' | 'browser'
  rendered?: {
    mainText: string
    headings: { level: number; text: string }[]
    listCount: number
    tableCount: number
  } | null
  renderWarning?: string | null
}): PageSignals {
  const previousTitle = document.title
  const doc = new DOMParser().parseFromString(input.html || '', 'text/html')
  document.title = previousTitle
  const base = input.finalUrl || input.requestedUrl

  const robotsMeta = unique(
    [...doc.querySelectorAll('meta[name="robots" i], meta[name="googlebot" i], meta[name="bingbot" i]')]
      .map((el) => attr(el, 'content'))
      .filter(Boolean),
  )
  const robotsJoined = `${robotsMeta.join(',')},${input.xRobotsTag}`.toLowerCase()

  const title = textOf(doc.querySelector('title'))

  const clone = doc.body ? (doc.body.cloneNode(true) as HTMLElement) : document.createElement('div')
  clone.querySelectorAll(JUNK_SELECTOR).forEach((n) => n.remove())
  collapseCarousels(clone)
  pruneHiddenAndFallback(clone)

  const ogTitle = metaContent(doc, 'og:title')
  const ogSiteName = metaContent(doc, 'og:site_name')
  const htmlHeadings = visibleHeadings(clone)
  const renderedOutline = (input.rendered?.headings ?? []).filter((heading) => heading.text)
  const headings = renderedOutline.length
    ? {
        h1s: unique(renderedOutline.filter((h) => h.level === 1).map((h) => h.text)),
        h2s: unique(renderedOutline.filter((h) => h.level === 2).map((h) => h.text)),
        h3s: unique(renderedOutline.filter((h) => h.level === 3).map((h) => h.text)),
        outline: renderedOutline,
      }
    : htmlHeadings
  const h1s = collapsePrimaryH1s(headings.h1s.length ? headings.h1s : htmlHeadings.h1s, title, ogTitle)
  const contentRoot = pickContentRoot(clone)
  const htmlBody = purifyBody(textOf(contentRoot))
  let mainText = purifyBody(input.rendered?.mainText || htmlBody)
  if (
    input.rendered?.mainText &&
    htmlBody &&
    !/\bis (a|an|the) |programming language|official home|application-layer protocol/i.test(mainText) &&
    /\bis (a|an|the) |programming language|official home|application-layer protocol/i.test(htmlBody)
  ) {
    mainText = purifyBody(`${htmlBody} ${mainText}`)
  }
  const hydrated = extractHydratedText(doc)
  if (mainText.split(/\s+/).filter(Boolean).length < 60 && hydrated) {
    mainText = purifyBody(`${mainText} ${hydrated}`.trim())
  }
  const words = mainText.split(/\s+/).filter(Boolean)
  const firstText = mainText.slice(0, 800)

  const { entities: jsonLdEntities, dates: jsonLdDates } = collectJsonLd(doc)
  const jsonLdTypes = unique(jsonLdEntities.flatMap((e) => e.types))

  const anchors = [...doc.querySelectorAll('a[href]')].map((a) => {
    try {
      return new URL(a.getAttribute('href') ?? '', base).href
    } catch {
      return ''
    }
  })
  const internal = anchors.filter((h) => h && sameHost(h, base))
  const external = anchors.filter((h) => h && !sameHost(h, base) && /^https?:/i.test(h))

  const aboutOrContactLinks = unique(
    [...doc.querySelectorAll('a[href]')]
      .filter((a) =>
        /about|contact|company|overview|소개|문의|회사|오시는|채용/i.test(
          `${textOf(a)} ${a.getAttribute('href') ?? ''}`,
        ),
      )
      .map((a) => textOf(a) || a.getAttribute('href') || '')
      .filter(Boolean),
  )

  const authorCandidates = unique([
    ...[...doc.querySelectorAll('[itemprop="author"], .author, .byline, [rel="author"]')].map(textOf),
    ...jsonLdEntities.filter((e) => e.types.some((t) => /person/i.test(t))).map((e) => e.name ?? ''),
  ]).filter(Boolean)

  const brand = hostBrand(base)
  const orgCandidates = unique([
    ogSiteName,
    ...jsonLdEntities.filter((e) => e.types.some((t) => /organization|localbusiness/i.test(t))).map((e) => e.name ?? ''),
    brand && new RegExp(brand, 'i').test(`${title} ${ogTitle} ${ogSiteName} ${h1s.join(' ')}`) ? brand : '',
  ]).filter(Boolean)

  const dates = unique([
    ...[...doc.querySelectorAll('time')].map((el) => attr(el, 'datetime') || textOf(el)),
    metaContent(doc, 'article:published_time'),
    metaContent(doc, 'article:modified_time'),
    metaContent(doc, 'og:updated_time'),
    metaContent(doc, 'publishdate'),
    metaContent(doc, 'date'),
    metaContent(doc, 'last-modified'),
    textOf(doc.querySelector('#footer-info-lastmod, [itemprop="dateModified"], [itemprop="datePublished"]')),
    ...jsonLdDates,
    ...(mainText.match(DATE_RE) ?? []),
  ]).filter(Boolean)

  const reviewBlob = [
    mainText,
    ...authorCandidates,
    ...orgCandidates,
    ...jsonLdEntities.map((e) => e.name ?? ''),
    textOf(doc.querySelector('.byline, [itemprop="author"], footer, .disclaimer')),
  ].join(' ')
  const reviewOrDisclaimer = REVIEW_CUE_RE.test(reviewBlob)

  const images = [...doc.querySelectorAll('img')]
  const emptyAltCount = images.filter((img) => !img.getAttribute('alt')?.trim()).length
  const scripts = doc.querySelectorAll('script[src], script:not([type]), script[type="text/javascript"]')
  const iframes = doc.querySelectorAll('iframe')
  const spaShell =
    mainText.replace(/\s+/g, '').length < 80 &&
    scripts.length >= 4 &&
    /root|app|__next|nuxt/i.test(doc.body?.innerHTML ?? '')

  const canonical =
    attr(doc.querySelector('link[rel="canonical"]'), 'href') || metaContent(doc, 'og:url')

  // 봇 차단(WAF) 챌린지 감지: JS로 쿠키를 세팅하고 리다이렉트하는 껍데기 페이지.
  // slowAES/cupid.js/ckattempt 같은 알려진 시그니처, 또는 본문이 거의 없는데
  // "쿠키 설정 + location 리다이렉트" 스크립트만 있는 경우.
  const rawHtml = input.html || ''
  const knownChallenge = /slowAES|toNumbers\(|\bckattempt\b|cupid\.js|imperva|distil_r_captcha|_Incapsula_/i.exec(rawHtml)
  const cookieRedirect =
    /document\.cookie\s*=/.test(rawHtml) && /location\.(href|replace|assign)|meta[^>]+http-equiv=["']?refresh/i.test(rawHtml)
  const botChallenge = Boolean(knownChallenge) || (cookieRedirect && words.length < 20)
  const botChallengeEvidence = botChallenge
    ? knownChallenge?.[0]
      ? `봇 차단 스크립트 감지: ${clip(knownChallenge[0], 40)}`
      : 'JS 쿠키 설정 후 리다이렉트하는 봇 차단 페이지'
    : ''

  const signals: PageSignals = {
    requestedUrl: input.requestedUrl,
    finalUrl: input.finalUrl,
    status: input.status,
    contentType: input.contentType,
    redirected: input.redirected,
    crossHostRedirect: !sameHost(input.requestedUrl, input.finalUrl || input.requestedUrl),
    fetchError: input.fetchError,
    fetchErrorCode: input.fetchErrorCode ?? null,
    collectionMode: input.renderMode ?? 'static',
    renderWarning: input.renderWarning ?? null,
    title,
    metaDescription:
      metaContent(doc, 'description') || metaContent(doc, 'og:description') || metaContent(doc, 'twitter:description'),
    canonical,
    robotsMeta,
    xRobotsTag: input.xRobotsTag,
    robotsTxt: input.robotsTxt,
    robotsTxtStatus: input.robotsTxtStatus,
    sitemapFound: input.sitemapFound,
    llmsTxtFound: input.llmsTxtFound,
    lang: attr(doc.documentElement, 'lang'),
    h1s,
    h2s: headings.h2s,
    h3s: headings.h3s,
    headingOutline: headings.outline,
    ogTitle,
    ogSiteName,
    ogType: metaContent(doc, 'og:type'),
    ogUrl: metaContent(doc, 'og:url'),
    jsonLdTypes,
    jsonLdEntities,
    wordCount: words.length,
    mainText,
    firstText,
    listCount: input.rendered?.listCount ?? doc.querySelectorAll('ul, ol').length,
    tableCount: input.rendered?.tableCount ?? doc.querySelectorAll('table').length,
    faqLike:
      jsonLdTypes.some((t) => /faq/i.test(t)) ||
      /faq|자주\s*묻는|Q&A|질의응답/i.test(`${headings.h2s.join(' ')} ${headings.h3s.join(' ')}`),
    internalLinkCount: unique(internal).length,
    externalLinkCount: unique(external).length,
    aboutOrContactLinks,
    authorCandidates,
    orgCandidates,
    dates,
    phoneOrEmail: looksLikeOfficialContact(base, contentRoot, mainText),
    addressLike: ADDRESS_RE.test(mainText),
    reviewOrDisclaimer,
    noindex: /\bnoindex\b/.test(robotsJoined),
    nofollow: /\bnofollow\b/.test(robotsJoined),
    noai:
      /\bnoai\b|\bnoimageai\b/.test(robotsJoined) ||
      Boolean(doc.querySelector('meta[name="robots" i][content*="noai" i]')),
    nosnippet: /\bnosnippet\b/.test(robotsJoined),
    maxSnippetZero: /max-snippet\s*:\s*0/.test(robotsJoined),
    scriptCount: scripts.length,
    spaShell: input.renderMode === 'browser' ? false : spaShell,
    iframeCount: iframes.length,
    iframeOnly: words.length < 30 && iframes.length > 0,
    authWall: AUTH_RE.test(mainText) || input.status === 401 || input.status === 403,
    authWallEvidence: AUTH_RE.exec(mainText)?.[0] ?? (input.status === 401 || input.status === 403 ? `HTTP ${input.status}` : ''),
    botChallenge,
    botChallengeEvidence,
    ymyl: detectYmyl(title, h1s, firstText, base),
    pageType: 'other',
    emptyAltCount,
    imageCount: images.length,
  }
  return { ...signals, pageType: inferPageType(signals) }
}
