import type { CategoryId } from './types.ts'

// aeocheck.co.kr의 공개 가중치와 동일한 6개 영역·배점(합 100).
export const CATEGORY_DEFS: { id: CategoryId; name: string; max: number }[] = [
  { id: 'crawler', name: 'AI 크롤러 접근·색인', max: 26 },
  { id: 'content', name: '콘텐츠 구조·인용 친화도', max: 22 },
  { id: 'eeat', name: 'E-E-A-T·최신성·신뢰', max: 18 },
  { id: 'structured', name: '구조화 데이터 (JSON-LD)', max: 15 },
  { id: 'technical', name: '기술 기본기', max: 12 },
  { id: 'agent', name: '에이전트 접근성', max: 7 },
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
