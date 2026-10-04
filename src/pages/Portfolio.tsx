import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import EmptyBrands from '../components/EmptyBrands'
import { useTenant } from '../context/useTenant'
import { loadPortfolio, type PortfolioRow } from '../lib/api'
import { groupOrder, industryGroupOf } from '../lib/industryGroups'
import { groupByIndustry, needsMeasure, statusChip } from '../lib/portfolioView'

type Filter = '' | 'done' | 'need' | 'alone'

function changeText(r: PortfolioRow): string {
  if (r.delta !== null) return r.delta === 0 ? '전주와 같음' : `전주 대비 ${r.delta > 0 ? '+' : '−'}${Math.abs(r.delta)}`
  if (r.changeReason) return `전주 비교 불가 · ${r.changeReason} 바뀜`
  return r.weekOf ? '측정 1회' : ''
}

/**
 * 브랜드 현황 — 등록한 고객 브랜드를 업종군 → 코호트(업종 · 지역) → 브랜드로 한눈에(server/portfolio.ts).
 *
 * 브랜드가 30곳을 넘자 드롭다운에서 찾기 어려웠고, 어느 코호트가 측정이 필요한지 볼 곳이 없었다. 줄을
 * 누르면 그 브랜드로 바꾸고 개요로 간다 — 드롭다운의 일을 넓힌 화면이다. 비교용 경쟁사는 수만 적는다.
 * 데스크톱 앱 전용(웹에는 이 라우트가 없다).
 */
export default function Portfolio() {
  const navigate = useNavigate()
  const { setTenantId } = useTenant()
  const [state, setState] = useState<{ loaded: boolean; value: { currentWeek: string; rows: PortfolioRow[] } | null }>({
    loaded: false,
    value: null,
  })
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
  const rows = useMemo(() => state.value?.rows ?? [], [state.value])

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
    const pass = (r: PortfolioRow) =>
      (!filter ||
        (filter === 'done' && r.status === 'done') ||
        (filter === 'need' && needsMeasure(r)) ||
        (filter === 'alone' && r.status === 'alone')) &&
      (!group || industryGroupOf(r.industry) === group) &&
      (!q || `${r.brandName} ${r.industry} ${r.region}`.toLowerCase().includes(q))
    return groupByIndustry(rows.filter(pass))
  }, [rows, filter, group, query])

  const open = (r: PortfolioRow) => {
    setTenantId(r.tenantId)
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

          <div className="pf-chips" role="group" aria-label="업종군">
            {[['', counts.all] as [string, number], ...groupsAll].map(([name, n]) => (
              <button
                key={name || 'all'}
                type="button"
                className={`pf-chip${group === name ? ' on' : ''}`}
                aria-pressed={group === name}
                onClick={() => setGroup(name)}
              >
                {name || '전체'} <span className="pf-chip-n">{n}</span>
              </button>
            ))}
          </div>

          {shown.length === 0 && <p className="muted">거르개에 맞는 브랜드가 없습니다.</p>}

          {shown.map((g) => (
            <section key={g.name} className="pf-group" aria-label={g.name}>
              <h2 className="pf-group-title">
                {g.name}{' '}
                <span className="dash-sub">
                  고객 브랜드 {g.cohorts.reduce((n, c) => n + c.list.length, 0)}곳 · 코호트 {g.cohorts.length}개
                </span>
              </h2>
              <div className="pf-card">
                {g.cohorts.map((c) => (
                  <div key={c.label} className="pf-cohort">
                    <div className="pf-cohort-head">
                      <span className="pf-cohort-label">{c.label}</span>
                      {c.list[0]?.totalTenants && <span className="dash-sub">코호트 {Math.max(...c.list.map((r) => r.totalTenants ?? 0))}곳</span>}
                    </div>
                    {c.list.map((r) => {
                      const chip = statusChip(r)
                      return (
                        <button key={r.tenantId} type="button" className="pf-row" onClick={() => open(r)}>
                          <span className="pf-row-name">
                            <span className="pf-row-brand">{r.brandName}</span>
                            <span className="pf-row-meta">
                              경쟁사 {r.competitors}곳 · 마지막 측정 {r.weekOf?.replace(/^\d{4}-/, '') ?? '없음'}
                            </span>
                          </span>
                          <span className="pf-row-score">{r.score ?? '—'}</span>
                          <span className="pf-row-rank">
                            {r.rank ? `${r.tied ? '공동 ' : ''}${r.rank}/${r.totalTenants}` : '—'}
                          </span>
                          <span className={`chip ${chip.tone}`}>{chip.text}</span>
                          <span className="pf-row-change">{changeText(r)}</span>
                          <span className="pf-row-go" aria-hidden="true">
                            ›
                          </span>
                        </button>
                      )
                    })}
                  </div>
                ))}
              </div>
            </section>
          ))}
        </>
      )}
    </>
  )
}
