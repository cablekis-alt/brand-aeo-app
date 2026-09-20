import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import WeekPicker from '../components/WeekPicker'
import { useTenant } from '../context/useTenant'
import {
  loadDiscoveredBrands,
  loadQuestionAnalyses,
  loadQuestionBank,
  loadRawAnswers,
  type DiscoveryResult,
  type RawAnswer,
} from '../lib/api'
import { highlightAnswer, type MarkKind } from '../lib/answerHighlight'
import { resolveBankVersion } from '../lib/bankVersion'
import { ENGINE_LABEL, OWNER_TYPE_LABEL, formatPct, weekLabel } from '../lib/format'
import { computeGapAnalysis } from '../lib/gapAnalysis'
import { computeQuestionWinLoss } from '../lib/questionWinLoss'
import { STAGE_LABEL, type JourneyStage } from '../lib/journeyStage'
import { useWeeklyPage } from '../lib/useWeeklyPage'
import type { QuestionRepeatAnalysis } from '../lib/types'
import { AEO_SCORE_WEIGHTS, normalizeRank, type WeeklyScorecard } from '../prompts/b8-report'
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

/**
 * 점수 구성 막대 — 38점이 **어디서 깎였는지**를 한눈에 본다.
 *
 * 대시보드는 같은 값을 카드 여섯 장으로 보여 주지만, 카드는 서로 비교가 안 된다.
 * 어느 항목이 점수를 끌어내리는지 알려면 숫자 여섯 개를 머리로 견줘야 한다. 막대는
 * 그 비교를 눈이 대신한다.
 *
 * 막대 길이는 **점수에 실제로 들어가는 값**이다. 추천 순위는 비율이 아니라 낮을수록 좋아서
 * 원값을 그대로 그리면 "6.4위"에 긴 막대가 붙는다 — 점수와 정반대 그림이 된다. 그래서
 * 점수 계산과 같은 normalizeRank를 쓰고, 라벨에는 사람이 아는 원값(6.4위)을 적는다.
 *
 * 측정 불가(null)는 막대를 그리지 않는다. 0으로 그리면 "최악"으로 보이는데 실제로는
 * 그 항목을 빼고 남은 가중치로 재정규화해 점수를 낸다 — 다른 얘기다.
 */
function ScoreBreakdown({ card }: { card: WeeklyScorecard }) {
  const rows: { key: string; letter: string; label: string; weight: number; value: number | null; text: string }[] = [
    {
      key: 'm',
      letter: 'M',
      label: '카테고리 무관 언급률',
      weight: AEO_SCORE_WEIGHTS.mentionRate,
      value: card.mentionRate,
      text: formatPct(card.mentionRate),
    },
    {
      key: 's',
      letter: 'S',
      label: 'Share of Mention',
      weight: AEO_SCORE_WEIGHTS.shareOfMention,
      value: card.shareOfMention,
      text: card.shareOfMention === null ? '측정 불가' : formatPct(card.shareOfMention),
    },
    {
      key: 'c',
      letter: 'C',
      label: '브랜드 소유 출처',
      weight: AEO_SCORE_WEIGHTS.brandOwnedCitationRate,
      value: card.brandOwnedCitationRate,
      text: formatPct(card.brandOwnedCitationRate),
    },
    {
      key: 'p',
      letter: 'P',
      label: '평균 추천 순위',
      weight: AEO_SCORE_WEIGHTS.avgRecommendationRank,
      value: card.avgRecommendationRank === null ? null : normalizeRank(card.avgRecommendationRank),
      text: card.avgRecommendationRank === null ? '판정 불가' : `${card.avgRecommendationRank.toFixed(1)}위`,
    },
    {
      key: 'f',
      letter: 'F',
      label: '사실성',
      weight: AEO_SCORE_WEIGHTS.factualityScore,
      value: card.factualityScore,
      text: formatPct(card.factualityScore),
    },
  ]
  const missing = rows.filter((r) => r.value === null)
  return (
    <section className="score-breakdown">
      <p className="eyebrow">Brand AEO Score · {weekLabel(card.weekOf)}</p>
      <p className="breakdown-total">
        <strong>{card.aeoScore.current}</strong>
        <span className="muted">점 — 아래 다섯 항목을 가중 평균한 값입니다</span>
      </p>
      <ul className="breakdown-rows">
        {rows.map((r) => (
          <li key={r.key}>
            <span className="bd-letter" aria-hidden="true">
              {r.letter}
            </span>
            <span className="bd-label">
              {r.label}
              <span className="muted"> {Math.round(r.weight * 100)}%</span>
            </span>
            <span className="bd-bar">
              {r.value !== null && <span style={{ width: `${Math.round(r.value * 100)}%` }} />}
            </span>
            <span className={`bd-value${r.value === null ? ' muted' : ''}`}>{r.text}</span>
          </li>
        ))}
      </ul>
      <p className="hint" style={{ marginBottom: 0 }}>
        막대는 점수에 실제로 들어가는 값입니다 — 추천 순위는 낮을수록 좋아 0~1로 환산해 그립니다.
        M·S에는 감성 계수가 곱해집니다.
        {missing.length > 0 &&
          ` ${missing.map((r) => r.letter).join('·')}는 측정할 수 없어 그 가중치를 빼고 남은 합으로 재정규화했습니다 — 0점으로 치지 않습니다.`}
      </p>
    </section>
  )
}

export default function BrandDiagnosis() {
  const { tenant } = useTenant()
  /*
   * 다른 화면에서 질문을 지정해 들어올 수 있다(질문별 승패의 「원문 보기」).
   * 주차는 처음부터 그 값으로 시작하고, 질문은 사용자가 아직 고르지 않았을 때만 쓴다 —
   * 들어온 뒤 드롭다운을 바꾸면 그 선택이 이긴다.
   */
  const [searchParams] = useSearchParams()
  const paramWeek = searchParams.get('week') ?? ''
  const paramQuestion = searchParams.get('q') ?? ''
  const { history, weeks, weekOf, setWeekOf, data: analyses, loading } = useWeeklyPage<QuestionRepeatAnalysis[]>(
    loadQuestionAnalyses,
    tenant?.tenantId ?? '',
    [],
    paramWeek,
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

  /*
   * AI 답변 원문 — 판정의 근거를 통째로 보여 준다.
   *
   * 지금까지 화면은 판정 결과(언급률·문장 조각)만 보여 줬다. 조각만 보여 주면 "유리한
   * 부분만 잘라 왔다"는 의심을 산다. 원문은 처음부터 raw-calls.json에 남아 있었는데
   * 한 번도 띄우지 않았을 뿐이다.
   *
   * 질문 하나씩 부른다 — 한 주차 전체는 실측 215KB(71건)라 한 번에 내려받을 이유가 없다.
   */
  const askable = useMemo(() => {
    const has = new Set(analyses.map((a) => a.questionId))
    const byId = new Map(questions.map((q) => [q.questionId, q]))
    return [...has]
      .map((id) => ({ id, text: byId.get(id)?.text ?? id }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }, [analyses, questions])

  const [rawQuestion, setRawQuestion] = useState('')
  // 기본 질문은 **사실 오류가 있는 질문**을 먼저 고른다. 원문을 여는 이유가 대개 그것이다.
  const defaultRawQuestion = useMemo(() => {
    const wrong = analyses.find((a) => a.factualityClaims.some((c) => c.verdict === 'contradicted'))
    if (wrong) return wrong.questionId
    return analyses.find((a) => a.mentioned)?.questionId ?? askable[0]?.id ?? ''
  }, [analyses, askable])
  const activeRawQuestion =
    rawQuestion && askable.some((q) => q.id === rawQuestion)
      ? rawQuestion
      : paramQuestion && askable.some((q) => q.id === paramQuestion)
        ? paramQuestion
        : defaultRawQuestion

  const [raw, setRaw] = useState<{ key: string; value: RawAnswer[] | null }>({ key: '', value: null })
  const rawKey = tenant && activeRawQuestion ? `${tenant.tenantId}|${weekOf}|${activeRawQuestion}` : ''
  useEffect(() => {
    if (!tenant?.tenantId || !activeRawQuestion) return
    let alive = true
    const key = `${tenant.tenantId}|${weekOf}|${activeRawQuestion}`
    void loadRawAnswers(tenant.tenantId, weekOf, activeRawQuestion).then((v) => {
      if (alive) setRaw({ key, value: v })
    })
    return () => {
      alive = false
    }
  }, [tenant?.tenantId, weekOf, activeRawQuestion])
  // 로딩은 상태로 들지 않고 키 불일치로 읽는다 — effect 안에서 동기로 setState 하지 않아도 된다.
  const rawLoading = rawKey !== '' && raw.key !== rawKey
  const rawAnswers = useMemo(() => (raw.key === rawKey ? (raw.value ?? []) : []), [raw, rawKey])

  const [rawEngine, setRawEngine] = useState<string>('')
  const rawEngines = useMemo(() => [...new Set(rawAnswers.map((a) => a.engine))], [rawAnswers])
  const activeRawEngine = rawEngine && rawEngines.includes(rawEngine) ? rawEngine : (rawEngines[0] ?? '')
  const shown = rawAnswers.find((a) => a.engine === activeRawEngine) ?? null

  /*
   * 칠할 구간은 전부 **이미 저장된 판정**에서 온다 — 여기서 새로 판단하지 않는다.
   * 원문에서 그 문자열을 못 찾으면 칠하지 않고 몇 개를 못 찾았는지 화면이 밝힌다.
   */
  const marked = useMemo(() => {
    if (!shown) return null
    const judged = analyses.find(
      (a) => a.questionId === activeRawQuestion && a.engine === activeRawEngine && a.callIndex === shown.callIndex,
    )
    const needles: { text: string; kind: MarkKind }[] = []
    if (judged) {
      for (const c of judged.factualityClaims) {
        if (c.verdict !== 'contradicted') continue
        needles.push({ text: c.responseValue || c.claimText, kind: 'wrong' })
      }
      for (const m of judged.mentionSentences) needles.push({ text: m.sentence, kind: 'mention' })
      for (const c of judged.competitorMentions) {
        for (const m of c.sentences) needles.push({ text: m.sentence, kind: 'competitor' })
      }
    }
    return { ...highlightAnswer(shown.rawText, needles), needles: needles.length, judged: Boolean(judged) }
  }, [shown, analyses, activeRawQuestion, activeRawEngine])

  /*
   * 답변에 함께 나온 브랜드 — 코호트에 없는 곳을 발견하는 자리.
   *
   * 「경쟁사 언급 비교」는 등록된 경쟁사만 본다(판정 프롬프트에 목록을 넣어 주기 때문이다).
   * 그래서 등록하지 않은 업체는 답변에 아무리 자주 나와도 화면에 존재하지 않았다.
   * 여기는 원문에서 직접 뽑으므로 "우리가 모르고 있던 곳"이 드러난다.
   */
  const [found, setFound] = useState<{ key: string; value: DiscoveryResult | null }>({ key: '', value: null })
  const foundKey = tenant ? `${tenant.tenantId}|${weekOf}` : ''
  useEffect(() => {
    if (!tenant?.tenantId) return
    let alive = true
    const key = `${tenant.tenantId}|${weekOf}`
    void loadDiscoveredBrands(tenant.tenantId, weekOf).then((v) => {
      if (alive) setFound({ key, value: v })
    })
    return () => {
      alive = false
    }
  }, [tenant?.tenantId, weekOf])
  const discovery = found.key === foundKey ? found.value : null
  const [showAllFound, setShowAllFound] = useState(false)
  // 점수 구성 막대가 쓸 스코어카드 — 주차 선택과 같은 주를 본다.
  const scoreCard = useMemo(() => history.find((h) => h.weekOf === weekOf) ?? null, [history, weekOf])

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

      {scoreCard && <ScoreBreakdown card={scoreCard} />}

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

          {askable.length > 0 && (
            <section>
              <h3>AI 답변 원문</h3>
              <p className="hint" style={{ marginTop: 0 }}>
                위 문장들이 어디서 나왔는지 원문 그대로 봅니다. 칠해진 부분은 <b>이미 판정된 것만</b>이며,
                화면이 새로 판단하지 않습니다.
              </p>

              <div className="filters">
                <label className="field">
                  <span>질문</span>
                  <select value={activeRawQuestion} onChange={(e) => setRawQuestion(e.target.value)}>
                    {askable.map((q) => (
                      <option key={q.id} value={q.id}>
                        {q.id} · {q.text.length > 48 ? `${q.text.slice(0, 48)}…` : q.text}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {rawLoading && <p className="muted">원문을 불러오는 중…</p>}
              {!rawLoading && rawAnswers.length === 0 && (
                <p className="muted">
                  이 주차에는 저장된 원문이 없습니다 — 옛 측정이거나 데모 데이터입니다(원문은 데스크톱 앱에서만
                  읽습니다).
                </p>
              )}

              {rawAnswers.length > 0 && (
                <>
                  <div className="axis-tabs" role="tablist" aria-label="엔진">
                    {rawEngines.map((e) => (
                      <button
                        type="button"
                        key={e}
                        role="tab"
                        aria-selected={activeRawEngine === e}
                        className={`axis-tab${activeRawEngine === e ? ' is-on' : ''}`}
                        onClick={() => setRawEngine(e)}
                      >
                        {ENGINE_LABEL[e] ?? e}
                      </button>
                    ))}
                  </div>

                  <p className="legend">
                    <span className="hl hl-wrong">사실 오류</span>
                    <span className="hl hl-mention">브랜드 언급</span>
                    <span className="hl hl-competitor">경쟁사 언급</span>
                    {marked && marked.missed > 0 && (
                      <span className="muted">
                        · 판정 {marked.needles}건 중 {marked.missed}건은 원문에서 그 문구를 찾지 못해 칠하지
                        않았습니다
                      </span>
                    )}
                    {marked && !marked.judged && <span className="muted">· 이 회차의 판정 레코드가 없습니다</span>}
                  </p>

                  {shown && (
                    <>
                      <pre className="raw-answer">
                        {marked?.segments.map((seg, i) =>
                          seg.kind ? (
                            <mark key={i} className={`hl hl-${seg.kind}`}>
                              {seg.text}
                            </mark>
                          ) : (
                            <span key={i}>{seg.text}</span>
                          ),
                        )}
                      </pre>
                      <p className="muted" style={{ fontSize: 13 }}>
                        {ENGINE_LABEL[shown.engine] ?? shown.engine} · {shown.callIndex}회차
                        {shown.usedWebSearch ? ' · 웹검색 사용' : ' · 웹검색 없음'}
                        {typeof shown.latencyMs === 'number' && ` · ${(shown.latencyMs / 1000).toFixed(1)}초`}
                        {shown.citations.length > 0 && ` · 인용 ${shown.citations.length}건`}
                      </p>
                    </>
                  )}
                </>
              )}
            </section>
          )}

          {discovery && (
            <section>
              <h3>답변에 함께 나온 브랜드</h3>
              <p className="hint" style={{ marginTop: 0 }}>
                위 「경쟁사 언급 비교」는 <b>등록한 경쟁사만</b> 봅니다. 여기는 답변 원문에서 직접 뽑아, 코호트에
                없는 곳까지 보여 줍니다. <b>판정이 아니라 후보</b>이며 등록은 사람이 확인한 뒤에 합니다.
              </p>
              {discovery.suffixes.length === 0 ? (
                <p className="muted">
                  「{tenant.industry}」는 상호에 붙는 말이 아니라서 이 방식으로는 찾을 수 없습니다 — 업종 이름이
                  상호 끝에 붙는 경우(성형외과·치과·펜션 등)에만 동작합니다.
                </p>
              ) : discovery.answersScanned === 0 ? (
                <p className="muted">이 주차에는 저장된 원문이 없어 찾을 수 없습니다.</p>
              ) : discovery.brands.length === 0 ? (
                <p className="muted">
                  {discovery.suffixSource === 'fallback'
                    ? `「${tenant.industry}」를 상호 접미사로 삼아 답변 ${discovery.answersScanned}건을 훑었지만 한 곳도 없었습니다 — 업종명이 상호 끝에 붙지 않는 업종이라 이 방식으로는 찾기 어렵습니다. "경쟁사가 없다"는 뜻이 아닙니다.`
                    : `답변 ${discovery.answersScanned}건에서 다른 브랜드가 발견되지 않았습니다.`}
                </p>
              ) : (
                <>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>브랜드</th>
                          <th>나온 답변</th>
                          <th>총 등장</th>
                          <th>엔진</th>
                          <th>코호트</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(showAllFound ? discovery.brands : discovery.brands.slice(0, 10)).map((b) => (
                          <tr key={b.name}>
                            <td>
                              <b>{b.name}</b>
                            </td>
                            <td>{b.answers}건</td>
                            <td>{b.mentions}회</td>
                            <td className="muted">{b.engines.map((e) => ENGINE_LABEL[e] ?? e).join(' · ')}</td>
                            <td>
                              <span className={`status-pill ${b.registered ? 'st-good' : 'st-warn'}`}>
                                {b.registered ? '등록됨' : '미등록'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {discovery.brands.length > 10 && (
                    <button type="button" className="gap-more-toggle" onClick={() => setShowAllFound((v) => !v)}>
                      {showAllFound ? '▾ 접기' : `▸ 나머지 ${discovery.brands.length - 10}개 더 보기`}
                    </button>
                  )}
                  <p className="muted">
                    미등록 브랜드를 코호트에 넣으려면 <Link to="/brand-onboarding">브랜드 추가</Link>에서 경쟁사로
                    등록하세요 — 다음 측정부터 언급 비교·Share of Mention에 들어갑니다.
                  </p>
                </>
              )}
            </section>
          )}

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
