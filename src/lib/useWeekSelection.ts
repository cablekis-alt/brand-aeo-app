import { useEffect, useState } from 'react'
import type { WeeklyScorecard } from '../prompts/b8-report'

/** 스코어카드 히스토리가 로드되면 최신 주차를 기본 선택하고, 테넌트가 바뀌어 그 주차가 없어지면 다시 최신으로 되돌린다. */
export function useWeekSelection(history: WeeklyScorecard[]) {
  const [weekOf, setWeekOf] = useState('')

  useEffect(() => {
    if (history.length === 0) return
    setWeekOf((current) => (history.some((item) => item.weekOf === current) ? current : (history.at(-1)?.weekOf ?? '')))
  }, [history])

  return [weekOf, setWeekOf] as const
}
