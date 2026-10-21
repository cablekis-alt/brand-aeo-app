import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTenant } from '../context/useTenant'
import {
  loadProfileEditor,
  planProfileEdit,
  saveProfileEdit,
  type ProfileEditorState,
  type ProfileInput,
  type ProfilePlan,
  type ProfileSaveResult,
} from '../lib/api'
import { scopeLabel } from '../lib/brandVariant'
import { MARKET_SCOPES, NATIONAL_REGION, type MarketScope } from '../prompts/types'

/**
 * 기본 정보 서랍 — 업종 · 지역 · 시장 범위 고치기(server/brandProfileEditor.ts). 브랜드 현황 코호트 카드의 「기본 정보」로 연다.
 *
 * 경쟁사 편집 서랍(CompetitorEditor.tsx)과 같은 틀이다: 바꾸면 서버가 미리 계산하고(새 질문지 번호 · 함께 옮길 경쟁사 · 막는 문제),
 * 저장은 확인 창을 거쳐 그 미리보기 열쇠로만 한다. 코호트와 질문지가 바뀌어 지난 주와 비교가 끊기므로 늘 확인을 받는다.
 * 지난 기록은 옮기지 않는다 — 다음 측정부터 새 코호트로 잰다.
 */

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; value: ProfileEditorState }
type PlanState = { key: string; replan: number; value: ProfilePlan | null; error: string | null }
type Form = { industry: string; region: string; marketScope: MarketScope; buyer: string }

const SCOPE_DESC: Record<MarketScope, string> = {
  local: '그 지역에서 찾는 손님 — 질문에 지역이 들어가요',
  national: '전국에서 찾는 손님 — 지역은 「국내」',
  b2b: '사업자 · 구매 담당자가 찾는 곳 — 지역은 「국내」',
}

// 지역형이 아니면 지역 칸은 「국내」로 잠기므로, 지역 입력은 지역형일 때의 값만 들고 있는다.
const formOf = (s: ProfileEditorState): Form => ({
  industry: s.industry,
  region: s.marketScope === 'local' ? s.region : '',
  marketScope: s.marketScope,
  buyer: s.buyer,
})

export default function ProfileEditor({
  tenantId,
  onClose,
  onSaved,
  onDirtyChange,
}: {
  tenantId: string
  onClose: () => void
  /** 저장한 뒤 — 브랜드 현황 · 브랜드 목록을 다시 읽는다. */
  onSaved: () => void
  onDirtyChange?: (dirty: boolean) => void
}) {
  const navigate = useNavigate()
  const { setTenantId } = useTenant()
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [form, setForm] = useState<Form | null>(null)
  // 함께 옮길 경쟁사 — null이면 서버가 정한 기본(지금 같은 코호트에 있는 곳).
  const [move, setMove] = useState<string[] | null>(null)
  const [plan, setPlan] = useState<PlanState | null>(null)
  const [replan, setReplan] = useState(0)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmKey, setConfirmKey] = useState<string | null>(null)
  const [saved, setSaved] = useState<ProfileSaveResult | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const saveRef = useRef<HTMLButtonElement>(null)
  const confirmWasOpen = useRef(false)

  useEffect(() => {
    let alive = true
    loadProfileEditor(tenantId).then(
      (value) => {
        if (!alive) return
        setLoad({ status: 'ok', value })
        setForm(formOf(value))
      },
      (err: unknown) => {
        console.error('[ProfileEditor] 기본 정보를 불러오지 못했습니다', err)
        if (alive) setLoad({ status: 'error', message: err instanceof Error ? err.message : String(err) })
      },
    )
    return () => {
      alive = false
    }
  }, [tenantId])

  // 열면 서랍 제목으로 초점을 옮기고, 닫으면 연 자리로 돌려준다.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    headingRef.current?.focus()
    return () => opener?.focus()
  }, [])

  const s = load.status === 'ok' ? load.value : null
  const f = form
  const moveIds = move ?? (s?.competitors.filter((c) => c.defaultMove).map((c) => c.tenantId) ?? [])
  const input: ProfileInput | null =
    s && f
      ? {
          industry: f.industry.trim(),
          region: f.marketScope === 'local' ? f.region.trim() : NATIONAL_REGION,
          marketScope: f.marketScope,
          buyer: f.marketScope === 'b2b' ? f.buyer.trim() : '',
          move: s.competitors.filter((c) => c.movable && moveIds.includes(c.tenantId)).map((c) => c.tenantId).sort(),
        }
      : null
  const dirty = Boolean(
    s &&
      input &&
      (input.industry !== s.industry ||
        input.region !== s.region ||
        input.marketScope !== s.marketScope ||
        input.buyer !== (s.marketScope === 'b2b' ? s.buyer : '')),
  )
  const requestKey = dirty && input ? JSON.stringify(input) : ''

  // 바뀔 때마다(잠깐 멈춘 뒤) 서버에 미리 계산을 묻는다. 응답은 지금 입력과 같을 때만 쓴다.
  useEffect(() => {
    if (!requestKey) return
    let alive = true
    const timer = setTimeout(() => {
      planProfileEdit(tenantId, JSON.parse(requestKey) as ProfileInput).then(
        (value) => alive && setPlan({ key: requestKey, replan, value, error: null }),
        (err: unknown) => {
          console.error('[ProfileEditor] 바꿀 내용을 계산하지 못했습니다', err)
          if (alive) setPlan({ key: requestKey, replan, value: null, error: err instanceof Error ? err.message : String(err) })
        },
      )
    }, 250)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [tenantId, requestKey, replan])

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])

  const close = () => {
    if (busy) return // 저장 중에는 닫지 않는다 — 닫아도 저장은 끝까지 진행된다.
    if (dirty && !window.confirm('바꾼 내용을 저장하지 않고 닫을까요?')) return
    onClose()
  }

  const current = plan && plan.key === requestKey ? plan : null
  const freshPlan = current?.replan === replan
  const planned = dirty ? (current?.value ?? null) : null
  const planning = dirty && !current
  const measuringNow = planned ? planned.measuring : Boolean(s?.measuring)
  const canSave = Boolean(s?.editable && dirty && planned && !planned.unchanged && planned.errors.length === 0 && !measuringNow && freshPlan && !busy)
  const confirmOpen = confirmKey !== null && confirmKey === planned?.key

  const update = (patch: Partial<Form>) => {
    if (!f) return
    setForm({ ...f, ...patch })
    setSaved(null)
    setActionError(null)
  }
  const toggleMove = (id: string, on: boolean) => {
    setMove(on ? [...new Set([...moveIds, id])] : moveIds.filter((x) => x !== id))
    setSaved(null)
    setActionError(null)
  }
  const clearEdits = () => {
    if (s) setForm(formOf(s))
    setMove(null)
    setConfirmKey(null)
    setActionError(null)
  }
  // 저장하는 순간의 미리보기 열쇠로 보낸다 — 그사이 설정이 바뀌었으면 서버가 409로 거절하고, 같은 입력으로 다시 계산한다.
  const doSave = () => {
    if (!input || !planned) return
    setBusy(true)
    setActionError(null)
    saveProfileEdit(tenantId, input, planned.key).then(
      (result) => {
        setConfirmKey(null)
        setPlan(null)
        setSaved(result)
        onSaved()
        loadProfileEditor(tenantId).then(
          (value) => {
            setLoad({ status: 'ok', value })
            setForm(formOf(value))
            setMove(null)
            setBusy(false)
          },
          (err: unknown) => {
            console.error('[ProfileEditor] 저장한 뒤 다시 불러오지 못했습니다', err)
            setBusy(false)
            setActionError('저장했지만 서랍을 다시 불러오지 못했어요. 닫았다가 다시 열어 주세요.')
          },
        )
      },
      (err: unknown) => {
        console.error('[ProfileEditor] 저장하지 못했습니다', err)
        setBusy(false)
        setConfirmKey(null)
        setActionError(err instanceof Error ? err.message : String(err))
        setPlan(null)
        setReplan((n) => n + 1)
      },
    )
  }
  const save = () => planned && setConfirmKey(planned.key)
  const goMeasure = () => {
    setTenantId(tenantId)
    onClose()
    navigate('/measure-tenant')
  }

  // 확인 창을 열면 저장 단추로, 닫으면 서랍의 저장 버튼으로 초점을 옮긴다.
  useEffect(() => {
    if (confirmOpen) confirmRef.current?.focus()
    else if (confirmWasOpen.current) saveRef.current?.focus()
    confirmWasOpen.current = confirmOpen
  }, [confirmOpen])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 명령 창 · 브랜드 고르기가 처리한 Escape(preventDefault)는 서랍까지 닫지 않는다.
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (confirmOpen) {
        if (!busy) setConfirmKey(null)
      } else close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <aside className="ce-drawer" aria-labelledby="pe-title">
      <div className="ce-head" inert={confirmOpen || undefined}>
        <div className="ce-title-row">
          <h2 id="pe-title" ref={headingRef} tabIndex={-1}>
            기본 정보
          </h2>
          <button type="button" className="ce-close" onClick={close} aria-label="기본 정보 닫기">
            ✕
          </button>
        </div>
        {s && (
          <p className="ce-sub">
            {s.brandName} · {s.industry} · {s.region} · {scopeLabel(s.marketScope)} · <b>바꾼 내용은 다음 측정부터 적용돼요</b>
          </p>
        )}
        {s && !s.editable && <p className="ce-alert warn">{s.reason}</p>}
        {s?.measuring && <p className="ce-alert">측정이 진행 중이에요. 끝난 뒤에 저장할 수 있어요.</p>}
      </div>

      <div className="ce-body" inert={confirmOpen || undefined}>
        {load.status === 'loading' && <p className="muted">불러오는 중…</p>}
        {load.status === 'error' && (
          <p className="error" role="alert">
            {load.message}
          </p>
        )}
        {s && f && (
          <fieldset className="ce-fieldset pe-form" disabled={busy || !s.editable}>
            <fieldset className="ce-qmode">
              <legend className="pe-label">시장 범위</legend>
              {MARKET_SCOPES.map((id) => (
                <label key={id} className="ce-qmode-opt">
                  <input type="radio" name="pe-scope" checked={f.marketScope === id} onChange={() => update({ marketScope: id })} />
                  <span>
                    {scopeLabel(id)}
                    <span className="ce-qmode-sub">{SCOPE_DESC[id]}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            {f.marketScope === 'b2b' && (
              <label className="pe-field">
                <span className="pe-label">누가 사나요? (질문하는 사람이 됩니다)</span>
                <input type="text" value={f.buyer} onChange={(e) => update({ buyer: e.target.value })} placeholder="예: 통신사 IPTV 셋톱박스 구매 · 조달 담당자" />
              </label>
            )}
            <label className="pe-field">
              <span className="pe-label">업종</span>
              <input type="text" list="pe-industries" value={f.industry} onChange={(e) => update({ industry: e.target.value })} />
            </label>
            <datalist id="pe-industries">
              {s.industries.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
            <label className="pe-field">
              <span className="pe-label">지역</span>
              {f.marketScope === 'local' ? (
                <input type="text" list="pe-regions" value={f.region} onChange={(e) => update({ region: e.target.value })} placeholder="예: 전북 군산" />
              ) : (
                <input type="text" value={NATIONAL_REGION} readOnly aria-readonly="true" className="pe-locked" />
              )}
            </label>
            <datalist id="pe-regions">
              {s.regions.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
            {s.competitors.length > 0 && (
              <div className="pe-comp">
                <p className="pe-label">함께 재는 경쟁사</p>
                <p className="ce-qmode-sub">이 브랜드만 재는 경쟁사는 함께 옮겨야 새 코호트에서 같이 잽니다.</p>
                {s.competitors.map((c) =>
                  c.movable ? (
                    <label key={c.tenantId} className="ce-pastbox-opt">
                      <input type="checkbox" checked={moveIds.includes(c.tenantId)} onChange={(e) => toggleMove(c.tenantId, e.target.checked)} />
                      {c.brandName} 함께 옮기기
                      <span className="muted">
                        {' '}
                        ({c.industry} · {c.region})
                      </span>
                    </label>
                  ) : (
                    <p key={c.tenantId} className="pe-comp-fixed">
                      {c.brandName} — {c.reason}
                    </p>
                  ),
                )}
              </div>
            )}
          </fieldset>
        )}
      </div>

      {s && dirty && (
        <div className="ce-bar" inert={confirmOpen || undefined}>
          <p className="ce-bar-summary">{planned?.summary ?? '바꿀 내용을 계산하는 중…'}</p>
          {planning && <p className="ce-bar-note">질문지 · 함께 옮길 곳을 계산하는 중…</p>}
          {current?.error && <p className="ce-bar-note bad">{current.error}</p>}
          {planned?.notes.map((n) => (
            <p key={n} className="ce-bar-note warn">
              {n}
            </p>
          ))}
          {planned?.errors.map((e) => (
            <p key={e} className="ce-bar-note bad">
              {e}
            </p>
          ))}
          {actionError && (
            <p className="ce-bar-note bad" role="alert">
              {actionError}
            </p>
          )}
          <div className="ce-bar-actions">
            <span className="ce-bar-hint">
              {measuringNow ? '측정이 끝난 뒤에 저장할 수 있어요' : !freshPlan ? '다시 계산하는 중…' : '다음 측정부터 새 코호트로 재요'}
            </span>
            <button type="button" className="btn" onClick={clearEdits} disabled={busy}>
              취소
            </button>
            <button type="button" className="btn primary" ref={saveRef} onClick={save} disabled={!canSave}>
              {busy ? '저장 중…' : '저장'}
            </button>
          </div>
        </div>
      )}

      {s && saved && !dirty && (
        <div className="ce-saved" role="status">
          <b>✓ 저장했어요 · 다음 측정부터 적용돼요</b>
          <p>{saved.summary}</p>
          {saved.moved.length > 0 && <p>함께 옮긴 경쟁사: {saved.moved.join(', ')}</p>}
          {actionError && (
            <p className="ce-bar-note bad" role="alert">
              {actionError}
            </p>
          )}
          <div className="ce-bar-actions">
            <button type="button" className="btn primary" onClick={goMeasure}>
              측정하러 가기
            </button>
          </div>
          <p className="ce-saved-note">
            옛 설정은 data/{tenantId}/{saved.backupDir}에 남겨 두었어요. 되돌리려면 여기서 다시 바꿔 저장해요. 「측정하러 가기」는 화면만 옮기고
            측정은 시작하지 않아요.
          </p>
        </div>
      )}

      {s && confirmOpen && planned && (
        <div className="ce-dialog-backdrop" onMouseDown={() => !busy && setConfirmKey(null)}>
          <div className="ce-dialog" role="dialog" aria-modal="true" aria-labelledby="pe-dialog-title" onMouseDown={(e) => e.stopPropagation()}>
            <h3 id="pe-dialog-title">기본 정보를 바꿀까요?</h3>
            <p>{planned.summary}</p>
            <p className="ce-dialog-note">
              지난 기록은 옛 코호트에 그대로 남고, 다음 측정부터 새 코호트 · 새 질문지({planned.bank.to})로 재요. 바뀐 주는 지난 주와 점수 증감을
              비교하지 않아요.
              {planned.moving.length > 0 ? ` 함께 옮길 경쟁사: ${planned.moving.map((m) => m.brandName).join(', ')}.` : ''}
            </p>
            <div className="ce-bar-actions">
              <button type="button" className="btn" onClick={() => setConfirmKey(null)} disabled={busy}>
                취소
              </button>
              <button type="button" className="btn primary" ref={confirmRef} onClick={doSave} disabled={busy || !canSave}>
                {busy ? '저장 중…' : '바꾸고 저장'}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}
