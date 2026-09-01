/**
 * 데모 판정 데이터가 demo-scorecards.json의 주간 지표를 실제로 재현하는지 확인한다.
 * 화면(S-02/04/06)이 이 레코드를 다시 집계하므로, 어긋나면 대시보드 수치와 상세 화면이 불일치한다.
 *
 *   npx tsx scripts/verify-demo-data.ts
 */
import { demoQuestionAnalyses, demoQuestionBank, demoScorecardHistory } from '../server/demoData';
import { DemoResultStore } from '../server/demoStore';
import { getRankingView } from '../server/queries';
import tenants from '../server/tenants.config.json';
import type { TenantConfig } from '../server/types';

const TOLERANCE = 0.02;

function pct(value: number | null): string {
  return value === null ? '판정불가' : `${(value * 100).toFixed(1)}%`;
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
    // SoM은 횟수 기준(Share of Voice): 내 언급 총합 / (내 + 경쟁사 언급) 총합.
    const brandMentions = analyses.reduce((s, a) => s + a.mentionSentences.length, 0);
    const compMentions = analyses.reduce(
      (s, a) => s + a.competitorMentions.reduce((t, c) => t + c.mentionCount, 0),
      0,
    );
    const derivedSom = brandMentions + compMentions > 0 ? brandMentions / (brandMentions + compMentions) : 0;
    const ranks = analyses.map((a) => a.brandRank).filter((r): r is number => r !== null);
    const derivedRank = mean(ranks);
    const supported = analyses.reduce((s, a) => s + a.factualitySupported, 0);
    const contradicted = analyses.reduce((s, a) => s + a.factualityContradicted, 0);
    const derivedFact = supported + contradicted > 0 ? supported / (supported + contradicted) : 1;
    // 브랜드 소유 출처는 "인용 단위"(전체 인용 중 자사 도메인 비중, S-05와 동일)로 통일됐다.
    const totalCitations = analyses.reduce((s, a) => s + a.citations.length, 0);
    const brandOwnedCitations = analyses.reduce(
      (s, a) => s + a.citations.filter((c) => c.ownerType === 'brand-owned').length,
      0,
    );
    const brandOwnedCitationRate = totalCitations > 0 ? brandOwnedCitations / totalCitations : 0;
    const ranking = await getRankingView(store, tenant, card.weekOf);

    const checks: [string, number, number][] = [
      ['언급률', derivedMention, card.mentionRate],
      ['사실성', derivedFact, card.factualityScore],
      ['인용', brandOwnedCitationRate, card.brandOwnedCitationRate],
    ];
    // SoM은 경쟁사가 없으면 스코어카드에서 null이다. 그 경우 검증 대상에서 제외한다.
    if (card.shareOfMention !== null) {
      checks.push(['SoM', derivedSom, card.shareOfMention]);
    }

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
  // cohortOnly 경쟁사는 상세 화면(S-02/05/07)이 없고 코호트 랭킹에 스코어카드만 쓰이므로
  // 스코어카드↔분석 정합성 검증 대상에서 제외한다.
  for (const tenant of (tenants as TenantConfig[]).filter((t) => !t.cohortOnly)) {
    failures += await verifyTenant(tenant);
  }

  console.log(failures === 0 ? '\n전체 테넌트·주차 일치' : `\n불일치 ${failures}건`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
