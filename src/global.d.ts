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
}

interface Window {
  electron?: ElectronBridge
}
