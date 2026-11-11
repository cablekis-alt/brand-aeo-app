import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AIO_RUN_ID,
  GOOGLE_AIO_FORMAT,
  GOOGLE_AIO_SETTINGS_FORMAT,
  addJudgeTokens,
  aioBankLabel,
  aioConditionSignature,
  aioConditions,
  aioCoverage,
  aioDayText,
  aioEnoughMeasured,
  aioFollowUpParams,
  aioItemOf,
  aioJudgeLabel,
  aioLocationFor,
  aioMaxSearches,
  aioParamsFit,
  aioPostRows,
  aioPostsUpDuring,
  aioQuestionSet,
  aioQuestionsOf,
  aioReSearchCap,
  aioRemaining,
  aioResumeProblem,
  aioRunId,
  aioSearchParams,
  aioSettleInFlight,
  aioSourceMarks,
  aioView,
  parseAioRun,
  parseAioSettings,
  readAioFirst,
  readAioFollowUp,
  readMentionVerdict,
  sourceOnlyOf,
  summarizeAioRun,
  type AioFailedReason,
  type AioItem,
  type AioJudgeTokens,
  type AioMentionVerdict,
  type AioPost,
  type AioQuestionSet,
  type AioReadContext,
  type AioReadResult,
  type AioResumeProblem,
  type AioRun,
  type AioRunState,
  type AioRunSummary,
  type AioSettings,
  type AioSourceMark,
  type AioUnreadableReason,
  type AioView,
} from '../src/lib/googleAio.js';
import { planArticleOf } from '../src/lib/publishStatus.js';
import { kstDate, todayKst } from '../src/lib/publishedUrl.js';
import { buildBrandMentionPrompt } from '../src/prompts/b5a-brand-mention.js';
import type { BrandContext, PromptMessage, QuestionCategory } from '../src/prompts/types.js';
import { PIPELINE_DATA_DIR, stateFilePath } from './appPaths.js';
import { cohortKey } from './cohortQuestionBank.js';
import { ENGINE_ENV } from './engineKeys.js';
import { getJudgeClient, usedJudgeEngineId } from './engines/index.js';
import type { EngineCallResult } from './engines/types.js';
import { readExternalPostsInQueue } from './externalPosts.js';
import { parseJsonLoose } from './jsonParse.js';
import { measureInFlight } from './measureTracker.js';
import { readProbePlan } from './probePlanStore.js';
import { readPublishedPostsInQueue } from './publishedPosts.js';
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
import { FileResultStore } from './store.js';
import { queueTenantWrite, writeJsonAtomic } from './tenantWriteQueue.js';
import type { TenantConfig } from './types.js';
import { thoughtTokensOf } from './usageStats.js';

/**
 * 구글 AI 개요 시범 실행기 — 점수에 세는 이름 없는 질문을 SerpAPI 구글 검색으로 묻고, AI 개요가 떴는지 · 그 안에 이 브랜드가 나오는지를
 * data/<브랜드>/google-aio/<회차 id>.json에 적는다(규칙: src/lib/googleAio.ts, 검색 · 몫 · 장부 · 잠금: server/serpApi.ts). 점수 · 정기진단
 * 보고서 · 전주 비교 · 회차 기록(runs/)과 격리한다 — 그쪽 모듈은 이 파일을 불러오지 않고(scripts/verify-google-aio.ts 정적 검사), 이 파일은
 * 원장 · 앱 밖 글 · 배정 파일을 읽기만 한다.
 *
 * - 이 PC 스위치(stateFilePath('google-aio-settings.json'), 기본 끔): 키가 모든 설치본에 들어가므로 다른 PC가 실수로 돈을 쓰지 않게 한다.
 *   PUT은 enabled 하나만 받는다. 시범 브랜드(tenants) · 위치 덮어쓰기(locations)는 파일로만 고친다(없으면 web4ai 하나).
 * - 사람이 단추를 눌러야 돈다: 계획(planGoogleAio — 검색 0, 계정 account.json만 무료로 새로 읽어 질문 수 · 최대 검색 M · 이번 결제 주기 AI 개요
 *   몫 · 계정 바닥 · 시간당 남은 수 · 판정 엔진을 보인다, 계획 id는 서버 메모리에 10분) → 실행(startGoogleAio — 그 계획 id로만). 남은 몫이 M보다
 *   적으면 회차를 줄이지 않고 시작하지 않는다(일부만 잰 회차는 비교에 못 쓴다). 측정이 도는 중이면 재지 않는다(G3 — 판정 빈 응답 계수를 함께 쓴다).
 * - 실행 잠금(SerpAPI 공용 'aio')을 잡은 뒤 다시 본다: 이 PC 켜짐 · 시범 브랜드 · 측정 중 아님 · 판정 엔진(키가 있고 클라이언트가 만들어짐) ·
 *   질문 지문 · 조건 서명이 계획과 같음 · 계정을 새로 읽어 AI 개요 몫이 M 이상. 하나라도 어긋나면 잠금을 놓고 409(검색 0).
 * - 차례(executeAioRun — 검색 · 판정을 주입받는다): 질문 하나 → 첫 검색 → (늦게 오는 개요면 곧바로 후속 engine=google_ai_overview) → 못 읽음이면
 *   1번 다시 검색(회차당 질문의 10%까지) → 있음이면 판정(b5a 1회, 자르기 전 본문) → 문항마다 회차 파일에 적는다(판정 앞뒤 두 번). 검색마다
 *   보내기 전에 회차 검색 수를 올리고 날아가는 검색(inFlight)을 함께 적는다(장부와 같은 규칙 — 앱이 꺼져도 보낸 검색을 센다). 보낸 검색은 M을
 *   넘지 않는다. 판정을 못 읽으면 mentioned null(판정 불가 — 미언급으로 세지 않는다), 판정이 3번 잇따라 실패하면 검색을 멈춘다('partial').
 *   판정 빈 응답 계수(브랜드 측정의 판정 차단기)는 되돌리지 않는다 — 되돌리는 것은 측정 시작뿐이다. 끝까지 갔어도 잰 문항이 90% 미만이면
 *   'done'이 아니라 'partial'(coverage — 요약 · 추이에 쓰지 않는다).
 * - 멈춤: 401 · 403 · 400 · 429(결제 주기 소진 · 시간당) · 계정 · 장부 · 몫 · 바닥 · 시간당에서 바로(남은 질문 0회), 시간 초과 · 5xx가 3번 잇따르면.
 *   시간 초과는 다시 보내지 않는다(이미 과금됐을 수 있다). 몫 · 바닥에 막혀 후속을 못 보낸 질문은 「못 읽음」. 후속이 HTTP 400이면(만료된
 *   page_token — 길이 초과는 보내기 전에 aioParamsFit이 가른다) 그 질문만 「못 읽음(follow-up-failed)」으로 두고 다음 질문으로 간다 — 다만
 *   잇따름에 세어 3번 잇따르면 멈춘다(2026-11-11 사용자 결정 ②). 첫 검색의 400은 그대로 바로 멈춘다. 중단 · 이 PC 끔 · 브랜드 측정 시작(G3)은
 *   다음 검색 전에 본다.
 * - 끊긴 회차: 실행기 없이 'running'인 파일은 GET에서 'interrupted'로만 보이고(읽기 길에서는 쓰지 않는다), 다음 시작 · 다시 판정 때 한 번 고친다
 *   — 날아가던 검색의 질문은 「못 읽음(interrupted)」으로 마무리한다(보낸 검색은 셌고 다시 보내지 않는다). 다른 창이 AI 개요 잠금을 쥐고 있으면
 *   그 창의 회차일 수 있어 끊김으로 보이지 않는다. 이어 재기는 같은 한국 날짜 · 같은 조건 서명 · 같은 판정 엔진(회차를 시작할 때의 엔진 —
 *   2026-11-11 사용자 결정 ③) · 같은 질문 지문인 멈춘 회차의 남은 질문만 보낸다(이중 과금 없음).
 * - 읽기: 회차 파일 · 원장 · 앱 밖 글 · 배정 파일은 브랜드 쓰기 줄(queueTenantWrite) 안에서 읽는다. 자사 · 올린 글 출처는 저장하지 않고 읽을 때
 *   계산한다(자사 주소 · 원장을 고치면 지난 회차에도 바로 적용). 작성자는 배정 글의 키(w1~w8)만 옮긴다. 도는 동안 상태 GET은 메모리의 진행만
 *   준다(2초마다 원장을 읽지 않는다 — 화면을 새로 열었을 때만 ?view=1로 한 번 읽는다).
 * - 다시 판정: 저장된 본문으로 판정만 다시(검색 0) — 그 회차가 돌지 않고(이 서버 · 준비 중 · 다른 창) 다른 다시 판정이 없을 때만. 판정마다 회차
 *   파일을 새로 읽어 판정 칸만 더해 쓰고, 그 사이 회차가 도는 중이 되거나 문항이 바뀌었으면(다른 창의 이어 재기) 멈춘다 — 이미 낸 검색 기록을
 *   덮지 않는다.
 * - 웹(Vercel)에는 라우트가 없다(함수 12/12) — 화면은 404를 「데스크톱 앱에서 볼 수 있습니다」로 읽는다.
 */

const SETTINGS_FILE = stateFilePath('google-aio-settings.json');
const SETTINGS_LOCK = 'google-aio-settings/*';
const RUN_DIR = 'google-aio';
/** 회차 폴더에서 받는 파일 이름 — 쓰다 만 임시 파일(…json.<pid>.<uuid>.tmp)은 거른다. */
const RUN_FILE = /^[\w-]+\.json$/;
const PLAN_TTL_MS = 10 * 60_000;
/** 시간 초과 · 응답 오류가 이만큼 잇따르면 멈춘다. */
const STREAK_STOP = 3;
/** 판정이 이만큼 잇따라 실패하면 멈춘다(검색비만 쓰지 않게). */
const JUDGE_STOP = 3;
/** 지난 회차가 이 날 수 안이면 확인창이 한 줄 더 알린다(2주에 한 번은 사람이 지키는 규칙). */
const RECENT_DAYS = 14;
/** 확인창의 걸리는 시간 어림 — 검색 하나(1초 간격 포함)와 판정 하나의 초[추론]. */
const SEARCH_SECONDS = 5;
const JUDGE_SECONDS = 4;
/**
 * 요금제 월 요금(USD) — 2026-11-10 SerpAPI 요금 열람값. 확인창의 「이미 낸 요금 안 · 검색당 환산」에만 쓴다(몫 · 상한에는 쓰지 않는다 — 몫은
 * 계정의 월 검색 수 비율). 모르는 요금제면 환산하지 않는다(null).
 */
const PLAN_PRICE_USD: Readonly<Record<string, number>> = { Free: 0, Starter: 25, Developer: 75, Production: 150, 'Big Data': 275 };

/**
 * 계정의 요금제 이름(account.json plan_name) → 월 요금(USD). 실제 응답은 「Starter Plan」처럼 끝에 「Plan」이 붙어 와서(2026-11-10 계정 확인)
 * 표의 이름과 바로 맞지 않았다 — 끝의 「Plan」을 떼고 대소문자 · 띄어쓰기를 접어 맞춘다. 모르는 요금제면 null(환산하지 않는다).
 */
export function aioPlanPriceUsd(planName: string | null | undefined): number | null {
  const fold = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const name = fold(planName ?? '').replace(/\s*plan$/, '');
  if (!name) return null;
  const hit = Object.entries(PLAN_PRICE_USD).find(([k]) => fold(k) === name);
  return hit ? hit[1] : null;
}

/** 다시 검색하는 못 읽음 — 응답은 받았는데 내용이 비었거나 깨진 것. 토큰이 너무 김 · 후속 요청 실패(시간 초과 · HTTP 오류) · 몫에 막힘은 하지 않는다. */
const RESEARCHABLE: ReadonlySet<AioUnreadableReason> = new Set(['overview-error', 'overview-empty', 'overview-shape', 'follow-up-error', 'follow-up-empty', 'follow-up-shape']);

const SETTINGS_BROKEN = '이 PC의 구글 AI 개요 시범 설정 파일(google-aio-settings.json)이 깨져 있어 시작하지 않았어요';
/** 설정 파일이 깨졌을 때의 글 — 까닭과 고치는 길(파일 위치 · 지우면 꺼짐으로 돌아감). */
const settingsBroken = (detail: string | null) =>
  `${SETTINGS_BROKEN}${detail ? ` — ${detail}` : ''}. 파일(${SETTINGS_FILE})을 바로잡거나 지워 주세요 — 지우면 「꺼짐」(기본)으로 돌아가요.`;
const PILOT_OFF = '이 PC에서는 구글 AI 개요 시범 측정을 켜지 않았어요 — 「이 PC에서 켜기」를 먼저 눌러 주세요.';
const NOT_PILOT = '이 브랜드는 시범 대상이 아니에요.';
const MEASURING = '브랜드 측정이 도는 중이라 시작하지 않았어요 — 측정이 끝난 뒤 다시 눌러 주세요(판정 엔진을 함께 써요).';
const MEASURE_FIRST = '이 브랜드의 질문지가 이 PC에 없어요 — 측정을 한 번 한 뒤 재세요.';
const PLAN_CHANGED = '계획이 바뀌었어요 — 계획을 다시 받아 주세요.';
const BUSY = '이미 구글 AI 개요 시범이 도는 중이에요 — 끝난 뒤 다시 눌러 주세요.';
const BUSY_ELSEWHERE = '이 PC에서 앱이 한 번 더 켜져 있고, 그쪽에서 SerpAPI 작업(구글 AI 개요 시범 등)이 도는 중이에요 — 끝난 뒤 다시 눌러 주세요.';
const REJUDGE_BUSY = '다시 판정이 이미 도는 중이에요 — 끝난 뒤 다시 눌러 주세요.';
const RUN_NOT_FOUND = '그 회차를 찾지 못했어요.';
const ACCOUNT_UNREAD = 'SerpAPI 계정 · 사용 기록을 읽지 못해 시작하지 않았어요.';
const RESUME_TEXT: Record<AioResumeProblem, string> = {
  'not-stopped': '이 회차는 멈춘 회차가 아니라 이어 잴 수 없어요.',
  'other-day': '오늘 시작한 회차만 이어 잴 수 있어요 — 날이 바뀌었으면 새 회차로 재 주세요.',
  conditions: '검색 조건(위치 등)이 그 회차와 달라 이어 잴 수 없어요 — 새 회차로 재 주세요.',
  'judge-engine': '판정 엔진이 그 회차를 시작할 때와 달라 이어 잴 수 없어요 — 한 회차 안에서 언급 판정 기준이 섞이지 않게, 새 회차로 재 주세요.',
  questions: '질문지가 그 회차와 달라 이어 잴 수 없어요 — 새 회차로 재 주세요.',
  'nothing-left': '이 회차는 남은 질문이 없어요.',
};
const STOP_TEXT = {
  cancelled: '중단했어요 — 받은 검색은 남겼어요.',
  pilotOff: '이 PC에서 시범 측정을 꺼서 멈췄어요 — 받은 검색은 남겼어요.',
  streak: 'SerpAPI가 3번 잇따라 답하지 않거나 오류를 내 멈췄어요 — 잠시 뒤 「이어 재기」를 눌러 주세요(오늘 안).',
  judge: '판정 엔진이 3번 잇따라 답하지 않아 검색을 멈췄어요 — 받은 개요는 저장했어요. 판정 엔진을 확인한 뒤 「다시 판정」을 눌러 주세요.',
  internal: '앱 오류로 멈췄어요 — 받은 검색은 남겼어요.',
  interrupted: '앱이 꺼져 멈춘 회차예요 — 받은 검색만 남았어요.',
  measuring: '브랜드 측정이 시작돼 멈췄어요(판정 엔진을 함께 써요) — 받은 검색은 남겼어요. 측정이 끝난 뒤 「이어 재기」를 눌러 주세요(오늘 안).',
} as const;
/** 끝까지 갔지만 잰 문항이 90% 미만 — 요약 · 추이에 쓰지 않는다(늦게 오는 개요 장애가 노출 0%로 오르지 않게). */
const coverageText = (c: { planned: number; measured: number; unreadable: number; failed: number }) =>
  `잰 질문이 ${c.measured}/${c.planned}개라(90% 미만) 요약 · 추이에 쓰지 않아요 — 못 읽음 ${c.unreadable}개 · 오류 ${c.failed}개. 회차 자세히에서 까닭을 확인해 주세요.`;
const REJUDGE_STOP = {
  judge: '판정 엔진이 3번 잇따라 답하지 않아 멈췄어요(판정 엔진을 확인해 주세요).',
  changed: '그 사이 회차가 바뀌어(다른 창의 이어 재기 등) 멈췄어요 — 받은 검색 · 문항은 그대로예요. 끝난 뒤 다시 판정해 주세요.',
  measuring: '브랜드 측정이 시작돼 멈췄어요 — 측정이 끝난 뒤 다시 판정해 주세요.',
} as const;
const RUN_STARTING = '그 회차를 이어 재려고 준비하는 중이에요 — 끝난 뒤 다시 판정해 주세요.';

export type GoogleAioErrorCode = 'plan-changed' | 'busy' | 'busy-elsewhere' | 'limit' | 'pilot-off' | 'not-pilot' | 'measuring' | 'judge' | 'resume' | 'not-running';

/** 라우트가 그대로 상태 코드로 쓰는 오류 — 409는 code로 화면이 할 일을 고른다. */
export class GoogleAioError extends Error {
  readonly status: number;
  readonly code: GoogleAioErrorCode | null;
  constructor(message: string, status: number, code: GoogleAioErrorCode | null = null) {
    super(message);
    this.name = 'GoogleAioError';
    this.status = status;
    this.code = code;
  }
}

/** 경로에 넣어도 되는 회차 id인가(라우트가 파일에 닿기 전에 본다). */
export function isAioRunId(v: unknown): v is string {
  return typeof v === 'string' && AIO_RUN_ID.test(v);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const errText = (err: unknown) => scrubSerpKey(err instanceof Error ? err.message : String(err)).slice(0, 300);

function bodyOf(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(body)) throw new GoogleAioError('본문은 JSON 객체여야 해요.', 400);
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length > 0) throw new GoogleAioError(`받지 않는 칸이 있어요: ${extra.join(', ')}`, 400);
  return body;
}

// ── 이 PC 설정 ────────────────────────────────────────────────────────────────

/** 줄 안에서 읽는다 — 없으면 기본(꺼짐), 못 읽거나 모양이 틀리면 500(켜짐으로 짐작하지 않고, 덮어쓰지 않는다). */
async function readSettingsInLock(): Promise<{ raw: unknown; settings: AioSettings }> {
  let text: string | null = null;
  try {
    text = await readFile(SETTINGS_FILE, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw new GoogleAioError(settingsBroken(`읽기 오류 ${code ?? ''}`.trim()), 500);
  }
  let raw: unknown;
  if (text !== null) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new GoogleAioError(settingsBroken('JSON을 읽지 못했어요'), 500);
    }
  }
  const parsed = parseAioSettings(raw);
  if (!parsed.ok) throw new GoogleAioError(settingsBroken(parsed.error), 500);
  return { raw, settings: parsed.settings };
}

function readSettings(): Promise<AioSettings> {
  return queueTenantWrite(SETTINGS_LOCK, async () => (await readSettingsInLock()).settings);
}

/** 이 PC 켜기 · 끄기 — 본문은 { enabled }만. 파일의 다른 칸(시범 브랜드 · 위치)은 그대로 둔다. */
export async function saveGoogleAioSettings(body: unknown): Promise<{ settings: { enabled: boolean } }> {
  const input = bodyOf(body, ['enabled']);
  if (typeof input.enabled !== 'boolean') throw new GoogleAioError('enabled는 true · false여야 해요.', 400);
  const enabled = input.enabled;
  return queueTenantWrite(SETTINGS_LOCK, async () => {
    const { raw } = await readSettingsInLock();
    await writeJsonAtomic(SETTINGS_FILE, { ...(isRecord(raw) ? raw : {}), format: GOOGLE_AIO_SETTINGS_FORMAT, enabled });
    return { settings: { enabled } };
  });
}

// ── 시범 브랜드 · 질문 · 판정 엔진 ──────────────────────────────────────────────

type Pilot = { ok: true; location: string | null; signature: string } | { ok: false; message: string };

/** 시범 대상인가 — 이 PC 설정의 브랜드 · 한국어 질문 · 검색 위치가 정해진 지역. */
function pilotOf(tenant: TenantConfig, settings: AioSettings): Pilot {
  if (!settings.tenants.includes(tenant.tenantId)) return { ok: false, message: NOT_PILOT };
  if (tenant.questionLanguage === 'en') return { ok: false, message: `${NOT_PILOT}(영어 질문 브랜드)` };
  const loc = aioLocationFor({ tenantId: tenant.tenantId, region: tenant.region, marketScope: tenant.marketScope }, settings.locations);
  if (!loc.ok) return { ok: false, message: `${NOT_PILOT}(지역 「${loc.region}」의 구글 검색 위치가 정해져 있지 않아요)` };
  return { ok: true, location: loc.location, signature: aioConditionSignature(loc.location) };
}

interface QuestionPick {
  bankVersion: string;
  cohortBank: { key: string; version: string } | null;
  questions: { questionId: string; text: string }[];
  set: AioQuestionSet;
}

const store = new FileResultStore();

/**
 * 측정이 쓰는 판(tenant.questionBankVersion)의 점수에 세는 이름 없는 질문. 판 목록을 먼저 본다 — getQuestionBank는 없는 판이면 동봉 질문지를
 * 이 PC로 복사하므로 부르지 않고, 있는 파일만 직접 읽는다(쓰기 0). 코호트 질문지를 쓰는 브랜드는 은행의 코호트 출처가 지금 코호트와 같아야 한다.
 */
async function pickQuestions(tenant: TenantConfig): Promise<{ ok: true; pick: QuestionPick } | { ok: false; message: string }> {
  const version = tenant.questionBankVersion;
  const versions = await store.listQuestionBankVersions(tenant.tenantId);
  if (!versions.includes(version)) return { ok: false, message: MEASURE_FIRST };
  const file = path.join(PIPELINE_DATA_DIR, tenant.tenantId, 'question-bank', `${version}.json`);
  let bank: unknown;
  try {
    bank = JSON.parse(await readFile(file, 'utf-8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, message: MEASURE_FIRST };
    return { ok: false, message: `질문지 파일(${version})을 읽지 못해 시작하지 않았어요.` };
  }
  if (!isRecord(bank) || !Array.isArray(bank.questions)) return { ok: false, message: `질문지 파일(${version})의 모양이 맞지 않아 시작하지 않았어요.` };
  const cb = isRecord(bank.cohortBank) && typeof bank.cohortBank.key === 'string' && typeof bank.cohortBank.version === 'string' ? { key: bank.cohortBank.key, version: bank.cohortBank.version } : null;
  if (tenant.cohortQuestionBank && (cb?.key !== cohortKey(tenant.industry, tenant.region) || cb.version !== tenant.cohortQuestionBank)) {
    return { ok: false, message: `${MEASURE_FIRST}(질문지가 지금 코호트 질문지와 맞지 않아요)` };
  }
  const questions = aioQuestionsOf(
    bank.questions.filter((q): q is { questionId: string; text: string; category: QuestionCategory; probe?: boolean } => isRecord(q) && typeof q.questionId === 'string' && typeof q.text === 'string' && typeof q.category === 'string'),
  ).map((q) => ({ questionId: q.questionId, text: q.text.trim() }));
  if (questions.length === 0) return { ok: false, message: '이 질문지에는 점수에 세는 이름 없는 질문이 없어요.' };
  return { ok: true, pick: { bankVersion: version, cohortBank: cb, questions, set: aioQuestionSet(questions) } };
}

/** 판정에 넘기는 브랜드 — 측정의 toBrandContext는 내보내지 않아 여기서 직접 만든다. */
function brandOf(tenant: TenantConfig): BrandContext {
  return {
    brandName: tenant.brandName,
    aliases: [...tenant.aliases],
    ownedDomains: [...tenant.ownedDomains],
    competitors: tenant.competitors.map((c) => ({ name: c.name, aliases: [...c.aliases], domains: [...c.domains] })),
    industry: tenant.industry,
    region: tenant.region,
    ...(tenant.marketScope ? { marketScope: tenant.marketScope } : {}),
    ...(tenant.buyer ? { buyer: tenant.buyer } : {}),
  };
}

export interface GoogleAioJudgeState {
  engine: string;
  label: string;
  ready: boolean;
  problem: string | null;
}

/** 판정 엔진 — 해석된(또는 이미 만든) 엔진의 키가 있어야 한다(목 엔진 제외). 키 값은 보지 않고 있는지만 본다. */
function judgeState(): GoogleAioJudgeState {
  const engine = usedJudgeEngineId();
  const label = aioJudgeLabel(engine);
  if (engine !== 'mock' && !(process.env[ENGINE_ENV[engine]] ?? '').trim()) {
    return { engine, label, ready: false, problem: `판정 엔진(${label}) 키가 이 PC에 없어 시작하지 않아요 — 판정 없이 검색비만 쓰지 않게요.` };
  }
  return { engine, label, ready: true, problem: null };
}

/** 실행 · 다시 판정에 쓸 판정 — 키가 있고 클라이언트가 만들어져야 한다(아니면 409 judge). */
function judgeOrError(): { judge: AioJudgeFn; judgeEngine: string } {
  const state = judgeState();
  if (!state.ready) throw new GoogleAioError(state.problem ?? '판정 엔진을 쓸 수 없어요.', 409, 'judge');
  try {
    const client = getJudgeClient();
    return { judge: (prompt) => client.call(prompt), judgeEngine: usedJudgeEngineId() };
  } catch (err) {
    throw new GoogleAioError(`판정 엔진(${state.label})을 준비하지 못해 시작하지 않았어요 — ${errText(err)}`, 409, 'judge');
  }
}

// ── 회차 파일 ─────────────────────────────────────────────────────────────────

function runFile(tenantId: string, runId: string): string {
  if (!isAioRunId(runId)) throw new GoogleAioError('회차 id가 올바르지 않아요.', 400);
  return path.join(PIPELINE_DATA_DIR, tenantId, RUN_DIR, `${runId}.json`);
}

/** 회차 파일 하나 쓰기 — 브랜드 쓰기 줄 안에서 원자적으로. */
function saveRun(run: AioRun): Promise<void> {
  const file = runFile(run.tenantId, run.runId);
  return queueTenantWrite(run.tenantId, () => writeJsonAtomic(file, run));
}

/** 줄 안에서 이 브랜드의 회차 파일을 모두 읽는다. 못 읽은 파일은 숨기지 않고 센다(「읽지 못한 회차 n개」). */
async function readRunsInQueue(tenantId: string): Promise<{ runs: AioRun[]; unreadable: number }> {
  const dir = path.join(PIPELINE_DATA_DIR, tenantId, RUN_DIR);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { runs: [], unreadable: 0 };
    throw err;
  }
  const runs: AioRun[] = [];
  let unreadable = 0;
  for (const name of names.sort()) {
    if (!RUN_FILE.test(name)) continue;
    let problem: string;
    try {
      const parsed = parseAioRun(JSON.parse(await readFile(path.join(dir, name), 'utf-8')));
      if (parsed.ok && `${parsed.run.runId}.json` === name && parsed.run.tenantId === tenantId) {
        runs.push(parsed.run);
        continue;
      }
      problem = parsed.ok ? '파일 이름 · 브랜드가 회차와 맞지 않음' : parsed.error;
    } catch (err) {
      problem = errText(err);
    }
    unreadable += 1;
    console.warn(`[googleAio] ${tenantId}/${RUN_DIR}/${name}을 읽지 못했습니다(읽지 못한 회차로 셉니다): ${problem}`);
  }
  return { runs, unreadable };
}

/** 줄 안에서 회차 하나를 읽는다 — 없으면 null, 모양이 틀리면 500. */
async function readRunInQueue(tenantId: string, runId: string): Promise<AioRun | null> {
  let text: string;
  try {
    text = await readFile(runFile(tenantId, runId), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new GoogleAioError(`회차 파일을 읽지 못했어요(${(err as NodeJS.ErrnoException).code ?? '읽기 오류'}).`, 500);
  }
  let parsed: ReturnType<typeof parseAioRun>;
  try {
    parsed = parseAioRun(JSON.parse(text));
  } catch {
    throw new GoogleAioError('회차 파일이 깨져 있어 읽지 못했어요.', 500);
  }
  if (!parsed.ok || parsed.run.runId !== runId || parsed.run.tenantId !== tenantId) throw new GoogleAioError(`회차 파일을 읽지 못했어요 — ${parsed.ok ? '회차 id가 맞지 않아요' : parsed.error}.`, 500);
  return parsed.run;
}

// ── 지금 도는 일(이 프로세스) ─────────────────────────────────────────────────────

interface ActiveRun {
  tenantId: string;
  runId: string;
  run: AioRun;
  resumed: boolean;
  planned: number;
  done: number;
  cancel: boolean;
  /** 이번 실행을 시작할 때의 회차 검색 수 · 문항 수 — 이어 재기 진행은 「이번에」 보낸 수 · 받은 문항으로 보인다(확인창의 최대 검색과 같은 기준). */
  searchesAtStart: number;
  itemsAtStart: number;
  /** 이번 실행의 최대 검색(새 회차 = M, 이어 재기 = 계획의 최대 검색). */
  budget: number;
}
let active: ActiveRun | null = null;
/**
 * 실행 잠금을 잡고 회차를 준비하는 동안(계정을 새로 읽느라 몇 초 걸린다) — active가 아직 없어도 이 표시로 같은 회차의 다시 판정 · 두 번째 시작을
 * 막는다(준비 중에 다시 판정이 옛 사본을 들고 들어가 이어 재기 결과를 덮지 않게).
 */
let starting: { tenantId: string; resumeRunId: string | null } | null = null;

interface Rejudging {
  tenantId: string;
  runId: string;
  total: number;
  done: number;
}
let rejudging: Rejudging | null = null;
let lastRejudge: { tenantId: string; runId: string; judged: number; failed: number; stopped: boolean; stopMessage: string | null; at: string } | null = null;

/** 다른 서버(앱을 두 번 켬)가 SerpAPI 실행 잠금을 쥐었으면 그 기능. 잠금 파일을 못 읽으면 누가 쥐었는지 모르니 쥔 것으로 본다(막힌 쪽). */
async function elsewhereFeature(): Promise<string | null> {
  try {
    return await serpRunElsewhere();
  } catch (err) {
    console.warn('[googleAio] SerpAPI 실행 잠금을 읽지 못했습니다 — 다른 서버가 쥔 것으로 봅니다:', errText(err));
    return 'unknown';
  }
}

/** 지금 시작하지 못하는 까닭(이 서버 · 다른 창에서 SerpAPI 실행이 도는 중). */
async function busyError(): Promise<GoogleAioError | null> {
  const holder = serpRunHolder();
  if (active || starting || holder === 'aio') return new GoogleAioError(BUSY, 409, 'busy');
  if (holder) return new GoogleAioError(`다른 SerpAPI 작업(${FEATURE_LABEL[holder]})이 도는 중이에요 — 끝난 뒤 다시 눌러 주세요.`, 409, 'busy');
  return (await elsewhereFeature()) !== null ? new GoogleAioError(BUSY_ELSEWHERE, 409, 'busy-elsewhere') : null;
}

/**
 * 실행기 없이 'running'인 회차(앱이 꺼져 끊김) — 다른 창이 AI 개요 잠금을 쥐었거나 누가 쥐었는지 모르면(잠금 파일을 못 읽음) 그 창의 회차일 수 있어
 * 끊김으로 보지 않는다.
 */
function isStale(run: AioRun, elsewhere: string | null): boolean {
  return (
    run.state === 'running' &&
    !(active && active.tenantId === run.tenantId && active.runId === run.runId) &&
    !(starting && starting.tenantId === run.tenantId) &&
    elsewhere !== 'aio' &&
    elsewhere !== 'unknown'
  );
}

/** 끊긴 회차를 고친 모양 — 날아가던 검색의 질문은 「못 읽음(interrupted)」으로 마무리한다(이어 재기가 다시 사지 않게). */
const interruptedOf = (run: AioRun): AioRun => ({ ...aioSettleInFlight(run), state: 'interrupted', stopReason: 'interrupted', stopMessage: STOP_TEXT.interrupted });

/** 읽기 길의 회차 — 끊긴 회차는 고친 모양으로만 보인다(파일은 고치지 않는다 — 다음 시작 · 다시 판정 때 한 번 고친다). */
const effective = (run: AioRun, elsewhere: string | null): AioRun => (isStale(run, elsewhere) ? interruptedOf(run) : run);

// ── 계정 · 몫 ─────────────────────────────────────────────────────────────────

/** 이번 결제 주기 AI 개요 몫 · 계정 숫자(어림 — 계정 값 − 그 뒤 이 PC가 보낸 수). 숫자는 계정 · 장부 값 그대로다. */
export interface GoogleAioQuota {
  cycle: string;
  cap: number;
  sent: number;
  left: number;
  /** 지금 더 보낼 수 있는 수(몫 · 계정 바닥 · 시간당 남은 수의 최솟값). 이것이 M 이상이어야 시작한다. */
  allowed: number;
  floor: number;
  accountLeft: number;
  aboveFloor: number;
  hourLeft: number;
  planName: string | null;
  searchesPerMonth: number | null;
  rateLimitPerHour: number | null;
  planRenewalDate: string | null;
}

function quotaOf(view: SerpApiAccountView): { quota: GoogleAioQuota | null; blocked: string | null } {
  const blocked = view.configError ?? view.accountError?.message ?? view.usageError ?? (view.usage ? null : ACCOUNT_UNREAD);
  if (!view.usage || !view.account) return { quota: null, blocked };
  const f = view.usage.features.aio;
  return {
    quota: {
      cycle: view.usage.cycle,
      cap: f.cap,
      sent: f.sent,
      left: f.left,
      allowed: f.allowed,
      floor: view.usage.floor,
      accountLeft: view.usage.accountLeft,
      aboveFloor: view.usage.aboveFloor,
      hourLeft: view.usage.hourLeft,
      planName: view.account.planName,
      searchesPerMonth: view.account.searchesPerMonth,
      rateLimitPerHour: view.account.rateLimitPerHour,
      planRenewalDate: view.account.planRenewalDate,
    },
    blocked,
  };
}

/** 몫이 M보다 적을 때의 까닭 — 숫자는 계정 · 장부에서 온 값 그대로. */
function limitMessage(q: GoogleAioQuota, need: number): string {
  if (q.left < need) return `이번 결제 주기 구글 AI 개요 몫이 ${q.left}회 남아(몫 ${q.cap}회) 한 회차(최대 ${need}회)를 시작하지 않았어요 — ${q.planRenewalDate ? aioDayText(q.planRenewalDate) : '다음 갱신일'}에 다시 채워져요.`;
  if (q.aboveFloor < need) return `계정에 남은 검색이 바닥(${q.floor}회) 위로 ${q.aboveFloor}회뿐이라 한 회차(최대 ${need}회)를 시작하지 않았어요 — 다른 PC · 다른 작업 몫이에요.`;
  if (q.hourLeft < need) return `이번 시간에 더 보낼 수 있는 검색이 ${q.hourLeft}회라 한 회차(최대 ${need}회)를 시작하지 않았어요 — 한 시간쯤 뒤 다시 눌러 주세요.`;
  return `지금 보낼 수 있는 검색이 ${q.allowed}회라 한 회차(최대 ${need}회)를 시작하지 않았어요.`;
}

/** 이어 재기에 드는 최대 검색 — 남은 질문 × 2 + 남은 다시 검색 몫 × 2, 그 회차의 M에서 이미 보낸 수를 뺀 것까지. */
function resumeNeed(run: AioRun): number {
  const remaining = aioRemaining(run).length;
  const reLeft = Math.max(0, aioReSearchCap(run.questionSet.ids.length) - run.usage.reSearches);
  return Math.min(2 * remaining + 2 * reLeft, Math.max(0, run.maxSearches - run.usage.searches));
}

// ── 실행기 핵심(주입 가능) ─────────────────────────────────────────────────────

export type AioSearchFn = (params: Record<string, string>) => Promise<{ json: Record<string, unknown> }>;
export type AioJudgeFn = (prompt: PromptMessage) => Promise<EngineCallResult>;

export interface AioRunnerDeps {
  /** 검색 한 번 — 기본은 공용 연결 serpSearch('aio', …)(실행 잠금 · 장부 · 몫 · 1초 간격). */
  search?: AioSearchFn;
  judge: AioJudgeFn;
  /** 판정 엔진 id — 문항 · 조건에 적는다. */
  judgeEngine: string;
  /** 다음 검색 전에 본다 — 참이면 더 보내지 않는다(중단). */
  cancelled?: () => boolean;
  /** 질문마다 본다 — 거짓이면 더 보내지 않는다(이 PC 끔). 기본은 설정 파일. */
  pilotOn?: () => Promise<boolean>;
  /** 질문마다 본다 — 참이면 더 보내지 않는다(브랜드 측정이 시작됨 — 판정 빈 응답 계수를 함께 쓰므로 G3를 도는 동안에도 지킨다). 기본 measureInFlight. */
  measuring?: () => boolean;
  /** 검색 보내기 직전 · 문항마다(판정 앞뒤) 부른다 — 기본은 회차 파일 쓰기. */
  save?: (run: AioRun) => Promise<void>;
  /** 질문 하나가 끝날 때마다(화면 진행). */
  progress?: (run: AioRun) => void;
}

/** 새 회차 기록(아직 아무것도 보내지 않음). maxSearches를 주지 않으면 M = 2n + 2⌈0.1n⌉. */
export function newAioRun(input: {
  tenantId: string;
  startedAt: Date;
  location: string | null;
  bankVersion: string;
  cohortBank: { key: string; version: string } | null;
  questions: readonly { questionId: string; text: string }[];
  maxSearches?: number;
  cycle: string | null;
  judgeEngine: string;
}): AioRun {
  const startedAt = input.startedAt.toISOString();
  const questionSet = aioQuestionSet(input.questions);
  return {
    format: GOOGLE_AIO_FORMAT,
    runId: aioRunId(input.startedAt),
    tenantId: input.tenantId,
    startedAt,
    finishedAt: null,
    state: 'running',
    stopReason: null,
    stopMessage: null,
    conditions: aioConditions({ startedAt, location: input.location, bankVersion: input.bankVersion, questionSet, judgeEngine: input.judgeEngine, judgeModel: null }),
    bankVersion: input.bankVersion,
    cohortBank: input.cohortBank,
    questionSet,
    maxSearches: input.maxSearches ?? aioMaxSearches(input.questions.length),
    cycle: input.cycle,
    usage: { searches: 0, followUps: 0, reSearches: 0, judgeCalls: 0, judgeTokens: { input: 0, output: 0, thought: 0 } },
    items: [],
  };
}

interface Stop {
  kind: string;
  message: string;
  state: AioRunState;
}

type SendOutcome =
  | { ok: true; json: Record<string, unknown> }
  | { ok: false; sent: boolean; stop: Stop | null; streak: boolean; failedReason: AioFailedReason; message: string; httpStatus: number | null };

/** 검색 오류 → 보냈는지 · 멈춤인지 · 잇따름에 세는지. 우리 쪽에서 막힌 것(몫 · 계정 · 장부 · 설정 · 요청 모양)은 보내지 않은 것이다. */
function failureOf(err: unknown): Omit<Extract<SendOutcome, { ok: false }>, 'ok'> {
  if (err instanceof SerpApiBudgetError) return { sent: false, stop: { kind: err.kind, message: err.message, state: 'partial' }, streak: false, failedReason: 'upstream', message: err.message, httpStatus: null };
  if (!(err instanceof SerpApiError)) throw err;
  const message = scrubSerpKey(err.message);
  if (err.kind === 'timeout' || err.kind === 'upstream') return { sent: true, stop: null, streak: true, failedReason: err.kind, message, httpStatus: err.httpStatus };
  const preSend = err.kind === 'no-key' || err.kind === 'config' || err.kind === 'account' || err.kind === 'ledger' || (err.kind === 'bad-request' && err.httpStatus === null);
  return { sent: !preSend, stop: { kind: err.kind, message, state: 'partial' }, streak: false, failedReason: 'upstream', message, httpStatus: err.httpStatus };
}

/**
 * 후속(늦게 오는 개요)이 보낸 뒤 HTTP 400으로 돌아왔는가 — 만료되거나 받지 않는 page_token이다(길이 초과는 보내기 전에 aioParamsFit이 거른다).
 * 그 질문만 「못 읽음」으로 두고 잇따름에 센다(2026-11-11 사용자 결정 ②). 첫 검색의 400은 요청 모양 문제라 그대로 바로 멈춘다.
 */
const isFollowUpTokenRejected = (f: Extract<SendOutcome, { ok: false }>): boolean => f.sent && f.stop?.kind === 'bad-request' && f.httpStatus === 400;

/**
 * 검색 한 번 — 회차의 M에 닿았으면 보내지 않는다. 보내기 전에 회차 검색 수를 올리고 날아가는 검색(inFlight)과 함께 회차 파일에 적는다(공용 장부와
 * 같은 규칙 — 앱이 응답 전에 꺼져도 보낸 검색을 센다, 이어 재기의 M 상한이 실제 보낸 수를 쓴다). 우리 쪽에서 막혀 보내지 않았으면 되돌린다.
 */
async function sendOnce(run: AioRun, search: AioSearchFn, params: Record<string, string>, beforeSend: () => Promise<void>): Promise<SendOutcome> {
  if (run.usage.searches >= run.maxSearches) {
    const message = `이 회차의 최대 검색 수(${run.maxSearches}회)에 닿아 멈췄어요.`;
    return { ok: false, sent: false, stop: { kind: 'max-searches', message, state: 'partial' }, streak: false, failedReason: 'upstream', message, httpStatus: null };
  }
  run.usage.searches += 1;
  await beforeSend();
  try {
    const { json } = await search(params);
    return { ok: true, json };
  } catch (err) {
    const f = failureOf(err);
    if (!f.sent) {
      run.usage.searches -= 1;
      if (run.inFlight) run.inFlight = { ...run.inFlight, searches: Math.max(0, run.inFlight.searches - 1) };
    }
    return { ok: false, ...f };
  }
}

interface QuestionStep {
  /** 끝 상태가 있는 문항 — null이면 이 질문은 남긴다(이어 재기 대상). */
  item: AioItem | null;
  /** 판정할 자르기 전 본문(있음일 때만). */
  text: string | null;
  stop: Stop | null;
  /** 시간 초과 · 응답 오류(잇따름에 센다) — null이면 응답을 받았다(잇따름을 되돌린다), undefined면 보내지 않았다(그대로). */
  streak: boolean | null | undefined;
}

/** 질문 하나 — 첫 검색 → (늦게 오는 개요면) 후속 → (못 읽음이면) 1번 다시 검색. 검색마다 보내기 전에 날아가는 검색을 적는다(save). */
async function searchQuestion(
  run: AioRun,
  q: { questionId: string; text: string },
  search: AioSearchFn,
  deps: AioRunnerDeps,
  canReSearch: () => boolean,
  save: (run: AioRun) => Promise<void>,
): Promise<QuestionStep> {
  const params = aioSearchParams(q.text, run.conditions.location);
  const ref = { questionId: q.questionId, query: params.q };
  const now = () => new Date().toISOString();
  if (!aioParamsFit(params)) return { item: aioItemOf(ref, { status: 'failed', reason: 'bad-query', topKeys: [], searchId: null }, { fetchedAt: now(), searches: 0 }), text: null, stop: null, streak: undefined };
  let searches = 0;
  let previous: AioItem | null = null;
  /** 보내기 직전 — 이 질문에 보낸 검색(이번 것 포함)을 날아가는 검색으로 적는다. */
  const beforeSend = () => {
    run.inFlight = { questionId: q.questionId, query: params.q, searches: searches + 1, at: now() };
    return save(run);
  };
  const send = (p: Record<string, string>) => sendOnce(run, search, p, beforeSend);
  /** 다시 검색이 실패하면 앞의 「못 읽음」을 그 문항의 끝 상태로 둔다(그 사이 보낸 검색 수까지). */
  const keepPrevious = (extra: { error?: string }): AioItem | null => (previous ? { ...previous, searches, ...(extra.error ? { error: extra.error.slice(0, 300) } : {}) } : null);
  for (;;) {
    const first = await send(params);
    if (!first.ok) {
      if (first.sent) searches += 1;
      if (first.stop) return { item: keepPrevious({ error: first.message }), text: null, stop: first.stop, streak: undefined };
      const failed = aioItemOf(ref, { status: 'failed', reason: first.failedReason, topKeys: [], searchId: null }, { fetchedAt: now(), searches, error: first.message });
      return { item: keepPrevious({ error: first.message }) ?? failed, text: null, stop: null, streak: true };
    }
    searches += 1;
    const read1 = readAioFirst(first.json);
    let read: AioReadResult;
    if (read1.step === 'follow-up') {
      const fparams = aioFollowUpParams(read1.pageToken);
      if (deps.cancelled?.()) return { item: keepPrevious({}), text: null, stop: { kind: 'cancelled', message: STOP_TEXT.cancelled, state: 'cancelled' }, streak: null };
      if (!aioParamsFit(fparams)) {
        read = { status: 'unreadable', reason: 'token-too-long', topKeys: [], searchId: read1.searchId };
      } else {
        const follow = await send(fparams);
        if (!follow.ok) {
          if (follow.sent) {
            searches += 1;
            run.usage.followUps += 1;
          }
          const reason: AioUnreadableReason = follow.sent ? 'follow-up-failed' : 'follow-up-blocked';
          const item = aioItemOf(ref, { status: 'unreadable', reason, topKeys: [], searchId: read1.searchId }, { fetchedAt: now(), searches, error: follow.message });
          if (isFollowUpTokenRejected(follow)) return { item, text: null, stop: null, streak: true };
          return { item, text: null, stop: follow.stop, streak: follow.stop ? undefined : follow.streak };
        }
        searches += 1;
        run.usage.followUps += 1;
        read = readAioFollowUp(follow.json);
      }
    } else {
      read = read1.read;
    }
    if (read.status === 'unreadable' && RESEARCHABLE.has(read.reason) && !previous && canReSearch()) {
      run.usage.reSearches += 1;
      previous = aioItemOf(ref, read, { fetchedAt: now(), searches });
      if (deps.cancelled?.()) return { item: keepPrevious({}), text: null, stop: { kind: 'cancelled', message: STOP_TEXT.cancelled, state: 'cancelled' }, streak: null };
      continue;
    }
    const item = aioItemOf(ref, read, { fetchedAt: now(), searches });
    return { item, text: read.status === 'shown' ? read.overview.text : null, stop: null, streak: null };
  }
}

/** 판정 한 번 — 실패(throw · 빈 답 · 못 읽음)면 verdict null. 토큰은 답을 받았으면 센다(생각 토큰 포함 — thoughtTokensOf와 같은 규칙). */
async function judgeOnce(deps: Pick<AioRunnerDeps, 'judge' | 'judgeEngine'>, brand: BrandContext, text: string) {
  let result: EngineCallResult;
  try {
    result = await deps.judge(buildBrandMentionPrompt(brand, text));
  } catch (err) {
    console.warn('[googleAio] 판정이 실패했습니다(판정 불가로 둡니다):', errText(err));
    return { verdict: null, tokens: {}, model: null };
  }
  const tokens = { input: result.inputTokens ?? 0, output: result.outputTokens ?? 0, thought: thoughtTokensOf({ engine: deps.judgeEngine, ...result }) };
  const model = typeof result.model === 'string' && result.model ? result.model : null;
  if (!result.text.trim()) return { verdict: null, tokens, model };
  const verdict: AioMentionVerdict = readMentionVerdict(parseJsonLoose<unknown>(result.text));
  return { verdict: verdict.mentioned === null ? null : verdict, tokens, model };
}

/**
 * 실행기 핵심 — 받은 질문을 차례로 재고 run을 고쳐 돌려준다(같은 객체). 검색 · 판정 · 저장 · 중단 확인을 주입받는다(같은 프로세스 시험). 이 함수는
 * 실행 잠금 · 계정 · 시작 조건을 보지 않는다 — 부르는 쪽(startGoogleAio)이 본다. 끝나면 state · finishedAt · 멈춘 까닭을 적고 저장한다.
 */
export async function executeAioRun(run: AioRun, questions: readonly { questionId: string; text: string }[], brand: BrandContext, deps: AioRunnerDeps): Promise<AioRun> {
  const search: AioSearchFn = deps.search ?? ((params) => serpSearch('aio', params));
  const save = deps.save ?? saveRun;
  const measuring = deps.measuring ?? measureInFlight;
  const reSearchCap = aioReSearchCap(run.questionSet.ids.length);
  let streak = 0;
  let judgeFails = 0;
  let stop: Stop | null = null;
  try {
    for (const q of questions) {
      if (deps.cancelled?.()) {
        stop = { kind: 'cancelled', message: STOP_TEXT.cancelled, state: 'cancelled' };
        break;
      }
      if (deps.pilotOn && !(await deps.pilotOn())) {
        stop = { kind: 'pilot-off', message: STOP_TEXT.pilotOff, state: 'cancelled' };
        break;
      }
      if (measuring()) {
        stop = { kind: 'measuring', message: STOP_TEXT.measuring, state: 'partial' };
        break;
      }
      const step = await searchQuestion(run, q, search, deps, () => run.usage.reSearches < reSearchCap, save);
      if (step.item) {
        run.items.push(step.item);
        run.inFlight = null;
        await save(run);
      }
      if (step.streak === true) streak += 1;
      else if (step.streak === null) streak = 0;
      if (step.stop) {
        stop = step.stop;
        break;
      }
      if (streak >= STREAK_STOP) {
        stop = { kind: 'streak', message: STOP_TEXT.streak, state: 'partial' };
        break;
      }
      // 본문이 빈 개요(출처만 옴)는 판정하지 않는다 — 판정할 글이 없다(판정 불가로 남는다).
      if (step.item && step.text !== null && step.text.trim()) {
        const item = step.item;
        const j = await judgeOnce(deps, brand, step.text);
        run.usage.judgeCalls += 1;
        run.usage.judgeTokens = addJudgeTokens(run.usage.judgeTokens, j.tokens);
        if (j.model && !run.conditions.judgeModel) run.conditions.judgeModel = j.model;
        item.mentioned = j.verdict ? j.verdict.mentioned : null;
        item.mentionSentences = j.verdict?.sentences ?? [];
        item.competitorMentions = j.verdict?.competitors ?? [];
        item.judgeEngine = deps.judgeEngine;
        item.judgeModel = j.model;
        item.judgedAt = new Date().toISOString();
        await save(run);
        judgeFails = j.verdict ? 0 : judgeFails + 1;
        if (judgeFails >= JUDGE_STOP) {
          stop = { kind: 'judge', message: STOP_TEXT.judge, state: 'partial' };
          break;
        }
      }
      deps.progress?.(run);
    }
  } catch (err) {
    stop = { kind: 'internal', message: STOP_TEXT.internal, state: 'partial' };
    console.error('[googleAio] 실행이 앱 오류로 멈췄습니다:', scrubSerpKey(err instanceof Error ? (err.stack ?? err.message) : String(err)));
  }
  const left = aioRemaining(run).length;
  // 멈춘 질문의 날아간 검색은 회차 검색 수에 이미 들었다 — 그 질문은 남겨 이어 재기 대상으로 둔다(첫 검색과 후속 사이 중단 등).
  run.inFlight = null;
  if (!stop && left === 0 && !aioEnoughMeasured(run)) stop = { kind: 'coverage', message: coverageText(aioCoverage(run)), state: 'partial' };
  run.state = stop ? stop.state : left === 0 ? 'done' : 'partial';
  run.stopReason = stop?.kind ?? null;
  run.stopMessage = stop ? scrubSerpKey(`${stop.message}${left > 0 ? ` 남은 ${left}문항은 재지 않았어요.` : ''}`) : null;
  run.finishedAt = new Date().toISOString();
  try {
    await save(run);
  } catch (err) {
    console.error('[googleAio] 회차를 마무리해 적지 못했습니다(끊긴 회차로 보입니다):', errText(err));
  }
  return run;
}

/** 다시 판정 한 건 — 회차 파일에 더할 판정 칸과 판정 사용량(문항은 질문 id · 받은 시각으로 찾는다). */
export interface AioRejudgePatch {
  questionId: string;
  fetchedAt: string;
  /** null이면 판정을 못 읽음 — 앞 판정을 지우지 않고 사용량만 더한다. */
  verdict: AioMentionVerdict | null;
  judgeEngine: string;
  judgeModel: string | null;
  at: string;
  tokens: Partial<AioJudgeTokens>;
}
/** 다시 판정 저장 — 더해 쓴 회차를 돌려준다. 회차가 그 사이 바뀌었으면(도는 중 · 문항이 달라짐 · 없음) null(다시 판정을 멈춘다). */
export type AioRejudgeCommit = (patch: AioRejudgePatch) => Promise<AioRun | null>;
export type AioRejudgeStop = keyof typeof REJUDGE_STOP;

/** 문항 목록의 모양(질문 id · 받은 시각) — 다시 판정이 읽은 뒤 다른 실행(다른 창의 이어 재기 등)이 문항을 더했는지 본다. */
const itemsKey = (run: AioRun) => run.items.map((i) => `${i.questionId}@${i.fetchedAt}`).join('|');

/** 회차에 다시 판정 한 건을 더한 사본 — 판정 칸 · 판정 사용량만 바꾼다(문항 · 검색 수 · 상태는 그대로). */
function withRejudge(run: AioRun, p: AioRejudgePatch): AioRun {
  const items = [...run.items];
  const idx = items.findLastIndex((i) => i.questionId === p.questionId && i.fetchedAt === p.fetchedAt);
  const target = idx >= 0 ? items[idx] : undefined;
  if (p.verdict && target) {
    items[idx] = {
      ...target,
      mentioned: p.verdict.mentioned,
      mentionSentences: p.verdict.sentences,
      competitorMentions: p.verdict.competitors,
      judgeEngine: p.judgeEngine,
      judgeModel: p.judgeModel,
      rejudgedAt: p.at,
    };
  }
  const conditions = p.verdict && target && p.judgeModel && !run.conditions.judgeModel ? { ...run.conditions, judgeModel: p.judgeModel } : run.conditions;
  return { ...run, items, conditions, usage: { ...run.usage, judgeCalls: run.usage.judgeCalls + 1, judgeTokens: addJudgeTokens(run.usage.judgeTokens, p.tokens) } };
}

/**
 * 다시 판정 기본 저장 — 브랜드 쓰기 줄 안에서 회차 파일을 새로 읽어 판정 칸만 더해 쓴다(읽은 사본을 통째로 덮지 않는다). 새로 읽은 회차가 도는
 * 중이거나 문항 목록이 처음과 다르면(다른 창의 이어 재기가 문항 · 검색을 더함) 쓰지 않고 null — 이미 낸 검색 기록을 지우지 않는다.
 */
function fileCommit(base: AioRun): AioRejudgeCommit {
  const key = itemsKey(base);
  return (patch) =>
    queueTenantWrite(base.tenantId, async () => {
      let fresh: AioRun | null;
      try {
        fresh = await readRunInQueue(base.tenantId, base.runId);
      } catch (err) {
        console.warn('[googleAio] 다시 판정 중 회차 파일을 읽지 못해 멈춥니다:', errText(err));
        return null;
      }
      if (!fresh || fresh.state === 'running' || itemsKey(fresh) !== key) return null;
      const next = withRejudge(fresh, patch);
      await writeJsonAtomic(runFile(next.tenantId, next.runId), next);
      return next;
    });
}

/**
 * 다시 판정(검색 0) — 저장된 본문으로 판정만 다시. scope 'unknown'은 판정 불가(null · 없음)인 있음만, 'all'은 본문이 있는 있음 모두. 다시 판정이
 * 실패하면 앞 판정을 지우지 않는다. 3번 잇따라 실패하거나 · 브랜드 측정이 시작되거나 · 회차가 그 사이 바뀌면 멈춘다. 마지막으로 저장한 회차를 돌려준다.
 */
export async function rejudgeAioItems(
  run: AioRun,
  brand: BrandContext,
  scope: 'unknown' | 'all',
  deps: Pick<AioRunnerDeps, 'judge' | 'judgeEngine' | 'measuring'> & { progress?: (done: number) => void; commit?: AioRejudgeCommit },
): Promise<{ run: AioRun; judged: number; failed: number; stopped: boolean; stopReason: AioRejudgeStop | null }> {
  const commit = deps.commit ?? fileCommit(run);
  const measuring = deps.measuring ?? measureInFlight;
  const targets = rejudgeTargets(run, scope);
  let current = run;
  let judged = 0;
  let failed = 0;
  let fails = 0;
  let stopReason: AioRejudgeStop | null = null;
  for (const item of targets) {
    if (measuring()) {
      stopReason = 'measuring';
      break;
    }
    const j = await judgeOnce(deps, brand, item.text ?? '');
    const next = await commit({ questionId: item.questionId, fetchedAt: item.fetchedAt, verdict: j.verdict, judgeEngine: deps.judgeEngine, judgeModel: j.model, at: new Date().toISOString(), tokens: j.tokens });
    if (!next) {
      stopReason = 'changed';
      break;
    }
    current = next;
    if (j.verdict) {
      judged += 1;
      fails = 0;
    } else {
      failed += 1;
      fails += 1;
    }
    deps.progress?.(judged + failed);
    if (fails >= JUDGE_STOP) {
      stopReason = 'judge';
      break;
    }
  }
  return { run: current, judged, failed, stopped: stopReason !== null, stopReason };
}

function rejudgeTargets(run: AioRun, scope: 'unknown' | 'all'): AioItem[] {
  return run.items.filter((i) => i.status === 'shown' && typeof i.text === 'string' && i.text.trim().length > 0 && (scope === 'all' || typeof i.mentioned !== 'boolean'));
}

// ── 읽기(상태 · 회차 상세) ─────────────────────────────────────────────────────

/**
 * 읽을 때 쓰는 지금의 브랜드 값(줄 안에서) — 원장 · 앱 밖 글을 못 읽으면 posts null(확인 불가). 작성자는 배정 글의 키만 옮긴다(이름은 싣지
 * 않는다). 배정 파일을 못 읽으면 작성자만 모른다.
 */
async function readContextInQueue(tenant: TenantConfig): Promise<AioReadContext> {
  let posts: AioPost[] | null = null;
  try {
    const ledger = await readPublishedPostsInQueue(tenant.tenantId);
    const external = await readExternalPostsInQueue(tenant.tenantId);
    let writerPlan: Awaited<ReturnType<typeof readProbePlan>>['plan'] = null;
    try {
      writerPlan = (await readProbePlan(tenant.tenantId)).plan;
    } catch (err) {
      console.warn(`[googleAio] ${tenant.tenantId} 배정 파일을 읽지 못해 작성자를 비웁니다:`, errText(err));
    }
    posts = aioPostRows(ledger, external, (post) => {
      const article = planArticleOf(writerPlan, post);
      return article && article !== 'bank-unknown' ? article.writer.key : null;
    });
  } catch (err) {
    console.warn(`[googleAio] ${tenant.tenantId} 원장 · 앱 밖 글을 읽지 못해 올린 글 출처를 확인 불가로 둡니다:`, errText(err));
  }
  return { brandName: tenant.brandName, aliases: [...tenant.aliases], ownedDomains: [...tenant.ownedDomains], competitors: tenant.competitors.map((c) => c.name), posts };
}

/** 진행 — 숫자는 모두 「이번 실행」 기준이다(이어 재기면 이번에 보낸 질문 · 검색 · 받은 문항만 — 확인창의 「검색 최대 n회」와 같은 기준). */
export interface GoogleAioProgress {
  runId: string;
  startedAt: string;
  resumed: boolean;
  /** 이번에 보낼 질문 수 · 끝낸 수. */
  planned: number;
  done: number;
  totalQuestions: number;
  /** 이번에 보낸 검색 · 이번 최대 검색. */
  searches: number;
  maxSearches: number;
  shown: number;
  absent: number;
  unreadable: number;
  failed: number;
  /** 본문이 있는데 판정이 없는 있음(판정 불가). */
  judgeUnknown: number;
  /** 본문 없이 출처만 온 있음(판정하지 않음). */
  noText: number;
  cancelling: boolean;
}

function progressOf(a: ActiveRun): GoogleAioProgress {
  const items = a.run.items.slice(a.itemsAtStart);
  const count = (s: AioItem['status']) => items.filter((i) => i.status === s).length;
  const shown = items.filter((i) => i.status === 'shown');
  const noText = shown.filter((i) => !(typeof i.text === 'string' && i.text.trim())).length;
  return {
    runId: a.runId,
    startedAt: a.run.startedAt,
    resumed: a.resumed,
    planned: a.planned,
    done: a.done,
    totalQuestions: a.run.questionSet.ids.length,
    searches: Math.max(0, a.run.usage.searches - a.searchesAtStart),
    maxSearches: a.budget,
    shown: shown.length,
    absent: count('absent'),
    unreadable: count('unreadable'),
    failed: count('failed'),
    judgeUnknown: shown.filter((i) => typeof i.mentioned !== 'boolean').length - noText,
    noText,
    cancelling: a.cancel,
  };
}

export interface GoogleAioStatusView {
  tenantId: string;
  /** 이 PC 스위치. */
  enabled: boolean;
  settingsError: string | null;
  pilot: boolean;
  pilotMessage: string | null;
  location: string | null;
  signature: string | null;
  /** 이 PC에 SerpAPI 키가 있는가 · 연결 주소 설정이 틀렸으면 그 까닭. */
  configured: boolean;
  configError: string | null;
  judge: GoogleAioJudgeState;
  measuring: boolean;
  /** 이 브랜드의 회차가 이 서버에서 도는 중이면 그 진행(메모리). */
  running: GoogleAioProgress | null;
  /** 다른 창(앱을 두 번 켬)이 AI 개요 잠금을 쥐었다 — 그쪽 회차를 끊김으로 보이지 않는다. */
  runningElsewhere: boolean;
  /** 지금 시작하지 못하는 까닭(다른 브랜드 회차 · 색인 자동 확인 · 다른 창). */
  busy: string | null;
  rejudging: { runId: string; total: number; done: number } | null;
  /** 이 브랜드의 마지막 다시 판정 결과(이 서버가 켜진 뒤). stopMessage는 멈춘 까닭(멈추지 않았으면 null). */
  rejudged: { runId: string; judged: number; failed: number; stopped: boolean; stopMessage: string | null; at: string } | null;
  /**
   * 회차 · 지표 — 도는 중(이 서버 · 다른 창) · 다시 판정 중에는 null(가벼운 GET — 화면은 앞서 받은 것을 둔다). 화면이 앞서 받은 것이 없으면(도는
   * 중에 화면을 새로 엶) ?view=1로 한 번만 무겁게 읽는다.
   */
  view: AioView | null;
  unreadableRuns: number;
  lastRunAt: string | null;
  /** 이어 잴 수 있는 오늘 멈춘 회차. */
  resumable: { runId: string; remaining: number } | null;
}

/** 이어 잴 수 있는 가장 최근 회차(오늘 · 같은 조건 · 같은 판정 엔진 · 같은 지문 · 남은 질문). */
function resumableOf(runs: readonly AioRun[], pilot: Pilot, pick: QuestionPick | null): { runId: string; remaining: number } | null {
  if (!pilot.ok || !pick) return null;
  const want = { today: todayKst(), signature: pilot.signature, fingerprint: pick.set.hash, judgeEngine: usedJudgeEngineId() };
  const run = [...runs].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).find((r) => aioResumeProblem(r, want) === null && resumeNeed(r) > 0);
  return run ? { runId: run.runId, remaining: aioRemaining(run).length } : null;
}

const latestStart = (runs: readonly AioRun[]): string | null => runs.reduce<string | null>((a, r) => (a === null || Date.parse(r.startedAt) > Date.parse(a) ? r.startedAt : a), null);

/**
 * 화면 상태 — 계정 · 검색은 부르지 않는다(비용 0). 도는 동안은 메모리의 진행만 준다(2초마다 묻는 가벼운 GET). opts.view면 도는 동안에도 회차 ·
 * 지표를 한 번 읽는다(화면을 새로 열었는데 앞서 받은 결과가 없을 때 — 화면이 한 번만 부른다).
 */
export async function googleAioStatus(tenant: TenantConfig, opts: { view?: boolean } = {}): Promise<GoogleAioStatusView> {
  let settings: AioSettings | null = null;
  let settingsError: string | null = null;
  try {
    settings = await readSettings();
  } catch (err) {
    settingsError = errText(err);
  }
  const pilot: Pilot = settings ? pilotOf(tenant, settings) : { ok: false, message: settingsError ?? SETTINGS_BROKEN };
  const off = serpApiUnavailable();
  const elsewhere = await elsewhereFeature();
  const mine = active && active.tenantId === tenant.tenantId ? active : null;
  const rj = rejudging && rejudging.tenantId === tenant.tenantId ? rejudging : null;
  const busy = mine ? null : ((await busyError())?.message ?? null);
  const base = {
    tenantId: tenant.tenantId,
    enabled: settings?.enabled === true,
    settingsError,
    pilot: pilot.ok,
    pilotMessage: pilot.ok ? null : pilot.message,
    location: pilot.ok ? pilot.location : null,
    signature: pilot.ok ? pilot.signature : null,
    configured: off?.kind !== 'no-key',
    configError: off?.kind === 'config' ? off.message : null,
    judge: judgeState(),
    measuring: measureInFlight(),
    running: mine ? progressOf(mine) : null,
    runningElsewhere: elsewhere === 'aio',
    busy,
    rejudging: rj ? { runId: rj.runId, total: rj.total, done: rj.done } : null,
    rejudged:
      lastRejudge && lastRejudge.tenantId === tenant.tenantId
        ? { runId: lastRejudge.runId, judged: lastRejudge.judged, failed: lastRejudge.failed, stopped: lastRejudge.stopped, stopMessage: lastRejudge.stopMessage, at: lastRejudge.at }
        : null,
  };
  const live = Boolean(mine || rj || elsewhere === 'aio');
  if (live && !opts.view) return { ...base, view: null, unreadableRuns: 0, lastRunAt: null, resumable: null };
  const { runs, unreadable, ctx } = await queueTenantWrite(tenant.tenantId, async () => ({ ...(await readRunsInQueue(tenant.tenantId)), ctx: await readContextInQueue(tenant) }));
  const shown = runs.map((r) => effective(r, elsewhere));
  const picked = pilot.ok && !live ? await pickQuestions(tenant) : null;
  return {
    ...base,
    view: shown.length > 0 ? aioView(shown, ctx, { unreadableRuns: unreadable }) : null,
    unreadableRuns: unreadable,
    lastRunAt: latestStart(shown),
    resumable: live ? null : resumableOf(shown, pilot, picked?.ok ? picked.pick : null),
  };
}

export interface GoogleAioDetailItem extends Omit<AioItem, 'rawBlock'> {
  /** 원문 블록이 회차 파일에 있는가(응답에는 싣지 않는다). */
  hasRawBlock: boolean;
  sources: AioSourceMark[];
  /** 본문엔 이름이 없고 출처 제목 · 이름에만 나옴(null = 확인 불가 · 있음 아님). */
  sourceOnly: boolean | null;
}

export interface GoogleAioRunDetail {
  run: Omit<AioRun, 'items'>;
  summary: AioRunSummary;
  items: GoogleAioDetailItem[];
  /** 원장 · 앱 밖 글을 못 읽어 올린 글 표시를 못 했다. */
  postsUnreadable: boolean;
}

/** 회차 상세 — 출처마다 자사 · 올린 글을 읽을 때 표시한다. 원문 블록은 싣지 않는다. */
export async function googleAioRunDetail(tenant: TenantConfig, runId: string): Promise<GoogleAioRunDetail> {
  if (!isAioRunId(runId)) throw new GoogleAioError('회차 id가 올바르지 않아요.', 400);
  const elsewhere = await elsewhereFeature();
  const { run, ctx } = await queueTenantWrite(tenant.tenantId, async () => {
    const found = await readRunInQueue(tenant.tenantId, runId);
    return { run: found, ctx: found ? await readContextInQueue(tenant) : null };
  });
  if (!run || !ctx) throw new GoogleAioError(RUN_NOT_FOUND, 404);
  const shown = effective(run, elsewhere);
  const upPosts = ctx.posts ? aioPostsUpDuring(shown, ctx.posts) : [];
  const { items, ...rest } = shown;
  return {
    run: rest,
    summary: summarizeAioRun(shown, ctx),
    items: items.map(({ rawBlock, ...item }) => ({
      ...item,
      hasRawBlock: rawBlock !== undefined && rawBlock !== null,
      sources: aioSourceMarks(item, ctx.ownedDomains, upPosts),
      sourceOnly: sourceOnlyOf(item, ctx),
    })),
    postsUnreadable: ctx.posts === null,
  };
}

// ── 계획 ─────────────────────────────────────────────────────────────────────

interface StoredPlan {
  tenantId: string;
  expires: number;
  resumeRunId: string | null;
  fingerprint: string;
  signature: string;
  bankVersion: string;
  maxSearches: number;
}
const plans = new Map<string, StoredPlan>();

export interface GoogleAioPlanView {
  /** 실행에 넘길 계획 id(10분) — 시작할 수 없으면 null(blocked에 까닭). */
  planId: string | null;
  expiresAt: string | null;
  tenantId: string;
  resume: { runId: string; remaining: number } | null;
  /** 이번에 보낼 질문 수 · 질문 묶음 전체. */
  questions: number;
  totalQuestions: number;
  /** 이번에 예약하는 최대 검색 M(새 회차 = 2n + 2⌈0.1n⌉). */
  maxSearches: number;
  maxJudgeCalls: number;
  judge: GoogleAioJudgeState;
  location: string | null;
  signature: string;
  bankLabel: string | null;
  quota: GoogleAioQuota | null;
  /** 「이미 낸 요금 안 · 검색당 환산」(USD) — 모르는 요금제면 null. */
  perSearchUsd: number | null;
  /** 걸리는 시간 어림(분) — [적게, 많게]. */
  expectedMinutes: [number, number];
  lastRunAt: string | null;
  daysSinceLastRun: number | null;
  /** 지난 회차가 14일 안 — 확인창이 한 줄 더 알린다(앱은 막지 않는다). */
  recent: boolean;
  blocked: { kind: 'bank' | 'judge' | 'account' | 'limit'; message: string } | null;
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** 계획 · 실행 앞의 공통 검사 — 키 · 연결(503), 설정(500), 이 PC 켜짐 · 시범 브랜드 · 측정 중(409). */
async function gate(tenant: TenantConfig): Promise<{ settings: AioSettings; pilot: Extract<Pilot, { ok: true }> }> {
  const off = serpApiUnavailable();
  if (off) throw new GoogleAioError(off.message, 503);
  const settings = await readSettings();
  if (!settings.enabled) throw new GoogleAioError(PILOT_OFF, 409, 'pilot-off');
  const pilot = pilotOf(tenant, settings);
  if (!pilot.ok) throw new GoogleAioError(pilot.message, 409, 'not-pilot');
  if (measureInFlight()) throw new GoogleAioError(MEASURING, 409, 'measuring');
  return { settings, pilot };
}

/**
 * 이어 재기 대상 — view가 끊긴 'running'을 고친 모양(interrupted · 날아가던 질문은 「못 읽음」)으로 보인다(계획은 읽기 길의 effective, 실행 준비는
 * 잠금을 쥐었으니 'running'이면 모두 끊긴 회차). 맞으면 그 모양(남은 질문 · 최대 검색을 그것으로 센다), 아니면 그 까닭.
 */
function resumeCheck(
  run: AioRun | undefined,
  pilot: Extract<Pilot, { ok: true }>,
  pick: QuestionPick,
  judgeEngine: string,
  view: (run: AioRun) => AioRun,
): { ok: true; run: AioRun } | { ok: false; message: string } {
  if (!run) return { ok: false, message: '이어 잴 회차를 찾지 못했어요.' };
  if (rejudging?.runId === run.runId && rejudging.tenantId === run.tenantId) return { ok: false, message: '그 회차를 다시 판정하는 중이에요 — 끝난 뒤 이어 재 주세요.' };
  const shown = view(run);
  const problem = aioResumeProblem(shown, { today: todayKst(), signature: pilot.signature, fingerprint: pick.set.hash, judgeEngine });
  if (problem) return { ok: false, message: RESUME_TEXT[problem] };
  if (resumeNeed(shown) <= 0) return { ok: false, message: `이 회차는 최대 검색 수(${run.maxSearches}회)를 다 써서 이어 잴 수 없어요 — 새 회차로 재 주세요.` };
  return { ok: true, run: shown };
}

/**
 * 계획 — 이번에 보낼 질문 · 최대 검색 M · 판정 엔진 · 이번 결제 주기 AI 개요 몫 · 계정 바닥 · 시간당 남은 수. 검색은 하지 않는다(계정
 * account.json만 새로 읽는다 — 무료). 시작할 수 있으면 계획 id(10분). 본문은 { resume?: 회차 id }만.
 */
export async function planGoogleAio(tenant: TenantConfig, body: unknown): Promise<GoogleAioPlanView> {
  const input = bodyOf(body, ['resume']);
  let resumeId: string | null = null;
  if (input.resume !== undefined && input.resume !== null) {
    if (!isAioRunId(input.resume)) throw new GoogleAioError('resume은 이어 잴 회차 id여야 해요.', 400);
    resumeId = input.resume;
  }
  const { pilot } = await gate(tenant);
  const busy = await busyError();
  if (busy) throw busy;
  const judge = judgeState();
  const picked = await pickQuestions(tenant);
  const elsewhere = await elsewhereFeature();
  const { runs } = await queueTenantWrite(tenant.tenantId, () => readRunsInQueue(tenant.tenantId));
  let resume: AioRun | null = null;
  if (resumeId && picked.ok) {
    const checked = resumeCheck(
      runs.find((r) => r.runId === resumeId),
      pilot,
      picked.pick,
      judge.engine,
      (r) => effective(r, elsewhere),
    );
    if (!checked.ok) throw new GoogleAioError(checked.message, 409, 'resume');
    resume = checked.run;
  }
  const n = resume ? aioRemaining(resume).length : picked.ok ? picked.pick.questions.length : 0;
  const maxSearches = resume ? resumeNeed(resume) : aioMaxSearches(n);
  const { quota, blocked: accountBlocked } = quotaOf(await serpApiAccountView({ fresh: true }));
  const blocked: GoogleAioPlanView['blocked'] = !picked.ok
    ? { kind: 'bank', message: picked.message }
    : !judge.ready
      ? { kind: 'judge', message: judge.problem ?? '판정 엔진을 쓸 수 없어요.' }
      : accountBlocked || !quota
        ? { kind: 'account', message: accountBlocked ?? ACCOUNT_UNREAD }
        : quota.allowed < maxSearches
          ? { kind: 'limit', message: limitMessage(quota, maxSearches) }
          : null;
  const now = Date.now();
  for (const [id, p] of plans) if (p.expires < now) plans.delete(id);
  let planId: string | null = null;
  if (!blocked && picked.ok) {
    planId = `plan-${randomUUID()}`;
    plans.set(planId, { tenantId: tenant.tenantId, expires: now + PLAN_TTL_MS, resumeRunId: resume?.runId ?? null, fingerprint: picked.pick.set.hash, signature: pilot.signature, bankVersion: picked.pick.bankVersion, maxSearches });
  }
  // 이어 재기의 「지난 회차」는 이어 잴 그 회차를 빼고 본다(오늘 멈춘 그 회차 때문에 늘 「14일이 안 됐어요」가 뜨지 않게).
  const resumeRunId = resume?.runId ?? null;
  const lastRunAt = latestStart(runs.filter((r) => r.runId !== resumeRunId));
  const daysSince = lastRunAt ? daysBetween(kstDate(lastRunAt) ?? todayKst(), todayKst()) : null;
  const price = aioPlanPriceUsd(quota?.planName) ?? undefined;
  return {
    planId,
    expiresAt: planId ? new Date(now + PLAN_TTL_MS).toISOString() : null,
    tenantId: tenant.tenantId,
    resume: resume ? { runId: resume.runId, remaining: n } : null,
    questions: n,
    totalQuestions: resume ? resume.questionSet.ids.length : n,
    maxSearches,
    maxJudgeCalls: n,
    judge,
    location: pilot.location,
    signature: pilot.signature,
    bankLabel: picked.ok ? aioBankLabel(picked.pick.bankVersion, picked.pick.questions.length, picked.pick.set.hash) : null,
    quota,
    perSearchUsd: price !== undefined && quota?.searchesPerMonth ? price / quota.searchesPerMonth : null,
    expectedMinutes: [Math.max(1, Math.ceil((n * SEARCH_SECONDS) / 60)), Math.max(1, Math.ceil((maxSearches * SEARCH_SECONDS + n * JUDGE_SECONDS) / 60))],
    lastRunAt,
    daysSinceLastRun: daysSince,
    recent: daysSince !== null && daysSince < RECENT_DAYS,
    blocked,
  };
}

// ── 실행 ─────────────────────────────────────────────────────────────────────

/**
 * 실행 — 계획 id로만(본문 { planId }만). 실행 잠금을 잡은 뒤 다시 본다(이 PC 켜짐 · 시범 브랜드 · 측정 중 아님 · 판정 엔진 · 질문 지문 · 조건
 * 서명 · 이어 재기 대상 · 계정을 새로 읽은 AI 개요 몫 ≥ M). 어긋나면 잠금을 놓고 409(검색 0), 계정을 못 읽으면 502. 지나면 끊긴 회차를 한 번 고치고
 * 회차를 적은 뒤 202로 바로 돌려주고 뒤에서 하나씩 잰다(진행은 googleAioStatus).
 */
export async function startGoogleAio(tenant: TenantConfig, body: unknown): Promise<{ runId: string; planned: number; maxSearches: number; resumed: boolean }> {
  const input = bodyOf(body, ['planId']);
  if (typeof input.planId !== 'string' || !input.planId) throw new GoogleAioError('planId가 필요해요 — 계획을 먼저 받아 주세요.', 400);
  const off = serpApiUnavailable();
  if (off) throw new GoogleAioError(off.message, 503);
  const busy = await busyError();
  if (busy) throw busy;
  const stored = plans.get(input.planId);
  plans.delete(input.planId);
  if (!stored || stored.expires < Date.now() || stored.tenantId !== tenant.tenantId) throw new GoogleAioError(PLAN_CHANGED, 409, 'plan-changed');
  // 기다림(잠금 · 계정 다시 읽기) 앞에서 자리를 잡는다 — 준비하는 몇 초 사이에 같은 회차의 다시 판정 · 두 번째 시작이 끼어들지 않게.
  if (active || starting) throw new GoogleAioError(BUSY, 409, 'busy');
  starting = { tenantId: tenant.tenantId, resumeRunId: stored.resumeRunId };
  let release: (() => Promise<void>) | null;
  try {
    release = await claimSerpRun('aio');
  } catch (err) {
    starting = null;
    throw err;
  }
  if (!release) {
    starting = null;
    throw (await busyError()) ?? new GoogleAioError(BUSY_ELSEWHERE, 409, 'busy-elsewhere');
  }
  const unlock = release;
  let prepared: Awaited<ReturnType<typeof prepareRun>>;
  try {
    prepared = await prepareRun(tenant, stored);
  } catch (err) {
    starting = null;
    await unlock();
    throw err;
  }
  plans.clear();
  const job: ActiveRun = {
    tenantId: tenant.tenantId,
    runId: prepared.run.runId,
    run: prepared.run,
    resumed: prepared.resumed,
    planned: prepared.questions.length,
    done: 0,
    cancel: false,
    searchesAtStart: prepared.run.usage.searches,
    itemsAtStart: prepared.run.items.length,
    budget: prepared.resumed ? stored.maxSearches : prepared.run.maxSearches,
  };
  starting = null;
  active = job;
  void executeAioRun(prepared.run, prepared.questions, brandOf(tenant), {
    judge: prepared.judge,
    judgeEngine: prepared.judgeEngine,
    cancelled: () => job.cancel,
    pilotOn: async () => {
      try {
        return (await readSettings()).enabled;
      } catch (err) {
        console.warn('[googleAio] 이 PC 설정을 읽지 못해 멈춥니다:', errText(err));
        return false;
      }
    },
    progress: () => {
      job.done += 1;
    },
  })
    .catch((err: unknown) => console.error('[googleAio] 실행이 끝나지 않았습니다:', errText(err)))
    .finally(async () => {
      await unlock();
      active = null;
    });
  return { runId: prepared.run.runId, planned: prepared.questions.length, maxSearches: job.budget, resumed: prepared.resumed };
}

/** 잠금을 쥔 뒤의 다시 보기 · 회차 준비(끊긴 회차 한 번 고치기 · 새 회차 적기 또는 멈춘 회차 이어 받기). */
async function prepareRun(tenant: TenantConfig, stored: StoredPlan) {
  const { pilot } = await gate(tenant);
  const { judge, judgeEngine } = judgeOrError();
  const picked = await pickQuestions(tenant);
  if (!picked.ok) throw new GoogleAioError(`${PLAN_CHANGED} ${picked.message}`, 409, 'plan-changed');
  const pick = picked.pick;
  if (pick.set.hash !== stored.fingerprint || pilot.signature !== stored.signature || pick.bankVersion !== stored.bankVersion) throw new GoogleAioError(PLAN_CHANGED, 409, 'plan-changed');
  // 이 프로세스가 AI 개요 잠금을 쥐었다 — 다른 창이 도는 회차는 없으니 'running' 파일은 모두 끊긴 회차다.
  const { runs } = await queueTenantWrite(tenant.tenantId, () => readRunsInQueue(tenant.tenantId));
  let need = aioMaxSearches(pick.questions.length);
  if (stored.resumeRunId) {
    const checked = resumeCheck(
      runs.find((r) => r.runId === stored.resumeRunId),
      pilot,
      pick,
      judgeEngine,
      (r) => (r.state === 'running' ? interruptedOf(r) : r),
    );
    if (!checked.ok) throw new GoogleAioError(`${PLAN_CHANGED} ${checked.message}`, 409, 'plan-changed');
    need = resumeNeed(checked.run);
    if (need !== stored.maxSearches) throw new GoogleAioError(PLAN_CHANGED, 409, 'plan-changed');
  }
  const view = await serpApiAccountView({ fresh: true });
  const { quota, blocked } = quotaOf(view);
  if (blocked || !quota) throw new GoogleAioError(blocked ?? ACCOUNT_UNREAD, 502);
  if (quota.allowed < need) throw new GoogleAioError(limitMessage(quota, need), 409, 'limit');
  return queueTenantWrite(tenant.tenantId, async () => {
    const fresh = await readRunsInQueue(tenant.tenantId);
    for (const r of fresh.runs) {
      if (r.state !== 'running') continue;
      // 끊긴 회차 — 날아가던 검색의 질문은 「못 읽음(interrupted)」으로 마무리한다(보낸 검색은 이미 셌다 — 이어 재기가 다시 사지 않게).
      await writeJsonAtomic(runFile(r.tenantId, r.runId), interruptedOf(r));
    }
    if (stored.resumeRunId) {
      const target = await readRunInQueue(tenant.tenantId, stored.resumeRunId);
      if (!target) throw new GoogleAioError(PLAN_CHANGED, 409, 'plan-changed');
      const remaining = new Set(aioRemaining(target));
      const run: AioRun = { ...target, state: 'running', stopReason: null, stopMessage: null, finishedAt: null };
      await writeJsonAtomic(runFile(run.tenantId, run.runId), run);
      return { run, questions: pick.questions.filter((q) => remaining.has(q.questionId)), judge, judgeEngine, resumed: true };
    }
    let startedAt = new Date();
    while (fresh.runs.some((r) => r.runId === aioRunId(startedAt))) startedAt = new Date(startedAt.getTime() + 1);
    const run = newAioRun({ tenantId: tenant.tenantId, startedAt, location: pilot.location, bankVersion: pick.bankVersion, cohortBank: pick.cohortBank, questions: pick.questions, cycle: quota.cycle, judgeEngine });
    await writeJsonAtomic(runFile(run.tenantId, run.runId), run);
    return { run, questions: pick.questions, judge, judgeEngine, resumed: false };
  });
}

/** 중단 — 이 서버에서 도는 그 회차만. 다음 검색 전에 멈춘다(지금 날아가는 요청 하나는 끝까지 받는다). */
export async function cancelGoogleAio(tenant: TenantConfig, runId: string): Promise<{ cancelling: true }> {
  if (!isAioRunId(runId)) throw new GoogleAioError('회차 id가 올바르지 않아요.', 400);
  if (active && active.tenantId === tenant.tenantId && active.runId === runId) {
    active.cancel = true;
    return { cancelling: true };
  }
  if ((await elsewhereFeature()) === 'aio') throw new GoogleAioError(`${BUSY_ELSEWHERE} 그 창에서 멈춰 주세요.`, 409, 'busy-elsewhere');
  throw new GoogleAioError('이 회차는 지금 돌고 있지 않아요.', 409, 'not-running');
}

/**
 * 다시 판정(검색 0) — 본문 { scope: 'unknown' | 'all' }. 이 PC 켜짐 · 시범 브랜드 · 측정 중 아님 · 판정 엔진 · 그 회차가 돌지 않음(이 서버 ·
 * 다른 창) · 다른 다시 판정이 없음. 202로 바로 돌려주고 뒤에서 하나씩 판정한다(진행은 googleAioStatus).
 */
export async function rejudgeGoogleAio(tenant: TenantConfig, runId: string, body: unknown): Promise<{ runId: string; total: number }> {
  if (!isAioRunId(runId)) throw new GoogleAioError('회차 id가 올바르지 않아요.', 400);
  const input = bodyOf(body, ['scope']);
  if (input.scope !== 'unknown' && input.scope !== 'all') throw new GoogleAioError('scope는 unknown · all 가운데 하나여야 해요.', 400);
  const scope = input.scope;
  if (rejudging) throw new GoogleAioError(REJUDGE_BUSY, 409, 'busy');
  const runBusy = () => {
    if (active && active.tenantId === tenant.tenantId && active.runId === runId) throw new GoogleAioError('그 회차가 아직 도는 중이에요 — 끝난 뒤 다시 판정해 주세요.', 409, 'busy');
    if (starting && starting.tenantId === tenant.tenantId && starting.resumeRunId === runId) throw new GoogleAioError(RUN_STARTING, 409, 'busy');
  };
  runBusy();
  // 기다림(설정 · 잠금 · 파일 읽기) 앞에서 자리를 잡는다 — 두 요청이 함께 검사를 지나 판정비가 두 번 나가지 않게.
  const job: Rejudging = { tenantId: tenant.tenantId, runId, total: 0, done: 0 };
  rejudging = job;
  let run: AioRun;
  let judging: { judge: AioJudgeFn; judgeEngine: string };
  try {
    const settings = await readSettings();
    if (!settings.enabled) throw new GoogleAioError(PILOT_OFF, 409, 'pilot-off');
    const pilot = pilotOf(tenant, settings);
    if (!pilot.ok) throw new GoogleAioError(pilot.message, 409, 'not-pilot');
    if (measureInFlight()) throw new GoogleAioError(MEASURING, 409, 'measuring');
    runBusy();
    judging = judgeOrError();
    const elsewhere = await elsewhereFeature();
    run = await queueTenantWrite(tenant.tenantId, async () => {
      const found = await readRunInQueue(tenant.tenantId, runId);
      if (!found) throw new GoogleAioError(RUN_NOT_FOUND, 404);
      runBusy();
      if (found.state !== 'running') return found;
      if (elsewhere === 'aio') throw new GoogleAioError(`${BUSY_ELSEWHERE} 그 회차는 다른 창에서 도는 중일 수 있어요.`, 409, 'busy-elsewhere');
      if (!isStale(found, elsewhere)) throw new GoogleAioError('그 회차가 아직 도는 중일 수 있어요 — 끝난 뒤 다시 판정해 주세요.', 409, 'busy');
      // 끊긴 회차는 다시 판정하며 한 번 고쳐 적는다 — 판정은 고친 파일에 더해 쓴다(날아가던 질문은 「못 읽음」).
      const fixed = interruptedOf(found);
      await writeJsonAtomic(runFile(fixed.tenantId, fixed.runId), fixed);
      return fixed;
    });
  } catch (err) {
    rejudging = null;
    throw err;
  }
  job.total = rejudgeTargets(run, scope).length;
  void rejudgeAioItems(run, brandOf(tenant), scope, {
    judge: judging.judge,
    judgeEngine: judging.judgeEngine,
    progress: (done) => {
      job.done = done;
    },
  })
    .then((r) => {
      lastRejudge = { tenantId: tenant.tenantId, runId, judged: r.judged, failed: r.failed, stopped: r.stopped, stopMessage: r.stopReason ? REJUDGE_STOP[r.stopReason] : null, at: new Date().toISOString() };
    })
    .catch((err: unknown) => console.error('[googleAio] 다시 판정이 끝나지 않았습니다:', errText(err)))
    .finally(() => {
      rejudging = null;
    });
  return { runId, total: job.total };
}
