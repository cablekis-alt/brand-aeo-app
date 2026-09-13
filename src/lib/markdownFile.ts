import type { StoredDraft } from './api'

/**
 * 마크다운 파일로 내보내기 — 화면 부품과 떼어 둔다.
 *
 * DraftPanel.tsx에 함께 두었더니 한 파일이 컴포넌트와 함수를 같이 내보내 Fast Refresh가
 * 깨졌다(react-refresh/only-export-components). 고쳐 쓰는 화면에서 새로고침이 되살아나면
 * 편집 중이던 초안이 날아간다.
 */

/**
 * 초안 패널 — 실행 항목에서도, 질문 은행에서도 쓴다.
 *
 * 두 화면이 같은 부품을 쓰는 이유: 측정 전에 질문을 골라 쓰는 글과 측정 후 실행 항목에서 쓰는
 * 글은 **만드는 방식이 같다**. 다른 것은 질문을 어디서 고르느냐뿐이다. 두 벌로 두면 빈칸
 * 채우기 같은 기능이 한쪽에만 생긴다.
 */
/**
 * 마크다운을 .md 파일로 내려받는다.
 *
 * 복사만 있으면 붙여 넣을 창이 열려 있을 때만 쓸모가 있다. 팀원에게 넘기거나 보관하려면
 * 파일이 필요하고, 클립보드 접근이 막힌 환경에서는 복사 자체가 실패한다(그때 대안이 없었다).
 * 문자열은 이미 만들고 있으므로 저장만 붙인다.
 */
export function downloadMarkdown(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
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

/** 파일 이름에 쓸 수 없는 글자를 덜어낸다. 한글·숫자·점·하이픈은 남긴다. */
export function safeFileName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '-').slice(0, 60)
}

/** 초안을 마크다운으로. 빈 자리는 표시를 남긴 채 내보낸다 — 지우면 채울 곳을 잃는다. */
export function draftToMarkdown(d: StoredDraft['draft']): string {
  const L: string[] = [`# ${d.title}`, '']
  if (d.lead) L.push(d.lead, '')
  for (const sec of d.sections) {
    L.push(`## ${sec.heading}`)
    for (const b of sec.blocks) {
      L.push(b.kind === 'gap' ? `> **채워야 함:** ${b.need ?? ''}` : (b.body ?? ''))
      L.push('')
    }
  }
  if (d.usedFacts.length) L.push('---', '', '**이 글이 쓴 사실**', ...d.usedFacts.map((f) => `- ${f}`), '')
  return L.join('\n')
}
