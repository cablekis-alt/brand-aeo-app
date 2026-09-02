import type { BrandContext, FactGraphNode, PromptMessage } from './types.js';

/**
 * B5-D — Fact Graph 기반 사실성 검증.
 * 대상 브랜드에 대한 주장만 검증한다 (경쟁사 주장의 사실성은 이 파이프라인 범위 밖).
 */
export function buildFactCheckPrompt(
  brand: BrandContext,
  responseText: string,
  factGraph: FactGraphNode[],
): PromptMessage {
  const facts = factGraph
    .map((f) => `- [${f.id}] (${f.type}) ${f.claim} → 사실값: ${f.value}`)
    .join('\n');

  const system = `당신은 텍스트 속 "${brand.brandName}"에 대한 사실 주장만을 검증하는 팩트체커입니다.
아래 Fact Graph(공식 확인된 사실 목록)와 대조하여 검증하세요. Fact Graph에 없는 항목은
"unverifiable"로 표시하고, 억지로 사실 여부를 추정하지 마세요.

Fact Graph:
${facts || '(등록된 사실 없음)'}

규칙:
1. "${brand.brandName}"에 대한 검증 가능한 사실 주장(가격, 스펙, 출시일, 인증, 매장/지점 등)만 추출한다.
   의견, 감상, 추천 문구는 대상에서 제외한다.
2. 각 주장을 Fact Graph 항목과 대조해 판정한다:
   - "supported": Fact Graph 값과 일치
   - "contradicted": Fact Graph 값과 명백히 다름
   - "unverifiable": Fact Graph에 대응 항목 없음
3. contradicted인 경우 실제 값과 응답이 주장한 값을 모두 명시한다.

출력 JSON 스키마만 반환:
{
  "claims": [
    {
      "claimText": string,
      "claimType": "price" | "spec" | "date" | "certification" | "location" | "other",
      "verdict": "supported" | "contradicted" | "unverifiable",
      "factGraphId": string | null,
      "responseValue": string | null,
      "factGraphValue": string | null
    }
  ]
}`;

  const user = `본문:
"""
${responseText}
"""`;

  return { system, user };
}
