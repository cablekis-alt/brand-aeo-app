import type { WeeklyScorecard } from '../prompts/b8-report'

/*
 * 두 측정을 증감으로 견줘도 되는가 — 앱 전체가 쓰는 규칙 하나(2026-10-25 통일).
 *
 * 예전에는 화면마다 규칙이 달랐다(8갈래 넘음). 같은 두 주를 두고 그래프는 선을 끊는데 보고서 표지는 「전주 대비 -44」를
 * 찍고, 개요 칩은 「질문지 달라 비교 불가」인데 바로 위 알림은 「상승 +11점」이라고 했다. 이제 증감 · 선 잇기 · 같은 조건
 * 주 수 · 이동평균 표시가 모두 이 판정을 쓴다.
 *
 * 보는 조건은 점수를 움직이는 여섯 가지다: 수집 엔진 · 판정 엔진 · 수집 모델 · 판정 모델 · 질문지 · 반복 횟수.
 * 조건마다 결과는 셋이다.
 *   - 양쪽에 기록이 있고 같음 → 같음
 *   - 양쪽에 기록이 있고 다름 → 바뀜
 *   - 한쪽에만 기록이 있음 → 확인 불가(모르는 것을 같다고도 다르다고도 하지 않는다 — 비교하지 않는다)
 *   - 양쪽 다 기록이 없음 → 같음(같은 시기의 옛 기록끼리다 — 다르다고 할 근거가 없다)
 * 바뀜이나 확인 불가가 하나라도 있으면 견주지 않는다.
 *
 * 이 파일은 서버(server/portfolio · runHistory · publishedHistory · queries)도 '../src/lib/comparability.js'로 읽는다 —
 * 런타임 import를 두지 않는다(확장자 없는 import가 끼면 Vercel 함수가 런타임에 죽는다). 그래서 엔진 이름도 여기 따로 둔다.
 */

export type ConditionChange = '수집 엔진' | '판정 엔진' | '수집 모델' | '판정 모델' | '질문지' | '반복 횟수'

export interface ConditionDiff {
  dimension: ConditionChange
  /** changed = 양쪽 기록이 다름, unknown = 한쪽에만 기록이 있어 확인 불가. */
  state: 'changed' | 'unknown'
  /** 화면에 적을 앞 · 뒤 값(기록이 없으면 null). */
  from: string | null
  to: string | null
}

type Card = Pick<
  WeeklyScorecard,
  'weekOf' | 'enginesUsed' | 'judgeEngine' | 'modelsUsed' | 'judgeModel' | 'questionBankVersion' | 'repeatsPerQuestion'
>

/** 엔진 이름 — src/lib/format.ts ENGINE_LABEL과 같다(런타임 import를 두지 않으려 따로 둔다). */
const ENGINE_NAME: Record<string, string> = { openai: 'ChatGPT', gemini: 'Gemini', claude: 'Claude', perplexity: 'Perplexity', mock: '목(테스트)' }
const engineName = (e: string) => ENGINE_NAME[e] ?? e
const engineList = (list: string[]) => list.map(engineName).join('+')

/** 한 조건의 세 상태 — 기록 없음은 undefined · null · 빈 문자열 · 0. */
function tri(dimension: ConditionChange, a: string | null, b: string | null): ConditionDiff | null {
  if (!a && !b) return null
  if (!a || !b) return { dimension, state: 'unknown', from: a || null, to: b || null }
  return a === b ? null : { dimension, state: 'changed', from: a, to: b }
}

/**
 * 두 측정 사이에 달라진(또는 확인할 수 없는) 조건 — **바뀐 조건이 먼저**, 그다음 확인 불가(각각 위 여섯 가지 순서). 같으면 빈 배열.
 * 바뀐 조건을 앞에 두는 까닭: 한 낱말만 적는 곳(개요 칩 · 브랜드 현황)과 이유 첫 구절이 실제 원인을 가리지 않게(실측 humax-networks
 * W38→W40 — 수집 모델은 W38에 기록이 없을 뿐이고 바뀐 것은 질문지 · 반복인데, 순서대로 두면 「수집 모델」이 먼저 잡혔다).
 * engine을 주면(엔진 하나로 좁혀 본 표) 수집 엔진은 두 측정 모두 그 엔진을 썼는지, 수집 모델은 그 엔진의 모델만 본다.
 */
export function compareConditions(prev: Card, cur: Card, opts: { engine?: string | null } = {}): ConditionDiff[] {
  const out: ConditionDiff[] = []
  const pe = [...(prev.enginesUsed ?? [])].sort()
  const ce = [...(cur.enginesUsed ?? [])].sort()
  const engine = opts.engine ?? null
  if (engine) {
    if (pe.length === 0 || ce.length === 0) {
      const d = tri('수집 엔진', pe.length ? engineList(pe) : null, ce.length ? engineList(ce) : null)
      if (d) out.push(d)
    } else if (!pe.includes(engine) || !ce.includes(engine)) {
      out.push({ dimension: '수집 엔진', state: 'changed', from: engineList(pe), to: engineList(ce) })
    }
  } else {
    const d = tri('수집 엔진', pe.length ? engineList(pe) : null, ce.length ? engineList(ce) : null)
    if (d) out.push(d)
  }
  const j = tri('판정 엔진', prev.judgeEngine ? engineName(prev.judgeEngine) : null, cur.judgeEngine ? engineName(cur.judgeEngine) : null)
  if (j) out.push(j)

  // 수집 모델 — 빈 객체는 기록 없음. 양쪽에 기록이 있으면 두 측정 모두에 있는 엔진끼리만 견준다(엔진 차이는 위에서 이미 잡는다).
  const pm = prev.modelsUsed && Object.keys(prev.modelsUsed).length > 0 ? prev.modelsUsed : null
  const cm = cur.modelsUsed && Object.keys(cur.modelsUsed).length > 0 ? cur.modelsUsed : null
  if (engine) {
    const d = tri('수집 모델', pm?.[engine] ?? null, cm?.[engine] ?? null)
    if (d) out.push(d)
  } else if (!pm !== !cm) {
    out.push({ dimension: '수집 모델', state: 'unknown', from: null, to: null })
  } else if (pm && cm) {
    const changed = Object.keys(pm)
      .filter((e) => cm[e] && pm[e] && pm[e] !== cm[e])
      .sort()
    if (changed.length > 0) {
      out.push({
        dimension: '수집 모델',
        state: 'changed',
        from: changed.map((e) => `${engineName(e)} ${pm[e]}`).join(' · '),
        to: changed.map((e) => `${engineName(e)} ${cm[e]}`).join(' · '),
      })
    }
  }

  const jm = tri('판정 모델', prev.judgeModel ?? null, cur.judgeModel ?? null)
  if (jm) out.push(jm)
  const q = tri('질문지', prev.questionBankVersion ?? null, cur.questionBankVersion ?? null)
  if (q) out.push(q)
  const r = tri(
    '반복 횟수',
    prev.repeatsPerQuestion ? `${prev.repeatsPerQuestion}회` : null,
    cur.repeatsPerQuestion ? `${cur.repeatsPerQuestion}회` : null,
  )
  if (r) out.push(r)
  return [...out.filter((d) => d.state === 'changed'), ...out.filter((d) => d.state === 'unknown')]
}

/** 달라진(또는 확인할 수 없는) 조건 이름 전부 — 판단용(견줄 수 있나 · 어느 조건인가). 화면에 적을 때는 conditionLabels를 쓴다. */
export function conditionChanges(prev: Card, cur: Card): ConditionChange[] {
  return compareConditions(prev, cur).map((d) => d.dimension)
}

/** 처음 걸린 조건 이름(바뀐 조건이 먼저). 견줘도 되면 null. */
export function conditionChange(prev: Card, cur: Card): ConditionChange | null {
  return conditionChanges(prev, cur)[0] ?? null
}

/** 화면에 적을 조건 이름 — 바뀐 조건은 이름 그대로, 확인 불가는 「수집 모델 기록 없음」(기록이 없는 것을 「바뀜 · 다름」으로 적지 않는다). */
export function conditionLabel(d: ConditionDiff): string {
  return d.state === 'unknown' ? `${d.dimension} 기록 없음` : d.dimension
}

/** 두 측정 사이 조건 이름들(화면용) — 그래프 · 회차 · 올린 글처럼 「무엇이 달랐나」를 다 적을 때. */
export function conditionLabels(prev: Card, cur: Card): string[] {
  return compareConditions(prev, cur).map(conditionLabel)
}

/** 한 구절 요약 — 「질문지 · 반복 횟수 바뀜」 · 「수집 모델 · 판정 모델 기록 없음」 · 둘이 섞이면 「질문지 바뀜 · 수집 모델 기록 없음」. */
export function conditionSummary(diffs: ConditionDiff[]): string {
  const changed = diffs.filter((d) => d.state === 'changed').map((d) => d.dimension)
  const unknown = diffs.filter((d) => d.state === 'unknown').map((d) => d.dimension)
  return [changed.length ? `${changed.join(' · ')} 바뀜` : '', unknown.length ? `${unknown.join(' · ')} 기록 없음` : ''].filter(Boolean).join(' · ')
}

/** 조건 하나를 한 구절로 — 「판정 엔진 Gemini → Claude」 · 「판정 모델 기록 없음(확인 불가)」. */
export function diffText(d: ConditionDiff): string {
  if (d.state === 'unknown') return `${d.dimension} 기록이 한쪽에 없음(확인 불가)`
  return `${d.dimension} ${d.from} → ${d.to}`
}

/** 이유 한 줄 — 첫 조건은 값과 함께, 나머지는 이름만. */
export function conditionReason(diffs: ConditionDiff[]): string {
  if (diffs.length === 0) return ''
  const [first, ...rest] = diffs
  return [diffText(first!), ...rest.map((d) => (d.state === 'unknown' ? `${d.dimension} 확인 불가` : `${d.dimension} 바뀜`))].join(' · ')
}

/** ISO 주차(YYYY-Www)의 목요일(UTC 자정 ms). 형식이 아니면 null — src/prompts/isoWeek.ts와 같은 규칙(런타임 import를 두지 않는다). */
function isoThursday(weekOf: string): number | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(weekOf)
  if (!m) return null
  const year = Number(m[1])
  const week = Number(m[2])
  const jan4 = Date.UTC(year, 0, 4)
  const jan4Day = (new Date(jan4).getUTCDay() + 6) % 7 // 월요일 0
  return jan4 - jan4Day * 86_400_000 + 3 * 86_400_000 + (week - 1) * 7 * 86_400_000
}

/** 두 주차 사이 주 수(같은 주 0, 바로 다음 주 1). 형식이 아니면 null. */
export function weeksBetween(from: string, to: string): number | null {
  const a = isoThursday(from)
  const b = isoThursday(to)
  return a === null || b === null ? null : Math.round((b - a) / (7 * 86_400_000))
}

export interface Comparability {
  /** 비교한 앞 측정 주차. 불러온 이력 안에 앞 측정이 없으면 null. */
  previousWeekOf: string | null
  comparable: boolean
  diffs: ConditionDiff[]
  /** 견줄 수 없을 때 한 줄 이유. 견줄 수 있으면 ''. */
  reason: string
  /** 앞 측정과 몇 주 떨어졌나(1 = 바로 전 주). 2 이상이면 「전주」가 아니라 「직전 측정(Wxx)」으로 적는다. */
  gapWeeks: number | null
}

const sortCards = <T extends Card>(history: T[]) => [...history].sort((a, b) => a.weekOf.localeCompare(b.weekOf))

/**
 * 그 주와 바로 앞 측정을 견줘도 되는가. 앞 측정 = 이력에서 그 주보다 앞선 가장 최근 측정(측정하지 않은 주는 건너뛴다).
 * 이력에 그 주가 없거나 앞 측정이 없으면 previousWeekOf가 null이다(증감을 쓰지 않는다).
 */
export function comparableWith<T extends Card>(history: T[], weekOf: string, opts: { engine?: string | null } = {}): Comparability {
  const sorted = sortCards(history)
  const cur = sorted.find((c) => c.weekOf === weekOf)
  const prev = [...sorted].reverse().find((c) => c.weekOf < weekOf)
  if (!cur || !prev) return { previousWeekOf: prev?.weekOf ?? null, comparable: false, diffs: [], reason: '', gapWeeks: null }
  const diffs = compareConditions(prev, cur, opts)
  return {
    previousWeekOf: prev.weekOf,
    comparable: diffs.length === 0,
    diffs,
    reason:
      diffs.length === 0
        ? ''
        : diffs.some((d) => d.state === 'changed')
          ? `직전 측정(${prev.weekOf})과 측정 조건이 달라 비교하지 않음 — ${conditionReason(diffs)}`
          : `직전 측정(${prev.weekOf})과 견줄 측정 조건 기록이 한쪽에 없어 비교하지 않음 — ${conditionReason(diffs)}`,
    gapWeeks: weeksBetween(prev.weekOf, weekOf),
  }
}

/**
 * 같은 조건 구간을 세는 말 — 이웃한 측정이 모두 바로 다음 주면 「연속 N주」, 사이에 측정하지 않은 주가 있으면 「N번」
 * (W40 · W44만 같은 조건으로 잰 구간을 「연속 2주」라고 하지 않는다).
 */
export function runCountText(run: { weekOf: string }[]): string {
  if (run.length === 0) return ''
  const span = weeksBetween(run[0]!.weekOf, run[run.length - 1]!.weekOf)
  return span === run.length - 1 ? `연속 ${run.length}주` : `${run.length}번`
}

/**
 * 그 주에서 끝나는 같은 조건 연속 구간(오름차순) — 이웃한 측정끼리 모두 견줄 수 있는 동안 거슬러 올라간다. 그 주가 이력에 없으면
 * 빈 배열. 「측정 횟수」 점검 · 같은 조건 평균 · 콘텐츠 실측 사례가 같은 구간을 센다(떨어진 주를 건너뛰어 세지 않는다).
 */
export function comparableRun<T extends Card>(history: T[], weekOf: string): T[] {
  const sorted = sortCards(history)
  const i = sorted.findIndex((c) => c.weekOf === weekOf)
  if (i < 0) return []
  let start = i
  while (start > 0 && compareConditions(sorted[start - 1]!, sorted[start]!).length === 0) start -= 1
  return sorted.slice(start, i + 1)
}

/**
 * 같은 조건 평균 — 그 주에서 끝나는 같은 조건 구간의 최근 4개 측정 평균(반올림). 구간이 2개 측정 미만이면 null —
 * 조건이 바뀐 주를 섞은 평균(예전 「4주 이동평균」, 실측 lghellovision 점수 10 · 평균 28)을 보이지 않는다.
 */
export function runAverage(
  history: (Card & Pick<WeeklyScorecard, 'aeoScore'>)[],
  weekOf: string,
): { average: number; weeks: number } | null {
  const run = comparableRun(history, weekOf).slice(-4)
  if (run.length < 2) return null
  return { average: Math.round(run.reduce((s, c) => s + c.aeoScore.current, 0) / run.length), weeks: run.length }
}

/** 사이트 진단 주소 비교용 — 스킴 · www. · 끝 「/」 · 대소문자를 무시한다. */
function siteKey(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '')
}

/**
 * 두 사이트 진단을 점수 증감으로 견줘도 되는가 — 같은 페이지(주소)를 같은 방식(정적 · 브라우저)으로 잰 것끼리만.
 * 실측 ktcorp: W40 corp.kt.com 57점 → W41 www.kt.com 0점이 「-57」로 찍혔다(다른 페이지를 잰 것이다).
 */
export function siteComparable(
  prev: { url: string; collectionMode: string },
  cur: { url: string; collectionMode: string },
): boolean {
  return siteDifference(prev, cur) === null
}

/** 두 사이트 진단의 다른 점 — 「주소」 · 「수집 방식」 · 「주소 · 수집 방식」, 같으면 null. */
export function siteDifference(
  prev: { url: string; collectionMode: string },
  cur: { url: string; collectionMode: string },
): string | null {
  const parts = [siteKey(prev.url) !== siteKey(cur.url) ? '주소' : '', prev.collectionMode !== cur.collectionMode ? '수집 방식' : ''].filter(Boolean)
  return parts.length ? parts.join(' · ') : null
}
