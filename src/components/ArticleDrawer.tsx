import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * 콘텐츠 생성의 글 서랍 — 글이 여러 편이면 글 카드를 접어 두고, 목록의 「열기」로 이 서랍에서 한 편씩 확인 · 사진 · 올리기를 한다
 * (2026-11-11 개편 시안). 내용(글 카드 · 그 글의 올리기 줄)은 화면이 children으로 넣는다 — 서랍은 틀만: 제목 · 닫기 · 이전/다음 글,
 * Esc · 바깥 누르기로 닫기. 모달이라 body 끝에 그리고(포털) 열려 있는 동안 앱 루트(#root)를 inert로 잠근다 — 열면 서랍으로 포커스를
 * 옮기고 닫으면 연 단추로 돌려준다.
 */
export default function ArticleDrawer({
  title,
  position,
  onClose,
  onPrev,
  onNext,
  children,
}: {
  title: string
  /** 「3 / 11」 — 지금 보이는 목록에서의 차례. */
  position: string
  onClose: () => void
  onPrev: (() => void) | null
  onNext: (() => void) | null
  children: ReactNode
}) {
  const headingId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  }, [onClose])

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const root = document.getElementById('root')
    const wasInert = root?.inert ?? false
    if (root) root.inert = true
    panelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault()
        closeRef.current()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (root) root.inert = wasInert
      opener?.focus()
    }
  }, [])

  return createPortal(
    <div className="article-drawer-layer">
      <div className="article-drawer-backdrop" aria-hidden="true" onClick={onClose} />
      <div ref={panelRef} className="article-drawer" role="dialog" aria-modal="true" aria-labelledby={headingId} tabIndex={-1}>
        <div className="article-drawer-head">
          <h2 id={headingId}>{title}</h2>
          <button type="button" className="ghost article-drawer-close" aria-label="서랍 닫기" onClick={onClose}>
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M3 3l10 10M13 3L3 13" />
            </svg>
          </button>
        </div>
        <div className="article-drawer-body">{children}</div>
        <div className="article-drawer-foot">
          <button type="button" className="ghost" onClick={onPrev ?? undefined} disabled={!onPrev}>
            이전 글
          </button>
          <span className="muted">{position}</span>
          <button type="button" className="ghost" onClick={onNext ?? undefined} disabled={!onNext}>
            다음 글
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
