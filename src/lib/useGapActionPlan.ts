import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  loadActionStates,
  loadCitationSources,
  loadQuestionAnalyses,
  loadQuestionBank,
  saveActionState,
  type ActionStateMap,
  type ActionStatus,
} from './api'
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

  // 집행 상태. null은 오류가 아니라 **이 환경에 저장 기능이 없다**는 뜻이다(웹에는 라우트가
  // 없다). 그 구분을 그대로 넘겨서 화면이 저장되지 않는 버튼을 띄우지 않게 한다.
  const [states, setStates] = useState<ActionStateMap | null>(null)
  const [statesReady, setStatesReady] = useState(false)
  useEffect(() => {
    if (!tenantId) return
    let alive = true
    setStatesReady(false)
    void loadActionStates(tenantId).then((map) => {
      if (!alive) return
      setStates(map)
      setStatesReady(true)
    })
    return () => {
      alive = false
    }
  }, [tenantId])

  const [saveError, setSaveError] = useState<string | null>(null)
  const setStatus = useCallback(
    async (actionId: string, status: ActionStatus) => {
      if (!tenantId) return
      const before = states
      // 낙관적 반영 — 클릭이 먹었는지 기다리게 하지 않는다. 실패하면 되돌리고 말한다.
      setStates((prev) => {
        const next = { ...(prev ?? {}) }
        if (status === 'todo') delete next[actionId]
        else next[actionId] = { status, updatedAt: new Date().toISOString(), markedWeek: weekOf }
        return next
      })
      setSaveError(null)
      const saved = await saveActionState(tenantId, actionId, status, weekOf)
      if (saved) setStates(saved)
      else {
        setStates(before)
        setSaveError('상태를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.')
      }
    },
    [tenantId, weekOf, states],
  )

  const plan: GapActionPlan = useMemo(
    () => computeGapActions(analyses, questions, citations, states ?? {}),
    [analyses, questions, citations, states],
  )

  return {
    plan,
    history,
    weeks,
    weekOf,
    setWeekOf,
    loading,
    neverMeasured,
    /** 상태를 저장할 수 있는 환경인가(웹에서는 false). 화면은 이걸로 컨트롤을 숨긴다. */
    canSaveStatus: statesReady && states !== null,
    setStatus,
    saveError,
  }
}
