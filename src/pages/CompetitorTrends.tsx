import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import WeekPicker from '../components/WeekPicker'
import { useTenant } from '../context/useTenant'
import { loadRanking, loadScorecards } from '../lib/api'
import { buildCompetitorTrend, type TrendEntry } from '../lib/competitorTrends'
import { weekLabel } from '../lib/format'
import { useScorecards } from '../lib/useScorecards'
import { useWeekSelection } from '../lib/useWeekSelection'
import { useWeeklyData } from '../lib/useWeeklyData'
import type { RankingView } from '../lib/types'

// 우리 브랜드 + 경쟁사 라인색(우리 브랜드는 강조).
const LINE_COLORS = ['var(--accent)', '#2563eb', '#16a34a', '#d97706', '#9333ea', '#0891b2']

export default function CompetitorTrends() {
  const { tenant } = useTenant()
  const { history } = useScorecards(tenant?.tenantId ?? '')
  const [weekOf, setWeekOf] = useWeekSelection(history)
  const { data: ranking } = useWeeklyData<RankingView | null>(loadRanking, tenant?.tenantId ?? '', weekOf, null)

  // 코호트 경쟁사(자기 자신 제외) 각각의 스코어카드 히스토리를 불러온다.
  const [peerHistories, setPeerHistories] = useState<TrendEntry[]>([])
  const peers = useMemo(
    () => (ranking?.cohort.peers ?? []).filter((p) => p.tenantId !== tenant?.tenantId),
    [ranking, tenant?.tenantId],
  )

  useEffect(() => {
    if (!tenant?.tenantId || peers.length === 0) return
    let alive = true
    void Promise.all(
      peers.map(async (p) => ({
        tenantId: p.tenantId,
        brandName: p.brandName,
        self: false,
        history: await loadScorecards(p.tenantId),
      })),
    ).then((entries) => {
      if (alive) setPeerHistories(entries)
    })
    return () => {
      alive = false
    }
  }, [tenant?.tenantId, peers])

  // 현재 코호트 경쟁사에 해당하는 히스토리만 사용한다(테넌트 전환·경쟁사 변경 시 이전 데이터 잔존 방지).
  const activePeers = useMemo(() => {
    const ids = new Set(peers.map((p) => p.tenantId))
    return peerHistories.filter((e) => ids.has(e.tenantId))
  }, [peers, peerHistories])
  // 불러올 경쟁사는 있는데 아직 정렬된 히스토리가 없으면 로딩 중으로 본다.
  const loadingPeers = peers.length > 0 && activePeers.length === 0

  const trend = useMemo(() => {
    if (!tenant) return null
    const self: TrendEntry = { tenantId: tenant.tenantId, brandName: tenant.brandName, self: true, history }
    return buildCompetitorTrend([self, ...activePeers])
  }, [tenant, history, activePeers])

  if (!tenant) return null

  const hasPeers = activePeers.length > 0
  const chart = trend && trend.weeks.length > 0 ? renderChart(trend) : null

  return (
    <>
      <p className="brand">상세 분석</p>
      <h1>경쟁 시계열</h1>
      <p className="lead">
        코호트 경쟁사와 우리 브랜드의 주간 AEO Score 추이를 한 축에서 비교합니다. 리더 대비 격차가 벌어지는지 좁혀지는지를
        추세로 봅니다.
      </p>

      <div className="filters">
        <WeekPicker weeks={history.map((h) => h.weekOf)} value={weekOf} onChange={setWeekOf} />
      </div>

      {!hasPeers && (
        <p className="muted">
          비교할 코호트 경쟁사 데이터가 없습니다. <Link to="/measure-tenant">브랜드·경쟁사 측정</Link>에서 경쟁사까지
          측정하면 추이가 채워집니다.
          {loadingPeers && ' (불러오는 중…)'}
        </p>
      )}

      {trend && trend.weeks.length > 0 && (
        <>
          <section>
            <h3>주간 AEO Score 추이</h3>
            {chart}
            <ul className="trend-legend">
              {trend.series.map((s, i) => (
                <li key={s.tenantId}>
                  <span className="swatch" style={{ background: LINE_COLORS[i % LINE_COLORS.length] }} />
                  <span className={s.self ? 'self' : undefined}>
                    {s.brandName}
                    {s.self ? ' (우리)' : ''}
                  </span>
                  <span className="muted">{s.latest ?? '-'}</span>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3>리더 대비 격차 · {weekLabel(trend.weeks[trend.weeks.length - 1])}</h3>
            <p className="muted">리더 {trend.leaderName ?? '-'} 기준. 0에 가까울수록 선두에 근접합니다.</p>
            <ul className="rank-list">
              {trend.gapToLeader.map((g) => (
                <li key={g.tenantId} className={`rank-row ${g.self ? 'self' : ''}`}>
                  <span className="rank-name">{g.brandName}</span>
                  <span className="rank-value">{g.latest ?? '-'}</span>
                  <span className="rank-value" style={{ minWidth: 64 }}>
                    {g.gapToLeader === null ? '-' : g.gapToLeader === 0 ? '리더' : `-${g.gapToLeader}`}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </>
  )
}

function renderChart(trend: NonNullable<ReturnType<typeof buildCompetitorTrend>>) {
  const W = 640
  const H = 220
  const padL = 34
  const padR = 12
  const padT = 12
  const padB = 26
  const n = trend.weeks.length
  const x = (i: number) => (n <= 1 ? padL : padL + (i * (W - padL - padR)) / (n - 1))
  const y = (v: number) => padT + (1 - v / trend.maxScore) * (H - padT - padB)

  return (
    <div className="table-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="trend-chart" role="img" aria-label="경쟁사 AEO Score 추이 선 그래프">
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const val = Math.round(trend.maxScore * f)
          const yy = y(val)
          return (
            <g key={f}>
              <line x1={padL} y1={yy} x2={W - padR} y2={yy} stroke="var(--line)" strokeWidth={1} />
              <text x={4} y={yy + 3} fontSize={9} fill="var(--muted)">
                {val}
              </text>
            </g>
          )
        })}
        {trend.weeks.map((w, i) => (
          <text key={w} x={x(i)} y={H - 8} fontSize={9} fill="var(--muted)" textAnchor="middle">
            {w.slice(-3)}
          </text>
        ))}
        {trend.series.map((s, si) => {
          const color = LINE_COLORS[si % LINE_COLORS.length]
          const pts = s.points
            .map((p, i) => (p.score === null ? null : `${x(i)},${y(p.score)}`))
            .filter((v): v is string => v !== null)
          return (
            <g key={s.tenantId}>
              <polyline
                points={pts.join(' ')}
                fill="none"
                stroke={color}
                strokeWidth={s.self ? 2.5 : 1.5}
                strokeOpacity={s.self ? 1 : 0.75}
              />
              {s.points.map((p, i) =>
                p.score === null ? null : (
                  <circle key={i} cx={x(i)} cy={y(p.score)} r={s.self ? 3 : 2} fill={color} />
                ),
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}
