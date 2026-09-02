import { useCallback, useEffect, useState } from 'react'

interface QueueTenant {
  tenantId: string
  brandName: string
  industry: string
  region: string
  ownedDomains: string[]
  competitors: { name: string }[]
}
interface MeasureRequest {
  tenant: QueueTenant
  requestedAt: string
}

export default function MeasureQueue() {
  const [items, setItems] = useState<MeasureRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [canMeasure, setCanMeasure] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [processMsg, setProcessMsg] = useState<string | null>(null)
  const [allTenants, setAllTenants] = useState<{ tenantId: string; brandName: string; cohortOnly?: boolean }[]>([])
  const [pickedTenant, setPickedTenant] = useState('')
  const [measuringOne, setMeasuringOne] = useState(false)
  const [measureOneMsg, setMeasureOneMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/measure-requests')
      if (!res.ok) throw new Error(`대기열을 불러오지 못했습니다 (HTTP ${res.status})`)
      setItems((await res.json()) as MeasureRequest[])
    } catch (err) {
      setError(err instanceof Error ? err.message : '대기열 조회 실패')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    fetch('/api/health')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const can = Boolean(d?.canMeasure)
        setCanMeasure(can)
        if (can) {
          fetch('/api/tenants?all=1')
            .then((r) => (r.ok ? r.json() : []))
            .then((list) => setAllTenants(list as typeof allTenants))
            .catch(() => setAllTenants([]))
        }
      })
      .catch(() => setCanMeasure(false))
  }, [load])

  // 선택한 테넌트 하나만 측정 + baking한다 (로컬 백엔드).
  async function measureOne() {
    if (!pickedTenant) return
    setMeasuringOne(true)
    setMeasureOneMsg(`${pickedTenant} 측정 중… (수 분). 이 탭을 열어 두세요.`)
    try {
      const res = await fetch(`/api/tenants/${encodeURIComponent(pickedTenant)}/measure`, { method: 'POST' })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error || `측정 실패 (HTTP ${res.status})`)
      }
      const d = (await res.json()) as { brandName: string; aeoScore?: number }
      setMeasureOneMsg(
        `✓ ${d.brandName} 측정·baking 완료 (AEO Score ${d.aeoScore ?? '?'}). git commit + npx vercel --prod 로 배포하세요.`,
      )
      await load()
    } catch (err) {
      setMeasureOneMsg(`✗ ${err instanceof Error ? err.message : '측정 실패'}`)
    } finally {
      setMeasuringOne(false)
    }
  }

  // 로컬 백엔드에서 대기열 전체를 측정 + publish + 정리한다 (수 분 소요).
  async function processAll() {
    setProcessing(true)
    setProcessMsg(`측정 중… 대기 ${items.length}건을 순서대로 처리합니다 (브랜드당 수 분). 이 탭을 열어 두세요.`)
    try {
      const res = await fetch('/api/measure-requests/process', { method: 'POST' })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error || `처리 실패 (HTTP ${res.status})`)
      }
      const data = (await res.json()) as {
        processed: number
        results: { brandName: string; aeoScore?: number; ok: boolean; error?: string }[]
      }
      const done = data.results.filter((r) => r.ok)
      const failed = data.results.filter((r) => !r.ok)
      setProcessMsg(
        `✓ ${done.length}건 측정·publish 완료` +
          (done.length ? ` — ${done.map((r) => `${r.brandName}(${r.aeoScore})`).join(', ')}` : '') +
          (failed.length ? ` · 실패 ${failed.length}건` : '') +
          `. 이제 git commit + npx vercel --prod 로 배포하세요.`,
      )
      await load()
    } catch (err) {
      setProcessMsg(`✗ ${err instanceof Error ? err.message : '처리 실패'}`)
    } finally {
      setProcessing(false)
    }
  }

  async function cancel(tenantId: string) {
    setBusyId(tenantId)
    try {
      const res = await fetch(`/api/measure-requests?tenantId=${encodeURIComponent(tenantId)}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`취소 실패 (HTTP ${res.status})`)
      setItems((prev) => prev.filter((r) => r.tenant.tenantId !== tenantId))
    } catch (err) {
      setError(err instanceof Error ? err.message : '요청 취소 실패')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
      <p className="brand">S-11 · 브랜드 관리</p>
      <h1>측정 대기열</h1>
      <p className="lead">
        배포 사이트에서 등록된 브랜드의 <b>측정 요청</b> 목록입니다. 측정(질문 × 엔진 × 반복, 수 분)은 서버리스
        함수에서 못 돌리므로, 이 대기열을 <b>로컬 CLI</b>가 처리합니다.
      </p>

      <div style={{ display: 'flex', gap: '10px', margin: '4px 0 12px', flexWrap: 'wrap' }}>
        {canMeasure && (
          <button type="button" className="primary" onClick={() => void processAll()} disabled={processing || items.length === 0}>
            {processing ? '측정 중…' : `측정 실행 (${items.length}건)`}
          </button>
        )}
        <button type="button" className="ghost" onClick={() => void load()} disabled={loading || processing}>
          {loading ? '불러오는 중…' : '새로고침'}
        </button>
        <span className="hint" style={{ alignSelf: 'center' }}>대기 {items.length}건</span>
      </div>
      <p className="hint" style={{ marginTop: 0 }}>
        {canMeasure
          ? '로컬 백엔드 감지됨 — "측정 실행"으로 대기열을 바로 측정·publish합니다 (완료 후 커밋·배포).'
          : '측정은 로컬에서만 실행됩니다. 아래 명령을 참고하세요.'}
      </p>

      {processMsg && (
        <p className={processMsg.startsWith('✗') ? 'error' : 'hint'} role="status" style={{ fontWeight: 500 }}>
          {processMsg}
        </p>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {!loading && items.length === 0 ? (
        <section className="panel">
          <p className="muted">측정 대기열이 비어 있습니다. 배포 사이트의 S-08에서 브랜드를 등록하면 여기에 쌓입니다.</p>
        </section>
      ) : (
        <section>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>브랜드</th>
                  <th>tenantId</th>
                  <th>업종 · 지역</th>
                  <th>경쟁사</th>
                  <th>요청일</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.tenant.tenantId}>
                    <td>{r.tenant.brandName}</td>
                    <td>
                      <code>{r.tenant.tenantId}</code>
                    </td>
                    <td className="judgment">
                      {r.tenant.industry} · {r.tenant.region}
                    </td>
                    <td>{r.tenant.competitors?.length ?? 0}곳</td>
                    <td>{r.requestedAt.slice(0, 10)}</td>
                    <td>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => void cancel(r.tenant.tenantId)}
                        disabled={busyId === r.tenant.tenantId}
                      >
                        {busyId === r.tenant.tenantId ? '취소 중…' : '요청 취소'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {canMeasure && (
        <section className="panel" style={{ marginTop: '20px' }}>
          <h3>테넌트 골라 측정</h3>
          <p className="muted">대기열과 무관하게 특정 테넌트 하나를 지금 측정 + baking합니다.</p>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
            <select
              value={pickedTenant}
              onChange={(e) => setPickedTenant(e.target.value)}
              style={{ padding: '9px 12px', border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', borderRadius: '2px', font: 'inherit', minWidth: '260px' }}
            >
              <option value="">테넌트 선택…</option>
              {allTenants.map((t) => (
                <option key={t.tenantId} value={t.tenantId}>
                  {t.brandName} ({t.tenantId}){t.cohortOnly ? ' · 경쟁사' : ''}
                </option>
              ))}
            </select>
            <button type="button" className="primary" onClick={() => void measureOne()} disabled={!pickedTenant || measuringOne}>
              {measuringOne ? '측정 중…' : '선택 측정'}
            </button>
          </div>
          {measureOneMsg && (
            <p className={measureOneMsg.startsWith('✗') ? 'error' : 'hint'} role="status" style={{ marginTop: '10px', fontWeight: 500 }}>
              {measureOneMsg}
            </p>
          )}
        </section>
      )}

      <section className="panel" style={{ marginTop: '20px' }}>
        <h3>로컬에서 처리하기</h3>
        <p className="muted">대기열을 확인하고, 측정 + baking + 대기열 정리까지 한 번에:</p>
        <pre className="json-block">{`# 목록만 보기
npx tsx scripts/measure-requests.ts

# 대기 중인 브랜드를 모두 측정 + publish + 대기열 정리
npx tsx scripts/measure-requests.ts --measure

# 이후 공개
git commit -am "data: measure queued brands" && npx vercel --prod`}</pre>
        <p className="hint">
          측정에는 OpenAI/Gemini 키가 필요합니다. 처리가 끝난 요청은 자동으로 이 대기열에서 사라집니다.
        </p>
      </section>
    </>
  )
}
