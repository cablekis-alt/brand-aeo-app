import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTenant } from '../context/useTenant'
import {
  loadCompetitorEditor,
  planCompetitorEdit,
  resetCompetitorEdit,
  saveCompetitorEdit,
  undoCompetitorEdit,
  type CompetitorEditPlan,
  type CompetitorEditorState,
  type CompetitorEntry,
  type EditorCompetitorRow,
} from '../lib/api'
import {
  applyOps,
  baseItems,
  dropHint,
  revertOp,
  summarizeOps,
  toCompetitors,
  type EditItem,
  type EditOp,
  type InputSource,
} from '../lib/competitorEdit'
import { topicParticle, withParticle } from '../lib/korean'
import CompetitorPicker, { type PickerGroup } from './CompetitorPicker'

const shortWeek = (weekOf: string) => weekOf.replace(/^\d{4}-/, '')
const shortDate = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : `${d.getMonth() + 1}월 ${d.getDate()}일 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const squash = (s: string) => s.replace(/\s+/g, '')

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; value: CompetitorEditorState }
type Open = { kind: 'row'; key: string } | { kind: 'wait'; key: string } | { kind: 'add' } | null
type PlanState = { key: string; value: CompetitorEditPlan | null; error: string | null }

const SOURCE_HEAD: Record<'past' | 'cohort' | 'answers', string> = {
  past: '예전 경쟁사',
  cohort: '같은 지역 등록 브랜드',
  answers: '지난 측정 답변에 나온 이름',
}

/**
 * 경쟁사 편집 서랍(상용화 UI 11차) — 브랜드 현황 코호트 카드에서 오른쪽에 연다. 화면을 어둡게 깔지 않는다:
 * 리더보드를 보면서 고치라는 서랍이다.
 *
 * 바꾼 내용은 작업 목록(src/lib/competitorEdit.ts)으로 들고, 바뀔 때마다 서버에 미리 계산을 묻는다 —
 * 「함께 측정 5/5 · 대기」는 측정과 같은 함수(server/cohortPlan.ts)로 세야 실제 측정과 어긋나지 않는다.
 * 저장은 data/<tenant>/competitors.json에 하고 다음 측정부터 적용된다. 질문지는 이 단계에서 바꾸지 않는다.
 */
export default function CompetitorEditor({
  tenantId,
  onClose,
  onSaved,
}: {
  tenantId: string
  onClose: () => void
  onSaved: () => void
}) {
  const navigate = useNavigate()
  const { setTenantId } = useTenant()
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [ops, setOps] = useState<EditOp[]>([])
  const [plan, setPlan] = useState<PlanState | null>(null)
  const [open, setOpen] = useState<Open>(null)
  const [pastOpen, setPastOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [savedNow, setSavedNow] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    let alive = true
    loadCompetitorEditor(tenantId).then(
      (value) => alive && setLoad({ status: 'ok', value }),
      (err: unknown) => {
        console.error('[CompetitorEditor] 경쟁사 목록을 불러오지 못했습니다', err)
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
  const base = useMemo(() => baseItems(s?.competitors ?? []), [s])
  const applied = useMemo(() => applyOps(base, ops), [base, ops])
  const requestKey = ops.length ? JSON.stringify(toCompetitors(applied.list)) : ''

  // 바뀔 때마다(잠깐 멈춘 뒤) 서버에 미리 계산을 묻는다. 응답은 지금 목록과 같을 때만 쓴다.
  useEffect(() => {
    if (!requestKey) return
    let alive = true
    const timer = setTimeout(() => {
      planCompetitorEdit(tenantId, JSON.parse(requestKey) as CompetitorEntry[]).then(
        (value) => alive && setPlan({ key: requestKey, value, error: null }),
        (err: unknown) => {
          console.error('[CompetitorEditor] 바꾼 목록을 계산하지 못했습니다', err)
          if (alive) setPlan({ key: requestKey, value: null, error: err instanceof Error ? err.message : String(err) })
        },
      )
    }, 250)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [tenantId, requestKey])

  const close = () => {
    if (ops.length && !window.confirm('바꾼 내용을 저장하지 않고 닫을까요?')) return
    onClose()
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (open) setOpen(null)
      else close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const current = plan && plan.key === requestKey ? plan : null
  const planned = ops.length ? current?.value ?? null : null
  const planning = ops.length > 0 && !current
  // 서버 계산이 오기 전에는 원래 줄의 정보를 이름으로 붙여 보여 준다(칸 나눔은 순서대로 가정).
  const rowFor = (item: EditItem, i: number): EditorCompetitorRow | null => {
    if (!s) return null
    if (!ops.length) return s.rows[i] ?? null
    if (planned) return planned.rows[i] ?? null
    const known = s.rows.find((r) => squash(r.name) === squash(item.competitor.name))
    return known ? { ...known, index: i, status: i < s.cap ? 'measured' : 'waiting', takesSlot: i < s.cap } : null
  }
  const rows = applied.list.map((item, i) => ({ item, row: rowFor(item, i) }))
  const slotRows = rows.filter((x) => x.row?.takesSlot)
  const restRows = rows.filter((x) => x.row && !x.row.takesSlot && x.row.status !== 'unnamed')
  const measuredCount = (planned ?? s)?.measuredCount ?? 0
  const waitingCount = ops.length ? (planned?.waitingCount ?? restRows.length) : (s?.waitingCount ?? 0)
  const blockedCount = (planned ?? s)?.blockedCount ?? 0
  const cap = s?.cap ?? 5
  const top = Math.max(1, s?.baseline?.score ?? 0, ...rows.map((x) => x.row?.latest?.score ?? 0))
  const waitingNames = restRows.filter((x) => x.row?.status === 'waiting').map((x) => x.item.competitor.name)
  const neverMeasured = !ops.length ? s?.rows.find((r) => r.status === 'waiting' && !r.latest) : undefined
  const originalStatus = (key: string) => (key.startsWith('b') ? s?.rows[Number(key.slice(1))]?.status : undefined)

  const push = (op: EditOp) => {
    setOps([...ops, op])
    setOpen(null)
    setSavedNow(false)
    setActionError(null)
  }
  const revert = (index: number) => setOps(revertOp(base, ops, index))
  const listNames = new Set(applied.list.map((x) => squash(x.competitor.name)))
  const suggestionGroups = (make: (entry: CompetitorEntry, source: InputSource) => EditOp): PickerGroup[] =>
    (['past', 'cohort', 'answers'] as const).map((source) => ({
      head: SOURCE_HEAD[source],
      options: (s?.suggestions ?? [])
        .filter((x) => x.source === source && !listNames.has(squash(x.name)))
        .map((x) => ({
          id: `${source}:${x.name}`,
          label: x.name,
          sub: x.note,
          onPick: () => push(make({ name: x.name, aliases: x.aliases, domains: x.domains }, source)),
        })),
    }))

  const summary = summarizeOps(base, ops)
  const errors = planned?.errors ?? []
  const canSave = Boolean(s) && ops.length > 0 && Boolean(planned) && !planned?.unchanged && errors.length === 0 && !s?.measuring && !busy

  const run = (task: () => Promise<CompetitorEditorState>, after: (value: CompetitorEditorState) => void) => {
    setBusy(true)
    setActionError(null)
    task().then(
      (value) => {
        setLoad({ status: 'ok', value })
        setOps([])
        setOpen(null)
        setBusy(false)
        after(value)
        onSaved()
      },
      (err: unknown) => {
        console.error('[CompetitorEditor] 저장하지 못했습니다', err)
        setBusy(false)
        setActionError(err instanceof Error ? err.message : String(err))
      },
    )
  }
  const save = () => run(() => saveCompetitorEdit(tenantId, toCompetitors(applied.list), summary.join(' · ')), () => setSavedNow(true))
  const undo = () => run(() => undoCompetitorEdit(tenantId), () => setSavedNow(false))
  const reset = () =>
    run(
      () => resetCompetitorEdit(tenantId),
      () => {
        setConfirmReset(false)
        setSavedNow(false)
      },
    )
  const goMeasure = () => {
    setTenantId(tenantId)
    onClose()
    navigate('/measure-tenant')
  }

  const rowProps = { top, ours: s?.baseline?.score ?? null, baselineWeek: s?.baseline?.weekOf ?? null, pending: planning }

  return (
    <aside className="ce-drawer" aria-labelledby="ce-title">
      <div className="ce-head">
        <div className="ce-title-row">
          <h2 id="ce-title" ref={headingRef} tabIndex={-1}>
            경쟁사 편집
          </h2>
          {s && (
            <>
              <span
                className={`chip ${blockedCount > 0 ? 'warn' : measuredCount === cap ? 'good' : ''}`}
                title={
                  blockedCount > 0
                    ? `${blockedCount}곳은 칸을 쓰지만 측정되지 않아요`
                    : measuredCount < cap
                      ? `빈 칸 ${cap - measuredCount}개 — 경쟁사를 더 넣을 수 있어요`
                      : undefined
                }
              >
                함께 측정 {measuredCount}/{cap}
              </span>
              {waitingCount > 0 && <span className="chip">대기 {waitingCount}</span>}
            </>
          )}
          <button type="button" className="ce-close" onClick={close} aria-label="경쟁사 편집 닫기">
            ✕
          </button>
        </div>
        {s && (
          <p className="ce-sub">
            {s.brandName} · {s.industry} · {s.region} · <b>바꾼 내용은 다음 측정부터 적용돼요</b>
          </p>
        )}
        {neverMeasured && (
          <p className="ce-alert warn">
            {topicParticle(neverMeasured.name)} 한 번도 측정되지 않았어요. 경쟁사는 {cap}곳까지만 함께 측정해요.
          </p>
        )}
        {s?.edit.stale && (
          <p className="ce-alert warn">
            저장소 설정이 바뀌어 앱에서 고친 목록({s.edit.savedAt ? shortDate(s.edit.savedAt) : ''} 저장)을 쓰지 않고 있어요. 지금 목록에서
            다시 고쳐 저장하면 새로 적용돼요.
          </p>
        )}
        {s?.measuring && <p className="ce-alert">측정이 진행 중이에요. 끝난 뒤에 저장할 수 있어요.</p>}
      </div>

      <div className="ce-body">
        {load.status === 'loading' && <p className="muted">불러오는 중…</p>}
        {load.status === 'error' && (
          <p className="error" role="alert">
            {load.message}
          </p>
        )}
        {s && (
          <>
            <div className="ce-us">
              <b>{s.brandName}</b>
              <span className="ce-us-tag">우리</span>
              <span className="ce-us-meta">
                {s.baseline
                  ? `${s.baseline.score}점 · 코호트 ${s.baseline.tied ? '공동 ' : ''}${s.baseline.rank}위 / ${s.baseline.totalTenants} · ${shortWeek(s.baseline.weekOf)}`
                  : '측정 전'}
              </span>
            </div>

            <div className="ce-cols" aria-hidden="true">
              <span>순서</span>
              <span>경쟁사</span>
              <span>{s.baseline ? `${shortWeek(s.baseline.weekOf)} 점수` : '점수'}</span>
              <span>비교 질문</span>
              <span />
            </div>
            <ol className="ce-rows">
              {slotRows.map(({ item, row }, i) => {
                const placed = applied.placedBy.get(item.key)
                const chips = sourceChips(item, applied.replaced, applied.movedDown, originalStatus(item.key), row!)
                const isOpen = open?.kind === 'row' && open.key === item.key
                const sub = applied.replaced.has(item.key)
                  ? `${base.find((b) => b.key === applied.replaced.get(item.key))?.competitor.name ?? ''} 대신`
                  : undefined
                return (
                  <Row
                    key={item.key}
                    r={row!}
                    n={String(i + 1)}
                    extraChips={chips}
                    sub={sub}
                    {...rowProps}
                    action={
                      placed !== undefined
                        ? { label: '되돌리기', onClick: () => revert(placed) }
                        : { label: '바꾸기·빼기', onClick: () => setOpen(isOpen ? null : { kind: 'row', key: item.key }), expanded: isOpen }
                    }
                  >
                    {isOpen && (
                      <CompetitorPicker
                        title={`${item.competitor.name} 자리에 넣을 곳`}
                        groups={[
                          {
                            head: '대기 중',
                            options: restRows
                              .filter((x) => x.row?.status === 'waiting')
                              .map((x) => ({
                                id: x.item.key,
                                label: x.item.competitor.name,
                                sub: x.row?.latest ? `${shortWeek(x.row.latest.weekOf)} ${x.row.latest.score}점` : '측정 기록 없음',
                                onPick: () => push({ t: 'replace', key: item.key, from: x.item.key }),
                              })),
                          },
                          ...suggestionGroups((entry, source) => ({ t: 'replace', key: item.key, with: entry, source })),
                          {
                            head: '바꾸지 않고',
                            options: [
                              {
                                id: 'drop',
                                label: '빼기',
                                sub: `다음 측정부터 빠져요 · 지난 기록은 남아요 · ${dropHint(waitingNames, measuredCount - 1)}`,
                                danger: true,
                                onPick: () => push({ t: 'drop', key: item.key }),
                              },
                            ],
                          },
                        ]}
                        typed={{ submitLabel: '이곳으로 바꾸기', onSubmit: (entry) => push({ t: 'replace', key: item.key, with: entry, source: 'typed' }) }}
                      />
                    )}
                  </Row>
                )
              })}
              {applied.removed.map((item) => {
                const by = applied.removedBy.get(item.key)!
                const was = s.rows[Number(item.key.slice(1))]
                return (
                  <li key={item.key} className="ce-row struck">
                    <span className="ce-n">−</span>
                    <span className="ce-name">
                      <span className="ce-name-line">
                        <b>{item.competitor.name}</b>
                        <span className="chip bad">뺄 예정</span>
                      </span>
                      <span className="ce-domain">다음 측정부터 빠져요 · 지난 기록은 남아요</span>
                    </span>
                    <span className="ce-score-num">{was?.latest?.score ?? '—'}</span>
                    <span className="ce-q none">{was?.questionIds.length ? `${was.questionIds.join(' · ')} 남음` : '—'}</span>
                    <span className="ce-act">
                      <button type="button" className="ce-btn" onClick={() => revert(by)}>
                        되돌리기
                      </button>
                    </span>
                  </li>
                )
              })}
            </ol>

            <div
              className="ce-cap"
              title={`한 번에 ${cap}곳까지만 함께 재요. 그 아래는 대기로 두고 측정하지 않아요. 위에서 빼거나 바꾸면 대기 첫 줄이 올라와요.`}
            >
              <span>여기까지 함께 측정 · {cap}곳</span>
            </div>

            {restRows.length > 0 ? (
              <ol className="ce-rows wait">
                {restRows.map(({ item, row }) => {
                  const placed = applied.placedBy.get(item.key)
                  const isOpen = open?.kind === 'wait' && open.key === item.key
                  const measuredTargets = slotRows.filter((x) => x.row?.status === 'measured')
                  return (
                    <Row
                      key={item.key}
                      r={row!}
                      n="대기"
                      extraChips={sourceChips(item, applied.replaced, applied.movedDown, originalStatus(item.key), row!)}
                      {...rowProps}
                      action={
                        placed !== undefined && !applied.movedDown.has(item.key)
                          ? { label: '되돌리기', onClick: () => revert(placed) }
                          : row?.status === 'waiting'
                            ? { label: '측정에 넣기', primary: true, onClick: () => setOpen(isOpen ? null : { kind: 'wait', key: item.key }), expanded: isOpen }
                            : undefined
                      }
                    >
                      {isOpen && (
                        <CompetitorPicker
                          title="어느 곳과 자리를 바꿀까요?"
                          note="고른 곳은 지우지 않고 대기로 내려가요."
                          groups={[
                            {
                              head: '함께 측정 중',
                              options: measuredTargets.map((x) => ({
                                id: x.item.key,
                                label: x.item.competitor.name,
                                sub: [
                                  x.row?.latest ? `${x.row.latest.score}점` : '측정 기록 없음',
                                  x.row?.questionIds.length ? x.row.questionIds.join(' · ') : '',
                                ]
                                  .filter(Boolean)
                                  .join(' · '),
                                onPick: () => push({ t: 'swap', a: item.key, b: x.item.key }),
                              })),
                            },
                          ]}
                        />
                      )}
                    </Row>
                  )
                })}
              </ol>
            ) : (
              <p className="ce-empty">대기 중인 경쟁사가 없어요.</p>
            )}

            <button
              type="button"
              className="ce-add"
              aria-expanded={open?.kind === 'add'}
              onClick={() => setOpen(open?.kind === 'add' ? null : { kind: 'add' })}
            >
              + 경쟁사 추가
            </button>
            {open?.kind === 'add' && (
              <CompetitorPicker
                title="추가할 곳"
                note={measuredCount >= cap ? `${cap}곳이 다 찼어요. 넣으면 대기로 들어가요 — 함께 재려면 줄의 「바꾸기·빼기」를 쓰세요.` : undefined}
                groups={suggestionGroups((entry, source) => ({ t: 'add', with: entry, source }))}
                typed={{ submitLabel: '추가', onSubmit: (entry) => push({ t: 'add', with: entry, source: 'typed' }) }}
              />
            )}

            {s.past.length > 0 && (
              <section className="ce-past">
                <button type="button" className="ce-past-toggle" aria-expanded={pastOpen} onClick={() => setPastOpen(!pastOpen)}>
                  예전 경쟁사 {s.past.length} {pastOpen ? '▾' : '▸'}
                </button>
                {pastOpen && (
                  <ul>
                    {s.past.map((p) => (
                      <li key={p.tenantId}>
                        <b>{p.brandName}</b>
                        <span>
                          지난 기록 {p.weeks}주 · 마지막 {shortWeek(p.lastWeekOf)} {p.lastScore}점 · 지난 순위표에 남아 있어요
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            {(s.edit.active || s.edit.undoAvailable) && !ops.length && !savedNow && (
              <div className="ce-edit-state">
                {s.edit.active ? (
                  <span>앱에서 고친 목록을 쓰는 중{s.edit.savedAt ? ` · ${shortDate(s.edit.savedAt)} 저장` : ''}</span>
                ) : (
                  <span>저장소 설정의 목록을 쓰는 중</span>
                )}
                {s.edit.undoAvailable && s.edit.summary && (
                  <button type="button" className="ce-link" disabled={busy || s.measuring} onClick={undo} title={s.edit.summary}>
                    마지막 저장 되돌리기
                  </button>
                )}
                {s.edit.active &&
                  (confirmReset ? (
                    <span className="ce-confirm">
                      저장소 설정({s.edit.repoCompetitors.map((c) => c.name).join(', ')})으로 돌아갈까요?
                      <button type="button" className="ce-link" disabled={busy || s.measuring} onClick={reset}>
                        돌아가기
                      </button>
                      <button type="button" className="ce-link" onClick={() => setConfirmReset(false)}>
                        취소
                      </button>
                    </span>
                  ) : (
                    <button type="button" className="ce-link" onClick={() => setConfirmReset(true)}>
                      저장소 설정으로 돌아가기
                    </button>
                  ))}
              </div>
            )}

            <p className="ce-bank">
              질문지 {s.questionBank.version}
              {s.questionBank.exists ? ` · 공통 ${s.questionBank.sharedCount} · 브랜드 ${s.questionBank.brandCount}` : ' · 다음 측정 때 새로 만들어요'}
              <span
                className="ce-hint"
                title={`점수와 순위는 같은 코호트에 똑같이 묻는 공통 질문${s.questionBank.exists ? ` ${s.questionBank.sharedCount}개` : ''}로 매겨요. 비교 질문은 브랜드 질문이에요.`}
              >
                ?
              </span>
            </p>
          </>
        )}
      </div>

      {s && ops.length > 0 && (
        <div className="ce-bar">
          <p className="ce-bar-summary">{summary.join(' · ')}</p>
          {planning && <p className="ce-bar-note">함께 측정할 곳을 다시 세는 중…</p>}
          {current?.error && <p className="ce-bar-note bad">{current.error}</p>}
          {waitingNames.length > 0 && <p className="ce-bar-note warn">대기 {waitingNames.length}곳({waitingNames.join(', ')})은 측정하지 않아요</p>}
          {planned?.notes.map((n) => (
            <p key={n} className="ce-bar-note warn">
              {n}
            </p>
          ))}
          {errors.map((e) => (
            <p key={e} className="ce-bar-note bad">
              {e}
            </p>
          ))}
          {planned?.unchanged && <p className="ce-bar-note">지금 목록과 같아요.</p>}
          <p className="ce-bar-q">질문지: 그대로 ({s.questionBank.version})</p>
          {actionError && (
            <p className="ce-bar-note bad" role="alert">
              {actionError}
            </p>
          )}
          <div className="ce-bar-actions">
            <span className="ce-bar-hint">{s.measuring ? '측정이 끝난 뒤에 저장할 수 있어요' : '다음 측정부터 적용돼요'}</span>
            <button type="button" className="btn" onClick={() => setOps([])} disabled={busy}>
              취소
            </button>
            <button type="button" className="btn primary" onClick={save} disabled={!canSave}>
              {busy ? '저장 중…' : '저장'}
            </button>
          </div>
        </div>
      )}

      {s && savedNow && !ops.length && (
        <div className="ce-saved" role="status">
          <b>✓ 저장했어요 · 다음 측정부터 적용돼요</b>
          {s.edit.summary && <p>{s.edit.summary}</p>}
          <p>질문지: 그대로 ({s.questionBank.version})</p>
          {actionError && (
            <p className="ce-bar-note bad" role="alert">
              {actionError}
            </p>
          )}
          <div className="ce-bar-actions">
            {s.edit.undoAvailable && (
              <button type="button" className="btn" onClick={undo} disabled={busy || s.measuring}>
                되돌리기
              </button>
            )}
            <button type="button" className="btn primary" onClick={goMeasure}>
              측정하러 가기
            </button>
          </div>
          <p className="ce-saved-note">
            되돌리기는 다음 측정 전까지만 돼요. 「측정하러 가기」는 화면만 옮기고 측정은 시작하지 않아요. GitHub 측정·웹 화면은 저장소 설정을 따라요.
          </p>
        </div>
      )}
    </aside>
  )
}

/** 이번 편집에서 생긴 표시 — 다시 넣음 · 새로 · 측정에 들어감 · 대기로 내려감. */
function sourceChips(
  item: EditItem,
  replaced: Map<string, string>,
  movedDown: Set<string>,
  originalStatus: string | undefined,
  row: EditorCompetitorRow,
): { text: string; tone: string; title?: string }[] {
  if (item.source === 'past') return [{ text: '다시 넣음', tone: 'info', title: `지난 기록 ${row.cohortWeeks}주를 이어요` }]
  if (item.source) return [{ text: '새로', tone: 'info' }]
  if (movedDown.has(item.key) && row.status === 'waiting') return [{ text: '대기로 내려감', tone: '', title: '지우지 않았어요 · 측정하지 않을 뿐이에요' }]
  if (originalStatus && originalStatus !== 'measured' && row.status === 'measured') return [{ text: '측정에 들어감', tone: 'good' }]
  if (replaced.has(item.key)) return [{ text: '측정에 들어감', tone: 'good' }]
  return []
}

function Row({
  r,
  n,
  top,
  ours,
  baselineWeek,
  pending,
  extraChips = [],
  sub,
  action,
  children,
}: {
  r: EditorCompetitorRow
  n: string
  top: number
  ours: number | null
  baselineWeek: string | null
  pending: boolean
  extraChips?: { text: string; tone: string; title?: string }[]
  sub?: string
  action?: { label: string; onClick: () => void; primary?: boolean; expanded?: boolean }
  children?: React.ReactNode
}) {
  const chips = [...extraChips]
  if (r.status === 'collision' && r.collidesWith) {
    chips.push({
      text: '이름 겹침 · 측정 안 됨',
      tone: 'bad',
      title: `${withParticle(`${r.collidesWith.brandName}(${r.collidesWith.industry} · ${r.collidesWith.region})`)} id가 같아 함께 재지 않아요`,
    })
  }
  if (r.status === 'duplicate') chips.push({ text: '같은 곳 중복', tone: 'warn', title: '앞 줄과 같은 브랜드로 재요 · 한 번만 측정해요' })
  if (r.status === 'waiting' && !extraChips.length) {
    chips.push(r.latest ? { text: '대기', tone: '', title: '지금은 칸이 차서 재지 않아요' } : { text: '측정 안 됨', tone: 'warn' })
  }
  if (r.otherRegion) chips.push({ text: '다른 지역으로 잼', tone: 'info', title: '다른 지역에 등록된 같은 브랜드로 재요 · 이 순위표에는 나오지 않아요' })
  if (r.existingCustomer) chips.push({ text: '고객 브랜드', tone: 'info', title: '다른 고객 브랜드를 그 브랜드 설정으로 재요' })
  if (r.deletedOtherIndustry) {
    chips.push({ text: '넣을 수 없음', tone: 'bad', title: `지운 다른 업종 브랜드(${r.deletedOtherIndustry.brandName})와 id가 같아요` })
  } else if (r.deleted) {
    chips.push({ text: '지운 브랜드', tone: 'warn', title: '지운 브랜드와 id가 같아요 · 측정하면 지난 기록이 다시 살아나요' })
  }

  const score = r.latest?.score
  const staleWeek = r.latest && baselineWeek && r.latest.weekOf !== baselineWeek ? shortWeek(r.latest.weekOf) : null
  return (
    <li className={`ce-row${r.takesSlot ? '' : ' wait'}${pending ? ' pending' : ''}`}>
      <span className="ce-n">{n}</span>
      <span className="ce-name">
        <span className="ce-name-line">
          <b>{r.name}</b>
          {chips.map((c) => (
            <span key={c.text} className={`chip ${c.tone}`} title={c.title}>
              {c.text}
            </span>
          ))}
        </span>
        <span className="ce-domain">{[sub, r.domains[0] ?? '홈페이지 없음'].filter(Boolean).join(' · ')}</span>
      </span>
      <span className="ce-score" title={r.latest ? `${shortWeek(r.latest.weekOf)} · 1회 측정` : '측정 기록 없음'}>
        <span className="ce-score-num">
          {score ?? '—'}
          {staleWeek && <small> {staleWeek}</small>}
        </span>
        <span className="ce-score-bar" aria-hidden="true">
          <span style={{ width: `${score === undefined ? 0 : Math.max(3, Math.round((score / top) * 100))}%` }} />
          {ours !== null && <i style={{ left: `${Math.min(100, Math.round((ours / top) * 100))}%` }} />}
        </span>
      </span>
      <span className={`ce-q${r.questionIds.length ? '' : ' none'}`}>{r.questionIds.length ? r.questionIds.join(' · ') : '비교 질문 없음'}</span>
      <span className="ce-act">
        {action && (
          <button
            type="button"
            className={`ce-btn${action.primary ? ' primary' : ''}`}
            onClick={action.onClick}
            aria-expanded={action.expanded}
          >
            {action.label}
          </button>
        )}
      </span>
      {children && <div className="ce-row-pop">{children}</div>}
    </li>
  )
}
