import type { AeoReport, CategoryResult, CollectionMode, Severity } from '../lib/aeo/types'
import { PAGE_TYPE_KO } from '../lib/aeo/pageType'
import { SEVERITY_KO } from '../lib/aeo/scoreMeta'

function collectionLabel(mode: CollectionMode): string {
  return mode === 'browser' ? '브라우저 렌더 후 분석' : '정적 HTML 분석'
}

function scoreText(c: CategoryResult): string {
  return typeof c.score === 'number' ? String(c.score) : '확인 불가'
}

function sevClass(s: Severity): string {
  return `sev sev-${s}`
}

export default function SiteReportView({ report }: { report: AeoReport }) {
  return (
    <article className="site-report">
      <section className="hero-card">
        <p className="eyebrow">사이트 종합 진단 · {report.source === 'llm' ? '모델 채점' : '휴리스틱 채점'}</p>
        <p className="total">
          총점 <strong>{report.overallScore === null ? '—' : report.overallScore}</strong>
          {report.overallScore !== null && <span className="delta flat"> / 100</span>}
        </p>
        <p className="lead">{report.oneLiner}</p>
        <dl className="meta">
          <div>
            <dt>분석 URL</dt>
            <dd className="truncate">
              <a href={report.url} target="_blank" rel="noreferrer">
                {report.url}
              </a>
            </dd>
          </div>
          <div>
            <dt>등급</dt>
            <dd>{report.grade ?? '본문 미확인'}</dd>
          </div>
          <div>
            <dt>추정 핵심 주제</dt>
            <dd>
              {report.coreTopic}
              {report.topicInferred ? ' (추론)' : ''}
            </dd>
          </div>
          <div>
            <dt>페이지 유형</dt>
            <dd>{PAGE_TYPE_KO[report.pageType]}</dd>
          </div>
          {report.bodyWordCount !== null && (
            <div>
              <dt>추출 본문</dt>
              <dd>약 {report.bodyWordCount}단어</dd>
            </div>
          )}
          <div>
            <dt>수집 방식</dt>
            <dd>{collectionLabel(report.collectionMode)}</dd>
          </div>
        </dl>
      </section>

      {report.accessFailure && (
        <section className="panel warn">
          <h3>접근 실패</h3>
          <ul>
            <li>접근 상태: {report.accessFailure.status}</li>
            <li>실패 원인: {report.accessFailure.cause}</li>
            <li>제공할 자료: {report.accessFailure.neededFromUser}</li>
            <li>재분석: {report.accessFailure.howToRetry}</li>
          </ul>
        </section>
      )}

      <section>
        <h3>영역별 점수</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>평가 영역</th>
                <th>점수</th>
                <th>만점</th>
                <th>핵심 판단</th>
              </tr>
            </thead>
            <tbody>
              {report.categories.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>{scoreText(c)}</td>
                  <td>{c.maxScore}</td>
                  <td className="judgment">{c.judgment}</td>
                </tr>
              ))}
              <tr className="selected">
                <td>합계</td>
                <td>{report.overallScore ?? '—'}</td>
                <td>100</td>
                <td className="judgment">{report.grade ?? '본문 미확인'}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {report.problems.length > 0 && (
        <section>
          <h3>주요 문제</h3>
          <ol className="issue-list">
            {report.problems.map((p) => (
              <li key={p.rank}>
                <span className={sevClass(p.severity)}>{SEVERITY_KO[p.severity]}</span>
                <div>
                  <strong>{p.title}</strong>
                  <p className="muted">확인 근거: {p.evidence}</p>
                  <p className="muted">AI 답변엔진 관점: {p.aiImpact}</p>
                  {p.quote ? <q>{p.quote}</q> : null}
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {report.recommendations.length > 0 && (
        <section>
          <h3>우선순위 개선안</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>개선 작업</th>
                  <th>기대 효과</th>
                  <th>난이도</th>
                </tr>
              </thead>
              <tbody>
                {report.recommendations.map((r) => (
                  <tr key={r.priority}>
                    <td>{r.priority}</td>
                    <td>
                      <span className="work-tag">{r.workType === 'dev' ? '개발' : '콘텐츠'}</span> {r.task}
                    </td>
                    <td className="judgment">{r.expectedEffect}</td>
                    <td>{r.difficulty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {report.citableSentences.length > 0 && (
        <section>
          <h3>인용 가능 문장 예시</h3>
          <ol className="cite-list">
            {report.citableSentences.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </section>
      )}

      {report.verdict && (
        <section>
          <h3>최종 판단</h3>
          <dl className="meta">
            <div>
              <dt>현재 준비도</dt>
              <dd>{report.verdict.readiness}</dd>
            </div>
            <div>
              <dt>가장 큰 강점</dt>
              <dd>{report.verdict.biggestStrength}</dd>
            </div>
            <div>
              <dt>가장 큰 장애물</dt>
              <dd>{report.verdict.biggestBlocker}</dd>
            </div>
            <div>
              <dt>먼저 실행할 작업</dt>
              <dd>{report.verdict.firstAction}</dd>
            </div>
            <div>
              <dt>점수 상승 예상</dt>
              <dd>{report.verdict.scoreRangeIfFixed}</dd>
            </div>
          </dl>
        </section>
      )}

      {report.limitations.length > 0 && (
        <section>
          <h3>확인 불가 · 한계</h3>
          <ul className="muted">
            {report.limitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </section>
      )}

      <p className="disclaimer">{report.disclaimer}</p>
    </article>
  )
}
