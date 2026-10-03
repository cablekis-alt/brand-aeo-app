import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { brandPattern, type AnswerHighlight, type CitationChip } from '../lib/answerInsights'

const OWNER_SHORT: Record<CitationChip['ownerType'], string> = {
  'brand-owned': '자사',
  'competitor-owned': '경쟁사',
  'third-party-authority': '제3자',
  'third-party-ugc': '이용자 글',
  unknown: '알 수 없음',
}
const OWNER_TONE: Record<CitationChip['ownerType'], string> = {
  'brand-owned': 'good',
  'competitor-owned': 'bad',
  'third-party-authority': 'info',
  'third-party-ugc': '',
  unknown: '',
}
const CHIPS_SHOWN = 5

/** 문장에서 브랜드 이름에 형광 표시를 한다. 이름 표기 차이(쉼표 뒤 공백 등)는 brandPattern이 흡수한다. */
function highlight(text: string, brandName: string): ReactNode[] {
  const re = brandPattern(brandName)
  if (!re) return [text]
  const out: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    out.push(<mark key={at}>{m[0]}</mark>)
    last = at + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** 브랜드 이름에 형광 표시를 한 문장 — AI 답변 화면의 엔진별 칸도 같이 쓴다. */
export function BrandText({ text, brandName }: { text: string; brandName: string }) {
  return <>{highlight(text, brandName)}</>
}

/**
 * 「AI는 이렇게 답했습니다」 카드 — 실제 답변에서 브랜드가 나온 문장과, 그 답변이 붙인 출처를 소유·뒷받침으로
 * 나눠 보인다. 개요와 AI 답변 화면이 같이 쓴다. 문장은 판정 기록의 언급 문장 그대로다(마크다운 기호만 걷는다).
 */
export default function AnswerCard({ answer, brandName, to }: { answer: AnswerHighlight; brandName: string; to?: string }) {
  const shown = answer.citations.slice(0, CHIPS_SHOWN)
  const rest = answer.citationCount - shown.reduce((s, c) => s + c.count, 0)
  return (
    <article className="answer-card">
      <div className="answer-tags">
        <span className="engine-chip">
          <span className="engine-dot" data-engine={answer.engine} aria-hidden="true" />
          {answer.engineLabel}
        </span>
        <span className={`chip ${answer.rank === 1 ? 'good' : answer.rank ? 'info' : ''}`}>
          {answer.rank === 1 ? '1순위 추천' : answer.rank ? `${answer.rank}순위` : '추천 순서 없음'}
        </span>
        {answer.divergence && <span className="chip warn">{answer.divergence}</span>}
      </div>
      <p className="answer-question">“{answer.questionText}”</p>
      <blockquote className="answer-quote">
        {answer.sentences.map((s, i) => (
          <span key={i}>
            {i > 0 && ' … '}
            {highlight(s, brandName)}
          </span>
        ))}
      </blockquote>
      {answer.citationCount > 0 && (
        <div className="answer-cites" aria-label={`이 답변이 붙인 출처 ${answer.citationCount}건`}>
          {shown.map((c) => (
            <span key={c.domain} className={`cite-chip ${OWNER_TONE[c.ownerType]}`}>
              {c.domain} · {OWNER_SHORT[c.ownerType]}
              {c.supports ? ' · 뒷받침' : ''}
              {c.count > 1 ? ` ×${c.count}` : ''}
            </span>
          ))}
          {rest > 0 && <span className="cite-chip">외 {rest}건</span>}
        </div>
      )}
      {to && (
        <Link to={to} className="dash-link">
          이 질문의 엔진별 답변 보기 →
        </Link>
      )}
    </article>
  )
}
