import { useEffect, useState } from 'react'

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
 * 1초마다 현재 시각. 진행 폴링은 5초 간격이라 그 주기로 경과를 그리면 시계가 멈춘 것처럼 보인다.
 * 경과는 startedAt만 있으면 화면에서 셀 수 있으므로 서버를 더 부르지 않는다.
 */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])
  return now
}

/** "3분 12초" · "45초". 시간 단위는 쓰지 않는다 — 측정은 분으로 세는 편이 읽기 쉽다. */
function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec}초`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return s ? `${m}분 ${s}초` : `${m}분`
}

/**
 * 남은 시간 어림 — 이 줄이 시작한 뒤의 속도가 그대로 이어진다고 본다.
 *
 * 줄마다 자기 startedAt으로 따로 센다. 전체 진행을 한 번에 어림하면 먼저 끝난 브랜드가
 * 목록에서 빠질 때 그 브랜드가 쓴 시간은 경과에 남고 진행만 사라져 값이 갑자기 부풀어 오른다.
 *
 * 초반에는 내지 않는다. 처음 몇 건은 엔진 응답이 들쭉날쭉한 구간이라 거기서 뽑은 기울기는
 * 몇 배씩 틀린다 — 틀린 숫자는 아무 숫자도 없는 것보다 나쁘다.
 */
function remainingMs(a: ActiveMeasure, now: number): number | null {
  const done = a.done ?? 0
  const total = a.total ?? 0
  if (!total || done < 3 || done >= total) return null
  const elapsed = now - Date.parse(a.startedAt)
  // Date.parse가 실패하면 NaN — isFinite가 걸러 낸다.
  if (!Number.isFinite(elapsed) || elapsed < 10_000) return null
  return (elapsed / done) * (total - done)
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
  const now = useNow()
  if (active.length === 0) return null

  // 여러 줄이 거의 동시에 시작하므로(코호트를 함께 재면 startedAt이 밀리초 차이다) 경과는
  // 줄마다 반복하지 않고 가장 먼저 시작한 시각 기준으로 위에 한 번만 낸다.
  const starts = active.map((a) => Date.parse(a.startedAt)).filter((t) => Number.isFinite(t))
  const elapsed = starts.length ? now - Math.min(...starts) : null

  return (
    <>
      {elapsed !== null && (
        <p className="mp-elapsed">
          경과 <b>{formatDuration(elapsed)}</b>
          <span className="muted"> · {active.length}곳 측정 중</span>
        </p>
      )}
      <ul className="measure-progress">
        {active.map((p) => {
          const left = remainingMs(p, now)
          return (
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
              {/* 어림이라는 것을 물결표로 알린다. 못 낼 때는 칸만 비워 줄 간 정렬을 지킨다. */}
              <span className="mp-eta">{left === null ? '' : `~${formatDuration(left)}`}</span>
            </li>
          )
        })}
      </ul>
    </>
  )
}
