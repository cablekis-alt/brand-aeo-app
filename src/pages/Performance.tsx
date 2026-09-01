import { useMemo } from 'react'
import { useTenant } from '../context/useTenant'
import { formatPct, formatRank, weekLabel } from '../lib/format'
import { useScorecards } from '../lib/useScorecards'
import { useWeekSelection } from '../lib/useWeekSelection'
import type { WeeklyScorecard } from '../prompts/b8-report'

const WEIGHTS = [
  { label: '카테고리 무관 언급률', weight: '35%' },
  { label: 'Share of Mention', weight: '25%' },
  { label: '추천 순위', weight: '15%' },
  { label: '사실성', weight: '15%' },
  { label: '브랜드 소유 출처', weight: '10%' },
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

  return (
    <>
      <p className="brand">B-05 · 브랜드 퍼포먼스</p>
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
            <div className="spark" role="img" aria-label="주간 AEO Score 막대 그래프">
              {history.map((item) => (
                <button
                  key={item.weekOf}
                  type="button"
                  className={item.weekOf === card.weekOf ? 'on' : undefined}
                  onClick={() => setSelectedWeek(item.weekOf)}
                >
                  <span
                    className="bar"
                    style={{ height: `${Math.max(8, (item.aeoScore.current / chartMax) * 100)}%` }}
                  />
                  <abbr title={weekLabel(item.weekOf)}>{item.weekOf.slice(-2)}</abbr>
                </button>
              ))}
            </div>
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
              AEO Score는 아래 가중치의 가중합(0–100)이며, 리포트 단계에서 다시 계산하지 않습니다.
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
