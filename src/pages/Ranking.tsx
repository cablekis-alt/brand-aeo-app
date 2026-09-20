import { Link } from 'react-router-dom'
import WeekPicker from '../components/WeekPicker'
import { useTenant } from '../context/useTenant'
import { loadRanking } from '../lib/api'
import { ENGINE_LABEL, formatPct } from '../lib/format'
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

  const maxShare = Math.max(0.01, ...(ranking?.competitorShareOfMention.map((c) => c.share) ?? [0.01]))

  /*
   * 한 줄 결론 — 상위권과 우리 사이의 격차가 **어느 지표에서 나오는지** 짚는다.
   *
   * 순위표는 "우리가 4위"까지만 말한다. 그 다음 질문("그래서 뭘 고치나")에 답하려면 상위권이
   * 우리와 무엇이 다른지를 봐야 하는데, 지금까지는 사람이 표를 읽어 스스로 찾아야 했다.
   *
   * 지어내지 않는다: 이미 리더보드에 있는 세 지표만 견주고, 상위권 평균과 우리 값의 차를
   * 그대로 말한다. 우리가 1위면 격차가 없으므로 다른 문장을 쓴다.
   */
  const verdict = (() => {
    const peers = ranking?.cohort.peers ?? []
    const me = peers.find((p) => p.tenantId === tenant?.tenantId)
    if (!me || peers.length < 2) return null
    const above = peers.filter((p) => p.aeoScore > me.aeoScore)
    if (above.length === 0) {
      return { lead: '코호트 1위입니다.', detail: '격차를 좁힐 상대가 없습니다 — 지금 수준을 유지하는 것이 과제입니다.' }
    }
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    const gaps = [
      { label: '언급률', mine: me.mentionRate, theirs: avg(above.map((p) => p.mentionRate)) },
      {
        label: '브랜드 소유 출처 인용률',
        mine: me.brandOwnedCitationRate,
        theirs: avg(above.map((p) => p.brandOwnedCitationRate)),
      },
      // SoM은 null인 브랜드가 섞일 수 있다 — 그런 브랜드를 0으로 치면 평균이 거짓이 되므로 뺀다.
      ...(me.shareOfMention !== null && above.some((p) => p.shareOfMention !== null)
        ? [
            {
              label: 'Share of Mention',
              mine: me.shareOfMention,
              theirs: avg(above.filter((p) => p.shareOfMention !== null).map((p) => p.shareOfMention!)),
            },
          ]
        : []),
    ]
    const worst = [...gaps].sort((a, b) => a.mine - a.theirs - (b.mine - b.theirs))[0]!
    const scoreGap = Math.round((avg(above.map((p) => p.aeoScore)) - me.aeoScore) * 10) / 10
    const lead = `우리 위 ${above.length}곳의 평균 Brand AEO Score는 우리보다 ${scoreGap}점 높습니다.`
    /*
     * 차이가 없으면 원인이라고 말하지 않는다.
     *
     * 실측에서 이 줄이 거짓말을 했다: 원진 W38에서 "가장 벌어진 지표는 언급률 — 상위권 4.7%
     * 대 우리 4.7%". 같은 값인데 원인으로 지목한 것이다. 리더보드는 다섯 지표 중 셋만 싣기
     * 때문에, 셋이 비슷하면 격차는 표에 없는 곳(추천 순위·사실성)에서 나온 것이다.
     * 3%p는 "이 정도는 원인이라 부르지 않는다"는 보수적인 선이다.
     */
    const MEANINGFUL_GAP = 0.03
    if (worst.theirs - worst.mine < MEANINGFUL_GAP) {
      return {
        lead,
        detail:
          '다만 이 표의 지표에서는 뚜렷한 차이가 없습니다 — 격차는 추천 순위·사실성처럼 여기 없는 항목에서 나옵니다. 브랜드 종합 진단의 점수 구성 막대에서 확인하세요.',
      }
    }
    return {
      lead,
      detail: `가장 벌어진 지표는 ${worst.label}입니다 — 상위권 평균 ${formatPct(worst.theirs)} 대 우리 ${formatPct(worst.mine)}.`,
    }
  })()

  return (
    <>
      <p className="brand">어디가 비어 있나</p>
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
            <h3>코호트 리더보드</h3>
            <p className="hint" style={{ marginTop: 0 }}>
              Brand AEO Score 순입니다. 지표를 같은 줄에 두면 상위권의 공통점이 보입니다 — 순위보다 <b>그 자리에 있는 이유</b>가
              고칠 거리를 알려 줍니다.
            </p>
            <div className="table-wrap">
              <table className="leaderboard">
                <thead>
                  <tr>
                    <th>순위</th>
                    <th>브랜드</th>
                    <th>Brand AEO Score</th>
                    <th>언급률</th>
                    <th>인용률</th>
                    <th>변동</th>
                  </tr>
                </thead>
                <tbody>
                  {ranking.cohort.peers.map((peer, i) => {
                    const rank = i + 1
                    // 전주 기록이 없으면 변동을 만들지 않는다 — '보합'으로 적으면 없는 비교를 한 것이 된다.
                    const move = peer.previousRank == null ? null : peer.previousRank - rank
                    return (
                      <tr key={peer.tenantId} className={peer.tenantId === tenant.tenantId ? 'self' : undefined}>
                        <td>{rank}</td>
                        <td>
                          <b>{peer.brandName}</b>
                        </td>
                        <td>{peer.aeoScore}</td>
                        <td>{formatPct(peer.mentionRate)}</td>
                        <td>{formatPct(peer.brandOwnedCitationRate)}</td>
                        <td className={move == null ? 'muted' : move > 0 ? 'move-up' : move < 0 ? 'move-down' : 'muted'}>
                          {move == null ? '—' : move === 0 ? '—' : move > 0 ? `▲${move}` : `▼${-move}`}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {verdict && (
              <p className="rank-verdict">
                <b>{verdict.lead}</b> {verdict.detail}
              </p>
            )}
            <p className="hint">
              {ranking.cohort.previousWeekOf
                ? `변동은 ${ranking.cohort.previousWeekOf} 대비입니다.`
                : '전주 측정이 없어 변동을 표시하지 않습니다.'}
            </p>
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

          {(ranking.byEngine?.length ?? 0) > 1 && (
            <section>
              <h3>수집 엔진별</h3>
              <p className="hint" style={{ marginTop: 0 }}>
                같은 브랜드라도 엔진마다 언급·추천이 다릅니다. 위 요약은 모든 엔진을 합친 값입니다.
                <br />
                <b>코호트 순위는 엔진별로 나누지 않습니다</b> — 주차 스코어카드가 브랜드당 하나라
                "이 엔진 기준 순위"는 저장된 적이 없습니다. 없는 값을 만들어 보여주지 않습니다.
              </p>
              <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>엔진</th>
                    <th style={{ textAlign: 'right' }}>자사 언급 점유</th>
                    <th style={{ textAlign: 'right' }}>1위 추천률</th>
                    <th style={{ textAlign: 'right' }}>가장 많이 언급된 곳</th>
                  </tr>
                </thead>
                <tbody>
                  {(ranking.byEngine ?? []).map((row) => {
                    const self = row.competitorShareOfMention.find((e) => e.name === tenant.brandName)
                    const leader = row.competitorShareOfMention[0]
                    return (
                      <tr key={row.engine}>
                        <td>{ENGINE_LABEL[row.engine] ?? row.engine}</td>
                        <td style={{ textAlign: 'right' }}>
                          {self && self.mentionCount > 0 ? formatPct(self.share) : '언급 없음'}
                          <span className="muted"> · 응답 {row.mentionCalls}건</span>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {row.rankedCalls > 0 ? formatPct(row.topRecommendationRate) : '순위 판정 없음'}
                          {row.rankedCalls > 0 && <span className="muted"> · {row.rankedCalls}건 중</span>}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {leader && leader.mentionCount > 0
                            ? `${leader.name} ${formatPct(leader.share)}`
                            : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              </div>
            </section>
          )}
        </>
      )}
    </>
  )
}
