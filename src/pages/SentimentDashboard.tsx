import { useEffect, useMemo, useState } from 'react'
import WeekPicker from '../components/WeekPicker'
import { useTenant } from '../context/useTenant'
import { loadQuestionAnalyses, loadQuestionBank } from '../lib/api'
import { ENGINE_LABEL } from '../lib/format'
import {
  computeSentiment,
  negRate,
  posRate,
  type SentimentCounts,
} from '../lib/sentiment'
import type { QuestionRepeatAnalysis, QuestionSpec } from '../lib/types'
import { useWeeklyPage } from '../lib/useWeeklyPage'

const pct = (n: number) => `${Math.round(n * 100)}%`

function StackedBar({ c }: { c: SentimentCounts }) {
  if (c.total === 0) return <span className="muted">데이터 없음</span>
  return (
    <span className="senti-bar" role="img" aria-label={`긍정 ${c.pos} 중립 ${c.neu} 부정 ${c.neg}`}>
      {c.pos > 0 && <span className="seg pos" style={{ width: `${(c.pos / c.total) * 100}%` }} />}
      {c.neu > 0 && <span className="seg neu" style={{ width: `${(c.neu / c.total) * 100}%` }} />}
      {c.neg > 0 && <span className="seg neg" style={{ width: `${(c.neg / c.total) * 100}%` }} />}
    </span>
  )
}

export default function SentimentDashboard() {
  const { tenant } = useTenant()
  const { weeks, weekOf, setWeekOf, data: analyses, loading } = useWeeklyPage<QuestionRepeatAnalysis[]>(
    loadQuestionAnalyses,
    tenant?.tenantId ?? '',
    [],
  )

  const [questions, setQuestions] = useState<QuestionSpec[]>([])
  useEffect(() => {
    if (!tenant?.tenantId) return
    let alive = true
    void loadQuestionBank(tenant.tenantId).then((bank) => {
      if (alive) setQuestions(bank?.questions ?? [])
    })
    return () => {
      alive = false
    }
  }, [tenant?.tenantId])

  const s = useMemo(() => computeSentiment(analyses, questions), [analyses, questions])

  if (!tenant) return null
  const hasData = s.overall.total > 0

  return (
    <>
      <p className="brand">상세 분석</p>
      <h1>감성 분석</h1>
      <p className="lead">
        AI 답변이 이 브랜드를 <b>어떤 어조</b>로 말하는지 봅니다 — 언급 문장의 긍정·중립·부정 분포와 엔진·질문별 편차,
        그리고 부정 문장을 직접 확인합니다.
      </p>

      <div className="filters">
        <WeekPicker weeks={weeks} value={weekOf} onChange={setWeekOf} />
      </div>

      {loading && <p className="muted">불러오는 중…</p>}
      {!loading && !hasData && <p className="muted">이 주차에 브랜드 언급 문장이 없습니다.</p>}

      {!loading && hasData && (
        <>
          <section className="metrics">
            <article>
              <h2>긍정</h2>
              <p className="sentiment positive">{pct(posRate(s.overall))}</p>
              <span>{s.overall.pos}개 문장</span>
            </article>
            <article>
              <h2>중립</h2>
              <p className="sentiment neutral">{pct(s.overall.neu / s.overall.total)}</p>
              <span>{s.overall.neu}개 문장</span>
            </article>
            <article>
              <h2>부정</h2>
              <p className="sentiment negative">{pct(negRate(s.overall))}</p>
              <span>{s.overall.neg}개 문장</span>
            </article>
            <article>
              <h2>전체 언급 문장</h2>
              <p>{s.overall.total}</p>
              <span>이 주차 · 질문 × 엔진 × 반복</span>
            </article>
          </section>

          <section>
            <h3>엔진별 어조</h3>
            <ul className="senti-list">
              {s.byEngine.map((e) => (
                <li key={e.engine}>
                  <span className="senti-name">{ENGINE_LABEL[e.engine] ?? e.engine}</span>
                  <StackedBar c={e} />
                  <span className="senti-value">
                    부정 {pct(negRate(e))} · {e.total}건
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3>질문별 어조 (부정 높은 순)</h3>
            <ul className="senti-list">
              {s.byQuestion.slice(0, 12).map((q) => (
                <li key={q.questionId}>
                  <span className="senti-name" title={q.text} style={{ maxWidth: 320 }}>
                    {q.text}
                  </span>
                  <StackedBar c={q} />
                  <span className="senti-value">
                    부정 {pct(negRate(q))} · {q.total}건
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className={s.negatives.length > 0 ? 'panel warn' : undefined}>
            <h3>부정 언급 문장 ({s.negatives.length}건)</h3>
            {s.negatives.length === 0 ? (
              <p className="muted">이 주차에 부정으로 판정된 언급 문장이 없습니다.</p>
            ) : (
              <ul className="neg-list">
                {s.negatives.map((n, i) => (
                  <li key={i}>
                    <span className="sentence-meta">
                      {ENGINE_LABEL[n.engine] ?? n.engine} · {n.questionId} — {n.text}
                    </span>
                    <span className="neg-sentence">“{n.sentence}”</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </>
  )
}
