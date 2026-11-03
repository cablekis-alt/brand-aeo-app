/**
 * 작성자 배정 — 브랜드마다 작성자 8명 × 10편 = 80편의 글(글마다 이름 없는 질문 2개)을 정하고, 앱 배정 파일(data/<tenant>/probe-plan.json,
 * src/lib/probePlan.ts의 probe-plan/2) · 작성자별 배정표(마크다운 · CSV) · 겹침 보고서를 만든다(2026-11-02 실증 종료 · 운영 방식 전환).
 *
 *   npx tsx scripts/writer-plan.ts [tenantId…] --app-data "<userData>"                          # dry-run(기본) — 보고서만 찍는다
 *   npx tsx scripts/writer-plan.ts [tenantId…] --app-data "<userData>" --handouts [--out <dir>]  # 배정표를 docs/writers/(또는 <dir>)에
 *   npx tsx scripts/writer-plan.ts [tenantId…] --app-data "<userData>" --write                  # 앱 배정 파일을 쓴다
 *     [--writers docs/writers.json] [--design docs/proof/design.json] [--seed 20261102] [--names <이름 파일>]
 *     [--bank-version <tenantId>=<판> …] [--active-until 2027-03-31]
 *
 *   tenantId        없으면 설계(docs/proof/design.json)의 브랜드 전부
 *   --writers       작성자 설정 { format: 'writers/1', placeholder?, writers: [{ key, name, label, angle, blog }] }. label은 글 이름에 붙는
 *                   짧은 각도(「가족 여행」), angle은 추가 글의 「다룰 각도」로 들어가는 문장이다. placeholder: true면 --write를 거절한다.
 *   --bank-version  배정할 질문지 판. 없으면 측정이 쓰는 판(브랜드 목록의 설정 — 저장소 설정이 이긴다), 브랜드 목록에 없으면 그
 *                   브랜드 question-bank 폴더의 가장 높은 번호(v<N>.json). 질문 id는 승격 전후 같다. 앱은 이 판으로 측정한 주에만 배정 글을
 *                   만든다. 그 판 파일이 이 PC에 아직 없으면 설치본 동봉본(src/data/question-banks/<tenantId>/<판>.json)을 읽는다(chooseWriterBank).
 *   --names         브랜드 → 글 id → 주제 이름 JSON({ "web4ai": { "topic:c1-001+c1-011": "…" } }). 자동 제안 이름을 덮어쓴다.
 *   --seed          배정 시드(기본 20261102). 브랜드마다 FNV-1a("<seed>:<tenantId>")로 난수를 나눈다 — 같은 입력이면 늘 같은 배정이다.
 *
 * 글을 쓸 질문 = 그 판의 이름 없는 질문(category-agnostic) − 설계의 ineligible(사실과 맞지 않는 질문, web4ai 10개 · gunsan 없음).
 * 규칙(모두 검사하고 위반이 하나라도 있으면 아무것도 쓰지 않는다):
 *   (1) 같은 질문 조합의 글은 없다 — 글 id(topic:<정렬한 질문 id>)가 모두 다르다(추가 글 · 브리프 · 초안 · 올린 기록이 이 id로 붙는다).
 *   (2) 두 글이 겹치는 질문은 많아야 1개.  (3) 한 작성자가 같은 질문을 두 번 맡지 않는다.
 *   (4) 질문마다 맡는 글 수가 고르다(최대 − 최소 ≤ 1 — 40개면 4편씩, 48개면 3~4편).  (5) 작성자마다 10편.
 *   그리고 바꿔 쓴 질문 짝(질문지 paraphraseOf — 승격 뒤 판에는 표시가 없어 같은 폴더의 옛 판에서 같은 id · 문장으로 찾는다)은 같은
 *   뜻으로 본다(intentsOf) — 사실상 같은 질문이라, 한 글에 넣지 않고 · 같은 뜻의 조합(A+B와 A'+B)을 두 글이 맡지 않고 · 한 작성자가
 *   A와 A'를 함께 맡지 않는다(그러면 한 사람이 같은 글을 두 번 쓴다).
 * 묶는 기준: 설계의 의미 묶음(clusters)이 같으면 가장 좋고, 그다음 같은 주제(topic) · 같은 단계(stage). 질문 조합(그래프)은 질문마다
 * 글 수를 정한 뒤 Havel–Hakimi로 시작해 두 글의 짝 바꾸기 · 한쪽 질문 옮기기로 묶음 점수를 올리고(재시작 여러 번), 작성자는 뜻
 * 그래프의 간선 색칠(작성자 = 색, 한 뜻의 글은 모두 다른 색)을 되돌아가기로 찾은 뒤 Kempe 사슬로 고르게 맞춘다(작성자마다 정확히 10편).
 * 묶음 점수가 높은 그래프부터 칠해 보고 처음 칠해지는 것을 쓴다.
 *
 * 이름: 글마다 「<주제> (<작성자 label>)」를 제안한다 — 같은 의미 묶음이면 묶음 이름, 같은 주제면 그 주제, 아니면 두 주제. 60자 이하 ·
 * 브랜드 안에서 모두 다르게 · 실험 용어 없이(parseWriterPlan이 막는다).
 *
 * 기본은 dry-run — 아무것도 쓰지 않는다(질문지 · 설계 · 작성자 설정 · 추가 글 목록을 읽기만 한다). --handouts는 배정표만 저장소
 * docs/writers/(또는 --out)에 쓴다. --write는:
 *   - 고른 브랜드 모두 검사를 통과해야 쓴다. 한 브랜드라도 걸리면 아무것도 쓰지 않는다. 작성자 설정이 자리표시(placeholder)면 거절한다.
 *   - 가상화 사본 경로(Packages\Claude_…)를 거절하고, 브랜드 폴더에 표지 파일을 써 보아 쓰기가 가상화 위치로 가면 멈춘다
 *     (server/probeQuestions.ts writeRedirects — scripts/promote-probe-questions.ts와 같다). Claude 셸에서는 //localhost/C$/… 경로로 실행한다.
 *   - 이미 probe-plan.json이 있으면(실증 배정 포함) <tenantDir>/before-writer-plan-<시각>/에 복사한 뒤 바꿔 쓰고, 다시 읽어
 *     parseWriterPlan으로 확인한다. 앱은 이 파일을 요청마다 읽기만 하므로 앱을 끄지 않아도 된다. 질문지 · 추가 글은 건드리지 않는다.
 *   - 운영 모드(probe-plan/2를 읽는 앱, v0.4.49) 앞의 앱은 이 파일을 읽지 않는다 — 잠금 · 작성자 단추 · 늘어난 추가 글 상한이 없다. 그
 *     릴리스를 설치한 뒤 쓴다.
 *
 * 배정(buildWriterPlan) · 규칙 검사(checkWriterRules) · 배정표(writerHandouts) · 파일 쓰기(writeWriterPlanFile)는
 * scripts/verify-writer-plan.ts가 가짜 질문지와 (있으면) 실제 질문지(읽기만)로 부른다.
 */
import { constants as fsConstants, existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findRedirectedCopies, looksVirtualized, writeRedirects } from '../server/probeQuestions'
import { writeJsonAtomic } from '../server/tenantWriteQueue'
import { aliveExtraArticles, normalizeExtraArticles, questionTextKey, topicArticleId } from '../src/lib/extraArticles'
import { parseWriterPlan, WRITER_LIMITS, WRITER_PLAN_FORMAT, type WriterPlan, type WriterPlanArticle } from '../src/lib/probePlan'

/** 배정 파일 — 서버가 읽는 자리(server/probePlanStore.ts PROBE_PLAN_FILE)와 같다. */
export const WRITER_PLAN_FILE = 'probe-plan.json'
export const WRITERS_FORMAT = 'writers/1'
/** 운영 기간 마지막 날 기본값 — --active-until로 바꾼다. */
export const WRITER_ACTIVE_UNTIL = '2027-03-31'
export const WRITER_PLAN_SEED = 20261102
/** 작성자마다 글 수. */
export const PER_WRITER = 10
/** 글마다 질문 수. */
export const QUESTIONS_PER_ARTICLE = 2

/** 묶음 점수 — 더한다. 같은 의미 묶음이 가장 크고, 묶이지 않은 질문은 주제 · 단계로 고른다. */
const AFFINITY = { cluster: 100, topic: 20, stage: 5 } as const
/** 그래프를 처음부터 다시 만들어 보는 횟수 — 가장 높은 점수를 쓴다. */
const RESTARTS = 6
/** Havel–Hakimi가 막힐 때(같은 뜻 · 이미 있는 조합) 순서를 바꿔 다시 해 보는 횟수. */
const START_ATTEMPTS = 50

export interface WriterSpec {
  /** 'w1' … */
  key: string
  name: string
  /** 글 이름에 붙는 짧은 각도 — 「가족 여행」. */
  label: string
  /** 추가 글의 다룰 각도 문장. */
  angle: string
  /** 블로그 주소나 이름. 모르면 빈 글자. */
  blog: string
}

export interface WritersFile {
  format: typeof WRITERS_FORMAT
  /** 이름 · 블로그가 아직 자리표시 — --write를 거절한다. */
  placeholder?: boolean
  writers: WriterSpec[]
}

export interface BankQuestion {
  questionId: string
  text: string
  category: string
  stage?: string
  topic?: string
  probe?: boolean
  paraphraseOf?: string
}

export interface Cluster {
  name: string
  ids: string[]
}

/** 글을 쓸 질문 하나. */
export interface PoolQuestion {
  questionId: string
  text: string
  stage?: string
  topic?: string
}

export type PairKind = 'cluster' | 'topic' | 'stage' | 'other'

// ── 난수 ────────────────────────────────────────────────────────────────────
export function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (const ch of Buffer.from(s, 'utf8')) {
    h ^= ch
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}
function mulberry32(a: number): () => number {
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const a = [...items]
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}
const range = (n: number) => Array.from({ length: n }, (_, i) => i)

// ── 질문 ────────────────────────────────────────────────────────────────────
/** 글을 쓸 질문 — 이름 없는 질문(질문지 순서)에서 뺄 질문을 뺀다. 뺄 질문이 이름 없는 질문이 아니면 오류(설계와 질문지가 어긋남). */
export function writerPool(questions: BankQuestion[], excluded: string[]): { pool: PoolQuestion[]; errors: string[] } {
  const agnostic = questions.filter((q) => q.category === 'category-agnostic')
  const skip = new Set(excluded)
  const errors = [...skip].filter((id) => !agnostic.some((q) => q.questionId === id)).map((id) => `글을 쓰지 않을 질문 ${id}가 질문지의 이름 없는 질문이 아닙니다.`)
  const pool = agnostic
    .filter((q) => !skip.has(q.questionId))
    .map((q) => ({ questionId: q.questionId, text: q.text, ...(q.stage ? { stage: q.stage } : {}), ...(q.topic ? { topic: q.topic } : {}) }))
  return { pool, errors }
}

/**
 * 같은 뜻으로 볼 짝(intentsOf) — 바꿔 쓴 질문과 그 원래 질문. 고른 판에 표시가 있으면 그대로, 없으면(승격 뒤) 다른 판 질문지에서 같은 id · 같은
 * 문장(공백만 정리)인 짝을 찾는다. 정렬한 [작은 id, 큰 id] 목록 — 같은 입력이면 늘 같은 순서.
 */
export function paraphrasePairs(pool: PoolQuestion[], banks: { questions: BankQuestion[] }[]): [string, string][] {
  const text = new Map(pool.map((q) => [q.questionId, questionTextKey(q.text)] as const))
  const out = new Map<string, [string, string]>()
  for (const bank of banks) {
    const byId = new Map(bank.questions.map((q) => [q.questionId, q] as const))
    for (const q of bank.questions) {
      if (!q.paraphraseOf) continue
      const src = byId.get(q.paraphraseOf)
      if (!src || text.get(q.questionId) !== questionTextKey(q.text) || text.get(src.questionId) !== questionTextKey(src.text)) continue
      const pair = [q.questionId, src.questionId].sort() as [string, string]
      out.set(pair.join('\n'), pair)
    }
  }
  return [...out.values()].sort((a, b) => (a.join('\n') < b.join('\n') ? -1 : 1))
}

/** 두 질문이 어떤 짝인지 — 가장 강한 것 하나(보고서용). */
export function pairKind(a: PoolQuestion, b: PoolQuestion, clusterOf: Map<string, string>): PairKind {
  const ca = clusterOf.get(a.questionId)
  if (ca !== undefined && ca === clusterOf.get(b.questionId)) return 'cluster'
  if (a.topic && a.topic === b.topic) return 'topic'
  if (a.stage && a.stage === b.stage) return 'stage'
  return 'other'
}

function affinity(a: PoolQuestion, b: PoolQuestion, clusterOf: Map<string, string>): number {
  const ca = clusterOf.get(a.questionId)
  return (
    (ca !== undefined && ca === clusterOf.get(b.questionId) ? AFFINITY.cluster : 0) +
    (a.topic && a.topic === b.topic ? AFFINITY.topic : 0) +
    (a.stage && a.stage === b.stage ? AFFINITY.stage : 0)
  )
}

/** 질문 id → 의미 묶음 이름. 한 질문이 두 묶음에 있으면 앞 묶음. */
export function clusterIndex(clusters: Cluster[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const c of clusters) for (const id of c.ids) if (!out.has(id)) out.set(id, c.name)
  return out
}

/**
 * 뜻 — 바꿔 쓴 질문 짝(과 그 사슬)을 하나로 본다. 질문 순번마다 그 뜻의 번호(뜻에 든 가장 앞 질문의 순번). 같은 뜻의 질문은 한 글에
 * 넣지 않고, 같은 뜻의 조합은 두 글이 맡지 않고, 한 작성자가 같은 뜻을 두 번 맡지 않는다 — 바꿔 쓴 질문은 사실상 같은 질문이라 글이
 * 같아진다.
 */
export function intentsOf(ids: string[], avoid: [string, string][]): number[] {
  const index = new Map(ids.map((id, i) => [id, i] as const))
  const parent = range(ids.length)
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i]!)))
  for (const [a, b] of avoid) {
    const i = index.get(a)
    const j = index.get(b)
    if (i === undefined || j === undefined) continue
    const [ri, rj] = [root(i), root(j)]
    if (ri !== rj) parent[Math.max(ri, rj)] = Math.min(ri, rj)
  }
  return ids.map((_, i) => root(i))
}

// ── 배정(그래프 · 색칠) ──────────────────────────────────────────────────────
export interface AllocationInput {
  pool: PoolQuestion[]
  clusters: Cluster[]
  /** 같은 뜻으로 볼 짝(바꿔 쓴 질문 — paraphrasePairs). */
  avoid: [string, string][]
  writers: number
  perWriter: number
  seed: number
}

/** 배정한 글 하나 — 작성자 순번(0부터)과 정렬한 질문 id 두 개. */
export interface AllocatedArticle {
  writer: number
  questionIds: [string, string]
}

export type Allocation = { ok: true; articles: AllocatedArticle[]; score: number } | { ok: false; error: string }

type Edge = [number, number]

/**
 * 질문 조합과 작성자를 정한다 — 파일을 읽지도 쓰지도 않는다. 같은 입력이면 늘 같은 결과다.
 *   질문마다 글 수: 전체 칸(작성자 × 글 수 × 2)을 질문 수로 나눈 몫, 나머지만큼의 질문은 하나 더(시드로 고른 뒤 옮기기로 바뀔 수 있다).
 *   조합: 뜻(intentsOf) 위의 단순 그래프(같은 뜻의 조합 없음 → 같은 질문 조합 없음 · 두 글의 겹침 ≤ 1)로 만들고 묶음 점수를 올린다.
 *   작성자: 뜻 그래프의 간선 색칠 — 한 뜻(한 질문)의 글은 모두 다른 작성자, 작성자마다 정확히 perWriter편. 묶음 점수가 높은 그래프부터
 *   칠해 보고 처음 칠해지는 것을 쓴다.
 */
export function allocateQuestions(input: AllocationInput): Allocation {
  const { pool, writers: W, perWriter: k } = input
  const n = pool.length
  const m = W * k
  if (W < 1 || k < 1) return { ok: false, error: '작성자 수와 작성자마다 글 수는 1 이상이어야 합니다.' }
  if (n < QUESTIONS_PER_ARTICLE * k) {
    return { ok: false, error: `글을 쓸 질문이 ${n}개라 작성자 한 명의 글 ${k}편(질문 ${QUESTIONS_PER_ARTICLE * k}개)을 서로 다른 질문으로 채울 수 없습니다.` }
  }
  // 질문 수가 2k 이상이면 질문마다 글 수(올림 2Wk/n)는 작성자 수 W를 넘지 않는다 — 넘치는 경우는 위에서 이미 걸렀다.
  const total = QUESTIONS_PER_ARTICLE * m
  const base = Math.floor(total / n)
  const extra = total % n
  const index = new Map(pool.map((q, i) => [q.questionId, i] as const))
  const intent = intentsOf(pool.map((q) => q.questionId), input.avoid)
  const intents = new Set(intent).size
  if ((intents * (intents - 1)) / 2 < m) return { ok: false, error: `서로 다른 질문 조합(바꿔 쓴 질문은 같은 뜻으로 봄)이 ${m}개보다 적습니다.` }
  /** 뜻 조합의 열쇠 — 같은 뜻 조합의 글은 하나만. */
  const key = (i: number, j: number) => {
    const [a, b] = [intent[i]!, intent[j]!]
    return a < b ? a * n + b : b * n + a
  }
  const same = (i: number, j: number) => intent[i] === intent[j]
  const clusterOf = clusterIndex(input.clusters)
  const aff = range(n).map((i) => range(n).map((j) => (i === j ? 0 : affinity(pool[i]!, pool[j]!, clusterOf))))
  const rand = mulberry32(input.seed)

  const graphs: { edges: Edge[]; score: number }[] = []
  for (let r = 0; r < RESTARTS; r += 1) {
    const order = shuffle(range(n), rand)
    const target = new Array<number>(n).fill(base)
    for (let x = 0; x < extra; x += 1) target[order[x]!] = base + 1
    const edges = startGraph(target, same, aff, key, rand)
    if (!edges) continue
    graphs.push({ edges, score: improveGraph(edges, n, base, extra > 0, same, aff, key, rand) })
  }
  if (graphs.length === 0) return { ok: false, error: '질문 조합을 만들지 못했습니다 — 바꿔 쓴 질문(같은 뜻)이 너무 많습니다.' }
  // 점수가 높은 그래프부터(같으면 먼저 만든 것) 칠해 본다 — sort는 안정 정렬이다.
  graphs.sort((a, b) => b.score - a.score)
  let best: { edges: Edge[]; score: number; color: number[] } | null = null
  for (const g of graphs) {
    const color = colorEdges(
      g.edges.map(([i, j]): Edge => [intent[i]!, intent[j]!]),
      n,
      W,
      k,
      rand,
    )
    if (color) {
      best = { ...g, color }
      break
    }
  }
  if (!best) return { ok: false, error: `작성자 ${W}명에게 ${k}편씩, 한 작성자가 같은 질문(같은 뜻)을 두 번 맡지 않게 나누지 못했습니다.` }
  const { color } = best
  const articles = best.edges.map(([i, j], e): AllocatedArticle => {
    const ids = [pool[i]!.questionId, pool[j]!.questionId].sort() as [string, string]
    return { writer: color[e]!, questionIds: ids }
  })
  // 작성자 순, 작성자 안에서는 질문지 순.
  const pos = (a: AllocatedArticle) => [index.get(a.questionIds[0])!, index.get(a.questionIds[1])!].sort((x, y) => x - y)
  articles.sort((a, b) => {
    if (a.writer !== b.writer) return a.writer - b.writer
    const [a0, a1] = pos(a)
    const [b0, b1] = pos(b)
    return a0! - b0! || a1! - b1!
  })
  return { ok: true, articles, score: best.score }
}

/**
 * Havel–Hakimi — 남은 글 수가 가장 많은 질문을 남은 글 수가 많은(같으면 묶음 점수가 높은) 질문과 잇는다. 같은 뜻끼리(same) · 이미 있는
 * 뜻 조합(key)은 잇지 않는다. 막히면 순서를 바꿔 다시.
 */
function startGraph(
  target: number[],
  same: (i: number, j: number) => boolean,
  aff: number[][],
  key: (i: number, j: number) => number,
  rand: () => number,
): Edge[] | null {
  const n = target.length
  for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
    const rank = new Array<number>(n)
    shuffle(range(n), rand).forEach((v, r) => (rank[v] = r))
    const rem = [...target]
    const has = new Set<number>()
    const edges: Edge[] = []
    let stuck = false
    for (;;) {
      let v = -1
      for (let i = 0; i < n; i += 1) {
        if (rem[i]! > 0 && (v < 0 || rem[i]! > rem[v]! || (rem[i] === rem[v] && rank[i]! < rank[v]!))) v = i
      }
      if (v < 0) break
      const cands = range(n)
        .filter((u) => u !== v && rem[u]! > 0 && !same(u, v) && !has.has(key(u, v)))
        .sort((a, b) => rem[b]! - rem[a]! || aff[v]![b]! - aff[v]![a]! || rank[a]! - rank[b]!)
      // 하나씩 다시 본다 — 같은 뜻의 두 질문(바꿔 쓴 짝)이 함께 후보에 있으면 v와의 뜻 조합이 같아 하나만 이을 수 있다.
      for (const u of cands) {
        if (rem[v] === 0) break
        if (has.has(key(u, v))) continue
        edges.push(v < u ? [v, u] : [u, v])
        has.add(key(u, v))
        rem[u]! -= 1
        rem[v]! -= 1
      }
      if (rem[v]! > 0) {
        stuck = true
        break
      }
    }
    if (!stuck) return edges
  }
  return null
}

/**
 * 묶음 점수를 올린다 — 더 오를 곳이 없을 때까지 처음 찾은 개선을 바로 쓴다(점수는 정수라 끝난다). 질문마다 글 수는 base 또는
 * base + 1(movable)로 지킨다. edges를 고쳐 쓰고 최종 점수를 돌려준다.
 *   짝 바꾸기: (a,b)(c,d) → (a,c)(b,d) 또는 (a,d)(b,c) — 질문마다 글 수가 그대로다.
 *   옮기기: (a,b) → (a,c) — b가 base + 1, c가 base일 때만(둘의 글 수가 맞바뀐다).
 */
function improveGraph(
  edges: Edge[],
  n: number,
  base: number,
  movable: boolean,
  same: (i: number, j: number) => boolean,
  aff: number[][],
  key: (i: number, j: number) => number,
  rand: () => number,
): number {
  const has = new Set(edges.map(([i, j]) => key(i, j)))
  const deg = new Array<number>(n).fill(0)
  for (const [i, j] of edges) {
    deg[i]! += 1
    deg[j]! += 1
  }
  const free = (i: number, j: number) => i !== j && !same(i, j) && !has.has(key(i, j))
  const set = (e: number, i: number, j: number) => {
    has.delete(key(edges[e]![0], edges[e]![1]))
    edges[e] = i < j ? [i, j] : [j, i]
    has.add(key(i, j))
  }
  const tryOnce = (order: number[], vertices: number[]): boolean => {
    for (let x = 0; x < order.length; x += 1) {
      const e1 = order[x]!
      for (let y = x + 1; y < order.length; y += 1) {
        const e2 = order[y]!
        const [a, b] = edges[e1]!
        const [c, d] = edges[e2]!
        if (a === c || a === d || b === c || b === d) continue
        const now = aff[a]![b]! + aff[c]![d]!
        for (const [p, q, r, s] of [[a, c, b, d], [a, d, b, c]] as const) {
          if (!free(p, q) || !free(r, s) || key(p, q) === key(r, s)) continue
          if (aff[p]![q]! + aff[r]![s]! > now) {
            has.delete(key(a, b))
            has.delete(key(c, d))
            edges[e1] = p < q ? [p, q] : [q, p]
            edges[e2] = r < s ? [r, s] : [s, r]
            has.add(key(p, q))
            has.add(key(r, s))
            return true
          }
        }
      }
      if (!movable) continue
      const [a, b] = edges[e1]!
      for (const [keep, drop] of [[a, b], [b, a]] as const) {
        if (deg[drop] !== base + 1) continue
        for (const c of vertices) {
          if (deg[c] !== base || c === drop || !free(keep, c)) continue
          if (aff[keep]![c]! > aff[keep]![drop]!) {
            set(e1, keep, c)
            deg[drop]! -= 1
            deg[c]! += 1
            return true
          }
        }
      }
    }
    return false
  }
  for (;;) {
    if (!tryOnce(shuffle(range(edges.length), rand), shuffle(range(n), rand))) break
  }
  return edges.reduce((s, [i, j]) => s + aff[i]![j]!, 0)
}

/** 색칠 되돌아가기 상한 — 넘으면 그 그래프는 포기하고 다음 그래프를 칠한다. */
const COLOR_NODE_LIMIT = 200_000

/**
 * 간선 색칠 — 색 = 작성자. 한 꼭짓점(뜻)의 글은 모두 다른 색이고 색마다 정확히 k개. 먼저 남은 색이 가장 적은 간선부터 칠하며 막히면
 * 되돌아가고(DSATUR — 한 뜻의 글 수가 작성자 수와 같아도 칠한다), 많은 색과 적은 색의 두 색 사슬(Kempe 사슬) 가운데 많은 색이 더 많은
 * 길을 뒤집어 하나씩 옮긴다 — 뒤집어도 한 꼭짓점에 같은 색이 둘이 되지 않는다. 칠하지 못하면 null.
 */
function colorEdges(edges: Edge[], n: number, W: number, k: number, rand: () => number): number[] | null {
  const m = edges.length
  const at = range(n).map(() => new Array<number>(W).fill(-1))
  const size = new Array<number>(W).fill(0)
  const color = new Array<number>(m).fill(-1)
  const paint = (e: number, c: number) => {
    color[e] = c
    at[edges[e]![0]]![c] = e
    at[edges[e]![1]]![c] = e
    size[c]! += 1
  }
  const unpaint = (e: number) => {
    const c = color[e]!
    at[edges[e]![0]]![c] = -1
    at[edges[e]![1]]![c] = -1
    size[c]! -= 1
    color[e] = -1
  }
  const deg = new Array<number>(n).fill(0)
  for (const [a, b] of edges) {
    deg[a]! += 1
    deg[b]! += 1
  }
  const rank = new Array<number>(m)
  shuffle(range(m), rand).forEach((e, r) => (rank[e] = r))
  const free = (e: number) => range(W).filter((c) => at[edges[e]![0]]![c]! < 0 && at[edges[e]![1]]![c]! < 0)
  let nodes = 0
  const solve = (left: number): boolean => {
    if (left === 0) return true
    nodes += 1
    if (nodes > COLOR_NODE_LIMIT) return false
    let pick = -1
    let options: number[] = []
    let pickDeg = 0
    for (let e = 0; e < m; e += 1) {
      if (color[e]! >= 0) continue
      const f = free(e)
      if (f.length === 0) return false
      const d = deg[edges[e]![0]]! + deg[edges[e]![1]]!
      if (pick < 0 || f.length < options.length || (f.length === options.length && (d > pickDeg || (d === pickDeg && rank[e]! < rank[pick]!)))) {
        pick = e
        options = f
        pickDeg = d
      }
    }
    // 글이 적은 작성자부터 — 나중에 고르게 맞출 일이 줄어든다.
    for (const c of options.sort((a, b) => size[a]! - size[b]! || a - b)) {
      paint(pick, c)
      if (solve(left - 1)) return true
      unpaint(pick)
    }
    return false
  }
  if (!solve(m)) return null
  for (let guard = 0; guard <= m * W; guard += 1) {
    const big = size.findIndex((s) => s > k)
    if (big < 0) return color
    const small = size.findIndex((s) => s < k)
    if (small < 0) return null
    let moved = false
    const seen = new Set<number>()
    for (let start = 0; start < m && !moved; start += 1) {
      if (color[start] !== big || seen.has(start)) continue
      const comp = [start]
      seen.add(start)
      for (let x = 0; x < comp.length; x += 1) {
        for (const v of edges[comp[x]!]!) {
          for (const c of [big, small]) {
            const f = at[v]![c]!
            if (f >= 0 && !seen.has(f)) {
              seen.add(f)
              comp.push(f)
            }
          }
        }
      }
      const bigCount = comp.filter((e) => color[e] === big).length
      if (bigCount <= comp.length - bigCount) continue
      for (const e of comp) {
        at[edges[e]![0]]![color[e]!] = -1
        at[edges[e]![1]]![color[e]!] = -1
        size[color[e]!]! -= 1
      }
      for (const e of comp) paint(e, color[e] === big ? small : big)
      moved = true
    }
    if (!moved) return null
  }
  return null
}

// ── 규칙 검사 · 보고서 ──────────────────────────────────────────────────────
export interface RuleInput {
  pool: PoolQuestion[]
  avoid: [string, string][]
  writerKeys: string[]
  perWriter: number
  articles: { id: string; writerKey: string; questionIds: string[] }[]
}

/** 규칙 (1)~(5)와 질문 · 짝 검사 — 위반 문장 목록(없으면 빈 목록). 배정을 만든 함수와 따로 센다. */
export function checkWriterRules(input: RuleInput): string[] {
  const out: string[] = []
  const inPool = new Set(input.pool.map((q) => q.questionId))
  const poolIds = input.pool.map((q) => q.questionId)
  const intentIndex = intentsOf(poolIds, input.avoid)
  /** 질문 id → 뜻(바꿔 쓴 질문 짝은 같은 뜻). 글을 쓸 질문이 아니면 id 그대로. */
  const intentOf = (q: string) => {
    const i = poolIds.indexOf(q)
    return i < 0 ? q : poolIds[intentIndex[i]!]!
  }
  const ids = new Set<string>()
  const intentPairs = new Map<string, string>()
  for (const a of input.articles) {
    if (a.questionIds.length !== QUESTIONS_PER_ARTICLE || new Set(a.questionIds).size !== QUESTIONS_PER_ARTICLE) out.push(`${a.id}: 서로 다른 질문 ${QUESTIONS_PER_ARTICLE}개가 아닙니다.`)
    const off = a.questionIds.filter((q) => !inPool.has(q))
    if (off.length) out.push(`${a.id}: 글을 쓸 질문이 아닌 ${off.join(', ')}`)
    if (a.id !== topicArticleId(a.questionIds)) out.push(`${a.id}: 글 id가 질문 조합과 다릅니다.`)
    if (ids.has(a.id)) out.push(`(1) 같은 질문 조합의 글이 두 번: ${a.id}`)
    ids.add(a.id)
    const meaning = a.questionIds.map(intentOf).sort()
    if (new Set(meaning).size < meaning.length) out.push(`${a.id}: 바꿔 쓴 질문 짝(같은 뜻)을 한 글에 넣었습니다.`)
    const pairKey = meaning.join('+')
    const twin = intentPairs.get(pairKey)
    if (twin && twin !== a.id) out.push(`(1) 같은 뜻의 질문 조합(바꿔 쓴 질문은 같은 뜻)의 글이 두 번: ${twin} · ${a.id}`)
    else intentPairs.set(pairKey, a.id)
  }
  for (let x = 0; x < input.articles.length; x += 1) {
    const mine = new Set(input.articles[x]!.questionIds)
    for (let y = x + 1; y < input.articles.length; y += 1) {
      const shared = input.articles[y]!.questionIds.filter((q) => mine.has(q)).length
      if (shared > 1) out.push(`(2) 두 글이 질문 ${shared}개를 함께 맡습니다: ${input.articles[x]!.id} · ${input.articles[y]!.id}`)
    }
  }
  for (const key of input.writerKeys) {
    const mine = input.articles.filter((a) => a.writerKey === key)
    const qs = mine.flatMap((a) => a.questionIds)
    const twice = [...new Set(qs.filter((q, i) => qs.indexOf(q) !== i))]
    if (twice.length) out.push(`(3) 작성자 ${key}가 같은 질문을 두 번 맡습니다: ${twice.join(', ')}`)
    const meanings = qs.map(intentOf)
    const twins = [...new Set(qs.filter((q, i) => meanings.indexOf(meanings[i]!) !== i && !twice.includes(q)))]
    if (twins.length) out.push(`(3) 작성자 ${key}가 바꿔 쓴 질문(같은 뜻)을 두 번 맡습니다: ${twins.join(', ')}`)
    if (mine.length !== input.perWriter) out.push(`(5) 작성자 ${key}의 글이 ${mine.length}편입니다(${input.perWriter}편이어야 함).`)
  }
  const unknown = [...new Set(input.articles.map((a) => a.writerKey).filter((k) => !input.writerKeys.includes(k)))]
  if (unknown.length) out.push(`작성자 설정에 없는 작성자: ${unknown.join(', ')}`)
  const counts = input.pool.map((q) => input.articles.filter((a) => a.questionIds.includes(q.questionId)).length)
  if (counts.length && Math.max(...counts) - Math.min(...counts) > 1) out.push(`(4) 질문마다 글 수가 고르지 않습니다(최소 ${Math.min(...counts)} · 최대 ${Math.max(...counts)}).`)
  return out
}

export interface CoverageReport {
  questions: number
  articles: number
  /** 질문지 순서. */
  perQuestion: { questionId: string; count: number; writers: string[] }[]
  min: number
  max: number
  /** 글 수 → 그만큼 맡은 질문 수. */
  histogram: Record<number, number>
  perWriter: { key: string; articles: number; questions: number }[]
  kinds: Record<PairKind, number>
  /** 두 글이 함께 맡는 질문 수의 최댓값. */
  maxOverlap: number
  violations: string[]
}

export function coverageReport(input: RuleInput & { clusters: Cluster[] }): CoverageReport {
  const clusterOf = clusterIndex(input.clusters)
  const byId = new Map(input.pool.map((q) => [q.questionId, q] as const))
  const perQuestion = input.pool.map((q) => {
    const mine = input.articles.filter((a) => a.questionIds.includes(q.questionId))
    return { questionId: q.questionId, count: mine.length, writers: mine.map((a) => a.writerKey) }
  })
  const counts = perQuestion.map((q) => q.count)
  const histogram: Record<number, number> = {}
  for (const c of counts) histogram[c] = (histogram[c] ?? 0) + 1
  const kinds: Record<PairKind, number> = { cluster: 0, topic: 0, stage: 0, other: 0 }
  for (const a of input.articles) {
    const [x, y] = a.questionIds.map((id) => byId.get(id))
    if (x && y) kinds[pairKind(x, y, clusterOf)] += 1
  }
  let maxOverlap = 0
  for (let x = 0; x < input.articles.length; x += 1) {
    const mine = new Set(input.articles[x]!.questionIds)
    for (let y = x + 1; y < input.articles.length; y += 1) {
      maxOverlap = Math.max(maxOverlap, input.articles[y]!.questionIds.filter((q) => mine.has(q)).length)
    }
  }
  return {
    questions: input.pool.length,
    articles: input.articles.length,
    perQuestion,
    min: counts.length ? Math.min(...counts) : 0,
    max: counts.length ? Math.max(...counts) : 0,
    histogram,
    perWriter: input.writerKeys.map((key) => {
      const mine = input.articles.filter((a) => a.writerKey === key)
      return { key, articles: mine.length, questions: new Set(mine.flatMap((a) => a.questionIds)).size }
    }),
    kinds,
    maxOverlap,
    violations: checkWriterRules(input),
  }
}

// ── 이름 ────────────────────────────────────────────────────────────────────
const NAME_MAX = 60

/**
 * 「<주제><번호> (<label>)」 — 60자를 넘으면 주제만 줄인다. 번호(suffix)는 줄이지 않는다 — 줄이면 번호가 달라도 이름이 같아져
 * suggestName의 번호 붙이기가 끝나지 않는다.
 */
function nameOf(phrase: string, label: string, suffix = ''): string {
  const tail = `${suffix} (${label})`
  const s = `${phrase}${tail}`.replace(/\s+/g, ' ').trim()
  if (s.length <= NAME_MAX) return s
  return `${phrase.slice(0, Math.max(1, NAME_MAX - tail.length - 1)).trimEnd()}…${tail}`.replace(/\s+/g, ' ').trim()
}

/**
 * 글 이름 제안 — 같은 의미 묶음이면 묶음 이름, 같은 주제면 그 주제, 아니면 「주제 · 주제」. 브랜드 안에서 이미 쓴 이름이면 다른 후보,
 * 그래도 겹치면 번호를 붙인다. used에 고른 이름을 더한다.
 */
export function suggestName(a: PoolQuestion, b: PoolQuestion, label: string, clusterOf: Map<string, string>, used: Set<string>): string {
  const ta = a.topic ?? a.questionId
  const tb = b.topic ?? b.questionId
  const ca = clusterOf.get(a.questionId)
  const phrases = [
    ...(ca !== undefined && ca === clusterOf.get(b.questionId) ? [ca] : []),
    ta === tb ? ta : `${ta} · ${tb}`,
    ...(ta === tb ? [] : [`${tb} · ${ta}`]),
  ]
  for (const p of phrases) {
    const name = nameOf(p, label)
    if (!used.has(name)) {
      used.add(name)
      return name
    }
  }
  // 번호가 다르면 이름이 다르므로(nameOf는 번호를 줄이지 않는다) used가 아무리 커도 끝난다.
  for (let i = 2; ; i += 1) {
    const name = nameOf(phrases[0]!, label, ` ${i}`)
    if (!used.has(name)) {
      used.add(name)
      return name
    }
  }
}

// ── 배정 파일 ───────────────────────────────────────────────────────────────
export interface WriterPlanInput {
  tenantId: string
  /** 배정할 판 — 질문지 파일의 version과 같아야 한다. */
  bankVersion: string
  bank: { version: string; questions: BankQuestion[] }
  /** 글을 쓰지 않을 질문(설계 ineligible). */
  excluded: string[]
  clusters: Cluster[]
  /** 같은 뜻으로 볼 짝(paraphrasePairs). */
  avoid: [string, string][]
  writers: WriterSpec[]
  perWriter: number
  /** 배정 시드 — 브랜드 난수는 FNV-1a("<seed>:<tenantId>"). */
  seed: number
  activeUntil: string
  /** 작성자 설정 경로(저장소 기준) — 파일에 출처로 남긴다. */
  writersSource: string
  /** 이 브랜드의 글 id → 주제 이름(자동 제안을 덮어쓴다). */
  names: Record<string, string>
}

export interface WriterPlanBuild {
  /** 검사를 모두 통과했을 때만. */
  plan: WriterPlan | null
  errors: string[]
  report: CoverageReport | null
  pool: PoolQuestion[]
  /** 이름을 덮어쓴 글 수. */
  overridden: number
}

/** 작성자 설정 검사 — 오류 문장 목록. */
export function writersErrors(writers: WriterSpec[]): string[] {
  const out: string[] = []
  if (writers.length === 0) out.push('작성자가 없습니다.')
  const keys = new Set<string>()
  for (const [i, w] of writers.entries()) {
    const where = `작성자 ${i + 1}(${String(w?.key)})`
    if (!w || typeof w !== 'object') {
      out.push(`${where}: 모양이 틀렸습니다.`)
      continue
    }
    if (typeof w.key !== 'string' || !/^[A-Za-z0-9_-]+$/.test(w.key) || w.key.length > WRITER_LIMITS.key) out.push(`${where}: key가 틀렸습니다.`)
    else if (keys.has(w.key)) out.push(`${where}: 같은 key가 두 번 있습니다.`)
    else keys.add(w.key)
    const line = (v: unknown) => typeof v === 'string' && v.trim() !== '' && v === v.replace(/\s+/g, ' ').trim()
    if (!line(w.name) || w.name.length > WRITER_LIMITS.writerName) out.push(`${where}: 이름(name)이 비었거나 ${WRITER_LIMITS.writerName}자를 넘거나 공백이 더 있습니다.`)
    if (!line(w.label)) out.push(`${where}: 짧은 각도(label)가 비었거나 공백이 더 있습니다.`)
    if (!line(w.angle)) out.push(`${where}: 각도(angle)가 비었거나 공백이 더 있습니다.`)
    if (typeof w.blog !== 'string' || w.blog !== w.blog.trim() || w.blog.length > WRITER_LIMITS.blog) out.push(`${where}: 블로그(blog)가 틀렸습니다(모르면 빈 글자).`)
  }
  return out
}

/**
 * 한 브랜드의 작성자 배정을 만든다 — 파일을 읽지도 쓰지도 않는다. 질문 고르기 → 배정(allocateQuestions) → 규칙 검사(checkWriterRules) →
 * 이름 → parseWriterPlan. 하나라도 걸리면 plan은 null이고 errors에 이유가 있다.
 */
export function buildWriterPlan(input: WriterPlanInput): WriterPlanBuild {
  const errors: string[] = []
  if (input.bank.version !== input.bankVersion) errors.push(`질문지 파일의 판(${input.bank.version})이 배정할 판(${input.bankVersion})과 다릅니다.`)
  errors.push(...writersErrors(input.writers))
  const { pool, errors: poolErrors } = writerPool(input.bank.questions, input.excluded)
  errors.push(...poolErrors)
  const bankIds = new Set(input.bank.questions.map((q) => q.questionId))
  for (const c of input.clusters) {
    const missing = c.ids.filter((id) => !bankIds.has(id))
    if (missing.length) errors.push(`의미 묶음 「${c.name}」의 ${missing.join(', ')}가 질문지에 없습니다.`)
  }
  if (errors.length) return { plan: null, errors, report: null, pool, overridden: 0 }

  const allocation = allocateQuestions({
    pool,
    clusters: input.clusters,
    avoid: input.avoid,
    writers: input.writers.length,
    perWriter: input.perWriter,
    seed: fnv1a(`${input.seed}:${input.tenantId}`),
  })
  if (!allocation.ok) return { plan: null, errors: [allocation.error], report: null, pool, overridden: 0 }

  const byId = new Map(pool.map((q) => [q.questionId, q] as const))
  const clusterOf = clusterIndex(input.clusters)
  const used = new Set<string>(Object.values(input.names).map((s) => s.replace(/\s+/g, ' ').trim()))
  const ids = new Set(allocation.articles.map((a) => topicArticleId(a.questionIds)))
  const strayNames = Object.keys(input.names).filter((id) => !ids.has(id))
  for (const id of strayNames) errors.push(`이름 파일의 ${id}는 이 브랜드 배정의 글이 아닙니다.`)
  let overridden = 0
  const articles: WriterPlanArticle[] = allocation.articles.map((a) => {
    const w = input.writers[a.writer]!
    const id = topicArticleId(a.questionIds)
    const [qa, qb] = a.questionIds.map((q) => byId.get(q)!)
    let name: string
    if (Object.hasOwn(input.names, id)) {
      name = input.names[id]!
      overridden += 1
    } else {
      name = suggestName(qa!, qb!, w.label, clusterOf, used)
    }
    return {
      id,
      name,
      angle: w.angle,
      writer: { key: w.key, name: w.name },
      blog: w.blog,
      questionIds: [...a.questionIds],
      questionTexts: a.questionIds.map((q) => byId.get(q)!.text),
    }
  })
  const ruleInput: RuleInput & { clusters: Cluster[] } = {
    pool,
    avoid: input.avoid,
    writerKeys: input.writers.map((w) => w.key),
    perWriter: input.perWriter,
    articles: articles.map((a) => ({ id: a.id, writerKey: a.writer.key, questionIds: a.questionIds })),
    clusters: input.clusters,
  }
  const report = coverageReport(ruleInput)
  errors.push(...report.violations)

  const plan: WriterPlan = {
    format: WRITER_PLAN_FORMAT,
    tenantId: input.tenantId,
    bankVersion: input.bankVersion,
    activeUntil: input.activeUntil,
    source: { writers: input.writersSource, seed: input.seed },
    articles,
  }
  const parsed = parseWriterPlan(JSON.parse(JSON.stringify(plan)))
  if (parsed.error !== undefined) errors.push(parsed.error)
  if (errors.length) return { plan: null, errors, report, pool, overridden }
  return { plan: parsed.plan!, errors: [], report, pool, overridden }
}

// ── 보고서 · 배정표 ─────────────────────────────────────────────────────────
const KIND_LABEL: Record<PairKind, string> = { cluster: '같은 의미 묶음', topic: '같은 주제', stage: '같은 단계', other: '그 밖' }

/** 겹침 보고서 줄 — 화면(dry-run)과 파일(overlap-report.md)이 같은 줄을 쓴다. */
export function reportLines(r: CoverageReport): string[] {
  const hist = Object.keys(r.histogram)
    .map(Number)
    .sort((a, b) => a - b)
    .map((c) => `${c}편 ${r.histogram[c]}개`)
    .join(' · ')
  return [
    `글을 쓸 질문 ${r.questions}개 · 글 ${r.articles}편 — 질문마다 글 ${r.min}~${r.max}편(${hist})`,
    `작성자: ${r.perWriter.map((w) => `${w.key} ${w.articles}편/질문 ${w.questions}개`).join(' · ')}`,
    `묶음: ${(Object.keys(r.kinds) as PairKind[]).map((k) => `${KIND_LABEL[k]} ${r.kinds[k]}`).join(' · ')}`,
    `두 글이 함께 맡는 질문 최대 ${r.maxOverlap}개 · 규칙 위반 ${r.violations.length}건`,
    ...r.violations.map((v) => `  ✗ ${v}`),
  ]
}

/** CSV 한 칸 — 쉼표·따옴표·줄바꿈이 있으면 따옴표로 감싼다(src/lib/answerInsights.ts와 같다). */
function csvCell(v: string | number): string {
  const s = String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const csvText = (rows: (string | number)[][]) => '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'

export interface HandoutBrand {
  tenantId: string
  brandName: string
  plan: WriterPlan
  report: CoverageReport
}

/**
 * 배정표 파일 — 작성자마다 <key>.md · <key>.csv(모든 브랜드의 그 작성자 글), 모든 글을 담은 all.csv, 겹침 보고서 overlap-report.md.
 * 엑셀이 한글을 깨뜨리지 않게 CSV에는 BOM을 붙인다.
 */
export function writerHandouts(brands: HandoutBrand[], writers: WriterSpec[]): { file: string; content: string }[] {
  const head = ['작성자', '작성자 이름', '브랜드', '브랜드 id', '질문지 판', '번호', '글 id', '글 이름', '질문 1 id', '질문 1', '질문 2 id', '질문 2', '각도', '블로그']
  const rowsOf = (key: string) =>
    brands.flatMap((b) =>
      b.plan.articles
        .filter((a) => a.writer.key === key)
        .map((a, i) => [key, a.writer.name, b.brandName, b.tenantId, b.plan.bankVersion, i + 1, a.id, a.name, a.questionIds[0]!, a.questionTexts[0]!, a.questionIds[1]!, a.questionTexts[1]!, a.angle, a.blog]),
    )
  const files: { file: string; content: string }[] = []
  for (const w of writers) {
    const lines = [
      `# ${w.key} · ${w.name} — 글 ${brands.reduce((s, b) => s + b.plan.articles.filter((a) => a.writer.key === w.key).length, 0)}편`,
      '',
      `- 각도: ${w.label} — ${w.angle}`,
      `- 블로그: ${w.blog || '(미정)'}`,
      '- 글마다 질문 2개에 모두 답해 주세요. 초안은 운영자가 앱에서 만들어 드리고, 올린 뒤 주소를 보내 주시면 됩니다.',
    ]
    for (const b of brands) {
      const mine = b.plan.articles.filter((a) => a.writer.key === w.key)
      lines.push('', `## ${b.brandName} (${b.tenantId} · 질문지 ${b.plan.bankVersion}) — ${mine.length}편`)
      mine.forEach((a, i) => {
        lines.push('', `### ${i + 1}. ${a.name}`, '', `- 글 id: \`${a.id}\``)
        a.questionIds.forEach((q, j) => lines.push(`- 질문 ${q}: ${a.questionTexts[j]}`))
      })
    }
    files.push({ file: `${w.key}.md`, content: lines.join('\r\n') + '\r\n' })
    files.push({ file: `${w.key}.csv`, content: csvText([head, ...rowsOf(w.key)]) })
  }
  files.push({ file: 'all.csv', content: csvText([head, ...writers.flatMap((w) => rowsOf(w.key))]) })
  const report = ['# 작성자 배정 겹침 보고서', '']
  for (const b of brands) {
    report.push(`## ${b.brandName} (${b.tenantId} · 질문지 ${b.plan.bankVersion} · 시드 ${b.plan.source.seed})`, '')
    report.push(...reportLines(b.report).map((l) => `- ${l.trim()}`), '')
    report.push('| 질문 | 글 수 | 작성자 |', '| --- | --- | --- |')
    for (const q of b.report.perQuestion) report.push(`| ${q.questionId} | ${q.count} | ${q.writers.join(' · ')} |`)
    report.push('')
  }
  files.push({ file: 'overlap-report.md', content: report.join('\r\n') })
  return files
}

/** 백업 폴더 이름 — 다른 편집의 백업(before-probe-plan-… · before-promote-…)과 같은 꼴. */
export function writerPlanBackupDirName(now: Date): string {
  return `before-writer-plan-${now.toISOString().replace(/[:.]/g, '-')}`
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
 * 배정 파일 쓰기 — 검사를 통과한 배정만 쓴다. 이미 있으면(실증 배정 포함) <tenantDir>/before-writer-plan-<시각>/에 복사한 뒤 원자적으로
 * 바꿔 쓰고, 다시 읽어 parseWriterPlan으로 같은 배정인지 확인한다. 그 자리에 백업이 이미 있으면 덮지 않고 멈춘다.
 */
export async function writeWriterPlanFile(input: { tenantDir: string; plan: WriterPlan; now: Date }): Promise<{ file: string; backupDir: string | null; plan: WriterPlan }> {
  const checked = parseWriterPlan(JSON.parse(JSON.stringify(input.plan)))
  if (checked.error !== undefined) throw new Error(`검사를 통과하지 못한 배정은 쓰지 않습니다: ${checked.error}`)
  const file = path.join(input.tenantDir, WRITER_PLAN_FILE)
  let backupDir: string | null = null
  if (await fileExists(file)) {
    backupDir = path.join(input.tenantDir, writerPlanBackupDirName(input.now))
    await mkdir(backupDir, { recursive: true })
    const backupFile = path.join(backupDir, WRITER_PLAN_FILE)
    await copyFile(file, backupFile, fsConstants.COPYFILE_EXCL).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'EEXIST') throw new Error(`백업 자리에 이미 파일이 있어 쓰지 않습니다(있는 백업을 덮지 않음): ${backupFile}`)
      throw err
    })
  }
  await writeJsonAtomic(file, checked.plan)
  const back = parseWriterPlan(JSON.parse(await readFile(file, 'utf-8')))
  const restore = backupDir ? ` — 백업에서 되돌리세요: ${path.join(backupDir, WRITER_PLAN_FILE)}` : ''
  if (back.error !== undefined) throw new Error(`쓴 배정 파일을 다시 읽지 못했습니다(${back.error})${restore}`)
  if (JSON.stringify(back.plan) !== JSON.stringify(checked.plan)) throw new Error(`쓴 배정 파일이 만든 배정과 다릅니다${restore}`)
  return { file, backupDir, plan: back.plan }
}

/** 배정할 질문지 — 판과 그 파일. */
export type WriterBankChoice =
  | { ok: true; version: string; file: string; from: 'requested' | 'configured' | 'newest'; bundled: boolean }
  | { ok: false; error: string }

/**
 * 배정할 질문지를 고른다(파일은 읽지 않는다). 판은 --bank-version, 없으면 측정이 쓰는 판(브랜드 목록의 설정 — 저장소 설정이 이긴다),
 * 브랜드 목록에 없으면 이 PC 질문지 폴더의 가장 높은 판. 파일은 이 PC 것을 먼저, 없으면 설치본에 동봉한 질문지(src/data/question-banks —
 * 측정이 그 판을 처음 읽을 때 이 PC로 가져온다, server/bundledBanks.ts). v0.4.49에서 저장소 설정이 web4ai v6 · gunsan v7로 올라도 운영
 * PC에는 그 판 파일이 측정 전까지 없다 — 동봉본으로 배정해야 앱이 그 판으로 잰 주에 배정 글을 만든다.
 */
export function chooseWriterBank(input: {
  requested?: string
  configured?: string
  localVersions: string[]
  localDir: string
  bundledDir: string
  exists?: (file: string) => boolean
}): WriterBankChoice {
  const exists = input.exists ?? existsSync
  const from = input.requested ? 'requested' : input.configured ? 'configured' : 'newest'
  const version = input.requested ?? input.configured ?? newestBankVersion(input.localVersions)
  if (!version) return { ok: false, error: `질문지가 없습니다: ${input.localDir}(v<N>.json)` }
  const local = path.join(input.localDir, `${version}.json`)
  if (input.localVersions.includes(version)) return { ok: true, version, file: local, from, bundled: false }
  const bundled = path.join(input.bundledDir, `${version}.json`)
  if (exists(bundled)) return { ok: true, version, file: bundled, from, bundled: true }
  return { ok: false, error: `질문지가 없습니다: ${local}(설치본 동봉본 ${bundled}도 없음)` }
}

/** 판 이름 가운데 가장 높은 v<N> — 없으면 null. */
export function newestBankVersion(versions: string[]): string | null {
  let best: { v: string; n: number } | null = null
  for (const v of versions) {
    const m = /^v(\d+)$/.exec(v)
    if (m && (!best || Number(m[1]) > best.n)) best = { v, n: Number(m[1]) }
  }
  return best?.v ?? null
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

/** 설계의 브랜드 한 줄 가운데 여기서 읽는 것. */
interface DesignBrand {
  tenantId: string
  ineligible?: { id: string; reason: string }[]
  clusters?: Cluster[]
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const VALUE_FLAGS = new Set(['--app-data', '--writers', '--design', '--seed', '--names', '--bank-version', '--active-until', '--out'])
  const BOOL_FLAGS = new Set(['--write', '--handouts'])
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const USAGE =
    '사용법: npx tsx scripts/writer-plan.ts [tenantId…] --app-data <dir> [--handouts] [--out <dir>] [--write] ' +
    '[--writers docs/writers.json] [--design docs/proof/design.json] [--seed N] [--names <이름 파일>] ' +
    '[--bank-version <tenantId>=<판> …] [--active-until YYYY-MM-DD]'
  const unknownFlag = args.find((x) => x.startsWith('--') && !VALUE_FLAGS.has(x) && !BOOL_FLAGS.has(x))
  if (unknownFlag) fail(`모르는 옵션입니다: ${unknownFlag}`, USAGE)
  const missingValue = args.findIndex((x, i) => VALUE_FLAGS.has(x) && (args[i + 1] === undefined || args[i + 1]!.startsWith('--')))
  if (missingValue >= 0) fail(`${args[missingValue]}에 값이 없습니다.`, USAGE)
  const positional = args.filter((x, i) => !x.startsWith('--') && !VALUE_FLAGS.has(args[i - 1] ?? ''))
  const write = args.includes('--write')
  const outFlag = flag('--out')
  const handouts = args.includes('--handouts') || outFlag !== undefined
  const rawAppData = flag('--app-data')
  if (!rawAppData) fail(USAGE)

  const expanded = expandEnvTokens(rawAppData)
  if (expanded !== rawAppData) console.log(`인자 확장: ${rawAppData} → ${expanded}`)
  const appData = path.resolve(expanded)
  if (!existsSync(appData)) fail(`앱 데이터 폴더가 없습니다: ${appData}`)
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const writersPath = path.resolve(flag('--writers') ?? path.join(repoRoot, 'docs', 'writers.json'))
  const designPath = path.resolve(flag('--design') ?? path.join(repoRoot, 'docs', 'proof', 'design.json'))
  const outDir = path.resolve(outFlag ?? path.join(repoRoot, 'docs', 'writers'))
  const rel = path.relative(repoRoot, writersPath)
  const writersSource = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : writersPath

  const seedFlag = flag('--seed')
  const seed = seedFlag === undefined ? WRITER_PLAN_SEED : Number(seedFlag)
  if (!Number.isSafeInteger(seed)) fail(`--seed는 정수여야 합니다: ${seedFlag}`)
  const activeUntil = flag('--active-until') ?? WRITER_ACTIVE_UNTIL
  // 2027-13-40처럼 없는 날짜는 Invalid Date라 toISOString이 예외를 던진다 — 그 전에 걸러 안내로 끝낸다.
  const until = new Date(`${activeUntil}T00:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(activeUntil) || Number.isNaN(until.getTime()) || until.toISOString().slice(0, 10) !== activeUntil) {
    fail(`--active-until은 YYYY-MM-DD여야 합니다: ${activeUntil}`)
  }
  const bankVersions = new Map<string, string>()
  args.forEach((x, i) => {
    if (x !== '--bank-version') return
    const m = /^([^=\s]+)=([^=\s]+)$/.exec(args[i + 1] ?? '')
    if (!m) fail(`--bank-version은 <tenantId>=<판> 꼴이어야 합니다: ${args[i + 1]}`)
    if (bankVersions.has(m[1]!)) fail(`--bank-version에 ${m[1]}가 두 번 있습니다.`)
    bankVersions.set(m[1]!, m[2]!)
  })

  const writersFile = readJsonFile<WritersFile>(writersPath, '작성자 설정')
  if (writersFile?.format !== WRITERS_FORMAT || !Array.isArray(writersFile.writers)) fail(`작성자 설정 형식이 ${WRITERS_FORMAT}가 아닙니다: ${writersPath}`)
  const writerProblems = writersErrors(writersFile.writers)
  if (writerProblems.length) fail(`작성자 설정이 틀렸습니다: ${writersPath}`, ...writerProblems.map((e) => `  - ${e}`))
  const writers = writersFile.writers
  const design = readJsonFile<{ brands?: DesignBrand[] }>(designPath, '설계 파일')
  const designBrands = Array.isArray(design.brands) ? design.brands : []

  let names: Record<string, Record<string, string>> = {}
  const namesFlag = flag('--names')
  if (namesFlag) {
    const raw = readJsonFile<unknown>(path.resolve(namesFlag), '이름 파일')
    const okShape =
      !!raw &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      Object.values(raw).every((m) => !!m && typeof m === 'object' && !Array.isArray(m) && Object.values(m).every((v) => typeof v === 'string'))
    if (!okShape) fail(`이름 파일은 { "브랜드 id": { "글 id": "주제 이름" } } 꼴이어야 합니다: ${namesFlag}`)
    names = raw as Record<string, Record<string, string>>
  }

  // 같은 브랜드를 두 번 주면 한 번만 본다 — 같은 시각으로 두 번 쓰면 두 번째 백업이 첫 백업을 덮는다.
  const tenantIds = [...new Set(positional.length ? positional : designBrands.map((b) => b.tenantId))]
  if (tenantIds.length === 0) fail('브랜드가 없습니다 — tenantId를 주거나 설계 파일에 brands를 두세요.', USAGE)
  const strayTenants = [...Object.keys(names), ...bankVersions.keys()].filter((t) => !tenantIds.includes(t))
  if (strayTenants.length) fail(`이름 파일 · --bank-version의 브랜드가 고른 브랜드에 없습니다: ${[...new Set(strayTenants)].join(', ')}`)

  // 로컬 앱 데이터만 읽는다 — .env에 Blob 토큰이 있으면 오버레이(브랜드 목록)를 클라우드에서 읽는다(tenantOverlay.ts).
  process.env.BLOB_READ_WRITE_TOKEN = ''
  process.env.BLOB_STORE_ID = ''
  // APP_DATA_DIR은 server/appPaths.ts가 모듈 로드 시점에 읽으므로, 그 전에 설정해야 한다.
  process.env.APP_DATA_DIR = appData
  const { loadRuntimeTenants } = await import('../server/tenantRegistry')
  const runtime = await loadRuntimeTenants()

  const virtualized = looksVirtualized(appData) || looksVirtualized(realpathSync.native(appData))
  console.log(`앱 데이터: ${appData}`)
  console.log(`작성자 설정: ${writersPath}${writersFile.placeholder ? ' (자리표시 — 이름 · 블로그를 채우고 placeholder를 지워야 --write)' : ''}`)
  console.log(`설계: ${designPath}`)
  console.log(`시드 ${seed} · 운영 기간 ~${activeUntil} · 작성자 ${writers.length}명 × ${PER_WRITER}편`)
  if (virtualized) console.warn('⚠ 이 셸의 가상화 사본(Packages\\Claude_…) 경로로 보입니다 — 실제 앱 데이터가 아닙니다.')

  const built: { tenantId: string; brandName: string; tenantDir: string; build: WriterPlanBuild }[] = []
  let problems = false
  for (const tenantId of tenantIds) {
    const tenantDir = path.join(appData, 'data', tenantId)
    const bankDir = path.join(tenantDir, 'question-bank')
    const tenant = runtime.find((t) => t.tenantId === tenantId)
    const brandName = tenant?.brandName ?? tenantId
    console.log(`\n■ ${tenantId}${tenant ? ` · ${brandName}` : ' (브랜드 목록에 없음 — 이름 대신 id를 씀)'}`)
    const files = existsSync(bankDir) ? readdirSync(bankDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length)) : []
    const choice = chooseWriterBank({
      requested: bankVersions.get(tenantId),
      configured: tenant?.questionBankVersion,
      localVersions: files,
      localDir: bankDir,
      bundledDir: path.join(repoRoot, 'src', 'data', 'question-banks', tenantId),
    })
    if (!choice.ok) {
      problems = true
      console.log(`  ✗ ${choice.error}`)
      continue
    }
    const { version } = choice
    const bankPath = choice.file
    const bank = readJsonFile<{ version: string; questions: BankQuestion[] }>(bankPath, '질문지')
    // 다른 판 질문지는 바꿔 쓴 질문 짝을 찾는 데만 쓴다 — 읽지 못한 판은 알리고 건너뛴다.
    const others: { questions: BankQuestion[] }[] = []
    for (const f of files.filter((x) => x !== version)) {
      const file = path.join(bankDir, `${f}.json`)
      try {
        const other = JSON.parse(readFileSync(file, 'utf8')) as { questions?: unknown }
        if (Array.isArray(other?.questions)) others.push({ questions: other.questions as BankQuestion[] })
      } catch (err) {
        console.warn(`  ⚠ 다른 판 질문지를 읽지 못해 바꿔 쓴 질문 짝을 찾는 데서 뺍니다: ${file} — ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    const designBrand = designBrands.find((b) => b.tenantId === tenantId)
    const excluded = (designBrand?.ineligible ?? []).map((e) => e.id)
    const clusters = designBrand?.clusters ?? []
    const { pool } = writerPool(bank.questions, excluded)
    const avoid = paraphrasePairs(pool, [bank, ...others])
    const build = buildWriterPlan({
      tenantId,
      bankVersion: version,
      bank,
      excluded,
      clusters,
      avoid,
      writers,
      perWriter: PER_WRITER,
      seed,
      activeUntil,
      writersSource,
      names: names[tenantId] ?? {},
    })
    built.push({ tenantId, brandName, tenantDir, build })

    const fromLabel = { requested: '', configured: ' (측정이 쓰는 판)', newest: ' (가장 높은 판)' }[choice.from]
    const bundledLabel = choice.bundled ? ' — 설치본 동봉본(이 PC에는 측정 때 가져옴)' : ''
    console.log(`  질문지 ${bankPath}${fromLabel}${bundledLabel}`)
    if (tenant && tenant.questionBankVersion !== version) {
      console.log(`  ⚠ 측정이 지금 쓰는 판은 ${tenant.questionBankVersion}입니다 — 앱은 ${version} 판으로 측정한 주에만 배정 글을 만듭니다.`)
    }
    console.log(`  글을 쓰지 않을 질문 ${excluded.length}개${excluded.length ? `: ${excluded.join(', ')}` : ''}`)
    console.log(`  의미 묶음 ${clusters.length}개 · 같은 뜻으로 볼 바꿔 쓴 질문 짝 ${avoid.length}개${avoid.length ? `: ${avoid.map((p) => p.join('↔')).join(', ')}` : ''}`)
    if (build.report) for (const line of reportLines(build.report)) console.log(`  ${line}`)
    if (build.plan) {
      console.log(`  이름: 자동 제안 ${build.plan.articles.length - build.overridden}편 · 이름 파일 ${build.overridden}편`)
      for (const w of writers) {
        const mine = build.plan.articles.filter((a) => a.writer.key === w.key)
        console.log(`  ${w.key} · ${w.name} (${w.label}) — ${mine.length}편`)
        for (const a of mine) console.log(`    ${a.name}  [${a.questionIds.join(' + ')}]`)
      }
    }
    const extraFile = path.join(tenantDir, 'extra-articles.json')
    if (existsSync(extraFile) && build.plan) {
      const alive = aliveExtraArticles(normalizeExtraArticles(readJsonFile<unknown>(extraFile, '추가 글 목록')))
      const planIds = new Set(build.plan.articles.map((a) => a.id))
      const sameId = alive.filter((a) => planIds.has(a.id)).map((a) => a.id)
      const aliveQs = new Set(alive.flatMap((a) => a.questionIds))
      const sharing = build.plan.articles.filter((a) => a.questionIds.some((q) => aliveQs.has(q))).length
      console.log(`  지금 추가 글(살아 있음) ${alive.length}편 — 배정과 같은 id ${sameId.length}편${sameId.length ? `(${sameId.join(', ')})` : ''} · 그 글의 질문을 함께 맡는 배정 글 ${sharing}편`)
    }
    const planFile = path.join(tenantDir, WRITER_PLAN_FILE)
    if (existsSync(planFile)) {
      const now = readJsonFile<{ format?: unknown }>(planFile, '배정 파일')
      console.log(`  배정 파일: ${planFile} — 있음(${String(now?.format)}) · 쓰면 before-writer-plan-<시각>/에 먼저 백업`)
    } else {
      console.log(`  배정 파일: ${planFile} — 없음(새로 씀)`)
    }
    for (const e of build.errors) console.log(`  ✗ ${e}`)
    if (build.errors.length) problems = true
  }

  if (handouts) {
    if (problems) fail('✗ 배정표를 쓰지 않았습니다 — 검사에 걸린 곳이 있습니다(위 ✗).')
    const files = writerHandouts(
      built.map((b) => ({ tenantId: b.tenantId, brandName: b.brandName, plan: b.build.plan!, report: b.build.report! })),
      writers,
    )
    await mkdir(outDir, { recursive: true })
    for (const f of files) await writeFile(path.join(outDir, f.file), f.content, 'utf8')
    console.log(`\n배정표 ${files.length}개: ${outDir} (${files.map((f) => f.file).join(', ')})`)
  }

  if (!write) {
    console.log('\ndry-run — 앱 데이터에는 아무것도 쓰지 않았습니다.')
    if (problems) fail('✗ 검사에 걸린 곳이 있습니다(위 ✗).')
    return
  }

  if (problems) fail('✗ 쓰지 않았습니다 — 검사에 걸린 곳이 있습니다(위 ✗).')
  if (writersFile.placeholder) fail(`✗ 쓰지 않았습니다 — 작성자 설정이 자리표시입니다. 이름 · 블로그를 채우고 "placeholder"를 지우세요: ${writersPath}`)
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
    let result: Awaited<ReturnType<typeof writeWriterPlanFile>>
    try {
      result = await writeWriterPlanFile({ tenantDir: b.tenantDir, plan: b.build.plan!, now })
    } catch (err) {
      fail(`✗ ${b.tenantId}: ${err instanceof Error ? err.message : String(err)}`)
    }
    const moved = [
      ...(await findRedirectedCopies(result.file, roots)),
      ...(result.backupDir ? await findRedirectedCopies(result.backupDir, roots) : []),
    ]
    if (moved.length > 0) fail(`✗ ${b.tenantId}: 배정 파일이 실제 폴더가 아닌 가상화 사본으로 갔습니다: ${moved.join(', ')}`)
    console.log(`\n저장: ${result.file}`)
    if (result.backupDir) console.log(`  백업: ${path.join(result.backupDir, WRITER_PLAN_FILE)}`)
    console.log(`  다시 읽음 — ${result.plan.bankVersion} 판 · 글 ${result.plan.articles.length}편 · 운영 기간 ~${result.plan.activeUntil}`)
  }
  console.log('\n앱은 이 파일을 요청마다 읽습니다 — 다시 켜지 않아도 됩니다. 질문지 · 추가 글은 건드리지 않았습니다.')
  console.log('⚠ 운영 모드(probe-plan/2를 읽는 앱, v0.4.49) 앞의 앱은 이 파일을 읽지 않습니다 — 잠금 · 작성자 단추 · 늘어난 추가 글 상한이 없습니다.')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
