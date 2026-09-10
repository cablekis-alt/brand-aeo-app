import { useEffect, useState } from 'react'
import { loadScorecards } from './api'
import type { WeeklyScorecard } from '../prompts/b8-report'

interface Loaded {
  tenantId: string
  history: WeeklyScorecard[]
  error: string | null
}

/**
 * 브랜드의 주간 스코어카드 히스토리.
 *
 * 결과에 어느 브랜드의 것인지를 함께 담아, 브랜드를 바꾸면 새 결과가 오기 전까지는
 * 빈 히스토리 + loading을 준다. 이전 브랜드의 주차 목록을 그대로 넘기면 화면이
 * 잘못된 (브랜드, 주차) 조합으로 한 번 요청을 보내고 "이 주차에 데이터가 없습니다"가
 * 잠깐 떴다가 바뀐다 — 브랜드를 고른 직후 "바로 안 들어가지는" 증상의 원인이다.
 */
export function useScorecards(tenantId: string) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    if (!tenantId) return
    let cancelled = false
    loadScorecards(tenantId)
      .then((history) => {
        if (!cancelled) setLoaded({ tenantId, history, error: null })
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoaded({
            tenantId,
            history: [],
            error: err instanceof Error ? err.message : '스코어카드를 불러오지 못했습니다.',
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [tenantId])

  const fresh = loaded !== null && loaded.tenantId === tenantId
  return {
    history: fresh ? loaded.history : [],
    loading: Boolean(tenantId) && !fresh,
    error: fresh ? loaded.error : null,
  }
}
