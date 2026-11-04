import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PIPELINE_DATA_DIR } from './appPaths.js';
import { writeJsonAtomic } from './tenantWriteQueue.js';
import {
  isScreenShotId,
  parseScreenAppSrc,
  screenAppSrc,
  screenOfPick,
  screenSaveAllowed,
  screenUrl,
  type ScreenDef,
  type ScreenProfile,
  type ScreenShot,
  type ScreenShotView,
  type ScreenVariant,
} from '../src/lib/screenCapture.js';
import type { PhotoPick } from '../src/lib/articlePhotos.js';

/**
 * 자사 화면 캡처의 서버 쪽 — 저장(PIPELINE_DATA_DIR/<tenant>/screens/<sha16>.png + screens.json)과 메인 프로세스에 찍기를 맡기는 다리.
 *
 * 서버는 패키징 앱에서 utilityProcess로 돌아 창을 띄울 수 없다. 그래서 process.parentPort로 메인(electron/main.cjs → electron/capture.cjs)에
 * 찍기를 청하고 PNG 바이트를 받아 여기서 쓴다(메인은 파일을 쓰지 않는다). parentPort가 없으면(vite dev의 tsx 서버 · 웹 · 검증 스크립트)
 * 찍기는 쓸 수 없고(/api/health screens false), 이미 찍어 둔 화면은 그대로 쓴다.
 *
 * 메시지(같은 parentPort를 electron/server-entry.cjs의 set-env도 쓴다 — type으로 가른다):
 *   서버 → 메인 { type: 'screen-capture', id, url, options: { host, map?, scrollTo?, hide?, activateFragmentLink?, timeoutMs? } }
 *   메인 → 서버 { type: 'screen-capture-result', id, ok: true, png(base64), width, height, url, finalUrl, waitedMs, warnings }
 *              { type: 'screen-capture-result', id, ok: false, code, message }
 * 한 번에 한 장(줄 세우기). 답이 한도 안에 오지 않으면 timeout으로 끝내고, 늦게 온 답은 버린다.
 */

const LIST_FILE = 'screens.json';
/** PNG 한 장의 최대 크기 — 1280×800 지도 화면이 약 450KB다. */
export const MAX_SCREEN_PNG_BYTES = 8 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_SIDE = 8192;

/** 캡처 모듈(electron/capture.cjs)과 같은 한도 — 기본 25초 · 최대 45초를 기다리고, 그 뒤 찍기 · 검사에 12초를 더 준다. */
const CAPTURE_DEFAULT_TIMEOUT_MS = 25000;
const CAPTURE_MIN_TIMEOUT_MS = 5000;
const CAPTURE_MAX_TIMEOUT_MS = 45000;
const CAPTURE_HARD_GRACE_MS = 12000;
/** 메인의 강제 종료 뒤에도 답을 더 기다리는 시간(메시지 · 인코딩 여유). */
const REPLY_GRACE_MS = 15000;
const MAX_QUEUE = 20;

/** 찍기 실패 — code는 캡처 모듈의 코드(kogl-image · timeout …) 또는 unavailable · busy · bad-png · failed. */
export class ScreenCaptureError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** 찍기 실패를 HTTP 상태로 — 쓸 수 없음 503 · 줄이 가득 참 429 · 시간 초과 504 · 그 밖(페이지 · 그림 검사)은 502. */
export function captureErrorStatus(code: string): number {
  if (code === 'unavailable' || code === 'disposed') return 503;
  if (code === 'busy') return 429;
  if (code === 'timeout') return 504;
  return 502;
}

// ── 메인 프로세스에 맡기는 다리 ─────────────────────────────────────────────

/** 캡처 모듈 옵션(electron/capture.cjs captureScreen) — 프로필에서만 만든다. */
export interface ScreenCaptureOptions {
  host: string;
  map?: true;
  scrollTo?: string;
  hide?: string[];
  activateFragmentLink?: true;
  timeoutMs?: number;
}

export interface ScreenCaptureRequest {
  url: string;
  options: ScreenCaptureOptions;
}

export interface CapturedPng {
  png: Buffer;
  finalUrl: string;
  warnings: string[];
}

/** Electron utilityProcess의 process.parentPort에서 쓰는 만큼(검증에서는 가짜를 넣는다). */
export interface ParentPortLike {
  on(event: 'message', listener: (event: { data?: unknown }) => void): unknown;
  postMessage(message: unknown): void;
}

export interface CaptureBridge {
  readonly available: boolean;
  capture(req: ScreenCaptureRequest): Promise<CapturedPng>;
}

/** 요청 하나의 답을 기다리는 시간 — 캡처 한도 + 강제 종료 여유 + 답 여유. */
export function replyWaitMs(options: Pick<ScreenCaptureOptions, 'timeoutMs'>): number {
  const asked = Number(options.timeoutMs);
  const limit = Number.isFinite(asked) && asked > 0 ? Math.min(Math.max(asked, CAPTURE_MIN_TIMEOUT_MS), CAPTURE_MAX_TIMEOUT_MS) : CAPTURE_DEFAULT_TIMEOUT_MS;
  return limit + CAPTURE_HARD_GRACE_MS + REPLY_GRACE_MS;
}

const UNAVAILABLE_MESSAGE = '이 실행에서는 화면을 찍을 수 없어요 — 설치한 데스크톱 앱에서만 찍습니다.';

const UNAVAILABLE_BRIDGE: CaptureBridge = {
  available: false,
  capture: () => Promise.reject(new ScreenCaptureError('unavailable', UNAVAILABLE_MESSAGE)),
};

const REPLY_CODE = /^[a-z][a-z-]{0,39}$/;
/** base64로 오는 PNG 글자 수의 상한. */
const MAX_PNG_BASE64 = Math.ceil(MAX_SCREEN_PNG_BYTES / 3) * 4 + 4;

/**
 * parentPort로 메인에 찍기를 맡기는 다리. port가 없으면 쓸 수 없는 다리(available false — 찍기는 unavailable로 거부).
 * 한 번에 한 장 — 앞 요청의 답(또는 시간 초과) 뒤에 다음 요청을 보낸다. 줄이 maxQueue를 넘으면 busy.
 */
export function createCaptureBridge(
  port: ParentPortLike | null | undefined,
  opts: { waitMs?: (req: ScreenCaptureRequest) => number; maxQueue?: number } = {},
): CaptureBridge {
  if (!port) return UNAVAILABLE_BRIDGE;
  const waitMs = opts.waitMs ?? ((req: ScreenCaptureRequest) => replyWaitMs(req.options));
  const maxQueue = opts.maxQueue ?? MAX_QUEUE;
  const pending = new Map<string, { resolve: (v: CapturedPng) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  port.on('message', (event) => {
    const msg = event?.data;
    if (!msg || typeof msg !== 'object') return;
    const m = msg as Record<string, unknown>;
    if (m.type !== 'screen-capture-result' || typeof m.id !== 'string') return;
    const waiting = pending.get(m.id);
    if (!waiting) return; // 시간 초과 뒤 늦게 온 답 · 모르는 id
    pending.delete(m.id);
    clearTimeout(waiting.timer);
    if (m.ok === true && typeof m.png === 'string' && m.png.length <= MAX_PNG_BASE64) {
      waiting.resolve({
        png: Buffer.from(m.png, 'base64'),
        finalUrl: typeof m.finalUrl === 'string' ? m.finalUrl.slice(0, 2048) : '',
        warnings: Array.isArray(m.warnings) ? m.warnings.filter((w): w is string => typeof w === 'string').slice(0, 20) : [],
      });
      return;
    }
    const code = m.ok === true ? 'bad-png' : typeof m.code === 'string' && REPLY_CODE.test(m.code) ? m.code : 'failed';
    const message = typeof m.message === 'string' && m.message ? m.message.slice(0, 300) : '화면을 찍지 못했어요.';
    waiting.reject(new ScreenCaptureError(code, message));
  });

  const send = (req: ScreenCaptureRequest) =>
    new Promise<CapturedPng>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new ScreenCaptureError('timeout', '앱이 화면을 찍는 동안 답이 오지 않았어요.'));
      }, waitMs(req));
      pending.set(id, { resolve, reject, timer });
      try {
        port.postMessage({ type: 'screen-capture', id, url: req.url, options: req.options });
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new ScreenCaptureError('unavailable', `앱에 찍기를 맡기지 못했어요 — ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  let tail: Promise<unknown> = Promise.resolve();
  let queued = 0;
  return {
    available: true,
    capture(req) {
      if (queued >= maxQueue) return Promise.reject(new ScreenCaptureError('busy', '찍을 화면이 너무 많이 밀려 있어요. 잠시 뒤에 다시 해 주세요.'));
      queued += 1;
      const job = tail.then(() => send(req));
      const release = () => {
        queued -= 1;
      };
      // 사슬은 순서만 지킨다 — 성공 · 실패는 job을 받은 호출자가 처리한다.
      tail = job.then(release, release);
      return job;
    },
  };
}

let defaultBridge: CaptureBridge | null = null;

/** 이 프로세스의 다리 — 패키징 앱의 utilityProcess면 process.parentPort, 아니면 쓸 수 없는 다리. */
export function captureBridge(): CaptureBridge {
  defaultBridge ??= createCaptureBridge((process as unknown as { parentPort?: ParentPortLike }).parentPort);
  return defaultBridge;
}

/** 이 서버에서 화면을 찍을 수 있는가(/api/health screens). */
export function screenCaptureAvailable(): boolean {
  return captureBridge().available;
}

// ── 저장 ──────────────────────────────────────────────────────────────────

/** 브랜드의 화면 폴더 — 브랜드 id에 경로 글자가 있거나 데이터 폴더 밖으로 나가면 throw. */
export function screensDir(tenantId: string): string {
  if (!tenantId || /[/\\]/.test(tenantId) || tenantId === '.' || tenantId === '..') throw new RangeError(`잘못된 브랜드 id: ${tenantId}`);
  const root = path.resolve(PIPELINE_DATA_DIR);
  const dir = path.resolve(root, tenantId, 'screens');
  if (path.relative(root, dir) !== path.join(tenantId, 'screens')) throw new RangeError(`잘못된 브랜드 id: ${tenantId}`);
  return dir;
}

/** PNG의 가로 · 세로(IHDR) — PNG가 아니거나 크기가 맞지 않으면 null. */
export function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 33 || !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  return width > 0 && height > 0 && width <= MAX_SIDE && height <= MAX_SIDE ? { width, height } : null;
}

/** 한국 날짜(YYYY-MM-DD) — 같은 날 다시 쓰기의 「같은 날」. */
export function kstDay(at: Date): string {
  return new Date(at.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function validShot(v: unknown): v is ScreenShot {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  const text = (x: unknown, max: number) => typeof x === 'string' && x.length > 0 && x.length <= max;
  const int = (x: unknown) => typeof x === 'number' && Number.isInteger(x) && x > 0;
  return (
    isScreenShotId(s.sha16) &&
    text(s.screenId, 60) &&
    text(s.variantId, 60) &&
    text(s.url, 2048) &&
    String(s.url).startsWith('https://') &&
    text(s.capturedAt, 40) &&
    Number.isFinite(Date.parse(String(s.capturedAt))) &&
    int(s.width) &&
    int(s.height) &&
    int(s.bytes)
  );
}

/** screens.json을 읽는다 — 없으면 []. 읽을 수 없거나 모양이 틀리면 throw(쓰는 길이 깨진 목록을 덮지 않게). */
async function loadShots(tenantId: string): Promise<ScreenShot[]> {
  let text: string;
  try {
    text = await readFile(path.join(screensDir(tenantId), LIST_FILE), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const parsed = JSON.parse(text) as { shots?: unknown };
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.shots)) throw new Error(`${tenantId}/screens/${LIST_FILE}의 모양이 맞지 않습니다.`);
  return parsed.shots.filter(validShot);
}

/** 찍어 둔 화면 목록(screens.json) — 없거나 읽을 수 없으면 [](읽을 수 없으면 알린다). 적힌 순서(오래된 것부터). */
export async function readScreenShots(tenantId: string): Promise<ScreenShot[]> {
  try {
    return await loadShots(tenantId);
  } catch (err) {
    console.warn(`[screens] ${tenantId} 화면 목록을 읽지 못했습니다:`, err);
    return [];
  }
}

/** 목록 · 찍기 응답에 나가는 모양 — id(= sha16)와 앱 주소를 붙인다. */
export function screenShotView(tenantId: string, shot: ScreenShot): ScreenShotView {
  return { ...shot, id: shot.sha16, src: screenAppSrc(tenantId, shot.sha16) };
}

/** 찍은 화면 파일 — 목록(screens.json)에 있는 id만. 없으면 null. */
export async function readScreenFile(tenantId: string, shotId: string): Promise<Buffer | null> {
  if (!isScreenShotId(shotId)) return null;
  const shots = await readScreenShots(tenantId);
  if (!shots.some((s) => s.sha16 === shotId)) return null;
  try {
    return await readFile(path.join(screensDir(tenantId), `${shotId}.png`));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** screens.json 쓰기를 브랜드마다 줄 세운다(drafts.json의 updateDrafts와 같은 방식 — 한 프로세스 안에서만). */
const listWrites = new Map<string, Promise<unknown>>();
function updateShots<T>(tenantId: string, task: (shots: ScreenShot[]) => T): Promise<T> {
  const prev = listWrites.get(tenantId) ?? Promise.resolve();
  const run = prev.then(async () => {
    const shots = await loadShots(tenantId);
    const result = task(shots);
    await writeJsonAtomic(path.join(screensDir(tenantId), LIST_FILE), { shots });
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

/** 한 화면 · 변형 — 프로필 · 화면 · 변형. */
export interface ScreenTarget {
  profile: ScreenProfile;
  screen: ScreenDef;
  variant: ScreenVariant;
}

/** 캡처 모듈에 넘길 옵션 — 프로필에서만 만든다(화면이 보낸 값은 쓰지 않는다). */
export function screenCaptureOptions(target: ScreenTarget): ScreenCaptureOptions {
  const { profile, screen, variant } = target;
  return {
    host: profile.host,
    ...(screen.map ? { map: true as const } : {}),
    ...(variant.scrollTo ? { scrollTo: variant.scrollTo } : {}),
    ...(screen.hide?.length ? { hide: [...screen.hide] } : {}),
    ...(variant.activateFragmentLink ? { activateFragmentLink: true as const } : {}),
  };
}

/**
 * 찍은 PNG를 저장한다 — <sha16>.png(이미 있으면 그대로)와 screens.json 한 줄. 같은 화면 · 변형의 같은 그림이 이미 적혀 있으면 새 줄을
 * 더하지 않고 찍은 때 · 주소만 새로 적는다. PNG가 아니거나 크면 bad-png(아무것도 쓰지 않는다).
 */
export async function storeScreenShot(tenantId: string, target: ScreenTarget, url: string, png: Buffer, at: Date): Promise<ScreenShot> {
  const size = pngSize(png);
  if (!size || png.length > MAX_SCREEN_PNG_BYTES) throw new ScreenCaptureError('bad-png', '찍은 그림이 PNG가 아니거나 너무 커요.');
  const sha16 = createHash('sha256').update(png).digest('hex').slice(0, 16);
  const dir = screensDir(tenantId);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sha16}.png`);
  if (!(await fileExists(file))) {
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, png);
    try {
      await rename(tmp, file);
    } catch (err) {
      await unlink(tmp).catch((cleanupErr: unknown) => console.warn(`[screens] 임시 파일을 지우지 못했습니다: ${tmp}`, cleanupErr));
      // 같은 그림을 그사이 다른 요청이 먼저 썼으면 그대로 쓴다(내용이 같다).
      if (!(await fileExists(file))) throw err;
    }
  }
  const shot: ScreenShot = {
    sha16,
    screenId: target.screen.id,
    variantId: target.variant.id,
    url,
    capturedAt: at.toISOString(),
    width: size.width,
    height: size.height,
    bytes: png.length,
  };
  return updateShots(tenantId, (shots) => {
    const same = shots.findIndex((s) => s.sha16 === sha16 && s.screenId === shot.screenId && s.variantId === shot.variantId);
    if (same >= 0) shots.splice(same, 1);
    shots.push(shot);
    return shot;
  });
}

/** 오늘(KST) 같은 주소로 찍어 둔 그 화면 · 변형 — 가장 늦게 찍은 것. 파일이 없으면 보지 않는다. */
async function sameDayShot(tenantId: string, target: ScreenTarget, url: string, now: Date): Promise<ScreenShot | null> {
  const today = kstDay(now);
  const shots = (await readScreenShots(tenantId))
    .filter((s) => s.screenId === target.screen.id && s.variantId === target.variant.id && s.url === url && kstDay(new Date(s.capturedAt)) === today)
    .sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
  for (const s of shots) if (await fileExists(path.join(screensDir(tenantId), `${s.sha16}.png`))) return s;
  return null;
}

const inflight = new Map<string, Promise<{ shot: ScreenShot; reused: boolean }>>();

/**
 * 화면 · 변형 한 장을 찍어 저장한다. 오늘(KST) 같은 주소로 찍어 둔 것이 있으면 다시 찍지 않고 그것을 준다(reused — 다리를 쓸 수 없어도).
 * 같은 화면 · 변형을 찍는 중에 또 청하면 그 결과를 함께 받는다. 다리를 쓸 수 없으면 unavailable.
 */
export async function captureScreenShot(
  tenantId: string,
  target: ScreenTarget,
  opts: { bridge?: CaptureBridge; now?: () => Date } = {},
): Promise<{ shot: ScreenShot; reused: boolean }> {
  const bridge = opts.bridge ?? captureBridge();
  const now = opts.now ?? (() => new Date());
  const url = screenUrl(target.profile, target.variant);
  const key = `${tenantId}\n${target.screen.id}\n${target.variant.id}`;
  const running = inflight.get(key);
  if (running) return running;
  const job = (async () => {
    const today = await sameDayShot(tenantId, target, url, now());
    if (today) return { shot: today, reused: true };
    if (!bridge.available) throw new ScreenCaptureError('unavailable', UNAVAILABLE_MESSAGE);
    const captured = await bridge.capture({ url, options: screenCaptureOptions(target) });
    return { shot: await storeScreenShot(tenantId, target, url, captured.png, now()), reused: false };
  })();
  inflight.set(key, job);
  try {
    return await job;
  } finally {
    if (inflight.get(key) === job) inflight.delete(key);
  }
}

/**
 * 「사진 N장 받기」 · 작성자 묶음이 받을 자사 화면 파일(origin screen 사진). 앱 주소가 이 브랜드의 것이고 목록에 그 화면 · 변형으로 적혀
 * 있어야 한다. 지금 저장하지 않는 종류(SCREEN_AUTO_SAVE_KINDS 밖 — 지도)면 'not-allowed', 파일 · 기록이 없으면 'gone'.
 */
export async function screenFileForPick(
  tenantId: string,
  ownedDomains: readonly string[] | undefined,
  pick: Pick<PhotoPick, 'src' | 'origin' | 'screenId' | 'variantId'>,
): Promise<Buffer | 'gone' | 'not-allowed'> {
  const ref = parseScreenAppSrc(pick.src);
  const target = screenOfPick(pick, ownedDomains);
  if (!ref || ref.tenantId !== tenantId || !target) return 'gone';
  if (!screenSaveAllowed(target.screen.kind)) return 'not-allowed';
  const shots = await readScreenShots(tenantId);
  if (!shots.some((s) => s.sha16 === ref.shotId && s.screenId === pick.screenId && s.variantId === pick.variantId)) return 'gone';
  return (await readScreenFile(tenantId, ref.shotId)) ?? 'gone';
}
