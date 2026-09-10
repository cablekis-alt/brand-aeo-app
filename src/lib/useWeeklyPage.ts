import { useScorecards } from './useScorecards'
import { useWeekSelection } from './useWeekSelection'
import { useWeeklyData } from './useWeeklyData'

/**
 * "브랜드 → 주차 → 그 주차 데이터"를 쓰는 STAGE 3·4 화면의 공통 배선.
 *
 * 세 훅을 따로 쓰면 화면마다 로딩 판정을 다시 만들어야 하고, 주차 목록이 오는 중을
 * 로딩으로 치지 않으면 브랜드를 고른 직후 "이 주차에 데이터가 없습니다"가 잠깐 떴다가
 * 값이 채워진다 — 브랜드를 골라도 "바로 안 들어가지는" 것처럼 보이는 원인이다.
 * loading은 주차 목록과 주차 데이터 중 하나라도 로딩 중이면 true다.
 */
export function useWeeklyPage<T>(
  loader: (tenantId: string, weekOf: string) => Promise<T>,
  tenantId: string,
  fallback: T,
) {
  const { history, loading: loadingHistory, error } = useScorecards(tenantId)
  const [weekOf, setWeekOf] = useWeekSelection(history)
  const { data, loading: loadingData } = useWeeklyData(loader, tenantId, weekOf, fallback)

  return {
    history,
    weeks: history.map((item) => item.weekOf),
    weekOf,
    setWeekOf,
    data,
    loading: loadingHistory || loadingData,
    /** 측정 이력이 아예 없는 브랜드 — "주차에 데이터 없음"과 구분해 안내가 달라진다. */
    neverMeasured: !loadingHistory && history.length === 0,
    error,
  }
}
