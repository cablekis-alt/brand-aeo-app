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

## 패키징 (설치형 빌드)

```bash
npm run electron:pack        # 설치본(NSIS .exe) + 포터블 .exe 생성
npm run electron:pack:dir    # 설치 파일 없이 언팩된 앱 폴더만(빠른 검증용)
```

동작 순서: `vite build`(dist/) → 서버 번들(`dist-electron/server.cjs`, esbuild) → `electron-builder`.
산출물: `dist-electron/out/`.

패키징 모드에서는 vite 없이 **번들된 서버가 인프로세스로 떠서** `dist/`(정적 UI)와 `/api`를 같은 오리진(`:4000`)에서 서빙합니다.

### API 키(.env)

키는 **설치본에 굽지 않습니다**(보안). 패키징 앱은 아래 순서로 `.env`를 찾습니다:
1. 실행파일과 같은 폴더의 `.env`
2. 사용자 데이터 폴더(`%APPDATA%/Web4AI Brand AEO/.env`)의 `.env`

측정하려면 `OPENAI_API_KEY`·`GEMINI_API_KEY`·`ANTHROPIC_API_KEY`가 담긴 `.env`를 위 위치에 두세요.

### Windows EPERM(rename) 오류 시

프로젝트 폴더에서 빌드가 `EPERM: operation not permitted, rename ... win-unpacked` 로 실패하면(백신 실시간 검사/가상 FS), 출력 경로를 프로젝트 밖으로 돌리세요:

```bash
npx electron-builder --dir -c.directories.output=%TEMP%/eb-out
```

## 구조

| 파일 | 역할 |
|---|---|
| `electron/main.cjs` | 메인 프로세스 — 창 생성, (dev) API·vite 자식 프로세스 / (패키징) 번들 서버 인프로세스 기동, 외부 링크 처리 |
| `electron/preload.cjs` | 렌더러에 `window.electron`(플랫폼·버전) 최소 노출 (contextIsolation) |
| `scripts/build-electron-server.mjs` | `server/index.ts` → `dist-electron/server.cjs` 단일 CJS 번들(esbuild, node_modules는 external) |
| `electron-builder.yml` | 패키징 설정(appId·타깃·asar·파일 포함 규칙) |

정적 서빙은 `server/index.ts`가 `ELECTRON_STATIC_DIR` 환경변수가 있을 때만 `dist/`를 서빙(웹/dev에선 no-op).

보안 기본값: `contextIsolation: true`, `nodeIntegration: false`.

## 아직 안 된 것 (다음 단계)

- [ ] **로컬 측정 UX** — preload로 측정 트리거·진행률·git 반영을 네이티브하게 연결
- [ ] **패키징 모드 측정 경로** — 현재 `measureAndBake`는 `npx tsx scripts/...`를 execSync로 부르고 `src/data`에 써서 dev 체크아웃을 전제. 설치본에서 측정하려면 데이터 경로(userData)와 publish 방식을 재설계해야 함. **패키징 앱은 지금은 조회·대시보드 중심, 측정은 dev 셸(`npm run electron:dev`)에서.**
- [ ] **앱 아이콘** — 현재 기본 Electron 아이콘
- [ ] **코드 서명** — 미서명(설치 시 SmartScreen 경고)

파이프라인 코드(`server/`)는 웹과 단일 소스로 공유하므로, master의 측정 개선이 그대로 반영됩니다.
