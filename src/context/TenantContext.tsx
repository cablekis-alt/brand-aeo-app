import { useEffect, useState, type ReactNode } from 'react'
import { loadTenants, type TenantSummary } from '../lib/api'
import { TenantContext } from './tenant-context'

export function TenantProvider({ children }: { children: ReactNode }) {
  const [tenants, setTenants] = useState<TenantSummary[]>([])
  const [tenantId, setTenantId] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function reloadTenants(): Promise<TenantSummary[]> {
    const next = await loadTenants()
    setTenants(next)
    return next
  }

  useEffect(() => {
    let cancelled = false
    loadTenants()
      .then((next) => {
        if (cancelled) return
        setTenants(next)
        setTenantId((current) => current || next[0]?.tenantId || '')
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '테넌트를 불러오지 못했습니다.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const tenant = tenants.find((item) => item.tenantId === tenantId) ?? tenants[0]

  return (
    <TenantContext.Provider
      value={{ tenants, tenantId: tenant?.tenantId ?? tenantId, setTenantId, tenant, loading, error, reloadTenants }}
    >
      {children}
    </TenantContext.Provider>
  )
}
