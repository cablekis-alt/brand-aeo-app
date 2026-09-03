import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { appendTenant, loadTenants } from './config.js';
import { inferCompetitors } from './brandInference.js';
import { runWeeklyPipeline } from './pipeline.js';
import { normalizeTenantDraft } from './tenantRegistry.js';
import type { FileResultStore } from './store.js';
import type { TenantConfig } from './types.js';

const SEED_LIVE: Record<string, { bank: string; an: string }> = {
  'example-brand': { bank: 'src/data/live-question-bank.json', an: 'src/data/live-question-analyses.json' },
  'stay-meomum': { bank: 'src/data/live-stay-question-bank.json', an: 'src/data/live-stay-question-analyses.json' },
};

export interface MeasureBakeResult {
  ok: true;
  tenantId: string;
  brandName: string;
  weekOf: string;
  aeoScore: number;
}

/** 한 테넌트를 측정한 뒤 배포용 src/data에 baking한다. GitHub Actions·로컬 단건 측정이 같이 쓴다. */
export async function measureAndBake(tenant: TenantConfig, store: FileResultStore): Promise<MeasureBakeResult> {
  // 경쟁사가 비어 있으면 여기(CI 러너·로컬 = LLM이 정상 동작하는 환경)에서 자동 추론해 채운다.
  // Vercel 서버리스 리전은 한국어 브랜드 회상에 헛소리를 내므로 이 함수는 Vercel에서 실행되지 않는다.
  if (!tenant.competitors?.length && !tenant.cohortOnly) {
    const inferred = await inferCompetitors(tenant.brandName, tenant.industry, tenant.region).catch(() => []);
    if (inferred.length) {
      tenant = normalizeTenantDraft({
        ...tenant,
        competitors: inferred.map((c) => ({ name: c.name, domains: c.domain ? [c.domain] : [] })),
      });
      console.log(`[measureAndBake] ${tenant.tenantId} 경쟁사 자동 추론: ${inferred.map((c) => c.name).join(', ')}`);
    }
  }

  const inConfig = (await loadTenants()).some((item) => item.tenantId === tenant.tenantId);
  if (!inConfig) await appendTenant(tenant);

  const { scorecard } = await runWeeklyPipeline(tenant, store);
  const weekOf = scorecard.weekOf;
  const id = tenant.tenantId;
  const seed = SEED_LIVE[id];
  if (seed) {
    writeFileSync(seed.bank, readFileSync(`data/${id}/question-bank/${tenant.questionBankVersion}.json`, 'utf8'));
    const analyses = JSON.parse(readFileSync(`data/${id}/${weekOf}/question-analyses.json`, 'utf8')) as unknown;
    writeFileSync(seed.an, JSON.stringify({ tenantId: id, weekOf, analyses }, null, 2) + '\n');
    execSync('npx tsx scripts/rescore-all.ts', { stdio: 'inherit' });
  } else {
    execSync(`npx tsx scripts/publish-tenant.ts ${id}`, { stdio: 'inherit' });
  }

  return {
    ok: true,
    tenantId: id,
    brandName: tenant.brandName,
    weekOf,
    aeoScore: scorecard.aeoScore.current,
  };
}
