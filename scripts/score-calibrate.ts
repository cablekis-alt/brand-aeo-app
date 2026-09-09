/**
 * 채점 보정 하니스 — aeocheck.co.kr 점수를 기준선으로 두고 우리 채점과의 편차를 표로 출력한다.
 *
 *   npx tsx scripts/score-calibrate.ts              # 기준 URL 전부
 *   npx tsx scripts/score-calibrate.ts <url> ...     # 지정 URL만
 *
 * extractPage·scoreAeo는 브라우저 DOM을 쓰므로 jsdom으로 전역을 채운 뒤 로드한다.
 * 수집은 로컬 API(:4000)를 거친다 — 봇 차단 사이트는 한국 IP에서만 본문이 열린다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⛔ 2026-09-09: aeocheck 대비 배점 튜닝을 **종료**했다. 이 하니스의 역할은
 *    "튜닝 목표"에서 **회귀 감지기**로 바뀐다.
 *
 * 종료 근거 — 이 문제는 원리적으로 식별 불가(underdetermined)다.
 *   aeocheck는 **총점만** 노출한다(사용자 확인). 즉 사이트당 스칼라 1개로 6개 영역 배점과
 *   수십 개 감점 크기를 맞추는 셈이다(기준선 7개 → 제약 7개, 미지수는 그보다 훨씬 많다).
 *   반대 방향 오차가 총점에서 상쇄되므로, 총점을 더 맞출수록 영역별 정확도는 오히려 나빠질 수 있다.
 *
 * 남은 편차의 원인 후보를 모두 실측으로 배제했다.
 *   - 측정 노이즈 : scripts/score-repeatability.ts → σ=0.00 (완전 결정적). 편차는 실재한다.
 *   - 콘텐츠 오탐 : 서두 판정이 내비·팝업을 읽던 결함 → 수정 완료(c00080e).
 *   - 렌더 차이   : scripts/render-compare.ts → 6/7 사이트 Δ=0, 전체 MAD 5.00→5.29(악화).
 *                   정적 수집이 원인이 아니며 puppeteer를 추가할 이유도 없다.
 *   결론: banobagi +9 · jjprs +14는 aeocheck가 우리가 모델링하지 않은 무언가를 감점하는 것이고,
 *   무엇인지 알 방법이 없다. 여기서 더 조이는 것은 커브 피팅이다.
 *
 * 도달한 상태(천장으로 인정)
 *   전체 7개 MAD 5.00 (시작 6.57) · hold-out 2개 11.50 (시작 17.00)
 *   k-wonjin -2 · viewclinic -2 · gunsan +3 · gangnamunni -3 · maum-dream -2 · banobagi +9 · jjprs +14
 *
 * 앞으로의 사용법
 *   1) 채점 로직을 건드린 뒤 이 하니스를 돌려 **MAD가 5.00보다 나빠지지 않는지** 확인한다(회귀 감시).
 *   2) 총점 편차를 줄이려고 배점(CATEGORY_DEFS max, 감점 points)을 만지지 않는다.
 *   3) 대신 **신호 추출·판정 결함**은 계속 고친다 — 그건 총점과 무관하게 옳은 일이고,
 *      실제로 그 방식(오탐 수정·에이전트 신호 추가)으로만 MAD가 6.57→5.00으로 내려왔다.
 *   4) 재개 조건: aeocheck가 영역별 점수를 노출하게 되거나(제약 7→42), 또는 aeocheck를 버리고
 *      Brand AEO 실측(brandOwnedCitationRate 등)과의 상관을 새 검증 목표로 삼을 때.
 * ─────────────────────────────────────────────────────────────────────────────
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

// 기본 실행 = 기준선이 있는 사이트 **전체**. 목록을 하드코딩하면 BASELINE에 기준선을 추가해도
// 실행에서 빠져 편차가 드러나지 않는다 — 실제로 banobagi·jjprs가 누락된 채 'MAD 2.4'를 보고
// 있었고, 두 사이트는 각각 +12·+22였다(과적합이 가려졌다).
const urls =
  process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : Object.keys(BASELINE).map((host) => `https://${host}/`);

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
