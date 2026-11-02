/**
 * 실증 배정 파일 data/<tenant>/probe-plan.json을 만든다 — 실증 기간(~12-28)에 앱이 배정표 글만 만들게 하는 잠금의 근거다
 * (src/lib/probePlan.ts). 배정표(docs/proof/assignment.json) · 설계(docs/proof/design.json) · 그 판의 질문지에서 이름 없는 질문마다
 * 역할 하나를 정하고, 배정 글마다 주제 이름을 붙인다.
 *
 *   npx tsx scripts/write-probe-plan.ts [tenantId…] --app-data "<userData>"                                     # dry-run(기본)
 *   npx tsx scripts/write-probe-plan.ts [tenantId…] --app-data "<userData>" --names <이름 파일> --write
 *     [--assignment docs/proof/assignment.json] [--design docs/proof/design.json]
 *
 *   tenantId   없으면 배정표의 브랜드 전부
 *   --names    글 id → 주제 이름 JSON({ "topic:c1-001+c1-011": "…", … }). 여러 브랜드의 글을 한 파일에 둔다. 이름은 추가 글 이름이자
 *              브리프 각도로 글에 들어가므로 실험 용어(실증 · 처치 · 1차 …)를 넣지 않는다(parseProbePlan이 막는다). dry-run은 이름이
 *              없는 글을 「이름 필요」로 보이고 채울 틀을 찍는다.
 *
 * 역할(그 판 질문지의 이름 없는 질문마다 정확히 하나 — 빠지거나 둘이면 멈춘다):
 *   round1 · round2  배정표 rounds의 글이 맡은 질문. 글 id = topic:<정렬한 질문 id>(추가 글 · 판독 스크립트와 같은 규칙), 채널은 배정표
 *                    그대로, 게시일은 11-23 · 12-07(docs/proof/preregistration.md §5).
 *   control          배정표 controlIds
 *   ineligible       설계 ineligible과 배정표 excluded의 「대상 아님:」 — 이유를 남긴다
 *   zeroth           설계 zeroth(10-30 추가 글)와 배정표 excluded의 「0차 추가 글이 맡음」
 *   holdout          질문지의 probe && paraphraseOf와 배정표 excluded의 「홀드아웃」 — 원래 질문은 배정표 holdoutSources에 있어야 한다
 * 문장은 질문지 문장이다. 배정표 pool 문장과 한 글자라도 다르면 멈춘다(배정 뒤 질문지가 바뀌었다).
 *
 * 기본은 dry-run — 아무것도 쓰지 않는다(질문지 · 배정표를 읽기만 한다). --write는:
 *   - 고른 브랜드 모두 이름이 다 있고 검사(parseProbePlan 포함)를 통과해야 쓴다. 한 브랜드라도 걸리면 아무것도 쓰지 않는다.
 *   - 가상화 사본 경로(Packages\Claude_…)를 거절하고, 브랜드 폴더에 표지 파일을 써 보아 쓰기가 가상화 위치로 가면 멈춘다
 *     (server/probeQuestions.ts writeRedirects — scripts/add-probe-questions.ts와 같다). Claude 셸에서는 //localhost/C$/… 경로로 실행한다.
 *   - 이미 probe-plan.json이 있으면 <tenantDir>/before-probe-plan-<시각>/에 복사한 뒤 바꿔 쓰고, 다시 읽어 parseProbePlan으로 확인한다.
 *   - 앱은 이 파일을 요청마다 읽기만 하므로 앱을 끄지 않아도 된다. 질문지 · 추가 글 · 다른 파일은 건드리지 않는다.
 *
 * 만드는 규칙(buildProbePlan)과 파일 쓰기(writeProbePlanFile)는 검사(scripts/verify-probe-plan.ts)가 임시 폴더의 가짜 브랜드로 부른다.
 */
import { constants as fsConstants, existsSync, readFileSync, realpathSync } from 'node:fs'
import { access, copyFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findRedirectedCopies, looksVirtualized, writeRedirects } from '../server/probeQuestions'
import { writeJsonAtomic } from '../server/tenantWriteQueue'
import { topicArticleId } from '../src/lib/extraArticles'
import {
  parseProbePlan,
  PROBE_PLAN_FORMAT,
  type ProbeChannel,
  type ProbePlan,
  type ProbePlanQuestion,
  type ProbePlanRound,
  type ProbeRole,
} from '../src/lib/probePlan'
import { isProbe } from '../src/lib/questionScope'

/** 잠금 마지막 날 — 최종 판독 날(preregistration.md §5). 다음 날부터 앱은 지금처럼 허용한다. */
export const PROBE_ACTIVE_UNTIL = '2026-12-28'
/** 차수별 게시일(§5) — 그날 아침 측정 뒤에 올린다. */
export const PROBE_POST_DATES: Record<1 | 2, string> = { 1: '2026-11-23', 2: '2026-12-07' }
export const PROBE_PLAN_FILE = 'probe-plan.json'
/** dry-run에서 이름이 없는 글의 나머지 규칙을 검사할 때만 넣는 임시 이름 — 파일에는 쓰지 않는다. */
const NAME_PLACEHOLDER = '이름 필요'

/** 배정표(proof-assignment/2)의 브랜드 한 줄 가운데 여기서 읽는 것. */
export interface AssignmentBrand {
  tenantId: string
  bankVersion: string
  excluded: { id: string; reason: string }[]
  pool: { id: string; text: string }[]
  rounds: { arm: string; questionIds: string[]; articles: { questionIds: string[]; channel: string }[]; holdoutSources: string[] }[]
  controlIds: string[]
}
/** 설계의 브랜드 한 줄 가운데 여기서 읽는 것. */
export interface DesignBrand {
  tenantId: string
  bankVersion: string
  zeroth: { article: string; questionIds: string[] }
  ineligible: { id: string; reason: string }[]
}
export interface BankQuestion {
  questionId: string
  text: string
  category: string
  probe?: boolean
  paraphraseOf?: string
}

export interface ProbePlanInput {
  assignment: AssignmentBrand
  design: DesignBrand
  /** 배정표 seed. */
  seed: number
  /** 배정표 경로(저장소 기준) — 파일에 출처로 남긴다. */
  assignmentSource: string
  /** 배정한 판의 질문지. */
  bank: { version: string; questions: BankQuestion[] }
  /** 글 id → 주제 이름. 이 브랜드 글이 아닌 id는 보지 않는다(여러 브랜드를 한 파일에 둔다). */
  names: Record<string, string>
}

export interface ProbePlanBuild {
  /** 역할 표를 만들 수 있었으면 그 배정(이름이 없는 글은 빈 이름), 아니면 null. errors가 비고 이름이 다 있을 때만 쓴다. */
  plan: ProbePlan | null
  /** 쓰지 않을 이유. */
  errors: string[]
  /** 이름이 없는 배정 글 id. */
  missingNames: string[]
}

const roundOfArm = (arm: string): 1 | 2 | null => (arm === 'round1' ? 1 : arm === 'round2' ? 2 : null)
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

/** 배정표 excluded 이유 → 역할. 「대상 아님: <이유>」 · 「0차 추가 글이 맡음: <글>」 · 「홀드아웃(<원래> 바꿔 쓰기)」(scripts/proof-assign.ts). */
function excludedRole(reason: string): { role: ProbeRole; reason?: string } | null {
  if (reason.startsWith('대상 아님:')) return { role: 'ineligible', reason: reason.slice('대상 아님:'.length).trim() }
  if (reason.startsWith('0차')) return { role: 'zeroth' }
  if (reason.startsWith('홀드아웃')) return { role: 'holdout' }
  return null
}

/**
 * 배정표 · 설계 · 질문지로 한 브랜드의 배정 파일을 만든다 — 파일을 읽지도 쓰지도 않는다. 검사: 브랜드 · 판이 셋 모두 같음, 역할을 준
 * 질문은 모두 질문지의 이름 없는 질문, 질문 하나에 역할 하나, 이름 없는 질문이 모두 역할을 가짐, 배정표 pool 문장 === 질문지 문장,
 * 차수의 질문 목록 === 그 차수 글들의 질문, 0차 글 id === 질문 id 규칙, 홀드아웃의 원래 질문은 holdoutSources, 그리고 parseProbePlan
 * (형식 · 글 id · 이름 규칙 · 홀드아웃이 어떤 글에도 없음 …). 이름이 없는 글은 임시 이름으로 나머지 규칙을 본다.
 */
export function buildProbePlan(input: ProbePlanInput): ProbePlanBuild {
  const { assignment: a, design: d, bank, names } = input
  const errors: string[] = []
  const tenantId = a.tenantId
  const version = a.bankVersion
  if (d.tenantId !== tenantId) errors.push(`설계의 브랜드(${d.tenantId})가 배정표의 브랜드(${tenantId})와 다릅니다.`)
  if (d.bankVersion !== version) errors.push(`설계의 판(${d.bankVersion})이 배정표의 판(${version})과 다릅니다.`)
  if (bank.version !== version) errors.push(`질문지의 판(${bank.version})이 배정표의 판(${version})과 다릅니다.`)

  const unnamed = new Map(bank.questions.filter((q) => q.category === 'category-agnostic').map((q) => [q.questionId, q] as const))
  const roles = new Map<string, Omit<ProbePlanQuestion, 'text'>>()
  const sources = new Map<string, string>()
  /** 역할 하나를 준다 — 같은 역할을 두 곳에서 주면 합치고(빈 필드만 채움), 다른 역할이거나 다른 글이면 멈춘다. */
  const give = (id: string, q: Omit<ProbePlanQuestion, 'text'>, from: string) => {
    if (!unnamed.has(id)) {
      errors.push(`${from}의 ${id}가 질문지 ${version}의 이름 없는 질문이 아닙니다.`)
      return
    }
    const prev = roles.get(id)
    if (!prev) {
      roles.set(id, q)
      sources.set(id, from)
      return
    }
    const clash = (k: 'articleId' | 'of') => prev[k] !== undefined && q[k] !== undefined && prev[k] !== q[k]
    if (prev.role !== q.role || clash('articleId') || clash('of')) {
      errors.push(`${id}의 역할이 둘입니다: ${sources.get(id)} ${prev.role}${prev.articleId ? `(${prev.articleId})` : ''} · ${from} ${q.role}${q.articleId ? `(${q.articleId})` : ''}`)
      return
    }
    roles.set(id, { ...q, ...prev })
  }

  // 배정 글 — 차수 순.
  const rounds: ProbePlanRound[] = []
  for (const r of a.rounds) {
    const round = roundOfArm(r.arm)
    if (round === null) {
      errors.push(`배정표의 차수(${r.arm})가 round1 · round2가 아닙니다.`)
      continue
    }
    if (rounds.some((x) => x.round === round)) {
      errors.push(`배정표에 ${round}차가 두 번 있습니다.`)
      continue
    }
    const articles = r.articles.map((art) => {
      const questionIds = [...art.questionIds].sort()
      const id = topicArticleId(questionIds)
      for (const qid of questionIds) give(qid, { role: round === 1 ? 'round1' : 'round2', articleId: id }, `${round}차 글`)
      return {
        id,
        name: Object.hasOwn(names, id) ? names[id] : '',
        channel: art.channel as ProbeChannel,
        questionIds,
        questionTexts: questionIds.map((qid) => unnamed.get(qid)?.text ?? ''),
      }
    })
    const inArticles = articles.flatMap((x) => x.questionIds).sort()
    if (!sameList(inArticles, [...r.questionIds].sort())) errors.push(`배정표 ${round}차의 질문 목록이 그 차수 글들의 질문과 다릅니다.`)
    rounds.push({ round, postDate: PROBE_POST_DATES[round], articles })
  }
  rounds.sort((x, y) => x.round - y.round)
  const missingNames = rounds.flatMap((r) => r.articles.filter((x) => !x.name).map((x) => x.id))

  for (const id of a.controlIds) give(id, { role: 'control' }, '대조')

  const zerothIds = [...d.zeroth.questionIds].sort()
  if (topicArticleId(zerothIds) !== d.zeroth.article) errors.push(`설계의 0차 글 id(${d.zeroth.article})가 질문 id 규칙(${topicArticleId(zerothIds)})과 다릅니다.`)
  for (const id of zerothIds) give(id, { role: 'zeroth', articleId: d.zeroth.article }, '설계 0차')
  for (const e of d.ineligible) give(e.id, { role: 'ineligible', reason: e.reason }, '설계 대상 아님')

  const holdoutSources = new Set(a.rounds.flatMap((r) => r.holdoutSources))
  for (const q of unnamed.values()) {
    if (!isProbe(q) || !q.paraphraseOf) continue
    if (!holdoutSources.has(q.paraphraseOf)) errors.push(`홀드아웃 ${q.questionId}의 원래 질문 ${q.paraphraseOf}가 배정표 holdoutSources에 없습니다.`)
    give(q.questionId, { role: 'holdout', of: q.paraphraseOf }, '질문지 홀드아웃')
  }
  for (const e of a.excluded) {
    const role = excludedRole(e.reason)
    if (!role) {
      errors.push(`배정표 excluded ${e.id}의 이유를 알 수 없습니다: ${e.reason}`)
      continue
    }
    if (role.role === 'zeroth' && !zerothIds.includes(e.id)) errors.push(`배정표가 0차라고 한 ${e.id}가 설계 0차 글에 없습니다.`)
    const spec = unnamed.get(e.id)
    if (role.role === 'holdout' && !(spec && isProbe(spec) && spec.paraphraseOf)) errors.push(`배정표가 홀드아웃이라고 한 ${e.id}가 질문지의 홀드아웃(probe · paraphraseOf)이 아닙니다.`)
    give(e.id, role, '배정표 제외')
  }

  for (const p of a.pool) {
    const q = unnamed.get(p.id)
    if (q && q.text !== p.text) errors.push(`${p.id}의 질문지 문장이 배정표 문장과 다릅니다 — 배정 뒤 질문지가 바뀌었습니다.`)
  }
  const roleless = [...unnamed.keys()].filter((id) => !roles.has(id))
  if (roleless.length) errors.push(`역할이 없는 이름 없는 질문 ${roleless.length}개: ${roleless.join(', ')}`)
  if (errors.length) return { plan: null, errors, missingNames }

  // 역할 표 — 질문지 순서.
  const questions: Record<string, ProbePlanQuestion> = {}
  for (const [id, q] of unnamed) {
    const r = roles.get(id)!
    questions[id] = {
      role: r.role,
      text: q.text,
      ...(r.articleId ? { articleId: r.articleId } : {}),
      ...(r.of ? { of: r.of } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
    }
  }
  const plan: ProbePlan = {
    format: PROBE_PLAN_FORMAT,
    tenantId,
    bankVersion: version,
    activeUntil: PROBE_ACTIVE_UNTIL,
    source: { assignment: input.assignmentSource, seed: input.seed },
    rounds,
    zerothArticle: { id: d.zeroth.article, questionIds: zerothIds },
    questions,
  }
  // 이름이 없는 글은 임시 이름으로 바꿔 나머지 규칙을 본다. 이름이 다 있으면 읽은 결과(정규형)를 그대로 쓴다.
  const missing = new Set(missingNames)
  const checkable = missing.size
    ? { ...plan, rounds: plan.rounds.map((r) => ({ ...r, articles: r.articles.map((x) => (missing.has(x.id) ? { ...x, name: NAME_PLACEHOLDER } : x)) })) }
    : plan
  const parsed = parseProbePlan(JSON.parse(JSON.stringify(checkable)))
  if (parsed.error !== undefined) return { plan, errors: [parsed.error], missingNames }
  return { plan: missing.size ? plan : parsed.plan, errors: [], missingNames }
}

/** 역할 수 표의 이름 — 화면 칩(roleChip)의 「· 글 금지」 같은 안내는 뺀다. */
const ROLE_LABEL: Record<ProbeRole, string> = {
  round1: '1차 처치',
  round2: '2차 처치',
  control: '대조',
  holdout: '홀드아웃',
  ineligible: '대상 아님',
  zeroth: '0차',
}

/** 역할별 질문 수. */
export function roleCounts(plan: ProbePlan): Record<ProbeRole, number> {
  const out: Record<ProbeRole, number> = { round1: 0, round2: 0, control: 0, holdout: 0, ineligible: 0, zeroth: 0 }
  for (const q of Object.values(plan.questions)) out[q.role] += 1
  return out
}

/** 백업 폴더 이름 — 다른 편집의 백업(before-probe-… · before-profile-…)과 같은 꼴. */
export function planBackupDirName(now: Date): string {
  return `before-probe-plan-${now.toISOString().replace(/[:.]/g, '-')}`
}

const fileExists = (p: string) =>
  access(p).then(
    () => true,
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return false
      throw err
    },
  )

/**
 * 배정 파일 쓰기 — 검사를 통과한 배정만 쓴다(깨진 파일은 앱의 글 만들기를 막는다). 이미 있으면 <tenantDir>/before-probe-plan-<시각>/에
 * 복사한 뒤 원자적으로 바꿔 쓰고, 다시 읽어 parseProbePlan으로 같은 배정인지 확인한다. 그 자리에 백업이 이미 있으면 덮지 않고 멈춘다.
 */
export async function writeProbePlanFile(input: { tenantDir: string; plan: ProbePlan; now: Date }): Promise<{ file: string; backupDir: string | null; plan: ProbePlan }> {
  const checked = parseProbePlan(JSON.parse(JSON.stringify(input.plan)))
  if (checked.error !== undefined) throw new Error(`검사를 통과하지 못한 배정은 쓰지 않습니다: ${checked.error}`)
  const file = path.join(input.tenantDir, PROBE_PLAN_FILE)
  let backupDir: string | null = null
  if (await fileExists(file)) {
    backupDir = path.join(input.tenantDir, planBackupDirName(input.now))
    await mkdir(backupDir, { recursive: true })
    const backupFile = path.join(backupDir, PROBE_PLAN_FILE)
    // 있는 백업은 덮지 않는다 — 같은 시각에 두 번 쓰면 첫 백업(원래 배정)이 사라진다. 이때는 아무것도 바꾸지 않고 멈춘다.
    await copyFile(file, backupFile, fsConstants.COPYFILE_EXCL).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'EEXIST') throw new Error(`백업 자리에 이미 파일이 있어 쓰지 않습니다(있는 백업을 덮지 않음): ${backupFile}`)
      throw err
    })
  }
  await writeJsonAtomic(file, checked.plan)
  const back = parseProbePlan(JSON.parse(await readFile(file, 'utf-8')))
  const restore = backupDir ? ` — 백업에서 되돌리세요: ${path.join(backupDir, PROBE_PLAN_FILE)}` : ''
  if (back.error !== undefined) throw new Error(`쓴 배정 파일을 다시 읽지 못했습니다(${back.error})${restore}`)
  if (JSON.stringify(back.plan) !== JSON.stringify(checked.plan)) throw new Error(`쓴 배정 파일이 만든 배정과 다릅니다${restore}`)
  return { file, backupDir, plan: back.plan }
}

// ── 실행 ────────────────────────────────────────────────────────────────────
function fail(...lines: string[]): never {
  for (const line of lines) console.error(line)
  process.exit(1)
}

/** 셸이 확장하지 못한 환경변수 토큰을 직접 푼다(scripts/add-probe-questions.ts와 같은 헬퍼). */
const expandEnvTokens = (input: string) =>
  input
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name: string) => process.env[name] ?? m)
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/g, (m, name: string) => process.env[name] ?? m)

function readJsonFile<T>(file: string, what: string): T {
  if (!existsSync(file)) fail(`${what}이 없습니다: ${file}`)
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch (err) {
    return fail(`${what}을 읽지 못했습니다: ${file} — ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const VALUE_FLAGS = new Set(['--app-data', '--assignment', '--design', '--names'])
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const USAGE =
    '사용법: npx tsx scripts/write-probe-plan.ts [tenantId…] --app-data <dir> [--names <이름 파일>] [--write] ' +
    '[--assignment docs/proof/assignment.json] [--design docs/proof/design.json]'
  const unknownFlag = args.find((x) => x.startsWith('--') && !VALUE_FLAGS.has(x) && x !== '--write')
  if (unknownFlag) fail(`모르는 옵션입니다: ${unknownFlag}`, USAGE)
  const positional = args.filter((x, i) => !x.startsWith('--') && !VALUE_FLAGS.has(args[i - 1] ?? ''))
  const write = args.includes('--write')
  const rawAppData = flag('--app-data')
  if (!rawAppData) fail(USAGE)

  const expanded = expandEnvTokens(rawAppData)
  if (expanded !== rawAppData) console.log(`인자 확장: ${rawAppData} → ${expanded}`)
  const appData = path.resolve(expanded)
  if (!existsSync(appData)) fail(`앱 데이터 폴더가 없습니다: ${appData}`)
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const assignmentPath = path.resolve(flag('--assignment') ?? path.join(repoRoot, 'docs', 'proof', 'assignment.json'))
  const designPath = path.resolve(flag('--design') ?? path.join(repoRoot, 'docs', 'proof', 'design.json'))
  const rel = path.relative(repoRoot, assignmentPath)
  const assignmentSource = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : assignmentPath

  const assignment = readJsonFile<{ format?: string; seed: number; brands: AssignmentBrand[] }>(assignmentPath, '배정표')
  if (assignment.format !== 'proof-assignment/2') fail(`배정표 형식이 proof-assignment/2가 아닙니다: ${String(assignment.format)}`)
  const design = readJsonFile<{ seed: number; brands: DesignBrand[] }>(designPath, '설계 파일')
  if (design.seed !== assignment.seed) fail(`설계의 seed(${design.seed})가 배정표의 seed(${assignment.seed})와 다릅니다.`)

  let names: Record<string, string> = {}
  const namesFlag = flag('--names')
  const namesPath = namesFlag ? path.resolve(namesFlag) : null
  if (namesPath) {
    const raw = readJsonFile<unknown>(namesPath, '이름 파일')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.values(raw).every((v) => typeof v === 'string')) {
      fail(`이름 파일은 { "글 id": "주제 이름" } 꼴이어야 합니다: ${namesPath}`)
    }
    names = raw as Record<string, string>
  }

  // 같은 브랜드를 두 번 주면 한 번만 쓴다 — 같은 시각으로 두 번 쓰면 두 번째 백업이 첫 백업(원래 배정)을 덮는다.
  const tenantIds = [...new Set(positional.length ? positional : assignment.brands.map((b) => b.tenantId))]
  const unknownTenant = tenantIds.filter((t) => !assignment.brands.some((b) => b.tenantId === t))
  if (unknownTenant.length) fail(`배정표에 없는 브랜드입니다: ${unknownTenant.join(', ')}`)

  // 이름 파일의 id — 배정표 어느 글도 아니면 오타다. 두 브랜드가 같은 글 id를 가지면 한 파일로 이름을 나눌 수 없다.
  const owners = new Map<string, string[]>()
  for (const b of assignment.brands) {
    for (const r of b.rounds) for (const art of r.articles) {
      const id = topicArticleId(art.questionIds)
      owners.set(id, [...(owners.get(id) ?? []), b.tenantId])
    }
  }
  const nameErrors = [
    ...Object.keys(names).filter((id) => !owners.has(id)).map((id) => `이름 파일의 ${id}는 배정표의 글이 아닙니다.`),
    ...Object.keys(names).filter((id) => (owners.get(id)?.length ?? 0) > 1).map((id) => `${id}는 두 브랜드(${owners.get(id)!.join(' · ')})의 글이라 한 이름 파일로 나눌 수 없습니다 — 브랜드마다 따로 실행하세요.`),
  ]

  const virtualized = looksVirtualized(appData) || looksVirtualized(realpathSync.native(appData))
  console.log(`앱 데이터: ${appData}`)
  console.log(`배정표: ${assignmentPath}`)
  console.log(`설계: ${designPath}`)
  if (namesPath) console.log(`이름 파일: ${namesPath}`)
  if (virtualized) console.warn('⚠ 이 셸의 가상화 사본(Packages\\Claude_…) 경로로 보입니다 — 실제 앱 데이터가 아닙니다.')

  const built: { tenantId: string; tenantDir: string; build: ProbePlanBuild }[] = []
  for (const tenantId of tenantIds) {
    const ab = assignment.brands.find((b) => b.tenantId === tenantId)!
    const db = design.brands.find((b) => b.tenantId === tenantId)
    if (!db) fail(`설계에 ${tenantId}가 없습니다: ${designPath}`)
    const tenantDir = path.join(appData, 'data', tenantId)
    const bankPath = path.join(tenantDir, 'question-bank', `${ab.bankVersion}.json`)
    const bank = readJsonFile<{ version: string; questions: BankQuestion[] }>(bankPath, '질문지')
    const build = buildProbePlan({ assignment: ab, design: db, seed: assignment.seed, assignmentSource, bank, names })
    built.push({ tenantId, tenantDir, build })

    console.log(`\n■ ${tenantId} (${ab.bankVersion}) — 질문지 ${bankPath}`)
    const { plan } = build
    if (plan) {
      const counts = roleCounts(plan)
      const roleLine = (Object.keys(counts) as ProbeRole[]).map((r) => `${ROLE_LABEL[r]} ${counts[r]}`).join(' · ')
      console.log(`  이름 없는 질문 ${Object.keys(plan.questions).length}개 — ${roleLine}`)
      console.log(`  글 ${plan.rounds.reduce((n, r) => n + r.articles.length, 0)}편`)
      for (const r of plan.rounds) {
        console.log(`  ${r.round}차 · ${r.postDate} 게시 — 글 ${r.articles.length}편`)
        r.articles.forEach((art, i) => {
          console.log(`    글 ${i + 1} · ${art.channel} · ${art.id}`)
          console.log(`      이름: ${art.name || `(${NAME_PLACEHOLDER})`}`)
          art.questionIds.forEach((qid, j) => console.log(`      ${qid}  ${art.questionTexts[j]}`))
        })
      }
      console.log(`  0차 글(되살리기만 허용): ${plan.zerothArticle.id}`)
      const listOf = (role: ProbeRole, detail: (q: ProbePlanQuestion) => string) =>
        Object.entries(plan.questions)
          .filter(([, q]) => q.role === role)
          .map(([id, q]) => `${id}${detail(q)}`)
      console.log(`  대조: ${listOf('control', () => '').join(', ') || '없음'}`)
      console.log(`  홀드아웃: ${listOf('holdout', (q) => ` ← ${q.of}`).join(', ') || '없음'}`)
      const ineligible = listOf('ineligible', (q) => `(${q.reason ?? '이유 없음'})`)
      console.log(`  대상 아님 ${ineligible.length}개${ineligible.length ? ':' : ''}`)
      for (const line of ineligible) console.log(`    ${line}`)
    }
    const file = path.join(tenantDir, PROBE_PLAN_FILE)
    console.log(`  배정 파일: ${file} — ${existsSync(file) ? '있음(쓰면 before-probe-plan-<시각>/에 먼저 백업)' : '없음(새로 씀)'}`)
    for (const e of build.errors) console.log(`  ✗ ${e}`)
  }
  for (const e of nameErrors) console.log(`✗ ${e}`)

  const missing = built.flatMap((b) => b.build.missingNames)
  const problems = built.some((b) => b.build.errors.length > 0) || nameErrors.length > 0
  if (missing.length) {
    const template = Object.fromEntries(built.flatMap((b) => (b.build.plan?.rounds ?? []).flatMap((r) => r.articles.map((art) => [art.id, art.name] as const))))
    console.log(`\n이름이 없는 글 ${missing.length}편 — 아래 틀의 빈 이름을 채워 저장하고 --names로 주세요(실험 용어 금지, 60자 이하):`)
    console.log(JSON.stringify(template, null, 2))
  }

  if (!write) {
    console.log('\ndry-run — 아무것도 쓰지 않았습니다.')
    if (problems) fail('✗ 검사에 걸린 곳이 있습니다(위 ✗).')
    return
  }

  if (problems) fail('✗ 쓰지 않았습니다 — 검사에 걸린 곳이 있습니다(위 ✗).')
  if (missing.length) fail(`✗ 쓰지 않았습니다 — 이름이 없는 글이 ${missing.length}편 있습니다(--names).`)
  if (virtualized) fail('✗ 가상화 사본 경로에는 쓰지 않습니다. 사용자 터미널이나 //localhost/C$/… 경로로 실행하세요.')

  // 경로 글자로는 안 보이는 쓰기 리다이렉트 — 브랜드 폴더마다 표지 파일을 써 보고 가상화 위치에 생기는지 본다. 모두 확인한 뒤에 쓴다.
  const roots = { appData: process.env.APPDATA, localAppData: process.env.LOCALAPPDATA }
  for (const b of built) {
    let redirected: string[] = []
    try {
      redirected = await writeRedirects(b.tenantDir, roots)
    } catch (err) {
      fail(`✗ ${b.tenantDir}에 써 보는 확인을 하지 못했습니다(${err instanceof Error ? err.message : String(err)}). 아무것도 쓰지 않았습니다.`)
    }
    if (redirected.length > 0) {
      fail(
        `✗ 이 셸에서 쓴 파일이 실제 폴더가 아닌 가상화 사본으로 갑니다: ${redirected.join(', ')}`,
        '  사용자 터미널이나 //localhost/C$/… 경로로 실행하세요. 아무것도 쓰지 않았습니다(표지 파일은 지웠습니다).',
      )
    }
    console.log(`쓰기 확인: ${b.tenantDir}에 쓴 파일이 그 자리에 갑니다(가상화 사본 아님).`)
  }

  const now = new Date()
  for (const b of built) {
    let result: Awaited<ReturnType<typeof writeProbePlanFile>>
    try {
      result = await writeProbePlanFile({ tenantDir: b.tenantDir, plan: b.build.plan!, now })
    } catch (err) {
      fail(`✗ ${b.tenantId}: ${err instanceof Error ? err.message : String(err)}`)
    }
    const moved = [
      ...(await findRedirectedCopies(result.file, roots)),
      ...(result.backupDir ? await findRedirectedCopies(result.backupDir, roots) : []),
    ]
    if (moved.length > 0) fail(`✗ ${b.tenantId}: 배정 파일이 실제 폴더가 아닌 가상화 사본으로 갔습니다: ${moved.join(', ')}`)
    console.log(`\n저장: ${result.file}`)
    if (result.backupDir) console.log(`  백업: ${path.join(result.backupDir, PROBE_PLAN_FILE)}`)
    const counts = roleCounts(result.plan)
    console.log(`  다시 읽음 — 글 ${result.plan.rounds.reduce((n, r) => n + r.articles.length, 0)}편 · 역할 ${Object.keys(result.plan.questions).length}개(대조 ${counts.control} · 홀드아웃 ${counts.holdout})`)
  }
  console.log('\n앱은 이 파일을 요청마다 읽습니다 — 다시 켜지 않아도 됩니다. 질문지 · 추가 글은 건드리지 않았습니다.')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
