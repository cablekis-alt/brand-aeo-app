/**
 * 추가 글 초안끼리 얼마나 비슷한지 본다 — 작성자 배정(src/lib/probePlan.ts probe-plan/2)으로 한 브랜드에 80편을 만들면 한 질문을 서너
 * 편이 함께 맡는다. 엔진이 같은 질문에 같은 문장을 되풀이하면 작성자 블로그 여러 곳에 거의 같은 글이 올라가 검색 · AI가 중복 글로
 * 보고 한 편만 남긴다. 올리기 전에 너무 비슷한 쌍을 찾아 한쪽을 다시 만들거나 각도를 바꾼다.
 *
 *   npx tsx scripts/draft-similarity.ts <tenantId> --app-data "<userData>" [--top 20] [--threshold 0.3] [--char-threshold 0.3] [--include-removed]
 *
 * 읽기만 한다(drafts.json · extra-articles.json · 있으면 probe-plan.json). 앱이 켜져 있어도 된다.
 *
 * 비교하는 글: 추가 글(topic:) 초안의 발행용 원고(src/lib/draftGaps.ts publishMarkdownOf — 빈칸 줄 · 쓴 사실 목록이 빠진, 복사 ·
 * .html과 같은 원고)에서 마크다운 기호 · 주소 · 사진 자리를 뗀 글자. 글 끝 상담 안내 · 태그는 발행 설정이 모든 글에 같게 붙이므로
 * 넣지 않는다. 살아 있는 추가 글과 배정 글만 보고, --include-removed면 목록에서 뺀 글의 초안도 본다.
 *
 * 비슷함 두 가지(자카드 = 겹치는 조각 수 / 합친 조각 수):
 *   - 단어 3-그램 — 연속한 세 낱말. 문장을 그대로 옮겨 쓴 정도다. 기준 --threshold(기본 0.3).
 *   - 글자 5-그램 — 띄어쓰기를 뺀 연속 다섯 글자. 조사 · 어미만 바꾼 문장도 잡는다. 기준 --char-threshold(기본 0.3).
 * 둘 중 하나라도 기준 이상이면 ⚠. 정렬은 기준에 얼마나 가까운가(두 값 ÷ 기준 중 큰 것) 순이다. 설치본의 서로 다른 블로그 글끼리는
 * 단어 0.04 · 글자 0.07을 넘지 않았다(2026-11-03, gunsan 4편 · web4ai 3편 — 같은 브랜드 · 같은 형식) — 기준은 그 네 배 남짓이다.
 *
 * 보고 순서: ① 같은 질문을 맡은 쌍(같은 질문이라 겹치기 쉽다) ② 그 밖의 쌍 — 각각 상위 --top개, 기준을 넘은 쌍은 모두.
 *
 * 글자 다듬기(plainText) · 조각(shingles) · 자카드(jaccard) · 보고(similarityReport)는 scripts/verify-draft-similarity.ts가 가짜 초안으로 부른다.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { looksVirtualized } from '../server/probeQuestions'
import type { StoredDraft } from '../src/lib/api'
import { publishMarkdownOf } from '../src/lib/draftGaps'
import { isExtraArticleId, normalizeExtraArticles } from '../src/lib/extraArticles'
import { parseWriterPlan, type WriterPlan } from '../src/lib/probePlan'

export const SIMILARITY_DEFAULTS = { top: 20, wordN: 3, charN: 5, wordThreshold: 0.3, charThreshold: 0.3 } as const

/** 비교할 글 하나. */
export interface SimilarityItem {
  id: string
  /** 주제 이름(추가 글 · 배정) — 없으면 초안 제목. */
  name: string
  /** 배정의 작성자 키(w1 …) — 배정이 없으면 null. */
  writer: string | null
  questionIds: string[]
  text: string
}

export interface SimilarityPair {
  a: SimilarityItem
  b: SimilarityItem
  /** 함께 맡은 질문 id. */
  shared: string[]
  word: number
  char: number
  /** 두 값 ÷ 기준 중 큰 것 — 1 이상이면 기준을 넘었다. */
  ratio: number
  flagged: boolean
}

/**
 * 발행용 원고 → 비교할 글자. 사진(`![…](…)`)은 사진 자리 안내라 빼고, 링크는 글자만 남기고, 맨 주소 · 마크다운 기호(# * > _ ` | ~ -)는
 * 공백으로. 남은 글자에서 낱말(글자 · 숫자의 이어진 줄)만 소문자로 뽑아 공백 하나로 잇는다.
 */
export function plainText(markdown: string): string {
  const stripped = markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
  return (stripped.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(' ')
}

/** 조각 — 'word'는 낱말 n개, 'char'는 띄어쓰기를 뺀 글자 n개. 글이 n보다 짧으면 글 전체가 조각 하나, 빈 글이면 빈 집합. */
export function shingles(text: string, kind: 'word' | 'char', n: number): Set<string> {
  const units = kind === 'word' ? text.split(' ').filter(Boolean) : [...text.replace(/ /g, '')]
  const out = new Set<string>()
  if (units.length === 0) return out
  if (units.length <= n) {
    out.add(units.join(kind === 'word' ? ' ' : ''))
    return out
  }
  for (let i = 0; i + n <= units.length; i += 1) out.add(units.slice(i, i + n).join(kind === 'word' ? ' ' : ''))
  return out
}

/** 자카드 — 둘 다 비면 0(빈 글끼리 같다고 하지 않는다). */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let both = 0
  for (const s of small) if (large.has(s)) both += 1
  return both / (a.size + b.size - both)
}

/** 'topic:a+b' → ['a', 'b']. */
export const questionIdsOf = (articleId: string): string[] => (isExtraArticleId(articleId) ? articleId.slice('topic:'.length).split('+').filter(Boolean) : [])

export interface SimilarityOptions {
  top: number
  wordN: number
  charN: number
  wordThreshold: number
  charThreshold: number
}

export interface SimilarityReport {
  /** 같은 질문을 맡은 쌍 전부(비슷한 순). */
  sharedPairs: SimilarityPair[]
  /** 그 밖의 쌍 전부(비슷한 순). */
  otherPairs: SimilarityPair[]
  /** 기준을 넘은 쌍 수. */
  flagged: number
}

/** 모든 쌍을 잰다(80편이면 3,160쌍 — 조각은 글마다 한 번만 만든다). */
export function similarityReport(items: SimilarityItem[], options: SimilarityOptions): SimilarityReport {
  const prepared = items.map((item) => ({
    item,
    words: shingles(item.text, 'word', options.wordN),
    chars: shingles(item.text, 'char', options.charN),
    questions: new Set(item.questionIds),
  }))
  const sharedPairs: SimilarityPair[] = []
  const otherPairs: SimilarityPair[] = []
  for (let i = 0; i < prepared.length; i += 1) {
    for (let j = i + 1; j < prepared.length; j += 1) {
      const x = prepared[i]!
      const y = prepared[j]!
      const word = jaccard(x.words, y.words)
      const char = jaccard(x.chars, y.chars)
      const ratio = Math.max(word / options.wordThreshold, char / options.charThreshold)
      const shared = y.item.questionIds.filter((q) => x.questions.has(q))
      const pair: SimilarityPair = { a: x.item, b: y.item, shared, word, char, ratio, flagged: ratio >= 1 }
      if (shared.length > 0) sharedPairs.push(pair)
      else otherPairs.push(pair)
    }
  }
  const order = (p: SimilarityPair, q: SimilarityPair) => q.ratio - p.ratio || q.word - p.word || p.a.id.localeCompare(q.a.id) || p.b.id.localeCompare(q.b.id)
  sharedPairs.sort(order)
  otherPairs.sort(order)
  return { sharedPairs, otherPairs, flagged: [...sharedPairs, ...otherPairs].filter((p) => p.flagged).length }
}

/** 보일 쌍 — 상위 top개, 기준을 넘은 쌍은 그보다 많아도 모두. */
export function pairsToShow(pairs: SimilarityPair[], top: number): SimilarityPair[] {
  return pairs.slice(0, Math.max(top, pairs.filter((p) => p.flagged).length))
}

/** 쌍 한 줄 — 「⚠ 단어 0.42 · 글자 0.61  w1 「이름」 ↔ w3 「이름」 · 같은 질문 c1-001」. */
export function pairLine(p: SimilarityPair): string {
  const who = (x: SimilarityItem) => `${x.writer ? `${x.writer} ` : ''}「${x.name}」`
  const shared = p.shared.length > 0 ? ` · 같은 질문 ${p.shared.join(', ')}` : ''
  return `${p.flagged ? '⚠' : ' '} 단어 ${p.word.toFixed(2)} · 글자 ${p.char.toFixed(2)}  ${who(p.a)} ↔ ${who(p.b)}${shared}`
}

/**
 * 비교할 글을 고른다 — 추가 글(topic:) 초안 중 살아 있는 추가 글 · 배정 글(includeRemoved면 모두). 이름은 추가 글 → 배정 → 초안 제목,
 * 작성자는 배정에서. 초안이 없는 배정 글 수도 돌려준다.
 */
export function similarityItems(input: {
  drafts: Record<string, StoredDraft>
  extras: ReturnType<typeof normalizeExtraArticles>
  plan: WriterPlan | null
  includeRemoved: boolean
}): { items: SimilarityItem[]; undrafted: number } {
  const planned = new Map((input.plan?.articles ?? []).map((a) => [a.id, a]))
  const defs = new Map(input.extras.map((x) => [x.id, x]))
  const items: SimilarityItem[] = []
  for (const [id, stored] of Object.entries(input.drafts)) {
    if (!isExtraArticleId(id)) continue
    const def = defs.get(id)
    const assigned = planned.get(id)
    if (!input.includeRemoved && !assigned && (!def || def.removedAt)) continue
    items.push({
      id,
      name: def?.name ?? assigned?.name ?? stored.draft.title,
      writer: assigned?.writer.key ?? null,
      questionIds: questionIdsOf(id),
      text: plainText(publishMarkdownOf(stored)),
    })
  }
  items.sort((x, y) => x.id.localeCompare(y.id))
  return { items, undrafted: [...planned.keys()].filter((id) => !input.drafts[id]).length }
}

// ── 실행 ────────────────────────────────────────────────────────────────────
function fail(...lines: string[]): never {
  for (const line of lines) console.error(line)
  process.exit(1)
}

function readJsonFile(file: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch (err) {
    fail(`✗ ${what}을 읽지 못했습니다: ${file} — ${err instanceof Error ? err.message : String(err)}`)
  }
}

function main(): void {
  const args = process.argv.slice(2)
  const VALUE_FLAGS = new Set(['--app-data', '--top', '--threshold', '--char-threshold'])
  const BOOL_FLAGS = new Set(['--include-removed'])
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const USAGE = '사용법: npx tsx scripts/draft-similarity.ts <tenantId> --app-data <dir> [--top 20] [--threshold 0.3] [--char-threshold 0.3] [--include-removed]'
  const unknownFlag = args.find((x) => x.startsWith('--') && !VALUE_FLAGS.has(x) && !BOOL_FLAGS.has(x))
  if (unknownFlag) fail(`모르는 옵션입니다: ${unknownFlag}`, USAGE)
  const tenantIds = [...new Set(args.filter((x, i) => !x.startsWith('--') && !VALUE_FLAGS.has(args[i - 1] ?? '')))]
  const rawAppData = flag('--app-data')
  if (!rawAppData || tenantIds.length !== 1) fail(USAGE)
  const tenantId = tenantIds[0]!
  const numberFlag = (name: string, fallback: number, ok: (n: number) => boolean): number => {
    const raw = flag(name)
    if (raw === undefined) return fallback
    const n = Number(raw)
    if (!Number.isFinite(n) || !ok(n)) fail(`${name} 값이 틀렸습니다: ${raw}`, USAGE)
    return n
  }
  const options: SimilarityOptions = {
    ...SIMILARITY_DEFAULTS,
    top: numberFlag('--top', SIMILARITY_DEFAULTS.top, (n) => Number.isInteger(n) && n >= 0),
    wordThreshold: numberFlag('--threshold', SIMILARITY_DEFAULTS.wordThreshold, (n) => n > 0 && n <= 1),
    charThreshold: numberFlag('--char-threshold', SIMILARITY_DEFAULTS.charThreshold, (n) => n > 0 && n <= 1),
  }

  const appData = path.resolve(rawAppData)
  const tenantDir = path.join(appData, 'data', tenantId)
  if (!existsSync(tenantDir)) fail(`브랜드 폴더가 없습니다: ${tenantDir}`)
  console.log(`앱 데이터: ${appData}`)
  if ([appData, realpathSync.native(appData)].some(looksVirtualized)) {
    console.warn('⚠ 이 셸의 가상화 사본(Packages\\Claude_…) 경로로 보입니다 — 실제 앱 데이터가 아니라 옛 사본일 수 있습니다.')
  }

  const draftsFile = path.join(tenantDir, 'drafts.json')
  const drafts = existsSync(draftsFile) ? (readJsonFile(draftsFile, '초안 파일') as Record<string, StoredDraft>) : {}
  const extrasFile = path.join(tenantDir, 'extra-articles.json')
  const extras = existsSync(extrasFile) ? normalizeExtraArticles(readJsonFile(extrasFile, '추가 글 목록')) : []
  const planFile = path.join(tenantDir, 'probe-plan.json')
  let plan: WriterPlan | null = null
  if (existsSync(planFile)) {
    const parsed = parseWriterPlan(readJsonFile(planFile, '배정 파일'))
    if (parsed.plan) plan = parsed.plan
    else console.warn(`⚠ 배정 파일을 읽지 못해 작성자 없이 봅니다: ${parsed.error}`)
  }

  const { items, undrafted } = similarityItems({ drafts, extras, plan, includeRemoved: args.includes('--include-removed') })
  const report = similarityReport(items, options)
  const pairCount = report.sharedPairs.length + report.otherPairs.length
  console.log(
    `\n■ ${tenantId} — 추가 글 초안 ${items.length}편${plan ? ` (배정 글 ${plan.articles.length}편 중 초안 없음 ${undrafted}편)` : ''} · ${pairCount}쌍`,
  )
  console.log(`기준: 단어 ${options.wordN}-그램 ${options.wordThreshold} 이상 또는 글자 ${options.charN}-그램 ${options.charThreshold} 이상이면 ⚠`)
  if (items.length < 2) {
    console.log('비교할 초안이 두 편보다 적습니다.')
    return
  }
  const shared = pairsToShow(report.sharedPairs, options.top)
  console.log(`\n① 같은 질문을 맡은 쌍 ${report.sharedPairs.length}개 — 비슷한 순 ${shared.length}개`)
  for (const p of shared) console.log(`  ${pairLine(p)}`)
  const others = pairsToShow(report.otherPairs, options.top)
  console.log(`\n② 그 밖의 쌍 ${report.otherPairs.length}개 — 비슷한 순 ${others.length}개`)
  for (const p of others) console.log(`  ${pairLine(p)}`)
  console.log(
    report.flagged > 0
      ? `\n⚠ 기준을 넘은 쌍 ${report.flagged}개 — 한쪽 글을 다시 만들거나 각도를 바꿔 다시 만든 뒤 다시 보세요.`
      : '\n기준을 넘은 쌍이 없습니다.',
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
