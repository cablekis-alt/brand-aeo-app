import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  autoReasonText,
  googleSearchParams,
  INDEX_AUTO_FORMAT,
  judgeGoogle,
  planAutoTargets,
  planSearches,
  RUN_CAP_DEFAULT,
  RUN_CAP_MAX,
  type AllowanceLike,
  type AttemptLike,
  type AutoTarget,
  type AutoTier,
  type PlanLimit,
  type QueryRefusal,
} from '../src/lib/indexAuto.js';
import { addDays, type RowOrigin } from '../src/lib/publishStatus.js';
import { todayKst } from '../src/lib/publishedUrl.js';
import { stateFilePath } from './appPaths.js';
import { IndexChecksError, writeIndexCheck } from './indexChecks.js';
import { readPublishStatusSnapshot } from './publishStatus.js';
import {
  claimSerpRun,
  FEATURE_LABEL,
  scrubSerpKey,
  serpApiAccountView,
  serpApiUnavailable,
  SerpApiBudgetError,
  SerpApiError,
  serpRunElsewhere,
  serpRunHolder,
  serpSearch,
  type SerpApiAccountView,
} from './serpApi.js';
import { queueTenantWrite, writeJsonAtomic } from './tenantWriteQueue.js';
import type { TenantConfig } from './types.js';

/**
 * 색인 자동 확인 실행기 — 발행 현황의 구글 색인 칸을 SerpAPI 구글 검색(site:)으로 대신 보고 index-checks.json에 source 'auto'로 적는다(규칙:
 * src/lib/indexAuto.ts, 검색 · 몫 · 장부: server/serpApi.ts, 적기: server/indexChecks.ts writeIndexCheck).
 *
 * - 사람이 단추를 눌러야 돈다: 계획(planIndexAuto — 검색 0, 계정만 무료로 읽어 대상 · 검색 수 · 이번 결제 주기 몫을 보인다, 계획 id는 서버 메모리에
 *   10분) → 실행(startIndexAuto — 그 계획 id로만, 계획에 있던 차례만 · 계획의 검색 수까지). 「열 때 하루 한 번」 설정은 있으나 기본 끔이고, 켜도
 *   같은 계획 → 실행 길을 지난다(openRunOn으로 하루 한 번). 정해진 시각 예약은 없다.
 * - 한 번에 하나(SerpAPI 공용 실행 잠금 — 나중의 AI 개요 시범과도, 앱을 두 번 켠 두 서버 사이에도). 검색은 공용 순차 줄에서 하나씩, 결과
 *   하나마다 짧게 쓰기 줄을 잡아 적는다 — 실행 중에도 사람 표시 · 다른 저장이 막히지 않는다. 확인하는 사이 사람이 누른 칸은 덮지 않는다(CAS).
 *   다른 서버가 실행 잠금을 쥔 동안에는 이 서버가 기록 파일을 고치지 않는다(설정 저장 409, 그쪽 pending을 닫지 않는다) — 두 프로세스가 같은 파일을
 *   읽고 다시 쓰면 한쪽 시도가 사라진다. 실행 기록은 글 하나가 끝날 때마다 함께 적는다(끊겨도 어디까지 했는지 남는다).
 * - 멈춤: 키(401) · 권한(403) · 결제 주기 소진 · 시간당 한도(429) · 요청 거절(400) · 계정 · 장부 · 몫 · 바닥에서 바로, 시간 초과 · 응답 오류가 3번
 *   잇따르면. 시간 초과는 다시 보내지 않는다(이미 과금됐을 수 있다).
 * - 기록(stateFilePath('index-auto.json'), 앱 전체에 하나): 설정 · 시도 · 실행. 부르기 직전에 시도를 pending으로 적고 응답 뒤 고친다 — 앱이
 *   꺼져 남은 pending은 다음에 읽을 때 interrupted(일시 — 차례 몫 1회)로 닫는다. 형식 · 설정만 엄격하다(틀리면 500, 덮어쓰지 않음). 시도 · 실행의
 *   모르는 값 · 칸은 그대로 읽고 다시 쓸 때도 남긴다(나중 판을 되돌려도 멈추지 않게). 키 · 계정 이메일 · id는 담지 않고, 검색어(공개된 글
 *   주소)만 남긴다.
 * - 웹(Vercel)에는 라우트가 없다(함수 12/12) — 화면은 404를 「이 환경에는 없음」으로 읽는다.
 */

const FILE = stateFilePath('index-auto.json');
const LOCK = 'index-auto/*';
const PLAN_TTL_MS = 10 * 60_000;
const ATTEMPTS_KEPT_DAYS = 120;
const ATTEMPTS_KEPT = 3000;
const RUNS_KEPT = 30;
/** 시간 초과 · 응답 오류가 이만큼 잇따르면 멈춘다. */
const STREAK_STOP = 3;

const BROKEN = '자동 확인 기록 파일(index-auto.json)이 깨져 있어 시작하지 않았어요.';
const PLAN_CHANGED = '계획이 바뀌었어요 — 계획을 다시 받아 주세요.';
const BUSY = '이미 구글 자동 확인이 도는 중이에요 — 끝난 뒤 다시 눌러 주세요.';
const BUSY_ELSEWHERE = '이 PC에서 앱이 한 번 더 켜져 있고, 그쪽에서 SerpAPI 작업(구글 자동 확인 등)이 도는 중이에요 — 끝난 뒤 다시 눌러 주세요.';
const OPEN_OFF = '「발행 현황을 열 때 하루 한 번 자동으로」가 꺼져 있어요.';
const OPEN_DONE = '오늘은 이미 열 때 자동 확인을 했어요.';
const STREAK_MESSAGE = 'SerpAPI가 잇따라 답하지 않거나 오류를 내 멈췄어요 — 잠시 뒤 다시 눌러 주세요.';
const LIMIT_MESSAGE: Record<PlanLimit, string> = {
  'run-cap': PLAN_CHANGED,
  'feature-cap': '이번 결제 주기 색인 몫을 다 써서 시작하지 않았어요.',
  floor: '계정에 남은 검색이 바닥 아래라 시작하지 않았어요.',
  hour: '이번 시간 검색 한도에 닿아 시작하지 않았어요 — 한 시간쯤 뒤 다시 눌러 주세요.',
  account: 'SerpAPI 계정 상태로는 검색할 수 없어 시작하지 않았어요.',
};

/** 409의 까닭 — 화면이 글자 대신 이것으로 할 일을 고른다(계획을 새로 받기 · 진행으로 넘어가기). */
export type IndexAutoErrorCode = 'plan-changed' | 'busy' | 'busy-elsewhere' | 'open-off' | 'open-done' | 'limit';

/** 라우트가 그대로 상태 코드로 쓰는 오류. */
export class IndexAutoError extends Error {
  readonly status: number;
  readonly code: IndexAutoErrorCode | null;
  constructor(message: string, status: number, code: IndexAutoErrorCode | null = null) {
    super(message);
    this.name = 'IndexAutoError';
    this.status = status;
    this.code = code;
  }
}

export type IndexAutoTrigger = 'button' | 'open';

export interface IndexAutoSettings {
  /** 한 번에 검색할 글 수 상한(1~200). */
  runCap: number;
  /** 발행 현황을 열 때 하루 한 번 자동으로(기본 끔). */
  autoOnOpen: boolean;
}

/** 시도 한 건 — 모르는 칸은 그대로 둔다. outcome: pending · found · not-found · unknown · not-sent(우리 쪽에서 보내지 않음). */
export interface AttemptRecord extends AttemptLike {
  [extra: string]: unknown;
  id: string;
  at: string;
  on: string;
  runId: string;
  engine: 'google';
  tier?: AutoTier;
  query?: string;
  results?: number;
  matched?: string;
  organicState?: string;
  wrote?: 'shown' | 'not-yet';
  skipped?: string;
}

export interface IndexAutoRunItem {
  key: string;
  tenantId: string;
  postId: string;
  rowName: string;
  tier: AutoTier;
  outcome: 'found' | 'not-found' | 'unknown';
  reason?: string;
  matched?: string;
  wrote?: 'shown' | 'not-yet';
  skipped?: string;
}

export interface IndexAutoStop {
  kind: string;
  message: string;
}

export interface IndexAutoRunRecord {
  runId: string;
  trigger: IndexAutoTrigger;
  startedAt: string;
  /** null이면 끝나지 않았다(도는 중이거나, 앱이 꺼져 끊김). */
  endedAt: string | null;
  planned: number;
  /** 보낸 검색 수(오류 · 시간 초과 포함). */
  searched: number;
  found: number;
  notFound: number;
  unknown: number;
  /** 찾음 · 못 찾음인데 적지 않은 수(사이에 누름 · 이미 색인됨 · 줄이 빠짐). */
  skipped: number;
  /** 계획했지만 보내지 않은 수(멈춤 · 몫). */
  notRun: number;
  stoppedBy: IndexAutoStop | null;
  items: IndexAutoRunItem[];
}

export interface IndexAutoAttemptView {
  at: string;
  on: string;
  turn: string;
  outcome: string;
  reason?: string;
  matched?: string;
  wrote?: string;
  skipped?: string;
}

export interface IndexAutoStatusView {
  /** 이 PC에 SerpAPI 키가 있는가. */
  configured: boolean;
  /** 연결 주소 설정이 틀렸으면 그 까닭(그러면 시작하지 않는다). */
  configError: string | null;
  settings: IndexAutoSettings;
  running: { runId: string; trigger: IndexAutoTrigger; startedAt: string; total: number; done: number } | null;
  lastRun: IndexAutoRunRecord | null;
  /** 주소 키마다 최근 자동 시도(새것부터 3건까지). */
  attemptsByKey: Record<string, IndexAutoAttemptView[]>;
  /** 오늘 「열 때 자동」을 이미 했다. */
  openRunToday: boolean;
  /** 앱을 두 번 켠 다른 서버가 SerpAPI 실행을 쥐고 있으면 그 안내(그동안 이 서버는 시작하지 않는다). */
  busyElsewhere: string | null;
}

export interface IndexAutoTargetView {
  key: string;
  tenantId: string;
  postId: string;
  origin: RowOrigin;
  rowName: string;
  tier: AutoTier;
  turn: string;
  since: string;
  batch: 'first' | 'retry';
  query: string;
}

/** 이번 결제 주기 색인 몫 · 계정 숫자(어림 — 계정 값 − 그 뒤 이 PC가 보낸 수). */
export interface IndexAutoQuotaView {
  cycle: string;
  cap: number;
  used: number;
  featureLeft: number;
  floor: number;
  accountLeft: number;
  aboveFloor: number;
  hourLeft: number;
  allowed: number;
  planName: string | null;
  searchesPerMonth: number | null;
  rateLimitPerHour: number | null;
}

export interface IndexAutoPlanView {
  /** 실행에 넘길 계획 id(10분) — 검색할 수가 0이면 null. */
  planId: string | null;
  expiresAt: string | null;
  trigger: IndexAutoTrigger;
  today: string;
  /** 오늘 자동으로 볼 주소 수(몫 · 상한 전). */
  candidates: number;
  /** 이번에 검색할 수 — targets의 앞에서부터 이만큼. */
  searches: number;
  limitedBy: PlanLimit | null;
  /** 계정 · 장부를 못 읽었거나 계정 상태로는 검색하지 않는 까닭(그러면 0). */
  blocked: string | null;
  targets: IndexAutoTargetView[];
  manual: number;
  unsupported: { key: string; rowName: string; reason: QueryRefusal; text: string }[];
  settled: number;
  quota: IndexAutoQuotaView | null;
  settings: IndexAutoSettings;
}

// ── 기록 파일 ─────────────────────────────────────────────────────────────────

interface IndexAutoFile {
  [extra: string]: unknown;
  format: typeof INDEX_AUTO_FORMAT;
  settings: IndexAutoSettings & Record<string, unknown>;
  attempts: unknown[];
  runs: unknown[];
  openRunOn?: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const validRunCap = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= RUN_CAP_MAX;

const defaultFile = (): IndexAutoFile => ({
  format: INDEX_AUTO_FORMAT,
  settings: { runCap: RUN_CAP_DEFAULT, autoOnOpen: false },
  attempts: [],
  runs: [],
  openRunOn: null,
});

/** 형식 · 설정 · 두 목록이 배열인지만 엄격하다. 틀리면 throw(시작하지 않고 덮어쓰지 않는다). */
function parseFile(raw: unknown): IndexAutoFile {
  if (!isRecord(raw) || raw.format !== INDEX_AUTO_FORMAT) throw new Error('format');
  const settings = raw.settings;
  if (!isRecord(settings) || !validRunCap(settings.runCap) || typeof settings.autoOnOpen !== 'boolean') throw new Error('settings');
  const attempts = raw.attempts ?? [];
  const runs = raw.runs ?? [];
  if (!Array.isArray(attempts) || !Array.isArray(runs)) throw new Error('lists');
  return { ...raw, format: INDEX_AUTO_FORMAT, settings: settings as IndexAutoFile['settings'], attempts, runs };
}

const attemptOf = (v: unknown): AttemptRecord | null =>
  isRecord(v) && typeof v.key === 'string' && typeof v.turn === 'string' && typeof v.outcome === 'string' ? (v as AttemptRecord) : null;

const settingsOf = (file: IndexAutoFile): IndexAutoSettings => ({ runCap: file.settings.runCap, autoOnOpen: file.settings.autoOnOpen });

/** 지금 도는 실행(이 프로세스). */
interface ActiveRun {
  runId: string;
  trigger: IndexAutoTrigger;
  startedAt: string;
  total: number;
  done: number;
}
let active: ActiveRun | null = null;

/**
 * 줄 안에서 읽는다. 없으면 기본값, 깨졌으면 500. tidy면 끊긴 실행의 pending은 interrupted로 닫고, 오래된 시도 · 실행은 덜어 낸다(dirty) — 다른
 * 서버가 실행 잠금을 쥔 동안에는 그쪽 pending일 수 있으니 부르는 쪽이 tidy를 끈다.
 */
async function loadInLock(tidy = true): Promise<{ file: IndexAutoFile; dirty: boolean }> {
  let text: string | null = null;
  try {
    text = await readFile(FILE, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw new IndexAutoError(`${BROKEN}(${code ?? '읽기 오류'})`, 500);
  }
  if (text === null) return { file: defaultFile(), dirty: false };
  let file: IndexAutoFile;
  try {
    file = parseFile(JSON.parse(text));
  } catch {
    throw new IndexAutoError(BROKEN, 500);
  }
  if (!tidy) return { file, dirty: false };
  let dirty = false;
  for (const a of file.attempts) {
    if (isRecord(a) && a.outcome === 'pending' && a.runId !== active?.runId) {
      a.outcome = 'unknown';
      a.reason = 'interrupted';
      dirty = true;
    }
  }
  const cutoff = addDays(todayKst(), -ATTEMPTS_KEPT_DAYS);
  const kept = file.attempts.filter((a) => !(isRecord(a) && typeof a.on === 'string' && a.on < cutoff)).slice(-ATTEMPTS_KEPT);
  if (kept.length !== file.attempts.length) {
    file.attempts = kept;
    dirty = true;
  }
  if (file.runs.length > RUNS_KEPT) {
    file.runs = file.runs.slice(-RUNS_KEPT);
    dirty = true;
  }
  return { file, dirty };
}

/** 앱을 두 번 켠 다른 서버가 SerpAPI 실행을 쥐고 있는가(그 서버가 이 파일을 고치는 중일 수 있다). */
async function heldElsewhere(): Promise<boolean> {
  try {
    return (await serpRunElsewhere()) !== null;
  } catch (err) {
    // 잠금 파일을 못 읽으면 누가 쥐었는지 모른다 — 남의 것으로 보고 고치지 않는다(막힌 쪽).
    console.warn('[indexAuto] SerpAPI 실행 잠금을 읽지 못했습니다 — 다른 서버가 쥔 것으로 봅니다:', err instanceof Error ? err.message : String(err));
    return true;
  }
}

/** 읽기 — 다른 서버가 실행 잠금을 쥔 동안에는 닫기 · 덜어 내기 없이 읽기만 한다(다시 쓰면 그쪽 시도가 사라질 수 있다). */
function readState(): Promise<{ file: IndexAutoFile; elsewhere: boolean }> {
  return queueTenantWrite(LOCK, async () => {
    const elsewhere = await heldElsewhere();
    const { file, dirty } = await loadInLock(!elsewhere);
    if (dirty) await writeJsonAtomic(FILE, file);
    return { file, elsewhere };
  });
}

/** 고치기 — 다른 서버가 실행 잠금을 쥔 동안에는 409(이 서버가 실행을 쥐었으면 그쪽은 쥘 수 없다). */
function updateState<T>(fn: (file: IndexAutoFile) => T): Promise<T> {
  return queueTenantWrite(LOCK, async () => {
    if (await heldElsewhere()) throw new IndexAutoError(BUSY_ELSEWHERE, 409, 'busy-elsewhere');
    const { file } = await loadInLock();
    const out = fn(file);
    await writeJsonAtomic(FILE, file);
    return out;
  });
}

// ── 상태 ─────────────────────────────────────────────────────────────────────

function attemptView(a: AttemptRecord): IndexAutoAttemptView {
  return {
    at: typeof a.at === 'string' ? a.at : '',
    on: typeof a.on === 'string' ? a.on : '',
    turn: a.turn,
    outcome: a.outcome,
    ...(typeof a.reason === 'string' ? { reason: a.reason } : {}),
    ...(typeof a.matched === 'string' ? { matched: a.matched } : {}),
    ...(typeof a.wrote === 'string' ? { wrote: a.wrote } : {}),
    ...(typeof a.skipped === 'string' ? { skipped: a.skipped } : {}),
  };
}

const lastRunOf = (file: IndexAutoFile): IndexAutoRunRecord | null => {
  const run = file.runs.at(-1);
  return isRecord(run) && typeof run.runId === 'string' ? (run as unknown as IndexAutoRunRecord) : null;
};

/** 화면이 2초마다 묻는 상태 — 계정은 부르지 않는다(검색 · 비용 0). 기록 파일이 깨졌으면 500. */
export async function indexAutoStatus(): Promise<IndexAutoStatusView> {
  const { file, elsewhere } = await readState();
  const off = serpApiUnavailable();
  const byKey = new Map<string, IndexAutoAttemptView[]>();
  for (let i = file.attempts.length - 1; i >= 0; i -= 1) {
    const a = attemptOf(file.attempts[i]);
    if (!a) continue;
    const list = byKey.get(a.key) ?? [];
    if (list.length < 3) byKey.set(a.key, [...list, attemptView(a)]);
  }
  return {
    configured: off?.kind !== 'no-key',
    configError: off?.kind === 'config' ? off.message : null,
    settings: settingsOf(file),
    running: active ? { ...active } : null,
    lastRun: lastRunOf(file),
    attemptsByKey: Object.fromEntries(byKey),
    openRunToday: file.openRunOn === todayKst(),
    busyElsewhere: elsewhere && !active ? BUSY_ELSEWHERE : null,
  };
}

// ── 계획 ─────────────────────────────────────────────────────────────────────

interface StoredPlan {
  trigger: IndexAutoTrigger;
  expires: number;
  /** 실행해도 되는 차례(주소 키 + 차례 id). */
  turns: Set<string>;
  searches: number;
}
const plans = new Map<string, StoredPlan>();
const turnIdOf = (t: { key: string; turn: string }) => `${t.key}\n${t.turn}`;

function bodyOf(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(body)) throw new IndexAutoError('본문은 JSON 객체여야 해요.', 400);
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length > 0) throw new IndexAutoError(`받지 않는 칸이 있어요: ${extra.join(', ')}`, 400);
  return body;
}

function unavailableError(): IndexAutoError | null {
  const off = serpApiUnavailable();
  return off ? new IndexAutoError(off.message, 503) : null;
}

/** 이 서버 · 앱을 두 번 켠 다른 서버에서 SerpAPI 실행이 도는 중이면 409. */
async function busyError(): Promise<IndexAutoError | null> {
  const holder = serpRunHolder();
  if (active || holder === 'index') return new IndexAutoError(BUSY, 409, 'busy');
  if (holder) return new IndexAutoError(`다른 SerpAPI 작업(${FEATURE_LABEL[holder]})이 도는 중이에요 — 끝난 뒤 다시 눌러 주세요.`, 409, 'busy');
  return (await heldElsewhere()) ? new IndexAutoError(BUSY_ELSEWHERE, 409, 'busy-elsewhere') : null;
}

/** 대상 — 발행 현황과 원본 확인 기록을 같은 순간에 읽고(CAS 기준값), 시도 기록으로 차례 규칙을 건다. */
async function targetsNow(tenants: TenantConfig[], file: IndexAutoFile) {
  const { status, checks } = await readPublishStatusSnapshot(tenants);
  const attempts = file.attempts.flatMap((a) => {
    const r = attemptOf(a);
    return r ? [r] : [];
  });
  const tenantOrder = tenants.filter((t) => !t.cohortOnly).map((t) => t.tenantId);
  return { today: status.today, plan: planAutoTargets({ rows: status.rows, today: status.today, checks, attempts, tenantOrder }) };
}

/** 계정 보기 → 몫. 계정 · 장부를 못 읽었거나 계정이 막으면 allowance null(검색 0)과 그 까닭. */
function quotaOf(view: SerpApiAccountView): { allowance: AllowanceLike | null; quota: IndexAutoQuotaView | null; blocked: string | null } {
  const blocked = view.configError ?? view.accountError?.message ?? view.usageError ?? (view.usage ? null : 'SerpAPI 계정 · 사용 기록을 읽지 못해 시작하지 않았어요.');
  if (!view.usage || !view.account) return { allowance: null, quota: null, blocked };
  const f = view.usage.features.index;
  const quota: IndexAutoQuotaView = {
    cycle: view.usage.cycle,
    cap: f.cap,
    used: f.sent,
    featureLeft: f.left,
    floor: view.usage.floor,
    accountLeft: view.usage.accountLeft,
    aboveFloor: view.usage.aboveFloor,
    hourLeft: view.usage.hourLeft,
    allowed: f.allowed,
    planName: view.account.planName,
    searchesPerMonth: view.account.searchesPerMonth,
    rateLimitPerHour: view.account.rateLimitPerHour,
  };
  const allowance = { featureLeft: f.left, aboveFloor: view.usage.aboveFloor, hourLeft: view.usage.hourLeft, allowed: f.allowed };
  return { allowance: blocked ? null : allowance, quota, blocked };
}

/**
 * 계획 — 오늘 자동으로 볼 글 · 이번에 검색할 수 · 이번 결제 주기 색인 몫 · 계정 남은 검색. 검색은 하지 않는다(계정 account.json만 새로 읽는다 —
 * 무료). 검색할 수가 있으면 계획 id(10분)를 준다. 본문은 { trigger: 'button' | 'open' }만.
 */
export async function planIndexAuto(tenants: TenantConfig[], body: unknown): Promise<IndexAutoPlanView> {
  const input = bodyOf(body, ['trigger']);
  if (input.trigger !== 'button' && input.trigger !== 'open') throw new IndexAutoError('trigger는 button · open 가운데 하나여야 해요.', 400);
  const trigger: IndexAutoTrigger = input.trigger;
  const off = unavailableError();
  if (off) throw off;
  const busy = await busyError();
  if (busy) throw busy;
  const { file } = await readState();
  const settings = settingsOf(file);
  if (trigger === 'open') {
    if (!settings.autoOnOpen) throw new IndexAutoError(OPEN_OFF, 409, 'open-off');
    if (file.openRunOn === todayKst()) throw new IndexAutoError(OPEN_DONE, 409, 'open-done');
  }
  const { today, plan } = await targetsNow(tenants, file);
  const { allowance, quota, blocked } = quotaOf(await serpApiAccountView({ fresh: true }));
  const { searches, limitedBy } = planSearches(plan.targets.length, settings.runCap, allowance);
  const now = Date.now();
  for (const [id, p] of plans) if (p.expires < now) plans.delete(id);
  let planId: string | null = null;
  if (searches > 0) {
    planId = `plan-${randomUUID()}`;
    plans.set(planId, { trigger, expires: now + PLAN_TTL_MS, turns: new Set(plan.targets.slice(0, searches).map(turnIdOf)), searches });
  }
  return {
    planId,
    expiresAt: planId ? new Date(now + PLAN_TTL_MS).toISOString() : null,
    trigger,
    today,
    candidates: plan.targets.length,
    searches,
    limitedBy,
    blocked,
    targets: plan.targets.map((t) => ({
      key: t.key,
      tenantId: t.tenantId,
      postId: t.postId,
      origin: t.origin,
      rowName: t.rowName,
      tier: t.tier,
      turn: t.turn,
      since: t.since,
      batch: t.batch,
      query: t.query,
    })),
    manual: plan.manual,
    unsupported: plan.unsupported.map((u) => ({ ...u, text: autoReasonText(u.reason) })),
    settled: plan.settled,
    quota,
    settings,
  };
}

// ── 실행 ─────────────────────────────────────────────────────────────────────

/**
 * 실행 — 계획 id로만(본문 { planId }만). 계정을 새로 읽고(못 읽으면 502) 대상을 다시 셈해, 계획에 있던 차례만 · 계획의 검색 수까지 · 지금 몫
 * 안에서 돈다. 202로 바로 돌려주고 뒤에서 하나씩 검색한다(진행은 indexAutoStatus). 키 없음 · 연결 설정 틀림 503, 도는 중 409, 계획 id가 없거나
 * 지났거나 대상이 바뀌어 남은 것이 없으면 409.
 */
export async function startIndexAuto(tenants: TenantConfig[], body: unknown): Promise<{ runId: string; total: number }> {
  const input = bodyOf(body, ['planId']);
  if (typeof input.planId !== 'string' || !input.planId) throw new IndexAutoError('planId가 필요해요 — 계획을 먼저 받아 주세요.', 400);
  const off = unavailableError();
  if (off) throw off;
  const busy = await busyError();
  if (busy) throw busy;
  const stored = plans.get(input.planId);
  plans.delete(input.planId);
  if (!stored || stored.expires < Date.now()) throw new IndexAutoError(PLAN_CHANGED, 409, 'plan-changed');
  // 실행 잠금 — 이 서버 안에서도, 앱을 두 번 켠 다른 서버와도 하나만. 잡은 뒤에 기록 파일을 다시 읽어 「열 때 하루 한 번」을 다시 본다.
  const release = await claimSerpRun('index');
  if (!release) throw (await busyError()) ?? new IndexAutoError(BUSY_ELSEWHERE, 409, 'busy-elsewhere');
  const run: ActiveRun = { runId: `r-${randomUUID()}`, trigger: stored.trigger, startedAt: new Date().toISOString(), total: 0, done: 0 };
  active = run;
  let targets: AutoTarget[];
  try {
    const { file } = await readState();
    const settings = settingsOf(file);
    const today = todayKst();
    if (stored.trigger === 'open' && (!settings.autoOnOpen || file.openRunOn === today)) {
      throw settings.autoOnOpen ? new IndexAutoError(OPEN_DONE, 409, 'open-done') : new IndexAutoError(OPEN_OFF, 409, 'open-off');
    }
    const { allowance, blocked } = quotaOf(await serpApiAccountView({ fresh: true }));
    if (blocked) throw new IndexAutoError(blocked, 502);
    const { plan } = await targetsNow(tenants, file);
    const selected = plan.targets.filter((t) => stored.turns.has(turnIdOf(t)));
    if (selected.length === 0) throw new IndexAutoError(PLAN_CHANGED, 409, 'plan-changed');
    const { searches, limitedBy } = planSearches(selected.length, Math.min(settings.runCap, stored.searches), allowance);
    if (searches === 0) throw new IndexAutoError(LIMIT_MESSAGE[limitedBy ?? 'run-cap'], 409, limitedBy === 'run-cap' || limitedBy === null ? 'plan-changed' : 'limit');
    targets = selected.slice(0, searches);
    run.total = targets.length;
    await updateState((f) => {
      const record: IndexAutoRunRecord = {
        runId: run.runId,
        trigger: run.trigger,
        startedAt: run.startedAt,
        endedAt: null,
        planned: targets.length,
        searched: 0,
        found: 0,
        notFound: 0,
        unknown: 0,
        skipped: 0,
        notRun: 0,
        stoppedBy: null,
        items: [],
      };
      f.runs.push(record);
      if (run.trigger === 'open') f.openRunOn = today;
    });
  } catch (err) {
    active = null;
    await release();
    throw err;
  }
  plans.clear();
  void runLoop(run, targets, tenants).finally(async () => {
    active = null;
    await release();
  });
  return { runId: run.runId, total: run.total };
}

interface Step {
  /** 요청이 나갔다(장부에 셌다). */
  sent: boolean;
  item: IndexAutoRunItem | null;
  stop: IndexAutoStop | null;
  /** 잇따름을 세는 일시 오류(시간 초과 · 응답 오류). */
  streak: boolean;
}

/** 검색 오류 → 시도 결과. 우리 쪽에서 막힌 것(몫 · 계정 · 장부 · 설정 · 요청 모양)은 보내지 않은 것이다. 앱 오류는 그대로 올린다. */
function failureOf(err: unknown): { sent: boolean; reason: string; stop: IndexAutoStop | null; streak: boolean } {
  if (err instanceof SerpApiBudgetError) return { sent: false, reason: err.kind, stop: { kind: err.kind, message: err.message }, streak: false };
  if (!(err instanceof SerpApiError)) throw err;
  if (err.kind === 'timeout' || err.kind === 'upstream') return { sent: true, reason: err.kind, stop: null, streak: true };
  const preSend = err.kind === 'no-key' || err.kind === 'config' || err.kind === 'account' || err.kind === 'ledger' || (err.kind === 'bad-request' && err.httpStatus === null);
  return { sent: !preSend, reason: err.kind, stop: { kind: err.kind, message: scrubSerpKey(err.message) }, streak: false };
}

/** 자동 결과 적기 — 사람 표시가 먼저(CAS · 원본 「색인됨」은 건너뜀). 줄이 빠졌으면 row-gone, 파일을 못 쓰면 실행을 멈춘다. */
async function writeAuto(
  t: AutoTarget,
  state: 'shown' | 'not-yet',
  customers: readonly string[],
): Promise<{ wrote: 'shown' | 'not-yet' } | { skipped: string } | { stop: IndexAutoStop }> {
  try {
    const others = customers.filter((id) => id !== t.tenantId);
    const r = await writeIndexCheck(t.tenantId, t.postId, 'google', state, others, Date.now(), 'auto', { expectRawCheckedAt: t.expectRawCheckedAt });
    return 'skipped' in r ? { skipped: r.skipped } : { wrote: state };
  } catch (err) {
    if (err instanceof IndexChecksError && (err.status === 404 || err.status === 409)) return { skipped: 'row-gone' };
    console.error('[indexAuto] 색인 확인을 적지 못해 멈춥니다:', err);
    return { stop: { kind: 'write', message: `색인 확인 파일을 적지 못해 멈췄어요 — ${err instanceof Error ? err.message : String(err)}` } };
  }
}

/** 글 하나 — 시도를 pending으로 적고 → 검색 → 판정 → 적기. 시도 고치기는 부르는 쪽이 실행 기록과 한 번에 적는다(patch). */
async function checkOne(runId: string, t: AutoTarget, customers: readonly string[]): Promise<{ step: Step; attemptId: string; patch: Partial<AttemptRecord> }> {
  const id = `a-${randomUUID()}`;
  const now = Date.now();
  const pending: AttemptRecord = { id, at: new Date(now).toISOString(), on: todayKst(now), runId, engine: 'google', key: t.key, turn: t.turn, tier: t.tier, query: t.query, outcome: 'pending' };
  await updateState((f) => {
    f.attempts.push(pending);
  });
  const base = { key: t.key, tenantId: t.tenantId, postId: t.postId, rowName: t.rowName, tier: t.tier };
  let patch: Partial<AttemptRecord>;
  let step: Step;
  try {
    const { json } = await serpSearch('index', googleSearchParams(t.query));
    const j = judgeGoogle(t.key, t.platform, json);
    const evidence = {
      ...(j.results !== null ? { results: j.results } : {}),
      ...(j.organicState !== null ? { organicState: j.organicState } : {}),
      ...('matched' in j && j.matched ? { matched: j.matched } : {}),
    };
    if (j.outcome === 'unknown') {
      patch = { outcome: 'unknown', reason: j.reason, ...evidence };
      step = { sent: true, item: { ...base, outcome: 'unknown', reason: j.reason, ...(evidence.matched ? { matched: evidence.matched } : {}) }, stop: null, streak: j.reason === 'upstream' };
    } else {
      const w = await writeAuto(t, j.outcome === 'found' ? 'shown' : 'not-yet', customers);
      if ('stop' in w) {
        patch = { outcome: 'unknown', reason: 'write', ...evidence };
        step = { sent: true, item: { ...base, outcome: 'unknown', reason: 'write' }, stop: w.stop, streak: false };
      } else {
        patch = { outcome: j.outcome, ...evidence, ...w };
        step = { sent: true, item: { ...base, outcome: j.outcome, ...(evidence.matched ? { matched: evidence.matched } : {}), ...w }, stop: null, streak: false };
      }
    }
  } catch (err) {
    const f = failureOf(err);
    patch = { outcome: f.sent ? 'unknown' : 'not-sent', reason: f.reason };
    step = { sent: f.sent, item: f.sent ? { ...base, outcome: 'unknown', reason: f.reason } : null, stop: f.stop, streak: f.streak };
  }
  return { step, attemptId: id, patch };
}

/** 실행 기록(runs)에서 이 실행을 찾아 고친다 — 없으면(덜어 냄 · 손으로 지움) 붙인다. */
function putRun(f: IndexAutoFile, runId: string, patch: Partial<IndexAutoRunRecord>, whole: () => IndexAutoRunRecord): void {
  const i = f.runs.findIndex((r) => isRecord(r) && r.runId === runId);
  if (i >= 0) f.runs[i] = { ...(f.runs[i] as Record<string, unknown>), ...patch };
  else f.runs.push(whole());
}

/**
 * 실행 — 차례대로 하나씩. 글 하나가 끝날 때마다 시도와 실행 기록(보낸 수 · 결과 · 줄마다)을 한 번에 적는다 — 앱이 꺼져 끊겨도 어디까지 했는지
 * 남는다(endedAt null). 멈춤 까닭이 나오면 거기서 멈추고, 끝나면 실행 기록을 마무리한다.
 */
async function runLoop(run: ActiveRun, targets: readonly AutoTarget[], tenants: TenantConfig[]): Promise<void> {
  const customers = tenants.filter((t) => !t.cohortOnly).map((t) => t.tenantId);
  const tally = { searched: 0, found: 0, notFound: 0, unknown: 0, skipped: 0 };
  const items: IndexAutoRunItem[] = [];
  let stoppedBy: IndexAutoStop | null = null;
  let streak = 0;
  const recordOf = (endedAt: string | null, notRun: number): IndexAutoRunRecord => ({
    runId: run.runId,
    trigger: run.trigger,
    startedAt: run.startedAt,
    endedAt,
    planned: targets.length,
    ...tally,
    notRun,
    stoppedBy,
    items: [...items],
  });
  try {
    for (const t of targets) {
      const { step, attemptId, patch } = await checkOne(run.runId, t, customers);
      if (step.sent) tally.searched += 1;
      if (step.item) {
        items.push(step.item);
        if (step.item.outcome === 'found') tally.found += 1;
        else if (step.item.outcome === 'not-found') tally.notFound += 1;
        else tally.unknown += 1;
        if (step.item.skipped) tally.skipped += 1;
      }
      await updateState((f) => {
        const i = f.attempts.findIndex((a) => isRecord(a) && a.id === attemptId);
        if (i >= 0) f.attempts[i] = { ...(f.attempts[i] as Record<string, unknown>), ...patch };
        putRun(f, run.runId, { ...tally, items: [...items] }, () => recordOf(null, 0));
      });
      run.done += 1;
      streak = step.streak ? streak + 1 : 0;
      stoppedBy = step.stop ?? (streak >= STREAK_STOP ? { kind: 'upstream-streak', message: STREAK_MESSAGE } : null);
      if (stoppedBy) break;
    }
  } catch (err) {
    stoppedBy = { kind: 'internal', message: '자동 확인 중 앱 오류로 멈췄어요 — 남은 글은 다음에 확인해요.' };
    console.error('[indexAuto] 실행이 앱 오류로 멈췄습니다:', scrubSerpKey(err instanceof Error ? (err.stack ?? err.message) : String(err)));
  }
  const notRun = targets.length - tally.searched;
  if (stoppedBy && notRun > 0) stoppedBy = { ...stoppedBy, message: `${stoppedBy.message} 남은 ${notRun}편은 확인하지 않았어요.` };
  const record = recordOf(new Date().toISOString(), notRun);
  try {
    await updateState((f) => putRun(f, run.runId, record, () => record));
  } catch (err) {
    console.error('[indexAuto] 실행 기록을 마무리하지 못했습니다(끊김으로 보입니다):', err);
  }
}

// ── 설정 ─────────────────────────────────────────────────────────────────────

/** 설정 저장 — 본문은 { runCap?, autoOnOpen? }(하나 이상). 모르는 칸 · 범위 밖 · 모양 틀림은 400. */
export async function saveIndexAutoSettings(body: unknown): Promise<{ settings: IndexAutoSettings }> {
  const input = bodyOf(body, ['runCap', 'autoOnOpen']);
  if (Object.keys(input).length === 0) throw new IndexAutoError('바꿀 설정이 없어요(runCap · autoOnOpen).', 400);
  if ('runCap' in input && !validRunCap(input.runCap)) throw new IndexAutoError(`runCap은 1~${RUN_CAP_MAX} 사이 정수여야 해요.`, 400);
  if ('autoOnOpen' in input && typeof input.autoOnOpen !== 'boolean') throw new IndexAutoError('autoOnOpen은 true · false여야 해요.', 400);
  return updateState((f) => {
    if (validRunCap(input.runCap)) f.settings.runCap = input.runCap;
    if (typeof input.autoOnOpen === 'boolean') f.settings.autoOnOpen = input.autoOnOpen;
    return { settings: settingsOf(f) };
  });
}
