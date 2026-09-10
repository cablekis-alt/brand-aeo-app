import type { WeeklyScorecard } from '../prompts/b8-report'

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

  // AEO Score 변화
  const aeoDelta = cur.aeoScore.current - prev.aeoScore.current
  if (aeoDelta <= -8) {
    alerts.push({ level: 'critical', title: `AEO Score 급락 ${aeoDelta}점`, detail: `전주 ${prev.aeoScore.current} → 이번 주 ${cur.aeoScore.current}. 4주 이동평균(${cur.aeoScore.ma4}) 추세도 함께 확인하세요.` })
  } else if (aeoDelta <= -4) {
    alerts.push({ level: 'warn', title: `AEO Score 하락 ${aeoDelta}점`, detail: `전주 ${prev.aeoScore.current} → 이번 주 ${cur.aeoScore.current}.` })
  } else if (aeoDelta >= 8) {
    alerts.push({ level: 'good', title: `AEO Score 상승 +${aeoDelta}점`, detail: `전주 ${prev.aeoScore.current} → 이번 주 ${cur.aeoScore.current}.` })
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
  const ciWidth = cur.aeoScore.ciHigh - cur.aeoScore.ciLow
  if (ciWidth >= 20) {
    alerts.push({ level: 'info', title: `변동성 큼 (95% CI 폭 ${Math.round(ciWidth)})`, detail: `이번 주 단일 변동은 과잉 해석하지 말고 4주 이동평균(${cur.aeoScore.ma4}) 추세로 판단하세요.` })
  }

  if (alerts.length === 0) {
    alerts.push({ level: 'good', title: '특이 변화 없음', detail: `전주 대비 큰 변동이 감지되지 않았습니다 (AEO ${prev.aeoScore.current} → ${cur.aeoScore.current}).` })
  }
  return alerts
}
