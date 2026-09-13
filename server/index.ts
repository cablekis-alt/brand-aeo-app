import 'dotenv/config';
import { execSync } from 'node:child_process';
import path from 'node:path';
import express from 'express';
import { packagedDataMode } from './appPaths.js';
import { seedFirstRunIfEmpty } from './seedFirstRun.js';
import { collectPage } from './aeo/collectPage.js';
import { inferAddressViaSearch, inferAliases, inferBrandFields, inferBrandFromDomain, inferBrandFromName, inferCompetitors } from './brandInference.js';
import { fetchAiReferrals } from './gaReferrals.js';
import { ciSyncEnabled, describeRepo, syncFromCi } from './ciSync.js';
import { tagJourneyStages } from './journeyStage.js';
import { tagQuestionTopics } from './questionTopic.js';
import { generateBrief, readBriefs } from './contentBrief.js';
import { generateDraft, readDrafts, saveEditedDraft } from './contentDraft.js';
import { extractFactCandidates } from './factExtract.js';
import { normalizeFactGraph, readFactGraphFile, writeFactGraphFile } from './factGraphStore.js';
import { getJudgeClient } from './engines/index.js';
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
import { isActionStatus, readActionStates, sanitizeUrls, writeActionState } from './actionStates.js';
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
  res.json({ ok: true, backend: 'express', canRegister: true, canMeasure: true, measureVia: 'local', servesUi: Boolean(process.env.ELECTRON_STATIC_DIR) });
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
    const baked = await isBakedTenant(tenantId);
    let dispatched = false;
    let htmlUrl: string | undefined;
    let locallyDeleted = false;
    if (baked && !process.env.VERCEL) {
      // 로컬/패키징(Electron) — 베이크된 브랜드도 툼스톤으로 즉시 완전 삭제(GitHub Actions 불필요).
      await deleteTenantLocally(tenantId);
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
    // reuseCohort=true면 이번 주 카드가 이미 있는(같은 엔진으로 잰) 경쟁사는 다시 재지 않는다.
    const reuseCohort = (req.body as { reuseCohort?: unknown } | undefined)?.reuseCohort === true;
    const result = await measureAndBake(tenant, store, { reuseCohort });
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
  const version = typeof req.query.version === 'string' ? req.query.version : tenant.questionBankVersion;
  const bank = await store.getQuestionBank(tenant.tenantId, version);
  const latestWeek = (await scorecardsFor(tenant.tenantId)).at(-1)?.weekOf ?? '2026-W36';
  if (!bank) markDemo(res);
  res.json(bank ?? demoQuestionBank(tenant, latestWeek));
});

// URL 상세 분석 — 도메인×소유권 기준 인용 집계.
app.get('/api/citations/:tenantId/:weekOf', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const source = await sourceFor(tenant, req.params.weekOf, res);
  res.json(await getCitationBreakdown(source, tenant.tenantId, req.params.weekOf));
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
  res.json(await getCitationSourceAnalysis(source, tenant.tenantId, req.params.weekOf));
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
      },
      getJudgeClient(),
    );
    res.json({ ...stored, reused: false });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 브랜드 사실(팩트 그래프) — 데스크톱·로컬 전용. 파일이 있으면 베이스·오버레이보다 우선한다.
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
      },
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
app.post('/api/tenants/:tenantId/fact-candidates', async (req, res) => {
  const tenant = await findTenant(req.params.tenantId);
  if (!tenant) {
    res.status(404).json({ error: `tenant not found: ${req.params.tenantId}` });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const given = typeof body.url === 'string' ? body.url.trim() : '';
  const domain = (tenant.ownedDomains ?? [])[0] ?? '';
  const url = given || (domain ? `https://${domain.replace(/^https?:\/\//, '')}` : '');
  if (!url) {
    res.status(400).json({ error: '읽을 주소가 없습니다. 브랜드에 자사 도메인을 등록하거나 url을 넘기세요.' });
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
  res.json(await readActionStates(tenant.tenantId));
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

app.listen(PORT, () => {
  seedFirstRunIfEmpty(); // 패키징 첫 실행 시 커밋 데이터를 userData로 시드(그 외엔 no-op)
  console.log(`[server] listening on :${PORT}`);
  startScheduler(store);
});
