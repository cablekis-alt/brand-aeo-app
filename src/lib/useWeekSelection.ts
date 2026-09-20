import { useState } from 'react'
import type { WeeklyScorecard } from '../prompts/b8-report'

/**
 * 주차 선택 — 사용자가 고른 주차를 기억하되, 그 주차가 현재 히스토리에 없으면(브랜드 전환·
 * 삭제 등) 최신 주차로 즉시 대체한다.
 *
 * effect로 고치면 잘못된 주차로 한 번 렌더·요청이 나간 뒤에야 바로잡히므로, 저장하지 않고
 * 렌더할 때마다 유효한 값을 계산한다. 히스토리가 아직 비었으면 ''을 주고, 화면은 그 사이
 * useScorecards의 loading을 보고 "불러오는 중"을 띄운다.
 */
export function useWeekSelection(history: WeeklyScorecard[], initial = '') {
  // 다른 화면에서 주차를 지정해 들어오는 경우(질문별 승패 → 원문 보기)를 위해 초기값을 받는다.
  // effect로 나중에 맞추면 한 번은 엉뚱한 주차로 요청이 나가므로 처음부터 그 값으로 시작한다.
  const [picked, setPicked] = useState(initial)
  const weekOf = history.some((item) => item.weekOf === picked) ? picked : (history.at(-1)?.weekOf ?? '')
  return [weekOf, setPicked] as const
}
