import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTenant } from '../context/useTenant'
import { loadRemovedTenants, restoreTenant, saveTenantEngines, type RemovedTenantSummary } from '../lib/api'
import { variantTag } from '../lib/brandVariant'
import { objectParticle } from '../lib/korean'
import { runName, useMeasureStatus } from '../lib/measureStatus'
import type { Engine } from '../prompts/types'
import DeleteBrandDialog from './DeleteBrandDialog'

/** 데스크톱 앱 — 내부 id · 배포 경로 안내는 웹 · 개발 환경에서만 보인다(상용화 UI 3차 U4). preload가 스크립트보다 먼저 싣는다. */
const isDesktop = typeof window !== 'undefined' && Boolean(window.electron?.isElectron)

// ApiKeySettings와 같은 순서·이름을 쓴다 — 두 화면이 다른 이름을 쓰면 같은 엔진으로 안 보인다.
// 키 상태는 /api/health가 **엔진 id**로 색인해 준다. 환경변수 이름을 여기 두면 그걸로
// 조회하게 된다 — 실제로 그래서 네 엔진이 전부 "키 없음"으로 잠겼다(v0.1.98 회귀).
const ENGINES: { id: Engine; label: string }[] = [
  { id: 'gemini', label: 'Gemini' },
  { id: 'openai', label: 'ChatGPT' },
  { id: 'claude', label: 'Claude' },
  { id: 'perplexity', label: 'Perplexity' },
]

interface BrandRow {
  tenantId: string
  brandName: string
  industry: string
  region: string
  cohortOnly?: boolean
  competitors?: string[]
  engines?: Engine[]
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}분 ${s % 60}초` : `${s}초`
}

/**
 * 브랜드 관리 — 수집 엔진 · 측정 · 목록에서 빼기 · 지운 브랜드 되살리기(브랜드 현황의 「관리」 보기).
 *
 * 상용화 UI 3차(U15): 「전체 측정」은 여기서 바로 재지 않고 측정 화면으로 보낸다(「측정…」) — 함께 잴 경쟁사 · 방식 · 비용을 보고 시작하게.
 * 삭제는 브라우저 확인 창 대신 무엇이 남고 바뀌는지 알리는 대화상자에서 브랜드 이름을 입력해야 빠지고, 뺀 브랜드는 아래 「지운 브랜드」에서
 * 설정째 되살린다(데스크톱 · 로컬).
 */
export default function BrandManageList() {
  const { reloadTenants, tenants, setTenantId } = useTenant()
  const navigate = useNavigate()
  const status = useMeasureStatus()
  // 같은 홈페이지로 범위만 다르게 등록한 브랜드는 이름이 같다 — 범위 꼬리표로 가른다(상용화 UI 3차 U7).
  const tagOf = (tenantId: string) => {
    const t = tenants.find((x) => x.tenantId === tenantId)
    return t ? variantTag(t, tenants) : null
  }
  const labelOf = (row: { tenantId: string; brandName: string }) => {
    const tag = tagOf(row.tenantId)
    return tag ? `${row.brandName} · ${tag}` : row.brandName
  }
  const [rows, setRows] = useState<BrandRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  // GitHub Actions 완전 삭제가 진행 중인 tenantId — 실제로 사라질 때까지 행을 "삭제 중"으로 잠근다.
  const [deletingIds, setDeletingIds] = useState<string[]>([])
  // 삭제 시작 시각·워크플로우 링크 — "N분 M초 경과" 진행 표시용.
  const [deleteInfo, setDeleteInfo] = useState<Record<string, { at: number; htmlUrl?: string }>>({})
  const [nowTs, setNowTs] = useState(() => Date.now())
  const [message, setMessage] = useState<string | null>(null)
  // 방금 목록에서 뺀 브랜드 — 안내 끝의 「되돌리기」.
  const [undoId, setUndoId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<BrandRow | null>(null)
  const [removed, setRemoved] = useState<RemovedTenantSummary[]>([])
  const [restoringId, setRestoringId] = useState<string | null>(null)
  // 측정 경로(local/github/none) — 「측정…」은 측정 화면으로 보낸다.
  const [measureVia, setMeasureVia] = useState<'local' | 'github' | 'none'>('none')
  // 앱은 한 번에 하나씩 잰다 — 다른 측정이 도는 동안 「측정…」 · 빼기 · 되살리기를 잠근다.
  const busyRoot = status.runs?.current[0] ?? null
  const measuring = busyRoot !== null || status.active.length > 0
  const busyNote = measuring
    ? `${busyRoot ? runName(busyRoot, tenants) : (status.active[0]?.brandName ?? '')} 측정 중이에요 — 끝나면 측정 · 삭제할 수 있어요.`
    : undefined
  // 수집 엔진 — 어떤 키가 있는지(keyStatus)와 전역 지정이 켜져 있는지(globalEngines)를 알아야
  // 체크박스가 거짓말을 안 한다. 서버가 /api/health로 알려 준다(키 값이 아니라 존재 여부만).
  const [keyStatus, setKeyStatus] = useState<Record<string, boolean> | null>(null)
  const [globalEngines, setGlobalEngines] = useState<Engine[] | null>(null)
  // 엔진을 고칠 수 있는가 — 저장소가 data/<tenant>/engines.json(파일)이라 Vercel에서는 못 쓴다.
  // 팩트 그래프·브랜드 페이지도 같은 제약이다. 보여는 주되 체크박스는 잠근다. 삭제도 같은 기준이다 — Vercel이 아니면 이 PC(앱 서버)가
  // 지우고 되살리기를 남긴다.
  const [canEditEngines, setCanEditEngines] = useState(true)
  const [engineBusyId, setEngineBusyId] = useState<string | null>(null)
  const [engineMsg, setEngineMsg] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetch('/api/health')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d) return
        setMeasureVia(d.measureVia === 'local' || d.measureVia === 'github' ? d.measureVia : 'none')
        if (d.engineKeys) setKeyStatus(d.engineKeys as Record<string, boolean>)
        setCanEditEngines(d.backend !== 'vercel')
        setGlobalEngines((d.collectEngines as Engine[] | null | undefined) ?? null)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  /**
   * 엔진 하나를 켜고 끈다. 바로 저장한다 — "적용" 버튼을 따로 두면 어느 행을 고쳤는지
   * 잊는다. 실패하면 이전 값으로 되돌린다(낙관적 갱신).
   */
  async function toggleEngine(row: BrandRow, id: Engine) {
    if (engineBusyId) return
    const before = row.engines ?? []
    const next = before.includes(id) ? before.filter((e) => e !== id) : [...before, id]
    if (next.length === 0) {
      setEngineMsg('✗ 수집 엔진을 하나 이상 남겨야 합니다.')
      return
    }
    setEngineBusyId(row.tenantId)
    setEngineMsg(null)
    setRows((prev) => prev.map((r) => (r.tenantId === row.tenantId ? { ...r, engines: next } : r)))
    try {
      const saved = await saveTenantEngines(row.tenantId, next)
      setRows((prev) => prev.map((r) => (r.tenantId === row.tenantId ? { ...r, engines: saved } : r)))
      setEngineMsg(`${row.brandName} 수집 엔진을 ${saved.map((e) => ENGINES.find((x) => x.id === e)?.label ?? e).join(' · ')}(으)로 저장했습니다.`)
      await reloadTenants()
    } catch (err) {
      setRows((prev) => prev.map((r) => (r.tenantId === row.tenantId ? { ...r, engines: before } : r)))
      setEngineMsg(`✗ ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setEngineBusyId(null)
    }
  }

  /** 「측정…」 — 바로 재지 않고 측정 화면에서 함께 잴 경쟁사 · 방식을 확인하고 시작한다(브랜드 현황 줄의 「측정」과 같은 길). */
  const measureRow = (row: BrandRow) => {
    setTenantId(row.tenantId)
    navigate('/measure-tenant', { state: { pick: row.tenantId } })
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

  const loadRemoved = useCallback(() => {
    loadRemovedTenants().then(setRemoved, (err: unknown) => console.error('[BrandManageList] 지운 브랜드를 읽지 못했습니다', err))
  }, [])
  useEffect(() => {
    loadRemoved()
  }, [loadRemoved])

  async function restore(tenantId: string) {
    setRestoringId(tenantId)
    try {
      const r = await restoreTenant(tenantId)
      setMessage(`✓ ${objectParticle(r.brandName)} 되살렸습니다 — 설정 · 측정 기록 · 비교 그룹 순위가 지우기 전으로 돌아왔습니다.`)
      setUndoId(null)
      await load()
      await reloadTenants()
    } catch (err) {
      setMessage(`✗ ${err instanceof Error ? err.message : '되살리지 못했습니다'}`)
    } finally {
      setRestoringId(null)
      loadRemoved()
    }
  }

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
          setMessage(`✓ ${gone.length}개 브랜드 삭제가 반영됐습니다.`)
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
    // 범위만 다르게 등록한 형제가 있으면 어느 쪽을 뺐는지 알 수 있게 — 빼고 나면 형제가 사라져 꼬리표를 다시 만들 수 없다.
    const name = labelOf(row)
    setBusyId(row.tenantId)
    setMessage(null)
    setUndoId(null)
    try {
      const res = await fetch(`/api/tenants?tenantId=${encodeURIComponent(row.tenantId)}`, { method: 'DELETE' })
      const body = (await res.json().catch(() => ({}))) as {
        error?: string
        stillBaked?: boolean
        dispatched?: boolean
        htmlUrl?: string
        locallyDeleted?: boolean
      }
      if (!res.ok) throw new Error(body.error || `삭제 실패 (HTTP ${res.status})`)
      setDeleteTarget(null)
      if (!body.stillBaked) {
        // 오버레이 브랜드, 또는 로컬/데스크톱에서 베이크된 브랜드(툼스톤) — 목록에서 바로 빠진다. 로컬은 측정 기록이 남는다.
        setRows((prev) => prev.filter((r) => r.tenantId !== row.tenantId))
        if (body.locallyDeleted) {
          setMessage(`✓ ${objectParticle(name)} 목록에서 뺐습니다 — 측정 기록은 이 PC에 남아 있습니다.`)
          setUndoId(row.tenantId)
          loadRemoved()
        } else setMessage(`✓ ${objectParticle(name)} 목록에서 뺐습니다.`)
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
      setDeleteTarget(null)
      setMessage(`✗ ${err instanceof Error ? err.message : '삭제 실패'}`)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="panel" style={{ marginTop: '28px' }}>
      <h3>브랜드 관리</h3>
      <p className="hint" style={{ marginTop: 0 }}>
        각 브랜드는 <b>「측정…」</b>으로 바로 잴 수 있습니다 — 측정 화면에서 함께 잴 경쟁사와 방식을 확인하고 시작합니다.
        {/*
          데스크톱 앱에서는 배포 경로(GitHub Actions) · 개발 말(고아 경쟁사)을 쓰지 않는다(상용화 UI 3차 U4). 로컬 삭제는 지운 표시만
          달고 측정 기록은 남긴다(server/tenantRegistry.ts deleteTenantLocally) — 「완전 삭제」라고 하지 않는다.
        */}
        {isDesktop ? (
          ' 목록에서 빼면 선택지와 비교 그룹 순위에서 바로 빠집니다. 측정 기록은 이 PC에 남고, 아래 「지운 브랜드」에서 설정째 되살릴 수 있습니다.'
        ) : (
          <>
            {' '}
            삭제 시 목록·선택지에서 즉시 사라집니다 — <b>데스크톱·로컬 앱</b>은 목록에서 빼고 기록은 남김, <b>배포 환경</b>은 GitHub Actions가
            커밋 데이터·점수까지 정리·자동 배포합니다(고아 경쟁사도 함께 정리, 공유 중인 경쟁사는 보존).
          </>
        )}
      </p>

      {message && (
        <p className={message.startsWith('✗') ? 'error' : 'hint'} role="status" style={{ fontWeight: 500 }}>
          {message}{' '}
          {undoId && (
            <button type="button" className="ghost" onClick={() => void restore(undoId)} disabled={restoringId !== null || measuring} title={busyNote}>
              {restoringId === undoId ? '되돌리는 중…' : '되돌리기'}
            </button>
          )}
        </p>
      )}

      {keyStatus && !canEditEngines && (
        <p className="hint" style={{ marginTop: 0 }}>
          <b>수집 엔진</b>은 그 브랜드에 질문을 실제로 물어볼 엔진입니다. 웹에서는 <b>보기만</b> 됩니다 — 브랜드별 설정은
          이 PC의 파일에 저장되므로 <b>데스크톱 앱</b>에서 바꾸세요(팩트 그래프·브랜드 페이지 주소도 같습니다). 새로
          등록하는 브랜드는 <Link to="/brand-onboarding">온보딩 5단계</Link>에서 웹에서도 고를 수 있습니다.
        </p>
      )}

      {keyStatus &&
        canEditEngines &&
        (globalEngines ? (
          <p className="hint" style={{ marginTop: 0 }}>
            지금은 <b>전역 지정</b>이 켜져 있어 모든 브랜드가{' '}
            <b>{globalEngines.map((e) => ENGINES.find((x) => x.id === e)?.label ?? e).join(' · ')}</b>로 측정됩니다. 아래
            브랜드별 설정은 저장은 되지만 쓰이지 않습니다 — 쓰려면 <Link to="/measure-tenant">브랜드·경쟁사 측정</Link>의
            「수집 엔진」에서 <b>브랜드별 설정 사용</b>으로 바꾸세요.
          </p>
        ) : (
          <p className="hint" style={{ marginTop: 0 }}>
            <b>수집 엔진</b>은 그 브랜드에 질문을 실제로 물어볼 엔진입니다. 체크하면 바로 저장됩니다. 엔진을 늘리면
            측정 시간과 호출 수가 거의 비례해 늘고, <b>주차마다 엔진이 다르면 점수를 나란히 비교할 수 없습니다</b>.
          </p>
        ))}

      {engineMsg && (
        <p className={engineMsg.startsWith('✗') ? 'error' : 'hint'} role="status">
          {engineMsg}
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
                {!isDesktop && (
                  <th className="cell-text" style={{ whiteSpace: 'nowrap' }}>
                    tenantId
                  </th>
                )}
                <th style={{ whiteSpace: 'nowrap' }}>업종 · 지역</th>
                <th>경쟁사</th>
                {keyStatus && <th style={{ whiteSpace: 'nowrap' }}>수집 엔진</th>}
                <th className="brand-manage-act"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const deleting = deletingIds.includes(row.tenantId)
                const busy = busyId === row.tenantId || deleting
                return (
                  <tr key={row.tenantId} style={deleting ? { opacity: 0.55 } : undefined}>
                    {/* 데스크톱 앱에서는 내부 id 칸을 빼고 브랜드 이름 제목(마우스를 올리면)으로 둔다. */}
                    <td style={{ whiteSpace: 'nowrap' }} title={isDesktop ? row.tenantId : undefined}>
                      {row.brandName}
                      {tagOf(row.tenantId) && <span className="hint"> · {tagOf(row.tenantId)}</span>}
                      {row.cohortOnly && <span className="hint"> · 경쟁사</span>}
                    </td>
                    {!isDesktop && (
                      <td className="cell-text" style={{ whiteSpace: 'nowrap' }}>
                        <code>{row.tenantId}</code>
                      </td>
                    )}
                    <td className="judgment" style={{ minWidth: '8em' }}>
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
                    {keyStatus && (
                      <td className="judgment">
                        <span className="engine-cell">
                          {ENGINES.map((e) => {
                            const on = (row.engines ?? []).includes(e.id)
                            const keyMissing = !keyStatus[e.id]
                            return (
                              <label
                                key={e.id}
                                className={keyMissing || globalEngines || !canEditEngines ? 'disabled' : undefined}
                                title={
                                  !canEditEngines
                                    ? '웹에서는 등록된 브랜드의 엔진을 바꿀 수 없습니다 — 데스크톱 앱에서 바꾸세요.'
                                    : globalEngines
                                      ? '전역 지정이 켜져 있어 지금은 이 설정이 쓰이지 않습니다.'
                                      : keyMissing
                                        ? `${e.label} 키가 없어 이 엔진은 측정에서 빠집니다.`
                                        : undefined
                                }
                              >
                                <input
                                  type="checkbox"
                                  checked={on}
                                  disabled={
                                    busy || engineBusyId !== null || keyMissing || Boolean(globalEngines) || !canEditEngines
                                  }
                                  onChange={() => void toggleEngine(row, e.id)}
                                />{' '}
                                {e.label}
                              </label>
                            )
                          })}
                        </span>
                      </td>
                    )}
                    <td className="brand-manage-act" style={{ whiteSpace: 'nowrap' }}>
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
                              className="ghost"
                              onClick={() => measureRow(row)}
                              disabled={busy || measuring}
                              title={busyNote ?? `${row.brandName} 측정 화면으로 — 함께 잴 경쟁사를 확인하고 시작합니다`}
                            >
                              측정…
                            </button>
                          )}
                          <button type="button" className="ghost" onClick={() => setDeleteTarget(row)} disabled={busy || measuring} title={busyNote}>
                            {busyId === row.tenantId ? '빼는 중…' : '삭제…'}
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

      {removed.length > 0 && (
        <details className="bm-removed">
          <summary>지운 브랜드 {removed.length}곳</summary>
          <p className="hint">되살리면 지우기 전의 설정(경쟁사 · 수집 엔진)과 측정 기록이 돌아오고, 같은 비교 그룹의 순위를 다시 매깁니다.</p>
          <ul>
            {removed.map((r) => (
              <li key={r.tenantId}>
                <span className="bm-removed-name">{r.brandName}</span>
                <span className="hint">
                  {r.industry} · {r.region} · {new Date(r.removedAt).toLocaleDateString()} 뺌
                </span>
                <button type="button" className="ghost" onClick={() => void restore(r.tenantId)} disabled={restoringId !== null || measuring} title={busyNote}>
                  {restoringId === r.tenantId ? '되살리는 중…' : '되살리기'}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {deleteTarget && (
        <DeleteBrandDialog
          key={deleteTarget.tenantId}
          tenantId={deleteTarget.tenantId}
          brandName={deleteTarget.brandName}
          label={labelOf(deleteTarget)}
          local={canEditEngines}
          busy={busyId === deleteTarget.tenantId}
          onConfirm={() => void remove(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </section>
  )
}
