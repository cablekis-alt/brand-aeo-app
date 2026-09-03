import { Outlet, useLocation } from 'react-router-dom'
import { useTenant } from '../context/useTenant'
import Sidebar from './Sidebar'

// 선택 브랜드와 무관한 관리·측정 화면 — 상단 브랜드 선택 박스를 숨긴다.
// (측정 대기열·측정 상태는 전역, 테넌트 골라 측정은 자체 선택 드롭다운, 브랜드 추가는 신규 등록)
const HIDE_BRAND_PICKER = new Set(['/brand-onboarding', '/measure-queue', '/measure-tenant', '/measure-status'])

export default function Layout() {
  const { tenants, tenant, setTenantId, loading, error } = useTenant()
  const { pathname } = useLocation()
  const showBrandPicker = Boolean(tenant) && !HIDE_BRAND_PICKER.has(pathname)

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
          {loading && !tenant && <p className="muted">불러오는 중…</p>}
        </header>
        {tenant && <Outlet />}
      </div>
    </div>
  )
}
