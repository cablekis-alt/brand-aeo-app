/**
 * scripts/proof-read.ts의 판독 규칙 검사 — 가짜 자료로 추정 · 지표 · 회차 · 칸 규칙을 확인한다(앱 데이터 · AI 호출 없음).
 * 최종 판독은 임시 폴더에 가짜 앱 데이터(회차 · 게시 기록 · 배정표)를 만들어 처음부터 끝까지 돌린다.
 *
 *   npx tsx scripts/verify-proof-read.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  articleIdOf,
  bootstrapCI,
  cellRule,
  finalRead,
  icc,
  indexDates,
  isHit,
  kstDay,
  mulberry32,
  ownedHost,
  periodOf,
  plannedAll,
  postKey,
  postKeysAt,
  REGISTERED_MODELS,
  regularRuns,
  riPValue,
  solve,
  twoWayFE,
  weekAfter,
  weightedFE,
  type QRows,
  type Row,
  type WRow,
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

// ── 최종 판독 부품 ──────────────────────────────────────────────────────────
check('연립방정식: 2×2를 풂', JSON.stringify(solve([[2, 1], [1, 3]], [3, 5])?.map((v) => Math.round(v * 1e9) / 1e9)) === '[0.8,1.4]')
check('연립방정식: 특이하면 null', solve([[1, 2], [2, 4]], [1, 2]) === null)
// 가중 · 처치 항 둘: y = 칸 + 회차 + 0.3·d1 − 0.1·d2, 가중이 칸마다 달라도 정확히 찾아야 한다.
const wrows: WRow[] = []
for (let c = 0; c < 10; c += 1) {
  for (let r = 0; r < 8; r += 1) {
    if ((c + r) % 7 === 3) continue
    const d1 = c < 4 && r >= 4 && r < 6 ? 1 : 0
    const d2 = c < 4 && r >= 6 ? 1 : 0
    wrows.push({ y: 0.2 * c + 0.03 * r + 0.3 * d1 - 0.1 * d2, d: [d1, d2], w: 1 + (c % 3), cell: `c${c}`, run: `r${r}` })
  }
}
const wb = weightedFE(wrows)
check('가중 고정효과: 처치 항 둘을 그대로 찾음', wb !== null && near(wb[0] ?? null, 0.3, 1e-6) && near(wb[1] ?? null, -0.1, 1e-6), wb)
const wz = weightedFE(wrows.map((r) => ({ ...r, d: [r.d[0]!, 0] })))
check('가중 고정효과: 변동 없는 처치 항은 null, 나머지는 풂', wz !== null && wz[1] === null && wz[0] !== null, wz)
check('가중 고정효과: 빈 자료는 null', weightedFE([]) === null)
check('무작위화 추론: (θ 이상인 다시 뽑기 + 1) / (수 + 1)', JSON.stringify(riPValue(0.5, [0.1, 0.6, null, 0.5, -0.2])) === JSON.stringify({ p: 3 / 5, draws: 4 }))
const meta = (s: string, f: string) => ({ runId: 'x', startedAt: s, finishedAt: f })
check('게시 기준: 첫 글 전에 끝나면 사전', periodOf(meta('2026-11-23T01:00:00Z', '2026-11-23T01:05:00Z'), '2026-11-23T03:00:00Z', '2026-11-23T04:00:00Z') === 'pre')
check('게시 기준: 마지막 글 뒤에 시작하면 사후', periodOf(meta('2026-11-25T01:00:00Z', '2026-11-25T01:05:00Z'), '2026-11-23T03:00:00Z', '2026-11-23T04:00:00Z') === 'post')
check('게시 기준: 그 사이에 걸치면 뺌', periodOf(meta('2026-11-23T03:30:00Z', '2026-11-23T03:40:00Z'), '2026-11-23T03:00:00Z', '2026-11-23T04:00:00Z') === 'between')
check('게시 후 주: 6일 뒤 0주, 8일 뒤 1주', weekAfter(meta('2026-11-29T03:00:00Z', ''), '2026-11-23T04:00:00Z') === 0 && weekAfter(meta('2026-12-01T05:00:00Z', ''), '2026-11-23T04:00:00Z') === 1)
check('추가 글 id: 질문 id를 정렬해 +로', articleIdOf(['v5-p009', 'c1-011']) === 'topic:c1-011+v5-p009')
const idx = indexDates('url,date,google,bing\nhttps://cablekis.tistory.com/9,2026-11-25,N,N\nhttps://cablekis.tistory.com/9,2026-11-27,Y,N\nhttps://cablekis.tistory.com/9,2026-11-30,Y,Y\n')
check('색인 기록: 구글 색인이 처음 확인된 날', idx.get('cablekis.tistory.com/9') === '2026-11-27', [...idx])
const ledger = [
  { url: 'https://cablekis.tistory.com/1', recordedAt: '2026-11-23T03:00:00Z', removedAt: '2026-12-10T00:00:00Z', removedReason: 'taken-down' },
  { url: 'https://cablekis.tistory.com/manage/newpost', recordedAt: '2026-11-23T02:00:00Z', removedAt: '2026-11-23T02:01:00Z', removedReason: 'mistake' },
  { url: 'https://cablekis.tistory.com/2', recordedAt: '2026-11-23T03:00:00Z' },
]
check('올린 글 키: 내린 글은 내리기 전 회차까지 셈', postKeysAt(ledger, '2026-12-09T01:00:00Z').has('cablekis.tistory.com/1') && !postKeysAt(ledger, '2026-12-11T01:00:00Z').has('cablekis.tistory.com/1'))
check('올린 글 키: 잘못 적은 기록은 언제도 안 셈', !postKeysAt(ledger, '2026-11-23T02:00:30Z').has('cablekis.tistory.com/manage/newpost'))
check('올린 글 키: 살아 있는 글은 늘 셈', postKeysAt(ledger, '2026-12-28T01:00:00Z').has('cablekis.tistory.com/2'))

// ── 최종 판독: 가짜 앱 데이터로 처음부터 끝까지 ──────────────────────────────
const ENGINES = ['openai', 'gemini', 'perplexity']
const POOL = Array.from({ length: 12 }, (_, i) => `q${String(i + 1).padStart(2, '0')}`)
const R1 = [['q01', 'q02'], ['q03', 'q04']]
const R2 = [['q05', 'q06'], ['q07', 'q08']]
const URL = (brand: string, ids: string[]) => `https://cablekis.tistory.com/${brand}-${ids.join('-')}`
const writeJson = (p: string, v: unknown) => {
  mkdirSync(path.dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(v, null, 2))
}
type Tag = 'model' | 'engine' | 'gemini-out'
function runDates(): { date: string; tag?: Tag }[] {
  const out: { date: string; tag?: Tag }[] = []
  for (let t = Date.parse('2026-11-02T00:00:00Z'); t <= Date.parse('2026-12-28T00:00:00Z'); t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10)
    const wd = new Date(t).getUTCDay()
    if (date === '2026-11-11') continue // 수요일 실패 → 목요일 보충
    if (date === '2026-11-12') out.push({ date })
    else if ([1, 3, 5].includes(wd)) out.push({ date, tag: date === '2026-11-16' ? 'model' : date === '2026-11-18' ? 'engine' : date === '2026-11-20' ? 'gemini-out' : undefined })
  }
  return out
}
function fixture(effect: boolean): { dataDir: string; design: { brands: { tenantId: string; bankVersion: string; metric: { ownedDomains: string[] } }[] }; assignment: { brands: unknown[] } } {
  const root = mkdtempSync(path.join(tmpdir(), 'proof-final-'))
  const dataDir = path.join(root, 'data')
  const rand = mulberry32(effect ? 11 : 12)
  const brands = ['fake-a', 'fake-b']
  const assignment = { brands: [] as unknown[] }
  for (const brand of brands) {
    const dir = path.join(dataDir, brand)
    writeJson(path.join(dir, 'question-bank', 'v1.json'), {
      version: 'v1',
      questions: [
        ...POOL.map((id, i) => ({ questionId: id, text: id, category: 'category-agnostic', containsBrandName: false, ...(i % 2 ? { probe: true } : {}) })),
        { questionId: 'h01', text: 'h01', category: 'category-agnostic', containsBrandName: false, probe: true, paraphraseOf: 'q01' },
      ],
    })
    const units = [...POOL.slice(0, 8).map((id) => [id]), ['q09', 'q10'], ['q11'], ['q12']]
    const labels = '00001111222'
    const alternativeLabels = Array.from({ length: 300 }, () => {
      const a = labels.split('')
      for (let i = a.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rand() * (i + 1))
        ;[a[i], a[j]] = [a[j]!, a[i]!]
      }
      return a.join('')
    })
    assignment.brands.push({
      tenantId: brand,
      bankVersion: 'v1',
      pool: POOL.map((id, i) => ({ id, probe: i % 2 === 1 })),
      units: units.map((ids) => ({ name: ids.join('+'), ids })),
      probabilities: units.map((ids) => ({ unit: ids.join('+'), round1: 1 / 3, round2: 1 / 3, control: 1 / 3 })),
      labels,
      rounds: [
        { arm: 'round1', questionIds: R1.flat(), articles: R1.map((ids) => ({ questionIds: ids, channel: '티스토리' })), holdoutSources: ['q01'] },
        { arm: 'round2', questionIds: R2.flat(), articles: R2.map((ids) => ({ questionIds: ids, channel: '티스토리' })), holdoutSources: [] },
      ],
      controlIds: ['q09', 'q10', 'q11', 'q12'],
      analysisUnits: [...R1, ...R2, ['q09', 'q10'], ['q11'], ['q12']],
      alternativeLabels,
    })
    const post = (ids: string[], at: string, extra: Record<string, unknown> = {}) => ({ url: URL(brand, ids), recordedAt: at, articleId: articleIdOf(ids), ...extra })
    writeJson(path.join(dir, 'published-posts.json'), {
      posts: [
        post(R1[0]!, '2026-11-20T02:00:00Z', { removedAt: '2026-11-20T02:01:00Z', removedReason: 'mistake' }),
        post(R1[0]!, '2026-11-23T03:00:00Z'),
        post(R1[1]!, '2026-11-23T03:10:00Z'),
        post(R2[0]!, '2026-12-07T03:00:00Z'),
        post(R2[1]!, '2026-12-07T03:10:00Z'),
      ],
    })
    writeJson(path.join(dir, 'extra-articles.json'), {
      articles: [
        ...[...R1, ...R2].map((ids) => ({ id: articleIdOf(ids), createdAt: '2026-11-20T00:00:00Z' })),
        { id: articleIdOf(['q09', 'q11']), createdAt: '2026-11-10T00:00:00Z' },
      ],
    })
    for (const { date, tag } of runDates()) {
      const startedAt = `${date}T01:00:00Z`
      const runId = `${date}T01-05-00-000Z`
      const runDir = path.join(dir, '2026-W99', 'runs', runId)
      writeJson(path.join(runDir, 'run.json'), {
        runId,
        startedAt,
        finishedAt: `${date}T01:05:00Z`,
        selfOnly: true,
        engines: Object.fromEntries(ENGINES.map((e) => [e, { planned: 13, succeeded: 13 }])),
      })
      writeJson(path.join(runDir, 'scorecard.json'), {
        questionBankVersion: 'v1',
        judgeModel: REGISTERED_MODELS.judgeModel,
        modelsUsed:
          tag === 'model'
            ? { ...REGISTERED_MODELS.modelsUsed, gemini: 'gemini-9' }
            : tag === 'gemini-out'
              ? { openai: REGISTERED_MODELS.modelsUsed.openai, perplexity: REGISTERED_MODELS.modelsUsed.perplexity }
              : REGISTERED_MODELS.modelsUsed,
      })
      const analyses = []
      for (const e of ENGINES) {
        for (const q of [...POOL, 'h01']) {
          if (tag === 'engine' && e === 'perplexity' && q > 'q06') continue
          if (tag === 'gemini-out' && e === 'gemini') continue
          if (q === 'h01' && date === '2026-11-02') continue // 홀드아웃은 첫 회차 뒤에 덧붙였다
          const r1 = R1.flat().includes(q) || q === 'h01'
          const r2 = R2.flat().includes(q)
          const after = (r1 && date > '2026-11-23') || (r2 && date > '2026-12-07')
          const boosted = effect && after && (e === 'gemini' || (e === 'openai' && rand() < 0.5))
          const viaCitation = boosted && e === 'openai'
          const hit = boosted || rand() < 0.02
          analyses.push({
            questionId: q,
            engine: e,
            mentioned: hit && !viaCitation,
            citations: viaCitation ? [{ raw: URL(brand, R1.find((ids) => ids.includes(q)) ?? R2.find((ids) => ids.includes(q)) ?? [q]), domain: 'cablekis.tistory.com' }] : [],
          })
        }
      }
      writeJson(path.join(runDir, 'question-analyses.json'), analyses)
    }
  }
  return {
    dataDir,
    design: { brands: brands.map((b) => ({ tenantId: b, bankVersion: 'v1', metric: { ownedDomains: [`${b}.example`] } })) },
    assignment,
  }
}
/** 색인 기록 — 2차의 두 번째 글(q07 · q08)은 끝까지 색인되지 않는다. */
const indexLog = () =>
  ['url,date,google,bing', ...['fake-a', 'fake-b'].flatMap((b) => [`${URL(b, R1[0]!)},2026-11-25,Y,N`, `${URL(b, R1[1]!)},2026-11-25,Y,N`, `${URL(b, R2[0]!)},2026-12-09,Y,N`])].join('\n')

const fx = fixture(true)
const res = finalRead({ ...fx, assignment: fx.assignment as never, until: '2026-12-28', reps: 300, indexLogCsv: indexLog() })
const fa = res.brands.find((b) => b.tenantId === 'fake-a')!
check('최종: 두 스택 모두 생김', JSON.stringify(res.stacks) === '["A","B"]', res.stacks)
check('최종: 게시 시각은 잘못 적은 기록을 빼고 가장 이른 기록', fa.rounds.A?.first === '2026-11-23T03:00:00Z' && fa.rounds.A?.last === '2026-11-23T03:10:00Z', fa.rounds)
check('최종: 모델이 다른 회차는 뺌', fa.runs.some((r) => r.runId.startsWith('2026-11-16') && r.excluded?.startsWith('모델 다름')), fa.runs.filter((r) => r.excluded))
check('최종: 대상 질문 10% 넘게 빠진 엔진만 뺌', fa.runs.some((r) => r.runId.startsWith('2026-11-18') && !r.excluded && r.droppedEngines.join() === 'perplexity'))
check('최종: 엔진 하나가 통째로 빠져도 회차는 남기고 그 엔진만 뺌', fa.runs.some((r) => r.runId.startsWith('2026-11-20') && !r.excluded && r.droppedEngines.join() === 'gemini'), fa.runs.filter((r) => r.runId.startsWith('2026-11-20')))
check('최종: 수요일 대신 목요일 회차가 보충', fa.runs.some((r) => r.runId.startsWith('2026-11-12') && r.supplement && r.scheduled === '2026-11-11'))
check('최종: 배정표에 없는 추가 글을 알림', res.warnings.some((w) => w.includes(articleIdOf(['q09', 'q11']))), res.warnings)
check('최종: 심은 효과 → θ가 크게 양수', res.theta !== null && res.theta > 0.2, res.theta)
check('최종: 무작위화 추론 p < 0.025', res.ri !== null && res.ri.p < 0.025, res.ri)
check('최종: 부트스트랩 구간 하한 > 0', res.ci !== null && res.ci.lo > 0, res.ci)
check('최종: 칸 규칙 — 처치 칸 2개 이상 · 대조 칸 1개 이하', res.cells.treated.length >= 2 && res.cells.control.length <= 1, { t: res.cells.treated.length, c: res.cells.control })
check('최종: 게시 후 1주 · 2주 계수 모두 > 0', res.decision.weeks, res.weekly)
check('최종: 「효과 있음」', res.decision.effect, res.decision)
check(
  '최종: 색인 기록이 없는 2차 글의 질문은 민감도에서 뺌, θ는 양수',
  res.sensitivity !== null && res.sensitivity.theta !== null && res.sensitivity.theta > 0 && res.sensitivity.droppedQuestions.filter((q) => q.includes('fake-a')).sort().join() === 'B|fake-a|q07,B|fake-a|q08',
  res.sensitivity,
)
const h = res.holdouts.find((x) => x.brand === 'fake-a' && x.holdout === 'h01')
check('최종: 홀드아웃은 원래 질문의 스택(1차)으로 사전 · 사후를 셈', h !== undefined && h.stack === 'A' && h.holdoutPre.responses > 0 && h.holdoutPost.responses > 0, h)
check('최종: 원래 질문은 홀드아웃과 같은 회차 · 엔진 응답만 견줌', h !== undefined && h.sourcePre.responses === h.holdoutPre.responses && h.sourcePost.responses === h.holdoutPost.responses, h)

const fx0 = fixture(false)
const res0 = finalRead({ ...fx0, assignment: fx0.assignment as never, until: '2026-12-28', reps: 300 })
check('최종(효과 없음): θ가 0 가까이', res0.theta !== null && Math.abs(res0.theta) < 0.05, res0.theta)
check('최종(효과 없음): 「효과 있음」 아님', !res0.decision.effect, res0.decision)
const mid = finalRead({ ...fx, assignment: fx.assignment as never, until: '2026-12-07', reps: 200 })
check('최종(12-07 중간): 2차 게시 전이면 스택 A만', JSON.stringify(mid.stacks) === '["A"]', mid.stacks)

console.log(failed ? `\n${failed}건 실패 · ${passed}건 통과` : `\n모두 통과(${passed}건)`)
if (failed) process.exit(1)
