import 'dotenv/config';
import { measureAndBake } from '../server/measureAndBake.js';
import { readMeasureRequests, removeMeasureRequest } from '../server/measureRequests.js';
import { FileResultStore } from '../server/store.js';
import { loadRuntimeTenants, normalizeTenantDraft } from '../server/tenantRegistry.js';

// 대기열 전체를 러너에서 순차 처리하라는 신호(GitHub Actions 큐 모드).
const QUEUE_SENTINEL = '__queue__';

/** 대기열(Blob)에 쌓인 브랜드를 하나씩 측정·baking하고, 성공한 항목만 대기열에서 제거한다. */
async function measureQueue(): Promise<void> {
  const pending = await readMeasureRequests();
  if (pending.length === 0) {
    console.log('[ci-measure] 대기열이 비어 있습니다. 측정할 항목 없음.');
    return;
  }
  console.log(`[ci-measure] 대기열 ${pending.length}건을 순차 측정합니다.`);
  const store = new FileResultStore();
  const results: { tenantId: string; ok: boolean; aeoScore?: number; error?: string }[] = [];
  for (const item of pending) {
    const rawId = item.tenant?.tenantId ?? '(unknown)';
    try {
      // 큐에 담긴 시점의 정규화가 오래됐을 수 있어 측정 직전 다시 정규화한다.
      const tenant = normalizeTenantDraft(item.tenant);
      console.log(`[ci-measure] ▶ ${tenant.brandName} (${tenant.tenantId})`);
      const result = await measureAndBake(tenant, store);
      await removeMeasureRequest(tenant.tenantId); // 성공한 항목만 대기열에서 뺀다.
      results.push({ tenantId: tenant.tenantId, ok: true, aeoScore: result.aeoScore });
      console.log(`[ci-measure] ✓ ${tenant.tenantId} score=${result.aeoScore}`);
    } catch (err) {
      // 실패 항목은 대기열에 남겨 다음 실행에서 재시도한다(측정된 것은 그대로 커밋).
      const message = err instanceof Error ? err.message : String(err);
      results.push({ tenantId: rawId, ok: false, error: message });
      console.error(`[ci-measure] ✗ ${rawId}: ${message}`);
    }
  }
  console.log(JSON.stringify({ processed: results.length, results }));
}

/** 테넌트 하나만 측정·baking한다(단건 경로). */
async function measureOne(tenantId: string): Promise<void> {
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

/** GitHub Actions / 로컬 CLI — Blob 오버레이 포함 런타임 테넌트를 측정·baking한다. */
async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) throw new Error(`사용법: npx tsx scripts/ci-measure.ts <tenantId | ${QUEUE_SENTINEL}>`);
  if (arg === QUEUE_SENTINEL) await measureQueue();
  else await measureOne(arg);
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
