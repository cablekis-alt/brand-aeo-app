import type { CitationSourceAnalysis, CitationSourceKind, CitationSourceUrlRow } from '../prompts/b7-citation-sources'
import { tidyUrl } from './citationView'

// 인용 갭 분석 — AI가 인용하지만 우리 브랜드 언급을 뒷받침하지 않는 출처(도메인/URL)를 찾는다.
// = "AI가 답을 찾으러 가는 곳인데 우리는 없는" 곳 → 콘텐츠·PR을 넣을 지점.
// 새 수집 없이 B7 인용출처(CitationSourceAnalysis)만으로 계산한다.

/**
 * 화면의 칩 필터 단위. 출처 유형(kind) 위에 경쟁사를 둘로 가른다 —
 * 판정의 'competitor'는 답변에 나온 아무 동종 업체에도 붙어서(원진 W38: 20곳 중 코호트는 5곳)
 * "우리가 순위를 다투는 경쟁사"와 "그냥 같은 업종"을 한 묶음으로 보면 목록이 잡음이 된다.
 */
export type GapBucket =
  | 'competitor-cohort'
  | 'competitor-peer'
  | 'review'
  | 'news'
  | 'forum'
  | 'blog'
  | 'social'
  | 'gov'
  | 'wiki'
  | 'other'

export const GAP_BUCKET_LABEL: Record<GapBucket, string> = {
  'competitor-cohort': '코호트 경쟁사',
  'competitor-peer': '동종 업체',
  review: '후기·예약 플랫폼',
  news: '뉴스·언론',
  forum: '포럼·커뮤니티',
  blog: '블로그',
  social: '소셜',
  gov: '공공기관',
  wiki: '위키',
  other: '기타',
}

/** 칩 표시 순서 — 실행 가치가 높은 곳부터. */
export const GAP_BUCKET_ORDER: GapBucket[] = [
  'competitor-cohort',
  'competitor-peer',
  'review',
  'news',
  'forum',
  'blog',
  'social',
  'gov',
  'wiki',
  'other',
]

export interface GapUrl {
  url: string
  citationCount: number
  engines: string[]
}

export interface GapRow {
  domain: string
  kind: CitationSourceKind
  bucket: GapBucket
  ownerType: string
  citationCount: number
  /** 전체 인용 중 비중(0~1) — 갭 인용이 아니라 이 주 전체 인용 기준. 화면 간 점유율 정의를 맞춘다. */
  share: number
  engines: string[]
  /** 이 도메인의 인용 URL(utm·해시 제거), 많이 인용된 순 상위 10개. */
  urls: GapUrl[]
  /** 전주 점유율 — 비교 가능할 때만 채운다(전주에 없던 도메인은 0). */
  previousShare?: number | null
}

export interface CitationGapSummary {
  /** 브랜드 미지원 출처, 인용수 많은 순. */
  gapDomains: GapRow[]
  /** 버킷별 갭 인용 수·비율(전체 인용 기준). 히어로의 요약 줄과 칩의 건수. */
  byBucket: { bucket: GapBucket; citationCount: number; share: number; domains: number }[]
  /** 전체 인용 중 브랜드 미지원 비율. */
  gapCitationShare: number
  gapCitations: number
  totalCitations: number
}

function bucketOf(u: Pick<CitationSourceUrlRow, 'kind' | 'ownerType' | 'cohortCompetitor'>): GapBucket {
  if (u.kind === 'competitor' || u.ownerType === 'competitor-owned') {
    return u.cohortCompetitor ? 'competitor-cohort' : 'competitor-peer'
  }
  switch (u.kind) {
    case 'review':
    case 'news':
    case 'forum':
    case 'blog':
    case 'social':
    case 'gov':
    case 'wiki':
      return u.kind
    default:
      return 'other'
  }
}

export function computeCitationGap(analysis: CitationSourceAnalysis): CitationGapSummary {
  // 브랜드 언급을 뒷받침하지 않는(=우리가 없는) URL만 남긴다. 자사 공식 출처는 갭이 아니다.
  const gapUrls = analysis.urls.filter(
    (u) => u.supportingBrandMentionCount === 0 && u.kind !== 'brand-official' && u.ownerType !== 'brand-owned',
  )
  const total = analysis.totalCitations

  type Acc = Omit<GapRow, 'urls' | 'share'> & { urlMap: Map<string, GapUrl>; cohort: boolean }
  const byDomain = new Map<string, Acc>()
  for (const u of gapUrls) {
    const acc = byDomain.get(u.domain) ?? {
      domain: u.domain,
      kind: u.kind,
      bucket: bucketOf(u),
      ownerType: u.ownerType,
      citationCount: 0,
      engines: [],
      urlMap: new Map<string, GapUrl>(),
      cohort: Boolean(u.cohortCompetitor),
    }
    acc.citationCount += u.citationCount
    acc.engines = [...new Set([...acc.engines, ...u.engines])].sort()
    // 한 도메인 안에서 코호트 경쟁사 URL이 하나라도 있으면 도메인 전체를 코호트로 본다.
    if (u.cohortCompetitor) acc.cohort = true
    const url = tidyUrl(u.raw)
    const g = acc.urlMap.get(url) ?? { url, citationCount: 0, engines: [] }
    g.citationCount += u.citationCount
    g.engines = [...new Set([...g.engines, ...u.engines])].sort()
    acc.urlMap.set(url, g)
    byDomain.set(u.domain, acc)
  }

  const gapDomains: GapRow[] = [...byDomain.values()]
    .map((acc) => {
      const bucket: GapBucket =
        acc.bucket === 'competitor-cohort' || acc.bucket === 'competitor-peer'
          ? acc.cohort
            ? 'competitor-cohort'
            : 'competitor-peer'
          : acc.bucket
      return {
        domain: acc.domain,
        kind: acc.kind,
        bucket,
        ownerType: acc.ownerType,
        citationCount: acc.citationCount,
        share: total > 0 ? acc.citationCount / total : 0,
        engines: acc.engines,
        urls: [...acc.urlMap.values()]
          .sort((a, b) => b.citationCount - a.citationCount || a.url.localeCompare(b.url))
          .slice(0, 10),
      }
    })
    .sort((a, b) => b.citationCount - a.citationCount || a.domain.localeCompare(b.domain))

  const bucketAcc = new Map<GapBucket, { citationCount: number; domains: number }>()
  for (const row of gapDomains) {
    const b = bucketAcc.get(row.bucket) ?? { citationCount: 0, domains: 0 }
    b.citationCount += row.citationCount
    b.domains += 1
    bucketAcc.set(row.bucket, b)
  }
  const byBucket = GAP_BUCKET_ORDER.filter((b) => bucketAcc.has(b)).map((bucket) => {
    const b = bucketAcc.get(bucket)!
    return { bucket, citationCount: b.citationCount, share: total > 0 ? b.citationCount / total : 0, domains: b.domains }
  })

  const gapCitations = gapUrls.reduce((s, u) => s + u.citationCount, 0)
  return {
    gapDomains,
    byBucket,
    gapCitationShare: total > 0 ? gapCitations / total : 0,
    gapCitations,
    totalCitations: total,
  }
}

/** 전주 갭에서 도메인별 점유율을 뽑아 이번 주 행에 붙인다. 비교 불가면 호출하지 않는다. */
export function attachPreviousShares(rows: GapRow[], previous: CitationGapSummary): GapRow[] {
  const prev = new Map(previous.gapDomains.map((r) => [r.domain, r.share]))
  return rows.map((r) => ({ ...r, previousShare: prev.get(r.domain) ?? 0 }))
}
