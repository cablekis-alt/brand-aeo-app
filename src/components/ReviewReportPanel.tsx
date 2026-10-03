import { useEffect, useMemo, useState } from 'react'
import type { WeeklyScorecard } from '../prompts/b8-report'
import { loadCitationBreakdown, loadQuestionBank, loadScorecards, type SiteScoreRecord } from '../lib/api'
import type { QuestionBank, QuestionRepeatAnalysis } from '../lib/types'
import type { PeriodicReport } from '../lib/b9-report'
import { formatRankWithCount, weekLabel } from '../lib/format'
import { downloadHtml } from '../lib/markdownFile'
import { buildReviewReport, reviewReportHtml, type CheckStatus, type ReviewReportInput } from '../lib/reviewReport'

const CHECK_PILL: Record<CheckStatus, { label: string; cls: string }> = {
  ok: { label: '확인', cls: 'st-good' },
  warn: { label: '주의', cls: 'st-warn' },
  review: { label: '사람 확인', cls: 'st-bad' },
}

type Loaded = Omit<ReviewReportInput, 'card' | 'history' | 'site' | 'periodic'>

/**
 * 검토 리포트 — 측정 신뢰도 점검과 코호트 비교를 화면에 보이고, 공유용 HTML 문서로 내려받게 한다.
 *
 * 코호트 다른 브랜드의 카드·질문 은행까지 읽어야 해서(같은 질문지를 받았는지) 정기진단 보고서 본문과
 * 따로 불러온다. 한 브랜드라도 읽지 못하면 그 브랜드는 "확인 불가"로 남긴다 — 빼고 판정하면 점검이
 * 통과한 것처럼 보인다.
 */
export default function ReviewReportPanel({
  card,
  history,
  site,
  periodic,
  selfAnalyses,
  selfBank,
}: {
  card: WeeklyScorecard
  history: WeeklyScorecard[]
  site: SiteScoreRecord | null
  periodic: PeriodicReport
  /** 정기진단 보고서가 이미 불러온 이 브랜드의 판정 기록·질문 은행 — 두 번 불러오지 않는다. */
  selfAnalyses: QuestionRepeatAnalysis[]
  selfBank: QuestionBank | null
}) {
  const key = `${card.tenantId}|${card.weekOf}`
  const [state, setState] = useState<{ key: string; data: Loaded | null; error: string | null }>({ key: '', data: null, error: null })

  useEffect(() => {
    let alive = true
    const memberIds = (card.cohortRank.members ?? []).map((m) => m.tenantId).filter((id) => id !== card.tenantId)
    const load = async (): Promise<Loaded> => {
      const memberCards = (
        await Promise.all(memberIds.map(async (id) => (await loadScorecards(id)).find((c) => c.weekOf === card.weekOf) ?? null))
      ).filter((c): c is WeeklyScorecard => c !== null)
      const bankEntries = await Promise.all(
        memberCards.map(async (c) => [c.tenantId, await loadQuestionBank(c.tenantId, c.questionBankVersion)] as const),
      )
      const citations = await loadCitationBreakdown(card.tenantId, card.weekOf)
      return {
        members: memberCards,
        banks: { ...Object.fromEntries(bankEntries), [card.tenantId]: selfBank },
        analyses: selfAnalyses,
        citationRows: citations.rows,
      }
    }
    load().then(
      (data) => alive && setState({ key, data, error: null }),
      (err: unknown) => alive && setState({ key, data: null, error: err instanceof Error ? err.message : String(err) }),
    )
    return () => {
      alive = false
    }
  }, [key, card, selfAnalyses, selfBank])

  const loaded = state.key === key ? state : null
  const report = useMemo(
    () => (loaded?.data ? buildReviewReport({ ...loaded.data, card, history, site, periodic }) : null),
    [loaded, card, history, site, periodic],
  )

  return (
    <section className="review-report">
      <div className="review-head">
        <div>
          <h3>검토 리포트</h3>
          <p className="hint">
            점수·순위를 그대로 읽어도 되는지 먼저 점검하고, 코호트 비교·불린 질문·인용 출처·Site AEO를 한 문서로 묶습니다.
            문장은 코드 템플릿이고 수치는 저장된 측정값 그대로입니다.
          </p>
        </div>
        <button
          type="button"
          className="ghost no-print"
          disabled={!report}
          onClick={() => report && downloadHtml(`${card.tenantId}-review-${card.weekOf}.html`, reviewReportHtml(report))}
        >
          검토 리포트 HTML 받기
        </button>
      </div>

      {!loaded && <p className="muted">코호트 데이터를 불러오는 중…</p>}
      {loaded?.error && (
        <p className="error" role="alert">
          검토 리포트를 만들지 못했습니다: {loaded.error}
        </p>
      )}

      {report && (
        <>
          <ul className="trust-checks">
            {report.checks.map((c) => (
              <li key={c.id}>
                <span className={`status-pill ${CHECK_PILL[c.status].cls}`}>{CHECK_PILL[c.status].label}</span>
                <strong>{c.label}</strong>
                <span className="judgment">{c.detail}</span>
              </li>
            ))}
          </ul>

          <div className="table-wrap">
            <table>
              <caption className="muted">
                {weekLabel(card.weekOf)} 코호트 {report.cohortTotal}곳 · 일반 질문 = 브랜드 이름 없는 질문 · 추천 순위 괄호는
                순위가 매겨진 응답 수(6건 미만이면 점수에 그만큼만)
              </caption>
              <thead>
                <tr>
                  <th>브랜드</th>
                  <th>순위</th>
                  <th>Brand AEO Score</th>
                  <th>일반 질문 언급률</th>
                  <th>자사 인용</th>
                  <th>추천 순위</th>
                  <th>질문지</th>
                </tr>
              </thead>
              <tbody>
                {report.cohort.map((r) => (
                  <tr key={r.tenantId} className={r.isSelf ? 'self' : undefined}>
                    <td>{r.brandName}</td>
                    <td className="num">
                      {r.tied ? '공동 ' : ''}
                      {r.position}
                    </td>
                    <td className="num">{r.score}</td>
                    <td className="num">{(r.mentionRate * 100).toFixed(1)}%</td>
                    <td className="num">{(r.ownedRate * 100).toFixed(1)}%</td>
                    <td className="num">{formatRankWithCount(r.avgRank, r.rankedResponses)}</td>
                    <td>{r.sameQuestions === null ? <span className="muted">확인 불가</span> : r.sameQuestions ? '같음' : <strong>다름</strong>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}
