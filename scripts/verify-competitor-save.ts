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
  const fileStore = await import('../server/tenantCompetitorsStore')
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
  ok('브랜드 현황 대기 표시', (await ed.pendingCompetitorEdit(await fresh()))?.summary === '가상 요약')

  // 4) 되돌리기
  const s2 = await ed.undoEdit(id, store)
  ok('되돌리면 저장소 설정으로', !s2.edit.active && s2.competitors[0].name === c0.name && (await fresh()).competitors[0].name === c0.name)
  ok('되돌린 뒤 또 되돌리면 409', await rejects(ed.undoEdit(id, store), 409))

  // 5) 저장한 뒤 그 목록으로 측정했으면 되돌릴 수 없다 — 측정 기록은 competitors.json에 남는다(measureAndBake)
  await ed.saveEdit(id, store, { competitors: swapped })
  const later = new Date(Date.now() + 60_000).toISOString()
  await fileStore.recordCompetitorMeasurement(id, repo.competitors, later)
  ok('저장 뒤 옛 목록으로 잰 측정(저장과 시작이 겹침)은 되돌리기를 막지 않는다', (await ed.buildEditorState(await fresh(), await reg.loadRuntimeTenants(), store)).edit.undoAvailable)
  ok('옛 목록으로 쟀으면 여전히 「다음 측정 대기」', (await ed.pendingCompetitorEdit(await fresh())) !== null)
  await fileStore.recordCompetitorMeasurement(id, swapped, later)
  ok('새 목록으로 측정한 뒤에는 되돌리기 409', await rejects(ed.undoEdit(id, store), 409))
  ok('새 목록으로 측정한 뒤에는 대기 표시가 사라진다', (await ed.pendingCompetitorEdit(await fresh())) === null)
  // 측정 완료 로그(measure-runs.json)는 보지 않는다 — 50건에서 잘리고 다른 고객의 경쟁사로 잰 측정도 섞인다.
  writeJson('measure-runs.json', [])
  ok('측정 로그가 비어도 판단이 바뀌지 않는다', (await ed.pendingCompetitorEdit(await fresh())) === null)

  // 5-b) 두 번 저장한 뒤 되돌려도, 아직 재지 않은 목록이면 대기 표시가 남는다
  const third = [c0, ...repo.competitors.slice(2), c1]
  await ed.saveEdit(id, store, { competitors: third })
  await ed.saveEdit(id, store, { competitors: [c1, ...repo.competitors.slice(2), c0] })
  const s5b = await ed.undoEdit(id, store)
  ok('되돌린 뒤 목록은 앞 저장', s5b.competitors.at(-1)!.name === c1.name)
  ok('앞 저장도 아직 재지 않았으면 대기 표시가 남는다', (await ed.pendingCompetitorEdit(await fresh())) !== null)
  await ed.saveEdit(id, store, { competitors: swapped })

  // 6) 저장소 설정으로 돌아가기 → 되돌리기
  const s3 = await ed.resetEdit(id, store)
  ok('돌아가기는 저장소 설정', !s3.edit.active && s3.competitors[0].name === c0.name)
  ok('돌아간 상태에서 또 돌아가기는 409', await rejects(ed.resetEdit(id, store), 409))
  const s4 = await ed.undoEdit(id, store)
  ok('돌아가기도 되돌릴 수 있다', s4.edit.active && s4.competitors[0].name === c1.name)

  // 7) 저장소 설정과 같은 목록을 저장하면 고친 목록을 지운다
  const s5 = await ed.saveEdit(id, store, { competitors: repo.competitors })
  ok('저장소 설정과 같으면 고친 목록 없음', !s5.edit.active && !s5.edit.stale)

  // 8) 측정 중에는 저장·되돌리기 409, 미리 계산은 측정 중이라고 알린다
  tracker.beginMeasureRun()
  ok('측정 중 저장 409', await rejects(ed.saveEdit(id, store, { competitors: swapped }), 409))
  ok('측정 중 되돌리기 409', await rejects(ed.undoEdit(id, store), 409))
  ok('측정 중이면 미리 계산에 measuring', (await ed.planEdit(await fresh(), await reg.loadRuntimeTenants(), store, swapped)).measuring)
  tracker.endMeasureRun()
  ok('측정이 끝나면 measuring false', !(await ed.planEdit(await fresh(), await reg.loadRuntimeTenants(), store, swapped)).measuring)

  // 8-b) 저장소 설정이 바뀌어 쓰이지 않는 고친 목록 — 대기 표시도, 돌아가기도 없다
  await ed.saveEdit(id, store, { competitors: swapped })
  writeJson(`data/${id}/competitors.json`, {
    current: { competitors: swapped, base: 'old-base' },
    lastSave: { savedAt: new Date().toISOString(), before: null, summary: '쓰이지 않는 편집' },
    measured: { at: null, listHash: 'x' },
  })
  ok('쓰이지 않는 고친 목록은 대기 표시가 없다', (await ed.pendingCompetitorEdit(await fresh())) === null)
  ok('쓰이지 않는 고친 목록에서 돌아가기는 409', await rejects(ed.resetEdit(id, store), 409))
  rmSync(path.join(dir, 'data', id, 'competitors.json'))

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

  // 11) 고객 자신의 이름은 넣을 수 없고, 같은 업종에 등록된 브랜드 이름이면 그 홈페이지로 잇는다
  const runtime = await reg.loadRuntimeTenants()
  const p4 = await ed.planEdit(repo, runtime, store, [...repo.competitors, { name: repo.brandName.replace(/\s+/g, ' ') }])
  ok('고객 자신의 이름 → 저장을 막는 문제', p4.errors.some((e) => e.includes('자신이에요')))
  const sibling = runtime.find((t) => t.tenantId !== id && t.industry === repo.industry && (t.questionLanguage ?? 'ko') === (repo.questionLanguage ?? 'ko') && t.ownedDomains.length > 0 && !repo.competitors.some((c) => c.name.replace(/\s+/g, '') === t.brandName.replace(/\s+/g, '')))
  if (sibling) {
    const p5 = await ed.planEdit(repo, runtime, store, [...repo.competitors, { name: sibling.brandName }])
    ok('등록된 브랜드 이름이면 그 홈페이지로 잇는다', p5.competitors.at(-1)!.domains[0] === sibling.ownedDomains[0] && p5.notes.some((n) => n.includes('이어 재요')))
  } else {
    ok('같은 업종 등록 브랜드(시험 대상)가 있어야 한다', false)
  }
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
