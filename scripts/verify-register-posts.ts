/**
 * 올린 주소 일괄 등록(scripts/register-posts.ts)을 확인한다. 파일은 임시 폴더의 가짜 브랜드에만 쓰고(스크립트는 하위 프로세스로도
 * 돌린다), 서버 · AI는 띄우지 않는다. 브랜드 · 작성자 · 주소는 모두 가짜다.
 *
 * 왜: 작성자 8명이 보낸 주소 160개를 한 번에 적는다. 한 줄이라도 다른 글 · 다른 작성자 · 블로그 홈 주소로 적히면 성과 표가 엉뚱한
 * 글의 인용을 세고, 기록 모양이 「올렸어요」와 다르면(자사 줄 · 사람이 고른 날 · 질문 스냅샷 · 「집행함」) 화면이 그 글을 올린 글로
 * 보지 못한다. 걸린 줄이 하나라도 있으면 아무것도 쓰지 않아야 하고, dry-run은 실제 데이터에 손대지 않아야 한다.
 *
 *   npx tsx scripts/verify-register-posts.ts
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { StoredDraft } from '../src/lib/api'

const tmp = mkdtempSync(path.join(tmpdir(), 'verify-register-posts-'))
const appRoot = path.join(tmp, 'app')
// 서버 모듈은 불러올 때 데이터 폴더를 정한다 — 불러오기 전에 둔다.
process.env.APP_DATA_DIR = appRoot

const checks: [string, boolean, string | undefined][] = []
/** detail은 실패했을 때만 찍는다(하위 프로세스 출력 등). */
const ok = (label: string, cond: boolean, detail?: string) => checks.push([label, cond, detail])

// ── 가짜 브랜드 「가상머뭄」(질문지 v9) · 작성자 2명 ───────────────────────────
const TENANT = 'fake-register'
const TEXT: Record<string, string> = {
  'c1-001': '가상시 원도심 걸어 다니기 좋은 숙소 어디야?',
  'c1-002': '가상시 기차역에서 가까운 조용한 숙소 추천해줘',
  'c1-003': '가상시 숙소 주차 편한 곳 후기 어디서 봐?',
  'c1-004': '가상시 독채 숙소 특징이 어때?',
}
const W1 = { key: 'w1', name: '가상 작성자 하나' }
const W2 = { key: 'w2', name: '가상 작성자 둘' }
const art = (ids: string[], name: string, writer: { key: string; name: string }, blog: string) => ({
  id: `topic:${[...ids].sort().join('+')}`,
  name,
  angle: `${name} — 천천히 둘러보는 하루`,
  writer,
  blog,
  questionIds: [...ids].sort(),
  questionTexts: [...ids].sort().map((id) => TEXT[id]!),
})
const A1 = art(['c1-001', 'c1-002'], '원도심 걸어서 다니는 숙소', W1, 'https://w1.example.com')
const A2 = art(['c1-003', 'c1-004'], '주차 편한 독채 숙소', W1, 'https://w1.example.com')
const B1 = art(['c1-002', 'c1-003'], '역 가까운 주차 편한 숙소', W2, '')
const planFile = { format: 'probe-plan/2', tenantId: TENANT, bankVersion: 'v9', activeUntil: '2027-03-31', source: { writers: 'docs/writers.json', seed: 7 }, articles: [A1, A2, B1] }

const draftOf = (actionId: string, title: string): StoredDraft => ({
  actionId,
  generatedAt: '2026-10-28T09:00:00.000Z',
  draft: {
    format: 'article',
    title,
    lead: `${title}에 바로 답합니다.`,
    sections: [{ heading: '무엇부터 보나요?', answers: 'c1-001', blocks: [{ kind: 'text', role: 'key', body: '목적지에 가까운 곳이 편합니다.' }] }],
    gapCount: 0,
    usedFacts: [],
  },
})
// A2는 초안이 없다(작성자에게 주지 않은 글).
const drafts = { [A1.id]: draftOf(A1.id, '원도심 숙소 고르는 기준'), [B1.id]: draftOf(B1.id, '역 앞 숙소 주차 안내') }
// 추가 글 목록에는 A1만 있다 — 만들 때의 판(v8)이 배정 판과 다르다. B1은 배정 파일의 스냅샷을 쓴다.
const extrasFile = {
  version: 1,
  articles: [{ id: A1.id, name: A1.name, angle: A1.angle, bankVersion: 'v8', questionIds: A1.questionIds, questionTexts: A1.questionTexts, createdAt: '2026-10-27T00:00:00.000Z', updatedAt: '2026-10-27T00:00:00.000Z' }],
}
const OTHER_URL = 'https://other.example.com/posts/12'
const A1_OLD_URL = 'https://w1.example.com/entry/old'
const ledgerFile = {
  version: 1,
  keyRule: 3,
  posts: [
    { id: 'p-other', url: OTHER_URL, key: 'other.example.com/posts/12', publishedOn: '2026-10-20', publishedOnSource: 'user', recordedAt: '2026-10-20T01:00:00.000Z', articleId: 'content:c1-099', targetActionId: 'content:c1-099', via: 'own', articleTitle: '다른 글' },
    { id: 'p-a1old', url: A1_OLD_URL, key: 'w1.example.com/entry/old', publishedOn: '2026-10-29', publishedOnSource: 'user', recordedAt: '2026-10-29T01:00:00.000Z', articleId: A1.id, targetActionId: A1.id, via: 'own', articleTitle: '원도심 숙소 고르는 기준' },
  ],
}
// 집행 상태 파일에만 있던 옛 주소(B1 자사 줄) — 앱이 다시 적을 때 옮긴다.
const LEGACY_URL = 'https://w2.example.com/old/3'
const statesFile = { 'content:c1-099': { status: 'done', updatedAt: '2026-10-20T01:00:00.000Z' } }

const put = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2))
  return file
}
function seed(root: string) {
  const dir = path.join(root, 'data', TENANT)
  put(path.join(dir, 'probe-plan.json'), planFile)
  put(path.join(dir, 'drafts.json'), drafts)
  put(path.join(dir, 'extra-articles.json'), extrasFile)
  put(path.join(dir, 'published-posts.json'), ledgerFile)
  put(path.join(dir, 'action-states.json'), statesFile)
  return dir
}

/** 폴더 안 모든 파일의 상대 경로 → 내용 지문. 아무것도 안 썼는지 볼 때 쓴다. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else out[path.relative(root, full)] = createHash('sha1').update(readFileSync(full)).digest('hex')
    }
  }
  walk(root)
  return out
}
const sameSnapshot = (a: Record<string, string>, b: Record<string, string>) => JSON.stringify(a) === JSON.stringify(b)

/** 설치본 앱이 켜져 있는지 — 스크립트의 --write는 그때 멈춘다(같은 tasklist 확인). */
function appRunning(): boolean {
  const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Web4AI Brand AEO.exe', '/NH', '/FO', 'CSV'], { encoding: 'utf8' })
  return /^"Web4AI Brand AEO\.exe","\d+"/im.test(out)
}

try {
  const tenantDir = seed(appRoot)
  const reg = await import('./register-posts')
  const { parseWriterPlan } = await import('../src/lib/probePlan')
  const { addPublishedPost, readPublishedPosts } = await import('../server/publishedPosts')
  const { readActionStates } = await import('../server/actionStates')
  const { todayKst } = await import('../src/lib/publishedUrl')
  const plan = parseWriterPlan(planFile).plan!
  ok('가짜 배정 파일이 앱 검사를 통과함(probe-plan/2)', Boolean(plan))
  const { normalizeExtraArticles } = await import('../src/lib/extraArticles')
  const extras = normalizeExtraArticles(extrasFile)
  const today = todayKst()

  // ── 1. CSV 읽기 ─────────────────────────────────────────────────────────────
  const csv = reg.parseRegisterCsv(
    '﻿작성자,글,주소,올린 날\r\n' +
      `w1,${A1.id},https://w1.example.com/entry/1,2026-10-30\r\n` +
      '\r\n' +
      `"${W2.name}","${B1.name}","https://w2.example.com/a?x=1,2",2026.10.31,,\r\n` +
      'w1,짧은 줄\n',
  )
  ok('CSV — BOM · 머리글 · 빈 줄을 건너뛰고 4칸 줄을 읽음', csv.rows.length === 2 && csv.rows[0]!.writer === 'w1' && csv.rows[0]!.line === 2, JSON.stringify(csv))
  ok('CSV — 따옴표 칸 안의 쉼표 · 뒤의 빈 칸 허용', csv.rows[1]!.url === 'https://w2.example.com/a?x=1,2' && csv.rows[1]!.postedOn === '2026.10.31' && csv.rows[1]!.line === 4, JSON.stringify(csv.rows[1]))
  ok('CSV — 칸 수가 틀린 줄은 줄 번호로 알림', csv.errors.length === 1 && csv.errors[0]!.startsWith('5행: 칸이 2개'), JSON.stringify(csv.errors))
  ok('CSV — 머리글이 없으면 첫 줄부터', reg.parseRegisterCsv(`w1,${A1.id},https://w1.example.com/entry/1,2026-10-30`).rows.length === 1)
  ok('올린 날 — 점 · 빗금 표기를 받고 없는 날은 거절', reg.normalizeDay('2026.11.2') === '2026-11-02' && reg.normalizeDay('2026/10/05') === '2026-10-05' && reg.normalizeDay('2026-02-30') === null && reg.normalizeDay('11/02') === null)

  // ── 2. 계획 ─────────────────────────────────────────────────────────────────
  const posts = await readPublishedPosts(TENANT)
  const row = (line: number, writer: string, article: string, url: string, postedOn = '2026-10-30') => ({ line, writer, article, url, postedOn })
  const planOf = (rows: ReturnType<typeof row>[], over: Partial<Parameters<typeof reg.planRegistration>[0]> = {}) =>
    reg.planRegistration({ plan, drafts, extras, posts, rows, today, ...over })
  const good = planOf([row(2, 'w1', A1.id, 'https://w1.example.com/entry/1'), row(3, W2.name, B1.name, 'https://w2.example.com/posts/7', '2026.10.31')])
  ok('계획 — 글 id · 주제 이름, 작성자 키 · 이름으로 찾아 두 줄 더함', good.errors.length === 0 && good.items.length === 2 && good.items[1]!.article.id === B1.id, JSON.stringify(good))
  const [i1, i2] = good.items
  ok(
    '계획 — 「올렸어요」와 같은 기록: 자사 줄 · 글 = 대상 · 사람이 고른 날 · 「집행함」 · 초안 제목 · 초안 판',
    i1!.input.via === 'own' &&
      i1!.input.articleId === A1.id &&
      i1!.input.targetActionId === A1.id &&
      i1!.input.publishedOn === '2026-10-30' &&
      i1!.input.publishedOnChosen === true &&
      i1!.input.markDone === true &&
      i1!.input.articleTitle === '원도심 숙소 고르는 기준' &&
      i1!.input.draftGeneratedAt === '2026-10-28T09:00:00.000Z' &&
      i2!.input.publishedOn === '2026-10-31',
    JSON.stringify(good.items),
  )
  ok('계획 — 질문 스냅샷은 추가 글 정의의 것(만들 때 판 v8)', JSON.stringify(i1!.input.topic) === JSON.stringify({ bankVersion: 'v8', questionIds: A1.questionIds, questionTexts: A1.questionTexts }))
  ok('계획 — 추가 글 목록에 없으면 배정 파일의 스냅샷(판 v9)', JSON.stringify(i2!.input.topic) === JSON.stringify({ bankVersion: 'v9', questionIds: B1.questionIds, questionTexts: B1.questionTexts }))
  ok('계획 — 같은 글에 이미 다른 주소가 있으면 알리고 더함', good.warnings.some((w) => w.startsWith('2행:') && w.includes('이미 다른 주소')), JSON.stringify(good.warnings))

  const errorOf = (r: ReturnType<typeof row>, over: Partial<Parameters<typeof reg.planRegistration>[0]> = {}) => {
    const p = planOf([r], over)
    return p.items.length === 0 && p.errors.length === 1 ? p.errors[0]! : `(걸리지 않음) ${JSON.stringify(p)}`
  }
  const cases: [string, string, string][] = [
    ['배정 글이 아니면 거절', errorOf(row(2, 'w1', '없는 글 이름', 'https://w1.example.com/entry/1')), '배정 글이 아닙니다'],
    ['다른 작성자의 글이면 거절', errorOf(row(2, 'w2', A1.id, 'https://w1.example.com/entry/1')), `w1 · ${W1.name}의 글입니다`],
    ['블로그 첫 화면 주소는 거절(isArticleUrl)', errorOf(row(2, 'w1', A1.id, 'https://w1.example.com/')), '사이트 첫 화면 주소입니다'],
    ['네이버 블로그 홈 주소는 거절', errorOf(row(2, 'w1', A1.id, 'https://blog.naver.com/fakewriter')), '블로그 홈 주소입니다'],
    ['글쓰기 화면 주소는 거절', errorOf(row(2, 'w1', A1.id, 'https://fakewriter.tistory.com/manage/newpost')), '관리 화면 주소입니다'],
    ['단축 주소는 거절', errorOf(row(2, 'w1', A1.id, 'https://bit.ly/abc123')), '단축 주소입니다'],
    ['http(s)가 아니면 거절', errorOf(row(2, 'w1', A1.id, 'w1.example.com/entry/1')), 'http(s)로 시작하는'],
    ['날짜가 아니면 거절', errorOf(row(2, 'w1', A1.id, 'https://w1.example.com/entry/1', '10월 30일')), 'YYYY-MM-DD 날짜가 아닙니다'],
    ['오늘 뒤의 날은 거절', errorOf(row(2, 'w1', A1.id, 'https://w1.example.com/entry/1', '2999-01-01')), '오늘'],
    ['초안이 없는 글은 거절', errorOf(row(2, 'w1', A2.name, 'https://w1.example.com/entry/2')), '초안이 없습니다'],
    ['다른 글의 주소면 거절', errorOf(row(2, 'w1', A1.id, `${OTHER_URL}?utm_source=x`)), '이미 다른 글 「다른 글」'],
  ]
  for (const [label, got, want] of cases) ok(`계획 — ${label}`, got.includes(want), got)
  const twice = planOf([row(2, 'w1', A1.id, 'https://w1.example.com/entry/1'), row(3, 'w2', B1.id, 'https://W1.example.com/entry/1/')])
  ok('계획 — 같은 주소(추적 키)가 CSV에 두 번이면 뒤 줄을 거절', twice.errors.length === 1 && twice.errors[0]!.includes('같은 주소가 2행에도'), JSON.stringify(twice))
  const already = planOf([row(2, 'w1', A1.id, A1_OLD_URL, '2026-10-30')])
  ok('계획 — 이 글 자사 줄에 이미 적힌 주소는 건너뜀(날짜가 다르면 앱에서 고치라고)', already.items.length === 0 && already.errors.length === 0 && already.skipped.length === 1 && already.skipped[0]!.includes('앱에서 고쳐'), JSON.stringify(already))
  const channelPosts = [...posts, { ...posts[1]!, id: 'p-chan', url: 'https://w1.example.com/entry/9', key: 'w1.example.com/entry/9', targetActionId: 'channel:tistory', via: 'channel' as const }]
  const viaChannel = planOf([row(2, 'w1', A1.id, 'https://w1.example.com/entry/9')], { posts: channelPosts })
  ok('계획 — 같은 글의 채널 줄에만 있는 주소는 자사 줄에 더함(앱과 같다)', viaChannel.items.length === 1 && viaChannel.warnings.some((w) => w.includes('채널 줄')), JSON.stringify(viaChannel))
  const legacyPosts = [...posts, { id: 'legacy-1', url: LEGACY_URL, key: 'w2.example.com/old/3', publishedOn: null, publishedOnSource: 'legacy' as const, recordedAt: '2026-09-01T00:00:00.000Z', articleId: B1.id, targetActionId: B1.id, via: 'direct' as const, legacy: true as const }]
  ok('계획 — 예전 방식(집행 상태)에만 있는 이 글 주소는 앱에 맡김', errorOf(row(2, 'w2', B1.id, LEGACY_URL), { posts: legacyPosts }).includes('예전 방식'))
  const removedPlan = planOf([row(2, 'w2', B1.id, 'https://w2.example.com/posts/7')], { extras: [{ ...extras[0]!, id: B1.id, questionIds: B1.questionIds, questionTexts: B1.questionTexts, removedAt: '2026-10-30T00:00:00.000Z' }] })
  ok('계획 — 추가 글 목록에서 뺀 글이면 알리고 더함', removedPlan.items.length === 1 && removedPlan.warnings.some((w) => w.includes('뺀 글')), JSON.stringify(removedPlan))

  // ── 3. 쓰기 · 확인(임시 폴더, 앱과 같은 저장 코드) ──────────────────────────
  const statesBefore = readFileSync(path.join(tenantDir, 'action-states.json'), 'utf8')
  const backupDir = await reg.backupLedger(tenantDir, new Date('2026-11-02T10:00:00.000Z'))
  ok(
    '백업 — before-register-<시각>/에 원장 · 집행 상태 두 파일',
    path.basename(backupDir) === 'before-register-2026-11-02T10-00-00-000Z' &&
      readFileSync(path.join(backupDir, 'published-posts.json'), 'utf8') === readFileSync(path.join(tenantDir, 'published-posts.json'), 'utf8') &&
      readFileSync(path.join(backupDir, 'action-states.json'), 'utf8') === statesBefore,
  )
  let backupTwice = ''
  await reg.backupLedger(tenantDir, new Date('2026-11-02T10:00:00.000Z')).catch((err: unknown) => {
    backupTwice = err instanceof Error ? err.message : String(err)
  })
  ok('백업 — 같은 시각 백업이 있으면 덮지 않고 멈춤', backupTwice.includes('있는 백업을 덮지 않음'), backupTwice)
  const done = await reg.registerPosts(TENANT, good.items, addPublishedPost)
  const after = await readPublishedPosts(TENANT)
  const states = await readActionStates(TENANT)
  ok('쓰기 — 두 줄을 더함', done.error === null && done.added.length === 2, JSON.stringify(done))
  ok('확인 — 원래 기록 그대로 · 새 기록 계획대로 · 두 글 「집행함」', reg.checkRegistration({ before: posts, after, items: good.items, states }).length === 0)
  const saved = after.find((p) => p.articleId === A1.id && p.url === 'https://w1.example.com/entry/1')
  ok(
    '쓰기 — 원장 기록 모양이 「올렸어요」와 같음(자사 · 사람이 고른 날 · 스냅샷 · 제목 · 초안 판)',
    Boolean(saved) &&
      saved!.via === 'own' &&
      saved!.targetActionId === A1.id &&
      saved!.publishedOnSource === 'user' &&
      saved!.key === 'w1.example.com/entry/1' &&
      saved!.topic?.bankVersion === 'v8' &&
      saved!.articleTitle === '원도심 숙소 고르는 기준' &&
      saved!.draftGeneratedAt === '2026-10-28T09:00:00.000Z' &&
      states[A1.id]?.status === 'done' &&
      states[B1.id]?.status === 'done' &&
      states['content:c1-099']?.status === 'done',
    JSON.stringify(saved),
  )
  const tampered = after.map((p) => (p.id === 'p-other' ? { ...p, publishedOn: '2026-10-21' } : p))
  ok('확인 — 원래 기록이 바뀌면 잡음', reg.checkRegistration({ before: posts, after: tampered, items: good.items, states }).some((p) => p.includes('원래 기록이 바뀌었습니다')))
  ok('확인 — 「집행함」이 아니면 잡음', reg.checkRegistration({ before: posts, after, items: good.items, states: {} }).some((p) => p.includes('「집행함」이 아닙니다')))
  const rerun = reg.planRegistration({ plan, drafts, extras, posts: after, rows: [row(2, 'w1', A1.id, 'https://w1.example.com/entry/1'), row(3, W2.name, B1.name, 'https://w2.example.com/posts/7', '2026.10.31')], today })
  ok('다시 돌리면 — 두 줄 모두 건너뜀(같은 결과)', rerun.items.length === 0 && rerun.errors.length === 0 && rerun.skipped.length === 2, JSON.stringify(rerun))
  // 계획과 쓰기 사이에 앱이 같은 주소를 다른 글에 적었다면 — 첫 실패에서 멈추고 그때까지 더한 수를 돌려준다.
  const raced = reg.planRegistration({ plan, drafts, extras, posts: after, rows: [row(2, 'w2', B1.id, 'https://w2.example.com/posts/8'), row(3, 'w1', A1.id, 'https://w1.example.com/entry/5')], today })
  await addPublishedPost(TENANT, { url: 'https://w1.example.com/entry/5', articleId: 'content:c1-099', targetActionId: 'content:c1-099', via: 'own' })
  const partial = await reg.registerPosts(TENANT, raced.items, addPublishedPost)
  ok('쓰기 — 중간에 거절되면 멈추고 더한 수 · 줄 번호를 알림', partial.added.length === 1 && partial.error !== null && partial.error.startsWith('3행:') && partial.error.includes('다른 글'), JSON.stringify(partial))

  // ── 4. 스크립트(하위 프로세스) ─────────────────────────────────────────────
  const scriptRoot = path.join(tmp, 'script-app')
  seed(scriptRoot)
  const profile = path.join(tmp, 'profile')
  mkdirSync(path.join(profile, 'Local', 'Packages'), { recursive: true })
  mkdirSync(path.join(profile, 'Roaming'), { recursive: true })
  const csvGood = path.join(tmp, 'good.csv')
  writeFileSync(csvGood, `작성자,글,주소,올린 날\nw1,${A1.id},https://w1.example.com/entry/1,2026-10-30\n${W2.name},${B1.name},https://w2.example.com/posts/7,2026-10-31\n`)
  const csvBad = path.join(tmp, 'bad.csv')
  writeFileSync(csvBad, `w1,${A1.id},https://w1.example.com/entry/1,2026-10-30\nw1,${A1.id},https://w1.example.com/,2026-10-30\n`)
  const tsxCli = path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs')
  const run = (root: string, csvFile: string, ...extra: string[]) =>
    spawnSync(process.execPath, [tsxCli, 'scripts/register-posts.ts', TENANT, '--csv', csvFile, '--app-data', root, ...extra], {
      encoding: 'utf8',
      env: { ...process.env, APP_DATA_DIR: '', APPDATA: path.join(profile, 'Roaming'), LOCALAPPDATA: path.join(profile, 'Local') },
    })
  const repoTenant = path.resolve('data', TENANT)
  const scriptBefore = snapshot(scriptRoot)

  const dry = run(scriptRoot, csvGood)
  ok(
    '스크립트 dry-run — 더할 줄을 보이고 임시 사본에 써 봄 · 앱 데이터 · 저장소 data/ 그대로',
    dry.status === 0 &&
      dry.stdout.includes('더할 기록 2 · 건너뜀 0 · 걸림 0') &&
      dry.stdout.includes(`+ 2행 w1 · ${A1.name} — https://w1.example.com/entry/1 (올린 날 2026-10-30)`) &&
      dry.stdout.includes('dry-run — 임시 사본에 같은 코드로 써 보았습니다(2건') &&
      sameSnapshot(snapshot(scriptRoot), scriptBefore) &&
      !existsSync(repoTenant),
    `${dry.status} ${dry.stdout}${dry.stderr}`,
  )
  const dryBad = run(scriptRoot, csvBad)
  ok('스크립트 — 걸린 줄이 있으면 줄 번호와 이유를 보이고 아무것도 안 씀', dryBad.status === 1 && dryBad.stdout.includes('✗ 2행: 사이트 첫 화면 주소입니다') && dryBad.stderr.includes('아무것도 쓰지 않았습니다') && sameSnapshot(snapshot(scriptRoot), scriptBefore), `${dryBad.status} ${dryBad.stdout}${dryBad.stderr}`)
  const badFlag = run(scriptRoot, csvGood, '--force')
  ok('스크립트 — 모르는 옵션은 거절', badFlag.status === 1 && badFlag.stderr.includes('모르는 옵션입니다: --force'), `${badFlag.status} ${badFlag.stderr}`)
  const noPlanRoot = path.join(tmp, 'no-plan')
  seed(noPlanRoot)
  rmSync(path.join(noPlanRoot, 'data', TENANT, 'probe-plan.json'))
  const noPlan = run(noPlanRoot, csvGood)
  ok('스크립트 — 배정 파일이 없으면 멈춤', noPlan.status === 1 && noPlan.stderr.includes('작성자 배정 파일이 없습니다'), `${noPlan.status} ${noPlan.stderr}`)
  const brokenRoot = path.join(tmp, 'broken-extras')
  seed(brokenRoot)
  put(path.join(brokenRoot, 'data', TENANT, 'extra-articles.json'), { version: 1, articles: [...extrasFile.articles, { id: 'topic:x' }] })
  const broken = run(brokenRoot, csvGood)
  ok('스크립트 — 추가 글 목록이 깨져 있으면 멈춤(앱과 같은 판단)', broken.status === 1 && broken.stderr.includes('추가 글 목록이 깨져 있습니다'), `${broken.status} ${broken.stderr}`)
  const virtualRoot = path.join(tmp, 'Packages', 'Claude_fake', 'LocalCache', 'Roaming', 'brand-aeo-app')
  seed(virtualRoot)
  const virtualBefore = snapshot(virtualRoot)
  const virtual = run(virtualRoot, csvGood, '--write')
  ok('스크립트 --write — 가상화 사본 경로면 거절 · 아무것도 안 씀', virtual.status === 1 && virtual.stderr.includes('가상화 사본') && sameSnapshot(snapshot(virtualRoot), virtualBefore), `${virtual.status} ${virtual.stderr}`)
  const writeBad = run(scriptRoot, csvBad, '--write')
  ok('스크립트 --write — 걸린 줄이 있으면 백업도 쓰지 않음', writeBad.status === 1 && sameSnapshot(snapshot(scriptRoot), scriptBefore), `${writeBad.status} ${writeBad.stdout}${writeBad.stderr}`)

  const running = appRunning()
  const written = run(scriptRoot, csvGood, '--write')
  if (running) {
    ok('스크립트 --write — 설치본 앱이 켜져 있어 앱 확인에서 멈춤 · 아무것도 안 씀(앱을 끄면 쓰기까지 확인)', written.status === 1 && written.stderr.includes('앱이 실행 중입니다') && sameSnapshot(snapshot(scriptRoot), scriptBefore), `${written.status} ${written.stdout}${written.stderr}`)
  } else {
    const dir = path.join(scriptRoot, 'data', TENANT)
    const backups = readdirSync(dir).filter((n) => n.startsWith('before-register-'))
    const ledger = JSON.parse(readFileSync(path.join(dir, 'published-posts.json'), 'utf8')) as { posts: { url: string; via: string; publishedOnSource: string }[] }
    ok(
      '스크립트 --write — 써 보는 확인 · 백업 · 두 줄 더함 · 다시 읽기',
      written.status === 0 &&
        written.stdout.includes('쓰기 확인:') &&
        written.stdout.includes('다시 읽음') &&
        backups.length === 1 &&
        readFileSync(path.join(dir, backups[0]!, 'published-posts.json'), 'utf8') === JSON.stringify(ledgerFile, null, 2) &&
        ledger.posts.length === 4 &&
        ledger.posts.slice(2).every((p) => p.via === 'own' && p.publishedOnSource === 'user'),
      `${written.status} ${written.stdout}${written.stderr}`,
    )
    const again = run(scriptRoot, csvGood, '--write')
    ok('스크립트 — 다시 돌리면 건너뛰고 아무것도 안 씀', again.status === 0 && again.stdout.includes('건너뜀 2') && again.stdout.includes('더할 기록이 없습니다'), `${again.status} ${again.stdout}${again.stderr}`)
  }
  console.log(`(설치본 앱 ${running ? '켜짐 — 스크립트 --write는 앱 확인에서 멈추는 것만 확인' : '꺼짐 — 스크립트 --write까지 확인'})`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

let failed = 0
for (const [label, pass, detail] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${label}`)
  if (!pass && detail) console.log(`    ${detail.replace(/\n/g, '\n    ')}`)
  if (!pass) failed += 1
}
if (failed > 0) {
  console.error(`\n${failed}건 실패`)
  process.exit(1)
}
console.log(`\n모두 통과 (${checks.length}건)`)
