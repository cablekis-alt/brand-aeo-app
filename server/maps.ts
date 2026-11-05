import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PIPELINE_DATA_DIR } from './appPaths.js';
import { frameFor, MAP_HEIGHT, MAP_WIDTH, type FrameSide } from './mapFrame.js';
import { pngSize, type ParentPortLike } from './screens.js';
import { writeJsonAtomic } from './tenantWriteQueue.js';
import {
  MAP_AVOID_TEXT,
  MAP_MAX_MARKERS,
  MAP_STYLE_VERSION,
  isMapImageId,
  mapAltOf,
  mapAppSrc,
  mapCaptionOf,
  mapMarkerOf,
  mapVariantIds,
  mapVariantKey,
  parseMapAppSrc,
  type MapMarker,
  type MapPointsFile,
} from '../src/lib/mapImage.js';
import type { PhotoPick } from '../src/lib/articlePhotos.js';
import type { ScreenProfile } from '../src/lib/screenCapture.js';

/**
 * 군산 지도 그림의 서버 쪽 — 장소 묶음(장소 id들)으로 틀을 정해(server/mapFrame.ts) 메인 프로세스에 그리기를 맡기고(electron/mapRender.cjs —
 * capture.cjs relayCaptureRequests의 'map-render'), 그린 PNG를 PIPELINE_DATA_DIR/<tenant>/maps/<id>.png + maps.json에 저장한다.
 *
 * 서버는 패키징 앱에서 utilityProcess로 돌아 창을 띄울 수 없다 — 자사 화면 찍기(server/screens.ts)와 같은 parentPort 다리를 쓴다. parentPort가
 * 없으면(vite dev의 tsx 서버 · 웹 · 검증 스크립트) 그릴 수 없고(/api/health maps false), 그려 둔 지도는 그대로 쓴다.
 *
 * 메시지(같은 parentPort를 화면 찍기 · set-env도 쓴다 — type으로 가른다):
 *   서버 → 메인 { type: 'map-render', id, spec: { width, height, center, zoom, markers:[{lng,lat,kind,label}], areaLabels, legend } }
 *   메인 → 서버 { type: 'map-render-result', id, ok: true, png(base64), width, height, bounds, zoom, labels, areaLabels, renderer, timings }
 *              { type: 'map-render-result', id, ok: false, code, message }
 *
 * 좌표 · 이름은 서버가 저장한 장소 목록(server/mapPoints.ts)에서만 찾는다 — 화면은 장소 id만 보낸다. 지도 id(그림 이름)는 그리기 요청 ·
 * 그림 판(MAP_STYLE_VERSION) · 장소 목록 판의 해시다(픽셀 해시가 아니다 — GPU마다 픽셀이 조금 다르다). 같은 장소 묶음 · 같은 판이면 다시
 * 그리지 않는다.
 */

const LIST_FILE = 'maps.json';
/** 지도 PNG 한 장의 최대 크기 — 실측 0.25~0.95MB. */
const MAX_MAP_PNG_BYTES = 8 * 1024 * 1024;
/** 메인의 그리기 한도(기본 20초) + 강제 종료 여유 5초 + 답 여유 15초 + 앞선 화면 찍기 하나(최대 57초)를 기다릴 여유. */
const MAP_REPLY_WAIT_MS = 100_000;
const MAX_QUEUE = 20;
/** 메인이 받는 줌 범위(electron/mapRender.cjs MIN_ZOOM · MAX_ZOOM). 이보다 넓은 묶음은 한 장에 담지 않는다. */
const MIN_ZOOM = 10;
const MAX_ZOOM = 17;

/**
 * 그리기 실패 — code는 메인의 코드(avoid-area · out-of-cover · timeout · blank …) 또는 unavailable · busy · bad-png · unknown-point ·
 * no-markers · base-in-frame · too-wide · failed.
 */
export class MapRenderError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** 그리기 실패를 HTTP 상태로 — 쓸 수 없음 503 · 줄이 가득 참 429 · 시간 초과 504 · 요청 · 장소 문제 400 · 틀을 만들 수 없음 422 · 그 밖 502. */
export function mapErrorStatus(code: string): number {
  if (code === 'unavailable' || code === 'disposed') return 503;
  if (code === 'busy') return 429;
  if (code === 'timeout') return 504;
  if (code === 'unknown-point' || code === 'bad-request') return 400;
  if (code === 'no-markers' || code === 'base-in-frame' || code === 'too-wide' || code === 'avoid-area' || code === 'out-of-cover') return 422;
  return 502;
}

export const MAP_UNAVAILABLE_MESSAGE = '이 실행에서는 지도를 그릴 수 없어요 — 지도는 설치한 데스크톱 앱에서만 그립니다(웹 · 개발 서버는 그려 둔 지도만 보여요).';

// ── 메인 프로세스에 맡기는 다리 ─────────────────────────────────────────────

/** 메인에 보내는 그리기 요청(electron/mapRender.cjs validateMapSpec). */
export interface MapRenderSpec {
  width: number;
  height: number;
  center: [number, number];
  zoom: number;
  markers: { lng: number; lat: number; kind: string; label: string }[];
  areaLabels: boolean;
  legend: boolean;
}

export interface RenderedMap {
  png: Buffer;
  /** 그림에 넣지 못한(겹친) 이름. */
  labelsDropped: string[];
  /** 그린 동 · 섬 · 호수 이름. */
  areaLabels: string[];
  renderer: string;
}

export interface MapBridge {
  readonly available: boolean;
  render(spec: MapRenderSpec): Promise<RenderedMap>;
}

const UNAVAILABLE_BRIDGE: MapBridge = {
  available: false,
  render: () => Promise.reject(new MapRenderError('unavailable', MAP_UNAVAILABLE_MESSAGE)),
};

const REPLY_CODE = /^[a-z][a-z-]{0,39}$/;
const MAX_PNG_BASE64 = Math.ceil(MAX_MAP_PNG_BYTES / 3) * 4 + 4;
const strings = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max).map((x) => x.slice(0, 60)) : []);

/**
 * parentPort로 메인에 그리기를 맡기는 다리. port가 없으면 쓸 수 없는 다리(available false — 그리기는 unavailable로 거부). 한 번에 한 장 —
 * 앞 요청의 답(또는 시간 초과) 뒤에 다음 요청을 보낸다. 줄이 maxQueue를 넘으면 busy. 늦게 온 답 · 모르는 id · 다른 type은 버린다.
 */
export function createMapBridge(port: ParentPortLike | null | undefined, opts: { waitMs?: () => number; maxQueue?: number } = {}): MapBridge {
  if (!port) return UNAVAILABLE_BRIDGE;
  const waitMs = opts.waitMs ?? (() => MAP_REPLY_WAIT_MS);
  const maxQueue = opts.maxQueue ?? MAX_QUEUE;
  const pending = new Map<string, { resolve: (v: RenderedMap) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  port.on('message', (event) => {
    const msg = event?.data;
    if (!msg || typeof msg !== 'object') return;
    const m = msg as Record<string, unknown>;
    if (m.type !== 'map-render-result' || typeof m.id !== 'string') return;
    const waiting = pending.get(m.id);
    if (!waiting) return; // 시간 초과 뒤 늦게 온 답 · 모르는 id
    pending.delete(m.id);
    clearTimeout(waiting.timer);
    if (m.ok === true && typeof m.png === 'string' && m.png.length <= MAX_PNG_BASE64) {
      const labels = (m.labels && typeof m.labels === 'object' ? m.labels : {}) as { dropped?: unknown };
      waiting.resolve({
        png: Buffer.from(m.png, 'base64'),
        labelsDropped: strings(labels.dropped, MAP_MAX_MARKERS),
        areaLabels: strings(m.areaLabels, 8),
        renderer: typeof m.renderer === 'string' ? m.renderer.slice(0, 200) : '',
      });
      return;
    }
    const code = m.ok === true ? 'bad-png' : typeof m.code === 'string' && REPLY_CODE.test(m.code) ? m.code : 'failed';
    const message = typeof m.message === 'string' && m.message ? m.message.slice(0, 300) : '지도를 그리지 못했어요.';
    waiting.reject(new MapRenderError(code, message));
  });

  const send = (spec: MapRenderSpec) =>
    new Promise<RenderedMap>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new MapRenderError('timeout', '앱이 지도를 그리는 동안 답이 오지 않았어요.'));
      }, waitMs());
      pending.set(id, { resolve, reject, timer });
      try {
        port.postMessage({ type: 'map-render', id, spec });
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new MapRenderError('unavailable', `앱에 지도 그리기를 맡기지 못했어요 — ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  let tail: Promise<unknown> = Promise.resolve();
  let queued = 0;
  return {
    available: true,
    render(spec) {
      if (queued >= maxQueue) return Promise.reject(new MapRenderError('busy', '그릴 지도가 너무 많이 밀려 있어요. 잠시 뒤에 다시 해 주세요.'));
      queued += 1;
      const job = tail.then(() => send(spec));
      const release = () => {
        queued -= 1;
      };
      // 사슬은 순서만 지킨다 — 성공 · 실패는 job을 받은 호출자가 처리한다.
      tail = job.then(release, release);
      return job;
    },
  };
}

let defaultBridge: MapBridge | null = null;

/** 이 프로세스의 다리 — 패키징 앱의 utilityProcess면 process.parentPort, 아니면 쓸 수 없는 다리. */
export function mapBridge(): MapBridge {
  defaultBridge ??= createMapBridge((process as unknown as { parentPort?: ParentPortLike }).parentPort);
  return defaultBridge;
}

/** 이 서버에서 지도를 그릴 수 있는가(/api/health maps). */
export function mapRenderAvailable(): boolean {
  return mapBridge().available;
}

// ── 저장 ──────────────────────────────────────────────────────────────────

/** 그린 지도 한 장(maps.json). markers는 실제로 그린 표지(공군기지 쪽에서 뺀 표지는 dropped). */
export interface MapImageRecord {
  /** 그림 이름(sha256 앞 16자) — 그리기 요청 · 그림 판 · 장소 목록 판의 해시. */
  id: string;
  /** 청한 장소 묶음의 변형 열쇠(src/lib/mapImage.ts mapVariantKey) — 뺀 표지가 있어도 청한 묶음 그대로. */
  variant: string;
  markers: MapMarker[];
  dropped: { id: string; name: string; why: 'avoid' | 'base' }[];
  center: [number, number];
  zoom: number;
  bounds: [number, number, number, number];
  side: FrameSide;
  shiftPx: number;
  pointsVersion: string;
  styleVersion: string;
  /** 장소 목록 출처(자사 사이트 /map/). */
  source: string;
  drawnAt: string;
  width: number;
  height: number;
  bytes: number;
  labelsDropped?: string[];
  renderer?: string;
}

/** 목록 · 그리기 응답에 나가는 모양 — 앱 주소 · 대체 텍스트(「군산 지도 — … 위치」) · 위치 문장을 붙인다. */
export interface MapImageView extends MapImageRecord {
  src: string;
  alt: string;
  caption: string;
}

/** 브랜드의 지도 폴더 — 브랜드 id에 경로 글자가 있거나 데이터 폴더 밖으로 나가면 throw. */
export function mapsDir(tenantId: string): string {
  if (!tenantId || /[/\\]/.test(tenantId) || tenantId === '.' || tenantId === '..') throw new RangeError(`잘못된 브랜드 id: ${tenantId}`);
  const root = path.resolve(PIPELINE_DATA_DIR);
  const dir = path.resolve(root, tenantId, 'maps');
  if (path.relative(root, dir) !== path.join(tenantId, 'maps')) throw new RangeError(`잘못된 브랜드 id: ${tenantId}`);
  return dir;
}

function validRecord(v: unknown): v is MapImageRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
  const int = (x: unknown) => typeof x === 'number' && Number.isInteger(x) && x > 0;
  return (
    isMapImageId(r.id) &&
    mapVariantIds(r.variant) !== null &&
    Array.isArray(r.markers) &&
    r.markers.length > 0 &&
    r.markers.every((m) => m && typeof m === 'object' && typeof (m as MapMarker).label === 'string' && typeof (m as MapMarker).id === 'string') &&
    Array.isArray(r.dropped) &&
    Array.isArray(r.center) &&
    r.center.length === 2 &&
    num(r.zoom) &&
    Array.isArray(r.bounds) &&
    r.bounds.length === 4 &&
    typeof r.pointsVersion === 'string' &&
    typeof r.styleVersion === 'string' &&
    typeof r.source === 'string' &&
    r.source.startsWith('https://') &&
    typeof r.drawnAt === 'string' &&
    Number.isFinite(Date.parse(r.drawnAt)) &&
    int(r.width) &&
    int(r.height) &&
    int(r.bytes)
  );
}

/** maps.json을 읽는다 — 없으면 []. 읽을 수 없거나 모양이 틀리면 throw(쓰는 길이 깨진 목록을 덮지 않게). */
async function loadRecords(tenantId: string): Promise<MapImageRecord[]> {
  let text: string;
  try {
    text = await readFile(path.join(mapsDir(tenantId), LIST_FILE), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const parsed = JSON.parse(text) as { maps?: unknown };
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.maps)) throw new Error(`${tenantId}/maps/${LIST_FILE}의 모양이 맞지 않습니다.`);
  return parsed.maps.filter(validRecord);
}

/** 그린 지도 목록(maps.json) — 없거나 읽을 수 없으면 [](읽을 수 없으면 알린다). 적힌 순서(오래된 것부터). */
export async function readMapImages(tenantId: string): Promise<MapImageRecord[]> {
  try {
    return await loadRecords(tenantId);
  } catch (err) {
    console.warn(`[maps] ${tenantId} 지도 목록을 읽지 못했습니다:`, err);
    return [];
  }
}

/**
 * 대체 텍스트 · 위치 문장 — 그림에 이름이 들어간 표지만(겹쳐 이름을 넣지 못한 표지 labelsDropped는 뺀다 — 독자가 그림에서 그 장소를 알아볼
 * 수 없다). 이름이 다 빠졌으면 모든 표지.
 */
export function mapTextOf(rec: Pick<MapImageRecord, 'markers' | 'labelsDropped'>): { alt: string; caption: string } {
  const dropped = rec.labelsDropped ?? [];
  const named = rec.markers.filter((m) => !dropped.includes(m.label));
  const shown = named.length ? named : rec.markers;
  return { alt: mapAltOf(shown), caption: mapCaptionOf(shown) };
}

export function mapImageView(tenantId: string, rec: MapImageRecord): MapImageView {
  return { ...rec, src: mapAppSrc(tenantId, rec.id), ...mapTextOf(rec) };
}

/** 그린 지도 파일 — 목록(maps.json)에 있는 id만. 없으면 null. */
export async function readMapFile(tenantId: string, mapId: string): Promise<Buffer | null> {
  if (!isMapImageId(mapId)) return null;
  const records = await readMapImages(tenantId);
  if (!records.some((r) => r.id === mapId)) return null;
  try {
    return await readFile(path.join(mapsDir(tenantId), `${mapId}.png`));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

const listWrites = new Map<string, Promise<unknown>>();
function updateRecords<T>(tenantId: string, task: (records: MapImageRecord[]) => T): Promise<T> {
  const prev = listWrites.get(tenantId) ?? Promise.resolve();
  const run = prev.then(async () => {
    const records = await loadRecords(tenantId);
    const result = task(records);
    await writeJsonAtomic(path.join(mapsDir(tenantId), LIST_FILE), { maps: records });
    return result;
  });
  // 앞 작업이 실패해도 다음 작업은 돈다 — 실패는 그 호출자에게만 간다.
  listWrites.set(
    tenantId,
    run.catch(() => undefined),
  );
  return run;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** 그리기 요청 — 동 · 섬 이름은 음식점이 없는 지도에만(음식점 표지는 촘촘해 이름 자리가 모자란다 — OSM 시험 g틀). */
export function mapSpecOf(markers: readonly MapMarker[], frame: { center: [number, number]; zoom: number }): MapRenderSpec {
  return {
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    center: frame.center,
    zoom: frame.zoom,
    markers: markers.map((m) => ({ lng: m.lng, lat: m.lat, kind: m.kind, label: m.label })),
    areaLabels: !markers.some((m) => m.kind === 'food'),
    legend: true,
  };
}

/** 그림 이름 — 그리기 요청 · 그림 판 · 장소 목록 판의 sha256 앞 16자. */
export function mapImageId(spec: MapRenderSpec, pointsVersion: string): string {
  return createHash('sha256').update(JSON.stringify({ spec, style: MAP_STYLE_VERSION, points: pointsVersion })).digest('hex').slice(0, 16);
}

const inflight = new Map<string, Promise<{ record: MapImageRecord; reused: boolean }>>();

/**
 * 장소 묶음 하나를 그려 저장한다. 장소는 저장한 장소 목록(pointsFile)에서만 찾고(없는 id는 unknown-point), 공군기지 상자 안 장소는 빼며,
 * 틀(frameFor)을 만들지 못하면 no-markers · base-in-frame, 줌이 메인의 범위(10~17) 밖이면 too-wide. 같은 묶음 · 같은 그림 판 · 같은 목록
 * 판으로 그려 둔 것이 있으면(파일까지) 다시 그리지 않는다(reused — 다리를 쓸 수 없어도). 같은 묶음을 그리는 중에 또 청하면 그 결과를 함께
 * 받는다. 다리를 쓸 수 없으면 unavailable, 그린 그림이 1280×800 PNG가 아니면 bad-png(아무것도 쓰지 않는다).
 */
export async function drawMapVariant(
  tenantId: string,
  profile: ScreenProfile,
  pointsFile: MapPointsFile,
  idsIn: readonly string[],
  opts: { bridge?: MapBridge; now?: () => Date } = {},
): Promise<{ record: MapImageRecord; reused: boolean }> {
  if (!profile.mapPoints) throw new MapRenderError('bad-request', '이 브랜드에는 지도 장소 목록 출처가 없어요.');
  const variant = mapVariantKey(idsIn);
  if (!idsIn.length || idsIn.length > MAP_MAX_MARKERS || mapVariantIds(variant) === null) throw new MapRenderError('bad-request', `장소 id(1~${MAP_MAX_MARKERS}곳)가 올바르지 않아요.`);
  const byId = new Map(pointsFile.points.map((p) => [p.id, p]));
  const order = [...new Set(idsIn)];
  const missing = order.filter((id) => !byId.has(id));
  if (missing.length) throw new MapRenderError('unknown-point', `자사 사이트 장소 목록에 없는 장소예요: ${missing.slice(0, 3).join(', ')}`);
  const key = `${tenantId}\n${variant}\n${pointsFile.version}`;
  const running = inflight.get(key);
  if (running) return running;
  const job = (async () => {
    const records = await readMapImages(tenantId);
    const dir = mapsDir(tenantId);
    for (const r of [...records].reverse()) {
      if (r.variant === variant && r.pointsVersion === pointsFile.version && r.styleVersion === MAP_STYLE_VERSION && (await fileExists(path.join(dir, `${r.id}.png`)))) {
        return { record: r, reused: true };
      }
    }
    const bridge = opts.bridge ?? mapBridge();
    const markers = order.map((id) => mapMarkerOf(byId.get(id)!));
    const frame = frameFor(markers);
    const dropped = frame.dropped.map((d) => ({ id: d.marker.id, name: d.marker.name, why: d.why }));
    if (!frame.ok) {
      throw new MapRenderError(
        frame.why,
        // 화면에 나가는 글 — 중립으로 쓴다(어떤 시설인지 적지 않는다, src/lib/mapImage.ts MAP_AVOID_TEXT).
        frame.why === 'no-markers' ? `${MAP_AVOID_TEXT}의 장소만 남아 지도를 그리지 않았어요.` : `${MAP_AVOID_TEXT}을 피하는 틀을 만들지 못해 지도를 그리지 않았어요.`,
      );
    }
    if (frame.zoom < MIN_ZOOM || frame.zoom > MAX_ZOOM) throw new MapRenderError('too-wide', '장소가 너무 넓게 퍼져 한 장에 담지 못했어요.');
    const spec = mapSpecOf(frame.markers, frame);
    const id = mapImageId(spec, pointsFile.version);
    if (!bridge.available) throw new MapRenderError('unavailable', MAP_UNAVAILABLE_MESSAGE);
    const rendered = await bridge.render(spec);
    const size = pngSize(rendered.png);
    if (!size || size.width !== MAP_WIDTH || size.height !== MAP_HEIGHT || rendered.png.length > MAX_MAP_PNG_BYTES) {
      throw new MapRenderError('bad-png', '그린 지도가 1280×800 PNG가 아니에요.');
    }
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${id}.png`);
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, rendered.png);
    try {
      await rename(tmp, file);
    } catch (err) {
      await unlink(tmp).catch((cleanupErr: unknown) => console.warn(`[maps] 임시 파일을 지우지 못했습니다: ${tmp}`, cleanupErr));
      throw err;
    }
    const record: MapImageRecord = {
      id,
      variant,
      markers: frame.markers,
      dropped,
      center: frame.center,
      zoom: frame.zoom,
      bounds: frame.bounds,
      side: frame.side,
      shiftPx: frame.shiftPx,
      pointsVersion: pointsFile.version,
      styleVersion: MAP_STYLE_VERSION,
      source: pointsFile.source,
      drawnAt: (opts.now ?? (() => new Date()))().toISOString(),
      width: size.width,
      height: size.height,
      bytes: rendered.png.length,
      ...(rendered.labelsDropped.length ? { labelsDropped: rendered.labelsDropped } : {}),
      ...(rendered.renderer ? { renderer: rendered.renderer } : {}),
    };
    await updateRecords(tenantId, (list) => {
      const at = list.findIndex((r) => r.id === id);
      if (at >= 0) list.splice(at, 1);
      list.push(record);
    });
    return { record, reused: false };
  })();
  inflight.set(key, job);
  try {
    return await job;
  } finally {
    if (inflight.get(key) === job) inflight.delete(key);
  }
}

/**
 * 「사진 N장 받기」 · 작성자 묶음이 받을 지도 파일(origin osm-map 사진). 앱 주소가 이 브랜드의 것이고 목록에 그 id · 장소 묶음으로 적혀
 * 있어야 한다. 없으면 'gone'.
 */
export async function mapFileForPick(tenantId: string, pick: Pick<PhotoPick, 'src' | 'origin' | 'mapId' | 'mapVariant'>): Promise<Buffer | 'gone'> {
  const ref = parseMapAppSrc(pick.src);
  if (pick.origin !== 'osm-map' || !ref || ref.tenantId !== tenantId || ref.mapId !== pick.mapId) return 'gone';
  const records = await readMapImages(tenantId);
  if (!records.some((r) => r.id === ref.mapId && r.variant === pick.mapVariant)) return 'gone';
  return (await readMapFile(tenantId, ref.mapId)) ?? 'gone';
}
