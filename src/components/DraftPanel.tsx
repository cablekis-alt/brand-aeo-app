import { useEffect, useRef, useState, type ReactNode } from 'react'
import ChannelTabs from './ChannelTabs'
import { Link } from 'react-router-dom'
import {
  findFactsForGaps,
  generateContentDraft,
  loadFactGraph,
  saveContentDraft,
  saveDraftGaps,
  saveFactGraph,
  type FactNode,
  type GapFactHit,
  type ChannelAdaptation,
  type GapFill,
  type StoredDraft,
} from '../lib/api'
import { copyRich } from '../lib/clipboard'
import { claimOf, effectiveDraft, filledLine, gapKey, gapProgress, publishMarkdownOf, workMarkdownOf } from '../lib/draftGaps'
import type { GapAction } from '../lib/gapActions'
import { buildPublishHtml, publishBodyHtml } from '../lib/htmlFile'
import { useTenant } from '../context/useTenant'
import { countGapNotes, downloadHtml, downloadMarkdown, draftToMarkdown, safeFileName } from '../lib/markdownFile'

/**
 * 초안 패널 — 글 한 편을 세 걸음으로 끝낸다: ① 초안 → ② 빈칸 확인 → ③ 올리기.
 *
 * 본문을 통째로 지어내지 않는다. 사실이 있어야 쓸 수 있는 문단인데 그 사실이 없으면 비워 두고 "무엇이
 * 필요한가"를 적어 온다. 그 빈칸을 **본문 안에서 바로** 채우게 하는 것이 이 화면의 일이다.
 *
 * 예전 흐름은 값을 적고 「사실로 저장하고 초안 다시 쓰기」를 눌러 글 전체를 다시 썼다(판정 1~2회, 1~2분).
 * 이제 값은 그 자리에 「항목: 값」 한 줄로 들어가고(lib/draftGaps.ts), 브랜드 사실에도 함께 저장된다.
 * 모르는 값은 「이 문장 빼기」 — 발행본에서 그 자리만 빠진다. 기록은 서버에 남아 화면을 떠나도 그대로다.
 *
 * 내보내기는 「이 글 복사」 하나가 기본이다(서식째 — 블로그 편집기에 붙여도 제목·굵은 글씨가 남는다).
 * 파일(.md·.html·작업용)은 「파일로 받기」에 접어 둔다. 단추가 일곱 개일 때 무엇을 눌러야 할지 몰랐다.
 */

type Step = 'gaps' | 'publish'

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

export default function DraftPanel({
  tenantId,
  action,
  hasBrief,
  stored,
  onStored,
  ensureBrief,
  compact = false,
  channels = null,
  publishedCount = 0,
  publish,
  adaptations = null,
  onAdapted,
  channelSlot,
}: {
  tenantId: string
  action: GapAction
  hasBrief: boolean
  stored: StoredDraft | undefined
  onStored: (s: StoredDraft) => void
  /** 브리프가 없으면 먼저 만든다. 초안 한 번 누르기로 여기까지 간다. */
  ensureBrief: () => Promise<void>
  /**
   * 운영자용 손잡이(편집·다시 만들기·생성일)를 숨긴다. 카드의 「자세히」가 되살린다 — 숨길 뿐 지우지 않는다.
   * 세 걸음(초안·빈칸·올리기)은 숨기지 않는다. 그게 이 화면의 본론이다.
   */
  compact?: boolean
  /** 이 글을 올릴 외부 채널 항목(콘텐츠형). 있으면 ③ 올리기가 채널 탭이 된다. */
  channels?: GapAction[] | null
  /** 이 항목에 기록된 「올린 글 주소」 수 — ③ 단계 표시. */
  publishedCount?: number
  /** ③ 올리기 칸(자사 사이트)에 들어갈 주소 기록 부품. 상태를 저장할 수 없는 환경이면 없다. */
  publish?: ReactNode
  /** 채널별 다듬은 글. null이면 다듬기 라우트가 없는 환경이다. */
  adaptations?: Record<string, ChannelAdaptation> | null
  onAdapted?: (a: ChannelAdaptation) => void
  /** 채널 항목의 주소 기록 부품. */
  channelSlot?: (a: GapAction) => ReactNode
}) {
  // 발행용 .html의 JSON-LD(Organization)에 브랜드 이름·도메인을 넣기 위해. tenantId만으로는 이름을 모른다.
  const { tenant } = useTenant()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState<Step | null>(null)
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
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

  // 기다리는 동안 지난 시간 — "보통 1~2분" 옆에 실제로 얼마나 지났는지 보인다.
  const startedAt = useRef(0)
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!busy) return
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

  const make = async (force: boolean) => {
    // 다시 만들면 손댄 글과 채운 빈칸 기록이 사라진다. 조용히 덮지 않는다.
    if (
      force &&
      (stored?.editedMarkdown || (stored?.gapFills && Object.keys(stored.gapFills).length)) &&
      !window.confirm('다시 만들면 고쳐 둔 글과 채운 빈칸 기록이 사라집니다(넣은 값은 브랜드 사실에 남아 새 초안에 들어갑니다). 계속할까요?')
    )
      return
    startedAt.current = Date.now()
    setElapsed(0)
    setBusy(true)
    setError(null)
    try {
      // 브리프는 초안을 잘 쓰기 위한 발판이지 사람이 읽으려고 만드는 물건이 아니다. 두 번
      // 누르게 하면 그 사이에 사람이 하는 판단이 없는데도 기다림만 두 번 생긴다.
      if (!hasBrief) await ensureBrief()
      const s = await generateContentDraft(tenantId, { actionId: action.id, targetDomain: action.targetDomain }, force)
      onStored(s)
      setEditing(false)
      setTyped({})
      setHits({})
      setMissed(new Set())
      setStep(gapProgress(s).total > 0 ? 'gaps' : 'publish')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
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

  /** 「이 글 복사」 — 서식째(lib/clipboard.ts). 남은 빈칸 줄은 빠진 발행본이다. */
  const copyPublish = async () => {
    if (!stored) return
    if (await copyRich(publishMarkdownOf(stored), publishBodyHtml(stored))) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } else {
      setError('클립보드에 복사하지 못했습니다. 「파일로 받기」를 써 주세요.')
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
            {busy ? `초안 쓰는 중… ${clock(elapsed)} · 보통 1~2분` : '초안 만들기 · 약 1~2분'}
          </button>
          {busy && <span className="doc-meta">기다리는 동안 다른 글을 계속 다룰 수 있습니다.</span>}
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    )
  }

  const upCount = (publishedCount > 0 ? 1 : 0) + (channels ?? []).filter((c) => c.publishedUrls.length > 0 || c.status === 'done').length
  const progress = gapProgress(stored)
  const left = progress.total - progress.done
  const d = effectiveDraft(stored)
  const toggle = (s: Step) => setStep((cur) => (cur === s ? null : s))
  const steps: Array<{ key: Step | 'draft'; n: number; label: string; sub: string; done: boolean }> = [
    { key: 'draft', n: 1, label: '초안', sub: `완료 · ${stored.generatedAt.slice(0, 10)}`, done: true },
    {
      key: 'gaps',
      n: 2,
      label: '빈칸 확인',
      sub: progress.edited
        ? left > 0
          ? `고친 글에 빈칸 ${left}줄 남음`
          : '빈칸 없음'
        : progress.total === 0
          ? '빈칸 없음'
          : `${progress.total}곳 중 ${progress.done}곳 처리${progress.suggested ? ` · 찾은 값 ${progress.suggested}` : ''}`,
      done: left === 0,
    },
    {
      key: 'publish',
      n: 3,
      label: '올리기',
      sub: channels?.length
        ? `${channels.length + 1}곳 중 ${upCount}곳 올림`
        : publishedCount > 0
          ? `올린 주소 ${publishedCount}개`
          : '자사 사이트',
      done: channels?.length ? upCount === channels.length + 1 : publishedCount > 0,
    },
  ]

  // ③ 올리기의 자사 사이트 칸 — 원문 복사·주소 기록·파일. 채널이 있으면 채널 탭의 첫 탭이 된다.
  const ownSite = (
    <>
          <div className="draft-copy">
            <button type="button" className="draft-copy-btn" onClick={() => void copyPublish()}>
              {copied ? '복사했습니다' : '이 글 복사'}
            </button>
            <p className="doc-meta">
              서식째 복사합니다 — 네이버 블로그·티스토리 편집기에 붙여도 제목·굵은 글씨가 남습니다.
              {(() => {
                const n = stored.editedMarkdown ? countGapNotes(stored.editedMarkdown) : left
                return n > 0 ? ` 아직 채우지 않은 빈칸 ${n}곳은 빼고 복사합니다.` : ''
              })()}
            </p>
          </div>
          {publish}
          <details className="draft-files">
            <summary>파일로 받기</summary>
            <div className="brief-bar">
              <button
                type="button"
                className="ghost"
                title="빈칸 표시와 「이 글이 쓴 사실」을 뺀 원고입니다."
                onClick={() =>
                  downloadMarkdown(`발행용-${safeFileName(action.title)}-${stored.generatedAt.slice(0, 10)}.md`, publishMarkdownOf(stored))
                }
              >
                발행용 .md
              </button>
              <button
                type="button"
                className="ghost"
                title="자체 사이트·CMS용 완성 HTML — <head>에 JSON-LD(Article·Organization)를 심습니다. 네이버 블로그·티스토리는 <head>를 버리므로 그때는 「이 글 복사」를 쓰세요."
                onClick={() => {
                  if (!tenant) return
                  void loadFactGraph(tenantId)
                    .then((fg) => fg?.factGraph ?? [])
                    .catch((e: unknown) => {
                      console.error('[DraftPanel] 브랜드 사실을 읽지 못해 Organization 없이 만듭니다', e)
                      return [] as FactNode[]
                    })
                    .then((facts) =>
                      downloadHtml(
                        `발행용-${safeFileName(action.title)}-${stored.generatedAt.slice(0, 10)}.html`,
                        buildPublishHtml({ stored, brand: tenant, facts }),
                      ),
                    )
                }}
              >
                자사 사이트용 .html
              </button>
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
    </>
  )

  return (
    <div className="brief draft-flow">
      <div className="draft-steps" role="group" aria-label={`${action.title} 진행 단계`}>
        {steps.map((s) =>
          s.key === 'draft' ? (
            <div key={s.key} className="draft-step done">
              <span className="draft-step-dot" aria-hidden="true">
                ✓
              </span>
              <span className="draft-step-text">
                <span className="draft-step-label">{s.label}</span>
                <span className="draft-step-sub">{s.sub}</span>
              </span>
            </div>
          ) : (
            <button
              key={s.key}
              type="button"
              className={`draft-step${s.done ? ' done' : ''}${step === s.key ? ' on' : ''}`}
              aria-expanded={step === s.key}
              onClick={() => toggle(s.key as Step)}
            >
              <span className="draft-step-dot" aria-hidden="true">
                {s.done ? '✓' : s.n}
              </span>
              <span className="draft-step-text">
                <span className="draft-step-label">{s.label}</span>
                <span className="draft-step-sub">{s.sub}</span>
              </span>
            </button>
          ),
        )}
      </div>

      {step === null && (
        // 접힌 카드에서도 다음에 할 일 하나는 바로 누를 수 있게 둔다.
        <div className="brief-bar">
          {left > 0 && !progress.edited ? (
            <button type="button" onClick={() => setStep('gaps')}>
              빈칸 {left}곳 확인하기
            </button>
          ) : (
            <>
              <button type="button" onClick={() => void copyPublish()}>
                {copied ? '복사했습니다' : '이 글 복사'}
              </button>
              <button type="button" className="ghost" onClick={() => setStep('publish')}>
                올리기 · 주소 기록
              </button>
            </>
          )}
        </div>
      )}

      {!compact && (
        <div className="brief-bar draft-tools">
          <button type="button" className="ghost" onClick={editing ? closeEdit : startEdit}>
            {editing ? '편집 닫기' : '본문 편집'}
          </button>
          <button type="button" className="ghost" onClick={() => void make(true)} disabled={busy}>
            {busy ? `다시 쓰는 중… ${clock(elapsed)}` : '다시 만들기'}
          </button>
          {stored.editedMarkdown && <span className="st st-info">고침 {stored.editedAt?.slice(0, 10)}</span>}
          <span className="doc-meta">{stored.generatedAt.slice(0, 10)} 생성</span>
        </div>
      )}

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
            </div>
          )}
          {dropped.length > 0 && (
            <ul className="doc-meta" style={{ marginTop: 0 }}>
              {dropped.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          )}
          <h4 className="draft-title">{d.title}</h4>
          {d.lead && <p>{d.lead}</p>}
          {stored.draft.sections.map((sec, si) => (
            <section key={`${si}-${sec.heading}`}>
              <h4>{sec.heading}</h4>
              {sec.blocks.map((b, bi) => {
                if (b.kind !== 'gap') return <p key={bi}>{b.body}</p>
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
              <button type="button" onClick={() => setStep('publish')}>
                빈칸 확인 끝 — 올리기로
              </button>
            </div>
          )}
        </div>
      )}

      {step === 'publish' && (
        <div className="brief-body draft-publish">
          {channels && channels.length > 0 && onAdapted && channelSlot ? (
            <ChannelTabs
              tenantId={tenantId}
              contentActionId={action.id}
              stored={stored}
              channels={channels}
              adaptations={adaptations}
              onAdapted={onAdapted}
              ownSite={ownSite}
              ownPublished={publishedCount > 0}
              channelSlot={channelSlot}
            />
          ) : (
            ownSite
          )}
        </div>
      )}
    </div>
  )
}
