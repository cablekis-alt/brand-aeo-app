import { useEffect, useMemo, useState } from 'react'
import { loadCohortTrend, type CohortTrendPoint } from '../lib/api'
import { useTenant } from '../context/useTenant'
import { formatPct, formatRank, judgeLabel, weekLabel } from '../lib/format'
import { useScorecards } from '../lib/useScorecards'
import { useWeekSelection } from '../lib/useWeekSelection'
import type { WeeklyScorecard } from '../prompts/b8-report'

const WEIGHTS = [
  { label: '카테고리 무관 언급률 (감성 가중)', weight: '25%' },
  { label: 'Share of Mention (감성 가중)', weight: '25%' },
  { label: '브랜드 소유 출처(인용)', weight: '20%' },
  { label: '추천 순위', weight: '15%' },
  { label: '사실성', weight: '15%' },
]

function maxScore(history: WeeklyScorecard[]): number {
  return Math.max(100, ...history.map((card) => card.aeoScore.current))
}

export default function Performance() {
  const { tenant } = useTenant()
  const { history, loading, error } = useScorecards(tenant?.tenantId ?? '')
  const [selectedWeek, setSelectedWeek] = useWeekSelection(history)

  const card = useMemo(
    () => history.find((item) => item.weekOf === selectedWeek) ?? history.at(-1) ?? null,
    [history, selectedWeek],
  )
  const chartMax = maxScore(history)

  /*
   * 코호트 평균선 — 막대(자사) 위에 겹쳐 그린다.
   *
   * 순위("3/7")만으로는 얼마나 벌어졌는지 알 수 없고, 코호트 전체가 같이 오른 주에 우리만
   * 제자리여도 순위는 그대로다. 평균선을 겹쳐야 "우리가 오른 것"과 "판이 오른 것"이 갈린다.
   * 자사는 평균에서 빠진다(서버 cohortTrend.ts) — 코호트가 작아 자기 점수가 기준을 끌어당긴다.
   */
  const [trend, setTrend] = useState<{ key: string; value: CohortTrendPoint[] }>({ key: '', value: [] })
  useEffect(() => {
    const id = tenant?.tenantId
    if (!id) return
    let alive = true
    void loadCohortTrend(id).then((v) => {
      if (alive) setTrend({ key: id, value: v ?? [] })
    })
    return () => {
      alive = false
    }
  }, [tenant?.tenantId])
  const cohortAvgOf = useMemo(() => {
    const map = new Map<string, number>()
    if (trend.key !== (tenant?.tenantId ?? '')) return map
    for (const p of trend.value) if (p.avg !== null) map.set(p.weekOf, p.avg)
    return map
  }, [trend, tenant?.tenantId])
  // 평균이 있는 주만 선으로 잇는다. 값이 없는 주를 0으로 채우면 그래프가 거짓말을 한다.
  const avgPoints = history
    .map((item, i) => ({ i, avg: cohortAvgOf.get(item.weekOf) }))
    .filter((p): p is { i: number; avg: number } => p.avg !== undefined)
  const peerCount = trend.value.find((p) => p.peerCount > 0)?.peerCount ?? 0
  // 판단 엔진이 주차마다 다르면 점수 차이를 "변화"로 읽을 수 없다. 기록이 없는 구버전 카드는
  // 무엇으로 판정했는지 알 수 없으므로 섞였는지 판단에서 제외한다(추측하지 않는다).
  const mixedJudges = useMemo(
    () => [...new Set(history.map((item) => item.judgeEngine).filter((v): v is string => Boolean(v)))],
    [history],
  )

  return (
    <>
      <p className="brand">보고</p>
      <h1>브랜드 AEO 퍼포먼스</h1>
      <p className="lead">여러 주에 걸친 Score 추이를 4주 이동평균·95% 신뢰구간과 함께 봅니다.</p>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loading && history.length === 0 && <p className="muted">불러오는 중…</p>}
      {!loading && history.length === 0 && <p className="muted">아직 저장된 주간 데이터가 없습니다.</p>}

      {card && (
        <>
          <section>
            <h3>주간 추이</h3>
            <div className="spark" role="img" aria-label="주간 AEO Score 막대 그래프와 코호트 평균선">
              {history.map((item) => (
                <button
                  key={item.weekOf}
                  type="button"
                  className={item.weekOf === card.weekOf ? 'on' : undefined}
                  onClick={() => setSelectedWeek(item.weekOf)}
                  title={`${weekLabel(item.weekOf)} · 자사 ${item.aeoScore.current}${
                    cohortAvgOf.has(item.weekOf) ? ` · 코호트 평균 ${cohortAvgOf.get(item.weekOf)}` : ''
                  }`}
                >
                  <span className="bar-box">
                    <span
                      className="bar"
                      style={{ height: `${Math.max(8, (item.aeoScore.current / chartMax) * 100)}%` }}
                    />
                  </span>
                  <abbr title={weekLabel(item.weekOf)}>{item.weekOf.slice(-2)}</abbr>
                </button>
              ))}
              {avgPoints.length > 0 && (
                <svg className="spark-overlay" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                  {/* 끊긴 구간을 잇지 않으려고 연속한 점끼리만 선분을 긋는다. */}
                  {avgPoints.slice(1).map((p, k) => {
                    const prev = avgPoints[k]!
                    if (p.i !== prev.i + 1) return null
                    const x = (n: number) => ((n + 0.5) / history.length) * 100
                    const y = (v: number) => 100 - (v / chartMax) * 100
                    return (
                      <line key={p.i} x1={x(prev.i)} y1={y(prev.avg)} x2={x(p.i)} y2={y(p.avg)} className="avg-line" />
                    )
                  })}
                  {avgPoints.map((p) => {
                    const x = ((p.i + 0.5) / history.length) * 100
                    const y = 100 - (p.avg / chartMax) * 100
                    const half = 40 / history.length
                    return <line key={`t${p.i}`} x1={x - half} y1={y} x2={x + half} y2={y} className="avg-tick" />
                  })}
                </svg>
              )}
            </div>
            <p className="hint">
              막대는 <b>자사</b>, 가로선은 <b>코호트 평균</b>입니다
              {peerCount > 0 ? ` (자사를 뺀 ${peerCount}개 브랜드)` : ''}. 평균선 위로 올라간 주가 실제로 앞선 주입니다
              — 판 전체가 오른 주에는 점수가 올라도 선을 넘지 못합니다.
              {avgPoints.length === 0 && ' 이 브랜드의 업종·지역 코호트에 비교할 다른 브랜드가 없어 평균선이 없습니다.'}
            </p>
          </section>

          <section>
            <h3>주간 스코어카드</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>주차</th>
                    <th>Score</th>
                    <th>언급률</th>
                    <th>SoM</th>
                    <th>순위</th>
                    <th>사실성</th>
                    <th>인용</th>
                    <th>판단</th>
                  </tr>
                </thead>
                <tbody>
                  {[...history].reverse().map((item) => (
                    <tr
                      key={item.weekOf}
                      className={item.weekOf === card.weekOf ? 'selected' : undefined}
                      onClick={() => setSelectedWeek(item.weekOf)}
                    >
                      <td>{item.weekOf}</td>
                      <td>{item.aeoScore.current}</td>
                      <td>{formatPct(item.mentionRate)}</td>
                      <td>{formatPct(item.shareOfMention)}</td>
                      <td>{formatRank(item.avgRecommendationRank)}</td>
                      <td>{formatPct(item.factualityScore)}</td>
                      <td>{formatPct(item.brandOwnedCitationRate)}</td>
                      <td>{judgeLabel(item.judgeEngine)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {mixedJudges.length > 1 && (
              <p className="hint" style={{ marginTop: 10 }}>
                <b>주의</b> — 이 브랜드의 주차들이 서로 다른 판단 엔진으로 측정됐습니다(
                {mixedJudges.map((j) => judgeLabel(j)).join(' · ')}). 판단 엔진은 언급·인용·순위·사실성을 모두 판정하므로,
                엔진이 다른 주차끼리는 점수 차이를 <b>변화로 해석할 수 없습니다</b>.
              </p>
            )}
          </section>

          {card.hallucinationFlags.length > 0 && (
            <section className="panel warn">
              <h3>사실성 리스크 ({weekLabel(card.weekOf)})</h3>
              <ul>
                {card.hallucinationFlags.map((flag) => (
                  <li key={flag}>{flag}</li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h3>측정 방식</h3>
            <p className="muted">
              AEO Score는 아래 가중치의 가중합(0–100)입니다. 언급률과 SoM은 <b>같은 모집단</b>—브랜드명을 넣지 않은
              카테고리 무관 질문의 응답—에서 냅니다. 두 값에는 감성 계수(positive 1.0 / neutral 0.7 / negative 0.2)를
              곱하고, 경쟁사가 없거나 그 질문들에 아무 언급도 없어 SoM을 못 재거나 추천 문맥이 없어 순위를 못 재면 그
              가중치를 빼고 재정규화합니다. EEAT는 별도 진단 축이라 점수에는 포함하지 않으며, 리포트 단계에서 다시
              계산하지 않습니다.
            </p>
            <ul className="weights">
              {WEIGHTS.map((item) => (
                <li key={item.label}>
                  <strong>{item.weight}</strong>
                  {item.label}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </>
  )
}
