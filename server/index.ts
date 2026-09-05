import 'dotenv/config';
import { execSync } from 'node:child_process';
import path from 'node:path';
import express from 'express';
import { packagedDataMode } from './appPaths.js';
import { seedFirstRunIfEmpty } from './seedFirstRun.js';
import { collectPage } from './aeo/collectPage.js';
import { inferAddressViaSearch, inferBrandFields, inferBrandFromDomain, inferCompetitors } from './brandInference.js';
import { cancelMeasureRun, canTriggerRemoteMeasure, listMeasureRuns, triggerGithubDelete } from './githubMeasure.js';
import { addMeasureRequest, readMeasureRequests, removeMeasureRequest } from './measureRequests.js';
import { addDeleteRequest, DELETE_QUEUE_SENTINEL } from './deleteRequests.js';
import { demoQuestionBank, demoScorecardHistory } from './demoData.js';
import { DemoResultStore } from './demoStore.js';
import { measureAndBake } from './measureAndBake.js';
import { readLocalMeasures } from './localMeasureLog.js';
import { listActiveMeasures } from './measureTracker.js';
import { runWeeklyPipeline } from './pipeline.js';
import { getCitationBreakdown, getCitationSourceAnalysis, getEeatAnalysis, getRankingView } from './queries.js';
import { startScheduler } from './scheduler.js';
import { FileResultStore } from './store.js';
import {
  blobStoreEnabled,
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

async function scorecardsFor(tenantId: string): Promise<WeeklyScorecard[]> {
  const history = await store.getScorecardHistory(tenantId, 12);
  return history.length > 0 ? history : demoScorecardHistory(tenantId);
}

/**
 * 파이프라인을 아직 돌리지 않은 주차는 파일 스토어가 비어 있다. 그럴 때만 데모 스토어로 넘겨서
 * 화면이 빈 상태로 남지 않게 한다 (배포 환경의 서버리스 함수와 같은 규칙).
 */
async function sourceFor(tenant: TenantConfig, weekOf: string) {
  const stored = await store.getQuestionAnalyses(tenant.tenantId, weekOf);
  return stored.length > 0 ? store : new DemoResultStore([tenant]);
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// 로컬 백엔드 감지용. 배포(Vercel)는 api/health.ts가 같은 계약을 제공한다.
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, backend: 'express', canRegister: true, canMeasure: true, measureVia: 'local' });
});

app.get('/api/tenants', async (req, res) => {
  const tenants = await loadRuntimeTenants();
  // 기본은 브랜드 드롭다운용(경쟁사 제외). ?all=1이면 측정 대상 선택용으로 전부 준다.
  const all = req.query.all === '1' || req.query.all === 'true';
  const picked = all ? tenants : tenants.filter((tenant) => !tenant.cohortOnly);
  res.json(picked.map((tenant) => ({ ...toTenantSummary(tenant), cohortOnly: Boolean(tenant.cohortOnly) })));
});

// 브랜드 삭제 — 오버레이(런타임 등록분)와 대기열에서 제거. 베이크된 테넌트는 CLI(delete-tenant.ts)+배포 필요.
app.delete('/api/tenants', async (req, res) => {
  const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId.trim() : '';
  if (!tenantId) {
    res.status(400).json({ error: 'tenantId 쿼리가 필요합니다.' });
    return;
  }
  try {
    const { removed } = await removeOverlayTenant(tenantId);
    await removeMeasureRequest(tenantId);
    const stillBaked = isBakedTenant(tenantId);
    let dispatched = false;
    let htmlUrl: string | undefined;
    if (stillBaked && canTriggerRemoteMeasure()) {
      try {
        // 큐에 누적하고 큐 모드로 트리거 — 여러 개를 빠르게 삭제해도 concurrency로 run이 취소되지 않게.
        await addDeleteRequest(tenantId);
        ({ htmlUrl } = await triggerGithubDelete(DELETE_QUEUE_SENTINEL));
        dispatched = true;
      } catch {
        dispatched = false;
      }
    }
    res.json({ ok: true, tenantId, removedFromOverlay: removed, stillBaked, dispatched, htmlUrl });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 측정 상태 — 앱이 직접 돌린 로컬 측정의 진행 중(measureAndBake가 브랜드마다 추적) + 완료 기록.
app.get('/api/measure-status', (_req, res) => {
  res.json({ active: listActiveMeasures(), completed: readLocalMeasures() });
});

// "테넌트 골라 측정" — 지정 테넌트 하나(+본 브랜드면 경쟁사·코호트)를 측정하고 baking까지 한다 (로컬).
// 진행중/완료 추적·로깅은 measureAndBake 내부에서 브랜드마다 처리한다.
app.post('/api/tenants/:tenantId/measure', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  try {
    const result = await measureAndBake(tenant, store);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 브랜드 추가 — 온보딩 초안을 등록한다.
app.post('/api/tenants', async (req, res) => {
  try {
    const tenant = normalizeTenantDraft(req.body);
    await registerTenant(tenant);
    res.status(201).json({ ok: true, tenantId: tenant.tenantId, brandName: tenant.brandName });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('필수 항목') ? 400 : message.includes('이미 존재') ? 409 : 500;
    res.status(status).json({ error: message });
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
  res.json(await scorecardsFor(req.params.tenantId));
});

app.get('/scorecards/:tenantId', async (req, res) => {
  res.json(await scorecardsFor(req.params.tenantId));
});

// 브랜드 종합 진단 — 해당 주차의 문장 단위 판정 원본(언급/인용/순위/사실성)을 그대로 내려준다.
app.get('/api/question-analyses/:tenantId/:weekOf', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const source = await sourceFor(tenant, req.params.weekOf);
  res.json(await source.getQuestionAnalyses(tenant.tenantId, req.params.weekOf));
});

// 질문 프롬프트 빌더 — ?version 없이 호출하면 테넌트에 설정된 현재 버전을 반환한다.
app.get('/api/question-bank/:tenantId', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const version = typeof req.query.version === 'string' ? req.query.version : tenant.questionBankVersion;
  const bank = await store.getQuestionBank(tenant.tenantId, version);
  const latestWeek = (await scorecardsFor(tenant.tenantId)).at(-1)?.weekOf ?? '2026-W36';
  res.json(bank ?? demoQuestionBank(tenant, latestWeek));
});

// URL 상세 분석 — 도메인×소유권 기준 인용 집계.
app.get('/api/citations/:tenantId/:weekOf', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const source = await sourceFor(tenant, req.params.weekOf);
  res.json(await getCitationBreakdown(source, tenant.tenantId, req.params.weekOf));
});

// EEAT 분석 — 답변에서 브랜드가 경험·전문성·권위·신뢰로 어떻게 그려지는지.
app.get('/api/eeat/:tenantId/:weekOf', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const source = await sourceFor(tenant, req.params.weekOf);
  res.json(await getEeatAnalysis(source, tenant.tenantId, req.params.weekOf));
});

// AI 인용출처 분석 — 출처 유형·엔진 치우침·합의 도메인.
app.get('/api/citation-sources/:tenantId/:weekOf', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const source = await sourceFor(tenant, req.params.weekOf);
  res.json(await getCitationSourceAnalysis(source, tenant.tenantId, req.params.weekOf));
});

// 랭킹 분석 — 업종·지역 코호트 순위 + 경쟁사 언급 점유율.
app.get('/api/ranking/:tenantId/:weekOf', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const source = await sourceFor(tenant, req.params.weekOf);
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
      res.json(await inferCompetitors(brandName, industry, region));
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

app.listen(PORT, () => {
  seedFirstRunIfEmpty(); // 패키징 첫 실행 시 커밋 데이터를 userData로 시드(그 외엔 no-op)
  console.log(`[server] listening on :${PORT}`);
  startScheduler(store);
});
