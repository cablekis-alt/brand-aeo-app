import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

type MeasureVia = 'local' | 'github' | 'none'

/** 현재 브랜드 하나를 측정(경쟁사 SoM·코호트 포함)하는 버튼. 등록과 분리된 측정 진입점. */
export default function MeasureBrandButton({ tenantId, brandName }: { tenantId: string; brandName: string }) {
  const [measureVia, setMeasureVia] = useState<MeasureVia>('none')
  const [canMeasure, setCanMeasure] = useState(false)
  const [ready, setReady] = useState(false)
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
        setReady(true)
      })
      .catch(() => {
        if (alive) setReady(true)
      })
    return () => {
      alive = false
    }
  }, [])

  async function measure() {
    if (!tenantId || !canMeasure || measuring) return
    setMeasuring(true)
    setMessage(measureVia === 'github' ? '측정 요청 중…' : '측정 중… (수 분) 이 탭을 열어 두세요.')
    try {
      if (measureVia === 'github') {
        const res = await fetch('/api/measure-requests', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'run', tenantId }),
        })
        const body = (await res.json().catch(() => ({}))) as { error?: string; htmlUrl?: string }
        if (!res.ok) throw new Error(body.error || `측정 요청 실패 (HTTP ${res.status})`)
        setMessage(
          `✓ GitHub Actions 측정 시작 — ${brandName}. 경쟁사가 없으면 자동 추론해 함께 측정합니다. 완료·배포 후(수 분) 새로고침하면 순위·SoM이 반영됩니다.` +
            (body.htmlUrl ? ` 진행: ${body.htmlUrl}` : ''),
        )
        return
      }
      const res = await fetch(`/api/tenants/${encodeURIComponent(tenantId)}/measure`, { method: 'POST' })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error || `측정 실패 (HTTP ${res.status})`)
      }
      const d = (await res.json()) as { brandName: string; aeoScore?: number }
      setMessage(`✓ ${d.brandName} 측정 완료 (AEO Score ${d.aeoScore ?? '?'}). 새로고침하면 순위·SoM이 갱신됩니다.`)
    } catch (err) {
      setMessage(`✗ ${err instanceof Error ? err.message : '측정 실패'}`)
    } finally {
      setMeasuring(false)
    }
  }

  const locked = ready && !canMeasure

  return (
    <section className="panel" style={{ marginTop: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <button type="button" className="primary" onClick={() => void measure()} disabled={locked || measuring}>
          {measuring ? '측정 진행 중…' : '이 브랜드 측정 (경쟁사 SoM·코호트 포함)'}
        </button>
        <span className="hint" style={{ margin: 0 }}>
          {!ready
            ? '환경 확인 중…'
            : measureVia === 'github'
              ? 'GitHub Actions가 측정하고, 완료·배포 후 새로고침하면 이 화면에 반영됩니다.'
              : measureVia === 'local'
                ? '로컬에서 즉시 측정·반영합니다.'
                : '로컬에서만 측정 가능 — 배포는 Vercel에 GH_MEASURE_TOKEN 필요.'}
        </span>
      </div>
      {message && (
        <p className={message.startsWith('✗') ? 'error' : 'hint'} role="status" style={{ marginTop: '10px', fontWeight: 500 }}>
          {message}
        </p>
      )}
      {measureVia === 'github' && (
        <p className="hint" style={{ marginTop: '8px' }}>
          진행 상태는 <Link to="/measure-status">측정 상태</Link>에서 볼 수 있습니다.
        </p>
      )}
    </section>
  )
}
