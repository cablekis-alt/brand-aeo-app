/**
 * 설치된 데스크톱 앱의 app.asar만 새 릴리스 것으로 갈아끼운다(설치본 실행 없이 업데이트).
 *
 * 왜 필요한가: 개발 PC에 Windows Smart App Control이 켜져 있으면 electron-updater가 새 버전을
 * 내려받아도 **설치 단계에서** Code Integrity가 미서명 설치본 로드를 거부한다. UAC에 "예"를
 * 눌러도 아무 일이 없고 버전이 그대로다(Event 3077, Microsoft-Windows-CodeIntegrity/Operational).
 * 포터블 zip도 새 exe라 실행이 막힌다.
 *
 * 우회 원리: 우리 변경(main.cjs·preload.cjs·server.cjs·UI·시드 데이터)은 전부 app.asar 안에
 * 있고, asar는 실행 파일이 아니라 Code Integrity 검사 대상이 아니다. 이미 허용된 설치본 exe는
 * 그대로 두고 asar만 바꾸면 앱이 새 버전으로 동작한다. 단 Electron 버전이 같아야 한다.
 *
 * 근본 해결은 코드 서명이다(electron-builder.yml의 CSC_LINK/CSC_KEY_PASSWORD). 이 스크립트는
 * 서명 인증서가 없는 동안의 임시 수단이다.
 *
 *   npx tsx scripts/patch-installed-asar.ts --dry-run          # 계획만 출력
 *   npx tsx scripts/patch-installed-asar.ts                    # package.json 버전으로 교체
 *   npx tsx scripts/patch-installed-asar.ts --tag v0.1.40
 *   npx tsx scripts/patch-installed-asar.ts --zip ./Web4AI-Brand-AEO-0.1.40-x64.zip
 *   npx tsx scripts/patch-installed-asar.ts --restore          # 백업으로 되돌리기
 *
 * 주의: exe의 파일 속성·Windows 프로그램 목록 버전은 옛 값으로 남는다(PE 리소스에 박혀 있다).
 * 앱 화면과 업데이터가 쓰는 버전은 asar의 package.json이므로 동작에는 영향이 없다.
 */
import { execFileSync } from 'node:child_process'
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const has = (f: string) => args.includes(f)
const valueOf = (f: string): string | undefined => {
  const i = args.indexOf(f)
  return i >= 0 ? args[i + 1] : undefined
}

const dryRun = has('--dry-run')
const restore = has('--restore')
const force = has('--force')

const DEFAULT_INSTALL = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
  'Programs',
  'Web4AI Brand AEO',
)
const installDir = valueOf('--install-dir') ?? DEFAULT_INSTALL
const asarPath = path.join(installDir, 'resources', 'app.asar')

// 함수 선언으로 둔다 — 화살표 상수로 두면 TypeScript가 never 반환을 제어 흐름에 반영하지 않아
// `if (!x) fail(...)` 뒤에서도 x가 undefined로 남는다.
function fail(msg: string): never {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

if (!existsSync(asarPath)) fail(`설치된 app.asar이 없습니다: ${asarPath}\n  --install-dir 로 경로를 지정하세요.`)

/** 설치 폴더의 실행 파일 이름(언인스톨러 제외). 프로세스 확인에 쓴다. */
function appExeName(): string | null {
  try {
    return (
      readdirSync(installDir).find((f) => f.toLowerCase().endsWith('.exe') && !/^uninstall/i.test(f)) ?? null
    )
  } catch {
    return null
  }
}

/**
 * 앱이 실행 중이면 교체를 막는다.
 *
 * 파일을 쓰기로 열어보는 방식은 쓸 수 없다 — Electron이 asar를 공유 모드로 열어두기 때문에
 * 앱이 켜져 있어도 openSync(.., 'r+')가 성공하고, 그대로 덮어써진다(실측 확인). 그래서
 * tasklist로 프로세스를 직접 확인한다.
 */
function assertAppClosed(): void {
  const exe = appExeName()
  if (!exe) {
    console.warn('⚠ 실행 파일을 찾지 못해 실행 여부를 확인하지 못했습니다. 앱이 꺼져 있는지 직접 확인하세요.')
    return
  }
  let out = ''
  try {
    out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${exe}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8' })
  } catch {
    console.warn('⚠ tasklist 실행에 실패해 실행 여부를 확인하지 못했습니다.')
    return
  }
  const pids = [...out.matchAll(/^"([^"]+)","(\d+)"/gm)]
    .filter((m) => m[1].toLowerCase() === exe.toLowerCase())
    .map((m) => m[2])
  if (pids.length > 0) {
    fail(`앱이 실행 중입니다(${exe} · PID ${pids.join(', ')}). 완전히 종료한 뒤 다시 실행하세요.`)
  }
}

/**
 * asar 안 package.json의 version을 헤더를 직접 읽어 구한다.
 *
 * `npx asar extract-file`을 쓰지 않는 이유: (1) stdout이 아니라 cwd에 파일을 쓴다,
 * (2) shell 경유라 설치 경로의 공백("Web4AI Brand AEO")에서 인자가 쪼개진다.
 * asar 포맷: [0..4)=4 · [4..8)=headerSize · [12..16)=JSON 길이 · [16..)=디렉터리 JSON,
 * 파일 데이터는 8+headerSize 지점부터 엔트리의 offset만큼 떨어져 있다.
 */
function asarVersion(file: string): string | null {
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const head = Buffer.alloc(16)
    readSync(fd, head, 0, 16, 0)
    const headerSize = head.readUInt32LE(4)
    const jsonLen = head.readUInt32LE(12)
    if (headerSize <= 0 || jsonLen <= 0 || jsonLen > headerSize) return null
    const json = Buffer.alloc(jsonLen)
    readSync(fd, json, 0, jsonLen, 16)
    const dir = JSON.parse(json.toString('utf8')) as {
      files?: Record<string, { size?: number; offset?: string }>
    }
    const entry = dir.files?.['package.json']
    if (!entry?.size || entry.offset === undefined) return null
    const body = Buffer.alloc(entry.size)
    readSync(fd, body, 0, entry.size, 8 + headerSize + Number(entry.offset))
    return (JSON.parse(body.toString('utf8')) as { version?: string }).version ?? null
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

const backupsOf = (): { file: string; version: string }[] =>
  readdirSync(path.dirname(asarPath))
    .map((n) => /^app\.asar\.v(\d+\.\d+\.\d+)\.bak$/.exec(n))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ file: path.join(path.dirname(asarPath), m[0]), version: m[1] }))
    .sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }))

// ── 되돌리기 ──────────────────────────────────────────────────────────────
if (restore) {
  const backups = backupsOf()
  if (backups.length === 0) fail('되돌릴 백업(app.asar.v*.bak)이 없습니다.')
  const pick = valueOf('--tag')
    ? backups.find((b) => `v${b.version}` === valueOf('--tag') || b.version === valueOf('--tag'))
    : backups.at(-1)
  if (!pick) fail(`해당 백업이 없습니다. 있는 백업: ${backups.map((b) => b.version).join(', ')}`)
  console.log(`현재 설치 버전: ${asarVersion(asarPath) ?? '알 수 없음'}`)
  console.log(`되돌릴 백업: v${pick.version} (${path.basename(pick.file)})`)
  if (dryRun) {
    console.log('--dry-run — 파일을 쓰지 않았습니다.')
    process.exit(0)
  }
  assertAppClosed()
  copyFileSync(pick.file, asarPath)
  console.log(`✓ 되돌림 완료 — 현재 ${asarVersion(asarPath) ?? '?'}`)
  process.exit(0)
}

// ── 교체 ─────────────────────────────────────────────────────────────────
const installedVersion = asarVersion(asarPath)
if (!installedVersion) fail('설치된 app.asar의 버전을 읽지 못했습니다.')

const repoVersion = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version
const tag = valueOf('--tag') ?? `v${repoVersion}`
const targetVersion = tag.replace(/^v/, '')

console.log(`설치 경로   ${installDir}`)
console.log(`현재 버전   ${installedVersion}`)
console.log(`목표 버전   ${targetVersion} (${tag})`)

if (installedVersion === targetVersion && !force) {
  console.log('이미 같은 버전입니다. 다시 하려면 --force를 주세요.')
  process.exit(0)
}

/** 태그의 package.json에서 electron 버전을 읽는다. asar에는 devDependencies가 없어 git으로 본다. */
function electronOfTag(t: string): string | null {
  try {
    const json = execFileSync('git', ['show', `${t}:package.json`], { encoding: 'utf8' })
    return (JSON.parse(json) as { devDependencies?: Record<string, string> }).devDependencies?.electron ?? null
  } catch {
    return null
  }
}

// Electron 버전이 다르면 asar만 바꿔도 동작하지 않는다(네이티브·API 불일치). 반드시 막는다.
const fromElectron = electronOfTag(`v${installedVersion}`)
const toElectron = electronOfTag(tag)
if (fromElectron && toElectron) {
  const same = fromElectron === toElectron
  console.log(`Electron    ${fromElectron} → ${toElectron} ${same ? '(동일)' : '(다름!)'}`)
  if (!same && !force) {
    fail('Electron 버전이 달라 asar 교체로는 업데이트할 수 없습니다. 정식 설치본이 필요합니다(--force로 강행 가능).')
  }
} else {
  const missing = [fromElectron ? null : `v${installedVersion}`, toElectron ? null : tag].filter(Boolean).join(', ')
  console.log(`Electron    확인 불가 — git에서 태그를 못 찾음(${missing})`)
  if (!force) fail('Electron 버전을 확인할 수 없습니다. git fetch --tags 후 재시도하거나 --force로 강행하세요.')
}

// 157MB를 내려받은 뒤에 "앱을 끄세요"를 만나지 않도록 먼저 확인한다(교체 직전에 한 번 더 본다).
if (!dryRun) assertAppClosed()

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'asar-patch-'))
try {
  // 1) 포터블 zip 확보 — 로컬 경로가 있으면 그걸 쓰고, 없으면 릴리스에서 내려받는다.
  let zip = valueOf('--zip')
  if (zip) {
    if (!existsSync(zip)) fail(`zip이 없습니다: ${zip}`)
    console.log(`zip         ${zip} (로컬)`)
  } else {
    const pattern = `Web4AI-Brand-AEO-${targetVersion}-x64.zip`
    console.log(`zip         릴리스 ${tag}에서 ${pattern} 내려받는 중… (약 157MB)`)
    if (dryRun) {
      console.log('--dry-run — 내려받지 않고 종료합니다.')
      process.exit(0)
    }
    // shell:true를 쓰지 않는다 — 인자가 인용되지 않아 공백 있는 경로에서 쪼개진다(Node DEP0190).
    // gh는 실제 exe(gh.exe)라 셸 없이 바로 실행된다.
    execFileSync(process.platform === 'win32' ? 'gh.exe' : 'gh', [
      'release',
      'download',
      tag,
      '-p',
      pattern,
      '-D',
      tmpDir,
      '--clobber',
    ], { stdio: 'inherit' })
    zip = path.join(tmpDir, pattern)
    if (!existsSync(zip)) fail('zip 다운로드에 실패했습니다.')
  }

  if (dryRun) {
    console.log('--dry-run — 파일을 쓰지 않았습니다.')
    process.exit(0)
  }

  // 2) zip에서 resources/app.asar만 꺼낸다. Windows 기본 bsdtar가 zip을 다룬다(GNU tar는 못 한다).
  const bsdtar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  const out = path.join(tmpDir, 'x')
  mkdirSync(out, { recursive: true })
  execFileSync(bsdtar, ['-xf', zip, '-C', out, 'resources/app.asar'], { cwd: tmpDir, stdio: 'pipe' })
  const newAsar = path.join(out, 'resources', 'app.asar')
  if (!existsSync(newAsar)) fail('zip에서 resources/app.asar을 찾지 못했습니다.')

  // 3) 꺼낸 asar이 정말 목표 버전인지 확인한다(엉뚱한 zip을 넣는 사고 방지).
  const newVersion = asarVersion(newAsar)
  if (newVersion !== targetVersion && !force) {
    fail(`zip의 app.asar 버전이 ${newVersion ?? '알 수 없음'}입니다(목표 ${targetVersion}).`)
  }
  console.log(`새 asar     ${(statSync(newAsar).size / 1024 / 1024).toFixed(2)} MB · 버전 ${newVersion}`)

  // 4) 앱이 닫혀 있어야 한다. 백업은 버전별로 하나만 남긴다(첫 백업이 원본).
  assertAppClosed()
  const backup = path.join(path.dirname(asarPath), `app.asar.v${installedVersion}.bak`)
  if (existsSync(backup)) {
    console.log(`백업        이미 존재 — 유지 (${path.basename(backup)})`)
  } else {
    copyFileSync(asarPath, backup)
    console.log(`백업        생성 (${path.basename(backup)})`)
  }

  copyFileSync(newAsar, asarPath)
  const applied = asarVersion(asarPath)
  if (applied !== targetVersion) {
    copyFileSync(backup, asarPath)
    fail(`교체 후 버전이 ${applied ?? '알 수 없음'}입니다. 백업으로 되돌렸습니다.`)
  }

  console.log('')
  console.log(`✓ 교체 완료 — ${installedVersion} → ${applied}`)
  console.log(`  앱을 실행해 좌하단 버전이 v${applied}인지 확인하세요.`)
  console.log(`  되돌리려면: npx tsx scripts/patch-installed-asar.ts --restore`)
  console.log('')
  console.log('  참고: exe 파일 속성·Windows 프로그램 목록 버전은 옛 값으로 남습니다(PE에 박혀 있음).')
} finally {
  rmSync(tmpDir, { recursive: true, force: true })
}
