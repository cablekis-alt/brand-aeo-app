import { useEffect, useState } from 'react'
import { clearDataSource } from './dataSource'

/**
 * tenantId·weekOf가 바뀔 때마다 다시 불러오는 범용 훅. 여러 화면이 각자의 loader만 바꿔 재사용한다.
 *
 * 결과에 어느 (브랜드, 주차)의 것인지를 함께 담는다 — 그러지 않으면 브랜드를 바꾼 직후
 * 이전 브랜드의 데이터가 새 브랜드의 것처럼 잠깐 보인다.
 */
export function useWeeklyData<T>(
  loader: (tenantId: string, weekOf: string) => Promise<T>,
  tenantId: string,
  weekOf: string,
  fallback: T,
) {
  const [loaded, setLoaded] = useState<{ key: string; data: T } | null>(null)
  // 구분자는 눈에 보이는 문자로 둔다. 원래 NUL 문자(코드 0)였는데 git이 파일을 바이너리로 취급해 diff가 사라졌다.
  const key = `${tenantId}|${weekOf}`
  const enabled = Boolean(tenantId && weekOf)

  useEffect(() => {
    if (!tenantId || !weekOf) return
    // 주차·브랜드가 바뀌면 이전 요청의 데모 표시를 비운다 — 안 그러면 옛 주차의 데모 배너가
    // 새 주차(실측)에 남는다. 새 응답이 데모면 getJson이 다시 기록한다.
    clearDataSource()
    let cancelled = false
    loader(tenantId, weekOf)
      .then((data) => {
        if (!cancelled) setLoaded({ key: `${tenantId}|${weekOf}`, data })
      })
      .catch(() => {
        if (!cancelled) setLoaded({ key: `${tenantId}|${weekOf}`, data: fallback })
      })
    return () => {
      cancelled = true
    }
    // fallback은 호출부에서 리터럴로 넘기는 "빈 값"이라 의존성에 넣지 않는다(매 렌더 새 참조).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loader, tenantId, weekOf])

  const fresh = loaded !== null && loaded.key === key
  return { data: fresh ? loaded.data : fallback, loading: enabled && !fresh }
}
