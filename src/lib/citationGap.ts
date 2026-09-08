import type { CitationSourceAnalysis, CitationSourceUrlRow } from '../prompts/b7-citation-sources'

// 인용 갭 분석 — AI가 인용하지만 우리 브랜드 언급을 뒷받침하지 않는 출처(도메인/URL)를 찾는다.
// = "AI가 답을 찾으러 가는 곳인데 우리는 없는" 곳 → 콘텐츠·PR을 넣을 지점.
// 새 수집 없이 B7 인용출처(CitationSourceAnalysis)만으로 계산한다.
export interface GapRow {
  domain: string
  kind: CitationSourceUrlRow['kind']
  ownerType: string
  citationCount: number
  engines: string[]
  urls: string[] // 이 도메인의 대표 URL(최대 몇 개)
}

export interface CitationGapSummary {
  gapDomains: GapRow[] // 브랜드 미지원 출처, 인용수 많은 순
  competitorDomains: GapRow[] // 그중 경쟁사 소유
  authorityDomains: GapRow[] // 그중 뉴스·공공·위키·후기 등 권위/플랫폼
  gapCitationShare: number // 전체 인용 중 브랜드 미지원 비율
}

const AUTHORITY_KINDS = new Set(['news', 'gov', 'wiki', 'review', 'forum'])

export function computeCitationGap(analysis: CitationSourceAnalysis): CitationGapSummary {
  // 브랜드 언급을 뒷받침하지 않는(=우리가 없는) URL만 남긴다. 자사 공식 출처는 갭이 아니다.
  const gapUrls = analysis.urls.filter(
    (u) => u.supportingBrandMentionCount === 0 && u.kind !== 'brand-official' && u.ownerType !== 'brand-owned',
  )

  const byDomain = new Map<string, GapRow>()
  for (const u of gapUrls) {
    const row = byDomain.get(u.domain) ?? {
      domain: u.domain,
      kind: u.kind,
      ownerType: u.ownerType,
      citationCount: 0,
      engines: [],
      urls: [],
    }
    row.citationCount += u.citationCount
    row.engines = [...new Set([...row.engines, ...u.engines])]
    if (row.urls.length < 3 && !row.urls.includes(u.raw)) row.urls.push(u.raw)
    byDomain.set(u.domain, row)
  }

  const gapDomains = [...byDomain.values()].sort((a, b) => b.citationCount - a.citationCount)
  const competitorDomains = gapDomains.filter((d) => d.kind === 'competitor' || d.ownerType === 'competitor-owned')
  const authorityDomains = gapDomains.filter(
    (d) => AUTHORITY_KINDS.has(d.kind) && d.kind !== 'competitor' && d.ownerType !== 'competitor-owned',
  )

  const gapCitations = gapUrls.reduce((s, u) => s + u.citationCount, 0)
  const gapCitationShare = analysis.totalCitations > 0 ? gapCitations / analysis.totalCitations : 0

  return { gapDomains, competitorDomains, authorityDomains, gapCitationShare }
}
