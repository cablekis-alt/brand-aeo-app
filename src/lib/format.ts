export function formatPct(value: number | null): string {
  if (value === null) return '판정 불가'
  return `${(value * 100).toFixed(1)}%`
}

export function formatDelta(current: number, previous: number): { text: string; tone: 'up' | 'down' | 'flat' } {
  const delta = current - previous
  if (delta === 0) return { text: '보합', tone: 'flat' }
  const sign = delta > 0 ? '+' : ''
  return { text: `${sign}${delta}`, tone: delta > 0 ? 'up' : 'down' }
}

export function formatRank(rank: number | null): string {
  return rank === null ? '판정 불가' : rank.toFixed(1)
}

export function weekLabel(weekOf: string): string {
  const match = weekOf.match(/(\d{4})-W(\d{2})/)
  if (!match) return weekOf
  return `${match[1]}년 ${Number(match[2])}주차`
}

export const ENGINE_LABEL: Record<string, string> = {
  openai: 'ChatGPT',
  gemini: 'Gemini',
  claude: 'Claude',
  perplexity: 'Perplexity',
}

export const OWNER_TYPE_LABEL: Record<string, string> = {
  'brand-owned': '자사',
  'competitor-owned': '경쟁사',
  'third-party-authority': '제3자 권위',
  'third-party-ugc': '제3자 UGC',
  unknown: '알 수 없음',
}

export const SOURCE_KIND_LABEL: Record<string, string> = {
  'brand-official': '자사 공식',
  competitor: '경쟁사',
  news: '뉴스·언론',
  gov: '공공기관',
  wiki: '위키',
  review: '후기 플랫폼',
  forum: '포럼',
  social: '소셜',
  blog: '블로그',
  other: '기타',
}

export const EEAT_PILLAR_LABEL: Record<string, { name: string; hint: string }> = {
  experience: { name: 'Experience', hint: '실제 이용·후기처럼 그려지는 정도' },
  expertise: { name: 'Expertise', hint: '전문성·자격·원장 등 전문가 신호' },
  authoritativeness: { name: 'Authoritativeness', hint: '권위 있는 제3자·1위 추천' },
  trustworthiness: { name: 'Trustworthiness', hint: '사실성·부정 어조·공식 출처' },
}
