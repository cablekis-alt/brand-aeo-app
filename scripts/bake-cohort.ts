/**
 * 브랜드(기존 baked) + cohortOnly 경쟁사(data/ 실측) 스코어카드를 모아 demo-scorecards.json에 반영하고,
 * 모든 테넌트의 코호트 순위(cohortRank)를 최신 코호트 기준으로 재계산한다.
 *   npx tsx scripts/bake-cohort.ts
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { computeCohortRank } from '../server/scoring';
import type { WeeklyScorecard } from '../src/prompts/b8-report';
import { loadTenants } from '../server/config';

const CARDS_PATH = 'src/data/demo-scorecards.json';

async function main() {
  const tenants = await loadTenants();
  const existing = JSON.parse(readFileSync(CARDS_PATH, 'utf8')) as WeeklyScorecard[];

  // 1) 브랜드 스코어카드는 기존 baked 것을 유지, 경쟁사는 data/에서 실측을 읽어 합친다.
  const collected: WeeklyScorecard[] = [];
  for (const tenant of tenants) {
    const fromData = `data/${tenant.tenantId}/scorecard-history.json`;
    if (tenant.cohortOnly && existsSync(fromData)) {
      const hist = JSON.parse(readFileSync(fromData, 'utf8')) as WeeklyScorecard[];
      collected.push(...hist);
    } else {
      const prev = existing.filter((c) => c.tenantId === tenant.tenantId);
      if (prev.length) collected.push(...prev);
      else if (existsSync(fromData)) {
        collected.push(...(JSON.parse(readFileSync(fromData, 'utf8')) as WeeklyScorecard[]));
      }
    }
  }

  // 2) 모든 스코어카드의 cohortRank를 같은 업종·지역·주차 그룹 기준으로 재계산.
  for (const card of collected) {
    const group = collected.filter(
      (c) => c.industry === card.industry && c.region === card.region && c.weekOf === card.weekOf,
    );
    card.cohortRank = computeCohortRank(card.aeoScore.current, group);
  }

  writeFileSync(CARDS_PATH, JSON.stringify(collected, null, 2) + '\n');

  // 3) 코호트별 순위 출력.
  const byCohort = new Map<string, WeeklyScorecard[]>();
  for (const c of collected) {
    const key = `${c.industry} · ${c.region} · ${c.weekOf}`;
    byCohort.set(key, [...(byCohort.get(key) ?? []), c]);
  }
  for (const [key, cards] of byCohort) {
    console.log(`\n[${key}] ${cards.length}개`);
    for (const c of [...cards].sort((a, b) => b.aeoScore.current - a.aeoScore.current)) {
      console.log(
        `  ${c.cohortRank.position}/${c.cohortRank.totalTenants}  Score ${String(c.aeoScore.current).padStart(3)}  ${c.brandName}`,
      );
    }
  }
  console.log(`\n총 ${collected.length}개 스코어카드 반영`);
}

void main();
