/**
 * 채점 보정 하니스 — aeocheck.co.kr 점수를 기준선으로 두고 우리 채점과의 편차를 표로 출력한다.
 *
 *   npx tsx scripts/score-calibrate.ts              # 기준 URL 전부
 *   npx tsx scripts/score-calibrate.ts <url> ...     # 지정 URL만
 *
 * extractPage·scoreAeo는 브라우저 DOM을 쓰므로 jsdom으로 전역을 채운 뒤 로드한다.
 * 수집은 로컬 API(:4000)를 거친다 — 봇 차단 사이트는 한국 IP에서만 본문이 열린다.
 */
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><head><title></title></head><body></body></html>');
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.DOMParser = dom.window.DOMParser;
g.Node = dom.window.Node;
g.Element = dom.window.Element;
g.HTMLElement = dom.window.HTMLElement;
g.getComputedStyle = dom.window.getComputedStyle;

const { extractPage } = await import('../src/lib/aeo/extractPage.ts');
const { evaluateAeo } = await import('../src/lib/aeo/scoreAeo.ts');

const API = process.env.AEO_API ?? 'http://localhost:4000';

/** aeocheck.co.kr 실측 점수 — 보정 목표. */
const BASELINE: Record<string, number> = {
  'k-wonjin.co.kr': 78,
  'www.viewclinic.com': 81,
  'gunsanstayhotel.com': 54,
  'www.gangnamunni.com': 79,
  'maum-dream.com': 61,
  'www.banobagi.com': 66,
  'www.jjprs.com': 59,
};

const CATEGORY_ORDER = ['crawler', 'content', 'eeat', 'structured', 'technical', 'agent'] as const;

const SHORT: Record<string, string> = {
  crawler: '크롤러',
  content: '콘텐츠',
  eeat: 'EEAT',
  structured: '구조화',
  technical: '기술',
  agent: '에이전트',
};

interface Row {
  host: string;
  pageType: string;
  total: number | null;
  target: number | undefined;
  cats: { id: string; score: number | 'unknown'; max: number }[];
  issues: { severity: string; title: string; points?: number }[];
  signals: unknown;
}

async function scoreUrl(url: string): Promise<Row> {
  const res = await fetch(`${API}/api/fetch?url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error(`수집 실패 ${url}: HTTP ${res.status}`);
  const p = await res.json();

  const signals = extractPage({
    requestedUrl: url,
    finalUrl: p.finalUrl || url,
    status: p.status,
    contentType: p.contentType,
    redirected: p.redirected,
    html: p.html,
    robotsTxt: p.robotsTxt,
    robotsTxtStatus: p.robotsTxtStatus,
    sitemapFound: p.sitemapFound,
    llmsTxtFound: p.llmsTxtFound,
    xRobotsTag: p.xRobotsTag,
    fetchError: p.fetchError,
    fetchErrorCode: p.fetchErrorCode,
    renderMode: p.renderMode,
    rendered: p.rendered,
    renderWarning: p.renderWarning,
  });

  const report = evaluateAeo(signals);
  const host = new URL(p.finalUrl || url).host;

  return {
    host,
    pageType: report.pageType ?? signals.pageType,
    total: report.overallScore,
    target: BASELINE[host],
    cats: report.categories.map((c) => ({ id: c.id, score: c.score, max: c.maxScore })),
    signals,
    // 카테고리별 issues에 실제 감점이 담긴다(report.problems는 상위 요약만).
    issues: report.categories.flatMap((c) =>
      (c.issues ?? []).map((i) => ({
        severity: i.severity,
        title: `${SHORT[c.id] ?? c.id} · ${i.title}`,
      })),
    ),
  };
}

const urls = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      'https://k-wonjin.co.kr',
      'https://www.viewclinic.com',
      'https://gunsanstayhotel.com',
      'https://www.gangnamunni.com',
      'https://maum-dream.com',
    ];

const rows: Row[] = [];
for (const url of urls) {
  try {
    rows.push(await scoreUrl(url));
  } catch (err) {
    console.error(`[skip] ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - [...s].length));
const padL = (s: string, n: number) => ' '.repeat(Math.max(0, n - [...s].length)) + s;

console.log('');
console.log(pad('사이트', 22), pad('유형', 8), ...CATEGORY_ORDER.map((c) => padL(SHORT[c], 8)), padL('총점', 7), padL('목표', 6), padL('편차', 6));
console.log('-'.repeat(22 + 8 + 8 * 6 + 7 + 6 + 6 + 12));

for (const r of rows) {
  const cells = CATEGORY_ORDER.map((id) => {
    const c = r.cats.find((x) => x.id === id);
    if (!c) return padL('-', 8);
    return padL(c.score === 'unknown' ? `?/${c.max}` : `${Math.round(c.score)}/${c.max}`, 8);
  });
  const total = r.total === null ? '—' : String(Math.round(r.total));
  const diff = r.total !== null && r.target !== undefined ? Math.round(r.total) - r.target : null;
  console.log(
    pad(r.host, 22),
    pad(r.pageType, 8),
    ...cells,
    padL(total, 7),
    padL(r.target === undefined ? '-' : String(r.target), 6),
    padL(diff === null ? '-' : (diff > 0 ? `+${diff}` : String(diff)), 6),
  );
}

if (process.env.AEO_SIGNALS) {
  console.log('');
  for (const r of rows) {
    const s = r.signals as Record<string, unknown>;
    const keys = [
      'pageType', 'ymyl', 'wordCount', 'title', 'metaDescription', 'ogSiteName',
      'h1s', 'h2s', 'h3s', 'listCount', 'tableCount', 'jsonLdTypes', 'jsonLdDates',
      'sitemapFound', 'llmsTxtFound', 'robotsTxtStatus', 'faqLike', 'addressLike',
      'phoneOrEmail', 'authorByline', 'datePublished', 'dateModified', 'spaShell',
      'orgCandidates', 'canonical', 'imageCount', 'emptyAltCount', 'firstText',
    ];
    console.log(`── ${r.host} signals`);
    for (const k of keys) {
      if (!(k in s)) continue;
      const v = s[k];
      const shown = Array.isArray(v) ? `[${v.length}] ${JSON.stringify(v.slice(0, 6))}` : JSON.stringify(v);
      console.log(`   ${k.padEnd(16)} ${String(shown).slice(0, 160)}`);
    }
    console.log('');
  }
}

console.log('');
for (const r of rows) {
  console.log(`── ${r.host} 감점 항목 (${r.issues.length})`);
  if (!r.issues.length) console.log('   (없음 — 만점 카테고리가 많다는 신호)');
  for (const i of r.issues) {
    console.log(`   [${i.severity}]${i.points !== undefined ? ` -${i.points}` : ''} ${i.title}`);
  }
  console.log('');
}
