/**
 * 작성자들이 올린 글 주소를 한꺼번에 적는다 — 작성자 배정(src/lib/probePlan.ts probe-plan/2)의 글을 작성자가 자기 블로그에 올리고 주소를
 * 보내면, 운영자가 글 카드마다 「올렸어요」를 누르는 대신 CSV 하나로 설치본의 집행 원장(data/<tenant>/published-posts.json)에 더한다.
 *
 *   npx tsx scripts/register-posts.ts <tenantId> --csv <파일> --app-data "<userData>"            # dry-run(기본)
 *   npx tsx scripts/register-posts.ts <tenantId> --csv <파일> --app-data "<userData>" --write    # 앱을 끄고
 *
 * CSV(브랜드마다 한 파일, UTF-8 — 엑셀의 BOM 허용): 작성자,글,주소,올린 날. 첫 줄이 머리글이면(세 번째 칸이 주소가 아니고 「주소」 · url)
 * 건너뛴다. 작성자는 키(w1)나 이름, 글은 글 id(topic:…)나 배정표의 주제 이름, 올린 날은 YYYY-MM-DD(2026.11.2 · 2026/11/02도 받는다).
 *
 * 기록은 콘텐츠 생성 「② 올리기 목록」의 그 글 자사 줄에서 「올렸어요」를 누른 것과 같다(src/lib/publishPlan.ts recordInputOf):
 * via 'own' · targetActionId = 글 id · 「집행함」으로 바꿈 · 추가 글의 질문 스냅샷(만들 때의 판 · id · 문장, 추가 글 목록에 없으면 배정 파일의
 * 것) · 글 제목(초안 제목) · 초안 판(generatedAt) · 사람이 고른 올린 날. 원장을 쓰는 코드는 앱과 같은 것(server/publishedPosts.ts
 * addPublishedPost)을 부른다 — 형식 · 키 규칙 · 상한 · 다른 글 주소 거절이 앱과 어긋나지 않는다.
 *
 * 줄마다 보는 것(하나라도 걸리면 아무것도 쓰지 않는다):
 *   - 배정 글인가(글 id · 주제 이름), 작성자가 그 글의 작성자인가, 초안이 있는가(작성자에게 준 글이다).
 *   - 글 한 편의 주소인가(src/lib/publishedUrl.ts isArticleUrl — 첫 화면 · 블로그 홈 · 단축 주소 · 글쓰기 화면은 안 된다).
 *   - 같은 주소(추적 키)가 CSV에 두 번 있거나 원장에서 다른 글의 주소면 거절한다. 원장에 이미 이 글 자사 줄의 주소로 적혀 있으면
 *     건너뛴다(다시 돌려도 같은 결과). 올린 날은 실제 날짜 · 오늘(KST) 이전.
 *
 * dry-run은 원장 · 집행 상태 파일을 임시 폴더로 복사해 그 사본에 같은 코드로 써 보고(실제 앱 데이터에는 쓰지 않는다) 더해질 줄을 보인다.
 * --write는 scripts/promote-probe-questions.ts와 같은 규칙을 지킨다:
 *   - 가상화 사본 경로(Packages\Claude_…)를 거절하고, 브랜드 폴더에 표지 파일을 써 보아 쓰기가 가상화 위치로 가면 멈춘다
 *     (server/probeQuestions.ts writeRedirects). Claude 셸에서는 //localhost/C$/… 경로로 실행한다.
 *   - 앱이 실행 중이면 멈춘다 — 앱도 같은 두 파일을 쓴다(줄은 프로세스 하나 안에서만 순서를 지킨다).
 *   - 계획을 세울 때 읽은 두 파일이 그 사이 바뀌었으면 멈추고, <tenantDir>/before-register-<시각>/에 두 파일을 복사한 뒤 줄마다 쓴다.
 *     다시 읽어 원래 기록이 그대로이고 새 기록이 계획대로인지, 그 글들이 「집행함」인지 본다. 되돌리기는 백업 두 파일을 제자리로 복사한다.
 *
 * 계획(planRegistration) · CSV 읽기(parseRegisterCsv) · 쓰기(registerPosts) · 확인(checkRegistration)은 scripts/verify-register-posts.ts가
 * 임시 폴더의 가짜 브랜드로 부른다.
 */
import { execFileSync } from 'node:child_process'
import { constants as fsConstants, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddPostInput, PublishedPost, TopicSnapshot } from '../server/publishedPosts'
import { findRedirectedCopies, looksVirtualized, writeRedirects } from '../server/probeQuestions'
import type { StoredDraft } from '../src/lib/api'
import { effectiveDraft } from '../src/lib/draftGaps'
import { extraTopicSnapshot, normalizeExtraArticles, type ExtraArticle } from '../src/lib/extraArticles'
import { draftTitle } from '../src/lib/markdownFile'
import { parseWriterPlan, type WriterPlan, type WriterPlanArticle } from '../src/lib/probePlan'
import { ARTICLE_URL_REASON, isArticleUrl, todayKst, trackingKey } from '../src/lib/publishedUrl'

/** 원장 · 집행 상태 · 배정 · 초안 · 추가 글 파일 — 서버가 쓰는 자리와 같다. */
export const REGISTER_FILES = {
  ledger: 'published-posts.json',
  states: 'action-states.json',
  plan: 'probe-plan.json',
  drafts: 'drafts.json',
  extras: 'extra-articles.json',
} as const

export interface CsvRow {
  /** CSV 줄 번호(1부터 — 머리글 포함). */
  line: number
  writer: string
  article: string
  url: string
  postedOn: string
}

/** 따옴표 칸(엑셀이 쉼표 · 줄바꿈이 든 칸을 감싼다)을 읽는다. 빈 줄은 건너뛴다. */
function csvRecords(text: string): { line: number; cells: string[] }[] {
  const out: { line: number; cells: string[] }[] = []
  let cells: string[] = []
  let cell = ''
  let quoted = false
  let line = 1
  let start = 1
  const push = () => {
    cells.push(cell)
    cell = ''
  }
  const end = () => {
    push()
    if (cells.some((c) => c.trim())) out.push({ line: start, cells })
    cells = []
  }
  // 엑셀이 붙이는 BOM(U+FEFF)을 뗀다.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"'
        i += 1
      } else if (ch === '"') {
        quoted = false
      } else {
        if (ch === '\n') line += 1
        cell += ch
      }
    } else if (ch === '"' && cell === '') {
      quoted = true
    } else if (ch === ',') {
      push()
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1
      end()
      line += 1
      start = line
    } else {
      cell += ch
    }
  }
  if (cell !== '' || cells.length > 0) end()
  return out
}

/** CSV를 줄로 — 칸이 4개(뒤의 빈 칸은 괜찮다)가 아니면 그 줄 번호로 알린다. 첫 줄이 머리글이면 건너뛴다. */
export function parseRegisterCsv(text: string): { rows: CsvRow[]; errors: string[] } {
  const rows: CsvRow[] = []
  const errors: string[] = []
  const records = csvRecords(text)
  const first = records[0]
  const header = first && !/^https?:/i.test((first.cells[2] ?? '').trim()) && /주소|url/i.test(first.cells[2] ?? '')
  for (const rec of header ? records.slice(1) : records) {
    const cells = rec.cells.map((c) => c.trim())
    while (cells.length > 4 && cells[cells.length - 1] === '') cells.pop()
    if (cells.length !== 4) {
      errors.push(`${rec.line}행: 칸이 ${cells.length}개입니다 — 작성자,글,주소,올린 날 4칸이어야 합니다.`)
      continue
    }
    const [writer, article, url, postedOn] = cells as [string, string, string, string]
    rows.push({ line: rec.line, writer, article, url, postedOn })
  }
  return { rows, errors }
}

/** 올린 날 — 2026-11-02 · 2026.11.2 · 2026/11/02를 YYYY-MM-DD로. 실제 날짜가 아니면 null. */
export function normalizeDay(raw: string): string | null {
  const m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})\.?$/.exec(raw.trim())
  if (!m) return null
  const day = `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`
  const t = Date.parse(`${day}T00:00:00Z`)
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === day ? day : null
}

/** 더할 기록 하나 — addPublishedPost에 그대로 넘긴다. */
export interface RegisterItem {
  line: number
  article: WriterPlanArticle
  input: AddPostInput & {
    url: string
    articleId: string
    targetActionId: string
    via: 'own'
    articleTitle: string
    draftGeneratedAt: string
    publishedOn: string
    publishedOnChosen: true
    markDone: true
    topic: TopicSnapshot
  }
  key: string
}

export interface RegisterPlanInput {
  plan: WriterPlan
  drafts: Record<string, StoredDraft>
  /** 추가 글 정의 전부(뺀 글 포함). */
  extras: ExtraArticle[]
  /** 지금 원장(옛 기록 포함 — server/publishedPosts.ts readPublishedPosts). */
  posts: PublishedPost[]
  rows: CsvRow[]
  /** 오늘(KST). */
  today: string
}

export interface RegisterPlan {
  items: RegisterItem[]
  /** 이미 그 글의 주소로 적혀 있어 건너뛴 줄. */
  skipped: string[]
  errors: string[]
  warnings: string[]
}

/** CSV 줄을 기록으로 — 걸린 줄은 errors(하나라도 있으면 쓰지 않는다), 이미 적힌 줄은 skipped. */
export function planRegistration(input: RegisterPlanInput): RegisterPlan {
  const items: RegisterItem[] = []
  const skipped: string[] = []
  const errors: string[] = []
  const warnings: string[] = []
  const seenKeys = new Map<string, number>()
  const seenArticles = new Map<string, number>()
  const actives = input.posts.filter((p) => !p.removedAt && !p.legacy)
  for (const row of input.rows) {
    const at = `${row.line}행`
    const article = row.article.startsWith('topic:')
      ? input.plan.articles.find((a) => a.id === row.article)
      : input.plan.articles.find((a) => a.name === row.article)
    if (!article) {
      errors.push(`${at}: 배정 글이 아닙니다 — ${row.article} (글 id나 배정표의 주제 이름을 그대로 적어 주세요)`)
      continue
    }
    const who = `${article.writer.key} · ${article.writer.name}`
    if (row.writer !== article.writer.key && row.writer !== article.writer.name) {
      errors.push(`${at}: 「${article.name}」은 ${who}의 글입니다 — 적힌 작성자 ${row.writer}`)
      continue
    }
    const url = row.url.trim()
    const check = isArticleUrl(url)
    if (!check.ok) {
      errors.push(`${at}: ${ARTICLE_URL_REASON[check.reason]} — ${url}`)
      continue
    }
    const key = trackingKey(url)!
    const day = normalizeDay(row.postedOn)
    if (!day) {
      errors.push(`${at}: 올린 날이 YYYY-MM-DD 날짜가 아닙니다 — ${row.postedOn}`)
      continue
    }
    if (day > input.today) {
      errors.push(`${at}: 올린 날(${day})이 오늘(${input.today})보다 뒤입니다.`)
      continue
    }
    if (day < '2020-01-01') {
      errors.push(`${at}: 올린 날(${day})이 너무 이릅니다.`)
      continue
    }
    const draft = input.drafts[article.id]
    if (!draft) {
      errors.push(`${at}: 「${article.name}」은 초안이 없습니다 — 작성자에게 준 글이 맞는지 확인해 주세요.`)
      continue
    }
    const twin = seenKeys.get(key)
    if (twin !== undefined) {
      errors.push(`${at}: 같은 주소가 ${twin}행에도 있습니다 — ${url}`)
      continue
    }
    seenKeys.set(key, row.line)
    // 앱과 같은 판단(server/publishedPosts.ts addPublishedPost) — 다른 글의 주소면 거절, 이 글 자사 줄에 이미 있으면 그 기록이다.
    const known = actives.filter((p) => p.key === key)
    const other = known.find((p) => p.articleId !== article.id)
    if (other) {
      errors.push(`${at}: 이 주소는 이미 다른 글 ${other.articleTitle ? `「${other.articleTitle}」` : other.articleId}의 올린 주소로 적혀 있습니다 — ${url}`)
      continue
    }
    // 집행 상태 파일에만 있던 옛 주소는 앱이 다시 적을 때 원장으로 옮긴다 — 여기서 옮기면 새 줄이 아니라 확인이 어긋나므로 앱에 맡긴다.
    if (input.posts.some((p) => p.legacy && !p.removedAt && p.key === key && p.targetActionId === article.id)) {
      errors.push(`${at}: 「${article.name}」에 예전 방식으로 적힌 주소입니다 — 앱의 올리기 목록에서 그 줄의 올린 날을 고쳐 주세요. ${url}`)
      continue
    }
    const own = known.find((p) => p.targetActionId === article.id)
    if (own) {
      const on = own.publishedOn
      skipped.push(`${at}: 「${article.name}」에 이미 적힌 주소입니다(올린 날 ${on ?? '모름'}) — 건너뜀${on && on !== day ? `. 날짜가 다르면 앱에서 고쳐 주세요(CSV ${day})` : ''}`)
      continue
    }
    if (known.length > 0) warnings.push(`${at}: 「${article.name}」의 채널 줄에 적힌 주소입니다 — 자사 줄에도 더합니다(앱의 「올렸어요」와 같다).`)
    const sameArticle = seenArticles.get(article.id)
    if (sameArticle !== undefined) warnings.push(`${at}: 「${article.name}」을 ${sameArticle}행에서도 다른 주소로 적었습니다 — 두 주소 모두 그 글의 기록이 됩니다.`)
    else if (actives.some((p) => p.articleId === article.id && p.targetActionId === article.id && p.key !== key)) {
      warnings.push(`${at}: 「${article.name}」에는 이미 다른 주소가 적혀 있습니다 — 이 주소도 더합니다.`)
    }
    seenArticles.set(article.id, row.line)
    const def = input.extras.find((x) => x.id === article.id)
    if (def?.removedAt) warnings.push(`${at}: 「${article.name}」은 추가 글 목록에서 뺀 글입니다 — 기록은 남지만 올리기 목록에는 보이지 않습니다.`)
    const topic = def
      ? extraTopicSnapshot(def)
      : { bankVersion: input.plan.bankVersion, questionIds: [...article.questionIds], questionTexts: [...article.questionTexts] }
    items.push({
      line: row.line,
      article,
      key,
      input: {
        url,
        articleId: article.id,
        targetActionId: article.id,
        via: 'own',
        articleTitle: draftTitle(effectiveDraft(draft)),
        draftGeneratedAt: draft.generatedAt,
        publishedOn: day,
        publishedOnChosen: true,
        markDone: true,
        topic,
      },
    })
  }
  return { items, skipped, errors, warnings }
}

/** 원장에 차례로 더한다 — 첫 실패에서 멈추고 그때까지 더한 수와 이유를 돌려준다. add는 server/publishedPosts.ts addPublishedPost. */
export async function registerPosts(
  tenantId: string,
  items: RegisterItem[],
  add: (tenantId: string, input: AddPostInput) => Promise<{ post: PublishedPost; existing: boolean }>,
): Promise<{ added: PublishedPost[]; error: string | null }> {
  const added: PublishedPost[] = []
  for (const item of items) {
    try {
      const r = await add(tenantId, item.input)
      if (r.existing) return { added, error: `${item.line}행: 원장에 이미 있는 기록이라 더하지 않았습니다 — ${item.input.url}` }
      added.push(r.post)
    } catch (err) {
      return { added, error: `${item.line}행: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
  return { added, error: null }
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * 쓴 뒤 확인 — 원래 원장 기록(옛 기록 제외)이 모두 그대로이고, 더한 기록이 계획과 같고(주소 · 글 · 자사 줄 · 사람이 고른 올린 날 · 질문
 * 스냅샷 · 제목 · 초안 판), 그 글들이 「집행함」인가. 어긋난 곳을 돌려준다(빈 배열이면 통과).
 */
export function checkRegistration(input: {
  before: PublishedPost[]
  after: PublishedPost[]
  items: RegisterItem[]
  states: Record<string, { status?: string }>
}): string[] {
  const problems: string[] = []
  const ledger = (posts: PublishedPost[]) => posts.filter((p) => !p.legacy)
  const after = new Map(ledger(input.after).map((p) => [p.id, p]))
  for (const p of ledger(input.before)) {
    if (!sameJson(after.get(p.id), p)) problems.push(`원래 기록이 바뀌었습니다: ${p.id} ${p.url}`)
  }
  const fresh = ledger(input.after).filter((p) => !input.before.some((b) => b.id === p.id))
  if (fresh.length !== input.items.length) problems.push(`새 기록이 ${fresh.length}줄입니다 — ${input.items.length}줄이어야 합니다.`)
  for (const item of input.items) {
    const p = fresh.find((x) => x.key === item.key && x.articleId === item.input.articleId)
    const want = item.input
    if (
      !p ||
      p.url !== want.url ||
      p.via !== 'own' ||
      p.targetActionId !== want.articleId ||
      p.publishedOn !== want.publishedOn ||
      p.publishedOnSource !== 'user' ||
      p.articleTitle !== want.articleTitle ||
      p.draftGeneratedAt !== want.draftGeneratedAt ||
      !sameJson(p.topic, want.topic) ||
      p.removedAt
    ) {
      problems.push(`${item.line}행의 기록이 계획과 다릅니다: ${want.url}`)
    }
    if (input.states[want.articleId]?.status !== 'done') problems.push(`${item.line}행의 글이 「집행함」이 아닙니다: ${want.articleId}`)
  }
  return problems
}

/** 백업 폴더 이름 — 다른 편집의 백업(before-promote-… · before-writer-plan-…)과 같은 꼴. */
export function registerBackupDirName(now: Date): string {
  return `before-register-${now.toISOString().replace(/[:.]/g, '-')}`
}

/** 원장 · 집행 상태 중 있는 파일을 백업 폴더로 복사한다(있는 백업은 덮지 않는다). 백업 폴더를 돌려준다. */
export async function backupLedger(tenantDir: string, now: Date): Promise<string> {
  const backupDir = path.join(tenantDir, registerBackupDirName(now))
  await mkdir(backupDir, { recursive: true })
  for (const name of [REGISTER_FILES.ledger, REGISTER_FILES.states]) {
    const source = path.join(tenantDir, name)
    if (!existsSync(source)) continue
    const target = path.join(backupDir, name)
    await copyFile(source, target, fsConstants.COPYFILE_EXCL).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'EEXIST') throw new Error(`백업 자리에 이미 파일이 있어 쓰지 않습니다(있는 백업을 덮지 않음): ${target}`)
      throw err
    })
  }
  return backupDir
}

// ── 실행 ────────────────────────────────────────────────────────────────────
function fail(...lines: string[]): never {
  for (const line of lines) console.error(line)
  process.exit(1)
}

/** 셸이 확장하지 못한 환경변수 토큰을 직접 푼다(scripts/promote-probe-questions.ts와 같은 헬퍼). */
const expandEnvTokens = (input: string) =>
  input
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name: string) => process.env[name] ?? m)
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/g, (m, name: string) => process.env[name] ?? m)

/** 앱이 실행 중이면 중단한다(scripts/promote-probe-questions.ts와 같은 방식). 확인에 실패하면 통과시키지 않는다. */
function assertAppClosed(): void {
  const EXE = 'Web4AI Brand AEO.exe'
  let out = ''
  try {
    out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${EXE}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8' })
  } catch (err) {
    fail(`✗ tasklist 실행에 실패해 앱 실행 여부를 확인할 수 없습니다(${err instanceof Error ? err.message : String(err)}). 앱을 끄고 다시 시도하세요.`)
  }
  const pids = [...out.matchAll(/^"([^"]+)","(\d+)"/gm)]
    .filter((m) => m[1].toLowerCase() === EXE.toLowerCase())
    .map((m) => m[2])
  if (pids.length > 0) {
    fail(
      `✗ 앱이 실행 중입니다(${EXE} · PID ${pids.join(', ')}). 완전히 종료한 뒤 다시 실행하세요.`,
      '  앱도 원장 · 집행 상태를 쓰므로 동시에 고치면 한쪽 변경이 사라집니다. 아무것도 쓰지 않았습니다.',
    )
  }
}

/** 파일 원문 — 없으면 null. */
const rawOf = (file: string): string | null => (existsSync(file) ? readFileSync(file, 'utf8') : null)

function readJsonFile(file: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch (err) {
    fail(`✗ ${what}을 읽지 못했습니다: ${file} — ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const VALUE_FLAGS = new Set(['--app-data', '--csv'])
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const USAGE = '사용법: npx tsx scripts/register-posts.ts <tenantId> --csv <파일> --app-data <dir> [--write]'
  const unknownFlag = args.find((x) => x.startsWith('--') && !VALUE_FLAGS.has(x) && x !== '--write')
  if (unknownFlag) fail(`모르는 옵션입니다: ${unknownFlag}`, USAGE)
  const tenantIds = [...new Set(args.filter((x, i) => !x.startsWith('--') && !VALUE_FLAGS.has(args[i - 1] ?? '')))]
  const write = args.includes('--write')
  const rawAppData = flag('--app-data')
  const csvPath = flag('--csv')
  if (!rawAppData || !csvPath || tenantIds.length !== 1) fail(USAGE)
  const tenantId = tenantIds[0]!

  const expanded = expandEnvTokens(rawAppData)
  if (expanded !== rawAppData) console.log(`인자 확장: ${rawAppData} → ${expanded}`)
  const appData = path.resolve(expanded)
  if (!existsSync(appData)) fail(`앱 데이터 폴더가 없습니다: ${appData}`)
  const tenantDir = path.join(appData, 'data', tenantId)
  if (!existsSync(tenantDir)) fail(`브랜드 폴더가 없습니다: ${tenantDir}`)
  if (!existsSync(csvPath)) fail(`CSV가 없습니다: ${csvPath}`)

  const virtualized = [appData, realpathSync.native(appData)].some(looksVirtualized)
  console.log(`앱 데이터: ${appData}`)
  console.log(`브랜드: ${tenantId} · CSV: ${path.resolve(csvPath)}`)
  if (virtualized) console.warn('⚠ 이 셸의 가상화 사본(Packages\\Claude_…) 경로로 보입니다 — 실제 앱 데이터가 아닙니다.')

  const planFile = path.join(tenantDir, REGISTER_FILES.plan)
  if (!existsSync(planFile)) fail(`✗ 작성자 배정 파일이 없습니다: ${planFile}`)
  const parsed = parseWriterPlan(readJsonFile(planFile, '배정 파일'))
  if (!parsed.plan) fail(`✗ 배정 파일이 깨져 있습니다: ${parsed.error}`)
  const plan = parsed.plan
  if (plan.tenantId !== tenantId) fail(`✗ 배정 파일의 브랜드(${plan.tenantId})가 ${tenantId}가 아닙니다.`)
  const draftsFile = path.join(tenantDir, REGISTER_FILES.drafts)
  const drafts = existsSync(draftsFile) ? (readJsonFile(draftsFile, '초안 파일') as Record<string, StoredDraft>) : {}
  const extrasFile = path.join(tenantDir, REGISTER_FILES.extras)
  const extrasRaw = existsSync(extrasFile) ? readJsonFile(extrasFile, '추가 글 목록') : { articles: [] }
  const extras = normalizeExtraArticles(extrasRaw)
  // 읽지 못한 줄이 있으면 앱도 그 파일을 깨진 것으로 본다(server/extraArticles.ts readState) — 질문 스냅샷을 틀리게 남기지 않게 멈춘다.
  const extrasRows = (extrasRaw as { articles?: unknown } | null)?.articles
  if (!Array.isArray(extrasRows) || extras.length !== extrasRows.length) fail(`✗ 추가 글 목록이 깨져 있습니다(앱도 읽지 않습니다): ${extrasFile}`)
  const csv = parseRegisterCsv(readFileSync(csvPath, 'utf8'))

  // 계획을 세울 때의 두 파일 원문 — 쓰기 전에 그 사이 바뀌지 않았는지 본다.
  const ledgerFile = path.join(tenantDir, REGISTER_FILES.ledger)
  const statesFile = path.join(tenantDir, REGISTER_FILES.states)
  const ledgerBefore = rawOf(ledgerFile)
  const statesBefore = rawOf(statesFile)

  // dry-run은 두 파일의 사본에 같은 코드로 써 본다. 서버 모듈이 불러올 때 데이터 폴더를 정하므로 환경 변수를 먼저 둔다.
  // 사본은 끝날 때 지운다 — fail()이 process.exit로 끝내도 지우도록 exit에 건다.
  const scratch = write ? null : mkdtempSync(path.join(tmpdir(), 'register-posts-'))
  if (scratch) process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))
  const roots = { appData: process.env.APPDATA, localAppData: process.env.LOCALAPPDATA }
  if (scratch) {
    const copyDir = path.join(scratch, 'data', tenantId)
    await mkdir(copyDir, { recursive: true })
    for (const name of [REGISTER_FILES.ledger, REGISTER_FILES.states]) {
      if (existsSync(path.join(tenantDir, name))) await copyFile(path.join(tenantDir, name), path.join(copyDir, name))
    }
  }
  process.env.APP_DATA_DIR = scratch ?? appData
  const { addPublishedPost, readPublishedPosts } = await import('../server/publishedPosts')
  const { readActionStates } = await import('../server/actionStates')

  const before = await readPublishedPosts(tenantId)
  const result = planRegistration({ plan, drafts, extras, posts: before, rows: csv.rows, today: todayKst() })
  const errors = [...csv.errors, ...result.errors]
  console.log(`\nCSV ${csv.rows.length + csv.errors.length}줄 — 더할 기록 ${result.items.length} · 건너뜀 ${result.skipped.length} · 걸림 ${errors.length}`)
  for (const item of result.items) {
    console.log(`  + ${item.line}행 ${item.article.writer.key} · ${item.article.name} — ${item.input.url} (올린 날 ${item.input.publishedOn})`)
  }
  for (const line of result.skipped) console.log(`  = ${line}`)
  for (const line of result.warnings) console.log(`  ⚠ ${line}`)
  for (const line of errors) console.log(`  ✗ ${line}`)
  if (errors.length > 0) fail('\n✗ 아무것도 쓰지 않았습니다 — 걸린 줄을 고쳐 다시 실행하세요.')
  if (result.items.length === 0) {
    console.log('\n더할 기록이 없습니다 — 아무것도 쓰지 않았습니다.')
    return
  }

  if (write) {
    if (virtualized) fail('✗ 가상화 사본 경로에는 쓰지 않습니다. 사용자 터미널이나 //localhost/C$/… 경로로 실행하세요.')
    let redirected: string[] = []
    try {
      redirected = await writeRedirects(tenantDir, roots)
    } catch (err) {
      fail(`✗ ${tenantDir}에 써 보는 확인을 하지 못했습니다(${err instanceof Error ? err.message : String(err)}). 아무것도 쓰지 않았습니다.`)
    }
    if (redirected.length > 0) {
      fail(
        `✗ 이 셸에서 쓴 파일이 실제 폴더가 아닌 가상화 사본으로 갑니다: ${redirected.join(', ')}`,
        '  사용자 터미널이나 //localhost/C$/… 경로로 실행하세요. 아무것도 쓰지 않았습니다(표지 파일은 지웠습니다).',
      )
    }
    console.log(`쓰기 확인: ${tenantDir}에 쓴 파일이 그 자리에 갑니다(가상화 사본 아님).`)
    // 앱 확인은 쓰기 바로 앞에서 한다 — 확인과 쓰기 사이에 앱을 켤 틈을 줄인다.
    assertAppClosed()
    if (rawOf(ledgerFile) !== ledgerBefore || rawOf(statesFile) !== statesBefore) {
      fail('✗ 원장이나 집행 상태가 그 사이 바뀌었습니다 — 다시 실행하세요. 아무것도 쓰지 않았습니다.')
    }
  }
  const backupDir = write ? await backupLedger(tenantDir, new Date()) : null
  const done = await registerPosts(tenantId, result.items, addPublishedPost)
  const problems = checkRegistration({
    before,
    after: await readPublishedPosts(tenantId),
    items: done.error ? result.items.slice(0, done.added.length) : result.items,
    states: await readActionStates(tenantId),
  })
  if (write && backupDir) {
    const moved = [...(await findRedirectedCopies(backupDir, roots)), ...(await findRedirectedCopies(ledgerFile, roots))]
    if (moved.length > 0) fail(`✗ 쓴 파일이 실제 폴더가 아닌 가상화 사본으로 갔습니다: ${moved.join(', ')}`, `  백업: ${backupDir}`)
  }
  const restore = backupDir ? [`  백업의 두 파일을 제자리로 복사해 되돌리세요: ${backupDir}`] : []
  if (done.error) fail(`✗ ${done.added.length}건을 더하고 멈췄습니다 — ${done.error}`, ...problems.map((p) => `  - ${p}`), ...restore)
  if (problems.length > 0) fail('✗ 다시 읽은 원장이 계획과 다릅니다:', ...problems.map((p) => `  - ${p}`), ...restore)

  if (write) {
    console.log(`\n저장: ${ledgerFile} — ${done.added.length}건을 더하고 그 글들을 「집행함」으로 바꿨습니다.`)
    console.log(`백업: ${backupDir}`)
    console.log('다시 읽음 — 원래 기록은 그대로이고 새 기록은 계획대로입니다. 앱을 켜면 콘텐츠 생성 · 보관함에 보입니다.')
  } else {
    console.log(`\ndry-run — 임시 사본에 같은 코드로 써 보았습니다(${done.added.length}건 · 원래 기록 그대로 · 「집행함」 확인). 실제 앱 데이터에는 아무것도 쓰지 않았습니다.`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
