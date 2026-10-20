import { Link, useLocation, useSearchParams } from 'react-router-dom'
import WeekPicker from '../components/WeekPicker'
import { useTenant } from '../context/useTenant'
import { useEffect, useState } from 'react'
import {
  generateContentBrief,
  generateContentDraft,
  loadChannelAdaptations,
  loadContentBriefs,
  loadContentDrafts,
  loadPublishSettings,
  PHOTO_RIGHTS_EVENT,
  type ActionStatus,
  type ChannelAdaptation,
  type ChannelAdaptationMap,
  type PhotoRightsChange,
  type StoredBrief,
  type StoredDraft,
} from '../lib/api'
import DraftPanel from '../components/DraftPanel'
import PublishList from '../components/PublishList'
import PublishedUrlEditor from '../components/PublishedUrlEditor'
import PublishSettingsPanel from '../components/PublishSettingsPanel'
import type { PublishSettings } from '../lib/publishSettings'
import { draftRequestOf, effectiveDraft } from '../lib/draftGaps'
import { draftTitle } from '../lib/markdownFile'
import { isOpenAction, type GapAction } from '../lib/gapActions'
import { buildPublishPlan } from '../lib/publishPlan'
import { useGapActionPlan } from '../lib/useGapActionPlan'

/** 집행 원장을 읽고 고치는 손잡이(useGapActionPlan의 posts). */
type PlanPosts = ReturnType<typeof useGapActionPlan>['posts']

// 배지 문구는 항목이 정한다(출처마다 하는 일이 다르다). 화면은 색만 정한다.
const KIND_CLASS: Record<GapAction['kind'], string> = { listing: 'st-warn', content: 'st-info' }

/** 카드에 보여 줄 질문 줄 수. **표시용이다** — 브리프·초안에는 항상 전부 넘어간다. */
const PREVIEW_QUESTIONS = 5

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



/**
 * 콘텐츠 브리프 패널. 글을 써 주지 않는다 — 무엇에 답하고, 어떤 사실만 쓰고, 어떤 구조가
 * 인용되기 쉬운지까지다. 사실은 팩트 그래프에서만 오고, 없는 것은 "확인 필요"로 남는다.
 * 한 번 만든 브리프는 저장되어 다음 주에도 그대로 열린다(판정 호출은 처음 한 번).
 * 복사 · 내려받기 버튼은 두지 않는다 — 펼친 브리프는 제목 · 목록으로 그려져 골라 복사하면 서식이 함께 간다.
 */
function BriefPanel({
  tenantId,
  action,
  stored,
  onStored,
  initiallyOpen = false,
}: {
  tenantId: string
  action: GapAction
  stored: StoredBrief | undefined
  onStored: (s: StoredBrief) => void
  /** 「글 설계 보기」를 펼쳤을 때는 본문까지 바로 연다 — 접힌 것을 한 번 더 펼치게 하지 않는다. */
  initiallyOpen?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(initiallyOpen)
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
  const b = stored?.brief
  return (
    <div className="brief">
      <div className="brief-bar">
        {!stored ? (
          <button type="button" onClick={() => void make(false)} disabled={busy} title="판정 1~2회">
            {busy ? '브리프 만드는 중… 보통 30초' : '브리프 만들기 · 약 30초'}
          </button>
        ) : (
          <>
            <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              {open ? '브리프 접기' : '브리프 보기'}
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



/** 한 편에 걸리는 대략의 시간(분) — 브리프(있으면 생략) + 초안, 각각 사실 대조 포함. 화면 안내용 어림이다. */
const MINUTES_PER_DRAFT = 1.5

/**
 * 쓸 글의 초안을 한 번에 만든다 — 브리프가 없으면 브리프부터.
 *
 * 예전에는 「브리프 없는 N건 한꺼번에 만들기」였다. 두 가지가 어긋났다: 브리프만 만들어서 결국 카드마다
 * 초안 단추를 또 눌러야 했고, 위의 글이 이미 덮는 채널 카드(「새로 쓸 글이 아닙니다」)까지 브리프를 만들어
 * 판정 호출을 버렸다. 이제 **쓸 글만**(콘텐츠 항목 + 덮는 글이 없는 채널) 골라 초안까지 간다.
 *
 * 순차로 돈다. 판정 엔진에 한꺼번에 던지면 처리량 천장에 걸려 오히려 느려지고, 무엇이 어디까지 됐는지도
 * 알 수 없다. 한 편 끝날 때마다 저장되므로 도중에 화면을 떠나도 그때까지 만든 것은 남는다.
 *
 * 실패는 삼키지 않는다 — 몇 편이 왜 실패했는지 끝에 그대로 보여 준다.
 */
function BulkDrafts({
  tenantId,
  actions,
  briefs,
  drafts,
  onBrief,
  onDraft,
}: {
  tenantId: string
  actions: GapAction[]
  briefs: Record<string, StoredBrief>
  drafts: Record<string, StoredDraft>
  onBrief: (s: StoredBrief) => void
  onDraft: (s: StoredDraft) => void
}) {
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const todo = actions.filter((a) => !drafts[a.id])
  if (todo.length === 0 && !result) return null
  const run = async () => {
    setBusy(true)
    setResult(null)
    const failed: string[] = []
    let ok = 0
    for (const [i, a] of todo.entries()) {
      setProgress(`${i + 1}/${todo.length} · ${a.title}`)
      try {
        if (!briefs[a.id]) {
          onBrief(
            await generateContentBrief(tenantId, {
              actionId: a.id,
              kind: a.kind,
              title: a.title,
              targetDomain: a.targetDomain,
              questionTexts: a.questionTexts,
              evidence: a.evidence,
            }),
          )
        }
        onDraft(await generateContentDraft(tenantId, draftRequestOf(a)))
        ok += 1
      } catch (e) {
        failed.push(`${a.title} — ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    setProgress('')
    setBusy(false)
    setResult(failed.length === 0 ? `초안 ${ok}편을 만들었습니다.` : `${ok}편 성공 · ${failed.length}편 실패\n${failed.join('\n')}`)
  }
  return (
    <div className="brief-bar" style={{ marginBottom: 10 }}>
      {todo.length > 0 && (
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy}
          title="쓸 글마다 브리프(없으면)와 초안을 차례로 만듭니다 — 한 편에 판정 2~4회"
        >
          {busy
            ? `초안 만드는 중… ${progress}`
            : `초안 없는 글 ${todo.length}편 한꺼번에 만들기 · 약 ${Math.max(1, Math.ceil(todo.length * MINUTES_PER_DRAFT))}분`}
        </button>
      )}
      {busy && <span className="doc-meta">한 편씩 저장되므로 화면을 떠나도 끝난 글은 남습니다.</span>}
      {result && (
        <span className={result.includes('실패') ? 'error' : 'doc-meta'} style={{ whiteSpace: 'pre-line' }}>
          {result}
        </span>
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
  posts,
  coveredBy,
  focused = false,
  weekOf,
}: {
  action: GapAction
  /** 이 항목을 만든 측정 주차 — 초안의 「실측 답변」이 그 주의 기록에서 고른다. */
  weekOf?: string
  canSaveStatus: boolean
  /** 인용 갭 분석에서 「콘텐츠 생성으로」를 눌러 넘어온 카드 — 스크롤 목적지이자 강조 대상. */
  focused?: boolean
  onStatus: (id: string, status: ActionStatus) => void
  tenantId: string
  /** null이면 이 환경(웹)에 브리프 라우트가 없다 — 버튼을 숨긴다. */
  briefs: Record<string, StoredBrief> | null
  onBrief: (s: StoredBrief) => void
  /** null이면 이 환경(웹)에 초안 라우트가 없다. */
  drafts: Record<string, StoredDraft> | null
  onDraft: (s: StoredDraft) => void
  /** 집행 원장 — null이면 이 환경(웹)에서는 주소를 적을 수 없다. */
  posts: PlanPosts | null
  /** 등재형일 때, 이 채널의 질문을 이미 덮는 콘텐츠 항목. 콘텐츠형이면 null. */
  coveredBy: { titles: string[]; covered: number; total: number } | null
}) {
  const [channelDraft, setChannelDraft] = useState(false)
  /**
   * 운영자용 손잡이를 펼쳤나. 기본은 접힘.
   *
   * 카드 한 장에 버튼이 15개까지 늘어 "여기서 밀린다 → 이 글을 쓰면 된다 → 초안 여기 있다"
   * 세 걸음이 묻혔다(실측: 화면 전체 버튼 69개·4,299자). 기능을 지우지 않고 접어 둔다.
   */
  const [detail, setDetail] = useState(false)
  // 집행했다고 적었는데 데이터가 아직 확인하지 못한 상태 — 가장 먼저 봐야 할 줄이다.
  const awaiting = action.status === 'done' && !action.satisfied
  // 언제 집행했나 — 올린 날이 적힌 기록이 있으면 그 날(가장 최근), 없으면 상태를 정할 때 보던 주차.
  const lastPosted = (action.publishedHits ?? []).map((h) => h.post.publishedOn).filter((d): d is string => Boolean(d)).sort().at(-1)
  const executedWhen = lastPosted
    ? ` (${Number(lastPosted.slice(5, 7))}/${Number(lastPosted.slice(8, 10))} 올림)`
    : action.markedWeek
      ? ` (${action.markedWeek}에 표시)`
      : ''
  // 초안 패널이 뜨는 카드는 「올린 글 주소」를 아래 「② 올리기 목록」의 줄에서 받는다(두 곳에 두지 않는다).
  const showsDraft = briefs !== null && drafts !== null && !action.satisfied && (!coveredBy || channelDraft)
  // 초안이 생기면 근거 · 질문 목록은 「자세히」로 접는다 — 카드는 글 자체(제목 · 첫 문단 · 빈칸)를 보인다.
  const hasDraft = Boolean(drafts?.[action.id])
  const showWhy = detail || !hasDraft
  return (
    <article className={`gap-card${focused ? ' is-focused' : ''}`} id={`action-${action.id}`}>
      <div className="gap-card-head">
        <span className="gap-name">{action.title}</span>
        <span className={`status-pill ${action.satisfied ? 'st-good' : KIND_CLASS[action.kind]}`}>
          {action.satisfied ? '충족' : action.badge}
        </span>
        <span className="gap-rate">
          AI가 우리를 말하지 않는 질문 <b>{action.reach}</b>개
        </span>
      </div>
      {showWhy && (
        <p className="gap-tally" style={{ color: 'var(--ink)' }}>
          {action.evidence}
        </p>
      )}
      {showWhy && action.questionTexts.length > 0 && (
        <>
          <ul className="gap-worst">
            {action.questionTexts.slice(0, PREVIEW_QUESTIONS).map((q) => (
              <li key={q}>
                <span className="gap-q">{q}</span>
              </li>
            ))}
          </ul>
          {action.questionTexts.length > PREVIEW_QUESTIONS && (
            // 몇 줄만 보인다는 걸 밝힌다. 글은 여기 안 보이는 것까지 답한다 — 예전에는 이 자르기가
            // 브리프에도 그대로 가서 나머지가 조용히 빠졌다.
            <p className="doc-meta" style={{ margin: '2px 0 0' }}>
              많이 밀리는 순으로 {PREVIEW_QUESTIONS}개만 보입니다. 글은 {action.questionTexts.length}개 전부에 답합니다.
            </p>
          )}
        </>
      )}
      {detail && <p className="gap-tally">완료 조건 · {action.doneSignal}</p>}
      {detail && !showsDraft && posts && action.status !== 'todo' && action.status !== 'skip' && (
        <PublishedUrlEditor
          hits={action.publishedHits ?? []}
          removed={posts.list.filter((p) => p.targetActionId === action.id && p.removedAt)}
          weekOf={weekOf ?? ''}
          busy={posts.busy}
          onRecord={(url, publishedOn, chosen) =>
            posts.record({
              url,
              articleId: action.id,
              targetActionId: action.id,
              via: 'direct',
              articleTitle: action.title,
              publishedOn,
              publishedOnChosen: chosen,
              markDone: false,
            })
          }
          onRemove={posts.remove}
          onRestore={posts.restore}
          onSetDate={posts.setPublishedOn}
        />
      )}
      {awaiting && (
        // 종류마다 확인 방법이 다르다. 등재형은 인용 데이터가 자동으로 충족을 켜지만,
        // 콘텐츠형은 자동 충족이 없다 — 우리 사이트 글은 인용 갭이 아니라 '패가 줄어드는 것'으로
        // 나타난다. 같은 문구를 쓰면 콘텐츠 카드가 "인용에서 못 찾았다·등재 방식을 보라"는
        // 해당 없는 말을 하게 된다(실제로 그렇게 떴다).
        <p className="gap-tally" style={{ color: 'var(--accent)' }}>
          {action.progress ? (
            <>
              집행했다고 표시했습니다{executedWhen}. 이 플랫폼은 실렸다/아니다가
              아니라 <b>지분</b>입니다 — 지금 {action.progress.unnamed && '브랜드 이름 없는 질문의 '}인용{' '}
              {action.progress.total}회 중 {action.progress.supporting}회가 우리를
              뒷받침합니다. 다음 측정에서 이 비율이 오르는지 보세요.
            </>
          ) : action.kind === 'listing' && action.support && action.support.all > 0 ? (
            // 「충족」은 브랜드 이름 없는 질문으로 정한다(gapActions.ts). 이름을 댄 질문에서 이미 뒷받침하면 페이지에 브랜드명은
            // 있다 — "못 찾았다 · 브랜드명이 있는지 보라"고 하면 멀쩡한 등재 페이지를 점검하게 만든다.
            <>
              집행했다고 표시했습니다{executedWhen}.{' '}
              {action.support.known
                ? `이름을 댄 질문에서는 이 출처가 우리를 ${action.support.all}회 뒷받침하지만, 브랜드 이름 없는 질문에서는 아직입니다. 그 페이지가 이름을 모르는 사람의 질문(위 질문 목록의 주제 · 지역 · 업종 말)에도 답하는지 보세요.`
                : `이 출처가 우리를 ${action.support.all}회 뒷받침하지만, 질문 은행을 읽지 못해 브랜드 이름 없는 질문에서였는지 확인하지 못했습니다.`}
            </>
          ) : action.kind === 'listing' ? (
            <>
              집행했다고 표시했지만 아직 인용에서 우리를 못 찾았습니다
              {executedWhen}. AI가 새 페이지를 읽어 들이는 데
              보통 몇 주가 걸립니다. 다음 측정에서도 그대로면 등재된 페이지에 브랜드명이 실제로 있는지,
              크롤러가 읽을 수 있는 정적 페이지인지 확인하세요.
            </>
          ) : (
            <>
              집행했다고 표시했습니다{executedWhen}. 콘텐츠는 인용이
              아니라 <b>이 질문들의 패 판정이 줄어드는 것</b>으로 확인됩니다 — 다음 측정을 보세요.
              자동으로 충족되지 않으므로, 효과가 보이면 직접 판단해 상태를 정리하세요.
            </>
          )}
        </p>
      )}
      {detail && canSaveStatus && (
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
      {action.kind === 'listing' && !coveredBy && !action.satisfied && (
        // 덮는 글이 없는 채널은 사실상 「쓸 글」이다. 말해 주지 않으면 다른 등재형 카드와
        // 똑같이 보여서 "위의 글을 여기 올리면 되는 것"으로 읽힌다.
        <p className="gap-dest">
          덮는 글 <b>없음</b>
          <span className="muted"> — 위의 글로는 못 덮습니다. 이 채널용으로 한 편 따로 씁니다.</span>
        </p>
      )}
      {detail && briefs !== null && !action.satisfied && (!coveredBy || channelDraft) && (
        // 브리프는 초안을 쓰기 위한 내부 설계도다 — 사람이 읽을 물건이 아니라서 「자세히」 안에서도 접어 둔다.
        // 초안 만들기가 브리프를 알아서 먼저 만든다(DraftPanel ensureBrief).
        <details className="brief-design">
          <summary>글 설계(브리프) 보기{briefs[action.id] ? '' : ' · 아직 없음'}</summary>
          <BriefPanel tenantId={tenantId} action={action} stored={briefs[action.id]} onStored={onBrief} initiallyOpen />
        </details>
      )}
      {coveredBy && (
        // 등재형은 "새로 쓸 글"이 아니다. 같은 질문을 이미 덮는 글이 위에 있다는 걸 먼저 말한다.
        <div className="brief">
          <p className="hint" style={{ margin: '6px 0 0' }}>
            이 채널이 걸린 질문 {coveredBy.total}개 중 <b>{coveredBy.covered}개</b>를 위의 글이 이미 덮습니다
            — <b>{coveredBy.titles.join(' · ')}</b>. <b>새로 쓸 글이 아닙니다.</b> 그 글을 여기에 올리면 이 항목도
            함께 진척됩니다.
          </p>
          {detail && (
            <button
              type="button"
              className="ghost"
              style={{ marginTop: 6 }}
              onClick={() => setChannelDraft((v) => !v)}
              aria-expanded={channelDraft}
            >
              {channelDraft ? '채널용 초안 접기' : '이 채널 문체로 따로 쓰기'}
            </button>
          )}
        </div>
      )}
      {showsDraft && (
        <DraftPanel
          tenantId={tenantId}
          weekOf={weekOf}
          action={action}
          hasBrief={Boolean(briefs[action.id])}
          stored={drafts[action.id]}
          onStored={onDraft}
          compact={!detail}
          ensureBrief={async () => {
            onBrief(
              await generateContentBrief(tenantId, {
                actionId: action.id,
                kind: action.kind,
                title: action.title,
                targetDomain: action.targetDomain,
                questionTexts: action.questionTexts,
                evidence: action.evidence,
              }),
            )
          }}
        />
      )}
      {/* 접은 것을 되살리는 자리. 기능을 지운 게 아니라는 것이 여기서 보여야 한다. */}
      <button type="button" className="gap-detail-toggle" onClick={() => setDetail((v) => !v)} aria-expanded={detail}>
        {detail ? '자세히 접기' : '자세히 — 상태·브리프·편집'}
      </button>
    </article>
  )
}

/**
 * 어디서 넘어왔는지 — 정기진단 보고서의 개선제안·대시보드의 「이번 주 할 일」이 링크 state로 넘긴다.
 * 경로 표시(「정기진단 보고서 › 01 카테고리 무관 노출 확대 › 콘텐츠 생성」)에만 쓴다. 메뉴로 바로 들어오면 없다.
 */
const ORIGINS = {
  report: { name: '정기진단 보고서', to: '/report' },
  dashboard: { name: '대시보드', to: '/' },
} as const
type OriginState = { from?: keyof typeof ORIGINS; label?: string } | null

export default function GapActions() {
  const { tenant } = useTenant()
  const navState = useLocation().state as OriginState
  const origin = navState?.from && ORIGINS[navState.from] ? { ...ORIGINS[navState.from], label: navState.label ?? '' } : null
  // 인용 갭 분석에서 넘어온 목적지. focus=액션 id, domain=사람이 읽을 이름(항목이 없을 때 안내에 쓴다).
  const [searchParams] = useSearchParams()
  const focusId = searchParams.get('focus') ?? ''
  const focusDomain = searchParams.get('domain') ?? ''
  const [help, setHelp] = useState(false)
  const { plan, weeks, weekOf, setWeekOf, loading, neverMeasured, canSaveStatus, setStatus, saveError, canRecordPosts, posts } =
    useGapActionPlan(tenant?.tenantId ?? '')
  const cardPosts = canRecordPosts ? posts : null
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
  // 채널별 다듬은 글(콘텐츠 생성 2단계). 키가 맞을 때만 쓴다 — 브랜드를 바꾸면 앞 브랜드 것이 잠깐 보이지 않게.
  const [adaptState, setAdaptState] = useState<{ key: string; value: ChannelAdaptationMap | null }>({ key: '', value: null })
  useEffect(() => {
    const id = tenant?.tenantId
    if (!id) return
    let alive = true
    void loadChannelAdaptations(id).then((m) => {
      if (alive) setAdaptState({ key: id, value: m })
    })
    return () => {
      alive = false
    }
  }, [tenant?.tenantId])
  const adaptations = adaptState.key === tenant?.tenantId ? adaptState.value : null
  // 브랜드별 발행 설정(글 끝 상담 안내 · 태그 · 블로그). 키가 맞을 때만 쓴다. 라우트가 없는 환경(웹)이면 null.
  const [settingsState, setSettingsState] = useState<{ key: string; value: PublishSettings | null }>({ key: '', value: null })
  useEffect(() => {
    const id = tenant?.tenantId
    if (!id) return
    let alive = true
    void loadPublishSettings(id).then((s) => {
      if (alive) setSettingsState({ key: id, value: s })
    })
    return () => {
      alive = false
    }
  }, [tenant?.tenantId])
  // 글 확인 칸에서 홈페이지 사진 사용을 확인하면 올리기 목록도 그 확인을 쓴다(낡은 설정이면 고른 사진을 빼고 복사한다).
  useEffect(() => {
    const id = tenant?.tenantId
    if (!id) return
    const onRights = (e: Event) => {
      const change = (e as CustomEvent<PhotoRightsChange>).detail
      if (change.tenantId === id) setSettingsState({ key: id, value: change.settings })
    }
    window.addEventListener(PHOTO_RIGHTS_EVENT, onRights)
    return () => window.removeEventListener(PHOTO_RIGHTS_EVENT, onRights)
  }, [tenant?.tenantId])
  const publishSettings = settingsState.key === tenant?.tenantId ? settingsState.value : null
  const onAdapted = (a: ChannelAdaptation) =>
    setAdaptState((st) => ({
      ...st,
      value: { ...(st.value ?? {}), [a.contentActionId]: { ...(st.value?.[a.contentActionId] ?? {}), [a.channelActionId]: a } },
    }))
  // 목적지 카드가 그려진 뒤 한 번 스크롤한다. 카드가 없으면(인용이 적어 제외·경쟁사) 아래 안내가 대신 뜬다.
  useEffect(() => {
    if (!focusId) return
    const el = document.getElementById(`action-${focusId}`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [focusId, plan])
  const focusMissing = Boolean(focusId) && !loading && plan.actions.every((a) => a.id !== focusId)
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
  // 「쓸 글」과 「올릴 곳」은 같은 질문을 다르게 자른 것이지 서로 다른 일이 아니다(실측: 콘텐츠형 6 + 등재형 9가
  // 같은 질문 26개를 가리킨다). 화면은 둘을 「① 글 확인」과 「② 올리기 목록」으로 편다 — lib/publishPlan.ts.
  const openContent = open.filter((a) => a.kind === 'content')
  const openListing = open.filter((a) => a.kind === 'listing')
  const publishPlan = buildPublishPlan(openContent, openListing, drafts, { blogUrl: publishSettings?.blogUrl })
  /** 이 등재 항목의 질문을 이미 덮는 콘텐츠 항목들 — 초안 라우트가 없는 환경(웹)의 채널 카드가 쓴다. */
  const coverageOf = (a: GapAction) => {
    const qs = new Set(a.questionIds)
    const hit = openContent
      .map((c) => ({ title: c.title, n: c.questionIds.filter((q) => qs.has(q)).length }))
      .filter((c) => c.n > 0)
      .sort((x, y) => y.n - x.n)
    return hit.length ? { titles: hit.map((h) => h.title), covered: hit.reduce((sum, h) => sum + h.n, 0), total: qs.size } : null
  }
  const confirmedCount = publishPlan.articles.filter((x) => x.confirmed).length
  const showArticle = (id: string) => {
    document.getElementById(`action-${id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  const satisfied = plan.actions.filter((a) => a.satisfied && a.status !== 'skip')
  const skipped = plan.actions.filter((a) => a.status === 'skip')
  const ready = !loading && plan.actions.length > 0

  if (!tenant) return null

  return (
    <>
      {origin && (
        <nav className="crumbs" aria-label="경로">
          <Link to={origin.to}>{origin.name}</Link>
          {origin.label && (
            <>
              <span aria-hidden="true">›</span>
              <Link to={origin.to}>{origin.label}</Link>
            </>
          )}
          <span aria-hidden="true">›</span>
          <span aria-current="page">콘텐츠 생성</span>
        </nav>
      )}
      <header className="page-head">
        <div className="page-title">
          <p className="page-eyebrow">실행 · {tenant.brandName}</p>
          <h1>콘텐츠 생성</h1>
        </div>
        <button
          type="button"
          className="help-toggle"
          aria-expanded={help}
          aria-label="이 화면 설명"
          title="이 화면 설명"
          onClick={() => setHelp((v) => !v)}
        >
          ?
        </button>
      </header>
      {help && (
        // 설명은 처음 한 번 읽으면 되는 것이라 「?」 뒤에 둔다 — 화면에는 할 일만 남긴다(상용화 UI 8차 시안).
        <div className="help-panel">
          <p>
            <Link to="/gap-analysis">가시성 격차 분석</Link>이 어디가 비어 있는지 말한다면, 여기는 그 자리를 채울 글을 만들고
            올리는 곳입니다. <b>① 글 확인</b>에서 글의 빈칸을 채우거나 빼면, <b>② 올리기 목록</b>에서 그 글을 올릴 곳이
            열립니다. 목록은 그곳에 올리면 덮이는 질문이 많은 순서입니다.
          </p>
          <p>
            할 일은 저장된 측정으로 계산합니다. AI를 부르는 것은 초안 만들기, 빈칸 값 찾기, 채널용 글 만들기뿐입니다.
            완료는 사람이 체크하지 않고 <b>데이터에서 읽습니다</b> — 브랜드 이름 없는 질문에서 올린 곳의 인용이 우리 언급을
            뒷받침하기 시작하면 자동으로 충족으로 넘어갑니다.
          </p>
          <p className="muted">
            글(콘텐츠형)과 올릴 곳(등재형)은 경쟁하는 일이 아닙니다. 글이 <b>무엇을 쓸지</b>, 올릴 곳이 <b>어디에 올릴지</b>라서,
            한 편을 써서 그곳에 올리면 둘 다 진척됩니다.
          </p>
        </div>
      )}

      <div className="filters">
        <WeekPicker weeks={weeks} value={weekOf} onChange={setWeekOf} />
      </div>

      {saveError && (
        <p className="error" role="alert">
          {saveError}
        </p>
      )}
      {/* 집행 원장을 읽거나 고치지 못했다 — 숨기면 올린 주소가 0개로 보여도 왜인지 모른다. 새 주소 기록 실패는 그 칸에만 뜬다. */}
      {canRecordPosts && posts.error && (
        <p className="error" role="alert">
          올린 글 기록: {posts.error}
        </p>
      )}

      {loading && <p className="muted">불러오는 중…</p>}

      {focusMissing && (
        <p className="muted" role="status">
          인용 갭 분석에서 넘어온 「{focusDomain || focusId}」에 대한 실행 항목이 이 주차에는 없습니다 — 인용이 적어 제외됐거나
          등재할 수 없는 출처(경쟁사·자사)입니다. <Link to="/citation-gap">인용 갭 분석으로 돌아가기</Link>
        </p>
      )}

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
          {open.length === 0 ? (
            <p className="muted">남은 항목이 없습니다.</p>
          ) : (
            <>
              {publishPlan.rows.length > 0 && drafts !== null && (
                <section className="publish-progress" aria-label="이번 주 올리기 진행">
                  <div className="publish-progress-row">
                    <span>
                      이번 주 올리기 <b>{publishPlan.done}</b> / {publishPlan.rows.length}곳
                    </span>
                    <span className="muted">
                      올린 글이 덮는 질문 <b>{publishPlan.coveredQuestions}</b> / {publishPlan.totalQuestions}개
                    </span>
                  </div>
                  <div
                    className="publish-progress-bar"
                    role="progressbar"
                    aria-label="올린 곳"
                    aria-valuemin={0}
                    aria-valuemax={publishPlan.rows.length}
                    aria-valuenow={publishPlan.done}
                  >
                    <span style={{ width: `${(publishPlan.done / publishPlan.rows.length) * 100}%` }} />
                  </div>
                  {plan.awaitingCount > 0 && (
                    <p className="publish-progress-note">
                      올렸다고 표시했지만 데이터가 아직 확인하지 못한 곳 <b>{plan.awaitingCount}곳</b> — 다음 측정에서 확인합니다.
                    </p>
                  )}
                </section>
              )}

              <section>
                <h3 className="step-head">
                  ① 글 확인{' '}
                  <span className="muted">
                    {publishPlan.articles.length}편 중 {confirmedCount}편 확인됨
                  </span>
                </h3>
                <p className="hint" style={{ marginTop: 0 }}>
                  빈칸을 채우거나 빼면 그 글이 확인되고, 아래 올리기 목록에서 그 글의 줄이 열립니다.
                </p>
                {briefs !== null && drafts !== null && (
                  <BulkDrafts
                    tenantId={tenant.tenantId}
                    actions={publishPlan.articles.map((x) => x.action)}
                    briefs={briefs}
                    drafts={drafts}
                    onBrief={onBrief}
                    onDraft={onDraft}
                  />
                )}
                <div className="gap-grid">
                  {publishPlan.articles.map(({ action: a }) => (
                    <ActionCard key={a.id} action={a} focused={focusId === a.id} canSaveStatus={canSaveStatus} onStatus={setStatus} tenantId={tenant.tenantId} briefs={briefs} onBrief={onBrief} drafts={drafts} onDraft={onDraft} posts={cardPosts} weekOf={weekOf} coveredBy={null} />
                  ))}
                </div>
              </section>

              <section>
                <h3 className="step-head">
                  ② 올리기 목록 <span className="muted">— 한 줄이 한 번 올리기입니다. 덮는 질문이 많은 곳부터.</span>
                </h3>
                {drafts !== null && publishSettings !== null && (
                  <PublishSettingsPanel
                    key={tenant.tenantId}
                    tenantId={tenant.tenantId}
                    brand={tenant}
                    settings={publishSettings}
                    onSaved={(s) => setSettingsState({ key: tenant.tenantId, value: s })}
                  />
                )}
                {drafts !== null ? (
                  <PublishList
                    tenantId={tenant.tenantId}
                    plan={publishPlan}
                    settings={publishSettings}
                    adaptations={adaptations}
                    onAdapted={onAdapted}
                    focusId={focusId}
                    onShowArticle={showArticle}
                    urlSlot={(row) =>
                      canRecordPosts ? (
                        <PublishedUrlEditor
                          addLabel="올렸어요"
                          hits={row.target.publishedHits ?? []}
                          removed={posts.list.filter((p) => p.targetActionId === row.target.id && p.removedAt)}
                          weekOf={weekOf}
                          busy={posts.busy}
                          // 올린 글 · 올린 곳 · 초안 판을 함께 남긴다 — 채널 항목 하나를 여러 글이 함께 쓰고, 초안은 다시 만들면 덮인다.
                          onRecord={(url, publishedOn, chosen) =>
                            posts.record({
                              url,
                              articleId: row.article.action.id,
                              targetActionId: row.target.id,
                              via: row.kind,
                              articleTitle: row.article.draft ? draftTitle(effectiveDraft(row.article.draft)) : row.article.action.title,
                              ...(row.article.draft ? { draftGeneratedAt: row.article.draft.generatedAt } : {}),
                              ...(adaptations?.[row.article.action.id]?.[row.target.id]
                                ? { adaptationSourceKey: adaptations[row.article.action.id]![row.target.id]!.sourceKey }
                                : {}),
                              publishedOn,
                              publishedOnChosen: chosen,
                              markDone: true,
                            })
                          }
                          onRemove={posts.remove}
                          onRestore={posts.restore}
                          onSetDate={posts.setPublishedOn}
                        />
                      ) : null
                    }
                  />
                ) : (
                  // 초안 라우트가 없는 환경(웹) — 올릴 글이 없으니 채널 카드로 근거 · 상태만 보인다.
                  <div className="gap-grid">
                    {openListing.map((a) => (
                      <ActionCard key={a.id} action={a} focused={focusId === a.id} canSaveStatus={canSaveStatus} onStatus={setStatus} tenantId={tenant.tenantId} briefs={briefs} onBrief={onBrief} drafts={drafts} onDraft={onDraft} posts={cardPosts} weekOf={weekOf} coveredBy={coverageOf(a)} />
                    ))}
                  </div>
                )}
              </section>
            </>
          )}

          {satisfied.length > 0 && (
            <section>
              <details className="gap-more">
              <summary>이미 되어 있는 것 {satisfied.length}건</summary>
              <p className="hint" style={{ marginTop: 0 }}>
                이 출처들은 이미 우리 언급을 뒷받침합니다. 새로 할 일은 없지만, 다음 주차에 사라지면
                여기서 먼저 보입니다.
              </p>
              <div className="gap-grid">
                {satisfied.map((a) => (
                  <ActionCard key={a.id} action={a} focused={focusId === a.id} canSaveStatus={canSaveStatus} onStatus={setStatus} tenantId={tenant.tenantId} briefs={briefs} onBrief={onBrief} drafts={drafts} onDraft={onDraft} posts={cardPosts} weekOf={weekOf} coveredBy={null} />
                ))}
              </div>
              </details>
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
                  <ActionCard key={a.id} action={a} focused={focusId === a.id} canSaveStatus={canSaveStatus} onStatus={setStatus} tenantId={tenant.tenantId} briefs={briefs} onBrief={onBrief} drafts={drafts} onDraft={onDraft} posts={cardPosts} weekOf={weekOf} coveredBy={null} />
                ))}
              </div>
            </section>
          )}

          <section>
            <details className="gap-more">
            <summary>목록에서 뺀 것</summary>
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
            </details>
          </section>
        </>
      )}
    </>
  )
}
