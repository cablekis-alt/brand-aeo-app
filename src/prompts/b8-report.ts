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
 *   Mention 25 : Citation 20 : Position 15 — 이 비율을 합 1로 맞춘 값이다
 *   (41.7% · 33.3% · 25.0%).
 *   · Mention에는 감성 계수를 곱한다
 *   · EEAT·사실성·Share of Mention은 점수에 넣지 않고 별도 진단 축으로 둔다
 *   · 추천 순위는 순위가 매겨진 응답 수만큼 비중을 늘려 반영한다(rankWeightFactor) — 0건이면 빼고
 *     남은 합으로 재정규화한다
 *
 * 왜 여기(src/prompts)에 두는가 — server와 src가 둘 다 import하는 유일한 지점이기 때문이다.
 * 예전에는 server/scoring.ts와 src/lib/b9-report.ts가 각자 표를 들고 있었고 값이 갈라졌다
 * (보고서는 언급률 35%·인용 10%, 실제 계산은 25%·20%). 손으로 베낀 두 번째 표는 언젠가
 * 반드시 어긋나므로, 값을 복사하지 말고 이 상수를 가져다 쓴다.
 *
 * 키는 WeeklyScorecard의 필드명을 따른다 — 지표와 가중치를 잇는 이름이 하나여야
 * 중간에 손으로 만든 대응표가 끼어들지 않는다.
 *
 * 사실성(원래 0.15)은 2026-09-30에 뺐다. 사실성은 브랜드의 팩트 그래프와 대조해야 잴 수 있는데,
 * 팩트 그래프는 사실상 우리 고객에게만 있다. 판정이 0건이면 100%로 채워, 측정 브랜드 139곳 중
 * 119곳이 한 번도 재지 않은 지표에서 만점을 받았고, 팩트 그래프를 등록한 브랜드만 깎일 수 있었다.
 * 채우지 않고 빼기만 하면(재정규화) 반대로 팩트 그래프가 있는 브랜드만 사실성을 가져 코호트에서
 * 유리해진다(펜션 W40 스테이,머뭄 5위 → 2위). 코호트 안에서 같은 조건으로 잴 수 없는 지표라
 * 점수에서 빼고 정확도로 따로 보여준다.
 *
 * Share of Mention(원래 25)은 2026-10-02에 같은 이유로 뺐다. SoM은 그 브랜드에 등록한 경쟁사 목록이
 * 있어야 잴 수 있는데, 경쟁사 목록은 우리 고객에게만 있고 비교용으로만 재는 브랜드(cohortOnly)에는
 * 없다. 재정규화로 빼면 고객만 SoM을 가져 코호트 순위가 기운다 — 실측 W40 성동구 정형외과에서 옥수 본은
 * 공유 질문지 일반 질문 언급 5/66으로 왕십리본(9/66)보다 적었는데, SoM 25%가 더해져 10점 1위가 됐다
 * (SoM을 빼면 4점). 경쟁사 목록도 브랜드마다 달라, 둘 다 SoM이 있어도 같은 조건의 값이 아니다.
 * 점수에서 빼고 점유율로 따로 보여준다.
 */
const WEIGHT_RATIO = {
  mentionRate: 25,
  brandOwnedCitationRate: 20,
  avgRecommendationRank: 15,
} as const;
const WEIGHT_TOTAL = Object.values(WEIGHT_RATIO).reduce((sum, w) => sum + w, 0);
export const AEO_SCORE_WEIGHTS = {
  mentionRate: WEIGHT_RATIO.mentionRate / WEIGHT_TOTAL,
  brandOwnedCitationRate: WEIGHT_RATIO.brandOwnedCitationRate / WEIGHT_TOTAL,
  avgRecommendationRank: WEIGHT_RATIO.avgRecommendationRank / WEIGHT_TOTAL,
} as const;

/**
 * SoM 최소 표본 — 자사·경쟁사 언급을 합쳐 이 횟수에 못 미치면 SoM을 판정하지 않는다(판정 불가로 표시).
 * SoM은 2026-10-02부터 점수에 들어가지 않는다(AEO_SCORE_WEIGHTS 주석). 아래 실측은 그 전, SoM이 점수에
 * 들어가던 때의 일이다.
 *
 * 왜 필요한가. SoM은 횟수 비율이라 표본이 작으면 한두 번에 크게 흔들린다(SoM 50%에서 6번이면 ±20%p,
 * 10번이면 ±16%p). 실측 2026-W40 강남 성형외과는 네 곳 모두 언급 6~8번으로 SoM이 정해져, 바노바기가
 * 자사 4번 대 경쟁사 2번(66.7%)으로 31점 1위가 됐다 — 그중 약 20점이 SoM 몫이었다. 씨어스 W37은
 * 8번 모두 자사라 SoM 100%로 42점이었다.
 *
 * 10번인 이유. 설치본 SoM 카드 59장 중 4~9번 구간이 10장, 10~19번은 4장뿐이다 — 10번은 소표본 무리를
 * 통째로 넘는 자리라 순위가 "언급 한 번 차이"로 갈리는 일이 적다(7번이면 강남 W40에서 7번인 더스완만
 * SoM이 남아 1위가 된다). 20번으로 올리면 "경쟁사 16번 · 자사 0번"처럼 정보가 있는 값까지 버린다.
 */
export const MIN_SOM_MENTIONS = 10;

/**
 * 추천 순위가 전체 비중(25%)으로 들어가는 순위 응답 수. 그보다 적으면 응답 수만큼만 반영한다.
 *
 * 전에는 3건 미만이면 순위를 통째로 빼고(재정규화) 3건부터 전체 비중으로 넣었다. 응답 한 건 차이로
 * 점수가 15점 넘게 뛰었다 — 실측 W40 디에이 치과는 순위 응답이 4건 → 2건이 되자 33 → 16점이 됐다.
 * 응답 1건이 1위였는지만으로 만점을 주지 않으려던 원래 뜻은 살리면서, 경계를 없앤다.
 * 0건이면 여전히 빼고 재정규화한다 — 재지 않은 값을 채우지 않는다.
 *
 * 6건인 이유(2026-10-03, 설치본 카드 251장·이웃 주차 90쌍 재계산). 3건 경계를 넘나든 주의 점수 변화가
 * 평균 20.4점 → 12.6점(6건)으로 줄었다. 10건이면 10.0점이지만 순위 응답 10건 이상 카드가 8장뿐이라
 * 거의 모든 브랜드에서 순위가 점수에 거의 들어가지 않는다(0건 137 · 1~2건 57 · 3~5건 34 · 6~9건 15).
 */
export const RANK_FULL_WEIGHT_RESPONSES = 6;

/** 추천 순위 비중 계수(0~1). 순위가 없으면 0, 응답 수를 모르는 옛 카드는(당시 3건 이상만 있었다) 1. */
export function rankWeightFactor(rankedResponses: number | undefined, avgRank: number | null): number {
  if (avgRank === null) return 0;
  if (rankedResponses === undefined) return 1;
  return Math.min(1, Math.max(0, rankedResponses) / RANK_FULL_WEIGHT_RESPONSES);
}

type SomFields = Pick<WeeklyScorecard, 'shareOfMention' | 'shareOfMentionMentions'>;

/** 표본 미달로 SoM이 빠진 주면 그 언급 횟수, 아니면 null. */
export function shareOfMentionShortSample(card: SomFields): number | null {
  const n = card.shareOfMentionMentions;
  return card.shareOfMention === null && typeof n === 'number' && n > 0 && n < MIN_SOM_MENTIONS ? n : null;
}

/** SoM이 null일 때 그 이유 — 화면·리포트가 같은 말을 쓰게 한곳에 둔다. 값이 있으면 null. */
export function shareOfMentionNote(card: SomFields): string | null {
  if (card.shareOfMention !== null) return null;
  const n = shareOfMentionShortSample(card);
  if (n !== null) return `자사·경쟁사 언급이 ${n}번뿐이라(${MIN_SOM_MENTIONS}번 미만) 판정 불가`;
  return '경쟁사 미설정 또는 해당 질문에 언급 없음 — 측정 불가';
}

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
  // 경쟁사가 없거나, 자사·경쟁사 언급이 MIN_SOM_MENTIONS번 미만이면 측정 불가(null).
  shareOfMention: number | null;
  // SoM 표본 — 그 모집단의 자사 + 경쟁사 언급 횟수. 경쟁사가 있던 주에만 있다(없으면 undefined).
  // 재계산 스크립트가 "경쟁사가 있었나"를 SoM 값이 아니라 이걸로 판단한다 — 표본이 적어 SoM이
  // null이 된 주를 "경쟁사 없음"으로 굳히지 않게. 옛 카드에는 없다.
  shareOfMentionMentions?: number;
  avgRecommendationRank: number | null;
  /**
   * 추천 순위가 매겨진 응답 수(브랜드 이름 없는 질문). 순위 비중을 정한다(rankWeightFactor).
   * 기록 이전 카드엔 없다 — 그때는 3건 이상일 때만 순위가 있었으므로 전체 비중으로 본다.
   */
  rankedResponses?: number;
  // supported / (supported+contradicted). 사실 판정이 0건이면 측정 불가(null) — 팩트 그래프가 없는
  // 브랜드는 늘 그렇다. Brand AEO Score에는 들어가지 않는 정확도 지표다(AEO_SCORE_WEIGHTS 주석).
  factualityScore: number | null;
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
  /*
   * 그 주차에 실제로 쓴 모델 — 엔진 id → 모델명. 기록 이전 카드엔 없다.
   *
   * 엔진이 같아도 모델이 다르면 같은 질문에 다른 답이 온다. 화면은 엔진이 달라졌을 때
   * "비교 불가"를 말해 왔는데 모델 변경은 아무도 몰라 더 위험했다.
   */
  modelsUsed?: Record<string, string>;
  /** 판정 모델. 판정이 바뀌면 언급·인용·사실성 판정이 통째로 달라진다. */
  judgeModel?: string;
  /**
   * 이 주차를 측정한 질문 은행 버전('v1'|'v2'…).
   *
   * 질문이 달라지면 언급률·SoM의 모집단이 달라져 같은 브랜드라도 값이 움직인다.
   * 버전을 기록하지 않으면 "점수가 떨어진 게 브랜드 때문인지 질문이 바뀐 탓인지"를
   * 사후에 구분할 수 없다 — 가중치 표를 바꿨을 때 87점이 73점으로 보였던 것과 같은 사고다.
   * v0.1.49 이전 카드엔 없어 선택 필드다(= 기록 없음, 12문항 × 3회 · v1 시기).
   */
  questionBankVersion?: string;
  /**
   * 질문당 반복 횟수(같은 질문을 엔진마다 몇 번 물었나). 판정 기록의 가장 큰 반복 번호에서 낸다.
   *
   * 반복 횟수가 다르면 같은 질문지·엔진이어도 응답 수가 달라 흔들림 폭이 다르다 — 실측 W40 강남
   * 세브란스는 옛 설정(12문항×3회)의 반복 3이 남아 36문항×3회=324호출로 쟀고 코호트는 108호출이었다.
   * 기록 이전 카드엔 없어 선택 필드다(재계산 스크립트가 판정 기록에서 채운다).
   */
  repeatsPerQuestion?: number;
}

/**
 * B8 — 스코어카드를 사람이 읽는 리포트로 요약.
 * 점수 자체(가중합, MA4, CI)는 결정적 계산이며 이 프롬프트의 입력으로 이미 확정되어 들어온다.
 * 모델은 새로운 수치를 만들어내지 말고, 주어진 수치만 해석해야 한다.
 *
 * 코호트 순위는 넣지 않는다. 리포트는 측정 중에 쓰이는데 순위는 코호트 전원이 저장된 뒤
 * reconcileCohortRanks(server/cohortRank.ts)에서 확정된다 — 넣으면 본문에 그 순간의 틀린
 * 분모가 박제된다(실측 2026-W39 통신: 세종텔레콤 "6 / 5", 다섯 곳 중 네 곳이 실제와 달랐다).
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
- Share of Mention (언급률과 같은 카테고리 무관 질문 응답 기준, Brand AEO Score에 포함되지 않음): ${shareOfMentionNote(card) ?? `${((card.shareOfMention ?? 0) * 100).toFixed(1)}%`}
- 평균 추천 순위: ${card.avgRecommendationRank === null ? '순위 판정 불가' : `${card.avgRecommendationRank}${card.rankedResponses !== undefined ? ` (순위 응답 ${card.rankedResponses}건 · 비중 ${Math.round(rankWeightFactor(card.rankedResponses, card.avgRecommendationRank) * 100)}%)` : ''}`}
- 사실성(정확도, Brand AEO Score에 포함되지 않음): ${card.factualityScore === null ? '팩트 그래프 없음 또는 대조할 사실 없음 — 측정 불가' : `${(card.factualityScore * 100).toFixed(1)}%`}
- 브랜드 소유 출처 인용률: ${(card.brandOwnedCitationRate * 100).toFixed(1)}%
- 사실성 위반 사례: ${card.hallucinationFlags.join(' / ') || '없음'}${eeatLines}${citationLines}`;

  return { system, user };
}
