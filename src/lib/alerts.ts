import type { WeeklyScorecard } from '../prompts/b8-report'
import { ENGINE_LABEL } from './format'

// 주간 스코어카드 히스토리에서 "이번 주 vs 지난 주" 변화를 감지해 알림을 만든다.
// 새 데이터 수집 없이 기존 스코어카드만으로 계산한다(SoM 급락·순위 하락·사실성 오류·변동성 등).
export type AlertLevel = 'critical' | 'warn' | 'good' | 'info'

export interface Alert {
  level: AlertLevel
  title: string
  detail: string
}

const pct = (n: number) => `${(n * 100).toFixed(0)}%`

/** 점수 목록 안에서의 경쟁 랭킹 위치(server/scoring.ts의 computeCohortRank와 같은 규칙). */
const rankIn = (score: number, scores: number[]) => scores.filter((s) => s > score).length + 1

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
): { from: number; to: number; total: number } | null {
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
  }
}

/**
 * 두 주를 견줄 수 있나 — 수집 엔진이 같아야 한다.
 *
 * 엔진 하나를 덜 재면 질문당 답변 수가 줄어 점수·SoM·순위가 전부 움직인다. 그 변화를
 * "실력 변화"로 알리면 측정 도구로서 거짓말이 된다. 옛 카드는 enginesUsed가 비어 있는데,
 * 그때는 알 수 없으므로 비교를 막지 않는다(막으면 과거 데이터의 알림이 전부 사라진다).
 */
/** 이번 주만으로 판단하는 알림이라 엔진 가드와 무관하다 — 두 경로에서 같이 쓴다. */
function ciWidthAlert(cur: WeeklyScorecard): Alert | null {
  const ciWidth = cur.aeoScore.ciHigh - cur.aeoScore.ciLow
  if (ciWidth < 20) return null
  return {
    level: 'info',
    title: `변동성 큼 (95% CI 폭 ${Math.round(ciWidth)})`,
    detail: `이번 주 단일 변동은 과잉 해석하지 말고 4주 이동평균(${cur.aeoScore.ma4}) 추세로 판단하세요.`,
  }
}

function sameEngines(a: WeeklyScorecard, b: WeeklyScorecard): boolean {
  const x = [...(a.enginesUsed ?? [])].sort()
  const y = [...(b.enginesUsed ?? [])].sort()
  if (x.length === 0 || y.length === 0) return true
  return x.length === y.length && x.every((e, i) => e === y[i])
}

/**
 * 판정 엔진이 같은가 — 같은 원문이라도 판정이 바뀌면 언급·순위·사실성 값이 달라진다.
 * 수집 엔진만 막고 판정은 통과시키면 앞뒤가 안 맞는다.
 */
function sameJudge(a: WeeklyScorecard, b: WeeklyScorecard): boolean {
  if (!a.judgeEngine || !b.judgeEngine) return true // 옛 카드는 알 수 없어 막지 않는다
  return a.judgeEngine === b.judgeEngine
}

export function computeAlerts(history: WeeklyScorecard[]): Alert[] {
  if (!history || history.length === 0) return []
  const sorted = [...history].sort((a, b) => a.weekOf.localeCompare(b.weekOf))
  const cur = sorted[sorted.length - 1]
  const prev = sorted.length >= 2 ? sorted[sorted.length - 2] : null
  const alerts: Alert[] = []

  // 사실성 오류(할루시네이션)는 전주 비교 없이도 즉시 알린다.
  if (cur.hallucinationFlags && cur.hallucinationFlags.length > 0) {
    alerts.push({
      level: 'critical',
      title: `사실성 오류 ${cur.hallucinationFlags.length}건`,
      detail: `AI 답변이 브랜드 정보를 잘못 말한 항목이 있습니다: ${cur.hallucinationFlags.slice(0, 2).join(' / ')}${cur.hallucinationFlags.length > 2 ? ' …' : ''}`,
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

  // 엔진 구성이 다르면 측정에서 파생된 변화를 알리지 않는다. 틀린 방향의 경고보다 침묵이
  // 낫다는 판단은 코호트 구성 가드(comparableRankChange)와 같다.
  if (!sameEngines(prev, cur) || !sameJudge(prev, cur)) {
    const label = (c: WeeklyScorecard) =>
      (c.enginesUsed ?? []).map((e) => ENGINE_LABEL[e] ?? e).join('·') || '알 수 없음'
    const judge = (c: WeeklyScorecard) => ENGINE_LABEL[c.judgeEngine ?? ''] ?? c.judgeEngine ?? '알 수 없음'
    // 무엇이 달라졌는지 밝힌다 — "엔진이 달라서"만으로는 수집인지 판정인지 알 수 없다.
    const what = !sameEngines(prev, cur)
      ? `수집 엔진이 ${label(prev)} → ${label(cur)}로 바뀌었습니다.`
      : `판정 엔진이 ${judge(prev)} → ${judge(cur)}로 바뀌었습니다.`
    alerts.push({
      level: 'info',
      title: '엔진이 달라 전주와 비교할 수 없음',
      detail:
        `${what} 엔진이 바뀌면 점수·점유·순위가 함께 움직이므로, ` +
        `점수 차이(${prev.aeoScore.current} → ${cur.aeoScore.current})를 실력 변화로 읽으면 안 됩니다. ` +
        `같은 엔진으로 두 주를 재면 비교가 살아납니다.`,
    })
    const ci = ciWidthAlert(cur)
    if (ci) alerts.push(ci)
    return alerts
  }

  // Brand AEO Score 변화
  const aeoDelta = cur.aeoScore.current - prev.aeoScore.current
  if (aeoDelta <= -8) {
    alerts.push({ level: 'critical', title: `Brand AEO Score 급락 ${aeoDelta}점`, detail: `전주 ${prev.aeoScore.current} → 이번 주 ${cur.aeoScore.current}. 4주 이동평균(${cur.aeoScore.ma4}) 추세도 함께 확인하세요.` })
  } else if (aeoDelta <= -4) {
    alerts.push({ level: 'warn', title: `Brand AEO Score 하락 ${aeoDelta}점`, detail: `전주 ${prev.aeoScore.current} → 이번 주 ${cur.aeoScore.current}.` })
  } else if (aeoDelta >= 8) {
    alerts.push({ level: 'good', title: `Brand AEO Score 상승 +${aeoDelta}점`, detail: `전주 ${prev.aeoScore.current} → 이번 주 ${cur.aeoScore.current}.` })
  }

  // Share of Mention 변화(둘 다 측정된 경우만)
  if (cur.shareOfMention !== null && prev.shareOfMention !== null) {
    const somDelta = cur.shareOfMention - prev.shareOfMention
    if (somDelta <= -0.15) {
      alerts.push({ level: 'warn', title: `Share of Mention 급락`, detail: `전주 ${pct(prev.shareOfMention)} → 이번 주 ${pct(cur.shareOfMention)} (${(somDelta * 100).toFixed(0)}%p). 경쟁사 대비 언급 점유가 줄었습니다.` })
    } else if (somDelta >= 0.15) {
      alerts.push({ level: 'good', title: `Share of Mention 상승`, detail: `전주 ${pct(prev.shareOfMention)} → 이번 주 ${pct(cur.shareOfMention)} (+${(somDelta * 100).toFixed(0)}%p).` })
    }
  }

  // 코호트 순위 변화(position 증가 = 하락). 비교 가능한 집합이 없으면 알리지 않는다 —
  // 틀린 방향의 경고보다 침묵이 낫다(comparableRankChange 주석 참고).
  const rankChange = comparableRankChange(prev, cur)
  if (rankChange && rankChange.to !== rankChange.from) {
    const basis = `두 주에 모두 측정된 ${rankChange.total}개 브랜드 기준.`
    const title = `코호트 순위 ${rankChange.to > rankChange.from ? '하락' : '상승'} ${rankChange.from}위 → ${rankChange.to}위`
    alerts.push(
      rankChange.to > rankChange.from
        ? { level: 'warn', title, detail: `${basis} 경쟁사에 자리를 내줬습니다.` }
        : { level: 'good', title, detail: basis },
    )
  }

  // 사실성 점수 하락
  const factDelta = cur.factualityScore - prev.factualityScore
  if (factDelta <= -0.1) {
    alerts.push({ level: 'warn', title: `사실 정확도 하락`, detail: `전주 ${pct(prev.factualityScore)} → 이번 주 ${pct(cur.factualityScore)}. AI가 틀린 정보를 말하는 비율이 늘었습니다.` })
  }

  // 변동성(신뢰구간 폭)이 크면 단일 변동 과잉해석 주의
  const ci = ciWidthAlert(cur)
  if (ci) alerts.push(ci)

  if (alerts.length === 0) {
    alerts.push({ level: 'good', title: '특이 변화 없음', detail: `전주 대비 큰 변동이 감지되지 않았습니다 (AEO ${prev.aeoScore.current} → ${cur.aeoScore.current}).` })
  }
  return alerts
}
