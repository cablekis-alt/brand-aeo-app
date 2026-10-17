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
  /** 이번 측정에서 끊긴 엔진 — 「Gemini 지출 한도 초과」(engineExhaustion.ts). 남은 호출은 보내지 않는다. */
  engineIssues?: string[];
  /** 남은 엔진만으로는 수집 하한에 못 미쳐 이번 측정은 멈춘다(pipeline.ts collectRawCalls). */
  collectionWillFail?: boolean;
}

/**
 * 실패한 측정 — 측정 상태 화면의 「실패」 줄. 완료 기록(localMeasureLog)은 성공만 남겨, 예전엔 실패한 측정이
 * 측정을 시작한 화면의 문구로만 보이고 사라졌다(2026-10-17 Gemini 지출 한도). 메모리에만 두고 최근 것만 남긴다 —
 * 앱을 다시 켜면 비고, 같은 브랜드를 다시 재서 성공하면 그 브랜드의 실패 줄은 지운다.
 */
export interface MeasureFailure {
  tenantId: string;
  brandName: string;
  at: string; // ISO
  error: string;
  engineIssues?: string[];
}

const MAX_FAILURES = 20;
const failures: MeasureFailure[] = [];

/** 브랜드마다 마지막 실패 하나만 남긴다 — 같은 곳을 여러 번 재다 실패해도 줄이 쌓이지 않게. */
export function recordMeasureFailure(failure: MeasureFailure): void {
  clearMeasureFailures(failure.tenantId);
  failures.unshift(failure);
  failures.splice(MAX_FAILURES);
}

export function clearMeasureFailures(tenantId: string): void {
  for (let i = failures.length - 1; i >= 0; i -= 1) {
    if (failures[i]!.tenantId === tenantId) failures.splice(i, 1);
  }
}

export function listMeasureFailures(): MeasureFailure[] {
  return failures.map((f) => ({ ...f }));
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
 * measureAndBake 한 번이 처음(경쟁사 고르기·질문지 준비)부터 끝(코호트 순위 재계산)까지 도는 동안을 센다.
 *
 * setActiveMeasure는 파이프라인 구간에만 걸린다 — 그 앞에서 측정할 경쟁사를 이미 골랐고, 그 뒤에 순위를 다시
 * 매긴다. 경쟁사 편집 저장·되돌리기는 이 전체 구간에 끼면 안 된다(측정은 옛 목록으로 돌고 결과는 새 목록 기준으로
 * 읽힌다). 측정 안에서 경쟁사를 또 measureAndBake로 재므로 중첩된다 — 그래서 켜짐/꺼짐이 아니라 수다.
 */
let measureRuns = 0;

export function beginMeasureRun(): void {
  measureRuns += 1;
}

export function endMeasureRun(): void {
  measureRuns = Math.max(0, measureRuns - 1);
}

/** 진행 중인 측정이 있는가 — 파이프라인 밖 구간까지 포함한다. */
export function measureInFlight(): boolean {
  return measureRuns > 0 || active.size > 0;
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
