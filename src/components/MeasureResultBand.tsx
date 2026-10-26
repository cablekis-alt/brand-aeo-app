import { useCallback, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTenant } from '../context/useTenant'
import {
  dismissOutcome,
  outcomeMessage,
  setOutcomeContext,
  useMeasureStatus,
  type MeasureRunRecord,
  type OutcomeAction,
} from '../lib/measureStatus'

const MAX_SHOWN = 3

/**
 * 화면 아래 측정 결과 띠 — 측정이 끝나거나 실패하면 어느 화면에서든 알린다(상용화 UI 3차 U13).
 *
 * 예전에는 측정을 시작한 화면의 문구만 결과를 알려, 다른 화면으로 가면 끝났는지 실패했는지 몰랐다. 성공은 저절로 닫지 않는다 —
 * 운영자가 자리를 비웠다 돌아와도 보이게. 멈춘 측정만 10초 뒤 닫는다(사용자가 멈췄다). 최신이 위, 셋까지 보이고 나머지는
 * 측정 상태로 보낸다. onRefresh는 같은 화면에 있어도 새 숫자로 다시 그리게 한다(Layout의 화면 키).
 */
export default function MeasureResultBand({ onRefresh }: { onRefresh: () => void }) {
  const { tenants, setTenantId } = useTenant()
  const navigate = useNavigate()
  const { band } = useMeasureStatus()

  const act = useCallback(
    (r: MeasureRunRecord, action: OutcomeAction) => {
      const view = outcomeMessage(r, tenants)
      dismissOutcome(r.seq)
      if (action === 'overview') {
        if (view.customerId) setTenantId(view.customerId)
        navigate('/')
        onRefresh()
      } else if (action === 'brands') {
        navigate('/brands')
        onRefresh()
      } else if (action === 'remeasure') {
        // 바로 다시 재지 않는다 — 측정 화면에서 함께 잴 경쟁사 · 방식을 확인하고 시작한다.
        if (view.customerId) setTenantId(view.customerId)
        navigate('/measure-tenant', { state: { pick: r.tenantId } })
      } else navigate('/measure-status')
    },
    [tenants, setTenantId, navigate, onRefresh],
  )

  useEffect(() => {
    setOutcomeContext({ tenants, onNotificationClick: act })
    return () => setOutcomeContext(null)
  }, [tenants, act])

  // 멈춘 측정 줄은 잠깐 보이고 닫는다.
  useEffect(() => {
    const timers = band.flatMap((r) => {
      const ms = outcomeMessage(r, tenants).autoCloseMs
      return ms === null ? [] : [window.setTimeout(() => dismissOutcome(r.seq), ms)]
    })
    return () => timers.forEach((t) => window.clearTimeout(t))
  }, [band, tenants])

  if (band.length === 0) return null
  return (
    <div className="mr-band no-print">
      {band.slice(0, MAX_SHOWN).map((r) => {
        const view = outcomeMessage(r, tenants)
        return (
          <div key={r.seq} className={`mr-item ${view.tone}`} role={view.tone === 'bad' ? 'alert' : 'status'}>
            <p className="mr-title">{view.title}</p>
            {view.sub && <p className="mr-sub">{view.sub}</p>}
            <div className="mr-actions">
              {view.primary === 'overview' && (
                <button type="button" className="mr-primary" onClick={() => act(r, 'overview')}>
                  개요 보기
                </button>
              )}
              {view.primary === 'brands' && (
                <button type="button" className="mr-primary" onClick={() => act(r, 'brands')}>
                  브랜드 현황
                </button>
              )}
              {view.primary === 'remeasure' && (
                <button type="button" className="mr-primary" onClick={() => act(r, 'remeasure')}>
                  다시 측정
                </button>
              )}
              {view.statusLink && (
                <button type="button" onClick={() => act(r, 'status')}>
                  측정 상태
                </button>
              )}
              <button type="button" onClick={() => dismissOutcome(r.seq)}>
                닫기
              </button>
            </div>
          </div>
        )
      })}
      {band.length > MAX_SHOWN && (
        <p className="mr-more">
          <Link to="/measure-status">측정 결과 {band.length - MAX_SHOWN}건 더 — 측정 상태</Link>
        </p>
      )}
    </div>
  )
}
