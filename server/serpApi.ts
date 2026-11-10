import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { stateFilePath } from './appPaths.js';
import { queueTenantWrite, writeJsonAtomic } from './tenantWriteQueue.js';

/**
 * SerpAPI 공용 연결 — 색인 자동 확인(feature 'index')이 먼저 쓰고, 구글 AI 개요 시범(feature 'aio')이 나중에 같은 계약 위에 얹는다.
 * 검색 1회마다 계정 크레딧이 들므로 「돈이 나가지 않는 쪽」으로 실패하게 짰다.
 *
 * - 키: process.env.SERPAPI_API_KEY를 이 서버에서만 읽는다. 화면 · 로그 · 오류 · 파일에 싣지 않는다(scrubSerpKey). 키가 질의 문자열에
 *   들어가므로 요청 주소는 어디에도 남기지 않는다(검색어만 부르는 쪽이 남긴다).
 * - 주소: https://serpapi.com 고정. 시험용 덮어쓰기는 정확히 http://127.0.0.1:<포트>만 받고, 그 밖의 값이면 진짜 주소로 돌아가지 않고
 *   시작하지 않는다(server/tourPhotos.ts baseUrl과 다른 점). 시험 전용 env 두 개는 설치본 묶음에서 이름째 지운다
 *   (scripts/build-electron-server.mjs).
 * - 계정(account.json — 무료, 검색 수에 안 셈): 허용 칸만 담는다(api_key · account_email · account_id 등은 버림). 60초 캐시 · 5초 시간 초과.
 *   못 읽거나, Active가 아니거나, 갱신일(YYYY-MM-DD) · 월 검색 수 · 남은 수 · 시간당 한도를 못 읽으면 검색하지 않는다.
 * - 장부(stateFilePath('serpapi-usage.json')): 결제 주기(plan_renewal_date)마다 기능별로 이 PC가 보낸 수를 센다. 보내기 직전에 sent+1과
 *   pending을 적고(앱이 죽어도 덜 세지 않게), 응답(성공 · 오류 · 시간 초과 모두) 뒤 pending만 지운다. 끊긴 프로세스의 pending은 다음에
 *   읽을 때 지운다(이미 sent에 들어 있다). 깨졌으면 부르지 않고 덮어쓰지 않는다. 모르는 칸(다른 기능 · 나중 판의 칸)은 버리지 않는다.
 *   이 장부는 이 PC 몫을 거는 보조다 — 다른 PC 사용은 계정 숫자(account.json)에만 보이고, 그래서 계정 바닥을 함께 본다.
 * - 몫(요금제 월 검색 수의 비율, 2026-11-10 사용자 결정): 계정 바닥 50%(남은 검색이 이 아래로 내려가지 않게 — 다른 프로젝트와 계정을
 *   나눠 쓴다) · 색인 20% · AI 개요 25% · 여유 5%. 호출마다 기능 몫 · 바닥 · 시간당 남은 수를 검사한다. 어림 남은 수 = 마지막 계정 값 −
 *   그 뒤 이 프로세스가 보낸 수. 계정은 60초가 지났거나 10회 보낸 뒤 다시 읽는다(실패면 보내지 않음).
 * - 프로세스 전역 순차 줄: 한 번에 하나, 앞 요청이 끝나고 1초 뒤에 다음 요청. 시간 초과 30초 — 끊어도 SerpAPI 쪽에서는 과금됐을 수
 *   있으므로 다시 보내지 않는다(장부에는 1회로 센다).
 */

export type SerpFeature = 'index' | 'aio';
/** 장부 · 몫을 가진 기능. 'aio'(구글 AI 개요 시범)는 몫만 잡아 두었다 — 지금 부르는 곳은 색인 자동 확인뿐이다. */
export const SERP_FEATURES: readonly SerpFeature[] = ['index', 'aio'];
const FEATURE_LABEL: Record<SerpFeature, string> = { index: '색인 자동 확인', aio: '구글 AI 개요 시범' };

export const SERPAPI_DEFAULT_BASE = 'https://serpapi.com';
/** 요금제 월 검색 수(searches_per_month)에 대한 비율(%) — 바닥은 계정 전체, 기능 몫은 이 PC의 결제 주기 사용. 합 100. */
export const SERPAPI_BUDGET_PCT = { floor: 50, index: 20, aio: 25, slack: 5 } as const;
export const SERPAPI_USAGE_FORMAT = 'serpapi-usage/1';
const USAGE_FILE = stateFilePath('serpapi-usage.json');
const USAGE_LOCK = 'serpapi-usage/*';
const REQUEST_QUEUE = 'serpapi-requests/*';
const CYCLES_KEPT = 6;
const SEARCH_TIMEOUT_MS = 30_000;
const ACCOUNT_TIMEOUT_MS = 5_000;
const ACCOUNT_TTL_MS = 60_000;
const ACCOUNT_REFRESH_EVERY = 10;
const GAP_MS = 1_000;
const RENEWAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** 부르는 쪽이 넘기면 안 되는 매개변수 — 키는 여기서만 붙이고, 비동기 · HTML 응답은 이 연결이 읽지 않는다. */
const RESERVED_PARAMS = new Set(['api_key', 'async', 'output']);

export type SerpApiErrorKind =
  | 'no-key'
  | 'config'
  | 'key'
  | 'forbidden'
  | 'quota-month'
  | 'rate-hour'
  | 'bad-request'
  | 'timeout'
  | 'upstream'
  | 'ledger'
  | 'account';

export class SerpApiError extends Error {
  readonly kind: SerpApiErrorKind;
  /** SerpAPI가 준 HTTP 상태(받았을 때만). */
  readonly httpStatus: number | null;
  /** SerpAPI 오류 글(키를 가린 뒤 160자까지) — 화면 문구가 아니라 까닭을 살필 때. */
  readonly detail: string | null;
  constructor(kind: SerpApiErrorKind, message: string, extra: { httpStatus?: number; detail?: string | null } = {}) {
    super(scrubSerpKey(message));
    this.name = 'SerpApiError';
    this.kind = kind;
    this.httpStatus = extra.httpStatus ?? null;
    this.detail = extra.detail ? scrubSerpKey(extra.detail).slice(0, 160) : null;
  }
}

export type SerpBudgetKind = 'feature-cap' | 'floor' | 'hour';

/** 우리 쪽 검사(기능 몫 · 계정 바닥 · 시간당 남은 수)로 부르지 않았다 — 요청은 나가지 않았고 장부에도 세지 않았다. */
export class SerpApiBudgetError extends Error {
  readonly kind: SerpBudgetKind;
  readonly allowance: SerpAllowance;
  constructor(kind: SerpBudgetKind, message: string, allowance: SerpAllowance) {
    super(message);
    this.name = 'SerpApiBudgetError';
    this.kind = kind;
    this.allowance = allowance;
  }
}

const NO_KEY_MESSAGE =
  '이 PC에 SerpAPI 키가 없어요 — %APPDATA%\\brand-aeo-app\\.env에 SERPAPI_API_KEY=… 한 줄을 넣고 앱을 다시 켜 주세요.';
const CONFIG_MESSAGE = 'SerpAPI 연결 주소 설정이 올바르지 않아 시작하지 않았어요 — 시험용 주소는 http://127.0.0.1:<포트>만 받아요.';
const LEDGER_MESSAGE = 'SerpAPI 사용 기록 파일이 깨져 있어 시작하지 않았어요.';

function serpKey(): string {
  return (process.env.SERPAPI_API_KEY ?? '').trim();
}

/** 이 PC에 SerpAPI 키가 있는가(값은 내보내지 않는다). */
export function serpApiConfigured(): boolean {
  return serpKey().length > 0;
}

/** 글자에서 키를 지운다 — 원문 · encodeURIComponent · URLSearchParams 모양 모두. 오류 · 로그 · 돌려주는 응답에 쓴다. */
export function scrubSerpKey(text: string): string {
  const key = serpKey();
  if (!key) return text;
  const forms = [...new Set([key, encodeURIComponent(key), new URLSearchParams({ k: key }).toString().slice(2)])].sort((a, b) => b.length - a.length);
  return forms.reduce((s, k) => s.split(k).join('***'), text);
}

/**
 * 부를 주소의 뿌리. 비어 있으면 진짜 주소, 값이 있으면 정확히 http://127.0.0.1:<포트>(이 PC의 가짜 서버)만 받는다. 그 밖의 값(localhost ·
 * https · 경로 · 다른 호스트 · 진짜 주소를 적은 것까지)은 진짜 주소로 돌아가지 않고 설정 오류다 — 오타 하나로 진짜 키가 진짜 검색으로
 * 나가지 않게.
 */
export function resolveSerpBase(raw: string | undefined): { base: string } | { error: string } {
  const value = (raw ?? '').trim();
  if (!value) return { base: SERPAPI_DEFAULT_BASE };
  const m = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(value);
  return m && Number(m[1]) <= 65535 ? { base: value } : { error: CONFIG_MESSAGE };
}

/** 연결 설정이 틀렸으면 그 까닭(그러면 검색 · 계정 모두 시작하지 않는다), 맞으면 null. */
export function serpApiConfigError(): string | null {
  const r = resolveSerpBase(process.env.SERPAPI_BASE_URL);
  return 'error' in r ? r.error : null;
}

function ready(): { base: string; key: string } {
  const key = serpKey();
  if (!key) throw new SerpApiError('no-key', NO_KEY_MESSAGE);
  const r = resolveSerpBase(process.env.SERPAPI_BASE_URL);
  if ('error' in r) throw new SerpApiError('config', r.error);
  return { base: r.base, key };
}

/** 검색 시간 초과 — 30초. 시험만 더 짧게 줄 수 있다(설치본 묶음에서는 이 env 이름이 지워진다). */
function searchTimeoutMs(): number {
  const n = Number(process.env.SERPAPI_TIMEOUT_MS);
  return Number.isInteger(n) && n >= 100 && n < SEARCH_TIMEOUT_MS ? n : SEARCH_TIMEOUT_MS;
}

function accountTimeoutMs(): number {
  return Math.min(ACCOUNT_TIMEOUT_MS, searchTimeoutMs());
}

// ── 계정 ──────────────────────────────────────────────────────────────────────

/** account.json에서 허용한 칸만 옮긴 것. 키 · 계정 이메일 · 계정 id · 요금 등은 담지 않는다. 읽지 못한 칸은 null. */
export interface SerpAccount {
  planName: string | null;
  accountStatus: string | null;
  searchesPerMonth: number | null;
  totalSearchesLeft: number | null;
  planSearchesLeft: number | null;
  extraCredits: number | null;
  thisMonthUsage: number | null;
  thisHourSearches: number | null;
  rateLimitPerHour: number | null;
  /** 결제 주기 이름 — 장부가 이 값으로 주기를 나눈다. */
  planRenewalDate: string | null;
  fetchedAt: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const countOf = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const textOf = (v: unknown, max: number): string | null => {
  const t = typeof v === 'string' ? v.trim() : '';
  return t && t.length <= max ? t : null;
};

function pickAccount(raw: unknown, fetchedAt: string): SerpAccount {
  const r = isRecord(raw) ? raw : {};
  return {
    planName: textOf(r.plan_name, 64),
    accountStatus: textOf(r.account_status, 32),
    searchesPerMonth: countOf(r.searches_per_month),
    totalSearchesLeft: countOf(r.total_searches_left),
    planSearchesLeft: countOf(r.plan_searches_left),
    extraCredits: countOf(r.extra_credits),
    thisMonthUsage: countOf(r.this_month_usage),
    thisHourSearches: countOf(r.this_hour_searches),
    rateLimitPerHour: countOf(r.account_rate_limit_per_hour),
    planRenewalDate: textOf(r.plan_renewal_date, 32),
    fetchedAt,
  };
}

/** 이 계정 상태로는 검색하지 않는 까닭(막힌 쪽 — 모르는 것은 쓰지 않는다). 없으면 null. */
export function serpAccountBlocker(acc: SerpAccount): string | null {
  if (acc.accountStatus !== 'Active') {
    return acc.accountStatus ? 'SerpAPI 계정이 활성 상태가 아니에요 — 계정을 확인해 주세요.' : 'SerpAPI 계정 상태를 읽지 못해 시작하지 않았어요.';
  }
  if (!acc.planRenewalDate || !RENEWAL_DATE.test(acc.planRenewalDate)) return 'SerpAPI 계정의 갱신일을 읽지 못해 시작하지 않았어요.';
  if (!acc.searchesPerMonth) return 'SerpAPI 요금제의 월 검색 수를 읽지 못해 시작하지 않았어요.';
  if (acc.totalSearchesLeft === null) return 'SerpAPI 계정의 남은 검색 수를 읽지 못해 시작하지 않았어요.';
  if (acc.rateLimitPerHour === null || acc.thisHourSearches === null) return 'SerpAPI 계정의 시간당 한도를 읽지 못해 시작하지 않았어요.';
  return null;
}

interface Snapshot {
  account: SerpAccount;
  at: number;
  /** 이 값을 읽기 시작할 때까지 이 프로세스가 보낸 수(그때 날아가던 요청은 빼서 많게 센다). */
  baseSent: number;
}
let snapshot: Snapshot | null = null;
let accountInflight: Promise<SerpAccount> | null = null;
/** 이 프로세스가 지금까지 보낸 검색 수(장부에 적은 뒤 센다) · 응답을 기다리는 수. */
let sentTotal = 0;
let searchesInFlight = 0;

const sentSinceSnapshot = (s: Snapshot) => sentTotal - s.baseSent;

function transportReason(err: unknown, timeoutMs: number): { timeout: boolean; text: string } {
  const name = (err as { name?: string } | null)?.name ?? '';
  if (name === 'TimeoutError' || name === 'AbortError') return { timeout: true, text: `${Math.round(timeoutMs / 100) / 10}초 안에 답하지 않았어요` };
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  return { timeout: false, text: `연결하지 못했어요${typeof code === 'string' && /^[A-Z_]{3,32}$/.test(code) ? ` — ${code}` : ''}` };
}

function httpReason(status: number): string {
  if (status === 401) return 'HTTP 401 — 키가 맞지 않아요';
  if (status === 403) return 'HTTP 403 — 계정이 허락하지 않았어요';
  return `HTTP ${status}`;
}

async function fetchAccount(): Promise<SerpAccount> {
  const { base, key } = ready();
  const ms = accountTimeoutMs();
  let status: number;
  let text: string;
  try {
    const res = await fetch(`${base}/account.json?${new URLSearchParams({ api_key: key }).toString()}`, {
      signal: AbortSignal.timeout(ms),
      headers: { Accept: 'application/json' },
    });
    status = res.status;
    text = await res.text();
  } catch (err) {
    throw new SerpApiError('account', `SerpAPI 계정 상태를 읽지 못해 시작하지 않았어요(${transportReason(err, ms).text}).`);
  }
  if (status !== 200) throw new SerpApiError('account', `SerpAPI 계정 상태를 읽지 못해 시작하지 않았어요(${httpReason(status)}).`, { httpStatus: status });
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SerpApiError('account', 'SerpAPI 계정 상태를 읽지 못해 시작하지 않았어요(응답이 JSON이 아니에요).');
  }
  if (!isRecord(json)) throw new SerpApiError('account', 'SerpAPI 계정 상태를 읽지 못해 시작하지 않았어요(응답 모양이 달라요).');
  return pickAccount(json, new Date().toISOString());
}

/**
 * 계정 상태(허용 칸만). 60초 안에 읽은 값이 있으면 그것을 준다 — fresh면 늘 다시 읽는다. 못 읽으면 SerpApiError('account')이고, 읽어
 * 둔 값도 버린다(다음 검색이 모르는 채로 나가지 않게).
 */
export async function serpAccount(opts: { fresh?: boolean } = {}): Promise<SerpAccount> {
  ready();
  if (!opts.fresh && snapshot && Date.now() - snapshot.at < ACCOUNT_TTL_MS) return snapshot.account;
  if (accountInflight) return accountInflight;
  const baseSent = sentTotal - searchesInFlight;
  accountInflight = fetchAccount()
    .then(
      (account) => {
        snapshot = { account, at: Date.now(), baseSent };
        return account;
      },
      (err: unknown) => {
        snapshot = null;
        throw err;
      },
    )
    .finally(() => {
      accountInflight = null;
    });
  return accountInflight;
}

// ── 몫 ────────────────────────────────────────────────────────────────────────

/** 요금제 월 검색 수 → 결제 주기당 회수. 기능 몫은 내림, 바닥은 올림(어느 쪽이든 덜 쓰는 쪽). */
export function serpQuota(searchesPerMonth: number): { floor: number; index: number; aio: number; slack: number } {
  const share = (pct: number) => Math.floor((searchesPerMonth * pct) / 100);
  return {
    floor: Math.ceil((searchesPerMonth * SERPAPI_BUDGET_PCT.floor) / 100),
    index: share(SERPAPI_BUDGET_PCT.index),
    aio: share(SERPAPI_BUDGET_PCT.aio),
    slack: share(SERPAPI_BUDGET_PCT.slack),
  };
}

/** 한 기능이 지금 더 보낼 수 있는 검색 수와 그 근거. 계정 값은 마지막 account.json − 그 뒤 이 프로세스가 보낸 수로 어림한다. */
export interface SerpAllowance {
  feature: SerpFeature;
  cycle: string;
  /** 이 PC가 이 주기에 이 기능으로 보낼 수 있는 수 · 보낸 수 · 남은 수. */
  cap: number;
  used: number;
  featureLeft: number;
  /** 계정 바닥 · 어림 남은 검색 · 바닥 위로 더 쓸 수 있는 수. */
  floor: number;
  accountLeft: number;
  aboveFloor: number;
  /** 어림 이번 시간에 더 보낼 수 있는 수. */
  hourLeft: number;
  /** 셋의 최솟값 — 0이면 부르지 않는다. */
  allowed: number;
}

function allowanceOf(acc: SerpAccount, cycle: string, used: number, sentSince: number, feature: SerpFeature): SerpAllowance {
  const quota = serpQuota(acc.searchesPerMonth ?? 0);
  const cap = quota[feature];
  const featureLeft = Math.max(0, cap - used);
  const accountLeft = Math.max(0, (acc.totalSearchesLeft ?? 0) - sentSince);
  const aboveFloor = Math.max(0, accountLeft - quota.floor);
  const hourLeft = Math.max(0, (acc.rateLimitPerHour ?? 0) - (acc.thisHourSearches ?? 0) - sentSince);
  const blocked = serpAccountBlocker(acc) !== null;
  return { feature, cycle, cap, used, featureLeft, floor: quota.floor, accountLeft, aboveFloor, hourLeft, allowed: blocked ? 0 : Math.min(featureLeft, aboveFloor, hourLeft) };
}

function refusalOf(a: SerpAllowance, acc: SerpAccount): SerpApiBudgetError | null {
  if (a.featureLeft < 1) return new SerpApiBudgetError('feature-cap', `이번 결제 주기 ${FEATURE_LABEL[a.feature]} 몫(${a.cap}회)을 다 써서 보내지 않았어요.`, a);
  if (a.aboveFloor < 1) {
    return new SerpApiBudgetError('floor', `계정에 남은 검색이 바닥 ${a.floor}회 아래로 내려가지 않게 멈췄어요(남은 검색 약 ${a.accountLeft}회 — 다른 PC · 다른 작업 몫).`, a);
  }
  if (a.hourLeft < 1) return new SerpApiBudgetError('hour', `이번 시간 검색 한도(${acc.rateLimitPerHour ?? 0}회)에 닿지 않게 멈췄어요 — 한 시간쯤 뒤 다시 눌러 주세요.`, a);
  return null;
}

// ── 장부 ──────────────────────────────────────────────────────────────────────

interface SerpPending {
  id: string;
  feature: string;
  at: string;
}
/** cycles[<plan_renewal_date>][<기능>] = { sent, …다른 칸 }. 모르는 기능 · 칸 · 머리 칸은 읽은 그대로 다시 쓴다. */
interface SerpUsageFile {
  [extra: string]: unknown;
  format: typeof SERPAPI_USAGE_FORMAT;
  cycles: Record<string, Record<string, unknown>>;
  pending: SerpPending[];
}

const isKnownFeature = (f: string): f is SerpFeature => (SERP_FEATURES as readonly string[]).includes(f);

/** 장부 검사 — 형식 · 아는 기능의 sent(0 이상 정수) · pending 모양만 엄격하다. 틀리면 throw(부르지 않고 덮어쓰지 않는다). */
function parseUsage(raw: unknown): SerpUsageFile {
  if (!isRecord(raw) || raw.format !== SERPAPI_USAGE_FORMAT) throw new Error('format');
  const cycles = raw.cycles ?? {};
  if (!isRecord(cycles)) throw new Error('cycles');
  for (const entry of Object.values(cycles)) {
    if (!isRecord(entry)) throw new Error('cycle');
    for (const [feature, value] of Object.entries(entry)) {
      if (!isKnownFeature(feature)) continue;
      if (!isRecord(value) || !Number.isInteger(value.sent) || (value.sent as number) < 0) throw new Error('sent');
    }
  }
  const pending = raw.pending ?? [];
  if (!Array.isArray(pending)) throw new Error('pending');
  for (const p of pending) {
    if (!isRecord(p) || typeof p.id !== 'string' || typeof p.feature !== 'string' || typeof p.at !== 'string') throw new Error('pending item');
  }
  return { ...raw, format: SERPAPI_USAGE_FORMAT, cycles: cycles as Record<string, Record<string, unknown>>, pending: pending as SerpPending[] };
}

/** 이 프로세스가 지금 응답을 기다리는 요청의 pending id — 장부에 이 밖의 pending이 있으면 끊긴 프로세스가 남긴 것이다. */
const inflightPending = new Set<string>();

/** 줄 안에서 읽는다. 없으면 빈 장부, 깨졌으면 SerpApiError('ledger'). 끊긴 pending은 걷어 내고 dirty로 알린다. */
async function loadUsageInLock(): Promise<{ usage: SerpUsageFile; dirty: boolean }> {
  let text: string | null = null;
  try {
    text = await readFile(USAGE_FILE, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new SerpApiError('ledger', LEDGER_MESSAGE, { detail: (err as NodeJS.ErrnoException).code ?? null });
  }
  if (text === null) return { usage: { format: SERPAPI_USAGE_FORMAT, cycles: {}, pending: [] }, dirty: false };
  let usage: SerpUsageFile;
  try {
    usage = parseUsage(JSON.parse(text));
  } catch (err) {
    throw new SerpApiError('ledger', LEDGER_MESSAGE, { detail: err instanceof Error ? err.message : null });
  }
  const live = usage.pending.filter((p) => inflightPending.has(p.id));
  const dirty = live.length !== usage.pending.length;
  usage.pending = live;
  return { usage, dirty };
}

async function saveUsage(usage: SerpUsageFile): Promise<void> {
  try {
    await writeJsonAtomic(USAGE_FILE, usage);
  } catch (err) {
    throw new SerpApiError('ledger', 'SerpAPI 사용 기록을 적지 못해 보내지 않았어요.', { detail: (err as NodeJS.ErrnoException).code ?? null });
  }
}

const sentIn = (usage: SerpUsageFile, cycle: string, feature: SerpFeature): number => {
  const entry = usage.cycles[cycle]?.[feature];
  return isRecord(entry) ? (entry.sent as number) : 0;
};

/** 이 PC 장부를 읽는다(끊긴 pending은 지워 다시 쓴다). 깨졌으면 SerpApiError('ledger') — 파일은 그대로 둔다. */
function readUsage(): Promise<SerpUsageFile> {
  return queueTenantWrite(USAGE_LOCK, async () => {
    const { usage, dirty } = await loadUsageInLock();
    if (dirty) await saveUsage(usage);
    return usage;
  });
}

/** 보내기 직전 — 몫을 검사하고, 지나면 sent+1 · pending을 저장한다(저장이 안 되면 보내지 않는다). pending id를 돌려준다. */
function reserve(feature: SerpFeature, snap: Snapshot): Promise<string> {
  return queueTenantWrite(USAGE_LOCK, async () => {
    const { usage, dirty } = await loadUsageInLock();
    const acc = snap.account;
    const cycle = acc.planRenewalDate as string;
    const used = sentIn(usage, cycle, feature);
    const refusal = refusalOf(allowanceOf(acc, cycle, used, sentSinceSnapshot(snap), feature), acc);
    if (refusal) {
      if (dirty) await saveUsage(usage);
      throw refusal;
    }
    const entries = (usage.cycles[cycle] ??= {});
    const entry = isRecord(entries[feature]) ? (entries[feature] as Record<string, unknown>) : {};
    entries[feature] = { ...entry, sent: used + 1 };
    const id = `p-${randomUUID()}`;
    usage.pending.push({ id, feature, at: new Date().toISOString() });
    const keys = Object.keys(usage.cycles).sort();
    const keep = new Set([...keys.slice(-CYCLES_KEPT), cycle]);
    for (const k of keys) if (!keep.has(k)) delete usage.cycles[k];
    await saveUsage(usage);
    inflightPending.add(id);
    sentTotal += 1;
    searchesInFlight += 1;
    return id;
  });
}

/** 응답 뒤 — pending만 지운다. 못 지우면 다음에 읽을 때 지운다(sent는 이미 적혀 있다). */
function release(id: string): Promise<void> {
  return queueTenantWrite(USAGE_LOCK, async () => {
    inflightPending.delete(id);
    try {
      const { usage, dirty } = await loadUsageInLock();
      if (dirty) await saveUsage(usage);
    } catch (err) {
      console.warn('[serpapi] 사용 기록의 대기 표시를 지우지 못했습니다 — 다음에 읽을 때 지웁니다', scrubSerpKey(err instanceof Error ? err.message : String(err)));
    }
  });
}

// ── 검색 ──────────────────────────────────────────────────────────────────────

export interface SerpSearchResult {
  /** 응답 JSON(키 글자는 ***로 가림). 결과 0건(Success + error 문구)도 그대로 온다 — 읽는 것은 부르는 쪽이다. */
  json: Record<string, unknown>;
  /** 이 검색을 센 결제 주기(plan_renewal_date). */
  cycle: string;
  elapsedMs: number;
}

let lastEndAt = 0;

function errorTextOf(text: string): string | null {
  try {
    const json: unknown = JSON.parse(text);
    return isRecord(json) && typeof json.error === 'string' ? json.error : null;
  } catch {
    return text.trim().slice(0, 160) || null;
  }
}

function classifyHttp(status: number, text: string): SerpApiError {
  const detail = errorTextOf(text);
  const extra = { httpStatus: status, detail };
  if (status === 401) return new SerpApiError('key', 'SerpAPI 키가 맞지 않아요(HTTP 401) — .env의 SERPAPI_API_KEY를 확인하고 앱을 다시 켜 주세요.', extra);
  if (status === 403) return new SerpApiError('forbidden', 'SerpAPI 계정이 이 검색을 허락하지 않았어요(HTTP 403) — 계정 상태를 확인해 주세요.', extra);
  if (status === 429 && /run out of searches/i.test(detail ?? text)) return new SerpApiError('quota-month', 'SerpAPI 계정의 이번 결제 주기 검색을 다 썼어요(HTTP 429).', extra);
  if (status === 429) return new SerpApiError('rate-hour', '이번 시간 검색 한도에 닿았어요(HTTP 429) — 한 시간쯤 뒤 다시 눌러 주세요.', extra);
  if (status === 400) return new SerpApiError('bad-request', 'SerpAPI가 요청을 받지 않았어요(HTTP 400) — 앱 문제일 수 있어요.', extra);
  return new SerpApiError('upstream', `SerpAPI 응답 오류(HTTP ${status})`, extra);
}

function checkRequest(feature: SerpFeature, params: Record<string, string>): void {
  if (!isKnownFeature(feature)) throw new SerpApiError('config', 'SerpAPI를 부르는 기능 이름이 올바르지 않아 보내지 않았어요 — 앱 문제예요.');
  const bad = () => new SerpApiError('bad-request', 'SerpAPI 요청 모양이 올바르지 않아 보내지 않았어요 — 앱 문제예요.');
  if (!isRecord(params) || typeof params.engine !== 'string' || !params.engine) throw bad();
  for (const [k, v] of Object.entries(params)) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(k) || RESERVED_PARAMS.has(k) || typeof v !== 'string' || v.length > 2048) throw bad();
  }
}

/** 장부 · 몫 검사를 지난 요청 하나를 보낸다. 시간 초과 · 연결 실패도 다시 보내지 않는다. */
async function send(base: string, key: string, params: Record<string, string>): Promise<{ json: Record<string, unknown>; elapsedMs: number }> {
  const ms = searchTimeoutMs();
  const started = Date.now();
  let status: number;
  let text: string;
  try {
    const res = await fetch(`${base}/search.json?${new URLSearchParams({ ...params, api_key: key }).toString()}`, {
      signal: AbortSignal.timeout(ms),
      headers: { Accept: 'application/json' },
    });
    status = res.status;
    text = await res.text();
  } catch (err) {
    const why = transportReason(err, ms);
    throw why.timeout ? new SerpApiError('timeout', `SerpAPI가 ${why.text}.`) : new SerpApiError('upstream', `SerpAPI에 ${why.text}.`);
  }
  if (status !== 200) throw classifyHttp(status, scrubSerpKey(text));
  let json: unknown;
  try {
    json = JSON.parse(scrubSerpKey(text));
  } catch {
    throw new SerpApiError('upstream', 'SerpAPI 응답을 읽지 못했어요(JSON이 아니에요).', { httpStatus: status });
  }
  if (!isRecord(json)) throw new SerpApiError('upstream', 'SerpAPI 응답 모양을 읽지 못했어요.', { httpStatus: status });
  return { json, elapsedMs: Date.now() - started };
}

/**
 * SerpAPI 검색 한 번(search.json). 프로세스 전역 순차 줄에서 돈다: 앞 요청이 끝나고 1초 뒤 → 계정(60초 · 10회마다 다시) → 몫 검사 →
 * 장부에 sent+1 · pending 저장 → 보냄 → pending 지움. 우리 쪽 검사로 막히면 SerpApiBudgetError(요청 0 · 장부 그대로), 그 밖은
 * SerpApiError(kind로 까닭). 키는 여기서만 붙인다 — params에 api_key · async · output을 넣으면 보내지 않는다.
 */
export function serpSearch(feature: SerpFeature, params: Record<string, string>): Promise<SerpSearchResult> {
  try {
    checkRequest(feature, params);
  } catch (err) {
    return Promise.reject(err);
  }
  return queueTenantWrite(REQUEST_QUEUE, async () => {
    const { base, key } = ready();
    const wait = lastEndAt + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    if (!snapshot || Date.now() - snapshot.at >= ACCOUNT_TTL_MS || sentSinceSnapshot(snapshot) >= ACCOUNT_REFRESH_EVERY) await serpAccount({ fresh: true });
    // 어림은 이 값을 읽은 뒤 보낸 수를 뺀다 — 그 사이 다른 곳(계정 보기)이 새로 읽어도 이 값 기준으로 많게 센다.
    const snap = snapshot;
    if (!snap) throw new SerpApiError('account', 'SerpAPI 계정 상태를 읽지 못해 시작하지 않았어요.');
    const acc = snap.account;
    const blocker = serpAccountBlocker(acc);
    if (blocker) throw new SerpApiError('account', blocker);
    const id = await reserve(feature, snap);
    try {
      const { json, elapsedMs } = await send(base, key, params);
      return { json, cycle: acc.planRenewalDate as string, elapsedMs };
    } finally {
      searchesInFlight -= 1;
      lastEndAt = Date.now();
      await release(id);
    }
  });
}

// ── 계정 보기(GET /api/serpapi/account) ─────────────────────────────────────────

export interface SerpFeatureUsage {
  sent: number;
  cap: number;
  left: number;
  /** 지금 더 보낼 수 있는 수(기능 몫 · 계정 바닥 · 시간당 남은 수의 최솟값, 계정이 막으면 0). */
  allowed: number;
}

export interface SerpApiAccountView {
  /** 키가 있는가. */
  configured: boolean;
  /** 연결 주소 설정이 틀렸으면 그 까닭(그러면 아무 요청도 하지 않는다). */
  configError: string | null;
  account: SerpAccount | null;
  /** 계정을 못 읽었거나 계정 상태로는 검색하지 않는 까닭. */
  accountError: { kind: SerpApiErrorKind; message: string } | null;
  budget: { pct: typeof SERPAPI_BUDGET_PCT; searches: ReturnType<typeof serpQuota> | null };
  /** 이 PC 장부의 이번 결제 주기 사용(기능별) — 계정의 갱신일 · 월 검색 수를 알 때만. */
  usage: {
    cycle: string;
    floor: number;
    accountLeft: number;
    aboveFloor: number;
    hourLeft: number;
    features: Record<SerpFeature, SerpFeatureUsage>;
  } | null;
  usageError: string | null;
}

/** 계정 · 몫 · 이 PC 장부를 한 번에(검색은 하지 않는다 — 계정은 60초 캐시). 키 · 계정 이메일 · id는 싣지 않는다. */
export async function serpApiAccountView(): Promise<SerpApiAccountView> {
  const view: SerpApiAccountView = {
    configured: serpApiConfigured(),
    configError: serpApiConfigError(),
    account: null,
    accountError: null,
    budget: { pct: SERPAPI_BUDGET_PCT, searches: null },
    usage: null,
    usageError: null,
  };
  if (!view.configured || view.configError) return view;
  let usage: SerpUsageFile | null = null;
  try {
    usage = await readUsage();
  } catch (err) {
    view.usageError = err instanceof Error ? scrubSerpKey(err.message) : LEDGER_MESSAGE;
  }
  let acc: SerpAccount;
  try {
    acc = await serpAccount();
  } catch (err) {
    view.accountError = { kind: err instanceof SerpApiError ? err.kind : 'account', message: scrubSerpKey(err instanceof Error ? err.message : String(err)) };
    return view;
  }
  view.account = acc;
  const blocker = serpAccountBlocker(acc);
  if (blocker) view.accountError = { kind: 'account', message: blocker };
  if (!acc.searchesPerMonth) return view;
  view.budget.searches = serpQuota(acc.searchesPerMonth);
  const cycle = acc.planRenewalDate;
  if (!usage || !cycle || !RENEWAL_DATE.test(cycle)) return view;
  const sentSince = snapshot && snapshot.account === acc ? sentSinceSnapshot(snapshot) : 0;
  const features = {} as Record<SerpFeature, SerpFeatureUsage>;
  for (const f of SERP_FEATURES) {
    const a = allowanceOf(acc, cycle, sentIn(usage, cycle, f), sentSince, f);
    features[f] = { sent: a.used, cap: a.cap, left: a.featureLeft, allowed: a.allowed };
  }
  const { floor, accountLeft, aboveFloor, hourLeft } = allowanceOf(acc, cycle, 0, sentSince, 'index');
  view.usage = { cycle, floor, accountLeft, aboveFloor, hourLeft, features };
  return view;
}
