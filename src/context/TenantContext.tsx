import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { loadTenants, type TenantSummary } from '../lib/api'
import { TenantContext } from './tenant-context'

export function TenantProvider({ children }: { children: ReactNode }) {
  const [tenants, setTenants] = useState<TenantSummary[]>([])
  const [tenantId, setTenantId] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // useCallback으로 고정한다 — 매 렌더 새 함수를 주면 이걸 의존성에 넣은 소비자 effect가
  // 계속 재구독한다(브랜드 관리 화면의 삭제 폴링이 매 렌더 타이머를 새로 건다).
  const reloadTenants = useCallback(async (): Promise<TenantSummary[]> => {
    // loadTenants는 API 미도달 시 데모 폴백을 주고, 서버가 실제로 빈 목록을 주면 []를 준다
    // (src/lib/api.ts). 그래서 빈 배열은 "브랜드 0개"로 그대로 믿어도 된다.
    const next = await loadTenants()
    setError(null)
    setTenants(next)
    // 선택된 브랜드가 목록에서 사라졌으면(삭제 등) 살아있는 첫 브랜드로 선택을 재조정한다.
    // 이걸 하지 않으면 tenantId state가 삭제된 id를 계속 들고 있어 아래 tenants[0] 폴백과
    // 어긋난다 — 화면은 첫 브랜드를 보여주는데 state는 삭제된 id라, 그 첫 브랜드를 다시
    // 고르면 select 값이 이미 같아 onChange가 나지 않아 선택이 먹지 않는다. 또 같은 id를
    // 다시 등록하면 선택이 그 브랜드로 되돌아가 버린다.
    setTenantId((current) => (next.some((item) => item.tenantId === current) ? current : (next[0]?.tenantId ?? '')))
    return next
  }, [])

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
