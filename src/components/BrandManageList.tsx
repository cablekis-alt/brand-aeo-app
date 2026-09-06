import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTenant } from '../context/useTenant'

interface BrandRow {
  tenantId: string
  brandName: string
  industry: string
  region: string
  cohortOnly?: boolean
  competitors?: string[]
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}분 ${s % 60}초` : `${s}초`
}

export default function BrandManageList() {
  const { reloadTenants } = useTenant()
  const [rows, setRows] = useState<BrandRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  // GitHub Actions 완전 삭제가 진행 중인 tenantId — 실제로 사라질 때까지 행을 "삭제 중"으로 잠근다.
  const [deletingIds, setDeletingIds] = useState<string[]>([])
  // 삭제 시작 시각·워크플로우 링크 — "N분 M초 경과" 진행 표시용.
  const [deleteInfo, setDeleteInfo] = useState<Record<string, { at: number; htmlUrl?: string }>>({})
  const [nowTs, setNowTs] = useState(() => Date.now())
  const [message, setMessage] = useState<string | null>(null)
  // 측정 경로(local/github/none)와 진행 중인 측정 — 등록된 브랜드를 목록에서 바로 측정한다.
  const [measureVia, setMeasureVia] = useState<'local' | 'github' | 'none'>('none')
  const [measuringId, setMeasuringId] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetch('/api/health')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d) return
        setMeasureVia(d.measureVia === 'local' || d.measureVia === 'github' ? d.measureVia : 'none')
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  async function measureRow(row: BrandRow) {
    if (measuringId || measureVia === 'none') return
    setMeasuringId(row.tenantId)
    setMessage(
      measureVia === 'github'
        ? `${row.brandName} GitHub Actions 측정 요청 중…`
        : `${row.brandName} 측정 중… (수 분). 완료되면 대시보드·랭킹에 반영됩니다.`,
    )
    try {
      if (measureVia === 'github') {
        const res = await fetch('/api/measure-requests', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'run', tenantId: row.tenantId }),
        })
        const body = (await res.json().catch(() => ({}))) as { error?: string; htmlUrl?: string }
        if (!res.ok) throw new Error(body.error || `측정 요청 실패 (HTTP ${res.status})`)
        setMessage(`✓ ${row.brandName} GitHub Actions 측정 시작 — 수 분 뒤 반영됩니다.`)
        return
      }
      const res = await fetch(`/api/tenants/${encodeURIComponent(row.tenantId)}/measure`, { method: 'POST' })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error || `측정 실패 (HTTP ${res.status})`)
      }
      const d = (await res.json()) as { brandName?: string; aeoScore?: number }
      setMessage(`✓ ${d.brandName ?? row.brandName} 측정 완료 (AEO Score ${d.aeoScore ?? '?'}).`)
    } catch (err) {
      setMessage(`✗ ${err instanceof Error ? err.message : '측정 실패'}`)
    } finally {
      setMeasuringId(null)
    }
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      // all=1을 빼면 서버가 cohortOnly(자동 생성 코호트 경쟁사)를 제외하고 내가 등록한 브랜드만 준다.
      const res = await fetch('/api/tenants')
      const list = res.ok ? ((await res.json()) as BrandRow[]) : []
      list.sort((a, b) => a.brandName.localeCompare(b.brandName))
      setRows(list)
    } catch {
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 삭제 진행 중이면 1초마다 경과 시간을 갱신한다.
  useEffect(() => {
    if (deletingIds.length === 0) return
    const iv = window.setInterval(() => setNowTs(Date.now()), 1000)
    return () => window.clearInterval(iv)
  }, [deletingIds])

  // 삭제 진행 중인 브랜드가 있으면, 실제로 목록에서 사라질 때까지 주기적으로 확인한다.
  useEffect(() => {
    if (deletingIds.length === 0) return
    let alive = true
    const tick = async () => {
      try {
        const res = await fetch('/api/tenants')
        const fresh = res.ok ? ((await res.json()) as BrandRow[]) : []
        if (!alive) return
        fresh.sort((a, b) => a.brandName.localeCompare(b.brandName))
        setRows(fresh)
        const freshIds = new Set(fresh.map((r) => r.tenantId))
        const gone = deletingIds.filter((id) => !freshIds.has(id))
        if (gone.length > 0) {
          setDeletingIds((prev) => prev.filter((id) => freshIds.has(id)))
          setDeleteInfo((prev) => {
            const next = { ...prev }
            for (const id of gone) delete next[id]
            return next
          })
          setMessage(`✓ ${gone.length}개 브랜드 완전 삭제가 반영됐습니다.`)
          void reloadTenants()
        }
      } catch {
        // 무시 — 다음 주기에 다시 확인
      }
    }
    const iv = window.setInterval(() => void tick(), 15000)
    return () => {
      alive = false
      window.clearInterval(iv)
    }
  }, [deletingIds, reloadTenants])

  async function remove(row: BrandRow) {
    if (!window.confirm(`'${row.brandName}' (${row.tenantId}) 브랜드를 삭제할까요?`)) return
    setBusyId(row.tenantId)
    setMessage(null)
    try {
      const res = await fetch(`/api/tenants?tenantId=${encodeURIComponent(row.tenantId)}`, { method: 'DELETE' })
      const body = (await res.json().catch(() => ({}))) as { error?: string; stillBaked?: boolean; dispatched?: boolean; htmlUrl?: string }
      if (!res.ok) throw new Error(body.error || `삭제 실패 (HTTP ${res.status})`)
      if (!body.stillBaked) {
        // 오버레이 브랜드, 또는 로컬/데스크톱에서 베이크된 브랜드(툼스톤) — 즉시 완전 삭제됨.
        setRows((prev) => prev.filter((r) => r.tenantId !== row.tenantId))
        setMessage(`✓ '${row.brandName}' 삭제 완료.`)
        await reloadTenants()
      } else if (body.dispatched) {
        // 베이크된 브랜드 — GitHub Actions가 완전 삭제 실행 중. 사라질 때까지 "삭제 중"으로 잠근다.
        setDeletingIds((prev) => (prev.includes(row.tenantId) ? prev : [...prev, row.tenantId]))
        setDeleteInfo((prev) => ({ ...prev, [row.tenantId]: { at: Date.now(), htmlUrl: body.htmlUrl } }))
        setNowTs(Date.now())
        setMessage(
          `'${row.brandName}' 완전 삭제를 GitHub Actions에서 실행 중입니다. 완료되면 목록에서 자동으로 사라집니다(보통 3~5분).`,
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
        각 브랜드는 <b>"전체 측정"</b>으로 여기서 바로 경쟁사·코호트까지 함께 측정할 수 있습니다(STAGE 1로 갈 필요 없음).
        삭제 시 목록·선택지에서 즉시 사라집니다 — <b>데스크톱·로컬 앱</b>은 바로 완전 삭제, <b>배포 환경</b>은 GitHub Actions가
        커밋 데이터·점수까지 정리·자동 배포합니다(고아 경쟁사도 함께 정리, 공유 중인 경쟁사는 보존).
      </p>

      {message && (
        <p className={message.startsWith('✗') ? 'error' : 'hint'} role="status" style={{ fontWeight: 500 }}>
          {message} {measuringId && <Link to="/measure-status">측정 상태에서 진행 보기</Link>}
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
                <th style={{ whiteSpace: 'nowrap' }}>브랜드</th>
                <th style={{ whiteSpace: 'nowrap' }}>tenantId</th>
                <th style={{ whiteSpace: 'nowrap' }}>업종 · 지역</th>
                <th>경쟁사</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const deleting = deletingIds.includes(row.tenantId)
                const busy = busyId === row.tenantId || deleting
                return (
                  <tr key={row.tenantId} style={deleting ? { opacity: 0.55 } : undefined}>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {row.brandName}
                      {row.cohortOnly && <span className="hint"> · 경쟁사</span>}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <code>{row.tenantId}</code>
                    </td>
                    <td className="judgment" style={{ whiteSpace: 'nowrap' }}>
                      {row.industry} · {row.region}
                    </td>
                    <td className="judgment" style={{ minWidth: '260px' }}>
                      {row.cohortOnly ? (
                        <span className="muted">—</span>
                      ) : row.competitors && row.competitors.length > 0 ? (
                        row.competitors.join(', ')
                      ) : (
                        <span className="muted">측정 후 자동 채움</span>
                      )}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {deleting ? (
                        <span style={{ display: 'inline-flex', flexDirection: 'column', gap: '2px', alignItems: 'flex-start' }}>
                          <span className="hint" style={{ margin: 0 }}>
                            삭제 중… ({fmtElapsed(nowTs - (deleteInfo[row.tenantId]?.at ?? nowTs))} 경과 · 보통 3~5분)
                          </span>
                          {deleteInfo[row.tenantId]?.htmlUrl && (
                            <a
                              href={deleteInfo[row.tenantId]!.htmlUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="hint"
                              style={{ margin: 0 }}
                            >
                              진행 상황 보기 ↗
                            </a>
                          )}
                        </span>
                      ) : (
                        <span style={{ display: 'inline-flex', gap: '6px', alignItems: 'center' }}>
                          {measureVia !== 'none' && !row.cohortOnly && (
                            <button
                              type="button"
                              className="primary"
                              onClick={() => void measureRow(row)}
                              disabled={busy || measuringId !== null}
                            >
                              {measuringId === row.tenantId ? '측정 중…' : '전체 측정'}
                            </button>
                          )}
                          <button type="button" className="ghost" onClick={() => void remove(row)} disabled={busy || measuringId !== null}>
                            {busyId === row.tenantId ? '삭제 중…' : '삭제'}
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
