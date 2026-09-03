import { Outlet, useLocation } from 'react-router-dom'
import { useTenant } from '../context/useTenant'
import EmptyBrands from './EmptyBrands'
import Sidebar from './Sidebar'

// 선택 브랜드와 무관한 관리·측정 화면 — 상단 브랜드 박스를 숨기고, 브랜드 0개여도 그대로 연다
// (브랜드 추가는 첫 등록 통로, 측정 대기열·상태는 전역, 테넌트 골라 측정은 자체 드롭다운).
const MANAGEMENT_ROUTES = new Set(['/brand-onboarding', '/measure-queue', '/measure-tenant', '/measure-status'])

export default function Layout() {
  const { tenants, tenant, setTenantId, loading, error } = useTenant()
  const { pathname } = useLocation()
  const isManagement = MANAGEMENT_ROUTES.has(pathname)
  const noBrands = !loading && tenants.length === 0
  const showBrandPicker = Boolean(tenant) && !isManagement

  return (
    <div className="shell">
      <Sidebar />
      <div className="content">
        <header className="top">
          {showBrandPicker && tenant && (
            <label className="tenant-pick">
              <span>브랜드</span>
              <select value={tenant.tenantId} onChange={(e) => setTenantId(e.target.value)}>
                {tenants.map((item) => (
                  <option key={item.tenantId} value={item.tenantId}>
                    {item.brandName} · {item.industry} · {item.region}
                  </option>
                ))}
              </select>
            </label>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {loading && tenants.length === 0 && <p className="muted">불러오는 중…</p>}
        </header>

        {/* 브랜드가 0개면 분석 화면 대신 빈 상태를 보여준다(관리·측정 화면은 그대로 열림). */}
        {noBrands && !isManagement ? <EmptyBrands /> : (tenant || isManagement) && <Outlet />}
      </div>
    </div>
  )
}
