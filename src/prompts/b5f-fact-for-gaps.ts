import type { FactGraphNode, PromptMessage } from './types';

/**
 * 초안의 빈칸 → 브랜드 페이지에서 그 값 찾기.
 *
 * b5e(사실 추출)와 다른 점은 **묻는 방향**이다. b5e는 "이 페이지에 뭐가 있나"를 묻고,
 * 이쪽은 "이 값이 이 페이지에 있나"를 묻는다. 초안이 비워 둔 자리마다 필요한 것이 이미
 * 적혀 있으므로(need), 그것을 그대로 질문으로 쓴다.
 *
 * 없으면 없다고 해야 한다. 여기서 지어내면 빈칸을 남긴 의미가 사라진다 — 빈칸은 정직함의
 * 표시이지 채우기 귀찮은 자리가 아니다.
 */
export function buildFactForGapsPrompt(
  brandName: string,
  industry: string,
  needs: string[],
  pageText: string,
): PromptMessage {
  const system = `당신은 페이지 본문에서 **요청받은 값만** 찾아내는 조회기입니다.

각 질문에 대해:
- 페이지 본문에 답이 **명시되어 있으면** value에 그 값을 **글자 그대로** 옮깁니다.
- 명시되어 있지 않으면 value를 null로 둡니다. **추정·계산·상식으로 채우지 마세요.**

value 규칙:
- 페이지에 있는 문자열 그대로. 다듬거나 반올림하거나 단위를 바꾸지 마세요.
- 문장이 아니라 **구(句)**여야 합니다. "체크인은 15시부터입니다" → "15:00"
- 값만 넣습니다. 항목 이름을 붙이지 마세요.

claim은 그 값이 무엇인지 짧은 명사구로 씁니다("체크인 시각", "1박 요금").
type은 price·spec·date·certification·location·other 중 하나입니다.

출력은 JSON 배열만. 질문 순서대로, 질문 수만큼. 설명·마크다운 금지.
[{ "need": string, "found": boolean, "type": string, "claim": string, "value": string|null }]`;

  const user = `브랜드: ${brandName}${industry ? ` (${industry})` : ''}

찾을 것:
${needs.map((n, i) => `${i + 1}. ${n}`).join('\n')}

페이지 본문:
"""
${pageText}
"""`;
  return { system, user };
}

export interface GapFactHit {
  need: string;
  type: FactGraphNode['type'];
  claim: string;
  value: string;
  sourceUrl: string;
}
