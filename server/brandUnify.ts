import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { BUNDLED_COHORT_BANK_DIR, COHORT_BANK_DIR, packagedDataMode, PIPELINE_DATA_DIR, stateFilePath } from './appPaths.js';
import { bankQuestionsDiffer, listBundledVersions, readBundledBank } from './bundledBanks.js';
import { cohortKey } from './cohortQuestionBank.js';
import { measureInFlight } from './measureTracker.js';
import type { QuestionBank, ResultStore } from './store.js';
import { findBakedTenant, loadRuntimeTenants } from './tenantRegistry.js';
import { readOverlay } from './tenantOverlay.js';
import { deleteTenantOnThisPc } from './tenantRemovedStore.js';
import { readDeletedTenants } from './tenantTombstone.js';
import { writeJsonAtomic } from './tenantWriteQueue.js';
import type { TenantConfig } from './types.js';
import { sharesSite } from '../src/lib/brandVariant.js';

/**
 * v0.4.49 브랜드 통일 — 스테이,머뭄(web4ai) · 군산각 지역형(gunsan)을 모든 PC에서 같은 설정 · 같은 질문지로 잰다. 설정은 저장소
 * 설정(server/tenants.config.json)에 굽고, 질문지는 설치본에 담는다(bundledBanks.ts). 여기서는 그 둘로 통일되지 않는 PC별 파일을
 * 다룬다(서버 시작 때, seedFirstRunIfEmpty 바로 뒤 — server/index.ts). 군산각 전국형(gunsan-national)은 통일에서 빼고 모든 PC에서
 * 한 번 지운다(2026-11-03 결정, 아래 3).
 *
 * 1. 한 번만 하는 정리 — 두 브랜드의 engines.json · market-scope.json을 data/<id>/before-unify-0.4.49/로 옮긴다(이름 바꾸기 — 지우지
 *    않는다). 두 파일은 저장소 설정의 엔진 · 시장 범위를 PC마다 덮는다(tenantRegistry.ts mergeRuntimeTenants). 표식 파일
 *    (userData/brand-unify-0.4.49.json)이 있으면 다시 하지 않는다 — 그 뒤 앱에서 다시 고친 값은 사람이 고친 것이다. 중간에 멈추면
 *    다음 시작은 첫 시도의 대상만 다시 하고, 그 사이 앱에서 새로 만들거나 고친 파일은 옮기지 않는다(UNIFY_PENDING_FILE). 이 PC가 그
 *    id를 다른 업체로 쓰고 있으면(idCollision) 그 id는 건너뛴다. fact-graph.json · owned-domains.json · publish-settings.json ·
 *    brand-page.json은 건드리지 않는다.
 * 2. 읽기만 하는 점검 — 시작할 때마다 userData/unify-check.json(과 로그)에 남긴다. 같은 홈페이지를 쓰는 다른 id(군산각을 다른 id로
 *    등록한 PC — 운영자가 지운다), 두 브랜드를 숨긴 툼스톤, 저장소 설정과 다른 오버레이 항목(그 id를 다른 업체로 쓰고 있으면 알린다),
 *    동봉본과 다른 코호트 공통 질문지 · 질문지, 남아 있는 PC별 파일, 마치지 못한 정리.
 * 3. 한 번만 하는 군산각 전국형 지우기 — id가 정확히 gunsan-national인 브랜드가 목록에 있으면 화면의 「빼기」와 같은 함수로 지운다
 *    (tenantRemovedStore.ts deleteTenantOnThisPc — 되살리기 백업 · 오버레이 · 측정 대기열 · 툼스톤 · 코호트 순위 · 최근 실패). 측정 기록
 *    (data/gunsan-national/)은 남아 「되살리기」로 돌아온다. 표식(userData/remove-gunsan-national-0.4.49.json)이 있으면 다시 하지 않는다
 *    — 그 뒤 되살리거나 새로 만든 것은 사람이 한 것이다. 없는 PC도 없음을 표식에 남긴다. 측정 중이면 미룬다. 그 id가 군산각 전국형이
 *    아니면(이름 · 홈페이지가 다르거나 경쟁사로만 잼 — nationalCollision) 지우지 않고 알린다. 지우다 멈추면(오버레이에서 뺀 뒤 쓰기
 *    실패 · 종료) 다음 시작이 진행 기록(NATIONAL_REMOVAL_PENDING_FILE)으로 알아보고 남은 단계를 마저 한다. 다른 id의 군산각 전국형은
 *    지우지 않고 점검이 같은 홈페이지로 알린다.
 * 패키징(설치본)에서만 한다 — dev 체크아웃의 data/는 개발자 것이고, 웹은 이 서버를 쓰지 않는다.
 */
export const UNIFY_VERSION = '0.4.49';
export const UNIFIED_TENANTS = ['web4ai', 'gunsan'] as const;
export const UNIFY_BACKUP_DIR = `before-unify-${UNIFY_VERSION}`;
export const UNIFY_MARKER_FILE = `brand-unify-${UNIFY_VERSION}.json`;
/** 정리하는 중의 기록 — 첫 시도의 대상을 고정한다(unifyCleanupOnce). 정리가 끝나면 표식이 이긴다. */
export const UNIFY_PENDING_FILE = `brand-unify-${UNIFY_VERSION}.pending.json`;
export const UNIFY_CHECK_FILE = 'unify-check.json';
/** 모든 PC에서 한 번 지우는 브랜드 — 군산각 전국형(2026-11-03 결정). 이 id만 지운다. */
export const NATIONAL_REMOVED_TENANT = 'gunsan-national';
/** 그 지우기를 했다는 표식 — 있으면 다시 하지 않는다(되살린 뒤에도). */
export const NATIONAL_REMOVAL_MARKER_FILE = `remove-${NATIONAL_REMOVED_TENANT}-${UNIFY_VERSION}.json`;
/**
 * 그 지우기를 시작했다는 진행 기록 — 지우기 전에 남긴다. 오버레이에서 빼는 순간 브랜드가 목록에서 사라지므로(저장소 설정에 없다),
 * 그 뒤에 멈추면 다음 시작은 목록만 보고는 「없었다」와 가리지 못한다. 표식이 생기면 표식이 이긴다.
 */
export const NATIONAL_REMOVAL_PENDING_FILE = `remove-${NATIONAL_REMOVED_TENANT}-${UNIFY_VERSION}.pending.json`;
/** 군산각 전국형과 같은 업체인지 견주는 구운 브랜드 — 같은 이름 · 같은 홈페이지의 고객 브랜드여야 지운다. */
const NATIONAL_SAME_BRAND = 'gunsan';
/** 정리에서 옮기는 파일 — 저장소 설정의 엔진 · 시장 범위를 PC마다 덮는다. */
const MOVED_FILES = ['engines.json', 'market-scope.json'] as const;
/** 점검에서 있는지만 보는 PC별 파일 — 저장소 설정을 이기거나(사실 · 브랜드 페이지 · 경쟁사) 더한다(자사 주소). */
const REPORTED_FILES = ['fact-graph.json', 'brand-page.json', 'owned-domains.json', 'competitors.json', 'publish-settings.json', ...MOVED_FILES] as const;

const exists = (file: string) =>
  access(file).then(
    () => true,
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return false;
      throw err;
    },
  );

export interface UnifyCleanup {
  version: string;
  doneAt: string;
  /** 옮긴 파일 — data/ 기준 상대 경로(원래 자리 → 백업 자리). 정리가 여러 번 시작에 걸쳐 끝났으면 모든 회차의 것. */
  moved: { from: string; to: string }[];
  /**
   * 옮기지 않은 것. from이 없으면 그 브랜드 전체 — 이 PC가 그 id를 다른 업체로 쓰고 있다(idCollision). from이 있으면 그 파일 — 첫 시도
   * 뒤 앱에서 고쳤거나(사람이 고친 값) 없어졌다.
   */
  skipped?: { tenantId: string; from?: string; reason: string }[];
}

/**
 * 정리하는 중의 기록(userData/brand-unify-0.4.49.pending.json). 첫 시도에서 옮길 대상 · 그때의 내용 지문을 정해 두고, 다음 시작은 그
 * 대상만 다시 한다 — 첫 시도 뒤 앱에서 새로 만든 파일 · 고친 파일 · 이미 옮긴 뒤 다시 저장한 파일은 사람이 고친 것이라 옮기지 않는다.
 */
interface UnifyPending {
  version: string;
  startedAt: string;
  targets: { tenantId: string; from: string; sha256: string }[];
  moved: UnifyCleanup['moved'];
  skipped: NonNullable<UnifyCleanup['skipped']>;
}

const sha256Of = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex');

/** 윈도우에서는 백신 · 색인기 · 동기화가 파일을 잡고 있는 순간 rename이 실패한다 — writeJsonAtomic(tenantWriteQueue.ts)처럼 잠깐 쉬었다 다시 한다. */
const RETRYABLE_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY']);
async function renameRetrying(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      if (RETRYABLE_RENAME.has((err as NodeJS.ErrnoException).code ?? '') && attempt < 6) {
        await sleep(20 * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }
}

/**
 * 구운 id를 이 PC가 다른 업체로 쓰고 있는가 — 오버레이 항목이 경쟁사로만 재는 브랜드이거나 이름이 다르다. 경쟁사 id는 도메인 첫
 * 마디라(cohortPlan.ts slugFromDomain) gunsan.go.kr(군산시 문화관광)도 gunsan이 된다. 병합은 저장소 설정이 이겨 그 항목은 조용히
 * 가려지고, 그 id 폴더의 지난 기록이 구운 브랜드의 기록처럼 보인다. 겹치면 사람이 읽을 까닭, 아니면 null.
 */
export function idCollision(entry: Pick<TenantConfig, 'brandName' | 'cohortOnly'>, baked: Pick<TenantConfig, 'brandName' | 'cohortOnly'>): string | null {
  const reasons: string[] = [];
  if (Boolean(entry.cohortOnly) !== Boolean(baked.cohortOnly)) reasons.push(entry.cohortOnly ? '경쟁사로만 재는 브랜드' : '고객 브랜드');
  if (entry.brandName.trim() !== baked.brandName.trim()) reasons.push(`이름 「${entry.brandName}」`);
  return reasons.length > 0 ? reasons.join(' · ') : null;
}

/**
 * 이 PC의 gunsan-national이 군산각 전국형이 아닌가 — 구운 군산각(gunsan)과 이름이 다르거나, 경쟁사로만 재거나, 홈페이지가 겹치지
 * 않는다. id는 홈페이지 첫 마디에 범위 꼬리를 붙여 만들어(cohortPlan.ts slugFromDomain · brandVariant.ts variantTenantId) gunsan.go.kr
 * (군산시 문화관광)의 「하나 더 등록」도 gunsan-national이 된다. 다른 업체면 사람이 읽을 까닭, 군산각 전국형이면 null.
 */
export function nationalCollision(
  entry: Pick<TenantConfig, 'brandName' | 'cohortOnly' | 'ownedDomains'>,
  regional: Pick<TenantConfig, 'brandName' | 'cohortOnly' | 'ownedDomains'> | undefined,
): string | null {
  if (!regional) return `저장소 설정에 ${NATIONAL_SAME_BRAND}가 없어 같은 업체인지 알 수 없음`;
  const reasons: string[] = [];
  const named = idCollision(entry, regional);
  if (named) reasons.push(named);
  if (!sharesSite({ ownedDomains: entry.ownedDomains ?? [] }, { ownedDomains: regional.ownedDomains ?? [] })) {
    reasons.push(`홈페이지 「${(entry.ownedDomains ?? []).join(', ') || '없음'}」`);
  }
  return reasons.length > 0 ? reasons.join(' · ') : null;
}

/** 첫 시도 — 옮길 대상과 그때의 내용 지문을 정한다. 이 PC가 다른 업체로 쓰는 id는 대상에서 뺀다. */
async function planCleanup(now: Date): Promise<UnifyPending> {
  const overlay = await readOverlay();
  const targets: UnifyPending['targets'] = [];
  const skipped: UnifyPending['skipped'] = [];
  for (const tenantId of UNIFIED_TENANTS) {
    const entry = overlay.find((t) => t.tenantId === tenantId);
    const baked = await findBakedTenant(tenantId);
    const collision = entry && baked ? idCollision(entry, baked) : null;
    if (collision) {
      skipped.push({ tenantId, reason: `이 PC의 ${tenantId}는 다른 업체(${collision})라 옮기지 않음` });
      continue;
    }
    for (const name of MOVED_FILES) {
      const from = path.join(PIPELINE_DATA_DIR, tenantId, name);
      if (await exists(from)) targets.push({ tenantId, from: path.relative(PIPELINE_DATA_DIR, from), sha256: await sha256Of(from) });
    }
  }
  return { version: UNIFY_VERSION, startedAt: now.toISOString(), targets, moved: [], skipped };
}

/**
 * 한 번만 하는 정리. 이미 했으면 그때의 기록을 돌려준다. 옮기지 못한 파일이 있으면 표식을 남기지 않고 던진다 — 다음 시작 때 첫 시도의
 * 대상 가운데 남은 것만 다시 한다(정리하는 중의 기록 UNIFY_PENDING_FILE). 백업 자리에 이미 파일이 있으면 덮지 않고 그 파일은 옮기지
 * 않는다(던진다). 첫 시도 때와 내용이 달라진 파일은 사람이 앱에서 고친 것이라 옮기지 않는다.
 */
export async function unifyCleanupOnce(now: Date = new Date()): Promise<{ ran: boolean; cleanup: UnifyCleanup }> {
  const marker = stateFilePath(UNIFY_MARKER_FILE);
  if (await exists(marker)) return { ran: false, cleanup: JSON.parse(await readFile(marker, 'utf-8')) as UnifyCleanup };
  const pendingFile = stateFilePath(UNIFY_PENDING_FILE);
  const pending = (await exists(pendingFile)) ? (JSON.parse(await readFile(pendingFile, 'utf-8')) as UnifyPending) : await planCleanup(now);
  // 옮기기 전에 대상을 남긴다 — 중간에 꺼져도 다음 시작이 새 대상을 고르지 않는다.
  await writeJsonAtomic(pendingFile, pending);
  const handled = new Set([...pending.moved.map((m) => m.from), ...pending.skipped.flatMap((k) => (k.from ? [k.from] : []))]);
  const failed: string[] = [];
  for (const target of pending.targets) {
    if (handled.has(target.from)) continue;
    const from = path.join(PIPELINE_DATA_DIR, target.from);
    const to = path.join(PIPELINE_DATA_DIR, target.tenantId, UNIFY_BACKUP_DIR, path.basename(target.from));
    const toRel = path.relative(PIPELINE_DATA_DIR, to);
    if (!(await exists(from))) {
      // 옮긴 뒤 기록을 남기기 전에 꺼진 경우 — 백업 자리의 내용이 첫 시도 때와 같으면 옮긴 것이다.
      if ((await exists(to)) && (await sha256Of(to)) === target.sha256) pending.moved.push({ from: target.from, to: toRel });
      else pending.skipped.push({ tenantId: target.tenantId, from: target.from, reason: '정리를 시작한 뒤 없어짐' });
      continue;
    }
    if ((await sha256Of(from)) !== target.sha256) {
      pending.skipped.push({ tenantId: target.tenantId, from: target.from, reason: '정리를 시작한 뒤 앱에서 고침 — 사람이 고친 값이라 옮기지 않음' });
      continue;
    }
    if (await exists(to)) {
      failed.push(`${to}에 이미 파일이 있어 ${from}을 옮기지 않았습니다(덮지 않음)`);
      continue;
    }
    try {
      await mkdir(path.dirname(to), { recursive: true });
      await renameRetrying(from, to);
      pending.moved.push({ from: target.from, to: toRel });
    } catch (err) {
      failed.push(`${from}을 옮기지 못했습니다(${err instanceof Error ? err.message : String(err)})`);
    }
  }
  await writeJsonAtomic(pendingFile, pending);
  if (failed.length > 0) {
    const done = pending.moved.map((m) => m.from).join(', ');
    throw new Error(`브랜드 통일 정리를 마치지 못했습니다 — ${failed.join(' · ')}${done ? ` (옮긴 것: ${done})` : ''}. 다음 시작 때 남은 것만 다시 합니다.`);
  }
  const cleanup: UnifyCleanup = {
    version: UNIFY_VERSION,
    doneAt: now.toISOString(),
    moved: pending.moved,
    ...(pending.skipped.length > 0 ? { skipped: pending.skipped } : {}),
  };
  await writeJsonAtomic(marker, cleanup);
  return { ran: true, cleanup };
}

/** 군산각 전국형 한 번 지우기의 표식(userData/remove-gunsan-national-0.4.49.json). */
export interface NationalRemoval {
  version: string;
  tenantId: string;
  at: string;
  /**
   * deleted — 화면의 「빼기」와 같이 지웠다. absent — 이 PC 목록에 없어 아무것도 하지 않았다. skipped-collision — 그 id가 군산각
   * 전국형이 아닌 다른 업체라 지우지 않았다(nationalCollision).
   */
  action: 'deleted' | 'absent' | 'skipped-collision';
  /** absent일 때 — 이미 지운 브랜드(툼스톤)였는가. */
  hidden?: boolean;
  /** deleted일 때 — 지난 시작에 멈춘 지우기를 이번에 마저 했다. */
  resumed?: boolean;
  /** skipped-collision일 때 — 다른 업체로 본 까닭. */
  reason?: string;
  /** deleted · skipped-collision일 때 — 그 브랜드의 모습(deleted면 지우기 결과도). */
  brandName?: string;
  industry?: string;
  region?: string;
  removedFromOverlay?: boolean;
  /** 순위를 다시 매긴 같은 코호트 카드 수. */
  ranksUpdated?: number;
}

/** 군산각 전국형 지우기의 진행 기록(userData/remove-gunsan-national-0.4.49.pending.json) — 지우기 전 브랜드의 모습. */
interface NationalRemovalPending {
  version: string;
  startedAt: string;
  brandName: string;
  industry: string;
  region: string;
  /** 그때 오버레이에 항목이 있었는가 — 마저 할 때 「오버레이에서 뺐다」를 바르게 적는다. */
  inOverlay: boolean;
}

/**
 * 한 번만 하는 군산각 전국형 지우기. 이미 했으면 그때의 표식을 돌려준다. 측정 중이면 표식 없이 미룬다(deferred — 화면의 「빼기」도
 * 측정 중에는 지우지 않는다). 그 id가 다른 업체면 지우지 않고 skipped-collision을 남긴다. 지우기 전에 진행 기록을 남기고, 지우다
 * 멈추면 표식 없이 던진다 — 다음 시작은 아직 목록에 있으면 다시 지우고, 오버레이에서 빠져 목록에 없으면 같은 함수로 남은 단계
 * (측정 대기열 · 툼스톤 · 코호트 순위 · 최근 실패 — 이미 한 것은 그대로 둔다)를 마저 한다. 되살리기 백업은 첫 시도의 것을 둔다.
 */
export async function removeNationalOnce(store: ResultStore, now: Date = new Date()): Promise<{ ran: boolean; removal: NationalRemoval | null; deferred?: string }> {
  const markerFile = stateFilePath(NATIONAL_REMOVAL_MARKER_FILE);
  if (await exists(markerFile)) return { ran: false, removal: JSON.parse(await readFile(markerFile, 'utf-8')) as NationalRemoval };
  if (measureInFlight()) {
    return { ran: false, removal: null, deferred: `측정이 진행 중이라 ${NATIONAL_REMOVED_TENANT}를 지우지 않았습니다 — 다음 시작 때 다시 합니다.` };
  }
  const base = { version: UNIFY_VERSION, tenantId: NATIONAL_REMOVED_TENANT, at: now.toISOString() };
  const pendingFile = stateFilePath(NATIONAL_REMOVAL_PENDING_FILE);
  const pending = (await exists(pendingFile)) ? (JSON.parse(await readFile(pendingFile, 'utf-8')) as NationalRemovalPending) : null;
  const tenant = (await loadRuntimeTenants()).find((t) => t.tenantId === NATIONAL_REMOVED_TENANT);
  let removal: NationalRemoval;
  if (tenant) {
    const shape = { brandName: tenant.brandName, industry: tenant.industry, region: tenant.region };
    const collision = nationalCollision(tenant, await findBakedTenant(NATIONAL_SAME_BRAND));
    if (collision) {
      removal = { ...base, action: 'skipped-collision', reason: collision, ...shape };
    } else {
      if (!pending) {
        const inOverlay = (await readOverlay()).some((t) => t.tenantId === NATIONAL_REMOVED_TENANT);
        await writeJsonAtomic(pendingFile, { version: UNIFY_VERSION, startedAt: now.toISOString(), ...shape, inOverlay } satisfies NationalRemovalPending);
      }
      const { removedFromOverlay, ranksUpdated } = await deleteTenantOnThisPc(NATIONAL_REMOVED_TENANT, store);
      removal = { ...base, action: 'deleted', ...shape, removedFromOverlay, ranksUpdated, ...(pending ? { resumed: true } : {}) };
    }
  } else if (pending) {
    // 지난 시작에 오버레이에서 뺀 뒤 멈췄다 — 브랜드가 목록에 없어도 같은 함수로 남은 단계를 마저 한다.
    const { removedFromOverlay, ranksUpdated } = await deleteTenantOnThisPc(NATIONAL_REMOVED_TENANT, store);
    removal = {
      ...base,
      action: 'deleted',
      resumed: true,
      brandName: pending.brandName,
      industry: pending.industry,
      region: pending.region,
      removedFromOverlay: removedFromOverlay || pending.inOverlay,
      ranksUpdated,
    };
  } else {
    removal = { ...base, action: 'absent', hidden: (await readDeletedTenants()).includes(NATIONAL_REMOVED_TENANT) };
  }
  await writeJsonAtomic(markerFile, removal);
  return { ran: true, removal };
}

export interface UnifyIssue {
  kind:
    | 'same-site'
    | 'tombstone'
    | 'bank-differs'
    | 'bank-unreadable'
    | 'cohort-differs'
    | 'not-baked'
    | 'id-collision'
    | 'cleanup-failed'
    /** 측정 중이라 군산각 전국형 지우기를 다음 시작으로 미뤘다. */
    | 'national-deferred'
    /** 군산각 전국형을 지우다 멈췄다 — 다음 시작 때 다시 지우거나 남은 단계를 마저 한다. */
    | 'national-delete-failed';
  tenantId: string;
  message: string;
}

/** 이번 시작의 군산각 전국형 지우기 결과(removeNationalOnce) — 점검 파일에 싣는다. */
export interface NationalRemovalOutcome {
  removal: NationalRemoval | null;
  problem?: { kind: 'national-deferred' | 'national-delete-failed'; message: string };
}

export interface UnifyTenantReport {
  /** 저장소 설정 값(굽지 않은 설치본이면 null). */
  baked: { questionBankVersion: string; industry: string; region: string; marketScope: string } | null;
  /** 툼스톤에 걸려 목록에서 숨었는가. */
  hidden: boolean;
  /** 오버레이 항목이 저장소 설정과 다른 값(범위 · 업종 · 지역 · 이름 · 경쟁사 여부) — 저장소 설정이 이기므로 쓰이지 않는다. 오버레이에 없으면 null. */
  overlayDiffers: Record<string, { overlay: string; repo: string }> | null;
  /** 동봉한 판마다 이 PC 질문지 상태 — missing이면 측정 때 가져온다. */
  banks: { version: string; state: 'same' | 'differs' | 'missing' | 'unreadable'; detail?: string }[];
  /** 남아 있는 PC별 파일. */
  files: string[];
}

export interface UnifyCheck {
  version: string;
  checkedAt: string;
  cleanup: UnifyCleanup | null;
  /** 운영자가 볼 것. */
  issues: UnifyIssue[];
  tenants: Record<string, UnifyTenantReport>;
  /** 두 브랜드와 같은 홈페이지를 쓰는 다른 id. */
  sameSite: { tenantId: string; brandName: string; industry: string; region: string; marketScope: string; cohortOnly: boolean; hidden: boolean; sharesWith: string[] }[];
  /** 두 브랜드가 쓰는 코호트 공통 질문지 — 이 PC 것과 동봉 기준본. 동봉 기준본이 없는 실행(dev)이면 비교하지 않는다. */
  cohortBanks: { key: string; version: string; state: 'same' | 'differs' | 'missing' | 'unreadable' | 'not-compared'; detail?: string }[];
  /**
   * 군산각 전국형 한 번 지우기의 표식 — 지웠다(deleted) · 없었다(absent) · 다른 업체라 두었다(skipped-collision — 그 브랜드가 목록에
   * 있는 동안 issues에 id-collision). 아직 못 했으면(미룸 · 멈춤) null이고 issues에 까닭.
   */
  nationalRemoval: NationalRemoval | null;
}

const scopeOf = (t: Pick<TenantConfig, 'marketScope'>) => t.marketScope ?? 'local';

/** 파일을 JSON으로 읽는다 — 없으면 null, 읽지 못하면 'unreadable'. */
async function readJsonState<T>(file: string): Promise<T | null | 'unreadable'> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return 'unreadable';
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return 'unreadable';
  }
}

/**
 * 읽기만 하는 점검 — 아무 파일도 쓰지 않는다(질문지를 가져오지도 않는다). cleanupFailure는 이번 시작의 정리가 던진 까닭, national은
 * 이번 시작의 군산각 전국형 지우기 결과.
 */
export async function checkBrandUnify(
  cleanup: UnifyCleanup | null,
  now: Date = new Date(),
  cleanupFailure?: string,
  national: NationalRemovalOutcome = { removal: null },
): Promise<UnifyCheck> {
  const [runtime, overlay, deleted] = await Promise.all([loadRuntimeTenants(), readOverlay(), readDeletedTenants()]);
  const deletedSet = new Set(deleted);
  const issues: UnifyIssue[] = [];
  if (cleanupFailure) issues.push({ kind: 'cleanup-failed', tenantId: UNIFIED_TENANTS.join(','), message: cleanupFailure });
  if (national.problem) issues.push({ kind: national.problem.kind, tenantId: NATIONAL_REMOVED_TENANT, message: national.problem.message });
  const otherNational = national.removal?.action === 'skipped-collision' ? runtime.find((t) => t.tenantId === NATIONAL_REMOVED_TENANT) : undefined;
  if (otherNational) {
    issues.push({
      kind: 'id-collision',
      tenantId: NATIONAL_REMOVED_TENANT,
      message:
        `이 PC의 ${NATIONAL_REMOVED_TENANT}는 군산각 전국형이 아닌 다른 업체(${national.removal?.reason} · ${otherNational.industry} · ${otherNational.region})라 ` +
        '지우지 않았습니다 — 군산각 전국형을 다른 id로 등록했다면 운영자가 지우세요.',
    });
  }
  const tenants: Record<string, UnifyTenantReport> = {};
  const cohortBanks: UnifyCheck['cohortBanks'] = [];
  const unified = new Set<string>(UNIFIED_TENANTS);

  for (const tenantId of UNIFIED_TENANTS) {
    const baked = await findBakedTenant(tenantId);
    if (!baked) issues.push({ kind: 'not-baked', tenantId, message: `${tenantId}가 저장소 설정에 없습니다 — 이 설치본은 통일 전 판입니다.` });
    const hidden = deletedSet.has(tenantId);
    if (hidden) {
      issues.push({ kind: 'tombstone', tenantId, message: `${tenantId}가 지운 브랜드(툼스톤)라 목록에서 숨어 있습니다 — 쓰려면 「되살리기」를 누르세요.` });
    }
    const entry = overlay.find((t) => t.tenantId === tenantId);
    let overlayDiffers: UnifyTenantReport['overlayDiffers'] = null;
    if (entry && baked) {
      overlayDiffers = {};
      const pairs: [string, string, string][] = [
        ['marketScope', scopeOf(entry), scopeOf(baked)],
        ['industry', entry.industry, baked.industry],
        ['region', entry.region, baked.region],
        ['brandName', entry.brandName, baked.brandName],
        ['cohortOnly', String(Boolean(entry.cohortOnly)), String(Boolean(baked.cohortOnly))],
      ];
      for (const [field, a, b] of pairs) if (a !== b) overlayDiffers[field] = { overlay: a, repo: b };
      const collision = idCollision(entry, baked);
      if (collision) {
        issues.push({
          kind: 'id-collision',
          tenantId,
          message:
            `이 PC의 ${tenantId}는 다른 업체(${collision} · ${entry.industry} · ${entry.region})인데 저장소 설정의 ${baked.brandName}가 같은 id를 씁니다 — ` +
            `저장소 설정이 이겨 그 업체는 목록에서 가려지고, data/${tenantId}/의 지난 기록이 ${baked.brandName}의 기록처럼 보입니다. ` +
            '정리는 이 id를 건너뛰었습니다. 운영자에게 알려 주세요.',
        });
      }
    }

    const banks: UnifyTenantReport['banks'] = [];
    for (const version of await listBundledVersions(tenantId)) {
      const bundled = await readBundledBank(tenantId, version);
      const local = await readJsonState<QuestionBank>(path.join(PIPELINE_DATA_DIR, tenantId, 'question-bank', `${version}.json`));
      if (local === null) banks.push({ version, state: 'missing' });
      else if (local === 'unreadable') {
        banks.push({ version, state: 'unreadable' });
        issues.push({ kind: 'bank-unreadable', tenantId, message: `${tenantId} 질문 은행 ${version}을 읽지 못합니다 — 그 판을 재면 측정이 멈춥니다.` });
      } else {
        const diff = bundled ? bankQuestionsDiffer(local, bundled) : null;
        banks.push(diff ? { version, state: 'differs', detail: diff } : { version, state: 'same' });
        if (diff) {
          issues.push({ kind: 'bank-differs', tenantId, message: `${tenantId} 질문 은행 ${version}이 설치본의 것과 다릅니다(${diff}) — 그 판을 재면 측정이 멈춥니다.` });
        }
      }
    }

    const files: string[] = [];
    for (const name of REPORTED_FILES) if (await exists(path.join(PIPELINE_DATA_DIR, tenantId, name))) files.push(name);
    tenants[tenantId] = {
      baked: baked ? { questionBankVersion: baked.questionBankVersion, industry: baked.industry, region: baked.region, marketScope: scopeOf(baked) } : null,
      hidden,
      overlayDiffers,
      banks,
      files,
    };

    if (baked?.cohortQuestionBank) {
      const key = cohortKey(baked.industry, baked.region);
      const version = baked.cohortQuestionBank;
      if (cohortBanks.some((c) => c.key === key && c.version === version)) continue;
      if (!BUNDLED_COHORT_BANK_DIR) {
        cohortBanks.push({ key, version, state: 'not-compared' });
        continue;
      }
      const local = await readJsonState<{ questions: QuestionBank['questions'] }>(path.join(COHORT_BANK_DIR, key, `${version}.json`));
      const bundled = await readJsonState<{ questions: QuestionBank['questions'] }>(path.join(BUNDLED_COHORT_BANK_DIR, key, `${version}.json`));
      if (local === null) cohortBanks.push({ key, version, state: 'missing' });
      else if (local === 'unreadable' || bundled === 'unreadable' || bundled === null) cohortBanks.push({ key, version, state: local === 'unreadable' ? 'unreadable' : 'not-compared' });
      else {
        const diff = bankQuestionsDiffer({ version, generatedAt: '', questions: local.questions }, { version, generatedAt: '', questions: bundled.questions });
        cohortBanks.push(diff ? { key, version, state: 'differs', detail: diff } : { key, version, state: 'same' });
        if (diff) {
          issues.push({
            kind: 'cohort-differs',
            tenantId,
            message: `코호트 공통 질문지 ${key}/${version}이 설치본의 기준본과 다릅니다(${diff}) — 이 PC의 같은 코호트 경쟁사는 다른 시험지를 풉니다.`,
          });
        }
      }
    }
  }

  // 같은 홈페이지를 쓰는 다른 id — 목록에 있는 것과 오버레이에 남은 것(숨은 것 포함).
  const unifiedConfigs = [...unified].map((id) => runtime.find((t) => t.tenantId === id) ?? overlay.find((t) => t.tenantId === id)).filter((t): t is TenantConfig => Boolean(t));
  const candidates = new Map<string, TenantConfig>();
  for (const t of [...runtime, ...overlay]) if (!unified.has(t.tenantId) && !candidates.has(t.tenantId)) candidates.set(t.tenantId, t);
  const sameSite: UnifyCheck['sameSite'] = [];
  for (const t of candidates.values()) {
    const sharesWith = unifiedConfigs.filter((u) => sharesSite({ ownedDomains: u.ownedDomains ?? [] }, { ownedDomains: t.ownedDomains ?? [] })).map((u) => u.tenantId);
    if (sharesWith.length === 0) continue;
    const hidden = deletedSet.has(t.tenantId);
    sameSite.push({ tenantId: t.tenantId, brandName: t.brandName, industry: t.industry, region: t.region, marketScope: scopeOf(t), cohortOnly: Boolean(t.cohortOnly), hidden, sharesWith });
    if (!hidden && !t.cohortOnly) {
      issues.push({
        kind: 'same-site',
        tenantId: t.tenantId,
        message: `${t.tenantId}(${t.brandName} · ${t.industry} · ${t.region})가 ${sharesWith.join(' · ')}와 같은 홈페이지를 씁니다 — 같은 브랜드를 다른 id로 등록했다면 운영자가 지우세요.`,
      });
    }
  }

  return { version: UNIFY_VERSION, checkedAt: now.toISOString(), cleanup, issues, tenants, sameSite, cohortBanks, nationalRemoval: national.removal };
}

/** 군산각 전국형 한 번 지우기를 하고 로그를 남긴다 — 미루거나 멈추면 점검이 알린다(던지지 않는다). */
async function runNationalRemoval(store: ResultStore): Promise<NationalRemovalOutcome> {
  try {
    const { ran, removal, deferred } = await removeNationalOnce(store);
    if (deferred) return { removal: null, problem: { kind: 'national-deferred', message: deferred } };
    if (ran && removal?.action === 'deleted') {
      console.log(
        `[unify] 군산각 전국형(${NATIONAL_REMOVED_TENANT})을 지움${removal.resumed ? '(지난 시작에 멈춘 지우기를 마저 함)' : ''} — 화면의 「빼기」와 같음(툼스톤 · 되살리기 가능), ` +
          `측정 기록은 data/${NATIONAL_REMOVED_TENANT}/에 남음 · 순위 다시 매긴 카드 ${removal.ranksUpdated ?? 0}장`,
      );
    } else if (ran && removal?.action === 'skipped-collision') {
      console.log(`[unify] 군산각 전국형(${NATIONAL_REMOVED_TENANT}) — 이 PC의 그 id는 다른 업체(${removal.reason})라 지우지 않음`);
    } else if (ran && removal) {
      console.log(`[unify] 군산각 전국형(${NATIONAL_REMOVED_TENANT}) — 이 PC 목록에 없음${removal.hidden ? '(이미 지운 브랜드)' : ''}, 지울 것 없음`);
    }
    return { removal };
  } catch (err) {
    const message = `${NATIONAL_REMOVED_TENANT}를 지우지 못했습니다(${err instanceof Error ? err.message : String(err)}) — 다음 시작 때 다시 지우거나 남은 단계를 마저 합니다.`;
    return { removal: null, problem: { kind: 'national-delete-failed', message } };
  }
}

/**
 * 서버 시작 때 — 정리(한 번) · 군산각 전국형 지우기(한 번) 뒤 점검을 userData/unify-check.json과 로그에 남긴다. 패키징이 아니면
 * 아무것도 하지 않는다.
 */
export async function runBrandUnify(store: ResultStore): Promise<void> {
  if (!packagedDataMode() || process.env.VERCEL) return;
  let cleanup: UnifyCleanup | null = null;
  let cleanupFailure: string | undefined;
  try {
    const result = await unifyCleanupOnce();
    cleanup = result.cleanup;
    if (result.ran) {
      const moved = result.cleanup.moved.map((m) => m.from).join(', ');
      const skipped = (result.cleanup.skipped ?? []).map((k) => `${k.from ?? k.tenantId}(${k.reason})`).join(', ');
      console.log(`[unify] 브랜드 통일 정리(${UNIFY_VERSION}) — ${moved ? `옮김: ${moved} → ${UNIFY_BACKUP_DIR}/` : '옮길 파일 없음'}${skipped ? ` · 건너뜀: ${skipped}` : ''}`);
    }
  } catch (err) {
    // 점검(unify-check.json)의 cleanup-failed로 올리고 로그에도 남긴다(아래 issues 출력).
    cleanupFailure = err instanceof Error ? err.message : String(err);
  }
  const national = await runNationalRemoval(store);
  const check = await checkBrandUnify(cleanup, new Date(), cleanupFailure, national);
  await writeJsonAtomic(stateFilePath(UNIFY_CHECK_FILE), check);
  if (check.issues.length === 0) {
    console.log(`[unify] 점검 — 알릴 것 없음(${stateFilePath(UNIFY_CHECK_FILE)})`);
    return;
  }
  console.warn(`[unify] 점검 — 알릴 것 ${check.issues.length}건(${stateFilePath(UNIFY_CHECK_FILE)})`);
  for (const issue of check.issues) console.warn(`[unify]   ${issue.message}`);
}
