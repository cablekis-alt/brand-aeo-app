/**
 * 측정 회차별 보기를 확인한다 — 회차 읽기(server/store.ts listRunSnapshots) · 그 주 표본(server/runSamples.ts) · 덮기 전 옮겨 두기
 * (server/preserveWeekFile.ts) · 회차 지표(server/runHistory.ts) · 95% 범위(server/exactInterval.ts) · 그림 모델(src/lib/runTrend.ts) ·
 * 패널 마크업(src/components/RunTrendPanel.tsx). 임시 폴더를 APP_DATA_DIR로 쓰고 가짜 브랜드 · 가짜 엔진 · 가짜 주소만 쓴다.
 *
 * 왜: 같은 주에 여러 번 잰 회차가 사라지지 않게 남긴 뒤(v0.4.26), 그 회차로 「올린 글이 며칠째 처음 인용됐나」를 본다. 회차 하나의 점수는
 * 같은 날에도 크게 흔들려(실측 16→1→6) 그림이 잡음을 변화처럼 보이면 안 된다 — 저장된 신뢰구간 띠 · 중앙값 · 코호트 순위를 그리지 않고,
 * 엔진이 빠진 회차 · 조건이 바뀐 자리 · 옛 기록은 잇지 않는다.
 *
 *   npx tsx scripts/verify-run-history.ts
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { PublishedPost } from '../server/publishedPosts'
import type { QuestionBank, RunMeta, RunReadIssue, RunSnapshot } from '../server/store'
import type { QuestionRepeatAnalysis } from '../server/types'
import type { RunHistory, RunPoint, RunPostRow } from '../src/lib/api'
import type { WeeklyScorecard } from '../src/prompts/b8-report'

const dir = mkdtempSync(path.join(tmpdir(), 'verify-run-history-'))
process.env.APP_DATA_DIR = dir
process.env.BLOB_READ_WRITE_TOKEN = ''
process.env.BLOB_STORE_ID = ''
process.env.USE_MOCK_ENGINES = 'true'
delete process.env.MOCK_REPORT_DELAY_MS

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])
const writeJson = (rel: string, value: unknown) => {
  const file = path.join(dir, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value))
}
const near = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) < 0.00005

const T = 'rv'
const answer = (questionId: string, day: string, cites: string[] = [], extra: Partial<QuestionRepeatAnalysis> = {}) =>
  ({
    questionId,
    engine: 'gemini',
    callIndex: 1,
    mentioned: false,
    mentionSentences: [],
    competitorMentions: [],
    shareOfMention: 0,
    topRecommendation: null,
    brandRank: null,
    factualityClaims: [],
    factualitySupported: 0,
    factualityContradicted: 0,
    brandOwnedCitation: false,
    citations: cites.map((raw) => ({ raw, domain: null, ownerType: 'third-party-ugc', supportsBrandMention: false })),
    timing: { startedAt: day.includes('T') ? day : `${day}T01:00:00Z`, wallMs: 0, judgeMs: { mention: 0, citation: 0, rank: 0, fact: 0 } },
    ...extra,
  }) as unknown as QuestionRepeatAnalysis
const card = (weekOf: string, extra: Partial<WeeklyScorecard> = {}) =>
  ({ tenantId: T, weekOf, industry: '펜션', region: '가상시', enginesUsed: ['gemini'], questionBankVersion: 'v1', judgeEngine: 'mock', aeoScore: { current: 5 }, ...extra }) as unknown as WeeklyScorecard
const meta = (weekOf: string, runId: string, finishedAt: string, extra: Partial<RunMeta> = {}): RunMeta => ({
  runId,
  tenantId: T,
  weekOf,
  startedAt: finishedAt,
  finishedAt,
  selfOnly: true,
  inCohortRun: false,
  weekCard: 'saved',
  engines: { gemini: { planned: 2, succeeded: 2 } },
  engineIssues: [],
  contextFingerprint: 'ctx-a',
  collectUsage: {},
  ...extra,
})

try {
  const { FileResultStore } = await import('../server/store')
  const { weekSamples } = await import('../server/runSamples')
  const { preserveUnrecordedWeekFile } = await import('../server/preserveWeekFile')
  const { clopperPearson } = await import('../server/exactInterval')
  const { getRunHistory } = await import('../server/runHistory')
  const { getPublishedHistory } = await import('../server/publishedHistory')
  const { summarizePost } = await import('../src/lib/publishTracking')

  // ── 1부: 회차 읽기 · 표본 · 옮겨 두기 ──────────────────────────────────────────────
  const store = new FileResultStore()
  ok('회차 읽기: runs/가 없으면 빈 결과', JSON.stringify(await store.listRunSnapshots(T, '2026-W40')) === JSON.stringify({ runs: [], issues: [] }))
  const runDir = (weekOf: string, runId: string) => `data/${T}/${weekOf}/runs/${runId}`
  const putRun = (weekOf: string, runId: string, finishedAt: string, analyses: QuestionRepeatAnalysis[], extra: { meta?: Partial<RunMeta>; card?: Partial<WeeklyScorecard> } = {}) => {
    writeJson(`${runDir(weekOf, runId)}/scorecard.json`, card(weekOf, extra.card))
    writeJson(`${runDir(weekOf, runId)}/question-analyses.json`, analyses)
    writeJson(`${runDir(weekOf, runId)}/run.json`, meta(weekOf, runId, finishedAt, extra.meta))
  }
  putRun('2026-W41', 'b-late', '2026-10-09T05:00:00Z', [answer('v1-001', '2026-10-09')])
  putRun('2026-W41', 'a-early-2', '2026-10-08T05:00:00Z', [answer('v1-001', '2026-10-08')])
  writeJson(`${runDir('2026-W41', 'c-half')}/scorecard.json`, card('2026-W41')) // run.json 없음 — 쓰다 만 회차
  writeJson(`${runDir('2026-W41', 'd-broken')}/run.json`, meta('2026-W41', 'd-broken', '2026-10-10T00:00:00Z'))
  writeFileSync(path.join(dir, runDir('2026-W41', 'd-broken'), 'scorecard.json'), '{ 깨진')
  writeJson(`${runDir('2026-W41', 'd-broken')}/question-analyses.json`, [])
  const read = await store.listRunSnapshots(T, '2026-W41')
  ok('회차 읽기: 쓰다 만 회차는 건너뛰고 깨진 회차는 issues · 완료 시각 순', read.runs.map((r) => r.meta.runId).join() === 'a-early-2,b-late' && read.issues.length === 1 && read.issues[0]!.runId === 'd-broken')
  ok('회차 읽기: 같은 회차를 다시 읽으면 붙잡아 둔 것을 쓴다', (await store.listRunSnapshots(T, '2026-W41')).runs[0] === read.runs[0])

  // 표본 — 그 주 파일과 판정 시작 시각이 같은 회차는 그 주 파일 판정을 쓴다(정비 반영), 짝이 없는 그 주 파일은 따로 하나
  const weekFixed = [answer('v1-001', '2026-10-09', ['https://fixed.example/1'])]
  const s1 = await weekSamples(store, T, card('2026-W41', { enginesUsed: ['gemini', 'perplexity'] }), weekFixed)
  ok(
    '표본: 짝지은 회차는 그 주 파일 판정 · 자기 판정은 따로',
    s1.samples.length === 2 && s1.samples[1]!.isWeekFile && s1.samples[1]!.analyses === weekFixed && s1.samples[1]!.ownAnalyses !== weekFixed,
  )
  ok('표본: 그 주 카드 엔진이 회차에 없으면 빠진 엔진', s1.samples.every((s) => s.missingEngines.join() === 'perplexity'))
  const s2 = await weekSamples(store, T, card('2026-W41'), [answer('v1-001', '2026-10-06')])
  ok('표본: 어느 회차와도 맞지 않는 그 주 파일은 week-file 표본(시각 순 맨 앞)', s2.samples.length === 3 && s2.samples[0]!.kind === 'week-file' && s2.samples[0]!.isWeekFile)
  putRun('2026-W42', 'p', '2026-10-15T05:00:00Z', [answer('v1-001', '2026-10-15')], { meta: { engines: { gemini: { planned: 4, succeeded: 3 } } } })
  ok('표본: 일부만 들어온 엔진', (await weekSamples(store, T, card('2026-W42'), [])).samples[0]!.partialEngines.join() === 'gemini')
  // 같은 측정이 두 번 남은 경우(회차를 잠깐 못 읽은 사이 옮겨 두기가 또 남김) — 하나로 접고 원래 회차를 남긴다
  const same = [answer('v1-001', '2026-10-27T01:00:00Z')]
  putRun('2026-W44', 'orig', '2026-10-27T02:00:00Z', same)
  putRun('2026-W44', 'orig-preserved', '2026-10-27T01:00:00Z', same, { meta: { preserved: { from: 'week-file', preservedAt: '2026-10-29T00:00:00Z' } } })
  const dup = await weekSamples(store, T, card('2026-W44'), [answer('v1-001', '2026-10-29')])
  ok('표본: 판정 시각이 같은 회차는 하나로 접고 옮겨 둔 쪽을 버린다', dup.samples.filter((s) => s.kind === 'run').map((s) => s.runId).join() === 'orig')

  // 옮겨 두기 — 회차 기록이 없는 그 주 파일을 runs/로
  writeJson(`data/${T}/scorecard-history.json`, [card('2026-W43')])
  writeJson(`data/${T}/2026-W43/question-analyses.json`, [answer('v1-001', '2026-10-22T07:28:00Z'), answer('v1-002', '2026-10-22T07:29:00Z', [], { engine: 'perplexity' as QuestionRepeatAnalysis['engine'] })])
  const kept = await preserveUnrecordedWeekFile(store, T, '2026-W43', new Date('2026-10-23T00:00:00Z'))
  const moved = await store.listRunSnapshots(T, '2026-W43')
  ok(
    '옮겨 두기: 회차 없는 그 주 파일을 옛 측정 시각 이름으로 옮기고 표시 · 엔진별 응답 수',
    kept === '2026-10-22T07-29-00Z-preserved' &&
      moved.runs.length === 1 &&
      moved.runs[0]!.meta.preserved?.from === 'week-file' &&
      moved.runs[0]!.meta.engines.perplexity?.succeeded === 1 &&
      moved.runs[0]!.analyses.length === 2,
  )
  ok('옮겨 두기: 이미 짝이 있으면 쓰지 않는다', (await preserveUnrecordedWeekFile(store, T, '2026-W43')) === null && (await store.listRunSnapshots(T, '2026-W43')).runs.length === 1)
  ok('옮겨 두기: 그 주 판정이 없으면 쓰지 않는다', (await preserveUnrecordedWeekFile(store, T, '2026-W44')) === null)
  writeJson(`data/${T}/2026-W45/question-analyses.json`, [answer('v1-001', '2026-11-03')])
  ok('옮겨 두기: 그 주 카드가 없으면 쓰지 않는다', (await preserveUnrecordedWeekFile(store, T, '2026-W45')) === null)

  // ── 2부: 회차 지표 · 조건 · 글 행 · 범위 ────────────────────────────────────────────
  ok('범위: 0/78', near(clopperPearson(0, 78)?.lower, 0) && near(clopperPearson(0, 78)?.upper, 0.0462))
  ok('범위: 1/78', near(clopperPearson(1, 78)?.lower, 0.0003) && near(clopperPearson(1, 78)?.upper, 0.0694))
  ok('범위: 3/78', near(clopperPearson(3, 78)?.lower, 0.008) && near(clopperPearson(3, 78)?.upper, 0.1083))
  ok('범위: 1/3 · 0/3', near(clopperPearson(1, 3)?.lower, 0.0084) && near(clopperPearson(1, 3)?.upper, 0.9057) && near(clopperPearson(0, 3)?.upper, 0.7076))
  ok('범위: n=0 · k>n은 null, k=n이면 상한 1', clopperPearson(0, 0) === null && clopperPearson(4, 3) === null && clopperPearson(3, 3)?.upper === 1)

  // 지표 정의 — 가짜 저장소. 카테고리 무관 질문의 답 가운데 언급되고 순위가 있는 응답만 k, 되묻기 포함 N.
  const bank = (version: string): QuestionBank =>
    ({
      version,
      generatedAt: '2026-10-01T00:00:00Z',
      questions: [
        { questionId: 'v5-001', text: '군산 숙소 추천', category: 'category-agnostic', containsBrandName: false },
        { questionId: 'v5-002', text: '가상 펜션 어때', category: 'brand-direct', containsBrandName: true },
      ],
    }) as unknown as QuestionBank
  const POST = 'https://fake-blog.example/post/1'
  const ranked = (day: string, cites: string[] = []) => answer('v5-001', day, cites, { mentioned: true, brandRank: 2 })
  const fakeStore = (cards: WeeklyScorecard[], weekFiles: Record<string, QuestionRepeatAnalysis[]>, runs: Record<string, { runs: RunSnapshot[]; issues: RunReadIssue[] }>, banks: Record<string, QuestionBank>) => ({
    getScorecardHistory: async (_t: string, n: number) => cards.slice(-n),
    getQuestionAnalyses: async (_t: string, w: string) => weekFiles[w] ?? [],
    getQuestionBank: async (_t: string, v: string) => banks[v] ?? null,
    listRunSnapshots: async (_t: string, w: string) => runs[w] ?? { runs: [], issues: [] },
  })
  const snap = (weekOf: string, runId: string, finishedAt: string, analyses: QuestionRepeatAnalysis[], m: Partial<RunMeta> = {}, c: Partial<WeeklyScorecard> = {}): RunSnapshot => ({
    meta: meta(weekOf, runId, finishedAt, m),
    scorecard: card(weekOf, { questionBankVersion: 'v5', ...c }),
    analyses,
  })
  // 10-21(수, W43)에 올림. W43: D+1(인용 없음) · W44: D+3(인용 없음) · D+5(Perplexity 빠짐) · W45: D+12(인용, 별칭 바뀜) · W46: 질문지 v9(은행 없음)
  const post: PublishedPost = {
    id: 'post-1',
    url: POST,
    key: 'fake-blog.example/post/1',
    publishedOn: '2026-10-21',
    publishedOnSource: 'user',
    recordedAt: '2026-10-21T01:00:00Z',
    articleId: 'content:a',
    targetActionId: 'listing:platform:fake-blog.example',
    via: 'channel',
    articleTitle: '가상 글',
  } as PublishedPost
  const w43 = [ranked('2026-10-22'), answer('v5-001', '2026-10-22'), answer('v5-002', '2026-10-22', [], { mentioned: true, brandRank: 1 })]
  const w44a = [answer('v5-001', '2026-10-24'), answer('v5-002', '2026-10-24')]
  const w44b = [answer('v5-001', '2026-10-26')]
  const w45 = [ranked('2026-11-02', [POST]), ranked('2026-11-02T02:00:00Z'), answer('v5-001', '2026-11-02', [], { clarifying: true } as Partial<QuestionRepeatAnalysis>)]
  const w46 = [answer('v5-001', '2026-11-09')]
  const cards = [card('2026-W43', { questionBankVersion: 'v5', aeoScore: { current: 9 } as WeeklyScorecard['aeoScore'] }), card('2026-W44', { questionBankVersion: 'v5' }), card('2026-W45', { questionBankVersion: 'v5' }), card('2026-W46', { questionBankVersion: 'v9' })]
  const fs1 = fakeStore(
    cards,
    { '2026-W43': w43, '2026-W44': w44a, '2026-W45': w45, '2026-W46': w46 },
    {
      '2026-W44': {
        runs: [
          snap('2026-W44', 'r44a', '2026-10-24T02:00:00Z', w44a),
          snap('2026-W44', 'r44b', '2026-10-26T02:00:00Z', w44b, { weekCard: 'kept', weekCardKeptReason: '엔진 빠짐', engines: { gemini: { planned: 2, succeeded: 2 }, perplexity: { planned: 2, succeeded: 0 } } }),
        ],
        issues: [],
      },
      '2026-W45': { runs: [snap('2026-W45', 'r45', '2026-11-02T03:00:00Z', w45, { contextFingerprint: 'ctx-b' })], issues: [] },
      '2026-W46': { runs: [snap('2026-W46', 'r46', '2026-11-09T03:00:00Z', w46, {}, { questionBankVersion: 'v9' })], issues: [] },
    },
    { v5: bank('v5') },
  )
  const tenant = { tenantId: T, questionBankVersion: 'v5' }
  const rh = await getRunHistory(fs1, tenant, [post], 6)
  const at = (runId: string | null, weekOf?: string) => rh.points.find((p) => p.runId === runId && (!weekOf || p.weekOf === weekOf))!
  const legacy = rh.points.find((p) => p.kind === 'week-file')!
  ok('회차 지표: k는 카테고리 무관 응답 중 언급 · 순위 있는 것, N은 그 질문 응답 전부(되묻기 포함)', at('r45').ranked?.k === 2 && at('r45').ranked?.n === 3 && legacy.ranked?.k === 1 && legacy.ranked?.n === 2)
  ok('회차 지표: 이름 댄 질문의 순위는 세지 않는다', legacy.ranked?.k === 1)
  ok('회차 지표: 회차 카드 판의 은행이 없으면 확인 불가(0이 아니다)', at('r46').ranked === null && at('r46').score === null)
  ok('회차 지표: 범위는 k/N의 Clopper–Pearson', near(at('r45').ranked?.ci?.lower, clopperPearson(2, 3)!.lower))
  ok('조건: 판정 맥락이 바뀐 자리 · 질문지가 바뀐 자리', at('r45').changesFromPrev.includes('판정 맥락') && at('r46').changesFromPrev.includes('질문지'))
  ok('조건: 예정 엔진이 바뀐 자리', at('r44b').changesFromPrev.includes('예정 엔진'))
  ok('회차: 옛 기록은 week-file · 지금 그 주 카드 표시', legacy.weekCard === 'week-file' && legacy.isWeekCard && at('r44a').isWeekCard && !at('r44b').isWeekCard && at('r44b').weekCard === 'kept')
  ok('회차: 카드를 덮지 않은 회차는 빠진 엔진', at('r44b').missingEngines.join() === 'perplexity')
  const row = rh.posts[0]!
  ok(
    '글 행: 올린 뒤 5회 중 1회 인용 · 첫 인용 D+12(직전 인용 없음 D+5)',
    row.measuredRuns === 5 && row.citedRuns === 1 && row.firstCited?.daysAfterPublish === 12 && row.lastUncitedDaysBefore === 5,
  )
  ok('글 행: 엔진 빠진 회차 1(Perplexity) · 14일 지난 회차는 D+19 하나(인용 없음)', row.weakRuns === 1 && row.weakEngines.join() === 'perplexity' && row.afterGrace.measured === 1 && row.afterGrace.cited === 0)
  const ph = await getPublishedHistory(fs1, tenant, [post], 12)
  const sum = summarizePost(ph.posts[0]!.cells, ph.weeks)
  ok('글 행: 성과 표 판단과 같은 회차 수(표와 패널 일치)', sum.measuredRuns === row.measuredRuns && sum.citedRuns === row.citedRuns && sum.firstCitedDays === row.firstCited?.daysAfterPublish)
  ok('그림 범위: 회차 칸은 그림에 보이는 점과 같은 수', row.cells.length === rh.points.length)
  ok('그 주 카드 점수(막대)를 함께 싣는다', rh.weekCardScores['2026-W43'] === 9)
  ok('저장된 신뢰구간 · 코호트 순위 필드를 싣지 않는다', !JSON.stringify(rh).includes('ciLow') && !JSON.stringify(rh).includes('cohortRank'))

  // 정비 스크립트가 그 주 파일만 고친 경우 — 회차 지표(순위)는 회차 자기 판정으로, 올린 글 칸은 그 주 파일(고친 판정)로 센다
  const own = [ranked('2026-11-16')]
  const fixed = [answer('v5-001', '2026-11-16', [POST])]
  const fs2 = fakeStore([card('2026-W47', { questionBankVersion: 'v5' })], { '2026-W47': fixed }, { '2026-W47': { runs: [snap('2026-W47', 'r47', '2026-11-16T03:00:00Z', own)], issues: [] } }, { v5: bank('v5') })
  const rh2 = await getRunHistory(fs2, tenant, [post], 6)
  ok('정비 반영: 순위 응답은 회차 자기 판정(k=1), 올린 글 칸은 그 주 파일(인용 1)', rh2.points[0]?.ranked?.k === 1 && rh2.posts[0]?.cells[0]?.cited === 1)

  // 글별 요약은 그림 범위(최근 장)가 아니라 성과 표와 같은 기간 — 그림을 1장으로 줄여도 요약은 그대로
  const narrow = await getRunHistory(fs1, tenant, [post], 1)
  ok('그림을 1주로 줄여도 글별 요약은 올린 뒤 전체', narrow.points.every((p) => p.weekOf === '2026-W46') && narrow.posts[0]!.measuredRuns === 5 && narrow.posts[0]!.citedRuns === 1)

  // 실측 일치 — 가짜 엔진으로 두 번 재면 회차 2개, 다시 센 점수 = 측정 때 점수
  const { measureAndBake } = await import('../server/measureAndBake')
  const reg = await import('../server/tenantRegistry')
  const BRAND = {
    tenantId: 'live', brandName: '회차 펜션', aliases: ['회차 펜션'], ownedDomains: ['live.example'], industry: '펜션', region: '가상시',
    engines: ['gemini'], questionBankSize: 6, questionBankVersion: 'v1', repeatsPerQuestion: 2, factGraph: [], competitors: [{ name: '이웃 펜션', aliases: ['이웃 펜션'], domains: ['near.example'] }],
  }
  writeJson('tenants.overlay.json', [BRAND])
  process.env.COLLECT_ENGINES = 'gemini'
  const live = async () => (await reg.loadRuntimeTenants()).find((t) => t.tenantId === 'live')!
  await measureAndBake(await live(), store, { selfOnly: true })
  await measureAndBake(await live(), store, { selfOnly: true })
  const real = await getRunHistory(store, await live(), [], 6)
  ok('실측: 같은 주 두 번 → 회차 점 2개', real.points.length === 2 && real.points.every((p) => p.kind === 'run'))
  ok('실측: 다시 센 점수 = 측정 때 점수', real.points.every((p) => p.score !== null && p.score === p.scoreAtMeasure))
  const weekOf = real.points[0]!.weekOf
  const runIds = readdirSync(path.join(dir, 'data/live', weekOf, 'runs'))
  const storedCards = await Promise.all(runIds.map(async (id) => (await store.listRunSnapshots('live', weekOf)).runs.find((r) => r.meta.runId === id)!.scorecard))
  ok('실측: 순위 응답 k = 회차 카드 rankedResponses', real.points.every((p) => storedCards.some((c) => c.rankedResponses === p.ranked?.k)))

  // ── 3부: 그림 모델 · 패널 마크업 ───────────────────────────────────────────────────
  const { buildRunTrend } = await import('../src/lib/runTrend')
  const point = (runId: string, at: string, extra: Partial<RunPoint> = {}): RunPoint => ({
    kind: 'run', runId, weekOf: '2026-W44', at, window: null, selfOnly: true, inCohortRun: false, weekCard: 'saved', isWeekCard: false,
    engines: { openai: { planned: 26, succeeded: 26 }, gemini: { planned: 26, succeeded: 26 } }, enginesUsed: ['gemini', 'openai'], partialEngines: [], missingEngines: [],
    engineIssues: [], conditionKey: 'k1', changesFromPrev: [], bankVersion: 'v5', ranked: { k: 1, n: 78, mentioned: 2, ci: clopperPearson(1, 78) },
    score: 6, scoreAtMeasure: 6, agnosticQuestions: 26, repeatsPerQuestion: 1, ...extra,
  })
  const cellOf = (days: number, cited = 0): RunPostRow['cells'][number] => ({ timing: 'after', afterRemoval: false, daysAfterPublish: days, withinGrace: days < 14, cited, unnamedCited: cited, variantCited: 0, byEngine: cited ? { perplexity: cited } : {} })
  const pts = [
    point('a', '2026-10-27T01:00:00Z'),
    point('b', '2026-10-27T05:00:00Z'),
    point('c', '2026-10-27T16:00:00Z', { engines: { openai: { planned: 26, succeeded: 26 }, gemini: { planned: 26, succeeded: 12 } }, partialEngines: ['gemini'] }),
    point('d', '2026-10-29T02:00:00Z', { changesFromPrev: ['판정 맥락'], conditionKey: 'k2', score: 16 }),
    point('e', '2026-10-30T02:00:00Z', { conditionKey: 'k2', score: 1 }),
  ]
  const mkRow = (id: string, cells: RunPostRow['cells'], extra: Partial<RunPostRow> = {}): RunPostRow => ({
    post: { ...post, id, articleTitle: `글 ${id}` },
    cells,
    measuredRuns: 3,
    citedRuns: 1,
    afterGrace: { measured: 0, cited: 0 },
    firstCited: { at: '2026-10-29T02:00:00Z', daysAfterPublish: 8 },
    lastUncitedDaysBefore: 6,
    unsureRuns: 0,
    weakRuns: 1,
    weakEngines: ['gemini'],
    ...extra,
  })
  const hist: RunHistory = {
    points: pts,
    posts: [
      mkRow('x', [cellOf(6), cellOf(6), cellOf(7), cellOf(8, 2), cellOf(9)]),
      mkRow('y', [cellOf(6), cellOf(6), cellOf(7), cellOf(8), cellOf(9)], { post: { ...post, id: 'y', key: 'fake-blog.example/post/2', url: 'https://fake-blog.example/post/2', articleTitle: '글 y' }, citedRuns: 0, firstCited: null }),
    ],
    weekCardScores: { '2026-W44': 1 },
    issues: [],
  }
  const model = buildRunTrend(hist)
  const dayOf = (d: string) => model.days.indexOf(d)
  ok('그림: 같은 한국 날 두 회차는 칸 안 1/4 · 3/4 자리', model.dots[0]!.x === dayOf('2026-10-27') + 0.25 && model.dots[1]!.x === dayOf('2026-10-27') + 0.75)
  ok('그림: UTC 16시 회차는 다음 한국 날 칸', Math.floor(model.dots[2]!.x) === dayOf('2026-10-28'))
  ok('그림: 엔진 일부만 든 회차 · 조건이 바뀐 자리에서 끊는다', JSON.stringify(model.segments) === JSON.stringify([[0, 1], [3, 4]]) && model.dots[2]!.isolated && model.breaks.length === 1)
  ok('그림: 조건이 섞인 주는 점수 평균을 내지 않는다', model.scoreLine[0]!.mixed && model.scoreLine[0]!.mean === null && model.scoreLine[0]!.bar === 1)
  ok('그림: 같은 날 올린 두 글은 핀 하나 · 줄 이름은 1a · 1b', model.pins.length === 1 && model.pins[0]!.postings.length === 2 && model.rows.map((r) => r.label).join() === '1a,1b')
  ok('그림: 평균에서 뺀 회차를 까닭별로 센다(엔진 빠진 회차 1)', model.scoreLine[0]!.isolated === 1 && model.scoreLine[0]!.legacy === 0)
  ok('그림: 엔진이 빠진 회차의 인용 없음은 근거 약함 표시', model.rows[1]!.marks[2] === 'weak' && model.rows[0]!.marks[3] === 'cited' && model.rows[0]!.marks[0] === 'grace')
  ok('그림: 이 브랜드의 같은 날 흔들림(옛 기록 제외)', model.sameDay?.date === '2026-10-27' && model.sameDay.scores.join() === '6,6')
  // 같은 날 엔진이 빠진 회차는 흔들림 안내에 넣지 않는다(엔진 실패를 잡음으로 설명하지 않게)
  const swing = buildRunTrend({
    ...hist,
    points: [point('s1', '2026-10-27T01:00:00Z', { score: 32 }), point('s2', '2026-10-27T02:00:00Z', { score: 0, missingEngines: ['gemini'] }), point('s3', '2026-10-27T03:00:00Z', { score: 30 })],
    posts: [],
  })
  ok('그림: 같은 날 흔들림은 엔진이 빠진 회차를 뺀다', swing.sameDay?.scores.join() === '32,30')

  const React = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  Object.assign(globalThis, { React })
  const { default: RunTrendPanel } = await import('../src/components/RunTrendPanel')
  const withLegacy: RunHistory = { ...hist, points: [point('old', '2026-10-26T01:00:00Z', { kind: 'week-file', runId: null, weekCard: 'week-file', engines: null }), ...pts], posts: hist.posts.map((r) => ({ ...r, cells: [null, ...r.cells] })) }
  const html = renderToStaticMarkup(React.createElement(RunTrendPanel, { history: withLegacy, selectedWeek: '2026-W44' }))
  ok('패널: 저장된 신뢰구간 띠 · 중앙값 · 코호트 순위를 그리지 않는다', !html.includes('st-band') && !html.includes('중앙값') && !html.includes('코호트'))
  ok('패널: 일부만 든 회차는 점선 점 · 조건 변경은 마름모 · 옛 기록은 네모', html.includes('rt-dot-partial') && html.includes('st-break-mark') && html.includes('rt-base'))
  ok('패널: 범례에 범위 방식과 쉬운 말', html.includes('Clopper–Pearson') && html.includes('대략의 범위') && html.includes('같은 26문항을 엔진 2곳에'))
  ok('패널: 글 요약 — 첫 인용 확인 D+8(직전 D+6) · 인용된 회차 1/3 · 엔진 빠진 회차(Gemini)', html.includes('첫 인용 확인 D+8(직전 인용 없음 D+6)') && html.includes('인용된 회차 1/3') && html.includes('엔진 빠진 회차 1(Gemini)'))
  ok('패널: 글별 95% 범위는 싣지 않는다', !/인용된 회차 1\/3 \(95%/.test(html))
  ok('패널: 회차 표에 엔진 성공/예정', html.includes('Gemini 12/26'))
  ok('패널: 같은 날 올린 글은 줄 이름으로 가른다(글1a · 글1b)', html.includes('글1a') && html.includes('글1b'))
  ok('패널: 카테고리 무관 질문이라고 밝힌다', html.includes('카테고리 무관 질문'))
  ok('패널: 점수는 조건 섞임이면 평균 안 냄', html.includes('조건 섞임 — 평균 안 냄'))
} finally {
  delete process.env.COLLECT_ENGINES
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
