import { suffixesFor } from './competitorDiscovery.js';
import { industryKey, type IndustryVerdict } from './competitorIndustryStore.js';
import { parseJsonLoose } from './jsonParse.js';
import { buildCompetitorIndustryPrompt } from '../src/prompts/b1e-competitor-industry.js';
import type { EngineClient } from './engines/types.js';
import type { CompetitorContext } from '../src/prompts/types.js';
import type { TenantConfig } from './types.js';

/**
 * 경쟁사 「업종 다름」 확인(경쟁사 편집 5단계, 결정 7) — 경쟁사를 추가하거나 새 이름으로 바꿀 때 한 번 부른다(서랍).
 *
 * 브랜드 추론 함수(brandInference.ts)는 쓰지 않는다 — 한 곳에 6~14번을 부르고, 업종 이름만 돌려줄 뿐 비교하지 않으며, 엔진을 직접
 * 만들어 모의 엔진 설정(USE_MOCK_ENGINES)과 엔진 슬롯을 지나친다. 여기서는 AI 없이 정할 수 있으면 먼저 정하고(업종 접미사 ·
 * 등록 고객 브랜드), 아니면 검색이 붙은 엔진에 한 번 묻는다. 엔진은 부르는 쪽이 넘긴다(시험은 가짜 엔진).
 *
 * 한국 지역 업체를 묻는 판단이라 Vercel 리전에서는 엉뚱한 답이 나온다 — 데스크톱(Express)에서만 돈다.
 */
export interface IndustryCheck {
  verdict: IndustryVerdict;
  looksLike: string | null;
  reason: string | null;
  /** rule: AI 없이 정했다. */
  engine: string;
}

const CALL_TIMEOUT_MS = 30_000;

async function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`업종 확인이 ${ms / 1000}초 안에 끝나지 않았어요`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** AI 없이 정할 수 있는 경우 — 이름이 고객 업종 접미사로 끝나면 같은 업종, 같은 이름의 등록 고객 브랜드면 그 업종으로 비교한다. */
export function industryByRule(customer: TenantConfig, competitor: CompetitorContext, runtime: TenantConfig[]): IndustryCheck | null {
  const names = [competitor.name, ...(competitor.aliases ?? [])].map((n) => n.replace(/\s+/g, ''));
  const { suffixes } = suffixesFor(customer.industry);
  if (names.some((n) => suffixes.some((s) => n.length > s.length && n.endsWith(s)))) {
    return { verdict: 'same', looksLike: customer.industry, reason: '이름이 고객 업종으로 끝나요', engine: 'rule' };
  }
  // 등록된 고객 브랜드의 업종은 사람이 넣은 값이다(경쟁사 초안의 업종은 고객 것을 물려받아 증거가 아니다).
  const keys = new Set([competitor.name, ...(competitor.aliases ?? [])].map(industryKey));
  const registered = runtime.find(
    (t) => !t.cohortOnly && t.tenantId !== customer.tenantId && [t.brandName, ...t.aliases].some((n) => keys.has(industryKey(n))),
  );
  if (registered) {
    const same = industryKey(registered.industry) === industryKey(customer.industry);
    return { verdict: same ? 'same' : 'different', looksLike: registered.industry, reason: `등록된 고객 브랜드(${registered.brandName})의 업종이에요`, engine: 'rule' };
  }
  return null;
}

/**
 * 업종 확인 — 규칙으로 못 정하면 엔진에 한 번 묻는다. 엔진 오류 · 시간 초과는 던진다(부르는 쪽이 「확인 못 함」으로 보이고 저장하지
 * 않는다). 답을 읽을 수 없으면 unsure다.
 */
export async function checkCompetitorIndustry(
  customer: TenantConfig,
  competitor: CompetitorContext,
  deps: { client: EngineClient; engine: string; runtime: TenantConfig[] },
): Promise<IndustryCheck> {
  if (process.env.VERCEL) throw new Error('경쟁사 업종 확인은 데스크톱 앱에서만 할 수 있어요.');
  const rule = industryByRule(customer, competitor, deps.runtime);
  if (rule) return rule;
  const prompt = buildCompetitorIndustryPrompt({
    brandName: customer.brandName,
    industry: customer.industry,
    region: customer.region,
    ...(customer.marketScope ? { marketScope: customer.marketScope } : {}),
    ...(customer.buyer ? { buyer: customer.buyer } : {}),
    competitorName: competitor.name,
    aliases: competitor.aliases ?? [],
    ...(competitor.domains?.[0] ? { domain: competitor.domains[0] } : {}),
  });
  const result = await withTimeout(deps.client.call(prompt), CALL_TIMEOUT_MS);
  const parsed = parseJsonLoose<{ verdict?: unknown; looksLike?: unknown; reason?: unknown }>(result.text);
  const verdict = parsed && (parsed.verdict === 'same' || parsed.verdict === 'different' || parsed.verdict === 'unsure') ? parsed.verdict : 'unsure';
  const short = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, max) : null);
  if (!parsed) console.warn(`[competitorIndustry] ${customer.tenantId} · ${competitor.name}: 응답을 읽지 못해 모름으로 둡니다`);
  return { verdict, looksLike: short(parsed?.looksLike, 20), reason: short(parsed?.reason, 120), engine: result.model ?? deps.engine };
}
