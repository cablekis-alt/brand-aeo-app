import { useEffect, useState } from 'react'
import { loadRunHistory, type RunHistory } from './api'

/**
 * 측정 회차별 보기를 불러온다(server/runHistory.ts) — usePublishedHistory와 같은 규칙. available이 false면 이 환경에 기능이 없다(웹 —
 * 라우트가 없다). 읽다가 실패하면 available은 true로 두고 error에 이유를 싣는다. 브랜드 · 주 수가 바뀌면 앞 결과를 쓰지 않는다.
 */
export function useRunHistory(tenantId: string, weeks = 6) {
  const key = `${tenantId}|${weeks}`
  const [state, setState] = useState<{ key: string; value: RunHistory | null; error: string | null } | null>(null)
  useEffect(() => {
    if (!tenantId) return
    let alive = true
    const k = `${tenantId}|${weeks}`
    void loadRunHistory(tenantId, weeks).then(
      (value) => {
        if (alive) setState({ key: k, value, error: null })
      },
      (err: unknown) => {
        if (alive) setState({ key: k, value: null, error: err instanceof Error ? err.message : String(err) })
      },
    )
    return () => {
      alive = false
    }
  }, [tenantId, weeks])
  const fresh = state?.key === key ? state : null
  return {
    history: fresh?.value ?? null,
    loading: fresh === null,
    error: fresh?.error ?? null,
    /** 이 환경에서 회차 기록을 볼 수 있는가(웹은 false). 읽기 실패여도 true — 이유는 error에 있다. */
    available: fresh !== null && (fresh.value !== null || fresh.error !== null),
  }
}
