import { useEffect, useMemo, useState } from 'react'
import { useTenant } from '../context/useTenant'
import { loadQuestionBank } from '../lib/api'
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
  }, [tenant])

  const agnosticRatio = useMemo(() => {
    if (!bank || bank.questions.length === 0) return 0
    const agnostic = bank.questions.filter((q) => q.category === 'category-agnostic').length
    return agnostic / bank.questions.length
  }, [bank])

  if (!tenant) return null

  return (
    <>
      <p className="brand">B-03 · AEO 최적화</p>
      <h1>질문 프롬프트 빌더</h1>
      <p className="lead">B1 질문 은행을 확인합니다 — 카테고리 분포를 점검해 브랜드명 없이도 언급되는지를 측정합니다.</p>

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
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>질문</th>
                    <th>ID</th>
                    <th>카테고리</th>
                    <th>브랜드명 포함</th>
                  </tr>
                </thead>
                <tbody>
                  {bank.questions.map((q) => (
                    <tr key={q.questionId}>
                      <td>{q.text}</td>
                      <td>{q.questionId}</td>
                      <td>{CATEGORY_LABEL[q.category] ?? q.category}</td>
                      <td>{q.containsBrandName ? 'O' : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </>
  )
}
