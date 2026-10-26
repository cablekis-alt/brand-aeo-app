import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTenant } from '../context/useTenant'
import { loadPortfolio, type PortfolioRow } from '../lib/api'
import { brandLabel, variantTag } from '../lib/brandVariant'
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
 *
 * dim — 브랜드 현황 · 측정 상태 같은 전체 브랜드 화면에서는 칸을 숨기지 않고 흐리게 「마지막으로 본 브랜드」로 둔다. 숨기면 메뉴가
 * 화면마다 오르내렸고, 사이드바 배지 · 측정 카드가 어느 브랜드 기준인지 보이지 않았다(상용화 UI 3차 U12).
 */
export default function BrandSwitcher({ dim = false }: { dim?: boolean }) {
  const { tenants, tenant, customer, viewing, setTenantId } = useTenant()
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
      return { tenantId: t.tenantId, brandName: t.brandName, industry: p?.industry ?? t.industry, region: p?.region ?? t.region, score: p?.score ?? null, p, variant: variantTag(t, tenants) }
    })
  }, [tenants, portfolio.rows])
  const known = portfolio.rows !== null

  // 브랜드 목록을 읽는 동안에도 같은 높이로 자리를 지킨다 — 칸이 늦게 나타나면 메뉴가 밀려 내려간다.
  if (!tenant) {
    return (
      <div className="brand-switch is-placeholder" aria-hidden="true">
        <span className="brand-switch-initial" />
        <span className="brand-switch-text">
          <span className="brand-switch-name">&nbsp;</span>
          <span className="brand-switch-meta">&nbsp;</span>
        </span>
      </div>
    )
  }
  const current = rows.find((r) => r.tenantId === tenant.tenantId) ?? null
  const name = viewing ? tenant.brandName : brandLabel(tenant, tenants)
  // 경쟁사 보기 중이면 브랜드 칸이 그 경쟁사를 회색으로 보인다 — 지금 누구를 보는지 헷갈리지 않게.
  const initial = viewing ? '경' : (Array.from(tenant.brandName.trim())[0] ?? '?')

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`brand-switch${open ? ' is-open' : ''}${viewing ? ' is-competitor' : ''}${dim ? ' is-dim' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={dim && !viewing ? `브랜드 바꾸기 — 마지막으로 본 브랜드 ${name}` : `브랜드 바꾸기 — 지금 ${name}`}
        // 경쟁사 보기 중에는 사이드바 측정 카드가 고른 고객 브랜드 기준이라 「이 브랜드 기준」이라고 하지 않는다.
        title={dim && !viewing ? '이 화면은 전체 브랜드 기준입니다. 사이드바의 배지와 최근 측정은 이 브랜드 기준입니다.' : undefined}
        onClick={() => (open ? close() : show())}
      >
        <span className="brand-switch-initial" aria-hidden="true">
          {initial}
        </span>
        <span className="brand-switch-text" aria-hidden="true">
          <span className="brand-switch-name">{name}</span>
          <span className="brand-switch-meta">
            {viewing
              ? '경쟁사 · 읽기 전용'
              : dim
                ? '마지막으로 본 브랜드'
                : `${current?.industry ?? tenant.industry} · ${current?.region ?? tenant.region}`}
          </span>
        </span>
        <NavIcon name="updown" size={16} />
      </button>

      {open && (
        <BrandPickerPanel
          rows={rows}
          currentId={customer?.tenantId ?? tenant.tenantId}
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
