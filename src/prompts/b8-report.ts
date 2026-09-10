import type { EeatAnalysis } from './b6-eeat.js';
import type { CitationSourceAnalysis } from './b7-citation-sources.js';
import type { PromptMessage } from './types.js';

export interface WeeklyScorecard {
  tenantId: string;
  weekOf: string;
  industry: string;
  region: string;
  brandName: string;
  aeoScore: { current: number; ma4: number; previousWeek: number; ciLow: number; ciHigh: number };
  mentionRate: number; // category-agnostic 질문 중 언급 비율
  // 언급률과 같은 모집단(category-agnostic 질문)에서 낸 횟수 기준 점유율.
  // 경쟁사가 없거나 그 모집단에 아무 언급도 없으면 측정 불가(null).
  shareOfMention: number | null;
  avgRecommendationRank: number | null;
  factualityScore: number; // supported / (supported+contradicted)
  brandOwnedCitationRate: number;
  cohortRank: { position: number; totalTenants: number };
  hallucinationFlags: string[]; // B5-D contradicted 주장 요약
  enginesUsed?: string[]; // 실제로 응답을 수집한 엔진(성공 호출 기준). 구버전 스코어카드엔 없을 수 있어 선택.
  // 이 주차를 판정한 엔진('gemini'|'claude'|'openai'|'mock'). 판단 엔진이 바뀌면 같은 응답에서
  // 다른 판정이 나오므로, 주차 간 점수 비교가 유효한지 확인하려면 이 값이 필요하다.
  // v0.1.38 이전 스코어카드엔 없어 선택 필드다(= 기록 없음, 사실상 Gemini 고정 시기).
  judgeEngine?: string;
}

/**
 * B8 — 스코어카드를 사람이 읽는 리포트로 요약.
 * 점수 자체(가중합, MA4, CI, 코호트 랭킹)는 결정적 계산이며 이 프롬프트의 입력으로 이미 확정되어 들어온다.
 * 모델은 새로운 수치를 만들어내지 말고, 주어진 수치만 해석해야 한다.
 */
export function buildWeeklyReportPrompt(
  card: WeeklyScorecard,
  extras?: { eeat?: EeatAnalysis; citationSources?: CitationSourceAnalysis },
): PromptMessage {
  const system = `당신은 브랜드 AEO(답변엔진 최적화) 주간 리포트를 작성하는 애널리스트입니다.
아래에 제공되는 수치 외의 어떤 숫자도 새로 만들어내지 마세요. 수치는 주어진 그대로 인용하세요.
신뢰구간이 넓다면(변동성이 크면) 그 사실을 반드시 언급하세요. 1회성 변동을 과잉 해석하지 마세요.

출력 형식(마크다운):
## 요약
## 세부 지표 (언급률 / 인용 품질 / 추천 순위 / 사실성)
## EEAT (경험 / 전문성 / 권위 / 신뢰)
## AI 인용출처
## 리스크 (사실성 오류, 언급률 급락 등)
## 다음 주 액션 제안`;

  const eeatLines = extras?.eeat
    ? `
- EEAT 종합: ${(extras.eeat.overall * 100).toFixed(1)}%
- Experience: ${(extras.eeat.experience.score * 100).toFixed(1)}%
- Expertise: ${(extras.eeat.expertise.score * 100).toFixed(1)}%
- Authoritativeness: ${(extras.eeat.authoritativeness.score * 100).toFixed(1)}%
- Trustworthiness: ${(extras.eeat.trustworthiness.score * 100).toFixed(1)}%`
    : '';

  const citationLines = extras?.citationSources
    ? `
- 인용 ${extras.citationSources.totalCitations}건 / 고유 URL ${extras.citationSources.uniqueUrls} / 고유 도메인 ${extras.citationSources.uniqueDomains}
- 고품질 출처 비율: ${(extras.citationSources.qualityRate * 100).toFixed(1)}%
- 출처 구성: ${extras.citationSources.mix.map((row) => `${row.kind} ${row.count}`).join(', ') || '없음'}`
    : '';

  const user = `주간 스코어카드 (${card.weekOf} / ${card.industry} / ${card.region} / ${card.brandName}):
- AEO Score: 이번주 ${card.aeoScore.current} / 4주 이동평균 ${card.aeoScore.ma4} / 전주 ${card.aeoScore.previousWeek} / 95% CI [${card.aeoScore.ciLow}, ${card.aeoScore.ciHigh}]
- 카테고리 무관 질문 언급률: ${(card.mentionRate * 100).toFixed(1)}%
- Share of Mention (언급률과 같은 카테고리 무관 질문 응답 기준): ${card.shareOfMention === null ? '경쟁사 미설정 또는 해당 질문에 언급 없음 — 측정 불가' : `${(card.shareOfMention * 100).toFixed(1)}%`}
- 평균 추천 순위: ${card.avgRecommendationRank ?? '순위 판정 불가'}
- 사실성 점수: ${(card.factualityScore * 100).toFixed(1)}%
- 브랜드 소유 출처 인용률: ${(card.brandOwnedCitationRate * 100).toFixed(1)}%
- 업종·지역 코호트 순위: ${card.cohortRank.position} / ${card.cohortRank.totalTenants}
- 사실성 위반 사례: ${card.hallucinationFlags.join(' / ') || '없음'}${eeatLines}${citationLines}`;

  return { system, user };
}
