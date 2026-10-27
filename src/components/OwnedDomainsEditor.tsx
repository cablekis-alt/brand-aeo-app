import { useEffect, useState } from 'react'
import {
  loadOwnedDomains,
  planOwnedDomains,
  saveOwnedDomains,
  type OwnedDomainsInput,
  type OwnedDomainsPlan,
  type OwnedDomainsSaveResult,
  type OwnedDomainsState,
} from '../lib/api'
import { hostKey } from '../lib/brandVariant'

/**
 * 기본 정보 서랍의 「자사 사이트 주소」 칸(server/ownedDomainsEditor.ts). 등록한 홈페이지 말고 브랜드가 가진 다른 사이트를 더한다 —
 * AI 답변이 그 주소를 근거로 쓰면 자사 인용으로 센다. 기본 정보와 따로 저장한다(저장소 설정 브랜드도 여기는 고칠 수 있다).
 *
 * 더할 때 「지난 측정에도 적용」을 고르면 서버가 주별 자사 인용률 · 점수 변화를 미리 계산하고, 저장은 그 미리보기 열쇠로만 한다.
 * 빼기는 다음 측정부터다.
 */

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; value: OwnedDomainsState }
type PlanState = { key: string; replan: number; value: OwnedDomainsPlan | null; error: string | null }

const pct = (v: number) => `${(v * 100).toFixed(1)}%`

export default function OwnedDomainsEditor({
  tenantId,
  onSaved,
  onDirtyChange,
}: {
  tenantId: string
  onSaved: () => void
  onDirtyChange?: (dirty: boolean) => void
}) {
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [extra, setExtra] = useState<string[] | null>(null)
  const [draft, setDraft] = useState('')
  const [applyPast, setApplyPast] = useState(true)
  const [plan, setPlan] = useState<PlanState | null>(null)
  const [replan, setReplan] = useState(0)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<OwnedDomainsSaveResult | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    loadOwnedDomains(tenantId).then(
      (value) => {
        if (!alive) return
        setLoad({ status: 'ok', value })
        setExtra(value.extra)
      },
      (err: unknown) => {
        console.error('[OwnedDomainsEditor] 자사 사이트 주소를 불러오지 못했습니다', err)
        if (alive) setLoad({ status: 'error', message: err instanceof Error ? err.message : String(err) })
      },
    )
    return () => {
      alive = false
    }
  }, [tenantId])

  const s = load.status === 'ok' ? load.value : null
  const list = extra ?? []
  const dirty = Boolean(s && list.join('\n') !== s.extra.join('\n'))
  const added = s ? list.filter((d) => !s.extra.includes(d)) : []
  const input: OwnedDomainsInput = { extra: list, applyPast: applyPast && added.length > 0 }
  const requestKey = dirty ? JSON.stringify(input) : ''

  // 바뀔 때마다(잠깐 멈춘 뒤) 서버에 미리 계산을 묻는다. 응답은 지금 입력과 같을 때만 쓴다.
  useEffect(() => {
    if (!requestKey) return
    let alive = true
    const timer = setTimeout(() => {
      planOwnedDomains(tenantId, JSON.parse(requestKey) as OwnedDomainsInput).then(
        (value) => alive && setPlan({ key: requestKey, replan, value, error: null }),
        (err: unknown) => {
          console.error('[OwnedDomainsEditor] 바꿀 내용을 계산하지 못했습니다', err)
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

  const current = plan && plan.key === requestKey ? plan : null
  const freshPlan = current?.replan === replan
  const planned = dirty ? (current?.value ?? null) : null
  const measuringNow = planned ? planned.measuring : Boolean(s?.measuring)
  const canSave = Boolean(s?.editable && dirty && planned && !planned.unchanged && planned.errors.length === 0 && !measuringNow && freshPlan && !busy)

  // 측정 중에 계산한 미리보기는 측정이 끝나도 그대로라 저장이 막힌 채 남는다 — 측정 중이면 잠시 뒤 다시 계산한다.
  useEffect(() => {
    if (!planned?.measuring) return
    const timer = setTimeout(() => setReplan((n) => n + 1), 5000)
    return () => clearTimeout(timer)
  }, [planned])

  const touch = () => {
    setSaved(null)
    setActionError(null)
    setConfirming(false)
  }
  const addDraft = () => {
    const host = hostKey(draft)
    if (!host) return
    if (!list.includes(host)) setExtra([...list, host])
    setDraft('')
    touch()
  }
  const remove = (d: string) => {
    setExtra(list.filter((x) => x !== d))
    touch()
  }
  const cancel = () => {
    if (s) setExtra(s.extra)
    setDraft('')
    touch()
  }
  // 저장하는 순간의 미리보기 열쇠로 보낸다 — 그사이 측정이 끼어들었으면 서버가 409로 거절하고 다시 계산한다.
  const doSave = () => {
    if (!planned) return
    setBusy(true)
    setActionError(null)
    saveOwnedDomains(tenantId, input, planned.key).then(
      (result) => {
        setConfirming(false)
        setPlan(null)
        setSaved(result)
        onSaved()
        loadOwnedDomains(tenantId).then(
          (value) => {
            setLoad({ status: 'ok', value })
            setExtra(value.extra)
            setBusy(false)
          },
          (err: unknown) => {
            console.error('[OwnedDomainsEditor] 저장한 뒤 다시 불러오지 못했습니다', err)
            setBusy(false)
            setActionError('저장했지만 주소 목록을 다시 불러오지 못했어요. 서랍을 닫았다가 다시 열어 주세요.')
          },
        )
      },
      (err: unknown) => {
        console.error('[OwnedDomainsEditor] 저장하지 못했습니다', err)
        setBusy(false)
        setConfirming(false)
        setActionError(err instanceof Error ? err.message : String(err))
        setPlan(null)
        setReplan((n) => n + 1)
      },
    )
  }

  return (
    <section className="od" aria-labelledby="od-title">
      <h3 id="od-title" className="od-title">
        자사 사이트 주소
      </h3>
      <p className="od-lead">AI 답변이 이 주소를 근거로 쓰면 자사 인용으로 셉니다. 옛 사이트나 따로 만든 소개 사이트처럼 이 브랜드가 가진 곳을 더하세요.</p>
      {load.status === 'loading' && <p className="muted">불러오는 중…</p>}
      {load.status === 'error' && (
        <p className="error" role="alert">
          {load.message}
        </p>
      )}
      {s && !s.editable && <p className="ce-alert warn">{s.reason}</p>}
      {s && (
        <fieldset className="ce-fieldset od-form" disabled={busy || !s.editable}>
          <legend className="sr-only">자사 사이트 주소 목록</legend>
          <ul className="od-list">
            {s.fixed.map((d, i) => (
              <li key={d}>
                <span className="od-host mono">{d}</span>
                <span className="od-tag">{i === 0 ? '등록한 홈페이지 · 바꿀 수 없음' : '저장소 설정 · 바꿀 수 없음'}</span>
              </li>
            ))}
            {list.map((d) => (
              <li key={d} className={s.extra.includes(d) ? undefined : 'od-new'}>
                <span className="od-host mono">{d}</span>
                {!s.extra.includes(d) && <span className="od-tag">더함</span>}
                <button type="button" className="btn od-remove" onClick={() => remove(d)} aria-label={`${d} 빼기`}>
                  빼기
                </button>
              </li>
            ))}
            {s.extra
              .filter((d) => !list.includes(d))
              .map((d) => (
                <li key={d} className="od-gone">
                  <span className="od-host mono">{d}</span>
                  <span className="od-tag">뺌 · 다음 측정부터</span>
                </li>
              ))}
          </ul>
          <form
            className="od-add"
            onSubmit={(e) => {
              e.preventDefault()
              addDraft()
            }}
          >
            <label className="pe-field od-add-field">
              <span className="sr-only">더할 주소</span>
              <input type="text" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="예: all-about-gunsan.vercel.app" />
            </label>
            <button type="submit" className="btn" disabled={!hostKey(draft)}>
              더하기
            </button>
          </form>
          {added.length > 0 && (
            <label className="ce-pastbox-opt od-past">
              <input
                type="checkbox"
                checked={applyPast}
                onChange={(e) => {
                  setApplyPast(e.target.checked)
                  touch()
                }}
              />
              지난 측정에도 적용 — 이미 잰 주의 자사 인용 · 점수를 다시 셉니다
            </label>
          )}
        </fieldset>
      )}

      {s && dirty && (
        <div className="od-plan">
          {!current && <p className="ce-bar-note">바뀔 내용을 계산하는 중…</p>}
          {current?.error && <p className="ce-bar-note bad">{current.error}</p>}
          {planned?.errors.map((e) => (
            <p key={e} className="ce-bar-note bad">
              {e}
            </p>
          ))}
          {planned?.notes.map((n) => (
            <p key={n} className="ce-bar-note warn">
              {n}
            </p>
          ))}
          {planned?.past && (
            <div className="ce-preview">
              <p className="ce-preview-head">
                지난 측정 <span>· 자사로 바꿀 인용 {planned.past.promoted.toLocaleString()}건 · 회차 {planned.past.runs}개도 함께</span>
              </p>
              {planned.past.promoted > 0 ? (
                <ul className="od-weeks">
                  {planned.past.weeks.map((w) => (
                    <li key={w.weekOf}>
                      <span className="ce-preview-week">{w.weekOf.slice(-3)}</span>
                      {w.promoted > 0 ? (
                        <>
                          인용 {w.promoted}건 · 자사 인용률 {pct(w.rateBefore)} → <b>{pct(w.rateAfter)}</b> · 점수 {w.scoreBefore} → <b>{w.scoreAfter}</b>
                        </>
                      ) : (
                        <>
                          앞 주 점수가 바뀌어 4주 평균 {w.ma4Before} → <b>{w.ma4After}</b>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="ce-preview-none">지난 측정에 이 주소 인용이 없어 바뀌는 기록이 없어요.</p>
              )}
              {planned.past.skipped.map((k) => (
                <p key={k} className="ce-bar-note warn">
                  {k}
                </p>
              ))}
              {planned.past.cohortWeeks > 0 && (
                <p className="ce-preview-meta">
                  점수가 바뀐 {planned.past.cohortWeeks}주는 코호트 순위를 다시 세요 · 이미 보낸 주간 보고서와 숫자가 달라질 수 있어요.
                </p>
              )}
            </div>
          )}
          {actionError && (
            <p className="ce-bar-note bad" role="alert">
              {actionError}
            </p>
          )}
          {confirming && planned ? (
            <div className="od-confirm" role="group" aria-label="저장 확인">
              <p>
                {planned.past && planned.past.weeks.length > 0
                  ? `지난 ${planned.past.weeks.length}주의 판정 · 점수를 다시 쓰고 저장할까요? 바꾸기 전 기록은 백업해 둬요.`
                  : '주소 목록을 저장할까요? 다음 측정부터 적용돼요.'}
              </p>
              <div className="ce-bar-actions">
                <button type="button" className="btn" onClick={() => setConfirming(false)} disabled={busy}>
                  취소
                </button>
                <button type="button" className="btn primary" onClick={doSave} disabled={busy || !canSave}>
                  {busy ? '저장 중…' : '저장'}
                </button>
              </div>
            </div>
          ) : (
            <div className="ce-bar-actions">
              <span className="ce-bar-hint">{measuringNow ? '측정이 끝난 뒤에 저장할 수 있어요' : !freshPlan ? '다시 계산하는 중…' : ''}</span>
              <button type="button" className="btn" onClick={cancel} disabled={busy}>
                취소
              </button>
              <button type="button" className="btn primary" onClick={() => setConfirming(true)} disabled={!canSave}>
                주소 저장
              </button>
            </div>
          )}
        </div>
      )}

      {s && saved && !dirty && (
        <div className="ce-saved" role="status">
          <b>✓ 자사 사이트 주소를 저장했어요</b>
          {saved.applied ? (
            <p>
              지난 측정 {saved.applied.weeks}주 · 회차 {saved.applied.runs}개에서 인용 {saved.applied.promoted.toLocaleString()}건을 자사로 바꿨어요
              {saved.applied.ranksUpdated > 0 ? ` · 순위 카드 ${saved.applied.ranksUpdated}장을 다시 셌어요` : ''}.
            </p>
          ) : (
            <p>다음 측정부터 적용돼요.</p>
          )}
          {actionError && (
            <p className="ce-bar-note bad" role="alert">
              {actionError}
            </p>
          )}
          <p className="ce-saved-note">바꾸기 전 기록은 data/{tenantId}/{saved.backupDir}에 남겨 두었어요.</p>
        </div>
      )}
    </section>
  )
}
