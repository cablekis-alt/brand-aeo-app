import { assertPublicUrl, CollectorError, publicCollectorError } from './networkSafety.js';

// 정적 수집만 수행한다. aeo-checker-app은 SPA 셸을 puppeteer로 렌더하지만,
// 여기서는 무거운 브라우저 의존성을 추가하지 않고, SPA로 의심되면 renderWarning으로 알린다.
// 채점 엔진(scoreAeo)은 renderMode 'static'을 정상적으로 처리한다.

export interface FetchPayload {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string;
  redirected: boolean;
  html: string;
  xRobotsTag: string;
  robotsTxt: string;
  robotsTxtStatus: number | null;
  sitemapFound: boolean;
  llmsTxtFound: boolean;
  renderMode: 'static' | 'browser';
  rendered: null;
  renderWarning: string | null;
  fetchError: string | null;
  fetchErrorCode: string | null;
}

const MAX_BODY = 1_500_000;
const TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 5;
const UA =
  'BrandAEO-SiteChecker/1.0 (+page quality diagnostic) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36';

interface FetchResult {
  status: number;
  finalUrl: string;
  contentType: string;
  xRobots: string;
  body: string;
}

async function readLimited(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_BODY) {
      await reader.cancel();
      throw new CollectorError('BODY_TOO_LARGE', '페이지 크기가 분석 한도를 초과했습니다.');
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged);
}

async function fetchOnce(url: string, method: 'GET' | 'HEAD' = 'GET'): Promise<FetchResult> {
  let current = (await assertPublicUrl(url)).href;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(current, {
        method,
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,text/plain,*;q=0.8' },
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get('location');
        if (!location) throw new CollectorError('INVALID_REDIRECT', '리디렉션 위치를 확인할 수 없습니다.');
        current = (await assertPublicUrl(new URL(location, current).href)).href;
        continue;
      }
      const contentType = res.headers.get('content-type') ?? '';
      const xRobots = res.headers.get('x-robots-tag') ?? '';
      const body = method === 'HEAD' ? '' : await readLimited(res);
      return { status: res.status, finalUrl: current, contentType, xRobots, body };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new CollectorError('TOO_MANY_REDIRECTS', '리디렉션이 너무 많아 수집을 중단했습니다.');
}

function stripStaticText(html: string): string {
  return html
    .replace(/<(script|style|noscript|nav|footer)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z0-9#]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeSpaShell(html: string): boolean {
  const words = stripStaticText(html).split(/\s+/).filter(Boolean).length;
  const scripts = (html.match(/<script\b/gi) ?? []).length;
  const appShell = /id=["'](?:root|app|__next|nuxt)["']/i.test(html);
  return words < 100 && scripts >= 1 && appShell;
}

async function probe(origin: string, path: string): Promise<{ status: number; body: string; found: boolean }> {
  try {
    const result = await fetchOnce(new URL(path, origin).href, 'GET');
    return { status: result.status, body: result.status === 200 ? result.body : '', found: result.status === 200 };
  } catch {
    return { status: 0, body: '', found: false };
  }
}

function originOf(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

export async function collectPage(target: string): Promise<FetchPayload> {
  try {
    const page = await fetchOnce(target, 'GET');
    const html = page.body;
    const finalUrl = page.finalUrl;
    const status = page.status;
    const renderWarning =
      status >= 200 && status < 400 && looksLikeSpaShell(html)
        ? '동적 렌더링이 필요한 페이지로 보이지만 정적 HTML만 평가했습니다. 핵심 본문은 서버 HTML로 출력하는 것을 권장합니다.'
        : null;

    const origin = originOf(finalUrl || target);
    const [robots, sitemap, llms] = await Promise.all([
      probe(origin, '/robots.txt'),
      probe(origin, '/sitemap.xml'),
      probe(origin, '/llms.txt'),
    ]);
    return {
      requestedUrl: target,
      finalUrl,
      status,
      contentType: page.contentType,
      redirected: finalUrl.replace(/\/$/, '') !== target.replace(/\/$/, ''),
      html,
      xRobotsTag: page.xRobots,
      robotsTxt: robots.body,
      robotsTxtStatus: robots.status || null,
      sitemapFound: sitemap.found,
      llmsTxtFound: llms.found,
      renderMode: 'static',
      rendered: null,
      renderWarning,
      fetchError: null,
      fetchErrorCode: null,
    };
  } catch (error) {
    const safe = publicCollectorError(error);
    return {
      requestedUrl: target,
      finalUrl: target,
      status: 0,
      contentType: '',
      redirected: false,
      html: '',
      xRobotsTag: '',
      robotsTxt: '',
      robotsTxtStatus: null,
      sitemapFound: false,
      llmsTxtFound: false,
      renderMode: 'static',
      rendered: null,
      renderWarning: null,
      fetchError: safe.message,
      fetchErrorCode: safe.code,
    };
  }
}
