// 진행 중인 로컬 측정 추적(측정 상태 화면의 "진행 중" 표시용). 인메모리.
// measureAndBake가 브랜드마다(본 브랜드 + 코호트 경쟁사) set/clear 하고, /api/measure-status가 읽는다.
export interface ActiveMeasure {
  tenantId: string;
  brandName: string;
  startedAt: string; // ISO
  /**
   * 지금 무엇을 하는 중인가. 화면이 "멈춘 게 아니다"를 말할 근거다.
   * 수집·분석은 건수가 있고(done/total), 나머지 단계는 이름만 바뀐다.
   */
  stage?: '준비' | '수집' | '인용 정리' | '분석' | '집계' | '리포트';
  done?: number;
  total?: number;
}

const active = new Map<string, ActiveMeasure>();

export function setActiveMeasure(m: ActiveMeasure): void {
  active.set(m.tenantId, m);
}

export function clearActiveMeasure(tenantId: string): void {
  active.delete(tenantId);
}

/**
 * 진행 상태를 덮어쓴다. 이미 끝난(clear된) 테넌트면 아무것도 하지 않는다 —
 * 늦게 도착한 갱신이 끝난 측정을 되살리면 화면이 영원히 "측정 중"이 된다.
 */
export function updateActiveMeasure(tenantId: string, patch: Partial<ActiveMeasure>): void {
  const cur = active.get(tenantId);
  if (!cur) return;
  active.set(tenantId, { ...cur, ...patch });
}

export function listActiveMeasures(): ActiveMeasure[] {
  return [...active.values()];
}
