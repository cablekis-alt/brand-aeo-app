export function formatPct(value: number): string {
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
