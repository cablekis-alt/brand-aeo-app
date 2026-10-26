import type { WeeklyScorecard } from '../prompts/b8-report'
import { aeoScoreOf, scoreInputsOf, type ScorePartKey } from './b9-report'
import { comparableRun, compareConditions, conditionReason, runAverage, runCountText, weeksBetween } from './comparability'
import { ENGINE_LABEL } from './format'

// 주간 스코어카드 히스토리에서 "이번 주 vs 지난 주" 변화를 감지해 알림을 만든다.
// 새 데이터 수집 없이 기존 스코어카드만으로 계산한다(SoM 급락·순위 하락·사실성 오류·변동성 등).
export type AlertLevel = 'critical' | 'warn' | 'good' | 'info'

export interface Alert {
  level: AlertLevel
  title: string
  detail: string
  /** 더 볼 곳 — 화면이 링크로 그린다. */
  link?: { to: string; label: string }
}

/** 사실성 「틀림」 주장 하나(정기진단 보고서의 원문 목록과 같은 모양 — reviewReport.selfReview). */
export interface ContradictedClaim {
  question: string
  engine: string
  said: string
  registered: string
}

/**
 * 알림 문장을 사람 말로 쓰는 데 필요한 것 — 화면이 이미 읽은 기록을 넘긴다. 없으면 기록 줄에서 낼 수 있는 만큼만 쓴다.
 *   - contradicted: 이번 주 「틀림」 주장(질문 · 엔진 · AI 값 · 등록 값). 없으면 엔진별 응답 수만 적는다.
 *   - nameOf: 비교 그룹 구성원 id → 브랜드 이름(이번 주 처음 잰 곳을 이름으로 밝힐 때).
 */
export interface AlertContext {
  contradicted?: ContradictedClaim[]
  nameOf?: (tenantId: string) => string | undefined
}

/** 점수 항목 이름 — 증감이 어디서 왔는지 밝힐 때. */
const PART_LABEL: Record<ScorePartKey, string> = {
  mentionRate: '언급률',
  brandOwnedCitationRate: '자사 인용률',
  avgRecommendationRank: '추천 순위',
}

/**
 * 「틀림」 기록 줄(server/aggregate.ts: `openai / v5-006 #1: 사실성 불일치 1건`)을 엔진별 응답 수로 — 「ChatGPT 1건 · Gemini 3건」.
 * 질문 id · 회차 같은 내부 값은 쓰지 않는다. 모양이 다른 줄은 「기타」로 센다.
 */
export function factFlagSummary(flags: string[]): string {
  const counts = new Map<string, number>()
  for (const f of flags) {
    const id = /^([a-z0-9-]+) \/ /.exec(f)?.[1]
    const name = id ? (ENGINE_LABEL[id] ?? id) : '기타'
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts.entries()].map(([name, n]) => `${name} ${n}건`).join(' · ')
}

/** 「틀림」 주장 한 줄 — 「ChatGPT · 커플 여행 갈 때 … — AI “도보 3분” ↔ 등록 “13m”」. 질문이 길면 줄인다. */
export function contradictedLine(c: ContradictedClaim): string {
  const q = c.question.length > 28 ? `${c.question.slice(0, 28)}…` : c.question
  return `${c.engine} · ${q} — AI “${c.said}” ↔ 등록 “${c.registered}”`
}

const pct = (n: number) => `${(n * 100).toFixed(0)}%`

/**
 * 점수 목록 안에서의 경쟁 랭킹 위치(server/scoring.ts의 computeCohortRank와 같은 규칙) — 동점이면 「공동」. scores에는 자기 점수도
 * 들어 있다(비교 그룹 구성원 목록에 자기도 있다).
 */
function rankIn(score: number, scores: number[]): { position: number; tied: boolean } {
  return { position: scores.filter((s) => s > score).length + 1, tied: scores.filter((s) => s === score).length > 1 }
}

const rankText = (r: { position: number; tied: boolean }) => `${r.tied ? '공동 ' : ''}${r.position}위`

/**
 * 주차 간 코호트 순위 변화 — **두 주에 모두 측정된 브랜드끼리만** 비교한다.
 *
 * 저장된 position을 그대로 비교하면 안 된다. 주차마다 측정한 경쟁사 구성이 달라져
 * 내 점수가 그대로여도 순위가 움직인다. 나보다 점수 높은 경쟁사가 코호트에서 빠지면
 * 그 아래 모든 브랜드가 공짜로 한 계단 올라간다.
 *
 * 실측(2026-W36 → W37, 성형외과·서울 강남이 7개 → 5개):
 *   idhospital 4/7 → 2/5 인데 점수는 30 → 28로 **떨어졌다**. 옛 로직은 "순위 상승"을 알렸다.
 *
 * @returns 비교 가능한 순위 변화. members가 없는 옛 카드나 공통 브랜드가 2개 미만이면 null.
 */
function comparableRankChange(
  prev: WeeklyScorecard,
  cur: WeeklyScorecard,
): {
  from: { position: number; tied: boolean }
  to: { position: number; tied: boolean }
  total: number
  /** 직전 측정 구성원에 없던 곳 중 우리보다 점수가 높은 곳 — 이 비교에서 빠졌다고 밝힌다. */
  newAbove: { tenantId: string; aeoScore: number }[]
} | null {
  const prevMembers = prev.cohortRank.members
  const curMembers = cur.cohortRank.members
  if (!prevMembers?.length || !curMembers?.length) return null

  const prevScoreById = new Map(prevMembers.map((m) => [m.tenantId, m.aeoScore]))
  const shared = curMembers.filter((m) => prevScoreById.has(m.tenantId))
  if (shared.length < 2) return null

  return {
    from: rankIn(prev.aeoScore.current, shared.map((m) => prevScoreById.get(m.tenantId) as number)),
    to: rankIn(cur.aeoScore.current, shared.map((m) => m.aeoScore)),
    total: shared.length,
    newAbove: curMembers.filter((m) => !prevScoreById.has(m.tenantId) && m.aeoScore > cur.aeoScore.current),
  }
}

/**
 * 점수 증감이 주로 어느 항목에서 왔나 — 실측 스테이,머뭄 W42 → W43 +11은 거의 순위 응답 2건에서 나왔는데 알림만 보면 노출이 크게
 * 는 것처럼 읽혔다(상용화 UI 3차 U20).
 *
 * 항목마다 「직전 측정에 이번 주 그 항목 값만 넣었을 때」 점수가 얼마나 움직이는지 본다(나머지는 직전 값). 항목별 보탠 점수를 빼서
 * 견주면 안 된다 — 순위 몫이 바뀌면 재정규화로 언급률 · 자사 인용 몫이 값 변화 없이 커지거나 줄어, 순위가 만든 증감을 「언급률에서」라고
 * 짚는다(1-B 검토). 한 항목이 증감의 60% 이상이고 방향이 같을 때만 그 이름을 적는다.
 */
function deltaSource(prev: WeeklyScorecard, cur: WeeklyScorecard, delta: number): string | null {
  const p = scoreInputsOf(prev)
  const q = scoreInputsOf(cur)
  const base = aeoScoreOf(p)
  const effects: { key: ScorePartKey; d: number }[] = [
    { key: 'mentionRate', d: aeoScoreOf({ ...p, mentionRate: q.mentionRate, sentiment: q.sentiment }) - base },
    { key: 'brandOwnedCitationRate', d: aeoScoreOf({ ...p, brandOwnedCitationRate: q.brandOwnedCitationRate }) - base },
    {
      key: 'avgRecommendationRank',
      d: aeoScoreOf({ ...p, avgRecommendationRank: q.avgRecommendationRank, rankedResponses: q.rankedResponses }) - base,
    },
  ]
  const top = effects.sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0]
  if (!top || Math.sign(top.d) !== Math.sign(delta) || Math.abs(top.d) < Math.abs(delta) * 0.6) return null
  if (top.key !== 'avgRecommendationRank') return `이번 증감의 대부분은 ${PART_LABEL[top.key]}에서 나왔습니다.`
  // 순위가 빠진 주는 「순위 응답 0건에서 나왔다」가 아니라 빠졌다고 말한다.
  if (cur.avgRecommendationRank === null) return '이번 증감의 대부분은 추천 순위가 점수에서 빠진 데서 나왔습니다(순위가 매겨진 응답 없음).'
  return `이번 증감의 대부분은 추천 순위${cur.rankedResponses !== undefined ? `(순위 응답 ${cur.rankedResponses}건)` : ''}에서 나왔습니다.`
}

/**
 * 같은 조건 평균 한 구절 — 「같은 조건 연속 3주 평균 28점」(사이에 재지 않은 주가 있으면 「같은 조건 3번 평균」).
 * 저장된 ma4(측정 당시 4주 이동평균)는 조건이 바뀐 주를 섞는다(실측 lghellovision 점수 10 · 평균 28) — 쓰지 않고 이력에서 센다.
 * 같은 조건으로 2번 이상 잰 구간이 없으면 null이고, 그 문장은 빼고 알린다.
 */
function sameConditionAverage(history: WeeklyScorecard[], weekOf: string): string | null {
  const avg = runAverage(history, weekOf)
  if (!avg) return null
  return `같은 조건 ${runCountText(comparableRun(history, weekOf).slice(-4))} 평균 ${avg.average}점`
}

/** 이번 주만으로 판단하는 알림이라 측정 조건 가드와 무관하다 — 두 경로에서 같이 쓴다. */
function ciWidthAlert(cur: WeeklyScorecard, average: string | null): Alert | null {
  // 하한은 0에서 잘려 있어(ciBounds) 상한 − 하한은 흔들림을 줄여 보인다. 자르기 전 폭으로 판단한다.
  const ciWidth = 2 * (cur.aeoScore.ciHigh - cur.aeoScore.current)
  if (ciWidth < 20) return null
  return {
    level: 'info',
    title: `변동성 큼 (95% CI 폭 ${Math.round(ciWidth)})`,
    detail: average
      ? `이번 주 단일 변동은 과잉 해석하지 말고 ${average}을 함께 보세요.`
      : '이번 주 단일 변동은 과잉 해석하지 마세요.',
  }
}

export function computeAlerts(history: WeeklyScorecard[], context: AlertContext = {}): Alert[] {
  if (!history || history.length === 0) return []
  const sorted = [...history].sort((a, b) => a.weekOf.localeCompare(b.weekOf))
  const cur = sorted[sorted.length - 1]
  const prev = sorted.length >= 2 ? sorted[sorted.length - 2] : null
  const alerts: Alert[] = []

  /*
   * 사실성 「틀림」은 전주 비교 없이도 알린다. 판정 오류일 수도 있어(다른 브랜드에 대한 답을 이 브랜드 사실과 대조) 「경고」가 아니라
   * 「주의」로 두고 「판정 검토 전」이라고 밝힌다 — 정기진단 보고서도 같은 4건을 「판정 오류일 수도」라고 말한다. 기록 줄의 내부 값
   * (openai / v5-006 #1)은 쓰지 않고 무엇이 어긋났는지 적는다(상용화 UI 3차 U23).
   */
  if (cur.hallucinationFlags && cur.hallucinationFlags.length > 0) {
    const n = cur.hallucinationFlags.length
    const claims = context.contradicted ?? []
    alerts.push({
      level: 'warn',
      title: `사실 확인 필요 — AI 응답 ${n}건 (판정 검토 전)`,
      // 제목의 N은 응답 수(기록 줄은 응답마다 한 줄), 아래 목록은 주장 단위다 — 한 응답에 틀린 주장이 여럿일 수 있어 「주장」이라고 밝힌다.
      detail:
        claims.length > 0
          ? `${contradictedLine(claims[0]!)}${claims.length > 1 ? ` 외 주장 ${claims.length - 1}건` : ''}`
          : `${factFlagSummary(cur.hallucinationFlags)}의 응답이 등록된 브랜드 정보와 다릅니다.`,
      link: { to: '/report', label: `정기진단 보고서에서 ${n}건 확인` },
    })
  }

  if (!prev) {
    alerts.push({
      level: 'info',
      title: '기준선 형성 중 (측정 1주차)',
      detail: '전주 데이터가 아직 없어 변화 비교를 시작하지 못했습니다. 다음 주 측정부터 변화 알림이 표시됩니다.',
    })
    return alerts
  }

  // 같은 조건 평균 — 조건이 바뀐 주에는 같은 조건 구간이 이번 주 하나뿐이라 null(문장이 빠진다).
  const average = sameConditionAverage(sorted, cur.weekOf)

  /*
   * 측정 조건이 바뀌었거나 한쪽에만 기록이 있어 확인할 수 없으면 측정에서 파생된 변화를 알리지 않는다 — 앱 공용 규칙
   * (compareConditions, lib/comparability) 하나로 개요 칩 · 5주 추이 표식 · 정기진단 보고서와 같은 판정을 쓴다. 예전에는
   * 수집 · 판정 엔진만 봐서 개요 칩이 「질문지 달라 비교 불가」인데 이 알림은 「상승 +11점」이라고 했다.
   * 틀린 방향의 경고보다 침묵이 낫다는 판단은 코호트 구성 가드(comparableRankChange)와 같다.
   */
  const diffs = compareConditions(prev, cur)
  if (diffs.length > 0) {
    alerts.push({
      level: 'info',
      // 기록이 없는 것을 「달라」라고 하지 않는다 — 바뀐 조건이 하나라도 있을 때만 「달라」.
      title: diffs.some((d) => d.state === 'changed')
        ? '측정 조건이 달라 직전 측정과 비교할 수 없음'
        : '측정 조건 기록이 한쪽에 없어 직전 측정과 비교할 수 없음',
      // 무엇이 달랐는지 밝힌다 — 첫 조건은 값과 함께(「판정 엔진 Gemini → Claude」), 나머지는 이름만.
      detail: conditionReason(diffs),
    })
    const ci = ciWidthAlert(cur, average)
    if (ci) alerts.push(ci)
    return alerts
  }

  // 앞 측정이 2주 이상 떨어져 있으면(사이에 재지 않은 주) 「전주」가 아니라 「직전 측정(Wxx)」 — 개요 칩 · 정기진단 보고서와 같은 말.
  const before = (weeksBetween(prev.weekOf, cur.weekOf) ?? 1) >= 2 ? `직전 측정(${prev.weekOf.replace(/^\d{4}-/, '')})` : '전주'

  // Brand AEO Score 변화
  const aeoDelta = cur.aeoScore.current - prev.aeoScore.current
  if (aeoDelta <= -8) {
    alerts.push({
      level: 'critical',
      title: `Brand AEO Score 급락 ${aeoDelta}점`,
      detail: `${before} ${prev.aeoScore.current} → 이번 주 ${cur.aeoScore.current}.${average ? ` ${average}도 함께 확인하세요.` : ''}`,
    })
  } else if (aeoDelta <= -4) {
    alerts.push({ level: 'warn', title: `Brand AEO Score 하락 ${aeoDelta}점`, detail: `${before} ${prev.aeoScore.current} → 이번 주 ${cur.aeoScore.current}.` })
  } else if (aeoDelta >= 8) {
    alerts.push({ level: 'good', title: `Brand AEO Score 상승 +${aeoDelta}점`, detail: `${before} ${prev.aeoScore.current} → 이번 주 ${cur.aeoScore.current}.` })
  }
  // 큰 증감은 어디서 왔는지 덧붙인다 — 순위 응답 몇 건이 만든 점수를 노출이 는 것으로 읽지 않게.
  if (Math.abs(aeoDelta) >= 8) {
    const source = deltaSource(prev, cur, aeoDelta)
    const last = alerts[alerts.length - 1]
    if (source && last) last.detail = `${last.detail} ${source}`
  }

  /*
   * 언급 점유율 변화(둘 다 측정된 경우만). 점유율은 이 브랜드 응답 안에서 등록 경쟁사 목록으로 센다(server/aggregate.ts) — 비교 그룹
   * 구성원과는 상관이 없어 구성원 변화로 증감을 거르지 않는다(1-B 검토: 「이 브랜드만 측정」으로 구성원이 줄면 진짜 급락이 가려졌다).
   */
  if (cur.shareOfMention !== null && prev.shareOfMention !== null) {
    const somDelta = cur.shareOfMention - prev.shareOfMention
    if (somDelta <= -0.15) {
      alerts.push({ level: 'warn', title: `언급 점유율 급락`, detail: `${before} ${pct(prev.shareOfMention)} → 이번 주 ${pct(cur.shareOfMention)} (${(somDelta * 100).toFixed(0)}%p). 경쟁사 대비 언급 점유가 줄었습니다.` })
    } else if (somDelta >= 0.15) {
      alerts.push({ level: 'good', title: `언급 점유율 상승`, detail: `${before} ${pct(prev.shareOfMention)} → 이번 주 ${pct(cur.shareOfMention)} (+${(somDelta * 100).toFixed(0)}%p).` })
    }
  }

  /*
   * 비교 그룹 순위 변화(position 증가 = 하락). 비교 가능한 집합이 없으면 알리지 않는다 — 틀린 방향의 경고보다 침묵이 낫다
   * (comparableRankChange 주석 참고). 두 주 모두 잰 곳 사이의 순위라 화면의 이번 주 순위(공동 2 / 7)와 다를 수 있다 — 제목에
   * 기준을 담고, 이번 주 전체 순위와 이번 주 처음 잰 곳(이 비교에서 빠짐)을 함께 적는다. 예전엔 「코호트 순위 상승 3위 → 1위」가
   * 바로 아래 「공동 2 / 7」과 어긋났다(실측 스테이,머뭄 W43 — 처음 잰 여미랑이 빠지고, 동점에 「공동」이 없었다. 상용화 UI 3차 U8).
   * 우리보다 높은 곳이 이번 주에 처음 들어왔으면 「상승」을 좋은 소식으로 내세우지 않는다(안내).
   */
  const rankChange = comparableRankChange(prev, cur)
  if (rankChange && rankChange.to.position !== rankChange.from.position) {
    const down = rankChange.to.position > rankChange.from.position
    const title = `두 주 모두 잰 ${rankChange.total}곳 사이 순위 ${down ? '하락' : '상승'} ${rankText(rankChange.from)} → ${rankText(rankChange.to)}`
    const whole = `이번 주 비교 그룹 전체로는 ${(cur.cohortRank.tiedCount ?? 1) > 1 ? '공동 ' : ''}${cur.cohortRank.position} / ${cur.cohortRank.totalTenants}입니다.`
    const newcomers = rankChange.newAbove
      .map((m) => {
        const name = context.nameOf?.(m.tenantId)
        return name ? `${name}(${m.aeoScore}점)` : null
      })
      .filter((x): x is string => x !== null)
    // 직전 측정 구성원에 없던 곳 — 처음 잰 곳인지는 모른다(앞서 쟀다가 직전 주에 빠졌을 수 있다). 데이터가 말하는 만큼만 쓴다.
    const left =
      rankChange.newAbove.length === 0
        ? ''
        : ` 직전 측정에 없던 ${newcomers.length === rankChange.newAbove.length ? newcomers.join(' · ') : `${rankChange.newAbove.length}곳`}은 이 비교에서 빠졌습니다.`
    alerts.push(
      down
        ? { level: 'warn', title, detail: `${whole}${left} 경쟁사에 자리를 내줬습니다.` }
        : { level: rankChange.newAbove.length > 0 ? 'info' : 'good', title, detail: `${whole}${left}` },
    )
  }

  // 사실 정확도 하락 — 두 주 모두 실제로 대조한 사실이 있을 때만 비교한다(측정 불가 주는 건너뜀).
  const curFact = cur.factualityScore
  const prevFact = prev.factualityScore
  if (curFact !== null && prevFact !== null && curFact - prevFact <= -0.1) {
    alerts.push({ level: 'warn', title: `사실 정확도 하락`, detail: `${before} ${pct(prevFact)} → 이번 주 ${pct(curFact)}. AI가 틀린 정보를 말하는 비율이 늘었습니다.` })
  }

  // 변동성(신뢰구간 폭)이 크면 단일 변동 과잉해석 주의
  const ci = ciWidthAlert(cur, average)
  if (ci) alerts.push(ci)

  if (alerts.length === 0) {
    alerts.push({ level: 'good', title: '특이 변화 없음', detail: `${before} 대비 큰 변동이 감지되지 않았습니다 (AEO ${prev.aeoScore.current} → ${cur.aeoScore.current}).` })
  }
  return alerts
}
