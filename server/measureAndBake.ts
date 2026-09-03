import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { appendTenant, loadTenants } from './config.js';
import { inferCompetitors } from './brandInference.js';
import { runWeeklyPipeline } from './pipeline.js';
import { normalizeTenantDraft } from './tenantRegistry.js';
import type { FileResultStore } from './store.js';
import type { TenantConfig } from './types.js';

const SEED_LIVE: Record<string, { bank: string; an: string }> = {
  'example-brand': { bank: 'src/data/live-question-bank.json', an: 'src/data/live-question-analyses.json' },
  'stay-meomum': { bank: 'src/data/live-stay-question-bank.json', an: 'src/data/live-stay-question-analyses.json' },
};

export interface MeasureBakeResult {
  ok: true;
  tenantId: string;
  brandName: string;
  weekOf: string;
  aeoScore: number;
}

// 자동 추론된 경쟁사를 코호트로 함께 측정할 때 최대 개수(측정량·시간 제한).
const MAX_AUTO_COHORT = 5;

function slugFromDomain(domain: string): string {
  const label = domain.split('.')[0] || 'brand';
  return label.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'brand';
}

/** 본 테넌트의 (도메인 있는) 경쟁사를 cohortOnly 테넌트 초안으로 변환한다 — 코호트 랭킹 분모용. */
function cohortOnlyDraftsFrom(tenant: TenantConfig): TenantConfig[] {
  const seen = new Set<string>([tenant.tenantId]);
  const out: TenantConfig[] = [];
  for (const competitor of tenant.competitors) {
    const domain = competitor.domains?.[0];
    if (!domain) continue; // 도메인 없으면 안정적 tenantId를 못 만든다(이름은 SoM에만 쓰임).
    const id = slugFromDomain(domain);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(
      normalizeTenantDraft({
        tenantId: id,
        brandName: competitor.name,
        aliases: competitor.aliases?.length ? competitor.aliases : [competitor.name],
        ownedDomains: [domain],
        industry: tenant.industry,
        region: tenant.region,
        engines: tenant.engines,
        questionBankSize: tenant.questionBankSize,
        questionBankVersion: tenant.questionBankVersion,
        repeatsPerQuestion: tenant.repeatsPerQuestion,
        competitors: [],
        factGraph: [],
        cohortOnly: true,
      }),
    );
  }
  return out;
}

/** 한 테넌트를 측정한 뒤 배포용 src/data에 baking한다. GitHub Actions·로컬 단건 측정이 같이 쓴다. */
export async function measureAndBake(tenant: TenantConfig, store: FileResultStore): Promise<MeasureBakeResult> {
  // 경쟁사가 비어 있으면 여기(CI 러너·로컬 = LLM이 정상 동작하는 환경)에서 자동 추론해 채운다.
  // Vercel 서버리스 리전은 한국어 브랜드 회상에 헛소리를 내므로 이 함수는 Vercel에서 실행되지 않는다.
  if (!tenant.competitors?.length && !tenant.cohortOnly) {
    const inferred = await inferCompetitors(tenant.brandName, tenant.industry, tenant.region).catch(() => []);
    if (inferred.length) {
      tenant = normalizeTenantDraft({
        ...tenant,
        competitors: inferred.map((c) => ({ name: c.name, domains: c.domain ? [c.domain] : [] })),
      });
      console.log(`[measureAndBake] ${tenant.tenantId} 경쟁사 자동 추론: ${inferred.map((c) => c.name).join(', ')}`);

      // 경쟁사도 코호트로 함께 측정 → 본 브랜드 스코어카드에서 코호트 순위(1/N)가 채워진다.
      // 본 브랜드보다 "먼저" 측정해 같은 주차 코호트에 포함시킨다. cohortOnly 초안이라 재귀로 더 퍼지지 않는다.
      // 이미 존재하는 테넌트(직접 등록한 브랜드 등)는 데이터를 덮어쓰지 않도록 건너뛴다.
      // autoCohort=false(등록 시 "경쟁사도 코호트로 함께 측정" 해제)면 코호트 측정을 건너뛴다.
      const existingIds = new Set((await loadTenants()).map((item) => item.tenantId));
      const wantCohort = tenant.autoCohort !== false;
      const cohortDrafts = wantCohort
        ? cohortOnlyDraftsFrom(tenant)
            .filter((draft) => !existingIds.has(draft.tenantId))
            .slice(0, MAX_AUTO_COHORT)
        : [];
      for (const draft of cohortDrafts) {
        try {
          console.log(`[measureAndBake] 코호트 경쟁사 측정 ▶ ${draft.brandName} (${draft.tenantId})`);
          await measureAndBake(draft, store);
        } catch (err) {
          console.error(
            `[measureAndBake] 코호트 경쟁사 측정 실패 ${draft.tenantId}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }
  }

  const inConfig = (await loadTenants()).some((item) => item.tenantId === tenant.tenantId);
  if (!inConfig) await appendTenant(tenant);

  const { scorecard } = await runWeeklyPipeline(tenant, store);
  const weekOf = scorecard.weekOf;
  const id = tenant.tenantId;
  const seed = SEED_LIVE[id];
  if (seed) {
    writeFileSync(seed.bank, readFileSync(`data/${id}/question-bank/${tenant.questionBankVersion}.json`, 'utf8'));
    const analyses = JSON.parse(readFileSync(`data/${id}/${weekOf}/question-analyses.json`, 'utf8')) as unknown;
    writeFileSync(seed.an, JSON.stringify({ tenantId: id, weekOf, analyses }, null, 2) + '\n');
    execSync('npx tsx scripts/rescore-all.ts', { stdio: 'inherit' });
  } else {
    execSync(`npx tsx scripts/publish-tenant.ts ${id}`, { stdio: 'inherit' });
  }

  return {
    ok: true,
    tenantId: id,
    brandName: tenant.brandName,
    weekOf,
    aeoScore: scorecard.aeoScore.current,
  };
}
