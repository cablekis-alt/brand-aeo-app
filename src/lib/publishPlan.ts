import type { StoredDraft } from './api'
import { gapProgress } from './draftGaps'
import { channelNameOf, isPublishedAction, type GapAction } from './gapActions'
import { countGapNotes } from './markdownFile'
import { channelStyleOf } from '../prompts/b9d-channel-adapt'

/**
 * 콘텐츠 생성의 「② 올리기 목록」 — 글과 채널을 **한 번 올리기 = 한 줄**로 편다(상용화 UI 8차 시안).
 *
 * 예전 화면은 같은 일을 두 곳에 나눠 보였다: 글 카드 안 ③ 올리기의 채널 탭, 그리고 아래 「채널별 올림 현황」.
 * 같은 채널이 두 번 나와 서로 다른 일로 읽혔고, 무엇부터 올릴지는 사람이 견줘야 했다. 여기서 둘을 합쳐
 * 덮는 질문이 많은 순으로 한 목록을 만든다. 화면 없이 계산만 한다(scripts/verify-publish-plan.ts).
 *
 * 줄의 종류
 *   own      글 한 편의 자사 사이트 — 기록은 그 콘텐츠 항목에.
 *   channel  글이 덮는 외부 채널 — 기록은 그 채널 항목에. 채널은 **한 줄**이고, 질문을 가장 많이 덮는 글에
 *            붙는다. 올린 주소가 채널 항목 하나에 기록되므로 글마다 줄을 두면 하나를 올릴 때 둘 다 올린 것이 된다.
 *   orphan   덮는 글이 없는 채널 — 그 채널용으로 따로 쓴 초안이 곧 올릴 글이다.
 */

export type PublishRowKind = 'own' | 'channel' | 'orphan'

/** 줄의 버튼 — 채널 성격마다 하는 일이 다르다. */
export type PublishVerb = 'copy' | 'write' | 'doc' | 'place'

export const VERB_LABEL: Record<PublishVerb, string> = {
  copy: '복사하기',
  write: '복사하고 글쓰기 열기',
  doc: '복사하고 문서 열기',
  place: '복사하고 등록 페이지 열기',
}

/** 버튼 옆 주의 — 채널 규칙에 걸려 글이 지워지는 일을 막는다. */
export const VERB_CAUTION: Partial<Record<PublishVerb, string>> = {
  doc: '홍보성 서술은 지워집니다. 출처를 달 수 있는 사실만 넣으세요.',
  place: '장소 · 업체 등록 화면입니다. 소개 칸에 붙이세요.',
}

export interface PublishArticle {
  /** 글의 항목 — 콘텐츠 항목 또는 덮는 글이 없는 채널 항목. */
  action: GapAction
  draft: StoredDraft | undefined
  /** 초안이 있고 빈칸을 모두 처리했다(값을 넣었거나 뺐다). 확인 전 글의 줄은 잠긴다. */
  confirmed: boolean
  /** 아직 처리하지 않은 빈칸 수. 초안이 없으면 0. */
  gapsLeft: number
}

export interface PublishRow {
  key: string
  kind: PublishRowKind
  /** 이 줄에 올릴 글. */
  article: PublishArticle
  /** 「올렸어요」를 기록할 항목. own이면 글의 항목, 그 밖에는 채널 항목. */
  target: GapAction
  name: string
  /** 이 줄을 올리면 덮는 질문 — 정렬과 진행 수의 근거. */
  questionIds: string[]
  verb: PublishVerb
  /** 버튼이 열 주소. 없으면 복사만 한다. */
  openUrl: string | null
  /** 외부 채널 문체로 다듬은 글이 필요한가(channel만). own · orphan은 글을 그대로 쓴다. */
  needsAdapt: boolean
  locked: boolean
  done: boolean
}

export interface PublishPlan {
  articles: PublishArticle[]
  rows: PublishRow[]
  done: number
  /** 올린 줄이 덮는 질문(중복 없이) / 모든 줄이 덮는 질문. */
  coveredQuestions: number
  totalQuestions: number
}

function gapsLeftOf(d: StoredDraft | undefined): number {
  if (!d) return 0
  if (d.editedMarkdown) return countGapNotes(d.editedMarkdown)
  const p = gapProgress(d)
  return p.total - p.done
}

function articleOf(action: GapAction, drafts: Record<string, StoredDraft> | null): PublishArticle {
  const draft = drafts?.[action.id]
  const gapsLeft = gapsLeftOf(draft)
  return { action, draft, gapsLeft, confirmed: Boolean(draft) && gapsLeft === 0 }
}

/**
 * 채널을 열 주소. 글쓰기 화면 주소가 알려진 곳만 그리로 보낸다 — 로그인이 안 돼 있으면 그 사이트가 로그인
 * 화면으로 돌린다. 나머지는 첫 화면이다. 묶음(언론 N곳)은 도메인이 없어 null(복사만).
 */
export function openUrlOf(domain: string | undefined): string | null {
  if (!domain) return null
  const host = domain.replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
  if (host === 'blog.naver.com') return 'https://blog.naver.com/GoBlogWrite.naver'
  if (host === 'tistory.com') return 'https://www.tistory.com/'
  return `https://${host}`
}

export function verbOf(channel: GapAction): PublishVerb {
  if (!channel.targetDomain) return 'copy'
  const style = channelStyleOf(channel.badge)
  if (style === 'wiki') return 'doc'
  if (style === 'listing') return 'place'
  return 'write'
}

function overlap(a: string[], b: Set<string>): string[] {
  return a.filter((q) => b.has(q))
}

export function buildPublishPlan(
  openContent: GapAction[],
  openListing: GapAction[],
  drafts: Record<string, StoredDraft> | null,
): PublishPlan {
  const contentArticles = openContent.map((a) => articleOf(a, drafts))
  const qsets = new Map(openContent.map((a) => [a.id, new Set(a.questionIds)]))

  const rows: PublishRow[] = contentArticles.map((article) => ({
    key: `own:${article.action.id}`,
    kind: 'own',
    article,
    target: article.action,
    name: '자사 사이트',
    questionIds: article.action.questionIds,
    verb: 'copy',
    openUrl: null,
    needsAdapt: false,
    locked: !article.confirmed,
    done: isPublishedAction(article.action),
  }))

  const orphanArticles: PublishArticle[] = []
  for (const ch of openListing) {
    // 질문을 가장 많이 덮는 글. 같으면 앞의 글(밀린 질문이 많은 글)이다.
    let best: { article: PublishArticle; qs: string[] } | null = null
    for (const article of contentArticles) {
      const qs = overlap(ch.questionIds, qsets.get(article.action.id)!)
      if (qs.length > 0 && (!best || qs.length > best.qs.length)) best = { article, qs }
    }
    if (best) {
      rows.push({
        key: ch.id,
        kind: 'channel',
        article: best.article,
        target: ch,
        name: channelNameOf(ch),
        questionIds: best.qs,
        verb: verbOf(ch),
        openUrl: openUrlOf(ch.targetDomain),
        needsAdapt: true,
        locked: !best.article.confirmed,
        done: isPublishedAction(ch),
      })
    } else {
      const article = articleOf(ch, drafts)
      orphanArticles.push(article)
      rows.push({
        key: ch.id,
        kind: 'orphan',
        article,
        target: ch,
        name: channelNameOf(ch),
        questionIds: ch.questionIds,
        verb: verbOf(ch),
        openUrl: openUrlOf(ch.targetDomain),
        needsAdapt: false,
        locked: !article.confirmed,
        done: isPublishedAction(ch),
      })
    }
  }

  // 지금 할 수 있는 줄이 위, 그 안에서는 덮는 질문이 많은 순. sort는 안정 정렬이라 같으면 만든 순서가 남는다.
  rows.sort((a, b) => Number(a.locked) - Number(b.locked) || b.questionIds.length - a.questionIds.length)

  const all = new Set(rows.flatMap((r) => r.questionIds))
  const covered = new Set(rows.filter((r) => r.done).flatMap((r) => r.questionIds))
  return {
    articles: [...contentArticles, ...orphanArticles],
    rows,
    done: rows.filter((r) => r.done).length,
    coveredQuestions: covered.size,
    totalQuestions: all.size,
  }
}

/** 확인된 글의 외부 채널 중 목록 위쪽 n곳 — 미리 다듬어 둘 후보(아직 안 올린 것만). */
export function pregenerateTargets(plan: PublishPlan, n = 2): PublishRow[] {
  return plan.rows.filter((r) => r.needsAdapt && !r.locked && !r.done).slice(0, n)
}
