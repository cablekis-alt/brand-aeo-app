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
import { cohortOfCompetitor } from '../src/lib/portfolioView'

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
