/**
 * 한국어 조사 선택.
 *
 * 화면 문구에 도메인과 한글 라벨이 섞여 들어오면서 "네이버 블로그을(를)"이 나왔다. 도메인일
 * 때는 받침을 알 수 없어 "을(를)"로 두는 게 맞지만, 한글로 끝나면 정확히 고를 수 있다.
 *
 * 한글 음절은 U+AC00부터 28개 종성 주기로 배열돼 있다 — (코드 − 0xAC00) % 28 이 0이면 받침이 없다.
 * 한글이 아닌 글자로 끝나면(reddit.com, agoda.com) 판정하지 않고 병기형을 그대로 쓴다.
 */
function finalJongseong(word: string): number | null {
  const ch = word.trim().at(-1)
  if (!ch) return null
  const code = ch.charCodeAt(0)
  if (code < 0xac00 || code > 0xd7a3) return null
  return (code - 0xac00) % 28
}

function particle(word: string, withBatchim: string, withoutBatchim: string, unknown: string): string {
  const jong = finalJongseong(word)
  if (jong === null) return `${word}${unknown}`
  return `${word}${jong === 0 ? withoutBatchim : withBatchim}`
}

/** 목적격 — 티스토리를 / reddit.com을(를) */
export function objectParticle(word: string): string {
  return particle(word, '을', '를', '을(를)')
}

/** 주격 — 티스토리가 / reddit.com이(가) */
export function subjectParticle(word: string): string {
  return particle(word, '이', '가', '이(가)')
}
