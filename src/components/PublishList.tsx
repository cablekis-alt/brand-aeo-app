import { useEffect, useRef, useState, type ReactNode } from 'react'
import { adaptForChannel, type ChannelAdaptation, type ChannelAdaptationMap } from '../lib/api'
import { copyRich } from '../lib/clipboard'
import { publishMarkdownOf } from '../lib/draftGaps'
import type { GapAction } from '../lib/gapActions'
import { markdownToHtml, publishBodyHtml } from '../lib/htmlFile'
import { pregenerateTargets, VERB_CAUTION, VERB_LABEL, type PublishPlan, type PublishRow } from '../lib/publishPlan'
import { sourceKeyOf, STYLE_LABEL } from '../prompts/b9d-channel-adapt'

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
  adaptations,
  onAdapted,
  urlSlot,
  onShowArticle,
  focusId = '',
}: {
  tenantId: string
  plan: PublishPlan
  /** 글별 채널 다듬은 글. null이면 다듬기 라우트가 없는 환경(웹)이다 — 원문을 복사한다. */
  adaptations: ChannelAdaptationMap | null
  onAdapted: (a: ChannelAdaptation) => void
  /** 올린 주소 기록 부품. 상태를 저장할 수 없는 환경이면 null. */
  urlSlot: (target: GapAction) => ReactNode
  /** 잠긴 줄의 「글 확인하러 가기」 — 그 글 카드로 옮겨 간다. */
  onShowArticle: (actionId: string) => void
  /** 인용 갭 분석에서 넘어온 채널 항목 id — 그 줄을 강조하고 스크롤 목적지(action-<id>)로 둔다. */
  focusId?: string
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
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

  /** 이 줄에서 복사할 글. 다듬은 글이 필요한데 아직 없으면 null. */
  const textOf = (row: PublishRow): { markdown: string; html: string } | null => {
    const d = row.article.draft
    if (!d) return null
    if (!row.needsAdapt || adaptations === null) return { markdown: publishMarkdownOf(d), html: publishBodyHtml(d) }
    const a = adaptationOf(row)
    return a ? { markdown: a.markdown, html: markdownToHtml(a.markdown) } : null
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
          const stale = Boolean(a && row.article.draft && a.sourceKey !== sourceKeyOf(sourceOf(row)))
          const text = textOf(row)
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
                  <span className="publish-row-article">{row.article.draft?.draft.title || row.article.action.title}</span>
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
              {!row.locked && !row.done && VERB_CAUTION[row.verb] && <p className="publish-row-note">{VERB_CAUTION[row.verb]}</p>}
              {stale && (
                <p className="channel-stale">
                  원문이 바뀌었습니다(빈칸을 채웠거나 고쳤습니다).{' '}
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
              {slotOpen && <div className="publish-row-slot">{urlSlot(row.target)}</div>}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
