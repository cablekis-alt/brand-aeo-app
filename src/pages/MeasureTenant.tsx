import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import ApiKeySettings from '../components/ApiKeySettings'
import { useTenant } from '../context/useTenant'

interface MeasureTenantOption {
  tenantId: string
  brandName: string
  cohortOnly?: boolean
}

type MeasureVia = 'local' | 'github' | 'none'

export default function MeasureTenant() {
  const { tenantId: currentTenantId } = useTenant()
  const [canMeasure, setCanMeasure] = useState(false)
  const [measureVia, setMeasureVia] = useState<MeasureVia>('none')
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
        const via = d.measureVia === 'local' || d.measureVia === 'github' ? (d.measureVia as MeasureVia) : 'none'
        setMeasureVia(via)
        setCanMeasure(Boolean(d.canMeasure) || via !== 'none')
        setHealthReady(true)
      })
      .catch(() => {
        if (alive) {
          setCanMeasure(false)
          setMeasureVia('none')
          setHealthReady(true)
        }
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
    if (!pickedTenant || !canMeasure) return
    setMeasuring(true)
    setMessage(
      measureVia === 'github'
        ? `${pickedTenant} GitHub Actions 측정 요청 중…`
        : `${pickedTenant} 측정 중… (수 분). 이 탭을 열어 두세요.`,
    )
    try {
      if (measureVia === 'github') {
        const res = await fetch('/api/measure-requests', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'run', tenantId: pickedTenant }),
        })
        const body = (await res.json().catch(() => ({}))) as { error?: string; htmlUrl?: string }
        if (!res.ok) throw new Error(body.error || `측정 요청 실패 (HTTP ${res.status})`)
        setMessage(
          `✓ GitHub Actions가 시작됐습니다. 수 분~수십 분 뒤 이 사이트에 점수가 반영됩니다.` +
            (body.htmlUrl ? ` 진행 상황: ${body.htmlUrl}` : ''),
        )
        return
      }
      const res = await fetch(`/api/tenants/${encodeURIComponent(pickedTenant)}/measure`, { method: 'POST' })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error || `측정 실패 (HTTP ${res.status})`)
      }
      const d = (await res.json()) as { brandName: string; aeoScore?: number }
      setMessage(
        `✓ ${d.brandName} 측정·baking 완료 (AEO Score ${d.aeoScore ?? '?'}). git commit + npx vercel --prod 로 배포하세요.`,
      )
    } catch (err) {
      setMessage(`✗ ${err instanceof Error ? err.message : '측정 실패'}`)
    } finally {
      setMeasuring(false)
    }
  }

  const picked = tenants.find((t) => t.tenantId === pickedTenant)
  const locked = healthReady && !canMeasure

  return (
    <>
      <p className="brand">STAGE 1</p>
      <h1>브랜드·경쟁사 측정</h1>
      <p className="lead">
        측정할 대상을 골라 실행합니다. <b>본 브랜드</b>를 고르면 <b>경쟁사·코호트까지 함께</b> 측정하고(랭킹 분석의 "이 브랜드
        측정"과 동일), <b>경쟁사</b>를 고르면 그 경쟁사 <b>하나만</b> 측정합니다(특정 경쟁사 스코어카드만 갱신). 배포에서는
        GitHub Actions가, 로컬에서는 이 탭에서 바로 측정합니다.
      </p>

      <ApiKeySettings />

      <section className={`panel${locked ? ' measure-local-only' : ''}`}>
        <h3>측정할 대상 선택</h3>
        <p className="muted">
          목록에는 내 브랜드와 경쟁사(<code>· 경쟁사</code> 표시)가 모두 있습니다.{' '}
          {!healthReady
            ? '환경을 확인하는 중…'
            : measureVia === 'local'
              ? '로컬 백엔드가 감지됐습니다. 선택 후 측정하면 baking까지 이어서 실행합니다.'
              : measureVia === 'github'
                ? '배포 환경입니다. 버튼은 GitHub Actions 측정을 시작하고, 완료·배포 후 새로고침하면 결과가 반영됩니다.'
                : '로컬에서만 측정 가능 — 배포에서 켜려면 Vercel에 GH_MEASURE_TOKEN을 넣으세요.'}
        </p>
        <div className="measure-pick">
          <select
            value={pickedTenant}
            onChange={(e) => setPickedTenant(e.target.value)}
            disabled={locked || measuring}
            aria-label="측정할 테넌트"
          >
            <option value="">테넌트 선택…</option>
            {tenants.map((t) => (
              <option key={t.tenantId} value={t.tenantId}>
                {t.brandName} ({t.tenantId}){t.cohortOnly ? ' · 경쟁사' : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="primary"
            onClick={() => void measureOne()}
            disabled={locked || !pickedTenant || measuring}
          >
            {measuring
              ? '진행 중…'
              : !canMeasure
                ? '로컬에서만 측정 가능'
                : picked?.cohortOnly
                  ? '이 경쟁사만 측정'
                  : '브랜드 전체 측정 (경쟁사·코호트 포함)'}
          </button>
        </div>
        {picked && (
          <p className="hint" style={{ marginTop: '10px' }}>
            {picked.cohortOnly ? (
              <>
                <b>{picked.brandName}</b> 경쟁사 하나만 측정합니다.
              </>
            ) : (
              <>
                <b>{picked.brandName}</b> + 경쟁사(도메인 없어도 이름 기준으로 코호트 측정)까지 함께 측정 → 코호트 순위 1/N이
                채워집니다.
              </>
            )}{' '}
            로컬 CLI: <code>npm run measure:local -- {picked.tenantId}</code>
          </p>
        )}
        {message && (
          <p className={message.startsWith('✗') ? 'error' : 'hint'} role="status" style={{ marginTop: '10px', fontWeight: 500 }}>
            {message}
          </p>
        )}
        {measureVia === 'github' && (
          <p className="hint" style={{ marginTop: '10px' }}>
            진행 상태는 <Link to="/measure-status">측정 상태</Link>에서 실시간으로 볼 수 있습니다.
          </p>
        )}
      </section>
    </>
  )
}
