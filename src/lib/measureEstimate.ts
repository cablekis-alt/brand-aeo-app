/**
 * 측정 진행 표시의 남은 시간 어림(components/MeasureProgress.tsx) — 화면 부품 파일은 부품만 내보내야 해서(빠른 새로 고침) 따로 둔다.
 */

/** 진행 중인 줄 하나에서 어림에 쓰는 값 — /api/measure-status의 active 항목(MeasureProgress.tsx ActiveMeasure). */
export interface ProgressRow {
  stage?: string
  done?: number
  total?: number
  engines?: Record<string, { done: number; total: number }>
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
 * 수집 중인 줄들의 남은 시간 — 엔진마다 「남은 건수 × 그 엔진의 한 건당 시간」을 구해 가장 늦은 엔진을 쓴다.
 *
 * 수집 슬롯은 엔진마다 따로고 Perplexity는 분당 상한까지 있어(server/concurrency.ts) 엔진 속도가 몇 배씩 다르다.
 * 합친 건수로 어림하면 빠른 엔진이 끝낸 건수에 끌려 남은 시간이 몇 배 짧게 나왔다 — 2026-W43 6곳 측정에서 실제로
 * 6~13분 남았을 때 화면은 약 1분 30초였다. 엔진 건수가 없는 줄(옛 서버)이 있으면 undefined — 합친 어림으로 돌아간다.
 * 남은 엔진의 표본이 아직 적으면 null(틀린 숫자보다 없는 게 낫다).
 */
function collectionRemainingMs(active: ProgressRow[], elapsedMs: number): number | null | undefined {
  const collecting = active.filter((a) => a.stage === '수집')
  if (collecting.length === 0 || collecting.some((a) => !a.engines)) return undefined
  const sums = new Map<string, { done: number; left: number }>()
  for (const a of collecting) {
    for (const [engine, e] of Object.entries(a.engines ?? {})) {
      const sum = sums.get(engine) ?? { done: 0, left: 0 }
      sum.done += e.done
      sum.left += Math.max(0, e.total - e.done)
      sums.set(engine, sum)
    }
  }
  let worst = 0
  for (const { done, left } of sums.values()) {
    if (left <= 0) continue
    if (done < 5) return null
    worst = Math.max(worst, left * (elapsedMs / done))
  }
  return worst
}

/**
 * 남은 시간 어림 — 줄마다가 아니라 측정 전체로 본다.
 *
 * 줄마다 따로 어림했더니 틀린 숫자가 나왔다. 실측 화면에서 경과 31초에 24/72인 줄은
 * "~1분 1초", 5/72인 줄은 "~6분 49초"를 냈다. 둘은 비슷한 때에 끝나는데 6배가 벌어졌다.
 *
 * 줄의 진행 속도가 그 브랜드의 속도가 아니기 때문이다. 수집 호출은 엔진마다 슬롯을 모든 줄이
 * 나눠 쓰므로, 한 줄이 빠른 건 그 줄이 빨라서가 아니라 그 순간 슬롯을 더 받았기 때문이다.
 * 몫은 다른 줄이 끝나면 곧 바뀐다. 그래서 속도는 줄이 아니라 측정 전체에서 잰다.
 *
 * 아직 시작도 안 한 줄(0/72)의 일감까지 남은 일로 세므로, 뒤에 줄이 밀려 있어도 값이
 * 낮게 나오지 않는다. 수집 중이면 엔진별로 어림한다(collectionRemainingMs).
 */
export function overallRemainingMs(active: ProgressRow[], elapsedMs: number): number | null {
  // 단계를 아직 못 받은 줄이 있으면 그 줄의 일감을 알 수 없다 — 모르는 채로 어림하면
  // 남은 일을 통째로 빠뜨린다. 그 줄에 단계가 붙을 때까지 숫자를 내지 않는다.
  if (active.some((a) => !a.stage)) return null
  if (elapsedMs < 15_000) return null

  const byEngine = collectionRemainingMs(active, elapsedMs)
  if (byEngine === null) return null
  if (byEngine !== undefined) return byEngine * (1 + ANALYZE_SHARE)

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
