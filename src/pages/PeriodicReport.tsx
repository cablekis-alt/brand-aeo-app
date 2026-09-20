import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import WeekPicker from '../components/WeekPicker'
import { useTenant } from '../context/useTenant'
import { loadCitationSources, loadEeat, loadSiteScores, type SiteScoreRecord } from '../lib/api'
import { comparisonFromHistory } from '../lib/citationView'
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

/** 전주 대비 증감. prev가 null이면 아무것도 그리지 않는다 — 비교가 없는 것과 보합은 다르다. */
function Delta({ now, prev }: { now: number; prev: number | null }) {
  if (prev === null) return null
  const d = Math.round((now - prev) * 10) / 10
  if (d === 0) return <span className="delta flat">보합</span>
  return (
    <span className={`delta ${d > 0 ? 'up' : 'down'}`}>
      {d > 0 ? '+' : ''}
      {d}
    </span>
  )
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

  /*
   * 맨 위 3타일 — 보고서를 판정 문장이 아니라 숫자 셋으로 연다.
   *
   * 지금은 「종합 판정」부터 나와서, 읽는 사람이 문장을 해석한 뒤에야 상태를 안다. 정기
   * 리포트는 훑어보는 문서라 첫 화면에서 "올랐나 내렸나"가 먼저 보여야 한다.
   *
   * 셋을 고른 이유: Brand는 답변에서의 가시성, Site는 페이지 준비도, 인용 건수는 그 주에
   * 엔진이 실제로 근거를 얼마나 끌어왔는지 — 서로 다른 축이라 함께 봐야 한다.
   */
  const comparison = useMemo(() => comparisonFromHistory(history, weekOf, null), [history, weekOf])
  const prevCard = useMemo(
    () => (comparison ? (history.find((h) => h.weekOf === comparison.previousWeekOf) ?? null) : null),
    [history, comparison],
  )

  // Site AEO Score는 엔진과 무관하게 페이지를 읽어 낸 값이라, 전주 비교에 엔진 조건이 걸리지
  // 않는다. 그 주차보다 앞선 가장 최근 진단을 그대로 쓴다.
  const [siteScores, setSiteScores] = useState<Record<string, SiteScoreRecord>>({})
  useEffect(() => {
    const id = tenant?.tenantId
    if (!id) return
    let alive = true
    void loadSiteScores(id).then((v) => {
      if (alive) setSiteScores(v ?? {})
    })
    return () => {
      alive = false
    }
  }, [tenant?.tenantId])
  const siteNow = weekOf ? (siteScores[weekOf] ?? null) : null
  const sitePrev = useMemo(() => {
    const before = Object.keys(siteScores)
      .filter((w) => w < weekOf)
      .sort()
    return before.length ? (siteScores[before[before.length - 1]!] ?? null) : null
  }, [siteScores, weekOf])

  // 인용 건수는 스코어카드에 없다(비율만 있다). 그 주차 인용 분석에서 총계를 읽어 온다.
  const [citations, setCitations] = useState<{ key: string; now: number | null; prev: number | null }>({
    key: '',
    now: null,
    prev: null,
  })
  const citationKey = tenant ? `${tenant.tenantId}|${weekOf}|${comparison?.previousWeekOf ?? ''}` : ''
  useEffect(() => {
    const id = tenant?.tenantId
    if (!id || !weekOf) return
    let alive = true
    const key = `${id}|${weekOf}|${comparison?.previousWeekOf ?? ''}`
    void Promise.all([
      loadCitationSources(id, weekOf),
      comparison?.previousWeekOf ? loadCitationSources(id, comparison.previousWeekOf) : Promise.resolve(null),
    ]).then(([now, prev]) => {
      if (alive) setCitations({ key, now: now?.totalCitations ?? null, prev: prev?.totalCitations ?? null })
    })
    return () => {
      alive = false
    }
  }, [tenant?.tenantId, weekOf, comparison?.previousWeekOf])
  const cite = citations.key === citationKey ? citations : { key: '', now: null, prev: null }

  if (!tenant) return null

  return (
    <>
      <p className="brand">보고</p>
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

          {/*
            전주 대비는 **비교가 성립할 때만** 보여 준다. 수집 엔진이 달라진 주차끼리 빼면
            그 차이는 브랜드가 아니라 측정 방식이 만든 것이다 — 인용 갭 분석과 같은 판단
            (comparisonFromHistory)을 쓴다. Site 점수만 예외인데, 엔진과 무관하게 페이지를
            읽어 낸 값이라 그 조건이 걸리지 않는다.
          */}
          <section className="report-tiles">
            <article>
              <p className="tile-label">Brand AEO Score</p>
              <p className="tile-value">
                {card.aeoScore.current}
                <Delta
                  now={card.aeoScore.current}
                  prev={comparison?.comparable ? (prevCard?.aeoScore.current ?? null) : null}
                />
              </p>
              <p className="tile-note">답변에 얼마나 나오는가</p>
            </article>
            <article>
              <p className="tile-label">Site AEO Score</p>
              <p className="tile-value">
                {siteNow ? siteNow.score : <span className="muted">—</span>}
                {siteNow && <Delta now={siteNow.score} prev={sitePrev?.score ?? null} />}
              </p>
              <p className="tile-note">
                {siteNow
                  ? sitePrev
                    ? `페이지 준비도 · ${weekLabel(sitePrev.weekOf)} 대비`
                    : '페이지 준비도 · 첫 기록'
                  : 'Site AEO Checker에서 이 주차에 진단한 기록이 없습니다'}
              </p>
            </article>
            <article>
              <p className="tile-label">인용 건수</p>
              <p className="tile-value">
                {cite.now === null ? <span className="muted">—</span> : cite.now.toLocaleString()}
                {cite.now !== null && <Delta now={cite.now} prev={comparison?.comparable ? cite.prev : null} />}
              </p>
              <p className="tile-note">엔진이 근거로 끌어온 출처 수</p>
            </article>
          </section>
          {comparison && !comparison.comparable && (
            <p className="hint no-print">※ {comparison.reason} — 점수·인용의 전주 대비를 표시하지 않았습니다.</p>
          )}

          <section className={`report-verdict sev-${report.verdict.tone}`}>
            <p className="eyebrow">
              {card.brandName} · {weekLabel(card.weekOf)} · {card.industry} · {card.region}
            </p>
            {/*
              점수 칩을 뺐다. 바로 위 타일이 같은 숫자를 더 크게 보여 주고 있었고, 거기서는
              'Brand AEO Score'인데 여기서는 'AEO 43'이라 이름까지 갈렸다.
            */}
            <p className="verdict-head">
              종합 판정 <strong>{report.verdict.label}</strong>
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
