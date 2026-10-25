import { comparableWith } from './comparability'
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
 * 인용 갭 분석 · 정기진단 보고서 숫자 칸의 「전주 대비」 — 비교 가능 여부는 앱 전체 규칙 하나(comparability.ts comparableWith)를 쓴다
 * (수집 엔진 · 판정 엔진 · 수집 모델 · 판정 모델 · 질문지 · 반복 횟수, 한쪽에만 기록이 있으면 확인 불가). 예전에는 여기서만 따로
 * 수집 엔진과 모델만 봐서, 질문지 · 반복 횟수가 바뀐 주에도 증감을 보였다(실측 mercury W38→W40 질문지 v4→v7 · 반복 3→1회).
 * 앞 측정 = 이력에서 이번 주보다 앞선 가장 최근 측정. engine을 주면 두 측정 모두 그 엔진을 썼는지, 수집 모델은 그 엔진 것만 본다.
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
  if (!current) {
    return {
      previousWeekOf: previous.weekOf,
      comparable: false,
      reason: '이번 주 측정 기록을 찾지 못해 비교하지 않음',
      previousEngines,
      currentEngines,
      filterHelps: false,
    }
  }
  const c = comparableWith(sorted, weekOf, { engine })
  if (c.comparable) return { previousWeekOf: previous.weekOf, comparable: true, previousEngines, currentEngines }
  // 엔진 하나로 좁힌 표에서 그 엔진 응답이 한쪽에 없으면 그것이 이유다 — 조건 목록보다 바로 읽힌다.
  const missingEngine =
    engine && previousEngines.length > 0 && currentEngines.length > 0 && (!previousEngines.includes(engine) || !currentEngines.includes(engine))
  // 「엔진 필터로 한 엔진만 고르면 비교가 살아난다」는 다른 점이 수집 엔진 구성뿐이고 두 주에 함께 있는 엔진이 있을 때만 맞다 —
  // 질문지 · 판정이 바뀌었거나 기록이 없는 주에 그 안내를 하면 필터를 골라도 여전히 「비교 불가」다.
  const filterHelps =
    !engine &&
    c.diffs.length > 0 &&
    c.diffs.every((d) => d.dimension === '수집 엔진' && d.state === 'changed') &&
    previousEngines.some((e) => currentEngines.includes(e))
  return {
    previousWeekOf: previous.weekOf,
    comparable: false,
    reason: missingEngine
      ? `직전 측정(${previous.weekOf})${previousEngines.includes(engine) ? '과 달리 이번 주' : ''}에 ${ENGINE_LABEL[engine] ?? engine} 응답이 없어 비교하지 않음`
      : c.reason,
    previousEngines,
    currentEngines,
    filterHelps,
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
