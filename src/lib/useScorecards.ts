import { useEffect, useState } from 'react'
import { loadScorecards } from './api'
import type { WeeklyScorecard } from '../prompts/b8-report'

export function useScorecards(tenantId: string) {
  const [history, setHistory] = useState<WeeklyScorecard[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!tenantId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    loadScorecards(tenantId)
      .then((next) => {
        if (!cancelled) setHistory(next)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '스코어카드를 불러오지 못했습니다.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [tenantId])

  return { history, loading, error }
}
