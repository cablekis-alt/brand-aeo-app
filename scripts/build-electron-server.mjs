// server/index.ts를 tsx 없이 실행 가능한 단일 CJS 번들로 만든다 (Electron 패키징용).
// node_modules는 external로 두고(런타임에 electron-builder가 포함), 우리 소스만 번들한다.
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'

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
