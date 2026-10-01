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
  /** 중단을 요청받아 멈추는 중이다(진행 중인 호출이 끝나기를 기다리는 동안). */
  cancelling?: boolean;
}

const active = new Map<string, ActiveMeasure>();

/**
 * 측정 중단 요청을 받은 테넌트. 파이프라인이 확인 지점(throwIfMeasureCancelled)에서 본다.
 *
 * 원문 저장(saveRawCalls) 전까지만 멈춘다 — 그 뒤는 이번 주 파일을 차례로 새로 쓰는 중이라,
 * 끊으면 새 원문과 옛 판정이 섞인 주차가 남는다. 저장을 시작한 브랜드는 끝까지 마무리한다.
 */
const cancelRequested = new Set<string>();

/** 이 단계부터는 이번 주 파일을 새로 쓰기 시작했다 — 중단하지 않고 마무리한다. */
const SAVING_STAGES = new Set<ActiveMeasure['stage']>(['분석', '집계', '리포트']);

/** 중단 요청으로 멈춘 측정. 일반 실패와 구분해 화면에 "중단했습니다"로 알린다. */
export class MeasureCancelledError extends Error {
  readonly tenantId: string;

  constructor(tenantId: string) {
    super(`측정을 중단했습니다 (tenant=${tenantId}). 이번 주 데이터는 건드리지 않았습니다.`);
    this.name = 'MeasureCancelledError';
    this.tenantId = tenantId;
  }
}

export function setActiveMeasure(m: ActiveMeasure): void {
  // 새 측정은 앞 측정에 걸린 중단 요청을 물려받지 않는다.
  cancelRequested.delete(m.tenantId);
  active.set(m.tenantId, m);
}

export function clearActiveMeasure(tenantId: string): void {
  active.delete(tenantId);
  cancelRequested.delete(tenantId);
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

/**
 * 진행 중인 로컬 측정 전체에 중단을 요청한다.
 * @returns stopping — 곧 멈출 테넌트, finishing — 이미 저장을 시작해 마무리할 테넌트
 */
export function requestCancelActiveMeasures(): { stopping: string[]; finishing: string[] } {
  const stopping: string[] = [];
  const finishing: string[] = [];
  for (const m of active.values()) {
    if (SAVING_STAGES.has(m.stage)) {
      finishing.push(m.tenantId);
      continue;
    }
    cancelRequested.add(m.tenantId);
    active.set(m.tenantId, { ...m, cancelling: true });
    stopping.push(m.tenantId);
  }
  return { stopping, finishing };
}

/** 확인 지점 — 중단이 요청됐으면 던진다. 원문 저장 전에만 부른다(위 cancelRequested 주석). */
export function throwIfMeasureCancelled(tenantId: string): void {
  if (cancelRequested.has(tenantId)) throw new MeasureCancelledError(tenantId);
}
