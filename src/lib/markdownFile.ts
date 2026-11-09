import type { ContentDraft, DraftBlock, DraftImage, DraftSection } from '../prompts/b9c-content-draft'
import type { StoredDraft } from './api'
import { articleSources, sourcesLine, type OfficialSource } from './officialSources'

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
 *
 * 내려받기(downloadHtml · downloadCsv · downloadBlob)는 src/lib/fileDownload.ts에 있다 — 이 파일은 DOM 없이 서버도 쓴다(draftTitle).
 */

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
 * 고친 블로그 글 형식 원고의 발행본 정리 — 빈칸 줄을 걷은 원고(stripGapNotes)에서 고아 자리(withoutOrphans)를 덜고, 본문이 없는
 * 절(소제목 · 사진 자리 · 참고 줄만 남은 절)을 빼고, 남은 「## n.」 번호를 1부터 다시 매기고, 제목이 {N} 틀(titleTemplate)이면 그
 * 수를 실린 절 수로 맞춘다. 작업용 원고는 채울 곳이 보이게 빈칸만 있는 절에도 번호를 달고 그 절까지 센다 — 고친 글을 그대로
 * 내보내면 빈 소제목과 틀린 수가 나간다. 사람이 번호를 지운 소제목은 그대로 둔다.
 */
export function tidyArticleMarkdown(markdown: string, titleTemplate: string): string {
  const lines = withoutUsedFacts(markdown.split('\n'))
  const isHeading = (l: string) => /^#{1,2}\s/.test(l)
  const kept: string[] = []
  for (let i = 0; i < lines.length; ) {
    if (/^##\s/.test(lines[i]!)) {
      let j = i + 1
      while (j < lines.length && !isHeading(lines[j]!)) j += 1
      const body = withoutOrphans(lines[i]!, lines.slice(i + 1, j))
      if (hasBody(body)) kept.push(lines[i]!, ...body)
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

/**
 * 본문이 아닌 줄 — 빈 줄, 사진 자리, 사진 자리 바로 아래 설명 줄, 공식 출처 「참고:」 줄(링크만 있는 모양). 사람이 쓴 「참고: …」
 * 문장이나 기울임 문단은 본문이다.
 */
function isFiller(line: string, prev: string): boolean {
  const t = line.trim()
  if (!t || IMAGE_SLOT_LINE.test(t) || SOURCES_LINE.test(t)) return true
  return /^\*(?!\*)(.+?)\*$/.test(t) && IMAGE_SLOT_LINE.test(prev.trim())
}

/** 절 본문에 문단이 하나라도 있는가 — 없으면 발행본에서 소제목째 뺀다. */
function hasBody(body: string[]): boolean {
  return !body.every((l, k) => isFiller(l, k > 0 ? body[k - 1]! : ''))
}

/**
 * FAQ 절 소제목 — 「자주 묻는 질문」 「자주 하는 질문」(앞에 주제가, 뒤에 「은 무엇인가요?」 · 「:」 · 「—」가 붙어도), 「FAQ」 「Q&A」
 * 「묻고 답하기」. 「손님이 자주 묻는 질문을 소제목으로 쓰세요」 「FAQ 구조화 데이터는 …」 「AI 검색에 자주 던지는 질문」처럼 FAQ를
 * 다루거나 예시 질문을 모은 절은 아니다 — 그런 절의 질문은 답이 없는 것이 맞다(2026-11-07 검토). 「자주 하는 오해」도 아니다.
 */
const FAQ_HEADING =
  /(?:자주\s*(?:묻는|하는|받는|나오는|헷갈리는)\s*질문|\bFAQ\b|frequently\s+asked\s+questions|\bQ\s*&\s*A\b|묻고\s*답하기)(?:\s*$|\s*[:：—–(]|\s+-\s|(?:은|는|들은|들)?\s*(?:무엇인가요|무엇일까요|무엇일까|뭔가요|뭘까요)?\s*[?？]\s*$|(?:은|는|들)\s*$|에는\s|[과와]\s*답)/i
/** 질문 꼬리표(「Q.」 「**Q2.**」 「Q:」) — 문단 · 소제목 앞에 붙는다. */
const Q_LABEL = /^(?:\*\*)?Q\s*\d{0,2}\s*[.:：)](?:\*\*)?\s*/
/** 답 꼬리표만 있는 줄(「A.」 「**A2.**」 「답:」) — 답 문장이 빠지면 꼬리표만 따로 남는다. */
const ANSWER_LABEL_LINE = /^(?:\*\*)?(?:A|답)\s*\d{0,2}\s*[.:：)](?:\*\*)?$/
/** 질문 바로 뒤의 빈 답 꼬리표(「…나가나요? A.」 「…? **A2.**」) — 답 문장이 빠지면 꼬리표만 남는다. */
const EMPTY_ANSWER = /(?<=[?？](?:\*\*)?)\s*(?:\*\*)?(?:A|답)\s*\d{0,2}\s*[.:：)](?:\*\*)?$/
/** 문장이 아닌 꼬리표(「Q.」 「**A1.**」 「1.」 「**주의!**」) — 다음 문장에 붙여 본다(server/contentDraft.ts BOLD_LABEL과 같은 말, 굵지 않아도). */
const LABEL_SENTENCE = /^(?:\*\*)?(?:Q|A|[QA]?\d{1,2}|답|주의|참고|팁|TIP|NOTE)\s*[.!?:：)]?(?:\*\*)?$/i
/** 뒤에 올 내용을 알리는 끝 문장 — 「…다음과 같습니다.」 「…아래와 같습니다.」 쌍점(:)으로 끝나는 줄. 혼자서는 할 말이 없다. */
const FORWARD_LEAD = /(?:(?:다음과|아래와)\s*같(?:습니다|아요|다)\.|[:：])$/
/** 답 뒤에 붙는 되묻는 말(「생각보다 부담이 적지 않나요?」) — 답이 빠진 새 질문이 아니다. */
const RHETORICAL = /(?:지\s*않(?:나요|을까요|습니까|아요|겠어요|나)|잖아요)\s*[?？](?:\*\*)?$/
/** 예시 질문을 드는 말(「이렇게 묻습니다.」 「예를 들면 …」 「…:」) — 그 뒤 질문은 답을 기다리는 질문이 아니다. */
const EXAMPLE_LEAD = /이렇게|이런\s*질문|다음과\s*같이|아래처럼|예를\s*들|예컨대|예시|[:：](?:\*\*)?$/
const EXAMPLE_START = /^(?:\*\*)?(?:예를\s*들(?:면|어)|예컨대|예:)/
/**
 * 문장 사이 공백 — server/contentDraft.ts splitSentences와 같은 자리에서 자르되 두 가지가 다르다. ① 「?」 「!」 「다.」 「요.」 뒤는
 * 숫자가 와도 문장 끝이다 — 서버는 전화번호(「+82. 2. 522」)를 지키려고 마침표 뒤 숫자를 모두 이어 붙이는데, 그러면 「…쉽니다.
 * 3~10월에는 몇 시까지 여나요?」가 한 문장이 돼 답까지 질문으로 덜렸다(2026-11-07 검토). 그 밖의 마침표 뒤 숫자 · 칭호 약어(Dr. …)
 * 뒤는 서버처럼 잇는다. ② 꼬리표(LABEL_SENTENCE)는 굵지 않아도 다음 문장에 붙인다(sentenceStarts). 전각 「？」도 문장 끝이다.
 */
const SENTENCE_GAP = /(?<=[!?。？](?:\*\*)?|[다요]\.(?:\*\*)?)\s+|(?<=\.(?:\*\*)?)(?<!\b(?:Dr|Mr|Mrs|Ms|Prof|St|Jr|Sr|Mt|vs)\.(?:\*\*)?)\s+(?!\d)/g
const IMAGE_LINE = /^!\[[^\]]*\]\([^)]*\)$/
const BOLD_LINE = /^\*\*((?:(?!\*\*).)+)\*\*$/
const LIST_LINE = /^(?:[-*+]|\d+[.)])\s/

/** 문장마다 시작 위치 — 꼬리표 문장은 다음 문장과 하나로 본다. */
function sentenceStarts(text: string): number[] {
  const starts = [0]
  for (const m of text.matchAll(SENTENCE_GAP)) {
    if (!LABEL_SENTENCE.test(text.slice(starts[starts.length - 1], m.index).trim())) starts.push(m.index + m[0].length)
  }
  return starts
}

function sentencesOf(text: string): string[] {
  const starts = sentenceStarts(text)
  return starts.map((s, k) => text.slice(s, starts[k + 1] ?? text.length).trim())
}

/**
 * 물음표로 끝나는 문장인가 — 끝 굵게 · 괄호는 걷고 본다. 따옴표로 닫힌 질문(「…이렇게 물어보세요. "날짜를 바꿀 수 있나요?"」)은
 * 옮겨 적은 말(물어볼 말 · AI에 넣을 말)이라 치지 않는다.
 */
function isQuestion(sentence: string): boolean {
  return /[?？]$/.test(sentence.trim().replace(/[*)\]]+$/, ''))
}

/**
 * 문단 끝의 답 없는 질문을 덜어낸 앞부분 — 덜 것이 없으면 null, 문단이 질문뿐이면 ''. 답 뒤에 남은 질문(「질문? 답. 질문?」)은
 * 문단이 질문으로 시작하는 문답 묶음일 때만 덜고, 되묻는 말 · 예시로 든 질문은 덜지 않는다. 굵게 구간 안에서 자르면 닫아 준다.
 */
function withoutTrailingQuestions(text: string): string | null {
  const starts = sentenceStarts(text)
  const ss = starts.map((s, k) => text.slice(s, starts[k + 1] ?? text.length).trim())
  let first = ss.length
  while (first > 0 && isQuestion(ss[first - 1]!)) first -= 1
  if (first === ss.length || EXAMPLE_START.test(ss[first]!)) return null
  if (first > 0 && (!isQuestion(ss[0]!) || EXAMPLE_LEAD.test(ss[first - 1]!) || ss.slice(first).some((s) => RHETORICAL.test(s)))) return null
  return closeBold(text.slice(0, starts[first]).trimEnd())
}

/** 굵게 표시(**)가 홀수면 닫는다 — 굵게 구간 안에서 문장을 덜면 짝이 깨져 「**」가 글자로 나간다. */
function closeBold(text: string): string {
  return (text.match(/\*\*/g)?.length ?? 0) % 2 === 1 ? `${text}**` : text
}

/** 내용이 아닌 줄 — 빈 줄, 공식 출처 「참고:」 줄, 가로줄. */
function blankish(t: string): boolean {
  return !t || SOURCES_LINE.test(t) || /^-{3,}$/.test(t)
}

/**
 * 발행본의 고아 자리 — 절 본문 줄(소제목 heading 아래 줄들)마다 덜어낸 모양을 낸다(그대로면 같은 줄, 줄째 빼면 null). 사실
 * 가드(server/factGuard.ts keepSentences)는 문단 안에서 문장을 빼고 그 문장에 기대던 다음 문장만 함께 뺀다 — 문단 경계는 보지 않아,
 * 답 문장만 빠진 FAQ 질문(「효과는 어떻게 확인하나요?」 「Q. … A.」)과 뒤따를 내용이 빠진 안내 문장이 그대로 발행됐다(2026-11-07
 * 에이아이오투오 80편 감사). 그래서 발행본을 만들 때 모양으로 한 번 더 본다. 저장한 초안 · 작업용 원고는 그대로다 — 운영자는 고칠
 * 자리를 본다.
 *   FAQ 질문  FAQ 절(FAQ_HEADING)의 문단 · 「###」 질문 소제목의 끝 문장이 질문인데 같은 절에 그 답이 없다 — 다음 내용 줄(사진 ·
 *            설명 · 출처 · 빈 「A.」 줄은 넘긴다)이 없거나, 같거나 얕은 소제목이거나, 다음 질문이다. 다음 질문은 「Q.」 줄, 질문 줄
 *            (질문뿐인 굵은 줄 · 소제목), 질문으로 시작하는 문단(지금 줄이 질문 줄이면 그 아래 문단은 되묻는 말로 시작해도 답이다),
 *            질문과 답이 함께 든 인용이다. 질문뿐인 인용(물어볼 말) · 목록 · 표 · 하위 소제목은 답이다. 질문 문장과 빈 「A.」
 *            꼬리표만 덜고 남는 말이 없으면 줄째 뺀다. 예시로 든 질문(EXAMPLE_LEAD 뒤) · 따옴표 속 질문 · 되묻는 말은 덜지 않는다.
 *   안내 문장 끝 문장이 「다음과/아래와 같습니다」이거나 쌍점으로 끝나는데 같은 절에 뒤따르는 줄(목록 · 표 · 사진 · 문단)이 하나도 없다.
 * 인용(그대로 쓸 말) · 목록 · 표 · 사진 줄은 덜지 않는다. 한 곳을 덜면 그 앞이 새로 고아가 될 수 있어 바뀌지 않을 때까지 다시 본다.
 * 사진 자리가 있는 절을 통째로 비우게 되면 덜지 않는다 — 절째 빠지면 그 자리에 고른 사진도 이유 없이 빠진다.
 */
function orphanEdits(heading: string, lines: string[]): (string | null)[] {
  const faq = FAQ_HEADING.test(heading)
  const body: (string | null)[] = [...lines]
  const at = (j: number) => body[j]?.trim() ?? ''
  const skipped = (j: number) => body[j] === null || blankish(at(j))
  const imageOrCaption = (j: number) => IMAGE_LINE.test(at(j)) || (/^\*(?!\*)(.+?)\*$/.test(at(j)) && j > 0 && IMAGE_LINE.test(at(j - 1)))
  const nextLine = (k: number, skip: (j: number) => boolean = () => false) => {
    for (let j = k + 1; j < body.length; j += 1) if (!skipped(j) && !skip(j)) return at(j)
    return null
  }
  // 답을 찾을 다음 줄 — 사진 · 설명 줄과 빈 답 꼬리표 줄은 넘긴다.
  const nextForAnswer = (k: number) => nextLine(k, (j) => imageOrCaption(j) || ANSWER_LABEL_LINE.test(at(j)))
  // 질문 줄(소제목 · 줄 전체가 굵은 줄 · 「Q.」 줄) — 그 아래 문단이 답이다. 같은 줄에 빈 「A.」가 있으면 답은 그 줄에 있어야 했다.
  const questionLine = (t: string) => !EMPTY_ANSWER.test(t) && (/^#{3,6}\s/.test(t) || BOLD_LINE.test(t) || Q_LABEL.test(t))
  // 다음 줄이 답이 아닌가. level은 지금 줄이 「###」 소제목이면 그 깊이(더 깊은 소제목은 답의 일부다).
  const notAnswer = (next: string | null, fromQuestionLine: boolean, level = 0): boolean => {
    if (next === null) return true
    const h = /^(#{1,6})\s/.exec(next)
    if (h) return !(level > 0 && h[1]!.length > level)
    if (LIST_LINE.test(next) || next.startsWith('|')) return false
    if (next.startsWith('>')) {
      const ss = sentencesOf(next.replace(/^>\s?/, ''))
      return isQuestion(ss[0]!) && !ss.every(isQuestion)
    }
    if (Q_LABEL.test(next)) return true
    if (!isQuestion(sentencesOf(unwrap(next))[0]!)) return false
    return !fromQuestionLine || questionLine(next)
  }
  // 예시로 든 질문인가 — 바로 앞 내용 줄이 예시를 드는 말로 끝나거나, 그 줄도 예시로 든 질문뿐이다.
  const example = (k: number): boolean => {
    for (let j = k - 1; j >= 0; j -= 1) {
      if (skipped(j) || imageOrCaption(j)) continue
      const ss = sentencesOf(unwrap(at(j).replace(/^(?:>\s?|#{3,6}\s+)/, '')))
      return EXAMPLE_LEAD.test(ss[ss.length - 1]!) || (ss.every(isQuestion) && example(j))
    }
    return false
  }
  // 한 줄을 고친 모양 — undefined는 그대로, null은 줄째 빼기.
  const fix = (k: number): string | null | undefined => {
    const t = at(k)
    if (blankish(t) || /^(?:>|\|)/.test(t) || LIST_LINE.test(t) || imageOrCaption(k)) return undefined
    if (faq && ANSWER_LABEL_LINE.test(t)) return notAnswer(nextForAnswer(k), true) ? null : undefined
    const sub = /^(#{3,6})\s+(.+)$/.exec(t)
    if (sub) {
      const unanswered = faq && notAnswer(nextForAnswer(k), true, sub[1]!.length)
      return unanswered && withoutTrailingQuestions(sub[2]!) === '' && !example(k) ? null : undefined
    }
    if (/^#/.test(t)) return undefined
    const bold = BOLD_LINE.exec(t)
    const text = bold ? bold[1]! : t
    const rewrap = (rest: string) => (!rest.replace(Q_LABEL, '').trim() || ANSWER_LABEL_LINE.test(rest) ? null : bold ? `**${rest}**` : rest)
    if (faq && notAnswer(nextForAnswer(k), questionLine(t))) {
      const rest = withoutTrailingQuestions(text.replace(EMPTY_ANSWER, ''))
      if (rest !== null && !(rest === '' && example(k))) return rewrap(rest)
    }
    const starts = sentenceStarts(text)
    const last = starts[starts.length - 1]!
    if (FORWARD_LEAD.test(text.slice(last).trim().replace(/\*+$/, '')) && nextLine(k) === null) {
      return rewrap(closeBold(text.slice(0, last).trimEnd()))
    }
    return undefined
  }
  for (let k = 0; k < body.length; ) {
    const fixed = body[k] === null ? undefined : fix(k)
    if (fixed === undefined || fixed === body[k]) {
      k += 1
      continue
    }
    body[k] = fixed
    k = 0
  }
  const emptied = hasBody(lines) && !hasBody(applyEdits(body))
  return emptied && lines.some((l) => IMAGE_SLOT_LINE.test(l.trim())) ? [...lines] : body
}

/** 고아 덜기 결과(orphanEdits)를 줄로 — 뺀 줄 옆의 빈 줄도 하나 뺀다(문단 사이 빈 줄이 겹치지 않게). */
function applyEdits(edits: readonly (string | null)[]): string[] {
  const out: string[] = []
  for (let i = 0; i < edits.length; i += 1) {
    const line = edits[i]
    const next = edits[i + 1]
    if (line !== null) out.push(line)
    else if (typeof next === 'string' && !next.trim()) i += 1
    else if (out.length > 0 && !out[out.length - 1]!.trim()) out.pop()
  }
  return out
}

/** 절 본문 줄에서 고아 자리를 덜어낸 줄(고친 글 · tidyArticleMarkdown). */
function withoutOrphans(heading: string, lines: string[]): string[] {
  return applyEdits(orphanEdits(heading, lines))
}

/** 줄 전체를 감싼 굵게(**…**)를 걷는다. 줄 안에 굵게가 더 있으면 그대로 둔다. */
function unwrap(line: string): string {
  return BOLD_LINE.exec(line)?.[1] ?? line
}

/** 글에 남은 사진 자리 수 — 올리기 목록이 「사진 넣을 곳 N곳」으로 알린다. */
export function countImageSlots(markdown: string): number {
  return markdown.split('\n').filter((line) => IMAGE_SLOT_LINE.test(line.trim())).length
}

/** 「… {N}가지」 제목의 {N}을 실린 절 수로 바꾼다. 글쓰기 엔진은 숫자를 쓰지 않고 {N}만 남긴다(b9c 규칙 8). */
export function fillTitleCount(title: string, count: number): string {
  return title.split('{N}').join(String(count))
}

/**
 * 발행본에 실리는 절과 그 본문 줄 — 빈칸이 아닌 문단에서 고아 자리(orphanEdits)를 덜고 문단이 하나라도 남은 절만. 공식 출처
 * 「참고:」(articleSources)는 덜어낸 글로 고른다 — 덜어낸 질문이 부른 출처가 남지 않고, 그 출처는 뒤 절이 받는다.
 */
function publishedSections(d: ContentDraft) {
  const cleaned: ContentDraft = { ...d, sections: d.sections.map((sec) => ({ ...sec, blocks: publishedBlocks(sec) })) }
  const sources = articleSources(cleaned)
  return cleaned.sections.map((sec, si) => ({ sec, body: sectionBody(sec, sec.blocks, sources[si]) })).filter((s) => hasBody(s.body))
}

/** 절의 발행 문단 — 빈칸을 빼고, 고아 자리를 덜어낸 문단은 본문을 바꾸고 줄째 뺀 문단은 뺀다. */
function publishedBlocks(sec: DraftSection): DraftBlock[] {
  const blocks = sec.blocks.filter((b) => b.kind !== 'gap' && (b.body ?? '').trim())
  const lines = sectionBody(sec, blocks, undefined)
  const edits = orphanEdits(sec.heading, lines)
  // 문단 i는 lines[2i]다(sectionBody가 문단마다 한 줄과 빈 줄을 낸다).
  return blocks.flatMap((b, i): DraftBlock[] => {
    const line = edits[2 * i]
    if (line === null) return []
    if (line === lines[2 * i]) return [b]
    return [{ ...b, body: b.role === 'key' ? line.replace(/^\*\*|\*\*$/g, '') : line }]
  })
}

/** 절 본문 줄 — 문단마다 한 줄과 빈 줄, 사진 자리와 설명 줄, 공식 출처 「참고:」 줄은 절 끝에. */
function sectionBody(sec: DraftSection, blocks: DraftBlock[], sources: readonly OfficialSource[] | undefined): string[] {
  return [
    ...blocks.flatMap((b) => [articleBlockLine(b), '']),
    ...(sec.image ? [...imageLines(sec.image), ''] : []),
    ...(sources?.length ? [sourcesLine(sources), ''] : []),
  ]
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
 * 쓴 사실」을 빼고, 고아 자리(답 없는 FAQ 질문 · 뒤가 빈 안내 문장)도 덜어낸다. 문단이 하나도 없는 절(빈칸을 모두 뺀 절)은
 * 작업용에서도 뺀다 — 번호가 비지 않게.
 */
function articleMarkdown(d: ContentDraft, publish: boolean): string {
  const sources = publish ? [] : articleSources(d)
  const shown = publish
    ? publishedSections(d)
    : d.sections.flatMap((sec, si) => (sec.blocks.length > 0 ? [{ sec, body: sectionBody(sec, sec.blocks, sources[si]) }] : []))
  const L: string[] = [`# ${fillTitleCount(d.title, shown.length)}`, '']
  if (d.lead) L.push(d.lead, '')
  shown.forEach(({ sec, body }, i) => L.push(`## ${i + 1}. ${sec.heading}`, '', ...body))
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
