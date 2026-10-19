/**
 * 경쟁사 편집 5단계 「업종 다름」 — 확인(규칙 · 엔진), 판정 저장(고객별 파일), 사람 표시, 그리고 서랍 계산(줄 표시 · 넘겨받기 제외 ·
 * 후보 거르기)을 확인한다. 임시 폴더를 APP_DATA_DIR로 쓰고 가짜 고객 · 가짜 엔진만 쓴다. 실제 AI는 부르지 않는다.
 *
 * 왜: 다른 업종 곳은 고객 업종 질문으로 재서 점수가 낮게 나오고, 그곳과 견주는 비교 질문은 고객 업종 질문이 아니다. 판정이 목록 저장 ·
 * 되돌리기 때 사라지거나, 엔진 오류가 판정으로 남으면 서랍이 엉뚱한 표시를 한다.
 *
 *   npx tsx scripts/verify-competitor-industry.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { PromptMessage } from '../src/prompts/types'

const dir = mkdtempSync(path.join(tmpdir(), 'verify-competitor-industry-'))
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
const industryFile = (id: string) => path.join(dir, 'data', id, 'competitor-industry.json')

/** 받은 프롬프트를 남기는 가짜 엔진. */
class FakeEngine {
  prompts: PromptMessage[] = []
  constructor(private answer: (prompt: PromptMessage) => string | Error) {}
  async call(prompt: PromptMessage) {
    this.prompts.push(prompt)
    const a = this.answer(prompt)
    if (a instanceof Error) throw a
    return { text: a, citations: [], usedWebSearch: true, model: 'fake-grounded' }
  }
}

const ID = 'fake-industry-customer'
const c = (name: string) => ({ name, aliases: [name], domains: [] as string[] })
const COMPETITORS = [c('가상골목'), c('가상옥도'), c('가상초원'), c('가상선연'), c('바닷가해돋이')]
const tenant = {
  tenantId: ID,
  brandName: '가상머뭄',
  aliases: ['가상머뭄'],
  ownedDomains: ['fake-mumum.example'],
  industry: '펜션',
  region: '가상시',
  competitors: COMPETITORS,
  engines: ['gemini'],
  questionBankSize: 7,
  questionBankVersion: 'v5',
  repeatsPerQuestion: 1,
  factGraph: [],
  cohortQuestionBank: 'c1',
}
// 같은 코호트의 등록 브랜드(경쟁사 후보) · 다른 업종의 고객 브랜드(규칙 판정)
const portal = { ...tenant, tenantId: 'fake-portal', brandName: '가상관광포털', aliases: ['가상관광포털'], ownedDomains: ['fake-portal.example'], competitors: [], cohortOnly: true }
const tourCustomer = { ...tenant, tenantId: 'fake-tour', brandName: '가상여행모음', aliases: ['가상여행모음'], ownedDomains: ['fake-tour.example'], industry: '관광안내', competitors: [] }
const q = (questionId: string, text: string, extra: Record<string, unknown> = {}) => ({
  questionId, text, category: 'comparison', stage: 'consider', industry: '펜션', region: '가상시', containsBrandName: true, version: questionId.split('-')[0], ...extra,
})
const shared = [
  q('c1-001', '가상시 펜션 추천해줘', { category: 'category-agnostic', containsBrandName: false, cohortShared: true }),
  q('c1-002', '가상시에서 펜션 고를 때 뭘 봐야 해?', { category: 'category-agnostic', containsBrandName: false, cohortShared: true }),
]

try {
  writeJson('tenants.overlay.json', [tenant, portal, tourCustomer])
  writeJson(`cohort-banks/펜션__가상시/c1.json`, { key: '펜션__가상시', industry: '펜션', region: '가상시', version: 'c1', generatedAt: 'x', questions: shared })
  writeJson(`data/${ID}/question-bank/v5.json`, {
    version: 'v5',
    generatedAt: 'x',
    cohortBank: { key: '펜션__가상시', version: 'c1' },
    questions: [
      ...shared,
      q('v5-001', '가상머뭄 체크인 몇 시야?', { category: 'brand-direct' }),
      q('v5-002', '가상머뭄이랑 가상골목 중에 어디가 더 나아?'),
      q('v5-003', '가족 여행이면 가상머뭄이랑 가상초원 중 어디가 좋아?'),
      q('v5-004', '커플 여행 갈 때 가상머뭄이랑 가상선연 중 어디가 나아?'),
      q('v5-005', '가상머뭄이랑 가상옥도 부대시설 차이 알려줘'),
    ],
  })

  const ed = await import('../server/competitorEditor')
  const reg = await import('../server/tenantRegistry')
  const tracker = await import('../server/measureTracker')
  const fileStore = await import('../server/tenantCompetitorsStore')
  const { checkCompetitorIndustry, industryByRule } = await import('../server/competitorIndustry')
  const { buildCompetitorIndustryPrompt } = await import('../src/prompts/b1e-competitor-industry')
  const { FileResultStore } = await import('../server/store')
  const store = new FileResultStore()
  const fresh = async () => (await reg.loadRuntimeTenants()).find((t) => t.tenantId === ID)!

  // 1) 규칙 — AI 없이 정하는 경우
  const runtime = await reg.loadRuntimeTenants()
  const t0 = await fresh()
  ok('규칙: 이름이 고객 업종으로 끝나면 같은 업종(바닷가해돋이펜션)', industryByRule(t0, c('바닷가해돋이펜션'), runtime)?.verdict === 'same')
  ok('규칙: 업종 이름 그 자체는 같은 업종으로 보지 않는다(「펜션」)', industryByRule(t0, c('펜션'), runtime) === null)
  const rTour = industryByRule(t0, c('가상 여행모음'), runtime)
  ok('규칙: 다른 업종의 고객 브랜드면 다른 업종(띄어쓰기 무시)', rTour?.verdict === 'different' && rTour.looksLike === '관광안내')
  ok('규칙: 경쟁사 초안(cohortOnly)의 업종은 증거가 아니다', industryByRule(t0, c('가상관광포털'), runtime) === null)

  // 2) 엔진 — 한 번 묻고, 읽을 수 없으면 모름
  const diff = new FakeEngine(() => '설명입니다\n```json\n{"verdict":"different","looksLike":"관광 정보 사이트","reason":"숙소가 아니라 여행 정보를 모아요"}\n```')
  const r1 = await checkCompetitorIndustry(t0, c('가상관광포털'), { client: diff, engine: 'gemini', runtime })
  ok('엔진: different · 무엇으로 보이는지 · 근거', r1.verdict === 'different' && r1.looksLike === '관광 정보 사이트' && Boolean(r1.reason) && diff.prompts.length === 1 && r1.engine === 'fake-grounded')
  ok('프롬프트: 고객 질문 기준 · 점검할 업체', diff.prompts[0]!.system.includes('가상시 펜션 추천해줘') && diff.prompts[0]!.user.includes('점검할 업체: 가상관광포털'))
  const garbage = await checkCompetitorIndustry(t0, c('가상관광포털'), { client: new FakeEngine(() => '잘 모르겠어요'), engine: 'gemini', runtime })
  ok('엔진: 답을 읽을 수 없으면 모름(unsure)', garbage.verdict === 'unsure')
  ok('엔진: 오류는 던진다(저장하지 않게)', await rejects(checkCompetitorIndustry(t0, c('가상관광포털'), { client: new FakeEngine(() => new Error('가상 API 오류')), engine: 'gemini', runtime })))
  process.env.VERCEL = '1'
  ok('Vercel에서는 확인하지 않는다', await rejects(() => checkCompetitorIndustry(t0, c('가상관광포털'), { client: diff, engine: 'gemini', runtime })))
  delete process.env.VERCEL
  ok('프롬프트: 지역 꼬리표 「(영어 질문)」은 뗀다 · B2B는 공급사 질문', (() => {
    const p = buildCompetitorIndustryPrompt({ brandName: 'b', industry: '셋톱박스 제조', region: '국내 (영어 질문)', marketScope: 'b2b', buyer: '통신사 구매 담당', competitorName: 'x', aliases: [] })
    return !p.user.includes('(영어 질문)') && p.system.includes('셋톱박스 제조 공급사') && p.user.includes('통신사 구매 담당')
  })())

  // 3) 서랍의 확인 · 표시(라우트 함수) — 캐시, 오류는 저장하지 않음, 사람 표시가 먼저
  const err = new FakeEngine(() => new Error('가상 그라운딩 오류'))
  const e1 = await ed.checkEditorIndustry(ID, { name: '가상관광포털' }, () => err)
  ok('확인 실패: verdict null · error · 파일을 쓰지 않는다', e1.verdict === null && e1.error === '가상 그라운딩 오류' && !existsSync(industryFile(ID)))
  const engine = new FakeEngine(() => JSON.stringify({ verdict: 'different', looksLike: '관광 정보 사이트', reason: '여행 정보' }))
  const k1 = await ed.checkEditorIndustry(ID, { name: '가상관광포털' }, () => engine)
  ok('확인: 다른 업종으로 저장', k1.verdict === 'different' && k1.by === 'ai' && JSON.parse(readFileSync(industryFile(ID), 'utf8')).entries['가상관광포털']?.ai?.customerIndustry === '펜션')
  await ed.checkEditorIndustry(ID, { name: '가상 관광포털' }, () => engine)
  ok('같은 이름(띄어쓰기 무시)은 다시 묻지 않는다', engine.prompts.length === 1)
  const ruled = new FakeEngine(() => new Error('부르면 안 된다'))
  ok('규칙으로 정하는 이름은 엔진을 부르지 않는다', (await ed.checkEditorIndustry(ID, { name: '바닷가해돋이펜션' }, () => ruled)).verdict === 'same' && ruled.prompts.length === 0)
  tracker.beginMeasureRun()
  ok('측정 중에도 확인한다(결정 F2)', (await ed.checkEditorIndustry(ID, { name: '가상 여행모음' }, () => ruled)).verdict === 'different')
  tracker.endMeasureRun()
  ok('잘못된 입력은 400', await rejects(ed.checkEditorIndustry(ID, { name: '  ' }, () => engine), 400))
  ok('표시: 알 수 없는 값은 400', await rejects(ed.markEditorIndustry(ID, { name: '가상관광포털', mark: 'maybe' }), 400))
  const m1 = await ed.markEditorIndustry(ID, { name: '가상관광포털', mark: 'same' })
  ok('「펜션 맞음」 — 사람 표시가 AI 판정보다 먼저', m1.verdict === 'same' && m1.by === 'person')
  const m2 = await ed.markEditorIndustry(ID, { name: '가상관광포털', mark: null })
  ok('사람 표시를 지우면 AI 판정으로 돌아간다', m2.verdict === 'different' && m2.by === 'ai')

  // 4) 서랍 계산 — 줄 표시 · 받는 곳에서 뺌 · 후보에서 거름
  const sState = await ed.buildEditorState(await fresh(), await reg.loadRuntimeTenants(), store)
  ok('후보: 다른 업종으로 본 곳(가상관광포털)은 권하지 않는다', !sState.suggestions.some((x) => x.name === '가상관광포털'))
  await ed.markEditorIndustry(ID, { name: '가상관광포털', mark: 'same' })
  const sState2 = await ed.buildEditorState(await fresh(), await reg.loadRuntimeTenants(), store)
  ok('사람이 「펜션 맞음」으로 풀면 다시 권한다', sState2.suggestions.some((x) => x.name === '가상관광포털'))
  await ed.markEditorIndustry(ID, { name: '가상관광포털', mark: null })

  // 바꿈: 가상골목 → 가상관광포털(다른 업종) — 그곳은 v5-002를 받지 않고, 이미 재는데 질문 없는 바닷가해돋이가 받는다
  const replaced = [c('가상관광포털'), ...COMPETITORS.slice(1)]
  const handoff = [{ from: '가상골목', to: '가상관광포털' }]
  const p1 = await ed.planEdit(await fresh(), await reg.loadRuntimeTenants(), store, replaced, undefined, handoff)
  const item = p1.questions.items.find((i) => i.fromId === 'v5-002')
  ok('줄 표시: 가상관광포털은 업종 다름(ai)', p1.rows[0]?.industry?.verdict === 'different' && p1.rows[0]?.industry?.by === 'ai')
  ok('넘겨받기: 업종 다름은 받지 않는다 → 이미 재는 바닷가해돋이가 받는다', item?.swaps[0]?.to?.name === '바닷가해돋이' && item.swaps[0]?.via === 'existing')
  ok('비교 질문 없음 안내에서도 업종 다름은 뺀다', !p1.noQuestion.includes('가상관광포털'))
  await ed.markEditorIndustry(ID, { name: '바닷가해돋이', mark: 'different' })
  const p2 = await ed.planEdit(await fresh(), await reg.loadRuntimeTenants(), store, replaced, undefined, handoff)
  ok('받을 곳이 모두 업종 다름이면 뺀다 · 이유 otherIndustry', p2.questions.items.find((i) => i.fromId === 'v5-002')?.action === 'remove' && p2.questions.unreceived[0]?.reason === 'otherIndustry')
  ok('표시가 바뀌면 계획 key도 바뀐다(미리 본 계획으로 저장 409)', p1.questions.key !== p2.questions.key && (await rejects(ed.saveEdit(ID, store, { competitors: replaced, handoff, questions: { key: p1.questions.key, drafts: [] } }), 409)))

  // 5) 판정은 목록 저장 · 되돌리기 · 저장소로 돌아가기 · 측정 기록과 따로 살아남는다
  const before = readFileSync(industryFile(ID), 'utf8')
  await ed.saveEdit(ID, store, { competitors: replaced, handoff, questions: { key: p2.questions.key, drafts: [] } })
  await fileStore.recordCompetitorMeasurement(ID, replaced, new Date(Date.now() - 1000).toISOString(), 'v6')
  await ed.undoEdit(ID, store)
  ok('저장 · 측정 기록 · 되돌리기 뒤에도 판정 파일 그대로', readFileSync(industryFile(ID), 'utf8') === before)
  ok('되돌린 뒤 줄 표시도 그대로(바닷가해돋이 업종 다름 · 사람)', (await ed.buildEditorState(await fresh(), await reg.loadRuntimeTenants(), store)).rows.find((r) => r.name === '바닷가해돋이')?.industry?.by === 'person')

  // 6) 고객 업종이 바뀌면 AI 판정은 낡은 값(다시 묻는다), 사람 표시는 그대로
  writeJson('tenants.overlay.json', [{ ...tenant, industry: '숙박' }, portal, tourCustomer])
  const again = new FakeEngine(() => JSON.stringify({ verdict: 'same', looksLike: '숙박 정보', reason: 'x' }))
  const k2 = await ed.checkEditorIndustry(ID, { name: '가상관광포털' }, () => again)
  ok('고객 업종이 바뀌면 AI 판정을 다시 묻는다', again.prompts.length === 1 && k2.verdict === 'same')
  ok('사람 표시는 업종이 바뀌어도 그대로', (await ed.checkEditorIndustry(ID, { name: '바닷가해돋이' }, () => again)).by === 'person' && again.prompts.length === 1)
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
