/**
 * 질문 배분(문항 수 · 반복 수 · 질문 은행 버전)을 기존 테넌트에 소급 적용한다.
 *
 * server/tenantRegistry.ts의 기본값을 바꿔도 **이미 등록된 테넌트는 안 바뀐다** — 설정에
 * 명시값이 들어 있기 때문이다. 그리고 저장소 config만 고치면 앱 오버레이에 등록된 브랜드가
 * 빠진다. 실제로 겪었다: v3로 올린 뒤 앱을 보니 KETI와 그 경쟁사 5개가 12문항 × 3회 · v1로
 * 남아 있었다. loadRuntimeTenants는 base를 먼저 넣고 오버레이는 `!map.has(id)`일 때만
 * 채우므로, **오버레이에만 있는 브랜드는 base가 덮어주지 못한다.**
 *
 *   npx tsx scripts/migrate-question-plan.ts --dry-run                              # 저장소 config
 *   npx tsx scripts/migrate-question-plan.ts
 *   npx tsx scripts/migrate-question-plan.ts --dry-run "$env:APPDATA\brand-aeo-app"  # 앱 오버레이
 *   npx tsx scripts/migrate-question-plan.ts --size 36 --repeats 1 --version v3
 *
 * 앱 오버레이를 고칠 때는 앱을 종료한 뒤 실행한다.
 *
 * 주의: 질문 은행 버전을 올리면 다음 측정에서 질문 집합이 새로 생성된다. 언급률·SoM의
 * 모집단이 달라지므로 그 이전 주차와 점수를 직접 비교할 수 없다(스코어카드의
 * questionBankVersion으로 구분된다).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

/** 셸이 확장하지 못한 환경변수 토큰을 직접 푼다(PowerShell은 %VAR%를, cmd는 $env:VAR를 못 푼다). */
function expandEnvTokens(input: string): string {
  return input
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name: string) => process.env[name] ?? m)
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/g, (m, name: string) => process.env[name] ?? m)
}

const FLAG_NAMES = new Set(['--size', '--repeats', '--version'])
const rawRoot = args.find((a, i) => !a.startsWith('--') && !FLAG_NAMES.has(args[i - 1] ?? ''))
const root = rawRoot ? expandEnvTokens(rawRoot) : undefined
if (rawRoot && root !== rawRoot) console.log(`인자 확장: ${rawRoot} → ${root}`)

const size = Number(flag('--size') ?? 36)
const repeats = Number(flag('--repeats') ?? 1)
const version = flag('--version') ?? 'v3'
if (!Number.isFinite(size) || size < 1 || !Number.isFinite(repeats) || repeats < 1) {
  console.error('--size와 --repeats는 1 이상의 수여야 합니다.')
  process.exit(1)
}

/**
 * 앱이 실행 중이면 중단한다 — 앱도 오버레이를 read-modify-write 하므로(브랜드 등록),
 * 동시에 쓰면 한쪽 변경이 조용히 사라진다.
 *
 * "앱을 종료한 뒤 실행하세요"라고 적어두기만 하면 거짓 안심이다. scripts/patch-installed-asar.ts와
 * 같은 방식으로 실제로 확인한다. 확인에 실패하면 그 사실을 밝힐 뿐 통과시키지 않는다.
 */
function assertAppClosed(): void {
  const EXE = 'Web4AI Brand AEO.exe'
  let out: string
  try {
    out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${EXE}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8' })
  } catch {
    console.error('✗ tasklist 실행에 실패해 앱 실행 여부를 확인할 수 없습니다. 앱을 끄고 다시 시도하세요.')
    process.exit(1)
  }
  const pids = [...out.matchAll(/^"([^"]+)","(\d+)"/gm)]
    .filter((m) => m[1].toLowerCase() === EXE.toLowerCase())
    .map((m) => m[2])
  if (pids.length > 0) {
    console.error(`✗ 앱이 실행 중입니다(${EXE} · PID ${pids.join(', ')}). 완전히 종료한 뒤 다시 실행하세요.`)
    console.error('  앱도 오버레이를 고치므로 동시에 쓰면 한쪽 변경이 사라집니다.')
    process.exit(1)
  }
}

interface Tenant {
  tenantId: string
  brandName?: string
  questionBankSize?: number
  repeatsPerQuestion?: number
  questionBankVersion?: string
  cohortOnly?: boolean
}

/** 고칠 파일 — 저장소 config, 또는 앱 데이터 폴더의 오버레이. */
const target = root ? path.join(root, 'tenants.overlay.json') : 'server/tenants.config.json'
if (!existsSync(target)) {
  console.error(`파일이 없습니다: ${target}`)
  process.exit(1)
}

// 오버레이(앱 데이터)를 고칠 때만 실행 여부를 본다. 저장소 config는 앱이 건드리지 않는다.
if (root && !dryRun) assertAppClosed()

let tenants: Tenant[]
try {
  const parsed = JSON.parse(readFileSync(target, 'utf8')) as unknown
  if (!Array.isArray(parsed)) throw new Error('배열이 아닙니다')
  tenants = parsed as Tenant[]
} catch (err) {
  console.error(`읽지 못했습니다: ${target} — ${err instanceof Error ? err.message : err}`)
  process.exit(1)
}

console.log(`대상 ${target}`)
console.log(`적용할 배분: ${size}문항 × ${repeats}회 · ${version}`)
console.log('')

const changes: string[] = []
for (const t of tenants) {
  const before = `${t.questionBankSize ?? '-'}문항 × ${t.repeatsPerQuestion ?? '-'}회 · ${t.questionBankVersion ?? '-'}`
  if (t.questionBankSize === size && t.repeatsPerQuestion === repeats && t.questionBankVersion === version) continue
  changes.push(`  ${t.tenantId.padEnd(16)}${(t.brandName ?? '').padEnd(20)}${before}${t.cohortOnly ? ' · 경쟁사' : ''}`)
  t.questionBankSize = size
  t.repeatsPerQuestion = repeats
  t.questionBankVersion = version
}

if (changes.length === 0) {
  console.log(`이미 모두 ${size}문항 × ${repeats}회 · ${version}입니다 (테넌트 ${tenants.length}개).`)
  process.exit(0)
}

console.log(`바꿀 테넌트 ${changes.length}/${tenants.length}개:`)
for (const line of changes.slice(0, 40)) console.log(line)
if (changes.length > 40) console.log(`  … 외 ${changes.length - 40}개`)

if (dryRun) {
  console.log('')
  console.log('--dry-run — 파일을 쓰지 않았습니다.')
  process.exit(0)
}

writeFileSync(target, JSON.stringify(tenants, null, 2) + '\n', 'utf8')
console.log('')
console.log(`갱신 완료 — 테넌트 ${changes.length}개.`)
console.log('다음 측정에서 질문 은행이 새로 생성됩니다. 그 이전 주차와는 척도가 달라')
console.log('점수를 직접 비교할 수 없습니다(카드의 questionBankVersion으로 구분됩니다).')
