import type { EntityMatchReport, EntityMatchStatus } from '../lib/aeo/entityMatch'

// 상태 → 배지. 점수가 아니라 "신호가 있는지/브랜드와 맞는지"만 나타낸다.
const BADGE: Record<EntityMatchStatus, { label: string; cls: string }> = {
  match: { label: '일치', cls: 'st-good' },
  weak: { label: '약함', cls: 'st-warn' },
  mismatch: { label: '불일치', cls: 'st-bad' },
  absent: { label: '없음', cls: 'st-bad' },
}

export default function EntityMatchPanel({ report }: { report: EntityMatchReport }) {
  return (
    <section className="panel" style={{ marginTop: 28 }}>
      <h3>
        엔티티 일치{' '}
        <span className="status-pill st-info" style={{ marginLeft: 6 }}>
          {report.matched} / {report.checked} 일치
        </span>
      </h3>
      <p className="hint" style={{ marginTop: 0 }}>
        이 페이지가 <b>{report.brandName}</b>에 대한 것임을 기계가 알 수 있는지 봅니다. 답변 엔진은 페이지 주제만으로는
        어느 브랜드로 묶을지 정하지 못합니다. <b>총점(100점)에는 반영하지 않습니다</b> — 위 6개 영역 배점은
        aeocheck 기준에 맞춰 고정돼 있고, 브랜드명을 아는지에 따라 같은 페이지의 점수가 달라지면 안 되기 때문입니다.
      </p>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ whiteSpace: 'nowrap' }}>신호</th>
              <th style={{ whiteSpace: 'nowrap' }}>판정</th>
              <th>페이지에서 읽은 값</th>
              <th>해석 · 조치</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row) => (
              <tr key={row.key}>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <code>{row.label}</code>
                </td>
                <td>
                  <span className={`status-pill ${BADGE[row.status].cls}`}>{BADGE[row.status].label}</span>
                </td>
                <td className="judgment" style={{ maxWidth: 320, wordBreak: 'break-word' }}>
                  {row.found ?? <span className="muted">—</span>}
                </td>
                <td className="judgment">{row.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
