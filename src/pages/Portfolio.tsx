import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useNavigationType, useSearchParams } from 'react-router-dom'
import CompetitorEditor from '../components/CompetitorEditor'
import ProfileEditor from '../components/ProfileEditor'
import EmptyBrands from '../components/EmptyBrands'
import RowMenu, { type RowMenuItem } from '../components/RowMenu'
import { useTenant } from '../context/useTenant'
import { loadPortfolio, type CohortMember, type Portfolio as PortfolioData, type PortfolioCohort, type PortfolioRow } from '../lib/api'
import { groupColor, groupOrder, industryGroupOf } from '../lib/industryGroups'
import { directionParticle } from '../lib/korean'
import { runName, useMeasureStatus } from '../lib/measureStatus'
import {
  barWidth,
  changeLine,
  cohortKey,
  customerForCompetitorRow,
  groupCohorts,
  isCurrentCustomer,
  parseView,
  passFilter,
  refReason,
  rowChips,
  showMeasure,
  sortCohorts,
  summarize,
  unmeasuredCohorts,
  viewParams,
  type PfFilter,
  type PfSort,
  type PortfolioViewState,
} from '../lib/portfolioView'

const SHOW_COMPETITORS_KEY = 'portfolio.showCompetitors'
/** 거르개 · 검색 · 정렬(주소의 ?f=…) — 사이드바로 다시 들어와도 이어지게 이 창에 기억한다. */
const VIEW_KEY = 'portfolio.view'
const FOLD_KEY = (group: string) => `portfolio.fold.${group}`

function readShowCompetitors(): boolean {
  try {
    return localStorage.getItem(SHOW_COMPETITORS_KEY) !== '0'
  } catch {
    return true // 저장소를 못 읽으면 기본(켬)
  }
}
function writeShowCompetitors(on: boolean) {
  try {
    localStorage.setItem(SHOW_COMPETITORS_KEY, on ? '1' : '0')
  } catch {
    /* 기억 못 해도 동작에는 영향 없음 */
  }
}
function readFolds(): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (key?.startsWith(FOLD_KEY(''))) out[key.slice(FOLD_KEY('').length)] = localStorage.getItem(key) === '1'
    }
  } catch {
    /* 못 읽으면 모두 펼친 채로 */
  }
  return out
}
function writeFold(group: string, folded: boolean) {
  try {
    localStorage.setItem(FOLD_KEY(group), folded ? '1' : '0')
  } catch {
    /* 기억 못 해도 이번에는 접힌다 */
  }
}
function readSavedView(): string {
  try {
    return sessionStorage.getItem(VIEW_KEY) ?? ''
  } catch {
    return ''
  }
}
function writeSavedView(search: string) {
  try {
    sessionStorage.setItem(VIEW_KEY, search)
  } catch {
    /* 기억 못 해도 지금 주소는 그대로 */
  }
}

const shortWeek = (weekOf: string) => weekOf.replace(/^\d{4}-/, '')
const pct = (v: number) => `${(v * 100).toFixed(1)}%`
/**
 * 브랜드 현황 — 등록한 고객 브랜드를 업종군 → 비교 그룹(업종 · 지역 · 주차) → 브랜드로 한눈에(server/portfolio.ts).
 *
 * 브랜드가 30곳을 넘자 드롭다운에서 찾기 어려웠고, 어느 비교 그룹이 측정이 필요한지 볼 곳이 없었다. 줄을
 * 누르면 그 브랜드로 바꾸고 개요로 간다 — 드롭다운의 일을 넓힌 화면이다. 데스크톱 앱 전용(웹에는 이
 * 라우트가 없다).
 *
 * 비교 그룹 카드는 미니 리더보드다(상용화 UI 6차 시안) — 같은 주 · 같은 질문지로 잰 구성원을 경쟁사까지 점수
 * 순서로 놓는다. 「경쟁사 함께 보기」를 끄면 고객 브랜드만 남는다(이 PC에 기억). 요약 타일 · 업종군 칩은 고객 브랜드 기준으로
 * 카드를 고르고, 검색은 경쟁사 이름도 찾는다. 고객 브랜드라도 그 뒤 주차에 다시 쟀으면 그 카드는 지난 기록이라 표시만 하고 세지 않는다.
 *
 * 상용화 UI 3차(U18 · U19 · U32a · U12 · U14): 요약 타일은 서로 겹치지 않게(완료 · 측정 남음 · 순위 비교 안 됨 · 경쟁사 없이), 줄마다
 * 상태 칩(나이와 비교 문제를 따로) · ⋯ 메뉴 · 「측정」, 열 머리 · 100점 막대, 정렬 · 업종군 접기, 거르개를 주소에 두어 줄을 열었다
 * 돌아와도 그대로, 사이드바에서 고른 브랜드에 「선택됨」.
 */
export default function Portfolio() {
  const navigate = useNavigate()
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const view = parseView(params)
  const { tenants, setTenantId, viewCompetitor, viewing, customer, reloadTenants } = useTenant()
  const measure = useMeasureStatus()
  const [state, setState] = useState<{ loaded: boolean; value: PortfolioData | null }>({ loaded: false, value: null })
  // 경쟁사 편집 · 기본 정보를 저장하면, 측정이 끝나면 다시 읽는다 — 줄의 칩이 저장한 값 · 새 측정을 따르게.
  const [reloadKey, setReloadKey] = useState(0)
  useEffect(() => {
    let alive = true
    void loadPortfolio().then((value) => {
      if (alive) setState({ loaded: true, value })
    })
    return () => {
      alive = false
    }
  }, [reloadKey, measure.doneEpoch])
  const afterCompetitorSave = () => {
    setReloadKey((k) => k + 1)
    reloadTenants().catch((err: unknown) => console.error('[Portfolio] 브랜드 목록을 다시 읽지 못했습니다', err))
  }

  // 보기 상태(거르개 · 업종군 · 검색 · 정렬)는 주소에 둔다 — 줄을 열었다 뒤로 와도 그대로. 바꿀 때는 이동 기록을 쌓지 않고
  // 스크롤도 그대로 둔다(Layout keepScroll).
  const setView = (patch: Partial<PortfolioViewState>) => {
    setParams((prev) => viewParams({ ...parseView(prev), ...patch }), { replace: true, state: { keepScroll: true } })
  }
  // 사이드바 · 명령 창으로 들어와 주소가 비면(이미 이 화면에 있을 때도) 이 창에서 마지막으로 본 보기로 연다. 뒤로 · 앞으로(POP)는 그
  // 기록의 주소 그대로 둔다 — 덮어쓰면 그 자리의 스크롤 복원도 끊긴다. 거르기를 다 풀면(replace) 빈 보기를 기억한다.
  const navigationType = useNavigationType()
  useEffect(() => {
    if (location.search === '' && navigationType === 'PUSH') {
      const saved = readSavedView()
      if (saved) {
        setParams(new URLSearchParams(saved), { replace: true, state: { ...((location.state as object | null) ?? {}), keepScroll: true } })
        return
      }
    }
    writeSavedView(location.search)
  }, [location.key, location.search, location.state, navigationType, setParams])

  // 검색 칸 — 글자는 화면 안에서 바로 바꾸고 주소는 잠깐 뒤에 적는다. 칸을 주소에 직접 묶었더니 글자가 빠지고 커서가 튀며 한글
  // 조합이 끊겼다. 주소가 밖에서 바뀌면(되살린 보기 · 거르기 풀기) 칸도 따른다.
  const [qInput, setQInput] = useState(view.q)
  const [syncedQ, setSyncedQ] = useState(view.q)
  // 친 글자가 아직 주소에 반영되지 않았다 — 주소 갱신은 전환(transition)이라 늦게 들어온다. 그동안 들어오는 옛 주소 값으로 칸을 덮지
  // 않고, 친 값이 주소에 들어오면 끝난다.
  const [typing, setTyping] = useState(false)
  if (view.q !== syncedQ) {
    setSyncedQ(view.q)
    if (view.q === qInput) setTyping(false)
    else if (!typing) setQInput(view.q)
  }
  const qTimer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (qTimer.current) window.clearTimeout(qTimer.current)
    },
    [],
  )
  const onQuery = (value: string, composing: boolean) => {
    setQInput(value)
    setTyping(true)
    if (qTimer.current) window.clearTimeout(qTimer.current)
    if (composing) return
    qTimer.current = window.setTimeout(() => {
      // 주소에 이미 같은 값이면(지웠다 같은 글자를 다시 침) 바뀔 것이 없다 — 치는 중을 바로 끝낸다.
      if ((new URLSearchParams(window.location.search).get('q') ?? '') === value) setTyping(false)
      else setView({ q: value })
    }, 250)
  }
  const clearFilters = () => {
    if (qTimer.current) window.clearTimeout(qTimer.current)
    setTyping(false)
    setQInput('')
    setView({ f: '', g: '', q: '' })
  }

  const [showCompetitors, setShowCompetitors] = useState(readShowCompetitors)
  const [folds, setFolds] = useState(readFolds)
  const rows = useMemo(() => state.value?.rows ?? [], [state.value])
  const rowById = useMemo(() => new Map(rows.map((r) => [r.tenantId, r])), [rows])
  const allCohorts = useMemo(() => [...(state.value?.cohorts ?? []), ...unmeasuredCohorts(rows)], [state.value, rows])
  const sum = summarize(rows)
  const groupsAll = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of rows) m.set(industryGroupOf(r.industry), (m.get(industryGroupOf(r.industry)) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => groupOrder(a[0]) - groupOrder(b[0]))
  }, [rows])
  const cohortTotal = allCohorts.filter((c) => c.members.some(isCurrentCustomer)).length

  const visible = useMemo(() => {
    const q = qInput.trim().toLowerCase()
    return allCohorts.filter((c) => {
      if (view.g && industryGroupOf(c.industry) !== view.g) return false
      const passes = c.members.filter(isCurrentCustomer).some((m) => {
        const r = rowById.get(m.tenantId)
        return r ? passFilter(r, view.f) : false
      })
      if (!passes) return false
      return !q || `${c.industry} ${c.region} ${c.members.map((m) => m.brandName).join(' ')}`.toLowerCase().includes(q)
    })
  }, [allCohorts, rowById, view.f, view.g, qInput])
  const grouped = useMemo(() => groupCohorts(visible), [visible])
  const flat = useMemo(() => (view.sort ? sortCohorts(visible, rowById, view.sort) : []), [visible, rowById, view.sort])
  // 검색 중에는 접기를 무시한다 — 찾은 브랜드가 접힌 묶음에 숨지 않게(접기 단추도 잠근다).
  const searching = qInput.trim() !== ''
  const isFolded = (group: string) => !searching && (folds[group] ?? false)
  const toggleFold = (group: string, folded: boolean) => {
    writeFold(group, folded)
    setFolds((f) => ({ ...f, [group]: folded }))
  }
  const anyOpen = grouped.some((g) => !isFolded(g.name))
  const setAllFolds = (folded: boolean) => {
    for (const g of grouped) writeFold(g.name, folded)
    setFolds((f) => ({ ...f, ...Object.fromEntries(grouped.map((g) => [g.name, folded])) }))
  }

  // 경쟁사 편집 · 기본 정보 서랍에 저장하지 않은 바꾼 내용이 있으면, 다른 브랜드로 바꾸거나 이 화면을 떠나기 전에 묻는다.
  const editorDirty = useRef(false)
  const onEditorDirty = useCallback((dirty: boolean) => {
    editorDirty.current = dirty
  }, [])
  const leaveEditor = () => !editorDirty.current || window.confirm('바꾼 내용을 저장하지 않고 나갈까요?')

  const open = (tenantId: string) => {
    if (!leaveEditor()) return
    setTenantId(tenantId)
    navigate('/')
  }
  const [viewError, setViewError] = useState<string | null>(null)
  /**
   * 경쟁사 줄 — 그 경쟁사를 읽기 전용으로 연다(상용화 UI 10차 시안). 고객 브랜드는 그 줄이 든 비교 그룹 카드의 고객으로
   * 맞춘다 — 그래야 「고객과 비교」와 「돌아가기」가 같은 비교 그룹을 가리킨다(customerForCompetitorRow 주석).
   */
  const openCompetitor = (tenantId: string, cohort: PortfolioCohort) => {
    if (!leaveEditor()) return
    setViewError(null)
    const target = customerForCompetitorRow(cohort, customer?.tenantId)
    if (target && target !== customer?.tenantId) setTenantId(target)
    viewCompetitor(tenantId)
      .then(() => navigate('/'))
      .catch((e: unknown) => setViewError(e instanceof Error ? e.message : String(e)))
  }

  // 경쟁사 편집 서랍(상용화 UI 11차). 명령 창에서 오면 location.state로 연다 — 이 화면에 머문 채 다시 와도
  // 열리게 이동(location.key)마다 한 번 본다.
  const requested = (location.state as { editCompetitors?: string } | null)?.editCompetitors ?? null
  const [editing, setEditing] = useState<string | null>(requested)
  // 기본 정보 서랍 — 경쟁사 편집 서랍과 같은 자리(오른쪽)에 뜨므로 한 번에 하나만 연다.
  const [profiling, setProfiling] = useState<string | null>(null)
  const [seenKey, setSeenKey] = useState(location.key)
  if (location.key !== seenKey) {
    setSeenKey(location.key)
    if (requested) {
      setEditing(requested)
      // 명령 창에서 경쟁사 편집을 열면 기본 정보 서랍은 닫는다 — 남겨 두면 경쟁사 서랍을 닫을 때 다시 나타난다.
      setProfiling(null)
    }
  }
  // 서랍을 연 단추(줄의 칩 · ⋯) — 서랍을 닫으면 초점을 거기로 돌린다(그대로 두면 body로 빠져 키보드로 이어 갈 수 없었다).
  const editorOpener = useRef<HTMLElement | null>(null)
  const rememberOpener = () => {
    const el = document.activeElement
    editorOpener.current = el instanceof HTMLElement && el !== document.body ? el : null
  }
  const returnFocus = () => {
    const el = editorOpener.current
    editorOpener.current = null
    if (el) window.setTimeout(() => el.isConnected && el.focus({ preventScroll: true }), 0)
  }
  const dropEditorRequest = () => {
    // 새로 고침·뒤로 가기에서 다시 열리지 않게 이동 기록의 요청을 지운다(보기 상태 · 스크롤은 그대로).
    if (requested) navigate({ pathname: location.pathname, search: location.search }, { replace: true, state: { keepScroll: true } })
  }
  const closeEditor = () => {
    setEditing(null)
    dropEditorRequest()
    returnFocus()
  }
  const closeProfile = () => {
    setProfiling(null)
    returnFocus()
  }
  const openProfile = (id: string) => {
    if ((id !== profiling || editing) && !leaveEditor()) return
    if (editing) {
      setEditing(null)
      dropEditorRequest()
    }
    rememberOpener()
    setProfiling(id)
  }
  const openCompetitorEditor = (id: string) => {
    if ((id !== editing || profiling) && !leaveEditor()) return
    setProfiling(null)
    rememberOpener()
    setEditing(id)
  }
  /** 줄의 「측정」 — 바로 재지 않고 측정 화면에서 함께 잴 경쟁사 · 방식을 확인하고 시작한다. */
  const startMeasure = (id: string) => {
    if (!leaveEditor()) return
    setEditing(null)
    setProfiling(null)
    setTenantId(id)
    navigate('/measure-tenant', { state: { pick: id } })
  }

  // 지금 재는 중 — 앱은 한 번에 하나씩 잰다. 그 측정에 든 브랜드(경쟁사로 함께 재는 고객 포함)는 「측정 중」 칩, 나머지는 「측정」을 잠근다.
  // 진행 줄(active)은 파이프라인 구간에만 있다 — 경쟁사를 고르거나 순위를 다시 매기는 동안에도 그 회차의 브랜드는 「측정 중」이다.
  const measuringIds = new Set([...measure.active.map((a) => a.tenantId), ...(measure.runs?.current ?? []).map((r) => r.tenantId)])
  const root = measure.runs?.current[0] ?? null
  const busy = root !== null || measure.active.length > 0
  const busyId = root?.tenantId ?? measure.active[0]?.tenantId ?? null
  const busyName = root ? runName(root, tenants) : (measure.active[0]?.brandName ?? '')
  const busyNote = `${busyName} 측정 중이에요 — 앱은 한 번에 하나씩 잽니다. 끝나면 측정할 수 있어요.`
  const stageOf = (id: string) => measure.active.find((a) => a.tenantId === id)?.stage ?? '준비'

  const locked = Boolean(viewing)
  const lockedNote = '고객 브랜드에서만 바꿀 수 있어요(경쟁사 보기 중)'
  const rowActions: RowActions = {
    open,
    openCompetitor,
    editCompetitors: openCompetitorEditor,
    editProfile: openProfile,
    measure: startMeasure,
    locked,
    lockedNote,
    busy,
    busyId,
    busyNote,
    measuringIds,
    stageOf,
  }

  // 「선택됨 · 스테이,머뭄으로 가기」 — 사이드바에서 고른 고객 브랜드의 줄로 옮긴다(접힌 업종군이면 편다).
  const selectedId = customer?.tenantId ?? null
  const selectedVisible = selectedId !== null && visible.some((c) => c.members.some((m) => isCurrentCustomer(m) && m.tenantId === selectedId))
  // 누를 때의 대상으로만 옮긴다 — 나중에 사이드바에서 브랜드를 바꿔도 화면이 따라 움직이지 않게.
  const [jumpTo, setJumpTo] = useState<{ id: string; n: number } | null>(null)
  const jump = () => {
    if (!selectedId) return
    const row = rowById.get(selectedId)
    if (row && !view.sort && isFolded(industryGroupOf(row.industry))) toggleFold(industryGroupOf(row.industry), false)
    setJumpTo((j) => ({ id: selectedId, n: (j?.n ?? 0) + 1 }))
  }
  useEffect(() => {
    if (!jumpTo) return
    const el = document.getElementById(`pf-row-${jumpTo.id}`)
    if (!el) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
    el.querySelector<HTMLElement>('.pf-lb-open')?.focus({ preventScroll: true })
  }, [jumpTo])

  const oldestText = [
    sum.oldest ? `가장 오래된 ${shortWeek(sum.oldest.weekOf)}${sum.oldest.weeks !== null ? ` · ${sum.oldest.weeks}주 전` : ''}` : '',
    sum.none ? `측정 전 ${sum.none}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
  const tiles: { key: PfFilter; label: string; value: number; sub: string; tone: string; title?: string; hidden?: boolean }[] = [
    { key: '', label: '고객 브랜드', value: sum.all, sub: `업종군 ${groupsAll.length}개 · 비교 그룹(코호트) ${cohortTotal}개`, tone: '' },
    {
      key: 'done',
      label: '이번 주 완료',
      value: sum.done,
      sub: `${state.value ? shortWeek(state.value.currentWeek) : ''} · 같은 질문지로 측정`,
      tone: sum.done > 0 ? 'good' : '',
    },
    { key: 'todo', label: '이번 주 측정 남음', value: sum.todo, sub: oldestText || '남은 브랜드 없음', tone: '' },
    {
      key: 'mismatch',
      label: '순위 비교 안 됨',
      value: sum.mismatch,
      sub: `질문지 다름 ${sum.diff} · 기록 없음 ${sum.unknown}`,
      tone: sum.mismatch > 0 ? 'warn' : '',
      title: '다른 질문지로 쟀거나 질문지 기록이 없어 순위를 견줄 수 없는 브랜드입니다. 경쟁사와 함께 다시 측정하면 맞춰집니다.',
    },
    {
      key: 'alone',
      label: '경쟁사 없이 측정',
      value: sum.alone,
      sub: '비교 그룹 순위 없음',
      tone: sum.alone > 0 ? 'info' : '',
      hidden: sum.alone === 0 && view.f !== 'alone',
    },
  ]

  const cohortCard = (c: PortfolioCohort, groupLabel: string | null) => {
    const members = c.members.filter((m) => showCompetitors || isCurrentCustomer(m))
    const ref = refReason(c, rowById)
    return (
      <div
        key={cohortKey(c)}
        className={`pf-cohort${ref ? ' is-ref' : ''}`}
        role="rowgroup"
        style={groupLabel ? ({ '--grp': groupColor(groupLabel) } as React.CSSProperties) : undefined}
      >
        <div className="pf-cohort-head" role="row">
          <span className="pf-cohort-cell" role="cell" aria-colspan={7}>
            {groupLabel && (
              <span className="pf-cohort-group">
                <span className="grp-dot" aria-hidden="true" />
                {groupLabel}
              </span>
            )}
            <span className="pf-cohort-label">
              {c.industry} · {c.region}
            </span>
            <span className="dash-sub">{c.weekOf ? `비교 그룹 ${c.members.length}곳 · ${shortWeek(c.weekOf)} 측정` : '측정 전'}</span>
            {ref && (
              <span className="pf-cohort-note">
                {ref === 'diff' ? '* 질문지가 달라 이 순위는 참고용' : '* 질문지 기록이 없어 이 순위는 참고용'}
              </span>
            )}
          </span>
        </div>
        {members.map((m) => (
          <LeaderRow
            key={m.tenantId}
            m={m}
            row={rowById.get(m.tenantId)}
            total={c.members.length}
            measured={Boolean(c.weekOf)}
            refRank={ref !== null}
            selected={isCurrentCustomer(m) && m.tenantId === selectedId}
            watching={viewing?.tenantId === m.tenantId}
            actions={rowActions}
            cohort={c}
          />
        ))}
      </div>
    )
  }

  return (
    <>
      <header className="page-head">
        <div className="page-title">
          <p className="page-eyebrow">전체 브랜드</p>
          <h1>브랜드 현황</h1>
        </div>
        <div className="page-actions">
          <label className="pf-search">
            <span className="sr-only">브랜드·업종 찾기</span>
            <input
              type="search"
              placeholder="브랜드·업종·지역 찾기"
              value={qInput}
              onChange={(e) => onQuery(e.target.value, (e.nativeEvent as InputEvent).isComposing)}
              onCompositionEnd={(e) => onQuery(e.currentTarget.value, false)}
            />
          </label>
        </div>
      </header>
      {viewError && (
        <p className="error" role="alert">
          {viewError}
        </p>
      )}
      <p className="page-lead">
        등록한 고객 브랜드를 업종별로 모았습니다. 비교 그룹(코호트)은 같은 업종 · 지역에서 같은 주에 함께 잰 브랜드 묶음입니다. 그 안의
        순위와 마지막 측정을 보이고, 줄을 누르면 그 브랜드의 개요로 갑니다.
      </p>

      {!state.loaded && <PortfolioSkeleton />}
      {state.loaded && state.value === null && (
        <p className="muted">브랜드 현황은 데스크톱 앱에서 볼 수 있습니다(웹에는 이 기능이 없습니다).</p>
      )}

      {/* 데스크톱 앱은 켤 때 이 화면에서 시작한다 — 브랜드가 없으면 첫 등록 안내를 보인다. */}
      {state.value && state.value.rows.length === 0 && <EmptyBrands />}

      {state.value && state.value.rows.length > 0 && (
        <>
          <section className="pf-summary" aria-label="요약">
            {tiles
              .filter((t) => !t.hidden)
              .map((t) => (
                <button
                  key={t.key || 'all'}
                  type="button"
                  className={`pf-sum${view.f === t.key ? ' on' : ''}${t.tone ? ` ${t.tone}` : ''}`}
                  aria-pressed={view.f === t.key}
                  title={t.title}
                  onClick={() => setView({ f: view.f === t.key ? '' : t.key })}
                >
                  <span className="pf-sum-label">{t.label}</span>
                  <span className="pf-sum-value">{t.value}</span>
                  <span className="pf-sum-sub">{t.sub}</span>
                </button>
              ))}
          </section>

          <div className="pf-toolbar">
            <div className="pf-chips" role="group" aria-label="업종군">
              {[['', sum.all] as [string, number], ...groupsAll].map(([name, n]) => (
                <button
                  key={name || 'all'}
                  type="button"
                  className={`pf-chip${view.g === name ? ' on' : ''}`}
                  aria-pressed={view.g === name}
                  onClick={() => setView({ g: name })}
                >
                  {name && <span className="grp-dot" style={{ '--grp': groupColor(name) } as React.CSSProperties} aria-hidden="true" />}
                  {name || '전체'} <span className="pf-chip-n">{n}</span>
                </button>
              ))}
            </div>
            <div className="pf-tools">
              {selectedVisible && customer && (
                <button type="button" className="ghost pf-jump" onClick={jump}>
                  선택됨 · {directionParticle(customer.brandName)} 가기
                </button>
              )}
              {!view.sort && grouped.length > 1 && !searching && (
                <button type="button" className="ghost pf-fold-all" onClick={() => setAllFolds(anyOpen)}>
                  {anyOpen ? '모두 접기' : '모두 펴기'}
                </button>
              )}
              <label className="pf-sort">
                정렬
                <select value={view.sort} onChange={(e) => setView({ sort: e.target.value as PfSort })}>
                  <option value="">기본(업종군별)</option>
                  <option value="oldest">오래된 측정부터</option>
                  <option value="score">점수 높은 순</option>
                  <option value="name">이름 순</option>
                </select>
              </label>
              <button
                type="button"
                className={`pf-switch${showCompetitors ? ' on' : ''}`}
                role="switch"
                aria-checked={showCompetitors}
                onClick={() => {
                  writeShowCompetitors(!showCompetitors)
                  setShowCompetitors(!showCompetitors)
                }}
              >
                <span className="pf-switch-track" aria-hidden="true">
                  <span className="pf-switch-knob" />
                </span>
                경쟁사 함께 보기
              </button>
            </div>
          </div>

          {visible.length === 0 && (
            <p className="muted pf-empty">
              거르개에 맞는 브랜드가 없습니다.{' '}
              <button type="button" className="ghost" onClick={clearFilters}>
                거르기 풀기
              </button>
            </p>
          )}

          {view.sort
            ? flat.length > 0 && (
                <div className="pf-card pf-card-flat" role="table" aria-label="비교 그룹">
                  <ColumnHead />
                  {flat.map((c) => cohortCard(c, industryGroupOf(c.industry)))}
                </div>
              )
            : grouped.map((g, i) => {
                const folded = isFolded(g.name)
                const groupRows = g.cohorts.flatMap((c) =>
                  c.members.filter(isCurrentCustomer).flatMap((m) => {
                    const r = rowById.get(m.tenantId)
                    return r ? [r] : []
                  }),
                )
                const digest = summarize(groupRows)
                return (
                  <section key={g.name} className="pf-group" aria-label={g.name} style={{ '--grp': groupColor(g.name) } as React.CSSProperties}>
                    <h2 className="pf-group-title">
                      <button
                        type="button"
                        className="pf-group-toggle"
                        aria-expanded={!folded}
                        aria-controls={folded ? undefined : `pf-g-${i}`}
                        disabled={searching}
                        title={searching ? '검색 중에는 찾은 브랜드가 숨지 않게 모두 펼쳐 둡니다' : undefined}
                        onClick={() => toggleFold(g.name, !folded)}
                      >
                        <span className={`chev${folded ? '' : ' open'}`} aria-hidden="true" />
                        <span className="grp-mark" aria-hidden="true" />
                        <span className="pf-group-name">{g.name}</span>
                      </button>
                      <span className="dash-sub">
                        고객 브랜드 {groupRows.length}곳 · 비교 그룹 {g.cohorts.length}개
                      </span>
                      {folded && (
                        <span className="pf-group-digest">
                          완료 {digest.done} · 측정 남음 {digest.todo} · 순위 비교 안 됨 {digest.mismatch}
                        </span>
                      )}
                    </h2>
                    {!folded && (
                      <div className="pf-card" id={`pf-g-${i}`} role="table" aria-label={g.name}>
                        <ColumnHead />
                        {g.cohorts.map((c) => cohortCard(c, null))}
                      </div>
                    )}
                  </section>
                )
              })}
        </>
      )}
      {editing && !viewing && state.value && (
        <CompetitorEditor key={editing} tenantId={editing} onClose={closeEditor} onSaved={afterCompetitorSave} onDirtyChange={onEditorDirty} />
      )}
      {profiling && !editing && !viewing && state.value && (
        <ProfileEditor key={profiling} tenantId={profiling} onClose={closeProfile} onSaved={afterCompetitorSave} onDirtyChange={onEditorDirty} />
      )}
    </>
  )
}

/** 첫 로드 동안의 뼈대 — 요약 타일과 카드 자리를 잡아 둔다. 저장 뒤 다시 읽을 때는 지금 화면을 그대로 둔다. */
function PortfolioSkeleton() {
  return (
    <div aria-busy="true">
      <p className="sr-only">브랜드 현황을 불러오는 중</p>
      <div className="pf-summary" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="pf-sum pf-skel" />
        ))}
      </div>
      <div className="pf-card" aria-hidden="true">
        <div className="pf-cohort-head pf-skel" />
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="pf-lb-row pf-skel" />
        ))}
      </div>
    </div>
  )
}

/** 카드 맨 위 열 머리 — 줄과 같은 칸 너비(--pf-cols)를 쓰고, 스크롤해도 위에 붙어 있다. */
function ColumnHead() {
  return (
    <div className="pf-lb-head" role="row">
      <span role="columnheader">순위</span>
      <span role="columnheader">브랜드 · 점수 변화</span>
      <span role="columnheader" className="num" title="Brand AEO Score — 100점 만점. 막대 끝이 100점, 가운데 눈금이 50점입니다.">
        AEO 점수 · 100점 만점
      </span>
      <span role="columnheader" className="num pf-head-rate" title="이름 없이 물은 질문의 답변 가운데 이 브랜드를 언급한 비율">
        언급률
      </span>
      <span role="columnheader" className="num pf-head-rate" title="AI가 근거로 쓴 출처 가운데 이 브랜드 사이트의 비율(모든 질문 기준)">
        자사 인용률
      </span>
      <span role="columnheader">상태</span>
      <span role="columnheader">
        <span className="sr-only">동작</span>
      </span>
    </div>
  )
}

interface RowActions {
  open: (tenantId: string) => void
  openCompetitor: (tenantId: string, cohort: PortfolioCohort) => void
  editCompetitors: (tenantId: string) => void
  editProfile: (tenantId: string) => void
  measure: (tenantId: string) => void
  /** 경쟁사 보기 중 — 편집을 잠근다. */
  locked: boolean
  lockedNote: string
  /** 다른 측정이 도는 중 — 「측정」을 잠근다. */
  busy: boolean
  /** 지금 재는 측정의 브랜드(측정 중이 아니면 null). */
  busyId: string | null
  busyNote: string
  measuringIds: Set<string>
  stageOf: (tenantId: string) => string
}

/**
 * 리더보드 한 줄. 고객 브랜드는 그 브랜드로 바꾸고(개요로), 경쟁사는 읽기 전용 개요를 연다.
 *
 * 줄 전체가 이름 단추의 덮개(.pf-lb-open::after)로 눌리고, 칩 단추 · 「측정」 · ⋯는 그 위에 따로 눌린다 — 예전에는 줄 전체가 단추라
 * 안에 다른 단추를 둘 수 없어 편집 링크가 비교 그룹 머리에 몰렸다. 지난 기록(그 뒤 주차에 다시 잰 고객 브랜드의 옛 줄)도 고객
 * 브랜드라 누르면 그 브랜드로 간다 — 개요는 가장 최근 주차를 보인다.
 */
function LeaderRow({
  m,
  row,
  total,
  measured,
  refRank,
  selected,
  watching,
  actions,
  cohort,
}: {
  m: CohortMember
  row: PortfolioRow | undefined
  total: number
  measured: boolean
  /** 질문지가 달라 이 순위는 참고용. */
  refRank: boolean
  /** 사이드바에서 고른 고객 브랜드. */
  selected: boolean
  /** 경쟁사 보기로 지금 보고 있는 경쟁사. */
  watching: boolean
  actions: RowActions
  cohort: PortfolioCohort
}) {
  const current = isCurrentCustomer(m) ? row : undefined
  const change = current ? changeLine(current) : null
  const kind = current ? 'own' : m.competitor ? 'competitor' : 'past'
  const onMain = () => (m.competitor ? actions.openCompetitor(m.tenantId, cohort) : actions.open(m.tenantId))
  const mainTitle = m.competitor
    ? `${m.brandName} 개요 보기(읽기 전용)`
    : current
      ? `${m.brandName} 개요 보기`
      : `${directionParticle(m.brandName)} 바꾸기 — ${m.laterWeek ? `${shortWeek(m.laterWeek)} 측정` : '최근 측정'}을 엽니다`
  const measuring = current ? actions.measuringIds.has(current.tenantId) : false
  const measureState = current ? showMeasure(current, measuring ? current.tenantId : actions.busyId) : 'off'
  const menu: RowMenuItem[] = current
    ? [
        { key: 'open', label: '개요 보기', onSelect: () => actions.open(current.tenantId) },
        {
          key: 'measure',
          label: current.status === 'done' ? '다시 측정' : '측정',
          onSelect: () => actions.measure(current.tenantId),
          disabled: actions.busy,
          title: actions.busy ? actions.busyNote : `${current.brandName} 측정 화면으로 — 함께 잴 경쟁사를 확인하고 시작합니다`,
        },
        {
          key: 'competitors',
          label: '경쟁사 편집',
          hint: current.competitorPlan?.waiting ? `대기 ${current.competitorPlan.waiting}곳` : undefined,
          onSelect: () => actions.editCompetitors(current.tenantId),
          disabled: actions.locked,
          title: actions.locked ? actions.lockedNote : undefined,
          separatorBefore: true,
        },
        {
          key: 'profile',
          label: '기본 정보',
          onSelect: () => actions.editProfile(current.tenantId),
          disabled: actions.locked,
          title: actions.locked ? actions.lockedNote : `${current.brandName} 업종 · 지역 · 시장 범위 바꾸기`,
        },
      ]
    : []

  return (
    <div className={`pf-lb-row ${kind}${selected ? ' is-selected' : ''}`} role="row" id={current ? `pf-row-${m.tenantId}` : undefined}>
      <span className="pf-lb-rank" role="cell">
        {measured ? `${m.tied ? '공동 ' : ''}${m.rank}/${total}${refRank ? '*' : ''}` : '—'}
      </span>
      <span className="pf-lb-name" role="cell">
        <span className="pf-lb-brand">
          <button type="button" className="pf-lb-open" title={mainTitle} aria-current={selected ? 'true' : undefined} onClick={onMain}>
            <span className="pf-lb-text">{m.brandName}</span>
          </button>
          {m.competitor && <span className="bsw-tag">경쟁사</span>}
          {selected && <span className="bsw-tag pf-sel-tag">선택됨</span>}
          {watching && <span className="bsw-tag pf-sel-tag">보는 중</span>}
        </span>
        {change?.text && (
          <span className={`pf-row-meta${change.title ? ' has-title' : ''}`} title={change.title}>
            {change.text}
            {change.title && <span className="sr-only"> — {change.title}</span>}
          </span>
        )}
      </span>
      <span className="pf-lb-score" role="cell">
        <span className="pf-lb-bar" aria-hidden="true">
          <span style={{ width: `${barWidth(m.score, measured)}%` }} />
        </span>
        <span className="pf-lb-num">{measured ? m.score : '—'}</span>
      </span>
      <span className="pf-lb-rate" role="cell">
        {measured ? pct(m.mentionRate) : '—'}
      </span>
      <span className="pf-lb-rate" role="cell">
        {measured ? pct(m.brandOwnedCitationRate) : '—'}
      </span>
      <span className="pf-lb-chip" role="cell">
        {current && measuring && (
          <Link to="/measure-status" className="chip info pf-chip-act">
            측정 중 · {actions.stageOf(current.tenantId)}
          </Link>
        )}
        {current &&
          rowChips(current).map((c) =>
            c.action === 'competitors' ? (
              <button
                key={c.text}
                type="button"
                className={`chip ${c.tone} pf-chip-act`}
                title={actions.locked ? actions.lockedNote : c.title}
                disabled={actions.locked}
                onClick={() => actions.editCompetitors(current.tenantId)}
              >
                {c.text}
              </button>
            ) : (
              <span key={c.text} className={`chip ${c.tone}`} title={c.title}>
                {c.text}
              </span>
            ),
          )}
        {m.laterWeek && <span className="chip info">{shortWeek(m.laterWeek)}에 다시 측정</span>}
      </span>
      <span className="pf-lb-act" role="cell">
        {current ? (
          <>
            {measureState !== 'off' && (
              <button
                type="button"
                className="pf-row-measure"
                disabled={measureState === 'disabled'}
                title={measureState === 'disabled' ? actions.busyNote : `${current.brandName} 측정 화면으로 — 함께 잴 경쟁사를 확인하고 시작합니다`}
                onClick={() => actions.measure(current.tenantId)}
              >
                측정
              </button>
            )}
            <RowMenu label={`${current.brandName} 메뉴`} items={menu} />
          </>
        ) : (
          <span className="pf-row-go pf-row-peek" aria-hidden="true">
            ›
          </span>
        )}
      </span>
    </div>
  )
}
