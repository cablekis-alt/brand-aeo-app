import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import EmptyBrands from '../components/EmptyBrands'
import { useTenant } from '../context/useTenant'
import { loadPortfolio, type CohortMember, type Portfolio as PortfolioData, type PortfolioRow } from '../lib/api'
import { groupColor, groupOrder, industryGroupOf } from '../lib/industryGroups'
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
  const { setTenantId } = useTenant()
  const [state, setState] = useState<{ loaded: boolean; value: PortfolioData | null }>({ loaded: false, value: null })
  useEffect(() => {
    let alive = true
    void loadPortfolio().then((value) => {
      if (alive) setState({ loaded: true, value })
    })
    return () => {
      alive = false
    }
  }, [])

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
    </>
  )
}

/** 리더보드 한 줄. 지금 재는 고객 브랜드는 누를 수 있고(개요로), 경쟁사·지난 기록은 비교용이다. */
function LeaderRow({
  m,
  row,
  top,
  total,
  measured,
  onOpen,
}: {
  m: CohortMember
  row: PortfolioRow | undefined
  top: number
  total: number
  measured: boolean
  onOpen: (tenantId: string) => void
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
      <span className="pf-row-go" aria-hidden="true">
        {current ? '›' : ''}
      </span>
    </>
  )
  return current ? (
    <button type="button" className="pf-lb-row own" onClick={() => onOpen(m.tenantId)}>
      {cells}
    </button>
  ) : (
    <div className={`pf-lb-row ${m.competitor ? 'competitor' : 'past'}`}>{cells}</div>
  )
}
