/**
 * 렌더 두 모드 비교 — 정적 HTML과 "브라우저 렌더 후 DOM"을 같은 채점기에 통과시켜 편차를 분해한다.
 *
 * 왜: 남은 편차가 banobagi·jjprs 같은 JS 중심 사이트에 몰려 있는데, 우리는 정적 수집만 한다.
 * 이 편차가 (a) 렌더를 안 해서 생긴 구조적 차이인지 (b) 순수 신호 추출 부족인지 분리해야
 * 배점을 건드릴지 추출을 고칠지 결정할 수 있다. 재현성 σ=0이므로 차이는 전부 렌더 귀속이다.
 *
 * ── 2026-09-09 실측 결론: 렌더는 원인이 아니다. 7개 기준 사이트 중 6개가 Δ=0이고,
 *    banobagi만 +2(에이전트 4→6)로 오히려 편차가 +9→+11로 벌어졌다. 전체 MAD 5.00 → 5.29.
 *    HTML은 크게 늘어나는데(banobagi 365KB→502KB) 추출 신호(단어수·H2·FAQ·JSON-LD·main)는
 *    거의 그대로였고 banobagi·gangnamunni는 단어수가 오히려 줄었다 — 늘어난 바이트는 대부분
 *    스크립트·인라인 상태이고, 채점 대상 본문·구조는 이미 정적 HTML에 다 있었다.
 *    → (1) 정적 기본값("정적 = 크롤러 동등")이 실측으로 방어된다.
 *      (2) puppeteer를 이 프로젝트에 추가할 이유가 없다(얻는 것이 0).
 *      (3) banobagi +9·jjprs +14는 aeocheck가 우리가 모델링하지 않은 무언가를 감점하는 것이다.
 *    한계: 아래 렌더러는 이미지·폰트를 차단하고 스크롤하지 않아 지연 로딩 콘텐츠는 안 잡힌다.
 *    즉 렌더 효과의 하한이다(델타가 0/음수였으므로 결론 자체는 견고).
 *    다시 돌릴 필요가 생기면 그때는 스크롤·lazy-load까지 포함해 측정할 것.
 *
 * 렌더 HTML은 이 저장소에 렌더러가 없으므로 외부에서 미리 만들어 RENDER_DIR/<host>.html로 둔다.
 * 선행 프로젝트(../aeo-checker-app)의 server/renderPage.js가 puppeteer-core로 렌더한다:
 *   node -e "import('./server/renderPage.js').then(async m => {
 *     const r = await m.renderPage('https://example.com/');
 *     require('fs').writeFileSync('<RENDER_DIR>/example.com.html', r.html);
 *   })"
 * 그 외 입력(robots·sitemap·llms·status)은 정적 수집분을 그대로 재사용해 HTML만 바꾼다.
 *
 *   RENDER_DIR=<dir> npx tsx scripts/render-compare.ts <url> ...
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><head><title></title></head><body></body></html>');
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window; g.document = dom.window.document; g.DOMParser = dom.window.DOMParser;
g.Node = dom.window.Node; g.Element = dom.window.Element; g.HTMLElement = dom.window.HTMLElement;
g.getComputedStyle = dom.window.getComputedStyle;
g.CSS = dom.window.CSS;

const { extractPage } = await import('../src/lib/aeo/extractPage.ts');
const { evaluateAeo } = await import('../src/lib/aeo/scoreAeo.ts');

const API = process.env.AEO_API ?? 'http://localhost:4000';
const RENDER_DIR = process.env.RENDER_DIR ?? '/tmp/rendered';
const CATS = ['crawler', 'content', 'eeat', 'structured', 'technical', 'agent'] as const;
const SHORT: Record<string, string> = {
  crawler: '크롤러', content: '콘텐츠', eeat: 'EEAT', structured: '구조화', technical: '기술', agent: '에이전트',
};
const BASELINE: Record<string, number> = {
  'k-wonjin.co.kr': 78, 'www.viewclinic.com': 81, 'gunsanstayhotel.com': 54,
  'www.gangnamunni.com': 79, 'maum-dream.com': 61, 'www.banobagi.com': 66, 'www.jjprs.com': 59,
};

function score(payload: Record<string, unknown>, html: string) {
  const s = extractPage({
    requestedUrl: payload.requestedUrl as string,
    finalUrl: (payload.finalUrl as string) || (payload.requestedUrl as string),
    status: payload.status as number,
    contentType: payload.contentType as string,
    redirected: payload.redirected as boolean,
    html,
    robotsTxt: payload.robotsTxt as string,
    robotsTxtStatus: payload.robotsTxtStatus as number | null,
    sitemapFound: payload.sitemapFound as boolean,
    llmsTxtFound: payload.llmsTxtFound as boolean,
    xRobotsTag: payload.xRobotsTag as string,
    fetchError: payload.fetchError as string | null,
    fetchErrorCode: payload.fetchErrorCode as string | null,
    renderMode: payload.renderMode as 'static' | 'browser',
    rendered: null,
    renderWarning: payload.renderWarning as string | null,
  });
  const r = evaluateAeo(s);
  const cats: Record<string, number | null> = {};
  for (const c of r.categories) cats[c.id] = typeof c.score === 'number' ? c.score : null;
  return { total: r.overallScore, cats, signals: s, report: r };
}

const rows: { host: string; st: number | null; rd: number | null; base?: number; cats: Record<string, [number|null, number|null]>; extra: string }[] = [];

for (const url of process.argv.slice(2)) {
  const payload = await (await fetch(`${API}/api/fetch?url=${encodeURIComponent(url)}`)).json();
  const host = new URL(payload.finalUrl || url).host;
  const file = join(RENDER_DIR, `${host}.html`);
  if (!existsSync(file)) { console.log(`  ${host}: 렌더 HTML 없음 (${file}) — 건너뜀`); continue; }
  const renderedHtml = readFileSync(file, 'utf8');

  const a = score(payload, payload.html);
  const b = score(payload, renderedHtml);
  const cats: Record<string, [number|null, number|null]> = {};
  for (const c of CATS) cats[c] = [a.cats[c], b.cats[c]];
  const sa = a.signals;
  const sb = b.signals;
  rows.push({
    host, st: a.total, rd: b.total, base: BASELINE[host], cats,
    extra: `words ${sa.wordCount}→${sb.wordCount} | h2 ${sa.h2s.length}→${sb.h2s.length} | faq ${sa.faqLike}→${sb.faqLike} | jsonLd ${sa.jsonLdTypes.length}→${sb.jsonLdTypes.length} | main ${sa.agentAccess.hasMainLandmark}→${sb.agentAccess.hasMainLandmark} | html ${(payload.html||'').length}→${renderedHtml.length}`,
  });
}

console.log('\n=== 정적 vs 렌더 총점 ===\n');
console.log('host                      정적   렌더   Δ렌더   기준선   정적편차  렌더편차');
console.log('─'.repeat(78));
for (const r of rows) {
  const d = r.st !== null && r.rd !== null ? r.rd - r.st : null;
  const f = (x: number | null | undefined) => (x === null || x === undefined ? '  -' : String(x).padStart(3));
  const sd = r.base !== undefined && r.st !== null ? r.st - r.base : null;
  const rdv = r.base !== undefined && r.rd !== null ? r.rd - r.base : null;
  const sg = (x: number | null) => (x === null ? '   -' : ((x > 0 ? '+' : '') + x).padStart(4));
  console.log(`${r.host.padEnd(24)} ${f(r.st)}   ${f(r.rd)}   ${sg(d)}   ${f(r.base)}     ${sg(sd)}     ${sg(rdv)}`);
}

console.log('\n=== 영역별 (정적 → 렌더) ===\n');
for (const r of rows) {
  const parts = CATS.map((c) => {
    const [x, y] = r.cats[c];
    const mark = x !== y ? ' ⚠' : '';
    return `${SHORT[c]} ${x ?? '-'}→${y ?? '-'}${mark}`;
  });
  console.log(`  ${r.host}\n    ${parts.join('  ')}`);
}

console.log('\n=== 신호 변화 ===\n');
for (const r of rows) console.log(`  ${r.host.padEnd(24)} ${r.extra}`);
