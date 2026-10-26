/**
 * 브랜드 현황 화면 규칙(src/lib/portfolioView.ts)을 확인한다 — 상태 칩 · 요약 타일 · 점수 변화 문구 · 막대 · 주소 보기 상태 ·
 * 비교 그룹 정렬 · 줄 「측정」 단추. 가짜 값만 쓰고 서버 · AI는 부르지 않는다.
 *
 * 왜: 월요일마다 지난주에 잰 브랜드까지 「측정 필요」 주황이 되어 37곳이 다 같은 색이었고, 「측정 필요 · 질문지 다름」은 언제
 * 쟀는지를 감췄다. 요약 타일끼리 겹치면 합이 전체와 맞지 않는다.
 *
 *   npx tsx scripts/verify-portfolio-view.ts
 */
import type { PortfolioCohort, PortfolioRow } from '../src/lib/api'
import {
  barWidth,
  changeLine,
  cohortKey,
  parseView,
  passFilter,
  refReason,
  rowChips,
  rowTone,
  showMeasure,
  sortCohorts,
  statusShort,
  summarize,
  unmeasuredCohorts,
  viewParams,
  type PfFilter,
} from '../src/lib/portfolioView'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function row(p: Partial<PortfolioRow> & { tenantId: string }): PortfolioRow {
  return {
    brandName: `가짜 ${p.tenantId}`,
    industry: '가짜업종',
    region: '가짜시',
    competitors: 0,
    competitorPlan: null,
    competitorEdit: null,
    profileEdit: null,
    status: 'stale',
    weekOf: '2026-W43',
    score: 40,
    rank: 1,
    totalTenants: 3,
    tied: false,
    delta: null,
    changeReason: null,
    previousWeekOf: null,
    ageWeeks: 1,
    changeDims: null,
    ...p,
  }
}
const texts = (r: PortfolioRow) => rowChips(r).map((c) => `${c.tone || '-'}:${c.text}`)

// ── 1) 상태 칩 ──────────────────────────────────────────────────
ok('stale 1주 → 중립 「이번 주 아직」', same(texts(row({ tenantId: 'a' })), ['-:W43 측정 · 이번 주 아직']))
ok('stale 4주 → 주황 「4주 전」', same(texts(row({ tenantId: 'a', weekOf: '2026-W40', ageWeeks: 4 })), ['warn:W40 측정 · 4주 전']))
ok('나이를 모르면(옛 응답) 주차만', same(texts(row({ tenantId: 'a', weekOf: '2026-W40', ageWeeks: undefined })), ['-:W40 측정']))
ok('done → 초록 「W44 완료」', same(texts(row({ tenantId: 'a', status: 'done', weekOf: '2026-W44', ageWeeks: 0 })), ['good:W44 완료']))
ok(
  'diff → 나이 칩과 「질문지 다름 · 순위 참고용」을 따로',
  same(texts(row({ tenantId: 'a', status: 'diff', weekOf: '2026-W38', ageWeeks: 6 })), ['warn:W38 측정 · 6주 전', 'warn:질문지 다름 · 순위 참고용']),
)
ok('이번 주에 쟀지만 질문지가 다르면 나이 칩 없이', same(texts(row({ tenantId: 'a', status: 'diff', weekOf: '2026-W44', ageWeeks: 0 })), ['warn:질문지 다름 · 순위 참고용']))
const unknownChips = rowChips(row({ tenantId: 'a', status: 'unknown', ageWeeks: 1 }))
ok('unknown → 「질문지 기록 없음 · 순위 참고용」(확인 불가)', unknownChips[1]?.text === '질문지 기록 없음 · 순위 참고용' && Boolean(unknownChips[1]?.title?.includes('확인 불가')))
ok('alone → 파랑 「경쟁사 없이 측정」', same(texts(row({ tenantId: 'a', status: 'alone', ageWeeks: 0 })), ['info:경쟁사 없이 측정']))
ok('none → 중립 「측정 전」', same(texts(row({ tenantId: 'a', status: 'none', weekOf: null, score: null, ageWeeks: null })), ['-:측정 전']))
const plan = (p: Partial<NonNullable<PortfolioRow['competitorPlan']>>) => ({ measured: 3, cap: 5, waiting: 0, blocked: 0, collision: 0, ...p })
const collided = rowChips(row({ tenantId: 'a', status: 'done', ageWeeks: 0, competitorPlan: plan({ blocked: 1, collision: 1 }) }))
ok('ID 겹침 1곳 → 주황 · 경쟁사 편집으로', collided[1]?.text === 'ID 겹침 1곳 · 측정 안 됨' && collided[1].tone === 'warn' && collided[1].action === 'competitors' && collided.length === 2)
ok('겹침 1 · 중복 1 → 두 칩', same(texts(row({ tenantId: 'a', status: 'done', ageWeeks: 0, competitorPlan: plan({ blocked: 2, collision: 1 }) })).slice(1), ['warn:ID 겹침 1곳 · 측정 안 됨', 'warn:중복 1곳 · 칸만 차지']))
const waiting = rowChips(row({ tenantId: 'a', status: 'done', ageWeeks: 0, competitorPlan: plan({ waiting: 6 }) }))
ok('대기만 → 중립 「경쟁사 대기 6곳」(경쟁사 편집 설명)', waiting[1]?.text === '경쟁사 대기 6곳' && waiting[1].tone === '' && waiting[1].action === 'competitors' && Boolean(waiting[1].title?.includes('한 번에 5곳까지만')))
ok(
  '옛 응답(겹침 수 없음) → 「측정 안 되는 경쟁사」',
  same(texts(row({ tenantId: 'a', status: 'done', ageWeeks: 0, competitorPlan: { measured: 3, cap: 5, waiting: 0, blocked: 2 } })).slice(1), ['warn:측정 안 되는 경쟁사 2곳']),
)
ok(
  '칩 순서: 나이 → 비교 문제 → 칸 문제 → 편집 대기 → 대기',
  same(
    rowChips(
      row({
        tenantId: 'a',
        status: 'diff',
        ageWeeks: 2,
        weekOf: '2026-W42',
        competitorPlan: plan({ waiting: 1, blocked: 1, collision: 1 }),
        profileEdit: { savedAt: '', summary: '지역 바꿈' },
        competitorEdit: { savedAt: '', summary: '경쟁사 바꿈' },
      }),
    ).map((c) => c.text),
    ['W42 측정 · 2주 전', '질문지 다름 · 순위 참고용', 'ID 겹침 1곳 · 측정 안 됨', '기본 정보 바뀜 · 다음 측정 대기', '경쟁사 바뀜 · 다음 측정 대기', '경쟁사 대기 1곳'],
  ),
)

// ── 2) 점 색 · 짧은 문구(브랜드 바꾸기 패널) ─────────────────────────
ok('점 색: stale 1주 중립 · 2주 주황 · 나이 모름 주황', rowTone(row({ tenantId: 'a' })) === '' && rowTone(row({ tenantId: 'a', ageWeeks: 2 })) === 'warn' && rowTone(row({ tenantId: 'a', ageWeeks: undefined })) === 'warn')
ok('점 색: done 초록 · alone 파랑 · none 중립 · diff 주황', rowTone(row({ tenantId: 'a', status: 'done' })) === 'good' && rowTone(row({ tenantId: 'a', status: 'alone' })) === 'info' && rowTone(row({ tenantId: 'a', status: 'none' })) === '' && rowTone(row({ tenantId: 'a', status: 'diff', ageWeeks: 0 })) === 'warn')
ok(
  '짧은 문구',
  statusShort(row({ tenantId: 'a' })) === 'W43 · 이번 주 아직' &&
    statusShort(row({ tenantId: 'a', weekOf: '2026-W40', ageWeeks: 4 })) === 'W40 · 4주 전' &&
    statusShort(row({ tenantId: 'a', status: 'diff', weekOf: '2026-W38' })) === 'W38 · 질문지 다름' &&
    statusShort(row({ tenantId: 'a', status: 'unknown', weekOf: '2026-W36' })) === 'W36 · 질문지 기록 없음' &&
    statusShort(row({ tenantId: 'a', status: 'alone' })) === '경쟁사 없이 측정' &&
    statusShort(row({ tenantId: 'a', status: 'none', weekOf: null })) === '측정 전',
)

// ── 3) 요약 타일 · 거르개 ──────────────────────────────────────────
const rows: PortfolioRow[] = [
  row({ tenantId: 'd1', status: 'done', weekOf: '2026-W44', ageWeeks: 0 }),
  row({ tenantId: 's1', status: 'stale', weekOf: '2026-W43', ageWeeks: 1 }),
  row({ tenantId: 's2', status: 'stale', weekOf: '2026-W40', ageWeeks: 4 }),
  row({ tenantId: 'n1', status: 'none', weekOf: null, ageWeeks: null, score: null }),
  row({ tenantId: 'x1', status: 'diff', weekOf: '2026-W38', ageWeeks: 6 }),
  row({ tenantId: 'u1', status: 'unknown', weekOf: '2026-W36', ageWeeks: 8 }),
  row({ tenantId: 'a1', status: 'alone', weekOf: '2026-W44', ageWeeks: 0 }),
]
const sum = summarize(rows)
ok('요약: 완료 1 · 측정 남음 3(측정 전 1) · 순위 비교 안 됨 2(다름 1 · 기록 없음 1) · 경쟁사 없이 1', sum.done === 1 && sum.todo === 3 && sum.none === 1 && sum.mismatch === 2 && sum.diff === 1 && sum.unknown === 1 && sum.alone === 1)
ok('타일 합 = 전체(겹치지 않는다)', sum.done + sum.todo + sum.mismatch + sum.alone === sum.all && sum.all === 7)
ok('가장 오래된 측정(측정 남음 가운데) W40 · 4주 전', same(sum.oldest, { weekOf: '2026-W40', weeks: 4 }))
const monday = summarize(rows.map((r) => (r.status === 'done' ? { ...r, status: 'stale' as const, ageWeeks: 1 } : r)))
ok('월요일(이번 주 아직 아무도 안 잼) → 완료 0', monday.done === 0 && monday.todo === 4)
const filters: PfFilter[] = ['done', 'todo', 'mismatch', 'alone']
ok('거르개 넷이 모든 줄을 한 번씩 나눈다', rows.every((r) => filters.filter((f) => passFilter(r, f)).length === 1) && rows.every((r) => passFilter(r, '')))

// ── 4) 점수 변화 문구 ──────────────────────────────────────────────
ok('전주 대비 +3', changeLine(row({ tenantId: 'a', delta: 3, previousWeekOf: '2026-W42' })).text === '전주 대비 +3')
ok('전주와 같음', changeLine(row({ tenantId: 'a', delta: 0, previousWeekOf: '2026-W42' })).text === '전주와 같음')
ok('2주 넘게 떨어지면 「직전 측정(W38)」', changeLine(row({ tenantId: 'a', delta: -2, previousWeekOf: '2026-W38' })).text === '직전 측정(W38) 대비 −2')
ok('첫 측정', changeLine(row({ tenantId: 'a' })).text === '첫 측정 · 다음 측정부터 변화 표시' && changeLine(row({ tenantId: 'a', status: 'none', weekOf: null })).text === '')
const four = changeLine(
  row({
    tenantId: 'a',
    previousWeekOf: '2026-W40',
    changeReason: '수집 엔진 · 질문지 바뀜 · 수집 모델 · 판정 모델 기록 없음',
    changeDims: { changed: ['수집 엔진', '질문지'], unknown: ['수집 모델', '판정 모델'] },
  }),
)
ok('조건 넷 → 「변화 표시 안 함 · 수집 엔진 바뀜 외 3」', four.text === '변화 표시 안 함 · 수집 엔진 바뀜 외 3')
ok(
  '전부는 title에(직전 측정 주차와 함께)',
  four.title === '직전 측정(W40)과 조건이 달라 점수 변화를 보이지 않습니다 — 수집 엔진 · 질문지 바뀜 · 수집 모델 · 판정 모델 기록 없음. 같은 조건으로 잰 측정끼리만 증감을 보입니다.',
)
ok('기록 없음 하나만 → 「판정 모델 기록 없음」', changeLine(row({ tenantId: 'a', previousWeekOf: '2026-W42', changeDims: { changed: [], unknown: ['판정 모델'] } })).text === '변화 표시 안 함 · 판정 모델 기록 없음')
ok('조건 나눔이 없는 옛 응답 → 이유 문자열 그대로', changeLine(row({ tenantId: 'a', previousWeekOf: '2026-W42', changeReason: '질문지 바뀜', changeDims: undefined })).text === '전주와 비교 불가 · 질문지 바뀜')

// ── 5) 막대 ───────────────────────────────────────────────────
ok('막대 폭 = 100점 만점 · 최소 2 · 0점 · 측정 전 0', barWidth(3, true) === 3 && barWidth(72, true) === 72 && barWidth(1, true) === 2 && barWidth(0, true) === 0 && barWidth(50, false) === 0 && barWidth(130, true) === 100)

// ── 6) 주소 보기 상태 ──────────────────────────────────────────────
const view = { f: 'todo' as const, g: '의료·뷰티', q: '강남 성형', sort: 'oldest' as const }
ok('보기 상태 ↔ 주소 왕복', same(parseView(viewParams(view).toString()), view) && same(parseView(`?${viewParams(view).toString()}`), view))
ok('기본 보기의 주소는 비어 있다', viewParams({ f: '', g: '', q: '', sort: '' }).toString() === '')
ok('모르는 값은 기본으로', same(parseView('?f=need&sort=random&g=x'), { f: '', g: 'x', q: '', sort: '' }))

// ── 7) 비교 그룹 정렬 ──────────────────────────────────────────────
const member = (tenantId: string, brandName: string, score: number, competitor = false) => ({
  tenantId,
  brandName,
  score,
  rank: 1,
  tied: false,
  mentionRate: 0,
  brandOwnedCitationRate: 0,
  competitor,
  laterWeek: null,
})
const cohort = (industry: string, region: string, weekOf: string, members: PortfolioCohort['members']): PortfolioCohort => ({ industry, region, weekOf, members })
const cohorts: PortfolioCohort[] = [
  cohort('성형외과', '서울 강남', '2026-W40', [member('g1', '나가짜', 72), member('k1', '경쟁 하나', 80, true)]),
  cohort('성형외과', '서울 서초', '2026-W36', [member('g2', '다가짜', 30)]),
  cohort('펜션', '전북 군산', '2026-W43', [member('g3', '가가짜', 55)]),
  // 측정 전 브랜드의 가짜 카드(구성원 점수 0) — 점수순에서는 줄의 점수(null)로 뒤에 간다.
  cohort('펜션', '강원 속초', '', [member('g4', '라가짜', 0)]),
  cohort('통신', '전국', '2026-W44', [member('g5', '마가짜', 90)]),
]
const byId = new Map<string, PortfolioRow>([
  ['g1', row({ tenantId: 'g1', score: 72, weekOf: '2026-W40' })],
  ['g2', row({ tenantId: 'g2', score: 30, weekOf: '2026-W36' })],
  ['g3', row({ tenantId: 'g3', score: 55, weekOf: '2026-W43' })],
  ['g4', row({ tenantId: 'g4', score: null, weekOf: null, status: 'none' })],
  ['g5', row({ tenantId: 'g5', score: 90, weekOf: '2026-W44' })],
])
const ids = (list: PortfolioCohort[]) => list.map((c) => c.members.find((m) => !m.competitor)!.tenantId).join(',')
ok('오래된 측정부터: 측정 전 → W36 → W40 → W43 → W44', ids(sortCohorts(cohorts, byId, 'oldest')) === 'g4,g2,g1,g3,g5')
ok('점수 높은 순(경쟁사 점수는 보지 않는다 · 측정 전 뒤)', ids(sortCohorts(cohorts, byId, 'score')) === 'g5,g1,g3,g2,g4')
ok('이름 순(가나다)', ids(sortCohorts(cohorts, byId, 'name')) === 'g3,g1,g2,g4,g5')
ok('기본은 업종군 순서 그대로(5곳 모두)', sortCohorts(cohorts, byId, '').length === 5)
const tie = [
  cohort('성형외과', '서울 강남', '2026-W40', [member('t1', '가같음', 50)]),
  cohort('성형외과', '서울 서초', '2026-W40', [member('t2', '나같음', 60)]),
]
const tieRows = new Map([
  ['t1', row({ tenantId: 't1', score: 50 })],
  ['t2', row({ tenantId: 't2', score: 60 })],
])
ok('같으면 기본 순서(같은 주차 둘 → 업종군 순서 그대로)', ids(sortCohorts(tie, tieRows, 'oldest')) === ids(sortCohorts(tie, tieRows, '')))

// ── 7-1) 측정 전 카드 · 참고용 순위 ──────────────────────────────────
const fakes = unmeasuredCohorts([
  row({ tenantId: 'n1', status: 'none', weekOf: null, score: null, region: '서울 강남' }),
  row({ tenantId: 'n2', status: 'none', weekOf: null, score: null, region: '서울 강남' }),
  row({ tenantId: 'n3', status: 'none', weekOf: null, score: null, region: '서울 서초' }),
  row({ tenantId: 's1' }),
])
ok(
  '측정 전 브랜드는 업종 · 지역마다 카드 한 장(측정한 브랜드는 없음)',
  fakes.length === 2 && fakes.every((c) => c.weekOf === '') && fakes.find((c) => c.region === '서울 강남')?.members.map((m) => m.tenantId).join() === 'n1,n2',
)
ok('카드 키가 겹치지 않는다', new Set(fakes.map(cohortKey)).size === fakes.length)
const refRows = new Map<string, PortfolioRow>([
  ['d', row({ tenantId: 'd', status: 'diff' })],
  ['u', row({ tenantId: 'u', status: 'unknown' })],
  ['o', row({ tenantId: 'o', status: 'stale' })],
])
ok(
  '참고용 순위: 질문지 다름이 먼저 · 기록 없음 · 아니면 없음',
  refReason(cohort('a', 'b', '2026-W40', [member('u', 'U', 1), member('d', 'D', 2)]), refRows) === 'diff' &&
    refReason(cohort('a', 'b', '2026-W40', [member('u', 'U', 1), member('o', 'O', 2)]), refRows) === 'unknown' &&
    refReason(cohort('a', 'b', '2026-W40', [member('o', 'O', 2), member('d', 'D', 1, true)]), refRows) === null,
)

// ── 8) 줄 「측정」 단추 ────────────────────────────────────────────
ok('측정 남음 · 비교 안 됨이면 보인다', showMeasure(row({ tenantId: 'a' }), null) === 'on' && showMeasure(row({ tenantId: 'a', status: 'diff' }), null) === 'on' && showMeasure(row({ tenantId: 'a', status: 'none' }), null) === 'on')
ok('완료 · 경쟁사 없이는 안 보인다', showMeasure(row({ tenantId: 'a', status: 'done' }), null) === 'off' && showMeasure(row({ tenantId: 'a', status: 'alone' }), null) === 'off')
ok('그 브랜드를 재는 중이면 숨긴다', showMeasure(row({ tenantId: 'a' }), 'a') === 'off')
ok('다른 브랜드를 재는 중이면 누를 수 없다', showMeasure(row({ tenantId: 'a' }), 'b') === 'disabled' && showMeasure(row({ tenantId: 'a', status: 'done' }), 'b') === 'off')

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
