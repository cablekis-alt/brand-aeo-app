import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

type MeasureVia = 'local' | 'github' | 'none'

/**
 * 현재 브랜드 측정 진입점. 측정은 로컬에서만 실행한다.
 * - localhost(로컬 백엔드) → "이 브랜드 측정" 버튼(PC에서 즉시 측정).
 * - 배포 웹 → 측정 불가(웹은 PC를 못 씀) → 로컬 실행(measure:local) 안내만.
 */
export default function MeasureBrandButton({ tenantId }: { tenantId: string }) {
  const [measureVia, setMeasureVia] = useState<MeasureVia>('none')
  const [measuring, setMeasuring] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetch('/api/health')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d) return
        setMeasureVia(d.measureVia === 'local' || d.measureVia === 'github' ? (d.measureVia as MeasureVia) : 'none')
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  async function measureLocal() {
    if (!tenantId || measuring) return
    setMeasuring(true)
    setMessage('측정 중… (수 분) 이 탭을 열어 두세요.')
    try {
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

  return (
    <section className="panel" style={{ marginTop: '16px' }}>
      {measureVia === 'local' ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <button type="button" className="primary" onClick={() => void measureLocal()} disabled={measuring}>
              {measuring ? '측정 진행 중…' : '이 브랜드 측정 (경쟁사 SoM·코호트 포함)'}
            </button>
            <span className="hint" style={{ margin: 0 }}>로컬 PC에서 즉시 측정·반영합니다.</span>
          </div>
          {message && (
            <p className={message.startsWith('✗') ? 'error' : 'hint'} role="status" style={{ marginTop: '10px', fontWeight: 500 }}>
              {message}
            </p>
          )}
        </>
      ) : (
        <>
          <p className="hint" style={{ margin: 0 }}>
            측정은 <b>로컬 PC</b>에서 실행합니다(정확도·비용 이점). 터미널에서:
          </p>
          <p className="hint" style={{ margin: '8px 0 0' }}>
            <code>npm run measure:local -- {tenantId || '<tenantId>'}</code>
          </p>
          <p className="hint" style={{ marginTop: '8px' }}>
            완료되면 결과가 배포에 반영되고(새로고침), 기록은 <Link to="/measure-status">측정 상태</Link>에서 볼 수 있습니다.
          </p>
        </>
      )}
    </section>
  )
}
