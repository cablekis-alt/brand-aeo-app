import { buildAnswerEvidence, isOurName, type AnswerEvidence } from '../src/lib/answerEvidence.js';
import { sameConditionWeeks } from '../src/lib/reviewReport.js';
import { cohortRankingEntities } from './cohortEntities.js';
import { getRawCallsForQuestions } from './rawCallStore.js';
import type { FileResultStore } from './store.js';
import type { TenantConfig } from './types.js';

/**
 * 글의 실측 사례를 저장된 측정 기록에서 만든다(src/lib/answerEvidence.ts). 판정 · 글쓰기 호출이 없다.
 *
 * 파일 스토어만 쓴다 — 화면용 데이터는 측정 기록이 없는 주차를 데모로 바꿔 주는데(index.ts sourceFor), 데모 응답을
 * 「실제로 AI에 물어본 결과」로 글에 실으면 거짓말이 된다. 주차를 주지 않으면 가장 최근 측정을 쓴다.
 */
export const WEEK_OF = /^\d{4}-W\d{2}$/;

/**
 * 우리 글에 싣지 않을 남의 이름 — 등록한 경쟁사, 같은 코호트(업종 · 지역 · 질문 언어) 브랜드와 그들이 등록한 경쟁사,
 * 그리고 그 별칭. 경쟁사 목록이 빈 브랜드가 많아(코호트 비교용) 등록 경쟁사만 보면 「KT 하이오더와 티오더는 …」처럼
 * 코호트 다른 브랜드 이름이 든 문장이 골라졌다. 우리 이름 · 별칭과 같은 이름은 뺀다(같은 브랜드를 두 번 등록한 경우).
 */
export function evidenceOtherNames(tenant: TenantConfig, runtime: TenantConfig[]): string[] {
  const ourNames = [tenant.brandName, ...(tenant.aliases ?? [])].map((n) => n.trim()).filter(Boolean);
  const ours = { has: (n: string) => isOurName(n, ourNames) };
  const names = new Set(cohortRankingEntities(tenant, runtime));
  for (const t of [tenant, ...runtime]) {
    const self = t.tenantId === tenant.tenantId;
    if (!self && (!names.has(t.brandName.trim()) || ours.has(t.brandName.trim()))) continue;
    if (!self) for (const a of t.aliases ?? []) names.add(a.trim());
    for (const c of t.competitors ?? []) for (const n of [c.name, ...(c.aliases ?? [])]) names.add(n.trim());
  }
  return [...names].filter((n) => n && !ours.has(n));
}

export async function buildArticleEvidence(
  store: FileResultStore,
  tenant: TenantConfig,
  questionIds: string[],
  weekOf: string | undefined,
  /** 등록된 브랜드 전체(loadRuntimeTenants) — 코호트 브랜드 이름을 거르는 데 쓴다. */
  runtime: TenantConfig[],
): Promise<AnswerEvidence> {
  const history = await store.getScorecardHistory(tenant.tenantId, Number.MAX_SAFE_INTEGER);
  const card = weekOf ? history.find((h) => h.weekOf === weekOf) : history.at(-1);
  if (!card) throw new Error(weekOf ? `${weekOf} 측정 기록이 없습니다.` : '아직 측정 기록이 없습니다.');
  const [analyses, bank, raw] = await Promise.all([
    store.getQuestionAnalyses(tenant.tenantId, card.weekOf),
    card.questionBankVersion ? store.getQuestionBank(tenant.tenantId, card.questionBankVersion) : Promise.resolve(null),
    getRawCallsForQuestions(tenant.tenantId, card.weekOf, questionIds),
  ]);
  return buildAnswerEvidence({
    weekOf: card.weekOf,
    questionIds,
    questions: bank?.questions ?? [],
    analyses,
    raw,
    brandName: tenant.brandName,
    aliases: tenant.aliases ?? [],
    competitorNames: evidenceOtherNames(tenant, runtime),
    card,
    sameConditionWeeks: sameConditionWeeks(history, card).length,
    industry: tenant.industry,
    builtAt: new Date().toISOString(),
  });
}
