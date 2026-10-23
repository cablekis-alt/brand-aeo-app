import { useState } from 'react'
import type { ActionStatus, PostRemovedReason, PublishedPost } from '../lib/api'
import type { PublishedHit } from '../lib/gapActions'
import { INDEXING_GRACE_DAYS, withinIndexingGrace } from '../lib/publishTracking'
import { ARTICLE_URL_REASON, isArticleUrl, kstDate, todayKst } from '../lib/publishedUrl'
import { UrlLink } from './CitationBits'

const REMOVED_LABEL: Record<PostRemovedReason, string> = {
  mistake: '잘못 적은 주소',
  'taken-down': '글을 내림',
}

/** "2026-10-19" → "10/19" */
const shortDate = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`

/**
 * 이번 주 결과 한 줄. 숫자는 정확 일치 인용만 센다(src/lib/publishedUrl.ts). 올리기 전에 한 측정은 세지 않고, 측정하던 날 올린
 * 글은 전후를 알 수 없다고 밝힌다. 질문 은행을 못 읽은 주는 이름 없는/이름 댄 질문을 0이 아니라 확인 불가로 둔다.
 */
function statusOf(h: PublishedHit, week: string, citedOtherRun: boolean): { pill: string; cls: string; detail: string | null } {
  // 같은 주 다른 회차에서 인용됐다 — 이 결과는 마지막 저장 측정만 보므로 기준을 밝힌다(AEO 퍼포먼스 올린 글 표는 회차를 합쳐 센다).
  if (!h.tally && citedOtherRun) {
    return {
      pill: '인용됨(다른 회차)',
      cls: 'st-info',
      detail: `${week} 같은 주 다른 회차에서 인용됨 — 마지막 저장 측정에서는 찾지 못했습니다. 회차별 결과는 AEO 퍼포먼스의 올린 글 인용 추적에 있습니다.`,
    }
  }
  if (h.timing === 'before') return { pill: '올리기 전 측정', cls: 'st-unknown', detail: `${week} 측정은 올린 날보다 앞이라 세지 않습니다.` }
  const unsure = h.timing === 'during' || h.timing === 'ambiguous'
  // during: 측정하던 날 올렸다. ambiguous: 측정 시각이 없는 옛 기록인데 같은 주에 올렸다 — 측정 중이었다고 단정하지 않는다.
  const unsureWhy = h.timing === 'during' ? '측정하던 날 올림' : '같은 주에 올렸는데 측정 시각 기록이 없음'
  const t = h.tally
  if (!t) {
    if (unsure) {
      return { pill: '전후 불명', cls: 'st-unknown', detail: `${week} — ${unsureWhy}이라, 인용이 없던 것이 올리기 전이라 그런지 알 수 없습니다.` }
    }
    // 갓 올린 글 — 색인 · 인용까지 시간이 걸려 이 주의 「인용 없음」으로 판단하지 않는다(올린 글 인용 추적의 「색인 대기」와 같은 기준).
    if (withinIndexingGrace(h.daysAfterPublish)) {
      return {
        pill: '색인 대기',
        cls: 'st-unknown',
        // 내린 글에는 다시 오지 않을 측정을 약속하지 않는다.
        detail: h.takenDownOn
          ? `${week} 측정은 올린 지 ${h.daysAfterPublish}일 뒤라 인용이 없어도 판단하지 않습니다 — 그 뒤 글을 내려 더 판단할 측정이 없습니다.`
          : `${week} 측정은 올린 지 ${h.daysAfterPublish}일 뒤라 인용이 없어도 아직 판단하지 않습니다(${INDEXING_GRACE_DAYS}일 지난 측정부터).`,
      }
    }
    return { pill: '인용 없음', cls: 'st-unknown', detail: `${week} 측정의 AI 답변 인용에서 이 주소를 찾지 못했습니다.` }
  }
  const counts =
    t.unnamed && t.named
      ? `${week} · 이름 없는 질문 ${t.unnamed.cited} · 이름 댄 질문 ${t.named.cited} · 뒷받침 ${t.all.supporting}`
      : `${week} · 인용 ${t.all.cited} · 질문지를 못 읽어 질문 유형은 확인 불가`
  return {
    pill: '인용됨',
    cls: t.unnamed && t.unnamed.cited > 0 ? 'st-good' : 'st-info',
    detail: unsure ? `${counts} (${unsureWhy} — 전후 불명)` : counts,
  }
}

/**
 * 올린 글 주소 — 집행 원장(server/publishedPosts.ts)의 기록을 적고, 이번 주 측정에서 그 글이 인용됐는지 보인다.
 * judged가 false면 주차 판정 없이 기록(올린 날 · 올린 곳)만 보인다.
 *
 * 주소마다 올린 날을 함께 남긴다(기본 오늘, 고칠 수 있다). 며칠 뒤에 적는 일이 흔해서, 적은 시각을 올린 날로 쓰면 그 사이
 * 측정이 「올리기 전」으로 잡힌다. 「빼기」는 지우지 않는다 — 잘못 적은 주소는 이력에서 빼고, 내린 글은 내린 날까지 남긴다.
 */
export default function PublishedUrlEditor({
  hits,
  removed,
  weekOf,
  addLabel = '추가',
  busy,
  onRecord,
  onRemove,
  onRestore,
  onSetDate,
  judged = true,
  targetLabel,
  citedInWeek = null,
}: {
  /** 이 곳의 뺀 적 없는 기록과 이번 주 결과. */
  hits: PublishedHit[]
  /** 이 곳의 뺀 기록 — 접어 두고 되살린다. */
  removed: PublishedPost[]
  weekOf: string
  addLabel?: string
  busy: boolean
  /** 성공하면 null — 입력칸을 비운다. 실패하면 이유(이 칸에만 보인다). chosen: 사람이 날짜를 바꿨는가. */
  onRecord: (url: string, publishedOn: string, chosen: boolean) => Promise<string | null>
  onRemove: (postId: string, reason: PostRemovedReason) => void
  onRestore: (postId: string) => void
  onSetDate: (postId: string, date: string) => void
  /** false면 주차 판정을 보이지 않는다(src/lib/gapActions.ts recordOnlyHits). */
  judged?: boolean
  /** 기록마다 어느 줄에 올린 것인지 — 한 글의 기록을 모아 볼 때(콘텐츠 보관함). */
  targetLabel?: (post: PublishedPost) => string
  /** 그 주 회차를 합친 칸에서 인용된 기록 id(src/lib/publishTracking.ts citedPostIdsInWeek). 없으면 마지막 저장 측정만 본다. */
  citedInWeek?: ReadonlySet<string> | null
}) {
  const today = todayKst()
  const [input, setInput] = useState('')
  // 날짜칸을 열었는가와 그 값을 따로 둔다 — 날짜 한 칸을 지우면 값이 ''가 되는데, 그때 칸을 닫으면 고치던 날짜와 포커스를 잃는다.
  const [dateOpen, setDateOpen] = useState(false)
  const [date, setDate] = useState(today)
  const [reject, setReject] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; date: string } | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const week = weekOf ? weekOf.slice(5) : '이번 주'
  const otherRun = (h: PublishedHit) => !h.tally && Boolean(citedInWeek?.has(h.post.id))
  const citedCount = hits.filter((h) => (h.timing !== 'before' && h.tally) || otherRun(h)).length

  const dateValid = !dateOpen || (/^\d{4}-\d{2}-\d{2}$/.test(date) && date <= today)
  const add = async () => {
    const url = input.trim()
    if (!url) return
    const check = isArticleUrl(url)
    if (!check.ok) {
      setReject(ARTICLE_URL_REASON[check.reason])
      return
    }
    if (!dateValid) {
      setReject('올린 날을 오늘이나 그 전 날짜로 골라 주세요.')
      return
    }
    setReject(null)
    const failed = await onRecord(url, dateOpen ? date : today, dateOpen)
    if (failed) {
      setReject(failed)
      return
    }
    setInput('')
    setDateOpen(false)
    setDate(today)
  }
  // 내린 글이 이 주에는 아직 올라가 있었으면 위 목록에 보인다 — 아래 「뺀 주소」에 두 번 보이지 않게.
  const shownIds = new Set(hits.map((h) => h.post.id))
  const removedOnly = removed.filter((p) => !shownIds.has(p.id))

  return (
    <div className="post-editor">
      <p className="gap-tally" style={{ marginBottom: 4 }}>
        올린 글 주소
        {hits.length > 0 && (judged ? ` · ${week} 인용 확인 ${citedCount}/${hits.length}` : ` ${hits.length}개`)}
      </p>
      {hits.length > 0 && (
        <ul className="post-list">
          {hits.map((h) => {
            const s = statusOf(h, week, otherRun(h))
            const p = h.post
            return (
              <li key={p.id}>
                <div className="post-line">
                  <UrlLink url={p.url} max={64} />
                  {judged && <span className={`status-pill ${s.cls}`}>{s.pill}</span>}
                  {targetLabel && <span className="st st-info">{targetLabel(p)}</span>}
                </div>
                <p className="doc-meta post-meta">
                  {p.publishedOn ? `${shortDate(p.publishedOn)} 올림` : '올린 날 모름(옛 기록)'}
                  {h.takenDownOn && ` · ${shortDate(h.takenDownOn)}에 글 내림(이 주는 올라가 있던 때)`}
                  {judged && s.detail && ` · ${s.detail}`}
                  {judged && h.variantCited > 0 && ` · 질의만 다른 주소에서 ${h.variantCited}회(같은 글인지 확인 필요, 숫자에 넣지 않음)`}{' '}
                  {/* 내린 글은 이 줄에서 되살리거나 「잘못 적은 주소」로 바꾼다 — 이 주에 보이는 동안은 아래 「뺀 주소」에 두 번 두지 않는다. */}
                  {h.takenDownOn ? (
                    <>
                      <button type="button" className="link-btn" disabled={busy} onClick={() => onRestore(p.id)}>
                        되살리기
                      </button>{' '}
                      <button type="button" className="link-btn" disabled={busy} onClick={() => onRemove(p.id, 'mistake')}>
                        잘못 적은 주소로 바꾸기
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="button" className="link-btn" disabled={busy} onClick={() => setEditing({ id: p.id, date: p.publishedOn ?? today })}>
                        날짜 고치기
                      </button>{' '}
                      <button type="button" className="link-btn" disabled={busy} onClick={() => setRemoving(removing === p.id ? null : p.id)}>
                        빼기
                      </button>
                    </>
                  )}
                </p>
                {editing?.id === p.id && (
                  <div className="post-row">
                    <input
                      type="date"
                      value={editing.date}
                      max={today}
                      aria-label="올린 날"
                      onChange={(e) => setEditing({ id: p.id, date: e.target.value })}
                    />
                    <button
                      type="button"
                      className="ghost"
                      disabled={!editing.date || editing.date > today}
                      onClick={() => {
                        onSetDate(p.id, editing.date)
                        setEditing(null)
                      }}
                    >
                      저장
                    </button>
                    <button type="button" className="ghost" onClick={() => setEditing(null)}>
                      취소
                    </button>
                  </div>
                )}
                {removing === p.id && (
                  <div className="post-row">
                    <span className="doc-meta">왜 빼나요?</span>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => {
                        onRemove(p.id, 'mistake')
                        setRemoving(null)
                      }}
                    >
                      잘못 적은 주소
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => {
                        onRemove(p.id, 'taken-down')
                        setRemoving(null)
                      }}
                    >
                      글을 내렸어요
                    </button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <div className="post-row">
        <input
          type="url"
          value={input}
          placeholder="https://… 올린 글 주소"
          aria-label="올린 글 주소"
          disabled={busy}
          onChange={(e) => {
            setInput(e.target.value)
            setReject(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void add()
            }
          }}
          style={{ flex: 1, minWidth: 0 }}
        />
        <button type="button" className="ghost" onClick={() => void add()} disabled={busy || !/^https?:\/\/\S+$/i.test(input.trim())}>
          {busy ? '저장 중…' : addLabel}
        </button>
      </div>
      <p className="doc-meta post-meta">
        올린 날{' '}
        {dateOpen ? (
          <>
            <input type="date" value={date} max={today} aria-label="올린 날" onChange={(e) => setDate(e.target.value)} />{' '}
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setDateOpen(false)
                setDate(today)
              }}
            >
              오늘로
            </button>
          </>
        ) : (
          <>
            오늘({shortDate(today)}){' '}
            <button type="button" className="link-btn" onClick={() => setDateOpen(true)}>
              바꾸기
            </button>
          </>
        )}
        {' — 며칠 뒤에 적는다면 실제로 올린 날로 바꾸세요. 그 사이 측정을 「올리기 전」으로 세지 않습니다.'}
      </p>
      {reject && <p className="error">{reject}</p>}
      {removedOnly.length > 0 && (
        <details className="draft-audit">
          <summary>뺀 주소 {removedOnly.length}개</summary>
          <ul className="post-list">
            {removedOnly.map((p) => (
              <li key={p.id}>
                <span className="muted">{p.url}</span>{' '}
                <span className="doc-meta">
                  {p.removedReason ? REMOVED_LABEL[p.removedReason] : '뺌'}
                  {p.removedAt && kstDate(p.removedAt) && ` · ${shortDate(kstDate(p.removedAt)!)}`}
                </span>{' '}
                <button type="button" className="link-btn" disabled={busy} onClick={() => onRestore(p.id)}>
                  되살리기
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

/** 집행 상태 — 콘텐츠 생성 카드(GapActions.tsx STATUS_CHOICES)와 같은 말을 쓴다. 「완료」가 아니라 「집행함」이다. */
const STATUS_CHOICES: { value: ActionStatus; label: string; title: string }[] = [
  { value: 'todo', label: '안 함', title: '아직 손대지 않음' },
  { value: 'doing', label: '진행 중', title: '작업하고 있음' },
  { value: 'done', label: '집행함', title: '올렸음' },
  { value: 'skip', label: '보류', title: '하지 않기로 함' },
]

/** 글 하나의 집행 상태 버튼 — 질문 은행 · 콘텐츠 보관함처럼 실행 항목 카드가 없는 화면이 쓴다. */
export function ExecutionStatusButtons({
  label,
  status,
  disabled,
  allowSkip = true,
  onChange,
}: {
  label: string
  status: ActionStatus
  disabled?: boolean
  /** 콘텐츠 생성의 글(content:)은 보류하지 않는다 — 보류하면 올리기 목록이 채널마다 따로 쓸 글로 쪼개진다(gapActions.ts). */
  allowSkip?: boolean
  onChange: (status: ActionStatus) => void
}) {
  return (
    <div className="action-status" role="group" aria-label={`${label} 집행 상태`}>
      {STATUS_CHOICES.filter((c) => allowSkip || c.value !== 'skip').map((c) => (
        <button
          key={c.value}
          type="button"
          title={c.title}
          disabled={disabled}
          className={status === c.value ? 'on' : undefined}
          aria-pressed={status === c.value}
          // 이미 눌린 상태를 다시 저장하지 않는다 — 이 화면은 주차가 없어서, 다시 저장하면 콘텐츠 생성에서 남긴 집행 주(markedWeek)가 지워진다.
          onClick={() => {
            if (status !== c.value) onChange(c.value)
          }}
        >
          {c.label}
        </button>
      ))}
    </div>
  )
}
