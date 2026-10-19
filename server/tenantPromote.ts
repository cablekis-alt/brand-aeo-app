import { access, mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PIPELINE_DATA_DIR } from './appPaths.js';
import { readCohortExclusions, updateCohortExclusions, type CohortExclusion } from './cohortExclusionStore.js';
import { competitorDraftId } from './cohortPlan.js';
import { affectedCohortWeeks, reconcileCohortRanks } from './cohortRank.js';
import { EditorError, saveEdit } from './competitorEditor.js';
import { getIsoWeekString } from './dateUtil.js';
import { measureInFlight } from './measureTracker.js';
import { readOverlay } from './tenantOverlay.js';
import { isBakedTenant, loadRuntimeTenants, replaceOverlayTenant } from './tenantRegistry.js';
import { topicParticle } from '../src/lib/korean.js';
import type { CompetitorContext } from '../src/prompts/types.js';
import type { ResultStore } from './store.js';
import type { TenantConfig } from './types.js';

/**
 * 브랜드 등록이 이미 있는 tenantId와 부딪혔을 때 — 무엇과 부딪혔는지 가려내고, 같은 곳이면 고객 브랜드로 전환한다.
 *
 * 그냥 덮어쓰지 않는 이유: id는 홈페이지 첫 마디라(cohortPlan.ts slugFromDomain) 서로 다른 업체가 같은 id를 받는다
 * (gunsan.webforai.kr과 gunsan.go.kr은 둘 다 gunsan). 덮어쓰면 두 업체의 기록이 한 폴더에 쌓이고, 이미 있는 고객
 * 브랜드면 경쟁사 · 사실 · 질문지 설정이 말없이 사라진다. 그래서 경쟁사로만 재던 브랜드(cohortOnly)이고 홈페이지가
 * 같을 때만 전환을 연다 — id가 그대로라 지난 측정 기록이 이어진다(2026-10-16, 군산여행의 모든것).
 */
export interface TenantConflict {
  /** competitor: 경쟁사로만 재던 브랜드 · customer: 이미 등록된 고객 브랜드 · repo: 저장소 설정의 브랜드(앱에서 못 바꿈). */
  kind: 'competitor' | 'customer' | 'repo';
  tenantId: string;
  brandName: string;
  industry: string;
  region: string;
  ownedDomains: string[];
  /** 홈페이지가 같은가 — 경쟁사 브랜드와 같으면 같은 곳으로 보고 전환할 수 있다. */
  sameSite: boolean;
  /** 이 id로 쌓인 측정 주차 수. */
  weeks: number;
  /** 가장 최근 측정 주차(기록이 없으면 null). */
  lastWeekOf: string | null;
  /**
   * 가장 최근 측정이 이번 주인가. 주차 카드는 주차당 하나라 이번 주에 다시 재면 그 카드를 새 측정이 덮어쓴다 —
   * 업종이 바뀌면 경쟁사로 잰 이번 주 기록이 사라지고 옛 코호트 순위에서 빠진다(measureAndBake.ts 「떠난 코호트」).
   */
  measuredThisWeek: boolean;
  /** 경쟁사일 때 앱에서 따로 고친 설정(시장 범위 등) — 전환하면 백업으로 옮기고 등록 값을 쓴다. */
  overrides: string[];
  /** 이 브랜드(같은 홈페이지)를 경쟁사로 함께 재는 고객 브랜드 — 전환할 때 그 목록에서 뺄 수 있다. */
  referencedBy: { tenantId: string; brandName: string }[];
  /**
   * 홈페이지는 다른데 id만 같아 지금 이 브랜드로 재고 있는 경쟁사 줄(gunsan.go.kr 줄이 gunsan을 잰다).
   * 다른 곳이라 빼지 않고 알리기만 한다 — 업종이 바뀌면 그 줄은 「이름 겹침 · 측정 안 됨」이 된다.
   */
  sharedIdLines: { tenantId: string; brandName: string; line: string; domain: string }[];
}

const host = (d: string) => d.trim().toLowerCase().replace(/^www\./, '');

/**
 * 브랜드별로 앱에서 고친 설정 파일 — 베이스 · 오버레이를 모두 이긴다(tenantRegistry.ts mergeRuntimeTenants).
 * 경쟁사일 때 남은 파일을 그대로 두면 등록 화면에서 넣은 값이 말없이 무시된다. 경로는 각 저장소의 filePathFor와 같다
 * (tenantScopeStore · factGraphStore · brandPageStore · tenantEnginesStore · tenantCompetitorsStore).
 */
const OVERRIDE_FILES: { file: string; label: string }[] = [
  { file: 'market-scope.json', label: '시장 범위' },
  { file: 'fact-graph.json', label: '사실' },
  { file: 'brand-page.json', label: '브랜드 페이지' },
  { file: 'engines.json', label: '수집 엔진' },
  { file: 'competitors.json', label: '경쟁사 목록' },
];

const tenantDir = (tenantId: string) => path.join(PIPELINE_DATA_DIR, tenantId);
const isMissing = (err: unknown) => (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';

async function existingOverrides(tenantId: string): Promise<typeof OVERRIDE_FILES> {
  const found: typeof OVERRIDE_FILES = [];
  for (const item of OVERRIDE_FILES) {
    try {
      await access(path.join(tenantDir(tenantId), item.file));
      found.push(item);
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
  }
  return found;
}

/**
 * 고객의 경쟁사 한 줄이 이 브랜드를 가리키는가 — 측정할 때(cohortPlan.ts planCohortTargets)와 같은 기준으로 본다.
 * 그 줄은 첫 홈페이지(domains[0])로 기존 브랜드를 찾고, 못 찾으면 id(홈페이지 첫 마디)로 찾는다.
 *
 * - same: 첫 홈페이지가 이 브랜드의 홈페이지다(홈페이지 없는 줄은 이름으로 만든 id가 같다). 같은 곳이라 뺄 수 있다.
 * - sharedId: 첫 홈페이지는 다른데 id만 같다(gunsan.go.kr 줄도 id가 gunsan). 다른 업체라 빼지 않는다.
 * 질문 언어가 다르면 다른 테넌트(-en)를 가리킨다(competitorDraftId · planCohortTargets sameIndustry).
 */
function lineTarget(customer: TenantConfig, line: CompetitorContext, target: TenantConfig): 'same' | 'sharedId' | null {
  if ((customer.questionLanguage ?? 'ko') !== (target.questionLanguage ?? 'ko')) return null;
  const idMatch = competitorDraftId(customer, line) === target.tenantId;
  const first = line.domains?.[0];
  if (!first) return idMatch ? 'same' : null;
  if (target.ownedDomains.some((d) => host(d) === host(first))) return 'same';
  return idMatch ? 'sharedId' : null;
}

async function inspect(
  draft: TenantConfig,
  store: ResultStore,
): Promise<{ existing: TenantConfig; conflict: TenantConflict } | null> {
  const runtime = await loadRuntimeTenants();
  const existing = runtime.find((t) => t.tenantId === draft.tenantId);
  if (!existing) return null;
  const drafts = new Set(draft.ownedDomains.map(host));
  const customers = runtime.filter((t) => !t.cohortOnly && t.tenantId !== existing.tenantId);
  const referencedBy = customers
    .filter((t) => t.competitors.some((line) => lineTarget(t, line, existing) === 'same'))
    .map((t) => ({ tenantId: t.tenantId, brandName: t.brandName }));
  const sharedIdLines = customers.flatMap((t) =>
    t.competitors
      .filter((line) => lineTarget(t, line, existing) === 'sharedId')
      .map((line) => ({ tenantId: t.tenantId, brandName: t.brandName, line: line.name, domain: line.domains?.[0] ?? '' })),
  );
  const history = await store.getScorecardHistory(existing.tenantId, Number.MAX_SAFE_INTEGER);
  const lastWeekOf = history.at(-1)?.weekOf ?? null;
  const kind: TenantConflict['kind'] = (await isBakedTenant(existing.tenantId)) ? 'repo' : existing.cohortOnly ? 'competitor' : 'customer';
  return {
    existing,
    conflict: {
      kind,
      tenantId: existing.tenantId,
      brandName: existing.brandName,
      industry: existing.industry,
      region: existing.region,
      ownedDomains: existing.ownedDomains,
      sameSite: existing.ownedDomains.some((d) => drafts.has(host(d))),
      weeks: history.length,
      lastWeekOf,
      measuredThisWeek: lastWeekOf === getIsoWeekString(new Date()),
      overrides: kind === 'competitor' ? (await existingOverrides(existing.tenantId)).map((o) => o.label) : [],
      referencedBy,
      sharedIdLines,
    },
  };
}

export async function describeTenantConflict(draft: TenantConfig, store: ResultStore): Promise<TenantConflict | null> {
  return (await inspect(draft, store))?.conflict ?? null;
}

/**
 * 전환한 브랜드가 쓸 질문지 버전. 경쟁사로 잴 때 만든 질문지는 경쟁사 목록 없이(비교 질문 없이) 만든 것이라 다시 쓰면
 * 안 되고, 코호트 출처가 다르면 첫 측정이 「questionBankVersion을 새 값으로 올리세요」로 멈춘다
 * (cohortQuestionBank.ts ensureComposedQuestionBank). 그 버전 파일이 이미 있으면 안 쓰인 다음 번호로 올린다 —
 * 지난 주차는 자기 버전의 질문지를 그대로 읽고, 화면은 질문지가 바뀐 주를 「질문지 v3→v6」로 비교에서 뺀다.
 */
async function freshBankVersion(tenantId: string, wanted: string): Promise<string> {
  let files: string[];
  try {
    files = await readdir(path.join(tenantDir(tenantId), 'question-bank'));
  } catch (err) {
    if (isMissing(err)) return wanted;
    throw err;
  }
  const used = new Set(files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length)));
  if (!used.has(wanted)) return wanted;
  const numbers = [...used, wanted].map((v) => /^v(\d+)$/.exec(v)?.[1]).filter((n): n is string => Boolean(n)).map(Number);
  let next = Math.max(0, ...numbers) + 1;
  while (used.has(`v${next}`)) next += 1;
  return `v${next}`;
}

/** 옮긴 설정 파일을 제자리로 돌린다 — 오버레이를 못 바꿨을 때. 하나라도 못 돌리면 남기고 알린다. */
async function restoreFiles(tenantId: string, backupDir: string, moved: string[]): Promise<void> {
  for (const file of moved) {
    try {
      await rename(path.join(backupDir, file), path.join(tenantDir(tenantId), file));
    } catch (err) {
      console.error(`[tenantPromote] ${tenantId}: ${file}을 백업(${backupDir})에서 되돌리지 못했습니다 — ${err instanceof Error ? err.message : err}`);
    }
  }
}

export interface PromoteResult {
  ok: true;
  tenantId: string;
  brandName: string;
  /** 새로 쓰는 질문지 버전(경쟁사 때 질문지가 같은 버전에 있으면 올린다). */
  questionBankVersion: string;
  /** 백업으로 옮긴 경쟁사 때의 설정(시장 범위 등). */
  setAside: string[];
  /** 옛 항목과 옮긴 설정을 둔 폴더 이름(data/<id>/ 아래). */
  backupDir: string;
  /** 경쟁사 목록에서 이 브랜드를 뺀 고객 브랜드. */
  removedFrom: string[];
  /** 빼지 못한 고객 브랜드와 이유(전환은 이미 됐다). */
  removeErrors: { tenantId: string; error: string }[];
}

/**
 * 경쟁사로만 재던 브랜드를 고객 브랜드로 전환한다 — id를 그대로 두고 등록 화면에서 넣은 값으로 바꾼다.
 *
 * 1. 옛 오버레이 항목을 data/<id>/before-promote-<시각>/에 남기고, 경쟁사일 때 고친 설정 파일을 그리로 옮긴다.
 * 2. 질문지 버전이 이미 쓰였으면 올린다(freshBankVersion).
 * 3. 오버레이 항목을 바꾼다. 실패하면 옮긴 파일을 되돌린다.
 * 4. removeFrom의 고객 브랜드에서는 이 브랜드를 가리키는 경쟁사 줄을 뺀다(업종이 바뀌면 그 브랜드 측정에서
 *    「이름 겹침 · 측정 안 됨」으로 남기 때문 — cohortPlan.ts). 빼기는 경쟁사 편집 저장과 같은 길이라 되돌릴 수 있다.
 */
export async function promoteCompetitor(draft: TenantConfig, removeFrom: string[], store: ResultStore): Promise<PromoteResult> {
  if (measureInFlight()) throw new EditorError(409, '측정이 진행 중이에요. 끝난 뒤에 전환해 주세요.');
  const found = await inspect(draft, store);
  if (!found) throw new EditorError(404, `전환할 브랜드가 없습니다: ${draft.tenantId} — 그냥 등록하세요.`);
  const { existing, conflict } = found;
  if (conflict.kind === 'customer') throw new EditorError(409, `${topicParticle(conflict.brandName)} 이미 고객 브랜드예요 — 브랜드 관리에서 고치세요.`);
  if (conflict.kind === 'repo') throw new EditorError(409, `${topicParticle(conflict.brandName)} 저장소 설정에 있는 브랜드라 앱에서 바꿀 수 없어요.`);
  if (!conflict.sameSite) {
    throw new EditorError(409, `같은 id(${conflict.tenantId})를 쓰는 다른 곳(${conflict.ownedDomains.join(', ') || '홈페이지 없음'})이 있어 전환할 수 없어요.`);
  }

  const questionBankVersion = await freshBankVersion(draft.tenantId, draft.questionBankVersion);
  const backupName = `before-promote-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const backupDir = path.join(tenantDir(draft.tenantId), backupName);
  // 옛 항목을 못 읽었으면(읽기 실패는 readOverlay가 []로 돌려준다) 아무것도 옮기지 않는다 — 빈 백업을 남기고
  // 바꾸면 옛 경쟁사 항목이 어디에도 남지 않는다.
  const previous = (await readOverlay()).find((t) => t.tenantId === draft.tenantId);
  if (!previous) throw new EditorError(409, `${draft.tenantId}의 지금 설정을 읽지 못했어요. 잠시 뒤 다시 전환해 주세요.`);
  await mkdir(backupDir, { recursive: true });
  await writeFile(path.join(backupDir, 'overlay-entry.json'), JSON.stringify(previous, null, 2), 'utf-8');

  const moved: string[] = [];
  const setAside: string[] = [];
  for (const item of OVERRIDE_FILES) {
    try {
      await rename(path.join(tenantDir(draft.tenantId), item.file), path.join(backupDir, item.file));
      moved.push(item.file);
      setAside.push(item.label);
    } catch (err) {
      if (isMissing(err)) continue;
      await restoreFiles(draft.tenantId, backupDir, moved);
      throw err;
    }
  }
  try {
    await replaceOverlayTenant({ ...draft, questionBankVersion, cohortOnly: undefined });
  } catch (err) {
    await restoreFiles(draft.tenantId, backupDir, moved);
    throw err;
  }

  const removedFrom: string[] = [];
  const removeErrors: PromoteResult['removeErrors'] = [];
  // 경쟁사일 때 다른 고객이 「지난 기록에서도 빼기」로 뺀 기록을 푼다 — 고객 브랜드가 되면 자기 코호트에서 자기 카드가 빠진 채
  // 남고, 고객 브랜드는 서랍의 예전 경쟁사에 나오지 않아 풀 곳이 없다. 실패해도 전환은 되돌리지 않고 알린다.
  try {
    let released: CohortExclusion[] = [];
    // 뺀 기록이 없으면 파일을 쓰지 않는다(전환마다 쓰지 않게).
    if ((await readCohortExclusions()).some((e) => e.tenantId === draft.tenantId)) await updateCohortExclusions((entries) => {
      released = entries.filter((e) => e.tenantId === draft.tenantId);
      return entries.filter((e) => e.tenantId !== draft.tenantId);
    });
    for (const k of await affectedCohortWeeks(store, released)) await reconcileCohortRanks(store, k.industry, k.region, k.weekOf);
  } catch (err) {
    console.error(`[tenantPromote] ${draft.tenantId} 코호트 제외 해제 실패:`, err);
    removeErrors.push({ tenantId: draft.tenantId, error: `지난 기록 제외를 풀지 못했어요: ${err instanceof Error ? err.message : String(err)}` });
  }
  const runtime = await loadRuntimeTenants();
  for (const id of new Set(removeFrom)) {
    const customer = runtime.find((t) => t.tenantId === id && !t.cohortOnly);
    if (!customer) {
      removeErrors.push({ tenantId: id, error: '고객 브랜드가 아닙니다.' });
      continue;
    }
    const kept = customer.competitors.filter((line) => lineTarget(customer, line, existing) !== 'same');
    if (kept.length === customer.competitors.length) continue;
    try {
      await saveEdit(id, store, { competitors: kept, summary: `빼기 · ${draft.brandName}(고객 브랜드로 전환)` });
      removedFrom.push(id);
    } catch (err) {
      removeErrors.push({ tenantId: id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return {
    ok: true,
    tenantId: draft.tenantId,
    brandName: draft.brandName,
    questionBankVersion,
    setAside,
    backupDir: backupName,
    removedFrom,
    removeErrors,
  };
}
