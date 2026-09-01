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

export async function fetchPage(url: string): Promise<FetchPayload> {
  const endpoint = `/api/fetch?url=${encodeURIComponent(url)}`
  const res = await fetch(endpoint)
  if (!res.ok) {
    throw new Error(`수집 프록시 오류 (${res.status})`)
  }
  return (await res.json()) as FetchPayload
}
