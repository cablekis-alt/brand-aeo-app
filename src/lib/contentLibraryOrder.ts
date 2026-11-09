import type { ExtraArticle } from './extraArticles'
import { planWriters, writerArticle, type PlanWriter, type WriterPlan, type WriterPlanArticle } from './probePlan'

/**
 * 콘텐츠 보관함(src/pages/ContentLibrary.tsx)의 글 순서.
 *
 * 작성자 배정(src/lib/probePlan.ts)이 있는 브랜드는 글 80편이 한 목록에 최근 고친 순으로 섞여 누구 글인지 · 몇 편이 남았는지 보기
 * 어려웠다. 배정이 있으면 작성자마다 한 칸(배정표에 처음 나온 순서 — w1 → w8)으로 묶고, 칸 안은 배정표 순서로 둔다. 배정 밖 글(본 글 ·
 * 배정에 없는 질문 글 · 다른 판으로 만든 글)은 마지막 칸에 지금처럼 최근 순이다. 배정이 없는 브랜드는 지금과 같은 한 목록이다.
 *
 * ── 누구 글인가 ─────────────────────────────────────────────────────────────
 * 콘텐츠 생성(src/pages/GapActions.tsx writerArticleOf)과 같은 규칙 — 글 id가 배정에 있고, 그 추가 글 정의(src/lib/extraArticles.ts)를
 * 배정 판으로 만들었어야 한다. 질문 id의 뜻은 판마다 바뀌므로 같은 id라도 다른 판으로 만든 글은 다른 질문이다. 초안에는 판이 없어 추가 글
 * 정의로 본다(「목록에서 빼기」 한 정의도 판은 남는다 — 콘텐츠 생성도 뺀 정의까지 본다). 발행 현황(src/lib/publishStatus.ts
 * planArticleOf)은 같은 규칙을 올린 기록의 질문 스냅샷 판으로 본다.
 *
 * ── 운영 기간 ───────────────────────────────────────────────────────────────
 * 운영 기간(activeUntil)이 지나도 묶는다 — 기간은 글 만들기의 잠금이고, 이미 쓴 글이 누구 몫인지는 바뀌지 않는다. 발행 현황도 기간과
 * 상관없이 작성자 칸을 채운다.
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

/** 「배정 밖 글」 고르기 값 — 작성자 키(영문 · 숫자 · _ · -)가 될 수 없는 글자로 둔다. */
export const OUTSIDE_PICK = ':outside'

export interface LibrarySection<D> {
  /** 고르기 값 — 작성자 키, 배정 밖 글은 OUTSIDE_PICK. */
  pick: string
  /** 배정 밖 글이면 null. */
  writer: PlanWriter | null
  drafts: D[]
  /** 올린 글(내리지 않은 기록)이 있는 글 수 — 원장을 읽지 못했으면 null(0으로 채우지 않는다). */
  posted: number | null
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
  /** 올린 글(내리지 않은 기록)이 있는 글 id — 원장을 읽지 못했으면 null. */
  livePostIds: ReadonlySet<string> | null
}

/** 올린 글이 있는 글 id — 내린 기록(removedAt)만 있는 글은 넣지 않는다. 원장이 없으면 null. */
export function liveArticleIds(posts: readonly { articleId: string; removedAt?: string }[] | null): Set<string> | null {
  return posts ? new Set(posts.filter((p) => !p.removedAt).map((p) => p.articleId)) : null
}

/** 이 글의 배정 — 글 id가 배정에 있고 그 추가 글을 배정 판으로 만들었을 때만. 아니면 null. */
export function assignedArticle(
  plan: WriterPlan | null,
  defs: ReadonlyMap<string, Pick<ExtraArticle, 'bankVersion'>>,
  articleId: string,
): WriterPlanArticle | null {
  return plan && defs.get(articleId)?.bankVersion === plan.bankVersion ? writerArticle(plan, articleId) : null
}

/** 보관함의 칸 — 배정과 추가 글 목록을 읽었으면 작성자별로 묶고, 아니면 한 목록(최근 순). 어느 쪽이든 모든 글이 한 번씩 나온다. */
export function libraryLayout<D extends LibraryDraftLike>(input: LibraryLayoutInput<D>): LibraryLayout<D> {
  const { plan, extras, livePostIds } = input
  if (!plan || input.planUnreadable) return { grouped: false, drafts: recentFirst(input.drafts), fallback: input.planUnreadable ? 'plan-unreadable' : null }
  if (!extras) return { grouped: false, drafts: recentFirst(input.drafts), fallback: 'extras-unreadable' }

  const defs = new Map(extras.map((e) => [e.id, e]))
  const order = new Map(plan.articles.map((a, i) => [a.id, i]))
  const byWriter = new Map<string, D[]>()
  const outside: D[] = []
  for (const d of input.drafts) {
    const a = assignedArticle(plan, defs, d.actionId)
    if (!a) outside.push(d)
    else byWriter.set(a.writer.key, [...(byWriter.get(a.writer.key) ?? []), d])
  }
  const postedOf = (list: readonly D[]) => (livePostIds ? list.filter((d) => livePostIds.has(d.actionId)).length : null)
  const sections: LibrarySection<D>[] = planWriters(plan).map((w) => {
    const mine = (byWriter.get(w.key) ?? []).sort((a, b) => (order.get(a.actionId) ?? 0) - (order.get(b.actionId) ?? 0))
    const made = new Set(mine.map((d) => d.actionId))
    return {
      pick: w.key,
      writer: { key: w.key, name: w.name },
      drafts: mine,
      posted: postedOf(mine),
      unmade: plan.articles.filter((a) => a.writer.key === w.key && !made.has(a.id)).length,
    }
  })
  if (outside.length > 0) {
    const recent = recentFirst(outside)
    sections.push({ pick: OUTSIDE_PICK, writer: null, drafts: recent, posted: postedOf(recent), unmade: 0 })
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

/** 칸 머리의 수 — 「10편 · 올림 3」, 아직 안 만든 배정 글이 있으면 「 · 아직 안 만든 글 2편」. 원장을 못 읽었으면 올림은 말하지 않는다. */
export function sectionDetail(section: Pick<LibrarySection<unknown>, 'drafts' | 'posted' | 'unmade'>): string {
  const posted = section.posted === null ? '' : ` · 올림 ${section.posted}`
  const unmade = section.unmade > 0 ? ` · 아직 안 만든 글 ${section.unmade}편` : ''
  return `${section.drafts.length}편${posted}${unmade}`
}

/** 「글 N편」 안내 — 고르면 그 칸(scope: 작성자 키 · 「배정 밖」)의 글 수와 전체 글 수. */
export function libraryCount<D>(layout: LibraryLayout<D>, pick: string): { scope: string | null; shown: number; total: number } {
  if (!layout.grouped) return { scope: null, shown: layout.drafts.length, total: layout.drafts.length }
  const valid = validLibraryPick(layout, pick)
  const section = valid ? layout.sections.find((s) => s.pick === valid) : undefined
  if (!section) return { scope: null, shown: layout.total, total: layout.total }
  return { scope: section.writer ? section.writer.key : '배정 밖', shown: section.drafts.length, total: layout.total }
}
