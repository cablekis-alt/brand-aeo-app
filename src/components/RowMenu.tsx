import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface RowMenuItem {
  key: string
  label: string
  /** 항목 오른쪽의 짧은 보조 글(「대기 6곳」). */
  hint?: string
  onSelect: () => void
  disabled?: boolean
  /** 누를 수 없는 까닭(disabled일 때) 또는 설명. */
  title?: string
  /** 이 항목 위에 구분선. */
  separatorBefore?: boolean
}

const MENU_WIDTH = 220
const ITEM_HEIGHT = 32
const SEPARATOR_HEIGHT = 9
const MENU_PADDING = 8
const EDGE = 8

/**
 * 줄 끝의 ⋯ 메뉴 — 브랜드 현황 줄의 「개요 보기 · 측정 · 경쟁사 편집 · 기본 정보」(상용화 UI 3차 U32a).
 *
 * 예전에는 비교 그룹 카드 머리에 고객 브랜드마다 「기본 정보 · 경쟁사 편집」 링크를 늘어놓아, 고객이 여럿인 영어 비교 그룹 머리에는
 * 링크 15개가 네 줄로 쌓였다. 메뉴는 문서 맨 바깥(body)에 그린다 — 카드가 잘라 내지 않고 sticky 머리 위로 뜨게(BrandPickerPanel과 같은
 * 까닭). 아래 공간이 모자라면 위로 연다(항목 높이가 고정이라 열기 전에 잰다).
 *
 * 키보드: 열면 첫 항목, ↑↓ · Home · End로 옮긴다 — 잠긴 항목도 거쳐 가 까닭(title)을 읽을 수 있게 하고, 누르면 아무 일도 하지 않는다.
 * 어떻게 닫든(Esc · Tab · 바깥 누르기 · 창 스크롤 · 크기 변화 · 항목 고르기) 초점은 ⋯로 돌아온다 — 항목이 서랍을 열면 서랍이 닫힐 때
 * 돌아올 자리가 ⋯가 된다.
 */
export default function RowMenu({ label, items }: { label: string; items: RowMenuItem[] }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const open = pos !== null
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const close = () => {
    setPos(null)
    // 스크롤로 닫힐 때 화면이 ⋯ 쪽으로 튀지 않게.
    triggerRef.current?.focus({ preventScroll: true })
  }
  const show = () => {
    const trigger = triggerRef.current?.getBoundingClientRect()
    if (!trigger) return
    const height = MENU_PADDING + items.length * ITEM_HEIGHT + items.filter((i) => i.separatorBefore).length * SEPARATOR_HEIGHT
    const below = trigger.bottom + 4
    const top = below + height + EDGE > window.innerHeight ? Math.max(EDGE, trigger.top - 4 - height) : below
    const left = Math.min(Math.max(EDGE, trigger.right - MENU_WIDTH), window.innerWidth - MENU_WIDTH - EDGE)
    setPos({ top, left })
  }

  useEffect(() => {
    if (!open) return
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const closeQuietly = () => {
      setPos(null)
      triggerRef.current?.focus({ preventScroll: true })
    }
    const onScroll = (e: Event) => {
      // 메뉴 안 스크롤은 닫지 않는다.
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return
      closeQuietly()
    }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', closeQuietly)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', closeQuietly)
    }
  }, [open])

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const list = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const i = list.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (list.length === 0) return
      const step = e.key === 'ArrowDown' ? 1 : -1
      list[(i + step + list.length) % list.length]?.focus()
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      ;(e.key === 'Home' ? list[0] : list.at(-1))?.focus()
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault()
      close()
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="pf-more"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => (open ? close() : show())}
      >
        ⋯
      </button>
      {pos &&
        createPortal(
          <>
            {/* 누른 자리로 초점이 옮겨 가지 않게 막는다 — 막지 않으면 ⋯로 돌린 초점이 곧바로 body로 빠진다. */}
            <div
              className="rm-backdrop"
              onMouseDown={(e) => {
                e.preventDefault()
                close()
              }}
            />
            <div
              ref={menuRef}
              className="rm-menu"
              role="menu"
              aria-label={label}
              style={{ top: pos.top, left: pos.left, width: MENU_WIDTH }}
              onKeyDown={onKeyDown}
            >
              {items.map((item) => (
                <div key={item.key} role="none">
                  {item.separatorBefore && <div className="rm-sep" role="separator" />}
                  <button
                    type="button"
                    role="menuitem"
                    className="rm-item"
                    aria-disabled={item.disabled ? 'true' : undefined}
                    title={item.title}
                    tabIndex={-1}
                    onClick={() => {
                      if (item.disabled) return
                      close()
                      item.onSelect()
                    }}
                  >
                    <span>{item.label}</span>
                    {item.hint && <span className="rm-hint">{item.hint}</span>}
                  </button>
                </div>
              ))}
            </div>
          </>,
          document.body,
        )}
    </>
  )
}
