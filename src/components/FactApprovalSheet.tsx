import { useState } from 'react'
import type { GapFactHit } from '../prompts/b5f-fact-for-gaps'
import { MEDICAL_INDUSTRY } from '../lib/answerEvidence'
import { preChecked } from '../lib/factApproval'

const TYPE_LABEL: Record<GapFactHit['type'], string> = {
  price: '가격',
  spec: '사양',
  date: '날짜',
  certification: '인증',
  location: '위치',
  other: '기타',
}

/**
 * 초안 쓰기 전 승인 시트 — 브리프가 「확인 필요」로 남긴 사실을 브랜드 페이지에서 찾은 값(src/lib/factApproval.ts).
 * 체크한 값만 브랜드 사실에 들어가고, 초안은 그 자리를 빈칸 대신 문장으로 쓴다. 값은 페이지에 글자 그대로 있던 것만 온다.
 * 가격 · 인증(의료 업종은 숫자가 든 값 모두)은 처음에 꺼 두어 하나씩 확인하게 한다.
 */
export default function FactApprovalSheet({
  hits,
  sourceUrl,
  dropped,
  industry,
  busy,
  onApprove,
  onSkip,
}: {
  hits: GapFactHit[]
  sourceUrl: string
  /** 가드가 끊은 값과 이유 — 조용히 지우지 않는다. */
  dropped: string[]
  industry: string
  busy: boolean
  onApprove: (approved: GapFactHit[]) => void
  onSkip: () => void
}) {
  const [checked, setChecked] = useState<Set<number>>(() => new Set(hits.flatMap((h, i) => (preChecked(h, industry) ? [i] : []))))
  const toggle = (i: number) =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  const held = hits.filter((h) => !preChecked(h, industry)).length

  return (
    <section className="fact-sheet" aria-label="브랜드 페이지에서 찾은 사실">
      <h4>
        초안 쓰기 전에 — 브랜드 페이지에서 찾은 사실 {hits.length}개{' '}
        <span className="muted">
          (
          <a href={sourceUrl} target="_blank" rel="noreferrer">
            읽은 페이지
          </a>
          )
        </span>
      </h4>
      <p className="hint" style={{ marginTop: 0 }}>
        체크한 값만 브랜드 사실에 넣고, 초안은 그 자리를 빈칸 대신 문장으로 씁니다. 값은 페이지에 글자 그대로 있던 것만 보여 줍니다.
        {held > 0 && ` 가격 · 인증${MEDICAL_INDUSTRY.test(industry) ? ' · 숫자가 든 값' : ''}은 페이지에서 직접 확인한 뒤 체크하세요.`}
      </p>
      <ul className="fact-sheet-list">
        {hits.map((h, i) => (
          <li key={`${h.claim}|${h.value}`}>
            <label>
              <input type="checkbox" checked={checked.has(i)} disabled={busy} onChange={() => toggle(i)} />{' '}
              <span className="draft-role">{TYPE_LABEL[h.type] ?? '기타'}</span> {h.claim}: <b>{h.value}</b>
            </label>
            {h.sourceUrl && h.sourceUrl !== sourceUrl && (
              <>
                {' '}
                <a className="doc-meta" href={h.sourceUrl} target="_blank" rel="noreferrer">
                  출처
                </a>
              </>
            )}
          </li>
        ))}
      </ul>
      {dropped.length > 0 && (
        <details className="draft-audit">
          <summary>페이지에 그대로 없어서 뺀 값 {dropped.length}개</summary>
          <ul className="muted">
            {dropped.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="brief-bar">
        <button type="button" disabled={busy} onClick={() => onApprove(hits.filter((_, i) => checked.has(i)))}>
          {checked.size > 0 ? `체크한 사실 ${checked.size}개 저장하고 초안 쓰기` : '저장 없이 초안 쓰기'}
        </button>
        <button type="button" className="ghost" disabled={busy} onClick={onSkip}>
          건너뛰고 초안 쓰기
        </button>
      </div>
    </section>
  )
}
