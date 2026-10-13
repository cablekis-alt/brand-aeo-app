/**
 * LLM 응답에서 JSON을 꺼내는 관대한 파서. 실패하면 null(호출부에서 재시도/스킵 처리).
 *
 * 읽는 순서:
 *  1. 응답 전체(앞뒤 코드블록 표시는 벗긴다) — 대부분의 응답이 여기서 끝난다.
 *  2. 본문 중간의 ```json 코드블록 — 설명 문장을 먼저 쓰고 JSON을 뒤에 붙인 응답.
 *  3. 처음 나오는 { 또는 [ 부터 짝이 되는 마지막 } 또는 ] 까지 — 코드블록 없이 앞뒤에 문장이 붙은 응답.
 *
 * 2·3은 Claude 판정 비교(2026-10-13, 교보생명 W40 응답 108건)에서 나왔다. Sonnet 5.5는 판정 418건 중
 * 17건, Opus 5.5는 4건을 "분류 이유 설명 + ```json 블록"으로 답했고, 1만 읽던 예전 파서는 이를 null로
 * 돌려 그 응답의 인용·언급이 조용히 빈 값이 됐다.
 */
export function parseJsonLoose<T>(text: string): T | null {
  const stripped = text
    .trim()
    .replace(/^```(json)?/i, '')
    .replace(/```$/, '')
    .trim();
  const whole = tryParse<T>(stripped);
  if (whole !== null) return whole;

  for (const block of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const parsed = tryParse<T>(block[1].trim());
    if (parsed !== null) return parsed;
  }

  // 문장 속 괄호(「[참고]」 등)에 걸리지 않게, 여는 괄호 후보를 앞에서부터 차례로 시도한다.
  let tried = 0;
  for (let i = 0; i < text.length && tried < 20; i++) {
    const open = text[i];
    if (open !== '{' && open !== '[') continue;
    tried += 1;
    const end = text.lastIndexOf(open === '{' ? '}' : ']');
    if (end <= i) continue;
    const parsed = tryParse<T>(text.slice(i, end + 1));
    if (parsed !== null) return parsed;
  }
  return null;
}

function tryParse<T>(candidate: string): T | null {
  if (!candidate) return null;
  try {
    return JSON.parse(candidate) as T;
  } catch {
    // 이 후보는 JSON이 아니다 — 다음 후보를 본다(전부 실패하면 parseJsonLoose가 null).
    return null;
  }
}
