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

interface UpdateStatus {
  state: UpdateState
  version?: string
  latest?: string
  percent?: number
  message?: string
}

interface ElectronBridge {
  isElectron: true
  platform: string
  versions: { electron: string; node: string; chrome: string }
  /** 수동 업데이트 확인 → 현재 상태를 반환(이후 진행은 onUpdateStatus로 통지). */
  checkForUpdates: () => Promise<UpdateStatus>
  /** 다운로드된 업데이트를 지금 설치(앱 재시작). */
  quitAndInstall: () => Promise<void>
  /** 업데이트 상태 변화 구독. 해제 함수를 반환. */
  onUpdateStatus: (cb: (status: UpdateStatus) => void) => () => void
  /** 현재 설정된 API 키 상태(값은 노출 안 함, 존재 여부만). */
  apiKeyStatus: () => Promise<{ status: Record<string, boolean>; envPath: string }>
  /** API 키를 userData/.env에 저장하고 즉시 적용. */
  setApiKey: (name: string, value: string) => Promise<{ ok: boolean; error?: string }>
  /** 릴리스 페이지를 기본 브라우저로 연다(수동 다운로드용). */
  openReleases: () => Promise<void>
}

interface Window {
  electron?: ElectronBridge
}
