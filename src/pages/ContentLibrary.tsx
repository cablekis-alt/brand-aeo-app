import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import PublishedUrlEditor, { ExecutionStatusButtons } from '../components/PublishedUrlEditor'
import { useTenant } from '../context/useTenant'
import { copyRich } from '../lib/clipboard'
import { buildPublishHtml, markdownToHtml } from '../lib/htmlFile'
import {
  loadActionStates,
  loadContentDrafts,
  loadFactGraph,
  loadPublishSettings,
  loadQuestionBank,
  saveActionState,
  type ActionStateMap,
  type ActionStatus,
  type FactNode,
  type StoredDraft,
} from '../lib/api'
import { recordOnlyHits, topicSnapshotFor } from '../lib/gapActions'
import { postChannelLabel, summarizePost, TIER_LABEL, type PostTier } from '../lib/publishTracking'
import { usePublishedHistory } from '../lib/usePublishedHistory'
import type { QuestionBank } from '../lib/types'
import { usePublishedPosts } from '../lib/usePublishedPosts'
import type { PublishSettings } from '../lib/publishSettings'
import { effectiveDraft, workMarkdownOf } from '../lib/draftGaps'
import { publishArticleOf } from '../lib/publishArticle'
import { countGapNotes, downloadHtml, draftTitle, gapNoteLines, safeFileName } from '../lib/markdownFile'

/**
 * 만든 글이 모이는 곳.
 *
 * 초안은 지금까지 실행 항목 카드 **안에만** 있었다. 항목은 주차마다 다시 계산되므로, 그 주에
 * 없어진 항목의 글은 화면에서 접근이 끊긴다 — 실측: chosun.com 기고 초안이 다음 주차에
 * 언론 묶음으로 흡수되자 열 방법이 사라졌다(파일에는 그대로 있었다).
 *
 * 여기는 항목이 아니라 **글**을 기준으로 센다. 항목이 사라져도 글은 남는다.
 *
 * 올린 곳도 글 기준으로 모은다 — 한 글의 기록(자사 · 채널 줄)을 한곳에서 보고 고치고 더 적는다. 그 주 실행 항목에서 빠진 글도
 * 여기서 주소를 적을 수 있다. 주차별 인용 판정은 보이지 않는다(어느 주의 결과인지 기준이 없다).
 */
export default function ContentLibrary() {
  const { tenant } = useTenant()
  // 로딩과 결과를 한 상태로 묶는다 — 이펙트 본문에서 setLoading(true)를 부르면 렌더가 한 번
  // 더 돌고 린트가 잡는다(react-hooks/set-state-in-effect). 브랜드가 바뀌면 키가 달라지므로
  // 이전 브랜드의 글이 잠깐 비치는 일도 없다.
  const [state, setState] = useState<{ key: string; drafts: Record<string, StoredDraft> | null } | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const key = tenant?.tenantId ?? ''
  const loading = state?.key !== key
  // 발행 설정(글 끝 상담 안내 · 태그) — 미리보기와 내보내기가 올리기 목록과 같은 발행본을 내도록.
  const [settingsState, setSettingsState] = useState<{ key: string; value: PublishSettings | null }>({ key: '', value: null })
  const settings = settingsState.key === key ? settingsState.value : null
  // 설정을 받기 전에 복사 · 내보내면 사진 · 글 끝이 빠진 글이 나간다 — 받을 때까지 두 버튼을 잠근다(실패해도 null로 온다).
  const settingsReady = settingsState.key === key
  useEffect(() => {
    if (!key) return
    let alive = true
    void loadPublishSettings(key).then((s) => {
      if (alive) setSettingsState({ key, value: s })
    })
    return () => {
      alive = false
    }
  }, [key])

  useEffect(() => {
    if (!key) return
    let alive = true
    void loadContentDrafts(key)
      .then((m) => {
        if (alive) setState({ key, drafts: m })
      })
      .catch(() => {
        if (alive) setState({ key, drafts: null })
      })
    return () => {
      alive = false
    }
  }, [key])

  const drafts = state?.key === key ? state.drafts : null

  // 올린 글 주소(집행 원장) · 집행 상태 — 데스크톱 · 로컬 전용(웹은 칸을 숨긴다).
  const published = usePublishedPosts(key)
  const [statesState, setStatesState] = useState<{ key: string; value: ActionStateMap | null } | null>(null)
  const states = statesState && statesState.key === key ? statesState.value : null
  const [statusError, setStatusError] = useState<string | null>(null)
  const [postsOpen, setPostsOpen] = useState<string | null>(null)
  // 「블로그에 붙일 글 복사」 — 방금 복사한 글(잠깐 「복사했습니다」) · 복사 실패.
  const [copied, setCopied] = useState<string | null>(null)
  const [copyError, setCopyError] = useState<string | null>(null)
  const copyArticle = async (d: StoredDraft) => {
    if (!tenant) return
    setCopyError(null)
    // 올리기 목록의 자사 줄과 같은 발행본(본문 + 사진 + 글 끝)을 서식째 넣는다 — 블로그 편집기에 붙이면 제목 · 굵은 글씨가 남는다.
    const markdown = publishArticleOf(d, { brand: tenant, settings })
    if (!(await copyRich(markdown, markdownToHtml(markdown)))) {
      setCopyError('클립보드에 복사하지 못했습니다. 「본문 보기」를 열어 글을 골라 복사하세요 — 서식이 함께 복사됩니다.')
      return
    }
    setCopied(d.actionId)
    window.setTimeout(() => setCopied((k) => (k === d.actionId ? null : k)), 1800)
  }
  useEffect(() => {
    if (!key) return
    let alive = true
    void loadActionStates(key).then((m) => {
      if (alive) setStatesState({ key, value: m })
    })
    return () => {
      alive = false
    }
  }, [key])
  // topic: 글의 질문 스냅샷용 — 질문을 골라 쓴 글이 있을 때만 지금 질문 은행을 불러온다.
  const hasTopic = Object.keys(drafts ?? {}).some((id) => id.startsWith('topic:'))
  const [bankState, setBankState] = useState<{ key: string; bank: QuestionBank | null } | null>(null)
  const bank = bankState && bankState.key === key ? bankState.bank : null
  useEffect(() => {
    if (!key || !hasTopic) return
    let alive = true
    void loadQuestionBank(key).then((b) => {
      if (alive) setBankState({ key, bank: b })
    })
    return () => {
      alive = false
    }
  }, [key, hasTopic])
  const canRecord = published.available && states !== null
  const postsOf = (articleId: string) => (published.posts ?? []).filter((p) => p.articleId === articleId)
  // 글별 인용 판단(언급률 2번 P3) — 그 글의 지금 올라가 있는 주소 가운데 가장 강한 판단을 칩으로 단다. 「올린 곳 N」과 같은
  // 주소만 본다 — 내린 글의 판단을 새로 올린 주소 옆에 붙이지 않는다. 이 화면에서 주소를 고치면 저장이 끝난 뒤 다시 읽는다.
  // 자세한 주차별 칸(내린 글 포함)은 AEO 퍼포먼스에 있다.
  const history = usePublishedHistory(canRecord ? key : '', 12, published.saved)
  const TIER_ORDER: PostTier[] = ['repeated', 'once', 'none', 'indexing', 'waiting', 'undated', 'removed']
  const tierOf = (articleId: string): PostTier | null => {
    const live = new Set(postsOf(articleId).filter((p) => !p.removedAt).map((p) => p.id))
    const rows = (history.history?.posts ?? []).filter((p) => p.post.articleId === articleId && live.has(p.post.id))
    if (rows.length === 0 || !history.history) return null
    const tiers = new Set(rows.map((p) => summarizePost(p.cells, history.history!.weeks).tier))
    return TIER_ORDER.find((t) => tiers.has(t)) ?? null
  }
  const setStatus = async (actionId: string, status: ActionStatus) => {
    const id = key
    setStatusError(null)
    const saved = await saveActionState(id, actionId, status)
    // 그사이 브랜드를 바꿨으면 늦게 온 응답으로 새 브랜드의 상태를 덮지 않는다.
    setStatesState((prev) => (prev && prev.key !== id ? prev : saved ? { key: id, value: saved } : prev))
    if (!saved) setStatusError('상태를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.')
  }
  /** 한 글의 올린 곳 — 그 글의 모든 기록(자사 · 채널 줄)을 보이고, 이 글에 직접 적는다. */
  const postsPanel = (articleId: string, title: string, stored: StoredDraft | undefined) => {
    const records = postsOf(articleId)
    return (
      <div className="post-section">
        <ExecutionStatusButtons label={title} status={states?.[articleId]?.status ?? 'todo'} onChange={(s) => void setStatus(articleId, s)} />
        <PublishedUrlEditor
          judged={false}
          addLabel="올렸어요"
          hits={recordOnlyHits(records)}
          removed={records.filter((p) => p.removedAt)}
          weekOf=""
          busy={published.busy}
          targetLabel={postChannelLabel}
          onRecord={async (url, publishedOn, chosen) => {
            // 초안이 없는 기록(stored 없음)은 쓸 때의 시각을 몰라 id만 남는다.
            const topic = topicSnapshotFor(articleId, bank, stored?.generatedAt)
            const r = await published.record({
              url,
              articleId,
              targetActionId: articleId,
              via: 'direct',
              articleTitle: title,
              ...(stored ? { draftGeneratedAt: stored.generatedAt } : {}),
              publishedOn,
              publishedOnChosen: chosen,
              markDone: true,
              ...(topic ? { topic } : {}),
            })
            if (!r.ok) return r.error
            if (r.states) setStatesState((prev) => (prev && prev.key !== key ? prev : { key, value: r.states! }))
            return null
          }}
          onRemove={published.remove}
          onRestore={published.restore}
          onSetDate={published.setPublishedOn}
        />
      </div>
    )
  }

  if (!tenant) return null

  // 최근에 만든 것이 위로. 고친 글이 있으면 그 시각을 기준으로 본다.
  const rows = Object.values(drafts ?? {}).sort((a, b) =>
    (b.editedAt ?? b.generatedAt).localeCompare(a.editedAt ?? a.generatedAt),
  )
  // 초안이 없어진 기록 — 초안을 지웠거나 다른 곳(질문 은행 · 옛 화면)에서 적은 주소. 글 단위로 묶어 남은 것을 보이고 고친다.
  const orphanArticles = drafts
    ? [...new Set((published.posts ?? []).map((p) => p.articleId))].filter((id) => !drafts[id])
    : []

  // 초안이 없는 기록 — 초안이 0편이어도 보여야 한다(초안을 모두 지웠거나 주소만 적은 브랜드).
  const orphanSection = (
    <>
      {canRecord && orphanArticles.length > 0 && (
        <>
          <h3>주소만 남은 기록</h3>
          <p className="hint" style={{ marginTop: 0 }}>
            초안이 없는 글의 올린 주소입니다. 기록은 지우지 않고 남겨 두므로, 여기서 날짜를 고치거나 빼고 되살릴 수 있습니다.
          </p>
          <div className="gap-grid">
            {orphanArticles.map((articleId) => {
              const first = postsOf(articleId)[0]
              const title = first?.articleTitle ?? articleId
              return (
                <article className="gap-card" key={articleId}>
                  <div className="gap-card-head">
                    <span className="gap-name">{title}</span>
                  </div>
                  <p className="doc-meta">
                    <code>{articleId}</code>
                  </p>
                  {postsPanel(articleId, title, undefined)}
                </article>
              )
            })}
          </div>
        </>
      )}
    </>
  )

  // 상태 · 원장 오류 — 어느 갈래(초안 0편 · 있음)에서든 보인다.
  const notices = (
    <>
      {statusError && (
        <p className="error" role="alert">
          {statusError}
        </p>
      )}
      {copyError && (
        <p className="error" role="alert">
          {copyError}
        </p>
      )}
      {canRecord && published.error && (
        <p className="error" role="alert">
          올린 글 기록: {published.error}
        </p>
      )}
    </>
  )

  return (
    <>
      <p className="brand">실행</p>
      <h1>콘텐츠 보관함</h1>
      <p className="lead">
        <Link to="/gap-actions">콘텐츠 생성</Link>에서 만든 글이 여기 모입니다. 실행 항목은 주차마다 다시
        계산되지만 글은 남습니다 — 그 주에 항목이 사라져도 여기서 열 수 있습니다.
      </p>

      {loading ? (
        <p className="muted">불러오는 중…</p>
      ) : drafts === null ? (
        <p className="muted">이 환경에서는 초안 보관함을 쓸 수 없습니다 (데스크톱·로컬 전용).</p>
      ) : rows.length === 0 ? (
        <section>
          <p className="muted">
            아직 만든 글이 없습니다. <Link to="/gap-actions">콘텐츠 생성</Link>에서 첫 글을 만들어 보세요.
          </p>
          {notices}
          {orphanSection}
        </section>
      ) : (
        <section>
          {notices}
          <p className="hint" style={{ marginTop: 0 }}>
            글 <b>{rows.length}편</b>. 블로그(네이버·티스토리)에는 <b>블로그에 붙일 글 복사</b>로 복사해 편집기에 붙여
            넣으세요 — 제목·굵은 글씨·사진이 함께 들어갑니다. 홈페이지·CMS에는 <b>홈페이지용 .html</b>을 올리세요 — AI 검색이
            읽는 구조화 데이터(JSON-LD)가 들어 있고, 브라우저로 열어 미리 볼 수도 있습니다. 남은 빈칸 줄은 두 곳 모두에서 빠집니다.
          </p>
          <div className="gap-grid">
            {rows.map((d) => {
              const md = workMarkdownOf(d)
              const gaps = countGapNotes(md)
              const title = draftTitle(effectiveDraft(d))
              const shown = open === d.actionId
              const postCount = postsOf(d.actionId).filter((p) => !p.removedAt).length
              const postsShown = postsOpen === d.actionId
              const tier = postCount > 0 ? tierOf(d.actionId) : null
              return (
                <article className="gap-card" key={d.actionId}>
                  <div className="gap-card-head">
                    <span className="gap-name">{title}</span>
                    {d.editedMarkdown && <span className="st st-info">고침</span>}
                    {gaps > 0 && <span className="st st-warn">빈칸 {gaps}</span>}
                    {canRecord && postCount > 0 && <span className="st st-info">올린 곳 {postCount}</span>}
                    {tier && (
                      <span className="st st-info" title="올린 뒤 측정에서 그 주소가 AI 답변에 인용됐나 — 주차별 칸은 AEO 퍼포먼스의 올린 글 인용 추적">
                        {TIER_LABEL[tier]}
                      </span>
                    )}
                  </div>
                  <p className="gap-tally">{d.draft.lead}</p>
                  <p className="doc-meta">
                    {(d.editedAt ?? d.generatedAt).slice(0, 10)} · 절 {d.draft.sections.length}개 · 쓴 사실{' '}
                    {d.draft.usedFacts.length}건 · <code>{d.actionId}</code>
                  </p>
                  <div className="facts-bar">
                    <button type="button" onClick={() => setOpen(shown ? null : d.actionId)} aria-expanded={shown}>
                      {shown ? '접기' : '본문 보기'}
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      title="제목 · 본문 · 사진 · 글 끝 안내를 서식째 복사합니다. 네이버 블로그 · 티스토리 편집기에 붙이면 서식이 남습니다."
                      disabled={!settingsReady}
                      onClick={() => void copyArticle(d)}
                    >
                      {copied === d.actionId ? '복사했습니다' : '블로그에 붙일 글 복사'}
                      {gaps > 0 && copied !== d.actionId && <span className="muted"> — 빈칸 {gaps}줄 뺌</span>}
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      title="홈페이지 · CMS에 올리는 완성 문서입니다. <head>에 JSON-LD(Article · Organization)를 심고, 브라우저로 열어 미리 볼 수 있습니다."
                      disabled={!settingsReady}
                      onClick={() => {
                        void loadFactGraph(tenant.tenantId)
                          .then((fg) => fg?.factGraph ?? [])
                          .catch(() => [] as FactNode[])
                          .then((facts) =>
                            downloadHtml(
                              `홈페이지용-${safeFileName(title)}-${d.generatedAt.slice(0, 10)}.html`,
                              buildPublishHtml({ stored: d, brand: tenant, facts, settings }),
                            ),
                          )
                      }}
                    >
                      홈페이지용 .html
                    </button>
                    {canRecord && (
                      <button type="button" className="ghost" aria-expanded={postsShown} onClick={() => setPostsOpen(postsShown ? null : d.actionId)}>
                        {postsShown ? '올린 곳 접기' : postCount > 0 ? `올린 곳 ${postCount}` : '올린 곳 적기'}
                      </button>
                    )}
                  </div>
                  {postsShown && postsPanel(d.actionId, title, d)}
                  {shown && (
                    <div className="brief-body">
                      {/* 서식째 보인다(markdownToHtml은 모든 글자를 이스케이프한다) — 복사가 막힌 곳에서 여기서 골라 복사해도
                          블로그에 #·** 기호가 남지 않는다. */}
                      <div className="channel-preview" dangerouslySetInnerHTML={{ __html: markdownToHtml(publishArticleOf(d, { brand: tenant, settings })) }} />
                      {/* 작업용 원고(.md)를 뺀 대신 — 그 주 목록에서 빠진 글도 남은 빈칸 · 쓴 사실을 여기서 본다. */}
                      {gaps > 0 && (
                        <>
                          <p className="doc-meta">남은 빈칸 {gaps}줄 — 복사 · .html에서는 빠집니다</p>
                          <ul>
                            {gapNoteLines(md).map((line, i) => (
                              <li key={i}>{line}</li>
                            ))}
                          </ul>
                        </>
                      )}
                      {d.draft.usedFacts.length > 0 && (
                        <details className="draft-audit">
                          <summary>이 글이 쓴 사실 {d.draft.usedFacts.length}개</summary>
                          <ul>
                            {d.draft.usedFacts.map((f) => (
                              <li key={f}>{f}</li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </div>
                  )}
                </article>
              )
            })}
          </div>
          {orphanSection}
        </section>
      )}
    </>
  )
}
