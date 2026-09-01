import cron from 'node-cron';
import { loadTenants } from './config';
import { runWeeklyPipeline } from './pipeline';
import type { ResultStore } from './store';

// 매주 월요일 03:00 (서버 로컬 타임존). 예상 호출량(슬라이드 기준 100문항×4엔진×3회=1,200콜/테넌트/주)을
// 감안해 트래픽이 적은 새벽 시간대로 잡는다. 환경변수로 오버라이드 가능하게 한다.
const CRON_EXPRESSION = process.env.PIPELINE_CRON ?? '0 3 * * 1';

export function startScheduler(store: ResultStore): void {
  cron.schedule(CRON_EXPRESSION, () => {
    void runAllTenants(store);
  });
  console.log(`[scheduler] B2 스케줄 등록됨: "${CRON_EXPRESSION}"`);
}

/** 테넌트 하나가 실패해도 나머지 테넌트 실행은 계속되도록 개별적으로 캐치한다. */
export async function runAllTenants(store: ResultStore): Promise<void> {
  const tenants = await loadTenants();
  for (const tenant of tenants) {
    try {
      console.log(`[pipeline] ${tenant.tenantId} 시작`);
      const { scorecard } = await runWeeklyPipeline(tenant, store);
      console.log(`[pipeline] ${tenant.tenantId} 완료 — AEO Score ${scorecard.aeoScore.current}`);
    } catch (err) {
      console.error(`[pipeline] ${tenant.tenantId} 실패`, err);
    }
  }
}
