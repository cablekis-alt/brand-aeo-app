import { readFileSync } from 'node:fs';
import { stateFilePath } from './appPaths.js';
import { writeJsonAtomic } from './tenantWriteQueue.js';

// 진행 중인 로컬 측정 추적(측정 상태 화면의 "진행 중" 표시용). 인메모리.
// measureAndBake가 브랜드마다(본 브랜드 + 코호트 경쟁사) set/clear 하고, /api/measure-status가 읽는다.

/** 수집 단계의 엔진 하나 — 화면이 남은 시간을 어림하는 재료(src/lib/measureEstimate.ts estimateFinishAt). */
export interface EngineProgress {
  done: number;
  total: number;
  /** 보내고 아직 답이 없는 호출의 보낸 시각(epoch ms, 오름차순) — 슬롯 · 분당 간격 대기가 끝난 뒤(withLlmSlot onSend). */
  inflightSentAt: number[];
  /** 이 브랜드 · 이 엔진에서 성공한 호출의 응답 시간(ms, RawCallRecord.latencyMs). 실패는 넣지 않는다. */
  latencyMs: number[];
  /** 수집 슬롯 수 · 분당 시작 상한(0 = 없음) — 모든 브랜드가 함께 쓴다(concurrency.ts collectLimit · collectRpm). */
  slots: number;
  rpm: number;
}

export interface ActiveMeasure {
  tenantId: string;
  brandName: string;
  startedAt: string; // ISO
  /**
   * 지금 무엇을 하는 중인가. 화면이 "멈춘 게 아니다"를 말할 근거다.
   * 수집·분석은 건수가 있고(done/total), 나머지 단계는 이름만 바뀐다.
   */
  stage?: '준비' | '수집' | '인용 정리' | '분석' | '집계' | '리포트';
  /** 지금 단계에 들어간 시각(epoch ms) — updateActiveMeasure가 단계가 바뀔 때 찍는다. */
  stageStartedAt?: number;
  done?: number;
  total?: number;
  /**
   * 수집 단계의 엔진별 진행. 엔진마다 속도가 크게 달라(2026-W43: OpenAI 2분 · Gemini 3분 · Perplexity 14분) 화면이 엔진마다
   * 어림한다. 끝자락에는 이미 보낸 호출의 응답만 기다리므로 속도가 아니라 「몇 초째 기다리는가」로 센다(inflightSentAt).
   */
  engines?: Record<string, EngineProgress>;
  /** 중단을 요청받아 멈추는 중이다(진행 중인 호출이 끝나기를 기다리는 동안). */
  cancelling?: boolean;
  /** 이번 측정에서 끊긴 엔진 — 「Gemini 지출 한도 초과」(engineExhaustion.ts). 남은 호출은 보내지 않는다. */
  engineIssues?: string[];
  /** 남은 엔진만으로는 수집 하한에 못 미쳐 이번 측정은 멈춘다(pipeline.ts collectRawCalls). */
  collectionWillFail?: boolean;
}

/**
 * 실패한 측정 — 측정 상태 화면의 「최근 실패」 줄. 완료 기록(localMeasureLog)은 성공만 남겨, 예전엔 실패한 측정이
 * 측정을 시작한 화면의 문구로만 보이고 사라졌다(2026-10-17 Gemini 지출 한도). 최근 것만 남기고, 같은 브랜드를 다시 재서
 * 성공하면 그 브랜드의 실패 줄은 지운다.
 *
 * 이 PC의 measure-failures.json에도 적는다 — 실패한 뒤 앱을 껐다 켜면 실패 흔적이 사라져, 지난 주 숫자로 보고서를 보내는
 * 일이 생겼다(상용화 UI 3차 U13, 결정 S2-3). 브랜드 이름 · 이유 · 시각만 담는다(키 같은 값은 담지 않는다).
 */
export interface MeasureFailure {
  tenantId: string;
  brandName: string;
  at: string; // ISO
  error: string;
  engineIssues?: string[];
  /** 그 실패가 든 측정 회차(경쟁사로 함께 잰 실패면 고객 측정의 회차). */
  runId?: string;
}

const MAX_FAILURES = 20;
const FAILURES_FILE = stateFilePath('measure-failures.json');

function loadFailures(): MeasureFailure[] {
  let text: string;
  try {
    text = readFileSync(FAILURES_FILE, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[measureTracker] measure-failures.json을 읽지 못했습니다:', err);
    return [];
  }
  try {
    const data: unknown = JSON.parse(text);
    return Array.isArray(data)
      ? (data as MeasureFailure[]).filter((f) => typeof f?.tenantId === 'string' && typeof f.error === 'string').slice(0, MAX_FAILURES)
      : [];
  } catch (err) {
    console.error('[measureTracker] measure-failures.json이 깨져 실패 기록 없이 시작합니다:', err);
    return [];
  }
}

const failures: MeasureFailure[] = loadFailures();

// 쓰기는 차례로 — 앞 쓰기가 끝나기 전에 다음 쓰기가 시작되면 옛 목록이 나중에 덮을 수 있다.
let failuresWrite: Promise<void> = Promise.resolve();
function saveFailures(): void {
  const snapshot = failures.map((f) => ({ ...f }));
  failuresWrite = failuresWrite
    .then(() => writeJsonAtomic(FAILURES_FILE, snapshot))
    .catch((err: unknown) => console.error('[measureTracker] measure-failures.json을 쓰지 못했습니다(화면의 실패 줄은 그대로):', err));
}

/** 실패 기록 파일 쓰기가 끝날 때까지 — 확인 스크립트가 파일을 읽기 전에 기다린다. */
export function flushMeasureFailures(): Promise<void> {
  return failuresWrite;
}

/** 브랜드마다 마지막 실패 하나만 남긴다 — 같은 곳을 여러 번 재다 실패해도 줄이 쌓이지 않게. */
export function recordMeasureFailure(failure: MeasureFailure): void {
  dropFailures(failure.tenantId);
  failures.unshift(failure);
  failures.splice(MAX_FAILURES);
  saveFailures();
}

export function clearMeasureFailures(tenantId: string): void {
  if (dropFailures(tenantId)) saveFailures();
}

function dropFailures(tenantId: string): boolean {
  let dropped = false;
  for (let i = failures.length - 1; i >= 0; i -= 1) {
    if (failures[i]!.tenantId === tenantId) {
      failures.splice(i, 1);
      dropped = true;
    }
  }
  return dropped;
}

export function listMeasureFailures(): MeasureFailure[] {
  return failures.map((f) => ({ ...f }));
}

/**
 * 측정 회차 기록 — 화면 아래 결과 띠와 Windows 알림의 근거다. 사용자가 시작한 측정 하나(함께 재는 경쟁사 포함)가 한 회차다 —
 * 다른 브랜드의 측정 안에서 경쟁사로 잰 것은 그 회차의 일부라 따로 적지 않는다(measureAndBake가 inCohortRun이면 부르지 않는다).
 *
 * seq는 **끝날 때** 붙인다(진행 중이면 0) — 화면은 「본 적 있는 seq보다 큰 것」만 알린다. 메모리에만 두므로 앱을 다시 켜면 비고
 * bootId가 바뀐다 — 화면은 bootId가 바뀌면 기준을 새로 잡는다.
 */
/** 함께 재다 실패한 경쟁사. keptEarlierCard면 같은 주에 앞서 잰 그 경쟁사의 카드가 순위에 그대로 들어갔다. */
export interface CompetitorFailure {
  tenantId: string;
  brandName: string;
  keptEarlierCard?: boolean;
}

export interface MeasureRunRecord {
  /** `${tenantId}@${startedAt}` */
  id: string;
  seq: number;
  tenantId: string;
  brandName: string;
  startedAt: string;
  endedAt?: string;
  /** 「이 브랜드만 측정」. */
  selfOnly?: boolean;
  /** 경쟁사(비교용 브랜드) 하나만 잰 측정. */
  competitorOnly?: boolean;
  /** 함께 재는 경쟁사 수 — 경쟁사를 고른 뒤 적는다. */
  competitors?: number;
  result?: 'done' | 'failed' | 'cancelled';
  aeoScore?: number;
  weekOf?: string;
  /** 이번 측정이 그 주 카드를 덮지 않은 까닭(pipeline.ts weekCardKeepReason). */
  weekCardKept?: string;
  error?: string;
  engineIssues?: string[];
  /** 함께 재다 실패한 경쟁사. */
  competitorFailures?: CompetitorFailure[];
}

export const BOOT_ID = `${Date.now().toString(36)}-${process.pid}`;
const MAX_RECENT_RUNS = 10;
let runSeq = 0;
const currentRuns = new Map<string, MeasureRunRecord>();
const recentRuns: MeasureRunRecord[] = [];

export function startRunRecord(start: { tenantId: string; brandName: string; selfOnly?: boolean; competitorOnly?: boolean }): MeasureRunRecord {
  const startedAt = new Date().toISOString();
  const record: MeasureRunRecord = {
    id: `${start.tenantId}@${startedAt}`,
    seq: 0,
    tenantId: start.tenantId,
    brandName: start.brandName,
    startedAt,
    ...(start.selfOnly ? { selfOnly: true } : {}),
    ...(start.competitorOnly ? { competitorOnly: true } : {}),
  };
  currentRuns.set(record.id, record);
  return { ...record };
}

/** 진행 중인 회차에 적는다(함께 재는 경쟁사 수). 이미 끝난 회차면 아무것도 하지 않는다. */
export function updateRunRecord(id: string, patch: Pick<MeasureRunRecord, 'competitors'>): void {
  const cur = currentRuns.get(id);
  if (cur) currentRuns.set(id, { ...cur, ...patch });
}

export function finishRunRecord(
  id: string,
  outcome: Pick<MeasureRunRecord, 'result' | 'aeoScore' | 'weekOf' | 'weekCardKept' | 'error' | 'engineIssues' | 'competitorFailures'>,
): MeasureRunRecord | null {
  const cur = currentRuns.get(id);
  if (!cur) return null;
  currentRuns.delete(id);
  runSeq += 1;
  const done: MeasureRunRecord = { ...cur, ...outcome, seq: runSeq, endedAt: new Date().toISOString() };
  recentRuns.unshift(done);
  recentRuns.splice(MAX_RECENT_RUNS);
  return { ...done };
}

/** 측정 상태 응답의 runs — 진행 중(시작 순)과 최근에 끝난 회차(최신 먼저, 최대 10개). */
export function listRunRecords(): { bootId: string; current: MeasureRunRecord[]; recent: MeasureRunRecord[] } {
  return {
    bootId: BOOT_ID,
    current: [...currentRuns.values()].map((r) => ({ ...r })),
    recent: recentRuns.map((r) => ({ ...r })),
  };
}

const active = new Map<string, ActiveMeasure>();

/**
 * 측정 중단 요청을 받은 테넌트. 파이프라인이 확인 지점(throwIfMeasureCancelled)에서 본다.
 *
 * 수집이 끝난 뒤의 마지막 확인 지점까지만 멈춘다. 그 뒤(분석부터)는 끝까지 마무리한다 — 이번 주 파일(원문 · 판정 · 카드)은
 * 판정 · 집계가 다 끝난 뒤에 함께 쓴다(pipeline.ts runWeeklyPipeline).
 */
const cancelRequested = new Set<string>();

/** 이 단계부터는 마지막 확인 지점을 지났다 — 중단하지 않고 마무리한다. */
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
  const stageChanged = patch.stage !== undefined && patch.stage !== cur.stage;
  active.set(tenantId, { ...cur, ...patch, ...(stageChanged ? { stageStartedAt: Date.now() } : {}) });
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
 * @returns stopping — 곧 멈출 테넌트, finishing — 마지막 확인 지점을 지나 마무리할 테넌트
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

/** 확인 지점 — 중단이 요청됐으면 던진다. 분석을 시작하기 전에만 부른다(위 cancelRequested 주석). */
export function throwIfMeasureCancelled(tenantId: string): void {
  if (cancelRequested.has(tenantId)) throw new MeasureCancelledError(tenantId);
}
