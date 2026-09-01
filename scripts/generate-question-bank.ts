/**
 * B1 질문 은행만 생성한다 (수집·분석 파이프라인은 돌리지 않음).
 * 버전이 tenants.config.json과 같고 data/에 이미 있으면 재사용한다.
 *   npx tsx scripts/generate-question-bank.ts
 *   npx tsx scripts/generate-question-bank.ts example-brand stay-meomum
 */
import 'dotenv/config';
import { agnosticQuota, countAgnostic } from '../src/prompts/b1-question-bank';
import { loadTenants } from '../server/config';
import { ensureQuestionBank } from '../server/pipeline';
import { FileResultStore } from '../server/store';

async function main() {
  const requested = process.argv.slice(2);
  const all = await loadTenants();
  const targets = requested.length
    ? all.filter((t) => requested.includes(t.tenantId))
    : all.filter((t) => !t.cohortOnly);

  if (targets.length === 0) {
    throw new Error(
      requested.length
        ? `테넌트를 찾지 못했습니다: ${requested.join(', ')}`
        : '생성할 테넌트가 없습니다.',
    );
  }

  const store = new FileResultStore();
  console.log(`[B1] ${targets.length}개 테넌트: ${targets.map((t) => t.tenantId).join(', ')}`);

  for (const tenant of targets) {
    const quota = agnosticQuota(tenant.questionBankSize);
    const questions = await ensureQuestionBank(tenant, store);
    const agnostic = countAgnostic(questions);
    const ok = agnostic >= quota ? 'OK' : 'UNDER';
    console.log(
      `[B1] ${ok} ${tenant.brandName} ${tenant.questionBankVersion} ` +
        `agnostic=${agnostic}/${questions.length} (하한 ${quota})`,
    );
    for (const q of questions) {
      console.log(`  ${q.questionId}  ${q.category.padEnd(24)}  ${q.text}`);
    }
  }
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
