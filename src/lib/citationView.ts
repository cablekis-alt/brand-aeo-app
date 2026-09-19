import { ENGINE_LABEL } from './format'
import type { CitationComparison } from './types'
import type { WeeklyScorecard } from '../prompts/b8-report'

/**
 * URL 상세 분석·인용 갭 분석이 함께 쓰는 표 규칙(상수·순수 함수).
 * 컴포넌트는 src/components/CitationBits.tsx에 있다 — react-refresh가 한 파일에 컴포넌트와
 * 함수를 섞어 export하는 걸 막아서 둘로 나눴다.
 */

/** 출처 유형 배지 색 — 자사·경쟁사만 색, 나머지는 회색. 표에서 눈이 먼저 가야 할 곳은 "우리와 경쟁사가 어디 있나"다. */
export const KIND_PILL: Record<string, string> = {
  'brand-official': 'st-good',
  competitor: 'st-bad',
  news: 'st-info',
  gov: 'st-info',
  wiki: 'st-info',
  review: 'st-ok',
  forum: 'st-ok',
  social: 'st-ok',
  blog: 'st-ok',
  other: 'st-unknown',
}

/**
 * 클라이언트에서 전주를 고르고 비교 가능 여부를 정한다 — server/queries.ts의 규칙과 같다.
 * 전주 = 이력에서 이번 주보다 앞선 가장 최근 주차. 엔진 필터가 있으면 두 주가 모두 그 엔진을 썼는지,
 * 없으면 엔진 집합이 같은지 본다. enginesUsed가 비어 있으면(옛 카드) 비교 불가로 둔다 — 모르는 걸 같다고 치지 않는다.
 */
export function comparisonFromHistory(
  history: WeeklyScorecard[],
  weekOf: string,
  engine: string | null,
): CitationComparison | null {
  const sorted = [...history].sort((a, b) => a.weekOf.localeCompare(b.weekOf))
  const current = sorted.find((c) => c.weekOf === weekOf)
  const previous = [...sorted].reverse().find((c) => c.weekOf < weekOf)
  if (!previous) return null
  const previousEngines = [...(previous.enginesUsed ?? [])].sort()
  const currentEngines = [...(current?.enginesUsed ?? [])].sort()
  if (previousEngines.length === 0 || currentEngines.length === 0) {
    return {
      previousWeekOf: previous.weekOf,
      comparable: false,
      reason: '수집 엔진 기록이 없는 주차라 비교 불가',
      previousEngines,
      currentEngines,
    }
  }
  const comparable = engine
    ? previousEngines.includes(engine) && currentEngines.includes(engine)
    : previousEngines.length === currentEngines.length && previousEngines.every((e, i) => e === currentEngines[i])
  if (comparable) return { previousWeekOf: previous.weekOf, comparable: true, previousEngines, currentEngines }
  const label = (list: string[]) => list.map((e) => ENGINE_LABEL[e] ?? e).join('+') || '없음'
  return {
    previousWeekOf: previous.weekOf,
    comparable: false,
    reason: engine
      ? `전주(${previous.weekOf})에 ${ENGINE_LABEL[engine] ?? engine} 응답이 없어 비교 불가`
      : `수집 엔진이 달라 비교 불가 — 전주 ${label(previousEngines)} · 이번 주 ${label(currentEngines)}`,
    previousEngines,
    currentEngines,
  }
}

/** 해시·추적 파라미터(utm_*, fbclid, gclid, si)를 뗀 URL — server/citationSources.canonicalUrl과 같은 규칙. */
export function tidyUrl(raw: string): string {
  try {
    const url = new URL(raw)
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|si$)/i.test(key)) url.searchParams.delete(key)
    }
    return url.toString()
  } catch {
    return raw
  }
}
