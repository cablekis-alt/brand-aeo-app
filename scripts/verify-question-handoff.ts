/**
 * 경쟁사 편집 4단계 — 질문 넘겨받기 계산(planQuestionHandoff · deriveQuestionBank · checkRewrite)과 서랍이 보내는 힌트
 * (src/lib/competitorEdit.ts handoffHints)를 확인한다.
 * 가짜 은행 · 가짜 이름만 쓰고 AI는 부르지 않는다.
 *
 * 왜: 바뀐 경쟁사 질문만 고쳐 쓰고 나머지는 그대로 둬야 한다. 받는 곳이 틀리면 엉뚱한 경쟁사를 묻고, 나머지 문항이
 * 바뀌면 지난 주와 같은 질문으로 잰 기록이 끊긴다.
 *
 *   npx tsx scripts/verify-question-handoff.ts
 */
import { checkRewrite, deriveQuestionBank, nextBankVersion, planQuestionHandoff, topicMentions, type HandoffInput, type HandoffItem } from '../server/questionHandoff'
import type { QuestionBank } from '../server/store'
import { applyOps, baseItems, handoffHints, type EditOp } from '../src/lib/competitorEdit'
import type { CompetitorContext, QuestionSpec } from '../src/prompts/types'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

const BRAND = ['가상머뭄', '가상,머뭄', '가상시 가상머뭄']
const q = (questionId: string, text: string, extra: Partial<QuestionSpec> = {}): QuestionSpec => ({
  questionId,
  text,
  category: 'comparison',
  stage: 'consider',
  industry: '펜션',
  region: '가상시',
  containsBrandName: true,
  version: questionId.split('-')[0]!,
  ...extra,
})
const c = (name: string, aliases: string[] = [], domains: string[] = []): CompetitorContext => ({ name, aliases: aliases.length ? aliases : [name], domains })

const shared = [
  q('c1-001', '가상시 감성 펜션 추천해줘', { category: 'category-agnostic', containsBrandName: false, cohortShared: true, topic: '감성 숙소' }),
  q('c1-002', '가상시에서 가상 골목집 같은 한옥 숙소 또 있어?', { category: 'category-agnostic', containsBrandName: false, cohortShared: true }),
]
const brandQs = [
  q('v5-001', '가상머뭄 체크인 몇 시야?', { category: 'brand-direct', topic: '입퇴실 시간' }),
  q('v5-004', '가상시 감성 펜션 찾는데 가상머뭄이랑 가상 골목집 중에 어디가 더 나아?', { topic: '골목집과의 비교' }),
  q('v5-005', '가족 여행 숙소로 가상머뭄이랑 초원고택 중 고민 중인데 분위기 차이가 뭐야?', { topic: '초원고택과의 비교' }),
  q('v5-006', '커플 여행 갈 때 가상머뭄이랑 가상 선연 둘 중에 어디를 더 추천해?', { stage: 'decide', topic: '커플 숙소 추천 비교' }),
  q('v5-007', '가상머뭄이랑 가상옥도 부대시설 차이 알려줘', { topic: '가상옥도 시설 비교' }),
]
const bank: QuestionBank = {
  version: 'v5',
  generatedAt: '2026-10-13T00:00:00.000Z',
  questions: [...shared, ...brandQs],
  cohortBank: { key: '펜션__가상시', version: 'c1' },
}
const NOW = [c('가상 골목집'), c('가상옥도', ['가상옥도', '가상 옥도']), c('초원고택'), c('가상 선연'), c('해돋이펜션')]
const CAP = 5
const measuredOf = (list: CompetitorContext[]) => list.map((_, i) => i < CAP)

function run(next: CompetitorContext[], hints: HandoffInput['hints'] = [], over: Partial<HandoffInput> = {}) {
  const now = over.now?.competitors ?? NOW
  return planQuestionHandoff({
    bank,
    version: 'v5',
    brandNames: BRAND,
    backToRepo: false,
    repoVersion: 'v5',
    now: { competitors: now, measured: measuredOf(now) },
    next: { competitors: next, measured: measuredOf(next) },
    hints,
    taken: ['v1', 'v3', 'v4', 'v5'],
    ...over,
  })
}
const itemOf = (plan: ReturnType<typeof run>, id: string) => plan.items.find((i) => i.fromId === id)
const toName = (item: HandoffItem | undefined) => item?.swaps.map((s) => s.to?.name ?? '∅').join(',')

// S1 바꿈 — 들어온 곳이 넘겨받는다. 나머지 문항은 그대로.
const A = c('새펜션A')
const s1 = run([A, ...NOW.slice(1)], [{ from: '가상 골목집', to: '새펜션A' }])
ok('S1 바꿈: derive · v5 → v6', s1.mode === 'derive' && s1.fromVersion === 'v5' && s1.toVersion === 'v6')
ok('S1 바꿈: v5-004 → v6-004 (새펜션A, 힌트)', itemOf(s1, 'v5-004')?.toId === 'v6-004' && toName(itemOf(s1, 'v5-004')) === '새펜션A' && itemOf(s1, 'v5-004')?.reason === 'hint')
ok('S1 바꿈: 고칠 질문은 하나 · 문항 수 그대로', s1.items.length === 1 && s1.sizeBefore === 7 && s1.sizeAfter === 7)
ok('S1 바꿈: 받는 곳 표시', JSON.stringify(s1.receivers) === JSON.stringify([{ name: '새펜션A', ids: ['v6-004'] }]))
ok('S1 바꿈: 이어질 위치는 바꾼 목록의 0번', itemOf(s1, 'v5-004')?.expectedIndexes.join() === '0')
ok('S1 바꿈: 주제에 「골목집」이 있어 주제도 새로 받는다', itemOf(s1, 'v5-004')?.topicNeedsRewrite === true)
ok('S1 바꿈: 공통 질문에 나간 이름이 있어도 건드리지 않는다', !s1.items.some((i) => i.fromId.startsWith('c1-')))

// S2 빼기(대기 없음) — 이미 재는데 비교 질문이 없는 곳(해돋이펜션)이 받는다(결정 E8).
const s2e = run(NOW.slice(1))
ok('S2 빼기: 이미 재는데 질문 없는 해돋이펜션이 v6-004를 받는다(existing)', toName(itemOf(s2e, 'v5-004')) === '해돋이펜션' && itemOf(s2e, 'v5-004')?.reason === 'existing' && s2e.sizeAfter === 7)
ok('S2 빼기(새로 든 곳만 받기 — 고객 전환): 뺀다', itemOf(run(NOW.slice(1), [], { existingReceivers: false }), 'v5-004')?.action === 'remove')
// 받을 곳이 정말 없으면 뺀다 — 질문 없는 해돋이펜션까지 지금 목록에 없는 경우.
const NOQ = NOW.slice(0, 4)
const s2 = run(NOQ.slice(1), [], { now: { competitors: NOQ, measured: measuredOf(NOQ) } })
ok('S2 빼기(받을 곳 없음): v5-004 뺌 · 7 → 6', itemOf(s2, 'v5-004')?.action === 'remove' && itemOf(s2, 'v5-004')?.toId === null && s2.sizeAfter === 6)
ok('S2 빼기: 받을 곳 없음으로 알린다', s2.unreceived.length === 1 && s2.unreceived[0]!.name === '가상 골목집' && s2.unreceived[0]!.reason === 'noReceiver')
// 업종 다름으로 표시된 곳은 받지 않는다 — 그 이유를 알린다.
const s2o = run(NOW.slice(1), [], { otherIndustry: ['해돋이펜션'] })
ok('업종 다름(해돋이펜션)은 받지 않는다 → 뺌 · 이유 otherIndustry', itemOf(s2o, 'v5-004')?.action === 'remove' && s2o.unreceived[0]?.reason === 'otherIndustry' && s2o.unreceived[0]?.other?.join() === '해돋이펜션')
const s1o = run([c('새펜션A'), ...NOW.slice(1)], [{ from: '가상 골목집', to: '새펜션A' }], { otherIndustry: ['새펜션 a'] })
ok('업종 다름인 새 곳 대신 이미 재는 곳이 받는다(이름은 띄어쓰기 · 대소문자 무시)', toName(itemOf(s1o, 'v5-004')) === '해돋이펜션')

// S3 빼기로 대기 첫 줄이 올라옴 — 올라온 곳이 받는다(promoted).
const W = c('대기펜션')
const s3 = run([...NOW.slice(1), W], [], { now: { competitors: [...NOW, W], measured: measuredOf([...NOW, W]) } })
ok('S3 대기에서 올라옴: 대기펜션이 v6-004를 받는다', toName(itemOf(s3, 'v5-004')) === '대기펜션' && itemOf(s3, 'v5-004')?.reason === 'promoted')

// S4 측정에 넣기(swap) — 대기 줄이 측정 줄 자리를 차지하면 그 질문을 받는다.
const s4next = [NOW[0]!, NOW[1]!, NOW[2]!, W, NOW[4]!, NOW[3]!]
const s4 = run(s4next, [{ from: '가상 선연', to: '대기펜션' }], { now: { competitors: [...NOW, W], measured: measuredOf([...NOW, W]) } })
ok('S4 측정에 넣기: v5-006 → v6-006 (대기펜션)', itemOf(s4, 'v5-006')?.toId === 'v6-006' && toName(itemOf(s4, 'v5-006')) === '대기펜션')
ok('S4 측정에 넣기: 대기로 내려간 곳도 나가는 곳이다', s4.items.length === 1)

// S5 두 곳 바꿈
const B = c('새펜션B')
const s5 = run([A, NOW[1]!, B, NOW[3]!, NOW[4]!], [{ from: '가상 골목집', to: '새펜션A' }, { from: '초원고택', to: '새펜션B' }])
ok('S5 두 곳 바꿈: v6-004(A) · v6-005(B)', toName(itemOf(s5, 'v5-004')) === '새펜션A' && toName(itemOf(s5, 'v5-005')) === '새펜션B' && itemOf(s5, 'v5-005')?.toId === 'v6-005')

// S6 추가 · 빼기 · 바꿈 섞기 — 힌트가 있으면 바꾼 곳이 받고, 추가로 올라온 곳은 남은 질문을 받는다.
const s6next = [NOW[1]!, A, NOW[3]!, NOW[4]!, B]
const s6 = run(s6next, [{ from: '초원고택', to: '새펜션A' }])
ok('S6 섞기(힌트): 004 → B(올라옴) · 005 → A(바꿈)', toName(itemOf(s6, 'v5-004')) === '새펜션B' && toName(itemOf(s6, 'v5-005')) === '새펜션A')
const s6n = run(s6next, [])
ok('S6 섞기(힌트 없음): 목록 순서대로 004 → A · 005 → B', toName(itemOf(s6n, 'v5-004')) === '새펜션A' && toName(itemOf(s6n, 'v5-005')) === '새펜션B')
ok('S6 힌트가 다르면 key도 다르다', s6.key !== s6n.key)

// S7 홈페이지만 바꿈 — 이름이 같으면 질문지는 그대로다.
const s7 = run([c('가상 골목집', [], ['golmok.example']), ...NOW.slice(1)])
ok('S7 홈페이지만 바꿈: same · 버전 그대로', s7.mode === 'same' && s7.toVersion === 'v5' && s7.items.length === 0)

// 질문 없는 경쟁사를 뺌
const s8 = run(NOW.slice(0, 4))
ok('질문 없는 경쟁사(해돋이펜션) 빼기: same', s8.mode === 'same' && s8.unreceived.length === 0)

// 경쟁사 둘을 짚은 질문 · 한 경쟁사의 질문 둘
const multiBank: QuestionBank = {
  ...bank,
  questions: [
    ...bank.questions,
    q('v5-008', '가상머뭄, 가상 골목집, 가상옥도 세 곳 1박 가격 비교해 줘', { category: 'price-spec', topic: '1박 가격' }),
    q('v5-009', '가상옥도랑 가상머뭄 중 바비큐 하기 좋은 곳은?', { topic: '바비큐 시설' }),
  ],
}
const m1 = run([A, ...NOW.slice(1)], [{ from: '가상 골목집', to: '새펜션A' }], { bank: multiBank })
const m1i = itemOf(m1, 'v5-008')
ok('경쟁사 둘(받는 곳 있음): 남는 곳(가상옥도)을 keep으로 두고 고쳐 쓴다', m1i?.action === 'rewrite' && m1i.keep.map((k) => k.name).join() === '가상옥도' && m1i.expectedIndexes.join() === '0,1')
ok('경쟁사 둘: 비교가 아닌 종류도 똑같이 다룬다(D2)', m1i?.source.category === 'price-spec')
const m2 = run(NOQ.slice(1), [], { bank: multiBank, now: { competitors: NOQ, measured: measuredOf(NOQ) } })
ok('경쟁사 둘(받는 곳 없음): 질문을 통째로 뺀다(D1)', itemOf(m2, 'v5-008')?.action === 'remove' && m2.sizeAfter === multiBank.questions.length - 2)
const C = c('새펜션C')
const m3 = run([NOW[0]!, C, ...NOW.slice(2)], [{ from: '가상옥도', to: '새펜션C' }], { bank: multiBank })
ok('한 경쟁사의 질문 셋(007 · 008 · 009)은 모두 같은 곳이 받는다', ['v5-007', 'v5-008', 'v5-009'].every((id) => toName(itemOf(m3, id)) === '새펜션C'))
ok('받는 곳 표시에 셋이 모두 든다', m3.receivers[0]?.ids.join() === 'v6-007,v6-008,v6-009')

// 자기 질문이 있는 곳은 받지 않는다(D4) — 이미 재는 해돋이펜션도 자기 질문이 있게 해 받을 곳이 없게 한다.
const ownBank: QuestionBank = {
  ...bank,
  questions: [...bank.questions, q('v5-010', '가상머뭄이랑 대기펜션 중 조용한 곳은?'), q('v5-011', '가상머뭄이랑 해돋이펜션 중 바다 전망은 어디가 나아?')],
}
const o1 = run([...NOW.slice(1), W], [], { bank: ownBank, now: { competitors: [...NOW, W], measured: measuredOf([...NOW, W]) } })
ok('자기 질문 있는 대기펜션은 받지 않는다 → v5-004 뺌', itemOf(o1, 'v5-004')?.action === 'remove')
ok('그 이유(receiverHasOwn)와 그 곳의 질문을 알린다', o1.unreceived[0]?.reason === 'receiverHasOwn' && o1.unreceived[0]?.own?.name === '대기펜션' && o1.unreceived[0]?.own?.questionIds.join() === 'v5-010')
const o2 = run([...NOW.slice(1), W], [{ from: '가상 골목집', to: '대기펜션' }], { bank: ownBank, now: { competitors: [...NOW, W], measured: measuredOf([...NOW, W]) } })
ok('힌트가 있어도 자기 질문 있는 곳은 받지 않는다', itemOf(o2, 'v5-004')?.action === 'remove')

// 받는 곳이 나간 곳의 이름을 품는다(초원 → 초원고택은 다른 곳)
const choBank: QuestionBank = { ...bank, questions: [...shared, q('v5-004', '가상머뭄이랑 초원 중 가족 여행엔 어디가 좋아?', { topic: '초원과의 비교' })] }
const cho = run([c('초원고택'), NOW[1]!], [{ from: '초원', to: '초원고택' }], { bank: choBank, now: { competitors: [c('초원'), NOW[1]!], measured: [true, true] } })
ok('초원 → 초원고택: 넘겨받는다', toName(itemOf(cho, 'v5-004')) === '초원고택')

// 모드 · 버전
ok('저장소 목록으로 돌아감(앱 질문지 v6): repo', run(NOW, [], { version: 'v6', backToRepo: true }).mode === 'repo')
ok('저장소 목록으로 돌아감(이미 저장소 버전): same', run(NOW, [], { backToRepo: true }).mode === 'same')
ok('은행 파일이 없음: fresh', run([A, ...NOW.slice(1)], [], { bank: null }).mode === 'fresh')
ok('버전 v5 → v6', nextBankVersion('v5', []) === 'v6')
ok('v6 파일이 남아 있으면 v7', nextBankVersion('v5', ['v6']) === 'v7' && run([A, ...NOW.slice(1)], [], { taken: ['v5', 'v6'] }).toVersion === 'v7')
ok('en1 → en2', nextBankVersion('en1', ['en1']) === 'en2')
ok('v9 → v10', nextBankVersion('v9', []) === 'v10')
ok('자릿수를 지킨다(2026-09-01 → 2026-09-02)', nextBankVersion('2026-09-01', []) === '2026-09-02')

// key
const k1 = run([A, ...NOW.slice(1)], [{ from: '가상 골목집', to: '새펜션A' }])
ok('key: 같은 입력이면 같다', k1.key === s1.key)
const textBank: QuestionBank = { ...bank, questions: bank.questions.map((x) => (x.questionId === 'v5-004' ? { ...x, text: `${x.text} ` + '정말' } : x)) }
ok('key: 원문이 바뀌면 다르다', run([A, ...NOW.slice(1)], [{ from: '가상 골목집', to: '새펜션A' }], { bank: textBank }).key !== s1.key)
const topicBank: QuestionBank = { ...bank, questions: bank.questions.map((x) => (x.questionId === 'v5-004' ? { ...x, topic: '골목집 비교' } : x)) }
ok('key: 주제가 바뀌면 다르다', run([A, ...NOW.slice(1)], [{ from: '가상 골목집', to: '새펜션A' }], { bank: topicBank }).key !== s1.key)
ok('key: 받는 곳 별칭이 바뀌면 다르다', run([c('새펜션A', ['새펜션A', '새 펜션A']), ...NOW.slice(1)], [{ from: '가상 골목집', to: '새펜션A' }]).key !== s1.key)

// deriveQuestionBank
const derived = deriveQuestionBank(bank, s1, new Map([['v5-004', { text: '가상시 감성 펜션 찾는데 가상머뭄이랑 새펜션A 중에 어디가 더 나아?', topic: '새펜션A와의 비교' }]]), { now: '2026-10-20T00:00:00.000Z', base: 'fp' })
const v6004 = derived.questions.find((x) => x.questionId === 'v6-004')
ok('derive: 버전 · cohortBank · derivedFrom', derived.version === 'v6' && derived.cohortBank?.key === '펜션__가상시' && derived.derivedFrom.version === 'v5' && derived.derivedFrom.replaced[0]?.to === 'v6-004' && derived.derivedFrom.base === 'fp')
ok('derive: 순서 · 나머지 문항 객체 그대로', derived.questions.map((x) => x.questionId).join() === 'c1-001,c1-002,v5-001,v6-004,v5-005,v5-006,v5-007' && derived.questions.every((x, i) => x.questionId === 'v6-004' || x === bank.questions[i]))
ok('derive: 고친 문항 필드(id · version · category · stage · containsBrandName · 주제)', Boolean(v6004 && v6004.version === 'v6' && v6004.category === 'comparison' && v6004.stage === 'consider' && v6004.containsBrandName && v6004.topic === '새펜션A와의 비교' && v6004.industry === '펜션'))
const keepTopic = deriveQuestionBank(bank, s4, new Map([['v5-006', { text: '커플 여행 갈 때 가상머뭄이랑 대기펜션 둘 중에 어디를 더 추천해?', topic: '엉뚱한 주제' }]]), { now: 'x', base: 'fp' })
ok('derive: 주제에 나간 이름이 없으면 원래 주제를 둔다', keepTopic.questions.find((x) => x.questionId === 'v6-006')?.topic === '커플 숙소 추천 비교' && keepTopic.questions.find((x) => x.questionId === 'v6-006')?.stage === 'decide')
const noTopic = deriveQuestionBank(bank, s1, new Map([['v5-004', { text: '가상시 감성 펜션 찾는데 가상머뭄이랑 새펜션A 중에 어디가 더 나아?' }]]), { now: 'x', base: 'fp' })
ok('derive: 새 주제를 못 받으면 비운다(미분류)', noTopic.questions.find((x) => x.questionId === 'v6-004')?.topic === undefined)
const removedBank = deriveQuestionBank(bank, s2, new Map(), { now: 'x', base: 'fp' })
ok('derive(빼기): 6문항 · removed 기록', removedBank.questions.length === 6 && removedBank.derivedFrom.removed.join() === 'v5-004' && !removedBank.questions.some((x) => x.questionId === 'v5-004'))
let threw = false
try {
  deriveQuestionBank(bank, s1, new Map(), { now: 'x', base: 'fp' })
} catch {
  threw = true
}
ok('derive: 고친 문장이 없으면 멈춘다', threw)

// topicMentions
ok('주제: 이름 일부(골목집)를 잡는다', topicMentions('골목집과의 비교', [c('가상 골목집')], BRAND))
ok('주제: 고객 이름에도 있는 낱말(가상)은 보지 않는다', !topicMentions('가상 체험 비교', [c('가상 골목집')], BRAND))
ok('주제: 이름이 없으면 아니다', !topicMentions('커플 숙소 추천 비교', [c('가상 선연')], BRAND))

// checkRewrite R0~R9
const item = itemOf(s1, 'v5-004')!
const next1 = [A, ...NOW.slice(1)]
const ctx = { item, brandNames: BRAND, language: 'ko' as const, next: next1, gone: [NOW[0]!], otherTexts: bank.questions.filter((x) => x.questionId !== 'v5-004').map((x) => x.text) }
const good = '가상시 감성 펜션 찾는데 가상머뭄이랑 새펜션A 중에 어디가 더 나아?'
const cases: [string, unknown, boolean][] = [
  ['좋은 문장', good, true],
  ['띄어쓰기 다른 고객 이름', '가상시 감성 펜션 찾는데 가상 머뭄이랑 새펜션A 중 어디가 더 나아?', true],
  ['별칭 고객 이름', '가상시 감성 펜션 찾는데 가상,머뭄이랑 새펜션A 중 어디가 더 나아?', true],
  ['나간 곳이 남음', '가상머뭄이랑 새펜션A, 가상 골목집 중에 어디가 더 나아?', false],
  ['고객 이름 빠짐', '가상시 감성 펜션 찾는데 새펜션A랑 가상옥도 중에 어디가 더 나아?', false],
  ['다른 경쟁사를 넣음', '가상시 감성 펜션 찾는데 가상머뭄이랑 새펜션A, 초원고택 중에 어디가 더 나아?', false],
  ['받는 곳 이름 없음', '가상시 감성 펜션 찾는데 가상머뭄이랑 다른 곳 중에 어디가 더 나아?', false],
  ['원래 질문과 같음', item.source.text, false],
  ['다른 질문과 같음', bank.questions[2]!.text, false],
  ['한국어 아님', 'Which is better, 가상머뭄 or 새펜션A for a quiet stay?', false],
  ['빈 문장', '   ', false],
  ['문자열 아님', 42, false],
  ['두 줄', '가상머뭄이랑 새펜션A 비교해줘\n그리고 가격도 알려줘', false],
  ['코드 블록', '```가상머뭄이랑 새펜션A 중 어디가 더 나아?```', false],
  ['목록 기호', '- 가상머뭄이랑 새펜션A 중 어디가 더 나아?', false],
  ['너무 짧음', '가상머뭄 새펜션A?', false],
  ['너무 김', `${good} ${'정말 궁금해서 그러는데 자세히 알려줘 '.repeat(5)}`, false],
  ['꼬리표', '가상시 감성 펜션 찾는데 가상머뭄이랑 새펜션A 중에 어디가 더 나아? (영어 질문)', false],
]
for (const [label, text, want] of cases) {
  const r = checkRewrite(text, '새펜션A와의 비교', ctx)
  ok(`checkRewrite ${want ? '통과' : '거절'}: ${label}${r.reasons.length ? ` (${r.reasons.join(' / ')})` : ''}`, (r.reasons.length === 0) === want)
}
ok('checkRewrite: 공백을 하나로 정리한다', checkRewrite(`  ${good.replace(' 중에', '   중에')} `, undefined, ctx).text === good)
ok('checkRewrite R9: 쓸 수 있는 주제는 받는다(공백 · 따옴표 정리)', checkRewrite(good, ' "감성 숙소  비교" ', ctx).topic === '감성 숙소 비교')
ok('checkRewrite R9: 나간 이름이 남은 주제는 비운다', checkRewrite(good, '골목집 대신 새 숙소', ctx).topic === undefined)
ok('checkRewrite R9: 받는 곳 · 고객 이름이 주제가 되면 비운다(isBrandTopic)', checkRewrite(good, '새펜션A와의 비교', ctx).topic === undefined && checkRewrite(good, '가상머뭄 장점', ctx).topic === undefined)
ok('checkRewrite R9: 「미분류」는 주제로 받지 않는다', checkRewrite(good, '미분류', ctx).topic === undefined)
ok('checkRewrite R9: 주제가 없거나 24자를 넘으면 비운다(문장은 통과)', checkRewrite(good, '', ctx).topic === undefined && checkRewrite(good, '가'.repeat(25), ctx).topic === undefined && checkRewrite(good, '가'.repeat(25), ctx).reasons.length === 0)

// 초원 → 초원고택: 새 이름이 옛 이름을 품는다
const choItem = itemOf(cho, 'v5-004')!
const choCtx = { item: choItem, brandNames: BRAND, language: 'ko' as const, next: [c('초원고택'), NOW[1]!], gone: [c('초원')], otherTexts: [] }
ok('checkRewrite: 초원고택은 초원이 남은 것이 아니다', checkRewrite('가상머뭄이랑 초원고택 중 가족 여행엔 어디가 좋아?', undefined, choCtx).reasons.length === 0)
ok('checkRewrite: 초원이 따로 남으면 거절', checkRewrite('가상머뭄이랑 초원, 초원고택 중 가족 여행엔 어디가 좋아?', undefined, choCtx).reasons.length > 0)

// 경쟁사 둘: 남는 곳을 지우면 거절
const multiItem = itemOf(m1, 'v5-008')!
const multiCtx = { item: multiItem, brandNames: BRAND, language: 'ko' as const, next: next1, gone: [NOW[0]!], otherTexts: [] }
ok('checkRewrite(경쟁사 둘): 남는 곳을 둔 문장은 통과', checkRewrite('가상머뭄, 새펜션A, 가상옥도 세 곳 1박 가격 비교해 줘', undefined, multiCtx).reasons.length === 0)
ok('checkRewrite(경쟁사 둘): 남는 곳을 지우면 거절', checkRewrite('가상머뭄이랑 새펜션A 두 곳 1박 가격 비교해 줘', undefined, multiCtx).reasons.length > 0)

// 영어 질문 — 별칭만 남아도 잡는다
const enBank: QuestionBank = {
  version: 'en1',
  generatedAt: 'x',
  questions: [q('en1-005', 'Between Fake Plastic Surgery and Zanobagi, which clinic has a better reputation for rhinoplasty?', { region: '가상구 (영어 질문)', version: 'en1', topic: '코성형 평판' })],
}
const zano = c('Zanobagi Plastic Surgery', ['Zanobagi Plastic Surgery', 'Zanobagi', 'ZANOBAGI', '자노바기성형외과'])
const nova = c('Nova Clinic')
const en = planQuestionHandoff({
  bank: enBank,
  version: 'en1',
  brandNames: ['Fake Plastic Surgery', '가짜성형외과'],
  backToRepo: false,
  repoVersion: 'en1',
  now: { competitors: [zano], measured: [true] },
  next: { competitors: [nova], measured: [true] },
  hints: [{ from: zano.name, to: nova.name }],
  taken: ['en1'],
})
const enCtx = { item: en.items[0]!, brandNames: ['Fake Plastic Surgery', '가짜성형외과'], language: 'en' as const, next: [nova], gone: [zano], otherTexts: [] }
ok('영어: en1 → en2 · en2-005', en.toVersion === 'en2' && en.items[0]?.toId === 'en2-005')
ok('영어: 좋은 문장 통과', checkRewrite('Between Fake Plastic Surgery and Nova Clinic, which clinic has a better reputation for rhinoplasty?', undefined, enCtx).reasons.length === 0)
ok('영어: 나간 곳 별칭(ZANOBAGI)이 남으면 거절', checkRewrite('Is Fake Plastic Surgery or Nova Clinic better than ZANOBAGI for rhinoplasty?', undefined, enCtx).reasons.length > 0)
ok('영어: 한글이 섞이면 거절', checkRewrite('Fake Plastic Surgery랑 Nova Clinic 중 코성형 어디가 나아?', undefined, enCtx).reasons.length > 0)
ok('영어: 주제는 나간 이름이 없어 그대로', en.items[0]?.topicNeedsRewrite === false)

// 고객 이름이 없는 질문지(브랜드 이름이 주소인 고객) — 원래 질문에 없었으면 요구하지 않는다(D10)
const urlBank: QuestionBank = { version: 'v2', generatedAt: 'x', questions: [q('v2-003', '가상시에서 가상 골목집 말고 다른 한옥 펜션 어디 있어?', { topic: '한옥 숙소' })] }
const url = planQuestionHandoff({
  bank: urlBank,
  version: 'v2',
  brandNames: ['fake-brand.example'],
  backToRepo: false,
  repoVersion: 'v2',
  now: { competitors: [NOW[0]!], measured: [true] },
  next: { competitors: [A], measured: [true] },
  hints: [{ from: '가상 골목집', to: '새펜션A' }],
  taken: ['v2'],
})
const urlCtx = { item: url.items[0]!, brandNames: ['fake-brand.example'], language: 'ko' as const, next: [A], gone: [NOW[0]!], otherTexts: [] }
ok('고객 이름 없는 질문: 이름 없이 고쳐도 통과', checkRewrite('가상시에서 새펜션A 말고 다른 한옥 펜션 어디 있어?', undefined, urlCtx).reasons.length === 0)

// 서랍의 힌트 — 바꿈 · 측정에 넣기 · 사슬(바꾼 줄을 다시 바꿈) · 되돌린 작업은 보내지 않는다
const items = baseItems([...NOW, W])
const hintsOf = (ops: EditOp[]) => handoffHints(items, applyOps(items, ops)).map((h) => `${h.from}→${h.to}`).join(',')
ok('힌트: 바꿈', hintsOf([{ id: '1', t: 'replace', key: 'b0', with: A, source: 'typed' }]) === '가상 골목집→새펜션A')
ok('힌트: 대기 줄로 바꿈', hintsOf([{ id: '1', t: 'replace', key: 'b2', from: 'b5' }]) === '초원고택→대기펜션')
ok('힌트: 측정에 넣기(내려간 줄 쪽 힌트는 서버가 쓰지 않는다)', hintsOf([{ id: '1', t: 'swap', a: 'b5', b: 'b3' }]).split(',').includes('가상 선연→대기펜션'))
ok('힌트: 자리를 두 번 바꾸면 원래대로(힌트 없음)', hintsOf([{ id: '1', t: 'swap', a: 'b5', b: 'b3' }, { id: '2', t: 'swap', a: 'b3', b: 'b5' }]) === '')
ok(
  '힌트: 바꾼 줄을 다시 바꾸면 원래 줄에서 마지막 곳으로',
  hintsOf([
    { id: '1', t: 'replace', key: 'b0', with: A, source: 'typed' },
    { id: '2', t: 'replace', key: 'n1', with: C, source: 'typed' },
  ]) === '가상 골목집→새펜션C',
)
ok(
  '힌트: 바꾼 줄을 측정에 넣기로 내리면 원래 줄에서 올라온 곳으로',
  hintsOf([
    { id: '1', t: 'replace', key: 'b0', with: A, source: 'typed' },
    { id: '2', t: 'swap', a: 'b5', b: 'n1' },
  ]).split(',').includes('가상 골목집→대기펜션'),
)
ok('힌트: 빼기 · 추가 · 홈페이지는 힌트가 없다', hintsOf([{ id: '1', t: 'drop', key: 'b0' }, { id: '2', t: 'add', with: B, source: 'typed' }, { id: '3', t: 'homepage', key: 'b1', domains: ['x.example'] }]) === '')

// 검토 지적 — 자리 바꾸기 사슬(대기둘을 엠원 자리에, 대기셋을 대기둘 자리에)과 바꿔 넣은 줄을 다시 자리 바꾸기로 내림
const W2 = c('대기둘')
const W3 = c('대기셋')
const chainNow = [c('엑스'), c('엠원'), c('씨'), c('디'), c('이'), W, W2, W3]
const chainItems = baseItems(chainNow)
const chainHints = (ops: EditOp[]) => handoffHints(chainItems, applyOps(chainItems, ops))
const h4 = chainHints([
  { id: '1', t: 'swap', a: 'b6', b: 'b1' },
  { id: '2', t: 'swap', a: 'b7', b: 'b6' },
  { id: '3', t: 'drop', key: 'b0' },
])
ok('힌트: 자리 바꾸기 사슬은 원래 줄에서 지금 주인으로(엠원 → 대기셋)', h4.some((h) => h.from === '엠원' && h.to === '대기셋'))
const N1 = c('새로운펜션')
const h3ops: EditOp[] = [
  { id: '1', t: 'replace', key: 'b1', with: N1, source: 'typed' },
  { id: '2', t: 'swap', a: 'b6', b: 'n1' },
  { id: '3', t: 'drop', key: 'b0' },
]
const h3 = chainHints(h3ops)
ok('힌트: 바꿔 넣은 줄을 자리 바꾸기로 내리면 원래 줄에서 올라온 곳으로(엠원 → 대기둘)', h3.some((h) => h.from === '엠원' && h.to === '대기둘'))
const chainBank: QuestionBank = { ...bank, questions: [...shared, q('v5-001', '가상머뭄이랑 엑스 중 어디가 나아?'), q('v5-002', '가상머뭄이랑 엠원 중 어디가 조용해?')] }
const chainNext = applyOps(chainItems, h3ops).list.map((x) => x.competitor)
const p3 = planQuestionHandoff({
  bank: chainBank,
  version: 'v5',
  brandNames: BRAND,
  backToRepo: false,
  repoVersion: 'v5',
  now: { competitors: chainNow, measured: measuredOf(chainNow) },
  next: { competitors: chainNext, measured: measuredOf(chainNext) },
  hints: [{ from: '엠원', to: '새로운펜션' }, ...h3],
  taken: ['v5'],
})
ok('서버: 한 자리에 힌트가 여럿이면 쓸 수 있는 나중 힌트(엠원 → 대기둘)', toName(p3.items.find((i) => i.fromId === 'v5-002')) === '대기둘')

// 검토 지적 — 넘겨줄 질문을 들어온 곳의 「자기 질문」으로 세지 않는다
const renameRun = (now: CompetitorContext[], next: CompetitorContext[], questions: QuestionSpec[], hints: HandoffInput['hints']) =>
  planQuestionHandoff({
    bank: { ...bank, questions: [...shared, ...questions] },
    version: 'v5',
    brandNames: BRAND,
    backToRepo: false,
    repoVersion: 'v5',
    now: { competitors: now, measured: now.map(() => true) },
    next: { competitors: next, measured: next.map(() => true) },
    hints,
    taken: ['v5'],
  })
const shorter = renameRun([c('초원고택'), NOW[1]!], [c('초원'), NOW[1]!], [q('v5-004', '가상머뭄이랑 초원고택 중 어디가 좋아?')], [{ from: '초원고택', to: '초원' }])
ok('옛 이름의 일부로 바꿈(초원고택 → 초원): 넘겨받아 고쳐 쓴다', itemOf(shorter, 'v5-004')?.action === 'rewrite' && toName(itemOf(shorter, 'v5-004')) === '초원' && !shorter.unreceived.length)
const aliasRename = renameRun(
  [c('바다별장'), NOW[1]!],
  [c('바다별장 리조트', ['바다별장 리조트', '바다별장']), NOW[1]!],
  [q('v5-004', '가상머뭄이랑 바다별장 중 어디가 좋아?')],
  [{ from: '바다별장', to: '바다별장 리조트' }],
)
ok('옛 이름을 별칭으로 둔 이름 바꾸기: 넘겨받아 고쳐 쓴다', itemOf(aliasRename, 'v5-004')?.action === 'rewrite' && toName(itemOf(aliasRename, 'v5-004')) === '바다별장 리조트')
const caseOnly = renameRun([c('KT'), NOW[1]!], [c('kt'), NOW[1]!], [q('v5-004', '가상머뭄이랑 KT 중 어디가 좋아?')], [{ from: 'KT', to: 'kt' }])
ok('대소문자만 바꿈(KT → kt): 같은 곳 · 질문지 그대로', caseOnly.mode === 'same')
const named2 = planQuestionHandoff({
  bank: { ...bank, questions: [...shared, q('v5-007', '가상머뭄, 가상 골목집, 대기펜션 세 곳 비교해 줘')] },
  version: 'v5',
  brandNames: BRAND,
  backToRepo: false,
  repoVersion: 'v5',
  now: { competitors: [...NOW, W], measured: measuredOf([...NOW, W]) },
  next: { competitors: [...NOW.slice(1), W], measured: measuredOf([...NOW.slice(1), W]) },
  hints: [],
  taken: ['v5'],
})
ok(
  '나가는 곳의 질문이 이미 짚은 곳(대기펜션)은 받지 않는다(자기 자신과 견주게 된다) — 이미 재는 다른 곳이 받는다',
  itemOf(named2, 'v5-007')?.swaps[0]?.via === 'existing' && toName(itemOf(named2, 'v5-007')) !== '대기펜션' && itemOf(named2, 'v5-007')?.keep.map((k) => k.name).join() === '대기펜션',
)
const fkRun = planQuestionHandoff({
  bank: { ...bank, questions: [...shared, q('v5-001', '가상머뭄이랑 가상 골목집 중 어디가 나아?')] },
  version: 'v5',
  brandNames: [...BRAND, 'FK'],
  backToRepo: false,
  repoVersion: 'v5',
  now: { competitors: NOW, measured: measuredOf(NOW) },
  next: { competitors: [c('FKpos'), ...NOW.slice(1)], measured: measuredOf(NOW) },
  hints: [{ from: '가상 골목집', to: 'FKpos' }],
  taken: ['v5'],
})
ok('고객 이름을 품은 곳(FKpos · 고객 별칭 FK)은 받지 않는다 — 질문에서 이어지지 않는다(이미 재는 곳이 받음)', itemOf(fkRun, 'v5-001')?.swaps[0]?.via === 'existing' && toName(itemOf(fkRun, 'v5-001')) !== 'FKpos')

// 검토 지적 — 남는 이름이 나간 이름의 일부일 때(남는 가상초원 · 나가는 가상초원고택) 나간 이름이 남은 문장을 거절한다
const subNow = [c('가상초원'), c('가상초원고택'), NOW[3]!]
const subNext = [c('가상초원'), c('새곳'), NOW[3]!]
const subPlan = renameRun(subNow, subNext, [q('v5-001', '가상머뭄, 가상초원, 가상초원고택 중 어디가 제일 조용해?')], [{ from: '가상초원고택', to: '새곳' }])
const subItem = itemOf(subPlan, 'v5-001')!
const subCtx = { item: subItem, brandNames: BRAND, language: 'ko' as const, next: subNext, gone: [c('가상초원고택')], otherTexts: [] }
ok('남는 이름이 나간 이름의 일부: 고친 문장은 통과', checkRewrite('가상머뭄, 가상초원, 새곳 중 어디가 제일 조용해?', undefined, subCtx).reasons.length === 0)
ok('남는 이름이 나간 이름의 일부: 나간 이름이 남으면 거절', checkRewrite('가상머뭄, 가상초원, 새곳, 가상초원고택 중 어디가 제일 조용해?', undefined, subCtx).reasons.includes('나간 경쟁사 이름이 남았어요'))

// 5단계 검토 지적 — 이미 재는 곳이 받을 때(E8) 질문지에 이름이 아예 없는 곳을 먼저 본다(넘겨줄 질문에 함께 나온 곳은 고쳐 써도 남는다)
const e3Now = [c('가짜골목'), c('가짜옥도'), c('가짜초원'), c('가짜해돋이')]
const e3Next = [c('새가짜A'), c('가짜초원'), c('가짜해돋이')]
const e3 = planQuestionHandoff({
  bank: { ...bank, questions: [...shared, q('v5-001', '가상머뭄, 가짜골목, 가짜초원 세 곳 1박 가격 비교해 줘'), q('v5-002', '가상머뭄이랑 가짜옥도 중 어디가 더 조용해?')] },
  version: 'v5',
  brandNames: BRAND,
  backToRepo: false,
  repoVersion: 'v5',
  now: { competitors: e3Now, measured: measuredOf(e3Now) },
  next: { competitors: e3Next, measured: measuredOf(e3Next) },
  hints: [{ from: '가짜골목', to: '새가짜A' }],
  taken: ['v5'],
})
ok('이미 재는 곳 받기: 이름이 없던 가짜해돋이가 받는다(가짜초원은 v5-001에 남는다)', toName(itemOf(e3, 'v5-002')) === '가짜해돋이' && itemOf(e3, 'v5-001')?.keep.map((k) => k.name).join() === '가짜초원')
ok('이미 재는 곳 받기: 질문 둘 다 고쳐 쓴다', e3.items.every((i) => i.action === 'rewrite') && e3.sizeAfter === e3.sizeBefore)

// 받는 곳을 정했는데 그 질문이 모두 빠지면(함께 짚은 나가는 곳이 받을 곳이 없다) 받는 곳을 돌려줘 다른 질문을 살린다
const e4Now = [c('가짜골목'), c('가짜옥도'), c('가짜선연'), c('가짜초원')]
const e4 = planQuestionHandoff({
  bank: { ...bank, questions: [...shared, q('v5-001', '가상머뭄, 가짜골목, 가짜옥도 세 곳 가격 비교해 줘'), q('v5-002', '가상머뭄이랑 가짜선연 중 어디가 나아?')] },
  version: 'v5',
  brandNames: BRAND,
  backToRepo: false,
  repoVersion: 'v5',
  now: { competitors: e4Now, measured: measuredOf(e4Now) },
  next: { competitors: [c('가짜초원')], measured: [true] },
  hints: [],
  taken: ['v5'],
})
ok('받는 곳 돌려주기: v5-001은 빠지고(가짜옥도 받을 곳 없음) 가짜초원이 v5-002를 받는다', itemOf(e4, 'v5-001')?.action === 'remove' && toName(itemOf(e4, 'v5-002')) === '가짜초원' && e4.sizeAfter === e4.sizeBefore - 1)
ok('받는 곳 돌려주기: 받는 곳 표시는 가짜초원 → v6-002 하나', JSON.stringify(e4.receivers) === JSON.stringify([{ name: '가짜초원', ids: ['v6-002'] }]))
ok('받는 곳 돌려주기: 빠지는 두 곳은 받을 곳 없음으로 남는다', e4.unreceived.map((u) => `${u.name}:${u.reason}`).sort().join() === '가짜골목:noReceiver,가짜옥도:noReceiver')

// 이유가 「들어온 곳에 자기 질문 있음」이어도 업종 다름으로 막힌 곳을 함께 싣는다(사람이 풀 수 있는 것은 업종 표시다)
const e6Now = [c('가짜골목'), c('가짜해돋이'), c('가짜대기')]
const e6 = planQuestionHandoff({
  bank: { ...bank, questions: [...shared, q('v5-001', '가상머뭄이랑 가짜골목 중 어디가 나아?'), q('v5-002', '가상머뭄이랑 가짜대기 중 어디가 조용해?')] },
  version: 'v5',
  brandNames: BRAND,
  backToRepo: false,
  repoVersion: 'v5',
  now: { competitors: e6Now, measured: [true, true, false] },
  next: { competitors: [c('가짜해돋이'), c('가짜대기')], measured: [true, true] },
  hints: [],
  otherIndustry: ['가짜해돋이'],
  taken: ['v5'],
})
ok('자기 질문 있음 + 업종 다름: 이유는 receiverHasOwn, 업종 다름 곳도 싣는다', e6.unreceived[0]?.reason === 'receiverHasOwn' && e6.unreceived[0]?.own?.name === '가짜대기' && e6.unreceived[0]?.other?.join() === '가짜해돋이')

let failed = 0
for (const [label, cond] of checks) {
  if (!cond) failed += 1
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}`)
}
console.log(failed ? `\n${failed}건 실패` : `\n모두 통과 (${checks.length}건)`)
process.exit(failed ? 1 : 0)
