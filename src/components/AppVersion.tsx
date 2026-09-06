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
      default:
        return ''
    }
  })()

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
      {isElectron && label && <p className="upd-status">{label}</p>}
    </div>
  )
}
