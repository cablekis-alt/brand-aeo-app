import { readFileSync } from 'node:fs';
import { stateFilePath } from './appPaths.js';
import { writeJsonAtomic } from './tenantWriteQueue.js';
import { normSlotAlt } from '../src/lib/articlePhotos.js';
import { placeKey } from '../src/lib/photoAutoPick.js';
import {
  galleryTourPhotos,
  knownRegion,
  korTourPhotos,
  pickTourPlace,
  regionLabel,
  regionsAgree,
  TOUR_SOURCES,
  tourItems,
  tourPhotoSrc,
  tourRegionOf,
  tourResultCode,
  tourStemKeywords,
  tourTotalCount,
  type TourApiErrorCode,
  type TourPhoto,
  type TourPhotoQuery,
  type TourPhotoResult,
  type TourPlace,
} from '../src/lib/tourPhotos.js';

/**
 * 관광공사 사진(3단계) — 한국관광공사 TourAPI를 이 PC의 키(userData/.env의 TOURAPI_SERVICE_KEY)로 부른다. 키는 서버 안에서만 읽고
 * 화면 · 로그 · 오류 글자에 싣지 않는다(scrub). 설치본에 동봉하지 않는다 — 키가 없으면 /api/health의 tourApi가 false라 화면이 이 단계를
 * 건너뛴다(웹 · Vercel도 같다).
 *
 * 개발계정 한도가 서비스마다 하루 1,000건쯤이라, 응답은 7일 동안 디스크(tourapi-cache.json)에 두고 다시 부르지 않는다. 같은 요청이 동시에
 * 오면 한 번만 부른다. 이 PC에서 하루(KST)에 서비스마다 DAILY_LIMIT건을 넘기면 부르지 않고 한도 알림을 돌려준다. 응답 읽기 · 장소 맞추기 ·
 * 지역 확인은 src/lib/tourPhotos.ts.
 */

const DEFAULT_BASE = 'https://apis.data.go.kr/B551011';
const CACHE_FILE = stateFilePath('tourapi-cache.json');
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_MAX = 3000;
const PHOTO_INDEX_MAX = 8000;
const CALL_TIMEOUT_MS = 10_000;
/** 이 PC에서 하루에 서비스마다 부르는 최대 횟수 — 개발계정 한도(약 1,000건)에 닿기 전에 멈춘다. */
const DAILY_LIMIT = 800;
const ROWS = '40';
/** 국문 관광정보의 제1유형 사진이 이보다 적으면 관광사진 정보도 찾는다. */
const GALLERY_WHEN_FEWER = 4;
/**
 * 관광사진 정보는 쪽마다 GALLERY_ROWS건씩 전체 건수(totalCount)까지, GALLERY_PAGES쪽까지 받는다 — 장소의 사진을 모두 보고 장면으로
 * 고른다(군산근대역사박물관 115장 — 첫 40장은 모두 2013-01 실내 전시 사진이었다). 쪽마다 7일 캐시.
 */
const GALLERY_ROWS = 100;
const GALLERY_PAGES = 5;

type Service = 'KorService2' | 'PhotoGalleryService1';
const SERVICE_NAME: Record<Service, string> = { KorService2: TOUR_SOURCES.kor.name, PhotoGalleryService1: TOUR_SOURCES.gallery.name };

export class TourApiError extends Error {
  readonly code: TourApiErrorCode;
  constructor(code: TourApiErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function serviceKey(): string {
  return (process.env.TOURAPI_SERVICE_KEY ?? '').trim();
}

/** 이 PC에 TourAPI 키가 있는가(값은 내보내지 않는다). */
export function tourApiConfigured(): boolean {
  return serviceKey().length > 0;
}

/** 글자에서 키를 지운다 — 오류 · 로그에 키나 키가 든 주소가 섞이지 않게. */
export function scrubTourKey(text: string): string {
  const key = serviceKey();
  if (!key) return text;
  return [key, encodeURIComponent(key), new URLSearchParams({ k: key }).toString().slice(2)].reduce((s, k) => s.split(k).join('***'), text);
}

/** 부를 주소의 뿌리 — 기본은 data.go.kr. TOURAPI_BASE_URL은 이 PC의 확인용 가짜 서버(127.0.0.1)만 받는다(키를 다른 곳에 보내지 않게). */
function baseUrl(): string {
  const raw = (process.env.TOURAPI_BASE_URL ?? '').trim().replace(/\/+$/, '');
  return raw === DEFAULT_BASE || /^http:\/\/127\.0\.0\.1:\d{2,5}(\/[\w-]+)*$/.test(raw) ? raw : DEFAULT_BASE;
}

interface CacheEntry {
  at: number;
  items: Record<string, unknown>[];
  /** 응답의 전체 건수(totalCount) — 쪽을 넘길지 정한다. 옛 기록에는 없다. */
  total?: number | null;
}
/** 받은 관광공사 사진의 장소 제목 · 제1유형 여부 — 사진 저장 때 서버가 다시 본다(tourPhotoInfo). */
interface PhotoInfo {
  title: string;
  type1: boolean;
}
interface CacheFile {
  entries: Record<string, CacheEntry>;
  photos: Record<string, PhotoInfo>;
}

let cache: CacheFile | null = null;
let saveTimer: NodeJS.Timeout | null = null;
const inflight = new Map<string, Promise<{ items: Record<string, unknown>[]; total: number | null }>>();
const daily = new Map<string, number>();

function loadCache(): CacheFile {
  if (cache) return cache;
  let raw: unknown = null;
  try {
    raw = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[tourapi] 캐시를 읽지 못해 새로 시작합니다', err instanceof Error ? err.message : err);
  }
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<CacheFile>;
  const now = Date.now();
  const entries = Object.fromEntries(
    Object.entries(r.entries && typeof r.entries === 'object' ? r.entries : {}).filter(
      ([, e]) => e && typeof e.at === 'number' && now - e.at < CACHE_TTL_MS && Array.isArray(e.items),
    ),
  );
  const photos = r.photos && typeof r.photos === 'object' ? r.photos : {};
  cache = { entries, photos };
  return cache;
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const c = loadCache();
    const keys = Object.keys(c.entries);
    if (keys.length > CACHE_MAX) {
      for (const k of keys.sort((a, b) => c.entries[a]!.at - c.entries[b]!.at).slice(0, keys.length - CACHE_MAX)) delete c.entries[k];
    }
    const srcs = Object.keys(c.photos);
    for (const k of srcs.slice(0, Math.max(0, srcs.length - PHOTO_INDEX_MAX))) delete c.photos[k];
    writeJsonAtomic(CACHE_FILE, c).catch((err: unknown) => console.warn('[tourapi] 캐시를 저장하지 못했습니다', err instanceof Error ? err.message : err));
  }, 1000);
  saveTimer.unref();
}

function todayKst(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 오류 응답(XML · JSON)의 이유 — 키 · 한도 · 서비스 승인. */
function classify(service: Service, text: string, code: string): TourApiError {
  if (/LIMITED_NUMBER_OF_SERVICE_REQUESTS|EXCEEDS/i.test(text) || code === '22') {
    return new TourApiError('QUOTA', '오늘 TourAPI 호출 한도에 닿았어요 — 내일 다시 눌러 주세요(이미 받은 결과는 7일 동안 다시 부르지 않아요).');
  }
  if (/SERVICE_KEY_IS_NOT_REGISTERED|SERVICE_KEY|INVALID_KEY/i.test(text) || code === '30' || code === '31') {
    return new TourApiError('KEY', 'TourAPI 키가 등록되지 않았거나 맞지 않아요 — 이 PC의 TOURAPI_SERVICE_KEY를 확인해 주세요.');
  }
  if (/NO_OPENAPI_SERVICE|UNREGISTERED|ACCESS_DENIED/i.test(text) || code === '12' || code === '20') {
    return new TourApiError('FORBIDDEN', `「${SERVICE_NAME[service]}」 사용 승인이 이 키에 없어요 — data.go.kr에서 활용신청을 확인해 주세요.`);
  }
  return new TourApiError('UPSTREAM', `TourAPI 응답 오류${code ? `(결과 코드 ${code.slice(0, 8)})` : ''}`);
}

async function callLive(service: Service, op: string, params: Record<string, string>): Promise<{ items: Record<string, unknown>[]; total: number | null }> {
  const key = serviceKey();
  if (!key) throw new TourApiError('NO_KEY', '이 PC에 관광공사 TourAPI 키가 없어요.');
  const dayKey = `${todayKst()}|${service}`;
  const used = daily.get(dayKey) ?? 0;
  if (used >= DAILY_LIMIT) {
    throw new TourApiError('QUOTA', `이 PC에서 오늘 「${SERVICE_NAME[service]}」를 ${DAILY_LIMIT}번 불러 멈췄어요 — 내일 다시 눌러 주세요.`);
  }
  daily.set(dayKey, used + 1);
  const q = new URLSearchParams({ serviceKey: key, MobileOS: 'ETC', MobileApp: 'BrandAEO', _type: 'json', numOfRows: ROWS, pageNo: '1', ...params });
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/${service}/${op}?${q.toString()}`, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS), headers: { Accept: 'application/json' } });
  } catch (err) {
    if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new TourApiError('TIMEOUT', `TourAPI가 ${CALL_TIMEOUT_MS / 1000}초 안에 답하지 않았어요.`);
    }
    throw new TourApiError('UPSTREAM', `TourAPI에 연결하지 못했어요 — ${scrubTourKey(err instanceof Error ? err.message : String(err)).slice(0, 120)}`);
  }
  // data.go.kr 게이트웨이는 등록 · 승인되지 않은 키에 401 'Unauthorized'를 준다 — 다음 장소 · 다른 서비스도 같으니 KEY로 멈추게 한다.
  if (res.status === 401) throw new TourApiError('KEY', 'TourAPI 키가 등록되지 않았거나 아직 승인되지 않았어요(HTTP 401) — 이 PC의 TOURAPI_SERVICE_KEY를 확인해 주세요.');
  if (res.status === 403) throw new TourApiError('FORBIDDEN', `「${SERVICE_NAME[service]}」 사용 승인이 이 키에 없어요(HTTP 403) — data.go.kr에서 활용신청을 확인해 주세요.`);
  if (res.status === 429) throw classify(service, 'LIMITED_NUMBER_OF_SERVICE_REQUESTS', '');
  const text = await res.text();
  if (!res.ok) {
    const e = classify(service, text, '');
    throw e.code === 'UPSTREAM' ? new TourApiError('UPSTREAM', `TourAPI 응답 오류(HTTP ${res.status})`) : e;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw classify(service, text, '');
  }
  const code = tourResultCode(json);
  if (code !== '0000') throw classify(service, '', code);
  return { items: tourItems(json), total: tourTotalCount(json) };
}

type Page = { items: Record<string, unknown>[]; total: number | null };

/** 서비스 하나를 부른다 — 7일 캐시, 같은 요청은 한 번만. 실제로 부르면 stats.live를 센다. */
async function callPage(service: Service, op: string, params: Record<string, string>, stats: { live: number }): Promise<Page> {
  const id = `${service}/${op}?${new URLSearchParams(Object.entries(params).sort(([a], [b]) => (a < b ? -1 : 1))).toString()}`;
  const c = loadCache();
  const hit = c.entries[id];
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { items: hit.items, total: hit.total ?? null };
  const running = inflight.get(id);
  if (running) return running;
  stats.live += 1;
  const task = callLive(service, op, params).then((page) => {
    c.entries[id] = { at: Date.now(), items: page.items, total: page.total };
    scheduleSave();
    return page;
  });
  inflight.set(id, task);
  try {
    return await task;
  } finally {
    inflight.delete(id);
  }
}

async function call(service: Service, op: string, params: Record<string, string>, stats: { live: number }): Promise<Record<string, unknown>[]> {
  return (await callPage(service, op, params, stats)).items;
}

/**
 * 여러 쪽을 받는다 — rows건씩 1쪽부터, 받은 건이 rows보다 적거나 전체 건수(totalCount)에 닿거나 maxPages쪽이면 멈춘다. 쪽마다 캐시.
 * 1쪽이 실패하면 throw. 다음 쪽이 실패하면(시간 초과 · 한도 · 응답 오류) 그때까지 받은 항목과 그 오류(error)를 돌려준다 — 받은 쪽의 사진은
 * 쓰고 오류는 알린다(군산근대역사박물관 115건은 2쪽까지 — 2쪽이 실패해도 1쪽 100장은 쓴다).
 */
async function callPages(
  service: Service,
  op: string,
  params: Record<string, string>,
  stats: { live: number },
  rows: number,
  maxPages: number,
): Promise<{ items: Record<string, unknown>[]; error?: unknown }> {
  const items: Record<string, unknown>[] = [];
  for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
    let page: Page;
    try {
      page = await callPage(service, op, { ...params, numOfRows: String(rows), pageNo: String(pageNo) }, stats);
    } catch (err) {
      if (pageNo === 1) throw err;
      return { items, error: err };
    }
    items.push(...page.items);
    if (page.items.length < rows || (page.total !== null && pageNo * rows >= page.total)) break;
  }
  return { items };
}

function remember(src: string | null, title: string, type1: boolean): void {
  if (!src) return;
  const c = loadCache();
  const before = c.photos[src];
  if (before && before.title === title && before.type1 === type1) return;
  c.photos[src] = { title, type1 };
  scheduleSave();
}

/** 받은 적 있는 관광공사 사진이면 그 장소 제목과 제1유형 여부 — 사진 저장(server/index.ts)이 유형을 다시 보고 사람 낱말 검사에서 장소 이름을 뗀다. */
export function tourPhotoInfo(src: string): PhotoInfo | null {
  return loadCache().photos[src] ?? null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

function noteOf(err: unknown): { note: string; error: TourApiErrorCode } {
  if (err instanceof TourApiError) return { note: err.message, error: err.code };
  console.warn('[tourapi] 예상하지 못한 오류', scrubTourKey(err instanceof Error ? err.message : String(err)));
  return { note: 'TourAPI를 읽다가 오류가 났어요.', error: 'UPSTREAM' };
}

/** 국문 관광정보가 이 오류로 끝나면 관광사진 정보도 부르지 않는다 — 키는 두 서비스에 같고, 시간 초과면 또 10초를 기다리게 된다. */
const SKIP_GALLERY_AFTER: ReadonlySet<TourApiErrorCode> = new Set(['KEY', 'NO_KEY', 'TIMEOUT']);

/**
 * 장소 하나의 관광공사 사진 — 사이트 이름 → 다른 이름으로 키워드 검색(주소가 브랜드 지역이고 제목이 맞는 곳), 없으면 이름 끝의 종류
 * 낱말을 뗀 낱말로 키워드 검색(이름이 비슷한 곳 — 장소 페이지 좌표가 있으면 그 근처), 없으면 장소 페이지 좌표 근처(1km)에서 이름이 비슷한
 * 곳. 찾으면 상세 사진의 제1유형만, 그 사진이 GALLERY_WHEN_FEWER장보다 적으면 관광사진 정보도(촬영지 · 제목 · 사람 낱말 확인). 지역은
 * 브랜드 지역과 장소 주소를 합쳐 정하고(광역시 · 도까지 — 「중구」만으로는 찾지 않는다), 둘이 어긋나면 찾지 않는다. 서비스 오류는 결과의
 * note · error로 돌려주고(다른 서비스 결과는 그대로) 던지지 않는다 — 키가 없을 때만 TourApiError('NO_KEY'). liveCalls는 이번에 실제로
 * 부른 횟수(캐시 · 같은 요청 기다림은 세지 않는다).
 */
export async function findTourPhotos(q: TourPhotoQuery, brandRegion: string): Promise<TourPhotoResult> {
  if (!tourApiConfigured()) throw new TourApiError('NO_KEY', '이 PC에 관광공사 TourAPI 키가 없어요.');
  const brand = tourRegionOf(brandRegion);
  const placeAt = tourRegionOf(q.address);
  const empty = { place: q.place, resolved: null, photos: [], rejectedType: 0, rejectedGallery: 0, liveCalls: 0 };
  if (brand && placeAt && !regionsAgree(brand, placeAt)) {
    return {
      ...empty,
      city: regionLabel(brand),
      note: `장소 주소의 도시(${regionLabel(placeAt)})가 브랜드 지역(${regionLabel(brand)})과 달라 관광공사 사진을 찾지 않았어요.`,
    };
  }
  const merged = brand && placeAt ? { province: brand.province ?? placeAt.province, city: brand.city ?? placeAt.city } : (brand ?? placeAt);
  if (!knownRegion(merged)) {
    return { ...empty, city: null, note: '브랜드 지역이나 장소 주소에서 도시(광역시 · 도까지)를 정하지 못해 관광공사 사진을 찾지 않았어요.' };
  }
  const region = merged;
  const city = regionLabel(region);
  const names = [...new Map([q.place, ...(q.names ?? [])].map((n) => [placeKey(n), normSlotAlt(n)] as const)).entries()]
    .filter(([k]) => k.length >= 3)
    .map(([, n]) => n)
    .slice(0, 4);
  if (!names.length) return { ...empty, city, note: '장소 이름이 너무 짧아 관광공사 사진을 찾지 않았어요.' };

  const stats = { live: 0 };
  const notes: string[] = [];
  let error: TourApiErrorCode | undefined;
  const fail = (err: unknown): TourApiErrorCode => {
    const n = noteOf(err);
    if (!notes.includes(n.note)) notes.push(n.note);
    error ??= n.error;
    return n.error;
  };
  const at = q.lat !== undefined && q.lng !== undefined ? { lat: q.lat, lng: q.lng } : null;

  let resolved: TourPlace | null = null;
  let first: Record<string, unknown> | null = null;
  let kor: { photos: TourPhoto[]; rejected: number } = { photos: [], rejected: 0 };
  let korError: TourApiErrorCode | null = null;
  const firstOf = (items: Record<string, unknown>[], place: TourPlace) => items.find((it) => str(it.contentid) === place.contentId) ?? null;
  try {
    for (const keyword of names.slice(0, 3)) {
      const items = await call('KorService2', 'searchKeyword2', { keyword }, stats);
      resolved = pickTourPlace(items, names, region);
      if (resolved) {
        first = firstOf(items, resolved);
        break;
      }
    }
    // 이름이 다른 곳(「진포해양공원」 ↔ 「진포해양테마공원」) — 끝말을 뗀 낱말 하나로. 좌표 검색은 그 장소를 돌려주지 않을 때가 있다.
    const stem = resolved ? undefined : tourStemKeywords(names)[0];
    if (stem) {
      const items = await call('KorService2', 'searchKeyword2', { keyword: stem }, stats);
      resolved = pickTourPlace(items, names, region, { mode: 'stem', ...(at ? { at } : {}) });
      if (resolved) first = firstOf(items, resolved);
    }
    if (!resolved && at) {
      const items = await call('KorService2', 'locationBasedList2', { mapX: at.lng.toFixed(7), mapY: at.lat.toFixed(7), radius: '1000', arrange: 'E' }, stats);
      resolved = pickTourPlace(items, names, region, { mode: 'near' });
      if (resolved) first = firstOf(items, resolved);
    }
    if (resolved) {
      const images = await call('KorService2', 'detailImage2', { contentId: resolved.contentId, imageYN: 'Y' }, stats);
      kor = korTourPhotos(resolved, first, images, q.place, [...names, resolved.title]);
      remember(tourPhotoSrc(first?.firstimage), resolved.title, str(first?.cpyrhtDivCd) === 'Type1');
      for (const im of images) remember(tourPhotoSrc(im.originimgurl), resolved.title, str(im.cpyrhtDivCd) === 'Type1');
    }
  } catch (err) {
    korError = fail(err);
  }

  let gallery: { photos: TourPhoto[]; rejected: number } = { photos: [], rejected: 0 };
  if (kor.photos.length < GALLERY_WHEN_FEWER && !(korError && SKIP_GALLERY_AFTER.has(korError))) {
    const allNames = resolved ? [...names, resolved.title] : names;
    const keywords = [...new Set([resolved?.title, names[0]].filter((k): k is string => Boolean(k)))];
    try {
      for (const keyword of keywords) {
        const pages = await callPages('PhotoGalleryService1', 'gallerySearchList1', { keyword }, stats, GALLERY_ROWS, GALLERY_PAGES);
        gallery = galleryTourPhotos(pages.items, q.place, allNames, region);
        for (const p of gallery.photos) remember(p.src, p.title, true);
        if (pages.error !== undefined) {
          fail(pages.error);
          break;
        }
        if (gallery.photos.length) break;
      }
    } catch (err) {
      fail(err);
    }
  }

  const photos = [...kor.photos, ...gallery.photos.filter((g) => !kor.photos.some((k) => k.src === g.src))];
  if (!photos.length && !notes.length) {
    notes.push(
      resolved
        ? `「${resolved.title}」에 공공누리 제1유형 사진이 없어요${kor.rejected ? `(제1유형이 아닌 사진 ${kor.rejected}장)` : ''}.`
        : `관광공사 자료에서 ${city}의 「${q.place}」를 찾지 못했어요.`,
    );
  }
  return {
    place: q.place,
    city,
    resolved,
    photos,
    rejectedType: kor.rejected,
    rejectedGallery: gallery.rejected,
    ...(notes.length ? { note: notes.join(' ') } : {}),
    ...(error ? { error } : {}),
    liveCalls: stats.live,
  };
}
