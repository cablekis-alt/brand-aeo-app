import 'dotenv/config';
import { measureAndBake } from '../server/measureAndBake.js';
import { FileResultStore } from '../server/store.js';
import { loadRuntimeTenants } from '../server/tenantRegistry.js';

/** GitHub Actions / 로컬 CLI — Blob 오버레이 포함 런타임 테넌트를 측정·baking한다. */
async function main(): Promise<void> {
  const tenantId = process.argv[2];
  if (!tenantId) throw new Error('사용법: npx tsx scripts/ci-measure.ts <tenantId>');

  const tenants = await loadRuntimeTenants();
  const tenant = tenants.find((item) => item.tenantId === tenantId);
  if (!tenant) {
    throw new Error(`테넌트를 찾지 못했습니다: ${tenantId} (사용 가능: ${tenants.map((t) => t.tenantId).join(', ')})`);
  }

  console.log(`[ci-measure] ${tenant.brandName} (${tenant.tenantId}) engines=${tenant.engines.join(',')}`);
  const result = await measureAndBake(tenant, new FileResultStore());
  console.log(`[ci-measure] done ${result.weekOf} score=${result.aeoScore}`);
  console.log(JSON.stringify(result));
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
