/**
 * 작성자 배정 — data/<tenant>/probe-plan.json(scripts/writer-plan.ts가 쓴다, 형식 probe-plan/2).
 *
 * 2026-11-02 실증을 끝내고(운영 방식 전환) 작성자 여러 명이 브랜드마다 글을 나눠 쓴다 — 작성자 8명 × 10편, 글마다 질문 2개. 글은 운영자
 * PC(설치본) 한 곳에서 모두 만들고, 작성자는 받은 초안을 자기 블로그에 올린다. 한 질문을 여러 글이 맡는다(질문마다 3~4편) — 대신 같은
 * 질문 조합의 글은 두 번 없고(글 id가 모두 다르다), 한 작성자가 같은 질문을 두 번 맡지 않는다.
 *
 * 왜 잠그나: 배정 밖의 글(배정표와 다르게 묶은 글)이 생기면 글 id가 배정표와 어긋나 누가 어느 글을 올렸는지 · 질문마다 몇 편이 맡았는지가
 * 틀어진다. 사람이 지키던 절차를 앱이 막는다 — 운영 기간에는 추가 글 만들기 · 되살리기와 질문 은행 글의 브리프 · 초안을 배정 글만
 * 허용한다. 대신 배정 글끼리는 질문이 겹쳐도 되고(writerExtraRules), 살아 있는 추가 글 상한이 배정 글 수 + 10으로 늘어난다(extraArticleCap).
 *
 * ── 판 ──────────────────────────────────────────────────────────────────────
 * 질문 id의 뜻은 질문지 판마다 바뀐다. 배정은 한 판(승격한 새 판)의 id로 적었으므로 다른 판의 주에서는 작성자를 붙이지 않고, 글 만들기는
 * 거절한다(그 판으로 측정한 주에서 만들라고 안내).
 *
 * ── 파일이 없을 때 ──────────────────────────────────────────────────────────
 * plan이 null이면 모든 함수가 「작성자 없음 · 허용 · 상한 10편」이다 — 배정 파일이 없는 브랜드와 웹은 지금과 한 글자도 다르지 않아야
 * 한다. 파일이 깨졌으면 글 만들기만 막는다(fail closed — 깨진 파일 탓에 잠금이 조용히 풀리지 않게). 실증 때의 형식(probe-plan/1)은 더
 * 읽지 않는다(실제 데이터에 그 파일이 없다) — 그 파일이 있으면 깨진 배정으로 본다.
 *
 * 서버와 화면이 같은 검사를 쓰도록 순수 함수만 둔다. 서버가 import하므로 상대 import는 .js로 쓴다.
 */
import { checkNewExtraArticle, EXTRA_LIMITS, isExtraArticleId, topicArticleId, type ExtraArticleRules } from './extraArticles.js'

export const WRITER_PLAN_FORMAT = 'probe-plan/2'

export const WRITER_LIMITS = {
  /** 작성자 키(w1 …). */
  key: 20,
  writerName: 40,
  blog: 200,
} as const

export interface PlanWriter {
  /** 'w1' … — 화면 거르기 · 배정표 파일 이름. */
  key: string
  name: string
}

export interface WriterPlanArticle {
  /** topicArticleId(questionIds) — 추가 글 id와 같은 규칙. */
  id: string
  /** 주제 이름 — 추가 글 이름. 실험 용어를 넣지 않는다. */
  name: string
  /** 작성자 각도 — 추가 글의 「다룰 각도」로 들어간다(이름과 합쳐 브리프 각도 한 줄, NAME_AND_ANGLE_LIMIT). */
  angle: string
  writer: PlanWriter
  /** 작성자가 올릴 블로그(주소나 이름). 모르면 빈 글자. */
  blog: string
  /** 정렬됨. */
  questionIds: string[]
  /** questionIds와 같은 수 · 같은 순서의 배정 판 문장. */
  questionTexts: string[]
}

export interface WriterPlan {
  format: typeof WRITER_PLAN_FORMAT
  tenantId: string
  /** 질문 id가 뜻하는 질문지 판. */
  bankVersion: string
  /** 운영 기간 마지막 날(YYYY-MM-DD, KST) — 이날까지 잠그고 다음 날부터 지금처럼 허용한다. */
  activeUntil: string
  /** 작성자 설정 파일(저장소 기준 경로)과 배정 시드. */
  source: { writers: string; seed: number }
  /** 작성자 순 · 작성자 안에서는 배정표 번호 순. */
  articles: WriterPlanArticle[]
}

export type WriterPlanParse = { plan: WriterPlan; error?: undefined } | { plan?: undefined; error: string }

/**
 * 주제 이름 · 각도에 넣지 않는 말 — 이름과 각도는 브리프 각도로 모델에게 가고 카드 제목 · 올린 글 제목 후보가 된다. 실험 용어가 글에
 * 새면 독자와 AI가 실험 글로 읽는다.
 */
export const PROBE_NAME_BANNED = ['실증', '실험', '처치', '대조', '홀드아웃', '배정', '0차', '1차', '2차'] as const

const isStr = (v: unknown): v is string => typeof v === 'string'
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** 실제 있는 날짜(YYYY-MM-DD)인지 — 2026-02-30 같은 값은 받지 않는다. */
function isDay(v: unknown): v is string {
  if (!isStr(v) || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const t = Date.parse(`${v}T00:00:00Z`)
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v
}

/** 주제 이름의 실험 용어 검사 — 맞으면 null. 길이(60자) · 공백은 추가 글 검사(checkNewExtraArticle)가 본다. */
export function probeNameError(name: string): string | null {
  const banned = PROBE_NAME_BANNED.find((w) => name.includes(w))
  if (banned) return `주제 이름에 '${banned}' 같은 실험 용어를 넣지 않아요 — 이름은 브리프 각도로 글에 들어갑니다: ${name}`
  return null
}

/** 작성자 하나 — 키 · 이름은 비지 않은 한 줄. */
function writerOf(raw: unknown): PlanWriter | null {
  if (!isObj(raw) || !isStr(raw.key) || !isStr(raw.name)) return null
  const { key, name } = raw
  if (!/^[A-Za-z0-9_-]+$/.test(key) || key.length > WRITER_LIMITS.key) return null
  if (!name.trim() || name !== name.replace(/\s+/g, ' ').trim() || name.length > WRITER_LIMITS.writerName) return null
  return { key, name }
}

/** 작성자 배정 글 하나 — 추가 글 만들기 검사(checkNewExtraArticle)를 각도까지 그대로 통과해야 화면이 정의를 그대로 보낼 수 있다. */
function writerArticleOf(raw: unknown, bankVersion: string, where: string): WriterPlanArticle | string {
  if (!isObj(raw)) return `${where}: 글 모양이 틀렸습니다.`
  const { id, name, angle, blog, questionIds, questionTexts } = raw
  if (!isStr(id) || !isExtraArticleId(id)) return `${where}: 글 id가 'topic:'으로 시작하지 않습니다.`
  const writer = writerOf(raw.writer)
  if (!writer) return `${where} ${id}: 작성자(writer.key · writer.name)가 틀렸습니다.`
  if (!isStr(blog) || blog.length > WRITER_LIMITS.blog || blog !== blog.trim()) return `${where} ${id}: 블로그가 틀렸습니다.`
  if (!Array.isArray(questionIds) || !questionIds.every(isStr)) return `${where} ${id}: 질문 id 목록이 틀렸습니다.`
  if (!Array.isArray(questionTexts) || !questionTexts.every(isStr)) return `${where} ${id}: 질문 문장 목록이 틀렸습니다.`
  if (topicArticleId(questionIds) !== id || `topic:${questionIds.join('+')}` !== id) return `${where} ${id}: 글 id가 정렬한 질문 id와 다릅니다.`
  if (!isStr(name)) return `${where} ${id}: 주제 이름이 없습니다.`
  if (!isStr(angle) || !angle.trim()) return `${where} ${id}: 각도가 없습니다.`
  const checked = checkNewExtraArticle({ id, name, angle, bankVersion, questionIds, questionTexts }, [], '2000-01-01T00:00:00.000Z')
  if (!checked.ok) return `${where} ${id}: ${checked.error}`
  if (checked.article.name !== name) return `${where} ${id}: 주제 이름 앞뒤나 사이에 공백이 더 있습니다.`
  if (checked.article.angle !== angle) return `${where} ${id}: 각도 앞뒤나 사이에 공백이 더 있습니다.`
  const banned = probeNameError(name)
  if (banned) return `${where} ${id}: ${banned}`
  const bannedAngle = PROBE_NAME_BANNED.find((w) => angle.includes(w))
  if (bannedAngle) return `${where} ${id}: 각도에 '${bannedAngle}' 같은 실험 용어를 넣지 않아요 — 각도는 브리프로 글에 들어갑니다.`
  return { id, name, angle, writer, blog, questionIds: [...questionIds], questionTexts: [...questionTexts] }
}

/**
 * 작성자 배정 파일을 검사해 읽는다 — 형식 · 글 id === topicArticleId(questionIds) · 추가 글 검사(이름 · 각도 · 문장) · 실험 용어 ·
 * 글 id와 이름이 모두 다름 · 같은 질문 id는 어느 글에서나 같은 문장 · 같은 작성자 키는 같은 이름과 블로그 · 한 작성자가 같은 질문을 두 번
 * 맡지 않음. 질문마다 글 수가 고른지 · 작성자마다 몇 편인지는 만드는 쪽(scripts/writer-plan.ts)이 본다. 하나라도 틀리면 { error } —
 * 서버는 깨진 파일로 보고 글 만들기를 막는다.
 */
export function parseWriterPlan(raw: unknown): WriterPlanParse {
  const fail = (error: string): WriterPlanParse => ({ error })
  if (!isObj(raw)) return fail('배정 파일 모양이 틀렸습니다.')
  if (raw.format !== WRITER_PLAN_FORMAT) return fail(`형식이 ${WRITER_PLAN_FORMAT}가 아닙니다(${String(raw.format)}).`)
  const { tenantId, bankVersion, activeUntil, source } = raw
  if (!isStr(tenantId) || !tenantId.trim()) return fail('tenantId가 없습니다.')
  if (!isStr(bankVersion) || !bankVersion.trim() || bankVersion.length > EXTRA_LIMITS.bankVersion) return fail('질문지 판(bankVersion)이 틀렸습니다.')
  if (!isDay(activeUntil)) return fail('운영 기간 마지막 날(activeUntil)이 YYYY-MM-DD가 아닙니다.')
  if (!isObj(source) || !isStr(source.writers) || !source.writers || typeof source.seed !== 'number' || !Number.isFinite(source.seed)) {
    return fail('출처(source.writers · source.seed)가 틀렸습니다.')
  }
  if (!Array.isArray(raw.articles) || raw.articles.length === 0) return fail('글(articles)이 없습니다.')

  const articles: WriterPlanArticle[] = []
  const ids = new Set<string>()
  const names = new Map<string, string>()
  const texts = new Map<string, string>()
  const writers = new Map<string, Omit<PlanWriter, 'key'> & { blog: string }>()
  const taken = new Map<string, string>()
  for (const [i, a] of raw.articles.entries()) {
    const art = writerArticleOf(a, bankVersion, `${i + 1}번째 글`)
    if (isStr(art)) return fail(art)
    if (ids.has(art.id)) return fail(`같은 질문 조합의 글이 두 번 있습니다: ${art.id}`)
    ids.add(art.id)
    const sameName = names.get(art.name)
    if (sameName) return fail(`두 글의 주제 이름이 같습니다: ${sameName} · ${art.id} — ${art.name}`)
    names.set(art.name, art.id)
    const w = writers.get(art.writer.key)
    if (!w) writers.set(art.writer.key, { name: art.writer.name, blog: art.blog })
    else if (w.name !== art.writer.name || w.blog !== art.blog) return fail(`작성자 ${art.writer.key}의 이름이나 블로그가 글마다 다릅니다(${art.id}).`)
    for (const [j, qid] of art.questionIds.entries()) {
      const text = texts.get(qid)
      if (text === undefined) texts.set(qid, art.questionTexts[j])
      else if (text !== art.questionTexts[j]) return fail(`질문 ${qid}의 문장이 글마다 다릅니다(${art.id}).`)
      const mine = `${art.writer.key}\n${qid}`
      const other = taken.get(mine)
      if (other) return fail(`작성자 ${art.writer.key}가 질문 ${qid}를 두 글에서 맡습니다: ${other} · ${art.id}`)
      taken.set(mine, art.id)
    }
    articles.push(art)
  }
  return {
    plan: {
      format: WRITER_PLAN_FORMAT,
      tenantId,
      bankVersion,
      activeUntil,
      source: { writers: source.writers, seed: source.seed },
      articles,
    },
  }
}

/** 배정에 나오는 작성자 — 처음 나온 순서, 블로그 포함. */
export function planWriters(plan: WriterPlan): (PlanWriter & { blog: string })[] {
  const out: (PlanWriter & { blog: string })[] = []
  for (const a of plan.articles) {
    if (!out.some((w) => w.key === a.writer.key)) out.push({ ...a.writer, blog: a.blog })
  }
  return out
}

/** 잠금이 켜져 있는지 — 오늘(KST)이 마지막 날까지면 켜짐. plan이 없으면 꺼짐. */
export function isActive(plan: WriterPlan | null, todayKst: string): boolean {
  return plan !== null && todayKst <= plan.activeUntil
}

/** 운영 기간에 만들 수 있는 추가 글 id — 배정 글. plan이 없으면 null(제한 없음). */
export function allowedTopicIds(plan: WriterPlan | null): string[] | null {
  if (!plan) return null
  return plan.articles.map((a) => a.id)
}

/**
 * 이 글(topicId)을 만들거나 되살리거나 브리프 · 초안을 써도 되는지 — 되면 null, 아니면 화면에 보일 이유.
 *   'topic:'이 아닌 글(본 글 · 등재형) → 이 규칙 밖이라 늘 허용
 *   배정 파일이 깨짐 → 거절(fail closed)
 *   배정 파일 없음 · 운영 기간 지남 → 허용(지금과 같다)
 *   질문지 판이 배정 판과 다름(모름 포함) → 거절 — 같은 id라도 다른 질문이다
 *   배정 글이 아님 → 거절
 */
export function topicGuard(
  plan: WriterPlan | null,
  corrupt: boolean,
  bankVersion: string | null | undefined,
  topicId: string,
  todayKst: string,
): string | null {
  if (!isExtraArticleId(topicId)) return null
  if (corrupt) return '배정 파일(probe-plan.json)이 깨져 있어 작성자 배정 글을 만들지 않았어요. 관리자에게 확인을 요청해 주세요.'
  if (!plan || !isActive(plan, todayKst)) return null
  if (bankVersion !== plan.bankVersion) {
    const seen = bankVersion ? `질문지 ${bankVersion} 판` : '질문지 판을 모르는 주'
    return `${seen}에서는 작성자 배정 기간(~${plan.activeUntil})의 글을 만들 수 없어요. 배정표는 ${plan.bankVersion} 판 질문이라 그 판으로 측정한 주에서 만들어 주세요.`
  }
  if (!allowedTopicIds(plan)?.includes(topicId)) return `작성자 배정 기간(~${plan.activeUntil})에는 배정표 글만 만들 수 있어요.`
  return null
}

/**
 * 살아 있는 추가 글 상한 — 운영 기간이면 배정 글 수 + 10(EXTRA_LIMITS.articles), 아니면 10(지금과 같다). 배정 글 80편을 한 PC에서 모두
 * 만들어 두고 작성자에게 나눠 주므로 10편 상한으로는 한 작성자 몫도 다 만들지 못한다. 배정 전에 만든 글(배정 밖 글)도 살아 있으면 세므로
 * 배정 글 수만큼만 열면 그 글 수만큼 배정 글이 모자란다(2026-11-03 web4ai · gunsan에 1편씩 — 80편 중 79편만 만들어졌다). 늘어난 몫으로
 * 배정 밖 글을 만들 수는 없다 — 운영 기간에는 topicGuard가 배정 글만 허용한다.
 */
export function extraArticleCap(plan: WriterPlan | null, todayKst: string): number {
  return plan && isActive(plan, todayKst) ? plan.articles.length + EXTRA_LIMITS.articles : EXTRA_LIMITS.articles
}

/**
 * 작성자 단추(src/pages/GapActions.tsx WriterRuns)의 편수 검사 — 그 작성자 몫 중 살아 있지 않은 글을 모두 더해도 상한(extraArticleCap)
 * 안이면 null, 넘으면 화면에 보일 이유. 서버도 같은 상한으로 409를 내므로 누르기 전에 같은 셈으로 막는다. alive는 살아 있는 추가 글
 * id 전부(배정 밖 글 포함)다.
 */
export function writerRunCapReason(plan: WriterPlan, alive: ReadonlySet<string>, writerKey: string, todayKst: string): string | null {
  const cap = extraArticleCap(plan, todayKst)
  const missing = plan.articles.filter((a) => a.writer.key === writerKey && !alive.has(a.id)).length
  if (alive.size + missing <= cap) return null
  return `추가 글은 ${cap}편까지예요 — 지금 ${alive.size}편에 ${missing}편을 더하면 넘습니다. 다 쓴 추가 글을 목록에서 뺀 뒤 눌러 주세요.`
}

/**
 * 추가 글 저장소가 쓸 규칙(src/lib/extraArticles.ts ExtraArticleRules) — 운영 기간이면 상한을 늘리고 질문 겹침을 허용한다(한 질문을
 * 3~4편이 맡는 배정이다). 배정 밖 글은 topicGuard가 따로 막으므로 겹침 허용이 배정 밖 글을 여는 일은 없다. 파일이 없거나 깨졌거나 기간이
 * 지났으면 undefined — 지금 규칙 그대로(상한 10 · 겹침 409).
 */
export function writerExtraRules(plan: WriterPlan | null, corrupt: boolean, todayKst: string): ExtraArticleRules | undefined {
  if (corrupt || !plan || !isActive(plan, todayKst)) return undefined
  return { cap: extraArticleCap(plan, todayKst), sharedQuestions: true }
}

/** 배정 글 하나(사본) — 배정 글이 아니면 null. */
export function writerArticle(plan: WriterPlan | null, articleId: string): WriterPlanArticle | null {
  const a = plan?.articles.find((x) => x.id === articleId)
  return a ? { ...a, writer: { ...a.writer }, questionIds: [...a.questionIds], questionTexts: [...a.questionTexts] } : null
}

/** 카드 머리 글자 — 「작성자 이름 · 블로그」(블로그를 모르면 이름만). 배정 글이 아니면 null. */
export function writerChip(plan: WriterPlan | null, articleId: string): string | null {
  const a = writerArticle(plan, articleId)
  return a ? (a.blog ? `${a.writer.name} · ${a.blog}` : a.writer.name) : null
}
