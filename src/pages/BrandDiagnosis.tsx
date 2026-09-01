import { useEffect, useMemo, useState } from 'react'
import WeekPicker from '../components/WeekPicker'
import { useTenant } from '../context/useTenant'
import { loadQuestionAnalyses } from '../lib/api'
import { ENGINE_LABEL } from '../lib/format'
import { useScorecards } from '../lib/useScorecards'
import { useWeekSelection } from '../lib/useWeekSelection'
import { useWeeklyData } from '../lib/useWeeklyData'
import type { Engine } from '../prompts/types'

const SENTIMENT_LABEL: Record<string, string> = { positive: '긍정', neutral: '중립', negative: '부정' }

export default function BrandDiagnosis() {
  const { tenant } = useTenant()
  const { history } = useScorecards(tenant?.tenantId ?? '')
  const [weekOf, setWeekOf] = useWeekSelection(history)
  const { data: analyses, loading } = useWeeklyData(loadQuestionAnalyses, tenant?.tenantId ?? '', weekOf, [])

  const [engineFilter, setEngineFilter] = useState<Engine[]>([])
  useEffect(() => {
    if (tenant) setEngineFilter(tenant.engines)
  }, [tenant])

  const filtered = useMemo(() => analyses.filter((a) => engineFilter.includes(a.engine)), [analyses, engineFilter])

  const competitorTotals = useMemo(() => {
    const totals = new Map<string, number>()
    for (const analysis of filtered) {
      for (const competitor of analysis.competitorMentions) {
        totals.set(competitor.name, (totals.get(competitor.name) ?? 0) + competitor.mentionCount)
      }
    }
    return [...totals.entries()].sort((a, b) => b[1] - a[1])
  }, [filtered])

  const violations = useMemo(
    () => filtered.flatMap((a) => a.factualityClaims.filter((c) => c.verdict === 'contradicted').map((claim) => ({ analysis: a, claim }))),
    [filtered],
  )

  function toggleEngine(engine: Engine) {
    setEngineFilter((current) => (current.includes(engine) ? current.filter((e) => e !== engine) : [...current, engine]))
  }

  if (!tenant) return null

  return (
    <>
      <p className="brand">S-02 · 브랜드 진단 및 분석</p>
      <h1>브랜드 종합 진단</h1>
      <p className="lead">이번 주 응답(질문 × 엔진 × 반복 3회) 중 브랜드가 실제로 어떻게 언급됐는지 문장 단위로 봅니다.</p>

      <div className="filters">
        <WeekPicker weeks={history.map((h) => h.weekOf)} value={weekOf} onChange={setWeekOf} />
        <fieldset className="engine-filter">
          <legend>엔진</legend>
          {tenant.engines.map((engine) => (
            <label key={engine}>
              <input type="checkbox" checked={engineFilter.includes(engine)} onChange={() => toggleEngine(engine)} />
              {ENGINE_LABEL[engine] ?? engine}
            </label>
          ))}
        </fieldset>
      </div>

      {loading && <p className="muted">불러오는 중…</p>}
      {!loading && analyses.length === 0 && <p className="muted">이 주차에 저장된 판정 데이터가 없습니다.</p>}

      {!loading && analyses.length > 0 && (
        <>
          <section>
            <h3>브랜드 언급 문장 ({filtered.filter((a) => a.mentioned).length}건)</h3>
            <ul className="sentence-list">
              {filtered
                .filter((a) => a.mentioned)
                .flatMap((a) =>
                  a.mentionSentences.map((m, i) => (
                    <li key={`${a.engine}-${a.questionId}-${a.callIndex}-${i}`}>
                      <span className={`sentiment ${m.sentiment}`}>{SENTIMENT_LABEL[m.sentiment]}</span>
                      <span className="sentence-text">{m.sentence}</span>
                      <span className="sentence-meta">
                        {ENGINE_LABEL[a.engine] ?? a.engine} · {a.questionId} · {a.callIndex}회차
                      </span>
                    </li>
                  )),
                )}
            </ul>
          </section>

          <section>
            <h3>경쟁사 언급 비교</h3>
            {competitorTotals.length === 0 ? (
              <p className="muted">이 주차에는 경쟁사 언급이 없습니다.</p>
            ) : (
              <ul className="weights">
                {competitorTotals.map(([name, count]) => (
                  <li key={name}>
                    <strong>{count}</strong>
                    {name}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {violations.length > 0 && (
            <section className="panel warn">
              <h3>Fact Graph 위반 ({violations.length}건)</h3>
              <ul>
                {violations.map(({ analysis, claim }, i) => (
                  <li key={i}>
                    <strong>{claim.claimText}</strong> — 응답: {claim.responseValue ?? '알 수 없음'}, 실제:{' '}
                    {claim.factGraphValue ?? '알 수 없음'} ({ENGINE_LABEL[analysis.engine] ?? analysis.engine} ·{' '}
                    {analysis.questionId})
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </>
  )
}
