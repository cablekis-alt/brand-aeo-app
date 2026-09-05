import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { cancelMeasureRun, loadMeasureRuns, type MeasureRunInfo } from '../lib/api'
import measureLogRaw from '../data/measure-log.json'
import scorecardsRaw from '../data/demo-scorecards.json'

// best-effort — tenantId → 최신 스코어카드(주차·AEO). 성공 run의 주차·AEO 열에 붙인다.
interface ScRow {
  tenantId: string
  weekOf: string
  aeoScore: { current: number }
}
const latestByTenant: Record<string, { weekOf: string; aeo: number }> = {}
for (const c of scorecardsRaw as ScRow[]) {
  const prev = latestByTenant[c.tenantId]
  if (!prev || c.weekOf > prev.weekOf) latestByTenant[c.tenantId] = { weekOf: c.weekOf, aeo: c.aeoScore.current }
}
function runTenantId(title: string): string | null {
  const m = title.match(/^measure\s+(.+)$/)
  const id = m?.[1]?.trim()
  return !id || id === '__queue__' ? null : id
}

// 로컬 측정 기록(measure:local이 커밋). GitHub Actions 실행 목록과 별도로 표시한다.
interface LocalMeasureLog {
  tenantId: string
  brandName: string
  weekOf: string
  aeoScore: number
  at: string
  durationSec?: number
  source: string
}
const localLog = measureLogRaw as LocalMeasureLog[]

// 초 → "N분 M초" / "N초"
function fmtSec(sec?: number): string {
  if (typeof sec !== 'number' || !Number.isFinite(sec)) return '-'
  const s = Math.max(0, Math.round(sec))
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}분 ${s % 60}초` : `${s}초`
}

// GitHub Actions 실행 상태 → 한국어 배지 + B9에서 쓰는 status-pill 색상 클래스.
function statusBadge(run: MeasureRunInfo): { label: string; cls: string } {
  if (run.status !== 'completed') {
    if (run.status === 'in_progress') return { label: '진행 중', cls: 'st-warn' }
    return { label: '대기', cls: 'st-ok' }
  }
  switch (run.conclusion) {
    case 'success':
      return { label: '성공', cls: 'st-good' }
    case 'failure':
      return { label: '실패', cls: 'st-bad' }
    case 'cancelled':
      return { label: '취소', cls: 'st-unknown' }
    case 'skipped':
      return { label: '건너뜀', cls: 'st-unknown' }
    default:
      return { label: run.conclusion ?? '완료', cls: 'st-warn' }
  }
}

// run-name "measure <tenantId>"(소문자) → 대상 라벨. tenantId는 nameMap으로 실제 브랜드명으로 치환.
function targetLabel(title: string, nameMap: Record<string, string>): string {
  const m = title.match(/^measure\s+(.+)$/)
  if (!m) return title
  const id = m[1].trim()
  if (id === '__queue__') return '대기열 전체'
  return nameMap[id] || id // 삭제됐거나 미매칭이면 tenantId 그대로
}

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return '-'
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 60) return `${s}초 전`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}분 전`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}시간 전`
  return `${Math.round(h / 24)}일 전`
}

function duration(run: MeasureRunInfo): string {
  const start = new Date(run.createdAt).getTime()
  const end = run.status === 'completed' ? new Date(run.updatedAt).getTime() : Date.now()
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '-'
  const s = Math.max(0, Math.round((end - start) / 1000))
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}분 ${s % 60}초` : `${s}초`
}

export default function MeasureStatus() {
  const [runs, setRuns] = useState<MeasureRunInfo[]>([])
  const [enabled, setEnabled] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [auto, setAuto] = useState(true)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const [nameMap, setNameMap] = useState<Record<string, string>>({})
  const [cancelling, setCancelling] = useState<number | null>(null)
  const timer = useRef<number | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await loadMeasureRuns()
      setEnabled(data.enabled)
      setRuns(data.runs)
      setError(null)
      setUpdatedAt(new Date())
    } catch (err) {
      setError(err instanceof Error ? err.message : '상태를 불러오지 못했습니다.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // tenantId → 브랜드명 매핑(GitHub 표 "대상"에 실제 이름 표시). 경쟁사 포함(all=1).
  useEffect(() => {
    let alive = true
    fetch('/api/tenants?all=1')
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => {
        if (!alive || !Array.isArray(list)) return
        const map: Record<string, string> = {}
        for (const t of list) if (t?.tenantId) map[t.tenantId] = t.brandName || t.tenantId
        setNameMap(map)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // 진행 중인 실행이 있으면 자동 새로고침을 계속한다.
  useEffect(() => {
    if (!auto) {
      if (timer.current) window.clearInterval(timer.current)
      return
    }
    timer.current = window.setInterval(() => void load(), 8000)
    return () => {
      if (timer.current) window.clearInterval(timer.current)
    }
  }, [auto, load])

  const active = runs.some((r) => r.status !== 'completed')

  async function onCancel(run: MeasureRunInfo) {
    if (!run.id) return
    if (!window.confirm(`'${targetLabel(run.title, nameMap)}' 측정을 취소할까요?`)) return
    setCancelling(run.id)
    try {
      await cancelMeasureRun(run.id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '취소 실패')
    } finally {
      setCancelling(null)
    }
  }

  return (
    <>
      <p className="brand">STAGE 2</p>
      <h1>측정 상태</h1>
      <p className="lead">
        GitHub Actions 측정 실행의 진행 상태와, 로컬(<code>npm run measure:local</code>)에서 측정한 기록입니다. 완료·배포 후 새로고침하면 결과가 반영됩니다.
      </p>

      <div className="filters no-print" style={{ alignItems: 'center' }}>
        <button type="button" className="ghost" onClick={() => void load()} disabled={loading}>
          {loading ? '불러오는 중…' : '새로고침'}
        </button>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          자동 새로고침(8초)
        </label>
        {updatedAt && <span className="hint">마지막 갱신 {updatedAt.toLocaleTimeString()}</span>}
        {active && <span className="status-pill st-warn">진행 중인 측정 있음</span>}
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <section style={{ marginTop: '8px' }}>
        <h3>GitHub Actions 측정 실행</h3>
        <p className="hint" style={{ marginTop: 0 }}>
          주차·AEO는 성공 run에 한해 해당 브랜드의 <b>최신 스코어카드</b>를 붙인 best-effort 값입니다(실패·미매칭은 <code>-</code>).
        </p>
        {!enabled ? (
          <p className="muted">
            배포 환경에서 <code>GH_MEASURE_TOKEN</code>이 설정되어야 실행 상태를 볼 수 있습니다. 아래 로컬 측정 기록은 토큰 없이도 보입니다.
          </p>
        ) : !loading && runs.length === 0 ? (
          <p className="muted">
            최근 GitHub Actions 실행이 없습니다. <Link to="/measure-tenant">테넌트 골라 측정</Link>에서 시작하거나, 로컬에서{' '}
            <code>npm run measure:local</code>을 쓰세요.
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>상태</th>
                  <th>대상</th>
                  <th>주차</th>
                  <th>AEO</th>
                  <th>측정시간</th>
                  <th>경과</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const badge = statusBadge(run)
                  const id = runTenantId(run.title)
                  const sc = run.conclusion === 'success' && id ? latestByTenant[id] : undefined
                  return (
                    <tr key={run.runNumber}>
                      <td>
                        <span className={`status-pill ${badge.cls}`}>{badge.label}</span>
                      </td>
                      <td>{targetLabel(run.title, nameMap)}</td>
                      <td>{sc?.weekOf ?? '-'}</td>
                      <td className="num">{sc?.aeo ?? '-'}</td>
                      <td className="num">{duration(run)}</td>
                      <td>{timeAgo(run.createdAt)}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {run.status !== 'completed' && (
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => void onCancel(run)}
                            disabled={cancelling === run.id}
                            style={{ marginRight: '8px' }}
                          >
                            {cancelling === run.id ? '취소 중…' : '취소'}
                          </button>
                        )}
                        <a href={run.htmlUrl} target="_blank" rel="noreferrer" className="rec-link">
                          로그 →
                        </a>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {localLog.length > 0 && (
        <section style={{ marginTop: '24px' }}>
          <h3>로컬 측정 기록 (measure:local)</h3>
          <p className="hint" style={{ marginTop: 0 }}>
            로컬 PC에서 측정한 뒤 배포에 반영된 기록입니다(최신 순, 최대 50건). 진행 중 상태는 없으며 완료 시점에 기록됩니다.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>상태</th>
                  <th>대상</th>
                  <th>주차</th>
                  <th>AEO</th>
                  <th>측정시간</th>
                  <th>경과</th>
                </tr>
              </thead>
              <tbody>
                {localLog.map((e, i) => (
                  <tr key={`${e.tenantId}-${e.at}-${i}`}>
                    <td>
                      <span className="status-pill st-good">로컬 완료</span>
                    </td>
                    <td>{e.brandName || e.tenantId}</td>
                    <td>{e.weekOf}</td>
                    <td className="num">{e.aeoScore}</td>
                    <td className="num">{fmtSec(e.durationSec)}</td>
                    <td>{timeAgo(e.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  )
}
