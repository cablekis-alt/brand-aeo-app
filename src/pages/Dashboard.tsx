import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import ChangeAlerts from '../components/ChangeAlerts'
import { useTenant } from '../context/useTenant'
import { ENGINE_LABEL, formatDelta, formatPct, formatRank, measureConditionText, weekLabel } from '../lib/format'
import { loadQuestionAnalyses, loadQuestionBank, loadRanking, loadSiteScores, type SiteScoreRecord } from '../lib/api'
import { buildPeriodicReport, type MetricStatus } from '../lib/b9-report'
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
  const { tenant, tenants } = useTenant()
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

  // 코호트 순위표 — 카드에 저장된 구성원 점수로 매긴다(서버의 computeCohortRank와 같은 경쟁 순위:
  // 동점은 같은 번호). 전주 점수는 전주 카드의 구성원 기록에서 같은 브랜드를 찾는다.
  const cohortRows = (() => {
    const members = card?.cohortRank.members
    if (!card || !members || members.length === 0) return []
    const prevOf = new Map((prevCard?.cohortRank.members ?? []).map((m) => [m.tenantId, m.aeoScore]))
    const peerNames = new Map((rankingView?.cohort.peers ?? []).map((p) => [p.tenantId, p.brandName]))
    const nameOf = (id: string) => peerNames.get(id) ?? tenants.find((t) => t.tenantId === id)?.brandName ?? id
    const scores = members.map((m) => m.aeoScore)
    return [...members]
      .sort((a, b) => b.aeoScore - a.aeoScore || nameOf(a.tenantId).localeCompare(nameOf(b.tenantId), 'ko'))
      .map((m) => {
        const position = scores.filter((s) => s > m.aeoScore).length + 1
        const tied = scores.filter((s) => s === m.aeoScore).length > 1
        return {
          tenantId: m.tenantId,
          name: nameOf(m.tenantId),
          score: m.aeoScore,
          rank: `${tied ? '공동 ' : ''}${position}`,
          prev: prevOf.get(m.tenantId) ?? null,
          self: m.tenantId === card.tenantId,
        }
      })
  })()

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

  return (
    <>
      <header className="page-head">
        <div className="page-title">
          {tenant && (
            <p className="page-eyebrow">
              {tenant.brandName} · {tenant.industry} · {tenant.region}
            </p>
          )}
          <h1>대시보드</h1>
        </div>
        <div className="page-actions">
          <Link to="/report" className="btn">
            정기진단 보고서
          </Link>
          <Link to="/measure-tenant" className="btn primary">
            측정 실행
          </Link>
        </div>
      </header>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loading && !card && <p className="muted">불러오는 중…</p>}

      {tenant && history.length > 0 && <ChangeAlerts history={history} />}

      {tenant && card && (
        <>
          {headline && (
            <section className={`headline st-${headline.tone}`} aria-label="이번 주 한 줄">
              <p className="headline-verdict">
                <span className={`status-pill st-${headline.tone}`}>{headline.label}</span>
                <b>
                  {weekLabel(card.weekOf)} · {card.aeoScore.current}점 · {cohortText}
                </b>
              </p>
              {headline.detail && <p className="headline-detail">{headline.detail}</p>}
            </section>
          )}

          <section className="dash-row" aria-label="핵심 지표">
            <article className="dash-card score-card">
              <div className="dash-card-head">
                <h2>Brand AEO Score</h2>
                <span className="chip good">{cohortText}</span>
              </div>
              <p className="score-big">
                <span className="score-num">{card.aeoScore.current}</span>
                <span className="score-max">/ 100</span>
                {delta && <span className={`delta-chip ${delta.tone}`}>{delta.text}</span>}
              </p>
              {/*
                측정 1주차에는 전주·4주 이동평균·신뢰구간을 감춘다.
                셋 다 "아직 비교할 게 없다"는 같은 말을 세 번 하는 자리다 — 전주는 "—",
                이동평균은 이번 주 점수 그 자체, 신뢰구간은 표본이 하나라 넓다. 게다가 위
                변화 알림 배너가 이미 「기준선 형성 중(측정 1주차)」이라고 말하고 있다.
                2주차부터 저절로 다시 나타난다(prevCard가 생긴다).
              */}
              {prevCard ? (
                <div className="ci-band" aria-label={`95% 신뢰구간 ${card.aeoScore.ciLow}에서 ${card.aeoScore.ciHigh}`}>
                  <div className="ci-track">
                    <span
                      className="ci-range"
                      style={{ left: `${card.aeoScore.ciLow}%`, width: `${Math.max(1, card.aeoScore.ciHigh - card.aeoScore.ciLow)}%` }}
                    />
                    <span className="ci-mark" style={{ left: `${card.aeoScore.current}%` }} />
                  </div>
                  <p className="dash-caption">
                    95% 신뢰구간 {card.aeoScore.ciLow} – {card.aeoScore.ciHigh} · 전주 {prevScore ?? '—'}
                    {changedBy && ` (${changedBy} 달라 비교 불가)`} · 4주 평균 {card.aeoScore.ma4}
                  </p>
                </div>
              ) : (
                <p className="dash-caption">측정 1주차 — 비교 기준을 쌓는 중입니다</p>
              )}
            </article>

            <article className="dash-card comp-card">
              <div className="dash-card-head">
                <h2>
                  점수 구성{' '}
                  <span className="dash-sub">
                    · 가중치 {WEIGHT_RATIO.mentionRate} : {WEIGHT_RATIO.brandOwnedCitationRate} : {WEIGHT_RATIO.avgRecommendationRank}
                  </span>
                </h2>
              </div>
              <div className="comp-tiles">
                <div className="comp-tile">
                  <span className="comp-label">
                    언급률 <span className="dash-sub">· {WEIGHT_RATIO.mentionRate}</span>
                  </span>
                  <span className="comp-value">{formatPct(card.mentionRate)}</span>
                  <span className="comp-bar">
                    <span style={{ width: `${Math.round(card.mentionRate * 100)}%` }} />
                  </span>
                  <span className="dash-caption">
                    {unnamed && unnamed.answered > 0
                      ? `이름 없는 질문 응답 ${unnamed.answered}건 중 ${Math.round(unnamed.rate * unnamed.answered)}건`
                      : '브랜드명을 넣지 않은 질문에서 언급된 비율'}
                  </span>
                </div>
                <div className="comp-tile">
                  <span className="comp-label">
                    자사 인용률 <span className="dash-sub">· {WEIGHT_RATIO.brandOwnedCitationRate}</span>
                  </span>
                  <span className="comp-value">{formatPct(card.brandOwnedCitationRate)}</span>
                  <span className="comp-bar">
                    <span style={{ width: `${Math.round(card.brandOwnedCitationRate * 100)}%` }} />
                  </span>
                  <span className="dash-caption">AI가 근거로 쓴 출처 중 우리 사이트</span>
                </div>
                <div className="comp-tile">
                  <span className="comp-label">
                    추천 순위 <span className="dash-sub">· {WEIGHT_RATIO.avgRecommendationRank}</span>
                  </span>
                  <span className="comp-value">
                    {formatRank(card.avgRecommendationRank)}
                    {card.avgRecommendationRank !== null && <span className="comp-unit">위</span>}
                  </span>
                  <span
                    className="rank-segs"
                    aria-label={`순위 응답 ${RANK_FULL_WEIGHT_RESPONSES}건 중 ${Math.min(ranked ?? 0, RANK_FULL_WEIGHT_RESPONSES)}건 반영`}
                  >
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
                </div>
              </div>
            </article>
          </section>

          <section className="dash-row" aria-label="추이와 경쟁">
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
                      <span
                        className={`trend-mark${changed ? ' on' : ''}`}
                        title={changed ? `직전 주와 ${changed}이(가) 다름` : undefined}
                      />
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

            <article className="dash-card cohort-card">
              <div className="dash-card-head">
                <h2>
                  코호트 순위{' '}
                  <span className="dash-sub">
                    · {card.industry} · {card.region}
                  </span>
                </h2>
                <Link to="/ranking" className="dash-link">
                  경쟁 순위
                </Link>
              </div>
              {cohortRows.length > 0 ? (
                <div className="table-scroll">
                  <table className="cohort-table">
                    <thead>
                      <tr>
                        <th scope="col">순위</th>
                        <th scope="col">브랜드</th>
                        <th scope="col">점수</th>
                        <th scope="col" className="num">
                          전주
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {cohortRows.map((r) => (
                        <tr key={r.tenantId} className={r.self ? 'self' : undefined}>
                          <td className="rank">{r.rank}</td>
                          <td className="name">{r.name}</td>
                          <td>
                            <span className="cohort-score">
                              <span className="cohort-bar">
                                <span style={{ width: `${Math.max(1, r.score)}%` }} />
                              </span>
                              <b>{r.score}</b>
                            </span>
                          </td>
                          <td className="num">{r.prev ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="dash-caption">{cohortText} · 구성원 점수 기록이 없는 옛 측정입니다</p>
              )}
            </article>
          </section>

          <section className="dash-row" aria-label="이번 주 할 일과 진단 지표">
            <article className="dash-card todo-card">
              <div className="dash-card-head">
                <h2>
                  이번 주 할 일 <span className="dash-sub">· 다른 곳이 대신 불린 질문</span>
                </h2>
                {openActions !== null && openActions > 0 && <span className="dash-sub">남은 실행 항목 {openActions}건</span>}
              </div>
              {todo ? (
                <>
                  <ul className="todo-list">
                    {todo.items.slice(0, TODO_SHOW).map((item) => (
                      <li key={item.text}>
                        <div className="todo-text">
                          <span>{item.text}</span>
                          {item.detail && <span className="dash-caption">{item.detail}</span>}
                        </div>
                        <Link to="/gap-actions" className="btn soft">
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
            </article>

            <article className="dash-card diag-card">
              <div className="dash-card-head">
                <h2>
                  진단 지표 <span className="dash-sub">· 점수 미포함</span>
                </h2>
              </div>
              <dl className="diag-list">
                <div>
                  <dt>Share of Mention</dt>
                  <dd>{formatPct(card.shareOfMention)}</dd>
                  <p className="dash-caption">
                    {shareOfMentionNote(card) ?? '같은 질문(브랜드명 미포함)에서 경쟁 브랜드 대비 언급 점유'}
                  </p>
                </div>
                <div>
                  <dt>사실성</dt>
                  <dd>{formatPct(card.factualityScore)}</dd>
                  {card.hallucinationFlags.length > 0 ? (
                    <details className="diag-flags">
                      <summary>사실 불일치 {card.hallucinationFlags.length}건</summary>
                      <ul>
                        {card.hallucinationFlags.map((flag) => (
                          <li key={flag}>{flag}</li>
                        ))}
                      </ul>
                    </details>
                  ) : (
                    <p className="dash-caption">
                      {card.factualityScore === null ? '팩트 그래프가 없으면 판정 불가' : '팩트 그래프와 모순되지 않은 주장 비율'}
                    </p>
                  )}
                </div>
                <div>
                  <dt>Site AEO</dt>
                  <dd>
                    {siteNow ? siteNow.score : '—'}
                    {siteDelta !== null && siteDelta !== 0 && (
                      <span className={`delta-chip ${siteDelta > 0 ? 'up' : 'down'}`}>
                        {siteDelta > 0 ? '+' : ''}
                        {siteDelta}
                      </span>
                    )}
                  </dd>
                  <p className="dash-caption">
                    {siteNow ? (
                      <>
                        페이지가 인용될 준비가 됐는가
                        {siteNow.weekOf !== card.weekOf && ` · ${weekLabel(siteNow.weekOf)} 진단`}
                      </>
                    ) : isElectron ? (
                      <>
                        <Link to="/site-diagnosis">Site AEO Checker</Link>에서 진단하면 채워집니다
                      </>
                    ) : (
                      '데스크톱 앱에서 진단·기록합니다'
                    )}
                  </p>
                </div>
              </dl>
            </article>
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
              <p className="dash-caption">
                어느 질문에서 밀리는지는 <Link to="/gap-analysis">가시성 격차 분석</Link>, 어느 여정 단계에서 안
                보이는지는 <Link to="/diagnosis">브랜드 종합 진단</Link>에서 봅니다.
              </p>
            </section>
          )}
        </>
      )}

      {/*
        사이드바와 같은 순서·같은 말로 묶은 안내 — 측정 → 진단 → 실행 → 보고. 처음 쓰는 사람을 위한 것이라
        매일 보는 화면에선 접어 둔다(상용화 UI 3단계에서 맨 위에서 맨 아래로 옮겼다).
      */}
      <details className="dash-guide">
        <summary>이 브랜드를 보는 순서 — 측정 → 진단 → 실행 → 보고</summary>
        <div className="pipeline-grid">
          <article>
            <p className="pipeline-stage">측정</p>
            <h2>같은 질문을 엔진마다 묻는다</h2>
            <p>
              {card ? `${weekLabel(card.weekOf)} · ${usedLabels.join(' · ') || '엔진 기록 없음'}` : '아직 측정한 주차가 없습니다'}
            </p>
            <Link to="/measure-tenant">브랜드·경쟁사 측정 →</Link>
          </article>
          <article>
            <p className="pipeline-stage">진단</p>
            <h2>밀리는 질문 유형·엔진·경쟁사</h2>
            <p>{card ? `카테고리 무관 언급률 ${formatPct(card.mentionRate)}` : '측정 후 채워집니다'}</p>
            <Link to="/gap-analysis">가시성 격차 분석 →</Link>
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
