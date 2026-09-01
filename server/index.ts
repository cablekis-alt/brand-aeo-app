import 'dotenv/config';
import express from 'express';
import { collectPage } from './aeo/collectPage';
import { loadTenants } from './config';
import { demoQuestionBank, demoScorecardHistory } from './demoData';
import { DemoResultStore } from './demoStore';
import { runWeeklyPipeline } from './pipeline';
import { getCitationBreakdown, getRankingView } from './queries';
import { startScheduler } from './scheduler';
import { FileResultStore } from './store';
import type { TenantConfig } from './types';
import type { WeeklyScorecard } from '../src/prompts/b8-report';

const app = express();
const store = new FileResultStore();
const PORT = process.env.PORT ?? 4000;

function toTenantSummary(tenant: TenantConfig) {
  return {
    tenantId: tenant.tenantId,
    brandName: tenant.brandName,
    aliases: tenant.aliases,
    ownedDomains: tenant.ownedDomains,
    industry: tenant.industry,
    region: tenant.region,
    engines: tenant.engines,
    questionBankSize: tenant.questionBankSize,
    competitors: tenant.competitors.map((competitor) => competitor.name),
  };
}

async function findTenant(tenantId: string): Promise<TenantConfig | undefined> {
  const tenants = await loadTenants();
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

app.get('/api/tenants', async (_req, res) => {
  const tenants = await loadTenants();
  res.json(tenants.map(toTenantSummary));
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
