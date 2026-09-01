import { useEffect, useState } from 'react'

/** tenantId·weekOf가 바뀔 때마다 다시 불러오는 범용 훅. S-02/04/06이 각자의 loader만 바꿔 재사용한다. */
export function useWeeklyData<T>(
  loader: (tenantId: string, weekOf: string) => Promise<T>,
  tenantId: string,
  weekOf: string,
  fallback: T,
) {
  const [data, setData] = useState<T>(fallback)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!tenantId || !weekOf) return
    let cancelled = false
    setLoading(true)
    loader(tenantId, weekOf)
      .then((next) => {
        if (!cancelled) setData(next)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [loader, tenantId, weekOf])

  return { data, loading }
}
