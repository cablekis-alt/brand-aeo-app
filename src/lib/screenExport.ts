/**
 * 자사 화면 내보내기 — 글의 사진 기록에는 자사 화면의 앱 주소(/api/screens/<tenant>/<id>.png)만 있다(2026-11-04 결정 1). 앱 안
 * 미리보기는 같은 출처라 그 주소로 바로 보이지만, 앱 밖으로 나가는 글(홈페이지용 .html · 서식째 복사 · 작성자 묶음의 .html)에 그 주소가
 * 남으면 운영자 PC에서만 보이고 독자에게는 깨진다. 그래서 내보낼 때 그림을 받아 data:image/png로 문서 안에 넣는다(inlineScreens). 받지
 * 못한 화면은 그림을 빼고 「[화면: 이름]」 글자로 둔다 — 앱 주소를 남기지 않는다. 서식째 복사의 글자 쪽(text/plain — 마크다운)에는
 * 그림 대신 「[화면: 이름]」을 넣는다(screenPlainText).
 *
 * 네이버 SmartEditor ONE · 티스토리가 붙여 넣은 data: 그림을 받는지는 아직 모른다(결정 2) — 그때까지 기본 전달은 「사진 N장 받기」
 * 파일이다(서버 photo-file이 이 PC의 화면 파일을 준다). 「사진 N장 받기」 · 작성자 묶음의 사진 파일은 여기를 거치지 않는다.
 *
 * DOM을 쓰지 않는다(검증 스크립트가 Node에서 부른다).
 */

/** 앱 주소의 화면 그림을 받는다 — 앱에서는 src/lib/api.ts fetchScreenFile. 실패하면 throw. */
export type ScreenFetcher = (src: string) => Promise<Blob>

/** 앱 밖으로 나간 글에 남으면 안 되는 앱 주소. */
const APP_PATH = /\/api\/screens\//
/** 본문 HTML(src/lib/htmlFile.ts markdownToHtml)의 화면 그림 — 그림 줄(figure)은 img가 figure 바로 안에 있다. */
const FIGURE_IMG = /<figure><img src="(\/api\/screens\/[^"]*)" alt="([^"]*)"[^>]*>/g
const ANY_IMG = /<img src="(\/api\/screens\/[^"]*)" alt="([^"]*)"([^>]*)>/g
/** 마크다운의 화면 그림 — `![이름](앱 주소)`. */
const MD_IMG = /!\[([^\]]*)\]\((\/api\/screens\/[^)\s]*)\)/g
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

/** 서식째 복사의 글자 쪽(마크다운) — 화면 그림을 「[화면: 이름]」으로. 화면이 없으면 그대로(바이트까지 같게). */
export function screenPlainText(markdown: string): string {
  return markdown.replace(MD_IMG, (_whole, alt: string) => screenPlaceholder(alt))
}

function base64Of(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** 받은 화면 그림을 data:image/png로 — PNG가 아니거나 비었거나 너무 크면 throw. */
async function dataUrlOf(blob: Blob): Promise<string> {
  if (blob.type && blob.type !== 'image/png') throw new Error(`PNG가 아닌 응답이에요(${blob.type}).`)
  if (!blob.size || blob.size > MAX_SCREEN_BYTES) throw new Error(`화면 그림 크기가 맞지 않아요(${blob.size}바이트).`)
  const bytes = new Uint8Array(await blob.arrayBuffer())
  if (!PNG_SIG.every((b, i) => bytes[i] === b)) throw new Error('PNG가 아닌 그림이에요.')
  return `data:image/png;base64,${base64Of(bytes)}`
}

export interface InlinedScreens {
  html: string
  /** 문서 안에 넣은 화면 그림 수(같은 화면이 두 번이면 두 번). */
  inlined: number
  /** 받지 못해 「[화면: 이름]」 글자로 바꾼 화면 그림 수. */
  dropped: number
}

/**
 * 내보낼 HTML(본문 · 완성 문서)의 자사 화면 그림을 문서 안(data:image/png)에 넣는다 — 같은 화면은 한 번만 받는다. 받지 못한 화면은 그림을
 * 빼고 「[화면: 이름]」 글자로 둔다(그림 줄이면 사진 자리처럼 figure 안 문단으로). 그래도 앱 주소가 남으면(본문 글자 등) throw — 앱 주소가
 * 든 글을 내보내지 않는다. 화면이 없으면 그대로.
 */
export async function inlineScreens(html: string, fetcher: ScreenFetcher): Promise<InlinedScreens> {
  if (!APP_PATH.test(html)) return { html, inlined: 0, dropped: 0 }
  const srcs = new Set([...html.matchAll(ANY_IMG)].map((m) => m[1]!))
  const data = new Map<string, string | null>()
  for (const src of srcs) {
    try {
      // HTML 속성 안의 주소라 &amp;가 있을 수 있다(앱 주소에는 없지만 되돌려 받는다).
      data.set(src, await dataUrlOf(await fetcher(src.replace(/&amp;/g, '&'))))
    } catch (err) {
      console.warn(`[screenExport] 화면 그림 ${src}을 받지 못해 「[화면: …]」 글자로 둡니다`, err)
      data.set(src, null)
    }
  }
  let inlined = 0
  let dropped = 0
  const out = html
    .replace(FIGURE_IMG, (whole, src: string, alt: string) => {
      if (data.get(src)) return whole
      dropped += 1
      return `<figure class="image-slot"><p>${screenPlaceholder(alt)}</p>`
    })
    .replace(ANY_IMG, (_whole, src: string, alt: string, rest: string) => {
      const url = data.get(src)
      if (url) {
        inlined += 1
        return `<img src="${url}" alt="${alt}"${rest}>`
      }
      dropped += 1
      return screenPlaceholder(alt)
    })
  if (APP_PATH.test(out)) throw new Error('내보낼 글에 앱 안에서만 열리는 화면 주소(/api/screens/)가 남았어요 — 화면을 넣지 못해 내보내지 않았어요.')
  return { html: out, inlined, dropped }
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
 * 내보낸 글에 남으면 안 되는 주소 — 앱 주소(/api/screens/) · 이 PC의 주소(127.0.0.1 · localhost). 찾은 것(중복 없이)을 돌려준다.
 * 검증 스크립트가 내보낸 결과를 이것으로 확인한다.
 */
export function exportLeaks(text: string): string[] {
  return [...new Set(text.match(/\/api\/screens\/|127\.0\.0\.1|localhost/gi) ?? [])]
}
