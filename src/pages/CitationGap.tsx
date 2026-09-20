import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import WeekPicker from '../components/WeekPicker'
import { ComparisonNote, ShareDelta, UrlLink } from '../components/CitationBits'
import { useTenant } from '../context/useTenant'
import { loadCitationSources } from '../lib/api'
import {
  GAP_BUCKET_LABEL,
  GAP_BUCKET_ORDER,
  attachPreviousShares,
  computeCitationGap,
  topEntryTargets,
  type CitationGapSummary,
  type GapBucket,
  type GapRow,
} from '../lib/citationGap'
import { KIND_PILL, comparisonFromHistory } from '../lib/citationView'
import { ENGINE_LABEL, formatPct } from '../lib/format'
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

/*
 * 띠 색 — 범주형 팔레트의 고정 슬롯. 값은 src/index.css의 --bucket-* 토큰에 있다.
 *
 * 예전에는 한 색조에 불투명도만 달리했는데(0.95 - i*0.08) 일곱 칸이 전부 검은 계열로 보여
 * 구분이 되지 않았다. 게다가 불투명도를 **정렬 순서(i)**로 매겨서, 데이터가 바뀌어 순서가
 * 달라지면 같은 유형이 다른 색이 됐다 — 색은 순위가 아니라 대상을 따라가야 한다.
 *
 * 경쟁사 둘은 같은 빨강을 쓰고 빗금으로 나눈다. 색을 하나 더 만드는 대신 "같은 개념의 두
 * 등급"임을 형태로 말한다(코호트에 등록된 곳 / 답변에 함께 나온 동종 업체).
 */
const BUCKET_FILL: Record<GapBucket, string> = {
  'competitor-cohort': 'f-competitor',
  'competitor-peer': 'f-competitor f-striped',
  review: 'f-review',
  blog: 'f-blog',
  news: 'f-news',
  gov: 'f-gov',
  forum: 'f-forum',
  social: 'f-social',
  wiki: 'f-wiki',
  other: 'f-other',
}

/** 버킷 배지 색 — 코호트 경쟁사만 빨강, 동종 업체는 주의색, 나머지는 유형 색을 그대로 쓴다. */
const BUCKET_PILL: Record<GapBucket, string> = {
  'competitor-cohort': 'st-bad',
  'competitor-peer': 'st-warn',
  review: KIND_PILL.review,
  news: KIND_PILL.news,
  forum: KIND_PILL.forum,
  blog: KIND_PILL.blog,
  social: KIND_PILL.social,
  gov: KIND_PILL.gov,
  wiki: KIND_PILL.wiki,
  other: KIND_PILL.other,
}

function GapRowView({
  row,
  isOpen,
  onToggle,
  comparable,
}: {
  row: GapRow
  isOpen: boolean
  onToggle: () => void
  comparable: boolean
}) {
  const canOpen = row.urls.length > 0
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
          <span className={`status-pill ${BUCKET_PILL[row.bucket]}`}>{GAP_BUCKET_LABEL[row.bucket]}</span>
        </td>
        <td>{formatPct(row.share)}</td>
        <td>
          <ShareDelta share={row.share} previousShare={row.previousShare} comparable={comparable} />
        </td>
        <td>{row.citationCount}</td>
        <td>{row.engines.map((e) => ENGINE_LABEL[e] ?? e).join(', ')}</td>
        <td>
          {row.actionId ? (
            <Link
              to={`/gap-actions?focus=${encodeURIComponent(row.actionId)}&domain=${encodeURIComponent(row.domain)}`}
              title="콘텐츠 생성에서 이 출처에 올릴 글·등재 항목으로 이동"
            >
              콘텐츠 생성으로 →
            </Link>
          ) : row.bucket === 'competitor-cohort' || row.bucket === 'competitor-peer' ? (
            <span className="muted" title="경쟁사 사이트에는 우리 글을 올릴 수 없습니다">등재 대상 아님</span>
          ) : (
            <span className="muted" title="카탈로그에 없는 종류거나 인용이 적어 실행 항목이 만들어지지 않았습니다">—</span>
          )}
        </td>
      </tr>
      {isOpen && (
        <tr>
          <td />
          <td colSpan={7}>
            <table>
              <thead>
                <tr>
                  <th>URL</th>
                  <th>인용</th>
                  <th>엔진</th>
                </tr>
              </thead>
              <tbody>
                {row.urls.map((u) => (
                  <tr key={u.url}>
                    <td>
                      <UrlLink url={u.url} />
                    </td>
                    <td>{u.citationCount}</td>
                    <td>{u.engines.map((e) => ENGINE_LABEL[e] ?? e).join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {row.citationCount > row.urls.reduce((n, u) => n + u.citationCount, 0) && (
              <p className="muted">상위 10개 URL만 표시합니다.</p>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

export default function CitationGap() {
  const { tenant } = useTenant()
  const [engine, setEngine] = useState<string>('')
  const [bucket, setBucket] = useState<GapBucket | 'all'>('all')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  // 엔진이 바뀌면 loader 참조가 바뀌어 useWeeklyData가 다시 불러온다.
  const loader = useCallback(
    (tenantId: string, weekOf: string) => loadCitationSources(tenantId, weekOf, engine || null),
    [engine],
  )
  const {
    history,
    weeks,
    weekOf,
    setWeekOf,
    data: analysis,
    loading,
  } = useWeeklyPage<CitationSourceAnalysis>(loader, tenant?.tenantId ?? '', EMPTY)

  const gap = useMemo(() => computeCitationGap(analysis), [analysis])
  const targets = useMemo(() => topEntryTargets(gap, 5), [gap])
  const comparison = useMemo(
    () => (weekOf ? comparisonFromHistory(history, weekOf, engine || null) : null),
    [history, weekOf, engine],
  )

  // 전주 갭 — 비교 가능할 때만 불러온다. 결과에 어느 (브랜드·주차·엔진)의 것인지 키를 함께 담아, 필터를 바꾼 직후
  // 옛 전주 값이 새 조건에 붙는 일을 막는다.
  const prevKey = comparison?.comparable ? `${tenant?.tenantId ?? ''}|${comparison.previousWeekOf}|${engine}` : ''
  const [previous, setPrevious] = useState<{ key: string; gap: CitationGapSummary } | null>(null)
  useEffect(() => {
    if (!prevKey || !tenant || !comparison?.comparable) return
    let cancelled = false
    loadCitationSources(tenant.tenantId, comparison.previousWeekOf, engine || null)
      .then((prevAnalysis) => {
        if (!cancelled) setPrevious({ key: prevKey, gap: computeCitationGap(prevAnalysis) })
      })
      .catch(() => {
        if (!cancelled) setPrevious(null)
      })
    return () => {
      cancelled = true
    }
  }, [prevKey, tenant, comparison, engine])
  const comparable = Boolean(comparison?.comparable && previous && previous.key === prevKey)

  const rows = useMemo(() => {
    const base = comparable && previous ? attachPreviousShares(gap.gapDomains, previous.gap) : gap.gapDomains
    const needle = query.trim().toLowerCase()
    return base.filter((r) => (bucket === 'all' || r.bucket === bucket) && (!needle || r.domain.includes(needle)))
  }, [gap, previous, comparable, bucket, query])

  if (!tenant) return null
  const hasData = analysis.totalCitations > 0
  const engines = [...new Set(analysis.byEngine.map((e) => e.engine))].sort()

  return (
    <>
      <p className="brand">어디가 비어 있나</p>
      <h1>인용 갭 분석</h1>
      <p className="lead">
        AI가 답을 만들 때 인용하지만 <b>우리 브랜드는 없는</b> 출처를 찾습니다. 이 도메인들이 곧 콘텐츠·PR·제휴로
        진입할 지점입니다 — 특히 코호트 경쟁사 도메인과 후기·언론 같은 플랫폼에 주목하세요.
      </p>

      <div className="filters">
        <WeekPicker weeks={weeks} value={weekOf} onChange={setWeekOf} />
        <select value={engine} onChange={(e) => setEngine(e.target.value)} aria-label="수집 엔진 필터">
          <option value="">전체 엔진</option>
          {engines.map((e) => (
            <option key={e} value={e}>
              {ENGINE_LABEL[e] ?? e}
            </option>
          ))}
        </select>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="도메인 검색"
          aria-label="도메인 검색"
        />
      </div>

      {loading && <p className="muted">불러오는 중…</p>}
      {!loading && !hasData && <p className="muted">이 주차에 수집된 인용 출처가 없습니다.</p>}

      {!loading && hasData && (
        <>
          <section className="hero-card">
            <p className="eyebrow">{weekOf}</p>
            <p className="total">
              브랜드 미지원 인용 <strong>{formatPct(gap.gapCitationShare)}</strong>
            </p>
            <p className="muted">
              전체 인용 {gap.totalCitations.toLocaleString()}건 중 {gap.gapCitations.toLocaleString()}건이 우리 언급을 뒷받침하지
              않는 출처에서 나왔습니다 · 갭 도메인 {gap.gapDomains.length}개
              {engine && ` · ${ENGINE_LABEL[engine] ?? engine} 응답만`}
            </p>
            <ComparisonNote comparison={comparison} />

            {/* 유형별 갭 비중 — 전체 인용 대비. 칸 사이 2px는 서페이스색이라 색이 맞닿지 않는다. */}
            <div className="mix-bar" role="img" aria-label="유형별 갭 비중">
              {gap.byBucket.map((b) => (
                <span
                  key={b.bucket}
                  className={BUCKET_FILL[b.bucket]}
                  style={{ width: `${(b.citationCount / Math.max(1, gap.gapCitations)) * 100}%` }}
                  title={`${GAP_BUCKET_LABEL[b.bucket]} ${b.citationCount}건 · 전체의 ${formatPct(b.share)}`}
                />
              ))}
            </div>
            <div className="mix-bar-legend">
              {gap.byBucket.map((b) => (
                <span key={b.bucket}>
                  <i className={BUCKET_FILL[b.bucket]} />
                  {GAP_BUCKET_LABEL[b.bucket]} {formatPct(b.share)}
                </span>
              ))}
            </div>

            {targets.length > 0 && (
              <>
                <p className="muted" style={{ marginTop: 12 }}>
                  <b>먼저 뚫을 곳</b> — 인용은 많은데 우리가 없고, 실제로 들어갈 수 있는 출처. 점유율 × 유형 가중(후기·언론
                  1.0 … 기타 0.4)으로 세웠습니다. 경쟁사 사이트는 제외.
                </p>
                <ol className="gap-targets">
                  {targets.map((r) => (
                    <li key={r.domain}>
                      <b>{r.domain}</b> · {GAP_BUCKET_LABEL[r.bucket]} · {formatPct(r.share)} ({r.citationCount}건){' '}
                      <Link to={`/gap-actions?focus=${encodeURIComponent(r.actionId ?? '')}&domain=${encodeURIComponent(r.domain)}`}>
                        콘텐츠 생성으로 →
                      </Link>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </section>

          <section>
            {/* 칩 필터 — 세 표를 한 표로 접는다. 건수는 갭 인용 수, 괄호는 전체 인용 대비 비중. */}
            <div className="filters" role="tablist" aria-label="출처 유형">
              <button
                type="button"
                className={`status-pill ${bucket === 'all' ? 'st-good' : 'st-unknown'}`}
                onClick={() => setBucket('all')}
                aria-pressed={bucket === 'all'}
              >
                전체 {gap.gapDomains.length}
              </button>
              {GAP_BUCKET_ORDER.filter((b) => gap.byBucket.some((x) => x.bucket === b)).map((b) => {
                const stat = gap.byBucket.find((x) => x.bucket === b)!
                const active = bucket === b
                return (
                  <button
                    type="button"
                    key={b}
                    className={`status-pill ${active ? BUCKET_PILL[b] : 'st-unknown'}`}
                    onClick={() => setBucket(active ? 'all' : b)}
                    aria-pressed={active}
                    title={`${GAP_BUCKET_LABEL[b]} — 도메인 ${stat.domains}개, 인용 ${stat.citationCount}건 (전체의 ${formatPct(stat.share)})`}
                  >
                    {GAP_BUCKET_LABEL[b]} {stat.domains}
                  </button>
                )
              })}
            </div>

            <p className="muted">
              자사 도메인·자사 언급을 뒷받침한 출처는 제외했습니다. 점유율은 이 주 전체 인용 기준입니다. 도메인을 펼치면 실제 인용된
              URL(상위 10개)이 보입니다.
              {(bucket !== 'all' || query) && ` · 표시 ${rows.length}/${gap.gapDomains.length}개`}
            </p>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th aria-label="펼치기" />
                    <th>도메인</th>
                    <th>유형</th>
                    <th>점유율</th>
                    <th>전주 대비</th>
                    <th>인용수</th>
                    <th>엔진</th>
                    <th>실행</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={8} className="muted">
                        조건에 맞는 갭 도메인이 없습니다.
                      </td>
                    </tr>
                  )}
                  {rows.map((row) => (
                    <GapRowView
                      key={row.domain}
                      row={row}
                      isOpen={open === row.domain}
                      onToggle={() => setOpen(open === row.domain ? null : row.domain)}
                      comparable={comparable}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <p className="hint" style={{ marginTop: 10 }}>
              여기 오른 도메인에 콘텐츠를 싣거나 인용될 수 있게 하면, 다음 측정에서 브랜드 인용·언급이 오를 여지가 큽니다.
              「코호트 경쟁사」는 설정에 등록한 경쟁사의 도메인, 「동종 업체」는 답변에 나온 그 밖의 같은 업종 사이트입니다.
            </p>
          </section>
        </>
      )}
    </>
  )
}
