import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTenant } from '../context/useTenant'
import {
  dismissOutcome,
  outcomeMessage,
  setOutcomeContext,
  useMeasureStatus,
  type MeasureRunRecord,
  type OutcomeAction,
  type OutcomeView,
} from '../lib/measureStatus'

const MAX_SHOWN = 3
/** 성공 줄을 작은 알림으로 접기까지. */
const COLLAPSE_MS = 10_000
/** 접을 때 마우스가 올라가 있거나 줄 안에 초점이 있으면 이만큼 뒤에 다시 본다(누르려던 단추가 사라지지 않게). */
const COLLAPSE_RECHECK_MS = 3_000

/** 저절로 접는 줄 — 깨끗한 성공만. 실패 · 경쟁사 일부 실패(「측정 상태」 단추가 있는 줄)는 펼친 채 둔다. 멈춘 측정은 따로 닫힌다. */
function collapsible(view: OutcomeView, r: MeasureRunRecord): boolean {
  return r.result !== 'cancelled' && view.tone === 'good' && !view.statusLink
}

/**
 * 화면 아래 측정 결과 띠 — 측정이 끝나거나 실패하면 어느 화면에서든 알린다(상용화 UI 3차 U13).
 *
 * 예전에는 측정을 시작한 화면의 문구만 결과를 알려, 다른 화면으로 가면 끝났는지 실패했는지 몰랐다. 성공은 저절로 닫지 않는다 —
 * 운영자가 자리를 비웠다 돌아와도 보이게. 멈춘 측정만 10초 뒤 닫는다(사용자가 멈췄다). 최신이 위, 셋까지 보이고 나머지는
 * 측정 상태로 보낸다. onRefresh는 같은 화면에 있어도 새 숫자로 다시 그리게 한다(Layout의 화면 키).
 *
 * 성공 줄은 10초 뒤 오른쪽 아래 작은 알림으로 접는다(2026-11-14 사용자 「1번으로」) — 펼친 띠가 본문 아래쪽(발행 현황의 거르기 줄 등)을
 * 덮어, 측정 직후 그 자리의 선택 상자가 눌리지 않았다. 접어도 닫지는 않는다(돌아와서 결과를 볼 수 있게). 작은 알림을 누르면 다시
 * 펼치고, 손으로 펼친 줄은 다시 접지 않는다.
 */
export default function MeasureResultBand({ onRefresh }: { onRefresh: () => void }) {
  const { tenants, setTenantId } = useTenant()
  const navigate = useNavigate()
  const { band } = useMeasureStatus()

  const act = useCallback(
    (r: MeasureRunRecord, action: OutcomeAction) => {
      const view = outcomeMessage(r, tenants)
      dismissOutcome(r.id)
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

  // 멈춘 측정 줄은 잠깐 보이고 닫는다 — 줄마다 처음 뜬 때부터 센다(다른 줄이 오가도 다시 세지 않는다).
  const timers = useRef(new Map<string, number>())
  useEffect(() => {
    const live = new Set(band.map((r) => r.id))
    for (const [id, t] of timers.current) {
      if (!live.has(id)) {
        window.clearTimeout(t)
        timers.current.delete(id)
      }
    }
    for (const r of band) {
      const ms = r.result === 'cancelled' ? outcomeMessage(r, []).autoCloseMs : null
      if (ms !== null && !timers.current.has(r.id)) timers.current.set(r.id, window.setTimeout(() => dismissOutcome(r.id), ms))
    }
  }, [band])
  useEffect(() => {
    const held = timers.current
    return () => {
      for (const t of held.values()) window.clearTimeout(t)
      held.clear()
    }
  }, [])

  // 성공 줄 접기 — 줄마다 처음 뜬 때부터 센다(한 번 건 줄은 다시 걸지 않는다 — 손으로 펼친 줄이 다시 접히지 않게).
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const collapseTimers = useRef(new Map<string, number>())
  const itemEls = useRef(new Map<string, HTMLDivElement>())
  useEffect(() => {
    const live = new Set(band.map((r) => r.id))
    for (const [id, t] of collapseTimers.current) {
      if (!live.has(id)) {
        window.clearTimeout(t)
        collapseTimers.current.delete(id)
      }
    }
    for (const r of band) {
      if (collapseTimers.current.has(r.id) || !collapsible(outcomeMessage(r, tenants), r)) continue
      const tryCollapse = () => {
        const el = itemEls.current.get(r.id)
        if (el && (el.matches(':hover') || el.contains(document.activeElement))) {
          collapseTimers.current.set(r.id, window.setTimeout(tryCollapse, COLLAPSE_RECHECK_MS))
          return
        }
        setCollapsed((prev) => new Set(prev).add(r.id))
      }
      collapseTimers.current.set(r.id, window.setTimeout(tryCollapse, COLLAPSE_MS))
    }
  }, [band, tenants])
  useEffect(() => {
    const held = collapseTimers.current
    return () => {
      for (const t of held.values()) window.clearTimeout(t)
      held.clear()
    }
  }, [])
  const expand = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  const keepEl = (id: string) => (el: HTMLDivElement | null) => {
    if (el) itemEls.current.set(id, el)
    else itemEls.current.delete(id)
  }

  if (band.length === 0) return null
  return (
    <div className="mr-band no-print">
      {band.slice(0, MAX_SHOWN).map((r) => {
        const view = outcomeMessage(r, tenants)
        if (collapsed.has(r.id)) {
          // 접은 줄 — 결과 한 줄과 닫기만. 처음 뜰 때 이미 알렸으니 다시 읽어 주지 않는다(role 없음).
          return (
            <div key={r.id} ref={keepEl(r.id)} className={`mr-item mr-mini ${view.tone}`}>
              <button type="button" className="mr-mini-open" aria-expanded={false} title="눌러서 펼치기" onClick={() => expand(r.id)}>
                {view.title}
              </button>
              <button type="button" className="mr-mini-close" aria-label={`${view.title} — 알림 닫기`} onClick={() => dismissOutcome(r.id)}>
                ×
              </button>
            </div>
          )
        }
        return (
          <div key={r.id} ref={keepEl(r.id)} className={`mr-item ${view.tone}`} role={view.tone === 'bad' ? 'alert' : 'status'}>
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
              <button type="button" onClick={() => dismissOutcome(r.id)}>
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
