import { useEffect, useMemo, useState } from 'react'
import { loadCohortTrend, loadEngineTrend, type CohortTrendPoint, type EngineTrendPoint } from '../lib/api'
import { useTenant } from '../context/useTenant'
import { ENGINE_LABEL, formatPct, formatRank, judgeLabel, weekLabel } from '../lib/format'
import { useScorecards } from '../lib/useScorecards'
import { useWeekSelection } from '../lib/useWeekSelection'
import { AEO_SCORE_WEIGHTS, type WeeklyScorecard } from '../prompts/b8-report'

/*
 * 설명용 라벨만 여기서 정하고 **퍼센트는 실제 계산에서 파생한다**.
 *
 * 예전에는 이 표에 25%/20%를 손으로 적어 두었고, 정기진단 보고서는 자기 표에 35%/10%를
 * 적어 두었다. 같은 앱의 두 화면이 같은 지표에 다른 가중치를 말했고 보고서 쪽이 틀렸다.
 * 손으로 베낀 표는 언젠가 어긋나므로 숫자를 적지 않는다.
 */
const WEIGHTS: { key: keyof typeof AEO_SCORE_WEIGHTS; label: string }[] = [
  { key: 'mentionRate', label: '카테고리 무관 언급률 (감성 가중)' },
  { key: 'shareOfMention', label: 'Share of Mention (감성 가중)' },
  { key: 'brandOwnedCitationRate', label: '브랜드 소유 출처(인용)' },
  { key: 'avgRecommendationRank', label: '추천 순위' },
  { key: 'factualityScore', label: '사실성' },
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

  /*
   * 엔진별 언급률 — 엔진을 한 그래프에 겹치지 않고 **엔진마다 따로** 그린다.
   *
   * 선을 겹치면 교차하는 선끼리 색으로 구분해야 하는데, 검증기 기준으로 그렇게 안전하게
   * 구분되는 색은 셋까지다(넷째부터 주황↔노랑이 정상시력에서도 안 갈린다). 게다가 우리
   * 데이터는 엔진이 주마다 들고 난다 — bymeps 실측: W36 ChatGPT+Gemini · W37 셋 · W38
   * ChatGPT+Perplexity. 겹쳐 그리면 선이 중간에 끊기고 없는 주가 이어진 것처럼 보인다.
   * 엔진마다 칸을 나누면 안 돈 주가 빈칸으로 그대로 드러난다.
   *
   * 점수가 아니라 언급률인 이유는 서버 쪽에 적어 뒀다(engineTrend.ts) — 엔진별 종합 점수는
   * 재정규화 분모가 달라 같은 축에 놓을 수 없다.
   */
  const [engineTrend, setEngineTrend] = useState<{ key: string; value: EngineTrendPoint[] }>({ key: '', value: [] })
  useEffect(() => {
    const id = tenant?.tenantId
    if (!id) return
    let alive = true
    void loadEngineTrend(id).then((v) => {
      if (alive) setEngineTrend({ key: id, value: v ?? [] })
    })
    return () => {
      alive = false
    }
  }, [tenant?.tenantId])
  // memo로 잡아야 아래 useMemo가 렌더마다 다시 돌지 않는다(조건식이 매번 새 배열을 만든다).
  const enginePoints = useMemo(
    () => (engineTrend.key === (tenant?.tenantId ?? '') ? engineTrend.value : []),
    [engineTrend, tenant?.tenantId],
  )
  const engineNames = useMemo(() => {
    const order = ['openai', 'gemini', 'claude', 'perplexity']
    const seen = new Set(enginePoints.flatMap((p) => p.byEngine.map((e) => e.engine)))
    return [...order.filter((e) => seen.has(e)), ...[...seen].filter((e) => !order.includes(e))]
  }, [enginePoints])
  // 칸 높이의 기준. 최소 10%로 잡아야 0.0%뿐인 브랜드에서 막대가 전부 사라지지 않는다.
  const engineMax = Math.max(
    0.1,
    ...enginePoints.flatMap((p) => p.byEngine.map((e) => e.mentionRate)),
  )
  const unclassified = enginePoints.filter((p) => p.byEngine.length === 0).map((p) => p.weekOf)
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
            <div className="spark" role="img" aria-label="주간 Brand AEO Score 막대 그래프와 코호트 평균선">
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

          {enginePoints.length > 0 && engineNames.length > 0 && (
            <section>
              <h3>엔진별 언급률</h3>
              <p className="hint" style={{ marginTop: 0 }}>
                같은 질문을 엔진마다 물었을 때 어디서 더 나오는지 봅니다. 계산은 위 점수와 같은 규칙입니다 —
                <b>브랜드명을 넣지 않은 질문</b>에서만 셉니다. 측정하지 않은 주는 빈칸입니다.
              </p>
              <div className="engine-facets">
                {engineNames.map((engine) => (
                  <div className="engine-facet" key={engine}>
                    <p className="facet-name">{ENGINE_LABEL[engine] ?? engine}</p>
                    <div className="facet-bars">
                      {enginePoints.map((p) => {
                        const row = p.byEngine.find((e) => e.engine === engine)
                        return (
                          <div
                            className={`facet-cell${row ? '' : ' is-empty'}`}
                            key={p.weekOf}
                            title={
                              row
                                ? `${weekLabel(p.weekOf)} · ${formatPct(row.mentionRate)} · 응답 ${row.answers}건`
                                : `${weekLabel(p.weekOf)} · 이 엔진으로 측정하지 않음`
                            }
                          >
                            <span className="facet-track">
                              {row && (
                                <span
                                  className="facet-fill"
                                  style={{ height: `${Math.max(2, (row.mentionRate / engineMax) * 100)}%` }}
                                />
                              )}
                            </span>
                            <span className="facet-value">{row ? formatPct(row.mentionRate) : '—'}</span>
                            <abbr title={weekLabel(p.weekOf)}>{p.weekOf.slice(-2)}</abbr>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
              {unclassified.length > 0 && (
                <p className="hint">
                  ※ {unclassified.map((w) => weekLabel(w)).join(' · ')}는 그 주차의 질문 은행을 읽지 못해 질문을
                  분류할 수 없었습니다 — 값을 지어내지 않고 비워 뒀습니다.
                </p>
              )}
            </section>
          )}

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
              Brand AEO Score는 아래 가중치의 가중합(0–100)입니다. 언급률과 SoM은 <b>같은 모집단</b>—브랜드명을 넣지 않은
              카테고리 무관 질문의 응답—에서 냅니다. 두 값에는 감성 계수(positive 1.0 / neutral 0.7 / negative 0.2)를
              곱하고, 경쟁사가 없거나 그 질문들에 아무 언급도 없어 SoM을 못 재거나 추천 문맥이 없어 순위를 못 재면 그
              가중치를 빼고 재정규화합니다. EEAT는 별도 진단 축이라 점수에는 포함하지 않으며, 리포트 단계에서 다시
              계산하지 않습니다.
            </p>
            <ul className="weights">
              {WEIGHTS.map((item) => (
                <li key={item.key}>
                  <strong>{Math.round(AEO_SCORE_WEIGHTS[item.key] * 100)}%</strong>
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
