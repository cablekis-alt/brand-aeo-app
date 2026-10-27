import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { computeAlerts, type AlertContext, type AlertLevel } from '../lib/alerts'
import type { WeeklyScorecard } from '../prompts/b8-report'

const LEVEL: Record<AlertLevel, { label: string; cls: string }> = {
  critical: { label: '경고', cls: 'st-bad' },
  warn: { label: '주의', cls: 'st-warn' },
  good: { label: '개선', cls: 'st-good' },
  info: { label: '안내', cls: 'st-info' },
}

// 주간 변화 알림 — 새 수집 없이 스코어카드 히스토리(전주 vs 이번 주)만으로
// "무엇이 나빠졌는지"를 대시보드 상단에 요약한다. context는 화면이 이미 읽은 기록(「틀림」 주장 · 구성원 이름) — 문장을 사람 말로 쓴다.
export default function ChangeAlerts({ history, context }: { history: WeeklyScorecard[]; context?: AlertContext }) {
  const alerts = useMemo(() => computeAlerts(history, context), [history, context])
  if (alerts.length === 0) return null

  return (
    <aside className="alerts" aria-label="주간 변화 알림">
      <div className="alerts-head">
        <h2>
          알림 <span className="mono">{alerts.length}</span>
        </h2>
        {/* 앞 측정이 2주 이상 떨어질 수 있다(사이에 재지 않은 주) — 「전주」라고 하지 않는다. */}
        <span>직전 측정 대비</span>
      </div>
      <ul>
        {alerts.map((a, i) => (
          <li key={i} className={`alert-row ${LEVEL[a.level].cls}`}>
            <span className={`status-pill ${LEVEL[a.level].cls}`}>{LEVEL[a.level].label}</span>
            <span className="alert-body">
              <b>{a.title}</b>
              <span className="alert-detail">
                {a.detail}
                {a.link && (
                  <>
                    {' '}
                    <Link to={a.link.to}>{a.link.label} →</Link>
                  </>
                )}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </aside>
  )
}
