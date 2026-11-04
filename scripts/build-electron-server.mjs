// server/index.ts를 tsx 없이 실행 가능한 단일 CJS 번들로 만든다 (Electron 패키징용).
// node_modules는 external로 두고(런타임에 electron-builder가 포함), 우리 소스만 번들한다.
// 지도 그리기(electron/mapRender.cjs)가 쓰는 라이브러리 파일도 dist-electron/map-vendor로 복사한다 — maplibre-gl · pmtiles는
// devDependencies라 설치본 node_modules에 없고, 패키지 전체(30MB) 대신 쓰는 파일(약 1.7MB)만 asar에 넣는다.
import { build } from 'esbuild'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

mkdirSync('dist-electron', { recursive: true })

await build({
  entryPoints: ['server/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  packages: 'external', // node_modules는 번들하지 않음(네이티브·동적 require 호환)
  outfile: 'dist-electron/server.cjs',
  logLevel: 'info',
})

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
