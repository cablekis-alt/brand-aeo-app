import { brandPattern } from './answerInsights'
import { runCountText } from './comparability'
import { ENGINE_LABEL, measureConditionText } from './format'
import type { QuestionRepeatAnalysis, QuestionSpec } from './types'

/**
 * 글에 넣는 「실제로 AI에 물어본 결과」 — 저장된 측정 기록에서 **코드가** 고르고 쓴다.
 *
 * 왜 글쓰기 모델에 맡기지 않나: 날짜 · 모델 · 건수는 사실 가드(server/factGuard.ts)가 지어낸 숫자로 보고 지운다.
 * 무엇보다 AI 답변을 옮기는 일은 한 글자도 바뀌면 안 된다 — 그래서 원문에 글자 그대로 있는 문장만 쓰고,
 * 사람이 화면에서 원문과 대조해 확인해야 발행본에 들어간다(confirmedAt).
 *
 * 정직하게 적을 것:
 * - 이 응답은 ChatGPT 앱 화면이 아니라 API 응답이다(앱 시스템 프롬프트 · 웹 검색 도구를 붙여 물었다).
 *   「스크린샷」 · 「캡처」라고 부르지 않는다.
 * - 판정 모델이 고른 「언급」에는 틀린 것이 섞인다 — 조건부 지목(「~을 말씀하시는 것이라면」)이 1순위로 세어진
 *   일이 있었다. 그래서 순위는 쓰지 않고, 아래 규칙으로 한 번 더 거른다.
 * - 한 번 잰 결과는 같은 설정에서도 흔들린다. 이 측정에서 끝나는 같은 조건 구간(comparableRun)이 2번 미만이면 그렇게 적는다.
 */

/** 원문 한 건 — server/types.ts RawCallRecord에서 쓰는 필드만. */
export interface EvidenceRawCall {
  engine: string
  questionId: string
  callIndex: number
  rawText: string
  usedWebSearch: boolean
  model?: string
  calledAt: string
}

export interface EvidenceItem {
  questionId: string
  questionText: string
  /** 브랜드 이름을 넣어 물은 질문 — 이름 없이 물은 질문과 같은 무게로 읽히지 않게 표시한다. */
  named: boolean
  engine: string
  model?: string
  usedWebSearch: boolean
  /** 응답을 받은 시각(UTC 원본). */
  calledAt: string
  /** 측정일(한국 시간). */
  measuredDate: string
  callIndex: number
  /** 원문에 글자 그대로 있는 1~2문장(서식 · 각주 번호만 걷음). */
  excerpt: string
}

export interface AnswerEvidence {
  version: 1
  builtAt: string
  weekOf: string
  questionBankVersion?: string
  /** 엔진마다 하나, 최대 둘. 순위가 아니라 질문 순서로 고른다. */
  items: EvidenceItem[]
  /**
   * 이름을 넣지 않은 질문을 물은 응답(되물음 제외)과 그중 이름이 실제로 나온 응답 — 원문에 이름이 있고, 조건부
   * 지목 · 못 찾음 문장만 있는 답은 뺀다. 이름을 넣어 물으면 이름이 나오는 게 당연해 비율이 부풀므로 세지 않는다
   * (다른 지표 — answerInsights · reviewReport — 와 같은 원칙).
   */
  answered: { asked: number; mentioned: number }
  conditions: { collect: string; judge: string; repeats: string }
  /**
   * 이 측정에서 끝나는 같은 조건 구간의 측정 수(src/lib/comparability.ts comparableRun — 정기진단 보고서 「측정 횟수」 점검과
   * 같은 구간). 2026-10-25 전에 만든 사례는 같은 질문 은행 · 같은 수집 엔진으로 잰 주차 수다(sameConditionRun이 없다).
   */
  sameConditionWeeks: number
  /** 그 구간을 세는 말(runCountText) — 「연속 3주」, 사이에 측정하지 않은 주가 있으면 「3번」. */
  sameConditionRun?: string
  /** 이 글의 질문 원문 — 「같은 질문으로 비교해 보세요」. 이름 없는 질문을 앞에, 최대 3개. */
  compareQuestions: string[]
  /** 고를 응답이 없을 때 이유(화면에만 보인다). */
  emptyReason?: string
  /** 사람이 원문과 대조해 확인한 시각 — 없으면 발행본에 넣지 않는다. */
  confirmedAt?: string
  /** 발행본에 넣을지. 의료 업종은 기본으로 끈다(제3자 추천 · 비교 광고 규정). */
  include: boolean
}

export interface BuildEvidenceInput {
  weekOf: string
  /** 이 글(실행 항목)이 다루는 질문. 이 밖의 질문은 쓰지 않는다. */
  questionIds: string[]
  questions: QuestionSpec[]
  analyses: QuestionRepeatAnalysis[]
  raw: EvidenceRawCall[]
  brandName: string
  aliases: string[]
  /** 경쟁사 이름 · 별칭 — 이 이름이 든 문장은 고르지 않는다(남의 이름을 우리 글에 싣지 않는다). */
  competitorNames: string[]
  card: {
    enginesUsed?: string[]
    modelsUsed?: Record<string, string>
    judgeEngine?: string
    judgeModel?: string
    repeatsPerQuestion?: number
    questionBankVersion?: string
  }
  /** 이 측정에서 끝나는 같은 조건 구간(comparableRun, 오름차순) — 고른 주 뒤의 측정은 들지 않는다. */
  sameConditionRun: { weekOf: string }[]
  industry: string
  builtAt: string
}

const MAX_ITEMS = 2
const MAX_SENTENCES = 2
const MAX_EXCERPT = 300
const MAX_COMPARE = 3
/** 문장으로 읽히는 최소 길이 — 목록 · 표 머리의 조각(「총액 요금제 기준 (예: …)」)을 거른다. */
const MIN_SENTENCE = 15
/** 문장 끝 — 마침표 · 느낌표, 또는 「~다」 · 「~요」로 끝나는 줄. 물음표로 끝나는 문장(되묻기)은 옮기지 않는다. */
const SENTENCE_END = /([.!。]|[다요])["'」』)]?$/

/** 의료 업종 — 실측 사례를 기본으로 끈다. 사람이 켤 수 있다. */
export const MEDICAL_INDUSTRY = /성형|치과|병원|의원|피부과|한의원|클리닉|의료|안과|산부인과/

/**
 * 조건부 지목 · 못 찾음 · 되묻기 — 이름이 들어 있어도 우리를 가리킨 답이 아니다. 작은 브랜드에 대한 한국어 답변에
 * 흔한 꼴(「~을 말하는 거라면」 「~을 의미하신다면」 「~이 맞다면」 「~을 찾으시는 건가요」 「잘 알려져 있지 않습니다」)을 함께 거른다.
 */
const CONDITIONAL =
  /말씀하시는|가리키는|가리킨다면|(?:것|거)(?:이)?라면|(?:말씀|의미|뜻|지칭|말)(?:하|하시)?(?:신|한|는)다면|(?:언급|얘기|이야기)하(?:신|시는|는)?다면|존재한다면|(?:이|가)\s?(?:정확히\s?)?맞다면|(?:찾으시는|말씀하시는|말하는)\s?(?:건|것인?)가요|정보를 찾(?:을 수 없|지 못)|찾기 어렵|확인되지 않|확인할 수 없|확인이 어렵|(?:인지|맞는지)(?:는|를)?\s?확인이 필요|찾지 못|알려진 바가 없|알려져 있지 않|등록(?:돼|되어) 있지 않|단정하기 어렵|파악하기 어렵|정보가 없/

/**
 * 옮길 문장에서만 더 거르는 조건문 — 「~이라면,」 「~한다면,」처럼 쉼표로 조건을 단 문장. 이름이 나온 답으로는 세지만(조건을 단
 * 추천도 추천이다) 우리 글에 인용하지는 않는다. 쉼표 없이 조건 뒤에 바로 우리를 꼽는 문장(「~을 원하신다면 X를 추천합니다」)은
 * 고른다.
 */
const CONDITIONAL_CLAUSE = /[라다]면[,，]/

/** 뒤 내용을 가리키는 문장(「~은 다음과 같습니다」) — 가리키는 목록 없이 옮기면 빈말이 된다. */
const POINTS_ONWARD = /(?:다음|아래)과 같(?:습니다|아요|다)|(?:다음|아래)와 같(?:습니다|아요|다)/

/** 발췌로 낼 문장 — 서식(굵게 · 인용 · 제목 · 목록 기호) · 링크 · 각주 번호만 걷고 글자는 그대로, 공백은 한 칸으로. */
function cleanExcerpt(s: string): string {
  return s
    .trim()
    .replace(/\[(\d+)\]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^>+\s*/, '')
    .replace(/^#+\s*/, '')
    .replace(/^[*-]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 원문 한 줄(서식을 걷은 것)에 이 문장이 **문장 하나로** 있나 — 줄 처음이나 문장 끝 부호 뒤에서 시작하고, 줄 끝이나
 * 공백 앞에서 끝나야 한다. 앞부분을 뗀 조각(「다른 곳보다 가상 여행은 …」의 뒷부분)과 두 줄을 이은 문장(제목 + 다음 줄)은
 * 받지 않는다. 공백은 지우지 않고 한 칸으로만 줄여 비교한다 — 판정이 띄어쓰기를 바꾼 문장은 원문이 아니다.
 */
function sentenceInLine(line: string, sentence: string): boolean {
  for (let i = line.indexOf(sentence); i >= 0; i = line.indexOf(sentence, i + 1)) {
    const starts = i === 0 || /[.!?。]["'」』)]?\s$/.test(line.slice(0, i))
    const end = i + sentence.length
    if (starts && (end === line.length || /\s/.test(line[end]!))) return true
  }
  return false
}

/** UTC 시각 → 한국 날짜(YYYY-MM-DD). 읽지 못하면 빈 문자열. */
export function kstDate(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  return new Date(t + 9 * 3600_000).toISOString().slice(0, 10)
}

/** 모델 표기 — Perplexity 「preset:low」는 모델명이 아니라 프리셋이다. */
function modelText(model: string | undefined): string | null {
  if (!model) return null
  const preset = /^preset:(.+)$/.exec(model)
  return preset ? `프리셋 ${preset[1]}` : model
}

/** 「ChatGPT(API · gpt-6-luna · 웹 검색) 응답 · 2026-10-17 측정」 */
export function evidenceLabel(item: Pick<EvidenceItem, 'engine' | 'model' | 'usedWebSearch' | 'measuredDate'>): string {
  const parts = ['API', modelText(item.model), item.usedWebSearch ? '웹 검색' : '웹 검색 없음'].filter(Boolean)
  return `${ENGINE_LABEL[item.engine] ?? item.engine}(${parts.join(' · ')}) 응답 · ${item.measuredDate} 측정`
}

function namePatterns(names: string[]): RegExp[] {
  return names.map((n) => brandPattern(n)).filter((r): r is RegExp => r !== null)
}

/** 두 글자가 모두 영문 · 숫자인가 — 영문 이름이 다른 영문 낱말 속에 든 경우(「SKT」 속 「KT」)를 가른다. */
function asciiJoin(a: string | undefined, b: string | undefined): boolean {
  return Boolean(a && b && /[a-z0-9]/i.test(a) && /[a-z0-9]/i.test(b))
}

/** text의 start 자리에서 맞은 이름(word)이 낱말로 서 있나 — 영문 이름은 앞뒤가 영문 · 숫자로 이어지면 다른 낱말의 일부다. 한글은 그대로 본다. */
function standalone(text: string, start: number, word: string): boolean {
  const end = start + word.length
  return !asciiJoin(text[start - 1], word[0]) && !asciiJoin(text[end], word[word.length - 1])
}

/**
 * 이 글에 이름이 있나 — 띄어쓰기를 무시하고 찾되 영문 이름은 낱말 경계에서만(우리 「KT」가 「SKT는 …」에서 나온 것으로 보지 않고,
 * 남의 「KT」가 우리 「SKT」 문장을 막지 않게).
 */
function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => [...text.matchAll(new RegExp(p.source, 'g'))].some((m) => standalone(text, m.index ?? 0, m[0])))
}

/** 이 응답에서 발행본에 옮겨도 되는 문장들. 없으면 빈 배열. */
function pickSentences(a: QuestionRepeatAnalysis, raw: EvidenceRawCall, ours: RegExp[], others: RegExp[]): string[] {
  const rawLines = raw.rawText.split(/\r?\n/).map(cleanExcerpt).filter(Boolean)
  const picked: string[] = []
  for (const m of a.mentionSentences ?? []) {
    if (m.sentiment === 'negative') continue
    const sentence = cleanExcerpt(m.sentence ?? '')
    if (!sentence || sentence.includes('|')) continue // 표 줄은 문장이 아니다
    // 서식을 걷고도 마크다운 기호가 남은 문장은 옮기지 않는다 — 고쳐 쓰면 원문이 아니고, 두면 서식이 깨진다.
    if (/[*`[\]]/.test(sentence)) continue
    // 목록 · 표 머리의 조각은 인용할 문장이 아니다.
    if (sentence.length < MIN_SENTENCE || !SENTENCE_END.test(sentence)) continue
    if (/\d/.test(sentence)) continue // 숫자는 판정이 사실 대조를 하지 않은 값일 수 있다 — 옮기지 않는다
    if (CONDITIONAL.test(sentence) || CONDITIONAL_CLAUSE.test(sentence) || POINTS_ONWARD.test(sentence)) continue
    if (!hasAny(sentence, ours)) continue // 「언급」으로 판정됐어도 이름이 실제로 있어야 한다
    if (hasAny(sentence, others)) continue
    if (!rawLines.some((line) => sentenceInLine(line, sentence))) continue // 원문 한 줄에 문장 그대로 있어야 한다
    if (picked.includes(sentence)) continue
    picked.push(sentence)
    if (picked.length >= MAX_SENTENCES) break
  }
  const joined = picked.join(' ')
  return joined.length > MAX_EXCERPT ? picked.slice(0, 1) : picked
}

/**
 * 이 이름이 우리 이름인가 — 띄어쓰기만 다른 우리 이름(「가상오더」 ↔ 「가상 오더」)이거나 우리 이름의 일부(「하이오더」 ⊂
 * 「KT 하이오더」)일 때. 코호트 다른 브랜드가 우리를 이렇게 적어 두면, 그 이름을 남의 이름으로 거를 때 우리 문장이 모두 빠진다.
 * 반대로 우리 이름을 품은 남의 이름(「SKT」 ⊃ 「KT」, 「왕십리본정형외과의원」 ⊃ 「본정형외과」)은 남의 이름이다. 영문 이름의
 * 일부는 낱말 경계에서만 본다 — 「KT」는 「SKT」의 일부가 아니다.
 */
export function isOurName(name: string, ourNames: string[]): boolean {
  const squash = (s: string) => s.replace(/\s+/g, '').toLowerCase()
  if (!squash(name)) return false
  if (ourNames.some((o) => squash(o) === squash(name))) return true
  const theirs = brandPattern(name)
  return theirs !== null && ourNames.some((o) => hasAny(o, [theirs]))
}

export function buildAnswerEvidence(input: BuildEvidenceInput): AnswerEvidence {
  const wanted = new Set(input.questionIds)
  const byQuestion = new Map(input.questions.map((q) => [q.questionId, q]))
  const rawOf = new Map(input.raw.map((r) => [`${r.engine}|${r.questionId}|${r.callIndex}`, r]))
  const ours = namePatterns([input.brandName, ...input.aliases])
  const order = new Map(input.questionIds.map((id, i) => [id, i]))

  const answers = input.analyses.filter((a) => wanted.has(a.questionId) && a.engine !== ('mock' as string) && !a.clarifying)
  /** 이름이 실제로 나온 답 — 판정이 언급으로 봤고, 원문에 이름이 있고, 조건부 지목 · 못 찾음 문장만 있는 답이 아니다. */
  const realMention = (a: QuestionRepeatAnalysis): boolean => {
    if (!a.mentioned) return false
    const raw = rawOf.get(`${a.engine}|${a.questionId}|${a.callIndex}`)
    if (raw && !hasAny(raw.rawText, ours)) return false
    const sentences = a.mentionSentences ?? []
    return sentences.length === 0 || sentences.some((m) => !CONDITIONAL.test(m.sentence ?? ''))
  }
  const unnamed = answers.filter((a) => !byQuestion.get(a.questionId)?.containsBrandName)
  const answered = { asked: unnamed.length, mentioned: unnamed.filter(realMention).length }
  const mentionedAny = answers.filter(realMention).length

  // 이름 없는 질문을 먼저, 그 안에서는 글의 질문 순서(순위로 줄 세우지 않는다).
  const candidates = answers
    .filter((a) => a.mentioned && !(a.factualityContradicted > 0))
    .sort(
      (x, y) =>
        Number(byQuestion.get(x.questionId)?.containsBrandName ?? false) - Number(byQuestion.get(y.questionId)?.containsBrandName ?? false) ||
        (order.get(x.questionId) ?? 0) - (order.get(y.questionId) ?? 0) ||
        x.engine.localeCompare(y.engine) ||
        x.callIndex - y.callIndex,
    )

  const items: EvidenceItem[] = []
  for (const a of candidates) {
    if (items.length >= MAX_ITEMS) break
    if (items.some((it) => it.engine === a.engine)) continue
    const raw = rawOf.get(`${a.engine}|${a.questionId}|${a.callIndex}`)
    const q = byQuestion.get(a.questionId)
    if (!raw || !q) continue
    // 등록 경쟁사 · 코호트 브랜드에 더해, 이 답이 1순위로 꼽은 곳과 판정이 찾은 다른 이름도 남의 이름이다. 우리 이름과 겹치는
    // 이름(띄어쓰기만 다른 우리 이름, 우리 이름의 일부)은 빼야 우리 문장이 모두 걸러지지 않는다.
    const ourNames = [input.brandName, ...input.aliases]
    const competitorNames = [...input.competitorNames, a.topRecommendation, ...(a.competitorMentions ?? []).map((c) => c.name)].filter(
      (name): name is string => Boolean(name) && !isOurName(name!, ourNames),
    )
    const sentences = pickSentences(a, raw, ours, namePatterns(competitorNames))
    if (!sentences.length) continue
    items.push({
      questionId: a.questionId,
      questionText: q.text,
      named: q.containsBrandName,
      engine: a.engine,
      ...(raw.model ? { model: raw.model } : {}),
      usedWebSearch: raw.usedWebSearch,
      calledAt: raw.calledAt,
      measuredDate: kstDate(raw.calledAt),
      callIndex: a.callIndex,
      excerpt: sentences.join(' '),
    })
  }

  const compareQuestions = input.questionIds
    .map((id) => byQuestion.get(id))
    .filter((q): q is QuestionSpec => Boolean(q))
    .sort((x, y) => Number(x.containsBrandName) - Number(y.containsBrandName))
    .slice(0, MAX_COMPARE)
    .map((q) => q.text)

  const emptyReason = items.length
    ? undefined
    : answers.length === 0
      ? '이 주에는 이 글의 질문을 잰 기록이 없습니다.'
      : mentionedAny === 0
        ? `이 글의 질문을 물은 답변 ${answers.length}건에서 ${input.brandName} 이름이 나오지 않았습니다.`
        : '이름이 나온 답변은 있지만, 원문 그대로 옮길 수 있는 문장이 없습니다(숫자 · 경쟁사 이름 · 조건부 지목이 든 문장은 뺍니다).'

  return {
    version: 1,
    builtAt: input.builtAt,
    weekOf: input.weekOf,
    ...(input.card.questionBankVersion ? { questionBankVersion: input.card.questionBankVersion } : {}),
    items,
    answered,
    conditions: measureConditionText(input.card),
    sameConditionWeeks: input.sameConditionRun.length,
    sameConditionRun: runCountText(input.sameConditionRun),
    compareQuestions,
    ...(emptyReason ? { emptyReason } : {}),
    include: !MEDICAL_INDUSTRY.test(input.industry),
  }
}

/** 발행본에 넣을 수 있나 — 사람이 확인했고, 넣기를 켰고, 고른 응답이 있다. */
export function evidencePublishable(e: AnswerEvidence | undefined): e is AnswerEvidence {
  return Boolean(e && e.include && e.confirmedAt && e.items.length > 0)
}

/**
 * 발행본에 붙는 마크다운 — 실측 사례 · 「이렇게 확인했습니다」 · 「같은 질문으로 비교해 보세요」.
 * 넣을 수 없으면(확인 전 · 끔 · 응답 없음) 빈 문자열. 비교 질문은 사례가 없어도 쓸 수 있지만, 사람이 확인한
 * 글에만 붙인다 — 확인 전 글 끝이 저절로 바뀌지 않게.
 */
export function renderEvidenceMarkdown(e: AnswerEvidence | undefined): string {
  if (!evidencePublishable(e)) return ''
  const L: string[] = ['## 실제로 AI에 물어본 결과', '']
  for (const it of e.items) {
    L.push(`**${evidenceLabel(it)}**`, '')
    L.push(`> ${it.excerpt}`, '')
    L.push(`질문: 「${it.questionText}」${it.named ? ' — 이름을 넣어 물은 질문' : ''}`, '')
  }
  L.push('### 이렇게 확인했습니다', '')
  L.push(
    e.answered.asked > 0
      ? `- 이 글의 질문을 ${e.conditions.collect}에 물었습니다. 이름을 넣지 않은 질문의 답변 ${e.answered.asked}건 중 ${e.answered.mentioned}건에서 이름이 나왔습니다.`
      : `- 이 글의 질문을 ${e.conditions.collect}에 물었습니다. 모두 이름을 넣어 물은 질문이라 이름이 나온 비율은 세지 않았습니다.`,
  )
  L.push('- 앱 화면이 아니라 API로 받은 응답입니다. 앱에서 같은 질문을 해도 다르게 답할 수 있습니다.')
  // 「Claude (claude-sonnet-5-5)」를 괄호 안에 또 괄호로 넣지 않게 「Claude · claude-sonnet-5-5」로.
  const judge = e.conditions.judge.replace(/ \((.+)\)$/, ' · $1')
  L.push(`- 이름이 나온 문장은 판정 모델이 골랐고(${judge}), 사람이 원문과 대조했습니다. 서식만 걷었고 문장은 원문 그대로입니다.`)
  // 2026-10-25 전에 만든 사례(sameConditionRun 없음)는 질문지 · 수집 엔진만 보고 센 수라 그때 문구로 둔다 — 「같은 조건」이라고
  // 적으면 세지 않은 판정 · 모델 · 반복까지 같았다고 말하게 된다.
  L.push(
    e.sameConditionWeeks >= 2
      ? e.sameConditionRun
        ? `- 같은 조건으로 ${e.sameConditionRun} 쟀습니다. 주마다 답이 달라질 수 있습니다.`
        : `- 같은 질문 · 같은 엔진으로 ${e.sameConditionWeeks}주 쟀습니다. 주마다 답이 달라질 수 있습니다.`
      : '- 한 번 물어본 결과입니다. 같은 질문을 다시 물으면 다르게 답할 수 있습니다.',
  )
  L.push('')
  if (e.compareQuestions.length) {
    L.push('## 같은 질문으로 비교해 보세요', '')
    for (const q of e.compareQuestions) L.push(`- 「${q}」`)
    L.push('', '웹 검색 사용 여부와 새 대화 여부를 같게 맞춰 물어보면 비교하기 쉽습니다.', '')
  }
  return L.join('\n').trimEnd()
}
