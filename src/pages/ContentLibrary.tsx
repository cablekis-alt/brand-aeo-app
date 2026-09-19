import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTenant } from '../context/useTenant'
import { buildPublishHtml } from '../lib/htmlFile'
import { loadContentDrafts, loadFactGraph, type FactNode, type StoredDraft } from '../lib/api'
import {
  countGapNotes,
  downloadHtml,
  downloadMarkdown,
  draftToMarkdown,
  draftToPublishMarkdown,
  safeFileName,
  stripGapNotes,
} from '../lib/markdownFile'

/**
 * 만든 글이 모이는 곳.
 *
 * 초안은 지금까지 실행 항목 카드 **안에만** 있었다. 항목은 주차마다 다시 계산되므로, 그 주에
 * 없어진 항목의 글은 화면에서 접근이 끊긴다 — 실측: chosun.com 기고 초안이 다음 주차에
 * 언론 묶음으로 흡수되자 열 방법이 사라졌다(파일에는 그대로 있었다).
 *
 * 여기는 항목이 아니라 **글**을 기준으로 센다. 항목이 사라져도 글은 남는다.
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

  if (!tenant) return null

  // 최근에 만든 것이 위로. 고친 글이 있으면 그 시각을 기준으로 본다.
  const rows = Object.values(drafts ?? {}).sort((a, b) =>
    (b.editedAt ?? b.generatedAt).localeCompare(a.editedAt ?? a.generatedAt),
  )

  return (
    <>
      <p className="brand">그래서 뭘 하나</p>
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
        <p className="muted">
          아직 만든 글이 없습니다. <Link to="/gap-actions">콘텐츠 생성</Link>에서 첫 글을 만들어 보세요.
        </p>
      ) : (
        <section>
          <p className="hint" style={{ marginTop: 0 }}>
            글 <b>{rows.length}편</b>. <b>발행용 .md</b>는 빈칸 표시와 「이 글이 쓴 사실」을 뺀 원고라 그대로
            올릴 수 있습니다. <b>발행용 .html</b>은 자체 사이트·CMS용 완성 문서로, JSON-LD(Article·Organization)를
            심어 둡니다 — 네이버 블로그·티스토리는 <code>&lt;head&gt;</code>를 버리므로 그때는 본문만 남습니다.
          </p>
          <div className="gap-grid">
            {rows.map((d) => {
              const md = d.editedMarkdown ?? draftToMarkdown(d.draft)
              const gaps = countGapNotes(md)
              const shown = open === d.actionId
              return (
                <article className="gap-card" key={d.actionId}>
                  <div className="gap-card-head">
                    <span className="gap-name">{d.draft.title}</span>
                    {d.editedMarkdown && <span className="st st-info">고침</span>}
                    {gaps > 0 && <span className="st st-warn">빈칸 {gaps}</span>}
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
                      title="빈칸 표시와 「이 글이 쓴 사실」을 뺀 원고입니다."
                      onClick={() =>
                        downloadMarkdown(
                          `발행용-${safeFileName(d.draft.title)}-${d.generatedAt.slice(0, 10)}.md`,
                          d.editedMarkdown ? stripGapNotes(d.editedMarkdown) : draftToPublishMarkdown(d.draft),
                        )
                      }
                    >
                      발행용 .md{gaps > 0 && <span className="muted"> — 빈칸 {gaps}줄 뺌</span>}
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      title="자체 사이트·CMS용 완성 HTML — <head>에 JSON-LD(Article·Organization)를 심습니다."
                      onClick={() => {
                        void loadFactGraph(tenant.tenantId)
                          .then((fg) => fg?.factGraph ?? [])
                          .catch(() => [] as FactNode[])
                          .then((facts) =>
                            downloadHtml(
                              `발행용-${safeFileName(d.draft.title)}-${d.generatedAt.slice(0, 10)}.html`,
                              buildPublishHtml({ stored: d, brand: tenant, facts }),
                            ),
                          )
                      }}
                    >
                      발행용 .html
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() =>
                        downloadMarkdown(`초안-${safeFileName(d.draft.title)}-${d.generatedAt.slice(0, 10)}.md`, md)
                      }
                    >
                      작업용 .md
                    </button>
                  </div>
                  {shown && (
                    <div className="brief-body">
                      <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                        {d.editedMarkdown ? stripGapNotes(d.editedMarkdown) : draftToPublishMarkdown(d.draft)}
                      </pre>
                    </div>
                  )}
                </article>
              )
            })}
          </div>
        </section>
      )}
    </>
  )
}
