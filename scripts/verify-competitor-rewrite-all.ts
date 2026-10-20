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
// 경쟁사 자동 추론(inferCompetitors)은 모의 엔진 설정을 보지 않고 키가 있으면 실제 엔진을 부른다 — 키를 비운다(16번은 fetch를 가로챈다).
for (const key of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'PERPLEXITY_API_KEY', 'ANTHROPIC_API_KEY']) process.env[key] = ''
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
  const repoBaseOf = async (id: string) => fileStore.baseFingerprint((await reg.loadTenantWithoutCompetitorEdit(id))!)
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
  await fileStore.recordCompetitorMeasurement(B.tenantId, tb.competitors, new Date(Date.now() + 60_000).toISOString(), tb.questionBankVersion, await repoBaseOf(B.tenantId))
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

  // 11-2) 모두 새로 쓴 질문지(v6)로 잰 뒤 「저장소 설정으로 돌아가기」 — 다음 측정은 v5로 재므로 대기다(저장소 버전 올림과 다르다)
  ok('잰 뒤에는 대기 없음(B · v6)', (await fresh(B.tenantId)).questionBankVersion === 'v6' && (await ed.pendingCompetitorEdit(await fresh(B.tenantId))) === null)
  // (9)는 측정 시각을 1분 뒤로 적었다 — 실제처럼 측정이 먼저 끝난 뒤에 돌아가게 시각을 다시 적는다.
  await fileStore.recordCompetitorMeasurement(B.tenantId, B.competitors, new Date(Date.now() - 1000).toISOString(), 'v6', await repoBaseOf(B.tenantId))
  await ed.resetEdit(B.tenantId, store)
  ok('저장소 설정으로 돌아가면 v5로 재니 대기', (await fresh(B.tenantId)).questionBankVersion === 'v5' && (await ed.pendingCompetitorEdit(await fresh(B.tenantId)))?.summary === '저장소 설정의 경쟁사 목록으로 돌아감')
  // 돌아간 뒤 무엇을 저장해도(목록을 바꿨다 다시 저장소 목록으로) 다음 측정이 v5인 동안은 대기다 — 직전 저장만 보면 놓친다
  const plusX = [...B.competitors, c('가상추가비')]
  await ed.saveEdit(B.tenantId, store, { competitors: plusX, summary: '가상추가비 추가' })
  await ed.saveEdit(B.tenantId, store, { competitors: B.competitors, summary: '가상추가비 빼기' })
  ok('돌아간 뒤 목록을 바꿨다 되돌려도 v5로 재니 대기', (await fresh(B.tenantId)).questionBankVersion === 'v5' && (await ed.pendingCompetitorEdit(await fresh(B.tenantId)))?.summary === '가상추가비 빼기')
  await fileStore.recordCompetitorMeasurement(B.tenantId, B.competitors, new Date(Date.now() + 120_000).toISOString(), 'v5', await repoBaseOf(B.tenantId))
  ok('v5로 잰 뒤에는 대기 없음', (await ed.pendingCompetitorEdit(await fresh(B.tenantId))) === null)

  // 12) 「모두 새로 쓰기」 권하는 곳 — 저장한 뒤 비교 질문이 없는 곳(빠지는 질문은 세지 않는다 · 그대로 두기면 넘겨받기가 없다)
  writeJson('cohort-banks/가상업종__가상면/c1.json', cohortFile('가상면'))
  writeJson(`data/${E.tenantId}/question-bank/v5.json`, bankOf('가상면', [q('v5-001', '가상머뭄, 가상골목, 가상초원 세 곳 1박 가격 비교해 줘', '가상면')]))
  const pe = await planOf(E.tenantId, [COMPETITORS[2]!])
  ok('함께 묻던 질문이 빠지면 남는 곳(가상초원)도 비교 질문 없음', itemOfPlan(pe, 'v5-001')?.action === 'remove' && pe.noQuestion.join() === '가상초원' && pe.noQuestionKept.length === 0)
  const ph = await planOf(A.tenantId, replaced, handoff)
  ok('넘겨받는 곳은 빼고, 그대로 두기면 넘겨받는 곳도 질문 없음', ph.noQuestion.join() === '가상해돋이' && ph.noQuestionKept.join() === '새펜션A,가상해돋이')

  // 13) 모두 새로 쓴 v6로 잰 뒤 다시 모두 새로 쓰기(v7) — 대기. 그 뒤 저장소가 버전을 올려 수정본이 낡으면 v7은 쓰이지 않으니 대기 아님
  const F = { ...B, tenantId: 'fake-all-f', ownedDomains: ['fake-f.example'] }
  writeJson('tenants.overlay.json', [A, B, C, D, E, F])
  writeJson(`data/${F.tenantId}/question-bank/v5.json`, bankOf('가상구', [q('v5-001', '가상머뭄이랑 가상골목 중에 어디가 더 나아?', '가상구')]))
  await ed.saveEdit(F.tenantId, store, { competitors: F.competitors, summary: 'F v5→v6', questions: { mode: 'all', key: (await planOf(F.tenantId, F.competitors)).rewriteAll.key } })
  await pipeline.ensureQuestionBank(await fresh(F.tenantId), store)
  await fileStore.recordCompetitorMeasurement(F.tenantId, F.competitors, new Date(Date.now() - 1000).toISOString(), 'v6', await repoBaseOf(F.tenantId))
  ok('F: v6로 잰 뒤 대기 없음', (await ed.pendingCompetitorEdit(await fresh(F.tenantId))) === null)
  await ed.saveEdit(F.tenantId, store, { competitors: F.competitors, summary: 'F v6→v7', questions: { mode: 'all', key: (await planOf(F.tenantId, F.competitors)).rewriteAll.key } })
  ok('F: 다시 모두 새로 쓰면(v7) 대기', (await fresh(F.tenantId)).questionBankVersion === 'v7' && (await ed.pendingCompetitorEdit(await fresh(F.tenantId)))?.summary === 'F v6→v7')
  writeJson('tenants.overlay.json', [A, B, C, D, E, { ...F, questionBankVersion: 'v8' }])
  ok('F: 저장소가 버전을 올려 수정본이 낡으면 대기 아님', (await fresh(F.tenantId)).questionBankVersion === 'v8' && (await ed.pendingCompetitorEdit(await fresh(F.tenantId))) === null)
  writeJson('tenants.overlay.json', [A, B, C, D, E, F])
  ok('F: 저장소가 그대로면 다시 대기', (await ed.pendingCompetitorEdit(await fresh(F.tenantId)))?.summary === 'F v6→v7')

  // 14) 실제 측정(measureAndBake)이 시작할 때의 저장소 지문을 적는다 — 측정 중에 저장소가 버전을 올려도 대기로 보이지 않는다
  const { measureAndBake } = await import('../server/measureAndBake')
  const G = { ...B, tenantId: 'fake-all-g', ownedDomains: ['fake-g.example'] }
  writeJson('tenants.overlay.json', [A, B, C, D, E, F, G])
  writeJson(`data/${G.tenantId}/question-bank/v5.json`, bankOf('가상구', [q('v5-001', '가상머뭄이랑 가상골목 중에 어디가 더 나아?', '가상구')]))
  await measureAndBake(await fresh(G.tenantId), store)
  await ed.saveEdit(G.tenantId, store, { competitors: G.competitors, summary: 'G all', questions: { mode: 'all', key: (await planOf(G.tenantId, G.competitors)).rewriteAll.key } })
  await measureAndBake(await fresh(G.tenantId), store)
  const mg = readJson(`data/${G.tenantId}/competitors.json`).measured
  ok('측정 기록: v6 · 저장소 지문', mg.bankVersion === 'v6' && mg.repoBase === (await repoBaseOf(G.tenantId)) && (await ed.pendingCompetitorEdit(await fresh(G.tenantId))) === null)
  await ed.saveEdit(G.tenantId, store, { competitors: G.competitors, summary: 'G all again', questions: { mode: 'all', key: (await planOf(G.tenantId, G.competitors)).rewriteAll.key } })
  const saveScorecard = store.saveScorecard.bind(store)
  store.saveScorecard = async (...args: Parameters<typeof saveScorecard>) => {
    writeJson('tenants.overlay.json', [A, B, C, D, E, F, { ...G, questionBankVersion: 'v9' }])
    return saveScorecard(...args)
  }
  await measureAndBake(await fresh(G.tenantId), store)
  store.saveScorecard = saveScorecard
  ok('측정 중에 저장소가 버전을 올리면(v9) 대기 아님', (await fresh(G.tenantId)).questionBankVersion === 'v9' && (await ed.pendingCompetitorEdit(await fresh(G.tenantId))) === null)

  // 15) 코호트 없이 재는 고객(autoCohort false — 온보딩에서 「함께 측정」을 끈 고객)도 자기 측정을 적는다. 그 측정도 고친 목록으로
  //     판정한다 — 적지 않으면 「다음 측정 대기」가 영영 남고 되돌리기가 열린 채다. 다른 고객의 경쟁사로 잰 측정(P가 N을 함께 잰다)은 적지 않는다.
  const { readLocalMeasures } = await import('../server/localMeasureLog')
  const saveList = async (id: string, list: ReturnType<typeof c>[], summary: string) => {
    const plan = await planOf(id, list)
    return ed.saveEdit(id, store, { competitors: list, summary, ...(plan.questions.mode === 'derive' ? { questions: { key: plan.questions.key, drafts: [] } } : {}) })
  }
  const measuredOf = (id: string) => readJson(`data/${id}/competitors.json`).measured
  const N = { ...base, tenantId: 'fake-all-n', ownedDomains: ['fake-n.example'], region: '가상리', competitors: [c('가상골목')], questionBankSize: 3, autoCohort: false }
  const P = { ...base, tenantId: 'fake-all-p', brandName: '가상피오', aliases: ['가상피오'], ownedDomains: ['fake-p.example'], region: '가상리', competitors: [{ name: '가상머뭄', aliases: ['가상머뭄'], domains: ['fake-n.example'] }], questionBankSize: 3 }
  writeJson('tenants.overlay.json', [N, P])
  writeJson('cohort-banks/가상업종__가상리/c1.json', cohortFile('가상리'))
  writeJson(`data/${N.tenantId}/question-bank/v5.json`, bankOf('가상리', [q('v5-001', '가상머뭄이랑 가상골목 중에 어디가 더 나아?', '가상리')]))
  writeJson(`data/${P.tenantId}/question-bank/v5.json`, bankOf('가상리', [q('v5-001', '가상피오랑 가상머뭄 중에 어디가 더 나아?', '가상리')]))
  await measureAndBake(await fresh(N.tenantId), store)
  await saveList(N.tenantId, [...N.competitors, c('가상추가엔')], 'N 가상추가엔 추가')
  ok('N: 저장 뒤 다음 측정 대기', (await ed.pendingCompetitorEdit(await fresh(N.tenantId)))?.summary === 'N 가상추가엔 추가')
  const runsOfN = () => readLocalMeasures().filter((r) => r.tenantId === N.tenantId).length
  const nBefore = runsOfN()
  await measureAndBake(await fresh(P.tenantId), store)
  ok('N: P의 경쟁사로 잰 측정(inCohortRun)은 적지 않는다 — 대기 그대로', runsOfN() === nBefore + 1 && measuredOf(N.tenantId).at === null && (await ed.pendingCompetitorEdit(await fresh(N.tenantId))) !== null)
  await measureAndBake(await fresh(N.tenantId), store)
  const mn = measuredOf(N.tenantId)
  ok('N: 자기 측정을 마치면 지금 목록 · 시작 시각을 적는다 — 대기 없음', mn.at !== null && mn.listHash === fileStore.listHash((await fresh(N.tenantId)).competitors) && (await ed.pendingCompetitorEdit(await fresh(N.tenantId))) === null)
  ok('N: 그 목록으로 쟀으니 되돌리기 닫힘', !(await ed.buildEditorState(await fresh(N.tenantId), await reg.loadRuntimeTenants(), store)).edit.undoAvailable && (await rejects(ed.undoEdit(N.tenantId, store), 409)))

  // 16) 저장소 경쟁사 목록이 빈 고객 — 측정마다 경쟁사를 추론해 채우지만 그 목록은 저장하지 않는다. 다음 측정도 빈 목록에서 시작하므로
  //     빈 목록을 적어야 「저장소 설정으로 돌아가기」 뒤 대기가 사라진다. 추론이 아무것도 못 찾아도 적는다.
  const H = { ...base, tenantId: 'fake-all-h', brandName: '가상하늘', aliases: ['가상하늘'], ownedDomains: ['fake-h.example'], region: '가상리', competitors: [] as ReturnType<typeof c>[], questionBankSize: 3 }
  writeJson('tenants.overlay.json', [N, P, H])
  writeJson(`data/${H.tenantId}/question-bank/v5.json`, bankOf('가상리', [q('v5-001', '가상하늘 체크인 몇 시야?', '가상리', { category: 'brand-direct' })]))
  const editedThenReset = async (summary: string) => {
    await saveList(H.tenantId, [c('가상편집')], summary)
    await fileStore.recordCompetitorMeasurement(H.tenantId, [c('가상편집')], new Date().toISOString(), 'v5', await repoBaseOf(H.tenantId))
    await ed.resetEdit(H.tenantId, store)
  }
  await editedThenReset('H 가상편집')
  ok('H: 고친 목록으로 잰 뒤 저장소 설정(빈 목록)으로 돌아가면 대기', (await fresh(H.tenantId)).competitors.length === 0 && (await ed.pendingCompetitorEdit(await fresh(H.tenantId)))?.summary === '저장소 설정의 경쟁사 목록으로 돌아감')
  // 키가 없어 추론이 빈 목록을 돌려준다.
  await measureAndBake(await fresh(H.tenantId), store)
  const mh1 = measuredOf(H.tenantId)
  ok('H: 추론이 비어도 빈 목록으로 잰 것을 적는다 — 대기 없음 · 되돌리기 닫힘', mh1.at !== null && mh1.listHash === fileStore.listHash([]) && (await ed.pendingCompetitorEdit(await fresh(H.tenantId))) === null && !(await ed.buildEditorState(await fresh(H.tenantId), await reg.loadRuntimeTenants(), store)).edit.undoAvailable)
  await editedThenReset('H 가상편집 다시')
  ok('H: 다시 고쳐 잰 뒤 돌아가면 대기', (await ed.pendingCompetitorEdit(await fresh(H.tenantId)))?.summary === '저장소 설정의 경쟁사 목록으로 돌아감')
  // 추론이 두 곳을 찾는다 — Gemini 호출만 가로채 답하고, 다른 외부 호출은 모두 막는다(실제 엔진을 부르지 않는다).
  const realFetch = globalThis.fetch
  let inferCalls = 0
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.includes('generativelanguage.googleapis.com') && typeof init?.body === 'string' && init.body.includes('스키마: [{')) {
      inferCalls += 1
      const text = JSON.stringify([{ name: '가상추론갑', domain: '' }, { name: '가상추론을', domain: '' }])
      return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    throw new Error(`verify: 외부 호출을 막았습니다 — ${url}`)
  }) as typeof fetch
  process.env.GEMINI_API_KEY = 'verify-fake-key'
  try {
    await measureAndBake(await fresh(H.tenantId), store)
  } finally {
    globalThis.fetch = realFetch
    process.env.GEMINI_API_KEY = ''
  }
  const mh2 = measuredOf(H.tenantId)
  ok('H: 추론한 목록으로 쟀어도 다음 측정이 읽을 빈 목록을 적는다 — 대기 없음 · 되돌리기 닫힘', inferCalls === 1 && (await fresh(H.tenantId)).competitors.length === 0 && mh2.listHash === fileStore.listHash([]) && mh2.at > mh1.at && (await ed.pendingCompetitorEdit(await fresh(H.tenantId))) === null && !(await ed.buildEditorState(await fresh(H.tenantId), await reg.loadRuntimeTenants(), store)).edit.undoAvailable)
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
