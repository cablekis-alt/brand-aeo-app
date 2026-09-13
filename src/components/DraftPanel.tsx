import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  findFactsForGaps,
  generateContentDraft,
  loadFactGraph,
  saveContentDraft,
  saveFactGraph,
  type FactNode,
  type GapFactHit,
  type StoredDraft,
} from '../lib/api'
import type { GapAction } from '../lib/gapActions'

/**
 * 초안 패널 — 실행 항목에서도, 질문 은행에서도 쓴다.
 *
 * 두 화면이 같은 부품을 쓰는 이유: 측정 전에 질문을 골라 쓰는 글과 측정 후 실행 항목에서 쓰는
 * 글은 **만드는 방식이 같다**. 다른 것은 질문을 어디서 고르느냐뿐이다. 두 벌로 두면 빈칸
 * 채우기 같은 기능이 한쪽에만 생긴다.
 */
/**
 * 마크다운을 .md 파일로 내려받는다.
 *
 * 복사만 있으면 붙여 넣을 창이 열려 있을 때만 쓸모가 있다. 팀원에게 넘기거나 보관하려면
 * 파일이 필요하고, 클립보드 접근이 막힌 환경에서는 복사 자체가 실패한다(그때 대안이 없었다).
 * 문자열은 이미 만들고 있으므로 저장만 붙인다.
 */
export function downloadMarkdown(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 즉시 해제하면 브라우저가 저장을 시작하기 전에 사라질 수 있다.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 파일 이름에 쓸 수 없는 글자를 덜어낸다. 한글·숫자·점·하이픈은 남긴다. */
export function safeFileName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '-').slice(0, 60)
}

/** 초안을 마크다운으로. 빈 자리는 표시를 남긴 채 내보낸다 — 지우면 채울 곳을 잃는다. */
export function draftToMarkdown(d: StoredDraft['draft']): string {
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

/**
 * 브랜드 페이지 조회 결과 — 입력칸에 미리 채워 넣고, 어디서 온 값인지 옆에 적는다.
 * 입력 자체는 이것과 무관하게 늘 가능하다(조회는 거들 뿐이다).
 */
interface GapLookup {
  byNeed: Record<string, GapFactHit>
  missing: string[]
  sourceUrl: string
  dropped: string[]
}

export default function DraftPanel({
  tenantId,
  action,
  hasBrief,
  stored,
  onStored,
  ensureBrief,
}: {
  tenantId: string
  action: GapAction
  hasBrief: boolean
  stored: StoredDraft | undefined
  onStored: (s: StoredDraft) => void
  /** 브리프가 없으면 먼저 만든다. 초안 한 번 누르기로 여기까지 간다. */
  ensureBrief: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  // 빈칸 채우기 — 초안이 비워 둔 자리를 이 화면 안에서 끝낸다.
  const [filling, setFilling] = useState(false)
  // 빈칸에 적어 넣는 값. need → 값. 초안 본문의 빈칸 자리에 그대로 입력칸이 붙는다 —
  // 문제와 해결책이 다른 자리에 있으면 사람이 눈을 왔다 갔다 해야 한다.
  const [typed, setTyped] = useState<Record<string, string>>({})
  const [lookup, setLookup] = useState<GapLookup | null>(null)
  const make = async (force: boolean) => {
    // 다시 만들면 손댄 글이 사라진다. 조용히 덮지 않는다.
    if (force && stored?.editedMarkdown && !window.confirm('다시 만들면 고쳐 둔 글이 사라집니다. 계속할까요?')) return
    setBusy(true)
    setError(null)
    try {
      // 브리프는 초안을 잘 쓰기 위한 발판이지 사람이 읽으려고 만드는 물건이 아니다. 두 번
      // 누르게 하면 그 사이에 사람이 하는 판단이 없는데도 기다림만 두 번 생긴다.
      // 없으면 여기서 만들고 이어서 초안까지 간다. 브리프는 따로 접혀 남아 볼 사람은 본다.
      if (!hasBrief) await ensureBrief()
      const s = await generateContentDraft(tenantId, { actionId: action.id, targetDomain: action.targetDomain }, force)
      onStored(s)
      setEditing(false)
      setOpen(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const startEdit = () => {
    if (!stored) return
    setText(stored.editedMarkdown ?? draftToMarkdown(stored.draft))
    setEditing(true)
    setOpen(true)
  }
  const save = async () => {
    if (!stored) return
    setSaving(true)
    setError(null)
    try {
      onStored(await saveContentDraft(tenantId, action.id, text))
      setEditing(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }
  /** 빈칸의 need 목록 — 초안이 "무엇이 필요한가"를 이미 적어 두었다. */
  const needsOf = (draft: StoredDraft['draft']): string[] =>
    draft.sections.flatMap((sec) => sec.blocks.filter((b) => b.kind === 'gap').map((b) => b.need ?? '')).filter(Boolean)

  /** 브랜드 페이지를 읽어 빈칸을 메워 본다. 찾은 것은 후보로만 두고, 사람이 넣어야 저장된다. */
  const lookUp = async () => {
    if (!stored) return
    const needs = needsOf(stored.draft)
    if (!needs.length) return
    setFilling(true)
    setError(null)
    try {
      const r = await findFactsForGaps(tenantId, needs)
      setLookup({
        byNeed: Object.fromEntries(r.found.map((f) => [f.need, f])),
        missing: r.missing,
        sourceUrl: r.sourceUrl,
        dropped: r.dropped,
      })
      // 찾은 값은 입력칸에 미리 채운다. 사람이 그대로 두거나 고칠 수 있게 — 읽기만 되는
      // 표로 보여 주면 "맞다/틀리다"를 말할 자리가 없다.
      setTyped((prev) => ({ ...prev, ...Object.fromEntries(r.found.map((f) => [f.need, f.value])) }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setFilling(false)
    }
  }

  /**
   * 고른 사실을 팩트 그래프에 넣고 초안을 다시 쓴다.
   *
   * 두 걸음을 하나로 묶는 이유: 사실만 저장하고 끝내면 사람이 "다시 만들기"를 또 눌러야 하고,
   * 안 누르면 초안은 그대로 빈칸이다. 빈칸을 메우는 목적이 초안을 끝내는 것이므로 여기까지가
   * 한 동작이다.
   */
  const applyFacts = async (
    picked: Array<{ type: FactNode['type']; claim: string; value: string; sourceUrl?: string }>,
  ) => {
    if (!picked.length) return
    setFilling(true)
    setError(null)
    try {
      const current = (await loadFactGraph(tenantId))?.factGraph ?? []
      const merged = [...current, ...picked.map((p) => ({ id: '', updatedAt: '', ...p }) as FactNode)]
      await saveFactGraph(tenantId, merged)
      setTyped({})
      setLookup(null)
      await make(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setFilling(false)
    }
  }
  const copy = async () => {
    if (!stored) return
    try {
      await navigator.clipboard.writeText(stored.editedMarkdown ?? draftToMarkdown(stored.draft))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('클립보드에 복사하지 못했습니다.')
    }
  }
  // 브리프가 없어도 버튼은 남긴다. 숨기면 "초안이라는 단계가 있다"는 사실 자체가 안 보인다 —
  // 실측: 실행 항목 id가 사이트 묶음으로 바뀌자 브리프가 어느 항목에도 안 붙었고, 그 순간
  // 초안 기능이 화면에서 통째로 사라졌다. 대신 누를 수 없게 두고 무엇이 먼저인지 말한다.
  const d = stored?.draft
  return (
    <div className="brief">
      <div className="brief-bar">
        {!stored ? (
          <>
            <button
              type="button"
              className="ghost"
              onClick={() => void make(false)}
              disabled={busy}
              title={hasBrief ? '브리프를 바탕으로 초안을 씁니다' : '브리프를 만든 뒤 이어서 초안까지 씁니다'}
            >
              {busy
                ? hasBrief
                  ? '초안 쓰는 중…'
                  : '브리프부터 쓰는 중…'
                : hasBrief
                  ? '초안 만들기 (판정 1회)'
                  : '초안 만들기 (브리프까지, 판정 2회)'}
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              {open ? '초안 접기' : '초안 보기'}
            </button>
            <button type="button" className="ghost" onClick={() => void copy()}>
              {copied ? '복사됨' : '마크다운 복사'}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() =>
                downloadMarkdown(
                  `초안-${safeFileName(action.title)}-${stored.generatedAt.slice(0, 10)}.md`,
                  stored.editedMarkdown ?? draftToMarkdown(stored.draft),
                )
              }
            >
              .md 내려받기
            </button>
            <button type="button" className="ghost" onClick={editing ? () => setEditing(false) : startEdit}>
              {editing ? '편집 닫기' : '편집'}
            </button>
            <button type="button" className="ghost" onClick={() => void make(true)} disabled={busy}>
              {busy ? '다시 쓰는 중…' : '다시 만들기'}
            </button>
            {stored.editedMarkdown && <span className="st st-info">고침 {stored.editedAt?.slice(0, 10)}</span>}
            {d && d.gapCount > 0 && !stored.editedMarkdown && (
              // 딱지 자체가 버튼이다 — 문제를 알리는 자리와 여는 자리가 같아야 한다.
              <button
                type="button"
                className="st st-warn"
                style={{ cursor: 'pointer', border: 0 }}
                title="초안을 열어 빈칸에 값을 적습니다"
                onClick={() => setOpen(true)}
              >
                채울 곳 {d.gapCount} — 채우기
              </button>
            )}
            <span className="doc-meta">{stored.generatedAt.slice(0, 10)} 생성</span>
          </>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {open && editing && stored && (
        <div className="brief-body">
          <p className="hint" style={{ marginTop: 0 }}>
            마크다운으로 고칩니다. 저장할 때 <b>사실 확인</b>을 한 번 돌려, 팩트 그래프에 없는 숫자가 있으면
            알려 드립니다. 막지는 않습니다 — 직접 확인하신 사실일 수 있습니다. 다만 그런 숫자는{' '}
            <Link to="/brand-facts">브랜드 사실</Link>에 넣어 두시면 다음 초안부터 자동으로 들어갑니다.
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={18}
            style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: 13, lineHeight: 1.6 }}
          />
          <div className="brief-bar">
            <button type="button" onClick={() => void save()} disabled={saving || !text.trim()}>
              {saving ? '저장 중…' : '저장'}
            </button>
            <button type="button" className="ghost" onClick={() => setEditing(false)} disabled={saving}>
              취소
            </button>
            {stored.editedMarkdown && (
              <button
                type="button"
                className="ghost"
                onClick={() => setText(draftToMarkdown(stored.draft))}
                disabled={saving}
              >
                생성된 원본으로 되돌리기
              </button>
            )}
          </div>
        </div>
      )}
      {open && !editing && stored?.editWarnings && stored.editWarnings.length > 0 && (
        <div className="brief-body">
          <section>
            <h4>
              사실 확인 <span className="muted">(고친 글에서 찾은 것 — 막지 않았습니다)</span>
            </h4>
            <ul className="muted">
              {stored.editWarnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
            <p className="gap-tally">
              직접 확인하신 값이면 <Link to="/brand-facts">브랜드 사실</Link>에 넣어 두세요. 그러면 다음
              초안부터 본문에 자동으로 들어가고, 이 경고도 사라집니다.
            </p>
          </section>
        </div>
      )}
      {open && !editing && stored?.editedMarkdown && (
        <div className="brief-body">
          <p className="hint" style={{ marginTop: 0 }}>
            고쳐 둔 글입니다({stored.editedAt?.slice(0, 10)} 저장). 복사·내려받기·묶음 내보내기 모두 이 글을 씁니다.
          </p>
          <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{stored.editedMarkdown}</pre>
        </div>
      )}
      {open && !editing && !stored?.editedMarkdown && d && (
        <div className="brief-body">
          <p className="hint" style={{ marginTop: 0 }}>
            발행용 원고가 아니라 <b>사람이 이어받을 원고</b>입니다. 사실이 없어 쓸 수 없던 자리는 문장을
            지어내지 않고 비워 두었습니다.{' '}
            {d.gapCount > 0 ? `${d.gapCount}곳을 채우면 완성됩니다 — 아래 빈칸에 바로 적으세요.` : '비운 자리는 없습니다.'}
          </p>
          {d.gapCount > 0 && (
            <div className="facts-bar" style={{ marginBottom: 10 }}>
              <button type="button" className="ghost" disabled={filling || busy} onClick={() => void lookUp()}>
                {filling ? '페이지 읽는 중…' : '브랜드 페이지에서 찾아보기'}
              </button>
              <button
                type="button"
                disabled={filling || busy || !Object.values(typed).some((v) => v.trim())}
                onClick={() =>
                  void applyFacts(
                    Object.entries(typed)
                      .filter(([, v]) => v.trim())
                      .map(([need, v]) => {
                        const hit = lookup?.byNeed[need]
                        // 조회로 찾은 값을 그대로 두었으면 그때의 항목 이름·출처를 쓴다.
                        return hit && hit.value === v.trim()
                          ? { type: hit.type, claim: hit.claim, value: hit.value, sourceUrl: hit.sourceUrl }
                          : { type: 'other' as FactNode['type'], claim: need, value: v.trim() }
                      }),
                  )
                }
              >
                {filling || busy ? '반영하는 중…' : '사실로 저장하고 초안 다시 쓰기'}
              </button>
              {lookup && (
                <span className="doc-meta">
                  <a href={lookup.sourceUrl} target="_blank" rel="noreferrer">
                    페이지
                  </a>
                  에서 {Object.keys(lookup.byNeed).length}곳을 찾았습니다
                </span>
              )}
            </div>
          )}
          {lookup && lookup.dropped.length > 0 && (
            <ul className="doc-meta" style={{ marginTop: 0 }}>
              {lookup.dropped.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          )}
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
                  // 빈칸이 곧 입력 자리다. 빨간 글씨만 남기면 "나가서 찾아오라"는 말이 된다.
                  <div key={i} style={{ margin: '8px 0' }}>
                    <label className="error" htmlFor={`gap-${action.id}-${sec.heading}-${i}`}>
                      채워야 함 · {b.need}
                    </label>
                    <input
                      id={`gap-${action.id}-${sec.heading}-${i}`}
                      type="text"
                      value={typed[b.need ?? ''] ?? ''}
                      // 안내문에 **그 브랜드에 그럴듯하게 들어맞는 값**을 쓰면 안 된다. 실측:
                      // "예: 도보 8분 · 180,000원 · 자쿠지 없음"을 그대로 넣은 사람이 있었고,
                      // 지어낸 숫자 3건이 팩트 그래프에 확인된 사실로 들어갔다. 형식만 보인다.
                      placeholder="확인하신 값만 적으세요 (숫자·시각·금액처럼 대조 가능한 것)"
                      style={{ width: '100%', marginTop: 4 }}
                      onChange={(e) => setTyped((prev) => ({ ...prev, [b.need ?? '']: e.target.value }))}
                    />
                    {lookup?.byNeed[b.need ?? ''] && (
                      <span className="doc-meta">브랜드 페이지에서 찾은 값입니다 — 맞으면 그대로 두세요.</span>
                    )}
                    {lookup && lookup.missing.includes(b.need ?? '') && (
                      <span className="doc-meta">브랜드 페이지에는 없었습니다.</span>
                    )}
                  </div>
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
