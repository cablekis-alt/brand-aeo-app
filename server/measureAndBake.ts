import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { appendTenant, loadTenants } from './config.js';
import { inferCompetitors } from './brandInference.js';
import { runWeeklyPipeline } from './pipeline.js';
import { normalizeTenantDraft } from './tenantRegistry.js';
import { blobStoreEnabled, readOverlay, writeOverlay } from './tenantOverlay.js';
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

/** 도메인 없는 경쟁사용 안정 ID — 이름(한글 등 비ASCII 포함) 해시. */
function slugFromName(name: string): string {
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return 'comp-' + h.toString(36);
}

/** 본 테넌트의 경쟁사를 cohortOnly 테넌트 초안으로 변환한다 — 코호트 랭킹 분모용.
 *  도메인이 있으면 도메인 slug, 없으면 이름 해시로 안정 ID를 만든다(도메인 없는 업종=펜션 등 지원). */
function cohortOnlyDraftsFrom(tenant: TenantConfig): TenantConfig[] {
  const seen = new Set<string>([tenant.tenantId]);
  const out: TenantConfig[] = [];
  for (const competitor of tenant.competitors) {
    if (!competitor.name) continue;
    const domain = competitor.domains?.[0];
    const id = domain ? slugFromDomain(domain) : slugFromName(competitor.name);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(
      normalizeTenantDraft({
        tenantId: id,
        brandName: competitor.name,
        aliases: competitor.aliases?.length ? competitor.aliases : [competitor.name],
        ownedDomains: domain ? [domain] : [], // 도메인 없으면 빈 배열 — brandOwnedCitation만 null 처리됨
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
  // 본 브랜드(경쟁사 측정용 cohortOnly가 아닌)일 때만 경쟁사 자동 추론·코호트 측정을 한다.
  // Vercel 서버리스 리전은 한국어 브랜드 회상에 헛소리를 내므로 이 함수는 Vercel에서 실행되지 않는다.
  if (!tenant.cohortOnly) {
    // 1) 경쟁사가 비어 있으면 CI 러너·로컬(=LLM 정상)에서 자동 추론해 채운다.
    if (!tenant.competitors?.length) {
      const inferred = await inferCompetitors(tenant.brandName, tenant.industry, tenant.region).catch(() => []);
      if (inferred.length) {
        tenant = normalizeTenantDraft({
          ...tenant,
          competitors: inferred.map((c) => ({ name: c.name, domains: c.domain ? [c.domain] : [] })),
        });
        console.log(`[measureAndBake] ${tenant.tenantId} 경쟁사 자동 추론: ${inferred.map((c) => c.name).join(', ')}`);

        // 추론된 경쟁사를 즉시 오버레이에 반영 → 배포 사이트(등록 폼)가 긴 측정 파이프라인 전에 경쟁사를 볼 수 있다.
        if (blobStoreEnabled()) {
          try {
            const overlay = await readOverlay();
            const idx = overlay.findIndex((item) => item.tenantId === tenant.tenantId);
            if (idx >= 0) overlay[idx] = tenant;
            else overlay.push(tenant);
            await writeOverlay(overlay);
            console.log(`[measureAndBake] ${tenant.tenantId} 경쟁사 오버레이 조기 반영 완료`);
          } catch (err) {
            console.error(`[measureAndBake] 오버레이 조기 반영 실패: ${err instanceof Error ? err.message : err}`);
          }
        }
      }
    }

    // 2) 경쟁사(추론됐든 직접 입력했든, 도메인 있는 것)를 코호트로 함께 측정 → 본 브랜드 스코어카드의 코호트 순위(1/N)가 채워진다.
    //    본 브랜드보다 "먼저" 측정해 같은 주차 코호트에 포함시킨다. cohortOnly 초안이라 재귀로 더 퍼지지 않는다.
    //    이미 존재하는 테넌트는 건너뛰므로, 재측정 시엔 빠진 경쟁사만 다시 채워진다(self-healing). autoCohort=false면 생략.
    if (tenant.autoCohort !== false && tenant.competitors?.length) {
      const existingIds = new Set((await loadTenants()).map((item) => item.tenantId));
      const cohortDrafts = cohortOnlyDraftsFrom(tenant)
        .filter((draft) => !existingIds.has(draft.tenantId))
        .slice(0, MAX_AUTO_COHORT);
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
