import { useState, type ReactNode } from 'react'
import { adaptForChannel, type ChannelAdaptation, type StoredDraft } from '../lib/api'
import { copyRich } from '../lib/clipboard'
import { publishMarkdownOf } from '../lib/draftGaps'
import type { GapAction } from '../lib/gapActions'
import { markdownToHtml } from '../lib/htmlFile'
import { channelStyleOf, sourceKeyOf, STYLE_LABEL } from '../prompts/b9d-channel-adapt'

/**
 * ③ 올리기의 채널 탭 — 자사 사이트 + 이 글을 올릴 외부 채널들(콘텐츠 생성 2단계).
 *
 * 탭마다 할 일은 같다: 그 채널에 맞는 글을 복사해 → 채널을 열어 붙이고 → 올린 주소를 적는다. 외부 채널은
 * 「이 채널 문체로 다듬기」를 한 번 눌러 글을 받는다(판정 1~2회, 원문 내용만 쓰고 사실 대조를 거친다 —
 * server/channelAdapt.ts). 다듬은 글은 저장되고, 원문을 고치거나 빈칸을 더 채우면 다시 다듬으라고 알린다.
 *
 * 주소는 **그 채널 항목**에 기록한다 — 아래 「올릴 곳」 카드와 같은 기록이라 두 곳이 어긋나지 않는다.
 */
/** 탭 이름 — 항목 제목에서 할 일(발행·등재…)을 뗀다. 「네이버 블로그 발행」 → 「네이버 블로그」. */
function channelName(a: GapAction): string {
  return a.title.replace(/\s*(발행|등재|문서 보완|커뮤니티 노출|보도·기고|채널 콘텐츠)$/, '').trim() || (a.targetDomain ?? a.title)
}

export default function ChannelTabs({
  tenantId,
  contentActionId,
  stored,
  channels,
  adaptations,
  onAdapted,
  ownSite,
  ownPublished,
  channelSlot,
}: {
  tenantId: string
  contentActionId: string
  /** 원문 초안 — 다듬기의 근거(빈칸을 채운 발행본). */
  stored: StoredDraft
  channels: GapAction[]
  /** 이 글의 채널별 다듬은 글. null이면 다듬기 라우트가 없는 환경이다. */
  adaptations: Record<string, ChannelAdaptation> | null
  onAdapted: (a: ChannelAdaptation) => void
  /** 자사 사이트 탭 내용(원문 복사·파일·주소 기록). */
  ownSite: ReactNode
  ownPublished: boolean
  /** 채널 항목의 주소 기록 부품. 상태를 저장할 수 없는 환경이면 null. */
  channelSlot: (a: GapAction) => ReactNode
}) {
  const [tab, setTab] = useState<string>('own')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const source = publishMarkdownOf(stored)
  const sourceKey = sourceKeyOf(source)
  const published = (a: GapAction) => a.publishedUrls.length > 0 || a.status === 'done'
  const current = channels.find((c) => c.id === tab) ?? null

  const adapt = async (a: GapAction) => {
    setBusy(a.id)
    setError(null)
    try {
      onAdapted(
        await adaptForChannel(tenantId, {
          contentActionId,
          channelActionId: a.id,
          channelDomain: a.targetDomain ?? a.title,
          channelBadge: a.badge,
          sourceMarkdown: source,
        }),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const copy = async (key: string, markdown: string) => {
    if (await copyRich(markdown, markdownToHtml(markdown))) {
      setCopied(key)
      window.setTimeout(() => setCopied((k) => (k === key ? null : k)), 1800)
    } else {
      setError('클립보드에 복사하지 못했습니다.')
    }
  }

  const done = (ownPublished ? 1 : 0) + channels.filter(published).length

  return (
    <div className="channel-tabs">
      <div className="channel-tablist" role="tablist" aria-label={`올릴 곳 ${channels.length + 1}곳 · 올림 ${done}곳`}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'own'}
          className={`channel-tab${tab === 'own' ? ' on' : ''}`}
          onClick={() => setTab('own')}
        >
          <span className={`channel-dot${ownPublished ? ' up' : ''}`} aria-hidden="true" />
          자사 사이트
        </button>
        {channels.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={tab === c.id}
            className={`channel-tab${tab === c.id ? ' on' : ''}`}
            onClick={() => setTab(c.id)}
            title={published(c) ? '올린 주소가 기록돼 있습니다' : '아직 올리지 않았습니다'}
          >
            <span className={`channel-dot${published(c) ? ' up' : ''}`} aria-hidden="true" />
            {channelName(c)}
          </button>
        ))}
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {tab === 'own' || !current ? (
        <div role="tabpanel" className="channel-panel">
          {ownSite}
        </div>
      ) : (
        (() => {
          const a = adaptations?.[current.id]
          const stale = Boolean(a && a.sourceKey !== sourceKey)
          const style = channelStyleOf(current.badge)
          const domain = current.targetDomain ?? current.title
          return (
            <div role="tabpanel" className="channel-panel">
              <p className="channel-why">
                <span className="chip">{current.badge}</span> {current.evidence.split(/(?<=[.다])\s/)[0]}
              </p>
              {adaptations === null ? (
                <p className="doc-meta">이 환경에서는 채널 다듬기를 쓸 수 없습니다. 자사 사이트 탭의 원문을 복사해 쓰세요.</p>
              ) : !a ? (
                <div className="brief-bar">
                  <button type="button" disabled={busy !== null} onClick={() => void adapt(current)}>
                    {busy === current.id ? '다듬는 중… 보통 30초~1분' : '이 채널 문체로 다듬기 · 약 30초~1분'}
                  </button>
                  <span className="doc-meta">{STYLE_LABEL[style]} — 원문 내용만 쓰고 새 사실은 더하지 않습니다.</span>
                </div>
              ) : (
                <>
                  {stale && (
                    <p className="channel-stale">
                      원문이 바뀌었습니다(빈칸을 채웠거나 고쳤습니다).{' '}
                      <button type="button" className="link-btn" disabled={busy !== null} onClick={() => void adapt(current)}>
                        {busy === current.id ? '다시 다듬는 중…' : '다시 다듬기'}
                      </button>
                    </p>
                  )}
                  <div className="channel-head">
                    <span className="channel-title">{a.title || stored.draft.title}</span>
                    <span className="chip">{STYLE_LABEL[a.style]}</span>
                  </div>
                  {/* markdownToHtml은 모든 글자를 이스케이프한다 — 판정 엔진이 쓴 글에 태그가 있어도 글자로 남는다. */}
                  <div className="channel-preview" dangerouslySetInnerHTML={{ __html: markdownToHtml(a.markdown) }} />
                  <div className="draft-copy">
                    <button type="button" className="draft-copy-btn" onClick={() => void copy(current.id, a.markdown)}>
                      {copied === current.id ? '복사했습니다' : '이 글 복사'}
                    </button>
                    <a className="channel-open" href={`https://${domain.replace(/^https?:\/\//, '')}`} target="_blank" rel="noreferrer">
                      {domain} 열기 ↗
                    </a>
                    <button type="button" className="ghost link-btn" onClick={() => void copy(`${current.id}:title`, a.title || stored.draft.title)}>
                      {copied === `${current.id}:title` ? '제목 복사함' : '제목만 복사'}
                    </button>
                  </div>
                  {a.notes && a.notes.length > 0 && (
                    <details className="draft-audit">
                      <summary>사실 대조에서 뺀 문장 {a.notes.length}건</summary>
                      <ul className="muted">
                        {a.notes.map((n) => (
                          <li key={n}>{n}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {!stale && (
                    <p className="doc-meta">
                      {a.generatedAt.slice(0, 10)} 다듬음 ·{' '}
                      <button type="button" className="link-btn" disabled={busy !== null} onClick={() => void adapt(current)}>
                        {busy === current.id ? '다시 다듬는 중…' : '다시 다듬기'}
                      </button>
                    </p>
                  )}
                </>
              )}
              {channelSlot(current)}
            </div>
          )
        })()
      )}
    </div>
  )
}
