import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTenant } from '../context/useTenant'
import { loadPortfolio, type PortfolioRow } from '../lib/api'
import BrandPickerPanel, { type PickerRow } from './BrandPickerPanel'
import NavIcon from './NavIcon'

/**
 * 브랜드 바꾸기 — 사이드바 머리의 브랜드 칸과, 누르면 열리는 업종별 패널(상용화 UI 5차 시안).
 *
 * 예전에는 기본 select에 업종군 optgroup을 달았다. 브랜드가 30곳을 넘자 좁은 칸에 이름만 길게 늘어서
 * 어느 코호트에 누가 있는지, 어디를 다시 재야 하는지 보이지 않았다. 패널(BrandPickerPanel)은 왼쪽에
 * 업종군, 오른쪽에 코호트(업종 · 지역) → 브랜드를 점수·순위·상태와 함께 놓는다. 묶는 규칙은 브랜드 현황
 * 화면과 같다(lib/portfolioView). 브랜드를 고르면 보던 화면은 그대로 두고 브랜드만 바꾼다 — 브랜드 현황
 * 화면에서 고르면 개요로 가는 것과 다르다(그쪽은 훑어보다 들어가는 곳, 이쪽은 같은 화면을 브랜드만 바꿔
 * 보는 곳).
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
  const triggerRef = useRef<HTMLButtonElement>(null)

  const show = () => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) setAnchor({ top: rect.bottom + 6, left: rect.left })
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

  const rows = useMemo((): PickerRow[] => {
    const byId = new Map((portfolio.rows ?? []).map((r) => [r.tenantId, r]))
    return tenants.map((t) => {
      const p = byId.get(t.tenantId) ?? null
      // 점수 기록의 업종·지역이 실제 코호트다(영어 질문 측정은 지역에 꼬리표가 붙는다).
      return { tenantId: t.tenantId, brandName: t.brandName, industry: p?.industry ?? t.industry, region: p?.region ?? t.region, score: p?.score ?? null, p }
    })
  }, [tenants, portfolio.rows])
  const known = portfolio.rows !== null

  if (!tenant) return null
  const current = rows.find((r) => r.tenantId === tenant.tenantId) ?? null
  const initial = Array.from(tenant.brandName.trim())[0] ?? '?'

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
        <BrandPickerPanel
          rows={rows}
          currentId={tenant.tenantId}
          known={known}
          loading={!portfolio.loaded}
          anchor={anchor}
          label="브랜드 바꾸기"
          verb="바꾸기"
          cohortSize="measured"
          onPick={(id) => {
            setTenantId(id)
            close()
          }}
          onClose={close}
          links={
            <>
              {known && (
                <Link to="/brands" onClick={() => setOpen(false)}>
                  브랜드 현황 전체 보기 →
                </Link>
              )}
              <Link to="/brand-onboarding" onClick={() => setOpen(false)}>
                + 브랜드 추가
              </Link>
            </>
          }
        />
      )}
    </>
  )
}
