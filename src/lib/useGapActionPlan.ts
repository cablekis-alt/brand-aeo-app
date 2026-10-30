import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createExtraArticle,
  loadActionStates,
  loadCitationSources,
  loadExtraArticles,
  loadQuestionAnalyses,
  loadQuestionBank,
  saveActionState,
  updateExtraArticle,
  type ActionStateMap,
  type ActionStatus,
  type ExtraArticleSaveResult,
  type NewExtraArticleInput,
  type RecordPostInput,
} from './api'
import { resolveBankVersion } from './bankVersion'
import type { ExtraArticle } from './extraArticles'
import { computeGapActions, type GapActionPlan } from './gapActions'
import type { QuestionRepeatAnalysis, QuestionSpec } from './types'
import { usePublishedPosts } from './usePublishedPosts'
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
  // 불러온 은행의 판 — 추가 글은 이 주를 잰 판을 알아야 질문을 다시 찾는다. 예시 은행(demo)의 판 번호는 실제 측정 은행의 것이 아니다.
  const [loadedBank, setLoadedBank] = useState<{ version: string; demo: boolean } | null>(null)
  const [citations, setCitations] = useState<CitationSourceAnalysis | null>(null)

  useEffect(() => {
    if (!tenantId) return
    let alive = true
    void loadQuestionBank(tenantId, bankVersion).then((bank) => {
      if (!alive) return
      setQuestions(bank?.questions ?? [])
      setLoadedBank(bank ? { version: bank.version, demo: bank.demo === true } : null)
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

  /**
   * 올린 글 주소는 집행 원장에 쓴다(server/publishedPosts.ts — 주소 한 줄 = 기록 한 줄). 「올렸어요」는 markDone으로 그 항목을
   * 「집행함」으로 **같은 요청에서** 바꾼다 — 따로 부르면 두 번째 요청이 앞 요청 전의 상태를 다시 쓴다. 주소를 고치거나 빼도
   * 집행한 주(markedWeek)는 덮지 않는다(예전에는 주소만 고쳐도 보던 주차로 덮였다).
   */
  const published = usePublishedPosts(tenantId)
  const { record } = published
  /** 성공하면 null, 실패하면 이유. 브랜드가 바뀐 뒤 온 결과는 상태에 반영하지 않는다(usePublishedPosts가 stale로 알린다). */
  const recordPost = useCallback(
    async (input: Omit<RecordPostInput, 'viewingWeek'>): Promise<string | null> => {
      const r = await record({ ...input, viewingWeek: weekOf })
      if (!r.ok) return r.error
      if (r.states) setStates(r.states)
      return null
    },
    [record, weekOf],
  )

  /**
   * 추가 글 정의(server/extraArticles.ts). list가 null이면 이 환경에 기능이 없다(웹 — 라우트 404) — 화면은 칸을 숨기고 오류를 띄우지
   * 않는다. 읽다가 실패하면 빈 목록으로 계산하고 이유를 error에 싣는다(기능을 조용히 숨기면 왜 만들 수 없는지 모른다).
   * 요청 중에 브랜드를 바꾸면 늦게 온 응답을 버린다(usePublishedPosts와 같은 규칙).
   */
  const [extraLoaded, setExtraLoaded] = useState<{ key: string; list: ExtraArticle[] | null; corrupt: boolean; error: string | null } | null>(null)
  const currentTenant = useRef(tenantId)
  useEffect(() => {
    currentTenant.current = tenantId
  }, [tenantId])
  useEffect(() => {
    if (!tenantId) return
    let alive = true
    void loadExtraArticles(tenantId).then(
      (r) => {
        if (alive) setExtraLoaded({ key: tenantId, list: r?.articles ?? null, corrupt: r?.corrupt ?? false, error: null })
      },
      (err: unknown) => {
        if (alive) setExtraLoaded({ key: tenantId, list: [], corrupt: false, error: err instanceof Error ? err.message : String(err) })
      },
    )
    return () => {
      alive = false
    }
  }, [tenantId])
  const extraFresh = extraLoaded?.key === tenantId ? extraLoaded : null
  const extraArticles = extraFresh?.list ?? null
  // 이 주를 잰 판 — 불러온 은행이 그 판일 때만(주차를 바꾼 직후 앞 판의 은행이 남아 있을 수 있다). 모르거나 예시 은행이면 null:
  // 추가 글의 질문은 확인 불가가 되고, 새 추가 글은 만들 수 없다.
  const weekBankVersion = bankVersion && loadedBank && !loadedBank.demo && loadedBank.version === bankVersion ? bankVersion : null

  /** 성공하면 서버가 돌려준 목록(뺀 글 포함)으로 갈아 끼우고 null, 실패하면 이유. */
  const applyExtraResult = useCallback(
    (forTenant: string, r: ExtraArticleSaveResult): string | null => {
      if (currentTenant.current !== forTenant) return '브랜드가 바뀌어 결과를 버렸습니다.'
      if (!r.ok) return r.error
      setExtraLoaded({ key: forTenant, list: r.articles, corrupt: false, error: null })
      return null
    },
    [],
  )
  const createExtra = useCallback(
    async (input: Omit<NewExtraArticleInput, 'bankVersion' | 'createdWeek'>): Promise<string | null> => {
      if (!tenantId) return '브랜드가 정해지지 않았습니다.'
      if (!weekBankVersion) return '이 주를 측정한 질문 은행 판을 몰라 추가 글을 만들 수 없어요. 측정한 주에서 만들어 주세요.'
      return applyExtraResult(tenantId, await createExtraArticle(tenantId, { ...input, bankVersion: weekBankVersion, createdWeek: weekOf }))
    },
    [tenantId, weekBankVersion, weekOf, applyExtraResult],
  )
  const updateExtra = useCallback(
    async (patch: { id: string; name?: string; angle?: string; removed?: boolean }): Promise<string | null> => {
      if (!tenantId) return '브랜드가 정해지지 않았습니다.'
      return applyExtraResult(tenantId, await updateExtraArticle(tenantId, patch))
    },
    [tenantId, applyExtraResult],
  )

  const plan: GapActionPlan = useMemo(
    () =>
      computeGapActions(analyses, questions, citations, states ?? {}, published.posts ?? [], weekOf, {
        extraArticles: extraArticles ?? [],
        bankVersion: weekBankVersion,
      }),
    [analyses, questions, citations, states, published.posts, weekOf, extraArticles, weekBankVersion],
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
    /** 올린 글 주소를 적을 수 있는 환경인가(웹에서는 false). 원장을 읽다 실패해도 true다 — 이유는 posts.error에 있다. */
    canRecordPosts: statesReady && states !== null && published.available,
    /** 집행 원장 — 뺀 기록까지 모두. 화면이 「뺀 주소」로 접어 보이고 되살린다. */
    posts: {
      list: published.posts ?? [],
      busy: published.busy,
      error: published.error,
      record: recordPost,
      remove: published.remove,
      restore: published.restore,
      setPublishedOn: published.setPublishedOn,
      addEdit: published.addEdit,
      removeEdit: published.removeEdit,
    },
    /** 추가 글 — 사이드바 · 대시보드도 같은 훅이라 할 일 수가 화면마다 같다. */
    extras: {
      /** 뺀 글까지 모두(정의 순서). 기능이 없거나 아직 읽는 중이면 빈 목록. */
      list: extraArticles ?? [],
      /** 이 환경에서 추가 글을 쓸 수 있는가(웹은 false). 읽기 실패여도 true — 이유는 error에 있다. */
      available: extraArticles !== null,
      /** 파일이 깨져 빈 목록으로 읽었다 — 서버가 쓰기를 거절한다. */
      corrupt: extraFresh?.corrupt ?? false,
      error: extraFresh?.error ?? null,
      /** 새 추가 글이 기록할 이 주의 은행 판 — null이면(모름 · 예시 은행) 만들 수 없다. */
      bankVersion: weekBankVersion,
      /** 성공하면 null, 실패하면 서버가 준 이유(409 다른 글이 맡은 질문 · 10편 상한 등). 판 · 주차는 훅이 붙인다. */
      create: createExtra,
      /** 이름 · 각도 고치기, 목록에서 빼기(removed true) · 되살리기(false). 성공하면 null, 실패하면 이유. */
      update: updateExtra,
    },
  }
}
