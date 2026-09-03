import WeekPicker from '../components/WeekPicker'
import { useTenant } from '../context/useTenant'
import { loadCitationBreakdown } from '../lib/api'
import { formatPct } from '../lib/format'
import { useScorecards } from '../lib/useScorecards'
import { useWeekSelection } from '../lib/useWeekSelection'
import { useWeeklyData } from '../lib/useWeeklyData'

const OWNER_TYPE_LABEL: Record<string, string> = {
  'brand-owned': '자사',
  'competitor-owned': '경쟁사',
  'third-party-authority': '제3자 권위',
  'third-party-ugc': '제3자 UGC',
  unknown: '알 수 없음',
}

export default function Citations() {
  const { tenant } = useTenant()
  const { history } = useScorecards(tenant?.tenantId ?? '')
  const [weekOf, setWeekOf] = useWeekSelection(history)
  const { data: breakdown, loading } = useWeeklyData(loadCitationBreakdown, tenant?.tenantId ?? '', weekOf, {
    rows: [],
    brandOwnedCitationRate: 0,
  })

  if (!tenant) return null

  return (
    <>
      <p className="brand">S-05 · STAGE 3</p>
      <h1>URL 상세 분석</h1>
      <p className="lead">응답에 실제로 인용된 URL을 소유권 기준으로 분류해, 자사 도메인이 얼마나 노출되는지 봅니다.</p>

      <div className="filters">
        <WeekPicker weeks={history.map((h) => h.weekOf)} value={weekOf} onChange={setWeekOf} />
      </div>

      {loading && <p className="muted">불러오는 중…</p>}
      {!loading && breakdown.rows.length === 0 && <p className="muted">이 주차에 인용된 URL이 없습니다.</p>}

      {!loading && breakdown.rows.length > 0 && (
        <>
          <section className="hero-card">
            <p className="total">
              자사 소유 출처 비율 <strong>{formatPct(breakdown.brandOwnedCitationRate)}</strong>
            </p>
          </section>

          <section>
            <h3>도메인별 인용</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>도메인</th>
                    <th>소유권</th>
                    <th>인용 횟수</th>
                    <th>브랜드 언급 뒷받침</th>
                  </tr>
                </thead>
                <tbody>
                  {breakdown.rows.map((row) => (
                    <tr key={`${row.domain}-${row.ownerType}`}>
                      <td>{row.domain}</td>
                      <td>{OWNER_TYPE_LABEL[row.ownerType] ?? row.ownerType}</td>
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
