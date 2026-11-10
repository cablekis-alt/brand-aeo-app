import { useEffect, useRef, useState } from 'react'
import {
  IndexAutoRequestError,
  loadIndexAuto,
  planIndexAuto,
  runIndexAuto,
  saveIndexAutoSettings,
  type IndexAutoPlan,
  type IndexAutoRunItem,
  type IndexAutoRunRecord,
  type IndexAutoSettings,
  type IndexAutoStatus,
} from '../lib/api'
import { AUTO_REASON_TEXT, autoReasonText, RUN_CAP_MAX } from '../lib/indexAuto'
import { kstStamp } from '../lib/runTrend'

/**
 * 구글 색인 자동 확인 패널(발행 현황 — src/pages/PublishStatus.tsx). 서버: server/indexAuto.ts(계획 · 실행 · 기록), 규칙: src/lib/indexAuto.ts.
 *
 * 돈이 드는 때를 사람이 정한다: 패널을 펼치면 계획을 받고(검색 0 — 서버가 SerpAPI 계정만 무료로 읽는다), 계획에 보인 검색 수 · 이번 결제
 * 주기 몫 · 계정 바닥을 보고 「n편 확인하기(검색 n회)」를 눌러야 검색한다(그 계획 id로만). 펼치기 전에는 계정을 읽지 않는다. 도는 동안 2초마다
 * 진행을 묻고(계정 · 검색 없음), 끝나면 발행 현황 표를 다시 읽는다. 「발행 현황을 열 때 하루 한 번 자동으로」는 기본 꺼짐 — 켜 두면 화면을 연
 * 처음 한 번만 같은 계획 → 실행 길을 지난다(서버가 하루 한 번을 지킨다).
 *
 * 키가 없으면 넣을 곳과 다시 켜기 안내만, 연결 설정이 틀리면 그 까닭만 보인다. 웹(라우트 404)에서는 아무것도 그리지 않는다. 상태 · 계획을
 * 읽지 못한 것은 패널 안에서만 알리고 표를 막지 않는다.
 */

/** 화면이 가진 자동 확인 상태 — loading 읽는 중, off 이 환경에 없음(웹 404), error 읽지 못함, ready. */
export type IndexAutoLoad = { kind: 'loading' } | { kind: 'off' } | { kind: 'error'; error: string } | { kind: 'ready'; status: IndexAutoStatus }

const POLL_MS = 2000
const NO_KEY =
  '구글 자동 확인: 이 PC에 SerpAPI 키가 없어요 — %APPDATA%\\brand-aeo-app\\.env에 SERPAPI_API_KEY=… 한 줄을 넣고 앱을 다시 켜 주세요. 지금은 「구글에서 확인」으로 직접 확인만 할 수 있어요.'
const EXPLAIN =
  '구글 칸이 14일째 차례인 글을 SerpAPI로 대신 검색해요(3 · 7일째는 지금처럼 직접 확인해요). 같은 주소를 찾으면 「색인됨 · 자동」, 못 찾으면 「아직 · 자동」으로 적어요 — 못 찾았다고 색인이 안 됐다는 확정은 아니라서, 마지막 확인이 자동 「아직」뿐인 글은 30일째에 한 번 더 봐요. 검색이 안 되거나 가릴 수 없으면 아무것도 적지 않고 「자동으로 못 가림」으로 알려 드려요. 직접 누른 표시가 늘 먼저예요. 검색 한 번마다 SerpAPI 사용량이 들어요.'
const STOPPED_ITEM = '실행이 멈춰 가리지 못했어요(위 까닭) — 직접 확인해 주세요.'
const SKIPPED_TEXT: Record<string, string> = {
  changed: '확인하는 사이에 직접 표시해서 자동 결과는 적지 않았어요.',
  'already-shown': '같은 주소의 다른 줄이 이미 색인됨이라 자동 결과는 적지 않았어요.',
  'row-gone': '확인하는 사이 줄이 빠져(뺐거나 옮김) 적지 않았어요.',
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const n = (v: number) => v.toLocaleString('ko-KR')
/** 결제 주기 이름(갱신일 YYYY-MM-DD) → 「12월 8일」. */
const renewalDay = (day: string) => (/^\d{4}-\d{2}-\d{2}$/.test(day) ? `${Number(day.slice(5, 7))}월 ${Number(day.slice(8, 10))}일` : day)

/** 오늘 볼 글보다 적게 검색하는 까닭. */
function limitText(plan: IndexAutoPlan): string | null {
  const rest = plan.candidates - plan.searches
  if (rest <= 0 || !plan.limitedBy) return null
  const q = plan.quota
  switch (plan.limitedBy) {
    case 'run-cap':
      return `한 번에 ${plan.settings.runCap}편까지라 ${rest}편은 다음에 확인해요.`
    case 'feature-cap':
      return `이번 결제 주기 색인 몫이 ${n(q?.featureLeft ?? 0)}회 남아 ${rest}편은 확인하지 않아요.`
    case 'floor':
      return `계정 남은 검색이 바닥(${n(q?.floor ?? 0)}회) 가까이라 ${rest}편은 확인하지 않아요.`
    case 'hour':
      return `이번 시간 검색 한도가 ${n(q?.hourLeft ?? 0)}회 남아 ${rest}편은 한 시간쯤 뒤 확인해요.`
    case 'account':
      return 'SerpAPI 계정 상태로는 검색하지 않아요.'
  }
}

/** 결과 줄의 까닭 — 줄마다 못 가린 까닭, 실행을 멈춘 오류로 못 본 글은 멈춘 까닭을 가리킨다. */
function itemReason(item: IndexAutoRunItem, run: IndexAutoRunRecord): string {
  if (item.reason && AUTO_REASON_TEXT[item.reason]) return AUTO_REASON_TEXT[item.reason]!
  return run.stoppedBy ? STOPPED_ITEM : autoReasonText(item.reason)
}

function RunResult({ run }: { run: IndexAutoRunRecord }) {
  const items = Array.isArray(run.items) ? run.items : []
  const shown = items.filter((i) => i.outcome === 'found' && i.wrote === 'shown').length
  const notYet = items.filter((i) => i.outcome === 'not-found' && i.wrote === 'not-yet').length
  const unknown = items.filter((i) => i.outcome === 'unknown')
  const skipped = items.filter((i) => i.outcome !== 'unknown' && i.skipped)
  return (
    <div className="iap-result">
      <h3>
        마지막 자동 확인 · {kstStamp(run.startedAt)}
        {run.trigger === 'open' ? '(열 때 자동)' : ''}
      </h3>
      {run.stoppedBy && (
        <p className="error" role="alert">
          멈춤 — {run.stoppedBy.message}
        </p>
      )}
      {run.endedAt === null ? (
        <p className="error">끝나지 않고 끊겼어요(앱이 꺼졌을 수 있어요) — 끝난 글은 적혀 있어요. 남은 글은 다음에 확인해요.</p>
      ) : (
        <p className="iap-big">
          {run.searched}편 확인 — 색인됨 {shown} · 아직 {notYet} · 자동으로 못 가림 {unknown.length}
          {skipped.length > 0 ? ` · 적지 않음 ${skipped.length}` : ''}
        </p>
      )}
      {run.notRun > 0 && !run.stoppedBy && <p className="iap-fine">확인하지 않은 글 {run.notRun}편은 다음에 확인해요.</p>}
      {unknown.length > 0 && (
        <>
          <p className="iap-label">자동으로 못 가림 — 직접 확인해 주세요</p>
          <ul className="iap-list">
            {unknown.map((i) => (
              <li key={`${i.key}|${i.postId}`}>
                <b>{i.rowName}</b> — {itemReason(i, run)}
                {i.matched && (
                  <>
                    {' '}
                    <a href={i.matched} target="_blank" rel="noreferrer" aria-label={`${i.rowName} 검색에 나온 주소(새 창)`}>
                      나온 주소
                    </a>
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {skipped.length > 0 && (
        <>
          <p className="iap-label">찾았지만 적지 않은 글</p>
          <ul className="iap-list">
            {skipped.map((i) => (
              <li key={`${i.key}|${i.postId}`}>
                <b>{i.rowName}</b> — {i.outcome === 'found' ? '찾음' : '못 찾음'} · {SKIPPED_TEXT[i.skipped ?? ''] ?? '적지 않았어요.'}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

interface Props {
  load: IndexAutoLoad
  /** 펼침 — 머리 단추(발행 현황 page-actions)와 함께 쓴다. */
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 진행 · 설정으로 상태가 바뀌었다. */
  onStatus: (status: IndexAutoStatus) => void
  /** 실행이 끝났다 — 발행 현황 표를 다시 읽는다. */
  onRunEnd: () => void
  /** 상태를 다시 읽는다(읽기 실패 뒤). */
  onRetry: () => void
}

export default function IndexAutoPanel({ load, open, onOpenChange, onStatus, onRunEnd, onRetry }: Props) {
  const status = load.kind === 'ready' ? load.status : null
  const usable = status !== null && status.configured && !status.configError
  const running = status?.running ?? null
  const isRunning = running !== null
  const runId = running?.runId ?? null
  // 계획 요청 차례 — 펼칠 때 · 「계획 다시 받기」 · 실행이 끝날 때 · 계획이 바뀌었을 때(409) 하나씩 올린다. 받은 계획이 이 차례가 아니면 읽는 중.
  const [planReq, setPlanReq] = useState(0)
  const [planRes, setPlanRes] = useState<{ req: number; plan: IndexAutoPlan | null; error: string | null } | null>(null)
  const [seenOpen, setSeenOpen] = useState(open)
  const [starting, setStarting] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [pollError, setPollError] = useState<string | null>(null)
  const [openRunNote, setOpenRunNote] = useState<string | null>(null)
  const [capText, setCapText] = useState<string | null>(null)
  const [onOpenDraft, setOnOpenDraft] = useState<boolean | null>(null)
  const [settingsNote, setSettingsNote] = useState<{ text: string; error: boolean } | null>(null)
  const [savingSettings, setSavingSettings] = useState(false)
  // 「열 때 하루 한 번」은 이 화면을 연 처음 상태로 한 번만 정한다(다시 읽기 · 설정을 바꾼 뒤에는 하지 않는다).
  const openDecided = useRef(false)

  // 머리 단추로 펼쳐도 계획을 새로 받는다 — 펼침이 바뀐 그 렌더에서 한 번.
  if (open !== seenOpen) {
    setSeenOpen(open)
    if (open) setPlanReq((r) => r + 1)
  }

  useEffect(() => {
    if (!open || planReq === 0 || !usable || isRunning) return
    let alive = true
    planIndexAuto('button').then(
      (plan) => {
        if (alive) setPlanRes({ req: planReq, plan, error: null })
      },
      (err: unknown) => {
        if (alive) setPlanRes({ req: planReq, plan: null, error: message(err) })
      },
    )
    return () => {
      alive = false
    }
  }, [open, planReq, usable, isRunning])

  useEffect(() => {
    if (!runId) return
    let alive = true
    const timer = window.setInterval(() => {
      loadIndexAuto().then(
        (next) => {
          if (!alive || !next) return
          setPollError(null)
          onStatus(next)
          if (next.running?.runId !== runId) {
            onRunEnd()
            setPlanReq((r) => r + 1)
          }
        },
        (err: unknown) => {
          if (alive) setPollError(`진행 상태를 읽지 못했어요 — ${message(err)}`)
        },
      )
    }, POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [runId, onStatus, onRunEnd])

  useEffect(() => {
    if (!status || openDecided.current) return
    openDecided.current = true
    if (!usable || !status.settings.autoOnOpen || status.openRunToday || status.running) return
    planIndexAuto('open')
      .then(async (plan) => {
        if (!plan.planId || plan.searches <= 0) {
          if (plan.blocked) setOpenRunNote(`열 때 자동 확인을 하지 않았어요 — ${plan.blocked}`)
          return
        }
        const started = await runIndexAuto(plan.planId)
        onStatus({ ...status, running: { runId: started.runId, trigger: 'open', startedAt: new Date().toISOString(), total: started.total, done: 0 } })
        onOpenChange(true)
      })
      .catch((err: unknown) => setOpenRunNote(`열 때 자동 확인을 하지 못했어요 — ${message(err)}`))
  }, [status, usable, onStatus, onOpenChange])

  if (load.kind === 'loading' || load.kind === 'off') return null
  if (load.kind === 'error') {
    return (
      <section className="iap-panel" aria-label="구글 색인 자동 확인">
        <p className="error" role="alert">
          구글 자동 확인 상태를 읽지 못했어요 — {load.error}{' '}
          <button type="button" className="ghost" onClick={onRetry}>
            다시 시도
          </button>
        </p>
      </section>
    )
  }
  const st = load.status
  if (!st.configured || st.configError) {
    return (
      <section className="iap-panel iap-off" aria-label="구글 색인 자동 확인">
        {st.configured ? <p className="error">구글 자동 확인: {st.configError}</p> : <p className="muted">{NO_KEY}</p>}
      </section>
    )
  }

  const loading = !isRunning && planRes?.req !== planReq
  const plan = loading ? null : (planRes?.plan ?? null)
  const planError = loading ? null : (planRes?.error ?? null)
  const replan = () => {
    setRunError(null)
    setPlanReq((r) => r + 1)
  }
  const start = (planId: string) => {
    setStarting(true)
    setRunError(null)
    runIndexAuto(planId)
      .then((started) => {
        onStatus({ ...st, running: { runId: started.runId, trigger: 'button', startedAt: new Date().toISOString(), total: started.total, done: 0 } })
        // 누른 단추가 진행 글자로 바뀌어 사라진다 — 키보드 포커스를 패널 머리(진행이 함께 보인다)로 옮긴다.
        document.getElementById('iap-toggle')?.focus()
      })
      .catch((err: unknown) => {
        setRunError(message(err))
        // 계획이 바뀌었다 · 그 사이 다른 실행이 돈다 — 지금 계획을 새로 받는다.
        if (err instanceof IndexAutoRequestError && err.status === 409) setPlanReq((r) => r + 1)
      })
      .finally(() => setStarting(false))
  }
  const capValue = capText ?? String(st.settings.runCap)
  const onOpenValue = onOpenDraft ?? st.settings.autoOnOpen
  const saveSettings = () => {
    const cap = Number(capValue)
    if (!/^\d+$/.test(capValue.trim()) || !Number.isInteger(cap) || cap < 1 || cap > RUN_CAP_MAX) {
      setSettingsNote({ text: `한 번에 1~${RUN_CAP_MAX}편 사이로 적어 주세요.`, error: true })
      return
    }
    const patch: Partial<IndexAutoSettings> = {}
    if (cap !== st.settings.runCap) patch.runCap = cap
    if (onOpenValue !== st.settings.autoOnOpen) patch.autoOnOpen = onOpenValue
    if (Object.keys(patch).length === 0) {
      setSettingsNote({ text: '바뀐 설정이 없어요.', error: false })
      return
    }
    setSavingSettings(true)
    setSettingsNote(null)
    saveIndexAutoSettings(patch)
      .then((settings) => {
        onStatus({ ...st, settings })
        setCapText(null)
        setOnOpenDraft(null)
        setSettingsNote({ text: '설정을 저장했어요.', error: false })
        // 한 번 상한이 바뀌면 이번에 검색할 수도 바뀐다.
        if ('runCap' in patch && !isRunning) setPlanReq((r) => r + 1)
      })
      .catch((err: unknown) => setSettingsNote({ text: `설정을 저장하지 못했어요 — ${message(err)}`, error: true }))
      .finally(() => setSavingSettings(false))
  }

  const q = plan?.quota ?? null
  const sub = running
    ? `확인하는 중… ${running.done}/${running.total}`
    : '14일째 차례인 글의 구글 칸을 SerpAPI로 대신 검색해요 · 누르기 전에 검색 수와 남은 몫을 보여 드려요'
  const lastRun = !isRunning ? st.lastRun : null

  return (
    <section className="iap-panel" aria-labelledby="iap-toggle">
      <h2 className="iap-head">
        <button id="iap-toggle" type="button" className="iap-toggle" aria-expanded={open} aria-controls="iap-body" onClick={() => onOpenChange(!open)}>
          <span className="iap-title">구글 색인 자동 확인</span>
          <span className="iap-sub">{sub}</span>
        </button>
      </h2>
      <div id="iap-body" className="iap-body" hidden={!open}>
        {open && (
          <>
            <p className="iap-lead">{EXPLAIN}</p>
            {openRunNote && <p className="pi-note">{openRunNote}</p>}
            {running ? (
              <>
                <p className="iap-progress" role="status">
                  확인하는 중… {running.done}/{running.total} — 앱을 끄면 멈춰요(끝난 글은 적혀 있어요).
                </p>
                {pollError && (
                  <p className="error" role="alert">
                    {pollError}
                  </p>
                )}
              </>
            ) : (
              <div className="iap-plan">
                {loading && <p className="muted">계획을 세우는 중… SerpAPI 계정만 읽어요(검색은 하지 않아요).</p>}
                {planError && (
                  <p className="error" role="alert">
                    계획을 받지 못했어요 — {planError}
                  </p>
                )}
                {plan && (
                  <>
                    <p className="iap-big">{plan.candidates > 0 ? `이번에 확인할 글 ${plan.searches}편 · 검색 ${plan.searches}회` : '오늘 자동으로 볼 글이 없어요.'}</p>
                    {limitText(plan) && <p className="iap-fine">{limitText(plan)}</p>}
                    {q && (
                      <p className="iap-quota">
                        이번 결제 주기({renewalDay(q.cycle)} 갱신까지) 이 PC 색인 몫 남은 검색 {n(q.featureLeft)}회 / {n(q.cap)}회 · 계정 남은 검색 {n(q.accountLeft)}회 — 계정
                        바닥 {n(q.floor)}회 아래로는 쓰지 않아요 · 이번 시간 남은 검색 {n(q.hourLeft)}회
                        {q.planName && q.searchesPerMonth !== null && q.rateLimitPerHour !== null && (
                          <span className="iap-fine">
                            {' '}
                            ({q.planName} 월 {n(q.searchesPerMonth)}회 · 시간당 {n(q.rateLimitPerHour)}회)
                          </span>
                        )}
                      </p>
                    )}
                    <ul className="iap-facts">
                      {plan.manual > 0 && <li>3 · 7일째 차례 {plan.manual}편은 직접 확인해 주세요(「구글에서 확인」).</li>}
                      {plan.settled > 0 && <li>이번 차례에 자동으로 못 가린 글 {plan.settled}편 — 다시 찾지 않아요. 칸 아래 안내대로 직접 확인해 주세요.</li>}
                      {plan.shownElsewhere > 0 && <li>다른 줄에서 이미 색인됨으로 본 주소 {plan.shownElsewhere}편은 자동이 건드리지 않아요.</li>}
                      {plan.unsupported.length > 0 && (
                        <li>
                          자동으로 안 찾는 주소 {plan.unsupported.length}편 — 직접 확인해 주세요.
                          <ul className="iap-list">
                            {plan.unsupported.map((u) => (
                              <li key={u.key}>
                                <b>{u.rowName}</b> — {u.text}
                              </li>
                            ))}
                          </ul>
                        </li>
                      )}
                      <li>이미 색인된 글은 다시 찾지 않아요.</li>
                    </ul>
                    {plan.blocked && (
                      <p className="error" role="alert">
                        {plan.blocked}
                      </p>
                    )}
                  </>
                )}
                {runError && (
                  <p className="error" role="alert">
                    {runError}
                  </p>
                )}
                {!loading && (
                  <div className="iap-actions">
                    {plan?.planId && plan.searches > 0 && (
                      <button type="button" className="btn primary" disabled={starting} onClick={() => start(plan.planId!)}>
                        {plan.searches}편 확인하기(검색 {plan.searches}회)
                      </button>
                    )}
                    <button type="button" className="btn" disabled={starting} onClick={replan}>
                      계획 다시 받기
                    </button>
                  </div>
                )}
                {plan?.planId && plan.searches > 0 && <p className="iap-fine">하나씩 차례로 검색해요(한 편에 몇 초) — 앱을 끄면 멈춰요(끝난 글은 적혀 있어요).</p>}
              </div>
            )}
            {lastRun && <RunResult run={lastRun} />}
            <details className="iap-settings">
              <summary>설정</summary>
              <div className="iap-settings-body">
                <label className="iap-field" htmlFor="iap-run-cap">
                  한 번에
                  <input
                    id="iap-run-cap"
                    className="iap-num"
                    type="number"
                    min={1}
                    max={RUN_CAP_MAX}
                    step={1}
                    inputMode="numeric"
                    value={capValue}
                    onChange={(e) => setCapText(e.target.value)}
                  />
                  편까지
                </label>
                <label className="ps-toggle" htmlFor="iap-on-open">
                  <input id="iap-on-open" type="checkbox" checked={onOpenValue} onChange={(e) => setOnOpenDraft(e.target.checked)} />
                  발행 현황을 열 때 하루 한 번 자동으로(기본 꺼짐 — 켜면 이 화면을 열 때 묻지 않고 검색해요)
                </label>
                <div className="iap-actions">
                  <button type="button" className="btn" disabled={savingSettings} onClick={saveSettings}>
                    설정 저장
                  </button>
                </div>
                {settingsNote &&
                  (settingsNote.error ? (
                    <p className="error" role="alert">
                      {settingsNote.text}
                    </p>
                  ) : (
                    <p className="pi-note" role="status">
                      {settingsNote.text}
                    </p>
                  ))}
                <p className="iap-fine">
                  {q
                    ? `몫은 결제 주기마다 요금제 월 검색 수의 비율로 정해요 — 이 PC 색인 자동 확인 ${n(q.cap)}회, 계정 바닥 ${n(q.floor)}회(다른 프로젝트와 계정을 나눠 써서 남은 검색이 이 아래로 내려가지 않게 해요).`
                    : '색인 몫 · 계정 바닥은 계획을 받으면 보여 드려요.'}
                </p>
                <p className="iap-fine">SerpAPI 계정 설정의 자동 조기 갱신(Automatic Early Renewal)은 끄기를 권해요 — 켜 두면 검색을 다 썼을 때 멈추지 않고 새 결제가 일어나요.</p>
              </div>
            </details>
          </>
        )}
      </div>
    </section>
  )
}
