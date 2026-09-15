import cron from 'node-cron';
import { loadTenants } from './config.js';
import { runWeeklyPipeline } from './pipeline.js';
import type { ResultStore } from './store.js';

/**
 * 주간 자동 측정 — **기본 꺼짐**. PIPELINE_CRON을 명시해야 등록된다.
 *
 * 전에는 매주 월요일 03:00이 기본값이었다. runAllTenants는 base config의 테넌트를 **전부**
 * 순차 측정하는데(지금 30곳), 곳마다 수집 72~216 호출에 판정이 그 몇 배다. 앱을 켜 둔 채
 * 월요일을 넘기면 사람이 시작하지 않은 측정이 수천 호출을 쓴다. 엔진 지출 한도에 실제로
 * 걸린 적이 있으므로 기본값으로 둘 동작이 아니다.
 *
 * 끄는 스위치가 아니라 켜는 스위치로 뒀다. 돈이 드는 일은 켜 두고 잊는 쪽이 아니라 켜야
 * 도는 쪽이 맞다. 켜려면:  PIPELINE_CRON="0 3 * * 1"
 */
const CRON_EXPRESSION = process.env.PIPELINE_CRON?.trim() ?? '';

export function startScheduler(store: ResultStore): void {
  if (!CRON_EXPRESSION) {
    console.log('[scheduler] 주간 자동 측정 꺼짐 (켜려면 PIPELINE_CRON, 예: "0 3 * * 1")');
    return;
  }
  if (!cron.validate(CRON_EXPRESSION)) {
    console.warn(`[scheduler] PIPELINE_CRON 형식이 올바르지 않아 등록하지 않습니다: "${CRON_EXPRESSION}"`);
    return;
  }
  cron.schedule(CRON_EXPRESSION, () => {
    void runAllTenants(store);
  });
  console.log(`[scheduler] 주간 자동 측정 등록됨: "${CRON_EXPRESSION}" — 등록 테넌트 전부를 측정합니다.`);
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
