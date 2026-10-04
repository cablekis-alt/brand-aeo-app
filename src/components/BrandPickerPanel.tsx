import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PortfolioRow } from '../lib/api'
import { groupColor, industryGroupOf } from '../lib/industryGroups'
import { groupByIndustry, needsMeasure, statusShort, statusTone } from '../lib/portfolioView'

export interface PickerRow {
  tenantId: string
  brandName: string
  /** 묶는 기준 — 부르는 쪽이 정한다(브랜드 바꾸기는 마지막 측정, 측정 화면은 지금 설정). */
  industry: string
  region: string
  score: number | null
  /** 브랜드 현황 한 줄. 아직 못 읽었거나 웹(엔드포인트 없음)이거나 경쟁사면 null. */
  p: PortfolioRow | null
  /** 비교용 경쟁사(cohortOnly) — 「경쟁사」 표시를 달고 고객 브랜드 아래에 둔다. */
  competitor?: boolean
}

const isNeed = (r: PickerRow) => r.p !== null && needsMeasure(r.p)

/** 공백·대소문자를 무시하고 낱말마다 찾는다(명령 창과 같은 방식). */
function hit(text: string, query: string): boolean {
  const hay = text.toLowerCase().replace(/\s+/g, '')
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w))
}

/**
 * 업종별 브랜드 고르기 패널 — 왼쪽 업종군, 오른쪽 코호트(업종 · 지역) → 브랜드, 위 검색·「측정 필요만」.
 *
 * 사이드바 브랜드 바꾸기(BrandSwitcher)와 측정 화면의 측정 대상 고르기(MeasureTenant)가 함께 쓴다.
 * 열릴 때 마운트되므로 거르개·검색은 열 때마다 처음 상태다. 위치는 부르는 쪽이 잰 기준점(anchor)에
 * 화면 기준(position: fixed)으로 띄운다 — 사이드바처럼 overflow: hidden인 곳에서도 잘리지 않는다.
 */
export default function BrandPickerPanel({
  rows,
  currentId,
  known,
  loading,
  anchor,
  label,
  verb,
  cohortSize,
  links,
  onPick,
  onClose,
}: {
  rows: PickerRow[]
  /** 체크 표시할 지금 대상. 처음 펼칠 업종군도 여기서 정한다. */
  currentId: string | null
  /** 브랜드 현황(점수·상태)을 받았는지 — 없으면 점수·상태·「측정 필요만」을 숨긴다. */
  known: boolean
  loading: boolean
  anchor: { top: number; left: number }
  label: string
  /** 아래 안내의 Enter 동작 이름(「바꾸기」·「고르기」). */
  verb: string
  /** 코호트 머리의 「코호트 n곳」 — 마지막 측정의 코호트 크기, 또는 목록에 든 수(지금 설정 기준). */
  cohortSize: 'measured' | 'listed'
  links?: ReactNode
  onPick: (tenantId: string) => void
  onClose: () => void
}) {
  const [group, setGroup] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [needOnly, setNeedOnly] = useState(false)
  const [active, setActive] = useState<string | null>(currentId)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  const current = rows.find((r) => r.tenantId === currentId) ?? null
  const currentGroup = current ? industryGroupOf(current.industry) : null
  const allGroups = useMemo(() => groupByIndustry(rows), [rows])
  const listedSize = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of rows) m.set(`${r.industry} · ${r.region}`, (m.get(`${r.industry} · ${r.region}`) ?? 0) + 1)
    return m
  }, [rows])
  const q = query.trim()
  const shownGroup = q ? null : (group ?? currentGroup ?? allGroups[0]?.name ?? null)

  const visible = useMemo(() => {
    const pass = (r: PickerRow) =>
      (!needOnly || !known || isNeed(r)) &&
      (q ? hit(`${r.brandName} ${r.tenantId} ${r.industry} ${r.region}`, q) : industryGroupOf(r.industry) === shownGroup)
    return groupByIndustry(rows.filter(pass)).map((g) => ({
      ...g,
      // 같은 코호트 안에서는 고객 브랜드를 위에, 경쟁사를 아래에 둔다(각각 점수 순서는 그대로).
      cohorts: g.cohorts.map((c) => ({ ...c, list: [...c.list.filter((r) => !r.competitor), ...c.list.filter((r) => r.competitor)] })),
    }))
  }, [rows, needOnly, known, q, shownGroup])
  const order = visible.flatMap((g) => g.cohorts.flatMap((c) => c.list.map((r) => r.tenantId)))
  const activeId =
    active && order.includes(active) ? active : currentId && order.includes(currentId) ? currentId : (order[0] ?? null)

  useEffect(() => {
    if (!activeId) return
    listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(activeId)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const i = activeId ? order.indexOf(activeId) : -1
    if (e.key === 'ArrowDown' && order.length > 0) {
      e.preventDefault()
      setActive(order[(i + 1) % order.length]!)
    } else if (e.key === 'ArrowUp' && order.length > 0) {
      e.preventDefault()
      setActive(order[(i - 1 + order.length) % order.length]!)
    } else if (e.key === 'Enter' && activeId) {
      e.preventDefault()
      onPick(activeId)
    }
  }

  const needTotal = rows.filter(isNeed).length
  const found = order.length

  return (
    <div className="bsw-backdrop" onMouseDown={onClose}>
      <div
        className="bsw"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        style={{ '--bsw-top': `${anchor.top}px`, '--bsw-left': `${anchor.left}px` } as React.CSSProperties}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
      >
        <div className="bsw-head">
          <label className="bsw-search">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" aria-hidden="true">
              <path d="M10.5 4a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13zM15.5 15.5L20 20" />
            </svg>
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setActive(null)
              }}
              onKeyDown={onSearchKey}
              placeholder="브랜드 · 업종 · 지역 찾기"
              aria-label="브랜드 찾기"
              role="combobox"
              aria-expanded="true"
              aria-controls="bsw-list"
              aria-activedescendant={activeId ? `bsw-${activeId}` : undefined}
              aria-autocomplete="list"
            />
          </label>
          {known && (
            <button
              type="button"
              className={`bsw-need${needOnly ? ' on' : ''}`}
              aria-pressed={needOnly}
              onClick={() => {
                setNeedOnly(!needOnly)
                setActive(null)
              }}
            >
              <span className="bsw-dot warn" aria-hidden="true" />
              측정 필요만 <span className="bsw-num">{needTotal}</span>
            </button>
          )}
        </div>

        <div className="bsw-body">
          <div className="bsw-groups" role="group" aria-label="업종군">
            {allGroups.map((g) => {
              const list = g.cohorts.flatMap((c) => c.list)
              const need = list.filter(isNeed).length
              const on = g.name === shownGroup
              return (
                <button
                  key={g.name}
                  type="button"
                  className={`bsw-group${on ? ' on' : ''}`}
                  aria-pressed={on}
                  onClick={() => {
                    setGroup(g.name)
                    setQuery('')
                    setActive(null)
                    searchRef.current?.focus()
                  }}
                >
                  <span className="grp-dot" style={{ '--grp': groupColor(g.name) } as React.CSSProperties} aria-hidden="true" />
                  <span className="bsw-group-text">
                    <span className="bsw-group-name">{g.name}</span>
                    {known && need > 0 && <span className="bsw-group-need">측정 필요 {need}</span>}
                  </span>
                  {g.name === currentGroup && <span className="bsw-dot good" title="지금 고른 브랜드가 여기 있음" />}
                  <span className="bsw-num">{list.length}</span>
                </button>
              )
            })}
          </div>

          <div className="bsw-list" id="bsw-list" role="listbox" aria-label="브랜드" ref={listRef}>
            {q && <p className="bsw-note">검색 결과 {found}곳 — 업종군 전체에서 찾았습니다</p>}
            {visible.map((g) => (
              <div key={g.name} role="presentation">
                {q && <p className="bsw-group-head">{g.name}</p>}
                {g.cohorts.map((c) => {
                  const size =
                    cohortSize === 'listed'
                      ? (listedSize.get(c.label) ?? 0)
                      : Math.max(0, ...c.list.map((r) => r.p?.totalTenants ?? 0))
                  return (
                    <div key={c.label} className="bsw-cohort" role="presentation">
                      <p className="bsw-cohort-head">
                        <span className="bsw-cohort-label">{c.label}</span>
                        {size > 0 && <span>코호트 {size}곳</span>}
                      </p>
                      {c.list.map((r) => {
                        const isCurrent = r.tenantId === currentId
                        return (
                          <div
                            key={r.tenantId}
                            id={`bsw-${r.tenantId}`}
                            data-id={r.tenantId}
                            role="option"
                            aria-selected={r.tenantId === activeId}
                            aria-current={isCurrent || undefined}
                            className={`bsw-row${r.tenantId === activeId ? ' on' : ''}${isCurrent ? ' current' : ''}${r.competitor ? ' competitor' : ''}`}
                            onMouseMove={() => r.tenantId !== activeId && setActive(r.tenantId)}
                            onClick={() => onPick(r.tenantId)}
                          >
                            <span className="bsw-check" aria-hidden="true">
                              {isCurrent && (
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M5 12l5 5 9-10" />
                                </svg>
                              )}
                            </span>
                            <span className="bsw-name">
                              {r.brandName}
                              {r.competitor && <span className="bsw-tag">경쟁사</span>}
                            </span>
                            <span className="bsw-score">{r.p?.score ?? (known && !r.competitor ? '—' : '')}</span>
                            <span className="bsw-rank">{r.p?.rank ? `${r.p.tied ? '공동 ' : ''}${r.p.rank}/${r.p.totalTenants}` : ''}</span>
                            <span className="bsw-status">
                              {r.p && (
                                <>
                                  <span className={`bsw-dot ${statusTone(r.p.status)}`} aria-hidden="true" />
                                  {statusShort(r.p)}
                                </>
                              )}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  )
                })}
              </div>
            ))}
            {found === 0 && <p className="bsw-note">맞는 브랜드가 없습니다. 업종 이름이나 지역으로도 찾을 수 있습니다.</p>}
          </div>
        </div>

        <div className="bsw-foot">
          <span>
            <kbd>↑↓</kbd> 이동 · <kbd>Enter</kbd> {verb} · <kbd>Esc</kbd> 닫기
            {loading && <span className="bsw-loading"> · 점수·상태 불러오는 중…</span>}
          </span>
          {links && <span className="bsw-links">{links}</span>}
        </div>
      </div>
    </div>
  )
}
