/**
 * 함께 측정할 경쟁사 계획(planCohortTargets)의 규칙을 확인한다 — 5칸, 대기, 중복, 다른 업종 충돌, 기존 브랜드.
 * 가짜 브랜드만 쓰고 AI는 부르지 않는다.
 *
 * 왜: 경쟁사 편집 서랍의 「함께 측정 5/5 · 대기 N」이 실제 측정 대상과 어긋나면, 화면은 잰다고 하는데
 * 측정은 건너뛰는 경쟁사가 생긴다. 서랍과 측정이 같은 함수를 써야 하고, 그 함수의 칸 계산은 이전과 같아야 한다.
 *
 *   npx tsx scripts/verify-cohort-plan.ts
 */
import { MAX_AUTO_COHORT, planCohortTargets, selectCohortTargets } from '../server/cohortPlan'
import { normalizeTenantDraft } from '../server/tenantRegistry'
import type { TenantConfig } from '../server/types'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

type Comp = { name: string; domains?: string[] }
const customer = (competitors: Comp[], extra: Partial<TenantConfig> = {}): TenantConfig =>
  normalizeTenantDraft({
    tenantId: 'cust',
    brandName: '가상 펜션',
    ownedDomains: ['cust.example'],
    industry: '펜션',
    region: '가상시',
    questionBankSize: 42,
    questionBankVersion: 'v5',
    competitors: competitors.map((c) => ({ name: c.name, domains: c.domains ?? [] })),
    ...extra,
  })
const other = (tenantId: string, brandName: string, industry: string, region: string, ownedDomains: string[] = []): TenantConfig =>
  normalizeTenantDraft({ tenantId, brandName, industry, region, ownedDomains, cohortOnly: true, questionBankVersion: 'v4' })

const six: Comp[] = ['가상 하나', '가상 둘', '가상 셋', '가상 넷', '가상 다섯', '가상 여섯'].map((name) => ({ name }))
const statuses = (t: TenantConfig, runtime: TenantConfig[]) => planCohortTargets(t, runtime).entries.map((e) => e.status).join(',')

// 1) 5칸 + 대기
{
  const t = customer(six)
  const plan = planCohortTargets(t, [t])
  ok('상한은 5칸', plan.cap === 5 && MAX_AUTO_COHORT === 5)
  ok('6곳이면 앞 5곳 함께 측정, 6번째 대기', statuses(t, [t]) === 'measured,measured,measured,measured,measured,waiting')
  ok('대기 줄은 칸을 차지하지 않는다', plan.entries[5].takesSlot === false)
  ok('측정 대상 5곳, 이름 해시 id', plan.targets.length === 5 && plan.targets.every((x) => x.tenantId.startsWith('comp-')))
  ok('새 초안은 고객의 질문지 버전과 업종·지역을 물려받는다', plan.targets.every((x) => x.questionBankVersion === 'v5' && x.industry === '펜션' && x.region === '가상시' && x.cohortOnly === true))
  ok('selectCohortTargets = plan.targets', JSON.stringify(selectCohortTargets(t, [t])) === JSON.stringify(plan.targets))
}

// 2) 같은 이름 두 줄 — 자르기 전에 걸러져 칸을 차지하지 않는다(6번째가 측정에 들어온다)
{
  const t = customer([six[0], six[0], ...six.slice(1)])
  const plan = planCohortTargets(t, [t])
  ok('중복 줄은 duplicate, 칸 안 씀', plan.entries[1].status === 'duplicate' && !plan.entries[1].takesSlot)
  ok('중복이 빠지면 6번째 줄까지 함께 측정, 7번째 대기', plan.targets.length === 5 && plan.entries[5].status === 'measured' && plan.entries[6].status === 'waiting')
}

// 3) 다른 업종 브랜드와 id 충돌 — 칸은 차지하고 측정은 안 한다(대기가 올라오지 않는다)
{
  const t = customer([{ name: '가상 통신', domains: ['kt.example'] }, ...six.slice(1)])
  const telecom = other('kt', '가상 테이블오더', '테이블오더', '국내', ['kt.co.example'])
  const plan = planCohortTargets(t, [t, telecom])
  ok('충돌 줄은 collision, 칸 씀', plan.entries[0].status === 'collision' && plan.entries[0].takesSlot)
  ok('충돌 상대가 기록된다', plan.entries[0].collidesWith?.tenantId === 'kt' && plan.entries[0].collidesWith.industry === '테이블오더')
  ok('충돌이 있으면 4곳만 함께 측정하고 6번째는 대기', plan.targets.length === 4 && plan.entries[5].status === 'waiting')
}

// 4) 같은 업종 다른 지역 기존 브랜드(도메인 일치) — 그 브랜드 설정으로 재고 다른 지역이라고 표시한다
{
  const t = customer([{ name: '가상 하나', domains: ['far.example'] }, ...six.slice(1, 5)])
  const far = other('far', '가상 원정', '펜션', '먼 곳', ['far.example'])
  const plan = planCohortTargets(t, [t, far])
  const first = plan.entries[0]
  ok('기존 브랜드로 측정', first.status === 'measured' && first.targetTenantId === 'far' && first.existing?.tenantId === 'far')
  ok('다른 지역이면 otherRegion', first.otherRegion === true)
  ok('기존 브랜드는 자기 설정(v4)·autoCohort false로 잰다', plan.targets[0].questionBankVersion === 'v4' && plan.targets[0].autoCohort === false)
}

// 5) 같은 코호트 기존 브랜드(id 일치) — 다른 지역 표시가 없다
{
  const t = customer(six.slice(0, 2))
  const id = planCohortTargets(t, [t]).entries[0].draftId!
  const same = other(id, '가상 하나', '펜션', '가상시')
  const first = planCohortTargets(t, [t, same]).entries[0]
  ok('같은 코호트 기존 브랜드', first.existing?.tenantId === id && first.otherRegion === undefined)
}

// 6) 도메인 둘이 같은 기존 브랜드로 이어지면 둘째 줄은 칸을 쓰는 duplicate
{
  const t = customer([{ name: '가상 하나', domains: ['a.example'] }, { name: '가상 하나 별관', domains: ['b.example'] }, ...six.slice(2)])
  const both = other('ab', '가상 하나', '펜션', '가상시', ['a.example', 'b.example'])
  const plan = planCohortTargets(t, [t, both])
  ok('둘째 줄 duplicate, 칸 씀', plan.entries[1].status === 'duplicate' && plan.entries[1].takesSlot)
  ok('측정 대상 4곳, 6번째 대기', plan.targets.length === 4 && plan.entries[5].status === 'waiting')
}

// 7) 영어 측정 고객의 경쟁사는 -en
{
  const t = customer(six.slice(0, 1), { questionLanguage: 'en' })
  ok('영어 측정이면 id에 -en', planCohortTargets(t, [t]).entries[0].draftId!.endsWith('-en'))
}

// 8) 이름 없는 줄(정규화를 거치지 않은 설정)은 unnamed, 칸 안 씀
{
  const t = { ...customer(six.slice(0, 2)), competitors: [{ name: '', aliases: [], domains: [] }, { name: '가상 하나', aliases: ['가상 하나'], domains: [] }] }
  const plan = planCohortTargets(t, [t])
  ok('이름 없는 줄 unnamed', plan.entries[0].status === 'unnamed' && !plan.entries[0].takesSlot && plan.targets.length === 1)
}

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
