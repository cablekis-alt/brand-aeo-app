import 'dotenv/config';
import { loadTenants } from '../server/config';
import { runWeeklyPipeline } from '../server/pipeline';
import { FileResultStore } from '../server/store';

async function main() {
  const tenants = await loadTenants();
  // 인자로 tenantId를 주면 그 테넌트만, 없으면 첫 번째 테넌트를 돌린다.
  //   npx tsx scripts/run-pipeline.ts stay-meomum
  const tenantId = process.argv[2];
  const tenant = tenantId ? tenants.find((t) => t.tenantId === tenantId) : tenants[0];
  if (!tenant) {
    throw new Error(
      tenantId
        ? `테넌트를 찾지 못했습니다: ${tenantId} (사용 가능: ${tenants.map((t) => t.tenantId).join(', ')})`
        : '테넌트가 없습니다.',
    );
  }
  console.log(
    `[pipeline] tenant=${tenant.brandName} engines=${tenant.engines.join(',')} questions=${tenant.questionBankSize} collect=${process.env.OPENAI_MODEL ?? 'gpt-4o'}`,
  );
  const store = new FileResultStore();
  const result = await runWeeklyPipeline(tenant, store);
  console.log('[pipeline] scorecard');
  console.log(JSON.stringify(result.scorecard, null, 2));
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
