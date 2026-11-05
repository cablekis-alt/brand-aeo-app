/**
 * 자사 화면 내보내기 — 글의 사진 기록에는 자사 화면의 앱 주소(/api/screens/<tenant>/<id>.png)만 있다(2026-11-04 결정 1). 앱 안
 * 썸네일은 같은 출처라 그 주소로 바로 보이지만, 앱 밖으로 나가는 글(홈페이지용 .html · 서식째 복사 · 작성자 묶음의 .html)에 그 주소가
 * 남으면 운영자 PC에서만 보이고 독자에게는 깨진다. 그래서 내보낼 때 그림을 받아 data:image/png로 문서 안에 넣는다(inlineScreens). 받지
 * 못한 화면은 그림을 빼고 「[화면: 이름]」 글자로 둔다 — 앱 주소를 남기지 않는다. 서식째 복사의 글자 쪽(text/plain — 마크다운)에는
 * 그림 대신 「[화면: 이름]」을 넣는다(screenPlainText). 앱 안의 글 미리보기도 골라 복사하는 곳이라 화면을 「[화면: 이름]」 글자로 그린다
 * (screenPreviewHtml — 그림은 자동 채우기 · 화면 고르기의 썸네일에서 본다). 앱이 그린 군산 지도(/api/maps/ — src/lib/mapImage.ts)도 같은
 * 길이고, 그림 바로 아래의 OSM 출처 줄은 늘 남는다 — 글자 쪽은 「[지도: 군산 지도 — … 위치] 출처 줄」 한 줄이다.
 *
 * 네이버 SmartEditor ONE · 티스토리가 붙여 넣은 data: 그림을 받는지는 아직 모른다(결정 2) — 그때까지 기본 전달은 「사진 N장 받기」
 * 파일이다(서버 photo-file이 이 PC의 화면 파일을 준다). 「사진 N장 받기」 · 작성자 묶음의 사진 파일은 여기를 거치지 않는다.
 *
 * DOM을 쓰지 않는다(검증 스크립트가 Node에서 부른다).
 */
import { MAP_AREA_NAME, MAP_CREDIT, mapPlainLine } from './mapImage'
import { OWNER_PHOTO_MAX_BYTES, ownerPhotoSize, sniffOwnerPhotoType } from './ownerPhotos'

/** 앱 주소의 화면 그림을 받는다 — 앱에서는 src/lib/api.ts fetchScreenFile. 실패하면 throw. */
export type ScreenFetcher = (src: string) => Promise<Blob>

/** 앱 밖으로 나간 글에 남으면 안 되는 앱 주소 — 자사 화면(/api/screens/)과 앱이 그린 지도(/api/maps/ — src/lib/mapImage.ts). */
const APP_PATH = /\/api\/(?:screens|maps|owner-photos)\//
/** 본문 HTML(src/lib/htmlFile.ts markdownToHtml)의 화면 · 지도 그림 — 그림 줄(figure)은 img가 figure 바로 안에 있다. */
const FIGURE_IMG = /<figure><img src="(\/api\/(?:screens|maps|owner-photos)\/[^"]*)" alt="([^"]*)"[^>]*>/g
const ANY_IMG = /<img src="(\/api\/(?:screens|maps|owner-photos)\/[^"]*)" alt="([^"]*)"([^>]*)>/g
/** 마크다운의 화면 · 지도 그림 — `![이름](앱 주소)`. */
const MD_IMG = /!\[([^\]]*)\]\((\/api\/(?:screens|maps|owner-photos)\/[^)\s]*)\)/g
/** 마크다운의 지도 그림과 그 바로 아래 출처 줄(src/lib/articlePhotos.ts placePhotos가 붙인 `*출처 줄*` — 있으면). */
const MD_MAP_WITH_CREDIT = new RegExp(`!\\[([^\\]]*)\\]\\((\\/api\\/maps\\/[^)\\s]*)\\)(?:(\\r?\\n)[ \\t]*\\*${MAP_CREDIT.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\*[ \\t]*(?=\\r?\\n|$))?`, 'g')
const MAP_PATH = /^\/api\/maps\//
/** 업주 사진의 앱 주소(src/lib/ownerPhotos.ts, 2026-11-06) — 자사 화면 · 지도처럼 내보낼 때 문서 안에 넣는다(jpg · png · webp). */
const OWNER_PATH = /^\/api\/owner-photos\//
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
/** 한 장의 최대 크기 — 서버 저장 상한(server/screens.ts MAX_SCREEN_PNG_BYTES)과 같다. */
const MAX_SCREEN_BYTES = 8 * 1024 * 1024

/**
 * 대체 텍스트에서 화면 이름 — 「군산각 웹사이트 'AI 코스 만들기' 화면」(src/lib/screenCapture.ts screenAlt)이면 「AI 코스 만들기」, 아니면
 * 대체 텍스트 그대로(비면 「자사 화면」).
 */
export function screenNameOfAlt(alt: string): string {
  const name = /'([^']+)' 화면$/.exec(alt.trim())?.[1] ?? alt.trim()
  return name || '자사 화면'
}

/** 화면 자리 글자 — 「[화면: AI 코스 만들기]」. 받은 「사진 N장 받기」 파일을 이 자리에 올린다. */
export function screenPlaceholder(alt: string): string {
  return `[화면: ${screenNameOfAlt(alt)}]`
}

/**
 * 앱 주소 그림의 자리 글자 — 앱이 그린 지도면 「[지도: 군산 지도 — … 위치]」(대체 텍스트 그대로 — 지도의 출처 줄은 바로 아랫줄 설명에 그대로
 * 남는다), 자사 화면이면 「[화면: 이름]」.
 */
function appImagePlaceholder(src: string, alt: string): string {
  if (OWNER_PATH.test(src)) return `[사진: ${alt.trim() || '업주 사진'}]`
  return MAP_PATH.test(src) ? `[지도: ${alt.trim() || '지도'}]` : screenPlaceholder(alt)
}

/**
 * 서식째 복사의 글자 쪽(마크다운) — 화면 그림은 「[화면: 이름]」, 지도 그림은 「[지도: 군산 지도 — … 위치] 출처 줄」 한 줄(바로 아래의 `*출처 줄*`은
 * 그 줄에 합친다 — 출처 줄은 한 번, 출처 줄이 따라오지 않은 지도 그림에도 붙는다). 없으면 그대로(바이트까지 같게).
 */
export function screenPlainText(markdown: string): string {
  return markdown
    .replace(MD_MAP_WITH_CREDIT, (_whole, alt: string) => mapPlainLine(alt))
    .replace(MD_IMG, (_whole, alt: string, src: string) => appImagePlaceholder(src, alt))
}

function base64Of(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** PNG 머리(IHDR)의 가로 — 읽지 못하면 null. */
function pngWidth(bytes: Uint8Array): number | null {
  if (bytes.length < 24 || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return null
  const w = bytes[16]! * 0x1000000 + bytes[17]! * 0x10000 + bytes[18]! * 0x100 + bytes[19]!
  return w > 0 ? w : null
}

/**
 * 받은 그림을 data:로(그림의 가로와 함께) — 자사 화면 · 지도는 PNG만, 업주 사진(owner)은 jpg · png · webp(앞 바이트로 가린다). 형식이 맞지
 * 않거나 비었거나 너무 크면 throw.
 */
async function dataUrlOf(blob: Blob, owner = false): Promise<{ url: string; width: number | null }> {
  if (owner) {
    if (!blob.size || blob.size > OWNER_PHOTO_MAX_BYTES) throw new Error(`업주 사진 크기가 맞지 않아요(${blob.size}바이트).`)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const mime = sniffOwnerPhotoType(bytes)
    if (!mime) throw new Error('jpg · png · webp가 아닌 그림이에요.')
    return { url: `data:${mime};base64,${base64Of(bytes)}`, width: ownerPhotoSize(bytes, mime)?.width ?? null }
  }
  if (blob.type && blob.type !== 'image/png') throw new Error(`PNG가 아닌 응답이에요(${blob.type}).`)
  if (!blob.size || blob.size > MAX_SCREEN_BYTES) throw new Error(`화면 그림 크기가 맞지 않아요(${blob.size}바이트).`)
  const bytes = new Uint8Array(await blob.arrayBuffer())
  if (!PNG_SIG.every((b, i) => bytes[i] === b)) throw new Error('PNG가 아닌 그림이에요.')
  return { url: `data:image/png;base64,${base64Of(bytes)}`, width: pngWidth(bytes) }
}

/** 그림 줄의 표시 폭(src/lib/htmlFile.ts FIGURE_IMG_SIZE — 칸 너비에 맞추되 720px까지). */
const FIGURE_MAX_WIDTH = 720

/**
 * 그림 화소보다 넓게 늘리지 않는다 — 그림 가로(화소)가 그림 줄 폭 720보다 좁으면 width · max-width를 그림 가로로 줄인다. 가로를 모르거나
 * 넓으면 그대로(칸이 좁으면 width:100%로 칸 폭).
 *
 * 예전 규칙은 「좁은 화면(잘라 찍은 장소 안내 · 가이드 — 가로 425px 남짓)은 내보낼 때 늘리지 않음」이었다 — 1배 그림을 720으로 늘리면 글자가
 * 흐려졌다. 2026-11-05부터 잘라 찍기는 2배 화소로 찍어(장소 안내 425 → 850 화소, 가이드 824 → 1648 화소) 720까지 줄여 넣어도 선명하다 —
 * 그래서 화면 크기(CSS px)가 아니라 그림 화소를 본다: 2배 그림은 그림 줄 폭(칸 폭)까지 크게 보이고(장소 안내는 예전 425의 1.7배), 그 전에
 * 1배로 찍은 옛 기록(425 화소)은 지금처럼 425 그대로다.
 */
function notWider(attrs: string, width: number | null): string {
  if (!width || width >= FIGURE_MAX_WIDTH) return attrs
  return attrs.replace(`width="${FIGURE_MAX_WIDTH}"`, `width="${width}"`).replace(`max-width:${FIGURE_MAX_WIDTH}px`, `max-width:${width}px`)
}

export interface InlinedScreens {
  html: string
  /** 문서 안에 넣은 화면 그림 수(같은 화면이 두 번이면 두 번). */
  inlined: number
  /** 받지 못해 「[화면: 이름]」 · 「[지도: …]」 글자로 바꾼 그림 수(화면 + 지도). */
  dropped: number
  /** dropped 가운데 앱이 그린 지도 수. */
  droppedMaps: number
}

/**
 * 내보낼 HTML(본문 · 완성 문서)의 자사 화면 그림을 문서 안(data:image/png)에 넣는다 — 같은 화면은 한 번만 받는다. 받지 못한 화면은 그림을
 * 빼고 「[화면: 이름]」 글자로 둔다(그림 줄이면 사진 자리처럼 figure 안 문단으로). 그래도 앱 주소가 남으면(본문 글자 등) throw — 앱 주소가
 * 든 글을 내보내지 않는다. 화면이 없으면 그대로.
 */
export async function inlineScreens(html: string, fetcher: ScreenFetcher): Promise<InlinedScreens> {
  if (!APP_PATH.test(html)) return { html, inlined: 0, dropped: 0, droppedMaps: 0 }
  const srcs = new Set([...html.matchAll(ANY_IMG)].map((m) => m[1]!))
  const data = new Map<string, { url: string; width: number | null } | null>()
  for (const src of srcs) {
    try {
      // HTML 속성 안의 주소라 &amp;가 있을 수 있다(앱 주소에는 없지만 되돌려 받는다).
      data.set(src, await dataUrlOf(await fetcher(src.replace(/&amp;/g, '&')), OWNER_PATH.test(src)))
    } catch (err) {
      console.warn(`[screenExport] 그림 ${src}을 받지 못해 「[화면: …]」 · 「[지도: …]」 글자로 둡니다`, err)
      data.set(src, null)
    }
  }
  const out = replaceScreens(html, data)
  if (APP_PATH.test(out.html)) throw new Error('내보낼 글에 앱 안에서만 열리는 화면 주소(/api/screens/)가 남았어요 — 화면을 넣지 못해 내보내지 않았어요.')
  return out
}

/**
 * HTML의 화면 그림(앱 주소)을 바꾼다 — data에 그 주소의 data: 그림이 있으면 그것으로(그림 화소가 그림 줄 폭보다 적으면 늘리지 않게 — notWider),
 * 없으면 그림을 빼고 「[화면: 이름]」 글자로(그림 줄이면 사진 자리처럼 figure 안 문단으로).
 */
function replaceScreens(html: string, data: ReadonlyMap<string, { url: string; width: number | null } | null>): InlinedScreens {
  let inlined = 0
  let dropped = 0
  let droppedMaps = 0
  const drop = (src: string) => {
    dropped += 1
    if (MAP_PATH.test(src)) droppedMaps += 1
  }
  const out = html
    .replace(FIGURE_IMG, (whole, src: string, alt: string) => {
      if (data.get(src)) return whole
      drop(src)
      return `<figure class="image-slot"><p>${appImagePlaceholder(src, alt)}</p>`
    })
    .replace(ANY_IMG, (_whole, src: string, alt: string, rest: string) => {
      const got = data.get(src)
      if (got) {
        inlined += 1
        return `<img src="${got.url}" alt="${alt}"${notWider(rest, got.width)}>`
      }
      drop(src)
      return appImagePlaceholder(src, alt)
    })
  return { html: out, inlined, dropped, droppedMaps }
}

/**
 * 앱 안 글 미리보기(콘텐츠 보관함 「본문 보기」 · 올리기 목록의 줄 미리보기)의 HTML — 화면 그림을 「[화면: 이름]」 글자로 둔다. 미리보기는
 * 복사가 막혔을 때 골라 복사하는 곳이기도 해서, 앱 주소 그림을 그리면 그 주소(http://localhost:…/api/screens/…)가 블로그로 나간다.
 * 화면이 없으면 그대로.
 */
export function screenPreviewHtml(html: string): string {
  return APP_PATH.test(html) ? replaceScreens(html, new Map()).html : html
}

/**
 * 서식째 복사할 글 — 서식(HTML)의 화면 그림은 문서 안(data:)에, 글자(마크다운)에는 「[화면: 이름]」. 화면이 없으면 받은 그대로.
 * src/lib/clipboard.ts copyRich 바로 앞에서 부른다.
 */
export async function richCopyWithScreens(markdown: string, html: string, fetcher: ScreenFetcher): Promise<{ markdown: string } & InlinedScreens> {
  const plain = screenPlainText(markdown)
  if (APP_PATH.test(plain)) throw new Error('복사할 글에 앱 안에서만 열리는 화면 주소(/api/screens/)가 남았어요 — 복사하지 않았어요.')
  const inlined = await inlineScreens(html, fetcher)
  return { markdown: plain, ...inlined }
}

/**
 * 화면 · 지도 그림을 넣지 못한 내보내기의 알림 — 서식째 복사 · 홈페이지용 .html(DraftPanel · ContentLibrary · PublishList) · 작성자 묶음
 * (GapActions — from은 「같은 폴더의」). dropped는 넣지 못한 그림 수(화면 + 지도), droppedMaps는 그 가운데 지도 수. 그 자리에는
 * 「[화면: 이름]」 · 「[지도: …]」 글자가 들어갔다(지도의 출처 줄은 그 아래 그대로).
 */
export function screensDroppedText(dropped: number, droppedMaps = 0, from = '「사진 N장 받기」로 받은'): string {
  const screens = dropped - droppedMaps
  const maps = droppedMaps
  const what =
    screens && maps
      ? `자사 화면 ${screens}장 · ${MAP_AREA_NAME} 지도 ${maps}장은 그림을 받지 못해 「[화면: 이름]」 · 「[지도: …]」 글자로 두었어요(지도 출처 줄은 그대로예요)`
      : maps
        ? `${MAP_AREA_NAME} 지도 ${maps}장은 그림을 받지 못해 「[지도: …]」 글자로 두었어요(출처 줄은 그대로예요)`
        : `자사 화면 ${screens}장은 그림을 받지 못해 「[화면: 이름]」 글자로 두었어요`
  return `${what} — 그 자리에 ${from} ${screens && maps ? '화면 · 지도' : maps ? '지도' : '화면'} 파일을 올려 주세요.`
}

/**
 * 내보낸 글에 남으면 안 되는 주소 — 앱 주소(/api/screens/) · 이 PC의 주소(127.0.0.1 · localhost). 찾은 것(중복 없이)을 돌려준다.
 * 검증 스크립트가 내보낸 결과를 이것으로 확인한다.
 */
export function exportLeaks(text: string): string[] {
  return [...new Set(text.match(/\/api\/(?:screens|maps|owner-photos)\/|127\.0\.0\.1|localhost/gi) ?? [])]
}
