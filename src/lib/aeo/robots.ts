// AEO에서 실제로 중요한 크롤러는 "답변·검색" 봇이다(라이브 인용·노출을 만든다).
// 학습(training) 봇 차단은 노출에 거의 영향이 없어 가볍게 본다. aeocheck도 이 구분을 반영한다.
const SEARCH_BOTS = [
  'OAI-SearchBot',
  'ChatGPT-User',
  'PerplexityBot',
  'Perplexity-User',
  'Claude-User',
  'Claude-SearchBot',
  'Gemini-Deep-Research',
  'Google-Extended',
  'Applebot',
  'Bingbot',
]
const TRAINING_BOTS = ['GPTBot', 'ClaudeBot', 'CCBot', 'Bytespider', 'Google-CloudVertexBot', 'Meta-ExternalAgent']

interface Group {
  agents: string[]
  allows: string[]
  disallows: string[]
}

function matchPath(rule: string, path: string): boolean {
  if (!rule) return false
  if (rule === '/') return true
  const normalized = rule.endsWith('$')
    ? rule.slice(0, -1)
    : rule.endsWith('*')
      ? rule.slice(0, -1)
      : rule
  if (rule.endsWith('$')) return path === normalized
  return path.startsWith(normalized)
}

export function parseRobotsTxt(text: string): Group[] {
  const groups: Group[] = []
  let current: Group | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const key = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()
    if (key === 'user-agent') {
      if (!current || current.allows.length || current.disallows.length) {
        current = { agents: [value], allows: [], disallows: [] }
        groups.push(current)
      } else {
        current.agents.push(value)
      }
    } else if (current && key === 'allow') {
      current.allows.push(value)
    } else if (current && key === 'disallow') {
      current.disallows.push(value)
    }
  }
  return groups
}

/** 특정 user-agent가 경로에 접근 가능한지 — robots.txt 규칙대로 "가장 구체적인 그룹"을 적용한다. */
function agentAllowedForPath(groups: Group[], agent: string, path: string): boolean {
  // 정확히 일치하는 그룹이 있으면 그것만 본다(spec). 없으면 '*' 그룹으로 폴백.
  const group =
    groups.find((g) => g.agents.some((a) => a.toLowerCase() === agent.toLowerCase())) ??
    groups.find((g) => g.agents.some((a) => a === '*'))
  if (!group) return true // 이 봇에 적용되는 규칙이 없음 → 허용
  const disallow = group.disallows.find((r) => matchPath(r, path))
  if (!disallow) return true
  const allow = group.allows.find((r) => matchPath(r, path))
  // 더 구체적(같거나 긴)인 Allow가 있으면 허용이 이긴다.
  return Boolean(allow && allow.length >= disallow.length)
}

export interface RobotsAiAccess {
  searchBlocked: string[]
  trainingBlocked: string[]
  searchTotal: number
  trainingTotal: number
}

/**
 * robots.txt가 AI 답변·검색 크롤러와 학습 크롤러의 이 경로 접근을 얼마나 막는지 봇 단위로 계산한다.
 * 와일드카드(User-agent: *)로 학습봇만 막고 답변봇은 각자 Allow하는 흔한 구성을
 * "전면 차단"으로 오판하지 않도록, 봇마다 가장 구체적인 그룹을 적용한다.
 */
export function robotsAiAccess(robotsTxt: string, pageUrl: string): RobotsAiAccess | null {
  if (!robotsTxt.trim()) return null
  let path = '/'
  try {
    path = new URL(pageUrl).pathname || '/'
  } catch {
    path = '/'
  }
  const groups = parseRobotsTxt(robotsTxt)
  return {
    searchBlocked: SEARCH_BOTS.filter((b) => !agentAllowedForPath(groups, b, path)),
    trainingBlocked: TRAINING_BOTS.filter((b) => !agentAllowedForPath(groups, b, path)),
    searchTotal: SEARCH_BOTS.length,
    trainingTotal: TRAINING_BOTS.length,
  }
}
