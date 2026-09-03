import WeekPicker from '../components/WeekPicker'
import { useTenant } from '../context/useTenant'
import { loadCitationSources } from '../lib/api'
import { ENGINE_LABEL, OWNER_TYPE_LABEL, SOURCE_KIND_LABEL, formatPct } from '../lib/format'
import { useScorecards } from '../lib/useScorecards'
import { useWeekSelection } from '../lib/useWeekSelection'
import { useWeeklyData } from '../lib/useWeeklyData'

const EMPTY = {
  totalCitations: 0,
  uniqueUrls: 0,
  uniqueDomains: 0,
  qualityRate: 0,
  mix: [],
  byEngine: [],
  urls: [],
  consensusDomains: [],
}

export default function CitationSources() {
  const { tenant } = useTenant()
  const { history, loading: historyLoading } = useScorecards(tenant?.tenantId ?? '')
  const [weekOf, setWeekOf] = useWeekSelection(history)
  const { data, loading } = useWeeklyData(loadCitationSources, tenant?.tenantId ?? '', weekOf, EMPTY)

  if (!tenant) return null

  const pending = historyLoading || (history.length > 0 && (!weekOf || loading))
  const empty = !pending && data.totalCitations === 0

  return (
    <>
      <p className="brand">S-10 · STAGE 3</p>
      <h1>AI 인용출처 분석</h1>
      <p className="lead">
        엔진이 실제로 붙인 URL을 출처 유형별로 나눕니다. S-05의 소유권(자사/경쟁사) 위에, 뉴스·공공·후기·블로그 같은
        매체 성격과 엔진 간 합의 도메인을 봅니다.
      </p>

      <div className="filters">
        <WeekPicker weeks={history.map((h) => h.weekOf)} value={weekOf} onChange={setWeekOf} />
      </div>

      {pending && <p className="muted">불러오는 중…</p>}
      {!pending && empty && <p className="muted">이 주차에 인용된 URL이 없습니다.</p>}

      {!pending && !empty && (
        <>
          <section className="hero-card">
            <p className="total">
              고품질 출처 비율 <strong>{formatPct(data.qualityRate)}</strong>
            </p>
            <dl className="meta">
              <div>
                <dt>인용 건수</dt>
                <dd>{data.totalCitations}</dd>
              </div>
              <div>
                <dt>고유 URL</dt>
                <dd>{data.uniqueUrls}</dd>
              </div>
              <div>
                <dt>고유 도메인</dt>
                <dd>{data.uniqueDomains}</dd>
              </div>
            </dl>
          </section>

          <section>
            <h3>출처 유형</h3>
            <ul className="weights">
              {data.mix.map((row) => (
                <li key={row.kind}>
                  <strong>{row.count}</strong> {SOURCE_KIND_LABEL[row.kind] ?? row.kind} ({formatPct(row.share)})
                </li>
              ))}
            </ul>
          </section>

          {data.byEngine.length > 0 && (
            <section>
              <h3>엔진별 출처</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>엔진</th>
                      <th>인용</th>
                      <th>구성</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byEngine.map((row) => (
                      <tr key={row.engine}>
                        <td>{ENGINE_LABEL[row.engine] ?? row.engine}</td>
                        <td>{row.total}</td>
                        <td>
                          {row.mix
                            .map((item) => `${SOURCE_KIND_LABEL[item.kind] ?? item.kind} ${item.count}`)
                            .join(' · ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {data.consensusDomains.length > 0 && (
            <section>
              <h3>엔진 간 합의 도메인</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>도메인</th>
                      <th>유형</th>
                      <th>엔진 수</th>
                      <th>인용</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.consensusDomains.map((row) => (
                      <tr key={row.domain}>
                        <td>{row.domain}</td>
                        <td>{SOURCE_KIND_LABEL[row.kind] ?? row.kind}</td>
                        <td>{row.engineCount}</td>
                        <td>{row.citationCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section>
            <h3>인용 URL</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>URL</th>
                    <th>유형</th>
                    <th>소유권</th>
                    <th>횟수</th>
                    <th>엔진</th>
                  </tr>
                </thead>
                <tbody>
                  {data.urls.slice(0, 40).map((row) => (
                    <tr key={row.raw}>
                      <td>
                        <a href={row.raw} target="_blank" rel="noreferrer">
                          {row.domain}
                        </a>
                      </td>
                      <td>{SOURCE_KIND_LABEL[row.kind] ?? row.kind}</td>
                      <td>{OWNER_TYPE_LABEL[row.ownerType] ?? row.ownerType}</td>
                      <td>{row.citationCount}</td>
                      <td>{row.engines.map((engine) => ENGINE_LABEL[engine] ?? engine).join(', ')}</td>
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
