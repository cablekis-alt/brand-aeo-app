/**
 * 올린 글 주소를 원장에 적는 규칙 — CLI(scripts/register-posts.ts)와 앱(발행 현황 「주소 한꺼번에 등록」, server/postImport.ts)이 이 한
 * 벌을 쓴다. 두 길이 같은 글에 다른 기록(자사 줄 · 직접 줄 · 질문 스냅샷 · 제목 · 올린 날)을 남기면 발행 현황 · 성과 표의 셈이 갈라진다.
 *
 * ── 어느 기록인가 ───────────────────────────────────────────────────────────
 *   작성자 배정 글 — 콘텐츠 생성 「② 올리기 목록」의 그 글 자사 줄 「올렸어요」(src/lib/publishPlan.ts recordInputOf)와 같다: via 'own' ·
 *     targetActionId = 글 id · 「집행함」으로 바꿈 · 추가 글의 질문 스냅샷(만들 때의 판 · id · 문장, 추가 글 목록에 없으면 배정 파일의
 *     것) · 글 제목(초안 제목) · 초안 판(generatedAt) · 사람이 고른 올린 날(writerRecordInput).
 *   그 밖의 글 — 콘텐츠 보관함 「올렸어요」(src/pages/ContentLibrary.tsx onRecord)와 같다: via 'direct' · 질문 스냅샷은 추가 글 정의 또는
 *     질문 은행(src/lib/contentLibraryOrder.ts libraryRecordTopic)(libraryRecordInput).
 * 앱은 보관함과 같은 규칙으로 배정 글을 가린다(assignedArticle — 배정에 있고, 그 추가 글을 배정 판으로 만들었거나 추가 글 정의가 없다).
 * 추가 글 정의가 없는 배정 글(질문 은행에서 만든 글 — 보관함의 「판 미확인」)은 CLI와 같이 배정 파일의 스냅샷으로 작성자 기록을 적는다 — 두
 * 길이 같은 글에 같은 기록을 남긴다. 보관함 · 질문 은행 「올렸어요」도 배정 글에는 같은 스냅샷을 싣는다(contentLibraryOrder.ts
 * assignedTopicSnapshot — 줄은 그 화면 그대로 직접 줄). CLI는 작성자 · 글을 사람이 적으므로 배정표의 글이면 작성자 기록이다
 * (planRegistration — 예전 그대로). 다른 판으로 만든 추가 글은 앱에서는 배정 밖(보관함 기록)이다.
 *
 * 서버가 import하므로 상대 import는 .js로 쓰고, DOM을 쓰는 모듈은 끌어오지 않는다(내려받기는 src/lib/fileDownload.ts).
 */
import type { StoredDraft, TopicSnapshot } from './api.js'
import { assignedArticle, libraryRecordTopic, writerTopicSnapshot } from './contentLibraryOrder.js'
import { effectiveDraft } from './draftGaps.js'
import type { ExtraArticle } from './extraArticles.js'
import { draftTitle } from './markdownFile.js'
import type { WriterPlan, WriterPlanArticle } from './probePlan.js'
import { ARTICLE_URL_REASON, isArticleUrl, trackingKey } from './publishedUrl.js'
import type { QuestionBank } from './types.js'

export interface CsvRow {
  /** CSV 줄 번호(1부터 — 머리글 포함). */
  line: number
  writer: string
  article: string
  url: string
  postedOn: string
}

/** 올린 날 — 2026-11-02 · 2026.11.2 · 2026/11/02를 YYYY-MM-DD로. 실제 날짜가 아니면 null. */
export function normalizeDay(raw: string): string | null {
  const m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})\.?$/.exec(raw.trim())
  if (!m) return null
  const day = `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`
  const t = Date.parse(`${day}T00:00:00Z`)
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === day ? day : null
}

/** 올린 날(YYYY-MM-DD)이 적을 수 있는 날인가 — 오늘(KST) 뒤 · 2020년 전이면 이유. 괜찮으면 null. */
export function postedDayProblem(day: string, today: string): string | null {
  if (day > today) return `올린 날(${day})이 오늘(${today})보다 뒤입니다.`
  if (day < '2020-01-01') return `올린 날(${day})이 너무 이릅니다.`
  return null
}

/** 원장 기록에서 이 규칙이 보는 값(server/publishedPosts.ts PublishedPost · src/lib/api.ts PublishedPost 모두 이 모양을 가진다). */
export interface RegistrationPostLike {
  key: string
  articleId: string
  targetActionId: string
  publishedOn: string | null
  articleTitle?: string
  removedAt?: string
  legacy?: true
}

/**
 * 이 주소를 이 글에 적어도 되는가 — 원장(한 브랜드)에서 본다. addPublishedPost(server/publishedPosts.ts)와 같은 판단:
 *   other    다른 글의 주소로 적혀 있다 — 거절.
 *   legacy   집행 상태 파일에만 있던 이 글의 옛 주소다 — 앱이 다시 적을 때 원장으로 옮기므로 여기서는 적지 않는다.
 *   already  이 글 자사 · 직접 줄(targetActionId = 글 id)에 이미 적혀 있다 — 건너뛴다(다시 돌려도 같은 결과).
 *   fresh    새로 적는다. channelOnly — 같은 글의 채널 줄에만 있던 주소(자사 줄에도 더한다), otherUrl — 이 글에는 이미 다른 주소가 있다.
 */
export type LedgerVerdict<P extends RegistrationPostLike = RegistrationPostLike> =
  | { kind: 'other'; post: P }
  | { kind: 'legacy' }
  | { kind: 'already'; post: P }
  | { kind: 'fresh'; channelOnly: boolean; otherUrl: boolean }

export function ledgerVerdict<P extends RegistrationPostLike>(posts: readonly P[], key: string, articleId: string): LedgerVerdict<P> {
  const actives = posts.filter((p) => !p.removedAt && !p.legacy)
  const known = actives.filter((p) => p.key === key)
  const other = known.find((p) => p.articleId !== articleId)
  if (other) return { kind: 'other', post: other }
  if (posts.some((p) => p.legacy && !p.removedAt && p.key === key && p.targetActionId === articleId)) return { kind: 'legacy' }
  const own = known.find((p) => p.targetActionId === articleId)
  if (own) return { kind: 'already', post: own }
  return {
    kind: 'fresh',
    channelOnly: known.length > 0,
    otherUrl: actives.some((p) => p.articleId === articleId && p.targetActionId === articleId && p.key !== key),
  }
}

/** addPublishedPost에 그대로 넘기는 기록 — 사람이 고른 올린 날 · 「집행함」. */
export interface RegisterInput {
  url: string
  articleId: string
  targetActionId: string
  via: 'own' | 'direct'
  articleTitle: string
  draftGeneratedAt: string
  publishedOn: string
  publishedOnChosen: true
  markDone: true
  topic?: TopicSnapshot
}

/** 작성자 배정 글의 기록 — 자사 줄 · 질문 스냅샷이 늘 있다. */
export interface WriterRegisterInput extends RegisterInput {
  via: 'own'
  topic: TopicSnapshot
}

/** 글 제목 — 콘텐츠 생성 · 보관함이 보이는 제목(블로그 글 형식이면 {N}을 실린 절 수로). */
const titleOf = (draft: StoredDraft) => draftTitle(effectiveDraft(draft))

/** 작성자 배정 글의 기록(「② 올리기 목록」 자사 줄 「올렸어요」와 같다). */
export function writerRecordInput(args: {
  article: WriterPlanArticle
  plan: WriterPlan
  draft: StoredDraft
  /** 추가 글 정의 전부(뺀 글 포함). */
  extras: readonly ExtraArticle[]
  url: string
  day: string
}): WriterRegisterInput {
  const { article, plan, draft } = args
  const topic = writerTopicSnapshot(article, plan, args.extras)
  return {
    url: args.url,
    articleId: article.id,
    targetActionId: article.id,
    via: 'own',
    articleTitle: titleOf(draft),
    draftGeneratedAt: draft.generatedAt,
    publishedOn: args.day,
    publishedOnChosen: true,
    markDone: true,
    topic,
  }
}

/** 배정 밖 글의 기록(콘텐츠 보관함 「올렸어요」와 같다). 추가 글 목록을 읽지 못했으면(null) 질문 은행으로 본다(보관함과 같다). */
export function libraryRecordInput(args: {
  /** 배정 — 없거나 읽지 못했으면 null(보관함과 같다). */
  plan: WriterPlan | null
  articleId: string
  draft: StoredDraft
  extras: readonly ExtraArticle[] | null
  bank: QuestionBank | null
  url: string
  day: string
}): RegisterInput {
  const topic = libraryRecordTopic(args.articleId, args.extras, args.bank, args.draft.generatedAt, args.plan)
  return {
    url: args.url,
    articleId: args.articleId,
    targetActionId: args.articleId,
    via: 'direct',
    articleTitle: titleOf(args.draft),
    draftGeneratedAt: args.draft.generatedAt,
    publishedOn: args.day,
    publishedOnChosen: true,
    markDone: true,
    ...(topic ? { topic } : {}),
  }
}

/**
 * 질문 글(topic:)의 작성자를 모르는가 — 배정 파일을 읽지 못했거나, 배정이 있는데 추가 글 목록을 읽지 못했다(어느 판으로 만들었는지 몰라 배정
 * 글인지 가릴 수 없다). 배정 파일이 없으면 배정 글일 수 없으니 안다(보관함 글). 화면(server/postImport.ts 후보의 「미확인」)과 등록
 * (importRecordInput)이 이 한 식을 쓴다 — 화면이 「배정 없음」으로 보여 체크해 둔 줄을 등록이 거절하지 않게.
 */
export function writerUnknownOf(articleId: string, plan: WriterPlan | null, planUnreadable: boolean, extras: readonly ExtraArticle[] | null): boolean {
  return articleId.startsWith('topic:') && (planUnreadable || (plan !== null && extras === null))
}

/**
 * 앱이 짝지은 글의 기록 — 배정 글(보관함 규칙 — 판 미확인 글 포함)이면 작성자 기록(추가 글 정의가 없으면 배정 파일의 스냅샷 — CLI와 같다),
 * 아니면 보관함 기록. 질문 글(topic:)의 작성자를 모르면(writerUnknownOf) 누구 글인지 · 어느 판인지 몰라 적지 않는다(짐작하지 않는다). 배정
 * 파일이 없는 브랜드는 추가 글 목록을 읽지 못해도 보관함 「올렸어요」와 같이 질문 은행으로 판을 본다. bank는 배정 밖 질문 은행 글(추가 글
 * 정의가 없는 topic:)에만 쓴다.
 */
export function importRecordInput(args: {
  plan: WriterPlan | null
  planUnreadable: boolean
  extras: readonly ExtraArticle[] | null
  bank: QuestionBank | null
  draft: StoredDraft
  articleId: string
  url: string
  day: string
}): { input: RegisterInput } | { error: string } {
  const { plan, extras, articleId } = args
  if (writerUnknownOf(articleId, plan, args.planUnreadable, extras)) {
    return {
      error: args.planUnreadable
        ? '작성자 배정 파일(probe-plan.json)을 읽지 못해 누구 글인지 확인하지 못했습니다 — 등록하지 않았습니다.'
        : '추가 글 목록을 읽지 못해 이 글의 질문지 판을 확인하지 못했습니다 — 등록하지 않았습니다.',
    }
  }
  const assigned = plan && extras ? assignedArticle(plan, new Map(extras.map((e) => [e.id, e])), articleId) : null
  if (assigned && plan && extras) {
    return { input: writerRecordInput({ article: assigned.article, plan, draft: args.draft, extras, url: args.url, day: args.day }) }
  }
  return { input: libraryRecordInput({ plan, articleId, draft: args.draft, extras, bank: args.bank, url: args.url, day: args.day }) }
}

/** CSV 한 줄의 기록 — addPublishedPost에 그대로 넘긴다. */
export interface RegisterItem {
  line: number
  article: WriterPlanArticle
  input: WriterRegisterInput
  key: string
}

export interface RegisterPlanInput {
  plan: WriterPlan
  drafts: Record<string, StoredDraft>
  /** 추가 글 정의 전부(뺀 글 포함). */
  extras: ExtraArticle[]
  /** 지금 원장(옛 기록 포함 — server/publishedPosts.ts readPublishedPosts). */
  posts: RegistrationPostLike[]
  rows: CsvRow[]
  /** 오늘(KST). */
  today: string
}

export interface RegisterPlan {
  items: RegisterItem[]
  /** 이미 그 글의 주소로 적혀 있어 건너뛴 줄. */
  skipped: string[]
  errors: string[]
  warnings: string[]
}

/** CSV 줄을 기록으로 — 걸린 줄은 errors(하나라도 있으면 쓰지 않는다), 이미 적힌 줄은 skipped. */
export function planRegistration(input: RegisterPlanInput): RegisterPlan {
  const items: RegisterItem[] = []
  const skipped: string[] = []
  const errors: string[] = []
  const warnings: string[] = []
  const seenKeys = new Map<string, number>()
  const seenArticles = new Map<string, number>()
  for (const row of input.rows) {
    const at = `${row.line}행`
    const article = row.article.startsWith('topic:')
      ? input.plan.articles.find((a) => a.id === row.article)
      : input.plan.articles.find((a) => a.name === row.article)
    if (!article) {
      errors.push(`${at}: 배정 글이 아닙니다 — ${row.article} (글 id나 배정표의 주제 이름을 그대로 적어 주세요)`)
      continue
    }
    const who = `${article.writer.key} · ${article.writer.name}`
    if (row.writer !== article.writer.key && row.writer !== article.writer.name) {
      errors.push(`${at}: 「${article.name}」은 ${who}의 글입니다 — 적힌 작성자 ${row.writer}`)
      continue
    }
    const url = row.url.trim()
    const check = isArticleUrl(url)
    if (!check.ok) {
      errors.push(`${at}: ${ARTICLE_URL_REASON[check.reason]} — ${url}`)
      continue
    }
    const key = trackingKey(url)!
    const day = normalizeDay(row.postedOn)
    if (!day) {
      errors.push(`${at}: 올린 날이 YYYY-MM-DD 날짜가 아닙니다 — ${row.postedOn}`)
      continue
    }
    const dayProblem = postedDayProblem(day, input.today)
    if (dayProblem) {
      errors.push(`${at}: ${dayProblem}`)
      continue
    }
    const draft = input.drafts[article.id]
    if (!draft) {
      errors.push(`${at}: 「${article.name}」은 초안이 없습니다 — 작성자에게 준 글이 맞는지 확인해 주세요.`)
      continue
    }
    const twin = seenKeys.get(key)
    if (twin !== undefined) {
      errors.push(`${at}: 같은 주소가 ${twin}행에도 있습니다 — ${url}`)
      continue
    }
    seenKeys.set(key, row.line)
    // 앱과 같은 판단(server/publishedPosts.ts addPublishedPost) — 다른 글의 주소면 거절, 이 글 자사 줄에 이미 있으면 그 기록이다.
    const verdict = ledgerVerdict(input.posts, key, article.id)
    if (verdict.kind === 'other') {
      const other = verdict.post
      errors.push(`${at}: 이 주소는 이미 다른 글 ${other.articleTitle ? `「${other.articleTitle}」` : other.articleId}의 올린 주소로 적혀 있습니다 — ${url}`)
      continue
    }
    // 집행 상태 파일에만 있던 옛 주소는 앱이 다시 적을 때 원장으로 옮긴다 — 여기서 옮기면 새 줄이 아니라 확인이 어긋나므로 앱에 맡긴다.
    if (verdict.kind === 'legacy') {
      errors.push(`${at}: 「${article.name}」에 예전 방식으로 적힌 주소입니다 — 앱의 올리기 목록에서 그 줄의 올린 날을 고쳐 주세요. ${url}`)
      continue
    }
    if (verdict.kind === 'already') {
      const on = verdict.post.publishedOn
      skipped.push(`${at}: 「${article.name}」에 이미 적힌 주소입니다(올린 날 ${on ?? '모름'}) — 건너뜀${on && on !== day ? `. 날짜가 다르면 앱에서 고쳐 주세요(CSV ${day})` : ''}`)
      continue
    }
    if (verdict.channelOnly) warnings.push(`${at}: 「${article.name}」의 채널 줄에 적힌 주소입니다 — 자사 줄에도 더합니다(앱의 「올렸어요」와 같다).`)
    const sameArticle = seenArticles.get(article.id)
    if (sameArticle !== undefined) warnings.push(`${at}: 「${article.name}」을 ${sameArticle}행에서도 다른 주소로 적었습니다 — 두 주소 모두 그 글의 기록이 됩니다.`)
    else if (verdict.otherUrl) warnings.push(`${at}: 「${article.name}」에는 이미 다른 주소가 적혀 있습니다 — 이 주소도 더합니다.`)
    seenArticles.set(article.id, row.line)
    const def = input.extras.find((x) => x.id === article.id)
    if (def?.removedAt) warnings.push(`${at}: 「${article.name}」은 추가 글 목록에서 뺀 글입니다 — 기록은 남지만 올리기 목록에는 보이지 않습니다.`)
    items.push({ line: row.line, article, key, input: writerRecordInput({ article, plan: input.plan, draft, extras: input.extras, url, day }) })
  }
  return { items, skipped, errors, warnings }
}
