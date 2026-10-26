import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

/**
 * 되돌리기 어려운 일을 하기 전에 묻는 앱 안 대화상자 — window.confirm 대신(상용화 UI 3차 U15).
 *
 * 브라우저 확인 창은 무엇이 남고 무엇이 바뀌는지 길게 적을 수 없고, 엔터 한 번에 넘어갔다. requireText를 주면 그 글(브랜드 이름)을
 * 그대로 입력해야 확인 단추가 눌린다. 틀은 경쟁사 편집의 확인 창(.ce-dialog)과 같다. 열리면 입력 칸(없으면 취소)에 초점을 두고,
 * Esc · 바깥 누르기로 취소한다(진행 중에는 닫지 않는다). 닫히면 연 단추로 초점을 돌린다.
 */
export default function ConfirmDialog({
  title,
  children,
  confirmLabel,
  danger = false,
  requireText,
  busy = false,
  disabledReason,
  onConfirm,
  onCancel,
}: {
  title: string
  children?: ReactNode
  confirmLabel: string
  danger?: boolean
  /** 확인하려면 입력해야 하는 글. */
  requireText?: { label: string; expected: string }
  /** 확인한 일을 하는 중 — 단추를 잠그고 닫지 않는다. */
  busy?: boolean
  /** 지금은 확인할 수 없는 까닭(측정 중 등). 있으면 확인 단추를 잠그고 이 글을 보인다. */
  disabledReason?: string | null
  onConfirm: () => void
  onCancel: () => void
}) {
  const titleId = useId()
  const [typed, setTyped] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const opener = useRef<Element | null>(typeof document === 'undefined' ? null : document.activeElement)

  useEffect(() => {
    ;(inputRef.current ?? cancelRef.current)?.focus()
    const back = opener.current
    return () => {
      if (back instanceof HTMLElement && back.isConnected) back.focus()
    }
  }, [])

  const matches = !requireText || typed.trim().normalize('NFC') === requireText.expected.normalize('NFC')
  const canConfirm = matches && !busy && !disabledReason
  const cancel = () => {
    if (!busy) onCancel()
  }

  return (
    <div className="ce-dialog-backdrop" onMouseDown={cancel}>
      <div
        className="ce-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            cancel()
          }
        }}
      >
        <h3 id={titleId}>{title}</h3>
        {children}
        {requireText && (
          <label className="cd-require">
            <span>{requireText.label}</span>
            <input
              ref={inputRef}
              type="text"
              value={typed}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canConfirm) onConfirm()
              }}
            />
          </label>
        )}
        {disabledReason && (
          <p className="ce-dialog-note cd-blocked" role="status">
            {disabledReason}
          </p>
        )}
        <div className="ce-bar-actions">
          <button ref={cancelRef} type="button" className="btn" onClick={cancel} disabled={busy}>
            취소
          </button>
          <button type="button" className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm} disabled={!canConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
