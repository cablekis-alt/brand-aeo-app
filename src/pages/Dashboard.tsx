import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import AnswerCard from '../components/AnswerCard'
import ChangeAlerts from '../components/ChangeAlerts'
import PositionMap from '../components/PositionMap'
import { useTenant } from '../context/useTenant'
import { ENGINE_LABEL, formatDelta, formatPct, formatRank, measureConditionText, weekLabel } from '../lib/format'
import { loadQuestionAnalyses, loadQuestionBank, loadRanking, loadSiteScores, type SiteScoreRecord } from '../lib/api'
import { buildPeriodicReport, type MetricStatus } from '../lib/b9-report'
import { engineMentions, headlineSentence, pickAnswerHighlights, questionCoverage, unnamedOwnedCitation } from '../lib/answerInsights'
import { conditionChange } from '../lib/comparability'
import { buildRecommendationEvidence, type EvidenceBlock } from '../lib/recommendationEvidence'
import { RANK_FULL_WEIGHT_RESPONSES, WEIGHT_RATIO, shareOfMentionNote } from '../prompts/b8-report'
import type { QuestionBank, QuestionRepeatAnalysis, RankingView } from '../lib/types'
import { useScorecards } from '../lib/useScorecards'
import { isOpenAction } from '../lib/gapActions'
import { useGapActionPlan } from '../lib/useGapActionPlan'

/** 5주 추이에 보이는 주 수. */
const TREND_WEEKS = 5
/** 「이번 주 할 일」에 펼쳐 두는 질문 수 — 나머지는 콘텐츠 생성 화면에서 본다. */
const TODO_SHOW = 3

export default function Dashboard() {
  const { tenant } = useTenant()
  // Site AEO Score의 주차 기록은 로컬 서버에만 있다(Vercel에는 이 라우트가 없다).
  // 웹에서 "진단하면 쌓입니다"라고 안내하면 지키지 못할 약속이 된다.
  const isElectron = typeof window !== 'undefined' && Boolean(window.electron?.isElectron)
  const { history, loading, error } = useScorecards(tenant?.tenantId ?? '')
  const card = history.at(-1) ?? null

  /*
   * 「이름을 대면 / 안 대면」 대비와 코호트 구성원 이름 — 스코어카드에 없는 값이라 랭킹 API를 한 번 더 부른다.
   * (비교용으로만 재는 브랜드는 브랜드 목록에 없어, 순위표 이름은 이 응답의 cohort.peers에서 읽는다.)
   *
   * 스코어카드에 넣어 저장할 수도 있지만 그러면 **다시 측정해야** 값이 생긴다. 이 계산은 이미
   * 저장된 판정 레코드와 질문 은행만 쓰므로 지난 주차도 바로 채워진다.
   * 실패하면 조용히 감춘다 — 대시보드 본문(Brand AEO Score)을 막을 이유가 없다.
   */
  const [ranking, setRanking] = useState<{ key: string; value: RankingView | null }>({ key: '', value: null })
  const splitKey = card ? `${card.tenantId}|${card.weekOf}` : ''
  useEffect(() => {
    if (!card) return
    let alive = true
    void loadRanking(card.tenantId, card.weekOf)
      .then((view) => {
        if (alive) setRanking({ key: `${card.tenantId}|${card.weekOf}`, value: view ?? null })
      })
      .catch(() => {
        if (alive) setRanking({ key: `${card.tenantId}|${card.weekOf}`, value: null })
      })
    return () => {
      alive = false
    }
  }, [card])

  /*
   * 「이번 주 할 일」 — 정기진단 보고서 개선제안의 실행 항목과 같은 근거(buildRecommendationEvidence)를
   * 쓴다. 이름 없는 질문 중 밀린 것과 그때 대신 불린 곳이다. 같은 질문을 두 화면이 다르게 고르면 안 된다.
   * 판정 기록을 못 읽으면 이 칸만 비운다 — 점수 칸을 막을 이유가 없다.
   */
  const [todoData, setTodoData] = useState<{
    key: string
    analyses: QuestionRepeatAnalysis[]
    bank: QuestionBank | null
  } | null>(null)
  useEffect(() => {
    if (!card) return
    let alive = true
    const key = `${card.tenantId}|${card.weekOf}`
    Promise.all([loadQuestionAnalyses(card.tenantId, card.weekOf), loadQuestionBank(card.tenantId, card.questionBankVersion)]).then(
      ([analyses, bank]) => alive && setTodoData({ key, analyses, bank }),
      () => alive && setTodoData({ key, analyses: [], bank: null }),
    )
    return () => {
      alive = false
    }
  }, [card])
  const todo = useMemo((): EvidenceBlock | null => {
    if (!card || !todoData || todoData.key !== splitKey) return null
    const evidence = buildRecommendationEvidence({
      card,
      analyses: todoData.analyses,
      questions: todoData.bank?.questions ?? [],
      citations: null,
      site: null,
    })
    return evidence.mention?.blocks[0] ?? null
  }, [card, todoData, splitKey])

  /*
   * Site AEO Score — 페이지 자체의 준비도. Brand AEO Score와 **다른 것을 잰다**.
   *
   * Brand 쪽은 "엔진이 우리를 말하는가", Site 쪽은 "그 페이지가 인용될 만한가"다. 그래서 점수 구성이
   * 아니라 「진단 지표 · 점수 미포함」 칸에 둔다. 둘의 차이 자체는 진단이라 「이번 주 한 줄」이 읽어 준다.
   *
   * 주차가 스코어카드와 어긋날 수 있다(사이트 진단은 아무 때나 돌린다). 맞추려고 값을
   * 끌어다 쓰지 않고, 가장 최근 기록을 그 주차와 함께 보여 준다.
   */
  const [siteScores, setSiteScores] = useState<{ key: string; value: Record<string, SiteScoreRecord> }>({
    key: '',
    value: {},
  })
  useEffect(() => {
    const id = tenant?.tenantId
    if (!id) return
    let alive = true
    void loadSiteScores(id).then((v) => {
      if (alive) setSiteScores({ key: id, value: v ?? {} })
    })
    return () => {
      alive = false
    }
  }, [tenant?.tenantId])
  const siteWeeks = siteScores.key === (tenant?.tenantId ?? '') ? Object.keys(siteScores.value).sort() : []
  const siteNow = siteWeeks.length > 0 ? (siteScores.value[siteWeeks[siteWeeks.length - 1]!] ?? null) : null
  const sitePrev = siteWeeks.length > 1 ? (siteScores.value[siteWeeks[siteWeeks.length - 2]!] ?? null) : null
  const siteDelta = siteNow && sitePrev ? siteNow.score - sitePrev.score : null

  /*
   * 「이번 주 한 줄」 — 숫자를 주기 전에 결론을 먼저 놓는다.
   *
   * 판정은 만들지 않고 **정기진단 보고서의 것을 그대로 쓴다**(buildPeriodicReport).
   * 같은 브랜드를 두 화면이 다르게 판정하면 둘 다 못 믿게 된다. 종합 판정도, 지표별
   * 미흡/주의 판정도, 설명 문장도 전부 거기서 온다.
   *
   * 'unknown'은 병목으로 내세우지 않는다 — 측정하지 못한 것과 나쁜 것은 다르다.
   */
  const headline = ((): { tone: MetricStatus; label: string; detail: string } | null => {
    if (!card) return null
    const report = buildPeriodicReport(history, card.weekOf)
    if (!report) return null
    const worst = report.metrics
      .filter((m) => m.status === 'bad' || m.status === 'warn')
      .sort((a, b) => b.weight - a.weight)[0]
    const detail: string[] = []
    if (worst) detail.push(`가장 발목을 잡는 건 ${worst.label} ${worst.valueText}입니다 — ${worst.note}`)
    /*
     * 두 점수의 관계. 서로 다른 것을 재므로 "78-38=40점 차"를 결론으로 내세우지 않고
     * 어느 쪽이 막고 있는지 방향만 읽는다. 경계를 20점으로 크게 잡은 것도 같은 이유다 —
     * 근소한 차는 방향을 말해 주지 않는다.
     */
    if (siteNow) {
      const gap = siteNow.score - card.aeoScore.current
      if (gap >= 20) {
        detail.push(`페이지 준비도(${siteNow.score})는 충분하니, 지금 막는 것은 페이지가 아니라 권위·인용일 가능성이 큽니다.`)
      } else if (gap <= -20) {
        detail.push(`답변 노출에 비해 페이지 준비도(${siteNow.score})가 뒤처집니다 — 페이지를 먼저 고치면 지금의 노출이 더 단단해집니다.`)
      }
    }
    return { tone: report.verdict.tone, label: report.verdict.label, detail: detail.join(' ') }
  })()

  // 브랜드·주차가 바뀌는 순간 옛 값이 새 카드에 붙지 않게 키를 맞춘다.
  const rankingView = ranking.key === splitKey ? ranking.value : null
  const promptedSplit = rankingView?.promptedSplit ?? null
  // 전주는 저장된 previousWeek가 아니라 히스토리에서 읽는다. 저장값은 측정 시점에 박제되어,
  // 지난 주를 다시 재면 어긋난다(실측: W37 카드 33 vs 알림 42 — 같은 화면이 +2와 -7을 동시에
  // 말했다). 알림도 히스토리를 쓰므로 이제 두 자리가 같은 값을 본다.
  const prevCard = history.length > 1 ? history[history.length - 2]! : null
  const prevScore = prevCard?.aeoScore.current ?? null
  // 측정 조건이 다르면 증감을 숫자로 내세우지 않는다. 헤드라인이 빨간 -7인데 바로 아래 알림이
  // "그렇게 읽지 말라"고 하면 화면이 자기모순이다. 5주 추이의 조건 변경 표식과 같은 규칙이다.
  const changedBy = prevCard && card ? conditionChange(prevCard, card) : null
  const delta = card && prevScore !== null && !changedBy ? formatDelta(card.aeoScore.current, prevScore) : null

  // 5주 추이 — 세로축 위끝은 보이는 주의 최고점을 10 단위로 올린 값(최소 20). 0~100 그대로 그리면
  // 한 자릿수·10점대 브랜드는 막대가 바닥에 붙어 추이가 안 보인다. 축 범위는 화면에 함께 적는다.
  // 직전 주와 측정 조건이 다른 주에는 표식을 단다. 화면에 보이는 첫 주도 그 앞 주와 비교한다.
  const trendWeeks = history.slice(-TREND_WEEKS)
  const trendTop = Math.max(20, Math.ceil(Math.max(0, ...trendWeeks.map((h) => h.aeoScore.current)) / 10) * 10)
  const trend = trendWeeks.map((h, i, list) => {
    const before = i > 0 ? list[i - 1] : history[history.length - list.length - 1]
    return { card: h, changed: before ? conditionChange(before, h) : null }
  })

  // 안내문·카드는 실제로 수집에 성공한 엔진에서 파생한다. 스코어카드에 기록된 enginesUsed가 진실이며
  // (키가 설정돼도 크레딧 소진 등으로 실패하면 빠진다), 구버전 스코어카드는 tenant.engines로 폴백한다.
  const ALL_ENGINES = ['openai', 'gemini', 'claude', 'perplexity'] as const
  const usedEngines: string[] = card?.enginesUsed?.length ? card.enginesUsed : (tenant?.engines ?? [])
  const usedLabels = usedEngines.map((e) => ENGINE_LABEL[e] ?? e)
  const excludedLabels = ALL_ENGINES.filter((e) => !usedEngines.includes(e)).map((e) => ENGINE_LABEL[e] ?? e)
  // 실행 항목 남은 건수 — 사이드바 배지·실행 항목 화면과 같은 훅, 같은 정의(isOpenAction).
  const { plan: actionPlan, loading: actionsLoading } = useGapActionPlan(tenant?.tenantId ?? '')
  const openActions = !actionsLoading && tenant ? actionPlan.actions.filter(isOpenAction).length : null

  const cohortText = card
    ? `코호트 ${(card.cohortRank.tiedCount ?? 1) > 1 ? '공동 ' : ''}${card.cohortRank.position}위 / ${card.cohortRank.totalTenants}`
    : ''
  const ranked = card?.rankedResponses
  const rankSegments = Array.from({ length: RANK_FULL_WEIGHT_RESPONSES }, (_, i) => i < Math.min(ranked ?? 0, RANK_FULL_WEIGHT_RESPONSES))
  const unnamed = promptedSplit?.unnamed
  const conditions = card ? measureConditionText(card) : null

  /*
   * 개요 2차의 판정 기록 계산 — 결론 문장·엔진별 언급·이름 없는 질문 기준 자사 인용·대표 답변(lib/answerInsights).
   * 「이번 주 할 일」과 같은 판정 기록(todoData)을 쓴다. 기록을 못 읽으면 이 칸들만 빠지고 점수는 그대로 보인다.
   */
  const insights = useMemo(() => {
    if (!card || !todoData || todoData.key !== splitKey || !todoData.bank) return null
    const qs = todoData.bank.questions
    return {
      sentence: headlineSentence(todoData.analyses, qs, card.brandName),
      coverage: questionCoverage(todoData.analyses, qs),
      engines: engineMentions(todoData.analyses, qs),
      owned: unnamedOwnedCitation(todoData.analyses, qs),
      answers: pickAnswerHighlights(todoData.analyses, qs, card.brandName),
    }
  }, [card, todoData, splitKey])
  const peers = rankingView?.cohort.peers ?? []
  const engineLine = (() => {
    const e = insights?.engines ?? []
    if (e.length < 2) return null
    const top = e[0]!
    const bottom = e[e.length - 1]!
    if (top.mentioned === bottom.mentioned) return '엔진 사이 차이가 없습니다.'
    return `${top.label}에서 가장 자주, ${bottom.label}에서 가장 적게 불립니다 — 차이는 ${top.mentioned - bottom.mentioned}문항입니다.`
  })()

  return (
    <>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loading && !card && <p className="muted">불러오는 중…</p>}
      {!loading && !card && tenant && <h1 className="page-solo-title">개요</h1>}

      {tenant && history.length > 0 && <ChangeAlerts history={history} />}

      {tenant && card && (
        <>
          {/*
            맨 위 요약 — 결론 문장(코드 템플릿, lib/answerInsights)과 점수 링. 문장을 만들 수 없으면(주제 태그 없음 등)
            숫자 요약을 제목으로 둔다. 판정 알약·「가장 발목을 잡는 건」은 정기진단 보고서와 같은 판정이다.
          */}
          <section className="hero2" aria-label="이번 주 요약">
            <div className="hero2-text">
              <p className="hero2-eyebrow">
                <span className="hero2-dot" aria-hidden="true" />
                이번 주 AI 가시성 · {weekLabel(card.weekOf)} · {usedLabels.join(' · ') || '엔진 기록 없음'}
              </p>
              <h1 className="hero2-title">
                {insights?.sentence ?? `${card.brandName} · Brand AEO ${card.aeoScore.current}점 · ${cohortText}`}
              </h1>
              <p className="hero2-sub">
                {insights && insights.coverage.asked > 0
                  ? `이름 없이 물은 질문 ${insights.coverage.asked}개 중 ${insights.coverage.hit}개에서 불렸고, ${card.industry} · ${card.region} ${cohortText}입니다.`
                  : `${card.industry} · ${card.region} ${cohortText}입니다.`}
                {!prevCard && ' 측정 1주차라 추이는 다음 측정부터 쌓입니다.'}
              </p>
              {headline && (
                <p className="hero2-verdict">
                  <span className={`status-pill st-${headline.tone}`}>{headline.label}</span>
                  {headline.detail && <span>{headline.detail}</span>}
                </p>
              )}
            </div>
            <div className="hero2-score">
              <div
                className="score-ring"
                style={{ background: `conic-gradient(var(--accent) 0 ${card.aeoScore.current}%, var(--surface-2) ${card.aeoScore.current}% 100%)` }}
                aria-label={`Brand AEO Score ${card.aeoScore.current}점`}
              >
                <div className="score-ring-inner">
                  <span className="score-ring-num">{card.aeoScore.current}</span>
                  <span className="score-ring-label">Brand AEO</span>
                </div>
              </div>
              <dl className="hero2-facts">
                <div>
                  <dt>코호트 순위</dt>
                  <dd>
                    {(card.cohortRank.tiedCount ?? 1) > 1 ? '공동 ' : ''}
                    {card.cohortRank.position} <span className="dash-sub">/ {card.cohortRank.totalTenants}</span>
                  </dd>
                </div>
                {/*
                  측정 1주차에는 전주·신뢰구간을 감춘다 — "아직 비교할 게 없다"는 같은 말을 여러 번 하는 자리다.
                  2주차부터 저절로 나타난다(prevCard가 생긴다).
                */}
                {prevCard && (
                  <div>
                    <dt>전주 대비</dt>
                    <dd>
                      {delta ? (
                        <span className={`delta-chip ${delta.tone}`}>{delta.text}</span>
                      ) : (
                        <span className="dash-sub">{changedBy ? `${changedBy} 달라 비교 불가` : '—'}</span>
                      )}
                    </dd>
                  </div>
                )}
                {prevCard && (
                  <div>
                    <dt>95% 신뢰구간</dt>
                    <dd className="mono">
                      {card.aeoScore.ciLow} – {card.aeoScore.ciHigh}
                    </dd>
                  </div>
                )}
                <div>
                  <dt>Site AEO</dt>
                  <dd>
                    {siteNow ? (
                      <>
                        {siteNow.score}
                        {siteDelta !== null && siteDelta !== 0 && (
                          <span className={`delta-chip ${siteDelta > 0 ? 'up' : 'down'}`}>
                            {siteDelta > 0 ? '+' : ''}
                            {siteDelta}
                          </span>
                        )}
                      </>
                    ) : isElectron ? (
                      <Link to="/site-diagnosis" className="dash-link">
                        진단하기
                      </Link>
                    ) : (
                      <span className="dash-sub">—</span>
                    )}
                  </dd>
                </div>
              </dl>
            </div>
          </section>

          <section className="kpi-strip" aria-label="점수 지표">
            <article className="kpi">
              <div className="kpi-head">
                <span>언급률</span>
                <span className="kpi-tag">가중치 {WEIGHT_RATIO.mentionRate}</span>
              </div>
              <span className="kpi-value">{formatPct(card.mentionRate)}</span>
              <span className="dash-caption">
                {unnamed && unnamed.answered > 0
                  ? `이름 없는 질문 응답 ${unnamed.answered}건 중 ${Math.round(unnamed.rate * unnamed.answered)}건`
                  : '브랜드명을 넣지 않은 질문에서 언급된 비율'}
              </span>
            </article>
            <article className="kpi">
              <div className="kpi-head">
                <span>추천 순위</span>
                <span className="kpi-tag">가중치 {WEIGHT_RATIO.avgRecommendationRank}</span>
              </div>
              <span className="kpi-value">
                {formatRank(card.avgRecommendationRank)}
                {card.avgRecommendationRank !== null && <span className="comp-unit">위</span>}
              </span>
              <span className="rank-segs" aria-label={`순위 응답 ${RANK_FULL_WEIGHT_RESPONSES}건 중 ${Math.min(ranked ?? 0, RANK_FULL_WEIGHT_RESPONSES)}건 반영`}>
                {rankSegments.map((on, i) => (
                  <span key={i} className={on ? 'on' : undefined} />
                ))}
              </span>
              <span className="dash-caption">
                {ranked === undefined
                  ? '순위 응답 수 기록 없음'
                  : card.avgRecommendationRank === null || ranked === 0
                    ? '순위가 매겨진 응답 없음 · 점수에서 제외'
                    : ranked < RANK_FULL_WEIGHT_RESPONSES
                      ? `순위 응답 ${ranked}건 · 점수 비중 ${ranked}/${RANK_FULL_WEIGHT_RESPONSES}`
                      : `순위 응답 ${ranked}건 · 전체 비중`}
              </span>
            </article>
            <article className="kpi">
              <div className="kpi-head">
                <span>자사 인용률</span>
                <span className="kpi-tag">가중치 {WEIGHT_RATIO.brandOwnedCitationRate}</span>
              </div>
              <span className="kpi-value">{formatPct(card.brandOwnedCitationRate)}</span>
              <span className="dash-caption">
                {insights?.owned
                  ? `이름 없는 질문만 ${(insights.owned.rate * 100).toFixed(1)}% (${insights.owned.owned}/${insights.owned.total})`
                  : 'AI가 근거로 쓴 출처 중 우리 사이트'}
              </span>
            </article>
            <article className="kpi">
              <div className="kpi-head">
                <span>Share of Mention</span>
                <span className="kpi-tag muted-tag">점수 미포함</span>
              </div>
              <span className="kpi-value">{formatPct(card.shareOfMention)}</span>
              <span className="dash-caption">
                {shareOfMentionNote(card) ??
                  (card.shareOfMentionMentions !== undefined
                    ? `자사·경쟁사 언급 ${card.shareOfMentionMentions}번 기준`
                    : '같은 질문에서 경쟁 브랜드 대비 언급 점유')}
              </span>
            </article>
          </section>

          {/* 사실성은 점수 밖 지표라 평소엔 숨기고, 팩트 그래프와 어긋난 주장이 있을 때만 경고로 띄운다. */}
          {card.hallucinationFlags.length > 0 && (
            <details className="fact-warn">
              <summary>
                AI 답변 중 브랜드 사실과 어긋난 주장 {card.hallucinationFlags.length}건
                {card.factualityScore !== null && ` · 사실성 ${formatPct(card.factualityScore)}`}
              </summary>
              <ul>
                {card.hallucinationFlags.map((flag) => (
                  <li key={flag}>{flag}</li>
                ))}
              </ul>
            </details>
          )}

          {history.length >= 2 && (
            <section className="dash-row" aria-label="추이">
              <article className="dash-card trend-card">
                <div className="dash-card-head">
                  <h2>
                    {trend.length}주 추이 <span className="dash-sub">· 세로축 0–{trendTop}점</span>
                  </h2>
                  <Link to="/performance" className="dash-link">
                    AEO 퍼포먼스
                  </Link>
                </div>
                <div className="trend-bars">
                  {trend.map(({ card: h, changed }) => {
                    const current = h.weekOf === card.weekOf
                    return (
                      <div key={h.weekOf} className={`trend-col${current ? ' current' : ''}`}>
                        <span className="trend-value">{h.aeoScore.current}</span>
                        <span className="trend-bar" style={{ height: `${Math.max(2, Math.round((h.aeoScore.current / trendTop) * 120))}px` }} />
                        <span className="trend-week">{h.weekOf.replace(/^\d{4}-/, '')}</span>
                        <span className={`trend-mark${changed ? ' on' : ''}`} title={changed ? `직전 주와 ${changed}이(가) 다름` : undefined} />
                      </div>
                    )
                  })}
                </div>
                {trend.some((t) => t.changed) && (
                  <p className="dash-caption trend-legend">
                    <span className="trend-mark on" aria-hidden="true" />
                    측정 조건이 바뀐 주 — 직전 주와 바로 비교하지 않습니다
                  </p>
                )}
              </article>
            </section>
          )}

          <section className="dash-row" aria-label="엔진과 경쟁">
            <article className="dash-card engine-card">
              <div className="dash-card-head">
                <h2>엔진별 언급</h2>
                {insights && insights.engines.length > 0 && (
                  <span className="dash-sub">
                    이름 없는 질문 {insights.engines[0]!.total}개 · 엔진마다
                  </span>
                )}
              </div>
              {insights && insights.engines.length > 0 ? (
                <>
                  <ul className="engine-bars">
                    {insights.engines.map((e) => (
                      <li key={e.engine}>
                        <div className="engine-bar-head">
                          <span className="engine-chip plain">
                            <span className="engine-dot" data-engine={e.engine} aria-hidden="true" />
                            {e.label}
                          </span>
                          <span className="mono">
                            <b>{(e.rate * 100).toFixed(1)}%</b> <span className="dash-sub">· {e.mentioned}/{e.total}</span>
                          </span>
                        </div>
                        <span className="engine-bar">
                          <span data-engine={e.engine} style={{ width: `${Math.max(1, e.rate * 100)}%` }} />
                        </span>
                      </li>
                    ))}
                  </ul>
                  {engineLine && <p className="dash-caption">{engineLine}</p>}
                </>
              ) : (
                <p className="dash-caption">질문별 판정을 불러오는 중…</p>
              )}
            </article>
            <article className="dash-card map-card">
              <div className="dash-card-head">
                <h2>
                  경쟁 포지션 <span className="dash-sub">· {card.industry} · {card.region}</span>
                </h2>
                <Link to="/ranking" className="dash-link">
                  경쟁 순위
                </Link>
              </div>
              {peers.length > 1 ? (
                <>
                  <PositionMap peers={peers} selfId={card.tenantId} />
                  <p className="dash-caption">원 크기 = Brand AEO Score</p>
                </>
              ) : (
                <p className="dash-caption">{cohortText} · 비교할 코호트 측정이 아직 없습니다</p>
              )}
            </article>
          </section>

          {insights && insights.answers.length > 0 && (
            <section className="answers-sec" aria-label="AI 답변">
              <div className="dash-card-head">
                <h2 className="sec-title">AI는 이렇게 답했습니다</h2>
                <Link to="/answers" className="dash-link">
                  모든 답변 보기 →
                </Link>
              </div>
              <div className="dash-row">
                {insights.answers.map((a) => (
                  <AnswerCard
                    key={`${a.questionId}-${a.engine}`}
                    answer={a}
                    brandName={card.brandName}
                    to={`/answers?q=${encodeURIComponent(a.questionId)}&week=${encodeURIComponent(card.weekOf)}`}
                  />
                ))}
              </div>
            </section>
          )}

          <section className="dash-card todo-card" aria-label="놓친 질문">
            <div className="dash-card-head">
              <h2>
                놓친 질문 <span className="dash-sub">· {card.brandName} 대신 불린 곳</span>
              </h2>
              {openActions !== null && openActions > 0 && <span className="dash-sub">남은 실행 항목 {openActions}건</span>}
            </div>
            {todo ? (
              <>
                <p className="dash-caption">{todo.heading}</p>
                <ul className="todo-list">
                  {todo.items.slice(0, TODO_SHOW).map((item) => (
                    <li key={item.text}>
                      <div className="todo-text">
                        {item.questionId ? (
                          <Link
                            to={`/answers?q=${encodeURIComponent(item.questionId)}&week=${encodeURIComponent(card.weekOf)}`}
                            className="todo-link"
                          >
                            {item.text}
                          </Link>
                        ) : (
                          <span>{item.text}</span>
                        )}
                        {item.detail && <span className="dash-caption">{item.detail}</span>}
                      </div>
                      <Link to="/gap-actions" state={{ from: 'dashboard', label: '놓친 질문' }} className="btn soft">
                        이 질문으로 글 만들기
                      </Link>
                    </li>
                  ))}
                </ul>
                {todo.items.length + (todo.more ?? 0) > TODO_SHOW && (
                  <Link to="/gap-actions" className="dash-link">
                    밀린 질문 {todo.items.length + (todo.more ?? 0)}개 모두 보기
                  </Link>
                )}
              </>
            ) : (
              <p className="dash-caption">
                {todoData && todoData.key === splitKey ? '이번 주 밀린 일반 질문이 없습니다.' : '질문별 판정을 불러오는 중…'}
              </p>
            )}
          </section>

          {promptedSplit && promptedSplit.named.answered > 0 && (
            <section className="dash-card split-card">
              <div className="dash-card-head">
                <h2>이름을 대면 / 안 대면</h2>
              </div>
              <p className="dash-caption">
                브랜드명을 넣은 질문에서 나오는 것은 성과가 아닙니다 — 엔진은 이름을 받으면 거의 항상 답합니다.
                점수가 쓰는 값은 <b>이름을 안 댔을 때</b>이고, 두 값의 차이가 곧 <b>아직 우리를 모르는 고객이 우리를
                만나지 못하는 폭</b>입니다. 되물은 응답은 분모에서 빠집니다.
              </p>
              <div className="funnel">
                <div className="funnel-step" title="브랜드명이 들어간 질문(브랜드 직접·비교 등)에서 언급된 비율">
                  <span className="funnel-label">이름을 대고 물으면</span>
                  <span className="funnel-rate">{formatPct(promptedSplit.named.rate)}</span>
                  <span className="funnel-bar">
                    <span style={{ width: `${Math.round(promptedSplit.named.rate * 100)}%` }} />
                  </span>
                  <span className="funnel-meta">응답 {promptedSplit.named.answered}건</span>
                </div>
                <div className="funnel-step is-on" title="브랜드명이 없는 질문(카테고리 무관)에서 언급된 비율 — 점수가 쓰는 값">
                  <span className="funnel-label">이름 없이 물으면 · 점수 기준</span>
                  <span className="funnel-rate">{formatPct(promptedSplit.unnamed.rate)}</span>
                  <span className="funnel-bar">
                    <span style={{ width: `${Math.round(promptedSplit.unnamed.rate * 100)}%` }} />
                  </span>
                  <span className="funnel-meta">응답 {promptedSplit.unnamed.answered}건</span>
                </div>
              </div>
            </section>
          )}
        </>
      )}

      {/*
        사이드바와 같은 순서·같은 말로 묶은 안내 — 처음 쓰는 사람을 위한 것이라 매일 보는 화면에선 접어 둔다.
      */}
      <details className="dash-guide">
        <summary>이 브랜드를 보는 순서 — 진단 → 실행 → 보고·측정</summary>
        <div className="pipeline-grid">
          <article>
            <p className="pipeline-stage">진단</p>
            <h2>밀리는 질문·엔진·경쟁사</h2>
            <p>{card ? `카테고리 무관 언급률 ${formatPct(card.mentionRate)}` : '측정 후 채워집니다'}</p>
            <Link to="/question-winloss">질문별 승패 →</Link>
          </article>
          <article>
            <p className="pipeline-stage">실행</p>
            <h2>격차를 할 일로</h2>
            <p>
              {openActions === null
                ? '측정 후 채워집니다'
                : openActions === 0
                  ? '남은 실행 항목 없음'
                  : `남은 실행 항목 ${openActions}건`}
            </p>
            <Link to="/gap-actions">콘텐츠 생성 →</Link>
          </article>
          <article>
            <p className="pipeline-stage">보고</p>
            <h2>점수와 코호트 순위</h2>
            <p>{card ? `Brand AEO Score ${card.aeoScore.current} · ${cohortText}` : '측정 후 채워집니다'}</p>
            <Link to="/report">정기진단 보고서 →</Link>
          </article>
          <article>
            <p className="pipeline-stage">측정</p>
            <h2>같은 질문을 엔진마다 묻는다</h2>
            <p>{card ? `${weekLabel(card.weekOf)} · ${usedLabels.join(' · ') || '엔진 기록 없음'}` : '아직 측정한 주차가 없습니다'}</p>
            <Link to="/measure-tenant">브랜드·경쟁사 측정 →</Link>
          </article>
        </div>
      </details>

      <p className="dash-foot">
        {card && conditions ? (
          <>
            {weekLabel(card.weekOf)} 측정 · 수집 {conditions.collect} · 판정 {conditions.judge} · 질문{' '}
            {tenant?.questionBankSize ?? '—'}개{card.questionBankVersion ? ` (질문지 ${card.questionBankVersion})` : ''} ·{' '}
            {conditions.repeats}.
          </>
        ) : (
          <>현재 점수는 {usedLabels.join(' · ') || '설정된 엔진'} 엔진으로 측정합니다.</>
        )}
        {excludedLabels.length > 0 && ` ${excludedLabels.join('·')}는 포함하지 않았습니다.`} 실제 인용·노출을 보장하지
        않습니다.
      </p>
    </>
  )
}
