import { findIndexRecord, recheckOf, rowName, type IndexCheck, type PublishStatusRow, type TenantChecks } from '../src/lib/publishStatus.js';
import { trackingKey } from '../src/lib/publishedUrl.js';
import { IndexChecksError, writeIndexCheck } from './indexChecks.js';
import { readPublishStatusSnapshot } from './publishStatus.js';
import type { TenantConfig } from './types.js';

/**
 * 네이버 자동 확인 — 발행 현황의 네이버 노출 칸을 NAVER API HUB 검색(블로그 · 웹문서)으로 대신 보고 index-checks.json에 source 'auto'로
 * 적는다(2026-11-16 사용자 「권장안대로」: 단추로만 실행, 3 · 7 · 14일째 차례 모두, 무료라 몫 · 확인 창 없음).
 *
 * - 검색: 글 제목으로 블로그 검색 → 못 찾으면 웹문서 검색(각 결과 100개까지). 결과 링크의 주소 키(trackingKey)가 그 글과 같으면 「노출됨 · 자동」,
 *   둘 다 없으면 「아직 · 자동」이다. 「아직 · 자동」은 확정이 아니다(제목이 흔하면 100개 밖일 수 있다) — 다음 다시 볼 날에 또 찾는다.
 * - 주소 키마다 한 번(같은 주소의 줄은 기록을 서로 이어받는다 — writeIndexCheck). 사람 표시가 먼저다: 계획 때 본 원본 기록의 네이버 확인 시각과
 *   다르면 덮지 않는다(CAS).
 * - 시도 기록 파일은 두지 않는다 — 적으면 확인일이 오늘이 되어 다음 차례까지 대상에서 빠지고, 못 가린 글(오류)은 적지 않아 다음에 다시 찾는다.
 *   실행 상태 · 마지막 결과는 이 서버 메모리에만 있다(앱을 끄면 사라진다).
 * - 키: NAVER_API_HUB_CLIENT_ID · NAVER_API_HUB_CLIENT_SECRET을 이 서버에서만 읽는다. 화면 · 로그 · 오류에 싣지 않는다.
 * - 멈춤: 키(401) · 권한(403) · 한도(429)는 바로, 시간 초과 · 서버 오류가 3번 잇따르면.
 * - 웹(Vercel)에는 라우트가 없다 — 화면은 404를 「이 환경에는 없음」으로 읽는다.
 */

const API_BASE = 'https://naverapihub.apigw.ntruss.com/search/v1';
const DISPLAY = 100;
const TIMEOUT_MS = 15_000;
/** 호출 사이 간격 — API 키당 50 RPS 한도보다 넉넉히 느리게. */
const GAP_MS = 120;
const STREAK_STOP = 3;

export type NaverSearchKind = 'blog' | 'webkr';

export interface NaverTarget {
  key: string;
  tenantId: string;
  postId: string;
  rowName: string;
  url: string;
  query: string;
  /** CAS 기준값 — 원본 최신 기록의 네이버 확인 시각. */
  expectRawCheckedAt: string | null;
}

export interface NaverPlan {
  targets: NaverTarget[];
  /** 제목을 몰라 찾지 못하는 주소 — 사람이 직접 본다. */
  untitled: number;
}

type LiveRow = PublishStatusRow & { key: string; postId: string; url: string };

/** 오늘 네이버를 다시 볼 차례인 주소 — 주소 키마다 대표 줄 하나(앱 글 먼저 · 브랜드 설정 순 · id 순). 「노출됨」이 이미 있으면 recheckOf가 빼 준다. */
export function planNaverTargets(input: { rows: readonly PublishStatusRow[]; today: string; checks: readonly TenantChecks[]; tenantOrder: readonly string[] }): NaverPlan {
  const order = (tenantId: string) => {
    const i = input.tenantOrder.indexOf(tenantId);
    return i < 0 ? input.tenantOrder.length : i;
  };
  const byKey = new Map<string, LiveRow[]>();
  for (const r of input.rows) {
    if (r.kind !== 'posted' || r.removed || !r.key || !r.postId || !r.url) continue;
    const from = r.recheckFrom === undefined ? r.publishedOn : r.recheckFrom;
    if (recheckOf(from, r.naver, input.today).kind !== 'due') continue;
    byKey.set(r.key, [...(byKey.get(r.key) ?? []), r as LiveRow]);
  }
  const plan: NaverPlan = { targets: [], untitled: 0 };
  for (const [key, rows] of [...byKey].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    rows.sort(
      (a, b) =>
        (a.origin === 'app' ? 0 : 1) - (b.origin === 'app' ? 0 : 1) || order(a.tenantId) - order(b.tenantId) || (a.postId < b.postId ? -1 : a.postId > b.postId ? 1 : 0),
    );
    const titled = rows.find((r) => (r.title ?? '').trim());
    if (!titled) {
      plan.untitled += 1;
      continue;
    }
    const own = input.checks.find((c) => c.tenantId === titled.tenantId) ?? { tenantId: titled.tenantId, checks: {} };
    const raw: IndexCheck | null =
      findIndexRecord(
        own,
        input.checks.filter((c) => c.tenantId !== titled.tenantId),
        [titled.postId],
        key,
      )?.record.naver ?? null;
    plan.targets.push({
      key,
      tenantId: titled.tenantId,
      postId: titled.postId,
      rowName: rowName(titled),
      url: titled.url,
      query: titled.title!.trim(),
      expectRawCheckedAt: raw?.checkedAt ?? null,
    });
  }
  return plan;
}

/** 검색 결과 링크 가운데 그 글 주소가 있는가 — 주소 키로 견준다(m. · 끝 / · 추적 꼬리 · 네이버 블로그 옛 주소 모양을 맞춘다). */
export function naverResultHas(key: string, items: unknown): boolean {
  if (!Array.isArray(items)) return false;
  return items.some((it) => {
    const link = it && typeof it === 'object' ? (it as { link?: unknown }).link : null;
    return typeof link === 'string' && trackingKey(link) === key;
  });
}

export type NaverErrorKind = 'no-key' | 'auth' | 'forbidden' | 'limit' | 'timeout' | 'upstream';

export class NaverSearchError extends Error {
  readonly kind: NaverErrorKind;

  constructor(kind: NaverErrorKind, message: string) {
    super(message);
    this.name = 'NaverSearchError';
    this.kind = kind;
  }
}

const NO_KEY =
  '이 PC에 네이버 검색 키가 없어요 — %APPDATA%\\brand-aeo-app\\.env에 NAVER_API_HUB_CLIENT_ID · NAVER_API_HUB_CLIENT_SECRET 두 줄을 넣고 앱을 다시 켜 주세요.';
const STOP_MESSAGE: Record<Exclude<NaverErrorKind, 'timeout' | 'upstream'>, string> = {
  'no-key': NO_KEY,
  auth: '네이버 검색 키가 맞지 않아요(HTTP 401) — .env의 NAVER_API_HUB_CLIENT_ID · SECRET을 확인하고 앱을 다시 켜 주세요.',
  forbidden: '네이버 검색을 쓸 권한이 없어요(HTTP 403) — NAVER API HUB 콘솔의 Application에 블로그 · 웹문서 검색이 선택돼 있는지 확인해 주세요.',
  limit: '네이버 검색 한도에 닿았어요(HTTP 429) — 내일 다시 눌러 주세요.',
};

function keys(): { id: string; secret: string } | null {
  const id = (process.env.NAVER_API_HUB_CLIENT_ID ?? '').trim();
  const secret = (process.env.NAVER_API_HUB_CLIENT_SECRET ?? '').trim();
  return id && secret ? { id, secret } : null;
}

/** 시험이 가짜 서버로 돌리는 주소 — 설치본 · 평소에는 비어 있어 진짜 API HUB로 간다. */
function apiBase(): string {
  return (process.env.NAVER_API_HUB_BASE_URL ?? '').trim() || API_BASE;
}

export async function naverSearch(kind: NaverSearchKind, query: string): Promise<unknown[]> {
  const k = keys();
  if (!k) throw new NaverSearchError('no-key', NO_KEY);
  const url = `${apiBase()}/${kind}?query=${encodeURIComponent(query)}&display=${DISPLAY}&format=json`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'X-NCP-APIGW-API-KEY-ID': k.id, 'X-NCP-APIGW-API-KEY': k.secret },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new NaverSearchError(timeout ? 'timeout' : 'upstream', timeout ? '네이버 검색이 답하지 않았어요(시간 초과).' : '네이버 검색에 닿지 못했어요.');
  }
  if (res.status === 401) throw new NaverSearchError('auth', STOP_MESSAGE.auth);
  if (res.status === 403) throw new NaverSearchError('forbidden', STOP_MESSAGE.forbidden);
  if (res.status === 429) throw new NaverSearchError('limit', STOP_MESSAGE.limit);
  if (!res.ok) throw new NaverSearchError('upstream', `네이버 검색이 오류를 냈어요(HTTP ${res.status}).`);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new NaverSearchError('upstream', '네이버 검색 응답을 읽지 못했어요.');
  }
  const items = json && typeof json === 'object' ? (json as { items?: unknown }).items : null;
  if (!Array.isArray(items)) throw new NaverSearchError('upstream', '네이버 검색 응답 모양이 달라요(items 없음).');
  return items;
}

// ── 실행 ─────────────────────────────────────────────────────────────────────

export type NaverItemOutcome = 'shown' | 'not-yet' | 'skipped' | 'unknown';

export interface NaverRunItem {
  key: string;
  tenantId: string;
  postId: string;
  rowName: string;
  outcome: NaverItemOutcome;
  /** 못 가렸거나 건너뛴 까닭. */
  reason?: string;
}

export interface NaverRunView {
  startedAt: string;
  endedAt: string | null;
  total: number;
  done: number;
  shown: number;
  notYet: number;
  skipped: number;
  unknown: number;
  untitled: number;
  /** 멈춘 까닭 — 끝까지 돌았으면 null. */
  stoppedBy: string | null;
  items: NaverRunItem[];
}

export interface NaverStatusView {
  /** 키가 있어 자동 확인을 할 수 있다. */
  configured: boolean;
  configMessage: string | null;
  /** 도는 중이면 그 실행, 아니면 마지막 실행(앱을 켠 뒤). */
  run: NaverRunView | null;
  running: boolean;
}

export class NaverIndexError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'NaverIndexError';
    this.status = status;
  }
}

let current: NaverRunView | null = null;
let running = false;

export function naverIndexStatus(): NaverStatusView {
  const configured = keys() !== null;
  return { configured, configMessage: configured ? null : NO_KEY, run: current ? { ...current, items: [...current.items] } : null, running };
}

/** 실행 시작 — 대상을 지금 파일에서 셈하고 뒤에서 돈다. 이미 도는 중 · 키 없음 · 대상 없음이면 거절. */
export async function startNaverIndex(tenants: TenantConfig[]): Promise<{ total: number }> {
  if (running) throw new NaverIndexError('이미 네이버 자동 확인이 도는 중이에요 — 끝난 뒤 다시 눌러 주세요.', 409);
  if (!keys()) throw new NaverIndexError(NO_KEY, 503);
  running = true;
  let plan: NaverPlan;
  try {
    const { status, checks } = await readPublishStatusSnapshot(tenants);
    const tenantOrder = tenants.filter((t) => !t.cohortOnly).map((t) => t.tenantId);
    plan = planNaverTargets({ rows: status.rows, today: status.today, checks, tenantOrder });
  } catch (err) {
    running = false;
    throw err;
  }
  if (plan.targets.length === 0) {
    running = false;
    throw new NaverIndexError('오늘 네이버를 다시 볼 글이 없어요.', 409);
  }
  current = {
    startedAt: new Date().toISOString(),
    endedAt: null,
    total: plan.targets.length,
    done: 0,
    shown: 0,
    notYet: 0,
    skipped: 0,
    unknown: 0,
    untitled: plan.untitled,
    stoppedBy: null,
    items: [],
  };
  const customers = tenants.filter((t) => !t.cohortOnly).map((t) => t.tenantId);
  void runLoop(current, plan.targets, customers)
    .catch((err: unknown) => {
      console.error('[naverIndex] 실행이 예외로 멈췄습니다:', err);
      if (current) current.stoppedBy = `예기치 못한 오류로 멈췄어요 — ${err instanceof Error ? err.message : String(err)}`;
    })
    .finally(() => {
      if (current) current.endedAt = new Date().toISOString();
      running = false;
    });
  return { total: plan.targets.length };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 블로그 → 웹문서 순으로 찾는다. 찾으면 true, 둘 다 없으면 false. */
async function findOnNaver(t: NaverTarget): Promise<boolean> {
  if (naverResultHas(t.key, await naverSearch('blog', t.query))) return true;
  await sleep(GAP_MS);
  return naverResultHas(t.key, await naverSearch('webkr', t.query));
}

async function runLoop(run: NaverRunView, targets: readonly NaverTarget[], customers: readonly string[]): Promise<void> {
  let streak = 0;
  for (const t of targets) {
    const base = { key: t.key, tenantId: t.tenantId, postId: t.postId, rowName: t.rowName };
    let found: boolean;
    try {
      found = await findOnNaver(t);
      streak = 0;
    } catch (err) {
      if (!(err instanceof NaverSearchError)) throw err;
      if (err.kind === 'timeout' || err.kind === 'upstream') {
        streak += 1;
        run.unknown += 1;
        run.done += 1;
        run.items.push({ ...base, outcome: 'unknown', reason: err.message });
        if (streak >= STREAK_STOP) {
          run.stoppedBy = '네이버 검색이 잇따라 답하지 않거나 오류를 내 멈췄어요 — 잠시 뒤 다시 눌러 주세요.';
          return;
        }
        await sleep(GAP_MS);
        continue;
      }
      run.stoppedBy = err.message;
      return;
    }
    const state = found ? 'shown' : 'not-yet';
    try {
      const others = customers.filter((id) => id !== t.tenantId);
      const r = await writeIndexCheck(t.tenantId, t.postId, 'naver', state, others, Date.now(), 'auto', { expectRawCheckedAt: t.expectRawCheckedAt });
      if ('skipped' in r) {
        run.skipped += 1;
        run.items.push({ ...base, outcome: 'skipped', reason: r.skipped === 'changed' ? '확인하는 사이 표시가 바뀜' : '이미 노출됨' });
      } else {
        if (found) run.shown += 1;
        else run.notYet += 1;
        run.items.push({ ...base, outcome: state });
      }
    } catch (err) {
      if (err instanceof IndexChecksError && (err.status === 404 || err.status === 409)) {
        run.skipped += 1;
        run.items.push({ ...base, outcome: 'skipped', reason: '줄이 빠짐' });
      } else {
        console.error('[naverIndex] 확인을 적지 못해 멈춥니다:', err);
        run.stoppedBy = `확인 파일을 적지 못해 멈췄어요 — ${err instanceof Error ? err.message : String(err)}`;
        return;
      }
    }
    run.done += 1;
    await sleep(GAP_MS);
  }
}
