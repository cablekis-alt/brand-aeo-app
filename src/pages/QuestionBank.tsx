import { useEffect, useMemo, useState } from 'react'
import { useTenant } from '../context/useTenant'
import { loadQuestionBank, tagQuestionBankStages, tagQuestionBankTopics } from '../lib/api'
import { STAGE_LABEL, stageOf } from '../lib/journeyStage'
import type { QuestionBank } from '../lib/types'

const CATEGORY_LABEL: Record<string, string> = {
  'category-agnostic': '카테고리 무관',
  'brand-direct': '브랜드 직접',
  comparison: '비교',
  'price-spec': '가격/스펙',
  'troubleshooting-review': '후기/문제해결',
  'local-regional': '지역 특화',
}

const CATEGORY_AGNOSTIC_TARGET = 0.6

export default function QuestionBankPage() {
  const { tenant } = useTenant()
  const [bank, setBank] = useState<QuestionBank | null>(null)
  const [loading, setLoading] = useState(true)
  const [tagging, setTagging] = useState<string | null>(null)
  const [topicTagging, setTopicTagging] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

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

  const agnosticRatio = useMemo(() => {
    if (!bank || bank.questions.length === 0) return 0
    const agnostic = bank.questions.filter((q) => q.category === 'category-agnostic').length
    return agnostic / bank.questions.length
  }, [bank])

  if (!tenant) return null

  return (
    <>
      <p className="brand">설정</p>
      <h1>질문 프롬프트 빌더</h1>
      <p className="lead">질문 은행을 확인합니다 — 카테고리 분포를 점검해 브랜드명 없이도 언급되는지를 측정합니다.</p>

      {loading && <p className="muted">불러오는 중…</p>}
      {!loading && !bank && <p className="muted">아직 생성된 질문 은행이 없습니다.</p>}

      {bank && (
        <>
          <section className="hero-card">
            <p className="eyebrow">
              버전 {bank.version} · {new Date(bank.generatedAt).toLocaleDateString('ko-KR')} 생성 · 질문{' '}
              {bank.questions.length}개
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
                  disabled={tagging !== null}
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
            {bank.questions.some((q) => !q.topic) && (
              <p className="hint" style={{ marginTop: 0 }}>
                콘텐츠 주제가 없는 질문이 <b>{bank.questions.filter((q) => !q.topic).length}개</b> 있습니다. 주제를
                매기면 격차 분석이 "어떤 <b>내용</b>에서 밀리는지"를 보여줍니다 — 카테고리는 질문의 형태라
                보강할 콘텐츠를 정해 주지 못합니다.{' '}
                <button
                  type="button"
                  className="ghost"
                  disabled={topicTagging !== null}
                  onClick={async () => {
                    if (!tenant) return
                    setTopicTagging('판정 중…')
                    try {
                      const r = await tagQuestionBankTopics(tenant.tenantId, bank.version)
                      setTopicTagging(`${r.taggedAfter - r.taggedBefore}개 매김 · 주제 ${r.topics.length}개`)
                      setReloadKey((k) => k + 1)
                    } catch (e) {
                      setTopicTagging(e instanceof Error ? e.message : String(e))
                    }
                  }}
                >
                  {topicTagging ?? '주제 매기기 (판정 1회)'}
                </button>
              </p>
            )}
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>질문</th>
                    <th>ID</th>
                    <th>주제</th>
                    <th>카테고리</th>
                    <th>단계</th>
                    <th>브랜드명 포함</th>
                  </tr>
                </thead>
                <tbody>
                  {bank.questions.map((q) => {
                    const st = stageOf(q)
                    return (
                      <tr key={q.questionId}>
                        <td>{q.text}</td>
                        <td>{q.questionId}</td>
                        <td>{q.topic ?? <span className="muted">미분류</span>}</td>
                        <td>{CATEGORY_LABEL[q.category] ?? q.category}</td>
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
        </>
      )}
    </>
  )
}
