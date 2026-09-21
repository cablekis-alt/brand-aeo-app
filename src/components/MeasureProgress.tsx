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

/*
 * 분석 단계 몫. done/total은 **현재 단계**의 건수라, 수집이 끝나도 측정은 안 끝난다 —
 * 뒤에 인용 정리·분석·집계·리포트가 남는다. 그중 건수를 세는 건 분석뿐이다.
 *
 * 2026-W39 여섯 곳 실측에서 분석은 수집의 0.09~0.16배였다(중앙값 0.15). 판정 슬롯이
 * 144개로 수집 24개보다 훨씬 넉넉해 같은 건수라도 훨씬 빨리 지나간다.
 */
const ANALYZE_SHARE = 0.15

/**
 * 남은 시간 어림 — 전체를 한 덩어리로 본다.
 *
 * 줄마다 따로 어림했더니 틀린 숫자가 나왔다. 실측 화면에서 경과 31초에 24/72인 줄은
 * "~1분 1초", 5/72인 줄은 "~6분 49초"를 냈다. 둘은 비슷한 때에 끝나는데 6배가 벌어졌다.
 *
 * 줄의 진행 속도가 그 브랜드의 속도가 아니기 때문이다. 수집 호출은 전역 슬롯 24개를 모두가
 * 나눠 쓰므로, 한 줄이 빠른 건 그 줄이 빨라서가 아니라 그 순간 슬롯을 더 받았기 때문이다.
 * 몫은 다른 줄이 끝나면 곧 바뀐다. 그래서 속도는 줄이 아니라 측정 전체에서 잰다.
 *
 * 아직 시작도 안 한 줄(0/72)의 일감까지 남은 일로 세므로, 뒤에 줄이 밀려 있어도 값이
 * 낮게 나오지 않는다.
 */
function overallRemainingMs(active: ActiveMeasure[], elapsedMs: number): number | null {
  // 단계를 아직 못 받은 줄이 있으면 그 줄의 일감을 알 수 없다 — 모르는 채로 어림하면
  // 남은 일을 통째로 빠뜨린다. 그 줄에 단계가 붙을 때까지 숫자를 내지 않는다.
  if (active.some((a) => !a.stage)) return null

  let done = 0
  let left = 0
  for (const a of active) {
    done += a.done ?? 0
    left += Math.max(0, (a.total ?? 0) - (a.done ?? 0))
  }
  // 초반 표본으로 뽑은 기울기는 몇 배씩 틀린다 — 틀린 숫자는 없는 것보다 나쁘다.
  if (done < 10 || elapsedMs < 15_000 || left <= 0) return null

  const perCallMs = elapsedMs / done
  return left * perCallMs * (1 + ANALYZE_SHARE)
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
  const left = elapsed === null ? null : overallRemainingMs(active, elapsed)

  return (
    <>
      {elapsed !== null && (
        <p className="mp-elapsed">
          경과 <b>{formatDuration(elapsed)}</b>
          {left !== null && (
            <>
              <span className="muted"> · </span>남은 시간 약 <b>{formatDuration(left)}</b>
            </>
          )}
          <span className="muted"> · {active.length}곳 측정 중</span>
        </p>
      )}
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
    </>
  )
}
