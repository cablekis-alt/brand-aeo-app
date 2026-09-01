/**
 * cohortOnly 경쟁사 테넌트 전체(또는 인자로 준 테넌트들)의 파이프라인을 순차 실행한다.
 *   npx tsx scripts/run-cohort.ts               # 모든 cohortOnly 테넌트
 *   npx tsx scripts/run-cohort.ts wonjin jjun   # 지정 테넌트만
 */
import 'dotenv/config';
import { loadTenants } from '../server/config';
import { runWeeklyPipeline } from '../server/pipeline';
import { FileResultStore } from '../server/store';

async function main() {
  const all = await loadTenants();
  const requested = process.argv.slice(2);
  const targets = requested.length
    ? all.filter((t) => requested.includes(t.tenantId))
    : all.filter((t) => t.cohortOnly);

  if (targets.length === 0) {
    console.log('실행할 테넌트가 없습니다.');
    return;
  }

  const store = new FileResultStore();
  console.log(`[cohort] ${targets.length}개 테넌트 실행: ${targets.map((t) => t.tenantId).join(', ')}`);

  for (const [i, tenant] of targets.entries()) {
    const label = `(${i + 1}/${targets.length}) ${tenant.brandName} [${tenant.tenantId}]`;
    console.log(`\n[cohort] ${label} 시작 — 경쟁사 ${tenant.competitors.length}, 질문 ${tenant.questionBankSize}`);
    try {
      const { scorecard } = await runWeeklyPipeline(tenant, store);
      console.log(
        `[cohort] ${label} 완료 — Score ${scorecard.aeoScore.current} | 언급률 ${(scorecard.mentionRate * 100).toFixed(1)}% | SoM ${scorecard.shareOfMention === null ? 'null' : (scorecard.shareOfMention * 100).toFixed(1) + '%'}`,
      );
    } catch (err) {
      console.error(`[cohort] ${label} 실패:`, err instanceof Error ? err.message : err);
    }
  }
  console.log('\n[cohort] 전체 완료');
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
