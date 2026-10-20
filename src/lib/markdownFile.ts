import type { ContentDraft, DraftBlock, DraftImage } from '../prompts/b9c-content-draft'
import type { StoredDraft } from './api'
import { articleSources, sourcesLine } from './officialSources'

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

/** 파일 이름에 쓸 수 없는 글자를 덜어낸다. 한글·숫자·점·하이픈은 남긴다. */
export function safeFileName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '-').slice(0, 60)
}

/** 본문에 남는 빈칸 표시. 발행용에서 걷어낼 때도 이 모양을 찾는다. */
const GAP_LINE = '> **채워야 함:**'

/**
 * 사람이 사진을 넣을 자리의 주소 — `![대체 텍스트](#image-slot)`. 글은 사진을 만들지 않는다(직접 찍거나 고른 사진을
 * 올린다). htmlFile.ts가 이 주소를 「사진 넣을 자리」로 낸다. 주소를 https로 바꾸면 그대로 사진이 된다.
 */
export const IMAGE_SLOT = '#image-slot'
const IMAGE_SLOT_LINE = /^!\[[^\]]*\]\(#image-slot\)$/

/**
 * 고친 블로그 글 형식 원고의 발행본 정리 — 빈칸 줄을 걷은 원고(stripGapNotes)에서 본문이 없는 절(소제목 · 사진 자리 · 참고 줄만
 * 남은 절)을 빼고, 남은 「## n.」 번호를 1부터 다시 매기고, 제목이 {N} 틀(titleTemplate)이면 그 수를 실린 절 수로 맞춘다.
 * 작업용 원고는 채울 곳이 보이게 빈칸만 있는 절에도 번호를 달고 그 절까지 센다 — 고친 글을 그대로 내보내면 빈 소제목과 틀린
 * 수가 나간다. 사람이 번호를 지운 소제목은 그대로 둔다.
 */
export function tidyArticleMarkdown(markdown: string, titleTemplate: string): string {
  const lines = withoutUsedFacts(markdown.split('\n'))
  const isHeading = (l: string) => /^#{1,2}\s/.test(l)
  // 본문이 아닌 줄 — 빈 줄, 사진 자리, 사진 자리 바로 아래 설명 줄, 공식 출처 「참고:」 줄(링크만 있는 모양). 사람이 쓴 「참고: …」
  // 문장이나 기울임 문단은 본문이다.
  const isFiller = (l: string, prev: string) => {
    const t = l.trim()
    if (!t || IMAGE_SLOT_LINE.test(t) || SOURCES_LINE.test(t)) return true
    return /^\*(?!\*)(.+?)\*$/.test(t) && IMAGE_SLOT_LINE.test(prev.trim())
  }
  const kept: string[] = []
  for (let i = 0; i < lines.length; ) {
    if (/^##\s/.test(lines[i]!)) {
      let j = i + 1
      while (j < lines.length && !isHeading(lines[j]!)) j += 1
      const body = lines.slice(i + 1, j)
      if (!body.every((l, k) => isFiller(l, k > 0 ? body[k - 1]! : ''))) kept.push(lines[i]!, ...body)
      i = j
      continue
    }
    kept.push(lines[i]!)
    i += 1
  }
  let n = 0
  const numbered = kept.map((l) => (/^##\s+\d+\.\s/.test(l) ? l.replace(/^##\s+\d+\.\s/, () => `## ${(n += 1)}. `) : l))
  const parts = titleTemplate.split('{N}')
  if (parts.length > 1 && n > 0) {
    const shape = new RegExp(`^#\\s+${parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\d+')}\\s*$`)
    const h1 = numbered.findIndex((l) => shape.test(l))
    if (h1 >= 0) numbered[h1] = `# ${fillTitleCount(titleTemplate, n)}`
  }
  return numbered.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
}

/**
 * 작업용 원고 끝의 「이 글이 쓴 사실」(앞의 --- 와 목록까지)을 뺀다 — 검증할 때 보는 목록이지 독자에게 할 말이 아니다(발행용
 * draftToPublishMarkdown과 같은 원칙). 작업용 원고를 그대로 고쳐 저장하면 이 목록이 함께 들어온다.
 */
function withoutUsedFacts(lines: string[]): string[] {
  const at = lines.findIndex((l) => l.trim() === USED_FACTS_LINE)
  if (at < 0) return lines
  let start = at
  while (start > 0 && !lines[start - 1]!.trim()) start -= 1
  if (start > 0 && /^-{3,}$/.test(lines[start - 1]!.trim())) start -= 1
  // 목록은 이름표 바로 아래 이어진 「- 」 줄까지만 — 빈 줄 뒤는 사람이 덧붙인 본문일 수 있다.
  let end = at + 1
  while (end < lines.length && /^\s*-\s/.test(lines[end]!)) end += 1
  return [...lines.slice(0, start), ...lines.slice(end)]
}
const USED_FACTS_LINE = '**이 글이 쓴 사실**'
/** 공식 출처 「참고:」 줄의 모양(src/lib/officialSources.ts sourcesLine) — 링크만으로 된 줄. */
const SOURCES_LINE = /^참고:\s*\[[^\]]+\]\(https?:[^)\s]+\)(?:\s·\s\[[^\]]+\]\(https?:[^)\s]+\))*$/

/** 글에 남은 사진 자리 수 — 올리기 목록이 「사진 넣을 곳 N곳」으로 알린다. */
export function countImageSlots(markdown: string): number {
  return markdown.split('\n').filter((line) => IMAGE_SLOT_LINE.test(line.trim())).length
}

/** 「… {N}가지」 제목의 {N}을 실린 절 수로 바꾼다. 글쓰기 엔진은 숫자를 쓰지 않고 {N}만 남긴다(b9c 규칙 8). */
export function fillTitleCount(title: string, count: number): string {
  return title.split('{N}').join(String(count))
}

/** 발행본에 실리는 절 — 빈칸이 아닌 문단이 하나라도 있는 절과 그 문단. si는 d.sections 안 순서. */
function publishedSections(d: ContentDraft) {
  return d.sections
    .map((sec, si) => ({ sec, si, blocks: sec.blocks.filter((b) => b.kind !== 'gap' && (b.body ?? '').trim()) }))
    .filter((s) => s.blocks.length > 0)
}

/** 화면 · 파일 이름에 쓰는 제목 — 블로그 글 형식이면 {N}을 발행본에 실릴 절 수로 채운다. 옛 형식은 그대로. */
export function draftTitle(d: ContentDraft): string {
  return d.format === 'article' ? fillTitleCount(d.title, publishedSections(d).length) : d.title
}

/** 블로그 글 형식의 문단 한 칸 — 핵심 문장은 굵게, 그대로 쓸 말은 인용, 빈칸은 빈칸 표시. */
function articleBlockLine(b: DraftBlock): string {
  if (b.kind === 'gap') return `${GAP_LINE} ${b.need ?? ''}`
  const body = b.body ?? ''
  if (b.role === 'key') return `**${body}**`
  if (b.role === 'quote') return `> ${body}`
  return body
}

/** 사진 자리 줄 — 장면은 대체 텍스트로, 설명은 바로 아랫줄 `*설명*`(htmlFile.ts가 figcaption으로 낸다). */
function imageLines(image: DraftImage): string[] {
  return [`![${image.alt}](${IMAGE_SLOT})`, ...(image.caption ? [`*${image.caption}*`] : [])]
}

/**
 * 블로그 글 형식(format 'article') — 실린 절에 순서대로 번호를 붙이고(엔진은 번호를 쓰지 않는다), 사진 자리와 공식 출처
 * 「참고:」 줄(src/lib/officialSources.ts)은 절 끝에. publish면 옛 형식과 같은 원칙으로 빈칸 줄 · 빈칸만 있던 절 · 「이 글이
 * 쓴 사실」을 뺀다. 문단이 하나도 없는 절(빈칸을 모두 뺀 절)은 작업용에서도 뺀다 — 번호가 비지 않게.
 */
function articleMarkdown(d: ContentDraft, publish: boolean): string {
  const shown = publish
    ? publishedSections(d)
    : d.sections.map((sec, si) => ({ sec, si, blocks: sec.blocks })).filter((s) => s.blocks.length > 0)
  const sources = articleSources(d)
  const L: string[] = [`# ${fillTitleCount(d.title, shown.length)}`, '']
  if (d.lead) L.push(d.lead, '')
  shown.forEach(({ sec, si, blocks }, i) => {
    L.push(`## ${i + 1}. ${sec.heading}`, '')
    for (const b of blocks) L.push(articleBlockLine(b), '')
    if (sec.image) L.push(...imageLines(sec.image), '')
    if (sources[si]?.length) L.push(sourcesLine(sources[si]), '')
  })
  if (publish) return L.join('\n').trimEnd() + '\n'
  if (d.usedFacts.length) L.push('---', '', '**이 글이 쓴 사실**', ...d.usedFacts.map((f) => `- ${f}`), '')
  return L.join('\n')
}

/** 초안을 마크다운으로. 빈 자리는 표시를 남긴 채 내보낸다 — 지우면 채울 곳을 잃는다. */
export function draftToMarkdown(d: StoredDraft['draft']): string {
  if (d.format === 'article') return articleMarkdown(d, false)
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
  if (d.format === 'article') return articleMarkdown(d, true)
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
  return gapNoteLines(markdown).length
}

/** 남은 빈칸 줄마다 무엇을 채워야 하는지(「채워야 함:」 뒤) — 보관함 본문 보기가 어디가 비었는지 보인다. */
export function gapNoteLines(markdown: string): string[] {
  return markdown
    .split('\n')
    .map((line) => line.trimStart())
    .filter((line) => line.startsWith(GAP_LINE))
    .map((line) => line.slice(GAP_LINE.length).trim())
}
