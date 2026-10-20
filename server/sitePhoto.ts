import { readLimitedBytes } from './aeo/collectPage.js';
import { assertPublicUrl, CollectorError } from './aeo/networkSafety.js';

/**
 * 고른 홈페이지 사진의 파일 — 「사진 N장 받기」(src/lib/articlePhotos.ts). 블로그 편집기가 붙여 넣은 바깥 사진을 버리거나 사이트가
 * 핫링크를 막으면, 받은 파일을 블로그에 직접 올린다.
 *
 * 화면이 보낸 주소가 아니라 저장된 고른 사진만 받는다(server/index.ts). 사이트 진단 수집(collectPage.ts)과 같은 안전장치를 쓴다 —
 * 홉마다 공개 주소인지 다시 보고(assertPublicUrl), https만, 전체 기한 하나, 크기 한도. 형식은 응답 헤더가 아니라 파일 앞 바이트로
 * 정한다 — 국내 호스팅 · S3는 사진을 octet-stream으로 보내기도 하고, 이미지라고 하면서 HTML을 보내기도 한다.
 */
export interface SitePhotoFile {
  bytes: Uint8Array;
  type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'image/avif';
  ext: 'jpg' | 'png' | 'gif' | 'webp' | 'avif';
}

const MAX_PHOTO_BYTES = 10_000_000;
const DEADLINE_MS = 15_000;
const MAX_REDIRECTS = 5;
const UA = 'BrandAEO-PhotoFetch/1.0 (+customer-approved homepage photo)';

/** 파일 앞 바이트로 사진 형식을 정한다. 아니면 null(svg · html 등은 받지 않는다). */
export function photoTypeOf(bytes: Uint8Array): Pick<SitePhotoFile, 'type' | 'ext'> | null {
  const at = (i: number) => bytes[i] ?? -1;
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => at(i) === b)) return { type: 'image/png', ext: 'png' };
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return { type: 'image/gif', ext: 'gif' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { type: 'image/webp', ext: 'webp' };
  if (ascii(4, 12) === 'ftypavif' || ascii(4, 12) === 'ftypavis') return { type: 'image/avif', ext: 'avif' };
  return null;
}

/** 헤더만 보고 거절할 형식 — 사진이 아닌 것이 분명하다. 그 밖(octet-stream · image/jpg 등)은 바이트로 본다. */
const NOT_PHOTO = /text\/|html|xml|svg|json|javascript/i;

export async function fetchSitePhoto(src: string): Promise<SitePhotoFile> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEADLINE_MS);
  try {
    let current = await assertPublicUrl(src);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (current.protocol !== 'https:') throw new CollectorError('NOT_HTTPS', '사진 주소가 https가 아니에요.');
      const res = await fetch(current.href, {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.5' },
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get('location');
        if (!location) throw new CollectorError('INVALID_REDIRECT', '사진 주소의 리디렉션 위치를 확인할 수 없어요.');
        current = await assertPublicUrl(new URL(location, current).href);
        continue;
      }
      if (!res.ok) throw new CollectorError('HTTP_ERROR', `사진을 받지 못했어요(HTTP ${res.status}). 사이트가 사진을 옮겼는지 확인해 주세요.`);
      if (NOT_PHOTO.test(res.headers.get('content-type') ?? '')) throw new CollectorError('NOT_IMAGE', '사진이 아닌 응답이에요.');
      const length = Number(res.headers.get('content-length'));
      if (length > MAX_PHOTO_BYTES) throw new CollectorError('BODY_TOO_LARGE', '사진이 10MB를 넘어 받지 않았어요.');
      let bytes: Uint8Array;
      try {
        bytes = await readLimitedBytes(res, MAX_PHOTO_BYTES);
      } catch (err) {
        if (err instanceof CollectorError && err.code === 'BODY_TOO_LARGE') throw new CollectorError('BODY_TOO_LARGE', '사진이 10MB를 넘어 받지 않았어요.');
        throw err;
      }
      const kind = photoTypeOf(bytes);
      if (!kind) throw new CollectorError('NOT_IMAGE', '사진 파일(jpg · png · gif · webp · avif)이 아니에요.');
      return { bytes, ...kind };
    }
    throw new CollectorError('TOO_MANY_REDIRECTS', '사진 주소의 리디렉션이 너무 많아요.');
  } catch (err) {
    if (ctrl.signal.aborted) throw new CollectorError('TIMEOUT', `사진을 ${DEADLINE_MS / 1000}초 안에 받지 못했어요.`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
