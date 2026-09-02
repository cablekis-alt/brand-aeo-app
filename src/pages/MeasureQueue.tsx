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
  }, [load])

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

      <div style={{ display: 'flex', gap: '10px', margin: '4px 0 20px' }}>
        <button type="button" className="ghost" onClick={() => void load()} disabled={loading}>
          {loading ? '불러오는 중…' : '새로고침'}
        </button>
        <span className="hint" style={{ alignSelf: 'center' }}>
          대기 {items.length}건
        </span>
      </div>

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
