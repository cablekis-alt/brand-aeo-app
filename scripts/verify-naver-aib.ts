/**
 * 네이버 AI 브리핑 시범 검사(2026-11-23 승인 — 구글 AI 개요 실행기 · 규칙 · 화면을 「검색 면」으로 공용화, ②). 구글 면의 동작은
 * scripts/verify-google-aio.ts가 지킨다 — 이 파일은 네이버 면만 본다. 진짜 SerpAPI · LLM은 부르지 않는다(검색 · 판정은 주입).
 *
 * A. 규칙(src/lib/googleAio.ts) — 검색 인자(engine=naver_ai_overview · query · no_cache, 위치 없음) · 최대 검색 수(질문당 1 + 다시 검색 몫) ·
 *    조건 서명 · 수집 엔진 'naver'(구글 회차와 「같은 조건」으로 묶이지 않음) · 응답 판독(있음 · 없음 · 결과 0건 · 오류 · 못 읽음 · markdown
 *    대체) · 화면 글 바꾸기(조사 받침) · 설정(기본 시범 브랜드 gunsan · 형식) · 회차 형식.
 * B. 실행기(server/googleAio.ts, 같은 프로세스 · 임시 APP_DATA_DIR) — 네이버 회차는 질문당 검색 1회 · 후속 없음 · 판정 · 문항 query 칸 ·
 *    못 읽음 다시 검색 10%. 이 PC 설정은 면마다 다른 파일이고, 회차 폴더도 면마다 다르다(다른 면 형식 파일은 「읽지 못한 회차」).
 * C. 몫 · 연결(server/serpApi.ts) — 기능 'naver' · 몫 10%(월 1,000회면 100회).
 * D. 화면 연결 — 경로 /naver-aib · 메뉴 「네이버 AI 브리핑(시범)」 · 서버 길 /api/naver-aib(Host · Origin 검사 목록 포함).
 *
 * 실행:
 *   npx tsx scripts/verify-naver-aib.ts
 */
import { execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  GOOGLE_SURFACE,
  NAVER_AIB_FORMAT,
  NAVER_SURFACE,
  aibSearchParams,
  aioConditions,
  aioQuestionSet,
  forSurface,
  parseAioRun,
  parseSurfaceSettings,
  readAibFirst,
  readSurfaceFirst,
  surfaceMaxSearches,
  surfaceOfRun,
  surfaceSearch,
  surfaceSignature,
  type AioRun,
} from '../src/lib/googleAio'
import type { TenantConfig } from '../server/types'
import type { AioJudgeFn, AioSearchFn } from '../server/googleAio'

let failed = 0
let passed = 0
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed += 1
    console.log(`✓ ${name}`)
  } else {
    failed += 1
    console.log(`✗ ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail, null, 1)}`}`)
  }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// ══ A. 규칙 ══════════════════════════════════════════════════════════════════════

ok('A 면 — 네이버: 기능 naver · 질문당 검색 1 · 위치 안 씀 · 회차 폴더 naver-aib · 기본 시범 브랜드 gunsan', NAVER_SURFACE.feature === 'naver' && NAVER_SURFACE.searchesPerQuestion === 1 && !NAVER_SURFACE.usesLocation && NAVER_SURFACE.runDir === 'naver-aib' && same(NAVER_SURFACE.defaultTenants, ['gunsan']))
ok('A 면 — 구글은 그대로(기능 aio · 질문당 2 · 위치 씀 · google-aio)', GOOGLE_SURFACE.feature === 'aio' && GOOGLE_SURFACE.searchesPerQuestion === 2 && GOOGLE_SURFACE.usesLocation && GOOGLE_SURFACE.runDir === 'google-aio')
ok('A 검색 인자 — engine=naver_ai_overview · query(앞뒤 공백만 뗌) · no_cache, 위치 · 키 칸 없음', same(aibSearchParams('  군산 1박 2일 코스 추천해줘. '), { engine: 'naver_ai_overview', query: '군산 1박 2일 코스 추천해줘.', no_cache: 'true' }))
{
  const s = surfaceSearch(NAVER_SURFACE, ' 질문 ', 'Gunsan-si,Jeollabuk-do,South Korea')
  ok('A 검색 인자 — 네이버 면은 위치를 넘겨도 싣지 않고, 문항 query는 보낸 글자 그대로', s.query === '질문' && !('location' in s.params) && s.params.query === '질문')
  const g = surfaceSearch(GOOGLE_SURFACE, ' 질문 ', 'Gunsan-si,Jeollabuk-do,South Korea')
  ok('A 검색 인자 — 구글 면은 예전처럼 q · 위치', g.query === '질문' && g.params.engine === 'google' && g.params.location === 'Gunsan-si,Jeollabuk-do,South Korea')
}
ok('A 최대 검색 — 네이버 48문항 = 48 + 다시 검색 5 = 53 · 구글 48문항 = 106(예전 2n + 2⌈0.1n⌉과 같음)', surfaceMaxSearches(48, NAVER_SURFACE) === 53 && surfaceMaxSearches(48, GOOGLE_SURFACE) === 106)
ok('A 조건 서명 — 네이버는 엔진 · 캐시만(위치 없음), 구글 서명과 다르다', surfaceSignature(null, NAVER_SURFACE) === 'naver-aib serpapi engine=naver_ai_overview cache=off' && surfaceSignature(null, GOOGLE_SURFACE).startsWith('google-aio '))
{
  const qs = [{ questionId: 'c1-001', text: '가짜 질문' }]
  const set = aioQuestionSet(qs)
  const c = aioConditions({ startedAt: '2026-11-23T03:00:00.000Z', location: null, bankVersion: 'v7', questionSet: set, judgeEngine: 'claude', judgeModel: null, surface: NAVER_SURFACE })
  ok('A 조건 — 수집 엔진 naver · 수집 모델 칸도 naver(구글 회차와 「같은 조건」으로 묶이지 않음)', same(c.enginesUsed, ['naver']) && Object.keys(c.modelsUsed).join() === 'naver' && c.location === null, c)
}

const meta = (extra: Record<string, unknown> = {}) => ({ search_metadata: { id: 'naver-search-1', status: 'Success', ...extra }, search_parameters: { engine: 'naver_ai_overview', query: '가짜' } })
const BRIEF = {
  ...meta(),
  markdown: '군산 여행은 근대역사거리부터.[1]',
  text_blocks: [{ type: 'paragraph', snippet: '군산 여행은 근대역사거리부터 둘러보세요.', reference_indexes: [1] }],
  references: [{ index: 1, title: '군산 여행 정리', link: 'https://example.com/gunsan', source: '예시 사이트' }],
  media: [{ position: 1, type: 'image', link: 'https://example.com/a.jpg' }],
}
{
  const r = readAibFirst(BRIEF)
  const read = r.step === 'done' ? r.read : null
  ok(
    'A 판독 — 브리핑 칸이 있으면 있음(inline) · 본문은 text_blocks 펼친 글 · 출처 · searchId',
    read?.status === 'shown' && read.kind === 'inline' && read.overview.text.includes('근대역사거리') && read.overview.references.length === 1 && read.overview.references[0]!.link === 'https://example.com/gunsan' && read.searchId === 'naver-search-1',
    read,
  )
  const raw = read?.status === 'shown' ? (read.overview.rawBlock as Record<string, unknown>) : null
  ok('A 판독 — 원문 블록에는 브리핑 칸만(검색 메타 · 매개변수 없음)', !!raw && !('search_metadata' in raw) && !('search_parameters' in raw) && 'text_blocks' in raw)
}
{
  const r = readAibFirst({ ...meta(), markdown: '본문은 markdown에만 있어요.', text_blocks: [], references: [] })
  ok('A 판독 — text_blocks가 비면 markdown을 본문으로', r.step === 'done' && r.read.status === 'shown' && r.read.overview.text === '본문은 markdown에만 있어요.', r)
}
{
  const absent = readAibFirst({ ...meta() })
  const none = readAibFirst({ ...meta(), error: "Naver hasn't returned any results for this query." })
  const err = readAibFirst({ ...meta(), error: 'Something else went wrong.' })
  const notOk = readAibFirst({ search_metadata: { id: 'x', status: 'Error' } })
  const shape = readAibFirst({ nope: true })
  const empty = readAibFirst({ ...meta(), text_blocks: [], references: [] })
  const mediaOnly = readAibFirst({ ...meta(), media: [{ type: 'image' }] })
  const st = (r: ReturnType<typeof readAibFirst>) => (r.step === 'done' ? [r.read.status, 'reason' in r.read ? r.read.reason : 'noResults' in r.read ? r.read.noResults : null] : ['follow-up'])
  ok('A 판독 — 브리핑 칸이 하나도 없음 → 없음', same(st(absent), ['absent', false]))
  ok('A 판독 — 결과 0건 문구 → 없음(noResults)', same(st(none), ['absent', true]))
  ok('A 판독 — 다른 error 문구 → 오류(upstream-error)', same(st(err), ['failed', 'upstream-error']))
  ok('A 판독 — Success 아님 → 오류(not-success) · 메타 없음 → 오류(shape)', same(st(notOk), ['failed', 'not-success']) && same(st(shape), ['failed', 'shape']))
  ok('A 판독 — 칸은 있는데 글자 · 출처 없음 → 못 읽음(overview-empty)', same(st(empty), ['unreadable', 'overview-empty']))
  ok('A 판독 — 그림(media)만 오면 브리핑이 아니라 없음', same(st(mediaOnly), ['absent', false]))
  ok('A 판독 — 네이버 판독은 후속을 만들지 않는다(늘 끝남)', [absent, none, err, notOk, shape, empty].every((r) => r.step === 'done'))
  ok('A 판독 — readSurfaceFirst는 면에 맞는 판독기를 고른다', readSurfaceFirst(NAVER_SURFACE, BRIEF).step === 'done' && readSurfaceFirst(GOOGLE_SURFACE, BRIEF).step === 'done' && (readSurfaceFirst(GOOGLE_SURFACE, BRIEF) as { read: { status: string } }).read.status === 'absent')
}

const cases: [string, string][] = [
  ['구글 AI 개요 시범', '네이버 AI 브리핑 시범'],
  ['AI 개요가 뜬 질문', 'AI 브리핑이 뜬 질문'],
  ['AI 개요는 있지만 언급 없음', 'AI 브리핑은 있지만 언급 없음'],
  ['판정 불가로 남은 개요를', '판정 불가로 남은 브리핑을'],
  ['출처 목록과 함께 온 개요가 없어요', '출처 목록과 함께 온 브리핑이 없어요'],
  ['개요와 출처', '브리핑과 출처'],
  ['개요로 보기', '브리핑으로 보기'],
  ['구글에서 보기(새 창)', '네이버에서 보기(새 창)'],
  ['구글을 쓰고 구글이 바뀌면 구글은', '네이버를 쓰고 네이버가 바뀌면 네이버는'],
  ['AI 개요 없음', 'AI 브리핑 없음'],
]
for (const [from, want] of cases) ok(`A 화면 글 — 「${from}」 → 「${want}」`, forSurface(from, NAVER_SURFACE) === want, forSurface(from, NAVER_SURFACE))
ok('A 화면 글 — 구글 면은 한 글자도 바꾸지 않는다', cases.every(([from]) => forSurface(from, GOOGLE_SURFACE) === from))

{
  const def = parseSurfaceSettings(undefined, NAVER_SURFACE)
  const google = parseSurfaceSettings({ format: 'google-aio-settings/1', enabled: true }, NAVER_SURFACE)
  const mine = parseSurfaceSettings({ format: 'naver-aib-settings/1', enabled: true, tenants: ['gunsan', 'web4ai'] }, NAVER_SURFACE)
  ok('A 설정 — 파일이 없으면 꺼짐 · 시범 브랜드 gunsan · 형식 naver-aib-settings/1', def.ok && !def.settings.enabled && same(def.settings.tenants, ['gunsan']) && def.settings.format === 'naver-aib-settings/1')
  ok('A 설정 — 구글 설정 형식이 네이버 파일에 오면 오류(켜짐으로 짐작하지 않음)', !google.ok)
  ok('A 설정 — 네이버 형식 · 켜짐 · 브랜드 목록', mine.ok && mine.settings.enabled && same(mine.settings.tenants, ['gunsan', 'web4ai']))
}

// ══ B. 실행기 ════════════════════════════════════════════════════════════════════

const dir = mkdtempSync(path.join(os.tmpdir(), 'verify-naver-aib-'))
Object.assign(process.env, {
  APP_DATA_DIR: dir,
  DOTENV_CONFIG_PATH: path.join(dir, 'no-such.env'),
  SERPAPI_API_KEY: 'fake-serp-key-naver',
  SERPAPI_LIVE: '',
  SERPAPI_BASE_URL: 'http://127.0.0.1:9',
  USE_MOCK_ENGINES: 'true',
  GEMINI_API_KEY: '',
  OPENAI_API_KEY: '',
  ANTHROPIC_API_KEY: '',
  PERPLEXITY_API_KEY: '',
  JUDGE_ENGINE: '',
})
const realFetch = globalThis.fetch
let outside = 0
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (!/^http:\/\/127\.0\.0\.1[:/]/.test(url)) outside += 1
  return realFetch(input, init)
}) as typeof fetch

const writeJson = (p: string, v: unknown) => {
  mkdirSync(path.dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(v, null, 2))
}
const aio = await import('../server/googleAio')
const serp = await import('../server/serpApi')

const BRAND = { brandName: '군산각', aliases: ['gunsangak'], ownedDomains: ['gunsan.example'], competitors: [{ name: '가짜 관광 앱', aliases: [], domains: [] }], industry: '여행 정보', region: '전북 군산' }
const QS = ['brief', 'absent', 'empty', 'brief', 'none'].map((k, i) => ({ questionId: `c1-${String(i + 1).padStart(3, '0')}`, text: `가짜 질문 ${k} ${i + 1}` }))
const OK_TEXT = JSON.stringify({ targetBrand: { mentioned: true, mentionCount: 1, mentions: [{ mentionOrder: 1, sentence: '군산각에서 코스를 볼 수 있어요.', sentiment: 'neutral' }] }, competitorMentions: [] })
const judgeOk: AioJudgeFn = async () => ({ text: OK_TEXT, citations: [], usedWebSearch: false, model: 'fake-judge-1', inputTokens: 50, outputTokens: 10 })
const seen: Record<string, string>[] = []
const search: AioSearchFn = async (params) => {
  seen.push({ ...params })
  const kind = (params.query ?? '').split(' ')[2]
  if (kind === 'brief') return { json: { ...BRIEF, markdown: '군산각에서 코스를 볼 수 있어요.', text_blocks: [{ type: 'paragraph', snippet: '군산각에서 코스를 볼 수 있어요.' }] } }
  if (kind === 'empty') return { json: { ...meta(), text_blocks: [], references: [] } }
  if (kind === 'none') return { json: { ...meta(), error: "Naver hasn't returned any results for this query." } }
  return { json: meta() }
}
{
  const run = aio.newAioRun({ tenantId: 'vnaib', startedAt: new Date('2026-11-23T03:00:00.000Z'), location: null, bankVersion: 'v7', cohortBank: null, questions: QS, cycle: '2026-12-08', judgeEngine: 'fake-judge', surface: NAVER_SURFACE })
  ok('B 새 회차 — 형식 naver-aib/1 · 최대 검색 5 + 1 = 6 · 수집 엔진 naver', run.format === NAVER_AIB_FORMAT && run.maxSearches === 6 && same(run.conditions.enginesUsed, ['naver']) && surfaceOfRun(run) === NAVER_SURFACE, { format: run.format, max: run.maxSearches })
  const saved: AioRun[] = []
  const out = await aio.executeAioRun(run, QS, BRAND, { search, judge: judgeOk, judgeEngine: 'fake-judge', save: async (r) => void saved.push(structuredClone(r)), measuring: () => false })
  const status = out.items.map((i) => [i.questionId, i.status, i.reason ?? null, i.searches])
  ok(
    'B 실행 — 질문마다 engine=naver_ai_overview · query로 보냄(후속 없음 · 위치 없음 · 키 칸 없음)',
    seen.every((p) => p.engine === 'naver_ai_overview' && typeof p.query === 'string' && !('q' in p) && !('location' in p) && !('page_token' in p) && !('api_key' in p)),
    seen,
  )
  ok(
    'B 실행 — 있음 2 · 없음 1 · 결과 0건 없음 1 · 빈 브리핑은 한 번 다시 검색한 뒤 못 읽음(검색 2) · 검색 합 6 = M',
    same(status, [
      ['c1-001', 'shown', null, 1],
      ['c1-002', 'absent', null, 1],
      ['c1-003', 'unreadable', 'overview-empty', 2],
      ['c1-004', 'shown', null, 1],
      ['c1-005', 'absent', null, 1],
    ]) &&
      out.usage.searches === 6 &&
      out.usage.followUps === 0 &&
      out.usage.reSearches === 1 &&
      seen.length === 6,
    { status, usage: out.usage, sent: seen.length },
  )
  ok('B 실행 — 있음만 판정(2회) · 언급 true · 판정 모델 기록', out.usage.judgeCalls === 2 && out.items.filter((i) => i.status === 'shown').every((i) => i.mentioned === true && i.judgeEngine === 'fake-judge') && out.conditions.judgeModel === 'fake-judge-1')
  // 잰 문항(있음 + 없음)이 4/5 = 80%라 끝까지 갔어도 done이 아니라 partial(coverage) — 구글 면과 같은 90% 규칙.
  ok(
    'B 실행 — 문항 query는 보낸 질문 글자 · 잰 문항 4/5(90% 미만)라 partial(coverage) · 저장이 문항마다 불림',
    out.items[0]!.query === '가짜 질문 brief 1' && out.state === 'partial' && out.stopReason === 'coverage' && saved.length >= QS.length,
    { state: out.state, stop: out.stopReason },
  )
}

// 설정 · 회차 폴더는 면마다 따로 — 서버 함수로(검색 0).
{
  const tenant = { tenantId: 'vnaib', ...BRAND, engines: ['gemini'], questionBankSize: 5, questionBankVersion: 'v7', repeatsPerQuestion: 1, factGraph: [], questionLanguage: 'ko' } as unknown as TenantConfig
  writeJson(path.join(dir, 'data', 'vnaib', 'question-bank', 'v7.json'), {
    version: 'v7',
    generatedAt: '2026-11-01T00:00:00.000Z',
    questions: QS.map((q) => ({ ...q, industry: '여행 정보', region: '전북 군산', containsBrandName: false, version: 'v7', category: 'category-agnostic' })),
  })
  await aio.saveGoogleAioSettings({ enabled: true }, NAVER_SURFACE)
  const naverFile = path.join(dir, 'naver-aib-settings.json')
  const googleFile = path.join(dir, 'google-aio-settings.json')
  const written = existsSync(naverFile) ? (JSON.parse(readFileSync(naverFile, 'utf8')) as Record<string, unknown>) : null
  ok('B 설정 — 네이버 켜기는 naver-aib-settings.json에만 적는다(구글 설정 파일은 만들지 않음)', written?.format === 'naver-aib-settings/1' && written.enabled === true && !existsSync(googleFile), written)

  // 아직 시범 브랜드가 아니다(기본은 gunsan) — 파일로 더한 뒤 다시 본다.
  const before = await aio.googleAioStatus(tenant, {}, NAVER_SURFACE)
  ok('B 상태 — 시범 브랜드가 아니면 pilot false(기본 시범 브랜드는 gunsan)', before.enabled && !before.pilot, before)
  writeJson(naverFile, { format: 'naver-aib-settings/1', enabled: true, tenants: ['vnaib'] })

  // 네이버 회차 하나 · 같은 폴더에 구글 형식 파일 하나(읽지 못한 회차로 센다), 구글 폴더의 회차는 네이버 화면에 보이지 않는다.
  const runN = aio.newAioRun({ tenantId: 'vnaib', startedAt: new Date('2026-11-22T03:00:00.000Z'), location: null, bankVersion: 'v7', cohortBank: null, questions: QS, cycle: '2026-12-08', judgeEngine: 'fake-judge', surface: NAVER_SURFACE })
  const runG = aio.newAioRun({ tenantId: 'vnaib', startedAt: new Date('2026-11-21T03:00:00.000Z'), location: null, bankVersion: 'v7', cohortBank: null, questions: QS, cycle: '2026-12-08', judgeEngine: 'fake-judge' })
  for (const r of [runN, runG]) Object.assign(r, { state: 'done', finishedAt: r.startedAt })
  writeJson(path.join(dir, 'data', 'vnaib', 'naver-aib', `${runN.runId}.json`), runN)
  writeJson(path.join(dir, 'data', 'vnaib', 'naver-aib', `${runG.runId}.json`), runG)
  writeJson(path.join(dir, 'data', 'vnaib', 'google-aio', `${runG.runId}.json`), runG)
  const st = await aio.googleAioStatus(tenant, {}, NAVER_SURFACE)
  ok(
    'B 상태 — 네이버 면: 시범 브랜드 · 위치 없음 · 서명은 네이버 · 회차는 네이버 형식만(같은 폴더의 구글 형식 1개는 읽지 못한 회차)',
    st.pilot && st.location === null && st.signature === surfaceSignature(null, NAVER_SURFACE) && st.view?.runs.length === 1 && st.view.runs[0]!.runId === runN.runId && st.unreadableRuns === 1,
    { pilot: st.pilot, msg: st.pilotMessage, sig: st.signature, runs: st.view?.runs.map((r) => r.runId), unreadable: st.unreadableRuns },
  )
  const gst = await aio.googleAioStatus(tenant, {}, GOOGLE_SURFACE)
  ok('B 상태 — 구글 면은 구글 설정 파일을 본다(없으면 꺼짐) · 네이버 회차를 섞지 않음', !gst.enabled && (gst.view?.runs ?? []).every((r) => r.runId === runG.runId))
  const detail = await aio.googleAioRunDetail(tenant, runN.runId, NAVER_SURFACE)
  ok('B 회차 상세 — 네이버 폴더에서 읽는다', detail.run.runId === runN.runId && detail.run.format === NAVER_AIB_FORMAT)
  const wrong = await aio.googleAioRunDetail(tenant, runN.runId, GOOGLE_SURFACE).then(
    () => null,
    (e: { status?: number }) => e.status ?? -1,
  )
  ok('B 회차 상세 — 구글 면으로 네이버 회차를 찾으면 404', wrong === 404, wrong)
  const parsed = parseAioRun(JSON.parse(JSON.stringify(runN)))
  ok('B 회차 파일 — 네이버 형식을 읽는다', parsed.ok)
}

// ══ C. 몫 · 연결 ═════════════════════════════════════════════════════════════════

ok('C 기능 — naver가 SerpAPI 기능 목록 · 이름에 있다', serp.SERP_FEATURES.includes('naver') && serp.FEATURE_LABEL.naver === '네이버 AI 브리핑 시범')
ok('C 몫 — 월 1,000회면 바닥 300 · 네이버 150 · AI 개요 400 · 색인 100 · 여유 50(합 100%)', same(serp.serpQuota(1000), { floor: 300, index: 100, aio: 400, naver: 150, slack: 50 }) && Object.values(serp.SERPAPI_BUDGET_PCT).reduce((a, b) => a + b, 0) === 100)

// ══ D. 화면 연결(정적) ════════════════════════════════════════════════════════════

const root = path.resolve(import.meta.dirname, '..')
const read = (p: string) => readFileSync(path.join(root, p), 'utf8')
ok('D 경로 — /naver-aib가 같은 화면을 네이버 면으로 연다', /path="naver-aib" element=\{<GoogleAio surface="naver" \/>\}/.test(read('src/App.tsx')))
ok('D 메뉴 — 「네이버 AI 브리핑(시범)」 · /naver-aib · 고객 브랜드만', /label: '네이버 AI 브리핑\(시범\)', to: '\/naver-aib', icon: 'aio', customerOnly: true/.test(read('src/lib/menu.ts')))
{
  const idx = read('server/index.ts')
  ok('D 서버 — 면마다 같은 라우트(/api/google-aio · /api/naver-aib) · Host · Origin 검사 목록에 /api/naver-aib', /for \(const sf of \[GOOGLE_SURFACE, NAVER_SURFACE\]\)/.test(idx) && idx.includes("'/api/google-aio', '/api/naver-aib'"))
}
ok('D 웹 함수 — 그대로 12개(api/ — 새 라우트는 Express 전용)', execSync('git ls-files api', { encoding: 'utf8', cwd: root }).trim().split(/\r?\n/).length === 12)
ok('D — .gitignore가 dev 설정 파일(server/naver-aib-settings.json)을 올리지 않는다', read('.gitignore').split(/\r?\n/).includes('server/naver-aib-settings.json'))

ok('— 이 프로세스의 fetch가 127.0.0.1 밖으로 나가려 한 적이 없다(진짜 SerpAPI · LLM 0회)', outside === 0, outside)

rmSync(dir, { recursive: true, force: true })
console.log(failed === 0 ? `\n모두 통과 (${passed}건)` : `\n${failed}건 실패`)
process.exit(failed === 0 ? 0 : 1)
