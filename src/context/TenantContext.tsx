import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { DEMO_TENANTS, fetchTenants, type TenantSummary } from '../lib/api'
import { TenantContext } from './tenant-context'

// 목록 조회는 5초에 끊고 재시도한다(최악 ~17초). 무한정 기다리면 그 동안 브랜드 선택 드롭다운이
// 화면에 아예 없어서 "눌러도 안 눌린다"로 보인다(백엔드가 재배포 중이거나 느릴 때 실제로 발생).
const ATTEMPTS = 3
const RETRY_DELAY_MS = 800

interface LoadResult {
  tenants: TenantSummary[]
  error: string | null
}

export function TenantProvider({ children }: { children: ReactNode }) {
  const [tenants, setTenants] = useState<TenantSummary[]>([])
  const [tenantId, setTenantId] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // 마지막으로 성공한 목록 — 재조회가 실패하면 이걸 유지해 선택지가 사라지지 않게 한다.
  const lastGood = useRef<TenantSummary[]>([])

  /** 타임아웃 + 재시도. setState는 하지 않는다(결과만 돌려주고 반영은 apply가 한다). */
  const fetchWithRetry = useCallback(async (): Promise<LoadResult> => {
    let lastError: unknown = null
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      try {
        return { tenants: await fetchTenants(), error: null }
      } catch (err) {
        lastError = err
        if (attempt < ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
      }
    }
    const message = lastError instanceof Error ? lastError.message : '브랜드 목록을 불러오지 못했습니다.'
    // 일시적 장애로 선택지가 사라지는 게 더 나쁘므로, 이전에 성공한 목록이 있으면 그걸 유지한다.
    return lastGood.current.length > 0
      ? { tenants: lastGood.current, error: `${message} 이전에 불러온 목록을 표시합니다.` }
      : { tenants: DEMO_TENANTS, error: `${message} 서버에 연결하지 못해 데모 브랜드를 표시합니다.` }
  }, [])

  const apply = useCallback((result: LoadResult) => {
    if (result.error === null) lastGood.current = result.tenants
    setTenants(result.tenants)
    setError(result.error)
    setLoading(false)
    // 선택된 브랜드가 목록에서 사라졌으면(삭제 등) 살아있는 첫 브랜드로 재조정한다. 이걸 하지
    // 않으면 tenantId state가 삭제된 id를 계속 들고 있어 아래 tenants[0] 폴백과 어긋난다 —
    // 화면은 첫 브랜드를 보여주는데 state는 삭제된 id라, 그 첫 브랜드를 다시 고르면 select
    // 값이 이미 같아 onChange가 나지 않아 선택이 먹지 않는다.
    setTenantId((current) =>
      result.tenants.some((item) => item.tenantId === current) ? current : (result.tenants[0]?.tenantId ?? ''),
    )
  }, [])

  const reloadTenants = useCallback(async (): Promise<TenantSummary[]> => {
    const result = await fetchWithRetry()
    apply(result)
    return result.tenants
  }, [fetchWithRetry, apply])

  useEffect(() => {
    let cancelled = false
    void fetchWithRetry().then((result) => {
      if (!cancelled) apply(result)
    })
    return () => {
      cancelled = true
    }
  }, [fetchWithRetry, apply])

  const tenant = tenants.find((item) => item.tenantId === tenantId) ?? tenants[0]

  return (
    <TenantContext.Provider
      value={{ tenants, tenantId: tenant?.tenantId ?? tenantId, setTenantId, tenant, loading, error, reloadTenants }}
    >
      {children}
    </TenantContext.Provider>
  )
}
