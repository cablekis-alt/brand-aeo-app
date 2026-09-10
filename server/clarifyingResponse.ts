/**
 * "되묻는 응답" 판별 — 답을 내놓지 않고 사용자에게 정보를 되묻는 응답인지.
 *
 * 왜 필요한가: 엔진이 "어느 지역을 찾고 계신가요?"처럼 되물으면 브랜드가 언급될 기회 자체가
 * 없었는데, 지금은 그냥 "미언급"으로 집계된다. "브랜드가 안 뽑혔다"와 "질문이 답을 유도하지
 * 못했다"는 진단이 완전히 다르므로 구분해야 한다.
 * (실측: OpenAI가 "성형외과 추천해줘"에 "어느 지역의 성형외과를 찾고 계신가요?"로만 응답.)
 *
 * 판단 LLM에 맡기지 않고 결정적 규칙으로 둔다 — 프롬프트를 건드리면 측정 도구가 흔들려
 * 주차 간 비교가 깨지기 때문이다. 오탐(실제 답변을 버리는 것)이 더 해로우므로 보수적으로 짠다.
 */

/** 사용자에게 정보를 요청하는 표현. */
const ASK_USER =
  /(어느|어떤|무엇을|어디에?서?)\s*[^?？]{0,30}[?？]|찾고\s*계(신가요|세요)|원하시(나요|는지)|알려\s*주(시면|세요)|말씀해\s*주(시면|세요)|구체적으로\s*(알려|말씀)|선호하시(나요|는)|예산은|지역을?\s*(알려|말씀|선택)|could you (please )?(tell|specify|share)|can you (tell|specify|share)|please (specify|provide|let me know)|which (city|area|region|type)|what (kind|type) of/i;

/** 실제 답변이 담고 있기 마련인 열거·목록 신호. */
const HAS_LIST = /(^|\n)\s*(?:[-*•]|\d+[.)]|[①-⑳])\s+/m;

/** 되묻기는 짧다. 이보다 길면 설명형 답변으로 본다. */
const MAX_CLARIFYING_LEN = 400;

/** 첫 문장이 이보다 길면 문장 분리가 실패한 것으로 보고 잘라서 판단한다. */
const FIRST_SENTENCE_CAP = 200;

/** 정규화된 텍스트의 첫 문장. */
function firstSentenceOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const parts = flat.split(/(?<=[.!?。？！])\s+/);
  return (parts[0] ?? flat).slice(0, FIRST_SENTENCE_CAP);
}

export function isClarifyingResponse(rawText: string): boolean {
  const text = (rawText ?? '').trim();
  if (!text) return false; // 빈 응답은 별개 문제(수집 실패)로 다룬다

  // 목록·열거가 있으면 무엇이든 답을 제시한 것으로 본다.
  if (HAS_LIST.test(text)) return false;

  // 길면 설명형 답변이다(끝에 확인 질문이 붙었을 뿐일 수 있다).
  if (text.replace(/\s+/g, ' ').length > MAX_CLARIFYING_LEN) return false;

  // 되묻기는 "첫 문장"이 사용자에게 던지는 질문이다.
  // 답을 먼저 주고 마지막에 확인 질문을 붙인 응답과 구분하는 핵심 조건.
  const first = firstSentenceOf(text);
  if (!/[?？]/.test(first)) return false;
  return ASK_USER.test(first);
}
