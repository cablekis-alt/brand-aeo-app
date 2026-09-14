/**
 * 진행 중인 측정을 보여 주는 공용 부품.
 *
 * 서버(/api/measure-status)가 단계·건수를 주는데 화면마다 따로 그리면 표시가 갈린다 —
 * 실제로 온보딩만 막대를 그리고 「측정 상태」 화면은 "측정 중…"만 띄우는 역전이 생겼다.
 * 측정을 보라고 만든 화면이 덜 보여 주면 앞뒤가 안 맞는다. 그래서 타입과 렌더를 한곳에 둔다.
 */

/** /api/measure-status의 active 항목. stage 이후는 v0.2.5부터라 옛 서버에는 없다. */
export interface ActiveMeasure {
  tenantId: string
  brandName: string
  startedAt: string
  stage?: string
  done?: number
  total?: number
}

/**
 * 한 줄로 줄인 진행 상태 — 버튼·표 칸처럼 자리가 좁은 곳에 쓴다.
 * 건수가 없는 단계(인용 정리·집계·리포트)는 단계 이름만 낸다.
 */
export function measureStageLabel(a: ActiveMeasure): string {
  const stage = a.stage ?? '준비'
  return a.total ? `${stage} ${a.done ?? 0}/${a.total}` : stage
}

/** 브랜드마다 한 줄. 코호트를 함께 재면 여러 줄이 선다. */
export default function MeasureProgress({ active }: { active: ActiveMeasure[] }) {
  if (active.length === 0) return null
  return (
    <ul className="measure-progress">
      {active.map((p) => (
        <li key={p.tenantId}>
          <span className="mp-name">{p.brandName || p.tenantId}</span>
          <span className="mp-stage">{p.stage ?? '준비'}</span>
          {p.total ? (
            <>
              <span className="mp-bar" aria-hidden="true">
                <i style={{ width: `${Math.round(((p.done ?? 0) / p.total) * 100)}%` }} />
              </span>
              <span className="mp-count">
                {p.done ?? 0}/{p.total}
              </span>
            </>
          ) : (
            <>
              <span className="mp-bar" aria-hidden="true" />
              <span className="mp-count muted">…</span>
            </>
          )}
        </li>
      ))}
    </ul>
  )
}
