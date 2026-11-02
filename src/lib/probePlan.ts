/**
 * 실증 배정 — data/<tenant>/probe-plan.json(scripts/write-probe-plan.ts가 docs/proof/assignment.json에서 만든다).
 *
 * 왜: 실증 기간(11-02~12-28)에 배정표 밖의 글(대조 · 홀드아웃 · 대상 아님 질문을 맡은 글, 배정표와 다르게 묶은 글)이 하나라도
 * 생기면 그 질문은 대조로 쓸 수 없다(docs/proof/preregistration.md §9). 사람이 지키던 절차를 앱이 막는다 — 추가 글 만들기 · 되살리기와
 * 질문 은행 글의 브리프 · 초안은 배정표 글(과 0차 글)만 허용한다.
 *
 * ── 판 ──────────────────────────────────────────────────────────────────────
 * 질문 id의 뜻은 질문지 판마다 바뀐다. 배정은 한 판(web4ai v5 · gunsan v6)의 id로 적었으므로 다른 판의 주에서는 역할을 붙이지 않고,
 * 글 만들기는 거절한다(측정한 판의 주에서 만들라고 안내).
 *
 * ── 파일이 없을 때 ──────────────────────────────────────────────────────────
 * plan이 null이면 모든 함수가 「역할 없음 · 허용」이다 — 배정 파일이 없는 브랜드와 웹은 지금과 한 글자도 다르지 않아야 한다. 파일이
 * 깨졌으면 글 만들기만 막는다(fail closed — 깨진 파일 탓에 잠금이 조용히 풀리지 않게).
 *
 * 서버와 화면이 같은 검사를 쓰도록 순수 함수만 둔다. 서버가 import하므로 상대 import는 .js로 쓴다.
 */
import { checkNewExtraArticle, EXTRA_LIMITS, isExtraArticleId, topicArticleId } from './extraArticles.js'

export const PROBE_PLAN_FORMAT = 'probe-plan/1'

export type ProbeRole = 'round1' | 'round2' | 'control' | 'holdout' | 'ineligible' | 'zeroth'

export type ProbeChannel = '자사 사이트' | '티스토리'

export interface ProbePlanArticle {
  /** topicArticleId(questionIds) — 추가 글 id와 같은 규칙. */
  id: string
  /** 주제 이름 — 추가 글 이름이자 브리프 각도(extraBriefAngle)로 들어간다. 실험 용어를 넣지 않는다. */
  name: string
  channel: ProbeChannel
  /** 정렬됨. */
  questionIds: string[]
  /** questionIds와 같은 수 · 같은 순서의 배정 판 문장. */
  questionTexts: string[]
}

export interface ProbePlanRound {
  round: 1 | 2
  /** 게시일(YYYY-MM-DD, KST) — 그날 아침 측정 뒤에 올린다. */
  postDate: string
  articles: ProbePlanArticle[]
}

export interface ProbePlanQuestion {
  role: ProbeRole
  text: string
  /** 처치(round1 · round2)는 그 질문을 맡은 배정 글, 0차는 0차 글. */
  articleId?: string
  /** 홀드아웃이 바꿔 쓴 원래 질문(질문지 paraphraseOf). */
  of?: string
  /** 대상 아님의 이유. */
  reason?: string
}

export interface ProbePlan {
  format: typeof PROBE_PLAN_FORMAT
  tenantId: string
  /** 질문 id가 뜻하는 질문지 판. */
  bankVersion: string
  /** 잠금 마지막 날(YYYY-MM-DD, KST) — 이날까지 막고 다음 날부터 지금처럼 허용한다. */
  activeUntil: string
  source: { assignment: string; seed: number }
  rounds: ProbePlanRound[]
  /** 10-30에 만든 추가 글 — 배정 밖이지만 되살리기는 허용한다. */
  zerothArticle: { id: string; questionIds: string[] }
  /** 이 판의 카테고리 무관 질문마다 역할 하나. */
  questions: Record<string, ProbePlanQuestion>
}

/** 배정 글 하나와 그 차수. */
export type PlannedArticle = ProbePlanArticle & { round: 1 | 2; postDate: string }

export type ProbePlanParse = { plan: ProbePlan; error?: undefined } | { plan?: undefined; error: string }

/**
 * 주제 이름에 넣지 않는 말 — 이름은 브리프 각도로 모델에게 가고 카드 제목 · 올린 글 제목 후보가 된다. 실험 용어가 글에 새면 독자와
 * AI가 실험 글로 읽는다.
 */
export const PROBE_NAME_BANNED = ['실증', '실험', '처치', '대조', '홀드아웃', '배정', '0차', '1차', '2차'] as const

const ROLES: readonly ProbeRole[] = ['round1', 'round2', 'control', 'holdout', 'ineligible', 'zeroth']
const CHANNELS: readonly ProbeChannel[] = ['자사 사이트', '티스토리']

const isStr = (v: unknown): v is string => typeof v === 'string'
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** 실제 있는 날짜(YYYY-MM-DD)인지 — 2026-02-30 같은 값은 받지 않는다. */
function isDay(v: unknown): v is string {
  if (!isStr(v) || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const t = Date.parse(`${v}T00:00:00Z`)
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v
}

const roleOfRound = (round: 1 | 2): ProbeRole => (round === 1 ? 'round1' : 'round2')

/** 주제 이름의 실험 용어 검사 — 맞으면 null. 길이(60자) · 공백은 추가 글 검사(checkNewExtraArticle)가 본다. */
export function probeNameError(name: string): string | null {
  const banned = PROBE_NAME_BANNED.find((w) => name.includes(w))
  if (banned) return `주제 이름에 '${banned}' 같은 실험 용어를 넣지 않아요 — 이름은 브리프 각도로 글에 들어갑니다: ${name}`
  return null
}

/** 배정 글 하나 — 추가 글 만들기 검사(checkNewExtraArticle)를 그대로 통과해야 화면이 정의를 그대로 보낼 수 있다. */
function articleOf(raw: unknown, bankVersion: string, where: string): ProbePlanArticle | string {
  if (!isObj(raw)) return `${where}: 글 모양이 틀렸습니다.`
  const { id, name, channel, questionIds, questionTexts } = raw
  if (!isStr(id) || !isExtraArticleId(id)) return `${where}: 글 id가 'topic:'으로 시작하지 않습니다.`
  if (!isStr(channel) || !CHANNELS.includes(channel as ProbeChannel)) return `${where} ${id}: 채널은 ${CHANNELS.join(' · ')} 가운데 하나여야 합니다.`
  if (!Array.isArray(questionIds) || !questionIds.every(isStr)) return `${where} ${id}: 질문 id 목록이 틀렸습니다.`
  if (!Array.isArray(questionTexts) || !questionTexts.every(isStr)) return `${where} ${id}: 질문 문장 목록이 틀렸습니다.`
  if (topicArticleId(questionIds) !== id || `topic:${questionIds.join('+')}` !== id) return `${where} ${id}: 글 id가 정렬한 질문 id와 다릅니다.`
  if (!isStr(name)) return `${where} ${id}: 주제 이름이 없습니다.`
  const checked = checkNewExtraArticle({ id, name, bankVersion, questionIds, questionTexts }, [], '2000-01-01T00:00:00.000Z')
  if (!checked.ok) return `${where} ${id}: ${checked.error}`
  if (checked.article.name !== name) return `${where} ${id}: 주제 이름 앞뒤나 사이에 공백이 더 있습니다.`
  const banned = probeNameError(name)
  if (banned) return `${where} ${id}: ${banned}`
  return { id, name, channel: channel as ProbeChannel, questionIds: [...questionIds], questionTexts: [...questionTexts] }
}

function questionOf(raw: unknown, qid: string): ProbePlanQuestion | string {
  if (!isObj(raw)) return `질문 ${qid}: 모양이 틀렸습니다.`
  if (!isStr(raw.role) || !ROLES.includes(raw.role as ProbeRole)) return `질문 ${qid}: 역할이 틀렸습니다(${String(raw.role)}).`
  if (!isStr(raw.text) || !raw.text.trim()) return `질문 ${qid}: 문장이 없습니다.`
  for (const k of ['articleId', 'of', 'reason'] as const) {
    if (raw[k] !== undefined && (!isStr(raw[k]) || !raw[k])) return `질문 ${qid}: ${k}가 틀렸습니다.`
  }
  return {
    role: raw.role as ProbeRole,
    text: raw.text,
    ...(isStr(raw.articleId) ? { articleId: raw.articleId } : {}),
    ...(isStr(raw.of) ? { of: raw.of } : {}),
    ...(isStr(raw.reason) ? { reason: raw.reason } : {}),
  }
}

/**
 * 배정 파일을 검사해 읽는다 — 형식 · 글 id === topicArticleId(questionIds) · 이름 규칙 · 질문 하나에 역할 하나 · 처치 질문은 정확히 한 글에 ·
 * 글 문장 === 역할 표 문장. 하나라도 틀리면 { error } — 서버는 깨진 파일로 보고 글 만들기를 막는다.
 */
export function parseProbePlan(raw: unknown): ProbePlanParse {
  const fail = (error: string): ProbePlanParse => ({ error })
  if (!isObj(raw)) return fail('배정 파일 모양이 틀렸습니다.')
  if (raw.format !== PROBE_PLAN_FORMAT) return fail(`형식이 ${PROBE_PLAN_FORMAT}가 아닙니다(${String(raw.format)}).`)
  const { tenantId, bankVersion, activeUntil, source } = raw
  if (!isStr(tenantId) || !tenantId.trim()) return fail('tenantId가 없습니다.')
  if (!isStr(bankVersion) || !bankVersion.trim() || bankVersion.length > EXTRA_LIMITS.bankVersion) return fail('질문지 판(bankVersion)이 틀렸습니다.')
  if (!isDay(activeUntil)) return fail('잠금 마지막 날(activeUntil)이 YYYY-MM-DD가 아닙니다.')
  if (!isObj(source) || !isStr(source.assignment) || !source.assignment || typeof source.seed !== 'number' || !Number.isFinite(source.seed)) {
    return fail('출처(source.assignment · source.seed)가 틀렸습니다.')
  }
  if (!isObj(raw.questions)) return fail('역할 표(questions)가 없습니다.')
  const entries: [string, ProbePlanQuestion][] = []
  for (const [qid, q] of Object.entries(raw.questions)) {
    const parsed = questionOf(q, qid)
    if (isStr(parsed)) return fail(parsed)
    entries.push([qid, parsed])
  }
  // 자기 속성으로만 만든다 — 'toString' 같은 id가 상속 값으로 「있음」이 되지 않게(조회는 모두 has로).
  const questions: Record<string, ProbePlanQuestion> = Object.fromEntries(entries)
  const has = (qid: string) => Object.hasOwn(questions, qid)

  if (!Array.isArray(raw.rounds) || raw.rounds.length === 0) return fail('차수(rounds)가 없습니다.')
  const rounds: ProbePlanRound[] = []
  const articleIds = new Set<string>()
  const placed = new Map<string, string>()
  for (const r of raw.rounds) {
    if (!isObj(r) || (r.round !== 1 && r.round !== 2)) return fail('차수는 1 · 2여야 합니다.')
    const round = r.round
    if (rounds.some((x) => x.round === round)) return fail(`${round}차가 두 번 있습니다.`)
    if (!isDay(r.postDate)) return fail(`${round}차 게시일이 YYYY-MM-DD가 아닙니다.`)
    if (!Array.isArray(r.articles) || r.articles.length === 0) return fail(`${round}차에 글이 없습니다.`)
    const articles: ProbePlanArticle[] = []
    for (const a of r.articles) {
      const art = articleOf(a, bankVersion, `${round}차`)
      if (isStr(art)) return fail(art)
      if (articleIds.has(art.id)) return fail(`같은 글이 두 번 있습니다: ${art.id}`)
      articleIds.add(art.id)
      for (const [i, qid] of art.questionIds.entries()) {
        const other = placed.get(qid)
        if (other) return fail(`질문 ${qid}가 두 글에 있습니다: ${other} · ${art.id}`)
        placed.set(qid, art.id)
        if (!has(qid)) return fail(`${art.id}의 질문 ${qid}가 역할 표에 없습니다.`)
        const q = questions[qid]
        if (q.role !== roleOfRound(round)) return fail(`${art.id}의 질문 ${qid}는 ${round}차 글에 있는데 역할이 ${q.role}입니다.`)
        if (q.articleId !== art.id) return fail(`질문 ${qid}의 articleId가 그 질문을 맡은 글(${art.id})과 다릅니다.`)
        if (q.text !== art.questionTexts[i]) return fail(`질문 ${qid}의 문장이 글의 문장과 다릅니다.`)
      }
      articles.push(art)
    }
    rounds.push({ round, postDate: r.postDate, articles })
  }
  rounds.sort((a, b) => a.round - b.round)

  const z = raw.zerothArticle
  if (!isObj(z) || !isStr(z.id) || !Array.isArray(z.questionIds) || z.questionIds.length === 0 || !z.questionIds.every(isStr)) {
    return fail('0차 글(zerothArticle)이 틀렸습니다.')
  }
  if (topicArticleId(z.questionIds) !== z.id || `topic:${z.questionIds.join('+')}` !== z.id) return fail('0차 글 id가 정렬한 질문 id와 다릅니다.')
  if (articleIds.has(z.id)) return fail('0차 글이 배정 글과 같습니다.')
  const zerothIds = new Set(z.questionIds)
  if (zerothIds.size !== z.questionIds.length) return fail('0차 글에 같은 질문이 두 번 있습니다.')

  for (const [qid, q] of Object.entries(questions)) {
    if (q.role === 'round1' || q.role === 'round2') {
      if (!placed.has(qid)) return fail(`처치 질문 ${qid}를 맡은 글이 없습니다.`)
    } else if (placed.has(qid)) {
      return fail(`${q.role} 질문 ${qid}가 글 ${placed.get(qid)}에 있습니다.`)
    }
    if (q.role === 'zeroth') {
      if (!zerothIds.has(qid)) return fail(`0차 질문 ${qid}가 0차 글에 없습니다.`)
      if (q.articleId !== undefined && q.articleId !== z.id) return fail(`0차 질문 ${qid}의 articleId가 0차 글과 다릅니다.`)
    } else if (zerothIds.has(qid)) {
      return fail(`0차 글의 질문 ${qid}의 역할이 ${q.role}입니다.`)
    }
    if (q.role === 'holdout') {
      if (!q.of) return fail(`홀드아웃 ${qid}에 원래 질문(of)이 없습니다.`)
      if (q.of === qid) return fail(`홀드아웃 ${qid}의 원래 질문이 자기 자신입니다.`)
      if (!has(q.of)) return fail(`홀드아웃 ${qid}의 원래 질문 ${q.of}가 역할 표에 없습니다.`)
    }
    if ((q.role === 'control' || q.role === 'holdout' || q.role === 'ineligible') && q.articleId !== undefined) {
      return fail(`${q.role} 질문 ${qid}에 글(articleId)이 붙어 있습니다.`)
    }
  }
  for (const qid of zerothIds) {
    if (!has(qid)) return fail(`0차 글의 질문 ${qid}가 역할 표에 없습니다.`)
  }

  return {
    plan: {
      format: PROBE_PLAN_FORMAT,
      tenantId,
      bankVersion,
      activeUntil,
      source: { assignment: source.assignment, seed: source.seed },
      rounds,
      zerothArticle: { id: z.id, questionIds: [...z.questionIds] },
      questions,
    },
  }
}

/** 잠금이 켜져 있는지 — 오늘(KST)이 마지막 날까지면 켜짐. plan이 없으면 꺼짐. */
export function isActive(plan: ProbePlan | null, todayKst: string): boolean {
  return plan !== null && todayKst <= plan.activeUntil
}

/** 실증 기간에 만들 수 있는 추가 글 id — 배정 글 + 0차 글(되살리기). plan이 없으면 null(제한 없음). */
export function allowedTopicIds(plan: ProbePlan | null): string[] | null {
  if (!plan) return null
  return [...plan.rounds.flatMap((r) => r.articles.map((a) => a.id)), plan.zerothArticle.id]
}

/**
 * 이 글(topicId)을 만들거나 되살리거나 브리프 · 초안을 써도 되는지 — 되면 null, 아니면 화면에 보일 이유.
 *   'topic:'이 아닌 글(본 글 · 등재형) → 이 규칙 밖이라 늘 허용
 *   배정 파일이 깨짐 → 거절(fail closed)
 *   배정 파일 없음 · 잠금 기간 지남 → 허용(지금과 같다)
 *   질문지 판이 배정 판과 다름(모름 포함) → 거절 — 같은 id라도 다른 질문이다
 *   배정 글 · 0차 글이 아님 → 거절
 */
export function topicGuard(
  plan: ProbePlan | null,
  corrupt: boolean,
  bankVersion: string | null | undefined,
  topicId: string,
  todayKst: string,
): string | null {
  if (!isExtraArticleId(topicId)) return null
  if (corrupt) return '배정 파일(probe-plan.json)이 깨져 있어 실증 기간의 글을 만들지 않았어요. 관리자에게 확인을 요청해 주세요.'
  if (!plan || !isActive(plan, todayKst)) return null
  if (bankVersion !== plan.bankVersion) {
    const seen = bankVersion ? `질문지 ${bankVersion} 판` : '질문지 판을 모르는 주'
    return `${seen}에서는 실증 기간(~${plan.activeUntil})의 글을 만들 수 없어요. 배정표는 ${plan.bankVersion} 판 질문이라 그 판으로 측정한 주에서 만들어 주세요.`
  }
  if (!allowedTopicIds(plan)?.includes(topicId)) return `실증 기간(~${plan.activeUntil})에는 배정표 글만 만들 수 있어요.`
  return null
}

/** 이 질문의 실증 역할 — plan이 없거나 판이 다르거나 역할 표에 없으면 null. */
export function roleOf(plan: ProbePlan | null, bankVersion: string | null | undefined, questionId: string): ProbeRole | null {
  if (!plan || bankVersion !== plan.bankVersion) return null
  return Object.hasOwn(plan.questions, questionId) ? plan.questions[questionId].role : null
}

const ROLE_CHIP: Record<ProbeRole, string> = {
  round1: '1차 처치',
  round2: '2차 처치',
  control: '대조 · 글 금지',
  holdout: '홀드아웃 · 글 금지',
  ineligible: '대상 아님',
  zeroth: '0차',
}

/** 질문 옆 역할 칩 글자. 역할이 없으면 null. */
export function roleChip(role: ProbeRole | null): string | null {
  return role ? ROLE_CHIP[role] : null
}

/** 배정 글 하나와 그 차수 — 배정 글이 아니면(0차 글 포함) null. */
export function planArticle(plan: ProbePlan | null, articleId: string): PlannedArticle | null {
  if (!plan) return null
  for (const r of plan.rounds) {
    const a = r.articles.find((x) => x.id === articleId)
    if (a) return { ...a, questionIds: [...a.questionIds], questionTexts: [...a.questionTexts], round: r.round, postDate: r.postDate }
  }
  return null
}

/** 카드 머리 글자 — 「1차 · 11-23 게시 · 티스토리」. 배정 글이 아니면 null. */
export function articleLabel(plan: ProbePlan | null, articleId: string): string | null {
  const a = planArticle(plan, articleId)
  return a ? `${a.round}차 · ${a.postDate.slice(5)} 게시 · ${a.channel}` : null
}
