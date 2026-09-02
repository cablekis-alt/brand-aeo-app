import 'dotenv/config';
import express from 'express';
import { collectPage } from './aeo/collectPage';
import { inferBrandFields, inferCompetitors } from './brandInference';
import { demoQuestionBank, demoScorecardHistory } from './demoData';
import { DemoResultStore } from './demoStore';
import { runWeeklyPipeline } from './pipeline';
import { getCitationBreakdown, getCitationSourceAnalysis, getEeatAnalysis, getRankingView } from './queries';
import { startScheduler } from './scheduler';
import { FileResultStore } from './store';
import { loadRuntimeTenants, normalizeTenantDraft, registerTenant, toTenantSummary } from './tenantRegistry';
import type { TenantConfig } from './types';
import type { WeeklyScorecard } from '../src/prompts/b8-report';

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
  res.json({ ok: true, backend: 'express', canRegister: true, canMeasure: true });
});

app.get('/api/tenants', async (_req, res) => {
  const tenants = await loadRuntimeTenants();
  // 코호트 비교용 경쟁사 테넌트는 브랜드 선택 드롭다운에서 제외한다.
  res.json(tenants.filter((tenant) => !tenant.cohortOnly).map(toTenantSummary));
});

// S-08 브랜드 추가 — 온보딩 초안을 등록한다.
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

// S-08 — 등록된 테넌트를 즉시 측정한다 (수 분 소요). /api 프리픽스라 vite 프록시로 전달된다.
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

// S-02 브랜드 종합 진단 — 해당 주차의 문장 단위 판정 원본(언급/인용/순위/사실성)을 그대로 내려준다.
app.get('/api/question-analyses/:tenantId/:weekOf', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const source = await sourceFor(tenant, req.params.weekOf);
  res.json(await source.getQuestionAnalyses(tenant.tenantId, req.params.weekOf));
});

// S-04 질문 프롬프트 빌더 — ?version 없이 호출하면 테넌트에 설정된 현재 버전을 반환한다.
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

// S-05 URL 상세 분석 — 도메인×소유권 기준 인용 집계.
app.get('/api/citations/:tenantId/:weekOf', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const source = await sourceFor(tenant, req.params.weekOf);
  res.json(await getCitationBreakdown(source, tenant.tenantId, req.params.weekOf));
});

// S-09 EEAT 분석 — 답변에서 브랜드가 경험·전문성·권위·신뢰로 어떻게 그려지는지.
app.get('/api/eeat/:tenantId/:weekOf', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const source = await sourceFor(tenant, req.params.weekOf);
  res.json(await getEeatAnalysis(source, tenant.tenantId, req.params.weekOf));
});

// S-10 AI 인용출처 분석 — 출처 유형·엔진 치우침·합의 도메인.
app.get('/api/citation-sources/:tenantId/:weekOf', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const source = await sourceFor(tenant, req.params.weekOf);
  res.json(await getCitationSourceAnalysis(source, tenant.tenantId, req.params.weekOf));
});

// S-07 랭킹 분석 — 업종·지역 코호트 순위 + 경쟁사 언급 점유율.
app.get('/api/ranking/:tenantId/:weekOf', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const source = await sourceFor(tenant, req.params.weekOf);
  res.json(await getRankingView(source, tenant, req.params.weekOf));
});

// S-03 사이트 종합 진단 — 단일 URL의 공개 HTML을 수집한다 (SSRF 가드, 정적 수집).
app.get('/api/fetch', async (req, res) => {
  const target = typeof req.query.url === 'string' ? req.query.url : '';
  if (!target) {
    res.status(400).json({ error: 'url 쿼리가 필요합니다.' });
    return;
  }
  res.set('Cache-Control', 'no-store');
  res.json(await collectPage(target));
});

// S-08 브랜드 추가 — 수집된 페이지 텍스트에서 업종·지역·주소를 Gemini로 추론한다.
app.post('/api/infer-brand', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  const brandName = typeof req.body?.brandName === 'string' ? req.body.brandName : '';
  if (!text.trim()) {
    res.status(400).json({ error: 'text가 필요합니다.' });
    return;
  }
  try {
    res.json(await inferBrandFields(text, brandName));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// S-08 브랜드 추가 — 같은 업종·지역의 경쟁사를 Gemini(웹검색)로 추천하고 도메인은 DNS로 검증한다.
app.post('/api/infer-competitors', async (req, res) => {
  const brandName = typeof req.body?.brandName === 'string' ? req.body.brandName : '';
  const industry = typeof req.body?.industry === 'string' ? req.body.industry : '';
  const region = typeof req.body?.region === 'string' ? req.body.region : '';
  if (!brandName.trim() || !industry.trim()) {
    res.status(400).json({ error: 'brandName, industry가 필요합니다.' });
    return;
  }
  try {
    res.json(await inferCompetitors(brandName, industry, region));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
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

app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
  startScheduler(store);
});
