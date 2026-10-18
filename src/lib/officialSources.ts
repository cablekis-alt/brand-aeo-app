import type { ContentDraft } from '../prompts/b9c-content-draft'

/**
 * 공식 출처 링크 — 블로그 글 형식(format 'article')의 절이 robots.txt · AI 검색 크롤러 · URL 검사 같은 주제를 다루면, 그 절
 * 끝에 「참고:」로 공식 안내 문서를 붙인다(src/lib/markdownFile.ts). 글쓰기 엔진은 주소를 쓰지 않는다(b9c 규칙 8) — 엔진이
 * 쓴 주소는 확인할 수 없어서, 사람이 열어 확인한 이 목록만 쓴다.
 *
 * 목록을 고칠 때: 주소를 열어 그 기관의 공식 문서인지, 제목이 label과 맞는지 확인하고 checkedAt을 고친다. 확인하지 않은
 * 주소는 넣지 않는다. label에는 숫자를 쓰지 않는다 — 고친 글의 사실 확인이 「출처 없는 숫자」로 잡는다.
 */
export interface OfficialSource {
  id: string
  label: string
  url: string
  /** 절 제목 · 본문에서 이 주제를 찾는 말. */
  match: RegExp
  /** 사람이 주소를 열어 확인한 날. */
  checkedAt: string
}

/** 앞에 둔 것이 먼저 붙는다 — 한 절에 여러 주제가 겹치면 이 순서로 MAX_PER_SECTION개까지. */
export const OFFICIAL_SOURCES: readonly OfficialSource[] = [
  {
    id: 'google-robots',
    label: 'Google 검색 센터 — robots.txt 소개',
    url: 'https://developers.google.com/search/docs/crawling-indexing/robots/intro',
    match: /robots\.txt/i,
    checkedAt: '2026-10-18',
  },
  {
    id: 'openai-bots',
    label: 'OpenAI — 크롤러 안내(OAI-SearchBot · GPTBot)',
    url: 'https://developers.openai.com/api/docs/bots',
    match: /OAI-SearchBot|GPTBot|ChatGPT-User|OpenAI\s?크롤러|오픈AI\s?크롤러/i,
    checkedAt: '2026-10-18',
  },
  {
    id: 'google-url-inspection',
    label: 'Search Console 도움말 — URL 검사 도구',
    url: 'https://support.google.com/webmasters/answer/9012289',
    // 「URL 검사」만으로는 보안 제품(악성 URL 검사)과 겹친다 — Search Console · 구글 · 색인과 함께일 때만.
    match: /Search Console|서치\s?콘솔|URL Inspection|(?:구글|Google)\s?(?:의\s?)?URL\s?검사|색인\s?생성\s?요청/i,
    checkedAt: '2026-10-18',
  },
  {
    id: 'perplexity-bots',
    label: 'Perplexity — 크롤러 안내(PerplexityBot)',
    url: 'https://docs.perplexity.ai/guides/bots',
    match: /PerplexityBot|Perplexity-User|퍼플렉시티\s?크롤러/i,
    checkedAt: '2026-10-18',
  },
  {
    id: 'google-structured-data',
    label: 'Google 검색 센터 — 구조화된 데이터 소개',
    url: 'https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data',
    // 「구조화된 데이터」만으로는 데이터 분석 제품과 겹친다 — 마크업 · 검색 · 구글과 함께일 때만.
    match: /JSON-LD|schema\.org|스키마\s?마크업|구조화(?:된)?\s?데이터\s?마크업|(?:구글|Google|검색)[^\n]{0,20}구조화(?:된)?\s?데이터/i,
    checkedAt: '2026-10-18',
  },
  {
    id: 'google-sitemaps',
    label: 'Google 검색 센터 — 사이트맵 알아보기',
    url: 'https://developers.google.com/search/docs/crawling-indexing/sitemaps/overview',
    // 「사이트맵」만으로는 홈페이지 메뉴 안내와 겹친다 — 제출 · 등록 · XML일 때만.
    match: /sitemap\.xml|XML\s?(?:사이트맵|sitemap)|사이트맵[^\n.]{0,10}(?:제출|등록)/i,
    checkedAt: '2026-10-18',
  },
  {
    id: 'google-ai-features',
    label: 'Google 검색 센터 — AI 기능과 웹사이트',
    url: 'https://developers.google.com/search/docs/appearance/ai-features',
    // 「AI 모드」는 가전 · 셋톱 기능 이름이기도 하다 — 구글 검색의 AI 개요 · AI 모드일 때만.
    match: /AI Overviews?|(?:구글|Google)\s?(?:의\s?)?(?:검색\s?)?AI\s?(?:개요|모드|Mode)/i,
    checkedAt: '2026-10-18',
  },
]

/** 한 절에 붙이는 공식 출처 수 — 참고 링크가 본문보다 많아 보이지 않게. */
const MAX_PER_SECTION = 2

/**
 * 절마다 붙일 공식 출처 — d.sections와 같은 순서 · 같은 길이. 절 제목과 쓴 문단(빈칸 제외)에서 주제를 찾고, 같은 출처는
 * 글 전체에서 한 번만(먼저 나온 절에) 붙인다. 쓴 문단이 없는 절(빈칸만 있는 절)에는 붙이지 않는다 — 발행본에서 빠지는 절이라
 * 작업용과 발행본의 링크 자리가 어긋나지 않게. 옛 형식 초안에는 붙이지 않는다(빈 배열).
 */
export function articleSources(d: ContentDraft): OfficialSource[][] {
  if (d.format !== 'article') return d.sections.map(() => [])
  const used = new Set<string>()
  return d.sections.map((sec) => {
    const texts = sec.blocks.filter((b) => b.kind !== 'gap' && (b.body ?? '').trim()).map((b) => b.body ?? '')
    if (!texts.length) return []
    const text = [sec.heading, ...texts].join('\n')
    const picked: OfficialSource[] = []
    for (const src of OFFICIAL_SOURCES) {
      if (picked.length >= MAX_PER_SECTION) break
      if (used.has(src.id) || !src.match.test(text)) continue
      used.add(src.id)
      picked.push(src)
    }
    return picked
  })
}

/** 절 끝 「참고:」 한 줄. */
export function sourcesLine(sources: readonly OfficialSource[]): string {
  return `참고: ${sources.map((s) => `[${s.label}](${s.url})`).join(' · ')}`
}
