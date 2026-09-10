import { Link } from 'react-router-dom'
import WeekPicker from '../components/WeekPicker'
import { useTenant } from '../context/useTenant'
import { loadRanking } from '../lib/api'
import { formatPct } from '../lib/format'
import { useWeeklyPage } from '../lib/useWeeklyPage'
import type { RankingView } from '../lib/types'

export default function Ranking() {
  const { tenant } = useTenant()
  const {
    weeks,
    weekOf,
    setWeekOf,
    data: ranking,
    loading,
    neverMeasured,
  } = useWeeklyPage<RankingView | null>(loadRanking, tenant?.tenantId ?? '', null)

  if (!tenant) return null

  const maxPeerScore = Math.max(1, ...(ranking?.cohort.peers.map((p) => p.aeoScore) ?? [1]))
  const maxShare = Math.max(0.01, ...(ranking?.competitorShareOfMention.map((c) => c.share) ?? [0.01]))

  return (
    <>
      <p className="brand">STAGE 4</p>
      <h1>랭킹 분석</h1>
      <p className="lead">같은 업종·지역의 다른 브랜드와 비교해 몇 위인지, 추천 우선순위에서 얼마나 앞서는지 봅니다.</p>

      <div className="filters">
        <WeekPicker weeks={weeks} value={weekOf} onChange={setWeekOf} />
      </div>

      {loading && <p className="muted">불러오는 중…</p>}
      {!loading && !ranking && (
        <p className="muted">
          {neverMeasured
            ? '이 브랜드는 아직 측정된 적이 없습니다. '
            : '이 주차에 랭킹 데이터가 없습니다. '}
          <Link to="/measure-tenant">브랜드·경쟁사 측정</Link>에서 이 브랜드를 측정하면 순위·SoM이 채워집니다.
        </p>
      )}

      {ranking && (
        <>
          <section className="hero-card">
            <p className="eyebrow">{tenant.industry} · {tenant.region} 코호트</p>
            <p className="total">
              코호트 순위{' '}
              <strong>
                {ranking.cohort.position || '-'} / {ranking.cohort.totalTenants}
              </strong>
            </p>
            <p className="muted">추천 1순위로 뽑힌 비율 {formatPct(ranking.topRecommendationRate)}</p>
          </section>

          <section>
            <h3>코호트 순위</h3>
            <ul className="rank-list">
              {ranking.cohort.peers.map((peer) => (
                <li key={peer.tenantId} className={`rank-row ${peer.tenantId === tenant.tenantId ? 'self' : ''}`}>
                  <span className="rank-name">{peer.brandName}</span>
                  <span className="rank-track">
                    <span className="rank-fill" style={{ width: `${(peer.aeoScore / maxPeerScore) * 100}%` }} />
                  </span>
                  <span className="rank-value">{peer.aeoScore}</span>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3>경쟁사 Share of Mention</h3>
            <p className="hint" style={{ marginTop: 0 }}>
              {ranking.mentionScope === 'category-agnostic'
                ? '브랜드명을 넣지 않은 질문(카테고리 무관)의 응답만 셉니다 — 대시보드의 Share of Mention과 같은 모집단입니다.'
                : '질문 은행을 읽지 못해 전체 응답으로 집계했습니다 — 브랜드명이 들어간 질문이 자사 점유를 부풀릴 수 있습니다.'}
            </p>
            {ranking.competitorShareOfMention.filter((e) => e.name !== tenant.brandName).length === 0 ? (
              <p className="muted">
                경쟁사가 설정되지 않아 언급 점유를 비교할 수 없습니다. 실제 경쟁 브랜드를 등록하면 측정됩니다.
              </p>
            ) : (
              <ul className="rank-list">
                {ranking.competitorShareOfMention.map((entity) => (
                  <li key={entity.name} className={`rank-row ${entity.name === tenant.brandName ? 'self' : ''}`}>
                    <span className="rank-name">{entity.name}</span>
                    <span className="rank-track">
                      <span className="rank-fill" style={{ width: `${(entity.share / maxShare) * 100}%` }} />
                    </span>
                    <span className="rank-value">{formatPct(entity.share)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </>
  )
}
