import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import WeekPicker from '../components/WeekPicker'
import { useTenant } from '../context/useTenant'
import { loadCitationSources, loadEeat, loadSiteScores, type SiteScoreRecord } from '../lib/api'
import { comparisonFromHistory } from '../lib/citationView'
import { isoWeekMonth, monthLabel } from '../prompts/isoWeek'
import { ENGINE_LABEL, weekLabel } from '../lib/format'
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

  /*
   * 주간 / 월간.
   *
   * 한 주는 변동이 크다(신뢰구간이 넓은 이유가 그것이다). 고객에게 보내는 문서라면 달 단위가
   * 더 맞을 때가 많아 두 보기를 둔다.
   *
   * 주차를 달에 묶는 기준은 **그 주의 목요일이 든 달**이다(isoWeekMonth). 한 주가 두 달에
   * 걸칠 때 규칙 없이 나누지 않기 위해서이고, ISO가 주의 연도를 정하는 방식과 같다.
   *
   * 중요한 제약: 종합 판정·지표별 진단·개선제안은 **한 주차 스코어카드에서** 나온다.
   * 지표를 평균 내 다시 판정하면 실제로 측정한 적 없는 주를 판정하는 셈이 된다. 그래서
   * 월간에서도 판정은 그 달 마지막 주차를 쓰고, 화면이 그렇다고 밝힌다. 타일만 달 단위로
   * 모은다(평균·합계는 측정값을 모으는 것이지 새로 만드는 것이 아니다).
   */
  const [period, setPeriod] = useState<'week' | 'month'>('week')
  const months = useMemo(() => {
    const set = new Set<string>()
    for (const h of history) {
      const m = isoWeekMonth(h.weekOf)
      if (m) set.add(m)
    }
    return [...set].sort()
  }, [history])
  const [monthKey, setMonthKey] = useState('')
  const activeMonth = monthKey && months.includes(monthKey) ? monthKey : (months.at(-1) ?? '')
  const weeksInMonth = useMemo(
    () => history.filter((h) => isoWeekMonth(h.weekOf) === activeMonth),
    [history, activeMonth],
  )
  const prevMonth = useMemo(() => {
    const i = months.indexOf(activeMonth)
    return i > 0 ? months[i - 1]! : ''
  }, [months, activeMonth])
  const weeksInPrevMonth = useMemo(
    () => (prevMonth ? history.filter((h) => isoWeekMonth(h.weekOf) === prevMonth) : []),
    [history, prevMonth],
  )

  /** 판정이 근거로 쓰는 주차 — 월간에서는 그 달의 마지막 주차. */
  const judgedWeek = period === 'month' ? (weeksInMonth.at(-1)?.weekOf ?? weekOf) : weekOf

  const { data: eeat } = useWeeklyData(loadEeat, tenant?.tenantId ?? '', judgedWeek, EMPTY_EEAT)

  const card = useMemo(
    () => history.find((h) => h.weekOf === judgedWeek) ?? history.at(-1) ?? null,
    [history, judgedWeek],
  )
  const report = useMemo(
    () => (history.length ? buildPeriodicReport(history, judgedWeek || (history.at(-1)?.weekOf ?? ''), eeat) : null),
    [history, judgedWeek, eeat],
  )
  const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null)

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

  /*
   * 인용 건수는 스코어카드에 없다(비율만 있다). 그 주차 인용 분석에서 총계를 읽어 온다.
   * 월간이면 그 달 주차들의 **합계**다 — 인용은 건수라 더하는 것이 자연스럽고, 평균을 내면
   * "한 주에 몇 건이었나"가 되어 달 단위 활동량을 말해 주지 못한다.
   */
  // 목록을 memo로 잡아 effect 의존성에 그대로 넣는다 — 렌더마다 새 배열이면 effect가 끝없이 돈다.
  const nowWeeks = useMemo(
    () => (period === 'month' ? weeksInMonth.map((h) => h.weekOf) : weekOf ? [weekOf] : []),
    [period, weeksInMonth, weekOf],
  )
  const prevWeeks = useMemo(
    () =>
      period === 'month'
        ? weeksInPrevMonth.map((h) => h.weekOf)
        : comparison?.previousWeekOf
          ? [comparison.previousWeekOf]
          : [],
    [period, weeksInPrevMonth, comparison],
  )
  const [citations, setCitations] = useState<{ key: string; now: number | null; prev: number | null }>({
    key: '',
    now: null,
    prev: null,
  })
  const citationKey = tenant ? `${tenant.tenantId}|${nowWeeks.join(',')}|${prevWeeks.join(',')}` : ''
  useEffect(() => {
    const id = tenant?.tenantId
    if (!id || nowWeeks.length === 0) return
    let alive = true
    const key = `${id}|${nowWeeks.join(',')}|${prevWeeks.join(',')}`
    const sum = async (weeks: string[]) => {
      if (weeks.length === 0) return null
      const rows = await Promise.all(weeks.map((w) => loadCitationSources(id, w)))
      // 한 주라도 읽지 못하면 합계를 만들지 않는다 — 빠진 주를 0으로 치면 달이 작아 보인다.
      if (rows.some((r) => r === null)) return null
      return rows.reduce((a, r) => a + (r?.totalCitations ?? 0), 0)
    }
    void Promise.all([sum(nowWeeks), sum(prevWeeks)]).then(([now, prev]) => {
      if (alive) setCitations({ key, now, prev })
    })
    return () => {
      alive = false
    }
  }, [tenant?.tenantId, citationKey, nowWeeks, prevWeeks])
  const cite = citations.key === citationKey ? citations : { key: '', now: null, prev: null }

  /*
   * 월간 타일 값.
   *
   * Brand 점수는 **평균**이다 — 한 주는 변동이 커서 마지막 주만 보면 그 달을 대표하지 못한다.
   * Site 점수는 평균을 내지 않는다. 그 시점 페이지 상태를 잰 값이라 평균이 뜻을 갖지 않는다 —
   * 그 달의 **마지막 진단**을 쓴다.
   */
  const monthBrand = mean(weeksInMonth.map((h) => h.aeoScore.current))
  const prevMonthBrand = mean(weeksInPrevMonth.map((h) => h.aeoScore.current))
  const monthSite = useMemo(() => {
    const inMonth = Object.keys(siteScores)
      .filter((w) => isoWeekMonth(w) === activeMonth)
      .sort()
    return inMonth.length ? (siteScores[inMonth[inMonth.length - 1]!] ?? null) : null
  }, [siteScores, activeMonth])
  const prevMonthSite = useMemo(() => {
    const inMonth = Object.keys(siteScores)
      .filter((w) => isoWeekMonth(w) === prevMonth)
      .sort()
    return inMonth.length ? (siteScores[inMonth[inMonth.length - 1]!] ?? null) : null
  }, [siteScores, prevMonth])

  /** 그 달 안에서 수집 엔진이 갈렸는지 — 갈렸으면 평균을 한 값처럼 읽으면 안 된다. */
  const monthEngineSets = useMemo(
    () => [...new Set(weeksInMonth.map((h) => [...(h.enginesUsed ?? [])].sort().join('+')).filter(Boolean))],
    [weeksInMonth],
  )

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
            <div className="axis-tabs" role="tablist" aria-label="보고 기간">
              {(['week', 'month'] as const).map((k) => (
                <button
                  type="button"
                  key={k}
                  role="tab"
                  aria-selected={period === k}
                  className={`axis-tab${period === k ? ' is-on' : ''}`}
                  onClick={() => setPeriod(k)}
                >
                  {k === 'week' ? '주간' : '월간'}
                </button>
              ))}
            </div>
            {period === 'week' ? (
              <WeekPicker weeks={history.map((h) => h.weekOf)} value={weekOf} onChange={setWeekOf} />
            ) : (
              <label className="field">
                <span>월</span>
                <select value={activeMonth} onChange={(e) => setMonthKey(e.target.value)}>
                  {months.map((m) => (
                    <option key={m} value={m}>
                      {monthLabel(m)}
                    </option>
                  ))}
                </select>
              </label>
            )}
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
              <p className="tile-label">Brand AEO Score{period === 'month' && ' 월 평균'}</p>
              <p className="tile-value">
                {period === 'month' ? (
                  monthBrand === null ? (
                    <span className="muted">—</span>
                  ) : (
                    <>
                      {monthBrand}
                      <Delta now={monthBrand} prev={prevMonthBrand} />
                    </>
                  )
                ) : (
                  <>
                    {card.aeoScore.current}
                    <Delta
                      now={card.aeoScore.current}
                      prev={comparison?.comparable ? (prevCard?.aeoScore.current ?? null) : null}
                    />
                  </>
                )}
              </p>
              <p className="tile-note">
                {period === 'month'
                  ? `답변에 얼마나 나오는가 · ${weeksInMonth.length}주 평균${prevMonth ? ` · ${monthLabel(prevMonth)} 대비` : ''}`
                  : '답변에 얼마나 나오는가'}
              </p>
            </article>
            <article>
              <p className="tile-label">Site AEO Score</p>
              {(() => {
                const now = period === 'month' ? monthSite : siteNow
                const prev = period === 'month' ? prevMonthSite : sitePrev
                return (
                  <>
                    <p className="tile-value">
                      {now ? now.score : <span className="muted">—</span>}
                      {now && <Delta now={now.score} prev={prev?.score ?? null} />}
                    </p>
                    <p className="tile-note">
                      {now
                        ? prev
                          ? `페이지 준비도 · ${weekLabel(now.weekOf)} 진단 · ${weekLabel(prev.weekOf)} 대비`
                          : `페이지 준비도 · ${weekLabel(now.weekOf)} 진단 · 첫 기록`
                        : period === 'month'
                          ? '이 달에 사이트 진단 기록이 없습니다'
                          : 'Site AEO Checker에서 이 주차에 진단한 기록이 없습니다'}
                    </p>
                  </>
                )
              })()}
            </article>
            <article>
              <p className="tile-label">인용 건수{period === 'month' && ' 합계'}</p>
              <p className="tile-value">
                {cite.now === null ? <span className="muted">—</span> : cite.now.toLocaleString()}
                {cite.now !== null && (
                  <Delta now={cite.now} prev={period === 'month' ? cite.prev : comparison?.comparable ? cite.prev : null} />
                )}
              </p>
              <p className="tile-note">
                엔진이 근거로 끌어온 출처 수{period === 'month' && ` · ${weeksInMonth.length}주 합계`}
              </p>
            </article>
          </section>
          {period === 'week' && comparison && !comparison.comparable && (
            <p className="hint no-print">※ {comparison.reason} — 점수·인용의 전주 대비를 표시하지 않았습니다.</p>
          )}

          {period === 'month' && (
            <section className="month-context">
              <p className="eyebrow">{monthLabel(activeMonth)} · 주차 {weeksInMonth.length}개</p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>주차</th>
                      <th>Brand AEO Score</th>
                      <th>카테고리 무관 언급률</th>
                      <th>수집 엔진</th>
                    </tr>
                  </thead>
                  <tbody>
                    {weeksInMonth.map((h) => (
                      <tr key={h.weekOf} className={h.weekOf === judgedWeek ? 'self' : undefined}>
                        <td>{weekLabel(h.weekOf)}</td>
                        <td>{h.aeoScore.current}</td>
                        <td>{(h.mentionRate * 100).toFixed(1)}%</td>
                        <td className="muted">
                          {(h.enginesUsed ?? []).map((e) => ENGINE_LABEL[e] ?? e).join(' · ') || '기록 없음'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/*
                평균을 한 값처럼 읽으면 안 되는 경우를 밝힌다. 그 달 안에서 수집 엔진이 갈렸으면
                주차별 점수가 같은 조건에서 나온 값이 아니다.
              */}
              {monthEngineSets.length > 1 && (
                <p className="hint">
                  ※ 이 달 안에서 수집 엔진이 달랐습니다 — 주차별 점수가 같은 조건에서 나온 값이 아니므로 평균을
                  하나의 수치처럼 읽지 마세요.
                </p>
              )}
              <p className="hint">
                아래 <b>종합 판정 · 지표별 진단 · 개선제안</b>은 이 달의 마지막 주차(
                {weekLabel(judgedWeek)}) 스코어카드에서 나옵니다. 지표를 평균 내 다시 판정하면 실제로 측정한 적 없는
                주를 판정하게 되므로 그렇게 하지 않습니다.
              </p>
            </section>
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
