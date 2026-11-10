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
 * 4단계 — 앱 전체 무시 목록(server/postImportIgnored.ts)은 측정 · 원장 · 보고서 · 실행 계획이 불러오지 않고, 보기 · 되돌리기도 앱 글 응답을
 * 바꾸지 않으며, 브랜드 쓰기와 한꺼번에 들어와도 멈추지 않는다(C18). 화면은 jsdom으로 본다: 「앱 글 아님 줄 모두 무시」는 「앱 글 아님」 줄만
 * 무시로 바꿔 체크하고(읽지 못함 줄은 빼고 — D10 · D14) 저장은 「이대로 등록」 때 하며(D6), 「무시한 글 보기 · 되돌리기」는 그 줄의 주소로 푼다.
 * 발행 현황 「관리」의 「빼기 + 새 글 찾기에서도 숨김」은 빼기를 먼저 하고, 무시가 걸려도 뺀 것을 알린다(C17).
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
// 4단계 — 앱 전체 무시 목록(server/postImportIgnored.ts)도 측정 · 원장 · 이력 · 보고서 · 실행 계획이 불러오지 않는다(새 글 찾기 숨김일 뿐이다).
const ignoredAbs = path.resolve(repo, 'server/postImportIgnored.ts')
const ignoredLeaks = [
  ...CLOSED_ROOTS.filter((r) => existsSync(path.resolve(repo, r)) && closureOf(r).has(ignoredAbs)),
  ...DIRECT_ROOTS.filter((r) => existsSync(path.resolve(repo, r)) && importsOf(path.resolve(repo, r)).includes(ignoredAbs)),
]
ok(
  `정적 검사 — 4단계 무시 목록 모듈은 측정 · 원장 · 이력 · 보고서 · 실행 계획 · 앱 글 화면이 불러오지 않는다${ignoredLeaks.length ? `: ${ignoredLeaks.join(', ')}` : ''}`,
  existsSync(ignoredAbs) && ignoredLeaks.length === 0 && closureOf('server/index.ts').has(ignoredAbs),
)

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
/** 최종 점검 — 날짜 모름으로 다시 올린 줄 · 날짜를 적은 다시 올린 줄이 든 실제 응답(5)이 성과 표에 넘긴다). */
let repostFixture: ClientExternalHistory | null = null

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
  // 내린 날이 오늘이라 다시 올린 날은 「모름」으로 적는다(내린 날 뒤여야 한다 — C9, 아래 (차)).
  const again = await add(T, page('https://fake.tistory.com/95', { publishedOn: null }))
  ok('내린 주소를 다시 적으면 새 x- 줄(내린 기간이 남는다)', !again.existing && again.post.id !== repost.post.id && again.posts.filter((p) => p.key === 'fake.tistory.com/95').length === 2)
  ok('「글을 내림」으로 뺀 줄은 되살리지 않는다(400 — 다시 올렸으면 새로 적는다)', (await fails(ext.updateExternalPost(T, repost.post.id, { restore: true }))) === 400)
  await ext.updateExternalPost(T, again.post.id, { remove: 'mistake' })
  const third = await add(T, page('https://fake.tistory.com/95', { publishedOn: null }))
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

  // ── 검토 반영(2026-11-10) — D12: 앱 글 표가 실제로 세는 회차만 비운다 ─────────────────────────────────────────
  // 날짜(0시)로 끊으면 옮긴 날 옮기기 전에 끝난 측정 · 앱 글의 올린 날을 기록일보다 뒤로 고친 사이의 측정을 어느 표도 세지 않았다. 회차마다 두 표
  // 가운데 정확히 하나가 세야 한다(앱 밖 줄을 올린 뒤 회차).
  const H2 = 'vx-hist-d12'
  const U2 = { morning: 'https://fake.tistory.com/d/1', runs: 'https://fake.tistory.com/d/2', later: 'https://fake.tistory.com/d/3' }
  const u2All = Object.values(U2)
  // W44 10-28 한 회차 · W45 11-04 오전 10시(한국) 한 회차 · W46 11-10 오전 10시 · 오후 5시 두 회차(회차 기록에 측정 시작 시각)
  const cards2 = ['2026-W44', '2026-W45', '2026-W46'].map((w) => card(H2, w))
  const m1 = [answer('c1-001', '2026-11-10T01:00:00Z', u2All)]
  const m2 = [answer('c1-001', '2026-11-10T08:00:00Z', u2All)]
  const byWeek2: Record<string, QuestionRepeatAnalysis[]> = {
    '2026-W44': [answer('c1-001', '2026-10-28T01:00:00Z', u2All)],
    '2026-W45': [answer('c1-001', '2026-11-04T01:00:00Z', u2All)],
    '2026-W46': m2,
  }
  const store2 = {
    getScorecardHistory: async (_t: string, n: number) => cards2.slice(-n),
    getQuestionAnalyses: async (_t: string, week: string) => byWeek2[week] ?? [],
    getQuestionBank: async (_t: string, v: string) => (v === 'v1' ? bankV1 : null),
    listRunSnapshots: async (_t: string, week: string) =>
      week === '2026-W46'
        ? {
            runs: [
              { meta: runMeta(H2, week, 'm1', '2026-11-10T00:50:00Z', '2026-11-10T01:30:00Z'), scorecard: card(H2, week), analyses: m1 },
              { meta: runMeta(H2, week, 'm2', '2026-11-10T07:50:00Z', '2026-11-10T08:30:00Z'), scorecard: card(H2, week), analyses: m2 },
            ],
            issues: [],
          }
        : { runs: [], issues: [] },
  }
  const tenantH2 = { tenantId: H2, questionBankVersion: 'v1' }
  const d12 = { morning: 'x-222222222201', runs: 'x-222222222202', later: 'x-222222222203' }
  writeData(
    H2,
    'external-posts.json',
    xFile([
      xRow(d12.morning, U2.morning, 'fake.tistory.com/d/1', { publishedOn: '2026-10-20', trackedAt: '2026-11-01T01:00:00.000Z' }),
      xRow(d12.runs, U2.runs, 'fake.tistory.com/d/2', { publishedOn: '2026-10-20', trackedAt: '2026-11-01T01:00:00.000Z' }),
      xRow(d12.later, U2.later, 'fake.tistory.com/d/3', { publishedOn: '2026-10-20', trackedAt: '2026-11-01T01:00:00.000Z' }),
    ]),
  )
  const H2LEDGER = [
    // 11-04 낮 12시(한국)에 패널 「옮김」으로 적음 — 올린 날 = 그날(누른 시각이 올린 시각). 그날 오전 10시 측정은 옮기기 전이다.
    ledgerRow('p-d12d12d12d01', U2.morning, 'fake.tistory.com/d/1', '2026-11-04', '2026-11-04T03:00:00.000Z'),
    // 11-10 오후 2시(한국)에 옮김 — 그날 오전 회차는 옮기기 전, 오후 회차는 옮긴 뒤.
    ledgerRow('p-d12d12d12d02', U2.runs, 'fake.tistory.com/d/2', '2026-11-10', '2026-11-10T05:00:00.000Z'),
    // 11-03에 적고 올린 날을 11-05로 뒤로 고쳤다 — 앱 글 표는 11-05부터 센다(11-04 측정은 앱 밖 표의 몫).
    ledgerRow('p-d12d12d12d03', U2.later, 'fake.tistory.com/d/3', '2026-11-05', '2026-11-03T03:00:00.000Z'),
  ]
  writeData(H2, 'published-posts.json', JSON.stringify({ version: 1, keyRule: 3, posts: H2LEDGER }, null, 2))
  const hist2 = await ext.getExternalHistory(store2, tenantH2, 12)
  const app2 = await getPublishedHistory(store2, tenantH2, H2LEDGER as Parameters<typeof getPublishedHistory>[2], 12)
  const xCell2 = (id: string, w: string) => hist2.posts.find((p) => p.post.id === id)?.cells[hist2.weeks.findIndex((x) => x.weekOf === w)] ?? null
  const aCell2 = (id: string, w: string) => app2.posts.find((p) => p.post.id === id)?.cells[app2.weeks.findIndex((x) => x.weekOf === w)] ?? null
  const pairs2: [string, string][] = [
    [d12.morning, 'p-d12d12d12d01'],
    [d12.runs, 'p-d12d12d12d02'],
    [d12.later, 'p-d12d12d12d03'],
  ]
  ok(
    'D12 검토 반영 — 옮긴 날 오전 측정(옮기기 전에 끝남)은 앱 밖 표가 센다(앱 글 표는 「올리기 전」) · 「앱 글 표에서」로 비우지 않는다',
    counted(xCell2(d12.morning, '2026-W45')) && (xCell2(d12.morning, '2026-W45')?.tally?.all.cited ?? 0) === 1 && aCell2('p-d12d12d12d01', '2026-W45')?.timing === 'before',
  )
  ok(
    'D12 검토 반영 — 앱 글의 올린 날을 기록일보다 뒤로 고쳤으면 그 사이 측정(11-04)은 앱 밖 표가 센다',
    counted(xCell2(d12.later, '2026-W45')) && aCell2('p-d12d12d12d03', '2026-W45')?.timing === 'before' && xCell2(d12.later, '2026-W46')?.afterRemoval === true && counted(aCell2('p-d12d12d12d03', '2026-W46')),
  )
  ok(
    'D12 검토 반영 — 회차가 하나인 주는 어느 측정이든 두 표 가운데 정확히 하나가 센다(옮기기 전 W44 · 옮긴 날 · 고친 올린 날)',
    pairs2.every(([x, p]) => ['2026-W44', '2026-W45'].every((w) => counted(xCell2(x, w)) !== counted(aCell2(p, w)))),
  )
  ok(
    'D12 검토 반영 — 옮긴 날 두 회차(오전 · 오후, 옮김은 그 사이) — 오전 회차는 앱 밖 표, 오후 회차는 앱 글 표가 센다',
    runsSeen(xCell2(d12.runs, '2026-W46')) === 1 && runsSeen(aCell2('p-d12d12d12d02', '2026-W46')) === 1 && xCell2(d12.runs, '2026-W46')?.runs?.cited === 1 &&
      aCell2('p-d12d12d12d02', '2026-W46')?.runs?.cited === 1,
  )
  ok(
    'D12 검토 반영 — 옮긴 뒤 측정만 있는 주(두 회차 모두 옮긴 뒤)는 앱 밖 칸을 비우고 앱 글 표가 두 회차를 센다',
    xCell2(d12.morning, '2026-W46')?.afterRemoval === true && runsSeen(aCell2('p-d12d12d12d01', '2026-W46')) === 2,
  )
  ok(
    'D12 검토 반영 — 옮긴 날은 기록 시각(한국 날짜) · 앱 글 표가 세기 시작하는 날은 앱 글의 올린 날(기록일과 섞지 않는다)',
    hist2.posts.find((p) => p.post.id === d12.later)?.external.movedOn === '2026-11-03' && hist2.posts.find((p) => p.post.id === d12.later)?.external.appCountsFrom === '2026-11-05' &&
      hist2.posts.every((p) => p.external.state === 'moved' && !p.post.removedAt),
  )

  // ── 검토 반영 — C9: 다시 올린 줄의 올린 날은 내린 날 뒤여야 한다(비공개를 풀면 페이지 날짜가 처음 올린 날 그대로) ──────────────
  const R = 'vx-repost-date'
  const RURL = 'https://fake.tistory.com/r/1'
  writeData(R, 'external-posts.json', xFile([xRow('x-333333333301', RURL, 'fake.tistory.com/r/1', { publishedOn: '2026-10-01', removedAt: '2026-10-10T01:00:00.000Z', removedReason: 'taken-down' })]))
  const earlyErr = await errorOf(add(R, page(RURL, { publishedOn: '2026-10-01' })))
  ok('C9 검토 반영 — 내린 주소를 처음 올린 날(내린 날 이전)로 다시 적으면 400 · 까닭(내린 날 뒤 · 날짜 모름)', earlyErr?.status === 400 && earlyErr.message.includes('2026-10-10') && earlyErr.message.includes('날짜 모름'))
  ok('C9 검토 반영 — 내린 날과 같은 날도 400(처음 올린 날과 내린 날이 같은 글을 막는다)', (await fails(add(R, page(RURL, { publishedOn: '2026-10-10' })))) === 400)
  const lateOk = await add(R, page(RURL, { publishedOn: '2026-10-11' }))
  ok('C9 검토 반영 — 내린 날 뒤 날짜는 새 줄로 받는다', !lateOk.existing && lateOk.post.publishedOn === '2026-10-11' && lateOk.posts.length === 2)
  ok('C9 검토 반영 — 다시 올린 줄의 올린 날을 내린 날 이전으로 고치면 400 · 뒤 날짜 · 모름은 받는다', (await fails(ext.updateExternalPost(R, lateOk.post.id, { publishedOn: '2026-10-05' }))) === 400 &&
    (await fails(ext.updateExternalPost(R, lateOk.post.id, { publishedOn: null }))) === null && (await fails(ext.updateExternalPost(R, lateOk.post.id, { publishedOn: '2026-10-12' }))) === null)
  ok('C9 검토 반영 — 내린 줄 자기 올린 날은 그대로 고친다(그 앞에 내린 줄이 없다)', (await fails(ext.updateExternalPost(R, 'x-333333333301', { publishedOn: '2026-10-02' }))) === null)
  const R2 = 'vx-repost-restore'
  const R2URL = 'https://fake.tistory.com/r/2'
  writeData(
    R2,
    'external-posts.json',
    xFile([
      xRow('x-444444444401', R2URL, 'fake.tistory.com/r/2', { publishedOn: '2026-10-01', removedAt: '2026-10-10T01:00:00.000Z', removedReason: 'taken-down' }),
      xRow('x-444444444402', R2URL, 'fake.tistory.com/r/2', { publishedOn: '2026-10-02', trackedAt: '2026-10-21T01:00:00.000Z', removedAt: '2026-10-22T01:00:00.000Z', removedReason: 'mistake' }),
    ]),
  )
  ok(
    'C9 검토 반영 — 「잘못 적음」 줄을 되살릴 때도 같은 주소에 내린 줄이 있으면 올린 날은 그 뒤여야 한다(400) · 날짜를 함께 고치면 받는다',
    (await fails(ext.updateExternalPost(R2, 'x-444444444402', { restore: true }))) === 400 &&
      (await ext.updateExternalPost(R2, 'x-444444444402', { restore: true, publishedOn: '2026-10-15' })).post.state === 'live',
  )
  const repostHist = await ext.getExternalHistory(
    {
      getScorecardHistory: async (_t: string, n: number) => ['2026-W41', '2026-W42'].map((w) => card(R, w)).slice(-n),
      getQuestionAnalyses: async (_t: string, week: string) => (week === '2026-W41' ? [answer('c1-001', '2026-10-08T01:00:00Z', [RURL])] : [answer('c1-001', '2026-10-14T01:00:00Z', [RURL])]),
      getQuestionBank: async (_t: string, v: string) => (v === 'v1' ? bankV1 : null),
      listRunSnapshots: async () => ({ runs: [], issues: [] }),
    },
    { tenantId: R, questionBankVersion: 'v1' },
    12,
  )
  const repostCells = (w: string) => repostHist.posts.map((p) => p.cells[repostHist.weeks.findIndex((x) => x.weekOf === w)] ?? null)
  ok('C9 검토 반영 — 받은 날짜로는 같은 측정을 두 줄이 함께 세지 않는다(내리기 전은 내린 줄, 다시 올린 뒤는 새 줄)', ['2026-W41', '2026-W42'].every((w) => repostCells(w).filter((c) => counted(c)).length === 1))

  // ── 최종 점검 — 날짜 모름(D3)으로 다시 올린 줄도 내린 날까지의 측정을 세지 않는다(C9 · 색인 표시와 같은 기준일) ─────────────────────
  // 날짜를 모르는 칸(unknown)도 숫자가 보인다 — 기준일을 두지 않으면 내린 줄이 센 측정이 다시 올린 줄에도 「인용」으로 함께 보였다. 기준일은 색인 표시와
  // 같은 externalIndexBasis(내린 날 다음 날)이고, 서버(칸 비우기)와 화면(까닭)이 같은 함수(repostBasis · measuredBefore)를 쓴다.
  const RU = 'vx-repost-undated'
  const RA = 'https://fake.tistory.com/ru/1'
  const RB = 'https://fake.tistory.com/ru/2'
  const ru = { downA: 'x-555555555501', liveA: 'x-555555555502', downB: 'x-555555555503', liveB: 'x-555555555504' }
  // W41 10-08 · W42 10-14 · W44 10-28 · W45 두 회차 11-03 · 11-05(내린 날 11-04 다음 날)
  const ruCards = ['2026-W41', '2026-W42', '2026-W44', '2026-W45'].map((w) => card(RU, w))
  const ruRun1 = [answer('c1-001', '2026-11-03T01:00:00Z', [RA, RB])]
  const ruRun2 = [answer('c1-001', '2026-11-05T01:00:00Z', [RA, RB])]
  const ruWeeks: Record<string, QuestionRepeatAnalysis[]> = {
    '2026-W41': [answer('c1-001', '2026-10-08T01:00:00Z', [RA, RB])],
    '2026-W42': [answer('c1-001', '2026-10-14T01:00:00Z', [RA, RB])],
    '2026-W44': [answer('c1-001', '2026-10-28T01:00:00Z', [RA, RB])],
    '2026-W45': ruRun2,
  }
  const ruStore = {
    getScorecardHistory: async (_t: string, n: number) => ruCards.slice(-n),
    getQuestionAnalyses: async (_t: string, week: string) => ruWeeks[week] ?? [],
    getQuestionBank: async (_t: string, v: string) => (v === 'v1' ? bankV1 : null),
    listRunSnapshots: async (_t: string, week: string) =>
      week === '2026-W45'
        ? {
            runs: [
              { meta: runMeta(RU, week, 'q1', '2026-11-03T00:30:00Z', '2026-11-03T02:00:00Z'), scorecard: card(RU, week), analyses: ruRun1 },
              { meta: runMeta(RU, week, 'q2', '2026-11-05T00:30:00Z', '2026-11-05T02:00:00Z'), scorecard: card(RU, week), analyses: ruRun2 },
            ],
            issues: [],
          }
        : { runs: [], issues: [] },
  }
  writeData(
    RU,
    'external-posts.json',
    xFile([
      // A — 10-01에 올려 11-04 오전 10시(한국)에 내림 → 11-06에 날짜 모름으로 다시 적음
      xRow(ru.downA, RA, 'fake.tistory.com/ru/1', { removedAt: '2026-11-04T01:00:00.000Z', removedReason: 'taken-down' }),
      xRow(ru.liveA, RA, 'fake.tistory.com/ru/1', { publishedOn: null, publishedOnSource: 'unknown', trackedAt: '2026-11-06T01:00:00.000Z' }),
      // B(대조) — 10-01에 올려 10-20에 내림 → 10-25에 다시 올렸다고 날짜를 적음(C9 — 내린 날 뒤)
      xRow(ru.downB, RB, 'fake.tistory.com/ru/2', { removedAt: '2026-10-20T01:00:00.000Z', removedReason: 'taken-down' }),
      xRow(ru.liveB, RB, 'fake.tistory.com/ru/2', { publishedOn: '2026-10-25', publishedOnSource: 'user', trackedAt: '2026-10-26T01:00:00.000Z' }),
    ]),
  )
  const tenantRU = { tenantId: RU, questionBankVersion: 'v1' }
  const ruHist = await ext.getExternalHistory(ruStore, tenantRU, 12)
  repostFixture = JSON.parse(JSON.stringify(ruHist)) as ClientExternalHistory
  const ruCell = (id: string, w: string) => ruHist.posts.find((p) => p.post.id === id)?.cells[ruHist.weeks.findIndex((x) => x.weekOf === w)] ?? null
  /** 숫자가 보이는 칸 — 내린 뒤 · 올리기 전이 아닌 칸(날짜 모름 칸도 숫자가 보인다). */
  const shows = (c: { afterRemoval: boolean; timing: string } | null) => Boolean(c && !c.afterRemoval && c.timing !== 'before')
  const ruSingle = ['2026-W41', '2026-W42', '2026-W44']
  ok(
    '최종 점검 — 날짜 모름으로 다시 올린 줄: 앞 줄을 내린 날(11-04)까지의 측정(W41 · W42 · W44)은 비운다(내린 뒤 모양 — 날짜 모름은 그대로)',
    ruSingle.every((w) => ruCell(ru.liveA, w)?.afterRemoval === true && ruCell(ru.liveA, w)?.tally === null && ruCell(ru.liveA, w)?.timing === 'unknown') &&
      ruSingle.every((w) => shows(ruCell(ru.downA, w))),
  )
  ok(
    '최종 점검 — 회차가 둘인 주(W45, 내린 날이 두 회차 사이) — 앞 회차(11-03)는 내린 줄, 뒤 회차(11-05 · 기준일)는 다시 올린 줄이 센다',
    ruCell(ru.downA, '2026-W45')?.runs?.measured === 1 && ruCell(ru.downA, '2026-W45')?.runs?.cited === 1 &&
      shows(ruCell(ru.liveA, '2026-W45')) && ruCell(ru.liveA, '2026-W45')?.timing === 'unknown' && ruCell(ru.liveA, '2026-W45')?.tally?.all.cited === 1,
  )
  ok(
    '최종 점검 — 어느 측정이든 내린 줄 · 날짜 모름으로 다시 올린 줄 가운데 많아야 하나에만 숫자가 보인다',
    ruSingle.every((w) => [ru.downA, ru.liveA].filter((id) => shows(ruCell(id, w))).length === 1),
  )
  const { summarizePost } = await import('../src/lib/publishTracking')
  const liveARow = ruHist.posts.find((p) => p.post.id === ru.liveA)
  ok(
    '최종 점검 — 다시 올린 줄의 판단은 「올린 날 모름」 그대로(비운 칸 때문에 「내림」이 되지 않는다) · 살아 있는 줄',
    liveARow?.external.state === 'live' && summarizePost(liveARow.cells as Parameters<typeof summarizePost>[0], ruHist.weeks, null).tier === 'undated',
  )
  // 대조 — 같은 줄을 기준일 없이(옮김도 없이) 그대로 계산한 칸.
  const ruParsed = lib.parseExternalPostsFile(JSON.parse(readData(RU, 'external-posts.json')))
  const ruPosts = ruParsed.ok ? ruParsed.posts : []
  const plain = await getPublishedHistory(ruStore, tenantRU, lib.externalViews(ruPosts, []).map(lib.externalAsLedgerPost) as Parameters<typeof getPublishedHistory>[2], 12)
  const plainCells = (id: string) => JSON.stringify(plain.posts.find((p) => p.post.id === id)?.cells ?? null)
  const ruCells = (id: string) => JSON.stringify(ruHist.posts.find((p) => p.post.id === id)?.cells ?? null)
  ok(
    '최종 점검 — 날짜를 적은 다시 올린 줄(C9 — 내린 날 뒤)과 내린 줄들은 칸이 기준일을 두기 전과 한 글자도 다르지 않다(올리기 전 칸은 이미 「올리기 전」)',
    plainCells(ru.liveB) !== 'null' && plainCells(ru.liveB) === ruCells(ru.liveB) && plainCells(ru.downB) === ruCells(ru.downB) && plainCells(ru.downA) === ruCells(ru.downA) &&
      ruCell(ru.liveB, '2026-W41')?.timing === 'before' && ruCell(ru.liveB, '2026-W42')?.timing === 'before' && ruCell(ru.liveB, '2026-W44')?.timing === 'after',
  )
  // 서버(칸 비우기)와 화면(까닭)이 같은 함수 — 기준일은 색인 표시와 같은 externalIndexBasis.
  const sharedBasis = typeof lib.repostBasis === 'function' && typeof lib.measuredBefore === 'function'
  const ruViews = ruHist.posts.map((p) => p.external)
  const basisA = sharedBasis ? lib.repostBasis(ruViews, ruViews.find((v) => v.id === ru.liveA)!) : null
  ok(
    '최종 점검 — 다시 올린 줄의 기준일은 색인 표시와 같은 externalIndexBasis(내린 날 다음 날) · 다시 올린 줄이 아니면 없음',
    sharedBasis && basisA?.downOn === '2026-11-04' && basisA.countsFrom === '2026-11-05' &&
      basisA.countsFrom === lib.externalIndexBasis(ruViews, ruViews.find((v) => v.id === ru.liveA)!) &&
      lib.repostBasis(ruViews, ruViews.find((v) => v.id === ru.downA)!) === null && lib.repostBasis(ruViews, ruViews.find((v) => v.id === ru.liveB)!)?.countsFrom === '2026-10-25',
  )
  ok(
    '최종 점검 — 비운 칸은 정확히 기준일 앞 측정이다(measuredBefore — 칸의 전후와 같은 규칙: 측정한 마지막 날이 기준일 앞 · 시각 없는 옛 기록은 주차)',
    sharedBasis && basisA !== null &&
      ruHist.weeks.every((w, i) => {
        const c = ruHist.posts.find((p) => p.post.id === ru.liveA)?.cells[i] ?? null
        return w.runs ? true : (c?.afterRemoval === true) === lib.measuredBefore(basisA.countsFrom, w.window, w.weekOf)
      }) &&
      lib.measuredBefore('2026-11-05', { first: '2026-11-04', last: '2026-11-04' }, '2026-W45') && !lib.measuredBefore('2026-11-05', { first: '2026-11-05', last: '2026-11-05' }, '2026-W45') &&
      lib.measuredBefore('2026-11-05', null, '2026-W44') && !lib.measuredBefore('2026-11-05', null, '2026-W45'),
  )
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
  ok('POST 내린 주소를 내린 날 이전 날짜(페이지의 처음 올린 날)로 다시 적으면 400(C9)', (await call('POST', '/api/external-posts/vext-a', page(L.hand, { publishedOn: '2026-10-25' }))).status === 400)
  ok('POST 내린 주소를 다시 적으면 새 줄 — 200(내린 날이 오늘이라 날짜 모름)', (await call('POST', '/api/external-posts/vext-a', page(L.hand, { publishedOn: null }))).json.existing === false)
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
  // 최종 점검 — 오늘 내리고 날짜 모름으로 다시 적은 주소: 지난 측정은 모두 내린 줄의 몫이다(다시 올린 줄에는 숫자가 보이지 않는다).
  type ApiCell = { afterRemoval: boolean; timing: string; tally: unknown } | null
  const handRows = ((xh.json.posts ?? []) as { external: { key: string; state: string }; cells: ApiCell[] }[]).filter((p) => p.external.key === 'fake.tistory.com/70')
  const apiShows = (c: ApiCell) => Boolean(c && !c.afterRemoval && c.timing !== 'before')
  ok(
    '최종 점검(API) — 날짜 모름으로 다시 올린 줄은 앞 줄을 내린 날까지의 측정을 비우고, 어느 주든 두 줄 가운데 하나에만 숫자가 보인다',
    handRows.length === 2 &&
      handRows.find((r) => r.external.state === 'live')?.cells.every((c) => c !== null && c.afterRemoval && c.tally === null && c.timing === 'unknown') === true &&
      (xhBody.weeks ?? []).every((_, i) => handRows.filter((r) => apiShows(r.cells[i] ?? null)).length === 1),
  )
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
  // 4단계 — 무시한 글 보기 · 되돌리기도 앱 전체 무시 목록만 바꾼다(아래 격리 비교에 함께 든다).
  const viewIgnored = await call('GET', '/api/post-import/ignored')
  const undoIgnored = await call('POST', '/api/post-import/unignore', { urls: ['https://fake.tistory.com/72'] })
  ok(
    '4단계 — 무시한 글 보기 · 되돌리기(무시 목록만 바뀐다)',
    viewIgnored.status === 200 && (viewIgnored.json.ignored as { url: string }[] | undefined)?.some((e) => e.url === 'https://fake.tistory.com/72') === true &&
      undoIgnored.status === 200 && undoIgnored.json.removed === 1,
  )

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
      // 4단계 — 무시한 글 보기 · 되돌리기(무시 목록 줄)가 브랜드 쓰기 · 등록과 엇갈려도 멈추지 않는다.
      ...Array.from({ length: 2 }, () => call('GET', '/api/post-import/ignored')),
      ...Array.from({ length: 2 }, (_, i) => call('POST', '/api/post-import/unignore', { urls: [`https://fake.tistory.com/burst-ignore/${i}`] })),
    ]),
    30_000,
  )
  ok('C18 — 등록 패널 · 발행 현황 · 색인 표시 · 앱 글 쓰기 · 무시 보기 · 되돌리기가 한꺼번에 들어와도 멈추지 않는다(30초 안에 모두 끝남)', burst !== 'timeout' && burst.every((r) => r.status === 200))
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
    const { externalMovedOf, externalRepostOf, ownedExternalHosts, useExternalHistory } = await import('../src/lib/useExternalHistory')
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
    // 옮긴 줄은 원장 모양에 내린 표시를 싣지 않는다(서버가 앱 글 표가 세는 회차만 비운다 — D12 검토 반영). 옮김을 넘기지 않으면 비운 칸이 「내린 뒤」로 보인다.
    const plainMovedTr = rowsWith(appHtml, 'https://fake.tistory.com/h/4')[0] ?? ''
    ok('3단계 (대조) 옮김을 넘기지 않으면 같은 행의 비운 칸이 「내린 뒤」 · 「앱 글로 옮김」이 없다 — 위 검사는 movedOf가 바꾼 것이다', plainMovedTr.includes('내린 뒤') && !plainMovedTr.includes('앱 글로 옮김') && !plainMovedTr.includes('앱 글 표에서'))
    const earlyTr = rowsWith(extHtml, 'https://fake.tistory.com/h/6')[0] ?? ''
    ok('3단계 앱 글 올린 날이 앞선 행 — 옮긴 날과 앱 글 표가 세기 시작한 날을 함께 적는다', earlyTr.includes('앱 글로 옮김(11/4)') && earlyTr.includes('10/12부터 앱 글 표에서 셈'))
    const repostTrs = rowsWith(extHtml, 'https://fake.tistory.com/h/3')
    ok('3단계 내렸다 다시 올린 주소 — 두 행, 내린 행은 「10/10 내림」 · 「내린 뒤」 그대로', repostTrs.length === 2 && repostTrs.some((s) => s.includes('10/10 내림') && s.includes('내린 뒤') && !s.includes('앱 글로 옮김')))
    const noAfter = { ...XH, posts: [{ ...movedRow, cells: movedRow.cells.map((c) => (c ? { ...c, afterRemoval: true } : c)) }] }
    const noAfterHtml = renderToStaticMarkup(React.createElement(PublishedHistoryTable, { history: noAfter, header: '앱 밖 글', description: '', movedOf }))
    ok('3단계 옮기기 전 측정이 없는 행 — 판단 칸은 「내림」이 아니라 「앱 글로 옮김」', noAfterHtml.includes('앱 글로 옮김 · 옮기기 전 판단할 측정 없음') && !noAfterHtml.includes('내림 · 올린 뒤'))
    // 검토 반영(2026-11-10) — C9 + D3: 앱 밖 글 표는 줄마다 한 행(groupRows false). 원장 규칙(같은 주소에 날짜 있는 줄이 있으면 날짜 없는 줄을 뺀다 ·
    // 같은 날짜 줄은 한 행)으로 묶으면 날짜 모름으로 다시 올린 살아 있는 줄이나 내리기 전 줄이 사라진다.
    const oldRow = rowOf(xid.repostOld!)
    const newRow = rowOf(xid.repostNew!)
    const undated = (r: typeof oldRow, id: string, title: string, over: Partial<typeof oldRow.post> = {}) => ({
      ...r,
      post: { ...r.post, id, articleTitle: title, publishedOn: null, ...over },
      external: { ...r.external, id, title, publishedOn: null, publishedOnSource: 'unknown' as const },
    })
    const tableOf = (posts: (typeof oldRow)[], groupRows?: boolean) =>
      renderToStaticMarkup(React.createElement(PublishedHistoryTable, { history: { ...XH, posts }, header: '앱 밖 글', description: '', movedOf, ...(groupRows === undefined ? {} : { groupRows }) }))
    const datedDownUndatedLive = [{ ...oldRow, post: { ...oldRow.post, articleTitle: '가상 먼저 올린 글' } }, undated(newRow, 'x-111111111191', '가상 다시 올린 글')]
    const undatedDownDatedLive = [undated(oldRow, 'x-111111111192', '가상 먼저 올린 글', { removedAt: oldRow.post.removedAt }), { ...newRow, post: { ...newRow.post, articleTitle: '가상 다시 올린 글' } }]
    const bothUndated = [undated(oldRow, 'x-111111111193', '가상 먼저 올린 글', { removedAt: oldRow.post.removedAt }), undated(newRow, 'x-111111111194', '가상 다시 올린 글')]
    const both = (html: string) => html.includes('가상 먼저 올린 글') && html.includes('가상 다시 올린 글') && html.split('<tr>').length - 2 === 2
    ok(
      'C9 + D3 검토 반영 — 앱 밖 글 표는 줄마다 한 행: 날짜 있는 내린 줄 + 날짜 모름 다시 올린 줄 · 그 반대 · 둘 다 날짜 모름 모두 두 행',
      both(tableOf(datedDownUndatedLive, false)) && both(tableOf(undatedDownDatedLive, false)) && both(tableOf(bothUndated, false)),
    )
    ok(
      '(대조) 묶는 표(기본 — 앱 글 표)는 예전 그대로 날짜 없는 줄을 날짜 있는 줄에 묻는다 — 위 검사는 groupRows가 바꾼 것이다',
      !tableOf(datedDownUndatedLive).includes('가상 다시 올린 글') && !both(tableOf(bothUndated)),
    )
    // 검토 반영 — 옮긴 행의 「최근 측정한 주에는 인용 없음」은 옮기기 전 마지막 측정 주의 말이다(최근 측정은 앱 글 표가 센다).
    const cited = movedRow.cells.find((c) => c && !c.afterRemoval && c.tally)!
    const lapsedCells = XH.weeks.map((_, i) => (i === 0 ? cited : i === 1 ? { ...cited, tally: null } : { ...cited, afterRemoval: true, tally: null }))
    const lapsedHtml = renderToStaticMarkup(
      React.createElement(PublishedHistoryTable, { history: { ...XH, posts: [{ ...movedRow, cells: lapsedCells }] }, header: '앱 밖 글', description: '', movedOf, groupRows: false }),
    )
    ok('검토 반영 — 옮긴 행은 「옮기기 전 마지막 측정 주에는 인용 없음」(「최근 측정한 주에는 인용 없음」이 아니다)', lapsedHtml.includes('옮기기 전 마지막 측정 주에는 인용 없음') && !lapsedHtml.includes('최근 측정한 주에는 인용 없음'))
    const plainLapsed = renderToStaticMarkup(React.createElement(PublishedHistoryTable, { history: { ...XH, posts: [{ ...movedRow, cells: lapsedCells }] } }))
    ok('(대조) 옮김을 넘기지 않으면(앱 글 표) 「최근 측정한 주에는 인용 없음」 그대로', plainLapsed.includes('최근 측정한 주에는 인용 없음'))

    // 최종 점검 — 날짜 모름으로 다시 올린 행의 비운 칸(앞 행을 내린 날까지의 측정)은 「다시 올리기 전」과 그 까닭을 단다(「내린 뒤」가 아니다). 날짜를
    // 적은 다시 올린 행 · 내린 행은 그대로다. 어느 칸에 까닭을 달지는 서버가 칸을 비운 것과 같은 함수로 정한다(externalRepostOf).
    if (!repostFixture) throw new Error('3) 다시 올린 줄 이력 검사가 끝나지 않아 화면 검사를 하지 못했다')
    const RF = repostFixture
    const repostOf = typeof externalRepostOf === 'function' ? externalRepostOf(RF) : undefined
    const rfTable = (props: Record<string, unknown> = {}) =>
      renderToStaticMarkup(React.createElement(PublishedHistoryTable, { history: RF, header: '앱 밖 글', description: '', groupRows: false, ...props }))
    const rfHtml = rfTable({ repostOf })
    const rfRows = (html: string, url: string) => rowsWith(html, url)
    const liveATr = rfRows(rfHtml, 'https://fake.tistory.com/ru/1').find((s) => s.includes('올린 날 모름')) ?? ''
    const downATr = rfRows(rfHtml, 'https://fake.tistory.com/ru/1').find((s) => s.includes('11/4 내림')) ?? ''
    const liveBTr = rfRows(rfHtml, 'https://fake.tistory.com/ru/2').find((s) => !s.includes('내림')) ?? ''
    ok(
      '최종 점검 — 날짜 모름으로 다시 올린 행: 비운 칸 셋(W41 · W42 · W44)은 「다시 올리기 전」 · 까닭(앞 행을 11/4에 내림) · 「내린 뒤」가 아니다',
      (liveATr.match(/<div>다시 올리기 전<\/div>/g)?.length ?? 0) === 3 && liveATr.includes('같은 주소를 11/4에 내렸습니다') && !liveATr.includes('내린 뒤'),
    )
    ok(
      '최종 점검 — 내린 행 · 날짜를 적은 다시 올린 행에는 「다시 올리기 전」이 없다(날짜를 적은 행의 앞 칸은 「—」 올리기 전 그대로)',
      downATr !== '' && !downATr.includes('다시 올리기 전') && liveBTr !== '' && !liveBTr.includes('다시 올리기 전') && liveBTr.includes('올리기 전에 한 측정이라 세지 않습니다'),
    )
    const plainLiveATr = rfRows(rfTable(), 'https://fake.tistory.com/ru/1').find((s) => s.includes('올린 날 모름')) ?? ''
    ok('(대조) 다시 올린 행을 넘기지 않으면 같은 칸이 「내린 뒤」 — 위 검사는 repostOf가 바꾼 것이다', plainLiveATr.includes('내린 뒤') && !plainLiveATr.includes('다시 올리기 전'))
    // 최종 점검 — 날짜 모름 칸 도움말: 앱 글 표는 「올린 날을 모르는 옛 기록」 그대로, 앱 밖 글 표는 넘긴 문구(옛 기록이 아니다).
    const titlesOf = (html: string) => [...html.matchAll(/<td class="history-cell[^"]*" title="([^"]*)"/g)].map((m) => m[1]!)
    const UNDATED_APP = '올린 날을 모르는 옛 기록입니다 — 판단에는 넣지 않습니다'
    const extUndated = renderToStaticMarkup(React.createElement(PublishedHistoryTable, { history: XH, header: '앱 밖 글', description: '', groupRows: false, undatedNote: '가상 날짜 모름 도움말' }))
    ok('최종 점검 — 앱 글 표(기본)의 날짜 모름 칸 도움말은 그대로 「옛 기록」', titlesOf(appHtml).some((t) => t.startsWith(UNDATED_APP)))
    ok(
      '최종 점검 — 앱 밖 글 표는 날짜 모름 칸 도움말을 넘긴 문구로 쓴다(「옛 기록」이 아니다)',
      titlesOf(extUndated).some((t) => t.startsWith('가상 날짜 모름 도움말')) && !titlesOf(extUndated).some((t) => t.includes('옛 기록')),
    )

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
    const sectionTitles = () => [...(dom.window.document.getElementById('external')?.querySelectorAll('td.history-cell[title]') ?? [])].map((td) => td.getAttribute('title') ?? '')
    ok(
      '최종 점검 — 퍼포먼스 앱 밖 글 표의 날짜 모름 칸 도움말은 「올린 날을 모르는 앱 밖 글」(「옛 기록」이 아니다)',
      sectionTitles().some((t) => t.startsWith('올린 날을 모르는 앱 밖 글입니다')) && !sectionTitles().some((t) => t.includes('옛 기록')),
    )
    if (repostFixture) await show({ status: 200, body: repostFixture })
    ok(
      '최종 점검 — 퍼포먼스 앱 밖 글 표는 날짜 모름으로 다시 올린 행의 비운 칸에 「다시 올리기 전」 · 까닭을 단다',
      sectionTitles().filter((t) => t.startsWith('같은 주소를 11/4에 내렸습니다')).length === 3 && sectionText().includes('다시 올리기 전'),
    )
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

// ── 6) 4단계 화면 — 「앱 글 아님 줄 모두 무시」(D10 · D14 · D6) · 「무시한 글 보기 · 되돌리기」 · 앱 밖 글 「빼기 + 새 글 찾기에서도 숨김」(C17) ─────
// jsdom과 가짜 fetch(경로 · 방법 · 본문을 적어 둔다). 서버 규칙(거절 · 상한 · 깨진 파일)은 verify-post-import가 본다 — 여기는 화면이 무엇을 언제
// 보내고 결과를 어떻게 보이는지만 본다.
{
  const realFetch = globalThis.fetch
  try {
    const React = await import('react')
    const { JSDOM } = await import('jsdom')
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1/' })
    Object.assign(globalThis, { React, window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
    const { createRoot } = await import('react-dom/client')
    const { MemoryRouter } = await import('react-router-dom')
    const { default: PostImportPanel } = await import('../src/components/PostImportPanel')
    const { default: PublishStatusPage } = await import('../src/pages/PublishStatus')
    type StatusRow = import('../src/lib/publishStatus').PublishStatusRow
    const doc = dom.window.document

    type Asked = { method: string; path: string; body: unknown }
    type Reply = { status: number; body: unknown } | 'network'
    const asked: Asked[] = []
    let reply: (a: Asked) => Reply = () => ({ status: 404, body: 'Not Found' })
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const a: Asked = { method: (init?.method ?? 'GET').toUpperCase(), path: url.split('?')[0]!, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null }
      asked.push(a)
      const r = reply(a)
      if (r === 'network') throw new TypeError('fetch failed')
      const json = typeof r.body !== 'string'
      return new Response(json ? JSON.stringify(r.body) : String(r.body), { status: r.status, headers: { 'Content-Type': json ? 'application/json' : 'text/html' } })
    }) as typeof fetch
    const sentTo = (p: string) => asked.filter((a) => a.path === p)

    const host = doc.getElementById('root')!
    let root = createRoot(host)
    const settle = async (n = 3) => {
      for (let i = 0; i < n; i += 1) await React.act(async () => new Promise((r) => setTimeout(r, 30)))
    }
    const click = async (el: Element | null | undefined) => {
      if (!el) throw new Error('누를 것을 찾지 못했다')
      await React.act(async () => (el as HTMLElement).click())
      await settle()
    }
    const buttonNamed = (text: string, within: ParentNode = doc) => [...within.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(text))

    // (가) 주소 한꺼번에 등록 — 새 글 찾기로 여섯 줄을 읽는다: 1 · 5 앱 글 아님, 2 맞음, 3 읽지 못함, 4 앱 글 아님이지만 무시 여부를 모름, 6 추적 중.
    const U = (n: number) => `https://fake-ui.tistory.com/${n}`
    const K = (n: number) => `fake-ui.tistory.com/${n}`
    const cand = (articleId: string, body: number) => ({ tenantId: 'vui-a', brand: '가상스테이', articleId, title: `가상 앱 글 ${articleId}`, body, titleScore: 0.3, writer: null, bankUnknown: false, writerUnknown: false, otherUrls: 0 })
    const readOk = (n: number, candidates: ReturnType<typeof cand>[], over: Record<string, unknown> = {}) => ({
      ok: true,
      url: U(n),
      key: K(n),
      readUrl: U(n),
      recordUrl: U(n),
      recordKey: K(n),
      urlNote: null,
      platform: { key: 'tistory', label: '티스토리' },
      post: { title: `가상 손글 ${n}`, publishedOn: '2026-11-01', dateText: null, dateProblem: null, bodyChars: 800 },
      candidates,
      known: [],
      tracked: [],
      ignoredAt: null,
      ownedBrands: [],
      appLedgers: [],
      stateUnknown: [],
      ...over,
    })
    const READS: Record<string, unknown> = {
      [U(1)]: readOk(1, [cand('content:a', 0.1)]),
      [U(2)]: readOk(2, [cand('content:b', 0.6), cand('content:a', 0.1)]),
      [U(3)]: { ok: false, url: U(3), key: K(3), error: '없는 글입니다(HTTP 404) — 가상' },
      [U(4)]: readOk(4, [cand('content:a', 0.1)], { stateUnknown: ['무시 목록'] }),
      [U(5)]: readOk(5, [cand('content:a', 0.12)]),
      [U(6)]: readOk(6, [cand('content:a', 0.1)], { tracked: [{ tenantId: 'vui-a', brand: '가상스테이', postId: 'x-uiuiuiuiui06', key: K(6), state: 'live', publishedOn: null, trackedAt: '2026-11-02T00:00:00.000Z' }] }),
    }
    const entry = (url: string, ignoredAt: string) => ({ url, urls: [url], keys: [url.replace(/^https:\/\//, '')], ignoredAt })
    let ignoredRows = [entry(U(9), '2026-11-08T01:00:00.000Z')]
    const panelReply = (a: Asked): Reply => {
      if (a.path === '/api/blog-sources') return { status: 200, body: { sources: [{ url: 'https://fake-ui.tistory.com', platform: 'tistory', addedAt: '2026-11-01T00:00:00.000Z' }] } }
      if (a.path === '/api/post-import/list') {
        return { status: 200, body: { source: 'https://fake-ui.tistory.com', platform: 'tistory', found: 9, newUrls: [1, 2, 3, 4, 5, 6].map(U), older: 0, hiddenExternal: 1, hiddenIgnored: 2, errors: [] } }
      }
      if (a.path === '/api/post-import/read') return { status: 200, body: READS[(a.body as { url: string }).url] }
      if (a.path === '/api/post-import/commit') {
        const items = (a.body as { items: { kind?: string; url: string; tenantId?: string; articleId?: string }[] }).items
        const results = items.map((it) => {
          if (it.kind === 'ignore') {
            ignoredRows = [entry(it.url, '2026-11-10T03:00:00.000Z'), ...ignoredRows]
            return { kind: 'ignore', url: it.url, status: 'added' }
          }
          return { kind: 'app', tenantId: it.tenantId, articleId: it.articleId, url: it.url, status: 'added', postId: 'p-uiuiuiuiui02' }
        })
        return { status: 200, body: { results, warnings: [] } }
      }
      if (a.path === '/api/post-import/ignored') return { status: 200, body: { ignored: ignoredRows, max: 5000 } }
      if (a.path === '/api/post-import/unignore') {
        const urls = (a.body as { urls: string[] }).urls
        const before = ignoredRows.length
        ignoredRows = ignoredRows.filter((e) => !e.urls.some((u) => urls.includes(u)))
        return { status: 200, body: { removed: before - ignoredRows.length, ignored: ignoredRows } }
      }
      return { status: 404, body: 'Not Found' }
    }
    reply = panelReply
    const rowOf = (n: number) => [...doc.querySelectorAll('.pi-table tbody tr')].find((tr) => tr.querySelector(`a[href="${U(n)}"]`))
    const selectOf = (n: number) => rowOf(n)?.querySelector('select') as HTMLSelectElement | null | undefined
    const checkOf = (n: number) => rowOf(n)?.querySelector('input[type="checkbox"]') as HTMLInputElement | null | undefined
    const BULK = '앱 글 아님 줄 모두 무시'
    await React.act(async () => root.render(React.createElement(PostImportPanel, { today: '2026-11-10', brands: [{ tenantId: 'vui-a', brand: '가상스테이' }], onRegistered: () => {} })))
    await settle()
    await click(buttonNamed('새 글 찾기'))
    await settle(6)
    const listText = [...doc.querySelectorAll('.pi-list-notes li')].map((li) => li.textContent ?? '').join(' ')
    ok('4단계 새 글 찾기 — 뺀 앱 밖 글 · 무시한 글 수를 목록 위에 보인다', listText.includes('앱 밖 글 1편 · 무시한 글 2편 뺌') && doc.querySelectorAll('.pi-table tbody tr').length === 6)
    ok(
      'D10 · D14 — 일괄 단추는 「앱 글 아님」 줄 수만 센다(읽지 못함 · 무시 여부를 모름 · 추적 중 · 맞음 줄은 빼고)',
      buttonNamed(BULK)?.textContent === `${BULK} (2)`,
    )
    const commitsBefore = sentTo('/api/post-import/commit').length
    await click(buttonNamed(BULK))
    ok(
      'D6 — 일괄 단추는 「앱 글 아님」 줄을 무시로 바꾸고 체크만 한다(아직 저장하지 않는다)',
      selectOf(1)?.value === 'ignore' && checkOf(1)?.checked === true && selectOf(5)?.value === 'ignore' && checkOf(5)?.checked === true &&
        sentTo('/api/post-import/commit').length === commitsBefore && buttonNamed(BULK) === undefined,
    )
    ok(
      'D14 — 일괄 무시는 「읽지 못함」 · 무시 여부를 모르는 줄 · 추적 중인 줄 · 맞음 줄을 건드리지 않는다(읽지 못함 줄은 하나씩 무시를 고를 수 있다)',
      selectOf(3)?.value === '' && [...(selectOf(3)?.options ?? [])].some((o) => o.value === 'ignore') && checkOf(3)?.checked === false &&
        selectOf(4)?.value === '' && checkOf(4)?.checked === false && selectOf(6)?.value === 'external' && selectOf(2)?.value === 'vui-a\ncontent:b' && checkOf(2)?.checked === true,
    )
    const registerBtn = buttonNamed('이대로 등록')
    ok('D6 — 등록 단추가 고른 일을 센다(앱 글 1 · 무시 2)', registerBtn?.textContent === '이대로 등록 (앱 글 1 · 무시 2)')
    await click(registerBtn)
    await settle()
    const sent = sentTo('/api/post-import/commit').at(-1)?.body as { items: { kind?: string; url: string }[] } | undefined
    ok(
      'D6 — 「이대로 등록」을 누를 때 무시를 함께 보낸다(줄 순서 그대로 · 앱 글 줄은 예전 모양)',
      sent?.items.map((i) => `${i.kind ?? 'app'}:${i.url}`).join() === [`ignore:${U(1)}`, `app:${U(2)}`, `ignore:${U(5)}`].join() &&
        (rowOf(1)?.textContent ?? '').includes('무시함') && (rowOf(5)?.textContent ?? '').includes('무시함'),
    )

    // (나) 무시한 글 보기 · 되돌리기 — 열 때 읽고(최근 것부터), 되돌리면 그 줄의 주소로 풀고 남은 목록을 다시 그린다.
    const listItems = () => [...doc.querySelectorAll('.pi-ignored-list li')]
    const hrefs = () => listItems().map((li) => li.querySelector('a')?.getAttribute('href'))
    const VIEW = '무시한 글 보기 · 되돌리기'
    await click(buttonNamed(VIEW))
    ok('4단계 무시한 글 보기 — 열면 목록을 읽어 최근 것부터 보인다(방금 무시한 두 글 · 전에 무시한 글)', hrefs().join() === [U(5), U(1), U(9)].join() && buttonNamed(VIEW)?.getAttribute('aria-expanded') === 'true')
    await click(listItems().find((li) => li.querySelector(`a[href="${U(1)}"]`))?.querySelector('button'))
    ok(
      '4단계 되돌리기 — 그 줄의 주소로 풀고 남은 목록을 다시 그린다 · 다음 새 글 찾기에 다시 나온다고 알린다',
      JSON.stringify(sentTo('/api/post-import/unignore').at(-1)?.body) === JSON.stringify({ urls: [U(1)] }) && hrefs().join() === [U(5), U(9)].join() &&
        (doc.querySelector('.pi-ignored-box')?.textContent ?? '').includes('다음 「새 글 찾기」에'),
    )
    ok(
      '4단계 되돌리기 — 표에 있는 그 주소 줄은 무시가 풀린 상태로 돌아간다(「앱 글 아님」 · 체크 없음 · 다시 일괄 무시 대상)',
      selectOf(1)?.value === '' && checkOf(1)?.checked === false && !(rowOf(1)?.textContent ?? '').includes('무시함') && selectOf(5)?.value === 'ignore' &&
        buttonNamed(BULK)?.textContent === `${BULK} (1)`,
    )
    await click(buttonNamed(VIEW))
    ok('4단계 무시한 글 보기 — 다시 누르면 닫는다', listItems().length === 0 && buttonNamed(VIEW)?.getAttribute('aria-expanded') === 'false')
    reply = (a) => (a.path === '/api/post-import/ignored' ? { status: 500, body: { error: '무시 목록(post-import-ignored.json)이 깨져 있어 읽지도 쓰지도 않았습니다: 가상' } } : panelReply(a))
    await click(buttonNamed(VIEW))
    ok('4단계 무시한 글 보기 — 목록을 읽지 못하면 이유를 보인다(빈 목록으로 보이지 않는다)', (doc.querySelector('.pi-ignored-box [role="alert"]')?.textContent ?? '').includes('깨져 있어') && listItems().length === 0)
    ignoredRows = []
    reply = panelReply
    await click(buttonNamed(VIEW))
    await click(buttonNamed(VIEW))
    ok('4단계 무시한 글 보기 — 빈 목록이면 「무시한 글이 없습니다」', (doc.querySelector('.pi-ignored-box')?.textContent ?? '').includes('무시한 글이 없습니다'))
    await React.act(async () => root.unmount())

    // (다) 발행 현황 「관리」 — 빼기 + 새 글 찾기에서도 숨김(C17): 빼기를 먼저 하고 무시 목록에 적는다. 무시가 걸리면 뺀 것은 그대로 두고 알린다.
    const xRow = (n: number, over: Partial<StatusRow> = {}): StatusRow => ({
      rowKey: `vui-a|x-uiuiuiuiui${n}`,
      tenantId: 'vui-a',
      brand: '가상스테이',
      kind: 'posted',
      origin: 'external',
      postId: `x-uiuiuiuiui${n}`,
      key: K(n),
      articleId: `external:x-uiuiuiuiui${n}`,
      title: `가상 손글 ${n}`,
      writer: null,
      writerUnknown: null,
      postedUnknown: false,
      platform: { key: 'tistory', label: '티스토리' },
      url: U(n),
      publishedOn: '2026-11-01',
      recheckFrom: '2026-11-05',
      trackedOn: '2026-11-05',
      removed: null,
      naver: null,
      google: null,
      checkFrom: null,
      ...over,
    })
    // 11번 주소는 다른 브랜드(vui-b)의 앱 글이기도 하다 — 새 글 찾기에서 이미 빠지므로 숨김을 고르지 않는다.
    const status = {
      today: '2026-11-10',
      brands: [
        { tenantId: 'vui-a', brand: '가상스테이' },
        { tenantId: 'vui-b', brand: '가상여관' },
      ],
      rows: [
        xRow(10),
        xRow(11),
        xRow(11, { rowKey: 'vui-b|p-uiuiuiuiui11', tenantId: 'vui-b', brand: '가상여관', origin: 'app', postId: 'p-uiuiuiuiui11', articleId: 'content:z', title: '가상 앱 글 z', trackedOn: null, recheckFrom: '2026-11-01' }),
      ],
      writers: [],
      issues: [],
    }
    let commitReply: Reply = { status: 200, body: { results: [{ kind: 'ignore', url: U(10), status: 'added' }], warnings: [] } }
    let patchReply: Reply = { status: 200, body: { post: {}, posts: [] } }
    reply = (a) => {
      if (a.path === '/api/publish-status') return { status: 200, body: status }
      if (a.path === '/api/blog-sources') return { status: 200, body: { sources: [] } }
      if (a.path.startsWith('/api/external-posts/')) return patchReply
      if (a.path === '/api/post-import/commit') return commitReply
      return { status: 404, body: 'Not Found' }
    }
    root = createRoot(host)
    await React.act(async () => root.render(React.createElement(MemoryRouter, { initialEntries: ['/publish-status'] }, React.createElement(PublishStatusPage))))
    await settle()
    const manageOf = (n: number) => doc.querySelector(`summary[aria-label="가상스테이 「가상 손글 ${n}」 티스토리 앱 밖 글 관리"]`)?.parentElement ?? null
    const hideBox = (n: number) =>
      ([...(manageOf(n)?.querySelectorAll('label') ?? [])].find((l) => (l.textContent ?? '').includes('새 글 찾기에서도 숨김'))?.querySelector('input') ?? null) as HTMLInputElement | null
    const removeBtn = (n: number) => [...(manageOf(n)?.querySelectorAll('button') ?? [])].find((b) => b.textContent === '빼기')
    const noteText = () => [...doc.querySelectorAll('p.pi-note[role="status"]')].map((p) => p.textContent ?? '').join(' ')
    const sinceMark = () => {
      const from = asked.length
      return () => asked.slice(from).filter((a) => a.method !== 'GET').map((a) => `${a.method} ${a.path}`)
    }
    ok('C17 (준비) 앱 밖 줄마다 「관리」가 있다', manageOf(10) !== null && manageOf(11) !== null && hideBox(10)?.disabled === false)
    await click(hideBox(10))
    let writes = sinceMark()
    await click(removeBtn(10))
    await settle()
    const sentIgnore = sentTo('/api/post-import/commit').at(-1)?.body
    ok(
      'C17 — 빼기를 먼저 하고(PATCH) 그다음 무시 목록에 적는다 · 「새 글 찾기에서도 숨깁니다」',
      writes().join() === ['PATCH /api/external-posts/vui-a/x-uiuiuiuiui10', 'POST /api/post-import/commit'].join() &&
        JSON.stringify(sentIgnore) === JSON.stringify({ items: [{ kind: 'ignore', url: U(10) }] }) &&
        noteText().includes('가상스테이에서 뺐습니다(잘못 적음)') && noteText().includes('새 글 찾기에서도 숨깁니다'),
    )
    commitReply = { status: 200, body: { results: [{ kind: 'ignore', url: U(10), status: 'error', error: '가상 — 무시 목록이 5000개를 넘어 더 적지 않았습니다' }], warnings: [] } }
    if (!hideBox(10)?.checked) await click(hideBox(10))
    writes = sinceMark()
    await click(removeBtn(10))
    await settle()
    ok(
      'C17 — 무시가 걸려도 뺀 것은 그대로 두고 까닭과 함께 알린다(반만 된 것을 숨기지 않는다)',
      writes().join() === ['PATCH /api/external-posts/vui-a/x-uiuiuiuiui10', 'POST /api/post-import/commit'].join() &&
        noteText().includes('뺐습니다') && noteText().includes('다만 새 글 찾기에서 숨기지 못했습니다 — 가상 — 무시 목록이 5000개를'),
    )
    commitReply = 'network'
    if (!hideBox(10)?.checked) await click(hideBox(10))
    await click(removeBtn(10))
    await settle()
    ok('C17 — 무시 요청이 서버에 닿지 못해도 뺀 것은 알리고 숨기지 못한 까닭을 붙인다', noteText().includes('뺐습니다') && noteText().includes('숨기지 못했습니다') && noteText().includes('닿지 못했습니다'))
    patchReply = { status: 500, body: { error: '앱 밖 글 파일(external-posts.json)이 깨져 있어 읽지도 쓰지도 않았습니다: 가상' } }
    commitReply = { status: 200, body: { results: [{ kind: 'ignore', url: U(10), status: 'added' }], warnings: [] } }
    if (!hideBox(10)?.checked) await click(hideBox(10))
    writes = sinceMark()
    await click(removeBtn(10))
    await settle()
    ok(
      'C17 — 빼기가 걸리면 무시 목록에 적지 않는다(숨기기만 되는 일이 없다) · 까닭을 그 「관리」에 보인다',
      writes().join() === 'PATCH /api/external-posts/vui-a/x-uiuiuiuiui10' && (manageOf(10)?.querySelector('[role="alert"]')?.textContent ?? '').includes('깨져 있어'),
    )
    patchReply = { status: 200, body: { post: {}, posts: [] } }
    ok(
      'C17 — 같은 주소가 다른 브랜드에 남아 있으면 숨김을 고를 수 없고 그 까닭(이미 새 글 찾기에 나오지 않음)을 보인다',
      hideBox(11)?.disabled === true && (manageOf(11)?.textContent ?? '').includes('가상여관의 앱 글에 남아 있어 새 글 찾기에는 이미 나오지 않습니다'),
    )
    writes = sinceMark()
    await click(removeBtn(11))
    await settle()
    ok(
      'C17 — 그 줄을 빼면 빼기만 한다(무시 목록에 적지 않는다)',
      writes().join() === 'PATCH /api/external-posts/vui-a/x-uiuiuiuiui11' && noteText().includes('「가상 손글 11」을(를) 가상스테이에서 뺐습니다(잘못 적음).') && !noteText().includes('숨기'),
    )
    await React.act(async () => root.unmount())
  } catch (err) {
    ok(`4단계 화면 검사가 예외 없이 끝난다: ${err instanceof Error ? err.stack : String(err)}`, false)
  } finally {
    globalThis.fetch = realFetch
  }
}

// ── 7) 검토 반영(2026-11-10) 화면 — 등록 패널(옮김 날짜 · 옮긴 뒤 줄 · 읽지 못함 무시 · 다시 올린 날 · 이름 · 되돌리기 포커스) · 발행 현황 「관리」
// (앱 글로 가진 브랜드 막기 · 올린 날 범위 · 내린 줄 날짜 · 결과 문구 · 포커스). jsdom과 가짜 fetch.
{
  const realFetch = globalThis.fetch
  try {
    const React = await import('react')
    const { JSDOM } = await import('jsdom')
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1/' })
    Object.assign(globalThis, { React, window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
    const { createRoot } = await import('react-dom/client')
    const { MemoryRouter } = await import('react-router-dom')
    const { default: PostImportPanel } = await import('../src/components/PostImportPanel')
    const { default: PublishStatusPage } = await import('../src/pages/PublishStatus')
    const { todayKst } = await import('../src/lib/publishedUrl')
    type StatusRow = import('../src/lib/publishStatus').PublishStatusRow
    const doc = dom.window.document

    type Asked = { method: string; path: string; body: unknown }
    type Reply = { status: number; body: unknown }
    const asked: Asked[] = []
    let reply: (a: Asked) => Reply = () => ({ status: 404, body: 'Not Found' })
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const a: Asked = { method: (init?.method ?? 'GET').toUpperCase(), path: url.split('?')[0]!, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null }
      asked.push(a)
      const r = reply(a)
      const json = typeof r.body !== 'string'
      return new Response(json ? JSON.stringify(r.body) : String(r.body), { status: r.status, headers: { 'Content-Type': json ? 'application/json' : 'text/html' } })
    }) as typeof fetch
    const sentTo = (p: string) => asked.filter((a) => a.path === p)
    const host = doc.getElementById('root')!
    let root = createRoot(host)
    const settle = async (n = 3) => {
      for (let i = 0; i < n; i += 1) await React.act(async () => new Promise((r) => setTimeout(r, 30)))
    }
    const click = async (el: Element | null | undefined) => {
      if (!el) throw new Error('누를 것을 찾지 못했다')
      await React.act(async () => (el as HTMLElement).click())
      await settle()
    }
    const pick = async (el: HTMLSelectElement | null | undefined, value: string) => {
      if (!el) throw new Error('고를 칸을 찾지 못했다')
      await React.act(async () => {
        el.value = value
        el.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
      })
      await settle()
    }
    const typeInto = async (el: Element | null | undefined, value: string) => {
      if (!el) throw new Error('적을 칸을 찾지 못했다')
      const proto = el instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype
      await React.act(async () => {
        Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
        el.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
      await settle()
    }
    const buttonNamed = (text: string, within: ParentNode = doc) => [...within.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(text))
    const BRANDS = [
      { tenantId: 'vrv-a', brand: '가상스테이' },
      { tenantId: 'vrv-b', brand: '가상여관' },
      { tenantId: 'vrv-c', brand: '가상민박' },
    ]
    const U = (n: number) => `https://fake-rv.tistory.com/${n}`
    const K = (n: number) => `fake-rv.tistory.com/${n}`
    const cand = (tenantId: string, brand: string, articleId: string, body: number) => ({ tenantId, brand, articleId, title: `가상 앱 글 ${articleId}`, body, titleScore: 0.3, writer: null, bankUnknown: false, writerUnknown: false, otherUrls: 0 })
    const readOk = (n: number, over: Record<string, unknown> = {}) => ({
      ok: true,
      url: U(n),
      key: K(n),
      readUrl: U(n),
      recordUrl: U(n),
      recordKey: K(n),
      urlNote: null,
      platform: { key: 'tistory', label: '티스토리' },
      post: { title: `가상 손글 ${n}`, publishedOn: '2026-10-20', dateText: null, dateProblem: null, bodyChars: 800 },
      candidates: [],
      known: [],
      tracked: [],
      ignoredAt: null,
      ownedBrands: [],
      appLedgers: [],
      stateUnknown: [],
      ...over,
    })
    const tracked = (tenantId: string, brand: string, n: number) => ({ tenantId, brand, postId: 'x-abababababab', key: K(n), state: 'live', publishedOn: '2026-10-20', trackedAt: '2026-11-01T00:00:00.000Z' })
    const READS: Record<string, unknown> = {
      // 가상스테이 · 가상여관이 앱 밖 글로 추적 중 — 가상스테이의 앱 글로 옮길 수 있다(후보 1번).
      [U(1)]: readOk(1, {
        candidates: [cand('vrv-a', '가상스테이', 'content:m', 0.6), cand('vrv-c', '가상민박', 'content:n', 0.5)],
        tracked: [tracked('vrv-a', '가상스테이', 1), tracked('vrv-b', '가상여관', 1)],
      }),
      // 읽지 못한 주소(404) — 하나씩 무시한다(D14).
      [U(2)]: { ok: false, url: U(2), key: K(2), error: '없는 글입니다(HTTP 404) — 가상', tracked: [], ignoredAt: null },
      // 가상스테이에서 10-25에 「글을 내림」으로 뺀 주소 — 페이지 날짜(10-20 — 처음 올린 날)로 다시 적으면 걸린다(C9).
      [U(3)]: readOk(3, { candidates: [cand('vrv-a', '가상스테이', 'content:z', 0.05)], ownedBrands: [{ tenantId: 'vrv-a', brand: '가상스테이' }], takenDown: [{ tenantId: 'vrv-a', brand: '가상스테이', on: '2026-10-25' }] }),
      // 발행 현황 안의 패널에서 등록할 맞음 줄.
      [U(21)]: readOk(21, { candidates: [cand('vrv-a', '가상스테이', 'content:q', 0.8)] }),
    }
    let ignoredRows = [{ url: U(19), urls: [U(19)], keys: [K(19)], ignoredAt: '2026-11-08T01:00:00.000Z' }, { url: U(18), urls: [U(18)], keys: [K(18)], ignoredAt: '2026-11-07T01:00:00.000Z' }]
    const panelReply = (a: Asked): Reply => {
      if (a.path === '/api/blog-sources') return { status: 200, body: { sources: [] } }
      if (a.path === '/api/post-import/read') return { status: 200, body: READS[(a.body as { url: string }).url] }
      if (a.path === '/api/post-import/commit') {
        const items = (a.body as { items: { kind?: string; url: string; tenantId?: string; articleId?: string }[] }).items
        return {
          status: 200,
          body: {
            results: items.map((it) =>
              it.kind === 'ignore' ? { kind: 'ignore', url: it.url, status: 'added' } : { kind: 'app', tenantId: it.tenantId, articleId: it.articleId, url: it.url, status: 'added', postId: 'p-rvrvrvrvrv01' },
            ),
            warnings: [],
          },
        }
      }
      if (a.path === '/api/post-import/ignored') return { status: 200, body: { ignored: ignoredRows, max: 5000 } }
      if (a.path === '/api/post-import/unignore') {
        const urls = (a.body as { urls: string[] }).urls
        const before = ignoredRows.length
        ignoredRows = ignoredRows.filter((e) => !e.urls.some((u) => urls.includes(u)))
        return { status: 200, body: { removed: before - ignoredRows.length, ignored: ignoredRows } }
      }
      return { status: 404, body: 'Not Found' }
    }
    reply = panelReply
    await React.act(async () => root.render(React.createElement(PostImportPanel, { today: '2026-11-10', brands: BRANDS, onRegistered: () => {} })))
    await settle()
    await typeInto(doc.getElementById('pi-paste'), [U(1), U(2), U(3)].join('\n'))
    await click(buttonNamed('주소 읽기'))
    await settle(6)
    const rowOf = (n: number) => [...doc.querySelectorAll('.pi-table tbody tr')].find((tr) => tr.querySelector(`a[href="${U(n)}"]`))
    const selectOf = (n: number) => rowOf(n)?.querySelector('select') as HTMLSelectElement | null | undefined
    const dateOf = (n: number) => (rowOf(n)?.querySelector('input[type="date"]') as HTMLInputElement | null | undefined)?.value
    const checkOf = (n: number) => rowOf(n)?.querySelector('input[type="checkbox"]') as HTMLInputElement | null | undefined
    const limitDay = todayKst() > '2026-11-10' ? todayKst() : '2026-11-10'
    ok('검토 (준비) 세 줄을 읽었다 — 추적 중 줄은 앱 밖 글(추적 중) · 페이지 날짜', doc.querySelectorAll('.pi-table tbody tr').length === 3 && selectOf(1)?.value === 'external' && dateOf(1) === '2026-10-20')

    // (가) D12 옮김 날짜 — 옮김을 골라 오늘로 바꾼 날은 옮김이 아닌 일을 고르면 페이지 날짜로 되돌린다(D3: 앱 밖 글을 오늘로 채우지 않는다).
    await pick(selectOf(1), 'vrv-a\ncontent:m')
    const movedDay = dateOf(1)
    await pick(selectOf(1), 'external')
    const backToExternal = dateOf(1)
    await pick(selectOf(1), 'vrv-a\ncontent:m')
    await pick(selectOf(1), 'vrv-c\ncontent:n')
    const backToOtherApp = dateOf(1)
    await pick(selectOf(1), 'vrv-a\ncontent:m')
    await pick(selectOf(1), '')
    const backToNone = dateOf(1)
    ok(
      'D12 검토 반영 — 앱 글로 옮김을 고르면 올린 날은 오늘, 앱 밖 글 · 다른 앱 글 · 앱 글 아님으로 바꾸면 페이지 날짜(10-20)로 되돌린다',
      movedDay === limitDay && backToExternal === '2026-10-20' && backToOtherApp === '2026-10-20' && backToNone === '2026-10-20',
    )
    // (나) 옮겨 등록하면 그 줄의 추적 표시가 「앱 글로 옮겨 쉼」이 된다(다시 읽지 않아도 서버와 같은 상태).
    await pick(selectOf(1), 'vrv-a\ncontent:m')
    if (!checkOf(1)?.checked) await click(checkOf(1))
    await click(buttonNamed('이대로 등록'))
    await settle()
    ok(
      '검토 반영 — 앱 글로 옮겨 등록한 줄은 「앱 밖 글로 추적 중: 가상스테이(앱 글로 옮겨 쉼), 가상여관」(옮긴 브랜드만 쉼)',
      (rowOf(1)?.textContent ?? '').includes('앱 밖 글로 추적 중: 가상스테이(앱 글로 옮겨 쉼), 가상여관') && (rowOf(1)?.textContent ?? '').includes('등록함'),
    )
    // (다) 「읽지 못함」 줄을 무시로 등록하면 그 줄은 「무시함」 — 진행 줄에 「무시」(고르기만 함)로 남지 않고 「다시 읽기」 대상에서 빠진다.
    await pick(selectOf(2), 'ignore')
    if (!checkOf(2)?.checked) await click(checkOf(2))
    const progressText = () => doc.querySelector('.pi-progress')?.textContent ?? ''
    ok('(준비) 읽지 못함 줄은 다시 읽기 대상', (buttonNamed('다시 읽기 —')?.textContent ?? '').includes('(1)'))
    await click(buttonNamed('이대로 등록'))
    await settle()
    ok(
      'D14 검토 반영 — 무시를 마친 「읽지 못함」 줄은 「무시함」(진행 줄에 「무시 1」이 남지 않는다) · 「다시 읽기」 단추가 사라진다',
      (rowOf(2)?.textContent ?? '').includes('무시함') && progressText().includes('무시함 1') && !progressText().includes('무시 1') && buttonNamed('다시 읽기 —') === undefined,
    )
    // (라) C9 — 내린 기록이 있는 브랜드에 페이지 날짜(처음 올린 날)로 다시 적으려 하면 그 줄에 알리고, 등록을 눌러도 보내지 않는다.
    await pick(selectOf(3), 'external')
    ok('C9 검토 반영 — 다시 적을 브랜드에서 그 날 이전에 내린 주소면 줄에 알린다(브랜드 · 내린 날)', (rowOf(3)?.textContent ?? '').includes('가상스테이: 이 브랜드에서 이 주소의 글을 2026-10-25에 내렸다고'))
    const commitsBefore = sentTo('/api/post-import/commit').length
    if (!checkOf(3)?.checked) await click(checkOf(3))
    await click(buttonNamed('이대로 등록'))
    await settle()
    ok('C9 검토 반영 — 그 줄은 등록 요청에 넣지 않고 걸림으로 둔다', sentTo('/api/post-import/commit').length === commitsBefore && (rowOf(3)?.querySelector('[role="alert"]')?.textContent ?? '').includes('내렸다고'))
    // (마) 이름 — 「날짜 모름」 · 추적할 브랜드 무리에 어느 글의 칸인지가 들어 있다.
    ok(
      '검토 반영(접근성) — 「날짜 모름」 체크 · 추적할 브랜드 무리의 이름에 글 제목',
      doc.querySelector('input[aria-label="「가상 손글 3」 날짜 모름"]') !== null && doc.querySelector('fieldset[aria-label="「가상 손글 3」 추적할 브랜드"]') !== null,
    )
    // (바) 되돌리기 — 끝나면 결과 문구로 포커스(키보드 사용자가 맨 위로 돌아가지 않게) · 처리 중에도 단추를 disabled로 바꾸지 않는다.
    await click(buttonNamed('무시한 글 보기 · 되돌리기'))
    const restoreBtn = [...doc.querySelectorAll('.pi-ignored-list li')].find((li) => li.querySelector(`a[href="${U(19)}"]`))?.querySelector('button') as HTMLButtonElement | undefined
    restoreBtn?.focus()
    const focusedBefore = doc.activeElement === restoreBtn
    await click(restoreBtn)
    await settle()
    const active = doc.activeElement
    ok(
      '검토 반영(키보드) — 되돌린 뒤 포커스는 결과 문구(role=status)로 간다(BODY로 사라지지 않는다) · 단추는 disabled를 쓰지 않는다',
      focusedBefore && active !== doc.body && active?.getAttribute('role') === 'status' && (active?.textContent ?? '').includes('무시를 풀었습니다') &&
        [...doc.querySelectorAll('.pi-ignored-list button')].every((b) => !(b as HTMLButtonElement).disabled),
    )
    // (아) 최종 점검 — (다)에서 무시한 「읽지 못함」 줄을 「되돌리기」로 풀면 표의 그 줄도 풀린다(다시 읽기 전에도 「무시함」 · 무시 고름이 남지 않는다).
    // 서버가 (다)의 무시를 목록에 적은 것처럼 둔다(이 가짜 등록은 목록을 바꾸지 않는다).
    ignoredRows = [{ url: U(2), urls: [U(2)], keys: [K(2)], ignoredAt: '2026-11-10T03:00:00.000Z' }, ...ignoredRows]
    await click(buttonNamed('무시한 글 보기 · 되돌리기'))
    await click(buttonNamed('무시한 글 보기 · 되돌리기'))
    const restoreFail = [...doc.querySelectorAll('.pi-ignored-list li')].find((li) => li.querySelector(`a[href="${U(2)}"]`))?.querySelector('button')
    ok('(준비) 무시한 「읽지 못함」 주소가 무시한 글 목록에 있고, 표의 그 줄은 「무시함」', restoreFail !== undefined && (rowOf(2)?.textContent ?? '').includes('무시함') && selectOf(2)?.value === 'ignore')
    await click(restoreFail)
    await settle()
    const row2Text = rowOf(2)?.textContent ?? ''
    ok(
      '최종 점검 — 무시한 「읽지 못함」 줄을 되돌리면 표의 그 줄도 풀린다(「무시함」 · 「…에 무시한 주소」 없음 · 고르기 「—」 · 「읽지 못함」 · 다시 읽기 대상)',
      ignoredRows.every((e) => e.url !== U(2)) && !row2Text.includes('무시함') && !row2Text.includes('무시한 주소') && row2Text.includes('읽지 못함') &&
        selectOf(2)?.value === '' && (buttonNamed('다시 읽기 —')?.textContent ?? '').includes('(1)'),
    )
    await React.act(async () => root.unmount())

    // (사) 발행 현황 「관리」
    const xRow = (n: number, over: Partial<StatusRow> = {}): StatusRow => ({
      rowKey: `vrv-a|x-rvrvrvrvrv${n}`,
      tenantId: 'vrv-a',
      brand: '가상스테이',
      kind: 'posted',
      origin: 'external',
      postId: `x-rvrvrvrvrv${n}`,
      key: K(n),
      articleId: `external:x-rvrvrvrvrv${n}`,
      title: `가상 손글 ${n}`,
      writer: null,
      writerUnknown: null,
      postedUnknown: false,
      platform: { key: 'tistory', label: '티스토리' },
      url: U(n),
      publishedOn: '2026-11-01',
      recheckFrom: '2026-11-05',
      trackedOn: '2026-11-05',
      removed: null,
      naver: null,
      google: null,
      checkFrom: null,
      ...over,
    })
    const appRowOf = (n: number, tenantId: string, brand: string, over: Partial<StatusRow> = {}) =>
      xRow(n, { rowKey: `${tenantId}|p-rvrvrvrvrv${n}`, tenantId, brand, origin: 'app', postId: `p-rvrvrvrvrv${n}`, articleId: 'content:z', title: '가상 앱 글 z', trackedOn: null, recheckFrom: '2026-11-01', ...over })
    const status = {
      today: '2026-11-10',
      brands: BRANDS,
      rows: [
        xRow(20),
        // 20번 주소는 가상여관의 앱 글 · 가상민박의 잘못 적은 앱 글 — 가상여관만 막는다.
        appRowOf(20, 'vrv-b', '가상여관'),
        appRowOf(20, 'vrv-c', '가상민박', { removed: { reason: 'mistake', at: '2026-11-02T00:00:00.000Z' } }),
        // 22번은 「글을 내림」으로 뺀 날짜 모름 줄.
        xRow(22, { publishedOn: null, removed: { reason: 'taken-down', at: '2026-11-08T00:00:00.000Z' } }),
      ],
      writers: [],
      issues: [],
    }
    let commitBody: unknown = { results: [{ kind: 'external', url: U(20), status: 'error', tenants: [{ tenantId: 'vrv-c', brand: '가상민박', status: 'error', error: '가상 — 적지 못했습니다' }] }], warnings: [] }
    reply = (a) => {
      if (a.path === '/api/publish-status') return { status: 200, body: status }
      if (a.path.startsWith('/api/external-posts/')) return { status: 200, body: { post: {}, posts: [] } }
      if (a.path === '/api/post-import/commit') return { status: 200, body: commitBody }
      return panelReply(a)
    }
    root = createRoot(host)
    await React.act(async () => root.render(React.createElement(MemoryRouter, { initialEntries: ['/publish-status'] }, React.createElement(PublishStatusPage))))
    await settle()
    const NAME20 = '가상스테이 「가상 손글 20」 티스토리'
    const summaryOf = (name: string) => doc.querySelector(`summary[aria-label="${name} 앱 밖 글 관리"]`) as HTMLElement | null
    const manage20 = () => summaryOf(NAME20)?.parentElement ?? null
    const brandBox = (brand: string) =>
      ([...(manage20()?.querySelectorAll('.ps-manage-brands label') ?? [])].find((l) => (l.textContent ?? '').startsWith(brand))?.querySelector('input') ?? null) as HTMLInputElement | null
    ok(
      'D13 검토 반영 — 「다른 브랜드에도 추적」은 그 주소를 앱 글로 가진 브랜드를 고를 수 없게 한다(등록 패널과 같은 함수 — 잘못 적은 앱 글 브랜드는 고를 수 있다)',
      brandBox('가상여관')?.disabled === true && (manage20()?.textContent ?? '').includes('가상여관 · 그 브랜드의 앱 글') && brandBox('가상민박')?.disabled === false,
    )
    await click(brandBox('가상민박'))
    await click(buttonNamed('추적 시작', manage20() ?? doc))
    await settle()
    ok('검토 반영 — 추적 결과에 걸린 브랜드가 있으면 오류 모양(role=alert)으로 보인다', (doc.querySelector('p.error[role="alert"]')?.textContent ?? '').includes('걸림 — 가상민박'))
    const dateInput20 = () => manage20()?.querySelector(`input[aria-label="${NAME20} 올린 날"]`) as HTMLInputElement | null
    ok(
      '검토 반영 — 올린 날은 추적을 시작한 날까지(max) · 「모름」 체크에 글 이름',
      dateInput20()?.max === '2026-11-05' && manage20()?.querySelector(`input[aria-label="${NAME20} 올린 날 모름"]`) !== null,
    )
    const patches = () => asked.filter((a) => a.method === 'PATCH').length
    const patchesBefore = patches()
    await typeInto(dateInput20(), '2026-11-07')
    await click(buttonNamed('저장', manage20() ?? doc))
    ok(
      '검토 반영 — 추적을 시작한 날 뒤 날짜는 화면이 막는다(서버 400을 기다리지 않는다 · 안내는 「추적을 시작한 날(…)까지」)',
      patches() === patchesBefore && (manage20()?.querySelector('[role="alert"]')?.textContent ?? '').includes('추적을 시작한 날(2026-11-05)까지'),
    )
    await typeInto(dateInput20(), '2026-11-03')
    await click(buttonNamed('저장', manage20() ?? doc))
    await settle()
    ok(
      '검토 반영(키보드) — 「저장」 뒤 표를 다시 읽어도 포커스는 같은 줄의 「관리」로 돌아온다 · 앞 결과 문구(오류)는 새 결과로 바뀐다',
      patches() === patchesBefore + 1 && doc.activeElement === summaryOf(NAME20) &&
        (doc.querySelector('p.pi-note[role="status"]')?.textContent ?? '').includes('올린 날을 2026-11-03로 고쳤습니다') && doc.querySelector('p.error[role="alert"]') === null,
    )
    // 「주소 한꺼번에 등록」으로 표가 바뀌면 앞선 「관리」 결과 문구는 지운다(지금 상태와 반대로 읽히지 않게).
    commitBody = { results: [{ kind: 'app', tenantId: 'vrv-a', articleId: 'content:q', url: U(21), status: 'added', postId: 'p-rvrvrvrvrv21' }], warnings: [] }
    await typeInto(doc.getElementById('pi-paste'), U(21))
    await click(buttonNamed('주소 읽기'))
    await settle(6)
    await click(buttonNamed('이대로 등록'))
    await settle()
    ok('검토 반영 — 주소를 등록해 표를 다시 읽으면 앞선 「관리」 결과 문구를 지운다', sentTo('/api/post-import/commit').length > 0 && !(doc.body.textContent ?? '').includes('올린 날을 2026-11-03로 고쳤습니다'))
    // 「글을 내림」으로 뺀 날짜 모름 줄도 올린 날을 적을 수 있다(판단 칸 「날짜를 적으면 판단」대로).
    const removedToggle = [...doc.querySelectorAll('label.ps-toggle')].find((l) => (l.textContent ?? '').includes('내린 · 뺀 글'))?.querySelector('input')
    await click(removedToggle)
    const NAME22 = '가상스테이 「가상 손글 22」 티스토리'
    ok('검토 반영 — 「글을 내림」으로 뺀 줄의 「관리」에도 올린 날 칸이 있다', summaryOf(NAME22)?.parentElement?.querySelector(`input[aria-label="${NAME22} 올린 날"]`) !== null)
    await React.act(async () => root.unmount())
  } catch (err) {
    ok(`검토 반영 화면 검사가 예외 없이 끝난다: ${err instanceof Error ? err.stack : String(err)}`, false)
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
