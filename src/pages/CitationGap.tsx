import { useMemo } from 'react'
import WeekPicker from '../components/WeekPicker'
import { useTenant } from '../context/useTenant'
import { loadCitationSources } from '../lib/api'
import { computeCitationGap, type GapRow } from '../lib/citationGap'
import { ENGINE_LABEL, SOURCE_KIND_LABEL } from '../lib/format'
import { useWeeklyPage } from '../lib/useWeeklyPage'
import type { CitationSourceAnalysis } from '../prompts/b7-citation-sources'

const EMPTY: CitationSourceAnalysis = {
  totalCitations: 0,
  uniqueUrls: 0,
  uniqueDomains: 0,
  qualityRate: 0,
  mix: [],
  byEngine: [],
  urls: [],
  consensusDomains: [],
}
const pct = (n: number) => `${Math.round(n * 100)}%`

function GapTable({ rows }: { rows: GapRow[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>도메인</th>
            <th>유형</th>
            <th className="num">인용수</th>
            <th>엔진</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.domain}>
              <td>
                {r.domain}
                {r.urls.length > 0 && (
                  <span className="sentence-meta" style={{ display: 'block' }}>
                    {r.urls[0]}
                    {r.urls.length > 1 ? ` 외 ${r.urls.length - 1}` : ''}
                  </span>
                )}
              </td>
              <td>{SOURCE_KIND_LABEL[r.kind] ?? r.kind}</td>
              <td className="num">{r.citationCount}</td>
              <td>{r.engines.map((e) => ENGINE_LABEL[e] ?? e).join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function CitationGap() {
  const { tenant } = useTenant()
  const {
    weeks,
    weekOf,
    setWeekOf,
    data: analysis,
    loading,
  } = useWeeklyPage<CitationSourceAnalysis>(loadCitationSources, tenant?.tenantId ?? '', EMPTY)

  const gap = useMemo(() => computeCitationGap(analysis), [analysis])

  if (!tenant) return null
  const hasData = analysis.totalCitations > 0

  return (
    <>
      <p className="brand">어디가 비어 있나</p>
      <h1>인용 갭 분석</h1>
      <p className="lead">
        AI가 답을 만들 때 인용하지만 <b>우리 브랜드는 없는</b> 출처를 찾습니다. 이 도메인들이 곧 콘텐츠·PR·제휴로
        진입할 지점입니다 — 특히 경쟁사 도메인과 뉴스·후기 같은 권위/플랫폼에 주목하세요.
      </p>

      <div className="filters">
        <WeekPicker weeks={weeks} value={weekOf} onChange={setWeekOf} />
      </div>

      {loading && <p className="muted">불러오는 중…</p>}
      {!loading && !hasData && <p className="muted">이 주차에 수집된 인용 출처가 없습니다.</p>}

      {!loading && hasData && (
        <>
          <section className="hero-card">
            <p className="eyebrow">{weekOf}</p>
            <p className="total">
              브랜드 미지원 인용 <strong>{pct(gap.gapCitationShare)}</strong>
            </p>
            <p className="muted">
              전체 인용 {analysis.totalCitations}건 중 우리 언급을 뒷받침하지 않는 출처의 비율. 갭 도메인{' '}
              {gap.gapDomains.length}개 · 경쟁사 {gap.competitorDomains.length}개 · 권위/플랫폼 {gap.authorityDomains.length}개.
            </p>
          </section>

          {gap.competitorDomains.length > 0 && (
            <section className="panel warn">
              <h3>경쟁사 도메인 — AI가 인용하지만 우리는 없음</h3>
              <GapTable rows={gap.competitorDomains} />
            </section>
          )}

          <section>
            <h3>권위/플랫폼 출처 — 진입 우선순위</h3>
            {gap.authorityDomains.length === 0 ? (
              <p className="muted">뉴스·공공·위키·후기·포럼 유형의 미지원 출처가 없습니다.</p>
            ) : (
              <GapTable rows={gap.authorityDomains.slice(0, 15)} />
            )}
          </section>

          <section>
            <h3>전체 갭 도메인 (인용수 순)</h3>
            <GapTable rows={gap.gapDomains.slice(0, 20)} />
            <p className="hint" style={{ marginTop: 10 }}>
              자사 도메인·자사 언급을 뒷받침한 출처는 제외했습니다. 여기 오른 도메인에 콘텐츠를 싣거나 인용될 수 있게
              하면, 다음 측정에서 브랜드 인용·언급이 오를 여지가 큽니다.
            </p>
          </section>
        </>
      )}
    </>
  )
}
