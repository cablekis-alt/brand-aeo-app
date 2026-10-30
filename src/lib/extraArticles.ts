/**
 * 추가 글 — 콘텐츠 생성의 본 글(content:category-agnostic)에서 질문 몇 개를 떼어 따로 쓰는 글(data/<tenant>/extra-articles.json).
 *
 * 왜: 본 글 한 편이 이번 주 밀린 질문을 모두 맡으면, 질문이 많은 브랜드는 한 글에 스무 개 넘는 질문이 몰려 어느 하나도 깊게 답하지
 * 못한다. 사람이 질문 몇 개를 골라 각도를 정하면 그 질문은 추가 글이 맡고 본 글에서 빠진다. 이미 만들어 올린 본 글은 다시 만들지
 * 않는다 — 고친 글 · 빈칸 기록 · 고른 사진이 사라지고 올린 글과 원문이 어긋난다.
 *
 * ── id ──────────────────────────────────────────────────────────────────────
 * 질문 은행 화면의 글과 같은 규칙(topic:<정렬한 질문 id를 +로 이음>)이다. 만들 때 한 번 정하고 다시 계산하지 않는다 — 초안 · 브리프 ·
 * 올린 기록이 모두 이 id로 붙는다. 집행 원장의 질문 스냅샷 검사(server/publishedPosts.ts checkTopic)가 id를 정렬 없이 이어 붙여 비교하므로
 * 질문 id는 정렬해서 저장한다.
 *
 * ── 판 ──────────────────────────────────────────────────────────────────────
 * 질문 id의 뜻은 은행 판마다 바뀐다(실측 27%). 그래서 만들 때의 판과 문장을 함께 고정한다. 판이 같은 주에는 id로, 다른 주에는 공백을
 * 정리한 문장이 정확히 같은 질문으로 다시 찾고, 그래도 없으면 확인 불가로 둔다 — 비슷한 질문으로 채우지 않는다.
 *
 * 서버(server/extraArticles.ts)와 화면이 같은 검사를 쓰도록 순수 함수만 둔다. 서버가 import하므로 상대 import는 .js로 쓴다.
 */
import { BRIEF_FOCUS_LIMITS } from '../prompts/b9b-content-brief.js'
import type { TopicSnapshot } from './api.js'
import type { QuestionSpec } from './types.js'

export interface ExtraArticle {
  /** 'topic:' + 정렬한 questionIds를 +로 이음. 만들 때 정하고 다시 계산하지 않는다. */
  id: string
  /** 주제 이름 — 카드 제목이자 브리프 각도의 기본값. */
  name: string
  /** 다룰 각도(선택). */
  angle?: string
  /** 만들 때 질문 은행 판. 질문 id는 이 판의 것이다. */
  bankVersion: string
  /** 정렬됨. */
  questionIds: string[]
  /** questionIds와 같은 수 · 같은 순서의 그 판 문장. */
  questionTexts: string[]
  createdAt: string
  /** 만들 때 보던 주차 — 감사용. */
  createdWeek?: string
  updatedAt: string
  /** 「목록에서 빼기」 — 지우지 않고 표시만 한다. 같은 질문으로 다시 만들면 지우고 되살린다(초안 · 기록이 이어진다). */
  removedAt?: string
}

export const EXTRA_LIMITS = {
  /** 한 글의 질문 수. */
  questions: 20,
  name: 60,
  angle: 200,
  /** 살아 있는 추가 글 수. */
  articles: 10,
  /** 원장 질문 스냅샷의 상한(server/publishedPosts.ts checkTopic)과 같다. */
  questionId: 60,
  questionText: 400,
  bankVersion: 20,
} as const

export const isExtraArticleId = (id: string): boolean => id.startsWith('topic:')

const ANGLE_JOINER = ' — '

/**
 * 브리프에 보내는 다룰 각도 — 「이름 — 각도」, 각도가 없으면 이름만. 브리프는 이 줄을 BRIEF_FOCUS_LIMITS.angle에서 자르므로
 * 저장할 때 이 줄 전체가 그 상한 안에 드는지 함께 검사한다(넘으면 사람이 적은 각도 뒷부분이 알림 없이 빠진다).
 */
export function extraBriefAngle(name: string, angle: string | undefined): string {
  const a = angle?.trim()
  return a ? `${name}${ANGLE_JOINER}${a}` : name
}

/** 주제 이름과 각도를 합친 글자 수의 상한 — 이을 때 넣는 「 — 」 세 글자를 뺀다. */
export const NAME_AND_ANGLE_LIMIT = BRIEF_FOCUS_LIMITS.angle - ANGLE_JOINER.length

/** 질문 은행 화면(QuestionBank.tsx actionFromQuestions)과 같은 규칙 — 기본 정렬(코드 단위)로 정렬해 +로 잇는다. */
export function topicArticleId(questionIds: string[]): string {
  return `topic:${[...questionIds].sort().join('+')}`
}

/** 비교용 문장 — 공백만 정리한다. 다른 글자는 바꾸지 않는다(조금만 달라도 다른 질문으로 본다). */
export const questionTextKey = (text: string): string => text.replace(/\s+/g, ' ').trim()

const isStr = (v: unknown): v is string => typeof v === 'string'
const isRealDate = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v))

/** 저장된 한 줄 — 모양이 맞지 않으면 null. id와 질문이 어긋난 줄은 받지 않는다(기록이 엉뚱한 질문을 가리킨다). */
function articleOf(raw: unknown): ExtraArticle | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const ids = r.questionIds
  const texts = r.questionTexts
  if (!isStr(r.id) || !isStr(r.name) || !r.name.trim() || !isStr(r.bankVersion) || !r.bankVersion.trim()) return null
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((x) => isStr(x) && x.length > 0)) return null
  if (!Array.isArray(texts) || texts.length !== ids.length || !texts.every((x) => isStr(x) && x.trim().length > 0)) return null
  if (topicArticleId(ids as string[]) !== r.id || `topic:${(ids as string[]).join('+')}` !== r.id) return null
  if (!isRealDate(r.createdAt) || !isRealDate(r.updatedAt)) return null
  return {
    id: r.id,
    name: r.name,
    ...(isStr(r.angle) && r.angle.trim() ? { angle: r.angle } : {}),
    bankVersion: r.bankVersion,
    questionIds: [...(ids as string[])],
    questionTexts: [...(texts as string[])],
    createdAt: r.createdAt,
    ...(isStr(r.createdWeek) && r.createdWeek ? { createdWeek: r.createdWeek } : {}),
    updatedAt: r.updatedAt,
    ...(isRealDate(r.removedAt) ? { removedAt: r.removedAt } : {}),
  }
}

/**
 * 파일(또는 응답)의 목록을 고른다 — { version, articles } 또는 배열. 모양이 틀린 줄과 같은 id의 두 번째 줄은 뺀다. 서버는 빠진 줄이
 * 있으면 파일을 깨진 것으로 보고 쓰지 않는다(server/extraArticles.ts) — 읽을 수 없는 정의를 덮어 잃지 않게.
 */
export function normalizeExtraArticles(raw: unknown): ExtraArticle[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? (raw as { articles?: unknown }).articles : undefined
  if (!Array.isArray(list)) return []
  const out: ExtraArticle[] = []
  for (const item of list) {
    const a = articleOf(item)
    if (a && !out.some((x) => x.id === a.id)) out.push(a)
  }
  return out
}

export const aliveExtraArticles = (all: ExtraArticle[]): ExtraArticle[] => all.filter((a) => !a.removedAt)

/** 검사 결과 — 틀리면 상태 코드(400 잘못된 값 · 409 다른 글과 부딪힘)와 이유. */
export type ExtraArticleCheck =
  | { ok: true; article: ExtraArticle; articles: ExtraArticle[]; revived: boolean }
  | { ok: false; status: 400 | 409; error: string }

const bad = (error: string): ExtraArticleCheck => ({ ok: false, status: 400, error })
const conflict = (error: string): ExtraArticleCheck => ({ ok: false, status: 409, error })

function nameOf(raw: unknown): string | { error: string } {
  const s = isStr(raw) ? raw.replace(/\s+/g, ' ').trim() : ''
  if (!s) return { error: '주제 이름을 적어 주세요.' }
  if (s.length > EXTRA_LIMITS.name) return { error: `주제 이름은 ${EXTRA_LIMITS.name}자까지 쓸 수 있어요(지금 ${s.length}자).` }
  return s
}

/** 각도 — 비우면 undefined. */
function angleOf(raw: unknown): string | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined
  if (!isStr(raw)) return { error: '다룰 각도가 올바르지 않습니다.' }
  const s = raw.replace(/\s+/g, ' ').trim()
  if (!s) return undefined
  if (s.length > EXTRA_LIMITS.angle) return { error: `다룰 각도는 ${EXTRA_LIMITS.angle}자까지 쓸 수 있어요(지금 ${s.length}자).` }
  return s
}

const isError = (v: unknown): v is { error: string } => typeof v === 'object' && v !== null && 'error' in v

/** 이름과 각도가 브리프의 각도 줄 하나에 다 들어가는지 — 하나씩은 상한 안이어도 합치면 넘을 수 있다. */
function nameAndAngleError(name: string, angle: string | undefined): string | null {
  if (extraBriefAngle(name, angle).length <= BRIEF_FOCUS_LIMITS.angle) return null
  const used = name.length + (angle?.length ?? 0)
  return `주제 이름과 다룰 각도는 합쳐서 ${NAME_AND_ANGLE_LIMIT}자까지 쓸 수 있어요(지금 ${used}자). 각도를 줄여 주세요.`
}

/** 살아 있는 다른 글과 질문 문장이 겹치면 그 이유. */
function overlapOf(article: Pick<ExtraArticle, 'id' | 'questionTexts'>, all: ExtraArticle[]): string | null {
  const mine = new Set(article.questionTexts.map(questionTextKey))
  for (const other of aliveExtraArticles(all)) {
    if (other.id === article.id) continue
    const shared = other.questionTexts.find((t) => mine.has(questionTextKey(t)))
    if (shared !== undefined) return `이 질문은 이미 '${other.name}' 글이 맡고 있어요: ${questionTextKey(shared)}`
  }
  return null
}

const capError = () => `추가 글은 ${EXTRA_LIMITS.articles}편까지 둘 수 있어요. 다 쓴 글을 목록에서 뺀 뒤 다시 만들어 주세요.`

/**
 * 새 추가 글을 검사해 다음 목록을 만든다. 받는 값: { id, name, angle?, bankVersion, questionIds, questionTexts, createdWeek? }.
 * 질문과 문장은 짝을 지어 id 순으로 정렬한다. 같은 id의 뺀 글이 있으면 되살린다 — 만든 시각은 두고 이름 · 각도 · 판 · 문장은 이번 값으로
 * 바꾼다(같은 id라도 다른 판이면 다른 질문이다).
 */
export function checkNewExtraArticle(input: unknown, all: ExtraArticle[], now: string): ExtraArticleCheck {
  const raw = (input ?? {}) as Record<string, unknown>
  const ids = raw.questionIds
  const texts = raw.questionTexts
  if (!Array.isArray(ids) || ids.length === 0) return bad('질문을 하나 이상 골라 주세요.')
  if (ids.length > EXTRA_LIMITS.questions) return bad(`한 글에는 질문을 ${EXTRA_LIMITS.questions}개까지 고를 수 있어요(지금 ${ids.length}개).`)
  if (!ids.every((x) => isStr(x) && x.length > 0 && x.length <= EXTRA_LIMITS.questionId && !x.includes('+'))) {
    return bad('질문 id가 올바르지 않습니다.')
  }
  if (new Set(ids).size !== ids.length) return bad('같은 질문을 두 번 골랐습니다.')
  if (!Array.isArray(texts) || texts.length !== ids.length) return bad('질문 문장 수가 질문 수와 다릅니다.')
  if (!texts.every((x) => isStr(x) && x.trim().length > 0 && x.length <= EXTRA_LIMITS.questionText)) {
    return bad(`질문 문장이 비었거나 ${EXTRA_LIMITS.questionText}자를 넘습니다.`)
  }
  const bankVersion = isStr(raw.bankVersion) ? raw.bankVersion.trim() : ''
  if (!bankVersion) return bad('질문 은행 판을 모르는 주에는 추가 글을 만들 수 없어요. 측정한 주에서 만들어 주세요.')
  if (bankVersion.length > EXTRA_LIMITS.bankVersion) return bad('질문 은행 판이 올바르지 않습니다.')
  const pairs = (ids as string[]).map((id, i) => ({ id, text: (texts as string[])[i] })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const questionIds = pairs.map((p) => p.id)
  const id = topicArticleId(questionIds)
  if (raw.id !== id) return bad('글 id가 고른 질문과 다릅니다.')
  const name = nameOf(raw.name)
  if (isError(name)) return bad(name.error)
  const angle = angleOf(raw.angle)
  if (isError(angle)) return bad(angle.error)
  const tooLong = nameAndAngleError(name, angle)
  if (tooLong) return bad(tooLong)
  const createdWeek = isStr(raw.createdWeek) && raw.createdWeek.trim() ? raw.createdWeek.trim().slice(0, 20) : undefined
  const questionTexts = pairs.map((p) => p.text)

  const same = all.find((a) => a.id === id)
  if (same && !same.removedAt) return conflict(`같은 질문으로 만든 '${same.name}' 글이 이미 있어요.`)
  const overlap = overlapOf({ id, questionTexts }, all)
  if (overlap) return conflict(overlap)
  if (aliveExtraArticles(all).length >= EXTRA_LIMITS.articles) return conflict(capError())

  const article: ExtraArticle = {
    id,
    name,
    ...(angle ? { angle } : {}),
    bankVersion,
    questionIds,
    questionTexts,
    createdAt: same?.createdAt ?? now,
    ...(createdWeek ? { createdWeek } : same?.createdWeek ? { createdWeek: same.createdWeek } : {}),
    updatedAt: now,
  }
  const articles = same ? all.map((a) => (a.id === id ? article : a)) : [...all, article]
  return { ok: true, article, articles, revived: Boolean(same) }
}

/**
 * 고치기 — 받는 값: { id, name?, angle?, removed?: boolean }. 각도에 빈 글자를 주면 지운다. removed false는 되살리기라 새로 만들 때와
 * 같은 겹침 · 편수 검사를 거친다. 바꿀 것이 없으면 400.
 */
export function checkExtraArticlePatch(input: unknown, all: ExtraArticle[], now: string): ExtraArticleCheck {
  const raw = (input ?? {}) as Record<string, unknown>
  if (!isStr(raw.id) || !raw.id) return bad('고칠 글(id)이 필요합니다.')
  const found = all.find((a) => a.id === raw.id)
  if (!found) return bad(`추가 글을 찾지 못했습니다: ${raw.id}`)
  if (raw.removed !== undefined && typeof raw.removed !== 'boolean') return bad('removed는 true · false여야 합니다.')
  if (raw.name === undefined && raw.angle === undefined && raw.removed === undefined) return bad('바꿀 것이 없습니다(name · angle · removed).')
  const next: ExtraArticle = { ...found }
  if (raw.name !== undefined) {
    const name = nameOf(raw.name)
    if (isError(name)) return bad(name.error)
    next.name = name
  }
  if (raw.angle !== undefined) {
    const angle = angleOf(raw.angle)
    if (isError(angle)) return bad(angle.error)
    if (angle) next.angle = angle
    else delete next.angle
  }
  if (raw.name !== undefined || raw.angle !== undefined) {
    const tooLong = nameAndAngleError(next.name, next.angle)
    if (tooLong) return bad(tooLong)
  }
  if (raw.removed === true && !found.removedAt) next.removedAt = now
  if (raw.removed === false && found.removedAt) {
    const overlap = overlapOf(found, all)
    if (overlap) return conflict(overlap)
    if (aliveExtraArticles(all).length >= EXTRA_LIMITS.articles) return conflict(capError())
    delete next.removedAt
  }
  next.updatedAt = now
  return { ok: true, article: next, articles: all.map((a) => (a.id === found.id ? next : a)), revived: raw.removed === false && Boolean(found.removedAt) }
}

export type ExtraResolveHow = 'same-bank' | 'by-text' | 'unresolved'

export interface ExtraResolution {
  /** 이번 주 은행에서 찾은 질문 id(정의 순서). */
  currentIds: string[]
  /** 찾지 못한 질문의 고정 문장 — 확인 불가로 보인다. */
  missingTexts: string[]
  how: ExtraResolveHow
}

/**
 * 이번 주 은행에서 이 글의 질문을 다시 찾는다. 판이 같으면 id로, 다르면 공백을 정리한 문장이 정확히 같은 질문으로 찾는다. 하나도
 * 못 찾았거나 이번 주 판을 모르면 확인 불가(unresolved) — 비슷한 질문이나 0으로 채우지 않는다.
 */
export function resolveExtraArticle(
  def: Pick<ExtraArticle, 'bankVersion' | 'questionIds' | 'questionTexts'>,
  weekBankVersion: string | null | undefined,
  questions: Pick<QuestionSpec, 'questionId' | 'text'>[],
): ExtraResolution {
  if (!weekBankVersion) return { currentIds: [], missingTexts: [...def.questionTexts], how: 'unresolved' }
  const currentIds: string[] = []
  const missingTexts: string[] = []
  if (weekBankVersion === def.bankVersion) {
    const known = new Set(questions.map((q) => q.questionId))
    def.questionIds.forEach((id, i) => {
      if (known.has(id)) currentIds.push(id)
      else missingTexts.push(def.questionTexts[i])
    })
    return { currentIds, missingTexts, how: currentIds.length > 0 ? 'same-bank' : 'unresolved' }
  }
  const byText = new Map<string, string>()
  for (const q of questions) {
    const key = questionTextKey(q.text)
    if (!byText.has(key)) byText.set(key, q.questionId)
  }
  for (const text of def.questionTexts) {
    const id = byText.get(questionTextKey(text))
    if (id !== undefined && !currentIds.includes(id)) currentIds.push(id)
    else missingTexts.push(text)
  }
  return { currentIds, missingTexts, how: currentIds.length > 0 ? 'by-text' : 'unresolved' }
}

/** 올린 기록에 싣는 질문 스냅샷 — 만들 때의 판 · id · 문장 그대로라 원장 검사(checkTopic)를 늘 통과한다. */
export function extraTopicSnapshot(def: Pick<ExtraArticle, 'bankVersion' | 'questionIds' | 'questionTexts'>): TopicSnapshot {
  return { bankVersion: def.bankVersion, questionIds: [...def.questionIds], questionTexts: [...def.questionTexts] }
}
