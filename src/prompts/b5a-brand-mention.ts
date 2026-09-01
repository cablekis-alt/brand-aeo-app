import type { BrandContext, PromptMessage } from './types';

/**
 * B5-A — 브랜드 언급 탐지.
 * 판정용 LLM은 4개 수집 엔진과 분리된 별도의 "심판" 모델(고정, 예: 하나의 강한 모델)을 쓰는 것을 권장한다.
 * 그래야 분석 단계 자체의 변동성이 주간 지표에 섞이지 않는다.
 */
export function buildBrandMentionPrompt(brand: BrandContext, responseText: string): PromptMessage {
  const competitorList = brand.competitors
    .map((c) => `- ${c.name} (별칭: ${c.aliases.join(', ') || '없음'})`)
    .join('\n');

  const system = `당신은 텍스트에서 브랜드 언급을 정확히 탐지하는 분석기입니다. 추측하거나 확장 해석하지 마세요.

측정 대상 브랜드: ${brand.brandName}
대상 브랜드 별칭/표기 변형: ${brand.aliases.join(', ') || '없음'}

경쟁사 목록:
${competitorList || '없음'}

규칙:
1. 대상 브랜드나 별칭이 명확히 지칭될 때만 "언급"으로 판정한다. 브랜드명과 철자가 같은 일반 단어(동음이의어)는
   문맥상 실제로 그 브랜드를 가리킬 때만 카운트한다.
2. 각 언급에 대해 등장 순서(mentionOrder), 해당 문장 원문(sentence), 어조(sentiment: positive/neutral/negative)를 판정한다.
   어조는 그 브랜드에 대한 문장의 태도를 기준으로 하며, 응답 전체 톤이 아니다.
3. 경쟁사 언급도 동일한 방식으로 모두 탐지한다 (이후 점유율 계산에 사용됨).
4. 응답에 언급된 브랜드가 하나도 없으면 mentions를 빈 배열로 반환한다. 없는 언급을 지어내지 않는다.

출력 JSON 스키마만 반환 (설명, 마크다운 금지):
{
  "targetBrand": {
    "mentioned": boolean,
    "mentionCount": number,
    "mentions": [
      { "mentionOrder": number, "sentence": string, "sentiment": "positive" | "neutral" | "negative", "matchedAlias": string }
    ]
  },
  "competitorMentions": [
    {
      "name": string,
      "mentionCount": number,
      "mentions": [
        { "mentionOrder": number, "sentence": string, "sentiment": "positive" | "neutral" | "negative" }
      ]
    }
  ]
}`;

  const user = `분석할 응답 본문:
"""
${responseText}
"""`;

  return { system, user };
}
