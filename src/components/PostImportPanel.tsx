import { useEffect, useRef, useState } from 'react'
import { commitPostImport, listImportBlogPosts, loadBlogSources, loadIgnoredPosts, readImportPost, saveBlogSources, unignorePosts } from '../lib/api'
import { BANK_UNKNOWN_NOTE } from '../lib/contentLibraryOrder'
import { externalTitle } from '../lib/externalPosts'
import {
  autoPick,
  bulkIgnorable,
  checkedByDefault,
  choiceBlockReason,
  choiceStateOf,
  commitChunks,
  DATE_PROBLEM_TEXT,
  externalBlockMessage,
  externalBrandState,
  externalDefaultBrands,
  externalRepostProblem,
  externalResultText,
  extractPostUrls,
  ignoreOptionAllowed,
  initialChoice,
  movesExternal,
  normalizeBlogSource,
  otherUrlsNow,
  pickKey,
  POST_PLATFORM_LABEL,
  ROW_STATE_LABEL,
  sameUrlAppBrands,
  scorePercent,
  type BlogListResult,
  type BlogSource,
  type CommitItem,
  type CommitResult,
  type ExtractedUrls,
  type IgnoredPost,
  type ImportCandidate,
  type PostImportRead,
  type RegisteredRow,
  type RowChoice,
  type RowPick,
  type RowState,
  type TrackedRecord,
} from '../lib/postImport'
import { kstDate, todayKst, trackingKey } from '../lib/publishedUrl'
import { monthDay } from '../lib/publishTracking'

/** 한 번에 읽는 주소 수(서버도 바깥 요청을 3개로 묶는다). */
const READ_CONCURRENCY = 3
/** 짝 고르기 값 — 앱 글은 pickKey(브랜드\n글 id), 「앱 글 아님」은 빈 글자, 나머지 둘은 줄바꿈 없는 글자라 겹치지 않는다. */
const EXTERNAL = 'external'
const IGNORE = 'ignore'

interface ImportRow {
  /** 추적 키 — 같은 글은 한 줄. */
  key: string
  url: string
  status: 'waiting' | 'reading' | 'done' | 'stopped'
  read: PostImportRead | null
  /** 읽기를 마친 차례 — 이 뒤에 이 표에서 등록한 줄만 「이미 다른 주소」에 더한다(otherUrlsNow). */
  readSeq: number
  /** 고른 일 — 앱 글(pick null이면 「앱 글 아님」) · 앱 밖 글로 추적(새로 고른 브랜드 · 날짜 모름) · 무시. */
  choice: RowChoice
  checked: boolean
  /** 올린 날(YYYY-MM-DD) — 페이지 날짜로 채우고 사람이 고친다. 모르면 빈 글자(사람이 골라야 등록된다 — 앱 밖 글은 「날짜 모름」도). */
  date: string
  /** 앱 글로 옮김을 골라 올린 날을 오늘로 바꿔 두었다 — 옮김이 아닌 일을 고르면 페이지 날짜로 되돌린다(D12 · D3: 앱 밖 글을 오늘로 채우지 않는다). */
  movedDate?: boolean
  /**
   * 등록 결과. seq는 등록한 차례, recheck는 등록 요청 자체가 실패해 적혔는지 모르는 줄(다시 읽어 확인한다). partial은 앱 밖 글을 몇
   * 브랜드에만 적었다(걸린 브랜드는 그대로 골라 둔다).
   */
  result: { kind: 'added' | 'existing' | 'error' | 'partial'; text: string; seq?: number; recheck?: boolean } | null
}

interface QueueCount {
  added: number
  requeued: number
  inTable: number
}

/** 「무시한 글 보기 · 되돌리기」 — 열 때마다 다시 읽는다. list가 null이면 아직 읽지 않았거나 읽지 못했다(error). busy는 되돌리는 중인 주소. */
interface IgnoredView {
  open: boolean
  loading: boolean
  list: IgnoredPost[] | null
  max: number
  shown: number
  busy: string | null
  error: string | null
  note: string | null
}
/** 무시한 글을 한 번에 보이는 수(「더 보기」로 늘린다 — 목록은 5000편까지). */
const IGNORED_PAGE = 100
const IGNORED_CLOSED: IgnoredView = { open: false, loading: false, list: null, max: 0, shown: IGNORED_PAGE, busy: null, error: null, note: null }

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

const validDay = (day: string, limit: string) => /^\d{4}-\d{2}-\d{2}$/.test(day) && day <= limit && day >= '2020-01-01'
const appPick = (c: RowChoice) => (c.mode === 'app' ? c.pick : null)
const choiceValue = (c: RowChoice) => (c.mode === 'external' ? EXTERNAL : c.mode === 'ignore' ? IGNORE : c.pick ? pickKey(c.pick) : '')
const samePick = (c: RowPick | null, p: RowPick | null) => c !== null && p !== null && c.tenantId === p.tenantId && c.articleId === p.articleId
/** 이 줄을 적을 주소 · 키 — 읽은 페이지가 밝힌 주소(리디렉션 뒤 · 정식 주소). 읽기 전이면 붙여 넣은 주소. */
const recordUrlOf = (r: ImportRow) => (r.read?.ok ? r.read.recordUrl : r.url)
const recordKeyOf = (r: ImportRow) => (r.read?.ok ? r.read.recordKey : r.key)
/** 적을 주소 말고 이 줄을 읽을 때 나온 주소 모양(붙여 넣은 · 읽은 주소) — 무시 목록에 함께 적고, 등록하면 함께 푼다. */
const otherUrlsOf = (r: ImportRow) => [...new Set([r.url, ...(r.read?.ok && r.read.readUrl ? [r.read.readUrl] : [])])].filter((u) => u !== recordUrlOf(r))
/** 이 줄에서 고른 일을 마쳤다(등록함 · 이미 있던 기록 · 무시함). */
const finishedRow = (r: ImportRow) => r.result?.kind === 'added' || r.result?.kind === 'existing'
/** 다시 읽을 줄 — 멈춤 · 읽지 못함(무시를 마친 줄은 빼고) · 등록 요청이 실패해 적혔는지 모르는 줄. */
const needsReread = (r: ImportRow) =>
  r.status === 'stopped' || (r.status === 'done' && r.read !== null && !r.read.ok && !(r.choice.mode === 'ignore' && finishedRow(r))) || r.result?.recheck === true
const NO_CHOICE: RowChoice = { mode: 'app', pick: null }

/** 표의 다른 줄이 이미 고른 앱 글(체크했거나 등록한 줄) — 같은 글 무리에서 한 줄만 미리 체크한다. */
function claimedPicks(rows: readonly ImportRow[], exceptKey: string): Set<string> {
  return new Set(
    rows.flatMap((r) => {
      const pick = appPick(r.choice)
      return r.key !== exceptKey && pick && (r.checked || r.result?.kind === 'added') ? [pickKey(pick)] : []
    }),
  )
}

const STATE_TONE: Record<RowState, string> = {
  match: 'good',
  review: 'warn',
  none: '',
  manual: 'warn',
  dismissed: '',
  already: 'info',
  other: 'bad',
  unreadable: 'bad',
  tracked: 'info',
  ignored: '',
  external: 'info',
  ignore: '',
}
const BLOCKED: readonly RowState[] = ['already', 'other', 'unreadable']

function writerText(c: ImportCandidate | undefined): string {
  if (!c) return '—'
  if (c.writer) return `${c.writer.key} · ${c.writer.name}`
  return c.writerUnknown ? '미확인' : '배정 없음'
}

function listNote(r: BlogListResult): string {
  const hidden = [
    ...((r.hiddenExternal ?? 0) > 0 ? [`앱 밖 글 ${r.hiddenExternal}편`] : []),
    ...((r.hiddenIgnored ?? 0) > 0 ? [`무시한 글 ${r.hiddenIgnored}편`] : []),
  ]
  const skipped = hidden.length > 0 ? ` · ${hidden.join(' · ')} 뺌` : ''
  const older = r.older > 0 ? ` · 더 오래된 새 글 ${r.older}편은 뺐습니다` : ''
  const errors = r.errors.length > 0 ? ` · 읽지 못한 목록: ${r.errors.join(' / ')}` : ''
  return `찾은 글 ${r.found}편 · 새 글 ${r.newUrls.length}편${skipped}${older}${errors}`
}

function queueText(c: QueueCount): string {
  const parts = [`새로 읽을 주소 ${c.added}개`]
  if (c.requeued > 0) parts.push(`다시 읽을 주소(멈춤 · 읽지 못함) ${c.requeued}개`)
  if (c.inTable > 0) parts.push(`이미 표에 있는 주소 ${c.inTable}개`)
  return parts.join(' · ')
}

/** 추적 중인 브랜드 — 「가상여관」, 앱 글로 옮겨 쉬는 줄은 「가상여관(앱 글로 옮겨 쉼)」. */
const trackedText = (tracked: readonly TrackedRecord[]) => [...new Map(tracked.map((t) => [t.tenantId, t.state === 'moved' ? `${t.brand}(앱 글로 옮겨 쉼)` : t.brand])).values()].join(', ')

/** 읽기를 마친 줄의 상태 · 고를 수 있는지 · 고른 후보 · 막힌 까닭. dupOf는 같은 글 주소(적을 주소가 같음)로 위에 먼저 나온 줄. */
function rowView(row: ImportRow, dupOf: ImportRow | undefined) {
  const read = row.read
  if (row.status !== 'done' || !read) return { state: null, verdict: null, candidate: undefined, registrable: false, blockReason: null, dupOf: undefined }
  const { state, verdict } = choiceStateOf(read, row.choice)
  const pick = appPick(row.choice)
  const candidate = read.ok && pick ? read.candidates.find((c) => samePick(c, pick)) : undefined
  const done = row.result?.kind === 'added' || row.result?.kind === 'existing'
  const blockReason = choiceBlockReason(read, row.choice)
  return { state, verdict, candidate, registrable: blockReason === null && !done && !dupOf, blockReason, dupOf }
}

/**
 * 주소 한꺼번에 등록 — 발행 현황(src/pages/PublishStatus.tsx) 위에 접혀 있다. 작성자가 보낸 메일을 붙여 넣거나 저장한 블로그의 새 글을
 * 찾으면, 서버가 글마다 페이지를 읽어 모든 고객 브랜드의 앱 글과 맞춘다(server/postImport.ts · src/lib/postImport.ts). 「맞음」 줄만 미리
 * 체크해 두고(같은 글을 또 올린 것일 수 있는 줄은 빼고), 사람이 확인 필요 줄의 글을 고르고 날짜를 확인한 뒤 「이대로 등록」을 누르면
 * 「올렸어요」와 같은 기록으로 적는다 — 주소는 페이지가 밝힌 주소(리디렉션 뒤 · 정식 주소)로. 웹에는 라우트가 없어 「데스크톱 앱에서만」을
 * 보인다.
 *
 * 앱에서 만들지 않은 글은 「앱 밖 글로 추적…」(브랜드 여러 곳 · 날짜 모름 — 원장과 따로, 점수 · 집행에 넣지 않는다)이나 「무시 — 새 글
 * 찾기에서 숨김」을 고른다. 이미 추적 중 · 무시한 주소는 그 상태로 다시 보이고 미리 체크하지 않는다(앱 글을 자동으로 고르지 않는다 — C6).
 * 오래된 글이 많은 블로그는 「앱 글 아님 줄 모두 무시」로 「앱 글 아님」 줄을 한꺼번에 무시로 바꿔 체크한다(읽지 못함 줄은 빼고 — D10 · D14,
 * 저장은 「이대로 등록」 때 — D6). 무시한 글은 「무시한 글 보기 · 되돌리기」로 보고 푼다(다음 새 글 찾기에 다시 나온다).
 * brands는 고객 브랜드 목록(발행 현황 응답).
 */
export default function PostImportPanel({
  today,
  brands,
  onRegistered,
}: {
  today: string
  brands: readonly { tenantId: string; brand: string }[]
  onRegistered: () => void
}) {
  const [available, setAvailable] = useState<'loading' | 'yes' | 'no'>('loading')
  const [sources, setSources] = useState<BlogSource[]>([])
  const [sourceInput, setSourceInput] = useState('')
  const [sourceBusy, setSourceBusy] = useState(false)
  const [sourceError, setSourceError] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [extracted, setExtracted] = useState<(ExtractedUrls & QueueCount) | null>(null)
  const [rows, setRows] = useState<ImportRow[]>([])
  const [phase, setPhase] = useState<{ kind: 'list'; done: number; total: number } | { kind: 'read'; done: number; total: number } | null>(null)
  const [listNotes, setListNotes] = useState<{ source: string; text: string; error: boolean }[]>([])
  const [findNote, setFindNote] = useState<string | null>(null)
  const [committing, setCommitting] = useState(false)
  const [commitNote, setCommitNote] = useState<string | null>(null)
  const [ignored, setIgnored] = useState<IgnoredView>(IGNORED_CLOSED)
  const abortRef = useRef<AbortController | null>(null)
  // 비동기 흐름(새 글 찾기 뒤 더하기 · 읽기를 마친 줄의 미리 체크)이 지금 표를 보게 한다.
  const rowsRef = useRef<ImportRow[]>(rows)
  const seqRef = useRef(0)
  // 「되돌리기」를 마치면 결과 문구(또는 오류)로 포커스를 옮긴다.
  const ignoredMsgRef = useRef<HTMLParagraphElement | null>(null)
  const focusIgnoredMsg = useRef(false)

  useEffect(() => {
    rowsRef.current = rows
  }, [rows])

  useEffect(() => {
    if (!focusIgnoredMsg.current || ignored.busy !== null) return
    focusIgnoredMsg.current = false
    ignoredMsgRef.current?.focus()
  }, [ignored])

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
  const nextSeq = () => (seqRef.current += 1)
  /** 고를 수 있는 날의 끝 — 화면을 연 날과 지금 한국 날짜 가운데 늦은 날(자정을 넘겨 열어 둔 화면에서도 오늘 올린 글을 적게). 서버가 다시 본다. */
  const dayLimit = () => {
    const now = todayKst()
    return now > today ? now : today
  }
  const patchRow = (key: string, patch: Partial<ImportRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)))

  /** 주소들을 차례로 읽는다(한 번에 READ_CONCURRENCY개). 「멈추기」를 누르면 남은 주소는 「멈춤」. 진행은 이번에 읽는 주소로 센다. */
  const readAll = async (targets: { key: string; url: string }[]) => {
    if (targets.length === 0) return
    const ctrl = new AbortController()
    abortRef.current = ctrl
    let done = 0
    setPhase({ kind: 'read', done, total: targets.length })
    let next = 0
    const worker = async () => {
      while (next < targets.length && !ctrl.signal.aborted) {
        const t = targets[next++]!
        patchRow(t.key, { status: 'reading', result: null })
        try {
          const read = await readImportPost(t.url, ctrl.signal)
          const seq = nextSeq()
          setRows((rs) =>
            rs.map((r) =>
              r.key === t.key
                ? {
                    ...r,
                    status: 'done',
                    read,
                    readSeq: seq,
                    choice: initialChoice(read),
                    checked: checkedByDefault(read, claimedPicks(rs, t.key)),
                    date: read.ok ? (read.post.publishedOn ?? '') : '',
                    movedDate: false,
                  }
                : r,
            ),
          )
        } catch (err) {
          if (ctrl.signal.aborted) patchRow(t.key, { status: 'stopped' })
          else patchRow(t.key, { status: 'done', read: { ok: false, url: t.url, key: t.key, error: message(err) }, readSeq: nextSeq(), choice: NO_CHOICE, checked: false })
        }
        done += 1
        setPhase({ kind: 'read', done, total: targets.length })
      }
    }
    await Promise.all(Array.from({ length: READ_CONCURRENCY }, worker))
    if (ctrl.signal.aborted) setRows((rs) => rs.map((r) => (r.status === 'waiting' || r.status === 'reading' ? { ...r, status: 'stopped' } : r)))
    if (abortRef.current === ctrl) abortRef.current = null
    setPhase(null)
  }

  /**
   * 글 주소를 표에 더하고 읽는다 — 표에 없는 주소는 새 줄로, 표에 있는데 멈춤 · 읽지 못함인 줄은 다시 읽는다. 같은 글은 붙여 넣은 주소와
   * 적을 주소(리디렉션 뒤 · 정식 주소) 모두로 알아본다.
   */
  const addAndRead = (urls: string[]): QueueCount => {
    const byKey = new Map<string, ImportRow>()
    for (const r of rowsRef.current) {
      byKey.set(r.key, r)
      byKey.set(recordKeyOf(r), r)
    }
    const fresh: { key: string; url: string }[] = []
    const requeue: { key: string; url: string }[] = []
    let inTable = 0
    const seen = new Set<string>()
    for (const url of urls) {
      const key = trackingKey(url)
      if (!key || seen.has(key)) continue
      seen.add(key)
      const row = byKey.get(key)
      if (!row) fresh.push({ key, url })
      else if (needsReread(row) && !requeue.some((t) => t.key === row.key)) requeue.push({ key: row.key, url: row.url })
      else inTable += 1
    }
    const requeued = new Set(requeue.map((t) => t.key))
    setRows((rs) => [
      ...rs.map((r) => (requeued.has(r.key) ? { ...r, status: 'waiting' as const, read: null, choice: NO_CHOICE, checked: false, result: null } : r)),
      ...fresh.map((f): ImportRow => ({ ...f, status: 'waiting', read: null, readSeq: 0, choice: NO_CHOICE, checked: false, date: '', result: null })),
    ])
    void readAll([...requeue, ...fresh])
    return { added: fresh.length, requeued: requeue.length, inTable }
  }

  const onExtract = () => {
    const ex = extractPostUrls(text)
    setCommitNote(null)
    setFindNote(null)
    setExtracted({ ...ex, ...addAndRead(ex.urls) })
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
    setFindNote(null)
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
    if (ctrl.signal.aborted) return
    setFindNote(`새 글 ${found.length}편 — ${queueText(addAndRead(found))}`)
  }

  /**
   * 짝을 고른다 — 앱 글은 처음 고른 글로 되돌린 맞음 줄만 다시 체크해 두고, 다른 글 · 「앱 글 아님」을 고르면 체크를 비운다. 「앱 밖 글로
   * 추적…」은 자사 주소인 브랜드가 정확히 하나면 그 브랜드를 미리 고르고(D2), 「무시」와 함께 체크는 사람이 한다. 앱 글로 옮김을 골라 올린 날을
   * 오늘로 바꿨다가 다른 일을 고르면 페이지 날짜(없으면 빈 칸)로 되돌린다 — 앱 밖 글을 오늘로 채우지 않는다(D3).
   */
  const choose = (row: ImportRow, value: string) => {
    if (!row.read) return
    const pageDate = row.read.ok ? (row.read.post.publishedOn ?? '') : ''
    const undoMove: Partial<ImportRow> = row.movedDate ? { date: pageDate, movedDate: false } : {}
    if (value === EXTERNAL) {
      const choice: RowChoice = row.choice.mode === 'external' ? row.choice : { mode: 'external', tenantIds: externalDefaultBrands(row.read), dateUnknown: false }
      patchRow(row.key, { choice, checked: false, result: null, ...undoMove })
      return
    }
    if (value === IGNORE) {
      patchRow(row.key, { choice: { mode: 'ignore' }, checked: false, result: null, ...undoMove })
      return
    }
    const [tenantId, articleId] = value.split('\n')
    const pick = value && tenantId && articleId ? { tenantId, articleId } : null
    const back = samePick(autoPick(row.read), pick)
    // 같은 브랜드에서 앱 밖 글로 추적 중인 주소를 앱 글로 옮기면 앱 글의 올린 날은 옮기는 날(오늘)이다(D12 — 그 전 인용은 앱 밖 표에 남는다).
    const moving = movesExternal(row.read, pick) !== null
    patchRow(row.key, {
      choice: { mode: 'app', pick },
      checked: back && checkedByDefault(row.read, claimedPicks(rowsRef.current, row.key)),
      result: null,
      ...(moving ? { date: dayLimit(), movedDate: true } : undoMove),
    })
  }

  /** 앱 밖 글로 추적할 브랜드를 고르거나 뺀다 · 「날짜 모름」을 켜고 끈다. */
  const patchExternal = (row: ImportRow, patch: { tenantId?: string; on?: boolean; dateUnknown?: boolean }) => {
    if (row.choice.mode !== 'external') return
    const { tenantId, on } = patch
    const tenantIds = tenantId === undefined ? row.choice.tenantIds : on ? [...new Set([...row.choice.tenantIds, tenantId])] : row.choice.tenantIds.filter((t) => t !== tenantId)
    patchRow(row.key, { choice: { ...row.choice, tenantIds, dateUnknown: patch.dateUnknown ?? row.choice.dateUnknown }, result: null })
  }

  const retry = () => {
    const targets = rows.filter(needsReread).map((r) => ({ key: r.key, url: r.url }))
    for (const t of targets) patchRow(t.key, { status: 'waiting', read: null, choice: NO_CHOICE, checked: false, result: null })
    void readAll(targets)
  }

  const patchIgnored = (patch: Partial<IgnoredView>) => setIgnored((s) => ({ ...s, ...patch }))
  /** 무시 목록을 읽는다 — 읽지 못하면 목록을 비우고 까닭을 보인다(빈 목록으로 보이지 않게). */
  const loadIgnored = async () => {
    patchIgnored({ loading: true, error: null })
    try {
      const res = await loadIgnoredPosts()
      patchIgnored({ loading: false, list: res.ignored, max: res.max })
    } catch (err) {
      patchIgnored({ loading: false, list: null, error: `무시한 글을 읽지 못했습니다 — ${message(err)}` })
    }
  }
  const toggleIgnored = () => {
    if (ignored.open) {
      setIgnored(IGNORED_CLOSED)
      return
    }
    setIgnored({ ...IGNORED_CLOSED, open: true })
    void loadIgnored()
  }
  /** 되돌린 주소가 표에 있으면 그 줄의 무시를 푼다 — 무시로 고른 줄은 처음 고를 일로 되돌리고 체크를 비운다(다시 읽지 않아도 상태가 맞게). */
  const afterUnignore = (keys: ReadonlySet<string>) =>
    setRows((rs) =>
      rs.map((r) => {
        const readKey = r.read?.ok && r.read.readUrl ? trackingKey(r.read.readUrl) : null
        if (![r.key, recordKeyOf(r), readKey].some((k) => k !== null && keys.has(k))) return r
        const read = r.read?.ok ? { ...r.read, ignoredAt: null } : r.read
        if (r.choice.mode !== 'ignore') return { ...r, read }
        return { ...r, read, choice: read ? initialChoice(read) : NO_CHOICE, checked: false, result: null }
      }),
    )
  const restoreIgnored = async (entry: IgnoredPost) => {
    // 되돌린 항목은 목록에서 사라진다 — 끝나면 결과 문구로 포커스를 옮긴다(키보드로 누른 사람이 맨 위로 돌아가지 않게).
    focusIgnoredMsg.current = true
    patchIgnored({ busy: entry.url, error: null, note: null })
    try {
      const res = await unignorePosts([entry.url])
      patchIgnored({
        busy: null,
        list: res.ignored,
        note:
          res.removed > 0
            ? `${shortUrl(entry.url)} — 무시를 풀었습니다. 다음 「새 글 찾기」에 다시 나옵니다.`
            : `${shortUrl(entry.url)} — 이미 풀린 주소입니다(목록을 다시 읽었습니다).`,
      })
      afterUnignore(new Set(entry.keys))
    } catch (err) {
      patchIgnored({ busy: null, error: `되돌리지 못했습니다 — ${message(err)}` })
    }
  }

  // 같은 글 주소(적을 주소가 같음) — 위에 먼저 나온 줄로 등록하고 나머지 줄은 막는다.
  const firstByRecord = new Map<string, ImportRow>()
  for (const r of rows) if (r.status === 'done' && r.read?.ok && !firstByRecord.has(recordKeyOf(r))) firstByRecord.set(recordKeyOf(r), r)
  const views = rows.map((r) => {
    const first = r.status === 'done' && r.read?.ok ? firstByRecord.get(recordKeyOf(r)) : undefined
    return { row: r, ...rowView(r, first && first !== r ? first : undefined) }
  })
  // 이 표에서 등록한 앱 글 줄 — 같은 앱 글에 또 다른 주소를 적는지 알리는 데 쓴다.
  const registered: RegisteredRow[] = rows.flatMap((r) => {
    const pick = appPick(r.choice)
    return r.result?.kind === 'added' && pick ? [{ pick, recordKey: recordKeyOf(r), seq: r.result.seq ?? 0 }] : []
  })

  /** 등록한 뒤 이 줄의 읽기 결과를 고친다 — 적은 브랜드를 추적 중으로, 무시한 주소에 무시한 때를(다시 읽지 않아도 상태가 맞게). */
  const afterExternal = (row: ImportRow, r: Extract<CommitResult, { kind: 'external' }>): Partial<ImportRow> => {
    const read = row.read
    const written = r.tenants.filter((t) => t.status !== 'error')
    const failed = r.tenants.filter((t) => t.status === 'error').map((t) => t.tenantId)
    const nowIso = new Date().toISOString()
    const tracked: TrackedRecord[] = written.map((t) => ({
      tenantId: t.tenantId,
      brand: t.brand,
      postId: t.postId ?? '',
      key: recordKeyOf(row),
      state: 'live',
      publishedOn: row.choice.mode === 'external' && row.choice.dateUnknown ? null : row.date || null,
      trackedAt: nowIso,
    }))
    const nextRead = read?.ok ? { ...read, tracked: [...(read.tracked ?? []).filter((t) => !written.some((w) => w.tenantId === t.tenantId)), ...tracked], ignoredAt: null } : read
    const choice: RowChoice = row.choice.mode === 'external' ? { ...row.choice, tenantIds: failed } : row.choice
    const kind = r.status === 'partial' ? 'partial' : r.status === 'added' ? 'added' : r.status === 'existing' ? 'existing' : 'error'
    return { read: nextRead, choice, checked: false, result: { kind, text: externalResultText(r), ...(kind === 'added' ? { seq: nextSeq() } : {}) } }
  }

  /** 앱 글로 옮겨 등록한 줄 — 그 브랜드의 앱 밖 줄을 「앱 글로 옮겨 쉼」으로 고친다(서버와 같은 상태 — 다시 읽지 않아도 맞게). */
  const afterAppMove = (row: ImportRow): PostImportRead | null => {
    const read = row.read
    const moved = read ? movesExternal(read, appPick(row.choice)) : null
    if (!read?.ok || !moved) return read
    return { ...read, tracked: (read.tracked ?? []).map((t) => (t.tenantId === moved.tenantId ? { ...t, state: 'moved' as const } : t)) }
  }

  const register = async () => {
    const limit = dayLimit()
    const chosen = views.filter((v) => v.row.checked && v.registrable).map((v) => v.row)
    if (chosen.length === 0) return
    setCommitting(true)
    setCommitNote(null)
    const ready: { row: ImportRow; item: CommitItem }[] = []
    let failed = 0
    for (const r of chosen) {
      const c = r.choice
      const alsoUrls = otherUrlsOf(r)
      if (c.mode === 'ignore') {
        ready.push({ row: r, item: { kind: 'ignore', url: recordUrlOf(r), alsoUrls } })
        continue
      }
      const dateOk = validDay(r.date, limit) || (c.mode === 'external' && c.dateUnknown)
      if (!dateOk || !r.read?.ok) {
        failed += 1
        patchRow(r.key, { result: { kind: 'error', text: `올린 날을 골라 주세요(2020-01-01 ~ 오늘 ${limit})${c.mode === 'external' ? ' — 모르면 「날짜 모름」' : ''}.` } })
        continue
      }
      const repost = c.mode === 'external' ? externalRepostProblem(r.read, c.tenantIds, c.dateUnknown ? null : r.date) : null
      if (repost) {
        failed += 1
        patchRow(r.key, { result: { kind: 'error', text: repost } })
        continue
      }
      if (c.mode === 'app' && c.pick) {
        ready.push({ row: r, item: { tenantId: c.pick.tenantId, articleId: c.pick.articleId, url: recordUrlOf(r), publishedOn: r.date, alsoUrls } })
      } else if (c.mode === 'external') {
        const unknown = c.dateUnknown
        ready.push({
          row: r,
          item: {
            kind: 'external',
            tenantIds: c.tenantIds,
            url: recordUrlOf(r),
            title: r.read.post.title || null,
            publishedOn: unknown ? null : r.date,
            publishedOnSource: unknown ? 'unknown' : r.date === r.read.post.publishedOn ? 'page' : 'user',
            alsoUrls,
          },
        })
      }
    }
    const count = { app: 0, external: 0, ignored: 0, existing: 0, partial: 0 }
    let uncertain = 0
    const warnings: string[] = []
    let offset = 0
    for (const chunk of commitChunks(ready.map((p) => p.item))) {
      const pairs = ready.slice(offset, offset + chunk.length)
      offset += chunk.length
      try {
        const res = await commitPostImport(chunk)
        warnings.push(...res.warnings)
        res.results.forEach((result, j) => {
          const r = pairs[j]?.row
          if (!r) return
          if (result.kind === 'external') {
            const patch = afterExternal(r, result)
            if (result.status === 'added') count.external += 1
            else if (result.status === 'existing') count.existing += 1
            else if (result.status === 'partial') count.partial += 1
            else failed += 1
            patchRow(r.key, patch)
            return
          }
          if (result.status === 'added') {
            if (result.kind === 'ignore') {
              count.ignored += 1
              // 읽지 못한 줄도 무시한 때를 단다 — 줄 상태 · 진행 줄이 「무시함」이 되고 「다시 읽기」에서 빠진다(D14).
              patchRow(r.key, { checked: false, read: r.read ? { ...r.read, ignoredAt: new Date().toISOString() } : r.read, result: { kind: 'added', text: '무시함 — 새 글 찾기에서 숨깁니다', seq: nextSeq() } })
            } else {
              count.app += 1
              patchRow(r.key, { checked: false, read: afterAppMove(r), result: { kind: 'added', text: '등록함', seq: nextSeq() } })
            }
          } else if (result.status === 'existing') {
            count.existing += 1
            patchRow(r.key, { checked: false, result: { kind: 'existing', text: result.kind === 'ignore' ? '이미 무시한 주소 — 그대로 둠' : '이미 있던 기록 — 그대로 둠' } })
          } else {
            failed += 1
            patchRow(r.key, { result: { kind: 'error', text: result.error ?? '등록하지 못했습니다.' } })
          }
        })
      } catch (err) {
        // 요청 자체가 실패했다 — 서버가 몇 줄을 적은 뒤 끊겼을 수 있다. 「다시 읽기」로 원장 · 앱 밖 글 · 무시 목록을 다시 보게 한다.
        uncertain += pairs.length
        for (const { row } of pairs) {
          patchRow(row.key, { result: { kind: 'error', recheck: true, text: `등록 요청이 실패했습니다 — ${message(err)}. 일부는 적혔을 수 있으니 「다시 읽기」로 확인해 주세요.` } })
        }
      }
    }
    setCommitting(false)
    const parts = [`앱 글 등록 ${count.app}편`]
    if (count.external > 0) parts.push(`앱 밖 글 ${count.external}편`)
    if (count.partial > 0) parts.push(`앱 밖 글 일부 브랜드만 ${count.partial}편(그 줄의 이유를 보세요)`)
    if (count.ignored > 0) parts.push(`무시 ${count.ignored}편`)
    parts.push(`이미 있던 기록 ${count.existing}편`)
    if (failed > 0) parts.push(`걸림 ${failed}편(그 줄의 이유를 보세요)`)
    if (uncertain > 0) parts.push(`적혔는지 모름 ${uncertain}편(다시 읽어 확인하세요)`)
    setCommitNote([parts.join(' · '), ...warnings].join(' — '))
    if (count.app > 0 || count.external > 0 || count.partial > 0 || uncertain > 0) onRegistered()
    // 무시한 글 목록을 열어 두었으면 다시 읽는다(방금 무시한 글 · 등록해서 풀린 글).
    if (ignored.open) void loadIgnored()
  }

  const clear = () => {
    setRows([])
    setExtracted(null)
    setListNotes([])
    setFindNote(null)
    setCommitNote(null)
  }

  const limit = dayLimit()
  const doneCount = rows.filter((r) => r.status === 'done').length
  const counts = (Object.keys(ROW_STATE_LABEL) as RowState[])
    .map((s) => [s, views.filter((v) => v.state === s).length] as const)
    .filter(([, n]) => n > 0)
  const ready = views.filter((v) => v.row.checked && v.registrable)
  const readyCount = {
    app: ready.filter((v) => v.row.choice.mode === 'app').length,
    external: ready.filter((v) => v.row.choice.mode === 'external').length,
    ignore: ready.filter((v) => v.row.choice.mode === 'ignore').length,
  }
  const readyText = [
    ...(readyCount.app > 0 ? [`앱 글 ${readyCount.app}`] : []),
    ...(readyCount.external > 0 ? [`앱 밖 ${readyCount.external}`] : []),
    ...(readyCount.ignore > 0 ? [`무시 ${readyCount.ignore}`] : []),
  ].join(' · ')
  const retryable = rows.filter(needsReread).length
  // 「앱 글 아님 줄 모두 무시」 대상 — 읽은 줄 가운데 앱 글을 고르지 않은 줄(읽지 못함 · 이미 적은 주소 · 같은 글 주소 아래 줄 · 등록을 마친 줄은 빼고).
  const bulkTargets = views.filter(
    (v) => v.row.status === 'done' && v.row.read !== null && !v.dupOf && v.row.result?.kind !== 'added' && v.row.result?.kind !== 'existing' && bulkIgnorable(v.row.read, v.row.choice),
  )
  /** 그 줄들을 무시로 바꾸고 체크만 한다 — 저장은 「이대로 등록」 때(D6). 줄마다 다시 고를 수 있다. */
  const ignoreAllNone = () => {
    const keys = new Set(bulkTargets.map((v) => v.row.key))
    setRows((rs) => rs.map((r) => (keys.has(r.key) ? { ...r, choice: { mode: 'ignore' as const }, checked: true, result: null } : r)))
    setCommitNote(`앱 글 아님 줄 ${keys.size}편을 「무시」로 바꿔 체크했습니다 — 「이대로 등록」을 눌러야 저장합니다. 읽지 못한 줄은 하나씩 고르세요.`)
  }
  // 같은 앱 글을 둘 이상의 체크한 줄이 고르면 알린다 — 두 주소 모두 그 글의 기록이 된다.
  const pickCount = new Map<string, number>()
  for (const v of ready) {
    const pick = appPick(v.row.choice)
    if (pick) pickCount.set(pickKey(pick), (pickCount.get(pickKey(pick)) ?? 0) + 1)
  }

  return (
    <details className="pi-panel">
      <summary>
        <span className="pi-title">주소 한꺼번에 등록</span>
        <span className="pi-sub">작성자가 보낸 글 주소를 읽어 앱 글과 맞춘 뒤 확인한 것만 올린 글로 적습니다 · 앱에서 만들지 않은 글은 앱 밖 글로 추적하거나 무시합니다</span>
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
                  글 주소 {extracted.urls.length}개 · {queueText(extracted)}
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
                글이 오릅니다). 앱 밖 글로 추적 중인 글과 무시한 글은 새 글 찾기에서 뺍니다.
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
              {findNote && (
                <p className="pi-note" role="status">
                  {findNote}
                </p>
              )}
              <div className="pi-row">
                <button type="button" className="btn" aria-expanded={ignored.open} aria-controls="pi-ignored-box" onClick={toggleIgnored}>
                  무시한 글 보기 · 되돌리기
                </button>
              </div>
              {ignored.open && (
                <div id="pi-ignored-box" className="pi-ignored-box">
                  {ignored.loading && <p className="muted pi-empty">무시한 글을 불러오는 중…</p>}
                  {ignored.error && (
                    <p className="error pi-note" role="alert" tabIndex={-1} ref={ignoredMsgRef}>
                      {ignored.error}
                    </p>
                  )}
                  {!ignored.loading && ignored.list?.length === 0 && <p className="muted pi-empty">무시한 글이 없습니다.</p>}
                  {ignored.list && ignored.list.length > 0 && (
                    <>
                      <p className="pi-label">
                        무시한 글 {ignored.list.length}편(최근 것부터 · {ignored.max}편까지 둡니다). 되돌리면 다음 「새 글 찾기」에 다시 나옵니다.
                      </p>
                      <ul className="pi-ignored-list">
                        {ignored.list.slice(0, ignored.shown).map((e) => (
                          <li key={`${e.url}|${e.ignoredAt}`}>
                            <a href={e.url} target="_blank" rel="noreferrer" title={e.url}>
                              {shortUrl(e.url)}
                            </a>
                            <span className="pi-platform">{kstDate(e.ignoredAt) ?? e.ignoredAt.slice(0, 10)} 무시</span>
                            <button
                              type="button"
                              className="ps-mark"
                              // 처리하는 동안 disabled로 바꾸면 누른 단추에서 포커스가 빠진다 — aria-disabled로 막는다.
                              onClick={() => {
                                if (ignored.busy === null) void restoreIgnored(e)
                              }}
                              aria-disabled={ignored.busy !== null || undefined}
                              aria-label={`${shortUrl(e.url)} 무시 되돌리기`}
                            >
                              되돌리기
                            </button>
                          </li>
                        ))}
                      </ul>
                      {ignored.list.length > ignored.shown && (
                        <div className="pi-row">
                          <button type="button" className="btn" onClick={() => patchIgnored({ shown: ignored.shown + IGNORED_PAGE })}>
                            더 보기 ({ignored.list.length - ignored.shown}편 남음)
                          </button>
                        </div>
                      )}
                    </>
                  )}
                  {ignored.note && (
                    <p className="pi-note" role="status" tabIndex={-1} ref={ignoredMsgRef}>
                      {ignored.note}
                    </p>
                  )}
                </div>
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
                <progress max={phase.total} value={phase.done} aria-label="주소 읽기 진행" />
                <span>
                  읽는 중 {phase.done}/{phase.total}
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
                    {views.map(({ row, state, verdict, candidate, registrable, blockReason, dupOf }) => {
                      const read = row.read
                      const ok = read?.ok ? read : null
                      const choice = row.choice
                      const external = choice.mode === 'external' ? choice : null
                      const label = ok?.post.title || shortUrl(row.url)
                      const recordUrl = recordUrlOf(row)
                      const pick = appPick(choice)
                      const runnerUp = ok ? Math.max(0, ...ok.candidates.filter((c) => !samePick(c, pick)).map((c) => c.body)) : 0
                      const twin = row.checked && registrable && pick !== null && (pickCount.get(pickKey(pick)) ?? 0) > 1
                      const others = candidate ? otherUrlsNow(candidate, recordKeyOf(row), row.readSeq, registered) : 0
                      const finished = row.result?.kind === 'added' || row.result?.kind === 'existing'
                      const dated = choice.mode !== 'ignore' && !(external?.dateUnknown ?? false)
                      const dateBad = registrable && dated && row.date !== '' && !validDay(row.date, limit)
                      const pageDate = ok?.post.dateText ? (ok.post.dateText.length > 40 ? `${ok.post.dateText.slice(0, 40)}…` : ok.post.dateText) : null
                      const tracked = read?.tracked ?? []
                      const appIn = ok && external ? sameUrlAppBrands(ok, external.tenantIds) : []
                      const chosenBrands = external ? brands.filter((b) => external.tenantIds.includes(b.tenantId)).map((b) => b.brand) : []
                      const owned = ok?.ownedBrands ?? []
                      const canIgnore = read !== null && (ignoreOptionAllowed(read) || choice.mode === 'ignore')
                      // 이 브랜드에서 내렸던 주소를 다시 적는다 — 페이지 날짜가 처음 올린 날이면 내린 동안을 「올라가 있음」으로 센다(C9).
                      const repost = ok && external ? externalRepostProblem(ok, external.tenantIds, external.dateUnknown ? null : row.date || null) : null
                      return (
                        <tr key={row.key} className={(state && BLOCKED.includes(state)) || dupOf ? 'pi-blocked' : undefined}>
                          <td>
                            <input
                              type="checkbox"
                              checked={row.checked && registrable}
                              disabled={!registrable || committing}
                              onChange={(e) => patchRow(row.key, { checked: e.target.checked })}
                              aria-label={`「${label}」 등록에 넣기`}
                            />
                          </td>
                          <td>
                            {choice.mode === 'app' && (candidate?.brand ?? '—')}
                            {external && (chosenBrands.length > 0 ? chosenBrands.join(', ') : tracked.length > 0 ? <span className="muted">{trackedText(tracked)}</span> : '—')}
                            {choice.mode === 'ignore' && '—'}
                          </td>
                          <td className={candidate?.writer ? undefined : 'muted'}>
                            {choice.mode === 'app' ? (candidate ? writerText(candidate) : '—') : external ? '앱 밖 글' : '—'}
                            {/* 판 미확인 — 질문 은행에서 만든 배정 글. 등록하면 배정 파일의 판으로 적으므로 보관함 작성자 칸과 같은 표시를 단다. */}
                            {candidate?.bankUnknown && (
                              <span className="pi-sub-line">
                                <span className="chip warn" title={BANK_UNKNOWN_NOTE}>
                                  판 미확인<span className="sr-only"> — {BANK_UNKNOWN_NOTE}</span>
                                </span>
                              </span>
                            )}
                          </td>
                          <td>
                            {ok ? (
                              <>
                                <select
                                  value={choiceValue(choice)}
                                  onChange={(e) => choose(row, e.target.value)}
                                  disabled={committing || row.result?.kind === 'added'}
                                  aria-label={`「${label}」과 짝지을 앱 글`}
                                >
                                  {ok.candidates.map((c) => (
                                    <option key={pickKey(c)} value={pickKey(c)}>
                                      {c.title} — {c.brand} · {scorePercent(c.body)}
                                    </option>
                                  ))}
                                  <option value="">앱 글 아님</option>
                                  <option value={EXTERNAL}>앱 밖 글로 추적…</option>
                                  {canIgnore && <option value={IGNORE}>무시 — 새 글 찾기에서 숨김</option>}
                                </select>
                                {candidate && <span className="pi-sub-line">앱 글: {candidate.title}</span>}
                                <span className="pi-sub-line">블로그 제목: {ok.post.title || externalTitle({ title: null })}</span>
                                {external && (
                                  <fieldset className="pi-brands" disabled={committing || finished} aria-label={`「${label}」 추적할 브랜드`}>
                                    <legend>추적할 브랜드(하나 이상)</legend>
                                    {brands.length === 0 && <span className="pi-sub-line warn">고객 브랜드 목록을 불러오지 못했습니다 — 발행 현황을 다시 읽어 주세요.</span>}
                                    <ul>
                                      {brands.map((b) => {
                                        const brandState = externalBrandState(ok, b.tenantId)
                                        const why = brandState === 'blocked' ? externalBlockMessage(ok, b.tenantId) : null
                                        return (
                                          <li key={b.tenantId}>
                                            <label title={why ?? undefined}>
                                              <input
                                                type="checkbox"
                                                checked={brandState === 'tracked' || external.tenantIds.includes(b.tenantId)}
                                                disabled={brandState !== 'open'}
                                                onChange={(e) => patchExternal(row, { tenantId: b.tenantId, on: e.target.checked })}
                                              />
                                              {b.brand}
                                              {brandState === 'tracked' && <span className="pi-brand-note"> 추적 중</span>}
                                              {brandState === 'blocked' && <span className="pi-brand-note"> 이 브랜드의 앱 글</span>}
                                            </label>
                                          </li>
                                        )
                                      })}
                                    </ul>
                                  </fieldset>
                                )}
                                {external && owned.length === 1 && <span className="pi-sub-line">자사 주소인 브랜드: {owned[0]!.brand}</span>}
                                {external && owned.length > 1 && (
                                  <span className="pi-sub-line">자사 주소인 브랜드가 여럿({owned.map((o) => o.brand).join(', ')})이라 미리 고르지 않았습니다.</span>
                                )}
                                {choice.mode === 'ignore' && !ok.ignoredAt && (
                                  <span className="pi-sub-line">앱 글이 아닌 글입니다 — 새 글 찾기에 더 나오지 않습니다(앱 글 · 앱 밖 글로 적으면 풀립니다).</span>
                                )}
                              </>
                            ) : read && !read.ok ? (
                              // 읽지 못한 줄은 무시만 할 수 있다(사이트맵에 남은 지운 글 · 비공개 글 — D14).
                              <select value={choiceValue(choice)} onChange={(e) => choose(row, e.target.value)} disabled={committing || row.result?.kind === 'added'} aria-label={`「${label}」 처리`}>
                                <option value="">—</option>
                                {canIgnore && <option value={IGNORE}>무시 — 새 글 찾기에서 숨김</option>}
                              </select>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                          <td className="pi-url">
                            <a href={recordUrl} target="_blank" rel="noreferrer" title={recordUrl}>
                              {shortUrl(recordUrl)}
                            </a>
                            {ok?.urlNote && (
                              <span className="pi-sub-line">
                                {ok.urlNote} 붙여 넣은 주소: {shortUrl(row.url)}
                              </span>
                            )}
                          </td>
                          <td>{ok ? ok.platform.label : '—'}</td>
                          <td>
                            {ok && choice.mode !== 'ignore' ? (
                              <>
                                <input
                                  type="date"
                                  className="pi-date"
                                  value={row.date}
                                  min="2020-01-01"
                                  max={limit}
                                  onChange={(e) => patchRow(row.key, { date: e.target.value, movedDate: false, result: null })}
                                  disabled={committing || !registrable || !dated}
                                  aria-label={`「${label}」 올린 날`}
                                  aria-invalid={dateBad || undefined}
                                  title={ok.post.dateText ? `페이지 날짜: ${ok.post.dateText}` : undefined}
                                />
                                {external && (
                                  <label className="pi-sub-line pi-check">
                                    <input
                                      type="checkbox"
                                      checked={external.dateUnknown}
                                      onChange={(e) => patchExternal(row, { dateUnknown: e.target.checked })}
                                      disabled={committing || finished}
                                      aria-label={`「${label}」 날짜 모름`}
                                    />
                                    날짜 모름
                                  </label>
                                )}
                                {dated &&
                                  !ok.post.publishedOn &&
                                  (pageDate ? (
                                    <span className={`pi-sub-line${registrable && !row.date ? ' warn' : ''}`}>
                                      페이지 날짜 「{pageDate}」를 쓸 수 없습니다 — {ok.post.dateProblem ? DATE_PROBLEM_TEXT[ok.post.dateProblem] : DATE_PROBLEM_TEXT.unknown}
                                      {row.date ? ' · 고른 날' : registrable ? ' · 골라 주세요' : ''}
                                    </span>
                                  ) : registrable && !row.date ? (
                                    <span className="pi-sub-line warn">페이지에 날짜가 없어 골라야 합니다{external ? '(모르면 「날짜 모름」)' : ''}</span>
                                  ) : (
                                    <span className="pi-sub-line">페이지에 날짜 없음{row.date ? ' — 고른 날' : ''}</span>
                                  ))}
                                {dated && ok.post.publishedOn && row.date !== ok.post.publishedOn && <span className="pi-sub-line">페이지: {ok.post.publishedOn}</span>}
                                {external?.dateUnknown && <span className="pi-sub-line">올린 날 모름 — 올리기 전 · 뒤를 가리지 않고 셉니다.</span>}
                                {repost && !finished && <span className="pi-sub-line warn">{repost}</span>}
                                {dateBad && (
                                  <span className="pi-sub-line error" role="alert">
                                    2020-01-01부터 오늘({limit})까지의 날을 골라 주세요.
                                  </span>
                                )}
                              </>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td title={candidate ? `제목 겹침 ${scorePercent(candidate.titleScore)}` : undefined}>
                            {candidate ? (
                              <>
                                본문 {scorePercent(candidate.body)}
                                <span className="pi-sub-line">
                                  {runnerUp > candidate.body ? '더 높은 후보' : '다음'} {scorePercent(runnerUp)}
                                </span>
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
                            {row.result?.kind === 'added' && <span className="chip good">{choice.mode === 'ignore' ? '무시함' : '등록함'}</span>}
                            {row.result?.kind === 'existing' && <span className="chip info">{choice.mode === 'ignore' ? '무시함' : '이미 등록됨'}</span>}
                            {row.result?.kind === 'partial' && <span className="chip warn">일부만 등록함</span>}
                            {state && !finished && (dupOf ? <span className="chip info">같은 글 주소</span> : <span className={`chip${STATE_TONE[state] ? ` ${STATE_TONE[state]}` : ''}`}>{ROW_STATE_LABEL[state]}</span>)}
                            {dupOf && !finished && <span className="pi-sub-line">표의 위 줄({shortUrl(dupOf.url)})과 같은 글 주소입니다 — 그 줄로 등록합니다.</span>}
                            {!dupOf && state === 'review' && !row.result && <span className="pi-sub-line">비슷한 앱 글이 둘 이상이거나 겹침이 낮습니다 — 맞는 글을 골라 체크하세요.</span>}
                            {!dupOf && state === 'none' && <span className="pi-sub-line">앱 글과 겹치는 부분이 적습니다. 맞는 글이 있으면 고르고, 아니면 앱 밖 글로 추적하거나 무시하세요.</span>}
                            {!dupOf && state === 'manual' && !row.result && (
                              <span className="pi-sub-line warn">가장 잘 맞는 글이 아닌 글을 골랐습니다 — 이 글이 맞으면 체크하세요.</span>
                            )}
                            {tracked.length > 0 && <span className="pi-sub-line">앱 밖 글로 추적 중: {trackedText(tracked)}</span>}
                            {ok && movesExternal(ok, pick) && !finished && (
                              <span className="pi-sub-line warn">
                                이 브랜드의 앱 밖 글을 앱 글로 옮깁니다 — 올린 날은 옮기는 날(오늘)로 둡니다. 그 전 인용은 앱 밖 글 표에 남고, 앱 밖 줄은 「앱 글로
                                옮김」으로 쉽니다.
                              </span>
                            )}
                            {read?.ignoredAt && <span className="pi-sub-line">{monthDay(kstDate(read.ignoredAt) ?? read.ignoredAt.slice(0, 10))}에 무시한 주소입니다(앱 글 · 앱 밖 글로 적으면 풀립니다).</span>}
                            {(ok?.stateUnknown ?? []).length > 0 && (
                              <span className="pi-sub-line warn">{ok!.stateUnknown!.join(' · ')}을(를) 읽지 못해 앱 밖 글 · 무시 여부를 다 보지 못했습니다 — 미리 체크하지 않았습니다.</span>
                            )}
                            {external && appIn.length > 0 && <span className="pi-sub-line">같은 주소: {appIn.join(', ')}의 앱 글</span>}
                            {external && !row.result && blockReason && external.tenantIds.length > 0 && <span className="pi-sub-line warn">{blockReason}</span>}
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
                            {registrable && others > 0 && (
                              <span className="pi-sub-line warn">이 앱 글에는 이미 다른 주소 {others}개가 적혀 있습니다 — 같은 글을 또 올린 것이면 이 주소도 더합니다.</span>
                            )}
                            {twin && <span className="pi-sub-line warn">같은 앱 글을 고른 줄이 또 있습니다 — 두 주소 모두 그 글의 기록이 됩니다.</span>}
                            {(row.result?.kind === 'added' || row.result?.kind === 'existing') && external && <span className="pi-sub-line">{row.result.text}</span>}
                            {(row.result?.kind === 'error' || row.result?.kind === 'partial') && (
                              <span className={`pi-sub-line ${row.result.kind === 'error' ? 'error' : 'warn'}`} role="alert">
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
                <button type="button" className="btn primary" onClick={() => void register()} disabled={busy || ready.length === 0}>
                  이대로 등록{readyText ? ` (${readyText})` : ''}
                </button>
                {bulkTargets.length > 0 && (
                  <button
                    type="button"
                    className="btn"
                    onClick={ignoreAllNone}
                    disabled={busy}
                    title="표의 「앱 글 아님」 줄을 모두 「무시」로 바꾸고 체크합니다 — 저장은 「이대로 등록」을 누를 때 합니다. 읽지 못한 줄은 넣지 않습니다."
                  >
                    앱 글 아님 줄 모두 무시 ({bulkTargets.length})
                  </button>
                )}
                {retryable > 0 && (
                  <button type="button" className="btn" onClick={retry} disabled={busy}>
                    다시 읽기 — 읽지 못함 · 멈춤 · 적혔는지 모름 ({retryable})
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
