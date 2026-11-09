import type { TopicSnapshot } from './api'
import { extraTopicSnapshot, type ExtraArticle } from './extraArticles'
import { topicSnapshotFor } from './gapActions'
import { planWriters, writerArticle, type PlanWriter, type WriterPlan, type WriterPlanArticle } from './probePlan'
import { planArticleOf, postingsOf, type LedgerPostLike } from './publishStatus'
import type { QuestionBank } from './types'

/**
 * 콘텐츠 보관함(src/pages/ContentLibrary.tsx)의 글 순서.
 *
 * 작성자 배정(src/lib/probePlan.ts)이 있는 브랜드는 글 80편이 한 목록에 최근 고친 순으로 섞여 누구 글인지 · 몇 편이 남았는지 보기
 * 어려웠다. 배정이 있으면 작성자마다 한 칸(배정표에 처음 나온 순서 — w1 → w8)으로 묶고, 칸 안은 배정표 순서로 둔다. 배정 밖 글(본 글 ·
 * 배정에 없는 질문 글 · 다른 판으로 만든 글)은 마지막 칸에 지금처럼 최근 순이다. 배정이 없는 브랜드는 지금과 같은 한 목록이다.
 *
 * ── 누구 글인가 ─────────────────────────────────────────────────────────────
 * 글 id가 배정에 있어야 하고, 그 추가 글 정의(src/lib/extraArticles.ts)가 있으면 배정 판으로 만들었어야 한다(콘텐츠 생성
 * src/pages/GapActions.tsx writerArticleOf와 같다). 질문 id의 뜻은 판마다 바뀌므로 같은 id라도 다른 판으로 만든 글은 다른 질문이다. 초안에는
 * 판이 없어 추가 글 정의로 본다(「목록에서 빼기」 한 정의도 판은 남는다 — 콘텐츠 생성도 뺀 정의까지 본다).
 * 추가 글 정의가 없는 배정 글 id(질문 은행 화면 src/pages/QuestionBank.tsx에서 만든 글 — 판을 남기지 않는다)는 그 작성자 칸에 두고
 * 「판 미확인」으로 표시한다(사용자 결정, 2026-11-09). 발행 현황(src/lib/publishStatus.ts planArticleOf — 판 없는 기록은 「미확인」) · 콘텐츠
 * 생성의 작성자 줄(초안 n/10) · 작성자 묶음(src/lib/writerBundle.ts)도 그 글을 그 작성자 글로 보고, 아직 안 만든 글로 세지 않는다.
 *
 * ── 운영 기간 ───────────────────────────────────────────────────────────────
 * 운영 기간(activeUntil)이 지나도 묶는다 — 기간은 글 만들기의 잠금이고, 이미 쓴 글이 누구 몫인지는 바뀌지 않는다. 발행 현황도 기간과
 * 상관없이 작성자 칸을 채운다.
 *
 * ── 올림 ────────────────────────────────────────────────────────────────────
 * 칸 머리의 「올림」은 발행 현황의 작성자 진행(buildTenantStatus)과 같은 규칙으로 센다(livePostsOf). 같은 주소 · 같은 올린 날의 줄은 올린
 * 일 한 번이라 한 줄만 「글을 내렸어요」여도 그 편은 내린 것이고, 작성자 칸은 배정 판으로 쓴 기록(planArticleOf)만 올림으로 센다. 판을
 * 모르는 기록뿐이면 「올렸는지 미확인」으로 따로 보인다(0으로도 올림으로도 채우지 않는다). 보관함에서 적는 기록에는 추가 글 정의의 판을
 * 싣는다(libraryRecordTopic) — 콘텐츠 생성에서 적은 기록과 같은 판이 남아, 질문지 판이 바뀐 뒤에 적어도 두 화면의 수가 갈라지지 않는다.
 * 판 미확인 글은 작성자 기록(주소 한꺼번에 등록 · CLI — src/lib/postRegistration.ts writerRecordInput)과 같이 배정 파일의 판을 싣는다.
 *
 * ── 짐작하지 않기 ───────────────────────────────────────────────────────────
 * 배정을 읽지 못했거나(깨진 파일 · 읽기 실패) 추가 글 목록을 읽지 못했으면(읽기 실패 · 깨진 목록) 묶지 않고 지금처럼 모든 글을 최근 순으로
 * 보인다 — 배정 글을 배정 밖으로 잘못 나누거나 숨기지 않게.
 */

/** 순서를 정하는 데 쓰는 초안의 값 — StoredDraft의 일부. */
export interface LibraryDraftLike {
  actionId: string
  generatedAt: string
  editedAt?: string
}

/** 최근에 만든 것이 위로. 고친 글이 있으면 그 시각을 기준으로 본다(배정이 없을 때의 보관함 순서). */
export function recentFirst<D extends LibraryDraftLike>(drafts: readonly D[]): D[] {
  return [...drafts].sort((a, b) => (b.editedAt ?? b.generatedAt).localeCompare(a.editedAt ?? a.generatedAt))
}

/** 「판 미확인」 표시의 풀이 — 보관함 글 카드 · 주소 한꺼번에 등록 작성자 칸의 툴팁 · 화면 읽기 프로그램 글자. */
export const BANK_UNKNOWN_NOTE =
  '질문 은행에서 만든 글이라 어느 질문지 판으로 썼는지 모릅니다 — 배정 글 id라 그 작성자 글로 보고, 올린 주소는 배정 파일의 판으로 적습니다.'

/** 「배정 밖 글」 고르기 값 — 작성자 키(영문 · 숫자 · _ · -)가 될 수 없는 글자로 둔다. */
export const OUTSIDE_PICK = ':outside'

export interface LibrarySection<D> {
  /** 고르기 값 — 작성자 키, 배정 밖 글은 OUTSIDE_PICK. */
  pick: string
  /** 배정 밖 글이면 null. */
  writer: PlanWriter | null
  drafts: D[]
  /** 판 미확인 — 이 칸의 글 가운데 추가 글 정의가 없어 어느 질문지 판으로 썼는지 모르는 글 id(칸 순서). 배정 밖 칸은 비어 있다. */
  bankUnknown: string[]
  /** 올린 글이 있는 글 수(livePostsOf — 작성자 칸은 배정 판으로 쓴 기록만) — 원장을 읽지 못했으면 null(0으로 채우지 않는다). */
  posted: number | null
  /** 올렸는지 미확인 — 살아 있는 기록이 판을 모르는 것뿐인 글 수. 배정 밖 칸 · 원장을 읽지 못했으면 0. */
  unsure: number
  /** 배정 글 가운데 이 칸에 초안이 없는 글 수. 배정 밖 칸은 0. */
  unmade: number
}

/** 묶지 못한 이유 — plan-unreadable: 배정을 읽지 못함, extras-unreadable: 추가 글 목록을 읽지 못함. */
export type LibraryFallback = 'plan-unreadable' | 'extras-unreadable'

export const LIBRARY_FALLBACK_NOTE: Record<LibraryFallback, string> = {
  'plan-unreadable': '작성자 배정(probe-plan.json)을 읽지 못해 작성자별로 묶지 않았습니다 — 모든 글을 최근 순으로 보입니다.',
  'extras-unreadable': '추가 글 목록을 읽지 못해 어느 글이 누구 배정인지 확인하지 못했습니다 — 작성자별로 묶지 않고 모든 글을 최근 순으로 보입니다.',
}

export type LibraryLayout<D> =
  | { grouped: false; drafts: D[]; fallback: LibraryFallback | null }
  | { grouped: true; sections: LibrarySection<D>[]; total: number }

export interface LibraryLayoutInput<D> {
  drafts: readonly D[]
  /** 배정 — 파일이 없거나 읽지 못했으면 null. 운영 기간은 보지 않는다. */
  plan: WriterPlan | null
  /** 배정 파일이 있는데 읽지 못했다(깨짐 · 읽기 실패). */
  planUnreadable: boolean
  /** 추가 글 정의(뺀 글 포함) — 읽지 못했거나 목록이 깨졌으면 null. */
  extras: readonly Pick<ExtraArticle, 'id' | 'bankVersion'>[] | null
  /** 올린 기록(원장 줄 — 뺀 줄 · 옛 기록 포함) — 원장을 읽지 못했으면 null. */
  posts: readonly LedgerPostLike[] | null
}

/** 올린 글 — 발행 현황(src/lib/publishStatus.ts buildTenantStatus)의 작성자 진행과 같은 규칙. */
export interface LivePosts {
  /** 살아 있는 기록이 있는 글 id(판과 상관없이) — 배정 밖 칸의 올림. */
  any: Set<string>
  /** 배정 판으로 쓴 살아 있는 기록이 있는 배정 글 id — 작성자 칸의 올림. */
  planned: Set<string>
  /** 살아 있는 기록이 판을 모르는 것뿐인 배정 글 id — 올렸는지 미확인. */
  unsure: Set<string>
}

/**
 * 살아 있는 기록의 글 — 같은 주소 · 같은 올린 날의 줄을 올린 일 한 번으로 묶어(postingsOf) 내린 편 · 잘못 적은 주소 · 같은 주소의 날짜 없는
 * 옛 줄을 뺀 뒤, 배정 판으로 쓴 기록인지(planArticleOf) 가린다. 원장이 없으면 null.
 */
export function livePostsOf(plan: WriterPlan | null, posts: readonly LedgerPostLike[] | null): LivePosts | null {
  if (!posts) return null
  const rows = postingsOf([...posts])
    .flatMap((p) => p.live)
    .map((p) => ({ articleId: p.articleId, match: planArticleOf(plan, p) }))
  const planned = new Set(rows.filter((r) => r.match !== null && r.match !== 'bank-unknown').map((r) => r.articleId))
  const unsure = new Set(rows.filter((r) => r.match === 'bank-unknown' && !planned.has(r.articleId)).map((r) => r.articleId))
  return { any: new Set(rows.map((r) => r.articleId)), planned, unsure }
}

type TopicDef = Pick<ExtraArticle, 'id' | 'bankVersion' | 'questionIds' | 'questionTexts'>

/**
 * 배정 글의 기록에 싣는 질문 스냅샷 — 추가 글 정의가 있으면 그 정의의 판 · 문장, 없으면(판 미확인 — 질문 은행에서 만든 글) 배정 파일의
 * 판 · 문장. 작성자 기록(src/lib/postRegistration.ts writerRecordInput — CLI · 주소 한꺼번에 등록)과 보관함 「올렸어요」가 이 한 식을 쓴다.
 */
export function writerTopicSnapshot(article: WriterPlanArticle, plan: WriterPlan, extras: readonly TopicDef[]): TopicSnapshot {
  const def = extras.find((x) => x.id === article.id)
  return def ? extraTopicSnapshot(def) : { bankVersion: plan.bankVersion, questionIds: [...article.questionIds], questionTexts: [...article.questionTexts] }
}

/**
 * 배정 글(assignedArticle — 배정 판으로 만든 글 · 판 미확인 글)이면 작성자 기록과 같은 스냅샷(writerTopicSnapshot), 아니면(배정에 없음 · 다른
 * 판으로 만든 글 · 배정이나 추가 글 목록이 없음) null. 보관함 「올렸어요」(libraryRecordTopic) · 질문 은행 「올렸어요」
 * (src/pages/QuestionBank.tsx — null이면 지금처럼 질문 은행 판)가 이 식으로 배정 글을 가른다.
 */
export function assignedTopicSnapshot(plan: WriterPlan | null, extras: readonly TopicDef[] | null, articleId: string): TopicSnapshot | null {
  if (!plan || !extras) return null
  const assigned = assignedArticle(plan, new Map(extras.map((e) => [e.id, e])), articleId)
  return assigned ? writerTopicSnapshot(assigned.article, plan, extras) : null
}

/**
 * 보관함 「올렸어요」가 기록에 싣는 질문 스냅샷 — 배정 글(작성자 칸의 초안)은 주소 한꺼번에 등록 · CLI가 같은 글에 적는 작성자 기록과 같은
 * 스냅샷(assignedTopicSnapshot — 추가 글 정의의 판 · 문장, 정의가 없으면(판 미확인) 배정 파일의 판 · 문장). 질문 은행 판을 실으면 같은 글이
 * 적은 길에 따라 발행 현황 · 보관함 칸에서 올림 · 미확인 · 배정 밖으로 갈라진다. 그 밖에는 추가 글 정의가 있으면 그 정의의 판 · 문장(콘텐츠
 * 생성 recordInputOf와 같다 — 다른 판으로 만든 글도), 없으면 지금처럼 질문 은행으로 본다(topicSnapshotFor — 은행이 초안보다 나중이면 판
 * 없음). 추가 글 목록을 읽지 못했거나(null) 배정이 없거나 읽지 못했으면(null — 작성자 칸이 없다) · 초안이 없는 기록(주소만 남은 기록)이면
 * 배정 글로 가르지 않는다.
 */
export function libraryRecordTopic(
  articleId: string,
  extras: readonly TopicDef[] | null,
  bank: QuestionBank | null,
  draftGeneratedAt: string | undefined,
  plan: WriterPlan | null,
): TopicSnapshot | undefined {
  const assigned = draftGeneratedAt ? assignedTopicSnapshot(plan, extras, articleId) : null
  if (assigned) return assigned
  const def = extras?.find((e) => e.id === articleId)
  return def ? extraTopicSnapshot(def) : topicSnapshotFor(articleId, bank, draftGeneratedAt)
}

export interface AssignedArticle {
  article: WriterPlanArticle
  /** 판 미확인 — 추가 글 정의가 없어(질문 은행 화면에서 만든 글) 어느 질문지 판으로 썼는지 모른다. */
  bankUnknown: boolean
}

/**
 * 이 글의 배정 — 글 id가 배정에 있고, 그 추가 글을 배정 판으로 만들었거나(판을 앎) 추가 글 정의가 없을 때(판 미확인). 다른 판으로 만든 추가
 * 글 · 배정에 없는 글이면 null.
 */
export function assignedArticle(
  plan: WriterPlan | null,
  defs: ReadonlyMap<string, Pick<ExtraArticle, 'bankVersion'>>,
  articleId: string,
): AssignedArticle | null {
  const article = writerArticle(plan, articleId)
  if (!plan || !article) return null
  const def = defs.get(articleId)
  if (!def) return { article, bankUnknown: true }
  return def.bankVersion === plan.bankVersion ? { article, bankUnknown: false } : null
}

/** 보관함의 칸 — 배정과 추가 글 목록을 읽었으면 작성자별로 묶고, 아니면 한 목록(최근 순). 어느 쪽이든 모든 글이 한 번씩 나온다. */
export function libraryLayout<D extends LibraryDraftLike>(input: LibraryLayoutInput<D>): LibraryLayout<D> {
  const { plan, extras } = input
  if (!plan || input.planUnreadable) return { grouped: false, drafts: recentFirst(input.drafts), fallback: input.planUnreadable ? 'plan-unreadable' : null }
  if (!extras) return { grouped: false, drafts: recentFirst(input.drafts), fallback: 'extras-unreadable' }

  const defs = new Map(extras.map((e) => [e.id, e]))
  const order = new Map(plan.articles.map((a, i) => [a.id, i]))
  const byWriter = new Map<string, D[]>()
  const bankUnknown = new Set<string>()
  const outside: D[] = []
  for (const d of input.drafts) {
    const a = assignedArticle(plan, defs, d.actionId)
    if (!a) {
      outside.push(d)
      continue
    }
    byWriter.set(a.article.writer.key, [...(byWriter.get(a.article.writer.key) ?? []), d])
    if (a.bankUnknown) bankUnknown.add(d.actionId)
  }
  const live = livePostsOf(plan, input.posts)
  const countIn = (list: readonly D[], ids: ReadonlySet<string>) => list.filter((d) => ids.has(d.actionId)).length
  const sections: LibrarySection<D>[] = planWriters(plan).map((w) => {
    const mine = (byWriter.get(w.key) ?? []).sort((a, b) => (order.get(a.actionId) ?? 0) - (order.get(b.actionId) ?? 0))
    const made = new Set(mine.map((d) => d.actionId))
    return {
      pick: w.key,
      writer: { key: w.key, name: w.name },
      drafts: mine,
      bankUnknown: mine.filter((d) => bankUnknown.has(d.actionId)).map((d) => d.actionId),
      posted: live ? countIn(mine, live.planned) : null,
      unsure: live ? countIn(mine, live.unsure) : 0,
      unmade: plan.articles.filter((a) => a.writer.key === w.key && !made.has(a.id)).length,
    }
  })
  if (outside.length > 0) {
    const recent = recentFirst(outside)
    sections.push({ pick: OUTSIDE_PICK, writer: null, drafts: recent, bankUnknown: [], posted: live ? countIn(recent, live.any) : null, unsure: 0, unmade: 0 })
  }
  return { grouped: true, sections, total: input.drafts.length }
}

/** 고른 값이 지금 칸에 있으면 그대로, 없으면(다시 읽은 뒤 사라짐 · 묶지 않은 화면) 전체(''). */
export function validLibraryPick<D>(layout: LibraryLayout<D>, pick: string): string {
  return layout.grouped && pick && layout.sections.some((s) => s.pick === pick) ? pick : ''
}

/** 고르기 목록 — 전체, 작성자(「w1 · 이름」), 배정 밖 글이 있으면 「배정 밖 글」. 묶지 않은 화면이면 전체 하나. */
export function libraryPickOptions<D>(layout: LibraryLayout<D>): { value: string; label: string }[] {
  const all = { value: '', label: '전체' }
  if (!layout.grouped) return [all]
  return [all, ...layout.sections.map((s) => ({ value: s.pick, label: sectionTitle(s) }))]
}

/** 보이는 칸 — 전체면 모든 칸, 고르면 그 칸 하나. 묶지 않은 화면이면 없다. */
export function shownSections<D>(layout: LibraryLayout<D>, pick: string): LibrarySection<D>[] {
  if (!layout.grouped) return []
  const valid = validLibraryPick(layout, pick)
  return valid ? layout.sections.filter((s) => s.pick === valid) : layout.sections
}

/**
 * 「주소만 남은 기록」(초안이 없는 올린 기록)은 전체에서만 보인다 — 초안이 없어 추가 글 정의로 누구 글인지 가를 수 없고, 그 가운데는 초안을
 * 지운 배정 글도 있다(발행 현황은 기록의 판으로 작성자를 붙인다). 「배정 밖 글」 아래에 두면 배정 글의 기록을 배정 밖이라고 말하게 된다.
 */
export function orphansShown<D>(layout: LibraryLayout<D>, pick: string): boolean {
  return validLibraryPick(layout, pick) === ''
}

/** 칸 이름 — 「w1 · 이름」, 배정 밖 칸은 「배정 밖 글」. */
export function sectionTitle(section: Pick<LibrarySection<unknown>, 'writer'>): string {
  return section.writer ? `${section.writer.key} · ${section.writer.name}` : '배정 밖 글'
}

/**
 * 칸 머리의 수 — 「10편 · 올림 3」, 판을 몰라 배정 글로 세지 못한 기록이 있으면 「 · 올렸는지 미확인 1」, 아직 안 만든 배정 글이 있으면
 * 「 · 아직 안 만든 글 2편」. 원장을 못 읽었으면 올림은 말하지 않는다.
 */
export function sectionDetail(section: Pick<LibrarySection<unknown>, 'drafts' | 'posted' | 'unsure' | 'unmade'>): string {
  const posted = section.posted === null ? '' : ` · 올림 ${section.posted}`
  const unsure = section.unsure > 0 ? ` · 올렸는지 미확인 ${section.unsure}` : ''
  const unmade = section.unmade > 0 ? ` · 아직 안 만든 글 ${section.unmade}편` : ''
  return `${section.drafts.length}편${posted}${unsure}${unmade}`
}

/** 「글 N편」 안내 — 고르면 그 칸(scope: 작성자 키 · 「배정 밖」)의 글 수와 전체 글 수. */
export function libraryCount<D>(layout: LibraryLayout<D>, pick: string): { scope: string | null; shown: number; total: number } {
  if (!layout.grouped) return { scope: null, shown: layout.drafts.length, total: layout.drafts.length }
  const valid = validLibraryPick(layout, pick)
  const section = valid ? layout.sections.find((s) => s.pick === valid) : undefined
  if (!section) return { scope: null, shown: layout.total, total: layout.total }
  return { scope: section.writer ? section.writer.key : '배정 밖', shown: section.drafts.length, total: layout.total }
}
