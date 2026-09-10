import { readFileSync } from 'node:fs'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { defineConfig } from 'vite'

const pkgVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

// https://vite.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion), // 빌드 시 앱 버전 주입(UI 표시용)
  },
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] })
  ],
  server: {
    proxy: {
      // 데스크톱 앱이 :4000을 잡고 있으면 dev API를 다른 포트로 띄우고
      // API_PROXY_TARGET으로 가리킨다 (PORT=4100 npm run server:start 등).
      '/api': process.env.API_PROXY_TARGET ?? 'http://localhost:4000',
    },
  },
})
