import type { ActiveMeasure } from '../components/MeasureProgress'

/**
 * 한 줄로 줄인 진행 상태 — 버튼·표 칸처럼 자리가 좁은 곳에 쓴다.
 * 건수가 없는 단계(인용 정리·집계·리포트)는 단계 이름만 낸다.
 * 컴포넌트 파일(MeasureProgress.tsx)이 함수를 함께 내보내면 빠른 새로 고침이 깨져 여기로 옮겼다.
 */
export function measureStageLabel(a: ActiveMeasure): string {
  if (a.cancelling) return '중단 중'
  const stage = a.stage ?? '준비'
  return a.total ? `${stage} ${a.done ?? 0}/${a.total}` : stage
}
