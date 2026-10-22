import 'dotenv/config';
import { execSync } from 'node:child_process';
import path from 'node:path';
import express from 'express';
import { connect as netConnect } from 'node:net';
import { packagedDataMode } from './appPaths.js';
import { seedFirstRunIfEmpty } from './seedFirstRun.js';
import { collectPage } from './aeo/collectPage.js';
import { inferAddressViaSearch, inferAliases, inferBrandFields, inferBrandFromDomain, inferBrandFromName, inferCompetitors, inferMarketScope } from './brandInference.js';
import { normalizeTenantScope, writeTenantScope } from './tenantScopeStore.js';
import { readPublishSettings, updatePublishSettings } from './publishSettingsStore.js';
import { normalizePublishSettings } from '../src/lib/publishSettings.js';
import { MARKET_SCOPES, type MarketScope } from '../src/prompts/types.js';
import { fetchAiReferrals } from './gaReferrals.js';
import { ciSyncEnabled, describeRepo, syncFromCi } from './ciSync.js';
import { tagJourneyStages } from './journeyStage.js';
import { tagQuestionTopics } from './questionTopic.js';
import { generateBrief, readBriefs } from './contentBrief.js';
import { adaptForChannel, readAdaptations } from './channelAdapt.js';
import { buildPortfolio } from './portfolio.js';
import { describeProfileEditor, planProfileEdit, saveProfileEdit } from './brandProfileEditor.js';
import {
  buildEditorState,
  checkEditorIndustry,
  EditorError,
  markEditorIndustry,
  planEdit,
  questionRewriteContext,
  resetEdit,
  saveEdit,
  undoEdit,
} from './competitorEditor.js';
import { draftCompetitorRewrites } from './competitorRewrite.js';
import { readCompetitorOverride } from './tenantCompetitorsStore.js';
import { describeTenantConflict, promoteCompetitor, registerVariant } from './tenantPromote.js';
import { DraftChangedError, generateDraft, readDrafts, saveEditedDraft, saveEvidence, saveGapFills, savePhotoPicks } from './contentDraft.js';
import { createFactGuard } from './factGuard.js';
import { fetchSitePhoto } from './sitePhoto.js';
import { publicCollectorError } from './aeo/networkSafety.js';
import { canonicalPhotoSrc, cleanPhotoAlt, isPhotoMedical, normSlotAlt, PHOTO_LIMITS, photosAllowed, type PhotoPick } from '../src/lib/articlePhotos.js';
import { buildArticleEvidence, WEEK_OF } from './articleEvidence.js';
import { channelStyleOf } from '../src/prompts/b9d-channel-adapt.js';
import { extractFactCandidates } from './factExtract.js';
import { normalizeFactGraph, readFactGraphFile, writeFactGraphFile } from './factGraphStore.js';
import { normalizeBrandPageUrl, writeBrandPageUrl } from './brandPageStore.js';
import { readSiteScores, urlBelongsToTenant, writeSiteScore } from './siteScoreStore.js';
import { getCohortTrend } from './cohortTrend.js';
import { getEngineTrend } from './engineTrend.js';
import { getUsageStats } from './usageStats.js';
import { readPricing, writePricing } from './pricingStore.js';
import { getRawAnswers } from './rawCallStore.js';
import { discoverBrands } from './competitorDiscovery.js';
import { normalizeEngineList, writeTenantEngines } from './tenantEnginesStore.js';
import { engineKeyStatus, globalCollectEngines } from './engineKeys.js';
import { findFactsForGaps } from './factForGaps.js';
import { configuredModels, getCheckEngineClient, getJudgeClient, getWriterClient, usedJudgeEngineId } from './engines/index.js';
import { cancelMeasureRun, canTriggerRemoteMeasure, listMeasureRuns, triggerGithubDelete } from './githubMeasure.js';
import { addMeasureRequest, readMeasureRequests, removeMeasureRequest } from './measureRequests.js';
import { addDeleteRequest, DELETE_QUEUE_SENTINEL } from './deleteRequests.js';
import { demoQuestionBank, demoScorecardHistory } from './demoData.js';
import { DemoResultStore } from './demoStore.js';
import { measureAndBake, measurePreview } from './measureAndBake.js';
import { readLocalMeasures } from './localMeasureLog.js';
import {
  MeasureCancelledError,
  beginMeasureRun,
  endMeasureRun,
  listActiveMeasures,
  listMeasureFailures,
  requestCancelActiveMeasures,
} from './measureTracker.js';
import { runWeeklyPipeline } from './pipeline.js';
import { getCitationBreakdown, getCitationSourceAnalysis, getEeatAnalysis, getRankingView } from './queries.js';
import { startScheduler } from './scheduler.js';
import { isActionStatus, readActionStates, sanitizeUrls, writeActionState } from './actionStates.js';
import { queueTenantWrite } from './tenantWriteQueue.js';
import { getPublishedHistory } from './publishedHistory.js';
import { getRunHistory, MAX_RUN_WEEKS } from './runHistory.js';
import {
  addPublishedPost,
  patchPublishedPost,
  PublishedPostsError,
  readPublishedPosts,
  type AddPostInput,
  type PatchPostInput,
} from './publishedPosts.js';
import { FileResultStore } from './store.js';
import {
  blobStoreEnabled,
  deleteTenantLocally,
  isBakedTenant,
  loadRuntimeTenants,
  normalizeTenantDraft,
  persistTenantForRuntime,
  registerTenant,
  removeOverlayTenant,
  toTenantSummary,
} from './tenantRegistry.js';
import type { TenantConfig } from './types.js';
import type { WeeklyScorecard } from '../src/prompts/b8-report.js';

const app = express();
app.use(express.json());
const store = new FileResultStore();
const PORT = process.env.PORT ?? 4000;

async function findTenant(tenantId: string): Promise<TenantConfig | undefined> {
  const tenants = await loadRuntimeTenants();
  return tenants.find((tenant) => tenant.tenantId === tenantId);
}

/**
 * 데모 데이터를 내려줄 때 응답에 표시한다. 화면(src/lib/dataSource.ts)이 이 헤더로 배너를 띄운다.
 *
 * 왜 필요한가. 아래 두 함수는 측정 전 주차를 조용히 데모로 바꿔 준다. 화면은 그걸 몰라서 데모
 * 숫자를 실제처럼 보여 줬고, 하루에 두 번 사람이 그걸 진짜로 읽었다. 오류가 아니라 "그럴듯한
 * 숫자"라서 더 위험하다. 데모 자체는 유지한다(빈 화면보다 낫다) — 대신 정직하게 표시한다.
 */
function markDemo(res: import('express').Response): void {
  res.setHeader('X-Data-Source', 'demo');
}

async function scorecardsFor(tenantId: string, res?: import('express').Response): Promise<WeeklyScorecard[]> {
  const history = await store.getScorecardHistory(tenantId, 12);
  if (history.length > 0) return history;
  if (res) markDemo(res);
  return demoScorecardHistory(tenantId);
}

/**
 * 파이프라인을 아직 돌리지 않은 주차는 파일 스토어가 비어 있다. 그럴 때만 데모 스토어로 넘겨서
 * 화면이 빈 상태로 남지 않게 한다 (배포 환경의 서버리스 함수와 같은 규칙). res를 주면 데모일 때
 * 헤더를 붙인다 — 모든 라우트가 넘기는 게 맞다.
 */
async function sourceFor(tenant: TenantConfig, weekOf: string, res?: import('express').Response) {
  const stored = await store.getQuestionAnalyses(tenant.tenantId, weekOf);
  if (stored.length > 0) return store;
  if (res) markDemo(res);
  return new DemoResultStore([tenant]);
}

// 앱(Electron)이 "이 포트의 서버가 정말 내 인프로세스 서버인가"를 확인하는 서명 엔드포인트.
// servesUi는 ELECTRON_STATIC_DIR이 설정돼 정적 UI를 서빙하는 서버에서만 true다 — 같은 포트를
// 다른 프로세스(개발용 dev 서버 등)가 점유하면 앱이 조용히 그쪽에 붙어 "Cannot GET /"가 뜬다.
app.get('/health', (_req, res) => {
  res.json({ ok: true, servesUi: Boolean(process.env.ELECTRON_STATIC_DIR), pid: process.pid });
});

// 로컬 백엔드 감지용. 배포(Vercel)는 api/health.ts가 같은 계약을 제공한다.
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    backend: 'express',
    canRegister: true,
    canMeasure: true,
    measureVia: 'local',
    servesUi: Boolean(process.env.ELECTRON_STATIC_DIR),
    // 엔진 선택 화면이 쓰는 값. 키는 존재 여부만 나간다 — 값은 절대 싣지 않는다.
    engineKeys: engineKeyStatus(),
    collectEngines: globalCollectEngines(),
  });
});

app.get('/api/tenants', async (req, res) => {
  const tenants = await loadRuntimeTenants();
  // 기본은 브랜드 드롭다운용(경쟁사 제외). ?all=1이면 측정 대상 선택용으로 전부 준다.
  const all = req.query.all === '1' || req.query.all === 'true';
  const picked = all ? tenants : tenants.filter((tenant) => !tenant.cohortOnly);
  res.json(picked.map((tenant) => ({ ...toTenantSummary(tenant), cohortOnly: Boolean(tenant.cohortOnly) })));
});

// 브랜드 삭제 — 오버레이·대기열에서 빼고, 로컬/패키징이면 툼스톤 + 남은 코호트 순위 재계산(deleteTenantLocally).
// 배포(Vercel)의 베이크된 브랜드는 GitHub Actions(delete-tenant.ts)로 커밋 데이터까지 지운다.
app.delete('/api/tenants', async (req, res) => {
  const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId.trim() : '';
  if (!tenantId) {
    res.status(400).json({ error: 'tenantId 쿼리가 필요합니다.' });
    return;
  }
  try {
    const { removed } = await removeOverlayTenant(tenantId);
    await removeMeasureRequest(tenantId);
    const baked = await isBakedTenant(tenantId);
    let dispatched = false;
    let htmlUrl: string | undefined;
    let locallyDeleted = false;
    if (!process.env.VERCEL) {
      // 로컬/패키징(Electron) — 베이크 여부와 관계없이 툼스톤으로 즉시 삭제(GitHub Actions 불필요).
      // 앱에서 등록한 브랜드도 측정 데이터가 남으므로 툼스톤이 없으면 코호트 순위에 계속 낀다.
      await deleteTenantLocally(tenantId, store);
      locallyDeleted = true;
    } else if (baked && canTriggerRemoteMeasure()) {
      try {
        // 배포(Vercel) — 커밋 데이터까지 지우려면 GitHub Actions. 큐에 누적하고 큐 모드로 트리거.
        await addDeleteRequest(tenantId);
        ({ htmlUrl } = await triggerGithubDelete(DELETE_QUEUE_SENTINEL));
        dispatched = true;
      } catch {
        dispatched = false;
      }
    }
    const stillBaked = baked && !locallyDeleted;
    res.json({ ok: true, tenantId, removedFromOverlay: removed, stillBaked, dispatched, htmlUrl, locallyDeleted });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 브랜드 현황 — 고객 브랜드마다 마지막 측정·코호트 순위·질문지 일치 상태(portfolio.ts). 읽기만 한다.
app.get('/api/portfolio', async (_req, res) => {
  try {
    res.json(await buildPortfolio(await loadRuntimeTenants(), store));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 측정 상태 — 앱이 직접 돌린 로컬 측정의 진행 중(measureAndBake가 브랜드마다 추적) + 완료 기록 + 최근 실패.
app.get('/api/measure-status', (_req, res) => {
  res.json({ active: listActiveMeasures(), completed: readLocalMeasures(), failed: listMeasureFailures() });
});

// "테넌트 골라 측정" — 지정 테넌트 하나(+본 브랜드면 경쟁사·코호트)를 측정하고 baking까지 한다 (로컬).
// 진행중/완료 추적·로깅은 measureAndBake 내부에서 브랜드마다 처리한다.
app.post('/api/tenants/:tenantId/measure', async (req, res) => {
  // 경쟁사 목록을 읽기 전부터 「측정 중」으로 센다 — 읽은 뒤 경쟁사 편집이 저장되면 측정은 옛 목록으로 돈다.
  beginMeasureRun();
  try {
    const tenant = await findTenant(req.params.tenantId);
    if (!tenant) {
      res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
      return;
    }
    // reuseCohort=true면 이번 주 카드가 이미 있는(같은 엔진으로 잰) 경쟁사는 다시 재지 않는다. selfOnly=true면 이 브랜드만 잰다.
    // 화면은 리포트(report.md)를 기다리지 않는다 — 점수 · 카드가 저장되면 끝낸다(measureAndBake backgroundReport).
    const body = (req.body ?? {}) as { reuseCohort?: unknown; selfOnly?: unknown };
    const result = await measureAndBake(tenant, store, {
      reuseCohort: body.reuseCohort === true,
      selfOnly: body.selfOnly === true,
      backgroundReport: true,
    });
    res.json(result);
  } catch (err) {
    // 사용자가 멈춘 측정은 실패가 아니다 — 화면이 "중단했습니다"로 알리게 409로 구분한다.
    if (err instanceof MeasureCancelledError) {
      res.status(409).json({ error: err.message, cancelled: true });
      return;
    }
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  } finally {
    endMeasureRun();
  }
});

// 측정 전 계획 — 「건너뛰기」 때 다시 잴 경쟁사와 까닭, 「이 브랜드만」 때 함께 순위를 매길 이번 주 경쟁사 카드의 도구(measurePreview).
// 읽기만 한다. Express 전용(웹은 GitHub 측정이라 쓰지 않는다).
app.get('/api/tenants/:tenantId/measure-preview', async (req, res) => {
  try {
    const tenant = await findTenant(req.params.tenantId);
    if (!tenant) {
      res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
      return;
    }
    res.json(await measurePreview(tenant, store));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 진행 중인 로컬 측정 중단 — 수집 단계까지인 브랜드는 곧 멈추고(이번 주 데이터를 쓰지 않는다),
// 이미 저장을 시작한 브랜드는 섞인 주차가 남지 않게 마무리한다(measureTracker.ts 참고).
app.post('/api/measure-cancel', (_req, res) => {
  res.json(requestCancelActiveMeasures());
});

// 브랜드 추가 — 온보딩 초안을 등록한다. 이미 있는 tenantId면 409와 함께 무엇과 부딪혔는지(conflict) 돌려준다 —
// 경쟁사로만 재던 같은 곳이면 화면이 「고객 브랜드로 전환」을 제안한다(tenantPromote.ts).
app.post('/api/tenants', async (req, res) => {
  let tenant: TenantConfig | null = null;
  try {
    tenant = normalizeTenantDraft(req.body);
    await registerTenant(tenant);
    res.status(201).json({ ok: true, tenantId: tenant.tenantId, brandName: tenant.brandName });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('필수 항목') ? 400 : message.includes('이미 존재') ? 409 : 500;
    let conflict = null;
    if (status === 409 && tenant) {
      try {
        conflict = await describeTenantConflict(tenant, store);
      } catch (inner) {
        console.error('[tenants] 부딪힌 브랜드를 가려내지 못했습니다:', inner);
      }
    }
    res.status(status).json({ error: message, ...(conflict ? { conflict } : {}) });
  }
});

// 경쟁사로만 재던 브랜드를 고객 브랜드로 전환 — id를 그대로 두어 지난 기록을 잇는다. 같은 홈페이지일 때만(tenantPromote.ts).
// 본문: { draft: 온보딩 초안, removeFrom: 이 브랜드를 경쟁사 목록에서 뺄 고객 브랜드 id[] }. Express 전용(데스크톱).
app.post('/api/tenants/:tenantId/promote', async (req, res) => {
  const body = (req.body ?? {}) as { draft?: unknown; removeFrom?: unknown };
  let draft: TenantConfig;
  try {
    draft = normalizeTenantDraft(body.draft);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (draft.tenantId !== req.params.tenantId) {
    res.status(400).json({ error: `초안의 tenantId(${draft.tenantId})가 주소(${req.params.tenantId})와 다릅니다.` });
    return;
  }
  const removeFrom = Array.isArray(body.removeFrom) ? body.removeFrom.filter((x): x is string => typeof x === 'string') : [];
  try {
    res.json(await promoteCompetitor(draft, removeFrom, store));
  } catch (err) {
    sendEditorError(res, err);
  }
});

// 같은 홈페이지를 다른 시장 범위로 하나 더 등록 — 부딪힌 고객 브랜드는 그대로 두고 id에 범위 꼬리를 붙인 새 브랜드를 만든다
// (tenantPromote.ts registerVariant, lib/brandVariant.ts). 본문: { draft: 온보딩 초안(부딪힌 id 그대로), copyBusinessFiles }. Express 전용.
app.post('/api/tenants/:tenantId/variant', async (req, res) => {
  const body = (req.body ?? {}) as { draft?: unknown; copyBusinessFiles?: unknown };
  let draft: TenantConfig;
  try {
    draft = normalizeTenantDraft(body.draft);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (draft.tenantId !== req.params.tenantId) {
    res.status(400).json({ error: `초안의 tenantId(${draft.tenantId})가 주소(${req.params.tenantId})와 다릅니다.` });
    return;
  }
  try {
    res.status(201).json(await registerVariant(draft, store, { copyBusinessFiles: body.copyBusinessFiles !== false }));
  } catch (err) {
    sendEditorError(res, err);
  }
});

// — 등록된 테넌트를 즉시 측정한다 (수 분 소요). /api 프리픽스라 vite 프록시로 전달된다.
app.post('/api/tenants/:tenantId/run', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  try {
    const result = await runWeeklyPipeline(tenant, store);
    res.json({ ok: true, tenantId: tenant.tenantId, aeoScore: result.scorecard.aeoScore.current });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/scorecards/:tenantId', async (req, res) => {
  res.json(await scorecardsFor(req.params.tenantId, res));
});

app.get('/scorecards/:tenantId', async (req, res) => {
  res.json(await scorecardsFor(req.params.tenantId, res));
});

// 브랜드 종합 진단 — 해당 주차의 문장 단위 판정 원본(언급/인용/순위/사실성)을 그대로 내려준다.
app.get('/api/question-analyses/:tenantId/:weekOf', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const source = await sourceFor(tenant, req.params.weekOf, res);
  res.json(await source.getQuestionAnalyses(tenant.tenantId, req.params.weekOf));
});

// 질문 프롬프트 빌더 — ?version 없이 호출하면 테넌트에 설정된 현재 버전을 반환한다.
app.get('/api/question-bank/:tenantId', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const requested = typeof req.query.version === 'string' ? req.query.version : null;
  const version = requested ?? tenant.questionBankVersion;
  const bank = await store.getQuestionBank(tenant.tenantId, version);
  const history = await scorecardsFor(tenant.tenantId);
  // 설정의 새 버전 은행은 다음 측정이 만든다. 그 전에는 마지막으로 잰 은행을 보여 주고 다음 버전을 알린다
  // — 예시 은행(12문항)으로 떨어지면 실제 질문 목록인 것처럼 보인다(v0.2.63에서 전 브랜드 v4 전환 직후).
  // 경쟁사 편집이 고쳐 만든 은행(derivedFrom)도 재기 전까지는 같다 — 지난 주 판정을 아직 묻지 않은 질문과 맞추지 않게.
  // 버전을 지정한 요청은 그 버전만 본다.
  if ((!bank || bank.derivedFrom) && !requested) {
    const measured = history.at(-1)?.questionBankVersion;
    const last = measured && measured !== version ? await store.getQuestionBank(tenant.tenantId, measured) : null;
    if (last) {
      // 마지막으로 잰 은행과 견줘 센다 — 재기 전에 두 번 고쳐 저장하면(v5 → v6 → v7) 마지막 단계만으로는 모자란다.
      // 고친 질문은 새 id를 달고(v7-004) 원래 질문 하나를 대신하므로, 남은 원래 질문 수에서 고친 수를 빼면 뺀 수다.
      const lastIds = new Set(last.questions.map((q) => q.questionId));
      const kept = bank ? bank.questions.filter((q) => lastIds.has(q.questionId)).length : 0;
      const replaced = bank ? bank.questions.length - kept : 0;
      // 「브랜드 질문 모두 새로 쓰기」로 올린 버전이면(경쟁사 편집, 아직 은행 없음) 새로 쓸 브랜드 질문 수를 알린다.
      const qb = !bank ? (await readCompetitorOverride(tenant.tenantId))?.current?.questionBank : undefined;
      const regenerate = qb?.regenerate && qb.version === version ? { brandCount: Math.max(0, qb.size - last.questions.filter((q) => q.cohortShared).length) } : null;
      res.json({
        ...last,
        upcomingVersion: version,
        ...(bank?.derivedFrom ? { upcomingDerived: { replaced, removed: Math.max(0, last.questions.length - kept - replaced) } } : {}),
        ...(regenerate ? { upcomingRegenerate: regenerate } : {}),
      });
      return;
    }
  }
  if (!bank) markDemo(res);
  // 측정 전 브랜드는 예시 은행을 준다 — demo를 실어, 화면이 그 판 번호를 「이 글이 겨냥한 질문의 판」으로 기록하지 않게 한다.
  res.json(bank ?? { ...demoQuestionBank(tenant, history.at(-1)?.weekOf ?? '2026-W36', requested ?? undefined), demo: true });
});

// URL 상세 분석 — 도메인×소유권 기준 인용 집계.
app.get('/api/citations/:tenantId/:weekOf', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const source = await sourceFor(tenant, req.params.weekOf, res);
  const engine = typeof req.query.engine === 'string' ? req.query.engine : null;
  res.json(await getCitationBreakdown(source, tenant.tenantId, req.params.weekOf, { engine }));
});

// EEAT 분석 — 답변에서 브랜드가 경험·전문성·권위·신뢰로 어떻게 그려지는지.
app.get('/api/eeat/:tenantId/:weekOf', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const source = await sourceFor(tenant, req.params.weekOf, res);
  res.json(await getEeatAnalysis(source, tenant.tenantId, req.params.weekOf));
});

// AI 인용출처 분석 — 출처 유형·엔진 치우침·합의 도메인.
app.get('/api/citation-sources/:tenantId/:weekOf', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const source = await sourceFor(tenant, req.params.weekOf, res);
  const engine = typeof req.query.engine === 'string' ? req.query.engine : null;
  const questions = req.query.questions === 'unnamed' || req.query.questions === 'named' ? req.query.questions : null;
  const competitorDomains = tenant.competitors.flatMap((c) => c.domains ?? []);
  res.json(
    await getCitationSourceAnalysis(source, tenant.tenantId, req.params.weekOf, {
      engine,
      competitorDomains,
      questions,
      currentBankVersion: tenant.questionBankVersion,
    }),
  );
});

// CI 측정 결과 동기화 — GitHub repo의 src/data(measure.yml이 굽는 곳)에서 로컬에 없는 (브랜드, 주차)만
// 채운다. 데스크톱 전용(웹은 번들이 곧 src/data다). 비공개 repo라 GH_MEASURE_TOKEN이 있어야 한다.
app.get('/api/ci-sync', (_req, res) => {
  res.json({ enabled: ciSyncEnabled(), repo: describeRepo() });
});

app.post('/api/ci-sync', async (_req, res) => {
  try {
    const tenants = await loadRuntimeTenants();
    res.json(await syncFromCi(store, tenants));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 질문 은행 구매 여정 단계 보정 — stage가 없는 옛 은행(v1·v2·초기 v3)에 한 번의 판정 호출로 매긴다.
// 이미 stage가 있는 문항은 건드리지 않는다. 데스크톱·로컬 전용.
app.post('/api/question-bank/:tenantId/tag-stages', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const version = typeof req.query.version === 'string' ? req.query.version : tenant.questionBankVersion;
  const bank = await store.getQuestionBank(tenant.tenantId, version);
  if (!bank) {
    res.status(404).json({ error: `question bank not found: ${tenant.tenantId}/${version}` });
    return;
  }
  try {
    const before = bank.questions.filter((q) => q.stage).length;
    const questions = await tagJourneyStages(bank.questions, getJudgeClient());
    const after = questions.filter((q) => q.stage).length;
    if (after > before) await store.saveQuestionBank(tenant.tenantId, { ...bank, questions });
    res.json({ tenantId: tenant.tenantId, version, total: questions.length, taggedBefore: before, taggedAfter: after });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 질문 은행 주제 배정 — 주제가 없는 문항에 한 번의 판정 호출로 콘텐츠 주제를 매긴다.
// 이미 있는 주제는 그대로 두고 재사용하게 한다(주차 간 비교). 데스크톱·로컬 전용.
app.post('/api/question-bank/:tenantId/tag-topics', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const version = typeof req.query.version === 'string' ? req.query.version : tenant.questionBankVersion;
  const bank = await store.getQuestionBank(tenant.tenantId, version);
  if (!bank) {
    res.status(404).json({ error: `question bank not found: ${tenant.tenantId}/${version}` });
    return;
  }
  try {
    // 상호가 주제 이름이 되지 않게 브랜드·별칭·경쟁사명을 판정기에 넘긴다(코드로도 막는다).
    const names = [
      tenant.brandName,
      ...(tenant.aliases ?? []),
      ...tenant.competitors.flatMap((c) => [c.name, ...(c.aliases ?? [])]),
    ].filter((n): n is string => Boolean(n));
    const before = bank.questions.filter((q) => q.topic).length;
    const { questions, brandTopicsDropped } = await tagQuestionTopics(
      bank.questions,
      getJudgeClient(),
      tenant.industry,
      names,
    );
    const after = questions.filter((q) => q.topic).length;
    // 상호 주제를 걷어냈으면 개수가 늘지 않아도 저장해야 한다(그 자체가 고침이다).
    if (after > before || brandTopicsDropped > 0) await store.saveQuestionBank(tenant.tenantId, { ...bank, questions });
    const topics = [...new Set(questions.map((q) => q.topic).filter(Boolean))];
    res.json({
      tenantId: tenant.tenantId,
      version,
      total: questions.length,
      taggedBefore: before,
      taggedAfter: after,
      brandTopicsDropped,
      topics,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 콘텐츠 브리프 — 실행 항목 하나를 "무엇을 써야 하나"로. 본문은 만들지 않는다(b9b-content-brief).
// 데스크톱·로컬 전용. GET은 저장된 브리프, POST는 생성(있으면 재사용, force=1이면 다시 만든다).
app.get('/api/content-brief/:tenantId', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  res.json(await readBriefs(tenant.tenantId));
});

app.post('/api/content-brief/:tenantId', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const actionId = typeof b.actionId === 'string' ? b.actionId : '';
  const kind = b.kind === 'listing' || b.kind === 'content' ? b.kind : null;
  if (!actionId || !kind || typeof b.title !== 'string') {
    res.status(400).json({ error: 'actionId, kind, title이 필요합니다.' });
    return;
  }
  const force = req.query.force === '1';
  try {
    if (!force) {
      const existing = (await readBriefs(tenant.tenantId))[actionId];
      if (existing) {
        res.json({ ...existing, reused: true });
        return;
      }
    }
    const stored = await generateBrief(
      tenant.tenantId,
      actionId,
      {
        brandName: tenant.brandName,
        industry: tenant.industry,
        region: tenant.region,
        competitorNames: tenant.competitors.map((c) => c.name),
        factGraph: tenant.factGraph ?? [],
        action: {
          kind,
          title: b.title,
          targetDomain: typeof b.targetDomain === 'string' ? b.targetDomain : undefined,
          questionTexts: Array.isArray(b.questionTexts)
            ? (b.questionTexts as unknown[]).filter((x): x is string => typeof x === 'string')
            : [],
          evidence: typeof b.evidence === 'string' ? b.evidence : '',
        },
        language: tenant.questionLanguage,
      },
      getWriterClient(),
      getJudgeClient(),
    );
    res.json({ ...stored, reused: false });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 브랜드 사실(팩트 그래프) — 데스크톱·로컬 전용. 파일이 있으면 베이스·오버레이보다 우선한다.
// 채널 다듬기 — 완성된 글을 올릴 채널 문체로(b9d-channel-adapt). 다듬은 글도 사실 대조를 거친다
// (channelAdapt.ts). 데스크톱·로컬 전용 — 웹에는 초안 기능이 없다.
app.get('/api/channel-adapt/:tenantId', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  res.json(await readAdaptations(tenant.tenantId));
});
app.post('/api/channel-adapt/:tenantId', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const contentActionId = str(b.contentActionId);
  const channelActionId = str(b.channelActionId);
  const channelDomain = str(b.channelDomain);
  const sourceMarkdown = typeof b.sourceMarkdown === 'string' ? b.sourceMarkdown : '';
  if (!contentActionId || !channelActionId || !channelDomain || !sourceMarkdown.trim()) {
    res.status(400).json({ error: 'contentActionId·channelActionId·channelDomain·sourceMarkdown이 필요합니다.' });
    return;
  }
  if (sourceMarkdown.length > 40000) {
    res.status(400).json({ error: '원문이 너무 깁니다(4만 자 초과).' });
    return;
  }
  try {
    res.json(
      await adaptForChannel(
        tenant.tenantId,
        { contentActionId, channelActionId },
        {
          brandName: tenant.brandName,
          channelDomain,
          style: channelStyleOf(str(b.channelBadge)),
          ...(b.format === 'article' ? { format: 'article' as const } : {}),
          sourceMarkdown,
          factGraph: tenant.factGraph ?? [],
          language: tenant.questionLanguage,
        },
        getWriterClient(),
        getJudgeClient(),
      ),
    );
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 빈칸 기록 저장(채운 값·뺌·찾아 둔 후보) — 판정 호출 없음. 초안을 다시 쓰지 않는다(contentDraft.ts gapFills).
app.put('/api/content-draft/:tenantId/gaps', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const actionId = typeof b.actionId === 'string' ? b.actionId : '';
  const fills = b.gapFills && typeof b.gapFills === 'object' ? (b.gapFills as Record<string, unknown>) : null;
  if (!actionId || !fills) {
    res.status(400).json({ error: 'actionId와 gapFills가 필요합니다.' });
    return;
  }
  try {
    res.json(await saveGapFills(tenant.tenantId, actionId, fills));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 글의 실측 사례(src/lib/answerEvidence.ts) — 저장된 측정 기록에서 코드가 고르고, 사람이 원문과 대조해 확인한다.
// 판정 · 글쓰기 호출이 없다. op: build(찾기) · confirm(원문과 맞음) · include · exclude(발행본에 넣기 켜고 끄기) · clear.
app.put('/api/content-draft/:tenantId/evidence', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const actionId = typeof b.actionId === 'string' ? b.actionId : '';
  const op = typeof b.op === 'string' ? b.op : '';
  if (!actionId || !['build', 'confirm', 'include', 'exclude', 'clear'].includes(op)) {
    res.status(400).json({ error: 'actionId와 op(build · confirm · include · exclude · clear)가 필요합니다.' });
    return;
  }
  try {
    if (op === 'build') {
      const questionIds = Array.isArray(b.questionIds)
        ? b.questionIds.filter((q): q is string => typeof q === 'string' && q.length <= 60).slice(0, 200)
        : [];
      const weekOf = typeof b.weekOf === 'string' && WEEK_OF.test(b.weekOf) ? b.weekOf : undefined;
      if (!questionIds.length) {
        res.status(400).json({ error: 'questionIds가 필요합니다.' });
        return;
      }
      const evidence = await buildArticleEvidence(store, tenant, questionIds, weekOf, await loadRuntimeTenants());
      // 새로 고르면 사람 확인은 다시 받는다. 넣기를 끈 선택은 지킨다.
      res.json(await saveEvidence(tenant.tenantId, actionId, (cur) => ({ ...evidence, include: cur ? cur.include : evidence.include })));
      return;
    }
    const now = new Date().toISOString();
    res.json(
      await saveEvidence(tenant.tenantId, actionId, (cur) => {
        if (op === 'clear') return undefined;
        if (!cur) throw new Error('먼저 실측 사례를 찾으세요.');
        if (op === 'confirm') {
          if (!cur.items.length) throw new Error('확인할 실측 사례가 없습니다.');
          return { ...cur, confirmedAt: now };
        }
        return { ...cur, include: op === 'include' };
      }),
    );
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 글 사진 자리에 고른 홈페이지 사진(src/lib/articlePhotos.ts) — op pick(넣기 · 옮기기) · remove(빼기). 판정 · 글쓰기 호출이 없고
// 페이지 · 사진을 다시 받지 않는다. 사진 사용 확인(photo-rights)이 없으면 409, 화면이 본 초안이 그사이 다시 만들어졌으면 409.
// 사이트가 단 사진 설명에 브랜드 사실에 없는 숫자가 있으면 설명을 비운다 — 내보낼 때 사실 확인을 거친 사진 자리 글자를 쓴다.
app.put('/api/content-draft/:tenantId/photos', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const actionId = typeof b.actionId === 'string' ? b.actionId : '';
  const generatedAt = typeof b.generatedAt === 'string' ? b.generatedAt : '';
  const op = b.op === 'pick' || b.op === 'remove' ? b.op : null;
  const text = (v: unknown, max: number) => (typeof v === 'string' ? normSlotAlt(v).slice(0, max) : '');
  const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 20 ? v : 0);
  // 사진 자리 하나 — 장면 글자 · 몇 번째 · 소제목. 빼기와 옮기기(replaces)가 이것으로 고른 사진을 찾는다.
  const placeOf = (v: unknown) => {
    const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    const place = { slot: text(r.slot, 300), nth: count(r.nth), heading: text(r.heading, 300) };
    return place.slot && place.nth ? place : null;
  };
  const samePlace = (p: PhotoPick, place: { slot: string; nth: number; heading: string }) =>
    p.slot === place.slot && p.nth === place.nth && p.heading === place.heading;
  if (!actionId || !generatedAt || !op) {
    res.status(400).json({ error: 'actionId · generatedAt · op(pick · remove)가 필요합니다.' });
    return;
  }
  try {
    if (op === 'remove') {
      const place = placeOf(b.place);
      if (!place) {
        res.status(400).json({ error: '뺄 사진 자리(place)가 필요합니다.' });
        return;
      }
      res.json(await savePhotoPicks(tenant.tenantId, actionId, generatedAt, (cur) => cur.filter((p) => !samePlace(p, place))));
      return;
    }
    const settings = await readPublishSettings(tenant.tenantId);
    if (!settings?.photoRights) {
      res.status(409).json({ error: '먼저 이 브랜드의 홈페이지 사진을 글에 써도 되는지 확인해 주세요.' });
      return;
    }
    if (isPhotoMedical(tenant.industry) && !settings.photoRights.medical) {
      res.status(409).json({ error: '의료 업종은 의료광고 확인까지 받아야 사진을 쓸 수 있어요.' });
      return;
    }
    const raw = (b.pick && typeof b.pick === 'object' ? b.pick : {}) as Record<string, unknown>;
    const place = placeOf(raw);
    const same = count(raw.same);
    const src = typeof raw.src === 'string' ? canonicalPhotoSrc(raw.src) : null;
    const pageUrl = typeof raw.pageUrl === 'string' && /^https?:\/\/\S+$/i.test(raw.pageUrl) && raw.pageUrl.length <= PHOTO_LIMITS.src ? raw.pageUrl : null;
    if (!place || !same || same < place.nth || !src || !pageUrl) {
      res.status(400).json({ error: '사진 자리(slot · nth · same · heading)와 https 사진 주소 · http(s) 페이지 주소가 필요합니다.' });
      return;
    }
    const siteAlt = cleanPhotoAlt(typeof raw.alt === 'string' ? raw.alt : '');
    const guard = createFactGuard(tenant.factGraph ?? [], [], 'drop');
    const alt = siteAlt && guard.guardSentence(siteAlt) ? siteAlt : '';
    const replaces = placeOf(b.replaces);
    const pick: PhotoPick = { ...place, same, src, alt, pageUrl, confirmedAt: new Date().toISOString() };
    const stored = await savePhotoPicks(tenant.tenantId, actionId, generatedAt, (cur) => {
      const rest = cur.filter((p) => !samePlace(p, place) && !(replaces && samePlace(p, replaces)));
      if (rest.length >= PHOTO_LIMITS.picks) {
        throw new RangeError(`사진은 글 하나에 ${PHOTO_LIMITS.picks}장까지예요 — 자리를 찾지 못한 사진을 먼저 빼 주세요.`);
      }
      return [...rest, pick];
    });
    res.json(siteAlt && !alt ? { ...stored, photoNote: '사이트의 사진 설명에 브랜드 사실에 없는 숫자가 있어, 사진 자리 글자를 설명으로 씁니다.' } : stored);
  } catch (err) {
    const status = err instanceof DraftChangedError ? 409 : err instanceof RangeError ? 400 : 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 「사진 N장 받기」 — 저장된 고른 사진 하나의 파일(server/sitePhoto.ts). 화면이 보낸 주소가 아니라 그 자리에 고른 사진만 받는다.
// 사진 사용 확인이 없거나(의료 업종은 의료광고 확인까지) 화면이 본 초안이 다시 만들어졌으면 409. Express 전용(Vercel 함수 12/12).
app.get('/api/content-draft/:tenantId/photo-file', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const q = req.query as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? normSlotAlt(v) : '');
  const actionId = typeof q.actionId === 'string' ? q.actionId : '';
  const generatedAt = typeof q.generatedAt === 'string' ? q.generatedAt : '';
  const nth = typeof q.nth === 'string' && /^[1-9]\d?$/.test(q.nth) ? Number(q.nth) : 0;
  const slot = str(q.slot);
  const heading = str(q.heading);
  if (!actionId || !generatedAt || !slot || !nth) {
    res.status(400).json({ error: 'actionId · generatedAt · slot · nth가 필요합니다.' });
    return;
  }
  const stored = (await readDrafts(tenant.tenantId))[actionId];
  if (!stored || stored.generatedAt !== generatedAt) {
    res.status(409).json({ error: '그사이 초안이 다시 만들어졌어요. 초안을 다시 불러온 뒤 받아 주세요.' });
    return;
  }
  const pick = stored.photos?.find((p) => p.slot === slot && p.nth === nth && p.heading === heading && p.confirmedAt);
  if (!pick) {
    res.status(404).json({ error: '그 자리에 고른 사진이 없어요.' });
    return;
  }
  if (!photosAllowed(await readPublishSettings(tenant.tenantId), tenant.industry)) {
    res.status(409).json({ error: '이 브랜드의 홈페이지 사진 사용 확인이 없어요.' });
    return;
  }
  try {
    const file = await fetchSitePhoto(pick.src);
    res.setHeader('Content-Type', file.type);
    res.setHeader('Content-Disposition', `attachment; filename="photo.${file.ext}"`);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.send(Buffer.from(file.bytes));
  } catch (err) {
    console.warn(`[photo-file] ${tenant.tenantId} ${pick.src} 받기 실패:`, err);
    res.status(502).json({ error: publicCollectorError(err).message });
  }
});

// 사람이 고친 초안 저장. 사실 가드를 돌려 경고만 남기고 저장은 막지 않는다 — 사람이 확인한
// 사실일 수 있다. 다만 우리가 판정 엔진에 요구하는 기준을 사람에게만 면제하지는 않는다.
app.put('/api/content-draft/:tenantId', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const actionId = typeof b.actionId === 'string' ? b.actionId : '';
  const markdown = typeof b.markdown === 'string' ? b.markdown : '';
  if (!actionId || !markdown.trim()) {
    res.status(400).json({ error: 'actionId와 markdown이 필요합니다.' });
    return;
  }
  const brief = (await readBriefs(tenant.tenantId))[actionId];
  try {
    const stored = await saveEditedDraft(
      tenant.tenantId,
      actionId,
      markdown,
      tenant.factGraph ?? [],
      brief?.brief.questionsToAnswer ?? [],
      getJudgeClient(),
    );
    res.json(stored);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 콘텐츠 초안 — 브리프에서 한 걸음. 팩트 그래프로 쓸 수 있는 문단만 채우고, 사실이 없는
// 자리는 문장을 지어내지 않고 gap으로 비운다(b9c-content-draft). 데스크톱·로컬 전용.
app.get('/api/content-draft/:tenantId', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  res.json(await readDrafts(tenant.tenantId));
});
app.post('/api/content-draft/:tenantId', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const actionId = typeof b.actionId === 'string' ? b.actionId : '';
  if (!actionId) {
    res.status(400).json({ error: 'actionId가 필요합니다.' });
    return;
  }
  // 초안은 브리프에서 한 걸음이다 — 브리프 없이 만들면 구조도 사실 목록도 없는 맨글이 된다.
  const brief = (await readBriefs(tenant.tenantId))[actionId];
  if (!brief) {
    res.status(409).json({ error: '이 항목의 브리프가 먼저 있어야 합니다. "브리프 만들기"를 실행하세요.' });
    return;
  }
  const force = req.query.force === '1';
  try {
    if (!force) {
      const existing = (await readDrafts(tenant.tenantId))[actionId];
      if (existing) {
        res.json({ ...existing, reused: true });
        return;
      }
    }
    const stored = await generateDraft(
      tenant.tenantId,
      actionId,
      {
        brandName: tenant.brandName,
        industry: tenant.industry,
        region: tenant.region,
        factGraph: tenant.factGraph ?? [],
        questionTexts: brief.brief.questionsToAnswer,
        brief: brief.brief,
        targetDomain: typeof b.targetDomain === 'string' ? b.targetDomain : undefined,
        language: tenant.questionLanguage,
        // 블로그 글 형식 — 영어 테넌트에는 프롬프트 · 정규화가 쓰지 않는다(articleFormatOf).
        format: b.format === 'article' ? 'article' : undefined,
      },
      getWriterClient(),
      getJudgeClient(),
    );
    res.json({ ...stored, reused: false });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/tenants/:tenantId/fact-graph', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const file = await readFactGraphFile(tenant.tenantId);
  res.json({ tenantId: tenant.tenantId, source: file ? 'file' : 'config', factGraph: file ?? tenant.factGraph ?? [] });
});

// 브랜드 페이지에서 팩트 그래프 후보를 뽑는다. **저장하지 않는다** — 사람이 골라 넣는다.
// 값이 페이지에 글자 그대로 없으면 버린다(factExtract 참고).
// 등록 **전** 브랜드에서 사실 후보를 뽑는다 — 온보딩용. 테넌트가 아직 없으므로 url·brandName을 직접 받는다.
// 저장하지 않는 것은 위와 같다. 온보딩 화면이 고른 것만 테넌트 초안의 factGraph에 담아 등록한다.
app.post('/api/fact-candidates', async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const url = typeof b.url === 'string' ? b.url.trim() : '';
  const brandName = typeof b.brandName === 'string' ? b.brandName.trim() : '';
  if (!url || !brandName) {
    res.status(400).json({ error: 'url과 brandName이 필요합니다.' });
    return;
  }
  const industry = typeof b.industry === 'string' ? b.industry.trim() : '';
  // 온보딩 화면은 사람이 친 값을 그대로 보낸다("example.com/a"). 스킴을 붙이고 http(s)인지 본다 —
  // 브랜드 페이지 저장과 같은 규칙(ftp://·javascript: 거절, 점 없는 호스트 거절).
  // **정규화 실패는 입력 잘못이므로 400이다.** try 안에 두면 서버 오류(500)로 나가 원인이 가려진다.
  let normalized: string | null;
  try {
    normalized = normalizeBrandPageUrl(url);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (!normalized) {
    res.status(400).json({ error: '읽을 주소가 없습니다.' });
    return;
  }
  try {
    res.json(await extractFactCandidates(normalized, brandName, industry, getJudgeClient()));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/tenants/:tenantId/fact-candidates', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const given = typeof body.url === 'string' ? body.url.trim() : '';
  // 등록된 브랜드 페이지 → 소유 도메인 루트 순. 루트는 회사 소개만 있거나(스테이,머뭄은 아예
  // 콘솔 껍데기) 사실이 없는 경우가 많아, 브랜드 페이지가 있으면 그쪽이 먼저다.
  const domain = (tenant.ownedDomains ?? [])[0] ?? '';
  const url = given || tenant.brandPageUrl || (domain ? `https://${domain.replace(/^https?:\/\//, '')}` : '');
  if (!url) {
    res.status(400).json({ error: '읽을 주소가 없습니다. 브랜드 페이지 주소를 등록하거나 url을 넘기세요.' });
    return;
  }
  try {
    const file = await readFactGraphFile(tenant.tenantId);
    const existing = file ?? tenant.factGraph ?? [];
    res.json(await extractFactCandidates(url, tenant.brandName, tenant.industry, getJudgeClient(), existing));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 초안의 빈칸 → 브랜드 페이지에서 그 값 찾기. 사실 추출과 같은 가드를 쓰고, 저장하지 않는다.
app.post('/api/tenants/:tenantId/fact-for-gaps', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const needs = Array.isArray(body.needs)
    ? body.needs.filter((n): n is string => typeof n === 'string' && n.trim().length > 0).map((n) => n.trim())
    : [];
  if (!needs.length) {
    res.status(400).json({ error: '찾을 항목(needs)이 비어 있습니다.' });
    return;
  }
  const given = typeof body.url === 'string' ? body.url.trim() : '';
  const domain = (tenant.ownedDomains ?? [])[0] ?? '';
  const url = given || tenant.brandPageUrl || (domain ? `https://${domain.replace(/^https?:\/\//, '')}` : '');
  if (!url) {
    res.status(400).json({ error: '읽을 주소가 없습니다. 브랜드 페이지 주소를 등록해 주세요.' });
    return;
  }
  try {
    const file = await readFactGraphFile(tenant.tenantId);
    const existing = file ?? tenant.factGraph ?? [];
    res.json(await findFactsForGaps(url, tenant.brandName, tenant.industry, needs, getJudgeClient(), existing));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.put('/api/tenants/:tenantId/brand-page', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  try {
    const url = normalizeBrandPageUrl((req.body as { url?: unknown } | undefined)?.url);
    await writeBrandPageUrl(tenant.tenantId, url);
    res.json({ ok: true, brandPageUrl: url ?? '' });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Site AEO Score의 주차별 기록. 진단 자체는 화면(브라우저)에서 채점하므로 여기서는 받아 적기만 한다.
app.get('/api/site-scores/:tenantId', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  res.json(await readSiteScores(tenant.tenantId));
});

app.put('/api/site-scores/:tenantId', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const body = (req.body ?? {}) as {
    score?: unknown;
    grade?: unknown;
    url?: unknown;
    pageTitle?: unknown;
    collectionMode?: unknown;
    categories?: unknown;
  };
  // 총점이 없는 진단(수집 실패 등)은 기록하지 않는다. 0점으로도, 중간값으로도 적지 않는다 —
  // 읽지 못한 주는 "그 주에 값이 없다"로 남아야 추이가 거짓말을 하지 않는다.
  if (typeof body.score !== 'number' || !Number.isFinite(body.score)) {
    res.status(400).json({ error: '총점이 없는 진단은 기록하지 않습니다.' });
    return;
  }
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!urlBelongsToTenant(url, tenant)) {
    res.status(400).json({ error: `${tenant.brandName}의 소유 주소가 아닙니다: ${url || '(빈 주소)'}` });
    return;
  }
  const categories = Array.isArray(body.categories)
    ? body.categories.map((c) => {
        const r = (c ?? {}) as Record<string, unknown>;
        return {
          id: String(r.id ?? ''),
          name: String(r.name ?? ''),
          score: typeof r.score === 'number' ? r.score : null,
          maxScore: typeof r.maxScore === 'number' ? r.maxScore : 0,
        };
      })
    : [];
  try {
    const saved = await writeSiteScore(tenant.tenantId, {
      score: body.score,
      grade: typeof body.grade === 'string' ? body.grade : null,
      url,
      pageTitle: typeof body.pageTitle === 'string' ? body.pageTitle : '',
      collectionMode: typeof body.collectionMode === 'string' ? body.collectionMode : 'static',
      categories,
    });
    res.json(saved);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 브랜드별 시장 범위(지역형 · 전국형 · B2B형) — data/<tenant>/market-scope.json(tenantScopeStore.ts).
// 질문지는 다음에 새로 만들 때부터 따른다. 이미 만든 질문지는 그대로라 측정 결과도 그대로다.
app.put('/api/tenants/:tenantId/market-scope', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  let scope;
  try {
    scope = normalizeTenantScope(req.body);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  try {
    await writeTenantScope(tenant.tenantId, scope);
    res.json({ tenantId: tenant.tenantId, ...scope });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 브랜드별 발행 설정(글 끝 상담 안내 · 문의 링크 · 태그 · 카테고리 · 블로그 주소) — data/<tenant>/publish-settings.json.
// Express 전용이다(Vercel 함수는 12/12). 웹은 콘텐츠 생성이 없어 이 설정도 쓰지 않는다.
app.get('/api/tenants/:tenantId/publish-settings', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  try {
    res.json((await readPublishSettings(tenant.tenantId)) ?? {});
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.put('/api/tenants/:tenantId/publish-settings', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  let settings;
  try {
    settings = normalizePublishSettings(req.body);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  // 사진 사용 확인은 이 화면이 보내지 않는다(서버만 찍는다) — 보낸 값은 버리고 저장된 값을 이어받는다.
  delete settings.photoRights;
  try {
    res.json(await updatePublishSettings(tenant.tenantId, (cur) => ({ ...settings, ...(cur?.photoRights ? { photoRights: cur.photoRights } : {}) })));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 홈페이지 사진을 글에 써도 된다는 확인(브랜드별 한 번, src/lib/articlePhotos.ts) — 확인 시각은 서버가 찍는다. 의료 업종은
// 의료광고(환자 · 시술 전후 사진) 확인(medical)까지 받아야 한다. Express 전용이다(Vercel 함수 12/12 — 웹은 사진을 고르지 않는다).
app.put('/api/tenants/:tenantId/photo-rights', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const medical = (req.body as { medical?: unknown } | undefined)?.medical === true;
  if (isPhotoMedical(tenant.industry) && !medical) {
    res.status(400).json({ error: '의료 업종은 환자 · 시술 전후 사진이 아닌지 확인(의료광고)까지 받아야 사진을 쓸 수 있어요.' });
    return;
  }
  try {
    const confirmedAt = new Date().toISOString();
    res.json(await updatePublishSettings(tenant.tenantId, (cur) => ({ ...cur, photoRights: { confirmedAt, ...(medical ? { medical: true as const } : {}) } })));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 경쟁사 편집 서랍의 처음 상태 — 함께 측정·대기, 경쟁사별 최근 점수·비교 질문, 예전 경쟁사(competitorEditor.ts).
// 읽기만 한다. Express 전용이다(Vercel 함수는 12/12이고, 웹은 이 서랍을 띄우지 않는다).
app.get('/api/tenants/:tenantId/competitors', async (req, res) => {
  try {
    const runtime = await loadRuntimeTenants();
    const tenant = runtime.find((t) => t.tenantId === req.params.tenantId);
    if (!tenant || tenant.cohortOnly) {
      res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
      return;
    }
    res.json(await buildEditorState(tenant, runtime, store));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

function sendEditorError(res: import('express').Response, err: unknown): void {
  const status = err instanceof EditorError ? err.status : 500;
  res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
}

// 바꾼 경쟁사 목록 미리 계산 — 함께 측정·대기, 빠지는 경쟁사의 질문을 누가 넘겨받는지(handoff: 바꿈 · 측정에 넣기 힌트),
// 저장을 막는 문제, 「지난 기록에서도 빼기」의 주차별 순위(pastOut). 쓰지 않는다.
app.post('/api/tenants/:tenantId/competitors/plan', async (req, res) => {
  try {
    const runtime = await loadRuntimeTenants();
    const tenant = runtime.find((t) => t.tenantId === req.params.tenantId);
    if (!tenant || tenant.cohortOnly) {
      res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
      return;
    }
    const body = (req.body ?? {}) as { competitors?: unknown; pastOut?: unknown; handoff?: unknown };
    res.json(await planEdit(tenant, runtime, store, body.competitors, body.pastOut, body.handoff));
  } catch (err) {
    sendEditorError(res, err);
  }
});

// 경쟁사 「업종 다름」 확인 — 경쟁사를 추가하거나 새 이름으로 바꿀 때 서랍이 부른다(검색이 붙은 Gemini 1회, 이미 본 이름이면 다시
// 묻지 않음). 확인하지 못하면 verdict null · error로 답한다(칩 없음). Express 전용이다(Vercel 리전에서는 한국 지역 업체 판단이 틀린다).
app.post('/api/tenants/:tenantId/competitors/industry', async (req, res) => {
  try {
    res.json(await checkEditorIndustry(req.params.tenantId, req.body, () => getCheckEngineClient('gemini')));
  } catch (err) {
    sendEditorError(res, err);
  }
});

// 사람이 정한 업종(「펜션 맞음」 · 「업종 다름으로 표시」 · 표시 지우기) — 바로 쓴다(목록 저장과 따로).
app.post('/api/tenants/:tenantId/competitors/industry/mark', async (req, res) => {
  try {
    res.json(await markEditorIndustry(req.params.tenantId, req.body));
  } catch (err) {
    sendEditorError(res, err);
  }
});

// 넘겨받은 비교 질문 고쳐 쓰기(미리보기) — 판정 엔진을 부른다. 쓰지 않는다(저장은 PUT이 이 문장을 받아 다시 검사한다).
// 계획(key)이 미리 본 것과 다르거나 측정 중이면 409, 판정 엔진 키가 없으면 503.
app.post('/api/tenants/:tenantId/competitors/questions', async (req, res) => {
  try {
    const ctx = await questionRewriteContext(req.params.tenantId, store, req.body);
    let judge;
    try {
      judge = getJudgeClient();
    } catch (err) {
      throw new EditorError(503, `판정 엔진 키가 없어요 — ${err instanceof Error ? err.message : String(err)}`);
    }
    const fresh = (req.body as { fresh?: unknown } | undefined)?.fresh === true;
    res.json({ ...(await draftCompetitorRewrites(ctx, judge, { fresh })), engine: usedJudgeEngineId() });
  } catch (err) {
    sendEditorError(res, err);
  }
});

// 저장 — data/<tenant>/competitors.json(tenantCompetitorsStore.ts). 다음 측정부터 이 목록으로 잰다. 측정 중이면 409.
app.put('/api/tenants/:tenantId/competitors', async (req, res) => {
  try {
    res.json(await saveEdit(req.params.tenantId, store, req.body));
  } catch (err) {
    sendEditorError(res, err);
  }
});

// 마지막 저장 되돌리기 — 그 뒤 이 브랜드를 쟀으면 409.
app.post('/api/tenants/:tenantId/competitors/undo', async (req, res) => {
  try {
    res.json(await undoEdit(req.params.tenantId, store));
  } catch (err) {
    sendEditorError(res, err);
  }
});

// 앱에서 고친 목록을 버리고 저장소 설정을 따른다(되돌릴 수 있다).
app.delete('/api/tenants/:tenantId/competitors', async (req, res) => {
  try {
    res.json(await resetEdit(req.params.tenantId, store));
  } catch (err) {
    sendEditorError(res, err);
  }
});

// 기본 정보(업종 · 지역 · 시장 범위) 서랍 — 처음 상태 · 미리 계산 · 저장(brandProfileEditor.ts). 앱에서 등록한 브랜드만 고친다.
// Express 전용이다(Vercel 함수는 12/12이고, 웹은 브랜드 현황 화면을 띄우지 않는다).
app.get('/api/tenants/:tenantId/profile', async (req, res) => {
  try {
    res.json(await describeProfileEditor(req.params.tenantId));
  } catch (err) {
    sendEditorError(res, err);
  }
});

app.post('/api/tenants/:tenantId/profile/plan', async (req, res) => {
  try {
    res.json(await planProfileEdit(req.params.tenantId, req.body, store));
  } catch (err) {
    sendEditorError(res, err);
  }
});

// 저장 — 미리보기와 같은 계획(previewKey)일 때만. 측정 중이면 409.
app.put('/api/tenants/:tenantId/profile', async (req, res) => {
  try {
    const body = (req.body ?? {}) as { input?: unknown; previewKey?: unknown };
    res.json(await saveProfileEdit(req.params.tenantId, body.input, body.previewKey, store));
  } catch (err) {
    sendEditorError(res, err);
  }
});

// 브랜드별 수집 엔진. 전역 지정(COLLECT_ENGINES)이 있으면 그쪽이 이긴다 —
// 여기 저장한 값은 "전역 지정을 안 쓸 때" 쓰인다(resolveCollectionEngines 한 곳에서 판단).
app.put('/api/tenants/:tenantId/engines', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  // 정규화를 try 밖에서 한다 — 입력 잘못은 400이지 500이 아니다.
  let engines;
  try {
    engines = normalizeEngineList((req.body as { engines?: unknown } | undefined)?.engines);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  try {
    await writeTenantEngines(tenant.tenantId, engines);
    res.json({ tenantId: tenant.tenantId, engines });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.put('/api/tenants/:tenantId/fact-graph', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { nodes, dropped } = normalizeFactGraph(body.factGraph);
  try {
    await writeFactGraphFile(tenant.tenantId, nodes);
    res.json({ tenantId: tenant.tenantId, source: 'file', factGraph: nodes, dropped });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 실행 항목의 집행 상태 — 데스크톱·로컬 전용(Vercel 함수를 새로 만들지 않는다).
// 여기 저장하는 건 '집행함'이지 '충족'이 아니다. 충족은 인용 데이터에서 매번 계산한다.
app.get('/api/action-states/:tenantId', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  // 쓰기 줄에 세워 읽는다 — 윈도우에서 읽는 중인 파일 위로 쓰기(rename)가 실패하지 않게(server/tenantWriteQueue.ts).
  res.json(await queueTenantWrite(tenant.tenantId, () => readActionStates(tenant.tenantId)));
});

app.put('/api/action-states/:tenantId', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const { actionId, status, markedWeek, note, publishedUrls } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof actionId !== 'string' || actionId.length === 0) {
    res.status(400).json({ error: 'actionId가 필요합니다.' });
    return;
  }
  if (!isActionStatus(status)) {
    res.status(400).json({ error: `status가 올바르지 않습니다: ${String(status)}` });
    return;
  }
  const next = await writeActionState(tenant.tenantId, actionId, {
    status,
    markedWeek: typeof markedWeek === 'string' ? markedWeek : undefined,
    note: typeof note === 'string' ? note : undefined,
    // 키가 아예 없으면 건드리지 않는다(상태만 바꾸는 호출). 있으면 그 목록으로 갈아끼운다.
    publishedUrls: publishedUrls === undefined ? undefined : sanitizeUrls(publishedUrls),
  });
  res.json(next);
});

// 집행 원장 — 올린 글 주소를 주소 한 줄 = 기록 한 줄로 남긴다(server/publishedPosts.ts). 데스크톱·로컬 전용.
// 오류는 이유와 함께 돌려준다(409: 다른 글에 적힌 주소, 400: 첫 화면·단축 주소 등, 500: 파일이 깨짐 — 쓰지 않는다).
function sendPostsError(res: import('express').Response, err: unknown) {
  const status = err instanceof PublishedPostsError ? err.status : 500;
  res.status(status).json({ error: err instanceof Error ? err.message : String(err), ...(err instanceof PublishedPostsError ? err.detail : {}) });
}

app.get('/api/published-posts/:tenantId', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  try {
    res.json({ posts: await readPublishedPosts(tenant.tenantId) });
  } catch (err) {
    sendPostsError(res, err);
  }
});

app.post('/api/published-posts/:tenantId', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  try {
    res.json(await addPublishedPost(tenant.tenantId, (req.body ?? {}) as AddPostInput));
  } catch (err) {
    sendPostsError(res, err);
  }
});

// 올린 글 인용 이력 — 주소 × 측정 주차(server/publishedHistory.ts). 저장하지 않고 요청마다 계산한다. 데모로 대신하지 않는다.
app.get('/api/published-history/:tenantId', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const weeks = Number(req.query.weeks);
  try {
    const posts = await readPublishedPosts(tenant.tenantId);
    res.json(await getPublishedHistory(store, tenant, posts, Number.isFinite(weeks) && weeks > 0 ? weeks : 12));
  } catch (err) {
    sendPostsError(res, err);
  }
});

// 측정 회차별 보기(server/runHistory.ts) — 같은 주에 여러 번 잰 회차와 올린 글의 회차별 인용. Express 전용(웹은 404 → 화면이 숨긴다).
app.get('/api/run-history/:tenantId', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const weeks = Number(req.query.weeks);
  try {
    const posts = await readPublishedPosts(tenant.tenantId);
    res.json(await getRunHistory(store, tenant, posts, Number.isFinite(weeks) && weeks > 0 ? Math.min(weeks, MAX_RUN_WEEKS) : 6));
  } catch (err) {
    sendPostsError(res, err);
  }
});

app.patch('/api/published-posts/:tenantId/:postId', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  try {
    res.json(await patchPublishedPost(tenant.tenantId, req.params.postId, (req.body ?? {}) as PatchPostInput));
  } catch (err) {
    sendPostsError(res, err);
  }
});

// 랭킹 분석 — 업종·지역 코호트 순위 + 경쟁사 언급 점유율.
// AI 리퍼럴 트래픽(GA4) — 로컬/데스크톱 전용. Vercel은 Hobby 함수 한도(12개) 여유가 1개뿐이라
// 별도 서버리스 함수를 만들지 않았다(웹에서도 필요해지면 api/ga-referrals.ts로 승격).
app.get('/api/ga-referrals/:tenantId', async (req, res) => {
  try {
    const tenants = await loadRuntimeTenants();
    const tenant = tenants.find((t) => t.tenantId === req.params.tenantId);
    if (!tenant) {
      res.status(404).json({ error: '테넌트를 찾을 수 없습니다.' });
      return;
    }
    const daysRaw = Number(req.query.days);
    const days = Number.isFinite(daysRaw) && daysRaw >= 1 && daysRaw <= 365 ? Math.floor(daysRaw) : 28;
    res.json(await fetchAiReferrals(tenant, days));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 답변에 함께 나온 브랜드 — 코호트에 없는 곳을 사람이 발견하도록 후보를 준다(판정이 아니다).
app.get('/api/discovered-brands/:tenantId/:weekOf', async (req, res) => {
  const tenants = await loadRuntimeTenants();
  const tenant = tenants.find((t) => t.tenantId === req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const known = tenants.map((t) => ({ name: t.brandName, aliases: t.aliases ?? [] }));
  res.json(
    await discoverBrands(
      tenant.tenantId,
      req.params.weekOf,
      { brandName: tenant.brandName, aliases: tenant.aliases ?? [], industry: tenant.industry },
      known,
    ),
  );
});

// AI 답변 원문 — 질문 하나의 엔진별 응답. 한 주차 전체는 크므로 질문 단위로만 내려준다.
app.get('/api/raw-answers/:tenantId/:weekOf', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const questionId = typeof req.query.questionId === 'string' ? req.query.questionId : '';
  if (!questionId) {
    res.status(400).json({ error: 'questionId 쿼리가 필요합니다.' });
    return;
  }
  res.json(await getRawAnswers(tenant.tenantId, req.params.weekOf, questionId));
});

// 엔진 단가 — 코드에 박지 않고 파일에 둔다(pricingStore.ts). 기본값 없음 = 미설정.
app.get('/api/engine-pricing', async (_req, res) => {
  // 지금 실제로 호출하는 모델을 함께 준다 — 단가가 어느 모델 기준인지 사람이 맞출 수 있어야 한다.
  res.json({ ...(await readPricing()), currentModels: configuredModels() });
});

app.put('/api/engine-pricing', async (req, res) => {
  try {
    // GET과 같은 모양으로 돌려준다 — 화면이 응답을 그대로 상태에 넣으므로, 여기서 빠뜨리면
    // 저장 직후 모델 안내가 사라진다(GET에서 다시 받기 전까지).
    res.json({ ...(await writePricing(req.body)), currentModels: configuredModels() });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 엔진 사용량 — 호출·토큰·시간. 전체 브랜드 합산이다(API 키를 같이 쓰므로).
app.get('/api/usage', async (req, res) => {
  const weeks = Number(req.query.weeks);
  res.json(await getUsageStats(Number.isFinite(weeks) && weeks > 0 ? weeks : 4));
});

// 엔진별 언급률 추이 — 엔진별 종합 점수는 재정규화 분모가 달라 비교가 안 된다(engineTrend.ts).
app.get('/api/engine-trend/:tenantId', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const weeks = Number(req.query.weeks);
  res.json(await getEngineTrend(store, tenant, Number.isFinite(weeks) && weeks > 0 ? Math.min(weeks, 52) : 12));
});

// 주차별 코호트 평균 — 추이 그래프의 비교선. 자사는 평균에서 빠진다(cohortTrend.ts).
app.get('/api/cohort-trend/:tenantId', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const weeks = Number(req.query.weeks);
  res.json(await getCohortTrend(store, tenant, Number.isFinite(weeks) && weeks > 0 ? Math.min(weeks, 52) : 12));
});

app.get('/api/ranking/:tenantId/:weekOf', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const source = await sourceFor(tenant, req.params.weekOf, res);
  res.json(await getRankingView(source, tenant, req.params.weekOf));
});

// 사이트 종합 진단 — 단일 URL의 공개 HTML을 수집한다 (SSRF 가드, 정적 수집).
app.get('/api/fetch', async (req, res) => {
  const target = typeof req.query.url === 'string' ? req.query.url : '';
  if (!target) {
    res.status(400).json({ error: 'url 쿼리가 필요합니다.' });
    return;
  }
  res.set('Cache-Control', 'no-store');
  res.json(await collectPage(target));
});

// 브랜드 추가 — Gemini 추론. ?kind=brand(업종·지역·주소) | competitors(경쟁사).
// 배포와 동일하게 한 라우트로 합친다(Vercel Hobby 함수 개수 제한 대응).
app.post('/api/infer', async (req, res) => {
  const kind = typeof req.query.kind === 'string' ? req.query.kind : '';
  try {
    if (kind === 'competitors') {
      const brandName = typeof req.body?.brandName === 'string' ? req.body.brandName : '';
      const industry = typeof req.body?.industry === 'string' ? req.body.industry : '';
      const region = typeof req.body?.region === 'string' ? req.body.region : '';
      if (!brandName.trim() || !industry.trim()) {
        res.status(400).json({ error: 'brandName, industry가 필요합니다.' });
        return;
      }
      const scopeRaw = typeof req.body?.marketScope === 'string' ? req.body.marketScope : '';
      const marketScope: MarketScope = (MARKET_SCOPES as string[]).includes(scopeRaw) ? (scopeRaw as MarketScope) : 'local';
      const buyer = typeof req.body?.buyer === 'string' ? req.body.buyer : '';
      res.json(await inferCompetitors(brandName, industry, region, marketScope, buyer));
      return;
    }
    if (kind === 'scope') {
      // 시장 범위(지역형 · 전국형 · B2B형) + B2B 구매자. 배포 api/infer.ts와 같은 계약.
      const brandName = typeof req.body?.brandName === 'string' ? req.body.brandName : '';
      const industry = typeof req.body?.industry === 'string' ? req.body.industry : '';
      if (!brandName.trim() || !industry.trim()) {
        res.status(400).json({ error: 'brandName, industry가 필요합니다.' });
        return;
      }
      const text = typeof req.body?.text === 'string' ? req.body.text : '';
      res.json(await inferMarketScope(brandName, industry, text));
      return;
    }
    if (kind === 'address') {
      const brandName = typeof req.body?.brandName === 'string' ? req.body.brandName : '';
      const region = typeof req.body?.region === 'string' ? req.body.region : '';
      if (!brandName.trim()) {
        res.status(400).json({ error: 'brandName이 필요합니다.' });
        return;
      }
      res.json({ address: await inferAddressViaSearch(brandName, region) });
      return;
    }
    if (kind === 'domain') {
      // 도메인만으로 브랜드명·업종·지역·주소 추론(그라운딩). 배포 api/infer.ts와 동일 계약.
      const domain = typeof req.body?.domain === 'string' ? req.body.domain : '';
      if (!domain.trim()) {
        res.status(400).json({ error: 'domain이 필요합니다.' });
        return;
      }
      res.json(await inferBrandFromDomain(domain));
      return;
    }
    if (kind === 'aliases') {
      // 상호의 표기 변형. 언급 판정이 이 목록을 그대로 쓰므로, 여기가 비면 한국어 답변의
      // 다른 표기를 통째로 놓친다(실측: 가온그룹이 "KAONGROUP.COM"이라 3/72였다).
      const brandName = typeof req.body?.brandName === 'string' ? req.body.brandName : '';
      if (!brandName.trim()) {
        res.status(400).json({ error: 'brandName이 필요합니다.' });
        return;
      }
      const industry = typeof req.body?.industry === 'string' ? req.body.industry : '';
      const region = typeof req.body?.region === 'string' ? req.body.region : '';
      const domain = typeof req.body?.domain === 'string' ? req.body.domain : '';
      res.json({ aliases: await inferAliases(brandName, industry, region, domain) });
      return;
    }
    if (kind === 'identify') {
      // 상호(브랜드명)만으로 도메인·업종·지역·주소 역추론. 배포 api/infer.ts와 동일 계약.
      const brandName = typeof req.body?.brandName === 'string' ? req.body.brandName : '';
      const region = typeof req.body?.region === 'string' ? req.body.region : '';
      if (!brandName.trim()) {
        res.status(400).json({ error: 'brandName이 필요합니다.' });
        return;
      }
      res.json(await inferBrandFromName(brandName, region));
      return;
    }
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    const brandName = typeof req.body?.brandName === 'string' ? req.body.brandName : '';
    if (!text.trim()) {
      res.status(400).json({ error: 'text가 필요합니다.' });
      return;
    }
    res.json(await inferBrandFields(text, brandName));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 측정 요청 대기열. 로컬 백엔드엔 Blob 토큰이 없으므로, 배포(Blob)의 큐를 프록시로 읽어
// 로컬 대기열 처리가 실제 대기열을 보게 한다.
const MEASURE_API_BASE = process.env.MEASURE_API_BASE ?? 'https://brand-aeo-app.vercel.app';

async function fetchQueue(): Promise<import('./measureRequests.js').MeasureRequest[]> {
  if (blobStoreEnabled()) return readMeasureRequests();
  const r = await fetch(`${MEASURE_API_BASE}/api/measure-requests`);
  return r.ok ? ((await r.json()) as import('./measureRequests.js').MeasureRequest[]) : [];
}

async function clearQueue(tenantId: string): Promise<void> {
  if (blobStoreEnabled()) {
    await removeMeasureRequest(tenantId);
    return;
  }
  await fetch(`${MEASURE_API_BASE}/api/measure-requests?tenantId=${encodeURIComponent(tenantId)}`, {
    method: 'DELETE',
  });
}

app.get('/api/measure-requests', async (req, res) => {
  try {
    if (req.query.view === 'runs') {
      res.json(await listMeasureRuns());
      return;
    }
    res.json(await fetchQueue());
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// "측정 실행" — 대기열의 브랜드를 config 등록 + 측정 + publish + 대기열 정리까지 처리한다(로컬 전용).
app.post('/api/measure-requests/process', async (_req, res) => {
  try {
    const pending = await fetchQueue();
    const results: { tenantId: string; brandName: string; aeoScore?: number; ok: boolean; error?: string }[] = [];
    for (const item of pending) {
      try {
        // 큐에 저장된 시점의 정규화가 오래됐을 수 있으니 측정 직전 한 번 더 정규화한다.
        const t = normalizeTenantDraft(item.tenant);
        await persistTenantForRuntime(t);
        const { scorecard } = await runWeeklyPipeline(t, store);
        // dev 체크아웃에서만 src/data baking(웹 배포용). 패키징 설치본은 store가 곧 데이터.
        if (!packagedDataMode()) execSync(`npx tsx scripts/publish-tenant.ts ${t.tenantId}`, { stdio: 'inherit' });
        await clearQueue(t.tenantId);
        results.push({ tenantId: t.tenantId, brandName: t.brandName, aeoScore: scorecard.aeoScore.current, ok: true });
      } catch (err) {
        results.push({
          tenantId: item.tenant?.tenantId ?? '(unknown)',
          brandName: item.tenant?.brandName ?? '(unknown)',
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    res.json({ processed: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
app.post('/api/measure-requests', async (req, res) => {
  try {
    const body = (req.body ?? {}) as { action?: string; runId?: number };
    if (body.action === 'cancel') {
      const runId = Number(body.runId);
      if (!runId) {
        res.status(400).json({ error: 'runId가 필요합니다.' });
        return;
      }
      await cancelMeasureRun(runId);
      res.status(202).json({ ok: true, cancelled: runId });
      return;
    }
    const tenant = normalizeTenantDraft(req.body);
    const list = await addMeasureRequest(tenant);
    res.status(201).json({ ok: true, pending: list.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(message.includes('필수 항목') ? 400 : 500).json({ error: message });
  }
});
app.delete('/api/measure-requests', async (req, res) => {
  const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : '';
  if (!tenantId.trim()) {
    res.status(400).json({ error: 'tenantId 쿼리가 필요합니다.' });
    return;
  }
  const list = await removeMeasureRequest(tenantId);
  res.json({ ok: true, pending: list.length });
});

app.post('/pipeline/run/:tenantId', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  try {
    const result = await runWeeklyPipeline(tenant, store);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Electron 패키징 모드: vite 없이 빌드된 정적 UI(dist)를 같은 오리진에서 서빙한다.
// 웹(Vercel)·dev에서는 ELECTRON_STATIC_DIR 미설정이라 아래 블록은 실행되지 않는다(공유 코드 안전).
const STATIC_DIR = process.env.ELECTRON_STATIC_DIR;
if (STATIC_DIR) {
  const staticRoot = path.resolve(STATIC_DIR); // sendFile은 절대경로 필요
  app.use(express.static(staticRoot));
  // SPA 폴백 — API/데이터 라우트가 아닌 GET은 index.html로 넘겨 클라이언트 라우팅이 처리하게 한다.
  const NON_SPA = ['/api', '/scorecards', '/pipeline', '/health'];
  app.use((req, res, next) => {
    if (req.method !== 'GET' || NON_SPA.some((p) => req.path === p || req.path.startsWith(p + '/'))) {
      return next();
    }
    res.sendFile(path.join(staticRoot, 'index.html'));
  });
}

// 이 PC 안(루프백)에서만 받는다 — 인증이 없는 서버라 모든 인터페이스에서 받으면 같은 와이파이의 다른 기기가 브랜드 데이터 ·
// 측정 실행 · 페이지 수집 프록시(/api/fetch)에 닿는다. 앱 창 · 개발용 프록시 · 스크립트는 모두 localhost로 부른다. localhost가
// IPv6(::1)로 먼저 풀리는 환경(윈도우)이 있어 ::1에도 연다(IPv6가 꺼진 PC면 건너뛴다). 다른 기기에서 일부러 열어야 하면
// AEO_SERVER_HOST로 바꾼다(예: AEO_SERVER_HOST=0.0.0.0). 흔한 이름인 HOST는 읽지 않는다 — PC 전체에 HOST가 설정돼 있으면(다른
// 개발 도구용) 앱이 그 주소로 열려 창이 서버에 닿지 못한다. 검증: scripts/verify-server-bind.ts
const HOSTS = process.env.AEO_SERVER_HOST?.trim() ? [process.env.AEO_SERVER_HOST.trim()] : ['127.0.0.1', '::1'];

/** 그 주소 · 포트에 이미 받는 소켓이 있는가 — 연결해 본다(electron/main.cjs isPortOccupied와 같은 방식). */
function portAnswers(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = netConnect({ host, port });
    const done = (answered: boolean) => {
      sock.destroy();
      resolve(answered);
    };
    sock.setTimeout(1000);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false)); // ECONNREFUSED = 비어 있음 · IPv6가 꺼진 PC의 ::1
  });
}

/**
 * 연다. 윈도우는 다른 프로세스가 모든 인터페이스(0.0.0.0 · ::)에 연 포트에도 특정 주소(127.0.0.1)로 또 열게 해 주고, 그러면 루프백
 * 접속을 이쪽이 조용히 가로챈다(예전 설치본이 4000을 잡고 있을 때 개발 서버를 띄우면 앱 창의 요청이 개발 서버로 간다). 그래서 열기
 * 전에 그 포트에 이미 받는 곳이 있으면 멈춘다. 첫 주소를 열지 못해도 멈춘다 — 「listening」이라 적고 아무것도 받지 않는 서버가
 * 남지 않게. 둘째 주소(::1)는 첫 주소를 연 뒤에만 연다.
 */
async function startListening(): Promise<void> {
  const port = Number(PORT);
  const probe = HOSTS.flatMap((h) => (h === '0.0.0.0' ? ['127.0.0.1'] : h === '::' ? ['::1', '127.0.0.1'] : [h]));
  for (const host of new Set(HOSTS.length > 1 ? [...probe, '127.0.0.1', '::1'] : probe)) {
    if (await portAnswers(host, port)) {
      console.error(`[server] ${host}:${port}에 이미 다른 프로그램이 받고 있어 열지 않습니다 — 그 프로그램(데스크톱 앱 등)을 끄거나 PORT를 바꾸세요.`);
      process.exit(1);
    }
  }
  app.listen(port, HOSTS[0]!, (err?: Error) => {
    if (err) {
      console.error(`[server] ${HOSTS[0]}:${port}에 열지 못했습니다`, err);
      process.exit(1);
    }
    seedFirstRunIfEmpty(); // 패키징 첫 실행 시 커밋 데이터를 userData로 시드(그 외엔 no-op)
    console.log(`[server] listening on ${HOSTS[0]} :${port}`);
    startScheduler(store);
    for (const host of HOSTS.slice(1)) {
      app
        .listen(port, host)
        .on('listening', () => console.log(`[server] listening on ${host} :${port}`))
        .on('error', (e: NodeJS.ErrnoException) => {
          console.warn(`[server] ${host}:${port}에는 열지 못했습니다(${e.code ?? e.message}) — ${HOSTS[0]}로만 받습니다.`);
        });
    }
  });
}
void startListening();
