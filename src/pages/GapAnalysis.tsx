import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import WeekPicker from '../components/WeekPicker'
import { useTenant } from '../context/useTenant'
import { loadQuestionAnalyses, loadQuestionBank } from '../lib/api'
import { computeGapAnalysis, type GapGroup, type GapVerdict } from '../lib/gapAnalysis'
import { ENGINE_LABEL } from '../lib/format'
import type { QuestionRepeatAnalysis, QuestionSpec } from '../lib/types'
import { useWeeklyPage } from '../lib/useWeeklyPage'
import { resolveBankVersion } from '../lib/bankVersion'

const VERDICT: Record<GapVerdict, { label: string; cls: string }> = {
  gap: { label: '격차', cls: 'st-bad' },
  mixed: { label: '혼재', cls: 'st-warn' },
  strength: { label: '강점', cls: 'st-good' },
}
const pct = (n: number) => `${Math.round(n * 100)}%`

/** 묶음 하나를 카드로. 카테고리·엔진이 같은 모양을 쓴다. */
function GroupCard({ group, nameOf }: { group: GapGroup; nameOf?: (key: string) => string }) {
  const v = VERDICT[group.verdict]
  return (
    <article className="gap-card">
      <div className="gap-card-head">
        <span className="gap-name">{nameOf ? nameOf(group.key) : group.label}</span>
        <span className={`status-pill ${v.cls}`}>{v.label}</span>
        <span className="gap-rate">
          언급률 <b>{pct(group.mentionRate)}</b>
        </span>
      </div>
      <div className="gap-bar" aria-hidden="true">
        {group.win > 0 && <i className="w" style={{ flexGrow: group.win }} />}
        {group.even > 0 && <i className="e" style={{ flexGrow: group.even }} />}
        {group.loss > 0 && <i className="l" style={{ flexGrow: group.loss }} />}
        {group.unanswered > 0 && <i className="u" style={{ flexGrow: group.unanswered }} />}
      </div>
      <p className="gap-tally">
        질문 {group.questions}개 · 승 {group.win} · 무 {group.even} · 패 {group.loss}
        {group.unanswered > 0 && ` · 무응답 ${group.unanswered}`}
      </p>
      {group.worst.length > 0 && (
        <ul className="gap-worst">
          {group.worst.map((r) => (
            <li key={r.questionId}>
              <span className="gap-q">{r.text}</span>
              {r.topCompetitor && (
                <span className="gap-who">
                  {r.topCompetitor.name}에 밀림 ({r.topCompetitor.mentions}회)
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </article>
  )
}

export default function GapAnalysis() {
  const { tenant } = useTenant()
  const {
    history,
    weeks,
    weekOf,
    setWeekOf,
    data: analyses,
    loading,
    neverMeasured,
  } = useWeeklyPage<QuestionRepeatAnalysis[]>(loadQuestionAnalyses, tenant?.tenantId ?? '', [])

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

  const gap = useMemo(() => computeGapAnalysis(analyses, questions), [analyses, questions])
  const worstCategory = gap.byCategory.find((g) => g.verdict === 'gap') ?? null
  // 엔진이 하나뿐이면 엔진 격차를 말할 수 없다 — "엔진마다 다르다"는 비교 대상이 있을 때만 참이다.
  const worstEngine = gap.byEngine.length > 1 ? (gap.byEngine.find((g) => g.verdict === 'gap') ?? null) : null
  const topCompetitor = gap.competitors[0] ?? null
  // 표가 비는 이유는 둘이고 뜻이 정반대다. 밀린 질문이 아예 없으면 좋은 소식이고,
  // 밀렸는데 경쟁사가 안 잡혔다면 그 자리를 아무도 못 가져간 것이다(= 선점 여지).
  const lossQuestions = gap.byCategory.reduce((sum, g) => sum + g.loss, 0)
  const ready = !loading && gap.totalQuestions > 0

  if (!tenant) return null

  return (
    <>
      <p className="brand">어디가 비어 있나</p>
      <h1>가시성 격차 분석</h1>
      <p className="lead">
        어떤 <b>유형의 질문</b>에서, 어떤 <b>엔진</b>에서, <b>누구에게</b> 밀리는지를 봅니다.
        질문 하나하나의 승패는 <Link to="/question-winloss">질문별 승패</Link>에서 보세요 — 여기는 그 위층입니다.
        어떤 <b>출처</b>가 우리를 인용하지 않는지는 <Link to="/citation-gap">인용 갭 분석</Link>이 따로 다룹니다.
        여기서 나온 격차를 할 일로 바꾼 것이 <Link to="/gap-actions">실행 항목</Link>입니다.
      </p>

      <div className="filters">
        <WeekPicker weeks={weeks} value={weekOf} onChange={setWeekOf} />
      </div>

      {loading && <p className="muted">불러오는 중…</p>}

      {!loading && gap.totalQuestions === 0 && (
        <p className="muted">
          {neverMeasured
            ? '이 브랜드는 아직 측정된 적이 없습니다. '
            : '이 주차에 분석 데이터가 없습니다. '}
          <Link to="/measure-tenant">브랜드·경쟁사 측정</Link>에서 측정하면 격차가 채워집니다.
        </p>
      )}

      {ready && (
        <>
          <section className="hero-card">
            <p className="eyebrow">가장 큰 격차</p>
            {worstCategory || worstEngine || topCompetitor ? (
              <ul className="gap-summary">
                {worstCategory && (
                  <li>
                    <b>{worstCategory.label}</b> 질문에서 언급률 {pct(worstCategory.mentionRate)} —
                    {' '}{worstCategory.questions}개 중 {worstCategory.loss}개에서 밀립니다.
                  </li>
                )}
                {worstEngine && (
                  <li>
                    <b>{ENGINE_LABEL[worstEngine.key] ?? worstEngine.key}</b>에서 언급률{' '}
                    {pct(worstEngine.mentionRate)} — 엔진마다 결과가 다릅니다.
                  </li>
                )}
                {topCompetitor && (
                  <li>
                    <b>{topCompetitor.name}</b>이(가) 질문 {topCompetitor.questionsLost}개에서 우리 자리를
                    가져갔습니다.
                  </li>
                )}
              </ul>
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                격차로 판정된 묶음이 없습니다 — 이번 주차는 모든 유형·엔진에서 밀리지 않았습니다.
              </p>
            )}
          </section>

          <section>
            <h3>질문 유형별</h3>
            <p className="hint" style={{ marginTop: 0 }}>
              언급률·Share of Mention은 <b>카테고리 무관</b> 질문에서 나옵니다. 브랜드명을 넣은 질문은
              거의 항상 언급되므로 그 줄이 높은 것은 성과가 아닙니다.
            </p>
            <div className="gap-grid">
              {gap.byCategory.map((g) => (
                <GroupCard key={g.key} group={g} />
              ))}
            </div>
          </section>

          {gap.byEngine.length > 1 ? (
            <section>
              <h3>엔진별</h3>
              <p className="hint" style={{ marginTop: 0 }}>
                같은 질문이라도 엔진마다 답이 다릅니다. 한 엔진에서만 빠져 있다면 그 엔진이 참고하는
                출처를 보강하는 것이 빠릅니다.
              </p>
              <div className="gap-grid">
                {gap.byEngine.map((g) => (
                  <GroupCard key={g.key} group={g} nameOf={(k) => ENGINE_LABEL[k] ?? k} />
                ))}
              </div>
            </section>
          ) : (
            <section>
              <h3>엔진별</h3>
              <p className="muted" style={{ marginTop: 0 }}>
                이 주차는 <b>{ENGINE_LABEL[gap.byEngine[0]?.key] ?? gap.byEngine[0]?.key ?? '엔진 1개'}</b>
                로만 측정해 엔진 간 비교가 없습니다. 설정에서 수집 엔진을 늘리면 이 자리가 채워집니다.
              </p>
            </section>
          )}

          <section>
            <h3>우리 자리를 가져간 경쟁사</h3>
            <p className="hint" style={{ marginTop: 0 }}>
              전체 언급량이 아니라 <b>우리가 밀린 질문에서 앞선 횟수</b>입니다. 그 질문들이 곧 보강할
              주제입니다.
            </p>
            {gap.competitors.length === 0 ? (
              <p className="muted">
                {lossQuestions === 0
                  ? '밀린 질문이 없습니다 — 이번 주차는 어떤 질문에서도 경쟁사에 뒤지지 않았습니다.'
                  : `밀린 질문 ${lossQuestions}개에서 추적 중인 경쟁사가 한 곳도 언급되지 않았습니다 — 우리가 진 게 아니라 그 자리를 아직 아무도 가져가지 않았습니다. 먼저 등재되면 선점할 수 있는 질문들입니다.`}
              </p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>경쟁사</th>
                      <th style={{ textAlign: 'right' }}>가져간 질문</th>
                      <th style={{ textAlign: 'right' }}>언급 문장</th>
                      <th>예시 질문</th>
                    </tr>
                  </thead>
                  <tbody>
                    {gap.competitors.map((c) => (
                      <tr key={c.name}>
                        <td>{c.name}</td>
                        <td style={{ textAlign: 'right' }}>{c.questionsLost}</td>
                        <td style={{ textAlign: 'right' }}>{c.mentions}</td>
                        <td className="muted">{c.examples.join(' · ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </>
  )
}
