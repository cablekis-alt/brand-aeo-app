import { AUTO_LATE_DAY, AUTO_TURN_DAY } from './indexAuto'
import { planWriters, type WriterPlan } from './probePlan'
import { addDays, type PublishStatusRow } from './publishStatus'

/**
 * 콘텐츠 생성 화면 맨 위 「작성자 진행판」의 숫자 — 작성자마다 초안 · 사진 · 빈칸 처리 · 올림 · 구글 색인과 다음 할 일(2026-11-11 개편 시안,
 * memory content-ui-redesign-mockup). 화면 없이 계산만 한다(scripts/verify-content-progress.ts).
 *
 * 재료는 화면이 이미 가진 것이다 — 배정(probe-plan), 초안이 있는 글, 글마다 남은 빈칸(publishPlan.ts PublishArticle.gapsLeft), 작성자별 사진 자리
 * 셈(photoAutoPick.ts photoSlotStats), 그리고 발행 현황 줄(publishStatus.ts — 올린 글 · 구글 확인 기록). 발행 현황을 못 읽었으면 올림 · 색인 칸은
 * 0이 아니라 「확인 불가」(tone 'na')다(memory aeo-unmeasured-metric-policy).
 *
 * 「빈칸 처리」는 앱의 「확인됨」과 같은 뜻이다 — 빈칸을 모두 채우거나 뺀 글. 작성자 묶음은 빈칸 줄을 빼고 내보내므로 다음 할 일에는 넣지 않는다.
 */

export type StageTone = 'done' | 'partial' | 'none' | 'na'

export interface StageCell {
  done: number
  total: number
  tone: StageTone
}

export interface PhotoCell extends StageCell {
  /** 빈 사진 자리(채우지도 빼지도 않은 자리). */
  empty: number
}

export interface IndexCell extends StageCell {
  /** 다음 구글 자동 확인 날(올린 지 14일째, 자동 「아직」이면 30일째). 볼 글이 없으면 null. */
  nextCheck: string | null
  /** 오늘이 그날이거나 지났다 — 「구글 자동 확인」을 누르면 볼 차례. */
  due: boolean
}

export type NextStep =
  | { kind: 'draft'; count: number }
  | { kind: 'photo'; count: number }
  | { kind: 'post'; count: number }
  | { kind: 'unknown' }
  | { kind: 'done' }

export interface WriterProgress {
  key: string
  name: string
  articles: number
  draft: StageCell
  photo: PhotoCell
  gaps: StageCell & { left: number }
  posted: StageCell
  indexed: IndexCell
  next: NextStep
}

export interface ProgressTotals {
  articles: number
  draft: StageCell
  photo: PhotoCell
  gaps: StageCell & { left: number }
  posted: StageCell
  indexed: IndexCell
  /** 안 올린 글이 남은 작성자 — 키와 남은 수(배정 순서). */
  postLeft: { key: string; count: number }[]
}

export interface ProgressInput {
  plan: WriterPlan
  /** 초안이 있는 글 id. */
  drafted: ReadonlySet<string>
  /** 글 id → 남은 빈칸 수(초안이 없으면 넣지 않는다). */
  gapsLeft: Readonly<Record<string, number>>
  /** 작성자 키 → 사진 자리 셈(초안이 있는 배정 글만). 없으면 그 작성자는 자리 0. */
  photos: Readonly<Record<string, { slots: number; filled: number; empty: number }>>
  /** 이 브랜드의 발행 현황 줄. 못 읽었으면 null — 올림 · 색인은 확인 불가. */
  statusRows: readonly PublishStatusRow[] | null
  /** 오늘(YYYY-MM-DD, KST). */
  today: string
}

export function stageTone(done: number, total: number): StageTone {
  if (total <= 0) return 'na'
  if (done >= total) return 'done'
  return done > 0 ? 'partial' : 'none'
}

const cell = (done: number, total: number): StageCell => ({ done, total, tone: stageTone(done, total) })
const unknownCell = (total: number): StageCell => ({ done: 0, total, tone: 'na' })

/** 글 하나를 올렸는가 — 발행 현황의 올린 줄(뺀 줄 제외)이 그 글 id를 가리키면. */
function postedRowsOf(rows: readonly PublishStatusRow[], articleId: string): PublishStatusRow[] {
  return rows.filter((r) => r.kind === 'posted' && !r.removed && r.articleId === articleId)
}

/** 올린 글 한 편의 다음 구글 자동 확인 날 — 색인됨이면 null, 확인 전이면 14일째, 자동 「아직」이면 30일째(이미 30일째 넘어 봤으면 null). */
export function nextGoogleCheck(row: Pick<PublishStatusRow, 'publishedOn' | 'recheckFrom' | 'google'>): string | null {
  if (row.google?.state === 'shown') return null
  const base = row.recheckFrom ?? row.publishedOn
  if (!base) return null
  if (!row.google) return addDays(base, AUTO_TURN_DAY)
  const late = addDays(base, AUTO_LATE_DAY)
  return row.google.checkedOn < late ? late : null
}

/** 작성자 진행판 — 배정 순서의 작성자마다. */
export function contentProgress(input: ProgressInput): { writers: WriterProgress[]; totals: ProgressTotals } {
  const { plan, drafted, gapsLeft, photos, statusRows, today } = input
  const writers = planWriters(plan).map((w): WriterProgress => {
    const mine = plan.articles.filter((a) => a.writer.key === w.key)
    const ids = mine.map((a) => a.id)
    const draftedIds = ids.filter((id) => drafted.has(id))
    const handled = draftedIds.filter((id) => (gapsLeft[id] ?? 0) === 0).length
    const left = draftedIds.reduce((n, id) => n + (gapsLeft[id] ?? 0), 0)
    const p = photos[w.key] ?? { slots: 0, filled: 0, empty: 0 }
    let posted: StageCell
    let indexed: IndexCell
    let postedCount = 0
    if (statusRows) {
      const postedIds = ids.filter((id) => postedRowsOf(statusRows, id).length > 0)
      postedCount = postedIds.length
      let shown = 0
      let nextCheck: string | null = null
      for (const id of postedIds) {
        const rows = postedRowsOf(statusRows, id)
        if (rows.some((r) => r.google?.state === 'shown')) {
          shown += 1
          continue
        }
        for (const r of rows) {
          const day = nextGoogleCheck(r)
          if (day && (nextCheck === null || day < nextCheck)) nextCheck = day
        }
      }
      posted = cell(postedCount, ids.length)
      indexed = { ...cell(shown, postedCount), nextCheck, due: nextCheck !== null && nextCheck <= today }
    } else {
      posted = unknownCell(ids.length)
      indexed = { ...unknownCell(0), nextCheck: null, due: false }
    }
    const notDrafted = ids.length - draftedIds.length
    const next: NextStep =
      notDrafted > 0
        ? { kind: 'draft', count: notDrafted }
        : p.empty > 0
          ? { kind: 'photo', count: p.empty }
          : !statusRows
            ? { kind: 'unknown' }
            : postedCount < ids.length
              ? { kind: 'post', count: ids.length - postedCount }
              : { kind: 'done' }
    return {
      key: w.key,
      name: w.name,
      articles: ids.length,
      draft: cell(draftedIds.length, ids.length),
      photo: { ...cell(p.filled, p.slots), empty: p.empty },
      gaps: { ...cell(handled, draftedIds.length), left },
      posted,
      indexed,
      next,
    }
  })
  const sum = (f: (w: WriterProgress) => number) => writers.reduce((n, w) => n + f(w), 0)
  const nextChecks = writers.map((w) => w.indexed.nextCheck).filter((d): d is string => d !== null).sort()
  const totals: ProgressTotals = {
    articles: sum((w) => w.articles),
    draft: cell(sum((w) => w.draft.done), sum((w) => w.draft.total)),
    photo: { ...cell(sum((w) => w.photo.done), sum((w) => w.photo.total)), empty: sum((w) => w.photo.empty) },
    gaps: { ...cell(sum((w) => w.gaps.done), sum((w) => w.gaps.total)), left: sum((w) => w.gaps.left) },
    posted: statusRows ? cell(sum((w) => w.posted.done), sum((w) => w.posted.total)) : unknownCell(sum((w) => w.posted.total)),
    indexed: statusRows
      ? { ...cell(sum((w) => w.indexed.done), sum((w) => w.indexed.total)), nextCheck: nextChecks[0] ?? null, due: (nextChecks[0] ?? '9999') <= today }
      : { ...unknownCell(0), nextCheck: null, due: false },
    postLeft: statusRows ? writers.filter((w) => w.posted.done < w.posted.total).map((w) => ({ key: w.key, count: w.posted.total - w.posted.done })) : [],
  }
  return { writers, totals }
}

/** 칸 글자 — 「10/10」, 확인 불가면 「확인 불가」, 대상이 없으면 「-」. */
export function cellText(c: StageCell): string {
  if (c.tone === 'na') return c.total > 0 ? '확인 불가' : '-'
  return `${c.done}/${c.total}`
}

/** 다음 할 일 글자. */
export function nextStepText(n: NextStep): string {
  switch (n.kind) {
    case 'draft':
      return `초안 ${n.count}편 만들기`
    case 'photo':
      return `사진 빈자리 ${n.count}곳`
    case 'post':
      return `${n.count}편 올리기`
    case 'unknown':
      return '올림 확인 불가'
    default:
      return '다 올림'
  }
}

export type ListMode = 'todo' | 'all'

/** 아래 글 목록에 보일 글인가 — 작성자 거르기(없으면 모두) · 「할 일만」이면 안 올린 글만. 발행 현황을 못 읽었으면 할 일만에서도 모두 보인다. */
export function showsArticle(
  articleId: string,
  writerOf: (id: string) => string | null,
  filter: { writer: string | null; mode: ListMode },
  postedIds: ReadonlySet<string> | null,
): boolean {
  if (filter.writer && writerOf(articleId) !== filter.writer) return false
  if (filter.mode === 'all' || !postedIds) return true
  return !postedIds.has(articleId)
}

/** 발행 현황 줄에서 올린 글 id(뺀 줄 제외). 줄을 못 읽었으면 null. */
export function postedArticleIds(rows: readonly PublishStatusRow[] | null): Set<string> | null {
  if (!rows) return null
  return new Set(rows.filter((r) => r.kind === 'posted' && !r.removed).map((r) => r.articleId))
}
