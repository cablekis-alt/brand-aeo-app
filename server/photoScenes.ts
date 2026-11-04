import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { stateFilePath } from './appPaths.js';
import { CollectorError, publicCollectorError } from './aeo/networkSafety.js';
import { fetchSitePhoto } from './sitePhoto.js';
import { writeJsonAtomic } from './tenantWriteQueue.js';
import { canonicalPhotoSrc } from '../src/lib/articlePhotos.js';
import { parseScene, SCENE_JSON_SCHEMA, validScene, type PhotoScene } from '../src/lib/photoScenes.js';

/**
 * 사진 장면 읽기 — 자동 채우기 후보 사진 한 장을 비전 모델에 보여 주고 장면(src/lib/photoScenes.ts PhotoScene)을 받는다. 기본은 Claude
 * Sonnet 5.5(PHOTO_SCENE_MODEL로 바꾼다) — 사진 한 장에 한 번, 구조화 출력(JSON 스키마)으로 받아 다시 검사한다. Gemini 클라이언트는
 * 사진을 받지 않아(글자 전용) 대체로 쓰지 않는다. 키(ANTHROPIC_API_KEY)는 서버 안에서만 읽고 응답 · 로그 · 오류 글자에 싣지 않는다.
 *
 * 사진은 서버가 받아(server/sitePhoto.ts — 공개 주소 · https · 15초 · 10MB) base64로 보낸다. 3.75MB를 넘으면(base64가 5MB 한도를 넘는다)
 * 주소로 보낸다. avif는 모델이 받지 않아 avif를 빼고 청한다(SCENE_PHOTO_ACCEPT — 형식을 고르는 CDN은 webp를 준다). 그래도 avif가 오면
 * 읽지 않는다.
 *
 * 읽은 장면은 userData의 photo-scenes.json에 사진 주소(canonicalPhotoSrc)마다 둔다 — 모델을 바꾸기 전까지 다시 읽지 않는다(사진 주소가
 * 같으면 사진도 같다고 본다). 쓰기는 원자적(writeJsonAtomic). 같은 사진을 동시에 물으면 한 번만 읽고, 이 PC 전체에서 동시에 CONCURRENCY장까지
 * 읽는다. 한 번에 SCENE_MAX_NEW장까지 새로 읽고 남은 수(pending)를 알린다 — 화면이 이어서 묻는다.
 * 사진 한 장의 문제(받지 못함 · 형식 · 모양이 틀림 · 모델이 그 사진을 읽지 않음)만 실패로 두고 FAIL_RETRY_MS 동안 다시 읽지 않는다(그
 * 사이에는 failed로 알린다 — 사진 서버의 시간 초과 · 일시 오류는 FAIL_RETRY_SHORT_MS). 키 · 호출 한도 · 크레딧 · 모델 없음 · Claude
 * 과부하 · 연결 끊김처럼 모든 사진에 같은 오류는 사진의 실패로 남기지 않고 멈춘다(남은 사진은 pending — 다시 누르면 이어서 읽는다).
 * 화면이 요청을 버리면(연결이 끊기면) 새 사진을 읽기 시작하지 않는다.
 */

/** 한 번에 새로 읽는 사진 수의 상한. */
export const SCENE_MAX_NEW = 60;
/** 한 번에 묻는 사진 주소 수의 상한. */
export const SCENE_MAX_SRCS = 300;
const CONCURRENCY = 3;
const DEFAULT_MODEL = 'claude-sonnet-5-5';
/** 이보다 큰 사진은 주소로 보낸다 — base64로 늘면 이미지 한 장 5MB 한도를 넘는다. */
const BASE64_MAX_BYTES = 3_750_000;
/** 생각(추론) 토큰도 여기에 들어간다 — 장면 한 줄 JSON에는 넉넉하다. */
const MAX_TOKENS = 2048;
const CALL_TIMEOUT_MS = 60_000;
const FAIL_RETRY_MS = 6 * 60 * 60 * 1000;
/** 사진 서버의 시간 초과 · 연결 · 5xx — 잠깐의 문제일 수 있어 짧게만 다시 읽지 않는다. */
const FAIL_RETRY_SHORT_MS = 10 * 60 * 1000;
/** 장면 읽기용으로 사진을 받을 때 청하는 형식 — avif는 모델이 받지 않아 뺀다. */
export const SCENE_PHOTO_ACCEPT = 'image/webp,image/png,image/jpeg,image/gif,*/*;q=0.5';
const CACHE_MAX = 20_000;
/** 추론 강도 · 거절 시 대체 모델을 받는 모델(5세대) — 그 밖의 모델에 보내면 400이거나 효과가 없다(engines/claudeJudgeClient.ts와 같다). */
const SUPPORTS_EFFORT_AND_FALLBACK = /^claude-(opus-5|fable-5|sonnet-5-5)/;

const SCENE_SYSTEM =
  '너는 여행 · 업체 글에 넣을 사진을 고르는 편집자를 돕는다. 사진 한 장을 보고 보이는 것만 적는다. 장소 이름 · 지역 · 연도를 짐작해 쓰지 않는다. 답은 주어진 JSON 모양으로만 한다.';
const SCENE_USER = [
  '이 사진의 장면을 적어 주세요.',
  '- text: 보이는 것만 적은 한국어 한 줄(60자 안팎). 예: 「초록 외벽의 박물관 건물과 앞마당, 사람 없음」',
  '- setting: exterior(건물 바깥 · 거리 · 풍경 · 야외), interior(건물 안 · 전시실 · 객실 · 매장 안), aerial(높은 곳이나 드론에서 내려다본 전경), closeup(음식 · 소품 · 안내판처럼 가까이 찍은 것), screen(웹사이트 · 앱 · 화면 캡처), illustration(그림 · 지도 · 일러스트 · 포스터), other(그 밖)',
  '- people: none(사람 없음), distant(사람이 작게 · 멀리 보여 누군지 알아볼 수 없음), identifiable(얼굴이나 모습으로 누군지 알아볼 수 있는 사람이 있음)',
  '- time: day(낮), night(밤), dusk(해 질 무렵 · 노을), unknown(실내 등 알 수 없음)',
  '- tags: 보이는 것을 가리키는 한국어 명사 3~10개. 예: 외관, 입구, 안내판, 매표소, 앞마당, 산책로, 거리, 전시실, 전시물, 디오라마, 모형, 야경, 바다, 공원, 겨울, 눈, 벚꽃',
].join('\n');

export function sceneModel(): string {
  return (process.env.PHOTO_SCENE_MODEL ?? '').trim() || DEFAULT_MODEL;
}

function apiKey(): string {
  return (process.env.ANTHROPIC_API_KEY ?? '').trim();
}

/** 이 PC에서 사진 장면을 읽을 수 있는가(키가 있는지만 — 값은 내보내지 않는다). */
export function photoScenesConfigured(): boolean {
  return apiKey().length > 0;
}

/** 글자에서 키를 지운다 — 오류 · 로그에 키가 섞이지 않게. */
export function scrubSceneKey(text: string): string {
  const key = apiKey();
  return key ? text.split(key).join('***') : text;
}

/**
 * 장면 읽기 오류 — 사진 한 장의 문제: FETCH 받지 못함 · FETCH_LATER 사진 서버의 시간 초과 · 연결 · 5xx(짧게만 다시 읽지 않는다) · FORMAT
 * 형식 · INVALID 모양이 틀림 · REFUSED 모델이 거절 · REJECTED 모델이 그 사진을 받지 않음(400 이미지). 모든 사진에 같은 문제(STOP_CODES —
 * 멈추고 남은 사진은 pending): AUTH 키 · 권한 · RATE 호출 한도 · ACCOUNT 크레딧 · 모델 없음 · 요청이 맞지 않음 · BUSY Claude 과부하 ·
 * 5xx · 연결 끊김 · 시간 초과 · ERROR 예상하지 못한 오류.
 */
type SceneErrorCode = 'FETCH' | 'FETCH_LATER' | 'FORMAT' | 'INVALID' | 'REFUSED' | 'REJECTED' | 'AUTH' | 'RATE' | 'ACCOUNT' | 'BUSY' | 'ERROR';

const STOP_CODES: ReadonlySet<SceneErrorCode> = new Set(['AUTH', 'RATE', 'ACCOUNT', 'BUSY', 'ERROR']);

export class SceneError extends Error {
  readonly code: SceneErrorCode;
  constructor(code: SceneErrorCode, message: string) {
    super(message);
    this.name = 'SceneError';
    this.code = code;
  }
}

/**
 * 사진 한 장의 장면을 읽는다 — 모델 출력(검사 전)과 실제로 답한 모델. 모델이 답하면 onCall을 부른다(비용 셈 — 답하지 않은 호출은 세지
 * 않는다). 확인 스크립트는 가짜를 넣는다(describePhotoScenes opts.describer).
 */
export type SceneDescriber = (src: string, onCall: () => void) => Promise<{ raw: unknown; model: string }>;

interface CacheEntry {
  scene: PhotoScene;
  /** 그때 부른 모델(PHOTO_SCENE_MODEL) — 지금 모델과 다르면 다시 읽는다. */
  via: string;
}
interface CacheFile {
  version: 1;
  scenes: Record<string, CacheEntry>;
}

let cache: CacheFile | null = null;
let writing: Promise<void> = Promise.resolve();
const failures = new Map<string, { at: number; reason: string; retryMs: number }>();
const inflight = new Map<string, Promise<PhotoScene>>();

function cacheFile(): string {
  return stateFilePath('photo-scenes.json');
}

function loadCache(): CacheFile {
  if (cache) return cache;
  let raw: unknown = null;
  try {
    raw = JSON.parse(readFileSync(cacheFile(), 'utf-8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[photo-scenes] 캐시를 읽지 못해 새로 시작합니다', err instanceof Error ? err.message : err);
  }
  const r = (raw && typeof raw === 'object' ? raw : {}) as { scenes?: Record<string, unknown> };
  const scenes: Record<string, CacheEntry> = {};
  for (const [src, e] of Object.entries(r.scenes && typeof r.scenes === 'object' ? r.scenes : {})) {
    const entry = (e && typeof e === 'object' ? e : {}) as { scene?: unknown; via?: unknown };
    const scene = validScene(entry.scene);
    if (scene && typeof entry.via === 'string' && canonicalPhotoSrc(src) === src) scenes[src] = { scene, via: entry.via };
  }
  cache = { version: 1, scenes };
  return cache;
}

/** 캐시를 디스크에 쓴다 — 한 번에 하나씩(원자적 쓰기), 너무 크면 오래 읽은 것부터 버린다. 실패해도 응답은 그대로 준다(다음 쓰기에 다시). */
function saveCache(): Promise<void> {
  writing = writing
    .then(() => {
      const c = loadCache();
      const keys = Object.keys(c.scenes);
      if (keys.length > CACHE_MAX) {
        const old = keys.sort((a, b) => (c.scenes[a]!.scene.describedAt < c.scenes[b]!.scene.describedAt ? -1 : 1)).slice(0, keys.length - CACHE_MAX);
        for (const k of old) delete c.scenes[k];
      }
      return writeJsonAtomic(cacheFile(), c);
    })
    .catch((err: unknown) => console.warn('[photo-scenes] 캐시를 저장하지 못했습니다', err instanceof Error ? err.message : err));
  return writing;
}

// 이 PC 전체에서 동시에 읽는 사진 수 — 자리를 넘겨줄 때는 셈을 줄이지 않는다(새 요청이 끼어들어 넘치지 않게).
let active = 0;
const waiting: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active < CONCURRENCY) active += 1;
  else await new Promise<void>((resolve) => waiting.push(resolve));
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  }
}

/** 사진 서버의 잠깐일 수 있는 문제 — 시간 초과 · 연결 끊김 · DNS 일시 실패 · 5xx. */
const FETCH_LATER_CODES: ReadonlySet<string> = new Set(['TIMEOUT', 'CONNECT_TIMEOUT', 'CONNECTION_RESET', 'DNS_TEMPORARY', 'FETCH_FAILED']);

/**
 * 모델에 보낼 사진 — 받아서 base64로(avif를 빼고 청한다 — SCENE_PHOTO_ACCEPT), 10MB를 넘거나 3.75MB를 넘으면 주소로. fetchPhoto는 확인
 * 스크립트가 가짜를 넣는다.
 */
export async function imageSourceOf(
  src: string,
  fetchPhoto: typeof fetchSitePhoto = fetchSitePhoto,
): Promise<Anthropic.Beta.BetaBase64ImageSource | Anthropic.Beta.BetaURLImageSource> {
  let file: Awaited<ReturnType<typeof fetchSitePhoto>>;
  try {
    file = await fetchPhoto(src, { accept: SCENE_PHOTO_ACCEPT });
  } catch (err) {
    if (err instanceof CollectorError && err.code === 'BODY_TOO_LARGE') return { type: 'url', url: src };
    const pub = publicCollectorError(err);
    const later = FETCH_LATER_CODES.has(pub.code) || /HTTP 5\d\d/.test(pub.message);
    throw new SceneError(later ? 'FETCH_LATER' : 'FETCH', `사진을 받지 못했어요 — ${pub.message}`);
  }
  if (file.type === 'image/avif') throw new SceneError('FORMAT', '이 사진 형식(avif)은 장면을 읽지 못해요.');
  if (file.bytes.length > BASE64_MAX_BYTES) return { type: 'url', url: src };
  return { type: 'base64', media_type: file.type, data: Buffer.from(file.bytes).toString('base64') };
}

let client: Anthropic | null = null;

/** Claude로 장면을 읽는다 — 구조화 출력(JSON 스키마), 5세대 모델이면 추론 강도 low · 거절 시 서버 쪽 대체 모델. */
function claudeDescriber(): SceneDescriber {
  return async (src, onCall) => {
    const source = await imageSourceOf(src);
    client ??= new Anthropic({ apiKey: apiKey(), maxRetries: 2, timeout: CALL_TIMEOUT_MS });
    const model = sceneModel();
    const modern = SUPPORTS_EFFORT_AND_FALLBACK.test(model);
    const response = await client.beta.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      system: SCENE_SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source },
            { type: 'text', text: SCENE_USER },
          ],
        },
      ],
      output_config: { ...(modern ? { effort: 'low' as const } : {}), format: { type: 'json_schema', schema: SCENE_JSON_SCHEMA as unknown as Record<string, unknown> } },
      ...(modern ? { fallbacks: 'default' as const, betas: ['server-side-fallback-2026-07-01'] } : {}),
    });
    onCall();
    if (response.stop_reason === 'refusal') throw new SceneError('REFUSED', `모델이 이 사진의 장면을 읽지 않았어요(${response.stop_details?.category ?? '분류 없음'}).`);
    if (response.stop_reason === 'max_tokens') throw new SceneError('INVALID', '모델 답이 출력 한도에서 잘렸어요.');
    const text = response.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
    try {
      return { raw: JSON.parse(text) as unknown, model: response.model };
    } catch (err) {
      throw new SceneError('INVALID', `모델 답이 JSON이 아니에요(${err instanceof Error ? err.message.slice(0, 60) : 'parse'}).`);
    }
  };
}

/**
 * 오류를 화면에 보일 글자 · 종류로 — 키는 지운다. 연결 오류(APIConnectionError · 시간 초과)는 APIError를 이어받아 먼저 본다. 400은
 * 사진에 대한 말(image)이면 그 사진만(REJECTED), 아니면 모든 사진에 같은 문제다(크레딧 · 요청이 맞지 않음 — ACCOUNT).
 */
function sceneErrorOf(err: unknown): SceneError {
  if (err instanceof SceneError) return err;
  if (err instanceof Anthropic.APIConnectionError) {
    return new SceneError('BUSY', 'Claude에 연결하지 못했어요(네트워크 · 시간 초과) — 남은 사진은 잠시 뒤 다시 누르면 이어서 읽어요.');
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new SceneError('AUTH', 'Claude 키가 맞지 않거나 이 모델을 쓸 권한이 없어 사진 장면을 읽지 못했어요 — 이 PC의 ANTHROPIC_API_KEY를 확인해 주세요.');
  }
  if (err instanceof Anthropic.RateLimitError) return new SceneError('RATE', 'Claude 호출 한도에 닿아 사진 장면을 다 읽지 못했어요 — 잠시 뒤 다시 눌러 주세요.');
  if (err instanceof Anthropic.APIError) {
    const message = err.message ?? '';
    if (err.type === 'billing_error' || /credit balance/i.test(message)) {
      return new SceneError('ACCOUNT', 'Claude 크레딧이 부족해 사진 장면을 읽지 못했어요 — 충전한 뒤 다시 눌러 주세요.');
    }
    if (err instanceof Anthropic.NotFoundError) {
      return new SceneError('ACCOUNT', `사진 장면 모델(${sceneModel()})을 찾지 못했어요 — 이 PC의 PHOTO_SCENE_MODEL을 확인해 주세요.`);
    }
    const status = err.status ?? 0;
    if (status >= 500 || err.type === 'overloaded_error' || err.type === 'api_error' || err.type === 'timeout_error') {
      return new SceneError('BUSY', `Claude가 지금 답하지 못해(HTTP ${status || '?'}) 사진 장면을 다 읽지 못했어요 — 남은 사진은 잠시 뒤 다시 누르면 이어서 읽어요.`);
    }
    if (status >= 400 && status < 500 && /image/i.test(message)) return new SceneError('REJECTED', `모델이 이 사진을 받지 않았어요(HTTP ${status}).`);
    return new SceneError('ACCOUNT', `Claude가 사진 장면 요청을 받지 않았어요(HTTP ${status || '?'}) — 남은 사진은 읽지 않았어요.`);
  }
  console.warn('[photo-scenes] 예상하지 못한 오류', scrubSceneKey(err instanceof Error ? err.message : String(err)));
  return new SceneError('ERROR', '사진 장면을 읽다가 오류가 나 남은 사진은 읽지 않았어요 — 다시 눌러 주세요.');
}

/** 사진 한 장 — 같은 사진을 동시에 물으면 한 번만 읽는다. 읽으면 캐시에 넣는다(디스크 쓰기는 describePhotoScenes가 끝에 한 번). */
function describeOne(src: string, describer: SceneDescriber, model: string, stats: { calls: number }): Promise<PhotoScene> {
  const running = inflight.get(src);
  if (running) return running;
  const task = withSlot(async () => {
    const { raw, model: answered } = await describer(src, () => {
      stats.calls += 1;
    });
    const scene = parseScene(raw, { model: answered, describedAt: new Date().toISOString() });
    if (!scene) throw new SceneError('INVALID', '모델 답의 모양이 맞지 않아요.');
    loadCache().scenes[src] = { scene, via: model };
    return scene;
  });
  inflight.set(src, task);
  return task.finally(() => inflight.delete(src));
}

export interface PhotoScenesResult {
  /** 물은 사진 가운데 장면이 있는 것(읽어 둔 것 + 이번에 읽은 것). */
  scenes: Record<string, PhotoScene>;
  /** 장면이 없는 사진(남은 것 + 실패). */
  missing: string[];
  /** 읽지 못한 사진과 이유(사진 한 장의 문제 — 받지 못함 · 형식 · 모양이 틀림 · 모델이 읽지 않음, 한동안 다시 읽지 않는다). */
  failed: Record<string, string>;
  /** 이번에 새로 읽은 사진 수. */
  described: number;
  /** 이번에 모델을 부른 횟수(비용). */
  calls: number;
  /** 아직 읽지 않은 사진 수(실패 제외 — 상한 · 멈춤으로 남은 사진) — 다시 물으면 이어서 읽는다. */
  pending: number;
  /** 이 PC에서 새로 읽을 수 있는가(키가 있는가). */
  available: boolean;
  model: string;
  notes: string[];
}

/**
 * 사진들의 장면 — 읽어 둔 장면은 그대로, 없는 사진은 앞에서부터 limit장(SCENE_MAX_NEW까지) 새로 읽는다(limit 0이면 읽어 둔 것만).
 * 키가 없으면 읽어 둔 장면만 주고 알린다. 모든 사진에 같은 오류(STOP_CODES — 키 · 한도 · 크레딧 · 모델 없음 · 과부하 · 연결)가 나면 남은
 * 사진은 읽지 않고 알린다(pending으로 남는다 — 실패로 적지 않는다). signal이 끊기면(화면이 요청을 버렸다) 새 사진을 읽기 시작하지 않는다.
 */
export async function describePhotoScenes(
  srcs: readonly string[],
  opts: { limit?: number; describer?: SceneDescriber; signal?: AbortSignal } = {},
): Promise<PhotoScenesResult> {
  const model = sceneModel();
  const list = [...new Set(srcs.map((s) => canonicalPhotoSrc(s)).filter((s): s is string => Boolean(s)))];
  const c = loadCache();
  const scenes: Record<string, PhotoScene> = {};
  const failed: Record<string, string> = {};
  const todo: string[] = [];
  const now = Date.now();
  for (const src of list) {
    const hit = c.scenes[src];
    if (hit && hit.via === model) {
      scenes[src] = hit.scene;
      continue;
    }
    const fail = failures.get(src);
    if (fail && now - fail.at < fail.retryMs) failed[src] = fail.reason;
    else todo.push(src);
  }
  const available = Boolean(opts.describer) || photoScenesConfigured();
  const notes: string[] = [];
  const stats = { calls: 0 };
  let described = 0;
  const limit = Math.max(0, Math.min(opts.limit ?? SCENE_MAX_NEW, SCENE_MAX_NEW));
  if (!available && todo.length) notes.push('이 PC에 Claude 키(ANTHROPIC_API_KEY)가 없어 사진 장면을 읽지 못해요 — 장면 없이 지금처럼 고릅니다.');
  if (available && limit > 0 && todo.length) {
    const describer = opts.describer ?? claudeDescriber();
    const batch = todo.slice(0, limit);
    let stop: string | null = null;
    let next = 0;
    const worker = async () => {
      while (next < batch.length && !stop && !opts.signal?.aborted) {
        const src = batch[next]!;
        next += 1;
        try {
          scenes[src] = await describeOne(src, describer, model, stats);
          described += 1;
        } catch (err) {
          const e = sceneErrorOf(err);
          const message = scrubSceneKey(e.message);
          if (STOP_CODES.has(e.code)) {
            stop ??= message;
            continue;
          }
          failed[src] = message;
          failures.set(src, { at: Date.now(), reason: message, retryMs: e.code === 'FETCH_LATER' ? FAIL_RETRY_SHORT_MS : FAIL_RETRY_MS });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.length) }, worker));
    if (stop) notes.push(stop);
    if (described) await saveCache();
  }
  const missing = list.filter((src) => !scenes[src]);
  return { scenes, missing, failed, described, calls: stats.calls, pending: missing.filter((src) => !failed[src]).length, available, model, notes };
}
