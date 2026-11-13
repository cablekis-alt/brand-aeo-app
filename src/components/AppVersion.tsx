import { useEffect, useState } from 'react'

// 사이드바 하단: 앱 버전 표시 + (Electron) 자동 업데이트 확인/설치.
// 웹에서는 버전만 보이고, 업데이트 UI는 데스크톱 앱에서만 나타난다.
export default function AppVersion() {
  const bridge = typeof window !== 'undefined' ? window.electron : undefined
  const isElectron = Boolean(bridge?.isElectron)
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    if (!bridge) return
    return bridge.onUpdateStatus((s) => setStatus(s))
  }, [bridge])

  // 창이 뜨기 전에 지나간 상태(시작 확인 결과 · 지난번 설치가 끝나지 않음)를 받아 온다. 그사이 새 상태가 왔으면 그것을 둔다.
  useEffect(() => {
    if (!bridge?.getUpdateStatus) return
    let alive = true
    bridge.getUpdateStatus().then(
      (s) => {
        if (alive && s) setStatus((prev) => prev ?? s)
      },
      (err: unknown) => console.warn('[AppVersion] 업데이트 상태를 읽지 못했습니다', err),
    )
    return () => {
      alive = false
    }
  }, [bridge])

  async function check() {
    if (!bridge) return
    setChecking(true)
    try {
      setStatus(await bridge.checkForUpdates())
    } catch {
      setStatus({ state: 'error', message: '확인 실패' })
    } finally {
      setChecking(false)
    }
  }

  const label = ((): string => {
    switch (status?.state) {
      case 'checking':
        return '업데이트 확인 중…'
      case 'available':
        return `새 버전 v${status.version ?? ''} 있음 — 자동으로 내려받는 중입니다.`
      case 'downloading':
        return `내려받는 중… ${status.percent ?? 0}%`
      case 'downloaded':
        return `새 버전 ${status.version ?? ''} 준비됨 — 재시작하여 설치하세요.`
      case 'not-available':
        return status.latest && status.latest !== __APP_VERSION__
          ? `현재 v${__APP_VERSION__} · 최신 v${status.latest} — "업데이트 확인"으로 받으세요.`
          : '최신 버전입니다.'
      case 'dev':
        return '개발 모드'
      case 'error':
        return `확인 실패: ${status.message ?? ''}`
      // 아래 「설치가 끝나지 않음」 줄이 알린다.
      case 'install-failed':
        return ''
      default:
        return ''
    }
  })()

  // 지난번 종료 때 설치를 시도했는데 버전이 그대로다(electron/updateLog.cjs). 스마트 앱 컨트롤 같은 Windows 보안이 서명 없는 설치
  // 파일을 막으면 그렇게 된다 — 막혔어도 앱 안에는 흔적이 없어 「껐다 켰는데 그대로」만 보였다.
  const failedVersion = status?.failedVersion && status.failedVersion !== __APP_VERSION__ ? status.failedVersion : null

  // 할 일이 없는 상태(최신 · 개발 모드) — 낮은 창에서는 숨겨 메뉴 자리를 넓힌다(App.css 조밀 모드).
  const quiet = status?.state === 'dev' || (status?.state === 'not-available' && !(status.latest && status.latest !== __APP_VERSION__))

  return (
    <div className="app-version">
      <div className="app-version-row">
        <span className="ver">v{__APP_VERSION__}</span>
        {isElectron &&
          (status?.state === 'downloaded' ? (
            <button type="button" className="ghost" onClick={() => void bridge?.quitAndInstall()}>
              재시작하여 설치
            </button>
          ) : (
            <button type="button" className="ghost" onClick={() => void check()} disabled={checking}>
              {checking ? '확인 중…' : '업데이트 확인'}
            </button>
          ))}
      </div>
      {isElectron && label && <p className={`upd-status${quiet ? ' is-quiet' : ''}`}>{label}</p>}
      {isElectron && failedVersion && (
        <p className="upd-status" role="status">
          지난번 v{failedVersion} 설치가 끝나지 않았습니다 — Windows 보안이 설치 파일을 막았을 수 있습니다.{' '}
          {/* 받아 둔 같은 설치 파일이 다시 확인되면 단추는 「재시작하여 설치」뿐이다 — 「업데이트 확인」은 같은 파일을 다시 쓸 뿐 새로 받지 않는다. */}
          {status?.state === 'downloaded' ? '「재시작하여 설치」로 한 번 더 시도하거나 ' : ''}
          <button type="button" className="linklike" onClick={() => void bridge?.openReleases()}>
            릴리스 페이지
          </button>
          에서 받아 설치하세요.
        </p>
      )}
    </div>
  )
}
