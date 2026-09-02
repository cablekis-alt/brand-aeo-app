/**
 * S-08 측정 대기열 처리 — 배포 사이트에서 "브랜드 등록"으로 쌓인 측정 요청을 로컬에서 처리한다.
 *   npx tsx scripts/measure-requests.ts             # 대기열 목록만 표시
 *   npx tsx scripts/measure-requests.ts --measure   # config 등록 + 측정 + publish + 대기열 정리
 * 이후 git commit + npx vercel --prod 로 공개된다. (측정엔 OpenAI/Gemini 키 필요)
 */
import 'dotenv/config';
import { execSync } from 'node:child_process';
import { appendTenant, loadTenants } from '../server/config.js';
import { runWeeklyPipeline } from '../server/pipeline.js';
import { FileResultStore } from '../server/store.js';
import type { MeasureRequest } from '../server/measureRequests.js';

const BASE = process.env.MEASURE_API_BASE ?? 'https://brand-aeo-app.vercel.app';

async function fetchPending(): Promise<MeasureRequest[]> {
  const res = await fetch(`${BASE}/api/measure-requests`);
  if (!res.ok) throw new Error(`대기열 조회 실패 (HTTP ${res.status}) — ${BASE}`);
  return (await res.json()) as MeasureRequest[];
}

async function clearPending(tenantId: string): Promise<void> {
  await fetch(`${BASE}/api/measure-requests?tenantId=${encodeURIComponent(tenantId)}`, { method: 'DELETE' });
}

async function main(): Promise<void> {
  const measure = process.argv.includes('--measure');
  const pending = await fetchPending();

  if (pending.length === 0) {
    console.log(`측정 대기열이 비어 있습니다. (${BASE})`);
    return;
  }
  console.log(`측정 대기 ${pending.length}건:`);
  for (const r of pending) {
    console.log(`  - ${r.tenant.tenantId} (${r.tenant.brandName}) · 요청 ${r.requestedAt.slice(0, 10)}`);
  }
  if (!measure) {
    console.log('\n측정하려면:  npx tsx scripts/measure-requests.ts --measure');
    console.log('(측정 후 git commit + npx vercel --prod 로 배포)');
    return;
  }

  const store = new FileResultStore();
  for (const r of pending) {
    const t = r.tenant;
    console.log(`\n[측정] ${t.tenantId} (${t.brandName}) — 질문 ${t.questionBankSize} × ${t.repeatsPerQuestion}회…`);
    try {
      const existing = await loadTenants();
      if (!existing.some((x) => x.tenantId === t.tenantId)) {
        await appendTenant(t);
        console.log('  server/tenants.config.json에 추가됨');
      }
      const { scorecard } = await runWeeklyPipeline(t, store);
      console.log(`  측정 완료 — AEO Score ${scorecard.aeoScore.current}`);
      execSync(`npx tsx scripts/publish-tenant.ts ${t.tenantId}`, { stdio: 'inherit' });
      await clearPending(t.tenantId);
      console.log(`  ✓ ${t.tenantId} baking + 대기열 정리 완료`);
    } catch (err) {
      console.error(`  ✗ ${t.tenantId} 실패:`, err instanceof Error ? err.message : err);
    }
  }
  console.log('\n모두 처리했습니다. git commit + npx vercel --prod 로 배포하세요.');
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
