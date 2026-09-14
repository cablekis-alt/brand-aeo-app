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

/** 본문에 남는 빈칸 표시. 발행용에서 걷어낼 때도 이 모양을 찾는다. */
const GAP_LINE = '> **채워야 함:**'

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

/**
 * 발행용 마크다운 — 작업용 메모를 뺀 원고.
 *
 * 빈칸을 채우지 못한 채 올려야 할 때가 있다(모르는 값, 병원이 공개하지 않는 가격 등). 그때
 * 지어내지 않고 비우는 것이 맞는데, 비운 자리 표시까지 함께 나가면 그대로 올릴 수 없다.
 * 실제로 `> **채워야 함:** … 팩트 그래프에 가격 항목 없음`이 본문에 그대로 실려 나갔다.
 *
 * 빈칸만 있던 절은 제목까지 덜어낸다 — 본문 없는 h2가 남으면 글이 망가진 것처럼 보인다.
 * 「이 글이 쓴 사실」도 뺀다. 어떤 사실을 썼는지는 우리가 검증할 때 보는 것이지 독자에게 할
 * 말이 아니다(화면에는 그대로 남는다).
 */
export function draftToPublishMarkdown(d: StoredDraft['draft']): string {
  const L: string[] = [`# ${d.title}`, '']
  if (d.lead) L.push(d.lead, '')
  for (const sec of d.sections) {
    const body = sec.blocks.filter((b) => b.kind !== 'gap' && (b.body ?? '').trim())
    if (!body.length) continue
    L.push(`## ${sec.heading}`, '')
    for (const b of body) L.push(b.body ?? '', '')
  }
  return L.join('\n').trimEnd() + '\n'
}

/**
 * 고쳐 둔 글에서 빈칸 표시 줄만 걷어낸다. 편집하면서 일부만 지웠을 수 있으므로 구조가 아니라
 * 글자로 찾는다. 표시가 사라진 자리에 빈 줄이 겹치면 하나로 줄인다.
 */
export function stripGapNotes(markdown: string): string {
  return markdown
    .split('\n')
    .filter((line) => !line.trimStart().startsWith(GAP_LINE))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}

/** 발행용으로 내보낼 때 덜어낼 빈칸이 몇 줄인지 — 버튼 옆에 알린다. */
export function countGapNotes(markdown: string): number {
  return markdown.split('\n').filter((line) => line.trimStart().startsWith(GAP_LINE)).length
}
