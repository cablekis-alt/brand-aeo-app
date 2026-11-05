/**
 * patch:asar(scripts/patch-installed-asar.ts)가 asar 밖 지도 데이터(resources/map/gunsan.pmtiles · NOTICE-OSM.txt)도 옮기는지 확인한다 —
 * 가짜 설치 폴더와 가짜 포터블 zip(Windows tar.exe로 만든다)으로 스크립트를 그대로 돌린다. 설치된 앱 · 릴리스 · 바깥 주소는 건드리지 않는다.
 *
 * 왜:
 * - 이 PC의 업데이트 길은 patch:asar다. 지도 데이터는 extraResources(asar 밖)라 asar만 바꾸면 새 앱은 지도 파일을 찾지 못하고 모든 지도
 *   그리기가 「Bad response code: 500」으로 실패했다(2026-11-05 검토 재연).
 * - 지도 파일을 옮기지 못했으면 asar를 바꾸기 전에 멈춰야 한다 — 새 앱만 깔리고 지도 데이터가 없는 상태를 만들지 않는다.
 * - 되돌리기(--restore)는 그 버전의 지도 파일 백업이 있으면 함께 되돌린다(bundled.env와 같다).
 *
 *   npx tsx scripts/verify-patch-asar.ts
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

const ROOT = process.cwd()
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const TAR = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
const work = mkdtempSync(path.join(tmpdir(), 'verify-patch-asar-'))

/** package.json 하나만 든 asar(헤더 pickle + 파일 데이터) — patch 스크립트의 asarVersion이 읽는 모양. */
function fakeAsar(version: string): Buffer {
  const data = Buffer.from(JSON.stringify({ name: 'fake-app', version }), 'utf8')
  const json = Buffer.from(JSON.stringify({ files: { 'package.json': { size: data.length, offset: '0' } } }), 'utf8')
  const padded = Math.ceil(json.length / 4) * 4
  const header = Buffer.alloc(8 + padded)
  header.writeUInt32LE(4 + padded, 0)
  header.writeUInt32LE(json.length, 4)
  json.copy(header, 8)
  const outer = Buffer.alloc(8)
  outer.writeUInt32LE(4, 0)
  outer.writeUInt32LE(header.length, 4)
  return Buffer.concat([outer, header, data])
}

/** 가짜 설치 폴더 — resources/app.asar(그 버전)만. */
function fakeInstall(name: string, version: string): string {
  const dir = path.join(work, name)
  mkdirSync(path.join(dir, 'resources'), { recursive: true })
  writeFileSync(path.join(dir, 'resources', 'app.asar'), fakeAsar(version))
  return dir
}

/** 가짜 포터블 zip — resources/app.asar와(주면) resources/map의 지도 파일들. */
function fakeZip(name: string, version: string, map: Record<string, string> | null): string {
  const stage = path.join(work, `${name}-stage`)
  mkdirSync(path.join(stage, 'resources'), { recursive: true })
  writeFileSync(path.join(stage, 'resources', 'app.asar'), fakeAsar(version))
  if (map) {
    mkdirSync(path.join(stage, 'resources', 'map'), { recursive: true })
    for (const [file, body] of Object.entries(map)) writeFileSync(path.join(stage, 'resources', 'map', file), body)
  }
  const zip = path.join(work, `${name}.zip`)
  const r = spawnSync(TAR, ['--format', 'zip', '-c', '-f', zip, '-C', stage, 'resources'], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`zip을 만들지 못했습니다: ${r.stderr}`)
  return zip
}

function patch(args: string[]): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [TSX, path.join('scripts', 'patch-installed-asar.ts'), ...args], { cwd: ROOT, encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
}

const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : null)
const asarVersionOf = (dir: string) => {
  const m = /"version":"([^"]+)"/.exec(readFileSync(path.join(dir, 'resources', 'app.asar'), 'latin1'))
  return m ? m[1] : null
}

try {
  const inst = fakeInstall('install', '0.0.1')
  const mapFile = path.join(inst, 'resources', 'map', 'gunsan.pmtiles')
  const noticeFile = path.join(inst, 'resources', 'map', 'NOTICE-OSM.txt')

  // 1) 지도 데이터를 처음 싣는 릴리스 — asar와 함께 resources/map도 옮긴다.
  const z2 = fakeZip('v2', '0.0.2', { 'gunsan.pmtiles': 'PMTILES-A', 'NOTICE-OSM.txt': 'NOTICE-1' })
  const r2 = patch(['--install-dir', inst, '--zip', z2, '--tag', 'v0.0.2', '--force'])
  ok(
    'zip에 지도 데이터가 있으면 resources/map/gunsan.pmtiles · NOTICE-OSM.txt를 옮기고 알린다',
    r2.status === 0 && asarVersionOf(inst) === '0.0.2' && read(mapFile) === 'PMTILES-A' && read(noticeFile) === 'NOTICE-1' && r2.out.includes('지도 데이터'),
  )

  // 2) 지도 데이터가 바뀐 릴리스 — 다른 파일은 백업(그 버전 이름)하고 바꾸고, 같은 파일은 그대로 둔다.
  const z3 = fakeZip('v3', '0.0.3', { 'gunsan.pmtiles': 'PMTILES-B', 'NOTICE-OSM.txt': 'NOTICE-1' })
  const r3 = patch(['--install-dir', inst, '--zip', z3, '--tag', 'v0.0.3', '--force'])
  ok(
    '바뀐 지도 파일은 옛 파일을 「.v<옛 버전>.bak」으로 남기고 바꾼다 · 같은 파일은 백업 없이 그대로',
    r3.status === 0 && read(mapFile) === 'PMTILES-B' && read(`${mapFile}.v0.0.2.bak`) === 'PMTILES-A' && read(noticeFile) === 'NOTICE-1' && !existsSync(`${noticeFile}.v0.0.2.bak`),
  )

  // 3) 지도 데이터가 없는 zip(예전 릴리스) — 있는 지도 파일은 그대로 두고 실패하지 않는다.
  const z4 = fakeZip('v4', '0.0.4', null)
  const r4 = patch(['--install-dir', inst, '--zip', z4, '--tag', 'v0.0.4', '--force'])
  ok('zip에 지도 데이터가 없으면 있는 파일을 그대로 둔다', r4.status === 0 && asarVersionOf(inst) === '0.0.4' && read(mapFile) === 'PMTILES-B')

  // 4) 되돌리기 — 그 버전의 지도 파일 백업이 있으면 함께 되돌린다.
  const rr = patch(['--install-dir', inst, '--restore', '--tag', 'v0.0.2'])
  ok('되돌리기(--restore)는 그 버전의 지도 파일 백업도 되돌린다', rr.status === 0 && asarVersionOf(inst) === '0.0.2' && read(mapFile) === 'PMTILES-A')

  // 5) 지도 파일을 옮기지 못하면(resources/map 자리에 파일이 있음) asar를 바꾸기 전에 멈춘다.
  const blocked = fakeInstall('install-blocked', '0.0.1')
  writeFileSync(path.join(blocked, 'resources', 'map'), 'not a folder')
  const rb = patch(['--install-dir', blocked, '--zip', z2, '--tag', 'v0.0.2', '--force'])
  ok('지도 파일을 옮기지 못하면 실패로 끝내고 asar는 바꾸지 않는다', rb.status === 1 && asarVersionOf(blocked) === '0.0.1' && rb.out.includes('지도 데이터'))
} finally {
  rmSync(work, { recursive: true, force: true })
}

let failed = 0
for (const [label, pass] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${label}`)
  if (!pass) failed += 1
}
if (failed > 0) {
  console.error(`\n${failed}건 실패`)
  process.exit(1)
}
console.log(`\n모두 통과 (${checks.length}건)`)
