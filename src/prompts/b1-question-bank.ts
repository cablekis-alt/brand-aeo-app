import type { PromptMessage } from './types';

export interface QuestionBankRequest {
  industry: string;
  region: string;
  brandName: string;
  competitorNames: string[];
  count: number; // 예: 100
  version: string; // 예: '2026-09-01' — 버저닝 기준
  previousVersionDiffNote?: string; // 이전 버전 대비 변경 사유(있으면 회귀분석에 사용)
}

/**
 * B1 — 질문 프롬프트 빌더.
 * 카테고리 무관(브랜드명 미언급) 질문 비중을 강제해 "프롬프트하지 않아도 언급되는가"를 측정한다.
 */
export function buildQuestionBankPrompt(req: QuestionBankRequest): PromptMessage {
  const { industry, region, brandName, competitorNames, count, version } = req;

  const system = `당신은 AEO(Answer Engine Optimization) 리서치 설계자입니다.
목표는 실제 소비자가 ChatGPT/Perplexity 같은 AI 검색·비서 서비스에 입력할 법한 "자연스러운" 질문 은행을 만드는 것입니다.
이 질문들은 이후 4개 LLM 엔진에 그대로 입력되어, 특정 브랜드가 "요청받지 않아도" 얼마나 자연스럽게 언급되는지를 측정하는 데 쓰입니다.

반드시 지켜야 할 규칙:
1. 전체 질문의 60% 이상은 브랜드명을 전혀 포함하지 않는 카테고리 질문이어야 한다 (category-agnostic).
   예: "${industry} 추천해줘", "${region}에서 ${industry} 살 때 뭘 봐야 해?"
2. 나머지는 브랜드 직접 언급(brand-direct), 비교(comparison), 가격/스펙(price-spec),
   후기/문제해결(troubleshooting-review), 지역 특화(local-regional)로 고르게 분배한다.
3. 질문 문체는 실제 사용자 입력처럼 구어체, 오탈자 없는 자연스러운 한국어로 작성한다. 설문 문항 같은 딱딱한 문체 금지.
4. 특정 브랜드에 유리하거나 불리하게 유도하는 질문(답을 암시하는 질문)은 금지한다.
5. 같은 의도의 질문을 표현만 바꿔 중복 생성하지 않는다 (의도 다양성 확보).
6. 출력은 아래 JSON 스키마를 따르는 배열만 반환한다. 설명, 마크다운, 코드블록 금지.

JSON 스키마 (배열의 각 원소):
{
  "questionId": string,        // "${version}-{순번3자리}"
  "text": string,
  "category": "category-agnostic" | "brand-direct" | "comparison" | "price-spec" | "troubleshooting-review" | "local-regional",
  "containsBrandName": boolean
}`;

  const user = `업종: ${industry}
지역: ${region}
측정 대상 브랜드: ${brandName}
주요 경쟁사: ${competitorNames.join(', ')}
버저닝 태그: ${version}
${req.previousVersionDiffNote ? `이전 버전 대비 참고사항: ${req.previousVersionDiffNote}` : ''}

위 조건에 맞는 질문 ${count}개를 생성하라.`;

  return { system, user };
}
