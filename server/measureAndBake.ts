import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { appendTenant, loadTenants } from './config.js';
import { runWeeklyPipeline } from './pipeline.js';
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
