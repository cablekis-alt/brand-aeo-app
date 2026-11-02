import { access, mkdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { BUNDLED_COHORT_BANK_DIR, COHORT_BANK_DIR, packagedDataMode, PIPELINE_DATA_DIR, stateFilePath } from './appPaths.js';
import { bankQuestionsDiffer, listBundledVersions, readBundledBank } from './bundledBanks.js';
import { cohortKey } from './cohortQuestionBank.js';
import type { QuestionBank } from './store.js';
import { findBakedTenant, loadRuntimeTenants } from './tenantRegistry.js';
import { readOverlay } from './tenantOverlay.js';
import { readDeletedTenants } from './tenantTombstone.js';
import { writeJsonAtomic } from './tenantWriteQueue.js';
import type { TenantConfig } from './types.js';
import { sharesSite } from '../src/lib/brandVariant.js';

/**
 * v0.4.49 브랜드 통일 — 스테이,머뭄(web4ai) · 군산각 지역형(gunsan) · 군산각 전국형(gunsan-national)을 모든 PC에서 같은 설정 · 같은
 * 질문지로 잰다. 설정은 저장소 설정(server/tenants.config.json)에 굽고, 질문지는 설치본에 담는다(bundledBanks.ts). 여기서는 그 둘로
 * 통일되지 않는 PC별 파일을 다룬다(서버 시작 때, seedFirstRunIfEmpty 바로 뒤 — server/index.ts).
 *
 * 1. 한 번만 하는 정리 — 세 브랜드의 engines.json · market-scope.json을 data/<id>/before-unify-0.4.49/로 옮긴다(이름 바꾸기 — 지우지
 *    않는다). 두 파일은 저장소 설정의 엔진 · 시장 범위를 PC마다 덮는다(tenantRegistry.ts mergeRuntimeTenants). 표식 파일
 *    (userData/brand-unify-0.4.49.json)이 있으면 다시 하지 않는다 — 그 뒤 앱에서 다시 고친 값은 사람이 고친 것이다. fact-graph.json ·
 *    owned-domains.json · publish-settings.json · brand-page.json은 건드리지 않는다.
 * 2. 읽기만 하는 점검 — 시작할 때마다 userData/unify-check.json(과 로그)에 남긴다. 같은 홈페이지를 쓰는 다른 id(군산각을 다른 id로
 *    등록한 PC — 운영자가 지운다), 세 브랜드를 숨긴 툼스톤, 저장소 설정과 다른 오버레이 항목, 동봉본과 다른 코호트 공통 질문지 · 질문지,
 *    남아 있는 PC별 파일.
 * 패키징(설치본)에서만 한다 — dev 체크아웃의 data/는 개발자 것이고, 웹은 이 서버를 쓰지 않는다.
 */
export const UNIFY_VERSION = '0.4.49';
export const UNIFIED_TENANTS = ['web4ai', 'gunsan', 'gunsan-national'] as const;
export const UNIFY_BACKUP_DIR = `before-unify-${UNIFY_VERSION}`;
export const UNIFY_MARKER_FILE = `brand-unify-${UNIFY_VERSION}.json`;
export const UNIFY_CHECK_FILE = 'unify-check.json';
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
  /** 옮긴 파일 — data/ 기준 상대 경로(원래 자리 → 백업 자리). */
  moved: { from: string; to: string }[];
}

/**
 * 한 번만 하는 정리. 이미 했으면 그때의 기록을 돌려준다. 옮기지 못한 파일이 있으면 표식을 남기지 않고 던진다 — 다음 시작 때 다시 한다.
 * 백업 자리에 이미 파일이 있으면 덮지 않고 그 파일은 옮기지 않는다(던진다).
 */
export async function unifyCleanupOnce(now: Date = new Date()): Promise<{ ran: boolean; cleanup: UnifyCleanup }> {
  const marker = stateFilePath(UNIFY_MARKER_FILE);
  if (await exists(marker)) return { ran: false, cleanup: JSON.parse(await readFile(marker, 'utf-8')) as UnifyCleanup };
  const moved: UnifyCleanup['moved'] = [];
  const failed: string[] = [];
  for (const tenantId of UNIFIED_TENANTS) {
    for (const name of MOVED_FILES) {
      const from = path.join(PIPELINE_DATA_DIR, tenantId, name);
      if (!(await exists(from))) continue;
      const to = path.join(PIPELINE_DATA_DIR, tenantId, UNIFY_BACKUP_DIR, name);
      if (await exists(to)) {
        failed.push(`${to}에 이미 파일이 있어 ${from}을 옮기지 않았습니다(덮지 않음)`);
        continue;
      }
      try {
        await mkdir(path.dirname(to), { recursive: true });
        await rename(from, to);
        moved.push({ from: path.relative(PIPELINE_DATA_DIR, from), to: path.relative(PIPELINE_DATA_DIR, to) });
      } catch (err) {
        failed.push(`${from}을 옮기지 못했습니다(${err instanceof Error ? err.message : String(err)})`);
      }
    }
  }
  if (failed.length > 0) {
    const done = moved.map((m) => m.from).join(', ');
    throw new Error(`브랜드 통일 정리를 마치지 못했습니다 — ${failed.join(' · ')}${done ? ` (옮긴 것: ${done})` : ''}. 다음 시작 때 다시 합니다.`);
  }
  const cleanup: UnifyCleanup = { version: UNIFY_VERSION, doneAt: now.toISOString(), moved };
  await writeJsonAtomic(marker, cleanup);
  return { ran: true, cleanup };
}

export interface UnifyIssue {
  kind: 'same-site' | 'tombstone' | 'bank-differs' | 'bank-unreadable' | 'cohort-differs' | 'not-baked';
  tenantId: string;
  message: string;
}

export interface UnifyTenantReport {
  /** 저장소 설정 값(굽지 않은 설치본이면 null). */
  baked: { questionBankVersion: string; industry: string; region: string; marketScope: string } | null;
  /** 툼스톤에 걸려 목록에서 숨었는가. */
  hidden: boolean;
  /** 오버레이 항목이 저장소 설정과 다른 값(범위 · 업종 · 지역) — 저장소 설정이 이기므로 쓰이지 않는다. 오버레이에 없으면 null. */
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
  /** 세 브랜드와 같은 홈페이지를 쓰는 다른 id. */
  sameSite: { tenantId: string; brandName: string; industry: string; region: string; marketScope: string; cohortOnly: boolean; hidden: boolean; sharesWith: string[] }[];
  /** 세 브랜드가 쓰는 코호트 공통 질문지 — 이 PC 것과 동봉 기준본. 동봉 기준본이 없는 실행(dev)이면 비교하지 않는다. */
  cohortBanks: { key: string; version: string; state: 'same' | 'differs' | 'missing' | 'unreadable' | 'not-compared'; detail?: string }[];
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

/** 읽기만 하는 점검 — 아무 파일도 쓰지 않는다(질문지를 가져오지도 않는다). */
export async function checkBrandUnify(cleanup: UnifyCleanup | null, now: Date = new Date()): Promise<UnifyCheck> {
  const [runtime, overlay, deleted] = await Promise.all([loadRuntimeTenants(), readOverlay(), readDeletedTenants()]);
  const deletedSet = new Set(deleted);
  const issues: UnifyIssue[] = [];
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
      ];
      for (const [field, a, b] of pairs) if (a !== b) overlayDiffers[field] = { overlay: a, repo: b };
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

  return { version: UNIFY_VERSION, checkedAt: now.toISOString(), cleanup, issues, tenants, sameSite, cohortBanks };
}

/** 서버 시작 때 — 정리(한 번) 뒤 점검을 userData/unify-check.json과 로그에 남긴다. 패키징이 아니면 아무것도 하지 않는다. */
export async function runBrandUnify(): Promise<void> {
  if (!packagedDataMode() || process.env.VERCEL) return;
  let cleanup: UnifyCleanup | null = null;
  try {
    const result = await unifyCleanupOnce();
    cleanup = result.cleanup;
    if (result.ran) {
      const moved = result.cleanup.moved.map((m) => m.from).join(', ');
      console.log(`[unify] 브랜드 통일 정리(${UNIFY_VERSION}) — ${moved ? `옮김: ${moved} → ${UNIFY_BACKUP_DIR}/` : '옮길 파일 없음'}`);
    }
  } catch (err) {
    console.warn(`[unify] ${err instanceof Error ? err.message : String(err)}`);
  }
  const check = await checkBrandUnify(cleanup);
  await writeJsonAtomic(stateFilePath(UNIFY_CHECK_FILE), check);
  if (check.issues.length === 0) {
    console.log(`[unify] 점검 — 알릴 것 없음(${stateFilePath(UNIFY_CHECK_FILE)})`);
    return;
  }
  console.warn(`[unify] 점검 — 알릴 것 ${check.issues.length}건(${stateFilePath(UNIFY_CHECK_FILE)})`);
  for (const issue of check.issues) console.warn(`[unify]   ${issue.message}`);
}
