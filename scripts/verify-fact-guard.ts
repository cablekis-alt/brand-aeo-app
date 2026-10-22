/**
 * 사실 가드(server/factGuard.ts)의 숫자 대조와 함께 빼기(keepSentences)를 확인한다. AI는 부르지 않는다.
 *
 * 왜: 「1박 2일 일정이라면 …」의 1을 「인원 추가 요금: 1인당 20,000원」의 1과 같은 숫자로 보고 문장을 뺐고, 그 문장에 기대던
 * 「그다음 그곳과 가까운 지역에서 …」가 혼자 남은 채 블로그에 올라갔다(2026-10-21 스테이,머뭄 글). 숫자는 단위까지 견주고,
 * 빠진 문장에 기대던 문장은 함께 뺀다. 요약 · 격상을 막던 기존 규칙은 그대로여야 한다.
 *
 *   npx tsx scripts/verify-fact-guard.ts
 */
import { createFactGuard, keepSentences } from '../server/factGuard'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

const NOW = '2026-10-22T00:00:00.000Z'
const facts = [
  { id: 'f1', type: 'other' as const, claim: '인원 추가 요금', value: '1인당 20,000원', updatedAt: NOW },
  { id: 'f2', type: 'other' as const, claim: '기준 인원', value: '2명', updatedAt: NOW },
  { id: 'f3', type: 'location' as const, claim: '히로쓰 가옥과의 거리', value: '13m', updatedAt: NOW },
  { id: 'f4', type: 'other' as const, claim: '건축', value: '1920년대 일본식 가옥', updatedAt: NOW },
]
const QUESTION = ['군산 1박 2일 코스로 묵기 좋은 독채 펜션 추천해줘']
const pass = (sentence: string, questions = QUESTION) => createFactGuard(facts, questions).guardSentence(sentence)

// 1) 숫자는 단위까지 — 질문에 같은 「숫자+단위」가 있으면 받는다
ok('질문에 있는 「1박 2일」은 받는다(1인당 · 2명과 다른 숫자)', pass('1박 2일 일정이라면 여행의 중심이 될 장소를 하나 정하세요.'))
ok('질문에 없으면 그대로 뺀다', !pass('1박 2일 일정이라면 여행의 중심이 될 장소를 하나 정하세요.', ['군산 독채 펜션 추천해줘']))
ok('같은 「숫자+단위」인데 값을 그대로 담지 않으면 뺀다(1인당)', !pass('1인당 추가 요금을 받는지 확인하세요.'))
ok('값을 그대로 담으면 받는다', pass('추가 인원은 1인당 20,000원입니다.') && pass('기준 인원은 2명입니다.'))
ok('단위가 다른 지어낸 숫자는 뺀다(2만 원 · 13미터 · 1920년에)', !pass('2만 원이면 충분합니다.') && !pass('히로쓰 가옥에서 13미터 거리입니다.') && !pass('1920년에 지어진 집입니다.'))
ok('질문의 숫자를 부분 문자열로 받지 않는다(50인 → 5만 건)', !pass('누적 방문 5만 건을 넘었습니다.', ['50인 규모 행사에 맞는 곳']))
ok('출처 없는 숫자는 뺀다', !pass('체크인은 3시입니다.'))
const warn = createFactGuard(facts, QUESTION, 'warn')
warn.guardSentence('1인당 추가 요금을 받는지 확인하세요.')
ok('편집 경로는 「확인하세요」로 알린다', warn.notes.some((n) => n.includes('값을 그대로 쓰셨는지 확인하세요')))

// 2) 빠진 문장에 기대던 문장은 함께 뺀다
const drop = (bad: Set<string>) => (s: string) => !bad.has(s)
let notes: string[] = []
ok(
  '앞 문장이 빠지면 「그다음 그곳…」도 함께 뺀다',
  keepSentences(['일정이 1박 3일이면 중심 장소를 정하세요.', '그다음 그곳과 가까운 숙소를 고르세요.'], drop(new Set(['일정이 1박 3일이면 중심 장소를 정하세요.'])), notes).length === 0 &&
    notes.length === 1 && notes[0]!.includes('앞 문장이 빠져'),
)
notes = []
ok(
  '「먼저 …」가 남아 있으면 「다음으로 …」는 남긴다',
  keepSentences(['먼저 지도를 받으세요.', '입장료는 9천 원입니다.', '다음으로 해안길을 걸으세요.'], drop(new Set(['입장료는 9천 원입니다.'])), notes).join('|') ===
    '먼저 지도를 받으세요.|다음으로 해안길을 걸으세요.' && notes.length === 0,
)
ok(
  '지시 · 인과(그래서 · 그곳)는 바로 앞 문장이 빠지면 함께 뺀다',
  keepSentences(['정원이 넓습니다.', '30명이 찾습니다.', '그래서 주말에 붐빕니다.'], drop(new Set(['30명이 찾습니다.'])), []).join('|') === '정원이 넓습니다.' &&
    keepSentences(['골목이 조용합니다.', '근처 식당이 7곳입니다.', '그곳은 저녁에 붐빕니다.'], drop(new Set(['근처 식당이 7곳입니다.'])), []).join('|') === '골목이 조용합니다.',
)
ok('빠진 문장이 없으면 그대로', keepSentences(['먼저 고르세요.', '그다음 예약하세요.', '그래서 편합니다.'], () => true, []).length === 3)
ok('빠진 문장 바로 뒤가 아니면 지시어도 남긴다', keepSentences(['30명이 찾습니다.', '정원이 넓습니다.', '그곳에서 쉬세요.'], drop(new Set(['30명이 찾습니다.'])), []).join('|') === '정원이 넓습니다.|그곳에서 쉬세요.')

let failed = 0
for (const [label, passed] of checks) {
  console.log(`${passed ? '✓' : '✗'} ${label}`)
  if (!passed) failed += 1
}
if (failed > 0) {
  console.error(`\n${failed}건 실패`)
  process.exit(1)
}
console.log(`\n모두 통과 (${checks.length}건)`)
