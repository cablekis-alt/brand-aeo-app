import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  CitationSourcesSection,
  CohortCompareSection,
  ContradictedList,
  MentionSection,
  ScoreExplainSection,
  SiteBreakdownSection,
  TrustChecksBox,
} from '../components/ReportReviewSections'
import ScoreTrendChart from '../components/ScoreTrendChart'
import WeekPicker from '../components/WeekPicker'
import { useTenant } from '../context/useTenant'
import { UrlLink } from '../components/CitationBits'
import {
  loadActionStates,
  loadCitationBreakdown,
  loadCitationSources,
  loadEeat,
  loadQuestionAnalyses,
  loadQuestionBank,
  loadScorecards,
  loadSiteScores,
  type ActionStateMap,
  type HistoryCell,
  type SiteScoreRecord,
} from '../lib/api'
import { citationTop, cohortRows, selfReview, trustChecks } from '../lib/reviewReport'
import { questionCoverage, unnamedOwnedCitation } from '../lib/answerInsights'
import { resolveBankVersion } from '../lib/bankVersion'
import {
  afterWeeksOf,
  citedPostIdsInWeek,
  distinctPostings,
  executionSummaryLine,
  freshNoCiteNote,
  monthDay,
  postWeekOf,
  runTallyText,
  summarizePost,
  TIER_LABEL,
} from '../lib/publishTracking'
import { isoWeekOf, kstDate } from '../lib/publishedUrl'
import { buildRecommendationEvidence } from '../lib/recommendationEvidence'
import { explainScore } from '../lib/reportExplain'
import { brandLabel, variantTag } from '../lib/brandVariant'
import { usePublishedHistory } from '../lib/usePublishedHistory'
import type { CitationBreakdownRow, QuestionBank, QuestionRepeatAnalysis } from '../lib/types'
import type { CitationSourceAnalysis } from '../prompts/b7-citation-sources'
import type { WeeklyScorecard } from '../prompts/b8-report'
import { comparableRun, compareConditions, conditionReason, conditionSummary, siteDifference } from '../lib/comparability'
import { isoWeekMonth, monthLabel } from '../prompts/isoWeek'
import { ENGINE_LABEL, measureConditionPlain, measureConditionText, weekLabel } from '../lib/format'
import { useScorecards } from '../lib/useScorecards'
import { useWeekSelection } from '../lib/useWeekSelection'
import { useWeeklyData } from '../lib/useWeeklyData'
import { buildPeriodicReport, PRIORITY_LABEL, scoreBreakdown, STATUS_LABEL, weightTagText, type ScorePartKey } from '../lib/b9-report'
import type { EeatAnalysis } from '../prompts/b6-eeat'

const EMPTY_EEAT: EeatAnalysis = {
  overall: 0,
  experience: { score: 0, evidence: [] },
  expertise: { score: 0, evidence: [] },
  authoritativeness: { score: 0, evidence: [] },
  trustworthiness: { score: 0, evidence: [] },
  mentionedCallCount: 0,
  totalCallCount: 0,
}

/** 전주 대비 증감. prev가 null이면 아무것도 그리지 않는다 — 비교가 없는 것과 보합은 다르다. */
function Delta({ now, prev }: { now: number; prev: number | null }) {
  if (prev === null) return null
  const d = Math.round((now - prev) * 10) / 10
  if (d === 0) return <span className="delta flat">보합</span>
  return (
    <span className={`delta ${d > 0 ? 'up' : 'down'}`}>
      {d > 0 ? '+' : ''}
      {d}
    </span>
  )
}

/** 집행 표 칸 — 올린 뒤 측정 한 주. 숫자는 그 주소를 정확히 인용한 응답 수, 여러 번 잰 주는 회차 수(성과 표와 같은 문구). */
function afterWeekText(weekOf: string, cell: HistoryCell | null): string {
  const w = weekOf.slice(5)
  if (!cell) return `${w} 확인 불가`
  if (cell.timing === 'during' || cell.timing === 'ambiguous') return `${w} 전후 불명`
  const runs = runTallyText(cell)
  if (runs) return `${w} ${runs.main}`
  if (cell.tally) return `${w} 인용 ${cell.tally.all.cited}`
  // 갓 올린 글의 「인용 없음」은 판단에 넣지 않는다 — 같은 줄 판단 칸의 「색인 대기」와 맞춘다(성과 표와 같은 꼬리).
  const fresh = freshNoCiteNote(cell)
  return fresh ? `${w} 인용 없음(${fresh})` : `${w} 인용 없음`
}

/** 집행 표에 보이는 올린 뒤 측정 주 수 — 최근 것부터. */
const EXEC_WEEKS = 6

/** 파일 이름에 못 쓰는 글자와 띄어쓰기 · 쉼표를 뺀다 — 「스테이,머뭄」 → 「스테이머뭄」. */
const fileSafe = (s: string) => s.replace(/[\\/:*?"<>|,.\s]+/g, '')

/** CSS 문자열 값 — @page 머리말에 브랜드 이름을 넣는다(따옴표 · 역슬래시 이스케이프). */
const cssString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"`

/** 화면에서는 값까지(운영자), 종이에서는 바뀐 조건 이름만 — 모델 id 같은 내부 값이 고객 종이에 찍히지 않게. */
function ReasonText({ full, plain }: { full: string; plain: string }) {
  return (
    <>
      <span className="no-print">{full}</span>
      <span className="print-only-inline">{plain}</span>
    </>
  )
}

export default function PeriodicReport() {
  const { tenant, tenants, viewing } = useTenant()
  const { history, loading, error } = useScorecards(tenant?.tenantId ?? '')
  // 다른 화면에서 주차를 지정해 들어올 수 있다(퍼포먼스의 「사실성 리스크」 → 그 주 원문). 없으면 최신 주.
  const [searchParams] = useSearchParams()
  const [weekOf, setWeekOf] = useWeekSelection(history, searchParams.get('week') ?? '')

  /*
   * 주간 / 월간.
   *
   * 한 주는 변동이 크다(신뢰구간이 넓은 이유가 그것이다). 고객에게 보내는 문서라면 달 단위가
   * 더 맞을 때가 많아 두 보기를 둔다.
   *
   * 주차를 달에 묶는 기준은 **그 주의 목요일이 든 달**이다(isoWeekMonth). 한 주가 두 달에
   * 걸칠 때 규칙 없이 나누지 않기 위해서이고, ISO가 주의 연도를 정하는 방식과 같다.
   *
   * 중요한 제약: 종합 판정·지표별 진단·개선제안은 **한 주차 스코어카드에서** 나온다.
   * 지표를 평균 내 다시 판정하면 실제로 측정한 적 없는 주를 판정하는 셈이 된다. 그래서
   * 월간에서도 판정은 그 달 마지막 주차를 쓰고, 화면이 그렇다고 밝힌다. 타일만 달 단위로
   * 모은다(평균·합계는 측정값을 모으는 것이지 새로 만드는 것이 아니다).
   */
  const [period, setPeriod] = useState<'week' | 'month'>('week')
  const months = useMemo(() => {
    const set = new Set<string>()
    for (const h of history) {
      const m = isoWeekMonth(h.weekOf)
      if (m) set.add(m)
    }
    return [...set].sort()
  }, [history])
  const [monthKey, setMonthKey] = useState('')
  const activeMonth = monthKey && months.includes(monthKey) ? monthKey : (months.at(-1) ?? '')
  const weeksInMonth = useMemo(
    () => history.filter((h) => isoWeekMonth(h.weekOf) === activeMonth),
    [history, activeMonth],
  )
  const prevMonth = useMemo(() => {
    const i = months.indexOf(activeMonth)
    return i > 0 ? months[i - 1]! : ''
  }, [months, activeMonth])
  const weeksInPrevMonth = useMemo(
    () => (prevMonth ? history.filter((h) => isoWeekMonth(h.weekOf) === prevMonth) : []),
    [history, prevMonth],
  )

  /** 판정이 근거로 쓰는 주차 — 월간에서는 그 달의 마지막 주차. */
  const judgedWeek = period === 'month' ? (weeksInMonth.at(-1)?.weekOf ?? weekOf) : weekOf

  const { data: eeat, loading: eeatLoading } = useWeeklyData(loadEeat, tenant?.tenantId ?? '', judgedWeek, EMPTY_EEAT)

  const card = useMemo(
    () => history.find((h) => h.weekOf === judgedWeek) ?? history.at(-1) ?? null,
    [history, judgedWeek],
  )
  const report = useMemo(
    () => (history.length ? buildPeriodicReport(history, judgedWeek || (history.at(-1)?.weekOf ?? ''), eeat) : null),
    [history, judgedWeek, eeat],
  )
  const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null)

  /*
   * 맨 위 3타일 — 보고서를 판정 문장이 아니라 숫자 셋으로 연다.
   *
   * 지금은 「종합 판정」부터 나와서, 읽는 사람이 문장을 해석한 뒤에야 상태를 안다. 정기
   * 리포트는 훑어보는 문서라 첫 화면에서 "올랐나 내렸나"가 먼저 보여야 한다.
   *
   * 셋을 고른 이유: Brand는 답변에서의 가시성, Site는 페이지 준비도, 인용 건수는 그 주에
   * 엔진이 실제로 근거를 얼마나 끌어왔는지 — 서로 다른 축이라 함께 봐야 한다.
   */
  // 주간 숫자 칸 · 표지 · 지표별 진단이 같은 판정을 쓴다(report.comparison — 앱 전체 규칙 comparability.ts). 월간은 아래 monthCompare.
  const comparison = period === 'week' ? (report?.comparison ?? null) : null
  const prevCard = useMemo(
    () => (comparison?.previousWeekOf ? (history.find((h) => h.weekOf === comparison.previousWeekOf) ?? null) : null),
    [history, comparison],
  )

  // Site AEO Score는 엔진과 무관하게 페이지를 읽어 낸 값이라, 전주 비교에 엔진 조건이 걸리지
  // 않는다. 그 주차보다 앞선 가장 최근 진단을 그대로 쓴다.
  const [siteScores, setSiteScores] = useState<Record<string, SiteScoreRecord>>({})
  // 어느 브랜드의 진단을 다 읽었는지 — 인쇄 버튼이 기다린다(읽기 전에 찍으면 Site 칸 · 영역 표가 말없이 빠진다).
  const [siteLoadedFor, setSiteLoadedFor] = useState('')
  useEffect(() => {
    const id = tenant?.tenantId
    if (!id) return
    let alive = true
    void loadSiteScores(id).then((v) => {
      if (!alive) return
      setSiteScores(v ?? {})
      setSiteLoadedFor(id)
    })
    return () => {
      alive = false
    }
  }, [tenant?.tenantId])
  /*
   * 주차에 보여 줄 사이트 진단.
   *   - 가장 최근 측정 주차: 가장 최근 진단(지금의 페이지 상태). 측정 뒤에 진단해도 보인다.
   *   - 그 밖의 주차: 그 주차 또는 그 전의 가장 최근 진단, 없으면 가장 가까운 이후 진단.
   *
   * Brand AEO 측정과 사이트 진단은 대개 다른 주에 한다(실측: KETI는 W37에 측정, 사이트는 W38·W40에
   * 진단). 같은 주차만 찾으면 진단을 해 둬도 보고서에는 「—」로 남는다. 어느 주의 진단인지는 타일
   * 아래에 적는다.
   */
  const siteWeeks = useMemo(() => Object.keys(siteScores).sort(), [siteScores])
  const latestMeasuredWeek = history.at(-1)?.weekOf ?? ''
  const siteFor = useCallback(
    (week: string): SiteScoreRecord | null => {
      if (!week) return null
      const upTo = siteWeeks.filter((w) => w <= week)
      const pick =
        week === latestMeasuredWeek ? siteWeeks.at(-1) : (upTo.at(-1) ?? siteWeeks.find((w) => w > week))
      return pick ? (siteScores[pick] ?? null) : null
    },
    [siteScores, siteWeeks, latestMeasuredWeek],
  )
  /*
   * 보고서 전체가 쓰는 사이트 진단 하나 — 숫자 칸 · 「Site AEO 영역별 점수」 · 개선제안 근거가 같은 진단을 쓴다. 예전에는 월간
   * 숫자 칸만 따로 골라, 칸은 「이 달에 사이트 진단 기록이 없습니다」인데 같은 화면 개선제안은 「사이트 진단(N점)」을 쓰는 일이 있었다.
   *   - 주간: 그 주차 기준(siteFor).
   *   - 월간: 그 달의 마지막 진단. 그 달에 진단이 없으면 판정 주차 기준(siteFor)으로 고르고 칸에 「(이 달 진단 없음)」을 밝힌다.
   *     판정 주차 기준만 쓰면 그 달에 진단이 있어도 앞 달 진단을 고를 수 있다(측정 W37 · 진단 W35 · W39 → 9월에 W35).
   */
  const monthSite = useMemo(() => {
    const inMonth = siteWeeks.filter((w) => isoWeekMonth(w) === activeMonth)
    return inMonth.length ? (siteScores[inMonth[inMonth.length - 1]!] ?? null) : null
  }, [siteScores, siteWeeks, activeMonth])
  const siteNow = period === 'month' ? (monthSite ?? siteFor(judgedWeek)) : siteFor(weekOf)
  // 비교 대상은 보여 주는 진단 바로 전의 진단이다(선택 주차가 아니라).
  const sitePrev = useMemo(() => {
    if (!siteNow) return null
    const before = siteWeeks.filter((w) => w < siteNow.weekOf)
    return before.length ? (siteScores[before[before.length - 1]!] ?? null) : null
  }, [siteScores, siteWeeks, siteNow])

  /*
   * 인용 건수는 스코어카드에 없다(비율만 있다). 그 주차 인용 분석에서 총계를 읽어 온다.
   * 월간이면 그 달 주차들의 **합계**다 — 인용은 건수라 더하는 것이 자연스럽고, 평균을 내면
   * "한 주에 몇 건이었나"가 되어 달 단위 활동량을 말해 주지 못한다.
   */
  // 목록을 memo로 잡아 effect 의존성에 그대로 넣는다 — 렌더마다 새 배열이면 effect가 끝없이 돈다.
  const nowWeeks = useMemo(
    () => (period === 'month' ? weeksInMonth.map((h) => h.weekOf) : weekOf ? [weekOf] : []),
    [period, weeksInMonth, weekOf],
  )
  const prevWeeks = useMemo(
    () =>
      period === 'month'
        ? weeksInPrevMonth.map((h) => h.weekOf)
        : comparison?.previousWeekOf
          ? [comparison.previousWeekOf]
          : [],
    [period, weeksInPrevMonth, comparison],
  )
  const [citations, setCitations] = useState<{ key: string; now: number | null; prev: number | null }>({
    key: '',
    now: null,
    prev: null,
  })
  const citationKey = tenant ? `${tenant.tenantId}|${nowWeeks.join(',')}|${prevWeeks.join(',')}` : ''
  useEffect(() => {
    const id = tenant?.tenantId
    if (!id || nowWeeks.length === 0) return
    let alive = true
    const key = `${id}|${nowWeeks.join(',')}|${prevWeeks.join(',')}`
    const sum = async (weeks: string[]) => {
      if (weeks.length === 0) return null
      const rows = await Promise.all(weeks.map((w) => loadCitationSources(id, w)))
      // 한 주라도 읽지 못하면 합계를 만들지 않는다 — 빠진 주를 0으로 치면 달이 작아 보인다.
      if (rows.some((r) => r === null)) return null
      return rows.reduce((a, r) => a + (r?.totalCitations ?? 0), 0)
    }
    void Promise.all([sum(nowWeeks), sum(prevWeeks)]).then(([now, prev]) => {
      if (alive) setCitations({ key, now, prev })
    })
    return () => {
      alive = false
    }
  }, [tenant?.tenantId, citationKey, nowWeeks, prevWeeks])
  const cite = citations.key === citationKey ? citations : { key: '', now: null, prev: null }

  /*
   * 월간 타일 값.
   *
   * Brand 점수는 **평균**이다 — 한 주는 변동이 커서 마지막 주만 보면 그 달을 대표하지 못한다.
   * Site 점수는 평균을 내지 않는다. 그 시점 페이지 상태를 잰 값이라 평균이 뜻을 갖지 않는다 —
   * 판정 주차의 진단(siteNow)을 쓴다.
   */
  const monthBrand = mean(weeksInMonth.map((h) => h.aeoScore.current))
  const prevMonthBrand = mean(weeksInPrevMonth.map((h) => h.aeoScore.current))
  // 언급률도 평균(%) — 점수와 같은 이유로 한 주가 그 달을 대표하지 못한다.
  const monthMention = mean(weeksInMonth.map((h) => h.mentionRate * 100))
  const prevMonthMention = mean(weeksInPrevMonth.map((h) => h.mentionRate * 100))

  /*
   * 개선제안의 「이번 주 데이터로 본 실행 항목」과 불린 질문 · 출처 · 사실성 절이 함께 쓰는 측정 기록 — 판정 주차의
   * 질문별 판정·질문 은행·인용 출처·도메인별 인용. 한 번만 불러와 나눠 준다.
   */
  const evidenceKey = card ? `${card.tenantId}|${card.weekOf}` : ''
  const [evidenceData, setEvidenceData] = useState<{
    key: string
    analyses: QuestionRepeatAnalysis[]
    bank: QuestionBank | null
    citations: CitationSourceAnalysis | null
    citationRows: CitationBreakdownRow[]
  } | null>(null)
  useEffect(() => {
    if (!card) return
    let alive = true
    const key = `${card.tenantId}|${card.weekOf}`
    loadQuestionAnalyses(card.tenantId, card.weekOf)
      .then(async (analyses) => {
        // 그 주차를 측정한 은행으로 — 버전이 없는 옛 카드는 질문 id 접두로 찾는다(콘텐츠 생성의 useGapActionPlan과 같은 규칙).
        // 지금 은행을 받으면 질문 id가 맞지 않아 이름 없는 질문을 가려내지 못하고, 실린 출처가 「충족」에서 빠진다.
        const [bank, citations, breakdown] = await Promise.all([
          loadQuestionBank(card.tenantId, resolveBankVersion([card], card.weekOf, analyses)),
          loadCitationSources(card.tenantId, card.weekOf),
          loadCitationBreakdown(card.tenantId, card.weekOf),
        ])
        return { analyses, bank, citations, citationRows: breakdown.rows }
      })
      .then(
        (data) => alive && setEvidenceData({ key, ...data }),
        // 기록을 못 읽으면 실행 항목 없이 기본 원칙만 보인다 — 빈 기록으로 두고 넘어간다.
        () => alive && setEvidenceData({ key, analyses: [], bank: null, citations: null, citationRows: [] }),
      )
    return () => {
      alive = false
    }
  }, [card])
  const evidence = evidenceData?.key === evidenceKey ? evidenceData : null

  /*
   * 같은 주 코호트 기록 — 다른 브랜드의 그 주 카드와 질문 은행. 브랜드마다 이력을 받아야 해서 무겁다 — 본문과 따로 뒤에서 불러오고,
   * 오는 동안 본문은 그대로 그린다(코호트 표 · 신뢰도 점검만 늦게 채워진다).
   */
  const [cohortData, setCohortData] = useState<{
    key: string
    members: WeeklyScorecard[]
    banks: Record<string, QuestionBank | null>
    error: string | null
  } | null>(null)
  useEffect(() => {
    if (!card) return
    let alive = true
    const key = `${card.tenantId}|${card.weekOf}`
    const ids = (card.cohortRank.members ?? []).map((m) => m.tenantId).filter((id) => id !== card.tenantId)
    const load = async () => {
      const members = (
        await Promise.all(ids.map(async (id) => (await loadScorecards(id)).find((c) => c.weekOf === card.weekOf) ?? null))
      ).filter((c): c is WeeklyScorecard => c !== null)
      const banks = await Promise.all(members.map(async (c) => [c.tenantId, await loadQuestionBank(c.tenantId, c.questionBankVersion)] as const))
      return { members, banks: Object.fromEntries(banks) }
    }
    load().then(
      (data) => alive && setCohortData({ key, ...data, error: null }),
      (err: unknown) => alive && setCohortData({ key, members: [], banks: {}, error: err instanceof Error ? err.message : String(err) }),
    )
    return () => {
      alive = false
    }
  }, [card])
  const cohortLoaded = cohortData?.key === evidenceKey ? cohortData : null

  // 이 브랜드의 그 주 응답 요약(불린 질문 · 유형별 · 「틀림」 원문) — 그 주 은행을 못 읽으면 null.
  const self = useMemo(() => (evidence ? selfReview(evidence.analyses, evidence.bank) : null), [evidence])
  const cohort = useMemo(
    () =>
      card && cohortLoaded && !cohortLoaded.error
        ? cohortRows(card, cohortLoaded.members, { ...cohortLoaded.banks, [card.tenantId]: evidence?.bank ?? null })
        : null,
    [card, cohortLoaded, evidence],
  )
  const checks = useMemo(
    () => (card && cohort && cohortLoaded ? trustChecks(card, history, cohortLoaded.members, cohort, self?.general ?? null) : null),
    [card, cohort, cohortLoaded, history, self],
  )
  const topCitations = useMemo(() => (evidence && evidence.citationRows.length > 0 ? citationTop(evidence.citationRows) : null), [evidence])

  /*
   * 집행한 글(언급률 2번 P4) — 고객 브랜드의 올린 글 기록과 집행 상태. 데스크톱에서만 있다(웹은 라우트가 없어 null). 그래프 핀 ·
   * 「집행한 글과 인용」 절 · 개선제안의 재권고 방지에 함께 쓴다. 경쟁사 보기에서는 쓰지 않는다 — 우리 집행 기록이다.
   */
  const published = usePublishedHistory(viewing ? '' : (tenant?.tenantId ?? ''))
  const [actionStates, setActionStates] = useState<{ key: string; value: ActionStateMap | null }>({ key: '', value: null })
  useEffect(() => {
    const id = viewing ? '' : tenant?.tenantId
    if (!id) return
    let alive = true
    loadActionStates(id).then(
      (value) => alive && setActionStates({ key: id, value }),
      // 집행 상태를 못 읽으면 개선제안은 전처럼 모든 출처를 권한다 — 집행 여부를 지어내지 않는다.
      () => alive && setActionStates({ key: id, value: null }),
    )
    return () => {
      alive = false
    }
  }, [tenant?.tenantId, viewing])
  const states = !viewing && actionStates.key === tenant?.tenantId ? actionStates.value : null
  const execPosts = useMemo(() => published.history?.posts.map((p) => p.post) ?? [], [published.history])

  /**
   * 보고 주차까지로 자른 집행 표 — 그 뒤 측정 · 그 뒤에 올린(날짜 없으면 기록한) 글은 넣지 않는다. 같은 주소를 여러 줄에 적은 기록은
   * 한 편으로 묶는다(편수는 글로 센다).
   */
  const execution = useMemo(() => {
    const h = published.history
    const until = judgedWeek || card?.weekOf || ''
    if (!h || !until || h.posts.length === 0) return null
    const cut = h.weeks.findIndex((w) => w.weekOf > until)
    const end = cut < 0 ? h.weeks.length : cut
    const weeks = h.weeks.slice(0, end)
    const rows = distinctPostings(
      h.posts.filter((p) => postWeekOf(p.post) <= until),
      (p) => p.post,
    ).map(({ item, post, places }) => {
      const cells = item.cells.slice(0, end)
      const removedOn = post.removedAt ? kstDate(post.removedAt) : null
      // 보고 주차까지 내린 날만 — 그 뒤에 내린 일은 이 주 보고서에 넣지 않는다.
      const removedBy = removedOn && (isoWeekOf(removedOn) ?? '') <= until ? removedOn : null
      const summary = summarizePost(cells, weeks, removedBy)
      return {
        post,
        places,
        // 날짜를 모르는 기록은 잘린 칸과 상관없이 「올린 날 모름」 — 기다리면 풀리는 「측정 대기」가 아니다.
        summary: post.publishedOn ? summary : { ...summary, tier: 'undated' as const },
        after: afterWeeksOf(cells, weeks, post.publishedOn, removedOn),
        removedOn: removedBy,
        // 보고 주차까지 고친 날만 — 그 뒤에 고친 일은 이 주 보고서에 넣지 않는다.
        editedOn: (post.edits ?? []).map((e) => e.editedOn).filter((d) => (isoWeekOf(d) ?? '') <= until),
      }
    })
    if (rows.length === 0) return null
    return { rows, line: executionSummaryLine(rows.map((r) => r.summary), weekLabel(until)) }
  }, [published.history, judgedWeek, card?.weekOf])

  // 보고 주 칸(그 주 회차를 합친 값)에서 올린 뒤 인용된 기록 — 개선제안의 「인용됨」이 집행 표와 같은 칸을 보게 한다.
  const citedPostIds = useMemo(
    () => (published.history && card ? citedPostIdsInWeek(published.history, card.weekOf) : null),
    [published.history, card],
  )

  const enrichedReport = useMemo(() => {
    if (!report || !card || !evidence) return report
    const map = buildRecommendationEvidence({
      card,
      analyses: evidence.analyses,
      questions: evidence.bank?.questions ?? [],
      citations: evidence.citations,
      site: siteNow,
      // 올린 글 기록을 다 읽었을 때만 집행을 가른다 — 읽는 중 · 실패 · 웹이면 전처럼 모두 권한다(「주소 기록 없음」을 지어내지 않는다).
      ...(published.history ? { posts: execPosts, ...(states ? { states } : {}), ...(citedPostIds ? { citedPostIds } : {}) } : {}),
    })
    return { ...report, recommendations: report.recommendations.map((r) => (map[r.id] ? { ...r, evidence: map[r.id] } : r)) }
  }, [report, card, evidence, siteNow, states, execPosts, published.history, citedPostIds])

  /*
   * 표지 한 문장 — "이름 없이 물은 질문 N개 중 M개에서 불렸습니다". 언급률(응답 단위)과 달리 질문 단위라
   * 고객이 "어느 질문에서 우리가 나오나"로 바로 읽는다. 판정 기록을 못 읽으면 문장 없이 판정만 둔다.
   */
  const coverLine = useMemo(() => {
    if (!evidence?.bank) return null
    const { asked, hit } = questionCoverage(evidence.analyses, evidence.bank.questions)
    return asked > 0 ? `이름 없이 물은 질문 ${asked}개 중 ${hit}개에서 불렸습니다` : null
  }, [evidence])

  /*
   * 이름 없는 질문 기준 자사 인용률 — 지표별 진단의 「브랜드 소유 출처 인용」 칸 아래에 함께 보인다.
   *
   * 점수에 들어가는 자사 인용률은 이번 주 **모든 질문**의 인용을 센다(server/aggregate.ts). 그런데 언급률은
   * 이름 없는 질문만 세서, 같은 점수 안에서 두 지표의 모집단이 다르다. 브랜드 이름을 넣은 질문("교보생명
   * ○○ 알려줘")에는 AI가 자연히 그 브랜드 사이트를 인용하므로 값이 부푼다 — 실측 교보생명 W40은 전체 21.0%,
   * 이름 없는 질문만 6.8%(46/676)였다. 점수 산식은 그대로 두고, 진단에서 두 값을 나란히 보인다.
   * 판정 기록에서 바로 세므로 지난 주차에도 나온다. 판정 기록·질문지를 못 읽으면 보이지 않는다.
   */
  const unnamedOwned = useMemo(
    () => (evidence?.bank ? unnamedOwnedCitation(evidence.analyses, evidence.bank.questions) : null),
    [evidence],
  )

  /*
   * 점수 풀이 — 판정 주차 점수가 어디서 나왔고 무엇이 점수를 움직이는지(src/lib/reportExplain.ts). 판정 기록을 읽기 전에는 카드만으로
   * 낼 수 있는 줄(구성 · 비중 · 순위의 뜻 · 견주는 구간)을 보이고, 읽으면 기록으로 센 줄(몰림 · 계단 · 이름을 댈 때 · 움직이는 것)을 더한다.
   */
  const explainLines = useMemo(
    () => (card ? explainScore({ card, history, analyses: evidence?.analyses ?? [], bank: evidence?.bank ?? null }) : []),
    [card, history, evidence],
  )

  /** 그 달 안에서 측정 조건이 바뀐 곳(앱 전체 규칙) — 바뀌었으면 월 평균을 한 값처럼 읽으면 안 된다. 화면은 값까지, 종이는 조건 이름만. */
  const monthConditionBreaks = useMemo(() => {
    const out: { full: string; plain: string }[] = []
    for (let i = 1; i < weeksInMonth.length; i++) {
      const diffs = compareConditions(weeksInMonth[i - 1]!, weeksInMonth[i]!)
      const w = weekLabel(weeksInMonth[i]!.weekOf)
      if (diffs.length > 0) out.push({ full: `${w}: ${conditionReason(diffs)}`, plain: `${w}: ${conditionSummary(diffs)}` })
    }
    return out
  }, [weeksInMonth])

  /*
   * 월간 증감 — 앞 달과 이 달의 모든 측정이 같은 조건 연속 구간 하나에 들 때만 견준다. 인용 합계는 잰 주 수까지 같아야 한다
   * (주 수가 다르면 합계 차이는 측정 횟수 차이다). 견줄 수 없으면 이유 한 줄을 화면과 종이에 함께 적는다.
   */
  const monthCompare = useMemo(() => {
    if (period !== 'month' || weeksInPrevMonth.length === 0 || weeksInMonth.length === 0) return null
    const span = [...weeksInPrevMonth, ...weeksInMonth].sort((a, b) => a.weekOf.localeCompare(b.weekOf))
    const inRun = new Set(comparableRun(history, span.at(-1)!.weekOf).map((c) => c.weekOf))
    if (span.every((c) => inRun.has(c.weekOf)))
      return { comparable: true, reason: '', reasonPlain: '', sameWeeks: weeksInPrevMonth.length === weeksInMonth.length }
    let reason = ''
    let reasonPlain = ''
    for (let i = 1; i < span.length && !reason; i++) {
      const diffs = compareConditions(span[i - 1]!, span[i]!)
      if (diffs.length > 0) {
        reason = `${weekLabel(span[i]!.weekOf)}: ${conditionReason(diffs)}`
        reasonPlain = `${weekLabel(span[i]!.weekOf)}: ${conditionSummary(diffs)}`
      }
    }
    return { comparable: false, reason, reasonPlain, sameWeeks: false }
  }, [period, history, weeksInMonth, weeksInPrevMonth])

  /*
   * 인쇄 준비 — 근거 · 비교 그룹 · EEAT · Site · 인용 건수 · 집행 기록을 다 읽기 전에는 인쇄를 막는다. 화면을 열자마자 찍으면 비교 그룹 표 ·
   * 집행 절이 말없이 빠진 PDF가 나오는데, 운영자 화면에서는 곧 채워져 모른 채 보내게 된다(상용화 UI 3차 U6). 경쟁사 보기는 집행
   * 기록을 읽지 않으므로 기다리지 않는다.
   */
  const printReady =
    Boolean(evidence) &&
    Boolean(cohortLoaded) &&
    !eeatLoading &&
    siteLoadedFor === (tenant?.tenantId ?? '') &&
    citations.key === citationKey &&
    (Boolean(viewing) || (!published.loading && actionStates.key === tenant?.tenantId))
  // 사람 확인이 남은 점검 — 인쇄 전에 한 번 묻는다(점검 상자는 종이에 싣지 않아 PDF만 보면 모른다).
  const reviewLeft = checks?.filter((c) => c.status === 'review').length ?? 0
  const onPrint = () => {
    if (
      reviewLeft > 0 &&
      !window.confirm(`측정 신뢰도 점검에 사람 확인 ${reviewLeft}건이 남아 있습니다. 그래도 인쇄 · PDF로 저장할까요?`)
    )
      return
    window.print()
  }

  /*
   * 인쇄할 때만 문서 제목을 「스테이머뭄_정기진단_2026-W43」으로 — PDF로 저장할 때 기본 파일 이름이 된다(매번 손으로 바꾸지 않게).
   * 버튼과 Ctrl+P 둘 다 오도록 beforeprint · afterprint에 건다. 창 제목은 평소 그대로 둔다.
   */
  const reportLabel = card ? (period === 'month' ? monthLabel(activeMonth) : weekLabel(card.weekOf)) : ''
  // 같은 홈페이지로 범위만 다르게 등록한 브랜드(군산각 지역형 · 전국형)는 이름이 같다 — 머리말 · 파일 이름에 범위 꼬리표(U7).
  const brandTag = tenant ? variantTag(tenant, tenants) : null
  const reportBrand = card ? `${card.brandName}${brandTag ? ` · ${brandTag}` : ''}` : ''
  const printTitle = card ? `${fileSafe(card.brandName)}${brandTag ? `_${fileSafe(brandTag)}` : ''}_정기진단_${period === 'month' ? activeMonth : card.weekOf}` : ''
  useEffect(() => {
    if (!printTitle) return
    let saved: string | null = null
    // beforeprint가 afterprint 없이 두 번 와도(인쇄 미리보기를 다시 그릴 때) 처음 제목을 지킨다.
    const before = () => {
      if (saved === null) saved = document.title
      document.title = printTitle
    }
    const after = () => {
      if (saved !== null) document.title = saved
      saved = null
    }
    window.addEventListener('beforeprint', before)
    window.addEventListener('afterprint', after)
    return () => {
      after()
      window.removeEventListener('beforeprint', before)
      window.removeEventListener('afterprint', after)
    }
  }, [printTitle])

  if (!tenant) return null

  return (
    <>
      <header className="page-head">
        <div className="page-title">
          <p className="page-eyebrow">
            보고 · {brandLabel(tenant, tenants)}
            {judgedWeek ? ` · ${weekLabel(judgedWeek)}` : ''}
          </p>
          <h1>정기진단 보고서</h1>
        </div>
        {card && report && (
          <div className="page-actions no-print">
            <button
              type="button"
              className="btn"
              onClick={onPrint}
              disabled={!printReady}
              title={printReady ? undefined : '비교 그룹 · 근거 기록을 다 불러온 뒤 인쇄할 수 있습니다'}
            >
              {printReady ? '인쇄 · PDF 저장' : '보고서 준비 중…'}
            </button>
          </div>
        )}
      </header>
      {/*
        종이 머리말(브랜드 · 기간)과 쪽 번호 — 2쪽부터 브랜드도 주차도 없어 여러 고객 보고서를 한꺼번에 뽑으면 섞였다(U29). 이 화면에
        있는 동안만 있는 규칙이다(Site AEO 인쇄는 자기 머리말을 쓴다). 첫 쪽은 표지에 같은 말이 있어 머리말을 뺀다.
      */}
      {card && (
        <style>{`@media print { @page { size: A4; margin: 14mm 12mm 16mm; @top-right { content: ${cssString(`${reportBrand} · ${reportLabel} 정기진단 보고서`)}; font: 8pt 'IBM Plex Sans KR', 'Malgun Gothic', sans-serif; color: #6b7280; } @bottom-center { content: counter(page) " / " counter(pages); font: 8pt 'IBM Plex Sans KR', 'Malgun Gothic', sans-serif; color: #6b7280; } } @page :first { @top-right { content: none; } } }`}</style>
      )}
      <p className="page-lead no-print">
        이번 주 스코어카드를 지표별로 진단하고, 약한 지표를 우선순위가 매겨진 실행 가능한 개선안으로 정리합니다. 모든
        판정은 측정된 수치에서 결정적으로 도출되며 새 수치를 만들지 않습니다.
      </p>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loading && history.length === 0 && <p className="muted">불러오는 중…</p>}
      {!loading && history.length === 0 && <p className="muted">아직 저장된 주간 데이터가 없습니다. 먼저 측정을 실행하세요.</p>}

      {card && report && (
        <>
          <div className="filters no-print">
            <div className="axis-tabs" role="tablist" aria-label="보고 기간">
              {(['week', 'month'] as const).map((k) => (
                <button
                  type="button"
                  key={k}
                  role="tab"
                  aria-selected={period === k}
                  className={`axis-tab${period === k ? ' is-on' : ''}`}
                  onClick={() => setPeriod(k)}
                >
                  {k === 'week' ? '주간' : '월간'}
                </button>
              ))}
            </div>
            {period === 'week' ? (
              <WeekPicker weeks={history.map((h) => h.weekOf)} value={weekOf} onChange={setWeekOf} />
            ) : (
              <label className="field">
                <span>월</span>
                <select value={activeMonth} onChange={(e) => setMonthKey(e.target.value)}>
                  {months.map((m) => (
                    <option key={m} value={m}>
                      {monthLabel(m)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {/*
            표지 — 결론 한 문장을 맨 위에 둔다(상용화 UI 4단계). 예전엔 숫자 타일과 검토 리포트 아래에
            「종합 판정」이 있어, 고객이 받은 문서의 첫 화면에서 결론을 찾을 수 없었다.
            문장은 코드 템플릿이고, 수는 판정 기록에서 센 그대로다. 점수 칩은 두지 않는다 — 바로 아래
            타일이 같은 숫자를 더 크게 보여 주고, 이름까지 갈리면('AEO 43') 두 값처럼 읽힌다.
          */}
          <section className={`report-cover sev-${report.verdict.tone}`}>
            <p className="report-cover-eyebrow">
              {card.brandName} · {weekLabel(card.weekOf)} · {card.industry} · {card.region}
            </p>
            <h2 className="report-cover-title">{coverLine ?? `종합 판정 ${report.verdict.label}`}</h2>
            <p className="verdict-head">
              <span className={`status-pill st-${report.verdict.tone}`}>종합 판정 {report.verdict.label}</span>
            </p>
            <p className="verdict-summary">{report.verdict.summary}</p>
            {/*
              같은 브랜드라도 엔진·모델·판정 모델이 바뀌면 점수가 움직인다 — 무엇으로 쟀는지 판정 옆에 둔다. 모델 id · preset은 운영자가
              화면에서 보고, 종이에는 엔진 이름만 싣는다(U5: 「Perplexity (preset:low)」가 고객 PDF 표지에 찍혔다).
            */}
            <p className="hint no-print">
              수집 엔진 {measureConditionText(card).collect} · 판정 엔진 {measureConditionText(card).judge} · 반복{' '}
              {measureConditionText(card).repeats}
              {card.questionBankVersion ? ` · 질문지 ${card.questionBankVersion}` : ''}
            </p>
            <p className="hint print-only">{measureConditionPlain(card)}</p>
            {report.variabilityNote && <p className="hint">※ {report.variabilityNote}</p>}
          </section>

          {/* 운영자 점검 — 결론 바로 아래, 화면에서만. 숫자를 읽기 전에 믿어도 되는지 먼저 본다. */}
          <TrustChecksBox checks={checks} error={cohortLoaded?.error ?? null} />

          {/*
            증감은 **견줄 수 있을 때만** 보여 준다. 측정 조건(수집 엔진 · 판정 · 모델 · 질문지 · 반복)이 바뀐 주끼리 빼면
            그 차이는 브랜드가 아니라 측정 방식이 만든 것이다 — 앱 전체 규칙(comparability.ts)을 표지 · 지표별 진단과 함께 쓴다.
            Site 점수는 엔진과 무관하게 페이지를 읽은 값이라 같은 주소 · 같은 수집 방식인지만 본다(siteComparable).
          */}
          <section className="report-tiles">
            <article>
              <p className="tile-label">Brand AEO Score{period === 'month' && ' 월 평균'}</p>
              <p className="tile-value">
                {period === 'month' ? (
                  monthBrand === null ? (
                    <span className="muted">—</span>
                  ) : (
                    <>
                      {monthBrand}
                      <Delta now={monthBrand} prev={monthCompare?.comparable ? prevMonthBrand : null} />
                    </>
                  )
                ) : (
                  <>
                    {card.aeoScore.current}
                    <Delta
                      now={card.aeoScore.current}
                      prev={comparison?.comparable ? (prevCard?.aeoScore.current ?? null) : null}
                    />
                  </>
                )}
              </p>
              <p className="tile-note">
                {period === 'month'
                  ? `100점 만점 · 답변에 얼마나 나오는가 · ${weeksInMonth.length}주 평균${prevMonth && monthCompare?.comparable ? ` · ${monthLabel(prevMonth)} 대비` : ''}`
                  : '100점 만점 · 답변에 얼마나 나오는가'}
              </p>
            </article>
            <article>
              <p className="tile-label">언급률{period === 'month' && ' 월 평균'}</p>
              {(() => {
                const pct = (v: number) => Math.round(v * 10) / 10
                const now = period === 'month' ? monthMention : pct(card.mentionRate * 100)
                const prev =
                  period === 'month'
                    ? monthCompare?.comparable
                      ? prevMonthMention
                      : null
                    : comparison?.comparable && prevCard
                      ? pct(prevCard.mentionRate * 100)
                      : null
                return (
                  <p className="tile-value">
                    {now === null ? (
                      <span className="muted">—</span>
                    ) : (
                      <>
                        {now.toFixed(1)}%
                        <Delta now={now} prev={prev} />
                      </>
                    )}
                  </p>
                )
              })()}
              {/* 응답 단위다 — 표지 문장(「질문 N개 중 M개」)은 질문 단위라 이름으로 가른다. */}
              <p className="tile-note">이름 없이 물은 질문의 AI 응답 중 불린 비율 · 증감은 %p</p>
            </article>
            <article>
              <p className="tile-label">Site AEO Score</p>
              {(() => {
                const now = siteNow
                const prev = sitePrev
                // 같은 페이지(주소)를 같은 방식으로 잰 진단끼리만 증감을 낸다 — 실측 ktcorp corp.kt.com 57 → www.kt.com 0이 「-57」로 찍혔다.
                const siteDiff = now && prev ? siteDifference(prev, now) : null
                // 보이는 진단이 그 주(월간이면 그 달) 것이 아니면 밝힌다 — 사이트 진단은 대개 측정과 다른 주에 한다.
                const away = now
                  ? period === 'month'
                    ? isoWeekMonth(now.weekOf) !== activeMonth
                      ? '(이 달 진단 없음)'
                      : ''
                    : now.weekOf !== weekOf
                      ? '(이 주차 진단 없음)'
                      : ''
                  : ''
                return (
                  <>
                    <p className="tile-value">
                      {now ? now.score : <span className="muted">—</span>}
                      {now && <Delta now={now.score} prev={prev && !siteDiff ? prev.score : null} />}
                    </p>
                    <p className="tile-note">
                      {now
                        ? `페이지 준비도 · ${weekLabel(now.weekOf)} 진단${away} · ${
                            prev
                              ? !siteDiff
                                ? `${weekLabel(prev.weekOf)} 대비`
                                : `${weekLabel(prev.weekOf)} 진단과 ${siteDiff === '주소' ? '주소가' : `${siteDiff}이`} 달라 견주지 않음`
                              : '첫 기록'
                          }`
                        : 'Site AEO Checker로 진단한 기록이 없습니다'}
                    </p>
                  </>
                )
              })()}
            </article>
            <article>
              <p className="tile-label">인용 건수{period === 'month' && ' 합계'}</p>
              <p className="tile-value">
                {cite.now === null ? <span className="muted">—</span> : cite.now.toLocaleString()}
                {cite.now !== null && (
                  <Delta
                    now={cite.now}
                    prev={
                      period === 'month'
                        ? monthCompare?.comparable && monthCompare.sameWeeks
                          ? cite.prev
                          : null
                        : comparison?.comparable
                          ? cite.prev
                          : null
                    }
                  />
                )}
              </p>
              <p className="tile-note">
                엔진이 근거로 끌어온 출처 수{period === 'month' && ` · ${weeksInMonth.length}주 합계`}
              </p>
            </article>
          </section>
          {/*
            증감을 적지 않은 이유 · 떨어진 비교는 종이에도 싣는다 — 표지 · 숫자 칸 · 지표별 진단이 같은 판정을 쓰므로 이제 같은 문서
            안에서 어긋나지 않는다. 빼면 PDF에서 증감이 이유 없이 사라진다.
          */}
          {period === 'week' && comparison?.previousWeekOf && !comparison.comparable && (
            <p className="hint">
              ※ 직전 측정({weekLabel(comparison.previousWeekOf)})과{' '}
              {comparison.diffs.some((d) => d.state === 'changed') ? '측정 조건이 달라' : '견줄 측정 조건 기록이 한쪽에 없어'}(
              <ReasonText full={conditionReason(comparison.diffs)} plain={conditionSummary(comparison.diffs)} />) 표지 · Brand AEO Score · 언급률 ·
              인용 건수 칸 · 지표별 진단에 증감을 적지 않았습니다.
              같은 조건으로 다시 재면 증감이 다시 나옵니다.
            </p>
          )}
          {period === 'week' && comparison?.previousWeekOf && comparison.comparable && (comparison.gapWeeks ?? 1) >= 2 && (
            <p className="hint">
              ※ 증감은 직전 측정({weekLabel(comparison.previousWeekOf)}, {comparison.gapWeeks}주 전) 대비입니다.
            </p>
          )}
          {period === 'month' && monthCompare && !monthCompare.comparable && (
            <p className="hint">
              ※ 앞 달({monthLabel(prevMonth)})과 측정 조건이 같지 않아(
              <ReasonText full={monthCompare.reason} plain={monthCompare.reasonPlain} />) 월 평균 · 합계에 증감을 적지 않았습니다.
            </p>
          )}
          {period === 'month' && monthCompare?.comparable && !monthCompare.sameWeeks && (
            <p className="hint">※ 앞 달과 잰 주 수가 달라 인용 건수 합계에는 증감을 적지 않았습니다.</p>
          )}

          {explainLines.length > 0 && <ScoreExplainSection lines={explainLines} weekOf={card.weekOf} />}

          {/* 판정 주차까지의 최근 12주 — 월간에서도 그 달 마지막 주차에서 끝난다(판정과 같은 주). */}
          <section className="report-trend">
            <h3>주차별 Brand AEO Score</h3>
            <ScoreTrendChart
              history={history}
              endWeek={judgedWeek || card.weekOf}
              {...(published.history && execPosts.length > 0 ? { executions: { posts: execPosts, weeks: published.history.weeks } } : {})}
            />
          </section>

          {/*
            같은 주 코호트 비교 — 그래프 아래 순위 숫자를 표로 편다(같은 저장 목록 · 같은 분모). 기록을 읽은 다른 브랜드가 없으면 뺀다
            (표는 읽은 줄만 그리므로, 저장 목록 수로 세면 이 브랜드 한 줄짜리 「비교」가 나온다).
          */}
          {cohort && cohort.filter((r) => r.loaded).length > 1 && <CohortCompareSection rows={cohort} weekOf={card.weekOf} />}
          {!cohortLoaded && <p className="muted no-print">비교 그룹 기록을 불러오는 중…</p>}

          {/* 집행한 글과 인용 — 기록이 없거나 웹이면 절을 뺀다(「집행 0편」이라고 단정하지 않는다). */}
          {!viewing && published.error && (
            <p className="hint no-print">
              올린 글 기록을 읽지 못해 집행 핀 · 「집행한 글과 인용」 · 개선제안의 집행 구분을 넣지 않았습니다: {published.error}
            </p>
          )}
          {execution && (
            <section className="report-exec">
              <h3>집행한 글과 인용</h3>
              {execution.line && <p className="report-exec-line">{execution.line}</p>}
              <div className="table-wrap">
                <table className="exec-table">
                  <thead>
                    <tr>
                      <th>올린 글</th>
                      <th>올린 날 · 올린 곳</th>
                      <th className="cell-text">올린 뒤 측정(최근 {EXEC_WEEKS}주까지)</th>
                      <th className="cell-text">판단</th>
                    </tr>
                  </thead>
                  <tbody>
                    {execution.rows.map((r) => (
                      <tr key={r.post.id}>
                        <td className="cell-text">
                          <b>{r.post.articleTitle ?? r.post.articleId}</b>
                          <div>
                            <UrlLink url={r.post.url} max={200} />
                          </div>
                        </td>
                        <td className="cell-text">
                          {r.post.publishedOn ? `${monthDay(r.post.publishedOn)} 올림` : '올린 날 모름'}
                          {r.editedOn.length > 0 && ` · ${r.editedOn.map(monthDay).join(' · ')} 고침`}
                          {r.removedOn && ` · ${monthDay(r.removedOn)} 내림`}
                          <div className="doc-meta">{r.places.join(' · ')}</div>
                        </td>
                        <td className="cell-text">
                          {r.after.length === 0
                            ? '—'
                            : r.after
                                .slice(-EXEC_WEEKS)
                                .map((a) => afterWeekText(a.weekOf, a.cell))
                                .join(' · ')}
                        </td>
                        <td className="cell-text">
                          {TIER_LABEL[r.summary.tier]}
                          {r.summary.measuredAfter > 0 && (
                            <div className="doc-meta">
                              올린 뒤 측정한 {r.summary.measuredAfter}주 중 {r.summary.citedWeeks}주 인용
                              {r.summary.measuredRuns !== r.summary.measuredAfter && ` (회차 ${r.summary.citedRuns}/${r.summary.measuredRuns})`}
                              {r.summary.firstCitedDays !== null && ` · 첫 인용 확인 D+${r.summary.firstCitedDays}`}
                            </div>
                          )}
                          {/* 성과 화면과 같은 표식 — 올린 뒤 측정 사이에 측정 조건이 바뀌었거나 확인할 수 없으면 주별 인용을 같은 조건의 반복으로 읽지 않는다. */}
                          {r.summary.conditionMixed && <div className="doc-meta">◆ 그사이 측정 조건이 바뀌었거나 확인할 수 없음</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="hint">
                숫자는 그 주소를 정확히 인용한 AI 응답 수입니다. 같은 주에 여러 번 잰 주는 「3회 중 1회」처럼 회차 단위로 적습니다(한 회차라도
                인용되면 그 주는 인용). 「여러 주 인용」은 올린 뒤 서로 다른 2주 이상에서 인용됐을 때만 붙입니다 — 자주 잴수록 한 주가 인용으로
                잡힐 기회가 늘어 회차 수를 함께 적습니다. 인용은 측정 조건과 다른 글에도 달려 있어, 점수 변화의 원인으로 읽지 않습니다. 「확인
                불가」는 그 주 판정 기록이 없다는 뜻입니다.
              </p>
            </section>
          )}

          {period === 'month' && (
            <section className="month-context">
              <p className="eyebrow">{monthLabel(activeMonth)} · 주차 {weeksInMonth.length}개</p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>주차</th>
                      <th>Brand AEO Score</th>
                      <th>언급률</th>
                      <th>수집 엔진</th>
                    </tr>
                  </thead>
                  <tbody>
                    {weeksInMonth.map((h) => (
                      <tr key={h.weekOf} className={h.weekOf === judgedWeek ? 'self' : undefined}>
                        <td>{weekLabel(h.weekOf)}</td>
                        <td>{h.aeoScore.current}</td>
                        <td>{(h.mentionRate * 100).toFixed(1)}%</td>
                        <td className="muted">
                          {(h.enginesUsed ?? []).map((e) => ENGINE_LABEL[e] ?? e).join(' · ') || '기록 없음'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/*
                평균을 한 값처럼 읽으면 안 되는 경우를 밝힌다. 그 달 안에서 수집 엔진이 갈렸으면
                주차별 점수가 같은 조건에서 나온 값이 아니다.
              */}
              {monthConditionBreaks.length > 0 && (
                <p className="hint">
                  ※ 이 달 안에 측정 조건이 바뀌었거나 확인할 수 없는 주가 있습니다(
                  <ReasonText
                    full={monthConditionBreaks.map((b) => b.full).join(' / ')}
                    plain={monthConditionBreaks.map((b) => b.plain).join(' / ')}
                  />
                  ) — 주차별 점수가 같은 조건에서 나온 값이 아니므로 평균을 하나의 수치처럼 읽지 마세요.
                </p>
              )}
              <p className="hint">
                아래 <b>종합 판정 · 지표별 진단 · 개선제안</b>은 이 달의 마지막 주차(
                {weekLabel(judgedWeek)}) 스코어카드에서 나옵니다. 지표를 평균 내 다시 판정하면 실제로 측정한 적 없는
                주를 판정하게 되므로 그렇게 하지 않습니다.
              </p>
            </section>
          )}

          <section>
            <h3>지표별 진단</h3>
            <div className="table-wrap">
              <table className="diagnosis-table">
                <thead>
                  <tr>
                    <th>지표</th>
                    <th>값</th>
                    <th>{period === 'month' || (report.comparison.gapWeeks ?? 1) >= 2 ? '직전 측정 대비' : '전주 대비'}</th>
                    <th>상태</th>
                    <th>진단</th>
                  </tr>
                </thead>
                <tbody>
                  {report.metrics.map((m) => (
                    <tr key={m.key}>
                      <td>
                        {m.label}
                        {/* 이번 주 실제 비중 — 순위 응답이 적으면 순위 몫이 줄고 나머지가 커진다(개요 · 진단 화면과 같은 값, 상용화 UI 3차 U20). */}
                        {m.weight > 0 &&
                          (() => {
                            const part = scoreBreakdown(card).find((p) => p.key === (m.key as ScorePartKey))
                            return (
                              <span className="weight-tag" title="기본 가중치 → 이번 주 실제 비중">
                                {part ? weightTagText(part, { short: true }) : `${Math.round(m.weight * 100)}%`}
                              </span>
                            )
                          })()}
                      </td>
                      <td className="num">
                        {m.valueText}
                        {m.key === 'brandOwnedCitationRate' && unnamedOwned && (
                          <span
                            className="cell-sub"
                            title="점수에는 모든 질문의 인용이 들어갑니다. 이 값은 브랜드 이름 없이 물은 질문(언급률과 같은 모집단)의 인용만 센 것입니다."
                          >
                            이름 없는 질문 {(unnamedOwned.rate * 100).toFixed(1)}% ({unnamedOwned.owned}/{unnamedOwned.total}건)
                          </span>
                        )}
                      </td>
                      <td className="num">
                        {m.delta ? <span className={`delta ${m.delta.tone}`}>{m.delta.text}</span> : <span className="muted">–</span>}
                      </td>
                      <td>
                        <span className={`status-pill st-${m.status}`}>{STATUS_LABEL[m.status]}</span>
                      </td>
                      <td className="judgment">{m.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/*
            지표 뒤의 근거 — 어느 질문에서 불렸나 · AI가 무엇을 근거로 썼나 · 사이트의 어느 영역이 약한가. 모두 판정 주차 기준이다.
            기록을 못 읽으면 절을 뺀다(「불린 적 없음」 · 「출처 없음」으로 쓰지 않는다).
          */}
          {self && self.general.responses > 0 && <MentionSection self={self} weekOf={card.weekOf} />}
          {topCitations && (
            <CitationSourcesSection top={topCitations.top} total={topCitations.total} owned={topCitations.owned} weekOf={card.weekOf} />
          )}
          {siteNow && siteNow.categories.length > 0 && <SiteBreakdownSection site={siteNow} />}

          {report.strengths.length > 0 && (
            <section className="panel">
              <h3>잘하고 있는 점</h3>
              <ul className="strength-list">
                {report.strengths.map((m) => (
                  <li key={m.key}>
                    <strong>{m.label}</strong> {m.valueText} — {m.note}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/*
            「틀림」 기록은 응답마다 한 줄이라 건수는 응답 수다. 기록 원문(엔진 id · 질문 id · 회차)과 판정 오류 가능성은 운영자가 화면에서
            보고, 고객 종이에는 건수만 싣는다 — 원문을 확인하기 전에는 결론으로 쓰지 않는다. 건수는 지표별 진단 사실성 줄과 개선제안
            근거 문장에 있어, 이 절은 통째로 화면에만 둔다(종이에는 제목만 남은 빈 상자로 찍혔다 — 상용화 UI 3차 U5 · 결정 D8).
          */}
          {report.risks.length > 0 && (
            <section className="panel warn no-print">
              <h3>리스크 · 사실성 — 사실과 어긋난 주장이 담긴 응답 {report.risks.length}건</h3>
              <p className="hint no-print">
                AI가 실제로 틀렸을 수도, 다른 브랜드에 대한 답을 이 브랜드 사실과 대조한 판정 오류일 수도 있습니다. 원문을 확인한 뒤
                씁니다.
              </p>
              {/* 원문은 주장 단위로 — 질문 · 엔진 · AI가 말한 값 · 등록된 값. 판정 기록을 못 읽으면 기록 줄 그대로. */}
              {self && self.contradicted.length > 0 ? (
                <ContradictedList items={self.contradicted} />
              ) : (
                <ul className="no-print">
                  {report.risks.map((flag) => (
                    <li key={flag}>{flag}</li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <section>
            <h3>개선제안 ({report.recommendations.length})</h3>
            {report.recommendations.length === 0 ? (
              <p className="muted">주의·미흡 지표가 없어 별도 개선제안이 없습니다. 현재 수준을 유지하세요.</p>
            ) : (
              <ol className="rec-list">
                {(enrichedReport ?? report).recommendations.map((rec, i) => (
                  <li key={rec.id} className={`rec-card pr-${rec.priority}`}>
                    <div className="rec-head">
                      <span className="rec-num">{String(i + 1).padStart(2, '0')}</span>
                      <h4>{rec.title}</h4>
                      <span className={`priority-pill pr-${rec.priority}`}>우선순위 {PRIORITY_LABEL[rec.priority]}</span>
                    </div>
                    <p className="rec-basis">{rec.basis}</p>
                    {rec.evidence && rec.evidence.blocks.length > 0 && (
                      // 화면 전용 묶음(사실성 원문)뿐이면 상자째 종이에서 뺀다 — 머리말만 남은 빈 상자가 찍히지 않게.
                      <div
                        className={`rec-evidence${rec.evidence.blocks.every((b) => b.screenOnly) && !rec.evidence.estimate ? ' no-print' : ''}`}
                      >
                        <p className="rec-label">이번 주 데이터로 본 실행 항목</p>
                        {rec.evidence.blocks.map((b, k) => (
                          <div key={k} className={`rec-evidence-block${b.screenOnly ? ' no-print' : ''}`}>
                            <p className="rec-evidence-head">{b.heading}</p>
                            <ul>
                              {b.items.map((it, j) => (
                                <li key={j}>
                                  <span>{it.text}</span>
                                  {it.detail && <span className="muted"> — {it.detail}</span>}
                                  {/* 운영자 메모(지분 · 충족 · 완료 기준) — 화면에서만. */}
                                  {it.opsNote && <span className="ops-note no-print">운영 메모 · {it.opsNote}</span>}
                                </li>
                              ))}
                            </ul>
                            {b.more ? <p className="hint">외 {b.more}개</p> : null}
                          </div>
                        ))}
                        {rec.evidence.estimate && <p className="hint">{rec.evidence.estimate}</p>}
                        {rec.evidence.link && (
                          <p className="no-print">
                            <Link
                              to={rec.evidence.link.to}
                              state={{ from: 'report', label: `${String(i + 1).padStart(2, '0')} ${rec.title}` }}
                              className="rec-link"
                            >
                              {rec.evidence.link.label} →
                            </Link>
                          </p>
                        )}
                      </div>
                    )}
                    {/*
                      「기본 원칙」은 위 데이터 항목과 견준 이름이다 — 종이에 데이터 항목이 없으면(사실성 원문만 있는 카드: 화면 전용) 종이에는
                      다른 카드처럼 「실행안」으로 찍는다.
                    */}
                    {(() => {
                      const blocks = rec.evidence?.blocks ?? []
                      if (blocks.length === 0) return <p className="rec-label">실행안</p>
                      const printed = blocks.some((b) => !b.screenOnly) || Boolean(rec.evidence?.estimate)
                      return printed ? (
                        <p className="rec-label">기본 원칙</p>
                      ) : (
                        <p className="rec-label">
                          <span className="no-print">기본 원칙</span>
                          <span className="print-only-inline">실행안</span>
                        </p>
                      )
                    })()}
                    <ul className="rec-actions">
                      {rec.actions.map((a, j) => (
                        <li key={j}>{a}</li>
                      ))}
                    </ul>
                    <p className="rec-expected">
                      <strong>기대효과</strong> {rec.expected}
                    </p>
                    <p className="rec-links no-print">
                      {rec.links.map((l) => (
                        <Link key={l.to} to={l.to} className="rec-link">
                          {l.label} →
                        </Link>
                      ))}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <p className="disclaimer">
            개선제안은 측정 지표의 강약을 규칙으로 매핑한 가이드입니다. 실제 반영 효과는 다음 측정에서 확인하세요.
            <span className="no-print"> 점수·수치는 리포트 단계에서 재계산하지 않습니다.</span>
          </p>
        </>
      )}
    </>
  )
}
