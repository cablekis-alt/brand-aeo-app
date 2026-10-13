import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import CompetitorEditor from '../components/CompetitorEditor'
import EmptyBrands from '../components/EmptyBrands'
import { useTenant } from '../context/useTenant'
import { loadPortfolio, type CohortMember, type Portfolio as PortfolioData, type PortfolioRow } from '../lib/api'
import { groupColor, groupOrder, industryGroupOf } from '../lib/industryGroups'
import { directionParticle } from '../lib/korean'
import { groupCohorts, isCurrentCustomer, needsMeasure, statusChip } from '../lib/portfolioView'

type Filter = '' | 'done' | 'need' | 'alone'

const SHOW_COMPETITORS_KEY = 'portfolio.showCompetitors'

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

function changeText(r: PortfolioRow): string {
  if (r.delta !== null) return r.delta === 0 ? '전주와 같음' : `전주 대비 ${r.delta > 0 ? '+' : '−'}${Math.abs(r.delta)}`
  if (r.changeReason) return `전주 비교 불가 · ${r.changeReason} 바뀜`
  return r.weekOf ? '측정 1회' : ''
}

const shortWeek = (weekOf: string) => weekOf.replace(/^\d{4}-/, '')
const pct = (v: number) => `${(v * 100).toFixed(1)}%`

/**
 * 브랜드 현황 — 등록한 고객 브랜드를 업종군 → 코호트(업종 · 지역) → 브랜드로 한눈에(server/portfolio.ts).
 *
 * 브랜드가 30곳을 넘자 드롭다운에서 찾기 어려웠고, 어느 코호트가 측정이 필요한지 볼 곳이 없었다. 줄을
 * 누르면 그 브랜드로 바꾸고 개요로 간다 — 드롭다운의 일을 넓힌 화면이다. 데스크톱 앱 전용(웹에는 이
 * 라우트가 없다).
 *
 * 코호트 카드는 미니 리더보드다(상용화 UI 6차 시안) — 같은 주 · 같은 질문지로 잰 구성원을 경쟁사까지 점수
 * 순서로 놓는다. 「4/6」만으로는 누가 위에 있고 몇 점 차이인지 경쟁 순위 화면까지 가야 보였다. 경쟁사 줄은
 * 비교용이라 누를 수 없고, 「경쟁사 함께 보기」를 끄면 고객 브랜드만 남는다(이 PC에 기억). 요약 칸·업종군
 * 칩은 고객 브랜드 기준으로 코호트를 고르고, 검색은 경쟁사 이름도 찾는다. 고객 브랜드라도 그 뒤 주차에
 * 다시 쟀으면 그 코호트는 지난 기록이라 표시만 하고 세지 않는다.
 */
export default function Portfolio() {
  const navigate = useNavigate()
  const location = useLocation()
  const { setTenantId, viewCompetitor, viewing, reloadTenants } = useTenant()
  const [state, setState] = useState<{ loaded: boolean; value: PortfolioData | null }>({ loaded: false, value: null })
  // 경쟁사 편집을 저장하면 다시 읽는다 — 카드의 「측정 안 됨」·「경쟁사 바뀜」 칩이 저장한 목록을 따르게.
  const [reloadKey, setReloadKey] = useState(0)
  useEffect(() => {
    let alive = true
    void loadPortfolio().then((value) => {
      if (alive) setState({ loaded: true, value })
    })
    return () => {
      alive = false
    }
  }, [reloadKey])
  const afterCompetitorSave = () => {
    setReloadKey((k) => k + 1)
    reloadTenants().catch((err: unknown) => console.error('[Portfolio] 브랜드 목록을 다시 읽지 못했습니다', err))
  }

  const [filter, setFilter] = useState<Filter>('')
  const [group, setGroup] = useState('')
  const [query, setQuery] = useState('')
  const [showCompetitors, setShowCompetitors] = useState(readShowCompetitors)
  const rows = useMemo(() => state.value?.rows ?? [], [state.value])
  const rowById = useMemo(() => new Map(rows.map((r) => [r.tenantId, r])), [rows])

  const counts = {
    all: rows.length,
    done: rows.filter((r) => r.status === 'done').length,
    need: rows.filter(needsMeasure).length,
    alone: rows.filter((r) => r.status === 'alone').length,
  }
  const groupsAll = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of rows) m.set(industryGroupOf(r.industry), (m.get(industryGroupOf(r.industry)) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => groupOrder(a[0]) - groupOrder(b[0]))
  }, [rows])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    const passRow = (r: PortfolioRow) =>
      !filter ||
      (filter === 'done' && r.status === 'done') ||
      (filter === 'need' && needsMeasure(r)) ||
      (filter === 'alone' && r.status === 'alone')
    // 측정 기록이 없는 고객 브랜드는 코호트 카드가 없다 — 자기만 든 코호트로 세워 목록에서 빠지지 않게.
    const unmeasured = rows
      .filter((r) => !r.weekOf)
      .map((r) => ({
        industry: r.industry,
        region: r.region,
        weekOf: '',
        members: [
          {
            tenantId: r.tenantId,
            brandName: r.brandName,
            score: 0,
            rank: 0,
            tied: false,
            mentionRate: 0,
            brandOwnedCitationRate: 0,
            competitor: false,
            laterWeek: null,
          },
        ],
      }))
    const visible = [...(state.value?.cohorts ?? []), ...unmeasured].filter((c) => {
      if (group && industryGroupOf(c.industry) !== group) return false
      const passes = c.members.filter(isCurrentCustomer).some((m) => {
        const r = rowById.get(m.tenantId)
        return r ? passRow(r) : false
      })
      if (!passes) return false
      return !q || `${c.industry} ${c.region} ${c.members.map((m) => m.brandName).join(' ')}`.toLowerCase().includes(q)
    })
    return groupCohorts(visible)
  }, [rows, rowById, state.value, filter, group, query])

  const open = (tenantId: string) => {
    setTenantId(tenantId)
    navigate('/')
  }
  const [viewError, setViewError] = useState<string | null>(null)
  /** 경쟁사 줄 — 고른 고객 브랜드는 그대로 두고 그 경쟁사를 읽기 전용으로 연다(상용화 UI 10차 시안). */
  const openCompetitor = (tenantId: string) => {
    setViewError(null)
    viewCompetitor(tenantId)
      .then(() => navigate('/'))
      .catch((e: unknown) => setViewError(e instanceof Error ? e.message : String(e)))
  }

  // 경쟁사 편집 서랍(상용화 UI 11차). 명령 창에서 오면 location.state로 연다 — 이 화면에 머문 채 다시 와도
  // 열리게 이동(location.key)마다 한 번 본다.
  const requested = (location.state as { editCompetitors?: string } | null)?.editCompetitors ?? null
  const [editing, setEditing] = useState<string | null>(requested)
  const [seenKey, setSeenKey] = useState(location.key)
  if (location.key !== seenKey) {
    setSeenKey(location.key)
    if (requested) setEditing(requested)
  }
  const closeEditor = () => {
    setEditing(null)
    // 새로 고침·뒤로 가기에서 다시 열리지 않게 이동 기록의 요청을 지운다.
    if (requested) navigate(location.pathname, { replace: true, state: null })
  }

  const summary: { key: Filter; label: string; value: number; sub: string; tone: string }[] = [
    { key: '', label: '고객 브랜드', value: counts.all, sub: `업종군 ${groupsAll.length}개`, tone: '' },
    { key: 'done', label: '이번 주 완료', value: counts.done, sub: `${state.value?.currentWeek.replace(/^\d{4}-/, '') ?? ''} · 같은 질문지로 측정`, tone: 'good' },
    { key: 'need', label: '측정 필요', value: counts.need, sub: '질문지 다름 · 기록 없음 · 오래됨', tone: 'warn' },
    { key: 'alone', label: '경쟁사 미측정', value: counts.alone, sub: '코호트 순위가 성립하지 않음', tone: 'info' },
  ]

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
            <input type="search" placeholder="브랜드·업종·지역 찾기" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
        </div>
      </header>
      {viewError && (
        <p className="error" role="alert">
          {viewError}
        </p>
      )}
      <p className="page-lead">
        등록한 고객 브랜드를 업종별로 모았습니다. 코호트(업종 · 지역)마다 마지막 측정과 질문지가 같은지 보이고, 줄을 누르면
        그 브랜드의 개요로 갑니다.
      </p>

      {!state.loaded && <p className="muted">불러오는 중…</p>}
      {state.loaded && state.value === null && (
        <p className="muted">브랜드 현황은 데스크톱 앱에서 볼 수 있습니다(웹에는 이 기능이 없습니다).</p>
      )}

      {/* 데스크톱 앱은 켤 때 이 화면에서 시작한다 — 브랜드가 없으면 첫 등록 안내를 보인다. */}
      {state.value && state.value.rows.length === 0 && <EmptyBrands />}

      {state.value && state.value.rows.length > 0 && (
        <>
          <section className="pf-summary" aria-label="요약">
            {summary.map((s) => (
              <button
                key={s.key || 'all'}
                type="button"
                className={`pf-sum${filter === s.key ? ' on' : ''}${s.tone ? ` ${s.tone}` : ''}`}
                aria-pressed={filter === s.key}
                onClick={() => setFilter(filter === s.key ? '' : s.key)}
              >
                <span className="pf-sum-label">{s.label}</span>
                <span className="pf-sum-value">{s.value}</span>
                <span className="pf-sum-sub">{s.sub}</span>
              </button>
            ))}
          </section>

          <div className="pf-toolbar">
            <div className="pf-chips" role="group" aria-label="업종군">
              {[['', counts.all] as [string, number], ...groupsAll].map(([name, n]) => (
                <button
                  key={name || 'all'}
                  type="button"
                  className={`pf-chip${group === name ? ' on' : ''}`}
                  aria-pressed={group === name}
                  onClick={() => setGroup(name)}
                >
                  {name && <span className="grp-dot" style={{ '--grp': groupColor(name) } as React.CSSProperties} aria-hidden="true" />}
                  {name || '전체'} <span className="pf-chip-n">{n}</span>
                </button>
              ))}
            </div>
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

          {shown.length === 0 && <p className="muted">거르개에 맞는 브랜드가 없습니다.</p>}

          {shown.map((g) => (
            <section key={g.name} className="pf-group" aria-label={g.name} style={{ '--grp': groupColor(g.name) } as React.CSSProperties}>
              <h2 className="pf-group-title">
                <span className="grp-mark" aria-hidden="true" />
                <span className="pf-group-name">{g.name}</span>{' '}
                <span className="dash-sub">
                  고객 브랜드 {g.cohorts.reduce((n, c) => n + c.members.filter(isCurrentCustomer).length, 0)}곳 · 코호트 {g.cohorts.length}개
                </span>
              </h2>
              <div className="pf-card">
                {g.cohorts.map((c) => {
                  const top = Math.max(1, ...c.members.map((m) => m.score))
                  const members = c.members.filter((m) => showCompetitors || isCurrentCustomer(m))
                  return (
                    <div key={`${c.industry}|${c.region}|${c.weekOf}`} className="pf-cohort">
                      <div className="pf-cohort-head">
                        <span className="pf-cohort-label">
                          {c.industry} · {c.region}
                        </span>
                        <span className="dash-sub">{c.weekOf ? `코호트 ${c.members.length}곳 · ${shortWeek(c.weekOf)}` : '측정 전'}</span>
                        {c.weekOf && <span className="pf-cohort-cols">순위 · 점수 · 언급률 · 자사 인용률</span>}
                        <CohortEditLinks
                          customers={c.members.filter(isCurrentCustomer).map((m) => rowById.get(m.tenantId)).filter((r): r is PortfolioRow => Boolean(r))}
                          locked={Boolean(viewing)}
                          onEdit={setEditing}
                        />
                      </div>
                      {members.map((m) => (
                        <LeaderRow
                          key={m.tenantId}
                          m={m}
                          row={rowById.get(m.tenantId)}
                          top={top}
                          total={c.members.length}
                          measured={Boolean(c.weekOf)}
                          onOpen={open}
                          onOpenCompetitor={openCompetitor}
                        />
                      ))}
                    </div>
                  )
                })}
              </div>
            </section>
          ))}
        </>
      )}
      {editing && !viewing && <CompetitorEditor key={editing} tenantId={editing} onClose={closeEditor} onSaved={afterCompetitorSave} />}
    </>
  )
}

/**
 * 코호트 카드 머리의 「경쟁사 편집」 — 이 코호트에 마지막 측정이 든 고객 브랜드마다 하나. 칸이 차서 재지 않는
 * 경쟁사가 있으면 주황 칩으로 알린다(server/cohortPlan.ts와 같은 계산). 경쟁사 보기 중에는 잠근다.
 */
function CohortEditLinks({
  customers,
  locked,
  onEdit,
}: {
  customers: PortfolioRow[]
  locked: boolean
  onEdit: (tenantId: string) => void
}) {
  if (customers.length === 0) return null
  const many = customers.length > 1
  return (
    <span className="pf-cohort-edit">
      {customers.map((r) => {
        const missing = r.competitorPlan ? r.competitorPlan.waiting + r.competitorPlan.blocked : 0
        const title = locked ? '고객 브랜드에서만 바꿀 수 있어요(경쟁사 보기 중)' : `${r.brandName} 경쟁사 편집`
        return (
          <span key={r.tenantId} className="pf-cohort-edit-item">
            {r.competitorEdit && (
              <span className="chip info" title={r.competitorEdit.summary}>
                경쟁사 바뀜 · 다음 측정 대기
              </span>
            )}
            {missing > 0 && (
              <button type="button" className="chip warn pf-cohort-miss" disabled={locked} title={title} onClick={() => onEdit(r.tenantId)}>
                경쟁사 {missing}곳 측정 안 됨
              </button>
            )}
            <button type="button" className="pf-cohort-edit-btn" disabled={locked} title={title} onClick={() => onEdit(r.tenantId)}>
              경쟁사 편집{many ? ` · ${r.brandName}` : ''}
            </button>
          </span>
        )
      })}
    </span>
  )
}

/**
 * 리더보드 한 줄. 고객 브랜드는 그 브랜드로 바꾸고(개요로), 경쟁사는 읽기 전용 개요를 연다.
 *
 * 지난 기록(그 뒤 주차에 다시 잰 고객 브랜드의 옛 코호트 줄)도 고객 브랜드라 누르면 그 브랜드로 간다 —
 * 개요는 가장 최근 주차를 보인다. 예전에는 비교용이라 눌리지 않아, 「W40에 다시 측정」이 붙은 뷰성형외과를
 * W37 코호트에서 눌러도 아무 일이 없었다(2026-10-13).
 */
function LeaderRow({
  m,
  row,
  top,
  total,
  measured,
  onOpen,
  onOpenCompetitor,
}: {
  m: CohortMember
  row: PortfolioRow | undefined
  top: number
  total: number
  measured: boolean
  onOpen: (tenantId: string) => void
  onOpenCompetitor: (tenantId: string) => void
}) {
  const current = isCurrentCustomer(m) ? row : undefined
  const chip = current ? statusChip(current) : null
  const cells = (
    <>
      <span className="pf-lb-rank">{measured ? `${m.tied ? '공동 ' : ''}${m.rank}/${total}` : '—'}</span>
      <span className="pf-lb-name">
        <span className="pf-lb-brand">
          <span className="pf-lb-text">{m.brandName}</span>
          {m.competitor && <span className="bsw-tag">경쟁사</span>}
        </span>
        {current && <span className="pf-row-meta">{changeText(current)}</span>}
      </span>
      <span className="pf-lb-score">
        <span className="pf-lb-bar" aria-hidden="true">
          <span style={{ width: `${measured ? Math.max(2, Math.round((m.score / top) * 100)) : 0}%` }} />
        </span>
        <span className="pf-lb-num">{measured ? m.score : '—'}</span>
      </span>
      <span className="pf-lb-rate">{measured ? pct(m.mentionRate) : '—'}</span>
      <span className="pf-lb-rate">{measured ? pct(m.brandOwnedCitationRate) : '—'}</span>
      <span className="pf-lb-chip">
        {chip && <span className={`chip ${chip.tone}`}>{chip.text}</span>}
        {m.laterWeek && <span className="chip info">{shortWeek(m.laterWeek)}에 다시 측정</span>}
      </span>
      <span className={`pf-row-go${current ? '' : ' pf-row-peek'}`} aria-hidden="true">
        ›
      </span>
    </>
  )
  if (current) {
    return (
      <button type="button" className="pf-lb-row own" onClick={() => onOpen(m.tenantId)}>
        {cells}
      </button>
    )
  }
  return m.competitor ? (
    <button
      type="button"
      className="pf-lb-row competitor"
      title={`${m.brandName} 개요 보기(읽기 전용)`}
      onClick={() => onOpenCompetitor(m.tenantId)}
    >
      {cells}
    </button>
  ) : (
    <button
      type="button"
      className="pf-lb-row past"
      title={`${directionParticle(m.brandName)} 바꾸기 — ${m.laterWeek ? `${shortWeek(m.laterWeek)} 측정` : '최근 측정'}을 엽니다`}
      onClick={() => onOpen(m.tenantId)}
    >
      {cells}
    </button>
  )
}
