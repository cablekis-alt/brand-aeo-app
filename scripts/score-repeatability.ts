/**
 * 채점 재현성(σ) 측정 — 같은 URL을 N회 채점해 총점·영역별 변동을 본다.
 *
 *   npx tsx scripts/score-repeatability.ts                 # 기준 URL 전부, 3회
 *   RUNS=5 GAP_MS=30000 npx tsx scripts/score-repeatability.ts
 *   npx tsx scripts/score-repeatability.ts <url> ...
 *
 * 목적: aeocheck 대비 잔여 편차(예: gunsan +5)가 우리 자신의 노이즈 바닥 안인지 판단한다.
 * σ가 잔여 편차와 비슷하면 더 이상의 배점 튜닝은 노이즈를 쫓는 것이다.
 *
 * 주의: 짧은 간격의 반복은 CDN A/B·캐시 회전을 덜 타므로 σ의 **하한**이다.
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
const RUNS = Number(process.env.RUNS ?? 3);
const GAP_MS = Number(process.env.GAP_MS ?? 10000);

// score-calibrate.ts의 기준 URL과 동일 집합 (aeocheck 기준선이 있는 사이트)
const DEFAULT_URLS = [
  'https://k-wonjin.co.kr/',
  'https://www.viewclinic.com/',
  'https://gunsanstayhotel.com/',
  'https://www.gangnamunni.com/',
  'https://maum-dream.com/',
  'https://www.banobagi.com/',
  'https://www.jjprs.com/',
];
const BASELINE: Record<string, number> = {
  'k-wonjin.co.kr': 78,
  'www.viewclinic.com': 81,
  'gunsanstayhotel.com': 54,
  'www.gangnamunni.com': 79,
  'maum-dream.com': 61,
  'www.banobagi.com': 66,
  'www.jjprs.com': 59,
};

const CATS = ['crawler', 'content', 'eeat', 'structured', 'technical', 'agent'] as const;
const SHORT: Record<string, string> = {
  crawler: '크롤러', content: '콘텐츠', eeat: 'EEAT',
  structured: '구조화', technical: '기술', agent: '에이전트',
};

interface Obs {
  total: number | null;
  cats: Record<string, number | 'unknown'>;
  status: number | null;
  htmlLen: number;
  renderMode: string;
  finalUrl: string;
  robots: string;
  sitemap: boolean;
  llms: boolean;
  err?: string;
}

async function observe(url: string): Promise<Obs> {
  const res = await fetch(`${API}/api/fetch?url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error(`수집 실패 HTTP ${res.status}`);
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
  const cats: Record<string, number | 'unknown'> = {};
  for (const c of report.categories) cats[c.id] = c.score;
  return {
    total: report.overallScore,
    cats,
    status: p.status ?? null,
    htmlLen: (p.html || '').length,
    renderMode: p.renderMode ?? '?',
    finalUrl: p.finalUrl || url,
    robots: String(p.robotsTxtStatus ?? '?'),
    sitemap: Boolean(p.sitemapFound),
    llms: Boolean(p.llmsTxtFound),
    err: p.fetchError || undefined,
  };
}

const stdev = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length);
};

const urls = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_URLS;
const all = new Map<string, Obs[]>();

for (let run = 1; run <= RUNS; run += 1) {
  process.stdout.write(`\n── run ${run}/${RUNS} ──\n`);
  for (const url of urls) {
    try {
      const o = await observe(url);
      const host = new URL(o.finalUrl).host;
      (all.get(host) ?? all.set(host, []).get(host)!).push(o);
      console.log(`  ${host.padEnd(24)} total=${String(o.total).padStart(4)} html=${o.htmlLen} mode=${o.renderMode}`);
    } catch (e) {
      console.log(`  ${url.padEnd(24)} ✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (run < RUNS) await new Promise((r) => setTimeout(r, GAP_MS));
}

console.log(`\n\n=== 재현성 요약 (${RUNS}회, 간격 ${GAP_MS / 1000}s) ===\n`);
console.log('host                     n  총점(회차별)        범위  σ     aeocheck  편차');
console.log('─'.repeat(84));
const sigmas: number[] = [];
for (const [host, obs] of all) {
  const totals = obs.map((o) => o.total).filter((t): t is number => typeof t === 'number');
  const nulls = obs.length - totals.length;
  if (totals.length === 0) { console.log(`${host.padEnd(24)} ${obs.length}  전부 확인 불가(null)`); continue; }
  const range = Math.max(...totals) - Math.min(...totals);
  const sd = stdev(totals);
  sigmas.push(sd);
  const base = BASELINE[host];
  const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
  const dev = base !== undefined ? (mean - base >= 0 ? '+' : '') + (mean - base).toFixed(1) : '-';
  console.log(
    `${host.padEnd(24)} ${obs.length}  ${totals.join(', ').padEnd(18)} ${String(range).padStart(4)}  ${sd.toFixed(2).padStart(5)} ${String(base ?? '-').padStart(8)}  ${dev.padStart(5)}${nulls ? `  (null ${nulls}회)` : ''}`,
  );
}

console.log('\n=== 영역별 변동 (값이 2개 이상이면 불안정) ===\n');
for (const [host, obs] of all) {
  const unstable: string[] = [];
  for (const c of CATS) {
    const vals = [...new Set(obs.map((o) => String(o.cats[c] ?? 'n/a')))];
    if (vals.length > 1) unstable.push(`${SHORT[c]}=${vals.join('/')}`);
  }
  console.log(`  ${host.padEnd(24)} ${unstable.length ? '⚠ ' + unstable.join('  ') : '동일 ✓'}`);
}

console.log('\n=== 수집 단계 변동 (점수 변동의 원인 후보) ===\n');
for (const [host, obs] of all) {
  const f = (get: (o: Obs) => unknown) => [...new Set(obs.map((o) => String(get(o))))];
  const bits: string[] = [];
  const hl = obs.map((o) => o.htmlLen);
  if (new Set(hl).size > 1) bits.push(`html길이 ${Math.min(...hl)}~${Math.max(...hl)} (Δ${Math.max(...hl) - Math.min(...hl)})`);
  for (const [label, get] of [
    ['status', (o: Obs) => o.status], ['renderMode', (o: Obs) => o.renderMode],
    ['finalUrl', (o: Obs) => o.finalUrl], ['robots', (o: Obs) => o.robots],
    ['sitemap', (o: Obs) => o.sitemap], ['llms.txt', (o: Obs) => o.llms],
  ] as const) {
    const v = f(get);
    if (v.length > 1) bits.push(`${label}: ${v.join('/')}`);
  }
  console.log(`  ${host.padEnd(24)} ${bits.length ? '⚠ ' + bits.join(' | ') : '동일 ✓'}`);
}

const maxSigma = sigmas.length ? Math.max(...sigmas) : 0;
console.log(`\n=== 판정 ===`);
console.log(`  관측된 최대 σ = ${maxSigma.toFixed(2)}점`);
console.log(`  잔여 편차(gunsan +5 / maum-dream +4)와 비교:`);
console.log(
  maxSigma >= 3
    ? `  ⚠ 노이즈가 큼 — 잔여 편차가 σ 안에 들어갑니다. 추가 배점 튜닝은 노이즈 추적입니다.`
    : maxSigma > 0
      ? `  △ σ=${maxSigma.toFixed(2)} — 편차(4~5)보다 작습니다. 편차는 실재하나, 이 σ만큼은 측정 흔들림입니다.`
      : `  ✓ σ=0 — 짧은 간격 반복은 완전 결정적. 편차는 실재하며 튜닝 대상입니다(단 σ 하한임에 주의).`,
);
