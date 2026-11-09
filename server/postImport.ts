import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { readFile, stat } from 'node:fs/promises';
import http, { type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { brandLabel } from '../src/lib/brandVariant.js';
import type { ExtraArticle } from '../src/lib/extraArticles.js';
import { assignedArticle } from '../src/lib/contentLibraryOrder.js';
import { draftTitle } from '../src/lib/markdownFile.js';
import { effectiveDraft } from '../src/lib/draftGaps.js';
import {
  BLOG_SOURCES_MAX,
  CANDIDATE_LIMIT,
  MIN_BODY_GRAMS,
  NEW_URLS_MAX,
  POST_PLATFORM_LABEL,
  bigrams,
  blogListTargets,
  draftMatchText,
  jaccard,
  listedPostUrls,
  newestFirst,
  normalizeBlogSource,
  otherListHosts,
  parseCommitItems,
  parseFeedLinks,
  parsePostHtml,
  parseSitemap,
  parseWpPostList,
  postPlatformOf,
  readTargetOf,
  sameBlogPostUrl,
  siteHostOf,
  urlVerdict,
  withoutTrailingText,
  wpListPageUrl,
  type BlogListResult,
  type BlogSource,
  type CommitItem,
  type CommitResult,
  type ImportCandidate,
  type KnownRecord,
  type PostImportRead,
} from '../src/lib/postImport.js';
import { importRecordInput, normalizeDay, postedDayProblem, writerUnknownOf } from '../src/lib/postRegistration.js';
import { writerArticle, type WriterPlan } from '../src/lib/probePlan.js';
import { ARTICLE_URL_REASON, isArticleUrl, todayKst, trackingKey } from '../src/lib/publishedUrl.js';
import type { QuestionBank } from '../src/lib/types.js';
import type { StoredDraft } from '../src/lib/api.js';
import { decodeBody } from './aeo/collectPage.js';
import { isPrivateIp, publicCollectorError } from './aeo/networkSafety.js';
import { PIPELINE_DATA_DIR, stateFilePath } from './appPaths.js';
import { readExtraArticles } from './extraArticles.js';
import { PROBE_PLAN_FILE, readProbePlan } from './probePlanStore.js';
import { addPublishedPost, readPublishedPosts } from './publishedPosts.js';
import { writeJsonAtomic } from './tenantWriteQueue.js';
import type { TenantConfig } from './types.js';

/**
 * 주소 한꺼번에 등록 — 발행 현황(src/pages/PublishStatus.tsx · src/components/PostImportPanel.tsx)이 부른다. 규칙은 src/lib/postImport.ts
 * (읽기 · 짝짓기 · 상태)와 src/lib/postRegistration.ts(기록 모양 — CLI와 같다)에 있고, 여기는 바깥 페이지 읽기 · 데이터 파일 · 원장 쓰기다.
 *
 *   읽기  POST /api/post-import/read { url } — 글 페이지를 읽어 제목 · 올린 날 · 본문을 뽑고, 고객 브랜드(경쟁사 빼고) 모든 초안과 맞춰
 *         후보 셋과 그 주소가 원장에 적힌 기록을 돌려준다. 페이지 HTML · 본문은 돌려주지 않는다.
 *   목록  POST /api/post-import/list { source } — 저장한 블로그의 글 목록(RSS · 사이트맵 · 워드프레스 공개 API)에서 아직 고객 브랜드 원장에
 *         살아 있지 않은 글 주소.
 *   등록  POST /api/post-import/commit { items } — 줄마다 다시 검사하고(고객 브랜드 · 그 브랜드의 초안 · 글 주소 · 다른 글의 주소 아님 ·
 *         올린 날 ≤ 오늘) 그 브랜드의 쓰기 줄에서 addPublishedPost(「올렸어요」와 같은 길)로 적는다. 한 줄이 걸려도 나머지는 적는다.
 *   저장한 블로그  GET/PUT /api/blog-sources — 앱 전체에 한 목록(stateFilePath('blog-sources.json'), 아래 주석).
 *
 * ── 바깥 페이지 읽기 ───────────────────────────────────────────────────────
 * http(s)만 · 80/443만 · 계정 정보 없는 주소만 · 15초 · 3MB(압축을 푼 뒤) · 리디렉션 3번(넘길 때마다 같은 검사) · 한 번에 3개 · 같은
 * 사이트에는 0.25초 간격. 내부 주소(루프백 · 사설 · 링크 로컬 · 메타데이터 · CGNAT · IPv6 사설/문서/6to4)는 DNS로 푼 뒤 연결하는 그 주소로
 * 막는다 — 연결 함수의 lookup에서 검사하므로 검사한 주소와 연결하는 주소가 다를 수 없다(DNS 재바인딩). 받은 HTML은 글자로만 다룬다(실행 ·
 * 그리기 없음).
 * POST_IMPORT_TEST_LOOPBACK=1은 검증 스크립트(scripts/verify-post-import.ts)만 켠다 — 그때만 루프백(127.0.0.0/8 · ::1)과 그 포트를 연다.
 * 설치본 서버 묶음(scripts/build-electron-server.mjs)은 이 이름을 define으로 지운다 — userData/.env나 환경변수로 켤 수 없다.
 * 받은 HTML은 src/lib/postImport.ts가 페이지 크기에 비례하는 시간으로만 읽는다(망가진 페이지 하나가 서버를 멈추지 않게).
 *
 * ── 적을 주소 ───────────────────────────────────────────────────────────────
 * 같은 글이 여러 모양의 주소로 온다(워드프레스 ?p=번호 · wp.me 단축 · 티스토리 /entry/). 읽기는 리디렉션 뒤 주소와 페이지가 밝힌 정식
 * 주소(같은 블로그의 글일 때)를 적을 주소(recordUrl)로 돌려주고, 원장 대조는 붙여 넣은 주소 · 읽은 주소 · 적을 주소 모두로 한다 — 이미
 * 등록한 글을 다른 모양으로 붙여 넣어도 「이미 등록됨」. 화면은 적을 주소로 등록한다.
 *
 * ── 저장한 블로그는 앱에 한 목록 ────────────────────────────────────────────
 * 한 작성자 블로그에 두 브랜드의 글이 함께 오른다(11-09 실측 — 네이버 · 워드프레스 블로그 하나에 스테이,머뭄과 군산각 글). 브랜드마다
 * 저장하면 같은 블로그를 두 번 읽고 「새 글」이 브랜드마다 갈라진다. 짝짓기는 어차피 모든 고객 브랜드의 초안과 하므로 목록은 하나다.
 * 파일은 data/ 밖의 상태 파일 자리다 — data/ 아래 항목은 측정 저장소가 브랜드 폴더로 훑는다(server/store.ts scorecardIndex).
 *
 * 웹(Vercel)에는 라우트가 없다(함수 12/12). 화면은 404를 「데스크톱 앱에서만」으로 읽는다.
 */

/** 라우트가 그대로 상태 코드로 쓰는 오류. */
export class PostImportError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** 바깥 페이지를 읽지 못한 까닭. code는 검증이 본다. */
export class PostFetchError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PostFetchError';
    this.code = code;
  }
}

const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const FETCH_CONCURRENCY = 3;
/** 워드프레스 공개 API는 쪽마다 100편 — 500편까지 본다. */
const WP_MAX_PAGES = 5;
/** 사이트맵 묶음(sitemapindex)에서 따라가는 하위 사이트맵 수. */
const SITEMAP_CHILDREN_MAX = 5;
/** 같은 사이트에 잇달아 거는 요청의 간격 — 네이버는 몰아서 50번쯤 읽으면 429로 막았다(11-09 실측). */
const HOST_GAP_MS = 250;
const UA = 'BrandAEO-PostImport/1.0 (+post registration) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36';
const PRIVATE_MESSAGE = '내부 네트워크 주소(루프백 · 사설 · 링크 로컬)는 읽지 않습니다.';

const loopbackAllowed = () => process.env.POST_IMPORT_TEST_LOOPBACK === '1';

/** IPv6 주소를 16비트 8칸으로. 틀린 모양이면 null. 끝에 IPv4가 붙은 모양(::ffff:1.2.3.4)도 받는다. */
function ipv6Hextets(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0]!;
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const b = v4.slice(1, 5).map(Number);
    if (b.some((x) => x > 255)) return null;
    s = `${s.slice(0, v4.index)}${((b[0]! << 8) | b[1]!).toString(16)}:${((b[2]! << 8) | b[3]!).toString(16)}`;
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const fill = parts.length === 2 ? 8 - head.length - tail.length : 0;
  const all = [...head, ...Array<string>(Math.max(fill, 0)).fill('0'), ...tail];
  if (fill < 0 || all.length !== 8 || all.some((h) => !/^[0-9a-f]{1,4}$/.test(h))) return null;
  return all.map((h) => Number.parseInt(h, 16));
}

/** IPv4 대응 IPv6(::ffff:a.b.c.d)면 그 IPv4. */
function mappedV4(h: number[]): string | null {
  return h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff ? `${h[6]! >> 8}.${h[6]! & 255}.${h[7]! >> 8}.${h[7]! & 255}` : null;
}

function isLoopback(ip: string): boolean {
  if (isIP(ip) === 4) return ip.startsWith('127.');
  const h = ipv6Hextets(ip);
  if (!h) return false;
  const v4 = mappedV4(h);
  if (v4) return v4.startsWith('127.');
  return h.slice(0, 7).every((x) => x === 0) && h[7] === 1;
}

/**
 * 연결하면 안 되는 주소인가 — IPv4는 사설 · 루프백 · 링크 로컬(169.254 — 클라우드 메타데이터) · CGNAT · 멀티캐스트 등(server/aeo/
 * networkSafety.ts isPrivateIp), IPv6는 공개 유니캐스트(2000::/3)만 받고 그 안의 문서(2001:db8::/32) · Teredo(2001::/32) · 6to4(2002::/16)도
 * 막는다. IPv4 대응 주소는 IPv4 규칙으로. 시험 깃발이면 루프백만 연다.
 */
export function addressBlocked(ip: string): boolean {
  const raw = ip.trim().replace(/^\[|\]$/g, '');
  if (loopbackAllowed() && isLoopback(raw)) return false;
  const family = isIP(raw);
  if (family === 4) return isPrivateIp(raw);
  if (family !== 6) return true;
  const h = ipv6Hextets(raw);
  if (!h) return true;
  const v4 = mappedV4(h);
  if (v4) return isPrivateIp(v4);
  if (h[0]! < 0x2000 || h[0]! > 0x3fff) return true;
  if (h[0] === 0x2002) return true;
  return h[0] === 0x2001 && (h[1] === 0x0db8 || h[1] === 0);
}

/** 연결 함수의 이름 풀기 — 풀린 주소 가운데 하나라도 막을 주소면 연결하지 않는다. */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { family: options.family, hints: options.hints, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) {
      callback(err, '');
      return;
    }
    if (addresses.length === 0 || addresses.some((a) => addressBlocked(a.address))) {
      callback(new PostFetchError('PRIVATE_ADDRESS', PRIVATE_MESSAGE), '');
      return;
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};

/** 읽어도 되는 주소인가 — 모양 · 포트 · 주소 자리에 적힌 IP. 이름은 연결할 때 guardedLookup이 본다. */
function checkTarget(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new PostFetchError('INVALID_URL', `주소로 읽히지 않습니다: ${raw.slice(0, 120)}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new PostFetchError('INVALID_PROTOCOL', 'http(s) 주소만 읽습니다.');
  if (u.username || u.password) throw new PostFetchError('CREDENTIALS', '계정 정보가 든 주소는 읽지 않습니다.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const loopbackHost = host === 'localhost' || (isIP(host) !== 0 && isLoopback(host));
  if (u.port && u.port !== '80' && u.port !== '443' && !(loopbackAllowed() && loopbackHost)) {
    throw new PostFetchError('BLOCKED_PORT', '80 · 443 포트의 주소만 읽습니다.');
  }
  if (isIP(host) !== 0 && addressBlocked(host)) throw new PostFetchError('PRIVATE_ADDRESS', PRIVATE_MESSAGE);
  return u;
}

// 바깥 요청은 한 번에 FETCH_CONCURRENCY개 — 화면이 여러 주소를 함께 걸어도 블로그에 몰리지 않게.
let activeFetches = 0;
const waitingFetches: (() => void)[] = [];
async function acquireFetch(): Promise<void> {
  if (activeFetches < FETCH_CONCURRENCY) {
    activeFetches += 1;
    return;
  }
  await new Promise<void>((resolve) => waitingFetches.push(resolve));
}
function releaseFetch(): void {
  const next = waitingFetches.shift();
  if (next) next();
  else activeFetches -= 1;
}

/** 같은 호스트에는 HOST_GAP_MS 간격으로 건다 — 다음 차례 시각을 잡아 두고 그때까지 기다린다. */
const hostNextAt = new Map<string, number>();
async function paceHost(host: string): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, hostNextAt.get(host) ?? 0);
  hostNextAt.set(host, at + HOST_GAP_MS);
  if (at > now) await sleep(at - now);
}

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

const tooLarge = () => new PostFetchError('BODY_TOO_LARGE', `페이지 크기가 ${MAX_BYTES / 1024 / 1024}MB를 넘어 읽지 않았습니다.`);

/** 요청 한 번 — 리디렉션은 따라가지 않고 그대로 돌려준다. 압축(gzip · deflate · br)을 풀며 크기를 센다. */
function requestOnce(u: URL, accept: string, signal: AbortSignal): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      u,
      {
        method: 'GET',
        lookup: guardedLookup,
        signal,
        headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.5', 'Accept-Encoding': 'gzip, deflate, br' },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          resolve({ status, headers: res.headers, body: Buffer.alloc(0) });
          return;
        }
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_BYTES) {
          res.destroy();
          reject(tooLarge());
          return;
        }
        const encoding = String(res.headers['content-encoding'] ?? '').trim().toLowerCase();
        const stream: Readable =
          encoding === 'gzip' || encoding === 'x-gzip'
            ? res.pipe(createGunzip())
            : encoding === 'deflate'
              ? res.pipe(createInflate())
              : encoding === 'br'
                ? res.pipe(createBrotliDecompress())
                : res;
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            res.destroy();
            stream.destroy();
            reject(tooLarge());
            return;
          }
          chunks.push(chunk);
        });
        stream.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }));
        stream.on('error', reject);
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

export interface FetchedText {
  finalUrl: string;
  status: number;
  contentType: string;
  text: string;
}

/**
 * 바깥 주소를 글자로 읽는다(위 「바깥 페이지 읽기」 규칙). 리디렉션은 3번까지 따라가며 넘길 때마다 같은 검사를 한다. 글자 인코딩은
 * 머리글 charset → <meta charset> → UTF-8 → EUC-KR 순(server/aeo/collectPage.ts decodeBody). 실패는 PostFetchError(code · 사람이 읽을 이유).
 */
export async function fetchText(raw: string, accept = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'): Promise<FetchedText> {
  let url = checkTarget(raw);
  await paceHost(url.host);
  await acquireFetch();
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  try {
    for (let hop = 0; ; hop += 1) {
      let res: RawResponse;
      try {
        res = await requestOnce(url, accept, signal);
      } catch (err) {
        if (err instanceof PostFetchError) throw err;
        if (signal.aborted) throw new PostFetchError('TIMEOUT', `${FETCH_TIMEOUT_MS / 1000}초 안에 응답이 오지 않아 멈췄습니다.`);
        const mapped = publicCollectorError(err);
        throw new PostFetchError(mapped.code, mapped.message);
      }
      const location = res.headers.location;
      if (res.status >= 300 && res.status < 400 && location) {
        if (hop >= MAX_REDIRECTS) throw new PostFetchError('TOO_MANY_REDIRECTS', `리디렉션이 ${MAX_REDIRECTS}번을 넘어 멈췄습니다.`);
        url = checkTarget(new URL(location, url).href);
        continue;
      }
      const contentType = String(res.headers['content-type'] ?? '');
      return { finalUrl: url.href, status: res.status, contentType, text: decodeBody(new Uint8Array(res.body), contentType) };
    }
  } finally {
    releaseFetch();
  }
}

const reasonOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ── 고객 브랜드의 초안 · 배정 · 원장 ────────────────────────────────────────

interface OwnerContext {
  plan: WriterPlan | null;
  /** 배정 파일이 있는데 읽지 못했다. */
  planUnreadable: boolean;
  /** 추가 글 정의(뺀 글 포함) — 읽지 못했거나 깨졌으면 null. */
  extras: ExtraArticle[] | null;
}

/** 그 브랜드의 배정 · 추가 글 정의. 읽기 실패는 로그를 남기고 「읽지 못함」으로 둔다 — 누구 글인지를 짐작하지 않는다. */
async function ownerContext(tenantId: string): Promise<OwnerContext> {
  let plan: WriterPlan | null = null;
  let planUnreadable: boolean;
  try {
    const state = await readProbePlan(tenantId);
    plan = state.plan;
    planUnreadable = state.corrupt;
  } catch (err) {
    console.error(`[postImport] ${tenantId} probe-plan.json을 읽지 못했습니다:`, err);
    planUnreadable = true;
  }
  let extras: ExtraArticle[] | null = null;
  try {
    const state = await readExtraArticles(tenantId);
    extras = state.corrupt ? null : state.articles;
  } catch (err) {
    console.error(`[postImport] ${tenantId} extra-articles.json을 읽지 못했습니다:`, err);
  }
  return { plan, planUnreadable, extras };
}

interface CorpusEntry {
  tenantId: string;
  brand: string;
  articleId: string;
  title: string;
  titleGrams: Set<string>;
  bodyGrams: Set<string>;
  writer: { key: string; name: string } | null;
  bankUnknown: boolean;
  writerUnknown: boolean;
}

/** 브랜드별 비교 재료 — 초안 · 배정 · 추가 글 파일이 그대로면 다시 만들지 않는다(주소마다 초안 1MB를 다시 읽지 않게). */
const corpusCache = new Map<string, { sig: string; entries: CorpusEntry[] }>();

async function fileSig(file: string): Promise<string> {
  try {
    const s = await stat(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'none';
    throw err;
  }
}

const isStoredDraft = (v: unknown): v is StoredDraft => {
  const d = (v as StoredDraft | null)?.draft;
  return typeof (v as StoredDraft | null)?.generatedAt === 'string' && typeof d?.title === 'string' && Array.isArray(d.sections);
};

/**
 * 그 브랜드의 초안(drafts.json) — 파일이 없으면 빈 목록, 읽지 못했거나(잠김 · 권한) 깨졌으면 오류. readDrafts(server/contentDraft.ts)는 둘 다
 * 빈 목록으로 돌려주는데, 짝짓기에서 그러면 그 브랜드 글이 모두 「앱 글 아님」으로 숨는다.
 */
async function draftsForMatch(tenantId: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path.join(PIPELINE_DATA_DIR, tenantId, 'drafts.json'), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('drafts.json이 글 목록 모양이 아닙니다.');
  return parsed as Record<string, unknown>;
}

/** 짝짓기 재료를 만들지 못한 브랜드 — 그 브랜드 글을 빼고 짝지으면 「앱 글 아님」이나 엉뚱한 「맞음」이 되므로 읽기를 「읽지 못함」으로 돌린다. */
class CorpusError extends Error {}

async function tenantCorpus(t: TenantConfig, brand: string): Promise<CorpusEntry[]> {
  const dir = path.join(PIPELINE_DATA_DIR, t.tenantId);
  const signature = async () => [brand, ...(await Promise.all(['drafts.json', PROBE_PLAN_FILE, 'extra-articles.json'].map((f) => fileSig(path.join(dir, f)))))].join('|');
  const sig = await signature();
  const cached = corpusCache.get(t.tenantId);
  if (cached?.sig === sig) return cached.entries;
  let drafts: Record<string, unknown>;
  try {
    drafts = await draftsForMatch(t.tenantId);
  } catch (err) {
    console.warn(`[postImport] ${t.tenantId} 초안(drafts.json)을 읽지 못해 짝짓지 않았습니다:`, err);
    throw new CorpusError(`${brand}의 초안(drafts.json)을 읽지 못해 짝짓지 않았습니다(${reasonOf(err)}) — 잠시 뒤 「다시 읽기」를 눌러 주세요.`);
  }
  const owner = await ownerContext(t.tenantId);
  const defs = new Map((owner.extras ?? []).map((e) => [e.id, e]));
  const entries: CorpusEntry[] = [];
  for (const [articleId, stored] of Object.entries(drafts)) {
    if (!isStoredDraft(stored)) {
      console.warn(`[postImport] ${t.tenantId} 초안 모양이 틀려 짝짓기에서 뺐습니다: ${articleId}`);
      continue;
    }
    let title: string;
    try {
      title = draftTitle(effectiveDraft(stored));
    } catch (err) {
      console.warn(`[postImport] ${t.tenantId} 초안 제목을 만들지 못해 짝짓기에서 뺐습니다: ${articleId}`, err);
      continue;
    }
    const text = draftMatchText(stored);
    // 작성자는 콘텐츠 보관함 규칙(assignedArticle — 추가 글 정의가 없는 배정 글(판 미확인)도 그 작성자, 등록도 작성자 기록으로 적는다) —
    // 모르면(writerUnknownOf — 등록과 같은 식) 질문 글(topic:)은 「미확인」.
    const writerUnknown = writerUnknownOf(articleId, owner.plan, owner.planUnreadable, owner.extras);
    const assigned = !writerUnknown && owner.plan && owner.extras ? assignedArticle(owner.plan, defs, articleId) : null;
    entries.push({
      tenantId: t.tenantId,
      brand,
      articleId,
      title,
      titleGrams: bigrams(text.title),
      bodyGrams: bigrams(text.body),
      writer: assigned ? { key: assigned.article.writer.key, name: assigned.article.writer.name } : null,
      bankUnknown: assigned?.bankUnknown ?? false,
      writerUnknown,
    });
  }
  // 읽는 사이 파일이 바뀌었으면 담아 두지 않는다 — 다음 읽기가 새로 만든다.
  if ((await signature()) === sig) corpusCache.set(t.tenantId, { sig, entries });
  return entries;
}

const customersOf = (tenants: TenantConfig[]) => tenants.filter((t) => !t.cohortOnly);

/**
 * 이 주소(추적 키들 — 붙여 넣은 · 읽은 · 적을 주소)가 고객 브랜드 원장에 적힌 기록(살아 있는 줄 · 옛 기록)과, 글마다 이 주소들 말고 이미 적힌
 * 자사 · 직접 주소 수(CLI의 「이 글에는 이미 다른 주소가 적혀 있습니다」와 같은 셈 — 같은 글을 두 곳에 올렸는지 사람이 보게). 원장을 읽지 못한
 * 브랜드는 로그를 남기고 건너뛴다.
 */
async function ledgerView(customers: TenantConfig[], keys: readonly string[]): Promise<{ known: KnownRecord[]; otherUrls: Map<string, number> }> {
  const wanted = new Set(keys);
  const parts = await Promise.all(
    customers.map(async (t) => {
      try {
        return { t, posts: await readPublishedPosts(t.tenantId) };
      } catch (err) {
        console.warn(`[postImport] ${t.tenantId} 원장을 읽지 못해 이 브랜드의 기록은 보지 않았습니다:`, err);
        return { t, posts: [] };
      }
    }),
  );
  const known: KnownRecord[] = [];
  const urlsOf = new Map<string, Set<string>>();
  for (const { t, posts } of parts) {
    const brand = brandLabel(t, customers);
    for (const p of posts) {
      if (p.removedAt) continue;
      if (wanted.has(p.key)) {
        known.push({
          tenantId: t.tenantId,
          brand,
          articleId: p.articleId,
          targetActionId: p.targetActionId,
          via: p.via,
          articleTitle: p.articleTitle ?? null,
          publishedOn: p.publishedOn,
          legacy: p.legacy === true,
        });
      } else if (!p.legacy && p.targetActionId === p.articleId) {
        const at = `${t.tenantId}
${p.articleId}`;
        urlsOf.set(at, (urlsOf.get(at) ?? new Set<string>()).add(p.key));
      }
    }
  }
  return { known, otherUrls: new Map([...urlsOf].map(([at, keys]) => [at, keys.size])) };
}

// ── 읽기 ────────────────────────────────────────────────────────────────────

/** 404 · 410이면 주소 끝에 붙은 글자(「…/slug/입니다」)를 떼고 한 번 더 읽는다 — 읽은 주소와 페이지. 다시 읽기가 실패하면 처음 응답 그대로. */
async function fetchPostPage(url: string): Promise<{ readUrl: string; page: FetchedText }> {
  const page = await fetchText(readTargetOf(url));
  const cut = page.status === 404 || page.status === 410 ? withoutTrailingText(url) : null;
  if (!cut) return { readUrl: url, page };
  try {
    const retry = await fetchText(readTargetOf(cut));
    return retry.status < 400 ? { readUrl: cut, page: retry } : { readUrl: url, page };
  } catch (err) {
    console.warn(`[postImport] 끝 글자를 뗀 주소도 읽지 못해 처음 응답(HTTP ${page.status})으로 둡니다: ${cut}`, err);
    return { readUrl: url, page };
  }
}

/** 화면에 보일 짧은 주소(http(s):// · 끝 슬래시를 뗀다). */
const shownUrl = (u: string) => u.replace(/^https?:\/\//i, '').replace(/\/+$/, '');

/** 글 페이지를 읽어 후보와 원장 기록을 돌려준다(페이지를 읽지 못하면 ok:false · 이유). 글 주소가 아니면 400. */
export async function readPostForImport(rawUrl: unknown, tenants: TenantConfig[], now = Date.now()): Promise<PostImportRead> {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) throw new PostImportError('읽을 글 주소(url)가 필요합니다.', 400);
  const url = rawUrl.trim();
  const check = isArticleUrl(url);
  if (!check.ok) throw new PostImportError(ARTICLE_URL_REASON[check.reason], 400);
  const key = trackingKey(url)!;
  const fail = (error: string): PostImportRead => ({ ok: false, url, key, error });
  let readUrl: string;
  let page: FetchedText;
  try {
    ({ readUrl, page } = await fetchPostPage(url));
  } catch (err) {
    return fail(reasonOf(err));
  }
  if (page.status === 404 || page.status === 410) return fail(`없는 글입니다(HTTP ${page.status}) — 주소를 다시 확인하거나 글이 공개됐는지 봐 주세요.`);
  if (page.status === 429) return fail('블로그가 잠시 요청을 막았습니다(HTTP 429) — 1~2분 뒤 「다시 읽기」를 눌러 주세요.');
  if (page.status >= 400) return fail(`페이지를 읽지 못했습니다(HTTP ${page.status}).`);
  if (page.contentType && !/html|xml|text\/plain/i.test(page.contentType)) {
    return fail(`글 페이지가 아닙니다(${page.contentType.split(';')[0]}).`);
  }
  // 지운 글 · 비공개 글은 블로그 홈으로 넘어가기도 한다 — 그 페이지를 글로 읽지 않는다.
  if (trackingKey(page.finalUrl) !== trackingKey(readTargetOf(readUrl)) && !isArticleUrl(page.finalUrl).ok) {
    return fail(`글 주소가 블로그 홈 · 첫 화면(${shownUrl(page.finalUrl)})으로 넘어갔습니다 — 글이 지워졌거나 비공개로 바뀌었는지 봐 주세요.`);
  }
  // 플랫폼은 실제로 읽은 곳으로(wp.me 단축 주소 → 워드프레스).
  const platform = postPlatformOf(page.finalUrl);
  const parsed = parsePostHtml(platform, page.text, now);
  const bodyGrams = bigrams(parsed.body);
  if (bodyGrams.size < MIN_BODY_GRAMS) {
    return fail(`본문 글자를 거의 찾지 못했습니다(${parsed.body.length}자) — 사진만 있는 글이거나 페이지 모양이 다릅니다.`);
  }
  // 적을 주소 — 페이지가 밝힌 정식 주소(같은 블로그의 글일 때) › 리디렉션 뒤 주소 › 읽은 주소. 추적 키가 같으면 적힌 모양 그대로.
  const declared = [parsed.canonical, parsed.ogUrl].flatMap((c) => (c ? [sameBlogPostUrl(page.finalUrl, c)] : [])).find((c): c is string => c !== null) ?? null;
  const target = declared ?? (isArticleUrl(page.finalUrl).ok ? page.finalUrl : readUrl);
  const readKey = trackingKey(readUrl)!;
  const recordUrl = trackingKey(target) === key ? url : trackingKey(target) === readKey ? readUrl : target;
  const recordKey = trackingKey(recordUrl)!;
  const notes: string[] = [];
  if (readUrl !== url) notes.push(`주소 끝에 붙은 「${url.slice(readUrl.length)}」를 떼고 읽었습니다`);
  if (recordKey !== readKey) notes.push(recordUrl === declared ? '페이지가 밝힌 정식 주소로 적습니다' : '이 주소로 넘어가 넘어간 주소로 적습니다');
  const customers = customersOf(tenants);
  let corpus: CorpusEntry[];
  try {
    corpus = (await Promise.all(customers.map((t) => tenantCorpus(t, brandLabel(t, customers))))).flat();
  } catch (err) {
    if (err instanceof CorpusError) return fail(err.message);
    console.error('[postImport] 앱 글을 모으지 못했습니다:', err);
    return fail(`앱 글을 모으지 못해 짝짓지 않았습니다 — ${reasonOf(err)}`);
  }
  const titleGrams = bigrams(parsed.title);
  const ledger = await ledgerView(customers, [...new Set([key, readKey, recordKey])]);
  const round = (n: number) => Math.round(n * 1000) / 1000;
  const candidates: ImportCandidate[] = corpus
    .map((d) => ({ d, body: jaccard(bodyGrams, d.bodyGrams), title: jaccard(titleGrams, d.titleGrams) }))
    .sort((a, b) => b.body - a.body || b.title - a.title)
    .slice(0, CANDIDATE_LIMIT)
    .map(({ d, body, title }) => ({
      tenantId: d.tenantId,
      brand: d.brand,
      articleId: d.articleId,
      title: d.title,
      body: round(body),
      titleScore: round(title),
      writer: d.writer,
      bankUnknown: d.bankUnknown,
      writerUnknown: d.writerUnknown,
      otherUrls: ledger.otherUrls.get(`${d.tenantId}
${d.articleId}`) ?? 0,
    }));
  const host = new URL(recordUrl).hostname.replace(/^www\./, '');
  return {
    ok: true,
    url,
    key,
    recordUrl,
    recordKey,
    urlNote: notes.length > 0 ? `${notes.join(' · ')}.` : null,
    platform: { key: platform, label: platform === 'generic' ? host : POST_PLATFORM_LABEL[platform] },
    post: { title: parsed.title, publishedOn: parsed.publishedOn, dateText: parsed.dateText, dateProblem: parsed.dateProblem, bodyChars: parsed.body.length },
    candidates,
    known: ledger.known,
  };
}

// ── 저장한 블로그 ───────────────────────────────────────────────────────────

const BLOG_SOURCES_FORMAT = 'blog-sources/1';
const sourcesFile = () => stateFilePath('blog-sources.json');

/** 저장한 블로그. 없으면 빈 목록, 깨졌으면 오류(빈 목록으로 읽고 덮어쓰면 목록이 사라진다). */
export async function readBlogSources(): Promise<BlogSource[]> {
  let text: string;
  try {
    text = await readFile(sourcesFile(), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new PostImportError(`저장한 블로그 목록을 읽지 못했습니다: ${reasonOf(err)}`, 500);
  }
  let raw: { format?: unknown; sources?: unknown };
  try {
    raw = JSON.parse(text) as { format?: unknown; sources?: unknown };
  } catch (err) {
    throw new PostImportError(`저장한 블로그 목록(blog-sources.json)이 깨져 있어 읽지 않았습니다: ${reasonOf(err)}`, 500);
  }
  if (raw?.format !== BLOG_SOURCES_FORMAT || !Array.isArray(raw.sources)) {
    throw new PostImportError('저장한 블로그 목록(blog-sources.json)의 모양이 맞지 않아 읽지 않았습니다.', 500);
  }
  return raw.sources.flatMap((s): BlogSource[] => {
    const v = s as Partial<BlogSource> | null;
    const norm = typeof v?.url === 'string' ? normalizeBlogSource(v.url) : null;
    return norm?.ok ? [{ url: norm.url, platform: norm.platform, addedAt: typeof v?.addedAt === 'string' ? v.addedAt : '' }] : [];
  });
}

let sourcesWrite: Promise<unknown> = Promise.resolve();

/** 블로그 목록을 통째로 저장한다({ sources: [주소] } — 더하기 · 빼기 모두). 홈으로 맞추고 같은 블로그는 한 번. 틀린 주소가 있으면 400 · 그대로. */
export function saveBlogSources(body: unknown, now = new Date()): Promise<BlogSource[]> {
  const list = (body as { sources?: unknown } | null)?.sources;
  if (!Array.isArray(list) || !list.every((s) => typeof s === 'string')) {
    return Promise.reject(new PostImportError('본문은 { sources: [블로그 주소] } 모양이어야 합니다.', 400));
  }
  const normalized: { url: string; platform: BlogSource['platform'] }[] = [];
  for (const raw of list as string[]) {
    const norm = normalizeBlogSource(raw);
    if (!norm.ok) return Promise.reject(new PostImportError(norm.error, 400));
    if (!normalized.some((n) => n.url === norm.url)) normalized.push({ url: norm.url, platform: norm.platform });
  }
  if (normalized.length > BLOG_SOURCES_MAX) return Promise.reject(new PostImportError(`블로그는 ${BLOG_SOURCES_MAX}곳까지 저장합니다.`, 400));
  const run = sourcesWrite.then(async () => {
    const before = await readBlogSources();
    const sources = normalized.map((n) => ({ ...n, addedAt: before.find((b) => b.url === n.url)?.addedAt || now.toISOString() }));
    await writeJsonAtomic(sourcesFile(), { format: BLOG_SOURCES_FORMAT, sources });
    return sources;
  });
  sourcesWrite = run.catch(() => undefined);
  return run;
}

// ── 새 글 찾기 ──────────────────────────────────────────────────────────────

/** 고객 브랜드 원장에 살아 있는 주소의 추적 키(옛 기록 포함). 원장을 읽지 못한 브랜드는 로그를 남기고 건너뛴다. */
async function recordedKeys(customers: TenantConfig[]): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const t of customers) {
    try {
      for (const p of await readPublishedPosts(t.tenantId)) if (!p.removedAt) keys.add(p.key);
    } catch (err) {
      console.warn(`[postImport] ${t.tenantId} 원장을 읽지 못해 이 브랜드의 기록은 빼지 않았습니다:`, err);
    }
  }
  return keys;
}

const FEED_ACCEPT = 'application/rss+xml,application/atom+xml,application/xml;q=0.9,text/xml;q=0.9,*/*;q=0.5';

/**
 * 저장한 블로그 하나의 새 글 — 목록(RSS · 사이트맵 · 워드프레스 공개 API)을 읽어 이 블로그의 글 주소만 모으고(listedPostUrls — www. · m.는
 * 떼고 보고, 목록을 실제로 받은 곳(리디렉션 뒤)의 호스트도 같은 블로그), 고객 브랜드 원장에 살아 있는 주소를 뺀다. 최근 글부터
 * NEW_URLS_MAX편만 돌려준다(작성자의 원래 블로그는 글이 천 편을 넘는다 — 11-09 실측 1043편). 읽지 못한 목록은 errors로 알린다(다른 목록으로
 * 하나라도 읽었으면 404는 알리지 않는다 — 그 밖 블로그는 RSS · feed · 사이트맵 가운데 있는 것만 쓴다). 목록은 읽었는데 이 블로그 글이 하나도
 * 없고 다른 사이트 글 주소만 있으면(워드프레스에 연결한 도메인 · 옮긴 블로그) 그 주소로 저장하라고 알린다. 저장하지 않은 블로그는 400.
 */
export async function listBlogPosts(rawSource: unknown, tenants: TenantConfig[]): Promise<BlogListResult> {
  if (typeof rawSource !== 'string') throw new PostImportError('블로그 주소(source)가 필요합니다.', 400);
  const norm = normalizeBlogSource(rawSource);
  if (!norm.ok) throw new PostImportError(norm.error, 400);
  if (!(await readBlogSources()).some((s) => s.url === norm.url)) {
    throw new PostImportError(`저장한 블로그가 아닙니다 — 먼저 목록에 더해 주세요: ${norm.url}`, 400);
  }
  const urls: string[] = [];
  const errors: { text: string; notFound: boolean }[] = [];
  /** 이 블로그의 목록을 실제로 받은 곳의 호스트(리디렉션 뒤 — 워드프레스 공개 API는 빼고). */
  const listHosts = new Set<string>();
  let anyRead = false;
  const readList = async (target: string, ownSite: boolean): Promise<string | null> => {
    try {
      const res = await fetchText(target, FEED_ACCEPT);
      if (res.status >= 400) {
        errors.push({ text: `${target} — HTTP ${res.status}`, notFound: res.status === 404 });
        return null;
      }
      anyRead = true;
      const host = ownSite ? siteHostOf(res.finalUrl) : null;
      if (host) listHosts.add(host);
      return res.text;
    } catch (err) {
      errors.push({ text: `${target} — ${reasonOf(err)}`, notFound: false });
      return null;
    }
  };
  // 하위 사이트맵은 같은 블로그(호스트 규칙은 글 주소와 같다)의 것만 따라간다.
  const sameSite = (raw: string) => {
    const host = siteHostOf(raw);
    return host !== null && (host === siteHostOf(norm.url) || listHosts.has(host));
  };
  for (const target of blogListTargets(norm.url)) {
    if (target.kind === 'wp-api') {
      for (let page = 1; page <= WP_MAX_PAGES; page += 1) {
        const text = await readList(wpListPageUrl(new URL(norm.url).hostname, page), false);
        if (text === null) break;
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch (err) {
          errors.push({ text: `워드프레스 글 목록을 읽지 못했습니다 — ${reasonOf(err)}`, notFound: false });
          break;
        }
        const list = parseWpPostList(json);
        urls.push(...list.urls);
        if (list.urls.length < 100) break;
      }
      continue;
    }
    const text = await readList(target.url, true);
    if (text === null) continue;
    if (target.kind === 'rss') {
      urls.push(...parseFeedLinks(text));
      continue;
    }
    const sitemap = parseSitemap(text);
    urls.push(...sitemap.urls);
    for (const child of sitemap.sitemaps.filter(sameSite).slice(0, SITEMAP_CHILDREN_MAX)) {
      const childText = await readList(child, true);
      if (childText !== null) urls.push(...parseSitemap(childText).urls);
    }
  }
  const posts = listedPostUrls(norm.url, urls, [...listHosts]);
  const others = posts.length === 0 ? otherListHosts(norm.url, urls, [...listHosts]) : [];
  if (others.length > 0) {
    errors.push({ text: `목록의 글 주소가 다른 주소(${others.join(' · ')})에 있습니다 — 그 주소로 블로그를 저장해 주세요.`, notFound: false });
  }
  const recorded = await recordedKeys(customersOf(tenants));
  const fresh = newestFirst(posts.filter((u) => !recorded.has(trackingKey(u) ?? '')));
  return {
    source: norm.url,
    platform: norm.platform,
    found: posts.length,
    newUrls: fresh.slice(0, NEW_URLS_MAX),
    older: Math.max(0, fresh.length - NEW_URLS_MAX),
    errors: errors.filter((e) => !(anyRead && e.notFound)).map((e) => e.text),
  };
}

// ── 등록 ────────────────────────────────────────────────────────────────────

/** 다른 글에 적힌 주소 — 어느 브랜드의 어느 글인지와 푸는 길. */
function otherRecordMessage(r: KnownRecord): string {
  const name = r.articleTitle ? `「${r.articleTitle}」` : r.articleId;
  return `이 주소는 이미 ${r.brand}의 다른 글 ${name}의 올린 주소로 적혀 있습니다 — 잘못 적은 것이면 콘텐츠 보관함에서 그 기록을 뺀 뒤 다시 등록해 주세요.`;
}

async function commitOne(
  item: CommitItem,
  customers: TenantConfig[],
  bankFor: (tenant: TenantConfig) => Promise<QuestionBank | null>,
  today: string,
): Promise<CommitResult> {
  const base = { tenantId: item.tenantId, articleId: item.articleId, url: item.url };
  const fail = (error: string): CommitResult => ({ ...base, status: 'error', error });
  const tenant = customers.find((t) => t.tenantId === item.tenantId);
  if (!tenant) return fail('고객 브랜드를 찾지 못했습니다(없는 브랜드 · 비교용 경쟁사에는 적지 않습니다).');
  const check = isArticleUrl(item.url);
  if (!check.ok) return fail(ARTICLE_URL_REASON[check.reason]);
  const key = trackingKey(item.url)!;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(item.publishedOn) ? normalizeDay(item.publishedOn) : null;
  if (!day) return fail(`올린 날이 YYYY-MM-DD 날짜가 아닙니다 — ${item.publishedOn}`);
  const dayProblem = postedDayProblem(day, today);
  if (dayProblem) return fail(dayProblem);
  let drafts: Record<string, unknown>;
  try {
    drafts = await draftsForMatch(tenant.tenantId);
  } catch (err) {
    return fail(`이 브랜드의 초안(drafts.json)을 읽지 못해 적지 않았습니다 — ${reasonOf(err)}`);
  }
  const draft = drafts[item.articleId];
  if (!isStoredDraft(draft)) return fail('그 브랜드에 이 글(초안)이 없습니다 — 다시 읽어 주세요.');
  const verdict = urlVerdict((await ledgerView(customers, [key])).known, { tenantId: tenant.tenantId, articleId: item.articleId });
  if (verdict.kind === 'already') return { ...base, status: 'existing' };
  if (verdict.kind === 'other') return fail(otherRecordMessage(verdict.record));
  const owner = await ownerContext(tenant.tenantId);
  // 배정 밖 질문 은행 글(추가 글 정의가 없고 배정에도 없는 topic:)만 질문 은행으로 판을 본다(보관함 「올렸어요」와 같다). 판 미확인 배정 글은
  // 배정 파일의 판으로 적으므로 은행을 읽지 않는다.
  const needsBank =
    item.articleId.startsWith('topic:') && !(owner.extras ?? []).some((e) => e.id === item.articleId) && !writerArticle(owner.plan, item.articleId);
  const built = importRecordInput({
    plan: owner.plan,
    planUnreadable: owner.planUnreadable,
    extras: owner.extras,
    bank: needsBank ? await bankFor(tenant) : null,
    draft,
    articleId: item.articleId,
    url: item.url,
    day,
  });
  if ('error' in built) return fail(built.error);
  try {
    const r = await addPublishedPost(tenant.tenantId, built.input);
    return { ...base, status: r.existing ? 'existing' : 'added', postId: r.post.id };
  } catch (err) {
    return fail(reasonOf(err));
  }
}

/**
 * 등록 — 줄마다 다시 검사하고 적는다(한 줄씩 차례로 — 같은 브랜드의 쓰기 줄에 선다). 걸린 줄은 그 줄만 error(한 줄에서 예외가 나도 — 파일
 * 잠김 등 — 그 줄만이다. 앞 줄은 이미 적혔으므로 요청 전체를 실패로 돌리면 적힌 줄이 「못 적음」으로 보인다), 이미 그 글의 기록이면
 * existing(원장을 바꾸지 않는다 — 날짜도). 본문 모양이 틀리면 400. bankFor는 질문 은행 글의 판을 볼 은행(GET /api/question-bank와 같다).
 */
export async function commitPostImport(
  body: unknown,
  tenants: TenantConfig[],
  bankFor: (tenant: TenantConfig) => Promise<QuestionBank | null>,
  now = Date.now(),
): Promise<{ results: CommitResult[] }> {
  const parsed = parseCommitItems(body);
  if (!parsed.ok) throw new PostImportError(parsed.error, 400);
  const customers = customersOf(tenants);
  const today = todayKst(now);
  const results: CommitResult[] = [];
  for (const item of parsed.items) {
    try {
      results.push(await commitOne(item, customers, bankFor, today));
    } catch (err) {
      console.error(`[postImport] ${item.tenantId} ${item.articleId} 등록 중 오류 — 이 줄만 걸림으로 둡니다:`, err);
      results.push({ tenantId: item.tenantId, articleId: item.articleId, url: item.url, status: 'error', error: `등록하지 못했습니다 — ${reasonOf(err)}` });
    }
  }
  return { results };
}
