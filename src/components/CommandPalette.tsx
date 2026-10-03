import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTenant } from '../context/useTenant'
import { loadQuestionBank } from '../lib/api'
import { allScreens } from '../lib/menu'
import type { QuestionSpec } from '../lib/types'

interface Command {
  id: string
  kind: '화면' | '질문' | '경쟁사'
  label: string
  hint: string
  to: string
}

const MAX_QUESTIONS = 8
const MAX_COMPETITORS = 5

/** 공백·대소문자를 무시하고 찾는다 — 「종로 고객센터」로 「종로 지역 고객센터」를 찾게 낱말마다 본다. */
function matches(text: string, query: string): boolean {
  const hay = text.toLowerCase().replace(/\s+/g, '')
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w))
}

/**
 * 명령 창(Ctrl K · ⌘K) — 화면 이동, 이 브랜드의 질문 찾기, 경쟁사 찾기를 한 칸에서 한다(상용화 UI 2차 9단계).
 *
 * 메뉴가 「상세 분석」·「설정」에 접혀 있어도 이름만 치면 간다. 질문은 이 브랜드의 현재 질문지에서 찾고
 * AI 답변 화면의 그 질문으로 연다. 경쟁사는 경쟁 순위로 보낸다 — 경쟁사별 화면이 따로 없고, 코호트 안
 * 위치를 보는 곳이 거기다. 질문지는 창을 처음 열 때 한 번 읽는다(앱을 켤 때마다 읽지 않는다).
 */
export default function CommandPalette() {
  const navigate = useNavigate()
  const { tenant } = useTenant()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)

  const show = () => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setQuery('')
    setActive(0)
    setOpen(true)
  }
  const close = () => {
    setOpen(false)
    returnFocus.current?.focus()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (open) close()
        else show()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const [bank, setBank] = useState<{ tenantId: string; questions: QuestionSpec[] } | null>(null)
  const tenantId = tenant?.tenantId ?? ''
  useEffect(() => {
    if (!open || !tenantId || bank?.tenantId === tenantId) return
    let alive = true
    loadQuestionBank(tenantId).then(
      (b) => alive && setBank({ tenantId, questions: b?.questions ?? [] }),
      (err: unknown) => {
        console.error('[CommandPalette] 질문지를 읽지 못했습니다', err)
        if (alive) setBank({ tenantId, questions: [] })
      },
    )
    return () => {
      alive = false
    }
  }, [open, tenantId, bank?.tenantId])

  const results = useMemo((): Command[] => {
    const q = query.trim()
    const screens = allScreens()
      .filter((s) => !q || matches(`${s.label} ${s.group ?? ''}`, q))
      .map((s) => ({ id: `s:${s.to}`, kind: '화면' as const, label: s.label, hint: s.group ?? '', to: s.to }))
    if (!q) return screens
    const questions = (bank?.tenantId === tenantId ? bank.questions : [])
      .filter((x) => matches(`${x.text} ${x.topic ?? ''}`, q))
      .slice(0, MAX_QUESTIONS)
      .map((x) => ({
        id: `q:${x.questionId}`,
        kind: '질문' as const,
        label: x.text,
        hint: [x.topic, x.category === 'category-agnostic' ? '이름 없는 질문' : '이름 넣은 질문'].filter(Boolean).join(' · '),
        to: `/answers?q=${encodeURIComponent(x.questionId)}`,
      }))
    const competitors = (tenant?.competitors ?? [])
      .filter((c) => matches(c, q))
      .slice(0, MAX_COMPETITORS)
      .map((c) => ({ id: `c:${c}`, kind: '경쟁사' as const, label: c, hint: '경쟁 순위에서 보기', to: '/ranking' }))
    return [...screens, ...questions, ...competitors]
  }, [query, bank, tenantId, tenant?.competitors])

  const current = Math.min(active, Math.max(0, results.length - 1))
  const go = (c: Command) => {
    setOpen(false)
    navigate(c.to)
  }

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((current + 1) % Math.max(1, results.length))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((current - 1 + results.length) % Math.max(1, results.length))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const c = results[current]
      if (c) go(c)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  }

  const listRef = useRef<HTMLUListElement>(null)
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [current, open])

  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
  const loadingQuestions = open && Boolean(tenantId) && bank?.tenantId !== tenantId

  return (
    <>
      <button type="button" className="topbar-search" onClick={show} aria-haspopup="dialog">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" aria-hidden="true">
          <path d="M10.5 4a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13zM15.5 15.5L20 20" />
        </svg>
        <span className="topbar-search-label">화면·질문·경쟁사 찾기</span>
        <kbd>{isMac ? '⌘K' : 'Ctrl K'}</kbd>
      </button>

      {open && (
        <div className="palette-backdrop" onMouseDown={close}>
          <div
            className="palette"
            role="dialog"
            aria-modal="true"
            aria-label="명령 창"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <input
              ref={inputRef}
              className="palette-input"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setActive(0)
              }}
              onKeyDown={onInputKey}
              placeholder="화면 이름, 질문 낱말, 경쟁사 이름"
              role="combobox"
              aria-expanded="true"
              aria-controls="palette-list"
              aria-activedescendant={results[current] ? `palette-${current}` : undefined}
              aria-autocomplete="list"
            />
            <ul ref={listRef} id="palette-list" className="palette-list" role="listbox" aria-label="찾은 항목">
              {results.map((c, i) => {
                const head = i === 0 || results[i - 1]!.kind !== c.kind
                return (
                  <li key={c.id} role="presentation">
                    {head && <p className="palette-group">{c.kind}</p>}
                    <div
                      id={`palette-${i}`}
                      role="option"
                      aria-selected={i === current}
                      className={`palette-item${i === current ? ' on' : ''}`}
                      onMouseMove={() => i !== current && setActive(i)}
                      onClick={() => go(c)}
                    >
                      <span className="palette-label">{c.label}</span>
                      {c.hint && <span className="palette-hint">{c.hint}</span>}
                    </div>
                  </li>
                )
              })}
            </ul>
            {results.length === 0 && <p className="palette-empty">찾은 항목이 없습니다.</p>}
            <p className="palette-foot">
              <span>↑↓ 고르기 · Enter 열기 · Esc 닫기</span>
              {loadingQuestions && query.trim() && <span>질문지를 불러오는 중…</span>}
            </p>
          </div>
        </div>
      )}
    </>
  )
}
