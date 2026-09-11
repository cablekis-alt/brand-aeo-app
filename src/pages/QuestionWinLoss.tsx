import { useEffect, useMemo, useState } from 'react'
import WeekPicker from '../components/WeekPicker'
import { useTenant } from '../context/useTenant'
import { loadQuestionAnalyses, loadQuestionBank } from '../lib/api'
import { computeQuestionWinLoss, type WinLossRow } from '../lib/questionWinLoss'
import type { QuestionRepeatAnalysis, QuestionSpec } from '../lib/types'
import { useWeeklyPage } from '../lib/useWeeklyPage'
import { resolveBankVersion } from '../lib/bankVersion'

const VERDICT: Record<WinLossRow['verdict'], { label: string; cls: string }> = {
  win: { label: '승', cls: 'st-good' },
  even: { label: '무', cls: 'st-warn' },
  loss: { label: '패', cls: 'st-bad' },
  unanswered: { label: '무응답', cls: 'st-info' },
}
const pct = (n: number) => `${Math.round(n * 100)}%`

export default function QuestionWinLoss() {
  const { tenant } = useTenant()
  const { history, weeks, weekOf, setWeekOf, data: analyses, loading } = useWeeklyPage<QuestionRepeatAnalysis[]>(
    loadQuestionAnalyses,
    tenant?.tenantId ?? '',
    [],
  )

  // 이 주차를 측정한 은행 버전으로 불러온다 — 현재 버전으로 부르면 옛 주차의 질문 id가
  // 맞지 않아 텍스트·카테고리가 빈 값이 된다(화면에 v1-001 같은 id가 뜬다).
  const bankVersion = resolveBankVersion(history, weekOf, analyses)
  const [questions, setQuestions] = useState<QuestionSpec[]>([])
  useEffect(() => {
    if (!tenant?.tenantId) return
    let alive = true
    void loadQuestionBank(tenant.tenantId, bankVersion).then((bank) => {
      if (alive) setQuestions(bank?.questions ?? [])
    })
    return () => {
      alive = false
    }
  }, [tenant?.tenantId, bankVersion])

  const rows = useMemo(() => computeQuestionWinLoss(analyses, questions), [analyses, questions])
  const tally = useMemo(() => {
    const t = { win: 0, even: 0, loss: 0, unanswered: 0 }
    for (const r of rows) t[r.verdict] += 1
    return t
  }, [rows])

  if (!tenant) return null

  return (
    <>
      <p className="brand">STAGE 3</p>
      <h1>질문별 승패</h1>
      <p className="lead">
        이번 주 응답(질문 × 엔진 × 반복)에서 <b>질문마다</b> 브랜드가 언급됐는지, 경쟁사에 밀리는지를 봅니다. 개선이 필요한
        질문(<b>패</b>)이 위로 정렬됩니다 — 그 질문의 콘텐츠를 보강하면 가시성이 오릅니다.
      </p>

      <div className="filters">
        <WeekPicker weeks={weeks} value={weekOf} onChange={setWeekOf} />
      </div>

      {loading && <p className="muted">불러오는 중…</p>}
      {!loading && rows.length === 0 && <p className="muted">이 주차에 저장된 판정 데이터가 없습니다.</p>}

      {!loading && rows.length > 0 && (
        <>
          <div className="winloss-tally">
            <span className="status-pill st-good">승 {tally.win}</span>
            <span className="status-pill st-warn">무 {tally.even}</span>
            <span className="status-pill st-bad">패 {tally.loss}</span>
            {tally.unanswered > 0 && (
              <span className="status-pill st-info">무응답 {tally.unanswered}</span>
            )}
            <span className="muted"> · 총 {rows.length}개 질문</span>
          </div>

          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead>
                <tr>
                  <th>승패</th>
                  <th>질문</th>
                  <th className="num">언급률</th>
                  <th className="num">브랜드/최다 경쟁사</th>
                  <th className="num">평균 순위</th>
                  <th>감성(긍·중·부)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.questionId}>
                    <td>
                      <span className={`status-pill ${VERDICT[r.verdict].cls}`}>{VERDICT[r.verdict].label}</span>
                    </td>
                    <td style={{ maxWidth: 380 }}>
                      {r.text}
                      <span className="sentence-meta" style={{ display: 'block' }}>
                        {r.questionId} · 응답 {r.responses}건
                      </span>
                    </td>
                    <td className="num">
                      {r.answered > 0 ? pct(r.mentionedRate) : '—'}
                      {r.clarifying > 0 && (
                        <span className="sentence-meta" style={{ display: 'block' }}>
                          되물음 {r.clarifying}/{r.responses}
                        </span>
                      )}
                    </td>
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>
                      {r.brandMentions}
                      {r.topCompetitor ? ` / ${r.topCompetitor.mentions} (${r.topCompetitor.name})` : ' / -'}
                    </td>
                    <td className="num">{r.avgRank !== null ? r.avgRank.toFixed(1) : '-'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <span className="sentiment positive">{r.sentiment.pos}</span>{' '}
                      <span className="sentiment neutral">{r.sentiment.neu}</span>{' '}
                      <span className="sentiment negative">{r.sentiment.neg}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint" style={{ marginTop: 10 }}>
            <b>승</b> = 브랜드가 과반 응답에서 언급되고 경쟁사보다 우위 · <b>무</b> = 언급되나 경쟁사와 대등/약함 ·{' '}
            <b>패</b> = 미언급이거나 경쟁사가 더 많이 언급 · <b>무응답</b> = 엔진이 답 대신 되물어(예: "어느
            지역을 찾으시나요?") 언급될 기회가 없었음 — 질문을 더 구체적으로 바꾸면 해소됩니다. 되물은 응답은
            언급률 분모에서 제외합니다. "브랜드/최다 경쟁사"는 언급 문장 수 비교입니다.
          </p>
        </>
      )}
    </>
  )
}
