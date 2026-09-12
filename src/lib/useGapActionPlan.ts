import { useEffect, useMemo, useState } from 'react'
import { loadCitationSources, loadQuestionAnalyses, loadQuestionBank } from './api'
import { resolveBankVersion } from './bankVersion'
import { computeGapActions, type GapActionPlan } from './gapActions'
import type { QuestionRepeatAnalysis, QuestionSpec } from './types'
import { useWeeklyPage } from './useWeeklyPage'
import type { CitationSourceAnalysis } from '../prompts/b7-citation-sources'

/**
 * 실행 항목 계산에 필요한 세 가지(분석·질문 은행·인용 출처)를 한 번에 배선한다.
 *
 * 실행 항목 화면과 측정 상태 화면이 같은 목록을 보여준다. 배선을 각자 들고 있으면 한쪽만
 * 고쳐져 **같은 브랜드·같은 주차인데 두 화면의 숫자가 다른** 상태가 생긴다. 그러면 둘 다
 * 못 믿게 된다. 그래서 계산도 훅 하나에서만 한다.
 *
 * 주차 선택은 useWeeklyPage가 정한다(기본값 = 최신 주차). 측정 상태 화면처럼 주차 선택이
 * 필요 없는 곳은 weeks·setWeekOf를 그냥 쓰지 않으면 된다.
 */
export function useGapActionPlan(tenantId: string) {
  const {
    history,
    weeks,
    weekOf,
    setWeekOf,
    data: analyses,
    loading,
    neverMeasured,
  } = useWeeklyPage<QuestionRepeatAnalysis[]>(loadQuestionAnalyses, tenantId, [])

  // 이 주차를 측정한 은행 버전으로 불러온다 — 현재 버전으로 부르면 옛 주차의 질문 id가
  // 맞지 않아 텍스트·카테고리가 빈 값이 된다(화면에 v1-001 같은 id가 뜬다).
  const bankVersion = resolveBankVersion(history, weekOf, analyses)
  const [questions, setQuestions] = useState<QuestionSpec[]>([])
  const [citations, setCitations] = useState<CitationSourceAnalysis | null>(null)

  useEffect(() => {
    if (!tenantId) return
    let alive = true
    void loadQuestionBank(tenantId, bankVersion).then((bank) => {
      if (alive) setQuestions(bank?.questions ?? [])
    })
    return () => {
      alive = false
    }
  }, [tenantId, bankVersion])

  useEffect(() => {
    if (!tenantId || !weekOf) return
    let alive = true
    setCitations(null)
    void loadCitationSources(tenantId, weekOf).then((data) => {
      if (alive) setCitations(data)
    })
    return () => {
      alive = false
    }
  }, [tenantId, weekOf])

  const plan: GapActionPlan = useMemo(
    () => computeGapActions(analyses, questions, citations),
    [analyses, questions, citations],
  )

  return { plan, history, weeks, weekOf, setWeekOf, loading, neverMeasured }
}
