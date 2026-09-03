import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import WeekPicker from '../components/WeekPicker'
import { useTenant } from '../context/useTenant'
import { loadEeat } from '../lib/api'
import { weekLabel } from '../lib/format'
import { useScorecards } from '../lib/useScorecards'
import { useWeekSelection } from '../lib/useWeekSelection'
import { useWeeklyData } from '../lib/useWeeklyData'
import { buildPeriodicReport, PRIORITY_LABEL, STATUS_LABEL } from '../lib/b9-report'
import type { EeatAnalysis } from '../prompts/b6-eeat'

const EMPTY_EEAT: EeatAnalysis = {
  overall: 0,
  experience: { score: 0, evidence: [] },
  expertise: { score: 0, evidence: [] },
  authoritativeness: { score: 0, evidence: [] },
  trustworthiness: { score: 0, evidence: [] },
  mentionedCallCount: 0,
  totalCallCount: 0,
}

export default function PeriodicReport() {
  const { tenant } = useTenant()
  const { history, loading, error } = useScorecards(tenant?.tenantId ?? '')
  const [weekOf, setWeekOf] = useWeekSelection(history)
  const { data: eeat } = useWeeklyData(loadEeat, tenant?.tenantId ?? '', weekOf, EMPTY_EEAT)

  const card = useMemo(() => history.find((h) => h.weekOf === weekOf) ?? history.at(-1) ?? null, [history, weekOf])
  const report = useMemo(
    () => (history.length ? buildPeriodicReport(history, weekOf || (history.at(-1)?.weekOf ?? ''), eeat) : null),
    [history, weekOf, eeat],
  )

  if (!tenant) return null

  return (
    <>
      <p className="brand">STAGE 4</p>
      <h1>정기진단 보고서 · 개선제안</h1>
      <p className="lead">
        이번 주 스코어카드를 지표별로 진단하고, 약한 지표를 우선순위가 매겨진 실행 가능한 개선안으로 정리합니다. 모든
        판정은 측정된 수치에서 결정적으로 도출되며 새 수치를 만들지 않습니다.
      </p>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loading && history.length === 0 && <p className="muted">불러오는 중…</p>}
      {!loading && history.length === 0 && <p className="muted">아직 저장된 주간 데이터가 없습니다. 먼저 측정을 실행하세요.</p>}

      {card && report && (
        <>
          <div className="filters no-print">
            <WeekPicker weeks={history.map((h) => h.weekOf)} value={weekOf} onChange={setWeekOf} />
            <button type="button" className="ghost" onClick={() => window.print()}>
              인쇄 · PDF 저장
            </button>
          </div>

          <section className={`report-verdict sev-${report.verdict.tone}`}>
            <p className="eyebrow">
              {card.brandName} · {weekLabel(card.weekOf)} · {card.industry} · {card.region}
            </p>
            <p className="verdict-head">
              종합 판정 <strong>{report.verdict.label}</strong>
              <span className="score-chip">AEO {card.aeoScore.current}</span>
            </p>
            <p className="verdict-summary">{report.verdict.summary}</p>
            {report.variabilityNote && <p className="hint">※ {report.variabilityNote}</p>}
          </section>

          <section>
            <h3>지표별 진단</h3>
            <div className="table-wrap">
              <table className="diagnosis-table">
                <thead>
                  <tr>
                    <th>지표</th>
                    <th>값</th>
                    <th>전주 대비</th>
                    <th>상태</th>
                    <th>진단</th>
                  </tr>
                </thead>
                <tbody>
                  {report.metrics.map((m) => (
                    <tr key={m.key}>
                      <td>
                        {m.label}
                        {m.weight > 0 && <span className="weight-tag">{Math.round(m.weight * 100)}%</span>}
                      </td>
                      <td className="num">{m.valueText}</td>
                      <td className="num">
                        {m.delta ? <span className={`delta ${m.delta.tone}`}>{m.delta.text}</span> : <span className="muted">–</span>}
                      </td>
                      <td>
                        <span className={`status-pill st-${m.status}`}>{STATUS_LABEL[m.status]}</span>
                      </td>
                      <td className="judgment">{m.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {report.strengths.length > 0 && (
            <section className="panel">
              <h3>잘하고 있는 점</h3>
              <ul className="strength-list">
                {report.strengths.map((m) => (
                  <li key={m.key}>
                    <strong>{m.label}</strong> {m.valueText} — {m.note}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {report.risks.length > 0 && (
            <section className="panel warn">
              <h3>리스크 · 사실성 위반 ({report.risks.length}건)</h3>
              <ul>
                {report.risks.map((flag) => (
                  <li key={flag}>{flag}</li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h3>개선제안 ({report.recommendations.length})</h3>
            {report.recommendations.length === 0 ? (
              <p className="muted">주의·미흡 지표가 없어 별도 개선제안이 없습니다. 현재 수준을 유지하세요.</p>
            ) : (
              <ol className="rec-list">
                {report.recommendations.map((rec, i) => (
                  <li key={rec.id} className={`rec-card pr-${rec.priority}`}>
                    <div className="rec-head">
                      <span className="rec-num">{i + 1}</span>
                      <h4>{rec.title}</h4>
                      <span className={`priority-pill pr-${rec.priority}`}>우선순위 {PRIORITY_LABEL[rec.priority]}</span>
                    </div>
                    <p className="rec-basis">{rec.basis}</p>
                    <p className="rec-label">실행안</p>
                    <ul className="rec-actions">
                      {rec.actions.map((a, j) => (
                        <li key={j}>{a}</li>
                      ))}
                    </ul>
                    <p className="rec-expected">
                      <strong>기대효과</strong> {rec.expected}
                    </p>
                    <p className="rec-links no-print">
                      {rec.links.map((l) => (
                        <Link key={l.to} to={l.to} className="rec-link">
                          {l.label} →
                        </Link>
                      ))}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <p className="disclaimer">
            개선제안은 측정 지표의 강약을 규칙으로 매핑한 가이드입니다. 실제 반영 효과는 다음 측정에서 확인하세요. 점수·수치는
            리포트 단계에서 재계산하지 않습니다.
          </p>
        </>
      )}
    </>
  )
}
