import { useEffect, useRef, useState, type ReactNode } from 'react'
import { adaptForChannel, type ChannelAdaptation, type ChannelAdaptationMap } from '../lib/api'
import { copyRich } from '../lib/clipboard'
import { effectiveDraft, publishMarkdownOf } from '../lib/draftGaps'
import { countImageSlots, draftTitle } from '../lib/markdownFile'
import { escapeHtml, markdownToHtml } from '../lib/htmlFile'
import { objectParticle } from '../lib/korean'
import { channelArticleParts, publishArticleOf } from '../lib/publishArticle'
import type { PublishSettings } from '../lib/publishSettings'
import { pregenerateTargets, VERB_CAUTION, VERB_LABEL, type PublishPlan, type PublishRow } from '../lib/publishPlan'
import { useTenant } from '../context/useTenant'
import { channelStyleOf, sourceKeyOf, STYLE_LABEL } from '../prompts/b9d-channel-adapt'
import { articlePhotoFiles, downloadArticlePhotos, uniquePhotoFiles } from '../lib/sitePhotos'
import type { AppliedPhoto } from '../lib/articlePhotos'

/**
 * ② 올리기 목록 — 한 줄이 한 번 올리기다(상용화 UI 8차 시안). 줄 계산은 lib/publishPlan.ts.
 *
 * 줄마다 할 일은 두 걸음이다: 버튼 하나(복사 + 채널 열기) → 올린 주소를 붙이고 「올렸어요」. 외부 채널은 그
 * 채널 문체로 다듬은 글이 있어야 복사할 수 있다(판정 1~2회, 원문 내용만 쓰고 사실 대조를 거친다 —
 * server/channelAdapt.ts). 확인된 글의 위쪽 채널 2곳은 미리 다듬어 둔다 — 목록을 열었을 때 맨 위 줄들이
 * 바로 「준비됨」이도록. 나머지는 처음 누를 때 만든다.
 *
 * 주소는 그 줄의 항목(own은 콘텐츠 항목, 그 밖에는 채널 항목)에 기록한다 — 예전 채널 탭 · 올림 현황과 같은 기록이다.
 */
export default function PublishList({
  tenantId,
  plan,
  settings = null,
  adaptations,
  onAdapted,
  urlSlot,
  onShowArticle,
  focusId = '',
}: {
  tenantId: string
  plan: PublishPlan
  /** 브랜드별 발행 설정 — 자사 줄 발행본의 글 끝(상담 안내 · 문의 링크)과 「태그 복사」. */
  settings?: PublishSettings | null
  /** 글별 채널 다듬은 글. null이면 다듬기 라우트가 없는 환경(웹)이다 — 원문을 복사한다. */
  adaptations: ChannelAdaptationMap | null
  onAdapted: (a: ChannelAdaptation) => void
  /** 올린 주소 기록 부품. 상태를 저장할 수 없는 환경이면 null. */
  /** 「올렸어요」 칸 — 줄 전체를 받는다. 기록에 글 · 올린 곳 · 초안 판을 함께 남기려면 대상 항목만으로는 모자라다. */
  urlSlot: (row: PublishRow) => ReactNode
  /** 잠긴 줄의 「글 확인하러 가기」 — 그 글 카드로 옮겨 간다. */
  onShowArticle: (actionId: string) => void
  /** 인용 갭 분석에서 넘어온 채널 항목 id — 그 줄을 강조하고 스크롤 목적지(action-<id>)로 둔다. */
  focusId?: string
}) {
  const { tenant } = useTenant()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  /** 홈페이지 사진을 받는 중인 줄. */
  const [photoBusy, setPhotoBusy] = useState<string | null>(null)
  /** 주소 칸을 펼친 줄 — 버튼을 누르면 펼친다. */
  const [openSlot, setOpenSlot] = useState<Set<string>>(new Set())
  const [preview, setPreview] = useState<string | null>(null)
  // 미리 다듬기를 한 번 시도한 줄(원문 키까지) — 실패한 줄을 계속 다시 부르지 않는다.
  const tried = useRef<Set<string>>(new Set())
  // 미리 다듬기가 돌고 있나 — busy(상태)는 다음 그리기에야 바뀌어서, 그 사이 효과가 다시 돌면 두 줄을 한꺼번에 부른다.
  const autoRunning = useRef(false)

  const sourceOf = (row: PublishRow) => (row.article.draft ? publishMarkdownOf(row.article.draft) : '')
  const adaptationOf = (row: PublishRow) => adaptations?.[row.article.action.id]?.[row.target.id]

  const adapt = async (row: PublishRow, auto = false) => {
    const source = sourceOf(row)
    if (!source) {
      if (auto) autoRunning.current = false
      return
    }
    setBusy(row.key)
    setError(null)
    try {
      onAdapted(
        await adaptForChannel(tenantId, {
          contentActionId: row.article.action.id,
          channelActionId: row.target.id,
          channelDomain: row.target.targetDomain ?? row.target.title,
          channelBadge: row.target.badge,
          sourceMarkdown: source,
          ...(row.article.draft?.draft.format === 'article' ? { format: 'article' as const } : {}),
        }),
      )
    } catch (e) {
      setError(`${row.name} — ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      if (auto) autoRunning.current = false
      setBusy(null)
    }
  }

  // 미리 다듬기 — 한 번에 하나씩. 끝나면 onAdapted가 다시 그리고, 이 효과가 다음 줄을 고른다.
  useEffect(() => {
    if (adaptations === null || busy !== null || autoRunning.current) return
    const next = pregenerateTargets(plan).find((row) => {
      const source = sourceOf(row)
      return source && !adaptationOf(row) && !tried.current.has(`${row.key}:${sourceKeyOf(source)}`)
    })
    if (!next) return
    tried.current.add(`${next.key}:${sourceKeyOf(sourceOf(next))}`)
    autoRunning.current = true
    void adapt(next, true)
    // sourceOf · adaptationOf · adapt는 plan · adaptations에서 나온다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, adaptations, busy])

  /**
   * 이 줄에서 복사할 글과 거기에 들어간 홈페이지 사진(「사진 N장 받기」). 다듬은 글이 필요한데 아직 없으면 null.
   * 자사 사이트 줄은 발행본(본문 + 글 끝 — 공식 사이트 링크 등)을 쓴다. 다듬기 원문(sourceOf)은 본문만이다.
   * 블로그 채널 줄은 다듬은 글에 고른 사진과 글 끝을 붙인다(channelArticleParts).
   */
  const textOf = (row: PublishRow): { markdown: string; html: string; photos: AppliedPhoto[] } | null => {
    const d = row.article.draft
    if (!d) return null
    if (!row.needsAdapt || adaptations === null) {
      const markdown = row.kind === 'own' && tenant ? publishArticleOf(d, { brand: tenant, settings }) : publishMarkdownOf(d)
      const photos = row.kind === 'own' ? articlePhotoFiles(d, { settings, industry: tenant?.industry }) : []
      return { markdown, html: markdownToHtml(markdown), photos }
    }
    const a = adaptationOf(row)
    if (!a) return null
    // 고른 사진은 이 다듬은 글을 만든 원문이 지금 원문일 때만 넣는다(옛 판이면 아래 경고 줄에서 다시 만든다).
    const source = sourceOf(row)
    const fresh = a.sourceKey === sourceKeyOf(source)
    const parts = tenant ? channelArticleParts(a, { brand: tenant, settings }, fresh ? { markdown: source, picks: d.photos } : undefined) : { markdown: a.markdown, photos: [] }
    return { markdown: parts.markdown, html: markdownToHtml(parts.markdown), photos: uniquePhotoFiles(parts.photos) }
  }

  /**
   * 이 줄의 제목 — 블로그 편집기는 제목 칸이 따로라 본문과 따로 복사한다. 다듬은 글은 사실 대조를 거친 그 제목, 자사 줄은 발행본
   * 첫 줄(# 제목)이 있으면 그것(고친 글의 제목), 없으면 빈칸을 채운 초안의 제목.
   */
  const titleOf = (row: PublishRow, markdown: string): string => {
    const a = row.needsAdapt ? adaptationOf(row) : undefined
    if (a?.title && a.titleChecked) return a.title
    // 다듬은 글 본문에는 # 제목이 없다 — 다듬기 원문(고친 글이면 그 제목)으로 떨어진다.
    const h1 = (md: string) => /^#\s+(.+)$/m.exec(md)?.[1]?.trim()
    return h1(markdown) || h1(sourceOf(row)) || (row.article.draft ? draftTitle(effectiveDraft(row.article.draft)) : row.article.action.title)
  }

  const run = async (row: PublishRow) => {
    const t = textOf(row)
    if (!t) return
    if (!(await copyRich(t.markdown, t.html))) {
      setError('클립보드에 복사하지 못했습니다.')
      return
    }
    setCopied(row.key)
    window.setTimeout(() => setCopied((k) => (k === row.key ? null : k)), 1800)
    if (row.openUrl) window.open(row.openUrl, '_blank', 'noopener')
    setOpenSlot((s) => new Set(s).add(row.key))
  }

  /**
   * 이미 올린 줄의 「본문 다시 복사」 — 원문이 바뀌어 채널용 글을 다시 만들었을 때 블로그의 기존 글을 고치는 데 쓴다. 채널을 열지
   * 않는다(고칠 곳은 올린 글이다). 복사하면 주소 칸을 열어 「고쳤어요」로 고친 날을 남기게 한다.
   */
  const [recopied, setRecopied] = useState<Set<string>>(new Set())
  /**
   * 이미 올린 줄에서 고칠 곳 — 줄 성격마다 다르다. 주소가 없거나(「집행함」만 누름) 우리가 고칠 수 없는 곳(언론 묶음 — 보낸 곳이 고친다)은
   * null이고, 그때는 「본문 다시 복사」를 그리지 않는다.
   */
  const editPlaceOf = (row: PublishRow): string | null => {
    if (row.target.publishedUrls.length === 0) return null
    if (row.kind === 'own') return `${row.name}의 기존 글`
    if (row.verb === 'doc') return '그 문서'
    if (row.verb === 'place' || row.verb === 'update') return `${row.name} 업체 관리 화면의 소개 칸`
    if (row.verb === 'write') return `${row.name}에 올린 기존 글`
    return null
  }
  /** 복사 뒤 안내 — 고칠 곳, 새로 올리지 말 것, 고친 날을 남기는 길(그 줄 기록 상태에 맞춰). */
  const recopyHintOf = (row: PublishRow): string => {
    const place = editPlaceOf(row) ?? '올린 곳'
    const hits = row.target.publishedHits ?? []
    const after = hits.some((h) => h.post.publishedOn && !h.takenDownOn)
      ? '다 고쳤으면 아래 주소 줄의 「고쳤어요」로 고친 날을 남깁니다.'
      : hits.some((h) => !h.post.publishedOn)
        ? '다 고쳤으면 아래 주소 줄의 「날짜 고치기」로 올린 날부터 적은 뒤 「고쳤어요」로 고친 날을 남깁니다.'
        : '내린 글이라 고친 날은 남기지 않습니다 — 되살리거나, 새로 올렸으면 새 주소를 「올렸어요」로 적으세요.'
    const duplicate = row.verb === 'write' ? '(주소가 바뀌면 인용 추적이 끊기고, 같은 곳에 비슷한 글이 두 편이 됩니다)' : '(주소가 바뀌면 인용 추적이 끊깁니다)'
    return `${objectParticle(place)} 수정해 붙여 넣으세요 — 새로 올리지 마세요${duplicate}. ${after}`
  }
  const recopy = async (row: PublishRow) => {
    const t = textOf(row)
    if (!t) return
    if (!(await copyRich(t.markdown, t.html))) {
      setError('클립보드에 복사하지 못했습니다.')
      return
    }
    setCopied(`body:${row.key}`)
    window.setTimeout(() => setCopied((k) => (k === `body:${row.key}` ? null : k)), 1800)
    setRecopied((s) => new Set(s).add(row.key))
    setOpenSlot((s) => new Set(s).add(`done:${row.key}`))
  }

  const copyTitle = async (key: string, title: string) => {
    if (!(await copyRich(title, escapeHtml(title)))) {
      setError('제목을 클립보드에 복사하지 못했습니다.')
      return
    }
    setCopied(`title:${key}`)
    window.setTimeout(() => setCopied((k) => (k === `title:${key}` ? null : k)), 1800)
  }

  const tags = settings?.tags ?? []
  // 태그는 본문에 넣지 않는다 — 블로그 편집기의 태그 칸에 따로 붙인다(쉼표로 나눈다).
  const copyTags = async (key: string) => {
    const text = tags.join(', ')
    // html 쪽은 이스케이프한 것만 넘긴다(clipboard.ts) — 「<신상>」 같은 태그가 사라지거나 태그로 그려지지 않게.
    if (!(await copyRich(text, escapeHtml(text)))) {
      setError('태그를 클립보드에 복사하지 못했습니다.')
      return
    }
    setCopied(`tags:${key}`)
    window.setTimeout(() => setCopied((k) => (k === `tags:${key}` ? null : k)), 1800)
  }

  return (
    <div className="publish-list-wrap">
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <ol className="publish-list">
        {plan.rows.map((row) => {
          const a = row.needsAdapt ? adaptationOf(row) : undefined
          // 올릴 곳의 형식이 바뀐 다듬은 글(예: 이미 등록된 후기 플랫폼 → 새 등록용이 아니라 소개 보강용)도 다시 만들게 한다.
          const styleChanged = Boolean(a && a.style !== channelStyleOf(row.target.badge))
          const stale = Boolean(a && row.article.draft && a.sourceKey !== sourceKeyOf(sourceOf(row))) || styleChanged
          const text = textOf(row)
          // 이 줄 복사본에 들어간 홈페이지 사진(src/lib/articlePhotos.ts) — 자사 줄과 블로그 채널 줄.
          const photos = text?.photos ?? []
          const ready = !row.locked && text !== null
          const making = busy === row.key
          const slotOpen = openSlot.has(row.key) || (row.done && openSlot.has(`done:${row.key}`))
          const state = row.done
            ? { label: '올림', cls: 'is-done' }
            : row.locked
              ? { label: '글 확인 후', cls: 'is-locked' }
              : making
                ? { label: '만드는 중', cls: 'is-making' }
                : ready
                  ? { label: '준비됨', cls: 'is-ready' }
                  : { label: '만들기 전', cls: 'is-todo' }
          return (
            <li
              key={row.key}
              // 채널 줄은 그 채널 항목의 자리다(인용 갭 분석 → focus). 따로 쓴 글(orphan)은 위의 글 카드가 그 자리다.
              id={row.kind === 'channel' ? `action-${row.target.id}` : undefined}
              className={`publish-row${row.locked ? ' is-locked' : ''}${row.done ? ' is-done' : ''}${
                row.kind === 'channel' && focusId === row.target.id ? ' is-focused' : ''
              }`}
            >
              <div className="publish-row-main">
                <span className={`channel-dot${row.done ? ' up' : ''}`} aria-hidden="true" />
                <span className="publish-row-name">
                  <b>{row.name}</b>
                  {/* 글이 한 편이면 줄마다 같은 제목이라 뺀다 — 위 ① 카드가 그 글이다. */}
                  {plan.articles.length > 1 && (
                    <span className="publish-row-article">{(row.article.draft && draftTitle(effectiveDraft(row.article.draft))) || row.article.action.title}</span>
                  )}
                </span>
                <span className="publish-row-reach">
                  질문 <b>{row.questionIds.length}</b>개
                </span>
                <span className={`publish-state ${state.cls}`}>{state.label}</span>
                <span className="publish-row-actions">
                  {row.locked ? (
                    <button type="button" className="ghost" onClick={() => onShowArticle(row.article.action.id)}>
                      {row.article.draft ? `빈칸 ${row.article.gapsLeft}곳 확인하러 가기` : '글 만들러 가기'}
                    </button>
                  ) : row.done ? (
                    <button
                      type="button"
                      className="ghost"
                      aria-expanded={slotOpen}
                      onClick={() =>
                        setOpenSlot((s) => {
                          const n = new Set(s)
                          const k = `done:${row.key}`
                          if (n.has(k)) n.delete(k)
                          else n.add(k)
                          return n
                        })
                      }
                    >
                      주소 {row.target.publishedUrls.length}개{row.target.citedPublishedUrls.length > 0 && ` · 인용 ${row.target.citedPublishedUrls.length}`}
                    </button>
                  ) : text ? (
                    <button type="button" className="publish-go" onClick={() => void run(row)}>
                      {copied === row.key ? '복사했습니다' : VERB_LABEL[row.verb]}
                    </button>
                  ) : (
                    <button type="button" disabled={busy !== null} onClick={() => void adapt(row)}>
                      {making ? '이 채널용 글 만드는 중… 30초~1분' : '이 채널용 글 만들기 · 약 30초~1분'}
                    </button>
                  )}
                  {row.done && !row.locked && text && editPlaceOf(row) && (
                    // 이 채널용 글이 옛 판이면(원문 · 올릴 곳 형식이 바뀜) 막는다 — 옛 글을 다시 붙이게 된다. 아래 경고 줄에서 다시 만든다.
                    <button
                      type="button"
                      className="ghost"
                      disabled={stale}
                      title={stale ? '이 채널용 글이 옛 판입니다 — 아래에서 다시 만든 뒤 복사하세요.' : '이미 올린 글을 고칠 때 — 본문만 복사합니다(채널은 열지 않음)'}
                      onClick={() => void recopy(row)}
                    >
                      {copied === `body:${row.key}` ? '본문 복사함' : '본문 다시 복사'}
                    </button>
                  )}
                  {!row.locked && text && (
                    <button type="button" className="ghost" title={titleOf(row, text.markdown)} onClick={() => void copyTitle(row.key, titleOf(row, text.markdown))}>
                      {copied === `title:${row.key}` ? '제목 복사함' : '제목 복사'}
                    </button>
                  )}
                  {!row.locked && row.kind === 'own' && tags.length > 0 && (
                    <button type="button" className="ghost" title={tags.join(', ')} onClick={() => void copyTags(row.key)}>
                      {copied === `tags:${row.key}` ? '태그 복사함' : `태그 복사 ${tags.length}`}
                    </button>
                  )}
                  {!row.locked && photos.length > 0 && row.article.draft && (
                    <button
                      type="button"
                      className="ghost"
                      disabled={photoBusy !== null}
                      title={photos.map((p, i) => `사진${i + 1} = 「${p.heading || p.slotAlt}」`).join(' · ')}
                      onClick={() => {
                        const draft = row.article.draft
                        if (!draft) return
                        setPhotoBusy(row.key)
                        setError(null)
                        downloadArticlePhotos(tenantId, draft, photos)
                          .catch((e: unknown) => setError(`${row.name} — ${e instanceof Error ? e.message : String(e)}`))
                          .finally(() => setPhotoBusy(null))
                      }}
                    >
                      {photoBusy === row.key ? '사진 받는 중…' : `사진 ${photos.length}장 받기`}
                    </button>
                  )}
                  {!row.locked && text && (
                    <button
                      type="button"
                      className="link-btn"
                      aria-expanded={preview === row.key}
                      onClick={() => setPreview((k) => (k === row.key ? null : row.key))}
                    >
                      {preview === row.key ? '글 접기' : '글 보기'}
                    </button>
                  )}
                </span>
              </div>
              {row.done && recopied.has(row.key) && <p className="publish-row-note">{recopyHintOf(row)}</p>}
              {!row.locked && !row.done && VERB_CAUTION[row.verb] && <p className="publish-row-note">{VERB_CAUTION[row.verb]}</p>}
              {!row.locked && (!row.done || recopied.has(row.key)) && text && countImageSlots(text.markdown) > 0 && (
                <p className="publish-row-note">
                  사진 넣을 곳 {countImageSlots(text.markdown)}곳 — 붙여 넣은 글의 「[사진 넣을 자리]」를 직접 찍거나 고른 사진으로 바꾸세요.
                </p>
              )}
              {!row.locked && (!row.done || recopied.has(row.key)) && photos.length > 0 && (
                <p className="publish-row-note">
                  홈페이지 사진 {photos.length}장을 넣었어요 — 붙여 넣은 글에서 사진이 안 보이면 「사진 {photos.length}장 받기」로 받은 파일을 그
                  자리에 올리세요({photos.map((p, i) => `사진${i + 1} = 「${p.heading || p.slotAlt}」`).join(' · ')}).
                </p>
              )}
              {stale && (
                <p className="channel-stale">
                  {styleChanged
                    ? channelStyleOf(row.target.badge) === 'listing-update'
                      ? '올릴 곳 형식이 바뀌었습니다 — 이미 등록된 업체라 새 등록 글이 아니라 소개 보강 글이 필요합니다.'
                      : '올릴 곳 형식이 바뀌었습니다.'
                    : '원문이 바뀌었습니다(빈칸을 채웠거나 고쳤습니다).'}{' '}
                  {a?.style === 'blog' &&
                    row.article.draft &&
                    articlePhotoFiles(row.article.draft, { settings, industry: tenant?.industry }).length > 0 &&
                    '고른 홈페이지 사진은 다시 만든 글에 들어갑니다. '}
                  <button type="button" className="link-btn" disabled={busy !== null} onClick={() => void adapt(row)}>
                    {making ? '다시 만드는 중…' : '이 채널용 글 다시 만들기'}
                  </button>
                </p>
              )}
              {preview === row.key && text && (
                <div className="publish-row-preview">
                  {a && <span className="chip">{STYLE_LABEL[a.style]}</span>}
                  {/* markdownToHtml은 모든 글자를 이스케이프한다 — 판정 엔진이 쓴 글에 태그가 있어도 글자로 남는다. */}
                  <div className="channel-preview" dangerouslySetInnerHTML={{ __html: markdownToHtml(text.markdown) }} />
                  {a?.notes && a.notes.length > 0 && (
                    <details className="draft-audit">
                      <summary>사실 대조에서 뺀 문장 {a.notes.length}건</summary>
                      <ul className="muted">
                        {a.notes.map((n) => (
                          <li key={n}>{n}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {a && !stale && (
                    <p className="doc-meta">
                      {a.generatedAt.slice(0, 10)} 만듦 ·{' '}
                      <button type="button" className="link-btn" disabled={busy !== null} onClick={() => void adapt(row)}>
                        {making ? '다시 만드는 중…' : '다시 만들기'}
                      </button>
                    </p>
                  )}
                </div>
              )}
              {slotOpen && <div className="publish-row-slot">{urlSlot(row)}</div>}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
