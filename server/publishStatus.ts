import { brandLabel } from '../src/lib/brandVariant.js';
import { externalViews } from '../src/lib/externalPosts.js';
import { todayKst } from '../src/lib/publishedUrl.js';
import { buildTenantStatus, orderRows, type PublishStatus, type TenantChecks, type TenantIssue } from '../src/lib/publishStatus.js';
import type { WriterPlan } from '../src/lib/probePlan.js';
import { readExternalPostsInQueue } from './externalPosts.js';
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
 * 읽기만 한다. 원장 · 확인 파일 · 앱 밖 글 파일(data/<tenant>/external-posts.json)은 그 브랜드의 쓰기 줄에서 함께 읽는다(같은 순간의 파일 ·
 * 윈도우 EPERM). 줄 안에서는 …InQueue 읽기만 쓴다(줄은 다시 들어갈 수 없다).
 *
 * 한 브랜드의 파일이 깨져도 전체를 실패시키지 않는다 — 그 브랜드는 줄 없이 오류(issues)로 알리고 나머지는 그대로 보인다. 배정 파일만 깨졌으면
 * 줄은 보이되 작성자를 「미확인」으로 둔다(「배정 없음」으로 채우지 않는다). 앱 밖 글 파일만 깨졌으면 앱 글 줄은 그대로 보이고 앱 밖 줄만 빠진
 * 것을 알린다. 같은 주소의 확인 기록은 브랜드를 건너 함께 본다 — 읽은 확인 파일은 원장이 깨진 브랜드 것도 쓴다(적을 때 server/indexChecks.ts가
 * 이어받는 기록과 같게).
 */
export async function readPublishStatus(tenants: TenantConfig[], now = Date.now()): Promise<PublishStatus> {
  return (await readPublishStatusSnapshot(tenants, now)).status;
}

/** 발행 현황과, 그 표를 만든 바로 그 확인 기록(브랜드마다 거르기 전 원본 — 파일이 깨진 브랜드는 빠진다). */
export interface PublishStatusSnapshot {
  status: PublishStatus;
  checks: TenantChecks[];
}

/**
 * readPublishStatus와 같은 읽기에 원본 확인 기록을 함께 준다 — 색인 자동 확인(server/indexAuto.ts)이 대상(줄)과 CAS 기준값(원본 최신 기록)을
 * 같은 순간의 파일에서 셈한다. 따로 두 번 읽으면 그 사이 사람이 누른 표시가 기준값에만 들어가 덮일 수 있다.
 */
export async function readPublishStatusSnapshot(tenants: TenantConfig[], now = Date.now()): Promise<PublishStatusSnapshot> {
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
        external: await settle(readExternalPostsInQueue(t.tenantId)),
      }));
      for (const f of [files.posts, files.checks]) if (!f.ok) issues.push({ tenantId: t.tenantId, brand, error: f.error });
      if (!files.external.ok) issues.push({ tenantId: t.tenantId, brand, error: `${files.external.error} — 앱 밖 글 줄은 보이지 않습니다(앱 글 줄은 그대로).` });
      return { t, brand, plan, planUnreadable, issues, files };
    }),
  );
  const shared = parts.flatMap((p) => (p.files.checks.ok ? [{ tenantId: p.t.tenantId, brand: p.brand, checks: p.files.checks.value }] : []));
  const built = parts.map((p) => {
    const { posts, checks, external } = p.files;
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
      external: external.ok ? externalViews(external.value, posts.value) : [],
    });
  });
  return {
    status: {
      today: todayKst(now),
      brands: parts.map((p) => ({ tenantId: p.t.tenantId, brand: p.brand })),
      rows: orderRows(built.flatMap((b) => b.rows)),
      writers: built.flatMap((b) => b.writers),
      issues: parts.flatMap((p) => p.issues),
    },
    checks: shared.map(({ tenantId, checks }) => ({ tenantId, checks })),
  };
}
