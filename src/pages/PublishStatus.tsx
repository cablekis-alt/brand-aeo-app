import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { loadPublishStatus, saveIndexCheck } from '../lib/api'
import { downloadCsv, safeFileName } from '../lib/markdownFile'
import { monthDay } from '../lib/publishTracking'
import {
  ENGINE_NAME,
  filterRows,
  googleSearchUrl,
  indexStateLabel,
  naverSearchUrl,
  publishStatusCsv,
  publishStatusFileName,
  recheckCell,
  rowRecheck,
  summarizeStatus,
  writerFilterValue,
  writerLabel,
  type IndexEngine,
  type IndexState,
  type PublishStatus as PublishStatusData,
  type PublishStatusRow,
  type StateFilter,
  type StatusFilter,
} from '../lib/publishStatus'

const DEFAULT_FILTER: StatusFilter = { tenantId: '', writer: '', naver: '', google: '', dueOnly: false, showUnposted: true, showRemoved: false }

const SHOWN_WORD: Record<IndexEngine, string> = { naver: '노출됨', google: '색인됨' }

/** 주소 칸에 보일 글자 — http(s)://를 뗀다(누르면 전체 주소로 연다). */
const shortUrl = (url: string) => url.replace(/^https?:\/\//i, '').replace(/\/+$/, '')

type MarkFn = (row: PublishStatusRow, engine: IndexEngine, state: IndexState | null) => void

/**
 * 네이버 노출 · 구글 색인 칸 — 상태와 확인한 날, 검색 창을 여는 링크(데스크톱 앱은 시스템 브라우저로 연다 — electron/main.cjs
 * setWindowOpenHandler), 본 결과를 적는 단추. 같은 상태를 다시 누르면 확인한 날이 오늘로 바뀐다(다시 볼 날에 「아직」을 다시 확인한 것).
 */
function IndexCell({ row, engine, busy, onMark }: { row: PublishStatusRow; engine: IndexEngine; busy: boolean; onMark: MarkFn }) {
  if (row.kind === 'unposted') return <td className="ps-index muted">—</td>
  const check = row[engine]
  const tone = check?.state === 'shown' ? ' good' : check ? ' warn' : ''
  const searchUrl = engine === 'naver' ? naverSearchUrl(row) : row.url ? googleSearchUrl(row.url) : null
  const name = ENGINE_NAME[engine]
  return (
    <td className="ps-index">
      <span className={`chip${tone}`}>{indexStateLabel(engine, check)}</span>
      {check && (
        <span className="ps-date" title={`${check.source === 'auto' ? '자동 확인' : '직접 확인'} · ${check.checkedAt}`}>
          {monthDay(check.checkedOn)} 확인
        </span>
      )}
      {!row.removed && (
        <div className="ps-index-actions">
          {searchUrl && (
            <a className="ps-search" href={searchUrl} target="_blank" rel="noreferrer">
              {name}에서 확인
            </a>
          )}
          <button
            type="button"
            className="ps-mark"
            aria-pressed={check?.state === 'shown'}
            aria-label={`${name} ${SHOWN_WORD[engine]}으로 표시`}
            disabled={busy}
            onClick={() => onMark(row, engine, 'shown')}
          >
            {SHOWN_WORD[engine]}
          </button>
          <button
            type="button"
            className="ps-mark"
            aria-pressed={check?.state === 'not-yet'}
            aria-label={`${name} 아직으로 표시`}
            disabled={busy}
            onClick={() => onMark(row, engine, 'not-yet')}
          >
            아직
          </button>
          {check && (
            <button type="button" className="ps-mark ps-clear" aria-label={`${name} 표시 지우기(미확인으로)`} disabled={busy} onClick={() => onMark(row, engine, null)}>
              지우기
            </button>
          )}
        </div>
      )}
    </td>
  )
}

/** 다시 볼 날 칸 — 오늘 다시 볼 글이면 어느 엔진인지, 아니면 다음 날 · 14일 지남 · 확인 끝 · 모름. */
function RecheckView({ row, today }: { row: PublishStatusRow; today: string }) {
  if (row.kind === 'unposted') return <td />
  if (row.removed) return <td className="muted">{recheckCell(row, today)}</td>
  const r = rowRecheck(row, today)
  if (r.due) {
    return (
      <td>
        <span className="chip warn">오늘 다시 볼 글</span>
        <span className="ps-date">
          {r.engines.map((e) => ENGINE_NAME[e]).join(' · ')}
          {r.over ? ' · 14일 지남' : ''}
        </span>
      </td>
    )
  }
  if (r.nextOn) {
    return (
      <td title={r.nextOn}>
        <span className="mono">{monthDay(r.nextOn)}</span>
        <span className="ps-date">다음에 볼 날</span>
      </td>
    )
  }
  return <td className="muted">{r.label}</td>
}

/**
 * 발행 현황 — 고객 브랜드 모두의 올린 글을 한 표로(server/publishStatus.ts · src/lib/publishStatus.ts). 작성자별 진행(올림 n/배정 수)과
 * 아직 안 올린 배정 글, 네이버 노출 · 구글 색인 확인, 다시 볼 날(올린 뒤 3 · 7 · 14일째)을 함께 본다.
 *
 * 색인 확인은 지금 두 엔진 모두 사람이 한다 — 「네이버에서 확인」 · 「구글에서 확인」으로 검색 창을 연 뒤 본 결과를 누른다. 누르지 않은 글은
 * 「미확인」이다. 데스크톱 앱 전용(웹에는 라우트가 없다).
 */
export default function PublishStatus() {
  const [state, setState] = useState<{ loaded: boolean; value: PublishStatusData | null; error: string | null }>({ loaded: false, value: null, error: null })
  const [reloadKey, setReloadKey] = useState(0)
  const [filter, setFilter] = useState<StatusFilter>(DEFAULT_FILTER)
  const [busy, setBusy] = useState<string | null>(null)
  const [markError, setMarkError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void loadPublishStatus().then(
      (value) => {
        if (alive) setState({ loaded: true, value, error: null })
      },
      (err: unknown) => {
        if (alive) setState((s) => ({ ...s, loaded: true, error: err instanceof Error ? err.message : String(err) }))
      },
    )
    return () => {
      alive = false
    }
  }, [reloadKey])

  const data = state.value
  const today = data?.today ?? ''
  const rows = data?.rows ?? []
  const patchFilter = (patch: Partial<StatusFilter>) => setFilter((f) => ({ ...f, ...patch }))

  const mark: MarkFn = (row, engine, next) => {
    if (!row.postId) return
    const cell = `${row.rowKey}|${engine}`
    setBusy(cell)
    setMarkError(null)
    saveIndexCheck(row.tenantId, row.postId, engine, next)
      .then((record) => {
        setState((s) =>
          s.value
            ? {
                ...s,
                value: {
                  ...s.value,
                  rows: s.value.rows.map((r) => (r.rowKey === row.rowKey ? { ...r, naver: record.naver ?? null, google: record.google ?? null } : r)),
                },
              }
            : s,
        )
      })
      .catch((err: unknown) => setMarkError(`「${row.title ?? '제목 미확인'}」 ${ENGINE_NAME[engine]} 표시를 저장하지 못했습니다 — ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setBusy((b) => (b === cell ? null : b)))
  }

  // 브랜드 · 작성자로 고른 범위 — 요약과 작성자 거르기 목록이 이 범위를 따른다(상태 거르기는 요약에 넣지 않는다).
  const brands = [...new Map(rows.map((r) => [r.tenantId, r.brand])).entries()]
  const inBrand = rows.filter((r) => !filter.tenantId || r.tenantId === filter.tenantId)
  const writerOptions = [...new Map(inBrand.map((r) => [writerFilterValue(r), writerLabel(r)])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'ko'))
  const scope = inBrand.filter((r) => !filter.writer || writerFilterValue(r) === filter.writer)
  const sum = summarizeStatus(scope, today)
  const shown = filterRows(rows, filter, today)
  const writers = (data?.writers ?? []).filter((w) => !filter.tenantId || w.tenantId === filter.tenantId)
  const writerBrands = [...new Set(writers.map((w) => w.tenantId))]

  const exportCsv = () => downloadCsv(safeFileName(publishStatusFileName(today)), publishStatusCsv(shown, today))
  const tiles = [
    { label: '올린 글', value: sum.posted, sub: '뺀 글 · 안 올린 글 제외', tone: '' },
    { label: '네이버 노출', value: sum.naverShown, sub: '노출됨으로 표시한 글', tone: 'good' },
    { label: '구글 색인', value: sum.googleShown, sub: '색인됨으로 표시한 글', tone: 'good' },
    { label: '미확인', value: sum.unknown, sub: '한 엔진이라도 아직 안 본 글', tone: '' },
    { label: '오늘 다시 볼', value: sum.due, sub: '올린 뒤 3 · 7 · 14일째', tone: 'warn' },
  ]

  return (
    <>
      <header className="page-head">
        <div className="page-title">
          <p className="page-eyebrow">전체 브랜드{today ? ` · ${today}` : ''}</p>
          <h1>발행 현황</h1>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" onClick={exportCsv} disabled={!data || shown.length === 0}>
            CSV로 받기
          </button>
          <button type="button" className="btn" onClick={() => setReloadKey((k) => k + 1)}>
            다시 읽기
          </button>
        </div>
      </header>
      <p className="page-lead">
        고객 브랜드에 올린 글을 한 표로 봅니다. 네이버 · 구글은 지금 직접 검색해 확인합니다 — 「네이버에서 확인」 · 「구글에서 확인」으로 검색 창을 연 뒤
        본 결과대로 「노출됨 · 색인됨」 또는 「아직」을 누르세요. 누르지 않은 글은 「미확인」입니다. 올린 뒤 3 · 7 · 14일째에 다시 봅니다.
      </p>

      {!state.loaded && <p className="muted">발행 현황을 불러오는 중…</p>}
      {state.error && (
        <p className="error" role="alert">
          {state.error}{' '}
          <button type="button" className="ghost" onClick={() => setReloadKey((k) => k + 1)}>
            다시 시도
          </button>
        </p>
      )}
      {state.loaded && !state.error && data === null && (
        <p className="muted">발행 현황은 데스크톱 앱에서 볼 수 있습니다(웹에는 이 기능이 없습니다).</p>
      )}

      {data && (
        <>
          {data.issues.length > 0 && (
            <div className="error" role="alert">
              {data.issues.map((i) => (
                <p key={`${i.tenantId}|${i.error}`} className="ps-issue">
                  <b>{i.brand}</b> — {i.error}
                </p>
              ))}
            </div>
          )}
          {markError && (
            <p className="error" role="alert">
              {markError}
            </p>
          )}

          {rows.length === 0 ? (
            <p className="muted">
              아직 올린 글도 작성자 배정도 없습니다. <Link to="/content-library">콘텐츠 보관함</Link>에서 올린 주소를 적으면 여기에 모입니다.
            </p>
          ) : (
            <>
              <section className="ps-summary" aria-label="요약">
                {tiles.map((t) => (
                  <div key={t.label} className={`ps-sum${t.tone ? ` ${t.tone}` : ''}`}>
                    <span className="ps-sum-label">{t.label}</span>
                    <span className="ps-sum-value">{t.value}</span>
                    <span className="ps-sum-sub">{t.sub}</span>
                  </div>
                ))}
              </section>

              {writers.length > 0 && (
                <section className="ps-writers" aria-label="작성자별 진행">
                  {writerBrands.map((tenantId) => (
                    <div key={tenantId} className="ps-writer-row">
                      <span className="ps-writer-brand">{writers.find((w) => w.tenantId === tenantId)?.brand}</span>
                      {writers
                        .filter((w) => w.tenantId === tenantId)
                        .map((w) => {
                          const value = `${w.key}\n${w.name}`
                          const on = filter.writer === value && filter.tenantId === tenantId
                          return (
                            <button
                              key={w.key}
                              type="button"
                              className={`ps-writer${on ? ' on' : ''}${w.posted >= w.assigned ? ' done' : ''}`}
                              aria-pressed={on}
                              title={`${w.key} · ${w.name} — 배정 ${w.assigned}편 중 ${w.posted}편 올림`}
                              onClick={() => patchFilter(on ? { writer: '' } : { tenantId, writer: value })}
                            >
                              {w.key} · {w.name}
                              <span className="ps-writer-n">
                                올림 {w.posted}/{w.assigned}
                              </span>
                            </button>
                          )
                        })}
                    </div>
                  ))}
                </section>
              )}

              <div className="ps-tools">
                <label className="ps-field">
                  <span>브랜드</span>
                  <select value={filter.tenantId} onChange={(e) => patchFilter({ tenantId: e.target.value, writer: '' })}>
                    <option value="">모든 브랜드</option>
                    {brands.map(([id, brand]) => (
                      <option key={id} value={id}>
                        {brand}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="ps-field">
                  <span>작성자</span>
                  <select value={filter.writer} onChange={(e) => patchFilter({ writer: e.target.value })}>
                    <option value="">모든 작성자</option>
                    {writerOptions.map(([value, text]) => (
                      <option key={value} value={value}>
                        {text}
                      </option>
                    ))}
                  </select>
                </label>
                {(['naver', 'google'] as const).map((engine) => (
                  <label key={engine} className="ps-field">
                    <span>{engine === 'naver' ? '네이버 노출' : '구글 색인'}</span>
                    <select
                      value={filter[engine]}
                      onChange={(e) => {
                        const value = e.target.value as StateFilter
                        patchFilter(engine === 'naver' ? { naver: value } : { google: value })
                      }}
                    >
                      <option value="">전체</option>
                      <option value="shown">{SHOWN_WORD[engine]}</option>
                      <option value="not-yet">아직</option>
                      <option value="unknown">미확인</option>
                    </select>
                  </label>
                ))}
                <button
                  type="button"
                  className={`ps-due${filter.dueOnly ? ' on' : ''}`}
                  aria-pressed={filter.dueOnly}
                  onClick={() => patchFilter({ dueOnly: !filter.dueOnly })}
                >
                  오늘 다시 볼 글 <span className="ps-writer-n">{sum.due}</span>
                </button>
                <label className="ps-toggle">
                  <input type="checkbox" checked={filter.showUnposted} onChange={(e) => patchFilter({ showUnposted: e.target.checked })} />
                  아직 안 올린 글
                </label>
                <label className="ps-toggle">
                  <input type="checkbox" checked={filter.showRemoved} onChange={(e) => patchFilter({ showRemoved: e.target.checked })} />
                  내린 · 뺀 글
                </label>
              </div>

              {shown.length === 0 ? (
                <p className="muted">고른 조건에 맞는 글이 없습니다.</p>
              ) : (
                <div className="table-wrap">
                  <table className="ps-table">
                    <thead>
                      <tr>
                        <th scope="col">브랜드</th>
                        <th scope="col">작성자</th>
                        <th scope="col">글 제목</th>
                        <th scope="col">플랫폼</th>
                        <th scope="col">주소</th>
                        <th scope="col">발행일</th>
                        <th scope="col">네이버 노출</th>
                        <th scope="col">구글 색인</th>
                        <th scope="col">다시 볼 날</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((r) => (
                        <tr key={r.rowKey} className={r.removed ? 'ps-removed' : r.kind === 'unposted' ? 'ps-unposted' : undefined}>
                          <td className="ps-nowrap">{r.brand}</td>
                          <td
                            className={`ps-nowrap${r.writer ? '' : ' muted'}`}
                            title={r.writerUnknown ? '배정 파일(probe-plan.json)을 읽지 못해 작성자를 모릅니다' : undefined}
                          >
                            {writerLabel(r)}
                          </td>
                          <td className="ps-title">
                            {r.title ?? <span className="muted">제목 미확인</span>}
                            {r.kind === 'unposted' && <span className="chip ps-tag">아직 안 올림</span>}
                            {r.removed && <span className="chip ps-tag">{recheckCell(r, today)}</span>}
                          </td>
                          <td className="ps-nowrap">{r.platform?.label ?? '—'}</td>
                          <td className="ps-url">
                            {r.url ? (
                              <a href={r.url} target="_blank" rel="noreferrer" title={r.url}>
                                {shortUrl(r.url)}
                              </a>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="mono">{r.kind === 'unposted' ? '—' : (r.publishedOn ?? '모름')}</td>
                          <IndexCell row={r} engine="naver" busy={busy === `${r.rowKey}|naver`} onMark={mark} />
                          <IndexCell row={r} engine="google" busy={busy === `${r.rowKey}|google`} onMark={mark} />
                          <RecheckView row={r} today={today} />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </>
      )}
    </>
  )
}
