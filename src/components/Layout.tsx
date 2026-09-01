import { Outlet } from 'react-router-dom'
import { useTenant } from '../context/useTenant'
import Sidebar from './Sidebar'

export default function Layout() {
  const { tenants, tenant, setTenantId, loading, error } = useTenant()

  return (
    <div className="shell">
      <Sidebar />
      <div className="content">
        <header className="top">
          {tenant && (
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
