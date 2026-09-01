/**
 * 데모 판정 데이터가 demo-scorecards.json의 주간 지표를 실제로 재현하는지 확인한다.
 * 화면(B-02/04/06)이 이 레코드를 다시 집계하므로, 어긋나면 대시보드 수치와 상세 화면이 불일치한다.
 *
 *   npx tsx scripts/verify-demo-data.ts
 */
import { demoQuestionAnalyses, demoQuestionBank, demoScorecardHistory } from '../server/demoData';
import { DemoResultStore } from '../server/demoStore';
import { getRankingView } from '../server/queries';
import tenants from '../server/tenants.config.json';
import type { TenantConfig } from '../server/types';

const TOLERANCE = 0.02;

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

async function verifyTenant(tenant: TenantConfig): Promise<number> {
  const store = new DemoResultStore([tenant]);
  const history = demoScorecardHistory(tenant.tenantId);
  if (history.length === 0) {
    console.log(`—    ${tenant.tenantId}: 데모 스코어카드 없음 (건너뜀)`);
    return 0;
  }
  console.log(`\n### ${tenant.brandName} (${tenant.tenantId}) — ${tenant.industry} · ${tenant.region}`);

  let failures = 0;

  for (const card of history) {
    const analyses = demoQuestionAnalyses(tenant, card.weekOf);
    // 언급률은 category-agnostic 질문에 대한 비율이다. 질문 id 규칙이 데모(q-*)와
    // 실측(v1-*/v2-*)에서 다르므로, 질문 은행의 실제 category를 기준으로 판별한다.
    const bank = demoQuestionBank(tenant, card.weekOf);
    const agnostic = new Set(
      bank.questions.filter((q) => q.category === 'category-agnostic').map((q) => q.questionId),
    );
    const agnosticRecords = analyses.filter((a) => agnostic.has(a.questionId));

    const derivedMention = mean(agnosticRecords.map((a) => (a.mentioned ? 1 : 0)));
    const derivedSom = mean(analyses.map((a) => a.shareOfMention));
    const ranks = analyses.map((a) => a.brandRank).filter((r): r is number => r !== null);
    const derivedRank = mean(ranks);
    const supported = analyses.reduce((s, a) => s + a.factualitySupported, 0);
    const contradicted = analyses.reduce((s, a) => s + a.factualityContradicted, 0);
    const derivedFact = supported + contradicted > 0 ? supported / (supported + contradicted) : 1;
    // 스코어카드의 brandOwnedCitationRate는 "응답 단위"(자사 인용을 포함한 응답 비율)다.
    // B-04 화면의 "인용 단위" 비율과는 정의가 다르므로 여기서는 응답 단위로 맞춘다.
    const brandOwnedCitationRate = mean(analyses.map((a) => (a.brandOwnedCitation ? 1 : 0)));
    const ranking = await getRankingView(store, tenant, card.weekOf);

    const checks: [string, number, number][] = [
      ['언급률', derivedMention, card.mentionRate],
      ['SoM', derivedSom, card.shareOfMention],
      ['사실성', derivedFact, card.factualityScore],
      ['인용', brandOwnedCitationRate, card.brandOwnedCitationRate],
    ];

    const bad = checks.filter(([, got, want]) => Math.abs(got - want) > TOLERANCE);
    // 순위는 추천 문맥이 없으면 null이다. 그 경우 파생값도 순위 레코드가 없어야 정합이다.
    if (card.avgRecommendationRank === null) {
      if (ranks.length > 0) bad.push(['순위(null 기대)', derivedRank, 0]);
    } else if (Math.abs(derivedRank - card.avgRecommendationRank) > 0.15) {
      bad.push(['순위', derivedRank, card.avgRecommendationRank]);
    }

    failures += bad.length;
    const status = bad.length === 0 ? 'OK  ' : 'FAIL';
    console.log(
      `${status} ${card.weekOf}  레코드 ${analyses.length}  언급 ${pct(derivedMention)}/${pct(card.mentionRate)}` +
        `  SoM ${pct(derivedSom)}/${pct(card.shareOfMention)}` +
        `  순위 ${derivedRank.toFixed(2)}/${card.avgRecommendationRank}` +
        `  사실성 ${pct(derivedFact)}/${pct(card.factualityScore)}` +
        `  인용 ${pct(brandOwnedCitationRate)}/${pct(card.brandOwnedCitationRate)}` +
        `  1순위 ${pct(ranking.topRecommendationRate)}`,
    );
    for (const [label, got, want] of bad) {
      console.log(`      ${label}: ${got.toFixed(4)} != ${want}`);
    }
  }

  return failures;
}

async function main() {
  let failures = 0;
  for (const tenant of tenants as TenantConfig[]) {
    failures += await verifyTenant(tenant);
  }

  console.log(failures === 0 ? '\n전체 테넌트·주차 일치' : `\n불일치 ${failures}건`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
