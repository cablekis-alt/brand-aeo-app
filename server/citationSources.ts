import type {
  CitationSourceAnalysis,
  CitationSourceKind,
  CitationSourceMixRow,
} from '../src/prompts/b7-citation-sources.js';
import type { CitationDetail, QuestionRepeatAnalysis } from './types.js';

const SOURCE_KIND_ORDER: CitationSourceKind[] = [
  'brand-official',
  'competitor',
  'news',
  'gov',
  'wiki',
  'review',
  'forum',
  'social',
  'blog',
  'other',
];

const HIGH_QUALITY = new Set<CitationSourceKind>(['brand-official', 'news', 'gov', 'wiki']);

const NEWS_HOSTS = new Set([
  'bbc.com',
  'chosun.com',
  'donga.com',
  'hani.co.kr',
  'hankyung.com',
  'imaeil.com',
  'joongang.co.kr',
  'jtbc.co.kr',
  'kbs.co.kr',
  'khan.co.kr',
  'kmib.co.kr',
  'mbc.co.kr',
  'mk.co.kr',
  'mt.co.kr',
  'news.naver.com',
  'news1.kr',
  'newsis.com',
  'nytimes.com',
  'reuters.com',
  'sbs.co.kr',
  'sedaily.com',
  'theguardian.com',
  'yna.co.kr',
  'yonhapnews.co.kr',
  'ytn.co.kr',
]);

const REVIEW_HOSTS = new Set([
  'agoda.com',
  'booking.com',
  'gangnamunni.com',
  'goodchoice.kr',
  'tripadvisor.com',
  'yanolja.com',
  'yeogi.com',
]);

const FORUM_HOSTS = new Set([
  'clien.net',
  'dcinside.com',
  'fmkorea.com',
  'instiz.net',
  'quora.com',
  'reddit.com',
  'theqoo.net',
]);

const SOCIAL_HOSTS = new Set([
  'facebook.com',
  'instagram.com',
  'threads.net',
  'tiktok.com',
  'twitter.com',
  'x.com',
  'youtube.com',
]);

const BLOG_HOSTS = new Set(['blog.naver.com', 'brunch.co.kr', 'medium.com', 'tistory.com', 'velog.io', 'wordpress.com']);

const WIKI_HOSTS = new Set(['namu.wiki', 'wikipedia.org']);

function hostOf(raw: string, fallbackDomain: string | null): string {
  if (fallbackDomain) return fallbackDomain.replace(/^www\./, '').toLowerCase();
  try {
    return new URL(raw).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return (raw.split('/')[0] ?? raw).replace(/^www\./, '').toLowerCase();
  }
}

function hostMatches(host: string, catalog: Set<string>): boolean {
  for (const entry of catalog) {
    if (host === entry || host.endsWith(`.${entry}`)) return true;
  }
  return false;
}

/**
 * 인용 출처의 종류를 정한다. **카탈로그에 없으면 other다.** 추측해서 채우지 않는다.
 *
 * 예전에는 마지막에 두 줄이 더 있었다:
 *
 *     if (citation.ownerType === 'third-party-authority') return 'news';
 *     if (citation.ownerType === 'third-party-ugc') return 'blog';
 *
 * 판정이 "권위 있어 보인다"고만 대답해도 news가 됐다. 저장된 인용 31,839건 전수 확인 결과
 * **9,888건(31.1%)** 이 이 폴백에서 온 라벨이었다(news→other 6,751 · blog→other 3,137).
 * 성형외과 홈페이지가 언론사로 둔갑했고, k-wonjin 2026-W37의 news 라벨 153개 도메인 중
 * 카탈로그가 아는 진짜 언론사는 13개뿐이었다.
 *
 * 그래서 '고품질 출처 비율'은 실제 출처 품질이 아니라 **판정이 권위 있다고 답한 비율**을
 * 재고 있었다. 전체 평균 31.3% → 12.3%. 반도체·B2B 테넌트는 더 심해서 photomask는
 * 92.2% → 11.3%였다 — 거의 전부가 폴백 라벨이었다.
 *
 * 점수는 움직이지 않는다. qualityRate는 화면·B8 리포트 문구 전용이고 EEAT는 설계상
 * 점수에 넣지 않는다(scoring.ts 참고). 바뀌는 것은 진단 지표뿐이다:
 *   고품질 출처 비율   평균 31.3% → 12.3%
 *   EEAT A(권위) 필러  보통 −1점, photomask는 40.2 → 20.1
 *   EEAT E(경험) 필러  −0.3~−1.2점
 *
 * 수치가 내려가는 건 나빠진 게 아니라 부풀어 있던 값이 제자리로 온 것이다. 과거 주차도
 * 같은 코드로 다시 계산되므로 추세 비교는 그대로 성립한다.
 *
 * 분류를 넓히려면 폴백을 되살리지 말고 위 호스트 카탈로그에 도메인을 추가한다.
 */
export function classifyCitationSourceKind(citation: Pick<CitationDetail, 'raw' | 'domain' | 'ownerType'>): CitationSourceKind {
  if (citation.ownerType === 'brand-owned') return 'brand-official';
  if (citation.ownerType === 'competitor-owned') return 'competitor';

  const host = hostOf(citation.raw, citation.domain);
  if (host.endsWith('.go.kr') || host.endsWith('.gov') || host === 'korea.kr') return 'gov';
  if (hostMatches(host, WIKI_HOSTS)) return 'wiki';
  if (hostMatches(host, NEWS_HOSTS)) return 'news';
  if (hostMatches(host, REVIEW_HOSTS)) return 'review';
  if (hostMatches(host, FORUM_HOSTS)) return 'forum';
  if (hostMatches(host, SOCIAL_HOSTS)) return 'social';
  if (hostMatches(host, BLOG_HOSTS) || host.includes('.tistory.com') || host.startsWith('blog.')) return 'blog';
  return 'other';
}

function canonicalUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|si$)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return raw;
  }
}

function toMix(counts: Map<CitationSourceKind, number>, total: number): CitationSourceMixRow[] {
  return SOURCE_KIND_ORDER.filter((kind) => (counts.get(kind) ?? 0) > 0).map((kind) => ({
    kind,
    count: counts.get(kind) ?? 0,
    share: total > 0 ? (counts.get(kind) ?? 0) / total : 0,
  }));
}

/** B7 — 한 주차 인용을 출처 유형·엔진·URL 단위로 집계한다. */
export function analyzeCitationSources(analyses: QuestionRepeatAnalysis[]): CitationSourceAnalysis {
  const mixCounts = new Map<CitationSourceKind, number>();
  const engineCounts = new Map<string, Map<CitationSourceKind, number>>();
  const engineTotals = new Map<string, number>();
  const urlRows = new Map<
    string,
    {
      raw: string;
      domain: string;
      kind: CitationSourceKind;
      ownerType: string;
      citationCount: number;
      engines: Set<string>;
      supportingBrandMentionCount: number;
    }
  >();
  const domainEngines = new Map<string, { kind: CitationSourceKind; engines: Set<string>; citationCount: number }>();

  let totalCitations = 0;
  let highQuality = 0;

  for (const analysis of analyses) {
    for (const citation of analysis.citations) {
      const kind = classifyCitationSourceKind(citation);
      const domain = hostOf(citation.raw, citation.domain) || citation.raw;
      const key = canonicalUrl(citation.raw);

      totalCitations += 1;
      if (HIGH_QUALITY.has(kind)) highQuality += 1;
      mixCounts.set(kind, (mixCounts.get(kind) ?? 0) + 1);

      const perEngine = engineCounts.get(analysis.engine) ?? new Map<CitationSourceKind, number>();
      perEngine.set(kind, (perEngine.get(kind) ?? 0) + 1);
      engineCounts.set(analysis.engine, perEngine);
      engineTotals.set(analysis.engine, (engineTotals.get(analysis.engine) ?? 0) + 1);

      const urlRow = urlRows.get(key) ?? {
        raw: citation.raw,
        domain,
        kind,
        ownerType: citation.ownerType,
        citationCount: 0,
        engines: new Set<string>(),
        supportingBrandMentionCount: 0,
      };
      urlRow.citationCount += 1;
      urlRow.engines.add(analysis.engine);
      if (citation.supportsBrandMention) urlRow.supportingBrandMentionCount += 1;
      urlRows.set(key, urlRow);

      const domainRow = domainEngines.get(domain) ?? { kind, engines: new Set<string>(), citationCount: 0 };
      domainRow.engines.add(analysis.engine);
      domainRow.citationCount += 1;
      domainEngines.set(domain, domainRow);
    }
  }

  const urls = [...urlRows.values()]
    .map((row) => ({
      raw: row.raw,
      domain: row.domain,
      kind: row.kind,
      ownerType: row.ownerType,
      citationCount: row.citationCount,
      engines: [...row.engines],
      supportingBrandMentionCount: row.supportingBrandMentionCount,
    }))
    .sort((a, b) => b.citationCount - a.citationCount);

  return {
    totalCitations,
    uniqueUrls: urls.length,
    uniqueDomains: domainEngines.size,
    qualityRate: totalCitations > 0 ? highQuality / totalCitations : 0,
    mix: toMix(mixCounts, totalCitations),
    byEngine: [...engineCounts.entries()].map(([engine, counts]) => {
      const total = engineTotals.get(engine) ?? 0;
      return { engine, total, mix: toMix(counts, total) };
    }),
    urls,
    consensusDomains: [...domainEngines.entries()]
      .filter(([, row]) => row.engines.size >= 2)
      .map(([domain, row]) => ({
        domain,
        kind: row.kind,
        engineCount: row.engines.size,
        citationCount: row.citationCount,
      }))
      .sort((a, b) => b.engineCount - a.engineCount || b.citationCount - a.citationCount),
  };
}
