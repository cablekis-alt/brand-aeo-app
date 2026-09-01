import 'dotenv/config';
import { loadTenants } from '../server/config';
import { runWeeklyPipeline } from '../server/pipeline';
import { FileResultStore } from '../server/store';

async function main() {
  const tenants = await loadTenants();
  const tenant = tenants[0];
  if (!tenant) throw new Error('테넌트가 없습니다.');
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
