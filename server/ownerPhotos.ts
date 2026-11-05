import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PIPELINE_DATA_DIR } from './appPaths.js';
import { writeJsonAtomic } from './tenantWriteQueue.js';
import { cleanPhotoAlt } from '../src/lib/articlePhotos.js';
import {
  cleanRightsHolder,
  isOwnerPhotoId,
  OWNER_PHOTO_MAX,
  OWNER_PHOTO_MAX_BYTES,
  OWNER_PHOTO_TYPES,
  ownerPhotoAppSrc,
  ownerPhotoSize,
  sniffOwnerPhotoType,
  type OwnerPhotoMime,
  type OwnerPhotoRecord,
  type OwnerPhotoView,
} from '../src/lib/ownerPhotos.js';
import { validScene, type PhotoScene } from '../src/lib/photoScenes.js';

/**
 * 업주 사진 보관함의 서버 쪽(src/lib/ownerPhotos.ts) — PIPELINE_DATA_DIR/<tenant>/owner-photos/<id>.<ext>와 목록 owner-photos.json.
 * 운영자 PC에만 둔다(바깥에 올리지 않는다). 사진 형식은 파일 앞 바이트로 가리고(jpg · png · webp), 크기 · 장수 상한을 넘으면 거절한다.
 * 목록 쓰기는 브랜드마다 줄을 세운다(한 프로세스 안).
 */

const LIST_FILE = 'owner-photos.json';

export class OwnerPhotoError extends Error {
  code: 'format' | 'too-large' | 'too-many' | 'empty' | 'not-found' | 'rights';
  constructor(code: OwnerPhotoError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

/** 브랜드의 업주 사진 폴더 — 브랜드 id에 경로 글자가 있거나 데이터 폴더 밖으로 나가면 throw. */
export function ownerPhotosDir(tenantId: string): string {
  if (!tenantId || /[/\\]/.test(tenantId) || tenantId === '.' || tenantId === '..') throw new RangeError(`잘못된 브랜드 id: ${tenantId}`);
  const root = path.resolve(PIPELINE_DATA_DIR);
  const dir = path.resolve(root, tenantId, 'owner-photos');
  if (path.relative(root, dir) !== path.join(tenantId, 'owner-photos')) throw new RangeError(`잘못된 브랜드 id: ${tenantId}`);
  return dir;
}

function validRecord(v: unknown): v is OwnerPhotoRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  const rights = (r.rights && typeof r.rights === 'object' ? r.rights : {}) as Record<string, unknown>;
  const mime = r.mime as OwnerPhotoMime;
  return (
    isOwnerPhotoId(r.id) &&
    Object.hasOwn(OWNER_PHOTO_TYPES, mime) &&
    r.ext === OWNER_PHOTO_TYPES[mime] &&
    typeof r.bytes === 'number' &&
    r.bytes > 0 &&
    typeof r.alt === 'string' &&
    typeof r.uploadedAt === 'string' &&
    Number.isFinite(Date.parse(r.uploadedAt)) &&
    typeof rights.confirmedAt === 'string' &&
    Number.isFinite(Date.parse(rights.confirmedAt)) &&
    typeof rights.holder === 'string' &&
    (r.scene === undefined || validScene(r.scene) !== null)
  );
}

/** 목록을 읽는다 — 없으면 []. 읽을 수 없거나 모양이 틀리면 throw(쓰는 길이 깨진 목록을 덮지 않게). */
async function loadRecords(tenantId: string): Promise<OwnerPhotoRecord[]> {
  let text: string;
  try {
    text = await readFile(path.join(ownerPhotosDir(tenantId), LIST_FILE), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const parsed = JSON.parse(text) as { photos?: unknown };
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.photos)) throw new Error(`${tenantId}/owner-photos/${LIST_FILE}의 모양이 맞지 않습니다.`);
  return parsed.photos.filter(validRecord);
}

/** 보관한 업주 사진(올린 차례) — 없거나 읽을 수 없으면 [](읽을 수 없으면 알린다). */
export async function readOwnerPhotos(tenantId: string): Promise<OwnerPhotoRecord[]> {
  try {
    return await loadRecords(tenantId);
  } catch (err) {
    console.warn(`[owner-photos] ${tenantId} 목록을 읽지 못했습니다:`, err);
    return [];
  }
}

export function ownerPhotoView(tenantId: string, rec: OwnerPhotoRecord): OwnerPhotoView {
  return { ...rec, src: ownerPhotoAppSrc(tenantId, rec.id, rec.ext) };
}

const listWrites = new Map<string, Promise<unknown>>();
function updateRecords<T>(tenantId: string, task: (photos: OwnerPhotoRecord[]) => Promise<T> | T): Promise<T> {
  const prev = listWrites.get(tenantId) ?? Promise.resolve();
  const run = prev.then(async () => {
    const photos = await loadRecords(tenantId);
    const result = await task(photos);
    await writeJsonAtomic(path.join(ownerPhotosDir(tenantId), LIST_FILE), { photos });
    return result;
  });
  listWrites.set(
    tenantId,
    run.catch(() => undefined),
  );
  return run;
}

/**
 * 사진 하나를 보관한다 — 형식(앞 바이트) · 크기 · 장수를 보고, 파일 sha256 앞 16자를 id로 쓴다. 같은 사진이 이미 있으면 설명 · 권리만
 * 새로 적고(existed) 파일은 그대로 둔다. 권리 확인(holder)이 없으면 거절한다 — 화면이 확인을 받고 보낸다.
 */
export async function addOwnerPhoto(
  tenantId: string,
  bytes: Buffer,
  meta: { alt: string; holder: unknown; note?: unknown; now?: Date },
): Promise<{ record: OwnerPhotoRecord; existed: boolean }> {
  if (!bytes.length) throw new OwnerPhotoError('empty', '사진 파일이 비어 있어요.');
  if (bytes.length > OWNER_PHOTO_MAX_BYTES) throw new OwnerPhotoError('too-large', `사진 한 장은 ${Math.round(OWNER_PHOTO_MAX_BYTES / 1024 / 1024)}MB까지예요.`);
  const mime = sniffOwnerPhotoType(bytes);
  if (!mime) throw new OwnerPhotoError('format', 'jpg · png · webp 사진만 올릴 수 있어요.');
  const id = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const ext = OWNER_PHOTO_TYPES[mime];
  const size = ownerPhotoSize(bytes, mime);
  const now = (meta.now ?? new Date()).toISOString();
  const alt = cleanPhotoAlt(meta.alt);
  const note = typeof meta.note === 'string' ? meta.note.replace(/[\p{Cc}<>]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) : '';
  const rights = { confirmedAt: now, holder: cleanRightsHolder(meta.holder), ...(note ? { note } : {}) };
  return updateRecords(tenantId, async (photos) => {
    const had = photos.find((p) => p.id === id);
    if (had) {
      if (alt) had.alt = alt;
      had.rights = rights;
      return { record: { ...had }, existed: true };
    }
    if (photos.length >= OWNER_PHOTO_MAX) throw new OwnerPhotoError('too-many', `업주 사진은 브랜드마다 ${OWNER_PHOTO_MAX}장까지예요.`);
    const dir = ownerPhotosDir(tenantId);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${id}.${ext}`);
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, file);
    const record: OwnerPhotoRecord = { id, ext, mime, bytes: bytes.length, ...(size ?? {}), alt, uploadedAt: now, rights };
    photos.push(record);
    return { record: { ...record }, existed: false };
  });
}

/** 설명을 고친다 — 없으면 not-found. */
export function updateOwnerPhotoAlt(tenantId: string, id: string, alt: string): Promise<OwnerPhotoRecord> {
  return updateRecords(tenantId, (photos) => {
    const rec = photos.find((p) => p.id === id);
    if (!rec) throw new OwnerPhotoError('not-found', '그 업주 사진이 없어요.');
    rec.alt = cleanPhotoAlt(alt);
    return { ...rec };
  });
}

/** 읽은 장면(또는 읽지 못한 까닭)을 적는다 — 없는 사진이면 null. */
export function setOwnerPhotoScene(tenantId: string, id: string, scene: PhotoScene | null, error?: string): Promise<OwnerPhotoRecord | null> {
  return updateRecords(tenantId, (photos) => {
    const rec = photos.find((p) => p.id === id);
    if (!rec) return null;
    if (scene) {
      rec.scene = scene;
      delete rec.sceneError;
    } else if (error) rec.sceneError = error.slice(0, 200);
    return { ...rec };
  });
}

/** 보관함에서 뺀다(파일도 지운다) — 없으면 false. 글에 이미 넣은 사진은 「사진 받기」 · 내보내기에서 빠진다(파일이 없다). */
export function removeOwnerPhoto(tenantId: string, id: string): Promise<boolean> {
  return updateRecords(tenantId, async (photos) => {
    const at = photos.findIndex((p) => p.id === id);
    if (at < 0) return false;
    const [rec] = photos.splice(at, 1);
    try {
      await unlink(path.join(ownerPhotosDir(tenantId), `${rec!.id}.${rec!.ext}`));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return true;
  });
}

/** 보관한 사진 파일 — 목록에 있는 id만. 없으면 null. */
export async function readOwnerPhotoFile(tenantId: string, id: string): Promise<{ bytes: Buffer; record: OwnerPhotoRecord } | null> {
  if (!isOwnerPhotoId(id)) return null;
  const record = (await readOwnerPhotos(tenantId)).find((p) => p.id === id);
  if (!record) return null;
  try {
    return { bytes: await readFile(path.join(ownerPhotosDir(tenantId), `${record.id}.${record.ext}`)), record };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
