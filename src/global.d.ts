// 빌드 시 vite가 주입하는 앱 버전.
declare const __APP_VERSION__: string

// Electron preload가 노출하는 API (contextIsolation). 웹에서는 window.electron이 없다.
type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'dev'
  /** 지난번 종료 때 설치를 시도했는데 버전이 그대로 — 아직 다른 확인 결과가 없을 때만 이 상태로 온다. */
  | 'install-failed'

interface UpdateStatus {
  state: UpdateState
  version?: string
  latest?: string
  percent?: number
  message?: string
  /** 지난번 종료 때 설치가 끝나지 않은 버전(electron/updateLog.cjs) — 어느 상태에든 붙어 함께 알린다. */
  failedVersion?: string
}

interface ElectronBridge {
  isElectron: true
  platform: string
  versions: { electron: string; node: string; chrome: string }
  /** 수동 업데이트 확인 → 현재 상태를 반환(이후 진행은 onUpdateStatus로 통지). */
  checkForUpdates: () => Promise<UpdateStatus>
  /** 지금 업데이트 상태(창이 늦게 떠 놓친 상태 포함). 없으면 null. 옛 preload에는 없다. */
  getUpdateStatus?: () => Promise<UpdateStatus | null>
  /** 다운로드된 업데이트를 지금 설치(앱 재시작). */
  quitAndInstall: () => Promise<void>
  /** 업데이트 상태 변화 구독. 해제 함수를 반환. */
  onUpdateStatus: (cb: (status: UpdateStatus) => void) => () => void
  /** 현재 설정된 API 키 상태(값은 노출 안 함, 존재 여부만). */
  apiKeyStatus: () => Promise<{
    status: Record<string, boolean>
    envPath: string
    judgeEngine?: string
    writerEngine?: string
    collectEngines?: string[] | null
  }>
  /** API 키를 userData/.env에 저장하고 즉시 적용. */
  setApiKey: (name: string, value: string) => Promise<{ ok: boolean; error?: string }>
  /**
   * 수집 엔진 전역 지정(COLLECT_ENGINES)을 저장하고 즉시 적용.
   * null 또는 빈 배열이면 "브랜드별 설정 사용"으로 되돌린다.
   */
  setCollectEngines: (
    engines: string[] | null,
  ) => Promise<{ ok: boolean; engines?: string[] | null; needsRestart?: boolean; error?: string }>
  /** 릴리스 페이지를 기본 브라우저로 연다(수동 다운로드용). */
  openReleases: () => Promise<void>
  /** 창을 앞으로(측정 결과 알림을 눌렀을 때). 옛 preload에는 없다. */
  focusWindow?: () => Promise<void>
  /** 창이 뒤에 있으면 작업 표시줄 단추를 깜빡인다(측정 실패). 옛 preload에는 없다. */
  flashWindow?: () => Promise<void>
}

interface Window {
  electron?: ElectronBridge
}
