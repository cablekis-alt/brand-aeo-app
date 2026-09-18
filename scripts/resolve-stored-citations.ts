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
 * ── 2026-09-18 수정: 두 결함이 서로를 잠그고 있었다 ─────────────────────────────
 *   a) 소유 도메인을 server/tenants.config.json(베이스)에서만 읽어, 설치본에서 등록해
 *      오버레이에만 있는 브랜드는 ownedDomains가 빈 집합이었다 → 자사 인용을 0건 승격.
 *   b) 승격 판정이 "래퍼를 이번에 해소한 인용"에만 걸려 있었고, 래퍼가 없으면 조기 종료했다.
 *      그래서 a) 때문에 unknown으로 남은 인용은 이미 실제 URL이라 재실행해도 영영 안 고쳐졌다.
 *   데스크톱 데이터 42건(테넌트·주차)이 이 상태였다(kriss W37: 자사 인용 67건 전부 unknown).
 *   이제 오버레이도 읽고(--overlay 또는 <appDataDir>/tenants.overlay.json), 승격은 모든 인용에
 *   대해 별도 단계로 돈다. 소유 도메인을 모르는 테넌트는 반드시 경고로 찍는다 —
 *   "조용히 아무 일도 안 함"이 문제의 핵심이었다.
 *   c) 함께, "brand-owned 인용에서 도메인을 배우는" 폴백을 제거했다. 판정이 공식 네이버 블로그를
 *      brand-owned로 표시하면 blog.naver.com 호스트 전체를 자사로 배워 남의 글 150건을 승격하려
 *      했다(bymeps W38 드라이런에서 발견). 승격은 **설정된 ownedDomains와 그 서브도메인**에만 건다.
 *
 * 이후 점수를 맞추려면 scripts/rescore-local.ts를 실행한다(brandOwnedCitationRate가 바뀐다).
 *
 *   npx tsx scripts/resolve-stored-citations.ts --dry-run          # repo(data/ + src/data/live-*)
 *   npx tsx scripts/resolve-stored-citations.ts
 *   npx tsx scripts/resolve-stored-citations.ts --dry-run "$env:APPDATA\brand-aeo-app"
 *   npx tsx scripts/resolve-stored-citations.ts --dry-run --overlay <tenants.overlay.json>   # 오버레이만 따로 지정
 *
 * 데스크톱 데이터를 대상으로 할 때는 앱을 종료한 뒤 실행한다.
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

// --overlay <file>: 소유 도메인을 읽을 오버레이 파일을 직접 지정한다(기본은 아래 overlayPath 규칙).
const overlayIdx = args.indexOf('--overlay')
const overlayValueIdx = overlayIdx >= 0 ? overlayIdx + 1 : -1
const overlayArg = overlayValueIdx >= 0 && args[overlayValueIdx] ? expandEnvTokens(args[overlayValueIdx]) : undefined
const rawArg = args.find((a, i) => !a.startsWith('--') && i !== overlayValueIdx)
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

// 소유 도메인: 베이스 설정 + 런타임 오버레이. **설정에 적힌 도메인만** 쓴다.
//
// 이전에는 server/tenants.config.json(베이스)만 읽었다. 그런데 설치본에서 등록한 브랜드는
// 오버레이(userData/tenants.overlay.json)에만 있어서 ownedDomains가 빈 집합이 됐고, 그 결과
// 자사 인용을 한 건도 승격하지 못했다 — 2026-09-18 확인 시 데스크톱 데이터 42건(테넌트·주차)이
// 그 상태였다(kriss W37은 자사 인용 67건 전부 unknown). 조용히 아무 일도 안 하는 게 문제의
// 핵심이었으므로, 소유 도메인을 모르는 테넌트는 아래에서 반드시 출력한다.
//
// "이미 brand-owned로 분류된 인용에서 도메인을 배운다"는 폴백은 **제거했다.** 판정 엔진이 브랜드의
// 공식 네이버 블로그·카카오 채널 URL을 brand-owned로 (옳게) 표시하면, 폴백은 blog.naver.com·
// pf.kakao.com이라는 **호스트 전체**를 자사로 배워 남의 블로그 글까지 승격했다 — 드라이런에서
// bymeps W38 자사 인용은 47건인데 승격 대상이 77건(blog.naver.com 150건 포함)으로 나와 발견했다.
// 공식 채널은 공유 호스트 위의 *경로*라 호스트 단위 학습이 원리적으로 틀리다. 오버레이를 읽게 된
// 지금은 폴백의 존재 이유(설정에 없는 설치본 브랜드)도 사라졌다.
//
// 병합 규칙은 server/tenantRegistry.ts의 loadRuntimeTenants와 같다 — 같은 id가 양쪽에 있으면 베이스가 이긴다.
// 오버레이 경로: --overlay <file> > <appDataDir>/tenants.overlay.json > server/tenants.overlay.json(개발 체크아웃).
const overlayPath =
  overlayArg ?? (appDataDir ? path.join(appDataDir, 'tenants.overlay.json') : path.join('server', 'tenants.overlay.json'))
const baseTenants = readJson<TenantConfig[]>('server/tenants.config.json') ?? []
const overlayTenants = readJson<TenantConfig[]>(overlayPath) ?? []
const normalizeDomain = (d: string) => d.replace(/^https?:\/\//, '').replace(/^www\./, '').toLowerCase()
const ownedByTenant = new Map<string, Set<string>>()
for (const t of baseTenants) {
  ownedByTenant.set(t.tenantId, new Set((t.ownedDomains ?? []).map(normalizeDomain)))
}
for (const t of overlayTenants) {
  if (ownedByTenant.has(t.tenantId)) continue
  ownedByTenant.set(t.tenantId, new Set((t.ownedDomains ?? []).map(normalizeDomain)))
}
console.log(
  `소유 도메인 출처 — 베이스 ${baseTenants.length}곳 · 오버레이 ${overlayTenants.length}곳` +
    (existsSync(overlayPath) ? ` (${overlayPath})` : ` (오버레이 파일 없음: ${overlayPath})`),
)
const noOwned = [...new Set(loaded.map((t) => t.tenantId))].filter((id) => (ownedByTenant.get(id)?.size ?? 0) === 0)
if (noOwned.length > 0) {
  console.log(
    `⚠ 소유 도메인을 모르는 테넌트 ${noOwned.length}곳 — 자사 인용이 있어도 승격되지 않습니다` +
      `(베이스·오버레이 어느 설정에도 ownedDomains가 없음):`,
  )
  console.log(`  ${noOwned.join(', ')}`)
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

// 래퍼가 없어도 여기서 멈추지 않는다. 이전에는 "해소할 래퍼가 없습니다"로 종료했는데, 그러면
// 지난 실행에서 실제 URL로 풀렸지만 (오버레이를 못 읽어) 소유권이 unknown으로 남은 인용을
// 두 번째 실행에서 영영 고치지 못한다. 해소(1단계)와 승격(2단계)은 별개 단계다.
let resolved = new Map<string, string>()
if (allWrappers.size > 0) {
  console.log('래퍼 해소 중… (리다이렉트 헤더만 읽습니다. API 비용 없음)')
  const started = Date.now()
  resolved = await resolveCitationUrls([...allWrappers])
  const changedUrls = [...resolved.entries()].filter(([from, to]) => from !== to)
  console.log(
    `해소 완료 ${changedUrls.length}/${allWrappers.size}개 (${Math.round((Date.now() - started) / 1000)}초). ` +
      `실패분은 원본 URL을 그대로 둡니다.`,
  )
} else {
  console.log('해소할 래퍼가 없습니다 — 소유권 승격만 진행합니다.')
}

let citationsFixed = 0
let brandOwnedAdded = 0
const perFile: string[] = []

for (const t of loaded) {
  const owned = ownedByTenant.get(t.tenantId) ?? new Set<string>()
  let fixed = 0
  let owns = 0
  for (const a of t.analyses) {
    const citations = (a.citations ?? []) as CitationDetail[]
    // 1단계: 래퍼 → 실제 URL. 도메인은 여기서 채운다.
    for (const c of citations) {
      if (!c.raw || !isGroundingRedirect(c.raw)) continue
      const to = resolved.get(c.raw)
      if (!to || to === c.raw) continue
      c.raw = to
      c.domain = hostOf(to)
      fixed += 1
    }
    // 2단계: 소유권 승격 — 이번에 해소된 것뿐 아니라 **이미 실제 URL인 인용도** 본다.
    // 이전 구현은 이 판정을 1단계 루프 안에 두어(래퍼가 아니면 continue), 이미 풀린 인용은
    // 다시는 건드리지 못했다. 자사 도메인만 결정적으로 올리고, 제3자 분류는 여전히 추측하지 않는다.
    for (const c of citations) {
      if (c.domain && c.ownerType !== 'brand-owned' && isOwned(c.domain, owned)) {
        c.ownerType = 'brand-owned'
        owns += 1
      }
    }
    // 자사 인용 포함 여부는 인용 소유권에서 파생되므로 다시 계산한다.
    a.brandOwnedCitation = citations.some((c) => c.ownerType === 'brand-owned')
  }
  citationsFixed += fixed
  brandOwnedAdded += owns
  if (fixed > 0 || owns > 0) {
    const parts: string[] = []
    if (fixed > 0) parts.push(`인용 ${String(fixed).padStart(4)}건 해소`)
    if (owns > 0) parts.push(`자사 ${String(owns).padStart(3)}건 승격`)
    perFile.push(`  ${t.tenantId.padEnd(20)} ${path.basename(path.dirname(t.file)).padEnd(10)} ${parts.join(' · ')}`)
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
