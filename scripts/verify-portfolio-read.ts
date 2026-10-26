/**
 * 브랜드 현황이 점수 기록을 한 번에 읽는지(server/store.ts scorecardIndex · server/portfolio.ts buildPortfolio) 확인한다.
 * 임시 폴더를 APP_DATA_DIR로 쓰고 가짜 카드만 만든다. AI는 부르지 않는다.
 *
 * 왜: 브랜드마다 코호트를 찾느라 data/ 폴더 전체를 다시 읽어, 브랜드 37곳이면 기록 파일을 7,400번 넘게 열었다(브랜드 현황이
 * 1초 가까이 걸렸다). 한 번 읽는 색인이 예전 두 메서드(getScorecardHistory · getCohortScorecards)와 다른 답을 내면 순위표에서
 * 지운 브랜드 · 뺀 경쟁사가 다시 끼거나 같은 브랜드가 두 번 센다.
 *
 *   npx tsx scripts/verify-portfolio-read.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { WeeklyScorecard } from '../src/prompts/b8-report'
import type { TenantConfig } from '../server/types'

const dir = mkdtempSync(path.join(tmpdir(), 'verify-portfolio-read-'))
process.env.APP_DATA_DIR = dir
process.env.BLOB_READ_WRITE_TOKEN = ''
process.env.BLOB_STORE_ID = ''
process.env.PIPELINE_CRON = ''

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])
const writeRaw = (rel: string, text: string) => {
  const file = path.join(dir, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}
const writeJson = (rel: string, value: unknown) => writeRaw(rel, JSON.stringify(value))
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const IND = '가짜업종'
const A = '가짜시'
const B = '다른시'
const NOW = new Date('2026-10-28T03:00:00Z') // 2026-W44

function card(tenantId: string, region: string, weekOf: string, score: number, extra: Partial<WeeklyScorecard> = {}): WeeklyScorecard {
  return {
    tenantId,
    weekOf,
    industry: IND,
    region,
    brandName: `가짜 ${tenantId}`,
    aeoScore: { current: score, ma4: score, previousWeek: score, ciLow: 0, ciHigh: 0 },
    mentionRate: 0.1,
    shareOfMention: null,
    avgRecommendationRank: null,
    factualityScore: null,
    brandOwnedCitationRate: 0.05,
    cohortRank: { position: 1, totalTenants: 3 },
    hallucinationFlags: [],
    enginesUsed: ['gemini', 'openai'],
    judgeEngine: 'gemini',
    judgeModel: 'g-1',
    questionBankVersion: 'v1',
    repeatsPerQuestion: 1,
    ...extra,
  } as WeeklyScorecard
}
const bank = (texts: string[]) => ({
  version: 'v1',
  generatedAt: '2026-10-01T00:00:00Z',
  questions: texts.map((text, i) => ({ id: `q${i}`, category: 'category-agnostic', text })),
})
const T = ['가짜 질문 하나', '가짜 질문 둘']
const T2 = ['다른 질문 하나', '다른 질문 둘']

function tenant(p: Partial<TenantConfig> & { tenantId: string }): TenantConfig {
  return {
    brandName: `가짜 ${p.tenantId}`,
    aliases: [],
    ownedDomains: [],
    industry: IND,
    region: A,
    engines: ['openai', 'gemini'],
    questionBankSize: 36,
    questionBankVersion: 'v1',
    repeatsPerQuestion: 1,
    factGraph: [],
    competitors: [],
    ...p,
  } as TenantConfig
}

// ── 가짜 데이터: 고객 4(c3은 측정 전) · 경쟁사 6 · 지운 브랜드 1 · 제외 1 · 같은 주 비교 그룹 2개(A W43 · B W43) + A W44 ──
const histories: Record<string, WeeklyScorecard[]> = {
  // c1: W40 → W43. 수집 엔진이 바뀌고(openai → gemini+openai) 판정 모델 기록이 W40에 없다.
  c1: [card('c1', A, '2026-W43', 40), card('c1', A, '2026-W40', 35, { enginesUsed: ['openai'], judgeModel: undefined })],
  // c2: W43 → W44 같은 조건 · +5.
  c2: [card('c2', A, '2026-W43', 60), card('c2', A, '2026-W44', 65)],
  c4: [card('c4', B, '2026-W43', 50)],
  // comp1은 같은 주 카드가 둘 — 폴더마다 첫 카드만 센다(예전 history.find와 같다).
  comp1: [card('comp1', A, '2026-W43', 30), card('comp1', A, '2026-W43', 99)],
  comp2: [card('comp2', A, '2026-W43', 20)],
  comp3: [card('comp3', A, '2026-W43', 25), card('comp3', A, '2026-W44', 28)],
  comp4: [card('comp4', A, '2026-W44', 33)],
  comp5: [card('comp5', B, '2026-W43', 45)],
  comp6: [card('comp6', B, '2026-W43', 44)],
  gone: [card('gone', A, '2026-W43', 70)],
}
for (const [id, list] of Object.entries(histories)) {
  writeJson(`data/${id}/scorecard-history.json`, list)
  writeJson(`data/${id}/question-bank/v1.json`, bank(id === 'comp5' ? T2 : T))
}
writeRaw('data/broken/scorecard-history.json', '{ not json')
writeRaw('data/notes.txt', '폴더가 아닌 파일')
writeJson('tenants.deleted.json', ['gone'])
writeJson('cohort-exclusions.json', {
  version: 1,
  entries: [
    { id: 'x1', industry: IND, region: A, tenantId: 'comp2', untilWeek: '2026-W43', brandName: '가짜 comp2', excludedAt: '', excludedBy: 'c1' },
  ],
})

try {
  const { FileResultStore } = await import('../server/store')
  const { buildPortfolio } = await import('../server/portfolio')
  const { rowChips } = await import('../src/lib/portfolioView')
  const store = new FileResultStore()
  const index = await store.scorecardIndex()

  // ── 1) 색인 = 예전 두 메서드 ──────────────────────────────────────
  const keys: [string, string, string][] = [
    [IND, A, '2026-W43'],
    [IND, A, '2026-W44'],
    [IND, B, '2026-W43'],
    [IND, A, '2026-W40'],
    [IND, '없는 지역', '2026-W43'],
  ]
  for (const [i, r, w] of keys) {
    const old = await store.getCohortScorecards(i, r, w)
    ok(`cohort(${r} ${w}) = getCohortScorecards(같은 카드 · 같은 순서)`, same(index.cohort(i, r, w), old))
  }
  for (const id of [...Object.keys(histories), 'broken', 'notes.txt', '없는브랜드']) {
    ok(`historyOf(${id}) = getScorecardHistory(전부)`, same(index.historyOf(id), await store.getScorecardHistory(id, Number.MAX_SAFE_INTEGER)))
  }
  const a43 = index.cohort(IND, A, '2026-W43').map((c) => c.tenantId)
  ok('지운 브랜드는 비교 그룹에서 빠진다', !a43.includes('gone'))
  ok('제외 목록의 경쟁사는 그 주 비교 그룹에서 빠진다', !a43.includes('comp2'))
  ok('같은 주 카드가 둘이면 첫 카드 하나만', a43.filter((x) => x === 'comp1').length === 1 && index.cohort(IND, A, '2026-W43').find((c) => c.tenantId === 'comp1')?.aeoScore.current === 30)
  ok('지운 브랜드도 자기 기록은 읽힌다(예전 getScorecardHistory와 같다)', index.historyOf('gone').length === 1)
  ok('기록은 주차 오름차순', index.historyOf('c1').map((c) => c.weekOf).join(',') === '2026-W40,2026-W43')
  const copy = index.historyOf('c1')
  copy.pop()
  ok('돌려준 배열을 고쳐도 색인은 그대로', index.historyOf('c1').length === 2)

  // ── 2) buildPortfolio는 색인을 한 번만 읽는다 ─────────────────────────
  const calls: Record<string, number> = {}
  const counting = new Proxy(store, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown
      if (typeof v !== 'function') return v
      return (...args: unknown[]) => {
        calls[String(prop)] = (calls[String(prop)] ?? 0) + 1
        return (v as (...a: unknown[]) => unknown).apply(target, args)
      }
    },
  })
  const tenants: TenantConfig[] = [
    // c1 경쟁사: comp1(잰다) · comp1의 다른 주소(같은 브랜드로 이어져 칸만 차지) · other(다른 업종 ID와 겹침)
    tenant({
      tenantId: 'c1',
      competitors: [
        { name: '가짜 comp1', domains: ['comp1.com'] },
        { name: '가짜 comp1 쇼핑', domains: ['shop-comp1.kr'] },
        { name: '가짜 겹침', domains: ['other.com'] },
      ] as TenantConfig['competitors'],
    }),
    // c2 경쟁사 7곳 — 5곳까지 함께 재고 2곳은 대기.
    tenant({
      tenantId: 'c2',
      competitors: Array.from({ length: 7 }, (_, i) => ({ name: `가짜 대기 ${i}`, domains: [`wait${i}.com`] })) as TenantConfig['competitors'],
    }),
    tenant({ tenantId: 'c3' }),
    tenant({ tenantId: 'c4', region: B }),
    tenant({ tenantId: 'comp1', cohortOnly: true, ownedDomains: ['comp1.com', 'shop-comp1.kr'] }),
    tenant({ tenantId: 'other', cohortOnly: true, industry: '다른업종' }),
  ]
  const pf = await buildPortfolio(tenants, counting, NOW)
  ok('scorecardIndex 한 번', calls.scorecardIndex === 1)
  ok('getCohortScorecards · getScorecardHistory는 부르지 않는다', !calls.getCohortScorecards && !calls.getScorecardHistory)
  ok('이번 주 W44', pf.currentWeek === '2026-W44')

  const row = (id: string) => pf.rows.find((r) => r.tenantId === id)!
  const c1 = row('c1')
  ok('c1: 같은 질문지 · 지난주 측정 → stale, 1주 전', c1.status === 'stale' && c1.ageWeeks === 1)
  ok(
    'c1: 조건 차이를 바뀜 · 기록 없음으로 나눈다',
    same(c1.changeDims, { changed: ['수집 엔진'], unknown: ['판정 모델'] }) && c1.delta === null && c1.changeReason === '수집 엔진 바뀜 · 판정 모델 기록 없음',
  )
  ok('c1: 경쟁사 계획 — 1곳 측정 · 칸만 차지 2(그중 ID 겹침 1)', same(c1.competitorPlan, { measured: 1, cap: 5, waiting: 0, blocked: 2, collision: 1 }))
  const chips = rowChips(c1).map((c) => c.text)
  ok('c1 칩: ID 겹침 1곳 · 중복 1곳', chips.includes('ID 겹침 1곳 · 측정 안 됨') && chips.includes('중복 1곳 · 칸만 차지'))
  const c2 = row('c2')
  ok('c2: 이번 주 · 같은 질문지 → done, 0주, +5', c2.status === 'done' && c2.ageWeeks === 0 && c2.delta === 5 && c2.changeDims === null)
  ok('c2: 경쟁사 7곳 중 2곳 대기 · 겹침 0', c2.competitorPlan?.waiting === 2 && c2.competitorPlan.collision === 0)
  const c3 = row('c3')
  ok('c3: 측정 전 → none, 나이 · 조건 없음', c3.status === 'none' && c3.ageWeeks === null && c3.changeDims === null)
  ok('c4: 비교 그룹의 다른 브랜드와 질문지 다름 → diff', row('c4').status === 'diff' && row('c4').ageWeeks === 1)
  const cohortA43 = pf.cohorts.find((c) => c.region === A && c.weekOf === '2026-W43')
  ok(
    '리더보드(A W43): 지운 브랜드 · 뺀 경쟁사 없이 c1 · c2(지난 기록) · comp1 · comp3',
    same(cohortA43?.members.map((m) => m.tenantId).sort(), ['c1', 'c2', 'comp1', 'comp3']) &&
      cohortA43?.members.find((m) => m.tenantId === 'c2')?.laterWeek === '2026-W44',
  )
} catch (err) {
  console.error(err)
  checks.push(['예외 없이 끝까지 돈다', false])
} finally {
  rmSync(dir, { recursive: true, force: true })
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
