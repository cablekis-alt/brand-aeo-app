import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  findFactsForGaps,
  generateContentDraft,
  loadContentBriefs,
  loadFactGraph,
  loadPublishSettings,
  saveContentDraft,
  saveDraftGaps,
  saveFactGraph,
  type FactNode,
  type GapFactHit,
  type GapFill,
  type StoredDraft,
} from '../lib/api'
import { claimOf, draftRequestOf, effectiveDraft, filledLine, gapKey, gapProgress, publishMarkdownOf, workMarkdownOf } from '../lib/draftGaps'
import type { GapAction } from '../lib/gapActions'
import { buildPublishHtml } from '../lib/htmlFile'
import EvidencePanel from './EvidencePanel'
import SitePhotoPanel from './SitePhotoPanel'
import { matchPhotos, normSlotAlt } from '../lib/articlePhotos'
import { articlePhotoFiles, downloadArticlePhotos } from '../lib/sitePhotos'
import FactApprovalSheet from './FactApprovalSheet'
import { mergeApproved, needsFromBrief, reconcileHits, unansweredNeeds, type SheetHit } from '../lib/factApproval'
import { publishArticleOf } from '../lib/publishArticle'
import { useTenant } from '../context/useTenant'
import { countGapNotes, downloadHtml, downloadMarkdown, draftTitle, draftToMarkdown, safeFileName } from '../lib/markdownFile'
import { articleSources } from '../lib/officialSources'
import type { DraftRole } from '../prompts/b9c-content-draft'

/** 블로그 글 형식 문단의 구실 — 확인 화면에서 문단 앞에 붙는 꼬리표. 핵심 문장은 굵게 보여 꼬리표를 달지 않는다. */
const ROLE_LABEL: Partial<Record<DraftRole, string>> = { action: '할 일', why: '이유', quote: '그대로 쓸 말', limit: '한계' }

/**
 * 초안 패널 — 콘텐츠 생성 「① 글 확인」의 글 카드 본문. 초안을 만들고 빈칸을 확인한다.
 *
 * 올리기는 여기 없다 — 「② 올리기 목록」(PublishList.tsx)이 글과 채널을 한 줄씩 편다. 예전에는 카드마다
 * ③ 올리기 단계와 채널 탭이 있어, 같은 채널이 아래 「채널별 올림 현황」과 두 번 나왔다(상용화 UI 8차 시안).
 * 빈칸을 모두 처리하면 그 글은 「확인됨」이고, 올리기 목록에서 그 글의 줄이 열린다(lib/publishPlan.ts).
 *
 * 본문을 통째로 지어내지 않는다. 사실이 있어야 쓸 수 있는 문단인데 그 사실이 없으면 비워 두고 "무엇이
 * 필요한가"를 적어 온다. 그 빈칸을 **본문 안에서 바로** 채우게 하는 것이 이 화면의 일이다.
 *
 * 예전 흐름은 값을 적고 「사실로 저장하고 초안 다시 쓰기」를 눌러 글 전체를 다시 썼다(판정 1~2회, 1~2분).
 * 이제 값은 그 자리에 「항목: 값」 한 줄로 들어가고(lib/draftGaps.ts), 브랜드 사실에도 함께 저장된다.
 * 모르는 값은 「이 문장 빼기」 — 발행본에서 그 자리만 빠진다. 기록은 서버에 남아 화면을 떠나도 그대로다.
 *
 * 파일(.md·.html·작업용)은 「자세히」의 「파일로 받기」에 접어 둔다. 복사는 올리기 목록의 줄이 한다.
 */

type Step = 'gaps'

/**
 * 저장하지 않은 편집 — 이 PC(localStorage)에 몇 초마다 보관한다. 서버 「저장」은 사실 확인(판정 호출)을 돌려서
 * 자동으로 부르지 않는다. 그 대신 화면을 떠나도 편집이 사라지지 않게 여기 둔다(다시 열면 「이어서 편집」).
 * 보관이 안 되는 환경(사생활 모드 등)이면 경고만 남기고 지나간다 — 편집 자체는 막지 않는다.
 */
interface PendingEdit {
  text: string
  at: string
}
function readPending(key: string): PendingEdit | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as PendingEdit) : null
  } catch (e) {
    console.warn('[DraftPanel] 보관한 편집을 읽지 못했습니다', e)
    return null
  }
}
function writePending(key: string, value: PendingEdit | null): void {
  try {
    if (value) localStorage.setItem(key, JSON.stringify(value))
    else localStorage.removeItem(key)
  } catch (e) {
    console.warn('[DraftPanel] 편집을 보관하지 못했습니다', e)
  }
}
const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
/** 블로그 글 형식 발행본이 이보다 짧으면 알린다(목표는 2,500~3,500자 — b9c 규칙 8). */
const SHORT_ARTICLE = 1500

/** 다시 쓰면 사라지는 손댄 상태 — 승인 시트를 연 뒤 달라졌는지 볼 때 쓴다. */
const editStampOf = (s: StoredDraft | undefined): string =>
  s ? JSON.stringify([s.generatedAt, s.editedMarkdown ?? '', s.gapFills ?? {}, s.photos ?? []]) : ''

export default function DraftPanel({
  tenantId,
  action,
  hasBrief,
  stored,
  onStored,
  ensureBrief,
  compact = false,
  weekOf,
  publishHint = '아래 올리기 목록에서 올리세요',
}: {
  tenantId: string
  action: GapAction
  hasBrief: boolean
  stored: StoredDraft | undefined
  onStored: (s: StoredDraft) => void
  /** 브리프가 없으면 먼저 만든다. 초안 한 번 누르기로 여기까지 간다. */
  ensureBrief: () => Promise<void>
  /**
   * 운영자용 손잡이(편집·다시 만들기·파일·생성일)를 숨긴다. 카드의 「자세히」가 되살린다 — 숨길 뿐 지우지 않는다.
   */
  compact?: boolean
  /** 이 글(실행 항목)을 만든 측정 주차 — 있으면 「실측 답변」 칸을 연다(측정 전 글쓰기 화면에는 없다). */
  weekOf?: string
  /**
   * 빈칸을 다 처리한 뒤의 안내 — 어디서 올리는지. 기본은 콘텐츠 생성의 「② 올리기 목록」이다. 그 목록이 없는 화면(질문 은행)은
   * 자기 화면의 주소 칸을 가리킨다.
   */
  publishHint?: string
}) {
  // 발행용 .html의 JSON-LD(Organization)에 브랜드 이름·도메인을 넣기 위해. tenantId만으로는 이름을 모른다.
  const { tenant } = useTenant()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState<Step | null>(null)
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [photoBusy, setPhotoBusy] = useState(false)
  // 빈칸 입력 중인 값(키 `절:블록`) — 「넣기」를 누를 때 서버에 남는다.
  const [typed, setTyped] = useState<Record<string, string>>({})
  /** 빈칸별로 찾아볼 주소. 비어 있으면 브랜드 페이지(없으면 소유 도메인 루트)를 쓴다. */
  const [urlByKey, setUrlByKey] = useState<Record<string, string>>({})
  /** 조회 중 — 'all'이면 한 번에 찾기, 키면 그 칸 하나. */
  const [looking, setLooking] = useState<string | null>(null)
  /** 조회 결과의 항목 이름·종류 — 「맞아요」로 브랜드 사실에 넣을 때 그대로 쓴다(화면을 떠나면 사라져도 된다). */
  const [hits, setHits] = useState<Record<string, GapFactHit>>({})
  /** 조회했지만 그 페이지에 없던 칸. */
  const [missed, setMissed] = useState<Set<string>>(new Set())
  const [dropped, setDropped] = useState<string[]>([])
  // 브랜드 사실 저장은 한 줄로 세운다 — 「맞아요」를 연달아 누르면 읽고-쓰기가 겹쳐 앞 값이 사라진다.
  const factChain = useRef<Promise<unknown>>(Promise.resolve())
  /**
   * 초안 쓰기 전 승인 시트 — 브리프가 「확인 필요」로 남긴 사실을 브랜드 페이지에서 찾은 값(src/lib/factApproval.ts).
   * force는 시트를 닫은 뒤 쓸 초안이 「다시 만들기」인지. actionId · stamp는 시트를 연 글과 그때의 고친 상태 — 시트는 기다리는
   * 동안 열려 있어서(질문 고르기가 바뀌거나, 한꺼번에 만들기가 초안을 쓰거나, 아래 초안을 고칠 수 있다) 닫을 때 다시 맞춰 본다.
   */
  const [prefill, setPrefill] = useState<
    { hits: SheetHit[]; sourceUrl: string; dropped: string[]; force: boolean; actionId: string; stamp: string } | null
  >(null)
  /** 사실 찾기 결과 한 줄 — 못 찾았거나 페이지를 못 읽었거나 넣은 개수. */
  const [prefillNote, setPrefillNote] = useState<string | null>(null)
  /** 기다리는 일 — 브랜드 페이지에서 사실 찾기 / 초안 쓰기. 버튼 글자가 달라진다. */
  const [busyKind, setBusyKind] = useState<'facts' | 'draft'>('draft')

  // 기다리는 동안 지난 시간 — "보통 1~2분" 옆에 실제로 얼마나 지났는지 보인다.
  const startedAt = useRef(0)
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!busy) return
    // 기다리기 시작한 시각은 여기서 잡는다 — 초안 만들기 · 승인 시트 둘 다 busy를 켜면 시작이다.
    startedAt.current = Date.now()
    const id = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 1000)
    return () => window.clearInterval(id)
  }, [busy])

  const editKey = `brand-aeo-draft-edit:${tenantId}:${action.id}`
  const [pending, setPending] = useState<PendingEdit | null>(() => readPending(editKey))
  const saveTimer = useRef<number | undefined>(undefined)
  const editText = (value: string) => {
    setText(value)
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => writePending(editKey, { text: value, at: new Date().toISOString() }), 1200)
  }
  const dropPending = () => {
    window.clearTimeout(saveTimer.current)
    writePending(editKey, null)
    setPending(null)
  }
  const closeEdit = () => {
    if (stored && text !== workMarkdownOf(stored) && !window.confirm('저장하지 않은 편집을 버릴까요?')) return
    dropPending()
    setEditing(false)
  }

  // 다시 만들면 손댄 글 · 채운 빈칸 기록 · 고른 홈페이지 사진이 사라진다. 조용히 덮지 않는다.
  const confirmOverwrite = () =>
    !(stored?.editedMarkdown || (stored?.gapFills && Object.keys(stored.gapFills).length) || stored?.photos?.length) ||
    window.confirm(
      '다시 만들면 고쳐 둔 글 · 채운 빈칸 기록 · 고른 홈페이지 사진이 사라집니다(넣은 값은 브랜드 사실에 남아 새 초안에 들어갑니다). 계속할까요?',
    )
  const make = async (force: boolean) => {
    if (force && !confirmOverwrite()) return
    setElapsed(0)
    setBusy(true)
    setError(null)
    setPrefill(null)
    setPrefillNote(null)
    try {
      // 브리프는 초안을 잘 쓰기 위한 발판이지 사람이 읽으려고 만드는 물건이 아니다. 두 번
      // 누르게 하면 그 사이에 사람이 하는 판단이 없는데도 기다림만 두 번 생긴다.
      if (!hasBrief) await ensureBrief()
      // 초안 쓰기 전에 브리프가 「확인 필요」로 남긴 사실을 브랜드 페이지에서 찾는다 — 찾으면 승인 시트를 띄우고 여기서 멈춘다.
      // 실측: 초안을 다 쓴 뒤 빈칸마다 값을 찾아 넣은 곳이 79곳 중 0곳이었다.
      const found = await findBriefFacts()
      if (found) {
        setPrefill({ ...found, force, actionId: action.id, stamp: editStampOf(stored) })
        return
      }
      await writeDraft(force)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setBusyKind('draft')
    }
  }
  /** 브리프의 「확인 필요」 사실을 브랜드 페이지에서 찾는다(판정 1회). 못 찾거나 페이지를 못 읽으면 null — 초안은 예전처럼 빈칸으로 쓴다. */
  const findBriefFacts = async (): Promise<{ hits: SheetHit[]; sourceUrl: string; dropped: string[] } | null> => {
    const briefs = await loadContentBriefs(tenantId)
    const asked = needsFromBrief(briefs?.[action.id]?.brief.doNotClaim ?? [])
    if (!asked.length) return null
    setBusyKind('facts')
    try {
      // 지금 브랜드 사실과 맞춰 본다 — 브리프는 다시 만들지 않아서, 빈칸에 넣거나 시트에서 넣은 사실도 「확인 필요」로 남아 있다.
      // 이미 답이 있는 항목은 다시 묻지 않고, 같은 항목의 다른 값은 덧붙이지 않고 바꿀지 묻는다(src/lib/factApproval.ts).
      const graph = await loadFactGraph(tenantId)
      if (!graph) throw new Error('지금 브랜드 사실을 읽지 못했습니다.')
      const needs = unansweredNeeds(asked, graph.factGraph)
      if (!needs.length) return null
      const r = await findFactsForGaps(tenantId, needs)
      const hits = reconcileHits(r.found, graph.factGraph)
      if (!hits.length) {
        // 「빈칸으로 남는다」고 하지 않는다 — 브랜드 사실에 이미 있던 값이면 초안이 그 자리를 문장으로 쓴다.
        setPrefillNote(`브랜드 페이지에서 확인 필요 사실 ${needs.length}개를 찾아봤지만 새로 넣을 값이 없었습니다.`)
        return null
      }
      return { hits, sourceUrl: r.sourceUrl, dropped: r.dropped }
    } catch (e) {
      // 페이지를 못 읽어도 초안은 쓴다(예전처럼 빈칸으로). 이유는 화면에 남긴다.
      console.warn('[DraftPanel] 브랜드 페이지에서 사실을 찾지 못했습니다', e)
      setPrefillNote(`브랜드 페이지에서 사실을 찾지 못해 건너뛰었습니다 — ${e instanceof Error ? e.message : String(e)}`)
      return null
    } finally {
      setBusyKind('draft')
    }
  }
  const writeDraft = async (force: boolean) => {
    const s = await generateContentDraft(tenantId, draftRequestOf(action), force)
    onStored(s)
    setEditing(false)
    setTyped({})
    setHits({})
    setMissed(new Set())
    setStep(gapProgress(s).total > 0 ? 'gaps' : null)
  }
  /** 승인 시트의 결정 — 체크한 값을 브랜드 사실에 넣고(빈 배열이면 저장 없이) 초안을 쓴다. 저장이 실패하면 시트를 남기고 알린다. */
  const finishPrefill = async (approved: SheetHit[]) => {
    if (!prefill) return
    // 시트를 연 글이 아니면(질문 고르기를 바꿨다) 버린다 — 다른 글에 초안을 쓰거나 그 글의 확인 창을 건너뛰지 않는다.
    if (prefill.actionId !== action.id) {
      setPrefill(null)
      return
    }
    // 시트가 떠 있는 동안 초안이 생겼으면(한꺼번에 만들기) 승인한 값을 넣으려면 다시 써야 한다 — 그냥 쓰면 서버가 그 초안을 돌려준다.
    const force = prefill.force || (approved.length > 0 && Boolean(stored))
    // 시트를 보는 동안 고친 글 · 빈칸 기록도 묻지 않고 덮지 않는다. 「다시 만들기」에서 이미 물은 상태 그대로면 다시 묻지 않는다.
    if (force && editStampOf(stored) !== prefill.stamp && !confirmOverwrite()) return
    setElapsed(0)
    setBusy(true)
    setError(null)
    try {
      if (approved.length) {
        // 「맞아요」 저장과 같은 줄에 세운다 — 읽고-쓰기가 겹쳐 앞 값이 사라지지 않게. 지금 사실을 읽지 못하면 저장하지 않는다
        // (빈 목록에 덧붙여 저장하면 있던 사실이 사라진다).
        const saveFacts = factChain.current.then(async () => {
          const current = await loadFactGraph(tenantId)
          if (!current) throw new Error('지금 브랜드 사실을 읽지 못해 저장하지 않았습니다. 다시 시도하거나 「건너뛰고 초안 쓰기」를 누르세요.')
          await saveFactGraph(tenantId, mergeApproved(current.factGraph, approved))
        })
        factChain.current = saveFacts.catch(() => undefined)
        await saveFacts
        setPrefillNote(`브랜드 사실 ${approved.length}개를 넣었습니다. 초안이 그 자리를 문장으로 씁니다.`)
      }
      setPrefill(null)
      await writeDraft(force)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const busyLabel = (draftLabel: string) => (busyKind === 'facts' ? `브랜드 페이지에서 사실 찾는 중… ${clock(elapsed)}` : draftLabel)
  const prefillView = (
    <>
      {prefill && prefill.actionId === action.id && tenant && (
        <FactApprovalSheet
          key={`${prefill.sourceUrl}|${prefill.hits.length}`}
          hits={prefill.hits}
          sourceUrl={prefill.sourceUrl}
          dropped={prefill.dropped}
          industry={tenant.industry}
          busy={busy}
          onApprove={(approved) => void finishPrefill(approved)}
          onSkip={() => void finishPrefill([])}
          onCancel={() => setPrefill(null)}
        />
      )}
      {prefillNote && <p className="doc-meta">{prefillNote}</p>}
    </>
  )
  const startEdit = () => {
    if (!stored) return
    setText(workMarkdownOf(stored))
    setEditing(true)
    setStep('gaps')
  }
  const save = async () => {
    if (!stored) return
    setSaving(true)
    setError(null)
    try {
      onStored(await saveContentDraft(tenantId, action.id, text))
      dropPending()
      setEditing(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  /** 빈칸 기록 저장 — 화면에 먼저 반영하고(기다리게 하지 않는다), 실패하면 되돌리고 말한다. */
  const persistFills = async (next: Record<string, GapFill>) => {
    if (!stored) return
    const before = stored
    onStored({ ...stored, gapFills: next })
    try {
      onStored(await saveDraftGaps(tenantId, action.id, next))
    } catch (e) {
      onStored(before)
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const fills = stored?.gapFills ?? {}

  /** 확인한 값을 브랜드 사실에도 넣는다 — 다음 초안부터는 빈칸이 아니라 문장으로 쓰인다. */
  const rememberFact = (need: string, value: string, hit: GapFactHit | undefined, sourceUrl?: string) => {
    // 조회 결과(항목 이름·종류)는 화면을 떠나면 사라진다. 그때도 저장해 둔 후보의 출처 주소는 남긴다.
    const fact = hit && hit.value === value
      ? { type: hit.type, claim: hit.claim, value: hit.value, sourceUrl: hit.sourceUrl }
      : { type: 'other' as FactNode['type'], claim: claimOf(need), value, ...(sourceUrl ? { sourceUrl } : {}) }
    factChain.current = factChain.current
      .then(async () => {
        const current = (await loadFactGraph(tenantId))?.factGraph ?? []
        if (current.some((f) => f.claim === fact.claim && f.value === fact.value)) return
        await saveFactGraph(tenantId, [...current, { id: '', updatedAt: '', ...fact } as FactNode])
      })
      .catch((e: unknown) => {
        console.error('[DraftPanel] 브랜드 사실 저장 실패', e)
        setError('값은 글에 넣었지만 브랜드 사실에 저장하지 못했습니다. 브랜드 사실 화면에서 직접 넣어 주세요.')
      })
  }
  const confirmGap = (key: string, need: string, value: string) => {
    const v = value.trim()
    if (!v) return
    const prev = fills[key]
    void persistFills({ ...fills, [key]: { value: v } })
    rememberFact(need, v, hits[key], prev?.suggested === v ? prev.sourceUrl : undefined)
    setTyped((prev) => ({ ...prev, [key]: '' }))
  }
  const omitGap = (key: string) => void persistFills({ ...fills, [key]: { omit: true } })
  /**
   * 남은 빈칸을 모두 뺀다 — 값을 넣은 칸은 그대로 두고, 아직 처리하지 않은 칸만 「빼기」로(찾아 둔 후보는 남겨 둔다).
   * 실측: 빈칸 79곳 중 값을 넣은 곳이 0곳이고 29곳을 한 칸씩 「빼기」로 처리했다. 뺀 칸은 하나씩 「되돌리기」할 수 있다.
   */
  const omitAll = () => {
    const open = openGaps()
    if (!open.length) return
    // 찾아 둔 값(노란 후보)이 있는 칸도 함께 빠진다 — 「맞아요」로 넣을 기회를 조용히 없애지 않게 미리 알린다.
    const withCandidate = open.filter(([k]) => fills[k]?.suggested).length
    const candidateNote = withCandidate ? ` 찾아 둔 값이 있는 칸 ${withCandidate}곳도 함께 빠집니다 — 그 값을 넣으려면 취소하고 「맞아요」를 누르세요.` : ''
    if (
      !window.confirm(
        `남은 빈칸 ${open.length}곳을 모두 빼고 이 글을 확인됨으로 둘까요? 발행본에서 그 자리만 빠집니다. 뺀 칸은 하나씩 「되돌리기」로 다시 열 수 있습니다.${candidateNote}`,
      )
    )
      return
    const next = { ...fills }
    for (const [k] of open) next[k] = { ...next[k], omit: true }
    void persistFills(next)
  }
  const undoGap = (key: string) => {
    const next = { ...fills }
    delete next[key]
    void persistFills(next)
  }

  /** 아직 처리하지 않은 빈칸(키 → need). */
  const openGaps = (): Array<[string, string]> => {
    if (!stored) return []
    const out: Array<[string, string]> = []
    stored.draft.sections.forEach((sec, si) =>
      sec.blocks.forEach((b, bi) => {
        const k = gapKey(si, bi)
        if (b.kind === 'gap' && !fills[k]?.value && !fills[k]?.omit) out.push([k, b.need ?? ''])
      }),
    )
    return out
  }

  /**
   * 페이지를 읽어 빈칸 후보를 찾는다(판정 1회). 찾은 값은 노란 후보로만 두고, 「맞아요」를 눌러야 글에 들어간다.
   *
   * onlyKey를 주면 그 칸 하나만, 그 칸에 적힌 주소로 찾는다. 빈칸마다 값이 있는 페이지가 다르기
   * 때문이다 — 주소 하나로 전부 찾으려 하면 대개 0건이 나온다(실측: 원진성형외과 루트에서 4건 전부 실패,
   * 페이지를 짚으니 1건 성공).
   */
  const lookUp = async (onlyKey?: string) => {
    if (!stored) return
    const targets = openGaps().filter(([k]) => !onlyKey || k === onlyKey)
    if (!targets.length) return
    const needs = [...new Set(targets.map(([, n]) => n))]
    const url = onlyKey ? urlByKey[onlyKey]?.trim() : undefined
    setLooking(onlyKey ?? 'all')
    setError(null)
    try {
      const r = await findFactsForGaps(tenantId, needs, url || undefined)
      const byNeed = new Map(r.found.map((f) => [f.need, f]))
      const next = { ...fills }
      const nextHits = { ...hits }
      const nextMissed = new Set(missed)
      for (const [k, need] of targets) {
        const hit = byNeed.get(need)
        if (hit) {
          next[k] = { ...next[k], suggested: hit.value, ...(hit.sourceUrl ? { sourceUrl: hit.sourceUrl } : {}) }
          nextHits[k] = hit
          nextMissed.delete(k)
        } else nextMissed.add(k)
      }
      setHits(nextHits)
      setMissed(nextMissed)
      setDropped(r.dropped)
      await persistFills(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLooking(null)
    }
  }

  // 브리프가 없어도 버튼은 남긴다. 숨기면 "초안이라는 단계가 있다"는 사실 자체가 안 보인다 —
  // 실측: 실행 항목 id가 사이트 묶음으로 바뀌자 브리프가 어느 항목에도 안 붙었고, 그 순간
  // 초안 기능이 화면에서 통째로 사라졌다.
  if (!stored) {
    return (
      <div className="brief">
        <div className="brief-bar">
          <button
            type="button"
            className="ghost"
            onClick={() => void make(false)}
            disabled={busy}
            // 판정 호출 수는 운영자용 정보라 손끝 설명에 둔다. 단추에는 기다릴 시간을 적는다.
            title={hasBrief ? '브리프를 바탕으로 초안을 씁니다(판정 1~2회)' : '브리프를 만든 뒤 이어서 초안까지 씁니다(판정 2~4회)'}
          >
            {busy ? busyLabel(`초안 쓰는 중… ${clock(elapsed)} · 보통 1~2분`) : '초안 만들기 · 약 1~2분'}
          </button>
          {busy && <span className="doc-meta">기다리는 동안 다른 글을 계속 다룰 수 있습니다.</span>}
        </div>
        {prefillView}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    )
  }

  const progress = gapProgress(stored)
  const left = progress.total - progress.done
  // 빈칸을 모두 처리한 블로그 글이 너무 짧으면 알린다 — 빈칸을 한꺼번에 빼면 글이 짧아지기 쉽다.
  const publishLength = left === 0 && stored.draft.format === 'article' ? publishMarkdownOf(stored).length : 0
  const d = effectiveDraft(stored)
  /** 절마다 발행본에 붙을 공식 출처(블로그 글 형식만) — 빈칸을 채운 글 기준, 절 순서는 stored.draft와 같다. */
  const sources = articleSources(d)
  const opened = step === 'gaps'
  // 사진 자리에 들어갈 홈페이지 사진 — 구조 화면의 자리는 장면 글자 + 소제목으로 찾는다(발행본의 절 번호는 빈 절을 빼면 바뀐다).
  const placedPhotos = matchPhotos(publishMarkdownOf(stored), stored.photos ?? []).applied
  const photoFiles = articlePhotoFiles(stored)
  const photoFor = (heading: string, alt: string) =>
    placedPhotos.find((a) => a.slot.key === normSlotAlt(alt) && a.slot.heading === normSlotAlt(heading))?.pick

  return (
    <div className="brief draft-flow">
      {/* 접힌 카드는 제목 · 첫 문단 · 확인 상태만 — 무슨 글인지 알고, 할 일이 하나 보이면 된다. */}
      <div className="article-summary">
        {!opened && (
          <>
            <h4 className="draft-title">{draftTitle(d)}</h4>
            {d.lead && <p className="article-lead">{d.lead}</p>}
          </>
        )}
        <div className="brief-bar">
          <span className={`article-state${left === 0 ? ' is-ok' : ''}`}>
            {left === 0
              ? `✓ 확인됨 — ${publishHint}`
              : progress.edited
                ? `고친 글에 빈칸 ${left}줄 남음`
                : `확인할 빈칸 ${left}곳${progress.suggested ? ` · 찾은 값 ${progress.suggested}` : ''}`}
          </span>
          <button type="button" className={left > 0 && !opened ? undefined : 'ghost'} aria-expanded={opened} onClick={() => setStep(opened ? null : 'gaps')}>
            {opened ? '접기' : left > 0 && !progress.edited ? `빈칸 ${left}곳 확인하기` : '전체 보기'}
          </button>
        </div>
        {publishLength > 0 && publishLength < SHORT_ARTICLE && (
          <p className="hint warn">
            발행본이 약 {publishLength.toLocaleString()}자로 짧습니다. <Link to="/brand-facts">브랜드 사실</Link>을 더 넣고 「다시
            만들기」를 하면 빈칸 대신 문장으로 채워집니다.
          </p>
        )}
      </div>

      {!compact && (
        <div className="brief-bar draft-tools">
          <button type="button" className="ghost" onClick={editing ? closeEdit : startEdit}>
            {editing ? '편집 닫기' : '본문 편집'}
          </button>
          <button type="button" className="ghost" onClick={() => void make(true)} disabled={busy}>
            {busy ? busyLabel(`다시 쓰는 중… ${clock(elapsed)}`) : '다시 만들기'}
          </button>
          {stored.editedMarkdown && <span className="st st-info">고침 {stored.editedAt?.slice(0, 10)}</span>}
          <span className="doc-meta">{stored.generatedAt.slice(0, 10)} 생성</span>
          <details className="draft-files">
            <summary>파일로 받기</summary>
            <div className="brief-bar">
              <button
                type="button"
                className="ghost"
                title="빈칸 표시와 「이 글이 쓴 사실」을 뺀 원고입니다."
                onClick={() => {
                  const file = `발행용-${safeFileName(action.title)}-${stored.generatedAt.slice(0, 10)}.md`
                  if (!tenant) {
                    downloadMarkdown(file, publishMarkdownOf(stored))
                    return
                  }
                  void loadPublishSettings(tenantId).then((settings) =>
                    downloadMarkdown(file, publishArticleOf(stored, { brand: tenant, settings })),
                  )
                }}
              >
                발행용 .md
              </button>
              <button
                type="button"
                className="ghost"
                title="자체 사이트·CMS용 완성 HTML — <head>에 JSON-LD(Article·Organization)를 심습니다. 네이버 블로그·티스토리는 <head>를 버리므로 그때는 올리기 목록의 「복사하기」를 쓰세요."
                onClick={() => {
                  if (!tenant) return
                  const facts = loadFactGraph(tenantId)
                    .then((fg) => fg?.factGraph ?? [])
                    .catch((e: unknown) => {
                      console.error('[DraftPanel] 브랜드 사실을 읽지 못해 Organization 없이 만듭니다', e)
                      return [] as FactNode[]
                    })
                  void Promise.all([facts, loadPublishSettings(tenantId)]).then(([factList, settings]) =>
                    downloadHtml(
                      `발행용-${safeFileName(action.title)}-${stored.generatedAt.slice(0, 10)}.html`,
                      buildPublishHtml({ stored, brand: tenant, facts: factList, settings }),
                    ),
                  )
                }}
              >
                자사 사이트용 .html
              </button>
              {photoFiles.length > 0 && (
                <button
                  type="button"
                  className="ghost"
                  disabled={photoBusy}
                  title="고른 홈페이지 사진 파일 — 블로그에 붙여 넣은 글에서 사진이 안 보이면 이 파일을 그 자리에 올리세요(파일 이름에 소제목)."
                  onClick={() => {
                    setPhotoBusy(true)
                    setError(null)
                    downloadArticlePhotos(tenantId, stored, photoFiles)
                      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                      .finally(() => setPhotoBusy(false))
                  }}
                >
                  {photoBusy ? '사진 받는 중…' : `사진 ${photoFiles.length}장 받기`}
                </button>
              )}
              <button
                type="button"
                className="ghost"
                title="남은 빈칸 표시와 「이 글이 쓴 사실」까지 담은 작업용 원고입니다."
                onClick={() =>
                  downloadMarkdown(`초안-${safeFileName(action.title)}-${stored.generatedAt.slice(0, 10)}.md`, workMarkdownOf(stored))
                }
              >
                작업용 .md
              </button>
            </div>
          </details>
        </div>
      )}

      {prefillView}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {pending && !editing && (
        <p className="draft-pending" role="status">
          저장하지 않은 편집이 있습니다(
          {new Date(pending.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}).{' '}
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setText(pending.text)
              setEditing(true)
              setStep('gaps')
            }}
          >
            이어서 편집
          </button>{' '}
          ·{' '}
          <button type="button" className="link-btn" onClick={dropPending}>
            버리기
          </button>
        </p>
      )}

      {step === 'gaps' && editing && (
        <div className="brief-body">
          <p className="hint" style={{ marginTop: 0 }}>
            마크다운으로 고칩니다. 저장할 때 <b>사실 확인</b>을 한 번 돌려, 브랜드 사실에 없는 숫자가 있으면 알려
            드립니다. 막지는 않습니다 — 직접 확인하신 사실일 수 있습니다. 그런 숫자는{' '}
            <Link to="/brand-facts">브랜드 사실</Link>에 넣어 두시면 다음 초안부터 자동으로 들어갑니다.
          </p>
          <textarea
            value={text}
            onChange={(e) => editText(e.target.value)}
            rows={18}
            style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: 13, lineHeight: 1.6 }}
          />
          <div className="brief-bar">
            <button type="button" onClick={() => void save()} disabled={saving || !text.trim()}>
              {saving ? '저장 중…' : '저장'}
            </button>
            <button type="button" className="ghost" onClick={closeEdit} disabled={saving}>
              취소
            </button>
            {stored.editedMarkdown && (
              <button
                type="button"
                className="ghost"
                onClick={() => setText(draftToMarkdown(effectiveDraft(stored)))}
                disabled={saving}
              >
                생성된 원본으로 되돌리기
              </button>
            )}
          </div>
        </div>
      )}

      {step === 'gaps' && !editing && stored.editedMarkdown && (
        <div className="brief-body">
          {stored.editWarnings && stored.editWarnings.length > 0 && (
            <section>
              <h4>
                사실 확인 <span className="muted">(고친 글에서 찾은 것 — 막지 않았습니다)</span>
              </h4>
              <ul className="muted">
                {stored.editWarnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </section>
          )}
          <p className="hint" style={{ marginTop: 0 }}>
            고쳐 둔 글입니다({stored.editedAt?.slice(0, 10)} 저장). 복사·내려받기 모두 이 글을 씁니다.
            {countGapNotes(stored.editedMarkdown) > 0 && ' 남은 빈칸 줄은 「자세히 → 본문 편집」에서 고치거나, 그대로 두면 발행본에서 빠집니다.'}
          </p>
          <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{stored.editedMarkdown}</pre>
        </div>
      )}

      {step === 'gaps' && !editing && !stored.editedMarkdown && (
        <div className="brief-body draft-doc">
          {progress.total > 0 && (
            <div className="draft-gapbar">
              <span>
                빈칸 <b>{progress.total}곳</b> 중 {progress.done}곳 처리. 값을 넣으면 그 자리에 「항목: 값」 한 줄로 들어가고
                브랜드 사실에도 저장됩니다. 모르는 값은 빼면 발행본에서 그 자리만 빠집니다.
              </span>
              {left > 0 && (
                <button
                  type="button"
                  className="ghost"
                  disabled={looking !== null}
                  title="브랜드 페이지 한 곳을 읽어 빈칸 값 후보를 찾습니다(판정 1회)"
                  onClick={() => void lookUp()}
                >
                  {looking === 'all' ? '페이지 읽는 중…' : '브랜드 페이지에서 찾아 채우기'}
                </button>
              )}
              {left > 0 && (
                <button type="button" className="ghost" disabled={looking !== null} onClick={omitAll} title="값을 모르는 칸을 한 번에 빼고 글을 확인됨으로 둡니다">
                  남은 빈칸 {left}곳 모두 빼기
                </button>
              )}
            </div>
          )}
          {dropped.length > 0 && (
            <ul className="doc-meta" style={{ marginTop: 0 }}>
              {dropped.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          )}
          <h4 className="draft-title">{draftTitle(d)}</h4>
          {d.lead && <p>{d.lead}</p>}
          {stored.draft.sections.map((sec, si) => (
            <section key={`${si}-${sec.heading}`}>
              <h4>{sec.heading}</h4>
              {sec.blocks.map((b, bi) => {
                if (b.kind !== 'gap') {
                  if (b.role === 'key') return <p key={bi} className="draft-key">{b.body}</p>
                  if (b.role === 'quote')
                    return (
                      <blockquote key={bi} className="draft-quote">
                        <span className="draft-role">{ROLE_LABEL.quote}</span> {b.body}
                      </blockquote>
                    )
                  return (
                    <p key={bi}>
                      {b.role && <span className="draft-role">{ROLE_LABEL[b.role]}</span>} {b.body}
                    </p>
                  )
                }
                const k = gapKey(si, bi)
                const f = fills[k]
                const need = b.need ?? ''
                if (f?.value) {
                  return (
                    <p key={bi} className="gap-filled">
                      {filledLine(need, f.value)}{' '}
                      <button type="button" className="link-btn" onClick={() => undoGap(k)}>
                        되돌리기
                      </button>
                    </p>
                  )
                }
                if (f?.omit) {
                  return (
                    <p key={bi} className="gap-omitted">
                      {claimOf(need)} — 발행본에서 뺌{' '}
                      <button type="button" className="link-btn" onClick={() => undoGap(k)}>
                        되돌리기
                      </button>
                    </p>
                  )
                }
                const inputId = `gap-${action.id}-${k}`
                return (
                  <div key={bi} className="gap-slot">
                    <label className="gap-need" htmlFor={inputId}>
                      채워야 함 · {claimOf(need)}
                    </label>
                    {need !== claimOf(need) && <span className="doc-meta">{need.slice(claimOf(need).length).replace(/^\s*[—–]\s*/, '')}</span>}
                    {f?.suggested && (
                      <div className="gap-suggest">
                        <span>
                          찾은 값 <b>{f.suggested}</b>
                          {f.sourceUrl && (
                            <>
                              {' · '}
                              <a href={f.sourceUrl} target="_blank" rel="noreferrer">
                                출처 페이지
                              </a>
                            </>
                          )}
                        </span>
                        <button type="button" onClick={() => confirmGap(k, need, f.suggested ?? '')}>
                          맞아요
                        </button>
                        <button type="button" className="ghost" onClick={() => setTyped((prev) => ({ ...prev, [k]: f.suggested ?? '' }))}>
                          고치기
                        </button>
                      </div>
                    )}
                    <div className="gap-input">
                      <input
                        id={inputId}
                        type="text"
                        value={typed[k] ?? ''}
                        // 안내문에 **그 브랜드에 그럴듯하게 들어맞는 값**을 쓰면 안 된다. 실측:
                        // "예: 도보 8분 · 180,000원 · 자쿠지 없음"을 그대로 넣은 사람이 있었고,
                        // 지어낸 숫자 3건이 팩트 그래프에 확인된 사실로 들어갔다. 형식만 보인다.
                        placeholder="확인하신 값만 적으세요 (숫자·시각·금액처럼 대조 가능한 것)"
                        onChange={(e) => setTyped((prev) => ({ ...prev, [k]: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            confirmGap(k, need, typed[k] ?? '')
                          }
                        }}
                      />
                      <button type="button" disabled={!(typed[k] ?? '').trim()} onClick={() => confirmGap(k, need, typed[k] ?? '')}>
                        넣기
                      </button>
                      <button type="button" className="ghost" onClick={() => omitGap(k)}>
                        모르면 이 문장 빼기
                      </button>
                    </div>
                    {missed.has(k) && !f?.suggested && (
                      <span className="doc-meta">그 페이지에는 없었습니다 — 아래에 값이 적힌 페이지 주소를 넣어 찾아보세요.</span>
                    )}
                    {/* 빈칸마다 값이 있는 페이지가 다르다. 주소 하나로 전부 찾으려 하면 대개 0건이다. */}
                    <details className="gap-url-more">
                      <summary>다른 페이지에서 찾기</summary>
                      <div className="gap-url">
                        <input
                          type="text"
                          inputMode="url"
                          aria-label={`${claimOf(need)} 값이 적힌 페이지 주소`}
                          placeholder="이 값이 적힌 페이지 주소 (비우면 브랜드 페이지)"
                          value={urlByKey[k] ?? ''}
                          onChange={(e) => setUrlByKey((prev) => ({ ...prev, [k]: e.target.value }))}
                        />
                        <button type="button" className="ghost" disabled={looking !== null} onClick={() => void lookUp(k)}>
                          {looking === k ? '읽는 중…' : '이 주소에서 찾기'}
                        </button>
                      </div>
                    </details>
                  </div>
                )
              })}
              {sec.image &&
                (() => {
                  // 사진은 사람이 찍거나 골라 올린다 — 글은 무엇을 넣을지만 제안한다(발행본에 「사진 넣을 자리」로 나간다). 홈페이지
                  // 사진을 골랐으면 그 사진이 들어간다(아래 「홈페이지 사진」).
                  const photo = photoFor(sec.heading, sec.image.alt)
                  return (
                    <figure className={`draft-image-slot${photo ? ' is-picked' : ''}`}>
                      {photo ? (
                        <img className="draft-image-photo" src={photo.src} alt={photo.alt || sec.image.alt} referrerPolicy="no-referrer" />
                      ) : null}
                      <span className="draft-role">{photo ? '홈페이지 사진' : '사진 넣을 자리'}</span> {photo ? photo.alt || sec.image.alt : sec.image.alt}
                      {sec.image.caption && <figcaption>{sec.image.caption}</figcaption>}
                    </figure>
                  )
                })()}
              {sources[si] && sources[si].length > 0 && (
                // 공식 안내 링크는 글쓰기 엔진이 아니라 확인한 고정 목록에서 코드가 붙인다(src/lib/officialSources.ts).
                <p className="doc-meta">
                  <span className="draft-role">참고</span>{' '}
                  {sources[si].map((s, i) => (
                    <span key={s.id}>
                      {i > 0 && ' · '}
                      <a href={s.url} target="_blank" rel="noreferrer">
                        {s.label}
                      </a>
                    </span>
                  ))}
                </p>
              )}
            </section>
          ))}
          {(d.usedFacts.length > 0 || (d.guardNotes && d.guardNotes.length > 0)) && (
            // 사실 대조 기록은 우리가 검증할 때 보는 것이라 접어 둔다(발행본에는 원래 실리지 않는다).
            <details className="draft-audit">
              <summary>
                사실 대조 · 쓴 사실 {d.usedFacts.length}개
                {d.guardNotes && d.guardNotes.length > 0 && ` · 검증이 걸러낸 문장 ${d.guardNotes.length}건`}
              </summary>
              {d.usedFacts.length > 0 && (
                <ul>
                  {d.usedFacts.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              )}
              {d.guardNotes && d.guardNotes.length > 0 && (
                <ul className="muted">
                  {d.guardNotes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
            </details>
          )}
          {left === 0 && progress.total > 0 && (
            <div className="brief-bar">
              <button type="button" onClick={() => setStep(null)}>
                확인 끝 — {publishHint}
              </button>
            </div>
          )}
        </div>
      )}

      {/* 실측 사례는 자사 글(content)의 발행본에만 붙는다 — 채널 전용 글(등재형)의 올리기 줄은 본문만 복사한다. */}
      {opened && !editing && weekOf && tenant && action.kind === 'content' && (
        <EvidencePanel
          tenantId={tenantId}
          stored={stored}
          questionIds={action.questionIds}
          weekOf={weekOf}
          industry={tenant.industry}
          onStored={onStored}
        />
      )}
      {/* 홈페이지 사진도 자사 글(content)의 발행본에만 들어간다. */}
      {opened && !editing && tenant && action.kind === 'content' && (
        <SitePhotoPanel tenantId={tenantId} brand={tenant} stored={stored} disabled={busy} onStored={onStored} />
      )}
    </div>
  )
}
