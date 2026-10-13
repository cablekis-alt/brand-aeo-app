/**
 * 판정 응답 JSON 파서(server/jsonParse.ts)가 실제로 나온 응답 모양을 읽는지 확인한다. AI는 부르지 않는다.
 *
 * 왜: Claude 판정 비교(2026-10-13)에서 Sonnet 5.5는 418건 중 17건, Opus 5.5는 4건을 "분류 이유 설명 +
 * ```json 블록"으로 답했다. 예전 파서는 응답 전체만 읽어 이를 null로 돌렸고, 그 응답의 인용·언급이 조용히
 * 빈 값이 됐다. 출력 한도에 걸려 잘린 JSON은 지금처럼 null이어야 한다 — 반쪽 결과를 지어내면 안 된다.
 *
 *   npx tsx scripts/verify-json-parse.ts
 */
import { parseJsonLoose } from '../server/jsonParse'

const checks: [string, boolean][] = []
const same = (label: string, got: unknown, want: unknown) =>
  checks.push([label, JSON.stringify(got) === JSON.stringify(want)])

const citation = { citations: [{ raw: 'https://eiec.kdi.re.kr/x', ownerType: 'third-party-authority', supportsBrandMention: false }] }
const json = JSON.stringify(citation, null, 2)

same('응답 전체가 JSON', parseJsonLoose(json), citation)
same('앞뒤 코드블록', parseJsonLoose('```json\n' + json + '\n```'), citation)
same(
  '설명 문장 + ```json 블록(실측 모양)',
  parseJsonLoose(
    'eiec.kdi.re.kr는 KDI 경제교육·정보센터로 공공기관 도메인이라 third-party-authority로 분류했습니다. 본문은 교보생명을 언급하지 않습니다.\n\n```json\n' +
      json +
      '\n```',
  ),
  citation,
)
same('설명 문장 + 코드블록 없는 JSON', parseJsonLoose('분류 결과입니다.\n' + json + '\n이상입니다.'), citation)
same('문장 속 [참고] 괄호 뒤의 JSON', parseJsonLoose('[참고] 아래가 결과입니다.\n' + json), citation)
same(
  '배열 응답 + 설명 문장',
  parseJsonLoose('검사 결과입니다:\n[{"sentence":"가","verdict":"supported"},{"sentence":"나","verdict":"unsupported"}]'),
  [
    { sentence: '가', verdict: 'supported' },
    { sentence: '나', verdict: 'unsupported' },
  ],
)
same('문자열 안의 괄호', parseJsonLoose('결과: {"note":"값은 {미정}과 [보류]","ok":true}'), { note: '값은 {미정}과 [보류]', ok: true })
same('출력 한도에 걸려 잘린 JSON은 null', parseJsonLoose('```json\n{"citations":[{"raw":"https://a.com","ownerType":"brand-'), null)
same('JSON이 없는 문장은 null', parseJsonLoose('판정할 수 없습니다.'), null)
same('빈 응답은 null', parseJsonLoose(''), null)

let failed = 0
for (const [label, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failed += 1
}
if (failed > 0) {
  console.error(`\n${failed}건 실패`)
  process.exit(1)
}
console.log(`\n모두 통과 (${checks.length}건)`)
