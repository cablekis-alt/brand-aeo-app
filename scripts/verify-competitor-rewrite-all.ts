/**
 * 경쟁사 편집 5단계 — 「브랜드 질문 모두 새로 쓰기」 · 「질문지 그대로 두기」 저장과, 측정이 새로 만드는 질문지의 출처 표식 · 가드를
 * 확인한다. 임시 폴더를 APP_DATA_DIR로 쓰고 가짜 고객 · 가짜 질문지 · 모의 판정(USE_MOCK_ENGINES)만 쓴다.
 *
 * 왜: 「모두 새로 쓰기」는 저장할 때 질문을 쓰지 않고 버전만 올린다 — 다음 측정이 그 버전을 새로 만든다. 버전 · 크기가 틀리거나
 * 공통 질문까지 바뀌면 점수 비교가 깨지고, 저장소가 같은 버전 이름을 따로 쓰면 다른 목록으로 만든 질문을 묻게 된다.
 *
 *   npx tsx scripts/verify-competitor-rewrite-all.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'verify-competitor-rewrite-all-'))
process.env.APP_DATA_DIR = dir
process.env.BLOB_READ_WRITE_TOKEN = ''
process.env.BLOB_STORE_ID = ''
process.env.PIPELINE_CRON = ''
process.env.USE_MOCK_ENGINES = 'true'
delete process.env.VERCEL

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])
async function rejects(p: Promise<unknown>, status?: number): Promise<boolean> {
  try {
    await p
    return false
  } catch (err) {
    return status === undefined || (err as { status?: number }).status === status
  }
}
const writeJson = (rel: string, value: unknown) => {
  const file = path.join(dir, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value))
}
const readJson = (rel: string) => JSON.parse(readFileSync(path.join(dir, rel), 'utf8'))
const exists = (rel: string) => existsSync(path.join(dir, rel))

const c = (name: string) => ({ name, aliases: [name], domains: [] as string[] })
const COMPETITORS = [c('가상골목'), c('가상옥도'), c('가상초원'), c('가상선연'), c('가상해돋이')]
const base = {
  brandName: '가상머뭄',
  aliases: ['가상머뭄'],
  industry: '가상업종',
  engines: ['gemini'],
  repeatsPerQuestion: 1,
  factGraph: [],
  cohortQuestionBank: 'c1',
  questionBankVersion: 'v5',
}
// A: 질문지 7문항(공통 2 + 브랜드 5). B: 모의 판정으로 새로 만들 수 있게 브랜드 질문 1개(문항 3). C: 코호트 질문지 없음.
const A = { ...base, tenantId: 'fake-all-a', ownedDomains: ['fake-a.example'], region: '가상시', competitors: COMPETITORS, questionBankSize: 7 }
const B = { ...base, tenantId: 'fake-all-b', ownedDomains: ['fake-b.example'], region: '가상구', competitors: COMPETITORS.slice(0, 2), questionBankSize: 3 }
const C = { ...base, tenantId: 'fake-all-c', ownedDomains: ['fake-c.example'], region: '가상동', competitors: COMPETITORS.slice(0, 2), questionBankSize: 7, cohortQuestionBank: undefined }
// D: 「모두 새로 쓰기」 뒤 재기 전에 다시 저장한다. E: 세 곳을 함께 묻는 질문 하나(빼면 남는 곳도 질문을 잃는다).
const D = { ...base, tenantId: 'fake-all-d', ownedDomains: ['fake-d.example'], region: '가상읍', competitors: COMPETITORS.slice(0, 2), questionBankSize: 3 }
const E = { ...base, tenantId: 'fake-all-e', ownedDomains: ['fake-e.example'], region: '가상면', competitors: [COMPETITORS[0]!, COMPETITORS[2]!], questionBankSize: 3 }
const q = (questionId: string, text: string, region: string, extra: Record<string, unknown> = {}) => ({
  questionId, text, category: 'comparison', stage: 'consider', industry: '가상업종', region, containsBrandName: true, version: questionId.split('-')[0], ...extra,
})
const shared = (region: string) => [
  q('c1-001', `${region} 가상업종 추천해줘`, region, { category: 'category-agnostic', containsBrandName: false, cohortShared: true }),
  q('c1-002', `${region}에서 가상업종 고를 때 뭘 봐야 해?`, region, { category: 'category-agnostic', containsBrandName: false, cohortShared: true }),
]
const bankOf = (region: string, brand: ReturnType<typeof q>[]) => ({
  version: 'v5',
  generatedAt: '2026-10-13T00:00:00.000Z',
  cohortBank: { key: `가상업종__${region}`, version: 'c1' },
  questions: [...shared(region), ...brand],
})
const cohortFile = (region: string) => ({ key: `가상업종__${region}`, industry: '가상업종', region, version: 'c1', generatedAt: 'x', questions: shared(region) })

try {
  writeJson('tenants.overlay.json', [A, B, C])
  for (const region of ['가상시', '가상구']) writeJson(`cohort-banks/가상업종__${region}/c1.json`, cohortFile(region))
  writeJson(`data/${A.tenantId}/question-bank/v5.json`, bankOf('가상시', [
    q('v5-001', '가상머뭄 체크인 몇 시야?', '가상시', { category: 'brand-direct' }),
    q('v5-002', '가상머뭄이랑 가상골목 중에 어디가 더 나아?', '가상시'),
    q('v5-003', '가족 여행이면 가상머뭄이랑 가상초원 중 어디가 좋아?', '가상시'),
    q('v5-004', '커플 여행 갈 때 가상머뭄이랑 가상선연 중 어디가 나아?', '가상시'),
    q('v5-005', '가상머뭄이랑 가상옥도 부대시설 차이 알려줘', '가상시'),
  ]))
  writeJson(`data/${B.tenantId}/question-bank/v5.json`, bankOf('가상구', [q('v5-001', '가상머뭄이랑 가상골목 중에 어디가 더 나아?', '가상구')]))

  const ed = await import('../server/competitorEditor')
  const reg = await import('../server/tenantRegistry')
  const pipeline = await import('../server/pipeline')
  const fileStore = await import('../server/tenantCompetitorsStore')
  const { FileResultStore } = await import('../server/store')
  const store = new FileResultStore()
  const fresh = async (id: string) => (await reg.loadRuntimeTenants()).find((t) => t.tenantId === id)!
  const itemOfPlan = (p: { questions: { items: { fromId: string; action: string }[] } }, id: string) => p.questions.items.find((i) => i.fromId === id)
  const planOf = async (id: string, list: unknown, handoff?: unknown) => ed.planEdit(await fresh(id), await reg.loadRuntimeTenants(), store, list, undefined, handoff)

  // 1) 계획 · 상태에 「모두 새로 쓰기」 정보
  const p0 = await planOf(A.tenantId, COMPETITORS)
  ok('계획: 모두 새로 쓰기 가능 · v5 → v6 · 문항 7 · 브랜드 질문 5', p0.rewriteAll.available && p0.rewriteAll.toVersion === 'v6' && p0.rewriteAll.size === 7 && p0.rewriteAll.brandCount === 5)
  ok('계획: 함께 재는데 비교 질문 없는 곳(가상해돋이)', p0.noQuestion.join() === '가상해돋이')
  const s0 = await ed.buildEditorState(await fresh(A.tenantId), await reg.loadRuntimeTenants(), store)
  ok('서랍 상태에도 같은 정보(바닥 줄 링크용)', s0.questionBank.rewriteAll.available && s0.questionBank.rewriteAll.key === p0.rewriteAll.key)
  const pc = await planOf(C.tenantId, C.competitors)
  ok('코호트 질문지가 없으면 막는다(공통 질문까지 바뀜)', !pc.rewriteAll.available && Boolean(pc.rewriteAll.reason?.includes('공통 질문')))

  // 2) 목록은 그대로 두고 질문지만 새로 쓰기(E2)
  ok('알 수 없는 방식은 400', await rejects(ed.saveEdit(A.tenantId, store, { competitors: COMPETITORS, questions: { mode: 'x' } }), 400))
  ok('방식 없이 목록 그대로면 400(바뀐 내용 없음)', await rejects(ed.saveEdit(A.tenantId, store, { competitors: COMPETITORS }), 400))
  ok('key가 다르면 409', await rejects(ed.saveEdit(A.tenantId, store, { competitors: COMPETITORS, questions: { mode: 'all', key: 'stale' } }), 409))
  ok('코호트 질문지 없는 고객은 400', await rejects(ed.saveEdit(C.tenantId, store, { competitors: C.competitors, questions: { mode: 'all', key: pc.rewriteAll.key } }), 400))
  const s1 = await ed.saveEdit(A.tenantId, store, { competitors: COMPETITORS, summary: '질문지 v5→v6 · 브랜드 질문 5개 새로 씀', questions: { mode: 'all', key: p0.rewriteAll.key } })
  const o1 = readJson(`data/${A.tenantId}/competitors.json`)
  ok('저장: 서랍 상태 v6 · 아직 질문지 파일 없음', s1.questionBank.version === 'v6' && !s1.questionBank.exists && !exists(`data/${A.tenantId}/question-bank/v6.json`))
  ok('저장: 저장소 목록이라도 수정본을 남긴다(새 버전 · 크기 · 출처)', o1.current?.competitors.length === 5 && o1.current.questionBank?.version === 'v6' && o1.current.questionBank.size === 7 && o1.current.questionBank.regenerate?.from === 'v5' && o1.current.questionBank.regenerate.base === fileStore.baseFingerprint((await reg.loadTenantWithoutCompetitorEdit(A.tenantId))!))
  ok('측정이 읽는 설정: v6 · 7문항', (await fresh(A.tenantId)).questionBankVersion === 'v6' && (await fresh(A.tenantId)).questionBankSize === 7)
  ok('목록은 그대로여도 「다음 측정 대기」(질문지가 바뀜)', (await ed.pendingCompetitorEdit(await fresh(A.tenantId)))?.summary === '질문지 v5→v6 · 브랜드 질문 5개 새로 씀')
  const p1 = await planOf(A.tenantId, COMPETITORS.slice(1))
  ok('저장 뒤 다시 바꾸면 fresh(다음 측정이 새 목록으로 만든다) · 모두 새로 쓰기는 막힘', p1.questions.mode === 'fresh' && !p1.rewriteAll.available)

  // 3) 되돌리기 — 지울 파일 없음, v5로
  await ed.undoEdit(A.tenantId, store)
  ok('되돌리면 v5 · 대기 없음', (await fresh(A.tenantId)).questionBankVersion === 'v5' && (await ed.pendingCompetitorEdit(await fresh(A.tenantId))) === null)

  // 4) 목록을 바꾸며 모두 새로 쓰기 — 고쳐 쓰기(넘겨받기)를 하지 않는다
  const replaced = [c('새펜션A'), ...COMPETITORS.slice(1)]
  const handoff = [{ from: '가상골목', to: '새펜션A' }]
  const p2 = await planOf(A.tenantId, replaced, handoff)
  ok('바꾼 목록 계획은 derive(v5-002 넘겨받기) · 모두 새로 쓰기도 가능', p2.questions.mode === 'derive' && p2.rewriteAll.available)
  await ed.saveEdit(A.tenantId, store, { competitors: replaced, handoff, questions: { mode: 'all', key: p2.rewriteAll.key } })
  ok('모두 새로 쓰기를 고르면 고친 문장 없이 저장되고 파일도 없다', (await fresh(A.tenantId)).questionBankVersion === 'v6' && !exists(`data/${A.tenantId}/question-bank/v6.json`) && (await fresh(A.tenantId)).competitors[0]!.name === '새펜션A')
  await ed.undoEdit(A.tenantId, store)

  // 5) 질문지 그대로 두기 — 은행 그대로, 미리 본 계획과 같아야 한다
  const p3 = await planOf(A.tenantId, replaced, handoff)
  ok('그대로 두기: key가 다르면 409', await rejects(ed.saveEdit(A.tenantId, store, { competitors: replaced, handoff, questions: { mode: 'keep', key: 'stale' } }), 409))
  await ed.saveEdit(A.tenantId, store, { competitors: replaced, handoff, questions: { mode: 'keep', key: p3.questions.key } })
  ok('그대로 두기: v5 그대로 · 새 파일 없음 · 목록은 바뀜', (await fresh(A.tenantId)).questionBankVersion === 'v5' && !exists(`data/${A.tenantId}/question-bank/v6.json`) && (await fresh(A.tenantId)).competitors[0]!.name === '새펜션A')
  await ed.undoEdit(A.tenantId, store)

  // 6) 넘겨받기로 질문을 뺀 뒤 모두 새로 쓰기 — 크기는 저장소 값으로 되돌린다(E1), 버전은 남은 v6을 피해 v7
  // 질문 없는 가상해돋이도 함께 뺀다 — 남으면 그곳이 v5-004를 넘겨받는다(결정 E8). 받을 곳이 없어야 빼기만 남는다.
  const dropped = COMPETITORS.filter((x) => x.name !== '가상선연' && x.name !== '가상해돋이')
  const p4 = await planOf(A.tenantId, dropped)
  await ed.saveEdit(A.tenantId, store, { competitors: dropped, questions: { key: p4.questions.key, drafts: [] } })
  ok('빼기 저장: v6 · 6문항', (await fresh(A.tenantId)).questionBankVersion === 'v6' && (await fresh(A.tenantId)).questionBankSize === 6)
  const p5 = await planOf(A.tenantId, dropped)
  ok('그 뒤 모두 새로 쓰기: v7 · 문항 7(저장소 크기) · 브랜드 질문 5', p5.rewriteAll.toVersion === 'v7' && p5.rewriteAll.size === 7 && p5.rewriteAll.brandCount === 5)
  await ed.saveEdit(A.tenantId, store, { competitors: dropped, questions: { mode: 'all', key: p5.rewriteAll.key } })
  ok('모두 새로 쓰기 저장: v7 · 7문항 · v6 파일은 남는다', (await fresh(A.tenantId)).questionBankVersion === 'v7' && (await fresh(A.tenantId)).questionBankSize === 7 && exists(`data/${A.tenantId}/question-bank/v6.json`))
  await ed.undoEdit(A.tenantId, store)
  ok('되돌리면 앞 저장(v6 · 6문항)', (await fresh(A.tenantId)).questionBankVersion === 'v6' && (await fresh(A.tenantId)).questionBankSize === 6)

  // 7) 측정이 새로 만드는 질문지 — 공통 질문은 코호트 그대로, 브랜드 질문은 새 id, 출처 표식(regeneratedFrom)
  const pb = await planOf(B.tenantId, B.competitors)
  await ed.saveEdit(B.tenantId, store, { competitors: B.competitors, questions: { mode: 'all', key: pb.rewriteAll.key } })
  const tb = await fresh(B.tenantId)
  const made = await pipeline.ensureQuestionBank(tb, store)
  const v6b = readJson(`data/${B.tenantId}/question-bank/v6.json`)
  ok('측정이 v6를 새로 만든다(공통 2 + 브랜드 1)', made.length === 3 && made.filter((x) => x.cohortShared).length === 2 && made.some((x) => x.questionId === 'v6-001'))
  ok('공통 질문은 코호트 질문지 그대로', JSON.stringify(made.filter((x) => x.cohortShared).map((x) => [x.questionId, x.text])) === JSON.stringify(shared('가상구').map((x) => [x.questionId, x.text])))
  ok('새로 만든 은행에 출처 표식(앞 버전 · 저장소 지문) · derivedFrom은 없다', v6b.regeneratedFrom?.version === 'v5' && v6b.regeneratedFrom.base === readJson(`data/${B.tenantId}/competitors.json`).current.questionBank.regenerate.base && !v6b.derivedFrom)
  ok('다시 재면 그 은행을 그대로 쓴다', (await pipeline.ensureQuestionBank(tb, store)).map((x) => x.questionId).join() === made.map((x) => x.questionId).join())

  // 8) 저장소가 같은 이름(v6)을 따로 쓰면 멈춘다(E3)
  writeJson('tenants.overlay.json', [A, { ...B, questionBankVersion: 'v6' }, C])
  ok('저장소 v6 + 앱이 새로 쓴 v6.json → 측정을 멈춘다', await rejects(pipeline.ensureQuestionBank(await fresh(B.tenantId), store)))
  writeJson('tenants.overlay.json', [A, B, C])
  ok('저장소가 그대로면 계속 쓴다', !(await rejects(pipeline.ensureQuestionBank(await fresh(B.tenantId), store))))

  // 9) 측정 기록에 질문지 버전 — 그 버전으로 재면 대기가 사라진다
  await fileStore.recordCompetitorMeasurement(B.tenantId, tb.competitors, new Date(Date.now() + 60_000).toISOString(), tb.questionBankVersion)
  ok('그 버전으로 잰 뒤에는 대기가 사라진다', (await ed.pendingCompetitorEdit(await fresh(B.tenantId))) === null)

  // 10) 저장소가 질문지 버전을 올린 것은 경쟁사 편집 대기가 아니다(검토 지적 — 앱이 고른 버전만 센다)
  await ed.resetEdit(A.tenantId, store)
  writeJson('tenants.overlay.json', [{ ...A, questionBankVersion: 'v8' }, { ...B, questionBankVersion: 'v8' }, C])
  ok('저장소 목록으로 돌아간 뒤 저장소가 버전을 올리면 대기 아님', (await ed.pendingCompetitorEdit(await fresh(A.tenantId))) === null)
  ok('질문지만 새로 쓴 수정본을 잰 뒤 저장소가 버전을 올리면 대기 아님(수정본은 안 쓰인다)', (await ed.pendingCompetitorEdit(await fresh(B.tenantId))) === null)

  // 11) 모두 새로 쓰기를 저장하고 재기 전에 다시 저장해도(경쟁사 추가) 새로 쓸 표시를 잇는다 — 가드가 그 버전을 본다
  writeJson('tenants.overlay.json', [A, B, C, D, E])
  writeJson('cohort-banks/가상업종__가상읍/c1.json', cohortFile('가상읍'))
  writeJson(`data/${D.tenantId}/question-bank/v5.json`, bankOf('가상읍', [q('v5-001', '가상머뭄이랑 가상골목 중에 어디가 더 나아?', '가상읍')]))
  const pd = await planOf(D.tenantId, D.competitors)
  await ed.saveEdit(D.tenantId, store, { competitors: D.competitors, summary: '질문지 v5→v6', questions: { mode: 'all', key: pd.rewriteAll.key } })
  const addedD = [...D.competitors, c('가상추가')]
  ok('재기 전 다시 바꾸면 질문지는 fresh', (await planOf(D.tenantId, addedD)).questions.mode === 'fresh')
  await ed.saveEdit(D.tenantId, store, { competitors: addedD, summary: '가상추가 추가' })
  const od = readJson(`data/${D.tenantId}/competitors.json`).current
  ok('재기 전 추가 저장도 새로 쓸 표시를 잇는다(v6 · 출처 v5)', od.questionBank?.version === 'v6' && od.questionBank.size === 3 && od.questionBank.regenerate?.from === 'v5' && od.competitors.length === 3)
  ok('그 저장도 다음 측정 대기', (await ed.pendingCompetitorEdit(await fresh(D.tenantId)))?.summary === '가상추가 추가')
  const backD = await planOf(D.tenantId, D.competitors)
  ok('재기 전 저장소 목록으로 돌아가면 저장소 질문지(v5)로 돌아간다고 보인다', backD.questions.mode === 'repo' && backD.questions.toVersion === 'v5')
  await pipeline.ensureQuestionBank(await fresh(D.tenantId), store)
  ok('측정이 만든 v6에 출처 표식', readJson(`data/${D.tenantId}/question-bank/v6.json`).regeneratedFrom?.version === 'v5')
  writeJson('tenants.overlay.json', [A, B, C, { ...D, questionBankVersion: 'v6' }, E])
  ok('저장소가 v6을 따로 쓰면 멈춘다(표시가 이어져 가드가 본다)', await rejects(pipeline.ensureQuestionBank(await fresh(D.tenantId), store)))
  writeJson('tenants.overlay.json', [A, B, C, D, E])

  // 12) 「모두 새로 쓰기」 권하는 곳 — 저장한 뒤 비교 질문이 없는 곳(빠지는 질문은 세지 않는다 · 그대로 두기면 넘겨받기가 없다)
  writeJson('cohort-banks/가상업종__가상면/c1.json', cohortFile('가상면'))
  writeJson(`data/${E.tenantId}/question-bank/v5.json`, bankOf('가상면', [q('v5-001', '가상머뭄, 가상골목, 가상초원 세 곳 1박 가격 비교해 줘', '가상면')]))
  const pe = await planOf(E.tenantId, [COMPETITORS[2]!])
  ok('함께 묻던 질문이 빠지면 남는 곳(가상초원)도 비교 질문 없음', itemOfPlan(pe, 'v5-001')?.action === 'remove' && pe.noQuestion.join() === '가상초원' && pe.noQuestionKept.length === 0)
  const ph = await planOf(A.tenantId, replaced, handoff)
  ok('넘겨받는 곳은 빼고, 그대로 두기면 넘겨받는 곳도 질문 없음', ph.noQuestion.join() === '가상해돋이' && ph.noQuestionKept.join() === '새펜션A,가상해돋이')
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
