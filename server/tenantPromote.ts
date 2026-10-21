import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PIPELINE_DATA_DIR } from './appPaths.js';
import { isPhotoMedical } from '../src/lib/articlePhotos.js';
import { hostKey, sameCohort, sharesSite, variantTenantId } from '../src/lib/brandVariant.js';
import { readCohortExclusions, updateCohortExclusions, type CohortExclusion } from './cohortExclusionStore.js';
import { competitorDraftId } from './cohortPlan.js';
import { affectedCohortWeeks, reconcileCohortRanks } from './cohortRank.js';
import { EditorError, planEdit, saveEdit } from './competitorEditor.js';
import { getIsoWeekString } from './dateUtil.js';
import { measureInFlight } from './measureTracker.js';
import { readOverlay } from './tenantOverlay.js';
import { cohortBankFor, freshBankVersion, isBakedTenant, loadRuntimeTenants, registerTenant, replaceOverlayTenant } from './tenantRegistry.js';
import { subjectParticle, topicParticle } from '../src/lib/korean.js';
import type { CompetitorContext, FactGraphNode } from '../src/prompts/types.js';
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
  /** 이 초안의 홈페이지를 쓰는 고객 브랜드(부딪힌 브랜드 포함) — 「다른 범위로 하나 더 등록」 패널이 보인다. */
  siblings: { tenantId: string; brandName: string; industry: string; region: string; marketScope: string }[];
  /**
   * 같은 홈페이지를 다른 범위로 하나 더 등록할 때(lib/brandVariant.ts) — 새 id와, 못 하면 그 이유. 부딪힌 곳이 고객 · 저장소
   * 브랜드이고 홈페이지(플랫폼 주소 말고)가 같을 때만 채운다(경쟁사면 「고객 브랜드로 전환」). twinId는 막은 같은 코호트 브랜드,
   * sameSettings는 그 브랜드가 부딪힌 브랜드 자신이고 범위까지 같을 때 — 같은 설정으로 다시 누른 것이라 화면이 「이미 등록된
   * 브랜드」로 안내한다. restoredWeeks는 지운 같은 id에 남은 기록 주 수.
   */
  variant: { tenantId: string; blocked: string | null; twinId: string | null; sameSettings: boolean; restoredWeeks: number } | null;
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

async function existingOverrides(tenantId: string, files = OVERRIDE_FILES): Promise<typeof OVERRIDE_FILES> {
  const found: typeof OVERRIDE_FILES = [];
  for (const item of files) {
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
  const sameSite = existing.ownedDomains.some((d) => drafts.has(host(d)));
  const siblings = runtime
    .filter((t) => !t.cohortOnly && sharesSite(t, draft))
    .map((t) => ({ tenantId: t.tenantId, brandName: t.brandName, industry: t.industry, region: t.region, marketScope: t.marketScope ?? 'local' }));
  return {
    existing,
    conflict: {
      kind,
      tenantId: existing.tenantId,
      brandName: existing.brandName,
      industry: existing.industry,
      region: existing.region,
      ownedDomains: existing.ownedDomains,
      sameSite,
      weeks: history.length,
      lastWeekOf,
      measuredThisWeek: lastWeekOf === getIsoWeekString(new Date()),
      overrides: kind === 'competitor' ? (await existingOverrides(existing.tenantId)).map((o) => o.label) : [],
      referencedBy,
      sharedIdLines,
      siblings,
      // 플랫폼 주소(blog.naver.com 등)만 같으면 다른 업체다 — 범위 변형으로 묶으면 남의 별칭 · GA4 · 사실을 물려받는다.
      variant: sameSite && kind !== 'competitor' && sharesSite(existing, draft) ? await planVariant(draft, existing, runtime, store) : null,
    },
  };
}

/**
 * 같은 홈페이지를 다른 범위로 하나 더 등록할 수 있는가 — 새 id(lib/brandVariant.ts variantTenantId)와 막히는 이유.
 * 홈페이지를 공유하는 브랜드(경쟁사 포함) 중 업종 · 지역 · 언어가 같은 곳이 있으면 같은 질문지 · 순위표를 쓰게 되므로 막는다.
 * 범위 꼬리 id가 이미 있으면(같은 범위의 두 번째 변형) 막지 않고 -2를 붙인다 — 막으면 업종 · 지역을 바꿔도 풀리지 않는다.
 */
async function planVariant(
  draft: TenantConfig,
  existing: TenantConfig,
  runtime: TenantConfig[],
  store: ResultStore,
): Promise<NonNullable<TenantConflict['variant']>> {
  const tenantId = variantTenantId(existing, draft.marketScope, runtime);
  // 등록할 때 바탕 브랜드의 홈페이지까지 합치므로(registerVariant) 같은 코호트도 그 범위에서 찾는다 — 초안 주소만 보면 통과라고
  // 안내한 뒤 registerTenant의 같은 검사에서 막힌다.
  const registered = { ...draft, ownedDomains: [...draft.ownedDomains, ...existing.ownedDomains] };
  const twin = runtime.find((t) => sharesSite(t, registered) && sameCohort(t, draft));
  const blocked = twin
    ? `${twin.brandName}(${twin.tenantId})${subjectParticle(twin.brandName).slice(twin.brandName.length)} 이미 ${twin.industry} · ${twin.region}에 있어요. 업종이나 지역을 바꿔야 다른 질문지로 재요` +
      (draft.region === '국내' && (twin.marketScope ?? 'local') !== (draft.marketScope ?? 'local')
        ? ' — 전국형과 B2B형은 지역이 둘 다 「국내」라 업종까지 같으면 같은 코호트예요.'
        : '.')
    : null;
  // 지운 같은 id의 기록 — 등록하면 툼스톤이 걷혀 그 기록이 되살아난다(registerTenant).
  const restoredWeeks = blocked ? 0 : (await store.getScorecardHistory(tenantId, Number.MAX_SAFE_INTEGER)).length;
  // 부딪힌 브랜드 자신과 범위까지 같으면 같은 설정으로 다시 누른 것이다. 범위만 바꿨으면(전국형 → B2B형) 막힌 까닭(「국내」)을 보여야 한다.
  const sameSettings = twin?.tenantId === existing.tenantId && (existing.marketScope ?? 'local') === (draft.marketScope ?? 'local');
  return { tenantId, blocked, twinId: twin?.tenantId ?? null, sameSettings, restoredWeeks };
}

export async function describeTenantConflict(draft: TenantConfig, store: ResultStore): Promise<TenantConflict | null> {
  return (await inspect(draft, store))?.conflict ?? null;
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
    // 공통 질문지는 들어가는 코호트의 고객 브랜드가 쓰는 버전을 따른다(tenantRegistry.ts cohortBankFor).
    const cohortQuestionBank = cohortBankFor(draft, await loadRuntimeTenants());
    await replaceOverlayTenant({ ...draft, questionBankVersion, cohortOnly: undefined, ...(cohortQuestionBank ? { cohortQuestionBank } : {}) });
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
      // 그 경쟁사를 짚은 비교 질문은 빼기와 같다(질문 넘겨받기 — competitorEditor.ts). 빼기만이면 고쳐 쓸 문장이 없어 그대로 저장한다.
      // 올라오는 대기 줄이 질문을 넘겨받아 고쳐 써야 하면 여기서는 하지 않는다 — 고친 문장을 확인할 곳은 서랍뿐이다.
      // 이미 재는 다른 경쟁사에 넘기지 않는다(고친 문장을 볼 화면이 없다) — 새로 든 곳이 없으면 그 질문은 빠진다.
      const questions = (await planEdit(customer, runtime, store, kept, undefined, undefined, { existingReceivers: false })).questions;
      if (questions.mode === 'derive' && questions.items.some((i) => i.action === 'rewrite')) {
        removeErrors.push({
          tenantId: id,
          error: `${draft.brandName} 자리에 드는 경쟁사가 비교 질문을 넘겨받아 고쳐 써야 해요 — 경쟁사 편집 서랍에서 빼 주세요.`,
        });
        continue;
      }
      await saveEdit(id, store, {
        competitors: kept,
        summary: `빼기 · ${draft.brandName}(고객 브랜드로 전환)`,
        ...(questions.mode === 'derive' ? { questions: { key: questions.key, drafts: [], receivers: 'incoming' } } : {}),
      });
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

/**
 * 지운 같은 id에 남아 있으면 등록 값 · 바탕 브랜드에서 가져올 값을 이기는 파일 — 앱에서 고친 설정과 발행 설정. 새 브랜드는 바탕 브랜드의
 * 값이나 빈 값으로 시작해야 한다(지운 브랜드의 문의 링크 · 블로그 주소로 글을 내보내지 않게).
 */
const VARIANT_SET_ASIDE: { file: string; label: string }[] = [...OVERRIDE_FILES, { file: 'publish-settings.json', label: '발행 설정' }];

export interface VariantResult {
  ok: true;
  tenantId: string;
  brandName: string;
  /** 새 브랜드의 질문지 버전 — 첫 측정에서 만든다. */
  questionBankVersion: string;
  /** 바탕 브랜드에서 가져온 설정. */
  copied: string[];
  /** 가져오지 못한 설정과 이유(등록은 이미 됐다). */
  copyErrors: { file: string; error: string }[];
  /** 지운 같은 id에 남아 있어 백업으로 옮긴 설정. */
  setAside: string[];
  /** 지운 같은 id에서 되살아난 기록 주 수. */
  restoredWeeks: number;
}

/**
 * 같은 홈페이지를 다른 시장 범위로 하나 더 등록한다 — 부딪힌 브랜드와 그 기록은 그대로 두고 id에 범위 꼬리를 붙인 새 고객 브랜드를
 * 만든다(lib/brandVariant.ts). 영어 질문 측정(-en)과 같은 방식이다. 지난 기록은 옮기지 않는다 — 새 브랜드는 0주에서 시작한다.
 *
 * 1. 다시 살핀다(inspect) — 홈페이지가 같은 고객 · 저장소 브랜드이고 막히지 않았을 때만.
 * 2. 지운 같은 id에 남은 설정 파일(VARIANT_SET_ASIDE)은 before-variant-<시각>/으로 옮긴다.
 * 3. 등록한다 — 별칭 · 홈페이지는 바탕 브랜드와 합친다(다듬어 둔 별칭 · 옛 도메인을 물려받아야 언급 · 자사 인용 판정이 같다).
 *    가져오기를 켜면 사실 · 브랜드 페이지는 바탕 브랜드의 실제 값(저장소 설정 · 오버레이 · 앱에서 고친 파일을 합친 값)을 새 브랜드
 *    설정에 넣는다 — 앱에서 고친 파일만 복사하면 저장소 · 등록 때 넣은 사실과 브랜드 페이지가 빠졌다(2026-10-21 검토). 사실은 바탕
 *    브랜드 것을 먼저 두고 등록 화면에서 고른 것 중 겹치지 않는 것을 더한다. 등록이 막히면 옮긴 파일을 되돌린다.
 * 4. 지운 id의 기록이 되살아나면 그 코호트 주차 순위를 다시 매긴다 — 지울 때 빼고 매겼다(tenantRegistry.ts deleteTenantLocally).
 * 5. 발행 설정을 복사한다. 실패해도 등록은 되돌리지 않고 알린다.
 */
export async function registerVariant(draft: TenantConfig, store: ResultStore, options: { copyBusinessFiles: boolean }): Promise<VariantResult> {
  const found = await inspect(draft, store);
  if (!found) throw new EditorError(404, `같은 홈페이지로 등록된 브랜드가 없습니다: ${draft.tenantId} — 그냥 등록하세요.`);
  const { existing, conflict } = found;
  const variant = conflict.variant;
  if (!variant) throw new EditorError(409, '홈페이지가 같은 고객 브랜드가 아니라 다른 범위로 하나 더 등록할 수 없어요.');
  if (variant.blocked) throw new EditorError(409, variant.blocked);
  // 되살아난 기록으로 코호트 순위를 다시 매기므로 측정과 겹치면 안 된다(promoteCompetitor와 같다).
  if (variant.restoredWeeks > 0 && measureInFlight()) throw new EditorError(409, '측정이 진행 중이에요. 끝난 뒤에 등록해 주세요.');
  const tenantId = variant.tenantId;
  const questionBankVersion = await freshBankVersion(tenantId, draft.questionBankVersion);

  const setAside: string[] = [];
  const moved: string[] = [];
  let backupDir = '';
  const leftovers = await existingOverrides(tenantId, VARIANT_SET_ASIDE);
  if (leftovers.length > 0) {
    backupDir = path.join(tenantDir(tenantId), `before-variant-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    await mkdir(backupDir, { recursive: true });
    for (const item of leftovers) {
      await rename(path.join(tenantDir(tenantId), item.file), path.join(backupDir, item.file));
      moved.push(item.file);
      setAside.push(item.label);
    }
  }

  const merge = (a: string[], b: string[], key: (s: string) => string) => {
    const seen = new Set<string>();
    return [...a, ...b].filter((x) => {
      const k = key(x);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  const carry = options.copyBusinessFiles;
  // 같은 사실은 띄어쓰기 차이까지 하나로 본다(lib/factApproval.ts claimKey와 같다). 등록 화면도 바탕 브랜드도 id를 fact-1부터 매기므로
  // 더하는 사실의 id가 겹치면 바꾼다 — 겹치면 빈칸 채우기 승인이 id로 찾다 바탕 사실을 덮어쓴다(2026-10-21 검토).
  const factKey = (f: FactGraphNode) => f.claim.replace(/\s+/g, '').toLowerCase();
  const baseFacts = new Set(existing.factGraph.map(factKey));
  const ids = new Set(existing.factGraph.map((f) => f.id));
  const added = draft.factGraph
    .filter((f) => !baseFacts.has(factKey(f)))
    .map((f) => {
      let id = f.id;
      for (let n = 2; ids.has(id); n += 1) id = `${f.id}-${n}`;
      ids.add(id);
      return { ...f, id };
    });
  const factGraph = carry ? [...existing.factGraph, ...added] : draft.factGraph;
  const brandPageUrl = draft.brandPageUrl ?? (carry ? existing.brandPageUrl : undefined);
  try {
    await registerTenant({
      ...draft,
      tenantId,
      questionBankVersion,
      aliases: merge(draft.aliases, existing.aliases, (s) => s.trim()),
      ownedDomains: merge(draft.ownedDomains, existing.ownedDomains, hostKey),
      factGraph,
      ...(brandPageUrl ? { brandPageUrl } : {}),
      ...(existing.ga4PropertyId && !draft.ga4PropertyId ? { ga4PropertyId: existing.ga4PropertyId } : {}),
      cohortOnly: undefined,
    });
  } catch (err) {
    if (moved.length > 0) await restoreFiles(tenantId, backupDir, moved);
    const message = err instanceof Error ? err.message : String(err);
    // registerTenant의 중복 검사(같은 id · 같은 홈페이지 · 코호트) — 살핀 뒤에 다른 등록이 끼어든 경우다.
    if (message.includes('이미 존재')) throw new EditorError(409, message);
    throw err;
  }

  if (variant.restoredWeeks > 0) {
    const history = await store.getScorecardHistory(tenantId, Number.MAX_SAFE_INTEGER);
    const weeks = new Map(history.map((c) => [`${c.industry}|${c.region}|${c.weekOf}`, c]));
    for (const { industry, region, weekOf } of weeks.values()) await reconcileCohortRanks(store, industry, region, weekOf);
  }

  const copied: string[] = [];
  const copyErrors: VariantResult['copyErrors'] = [];
  if (carry && existing.factGraph.length > 0) copied.push('사실');
  if (carry && !draft.brandPageUrl && existing.brandPageUrl) copied.push('브랜드 페이지');
  if (carry) {
    try {
      const raw = await readFile(path.join(tenantDir(existing.tenantId), 'publish-settings.json'), 'utf-8');
      const settings = JSON.parse(raw) as { photoRights?: { medical?: boolean } };
      // 의료 업종으로 등록하면 의료광고 확인 없는 사진 사용 확인은 넘기지 않는다(lib/articlePhotos photosAllowed).
      if (settings.photoRights && !settings.photoRights.medical && isPhotoMedical(draft.industry)) delete settings.photoRights;
      await mkdir(tenantDir(tenantId), { recursive: true });
      await writeFile(path.join(tenantDir(tenantId), 'publish-settings.json'), JSON.stringify(settings, null, 2), 'utf-8');
      copied.push('발행 설정');
    } catch (err) {
      if (!isMissing(err)) copyErrors.push({ file: '발행 설정', error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { ok: true, tenantId, brandName: draft.brandName, questionBankVersion, copied, copyErrors, setAside, restoredWeeks: variant.restoredWeeks };
}
