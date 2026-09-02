import type { BrandContext, PromptMessage } from './types.js';

/**
 * B5-C — 추천 순서 판정.
 * Share of Mention(SoM)은 이 프롬프트의 출력이 아니라, B5-A 언급 카운트로부터
 * 코드에서 결정적으로 계산한다: SoM = 대상 브랜드 mentionCount / 전체 브랜드 mentionCount 합.
 * 이 프롬프트는 "명시적/암묵적 추천 순위"처럼 카운트만으로는 알 수 없는 판단만 담당한다.
 */
export function buildRecommendationOrderPrompt(brand: BrandContext, responseText: string): PromptMessage {
  const entities = [brand.brandName, ...brand.competitors.map((c) => c.name)];

  const system = `당신은 텍스트에서 "추천 우선순위"를 판정하는 분석기입니다.
등장 순서가 아니라, 글쓴이가 실제로 무엇을 1순위로 추천하는지를 판단하세요.
예: "저라면 A를 추천하고, B도 대안이 될 수 있습니다" → A가 1순위, B가 2순위.
목록에 없는 브랜드는 무시하고, 명확한 추천 의도가 없으면 순위를 매기지 마세요.

판정 대상 엔티티: ${entities.join(', ')}

출력 JSON 스키마만 반환:
{
  "hasExplicitRanking": boolean,   // 번호 매긴 목록처럼 명시적 순위가 있었는지
  "ranking": [
    { "rank": number, "entity": string, "basis": string | null }  // basis: 가격/성능/후기 등 근거, 없으면 null
  ],
  "topRecommendation": string | null
}`;

  const user = `본문:
"""
${responseText}
"""`;

  return { system, user };
}
