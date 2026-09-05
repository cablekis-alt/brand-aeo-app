import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTenant } from '../context/useTenant'

interface MeasureTenantOption {
  tenantId: string
  brandName: string
  cohortOnly?: boolean
}

export default function MeasureTenant() {
  const { tenantId: currentTenantId } = useTenant()
  // 측정은 로컬에서만 실행한다. localMode(로컬 백엔드)일 때만 버튼을, 배포 웹에선 로컬 실행 명령을 안내한다.
  const [localMode, setLocalMode] = useState(false)
  const [healthReady, setHealthReady] = useState(false)
  const [tenants, setTenants] = useState<MeasureTenantOption[]>([])
  const [pickedTenant, setPickedTenant] = useState('')
  const [measuring, setMeasuring] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetch('/api/health')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d) return
        setLocalMode(d.measureVia === 'local')
        setHealthReady(true)
      })
      .catch(() => {
        if (alive) setHealthReady(true)
      })
    fetch('/api/tenants?all=1')
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => {
        if (!alive) return
        const next = (Array.isArray(list) ? list : []) as MeasureTenantOption[]
        setTenants(next)
        setPickedTenant((current) => current || currentTenantId || next[0]?.tenantId || '')
      })
      .catch(() => {
        if (alive) setTenants([])
      })
    return () => {
      alive = false
    }
  }, [currentTenantId])

  async function measureOne() {
    if (!pickedTenant || !localMode) return
    setMeasuring(true)
    setMessage(`${pickedTenant} 측정 중… (수 분). 이 탭을 열어 두세요.`)
    try {
      const res = await fetch(`/api/tenants/${encodeURIComponent(pickedTenant)}/measure`, { method: 'POST' })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error || `측정 실패 (HTTP ${res.status})`)
      }
      const d = (await res.json()) as { brandName: string; aeoScore?: number }
      setMessage(`✓ ${d.brandName} 측정·baking 완료 (AEO Score ${d.aeoScore ?? '?'}). 새로고침하면 반영됩니다.`)
    } catch (err) {
      setMessage(`✗ ${err instanceof Error ? err.message : '측정 실패'}`)
    } finally {
      setMeasuring(false)
    }
  }

  const picked = tenants.find((t) => t.tenantId === pickedTenant)

  return (
    <>
      <p className="brand">STAGE 1</p>
      <h1>브랜드·경쟁사 측정</h1>
      <p className="lead">
        <b>브랜드 하나 또는 경쟁사</b>를 골라 개별 측정합니다. 상단 브랜드 선택과 무관하게 원하는 대상을 고를 수 있어,{' '}
        <b>특정 경쟁사 스코어카드만 갱신</b>할 때도 씁니다(경쟁사는 상단 브랜드 메뉴에 없어 여기서만 선택 가능).{' '}
        <b>측정은 로컬 PC에서만</b> 실행합니다 — 배포 웹에서는 아래 명령을 로컬 터미널에서 실행하세요.
      </p>

      <section className="panel">
        <h3>측정할 대상 선택</h3>
        <p className="muted">
          목록에는 내 브랜드와 경쟁사(<code>· 경쟁사</code> 표시)가 모두 있습니다.{' '}
          {!healthReady
            ? '환경을 확인하는 중…'
            : localMode
              ? '로컬 백엔드가 감지됐습니다. 선택 후 "측정 시작"을 누르면 PC에서 측정·baking까지 실행합니다.'
              : '배포 환경입니다. 측정은 로컬에서만 하므로, 대상을 고른 뒤 아래 명령을 로컬 터미널에서 실행하세요.'}
        </p>
        <div className="measure-pick">
          <select
            value={pickedTenant}
            onChange={(e) => setPickedTenant(e.target.value)}
            disabled={measuring}
            aria-label="측정할 테넌트"
          >
            <option value="">테넌트 선택…</option>
            {tenants.map((t) => (
              <option key={t.tenantId} value={t.tenantId}>
                {t.brandName} ({t.tenantId}){t.cohortOnly ? ' · 경쟁사' : ''}
              </option>
            ))}
          </select>
          {localMode && (
            <button type="button" className="primary" onClick={() => void measureOne()} disabled={!pickedTenant || measuring}>
              {measuring ? '진행 중…' : '측정 시작'}
            </button>
          )}
        </div>
        {picked && (
          <p className="hint" style={{ marginTop: '10px' }}>
            {localMode ? '로컬 CLI(선택): ' : '로컬 터미널에서: '}
            <code>npm run measure:local -- {picked.tenantId}</code>
          </p>
        )}
        {message && (
          <p className={message.startsWith('✗') ? 'error' : 'hint'} role="status" style={{ marginTop: '10px', fontWeight: 500 }}>
            {message}
          </p>
        )}
        <p className="hint" style={{ marginTop: '10px' }}>
          측정 기록은 <Link to="/measure-status">측정 상태</Link>에서 볼 수 있습니다.
        </p>
      </section>
    </>
  )
}
