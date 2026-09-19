import { ENGINE_LABEL } from '../lib/format'
import type { CitationComparison } from '../lib/types'

/**
 * URL 상세 분석·인용 갭 분석이 함께 쓰는 표 컴포넌트.
 *
 * 두 화면이 같은 규칙("수집 엔진이 같은 주차에서만 비교", "일간 잡음 위에 화살표를 그리지 않는다")을
 * 따라야 하는데, 각자 구현하면 문구·문턱이 조금씩 갈린다. 여기 한 곳에 둔다.
 * 상수·순수 함수(KIND_PILL, comparisonFromHistory, tidyUrl)는 src/lib/citationView.ts에 있다.
 */

/**
 * 전주 대비 점유율 변화(%p). 비교 가능한 주차에서만 숫자를 그린다.
 * 엔진이 다르면 「—」이고, 그 이유는 ComparisonNote가 말한다. 전주에 없던 도메인은 「신규」.
 */
export function ShareDelta({
  share,
  previousShare,
  comparable,
}: {
  share: number
  previousShare: number | null | undefined
  comparable: boolean
}) {
  if (!comparable || previousShare === null || previousShare === undefined) return <span className="muted">—</span>
  if (previousShare === 0) return <span className="status-pill st-info">신규</span>
  const delta = (share - previousShare) * 100
  if (Math.abs(delta) < 0.05) return <span className="muted">0.0%p</span>
  const cls = delta > 0 ? 'st-good' : 'st-bad'
  return (
    <span className={`status-pill ${cls}`}>
      {delta > 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(1)}%p
    </span>
  )
}

/** 표 위 한 줄 — 전주와 비교 가능한지, 아니면 왜 아닌지. */
export function ComparisonNote({ comparison }: { comparison: CitationComparison | null }) {
  if (!comparison) return <p className="muted">전주 측정이 없어 변화는 표시하지 않습니다.</p>
  if (comparison.comparable) {
    return (
      <p className="muted">
        전주 대비는 {comparison.previousWeekOf} 기준 · 수집 엔진 동일(
        {comparison.currentEngines.map((e) => ENGINE_LABEL[e] ?? e).join('+')})
      </p>
    )
  }
  return (
    <p className="muted">
      <span className="status-pill st-warn">비교 불가</span> {comparison.reason} — 엔진 필터로 한 엔진만 고르면 그 엔진이 두 주에
      모두 있을 때 비교가 살아납니다.
    </p>
  )
}

/** URL 표시용 — 너무 길면 줄이고 title로 전체를 준다. */
export function UrlLink({ url, max = 90 }: { url: string; max?: number }) {
  return (
    <a href={url} target="_blank" rel="noreferrer noopener" title={url}>
      {url.length > max ? `${url.slice(0, max)}…` : url}
    </a>
  )
}
