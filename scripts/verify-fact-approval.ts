/**
 * 초안 쓰기 전 사실 채우기의 규칙(src/lib/factApproval.ts)을 확인한다. 화면 · 서버 · AI는 부르지 않는다.
 *
 * 왜: 승인 시트에서 처음부터 체크해 두는 값은 사람이 하나씩 보지 않고 넘길 수 있다. 가격 · 인증 · 의료 업종의 수치는
 * 틀리면 바로 문제가 되므로 처음부터 꺼 두어야 하고, 합칠 때 있던 사실이 사라지거나 같은 사실이 두 번 들어가면 안 된다.
 *
 *   npx tsx scripts/verify-fact-approval.ts
 */
const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

const { mergeApproved, needsFromBrief, preChecked, reconcileHits, unansweredNeeds } = await import('../src/lib/factApproval')

// 1) 브리프의 「확인 필요」 → 찾을 말
ok('「확인 필요:」를 걷는다', JSON.stringify(needsFromBrief(['확인 필요: 객실 기본 요금', '확인필요：취사도구 품목'])) === JSON.stringify(['객실 기본 요금', '취사도구 품목']))
ok('같은 말은 한 번 · 빈 말은 뺀다', JSON.stringify(needsFromBrief(['확인 필요: 주차', '주차', '  ', '확인 필요:'])) === JSON.stringify(['주차']))
ok('12개까지', needsFromBrief(Array.from({ length: 20 }, (_, i) => `항목 ${i}`)).length === 12)

// 2) 처음부터 체크해 둘지
const hit = (type: 'price' | 'spec' | 'date' | 'certification' | 'location' | 'other', value: string) => ({ type, value })
ok('위치 · 기타 · 사양 · 날짜는 체크', preChecked(hit('location', '가상시 1번길 2'), '펜션') && preChecked(hit('other', '체크인 15:00'), '펜션') && preChecked(hit('spec', '객실 2동'), '펜션') && preChecked(hit('date', '2024년 5월'), '펜션'))
ok('가격 · 인증은 끈다', !preChecked(hit('price', '20,000원'), '펜션') && !preChecked(hit('certification', '우수 숙박업소'), '펜션'))
ok('의료 업종은 숫자가 든 값을 끈다', !preChecked(hit('other', '전문의 3명'), '성형외과') && !preChecked(hit('location', '강남구 1번길 2'), '치과'))
ok('의료 업종이라도 숫자 없는 값은 체크', preChecked(hit('other', '야간 진료 가능'), '성형외과'))

// 3) 합치기 — 있던 사실은 그대로, 같은 사실은 한 번
const current = [{ id: 'f1', type: 'location' as const, claim: '주소', value: '가상시 1번길 2', updatedAt: '2026-10-01' }]
const merged = mergeApproved(current, [
  { need: '주소', type: 'location', claim: '주소', value: '가상시 1번길 2', sourceUrl: 'https://v.example/' },
  { need: '체크인', type: 'other', claim: '체크인 시간', value: '15:00', sourceUrl: 'https://v.example/info' },
  { need: '체크인', type: 'other', claim: '체크인 시간', value: '15:00', sourceUrl: 'https://v.example/info' },
])
ok('있던 사실은 그대로 앞에', merged[0] === current[0])
ok('같은 사실은 한 번만 더한다', merged.length === 2 && merged[1]?.claim === '체크인 시간' && merged[1].value === '15:00')
ok('출처 주소를 남긴다(id · 시각은 서버가)', merged[1]?.sourceUrl === 'https://v.example/info' && merged[1].id === '' && merged[1].updatedAt === '')
ok('승인한 것이 없으면 그대로', mergeApproved(current, []).length === 1)

// 4) 지금 브랜드 사실과 맞추기 — 「다시 만들기」는 브리프를 다시 만들지 않아 「확인 필요」가 사실을 넣은 뒤에도 남는다
const graph = [
  { id: 'f-typed', type: 'other' as const, claim: '체크인 시간', value: '14:00', updatedAt: '2026-10-18' },
  { id: 'f-park', type: 'other' as const, claim: '주차 요금', value: '무료', updatedAt: '2026-10-18' },
]
ok('브랜드 사실이 답한 항목은 다시 찾지 않는다(빈칸에 넣은 값은 claimOf(need)로 저장된다)', JSON.stringify(unansweredNeeds(['체크인 시간 — 팩트 그래프에 없음', '체크인시간', '객실 기본 요금'], graph)) === JSON.stringify(['객실 기본 요금']))
const conflict = reconcileHits([{ need: '체크인 가능 시각', type: 'other', claim: '체크인 시간', value: '15:00', sourceUrl: 'https://v.example/' }], graph)
ok('같은 항목에 다른 값이 있으면 지금 값을 붙인다', conflict.length === 1 && conflict[0]?.replaces?.id === 'f-typed' && conflict[0].replaces.value === '14:00')
ok('바꾸는 줄은 처음에 꺼 둔다', !preChecked(conflict[0]!, '펜션'))
ok('need의 항목 이름으로도 같은 항목을 찾는다', reconcileHits([{ need: '체크인 시간', type: 'other', claim: '입실 시각', value: '15:00', sourceUrl: '' }], graph)[0]?.replaces?.id === 'f-typed')
ok('같은 항목 · 같은 값은 뺀다(띄어쓰기만 달라도)', reconcileHits([{ need: '주차', type: 'other', claim: '주차요금', value: '무료', sourceUrl: '' }], graph).length === 0)
ok('항목이 다르면 값이 같아도 남긴다', reconcileHits([{ need: '와이파이', type: 'other', claim: '와이파이', value: '무료', sourceUrl: '' }], graph).length === 1)
ok('찾은 값끼리 같은 것은 한 번', reconcileHits([
  { need: '조식', type: 'other', claim: '조식 시간', value: '08:00', sourceUrl: '' },
  { need: '아침', type: 'other', claim: '조식 시간', value: '08:00', sourceUrl: '' },
], graph).length === 1)
const replaced = mergeApproved(graph, conflict)
ok('바꾸기로 한 값은 그 사실 자리에서 바꾼다 — 한 항목에 값이 둘이 되지 않는다', replaced.length === 2 && replaced[0]?.id === 'f-typed' && replaced[0].claim === '체크인 시간' && replaced[0].value === '15:00' && replaced[0].sourceUrl === 'https://v.example/')
ok('바꾸는 사이 그 사실이 지워졌으면 새로 넣는다', mergeApproved([graph[1]!], conflict).map((f) => `${f.claim}:${f.value}`).join(',') === '주차 요금:무료,체크인 시간:15:00')

let failed = 0
for (const [label, pass] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${label}`)
  if (!pass) failed += 1
}
if (failed > 0) {
  console.error(`\n${failed}건 실패`)
  process.exit(1)
}
console.log(`\n모두 통과 (${checks.length}건)`)
