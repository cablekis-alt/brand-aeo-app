import { brandLabel } from '../src/lib/brandVariant.js';
import { todayKst } from '../src/lib/publishedUrl.js';
import { buildTenantStatus, orderRows, type PublishStatus, type TenantIssue } from '../src/lib/publishStatus.js';
import type { WriterPlan } from '../src/lib/probePlan.js';
import { readIndexChecksInQueue } from './indexChecks.js';
import { readProbePlan } from './probePlanStore.js';
import { readPublishedPostsInQueue } from './publishedPosts.js';
import { queueTenantWrite } from './tenantWriteQueue.js';
import type { TenantConfig } from './types.js';

type Settled<T> = { ok: true; value: T } | { ok: false; error: string };

/** 실패를 그 브랜드의 오류 글자로 바꾼다(그 브랜드만 issues로 알린다). */
const settle = <T>(p: Promise<T>): Promise<Settled<T>> =>
  p.then(
    (value): Settled<T> => ({ ok: true, value }),
    (err: unknown): Settled<T> => ({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  );

/**
 * 발행 현황 — 고객 브랜드(경쟁사 빼고) 모두의 올린 글 · 작성자 배정 · 색인 확인을 한 번에 모은다(줄 계산은 src/lib/publishStatus.ts).
 * 읽기만 한다. 원장과 확인 파일은 그 브랜드의 쓰기 줄에서 함께 읽는다(같은 순간의 두 파일 · 윈도우 EPERM).
 *
 * 한 브랜드의 파일이 깨져도 전체를 실패시키지 않는다 — 그 브랜드는 줄 없이 오류(issues)로 알리고 나머지는 그대로 보인다. 배정 파일만 깨졌으면
 * 줄은 보이되 작성자를 「미확인」으로 둔다(「배정 없음」으로 채우지 않는다). 같은 주소의 확인 기록은 브랜드를 건너 함께 본다 — 읽은 확인
 * 파일은 원장이 깨진 브랜드 것도 쓴다(적을 때 server/indexChecks.ts가 이어받는 기록과 같게).
 */
export async function readPublishStatus(tenants: TenantConfig[], now = Date.now()): Promise<PublishStatus> {
  const customers = tenants.filter((t) => !t.cohortOnly);
  const parts = await Promise.all(
    customers.map(async (t) => {
      const brand = brandLabel(t, customers);
      const issues: TenantIssue[] = [];
      let plan: WriterPlan | null = null;
      let planUnreadable: boolean;
      try {
        const state = await readProbePlan(t.tenantId);
        plan = state.plan;
        planUnreadable = state.corrupt;
      } catch (err) {
        console.error(`[publishStatus] ${t.tenantId} probe-plan.json을 읽지 못했습니다:`, err);
        planUnreadable = true;
      }
      if (planUnreadable) issues.push({ tenantId: t.tenantId, brand, error: '배정 파일(probe-plan.json)을 읽지 못해 작성자를 붙이지 못했습니다.' });
      const files = await queueTenantWrite(t.tenantId, async () => ({
        posts: await settle(readPublishedPostsInQueue(t.tenantId)),
        checks: await settle(readIndexChecksInQueue(t.tenantId)),
      }));
      for (const f of [files.posts, files.checks]) if (!f.ok) issues.push({ tenantId: t.tenantId, brand, error: f.error });
      return { t, brand, plan, planUnreadable, issues, files };
    }),
  );
  const shared = parts.flatMap((p) => (p.files.checks.ok ? [{ tenantId: p.t.tenantId, brand: p.brand, checks: p.files.checks.value }] : []));
  const built = parts.map((p) => {
    const { posts, checks } = p.files;
    if (!posts.ok || !checks.ok) return { rows: [], writers: [] };
    return buildTenantStatus({
      tenantId: p.t.tenantId,
      brand: p.brand,
      ownedDomains: p.t.ownedDomains ?? [],
      posts: posts.value,
      plan: p.plan,
      planUnreadable: p.planUnreadable,
      checks: checks.value,
      others: shared.filter((s) => s.tenantId !== p.t.tenantId),
    });
  });
  return {
    today: todayKst(now),
    rows: orderRows(built.flatMap((b) => b.rows)),
    writers: built.flatMap((b) => b.writers),
    issues: parts.flatMap((p) => p.issues),
  };
}
