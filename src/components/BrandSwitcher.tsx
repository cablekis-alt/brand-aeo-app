import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTenant } from '../context/useTenant'
import { loadPortfolio, type PortfolioRow } from '../lib/api'
import { industryGroupOf } from '../lib/industryGroups'
import { groupByIndustry, needsMeasure, statusShort, statusTone } from '../lib/portfolioView'
import NavIcon from './NavIcon'

interface Row {
  tenantId: string
  brandName: string
  industry: string
  region: string
  score: number | null
  /** 브랜드 현황 한 줄. 아직 못 읽었거나 웹(엔드포인트 없음)이면 null — 이름·업종만 보인다. */
  p: PortfolioRow | null
}

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
 * 브랜드 바꾸기 — 사이드바 머리의 브랜드 칸과, 누르면 열리는 업종별 패널(상용화 UI 5차 시안).
 *
 * 예전에는 기본 select에 업종군 optgroup을 달았다. 브랜드가 30곳을 넘자 좁은 칸에 이름만 길게 늘어서
 * 어느 코호트에 누가 있는지, 어디를 다시 재야 하는지 보이지 않았다. 패널은 왼쪽에 업종군, 오른쪽에
 * 코호트(업종 · 지역) → 브랜드를 점수·순위·상태와 함께 놓는다. 묶는 규칙은 브랜드 현황 화면과 같다
 * (lib/portfolioView). 브랜드를 고르면 보던 화면은 그대로 두고 브랜드만 바꾼다 — 브랜드 현황 화면에서
 * 고르면 개요로 가는 것과 다르다(그쪽은 훑어보다 들어가는 곳, 이쪽은 같은 화면을 브랜드만 바꿔 보는 곳).
 *
 * 사이드바는 overflow: hidden이라 패널을 그 안에 띄우면 잘린다. 열 때 브랜드 칸 위치를 재서 화면 기준
 * (position: fixed)으로 띄운다. 점수·상태는 열 때마다 /api/portfolio를 새로 읽고, 오기 전에는 이미 가진
 * 브랜드 목록으로 이름부터 보여 준다.
 */
export default function BrandSwitcher() {
  const { tenants, tenant, setTenantId } = useTenant()
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState({ top: 0, left: 0 })
  const [portfolio, setPortfolio] = useState<{ loaded: boolean; rows: PortfolioRow[] | null }>({ loaded: false, rows: null })
  const [group, setGroup] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [needOnly, setNeedOnly] = useState(false)
  const [active, setActive] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const show = () => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) setAnchor({ top: rect.bottom + 6, left: rect.left })
    setGroup(null)
    setQuery('')
    setActive(tenant?.tenantId ?? null)
    setOpen(true)
    loadPortfolio().then(
      (value) => setPortfolio({ loaded: true, rows: value?.rows ?? null }),
      (err: unknown) => {
        console.error('[BrandSwitcher] 브랜드 현황을 읽지 못했습니다', err)
        setPortfolio((p) => ({ ...p, loaded: true }))
      },
    )
  }
  const close = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  useEffect(() => {
    if (open) searchRef.current?.focus()
  }, [open])

  const rows = useMemo((): Row[] => {
    const byId = new Map((portfolio.rows ?? []).map((r) => [r.tenantId, r]))
    return tenants.map((t) => {
      const p = byId.get(t.tenantId) ?? null
      // 점수 기록의 업종·지역이 실제 코호트다(영어 질문 측정은 지역에 꼬리표가 붙는다).
      return { tenantId: t.tenantId, brandName: t.brandName, industry: p?.industry ?? t.industry, region: p?.region ?? t.region, score: p?.score ?? null, p }
    })
  }, [tenants, portfolio.rows])
  const known = portfolio.rows !== null

  const current = rows.find((r) => r.tenantId === tenant?.tenantId) ?? null
  const currentGroup = current ? industryGroupOf(current.industry) : null
  const allGroups = useMemo(() => groupByIndustry(rows), [rows])
  const q = query.trim()
  const shownGroup = q ? null : (group ?? currentGroup ?? allGroups[0]?.name ?? null)

  const visible = useMemo(() => {
    const pass = (r: Row) =>
      (!needOnly || !known || (r.p !== null && needsMeasure(r.p))) &&
      (q ? hit(`${r.brandName} ${r.industry} ${r.region}`, q) : industryGroupOf(r.industry) === shownGroup)
    return groupByIndustry(rows.filter(pass))
  }, [rows, needOnly, known, q, shownGroup])
  const order = visible.flatMap((g) => g.cohorts.flatMap((c) => c.list.map((r) => r.tenantId)))
  const activeId =
    active && order.includes(active) ? active : tenant && order.includes(tenant.tenantId) ? tenant.tenantId : (order[0] ?? null)

  useEffect(() => {
    if (!open || !activeId) return
    listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(activeId)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [open, activeId])

  const pick = (tenantId: string) => {
    setTenantId(tenantId)
    close()
  }

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
      pick(activeId)
    }
  }

  if (!tenant) return null
  const initial = Array.from(tenant.brandName.trim())[0] ?? '?'
  const needTotal = rows.filter((r) => r.p !== null && needsMeasure(r.p)).length
  const found = order.length

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`brand-switch${open ? ' is-open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`브랜드 바꾸기 — 지금 ${tenant.brandName}`}
        onClick={() => (open ? close() : show())}
      >
        <span className="brand-switch-initial" aria-hidden="true">
          {initial}
        </span>
        <span className="brand-switch-text" aria-hidden="true">
          <span className="brand-switch-name">{tenant.brandName}</span>
          <span className="brand-switch-meta">
            {current?.industry ?? tenant.industry} · {current?.region ?? tenant.region}
          </span>
        </span>
        <NavIcon name="updown" size={16} />
      </button>

      {open && (
        <div className="bsw-backdrop" onMouseDown={close}>
          <div
            className="bsw"
            role="dialog"
            aria-modal="true"
            aria-label="브랜드 바꾸기"
            style={{ '--bsw-top': `${anchor.top}px`, '--bsw-left': `${anchor.left}px` } as React.CSSProperties}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                close()
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
                  const need = list.filter((r) => r.p !== null && needsMeasure(r.p)).length
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
                      <span className="bsw-group-text">
                        <span className="bsw-group-name">{g.name}</span>
                        {known && need > 0 && <span className="bsw-group-need">측정 필요 {need}</span>}
                      </span>
                      {g.name === currentGroup && <span className="bsw-dot good" title="지금 브랜드가 여기 있음" />}
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
                    {g.cohorts.map((c) => (
                      <div key={c.label} className="bsw-cohort" role="presentation">
                        <p className="bsw-cohort-head">
                          <span className="bsw-cohort-label">{c.label}</span>
                          {c.list[0]?.p?.totalTenants ? <span>코호트 {Math.max(...c.list.map((r) => r.p?.totalTenants ?? 0))}곳</span> : null}
                        </p>
                        {c.list.map((r) => {
                          const isCurrent = r.tenantId === tenant.tenantId
                          return (
                            <div
                              key={r.tenantId}
                              id={`bsw-${r.tenantId}`}
                              data-id={r.tenantId}
                              role="option"
                              aria-selected={r.tenantId === activeId}
                              aria-current={isCurrent || undefined}
                              className={`bsw-row${r.tenantId === activeId ? ' on' : ''}${isCurrent ? ' current' : ''}`}
                              onMouseMove={() => r.tenantId !== activeId && setActive(r.tenantId)}
                              onClick={() => pick(r.tenantId)}
                            >
                              <span className="bsw-check" aria-hidden="true">
                                {isCurrent && (
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M5 12l5 5 9-10" />
                                  </svg>
                                )}
                              </span>
                              <span className="bsw-name">{r.brandName}</span>
                              <span className="bsw-score">{r.p?.score ?? (known ? '—' : '')}</span>
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
                    ))}
                  </div>
                ))}
                {found === 0 && <p className="bsw-note">맞는 브랜드가 없습니다. 업종 이름이나 지역으로도 찾을 수 있습니다.</p>}
              </div>
            </div>

            <div className="bsw-foot">
              <span>
                <kbd>↑↓</kbd> 이동 · <kbd>Enter</kbd> 바꾸기 · <kbd>Esc</kbd> 닫기
                {!portfolio.loaded && <span className="bsw-loading"> · 점수·상태 불러오는 중…</span>}
              </span>
              <span className="bsw-links">
                {known && (
                  <Link to="/brands" onClick={() => setOpen(false)}>
                    브랜드 현황 전체 보기 →
                  </Link>
                )}
                <Link to="/brand-onboarding" onClick={() => setOpen(false)}>
                  + 브랜드 추가
                </Link>
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
