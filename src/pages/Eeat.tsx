import WeekPicker from '../components/WeekPicker'
import { useTenant } from '../context/useTenant'
import { loadEeat } from '../lib/api'
import { EEAT_PILLAR_LABEL, formatPct } from '../lib/format'
import { useScorecards } from '../lib/useScorecards'
import { useWeekSelection } from '../lib/useWeekSelection'
import { useWeeklyData } from '../lib/useWeeklyData'
import type { EeatPillarId } from '../prompts/b6-eeat'

const PILLARS: EeatPillarId[] = ['experience', 'expertise', 'authoritativeness', 'trustworthiness']

const EMPTY = {
  overall: 0,
  experience: { score: 0, evidence: [] },
  expertise: { score: 0, evidence: [] },
  authoritativeness: { score: 0, evidence: [] },
  trustworthiness: { score: 0, evidence: [] },
  mentionedCallCount: 0,
  totalCallCount: 0,
}

export default function Eeat() {
  const { tenant } = useTenant()
  const { history, loading: historyLoading } = useScorecards(tenant?.tenantId ?? '')
  const [weekOf, setWeekOf] = useWeekSelection(history)
  const { data, loading } = useWeeklyData(loadEeat, tenant?.tenantId ?? '', weekOf, EMPTY)

  if (!tenant) return null

  const pending = historyLoading || (history.length > 0 && (!weekOf || loading))
  const empty = !pending && data.totalCallCount === 0

  return (
    <>
      <p className="brand">S-09 · STAGE 3</p>
      <h1>EEAT 분석</h1>
      <p className="lead">
        답변 엔진이 이 브랜드를 경험·전문성·권위·신뢰 관점에서 어떻게 그리는지 봅니다. 점수는 B5 판정(언급 문장,
        인용, 사실성)에서 계산하며, 심판 모델이 새로 채점하지 않습니다.
      </p>

      <div className="filters">
        <WeekPicker weeks={history.map((h) => h.weekOf)} value={weekOf} onChange={setWeekOf} />
      </div>

      {pending && <p className="muted">불러오는 중…</p>}
      {!pending && empty && <p className="muted">이 주차에 저장된 판정 데이터가 없습니다.</p>}

      {!pending && !empty && (
        <>
          <section className="hero-card">
            <p className="eyebrow">
              {tenant.brandName} · 언급된 응답 {data.mentionedCallCount} / {data.totalCallCount}
            </p>
            <p className="total">
              EEAT 종합 <strong>{formatPct(data.overall)}</strong>
            </p>
          </section>

          <section className="metrics eeat-metrics">
            {PILLARS.map((id) => {
              const pillar = data[id]
              const meta = EEAT_PILLAR_LABEL[id]
              return (
                <article key={id}>
                  <h2>{meta.name}</h2>
                  <p>{formatPct(pillar.score)}</p>
                  <div className="eeat-bar" aria-hidden="true">
                    <span style={{ width: `${Math.round(pillar.score * 100)}%` }} />
                  </div>
                  <span>{meta.hint}</span>
                </article>
              )
            })}
          </section>

          {PILLARS.map((id) => {
            const pillar = data[id]
            if (pillar.evidence.length === 0) return null
            return (
              <section key={`${id}-evidence`}>
                <h3>{EEAT_PILLAR_LABEL[id].name} 근거</h3>
                <ul className="sentence-list">
                  {pillar.evidence.map((item) => (
                    <li key={item}>
                      <span className="sentence-text">{item}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
        </>
      )}
    </>
  )
}
