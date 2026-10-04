/**
 * 서식째 복사 — 서식(HTML)과 글자(마크다운)를 함께 넣는다. 붙여 넣는 편집기가 고른다. 네이버 블로그·티스토리
 * 편집기에 붙여도 제목·굵은 글씨가 남는다(마크다운만 넣으면 #·** 기호가 글자로 남았다).
 *
 * 클립보드 쓰기 권한이 막힌 환경(실측: 미리보기 브라우저 NotAllowedError)에서는 화면 밖에 본문을 그려
 * 선택한 뒤 복사한다 — 이 길도 서식이 남는다. html은 우리 원고에서 만든(이스케이프된) 것만 넣는다
 * (lib/htmlFile.ts markdownToHtml).
 *
 * @returns 복사했으면 true
 */
export async function copyRich(markdown: string, html: string): Promise<boolean> {
  try {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) throw new Error('ClipboardItem 없음')
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([markdown], { type: 'text/plain' }),
      }),
    ])
    return true
  } catch (e) {
    console.warn('[clipboard] 클립보드 API로 복사하지 못해 선택 복사로 넘어갑니다', e)
    return copyBySelection(html)
  }
}

function copyBySelection(html: string): boolean {
  const box = document.createElement('div')
  box.contentEditable = 'true'
  box.style.position = 'fixed'
  box.style.left = '-9999px'
  box.style.top = '0'
  box.innerHTML = html
  document.body.appendChild(box)
  const selection = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(box)
  selection?.removeAllRanges()
  selection?.addRange(range)
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch (e) {
    console.error('[clipboard] 선택 복사 실패', e)
  }
  selection?.removeAllRanges()
  box.remove()
  return ok
}
