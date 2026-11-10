// server/index.ts를 tsx 없이 실행 가능한 단일 CJS 번들로 만든다 (Electron 패키징용).
// node_modules는 external로 두고(런타임에 electron-builder가 포함), 우리 소스만 번들한다.
// 지도 그리기(electron/mapRender.cjs)가 쓰는 라이브러리 파일도 dist-electron/map-vendor로 복사한다 — maplibre-gl · pmtiles는
// devDependencies라 설치본 node_modules에 없고, 패키지 전체(30MB) 대신 쓰는 파일(약 1.7MB)만 asar에 넣는다.
import { build } from 'esbuild'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { noticeProblems } from './map-data/notice.mjs'

// 지도 알림(map-data/NOTICE-OSM.txt · pmtiles.LICENSE.txt)이 완성되지 않았으면 설치본 재료를 만들지 않는다 — 자리 글자(「<저작권자 확인
// 필요>」 · TODO)가 든 라이선스 글이나 node_modules와 다른 의존 라이브러리 글이 설치본에 나가지 않게(map-data/README.md 「라이선스」).
const noticeIssues = noticeProblems(process.cwd())
if (noticeIssues.length) {
  for (const p of noticeIssues) console.error(`[build-electron-server] ${p.file}: ${p.detail}`)
  console.error('[build-electron-server] 지도 알림 파일이 완성되지 않아 멈춥니다 — 자리 글자를 채우거나 node scripts/map-data/notice.mjs --write로 다시 만드세요.')
  process.exit(1)
}

mkdirSync('dist-electron', { recursive: true })

// SerpAPI 시험 전용 env — 가짜 SerpAPI 서버 주소(127.0.0.1)와 짧은 시간 초과(server/serpApi.ts). 검증 스크립트만 쓴다 — 설치본에서는 이름째
// 지워 userData/.env나 환경변수로 진짜 키를 다른 주소로 보내거나 시간 초과를 바꿀 수 없게 한다(scripts/verify-serpapi-client.ts가 이 줄을 본다).
const SERPAPI_TEST_ENV = ['SERPAPI_BASE_URL', 'SERPAPI_TIMEOUT_MS']

const serverBuild = {
  entryPoints: ['server/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  packages: 'external', // node_modules는 번들하지 않음(네이티브·동적 require 호환)
  // 주소 한꺼번에 등록의 루프백 시험 깃발(server/postImport.ts)은 검증 스크립트만 켠다 — 설치본에서는 이름째 지워 userData/.env나
  // 환경변수로 켤 수 없게 한다(scripts/verify-post-import.ts가 이 줄을 본다).
  define: { 'process.env.POST_IMPORT_TEST_LOOPBACK': 'undefined' },
  outfile: 'dist-electron/server.cjs',
  logLevel: 'info',
}
for (const name of SERPAPI_TEST_ENV) serverBuild.define[`process.env.${name}`] = 'undefined'
// 진짜 SerpAPI 주소는 설치본 묶음에서만 쓴다 — 여기서 "1"로 박는다. dev · 시험 서버(tsx)는 SERPAPI_LIVE=1을 따로 주지 않으면 주소가 비어 있을 때
// 시작하지 않는다(저장소 .env의 진짜 키가 dev 화면에서 진짜 검색으로 나가지 않게 — server/serpApi.ts resolveSerpBase).
serverBuild.define['process.env.SERPAPI_LIVE'] = '"1"'
await build(serverBuild)

console.log('[build-electron-server] dist-electron/server.cjs 생성 완료')

const require = createRequire(import.meta.url)
const MAP_VENDOR = 'dist-electron/map-vendor'
const maplibreDir = path.dirname(require.resolve('maplibre-gl/package.json'))
// pmtiles의 exports에는 dist/pmtiles.js(IIFE 판)가 없어 package.json 위치에서 경로를 붙인다.
const pmtilesDir = path.dirname(require.resolve('pmtiles/package.json'))
const vendorFiles = [
  [path.join(maplibreDir, 'dist', 'maplibre-gl.mjs'), 'maplibre-gl.mjs'],
  [path.join(maplibreDir, 'dist', 'maplibre-gl-worker.mjs'), 'maplibre-gl-worker.mjs'],
  [path.join(maplibreDir, 'dist', 'maplibre-gl.css'), 'maplibre-gl.css'],
  [path.join(maplibreDir, 'LICENSE.txt'), 'maplibre-gl.LICENSE.txt'],
  [path.join(pmtilesDir, 'dist', 'pmtiles.js'), 'pmtiles.js'],
  // pmtiles npm 묶음에는 LICENSE 파일이 없다 — 저장소에 둔 라이선스 글(pmtiles.js에 함께 묶인 fflate 포함)을 넣는다.
  [path.join('map-data', 'pmtiles.LICENSE.txt'), 'pmtiles.LICENSE.txt'],
]
rmSync(MAP_VENDOR, { recursive: true, force: true })
mkdirSync(MAP_VENDOR, { recursive: true })
for (const [from, name] of vendorFiles) copyFileSync(from, path.join(MAP_VENDOR, name))
console.log(`[build-electron-server] ${MAP_VENDOR}/ 지도 라이브러리 ${vendorFiles.length}개 복사 완료`)
