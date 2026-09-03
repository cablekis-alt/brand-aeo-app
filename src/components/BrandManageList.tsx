import { useCallback, useEffect, useState } from 'react'
import { useTenant } from '../context/useTenant'

interface BrandRow {
  tenantId: string
  brandName: string
  industry: string
  region: string
  cohortOnly?: boolean
}

export default function BrandManageList() {
  const { reloadTenants } = useTenant()
  const [rows, setRows] = useState<BrandRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/tenants?all=1')
      setRows(res.ok ? ((await res.json()) as BrandRow[]) : [])
    } catch {
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function remove(row: BrandRow) {
    if (!window.confirm(`'${row.brandName}' (${row.tenantId}) 브랜드를 삭제할까요?`)) return
    setBusyId(row.tenantId)
    setMessage(null)
    try {
      const res = await fetch(`/api/tenants?tenantId=${encodeURIComponent(row.tenantId)}`, { method: 'DELETE' })
      const body = (await res.json().catch(() => ({}))) as { error?: string; stillBaked?: boolean; dispatched?: boolean; htmlUrl?: string }
      if (!res.ok) throw new Error(body.error || `삭제 실패 (HTTP ${res.status})`)
      if (!body.stillBaked) {
        // 오버레이 브랜드 — 즉시 완전 삭제됨.
        setRows((prev) => prev.filter((r) => r.tenantId !== row.tenantId))
        setMessage(`✓ '${row.brandName}' 삭제 완료.`)
        await reloadTenants()
      } else if (body.dispatched) {
        // 베이크된 브랜드 — GitHub Actions가 완전 삭제 실행 중. 완료되면 자동 반영.
        setMessage(
          `✓ '${row.brandName}' 완전 삭제를 GitHub Actions에서 실행 중입니다. 수 분 후 이 사이트에 자동 반영됩니다.` +
            (body.htmlUrl ? ` 진행 상황: ${body.htmlUrl}` : ''),
        )
      } else {
        // 베이크됐지만 원격 트리거 불가(토큰 없음) — 로컬 CLI 안내.
        setMessage(
          `⚠ '${row.brandName}'은(는) 커밋된 브랜드입니다. 오버레이·대기열은 제거했지만 완전 삭제는 로컬에서 ` +
            `npx tsx scripts/delete-tenant.ts ${row.tenantId} 실행 후 git commit + 배포가 필요합니다.`,
        )
      }
    } catch (err) {
      setMessage(`✗ ${err instanceof Error ? err.message : '삭제 실패'}`)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="panel" style={{ marginTop: '28px' }}>
      <h3>등록된 브랜드 관리</h3>
      <p className="hint" style={{ marginTop: 0 }}>
        오버레이로 등록한 브랜드는 즉시 삭제됩니다. 커밋된(베이크된) 브랜드는 삭제 시 GitHub Actions가 데이터·점수까지 완전
        삭제하고 자동 배포합니다(수 분 소요). 로컬에서는 <code>scripts/delete-tenant.ts</code>로 삭제합니다.
      </p>

      {message && (
        <p className={message.startsWith('✗') ? 'error' : 'hint'} role="status" style={{ fontWeight: 500 }}>
          {message}
        </p>
      )}

      {loading ? (
        <p className="muted">불러오는 중…</p>
      ) : rows.length === 0 ? (
        <p className="muted">등록된 브랜드가 없습니다.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>브랜드</th>
                <th>tenantId</th>
                <th>업종 · 지역</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.tenantId}>
                  <td>
                    {row.brandName}
                    {row.cohortOnly && <span className="hint"> · 경쟁사</span>}
                  </td>
                  <td>
                    <code>{row.tenantId}</code>
                  </td>
                  <td className="judgment">
                    {row.industry} · {row.region}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => void remove(row)}
                      disabled={busyId === row.tenantId}
                    >
                      {busyId === row.tenantId ? '삭제 중…' : '삭제'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
