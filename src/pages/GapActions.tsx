import { Link, useLocation, useSearchParams } from 'react-router-dom'
import WeekPicker from '../components/WeekPicker'
import { useTenant } from '../context/useTenant'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  generateContentBrief,
  generateContentDraft,
  loadChannelAdaptations,
  loadContentBriefs,
  loadContentDrafts,
  loadFactGraph,
  loadPublishSettings,
  PHOTO_RIGHTS_EVENT,
  type ActionStatus,
  type ChannelAdaptation,
  type ChannelAdaptationMap,
  type FactNode,
  type PhotoRightsChange,
  type StoredBrief,
  type StoredDraft,
  type TenantSummary,
} from '../lib/api'
import DraftPanel from '../components/DraftPanel'
import ExtraArticleForm from '../components/ExtraArticleForm'
import PhotoAutoFill from '../components/PhotoAutoFill'
import PublishList from '../components/PublishList'
import PublishedUrlEditor from '../components/PublishedUrlEditor'
import PublishSettingsPanel from '../components/PublishSettingsPanel'
import type { PublishSettings } from '../lib/publishSettings'
import { bulkRunsAfter, passForTenant, type BulkKind, type BulkRuns } from '../lib/bulkRun'
import { briefInputOf, draftRequestOf, effectiveDraft, publishMarkdownOf } from '../lib/draftGaps'
import { aliveExtraArticles, isExtraArticleId, questionTextKey, type ExtraArticle } from '../lib/extraArticles'
import { draftTitle } from '../lib/markdownFile'
import {
  channelNameOf,
  extraFormSlot,
  extraStandingOf,
  extraTakenFromMain,
  isIdleAction,
  isOpenAction,
  probeQuestionList,
  probeSectionHint,
  probeTakenNote,
  type GapAction,
} from '../lib/gapActions'
import { useMeasureStatus } from '../lib/measureStatus'
import { photoSlotStats } from '../lib/photoAutoPick'
import {
  extraArticleCap,
  planWriters,
  topicGuard,
  writerArticle,
  writerChip,
  writerRunCapReason,
  type WriterPlan,
  type WriterPlanArticle,
} from '../lib/probePlan'
import { todayKst } from '../lib/publishedUrl'
import { buildPublishPlan, recordInputOf, type PublishArticle } from '../lib/publishPlan'
import { VERDICT_WORD } from '../lib/questionWinLoss'
import { useGapActionPlan } from '../lib/useGapActionPlan'
import { useProbePlan } from '../lib/useProbePlan'
import { usePublishedHistory } from '../lib/usePublishedHistory'
import { citedPostIdsInWeek, weekFileTimingOf } from '../lib/publishTracking'
import { canSaveToFolder, saveWriterBundle, writerBundle } from '../lib/writerBundle'

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
  mainDraft,
  initiallyOpen = false,
}: {
  tenantId: string
  action: GapAction
  stored: StoredBrief | undefined
  onStored: (s: StoredBrief) => void
  /** 본 글의 저장된 초안 — 추가 글의 브리프가 그 제목 · 소제목과 겹치지 않게 한다(briefInputOf). */
  mainDraft: StoredDraft | undefined
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
      const s = await generateContentBrief(tenantId, briefInputOf(action, mainDraft), force)
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

/** 작성자 실행이 만든 글의 카드를 기다리는 시간 — 추가 글 목록을 받고 항목을 다시 계산하는 데는 보통 1초도 안 걸린다. */
const CARD_WAIT_MS = 15_000

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
 *
 * 작성자 단추(onlyIds — WriterRuns)는 같은 흐름을 그 작성자의 배정 글만 돈다: 먼저 없는 배정 글을 만들고(prepare), 그 카드가
 * 나타나기를 기다린 뒤 브리프(없으면) → 초안(없으면). 한 작성자 몫을 빠짐없이 넘기려고 첫 실패에서 멈추고, 다시 누르면 남은 것부터
 * 이어서 한다.
 */
function BulkDrafts({
  tenantId,
  actions,
  briefs,
  drafts,
  mainId,
  onBrief,
  onDraft,
  onlyIds,
  label = '',
  blocked = null,
  prepare,
  briefWarning,
  locked = false,
  onBusyChange,
}: {
  tenantId: string
  actions: GapAction[]
  briefs: Record<string, StoredBrief>
  drafts: Record<string, StoredDraft>
  /** 본 글 항목 id — 추가 글의 브리프가 본 글 초안과 겹치지 않게 한다(briefInputOf). */
  mainId: string | undefined
  onBrief: (s: StoredBrief) => void
  onDraft: (s: StoredDraft) => void
  /** 작성자 한 명의 배정 글 — 이 글들만 이 순서로 돌고 첫 실패에서 멈춘다. 없으면 쓸 글 전부(지금과 같다). */
  onlyIds?: readonly string[]
  /** onlyIds일 때 단추 글자. */
  label?: string
  /** onlyIds일 때 누를 수 없는 이유 — 단추를 끄고 옆에 보인다. */
  blocked?: string | null
  /** onlyIds일 때 브리프 · 초안 전에 할 일(없는 배정 글 만들기). 실패하면 이유 — 거기서 멈춘다. */
  prepare?: (progress: (text: string) => void) => Promise<string | null>
  /** 새 브리프를 받은 뒤 확인할 것(모델 출력) — 경고만 하고 멈추지 않는다. */
  briefWarning?: (a: GapAction, s: StoredBrief) => string | null
  /** 다른 일괄 실행이 도는 중 — 단추를 끈다. */
  locked?: boolean
  /** 돌기 시작 · 끝 — 화면이 다른 일괄 실행과 카드 단추를 잠근다. */
  onBusyChange?: (busy: boolean) => void
}) {
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  // 작성자 실행은 글을 만든 뒤의 카드 · 브리프 · 초안을 읽어야 한다 — 누른 때의 값이 아니라 마지막으로 그린 값.
  const latest = useRef({ actions, briefs, drafts })
  useEffect(() => {
    latest.current = { actions, briefs, drafts }
  })
  const todo = actions.filter((a) => !drafts[a.id])
  if (!onlyIds && todo.length === 0 && !result) return null

  /** 만든 글의 카드가 그려지기를 기다린다(추가 글 목록 → 항목 계산). 제때 안 나타나면 null. */
  const cardsOf = async (ids: readonly string[]): Promise<GapAction[] | null> => {
    for (let waited = 0; waited <= CARD_WAIT_MS; waited += 100) {
      const found = ids.map((id) => latest.current.actions.find((a) => a.id === id))
      if (found.every((a): a is GapAction => a !== undefined)) return found
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return null
  }

  const runOnly = async (ids: readonly string[]) => {
    setBusy(true)
    onBusyChange?.(true)
    setResult(null)
    setWarnings([])
    const warned: string[] = []
    let ok = 0
    let total = 0
    let failure: string | null
    try {
      failure = prepare ? await prepare(setProgress) : null
      const cards = failure ? null : await cardsOf(ids)
      if (!failure && !cards) failure = '만든 글의 카드가 나타나지 않았어요. 화면을 다시 연 뒤 다시 눌러 주세요.'
      if (cards) {
        const { briefs: known, drafts: made } = latest.current
        const mainDraft = mainId ? made[mainId] : undefined
        const list = cards.filter((a) => !made[a.id])
        total = list.length
        for (const [i, a] of list.entries()) {
          const name = a.extra?.name ?? a.title
          try {
            if (!known[a.id]) {
              setProgress(`${i + 1}/${list.length} · ${name} · 브리프`)
              const s = await generateContentBrief(tenantId, briefInputOf(a, mainDraft))
              onBrief(s)
              const w = briefWarning?.(a, s)
              if (w) warned.push(w)
            }
            setProgress(`${i + 1}/${list.length} · ${name} · 초안`)
            onDraft(await generateContentDraft(tenantId, draftRequestOf(a)))
            ok += 1
          } catch (e) {
            failure = `${name} — ${e instanceof Error ? e.message : String(e)}`
            break
          }
        }
      }
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e)
    } finally {
      setProgress('')
      setBusy(false)
      onBusyChange?.(false)
    }
    setWarnings(warned)
    setResult(
      failure
        ? `${ok > 0 ? `초안 ${ok}편을 만들고 ` : ''}멈췄어요 — ${failure}\n다시 누르면 남은 것부터 이어서 합니다.`
        : total === 0
          ? '이 작성자의 글은 모두 초안까지 있어요.'
          : `초안 ${ok}편을 만들었습니다.`,
    )
  }

  if (onlyIds) {
    return (
      <div className="brief-bar" style={{ marginBottom: 10 }}>
        <button
          type="button"
          onClick={() => void runOnly(onlyIds)}
          disabled={busy || locked || Boolean(blocked)}
          title="없는 배정 글을 만들고, 글마다 브리프(없으면)와 초안을 차례로 만듭니다 — 한 편에 판정 2~4회"
        >
          {busy ? `만드는 중… ${progress}` : label}
        </button>
        {!busy && blocked && <span className="hint warn">{blocked}</span>}
        {!busy && !blocked && locked && <span className="doc-meta">다른 일괄 실행이 끝난 뒤에 누를 수 있어요.</span>}
        {busy && <span className="doc-meta">한 편씩 저장되므로 화면을 떠나도 끝난 글은 남습니다.</span>}
        {result && (
          <span className={result.includes('멈췄어요') ? 'error' : 'doc-meta'} style={{ whiteSpace: 'pre-line' }}>
            {result}
          </span>
        )}
        {warnings.length > 0 && (
          <span className="hint warn" style={{ whiteSpace: 'pre-line' }}>
            {warnings.join('\n')}
          </span>
        )}
      </div>
    )
  }

  const run = async () => {
    setBusy(true)
    onBusyChange?.(true)
    setResult(null)
    const failed: string[] = []
    let ok = 0
    // 본 글이 먼저 돈다(글 목록 순서) — 이번에 만든 본 글 초안도 뒤의 추가 글 브리프가 피할 글로 쓴다.
    let mainDraft = mainId ? drafts[mainId] : undefined
    for (const [i, a] of todo.entries()) {
      setProgress(`${i + 1}/${todo.length} · ${a.title}`)
      try {
        if (!briefs[a.id]) onBrief(await generateContentBrief(tenantId, briefInputOf(a, mainDraft)))
        const d = await generateContentDraft(tenantId, draftRequestOf(a))
        onDraft(d)
        if (a.id === mainId) mainDraft = d
        ok += 1
      } catch (e) {
        failed.push(`${a.title} — ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    setProgress('')
    setBusy(false)
    onBusyChange?.(false)
    setResult(failed.length === 0 ? `초안 ${ok}편을 만들었습니다.` : `${ok}편 성공 · ${failed.length}편 실패\n${failed.join('\n')}`)
  }
  return (
    <div className="brief-bar" style={{ marginBottom: 10 }}>
      {todo.length > 0 && (
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy || locked}
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

/**
 * 작성자 단추 — 작성자 배정(src/lib/probePlan.ts)의 한 작성자 글(10편)을 단추 하나로 만들고 브리프 · 초안까지 차례로 만든다. 글은 운영자
 * PC 한 곳에서 모두 만들고 작성자는 받은 초안을 자기 블로그에 올린다. 사람이 질문을 고르다 배정과 다르게 묶는 일을 없앤다.
 *
 * 누르기 전에 확인한다 — 보는 주의 질문 은행 판이 배정 판인가(다른 판이면 같은 id가 다른 질문이다), 살아 있는 추가 글 + 만들 글이 상한
 * (writerRunCapReason · extraArticleCap — 운영 기간에는 배정 글 수 + 10) 안인가, 측정 중이 아닌가(판정 엔진을 함께 쓴다), 다른 일괄 실행이 돌고 있지 않은가
 * (브리프 · 초안 파일 쓰기에 줄이 없다). 이미 살아 있는 글은 건너뛰고, 뺀 글은 서버가 되살린다. 배정 글의 각도는 추가 글의 「다룰
 * 각도」로 들어가 브리프 각도가 된다.
 *
 * 초안이 있으면 그 작성자 몫을 한 폴더로 받는 단추도 둔다(src/lib/writerBundle.ts — 글마다 홈페이지용 .html과 사진 파일). 그 아래
 * 「사진 자동 채우기」(PhotoAutoFill)는 작성자 글의 빈 사진 자리를 홈페이지 사진으로 채운다 — 브랜드 전부 단추도 맨 위에 둔다.
 */
function WriterRuns({
  tenantId,
  brand,
  writerPlan,
  writerKey,
  weekBank,
  extrasList,
  extrasBlocked,
  create,
  actions,
  briefs,
  drafts,
  mainId,
  onBrief,
  onDraft,
  locked,
  onBusyChange,
  onPhotosBusyChange,
}: {
  tenantId: string
  /** 묶음의 .html이 쓰는 브랜드(글 끝 · JSON-LD · 사진의 업종 확인). */
  brand: TenantSummary
  /** 운영 기간 안의 배정. */
  writerPlan: WriterPlan
  /** 작성자 거르기 — 고르면 그 작성자 단추만 보인다. */
  writerKey: string | null
  /** 보는 주를 잰 질문 은행 판(모르면 null). */
  weekBank: string | null
  /** 추가 글 정의 전부(뺀 글 포함). */
  extrasList: ExtraArticle[]
  /** 추가 글 목록을 읽지 못했거나 깨졌다 — 누를 수 없는 이유. */
  extrasBlocked: string | null
  /** 추가 글 만들기(useGapActionPlan extras.create) — 성공하면 null, 실패하면 이유. */
  create: (input: { name: string; angle: string; questionIds: string[]; questionTexts: string[] }) => Promise<string | null>
  /** 이번 주 항목 전부 — 만든 글의 카드를 여기서 찾는다. */
  actions: GapAction[]
  briefs: Record<string, StoredBrief>
  drafts: Record<string, StoredDraft>
  mainId: string | undefined
  onBrief: (s: StoredBrief) => void
  onDraft: (s: StoredDraft) => void
  /** 다른 일괄 실행이 도는 중. */
  locked: boolean
  onBusyChange: (busy: boolean) => void
  /** 사진 자동 채우기 저장 시작 · 끝(BulkKind photos). */
  onPhotosBusyChange: (busy: boolean) => void
}) {
  const status = useMeasureStatus()
  const measuringRun = status.runs?.current[0] ?? null
  const measuring = measuringRun !== null || status.active.length > 0
  const measuringName = measuringRun?.brandName ?? status.active[0]?.brandName ?? ''
  const alive = new Set(aliveExtraArticles(extrasList).map((a) => a.id))
  const today = todayKst()
  const cap = extraArticleCap(writerPlan, today)
  const writers = planWriters(writerPlan).filter((w) => !writerKey || w.key === writerKey)
  // 묶음 받기 — 한 번에 한 작성자. 결과 · 실패는 그 작성자 줄에 보인다.
  const [bundleBusy, setBundleBusy] = useState<string | null>(null)
  const [bundleNote, setBundleNote] = useState<{ key: string; text: string; error: boolean } | null>(null)
  /** 사진 자동 채우기 — 글의 작성자(같은 작성자 글 사이에 같은 사진을 한 번만). */
  const groupOf = (id: string) => writerArticle(writerPlan, id)?.writer.key
  const photoArticle = (id: string) => {
    const stored = drafts[id]
    return stored ? [{ stored, title: draftTitle(effectiveDraft(stored)) }] : []
  }
  // 작성자 줄의 「사진 자리 n · 채움 m · 자동 k · 빈자리 j」 — 초안이 바뀔 때만 다시 센다(글마다 발행 원고를 만든다).
  const photoStats = useMemo(() => {
    const out = new Map<string, ReturnType<typeof photoSlotStats>>()
    for (const w of planWriters(writerPlan)) {
      const mine = writerPlan.articles.filter((a) => a.writer.key === w.key && drafts[a.id])
      out.set(w.key, photoSlotStats(mine.map((a) => ({ markdown: publishMarkdownOf(drafts[a.id]!), picks: drafts[a.id]!.photos }))))
    }
    return out
  }, [writerPlan, drafts])
  // 브랜드 전부 — 배정 순서의 작성자 글, 그다음 배정에 없는 자사 글(본 글 등).
  const brandPhotoArticles = [
    ...writerPlan.articles.flatMap((a) => photoArticle(a.id)),
    ...actions.filter((a) => a.kind === 'content' && !writerArticle(writerPlan, a.id)).flatMap((a) => photoArticle(a.id)),
  ]

  /** 그 작성자의 초안을 한 폴더로 — 글 카드 「홈페이지용 .html」과 같은 사실 · 발행 설정으로 만든다. 폴더 고르기를 닫으면 아무 말도 하지 않는다. */
  const saveBundle = async (key: string) => {
    setBundleBusy(key)
    setBundleNote(null)
    try {
      const [facts, settings] = await Promise.all([
        loadFactGraph(tenantId)
          .then((fg) => fg?.factGraph ?? [])
          .catch((e: unknown) => {
            console.error('[WriterRuns] 브랜드 사실을 읽지 못해 Organization 없이 만듭니다', e)
            return [] as FactNode[]
          }),
        loadPublishSettings(tenantId),
      ])
      const bundle = writerBundle({ plan: writerPlan, writerKey: key, drafts, brand, facts, settings, today })
      const saved = await saveWriterBundle(tenantId, bundle)
      if (!saved) return
      const parts = [`「${saved.where}」에 글 ${bundle.articles}편${bundle.photos > 0 ? ` · 사진 ${bundle.photos}장` : ''}을 저장했어요.`]
      if (bundle.missing.length > 0) parts.push(`초안이 없는 ${bundle.missing.length}편은 뺐어요(${bundle.missing.join(' · ')}).`)
      if (bundle.withGaps > 0) parts.push(`빈칸이 남은 글 ${bundle.withGaps}편 — 빈칸 줄은 빠졌어요.`)
      setBundleNote({ key, text: parts.join(' '), error: false })
    } catch (e) {
      setBundleNote({ key, text: `묶음을 다 저장하지 못했어요 — ${e instanceof Error ? e.message : String(e)}`, error: true })
    } finally {
      setBundleBusy(null)
    }
  }

  /** 브리프의 답할 질문 앞부분에 배정 문장이 모두 있는지 — 모델 출력이라 다르면 알리기만 한다. */
  const briefWarning = (a: GapAction, s: StoredBrief): string | null => {
    const planned = writerArticle(writerPlan, a.id)
    if (!planned) return null
    const head = new Set(s.brief.questionsToAnswer.slice(0, planned.questionTexts.length).map(questionTextKey))
    if (planned.questionTexts.every((t) => head.has(questionTextKey(t)))) return null
    return `「${planned.name}」 브리프의 답할 질문 앞부분이 배정 문장과 달라요 — 모델이 쓴 것이라 브리프를 열어 확인해 주세요.`
  }

  /** 없는 배정 글만 차례로 만든다 — 살아 있는 글은 건너뛰고, 뺀 글은 서버가 되살린다(초안 · 기록이 이어진다). 각도도 함께 보낸다. */
  const prepareOf = (mine: WriterPlanArticle[]) => async (progress: (text: string) => void): Promise<string | null> => {
    for (const [i, a] of mine.entries()) {
      if (alive.has(a.id)) continue
      progress(`${i + 1}/${mine.length} · ${a.name} · 글 만들기`)
      const error = await create({ name: a.name, angle: a.angle, questionIds: [...a.questionIds], questionTexts: [...a.questionTexts] })
      if (error) return `「${a.name}」 글을 만들지 못했어요 — ${error}`
    }
    return null
  }

  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <p className="hint" style={{ margin: 0 }}>
        작성자마다 단추 하나로 그 작성자의 배정 글을 만들고 브리프 · 초안까지 차례로 만듭니다. 첫 실패에서 멈추고, 다시 누르면 남은 것부터
        이어서 합니다. 도는 동안에는 글 카드의 단추와 「글 더 만들기」를 잠급니다. 운영 기간(~{writerPlan.activeUntil})에는 추가 글을{' '}
        {cap}편까지 둘 수 있어요(지금 {alive.size}편).
      </p>
      {brandPhotoArticles.length > 0 && (
        <PhotoAutoFill
          tenantId={tenantId}
          brand={brand}
          articles={brandPhotoArticles}
          drafts={drafts}
          groupOf={groupOf}
          label={`사진 자동 채우기 — 브랜드 전부(글 ${brandPhotoArticles.length}편)`}
          locked={locked}
          onBusyChange={onPhotosBusyChange}
          onStored={onDraft}
        />
      )}
      {writers.map((w) => {
        const mine = writerPlan.articles.filter((a) => a.writer.key === w.key)
        const ids = mine.map((a) => a.id)
        const missing = mine.filter((a) => !alive.has(a.id)).length
        const drafted = ids.filter((id) => drafts[id]).length
        const photos = photoStats.get(w.key)
        const reason =
          extrasBlocked ??
          topicGuard(writerPlan, false, weekBank, ids[0], today) ??
          writerRunCapReason(writerPlan, alive, w.key, today) ??
          (measuring ? `측정이 끝난 뒤에 눌러 주세요${measuringName ? `(지금 ${measuringName} 측정 중)` : ''}.` : null)
        return (
          <div key={w.key} style={{ display: 'grid', gap: 2 }}>
            <p className="doc-meta" style={{ margin: 0 }}>
              <b>
                {w.key} · {w.name}
              </b>
              {w.blog && ` · ${w.blog}`} · 만든 글 {ids.length - missing}/{ids.length} · 초안 {drafted}/{ids.length}
              {photos && photos.slots > 0 && ` · 사진 자리 ${photos.slots} · 채움 ${photos.filled} · 자동 ${photos.auto} · 빈자리 ${photos.empty}`}
            </p>
            <BulkDrafts
              tenantId={tenantId}
              actions={actions}
              briefs={briefs}
              drafts={drafts}
              mainId={mainId}
              onBrief={onBrief}
              onDraft={onDraft}
              onlyIds={ids}
              label={`${w.name} — ${ids.length}편 만들기 · 브리프 · 초안`}
              blocked={reason}
              prepare={prepareOf(mine)}
              briefWarning={briefWarning}
              locked={locked}
              onBusyChange={onBusyChange}
            />
            {drafted > 0 && (
              <div className="brief-bar" style={{ marginBottom: 10 }}>
                <button
                  type="button"
                  className="ghost"
                  disabled={bundleBusy !== null}
                  onClick={() => void saveBundle(w.key)}
                  title={
                    canSaveToFolder()
                      ? '고른 폴더 안에 이 작성자 묶음 폴더를 만들어 글마다 홈페이지용 .html과 사진 파일을 저장합니다(파일 앞 번호는 배정표 번호).'
                      : '글마다 홈페이지용 .html과 사진 파일을 내려받습니다(파일 이름 앞에 묶음 이름).'
                  }
                >
                  {bundleBusy === w.key ? '묶음 저장 중…' : `초안 ${drafted}편 묶음 받기`}
                </button>
                {bundleNote?.key === w.key && (
                  <span className={bundleNote.error ? 'error' : 'doc-meta'} role={bundleNote.error ? 'alert' : undefined}>
                    {bundleNote.text}
                  </span>
                )}
              </div>
            )}
            {drafted > 0 && photos && photos.slots > 0 && (
              <PhotoAutoFill
                tenantId={tenantId}
                brand={brand}
                articles={mine.flatMap((a) => photoArticle(a.id))}
                drafts={drafts}
                groupOf={groupOf}
                label={`${w.name} — 사진 자동 채우기`}
                locked={locked}
                onBusyChange={onPhotosBusyChange}
                onStored={onDraft}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

/** 항목 하나. 근거와 완료 조건을 항상 함께 보여준다 — 지시만 있고 근거가 없으면 안 하게 된다. */
/**
 * 「① 글 확인」 한 편의 상태 — 목록 줄과 카드 머리가 같은 말을 쓴다. 카드 안쪽(초안 패널)에만 있으면 4편을 훑어서는
 * 어느 글이 확인됐는지 알 수 없었다(2026-10-20).
 */
function articleStateOf(x: PublishArticle): { label: string; tone: string } {
  if (x.confirmed) return { label: '✓ 확인됨', tone: 'st-good' }
  if (x.draft) return { label: `빈칸 ${x.gapsLeft}곳`, tone: 'st-warn' }
  return { label: '초안 없음', tone: 'st-ok' }
}

/**
 * 이 글이 무엇을 위한 글인지 — 카드 머리에 항목 이름이 크게 있으면 글 이름처럼 읽혀, 글이 있는 카드는 글 제목을 크게 ·
 * 이 설명은 작게 둔다(2026-10-20). 콘텐츠 항목은 답하는 질문 묶음(항목 제목 「카테고리 무관 질문 콘텐츠 보강」에서
 * 「콘텐츠 보강」을 뗀 것, lib/gapActions.ts), 추가 글은 사람이 붙인 주제 이름, 덮는 글이 없는 채널 항목은 그 채널
 * (「namu.wiki 문서 보완」)이다.
 */
function articleRoleOf(action: GapAction): { line: string; short: string } {
  if (action.kind !== 'content') return { line: `${action.title}용 글`, short: action.title }
  const group = action.extra?.name ?? action.title.replace(/\s*콘텐츠 보강$/, '')
  // 이번 주 결과가 있는 질문이 없는 추가 글은 「0개」가 아니라 확인 불가 — 밀린 질문이 없는 것처럼 읽히면 안 된다.
  const count = extraStandingOf(action) === 'unknown' ? '확인 불가' : `${action.reach}개`
  return { line: `${group}에 답하는 글`, short: `${group} ${count}` }
}

function ActionCard({
  action,
  article,
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
  mainDraft,
  takenByExtras = 0,
  onRemoveExtra,
  writerLabel = null,
  locked = false,
  photoContext,
}: {
  action: GapAction
  /** 사진 자동 채우기의 반복 상한에 셀 브랜드 초안과 작성자(SitePhotoPanel photoContext). */
  photoContext?: { drafts: Readonly<Record<string, StoredDraft>>; groupOf?: (actionId: string) => string | undefined }
  /** 작성자 배정 기간의 배정 글 표시 — 「작성자 이름 · 블로그」. */
  writerLabel?: string | null
  /** 작성자 배정 기간의 일괄 실행 중 — 카드 전체를 잠근다(브리프 · 초안 파일 쓰기에 줄이 없어 같은 파일을 함께 쓰지 않게). */
  locked?: boolean
  /** 「① 글 확인」의 글이면 그 확인 상태 — 카드 머리에 같은 표시를 단다. */
  article?: PublishArticle
  /** 본 글의 저장된 초안 — 추가 글의 브리프가 그 제목 · 소제목과 겹치지 않게 한다(briefInputOf). */
  mainDraft?: StoredDraft
  /** 본 글 카드일 때 추가 글이 가져간 이번 주 질문 수. */
  takenByExtras?: number
  /** 추가 글 카드의 「목록에서 빼기」 — 성공하면 null, 실패하면 이유. */
  onRemoveExtra?: () => Promise<string | null>
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
  posts: (PlanPosts & { citedInWeek?: ReadonlySet<string> | null; timingInWeek?: ReturnType<typeof weekFileTimingOf> }) | null
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
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const extra = action.extra
  const standing = extraStandingOf(action)
  /** 「목록에서 빼기」 — 지우지 않는다. 초안 · 올린 기록은 남고, 맡던 질문은 다음 계산부터 본 글로 돌아간다. */
  const removeExtra = async () => {
    if (!extra || !onRemoveExtra) return
    // 다시 이어지는 것은 같은 판에서 같은 질문으로 만들 때뿐이다 — 글 id가 그 판의 질문 id로 정해진다(lib/extraArticles.ts topicArticleId).
    const ok = window.confirm(
      `「${extra.name}」 글을 목록에서 뺄까요?\n\n` +
        '초안과 올린 기록은 지우지 않고 남겨 둡니다(콘텐츠 보관함 · AEO 퍼포먼스의 올린 글 인용 추적에서 볼 수 있어요). ' +
        '이 글이 맡던 질문 가운데 이번 주 질문 은행에 있는 것은 본 글로 돌아갑니다. ' +
        '질문 은행 판이 같을 때 같은 질문으로 다시 만들면 초안과 기록이 이어집니다(판이 바뀐 뒤에 만들면 새 글로 시작해요).',
    )
    if (!ok) return
    setRemoving(true)
    setRemoveError(null)
    try {
      const error = await onRemoveExtra()
      if (error) setRemoveError(error)
    } catch (e) {
      setRemoveError(e instanceof Error ? e.message : String(e))
    } finally {
      setRemoving(false)
    }
  }
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
  // 「① 글 확인」의 글이면 머리에 글 제목을 크게, 답하는 질문 묶음은 그 아래 작게.
  const articleTitle = article?.draft ? draftTitle(effectiveDraft(article.draft)) : null
  return (
    <article className={`gap-card${focused ? ' is-focused' : ''}`} id={`action-${action.id}`} inert={locked || undefined}>
      <div className="gap-card-head">
        <span className="gap-name">{articleTitle ?? action.title}</span>
        <span className={`status-pill ${action.satisfied ? 'st-good' : `no-glyph ${KIND_CLASS[action.kind]}`}`}>
          {action.satisfied ? '충족' : action.badge}
        </span>
        {writerLabel && <span className="status-pill st-info">{writerLabel}</span>}
        {article && <span className={`status-pill ${articleStateOf(article).tone}`}>{articleStateOf(article).label}</span>}
        <span className="gap-rate">
          {standing === 'unknown' ? (
            // 이번 주 결과가 있는 질문이 없다 — 0개로 보이면 밀린 질문이 없는 것처럼 읽힌다.
            <>
              AI가 우리를 말하지 않는 질문 <b>확인 불가</b>
            </>
          ) : (
            <>
              AI가 우리를 말하지 않는 질문 <b>{action.reach}</b>개
            </>
          )}
        </span>
      </div>
      {articleTitle && <p className="gap-card-group">{articleRoleOf(action).line}</p>}
      {takenByExtras > 0 && (
        // 본 글은 다시 만들지 않는다 — 질문 목록 · 진행 막대 · 채널 배정만 바뀐다(lib/gapActions.ts contentActions).
        <p className="hint" style={{ margin: 0 }}>
          이 질문 {takenByExtras}개는 추가 글이 맡습니다.{hasDraft && ' 이미 만든 본 글에는 그대로 있어요(다시 만들 필요 없음).'}
        </p>
      )}
      {extra && extra.missingTexts.length > 0 && (
        // 찾지 못한 질문은 세지 않는다 — 0이나 「이김」으로 채우지 않고 확인 불가로 밝힌다.
        <details className="draft-audit">
          <summary>
            {/* 까닭은 근거 문장(lib/gapActions.ts missingWhy)과 같게 — 판을 모르는 것과 판이 바뀐 것은 다른 일이다. */}
            {extra.missingWhy === 'bank-unknown'
              ? `이번 주 질문 은행 판을 몰라 고른 질문 ${extra.missingTexts.length}개는 확인 불가예요.`
              : `고른 질문 ${extra.missingTexts.length}개는 이번 주 질문 은행에서 찾지 못해 확인 불가예요${
                  extra.missingWhy === 'bank-changed' ? ' — 질문 은행 판이 바뀌었습니다.' : '.'
                }`}
          </summary>
          <ul className="muted">
            {extra.missingTexts.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </details>
      )}
      {extra && extra.how === 'by-text' && extra.missingTexts.length === 0 && (
        <p className="doc-meta" style={{ margin: 0 }}>
          질문 은행 판이 바뀌어 문장이 같은 질문으로 다시 찾았어요.
        </p>
      )}
      {standing === 'all-win' && (
        // 이긴 주에도 사람이 뺄 때까지 남긴다 — 올린 기록이 목록에서 사라지면 안 된다.
        <p className="gap-tally" style={{ color: 'var(--ink)' }}>
          이번 주 고른 질문을 모두 이기고 있어요.
        </p>
      )}
      {extra && standing === 'no-loss' && (
        // 밀린 질문이 없다고 모두 이긴 것은 아니다 — 무승부 · 되물음은 이김이 아니고, 응답 없는 질문은 확인 불가다.
        <p className="gap-tally" style={{ color: 'var(--ink)' }}>
          이번 주 {extra.missingTexts.length > 0 ? '찾은 질문 가운데 ' : '고른 질문 가운데 '}밀리는 질문은 없어요.
          {extra.noAnswer > 0 && ` 응답이 없는 질문 ${extra.noAnswer}개는 확인 불가예요.`}
        </p>
      )}
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
              {extra ? `고른 질문 가운데 ${PREVIEW_QUESTIONS}개만` : `많이 밀리는 순으로 ${PREVIEW_QUESTIONS}개만`} 보입니다. 글은{' '}
              {action.questionTexts.length}개 전부에 답합니다.
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
          citedInWeek={posts.citedInWeek}
          timingInWeek={posts.timingInWeek}
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
          onAddEdit={(postId, editedOn) => posts.addEdit(postId, { editedOn })}
          onRemoveEdit={posts.removeEdit}
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
          {/* 글은 보류하지 않는다 — 본 글을 보류하면 올리기 목록이 채널마다 따로 쓸 글로 쪼개진다(gapActions.ts). 추가 글은 「목록에서 빼기」로 뺀다. */}
          {STATUS_CHOICES.filter((c) => action.kind !== 'content' || c.value !== 'skip').map((c) => (
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
          <BriefPanel tenantId={tenantId} action={action} stored={briefs[action.id]} onStored={onBrief} mainDraft={mainDraft} initiallyOpen />
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
          titleInHeader={Boolean(articleTitle)}
          ensureBrief={async () => {
            onBrief(await generateContentBrief(tenantId, briefInputOf(action, mainDraft)))
          }}
          photoContext={photoContext}
        />
      )}
      {extra && onRemoveExtra && (
        <div className="brief-bar">
          <button type="button" className="ghost" disabled={removing} onClick={() => void removeExtra()}>
            {removing ? '빼는 중…' : '목록에서 빼기'}
          </button>
          {removeError && (
            <span className="error" role="alert">
              {removeError}
            </span>
          )}
        </div>
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
  const { plan, weeks, weekOf, setWeekOf, loading, neverMeasured, canSaveStatus, setStatus, saveError, canRecordPosts, posts, extras } =
    useGapActionPlan(tenant?.tenantId ?? '')
  // 작성자 배정 — 운영 기간 안이면 작성자 단추 · 작성자 거르기가 생기고 「글 더 만들기」가 배정표 글만 고른다. 파일이 없으면 지금과 같다.
  const probe = useProbePlan(tenant?.tenantId ?? '')
  const activePlan = probe.active
  // 작성자 거르기 — 브랜드마다 따로 둔다(브랜드를 바꿔도 이 화면은 그대로다). 배정에 없는 작성자면 전체로 본다.
  const [writerPick, setWriterPick] = useState<{ tenantId: string; key: string } | null>(null)
  const pickedKey = writerPick && writerPick.tenantId === tenant?.tenantId ? writerPick.key : ''
  const writerKey = activePlan && pickedKey && activePlan.articles.some((a) => a.writer.key === pickedKey) ? pickedKey : null
  // 도는 일괄 실행 — 작성자 배정 기간에는 도는 동안 카드와 「글 더 만들기」를 잠근다(브리프 · 초안 파일 쓰기에 줄이 없다). 브랜드마다
  // 따로 센다 — 브랜드를 바꿔도 이 화면은 그대로라, 앞 브랜드에서 누른 실행이 끝날 때까지 지금 브랜드를 잠그면 안 된다(src/lib/bulkRun.ts).
  const [bulkRuns, setBulkRuns] = useState<BulkRuns>({})
  const bulkRunning = bulkRuns[tenant?.tenantId ?? ''] ?? null
  const pageLocked = activePlan !== null && bulkRunning !== null
  const bulkBusy = (tenantId: string, kind: BulkKind) => (busy: boolean) => setBulkRuns((r) => bulkRunsAfter(r, tenantId, kind, busy))
  // 지금 보는 브랜드 — 앞 브랜드의 작성자 실행이 넘기는 브리프 · 초안을 버리는 데 쓴다(useGapActionPlan의 currentTenant와 같다).
  const currentTenant = useRef(tenant?.tenantId ?? '')
  useEffect(() => {
    currentTenant.current = tenant?.tenantId ?? ''
  }, [tenant?.tenantId])
  // 그 주 회차를 합친 올린 글 칸 — 마지막 저장 측정에는 없고 같은 주 다른 회차에서만 인용된 글을 주소 알약이 밝힌다(성과 표와 같은 칸).
  const postsRevision = useMemo(() => posts.list.map((p) => `${p.id}|${p.publishedOn ?? ''}|${p.removedAt ?? ''}`).join(','), [posts.list])
  const weekHistory = usePublishedHistory(canRecordPosts ? (tenant?.tenantId ?? '') : '', 12, postsRevision)
  const citedInWeek = useMemo(
    () => (weekHistory.history && weekOf ? citedPostIdsInWeek(weekHistory.history, weekOf) : null),
    [weekHistory.history, weekOf],
  )
  // 같은 날 올린 글 — 이번 주 결과가 전후 불명이면 회차 기록의 측정 시작까지 써서 다시 잰다(publishTracking.ts weekFileTimingOf).
  const timingInWeek = useMemo(
    () => (weekHistory.history && weekOf ? weekFileTimingOf(weekHistory.history, weekOf, plan.weekWindow) : null),
    [weekHistory.history, weekOf, plan.weekWindow],
  )
  const cardPosts = canRecordPosts ? { ...posts, citedInWeek, timingInWeek } : null
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
  // 넘어온 곳이 「목록에서 뺀 것」이면 스크롤할 카드가 없다 — 왜 없는지 따로 말한다.
  const focusIdle = Boolean(focusId) && !loading && plan.actions.some((a) => a.id === focusId && isIdleAction(a))
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
  // 작성자 단추 — 운영 기간 안이고 추가 글 · 브리프 · 초안을 쓸 수 있는 환경(데스크톱)일 때만.
  const showWriters = activePlan !== null && extras.available && briefs !== null && drafts !== null

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
  // 글 카드 순서 — 본 글, 추가 글(만든 순서), 그 밖의 글(덮는 글 없는 채널). 항목 순위로 두면 추가 글이 본 글보다 앞에 올 수 있다.
  const extraOrder = new Map(extras.list.map((d, i) => [d.id, i]))
  const articleRank = (x: PublishArticle) => (x.action.kind !== 'content' ? 2 : isExtraArticleId(x.action.id) ? 1 : 0)
  const articleCards = [...publishPlan.articles].sort(
    (a, b) => articleRank(a) - articleRank(b) || (extraOrder.get(a.action.id) ?? 0) - (extraOrder.get(b.action.id) ?? 0),
  )
  const mainArticle = articleCards.find((x) => articleRank(x) === 0)
  // 본 글 초안 — 이번 주 본 글이 목록에 없어도(그 질문을 모두 이긴 주) 저장된 초안이 있으면 추가 글 브리프가 피할 글로 쓴다.
  const mainId = mainArticle?.action.id ?? plan.actions.find((a) => a.kind === 'content' && !isExtraArticleId(a.id))?.id
  const mainDraft = mainId ? drafts?.[mainId] : undefined
  const extraActions = plan.actions.filter((a) => a.extra)
  // 추가 글이 본 글에서 가져간 이번 주 밀린 질문(실증 제외) — 질문 id로 한 번씩 센다. 운영 기간에는 배정 글끼리 질문이 겹쳐 글마다
  // reach를 더하면 부푼다. 본 글이 비지 않게 하나도 빼지 않은 주(본 글에 추가 글의 질문이 그대로 있다)에는 0이다.
  const mainQuestionIds = new Set(mainArticle?.action.questionIds ?? [])
  const mainKeptAll = extraActions.some((a) => a.questionIds.some((id) => mainQuestionIds.has(id)))
  const takenByExtras = mainKeptAll ? 0 : extraTakenFromMain(extraActions)
  // 실증 칸 목록 — 맡은 추가 글로 처치(맡은 글 있음) · 대조(없음)를 밝힌다. 추가 글이 맡았는데 이번 주 응답이 없는 실증도 싣는다.
  const probeList = probeQuestionList(plan.probes, extraActions)
  const extraDefs = new Map(extras.list.map((d) => [d.id, d]))
  /** 이 추가 글의 배정 — 글 id는 만든 판의 질문 id라 배정 판으로 만든 글만 배정 글로 본다. 운영 기간이 아니면 null. */
  const writerArticleOf = (id: string) =>
    activePlan && extraDefs.get(id)?.bankVersion === activePlan.bankVersion ? writerArticle(activePlan, id) : null
  /** 추가 글 카드 머리의 작성자 표시 — 「작성자 이름 · 블로그」. 배정 글이 아니면 null. */
  const writerLabelOf = (a: GapAction) => (a.extra && writerArticleOf(a.id) ? writerChip(activePlan, a.id) : null)
  // 작성자 거르기 — 고른 작성자의 배정 글만 카드 · 올리기 목록에 남긴다. 고르지 않으면 지금과 같다.
  const shownByWriter = (id: string) => !writerKey || writerArticleOf(id)?.writer.key === writerKey
  const shownCards = writerKey ? articleCards.filter((x) => shownByWriter(x.action.id)) : articleCards
  // 사진 자동 채우기 — 반복 상한은 브랜드의 초안 전부와 작성자로 센다. 배정이 없으면 작성자 상한 없이 글 · 브랜드 상한만.
  const photoContext = drafts ? { drafts, groupOf: (id: string) => writerArticleOf(id)?.writer.key } : undefined
  const photoCards = drafts
    ? shownCards.flatMap((x) => {
        const stored = x.action.kind === 'content' ? drafts[x.action.id] : undefined
        return stored ? [{ stored, title: draftTitle(effectiveDraft(stored)) }] : []
      })
    : []
  const shownPlan = writerKey
    ? {
        ...publishPlan,
        articles: publishPlan.articles.filter((x) => shownByWriter(x.action.id)),
        rows: publishPlan.rows.filter((r) => shownByWriter(r.article.action.id)),
      }
    : publishPlan
  // 「글 더 만들기」 자리 — 작성자를 골라 본 글 카드가 걸러져도 글 카드 뒤에 남긴다(그 작성자의 배정표 글만 보인다).
  const formSlot = extraFormSlot({
    hasMain: mainArticle !== undefined,
    mainShown: mainArticle !== undefined && shownCards.includes(mainArticle),
    probes: plan.probes.length,
  })
  const extraForm = (main: GapAction | null) => (
    <ExtraArticleForm
      main={main}
      probes={plan.probes}
      extraActions={extraActions}
      bankVersion={extras.bankVersion}
      corrupt={extras.corrupt}
      loadError={extras.error}
      onCreate={extras.create}
      probePlan={activePlan}
      writerKey={writerKey}
      locked={pageLocked}
    />
  )
  const articleCount = articleCards.filter((x) => x.action.kind === 'content').length
  const confirmedCount = shownPlan.articles.filter((x) => x.confirmed).length
  const showArticle = (id: string) => {
    document.getElementById(`action-${id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  const satisfied = plan.actions.filter((a) => a.satisfied && a.status !== 'skip')
  const skipped = plan.actions.filter((a) => a.status === 'skip')
  const idle = plan.actions.filter(isIdleAction)
  /** 글이 여러 편일 때만 글 목록 · 한꺼번에 만들기를 보인다 — 보통은 한 편(gapActions contentActions)이고, 손댄 채널이 따로 쓴 글을 가질 때만 늘어난다. */
  const manyArticles = publishPlan.articles.length > 1
  // 글에 넣지 않은 밀린 질문만 있는 주(카테고리 무관 질문은 모두 이김)도 그린다 — 그 질문들을 밝히는 칸이 있다. 실증 질문만 있는 주도
  // 그린다 — 실증 칸과 「글 더 만들기」가 있다.
  const ready = !loading && (plan.actions.length > 0 || plan.otherLost.length > 0 || plan.probes.length > 0)

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
            올리는 곳입니다.{' '}
            {articleCount > 1 ? (
              <>
                글은 <b>{articleCount}편</b>입니다 — 본 글이 언급률 · 추천 순위를 재는 카테고리 무관 질문 가운데 우리가 밀린 질문에
                답하고, 추가 글은 본 글에서 떼어 낸 질문을 맡습니다.
              </>
            ) : (
              <>
                글은 <b>한 편</b>입니다 — 언급률 · 추천 순위를 재는 카테고리 무관 질문 가운데 우리가 밀린 질문에 답합니다.
              </>
            )}{' '}
            <b>① 글 확인</b>에서 그 글의 빈칸을 채우거나 빼면, <b>② 올리기 목록</b>에서 그 글을 올릴 곳이 열립니다.
            목록은 그곳에 올리면 덮이는 질문이 많은 순서입니다.
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
        {activePlan && (
          // 작성자 거르기 — 작성자 단추 · 글 카드 · 올리기 목록 · 「글 더 만들기」의 배정표 글을 그 작성자 것만 남긴다.
          <label className="field">
            <span>작성자</span>
            <select value={writerKey ?? ''} onChange={(e) => setWriterPick({ tenantId: tenant.tenantId, key: e.target.value })}>
              <option value="">전체</option>
              {planWriters(activePlan).map((w) => (
                <option key={w.key} value={w.key}>
                  {w.key} · {w.name}
                </option>
              ))}
            </select>
          </label>
        )}
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
      {/* 추가 글 목록을 읽지 못했다 — 빈 목록으로 계산해 추가 글 카드가 사라지고 그 질문이 본 글로 돌아간다. 「글 더 만들기」 칸은
          본 글이 없는 주에 그려지지 않으니 여기서 밝힌다. */}
      {extras.available && (extras.error || extras.corrupt) && (
        <p className="error" role="alert">
          추가 글 목록:{' '}
          {extras.error
            ? `읽지 못했어요(${extras.error}).`
            : '저장된 목록이 깨져 읽지 못했어요. 목록을 덮어쓰지 않으려고 새 추가 글도 만들지 않습니다.'}{' '}
          이미 만든 추가 글이 보이지 않고, 그 글이 맡던 질문은 본 글에 들어가 있어요.
        </p>
      )}
      {/* 작성자 배정을 읽지 못했다 — 서버는 그래도 배정 글 만들기를 막는다(fail closed). 파일이 없으면 아무것도 띄우지 않는다. */}
      {(probe.corrupt || probe.error) && (
        <p className="error" role="alert">
          작성자 배정:{' '}
          {probe.corrupt
            ? '배정 파일(probe-plan.json)이 깨져 있어 추가 글 · 브리프 · 초안을 만들지 않아요. 관리자에게 확인을 요청해 주세요.'
            : `읽지 못했어요(${probe.error}). 글 만들기가 막힐 수 있어요.`}
        </p>
      )}
      {pageLocked && (
        <p className="hint warn" role="status">
          일괄 실행 중 — 끝날 때까지 글 카드와 「글 더 만들기」를 잠갔어요(브리프 · 초안을 같은 파일에 함께 쓰지 않게).
        </p>
      )}

      {loading && <p className="muted">불러오는 중…</p>}

      {focusMissing && (
        <p className="muted" role="status">
          인용 갭 분석에서 넘어온 「{focusDomain || focusId}」에 대한 실행 항목이 이 주차에는 없습니다 — 인용이 적어 제외됐거나
          등재할 수 없는 출처(경쟁사·자사)입니다. <Link to="/citation-gap">인용 갭 분석으로 돌아가기</Link>
        </p>
      )}
      {focusIdle && (
        <p className="muted" role="status">
          인용 갭 분석에서 넘어온 「{focusDomain || focusId}」는 이번 주 올리기 목록에서 뺐습니다 — 글이 답하는 밀린 질문에서
          이곳이 인용되지 않아, 올려도 덮는 질문이 없습니다. <Link to="/citation-gap">인용 갭 분석으로 돌아가기</Link>
        </p>
      )}

      {!loading && plan.actions.length === 0 && plan.otherLost.length === 0 && plan.probes.length === 0 && (
        <p className="muted">
          {neverMeasured
            ? '이 브랜드는 아직 측정된 적이 없습니다. '
            : '이 주차에 분석 데이터가 없습니다. '}
          <Link to="/measure-tenant">브랜드·경쟁사 측정</Link>에서 측정하면 항목이 채워집니다.
        </p>
      )}

      {showWriters && activePlan && briefs !== null && drafts !== null && !loading && (
        // 작성자 단추 — 작성자마다 배정 글을 만들고 브리프 · 초안까지. 이번 주 밀린 질문이 없어도 배정 글은 만든다.
        <section>
          <h3 className="step-head">
            작성자 배정 <span className="muted">— 작성자 {planWriters(activePlan).length}명 · 글 {activePlan.articles.length}편 · {activePlan.bankVersion} 판</span>
          </h3>
          <WriterRuns
            key={tenant.tenantId}
            tenantId={tenant.tenantId}
            brand={tenant}
            writerPlan={activePlan}
            writerKey={writerKey}
            weekBank={extras.bankVersion}
            extrasList={extras.list}
            extrasBlocked={
              extras.error
                ? `추가 글 목록을 읽지 못해 누를 수 없어요(${extras.error}).`
                : extras.corrupt
                  ? '저장된 추가 글 목록이 깨져 있어 새 글을 만들 수 없어요.'
                  : null
            }
            create={extras.create}
            actions={plan.actions}
            briefs={briefs}
            drafts={drafts}
            mainId={mainId}
            // 브랜드를 바꾼 뒤에도 앞 브랜드의 실행이 돈다 — 그 브리프 · 초안은 지금 브랜드의 목록에 넣지 않는다.
            onBrief={(s) => passForTenant(currentTenant.current, tenant.tenantId, s, onBrief)}
            onDraft={(s) => passForTenant(currentTenant.current, tenant.tenantId, s, onDraft)}
            locked={bulkRunning !== null}
            onBusyChange={bulkBusy(tenant.tenantId, 'writer')}
            onPhotosBusyChange={bulkBusy(tenant.tenantId, 'photos')}
          />
        </section>
      )}

      {ready && (
        <>
          {open.length === 0 ? (
            <p className="muted">
              {/* 실증 질문도 카테고리 무관이라 「점수에 드는」을 붙인다 — 실증에서는 밀렸을 수 있다. */}
              {plan.probes.length > 0
                ? '점수에 드는 카테고리 무관 질문에서 밀린 곳은 없습니다.'
                : plan.otherLost.length > 0
                  ? '카테고리 무관 질문에서 밀린 곳은 없습니다.'
                  : '남은 항목이 없습니다.'}
            </p>
          ) : (
            <>
              {publishPlan.rows.length > 0 && drafts !== null && (
                <section className="publish-progress" aria-label="이번 주 올리기 진행">
                  <div className="publish-progress-row">
                    <span>
                      이번 주 올리기 <b>{publishPlan.done}</b> / {publishPlan.rows.length}곳
                    </span>
                    {publishPlan.totalQuestions > 0 && (
                      <span className="muted">
                        올린 글이 덮는 질문 <b>{publishPlan.coveredQuestions}</b> / {publishPlan.totalQuestions}개
                      </span>
                    )}
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

              {publishPlan.articles.length === 0 && (
                // 카테고리 무관 질문을 모두 이긴 주 — 남은 것은 이미 올린 곳의 주소 줄뿐이다(lib/publishPlan.ts).
                <p className="muted">
                  {plan.probes.length > 0 ? '점수에 드는 ' : ''}카테고리 무관 질문에서 밀린 곳은 없습니다. 아래는 이미 올린 곳입니다.
                </p>
              )}

              {publishPlan.articles.length > 0 && (
              <section>
                <h3 className="step-head">
                  ① 글 확인
                  {manyArticles && (
                    <>
                      {' '}
                      <span className="muted">
                        {shownPlan.articles.length}편 중 {confirmedCount}편 확인됨
                      </span>
                    </>
                  )}
                </h3>
                <p className="hint" style={{ marginTop: 0 }}>
                  {manyArticles
                    ? '빈칸을 채우거나 빼면 그 글이 확인되고, 아래 올리기 목록에서 그 글의 줄이 열립니다.'
                    : '빈칸을 채우거나 빼면 글이 확인되고, 아래 올리기 목록의 줄이 열립니다. 모든 곳에 이 글 한 편을 올립니다.'}
                </p>
                {manyArticles && (
                  <ul className="article-check-list" aria-label="글별 확인 상태">
                    {shownCards.map((x) => {
                      const state = articleStateOf(x)
                      return (
                        <li key={x.action.id}>
                          <span className={`status-pill ${state.tone}`}>{state.label}</span>
                          {/* 사용자가 알아보는 것은 글 제목이다 — 글이 없을 때만 항목 이름. */}
                          <span className="article-check-title">
                            {x.draft ? draftTitle(effectiveDraft(x.draft)) : x.action.title}
                            {x.draft && <span className="muted"> · {articleRoleOf(x.action).short}</span>}
                          </span>
                          <button type="button" className="ghost" onClick={() => showArticle(x.action.id)}>
                            보기
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
                {/* 한 편이면 카드의 「초안 만들기」가 같은 일을 한다. */}
                {manyArticles && briefs !== null && drafts !== null && (
                  <BulkDrafts
                    tenantId={tenant.tenantId}
                    actions={shownCards.map((x) => x.action)}
                    briefs={briefs}
                    drafts={drafts}
                    mainId={mainId}
                    onBrief={onBrief}
                    onDraft={onDraft}
                    locked={bulkRunning === 'writer' || bulkRunning === 'photos'}
                    onBusyChange={bulkBusy(tenant.tenantId, 'all')}
                  />
                )}
                {/* 작성자 배정이 없는 브랜드의 사진 자동 채우기 — 배정이 있으면 위 작성자 칸에 있다. 한 편이면 글의 「홈페이지 사진」 칸에서. */}
                {!activePlan && photoCards.length > 1 && drafts !== null && (
                  <PhotoAutoFill
                    tenantId={tenant.tenantId}
                    brand={tenant}
                    articles={photoCards}
                    drafts={drafts}
                    label={`사진 자동 채우기 — 글 ${photoCards.length}편`}
                    locked={bulkRunning !== null}
                    onBusyChange={bulkBusy(tenant.tenantId, 'photos')}
                    onStored={(s) => passForTenant(currentTenant.current, tenant.tenantId, s, onDraft)}
                  />
                )}
                {writerKey && shownCards.length === 0 && (
                  <p className="muted">이 작성자의 글이 아직 없어요 — 위 작성자 단추로 만드세요.</p>
                )}
                <div className="gap-grid">
                  {shownCards.map((x) => (
                    <Fragment key={x.action.id}>
                      <ActionCard
                        action={x.action}
                        article={x}
                        writerLabel={writerLabelOf(x.action)}
                        locked={pageLocked}
                        focused={focusId === x.action.id}
                        canSaveStatus={canSaveStatus}
                        onStatus={setStatus}
                        tenantId={tenant.tenantId}
                        briefs={briefs}
                        onBrief={onBrief}
                        drafts={drafts}
                        onDraft={onDraft}
                        posts={cardPosts}
                        weekOf={weekOf}
                        coveredBy={null}
                        mainDraft={mainDraft}
                        takenByExtras={x === mainArticle ? takenByExtras : 0}
                        onRemoveExtra={x.action.extra && extras.available ? () => extras.update({ id: x.action.id, removed: true }) : undefined}
                        photoContext={photoContext}
                      />
                      {/* 「글 더 만들기」는 본 글 카드 바로 아래. 이 환경에 기능이 없으면(웹) 칸째 숨긴다 — 오류 문구도 띄우지 않는다. */}
                      {x === mainArticle && formSlot === 'under-main' && extras.available && extraForm(x.action)}
                    </Fragment>
                  ))}
                  {/* 작성자를 골라 본 글 카드가 걸러진 주 — 「글 더 만들기」를 글 카드 뒤에 둔다. */}
                  {mainArticle && formSlot === 'after-cards' && extras.available && extraForm(mainArticle.action)}
                </div>
              </section>
              )}

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
                    plan={shownPlan}
                    settings={publishSettings}
                    adaptations={adaptations}
                    onAdapted={onAdapted}
                    focusId={focusId}
                    onShowArticle={showArticle}
                    urlSlot={(row) =>
                      canRecordPosts ? (
                        <PublishedUrlEditor
                          addLabel="올렸어요"
                          hits={row.hits}
                          // 뺀 주소도 그 줄이 보이는 기록과 같은 규칙으로(publishPlan.ts keepsArticle) — 다르면 뺀 주소를 되살릴 곳이 없다.
                          removed={posts.list.filter((p) => p.targetActionId === row.target.id && p.removedAt && row.keepsArticle(p.articleId))}
                          weekOf={weekOf}
                          citedInWeek={citedInWeek}
                          timingInWeek={timingInWeek}
                          busy={posts.busy}
                          // 올린 글 · 올린 곳 · 초안 판을 함께 남긴다 — 채널 항목 하나를 여러 글이 함께 쓰고, 초안은 다시 만들면 덮인다.
                          // 글 · 대상 · 집행 상태를 바꿀지 · 추가 글의 질문 스냅샷은 줄 모델이 정한다(publishPlan.ts recordInputOf).
                          onRecord={(url, publishedOn, chosen) =>
                            posts.record({
                              url,
                              ...recordInputOf(row),
                              articleTitle: row.article.draft ? draftTitle(effectiveDraft(row.article.draft)) : row.article.action.title,
                              ...(row.article.draft ? { draftGeneratedAt: row.article.draft.generatedAt } : {}),
                              ...(adaptations?.[row.article.action.id]?.[row.target.id]
                                ? { adaptationSourceKey: adaptations[row.article.action.id]![row.target.id]!.sourceKey }
                                : {}),
                              publishedOn,
                              publishedOnChosen: chosen,
                            })
                          }
                          onRemove={posts.remove}
                          onRestore={posts.restore}
                          onSetDate={posts.setPublishedOn}
                          // 고친 날에는 지금 이 줄이 복사하는 판을 남긴다 — 「본문 다시 복사」로 붙여 넣은 글이다.
                          onAddEdit={(postId, editedOn) =>
                            posts.addEdit(postId, {
                              editedOn,
                              ...(row.article.draft ? { draftGeneratedAt: row.article.draft.generatedAt } : {}),
                              ...(row.needsAdapt && adaptations?.[row.article.action.id]?.[row.target.id]
                                ? { adaptationSourceKey: adaptations[row.article.action.id]![row.target.id]!.sourceKey }
                                : {}),
                            })
                          }
                          onRemoveEdit={posts.removeEdit}
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

          {plan.otherLost.length > 0 && (
            // 예전에는 유형마다 글을 한 편씩 썼다(질문 1~3개짜리). 글은 이제 한 편이라 여기 밝혀 둔다 — 목록 밖에 있어도 보이게,
            // 남은 항목이 없는 주에도 그린다.
            <section>
              <details className="gap-more">
                <summary>글에 넣지 않은 밀린 질문 {plan.otherLost.length}개 — 카테고리 무관이 아닌 질문</summary>
                <p className="hint" style={{ marginTop: 0 }}>
                  언급률 · 추천 순위는 카테고리 무관 질문으로만 재서, 글은 그 질문에만 답합니다.
                  {/* 옛 은행(v1 · v3)에는 유형은 다르지만 브랜드 이름이 없는 질문이 많다 — 이름 든 질문이 있을 때만 그 말을 한다. */}
                  {plan.otherLost.some((q) => q.containsBrandName === true) &&
                    ' 브랜드 이름을 넣은 질문은 쓰는 방식도 반대입니다(첫 문장에서 바로 답).'}{' '}
                  다만 이 질문들의 답이 자사 사이트를 인용하는 비율(브랜드 소유 출처)은 점수에 들어갑니다 — 답에 필요한 사실이 자사
                  사이트의 소개 · 자주 묻는 질문과{' '}
                  <Link to="/brand-facts">브랜드 사실</Link>에 있는지 확인하세요. 이 질문으로 글을 따로 쓰려면{' '}
                  <Link to="/questions">질문 은행</Link>에서 골라 쓰고, 예전에 만든 초안은 <Link to="/content-library">콘텐츠 보관함</Link>에
                  있습니다.
                </p>
                <ul className="gap-worst">
                  {plan.otherLost.map((q) => (
                    <li key={q.questionId}>
                      <span className="gap-q">{q.text}</span>{' '}
                      <span className="muted">
                        · {q.categoryLabel}
                        {q.containsBrandName === true && ' · 브랜드 이름 있음'}
                        {q.containsBrandName === false && ' · 브랜드 이름 없음'}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            </section>
          )}

          {probeList.length > 0 && (
            // 실증 질문 — 점수 · 본 글 · 채널의 질문에서 뺐다(lib/gapActions.ts). 처치로 쓸지는 「글 더 만들기」에서 고른다(작성자 배정
            // 기간에는 고르지 않아 처치 · 대조를 말하지 않는다 — 실증이 남은 옛 판 주를 볼 때다). 본 글이 없는 주에는 그 칸이 본 글 카드
            // 아래에 없으니 여기 둔다(고를 실증이 있을 때만 — 응답 없는 실증은 이미 맡은 것뿐이다).
            <section>
              <details className="gap-more">
                <summary>실증 질문 {probeList.length}개 · 점수 제외 · 본 글에 넣지 않음</summary>
                <p className="hint" style={{ marginTop: 0 }}>
                  {probeSectionHint(activePlan?.activeUntil ?? null)}
                </p>
                <ul className="gap-worst">
                  {probeList.map((q) => (
                    <li key={q.questionId}>
                      <span className="gap-q">{q.text}</span>{' '}
                      <span className="muted">
                        · 이번 주 {q.verdict ? VERDICT_WORD[q.verdict] : '응답 없음(확인 불가)'}
                        {probeTakenNote(q.takers, activePlan !== null)}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
              {formSlot === 'probes' && extras.available && extraForm(null)}
            </section>
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
                  <ActionCard key={a.id} action={a} focused={focusId === a.id} canSaveStatus={canSaveStatus} onStatus={setStatus} tenantId={tenant.tenantId} briefs={briefs} onBrief={onBrief} drafts={drafts} onDraft={onDraft} posts={cardPosts} weekOf={weekOf} coveredBy={null} locked={pageLocked} />
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
                  <ActionCard key={a.id} action={a} focused={focusId === a.id} canSaveStatus={canSaveStatus} onStatus={setStatus} tenantId={tenant.tenantId} briefs={briefs} onBrief={onBrief} drafts={drafts} onDraft={onDraft} posts={cardPosts} weekOf={weekOf} coveredBy={null} locked={pageLocked} />
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
              {idle.length > 0 && (
                <li>
                  이번 주 덮는 밀린 질문이 없는 곳 <b>{idle.length}곳</b> — 글이 답하는 밀린 질문에서는 인용되지 않았습니다(우리가
                  밀리지 않은 질문이나 카테고리 무관이 아닌 질문에서만 인용). 올려도 이번 주 덮는 질문이 없어 뺐고, 다음 측정에서 밀린
                  질문이 이곳을 인용하면 목록에 다시 나옵니다: {idle.map((a) => channelNameOf(a)).join(' · ')}
                </li>
              )}
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
