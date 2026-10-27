/**
 * 자사 사이트 주소 더하기 · 빼기(server/ownedDomainsEditor.ts)를 확인한다. 임시 폴더를 APP_DATA_DIR로 쓰고 가짜 브랜드만 만든다. AI는 부르지 않는다.
 *
 * 왜: 등록할 때 넣은 홈페이지 말고 브랜드가 가진 다른 사이트(2026-10-27 군산각의 all-about-gunsan.vercel.app)는 앱에서 더할 수 없어
 * 설정 파일과 판정 기록을 손으로 고쳤다. 자사 인용률은 점수의 20 비중이라, 지난 측정에 적용할 때는 판정 · 점수 · 회차 · 순위가 한꺼번에
 * 맞아야 한다.
 *
 *   npx tsx scripts/verify-owned-domains.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'verify-owned-domains-'))
process.env.APP_DATA_DIR = dir
process.env.BLOB_READ_WRITE_TOKEN = ''
process.env.BLOB_STORE_ID = ''
process.env.USE_MOCK_ENGINES = 'true'

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
const readJson = <T>(rel: string): T => JSON.parse(readFileSync(path.join(dir, rel), 'utf-8')) as T

try {
  const reg = await import('../server/tenantRegistry')
  const editor = await import('../server/ownedDomainsEditor')
  const tracker = await import('../server/measureTracker')
  const { aggregateWeeklyMetrics, ciBounds } = await import('../server/aggregate')
  const { movingAverage4 } = await import('../server/scoring')
  const { contextFingerprint } = await import('../server/pipeline')
  const { cohortRankingEntities } = await import('../server/cohortEntities')
  const { FileResultStore } = await import('../server/store')
  type Analysis = import('../server/types').QuestionRepeatAnalysis
  type Card = import('../src/prompts/b8-report').WeeklyScorecard
  const store = new FileResultStore()

  // 가짜 코호트(펜션 · 가상시): 고객 oa가 경쟁사 ob를 잰다. oc는 다른 고객, oa-national은 oa와 홈페이지가 같은 범위 변형.
  const base = { engines: ['gemini'], questionBankSize: 4, questionBankVersion: 'v1', repeatsPerQuestion: 1, factGraph: [] }
  const line = (name: string, domain: string) => ({ name, aliases: [name], domains: [domain] })
  writeJson('tenants.overlay.json', [
    { ...base, tenantId: 'oa', brandName: '가상 숙소', aliases: ['가상 숙소'], ownedDomains: ['oa.example'], industry: '펜션', region: '가상시', competitors: [line('경쟁 하나', 'ob.example')] },
    { ...base, tenantId: 'ob', brandName: '경쟁 하나', aliases: ['경쟁 하나'], ownedDomains: ['ob.example'], industry: '펜션', region: '가상시', competitors: [], cohortOnly: true },
    { ...base, tenantId: 'oc', brandName: '다른 고객', aliases: ['다른 고객'], ownedDomains: ['oc.example'], industry: '민박', region: '가상시', competitors: [] },
    { ...base, tenantId: 'oa-national', brandName: '가상 숙소', aliases: ['가상 숙소'], ownedDomains: ['oa.example'], industry: '관광안내', region: '국내', marketScope: 'national', competitors: [] },
  ])
  const questions = ['q1', 'q2', 'q3', 'q4'].map((questionId, i) => ({
    questionId, text: questionId, category: i < 3 ? 'category-agnostic' : 'brand-direct', industry: '펜션', region: '가상시', containsBrandName: i === 3, version: 'v1',
  }))
  writeJson('data/oa/question-bank/v1.json', { version: 'v1', generatedAt: '2026-10-01', questions })

  // 판정 레코드 — side.example(더할 주소) 인용이 있는 응답과 없는 응답을 섞는다.
  const cite = (raw: string, ownerType: string) => ({ raw, domain: new URL(raw).hostname, ownerType, supportsBrandMention: true })
  const analysis = (questionId: string, mentioned: boolean, citations: ReturnType<typeof cite>[]): Analysis => ({
    questionId, engine: 'gemini', callIndex: 0, mentioned, mentionSentences: [], competitorMentions: [], shareOfMention: 0,
    citations, topRecommendation: null, brandRank: mentioned ? 2 : null, factualityClaims: [], factualitySupported: 0, factualityContradicted: 0,
    brandOwnedCitation: citations.some((c) => c.ownerType === 'brand-owned'),
  }) as unknown as Analysis
  const weekAnalyses = (n: number): Analysis[] => [
    analysis('q1', true, [cite('https://oa.example/a', 'brand-owned'), cite('https://www.side.example/p/1', 'unknown')]),
    analysis('q2', n > 0, [cite('https://side.example/p/2', 'competitor'), cite('https://news.example/x', 'third-party-authority')]),
    analysis('q3', false, [cite('https://blog.side.example/x', 'unknown')]),
    analysis('q4', true, [cite('https://oa.example/b', 'brand-owned')]),
  ]
  const tenantLike = { competitors: [{ name: '경쟁 하나' }] }
  const cardFor = (weekOf: string, analyses: Analysis[], prior: number[], tenantId = 'oa', brandName = '가상 숙소'): Card => {
    const m = aggregateWeeklyMetrics(tenantLike, questions as never, analyses)
    return {
      tenantId, weekOf, industry: '펜션', region: '가상시', brandName,
      aeoScore: { current: m.score, ma4: Math.round(movingAverage4([...prior, m.score])), previousWeek: prior.at(-1) ?? null, ...ciBounds(m.score, m.ciMargin) },
      mentionRate: m.mentionRate, shareOfMention: m.shareOfMention, shareOfMentionMentions: m.shareOfMentionMentions,
      avgRecommendationRank: m.avgRecommendationRank, rankedResponses: m.rankedResponses, factualityScore: m.factualityScore,
      brandOwnedCitationRate: m.brandOwnedCitationRate, hallucinationFlags: m.hallucinationFlags, enginesUsed: m.enginesUsed,
      questionBankVersion: 'v1', cohortRank: { position: 1, totalTenants: 2, members: [] },
    } as unknown as Card
  }
  const a40 = weekAnalyses(0)
  const a41 = weekAnalyses(1)
  const c40 = cardFor('2026-W40', a40, [])
  const c41 = cardFor('2026-W41', a41, [c40.aeoScore.current])
  // W42는 저장값이 지금 규칙과 다르다(측정 뒤 규칙이 바뀐 주) — 판정만 바꾸고 점수는 그대로 둬야 한다.
  const a42 = weekAnalyses(1)
  const c42 = { ...cardFor('2026-W42', a42, [c40.aeoScore.current, c41.aeoScore.current]) }
  c42.aeoScore = { ...c42.aeoScore, current: c42.aeoScore.current + 7 }
  for (const [w, a, c] of [['2026-W40', a40, c40], ['2026-W41', a41, c41], ['2026-W42', a42, c42]] as const) {
    writeJson(`data/oa/${w}/question-analyses.json`, a)
    writeJson(`data/oa/${w}/scorecard.json`, c)
  }
  writeJson('data/oa/scorecard-history.json', [c40, c41, c42])
  // 경쟁사 ob의 카드(같은 코호트) — 순위를 다시 세면 바뀐다.
  const ob40 = cardFor('2026-W40', [], [], 'ob', '경쟁 하나')
  ob40.aeoScore = { ...ob40.aeoScore, current: c40.aeoScore.current + 1 }
  writeJson('data/ob/2026-W40/scorecard.json', ob40)
  writeJson('data/ob/scorecard-history.json', [ob40])

  // 회차: W41에 지금 설정 지문의 회차 하나와 옛 설정 지문의 회차 하나.
  const runtime0 = await reg.loadRuntimeTenants()
  const oa0 = runtime0.find((t) => t.tenantId === 'oa')!
  const entities = cohortRankingEntities(oa0, runtime0)
  const fpNow = contextFingerprint(oa0, entities)
  const runMeta = (runId: string, fp: string) => ({ runId, tenantId: 'oa', weekOf: '2026-W41', startedAt: '2026-10-08T00:00:00.000Z', finishedAt: `2026-10-08T0${runId.slice(-1)}:00:00.000Z`, selfOnly: false, inCohortRun: false, weekCard: 'saved', engines: {}, engineIssues: [], contextFingerprint: fp })
  for (const [runId, fp] of [['run-1', fpNow], ['run-2', 'oldfingerprint00']] as const) {
    writeJson(`data/oa/2026-W41/runs/${runId}/question-analyses.json`, a41)
    writeJson(`data/oa/2026-W41/runs/${runId}/scorecard.json`, c41)
    writeJson(`data/oa/2026-W41/runs/${runId}/run.json`, runMeta(runId, fp))
  }

  // ── 처음 상태 ──
  const s0 = await editor.describeOwnedDomains('oa')
  ok('처음: 첫 주소 oa.example · 더한 주소 없음 · 고칠 수 있음', s0.primary === 'oa.example' && s0.extra.length === 0 && s0.editable && s0.fixed.join() === 'oa.example')
  ok('경쟁사 측정 브랜드는 404', await rejects(editor.describeOwnedDomains('ob'), 404))
  const web = await editor.describeOwnedDomains('web4ai')
  ok('저장소 설정 브랜드(web4ai)도 고칠 수 있다 — 고정 주소 둘', web.editable && web.fixed.length >= 2 && web.primary === web.fixed[0])

  // ── 받지 않는 주소 ──
  const reject = async (host: string, want: string) => {
    const p = await editor.planOwnedDomains('oa', { extra: [host], applyPast: false }, store)
    return p.errors.some((e) => e.includes(want))
  }
  ok('거절: 공유 플랫폼(blog.naver.com)', await reject('blog.naver.com', '플랫폼'))
  ok('거절: 후기 · 예약 플랫폼(trip.com)', await reject('https://www.trip.com/hotels', '후기'))
  ok('거절: 이미 자사(oa.example의 하위 주소)', await reject('m.oa.example', '이미 자사 주소'))
  ok('거절: 경쟁사 측정 브랜드의 주소', await reject('ob.example', '경쟁 하나'))
  ok('거절: 다른 고객의 주소', await reject('oc.example', '다른 고객'))
  ok('거절: 주소 형식 아님', await reject('없는주소', '형식'))
  ok('형식이 틀린 요청은 400', await rejects(editor.planOwnedDomains('oa', { extra: 'side.example' }, store), 400))

  // ── 지난 측정에도 적용 — 미리보기 ──
  const input = { extra: ['https://www.side.example/about'], applyPast: true }
  const plan = await editor.planOwnedDomains('oa', input, store)
  ok('미리보기: 주소를 호스트로(www · 경로 제거)', plan.extra.join() === 'side.example' && plan.added.join() === 'side.example' && plan.errors.length === 0)
  const promoted40 = a40.flatMap((a) => a.citations).filter((c) => /side\.example$/.test(c.domain ?? '')).length
  ok('미리보기: 바꿀 인용 수(하위 주소 포함, 이미 자사 아닌 것만)', plan.past?.weeks.find((w) => w.weekOf === '2026-W40')?.promoted === promoted40)
  const promote = (list: Analysis[]) => list.map((a) => {
    const citations = a.citations.map((c) => (/(^|\.)side\.example$/.test(c.domain ?? '') ? { ...c, ownerType: 'brand-owned' } : c))
    return { ...a, citations, brandOwnedCitation: citations.some((c) => c.ownerType === 'brand-owned') }
  }) as Analysis[]
  const m40 = aggregateWeeklyMetrics(tenantLike, questions as never, promote(a40))
  const m41 = aggregateWeeklyMetrics(tenantLike, questions as never, promote(a41))
  const w40 = plan.past?.weeks.find((w) => w.weekOf === '2026-W40')
  ok('미리보기: W40 자사 인용률 · 점수가 바뀐 판정으로 센 값', !!w40 && w40.rateAfter === m40.brandOwnedCitationRate && w40.scoreAfter === m40.score && w40.rateAfter > w40.rateBefore)
  ok('미리보기: W41 회차 둘', plan.past?.weeks.find((w) => w.weekOf === '2026-W41')?.runs === 2)
  ok('미리보기: W42는 저장값이 달라 점수 그대로 — 이유를 알림', plan.past?.weeks.find((w) => w.weekOf === '2026-W42')?.scoreAfter === c42.aeoScore.current && plan.past!.skipped.some((s) => s.includes('2026-W42')))

  // ── 저장 막힘 ──
  ok('저장: 미리보기 열쇠가 다르면 409', await rejects(editor.saveOwnedDomains('oa', input, 'wrong', store), 409))
  tracker.beginMeasureRun()
  ok('저장: 측정 중이면 409', await rejects(editor.saveOwnedDomains('oa', input, plan.key, store), 409))
  tracker.endMeasureRun()

  // ── 저장 ──
  const saved = await editor.saveOwnedDomains('oa', input, plan.key, store)
  ok('저장: 더한 주소 파일', readJson<{ extra: string[] }>('data/oa/owned-domains.json').extra.join() === 'side.example')
  const runtime1 = await reg.loadRuntimeTenants()
  const oa1 = runtime1.find((t) => t.tenantId === 'oa')!
  ok('런타임: 첫 주소 뒤에 더한 주소', oa1.ownedDomains.join() === 'oa.example,side.example')
  const after40 = readJson<Analysis[]>('data/oa/2026-W40/question-analyses.json')
  ok('판정: 더한 주소 인용이 자사로(경쟁사로 잘못 판정된 것 포함)', after40.flatMap((a) => a.citations).filter((c) => /side\.example$/.test(c.domain ?? '')).every((c) => c.ownerType === 'brand-owned'))
  ok('판정: 다른 인용은 그대로', after40.flatMap((a) => a.citations).filter((c) => c.domain === 'news.example').every((c) => c.ownerType === 'third-party-authority'))
  ok('판정: brandOwnedCitation 다시 계산', after40.find((a) => a.questionId === 'q3')?.brandOwnedCitation === true)
  const k40 = readJson<Card>('data/oa/2026-W40/scorecard.json')
  const k41 = readJson<Card>('data/oa/2026-W41/scorecard.json')
  const k42 = readJson<Card>('data/oa/2026-W42/scorecard.json')
  ok('카드: W40 점수 · CI · 자사 인용률', k40.aeoScore.current === m40.score && k40.brandOwnedCitationRate === m40.brandOwnedCitationRate && k40.aeoScore.ciHigh === ciBounds(m40.score, m40.ciMargin).ciHigh)
  ok('카드: W41 전주 = 고친 W40 점수, 4주 평균도', k41.aeoScore.previousWeek === m40.score && k41.aeoScore.ma4 === Math.round(movingAverage4([m40.score, m41.score])))
  ok('카드: W42 점수는 그대로, 전주 · 4주 평균은 고친 앞 주로', k42.aeoScore.current === c42.aeoScore.current && k42.aeoScore.previousWeek === m41.score)
  const hist = readJson<Card[]>('data/oa/scorecard-history.json')
  ok('히스토리: 주차 카드와 같다', hist.find((h) => h.weekOf === '2026-W40')?.aeoScore.current === m40.score)
  const run1 = readJson<{ contextFingerprint: string }>('data/oa/2026-W41/runs/run-1/run.json')
  const run2 = readJson<{ contextFingerprint: string }>('data/oa/2026-W41/runs/run-2/run.json')
  const fpAfter = contextFingerprint(oa1, cohortRankingEntities(oa1, runtime1))
  ok('회차: 지금 설정 지문의 회차는 새 지문(다음 측정과 이어진다)', run1.contextFingerprint === fpAfter && fpAfter !== fpNow)
  ok('회차: 옛 설정 지문의 회차는 그대로', run2.contextFingerprint === 'oldfingerprint00')
  ok('회차: 카드 · 판정도 고침', readJson<Card>('data/oa/2026-W41/runs/run-2/scorecard.json').aeoScore.current === m41.score)
  const { runs } = await store.listRunSnapshots('oa', '2026-W41')
  ok('회차 캐시: 다시 읽으면 새 값', runs.every((r) => r.scorecard.aeoScore.current === m41.score))
  const ob40After = readJson<Card>('data/ob/2026-W40/scorecard.json')
  ok('순위: 같은 코호트 경쟁사 카드도 다시 셈', saved.applied!.ranksUpdated > 0 && JSON.stringify(ob40After.cohortRank) !== JSON.stringify(ob40.cohortRank))
  const backups = readdirSync(path.join(dir, 'data/oa')).filter((d) => d.startsWith('before-owned-domains-'))
  ok('백업: 바꾸기 전 판정 · 카드 · 회차 · 경쟁사 카드', backups.length === 1 &&
    readJson<Analysis[]>(`data/oa/${backups[0]}/2026-W40/question-analyses.json`)[0]!.citations[1]!.ownerType === 'unknown' &&
    existsSync(path.join(dir, `data/oa/${backups[0]}/2026-W41/runs/run-1/run.json`)) &&
    existsSync(path.join(dir, `data/oa/${backups[0]}/_cohort/ob/2026-W40/scorecard.json`)))
  ok('같은 값으로 다시 계획하면 바뀐 것 없음', (await editor.planOwnedDomains('oa', { extra: ['side.example'], applyPast: true }, store)).unchanged)

  // ── 범위 변형은 같은 곳 — 같은 주소를 더할 수 있다 ──
  ok('범위 변형(oa-national)은 oa가 더한 주소를 받는다', (await editor.planOwnedDomains('oa-national', { extra: ['side.example'], applyPast: false }, store)).errors.length === 0)
  ok('다른 고객(oc)은 oa가 더한 주소를 못 받는다', (await editor.planOwnedDomains('oc', { extra: ['side.example'], applyPast: false }, store)).errors.some((e) => e.includes('가상 숙소')))

  // ── 지난 측정에 적용하지 않고 더하기 ──
  const p2 = await editor.planOwnedDomains('oa', { extra: ['side.example', 'third.example'], applyPast: false }, store)
  ok('적용 안 함: 미리보기 없음 · 점수가 뛸 수 있다고 알림', p2.past === null && p2.notes.some((n) => n.includes('다음 측정')))
  const before41 = readFileSync(path.join(dir, 'data/oa/2026-W41/scorecard.json'), 'utf-8')
  await editor.saveOwnedDomains('oa', { extra: ['side.example', 'third.example'], applyPast: false }, p2.key, store)
  ok('적용 안 함: 지난 카드 그대로', readFileSync(path.join(dir, 'data/oa/2026-W41/scorecard.json'), 'utf-8') === before41)

  // ── 빼기 — 다음 측정부터 ──
  const p3 = await editor.planOwnedDomains('oa', { extra: ['third.example'], applyPast: true }, store)
  ok('빼기: 뺀 주소 · 지난 기록 그대로라고 알림 · 미리보기 없음', p3.removed.join() === 'side.example' && p3.past === null && p3.notes.some((n) => n.includes('지난 기록은 그대로')))
  await editor.saveOwnedDomains('oa', { extra: ['third.example'], applyPast: true }, p3.key, store)
  ok('빼기: 런타임에서 빠짐', (await reg.loadRuntimeTenants()).find((t) => t.tenantId === 'oa')!.ownedDomains.join() === 'oa.example,third.example')
  ok('빼기: 지난 판정은 그대로(자사)', readJson<Analysis[]>('data/oa/2026-W40/question-analyses.json').flatMap((a) => a.citations).filter((c) => /side\.example$/.test(c.domain ?? '')).every((c) => c.ownerType === 'brand-owned'))

  // ── 대기열에 있으면 막는다 ──
  writeJson('measure-requests.json', [{ tenant: oa1, requestedAt: '2026-10-27T00:00:00.000Z' }])
  ok('측정 대기열에 있으면 오류', (await editor.planOwnedDomains('oa', { extra: [], applyPast: false }, store)).errors.some((e) => e.includes('대기열')))
  writeJson('measure-requests.json', [])

  // ── 검토 반영 ──
  // or: 고정 주소가 하위 주소(shop.or-brand.example)이고, 설정이 대문자 · 경로째 적혀 있다. W40은 회차에만 runonly.example 인용이 있다.
  const overlay = readJson<unknown[]>('tenants.overlay.json')
  overlay.push({ ...base, tenantId: 'or', brandName: '하위 숙소', aliases: ['하위 숙소'], ownedDomains: ['https://Shop.OR-Brand.example/'], industry: '캠핑', region: '가상시', competitors: [] })
  writeJson('tenants.overlay.json', overlay)
  writeJson('data/or/question-bank/v1.json', { version: 'v1', generatedAt: '2026-10-01', questions })
  const plain = weekAnalyses(0).map((a) => ({ ...a, citations: a.citations.filter((c) => !/side\.example$/.test(c.domain ?? '')) })) as Analysis[]
  const withRunOnly = plain.map((a, i) => (i === 0 ? { ...a, citations: [...a.citations, cite('https://runonly.example/p', 'unknown')] } : a)) as Analysis[]
  const or40 = cardFor('2026-W40', plain, [], 'or', '하위 숙소')
  writeJson('data/or/2026-W40/question-analyses.json', plain)
  writeJson('data/or/2026-W40/scorecard.json', or40)
  writeJson('data/or/scorecard-history.json', [or40])
  const rtOr = await reg.loadRuntimeTenants()
  const orT = rtOr.find((t) => t.tenantId === 'or')!
  const orEntities = cohortRankingEntities(orT, rtOr)
  writeJson('data/or/2026-W40/runs/r1/question-analyses.json', withRunOnly)
  writeJson('data/or/2026-W40/runs/r1/scorecard.json', cardFor('2026-W40', withRunOnly, [], 'or', '하위 숙소'))
  writeJson('data/or/2026-W40/runs/r1/run.json', { ...runMeta('r1', contextFingerprint(orT, orEntities)), tenantId: 'or', weekOf: '2026-W40' })

  const planFor = (id: string, extra: string[], applyPast = false) => editor.planOwnedDomains(id, { extra, applyPast }, store)
  ok('거절: 플랫폼 바탕 주소(vercel.app)', (await planFor('or', ['vercel.app'])).errors.some((e) => e.includes('플랫폼')))
  ok('받음: 플랫폼 아래 내 사이트(my-site.vercel.app)', (await planFor('or', ['my-site.vercel.app'])).errors.length === 0)
  ok('거절: 접미사(co.kr)', (await planFor('or', ['co.kr'])).errors.some((e) => e.includes('접미사')))
  ok('거절: 고정 주소의 상위 주소(or-brand.example)', (await planFor('or', ['or-brand.example'])).errors.some((e) => e.includes('상위 주소')))
  const idn = await planFor('or', ['https://군산각.kr/'])
  ok('한글 도메인은 퓨니코드로 받는다', idn.errors.length === 0 && idn.extra[0]!.startsWith('xn--'))
  ok('끝 점은 뗀다', (await planFor('or', ['example-site.com.'])).extra.join() === 'example-site.com')

  const pr = await planFor('or', ['runonly.example'], true)
  ok('회차에만 있는 인용도 미리보기에 센다', pr.past?.promoted === 0 && pr.past?.runPromoted === 1 && pr.past?.weeks.some((w) => w.weekOf === '2026-W40' && w.runPromoted === 1))
  await editor.saveOwnedDomains('or', { extra: ['runonly.example'], applyPast: true }, pr.key, store)
  const rtOr2 = await reg.loadRuntimeTenants()
  const orT2 = rtOr2.find((t) => t.tenantId === 'or')!
  const fpOr2 = contextFingerprint(orT2, cohortRankingEntities(orT2, rtOr2))
  ok('설정이 대문자 · 경로째여도 바꾼 회차 지문 = 다음 측정 지문', readJson<{ contextFingerprint: string }>('data/or/2026-W40/runs/r1/run.json').contextFingerprint === fpOr2)
  const pr2 = await planFor('or', ['another.example'], true)
  await editor.saveOwnedDomains('or', { extra: ['another.example'], applyPast: true }, pr2.key, store)
  ok('빼기와 더하기를 함께 하면 회차 지문은 그대로(끊김 표시 유지)', readJson<{ contextFingerprint: string }>('data/or/2026-W40/runs/r1/run.json').contextFingerprint === fpOr2)

  // 더한 주소가 나중에 설정에도 들어간 경우 — 고정 주소로 보이고, 뺄 수 있는 목록에는 없다.
  writeJson('data/oc/owned-domains.json', { extra: ['oc.example', 'oc-old.example'], updatedAt: '2026-10-27' })
  const oc = await editor.describeOwnedDomains('oc')
  ok('설정에도 있는 더한 주소는 고정으로', oc.fixed.join() === 'oc.example' && oc.extra.join() === 'oc-old.example')
  ok('설정 주소만(더한 주소 빼고) — 범위 변형 등록이 옮겨 적는 값', (await reg.configuredOwnedDomains('oc')).join() === 'oc.example')
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
