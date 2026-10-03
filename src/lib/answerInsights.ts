import type { CitationDetail, QuestionRepeatAnalysis, QuestionSpec } from './types'
import { ENGINE_LABEL } from './format'

/*
 * 개요(대시보드 2차)와 AI 답변 화면이 함께 쓰는 판정 기록 계산. 모두 저장된 판정 기록·질문 은행에서 바로
 * 센다 — 새 API 호출도, 지어낸 문장도 없다. 모집단은 언급률과 같은 「이름 없는 질문」(category-agnostic)이다.
 */

function agnosticOf(analyses: QuestionRepeatAnalysis[], questions: QuestionSpec[]) {
  const byId = new Map(questions.map((q) => [q.questionId, q]))
  const general = analyses.filter((a) => byId.get(a.questionId)?.category === 'category-agnostic')
  return { byId, general }
}

/**
 * 이름 없는 질문 기준 자사 인용률. 점수의 자사 인용률은 모든 질문의 인용을 세서, 브랜드 이름을 넣은 질문에서
 * 자연히 그 브랜드 사이트가 인용되는 몫까지 들어간다(실측 교보생명 W40: 전체 21.0%, 이름 없는 질문만 6.8%).
 */
export function unnamedOwnedCitation(
  analyses: QuestionRepeatAnalysis[],
  questions: QuestionSpec[],
): { owned: number; total: number; rate: number } | null {
  const { general } = agnosticOf(analyses, questions)
  let total = 0
  let owned = 0
  for (const a of general) {
    total += a.citations.length
    owned += a.citations.filter((c) => c.ownerType === 'brand-owned').length
  }
  return total > 0 ? { owned, total, rate: owned / total } : null
}

/** 이름 없는 질문 중 몇 개에서 불렸나(엔진 하나라도) — 표지·개요의 「질문 N개 중 M개」. */
export function questionCoverage(analyses: QuestionRepeatAnalysis[], questions: QuestionSpec[]): { asked: number; hit: number } {
  const { general } = agnosticOf(analyses, questions)
  const asked = new Set<string>()
  const hit = new Set<string>()
  for (const a of general) {
    asked.add(a.questionId)
    if (a.mentioned) hit.add(a.questionId)
  }
  return { asked: asked.size, hit: hit.size }
}

/** 엔진별 언급 — 이름 없는 질문에서 그 엔진 응답 중 브랜드가 나온 비율. 비율 높은 순. */
export function engineMentions(
  analyses: QuestionRepeatAnalysis[],
  questions: QuestionSpec[],
): { engine: string; label: string; mentioned: number; total: number; rate: number }[] {
  const { general } = agnosticOf(analyses, questions)
  const by = new Map<string, { mentioned: number; total: number }>()
  for (const a of general) {
    if (a.clarifying) continue
    const e = by.get(a.engine) ?? { mentioned: 0, total: 0 }
    e.total += 1
    if (a.mentioned) e.mentioned += 1
    by.set(a.engine, e)
  }
  return [...by.entries()]
    .map(([engine, v]) => ({ engine, label: ENGINE_LABEL[engine] ?? engine, ...v, rate: v.total > 0 ? v.mentioned / v.total : 0 }))
    .sort((a, b) => b.rate - a.rate || a.label.localeCompare(b.label))
}

/** 받침이 있으면 '이', 없으면 '가'. 한글로 끝나지 않으면 '이(가)'. */
function subjectJosa(word: string): string {
  const last = word.trim().slice(-1)
  const code = last.charCodeAt(0) - 0xac00
  if (code < 0 || code > 11171) return '이(가)'
  return code % 28 === 0 ? '가' : '이'
}

/**
 * 결론 한 문장 — 주제(topic) 기준으로 가장 강한 주제와, 놓쳤고 대신 불린 경쟁사가 있는 주제를 한 문장에 담는다.
 * 예: 「종로 지역 고객센터」 질문에선 1순위로 추천되지만, 「종신 및 정기보험」 질문에선 한화생명이 대신 불립니다.
 *
 * 코드 템플릿이다. 주제 태그가 없는 브랜드(질문 프롬프트 빌더에서 주제를 매기지 않음)나 말할 거리가 없으면
 * null — 화면은 문장 없이 숫자 요약만 둔다. 강한 주제는 그 주제 질문 절반 이상, 그리고 **두 질문 이상**에서
 * 불렸을 때만 내세운다 — 질문 한 개짜리 주제에서 한 번 불린 것을 「1순위로 추천」이라 쓰면 부풀린 말이 된다
 * (실측: 스테이,머뭄 W40은 26개 중 2개에서만 불렸는데 질문 하나로 그렇게 쓰였다).
 */
export function headlineSentence(
  analyses: QuestionRepeatAnalysis[],
  questions: QuestionSpec[],
  brandName: string,
): string | null {
  const { byId, general } = agnosticOf(analyses, questions)
  type Topic = { questions: Set<string>; hit: Set<string>; first: Set<string>; lost: Set<string>; others: Map<string, number> }
  const topics = new Map<string, Topic>()
  const perQuestion = new Map<string, QuestionRepeatAnalysis[]>()
  for (const a of general) perQuestion.set(a.questionId, [...(perQuestion.get(a.questionId) ?? []), a])
  for (const [qid, list] of perQuestion) {
    const topic = byId.get(qid)?.topic?.trim()
    if (!topic) continue
    const t = topics.get(topic) ?? { questions: new Set(), hit: new Set(), first: new Set(), lost: new Set(), others: new Map() }
    t.questions.add(qid)
    // 강한 주제의 근거는 「엔진 절반 이상이 불렀다」 — 엔진 하나에서 한 번 나온 질문으로 「1순위 추천」이라
    // 쓰지 않는다(실측: 스테이,머뭄 W40 감성 독채 질문은 엔진 셋 중 하나씩만 불렀다).
    const majority = list.filter((a) => a.mentioned).length * 2 >= list.length
    if (majority) t.hit.add(qid)
    if (majority && list.some((a) => a.mentioned && a.brandRank === 1)) t.first.add(qid)
    if (!list.some((a) => a.mentioned)) {
      t.lost.add(qid)
      for (const a of list) {
        for (const c of a.competitorMentions) if (c.mentionCount > 0) t.others.set(c.name, (t.others.get(c.name) ?? 0) + c.mentionCount)
      }
    }
    topics.set(topic, t)
  }
  if (topics.size === 0) return null

  const strong = [...topics.entries()]
    .filter(([, t]) => t.hit.size >= 2 && t.hit.size / t.questions.size >= 0.5)
    .sort((a, b) => b[1].first.size - a[1].first.size || b[1].hit.size / b[1].questions.size - a[1].hit.size / a[1].questions.size)[0]
  const weak = [...topics.entries()]
    .filter(([name, t]) => t.others.size > 0 && name !== strong?.[0])
    .sort((a, b) => b[1].lost.size - a[1].lost.size || sumOf(b[1].others) - sumOf(a[1].others))[0]

  const strongFirst = strong ? strong[1].first.size > 0 : false
  const strongPart = strong
    ? strongFirst
      ? `「${strong[0]}」 질문에선 1순위로 추천되지만`
      : `「${strong[0]}」 질문에서 가장 자주 불리지만`
    : null
  const strongAlone = strong
    ? strongFirst
      ? `「${strong[0]}」 질문에선 1순위로 추천됩니다`
      : `「${strong[0]}」 질문에서 가장 자주 불립니다`
    : null
  const names = weak
    ? [...weak[1].others.entries()]
        .filter(([n]) => n !== brandName)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([n]) => n)
    : []
  const weakPart = weak && names.length > 0 ? `「${weak[0]}」 질문에선 ${names.join('·')}${subjectJosa(names[names.length - 1]!)} 대신 불립니다` : null

  if (strongPart && weakPart) return `${strongPart}, ${weakPart}`
  return weakPart ?? strongAlone
}

function sumOf(m: Map<string, number>): number {
  let s = 0
  for (const v of m.values()) s += v
  return s
}

/** 답변 문장을 화면에 보일 모양으로 — 마크다운 굵게·머리글 기호를 걷는다(내용은 바꾸지 않는다). */
export function cleanSentence(s: string): string {
  return s
    .replace(/\*\*/g, '')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/^#+\s*/, '')
    .replace(/^[*-]\s+/, '')
    .trim()
}

/**
 * 답변 문장에서 브랜드 이름을 찾는 정규식 — 쉼표·공백 차이를 허용한다(「스테이,머뭄」을 답변이 「스테이, 머뭄」으로
 * 쓴다). 화면이 이 이름에 형광 표시를 한다.
 */
export function brandPattern(brandName: string): RegExp | null {
  const core = brandName.replace(/\s+/g, '')
  if (!core) return null
  const body = [...core].map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*')
  return new RegExp(body, 'g')
}

export interface CitationChip {
  domain: string
  ownerType: CitationDetail['ownerType']
  supports: boolean
  count: number
}

/** 같은 도메인을 한 칩으로 — 자사·뒷받침을 앞에, 나머지는 건수 순. */
export function citationChips(citations: CitationDetail[]): CitationChip[] {
  const by = new Map<string, CitationChip>()
  for (const c of citations) {
    const domain = (c.domain || c.raw).replace(/^www\./, '')
    const chip = by.get(domain) ?? { domain, ownerType: c.ownerType, supports: false, count: 0 }
    chip.count += 1
    if (c.supportsBrandMention) chip.supports = true
    by.set(domain, chip)
  }
  const rank = (c: CitationChip) => (c.ownerType === 'brand-owned' ? 0 : c.supports ? 1 : c.ownerType === 'competitor-owned' ? 2 : 3)
  return [...by.values()].sort((a, b) => rank(a) - rank(b) || b.count - a.count)
}

export interface AnswerHighlight {
  questionId: string
  questionText: string
  engine: string
  engineLabel: string
  rank: number | null
  sentences: string[]
  citations: CitationChip[]
  citationCount: number
  /** 같은 질문에서 다른 엔진이 다르게 답했을 때 한 줄(예: Perplexity는 2순위 — 1순위 흥국생명). */
  divergence: string | null
}

/**
 * 「AI는 이렇게 답했습니다」에 올릴 답변 — 이름 없는 질문에서 브랜드가 불린 응답 중 순위가 높고, 언급 문장이
 * 있고, 자사·뒷받침 인용이 많은 것부터. 같은 질문은 한 번만 고르되, 그 질문에서 엔진끼리 결과가 갈렸으면
 * 갈린 내용을 한 줄로 붙인다(고객에게 "엔진마다 다르게 말한다"를 보여 주는 근거).
 */
export function pickAnswerHighlights(
  analyses: QuestionRepeatAnalysis[],
  questions: QuestionSpec[],
  brandName: string,
  max = 2,
): AnswerHighlight[] {
  const { byId, general } = agnosticOf(analyses, questions)
  const score = (a: QuestionRepeatAnalysis) =>
    (a.brandRank === 1 ? 100 : a.brandRank ? 50 - a.brandRank : 0) +
    a.citations.filter((c) => c.ownerType === 'brand-owned' || c.supportsBrandMention).length
  const candidates = general
    .filter((a) => a.mentioned && a.mentionSentences.length > 0)
    .sort((a, b) => score(b) - score(a) || a.questionId.localeCompare(b.questionId))
  const out: AnswerHighlight[] = []
  const usedQuestions = new Set<string>()
  const usedEngines = new Set<string>()
  // 엔진이 겹치지 않게 먼저 고르고, 모자라면 겹쳐도 채운다.
  for (const pass of [0, 1]) {
    for (const a of candidates) {
      if (out.length >= max) break
      if (usedQuestions.has(a.questionId)) continue
      if (pass === 0 && usedEngines.has(a.engine)) continue
      const sameQuestion = general.filter((x) => x.questionId === a.questionId && x.engine !== a.engine)
      const divergence = divergenceLine(a, sameQuestion, brandName)
      out.push({
        questionId: a.questionId,
        questionText: byId.get(a.questionId)?.text ?? a.questionId,
        engine: a.engine,
        engineLabel: ENGINE_LABEL[a.engine] ?? a.engine,
        rank: a.brandRank,
        sentences: a.mentionSentences.slice(0, 3).map((m) => cleanSentence(m.sentence)).filter(Boolean),
        citations: citationChips(a.citations),
        citationCount: a.citations.length,
        divergence,
      })
      usedQuestions.add(a.questionId)
      usedEngines.add(a.engine)
    }
  }
  return out
}

function divergenceLine(a: QuestionRepeatAnalysis, others: QuestionRepeatAnalysis[], brandName: string): string | null {
  for (const o of others) {
    const label = ENGINE_LABEL[o.engine] ?? o.engine
    if (!o.mentioned) {
      const top = o.topRecommendation && o.topRecommendation !== brandName ? ` — 1순위 ${o.topRecommendation}` : ''
      return `같은 질문 ${label}에선 불리지 않음${top}`
    }
    if (a.brandRank !== null && o.brandRank !== null && o.brandRank !== a.brandRank) {
      const top = o.topRecommendation && o.topRecommendation !== brandName ? ` — 1순위 ${o.topRecommendation}` : ''
      return `같은 질문 ${label}는 ${o.brandRank}순위${top}`
    }
  }
  return null
}
