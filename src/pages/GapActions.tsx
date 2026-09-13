import { Link } from 'react-router-dom'
import WeekPicker from '../components/WeekPicker'
import { useTenant } from '../context/useTenant'
import { useEffect, useState } from 'react'
import {
  generateContentBrief,
  generateContentDraft,
  loadContentBriefs,
  loadContentDrafts,
  type ActionStatus,
  type StoredBrief,
  type StoredDraft,
} from '../lib/api'
import { isOpenAction, type GapAction } from '../lib/gapActions'
import { useGapActionPlan } from '../lib/useGapActionPlan'

// 배지 문구는 항목이 정한다(출처마다 하는 일이 다르다). 화면은 색만 정한다.
const KIND_CLASS: Record<GapAction['kind'], string> = { listing: 'st-warn', content: 'st-info' }

/**
 * 집행 상태 버튼 — '완료'가 아니라 '집행함'이다.
 *
 * 사람이 충족(satisfied)을 직접 켤 수는 없다. 그건 데이터가 정한다. 여기서 고르는 건
 * "내가 그 일을 했는가"뿐이고, 그래서 집행했는데 아직 인용이 안 잡힌 항목이 드러난다.
 */
const STATUS_CHOICES: { value: ActionStatus; label: string; title: string }[] = [
  { value: 'todo', label: '안 함', title: '아직 손대지 않음' },
  { value: 'doing', label: '진행 중', title: '작업하고 있음' },
  { value: 'done', label: '집행함', title: '올렸음 — 인용이 잡히면 자동으로 충족이 된다' },
  { value: 'skip', label: '보류', title: '하지 않기로 함 — 목록 아래로 내린다' },
]

/** 브리프를 마크다운으로 — 문서 도구에 붙여 넣기용. 본문이 아니라 뼈대다. */
function briefToMarkdown(title: string, b: StoredBrief['brief']): string {
  const L: string[] = [`# 브리프 · ${title}`, '']
  if (b.titles.length) L.push('## 제목 후보', ...b.titles.map((t) => `- ${t}`), '')
  if (b.audience) L.push('## 독자', b.audience, '')
  if (b.questionsToAnswer.length) L.push('## 답해야 할 질문', ...b.questionsToAnswer.map((q) => `- ${q}`), '')
  if (b.mustIncludeFacts.length) L.push('## 반드시 넣을 사실(팩트 그래프)', ...b.mustIncludeFacts.map((x) => `- ${x}`), '')
  if (b.doNotClaim.length) L.push('## 확인 필요한 사실(팩트 그래프에 없음)', ...b.doNotClaim.map((x) => `- ${x}`), '')
  if (b.structure.length) L.push('## 구조', ...b.structure.map((s) => `- **${s.heading}** (${s.format}) — ${s.answers}`), '')
  if (b.citableSentences.length) L.push('## 인용용 문장', ...b.citableSentences.map((x) => `- ${x}`), '')
  if (b.channelNotes.length) L.push('## 채널 메모', ...b.channelNotes.map((x) => `- ${x}`), '')
  return L.join('\n')
}

/**
 * 콘텐츠 브리프 패널. 글을 써 주지 않는다 — 무엇에 답하고, 어떤 사실만 쓰고, 어떤 구조가
 * 인용되기 쉬운지까지다. 사실은 팩트 그래프에서만 오고, 없는 것은 "확인 필요"로 남는다.
 * 한 번 만든 브리프는 저장되어 다음 주에도 그대로 열린다(판정 호출은 처음 한 번).
 */
function BriefPanel({
  tenantId,
  action,
  stored,
  onStored,
}: {
  tenantId: string
  action: GapAction
  stored: StoredBrief | undefined
  onStored: (s: StoredBrief) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const make = async (force: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const s = await generateContentBrief(
        tenantId,
        {
          actionId: action.id,
          kind: action.kind,
          title: action.title,
          targetDomain: action.targetDomain,
          questionTexts: action.questionTexts,
          evidence: action.evidence,
        },
        force,
      )
      onStored(s)
      setOpen(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const copy = async () => {
    if (!stored) return
    try {
      await navigator.clipboard.writeText(briefToMarkdown(action.title, stored.brief))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('클립보드에 복사하지 못했습니다.')
    }
  }
  const b = stored?.brief
  return (
    <div className="brief">
      <div className="brief-bar">
        {!stored ? (
          <button type="button" onClick={() => void make(false)} disabled={busy}>
            {busy ? '브리프 만드는 중…' : '브리프 만들기 (판정 1회)'}
          </button>
        ) : (
          <>
            <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              {open ? '브리프 접기' : '브리프 보기'}
            </button>
            <button type="button" className="ghost" onClick={() => void copy()}>
              {copied ? '복사됨' : '마크다운 복사'}
            </button>
            <button type="button" className="ghost" onClick={() => void make(true)} disabled={busy}>
              {busy ? '다시 만드는 중…' : '다시 만들기'}
            </button>
            <span className="doc-meta">{stored.generatedAt.slice(0, 10)} 생성</span>
          </>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {open && b && (
        <div className="brief-body">
          {b.titles.length > 0 && (
            <section>
              <h4>제목 후보</h4>
              <ul>{b.titles.map((t) => <li key={t}>{t}</li>)}</ul>
            </section>
          )}
          {b.audience && (
            <section>
              <h4>독자</h4>
              <p>{b.audience}</p>
            </section>
          )}
          {b.questionsToAnswer.length > 0 && (
            <section>
              <h4>답해야 할 질문</h4>
              <ul>{b.questionsToAnswer.map((q) => <li key={q}>{q}</li>)}</ul>
            </section>
          )}
          <section>
            <h4>
              반드시 넣을 사실 <span className="muted">(팩트 그래프에서만)</span>
            </h4>
            {b.mustIncludeFacts.length > 0 ? (
              <ul>{b.mustIncludeFacts.map((x) => <li key={x}>{x}</li>)}</ul>
            ) : (
              <p className="muted">
                등록된 사실이 없습니다 — <Link to="/brand-facts">브랜드 사실</Link>을 채우면 여기 들어옵니다.
              </p>
            )}
          </section>
          {b.doNotClaim.length > 0 && (
            <section>
              <h4>확인 필요한 사실 <span className="muted">(팩트 그래프에 없음)</span></h4>
              <ul>{b.doNotClaim.map((x) => <li key={x}>{x}</li>)}</ul>
            </section>
          )}
          {b.structure.length > 0 && (
            <section>
              <h4>구조</h4>
              <ol>
                {b.structure.map((s) => (
                  <li key={s.heading}>
                    <b>{s.heading}</b> <span className="muted">({s.format})</span> — {s.answers}
                  </li>
                ))}
              </ol>
            </section>
          )}
          {b.citableSentences.length > 0 && (
            <section>
              <h4>인용용 문장</h4>
              <ul>{b.citableSentences.map((x) => <li key={x}>{x}</li>)}</ul>
            </section>
          )}
          {b.guardNotes && b.guardNotes.length > 0 && (
            <section>
              <h4>
                검증에서 뺀 것 <span className="muted">(사실을 요약·격상했거나 출처 없는 수치)</span>
              </h4>
              <ul className="muted">{b.guardNotes.map((x) => <li key={x}>{x}</li>)}</ul>
            </section>
          )}
          {b.channelNotes.length > 0 && (
            <section>
              <h4>채널 메모</h4>
              <ul>{b.channelNotes.map((x) => <li key={x}>{x}</li>)}</ul>
            </section>
          )}
          <p className="gap-tally">본문은 쓰지 않습니다. 이 뼈대로 사람이 쓴 글이 인용됩니다 — 사실은 팩트 그래프 밖으로 나가지 않게.</p>
        </div>
      )}
    </div>
  )
}

/** 초안을 마크다운으로. 빈 자리는 표시를 남긴 채 내보낸다 — 지우면 채울 곳을 잃는다. */
function draftToMarkdown(d: StoredDraft['draft']): string {
  const L: string[] = [`# ${d.title}`, '']
  if (d.lead) L.push(d.lead, '')
  for (const sec of d.sections) {
    L.push(`## ${sec.heading}`)
    for (const b of sec.blocks) {
      L.push(b.kind === 'gap' ? `> **채워야 함:** ${b.need ?? ''}` : (b.body ?? ''))
      L.push('')
    }
  }
  if (d.usedFacts.length) L.push('---', '', '**이 글이 쓴 사실**', ...d.usedFacts.map((f) => `- ${f}`), '')
  return L.join('\n')
}

/**
 * 초안 패널 — 브리프에서 한 걸음.
 *
 * 본문을 통째로 만들지 않는다. 사실이 있어야 쓸 수 있는 자리인데 그 사실이 없으면 문장을
 * 짓지 않고 비운 채 "무엇이 필요한가"를 적어 온다. 그 빈 자리를 눈에 띄게 보여주는 것이
 * 이 화면의 일이다 — 사람이 채울 곳이 어디인지가 결과물의 핵심이다.
 */
function DraftPanel({
  tenantId,
  action,
  hasBrief,
  stored,
  onStored,
}: {
  tenantId: string
  action: GapAction
  hasBrief: boolean
  stored: StoredDraft | undefined
  onStored: (s: StoredDraft) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const make = async (force: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const s = await generateContentDraft(tenantId, { actionId: action.id, targetDomain: action.targetDomain }, force)
      onStored(s)
      setOpen(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const copy = async () => {
    if (!stored) return
    try {
      await navigator.clipboard.writeText(draftToMarkdown(stored.draft))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('클립보드에 복사하지 못했습니다.')
    }
  }
  // 브리프가 없으면 버튼을 내주지 않는다 — 서버도 409로 막지만, 누를 수 없는 편이 낫다.
  if (!hasBrief && !stored) return null
  const d = stored?.draft
  return (
    <div className="brief">
      <div className="brief-bar">
        {!stored ? (
          <button type="button" className="ghost" onClick={() => void make(false)} disabled={busy}>
            {busy ? '초안 쓰는 중…' : '초안 만들기 (판정 1회)'}
          </button>
        ) : (
          <>
            <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              {open ? '초안 접기' : '초안 보기'}
            </button>
            <button type="button" className="ghost" onClick={() => void copy()}>
              {copied ? '복사됨' : '마크다운 복사'}
            </button>
            <button type="button" className="ghost" onClick={() => void make(true)} disabled={busy}>
              {busy ? '다시 쓰는 중…' : '다시 만들기'}
            </button>
            {d && d.gapCount > 0 && <span className="st st-warn">채울 곳 {d.gapCount}</span>}
            <span className="doc-meta">{stored.generatedAt.slice(0, 10)} 생성</span>
          </>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {open && d && (
        <div className="brief-body">
          <p className="hint" style={{ marginTop: 0 }}>
            발행용 원고가 아니라 <b>사람이 이어받을 원고</b>입니다. 사실이 없어 쓸 수 없던 자리는 문장을
            지어내지 않고 비워 두었습니다.{' '}
            {d.gapCount > 0 ? `${d.gapCount}곳을 채우면 완성됩니다.` : '비운 자리는 없습니다.'}
          </p>
          <section>
            <h4>{d.title}</h4>
            {d.lead && <p>{d.lead}</p>}
          </section>
          {d.sections.map((sec) => (
            <section key={sec.heading}>
              <h4>{sec.heading}</h4>
              {sec.answers && <p className="doc-meta">답하는 질문 · {sec.answers}</p>}
              {sec.blocks.map((b, i) =>
                b.kind === 'gap' ? (
                  <p key={i} className="error" style={{ margin: '6px 0' }}>
                    채워야 함 · {b.need}
                  </p>
                ) : (
                  <p key={i}>{b.body}</p>
                ),
              )}
            </section>
          ))}
          {d.usedFacts.length > 0 && (
            <section>
              <h4>이 글이 쓴 사실</h4>
              <ul>
                {d.usedFacts.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </section>
          )}
          {d.guardNotes && d.guardNotes.length > 0 && (
            <section>
              <h4>검증이 걸러낸 것</h4>
              <ul>
                {d.guardNotes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  )
}

/** 항목 하나. 근거와 완료 조건을 항상 함께 보여준다 — 지시만 있고 근거가 없으면 안 하게 된다. */
function ActionCard({
  action,
  canSaveStatus,
  onStatus,
  tenantId,
  briefs,
  onBrief,
  drafts,
  onDraft,
}: {
  action: GapAction
  canSaveStatus: boolean
  onStatus: (id: string, status: ActionStatus) => void
  tenantId: string
  /** null이면 이 환경(웹)에 브리프 라우트가 없다 — 버튼을 숨긴다. */
  briefs: Record<string, StoredBrief> | null
  onBrief: (s: StoredBrief) => void
  /** null이면 이 환경(웹)에 초안 라우트가 없다. */
  drafts: Record<string, StoredDraft> | null
  onDraft: (s: StoredDraft) => void
}) {
  // 집행했다고 적었는데 데이터가 아직 확인하지 못한 상태 — 가장 먼저 봐야 할 줄이다.
  const awaiting = action.status === 'done' && !action.satisfied
  return (
    <article className="gap-card">
      <div className="gap-card-head">
        <span className="gap-name">{action.title}</span>
        <span className={`status-pill ${action.satisfied ? 'st-good' : KIND_CLASS[action.kind]}`}>
          {action.satisfied ? '충족' : action.badge}
        </span>
        <span className="gap-rate">
          영향 <b>{action.reach}</b>
        </span>
      </div>
      <p className="gap-tally" style={{ color: 'var(--ink)' }}>
        {action.evidence}
      </p>
      {action.questionTexts.length > 0 && (
        <ul className="gap-worst">
          {action.questionTexts.map((q) => (
            <li key={q}>
              <span className="gap-q">{q}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="gap-tally">완료 조건 · {action.doneSignal}</p>
      {awaiting && (
        // 종류마다 확인 방법이 다르다. 등재형은 인용 데이터가 자동으로 충족을 켜지만,
        // 콘텐츠형은 자동 충족이 없다 — 우리 사이트 글은 인용 갭이 아니라 '패가 줄어드는 것'으로
        // 나타난다. 같은 문구를 쓰면 콘텐츠 카드가 "인용에서 못 찾았다·등재 방식을 보라"는
        // 해당 없는 말을 하게 된다(실제로 그렇게 떴다).
        <p className="gap-tally" style={{ color: 'var(--accent)' }}>
          {action.progress ? (
            <>
              집행했다고 표시했습니다{action.markedWeek && ` (${action.markedWeek})`}. 이 플랫폼은 실렸다/아니다가
              아니라 <b>지분</b>입니다 — 지금 인용 {action.progress.total}회 중 {action.progress.supporting}회가 우리를
              뒷받침합니다. 다음 측정에서 이 비율이 오르는지 보세요.
            </>
          ) : action.kind === 'listing' ? (
            <>
              집행했다고 표시했지만 아직 인용에서 우리를 못 찾았습니다
              {action.markedWeek && ` (${action.markedWeek}에 표시)`}. AI가 새 페이지를 읽어 들이는 데
              보통 몇 주가 걸립니다. 다음 측정에서도 그대로면 등재된 페이지에 브랜드명이 실제로 있는지,
              크롤러가 읽을 수 있는 정적 페이지인지 확인하세요.
            </>
          ) : (
            <>
              집행했다고 표시했습니다{action.markedWeek && ` (${action.markedWeek})`}. 콘텐츠는 인용이
              아니라 <b>이 질문들의 패 판정이 줄어드는 것</b>으로 확인됩니다 — 다음 측정을 보세요.
              자동으로 충족되지 않으므로, 효과가 보이면 직접 판단해 상태를 정리하세요.
            </>
          )}
        </p>
      )}
      {canSaveStatus && (
        <div className="action-status" role="group" aria-label={`${action.title} 집행 상태`}>
          {STATUS_CHOICES.map((c) => (
            <button
              key={c.value}
              type="button"
              title={c.title}
              className={action.status === c.value ? 'on' : undefined}
              aria-pressed={action.status === c.value}
              onClick={() => onStatus(action.id, c.value)}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
      {briefs !== null && !action.satisfied && (
        <BriefPanel tenantId={tenantId} action={action} stored={briefs[action.id]} onStored={onBrief} />
      )}
      {briefs !== null && drafts !== null && !action.satisfied && (
        <DraftPanel
          tenantId={tenantId}
          action={action}
          hasBrief={Boolean(briefs[action.id])}
          stored={drafts[action.id]}
          onStored={onDraft}
        />
      )}
    </article>
  )
}

export default function GapActions() {
  const { tenant } = useTenant()
  const { plan, weeks, weekOf, setWeekOf, loading, neverMeasured, canSaveStatus, setStatus, saveError } =
    useGapActionPlan(tenant?.tenantId ?? '')
  // 저장된 브리프 — 라우트가 없는 환경(웹)이면 null로 남아 카드가 버튼을 숨긴다.
  const [briefs, setBriefs] = useState<Record<string, StoredBrief> | null>(null)
  useEffect(() => {
    if (!tenant?.tenantId) return
    let alive = true
    setBriefs(null)
    void loadContentBriefs(tenant.tenantId).then((m) => {
      if (alive) setBriefs(m)
    })
    return () => {
      alive = false
    }
  }, [tenant?.tenantId])
  const onBrief = (s: StoredBrief) => setBriefs((m) => ({ ...(m ?? {}), [s.actionId]: s }))
  // 저장된 초안 — 브리프와 같은 방식. 라우트가 없는 환경(웹)이면 null로 남아 패널이 숨는다.
  const [drafts, setDrafts] = useState<Record<string, StoredDraft> | null>(null)
  useEffect(() => {
    if (!tenant?.tenantId) return
    let alive = true
    setDrafts(null)
    void loadContentDrafts(tenant.tenantId).then((m) => {
      if (alive) setDrafts(m)
    })
    return () => {
      alive = false
    }
  }, [tenant?.tenantId])
  const onDraft = (s: StoredDraft) => setDrafts((m) => ({ ...(m ?? {}), [s.actionId]: s }))

  const open = plan.actions.filter(isOpenAction)
  const satisfied = plan.actions.filter((a) => a.satisfied && a.status !== 'skip')
  const skipped = plan.actions.filter((a) => a.status === 'skip')
  const ready = !loading && plan.actions.length > 0

  if (!tenant) return null

  return (
    <>
      <p className="brand">그래서 뭘 하나</p>
      <h1>실행 항목</h1>
      <p className="lead">
        <Link to="/gap-analysis">가시성 격차 분석</Link>이 "어디가 비어 있나"를 말한다면, 여기는{' '}
        <b>그래서 뭘 하나</b>입니다. 저장된 측정만으로 계산하며 새 API 호출은 없습니다.
      </p>

      <div className="filters">
        <WeekPicker weeks={weeks} value={weekOf} onChange={setWeekOf} />
      </div>

      {saveError && (
        <p className="error" role="alert">
          {saveError}
        </p>
      )}

      {loading && <p className="muted">불러오는 중…</p>}

      {!loading && plan.actions.length === 0 && (
        <p className="muted">
          {neverMeasured
            ? '이 브랜드는 아직 측정된 적이 없습니다. '
            : '이 주차에 분석 데이터가 없습니다. '}
          <Link to="/measure-tenant">브랜드·경쟁사 측정</Link>에서 측정하면 항목이 채워집니다.
        </p>
      )}

      {ready && (
        <>
          <section className="hero-card">
            <p className="eyebrow">이번 주차</p>
            <ul className="gap-summary">
              <li>
                남은 항목 <b>{open.length}건</b>
                {satisfied.length > 0 && <> · 데이터가 충족을 확인한 항목 {satisfied.length}건</>}
                {plan.skippedCount > 0 && <> · 보류 {plan.skippedCount}건</>}
              </li>
              {plan.awaitingCount > 0 && (
                <li>
                  <b>집행 확인 대기 {plan.awaitingCount}건</b> — 했다고 표시했지만 데이터가 아직 확인하지
                  못한 항목입니다(등재형은 인용, 콘텐츠형은 패 판정으로 확인). 맨 위에 모아 뒀습니다.
                </li>
              )}
              <li className="muted">
                완료는 사람이 체크하지 않고 <b>데이터에서 읽습니다.</b> 등재가 실제로 되면 그 도메인의
                인용이 우리 언급을 뒷받침하기 시작하고, 그때 자동으로 충족으로 넘어갑니다.
              </li>
            </ul>
          </section>

          <section>
            <h3>할 일</h3>
            <p className="hint" style={{ marginTop: 0 }}>
              영향 숫자는 등재형이면 그 도메인의 인용 수, 콘텐츠형이면 밀린 질문 수입니다. 큰 것부터
              하시면 됩니다.
            </p>
            {open.length === 0 ? (
              <p className="muted">남은 항목이 없습니다.</p>
            ) : (
              <div className="gap-grid">
                {open.map((a) => (
                  <ActionCard key={a.id} action={a} canSaveStatus={canSaveStatus} onStatus={setStatus} tenantId={tenant.tenantId} briefs={briefs} onBrief={onBrief} drafts={drafts} onDraft={onDraft} />
                ))}
              </div>
            )}
          </section>

          {satisfied.length > 0 && (
            <section>
              <h3>이미 되어 있는 것</h3>
              <p className="hint" style={{ marginTop: 0 }}>
                이 출처들은 이미 우리 언급을 뒷받침합니다. 새로 할 일은 없지만, 다음 주차에 사라지면
                여기서 먼저 보입니다.
              </p>
              <div className="gap-grid">
                {satisfied.map((a) => (
                  <ActionCard key={a.id} action={a} canSaveStatus={canSaveStatus} onStatus={setStatus} tenantId={tenant.tenantId} briefs={briefs} onBrief={onBrief} drafts={drafts} onDraft={onDraft} />
                ))}
              </div>
            </section>
          )}

          {skipped.length > 0 && (
            <section>
              <h3>보류</h3>
              <p className="hint" style={{ marginTop: 0 }}>
                하지 않기로 한 항목입니다. 지운 게 아니라 내려 둔 것이라, 생각이 바뀌면 여기서 되돌릴
                수 있습니다.
              </p>
              <div className="gap-grid">
                {skipped.map((a) => (
                  <ActionCard key={a.id} action={a} canSaveStatus={canSaveStatus} onStatus={setStatus} tenantId={tenant.tenantId} briefs={briefs} onBrief={onBrief} drafts={drafts} onDraft={onDraft} />
                ))}
              </div>
            </section>
          )}

          <section>
            <h3>목록에서 뺀 것</h3>
            <p className="hint" style={{ marginTop: 0 }}>
              인용된 도메인이라고 다 등재 대상은 아닙니다. 왜 빠졌는지 밝혀 둡니다 — 목록이 짧은 것이
              데이터가 없어서가 아니라는 뜻입니다.
            </p>
            <ul className="gap-summary">
              <li>
                경쟁사 소유 <b>{plan.competitorDomainCount}개</b> — 경쟁사 사이트에는 우리가 실릴 수
                없습니다.
              </li>
              <li>
                분류가 <code>other</code>라 보류 <b>{plan.excludedLowConfidence}개</b> — 알려진 호스트
                목록에 없는 도메인입니다. 대부분 같은 업종의 다른 업체 홈페이지라 등재할 수 없습니다.
                블로그는 <b>발행 가능한 플랫폼</b>(네이버 블로그·티스토리·브런치 등)만 남기고, 남의 회사 자체
                블로그는 뺐습니다 — 거기엔 글을 올릴 수 없습니다.
              </li>
              <li className="muted">
                공공기관(<code>.go.kr</code>) 출처도 뺐습니다. 분류는 정확하지만 보건복지부나 PubMed에
                병원이 등재할 방법은 없습니다 — AI가 공공 지침을 참고한다는 사실은{' '}
                <Link to="/citation-gap">인용 갭 분석</Link>에서 보세요.
              </li>
            </ul>
          </section>
        </>
      )}
    </>
  )
}
