export interface FetchPayload {
  requestedUrl: string
  finalUrl: string
  status: number
  contentType: string
  redirected: boolean
  html: string
  xRobotsTag: string
  robotsTxt: string
  robotsTxtStatus: number | null
  sitemapFound: boolean
  llmsTxtFound: boolean
  renderMode: 'static' | 'browser'
  rendered: {
    mainText: string
    headings: { level: number; text: string }[]
    listCount: number
    tableCount: number
  } | null
  renderWarning: string | null
  fetchError: string | null
  fetchErrorCode: string | null
}

/**
 * 공개 페이지 하나를 수집 프록시(/api/fetch)로 받는다. probes: false면 robots.txt · sitemap.xml · llms.txt를 함께 조사하지 않는다 —
 * 사진 후보 · 장소 페이지처럼 본문만 쓰는 곳(src/lib/sitePhotos.ts)이 페이지마다 sitemap(군산각 510KB)을 다시 받지 않게. 그때
 * robotsTxt · sitemapFound · llmsTxtFound는 비어 있다(조사하지 않음).
 */
export async function fetchPage(url: string, options: { probes?: boolean } = {}): Promise<FetchPayload> {
  const endpoint = `/api/fetch?url=${encodeURIComponent(url)}${options.probes === false ? '&probes=0' : ''}`
  const res = await fetch(endpoint)
  if (!res.ok) {
    throw new Error(`수집 프록시 오류 (${res.status})`)
  }
  return (await res.json()) as FetchPayload
}
