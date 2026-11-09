import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import DraftPanel from '../components/DraftPanel'
import PublishedUrlEditor, { ExecutionStatusButtons } from '../components/PublishedUrlEditor'
import { useTenant } from '../context/useTenant'
import {
  generateContentBrief,
  loadActionStates,
  loadContentBriefs,
  loadContentDrafts,
  loadExtraArticles,
  loadQuestionBank,
  saveActionState,
  tagQuestionBankStages,
  tagQuestionBankTopics,
  type ActionStateMap,
  type ActionStatus,
  type StoredBrief,
  type StoredDraft,
  type TopicSnapshot,
} from '../lib/api'
import { assignedTopicSnapshot } from '../lib/contentLibraryOrder'
import { effectiveDraft } from '../lib/draftGaps'
import { recordOnlyHits, topicSnapshotFor, type GapAction } from '../lib/gapActions'
import { draftTitle } from '../lib/markdownFile'
import { writerArticle } from '../lib/probePlan'
import { usePublishedPosts } from '../lib/usePublishedPosts'
import { useProbePlan } from '../lib/useProbePlan'
import { STAGE_LABEL, stageOf } from '../lib/journeyStage'
import { isProbe, isScoredAgnostic } from '../lib/questionScope'
import type { QuestionBank, QuestionSpec } from '../lib/types'

/**
 * 고른 질문을 실행 항목 모양으로 감싼다.
 *
 * 브리프·초안 서버 경로는 실행 항목 **객체**가 아니라 title·questionTexts만 본다. 즉 측정이
 * 없어도 글은 쓸 수 있는데, 화면이 실행 항목에서만 시작하도록 만들어 둬서 막혀 있었다.
 * 측정이 더해 주는 것은 "어느 질문에서 지는가"라는 **우선순위 하나뿐**이고, 그게 없으면
 * 은행에서 고르면 된다. 우선순위를 모른다고 글까지 못 쓸 이유는 없다.
 *
 * id를 질문 id로 짓는 이유: 주차가 바뀌어도 같은 질문 묶음이면 같은 초안에 이어 붙어야 한다.
 * 집행 상태는 저장된 값을 쓴다 — 예전에는 늘 「할 일」로 고정돼 있었다.
 */
function actionFromQuestions(picked: QuestionSpec[], status: ActionStatus = 'todo'): GapAction {
  const ids = picked.map((q) => q.questionId).sort()
  const head = picked[0]?.text ?? ''
  return {
    id: `topic:${ids.join('+')}`,
    kind: 'content',
    title: picked.length === 1 ? head.slice(0, 40) : `질문 ${picked.length}개 묶음 글`,
    badge: '측정 전',
    evidence:
      `측정 없이 질문 ${picked.length}개를 직접 골라 만든 글입니다. ` +
      `어느 질문에서 밀리는지는 아직 모르므로 우선순위 근거는 없습니다.`,
    questionIds: ids,
    questionTexts: picked.map((q) => q.text),
    reach: picked.length,
    satisfied: false,
    status,
    publishedUrls: [],
    citedPublishedUrls: [],
    doneSignal: '다음 측정에서 이 질문들의 판정을 확인하세요',
  }
}

const CATEGORY_LABEL: Record<string, string> = {
  'category-agnostic': '카테고리 무관',
  'brand-direct': '브랜드 직접',
  comparison: '비교',
  'price-spec': '가격/스펙',
  'troubleshooting-review': '후기/문제해결',
  'local-regional': '지역 특화',
}

const CATEGORY_AGNOSTIC_TARGET = 0.6

/** 빈 선택 — 새 Set을 매번 만들면 파생값이 매 렌더 달라져 useMemo가 헛돈다. 읽기 전용으로 쓴다. */
const EMPTY_PICK: Set<string> = new Set<string>()

export default function QuestionBankPage() {
  const { tenant } = useTenant()
  const [bank, setBank] = useState<QuestionBank | null>(null)
  const [loading, setLoading] = useState(true)
  const [tagging, setTagging] = useState<string | null>(null)
  const [topicTagging, setTopicTagging] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  // 측정 없이 글쓰기 — 질문을 골라 바로 초안으로 간다.
  // 고른 질문에 브랜드 id를 함께 담는다. 브랜드가 바뀌면 effect에서 비우는 대신 **어긋난 것으로
  // 보고 무시한다** — 화면을 그리는 도중에 상태를 되돌리면 한 번 더 그려야 한다.
  const [pick, setPick] = useState<{ tid: string; ids: Set<string> }>({ tid: '', ids: new Set() })
  const picked = pick.tid === (tenant?.tenantId ?? '') ? pick.ids : EMPTY_PICK
  const setPicked = (next: (prev: Set<string>) => Set<string>) =>
    setPick((prev) => {
      const tid = tenant?.tenantId ?? ''
      return { tid, ids: next(prev.tid === tid ? prev.ids : EMPTY_PICK) }
    })
  const [briefs, setBriefs] = useState<Record<string, StoredBrief> | null>(null)
  const [drafts, setDrafts] = useState<Record<string, StoredDraft> | null>(null)
  // 올린 글 주소(집행 원장)와 집행 상태 — 질문을 골라 쓴 글(topic:)은 콘텐츠 생성의 올리기 목록에 나오지 않아 여기서 적는다.
  // 둘 다 데스크톱 · 로컬 전용이다(웹은 null → 칸을 숨긴다).
  const published = usePublishedPosts(tenant?.tenantId ?? '')
  const [statesState, setStatesState] = useState<{ key: string; value: ActionStateMap | null } | null>(null)
  const states = statesState && statesState.key === tenant?.tenantId ? statesState.value : null
  const [statusError, setStatusError] = useState<string | null>(null)
  // 작성자 배정 기간에는 여기서 글을 만들지 않는다 — 고른 질문으로 묶은 글은 배정표 밖 글이다(src/lib/probePlan.ts, 서버도 막는다).
  // 배정 파일이 없으면 지금과 같다.
  const probe = useProbePlan(tenant?.tenantId ?? '')
  const writeBlocked = probe.active
    ? `작성자 배정 기간(~${probe.active.activeUntil})에는 콘텐츠 생성의 배정표 글만 만들 수 있어요.`
    : probe.corrupt
      ? '배정 파일(probe-plan.json)이 깨져 있어 작성자 배정 글을 만들지 않아요. 관리자에게 확인을 요청해 주세요.'
      : null
  useEffect(() => {
    const id = tenant?.tenantId
    if (!id) return
    let alive = true
    void loadActionStates(id).then((m) => {
      if (alive) setStatesState({ key: id, value: m })
    })
    return () => {
      alive = false
    }
  }, [tenant?.tenantId])

  useEffect(() => {
    if (!tenant) return
    let cancelled = false
    setLoading(true)
    loadQuestionBank(tenant.tenantId)
      .then((next) => {
        if (!cancelled) setBank(next)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant, reloadKey])

  useEffect(() => {
    if (!tenant) return
    let alive = true
    void Promise.all([loadContentBriefs(tenant.tenantId), loadContentDrafts(tenant.tenantId)]).then(([b, d]) => {
      if (!alive) return
      setBriefs(b ?? {})
      setDrafts(d ?? {})
    })
    return () => {
      alive = false
    }
  }, [tenant])

  const pickedQuestions = useMemo(
    () => (bank?.questions ?? []).filter((q) => picked.has(q.questionId)),
    [bank, picked],
  )
  const action = pickedQuestions.length > 0 ? actionFromQuestions(pickedQuestions) : null
  const savedStatus = action ? (states?.[action.id]?.status ?? 'todo') : 'todo'
  // 배정을 받은 뒤에 적는다 — 배정 글인지에 따라 기록에 싣는 질문 스냅샷이 다르다(아래 onRecord).
  const canRecord = published.available && states !== null && probe.loaded
  const setStatus = async (status: ActionStatus) => {
    if (!tenant || !action) return
    const id = tenant.tenantId
    setStatusError(null)
    const saved = await saveActionState(id, action.id, status)
    // 그사이 브랜드를 바꿨으면 늦게 온 응답으로 새 브랜드의 상태를 덮지 않는다.
    setStatesState((prev) => (prev && prev.key !== id ? prev : saved ? { key: id, value: saved } : prev))
    if (!saved) setStatusError('상태를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.')
  }

  // 점수에 세는 문항으로만 낸다 — 실증 질문은 이름 없는 질문이지만 점수 밖이라, 넣으면 비율이 부풀어 하한(countAgnostic)과 어긋난다.
  const agnosticRatio = useMemo(() => {
    const scored = bank ? bank.questions.filter((q) => !isProbe(q)) : []
    if (scored.length === 0) return 0
    return scored.filter(isScoredAgnostic).length / scored.length
  }, [bank])
  // 실증 질문 수 — 문항 수 옆에 「실증 k개 포함」으로 밝힌다(점수 · 비율에는 들지 않는다).
  const probeCount = bank ? bank.questions.filter(isProbe).length : 0

  if (!tenant) return null

  return (
    <>
      <p className="brand">설정</p>
      <h1>질문 프롬프트 빌더</h1>
      <p className="lead">질문 은행을 확인합니다 — 카테고리 분포를 점검해 브랜드명 없이도 언급되는지를 측정합니다.</p>

      {loading && <p className="muted">불러오는 중…</p>}
      {!loading && !bank && <p className="muted">아직 생성된 질문 은행이 없습니다.</p>}
      {/* 측정 전 브랜드는 서버가 예시 은행(demo — 다른 업종의 견본)을 준다. 그 목록을 이 브랜드 질문처럼 보이거나 매기기 · 글쓰기에
          쓰면 헷갈리고 판정 비용만 든다(2026-10-21 군산각 v6 — 성형외과 견본이 보였다). 데스크톱 서버만 demo를 싣는다(웹은 예전 그대로). */}
      {!loading && bank?.demo && (
        <p className="hint">
          아직 이 브랜드의 질문지가 없습니다 — <b>첫 측정 때</b> {tenant.industry} · {tenant.region} 질문지({bank.version})가 만들어집니다.{' '}
          <Link to="/measure-tenant">브랜드·경쟁사 측정</Link>에서 측정하면 여기에 질문이 보이고, 질문을 골라 글을 쓸 수 있습니다.
        </p>
      )}

      {bank && !bank.demo && (
        <>
          {bank.upcomingVersion &&
            (bank.upcomingRegenerate ? (
              <p className="hint">
                ※ 지금 목록은 마지막 측정({bank.version}) 질문입니다. 다음 측정에서 {bank.upcomingVersion} 질문지를 새로 만들어요 — 경쟁사
                편집에서 브랜드 질문 {bank.upcomingRegenerate.brandCount}개를 모두 새로 쓰기로 했고, 공통 질문은 그대로예요. 주제 · 단계
                매기기는 그 측정 뒤에 할 수 있어요 — 지금 매기면 새 질문지에는 남지 않아요.
              </p>
            ) : bank.upcomingDerived ? (
              <p className="hint">
                ※ 지금 목록은 마지막 측정({bank.version}) 질문입니다. 다음 측정부터 {bank.upcomingVersion} 질문지를 씁니다 — 경쟁사를 바꾸며
                {bank.upcomingDerived.replaced ? ` 비교 질문 ${bank.upcomingDerived.replaced}개를 고쳐 썼고` : ''}
                {bank.upcomingDerived.removed ? ` ${bank.upcomingDerived.removed}개를 뺐고` : ''} 나머지 질문은 그대로입니다(경쟁사 편집).
                주제 · 단계 매기기는 그 측정 뒤에 할 수 있어요 — 지금 매기면 다음 측정이 쓰는 질문지에는 남지 않아요.
              </p>
            ) : (
              <p className="hint">
                ※ 지금 목록은 마지막 측정({bank.version}) 질문입니다. 다음 측정부터 {bank.upcomingVersion}(코호트 공유 질문지 +
                브랜드 전용 질문)로 바뀌고, 새 질문은 그 측정에서 만들어집니다.
              </p>
            ))}
          <section className="hero-card">
            <p className="eyebrow">
              버전 {bank.version} · {new Date(bank.generatedAt).toLocaleDateString('ko-KR')} 생성 · 질문{' '}
              {bank.questions.length}개{probeCount > 0 && `(실증 ${probeCount}개 포함)`}
            </p>
            <p className="total">
              카테고리 무관 비중 <strong>{(agnosticRatio * 100).toFixed(0)}%</strong>
              <span className={`delta ${agnosticRatio >= CATEGORY_AGNOSTIC_TARGET ? 'up' : 'down'}`}>
                기준 {CATEGORY_AGNOSTIC_TARGET * 100}%
              </span>
            </p>
            <p className="muted">
              이 비율이 낮으면 "물어보니까 답했다"만 측정하게 되어 실제 가시성과 점수가 어긋납니다.
            </p>
          </section>

          <section>
            <h3>질문 목록</h3>
            {bank.questions.some((q) => stageOf(q).inferred) && (
              <p className="hint" style={{ marginTop: 0 }}>
                구매 여정 단계(탐색·비교·결정)가 기록되지 않은 질문이{' '}
                <b>{bank.questions.filter((q) => stageOf(q).inferred).length}개</b> 있어 문장으로 추정해 보여줍니다.{' '}
                <button
                  type="button"
                  className="ghost"
                  disabled={tagging !== null || Boolean(bank.upcomingDerived || bank.upcomingRegenerate)}
                  onClick={async () => {
                    if (!tenant) return
                    setTagging('판정 중…')
                    try {
                      const r = await tagQuestionBankStages(tenant.tenantId, bank.version)
                      setTagging(`${r.taggedAfter - r.taggedBefore}개 매김 (${r.taggedAfter}/${r.total})`)
                      setReloadKey((k) => k + 1)
                    } catch (e) {
                      setTagging(e instanceof Error ? e.message : String(e))
                    }
                  }}
                >
                  {tagging ?? '단계 매기기 (판정 1회)'}
                </button>
              </p>
            )}
            {/* 미분류가 없어도 버튼을 남긴다 — 상호가 이름이 된 주제를 고치려면 다시 돌려야 하고,
                그때는 모든 질문에 주제가 있어 조건부로 숨기면 손댈 방법이 없어진다. */}
            <p className="hint" style={{ marginTop: 0 }}>
              {bank.questions.some((q) => !q.topic) ? (
                <>
                  콘텐츠 주제가 없는 질문이 <b>{bank.questions.filter((q) => !q.topic).length}개</b> 있습니다. 주제를
                  매기면 격차 분석이 "어떤 <b>내용</b>에서 밀리는지"를 보여줍니다. 카테고리는 질문의 형태라
                  보강할 콘텐츠를 정해 주지 못합니다.{' '}
                </>
              ) : (
                <>
                  모든 질문에 콘텐츠 주제가 있습니다. 다시 돌리면 상호가 이름이 된 주제만 걷어내고 그 질문을
                  다시 매깁니다.{' '}
                </>
              )}
              <button
                type="button"
                className="ghost"
                disabled={topicTagging !== null || Boolean(bank.upcomingDerived || bank.upcomingRegenerate)}
                onClick={async () => {
                  if (!tenant) return
                  setTopicTagging('판정 중…')
                  try {
                    const r = await tagQuestionBankTopics(tenant.tenantId, bank.version)
                    const dropped = r.brandTopicsDropped > 0 ? ` · 상호 주제 ${r.brandTopicsDropped}건 걷어냄` : ''
                    setTopicTagging(`${r.taggedAfter - r.taggedBefore}개 매김 · 주제 ${r.topics.length}개${dropped}`)
                    setReloadKey((k) => k + 1)
                  } catch (e) {
                    setTopicTagging(e instanceof Error ? e.message : String(e))
                  }
                }}
              >
                {topicTagging ?? '주제 매기기 (판정 1회)'}
              </button>
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 34 }}>고름</th>
                    <th className="cell-text">질문</th>
                    <th>ID</th>
                    <th className="cell-text">주제</th>
                    <th className="cell-text">카테고리</th>
                    <th>단계</th>
                    <th>브랜드명 포함</th>
                  </tr>
                </thead>
                <tbody>
                  {bank.questions.map((q) => {
                    const st = stageOf(q)
                    return (
                      <tr key={q.questionId}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`${q.text} 고르기`}
                            disabled={writeBlocked !== null}
                            checked={writeBlocked === null && picked.has(q.questionId)}
                            onChange={(e) =>
                              setPicked((prev) => {
                                const next = new Set(prev)
                                if (e.target.checked) next.add(q.questionId)
                                else next.delete(q.questionId)
                                return next
                              })
                            }
                          />
                        </td>
                        <td className="cell-text">
                          {q.text}
                          {isProbe(q) && (
                            <>
                              {' '}
                              <span className="status-pill st-info" title="우리 글이 AI 답에 인용되는지 보려고 덧붙인 실험 질문 — 측정은 하지만 점수 · 본 글에는 넣지 않습니다">
                                실증 · 점수 제외
                              </span>
                            </>
                          )}
                        </td>
                        <td>{q.questionId}</td>
                        <td className="cell-text">{q.topic ?? <span className="muted">미분류</span>}</td>
                        <td className="cell-text">{CATEGORY_LABEL[q.category] ?? q.category}</td>
                        <td>
                          {STAGE_LABEL[st.stage]}
                          {st.inferred && (
                            <span className="muted" title="은행에 기록이 없어 문장으로 추정한 값">
                              {' '}
                              (추정)
                            </span>
                          )}
                        </td>
                        <td>{q.containsBrandName ? 'O' : ''}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h3>고른 질문으로 글쓰기</h3>
            <p className="hint" style={{ marginTop: 0 }}>
              측정하지 않아도 글은 쓸 수 있습니다. 측정이 더해 주는 것은 <b>어느 질문에서 밀리는가</b>라는
              우선순위 하나뿐이라, 그게 없으면 은행에서 직접 고르면 됩니다. 브랜드 사실이 채워져 있을수록
              빈칸이 줄어듭니다 — <Link to="/brand-facts">브랜드 사실</Link>에서 브랜드 페이지로 한 번에 채울 수
              있습니다.
            </p>
            {writeBlocked ? (
              <p className="hint warn">
                {writeBlocked}
                {probe.active && (
                  <>
                    {' '}
                    <Link to="/gap-actions">콘텐츠 생성</Link>에서 만들어 주세요.
                  </>
                )}
              </p>
            ) : picked.size === 0 ? (
              <p className="muted">위 표에서 함께 다룰 질문을 고르세요. 한 편의 글로 덮을 수 있는 것끼리 묶으면 됩니다.</p>
            ) : (
              <>
                <div className="brief-bar" style={{ marginBottom: 8 }}>
                  <span className="st st-info">{picked.size}개 고름</span>
                  <button type="button" className="ghost" onClick={() => setPicked(() => new Set())}>
                    선택 비우기
                  </button>
                  <span className="doc-meta">
                    측정 전이라 우선순위 근거는 없습니다. 측정 뒤에는 <Link to="/gap-actions">실행 항목</Link>이
                    밀린 질문부터 짚어 줍니다.
                  </span>
                </div>
                <ul className="doc-meta" style={{ marginTop: 0 }}>
                  {pickedQuestions.map((q) => (
                    <li key={q.questionId}>{q.text}</li>
                  ))}
                </ul>
                {action && briefs !== null && drafts !== null && tenant && (
                  <DraftPanel
                    tenantId={tenant.tenantId}
                    action={{ ...action, status: savedStatus }}
                    publishHint="올린 뒤 아래 「올린 곳」에 주소를 적으세요"
                    hasBrief={Boolean(briefs[action.id])}
                    stored={drafts[action.id]}
                    onStored={(d) => setDrafts((prev) => ({ ...(prev ?? {}), [action.id]: d }))}
                    ensureBrief={async () => {
                      const b = await generateContentBrief(tenant.tenantId, {
                        actionId: action.id,
                        kind: action.kind,
                        title: action.title,
                        questionTexts: action.questionTexts,
                        evidence: action.evidence,
                      })
                      setBriefs((prev) => ({ ...(prev ?? {}), [action.id]: b }))
                    }}
                  />
                )}
                {action && drafts?.[action.id] && canRecord && (
                  <section className="post-section" aria-label="올린 곳">
                    <h4 style={{ margin: '12px 0 4px' }}>올린 곳</h4>
                    <p className="hint" style={{ marginTop: 0 }}>
                      이 글을 올린 주소와 올린 날, 겨냥한 질문을 기록해 둡니다 — 주차별 인용 결과는 이 기록으로 냅니다(결과 화면은
                      다음 단계에서 붙습니다). 질문 은행 판은 이 초안을 쓸 때의 판이라고 확인될 때만 함께 남깁니다(작성자 배정 글은
                      콘텐츠 보관함과 같은 배정 판으로 남깁니다).
                    </p>
                    <ExecutionStatusButtons label={action.title} status={savedStatus} onChange={(s) => void setStatus(s)} />
                    {statusError && <p className="error">{statusError}</p>}
                    {published.error && <p className="error">올린 글 기록: {published.error}</p>}
                    <PublishedUrlEditor
                      judged={false}
                      addLabel="올렸어요"
                      hits={recordOnlyHits((published.posts ?? []).filter((p) => p.targetActionId === action.id))}
                      removed={(published.posts ?? []).filter((p) => p.targetActionId === action.id && p.removedAt)}
                      weekOf=""
                      busy={published.busy}
                      onRecord={async (url, publishedOn, chosen) => {
                        const stored = drafts[action.id]
                        // 배정 글(작성자 배정에 있는 글 id)은 콘텐츠 보관함 · 주소 한꺼번에 등록 · CLI와 같은 질문 스냅샷 — 추가 글 정의의 판,
                        // 정의가 없으면(판 미확인) 배정 파일의 판(src/lib/contentLibraryOrder.ts assignedTopicSnapshot). 지금 은행 판을 실으면
                        // 같은 글이 적은 화면에 따라 발행 현황에서 올림 · 미확인 · 배정 밖으로 갈린다. 추가 글 목록을 읽지 못하면 어느 판인지
                        // 가를 수 없어 적지 않는다(주소 한꺼번에 등록과 같다).
                        let assigned: TopicSnapshot | null = null
                        if (writerArticle(probe.plan, action.id)) {
                          const unread = '추가 글 목록을 읽지 못해 이 글의 질문지 판을 확인하지 못했습니다 — 적지 않았습니다.'
                          let listed: Awaited<ReturnType<typeof loadExtraArticles>>
                          try {
                            listed = await loadExtraArticles(tenant.tenantId)
                          } catch (err) {
                            return `${unread} (${err instanceof Error ? err.message : String(err)})`
                          }
                          if (!listed || listed.corrupt) return unread
                          assigned = assignedTopicSnapshot(probe.plan, listed.articles, action.id)
                        }
                        const r = await published.record({
                          url,
                          articleId: action.id,
                          targetActionId: action.id,
                          via: 'direct',
                          articleTitle: stored ? draftTitle(effectiveDraft(stored)) : action.title,
                          ...(stored ? { draftGeneratedAt: stored.generatedAt } : {}),
                          publishedOn,
                          publishedOnChosen: chosen,
                          markDone: true,
                          // 질문 id의 뜻은 은행 판마다 바뀐다 — 배정 글이 아니면 지금 은행이 이 초안을 쓸 때의 판일 때만 판 · 문장을 고정한다.
                          topic: assigned ?? topicSnapshotFor(action.id, bank, stored?.generatedAt),
                        })
                        if (!r.ok) return r.error
                        if (r.states) setStatesState((prev) => (prev && prev.key !== tenant.tenantId ? prev : { key: tenant.tenantId, value: r.states! }))
                        return null
                      }}
                      onRemove={published.remove}
                      onRestore={published.restore}
                      onSetDate={published.setPublishedOn}
                      onAddEdit={(postId, editedOn) => published.addEdit(postId, { editedOn, ...(drafts[action.id] ? { draftGeneratedAt: drafts[action.id]!.generatedAt } : {}) })}
                      onRemoveEdit={published.removeEdit}
                    />
                  </section>
                )}
              </>
            )}
          </section>
        </>
      )}
    </>
  )
}
