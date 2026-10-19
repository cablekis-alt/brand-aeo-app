/**
 * 「지난 기록에서도 빼기」(경쟁사 편집 3단계)를 확인한다 — 코호트 제외 목록(server/cohortExclusionStore.ts), 순위 미리보기 ·
 * 저장 · 되돌리기 · 다시 세기(server/competitorEditor.ts), 같은 주 재측정 해제(trimRemeasured). 임시 폴더를 APP_DATA_DIR로 쓰고
 * 가짜 카드만 만든다. AI는 부르지 않는다.
 *
 * 왜: 지난 주차 순위는 고객 보고서에 나간 숫자다. 미리 본 순위와 저장된 순위가 다르거나, 되돌려도 원래대로 돌아오지 않거나,
 * 다른 고객이 재는 경쟁사를 빼면 그 고객의 순위표가 몰래 바뀐다.
 *
 *   npx tsx scripts/verify-cohort-exclusion.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'verify-cohort-exclusion-'))
process.env.APP_DATA_DIR = dir
process.env.BLOB_READ_WRITE_TOKEN = ''
process.env.BLOB_STORE_ID = ''
process.env.PIPELINE_CRON = ''

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])
async function rejects(p: Promise<unknown>, status: number): Promise<boolean> {
  try {
    await p
    return false
  } catch (err) {
    return (err as { status?: number }).status === status
  }
}
const writeRaw = (rel: string, text: string) => {
  const file = path.join(dir, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}
const writeJson = (rel: string, value: unknown) => writeRaw(rel, JSON.stringify(value))

try {
  const ex = await import('../server/cohortExclusionStore')
  const ed = await import('../server/competitorEditor')
  const reg = await import('../server/tenantRegistry')
  const rank = await import('../server/cohortRank')
  const tracker = await import('../server/measureTracker')
  const { slugFromName } = await import('../server/cohortPlan')
  const { FileResultStore } = await import('../server/store')
  const store = new FileResultStore()

  // ── 1) 제외 목록 파일 ──────────────────────────────────────────────
  ok('파일이 없으면 빈 목록', (await ex.readCohortExclusions()).length === 0)
  writeRaw('cohort-exclusions.json', '{ not json')
  ok('깨진 파일은 읽을 때 빈 목록(순위 화면이 멈추지 않게)', (await ex.readCohortExclusions()).length === 0)
  let threw = false
  try {
    await ex.updateCohortExclusions((e) => e)
  } catch {
    threw = true
  }
  ok('깨진 파일은 쓸 때 덮지 않고 실패', threw)
  rmSync(path.join(dir, 'cohort-exclusions.json'))

  const e1 = { id: 'x', industry: '업', region: '지', tenantId: 't', untilWeek: '2026-W42', brandName: 'T', excludedAt: '', excludedBy: 'c' }
  const card = (weekOf: string, extra = {}) => ({ tenantId: 't', industry: '업', region: '지', weekOf, ...extra })
  ok('untilWeek는 포함', ex.isExcluded([e1], card('2026-W42')) && ex.isExcluded([e1], card('2026-W30')) && !ex.isExcluded([e1], card('2026-W43')))
  ok('fromWeek가 있으면 그 주부터', ex.isExcluded([{ ...e1, fromWeek: '2026-W42' }], card('2026-W42')) && !ex.isExcluded([{ ...e1, fromWeek: '2026-W42' }], card('2026-W41')))
  ok('지역 문자열이 다르면(영어 질문 꼬리표 등) 걸리지 않는다', !ex.isExcluded([e1], card('2026-W42', { region: '지 (영어 질문)' })) && !ex.isExcluded([e1], card('2026-W42', { tenantId: 'u' })))

  // ── 2) 같은 주 재측정 해제 ────────────────────────────────────────
  const tr = ex.trimRemeasured([e1, { ...e1, id: 'y', fromWeek: '2026-W42' }, { ...e1, id: 'z', tenantId: 'other' }], [card('2026-W42')])
  ok('다시 넣어 잰 주부터 다시 센다(untilWeek를 그 전 주로)', tr.entries.find((e) => e.id === 'x')?.untilWeek === '2026-W41')
  ok('그 주만 뺀 항목은 지운다', !tr.entries.some((e) => e.id === 'y') && tr.trimmed.some((t) => t.entry.id === 'y' && t.removed))
  ok('다른 브랜드 항목은 그대로', tr.entries.some((e) => e.id === 'z' && e.untilWeek === '2026-W42'))
  ok('범위 밖 주에 잰 것은 풀지 않는다', ex.trimRemeasured([e1], [card('2026-W43')]).trimmed.length === 0)

  // ── 3) 가짜 코호트 — 고객 + 경쟁사 6곳, W41 · W42 ─────────────────────
  const runtime0 = await reg.loadRuntimeTenants()
  const repo = runtime0.find((t) => !t.cohortOnly && t.competitors.length >= 3 && t.autoCohort !== false)!
  const id = repo.tenantId
  const pastName = '가짜예전펜션'
  const X = slugFromName(pastName)
  // 점수 20 / 3 / 1(고객) / 0 / 0 / 0 / 0(X) — 고객 3/7, X를 빼면 3/6. 가짜 경쟁사 id는 지금 목록에 없다.
  const scores: [string, string, number][] = [
    ['fake-a', '가짜A', 20],
    ['fake-b', '가짜B', 3],
    [id, repo.brandName, 1],
    ['fake-c', '가짜C', 0],
    ['fake-d', '가짜D', 0],
    ['fake-e', '가짜E', 0],
    [X, pastName, 0],
  ]
  const weeks = ['2026-W41', '2026-W42']
  for (const [tid, name, score] of scores) {
    const history = weeks.map((weekOf) => ({
      tenantId: tid,
      brandName: name,
      weekOf,
      industry: repo.industry,
      region: repo.region,
      aeoScore: { current: score, ciLow: 0, ciHigh: score },
      mentionRate: 0,
      brandOwnedCitationRate: 0,
      cohortRank: { position: 1, totalTenants: 1 },
    }))
    writeJson(`data/${tid}/scorecard-history.json`, history)
  }
  for (const w of weeks) await rank.reconcileCohortRanks(store, repo.industry, repo.region, w)
  const ranksOf = async () =>
    Object.fromEntries(
      await Promise.all(
        scores.map(async ([tid]) => [tid, (await store.getScorecardHistory(tid, 10)).map((c) => c.cohortRank)] as const),
      ),
    )
  const snapshot0 = JSON.stringify(await ranksOf())
  const custRank = async (w: string) => (await store.getScorecardHistory(id, 10)).find((c) => c.weekOf === w)!.cohortRank
  ok('준비: 고객 3/7', (await custRank('2026-W42')).position === 3 && (await custRank('2026-W42')).totalTenants === 7)

  // ── 4) 예전 경쟁사 · 미리보기 ─────────────────────────────────────
  const s0 = await ed.buildEditorState(repo, runtime0, store)
  const pastX = s0.past.find((p) => p.tenantId === X)
  ok('뺀 적 없는 예전 경쟁사로 보인다(뺀 범위 없음)', Boolean(pastX) && pastX!.excluded.length === 0 && pastX!.firstWeekOf === '2026-W41' && pastX!.lastWeekOf === '2026-W42')

  const p1 = await ed.planEdit(repo, runtime0, store, repo.competitors, { add: [{ tenantId: X }], restore: [] })
  const pv = p1.exclusion!
  ok('미리보기: 고객 주차별 3/7 → 3/6', pv.weeks.length === 2 && pv.weeks.every((w) => w.before?.position === 3 && w.before.totalTenants === 7 && w.after.position === 3 && w.after.totalTenants === 6))
  ok('미리보기: 범위 W41~W42 · 2주', pv.items[0]?.action === 'exclude' && pv.items[0].firstWeek === '2026-W41' && pv.items[0].untilWeek === '2026-W42' && pv.items[0].weeks === 2 && !pv.items[0].fromWeek)
  ok('미리보기: 다시 쓸 카드 = 남는 6곳 × 2주', pv.cardsRewritten === 12 && pv.locked.length === 0)
  ok('미리보기는 쓰지 않는다', JSON.stringify(await ranksOf()) === snapshot0 && (await ex.readCohortExclusions()).length === 0)
  ok('목록에 남은 경쟁사는 뺄 수 없다', (await ed.planEdit(repo, runtime0, store, repo.competitors, { add: [{ tenantId: id }], restore: [] })).errors.length > 0)
  ok('그 주 기록이 없으면 그 주만 뺄 수 없다', (await ed.planEdit(repo, runtime0, store, repo.competitors, { add: [{ tenantId: X, onlyWeek: '2026-W40' }], restore: [] })).errors.length > 0)

  // ── 5) 저장 = 미리보기 ───────────────────────────────────────────
  ok('목록도 지난 기록도 그대로면 400', await rejects(ed.saveEdit(id, store, { competitors: repo.competitors }), 400))
  ok('미리 본 결과와 다르면 409', await rejects(ed.saveEdit(id, store, { competitors: repo.competitors, pastOut: { add: [{ tenantId: X }], restore: [] }, previewKey: 'stale' }), 409))
  tracker.beginMeasureRun()
  ok('측정 중이면 409', await rejects(ed.saveEdit(id, store, { competitors: repo.competitors, pastOut: { add: [{ tenantId: X }], restore: [] }, previewKey: pv.key }), 409))
  tracker.endMeasureRun()
  const saved = await ed.saveEdit(id, store, { competitors: repo.competitors, summary: '지난 기록에서 빼기', pastOut: { add: [{ tenantId: X }], restore: [] }, previewKey: pv.key })
  const afterSave = await ranksOf()
  ok('저장된 고객 순위 = 미리보기(3/6)', weeks.every((w, i) => {
    const r = afterSave[id]![i]!
    return r.position === pv.weeks[i]!.after.position && r.totalTenants === pv.weeks[i]!.after.totalTenants && (r.tiedCount ?? 1) === pv.weeks[i]!.after.tiedCount
  }))
  const recount = await Promise.all(weeks.map((w) => rank.planCohortRanks(store, repo.industry, repo.region, w)))
  ok('저장 뒤 다시 세도 바뀔 카드가 없다(미리보기 = 저장)', recount.every((p) => p.cards.length === 6 && p.cards.every((c) => !c.changed)))
  ok('뺀 경쟁사 자신의 카드 순위는 그대로(지운 브랜드와 같다)', JSON.stringify(afterSave[X]) === JSON.stringify(JSON.parse(snapshot0)[X]))
  ok('예전 경쟁사에 뺀 범위가 붙는다', saved.past.find((p) => p.tenantId === X)?.excluded[0]?.untilWeek === '2026-W42' && saved.edit.undoAvailable)
  ok('순위표(코호트)에서 빠진다', (await store.getCohortScorecards(repo.industry, repo.region, '2026-W42')).every((c) => c.tenantId !== X))

  // ── 6) 되돌리기 · 다시 세기 ─────────────────────────────────────
  await ed.undoEdit(id, store)
  ok('되돌리면 순위가 처음과 같다', JSON.stringify(await ranksOf()) === snapshot0 && (await ex.readCohortExclusions()).length === 0)

  const pv2 = (await ed.planEdit(repo, runtime0, store, repo.competitors, { add: [{ tenantId: X }], restore: [] })).exclusion!
  await ed.saveEdit(id, store, { competitors: repo.competitors, pastOut: { add: [{ tenantId: X }], restore: [] }, previewKey: pv2.key })
  const pr = (await ed.planEdit(repo, await reg.loadRuntimeTenants(), store, repo.competitors, { add: [], restore: [X] })).exclusion!
  ok('다시 세기 미리보기: 3/6 → 3/7', pr.items[0]?.action === 'restore' && pr.weeks.every((w) => w.before?.totalTenants === 6 && w.after.totalTenants === 7))
  await ed.saveEdit(id, store, { competitors: repo.competitors, pastOut: { add: [], restore: [X] }, previewKey: pr.key })
  ok('다시 세면 순위가 처음과 같다', JSON.stringify(await ranksOf()) === snapshot0 && (await ex.readCohortExclusions()).length === 0)

  // ── 7) 그 주만 빼기 ──────────────────────────────────────────────
  const po = (await ed.planEdit(repo, runtime0, store, repo.competitors, { add: [{ tenantId: X, onlyWeek: '2026-W42' }], restore: [] })).exclusion!
  ok('W42만 빼기: W42만 바뀐다', po.weeks.length === 1 && po.weeks[0]!.weekOf === '2026-W42' && po.items[0]?.fromWeek === '2026-W42' && po.cardsRewritten === 6)
  await ed.saveEdit(id, store, { competitors: repo.competitors, pastOut: { add: [{ tenantId: X, onlyWeek: '2026-W42' }], restore: [] }, previewKey: po.key })
  ok('W42만 빼면 W41은 3/7 그대로, W42는 3/6', (await custRank('2026-W41')).totalTenants === 7 && (await custRank('2026-W42')).totalTenants === 6)

  // 같은 주 다시 넣어 재면 풀린다 — 측정이 하는 해제를 직접 부른다(trimRemeasured + reconcile)
  const trimmed = await ex.updateCohortExclusions((entries) => ex.trimRemeasured(entries, [{ tenantId: X, industry: repo.industry, region: repo.region, weekOf: '2026-W42' }]).entries)
  await rank.reconcileCohortRanks(store, repo.industry, repo.region, '2026-W42')
  ok('같은 주에 다시 넣어 재면 그 주 항목이 풀리고 다시 센다', trimmed.length === 0 && (await custRank('2026-W42')).totalTenants === 7)

  // ── 8) 지운 브랜드와 함께 ─────────────────────────────────────────
  const pv3 = (await ed.planEdit(repo, runtime0, store, repo.competitors, { add: [{ tenantId: X }], restore: [] })).exclusion!
  await ed.saveEdit(id, store, { competitors: repo.competitors, pastOut: { add: [{ tenantId: X }], restore: [] }, previewKey: pv3.key })
  writeJson('tenants.deleted.json', ['fake-e'])
  const both = await store.getCohortScorecards(repo.industry, repo.region, '2026-W42')
  ok('지운 브랜드와 뺀 경쟁사가 함께 빠진다', both.length === 5 && !both.some((c) => c.tenantId === X || c.tenantId === 'fake-e'))
  writeJson('tenants.deleted.json', [])

  // ── 9) 다른 고객이 그 경쟁사를 함께 재면 잠긴다 ────────────────────
  const restore4 = (await ed.planEdit(repo, runtime0, store, repo.competitors, { add: [], restore: [X] })).exclusion!
  await ed.saveEdit(id, store, { competitors: repo.competitors, pastOut: { add: [], restore: [X] }, previewKey: restore4.key })
  const other = { ...repo, tenantId: 'fake-other-customer', brandName: '가짜다른고객', aliases: ['가짜다른고객'], ownedDomains: ['fake-other.example'], competitors: [{ name: pastName, aliases: [pastName], domains: [] }] }
  writeJson('tenants.overlay.json', [other])
  const runtime1 = await reg.loadRuntimeTenants()
  const lockPlan = (await ed.planEdit(repo, runtime1, store, repo.competitors, { add: [{ tenantId: X }], restore: [] })).exclusion!
  ok('다른 고객이 함께 재면 잠긴다(미리보기)', lockPlan.locked.length === 1 && lockPlan.locked[0]!.by.includes('가짜다른고객'))
  ok('잠긴 경쟁사는 저장 409', await rejects(ed.saveEdit(id, store, { competitors: repo.competitors, pastOut: { add: [{ tenantId: X }], restore: [] }, previewKey: lockPlan.key }), 409))
  ok('잠겨서 아무것도 쓰지 않았다', JSON.stringify(await ranksOf()) === snapshot0)
  writeJson('tenants.overlay.json', [])
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
