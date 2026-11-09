/**
 * 파일 내려받기 — 브라우저 전용(document · window). src/lib/markdownFile.ts에서 떼어 냈다: 서버도 그 파일의 제목 규칙(draftTitle)을
 * 쓰는데(발행 현황 「주소 한꺼번에 등록」 — src/lib/postRegistration.ts · server/postImport.ts), 서버 타입 검사(tsconfig.server.json)에는
 * DOM이 없다.
 */

/**
 * 완성된 HTML 문서를 .html로 내려받는다(src/lib/htmlFile.ts가 만든 문자열). 글 내보내기는 「블로그는 복사 · 홈페이지는
 * .html」이라 .md 파일은 내지 않는다 — 일반 사용자는 .md를 열기 어렵고, 블로그 편집기에 붙이면 # · ** 기호가 남는다(2026-10-20).
 */
export function downloadHtml(filename: string, html: string): void {
  downloadTextFile(filename, html, 'text/html;charset=utf-8')
}

/** CSV를 .csv로 내려받는다(BOM은 만드는 쪽이 붙인다 — src/lib/answerInsights.ts answersCsv). */
export function downloadCsv(filename: string, csv: string): void {
  downloadTextFile(filename, csv, 'text/csv;charset=utf-8')
}

function downloadTextFile(filename: string, text: string, mime: string): void {
  downloadBlob(filename, new Blob([text], { type: mime }))
}

/** 파일 하나를 내려받는다(글자 · 사진 공통). */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 즉시 해제하면 브라우저가 저장을 시작하기 전에 사라질 수 있다.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
