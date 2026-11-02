/**
 * scripts/proof-read.ts의 판독 규칙 검사 — 가짜 자료로 추정 · 지표 · 회차 · 칸 규칙을 확인한다(앱 데이터 · AI 호출 없음).
 *
 *   npx tsx scripts/verify-proof-read.ts
 */
import {
  bootstrapCI,
  cellRule,
  icc,
  isHit,
  kstDay,
  mulberry32,
  ownedHost,
  plannedAll,
  postKey,
  regularRuns,
  twoWayFE,
  type QRows,
  type Row,
} from './proof-read'

let failed = 0
let passed = 0
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1
    console.log(`✓ ${name}`)
  } else {
    failed += 1
    console.log(`✗ ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}
const near = (a: number | null, b: number, eps = 1e-9) => a !== null && Math.abs(a - b) < eps

// ── 추정 ────────────────────────────────────────────────────────────────────
// 칸 효과 + 회차 효과 + θ · 처치×사후, 잡음 없음 → θ가 정확히 나와야 한다(고르지 않은 패널 포함).
function panel(theta: number, drop: (cell: number, run: number) => boolean): Row[] {
  const rows: Row[] = []
  for (let c = 0; c < 12; c += 1) {
    for (let r = 0; r < 10; r += 1) {
      if (drop(c, r)) continue
      const treated = c < 5
      const postRun = r >= 6
      const d = treated && postRun ? 1 : 0
      rows.push({ y: 0.1 * (c % 4) + 0.05 * r + theta * d, d, cell: `c${c}`, run: `r${r}` })
    }
  }
  return rows
}
check('고정효과: 고른 패널에서 θ를 그대로 찾음', near(twoWayFE(panel(0.3, () => false)), 0.3, 1e-8), twoWayFE(panel(0.3, () => false)))
const ragged = panel(-0.12, (c, r) => (c * 7 + r * 3) % 5 === 0)
check('고정효과: 응답이 빠진 패널에서도 θ를 그대로 찾음', near(twoWayFE(ragged), -0.12, 1e-6), twoWayFE(ragged))
check('고정효과: 처치 변동이 없으면 null', twoWayFE(panel(0, () => false).map((r) => ({ ...r, d: 0 }))) === null)
check('고정효과: 빈 자료는 null', twoWayFE([]) === null)

// 잡음 없는 자료의 부트스트랩은 모든 재표집이 같은 θ — 구간이 θ 한 점.
const units: QRows[] = []
for (const r of panel(0.2, () => false)) {
  const c = Number(r.cell.slice(1))
  const key = r.cell
  let u = units.find((x) => x.question === key)
  if (!u) {
    u = { stratum: c < 5 ? 'treated' : 'control', question: key, rows: [] }
    units.push(u)
  }
  u.rows.push(r)
}
const ci = bootstrapCI(units, 200, 7)
check('부트스트랩: 잡음 없는 자료면 구간이 θ 한 점', ci !== null && near(ci.lo, 0.2, 1e-6) && near(ci.hi, 0.2, 1e-6), ci)
check('부트스트랩: 같은 시드면 같은 구간', JSON.stringify(bootstrapCI(units, 200, 7)) === JSON.stringify(ci))

// 잡음이 있는 자료 — 구간이 참값을 감싸고, 위아래가 다름.
const rand = mulberry32(42)
const noisy: QRows[] = []
for (let q = 0; q < 30; q += 1) {
  const treated = q < 12
  const base = 0.05 + 0.1 * rand()
  const rows: Row[] = []
  for (let e = 0; e < 3; e += 1) {
    for (let r = 0; r < 12; r += 1) {
      const postRun = r >= 6
      const p = base + (treated && postRun ? 0.25 : 0)
      rows.push({ y: rand() < p ? 1 : 0, d: treated && postRun ? 1 : 0, cell: `q${q}|e${e}`, run: `r${r}` })
    }
  }
  noisy.push({ stratum: treated ? 'treated' : 'control', question: `q${q}`, rows })
}
const noisyTheta = twoWayFE(noisy.flatMap((u) => u.rows))
const noisyCi = bootstrapCI(noisy, 500, 3)
check('부트스트랩: 잡음 자료에서 구간이 추정치를 감쌈', noisyCi !== null && noisyTheta !== null && noisyCi.lo < noisyTheta && noisyTheta < noisyCi.hi, { noisyTheta, noisyCi })
check('부트스트랩: 효과 0.25 자료에서 구간 하한이 0보다 큼', noisyCi !== null && noisyCi.lo > 0, noisyCi)

// ── ICC ─────────────────────────────────────────────────────────────────────
check('ICC: 질문 안 값이 모두 같고 질문끼리 다르면 1', near(icc([[1, 1, 1], [0, 0, 0], [1, 1, 1], [0, 0, 0]]), 1))
check('ICC: 질문이 하나면 null', icc([[1, 0, 1]]) === null)
const iid: number[][] = Array.from({ length: 40 }, () => Array.from({ length: 30 }, () => (rand() < 0.3 ? 1 : 0)))
const iidIcc = icc(iid)
check('ICC: 서로 독립인 자료면 0 가까이', iidIcc !== null && Math.abs(iidIcc) < 0.05, iidIcc)

// ── 지표 ────────────────────────────────────────────────────────────────────
check('주소: 호스트 대소문자 · www. · 질의 · 조각 · 끝 / 무시', postKey('https://www.Cablekis.tistory.com/7/?category=3#c') === 'cablekis.tistory.com/7', postKey('https://www.Cablekis.tistory.com/7/?category=3#c'))
check('주소: 티스토리 모바일 /m/ 경로는 같은 글', postKey('https://cablekis.tistory.com/m/7') === 'cablekis.tistory.com/7')
check('주소: 일반 사이트 질의도 뗌(§7)', postKey('https://co.webforai.kr/s/stay?ref=x') === 'co.webforai.kr/s/stay')
check('주소: 주소가 아니면 null', postKey('not a url') === null)
check('자사 도메인: 같은 호스트', ownedHost('co.webforai.kr', ['co.webforai.kr']))
check('자사 도메인: 하위 도메인 포함', ownedHost('m.gunsan.webforai.kr', ['gunsan.webforai.kr']))
check('자사 도메인: 이름만 겹치는 다른 호스트는 아님', !ownedHost('notco.webforai.kr', ['co.webforai.kr']))
check('자사 도메인: 상위 도메인은 아님', !ownedHost('webforai.kr', ['co.webforai.kr']))
const owned = ['co.webforai.kr']
const posts = new Set(['cablekis.tistory.com/7'])
check('적중: 언급', isHit({ questionId: 'q', engine: 'e', mentioned: true, citations: [] }, owned, posts))
check('적중: 자사 도메인 인용(domain 칸)', isHit({ questionId: 'q', engine: 'e', citations: [{ domain: 'www.co.webforai.kr' }] }, owned, posts))
check('적중: 자사 도메인 인용(주소만)', isHit({ questionId: 'q', engine: 'e', citations: [{ raw: 'https://co.webforai.kr/s/stay' }] }, owned, posts))
check('적중: 올린 글 주소 인용', isHit({ questionId: 'q', engine: 'e', citations: [{ raw: 'https://cablekis.tistory.com/m/7?x=1', domain: 'cablekis.tistory.com' }] }, owned, posts))
check(
  '적중 아님: 같은 티스토리의 다른 글',
  !isHit({ questionId: 'q', engine: 'e', citations: [{ raw: 'https://cablekis.tistory.com/6', domain: 'cablekis.tistory.com' }] }, owned, posts),
)
check('적중 아님: 언급 없고 인용 없음', !isHit({ questionId: 'q', engine: 'e', mentioned: false }, owned, posts))

// ── 회차 ────────────────────────────────────────────────────────────────────
check('KST 날짜: UTC 15시는 다음 날', kstDay('2026-11-01T15:30:00Z').date === '2026-11-02' && kstDay('2026-11-01T15:30:00Z').weekday === 1)
const runs = [
  { runId: 'mon-am', startedAt: '2026-11-02T00:20:00Z', finishedAt: '2026-11-02T00:23:00Z', selfOnly: true, all: false },
  { runId: 'mon-pm', startedAt: '2026-11-02T05:27:00Z', finishedAt: '2026-11-02T05:29:00Z', selfOnly: true, all: true },
  { runId: 'mon-late', startedAt: '2026-11-02T08:00:00Z', finishedAt: '2026-11-02T08:02:00Z', selfOnly: true, all: true },
  { runId: 'tue', startedAt: '2026-11-03T01:00:00Z', finishedAt: '2026-11-03T01:02:00Z', selfOnly: true, all: true },
  { runId: 'wed-cohort', startedAt: '2026-11-04T01:00:00Z', finishedAt: '2026-11-04T01:05:00Z', selfOnly: false, all: true },
  { runId: 'wed', startedAt: '2026-11-04T02:00:00Z', finishedAt: '2026-11-04T02:02:00Z', selfOnly: true, all: true },
]
const regular = regularRuns(runs, (r) => r.all, '2026-11-02', '2026-11-04').map((p) => p.run.runId)
check('정규 회차: 월 · 수 · 금 날짜마다 처음 끝난 selfOnly · 대상 질문 모두 잰 회차 하나', JSON.stringify(regular) === JSON.stringify(['mon-pm', 'wed']), regular)
const withSupplement = [
  { runId: 'mon', startedAt: '2026-11-09T01:00:00Z', finishedAt: '2026-11-09T01:02:00Z', selfOnly: true, all: true },
  { runId: 'tue-extra', startedAt: '2026-11-10T01:00:00Z', finishedAt: '2026-11-10T01:02:00Z', selfOnly: true, all: true },
  { runId: 'thu-sup', startedAt: '2026-11-12T01:00:00Z', finishedAt: '2026-11-12T01:02:00Z', selfOnly: true, all: true },
  { runId: 'sun-sup', startedAt: '2026-11-15T01:00:00Z', finishedAt: '2026-11-15T01:02:00Z', selfOnly: true, all: true },
]
const picks = regularRuns(withSupplement, (r) => r.all, '2026-11-09', '2026-11-15')
check(
  '정규 회차: 수요일이 없으면 목요일, 금요일이 없으면 주말 회차가 보충(월요일이 있으면 화요일 회차는 안 씀)',
  JSON.stringify(picks.map((p) => [p.run.runId, p.scheduled, p.supplement])) ===
    JSON.stringify([['mon', '2026-11-09', false], ['thu-sup', '2026-11-11', true], ['sun-sup', '2026-11-13', true]]),
  picks.map((p) => [p.run.runId, p.scheduled, p.supplement]),
)
check(
  '정규 회차: until 뒤의 보충 회차는 안 씀',
  regularRuns(withSupplement, (r) => r.all, '2026-11-09', '2026-11-14').map((p) => p.run.runId).join(',') === 'mon,thu-sup',
)
check('계획 수: 엔진 계획 수 가운데 가장 큰 값이 기준 이상이면 대상 질문을 모두 계획', plannedAll({ runId: 'a', startedAt: '', finishedAt: '', engines: { openai: { planned: 58 }, gemini: { planned: 57 } } }, 58))
check('계획 수: 실증을 덧붙이기 전 회차(42문항)는 아님', !plannedAll({ runId: 'a', startedAt: '', finishedAt: '', engines: { openai: { planned: 42 } } }, 58))

// ── 칸 규칙 ─────────────────────────────────────────────────────────────────
check('칸 규칙: 사전 0 → 사후 6회 중 3회', cellRule([0, 0, 0, 0, 0, 0, 0], [1, 0, 1, 0, 1, 0]) === true)
check('칸 규칙: 사후 6회 중 2회는 아님', cellRule([0, 0, 0, 0, 0, 0], [1, 0, 1, 0, 0, 0]) === false)
check('칸 규칙: 사전 마지막 6회에 적중이 있으면 아님', cellRule([0, 0, 0, 1, 0, 0], [1, 1, 1, 1, 1, 1]) === false)
check('칸 규칙: 사전 마지막 6회만 봄(그 앞 적중은 무시)', cellRule([1, 0, 0, 0, 0, 0, 0], [1, 1, 1, 0, 0, 0]) === true)
check('칸 규칙: 사후 5회면 ⌈5/2⌉ = 3회', cellRule([0, 0, 0, 0], [1, 1, 0, 0, 0]) === false && cellRule([0, 0, 0, 0], [1, 1, 1, 0, 0]) === true)
check('칸 규칙: 사전이나 사후가 4회 미만이면 판정 제외', cellRule([0, 0, 0], [1, 1, 1, 1]) === null && cellRule([0, 0, 0, 0], [1, 1, 1]) === null)

console.log(failed ? `\n${failed}건 실패 · ${passed}건 통과` : `\n모두 통과(${passed}건)`)
if (failed) process.exit(1)
