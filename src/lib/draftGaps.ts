import type { ContentDraft } from '../prompts/b9c-content-draft'
import type { GapFill, StoredDraft } from './api'
import { countGapNotes, draftToMarkdown, draftToPublishMarkdown, stripGapNotes } from './markdownFile'

/**
 * 초안 빈칸을 화면에서 채운 기록(gapFills)을 원고에 반영한다.
 *
 * 빈칸은 문장 속 한 단어가 아니라 **문단 하나를 비운 자리**다(판정 엔진이 사실이 없어 쓰지 못한 문단).
 * 그래서 값만 넣으면 문장이 되지 않는다. 예전에는 값을 브랜드 사실로 저장하고 초안을 통째로 다시
 * 썼다(판정 1~2회, 1~2분). 이제 그 자리에 「항목: 값」 한 줄을 넣는다 — 다시 쓰지 않고, 어색하면
 * 사람이 그 줄만 고친다. 넣은 값은 브랜드 사실에도 들어가 다음 초안부터는 처음부터 문장으로 쓰인다.
 *
 * 복사·.md·.html·보관함·묶음 내려받기가 모두 이 결과를 쓴다 — 한 곳이라도 원본을 쓰면 채운 값이
 * 그 내보내기에서만 빠진다.
 */

/** 빈칸 자리의 키 — 그 초안 안에서만 뜻이 있다(다시 만들면 기록을 버린다). */
export function gapKey(sectionIndex: number, blockIndex: number): string {
  return `${sectionIndex}:${blockIndex}`
}

/**
 * 빈칸 메모의 항목 이름 — "매몰법 및 절개법 수술 비용 — 팩트 그래프에 가격 항목 없음"의 앞부분.
 * 뒷부분은 운영자용 설명이라 원고에 싣지 않는다.
 */
export function claimOf(need: string): string {
  return need.split(/\s[—–]\s/)[0]!.trim() || need.trim()
}

/** 채운 빈칸이 원고에 들어가는 모양. */
export function filledLine(need: string, value: string): string {
  return `${claimOf(need)}: ${value}`
}

/** 채운 값은 문장으로, 뺀 빈칸은 지운 초안. 확인 전 후보(suggested)는 아직 빈칸이다. */
export function applyGapFills(draft: ContentDraft, fills: Record<string, GapFill> | undefined): ContentDraft {
  if (!fills || !Object.keys(fills).length) return draft
  let gapCount = 0
  const sections = draft.sections.map((sec, si) => ({
    ...sec,
    blocks: sec.blocks.flatMap((b, bi) => {
      if (b.kind !== 'gap') return [b]
      const f = fills[gapKey(si, bi)]
      if (f?.omit) return []
      if (f?.value) return [{ kind: 'text' as const, body: filledLine(b.need ?? '', f.value) }]
      gapCount += 1
      return [b]
    }),
  }))
  return { ...draft, sections, gapCount }
}

export function effectiveDraft(stored: StoredDraft): ContentDraft {
  return applyGapFills(stored.draft, stored.gapFills)
}

/** 작업용 원고(남은 빈칸 표시 포함). 고쳐 둔 글이 있으면 그것. */
export function workMarkdownOf(stored: StoredDraft): string {
  return stored.editedMarkdown ?? draftToMarkdown(effectiveDraft(stored))
}

/** 발행용 원고 — 남은 빈칸 줄과 「이 글이 쓴 사실」을 뺀다. 복사·.md·.html이 같은 원고를 쓴다. */
export function publishMarkdownOf(stored: StoredDraft): string {
  return stored.editedMarkdown ? stripGapNotes(stored.editedMarkdown) : draftToPublishMarkdown(effectiveDraft(stored))
}

/**
 * 빈칸 진행 — 단계 띠의 「빈칸 확인 m/n」.
 * 고쳐 둔 글은 구조가 아니라 글자라서 처음 몇 곳이었는지 모른다 — 남은 표시 줄만 센다.
 */
export function gapProgress(stored: StoredDraft): { total: number; done: number; suggested: number; edited: boolean } {
  if (stored.editedMarkdown) {
    const left = countGapNotes(stored.editedMarkdown)
    return { total: left, done: 0, suggested: 0, edited: true }
  }
  let total = 0
  let done = 0
  let suggested = 0
  stored.draft.sections.forEach((sec, si) =>
    sec.blocks.forEach((b, bi) => {
      if (b.kind !== 'gap') return
      total += 1
      const f = stored.gapFills?.[gapKey(si, bi)]
      if (f?.value || f?.omit) done += 1
      else if (f?.suggested) suggested += 1
    }),
  )
  return { total, done, suggested, edited: false }
}
