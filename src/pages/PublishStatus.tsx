import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import PostImportPanel from '../components/PostImportPanel'
import { commitPostImport, loadPublishStatus, patchExternalPost, saveIndexCheck } from '../lib/api'
import { downloadCsv } from '../lib/fileDownload'
import { safeFileName } from '../lib/markdownFile'
import { externalResultText } from '../lib/postImport'
import { todayKst } from '../lib/publishedUrl'
import { monthDay } from '../lib/publishTracking'
import {
  emptyStateOf,
  ENGINE_NAME,
  filterRows,
  googleSearchUrl,
  indexStateLabel,
  markLabel,
  naverSearchUrl,
  publishStatusCsv,
  publishStatusFileName,
  recheckCell,
  rowName,
  rowRecheck,
  sameUrlBrands,
  searchLabel,
  SHOWN_WORD,
  summarizeStatus,
  toggleWriterChip,
  unpostedLabel,
  validFilter,
  withIndexRecord,
  WRITER_UNKNOWN_NOTE,
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

/** 주소 칸에 보일 글자 — http(s)://를 뗀다(누르면 전체 주소로 연다). */
const shortUrl = (url: string) => url.replace(/^https?:\/\//i, '').replace(/\/+$/, '')

type MarkFn = (row: PublishStatusRow, engine: IndexEngine, state: IndexState | null) => void

/**
 * 네이버 노출 · 구글 색인 칸 — 상태와 확인한 날, 검색 창을 여는 링크(데스크톱 앱은 시스템 브라우저로 연다 — electron/main.cjs
 * setWindowOpenHandler), 본 결과를 적는 단추. 같은 상태를 다시 누르면 확인한 날이 오늘로 바뀐다(다시 볼 날에 「아직」을 다시 확인한 것).
 * 단추 · 링크 이름에 브랜드 · 제목을 넣어 화면 읽기 프로그램이 어느 글의 것인지 알게 한다.
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
          {monthDay(check.checkedOn)} 확인{row.checkFrom ? ` · ${row.checkFrom} 줄에서` : ''}
        </span>
      )}
      {!row.removed && (
        <div className="ps-index-actions">
          {searchUrl && (
            <a className="ps-search" href={searchUrl} target="_blank" rel="noreferrer" aria-label={searchLabel(row, engine)}>
              {name}에서 확인
            </a>
          )}
          <button
            type="button"
            className="ps-mark"
            aria-pressed={check?.state === 'shown'}
            aria-label={markLabel(row, engine, 'shown', check)}
            disabled={busy}
            onClick={() => onMark(row, engine, 'shown')}
          >
            {SHOWN_WORD[engine]}
          </button>
          <button
            type="button"
            className="ps-mark"
            aria-pressed={check?.state === 'not-yet'}
            aria-label={markLabel(row, engine, 'not-yet', check)}
            disabled={busy}
            onClick={() => onMark(row, engine, 'not-yet')}
          >
            아직
          </button>
          {check && (
            <button type="button" className="ps-mark ps-clear" aria-label={markLabel(row, engine, null, check)} disabled={busy} onClick={() => onMark(row, engine, null)}>
              지우기
            </button>
          )}
        </div>
      )}
    </td>
  )
}

/** 다시 볼 날 칸 — 오늘 다시 볼 글이면 어느 엔진인지(CSV와 같은 글자), 아니면 다음 날 · 14일 지남 · 확인 끝 · 모름. */
function RecheckView({ row, today }: { row: PublishStatusRow; today: string }) {
  if (row.kind === 'unposted') return <td />
  if (row.removed) return <td className="muted">{recheckCell(row, today)}</td>
  const r = rowRecheck(row, today)
  if (r.due) {
    return (
      <td>
        <span className="chip warn">{r.label}</span>
        <span className="ps-date">{r.note}</span>
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

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const validDay = (day: string, limit: string) => /^\d{4}-\d{2}-\d{2}$/.test(day) && day <= limit && day >= '2020-01-01'

/**
 * 앱 밖 글 줄의 「관리」(server/externalPosts.ts) — 올린 날 고치기(「모름」 포함), 다른 브랜드에도 추적, 빼기(잘못 적음 · 글을 내림 — 이 브랜드
 * 줄에만), 되살리기(잘못 적음으로 뺀 줄만 — 내린 글을 다시 올렸으면 새로 적어 내린 기간을 남긴다). 빼면서 「새 글 찾기에서도 숨김」을 고르면
 * 빼기를 먼저 하고 무시 목록에 적는다 — 무시가 걸리면 뺀 것은 그대로 두고 알린다(C17). 같은 주소를 다른 브랜드가 아직 추적하거나 앱 글로
 * 가졌으면 새 글 찾기에는 이미 나오지 않으므로 그렇게 알린다. 다른 브랜드에 적어도 되는지는 서버가 그 브랜드 원장으로 가린다(D13).
 */
function ExternalManage({
  row,
  rows,
  brands,
  today,
  onChanged,
}: {
  row: PublishStatusRow
  rows: readonly PublishStatusRow[]
  brands: readonly { tenantId: string; brand: string }[]
  today: string
  onChanged: (note: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [date, setDate] = useState(row.publishedOn ?? '')
  const [dateUnknown, setDateUnknown] = useState(row.publishedOn === null)
  const [more, setMore] = useState<string[]>([])
  const [reason, setReason] = useState<'mistake' | 'taken-down'>('mistake')
  const [hide, setHide] = useState(false)
  if (!row.postId || !row.url) return null
  const postId = row.postId
  const url = row.url
  const live = !row.removed
  // 같은 주소를 아직 다른 브랜드가 앱 밖 글로 추적하거나 어느 브랜드든 앱 글로 가졌다 — 새 글 찾기에서 이미 빠진다.
  const stillHidden = [
    ...new Set(
      rows
        .filter((r) => r.key === row.key && r.kind === 'posted' && !r.removed && r.rowKey !== row.rowKey && (r.origin === 'app' || r.tenantId !== row.tenantId))
        .map((r) => (r.origin === 'app' ? `${r.brand}의 앱 글` : r.brand)),
    ),
  ]
  const trackingIn = new Set(rows.filter((r) => r.key === row.key && r.origin === 'external' && !r.removed).map((r) => r.tenantId))
  const addable = brands.filter((b) => b.tenantId !== row.tenantId && !trackingIn.has(b.tenantId))
  const run = async (work: () => Promise<string>) => {
    setBusy(true)
    setError(null)
    try {
      onChanged(await work())
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }
  const saveDate = () => {
    if (!dateUnknown && !validDay(date, today)) {
      setError(`올린 날을 2020-01-01부터 오늘(${today})까지에서 고르거나 「모름」을 체크해 주세요.`)
      return
    }
    void run(async () => {
      await patchExternalPost(row.tenantId, postId, { publishedOn: dateUnknown ? null : date })
      return `「${row.title ?? '제목 미확인'}」(${row.brand}) 올린 날을 ${dateUnknown ? '모름으로' : `${date}로`} 고쳤습니다.`
    })
  }
  const track = () =>
    void run(async () => {
      const { results } = await commitPostImport([
        { kind: 'external', tenantIds: more, url, title: row.title, publishedOn: row.publishedOn, publishedOnSource: row.publishedOn ? 'user' : 'unknown' },
      ])
      const r = results[0]
      if (!r || r.kind !== 'external') throw new Error('서버 응답을 읽지 못했습니다.')
      setMore([])
      return `「${row.title ?? '제목 미확인'}」 — ${externalResultText(r)}`
    })
  const remove = () =>
    void run(async () => {
      await patchExternalPost(row.tenantId, postId, { remove: reason })
      const done = `「${row.title ?? '제목 미확인'}」을(를) ${row.brand}에서 뺐습니다(${reason === 'mistake' ? '잘못 적음' : '글을 내림'}).`
      if (!hide) return done
      if (stillHidden.length > 0) return `${done} ${stillHidden.join(', ')}에 남아 있어 새 글 찾기에는 이미 나오지 않습니다.`
      try {
        const { results } = await commitPostImport([{ kind: 'ignore', url }])
        const r = results[0]
        if (r && r.status !== 'error') return `${done} 새 글 찾기에서도 숨깁니다.`
        return `${done} 다만 새 글 찾기에서 숨기지 못했습니다 — ${r?.error ?? '서버 응답을 읽지 못했습니다.'}`
      } catch (err) {
        return `${done} 다만 새 글 찾기에서 숨기지 못했습니다 — ${message(err)}`
      }
    })
  const restore = () =>
    void run(async () => {
      await patchExternalPost(row.tenantId, postId, { restore: true })
      return `「${row.title ?? '제목 미확인'}」을(를) ${row.brand}에서 다시 추적합니다.`
    })
  const name = rowName(row)
  return (
    <details className="ps-manage">
      <summary aria-label={`${name} 앱 밖 글 관리`}>관리</summary>
      <div className="ps-manage-body">
        {live && (
          <>
            <fieldset disabled={busy}>
              <legend>올린 날</legend>
              <div className="ps-manage-row">
                <input type="date" className="pi-date" value={date} min="2020-01-01" max={today} disabled={dateUnknown} onChange={(e) => setDate(e.target.value)} aria-label={`${name} 올린 날`} />
                <label className="ps-toggle">
                  <input type="checkbox" checked={dateUnknown} onChange={(e) => setDateUnknown(e.target.checked)} />
                  모름
                </label>
                <button type="button" className="ps-mark" onClick={saveDate}>
                  저장
                </button>
              </div>
            </fieldset>
            <fieldset disabled={busy}>
              <legend>다른 브랜드에도 추적</legend>
              {addable.length === 0 ? (
                <p className="ps-date">더 고를 고객 브랜드가 없습니다.</p>
              ) : (
                <ul className="ps-manage-brands">
                  {addable.map((b) => (
                    <li key={b.tenantId}>
                      <label>
                        <input
                          type="checkbox"
                          checked={more.includes(b.tenantId)}
                          onChange={(e) => setMore((m) => (e.target.checked ? [...m, b.tenantId] : m.filter((t) => t !== b.tenantId)))}
                        />
                        {b.brand}
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              <button type="button" className="ps-mark" onClick={track} disabled={more.length === 0}>
                추적 시작
              </button>
              <p className="ps-date">그 브랜드의 측정 답변으로 따로 셉니다. 그 브랜드에 앱 글로 적힌 주소는 적지 않습니다.</p>
            </fieldset>
            <fieldset disabled={busy}>
              <legend>빼기 — 이 브랜드 줄만</legend>
              <div className="ps-manage-row">
                <label className="ps-toggle">
                  <input type="radio" name={`ps-remove-${row.rowKey}`} checked={reason === 'mistake'} onChange={() => setReason('mistake')} />
                  잘못 적음
                </label>
                <label className="ps-toggle">
                  <input type="radio" name={`ps-remove-${row.rowKey}`} checked={reason === 'taken-down'} onChange={() => setReason('taken-down')} />
                  글을 내림
                </label>
              </div>
              <label className="ps-toggle">
                <input type="checkbox" checked={hide} onChange={(e) => setHide(e.target.checked)} disabled={stillHidden.length > 0} />
                새 글 찾기에서도 숨김
              </label>
              {stillHidden.length > 0 && <p className="ps-date">같은 주소가 {stillHidden.join(', ')}에 남아 있어 새 글 찾기에는 이미 나오지 않습니다.</p>}
              <button type="button" className="ps-mark" onClick={remove}>
                빼기
              </button>
            </fieldset>
          </>
        )}
        {row.removed?.reason === 'mistake' && (
          <button type="button" className="ps-mark" onClick={restore} disabled={busy}>
            되살리기
          </button>
        )}
        {row.removed?.reason === 'taken-down' && <p className="ps-date">다시 올렸으면 「주소 한꺼번에 등록」에서 새로 적어 주세요(내린 기간이 남습니다).</p>}
        {row.removed?.reason === 'moved' && (
          <p className="ps-date">같은 브랜드에 앱 글로 적혀 쉬고 있습니다 — 그 앱 글 기록을 콘텐츠 보관함에서 「잘못 적음」으로 빼면 다시 추적합니다.</p>
        )}
        {error && (
          <p className="error ps-date" role="alert">
            {error}
          </p>
        )}
      </div>
    </details>
  )
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
  const [filterState, setFilter] = useState<StatusFilter>(DEFAULT_FILTER)
  // 작성자 칩으로 거르기를 켜기 전의 브랜드 거르기 — 칩을 끄면 여기로 돌아간다. 손으로 고르면 null.
  const [chipBefore, setChipBefore] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [markError, setMarkError] = useState<string | null>(null)
  // 앱 밖 글 「관리」에서 바꾼 결과 — 표를 다시 읽은 뒤에도 남긴다(무시를 못 했으면 그 까닭까지).
  const [manageNote, setManageNote] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void loadPublishStatus().then(
      (value) => {
        if (!alive) return
        setState({ loaded: true, value, error: null })
        // 고른 브랜드 · 작성자가 새 줄에 없으면(브랜드 파일이 깨졌다 · 지웠다 · 배정이 바뀌었다) 모두로 되돌린다.
        if (value) setFilter((f) => validFilter(f, value.rows))
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
  // 거르기는 늘 지금 줄에 있는 브랜드 · 작성자로 본다(읽은 직후에도 되돌리지만, 그 사이 한 번 그리는 값도 어긋나지 않게).
  const filter = validFilter(filterState, rows)
  const patchFilter = (patch: Partial<StatusFilter>) => setFilter((f) => ({ ...validFilter(f, rows), ...patch }))
  const pickFilter = (patch: Partial<StatusFilter>) => {
    patchFilter(patch)
    setChipBefore(null)
  }

  const mark: MarkFn = (row, engine, next) => {
    if (!row.postId) return
    const cell = `${row.rowKey}|${engine}`
    setBusy(cell)
    setMarkError(null)
    saveIndexCheck(row.tenantId, row.postId, engine, next)
      .then((record) => {
        // 같은 주소의 줄 모두(다른 고객 브랜드 포함) — 다시 읽은 것과 같은 값이 된다.
        setState((s) => (s.value ? { ...s, value: { ...s.value, rows: withIndexRecord(s.value.rows, row, record) } } : s))
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
  const sameUrl = sameUrlBrands(rows)
  const empty = data ? emptyStateOf(data) : null

  const exportCsv = () => downloadCsv(safeFileName(publishStatusFileName(today)), publishStatusCsv(shown, today))
  const tiles = [
    // 앱 밖 글이 있으면 올린 글을 앱 글 · 앱 밖 글로 나눠 보인다(같은 주소가 한 브랜드에서라도 앱 글이면 앱 글 — 합이 올린 글).
    { label: '올린 글', value: sum.posted, sub: sum.external > 0 ? `앱 글 ${sum.app} · 앱 밖 ${sum.external}` : '뺀 글 · 안 올린 글 제외', tone: '' },
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
        본 결과대로 「노출됨 · 색인됨」 또는 「아직」을 누르세요. 누르지 않은 글은 「미확인」입니다. 올린 뒤 3 · 7 · 14일째에 다시 봅니다. 「앱 밖 글」은
        앱에서 만들지 않은 글입니다 — 작성자 진행 · 점수 · 보고서에는 넣지 않고, 다시 볼 날은 추적을 시작한 날부터 셉니다.
      </p>
      {/* 작성자들이 보낸 주소를 한꺼번에 적는다 — 적으면 이 표를 다시 읽는다. 오늘은 서버가 센 날(읽기 전이면 이 PC의 한국 날짜). */}
      <PostImportPanel today={today || todayKst()} brands={data?.brands ?? []} onRegistered={() => setReloadKey((k) => k + 1)} />

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
                  {!rows.some((r) => r.tenantId === i.tenantId) && ' 이 브랜드의 줄은 표에 보이지 않습니다.'}
                </p>
              ))}
            </div>
          )}
          {markError && (
            <p className="error" role="alert">
              {markError}
            </p>
          )}
          {manageNote && (
            <p className="pi-note" role="status">
              {manageNote}
            </p>
          )}

          {empty === 'issues' ? (
            <p className="muted">파일을 읽지 못한 브랜드가 있어 보일 줄이 없습니다. 위 오류의 파일을 고친 뒤 「다시 읽기」를 누르세요.</p>
          ) : empty === 'empty' ? (
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
                              title={`${w.key} · ${w.name} — 배정 ${w.assigned}편 중 ${w.posted}편 올림${w.unsure ? ` · ${w.unsure}편은 올렸는지 미확인(글을 쓴 질문지 판을 모름)` : ''}`}
                              onClick={() => {
                                const next = toggleWriterChip(filter, { tenantId, writer: value }, chipBefore)
                                setFilter(next.filter)
                                setChipBefore(next.before)
                              }}
                            >
                              {w.key} · {w.name}
                              <span className="ps-writer-n">
                                올림 {w.posted}/{w.assigned}
                                {w.unsure ? ` · 미확인 ${w.unsure}` : ''}
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
                  <select value={filter.tenantId} onChange={(e) => pickFilter({ tenantId: e.target.value, writer: '' })}>
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
                  <select value={filter.writer} onChange={(e) => pickFilter({ writer: e.target.value })}>
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
                <div className="table-wrap ps-table-wrap">
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
                          <td className={`ps-nowrap${r.writer ? '' : ' muted'}`} title={r.writerUnknown ? WRITER_UNKNOWN_NOTE[r.writerUnknown] : undefined}>
                            {writerLabel(r)}
                          </td>
                          <td className="ps-title">
                            {r.title ?? <span className="muted">제목 미확인</span>}
                            {r.origin === 'external' && (
                              <span className="chip info ps-tag" title="앱에서 만들지 않은 글 — 작성자 진행 · 점수 · 보고서에 넣지 않습니다">
                                앱 밖 글
                              </span>
                            )}
                            {r.kind === 'unposted' && <span className="chip ps-tag">{unpostedLabel(r)}</span>}
                            {r.removed && <span className="chip ps-tag">{recheckCell(r, today)}</span>}
                            {r.origin === 'external' && (
                              <ExternalManage
                                key={`${r.rowKey}|${r.publishedOn ?? ''}|${r.removed?.reason ?? ''}`}
                                row={r}
                                rows={rows}
                                brands={data.brands ?? []}
                                today={today}
                                onChanged={(note) => {
                                  setManageNote(note)
                                  setReloadKey((k) => k + 1)
                                }}
                              />
                            )}
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
                            {r.key && !r.removed && sameUrl.has(r.key) && (
                              <span className="ps-date">같은 주소: {sameUrl.get(r.key)!.filter((b) => b !== r.brand).join(', ')}</span>
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
