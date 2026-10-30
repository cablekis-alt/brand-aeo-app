import type { RecordPostInput, StoredDraft } from './api'
import { gapProgress } from './draftGaps'
import { extraTopicSnapshot, isExtraArticleId } from './extraArticles'
import { channelNameOf, isPublishedAction, type GapAction, type PublishedHit } from './gapActions'
import { countGapNotes } from './markdownFile'
import { blogWriteUrl } from './publishSettings'
import { channelStyleOf } from '../prompts/b9d-channel-adapt'

/**
 * 콘텐츠 생성의 「② 올리기 목록」 — 글과 채널을 **한 번 올리기 = 한 줄**로 편다(상용화 UI 8차 시안).
 *
 * 예전 화면은 같은 일을 두 곳에 나눠 보였다: 글 카드 안 ③ 올리기의 채널 탭, 그리고 아래 「채널별 올림 현황」.
 * 같은 채널이 두 번 나와 서로 다른 일로 읽혔고, 무엇부터 올릴지는 사람이 견줘야 했다. 여기서 둘을 합쳐
 * 덮는 질문이 많은 순으로 한 목록을 만든다. 화면 없이 계산만 한다(scripts/verify-publish-plan.ts · verify-extra-articles.ts).
 *
 * 줄의 종류
 *   own      글 한 편의 자사 사이트 — 기록은 그 콘텐츠 항목에.
 *   channel  글이 덮는 외부 채널 — 기록은 그 채널 항목에.
 *   orphan   덮는 글이 없는 채널 — 그 채널용으로 따로 쓴 초안이 곧 올릴 글이다.
 *
 * 본 글과 추가 글
 *   본 글은 topic:이 아닌 첫 글이다. 항목은 순위 · 밀린 질문 수 순이라 추가 글(topic: — src/lib/extraArticles.ts)이 본 글보다 앞에 올 수
 *   있다. 맨 앞 글을 본 글로 보면 이미 올린 채널이 추가 글로 넘어간다.
 *   블로그 플랫폼(티스토리 · 네이버 블로그 등)은 글마다 따로 올리는 곳이라, 본 글 줄과 별도로 추가 글마다 줄을 준다 — 그 글의 질문과
 *   겹치는 곳, 이 브랜드가 이미 글을 올린 곳, 그 글로 이미 올린 곳에만. 열린 플랫폼 전부에 주면 계정도 없는 곳까지 줄이 는다.
 *   플랫폼이 아닌 채널(위키 · 여행 사이트 등)은 같은 업체를 여러 번 올릴 곳이 아니라 **한 줄**이고, 본 글을 먼저 본다: 본 글(topic:이
 *   아닌 글)로 올렸거나 그 글과 겹치면 그 글, 아니면 가장 많이 겹치는 추가 글, 그래도 아니지만 이미 올린 곳이면 본 글. 「덮는 글 없는
 *   채널」은 어느 글도 받지 못했을 때만 생긴다. 이미 올린 곳이 다른 글로 넘어가면 「본문 다시 복사」가 엉뚱한 글을 복사한다 — 그래서
 *   본 글로 올린 기록이 없고 살아 있는 추가 글로만 올린 곳은 그 추가 글에 둔다. 「집행함」만으로는 본 글로 올렸다고 보지 않는다 —
 *   추가 글로 올린 단일 채널도 「집행함」이 된다. 본 글 줄을 붙이는 「이미 올린 곳」도 topic:이 아닌 기록과 집행 상태로만 본다 — 추가 글
 *   기록까지 세면 추가 글만 올린 플랫폼에 아무도 쓰지 않은 본 글 줄이 생긴다.
 *
 * 「올림」은 줄마다 그 글의 기록으로 판정한다(PublishRow.hits). 채널 항목 하나에 여러 글의 기록이 모이기 때문이다. 추가 글의 블로그
 * 플랫폼 줄은 그 글의 기록만 보고, 기록할 때 채널 항목의 집행 상태를 바꾸지 않는다(recordInputOf) — 집행 상태는 그 플랫폼의 본 글 줄
 * 것이다. 그 밖의 줄은 지금처럼 집행 상태와 기록으로 보되 topic: 기록은 뺀다 — 「목록에서 빼기」로 치운 추가 글의 기록도 본 글 줄을
 * 「올림」으로 만들지 않는다. 단일 채널은 줄이 하나라 추가 글이 맡아도 집행 상태를 함께 쓴다 — 그 글을 치워도 그 채널은 「올림」으로 남는다.
 */

export type PublishRowKind = 'own' | 'channel' | 'orphan'

/** 줄의 버튼 — 채널 성격마다 하는 일이 다르다. */
export type PublishVerb = 'copy' | 'write' | 'doc' | 'place' | 'update'

export const VERB_LABEL: Record<PublishVerb, string> = {
  copy: '복사하기',
  write: '복사하고 글쓰기 열기',
  doc: '복사하고 문서 열기',
  place: '복사하고 등록 페이지 열기',
  update: '복사하고 우리 업체 페이지 열기',
}

/** 버튼 옆 주의 — 채널 규칙에 걸려 글이 지워지는 일을 막는다. */
export const VERB_CAUTION: Partial<Record<PublishVerb, string>> = {
  doc: '홍보성 서술은 지워집니다. 출처를 달 수 있는 사실만 넣으세요.',
  place: '장소 · 업체 등록 화면입니다. 소개 칸에 붙이세요.',
  update:
    '이미 등록된 업체입니다 — 새로 등록하지 말고, 이 플랫폼의 업체 관리(파트너) 화면에서 소개 칸 · 사진 설명을 이 글로 보강하세요. ' +
    '후기는 지어내지 말고, 받은 후기에 답글을 달 때 위치 · 시설 말을 쓰세요.',
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
  /**
   * 이 줄의 글이 이 대상에 남긴 기록(집행 원장). 추가 글의 줄은 그 글의 기록만, 그 밖의 줄은 topic:이 아닌 기록만 — 채널 항목 하나에
   * 여러 글의 기록이 모인다. 덮는 글이 없는 주의 「올린 주소만 다루는 줄」은 살아 있는 추가 글 줄에 보이지 않는 기록을 모두 받는다.
   */
  hits: PublishedHit[]
  /** hits의 주소(같은 순서). */
  publishedUrls: string[]
  /** 그중 이번 주 인용에 나온 주소. */
  citedUrls: string[]
  /**
   * 채널마다 channel 줄 하나 — 본 글 줄이 먼저다. 화면의 채널 앵커(action-<채널 id>)와 focus 강조를 받는다. own · orphan 줄은 false다
   * (그 글 카드가 같은 앵커를 쓴다).
   */
  anchor: boolean
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
  if (style === 'listing-update') return 'update'
  if (style === 'listing') return 'place'
  return 'write'
}

function overlap(a: string[], b: Set<string>): string[] {
  return a.filter((q) => b.has(q))
}

/** 블로그 플랫폼 채널(gapActions listingActions — 플랫폼 단위로 묶은 항목). 글마다 따로 올릴 수 있는 곳이다. */
export const isBlogPlatformChannel = (a: GapAction): boolean => a.id.startsWith('listing:platform:')

type RowRecords = Pick<PublishRow, 'hits' | 'publishedUrls' | 'citedUrls'>

/**
 * 대상 항목의 기록 가운데 keep이 고른 글의 것. exact가 아니고 빠진 기록이 없으면 항목의 주소를 그대로 쓴다 — 기록 줄 없이 주소만 실린
 * 항목(옛 계산 · 검사의 가짜 항목)도 지금과 같게 보인다. 추가 글 줄은 exact — 그 글의 기록에서만 주소를 낸다.
 */
function recordsOf(target: GapAction, keep: (articleId: string) => boolean, exact: boolean): RowRecords {
  const all = target.publishedHits ?? []
  const hits = all.filter((h) => keep(h.post.articleId))
  if (!exact && hits.length === all.length) return { hits, publishedUrls: target.publishedUrls, citedUrls: target.citedPublishedUrls }
  const urls = hits.map((h) => h.post.url)
  return { hits, publishedUrls: urls, citedUrls: target.citedPublishedUrls.filter((u) => urls.includes(u)) }
}

const notExtra = (articleId: string) => !isExtraArticleId(articleId)

/** 줄의 기록으로 본 「올림」 — 주소가 있거나 대상 항목이 「집행함」. 기록을 거르지 않으면 isPublishedAction과 같다. */
const isPublishedIn = (records: RowRecords, target: GapAction): boolean => records.publishedUrls.length > 0 || target.status === 'done'

export interface PublishPlanOptions {
  /**
   * 브랜드 블로그(발행 설정 — src/lib/publishSettings.ts). 있으면 자사 줄이 「자사 블로그」가 되고 버튼이 그 블로그의
   * 글쓰기 화면을 연다. 없으면 지금처럼 복사만 한다.
   */
  blogUrl?: string
}

export function buildPublishPlan(
  openContent: GapAction[],
  openListing: GapAction[],
  drafts: Record<string, StoredDraft> | null,
  opts: PublishPlanOptions = {},
): PublishPlan {
  const contentArticles = openContent.map((a) => articleOf(a, drafts))
  const qsets = new Map(openContent.map((a) => [a.id, new Set(a.questionIds)]))
  const blogOpen = opts.blogUrl ? blogWriteUrl(opts.blogUrl) : null
  // 본 글 — topic:이 아닌 첫 글. 추가 글이 앞에 올 수 있어 contentArticles[0]으로 보지 않는다.
  const baseArticles = contentArticles.filter((x) => !isExtraArticleId(x.action.id))
  const extraArticles = contentArticles.filter((x) => isExtraArticleId(x.action.id))
  const main = baseArticles[0] ?? null
  const aliveExtra = new Set(extraArticles.map((x) => x.action.id))

  const rows: PublishRow[] = contentArticles.map((article) => {
    const id = article.action.id
    const records = isExtraArticleId(id) ? recordsOf(article.action, (a) => a === id, true) : recordsOf(article.action, notExtra, false)
    return {
      key: `own:${id}`,
      kind: 'own',
      article,
      target: article.action,
      name: blogOpen ? '자사 블로그' : '자사 사이트',
      questionIds: article.action.questionIds,
      verb: blogOpen ? 'write' : 'copy',
      openUrl: blogOpen,
      needsAdapt: false,
      locked: !article.confirmed,
      ...records,
      anchor: false,
      done: isPublishedIn(records, article.action),
    }
  })

  // 글이 덮는 채널 줄. 추가 글의 줄은 그 글의 기록만 보인다. 추가 글의 플랫폼 줄은 그 기록만으로 「올림」을 본다 — 플랫폼 항목의 집행
  // 상태는 본 글 줄의 것이다(recordInputOf). 단일 채널은 줄이 하나라 누가 맡든 집행 상태도 본다.
  const channelRow = (ch: GapAction, article: PublishArticle, questionIds: string[], key = ch.id): PublishRow => {
    const id = article.action.id
    const extra = isExtraArticleId(id)
    const records = extra ? recordsOf(ch, (a) => a === id, true) : recordsOf(ch, notExtra, false)
    const ownState = extra && isBlogPlatformChannel(ch)
    return {
      key,
      kind: 'channel',
      article,
      target: ch,
      name: channelNameOf(ch),
      questionIds,
      verb: verbOf(ch),
      // 이미 등록된 곳이면 사이트 첫 화면이 아니라 우리 업체 페이지를 연다(gapActions listedPage).
      openUrl: ch.listedPage ?? openUrlOf(ch.targetDomain),
      needsAdapt: true,
      locked: !article.confirmed,
      ...records,
      anchor: false,
      done: ownState ? records.hits.length > 0 : isPublishedIn(records, ch),
    }
  }
  // 본 글이 없는 주(카테고리 무관 질문을 모두 이긴 주)의 이미 올린 곳 — 올린 주소만 다루는 줄이다. 따로 쓸 글로 만들면 잠긴 줄이
  // 되어 올린 주소가 「글 만들러 가기」 뒤로 숨고, ① 글 확인에 채널마다 글이 다시 생긴다. 살아 있는 추가 글의 기록은 그 글 줄이 보인다.
  const addressRecords = (ch: GapAction) => recordsOf(ch, (a) => !aliveExtra.has(a), false)
  const addressRow = (ch: GapAction): PublishRow => {
    const records = addressRecords(ch)
    return {
      key: ch.id,
      kind: 'channel',
      article: articleOf(ch, drafts),
      target: ch,
      name: channelNameOf(ch),
      questionIds: [],
      verb: verbOf(ch),
      openUrl: ch.listedPage ?? openUrlOf(ch.targetDomain),
      needsAdapt: false,
      locked: false,
      ...records,
      anchor: false,
      done: isPublishedIn(records, ch),
    }
  }
  // 질문을 가장 많이 덮는 글. 같으면 앞의 글(밀린 질문이 많은 글)이다.
  const bestOf = (ch: GapAction, list: PublishArticle[]): { article: PublishArticle; qs: string[] } | null => {
    let best: { article: PublishArticle; qs: string[] } | null = null
    for (const article of list) {
      const qs = overlap(ch.questionIds, qsets.get(article.action.id)!)
      if (qs.length > 0 && (!best || qs.length > best.qs.length)) best = { article, qs }
    }
    return best
  }
  const postedBy = (ch: GapAction, articleId: string) => (ch.publishedHits ?? []).some((h) => h.post.articleId === articleId)

  const orphanArticles: PublishArticle[] = []
  for (const ch of openListing) {
    const baseBest = bestOf(ch, baseArticles)
    // 본 글(topic:이 아닌 글)로 올린 곳 — topic: 기록은 세지 않는다. 추가 글 기록까지 세면 추가 글만 올린 곳에 빈 본 글 줄이 붙는다.
    const baseRecords = recordsOf(ch, notExtra, false)
    const here: PublishRow[] = []
    if (isBlogPlatformChannel(ch)) {
      // 본 글 줄 — 배정은 예전과 같다. 본 글로 이미 올린 곳은 이번 주 겹치는 질문이 없어도 본 글 줄로 남긴다 — 따로 쓸 글로 쪼개면 올린
      // 주소가 「글 만들러 가기」 뒤로 숨고, 새 기록이 다른 글로 적힌다.
      if (baseBest) here.push(channelRow(ch, baseBest.article, baseBest.qs))
      else if (main && isPublishedIn(baseRecords, ch)) here.push(channelRow(ch, main, []))
      else if (!main && isPublishedIn(addressRecords(ch), ch)) here.push(addressRow(ch))
      // 추가 글 줄 — 그 글의 질문과 겹치는 곳, 이 브랜드가 이미 글을 올린 곳(계정이 있다), 그 글로 이미 올린 곳.
      for (const x of extraArticles) {
        const qs = overlap(ch.questionIds, qsets.get(x.action.id)!)
        if (qs.length > 0 || isPublishedAction(ch) || postedBy(ch, x.action.id)) here.push(channelRow(ch, x, qs, `${x.action.id}|${ch.id}`))
      }
    } else {
      // 단일 채널 — 한 줄, 본 글 먼저. 본 글로 올린 기록이 없고 살아 있는 추가 글로만 올린 곳은 그 글에 둔다(올린 글과 다시 복사할 글이
      // 같게). 「집행함」은 여기서 보지 않는다 — 추가 글로 올려도 집행함이 되고, 사람이 바꿀 수도 있다.
      const owner = baseRecords.publishedUrls.length > 0 ? undefined : extraArticles.find((x) => postedBy(ch, x.action.id))
      const extraBest = bestOf(ch, extraArticles)
      if (owner) here.push(channelRow(ch, owner, overlap(ch.questionIds, qsets.get(owner.action.id)!)))
      else if (baseBest) here.push(channelRow(ch, baseBest.article, baseBest.qs))
      else if (main && isPublishedIn(baseRecords, ch)) here.push(channelRow(ch, main, []))
      else if (!main && isPublishedIn(baseRecords, ch)) here.push(addressRow(ch))
      else if (extraBest) here.push(channelRow(ch, extraBest.article, extraBest.qs))
      else if (!main && isPublishedAction(ch)) here.push(addressRow(ch))
    }
    if (here.length > 0) {
      here[0]!.anchor = true
      rows.push(...here)
      continue
    }
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
      // 이미 등록된 곳이면 사이트 첫 화면이 아니라 우리 업체 페이지를 연다(gapActions listedPage).
      openUrl: ch.listedPage ?? openUrlOf(ch.targetDomain),
      needsAdapt: false,
      locked: !article.confirmed,
      ...baseRecords,
      anchor: false,
      done: isPublishedIn(baseRecords, ch),
    })
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

/**
 * 이 줄의 「올렸어요」가 원장에 남길 글 · 대상 · 경로. 추가 글의 블로그 플랫폼 줄은 markDone false — 플랫폼 항목의 집행 상태는 본 글
 * 줄의 것이라, 추가 글을 티스토리에 올려도 본 글의 티스토리 줄이 「올림」이 되지 않는다. 추가 글이 맡은 단일 채널 줄은 markDone true —
 * 줄이 하나라 집행 상태도 그 줄의 것이고, 그 글을 목록에서 빼도 이미 등록한 곳이 「올리기」로 돌아가지 않는다. 추가 글의 기록에는 만들
 * 때의 질문 스냅샷을 싣는다(원장 검사 checkTopic을 늘 통과한다).
 */
export function recordInputOf(row: PublishRow): Pick<RecordPostInput, 'articleId' | 'targetActionId' | 'via' | 'markDone' | 'topic'> {
  const articleId = row.article.action.id
  const topic = isExtraArticleId(articleId) ? row.article.action.extra?.topic : undefined
  return {
    articleId,
    targetActionId: row.target.id,
    via: row.kind,
    markDone: !(row.kind === 'channel' && isExtraArticleId(articleId) && isBlogPlatformChannel(row.target)),
    ...(topic?.bankVersion ? { topic: extraTopicSnapshot({ ...topic, bankVersion: topic.bankVersion }) } : {}),
  }
}
