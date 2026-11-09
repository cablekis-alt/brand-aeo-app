import { useEffect, useRef, useState } from 'react'
import { commitPostImport, listImportBlogPosts, loadBlogSources, readImportPost, saveBlogSources } from '../lib/api'
import {
  autoPick,
  checkedByDefault,
  extractPostUrls,
  normalizeBlogSource,
  POST_PLATFORM_LABEL,
  ROW_STATE_LABEL,
  rowStateOf,
  scorePercent,
  type BlogListResult,
  type BlogSource,
  type ExtractedUrls,
  type ImportCandidate,
  type PostImportRead,
  type RowPick,
  type RowState,
} from '../lib/postImport'
import { trackingKey } from '../lib/publishedUrl'

/** 한 번에 읽는 주소 수(서버도 바깥 요청을 3개로 묶는다). */
const READ_CONCURRENCY = 3
/** 등록 요청 한 번에 보내는 줄 수(서버 상한 100줄 · JSON 100KB 안). */
const COMMIT_CHUNK = 40

interface ImportRow {
  /** 추적 키 — 같은 글은 한 줄. */
  key: string
  url: string
  status: 'waiting' | 'reading' | 'done' | 'stopped'
  read: PostImportRead | null
  /** 짝지을 앱 글. null이면 「앱 글 아님」. */
  pick: RowPick | null
  checked: boolean
  /** 올린 날(YYYY-MM-DD) — 페이지 날짜로 채우고 사람이 고친다. 모르면 빈 글자(사람이 골라야 등록된다). */
  date: string
  result: { kind: 'added' | 'existing' | 'error'; text: string } | null
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** 주소 칸에 보일 글자 — http(s)://를 떼고 한글 주소는 풀어 보인다. */
function shortUrl(url: string): string {
  let shown: string
  try {
    shown = decodeURI(url)
  } catch {
    shown = url
  }
  return shown.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
}

const validDay = (day: string, today: string) => /^\d{4}-\d{2}-\d{2}$/.test(day) && day <= today && day >= '2020-01-01'
const pickValue = (p: RowPick | null) => (p ? `${p.tenantId}\n${p.articleId}` : '')
const samePick = (c: ImportCandidate, p: RowPick | null) => p !== null && c.tenantId === p.tenantId && c.articleId === p.articleId

const STATE_TONE: Record<RowState, string> = { match: 'good', review: 'warn', none: '', already: 'info', other: 'bad', unreadable: 'bad' }
const BLOCKED: readonly RowState[] = ['already', 'other', 'unreadable']

function writerText(c: ImportCandidate | undefined): string {
  if (!c) return '—'
  if (c.writer) return `${c.writer.key} · ${c.writer.name}`
  return c.writerUnknown ? '미확인' : '배정 없음'
}

function listNote(r: BlogListResult): string {
  const older = r.older > 0 ? ` · 더 오래된 새 글 ${r.older}편은 뺐습니다` : ''
  const errors = r.errors.length > 0 ? ` · 읽지 못한 목록: ${r.errors.join(' / ')}` : ''
  return `찾은 글 ${r.found}편 · 새 글 ${r.newUrls.length}편${older}${errors}`
}

/** 읽기를 마친 줄의 상태 · 고를 수 있는지 · 고른 후보. */
function rowView(row: ImportRow) {
  const read = row.read
  if (row.status !== 'done' || !read) return { state: null, verdict: null, candidate: undefined, registrable: false }
  const { state, verdict } = rowStateOf(read, row.pick)
  const candidate = read.ok ? read.candidates.find((c) => samePick(c, row.pick)) : undefined
  const done = row.result?.kind === 'added' || row.result?.kind === 'existing'
  return { state, verdict, candidate, registrable: read.ok && row.pick !== null && !BLOCKED.includes(state) && !done }
}

/**
 * 주소 한꺼번에 등록 — 발행 현황(src/pages/PublishStatus.tsx) 위에 접혀 있다. 작성자가 보낸 메일을 붙여 넣거나 저장한 블로그의 새 글을
 * 찾으면, 서버가 글마다 페이지를 읽어 모든 고객 브랜드의 앱 글과 맞춘다(server/postImport.ts · src/lib/postImport.ts). 「맞음」 줄만 미리
 * 체크해 두고, 사람이 확인 필요 줄의 글을 고르고 날짜를 확인한 뒤 「이대로 등록」을 누르면 「올렸어요」와 같은 기록으로 적는다. 웹에는
 * 라우트가 없어 「데스크톱 앱에서만」을 보인다.
 */
export default function PostImportPanel({ today, onRegistered }: { today: string; onRegistered: () => void }) {
  const [available, setAvailable] = useState<'loading' | 'yes' | 'no'>('loading')
  const [sources, setSources] = useState<BlogSource[]>([])
  const [sourceInput, setSourceInput] = useState('')
  const [sourceBusy, setSourceBusy] = useState(false)
  const [sourceError, setSourceError] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [extracted, setExtracted] = useState<(ExtractedUrls & { added: number }) | null>(null)
  const [rows, setRows] = useState<ImportRow[]>([])
  const [phase, setPhase] = useState<{ kind: 'list'; done: number; total: number } | { kind: 'read' } | null>(null)
  const [listNotes, setListNotes] = useState<{ source: string; text: string; error: boolean }[]>([])
  const [committing, setCommitting] = useState(false)
  const [commitNote, setCommitNote] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    let alive = true
    loadBlogSources().then(
      (list) => {
        if (!alive) return
        setAvailable(list === null ? 'no' : 'yes')
        if (list) setSources(list)
      },
      (err: unknown) => {
        if (!alive) return
        setAvailable('yes')
        setSourceError(`저장한 블로그를 읽지 못했습니다 — ${message(err)}`)
      },
    )
    return () => {
      alive = false
    }
  }, [])
  // 화면을 떠나면 읽던 것을 멈춘다.
  useEffect(() => () => abortRef.current?.abort(), [])

  const busy = phase !== null || committing
  const patchRow = (key: string, patch: Partial<ImportRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)))

  /** 주소들을 차례로 읽는다(한 번에 READ_CONCURRENCY개). 「멈추기」를 누르면 남은 주소는 「멈춤」. */
  const readAll = async (targets: { key: string; url: string }[]) => {
    if (targets.length === 0) return
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setPhase({ kind: 'read' })
    let next = 0
    const worker = async () => {
      while (next < targets.length && !ctrl.signal.aborted) {
        const t = targets[next++]!
        patchRow(t.key, { status: 'reading', result: null })
        try {
          const read = await readImportPost(t.url, ctrl.signal)
          patchRow(t.key, { status: 'done', read, pick: autoPick(read), checked: checkedByDefault(read), date: read.ok ? (read.post.publishedOn ?? '') : '' })
        } catch (err) {
          if (ctrl.signal.aborted) patchRow(t.key, { status: 'stopped' })
          else patchRow(t.key, { status: 'done', read: { ok: false, url: t.url, key: t.key, error: message(err) }, pick: null, checked: false })
        }
      }
    }
    await Promise.all(Array.from({ length: READ_CONCURRENCY }, worker))
    if (ctrl.signal.aborted) setRows((rs) => rs.map((r) => (r.status === 'waiting' || r.status === 'reading' ? { ...r, status: 'stopped' } : r)))
    if (abortRef.current === ctrl) abortRef.current = null
    setPhase(null)
  }

  /** 표에 없는 글 주소만 줄로 더하고 읽는다. 더한 수를 돌려준다. */
  const addAndRead = (urls: string[]): number => {
    const known = new Set(rows.map((r) => r.key))
    const fresh: { key: string; url: string }[] = []
    for (const url of urls) {
      const key = trackingKey(url)
      if (!key || known.has(key)) continue
      known.add(key)
      fresh.push({ key, url })
    }
    if (fresh.length === 0) return 0
    setRows((rs) => [...rs, ...fresh.map((f): ImportRow => ({ ...f, status: 'waiting', read: null, pick: null, checked: false, date: '', result: null }))])
    void readAll(fresh)
    return fresh.length
  }

  const onExtract = () => {
    const ex = extractPostUrls(text)
    setCommitNote(null)
    setExtracted({ ...ex, added: addAndRead(ex.urls) })
  }

  const saveSources = async (urls: string[]): Promise<boolean> => {
    setSourceBusy(true)
    setSourceError(null)
    try {
      setSources(await saveBlogSources(urls))
      return true
    } catch (err) {
      setSourceError(`저장하지 못했습니다 — ${message(err)}`)
      return false
    } finally {
      setSourceBusy(false)
    }
  }
  const addSource = async () => {
    const norm = normalizeBlogSource(sourceInput)
    if (!norm.ok) {
      setSourceError(norm.error)
      return
    }
    if (sources.some((s) => s.url === norm.url)) {
      setSourceError(`이미 저장한 블로그입니다: ${norm.url}`)
      return
    }
    const submitted = sourceInput
    // 저장을 기다리는 사이 새로 적은 주소는 지우지 않는다.
    if (await saveSources([...sources.map((s) => s.url), norm.url])) setSourceInput((cur) => (cur === submitted ? '' : cur))
  }

  /** 저장한 블로그마다 새 글을 찾아 표에 더하고 읽는다. */
  const findNew = async () => {
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setListNotes([])
    setCommitNote(null)
    const found: string[] = []
    for (const [i, s] of sources.entries()) {
      if (ctrl.signal.aborted) break
      setPhase({ kind: 'list', done: i, total: sources.length })
      try {
        const r = await listImportBlogPosts(s.url, ctrl.signal)
        found.push(...r.newUrls)
        setListNotes((n) => [...n, { source: s.url, text: listNote(r), error: r.found === 0 && r.errors.length > 0 }])
      } catch (err) {
        if (ctrl.signal.aborted) break
        setListNotes((n) => [...n, { source: s.url, text: `목록을 읽지 못했습니다 — ${message(err)}`, error: true }])
      }
    }
    if (abortRef.current === ctrl) abortRef.current = null
    setPhase(null)
    if (!ctrl.signal.aborted) addAndRead(found)
  }

  const choose = (row: ImportRow, value: string) => {
    const [tenantId, articleId] = value.split('\n')
    const pick = value && tenantId && articleId ? { tenantId, articleId } : null
    const state = row.read ? rowStateOf(row.read, pick).state : null
    patchRow(row.key, { pick, checked: pick !== null && state !== null && !BLOCKED.includes(state), result: null })
  }

  const retry = () => {
    const targets = rows.filter((r) => r.status === 'stopped' || (r.status === 'done' && r.read && !r.read.ok)).map((r) => ({ key: r.key, url: r.url }))
    for (const t of targets) patchRow(t.key, { status: 'waiting', read: null, pick: null, checked: false, result: null })
    void readAll(targets)
  }

  const register = async () => {
    const chosen = rows.filter((r) => r.checked && rowView(r).registrable)
    if (chosen.length === 0) return
    setCommitting(true)
    setCommitNote(null)
    const noDate = chosen.filter((r) => !validDay(r.date, today))
    for (const r of noDate) patchRow(r.key, { result: { kind: 'error', text: `올린 날을 골라 주세요(오늘 ${today}까지).` } })
    const ready = chosen.filter((r) => validDay(r.date, today))
    let added = 0
    let existing = 0
    let failed = noDate.length
    for (let i = 0; i < ready.length; i += COMMIT_CHUNK) {
      const chunk = ready.slice(i, i + COMMIT_CHUNK)
      try {
        const results = await commitPostImport(chunk.map((r) => ({ tenantId: r.pick!.tenantId, articleId: r.pick!.articleId, url: r.url, publishedOn: r.date })))
        results.forEach((res, j) => {
          const r = chunk[j]!
          if (res.status === 'added') {
            added += 1
            patchRow(r.key, { checked: false, result: { kind: 'added', text: '등록함' } })
          } else if (res.status === 'existing') {
            existing += 1
            patchRow(r.key, { checked: false, result: { kind: 'existing', text: '이미 있던 기록 — 그대로 둠' } })
          } else {
            failed += 1
            patchRow(r.key, { result: { kind: 'error', text: res.error ?? '등록하지 못했습니다.' } })
          }
        })
      } catch (err) {
        failed += chunk.length
        for (const r of chunk) patchRow(r.key, { result: { kind: 'error', text: `등록하지 못했습니다 — ${message(err)}` } })
      }
    }
    setCommitting(false)
    setCommitNote(`등록 ${added}편 · 이미 있던 기록 ${existing}편${failed > 0 ? ` · 걸림 ${failed}편(그 줄의 이유를 보세요)` : ''}`)
    if (added > 0) onRegistered()
  }

  const clear = () => {
    setRows([])
    setExtracted(null)
    setListNotes([])
    setCommitNote(null)
  }

  const views = rows.map((r) => ({ row: r, ...rowView(r) }))
  const doneCount = rows.filter((r) => r.status === 'done').length
  const counts = (Object.keys(ROW_STATE_LABEL) as RowState[])
    .map((s) => [s, views.filter((v) => v.state === s).length] as const)
    .filter(([, n]) => n > 0)
  const checkedCount = views.filter((v) => v.row.checked && v.registrable).length
  const retryable = rows.filter((r) => r.status === 'stopped' || (r.status === 'done' && r.read && !r.read.ok)).length
  // 같은 앱 글을 둘 이상의 체크한 줄이 고르면 알린다 — 두 주소 모두 그 글의 기록이 된다.
  const pickCount = new Map<string, number>()
  for (const v of views) if (v.row.checked && v.registrable) pickCount.set(pickValue(v.row.pick), (pickCount.get(pickValue(v.row.pick)) ?? 0) + 1)

  return (
    <details className="pi-panel">
      <summary>
        <span className="pi-title">주소 한꺼번에 등록</span>
        <span className="pi-sub">작성자가 보낸 글 주소를 읽어 앱 글과 맞춘 뒤 확인한 것만 올린 글로 적습니다</span>
      </summary>
      {available === 'loading' && <p className="muted">불러오는 중…</p>}
      {available === 'no' && <p className="muted">주소 한꺼번에 등록은 데스크톱 앱에서 할 수 있습니다(웹에는 이 기능이 없습니다).</p>}
      {available === 'yes' && (
        <div className="pi-body">
          <div className="pi-inputs">
            <section className="pi-box" aria-labelledby="pi-paste-title">
              <h3 id="pi-paste-title">메일 · 메모에서 주소 찾기</h3>
              <label className="pi-label" htmlFor="pi-paste">
                받은 메일이나 메모를 그대로 붙여 넣으세요. 글 주소만 골라 읽습니다.
              </label>
              <textarea id="pi-paste" className="pi-textarea" rows={5} value={text} onChange={(e) => setText(e.target.value)} disabled={busy} />
              <div className="pi-row">
                <button type="button" className="btn primary" onClick={onExtract} disabled={busy || !text.trim()}>
                  주소 읽기
                </button>
              </div>
              {extracted && (
                <div className="pi-note" role="status">
                  글 주소 {extracted.urls.length}개 · 새로 읽을 주소 {extracted.added}개
                  {extracted.urls.length > extracted.added && ` · 이미 표에 있는 주소 ${extracted.urls.length - extracted.added}개`}
                  {extracted.duplicates > 0 && ` · 겹친 주소 ${extracted.duplicates}개는 한 번만`}
                  {extracted.ignored.length > 0 && (
                    <details className="pi-ignored">
                      <summary>글 주소가 아니라 건너뜀 {extracted.ignored.length}개</summary>
                      <ul>
                        {extracted.ignored.map((i) => (
                          <li key={i.url}>
                            <span className="mono">{shortUrl(i.url)}</span> — {i.reason}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              )}
            </section>

            <section className="pi-box" aria-labelledby="pi-sources-title">
              <h3 id="pi-sources-title">저장한 블로그</h3>
              <p className="pi-label">
                작성자 블로그를 한 번 저장해 두면 「새 글 찾기」로 아직 적지 않은 글을 모아 읽습니다. 앱 전체에 한 목록입니다(한 블로그에 여러 브랜드의
                글이 오릅니다).
              </p>
              {sources.length > 0 ? (
                <ul className="pi-sources">
                  {sources.map((s) => (
                    <li key={s.url}>
                      <a href={s.url} target="_blank" rel="noreferrer">
                        {shortUrl(s.url)}
                      </a>
                      <span className="pi-platform">{POST_PLATFORM_LABEL[s.platform]}</span>
                      <button
                        type="button"
                        className="ps-mark"
                        onClick={() => void saveSources(sources.filter((x) => x.url !== s.url).map((x) => x.url))}
                        disabled={busy || sourceBusy}
                        aria-label={`${shortUrl(s.url)} 저장한 블로그에서 빼기`}
                      >
                        빼기
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted pi-empty">아직 저장한 블로그가 없습니다.</p>
              )}
              <form
                className="pi-row"
                onSubmit={(e) => {
                  e.preventDefault()
                  void addSource()
                }}
              >
                <label className="sr-only" htmlFor="pi-source">
                  더할 블로그 주소
                </label>
                <input
                  id="pi-source"
                  // 「아이디.tistory.com」처럼 http(s) 없이 적어도 받는다(normalizeBlogSource) — type=url이면 브라우저가 막는다.
                  type="text"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  className="pi-source-input"
                  placeholder="예: https://blog.naver.com/아이디 · https://아이디.tistory.com"
                  value={sourceInput}
                  onChange={(e) => {
                    setSourceInput(e.target.value)
                    setSourceError(null)
                  }}
                  disabled={sourceBusy}
                />
                <button type="submit" className="btn" disabled={sourceBusy || !sourceInput.trim()}>
                  더하기
                </button>
                <button type="button" className="btn primary" onClick={() => void findNew()} disabled={busy || sourceBusy || sources.length === 0}>
                  새 글 찾기
                </button>
              </form>
              {sourceError && (
                <p className="error pi-note" role="alert">
                  {sourceError}
                </p>
              )}
              {listNotes.length > 0 && (
                <ul className="pi-list-notes">
                  {listNotes.map((n) => (
                    <li key={n.source} className={n.error ? 'error' : undefined}>
                      <span className="mono">{shortUrl(n.source)}</span> — {n.text}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <div className="pi-progress" role="status" aria-live="polite">
            {phase?.kind === 'list' && (
              <span>
                블로그 목록 확인 중 {phase.done + 1}/{phase.total}
              </span>
            )}
            {phase?.kind === 'read' && (
              <>
                <progress max={rows.length} value={doneCount} aria-label="주소 읽기 진행" />
                <span>
                  읽는 중 {doneCount}/{rows.length}
                </span>
              </>
            )}
            {phase === null && rows.length > 0 && (
              <span>
                {doneCount}/{rows.length}개 읽음
                {counts.length > 0 && ` · ${counts.map(([s, n]) => `${ROW_STATE_LABEL[s]} ${n}`).join(' · ')}`}
              </span>
            )}
            {phase !== null && (
              <button type="button" className="btn" onClick={() => abortRef.current?.abort()}>
                멈추기
              </button>
            )}
          </div>

          {rows.length > 0 && (
            <>
              <div className="table-wrap pi-table-wrap">
                <table className="pi-table">
                  <caption className="sr-only">읽은 글 주소와 짝지을 앱 글</caption>
                  <colgroup>
                    <col className="pi-col-check" />
                    <col className="pi-col-brand" />
                    <col className="pi-col-writer" />
                    <col className="pi-col-article" />
                    <col className="pi-col-url" />
                    <col className="pi-col-platform" />
                    <col className="pi-col-date" />
                    <col className="pi-col-score" />
                    <col className="pi-col-state" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th scope="col">등록</th>
                      <th scope="col">브랜드</th>
                      <th scope="col">작성자</th>
                      <th scope="col">앱 글 제목</th>
                      <th scope="col">주소</th>
                      <th scope="col">플랫폼</th>
                      <th scope="col">올린 날</th>
                      <th scope="col">맞음 정도</th>
                      <th scope="col">상태</th>
                    </tr>
                  </thead>
                  <tbody>
                    {views.map(({ row, state, verdict, candidate, registrable }) => {
                      const read = row.read
                      const ok = read?.ok ? read : null
                      const label = ok?.post.title || shortUrl(row.url)
                      const runnerUp = ok ? Math.max(0, ...ok.candidates.filter((c) => !samePick(c, row.pick)).map((c) => c.body)) : 0
                      const twin = row.checked && registrable && (pickCount.get(pickValue(row.pick)) ?? 0) > 1
                      return (
                        <tr key={row.key} className={state && BLOCKED.includes(state) ? 'pi-blocked' : undefined}>
                          <td>
                            <input
                              type="checkbox"
                              checked={row.checked && registrable}
                              disabled={!registrable || committing}
                              onChange={(e) => patchRow(row.key, { checked: e.target.checked })}
                              aria-label={`「${label}」 등록에 넣기`}
                            />
                          </td>
                          <td>{candidate?.brand ?? '—'}</td>
                          <td className={candidate?.writer ? undefined : 'muted'}>{candidate ? writerText(candidate) : '—'}</td>
                          <td>
                            {ok ? (
                              <>
                                <select
                                  value={pickValue(row.pick)}
                                  onChange={(e) => choose(row, e.target.value)}
                                  disabled={committing || row.result?.kind === 'added'}
                                  aria-label={`「${label}」과 짝지을 앱 글`}
                                >
                                  {ok.candidates.map((c) => (
                                    <option key={pickValue(c)} value={pickValue(c)}>
                                      {c.title} — {c.brand} · {scorePercent(c.body)}
                                    </option>
                                  ))}
                                  <option value="">앱 글 아님</option>
                                </select>
                                <span className="pi-sub-line">블로그 제목: {ok.post.title || '없음'}</span>
                              </>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                          <td className="pi-url">
                            <a href={row.url} target="_blank" rel="noreferrer" title={row.url}>
                              {shortUrl(row.url)}
                            </a>
                          </td>
                          <td>{ok ? ok.platform.label : '—'}</td>
                          <td>
                            {ok ? (
                              <>
                                <input
                                  type="date"
                                  className="pi-date"
                                  value={row.date}
                                  min="2020-01-01"
                                  max={today}
                                  onChange={(e) => patchRow(row.key, { date: e.target.value, result: null })}
                                  disabled={committing || !registrable}
                                  aria-label={`「${label}」 올린 날`}
                                  title={ok.post.dateText ? `페이지 날짜: ${ok.post.dateText}` : undefined}
                                />
                                {!ok.post.publishedOn &&
                                  (registrable && !row.date ? (
                                    <span className="pi-sub-line warn">페이지에 날짜가 없어 골라야 합니다</span>
                                  ) : (
                                    <span className="pi-sub-line">페이지에 날짜 없음{row.date ? ' — 고른 날' : ''}</span>
                                  ))}
                                {ok.post.publishedOn && row.date !== ok.post.publishedOn && <span className="pi-sub-line">페이지: {ok.post.publishedOn}</span>}
                              </>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td title={candidate ? `제목 겹침 ${scorePercent(candidate.titleScore)}` : undefined}>
                            {candidate ? (
                              <>
                                본문 {scorePercent(candidate.body)}
                                <span className="pi-sub-line">다음 {scorePercent(runnerUp)}</span>
                              </>
                            ) : ok?.candidates[0] ? (
                              <span className="muted">가장 비슷한 {scorePercent(ok.candidates[0].body)}</span>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td>
                            {row.status === 'waiting' && <span className="chip">기다림</span>}
                            {row.status === 'reading' && <span className="chip info">읽는 중</span>}
                            {row.status === 'stopped' && <span className="chip">멈춤</span>}
                            {row.result?.kind === 'added' && <span className="chip good">등록함</span>}
                            {row.result?.kind === 'existing' && <span className="chip info">이미 등록됨</span>}
                            {state && !(row.result?.kind === 'added' || row.result?.kind === 'existing') && (
                              <span className={`chip${STATE_TONE[state] ? ` ${STATE_TONE[state]}` : ''}`}>{ROW_STATE_LABEL[state]}</span>
                            )}
                            {state === 'review' && !row.result && <span className="pi-sub-line">비슷한 앱 글이 둘 이상이거나 겹침이 낮습니다 — 맞는 글을 골라 체크하세요.</span>}
                            {state === 'none' && row.pick === null && <span className="pi-sub-line">앱 글과 겹치는 부분이 적습니다. 맞는 글이 있으면 고르세요.</span>}
                            {verdict?.kind === 'other' && (
                              <span className="pi-sub-line">
                                {verdict.record.brand}의 「{verdict.record.articleTitle ?? verdict.record.articleId}」에 적힌 주소입니다 — 잘못 적었으면 콘텐츠 보관함에서 그
                                기록을 빼 주세요.
                              </span>
                            )}
                            {verdict?.kind === 'already' && !row.result && (
                              <span className="pi-sub-line">
                                {verdict.record.legacy
                                  ? '예전 방식으로 적힌 주소입니다 — 콘텐츠 보관함에서 올린 날을 고쳐 주세요.'
                                  : `${verdict.record.brand} 「${verdict.record.articleTitle ?? verdict.record.articleId}」 · ${verdict.record.publishedOn ?? '날짜 모름'}`}
                              </span>
                            )}
                            {read && !read.ok && <span className="pi-sub-line">{read.error}</span>}
                            {registrable && candidate && candidate.otherUrls > 0 && (
                              <span className="pi-sub-line warn">이 앱 글에는 이미 다른 주소 {candidate.otherUrls}개가 적혀 있습니다 — 같은 글을 또 올린 것이면 이 주소도 더합니다.</span>
                            )}
                            {twin && <span className="pi-sub-line warn">같은 앱 글을 고른 줄이 또 있습니다 — 두 주소 모두 그 글의 기록이 됩니다.</span>}
                            {row.result?.kind === 'error' && (
                              <span className="pi-sub-line error" role="alert">
                                {row.result.text}
                              </span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="pi-actions">
                <button type="button" className="btn primary" onClick={() => void register()} disabled={busy || checkedCount === 0}>
                  이대로 등록{checkedCount > 0 ? ` (${checkedCount}편)` : ''}
                </button>
                {retryable > 0 && (
                  <button type="button" className="btn" onClick={retry} disabled={busy}>
                    읽지 못한 · 멈춘 주소 다시 읽기 ({retryable})
                  </button>
                )}
                <button type="button" className="btn" onClick={clear} disabled={busy}>
                  표 비우기
                </button>
                {commitNote && (
                  <span className="pi-note" role="status">
                    {commitNote}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </details>
  )
}
