// 지도 알림 파일(map-data/NOTICE-OSM.txt) 만들기 · 검사.
//
// maplibre-gl.mjs · maplibre-gl-worker.mjs(설치본 dist-electron/map-vendor)는 의존 라이브러리(kdbush · pbf · earcut · gl-matrix · bidi-js …)를
// 함께 묶은 한 덩어리다. BSD · ISC · MIT는 모두 바이너리 사본에도 저작권 · 허가 글을 싣게 하므로, 설치된 node_modules에서 maplibre-gl의 의존
// 트리를 따라가 각 패키지의 LICENSE 원문을 NOTICE-OSM.txt 끝의 표시 사이에 넣는다(손으로 고치지 않는다).
// 묶음 스크립트(scripts/build-electron-server.mjs)는 noticeProblems로 검사해, 자리 글자(「<저작권자 확인 필요>」 · TODO)가 남았거나 의존
// 라이브러리 글이 node_modules와 다르면 설치본 재료를 만들지 않는다.
//
//   node scripts/map-data/notice.mjs           # 검사만(문제가 있으면 exit 1)
//   node scripts/map-data/notice.mjs --write   # 의존 라이브러리 글을 node_modules에서 다시 만든다
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const NOTICE_FILE = 'map-data/NOTICE-OSM.txt'
export const PMTILES_LICENSE_FILE = 'map-data/pmtiles.LICENSE.txt'
const BEGIN = '[BEGIN maplibre-gl dependencies — scripts/map-data/notice.mjs --write가 만든다, 손으로 고치지 않는다]'
const END = '[END maplibre-gl dependencies]'
const RULE = '-'.repeat(79)
const LICENSE_FILES = /^(licen[cs]e|copying)(\.(md|txt))?$/i
/** 자리 글자 — 사람이 채워야 하는 줄. */
const PLACEHOLDER = /<저작권자 확인 필요>|TODO\(/

const lf = (s) => s.replace(/\r\n?/g, '\n')

/** package.json을 exports로 막은 패키지가 있어 node_modules를 위로 올라가며 찾는다(Node 찾기 순서와 같다). */
function findPackage(name, from) {
  for (let d = from; ; d = path.dirname(d)) {
    const p = path.join(d, 'node_modules', name, 'package.json')
    if (existsSync(p)) return p
    if (path.dirname(d) === d) throw new Error(`${name}을 node_modules에서 찾지 못했습니다(${from}에서)`)
  }
}

/** LICENSE 파일이 없는 패키지 — README의 「License」 절(제목 다음 줄부터 다음 제목 앞까지). */
function readmeLicense(dir) {
  const readme = readdirSync(dir).find((f) => /^readme(\.md)?$/i.test(f))
  if (!readme) return null
  const lines = lf(readFileSync(path.join(dir, readme), 'utf8')).split('\n')
  const at = lines.findIndex((l) => /^#{1,6}\s*licen[cs]e\b/i.test(l))
  if (at < 0) return null
  let end = at + 1
  while (end < lines.length && !/^#{1,6}\s/.test(lines[end])) end += 1
  const text = lines.slice(at + 1, end).join('\n').trim()
  return text || null
}

/**
 * maplibre-gl의 의존 트리(설치된 node_modules, 이름 차례) — { name, version, license, text, from }. from은 글을 가져온 파일(LICENSE 파일 이름 또는
 * 「README License 절」). 글을 찾지 못한 패키지가 있으면 던진다(손으로 넣어야 한다).
 */
export function maplibreDependencies(root) {
  const maplibre = findPackage('maplibre-gl', root)
  const seen = new Map()
  const walk = (name, from) => {
    if (seen.has(name)) return
    const pkgJson = findPackage(name, from)
    const dir = path.dirname(pkgJson)
    const pj = JSON.parse(readFileSync(pkgJson, 'utf8'))
    const file = readdirSync(dir).find((f) => LICENSE_FILES.test(f))
    const text = file ? lf(readFileSync(path.join(dir, file), 'utf8')).trim() : readmeLicense(dir)
    if (!text) throw new Error(`${name} ${pj.version}의 라이선스 글을 찾지 못했습니다 — NOTICE에 손으로 넣어야 합니다.`)
    seen.set(name, { name, version: pj.version, license: pj.license ?? '', text, from: file ?? 'README License 절' })
    for (const d of Object.keys(pj.dependencies ?? {})) walk(d, dir)
  }
  const mlDir = path.dirname(maplibre)
  const ml = JSON.parse(readFileSync(maplibre, 'utf8'))
  for (const d of Object.keys(ml.dependencies ?? {})) walk(d, mlDir)
  return { maplibreVersion: ml.version, direct: Object.keys(ml.dependencies ?? {}), packages: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)) }
}

/** NOTICE-OSM.txt 끝에 넣는 의존 라이브러리 절(BEGIN · END 표시 포함). */
export function maplibreDependencySection(root) {
  const { maplibreVersion, packages } = maplibreDependencies(root)
  const out = [
    BEGIN,
    '',
    '='.repeat(79),
    `maplibre-gl ${maplibreVersion}에 함께 묶인 라이브러리 — 설치본 dist-electron/map-vendor의 maplibre-gl.mjs · maplibre-gl-worker.mjs 안에 들어 있다`,
    `Libraries bundled inside maplibre-gl ${maplibreVersion} (maplibre-gl.mjs · maplibre-gl-worker.mjs)`,
    '='.repeat(79),
  ]
  for (const p of packages) {
    out.push('', RULE, `${p.name} ${p.version} — ${p.license}${p.from === 'README License 절' ? ' (LICENSE 파일이 없어 README의 License 절)' : ''}`, RULE, '', p.text)
  }
  out.push('', END)
  return out.join('\n')
}

/** 글에 남은 자리 글자(「<저작권자 확인 필요>」 · TODO) 줄. */
export function placeholderProblems(text) {
  return lf(text)
    .split('\n')
    .filter((l) => PLACEHOLDER.test(l))
    .map((l) => l.trim())
}

/** 알림 파일 문제 — kind placeholder(자리 글자) · deps(의존 라이브러리 글이 없거나 node_modules와 다름). */
export function noticeProblems(root) {
  const problems = []
  for (const file of [NOTICE_FILE, PMTILES_LICENSE_FILE]) {
    for (const line of placeholderProblems(readFileSync(path.join(root, file), 'utf8'))) {
      problems.push({ kind: 'placeholder', file, detail: `자리 글자가 남았습니다: ${line.slice(0, 120)}` })
    }
  }
  const notice = lf(readFileSync(path.join(root, NOTICE_FILE), 'utf8'))
  const a = notice.indexOf(BEGIN)
  const b = notice.indexOf(END)
  let want
  try {
    want = maplibreDependencySection(root)
  } catch (err) {
    problems.push({ kind: 'deps', file: NOTICE_FILE, detail: err instanceof Error ? err.message : String(err) })
    return problems
  }
  if (a < 0 || b < a) problems.push({ kind: 'deps', file: NOTICE_FILE, detail: 'maplibre-gl 의존 라이브러리 글이 없습니다 — node scripts/map-data/notice.mjs --write' })
  else if (notice.slice(a, b + END.length) !== want) {
    problems.push({ kind: 'deps', file: NOTICE_FILE, detail: 'maplibre-gl 의존 라이브러리 글이 node_modules와 다릅니다 — node scripts/map-data/notice.mjs --write' })
  }
  return problems
}

/** NOTICE-OSM.txt의 의존 라이브러리 절을 node_modules에서 다시 만든다(없으면 끝에 붙인다). 줄 끝은 파일의 것을 지킨다. */
export function writeDependencySection(root) {
  const file = path.join(root, NOTICE_FILE)
  const raw = readFileSync(file, 'utf8')
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const notice = lf(raw)
  const section = maplibreDependencySection(root)
  const a = notice.indexOf(BEGIN)
  const b = notice.indexOf(END)
  const next = a >= 0 && b > a ? `${notice.slice(0, a)}${section}${notice.slice(b + END.length)}` : `${notice.replace(/\n*$/, '\n')}\n${section}\n`
  writeFileSync(file, next.replace(/\n/g, eol))
  return maplibreDependencies(root).packages.length
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd()
  if (process.argv.includes('--write')) {
    const n = writeDependencySection(root)
    console.log(`[notice] ${NOTICE_FILE}에 maplibre-gl 의존 라이브러리 ${n}개의 라이선스 글을 넣었습니다.`)
  }
  const problems = noticeProblems(root)
  for (const p of problems) console.error(`[notice] ${p.file}: ${p.detail}`)
  if (problems.length) process.exit(1)
  console.log('[notice] 알림 파일 문제 없음')
}
