/**
 * 비교 질문과 경쟁사를 잇는 규칙(linkCompetitorQuestions)을 확인한다. 가짜 질문·가짜 이름만 쓰고 AI는 부르지 않는다.
 *
 * 왜: 경쟁사를 바꾸면 그 경쟁사를 짚은 질문만 고쳐 쓴다. 잇기가 틀리면 엉뚱한 질문을 고치거나,
 * 빠진 경쟁사를 계속 묻는 질문이 남는다.
 *
 *   npx tsx scripts/verify-question-links.ts
 */
import { linkCompetitorQuestions } from '../server/competitorQuestions'
import type { CompetitorContext, QuestionSpec } from '../src/prompts/types'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

const q = (questionId: string, text: string, category: QuestionSpec['category'] = 'comparison', cohortShared = false): QuestionSpec => ({
  questionId, text, category, industry: '펜션', region: '가상시', containsBrandName: !cohortShared, version: questionId.split('-')[0], ...(cohortShared ? { cohortShared } : {}),
})
const c = (name: string, aliases: string[] = []): CompetitorContext => ({ name, aliases: aliases.length ? aliases : [name], domains: [] })

const competitors = [c('가상 골목집'), c('초원'), c('초원고택'), c('가상옥도', ['가상 옥도']), c('스테이'), c('가상 바다')]
const questions = [
  q('c1-001', '가상시 가상 골목집 같은 감성 숙소 어디야?', 'category-agnostic', true),
  q('v5-001', '스테이,머뭄 체크인 몇 시야?', 'brand-direct'),
  q('v5-004', '가상시 감성 펜션 찾는데 스테이,머뭄이랑 가상골목집 중에 어디가 더 나아?'),
  q('v5-005', '가족 여행이면 스테이,머뭄이랑 초원고택 중 어디가 좋아?'),
  q('v5-006', '스테이,머뭄이랑 가상 옥도 부대시설 비교하면 어때?'),
  q('v5-007', '스테이,머뭄, 초원, 가상 바다 세 곳 가격 비교해 줘', 'price-spec'),
]
const links = linkCompetitorQuestions(questions, competitors, ['스테이,머뭄', '스테이 머뭄'])
const ids = (i: number) => links.byCompetitor[i].join(',')

ok('코호트 공통 질문은 보지 않는다', !links.questions.some((x) => x.questionId === 'c1-001'))
ok('띄어쓰기를 무시한다(가상 골목집 ↔ 가상골목집)', ids(0) === 'v5-004')
ok('긴 이름이 먼저 — 초원고택 질문은 초원에 잇지 않는다', ids(2) === 'v5-005' && !links.byCompetitor[1].includes('v5-005'))
ok('짧은 이름도 따로 쓰인 곳은 잡는다(초원)', ids(1) === 'v5-007')
ok('별칭으로 찾는다(가상 옥도)', ids(3) === 'v5-006')
ok('고객 이름 안의 글자(스테이)는 경쟁사로 잡지 않는다', ids(4) === '')
ok('한 질문에 경쟁사 둘이면 둘 다 잇는다', links.questions.find((x) => x.questionId === 'v5-007')?.competitorIndexes.join(',') === '1,5')
ok('경쟁사를 짚지 않은 브랜드 질문은 없다', !links.questions.some((x) => x.questionId === 'v5-001'))
ok('byCompetitor는 경쟁사 수와 같다', links.byCompetitor.length === competitors.length)

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
