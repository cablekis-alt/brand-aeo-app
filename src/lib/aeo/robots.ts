const BOTS = ['GPTBot', 'Google-Extended', 'ClaudeBot', 'PerplexityBot', 'CCBot', '*']

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

export function robotsBlocksPath(
  robotsTxt: string,
  pageUrl: string,
): { blocked: boolean; agent: string; rule: string } | null {
  if (!robotsTxt.trim()) return null
  let path = '/'
  try {
    path = new URL(pageUrl).pathname || '/'
  } catch {
    path = '/'
  }
  const groups = parseRobotsTxt(robotsTxt)
  for (const agent of BOTS) {
    const group =
      groups.find((g) => g.agents.some((a) => a.toLowerCase() === agent.toLowerCase())) ??
      (agent === '*' ? groups.find((g) => g.agents.some((a) => a === '*')) : undefined)
    if (!group) continue
    const disallow = group.disallows.find((r) => matchPath(r, path))
    const allow = group.allows.find((r) => matchPath(r, path))
    if (disallow && (!allow || allow.length <= disallow.length)) {
      return { blocked: true, agent, rule: `Disallow: ${disallow}` }
    }
  }
  return null
}
