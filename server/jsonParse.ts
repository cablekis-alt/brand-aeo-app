/** LLM이 코드블록으로 감싸 응답하는 경우까지 허용하는 관대한 JSON 파서. 실패 시 null 반환(호출부에서 재시도/스킵 처리). */
export function parseJsonLoose<T>(text: string): T | null {
  const stripped = text
    .trim()
    .replace(/^```(json)?/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    return JSON.parse(stripped) as T;
  } catch {
    return null;
  }
}
