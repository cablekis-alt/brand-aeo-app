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

/**
 * 출처 카탈로그. 2026-09-19에 저장된 인용 15,427건의 「기타」(52.6%)를 실측해 채웠다 —
 * 상위는 예약·OTA 플랫폼(airbnb 1,002건·cozycozy·trip.com·allstay·expedia·onda), 의료 후기·정보
 * 플랫폼(성예사·바비톡·여신티켓·모두닥·굿닥·캐시닥), 카탈로그에 없던 언론(다음뉴스·이데일리·
 * ZDNet·하이닥뉴스·메디컬투데이…)이었다. 남는 「기타」의 핵심은 판정이 unknown인 동종 업체
 * 홈페이지들이다 — 그건 카탈로그로 풀 문제가 아니라 판정(업계 사이트 분류)의 몫이다.
 *
 * 원칙은 그대로다: **카탈로그에 없으면 other.** 아래 휴리스틱은 전부 구조적 규칙(TLD·접두·라벨)
 * 이고, 판정 결과("권위 있어 보인다")를 라벨로 바꾸는 폴백은 없다(classifyCitationSourceKind 주석 참고).
 */
const NEWS_HOSTS = new Set([
  // 종합·경제
  'bbc.com', 'chosun.com', 'donga.com', 'hani.co.kr', 'hankyung.com', 'imaeil.com', 'joongang.co.kr',
  'jtbc.co.kr', 'kbs.co.kr', 'khan.co.kr', 'kmib.co.kr', 'mbc.co.kr', 'mk.co.kr', 'mt.co.kr',
  'news.naver.com', 'news1.kr', 'newsis.com', 'nytimes.com', 'reuters.com', 'sbs.co.kr', 'sedaily.com',
  'theguardian.com', 'yna.co.kr', 'yonhapnews.co.kr', 'ytn.co.kr',
  'v.daum.net', 'news.daum.net', 'news.nate.com', 'edaily.co.kr', 'seoul.co.kr', 'segye.com', 'munhwa.com',
  'asiae.co.kr', 'fnnews.com', 'heraldcorp.com', 'newspim.com', 'wowtv.co.kr', 'kukinews.com',
  'nocutnews.co.kr', 'ohmynews.com', 'pressian.com', 'sisain.co.kr', 'sisajournal.com', 'viva100.com',
  'consumernews.co.kr', 'eroun.net', 'ekoreanews.co.kr', 'bntnews.co.kr', 'mediatoday.co.kr',
  // IT·산업
  'zdnet.co.kr', 'etnews.com', 'dt.co.kr', 'inews24.com', 'ddaily.co.kr', 'bloter.net', 'thebell.co.kr',
  // 의료 전문지
  'hidoc.co.kr', 'mdtoday.co.kr', 'medisobizanews.com', 'bokuennews.com', 'kormedi.com',
  'docdocdoc.co.kr', 'doctorsnews.co.kr', 'medigatenews.com', 'dailymedi.com', 'medipana.com',
  'whosaeng.com', 'akomnews.com', 'psychiatricnews.net', 'koreacarejournal.com',
  // 업계 매거진
  'sukbakmagazine.com',
]);

/** 후기·예약 플랫폼 — 이용자 후기와 예약을 겸하는 중개 사이트. OTA와 의료 후기 플랫폼을 함께 둔다. */
const REVIEW_HOSTS = new Set([
  // 숙박·여행 OTA
  'agoda.com', 'booking.com', 'goodchoice.kr', 'tripadvisor.com', 'tripadvisor.co.kr', 'yanolja.com',
  'yeogi.com', 'airbnb.co.kr', 'airbnb.com', 'cozycozy.com', 'trip.com', 'allstay.com', 'expedia.co.kr',
  'expedia.com', 'hotels.com', 'hotelscombined.co.kr', 'onda.me', 'telltrip.com', 'priviatravel.com',
  'waug.com', 'mom-mom.net', 'roomingofficial.com', 'pzip.kr', 'funvillage.kr', 'koreantrip.kr',
  'tripbtoz.com', 'yapen.co.kr', 'tourvis.com', 'triple.guide', 'myrealtrip.com', 'klook.com',
  'dailyhotel.com', 'allthatreview.com',
  // 의료 후기·병원 정보
  'gangnamunni.com', 'babitalk.com', 'yeoshin.co.kr', 'sungyesa.com', 'modoodoc.com', 'goodoc.co.kr',
  'cashdoc.me', 'my-doctor.io', 'ddocdoc.com',
]);

const FORUM_HOSTS = new Set([
  'clien.net', 'dcinside.com', 'fmkorea.com', 'instiz.net', 'quora.com', 'reddit.com', 'theqoo.net',
  'cafe.naver.com', 'cafe.daum.net', 'kin.naver.com', 'chiebukuro.yahoo.co.jp', 'ppomppu.co.kr',
  'ruliweb.com', '82cook.com', 'todayhumor.co.kr', 'bobaedream.co.kr', 'mlbpark.donga.com',
]);

const SOCIAL_HOSTS = new Set([
  'facebook.com', 'instagram.com', 'threads.net', 'tiktok.com', 'twitter.com', 'x.com', 'youtube.com',
  'band.us', 'pinterest.com', 'linkedin.com',
]);

const BLOG_HOSTS = new Set([
  'blog.naver.com', 'brunch.co.kr', 'medium.com', 'tistory.com', 'velog.io', 'wordpress.com',
  'post.naver.com', 'in.naver.com', 'blog.daum.net', 'ameblo.jp', 'note.com', 'hatenablog.com', 'blogspot.com',
]);

const WIKI_HOSTS = new Set(['namu.wiki', 'wikipedia.org']);

/**
 * 구조적 언론 휴리스틱 — 호스트 라벨 자체가 뉴스임을 말할 때만(news.·press. 접두, 첫 라벨에 news 포함).
 * 카탈로그 뒤, 블로그 판정 뒤에 둔다: 'xxxnews.tistory.com'은 블로그다.
 */
function looksLikeNewsHost(host: string): boolean {
  const labels = host.split('.');
  if (labels.length >= 3 && /^(news|press|breakingnews)$/.test(labels[0])) return true;
  const first = labels[0] ?? '';
  return /news/.test(first) && !/newsletter/.test(first);
}

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
  // 포럼을 언론보다 먼저 본다 — mlbpark.donga.com 처럼 언론사 아래 커뮤니티가 있다.
  if (hostMatches(host, FORUM_HOSTS)) return 'forum';
  if (hostMatches(host, NEWS_HOSTS)) return 'news';
  if (hostMatches(host, REVIEW_HOSTS)) return 'review';
  if (hostMatches(host, SOCIAL_HOSTS)) return 'social';
  if (hostMatches(host, BLOG_HOSTS) || host.includes('.tistory.com') || host.startsWith('blog.')) return 'blog';
  if (looksLikeNewsHost(host)) return 'news';
  return 'other';
}

/** 해시·추적 파라미터를 뗀 URL — 같은 글이 utm만 달라 다른 URL로 세지 않게. queries.ts도 쓴다. */
export function canonicalUrl(raw: string): string {
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
