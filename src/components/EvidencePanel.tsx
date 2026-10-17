import { useState } from 'react'
import { loadRawAnswers, updateDraftEvidence, type RawAnswer, type StoredDraft } from '../lib/api'
import { evidenceLabel, evidencePublishable, kstDate, MEDICAL_INDUSTRY, renderEvidenceMarkdown, type EvidenceItem } from '../lib/answerEvidence'
import { weekLabel } from '../lib/format'
import { markdownToHtml } from '../lib/htmlFile'

/**
 * 글 확인 화면의 「실측 답변」 — 이 글이 다루는 질문으로 실제 AI 답변에서 우리 이름이 나온 문장을 찾는다
 * (src/lib/answerEvidence.ts · server/articleEvidence.ts). 판정 · 글쓰기 호출 없이 저장된 측정 기록만 본다.
 *
 * 사람이 원문 전체를 열어 대조하고 「원문과 맞습니다」를 눌러야 발행본에 들어간다 — 판정 모델이 고른 「언급」에는
 * 틀린 것이 섞이고(조건부 지목 · 다른 곳 오인), AI 답변을 옮기는 일은 한 글자도 틀리면 안 된다.
 */
export default function EvidencePanel({
  tenantId,
  stored,
  questionIds,
  weekOf,
  industry,
  onStored,
}: {
  tenantId: string
  stored: StoredDraft
  /** 이 글(실행 항목)이 다루는 질문. */
  questionIds: string[]
  /** 지금 보는 주차 — 실행 항목을 만든 측정. */
  weekOf: string
  industry: string
  onStored: (s: StoredDraft) => void
}) {
  const ev = stored.evidence
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 원문을 펼친 응답(키 `엔진|질문|회차`)과 불러온 원문. */
  const [openRaw, setOpenRaw] = useState<string | null>(null)
  const [raw, setRaw] = useState<Record<string, RawAnswer | null>>({})

  const run = async (op: 'build' | 'confirm' | 'include' | 'exclude') => {
    setBusy(op)
    setError(null)
    try {
      onStored(
        await updateDraftEvidence(tenantId, {
          actionId: stored.actionId,
          op,
          ...(op === 'build' ? { questionIds, weekOf } : {}),
        }),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const keyOf = (it: EvidenceItem) => `${it.engine}|${it.questionId}|${it.callIndex}`
  const toggleRaw = async (it: EvidenceItem) => {
    const key = keyOf(it)
    if (openRaw === key) {
      setOpenRaw(null)
      return
    }
    setOpenRaw(key)
    if (key in raw || !ev) return
    const answers = await loadRawAnswers(tenantId, ev.weekOf, it.questionId)
    setRaw((prev) => ({ ...prev, [key]: answers?.find((a) => a.engine === it.engine && a.callIndex === it.callIndex) ?? null }))
  }

  const medical = MEDICAL_INDUSTRY.test(industry)
  const publishable = evidencePublishable(ev)

  return (
    <section className="evidence-panel">
      <h4>
        실측 답변 <span className="muted">— 저장된 측정 기록에서 고릅니다(판정 호출 없음){ev ? ` · ${weekLabel(ev.weekOf)}` : ''}</span>
      </h4>
      {!ev && (
        <>
          <p className="hint" style={{ marginTop: 0 }}>
            이 글이 다루는 질문을 실제로 AI에 물은 답변에서, 우리 이름이 나온 문장을 원문 그대로 찾습니다. 숫자 · 경쟁사 이름 ·
            조건부 지목(「~을 말씀하시는 것이라면」)이 든 문장은 고르지 않습니다.
          </p>
          <div className="brief-bar">
            <button type="button" disabled={busy !== null} onClick={() => void run('build')}>
              {busy === 'build' ? '찾는 중…' : '실측 답변 찾기'}
            </button>
          </div>
        </>
      )}
      {ev && ev.items.length === 0 && <p className="hint">{ev.emptyReason ?? '옮길 수 있는 문장이 없습니다.'}</p>}
      {ev?.items.map((it) => (
        <div key={keyOf(it)} className="evidence-item">
          <b>{evidenceLabel(it)}</b>
          <blockquote>{it.excerpt}</blockquote>
          <p className="doc-meta">
            질문: 「{it.questionText}」{it.named && ' · 이름을 넣어 물은 질문'} ·{' '}
            <button type="button" className="link-btn" aria-expanded={openRaw === keyOf(it)} onClick={() => void toggleRaw(it)}>
              {openRaw === keyOf(it) ? '원문 접기' : '원문 전체 보기'}
            </button>
          </p>
          {openRaw === keyOf(it) && (
            <pre className="evidence-raw">
              {keyOf(it) in raw ? (raw[keyOf(it)]?.rawText ?? '원문을 찾지 못했습니다(그 주를 다시 쟀으면 원문이 바뀌었을 수 있습니다).') : '불러오는 중…'}
            </pre>
          )}
        </div>
      ))}
      {ev && (
        <div className="brief-bar">
          {ev.items.length > 0 &&
            (ev.confirmedAt ? (
              <span className="article-state is-ok">✓ 원문과 대조함 · {kstDate(ev.confirmedAt)}</span>
            ) : (
              <>
                <span className="article-state">확인 전 — 발행본에 넣지 않습니다</span>
                <button type="button" disabled={busy !== null} onClick={() => void run('confirm')} title="원문 전체를 열어 발췌가 원문과 같은지 본 뒤 누르세요">
                  {busy === 'confirm' ? '저장 중…' : '원문과 맞습니다'}
                </button>
              </>
            ))}
          {ev.items.length > 0 && (
            <label className="evidence-include">
              <input
                type="checkbox"
                checked={ev.include}
                disabled={busy !== null}
                onChange={(e) => void run(e.target.checked ? 'include' : 'exclude')}
              />{' '}
              발행본에 넣기
            </label>
          )}
          <button type="button" className="ghost" disabled={busy !== null} onClick={() => void run('build')} title="다시 고르면 원문 대조를 다시 받습니다">
            {busy === 'build' ? '찾는 중…' : '다시 찾기'}
          </button>
        </div>
      )}
      {medical && ev && ev.items.length > 0 && (
        <p className="hint warn">
          의료 업종은 실측 사례를 기본으로 넣지 않습니다(제3자 추천 · 비교 광고 규정). 규정을 확인한 뒤 「발행본에 넣기」를 켜세요.
        </p>
      )}
      {publishable && (
        <details className="draft-audit">
          <summary>발행본에 붙는 모양</summary>
          {/* markdownToHtml은 모든 글자를 이스케이프한다. */}
          <div className="channel-preview" dangerouslySetInnerHTML={{ __html: markdownToHtml(renderEvidenceMarkdown(ev)) }} />
        </details>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
