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

### 데이터 위치 (측정 결과·등록 브랜드)

설치본은 asar(읽기전용)를 피해 **사용자 데이터 폴더**(`app.getPath('userData')`, Windows는 `%APPDATA%/brand-aeo-app/`)에 씁니다:

| 항목 | 경로 |
|---|---|
| 측정 파이프라인 데이터 | `<userData>/data/<tenantId>/...` |
| 등록 브랜드(오버레이) | `<userData>/tenants.overlay.json` |
| 측정·삭제 대기열 | `<userData>/measure-requests.json`, `delete-requests.json` |

측정하면 결과가 여기에 저장되고 앱이 곧바로 읽어 대시보드·랭킹에 반영합니다. **git·tsx 없이** 로컬에서 완결됩니다(웹처럼 src/data baking·배포를 하지 않음). 이 경로 분기는 `server/appPaths.ts`(`APP_DATA_DIR`)가 담당하며, dev·웹에서는 미설정이라 기존 저장소 경로를 그대로 씁니다.

### API 키(.env)

키는 **설치본에 굽지 않습니다**(보안). 패키징 앱은 아래 순서로 `.env`를 찾습니다:
1. 실행파일과 같은 폴더의 `.env`
2. 사용자 데이터 폴더(`%APPDATA%/brand-aeo-app/.env`)의 `.env`

패키징 앱은 판정·수집 기본을 **Gemini**로 두므로(로컬 한국 측정이 가장 정확, OpenAI 크레딧 비의존) `GEMINI_API_KEY`만 있어도 측정됩니다. `OPENAI_API_KEY`·`ANTHROPIC_API_KEY`는 해당 엔진을 함께 쓸 때만 필요합니다. `.env`에서 `JUDGE_ENGINE`을 명시하면 그 값을 우선합니다.

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
| `electron-builder.yml` | 패키징 설정(appId·타깃·asar·아이콘·파일 포함 규칙) |
| `electron/build/icon.png` | 앱 아이콘 소스(512px). electron-builder가 각 크기·.ico로 변환 |

정적 서빙은 `server/index.ts`가 `ELECTRON_STATIC_DIR` 환경변수가 있을 때만 `dist/`를 서빙(웹/dev에선 no-op).

보안 기본값: `contextIsolation: true`, `nodeIntegration: false`.

### 코드 서명

인증서는 **저장소에 굽지 않습니다**. electron-builder는 아래 환경변수가 있으면 빌드 시 **자동 서명**합니다(별도 설정 불필요):

```bash
# Windows 예 (PowerShell)
$env:CSC_LINK="C:\path\to\cert.pfx"   # 또는 .pfx의 base64 문자열
$env:CSC_KEY_PASSWORD="<인증서 비밀번호>"
npm run electron:pack
```

- env가 없으면 **미서명**으로 빌드됩니다 — 설치 시 Windows SmartScreen 경고가 뜹니다(기능은 정상).
- 경고를 없애려면 **OV/EV 코드서명 인증서**(신뢰 CA 발급)가 필요합니다. EV는 즉시 평판이 붙고, OV는 초기 다운로드 수가 쌓이며 경고가 줄어듭니다.
- 비밀번호는 셸 히스토리에 남지 않도록 CI 시크릿/환경변수로 주입하세요.

## 완료

- [x] 개발 모드 셸 (`npm run electron:dev`)
- [x] electron-builder 패키징(설치본/포터블) + 번들 서버 + 정적 서빙
- [x] **패키징 모드 측정** — userData에 저장·조회, git·tsx 없이 로컬 완결(위 "데이터 위치" 참고)
- [x] **첫 실행 시드** — 설치 직후 커밋 데이터(코호트·분석)를 userData로 시드(`server/seedFirstRun.ts`)
- [x] **앱 아이콘** — AIO2O 모노그램(`electron/build/icon.png` 512px → electron-builder가 .ico 변환)
- [x] **코드 서명 지원** — CSC_LINK/CSC_KEY_PASSWORD env로 자동 서명(위 참고)

## 아직 안 된 것 (다음 단계)

- [ ] **실제 인증서 서명** — 신뢰 CA 인증서 확보 후 위 env로 빌드(현재는 미서명)
- [ ] **로컬 측정 UX** — preload로 측정 진행률·완료 알림을 네이티브하게 연결
- [ ] **자동 업데이트** — electron-updater(선택)

파이프라인 코드(`server/`)는 웹과 단일 소스로 공유하므로, master의 측정 개선이 그대로 반영됩니다.
