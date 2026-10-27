import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import AnswerCard from '../components/AnswerCard'
import ChangeAlerts from '../components/ChangeAlerts'
import PositionMap from '../components/PositionMap'
import { useTenant } from '../context/useTenant'
import { ENGINE_LABEL, formatDelta, formatPct, formatRank, measureConditionText, weekLabel } from '../lib/format'
import { subjectParticle, withParticle } from '../lib/korean'
import { sameCohort } from '../lib/portfolioView'
import { loadQuestionAnalyses, loadQuestionBank, loadRanking, loadSiteScores, type SiteScoreRecord } from '../lib/api'
import { buildPeriodicReport, sameConditionAverage, scoreBreakdown, weightTagText, type MetricStatus, type ScorePartKey } from '../lib/b9-report'
import { contradictedLine, factFlagSummary, type AlertContext } from '../lib/alerts'
import { selfReview } from '../lib/reviewReport'
import { engineMentions, headlineSentence, pickAnswerHighlights, questionCoverage, unnamedOwnedCitation } from '../lib/answerInsights'
import { comparableRun, compareConditions, conditionSummary, siteComparable, siteDifference, weeksBetween } from '../lib/comparability'
import { buildRecommendationEvidence, type EvidenceBlock } from '../lib/recommendationEvidence'
import { recentRuns, scoreExplainData } from '../lib/reportExplain'
import { RANK_FULL_WEIGHT_RESPONSES, shareOfMentionNote, type WeeklyScorecard } from '../prompts/b8-report'
import type { QuestionBank, QuestionRepeatAnalysis, RankingView } from '../lib/types'
import { useScorecards } from '../lib/useScorecards'
import { useRunHistory } from '../lib/useRunHistory'
import { kstStamp } from '../lib/runTrend'
import { isOpenAction } from '../lib/gapActions'
import { useGapActionPlan } from '../lib/useGapActionPlan'

/** 5주 추이에 보이는 주 수. */
const TREND_WEEKS = 5
/** 「이번 주 할 일」에 펼쳐 두는 질문 수 — 나머지는 콘텐츠 생성 화면에서 본다. */
const TODO_SHOW = 3


export default function Dashboard() {
  const { tenant, customer, viewing } = useTenant()
  // Site AEO Score의 주차 기록은 로컬 서버에만 있다(Vercel에는 이 라우트가 없다).
  // 웹에서 "진단하면 쌓입니다"라고 안내하면 지키지 못할 약속이 된다.
  const isElectron = typeof window !== 'undefined' && Boolean(window.electron?.isElectron)
  const { history, loading, error } = useScorecards(tenant?.tenantId ?? '')
  const card = history.at(-1) ?? null
  /*
   * 이번 주에 여러 번 쟀으면 — 점수는 그 주 카드 회차 하나다(평균이 아니다). 회차 기록은 데스크톱 전용이라 웹에서는 비어 있다.
   * 최근 12주를 받는다 — 「같은 조건 평균」이 정기진단 보고서 표지와 같은 회차 창(recentRuns)으로 센다.
   */
  const runHistory = useRunHistory(viewing ? '' : (tenant?.tenantId ?? ''), 12)
  const cardAt = useMemo(() => {
    const point = (runHistory.history?.points ?? []).find((p) => card && p.weekOf === card.weekOf && p.isWeekCard)
    return point?.at ? kstStamp(point.at) : null
  }, [runHistory.history, card])
  const weekRuns = useMemo(() => {
    const points = (runHistory.history?.points ?? []).filter((p) => card && p.weekOf === card.weekOf)
    if (points.length < 2) return null
    return {
      count: points.length,
      scores: points.map((p) => (p.score === null ? '?' : String(p.score))),
    }
  }, [runHistory.history, card])
  /*
   * 같은 조건 평균 — 보고서 표지와 같은 값 · 같은 말(sameConditionAverage). 회차 기록을 다 읽은 뒤에만 보인다 — 먼저 주 카드 평균을 그렸다가
   * 회차 평균으로 바뀌면 한 화면에서 숫자가 둘이 된다. 경쟁사 보기는 회차 기록을 읽지 않는다(주 카드 평균).
   */
  const sameAvg = useMemo(() => {
    if (!card || (!viewing && runHistory.loading)) return null
    const recent = recentRuns(runHistory.history, card.weekOf)
    return sameConditionAverage(history, card.weekOf, recent ? { average: recent.average, count: recent.runs.length } : null)
  }, [card, history, viewing, runHistory.loading, runHistory.history])

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
  /*
   * 이번 주 「틀림」 주장(질문 · 엔진 · AI 값 · 등록 값) — 변화 알림과 사실성 경고가 기록 줄(openai / v5-006 #1) 대신 무엇이 어긋났는지
   * 쓴다(상용화 UI 3차 U23). 정기진단 보고서의 원문 목록과 같은 함수다. 판정 기록 · 질문지를 못 읽으면 null.
   */
  const selfCheck = useMemo(
    () => (todoData && todoData.key === splitKey ? selfReview(todoData.analyses, todoData.bank) : null),
    [todoData, splitKey],
  )
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
  // 같은 페이지(주소)를 같은 방식으로 잰 진단끼리만 증감을 낸다 — 정기진단 보고서와 같은 규칙(siteComparable).
  // 실측 ktcorp: corp.kt.com 57점 → www.kt.com 0점이 「-57」로 찍혔다(다른 페이지를 잰 것이다).
  const siteDiff = siteNow && sitePrev ? siteDifference(sitePrev, siteNow) : null
  const siteDelta = siteNow && sitePrev && siteComparable(sitePrev, siteNow) ? siteNow.score - sitePrev.score : null

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
        // 「충분하니」라고 단정하지 않는다 — 두 점수는 다른 것을 재므로 상대 비교만 말한다(62점 사이트를 「충분」이라 부른 일이 있었다).
        detail.push(`페이지 준비도(${siteNow.score})가 답변 노출 점수보다 훨씬 높습니다 — 지금 막는 것은 페이지보다 권위·인용일 가능성이 큽니다.`)
      } else if (gap <= -20) {
        detail.push(`답변 노출에 비해 페이지 준비도(${siteNow.score})가 뒤처집니다 — 페이지를 먼저 고치면 지금의 노출이 더 단단해집니다.`)
      }
    }
    return { tone: report.verdict.tone, label: report.verdict.label, detail: detail.join(' ') }
  })()

  // 브랜드·주차가 바뀌는 순간 옛 값이 새 카드에 붙지 않게 키를 맞춘다.
  const rankingView = ranking.key === splitKey ? ranking.value : null
  // 변화 알림이 사람 말로 쓰는 데 필요한 것 — 이번 주 「틀림」 주장과 비교 그룹 구성원 이름(비교용 브랜드는 브랜드 목록에 없어 랭킹 응답에서).
  const alertContext = useMemo(
    (): AlertContext => ({
      ...(selfCheck ? { contradicted: selfCheck.contradicted } : {}),
      nameOf: (id: string) => rankingView?.cohort.peers.find((p) => p.tenantId === id)?.brandName,
    }),
    [selfCheck, rankingView],
  )
  // 항목별 이번 주 실제 비중 — 순위 응답이 적으면 순위 몫이 줄고 나머지가 커진다(정기진단 보고서 · 진단 화면과 같은 값).
  const parts = card ? new Map(scoreBreakdown(card).map((p) => [p.key, p])) : null
  /*
   * 「이번 주 N점은 어디서 나왔나」 — 정기진단 보고서 「점수 풀이」와 같은 계산(scoreExplainData). 구성은 카드만으로 나오고, 몰림 · 계단은
   * 판정 기록을 읽어 카드와 같은 측정일 때만 나온다(못 읽으면 그 칸만 빠진다).
   */
  const explain = useMemo(() => {
    if (!card) return null
    const ready = todoData && todoData.key === splitKey
    return scoreExplainData({ card, analyses: ready ? todoData.analyses : [], bank: ready ? todoData.bank : null })
  }, [card, todoData, splitKey])
  const stepTop = explain?.steps ? Math.max(10, Math.ceil(Math.max(...explain.steps.map((s) => s.score)) / 10) * 10) : 10
  // 1위 답 한 건이 오갈 때 점수가 움직이는 폭 — 계단 칸 사이 차이.
  const stepMove = (() => {
    const s = explain?.steps ?? []
    const gaps = s.slice(1).map((x, i) => Math.abs(x.score - s[i]!.score)).filter((d) => d > 0)
    if (gaps.length === 0) return null
    const lo = Math.min(...gaps)
    const hi = Math.max(...gaps)
    return lo === hi ? `${lo}` : `${lo}–${hi}`
  })()
  const weightTitle = (key: ScorePartKey) => {
    const part = parts?.get(key)
    return part && part.weight > 0 ? `기본 가중치 ${Math.round(part.baseWeight * 100)}% · 이번 주 실제 비중 ${Math.round(part.weight * 100)}%` : undefined
  }
  const promptedSplit = rankingView?.promptedSplit ?? null
  // 전주는 저장된 previousWeek가 아니라 히스토리에서 읽는다. 저장값은 측정 시점에 박제되어,
  // 지난 주를 다시 재면 어긋난다(실측: W37 카드 33 vs 알림 42 — 같은 화면이 +2와 -7을 동시에
  // 말했다). 알림도 히스토리를 쓰므로 이제 두 자리가 같은 값을 본다.
  const prevCard = history.length > 1 ? history[history.length - 2]! : null
  const prevScore = prevCard?.aeoScore.current ?? null
  /*
   * 증감을 내도 되는지는 앱 공용 규칙 하나(compareConditions, lib/comparability)가 정한다 — 위 변화 알림 · 아래 5주 추이 표식 ·
   * 정기진단 보고서와 같은 판정이다. 여섯 조건(수집 · 판정 엔진, 수집 · 판정 모델, 질문지, 반복 횟수) 중 바뀐 것이 있거나
   * 한쪽에만 기록이 있어 확인할 수 없으면 증감을 숫자로 내세우지 않고 이유를 적는다. 헤드라인이 빨간 -7인데 바로 위 알림이
   * "비교할 수 없다"고 하면 화면이 자기모순이다. 기록이 없는 조건은 「달라」가 아니라 「기록이 없어」로 적는다(바뀐 조건이 먼저 온다).
   */
  const prevDiffs = prevCard && card ? compareConditions(prevCard, card) : []
  const firstDiff = prevDiffs[0] ?? null
  const delta = card && prevScore !== null && !firstDiff ? formatDelta(card.aeoScore.current, prevScore) : null
  const notComparableText = firstDiff
    ? firstDiff.state === 'changed'
      ? `${firstDiff.dimension} 달라 비교 불가`
      : `${firstDiff.dimension} 기록이 없어 비교 불가`
    : null
  // 앞 측정이 2주 이상 떨어져 있으면(사이에 재지 않은 주가 있으면) 「전주」라고 하지 않는다 — 정기진단 보고서와 같은 말.
  const prevGap = prevCard && card ? weeksBetween(prevCard.weekOf, card.weekOf) : null
  const deltaLabel = prevCard && (prevGap ?? 1) >= 2 ? `직전 측정(${prevCard.weekOf.replace(/^\d{4}-/, '')}) 대비` : '전주 대비'

  // 5주 추이 — 세로축 위끝은 보이는 주의 최고점을 10 단위로 올린 값(최소 20). 0~100 그대로 그리면
  // 한 자릿수·10점대 브랜드는 막대가 바닥에 붙어 추이가 안 보인다. 축 범위는 화면에 함께 적는다.
  // 직전 측정과 측정 조건이 바뀌었거나 확인할 수 없는(한쪽에만 기록) 주에는 표식을 단다 — 위 칩과 같은 규칙.
  // 화면에 보이는 첫 주도 그 앞 측정과 비교한다.
  const trendWeeks = history.slice(-TREND_WEEKS)
  const trendTop = Math.max(20, Math.ceil(Math.max(0, ...trendWeeks.map((h) => h.aeoScore.current)) / 10) * 10)
  const trend = trendWeeks.map((h, i, list) => {
    const before = i > 0 ? list[i - 1] : history[history.length - list.length - 1]
    return { card: h, diffs: before ? compareConditions(before, h) : [] }
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
  const unnamed = promptedSplit?.unnamed
  const conditions = card ? measureConditionText(card) : null
  // 5주 추이 — 이번 주와 같은 조건으로 잰 구간의 첫 주. 그 앞 주는 빈 막대로 그려 잇지 않는다(보고서 「견주는 구간」과 같은 규칙).
  const runStart = card ? (comparableRun(history, card.weekOf)[0]?.weekOf ?? null) : null
  const hasPrior = runStart !== null && trendWeeks.length > 0 && trendWeeks[0]!.weekOf < runStart

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

  /*
   * 지표 표 — 값 · 근거 · 점수 비중(기본 → 이번 주) · 점수 기여. 기여는 「점수가 어디서 나왔나」 구성과 같은 몫(합이 점수와 같다).
   * 언급 점유율은 점수 밖 참고 지표다.
   */
  const metricRows: { key: ScorePartKey | 'shareOfMention'; label: string; value: string; unit?: string; isText: boolean; basis: string }[] = card
    ? [
        {
          key: 'mentionRate',
          label: '언급률',
          value: formatPct(card.mentionRate),
          isText: false,
          basis:
            unnamed && unnamed.answered > 0
              ? `이름 없는 질문 응답 ${unnamed.answered}건 중 ${Math.round(unnamed.rate * unnamed.answered)}건`
              : '브랜드명을 넣지 않은 질문에서 언급된 비율',
        },
        {
          key: 'avgRecommendationRank',
          label: '평균 추천 순위',
          value: formatRank(card.avgRecommendationRank),
          ...(card.avgRecommendationRank !== null ? { unit: '위' } : {}),
          isText: card.avgRecommendationRank === null,
          basis:
            ranked === undefined
              ? '순위 응답 수 기록 없음'
              : card.avgRecommendationRank === null || ranked === 0
                ? '순위가 매겨진 답 없음 · 점수에서 제외'
                : ranked < RANK_FULL_WEIGHT_RESPONSES
                  ? `순위가 매겨진 답 ${ranked}건 — ${RANK_FULL_WEIGHT_RESPONSES}건보다 적어 비중을 줄였습니다`
                  : `순위가 매겨진 답 ${ranked}건`,
        },
        {
          key: 'brandOwnedCitationRate',
          label: '자사 출처 인용률',
          value: formatPct(card.brandOwnedCitationRate),
          isText: false,
          basis: insights?.owned
            ? `이름 없는 질문만 보면 ${(insights.owned.rate * 100).toFixed(1)}% (${insights.owned.owned}/${insights.owned.total})`
            : 'AI가 근거로 쓴 출처 중 우리 사이트',
        },
        {
          key: 'shareOfMention',
          label: '언급 점유율',
          value: formatPct(card.shareOfMention),
          isText: card.shareOfMention === null,
          basis:
            shareOfMentionNote(card) ??
            (card.shareOfMentionMentions !== undefined
              ? `자사·경쟁사 언급 ${card.shareOfMentionMentions}번 기준`
              : '같은 질문에서 경쟁 브랜드 대비 언급 점유'),
        },
      ]
    : []
  // 점수를 가장 많이 보탠 항목 — 표에서 기여를 강조한다.
  const topPart = explain?.parts?.find((p) => p.points > 0)?.key ?? null

  return (
    <>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loading && !card && <p className="muted">불러오는 중…</p>}
      {!loading && !card && tenant && <h1 className="page-solo-title">개요</h1>}

      {tenant && card && (
        <>
          {/*
            맨 위 — 브랜드 · 결론 문장(코드 템플릿, lib/answerInsights)과 변화 알림(계기판 A). 문장을 만들 수 없으면(주제 태그 없음 등)
            숫자 요약만 둔다. 판정 알약 · 「가장 발목을 잡는 건」은 정기진단 보고서와 같은 판정이다.
          */}
          <section className="ov-head" aria-label="이번 주 요약">
            <div className="ov-head-main">
              <div className="ov-brand">
                <h1>{card.brandName}</h1>
                <span>
                  {card.industry} · {card.region}
                </span>
              </div>
              <p className="ov-meta">
                {weekLabel(card.weekOf)}
                {cardAt && (
                  <>
                    {' '}
                    · <span className="mono">{cardAt}</span> 측정
                  </>
                )}{' '}
                · {usedLabels.join(' · ') || '엔진 기록 없음'}
              </p>
              {insights?.sentence && <p className="ov-sentence">{insights.sentence}</p>}
              <p className="ov-sub">
                {insights && insights.coverage.asked > 0 ? (
                  <>
                    이름 없이 물은 질문 <b className="mono">{insights.coverage.asked}</b>개 중 <b className="mono">{insights.coverage.hit}</b>개에서
                    불렸고, {cohortText}입니다.
                  </>
                ) : (
                  `${cohortText}입니다.`
                )}
                {!prevCard && ' 측정 1주차라 추이는 다음 측정부터 쌓입니다.'}
              </p>
              {headline && (
                <p className="ov-verdict">
                  <span className={`status-pill st-${headline.tone}`}>{headline.label}</span>
                  {headline.detail && <span>{headline.detail}</span>}
                </p>
              )}
            </div>
            <ChangeAlerts history={history} context={alertContext} />
          </section>

          {/*
            점수 판 — 흰 판은 이 화면에 이것 하나(계기판 A). 점수 · 100점 눈금(95% 신뢰구간 띠 · 같은 조건 평균 눈금) · 「N점은 어디서 나왔나」
            (구성 · 몰림 막대) · 1위 답 수별 점수(계단). 구성 · 몰림 · 계단은 정기진단 보고서 「점수 풀이」와 같은 계산이다.
          */}
          <section className="ov-sheet" aria-label="이번 주 점수">
            <div className="ov-pane ov-gauge">
              <div className="ov-pane-head">
                <h2>Brand AEO Score</h2>
                {/* 숫자만 보면 몇 점 만점인지 알 수 없다(상용화 UI 3차 U20). */}
                <span>100점 만점</span>
              </div>
              <div className="ov-score">
                <span className="ov-score-num">{card.aeoScore.current}</span>
                {/* 측정 1주차에는 전주 · 신뢰구간을 감춘다 — 「아직 비교할 게 없다」는 같은 말을 여러 번 하는 자리다. */}
                {prevCard && (
                  <span className="ov-score-delta">
                    <b className={delta ? `tone-${delta.tone}` : undefined}>{delta ? `${deltaLabel} ${delta.text}` : notComparableText}</b>
                    <span className="mono">
                      {prevCard.weekOf.replace(/^\d{4}-/, '')} {prevCard.aeoScore.current} {delta ? '→' : '·'} {card.weekOf.replace(/^\d{4}-/, '')}{' '}
                      {card.aeoScore.current}
                    </span>
                  </span>
                )}
              </div>
              <div
                className="ov-scale"
                role="img"
                aria-label={`100점 눈금 위 이번 주 ${card.aeoScore.current}점${prevCard ? `, 95% 신뢰구간 ${card.aeoScore.ciLow}–${card.aeoScore.ciHigh}` : ''}${
                  sameAvg ? `, ${sameAvg.text} ${sameAvg.average}` : ''
                }`}
              >
                <span className="ov-scale-track" />
                {prevCard && (
                  <span
                    className="ov-scale-ci"
                    style={{ left: `${card.aeoScore.ciLow}%`, width: `${Math.max(0.5, card.aeoScore.ciHigh - card.aeoScore.ciLow)}%` }}
                  />
                )}
                {sameAvg && <span className="ov-scale-avg" style={{ left: `${sameAvg.average}%` }} />}
                <span className="ov-scale-now" style={{ left: `${card.aeoScore.current}%` }} />
                <span className="ov-scale-ticks" aria-hidden="true">
                  <span>0</span>
                  <span>50</span>
                  <span>100</span>
                </span>
              </div>
              <dl className="ov-facts">
                {sameAvg && (
                  <div>
                    <dt>
                      <span className="ov-key avg" aria-hidden="true" />
                      같은 조건 평균
                    </dt>
                    <dd>
                      <b className="mono">{sameAvg.average}</b>{' '}
                      <span className="dash-sub">{sameAvg.text.replace(/^같은 조건 /, '').replace(/ 평균$/, '')}</span>
                    </dd>
                  </div>
                )}
                {prevCard && (
                  <div>
                    <dt>
                      <span className="ov-key ci" aria-hidden="true" />
                      95% 신뢰구간
                    </dt>
                    <dd className="mono">
                      {card.aeoScore.ciLow}–{card.aeoScore.ciHigh}
                    </dd>
                  </div>
                )}
                {weekRuns && (
                  // 좁은 칸이라 주의 문장은 제목(마우스를 올리면)으로 — 화면에는 횟수 · 회차별 점수만.
                  <div title="점수는 그 주 카드 회차 하나입니다(평균이 아닙니다). 회차마다 흔들려 하루 단위로 견주지 않습니다.">
                    <dt>이번 주 측정</dt>
                    <dd>
                      <b className="mono">{weekRuns.count}</b>회{' '}
                      <span className="dash-sub">
                        · {weekRuns.scores.join('·')} · <Link to="/performance#runs">회차별 보기</Link>
                      </span>
                    </dd>
                  </div>
                )}
                <div>
                  <dt>코호트 순위</dt>
                  <dd>
                    {(card.cohortRank.tiedCount ?? 1) > 1 ? '공동 ' : ''}
                    <b className="mono">{card.cohortRank.position}</b>위 <span className="dash-sub mono">/ {card.cohortRank.totalTenants}</span>
                  </dd>
                </div>
                <div>
                  <dt>Site AEO</dt>
                  <dd>
                    {siteNow ? (
                      <>
                        <b className="mono">{siteNow.score}</b>
                        {siteDelta !== null && siteDelta !== 0 && (
                          <span className={`delta-chip ${siteDelta > 0 ? 'up' : 'down'}`}>
                            {siteDelta > 0 ? '+' : ''}
                            {siteDelta}
                          </span>
                        )}
                        {siteDiff && (
                          <>
                            {' '}
                            <span className="dash-sub">· {subjectParticle(siteDiff)} 달라 견주지 않음</span>
                          </>
                        )}
                      </>
                    ) : isElectron && !viewing ? (
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

            {explain?.parts && (
              <div className="ov-pane ov-why">
                <div className="ov-pane-head">
                  <h2 className="ov-why-title">이번 주 {explain.score}점은 어디서 나왔나</h2>
                  <span>막대 길이 = {explain.score}점</span>
                </div>
                <div className="ov-bar-block">
                  <div className="ov-bar-label">
                    <b>구성 — 지표별</b>
                    <span className="mono">
                      {explain.score} = {explain.parts.map((p) => p.points).join(' + ')}
                    </span>
                  </div>
                  <div
                    className="ov-bar"
                    role="img"
                    aria-label={`${explain.score}점 구성: ${explain.parts.map((p) => `${p.label} 약 ${p.points}점`).join(', ')}`}
                  >
                    {explain.parts
                      .filter((p) => p.points > 0)
                      .map((p) => (
                        <span key={p.key} className={`ov-seg part-${p.key}`} style={{ flexGrow: p.points }} />
                      ))}
                  </div>
                  <ul className="ov-legend">
                    {explain.parts.map((p) => (
                      <li key={p.key}>
                        <span className="ov-legend-name">
                          <span className={`ov-swatch part-${p.key}`} aria-hidden="true" />
                          {p.label}
                        </span>
                        <span>
                          약 <b className="mono">{p.points}</b>점{' '}
                          {parts?.get(p.key) && (
                            <span className="dash-sub">
                              · 비중 <span className="mono">{Math.round(parts.get(p.key)!.weight * 100)}%</span>
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {explain.rankDropped && <p className="dash-caption">순위가 매겨진 답이 없어 추천 순위는 점수에서 빠졌습니다.</p>}
                </div>
                {explain.concentration && (
                  <div className="ov-bar-block">
                    <div className="ov-bar-label">
                      <b>몰림 — 답별</b>
                      <span className="mono">
                        {explain.score} = {explain.concentration.fromRanked} + {explain.concentration.without}
                      </span>
                    </div>
                    <div
                      className="ov-bar"
                      role="img"
                      aria-label={`${explain.score}점 가운데 약 ${explain.concentration.fromRanked}점이 순위가 매겨진 답 ${explain.concentration.answers}건에서, 나머지에서 ${explain.concentration.without}점`}
                    >
                      <span className="ov-seg conc" style={{ flexGrow: explain.concentration.fromRanked }}>
                        답 {explain.concentration.answers}건
                        {explain.concentration.questions.length > 0 && ` · 질문 ${explain.concentration.questions.length}개`}에서 약{' '}
                        {explain.concentration.fromRanked}점
                      </span>
                      {explain.concentration.without > 0 && <span className="ov-seg rest" style={{ flexGrow: explain.concentration.without }} />}
                    </div>
                    <p className="ov-why-note">
                      이름 없이 물은 질문에서 순위가 매겨진 답 {explain.concentration.answers}건이 없었다면{' '}
                      <b className="mono">{explain.concentration.without}</b>점입니다.
                    </p>
                    {explain.concentration.questions.length === 1 && (
                      <p className="ov-quote">
                        <span>몰린 질문</span>「{explain.concentration.questions[0]}」
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {explain?.steps && (
              <div className="ov-pane ov-steps">
                <div>
                  <h2>1위 답 수별 점수</h2>
                  <p className="dash-caption">이번 주 다른 값은 그대로 두고, 비교 그룹 이름 중 1위로 추천된 답 수만 바꾸면</p>
                </div>
                <div
                  className="ov-step-bars"
                  role="img"
                  aria-label={explain.steps.map((s) => `${s.firstAnswers}건 ${s.score}점${s.current ? '(이번 주)' : ''}`).join(', ')}
                >
                  {explain.steps.map((s) => (
                    <div key={s.firstAnswers} className={`ov-step${s.current ? ' current' : ''}`}>
                      <span className="mono">{s.score}</span>
                      <span className="ov-step-bar" style={{ height: `${Math.max(2, Math.round((s.score / stepTop) * 100))}%` }} />
                    </div>
                  ))}
                </div>
                <div className="ov-step-axis" aria-hidden="true">
                  {explain.steps.map((s) => (
                    <span key={s.firstAnswers} className={s.current ? 'current' : undefined}>
                      {s.firstAnswers}건
                      {s.current && (
                        <>
                          <br />
                          이번 주
                        </>
                      )}
                    </span>
                  ))}
                </div>
                {stepMove && (
                  <p className="dash-caption">
                    1위 답 1건이 오가면 점수가 <span className="mono">{stepMove}</span>점 움직입니다 — 한 번 잰 점수보다 같은 조건 평균으로 봅니다.
                  </p>
                )}
              </div>
            )}
          </section>

          <section className="ov-sec" aria-labelledby="ov-metrics">
            <div className="ov-sec-head">
              <h2 id="ov-metrics">지표</h2>
              <span className="dash-sub">막대 = 이번 주 비중 · 세로 눈금 = 기본 비중</span>
              <Link to="/answers" className="dash-link">
                AI 답변 보기 →
              </Link>
            </div>
            <div className="ov-table-wrap">
              <table className="ov-table">
                <thead>
                  <tr>
                    <th scope="col">지표</th>
                    <th scope="col" className="num">
                      이번 주
                    </th>
                    <th scope="col">근거</th>
                    <th scope="col">점수 비중 · 기본 → 이번 주</th>
                    <th scope="col" className="num">
                      점수 기여
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {metricRows.map((r) => {
                    const part = r.key === 'shareOfMention' ? null : (parts?.get(r.key) ?? null)
                    const share = r.key === 'shareOfMention' ? null : (explain?.parts?.find((p) => p.key === r.key) ?? null)
                    return (
                      <tr key={r.key} className={r.key === 'shareOfMention' ? 'is-ref' : undefined}>
                        <th scope="row">{r.label}</th>
                        <td className={`num ov-val${r.isText ? ' is-text' : ''}`}>
                          {r.value}
                          {r.unit && <span className="ov-unit">{r.unit}</span>}
                        </td>
                        <td className="ov-basis">{r.basis}</td>
                        <td className="ov-weight" title={r.key === 'shareOfMention' ? undefined : weightTitle(r.key)}>
                          {!part ? (
                            <span className="dash-sub">점수 미포함 — 참고 지표</span>
                          ) : part.weight === 0 ? (
                            <span className="dash-sub">{weightTagText(part)}</span>
                          ) : (
                            <span className="ov-wbar-row">
                              {/* 눈금 0–60% — 기본 비중 가장 큰 항목(언급률 42%)이 순위가 빠져 커져도(56%) 막대 안에 든다. */}
                              <span className="ov-wbar" aria-hidden="true">
                                <span style={{ width: `${Math.min(100, (part.weight / 0.6) * 100)}%` }} />
                                <i style={{ left: `${Math.min(100, (part.baseWeight / 0.6) * 100)}%` }} />
                              </span>
                              <span className="mono">{weightTagText(part, { short: true })}</span>
                            </span>
                          )}
                        </td>
                        <td className={`num ov-contrib${share && share.key === topPart ? ' is-top' : ''}`}>
                          {share ? (
                            <>
                              약 <b className="mono">{share.points}</b>점
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* 사실성은 점수 밖 지표라 평소엔 숨기고, 등록된 브랜드 정보와 어긋난 주장이 있을 때만 경고로 띄운다. */}
          {card.hallucinationFlags.length > 0 && (
            <details className="fact-warn">
              <summary>
                {/* 「틀림」 기록은 응답마다 한 줄이라 건수는 응답 수다 — 정기진단 보고서와 같은 말로. 판정 오류일 수도 있어 「검토 전」. */}
                브랜드 사실과 어긋난 주장이 담긴 AI 응답 {card.hallucinationFlags.length}건 (판정 검토 전)
                {card.factualityScore !== null && ` · 사실성 ${formatPct(card.factualityScore)}`}
              </summary>
              {/* 기록 줄(openai / v5-006 #1)이 아니라 무엇이 어긋났는지 — 판정 기록을 못 읽으면 엔진별 응답 수만. */}
              {selfCheck && selfCheck.contradicted.length > 0 ? (
                <ul>
                  {selfCheck.contradicted.map((c, i) => (
                    <li key={i}>{contradictedLine(c)}</li>
                  ))}
                </ul>
              ) : (
                <p className="muted">{factFlagSummary(card.hallucinationFlags)}의 응답 — 원문은 정기진단 보고서에서 봅니다.</p>
              )}
            </details>
          )}

          {viewing && customer && <CompareWithCustomer competitor={card} customerId={customer.tenantId} customerName={customer.brandName} />}

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
                  {trend.map(({ card: h, diffs }) => {
                    const current = h.weekOf === card.weekOf
                    const marked = diffs.length > 0
                    // 이번 주와 같은 조건으로 잰 구간 앞의 주 — 빈 막대로 그려 이어 읽지 않게 한다. 구간 첫 주 앞에는 세로 점선.
                    const prior = runStart !== null && h.weekOf < runStart
                    const start = hasPrior && h.weekOf === runStart
                    return (
                      <div key={h.weekOf} className={`trend-col${current ? ' current' : ''}${prior ? ' prior' : ''}${start ? ' run-start' : ''}`}>
                        <span className="trend-value">{h.aeoScore.current}</span>
                        <span className="trend-bar" style={{ height: `${Math.max(2, Math.round((h.aeoScore.current / trendTop) * 64))}px` }} />
                        <span className="trend-week">{h.weekOf.replace(/^\d{4}-/, '')}</span>
                        <span className={`trend-mark${marked ? ' on' : ''}`} title={marked ? `직전 측정과 ${conditionSummary(diffs)}` : undefined} />
                      </div>
                    )
                  })}
                </div>
                {(hasPrior || trend.some((t) => t.diffs.length > 0)) && (
                  <ul className="trend-key">
                    {hasPrior && (
                      <li>
                        <span className="trend-swatch prior" aria-hidden="true" />
                        {runStart?.replace(/^\d{4}-/, '')} 앞 — 측정 조건이 달라 이번 주와 잇지 않음
                      </li>
                    )}
                    <li>
                      <span className="trend-swatch" aria-hidden="true" />
                      같은 조건
                    </li>
                    <li>
                      <span className="trend-swatch now" aria-hidden="true" />
                      이번 주
                    </li>
                    {trend.some((t) => t.diffs.length > 0) && (
                      <li>
                        <span className="trend-mark on" aria-hidden="true" />
                        측정 조건이 바뀌었거나 확인할 수 없는 주 — 직전 측정과 바로 비교하지 않습니다
                      </li>
                    )}
                  </ul>
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

          {!viewing && (
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
          )}

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
      {!viewing && (
      <details className="dash-guide">
        <summary>이 브랜드를 보는 순서 — 진단 → 실행 → 보고·측정</summary>
        <div className="pipeline-grid">
          <article>
            <p className="pipeline-stage">진단</p>
            <h2>밀리는 질문·엔진·경쟁사</h2>
            <p>{card ? `카테고리 무관 언급률 ${formatPct(card.mentionRate)}` : '측정 후 채워집니다'}</p>
            <Link to="/answers">AI 답변 →</Link>
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
      )}

      <p className="dash-foot">
        {card && conditions ? (
          <>
            {weekLabel(card.weekOf)} 측정 · 수집 {conditions.collect} · 판정 {conditions.judge} · 질문{' '}
            {/* 그 주에 쓴 은행의 문항 수 — 설정값은 다음 측정의 값이라(경쟁사 편집이 질문을 빼면 41) 그 주와 다를 수 있다. */}
            {(todoData?.key === splitKey && todoData.bank && todoData.bank.version === card.questionBankVersion
              ? todoData.bank.questions.length
              : tenant?.questionBankSize) ?? '—'}
            개{card.questionBankVersion ? ` (질문지 ${card.questionBankVersion})` : ''} ·{' '}
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

/**
 * 경쟁사 보기(읽기 전용)에서 고른 고객 브랜드와 나란히 — 상용화 UI 10차 시안의 「삼성서울병원과 비교」.
 * 두 브랜드의 마지막 측정을 그대로 견준다. 주차나 질문지가 다르면 그 사실을 밝힌다(같은 질문으로 잰 게 아니다).
 * 마지막 측정의 코호트(업종 · 지역)가 다르면 나란히 놓지 않는다 — 펜션 경쟁사를 성형외과 고객과 견주는 건 의미가 없다.
 */
function CompareWithCustomer({
  competitor,
  customerId,
  customerName,
}: {
  competitor: WeeklyScorecard | null
  customerId: string
  customerName: string
}) {
  const { history } = useScorecards(customerId)
  const mine = history.at(-1) ?? null
  // 같은 질문으로 쟀는지 — 버전 이름만으로는 모른다(W36은 브랜드마다 「v1」인데 질문 문장이 달랐다).
  // 브랜드 현황(server/portfolio.ts)과 같이 이름 없는 질문의 문장 집합을 견준다. 못 읽으면 다르다고 본다.
  const basisKey = competitor && mine ? `${competitor.tenantId}|${competitor.questionBankVersion}|${mine.tenantId}|${mine.questionBankVersion}` : ''
  const [sameQuestions, setSameQuestions] = useState<{ key: string; same: boolean } | null>(null)
  useEffect(() => {
    if (!competitor || !mine || !competitor.questionBankVersion || !mine.questionBankVersion || !sameCohort(competitor, mine)) return
    let alive = true
    const general = (b: QuestionBank | null) =>
      b ? new Set(b.questions.filter((q) => q.category === 'category-agnostic').map((q) => q.text)) : null
    void Promise.all([
      loadQuestionBank(competitor.tenantId, competitor.questionBankVersion),
      loadQuestionBank(mine.tenantId, mine.questionBankVersion),
    ])
      .then(([a, b]) => {
        const x = general(a)
        const y = general(b)
        const same = Boolean(x && y && x.size > 0 && x.size === y.size && [...x].every((t) => y.has(t)))
        if (alive) setSameQuestions({ key: basisKey, same })
      })
      .catch((err: unknown) => {
        console.error('[CompareWithCustomer] 질문지를 읽지 못해 다른 질문지로 봅니다', err)
        if (alive) setSameQuestions({ key: basisKey, same: false })
      })
    return () => {
      alive = false
    }
  }, [competitor, mine, basisKey])
  if (!competitor || !mine) return null
  if (!sameCohort(competitor, mine)) {
    return (
      <section className="dash-card cv-compare" aria-label={`${withParticle(customerName)} 비교`}>
        <div className="dash-card-head">
          <h2>{withParticle(customerName)} 비교</h2>
          <span className="dash-sub">
            {competitor.brandName} {competitor.industry} · {competitor.region} · {customerName} {mine.industry} · {mine.region}
          </span>
        </div>
        <p className="dash-caption cv-compare-note">
          두 브랜드의 마지막 측정이 서로 다른 코호트(업종 · 지역)에 있어 나란히 비교하지 않아요. 같은 질문지로 잰
          코호트끼리만 견줄 수 있어요.
        </p>
      </section>
    )
  }
  const rows: { label: string; them: number | null; us: number | null; fmt: (v: number) => string; scale: number }[] = [
    { label: 'Brand AEO Score', them: competitor.aeoScore.current, us: mine.aeoScore.current, fmt: (v) => String(v), scale: 100 },
    { label: '언급률', them: competitor.mentionRate, us: mine.mentionRate, fmt: formatPct, scale: 1 },
    { label: '자사 인용률', them: competitor.brandOwnedCitationRate, us: mine.brandOwnedCitationRate, fmt: formatPct, scale: 1 },
  ]
  const sameBasis = competitor.weekOf === mine.weekOf && sameQuestions?.key === basisKey && sameQuestions.same
  const bar = (v: number | null, scale: number) => `${v === null ? 0 : Math.max(2, Math.min(100, Math.round((v / scale) * 100)))}%`
  return (
    <section className="dash-card cv-compare" aria-label={`${withParticle(customerName)} 비교`}>
      <div className="dash-card-head">
        <h2>{withParticle(customerName)} 비교</h2>
        <span className="dash-sub">
          {competitor.brandName} {weekLabel(competitor.weekOf)} · {customerName} {weekLabel(mine.weekOf)}
        </span>
      </div>
      <div className="cv-compare-rows">
        {rows.map((r) => (
          <div className="cv-compare-row" key={r.label}>
            <span className="cv-compare-label">{r.label}</span>
            <span className="cv-compare-bar them">
              <span style={{ width: bar(r.them, r.scale) }} />
              <span className="cv-compare-who">{competitor.brandName}</span>
            </span>
            <span className="cv-compare-val">{r.them === null ? '—' : r.fmt(r.them)}</span>
            <span className="cv-compare-bar us">
              <span style={{ width: bar(r.us, r.scale) }} />
              <span className="cv-compare-who">{customerName}</span>
            </span>
            <span className="cv-compare-val us">{r.us === null ? '—' : r.fmt(r.us)}</span>
          </div>
        ))}
      </div>
      {(!competitor.questionBankVersion || !mine.questionBankVersion || (sameQuestions?.key === basisKey && !sameBasis)) && (
        <p className="dash-caption cv-compare-note">
          두 브랜드를 다른 주차나 다른 질문지로 쟀습니다 — 질문별 승패는 비교할 수 없습니다. 같은 코호트 질문지로 다시
          재면 같은 질문에서 누가 앞서는지 볼 수 있습니다.
        </p>
      )}
    </section>
  )
}
