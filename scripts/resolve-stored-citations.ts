/**
 * 저장된 판정 레코드의 Gemini 그라운딩 래퍼 URL을 실제 발행 URL로 소급 해소한다.
 *
 * v0.1.33 이전에 측정한 주차는 인용이 `vertexaisearch.../grounding-api-redirect/<token>` 형태로
 * 저장돼 있다. 그 상태로는 domain이 null이라 URL 상세·인용출처·인용 갭 분석에서 전부
 * "도메인없음"으로 뭉치고, 자사 도메인 인용도 unknown으로 빠져 brandOwnedCitationRate가
 * 과소 산정된다(측정 결과 09-10 이전 35건에서 인용의 79%가 래퍼였다).
 *
 * 래퍼 토큰은 아직 살아 있어 302로 실제 URL을 돌려준다 — 그래서 소급 복구가 가능하다.
 * 새 API 호출은 없다(리다이렉트 헤더만 읽는다).
 *
 * 하는 일:
 *   1) 래퍼 URL을 파일 전체에서 모아 중복 제거 후 한 번에 해소(server/citationResolve.ts).
 *   2) citation.raw를 실제 URL로, domain을 그 호스트로 채운다(citationSources의 hostOf와 동일 규칙).
 *   3) ownerType은 **자사 도메인만** 결정적으로 'brand-owned'로 고친다. 제3자 세부 분류
 *      (권위/UGC/경쟁사)는 판단 엔진의 몫이라 여기서 추측하지 않고 기존 값을 둔다.
 *   4) analysis.brandOwnedCitation을 다시 계산한다.
 *
 * 이후 점수를 맞추려면 scripts/rescore-local.ts를 실행한다(brandOwnedCitationRate가 바뀐다).
 *
 *   npx tsx scripts/resolve-stored-citations.ts --dry-run          # repo(data/ + src/data/live-*)
 *   npx tsx scripts/resolve-stored-citations.ts
 *   npx tsx scripts/resolve-stored-citations.ts --dry-run "$env:APPDATA\brand-aeo-app"
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')

/**
 * 셸이 확장하지 못한 환경변수 토큰을 직접 푼다(PowerShell은 %VAR%를, cmd는 $env:VAR를 못 푼다).
 * scripts/rescore-local.ts에도 같은 헬퍼가 있다 — 두 스크립트가 서로를 import하면 top-level
 * 부수효과가 같이 실행되므로 의도적으로 따로 둔다.
 */
function expandEnvTokens(input: string): string {
  return input
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name: string) => process.env[name] ?? m)
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/g, (m, name: string) => process.env[name] ?? m)
}

const rawArg = args.find((a) => !a.startsWith('--'))
const appDataDir = rawArg ? expandEnvTokens(rawArg) : undefined
if (rawArg && appDataDir !== rawArg) console.log(`인자 확장: ${rawArg} → ${appDataDir}`)

const { isGroundingRedirect, resolveCitationUrls } = await import('../server/citationResolve')
type CitationDetail = import('../server/types').CitationDetail
type QuestionRepeatAnalysis = import('../server/types').QuestionRepeatAnalysis
type TenantConfig = import('../server/types').TenantConfig

const readJson = <T,>(p: string): T | null => {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T
  } catch {
    return null
  }
}

/** citationSources.ts의 hostOf와 같은 규칙(www 제거·소문자). 집계가 갈리지 않게 맞춘다. */
function hostOf(raw: string): string | null {
  try {
    return new URL(raw).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return null
  }
}

/** 호스트가 소유 도메인이거나 그 서브도메인인지 — m.k-wonjin.co.kr은 k-wonjin.co.kr 소유다. */
function isOwned(host: string, owned: Set<string>): boolean {
  for (const d of owned) {
    if (host === d || host.endsWith(`.${d}`)) return true
  }
  return false
}

interface Target {
  file: string
  tenantId: string
  /** 파일 형태 — data/는 배열, src/data/live-*는 { tenantId, weekOf, analyses } */
  wrapped: boolean
}

function collectTargets(): Target[] {
  const out: Target[] = []
  if (appDataDir) {
    const dataDir = path.join(appDataDir, 'data')
    if (!existsSync(dataDir)) {
      console.error(`데이터 디렉터리가 없습니다: ${dataDir}`)
      process.exit(1)
    }
    for (const tenantId of readdirSync(dataDir)) {
      const td = path.join(dataDir, tenantId)
      if (!statSync(td).isDirectory()) continue
      for (const week of readdirSync(td)) {
        const f = path.join(td, week, 'question-analyses.json')
        if (existsSync(f)) out.push({ file: f, tenantId, wrapped: false })
      }
    }
    return out
  }
  // repo 기본: 개발 체크아웃 data/ + 배포용 src/data/live-*
  if (existsSync('data')) {
    for (const tenantId of readdirSync('data')) {
      const td = path.join('data', tenantId)
      if (!statSync(td).isDirectory()) continue
      for (const week of readdirSync(td)) {
        const f = path.join(td, week, 'question-analyses.json')
        if (existsSync(f)) out.push({ file: f, tenantId, wrapped: false })
      }
    }
  }
  if (existsSync('src/data')) {
    for (const name of readdirSync('src/data')) {
      const m = /^live-(.+)-question-analyses\.json$/.exec(name)
      if (m) out.push({ file: path.join('src/data', name), tenantId: m[1], wrapped: true })
    }
  }
  return out
}

const targets = collectTargets()
if (targets.length === 0) {
  console.error('대상 파일이 없습니다.')
  process.exit(1)
}

const loaded = targets
  .map((t) => {
    const json = readJson<QuestionRepeatAnalysis[] | { analyses: QuestionRepeatAnalysis[] }>(t.file)
    if (!json) return null
    const analyses = Array.isArray(json) ? json : json.analyses
    if (!Array.isArray(analyses)) return null
    return { ...t, json, analyses }
  })
  .filter((v): v is NonNullable<typeof v> => v !== null)

// 소유 도메인: 테넌트 설정 + 이미 brand-owned로 분류된 인용에서 배운 도메인의 합집합.
// 설치본은 브랜드 목록을 번들에 굽기 때문에 이 체크아웃 설정에 없는 브랜드가 많다 —
// 그때는 데이터 자신이 알려준 도메인을 쓴다.
const configTenants = readJson<TenantConfig[]>('server/tenants.config.json') ?? []
const ownedByTenant = new Map<string, Set<string>>()
for (const t of configTenants) {
  const set = ownedByTenant.get(t.tenantId) ?? new Set<string>()
  for (const d of t.ownedDomains ?? []) set.add(d.replace(/^https?:\/\//, '').replace(/^www\./, '').toLowerCase())
  ownedByTenant.set(t.tenantId, set)
}
for (const t of loaded) {
  const set = ownedByTenant.get(t.tenantId) ?? new Set<string>()
  for (const a of t.analyses) {
    for (const c of a.citations ?? []) {
      if (c.ownerType === 'brand-owned' && c.domain) set.add(c.domain.replace(/^www\./, '').toLowerCase())
    }
  }
  ownedByTenant.set(t.tenantId, set)
}

const allWrappers = new Set<string>()
for (const t of loaded) {
  for (const a of t.analyses) {
    for (const c of a.citations ?? []) {
      if (c.raw && isGroundingRedirect(c.raw)) allWrappers.add(c.raw)
    }
  }
}

console.log(`대상 파일 ${loaded.length}개 · 고유 래퍼 ${allWrappers.size}개`)
if (allWrappers.size === 0) {
  console.log('해소할 래퍼가 없습니다.')
  process.exit(0)
}

console.log('래퍼 해소 중… (리다이렉트 헤더만 읽습니다. API 비용 없음)')
const started = Date.now()
const resolved = await resolveCitationUrls([...allWrappers])
const changedUrls = [...resolved.entries()].filter(([from, to]) => from !== to)
console.log(
  `해소 완료 ${changedUrls.length}/${allWrappers.size}개 (${Math.round((Date.now() - started) / 1000)}초). ` +
    `실패분은 원본 URL을 그대로 둡니다.`,
)

let citationsFixed = 0
let brandOwnedAdded = 0
const perFile: string[] = []

for (const t of loaded) {
  const owned = ownedByTenant.get(t.tenantId) ?? new Set<string>()
  let fixed = 0
  let owns = 0
  for (const a of t.analyses) {
    for (const c of (a.citations ?? []) as CitationDetail[]) {
      if (!c.raw || !isGroundingRedirect(c.raw)) continue
      const to = resolved.get(c.raw)
      if (!to || to === c.raw) continue
      c.raw = to
      c.domain = hostOf(to)
      fixed += 1
      if (c.domain && c.ownerType !== 'brand-owned' && isOwned(c.domain, owned)) {
        c.ownerType = 'brand-owned'
        owns += 1
      }
    }
    // 자사 인용 포함 여부는 인용 소유권에서 파생되므로 다시 계산한다.
    a.brandOwnedCitation = (a.citations ?? []).some((c) => c.ownerType === 'brand-owned')
  }
  citationsFixed += fixed
  brandOwnedAdded += owns
  if (fixed > 0) {
    perFile.push(`  ${t.tenantId.padEnd(20)} ${path.basename(path.dirname(t.file)).padEnd(10)} 인용 ${String(fixed).padStart(4)}건 해소` + (owns > 0 ? ` · 자사 ${owns}건 승격` : ''))
    if (!dryRun) {
      writeFileSync(t.file, JSON.stringify(t.json, null, 2) + (t.wrapped ? '\n' : ''), 'utf8')
    }
  }
}

console.log('')
for (const line of perFile.slice(0, 40)) console.log(line)
if (perFile.length > 40) console.log(`  … 외 ${perFile.length - 40}개 파일`)
console.log('')
console.log(`인용 ${citationsFixed}건 해소 · 자사 도메인으로 승격 ${brandOwnedAdded}건 · 파일 ${perFile.length}개`)
if (dryRun) {
  console.log('--dry-run — 파일을 쓰지 않았습니다.')
} else {
  console.log('완료. 점수를 맞추려면 scripts/rescore-local.ts를 실행하세요(brandOwnedCitationRate가 바뀝니다).')
}
