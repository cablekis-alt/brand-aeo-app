// 진행 중인 로컬 측정 추적(측정 상태 화면의 "진행 중" 표시용). 인메모리.
// measureAndBake가 브랜드마다(본 브랜드 + 코호트 경쟁사) set/clear 하고, /api/measure-status가 읽는다.
export interface ActiveMeasure {
  tenantId: string;
  brandName: string;
  startedAt: string; // ISO
}

const active = new Map<string, ActiveMeasure>();

export function setActiveMeasure(m: ActiveMeasure): void {
  active.set(m.tenantId, m);
}

export function clearActiveMeasure(tenantId: string): void {
  active.delete(tenantId);
}

export function listActiveMeasures(): ActiveMeasure[] {
  return [...active.values()];
}
