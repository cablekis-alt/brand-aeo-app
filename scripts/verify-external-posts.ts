/**
 * 앱 밖 글(src/lib/externalPosts.ts · server/externalPosts.ts)을 확인한다 — 저장 규칙, 인용 이력, 그리고 앱 글 기록과의 격리. 임시 폴더 ·
 * 가짜 측정 데이터만 쓴다(서버는 포트 4183에 임시로 띄운다). 앱 데이터 · 설치본(포트 4000) · AI는 부르지 않는다.
 *
 * 왜: 앱 밖 글(앱에서 만들지 않은 손글)은 집행 기록이 아니다. 원장(published-posts.json)이나 집행 상태(action-states.json)에 섞이면 콘텐츠
 * 보관함 · 정기진단 보고서 「집행 글 N편」 · 퍼포먼스 집행 핀 · 실행 계획이 손글을 집행으로 조용히 센다. 그래서 따로 두고, 앱 밖 글을 적고 ·
 * 고치고 · 빼도 원장 · 집행 상태 파일과 앱 글 응답(올린 글 목록 · 인용 이력 · 회차 보기)이 바이트 단위로 같은지 본다. 측정 · 집계 · 보고서 ·
 * 실행 계획 모듈은 새 모듈을 불러오지 않아야 한다(정적 검사 — 타입만 불러오는 것은 런타임에 없어 괜찮다. 그래서 src/lib/api.ts는 새 모듈을
 * 타입으로만 불러와야 한다 — 정기진단 보고서가 api.ts를 불러온다).
 *
 * 또 추적을 시작한 시각을 올린 시각으로 쓰면 같은 날 측정이 「올리기 전」이 되어 인용이 사라지고(C7), 내렸다 다시 올린 주소를 한 줄로
 * 되살리면 내린 동안도 「올라가 있음」으로 센다(C9). 같은 브랜드에 앱 글로 옮긴 주소는 두 표가 같은 측정을 두 번 세면 안 된다(D12).
 *
 * 색인 표시(index-checks.json)는 같은 주소 키로 앱 글 줄과 이어받는 것이 의도라(C15) 이 격리 검사 범위 밖이다.
 *
 * 3단계 — 퍼포먼스 「앱 밖 글 인용 추적」 절(src/lib/useExternalHistory.ts · src/pages/Performance.tsx)은 jsdom과 가짜 fetch로 그린다.
 * 웹(라우트 없음 404) · 앱 밖 글 0편이면 절을 숨기고(C19), 절이 있어도 나머지 화면(집행 핀 · 「집행」 칸 · 올린 글 표)은 한 글자도 바뀌지
 * 않아야 한다. 머리말은 자사 인용률과 더해 보이는 말을 쓰지 않는다(C1). 앱 글로 옮긴 행은 「내림」이 아니라 「앱 글로 옮김(날짜)」이다(D12).
 *
 *   npx tsx scripts/verify-external-posts.ts
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { QuestionBank, RunMeta } from '../server/store'
import type { QuestionRepeatAnalysis } from '../server/types'
import type { ExternalHistory as ClientExternalHistory } from '../src/lib/api'
import type { WeeklyScorecard } from '../src/prompts/b8-report'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])
const repo = process.cwd()

// ── 1) 정적 검사 — 측정 · 집계 · 원장 · 보고서 · 실행 계획은 새 모듈을 불러오지 않는다 ─────────────────────────────
const NEW_MODULES = ['src/lib/externalPosts.ts', 'server/externalPosts.ts']
/** 닫힘(불러오는 모듈을 따라간 전체)에 새 모듈이 없어야 하는 뿌리. */
const CLOSED_ROOTS = [
  // 측정 · 집계 · 점수 · 코호트
  'server/pipeline.ts',
  'server/aggregate.ts',
  'server/scoring.ts',
  'server/store.ts',
  'server/ciSync.ts',
  'server/cohortRank.ts',
  'server/measureAndBake.ts',
  'scripts/ci-measure.ts',
  'scripts/measure-local.ts',
  // 원장 · 인용 이력 · 회차 보기 · 집행 상태
  'server/publishedPosts.ts',
  'server/publishedHistory.ts',
  'server/runHistory.ts',
  'server/actionStates.ts',
  // 정기진단 보고서 · 실행 계획 · 같은 조건
  'src/pages/PeriodicReport.tsx',
  'src/lib/publishTracking.ts',
  'src/lib/gapActions.ts',
  'src/lib/publishPlan.ts',
  'src/lib/recommendationEvidence.ts',
  'src/lib/comparability.ts',
  'src/pages/GapActions.tsx',
  'src/pages/Dashboard.tsx',
]
/**
 * 직접 불러오지 않아야 하는 앱 글 화면 — 콘텐츠 보관함 · 질문 은행은 작성자 진행 규칙(src/lib/contentLibraryOrder.ts → publishStatus.ts)을
 * 거쳐 발행 현황 모듈을 불러오므로 닫힘으로는 보지 않는다(발행 현황은 앱 밖 글 줄을 보이는 화면이다). 원장 라우트만 읽는지는 직접 불러오기로 본다.
 */
const DIRECT_ROOTS = ['src/pages/ContentLibrary.tsx', 'src/pages/QuestionBank.tsx']

const SPEC = /(?:^|\n)\s*(import|export)\s+(type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g
function resolveSpec(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = path.resolve(path.dirname(from), spec.replace(/\.js$/, ''))
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (existsSync(c) && statSync(c).isFile()) return c
  }
  return null
}
/** 런타임 불러오기만 따라간다(import type · export type은 런타임에 없다). */
function importsOf(file: string): string[] {
  const out: string[] = []
  for (const m of readFileSync(file, 'utf-8').matchAll(SPEC)) {
    if (m[2]) continue
    const r = resolveSpec(file, (m[3] ?? m[4])!)
    if (r) out.push(r)
  }
  return out
}
function closureOf(root: string): Set<string> {
  const seen = new Set<string>()
  const stack = [path.resolve(repo, root)]
  while (stack.length > 0) {
    const f = stack.pop()!
    if (seen.has(f)) continue
    seen.add(f)
    stack.push(...importsOf(f))
  }
  return seen
}
const newAbs = NEW_MODULES.map((m) => path.resolve(repo, m))
ok('정적 검사 — 새 모듈 두 개가 있다', newAbs.every((f) => existsSync(f)))
const missingRoots = [...CLOSED_ROOTS, ...DIRECT_ROOTS].filter((r) => !existsSync(path.resolve(repo, r)))
ok(`정적 검사 — 지키는 모듈이 모두 있다(이름이 바뀌면 여기를 고친다)${missingRoots.length ? `: 없음 ${missingRoots.join(', ')}` : ''}`, missingRoots.length === 0)
const leaks = CLOSED_ROOTS.filter((r) => existsSync(path.resolve(repo, r))).flatMap((r) => {
  const c = closureOf(r)
  return newAbs.filter((n) => c.has(n)).map((n) => `${r} → ${path.relative(repo, n)}`)
})
ok(`정적 검사 — 측정 · 집계 · 원장 · 이력 · 보고서 · 실행 계획은 앱 밖 글 모듈을 불러오지 않는다${leaks.length ? `: ${leaks.join(', ')}` : ''}`, leaks.length === 0)
const directLeaks = DIRECT_ROOTS.filter((r) => existsSync(path.resolve(repo, r))).filter((r) => importsOf(path.resolve(repo, r)).some((f) => newAbs.includes(f)))
ok(`정적 검사 — 콘텐츠 보관함 · 질문 은행 화면은 앱 밖 글 모듈을 직접 불러오지 않는다${directLeaks.length ? `: ${directLeaks.join(', ')}` : ''}`, directLeaks.length === 0)
ok('정적 검사 — 검사가 실제로 잡는다(서버 진입점의 닫힘에는 새 모듈이 있다)', newAbs.every((n) => closureOf('server/index.ts').has(n)))

// 3단계 — 앱 밖 글 이력을 읽는 화면 hook. 화면 전용이라 서버 닫힘에는 없고, 퍼포먼스 화면만 불러온다.
const hookAbs = path.resolve(repo, 'src/lib/useExternalHistory.ts')
ok('정적 검사 — 3단계 hook(src/lib/useExternalHistory.ts)이 있다', existsSync(hookAbs))
const hookLeaks = [
  ...CLOSED_ROOTS.filter((r) => existsSync(path.resolve(repo, r)) && closureOf(r).has(hookAbs)),
  ...DIRECT_ROOTS.filter((r) => existsSync(path.resolve(repo, r)) && importsOf(path.resolve(repo, r)).includes(hookAbs)),
]
ok(`정적 검사 — 측정 · 원장 · 보고서 · 실행 계획 · 앱 글 화면은 앱 밖 글 이력 hook을 불러오지 않는다${hookLeaks.length ? `: ${hookLeaks.join(', ')}` : ''}`, hookLeaks.length === 0)
ok('정적 검사 — (대조) 퍼포먼스 화면의 닫힘에는 hook이 있다', closureOf('src/pages/Performance.tsx').has(hookAbs))
{
  // 퍼포먼스 본문(집행 핀 · 「집행」 칸 · 올린 글 표)은 원장 이력만 쓴다 — 앱 밖 글 이력은 그 아래 절 컴포넌트만 읽는다(본문 함수 밖).
  const src = readFileSync(path.resolve(repo, 'src/pages/Performance.tsx'), 'utf-8')
  const start = src.indexOf('function ExternalHistorySection(')
  const end = src.indexOf('export default function Performance(')
  const calls = [...src.matchAll(/useExternalHistory\(/g)].map((m) => m.index)
  ok(
    '정적 검사 — 퍼포먼스 본문은 앱 밖 글 이력을 읽지 않는다(hook은 본문 앞에 둔 앱 밖 글 절 컴포넌트에서 한 번만 부른다)',
    start >= 0 && end > start && calls.length === 1 && calls.every((i) => i > start && i < end),
  )
}

// ── 공용 가짜 데이터 ─────────────────────────────────────────────────────────────
const answer = (questionId: string, startedAt: string, cites: string[] = [], extra: Partial<QuestionRepeatAnalysis> = {}) =>
  ({
    questionId,
    engine: 'gemini',
    callIndex: 0,
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
    timing: { startedAt, wallMs: 0, judgeMs: { mention: 0, citation: 0, rank: 0, fact: 0 } },
    ...extra,
  }) as unknown as QuestionRepeatAnalysis
const bankV1 = {
  version: 'v1',
  generatedAt: '2026-09-01T00:00:00Z',
  questions: [
    { questionId: 'c1-001', text: '가상 이름 없는 질문', category: 'category-agnostic', containsBrandName: false },
    { questionId: 'c1-002', text: '가상 이름 댄 질문', category: 'brand-direct', containsBrandName: true },
  ],
} as unknown as QuestionBank
const card = (tenantId: string, weekOf: string) =>
  ({ tenantId, weekOf, industry: '숙박', region: '가상시', enginesUsed: ['gemini'], questionBankVersion: 'v1', judgeModel: 'judge-a', repeatsPerQuestion: 1, aeoScore: { current: 30 } }) as unknown as WeeklyScorecard
const runMeta = (tenantId: string, weekOf: string, runId: string, startedAt: string, finishedAt: string): RunMeta => ({
  runId,
  tenantId,
  weekOf,
  startedAt,
  finishedAt,
  selfOnly: true,
  inCohortRun: false,
  weekCard: 'saved',
  engines: { gemini: { planned: 2, succeeded: 2 } },
  engineIssues: [],
  contextFingerprint: 'ctx-a',
  collectUsage: {},
})
const fails = async (p: Promise<unknown>): Promise<number | null> => {
  try {
    await p
    return null
  } catch (err) {
    return (err as { status?: number }).status ?? -1
  }
}
const errorOf = async (p: Promise<unknown>): Promise<{ status: number; message: string } | null> => {
  try {
    await p
    return null
  } catch (err) {
    return { status: (err as { status?: number }).status ?? -1, message: err instanceof Error ? err.message : String(err) }
  }
}
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> =>
  Promise.race([p, new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms))])

// ── 2) 저장 규칙 · 3) 인용 이력 — 모듈을 임시 폴더로 직접 부른다 ───────────────────────────────────────
const root = mkdtempSync(path.join(tmpdir(), 'verify-external-posts-'))
// 모듈이 불러올 때 데이터 폴더를 정하므로, 환경 변수를 먼저 두고 동적으로 불러온다.
process.env.APP_DATA_DIR = root
const dataFile = (tenantId: string, name: string) => path.join(root, 'data', tenantId, name)
const writeData = (tenantId: string, name: string, text: string) => {
  mkdirSync(path.join(root, 'data', tenantId), { recursive: true })
  writeFileSync(dataFile(tenantId, name), text)
}
const readData = (tenantId: string, name: string) => readFileSync(dataFile(tenantId, name), 'utf-8')
const xRow = (id: string, url: string, key: string, over: Record<string, unknown> = {}) => ({
  id,
  url,
  key,
  title: '가상 손글',
  publishedOn: '2026-10-01',
  publishedOnSource: 'page',
  trackedAt: '2026-10-05T01:00:00.000Z',
  ...over,
})
const xFile = (posts: unknown[], keyRule = 3) => JSON.stringify({ version: 1, keyRule, posts }, null, 2)
/** 3) 인용 이력 검사가 만든 실제 응답(선을 넘는 모양 그대로) — 5) 퍼포먼스 절 검사가 화면에 넘긴다. */
let uiFixture: { history: ClientExternalHistory; ids: Record<string, string> } | null = null

try {
  const ext = await import('../server/externalPosts')
  const lib = await import('../src/lib/externalPosts')
  const { addPublishedPost, patchPublishedPost, readPublishedPosts } = await import('../server/publishedPosts')
  const { writeActionState } = await import('../server/actionStates')
  const { getPublishedHistory } = await import('../server/publishedHistory')
  const { KEY_RULE, kstDate, todayKst } = await import('../src/lib/publishedUrl')

  const T = 'vx-store'
  const today = todayKst()
  const add = (tenantId: string, body: Record<string, unknown>) => ext.addExternalPost(tenantId, body)
  const page = (url: string, over: Record<string, unknown> = {}) => ({ url, title: '가상 손글 하나', publishedOn: '2026-10-15', publishedOnSource: 'page', ...over })

  // (가) 적기 — 모양 · 키 · 같은 주소는 있던 줄
  const a1 = await add(T, page('https://fake.tistory.com/70?category=3'))
  ok('적기 — x- id · 주소 키 · 페이지 날짜 · 추적 시작 시각 · 살아 있음', /^x-[0-9a-f]{12}$/.test(a1.post.id) && a1.post.key === 'fake.tistory.com/70' && a1.post.publishedOn === '2026-10-15' && a1.post.publishedOnSource === 'page' && kstDate(a1.post.trackedAt) === today && a1.post.state === 'live' && !a1.existing)
  const a1b = await add(T, page('https://m.fake.tistory.com/m/70', { publishedOn: '2026-10-01' }))
  ok('같은 주소를 다시 적으면 있던 줄을 돌려주고 고치지 않는다', a1b.existing && a1b.post.id === a1.post.id && a1b.post.publishedOn === '2026-10-15' && a1b.posts.length === 1)
  ok('올린 날 칸이 빠지면 400', (await fails(add(T, { url: 'https://fake.tistory.com/71', title: 't' }))) === 400)
  const unknownDay = await add(T, { url: 'https://fake.tistory.com/71', title: null, publishedOn: null })
  ok('올린 날 null은 「모름」으로 받는다(오늘로 채우지 않는다) · 제목 없으면 null', unknownDay.post.publishedOn === null && unknownDay.post.publishedOnSource === 'unknown' && unknownDay.post.title === null)
  ok('날짜를 주면 출처(page · user)도 있어야 한다(400)', (await fails(add(T, { url: 'https://fake.tistory.com/72', publishedOn: '2026-10-01' }))) === 400)
  ok('오늘 뒤 날짜는 400', (await fails(add(T, page('https://fake.tistory.com/72', { publishedOn: '2999-01-01' })))) === 400)
  ok('없는 날짜는 400', (await fails(add(T, page('https://fake.tistory.com/72', { publishedOn: '2026-02-30' })))) === 400)
  ok('2020년 전 날짜는 400', (await fails(add(T, page('https://fake.tistory.com/72', { publishedOn: '2019-12-31' })))) === 400)
  ok('첫 화면 · 단축 주소 · 관리 화면은 400', (await fails(add(T, page('https://fake.tistory.com/')))) === 400 && (await fails(add(T, page('https://naver.me/abc')))) === 400 && (await fails(add(T, page('https://fake.tistory.com/manage/newpost')))) === 400)
  const longTitle = await add(T, page('https://fake.tistory.com/73', { title: `  ${'가'.repeat(300)}  ` }))
  const blankTitle = await add(T, page('https://fake.tistory.com/74', { title: '   ' }))
  ok('제목은 200자까지 · 빈 제목은 null(화면은 「제목 미확인」)', longTitle.post.title?.length === 200 && blankTitle.post.title === null && lib.externalTitle(blankTitle.post) === '제목 미확인')
  ok('제목이 글자가 아니면 400', (await fails(add(T, page('https://fake.tistory.com/75', { title: 42 })))) === 400)

  // (나) 원장이 이긴다(C5) — 같은 브랜드 원장의 살아 있는 줄 · 내린 줄 · 옛 기록은 거절, 잘못 적은 줄은 받는다
  const own = { articleId: 'content:a', targetActionId: 'content:a', via: 'own' }
  const live = await addPublishedPost(T, { ...own, url: 'https://fake.tistory.com/80', publishedOn: '2026-10-02', publishedOnChosen: true })
  const down = await addPublishedPost(T, { ...own, url: 'https://fake.tistory.com/81', publishedOn: '2026-10-02', publishedOnChosen: true })
  await patchPublishedPost(T, down.post.id, { remove: 'taken-down' })
  const wrong = await addPublishedPost(T, { ...own, url: 'https://fake.tistory.com/82', publishedOn: '2026-10-02', publishedOnChosen: true })
  await patchPublishedPost(T, wrong.post.id, { remove: 'mistake' })
  await writeActionState(T, 'listing:old.example', { status: 'done', publishedUrls: ['https://old.example/a/1'] })
  const liveErr = await errorOf(add(T, page(live.post.url)))
  const downErr = await errorOf(add(T, page(down.post.url)))
  ok('원장의 살아 있는 앱 글 주소는 409', liveErr?.status === 409 && liveErr.message.includes('앱 글'))
  ok('원장에 「글을 내렸어요」로 뺀 앱 글 주소도 409 — 「앱 글로 적었다가 내린 기록」으로 알린다', downErr?.status === 409 && downErr.message.includes('내린 기록'))
  ok('원장에 「잘못 적음」으로 뺀 주소는 받는다', (await fails(add(T, page(wrong.post.url)))) === null)
  ok('집행 상태에만 있던 옛 주소(옛 기록)도 409', (await fails(add(T, page('https://old.example/a/1')))) === 409)
  const winners = lib.ledgerWinners(await readPublishedPosts(T), 'fake.tistory.com/81')
  ok('등록 거절과 쉼이 같은 기준(ledgerWinners) — 내린 줄은 이기고 잘못 적은 줄은 지지 않는다', winners.length === 1 && lib.ledgerWinners(await readPublishedPosts(T), 'fake.tistory.com/82').length === 0)

  // (다) 앱 글로 옮김(D7 · D12) — 원장에 앱 글이 생기면 쉬고, 그 기록을 「잘못 적음」으로 빼면 다시 산다
  const moving = await add(T, page('https://fake.tistory.com/90', { publishedOn: '2026-10-03' }))
  const appRow = await addPublishedPost(T, { ...own, articleId: 'content:b', targetActionId: 'content:b', url: 'https://fake.tistory.com/90', publishedOn: today, publishedOnChosen: true })
  const afterMove = (await ext.listExternalPosts(T)).find((p) => p.id === moving.post.id)
  ok('같은 브랜드에 앱 글로 적히면 앱 밖 줄은 「앱 글로 옮김」 — 옮긴 날은 그 원장 줄의 기록 시각(한국 날짜)', afterMove?.state === 'moved' && afterMove.movedOn === kstDate(appRow.post.recordedAt) && afterMove.appCountsFrom === today)
  ok('쉬는 줄도 파일에 남는다(지우지 않는다)', JSON.parse(readData(T, 'external-posts.json')).posts.some((p: { id: string }) => p.id === moving.post.id))
  await patchPublishedPost(T, appRow.post.id, { remove: 'mistake' })
  ok('그 앱 글 기록을 「잘못 적음」으로 빼면 앱 밖 줄이 다시 산다', (await ext.listExternalPosts(T)).find((p) => p.id === moving.post.id)?.state === 'live')

  // (라) 빼기 · 되살리기 · 다시 올림(C9) — 살아 있는 줄은 주소마다 하나, 다시 올리면 새 줄, 되살리기는 「잘못 적음」만
  const repost = await add(T, page('https://fake.tistory.com/95', { publishedOn: '2026-10-01' }))
  const taken = await ext.updateExternalPost(T, repost.post.id, { remove: 'taken-down' })
  ok('빼기는 표시만 한다(뺀 시각 · 까닭)', taken.post.state === 'removed' && taken.post.removedReason === 'taken-down' && Boolean(taken.post.removedAt))
  const again = await add(T, page('https://fake.tistory.com/95', { publishedOn: '2026-10-20' }))
  ok('내린 주소를 다시 적으면 새 x- 줄(내린 기간이 남는다)', !again.existing && again.post.id !== repost.post.id && again.posts.filter((p) => p.key === 'fake.tistory.com/95').length === 2)
  ok('「글을 내림」으로 뺀 줄은 되살리지 않는다(400 — 다시 올렸으면 새로 적는다)', (await fails(ext.updateExternalPost(T, repost.post.id, { restore: true }))) === 400)
  await ext.updateExternalPost(T, again.post.id, { remove: 'mistake' })
  const third = await add(T, page('https://fake.tistory.com/95', { publishedOn: '2026-10-21' }))
  ok('같은 주소에 살아 있는 줄이 있으면 「잘못 적음」 줄도 되살리지 않는다(409)', (await fails(ext.updateExternalPost(T, again.post.id, { restore: true }))) === 409)
  await ext.updateExternalPost(T, third.post.id, { remove: 'mistake' })
  const restored = await ext.updateExternalPost(T, again.post.id, { restore: true })
  ok('「잘못 적음」으로 뺀 줄은 되살린다', restored.post.state === 'live' && !restored.post.removedAt && !restored.post.removedReason)
  ok('이미 뺀 줄을 같은 까닭으로 다시 빼면 그대로 · 다른 까닭이면 409', (await fails(ext.updateExternalPost(T, repost.post.id, { remove: 'taken-down' }))) === null && (await fails(ext.updateExternalPost(T, repost.post.id, { remove: 'mistake' }))) === 409)
  ok('원장이 이긴 주소의 「잘못 적음」 줄도 되살리지 않는다(409 — 등록 거절과 같은 기준)', await (async () => {
    const x = await add(T, page('https://fake.tistory.com/96'))
    await ext.updateExternalPost(T, x.post.id, { remove: 'mistake' })
    await addPublishedPost(T, { ...own, articleId: 'content:c', targetActionId: 'content:c', url: 'https://fake.tistory.com/96' })
    return (await fails(ext.updateExternalPost(T, x.post.id, { restore: true }))) === 409
  })())

  // (마) 올린 날 고치기
  const redated = await ext.updateExternalPost(T, unknownDay.post.id, { publishedOn: '2026-10-09' })
  ok('올린 날을 고치면 사람이 고른 날(user) · 추적 시작 시각은 그대로', redated.post.publishedOn === '2026-10-09' && redated.post.publishedOnSource === 'user' && redated.post.trackedAt === unknownDay.post.trackedAt)
  const unset = await ext.updateExternalPost(T, unknownDay.post.id, { publishedOn: null })
  ok('올린 날을 「모름」으로 되돌릴 수 있다', unset.post.publishedOn === null && unset.post.publishedOnSource === 'unknown')
  ok('바꿀 것이 없으면 400 · 없는 줄은 404 · id 모양이 틀리면 400', (await fails(ext.updateExternalPost(T, unknownDay.post.id, {}))) === 400 && (await fails(ext.updateExternalPost(T, 'x-000000000000', { publishedOn: null }))) === 404 && (await fails(ext.updateExternalPost(T, '../x', { publishedOn: null }))) === 400)
  writeData('vx-tracked', 'external-posts.json', xFile([xRow('x-aaaaaaaaaa01', 'https://fake.tistory.com/1', 'fake.tistory.com/1')]))
  ok('올린 날은 추적을 시작한 날보다 뒤일 수 없다(400)', (await fails(ext.updateExternalPost('vx-tracked', 'x-aaaaaaaaaa01', { publishedOn: '2026-10-07' }))) === 400)

  // (바) 깨진 파일 · 상한 · 키 규칙(C11)
  const BROKEN = '{"version":1,"posts": ['
  writeData('vx-broken', 'external-posts.json', BROKEN)
  ok('깨진 파일은 읽지 않는다(500)', (await fails(ext.listExternalPosts('vx-broken'))) === 500)
  ok('깨진 파일에는 쓰지 않는다(500 · 한 글자도 그대로)', (await fails(add('vx-broken', page('https://fake.tistory.com/1')))) === 500 && readData('vx-broken', 'external-posts.json') === BROKEN)
  const BAD_ROW = xFile([xRow('p-notexternal', 'https://fake.tistory.com/1', 'fake.tistory.com/1')])
  writeData('vx-badrow', 'external-posts.json', BAD_ROW)
  ok('줄 모양이 틀린 파일도 읽지도 쓰지도 않는다', (await fails(add('vx-badrow', page('https://fake.tistory.com/2')))) === 500 && readData('vx-badrow', 'external-posts.json') === BAD_ROW)
  writeData('vx-ledger-broken', 'published-posts.json', '{"posts": [ {')
  ok('원장이 깨졌으면 원장이 이기는지 알 수 없어 적지 않는다(500 · 파일을 만들지 않는다)', (await fails(add('vx-ledger-broken', page('https://fake.tistory.com/3')))) === 500 && !existsSync(dataFile('vx-ledger-broken', 'external-posts.json')))
  const many = Array.from({ length: lib.MAX_EXTERNAL_POSTS }, (_, i) => xRow(`x-${String(i).padStart(12, '0')}`, `https://fake.tistory.com/c/${i}`, `fake.tistory.com/c/${i}`))
  writeData('vx-cap', 'external-posts.json', xFile(many))
  ok(`살아 있는 줄이 ${lib.MAX_EXTERNAL_POSTS}개면 더 적지 않는다(400)`, (await fails(add('vx-cap', page('https://fake.tistory.com/new')))) === 400)
  writeData('vx-cap-removed', 'external-posts.json', xFile(many.map((p) => ({ ...p, removedAt: '2026-10-06T00:00:00.000Z', removedReason: 'mistake' }))))
  ok('상한은 살아 있는 줄로 센다(뺀 줄만 가득하면 적힌다)', (await fails(add('vx-cap-removed', page('https://fake.tistory.com/new')))) === null)
  writeData('vx-rule', 'external-posts.json', xFile([xRow('x-bbbbbbbbbb01', 'https://www.example.com/x/1/?fbclid=1', 'stale')], 0))
  ok('키 규칙이 다른 파일은 읽을 때 주소로 키를 다시 계산한다', (await ext.listExternalPosts('vx-rule'))[0]?.key === 'example.com/x/1')
  await add('vx-rule', page('https://example.com/x/2'))
  const ruleFile = JSON.parse(readData('vx-rule', 'external-posts.json')) as { keyRule: number; posts: { key: string }[] }
  ok('다시 쓸 때는 지금 키 규칙으로 쓴다', ruleFile.keyRule === KEY_RULE && ruleFile.posts[0]?.key === 'example.com/x/1')
  writeData('vx-extra', 'external-posts.json', xFile([xRow('x-dddddddddd01', 'https://fake.tistory.com/1', 'fake.tistory.com/1', { laterField: '뒤 판 칸' })]))
  await add('vx-extra', page('https://fake.tistory.com/2'))
  ok('모르는 칸(뒤 판이 더한 칸)은 다시 써도 지우지 않는다', (JSON.parse(readData('vx-extra', 'external-posts.json')) as { posts: { laterField?: string }[] }).posts[0]?.laterField === '뒤 판 칸')

  // (사) 다른 브랜드의 앱 글(D13) — 한 함수로 가린다: 고른 브랜드의 원장만 막고, 다른 브랜드는 알리기만
  const ledgers = [
    { tenantId: 'vx-a', posts: [{ key: 'k/1', recordedAt: '2026-10-01T00:00:00.000Z' }] },
    { tenantId: 'vx-b', posts: [{ key: 'k/1', recordedAt: '2026-10-01T00:00:00.000Z', removedAt: '2026-10-02T00:00:00.000Z', removedReason: 'mistake' }] },
    { tenantId: 'vx-c', posts: [{ key: 'k/1', recordedAt: '2026-10-01T00:00:00.000Z', removedAt: '2026-10-02T00:00:00.000Z', removedReason: 'taken-down' }] },
  ]
  const forB = lib.externalRegistrationCheck('vx-b', 'k/1', ledgers)
  const forA = lib.externalRegistrationCheck('vx-a', 'k/1', ledgers)
  ok('다른 브랜드에 앱 글로 적힌 주소 — 고른 브랜드 원장만 막고, 다른 브랜드는 「같은 주소」로 알린다', !forB.blocked && forB.appIn.join() === 'vx-a,vx-c' && forA.blocked && forA.appIn.join() === 'vx-c')
  await addPublishedPost('vx-other', { ...own, url: 'https://fake.tistory.com/500' })
  const cross = await ext.addExternalPost('vx-mine', page('https://fake.tistory.com/500'), await ext.readOtherLedgers(['vx-other']))
  ok('서버도 같은 함수 — 다른 브랜드의 앱 글 주소는 적고 「같은 주소」 브랜드를 돌려준다', cross.post.state === 'live' && cross.alsoAppIn.join() === 'vx-other')

  // (아) 같은 브랜드에 앱 밖 글과 앱 글이 동시에 들어와도 멈추지 않는다(C18 · C21-12)
  const C = 'vx-burst'
  const burst = await withTimeout(
    Promise.allSettled([
      ...Array.from({ length: 15 }, (_, i) => ext.addExternalPost(C, page(`https://fake.tistory.com/x/${i}`))),
      ...Array.from({ length: 10 }, (_, i) => addPublishedPost(C, { ...own, articleId: `content:${i}`, targetActionId: `content:${i}`, url: `https://fake.tistory.com/p/${i}` })),
      ...Array.from({ length: 5 }, () => ext.listExternalPosts(C)),
      ...Array.from({ length: 5 }, () => readPublishedPosts(C)),
      ext.addExternalPost(C, page('https://fake.tistory.com/both')),
      addPublishedPost(C, { ...own, articleId: 'content:both', targetActionId: 'content:both', url: 'https://fake.tistory.com/both' }),
    ]),
    20_000,
  )
  ok('같은 브랜드 동시 쓰기 · 읽기가 멈추지 않는다(20초 안에 모두 끝난다)', burst !== 'timeout')
  const burstExt = await ext.listExternalPosts(C)
  const burstLedger = await readPublishedPosts(C)
  ok(
    '동시 쓰기에서 앱 밖 줄 · 원장 줄이 사라지지 않는다',
    burst !== 'timeout' &&
      Array.from({ length: 15 }, (_, i) => `fake.tistory.com/x/${i}`).every((k) => burstExt.some((p) => p.key === k)) &&
      Array.from({ length: 10 }, (_, i) => `fake.tistory.com/p/${i}`).every((k) => burstLedger.some((p) => p.key === k)),
  )
  const both = burstExt.find((p) => p.key === 'fake.tistory.com/both')
  ok('같은 주소가 동시에 들어오면 앱 글이 이기고 앱 밖 줄은 없거나 쉰다', burstLedger.some((p) => p.key === 'fake.tistory.com/both') && (!both || both.state === 'moved'))

  // (자) 앱 밖 글 쓰기는 그 브랜드 폴더에 external-posts.json 하나만 만든다
  const onlyDir = 'vx-only'
  await add(onlyDir, page('https://fake.tistory.com/600'))
  ok('앱 밖 글을 적어도 원장 · 집행 상태 파일이 생기지 않는다', readdirSync(path.join(root, 'data', onlyDir)).join() === 'external-posts.json')

  // ── 3) 인용 이력 — 가짜 측정(가짜 저장소) ─────────────────────────────────────────────
  const H = 'vx-hist'
  const U = {
    sameDay: 'https://fake.tistory.com/h/1',
    noDate: 'https://fake.tistory.com/h/2',
    repost: 'https://fake.tistory.com/h/3',
    moved: 'https://fake.tistory.com/h/4',
    movedMid: 'https://fake.tistory.com/h/5',
    early: 'https://fake.tistory.com/h/6',
  }
  const allUrls = Object.values(U)
  // W41 10-08 · W42 10-14(오전 10시 한국, 01:00Z에 끝) · W43 판정 없음 · W44 10-28 · W45 두 회차 11-03 · 11-05
  const histCards = ['2026-W41', '2026-W42', '2026-W43', '2026-W44', '2026-W45'].map((w) => card(H, w))
  const r1 = [answer('c1-001', '2026-11-03T01:00:00Z', allUrls)]
  const r2 = [answer('c1-001', '2026-11-05T01:00:00Z', allUrls)]
  const byWeek: Record<string, QuestionRepeatAnalysis[]> = {
    '2026-W41': [answer('c1-001', '2026-10-08T01:00:00Z', allUrls)],
    '2026-W42': [answer('c1-001', '2026-10-14T01:00:00Z', allUrls), answer('c1-002', '2026-10-14T01:00:00Z', [U.sameDay], { callIndex: 1 })],
    '2026-W43': [],
    '2026-W44': [answer('c1-001', '2026-10-28T01:00:00Z', allUrls)],
    '2026-W45': r2,
  }
  const histStore = {
    getScorecardHistory: async (_t: string, n: number) => histCards.slice(-n),
    getQuestionAnalyses: async (_t: string, week: string) => byWeek[week] ?? [],
    getQuestionBank: async (_t: string, v: string) => (v === 'v1' ? bankV1 : null),
    listRunSnapshots: async (_t: string, week: string) =>
      week === '2026-W45'
        ? {
            runs: [
              { meta: runMeta(H, week, 'r1', '2026-11-03T00:30:00Z', '2026-11-03T02:00:00Z'), scorecard: card(H, week), analyses: r1 },
              { meta: runMeta(H, week, 'r2', '2026-11-05T00:30:00Z', '2026-11-05T02:00:00Z'), scorecard: card(H, week), analyses: r2 },
            ],
            issues: [],
          }
        : { runs: [], issues: [] },
  }
  const tenantH = { tenantId: H, questionBankVersion: 'v1' }
  const ids = { sameDay: 'x-111111111101', noDate: 'x-111111111102', repostOld: 'x-111111111103', repostNew: 'x-111111111104', moved: 'x-111111111105', movedMid: 'x-111111111106', early: 'x-111111111107', mistake: 'x-111111111108' }
  writeData(
    H,
    'external-posts.json',
    xFile([
      // 올린 날 당일(10-14 오후 2시 한국)에 등록 — 그날 오전에 끝난 측정
      xRow(ids.sameDay, U.sameDay, 'fake.tistory.com/h/1', { publishedOn: '2026-10-14', trackedAt: '2026-10-14T05:00:00.000Z' }),
      xRow(ids.noDate, U.noDate, 'fake.tistory.com/h/2', { publishedOn: null, publishedOnSource: 'unknown' }),
      xRow(ids.repostOld, U.repost, 'fake.tistory.com/h/3', { publishedOn: '2026-10-01', removedAt: '2026-10-10T00:00:00.000Z', removedReason: 'taken-down' }),
      xRow(ids.repostNew, U.repost, 'fake.tistory.com/h/3', { publishedOn: '2026-10-20', trackedAt: '2026-10-20T03:00:00.000Z' }),
      xRow(ids.moved, U.moved, 'fake.tistory.com/h/4', { publishedOn: '2026-10-01' }),
      xRow(ids.movedMid, U.movedMid, 'fake.tistory.com/h/5', { publishedOn: '2026-10-01' }),
      xRow(ids.early, U.early, 'fake.tistory.com/h/6', { publishedOn: '2026-10-01' }),
      xRow(ids.mistake, 'https://fake.tistory.com/h/9', 'fake.tistory.com/h/9', { removedAt: '2026-10-06T00:00:00.000Z', removedReason: 'mistake' }),
    ]),
  )
  const ledgerRow = (id: string, url: string, key: string, publishedOn: string, recordedAt: string) => ({
    id, url, key, publishedOn, publishedOnSource: 'user', recordedAt, articleId: `content:${id}`, targetActionId: `content:${id}`, via: 'own',
  })
  const HLEDGER = [
    // 10-27에 앱 글로 옮김(올린 날 = 옮긴 날)
    ledgerRow('p-hhhhhhhhhh01', U.moved, 'fake.tistory.com/h/4', '2026-10-27', '2026-10-27T03:00:00.000Z'),
    // W45 두 회차 사이(11-04)에 옮김
    ledgerRow('p-hhhhhhhhhh02', U.movedMid, 'fake.tistory.com/h/5', '2026-11-04', '2026-11-04T03:00:00.000Z'),
    // 11-04에 적었는데 올린 날을 10-12로 골랐다 — 앱 글 표가 10-12부터 센다
    ledgerRow('p-hhhhhhhhhh03', U.early, 'fake.tistory.com/h/6', '2026-10-12', '2026-11-04T03:00:00.000Z'),
  ]
  writeData(H, 'published-posts.json', JSON.stringify({ version: 1, keyRule: 3, posts: HLEDGER }, null, 2))
  const hist = await ext.getExternalHistory(histStore, tenantH, 12)
  uiFixture = { history: JSON.parse(JSON.stringify(hist)) as ClientExternalHistory, ids }
  const rowOf = (id: string) => hist.posts.find((p) => p.post.id === id)
  const weekIndex = (w: string) => hist.weeks.findIndex((x) => x.weekOf === w)
  const cellOf = (id: string, w: string) => rowOf(id)?.cells[weekIndex(w)] ?? null
  ok('이력 — 주차 5개 · 「잘못 적음」 줄은 이력에서 뺀다', hist.weeks.length === 5 && hist.posts.length === 7 && !rowOf(ids.mistake))
  ok('이력 — 판정 기록이 없는 주는 칸이 null(0이 아니다)', hist.weeks[weekIndex('2026-W43')]?.analysed === false && hist.posts.every((p) => p.cells[weekIndex('2026-W43')] === null))
  // C7 — 추적 시작 시각을 올린 시각으로 쓰지 않는다
  ok('당일 등록한 손글 — 등록 전에 끝난 그날 측정은 「올리기 전」이 아니라 전후 불명(during)', cellOf(ids.sameDay, '2026-W42')?.timing === 'during' && (cellOf(ids.sameDay, '2026-W42')?.tally?.all.cited ?? 0) === 2)
  const control = await getPublishedHistory(histStore, tenantH, [{ ...ledgerRow('p-control0001', U.sameDay, 'fake.tistory.com/h/1', '2026-10-14', '2026-10-14T05:00:00.000Z'), publishedOnSource: 'user' as const, via: 'own' as const }], 12)
  ok('(대조) 앱 글이 같은 시각에 적혔으면 누른 시각으로 「올리기 전」이 된다 — 위 검사가 그 길을 막는다', control.posts[0]?.cells[control.weeks.findIndex((x) => x.weekOf === '2026-W42')]?.timing === 'before')
  ok('변환기는 올린 시각을 싣지 않는다(postedAtOf가 늘 null)', hist.posts.every((p) => p.post.publishedOnSource === 'legacy'))
  ok('올린 날을 모르면 전후를 판단하지 않는다(모든 칸 unknown)', rowOf(ids.noDate)!.cells.every((c) => c === null || c.timing === 'unknown'))
  ok('겨냥 질문은 해당 없음(topicMention 없음)', hist.posts.every((p) => p.cells.every((c) => c === null || c.topicMention === undefined)))
  ok('이력 행은 앱 밖 줄 정보(state · 제목)를 함께 싣는다', rowOf(ids.repostNew)?.external.state === 'live' && rowOf(ids.repostNew)?.post.articleTitle === '가상 손글' && rowOf(ids.noDate)?.external.publishedOn === null)
  // C9 — 내림 → 다시 올림
  ok('내린 줄 — 올라가 있던 W41은 세고, 내린 뒤 W42 · W44는 「내린 뒤」', cellOf(ids.repostOld, '2026-W41')?.timing === 'after' && !cellOf(ids.repostOld, '2026-W41')?.afterRemoval && cellOf(ids.repostOld, '2026-W42')?.afterRemoval === true && cellOf(ids.repostOld, '2026-W44')?.afterRemoval === true)
  ok('다시 올린 줄 — 다시 올리기 전 W41 · W42는 「올리기 전」, W44부터 센다(내린 동안은 어느 줄도 세지 않는다)', cellOf(ids.repostNew, '2026-W41')?.timing === 'before' && cellOf(ids.repostNew, '2026-W42')?.timing === 'before' && cellOf(ids.repostNew, '2026-W44')?.timing === 'after')
  // D12 — 앱 글로 옮긴 날 뒤에는 두 표가 겹치지 않는다
  const app = await getPublishedHistory(histStore, tenantH, HLEDGER as Parameters<typeof getPublishedHistory>[2], 12)
  const appCell = (id: string, w: string) => app.posts.find((p) => p.post.id === id)?.cells[app.weeks.findIndex((x) => x.weekOf === w)] ?? null
  ok('옮긴 줄 — 상태 moved · 옮긴 날 10-27', rowOf(ids.moved)?.external.state === 'moved' && rowOf(ids.moved)?.external.movedOn === '2026-10-27')
  ok('옮긴 줄 — 옮기기 전 W41 · W42는 앱 밖 표가 세고, 옮긴 뒤 W44 · W45는 비운다(내린 뒤처럼)', cellOf(ids.moved, '2026-W41')?.timing === 'after' && !cellOf(ids.moved, '2026-W42')?.afterRemoval && cellOf(ids.moved, '2026-W44')?.afterRemoval === true && cellOf(ids.moved, '2026-W45')?.afterRemoval === true)
  const counted = (c: { afterRemoval: boolean; timing: string } | null) => Boolean(c && !c.afterRemoval && (c.timing === 'after' || c.timing === 'during' || c.timing === 'ambiguous'))
  const singleWeeks = ['2026-W41', '2026-W42', '2026-W44']
  const pairs: [string, string][] = [
    [ids.moved, 'p-hhhhhhhhhh01'],
    [ids.movedMid, 'p-hhhhhhhhhh02'],
    [ids.early, 'p-hhhhhhhhhh03'],
  ]
  ok('회차가 하나인 주 — 같은 측정을 두 표가 함께 세지 않는다(옮긴 날 · 앞선 올린 날 모두)', pairs.every(([x, p]) => singleWeeks.every((w) => !(counted(cellOf(x, w)) && counted(appCell(p, w))))))
  const runsSeen = (c: { runs?: { measured: number; unsure: number } } | null) => (c?.runs ? c.runs.measured + c.runs.unsure : 0)
  ok(
    '회차가 둘인 주(W45, 옮긴 날이 두 회차 사이) — 앞 회차는 앱 밖 표, 뒤 회차는 앱 글 표가 센다(합이 회차 수를 넘지 않는다)',
    runsSeen(cellOf(ids.movedMid, '2026-W45')) === 1 && runsSeen(appCell('p-hhhhhhhhhh02', '2026-W45')) === 1 && cellOf(ids.movedMid, '2026-W45')?.runs?.cited === 1 && appCell('p-hhhhhhhhhh02', '2026-W45')?.runs?.cited === 1,
  )
  ok('앱 글 올린 날이 옮긴 날보다 앞이면 그 날부터 앱 밖 표를 비운다(옮긴 날은 기록 시각 그대로)', rowOf(ids.early)?.external.movedOn === '2026-11-04' && rowOf(ids.early)?.external.appCountsFrom === '2026-10-12' && cellOf(ids.early, '2026-W42')?.afterRemoval === true && cellOf(ids.early, '2026-W41')?.timing === 'after')
  ok('이력 계산은 원장 · 앱 밖 파일을 바꾸지 않는다', readData(H, 'published-posts.json') === JSON.stringify({ version: 1, keyRule: 3, posts: HLEDGER }, null, 2))
} catch (err) {
  ok(`모듈 검사가 예외 없이 끝난다: ${err instanceof Error ? err.stack : String(err)}`, false)
} finally {
  rmSync(root, { recursive: true, force: true })
}

// ── 4) 서버 길 — 격리(바이트 단위) ─────────────────────────────────────────────────
const PORT = 4183
const BASE = `http://127.0.0.1:${PORT}`
const portFree = () =>
  new Promise<boolean>((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(PORT, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
const dir = mkdtempSync(path.join(tmpdir(), 'verify-external-posts-server-'))
const tenantConfig = (tenantId: string, brandName: string, over: Record<string, unknown> = {}) => ({
  tenantId,
  brandName,
  aliases: [brandName],
  ownedDomains: [`${tenantId}.example`],
  industry: '숙박',
  region: '가상시',
  engines: ['gemini'],
  questionBankSize: 2,
  questionBankVersion: 'v1',
  repeatsPerQuestion: 1,
  factGraph: [],
  competitors: [],
  ...over,
})
writeFileSync(
  path.join(dir, 'tenants.overlay.json'),
  JSON.stringify([
    tenantConfig('vext-a', '가상스테이'),
    tenantConfig('vext-b', '가상스테이전국'),
    tenantConfig('vext-comp', '가상경쟁사', { cohortOnly: true }),
    tenantConfig('vext-gone', '지운브랜드'),
  ]),
)
writeFileSync(path.join(dir, 'tenants.deleted.json'), JSON.stringify(['vext-gone']))
const sdir = (tenantId: string) => {
  const d = path.join(dir, 'data', tenantId)
  mkdirSync(d, { recursive: true })
  return d
}
const sjson = (rel: string, value: unknown) => {
  const file = path.join(dir, 'data', rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2))
}
const L = {
  live: 'https://vext-a.example/blog/1',
  down: 'https://fake.tistory.com/50',
  wrong: 'https://fake.tistory.com/60',
  legacy: 'https://old.example/a/1',
  hand: 'https://fake.tistory.com/70',
  handB: 'https://blog.naver.com/fakeblog/224400000001',
}
const lrow = (id: string, url: string, key: string, over: Record<string, unknown> = {}) => ({
  id, url, key, publishedOn: '2026-10-20', publishedOnSource: 'user', recordedAt: '2026-10-20T01:00:00.000Z', articleId: 'content:a', targetActionId: 'content:a', via: 'own', articleTitle: '가상 앱 글', ...over,
})
const LEDGER_A = JSON.stringify(
  {
    version: 1,
    keyRule: 3,
    posts: [
      lrow('p-aaaaaaaaaa01', L.live, 'vext-a.example/blog/1'),
      lrow('p-aaaaaaaaaa02', L.down, 'fake.tistory.com/50', { publishedOn: '2026-10-10', recordedAt: '2026-10-10T01:00:00.000Z', removedAt: '2026-10-28T01:00:00.000Z', removedReason: 'taken-down' }),
      lrow('p-aaaaaaaaaa03', L.wrong, 'fake.tistory.com/60', { removedAt: '2026-10-21T01:00:00.000Z', removedReason: 'mistake' }),
    ],
  },
  null,
  2,
)
const STATES_A = JSON.stringify({ 'listing:old.example': { status: 'done', updatedAt: '2026-09-01T00:00:00.000Z', publishedUrls: [L.legacy] } }, null, 2)
writeFileSync(path.join(sdir('vext-a'), 'published-posts.json'), LEDGER_A)
writeFileSync(path.join(sdir('vext-a'), 'action-states.json'), STATES_A)
const LEDGER_B = JSON.stringify({ version: 1, keyRule: 3, posts: [lrow('p-bbbbbbbbbb01', L.handB, 'blog.naver.com/fakeblog/224400000001', { via: 'channel', targetActionId: 'listing:platform:naver.com' })] }, null, 2)
writeFileSync(path.join(sdir('vext-b'), 'published-posts.json'), LEDGER_B)
const cites = Object.values(L)
for (const t of ['vext-a', 'vext-b']) {
  sjson(`${t}/question-bank/v1.json`, bankV1)
  sjson(`${t}/scorecard-history.json`, ['2026-W43', '2026-W44', '2026-W45'].map((w) => card(t, w)))
  sjson(`${t}/2026-W43/question-analyses.json`, [answer('c1-001', '2026-10-22T01:00:00Z', cites), answer('c1-002', '2026-10-22T01:00:00Z', [L.live], { callIndex: 1, mentioned: true })])
  sjson(`${t}/2026-W43/scorecard.json`, card(t, '2026-W43'))
  sjson(`${t}/2026-W44/question-analyses.json`, [answer('c1-001', '2026-10-29T01:00:00Z', cites)])
  sjson(`${t}/2026-W44/scorecard.json`, card(t, '2026-W44'))
  const w45a = [answer('c1-001', '2026-11-03T01:00:00Z', cites)]
  const w45b = [answer('c1-001', '2026-11-05T01:00:00Z', [L.live, L.hand])]
  sjson(`${t}/2026-W45/question-analyses.json`, w45b)
  sjson(`${t}/2026-W45/scorecard.json`, card(t, '2026-W45'))
  for (const [runId, analyses, startedAt, finishedAt] of [
    ['run-1', w45a, '2026-11-03T00:30:00Z', '2026-11-03T02:00:00Z'],
    ['run-2', w45b, '2026-11-05T00:30:00Z', '2026-11-05T02:00:00Z'],
  ] as const) {
    sjson(`${t}/2026-W45/runs/${runId}/scorecard.json`, card(t, '2026-W45'))
    sjson(`${t}/2026-W45/runs/${runId}/question-analyses.json`, analyses)
    sjson(`${t}/2026-W45/runs/${runId}/run.json`, runMeta(t, '2026-W45', runId, startedAt, finishedAt))
  }
}
// 지운 브랜드 · 경쟁사 브랜드에 남은 앱 밖 글 파일 — 지우지 않고 그대로 둔다.
const GONE = xFile([xRow('x-ccccccccccc1', 'https://fake.tistory.com/700', 'fake.tistory.com/700')])
writeFileSync(path.join(sdir('vext-gone'), 'external-posts.json'), GONE)

const env: Record<string, string | undefined> = {
  ...process.env,
  APP_DATA_DIR: dir,
  PORT: String(PORT),
  USE_MOCK_ENGINES: 'true',
  DOTENV_CONFIG_PATH: path.join(dir, 'no-such.env'),
  BLOB_READ_WRITE_TOKEN: '',
  BLOB_STORE_ID: '',
  PIPELINE_CRON: '',
  GH_MEASURE_TOKEN: '',
  ANTHROPIC_API_KEY: '',
}
delete env.AEO_SERVER_HOST

if (!(await portFree())) {
  console.error(`포트 ${PORT}을 다른 프로그램이 쓰고 있어 확인하지 못했습니다.`)
  rmSync(dir, { recursive: true, force: true })
  process.exit(1)
}
const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: repo, env, stdio: 'ignore' })
const call = async (method: string, url: string, body?: unknown) => {
  const r = await fetch(`${BASE}${url}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const text = await r.text()
  let json: Record<string, unknown>
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch (err) {
    json = { parseError: String(err) }
  }
  return { status: r.status, text, json }
}
/** 그 브랜드의 앱 글 응답 셋(바이트 그대로)과 원장 · 집행 상태 파일, 그리고 data/<브랜드>/ 아래 앱 밖 글 파일을 뺀 모든 파일. */
const snapshot = async (tenantId: string) => {
  const files: Record<string, string> = {}
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const f = path.join(d, name)
      if (statSync(f).isDirectory()) walk(f)
      else if (name !== 'external-posts.json') files[path.relative(dir, f)] = readFileSync(f, 'utf-8')
    }
  }
  walk(path.join(dir, 'data', tenantId))
  return {
    posts: (await call('GET', `/api/published-posts/${tenantId}`)).text,
    history: (await call('GET', `/api/published-history/${tenantId}`)).text,
    history52: (await call('GET', `/api/published-history/${tenantId}?weeks=52`)).text,
    runs: (await call('GET', `/api/run-history/${tenantId}`)).text,
    files,
  }
}
const sameSnapshot = (a: Awaited<ReturnType<typeof snapshot>>, b: Awaited<ReturnType<typeof snapshot>>) =>
  a.posts === b.posts && a.history === b.history && a.history52 === b.history52 && a.runs === b.runs && JSON.stringify(a.files) === JSON.stringify(b.files)
try {
  let up = false
  for (let i = 0; i < 80 && !up; i += 1) {
    up = await fetch(`${BASE}/health`).then((r) => r.ok, () => false)
    if (!up) await new Promise((r) => setTimeout(r, 500))
  }
  ok('임시 서버가 뜬다', up)

  const beforeA = await snapshot('vext-a')
  const beforeB = await snapshot('vext-b')
  ok('(준비) 앱 글 응답이 두 번 불러도 같다 — 비교가 뜻이 있다', sameSnapshot(beforeA, await snapshot('vext-a')))
  const histA = JSON.parse(beforeA.history) as { weeks: unknown[]; posts: { cells: unknown[] }[] }
  const runsA = JSON.parse(beforeA.runs) as { points: unknown[]; posts: unknown[] }
  ok('(준비) 앱 글 이력 · 회차 보기가 비어 있지 않다(주차 3 · 글 3 · 회차 4)', histA.weeks.length === 3 && histA.posts.length === 3 && runsA.points.length === 4 && runsA.posts.length === 3)

  // 앱 밖 글 쓰기 — 적기 · 같은 주소 · 거절 · 고치기 · 빼기 · 다시 올림 · 되살리기 · 다른 브랜드
  const page = (url: string, over: Record<string, unknown> = {}) => ({ url, title: '가상 손글', publishedOn: '2026-10-15', publishedOnSource: 'page', ...over })
  const h1 = await call('POST', '/api/external-posts/vext-a', page(L.hand))
  const h1post = h1.json.post as { id: string; state: string } | undefined
  ok('POST 앱 밖 글 — 200 · 살아 있음', h1.status === 200 && h1post?.state === 'live')
  ok('POST 같은 주소 — 있던 줄', (await call('POST', '/api/external-posts/vext-a', page(`${L.hand}?category=2`))).json.existing === true)
  ok('POST 원장의 살아 있는 · 내린 · 옛 기록 주소는 409', (await call('POST', '/api/external-posts/vext-a', page(L.live))).status === 409 && (await call('POST', '/api/external-posts/vext-a', page(L.down))).status === 409 && (await call('POST', '/api/external-posts/vext-a', page(L.legacy))).status === 409)
  const w = await call('POST', '/api/external-posts/vext-a', page(L.wrong, { publishedOn: null }))
  ok('POST 원장에서 「잘못 적음」 주소 · 날짜 모름 — 200', w.status === 200 && (w.json.post as { publishedOn?: unknown } | undefined)?.publishedOn === null)
  ok('POST 올린 날 칸이 빠지면 400 · 첫 화면 주소 400', (await call('POST', '/api/external-posts/vext-a', { url: 'https://fake.tistory.com/77' })).status === 400 && (await call('POST', '/api/external-posts/vext-a', page('https://fake.tistory.com/'))).status === 400)
  const wid = (w.json.post as { id?: string } | undefined)?.id
  ok('PATCH 올린 날 고치기 — 200', (await call('PATCH', `/api/external-posts/vext-a/${wid}`, { publishedOn: '2026-10-11' })).status === 200)
  ok('PATCH 빼기(글을 내림) — 200', (await call('PATCH', `/api/external-posts/vext-a/${h1post?.id}`, { remove: 'taken-down' })).status === 200)
  ok('POST 내린 주소를 다시 적으면 새 줄 — 200', (await call('POST', '/api/external-posts/vext-a', page(L.hand, { publishedOn: '2026-10-25' }))).json.existing === false)
  ok('PATCH 「글을 내림」 줄 되살리기는 400', (await call('PATCH', `/api/external-posts/vext-a/${h1post?.id}`, { restore: true })).status === 400)
  ok('PATCH 빼기(잘못 적음) → 되살리기 — 200', (await call('PATCH', `/api/external-posts/vext-a/${wid}`, { remove: 'mistake' })).status === 200 && (await call('PATCH', `/api/external-posts/vext-a/${wid}`, { restore: true })).status === 200)
  ok('PATCH 없는 줄 404', (await call('PATCH', '/api/external-posts/vext-a/x-000000000000', { publishedOn: null })).status === 404)
  const cross = await call('POST', '/api/external-posts/vext-b', page(L.live))
  ok('POST 다른 브랜드의 앱 글 주소는 적고 「같은 주소」 브랜드를 돌려준다(D13)', cross.status === 200 && JSON.stringify(cross.json.alsoAppIn) === '["vext-a"]')
  ok('POST 경쟁사(비교용) · 지운 · 없는 브랜드는 404', (await call('POST', '/api/external-posts/vext-comp', page(L.hand))).status === 404 && (await call('POST', '/api/external-posts/vext-gone', page(L.hand))).status === 404 && (await call('POST', '/api/external-posts/vext-nope', page(L.hand))).status === 404)
  ok('지운 브랜드의 앱 밖 글 파일은 그대로 남는다(되살리면 돌아온다)', readFileSync(path.join(dir, 'data', 'vext-gone', 'external-posts.json'), 'utf-8') === GONE && (await call('GET', '/api/external-posts/vext-gone')).status === 404)
  ok('경쟁사 브랜드에는 앱 밖 글 파일을 만들지 않는다', !existsSync(path.join(dir, 'data', 'vext-comp', 'external-posts.json')))

  const list = await call('GET', '/api/external-posts/vext-a')
  const listed = (list.json.posts ?? []) as { key: string; state: string }[]
  ok('GET 앱 밖 글 목록 — 내린 줄 · 다시 올린 줄 · 날짜 고친 줄', list.status === 200 && listed.length === 3 && listed.filter((p) => p.key === 'fake.tistory.com/70').map((p) => p.state).sort().join() === 'live,removed')
  const xh = await call('GET', '/api/external-history/vext-a')
  const xhBody = xh.json as { weeks?: unknown[]; posts?: { external: { state: string }; cells: unknown[] }[] }
  ok('GET 앱 밖 글 인용 이력 — 주차 3 · 행 3(내린 줄 포함)', xh.status === 200 && xhBody.weeks?.length === 3 && xhBody.posts?.length === 3)
  ok('GET 지운 · 없는 브랜드의 이력은 404', (await call('GET', '/api/external-history/vext-gone')).status === 404)

  // 2단계 — 주소 한꺼번에 등록(POST /api/post-import/commit)의 앱 밖 글 · 무시도 같은 저장소로만 간다(원장 · 앱 글 응답은 그대로).
  const viaImport = await call('POST', '/api/post-import/commit', {
    items: [
      { kind: 'external', tenantIds: ['vext-a', 'vext-b'], url: 'https://fake.tistory.com/71', title: '가상 손글 둘', publishedOn: '2026-10-16', publishedOnSource: 'page' },
      { kind: 'ignore', url: 'https://fake.tistory.com/72', alsoUrls: [] },
      { kind: 'external', tenantIds: ['vext-a'], url: L.live, title: null, publishedOn: null, publishedOnSource: 'unknown' },
    ],
  })
  const importResults = (viaImport.json.results ?? []) as { kind: string; status: string }[]
  ok(
    '2단계 — 등록 패널의 앱 밖 글(두 브랜드) · 무시 · 원장이 이긴 주소의 거절이 줄마다 결과로',
    viaImport.status === 200 && importResults.map((r) => `${r.kind}:${r.status}`).join() === 'external:added,ignore:added,external:error',
  )
  const statusText = (await call('GET', '/api/publish-status')).text
  ok('2단계 — 발행 현황에 앱 밖 줄이 보인다(읽기만 — 파일을 바꾸지 않는다)', statusText.includes('"origin":"external"') && statusText.includes('fake.tistory.com/71'))

  const afterA = await snapshot('vext-a')
  const afterB = await snapshot('vext-b')
  ok('격리 — 앱 밖 글을 적고 · 고치고 · 빼도 /api/published-posts 응답이 바이트 단위로 같다', beforeA.posts === afterA.posts && beforeB.posts === afterB.posts)
  ok('격리 — /api/published-history 응답(기본 · 52주)이 바이트 단위로 같다', beforeA.history === afterA.history && beforeA.history52 === afterA.history52 && beforeB.history === afterB.history)
  ok('격리 — /api/run-history 응답이 바이트 단위로 같다', beforeA.runs === afterA.runs && beforeB.runs === afterB.runs)
  ok(
    '격리 — published-posts.json · action-states.json이 한 글자도 바뀌지 않는다',
    readFileSync(path.join(dir, 'data', 'vext-a', 'published-posts.json'), 'utf-8') === LEDGER_A &&
      readFileSync(path.join(dir, 'data', 'vext-a', 'action-states.json'), 'utf-8') === STATES_A &&
      readFileSync(path.join(dir, 'data', 'vext-b', 'published-posts.json'), 'utf-8') === LEDGER_B,
  )
  ok('격리 — 브랜드 폴더에서 앱 밖 글 파일 말고는 아무 파일도 생기거나 바뀌지 않는다', JSON.stringify(beforeA.files) === JSON.stringify(afterA.files) && JSON.stringify(beforeB.files) === JSON.stringify(afterB.files))

  const BROKEN = '{"version":1,"posts":['
  writeFileSync(path.join(dir, 'data', 'vext-b', 'external-posts.json'), BROKEN)
  ok('깨진 앱 밖 글 파일 — 목록 · 이력 · 적기 모두 500, 파일은 그대로', (await call('GET', '/api/external-posts/vext-b')).status === 500 && (await call('GET', '/api/external-history/vext-b')).status === 500 && (await call('POST', '/api/external-posts/vext-b', page(L.hand))).status === 500 && readFileSync(path.join(dir, 'data', 'vext-b', 'external-posts.json'), 'utf-8') === BROKEN)
  const brokenB = await snapshot('vext-b')
  ok('깨진 앱 밖 글 파일이 있어도 앱 글 응답은 그대로', brokenB.posts === beforeB.posts && brokenB.history === beforeB.history && brokenB.runs === beforeB.runs)

  // C18 · C21-12 — 2단계 길(등록 패널의 앱 밖 글 · 무시, 발행 현황 읽기, 앱 밖 줄 색인 표시)이 같은 브랜드의 앱 글 쓰기와 한꺼번에 들어와도 멈추지 않는다.
  const liveX = ((await call('GET', '/api/external-posts/vext-a')).json.posts as { id: string; state: string }[]).find((p) => p.state === 'live')
  const burst = await withTimeout(
    Promise.all([
      ...Array.from({ length: 6 }, (_, i) =>
        call('POST', '/api/post-import/commit', { items: [{ kind: 'external', tenantIds: ['vext-a'], url: `https://fake.tistory.com/burst/${i}`, title: null, publishedOn: null, publishedOnSource: 'unknown' }] }),
      ),
      ...Array.from({ length: 4 }, (_, i) => call('POST', '/api/post-import/commit', { items: [{ kind: 'ignore', url: `https://fake.tistory.com/burst-ignore/${i}`, alsoUrls: [] }] })),
      ...Array.from({ length: 4 }, (_, i) =>
        call('POST', '/api/published-posts/vext-a', { articleId: `content:burst-${i}`, targetActionId: `content:burst-${i}`, via: 'own', url: `https://fake.tistory.com/burst-app/${i}` }),
      ),
      ...Array.from({ length: 3 }, () => call('GET', '/api/publish-status')),
      ...Array.from({ length: 3 }, (_, i) => call('PUT', `/api/index-checks/vext-a/${liveX?.id}`, { engine: i % 2 === 0 ? 'naver' : 'google', state: 'shown' })),
      ...Array.from({ length: 3 }, () => call('GET', '/api/external-posts/vext-a')),
    ]),
    30_000,
  )
  ok('C18 — 등록 패널 · 발행 현황 · 색인 표시 · 앱 글 쓰기가 한꺼번에 들어와도 멈추지 않는다(30초 안에 모두 끝남)', burst !== 'timeout' && burst.every((r) => r.status === 200))
  const afterBurst = ((await call('GET', '/api/external-posts/vext-a')).json.posts ?? []) as { key: string }[]
  ok('C18 — 한꺼번에 들어온 앱 밖 글이 하나도 사라지지 않는다', Array.from({ length: 6 }, (_, i) => `fake.tistory.com/burst/${i}`).every((k) => afterBurst.some((p) => p.key === k)))
} catch (err) {
  ok(`서버 검사가 예외 없이 끝난다: ${err instanceof Error ? err.stack : String(err)}`, false)
} finally {
  server.kill()
  await new Promise((r) => setTimeout(r, 800))
  rmSync(dir, { recursive: true, force: true })
}

// ── 5) 퍼포먼스 「앱 밖 글 인용 추적」 절(3단계) — 화면은 jsdom, 응답은 가짜 fetch ─────────────────────────────
// 응답은 3)이 계산한 실제 이력(옮긴 행 · 내렸다 다시 올린 행 · 날짜 모름 포함)을 JSON으로 한 번 돌린 것이다(선을 넘는 모양 그대로).
{
  const realFetch = globalThis.fetch
  try {
    if (!uiFixture) throw new Error('3) 인용 이력 검사가 끝나지 않아 화면 검사를 하지 못했다')
    const { history: XH, ids: xid } = uiFixture
    const React = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { JSDOM } = await import('jsdom')
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1/' })
    // 화면 파일은 jsx 자동 변환을 전제로 하는데 tsx는 고전 변환으로 읽는다 — React를 전역에 둔다. react-dom/client는 읽을 때 DOM을 본다.
    Object.assign(globalThis, { React, window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
    const { createRoot } = await import('react-dom/client')
    const { MemoryRouter } = await import('react-router-dom')
    const { TenantContext } = await import('../src/context/tenant-context')
    const { default: Performance } = await import('../src/pages/Performance')
    const { default: PublishedHistoryTable } = await import('../src/components/PublishedHistoryTable')
    const { loadExternalHistory } = await import('../src/lib/api')
    const { externalMovedOf, ownedExternalHosts, useExternalHistory } = await import('../src/lib/useExternalHistory')
    type TenantSummary = import('../src/lib/api').TenantSummary

    // 가짜 fetch — 길(경로)마다 정한 응답. 정하지 않은 길은 Express · Vercel처럼 JSON이 아닌 404다.
    type Reply = { status: number; body: unknown } | 'network'
    let routes: Record<string, Reply> = {}
    const asked: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      asked.push(url)
      const reply = routes[url.split('?')[0]!] ?? { status: 404, body: 'Not Found' }
      if (reply === 'network') throw new TypeError('fetch failed')
      const json = typeof reply.body !== 'string'
      return new Response(json ? JSON.stringify(reply.body) : String(reply.body), { status: reply.status, headers: { 'Content-Type': json ? 'application/json' : 'text/html' } })
    }) as typeof fetch
    const thrown = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof Error ? e.message : String(e)))
    const XPATH = '/api/external-history/vext-ui'

    // (가) 읽기 — 웹 404만 null(기능 없음), 그 밖의 실패는 이유와 함께 throw
    routes = { [XPATH]: { status: 404, body: 'Not Found' } }
    ok('3단계 읽기 — 웹(라우트 없음 404)은 null', (await loadExternalHistory('vext-ui')) === null)
    routes = { [XPATH]: { status: 404, body: { error: 'tenant not found: vext-ui' } } }
    ok('3단계 읽기 — 브랜드가 없다는 404는 null이 아니라 오류', (await thrown(loadExternalHistory('vext-ui')))?.startsWith('tenant not found') === true)
    routes = { [XPATH]: { status: 500, body: { error: '앱 밖 글 파일(external-posts.json)이 깨져 있어 읽지도 쓰지도 않았습니다: 가상' } } }
    ok('3단계 읽기 — 500은 서버가 준 이유로 throw', (await thrown(loadExternalHistory('vext-ui')))?.includes('깨져 있어') === true)
    routes = { [XPATH]: 'network' }
    ok('3단계 읽기 — 서버에 닿지 못하면 throw', (await thrown(loadExternalHistory('vext-ui')))?.includes('닿지 못했습니다') === true)
    routes = { [XPATH]: { status: 200, body: XH } }
    const loaded = await loadExternalHistory('vext-ui', 52)
    ok('3단계 읽기 — 200은 응답 그대로 · 주 수를 넘긴다', loaded?.posts.length === XH.posts.length && asked.at(-1) === `${XPATH}?weeks=52`)

    // (나) hook — available은 웹(라우트 없음)에서만 false, 읽기 실패는 available true + error
    const host = dom.window.document.getElementById('root')!
    const root = createRoot(host)
    const settle = () => React.act(async () => new Promise((r) => setTimeout(r, 30)))
    let mountKey = 0
    const mount = async (el: React.ReactElement) => {
      mountKey += 1
      await React.act(async () => root.render(React.createElement(React.Fragment, { key: mountKey }, el)))
      await settle()
      await settle()
    }
    const Probe = ({ tenantId }: { tenantId: string }) => {
      const h = useExternalHistory(tenantId)
      return React.createElement('pre', { id: 'probe' }, JSON.stringify({ available: h.available, loading: h.loading, error: h.error, posts: h.history?.posts.length ?? null }))
    }
    const probed = async (tenantId: string) => {
      await mount(React.createElement(Probe, { tenantId }))
      return JSON.parse(dom.window.document.getElementById('probe')?.textContent ?? 'null') as { available: boolean; loading: boolean; error: string | null; posts: number | null }
    }
    const askedBefore = asked.length
    const none = await probed('')
    ok('3단계 hook — 브랜드가 없으면(경쟁사 보기) 읽지 않고 available false', none.available === false && asked.length === askedBefore)
    routes = { [XPATH]: { status: 404, body: 'Not Found' } }
    const webState = await probed('vext-ui')
    ok('3단계 hook — 웹 404면 available false · 불러오기 끝 · 오류 없음', webState.available === false && webState.loading === false && webState.error === null && webState.posts === null)
    routes = { [XPATH]: { status: 500, body: { error: '가상 깨짐' } } }
    const failState = await probed('vext-ui')
    ok('3단계 hook — 읽기 실패는 available true · error에 이유', failState.available === true && failState.error === '가상 깨짐' && failState.posts === null)
    routes = { [XPATH]: { status: 200, body: XH } }
    const okState = await probed('vext-ui')
    ok('3단계 hook — 200이면 이력 · available true', okState.available === true && okState.loading === false && okState.posts === XH.posts.length)

    // (다) 옮김 · 자사 주소 — 화면이 쓰는 순수 함수
    const rowOf = (id: string) => XH.posts.find((p) => p.post.id === id)!
    const movedOf = externalMovedOf(XH)
    const movedJson = (id: string) => JSON.stringify(movedOf(rowOf(id).post))
    ok('3단계 옮김 — 앱 글로 옮긴 행은 옮긴 날 · 앱 글 표가 세기 시작한 날', movedJson(xid.moved!) === '{"movedOn":"2026-10-27","countsFrom":"2026-10-27"}')
    ok('3단계 옮김 — 앱 글 올린 날이 옮긴 날보다 앞이면 세기 시작한 날이 앞선다', movedJson(xid.early!) === '{"movedOn":"2026-11-04","countsFrom":"2026-10-12"}')
    ok('3단계 옮김 — 추적 중 · 날짜 모름 · 내린 · 다시 올린 행은 null', [xid.sameDay!, xid.noDate!, xid.repostOld!, xid.repostNew!].every((id) => movedOf(rowOf(id).post) === null))
    const movedRow = rowOf(xid.moved!)
    const removedFirst = (removedAt: string) => ({ ...XH, posts: [{ ...movedRow, external: { ...movedRow.external, state: 'removed' as const, removedAt, removedReason: 'taken-down' as const } }] })
    ok('3단계 옮김 — 앱 글로 옮기기 전에 「글을 내림」으로 뺀 행은 내림 그대로(null)', externalMovedOf(removedFirst('2026-10-20T03:00:00.000Z'))(movedRow.post) === null)
    ok('3단계 옮김 — 옮긴 뒤에 뺀 행은 옮김(칸을 끊은 까닭이 옮김)', externalMovedOf(removedFirst('2026-11-01T03:00:00.000Z'))(movedRow.post)?.movedOn === '2026-10-27')
    const uiTenant: TenantSummary = {
      tenantId: 'vext-ui',
      brandName: '가상 스테이',
      aliases: [],
      ownedDomains: ['fake.tistory.com', 'blog.naver.com'],
      industry: '숙박',
      region: '가상시',
      engines: ['gemini'],
      questionBankSize: 2,
      competitors: [],
    }
    const naverRow = { ...movedRow, post: { ...movedRow.post, url: 'https://blog.naver.com/fakeblog/224400000009' } }
    ok(
      '3단계 자사 주소 — 이 브랜드 자사 주소에 있는 글의 호스트만 · 여럿이 쓰는 플랫폼(blog.naver.com)은 자사 주소 칸에 있어도 뺀다(C2와 같은 규칙)',
      JSON.stringify(ownedExternalHosts([...XH.posts, naverRow], uiTenant)) === '["fake.tistory.com"]',
    )
    ok('3단계 자사 주소 — 자사 주소가 아니면 빈 목록', ownedExternalHosts(XH.posts, { ...uiTenant, ownedDomains: ['other.example'] }).length === 0)

    // (라) 성과 표 — 머리글 · 설명 · 옮긴 행. 기본(앱 글 표)은 그대로다.
    const probeHistory = { ...XH, weeks: XH.weeks.map((w) => ({ ...w, responses: { ...w.responses, probe: 1 } })) }
    const appHtml = renderToStaticMarkup(React.createElement(PublishedHistoryTable, { history: probeHistory }))
    const extHtml = renderToStaticMarkup(React.createElement(PublishedHistoryTable, { history: probeHistory, header: '앱 밖 글', description: '가상 앱 밖 글 설명.', movedOf }))
    const APP_ONLY = ['같은 주소 · 같은 올린 날을 여러 줄(자사 블로그 · 채널)에 적은 기록은', '기존 글을 고쳤다고 남긴 글은', '실증을 맡은 글(처치)']
    ok('3단계 성과 표 기본 — 머리글 「올린 글」 · 앱 글 설명 그대로(묶기 · 고친 글 · 실증 처치)', appHtml.includes('<th>올린 글</th>') && APP_ONLY.every((s) => appHtml.includes(s)) && !appHtml.includes('가상 앱 밖 글 설명.'))
    ok(
      '3단계 성과 표 앱 밖 — 머리글 「앱 밖 글」 · 앱 글 전용 문장 대신 넘긴 설명 · 공통 문장(숫자 · 실증 · ◆)은 그대로',
      extHtml.includes('<th>앱 밖 글</th>') &&
        !extHtml.includes('<th>올린 글</th>') &&
        APP_ONLY.every((s) => !extHtml.includes(s)) &&
        extHtml.includes('가상 앱 밖 글 설명.') &&
        extHtml.includes('숫자는 그 주소가 정확히 인용된') &&
        extHtml.includes('「실증」은 점수에 넣지 않는') &&
        extHtml.includes('◆는 직전 측정과'),
    )
    const rowsWith = (html: string, url: string) => html.split('<tr>').filter((s) => s.includes(`href="${url}"`))
    const movedTr = rowsWith(extHtml, 'https://fake.tistory.com/h/4')[0] ?? ''
    ok('3단계 옮긴 행 — 「앱 글로 옮김(10/27)」, 「내림」 · 「내린 뒤」 대신 옮긴 뒤 칸은 「앱 글 표에서」', movedTr.includes('앱 글로 옮김(10/27)') && !movedTr.includes('내림') && !movedTr.includes('내린 뒤') && movedTr.includes('앱 글 표에서'))
    ok('3단계 (대조) 옮김을 넘기지 않으면 같은 행이 「10/27 내림」 — 위 검사는 movedOf가 바꾼 것이다', (rowsWith(appHtml, 'https://fake.tistory.com/h/4')[0] ?? '').includes('10/27 내림'))
    const earlyTr = rowsWith(extHtml, 'https://fake.tistory.com/h/6')[0] ?? ''
    ok('3단계 앱 글 올린 날이 앞선 행 — 옮긴 날과 앱 글 표가 세기 시작한 날을 함께 적는다', earlyTr.includes('앱 글로 옮김(11/4)') && earlyTr.includes('10/12부터 앱 글 표에서 셈'))
    const repostTrs = rowsWith(extHtml, 'https://fake.tistory.com/h/3')
    ok('3단계 내렸다 다시 올린 주소 — 두 행, 내린 행은 「10/10 내림」 · 「내린 뒤」 그대로', repostTrs.length === 2 && repostTrs.some((s) => s.includes('10/10 내림') && s.includes('내린 뒤') && !s.includes('앱 글로 옮김')))
    const noAfter = { ...XH, posts: [{ ...movedRow, cells: movedRow.cells.map((c) => (c ? { ...c, afterRemoval: true } : c)) }] }
    const noAfterHtml = renderToStaticMarkup(React.createElement(PublishedHistoryTable, { history: noAfter, header: '앱 밖 글', description: '', movedOf }))
    ok('3단계 옮기기 전 측정이 없는 행 — 판단 칸은 「내림」이 아니라 「앱 글로 옮김」', noAfterHtml.includes('앱 글로 옮김 · 옮기기 전 판단할 측정 없음') && !noAfterHtml.includes('내림 · 올린 뒤'))

    // (마) 퍼포먼스 화면 — 절을 숨기는 때 · 문구 · 나머지 화면은 그대로
    const uiCard = (tenantId: string, weekOf: string, score: number) => ({
      tenantId,
      weekOf,
      aeoScore: { current: score },
      mentionRate: 0.2,
      shareOfMention: 0.3,
      avgRecommendationRank: 2,
      factualityScore: 0.9,
      brandOwnedCitationRate: 0.1,
      judgeEngine: 'gemini',
      hallucinationFlags: [],
    })
    const appPost = {
      id: 'p-uiapp000001',
      url: 'https://fake.tistory.com/app/1',
      key: 'fake.tistory.com/app/1',
      publishedOn: '2026-10-20',
      publishedOnSource: 'user',
      recordedAt: '2026-10-20T01:00:00.000Z',
      articleId: 'content:a',
      targetActionId: 'content:a',
      via: 'own',
      articleTitle: '가상 앱 글',
    }
    const baseRoutes = (): Record<string, Reply> => ({
      '/api/scorecards/vext-ui': { status: 200, body: XH.weeks.map((w, i) => uiCard('vext-ui', w.weekOf, 20 + i)) },
      '/api/scorecards/vext-comp': { status: 200, body: XH.weeks.map((w, i) => uiCard('vext-comp', w.weekOf, 30 + i)) },
      '/api/published-history/vext-ui': { status: 200, body: { weeks: XH.weeks, posts: [{ post: appPost, cells: XH.weeks.map(() => null) }] } },
    })
    const ctx = (tenant: TenantSummary, viewing: TenantSummary | null) => ({
      tenants: [tenant],
      tenantId: viewing?.tenantId ?? tenant.tenantId,
      setTenantId: () => {},
      tenant: viewing ?? tenant,
      customer: tenant,
      viewing,
      viewCompetitor: async () => {},
      exitCompetitorView: () => {},
      loading: false,
      error: null,
      reloadTenants: async () => [tenant],
    })
    const show = async (external: Reply, tenant = uiTenant, viewing: TenantSummary | null = null) => {
      routes = { ...baseRoutes(), [XPATH]: external }
      await mount(
        React.createElement(
          TenantContext.Provider,
          { value: ctx(tenant, viewing) },
          React.createElement(MemoryRouter, { initialEntries: ['/performance'] }, React.createElement(Performance)),
        ),
      )
      return host.innerHTML
    }
    const HEAD = '앱 밖 글 인용 추적'
    const sectionText = () => dom.window.document.getElementById('external')?.textContent ?? ''
    const web = await show({ status: 404, body: 'Not Found' })
    ok(
      '3단계 (준비) 퍼포먼스 화면에 올린 글 표 · 집행 핀(앱 글 1편) · 「집행」 칸이 그려진다',
      web.includes('올린 글 인용 추적') && (web.match(/class="exec-pin/g)?.length ?? 0) === 1 && web.includes('「가상 앱 글」') && web.includes('>집행</th>'),
    )
    ok('3단계 퍼포먼스 — 웹(라우트 없음 404)이면 절을 숨긴다', !web.includes(HEAD))
    const empty = await show({ status: 200, body: { weeks: XH.weeks, posts: [] } })
    ok('3단계 퍼포먼스 — 앱 밖 글 0편이면 절을 숨기고 화면이 웹과 한 글자도 다르지 않다', !empty.includes(HEAD) && empty === web)
    const full = await show({ status: 200, body: XH })
    const section = dom.window.document.getElementById('external')
    ok(
      '3단계 퍼포먼스 — 앱 밖 글이 있으면 올린 글 표 바로 아래에 절',
      section?.querySelector('h3')?.textContent === HEAD && full.includes('id="published"') && full.indexOf('id="published"') < full.indexOf('id="external"'),
    )
    ok(
      '3단계 퍼포먼스 머리말 — 이 브랜드 측정 답변 기준(C19) · 점수 · 집행 핀 · 보고서 · 실행 계획에는 넣지 않음',
      sectionText().includes('이 브랜드 측정 답변 기준') && sectionText().includes('점수 · 집행 핀') && sectionText().includes('정기진단 보고서') && sectionText().includes('실행 계획에는 넣지 않습니다'),
    )
    ok(
      '3단계 퍼포먼스 자사 주소 — 중립 문구(들어갈 수 있음 · 더하지 않음), 「이미 자사 인용률에 들어 있다」고 단정하지 않음(C1)',
      sectionText().includes('fake.tistory.com') && sectionText().includes('자사 인용률에도 들어갈 수 있습니다') && sectionText().includes('둘을 더하지 않습니다') && !sectionText().includes('이미 자사 인용률'),
    )
    ok('3단계 퍼포먼스 — 절에 합계 줄이 없다(자사 인용 KPI와 더해 보이지 않게)', section?.querySelector('tfoot') === null && !sectionText().includes('합계'))
    ok('3단계 퍼포먼스 — 표 머리글 「앱 밖 글」 · 옮긴 행 「앱 글로 옮김(10/27)」', section?.querySelector('th')?.textContent === '앱 밖 글' && sectionText().includes('앱 글로 옮김(10/27)'))
    const rest = host.cloneNode(true) as HTMLElement
    rest.querySelector('#external')?.remove()
    ok('3단계 퍼포먼스 — 절을 빼면 나머지 화면(집행 핀 · 「집행」 칸 · 올린 글 표 · 스코어카드)이 웹과 한 글자도 다르지 않다', rest.innerHTML === web)
    const broken = await show({ status: 500, body: { error: '앱 밖 글 파일(external-posts.json)이 깨져 있어 읽지도 쓰지도 않았습니다: 가상' } })
    ok('3단계 퍼포먼스 — 앱 밖 글 파일이 깨졌으면 절에 이유를 보인다(조용히 숨기지 않는다)', broken.includes(HEAD) && sectionText().includes('앱 밖 글 기록: 앱 밖 글 파일(external-posts.json)이 깨져'))
    await show({ status: 200, body: XH }, { ...uiTenant, ownedDomains: ['other.example'] })
    ok('3단계 퍼포먼스 — 자사 주소 글이 없으면 자사 주소 문구가 없다', sectionText().includes(HEAD) && !sectionText().includes('자사 인용률에도'))
    const askedComp = asked.length
    const comp = await show({ status: 200, body: XH }, uiTenant, { ...uiTenant, tenantId: 'vext-comp', brandName: '가상 경쟁사' })
    ok('3단계 퍼포먼스 — 경쟁사 보기에서는 앱 밖 글을 읽지도 보이지도 않는다', comp.includes('주간 스코어카드') && !comp.includes(HEAD) && !asked.slice(askedComp).some((u) => u.includes('/api/external-history/')))
    await React.act(async () => root.unmount())
  } catch (err) {
    ok(`퍼포먼스 절 검사가 예외 없이 끝난다: ${err instanceof Error ? err.stack : String(err)}`, false)
  } finally {
    globalThis.fetch = realFetch
  }
}

let failed = 0
for (const [text, pass] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${text}`)
  if (!pass) failed += 1
}
if (failed > 0) {
  console.error(`\n${failed}건 실패`)
  process.exit(1)
}
console.log(`\n모두 통과 (${checks.length}건)`)
