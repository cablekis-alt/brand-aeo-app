/**
 * 경쟁사 편집 4단계 「바뀐 경쟁사 질문만 고치기」 — 고쳐 쓰기(미리보기) → 저장 → 측정이 쓰는 은행까지 확인한다.
 * 임시 폴더를 APP_DATA_DIR로 쓰고 가짜 고객 · 가짜 질문지 · 가짜 판정 엔진만 쓴다. 실제 AI는 부르지 않는다.
 *
 * 왜: 미리 본 질문과 저장된 질문이 같아야 하고, 저장한 뒤 첫 측정이 그 질문지를 판정 엔진으로 다시 만들면 안 된다.
 * 실패하면 아무도 안 쓰는 질문지나 질문지 없는 수정본이 남으면 안 된다.
 *
 *   npx tsx scripts/verify-competitor-rewrite.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { PromptMessage } from '../src/prompts/types'

const dir = mkdtempSync(path.join(tmpdir(), 'verify-competitor-rewrite-'))
process.env.APP_DATA_DIR = dir
process.env.BLOB_READ_WRITE_TOKEN = ''
process.env.BLOB_STORE_ID = ''
process.env.PIPELINE_CRON = ''
delete process.env.VERCEL

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])
async function rejects(p: Promise<unknown> | (() => unknown), status?: number): Promise<boolean> {
  try {
    await (typeof p === 'function' ? p() : p)
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
const exists = (rel: string) => {
  try {
    statSync(path.join(dir, rel))
    return true
  } catch {
    return false
  }
}

/** 차례로 답하는 가짜 판정 엔진 — 받은 프롬프트를 남긴다. */
class FakeJudge {
  prompts: PromptMessage[] = []
  constructor(private answer: (prompt: PromptMessage, n: number) => string | Error) {}
  async call(prompt: PromptMessage) {
    this.prompts.push(prompt)
    const a = this.answer(prompt, this.prompts.length)
    if (a instanceof Error) throw a
    return { text: a, citations: [], usedWebSearch: false }
  }
}

const ID = 'fake-rewrite-customer'
const c = (name: string) => ({ name, aliases: [name], domains: [] as string[] })
const COMPETITORS = [c('가상골목'), c('가상옥도'), c('가상초원'), c('가상선연'), c('가상해돋이')]
const tenant = {
  tenantId: ID,
  brandName: '가상머뭄',
  aliases: ['가상머뭄', '가상,머뭄'],
  ownedDomains: ['fake-mumum.example'],
  industry: '가상업종',
  region: '가상시',
  competitors: COMPETITORS,
  engines: ['gemini'],
  questionBankSize: 7,
  questionBankVersion: 'v5',
  repeatsPerQuestion: 1,
  factGraph: [],
  cohortQuestionBank: 'c1',
}
const q = (questionId: string, text: string, extra: Record<string, unknown> = {}) => ({
  questionId, text, category: 'comparison', stage: 'consider', industry: '가상업종', region: '가상시', containsBrandName: true, version: questionId.split('-')[0], ...extra,
})
const shared = [
  q('c1-001', '가상시 가상업종 추천해줘', { category: 'category-agnostic', containsBrandName: false, cohortShared: true }),
  q('c1-002', '가상시에서 가상업종 고를 때 뭘 봐야 해?', { category: 'category-agnostic', containsBrandName: false, cohortShared: true }),
]
const v5 = {
  version: 'v5',
  generatedAt: '2026-10-13T00:00:00.000Z',
  cohortBank: { key: '가상업종__가상시', version: 'c1' },
  questions: [
    ...shared,
    q('v5-001', '가상머뭄 체크인 몇 시야?', { category: 'brand-direct', topic: '입퇴실 시간' }),
    q('v5-002', '가상시 감성 숙소 찾는데 가상머뭄이랑 가상골목 중에 어디가 더 나아?', { topic: '가상골목과의 비교' }),
    q('v5-003', '가족 여행이면 가상머뭄이랑 가상초원 중 어디가 좋아?', { topic: '가족 숙소 비교' }),
    q('v5-004', '커플 여행 갈 때 가상머뭄이랑 가상선연 둘 중에 어디를 더 추천해?', { stage: 'decide', topic: '커플 숙소 비교' }),
    q('v5-005', '가상머뭄이랑 가상옥도 부대시설 차이 알려줘', { topic: '부대시설 비교' }),
  ],
}

try {
  writeJson('tenants.overlay.json', [tenant])
  writeJson(`cohort-banks/가상업종__가상시/c1.json`, { key: '가상업종__가상시', industry: '가상업종', region: '가상시', version: 'c1', generatedAt: 'x', questions: shared })
  writeJson(`data/${ID}/question-bank/v5.json`, v5)

  const ed = await import('../server/competitorEditor')
  const rw = await import('../server/competitorRewrite')
  const reg = await import('../server/tenantRegistry')
  const tracker = await import('../server/measureTracker')
  const pipeline = await import('../server/pipeline')
  const { MockJudgeClient } = await import('../server/engines/mockJudgeClient')
  const { buildCompetitorRewritePrompt } = await import('../src/prompts/b1d-competitor-rewrite')
  const { checkRewrite } = await import('../server/questionHandoff')
  const { FileResultStore } = await import('../server/store')
  const store = new FileResultStore()
  const fresh = async () => (await reg.loadRuntimeTenants()).find((t) => t.tenantId === ID)!

  // 1) 처음 상태
  const s0 = await ed.buildEditorState(await fresh(), await reg.loadRuntimeTenants(), store)
  ok('처음 질문지는 v5 · 고친 질문지 아님', s0.questionBank.version === 'v5' && s0.questionBank.exists && s0.questionBank.derived === null)

  // 2) 바꿈 계획 — 가상골목 → 새펜션A
  const replaced = [c('새펜션A'), ...COMPETITORS.slice(1)]
  const handoff = [{ from: '가상골목', to: '새펜션A' }]
  const plan = await ed.planEdit(await fresh(), await reg.loadRuntimeTenants(), store, replaced, undefined, handoff)
  const qp = plan.questions
  ok('계획: v5 → v6 · v5-002 → v6-002 · 주제도 새로', qp.mode === 'derive' && qp.toVersion === 'v6' && qp.items.length === 1 && qp.items[0]!.toId === 'v6-002' && qp.items[0]!.topicNeedsRewrite)

  // 3) 고쳐 쓰기 — 첫 답은 나간 이름이 남고, 둘째 답이 맞다
  const good = '가상시 감성 숙소 찾는데 가상머뭄이랑 새펜션A 중에 어디가 더 나아?'
  const bad = '가상시 감성 숙소 찾는데 가상머뭄이랑 새펜션A, 가상골목 중에 어디가 더 나아?'
  const judge = new FakeJudge((_, n) => (n === 1 ? JSON.stringify({ text: bad, topic: '감성 숙소 비교' }) : `설명을 붙였어요\n\`\`\`json\n${JSON.stringify({ text: ` ${good} `, topic: '감성 숙소 비교' })}\n\`\`\``))
  const body = { competitors: replaced, handoff, key: qp.key }
  const ctx = await ed.questionRewriteContext(ID, store, body)
  const r1 = await rw.draftCompetitorRewrites(ctx, judge)
  ok('고쳐 쓰기: 둘째 시도에 통과 · 문장은 정리해서 돌려준다', r1.drafts.length === 1 && r1.failed.length === 0 && r1.drafts[0]!.attempts === 2 && r1.drafts[0]!.text === good && r1.drafts[0]!.topic === '감성 숙소 비교')
  ok('다시 시도할 때 직전 안과 이유를 알려 준다', judge.prompts.length === 2 && judge.prompts[1]!.user.includes(bad) && judge.prompts[1]!.user.includes('나간 경쟁사 이름이 남았어요'))
  ok('프롬프트에 원래 질문 · 바꿀 경쟁사 · 고객 이름', judge.prompts[0]!.user.includes(v5.questions[3]!.text) && judge.prompts[0]!.user.includes('빼는 경쟁사: 가상골목 → 넣는 경쟁사: 새펜션A') && judge.prompts[0]!.user.includes('가상머뭄'))
  ok('프롬프트가 질문지 생성 · 판정 mock 문구를 쓰지 않는다', !/AEO\(Answer Engine Optimization\) 리서치 설계자|브랜드 언급을 정확히 탐지하는 분석기|추천 우선순위|사실 주장만을 검증하는 팩트체커/.test(judge.prompts[0]!.system))
  const r1b = await rw.draftCompetitorRewrites(await ed.questionRewriteContext(ID, store, body), judge)
  ok('같은 계획을 다시 열면 판정 엔진을 다시 부르지 않는다', judge.prompts.length === 2 && r1b.drafts[0]!.text === good)
  const judge2 = new FakeJudge(() => JSON.stringify({ text: '감성 숙소 고르는데 가상머뭄이랑 새펜션A 중 어디가 더 좋아?', topic: '감성 숙소 비교' }))
  const r1c = await rw.draftCompetitorRewrites(await ed.questionRewriteContext(ID, store, body), judge2, { fresh: true })
  ok('다시 쓰기(fresh)는 새로 부르고 직전 문장과 다르게 쓰라고 한다', judge2.prompts.length === 1 && judge2.prompts[0]!.user.includes(good) && r1c.drafts[0]!.text !== good)

  // 4) 거절
  ok('고쳐 쓰기: key가 다르면 409', await rejects(ed.questionRewriteContext(ID, store, { ...body, key: 'stale' }), 409))
  tracker.beginMeasureRun()
  ok('고쳐 쓰기: 측정 중이면 409', await rejects(ed.questionRewriteContext(ID, store, body), 409))
  ok('저장: 측정 중이면 409', await rejects(ed.saveEdit(ID, store, { competitors: replaced, handoff, questions: { key: qp.key, drafts: [{ fromId: 'v5-002', text: good, topic: '감성 숙소 비교' }] } }), 409))
  tracker.endMeasureRun()
  const saveBody = (drafts: unknown, key = qp.key) => ({ competitors: replaced, handoff, summary: '가상 바꿈', questions: { key, drafts } })
  ok('저장: 고친 질문 없이 저장하면 409(key 없음)', await rejects(ed.saveEdit(ID, store, { competitors: replaced, handoff }), 409))
  ok('저장: key가 다르면 409', await rejects(ed.saveEdit(ID, store, saveBody([{ fromId: 'v5-002', text: good, topic: '감성 숙소 비교' }], 'stale')), 409))
  ok('저장: 고친 질문이 빠지면 400', await rejects(ed.saveEdit(ID, store, saveBody([])), 400))
  ok('저장: 문장을 바꿔치기하면 400(검사)', await rejects(ed.saveEdit(ID, store, saveBody([{ fromId: 'v5-002', text: bad, topic: '감성 숙소 비교' }])), 400))
  ok('저장: 정리 전 문장이면 400(미리 본 것과 다름)', await rejects(ed.saveEdit(ID, store, saveBody([{ fromId: 'v5-002', text: ` ${good}`, topic: '감성 숙소 비교' }])), 400))
  ok('저장: 힌트가 깨졌으면 400', await rejects(ed.saveEdit(ID, store, { ...saveBody([]), handoff: [{ from: 1 }] }), 400))
  ok('거절된 저장은 아무것도 쓰지 않았다', !exists(`data/${ID}/question-bank/v6.json`) && !exists(`data/${ID}/competitors.json`))

  // 5) 실패 보상 — 수정본 쓰기가 실패하면 새 질문지를 지운다
  const tmpDir = path.join(dir, 'data', ID, `competitors.json.${process.pid}.tmp`)
  mkdirSync(tmpDir, { recursive: true })
  ok('수정본 쓰기가 실패하면 저장 실패', await rejects(ed.saveEdit(ID, store, saveBody([{ fromId: 'v5-002', text: good, topic: '감성 숙소 비교' }]))))
  ok('그때 만든 v6.json은 지운다 · 질문지는 v5 그대로', !exists(`data/${ID}/question-bank/v6.json`) && (await fresh()).questionBankVersion === 'v5')
  rmSync(tmpDir, { recursive: true, force: true })

  // 6) 저장
  const s1 = await ed.saveEdit(ID, store, saveBody([{ fromId: 'v5-002', text: good, topic: '감성 숙소 비교' }]))
  const v6 = readJson(`data/${ID}/question-bank/v6.json`)
  ok('저장: 서랍 상태가 v6 · 고친 질문지', s1.questionBank.version === 'v6' && s1.questionBank.derived?.from === 'v5' && s1.questionBank.derived.replaced === 1)
  ok('v6.json: 미리 본 문장 그대로', v6.questions.find((x: { questionId: string }) => x.questionId === 'v6-002')?.text === good)
  ok('v6.json: 나머지 문항은 v5와 같고 순서도 같다', JSON.stringify(v6.questions.filter((x: { questionId: string }) => x.questionId !== 'v6-002')) === JSON.stringify(v5.questions.filter((x) => x.questionId !== 'v5-002')) && v6.questions[3].questionId === 'v6-002')
  ok('v6.json: cohortBank · derivedFrom', v6.cohortBank?.key === '가상업종__가상시' && v6.derivedFrom?.version === 'v5' && v6.derivedFrom.replaced[0]?.to === 'v6-002')
  const t1 = await fresh()
  ok('측정이 읽는 설정: v6 · 7문항 · 새 목록', t1.questionBankVersion === 'v6' && t1.questionBankSize === 7 && t1.competitors[0]!.name === '새펜션A')
  const mtime = statSync(path.join(dir, 'data', ID, 'question-bank', 'v6.json')).mtimeMs
  const questions = await pipeline.ensureQuestionBank(t1, store)
  ok('첫 측정은 v6를 그대로 쓴다(판정 엔진 없이 · 파일 그대로)', questions.length === 7 && questions[3]!.text === good && statSync(path.join(dir, 'data', ID, 'question-bank', 'v6.json')).mtimeMs === mtime)

  // 7) 되돌리기 — 질문지도 v5로. v6.json은 남고 다음 계획은 v7
  await ed.undoEdit(ID, store)
  ok('되돌리면 v5 · 옛 목록', (await fresh()).questionBankVersion === 'v5' && (await fresh()).competitors[0]!.name === '가상골목')
  ok('되돌려도 v6.json은 남는다', exists(`data/${ID}/question-bank/v6.json`))
  const plan2 = await ed.planEdit(await fresh(), await reg.loadRuntimeTenants(), store, replaced, undefined, handoff)
  ok('되돌린 뒤 다시 계획하면 v7', plan2.questions.toVersion === 'v7' && plan2.questions.items[0]!.toId === 'v7-002')

  // 8) 빼기만 있는 저장 — 판정 엔진 없이 v7 · 6문항
  const dropped = COMPETITORS.filter((x) => x.name !== '가상선연')
  const plan3 = await ed.planEdit(await fresh(), await reg.loadRuntimeTenants(), store, dropped)
  ok('빼기 계획: v5-004 뺌 · 7 → 6 · 고쳐 쓸 것 없음', plan3.questions.mode === 'derive' && plan3.questions.items.every((i) => i.action === 'remove') && plan3.questions.sizeAfter === 6)
  const removeOnly = await rw.draftCompetitorRewrites(await ed.questionRewriteContext(ID, store, { competitors: dropped, key: plan3.questions.key }), new FakeJudge(() => new Error('부르면 안 된다')))
  ok('빼기만 있으면 판정 엔진을 부르지 않는다', removeOnly.drafts.length === 0 && removeOnly.failed.length === 0)
  await ed.saveEdit(ID, store, { competitors: dropped, questions: { key: plan3.questions.key, drafts: [] } })
  const t3 = await fresh()
  ok('빼기 저장: v7 · 6문항', t3.questionBankVersion === 'v7' && t3.questionBankSize === 6 && readJson(`data/${ID}/question-bank/v7.json`).questions.length === 6)

  // 9) 넘겨받을 것 없는 바꿈은 앱 질문지를 그대로 잇는다(저장소 v5로 떨어지지 않게)
  const reordered = [dropped[1]!, dropped[0]!, ...dropped.slice(2)]
  const plan4 = await ed.planEdit(t3, await reg.loadRuntimeTenants(), store, reordered)
  ok('순서만 바꿈: same · v7 그대로', plan4.questions.mode === 'same' && plan4.questions.toVersion === 'v7')
  await ed.saveEdit(ID, store, { competitors: reordered })
  ok('순서만 바꾼 저장 뒤에도 v7 · 6문항', (await fresh()).questionBankVersion === 'v7' && (await fresh()).questionBankSize === 6)

  // 10) 저장소 목록으로 돌아가면 저장소 질문지(v5)로
  const plan5 = await ed.planEdit(await fresh(), await reg.loadRuntimeTenants(), store, COMPETITORS)
  ok('저장소 목록으로 돌아감: repo · v5', plan5.questions.mode === 'repo' && plan5.questions.toVersion === 'v5')
  await ed.saveEdit(ID, store, { competitors: COMPETITORS })
  ok('돌아간 뒤 v5 · 7문항', (await fresh()).questionBankVersion === 'v5' && (await fresh()).questionBankSize === 7)

  // 11) 저장소가 같은 버전 이름(v7)을 따로 쓰면 측정을 멈춘다(D12)
  writeJson('tenants.overlay.json', [{ ...tenant, questionBankVersion: 'v7', questionBankSize: 6 }])
  ok('저장소 v7 + 앱이 만든 v7.json → 측정을 멈춘다', await rejects(pipeline.ensureQuestionBank(await fresh(), store)))
  writeJson('tenants.overlay.json', [tenant])

  // 12) 저장소 메서드
  let refused = false
  try {
    await store.createQuestionBank(ID, { ...v5, version: 'v6' })
  } catch {
    refused = true
  }
  ok('createQuestionBank: 있는 버전은 덮어쓰지 않는다', refused && readJson(`data/${ID}/question-bank/v6.json`).derivedFrom?.version === 'v5')
  ok('listQuestionBankVersions: 파일 이름', (await store.listQuestionBankVersions(ID)).sort().join() === 'v5,v6,v7')
  await store.removeQuestionBank(ID, 'v9')
  ok('removeQuestionBank: 없는 파일은 그냥 넘어간다', true)

  // 13) 고쳐 쓰기 실패 — 세 번 다 검사에 걸리면 실패로 돌려주고 남기지 않는다. 오류 · 시간 초과는 다시 시도하지 않는다.
  const plan6 = await ed.planEdit(await fresh(), await reg.loadRuntimeTenants(), store, replaced, undefined, handoff)
  const ctx6 = await ed.questionRewriteContext(ID, store, { competitors: replaced, handoff, key: plan6.questions.key })
  const always = new FakeJudge(() => JSON.stringify({ text: bad }))
  const f1 = await rw.draftCompetitorRewrites(ctx6, always)
  ok('세 번 실패: failed와 이유', f1.drafts.length === 0 && f1.failed[0]?.fromId === 'v5-002' && f1.failed[0]!.reasons.includes('나간 경쟁사 이름이 남았어요') && always.prompts.length === 3)
  await rw.draftCompetitorRewrites(ctx6, always)
  ok('실패한 결과는 남기지 않는다(다시 열면 다시 쓴다)', always.prompts.length === 6)
  const throwing = new FakeJudge(() => new Error('가상 API 오류'))
  const f2 = await rw.draftCompetitorRewrites(ctx6, throwing, { fresh: true })
  ok('판정 오류는 한 번만 부르고 실패로 돌려준다', throwing.prompts.length === 1 && f2.failed[0]?.reasons[0] === '가상 API 오류')
  const empty = new FakeJudge(() => '')
  const f3 = await rw.draftCompetitorRewrites(ctx6, empty, { fresh: true })
  ok('빈 응답은 다시 시도하고 이유를 남긴다', empty.prompts.length === 3 && f3.failed[0]?.reasons[0] === '판정 엔진이 빈 응답을 돌려줬어요')
  process.env.VERCEL = '1'
  ok('Vercel에서는 고쳐 쓰지 않는다', await rejects(() => rw.draftCompetitorRewrites(ctx6, always, { fresh: true })))
  delete process.env.VERCEL

  // 14) 모의 판정(USE_MOCK_ENGINES) — 고쳐 쓰기 응답이 검사를 통과한다
  const item = plan6.questions.items[0]!
  const mockAnswer = await new MockJudgeClient().call(
    buildCompetitorRewritePrompt({ industry: '가상업종', region: '가상시 (영어 질문)', brandName: '가상머뭄', brandAliases: ['가상,머뭄'], source: item.source, swaps: item.swaps.map((s) => ({ from: s.from, to: s.to! })), keep: item.keep, topicNeedsRewrite: item.topicNeedsRewrite }),
  )
  const parsedMock = JSON.parse(mockAnswer.text) as { text: string; topic: string }
  ok('모의 판정: 고쳐 쓴 문장이 검사를 통과한다', checkRewrite(parsedMock.text, parsedMock.topic, { item, brandNames: ['가상머뭄', '가상,머뭄'], language: 'ko', next: replaced, otherTexts: [] }).reasons.length === 0)
  ok('프롬프트: 지역 꼬리표 「(영어 질문)」은 뗀다', !buildCompetitorRewritePrompt({ industry: 'x', region: '가상시 (영어 질문)', brandName: 'b', brandAliases: [], source: item.source, swaps: [], keep: [], topicNeedsRewrite: false }).user.includes('(영어 질문)'))
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
