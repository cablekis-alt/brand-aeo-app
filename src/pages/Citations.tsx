import WeekPicker from '../components/WeekPicker'
import { useTenant } from '../context/useTenant'
import { loadCitationBreakdown } from '../lib/api'
import { formatPct } from '../lib/format'
import type { CitationBreakdown, CitationBreakdownRow } from '../lib/types'
import { useWeeklyPage } from '../lib/useWeeklyPage'

const OWNER_TYPE_LABEL: Record<string, string> = {
  'brand-owned': '자사',
  'competitor-owned': '경쟁사',
  'third-party-authority': '제3자 권위',
  'third-party-ugc': '제3자 UGC',
  unknown: '알 수 없음',
}

// 자사·경쟁사만 색을 준다. 제3자는 회색 — 표에서 눈이 먼저 가야 할 곳은 "우리와 경쟁사가 어디에 있나"다.
const OWNER_TYPE_PILL: Record<string, string> = {
  'brand-owned': 'st-good',
  'competitor-owned': 'st-bad',
  'third-party-authority': 'st-info',
  'third-party-ugc': 'st-ok',
  unknown: 'st-unknown',
}

/** 소유권 배지. 판정이 갈린 호스트는 「혼재」를 덧붙이고, 마우스를 올리면 판정별 건수를 보여 준다. */
function OwnerPill({ row }: { row: CitationBreakdownRow }) {
  const label = OWNER_TYPE_LABEL[row.ownerType] ?? row.ownerType
  const counts = row.ownerTypeCounts
  const detail = counts
    ? Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([t, n]) => `${OWNER_TYPE_LABEL[t] ?? t} ${n}`)
        .join(' · ')
    : undefined
  return (
    <span className={`status-pill ${OWNER_TYPE_PILL[row.ownerType] ?? 'st-unknown'}`} title={detail}>
      {label}
      {row.mixed && <span className="muted"> · 혼재</span>}
    </span>
  )
}

export default function Citations() {
  const { tenant } = useTenant()
  const {
    weeks,
    weekOf,
    setWeekOf,
    data: breakdown,
    loading,
  } = useWeeklyPage<CitationBreakdown>(loadCitationBreakdown, tenant?.tenantId ?? '', {
    rows: [],
    brandOwnedCitationRate: 0,
  })

  if (!tenant) return null

  // 구버전 서버(share·totalCitations 없음)에서도 표가 깨지지 않게 클라이언트에서 보정한다.
  const total = breakdown.totalCitations ?? breakdown.rows.reduce((sum, r) => sum + r.citationCount, 0)
  const shareOf = (row: CitationBreakdownRow) => row.share ?? (total > 0 ? row.citationCount / total : 0)
  const mixedCount = breakdown.rows.filter((r) => r.mixed).length

  return (
    <>
      <p className="brand">상세 분석</p>
      <h1>URL 상세 분석</h1>
      <p className="lead">응답에 실제로 인용된 URL을 소유권 기준으로 분류해, 자사 도메인이 얼마나 노출되는지 봅니다.</p>

      <div className="filters">
        <WeekPicker weeks={weeks} value={weekOf} onChange={setWeekOf} />
      </div>

      {loading && <p className="muted">불러오는 중…</p>}
      {!loading && breakdown.rows.length === 0 && <p className="muted">이 주차에 인용된 URL이 없습니다.</p>}

      {!loading && breakdown.rows.length > 0 && (
        <>
          <section className="hero-card">
            <p className="total">
              자사 소유 출처 비율 <strong>{formatPct(breakdown.brandOwnedCitationRate)}</strong>
            </p>
            <p className="muted">
              인용 {total.toLocaleString()}건 · 도메인 {breakdown.rows.length.toLocaleString()}개
              {mixedCount > 0 && ` · 소유권 판정이 갈린 도메인 ${mixedCount}개(「혼재」 표시)`}
            </p>
          </section>

          <section>
            <h3>도메인별 인용</h3>
            <p className="muted">
              www.·m. 접두는 같은 도메인으로 묶었습니다. 소유권은 인용별 판정의 다수결이며, 배지에 마우스를 올리면 판정별 건수가 보입니다.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>도메인</th>
                    <th>소유권</th>
                    <th>점유율</th>
                    <th>인용 횟수</th>
                    <th>브랜드 언급 뒷받침</th>
                  </tr>
                </thead>
                <tbody>
                  {breakdown.rows.map((row) => (
                    <tr key={row.domain}>
                      <td>{row.domain}</td>
                      <td>
                        <OwnerPill row={row} />
                      </td>
                      <td>{formatPct(shareOf(row))}</td>
                      <td>{row.citationCount}</td>
                      <td>{row.supportingBrandMentionCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </>
  )
}
