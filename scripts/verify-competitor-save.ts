/**
 * 경쟁사 편집의 미리 계산·저장·되돌리기·저장소 설정으로 돌아가기를 확인한다(server/competitorEditor.ts).
 * 임시 폴더를 APP_DATA_DIR로 쓰고 가짜 질문지·가짜 기록만 만든다. AI는 부르지 않는다.
 *
 * 왜: 저장은 다음 측정의 경쟁사를 바꾼다. 측정 중에 저장되거나, 측정한 뒤에 되돌려지면 화면 숫자와 측정이
 * 어긋난다. 빠지는 경쟁사를 짚은 비교 질문은 그대로 남는다는 것도 저장 전에 알려야 한다.
 *
 *   npx tsx scripts/verify-competitor-save.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'verify-competitor-save-'))
process.env.APP_DATA_DIR = dir
process.env.BLOB_READ_WRITE_TOKEN = ''
process.env.BLOB_STORE_ID = ''

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
const writeJson = (rel: string, value: unknown) => {
  const file = path.join(dir, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value))
}

try {
  const ed = await import('../server/competitorEditor')
  const reg = await import('../server/tenantRegistry')
  const tracker = await import('../server/measureTracker')
  const { slugFromName } = await import('../server/cohortPlan')
  const { FileResultStore } = await import('../server/store')
  const store = new FileResultStore()

  // 저장소 설정의 고객 브랜드 하나(경쟁사 3곳 이상)로 시험한다 — 패키징 모드는 번들된 설정을 베이스로 쓴다.
  const runtime0 = await reg.loadRuntimeTenants()
  const repo = runtime0.find((t) => !t.cohortOnly && t.competitors.length >= 3 && t.autoCohort !== false)!
  const id = repo.tenantId
  const [c0, c1] = repo.competitors
  const v = repo.questionBankVersion
  const q = (questionId: string, text: string, category: string, cohortShared = false) => ({
    questionId, text, category, industry: repo.industry, region: repo.region, containsBrandName: !cohortShared, version: v, ...(cohortShared ? { cohortShared } : {}),
  })
  writeJson(`data/${id}/question-bank/${v}.json`, {
    version: v,
    generatedAt: '2026-01-01T00:00:00.000Z',
    questions: [
      q('c1-001', '가상 지역 좋은 곳 어디야?', 'category-agnostic', true),
      q(`${v}-001`, `${repo.brandName}이랑 ${c0.name} 중 어디가 더 나아?`, 'comparison'),
      q(`${v}-002`, `${repo.brandName} 가격 알려줘`, 'price-spec'),
    ],
  })
  const fresh = async () => (await reg.loadRuntimeTenants()).find((t) => t.tenantId === id)!

  // 1) 처음 상태
  const s0 = await ed.buildEditorState(repo, runtime0, store)
  ok('줄 수 = 경쟁사 수', s0.rows.length === repo.competitors.length)
  ok('첫 경쟁사에 비교 질문이 이어진다', s0.rows[0].questionIds.join() === `${v}-001`)
  ok('처음에는 앱에서 고친 목록이 없다', !s0.edit.active && !s0.edit.undoAvailable && s0.edit.repoCompetitors.length === repo.competitors.length)
  ok('질문지 정보', s0.questionBank.exists && s0.questionBank.sharedCount === 1 && s0.questionBank.brandCount === 2)

  // 2) 미리 계산 — 첫 경쟁사 빼기
  const dropFirst = repo.competitors.slice(1)
  const p1 = await ed.planEdit(repo, runtime0, store, dropFirst)
  ok('빠지는 경쟁사와 그 비교 질문', p1.leaving.length === 1 && p1.leaving[0].name === c0.name && p1.leaving[0].questionIds.join() === `${v}-001`)
  ok('비교 질문이 빠진 경쟁사를 계속 묻는다고 알린다', p1.notes.some((n) => n.includes(`묻는 질문(${v}-001)이 남아요`) && n.includes(c0.name)))
  ok('바뀜으로 본다', !p1.unchanged && p1.errors.length === 0)
  ok('같은 목록이면 바뀐 것 없음', (await ed.planEdit(repo, runtime0, store, repo.competitors)).unchanged)
  ok('잘못된 입력은 400', await rejects(ed.planEdit(repo, runtime0, store, []), 400))

  // 3) 저장 — 앞 두 경쟁사 순서 바꾸기
  const swapped = [c1, c0, ...repo.competitors.slice(2)]
  const s1 = await ed.saveEdit(id, store, { competitors: swapped, summary: '가상 요약' })
  ok('저장하면 앱에서 고친 목록을 쓴다', s1.edit.active && s1.competitors[0].name === c1.name)
  ok('저장 요약과 되돌리기 가능', s1.edit.summary === '가상 요약' && s1.edit.undoAvailable)
  ok('측정이 읽는 목록에도 반영된다', (await fresh()).competitors[0].name === c1.name)
  ok('같은 목록을 다시 저장하면 400', await rejects(ed.saveEdit(id, store, { competitors: swapped }), 400))
  ok('브랜드 현황 대기 표시', (await ed.pendingCompetitorEdit(id))?.summary === '가상 요약')

  // 4) 되돌리기
  const s2 = await ed.undoEdit(id, store)
  ok('되돌리면 저장소 설정으로', !s2.edit.active && s2.competitors[0].name === c0.name && (await fresh()).competitors[0].name === c0.name)
  ok('되돌린 뒤 또 되돌리면 409', await rejects(ed.undoEdit(id, store), 409))

  // 5) 저장한 뒤 측정했으면 되돌릴 수 없다
  await ed.saveEdit(id, store, { competitors: swapped })
  writeJson('measure-runs.json', [
    { tenantId: id, brandName: repo.brandName, weekOf: '2026-W01', aeoScore: 0, durationSec: 1, at: new Date(Date.now() + 60_000).toISOString() },
  ])
  ok('측정한 뒤에는 되돌리기 409', await rejects(ed.undoEdit(id, store), 409))
  ok('측정한 뒤에는 대기 표시가 사라진다', (await ed.pendingCompetitorEdit(id)) === null)
  rmSync(path.join(dir, 'measure-runs.json'))

  // 6) 저장소 설정으로 돌아가기 → 되돌리기
  const s3 = await ed.resetEdit(id, store)
  ok('돌아가기는 저장소 설정', !s3.edit.active && s3.competitors[0].name === c0.name)
  ok('돌아간 상태에서 또 돌아가기는 409', await rejects(ed.resetEdit(id, store), 409))
  const s4 = await ed.undoEdit(id, store)
  ok('돌아가기도 되돌릴 수 있다', s4.edit.active && s4.competitors[0].name === c1.name)

  // 7) 저장소 설정과 같은 목록을 저장하면 고친 목록을 지운다
  const s5 = await ed.saveEdit(id, store, { competitors: repo.competitors })
  ok('저장소 설정과 같으면 고친 목록 없음', !s5.edit.active && !s5.edit.stale)

  // 8) 측정 중에는 저장·되돌리기 409
  tracker.beginMeasureRun()
  ok('측정 중 저장 409', await rejects(ed.saveEdit(id, store, { competitors: swapped }), 409))
  ok('측정 중 되돌리기 409', await rejects(ed.undoEdit(id, store), 409))
  tracker.endMeasureRun()

  // 9) 지운 다른 업종 브랜드와 id가 같으면 넣을 수 없다
  const ghost = '가상 지운 통신사'
  const ghostId = slugFromName(ghost)
  writeJson('tenants.deleted.json', [ghostId])
  writeJson(`data/${ghostId}/scorecard-history.json`, [
    { tenantId: ghostId, brandName: ghost, industry: '가상 통신', region: '국내', weekOf: '2026-W01', aeoScore: { current: 1 }, mentionRate: 0, brandOwnedCitationRate: 0, cohortRank: { position: 1, totalTenants: 1 } },
  ])
  const withGhost = [...repo.competitors, { name: ghost, aliases: [ghost], domains: [] }]
  const p2 = await ed.planEdit(repo, await reg.loadRuntimeTenants(), store, withGhost)
  ok('지운 다른 업종 브랜드 → 저장을 막는 문제', p2.errors.length === 1 && p2.rows.at(-1)!.deletedOtherIndustry?.industry === '가상 통신')
  ok('그 목록 저장은 400', await rejects(ed.saveEdit(id, store, { competitors: withGhost }), 400))

  // 10) 공용 주소로 추가하면 알린다
  const p3 = await ed.planEdit(repo, await reg.loadRuntimeTenants(), store, [...repo.competitors, { name: '가상 블로그 펜션', domains: ['https://blog.naver.com/x'] }])
  ok('공용 주소는 이름으로 잰다고 알린다', p3.droppedHosts.includes('blog.naver.com') && p3.notes.some((n) => n.includes('공용 주소')))
  ok('정리한 목록에는 주소가 없다', p3.competitors.at(-1)!.domains.length === 0)
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
