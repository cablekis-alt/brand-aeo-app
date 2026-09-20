import type { EeatAnalysis } from './b6-eeat.js';
import type { CitationSourceAnalysis } from './b7-citation-sources.js';
import type { PromptMessage } from './types.js';

/**
 * Brand AEO Score 가중치 — **이 값이 유일한 출처다**.
 *
 * 이름은 Brand AEO Score 하나로 쓴다. 예전 설계 문서와 일부 주석이 같은 값을 AVS라고 불렀고
 * 랭킹 화면 표 머리에도 그 약어가 남아 있었는데, 화면 어디에서도 풀어 쓰지 않아 처음 보는
 * 사람은 뜻을 알 수 없었다. Site AEO Score와 구별해야 하므로 'AEO Score'가 아니라
 * 'Brand AEO Score'가 정식 이름이다.
 *
 *   Mention 0.25 · Share of Mention 0.25 · Citation 0.20 · Position 0.15 · Factuality 0.15 (합 1.0)
 *   · Mention/SoM에는 감성 계수를 곱한다
 *   · EEAT는 점수에 넣지 않고 별도 진단 축으로 둔다
 *   · SoM/순위가 null(경쟁사·추천문맥 없음)이면 그 가중치를 빼고 남은 합으로 재정규화한다
 *
 * 왜 여기(src/prompts)에 두는가 — server와 src가 둘 다 import하는 유일한 지점이기 때문이다.
 * 예전에는 server/scoring.ts와 src/lib/b9-report.ts가 각자 표를 들고 있었고 값이 갈라졌다
 * (보고서는 언급률 35%·인용 10%, 실제 계산은 25%·20%). 손으로 베낀 두 번째 표는 언젠가
 * 반드시 어긋나므로, 값을 복사하지 말고 이 상수를 가져다 쓴다.
 *
 * 키는 WeeklyScorecard의 필드명을 따른다 — 지표와 가중치를 잇는 이름이 하나여야
 * 중간에 손으로 만든 대응표가 끼어들지 않는다.
 */
export const AEO_SCORE_WEIGHTS = {
  mentionRate: 0.25,
  shareOfMention: 0.25,
  brandOwnedCitationRate: 0.2,
  avgRecommendationRank: 0.15,
  factualityScore: 0.15,
} as const;

/**
 * 추천 순위(1=최상위)를 0~1로. 점수 계산과 화면 막대가 **같은 함수**를 써야 한다.
 *
 * 순위는 낮을수록 좋고 비율이 아니라서, 화면이 따로 계산하면 "6.4위"에 긴 막대를 그리는
 * 식으로 점수와 반대되는 그림이 나온다. 가중치 표가 갈라졌던 것과 같은 종류의 사고다.
 */
export function normalizeRank(rank: number, maxRank = 5): number {
  return Math.max(0, (maxRank - rank + 1) / maxRank);
}

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
  cohortRank: {
    position: number;
    totalTenants: number;
    /** 이 순위를 공유하는 브랜드 수(자신 포함). 1이면 단독. 경쟁 랭킹이라 동점 뒤 번호는 건너뛴다. */
    tiedCount?: number;
    /**
     * 이 순위를 매길 때 비교한 브랜드와 그 점수.
     *
     * 순위 숫자만 남기면 "무엇과 비교한 순위인지"가 지워진다. 주차마다 측정한 경쟁사가 달라
     * (실측: 성형외과·서울 강남이 W36 7개 → W37 5개) 순위만으로는 주차 간 비교가 성립하지 않는다.
     * 두 주에 모두 있는 브랜드끼리만 비교하려면 이 목록이 필요하다(src/lib/alerts.ts).
     * v0.1.44 이전 카드엔 없어 선택 필드다.
     */
    members?: { tenantId: string; aeoScore: number }[];
  };
  hallucinationFlags: string[]; // B5-D contradicted 주장 요약
  enginesUsed?: string[]; // 실제로 응답을 수집한 엔진(성공 호출 기준). 구버전 스코어카드엔 없을 수 있어 선택.
  // 이 주차를 판정한 엔진('gemini'|'claude'|'openai'|'mock'). 판단 엔진이 바뀌면 같은 응답에서
  // 다른 판정이 나오므로, 주차 간 점수 비교가 유효한지 확인하려면 이 값이 필요하다.
  // v0.1.38 이전 스코어카드엔 없어 선택 필드다(= 기록 없음, 사실상 Gemini 고정 시기).
  judgeEngine?: string;
  /**
   * 이 주차를 측정한 질문 은행 버전('v1'|'v2'…).
   *
   * 질문이 달라지면 언급률·SoM의 모집단이 달라져 같은 브랜드라도 값이 움직인다.
   * 버전을 기록하지 않으면 "점수가 떨어진 게 브랜드 때문인지 질문이 바뀐 탓인지"를
   * 사후에 구분할 수 없다 — 가중치 표를 바꿨을 때 87점이 73점으로 보였던 것과 같은 사고다.
   * v0.1.49 이전 카드엔 없어 선택 필드다(= 기록 없음, 12문항 × 3회 · v1 시기).
   */
  questionBankVersion?: string;
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
- 업종·지역 코호트 순위: ${(card.cohortRank.tiedCount ?? 1) > 1 ? '공동 ' : ''}${card.cohortRank.position} / ${card.cohortRank.totalTenants}
- 사실성 위반 사례: ${card.hallucinationFlags.join(' / ') || '없음'}${eeatLines}${citationLines}`;

  return { system, user };
}
