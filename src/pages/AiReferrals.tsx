import { useEffect, useState } from 'react'
import { useTenant } from '../context/useTenant'
import { loadAiReferrals } from '../lib/api'
import type { AiReferralReport } from '../lib/types'

const DAY_OPTIONS = [7, 28, 90] as const
const pct = (n: number) => `${(n * 100).toFixed(1)}%`
const num = (n: number) => n.toLocaleString('ko-KR')

export default function AiReferrals() {
  const { tenant } = useTenant()
  const [days, setDays] = useState<number>(28)
  const [report, setReport] = useState<AiReferralReport | null>(null)
  // 로딩은 별도 state로 두지 않고 "요청 키와 적재된 키가 다른가"로 파생한다
  // (effect 안에서 setState를 동기 호출하지 않기 위해 — cascading render 방지).
  const [loadedKey, setLoadedKey] = useState('')
  const key = `${tenant?.tenantId ?? ''}:${days}`
  const loading = Boolean(tenant?.tenantId) && loadedKey !== key

  useEffect(() => {
    const id = tenant?.tenantId
    if (!id) return
    let alive = true
    void loadAiReferrals(id, days).then((r) => {
      if (!alive) return
      setReport(r)
      setLoadedKey(`${id}:${days}`)
    })
    return () => {
      alive = false
    }
  }, [tenant?.tenantId, days])

  if (!tenant) return null

  return (
    <>
      <p className="brand">STAGE 4</p>
      <h1>AI 리퍼럴 트래픽</h1>
      <p className="lead">
        AI 답변에서 <b>실제 방문으로 이어진</b> 세션을 자사 GA4에서 확인합니다. 가시성 측정(언급·인용)이 "보이는가"라면,
        이 화면은 "그래서 들어왔는가"를 봅니다.
      </p>

      <div className="filters">
        <label className="field">
          <span>기간</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {DAY_OPTIONS.map((d) => (
              <option key={d} value={d}>
                최근 {d}일
              </option>
            ))}
          </select>
        </label>
      </div>

      {loading && <p className="muted">불러오는 중…</p>}

      {!loading && report && !report.configured && (
        <section className="panel">
          <h3>GA4 연동이 필요합니다</h3>
          {report.reason === 'unavailable' ? (
            <p className="muted">
              이 화면은 <b>데스크톱 앱(또는 로컬 서버)</b>에서만 동작합니다. 웹 배포에는 GA 조회 함수가 없습니다.
            </p>
          ) : (
            <p className="muted">{report.reason}</p>
          )}
          <p className="hint" style={{ marginTop: 10 }}>
            설정 방법 — ① Google Cloud에서 <b>서비스 계정</b>을 만들고 JSON 키를 발급, ② 그 서비스 계정 이메일을 GA4 속성의{' '}
            <b>뷰어</b>로 추가, ③ <code>.env</code>에 <code>GOOGLE_SERVICE_ACCOUNT_JSON</code>(JSON 한 줄) 과{' '}
            <code>GA4_PROPERTY_ID</code>(숫자 속성 ID)를 설정. 브랜드마다 다른 속성을 쓰려면 브랜드 설정의{' '}
            <code>ga4PropertyId</code>를 지정하세요. GA 권한이 있는 <b>자사 브랜드</b>에만 적용됩니다.
          </p>
        </section>
      )}

      {!loading && report?.configured && (
        <>
          <section className="hero-card">
            <p className="eyebrow">
              {tenant.brandName} · GA4 {report.propertyId} · {report.startDate} ~ {report.endDate}
            </p>
            <p className="total">
              AI 유입 세션 <strong>{num(report.totalAiSessions)}</strong>
            </p>
            <dl className="meta">
              <div>
                <dt>전체 세션</dt>
                <dd>{num(report.totalSessions)}</dd>
              </div>
              <div>
                <dt>AI 유입 비중</dt>
                <dd>{pct(report.aiShare)}</dd>
              </div>
              <div>
                <dt>유입 엔진 수</dt>
                <dd>{report.rows.length}</dd>
              </div>
            </dl>
          </section>

          {report.rows.length === 0 ? (
            <p className="muted">
              이 기간에 AI 답변엔진에서 유입된 세션이 없습니다. 가시성이 올라도 유입은 시차를 두고 나타납니다.
            </p>
          ) : (
            <section>
              <h3>엔진별 유입</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>엔진</th>
                      <th className="num">세션</th>
                      <th className="num">사용자</th>
                      <th className="num">참여 세션</th>
                      <th className="num">전체 대비</th>
                      <th>GA 소스</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.map((r) => (
                      <tr key={r.engine}>
                        <td>
                          <b>{r.label}</b>
                        </td>
                        <td className="num">{num(r.sessions)}</td>
                        <td className="num">{num(r.activeUsers)}</td>
                        <td className="num">{num(r.engagedSessions)}</td>
                        <td className="num">{pct(r.share)}</td>
                        <td>
                          <span className="sentence-meta">{r.sources.join(', ')}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="hint" style={{ marginTop: 10 }}>
                GA4 <code>sessionSource</code>를 답변엔진으로 분류한 값입니다. AI 유입은 리퍼러를 남기지 않는 경우도 있어
                <b> 과소 집계</b>될 수 있습니다(실제 하한으로 보세요).
              </p>
            </section>
          )}
        </>
      )}
    </>
  )
}
