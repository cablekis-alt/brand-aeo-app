import { useEffect } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { clearDataSource, useDemoData } from '../lib/dataSource'
import { useTenant } from '../context/useTenant'
import EmptyBrands from './EmptyBrands'
import Sidebar from './Sidebar'

// 선택 브랜드와 무관한 관리·측정 화면 — 상단 브랜드 박스를 숨기고, 브랜드 0개여도 그대로 연다
// (브랜드 추가는 첫 등록 통로, 측정 대기열·상태는 전역, 테넌트 골라 측정은 자체 드롭다운).
const MANAGEMENT_ROUTES = new Set(['/brand-onboarding', '/measure-tenant', '/measure-status'])

export default function Layout() {
  const { tenants, tenant, setTenantId, loading, error, reloadTenants } = useTenant()
  const { pathname } = useLocation()
  const isManagement = MANAGEMENT_ROUTES.has(pathname)
  const noBrands = !loading && tenants.length === 0
  const loadingBrands = loading && tenants.length === 0
  const showBrandPicker = Boolean(tenant) && !isManagement
  // 데모 응답이 섞여 있으면 배너. 화면·브랜드가 바뀌면 이전 표시를 비운다(주차 변경은 useWeeklyData가 비운다).
  const demo = useDemoData()
  useEffect(() => {
    clearDataSource()
  }, [pathname, tenant?.tenantId])

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
              {error}{' '}
              <button type="button" className="ghost" onClick={() => void reloadTenants()}>
                다시 시도
              </button>
            </p>
          )}
        </header>

        {demo && !isManagement && (
          <p className="notice" role="status">
            <b>측정 전 예시 데이터입니다.</b> 이 브랜드·주차는 아직 측정되지 않아 화면의 숫자는 데모입니다.{' '}
            <Link to="/measure-tenant">브랜드·경쟁사 측정</Link>에서 측정하면 실제 값으로 바뀝니다.
          </p>
        )}

        {/*
          브랜드 목록을 불러오는 동안에는 화면을 비우지 않고 로딩임을 명시한다.
          이전에는 아무것도 렌더하지 않아, 목록 조회가 느리면 브랜드 드롭다운조차 없는 상태가
          되어 "눌러도 안 눌린다"로 보였다. 0개면 빈 상태, 관리·측정 화면은 브랜드와 무관하게 열린다.
        */}
        {isManagement ? (
          <Outlet />
        ) : loadingBrands ? (
          <p className="muted" style={{ marginTop: 24 }}>
            브랜드 목록을 불러오는 중…
          </p>
        ) : noBrands ? (
          <EmptyBrands />
        ) : (
          tenant && <Outlet />
        )}
      </div>
    </div>
  )
}
