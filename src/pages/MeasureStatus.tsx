import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { loadMeasureRuns, type MeasureRunInfo } from '../lib/api'

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

// run-name "measure <tenantId>"(소문자) → 대상 라벨. 구버전 실행명 "Measure tenant"(대문자)는 그대로 둔다.
function targetLabel(title: string): string {
  const m = title.match(/^measure\s+(.+)$/)
  if (!m) return title
  const id = m[1].trim()
  return id === '__queue__' ? '대기열 전체' : id
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

  return (
    <>
      <p className="brand">STAGE 2</p>
      <h1>측정 상태</h1>
      <p className="lead">
        S-11·S-12에서 시작한 GitHub Actions 측정 실행의 진행 상태입니다. 완료되면 결과가 이 사이트에 자동 반영됩니다.
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

      {!enabled ? (
        <section className="panel">
          <p className="muted">
            배포 환경에서 <code>GH_MEASURE_TOKEN</code>이 설정되어야 실행 상태를 볼 수 있습니다. 로컬에서는 이 탭에서
            바로 측정하므로 별도 상태 조회가 필요 없습니다.
          </p>
        </section>
      ) : !loading && runs.length === 0 ? (
        <section className="panel">
          <p className="muted">
            최근 측정 실행이 없습니다. <Link to="/measure-tenant">S-12 테넌트 골라 측정</Link> 또는{' '}
            <Link to="/measure-queue">S-11 측정 대기열</Link>에서 측정을 시작하세요.
          </p>
        </section>
      ) : (
        <section>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>상태</th>
                  <th>대상</th>
                  <th>실행</th>
                  <th>시작</th>
                  <th>경과</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const badge = statusBadge(run)
                  return (
                    <tr key={run.runNumber}>
                      <td>
                        <span className={`status-pill ${badge.cls}`}>{badge.label}</span>
                      </td>
                      <td>{targetLabel(run.title)}</td>
                      <td className="num">#{run.runNumber}</td>
                      <td>{timeAgo(run.createdAt)}</td>
                      <td className="num">{duration(run)}</td>
                      <td>
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
        </section>
      )}
    </>
  )
}
