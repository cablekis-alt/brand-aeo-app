import { buildAnswerEvidence, type AnswerEvidence } from '../src/lib/answerEvidence.js';
import { sameConditionWeeks } from '../src/lib/reviewReport.js';
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

export async function buildArticleEvidence(
  store: FileResultStore,
  tenant: TenantConfig,
  questionIds: string[],
  weekOf?: string,
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
    competitorNames: (tenant.competitors ?? []).flatMap((c) => [c.name, ...(c.aliases ?? [])]).filter(Boolean),
    card,
    sameConditionWeeks: sameConditionWeeks(history, card).length,
    industry: tenant.industry,
    builtAt: new Date().toISOString(),
  });
}
