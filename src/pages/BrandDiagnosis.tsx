import { useEffect, useMemo, useState } from 'react'
import WeekPicker from '../components/WeekPicker'
import { useTenant } from '../context/useTenant'
import { loadQuestionAnalyses, loadQuestionBank } from '../lib/api'
import { resolveBankVersion } from '../lib/bankVersion'
import { ENGINE_LABEL, OWNER_TYPE_LABEL, formatPct, weekLabel } from '../lib/format'
import { computeGapAnalysis } from '../lib/gapAnalysis'
import { computeQuestionWinLoss } from '../lib/questionWinLoss'
import { STAGE_LABEL, type JourneyStage } from '../lib/journeyStage'
import { useWeeklyPage } from '../lib/useWeeklyPage'
import type { QuestionRepeatAnalysis } from '../lib/types'
import type { Engine, QuestionSpec } from '../prompts/types'

const SENTIMENT_LABEL: Record<string, string> = { positive: '긍정', neutral: '중립', negative: '부정' }

/**
 * 구매 여정 퍼널 — 탐색 → 비교 → 결정 순으로 언급률을 나란히 놓는다.
 *
 * 가시성 격차 분석에도 「구매 여정별」이 있지만 그쪽은 승/무/패를 카드로 보는 화면이다.
 * 여기서는 **언급률의 진행**만 한 줄로 본다 — 뒤따르는 문장 목록이 어느 단계에서 나온 것인지
 * 읽는 맥락이 되고, 단계를 눌러 그 문장만 걸러 볼 수 있다.
 */
function StageFunnel({
  groups,
  active,
  onPick,
}: {
  groups: { key: string; label: string; questions: number; mentionRate: number }[]
  active: JourneyStage | 'all'
  onPick: (stage: JourneyStage | 'all') => void
}) {
  return (
    <div className="funnel">
      {groups.map((g) => {
        const on = active === g.key
        return (
          <button
            type="button"
            key={g.key}
            className={`funnel-step${on ? ' is-on' : ''}`}
            onClick={() => onPick(on ? 'all' : (g.key as JourneyStage))}
            aria-pressed={on}
            title={`${g.label} 질문 ${g.questions}개 — 답을 내놓은 응답 중 브랜드가 언급된 비율(되물은 응답 제외)`}
          >
            <span className="funnel-label">{g.label}</span>
            <span className="funnel-rate">{formatPct(g.mentionRate)}</span>
            <span className="funnel-bar">
              <span style={{ width: `${Math.round(g.mentionRate * 100)}%` }} />
            </span>
            <span className="funnel-meta">질문 {g.questions}개</span>
          </button>
        )
      })}
    </div>
  )
}

export default function BrandDiagnosis() {
  const { tenant } = useTenant()
  const { history, weeks, weekOf, setWeekOf, data: analyses, loading } = useWeeklyPage<QuestionRepeatAnalysis[]>(
    loadQuestionAnalyses,
    tenant?.tenantId ?? '',
    [],
  )

  // 여정 단계는 질문 은행에 있다. 이 주차를 측정한 버전으로 불러온다 — 현재 버전으로 부르면
  // 옛 주차의 질문 id가 맞지 않아 단계가 전부 비어 추정값으로 떨어진다(격차 분석과 같은 이유).
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
  const [stageFilter, setStageFilter] = useState<JourneyStage | 'all'>('all')

  // 엔진 목록은 **이 주차에 실제로 응답한 엔진**에서 뽑는다. 테넌트 설정(tenant.engines)은
  // COLLECT_ENGINES 오버라이드로 실측과 갈릴 수 있다 — 실제로 설정은 openai·gemini인데 측정은
  // 3엔진이어서 Perplexity가 체크박스에 없고 그 문장들이 필터에 걸려 조용히 빠졌다.
  const presentEngines = useMemo(() => {
    const order: Engine[] = ['openai', 'gemini', 'claude', 'perplexity']
    const set = new Set(analyses.map((a) => a.engine))
    return [...order.filter((e) => set.has(e)), ...[...set].filter((e) => !order.includes(e))] as Engine[]
  }, [analyses])
  const [engineFilter, setEngineFilter] = useState<Engine[]>([])
  useEffect(() => {
    setEngineFilter(presentEngines)
  }, [presentEngines])

  // 문구도 데이터로 말한다. "반복 3회"를 박아 두면 36문항×1회로 바뀐 뒤에도 그대로 거짓말을 한다.
  const shape = useMemo(() => {
    const questions = new Set(analyses.map((a) => a.questionId)).size
    const repeats = analyses.reduce((m, a) => Math.max(m, a.callIndex ?? 1), 0)
    return { questions, repeats, engines: presentEngines.length, total: analyses.length }
  }, [analyses, presentEngines])

  const filtered = useMemo(() => analyses.filter((a) => engineFilter.includes(a.engine)), [analyses, engineFilter])

  /*
   * 퍼널은 computeGapAnalysis의 byStage를 그대로 쓴다 — 언급률 계산을 여기서 다시 만들면
   * 두 화면이 같은 주차에 다른 값을 보여줄 수 있다. 엔진 필터가 걸린 분석을 넣어 필터와 맞춘다.
   */
  const stageGroups = useMemo(
    () => (questions.length > 0 ? computeGapAnalysis(filtered, questions).byStage : []),
    [filtered, questions],
  )
  const stageInferredCount = useMemo(
    () => (questions.length > 0 ? computeGapAnalysis(filtered, questions).stageInferredCount : 0),
    [filtered, questions],
  )
  /** 질문 → 단계. 문장 목록을 단계로 거를 때 쓴다. 같은 판정(questionWinLoss)에서 나온 값이다. */
  const stageByQuestion = useMemo(() => {
    const map = new Map<string, JourneyStage>()
    if (questions.length === 0) return map
    for (const row of computeQuestionWinLoss(filtered, questions)) map.set(row.questionId, row.stage)
    return map
  }, [filtered, questions])

  const staged = useMemo(
    () => (stageFilter === 'all' ? filtered : filtered.filter((a) => stageByQuestion.get(a.questionId) === stageFilter)),
    [filtered, stageFilter, stageByQuestion],
  )

  const competitorTotals = useMemo(() => {
    const totals = new Map<string, number>()
    for (const analysis of staged) {
      for (const competitor of analysis.competitorMentions) {
        totals.set(competitor.name, (totals.get(competitor.name) ?? 0) + competitor.mentionCount)
      }
    }
    return [...totals.entries()].sort((a, b) => b[1] - a[1])
  }, [staged])

  const violations = useMemo(
    () => staged.flatMap((a) => a.factualityClaims.filter((c) => c.verdict === 'contradicted').map((claim) => ({ analysis: a, claim }))),
    [staged],
  )

  /*
   * AI 인지 상태 — "아는가 · 무엇으로 아는가 · 무엇을 틀리게 아는가".
   *
   * 아래 본문은 전부 비율과 문장 목록이라, 읽고 나서야 상태를 알 수 있다. 영업 자리에서
   * 꽂히는 말은 비율이 아니라 사실이다 — "Gemini는 당신을 모릅니다", "AI가 주소를 틀리게
   * 말합니다". 세 줄 다 새 측정 없이 이미 저장된 판정에서 나온다.
   *
   * 엔진 필터를 타지 않는다(analyses를 그대로 쓴다). 이건 이 주차 측정 전체에 대한 사실이고,
   * 표시 필터로 "Gemini 미인식"이 사라지면 오히려 상태를 잘못 읽게 된다.
   */
  const recognition = useMemo(() => {
    if (analyses.length === 0) return null

    /*
     * 인지 판정은 **브랜드명을 넣은 질문**에서만 한다.
     * 이름을 대고 물었는데도 답변에 브랜드가 안 나오면 그 엔진은 우리를 모르는 것이다.
     * 카테고리 무관 질문으로 판정하면 "노출이 약한 것"과 "모르는 것"이 섞인다 — 다른 얘기다.
     * 되물은 응답(clarifying)은 분모에서 뺀다. 답을 안 한 것이지 모른다는 뜻이 아니다.
     */
    const named = new Set(questions.filter((q) => q.containsBrandName).map((q) => q.questionId))
    const byEngine = presentEngines.map((engine) => {
      const rows = analyses.filter((a) => a.engine === engine && named.has(a.questionId) && !a.clarifying)
      return { engine, answered: rows.length, hit: rows.filter((a) => a.mentioned).length }
    })
    const judged = byEngine.filter((e) => e.answered > 0)
    const unknown = judged.filter((e) => e.hit === 0)

    /*
     * 인지 근거 — 언급을 **뒷받침한** 인용만 본다(supportsBrandMention).
     * 답변에 딸린 인용을 전부 세면 브랜드와 무관한 출처까지 "우리를 아는 근거"가 되어 버린다.
     */
    const owners = new Map<string, number>()
    const hosts = new Map<string, number>()
    for (const a of analyses) {
      if (!a.mentioned) continue
      for (const c of a.citations) {
        if (!c.supportsBrandMention) continue
        owners.set(c.ownerType, (owners.get(c.ownerType) ?? 0) + 1)
        const h = (c.domain ?? '').replace(/^(www|m)\./, '').toLowerCase()
        if (h) hosts.set(h, (hosts.get(h) ?? 0) + 1)
      }
    }

    // 오인지 — Fact Graph와 모순된 주장. 어느 엔진이 몇 건인지까지 같이 센다.
    const wrong = analyses.flatMap((a) =>
      a.factualityClaims.filter((c) => c.verdict === 'contradicted').map((claim) => ({ engine: a.engine, claim })),
    )
    const wrongByEngine = new Map<string, number>()
    for (const w of wrong) wrongByEngine.set(w.engine, (wrongByEngine.get(w.engine) ?? 0) + 1)

    return {
      namedQuestions: named.size,
      byEngine,
      judged,
      unknown,
      owners: [...owners.entries()].sort((a, b) => b[1] - a[1]),
      hosts: [...hosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3),
      wrong,
      wrongByEngine: [...wrongByEngine.entries()].sort((a, b) => b[1] - a[1]),
    }
  }, [analyses, questions, presentEngines])

  function toggleEngine(engine: Engine) {
    setEngineFilter((current) => (current.includes(engine) ? current.filter((e) => e !== engine) : [...current, engine]))
  }

  if (!tenant) return null

  return (
    <>
      <p className="brand">어디가 비어 있나</p>
      <h1>브랜드 종합 진단</h1>
      <p className="lead">
        이번 주 응답
        {shape.total > 0
          ? ` ${shape.total}건(질문 ${shape.questions}개 × 엔진 ${shape.engines}개 × 반복 ${shape.repeats}회)`
          : '(질문 × 엔진 × 반복)'}{' '}
        중 브랜드가 실제로 어떻게 언급됐는지 문장 단위로 봅니다.
      </p>

      {recognition && (
        <section className="recognition" aria-label="AI 인지 상태">
          <p className="eyebrow">AI 인지 상태 · {weekLabel(weekOf)} 측정 전체</p>

          <div className="recog-row">
            <span className={`status-pill ${recognition.unknown.length === 0 ? 'st-good' : 'st-bad'}`}>
              {recognition.judged.length === 0 ? '판정 불가' : recognition.unknown.length === 0 ? '인지' : '일부 미인지'}
            </span>
            <div>
              {recognition.judged.length === 0 ? (
                <p>
                  브랜드명을 넣은 질문이 {recognition.namedQuestions}개뿐이라 인지 여부를 판정할 수 없습니다 — 질문
                  은행에 브랜드 직접 질문을 넣어야 이 줄이 채워집니다.
                </p>
              ) : (
                <>
                  <p>
                    엔진 {recognition.judged.length}개 중 <b>{recognition.judged.length - recognition.unknown.length}개</b>가
                    브랜드를 인식
                    {recognition.unknown.length > 0 && (
                      <>
                        {' — '}
                        <b>{recognition.unknown.map((e) => ENGINE_LABEL[e.engine] ?? e.engine).join(' · ')} 미인식</b>
                      </>
                    )}
                  </p>
                  <p className="recog-detail">
                    {recognition.byEngine
                      .map((e) =>
                        e.answered === 0
                          ? `${ENGINE_LABEL[e.engine] ?? e.engine} 응답 없음`
                          : `${ENGINE_LABEL[e.engine] ?? e.engine} ${e.hit}/${e.answered}`,
                      )
                      .join(' · ')}
                    {' · '}브랜드명을 넣은 질문 {recognition.namedQuestions}개 기준(되물은 응답 제외)
                  </p>
                </>
              )}
            </div>
          </div>

          <div className="recog-row">
            <span className="status-pill st-info">인지 근거</span>
            <div>
              {recognition.owners.length === 0 ? (
                <p>언급을 뒷받침한 인용이 없습니다 — 엔진이 근거 없이 브랜드를 말하고 있습니다.</p>
              ) : (
                <>
                  <p>{recognition.owners.map(([t, n]) => `${OWNER_TYPE_LABEL[t] ?? t} ${n}건`).join(' · ')}</p>
                  {recognition.hosts.length > 0 && (
                    <p className="recog-detail">
                      가장 많이 인용된 곳: {recognition.hosts.map(([h, n]) => `${h} ${n}`).join(' · ')}
                    </p>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="recog-row">
            <span className={`status-pill ${recognition.wrong.length > 0 ? 'st-bad' : 'st-good'}`}>
              {recognition.wrong.length > 0 ? '오인지' : '오인지 없음'}
            </span>
            <div>
              {recognition.wrong.length === 0 ? (
                <p>Fact Graph와 모순된 주장이 없습니다.</p>
              ) : (
                <>
                  <p>
                    <b>{recognition.wrong.length}건</b>
                    {' — '}
                    {recognition.wrongByEngine
                      .map(([e, n]) => `${ENGINE_LABEL[e] ?? e} ${n}건`)
                      .join(' · ')}
                  </p>
                  {/* 예시는 한 건만. 전체 목록은 아래 「Fact Graph 위반」이 이미 보여 준다. */}
                  <p className="recog-detail">
                    예: AI는 「{recognition.wrong[0]!.claim.responseValue ?? recognition.wrong[0]!.claim.claimText}」
                    {recognition.wrong[0]!.claim.factGraphValue && (
                      <> — 실제는 「{recognition.wrong[0]!.claim.factGraphValue}」</>
                    )}
                  </p>
                </>
              )}
            </div>
          </div>
        </section>
      )}

      <div className="filters">
        <WeekPicker weeks={weeks} value={weekOf} onChange={setWeekOf} />
        <fieldset className="engine-filter">
          <legend>엔진</legend>
          {presentEngines.map((engine) => (
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
          {stageGroups.length > 0 && (
            <section>
              <h3>구매 여정별 언급률</h3>
              <p className="hint" style={{ marginTop: 0 }}>
                탐색 → 비교 → 결정 순입니다. 답을 내놓은 응답 중 브랜드가 언급된 비율이며, 되물은 응답은 분모에서
                빠집니다. 단계를 누르면 아래 문장·경쟁사·사실성이 그 단계로 좁혀집니다.
                {stageInferredCount > 0 &&
                  ` 질문 ${stageInferredCount}개는 은행에 단계 기록이 없어 문장으로 추정했습니다 — 질문 프롬프트 빌더에서 "단계 매기기"를 실행하면 판정값으로 바뀝니다.`}
              </p>
              <StageFunnel groups={stageGroups} active={stageFilter} onPick={setStageFilter} />
              {stageFilter !== 'all' && (
                <p className="muted">
                  {STAGE_LABEL[stageFilter]} 단계만 보는 중 ·{' '}
                  <button type="button" className="ghost" onClick={() => setStageFilter('all')}>
                    전체 보기
                  </button>
                </p>
              )}
            </section>
          )}

          <section>
            <h3>브랜드 언급 문장 ({staged.filter((a) => a.mentioned).length}건)</h3>
            <ul className="sentence-list">
              {staged
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
