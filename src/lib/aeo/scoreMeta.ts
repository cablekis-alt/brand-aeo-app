import type { CategoryId } from './types.ts'

export const CATEGORY_DEFS: { id: CategoryId; name: string; max: number }[] = [
  { id: 'accessibility', name: '접근성과 수집 가능성', max: 15 },
  { id: 'answer_content', name: '질문 대응력과 콘텐츠 완결성', max: 20 },
  { id: 'structure', name: '구조와 기계 가독성', max: 15 },
  { id: 'trust', name: '신뢰성·전문성·최신성', max: 20 },
  { id: 'citability', name: '인용 가능성과 정보 고유성', max: 20 },
  { id: 'entity', name: '엔터티·브랜드 명확성과 연결성', max: 10 },
]

export function scoreBand(total: number | null): string | null {
  if (total === null) return null
  if (total >= 85) return 'AI 인용 준비도가 높음'
  if (total >= 70) return '양호하지만 보완 필요'
  if (total >= 50) return '부분적으로 준비됨'
  if (total >= 30) return '주요 개선 필요'
  return '기초부터 재정비 필요'
}

export function areaQuality(score: number, max: number): string {
  const pct = max <= 0 ? 0 : (score / max) * 100
  if (pct >= 90) return '매우 우수'
  if (pct >= 75) return '양호'
  if (pct >= 60) return '보통'
  if (pct >= 40) return '미흡'
  return '매우 미흡'
}

export const SEVERITY_KO = {
  critical: '치명적',
  high: '높음',
  medium: '중간',
  low: '낮음',
} as const
