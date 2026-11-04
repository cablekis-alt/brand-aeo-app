import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { collectPage } from './aeo/collectPage.js';
import { PIPELINE_DATA_DIR } from './appPaths.js';
import { writeJsonAtomic } from './tenantWriteQueue.js';
import { normalizeMapPoints, type MapPoint, type MapPointsFile } from '../src/lib/mapImage.js';
import type { ScreenProfile } from '../src/lib/screenCapture.js';

/**
 * 군산 지도 그림의 장소 목록 — 고객 자사 사이트 /map/ 페이지의 div.map[data-points](JSON {all:[{lat,lng,name,url,kind,r,id}]})를 GET으로 한 번
 * 읽어 점만 검사해(src/lib/mapImage.ts normalizeMapPoints) PIPELINE_DATA_DIR/<tenant>/map-points.json에 저장한다
 * ({ fetchedAt, source, version, points }). 페이지 HTML은 저장하지 않는다 — 같은 태그에 카카오 지도 앱 키가 든 속성이 있다. 다른 속성 ·
 * anchor_pts · 장소 주소도 남기지 않는다.
 *
 * 저장한 목록이 MAP_POINTS_MAX_AGE_MS보다 젊으면 다시 받지 않는다(지도 그림 이름에 목록 판 version이 들어가 — 받을 때마다 좌표가 바뀌면
 * 그려 둔 지도를 다시 그린다). 기한이 지났는데 받지 못하면 저장한 목록을 쓰고 알린다(stale).
 */

const POINTS_FILE = 'map-points.json';
/** 저장한 장소 목록을 다시 받지 않고 쓰는 기간 — 사이트의 장소 · 좌표는 자주 바뀌지 않는다. */
export const MAP_POINTS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** 장소 목록 실패 — no-source 프로필에 출처 없음 · fetch-failed 받지 못함(저장한 목록도 없음) · no-points 점이 하나도 없음. */
export class MapPointsError extends Error {
  code: 'no-source' | 'fetch-failed' | 'no-points';
  constructor(code: MapPointsError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

/** 장소 목록 출처 주소 — https · 프로필 호스트 · 프로필의 경로. 출처가 없으면 null. */
export function mapPointsSource(profile: ScreenProfile): string | null {
  return profile.mapPoints ? new URL(profile.mapPoints.path, `https://${profile.host}/`).href : null;
}

/** HTML 글자 참조를 푼다 — 속성 값에 쓰이는 것만(&quot; &#39; &#x27; &amp; &lt; &gt; 숫자 참조). */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|quot|apos|amp|lt|gt);/gi, (whole, ref: string) => {
    const r = ref.toLowerCase();
    if (r === 'quot') return '"';
    if (r === 'apos') return "'";
    if (r === 'amp') return '&';
    if (r === 'lt') return '<';
    if (r === 'gt') return '>';
    const code = r.startsWith('#x') ? Number.parseInt(r.slice(2), 16) : Number.parseInt(r.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/**
 * 페이지 글자에서 class에 map이 있는 div의 data-points JSON — 그 속성 값만 읽어 푼다(다른 속성 · 태그는 보지 않는다). 없거나 JSON이 아니면 null.
 */
export function mapPointsFromHtml(html: string): unknown | null {
  for (const tag of html.matchAll(/<div\b[^>]*>/gi)) {
    const attrs = new Map<string, string>();
    for (const a of tag[0].matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) attrs.set(a[1]!.toLowerCase(), a[3] ?? a[4] ?? '');
    const classes = (attrs.get('class') ?? '').split(/\s+/);
    const points = attrs.get('data-points');
    if (!classes.includes('map') || points === undefined) continue;
    try {
      return JSON.parse(decodeEntities(points)) as unknown;
    } catch {
      return null;
    }
  }
  return null;
}

function pointsDir(tenantId: string): string {
  if (!tenantId || /[/\\]/.test(tenantId) || tenantId === '.' || tenantId === '..') throw new RangeError(`잘못된 브랜드 id: ${tenantId}`);
  const root = path.resolve(PIPELINE_DATA_DIR);
  const dir = path.resolve(root, tenantId);
  if (path.relative(root, dir) !== tenantId) throw new RangeError(`잘못된 브랜드 id: ${tenantId}`);
  return dir;
}

function validFile(v: unknown): v is MapPointsFile {
  if (!v || typeof v !== 'object') return false;
  const f = v as Record<string, unknown>;
  return (
    typeof f.fetchedAt === 'string' &&
    Number.isFinite(Date.parse(f.fetchedAt)) &&
    typeof f.source === 'string' &&
    f.source.startsWith('https://') &&
    typeof f.version === 'string' &&
    /^[0-9a-f]{12}$/.test(f.version) &&
    Array.isArray(f.points)
  );
}

/** 저장한 장소 목록 — 없거나 모양이 틀리면 null(틀리면 알린다). 점은 다시 검사한다. */
export async function readMapPoints(tenantId: string): Promise<MapPointsFile | null> {
  let text: string;
  try {
    text = await readFile(path.join(pointsDir(tenantId), POINTS_FILE), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.warn(`[maps] ${tenantId}/${POINTS_FILE}를 읽지 못했습니다:`, err);
    return null;
  }
  if (!validFile(parsed)) {
    console.warn(`[maps] ${tenantId}/${POINTS_FILE}의 모양이 맞지 않습니다.`);
    return null;
  }
  return { ...parsed, points: normalizeMapPoints(parsed.points).points };
}

/** 점 목록의 판 — 점(id · 이름 · 종류 · 좌표 · 권역) JSON의 sha256 앞 12자. */
export function mapPointsVersion(points: readonly MapPoint[]): string {
  return createHash('sha256').update(JSON.stringify(points)).digest('hex').slice(0, 12);
}

export interface FetchedPage {
  status: number;
  html: string;
  fetchError?: string | null;
}

async function defaultFetchPage(url: string): Promise<FetchedPage> {
  const page = await collectPage(url, { probes: false });
  return { status: page.status, html: page.html, fetchError: page.fetchError };
}

const inflight = new Map<string, Promise<{ file: MapPointsFile; fetched: boolean; stale: boolean; warning?: string }>>();

/**
 * 브랜드의 장소 목록 — 저장한 목록이 기한 안이면 그것(refresh면 다시 받는다), 아니면 자사 사이트 /map/을 받아 점만 저장한다. 받기는 사이트
 * 진단과 같은 수집기(collectPage — 사설 주소 · 크기 · 시간 한도, 검증은 가짜를 넣는다). 받지 못하면 저장한 목록(stale · warning), 그것도
 * 없으면 fetch-failed. 점이 하나도 없으면 no-points(저장하지 않는다).
 */
export function loadMapPoints(
  tenantId: string,
  profile: ScreenProfile,
  opts: { now?: () => Date; fetchPage?: (url: string) => Promise<FetchedPage>; refresh?: boolean } = {},
): Promise<{ file: MapPointsFile; fetched: boolean; stale: boolean; warning?: string }> {
  const key = `${tenantId}\n${opts.refresh ? 'refresh' : ''}`;
  const running = inflight.get(key);
  if (running) return running;
  const job = (async () => {
    const source = mapPointsSource(profile);
    if (!source) throw new MapPointsError('no-source', '이 브랜드에는 지도 장소 목록 출처가 없어요.');
    const now = (opts.now ?? (() => new Date()))();
    const saved = await readMapPoints(tenantId);
    const fresh = saved && saved.source === source && now.getTime() - Date.parse(saved.fetchedAt) < MAP_POINTS_MAX_AGE_MS;
    if (saved && fresh && !opts.refresh) return { file: saved, fetched: false, stale: false };
    let raw: unknown = null;
    let failure = '';
    try {
      const page = await (opts.fetchPage ?? defaultFetchPage)(source);
      if (page.fetchError) failure = page.fetchError;
      else if (page.status >= 400 || page.status === 0) failure = `HTTP ${page.status}`;
      else raw = mapPointsFromHtml(page.html);
      if (!failure && raw === null) failure = '지도 장소 목록(div.map[data-points])을 찾지 못함';
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    if (failure) {
      const message = `자사 사이트의 지도 장소 목록을 받지 못했어요 — ${failure.slice(0, 200)}`;
      if (saved) {
        console.warn(`[maps] ${tenantId} ${message} — 저장한 목록(${saved.fetchedAt})을 씁니다.`);
        return { file: saved, fetched: false, stale: true, warning: message };
      }
      throw new MapPointsError('fetch-failed', message);
    }
    const { points, skipped } = normalizeMapPoints(raw);
    if (!points.length) throw new MapPointsError('no-points', '자사 사이트의 지도 장소 목록에 쓸 수 있는 장소가 없어요.');
    if (skipped) console.warn(`[maps] ${tenantId} 지도 장소 ${skipped}곳은 모양 · 좌표 범위가 맞지 않아 뺐습니다.`);
    const file: MapPointsFile = { fetchedAt: now.toISOString(), source, version: mapPointsVersion(points), points };
    await writeJsonAtomic(path.join(pointsDir(tenantId), POINTS_FILE), file);
    return { file, fetched: true, stale: false };
  })();
  inflight.set(key, job);
  return job.finally(() => {
    if (inflight.get(key) === job) inflight.delete(key);
  });
}
