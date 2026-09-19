import { useCallback, useState } from 'react'
import WeekPicker from '../components/WeekPicker'
import { useTenant } from '../context/useTenant'
import { loadCitationBreakdown } from '../lib/api'
import { ENGINE_LABEL, formatPct } from '../lib/format'
import type { CitationBreakdown, CitationBreakdownRow, CitationBreakdownUrl, CitationComparison } from '../lib/types'
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

/**
 * 전주 대비 점유율 변화(%p). 비교 가능한 주차에서만 숫자를 그린다.
 * 일간 잡음 위에 화살표를 그리지 않는다 — 엔진이 다르면 「—」이고, 그 이유는 표 위 문구가 말한다.
 */
function ShareDelta({ share, previousShare, comparable }: { share: number; previousShare: number | null; comparable: boolean }) {
  if (!comparable || previousShare === null) return <span className="muted">—</span>
  if (previousShare === 0) return <span className="status-pill st-info">신규</span>
  const delta = (share - previousShare) * 100
  if (Math.abs(delta) < 0.05) return <span className="muted">0.0%p</span>
  const cls = delta > 0 ? 'st-good' : 'st-bad'
  return (
    <span className={`status-pill ${cls}`}>
      {delta > 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(1)}%p
    </span>
  )
}

/** 표 위 한 줄 — 전주와 비교 가능한지, 아니면 왜 아닌지. */
function ComparisonNote({ comparison }: { comparison: CitationComparison | null }) {
  if (!comparison) return <p className="muted">전주 측정이 없어 변화는 표시하지 않습니다.</p>
  if (comparison.comparable) {
    return (
      <p className="muted">
        전주 대비는 {comparison.previousWeekOf} 기준 · 수집 엔진 동일(
        {comparison.currentEngines.map((e) => ENGINE_LABEL[e] ?? e).join('+')})
      </p>
    )
  }
  return (
    <p className="muted">
      <span className="status-pill st-warn">비교 불가</span> {comparison.reason} — 엔진 필터로 한 엔진만 고르면 그 엔진이 두 주에
      모두 있을 때 비교가 살아납니다.
    </p>
  )
}

/** 도메인 한 줄 + 펼침 시 그 호스트에서 실제 인용된 URL 목록. URL은 서버가 상위 10개만 준다. */
function RowWithUrls({
  row,
  urls,
  share,
  isOpen,
  onToggle,
  comparable,
}: {
  row: CitationBreakdownRow
  urls: CitationBreakdownUrl[]
  share: number
  isOpen: boolean
  onToggle: () => void
  comparable: boolean
}) {
  const canOpen = urls.length > 0
  return (
    <>
      <tr>
        <td>
          {canOpen ? (
            <button type="button" onClick={onToggle} aria-expanded={isOpen} aria-label={isOpen ? 'URL 접기' : 'URL 펼치기'}>
              {isOpen ? '▾' : '▸'}
            </button>
          ) : (
            <span className="muted">·</span>
          )}
        </td>
        <td>{row.domain}</td>
        <td>
          <OwnerPill row={row} />
        </td>
        <td>{formatPct(share)}</td>
        <td>
          <ShareDelta share={share} previousShare={row.previousShare ?? null} comparable={comparable} />
        </td>
        <td>{row.citationCount}</td>
        <td>{row.supportingBrandMentionCount}</td>
      </tr>
      {isOpen && (
        <tr>
          <td />
          <td colSpan={6}>
            <table>
              <thead>
                <tr>
                  <th>URL</th>
                  <th>인용</th>
                  <th>엔진</th>
                  <th>뒷받침</th>
                </tr>
              </thead>
              <tbody>
                {urls.map((u) => (
                  <tr key={u.url}>
                    <td>
                      <a href={u.url} target="_blank" rel="noreferrer noopener" title={u.url}>
                        {u.url.length > 90 ? `${u.url.slice(0, 90)}…` : u.url}
                      </a>
                    </td>
                    <td>{u.citationCount}</td>
                    <td>{u.engines.map((e) => ENGINE_LABEL[e] ?? e).join(', ')}</td>
                    <td>{u.supportingBrandMentionCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {row.citationCount > urls.reduce((n, u) => n + u.citationCount, 0) && (
              <p className="muted">상위 10개 URL만 표시합니다.</p>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

export default function Citations() {
  const { tenant } = useTenant()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [engine, setEngine] = useState<string>('')
  // 엔진이 바뀌면 loader 참조가 바뀌어 useWeeklyData가 다시 불러온다.
  const loader = useCallback(
    (tenantId: string, weekOf: string) => loadCitationBreakdown(tenantId, weekOf, engine || null),
    [engine],
  )
  const {
    weeks,
    weekOf,
    setWeekOf,
    data: breakdown,
    loading,
  } = useWeeklyPage<CitationBreakdown>(loader, tenant?.tenantId ?? '', {
    rows: [],
    brandOwnedCitationRate: 0,
  })

  if (!tenant) return null

  // 구버전 서버(share·totalCitations 없음)에서도 표가 깨지지 않게 클라이언트에서 보정한다.
  const total = breakdown.totalCitations ?? breakdown.rows.reduce((sum, r) => sum + r.citationCount, 0)
  const shareOf = (row: CitationBreakdownRow) => row.share ?? (total > 0 ? row.citationCount / total : 0)
  const mixedCount = breakdown.rows.filter((r) => r.mixed).length

  // 도메인 검색 — 200개 넘는 행을 스크롤로 찾게 하지 않는다. 점유율은 전체 기준 그대로 둔다(필터로 재계산하지 않음).
  const needle = query.trim().toLowerCase()
  const visible = needle ? breakdown.rows.filter((r) => r.domain.includes(needle)) : breakdown.rows

  return (
    <>
      <p className="brand">상세 분석</p>
      <h1>URL 상세 분석</h1>
      <p className="lead">응답에 실제로 인용된 URL을 소유권 기준으로 분류해, 자사 도메인이 얼마나 노출되는지 봅니다.</p>

      <div className="filters">
        <WeekPicker weeks={weeks} value={weekOf} onChange={setWeekOf} />
        <select value={engine} onChange={(e) => setEngine(e.target.value)} aria-label="수집 엔진 필터">
          <option value="">전체 엔진</option>
          {(breakdown.engines ?? []).map((e) => (
            <option key={e} value={e}>
              {ENGINE_LABEL[e] ?? e}
            </option>
          ))}
        </select>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="도메인 검색 (예: naver, k-wonjin)"
          aria-label="도메인 검색"
        />
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
              {breakdown.engine && ` · ${ENGINE_LABEL[breakdown.engine] ?? breakdown.engine} 응답만`}
            </p>
            <ComparisonNote comparison={breakdown.comparison ?? null} />
          </section>

          <section>
            <h3>도메인별 인용</h3>
            <p className="muted">
              www.·m. 접두는 같은 도메인으로 묶었습니다. 소유권은 인용별 판정의 다수결이며, 배지에 마우스를 올리면 판정별 건수가 보입니다.
              도메인을 펼치면 실제 인용된 URL(상위 10개)이 보입니다.
              {needle && ` · 검색 결과 ${visible.length}/${breakdown.rows.length}개`}
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th aria-label="펼치기" />
                    <th>도메인</th>
                    <th>소유권</th>
                    <th>점유율</th>
                    <th>전주 대비</th>
                    <th>인용 횟수</th>
                    <th>브랜드 언급 뒷받침</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.length === 0 && (
                    <tr>
                      <td colSpan={7} className="muted">「{query}」와 일치하는 도메인이 없습니다.</td>
                    </tr>
                  )}
                  {visible.map((row) => {
                    const urls = row.urls ?? []
                    const isOpen = open === row.domain
                    return (
                      <RowWithUrls
                        key={row.domain}
                        row={row}
                        urls={urls}
                        share={shareOf(row)}
                        isOpen={isOpen}
                        onToggle={() => setOpen(isOpen ? null : row.domain)}
                        comparable={Boolean(breakdown.comparison?.comparable)}
                      />
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </>
  )
}
