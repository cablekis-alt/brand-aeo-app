import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTenant } from '../context/useTenant'
import {
  draftCompetitorQuestions,
  loadCompetitorEditor,
  planCompetitorEdit,
  resetCompetitorEdit,
  saveCompetitorEdit,
  undoCompetitorEdit,
  type CompetitorEditPlan,
  type CompetitorEditorState,
  type CompetitorEntry,
  type EditorCompetitorRow,
  type ExcludedRange,
  type ExclusionPreview,
  type HandoffHint,
  type PastOutInput,
  type QuestionHandoffPlan,
  type QuestionRewriteResult,
} from '../lib/api'
import {
  applyOps,
  baseItems,
  displayHost,
  dropHint,
  handoffHints,
  rankText,
  revertOp,
  summarizeOps,
  summarizePastOut,
  toCompetitors,
  weekRange,
  type AppliedEdit,
  type EditItem,
  type EditOp,
  type InputSource,
} from '../lib/competitorEdit'
import { objectParticle, subjectParticle, topicParticle, withParticle } from '../lib/korean'
import CompetitorPicker, { type PickerGroup } from './CompetitorPicker'

const shortWeek = (weekOf: string) => weekOf.replace(/^\d{4}-/, '')
const shortDate = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : `${d.getMonth() + 1}월 ${d.getDate()}일 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const squash = (s: string) => s.replace(/\s+/g, '')

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; value: CompetitorEditorState }
/** id를 붙이기 전의 작업 — push가 고정 id를 준다(src/lib/competitorEdit.ts newKey 주석). */
type NewOp = EditOp extends infer T ? (T extends EditOp ? Omit<T, 'id'> : never) : never
/** 작업 id — 서랍을 다시 열어도 겹치지 않게 모듈에서 센다(작업 목록은 서랍마다 새로 시작한다). */
let opSeq = 0
function nextOpId(): string {
  opSeq += 1
  return String(opSeq)
}
type Open = { kind: 'row'; key: string } | { kind: 'wait'; key: string } | { kind: 'add' } | null
type PlanState = { key: string; value: CompetitorEditPlan | null; error: string | null }
/** 넘겨받은 비교 질문 고쳐 쓰기 — 계획(key)마다 하나. */
type DraftState = { status: 'running'; startedAt: number } | { status: 'done'; value: QuestionRewriteResult } | { status: 'error'; message: string }
type SetDrafts = (update: (prev: Record<string, DraftState>) => Record<string, DraftState>) => void

const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`

/** 고쳐 쓰기를 부르고 결과를 계획 key 자리에 둔다. 자동(계획이 오면)과 「다시 쓰기」가 함께 쓴다. */
function runDraft(
  tenantId: string,
  key: string,
  req: { competitors: CompetitorEntry[]; handoff: HandoffHint[] },
  fresh: boolean,
  setDrafts: SetDrafts,
  onResult: () => void,
) {
  setDrafts((d) => ({ ...d, [key]: { status: 'running', startedAt: Date.now() } }))
  draftCompetitorQuestions(tenantId, req.competitors, req.handoff, key, fresh).then(
    (value) => {
      setDrafts((d) => ({ ...d, [key]: { status: 'done', value } }))
      onResult()
    },
    (err: unknown) => {
      console.error('[CompetitorEditor] 비교 질문을 고쳐 쓰지 못했습니다', err)
      const message = err instanceof Error ? (err.name === 'TimeoutError' ? '3분 안에 끝나지 않았어요' : err.message) : String(err)
      setDrafts((d) => ({ ...d, [key]: { status: 'error', message } }))
    },
  )
}

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
 * 저장은 data/<tenant>/competitors.json에 하고 다음 측정부터 적용된다. 빠지는 경쟁사를 짚은 비교 질문은 들어오는 곳이 넘겨받아
 * 고쳐 쓴다(4단계 — 서버가 받는 곳을 정하고 판정 엔진이 문장을 쓴다). 고친 질문을 확인해야 저장할 수 있다.
 */
export default function CompetitorEditor({
  tenantId,
  onClose,
  onSaved,
  onDirtyChange,
}: {
  tenantId: string
  onClose: () => void
  onSaved: () => void
  /** 저장하지 않은 바꾼 내용이 있는지 — 브랜드 현황이 다른 브랜드로 바꾸거나 화면을 떠나기 전에 묻는다. */
  onDirtyChange?: (dirty: boolean) => void
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
  const [pickError, setPickError] = useState<string | null>(null)
  // 「지난 기록에서도 빼기」: 경쟁사 id → 'all'(이 코호트 지난 기록 전체) 또는 주차(그 주만). 「다시 세기」: 뺀 범위를 지울 id.
  const [pastOut, setPastOut] = useState<Record<string, string>>({})
  const [restore, setRestore] = useState<string[]>([])
  // 확인 창은 연 때의 미리보기(key)에 묶는다 — 미리보기가 바뀌거나 사라지면 저절로 닫히고, 나중에 혼자 열리지 않는다.
  const [confirmKey, setConfirmKey] = useState<string | null>(null)
  const [savedExclusion, setSavedExclusion] = useState<ExclusionPreview | null>(null)
  // 저장이 실패하면(그사이 순위가 바뀌어 409 등) 같은 입력으로 미리보기를 다시 받는다.
  const [replan, setReplan] = useState(0)
  // 마지막으로 받은 미리보기 — 새 미리보기를 기다리는 동안에도 「W42 기록만 빼기」 · 「다시 세기」 체크가 사라지지 않게(저장은 새 것만 쓴다).
  const [lastPlan, setLastPlan] = useState<CompetitorEditPlan | null>(null)
  const [drafts, setDrafts] = useState<Record<string, DraftState>>({})
  const [qOpen, setQOpen] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
  // 저장한 순간의 질문지 계획 — 결과 카드가 「v5 → v6」을 보인다.
  const [savedQuestions, setSavedQuestions] = useState<QuestionHandoffPlan | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const saveRef = useRef<HTMLButtonElement>(null)
  const confirmWasOpen = useRef(false)

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
  // 체크할 수 있는 곳 — 이번 편집에서 뺀 줄(그 코호트 기록이 있을 때)과 예전 경쟁사. 줄을 되돌리면 그 체크는 요청에서 빠진다.
  const removedIds = applied.removed
    .map((item) => s?.rows[Number(item.key.slice(1))])
    .map((r) => (r ? (r.targetTenantId ?? r.draftId) : null))
    .filter((x): x is string => Boolean(x))
  const eligible = new Set([...removedIds, ...(s?.past.filter((p) => p.cohortWeeks > 0).map((p) => p.tenantId) ?? [])])
  const excludedIds = new Set([
    ...(s?.past.filter((p) => p.excluded.length).map((p) => p.tenantId) ?? []),
    ...(s?.rows.filter((r) => r.excluded.length).map((r) => r.targetTenantId ?? r.draftId) ?? []),
  ])
  const pastAdd = Object.entries(pastOut)
    .filter(([id]) => eligible.has(id))
    .map(([id, v]) => (v === 'all' ? { tenantId: id } : { tenantId: id, onlyWeek: v }))
  const pastRestore = restore.filter((id) => excludedIds.has(id))
  const pastInput: PastOutInput | null = pastAdd.length || pastRestore.length ? { add: pastAdd, restore: pastRestore } : null
  const dirty = ops.length > 0 || pastInput !== null
  // 누가 누구 자리에 들었나 — 서버가 빠지는 경쟁사의 질문을 받을 곳을 정할 때 쓴다(요청 key에도 넣어 미리보기 = 저장).
  const hints = useMemo(() => handoffHints(base, applied), [base, applied])
  const requestKey = dirty ? JSON.stringify({ competitors: toCompetitors(applied.list), pastOut: pastInput, handoff: hints }) : ''

  // 바뀔 때마다(잠깐 멈춘 뒤) 서버에 미리 계산을 묻는다. 응답은 지금 목록과 같을 때만 쓴다.
  useEffect(() => {
    if (!requestKey) return
    let alive = true
    const timer = setTimeout(() => {
      const req = JSON.parse(requestKey) as { competitors: CompetitorEntry[]; pastOut: PastOutInput | null; handoff: HandoffHint[] }
      planCompetitorEdit(tenantId, req.competitors, req.pastOut, req.handoff).then(
        (value) => {
          if (!alive) return
          setPlan({ key: requestKey, value, error: null })
          setLastPlan(value)
        },
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
  const planned = dirty ? current?.value ?? null : null
  const planning = dirty && !current
  // 새 미리보기를 기다리는 동안 보일 값 — 줄의 뺀 범위 · 「이번 주」 여부는 체크에 따라 바뀌지 않는다. 저장 판단은 planned만 쓴다.
  const shownPlan = planned ?? (dirty ? lastPlan : null)
  // 서버 계산이 오기 전에는 원래 줄의 정보를 이름으로 붙여 보여 준다(칸 나눔은 순서대로 가정).
  // 계산이 실패해도(잘못된 주소 등) 새로 넣은 줄은 보여야 한다 — 그래야 그 줄을 되돌릴 수 있다.
  const rowFor = (item: EditItem, i: number): EditorCompetitorRow | null => {
    if (!s) return null
    if (!ops.length) return s.rows[i] ?? null
    if (planned?.rows[i]) return planned.rows[i]
    const guess = { index: i, status: i < s.cap ? ('measured' as const) : ('waiting' as const), takesSlot: i < s.cap }
    const prev = lastPlan?.rows[i]
    if (prev && squash(prev.name) === squash(item.competitor.name)) return { ...prev, ...guess }
    const known = s.rows.find((r) => squash(r.name) === squash(item.competitor.name))
    if (known) return { ...known, ...guess }
    return {
      ...guess,
      name: item.competitor.name,
      aliases: item.competitor.aliases,
      domains: item.competitor.domains,
      draftId: null,
      targetTenantId: null,
      otherRegion: false,
      existingCustomer: false,
      collidesWith: null,
      deleted: false,
      deletedOtherIndustry: null,
      cohortWeeks: 0,
      cohortFirstWeekOf: null,
      excluded: [],
      measuredByOthers: [],
      latest: null,
      questionIds: [],
    }
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

  // 성립하지 않는 작업(이미 있는 이름, 마지막 한 곳 빼기)은 쌓지 않고 고르기 상자에 이유를 보인다.
  const push = (raw: NewOp) => {
    const op = { ...raw, id: nextOpId() } as EditOp
    const next = [...ops, op]
    if (!applyOps(base, next).valid.at(-1)) {
      setPickError(
        op.t === 'drop'
          ? '마지막 한 곳은 뺄 수 없어요 — 경쟁사가 하나도 없으면 측정할 때마다 AI가 새로 골라요.'
          : op.t === 'homepage'
            ? '지금 홈페이지와 같아요.'
            : '이미 목록에 있는 곳이에요.',
      )
      return
    }
    setOps(next)
    setOpen(null)
    setPickError(null)
    setSavedNow(false)
    setActionError(null)
  }
  const toggle = (next: Open) => {
    setPickError(null)
    setOpen(next)
  }
  const revert = (index: number) => setOps(revertOp(base, ops, index))
  const listNames = new Set(applied.list.map((x) => squash(x.competitor.name)))
  const suggestionGroups = (make: (entry: CompetitorEntry, source: InputSource) => NewOp): PickerGroup[] =>
    (['past', 'cohort', 'answers'] as const).map((source) => ({
      head: SOURCE_HEAD[source],
      options: (s?.suggestions ?? [])
        .filter((x) => x.source === source && !listNames.has(squash(x.name)))
        .map((x) => ({
          id: `${source}:${x.name}`,
          label: x.name,
          sub: x.note,
          // 예전 경쟁사라도 같은 id로 이어지지 않으면 「다시 넣음」이 아니라 새로 넣은 곳이다.
          onPick: () => push(make({ name: x.name, aliases: x.aliases, domains: x.domains }, source === 'past' && x.continues === false ? 'cohort' : source)),
        })),
    }))

  const exclusion = pastInput ? (planned?.exclusion ?? null) : null
  const summary = [...summarizeOps(base, ops), ...summarizePastOut(exclusion), ...questionSummary(planned?.questions ?? null)]
  const errors = planned?.errors ?? []
  const pastLocked = (exclusion?.locked.length ?? 0) > 0
  // 측정 중인지는 미리 계산 응답으로 다시 본다 — 서랍을 연 뒤 측정이 끝났을 수 있다.
  const measuringNow = planned ? planned.measuring : Boolean(s?.measuring)
  // 질문 넘겨받기 — 고쳐 쓸 질문이 있으면 계획이 오자마자 판정 엔진에 고쳐 쓰기를 맡긴다(빼기만 있으면 부르지 않는다).
  const qplan = planned?.questions ?? null
  const rewrites = qplan?.mode === 'derive' ? qplan.items.filter((i) => i.action === 'rewrite') : []
  const draft = qplan ? drafts[qplan.key] : undefined
  const draftDone = draft?.status === 'done' ? draft.value : null
  const questionsReady =
    !qplan || qplan.mode !== 'derive' || rewrites.length === 0 || Boolean(draftDone && !draftDone.failed.length && draftDone.drafts.length === rewrites.length)
  const draftNeeded = qplan && rewrites.length > 0 && !draft && !measuringNow ? qplan.key : null
  useEffect(() => {
    if (!draftNeeded) return
    // 계획과 같은 입력으로 부른다(requestKey) — 서버가 계획을 다시 세어 key가 같을 때만 고쳐 쓴다.
    const timer = setTimeout(() => {
      const req = JSON.parse(requestKey) as { competitors: CompetitorEntry[]; handoff: HandoffHint[] }
      runDraft(tenantId, draftNeeded, req, false, setDrafts, () => setQOpen(true))
    }, 0)
    return () => clearTimeout(timer)
  }, [tenantId, draftNeeded, requestKey])
  const drafting = draft?.status === 'running'
  useEffect(() => {
    if (!drafting) return
    const timer = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [drafting])
  const draftElapsed = draft?.status === 'running' ? Math.max(0, Math.round((nowMs - draft.startedAt) / 1000)) : 0
  // 「다시 쓰기」 — 결과를 받은 뒤면 다른 표현으로 새로 쓴다(fresh). 시간 초과 · 오류 뒤면 서버가 아직 쓰는 중이거나 써 둔 결과에
  // 붙는다 — fresh로 보내면 그 결과를 버리고 판정 엔진을 다시 불러, 같은 3분을 또 기다리게 된다.
  const redraft = (fresh: boolean) => {
    if (!qplan) return
    runDraft(tenantId, qplan.key, JSON.parse(requestKey) as { competitors: CompetitorEntry[]; handoff: HandoffHint[] }, fresh, setDrafts, () => setQOpen(true))
  }
  const canSave =
    Boolean(s) &&
    dirty &&
    Boolean(planned) &&
    (!planned?.unchanged || Boolean(exclusion?.items.length)) &&
    errors.length === 0 &&
    !pastLocked &&
    !measuringNow &&
    questionsReady &&
    !busy

  const confirmOpen = confirmKey !== null && exclusion?.key === confirmKey
  const clearEdits = () => {
    setOps([])
    setPastOut({})
    setRestore([])
    setConfirmKey(null)
  }
  const run = (task: () => Promise<CompetitorEditorState>, after: (value: CompetitorEditorState) => void) => {
    setBusy(true)
    setActionError(null)
    task().then(
      (value) => {
        setLoad({ status: 'ok', value })
        clearEdits()
        setOpen(null)
        // 저장 전 미리보기는 버린다 — 같은 입력을 다시 고르면 새로 계산한다.
        setPlan(null)
        setLastPlan(null)
        setBusy(false)
        after(value)
        onSaved()
      },
      (err: unknown) => {
        console.error('[CompetitorEditor] 저장하지 못했습니다', err)
        setBusy(false)
        setConfirmKey(null)
        setActionError(err instanceof Error ? err.message : String(err))
        // 그사이 순위가 바뀌었을 수 있다 — 미리보기를 버리고 같은 입력으로 다시 받는다(옛 key로 다시 저장하지 않게).
        setPlan(null)
        setReplan((n) => n + 1)
      },
    )
  }
  // 저장하는 순간의 미리보기 — 확인 창 · 결과 카드가 같은 값을 보인다. 서버는 이 previewKey와 지금 계산이 같을 때만 쓴다.
  const doSave = () => {
    const shown = exclusion
    const shownQuestions = qplan
    // 고쳐 쓴 문장은 미리 본 그대로 보낸다 — 서버는 다시 쓰지 않고 같은 검사만 다시 한다.
    const questions =
      qplan?.mode === 'derive'
        ? { key: qplan.key, drafts: (draftDone?.drafts ?? []).map((d) => ({ fromId: d.fromId, text: d.text, ...(d.topic ? { topic: d.topic } : {}) })) }
        : undefined
    run(
      () =>
        saveCompetitorEdit(
          tenantId,
          toCompetitors(applied.list),
          summary.join(' · '),
          pastInput && shown ? { pastOut: pastInput, previewKey: shown.key } : null,
          { handoff: hints, questions },
        ),
      () => {
        setSavedNow(true)
        setSavedExclusion(shown?.items.length ? shown : null)
        setSavedQuestions(shownQuestions)
      },
    )
  }
  // 지난 기록을 바꾸면 확인을 받는다 — 이미 보낸 주간 보고서와 숫자가 달라질 수 있다.
  const save = () => (exclusion?.items.length ? setConfirmKey(exclusion.key) : doSave())

  // 확인 창을 열면 「다시 계산하고 저장」으로, 닫으면 저장 버튼으로 초점을 옮긴다.
  useEffect(() => {
    if (confirmOpen) confirmRef.current?.focus()
    else if (confirmWasOpen.current) saveRef.current?.focus()
    confirmWasOpen.current = confirmOpen
  }, [confirmOpen])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 명령 창·브랜드 고르기가 처리한 Escape(preventDefault)는 서랍까지 닫지 않는다.
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (confirmOpen) {
        if (!busy) setConfirmKey(null)
      } else if (open) setOpen(null)
      else close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  const undo = () =>
    run(
      () => undoCompetitorEdit(tenantId),
      () => {
        setSavedNow(false)
        setSavedExclusion(null)
        setSavedQuestions(null)
      },
    )
  const setPast = (id: string, value: string | undefined) => {
    const next = { ...pastOut }
    if (value) next[id] = value
    else delete next[id]
    setPastOut(next)
    setSavedNow(false)
    setActionError(null)
  }
  const toggleRestore = (id: string, on: boolean) => {
    setRestore(on ? [...new Set([...restore, id])] : restore.filter((x) => x !== id))
    setSavedNow(false)
    setActionError(null)
  }
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
  // 줄의 「비교 질문」 칸 — 넘겨받는 곳은 「v6-004 받음」, 빠지는 곳은 「v5-004 → 새 곳」 · 「v5-004 뺌」.
  const qTextFor = (name: string): string | undefined => {
    if (qplan?.mode !== 'derive') return undefined
    const got = qplan.receivers.find((r) => squash(r.name) === squash(name))
    if (got) return `${got.ids.join(' · ')} 받음`
    const outs = qplan.items.flatMap((i) => {
      const swap = i.swaps.find((sw) => squash(sw.from.name) === squash(name))
      return swap ? [i.action === 'rewrite' && swap.to ? `${i.fromId} → ${swap.to.name}` : `${i.fromId} 뺌`] : []
    })
    return outs.length ? outs.join(' · ') : undefined
  }
  // 지난 기록에서 뺀 뒤 다시 넣은 경쟁사 — 다시 잰 주부터는 저절로 세지만, 그 전 주는 여기서 다시 센다.
  const restoreFor = (r: EditorCompetitorRow | null) => {
    const id = r ? (r.targetTenantId ?? r.draftId) : null
    // 요청에 실을 수 있는 곳만 — 저장된 상태에서 뺀 범위가 있는 곳(미리보기 줄만 보고 그리면 체크해도 요청에 안 실린다).
    if (!r || !id || !r.excluded.length || !excludedIds.has(id)) return undefined
    return (
      <label className="ce-pastbox-opt">
        <input type="checkbox" checked={restore.includes(id)} onChange={(e) => toggleRestore(id, e.target.checked)} />
        지난 기록 다시 세기 ({rangesText(r.excluded, r.cohortFirstWeekOf ?? r.excluded[0]!.untilWeek)})
      </label>
    )
  }

  return (
    <aside className="ce-drawer" aria-labelledby="ce-title">
      <div className="ce-head" inert={confirmOpen || undefined}>
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

      <div className="ce-body" inert={confirmOpen || undefined}>
        {load.status === 'loading' && <p className="muted">불러오는 중…</p>}
        {load.status === 'error' && (
          <p className="error" role="alert">
            {load.message}
          </p>
        )}
        {s && (
          <fieldset className="ce-fieldset" disabled={busy}>
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
                const chips = sourceChips(item, applied, originalStatus(item.key), row!)
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
                    qText={qTextFor(item.competitor.name)}
                    below={restoreFor(row)}
                    action={
                      placed !== undefined
                        ? { label: '되돌리기', onClick: () => revert(placed) }
                        : { label: '바꾸기·빼기', onClick: () => toggle(isOpen ? null : { kind: 'row', key: item.key }), expanded: isOpen }
                    }
                  >
                    {isOpen && (
                      <CompetitorPicker
                        title={`${item.competitor.name} 자리에 넣을 곳`}
                        error={pickError}
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
                            options:
                              applied.list.length > 1
                                ? [
                                    {
                                      id: 'drop',
                                      label: '빼기',
                                      sub: `다음 측정부터 빠져요 · 지난 기록은 남아요 · ${dropHint(waitingNames, row?.status === 'measured' ? measuredCount - 1 : measuredCount)}`,
                                      danger: true,
                                      onPick: () => push({ t: 'drop', key: item.key }),
                                    },
                                  ]
                                : [],
                          },
                        ]}
                        typed={{
                          submitLabel: '이곳으로 바꾸기',
                          onSubmit: (entry) => push({ t: 'replace', key: item.key, with: entry, source: 'typed' }),
                          onHomepageOnly: (home) => push({ t: 'homepage', key: item.key, domains: [home] }),
                        }}
                      />
                    )}
                  </Row>
                )
              })}
              {applied.removed.map((item) => {
                const by = applied.removedBy.get(item.key)!
                const was = s.rows[Number(item.key.slice(1))]
                const pastId = was ? (was.targetTenantId ?? was.draftId) : null
                // 같은 주에 다시 재면 이번 주 기록이 순위표에 남는다 — 그 주만 뺄 수 있게 한다.
                const sameWeek = shownPlan?.leaving.find((l) => l.tenantId === pastId)?.thisWeek ? (was?.latest?.weekOf ?? null) : null
                return (
                  <li key={item.key} className="ce-row struck">
                    <span className="ce-n">−</span>
                    <span className="ce-name">
                      <span className="ce-name-line">
                        <b>{item.competitor.name}</b>
                        <span className="chip bad">뺄 예정</span>
                      </span>
                      <span className="ce-domain">다음 측정부터 빠져요 · {pastLabel(pastOut[pastId ?? ''])}</span>
                      {pastId && was && was.cohortWeeks > 0 && was.latest && (
                        <PastBox
                          range={weekRange(was.cohortFirstWeekOf ?? was.latest.weekOf, was.latest.weekOf)}
                          weeks={was.cohortWeeks}
                          onlyWeek={sameWeek}
                          value={pastOut[pastId]}
                          onChange={(v) => setPast(pastId, v)}
                          lockedBy={was.measuredByOthers}
                          excluded={was.excluded}
                          firstWeek={was.cohortFirstWeekOf ?? was.latest.weekOf}
                        />
                      )}
                    </span>
                    <span className="ce-score-num">{was?.latest?.score ?? '—'}</span>
                    <span className="ce-q none">
                      {qTextFor(item.competitor.name) ??
                        // 재지 않던 대기 줄을 빼면 넘겨받지 않는다 — 그 줄을 짚은 질문은 질문지에 그대로 남는다.
                        ((qplan?.mode === 'same' || qplan?.mode === 'derive') && was?.questionIds.length ? `${was.questionIds.join(' · ')} 남음` : '—')}
                    </span>
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
                      n={row?.status === 'waiting' ? '대기' : '중복'}
                      extraChips={sourceChips(item, applied, originalStatus(item.key), row!)}
                      {...rowProps}
                      qText={qTextFor(item.competitor.name)}
                      below={restoreFor(row)}
                      action={
                        placed !== undefined && !applied.movedDown.has(item.key)
                          ? { label: '되돌리기', onClick: () => revert(placed) }
                          : row?.status === 'waiting'
                            ? { label: '넣기·빼기', primary: true, onClick: () => toggle(isOpen ? null : { kind: 'wait', key: item.key }), expanded: isOpen }
                            : applied.list.length > 1
                              ? { label: '빼기', onClick: () => push({ t: 'drop', key: item.key }) }
                              : undefined
                      }
                    >
                      {isOpen && (
                        <CompetitorPicker
                          error={pickError}
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
                            // 대기 줄도 목록에서 지울 수 있어야 한다 — 예전엔 「측정에 넣기」만 있어, 자리를 바꿔 대기로
                            // 내려간 곳(2026-10-17 스테이,머뭄의 군산여행의 모든것)을 지울 길이 없었다.
                            {
                              head: '넣지 않고',
                              options:
                                applied.list.length > 1
                                  ? [
                                      {
                                        id: 'drop',
                                        label: '빼기',
                                        sub: '목록에서 지워요 · 대기 줄이라 함께 측정하는 곳은 그대로예요 · 지난 기록은 남아요',
                                        danger: true,
                                        onPick: () => push({ t: 'drop', key: item.key }),
                                      },
                                    ]
                                  : [],
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
              onClick={() => toggle(open?.kind === 'add' ? null : { kind: 'add' })}
            >
              + 경쟁사 추가
            </button>
            {open?.kind === 'add' && (
              <CompetitorPicker
                title="추가할 곳"
                error={pickError}
                note={slotRows.length >= cap ? `${cap}칸이 다 찼어요. 넣으면 대기로 들어가요 — 함께 재려면 줄의 「바꾸기·빼기」를 쓰세요.` : undefined}
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
                    {s.past.map((p) => {
                      // 뺄 수 있는 범위는 지금 코호트에 있는 이 경쟁사의 카드 전체다(최근 12주보다 넓을 수 있다).
                      const first = p.cohortFirstWeekOf ?? p.firstWeekOf
                      const last = p.cohortLastWeekOf ?? p.lastWeekOf
                      const excludedText = p.excluded.length ? rangesText(p.excluded, first) : null
                      // 뺀 범위가 이 코호트 카드를 모두 덮는가 — 일부(그 주만 등)면 남은 주도 뺄 수 있게 체크를 함께 둔다.
                      const fullyOut = p.excluded.some((r) => (!r.fromWeek || r.fromWeek <= first) && r.untilWeek >= last)
                      const lastOut = p.excluded.some((r) => (!r.fromWeek || r.fromWeek <= last) && r.untilWeek >= last)
                      return (
                        <li key={p.tenantId}>
                          <div className="ce-past-line">
                            <b>{p.brandName}</b>
                            {excludedText && <span className="chip">지난 기록에서 뺌 · {excludedText}</span>}
                          </div>
                          <div className="ce-past-meta">
                            지난 기록 {p.weeks}주 · 마지막 {shortWeek(p.lastWeekOf)} {p.lastScore}점
                            {p.cohortWeeks === 0
                              ? ' · 옛 코호트 기록이라 지금 순위표에는 없어요'
                              : excludedText
                                ? fullyOut
                                  ? ' · 지난 순위표에서 빠져 있어요'
                                  : ` · ${excludedText} 순위에서만 빠져 있어요`
                                : ' · 지난 순위표에 남아 있어요'}
                          </div>
                          {excludedText && (
                            <label className="ce-pastbox-opt">
                              <input type="checkbox" checked={restore.includes(p.tenantId)} onChange={(e) => toggleRestore(p.tenantId, e.target.checked)} />
                              다시 세기 — 지난 순위표에 다시 넣어요
                            </label>
                          )}
                          {p.cohortWeeks > 0 && !fullyOut && (
                            <PastBox
                              range={weekRange(first, last)}
                              weeks={p.cohortWeeks}
                              // 고객의 마지막 순위에 남은 카드(같은 주 재측정으로 남은 곳) — 그 주만 뺄 수 있다.
                              onlyWeek={!lastOut && s.baseline && last === s.baseline.weekOf ? last : null}
                              value={pastOut[p.tenantId]}
                              onChange={(v) => setPast(p.tenantId, v)}
                              lockedBy={[]}
                              excluded={[]}
                              firstWeek={first}
                            />
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </section>
            )}

            {(s.edit.active || s.edit.undoAvailable) && !dirty && !savedNow && (
              <div className="ce-edit-state">
                {s.edit.active ? (
                  <span>앱에서 고친 목록을 쓰는 중{s.edit.savedAt ? ` · ${shortDate(s.edit.savedAt)} 저장` : ''}</span>
                ) : (
                  <span>저장소 설정의 목록을 쓰는 중</span>
                )}
                {s.edit.undoAvailable && s.edit.summary && (
                  <button type="button" className="ce-link" disabled={busy} onClick={undo} title={s.edit.summary}>
                    마지막 저장 되돌리기
                  </button>
                )}
                {s.edit.active &&
                  (confirmReset ? (
                    <span className="ce-confirm">
                      저장소 설정({s.edit.repoCompetitors.map((c) => c.name).join(', ')})으로 돌아갈까요?
                      <button type="button" className="ce-link" disabled={busy} onClick={reset}>
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
              {s.questionBank.exists && s.questionBank.measuredVersion && s.questionBank.measuredVersion !== s.questionBank.version
                ? ` (다음 측정부터 · 마지막 측정 ${s.questionBank.measuredVersion})`
                : ''}
              {s.questionBank.exists ? ` · 공통 ${s.questionBank.sharedCount} · 브랜드 ${s.questionBank.brandCount}` : ' · 다음 측정 때 새로 만들어요'}
              <span
                className="ce-hint"
                title={`점수와 순위는 같은 코호트에 똑같이 묻는 공통 질문${s.questionBank.exists ? ` ${s.questionBank.sharedCount}개` : ''}로 매겨요. 비교 질문은 브랜드 질문이에요.`}
              >
                ?
              </span>
            </p>
          </fieldset>
        )}
      </div>

      {s && dirty && (
        <div className="ce-bar" inert={confirmOpen || undefined}>
          <p className="ce-bar-summary">{summary.join(' · ')}</p>
          {planning && <p className="ce-bar-note">{pastInput ? '지난 순위를 다시 세는 중…' : '함께 측정할 곳을 다시 세는 중…'}</p>}
          {exclusion && exclusion.items.length > 0 && <ExclusionPreviewBlock preview={exclusion} brandName={s.brandName} />}
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
          {planned?.unchanged && !pastInput && <p className="ce-bar-note">지금 목록과 같아요.</p>}
          {qplan ? (
            <QuestionPlanBlock
              plan={qplan}
              draft={draft}
              elapsed={draftElapsed}
              open={qOpen}
              onToggle={() => setQOpen(!qOpen)}
              onRedraft={redraft}
              canRedraft={!measuringNow && !busy}
              measuring={measuringNow}
              onRecheck={() => setReplan((n) => n + 1)}
              sharedCount={s.questionBank.sharedCount}
            />
          ) : (
            <p className="ce-bar-q">질문지: {planning ? '계산 중…' : `그대로 (${s.questionBank.version})`}</p>
          )}
          {actionError && (
            <p className="ce-bar-note bad" role="alert">
              {actionError}
            </p>
          )}
          <div className="ce-bar-actions">
            <span className="ce-bar-hint">
              {measuringNow
                ? '측정이 끝난 뒤에 저장할 수 있어요'
                : !questionsReady
                  ? '고쳐 쓴 질문을 확인한 뒤 저장할 수 있어요'
                  : pastInput
                  ? ops.length
                    ? '목록은 다음 측정부터 · 지난 순위는 저장하면 바로 다시 세요'
                    : '저장하면 지난 순위를 바로 다시 세요'
                  : '다음 측정부터 적용돼요'}
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

      {s && savedNow && !dirty && (
        <div className="ce-saved" role="status">
          <b>✓ 저장했어요 · {savedExclusion ? '지난 순위를 다시 셌어요' : '다음 측정부터 적용돼요'}</b>
          {s.edit.summary && <p>{s.edit.summary}</p>}
          {savedExclusion && <p>순위 카드 {savedExclusion.cardsRewritten}장을 다시 계산했어요 · 점수는 그대로예요</p>}
          <p>{savedQuestionText(savedQuestions, s.questionBank.version)}</p>
          {actionError && (
            <p className="ce-bar-note bad" role="alert">
              {actionError}
            </p>
          )}
          <div className="ce-bar-actions">
            {s.edit.undoAvailable && (
              <button type="button" className="btn" onClick={undo} disabled={busy}>
                되돌리기
              </button>
            )}
            <button type="button" className="btn primary" onClick={goMeasure}>
              측정하러 가기
            </button>
          </div>
          <p className="ce-saved-note">
            되돌리기는 다음 측정 전까지만 돼요{savedExclusion ? ' — 그 뒤에는 예전 경쟁사의 「다시 세기」로 되돌려요' : ''}. 「측정하러 가기」는 화면만 옮기고 측정은
            시작하지 않아요. GitHub 측정·웹 화면은 저장소 설정을 따라요{savedExclusion ? ' · 지난 기록 빼기도 이 앱 순위표에만 적용돼요' : ''}.
          </p>
        </div>
      )}

      {s && confirmOpen && exclusion && (
        <div className="ce-dialog-backdrop" onMouseDown={() => !busy && setConfirmKey(null)}>
          <div className="ce-dialog" role="dialog" aria-modal="true" aria-labelledby="ce-dialog-title" onMouseDown={(e) => e.stopPropagation()}>
            <h3 id="ce-dialog-title">{exclusion.items.some((it) => it.action === 'exclude') ? '지난 기록에서도 뺄까요?' : '지난 순위표에 다시 넣을까요?'}</h3>
            <p>{confirmText(exclusion)}</p>
            <ExclusionPreviewBlock preview={exclusion} brandName={s.brandName} compact />
            <p className="ce-dialog-note">
              점수는 그대로예요. 측정 기록은 지우지 않고 순위 계산에서만 {exclusion.items.some((it) => it.action === 'exclude') ? '빼요' : '다시 넣어요'}. 이미 보낸 주간
              보고서와 숫자가 달라질 수 있어요. 이 앱 순위표에서만 바뀌어요 · 웹 화면과 GitHub 측정 순위는 그대로예요.
            </p>
            <div className="ce-bar-actions">
              <button type="button" className="btn" onClick={() => setConfirmKey(null)} disabled={busy}>
                취소
              </button>
              <button type="button" className="btn primary" ref={confirmRef} onClick={doSave} disabled={busy || !canSave}>
                {busy ? '저장 중…' : '다시 계산하고 저장'}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}

/** 뺀 줄의 지난 기록 안내 — 체크에 따라. */
function pastLabel(value: string | undefined): string {
  if (!value) return '지난 기록은 남아요'
  return value === 'all' ? '지난 기록에서도 빼요' : `${shortWeek(value)} 기록만 빼요`
}

/** 「W36~W42」 — 뺀 범위들(fromWeek가 없으면 그 경쟁사의 첫 기록부터). */
function rangesText(ranges: ExcludedRange[], firstWeek: string): string {
  return ranges.map((r) => weekRange(r.fromWeek ?? firstWeek, r.untilWeek)).join(', ')
}

/** 확인 창 첫 문장 — 무엇을 빼고 되살리는지. 서버 미리보기 이름으로 만든다. */
function confirmText(preview: ExclusionPreview): string {
  const out = preview.items.filter((it) => it.action === 'exclude').map((it) => it.brandName)
  const back = preview.items.filter((it) => it.action === 'restore').map((it) => it.brandName)
  const parts: string[] = []
  if (out.length) parts.push(`${subjectParticle(out.join(' · '))} 든 지난 주차 순위를 다시 계산해요.`)
  if (back.length) parts.push(`${objectParticle(back.join(' · '))} 지난 순위표에 다시 넣고 순위를 다시 계산해요.`)
  return parts.join(' ')
}

/** 저장 기록 요약에 붙일 질문지 한 줄 — 새 질문지를 만들 때만. */
function questionSummary(plan: QuestionHandoffPlan | null): string[] {
  if (plan?.mode !== 'derive') return []
  const fixed = plan.items.filter((i) => i.action === 'rewrite').length
  const removed = plan.items.length - fixed
  return [`질문지 ${plan.fromVersion}→${plan.toVersion}${fixed ? ` · 비교 질문 ${fixed}개 고침` : ''}${removed ? ` · ${removed}개 뺌` : ''}`]
}

/** 저장 결과 카드의 질문지 줄. */
function savedQuestionText(plan: QuestionHandoffPlan | null, version: string): string {
  if (plan?.mode === 'derive') {
    const fixed = plan.items.filter((i) => i.action === 'rewrite').length
    const removed = plan.items.length - fixed
    return `질문지 ${plan.fromVersion} → ${plan.toVersion}${fixed ? ` · 비교 질문 ${fixed}개 고침` : ''}${removed ? ` · ${removed}개 뺌` : ''} · 다음 측정부터 써요 · 되돌리면 질문지도 원래대로(${plan.fromVersion}) 돌아가요`
  }
  if (plan?.mode === 'repo') return `질문지: 저장소 질문지(${plan.toVersion})로 돌아갔어요`
  if (plan?.mode === 'fresh') return `질문지(${plan.toVersion})는 다음 측정 때 새 목록으로 만들어요`
  return `질문지: 그대로 (${version})`
}

/**
 * 질문 넘겨받기 — 저장 막대의 질문지 줄과 펼쳐 보는 미리보기(고칠 질문 · 뺄 질문 · 넘겨받지 않는 곳). 고쳐 쓴 문장은 판정 엔진이
 * 쓰고 서버가 검사한 것이다. 저장은 여기 보인 문장 그대로 한다.
 */
function QuestionPlanBlock({
  plan,
  draft,
  elapsed,
  open,
  onToggle,
  onRedraft,
  canRedraft,
  measuring,
  onRecheck,
  sharedCount,
}: {
  plan: QuestionHandoffPlan
  draft: DraftState | undefined
  elapsed: number
  open: boolean
  onToggle: () => void
  /** fresh: 받은 결과를 버리고 다른 표현으로 새로 쓴다. */
  onRedraft: (fresh: boolean) => void
  canRedraft: boolean
  /** 측정 중이라 고쳐 쓰기를 시작하지 않았다 — 끝난 뒤 「다시 확인」으로 계획을 새로 받는다. */
  measuring: boolean
  onRecheck: () => void
  sharedCount: number
}) {
  if (plan.mode === 'same') return <p className="ce-bar-q">질문지: 그대로 ({plan.fromVersion})</p>
  if (plan.mode === 'repo') return <p className="ce-bar-q">질문지: 저장소 질문지({plan.toVersion})로 돌아가요</p>
  if (plan.mode === 'fresh') return <p className="ce-bar-q">질문지({plan.toVersion})는 다음 측정 때 새 목록으로 만들어요</p>
  const fixed = plan.items.filter((i) => i.action === 'rewrite')
  const removed = plan.items.filter((i) => i.action === 'remove')
  const done = draft?.status === 'done' ? draft.value : null
  const failed = done?.failed ?? []
  const head = [
    `질문지 ${plan.fromVersion} → ${plan.toVersion}`,
    fixed.length ? `비교 질문 ${fixed.length}개 바뀜` : null,
    removed.length ? `${removed.length}개 뺌 (${plan.sizeBefore} → ${plan.sizeAfter})` : null,
  ].filter(Boolean)
  const own = plan.unreceived.filter((u) => u.reason === 'receiverHasOwn' && u.own)
  return (
    <div className="ce-qplan">
      <p className="ce-bar-q">
        {head.join(' · ')}{' '}
        <button type="button" className="ce-link" aria-expanded={open} onClick={onToggle}>
          {open ? '접기 ▴' : '보기 ▾'}
        </button>
      </p>
      {draft?.status === 'running' && <p className="ce-bar-note">비교 질문 고쳐 쓰는 중… {clock(elapsed)}</p>}
      {!draft && fixed.length > 0 && measuring && (
        <p className="ce-bar-note">
          측정이 끝나면 비교 질문을 고쳐 써요{' '}
          <button type="button" className="ce-link" onClick={onRecheck}>
            다시 확인
          </button>
        </p>
      )}
      {draft?.status === 'error' && (
        <p className="ce-bar-note bad">
          비교 질문을 고쳐 쓰지 못했어요 — {draft.message}{' '}
          <button type="button" className="ce-link" onClick={() => onRedraft(false)} disabled={!canRedraft}>
            다시 쓰기
          </button>
        </p>
      )}
      {failed.length > 0 && !open && <p className="ce-bar-note bad">고쳐 쓰지 못한 질문 {failed.length}개 — 「보기」에서 이유를 보고 다시 써 주세요</p>}
      {open && (
        <div className="ce-qplan-body">
          <ul className="ce-qplan-list">
            {plan.items.map((item) => {
              const d = done?.drafts.find((x) => x.fromId === item.fromId)
              const f = failed.find((x) => x.fromId === item.fromId)
              const keep = item.keep.length ? ` · ${item.keep.map((k) => k.name).join(', ')} 그대로` : ''
              return (
                <li key={item.fromId} className={`ce-qplan-item${item.action === 'remove' ? ' removed' : ''}`}>
                  <p className="ce-qplan-head">
                    {item.action === 'rewrite'
                      ? `${item.fromId} → ${item.toId} · ${item.swaps.map((sw) => `${sw.from.name} → ${sw.to?.name ?? ''}`).join(', ')}${keep}`
                      : `${item.fromId} 뺌 · ${item.swaps.map((sw) => sw.from.name).join(', ')} — 넘겨받을 곳이 없어요`}
                  </p>
                  <p className="ce-qplan-old">{item.source.text}</p>
                  {item.action === 'rewrite' &&
                    (d ? (
                      <>
                        <p className="ce-qplan-new">{d.text}</p>
                        {item.topicNeedsRewrite && (
                          <p className="ce-qplan-topic">
                            주제: {item.source.topic} → {d.topic ?? '미분류'}
                          </p>
                        )}
                      </>
                    ) : f ? (
                      <p className="ce-bar-note bad">고쳐 쓰지 못했어요 — {f.reasons.join(' · ')}</p>
                    ) : (
                      <p className="ce-qplan-wait">
                        {draft?.status === 'error'
                          ? '고쳐 쓰지 못했어요'
                          : draft?.status === 'running'
                            ? '고쳐 쓰는 중…'
                            : measuring
                              ? '측정이 끝나면 고쳐 써요'
                              : '고쳐 쓰기를 기다리는 중…'}
                      </p>
                    ))}
                </li>
              )
            })}
          </ul>
          {own.map((u) => (
            <p key={u.name} className="ce-bar-note">
              {topicParticle(u.own!.name)} 이미 비교 질문({u.own!.questionIds.join(' · ')})이 있어 {u.name}의 질문을 넘겨받지 않아요
            </p>
          ))}
          <p className="ce-qplan-note">
            저장하면 다음 측정 주는 질문지가 바뀌어 전주 대비 증감을 보이지 않아요 · 점수 · 순위는 공통 질문 {sharedCount}개로 매겨요
          </p>
          {fixed.length > 0 && done && (
            <button type="button" className="ce-link" onClick={() => onRedraft(true)} disabled={!canRedraft}>
              다시 쓰기
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * 지난 순위 미리보기 — 이 고객의 주차별 순위(지금 → 바뀐 뒤), 다시 쓸 카드 수, 함께 바뀌는 다른 고객, 잠김. 모두 서버가 저장과
 * 같은 계산으로 낸 값이다.
 */
function ExclusionPreviewBlock({ preview, brandName, compact = false }: { preview: ExclusionPreview; brandName: string; compact?: boolean }) {
  return (
    <div className="ce-preview">
      <p className="ce-preview-head">
        {brandName} 지난 순위 <span>· 점수는 그대로, 순위만 다시 셉니다</span>
      </p>
      {preview.weeks.length ? (
        <ul>
          {preview.weeks.map((w) => (
            <li key={w.weekOf}>
              <span className="ce-preview-week">{shortWeek(w.weekOf)}</span>
              {w.before ? rankText(w.before) : '—'} → <b>{rankText(w.after)}</b>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ce-preview-none">{brandName} 순위는 바뀌지 않아요.</p>
      )}
      {!compact && <p className="ce-preview-meta">순위 카드 {preview.cardsRewritten}장을 다시 계산해요 · 이미 보낸 주간 보고서와 숫자가 달라질 수 있어요.</p>}
      {preview.otherCustomers.map((o) => (
        <p key={o.brandName} className="ce-bar-note warn">
          다른 고객 {o.brandName}의 지난 순위도 {o.weeks}주 바뀌어요.
        </p>
      ))}
      {preview.locked.map((l) => (
        <p key={l.tenantId} className="ce-bar-note bad">
          {l.brandName}: {l.by.join(', ')}도 이 경쟁사를 재고 있어 지난 기록에서 뺄 수 없어요.
        </p>
      ))}
    </div>
  )
}

/**
 * 「지난 기록에서도 빼기」 체크 — 기본은 꺼짐(지난 기록은 남는다). 그 주만 뺄 수 있으면(같은 주 재측정으로 남은 카드) 둘째 체크를
 * 둔다. 다른 고객이 함께 재는 경쟁사는 잠근다(그 고객의 순위표에 든다).
 */
function PastBox({
  range,
  weeks,
  onlyWeek,
  value,
  onChange,
  lockedBy,
  excluded,
  firstWeek,
}: {
  range: string
  weeks: number
  onlyWeek: string | null
  value: string | undefined
  onChange: (value: string | undefined) => void
  lockedBy: string[]
  excluded: ExcludedRange[]
  firstWeek: string
}) {
  if (lockedBy.length) {
    return <span className="ce-pastbox-lock">{lockedBy.join(', ')}도 이 경쟁사를 재고 있어 지난 기록에서 뺄 수 없어요</span>
  }
  return (
    <span className="ce-pastbox">
      {excluded.length > 0 && <span className="ce-pastbox-note">이미 지난 기록에서 뺌 · {rangesText(excluded, firstWeek)}</span>}
      <label className="ce-pastbox-opt">
        <input type="checkbox" checked={value === 'all'} onChange={(e) => onChange(e.target.checked ? 'all' : undefined)} />
        지난 기록에서도 빼기 ({range} · {weeks}주)
      </label>
      {onlyWeek && (
        <label className="ce-pastbox-opt">
          <input type="checkbox" checked={value === onlyWeek} onChange={(e) => onChange(e.target.checked ? onlyWeek : undefined)} />
          {shortWeek(onlyWeek)} 기록만 빼기
        </label>
      )}
    </span>
  )
}

/** 이번 편집에서 생긴 표시 — 다시 넣음 · 새로 · 주소 바뀜 · 측정에 들어감 · 대기로 내려감. */
function sourceChips(
  item: EditItem,
  applied: Pick<AppliedEdit, 'replaced' | 'movedDown' | 'rehomed'>,
  originalStatus: string | undefined,
  row: EditorCompetitorRow,
): { text: string; tone: string; title?: string }[] {
  const { replaced, movedDown, rehomed } = applied
  const before = rehomed.get(item.key)
  if (before) {
    const was = before.map(displayHost).join(', ') || '없음'
    const now = item.competitor.domains.map(displayHost).join(', ') || '없음'
    return [{ text: '주소 바뀜', tone: 'info', title: `${was} → ${now}` }]
  }
  if (item.source === 'past' && row.cohortWeeks > 0) return [{ text: '다시 넣음', tone: 'info', title: `지난 기록 ${row.cohortWeeks}주를 이어요` }]
  if (item.source) return [{ text: '새로', tone: 'info' }]
  if (movedDown.has(item.key) && row.status === 'waiting') return [{ text: '대기로 내려감', tone: '', title: '지우지 않았어요 · 측정하지 않을 뿐이에요' }]
  if (originalStatus && originalStatus !== 'measured' && row.status === 'measured') return [{ text: '측정에 들어감', tone: 'good' }]
  if (replaced.has(item.key) && row.status === 'measured') return [{ text: '측정에 들어감', tone: 'good' }]
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
  qText,
  action,
  below,
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
  /** 「비교 질문」 칸을 넘겨받기 계획으로 바꿔 보인다(「v6-004 받음」 · 「v5-004 → 새 곳」). */
  qText?: string
  action?: { label: string; onClick: () => void; primary?: boolean; expanded?: boolean }
  /** 이름 아래 한 줄(「지난 기록 다시 세기」). */
  below?: React.ReactNode
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
  if (r.excluded.length) {
    chips.push({
      text: '지난 기록 일부 뺌',
      tone: '',
      title: `${rangesText(r.excluded, r.cohortFirstWeekOf ?? r.excluded[0]!.untilWeek)} 순위에서는 빠져 있어요 · 다시 잰 주부터는 저절로 세요`,
    })
  }
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
        {below}
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
      <span className={`ce-q${qText || r.questionIds.length ? '' : ' none'}`}>{qText ?? (r.questionIds.length ? r.questionIds.join(' · ') : '비교 질문 없음')}</span>
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
