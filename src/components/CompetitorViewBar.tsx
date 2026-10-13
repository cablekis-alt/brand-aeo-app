import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTenant } from '../context/useTenant'
import { loadPortfolio, type PortfolioCohort } from '../lib/api'
import { directionParticle } from '../lib/korean'
import { cohortOfCompetitor } from '../lib/portfolioView'

/**
 * 경쟁사 보기(읽기 전용) 띠 — 화면 맨 위(상용화 UI 10차 시안).
 *
 * 지금 누구를 보고 있는지 놓치지 않게 어두운 띠로 둔다. 같은 코호트의 다른 경쟁사로 바로 옮기는 칩과,
 * 고른 고객 브랜드로 돌아가는 버튼이 있다. 측정 · 콘텐츠 생성 같은 화면은 사이드바에서 잠긴다.
 */
export default function CompetitorViewBar() {
  const { viewing, customer, viewCompetitor, exitCompetitorView } = useTenant()
  const navigate = useNavigate()
  const [cohorts, setCohorts] = useState<PortfolioCohort[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!viewing || cohorts) return
    let alive = true
    void loadPortfolio().then((p) => {
      if (alive) setCohorts(p?.cohorts ?? [])
    })
    return () => {
      alive = false
    }
  }, [viewing, cohorts])

  if (!viewing) return null
  const cohort = cohorts ? cohortOfCompetitor(cohorts, viewing.tenantId, customer?.tenantId) : null
  const others = (cohort?.members ?? []).filter((m) => m.competitor)

  const go = (id: string) => {
    setError(null)
    viewCompetitor(id).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  return (
    <div className="cv-bar" role="status">
      <span className="cv-tag">경쟁사 보기 · 읽기 전용</span>
      <span className="cv-text">
        {customer ? `${customer.brandName}의 비교 대상입니다. ` : ''}측정 · 콘텐츠 생성은 고객 브랜드에서만 합니다.
        {cohort && <span className="cv-cohort"> {cohort.industry} · {cohort.region} · {cohort.weekOf.replace(/^\d{4}-/, '')}</span>}
      </span>
      {others.length > 0 && (
        <span className="cv-chips" aria-label="같은 코호트의 경쟁사">
          {others.map((m) => (
            <button
              key={m.tenantId}
              type="button"
              className={`cv-chip${m.tenantId === viewing.tenantId ? ' on' : ''}`}
              aria-current={m.tenantId === viewing.tenantId || undefined}
              onClick={() => go(m.tenantId)}
            >
              {m.rank} {m.brandName} {m.score}
            </button>
          ))}
        </span>
      )}
      <button
        type="button"
        className="cv-back"
        onClick={() => {
          exitCompetitorView()
          navigate('/')
        }}
      >
        ← {directionParticle(customer?.brandName ?? '고객 브랜드')} 돌아가기
      </button>
      {error && <span className="cv-error">{error}</span>}
    </div>
  )
}
