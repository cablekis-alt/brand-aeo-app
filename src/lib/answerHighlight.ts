/**
 * 답변 원문 위의 하이라이트 — **이미 판정된 것만** 칠한다.
 *
 * 원문을 보여 주는 목적은 "판정이 진짜인지" 고객이 눈으로 확인하게 하는 것이다. 그러니
 * 여기서 새로 판단하면 안 된다. 칠할 구간은 전부 저장된 판정에서 온 문자열이고, 원문에서
 * 그 문자열을 못 찾으면 **칠하지 않는다**(비슷한 곳을 찾아 칠하지 않는다 — 그러면 화면이
 * 판정에 없는 것을 판정인 양 보여 주게 된다). 몇 개를 못 찾았는지는 화면이 밝힌다.
 */
export type MarkKind = 'wrong' | 'mention' | 'competitor'

export interface Mark {
  start: number
  end: number
  kind: MarkKind
}

export interface Segment {
  text: string
  kind: MarkKind | null
}

/** 겹칠 때 이기는 순서. 사실 오류가 가장 중요하다 — 언급 문장 안에 오류가 들어 있는 경우가 많다. */
const PRIORITY: Record<MarkKind, number> = { wrong: 0, mention: 1, competitor: 2 }

/** 원문에서 needle의 위치. 공백이 접히거나 마크다운이 섞여 정확히 안 맞는 경우가 흔해 실패를 허용한다. */
function findRange(text: string, needle: string): { start: number; end: number } | null {
  const t = needle.trim()
  if (t.length < 4) return null // 너무 짧으면 엉뚱한 곳에 걸린다
  const i = text.indexOf(t)
  if (i >= 0) return { start: i, end: i + t.length }
  // 공백만 다른 경우를 한 번 더 시도한다(줄바꿈이 섞인 문장).
  const loose = t.replace(/\s+/g, ' ')
  const flat = text.replace(/\s+/g, ' ')
  const j = flat.indexOf(loose)
  if (j < 0) return null
  // 접은 좌표를 원문 좌표로 되돌린다 — 접기 전 몇 글자였는지 세어 올라간다.
  let orig = 0
  let folded = 0
  while (orig < text.length && folded < j) {
    if (/\s/.test(text[orig]!)) {
      while (orig < text.length && /\s/.test(text[orig]!)) orig += 1
      folded += 1
    } else {
      orig += 1
      folded += 1
    }
  }
  const start = orig
  let end = start
  let need = loose.length
  while (end < text.length && need > 0) {
    if (/\s/.test(text[end]!)) {
      while (end < text.length && /\s/.test(text[end]!)) end += 1
      need -= 1
    } else {
      end += 1
      need -= 1
    }
  }
  return { start, end: Math.min(end, text.length) }
}

/**
 * 원문을 하이라이트 구간으로 쪼갠다.
 * @returns segments와, 찾지 못해 칠하지 못한 개수(화면이 그대로 밝힌다)
 */
export function highlightAnswer(
  text: string,
  needles: { text: string; kind: MarkKind }[],
): { segments: Segment[]; missed: number } {
  const marks: Mark[] = []
  let missed = 0
  for (const n of needles) {
    const r = findRange(text, n.text)
    if (!r) {
      missed += 1
      continue
    }
    marks.push({ ...r, kind: n.kind })
  }
  // 겹치는 구간은 우선순위가 높은 쪽만 남긴다. 부분 겹침을 잘라 붙이면 문장이 조각나 읽기 어렵다.
  marks.sort((a, b) => a.start - b.start || PRIORITY[a.kind] - PRIORITY[b.kind])
  const kept: Mark[] = []
  for (const m of marks) {
    const clash = kept.find((k) => m.start < k.end && k.start < m.end)
    if (!clash) {
      kept.push(m)
      continue
    }
    if (PRIORITY[m.kind] < PRIORITY[clash.kind]) {
      kept.splice(kept.indexOf(clash), 1, m)
    }
  }
  kept.sort((a, b) => a.start - b.start)

  const segments: Segment[] = []
  let cursor = 0
  for (const m of kept) {
    if (m.start > cursor) segments.push({ text: text.slice(cursor, m.start), kind: null })
    segments.push({ text: text.slice(m.start, m.end), kind: m.kind })
    cursor = m.end
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), kind: null })
  return { segments, missed }
}

/** 표 구분 줄(|---|:---:|) — 글자가 없어 통째로 뺀다. */
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/

/**
 * 줄마다 마크다운 기호를 걷는다 — 굵게(**, __), 제목(###), 표 구분 줄, 표 칸 막대(「| 객실 | 독채 |」 → 「객실 · 독채」). 글자는 그대로 둔다.
 * startsLine이 false면 첫 줄은 줄 가운데서 시작한 조각이라 줄 처음 기호(제목 · 앞 막대)를 걷지 않는다.
 */
function tidyLines(text: string, startsLine: boolean): string {
  return text
    .split('\n')
    .map((line, i) => {
      let l = line.replace(/\*\*|__/g, '')
      if (i > 0 || startsLine) {
        if (TABLE_RULE.test(l)) return null
        l = l.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/^\s*\|\s*/, '')
      }
      return l.replace(/\s*\|\s*$/, '').replace(/\s+\|\s+/g, ' · ')
    })
    .filter((l): l is string => l !== null)
    .join('\n')
}

/** AI 답변 문장 하나를 화면에 보일 글로 — 브랜드 종합 진단 · EEAT 분석의 인용문(상용화 UI 3차 U23: 「**」 · 「###」 · 표 줄이 그대로 보였다). */
export const tidyMarkdown = (text: string) => tidyLines(text, true)

/**
 * 하이라이트를 칠한 원문 조각들에서 마크다운 기호를 걷는다. 칠할 구간은 원문 그대로에서 찾고(먼저 걷으면 판정 문장과 위치가
 * 어긋난다) 화면에 보이기 직전에 조각마다 걷는다 — 칠한 글자는 그대로 남는다. 줄 처음 기호는 그 조각이 줄 처음에서 시작할 때만.
 */
export function tidySegments(segments: Segment[]): Segment[] {
  let atLineStart = true
  return segments.map((seg) => {
    const text = tidyLines(seg.text, atLineStart)
    if (seg.text.length > 0) atLineStart = seg.text.endsWith('\n')
    return { ...seg, text }
  })
}
