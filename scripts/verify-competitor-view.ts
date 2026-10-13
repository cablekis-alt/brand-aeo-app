/**
 * 경쟁사 보기(읽기 전용)의 규칙을 확인한다 — 어느 화면이 잠기는지, 띠가 어느 코호트를 보이는지. AI는 부르지 않는다.
 *
 * 왜: 경쟁사 보기에서 측정 · 콘텐츠 생성 · 설정 화면이 열리면 경쟁사 이름으로 측정을 걸거나 글을 만들 수 있다.
 * 반대로 보기 화면이 잠기면 경쟁사를 연 의미가 없다(상용화 UI 10차 시안).
 *
 *   npx tsx scripts/verify-competitor-view.ts
 */
import type { PortfolioCohort } from '../src/lib/api'
import { allScreens, isCustomerOnlyPath } from '../src/lib/menu'
import { cohortOfCompetitor, customerForCompetitorRow, sameCohort } from '../src/lib/portfolioView'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

const LOCKED = ['/gap-actions', '/content-library', '/site-diagnosis', '/report', '/measure-tenant', '/measure-status', '/ai-referrals', '/brand-facts', '/questions', '/brand-onboarding']
const OPEN = ['/brands', '/', '/answers', '/ranking', '/citation-gap', '/diagnosis', '/performance', '/question-winloss', '/gap-analysis', '/sentiment', '/citations', '/citation-sources', '/eeat', '/competitor-trends']

for (const p of LOCKED) ok(`잠김: ${p}`, isCustomerOnlyPath(p))
for (const p of OPEN) ok(`열림: ${p}`, !isCustomerOnlyPath(p))
ok('메뉴에 있는 화면은 모두 열림 또는 잠김 목록에 있다', allScreens().every((s) => LOCKED.includes(s.to) || OPEN.includes(s.to)))
ok('명령 창: 경쟁사 보기에서는 잠긴 화면이 빠진다', allScreens(true).every((s) => !isCustomerOnlyPath(s.to)))
ok('명령 창: 평소에는 전부 보인다', allScreens(false).length === allScreens().length && allScreens().some((s) => s.to === '/gap-actions'))

const member = (tenantId: string, competitor: boolean) => ({
  tenantId, brandName: tenantId, score: 50, rank: 1, tied: false, mentionRate: 0.5, brandOwnedCitationRate: 0.1, competitor, laterWeek: null,
})
const cohorts: PortfolioCohort[] = [
  { industry: '병원', region: '서울 강남', weekOf: '2026-W36', members: [member('amc', true), member('samsunghospital', false)] },
  { industry: '병원', region: '서울 강남', weekOf: '2026-W40', members: [member('amc', true), member('other', false)] },
  { industry: '병원', region: '서울 송파', weekOf: '2026-W38', members: [member('amc', true), member('samsunghospital', false)] },
]
ok('고객과 함께 있는 코호트 중 가장 최근(W38 송파)', cohortOfCompetitor(cohorts, 'amc', 'samsunghospital')?.weekOf === '2026-W38')
ok('고객과 함께 있는 코호트가 없으면 경쟁사가 든 가장 최근(W40)', cohortOfCompetitor(cohorts, 'amc', 'nobody')?.weekOf === '2026-W40')
ok('경쟁사가 든 코호트가 없으면 null', cohortOfCompetitor(cohorts, 'ghost', 'samsunghospital') === null)

// 브랜드 현황에서 경쟁사 줄을 열 때 맞출 고객 — 다른 업종 고객을 고른 채 펜션 카드의 경쟁사를 열면 펜션 고객으로
const pension: PortfolioCohort = {
  industry: '펜션',
  region: '가상시',
  weekOf: '2026-W42',
  members: [member('comp-a', true), member('stay', false), member('comp-b', true)],
}
ok('고른 고객이 그 카드에 없으면 카드의 고객으로 맞춘다', customerForCompetitorRow(pension, 'view-ps') === 'stay')
ok('고른 고객이 그 카드에 있으면 그대로', customerForCompetitorRow(cohorts[0]!, 'samsunghospital') === 'samsunghospital')
ok('고객이 여럿이면 고른 고객을 우선', customerForCompetitorRow({ ...pension, members: [...pension.members, member('stay2', false)] }, 'stay2') === 'stay2')
ok('고객 브랜드가 없는 카드면 바꾸지 않는다(null)', customerForCompetitorRow({ ...pension, members: [member('comp-a', true)] }, 'view-ps') === null)
ok('지난 기록 줄의 고객도 그 카드의 고객', customerForCompetitorRow({ ...pension, members: [member('comp-a', true), { ...member('stay', false), laterWeek: '2026-W43' }] }, 'view-ps') === 'stay')
ok('같은 업종 · 지역이면 같은 코호트', sameCohort({ industry: '펜션', region: '전북 군산' }, { industry: '펜션', region: '전북 군산' }))
ok('업종이 다르면 다른 코호트(비교 카드를 나란히 놓지 않음)', !sameCohort({ industry: '펜션', region: '전북 군산' }, { industry: '성형외과', region: '서울 강남' }))
ok('지역만 달라도 다른 코호트', !sameCohort({ industry: '병원', region: '서울 강남' }, { industry: '병원', region: '서울 송파' }))

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
