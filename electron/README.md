# Electron 데스크톱 셸

한국 리전 로컬 PC에서 **정확한 측정**을 돌리기 위한 데스크톱 껍데기입니다. 웹(Vercel)과 **동일한 React UI**에 로컬 Express API(`server/index.ts`)를 붙여 한 창에서 띄웁니다.

- 웹 배포(Vercel/GitHub Actions): 미국 리전이라 한국어 브랜드 회상이 부정확 → 측정은 프리즈 상태.
- 이 데스크톱 앱: 로컬(한국)에서 실행 → 회상 정확, 서버 비용 $0.

## 실행 (개발 모드)

```bash
npm run electron:dev
```

동작:
1. 로컬 API 서버(`tsx server/index.ts`, `:4000`)를 자식 프로세스로 기동
2. vite 개발 서버(`npm run dev`, `:5173`)를 자식 프로세스로 기동 (`/api` → `:4000` 프록시)
3. vite가 준비되면 Electron 창이 그 UI를 로드

`.env`(OPENAI/GEMINI/ANTHROPIC 키)는 프로젝트 루트 것을 그대로 씁니다.

## 구조

| 파일 | 역할 |
|---|---|
| `electron/main.cjs` | 메인 프로세스 — 창 생성, API·vite 자식 프로세스 관리, 외부 링크 처리 |
| `electron/preload.cjs` | 렌더러에 `window.electron`(플랫폼·버전) 최소 노출 (contextIsolation) |

보안 기본값: `contextIsolation: true`, `nodeIntegration: false`.

## 아직 안 된 것 (다음 단계)

- [ ] **패키징** — `electron-builder`로 설치형(.exe/.dmg) 만들기
- [ ] **정적 서빙** — 패키징 시 vite 없이 `dist/`를 Express가 서빙 (`app.use(express.static('dist'))`)해 같은 오리진에서 `/api` 동작
- [ ] **컴파일된 서버** — tsx 대신 번들/컴파일된 서버를 앱에 내장
- [ ] **로컬 측정 UX** — preload로 측정 트리거·진행률·git 반영을 네이티브하게 연결

현재는 **개발 모드 셸**까지가 스캐폴딩 범위입니다. 파이프라인 코드(`server/`)는 웹과 단일 소스로 공유하므로, master의 측정 개선이 그대로 반영됩니다.
