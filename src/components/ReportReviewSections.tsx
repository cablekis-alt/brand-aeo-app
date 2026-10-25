import type { SiteScoreRecord } from '../lib/api'
import { formatRankWithCount, weekLabel } from '../lib/format'
import type { CheckStatus, CitationRow, CohortRow, SelfReview, TrustCheck } from '../lib/reviewReport'

/*
 * 정기진단 보고서의 점검 · 비교 절 — 예전 「검토 리포트」 상자와 HTML 파일에 있던 내용을 보고서 본문 자리로 나눠 둔다
 * (계산은 src/lib/reviewReport.ts). 운영자 점검만 화면에서 보고, 나머지는 고객 종이에도 싣는다.
 */

const CHECK_PILL: Record<CheckStatus, { label: string; cls: string }> = {
  ok: { label: '확인', cls: 'st-good' },
  warn: { label: '주의', cls: 'st-warn' },
  review: { label: '사람 확인', cls: 'st-bad' },
}

const pct = (v: number | null) => (v === null ? null : `${(v * 100).toFixed(1)}%`)
const Unknown = () => <span className="muted">확인 불가</span>

/**
 * 측정 신뢰도 점검 — 운영자 상자. 점수 · 순위를 그대로 읽어도 되는지 먼저 본다.
 *
 * 화면에서만 보인다(no-print) — 「고객용 결론은 … 씁니다」 같은 운영 지시와 「사람 확인」 칩이 고객 종이에 찍히면 안 된다. 기본은
 * 접어 두되, 접혀 있어도 제목 줄에 확인 · 주의 · 사람 확인 개수를 보인다.
 */
export function TrustChecksBox({ checks, error }: { checks: TrustCheck[] | null; error: string | null }) {
  const count = (s: CheckStatus) => checks?.filter((c) => c.status === s).length ?? 0
  return (
    <details className="trust-box no-print">
      <summary>
        <strong>측정 신뢰도 점검</strong>
        {error ? (
          <span className="muted">코호트 기록을 읽지 못했습니다: {error}</span>
        ) : checks ? (
          <span className="trust-counts">
            {(['review', 'warn', 'ok'] as const)
              .filter((s) => count(s) > 0)
              .map((s) => (
                <span key={s} className={`status-pill ${CHECK_PILL[s].cls}`}>
                  {CHECK_PILL[s].label} {count(s)}
                </span>
              ))}
          </span>
        ) : (
          <span className="muted">코호트 기록을 불러오는 중…</span>
        )}
      </summary>
      <p className="hint">점수 · 순위를 그대로 읽어도 되는지 운영자가 먼저 봅니다. 고객 종이에는 싣지 않습니다.</p>
      {checks && (
        <ul className="trust-checks">
          {checks.map((c) => (
            <li key={c.id}>
              <span className={`status-pill ${CHECK_PILL[c.status].cls}`}>{CHECK_PILL[c.status].label}</span>
              <strong>{c.label}</strong>
              <span className="judgment">{c.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </details>
  )
}

/**
 * 같은 주 코호트 비교 — 다른 브랜드 수치가 나오는 유일한 곳. 순위는 저장된 순위 비교 목록에서 내 그래프 아래 순위와 같은 분모다.
 * 이 브랜드 줄은 아래 지표별 진단과 같은 한 주 측정값이라 강조하고 그렇다고 밝힌다(다른 값으로 읽히지 않게). 월간 보기의 위 숫자
 * 칸은 월 평균이라 「같은 값」이라고 하지 않는다.
 *
 * 그 주 기록을 읽지 못한 브랜드는 표에서 빼고 몇 곳 뺐는지만 적는다 — 저장 목록에는 이름이 없어(내부 id뿐) 고객 종이에 id가
 * 찍힌다. 순위는 뺀 곳까지 포함한 저장 목록 기준 그대로다.
 */
export function CohortCompareSection({ rows, weekOf }: { rows: CohortRow[]; weekOf: string }) {
  const shown = rows.filter((r) => r.loaded)
  const hidden = rows.length - shown.length
  return (
    <section className="cohort-compare">
      <h3>같은 주 코호트 비교</h3>
      <div className="table-wrap">
        <table>
          <caption className="muted">
            {weekLabel(weekOf)} 코호트 {rows.length}곳
            {hidden > 0 && ` · 이번 주 기록을 읽지 못한 ${hidden}곳은 표에서 뺐습니다(순위는 ${rows.length}곳 기준)`} · 굵은 줄(이
            브랜드)은 {weekLabel(weekOf)} 한 주의 값으로 아래 지표별 진단과 같습니다 · 언급률은 이름 없이 물은 질문의 응답 기준, 자사
            인용률은 모든 질문 기준 · 추천 순위 괄호는 순위가 매겨진 응답 수(6건 미만이면 점수에 그만큼만)
          </caption>
          <thead>
            <tr>
              <th>브랜드</th>
              <th>순위</th>
              <th>Brand AEO Score</th>
              <th>언급률</th>
              <th>자사 인용률</th>
              <th>추천 순위</th>
              <th className="no-print">질문지</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.tenantId} className={r.isSelf ? 'self' : undefined}>
                <td>{r.isSelf ? <strong>{r.brandName}</strong> : r.brandName}</td>
                <td className="num">
                  {r.tied ? '공동 ' : ''}
                  {r.position}
                </td>
                <td className="num">{r.score}</td>
                <td className="num">{pct(r.mentionRate) ?? <Unknown />}</td>
                <td className="num">{pct(r.ownedRate) ?? <Unknown />}</td>
                <td className="num">{r.loaded ? formatRankWithCount(r.avgRank, r.rankedResponses) : <Unknown />}</td>
                <td className="no-print">
                  {r.isSelf ? '—' : r.sameQuestions === null ? <Unknown /> : r.sameQuestions ? '같음' : <strong>다름</strong>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/**
 * 브랜드 이름 없이 물었을 때 불린 질문 — 표지의 「N개 중 M개에서 불렸습니다」가 어느 질문인지 보인다. 질문 유형별 언급은 응답
 * 단위다(표지 문장은 질문 단위 — 두 단위를 이름으로 가른다).
 */
export function MentionSection({ self, weekOf }: { self: SelfReview; weekOf: string }) {
  const g = self.general
  return (
    <section className="mention-section">
      <h3>브랜드 이름 없이 물었을 때 불린 질문</h3>
      {self.mentionedQuestions.length > 0 ? (
        <ul className="mention-list">
          {self.mentionedQuestions.map((q) => (
            <li key={q.text}>
              {q.text} <span className="muted">— {q.engines.join(' · ')}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">이번 주 이름 없이 물은 질문에서는 한 번도 불리지 않았습니다.</p>
      )}
      <p className="hint">
        {weekLabel(weekOf)} · 이름 없이 물은 질문 {g.questions}개 · AI 응답 {g.responses}건 중 {g.mentioned}건에서 불림 · 답 대신 조건을
        되물은 응답 {g.clarifying}건
      </p>
      {self.categories.length > 0 && (
        <div className="table-wrap">
          <table>
            <caption className="muted">질문 유형별 언급 — 응답 수 기준</caption>
            <thead>
              <tr>
                <th>질문 유형</th>
                <th>불린 응답 / 응답</th>
              </tr>
            </thead>
            <tbody>
              {self.categories.map((c) => (
                <tr key={c.category}>
                  <td>{c.label}</td>
                  <td className="num">
                    {c.mentioned}/{c.total}
                  </td>
                </tr>
              ))}
              <tr className="self">
                <td>
                  <strong>이름 없이 물은 질문</strong>
                </td>
                <td className="num">
                  <strong>
                    {g.mentioned}/{g.responses}
                  </strong>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/** AI가 근거로 쓴 출처 — 그 주 상위 출처와 자사 출처. 건수는 위 「인용 건수」 칸과 같은 인용 분석에서 나온다. */
export function CitationSourcesSection({
  top,
  total,
  owned,
  weekOf,
}: {
  top: CitationRow[]
  total: number
  owned: number
  weekOf: string
}) {
  return (
    <section className="citation-top">
      <h3>AI가 근거로 쓴 출처</h3>
      <div className="table-wrap">
        <table>
          <caption className="muted">
            {weekLabel(weekOf)} · 인용 {total.toLocaleString()}건 중 자사 {owned.toLocaleString()}건 · 상위 출처와 자사 출처
          </caption>
          <thead>
            <tr>
              <th>출처</th>
              <th>인용</th>
              <th>성격</th>
            </tr>
          </thead>
          <tbody>
            {top.map((c) => (
              <tr key={c.domain} className={c.isOwned ? 'self' : undefined}>
                <td className="cell-text">
                  <code>{c.domain}</code>
                </td>
                <td className="num">{c.count.toLocaleString()}</td>
                <td>{c.isOwned ? <strong>{c.owner}</strong> : c.owner}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/** Site AEO 영역별 점수 — 총점은 위 숫자 칸에 있어 영역만 보인다. 어느 주의 진단인지 함께 적는다. */
export function SiteBreakdownSection({ site }: { site: SiteScoreRecord }) {
  return (
    <section className="site-breakdown">
      <h3>Site AEO 영역별 점수</h3>
      <div className="table-wrap">
        <table>
          <caption className="muted">
            {weekLabel(site.weekOf)} 진단 · 총점 {site.score}점 · <code>{site.url}</code>
          </caption>
          <thead>
            <tr>
              <th>진단 영역</th>
              <th>점수</th>
            </tr>
          </thead>
          <tbody>
            {site.categories.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td className="num">{c.score === null ? <Unknown /> : `${c.score} / ${c.maxScore}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/** 사실성 「틀림」 원문 — 운영자가 판정 오류인지 가린다(화면에서만). */
export function ContradictedList({ items }: { items: SelfReview['contradicted'] }) {
  return (
    <ul className="contradicted-list no-print">
      {items.map((c, i) => (
        <li key={i}>
          {c.question} <span className="muted">— {c.engine}</span>
          <div className="doc-meta">
            AI: “{c.said}” · 등록: “{c.registered}”
          </div>
        </li>
      ))}
    </ul>
  )
}
