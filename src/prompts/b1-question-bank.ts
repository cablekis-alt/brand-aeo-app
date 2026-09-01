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
/** 전체 count 중 category-agnostic이 최소 60%가 되도록 한 개수. */
export function agnosticQuota(count: number): number {
  return Math.max(1, Math.ceil(count * 0.6));
}

export function buildQuestionBankPrompt(req: QuestionBankRequest): PromptMessage {
  const { industry, region, brandName, competitorNames, count, version } = req;
  const agnosticCount = agnosticQuota(count);
  const brandedCount = count - agnosticCount;

  const system = `당신은 AEO(Answer Engine Optimization) 리서치 설계자입니다.
목표는 실제 소비자가 ChatGPT/Perplexity 같은 AI 검색·비서 서비스에 입력할 법한 "자연스러운" 질문 은행을 만드는 것입니다.
이 질문들은 이후 4개 LLM 엔진에 그대로 입력되어, 특정 브랜드가 "요청받지 않아도" 얼마나 자연스럽게 언급되는지를 측정하는 데 쓰입니다.

★ 가장 중요한 제약 — 반드시 지켜라:
전체 ${count}개 중 **정확히 ${agnosticCount}개**는 category-agnostic 이어야 한다.
category-agnostic = 브랜드명(${brandName})도, 어떤 경쟁사명도, 특정 업체명도 전혀 포함하지 않는 일반 질문.
   예: "${industry} 추천해줘", "${region}에서 ${industry} 고를 때 뭘 봐야 해?", "${industry} 후기 좋은 곳 알려줘"
이것이 이 측정의 핵심이다("이름을 대지 않아도 브랜드가 등장하는가"). 이 개수를 못 맞추면 측정 자체가 무의미하다.
나머지 **${brandedCount}개**만 아래 브랜드/특정 지목 카테고리로 배분한다.

그 밖의 규칙:
1. 나머지 ${brandedCount}개는 brand-direct(브랜드 직접), comparison(비교), price-spec(가격/스펙),
   troubleshooting-review(후기/문제해결), local-regional(지역 특화)로 고르게 분배한다.
   — brand-direct/comparison에는 브랜드명이나 경쟁사명이 들어가도 된다.
2. category-agnostic 질문에는 어떤 상호·브랜드명도 절대 넣지 마라(containsBrandName=false).
3. 질문 문체는 실제 사용자 입력처럼 구어체, 오탈자 없는 자연스러운 한국어로 작성한다. 설문 문항 같은 딱딱한 문체 금지.
4. 특정 브랜드에 유리하거나 불리하게 유도하는 질문(답을 암시하는 질문)은 금지한다.
5. 같은 의도의 질문을 표현만 바꿔 중복 생성하지 않는다 (의도 다양성 확보).
6. 출력 전에 category가 "category-agnostic"인 원소가 정확히 ${agnosticCount}개인지 직접 세어 확인하라.
7. 출력은 아래 JSON 스키마를 따르는 배열만 반환한다. 설명, 마크다운, 코드블록 금지.

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
