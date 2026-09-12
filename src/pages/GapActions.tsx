import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import WeekPicker from '../components/WeekPicker'
import { useTenant } from '../context/useTenant'
import { loadCitationSources, loadQuestionAnalyses, loadQuestionBank } from '../lib/api'
import { resolveBankVersion } from '../lib/bankVersion'
import { computeGapActions, type GapAction } from '../lib/gapActions'
import type { QuestionRepeatAnalysis, QuestionSpec } from '../lib/types'
import { useWeeklyPage } from '../lib/useWeeklyPage'
import type { CitationSourceAnalysis } from '../prompts/b7-citation-sources'

const KIND_LABEL: Record<GapAction['kind'], { text: string; cls: string }> = {
  listing: { text: '외부 등재', cls: 'st-warn' },
  content: { text: '콘텐츠', cls: 'st-info' },
}

/** 항목 하나. 근거와 완료 조건을 항상 함께 보여준다 — 지시만 있고 근거가 없으면 안 하게 된다. */
function ActionCard({ action }: { action: GapAction }) {
  const kind = KIND_LABEL[action.kind]
  return (
    <article className="gap-card">
      <div className="gap-card-head">
        <span className="gap-name">{action.title}</span>
        <span className={`status-pill ${action.satisfied ? 'st-good' : kind.cls}`}>
          {action.satisfied ? '충족' : kind.text}
        </span>
        <span className="gap-rate">
          영향 <b>{action.reach}</b>
        </span>
      </div>
      <p className="gap-tally" style={{ color: 'var(--ink)' }}>
        {action.evidence}
      </p>
      {action.questionTexts.length > 0 && (
        <ul className="gap-worst">
          {action.questionTexts.map((q) => (
            <li key={q}>
              <span className="gap-q">{q}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="gap-tally">완료 조건 · {action.doneSignal}</p>
    </article>
  )
}

export default function GapActions() {
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

  // 격차 분석과 같은 규칙으로 은행 버전을 맞춘다 — 옛 주차를 현재 은행으로 부르면
  // 질문 id가 어긋나 텍스트·카테고리가 빈 값이 된다.
  const bankVersion = resolveBankVersion(history, weekOf, analyses)
  const [questions, setQuestions] = useState<QuestionSpec[]>([])
  const [citations, setCitations] = useState<CitationSourceAnalysis | null>(null)

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

  useEffect(() => {
    if (!tenant?.tenantId || !weekOf) return
    let alive = true
    setCitations(null)
    void loadCitationSources(tenant.tenantId, weekOf).then((data) => {
      if (alive) setCitations(data)
    })
    return () => {
      alive = false
    }
  }, [tenant?.tenantId, weekOf])

  const plan = useMemo(
    () => computeGapActions(analyses, questions, citations),
    [analyses, questions, citations],
  )
  const open = plan.actions.filter((a) => !a.satisfied)
  const satisfied = plan.actions.filter((a) => a.satisfied)
  const ready = !loading && plan.actions.length > 0

  if (!tenant) return null

  return (
    <>
      <p className="brand">STAGE 3</p>
      <h1>실행 항목</h1>
      <p className="lead">
        <Link to="/gap-analysis">가시성 격차 분석</Link>이 "어디가 비어 있나"를 말한다면, 여기는{' '}
        <b>그래서 뭘 하나</b>입니다. 저장된 측정만으로 계산하며 새 API 호출은 없습니다.
      </p>

      <div className="filters">
        <WeekPicker weeks={weeks} value={weekOf} onChange={setWeekOf} />
      </div>

      {loading && <p className="muted">불러오는 중…</p>}

      {!loading && plan.actions.length === 0 && (
        <p className="muted">
          {neverMeasured
            ? '이 브랜드는 아직 측정된 적이 없습니다. '
            : '이 주차에 분석 데이터가 없습니다. '}
          <Link to="/measure-tenant">브랜드·경쟁사 측정</Link>에서 측정하면 항목이 채워집니다.
        </p>
      )}

      {ready && (
        <>
          <section className="hero-card">
            <p className="eyebrow">이번 주차</p>
            <ul className="gap-summary">
              <li>
                남은 항목 <b>{open.length}건</b>
                {satisfied.length > 0 && <> · 데이터가 충족을 확인한 항목 {satisfied.length}건</>}
              </li>
              <li className="muted">
                완료는 사람이 체크하지 않고 <b>데이터에서 읽습니다.</b> 등재가 실제로 되면 그 도메인의
                인용이 우리 언급을 뒷받침하기 시작하고, 그때 자동으로 충족으로 넘어갑니다.
              </li>
            </ul>
          </section>

          <section>
            <h3>할 일</h3>
            <p className="hint" style={{ marginTop: 0 }}>
              영향 숫자는 등재형이면 그 도메인의 인용 수, 콘텐츠형이면 밀린 질문 수입니다. 큰 것부터
              하시면 됩니다.
            </p>
            {open.length === 0 ? (
              <p className="muted">남은 항목이 없습니다.</p>
            ) : (
              <div className="gap-grid">
                {open.map((a) => (
                  <ActionCard key={a.id} action={a} />
                ))}
              </div>
            )}
          </section>

          {satisfied.length > 0 && (
            <section>
              <h3>이미 되어 있는 것</h3>
              <p className="hint" style={{ marginTop: 0 }}>
                이 출처들은 이미 우리 언급을 뒷받침합니다. 새로 할 일은 없지만, 다음 주차에 사라지면
                여기서 먼저 보입니다.
              </p>
              <div className="gap-grid">
                {satisfied.map((a) => (
                  <ActionCard key={a.id} action={a} />
                ))}
              </div>
            </section>
          )}

          <section>
            <h3>목록에서 뺀 것</h3>
            <p className="hint" style={{ marginTop: 0 }}>
              인용된 도메인이라고 다 등재 대상은 아닙니다. 왜 빠졌는지 밝혀 둡니다 — 목록이 짧은 것이
              데이터가 없어서가 아니라는 뜻입니다.
            </p>
            <ul className="gap-summary">
              <li>
                경쟁사 소유 <b>{plan.competitorDomainCount}개</b> — 경쟁사 사이트에는 우리가 실릴 수
                없습니다.
              </li>
              <li>
                출처 분류를 믿을 수 없어 보류 <b>{plan.excludedLowConfidence}개</b> — 인용 판정이 "권위
                있어 보인다"고만 해도 <code>news</code>가 붙습니다. 그대로 쓰면 다른 병원 홈페이지에
                "등재하세요"가 뜹니다. 호스트 목록으로만 분류가 정해지는 출처(위키·후기·커뮤니티·소셜)만
                남겼습니다.
              </li>
              <li className="muted">
                공공기관(<code>.go.kr</code>) 출처도 뺐습니다. 분류는 정확하지만 보건복지부나 PubMed에
                병원이 등재할 방법은 없습니다 — AI가 공공 지침을 참고한다는 사실은{' '}
                <Link to="/citation-gap">인용 갭 분석</Link>에서 보세요.
              </li>
            </ul>
          </section>
        </>
      )}
    </>
  )
}
